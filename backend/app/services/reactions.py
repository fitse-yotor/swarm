"""Reaction graphs and analyst-triggered actions for a finished simulation.

Reaction graph kinds (all built from stored SimEvent rows, nothing is generated):
- agents:  who interacted with whom across the whole run (aggregated replies, reposts, likes).
- post:    the cascade under one post: the post, every comment / repost / like on it, replies to replies.
- agent:   everything one persona posted plus the reactions it drew.

Triggering lets an analyst make one persona post, comment, repost, like or dislike inside a finished
run, optionally letting the other personas react. Reactions are rule-based (stance closeness decides
agree / disagree / like / repost), seeded per event so the same trigger reproduces, and every row is
labelled with who produced it (`analyst-trigger`, `reaction-model`, or the LLM name).
"""
import hashlib
import math
import random
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import SimEvent, Simulation, new_id
from app.services import llm
from app.services.simulation import POSTS, REPLIES, lean

CONTENT_ACTIONS = ("CREATE_POST", "CREATE_COMMENT", "REPOST")
ACTION_LABEL = {"CREATE_POST": "POSTED", "CREATE_COMMENT": "COMMENTED", "REPOST": "REPOSTED", "LIKE_POST": "LIKED",
                "DISLIKE_POST": "DISLIKED", "FOLLOW": "FOLLOWED"}
NODE_CAP = 450


def snippet(text: str, n: int = 56) -> str:
    t = re.sub(r"\s+", " ", text).strip()
    return t if len(t) <= n else t[: n - 1] + "…"


def events_of(db: Session, sim_id: str) -> list[SimEvent]:
    return list(db.scalars(select(SimEvent).where(SimEvent.simulation_id == sim_id).order_by(SimEvent.round, SimEvent.id)))


def agents_of(sim: Simulation) -> dict[str, dict]:
    return {a["id"]: a for a in (sim.config or {}).get("agents", [])}


def final_stance(sim: Simulation, aid: str, fallback: float = 0.0) -> float:
    series = (sim.stats or {}).get("series", {}).get(aid)
    return series[-1] if series else fallback


def _agent_node(a: dict | None, aid: str, name: str, sim: Simulation) -> dict:
    synthetic = bool(a and a.get("synthetic"))
    return {"id": aid, "name": name, "type": "persona" if synthetic else "actor", "stance": round(final_stance(sim, aid, a["stance"] if a else 0), 2),
            "synthetic": synthetic}


def _event_node(e: SimEvent) -> dict:
    kind = {"CREATE_POST": "post", "CREATE_COMMENT": "comment", "REPOST": "repost"}.get(e.action, "post")
    return {"id": e.id, "name": f"{e.agent_name}: {snippet(e.content)}", "type": kind, "round": e.round, "platform": e.platform,
            "likes": e.likes, "reposts": e.reposts, "replies": e.replies, "stance": e.stance, "text": e.content, "author": e.agent_name,
            "generated_by": e.generated_by}


def interaction_graph(db: Session, sim: Simulation) -> dict:
    """Persona-to-persona interactions across the whole run; one link per (actor, author, action)."""
    evs = events_of(db, sim.id)
    by_id = {e.id: e for e in evs}
    agents = agents_of(sim)
    counts: dict[tuple, int] = {}
    seen: dict[str, str] = {}
    for e in evs:
        seen[e.agent_id] = e.agent_name
        t = by_id.get(e.target_id) if e.target_id else None
        if t is None or t.agent_id in ("src", e.agent_id) or e.agent_id == "src":
            continue
        verb = {"CREATE_COMMENT": "REPLIED_TO", "REPOST": "REPOSTED", "LIKE_POST": "LIKED", "DISLIKE_POST": "DISLIKED"}.get(e.action)
        if verb:
            counts[(e.agent_id, t.agent_id, verb)] = counts.get((e.agent_id, t.agent_id, verb), 0) + 1
            seen[t.agent_id] = t.agent_name
    nodes = [_agent_node(agents.get(i), i, n, sim) for i, n in seen.items() if i != "src"]
    links = [{"source": s, "target": t, "type": v if c == 1 else f"{v} ×{c}", "count": c} for (s, t, v), c in counts.items()]
    return {"scope": "agents", "nodes": nodes, "links": links, "events": len(evs)}


def cascade_graph(db: Session, sim: Simulation, roots: list[str]) -> dict:
    """Roots plus everything that reacted to them, level by level; persona nodes connect to their events."""
    evs = events_of(db, sim.id)
    by_id = {e.id: e for e in evs}
    children: dict[str, list[SimEvent]] = {}
    for e in evs:
        if e.target_id:
            children.setdefault(e.target_id, []).append(e)
    agents = agents_of(sim)
    nodes: dict[str, dict] = {}
    links: list[dict] = []
    seen_ev: set[str] = set()
    frontier = [r for r in roots if r in by_id]
    root_ids = set(frontier)
    while frontier and len(nodes) < NODE_CAP:
        nxt: list[str] = []
        for pid in frontier:
            parent = by_id[pid]
            for e in children.get(pid, []):
                if e.id in seen_ev:
                    continue
                seen_ev.add(e.id)
                if e.action in CONTENT_ACTIONS:
                    nodes[e.id] = _event_node(e)
                    links.append({"source": e.id, "target": pid, "type": "REPOST_OF" if e.action == "REPOST" else "REPLY_TO"})
                    nxt.append(e.id)
                if e.agent_id != "src":
                    nodes.setdefault(e.agent_id, _agent_node(agents.get(e.agent_id), e.agent_id, e.agent_name, sim))
                    links.append({"source": e.agent_id, "target": e.id if e.action in CONTENT_ACTIONS else pid, "type": ACTION_LABEL.get(e.action, e.action)})
            nodes.setdefault(pid, _event_node(parent))
            nodes[pid]["root"] = pid in root_ids
            if parent.agent_id != "src":
                nodes.setdefault(parent.agent_id, _agent_node(agents.get(parent.agent_id), parent.agent_id, parent.agent_name, sim))
                if not any(lk["source"] == parent.agent_id and lk["target"] == pid for lk in links):
                    links.append({"source": parent.agent_id, "target": pid, "type": ACTION_LABEL.get(parent.action, "POSTED")})
        frontier = nxt
    return {"scope": "post", "nodes": list(nodes.values()), "links": links, "roots": sorted(root_ids), "events": len(seen_ev)}


def agent_graph(db: Session, sim: Simulation, agent_id: str) -> dict:
    evs = events_of(db, sim.id)
    roots = [e.id for e in evs if e.agent_id == agent_id and e.action in ("CREATE_POST", "CREATE_COMMENT")]
    g = cascade_graph(db, sim, roots)
    g["scope"] = "agent"
    return g


# ---------------------------------------------------------------- analyst-triggered actions
def _influence(sim: Simulation, stances: dict[str, float], reader: str, post_stance: float, author_inf: float, weight: float) -> None:
    c = sim.config["config"]
    d = post_stance - stances[reader]
    if abs(d) < c.get("epsilon", 0.6):
        stances[reader] += c.get("mu", 0.2) * author_inf * weight * d
    else:
        stances[reader] -= c.get("backfire", 0.04) * weight * math.copysign(1, d)
    stances[reader] = max(-1.0, min(1.0, stances[reader]))


def _text_for(sim: Simulation, agent: dict, stance: float, action: str, target: SimEvent | None, rng: random.Random, use_llm: bool) -> tuple[str, str]:
    focus = (sim.config.get("config") or {}).get("focus_name") or "the issue"
    topic = rng.choice(agent["interests"]) if agent.get("interests") else "the people affected"
    if use_llm and llm.available() and action in ("CREATE_POST", "CREATE_COMMENT"):
        who = "a SYNTHETIC persona (fictional)" if agent.get("synthetic") else "an agent"
        system = (f"You are {agent['name']} ({agent['profession']}), {who} in a social simulation about {focus}. Persona: {agent['persona']} "
                  f"Your stance on {focus}: {stance:+.2f} (-1 opposes, +1 supports). Write ONE "
                  f"{'reply' if target else 'post'}, at most 45 words, plain text, no hashtags, no invented statistics.")
        prompt = f"Reply to {target.agent_name}: \"{target.content}\"" if target else f"Write your post about {focus}."
        try:
            return llm.chat(system, [{"role": "user", "content": prompt}], temperature=0.8, max_tokens=110).strip().strip('"')[:600], llm.name()
        except Exception:  # fall through to templates
            pass
    if action == "CREATE_COMMENT" and target is not None:
        agree = abs(stance - target.stance) < sim.config["config"].get("epsilon", 0.6)
        return rng.choice(REPLIES["agree" if agree else "disagree"]).format(f=focus, i=topic), "template"
    return rng.choice(POSTS[lean(stance)]).format(f=focus, i=topic), "template"


def trigger(db: Session, sim: Simulation, *, agent_id: str, action: str, platform: str, target: SimEvent | None, content: str,
            react: bool, use_llm: bool, actor: str) -> list[SimEvent]:
    agents = agents_of(sim)
    agent = agents[agent_id]
    series = {k: list(v) for k, v in (sim.stats.get("series") or {}).items()}
    stances = {a: (series[a][-1] if series.get(a) else float(x["stance"])) for a, x in agents.items()}
    rnd = max([e.round for e in events_of(db, sim.id)] + [0]) + 1
    rng = random.Random(int(hashlib.sha1(f"{sim.id}|{rnd}|{agent_id}|{action}".encode()).hexdigest()[:8], 16))
    created: list[SimEvent] = []
    plat = target.platform if target else platform

    def emit(a_id: str, a_name: str, act: str, text: str, tgt: SimEvent | None, st: float, by: str, r: int, plt: str) -> SimEvent:
        ev = SimEvent(id=new_id("se"), simulation_id=sim.id, round=r, platform=plt, agent_id=a_id, agent_name=a_name, action=act, content=text,
                      target_id=tgt.id if tgt else None, stance=round(st, 3), generated_by=by, likes=0, replies=0, reposts=0)
        db.add(ev)
        created.append(ev)
        if tgt is not None:
            if act == "LIKE_POST":
                tgt.likes += 1
            elif act == "REPOST":
                tgt.reposts += 1
            elif act == "CREATE_COMMENT":
                tgt.replies += 1
        return ev

    text, by = content.strip(), "analyst-trigger"
    if action == "REPOST":
        text = target.content
    elif action in ("CREATE_POST", "CREATE_COMMENT") and not text:
        text, by = _text_for(sim, agent, stances[agent_id], action, target, rng, use_llm)
        by = by if by != "template" else "analyst-trigger · template"
    elif action in ("CREATE_POST", "CREATE_COMMENT"):
        by = "analyst-trigger · typed"
    if target is not None and target.agent_id in agents:
        _influence(sim, stances, agent_id, target.stance, agents[target.agent_id].get("influence", 0.5), 1.0 if action != "DISLIKE_POST" else 0.5)
    root = emit(agent_id, agent["name"], action, text, target, stances[agent_id], by, rnd, plat)
    db.flush()

    if react and action in CONTENT_ACTIONS:
        eps = sim.config["config"].get("epsilon", 0.6)
        pool = [a for a in agents.values() if a.get("speaks", True) and a["id"] != agent_id]
        rng.shuffle(pool)
        for a in pool:
            if len(created) > 13:
                break
            p = min(0.9, 0.2 + 0.55 * a.get("activity", 0.5)) * (0.6 + 0.4 * agent.get("influence", 0.5))
            if rng.random() > p:
                continue
            close = abs(stances[a["id"]] - root.stance) < eps
            kind = rng.choices(["LIKE_POST", "REPOST", "CREATE_COMMENT"], [0.45, 0.2, 0.35] if close else [0.0, 0.0, 0.5])[0]
            if not close and plat == "forum" and rng.random() < 0.5:
                kind = "DISLIKE_POST"
            elif not close and kind != "CREATE_COMMENT":
                kind = "CREATE_COMMENT"
            _influence(sim, stances, a["id"], root.stance, agent.get("influence", 0.5), 0.7)
            t2, b2 = ("", "reaction-model")
            if kind == "CREATE_COMMENT":
                t2, _ = _text_for(sim, a, stances[a["id"]], kind, root, rng, False)
            elif kind == "REPOST":
                t2 = root.content
            emit(a["id"], a["name"], kind, t2, root, stances[a["id"]], b2, rnd + 1, plat)

    for aid, v in stances.items():
        if series.get(aid):
            series[aid][-1] = round(v, 3)
    sim.stats = {**sim.stats, "series": series, "manual_events": sim.stats.get("manual_events", 0) + len(created)}
    db.flush()
    return created
