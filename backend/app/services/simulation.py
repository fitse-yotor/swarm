"""Stage 3: built-in agent-based social simulation with an OASIS-style action space.

Engine "lattice-abm/1". Each round, every agent is active with probability from its
activity and a day/night curve. An active agent reads a feed on one platform (followed
agents first, then trending) and takes one action: CREATE_POST, CREATE_COMMENT, REPOST,
LIKE_POST, DISLIKE_POST (forum only), FOLLOW or DO_NOTHING.

Opinions move by bounded confidence (Deffuant): reading a post within `epsilon` of the
reader's stance pulls it by `mu × author influence`; a post further away pushes it
slightly away (`backfire`). An injected scenario is an outside event with a direction
(`scenario_shock`): open agents shift toward it, committed opponents entrench. Post text comes from the local LLM for the most influential
posting agents (up to `llm_posts_per_round`), otherwise from stance-aware templates.
Every event records which. Runs are seeded, so the same environment reproduces exactly.
"""
import math
import random
import statistics

from app.models import Environment, SimEvent, Simulation, new_id, utcnow
from app.services import llm
from app.services.jobrunner import JobCtx

ENGINE = "lattice-abm/1"
ACTIONS = {
    "microblog": [("CREATE_POST", .22), ("LIKE_POST", .30), ("REPOST", .14), ("CREATE_COMMENT", .14), ("FOLLOW", .06),
                  ("DO_NOTHING", .14)],
    "forum": [("CREATE_POST", .18), ("CREATE_COMMENT", .34), ("LIKE_POST", .22), ("DISLIKE_POST", .10),
              ("DO_NOTHING", .16)],
}
POSTS = {
    "support": ["{f} is the right call — {i} depends on it.", "Backing {f}. The record on {i} is clear enough.",
                "Good to see movement on {f}. Partners should follow through.", "We support {f} and will say so publicly.",
                "Delay on {f} costs more than acting. Think about {i}.", "{f} deserves a fair hearing, not panic."],
    "oppose": ["{f} ignores what is happening with {i}.", "We cannot accept {f} as it stands.",
               "Who answers for {i} if {f} goes ahead?", "{f} must be paused until {i} is addressed.",
               "Nobody asked the people affected by {f}.", "The costs of {f} land on {i}. That is not acceptable."],
    "neutral": ["Watching {f} closely. What does it mean for {i}?", "Open question: how will {f} affect {i}?",
                "Waiting for real data on {i} before taking a view on {f}.", "Both sides on {f} are talking past each other.",
                "Is there an independent assessment of {f} yet?", "Summary of where things stand on {f} and {i}:"],
}
REPLIES = {
    "agree": ["Agreed — {i} is the key issue here.", "Exactly this.", "Well put. {f} needs this scrutiny.",
              "Same view from our side.", "This matches what we are seeing on {i}."],
    "disagree": ["That misreads {f}.", "Not convinced — what about {i}?", "The record on {i} says otherwise.",
                 "This ignores the people most affected.", "Respectfully, no. {f} is more complicated than that."],
}


def lean(s: float) -> str:
    return "support" if s > 0.25 else "oppose" if s < -0.25 else "neutral"


def diurnal(hour: float) -> float:
    return 0.3 if hour < 6 else 1.0 if 9 <= hour < 22 else 0.6


class Engine:
    def __init__(self, ctx: JobCtx, sim: Simulation):
        self.ctx, self.sim = ctx, sim
        c = sim.config
        self.cfg = c["config"]
        self.rng = random.Random(self.cfg["seed"])
        self.focus = self.cfg.get("focus_name") or "the issue"
        self.agents = {a["id"]: a for a in c["agents"]}
        self.stance = {a["id"]: float(a["stance"]) for a in c["agents"]}
        self.series = {a["id"]: [round(a["stance"], 3)] for a in c["agents"]}
        self.follows: dict[str, set[str]] = {a: set() for a in self.agents}
        for link in c["links"]:
            if link["kind"] != "opponent":
                self.follows[link["s"]].add(link["o"])
                self.follows[link["o"]].add(link["s"])
        self.posts: list[SimEvent] = []
        self.by_id: dict[str, SimEvent] = {}
        self.received = {a: 0 for a in self.agents}
        self.llm_budget = self.cfg.get("llm_posts_per_round", 0) if llm.available() else 0
        self.llm_count = 0
        self.seeds = c.get("seed_posts", [])
        self.speakers = [a for a, x in self.agents.items() if x.get("speaks", True)]
        if not self.speakers:
            raise ValueError("No agent can post: import synthetic personas, or allow real actors to speak in the environment")

    # ----- content -----
    def topic(self, agent: dict) -> str:
        return self.rng.choice(agent["interests"]) if agent["interests"] else "the people affected"

    def template_post(self, agent: dict) -> str:
        return self.rng.choice(POSTS[lean(self.stance[agent["id"]])]).format(f=self.focus, i=self.topic(agent))

    def template_reply(self, agent: dict, target: SimEvent) -> str:
        agree = abs(self.stance[agent["id"]] - target.stance) < self.cfg["epsilon"]
        return self.rng.choice(REPLIES["agree" if agree else "disagree"]).format(f=self.focus, i=self.topic(agent))

    def llm_text(self, agent: dict, platform: str, target: SimEvent | None, seen: list[SimEvent]) -> str | None:
        s = self.stance[agent["id"]]
        label = "a SYNTHETIC persona (fictional, not a real person)" if agent.get("synthetic") else "an agent"
        system = (f"You are {agent['name']} ({agent['profession']}), {label} in a social simulation about "
                  f"{self.focus}. Persona: {agent['persona']} Your current stance on {self.focus}: {s:+.2f} "
                  f"(-1 opposes, +1 supports). Tone: {agent['tone']}. Write ONE {platform} "
                  f"{'reply' if target else 'post'} in character, at most 45 words, plain text, no hashtags. "
                  f"Do not invent statistics. Known facts:\n" + "\n".join(f"- {f}" for f in agent["facts"][:6]))
        prompt = (f"Reply to this post by {target.agent_name}: \"{target.content}\"" if target else
                  "Recent posts you saw:\n" + "\n".join(f"- {p.agent_name}: {p.content[:160]}" for p in seen[:3])
                  if seen else f"Write your first post about {self.focus}.")
        try:
            text = llm.chat(system, [{"role": "user", "content": prompt}], temperature=0.8, max_tokens=110)
            return text.strip().strip('"')[:600] or None
        except Exception as e:
            self.ctx.log(f"LLM post for {agent['name']} failed ({type(e).__name__}); template used", "e")
            return None

    # ----- dynamics -----
    def influence(self, reader: str, post: SimEvent, weight: float) -> None:
        author = self.agents.get(post.agent_id)
        w = author["influence"] if author else 0.6
        d = post.stance - self.stance[reader]
        if abs(d) < self.cfg["epsilon"]:
            self.stance[reader] += self.cfg["mu"] * w * weight * d
        else:
            self.stance[reader] -= self.cfg["backfire"] * weight * math.copysign(1, d)
        self.stance[reader] = max(-1.0, min(1.0, self.stance[reader]))

    def news_shock(self, aid: str, shock: float) -> None:
        """An exogenous event, not a peer's post: open agents shift with it, committed opponents entrench."""
        s = self.stance[aid]
        if s * shock < 0 and abs(s) > 0.5:
            s -= 0.08 * shock
        else:
            s += 0.35 * shock * (1 - abs(s))
        self.stance[aid] = max(-1.0, min(1.0, s))

    def feed(self, aid: str, platform: str, rnd: int) -> list[SimEvent]:
        recent = [p for p in self.posts if p.platform == platform and p.agent_id != aid and rnd - p.round <= 3
                  and p.action in ("CREATE_POST", "CREATE_COMMENT", "REPOST")]
        def score(p: SimEvent) -> float:
            return ((2.5 if p.agent_id in self.follows[aid] else 0) + (3 if p.agent_id == "src" else 0)
                    + math.log1p(p.likes + 2 * p.reposts + 2 * p.replies) - 0.4 * (rnd - p.round) + self.rng.random())
        return sorted(recent, key=score, reverse=True)[:5]

    def emit(self, rnd: int, platform: str, agent_id: str, name: str, action: str, content: str = "",
             target: SimEvent | None = None, stance: float = 0.0, by: str = "template") -> SimEvent:
        ev = SimEvent(id=new_id("se"), simulation_id=self.sim.id, round=rnd, platform=platform, agent_id=agent_id,
                      agent_name=name, action=action, content=content, target_id=target.id if target else None,
                      stance=round(stance, 3), generated_by=by, likes=0, replies=0, reposts=0)
        self.ctx.db.add(ev)
        self.by_id[ev.id] = ev
        if action in ("CREATE_POST", "CREATE_COMMENT", "REPOST"):
            self.posts.append(ev)
        return ev

    def round(self, rnd: int) -> dict:
        hour = (8 + rnd * self.cfg["minutes_per_round"] / 60) % 24
        counts = {a: 0 for a, _ in ACTIONS["microblog"] + ACTIONS["forum"]}
        per_platform = {p: 0 for p in self.cfg["platforms"]}
        for s in self.seeds:
            if s["round"] == rnd:
                scenario = s["source"] == "scenario injection"
                shock = max(-1.0, min(1.0, float(self.cfg.get("scenario_shock", 0.0)))) if scenario else 0.0
                for p in self.cfg["platforms"]:
                    self.emit(rnd, p, "src", "Scenario" if scenario else "Case sources", "CREATE_POST", s["content"],
                                     stance=shock, by=s["source"])
                if scenario and shock:  # everyone hears the news once
                    for aid in self.speakers:
                        self.news_shock(aid, shock)
        order = [a for a in self.agents.values() if a.get("speaks", True)]  # context-only actors never act
        self.rng.shuffle(order)
        # Influential agents claim the LLM budget first.
        llm_left = self.llm_budget
        llm_first = {a["id"] for a in sorted(order, key=lambda a: a["influence"], reverse=True)[:max(llm_left * 3, 0)]}
        active = 0
        for a in order:
            aid = a["id"]
            if self.rng.random() > a["activity"] * diurnal(hour):
                continue
            active += 1
            platform = self.rng.choice([p for p in a.get("platforms", self.cfg["platforms"]) if p in self.cfg["platforms"]]
                                       or self.cfg["platforms"])
            seen = self.feed(aid, platform, rnd)
            for p in seen[:3]:
                self.influence(aid, p, 0.35)
            acts, weights = zip(*ACTIONS[platform], strict=True)
            action = self.rng.choices(acts, weights)[0]
            if not seen and action not in ("CREATE_POST", "FOLLOW"):
                action = "CREATE_POST" if self.rng.random() < 0.5 else "DO_NOTHING"
            counts[action] += 1
            if action == "DO_NOTHING":
                continue
            per_platform[platform] += 1
            s = self.stance[aid]
            if action == "FOLLOW":
                cands = [x for x in self.agents if x != aid and x not in self.follows[aid]]
                if cands:
                    tgt = max(cands, key=lambda x: self.agents[x]["influence"] - abs(self.stance[x] - s) + self.rng.random())
                    self.follows[aid].add(tgt)
                    self.emit(rnd, platform, aid, a["name"], "FOLLOW", f"followed {self.agents[tgt]['name']}", stance=s)
                continue
            if action == "CREATE_POST":
                text, by = None, "template"
                if llm_left > 0 and aid in llm_first:
                    text = self.llm_text(a, platform, None, seen)
                    if text:
                        llm_left, by, self.llm_count = llm_left - 1, llm.name(), self.llm_count + 1
                self.emit(rnd, platform, aid, a["name"], action, text or self.template_post(a), stance=s, by=by)
                continue
            if action in ("LIKE_POST", "REPOST"):
                target = max(seen, key=lambda p: math.exp(-2 * abs(p.stance - s)) + self.rng.random() * 0.5)
            elif action == "DISLIKE_POST":
                target = max(seen, key=lambda p: abs(p.stance - s) + self.rng.random() * 0.3)
            else:
                target = self.rng.choice(seen)
            self.influence(aid, target, 1.0 if action != "DISLIKE_POST" else 0.5)
            s = self.stance[aid]
            if target.agent_id in self.received:
                self.received[target.agent_id] += 1
            if action == "LIKE_POST":
                target.likes += 1
                self.emit(rnd, platform, aid, a["name"], action, target=target, stance=s)
            elif action == "DISLIKE_POST":
                self.emit(rnd, platform, aid, a["name"], action, target=target, stance=s)
            elif action == "REPOST":
                target.reposts += 1
                self.emit(rnd, platform, aid, a["name"], action, target.content, target=target, stance=s)
            else:
                text, by = None, "template"
                if llm_left > 0 and aid in llm_first:
                    text = self.llm_text(a, platform, target, seen)
                    if text:
                        llm_left, by, self.llm_count = llm_left - 1, llm.name(), self.llm_count + 1
                target.replies += 1
                self.emit(rnd, platform, aid, a["name"], action, text or self.template_reply(a, target), target=target,
                          stance=s, by=by)
        vals = [self.stance[a] for a in self.speakers]
        for aid in self.agents:
            self.series[aid].append(round(self.stance[aid], 3))
        return {"round": rnd, "hour": round(hour, 1), "active": active, "actions": counts, "platforms": per_platform,
                "mean_stance": round(statistics.fmean(vals), 3),
                "polarization": round(statistics.pstdev(vals), 3),
                "support": round(sum(v > 0.25 for v in vals) / len(vals), 3),
                "oppose": round(sum(v < -0.25 for v in vals) / len(vals), 3)}


def run(ctx: JobCtx) -> None:
    db = ctx.db
    sim = db.get(Simulation, ctx.job.stats["target_id"])
    env = db.get(Environment, sim.environment_id)
    ctx.stage(0)
    sim.status, sim.engine = "running", ENGINE
    if not sim.config:
        sim.config = {"config": env.config, "agents": env.agents, "links": env.links, "seed_posts": env.seed_posts,
                      "environment_revision": env.revision}
    sim.config["config"] = {**sim.config["config"], **(ctx.job.stats.get("overrides") or {})}
    db.query(SimEvent).filter(SimEvent.simulation_id == sim.id).delete()  # a retry replays from round 0
    sim.rounds = []
    eng = Engine(ctx, sim)
    rounds = int(eng.cfg["rounds"])
    ctx.log(f"{ENGINE}: {len(eng.agents)} agents, {rounds} rounds, platforms {', '.join(eng.cfg['platforms'])}; "
            f"{eng.llm_budget} LLM-written posts per round ({llm.name() if eng.llm_budget else 'templates only'})", "o")

    ctx.stage(1)
    for r in range(rounds + 1):
        m = eng.round(r)
        sim.rounds = [*sim.rounds, m]
        acts = m["actions"]
        ctx.log(f"[Round {r}/{rounds}] {m['active']} active · {acts['CREATE_POST']} posts · "
                f"{acts['CREATE_COMMENT']} comments · {acts['LIKE_POST']} likes · mean stance {m['mean_stance']:+.2f} · "
                f"polarization {m['polarization']:.2f}")
        ctx.progress(5 + 85 * (r + 1) / (rounds + 1))
        ctx.check_cancel()

    ctx.stage(2)
    def engagement(p: SimEvent) -> int:
        return p.likes + 2 * p.reposts + 2 * p.replies
    originals = [p for p in eng.posts if p.action in ("CREATE_POST", "CREATE_COMMENT") and p.agent_id != "src"]
    top = sorted(originals, key=engagement, reverse=True)[:10]
    final = eng.stance
    groups = {k: [a for a in eng.speakers if lean(final[a]) == k] for k in ("support", "neutral", "oppose")}
    movers = sorted(eng.speakers, key=lambda a: abs(final[a] - eng.series[a][0]), reverse=True)[:6]
    sim.stats = {
        "engine": ENGINE, "agents": len(eng.agents), "rounds": rounds, "events": len(eng.by_id),
        "speaking_agents": len(eng.speakers), "synthetic_agents": sum(1 for a in eng.agents.values() if a.get("synthetic")),
        "context_only_agents": len(eng.agents) - len(eng.speakers),
        "llm_posts": eng.llm_count, "llm_model": llm.name() if eng.llm_count else None,
        "totals": {k: sum(m["actions"].get(k, 0) for m in sim.rounds) for k in
                   ("CREATE_POST", "CREATE_COMMENT", "REPOST", "LIKE_POST", "DISLIKE_POST", "FOLLOW", "DO_NOTHING")},
        "platform_totals": {p: sum(m["platforms"].get(p, 0) for m in sim.rounds) for p in eng.cfg["platforms"]},
        "stance_start": sim.rounds[0]["mean_stance"] if sim.rounds else 0, "stance_end": sim.rounds[-1]["mean_stance"],
        "polarization_start": sim.rounds[0]["polarization"], "polarization_end": sim.rounds[-1]["polarization"],
        "series": eng.series,
        "coalitions": {k: [{"id": a, "name": eng.agents[a]["name"], "stance": round(final[a], 2)} for a in v]
                       for k, v in groups.items()},
        "movers": [{"id": a, "name": eng.agents[a]["name"], "from": eng.series[a][0], "to": round(final[a], 2)}
                   for a in movers],
        "most_engaged": sorted(({"id": a, "name": eng.agents[a]["name"], "received": n} for a, n in eng.received.items()),
                               key=lambda x: x["received"], reverse=True)[:6],
        "top_posts": [{"id": p.id, "agent": p.agent_name, "platform": p.platform, "round": p.round, "content": p.content,
                       "engagement": engagement(p), "stance": p.stance, "generated_by": p.generated_by} for p in top],
        "focus": eng.focus,
    }
    ctx.log(f"Mean stance {sim.stats['stance_start']:+.2f} → {sim.stats['stance_end']:+.2f}; polarization "
            f"{sim.stats['polarization_start']:.2f} → {sim.stats['polarization_end']:.2f}; "
            f"{len(eng.by_id)} events, {eng.llm_count} written by the local LLM", "o")
    ctx.stage(3)
    sim.status, sim.finished_at = "done", utcnow()
    ctx.log("Simulation complete — ready for report generation", "o")
