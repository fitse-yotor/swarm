"""Per-agent behaviour: which actions an agent tends to take, and how it answers replies to its own posts.

An agent's `behavior` (stored on the agent, so no schema change) has:
- `mix`: relative weight of each action when the agent is active (post, comment, repost, like, dislike, follow);
- `responsiveness` 0..1: chance that it answers a comment on one of its posts;
- `reply_style`: how it answers.
    engage       replies to comments it agrees with and to ones it disagrees with
    debate       likes agreeing comments briefly, writes a rebuttal to disagreeing ones
    acknowledge  likes agreeing comments, mostly lets disagreeing ones pass
    ignore       never answers

Presets give sensible starting points; an agent without a `behavior` gets one derived from its kind and stance.
Everything here is plain arithmetic on seeded random draws, so runs and triggered reactions stay reproducible.
"""
import random

KEYS = ("post", "comment", "repost", "like", "dislike", "follow")
ENGINE_ACTION = {"post": "CREATE_POST", "comment": "CREATE_COMMENT", "repost": "REPOST", "like": "LIKE_POST",
                 "dislike": "DISLIKE_POST", "follow": "FOLLOW"}
PLATFORM_KEYS = {"microblog": ("post", "comment", "repost", "like", "follow"),
                 "forum": ("post", "comment", "like", "dislike")}
REPLY_STYLES = ("engage", "debate", "acknowledge", "ignore")
IDLE = 0.14  # share of active turns an agent does nothing, as in the original fixed table

PRESETS: dict[str, dict] = {
    "balanced": {"label": "Balanced", "desc": "A bit of everything; answers about half the comments it gets.",
                 "mix": {"post": .22, "comment": .2, "repost": .12, "like": .3, "dislike": .06, "follow": .06},
                 "responsiveness": .5, "reply_style": "engage"},
    "broadcaster": {"label": "Broadcaster", "desc": "Posts statements often, rarely replies. Typical of institutions and governments.",
                    "mix": {"post": .55, "comment": .08, "repost": .1, "like": .15, "dislike": .02, "follow": .1},
                    "responsiveness": .2, "reply_style": "acknowledge"},
    "commenter": {"label": "Commenter", "desc": "Mostly replies to other people's posts and answers replies to its own.",
                  "mix": {"post": .1, "comment": .5, "repost": .05, "like": .2, "dislike": .05, "follow": .1},
                  "responsiveness": .8, "reply_style": "engage"},
    "debater": {"label": "Debater", "desc": "Argues. Rebuts people who disagree and barely acknowledges those who agree.",
                "mix": {"post": .15, "comment": .5, "repost": .05, "like": .1, "dislike": .15, "follow": .05},
                "responsiveness": .85, "reply_style": "debate"},
    "amplifier": {"label": "Amplifier", "desc": "Reposts and likes what it agrees with; seldom writes anything itself.",
                  "mix": {"post": .08, "comment": .07, "repost": .4, "like": .4, "dislike": .0, "follow": .05},
                  "responsiveness": .3, "reply_style": "acknowledge"},
    "lurker": {"label": "Lurker", "desc": "Reads and likes. Almost never posts or replies.",
               "mix": {"post": .03, "comment": .04, "repost": .05, "like": .78, "dislike": .05, "follow": .05},
               "responsiveness": .1, "reply_style": "acknowledge"},
}


def preset_catalogue() -> list[dict]:
    return [{"id": k, **{f: v[f] for f in ("label", "desc", "mix", "responsiveness", "reply_style")}} for k, v in PRESETS.items()]


def default_preset(agent: dict) -> str:
    kind = agent.get("kind", "individual")
    if kind in ("state", "institution"):
        return "broadcaster"
    return "debater" if abs(float(agent.get("stance", 0))) > .55 else "balanced"


def _norm(mix: dict) -> dict[str, float]:
    m = {k: max(0.0, float(mix.get(k, 0))) for k in KEYS}
    total = sum(m.values())
    return {k: round(v / total, 4) for k, v in m.items()} if total > 0 else dict(PRESETS["balanced"]["mix"])


def resolve(agent: dict) -> dict:
    """The agent's full behaviour: stored values over the preset (stored or derived)."""
    b = agent.get("behavior") or {}
    pid = b.get("preset") if b.get("preset") in PRESETS else default_preset(agent)
    base = PRESETS[pid]
    style = b.get("reply_style") if b.get("reply_style") in REPLY_STYLES else base["reply_style"]
    resp = b.get("responsiveness", base["responsiveness"])
    return {"preset": pid, "label": base["label"], "mix": _norm(b.get("mix") or base["mix"]),
            "responsiveness": round(max(0.0, min(1.0, float(resp))), 2), "reply_style": style}


def clean(agent: dict) -> dict:
    """Validated `behavior` to store on the agent (called when an environment is saved)."""
    r = resolve(agent)
    return {"preset": r["preset"], "mix": r["mix"], "responsiveness": r["responsiveness"], "reply_style": r["reply_style"]}


def with_default(agent: dict) -> dict:
    return {**agent, "behavior": clean(agent)}


def action_weights(agent: dict, platform: str) -> list[tuple[str, float]]:
    """(engine action, weight) pairs for one active turn on a platform, including doing nothing."""
    mix = resolve(agent)["mix"]
    allowed = PLATFORM_KEYS.get(platform, PLATFORM_KEYS["microblog"])
    total = sum(mix[k] for k in allowed) or 1.0
    out = [(ENGINE_ACTION[k], (1 - IDLE) * mix[k] / total) for k in allowed]
    return [*out, ("DO_NOTHING", IDLE)]


def reaction_weights(agent: dict, agrees: bool, platform: str) -> tuple[list[str], list[float]]:
    """How a bystander reacts to a new post: like / repost / comment (or dislike) weighted by its behaviour."""
    mix = resolve(agent)["mix"]
    if agrees:
        pairs = [("LIKE_POST", mix["like"]), ("CREATE_COMMENT", mix["comment"])]
        if platform == "microblog":
            pairs.append(("REPOST", mix["repost"]))
    else:
        pairs = [("CREATE_COMMENT", mix["comment"])]
        if platform == "forum":
            pairs.append(("DISLIKE_POST", mix["dislike"]))
    if sum(w for _, w in pairs) <= 0:
        pairs = [(pairs[0][0], 1.0)]
    return [a for a, _ in pairs], [w for _, w in pairs]


def decide_response(agent: dict, own_stance: float, incoming_stance: float, epsilon: float, rng: random.Random) -> dict:
    """What the author of a post does when someone comments on it.

    Returns {"action": CREATE_COMMENT | LIKE_POST | None, "reason": str, "agrees": bool, "gap": float}.
    """
    b = resolve(agent)
    gap = abs(own_stance - incoming_stance)
    agrees = gap < epsilon
    who = f"{b['label']}, answers {round(b['responsiveness'] * 100)}% of comments"
    if b["reply_style"] == "ignore" or rng.random() > b["responsiveness"]:
        return {"action": None, "agrees": agrees, "gap": gap, "reason": f"{who}: not answering this one (stance gap {gap:.2f})"}
    style = b["reply_style"]
    if agrees:
        action = {"engage": "CREATE_COMMENT" if rng.random() < .5 else "LIKE_POST", "debate": "LIKE_POST",
                  "acknowledge": "LIKE_POST"}[style]
        why = "agrees" if action == "LIKE_POST" else "agrees and joins in"
    else:
        take = {"engage": 1.0, "debate": 1.0, "acknowledge": .35}[style]
        action = "CREATE_COMMENT" if rng.random() < take else None
        why = "disagrees and rebuts" if style == "debate" else "disagrees and replies"
        if action is None:
            return {"action": None, "agrees": agrees, "gap": gap, "reason": f"{who}: disagrees (gap {gap:.2f}) but lets it pass"}
    return {"action": action, "agrees": agrees, "gap": gap, "reason": f"{who}: {why} (stance gap {gap:.2f} {'<' if agrees else '≥'} ε {epsilon:g})"}


def counts_by_agent(events) -> dict[str, dict[str, int]]:
    """Per-agent tally of what they did in a run (events: SimEvent rows)."""
    names = {"CREATE_POST": "posts", "CREATE_COMMENT": "comments", "REPOST": "reposts", "LIKE_POST": "likes",
             "DISLIKE_POST": "dislikes", "FOLLOW": "follows"}
    out: dict[str, dict[str, int]] = {}
    for e in events:
        k = names.get(e.action)
        if k and e.agent_id != "src":
            d = out.setdefault(e.agent_id, {n: 0 for n in names.values()})
            d[k] += 1
    return out
