"""Synthetic persona import for environments.

Parses persona lines in the case-study format

    - **SIM01 — Ethiopian logistics entrepreneur (Ethiopia; supportive)** [stance +0.6]: "…" [simulation topic T01]

(bold markers, the stance tag and the topic tag are optional) into agents that are always
flagged `synthetic`. Stance comes from an explicit [stance x] tag, else from the viewpoint
word ("supportive", "sovereignty focused", …), else 0. Topic codes resolve through a
"Topic codes: T01 commerce; T02 …" line in the pasted text or an explicit mapping.
"""
import hashlib
import math
import re

from app.services import behavior

_LINE = re.compile(
    r"^\s*[-*•]?\s*\**\s*(?P<pid>(?:SIM|SYN)[-\s]?\w+)\s*[—–-]+\s*(?P<label>[^(;]+?)\s*\((?P<where>[^;]+);\s*(?P<view>[^;]+?)\)\s*\**"
    r"\s*(?:\[stance\s*(?P<stance>[+-]?\d*\.?\d+)\])?\s*:?\s*[“\"](?P<quote>.+?)[”\"]\s*(?:\[(?:simulation\s+)?topic\s*(?P<topic>T\d+)\])?",
    re.I)
_TOPIC_LINE = re.compile(r"\b(T\d{2})\s+([^;.\n]+)")
VIEW_STANCE = [  # first match wins; most specific phrases first
    ("cautiously supportive", 0.35), ("commercially supportive", 0.5), ("recognition-supportive", 0.5),
    ("government-aligned", 0.6), ("government-critical", -0.5), ("tplf-aligned", -0.7), ("tplf-sympathetic", -0.5),
    ("supportive", 0.6), ("sovereignty", -0.5), ("security", -0.4), ("legal", -0.3), ("questioning", -0.15),
    ("cautious", -0.2), ("risk", -0.25), ("regionalist", 0.2), ("conditional", 0.1), ("pragmatic", 0.1),
    ("commercial", 0.2), ("investment", 0.3), ("partnership", 0.3), ("mediation", 0.2),
]


def view_stance(view: str) -> float:
    v = view.lower()
    return next((s for k, s in VIEW_STANCE if k in v), 0.0)


def _join_wrapped(text: str) -> list[str]:
    """PDF text and pasted Markdown wrap persona lines; glue continuation lines back on."""
    out: list[str] = []
    for raw in text.replace("\r", "").split("\n"):
        line = raw.strip()
        if not line:
            continue
        starts = re.match(r"^[-*•]?\s*\**\s*(SIM|SYN)[-\s]?\w+\s*[—–-]", line, re.I)
        if starts or not out:
            out.append(line)
        else:
            out[-1] += " " + line
    return out


def parse(text: str, topics: dict[str, str] | None = None) -> tuple[list[dict], list[str]]:
    topics = dict(topics or {})
    legend = re.search(r"topic codes?:(.*?)(?:\n\s*[-*•]|\Z)", text, re.I | re.S)
    if legend:
        topics.update({k: v.strip() for k, v in _TOPIC_LINE.findall(legend.group(1).replace("\n", " "))})
    personas, skipped = [], []
    for line in _join_wrapped(text):
        if not re.match(r"^[-*•]?\s*\**\s*(SIM|SYN)", line, re.I):
            continue
        m = _LINE.match(line)
        if not m:
            skipped.append(line[:120])
            continue
        g = m.groupdict()
        stance = float(g["stance"]) if g["stance"] else view_stance(g["view"])
        personas.append({"pid": re.sub(r"\s", "", g["pid"]).upper(), "label": g["label"].strip(" *"), "where": g["where"].strip(),
                         "view": g["view"].strip(), "stance": max(-1.0, min(1.0, stance)), "quote": g["quote"].strip(),
                         "topic": topics.get((g["topic"] or "").upper(), g["topic"] or "")})
    return personas, skipped


def to_agents(personas: list[dict], platforms: list[str], existing_ids: set[str]) -> list[dict]:
    agents = []
    n = max(1, len(personas))
    for i, p in enumerate(personas):
        aid = "syn_" + hashlib.sha1(f"{p['pid']}|{p['label']}".encode()).hexdigest()[:10]
        if aid in existing_ids:
            continue
        ang = 2 * math.pi * i / n
        handle = "@" + re.sub(r"[^a-z0-9]+", "_", f"{p['pid']}_{p['label']}".lower()).strip("_")[:28]
        agents.append({
            "id": aid, "node_id": None, "name": f"{p['label']} ({p['pid']})", "handle": handle, "kind": "individual",
            "entity_type": "person", "profession": p["label"], "country": p["where"], "viewpoint": p["view"],
            "interests": [t for t in (p["topic"], p["where"]) if t],
            "bio": f"Synthetic persona — {p['label']}, {p['where']}; {p['view']} viewpoint. Not a real person.",
            "persona": f"A {p['view']} {p['label'].lower()} from {p['where']}. Example of how they talk: “{p['quote']}”",
            "facts": [], "stance": round(p["stance"], 2), "stance_source": "analyst", "influence": 0.35, "activity": 0.65,
            "tone": p["view"], "followers": 250 + 40 * i, "platforms": platforms, "generated_by": "analyst · synthetic",
            "synthetic": True, "speaks": True, "persona_id": p["pid"],
            "x": round(400 + 430 * math.cos(ang)), "y": round(300 + 330 * math.sin(ang)),
        })
        agents[-1]["behavior"] = behavior.clean(agents[-1])
    return agents


def links_for(new: list[dict], everyone: list[dict]) -> list[dict]:
    """Weak ties between synthetic personas that share a topic or a country (never to real actors)."""
    links, seen = [], set()
    syn = [a for a in everyone if a.get("synthetic")]
    for a in new:
        ties = 0
        for b in syn:
            if b["id"] == a["id"] or ties >= 4:
                continue
            key = tuple(sorted((a["id"], b["id"])))
            if key in seen:
                continue
            same_topic = bool(set(a["interests"][:1]) & set(b["interests"][:1]))
            same_place = a.get("country") and a.get("country") == b.get("country")
            if same_topic or same_place:
                seen.add(key)
                ties += 1
                links.append({"id": f"l_{key[0]}_{key[1]}", "s": key[0], "o": key[1], "kind": "shared" if same_topic else "contact",
                              "relation": "same topic" if same_topic else f"both in {a['country']}", "weight": 0.3})
    return links
