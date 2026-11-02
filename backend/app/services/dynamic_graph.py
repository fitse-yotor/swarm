"""One evolving graph per case, in three layers, with append-only change events and immutable snapshots.

Layers (every node and edge carries `layer` and `provenance`):
  research    approved, source-grounded entities and relationships (provenance `sourced`). Read from the approved
              graph version; nothing in this module ever writes to it.
  reaction    generated reaction hypotheses linked to their actor (provenance `generated_hypothesis`).
  simulation  synthetic agents, their simulated relationships and statements (provenance `simulation_generated`).

The simulation layer is a pure fold over `GraphEvent` rows: state = base agents + every event applied in order. So the
"current graph" is a projection (research + reactions + the fold up to now), a snapshot is the same projection frozen
at a moment, and a simulation can never overwrite a research fact because it has no path to write one.

The graph UI and any external simulation engine meet this module only through `Recorder` / `ingest` (events in)
and `live_state` / `to_graph` / `diff` (graph out).
"""
import copy
import hashlib
import json
import math
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import (
    Case,
    Environment,
    GraphEvent,
    GraphSnapshot,
    GraphVersion,
    Reaction,
    ReactionRun,
    SimEvent,
    Simulation,
)
from app.services import graph_store

LAYERS = ("research", "reaction", "simulation")
PROVENANCE = {"research": "sourced", "reaction": "generated_hypothesis", "simulation": "simulation_generated"}
EVENT_TYPES = ("STATEMENT_PUBLISHED", "RESPONDED_TO", "REACTED_TO_EVENT", "POSITION_CHANGED", "RELATIONSHIP_FORMED",
               "RELATIONSHIP_STRENGTHENED", "RELATIONSHIP_WEAKENED", "ALLIANCE_FORMED")
SNAPSHOT_REASONS = ("research_approved", "reactions_generated", "simulation_start", "checkpoint", "simulation_complete", "manual")
APPROVED = {"approved", "manual"}
STANCE_EPS = 0.05          # smaller stance moves are not recorded as a position change
ALLIANCE_AFFINITY = 3      # mutual positive interactions needed before an alliance is recorded
POSITIVE = ("LIKED", "REPOSTED", "FOLLOWS")
COMPARED = ("label", "type", "status", "confidence", "stance", "strength")
_RESEARCH_CACHE: dict[tuple[str, str], dict] = {}  # approved versions are immutable, so their layer can be cached


def snip(text: str, n: int = 160) -> str:
    t = " ".join((text or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def hash_state(state: dict) -> str:
    return hashlib.sha256(json.dumps(state, sort_keys=True, default=str).encode()).hexdigest()


# ---------------------------------------------------------------- layers
def research_layer(version: GraphVersion | None) -> dict:
    """Approved entities and relationships of one graph version. Unapproved or rejected items are never included."""
    if version is None:
        return {"version_id": None, "version_label": None, "content_hash": None, "nodes": [], "edges": [], "unavailable": False}
    base = {"version_id": version.id, "version_label": version.label, "content_hash": version.content_hash, "unavailable": False}
    key = (version.id, version.content_hash or "")
    if version.status == "approved" and key in _RESEARCH_CACHE:
        return _RESEARCH_CACHE[key]
    try:
        nodes, edges = graph_store.read_version(version.id)
    except Exception:  # noqa: BLE001 — graph store down: say so instead of pretending the layer is empty
        return {**base, "nodes": [], "edges": [], "unavailable": True}
    keep = [n for n in nodes if n.get("status") in APPROVED]
    ids = {n["id"] for n in keep}
    layer = {**base,
             "nodes": [{"id": n["id"], "name": n["name"], "type": n["type"], "status": n["status"], "confidence": round(float(n.get("confidence") or 0), 3),
                        "description": snip(n.get("description") or "", 240), "evidence_ids": list(n.get("evidence_ids") or [])} for n in keep],
             "edges": [{"id": e["id"], "s": e["s"], "o": e["o"], "type": e["type"], "status": e["status"], "confidence": round(float(e.get("confidence") or 0), 3),
                        "directed": bool(e.get("directed", True)), "statement": snip(e.get("statement") or "", 240), "evidence_ids": list(e.get("evidence_ids") or [])}
                       for e in edges if e.get("status") in APPROVED and e["s"] in ids and e["o"] in ids]}
    if version.status == "approved":
        if len(_RESEARCH_CACHE) > 32:
            _RESEARCH_CACHE.clear()
        _RESEARCH_CACHE[key] = layer
    return layer


def reaction_layer(db: Session, case_id: str, run_id: str | None = None) -> dict:
    run = db.get(ReactionRun, run_id) if run_id else db.scalar(
        select(ReactionRun).where(ReactionRun.case_id == case_id, ReactionRun.status == "ready").order_by(ReactionRun.number.desc()))
    if run is None or run.case_id != case_id:
        return {"run_id": None, "run_number": None, "mode": None, "items": []}
    rows = db.scalars(select(Reaction).where(Reaction.run_id == run.id).order_by(Reaction.created_at, Reaction.id))
    return {"run_id": run.id, "run_number": run.number, "mode": run.mode, "items": [
        {"id": r.id, "actor_id": r.actor_id, "actor_name": r.actor_name, "title": r.title, "category": r.category, "status": r.status,
         "confidence": round(r.confidence, 3), "edited": r.edited} for r in rows]}


def sim_base(sim: Simulation) -> dict:
    agents = {a["id"]: {"name": a["name"], "kind": a.get("kind", "individual"), "synthetic": bool(a.get("synthetic")), "node_id": a.get("node_id"),
                        "speaks": a.get("speaks", True), "stance": round(float(a.get("stance", 0)), 3), "stance0": round(float(a.get("stance", 0)), 3)}
              for a in (sim.config or {}).get("agents", [])}
    return {"run_id": sim.id, "run_name": sim.name, "attempt": 1, "step": -1, "seq": 0, "graph_version": 0, "agents": agents, "edges": {}, "statements": {}}


def fold(state: dict, events) -> dict:
    """Apply graph events (rows or dicts) to a simulation state in order. Pure: the same events give the same state."""
    for ev in events:
        get = (lambda k, ev=ev: ev[k]) if isinstance(ev, dict) else (lambda k, ev=ev: getattr(ev, k))
        after = get("after") or {}
        if (a := after.get("agent")) and a["id"] in state["agents"]:
            state["agents"][a["id"]]["stance"] = round(float(a["stance"]), 3)
        if (e := after.get("edge")):
            if e["strength"] <= 0:
                state["edges"].pop(e["key"], None)
            else:
                state["edges"][e["key"]] = {"s": e["s"], "o": e["o"], "kind": e["kind"], "strength": int(e["strength"]), "polarity": e.get("polarity", "positive")}
        if (st := after.get("statement")):
            state["statements"][st["id"]] = {"agent": st.get("agent"), "step": st.get("step"), "text": st.get("text", ""), "kind": st.get("kind", "statement")}
        state["step"], state["seq"] = max(state["step"], get("step")), max(state["seq"], get("seq"))
        state["graph_version"] = max(state["graph_version"], get("graph_version"))
    return state


def latest_attempt(db: Session, sim_id: str) -> int:
    return db.scalar(select(func.max(GraphEvent.attempt)).where(GraphEvent.run_id == sim_id)) or 1


def sim_state(db: Session, sim: Simulation, upto_seq: int | None = None, attempt: int | None = None) -> dict:
    attempt = attempt or latest_attempt(db, sim.id)
    q = select(GraphEvent).where(GraphEvent.run_id == sim.id, GraphEvent.attempt == attempt).order_by(GraphEvent.seq)
    if upto_seq is not None:
        q = q.where(GraphEvent.seq <= upto_seq)
    st = sim_base(sim)
    st["attempt"] = attempt
    return fold(st, db.scalars(q))


def version_for(db: Session, case_id: str, sim: Simulation | None = None) -> GraphVersion | None:
    """The approved research version a simulation was built from, else the newest approved version of the case."""
    if sim is not None:
        env = db.get(Environment, sim.environment_id)
        v = db.get(GraphVersion, env.version_id) if env else None
        if v is not None and v.status == "approved":
            return v
    return db.scalar(select(GraphVersion).where(GraphVersion.case_id == case_id, GraphVersion.status == "approved").order_by(GraphVersion.number.desc()))


def latest_sim(db: Session, case_id: str) -> Simulation | None:
    return db.scalar(select(Simulation).where(Simulation.case_id == case_id,
                     Simulation.id.in_(select(GraphEvent.run_id).where(GraphEvent.case_id == case_id))).order_by(Simulation.created_at.desc()))


def live_state(db: Session, case: Case, *, simulation_id: str | None = None, upto_seq: int | None = None, version: GraphVersion | None = None,
               reaction_run_id: str | None = None, sim_override: dict | None = None) -> dict:
    """The current graph: approved research + reaction hypotheses + the simulation fold up to now (or up to `upto_seq`)."""
    sim = db.get(Simulation, simulation_id) if simulation_id else latest_sim(db, case.id)
    if sim is not None and sim.case_id != case.id:
        sim = None
    version = version or version_for(db, case.id, sim)
    state = {"research": research_layer(version), "reactions": reaction_layer(db, case.id, reaction_run_id), "simulation": None}
    if sim is not None:
        state["simulation"] = sim_override if sim_override is not None else sim_state(db, sim, upto_seq)
    return state


# ---------------------------------------------------------------- unified graph for the UI
def to_graph(state: dict, include_statements: bool = False) -> dict:
    nodes: list[dict] = []
    edges: list[dict] = []
    r = state.get("research") or {}
    rids = {n["id"] for n in r.get("nodes", [])}
    for n in r.get("nodes", []):
        nodes.append({"id": n["id"], "label": n["name"], "layer": "research", "type": n["type"], "status": n["status"], "provenance": "sourced",
                      "confidence": n["confidence"], "description": n["description"], "evidence_ids": n["evidence_ids"]})
    for e in r.get("edges", []):
        edges.append({"id": e["id"], "s": e["s"], "o": e["o"], "type": e["type"], "layer": "research", "status": e["status"], "provenance": "sourced",
                      "confidence": e["confidence"], "directed": e["directed"], "description": e["statement"], "evidence_ids": e["evidence_ids"]})
    for x in (state.get("reactions") or {}).get("items", []):
        nodes.append({"id": x["id"], "label": x["title"], "layer": "reaction", "type": "reaction", "status": x["status"], "provenance": "generated_hypothesis",
                      "confidence": x["confidence"], "category": x["category"], "actor_id": x["actor_id"], "edited": x["edited"]})
        if x["actor_id"] in rids:
            edges.append({"id": f"{x['id']}>{x['actor_id']}", "s": x["id"], "o": x["actor_id"], "type": "HYPOTHESIS_ABOUT", "layer": "reaction",
                          "status": x["status"], "provenance": "generated_hypothesis", "directed": True})
    s = state.get("simulation")
    if s:
        for aid, a in s["agents"].items():
            nodes.append({"id": f"sim:{aid}", "label": a["name"], "layer": "simulation", "type": "agent", "status": "simulated", "provenance": "simulation_generated",
                          "stance": a["stance"], "stance0": a["stance0"], "synthetic": a["synthetic"], "speaks": a["speaks"]})
            if a.get("node_id") in rids:
                edges.append({"id": f"sim:{aid}>{a['node_id']}", "s": f"sim:{aid}", "o": a["node_id"], "type": "SIMULATES", "layer": "simulation",
                              "status": "simulated", "provenance": "simulation_generated", "directed": True})
        for key, e in s["edges"].items():
            if e["s"] in s["agents"] and e["o"] in s["agents"]:
                edges.append({"id": f"sim:{key}", "s": f"sim:{e['s']}", "o": f"sim:{e['o']}", "type": e["kind"], "layer": "simulation", "status": "simulated",
                              "provenance": "simulation_generated", "strength": e["strength"], "polarity": e.get("polarity", "positive"), "directed": e["kind"] != "ALLIED_WITH"})
        if include_statements:
            for sid, st in s["statements"].items():
                nodes.append({"id": f"sim:{sid}", "label": snip(st["text"], 60), "layer": "simulation", "type": "statement", "status": "simulated",
                              "provenance": "simulation_generated", "description": st["text"], "step": st["step"], "kind": st["kind"]})
                if st.get("agent") in s["agents"]:
                    edges.append({"id": f"sim:{sid}>{st['agent']}", "s": f"sim:{sid}", "o": f"sim:{st['agent']}", "type": "PUBLISHED_BY", "layer": "simulation",
                                  "status": "simulated", "provenance": "simulation_generated", "directed": True})
    meta = {"research": {k: r.get(k) for k in ("version_id", "version_label", "content_hash", "unavailable")},
            "reactions": {k: (state.get("reactions") or {}).get(k) for k in ("run_id", "run_number", "mode")},
            "simulation": {k: s.get(k) for k in ("run_id", "run_name", "attempt", "step", "seq", "graph_version")} if s else None}
    return {"nodes": nodes, "edges": edges, "meta": meta,
            "counts": {l: {"nodes": sum(n["layer"] == l for n in nodes), "edges": sum(e["layer"] == l for e in edges)} for l in LAYERS}}


def _num(v):
    return round(v, 3) if isinstance(v, float) and not math.isnan(v) else v


def diff(a: dict, b: dict, include_statements: bool = True) -> dict:
    """What changed from graph state `a` (earlier) to `b`: added, removed and changed nodes and edges, per layer."""
    ga, gb = to_graph(a, include_statements), to_graph(b, include_statements)
    comparable = {"research": not ((a.get("research") or {}).get("unavailable") or (b.get("research") or {}).get("unavailable"))}
    out = {l: {"nodes": {"added": [], "removed": [], "changed": []}, "edges": {"added": [], "removed": [], "changed": []}} for l in LAYERS}
    for kind in ("nodes", "edges"):
        ia, ib = {x["id"]: x for x in ga[kind]}, {x["id"]: x for x in gb[kind]}
        brief = lambda x: {"id": x["id"], "label": x.get("label") or f"{x.get('type')} {x['id']}", "type": x["type"], "layer": x["layer"]}
        for i, x in ib.items():
            if i not in ia:
                out[x["layer"]][kind]["added"].append(brief(x))
            else:
                fields = {f: [_num(ia[i].get(f)), _num(x.get(f))] for f in COMPARED if _num(ia[i].get(f)) != _num(x.get(f))}
                if fields:
                    out[x["layer"]][kind]["changed"].append({**brief(x), "fields": fields})
        for i, x in ia.items():
            if i not in ib:
                out[x["layer"]][kind]["removed"].append(brief(x))
    for l in LAYERS:  # a layer that could not be read on one side cannot be compared honestly
        if l == "research" and not comparable["research"]:
            out[l] = {g: {"added": [], "removed": [], "changed": []} for g in ("nodes", "edges")}
    summary = {l: {k: sum(len(out[l][g][k]) for g in ("nodes", "edges")) for k in ("added", "removed", "changed")} for l in LAYERS}
    return {"layers": out, "summary": summary, "comparable": comparable}


# ---------------------------------------------------------------- snapshots (append-only)
def next_number(db: Session, case_id: str) -> int:
    return (db.scalar(select(func.max(GraphSnapshot.number)).where(GraphSnapshot.case_id == case_id)) or 0) + 1


def create_snapshot(db: Session, case: Case, reason: str, by: str, *, note: str = "", simulation_id: str | None = None, sim_override: dict | None = None,
                    upto_seq: int | None = None, reaction_run_id: str | None = None, version: GraphVersion | None = None) -> GraphSnapshot:
    """Freeze the current projection. There is no function that edits a snapshot afterwards."""
    if reason not in SNAPSHOT_REASONS:
        raise ValueError(f"Unknown snapshot reason: {reason}")
    state = live_state(db, case, simulation_id=simulation_id, upto_seq=upto_seq, version=version, reaction_run_id=reaction_run_id, sim_override=sim_override)
    sim = state["simulation"]
    parent = db.scalar(select(GraphSnapshot).where(GraphSnapshot.case_id == case.id).order_by(GraphSnapshot.number.desc()))
    snap = GraphSnapshot(case_id=case.id, parent_id=parent.id if parent else None, number=next_number(db, case.id), reason=reason, note=note,
                         version_id=state["research"]["version_id"], simulation_id=sim["run_id"] if sim else None, step=sim["step"] if sim else None,
                         event_seq=sim["seq"] if sim else None, reaction_run_id=state["reactions"]["run_id"], graph_version=sim["graph_version"] if sim else 0,
                         created_by=by, state=copy.deepcopy(state), content_hash=hash_state(state))
    db.add(snap)
    db.flush()
    return snap


def verify(snap: GraphSnapshot) -> bool:
    return hash_state(snap.state) == snap.content_hash


# ---------------------------------------------------------------- change events
class EventError(ValueError):
    pass


def _check(draft: dict, agents: dict) -> dict:
    t = draft.get("event_type")
    if t not in EVENT_TYPES:
        raise EventError(f"event_type must be one of {', '.join(EVENT_TYPES)}")
    for aid in draft.get("actor_ids", []):
        if aid not in agents:
            raise EventError(f"Unknown agent in actor_ids: {aid}")
    after = draft.get("after") or {}
    extra = set(after) - {"agent", "edge", "statement"}
    if extra:
        raise EventError(f"after may only contain agent, edge, statement (got {', '.join(sorted(extra))})")
    a = after.get("agent")
    if a is not None and (a.get("id") not in agents or not isinstance(a.get("stance"), (int, float)) or not -1 <= a["stance"] <= 1):
        raise EventError("after.agent needs a known agent id and a stance between -1 and 1")
    if (e := after.get("edge")) is not None:
        if not all(k in e for k in ("key", "s", "o", "kind", "strength")) or e["s"] not in agents or e["o"] not in agents or e["s"] == e["o"]:
            raise EventError("after.edge needs key, s, o (two different known agents), kind and strength")
        if not isinstance(e["strength"], int) or e["strength"] < 0:
            raise EventError("after.edge.strength must be a non-negative integer")
    if (st := after.get("statement")) is not None and not st.get("id"):
        raise EventError("after.statement needs an id")
    if not after:
        raise EventError("An event must change something: after is empty")
    return draft


class Recorder:
    """Writes graph events for one simulation run and keeps its state in memory so recording a round is cheap."""

    def __init__(self, db: Session, sim: Simulation, attempt: int | None = None, resume: bool = False):
        self.db, self.sim = db, sim
        self.sim_events: dict[str, SimEvent] = {}
        if resume:
            self.state = sim_state(db, sim, attempt=attempt)
            self.sim_events = {e.id: e for e in db.scalars(select(SimEvent).where(SimEvent.simulation_id == sim.id))}
        else:
            self.state = sim_base(sim)
            self.state["attempt"] = (attempt if attempt else latest_attempt(db, sim.id) + (1 if db.scalar(select(func.count()).select_from(GraphEvent).where(GraphEvent.run_id == sim.id)) else 0))
        self.attempt = self.state["attempt"]
        self.names = {a["name"]: aid for aid, a in self.state["agents"].items()}

    # -- translating the engine's actions into explicit graph changes
    def _edge(self, kind: str, s: str, o: str, delta: int, polarity: str = "positive") -> tuple[dict, str, int | None]:
        key = f"{kind}:{s}>{o}" if kind != "ALLIED_WITH" else f"{kind}:{min(s, o)}>{max(s, o)}"
        before = self.state["edges"].get(key, {}).get("strength")
        after = max(0, (before or 0) + delta)
        payload = {"key": key, "s": s, "o": o, "kind": kind, "strength": after, "polarity": polarity}
        etype = "RELATIONSHIP_FORMED" if before is None else "RELATIONSHIP_STRENGTHENED" if delta > 0 else "RELATIONSHIP_WEAKENED"
        return payload, etype, before

    def _apply(self, draft: dict) -> dict:
        fold(self.state, [{"after": draft["after"], "step": draft["step"], "seq": self.state["seq"], "graph_version": self.state["graph_version"]}])
        return draft

    def translate(self, sim_events: list[SimEvent], stances: dict[str, float] | None = None) -> list[dict]:
        out: list[dict] = []
        agents = self.state["agents"]
        for e in sim_events:
            self.sim_events[e.id] = e
        touched: dict[str, SimEvent] = {}
        for e in sim_events:
            a, target = e.agent_id, self.sim_events.get(e.target_id or "")
            if a == "src":
                if e.action == "CREATE_POST":
                    out.append(self._apply({"event_type": "STATEMENT_PUBLISHED", "step": e.round, "actor_ids": [], "trigger_event_id": e.id, "nodes": [f"sim:{e.id}"], "edges": [], "before": {},
                                            "description": f"{e.agent_name} introduced into the simulation: {snip(e.content, 120)}",
                                            "after": {"statement": {"id": e.id, "agent": None, "step": e.round, "text": e.content, "kind": "scenario"}}}))
                continue
            if a not in agents:
                continue
            touched[a] = e
            owner = target.agent_id if target else None
            on_agent = owner in agents and owner != a
            base = {"step": e.round, "actor_ids": [a], "trigger_event_id": e.id, "before": {}}
            name = agents[a]["name"]
            if e.action == "CREATE_POST":
                out.append(self._apply({**base, "event_type": "STATEMENT_PUBLISHED", "nodes": [f"sim:{a}", f"sim:{e.id}"], "edges": [],
                                        "description": f"{name} published a simulated statement: {snip(e.content, 120)}",
                                        "after": {"statement": {"id": e.id, "agent": a, "step": e.round, "text": e.content}}}))
            elif e.action == "CREATE_COMMENT":
                st = {"id": e.id, "agent": a, "step": e.round, "text": e.content}
                if on_agent:
                    pay, _, before = self._edge("REPLIED_TO", a, owner, 1)
                    out.append(self._apply({**base, "event_type": "RESPONDED_TO", "actor_ids": [a, owner], "nodes": [f"sim:{a}", f"sim:{owner}", f"sim:{e.id}"], "edges": [f"sim:{pay['key']}"],
                                            "before": {"strength": before}, "description": f"{name} responded to {agents[owner]['name']}: {snip(e.content, 120)}",
                                            "after": {"edge": pay, "statement": st}}))
                else:
                    out.append(self._apply({**base, "event_type": "REACTED_TO_EVENT", "nodes": [f"sim:{a}", f"sim:{e.id}"], "edges": [],
                                            "description": f"{name} reacted to a simulated event: {snip(e.content, 120)}", "after": {"statement": st}}))
            elif e.action in ("LIKE_POST", "REPOST", "DISLIKE_POST") and target is not None:
                if not on_agent:
                    out.append(self._apply({**base, "event_type": "REACTED_TO_EVENT", "nodes": [f"sim:{a}"], "edges": [], "description": f"{name} reacted to a simulated event ({e.action.split('_')[0].lower()})",
                                            "after": {"statement": {"id": f"{e.id}", "agent": a, "step": e.round, "text": f"{name} {e.action.split('_')[0].lower()}d the scenario", "kind": "reaction"}}}))
                    continue
                kind = {"LIKE_POST": "LIKED", "REPOST": "REPOSTED", "DISLIKE_POST": "DISLIKED"}[e.action]
                pay, etype, before = self._edge(kind, a, owner, 1, "negative" if kind == "DISLIKED" else "positive")
                out.append(self._apply({**base, "event_type": etype, "actor_ids": [a, owner], "nodes": [f"sim:{a}", f"sim:{owner}"], "edges": [f"sim:{pay['key']}"], "before": {"strength": before},
                                        "description": f"{name} {e.action.split('_')[0].lower()}d {agents[owner]['name']}'s post", "after": {"edge": pay}}))
                if kind == "DISLIKED" and self.state["edges"].get(f"LIKED:{a}>{owner}", {}).get("strength", 0) > 0:
                    pay, etype, before = self._edge("LIKED", a, owner, -1)
                    out.append(self._apply({**base, "event_type": "RELATIONSHIP_WEAKENED", "actor_ids": [a, owner], "nodes": [f"sim:{a}", f"sim:{owner}"], "edges": [f"sim:{pay['key']}"],
                                            "before": {"strength": before}, "description": f"{name}'s support for {agents[owner]['name']} weakened after a dislike", "after": {"edge": pay}}))
            elif e.action == "FOLLOW":
                tgt = next((aid for n, aid in self.names.items() if n in e.content), None)
                if tgt and tgt != a:
                    pay, etype, before = self._edge("FOLLOWS", a, tgt, 1)
                    out.append(self._apply({**base, "event_type": etype, "actor_ids": [a, tgt], "nodes": [f"sim:{a}", f"sim:{tgt}"], "edges": [f"sim:{pay['key']}"], "before": {"strength": before},
                                            "description": f"{name} started following {agents[tgt]['name']}", "after": {"edge": pay}}))
            out.extend(self._alliances(a, owner, e))
        # position changes, for every agent whose stance moved, not only those that acted
        for aid, now in (stances or {aid: touched[aid].stance for aid in touched}).items():
            if aid in agents and abs(now - agents[aid]["stance"]) >= STANCE_EPS:
                last = touched.get(aid)
                before = agents[aid]["stance"]
                out.append(self._apply({"event_type": "POSITION_CHANGED", "step": last.round if last else self.state["step"], "actor_ids": [aid], "nodes": [f"sim:{aid}"], "edges": [],
                                        "trigger_event_id": last.id if last else None, "before": {"stance": before},
                                        "description": f"{agents[aid]['name']} moved from {before:+.2f} to {now:+.2f}", "after": {"agent": {"id": aid, "stance": round(now, 3)}}}))
        return out

    def _alliances(self, a: str, b: str | None, e: SimEvent) -> list[dict]:
        if not b or b not in self.state["agents"] or b == a:
            return []
        ed = self.state["edges"]
        key = f"ALLIED_WITH:{min(a, b)}>{max(a, b)}"
        if key in ed:
            return []
        affinity = sum(ed.get(f"{k}:{x}>{y}", {}).get("strength", 0) for k in POSITIVE for x, y in ((a, b), (b, a)))
        both = any(ed.get(f"{k}:{a}>{b}") for k in POSITIVE) and any(ed.get(f"{k}:{b}>{a}") for k in POSITIVE)
        if affinity >= ALLIANCE_AFFINITY and both:
            pay, _, _ = self._edge("ALLIED_WITH", a, b, 1)
            ag = self.state["agents"]
            return [self._apply({"event_type": "ALLIANCE_FORMED", "step": e.round, "actor_ids": [a, b], "nodes": [f"sim:{a}", f"sim:{b}"], "edges": [f"sim:{pay['key']}"], "trigger_event_id": e.id,
                                 "before": {}, "description": f"{ag[a]['name']} and {ag[b]['name']} formed a simulated alliance", "after": {"edge": pay}})]
        return []

    def record(self, sim_events: list[SimEvent], stances: dict[str, float] | None = None) -> list[GraphEvent]:
        """Translate a batch of simulation actions and append the resulting graph events as one new graph version."""
        drafts = self.translate(sim_events, stances)
        return self._write(drafts) if drafts else []

    def _write(self, drafts: list[dict]) -> list[GraphEvent]:
        version = (self.db.scalar(select(func.max(GraphEvent.graph_version)).where(GraphEvent.run_id == self.sim.id, GraphEvent.attempt == self.attempt)) or 0) + 1
        seq = self.db.scalar(select(func.coalesce(func.max(GraphEvent.seq), 0)).where(GraphEvent.run_id == self.sim.id, GraphEvent.attempt == self.attempt))
        rows = []
        for d in drafts:
            seq += 1
            rows.append(GraphEvent(case_id=self.sim.case_id, run_id=self.sim.id, attempt=self.attempt, seq=seq, step=d["step"], event_type=d["event_type"], actor_ids=d.get("actor_ids", []),
                                   description=d.get("description", ""), nodes=d.get("nodes", []), edges=d.get("edges", []), before=d.get("before", {}), after=d["after"],
                                   trigger_event_id=d.get("trigger_event_id"), graph_version=version))
        self.db.add_all(rows)
        self.db.flush()
        self.state["seq"], self.state["graph_version"] = seq, version
        return rows

    def ingest_external(self, drafts: list[dict]) -> list[GraphEvent]:
        """Validated events from an external simulation engine. The state is replayed from storage first."""
        self.state = sim_state(self.db, self.sim, attempt=self.attempt)
        checked = [_check(d, self.state["agents"]) for d in drafts]
        scratch = copy.deepcopy(self.state)
        for d in checked:  # reject the whole batch if any event would not apply cleanly
            fold(scratch, [{"after": d["after"], "step": d["step"], "seq": 0, "graph_version": 0}])
        rows = self._write(checked)
        fold(self.state, [{"after": r.after, "step": r.step, "seq": r.seq, "graph_version": r.graph_version} for r in rows])
        return rows

    def snapshot(self, case: Case, reason: str, by: str, note: str = "") -> GraphSnapshot:
        return create_snapshot(self.db, case, reason, by, note=note, simulation_id=self.sim.id, sim_override=copy.deepcopy(self.state))


def record_trigger(db: Session, sim: Simulation, events: list[SimEvent]) -> list[GraphEvent]:
    """Graph events for actions an analyst triggered inside a finished run (appended after the run's own events)."""
    series = (sim.stats or {}).get("series") or {}
    stances = {aid: s[-1] for aid, s in series.items() if s}
    rec = Recorder(db, sim, attempt=latest_attempt(db, sim.id), resume=True)
    return rec.record(sorted(events, key=lambda e: e.round), stances)


def new_recorder(db: Session, sim: Simulation) -> Recorder:
    """Recorder for a run that is starting (or restarting: a retry opens a new attempt and leaves old events as history)."""
    return Recorder(db, sim)


def timeline_ts(x) -> datetime:
    return x.ts if isinstance(x, GraphEvent) else x.created_at
