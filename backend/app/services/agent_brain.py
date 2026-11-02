"""AI-agent turns: the local model decides what one simulated actor does, and writes it.

What an agent knows when it acts (nothing here is a template):
- the geopolitics briefing (app/knowledge/ethiopia_geopolitics.md) plus any analyst notes for the environment;
- its own persona, role, facts from the case graph, tone, interests and current stance;
- the case-document passages most relevant to what it is looking at (vector search over the case's chunks);
- the breaking development (the scenario) once it has been injected;
- its feed on the platform it chose, and its own last actions.
The model returns ONE structured decision (action, target post, text, new stance, a one-sentence reason).
The engine validates and applies it; stance can move at most MAX_SHIFT per turn so one reply cannot flip an actor.
"""
import logging
import re
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import DocumentChunk, SimEvent, SourceDocument
from app.services import embeddings, llm

log = logging.getLogger(__name__)
MAX_SHIFT = 0.35
PRIMER_FILE = Path(__file__).resolve().parent.parent / "knowledge" / "ethiopia_geopolitics.md"


class TurnDecision(BaseModel):
    action: Literal["POST", "COMMENT", "REPOST", "LIKE", "DISLIKE", "NOTHING"]
    target: int  # number of the feed item acted on (1-based); 0 when posting or doing nothing
    text: str    # the post or comment, in the actor's own voice; empty for REPOST, LIKE, DISLIKE, NOTHING
    stance_after: float  # -1 (opposes the focus issue) .. +1 (supports it)
    why: str     # one sentence: the geopolitical or personal consideration behind this action


@lru_cache
def primer() -> str:
    return PRIMER_FILE.read_text(encoding="utf-8")


def passages(db: Session, case_id: str, query: str, k: int = 3) -> list[str]:
    """Top-k case-document passages for a query (pgvector cosine), trimmed for the prompt."""
    try:
        qvec = embeddings.embed([query])[0]
        rows = db.execute(select(DocumentChunk.text, SourceDocument.filename)
                          .join(SourceDocument, SourceDocument.id == DocumentChunk.document_id)
                          .where(DocumentChunk.case_id == case_id, DocumentChunk.embedding.is_not(None))
                          .order_by(DocumentChunk.embedding.cosine_distance(qvec)).limit(k)).all()
    except Exception as e:  # retrieval is a help, not a requirement
        log.warning("passage retrieval failed: %s", e)
        return []
    return [f"[{name[:40]}] {text[:420]}" for text, name in rows]


def _label(a: dict) -> str:
    if a.get("synthetic"):
        return "a SYNTHETIC persona: a fictional archetype, not a real person"
    if a.get("entity_type") == "country":
        return "a state (simulated voice; its documented positions only)"
    if a.get("entity_type") == "organization":
        return "an institution (simulated voice; its documented positions only)"
    return "a public figure (simulated statement; never a claimed quotation)"


def split_voice(persona: str) -> tuple[str, str]:
    """Separate a persona's description from its example sentence, so the model uses the voice without copying the words."""
    m = re.search(r"\s*Example of how they talk:\s*[\u201c\"](.+?)[\u201d\"]\s*$", persona, re.S)
    return (persona[:m.start()].strip(), m.group(1).strip()) if m else (persona.strip(), "")


def build_prompt(*, agent: dict, stance: float, focus: str, scenario: str | None, notes: str, platform: str,
                 feed: list[SimEvent], own: list[SimEvent], found: list[str]) -> tuple[str, str]:
    desc, sample = split_voice(agent.get("persona") or agent.get("bio", ""))
    system = (
        f"You are {agent['name']}, {agent['profession']}: {_label(agent)}. You are one actor in a social-media simulation about "
        f"\"{focus}\". Act exactly as this actor realistically would, using the background briefing below; do not break character, "
        "never mention an AI, a simulation, a case study, passages or a briefing. Reason from your own interests, role, fears and "
        "current stance. Never invent statistics, dates, events or quotations that are not in the briefing, the passages or your feed. "
        f"Keep the tone of {platform} (short, direct, plain language).\n\n"
        "QUALITY BAR: show real understanding of the geopolitics. Every POST or COMMENT must name at least one concrete actor, event, "
        "agreement or interest from the briefing, the passages or the feed that matters to YOUR role (for example Djibouti's port role, "
        "the Ankara Declaration, the Somaliland memorandum, GERD and Egypt, Eritrea's security fears, Pretoria and Tigray), and say what it "
        "means for you or your side. Take a position; do not repeat what others said, and do not write generic statements.\n\n"
        f"YOUR PERSONA: {desc}\n"
        + (f"Your general way of speaking (paraphrase the idea in NEW words; never copy this sentence): \u201c{sample}\u201d\n" if sample else "")
        + f"Tone: {agent.get('tone', 'neutral')}. Interests: {', '.join(agent.get('interests', [])[:5]) or 'the case'}.\n"
        + ("Facts about you from the case graph:\n" + "\n".join(f"- {f}" for f in agent.get("facts", [])[:8]) + "\n" if agent.get("facts") else "")
        + f"Your current stance on the focus issue: {stance:+.2f} (-1 opposes, 0 neutral, +1 supports).\n\n"
        + primer() + (f"\nANALYST NOTES FOR THIS CASE:\n{notes.strip()}\n" if notes.strip() else ""))
    lines = [f"{i}. {e.agent_name} ({'scenario' if e.agent_id == 'src' else e.action.replace('CREATE_', '').lower()}, round {e.round}; "
             f"{e.likes} likes, {e.reposts} reposts, {e.replies} replies): {e.content[:260]}" for i, e in enumerate(feed, 1)]
    mine = [f"- round {e.round}: {e.action.replace('CREATE_', '').lower()} “{e.content[:140]}”" for e in own[-3:] if e.content]
    user = (
        (f"BREAKING DEVELOPMENT (everyone has heard this): {scenario}\n\n" if scenario else "")
        + ("PASSAGES FROM THE CASE DOCUMENTS most relevant to your feed:\n" + "\n".join(f"- {p}" for p in found) + "\n\n" if found else "")
        + ("YOUR RECENT ACTIONS:\n" + "\n".join(mine) + "\n\n" if mine else "")
        + (f"YOUR {platform.upper()} FEED:\n" + "\n".join(lines) if lines else f"YOUR {platform.upper()} FEED: (empty — nobody has posted yet)")
        + "\n\nDecide ONE action: POST (new post), COMMENT (reply to a numbered feed item), REPOST (share a numbered item), LIKE, "
          "DISLIKE (forum only) or NOTHING. Write text of at most 60 words for POST and COMMENT, in your own voice, reacting to the "
          "feed and the geopolitical situation as you understand it. stance_after is your stance after this turn; change it by at "
          "most 0.35 and only if something you read actually moved you. why: one sentence on the consideration behind your action.")
    return system, user


def decide(db: Session, *, case_id: str, agent: dict, stance: float, focus: str, scenario: str | None, notes: str, platform: str,
           feed: list[SimEvent], own: list[SimEvent]) -> TurnDecision:
    query = " ".join([focus, agent.get("profession", ""), *[e.content[:120] for e in feed[:2]]])
    found = passages(db, case_id, query)
    system, user = build_prompt(agent=agent, stance=stance, focus=focus, scenario=scenario, notes=notes, platform=platform,
                                feed=feed, own=own, found=found)
    d = llm.structured(system, user, TurnDecision, temperature=0.7, max_tokens=320, model=llm.agent_model())
    d.text = d.text.strip().strip('"')[:700]
    d.why = d.why.strip()[:300]
    d.stance_after = max(stance - MAX_SHIFT, min(stance + MAX_SHIFT, max(-1.0, min(1.0, d.stance_after))))
    return d
