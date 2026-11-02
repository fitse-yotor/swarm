"""Reactions, the layered dynamic graph, snapshots, timeline and graph-event ingestion.

All routes resolve the case through `get_case`, so another tenant's (or another user's private) case reads as not found.
Reads need only access to the case; changes need `graph.review` (reactions, snapshots) or `sim.run` (ingesting events).
"""
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.api.jobs import enqueue
from app.core.db import get_db
from app.core.deps import audit, current_user, get_case, require
from app.models import (
    GraphEvent,
    GraphSnapshot,
    GraphVersion,
    ProcessingJob,
    Reaction,
    ReactionRun,
    Simulation,
    User,
)
from app.services import dynamic_graph as dg
from app.services import reaction_gen

router = APIRouter(tags=["dynamic-graph"])
LABEL = reaction_gen.LABEL


# ---------------------------------------------------------------- schemas
class ReactionOut(BaseModel):
    id: str
    case_id: str
    run_id: str
    actor_id: str
    actor_name: str
    actor_type: str
    title: str
    description: str
    category: str
    trigger: str
    related: list[dict[str, Any]]
    evidence_ids: list[str]
    reasoning: str
    confidence: float
    uncertainty: Literal["low", "medium", "high"]  # how uncertain the hypothesis is (inverse of confidence)
    assumptions: list[dict[str, Any]]
    warnings: list[str]
    provenance: str
    label: str = LABEL
    status: str
    edited: bool
    environment_id: str | None
    generator: dict[str, Any]
    created_at: datetime
    updated_at: datetime


class ReactionPage(BaseModel):
    items: list[ReactionOut]
    total: int
    limit: int
    offset: int
    run: dict[str, Any] | None


class ReactionRunIn(BaseModel):
    version_id: str | None = None
    note: str = Field("", max_length=500)


class ReactionPatch(BaseModel):
    title: str | None = Field(None, min_length=5, max_length=160)
    description: str | None = Field(None, min_length=20, max_length=1200)
    category: Literal["support", "opposition", "concern", "neutrality", "negotiation", "public_communication", "policy_response", "operational_response"] | None = None
    status: Literal["generated", "reviewed", "selected", "excluded"] | None = None


class BulkIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=200)
    status: Literal["reviewed", "selected", "excluded"]


class SnapshotIn(BaseModel):
    note: str = Field("", max_length=500)
    simulation_id: str | None = None


class SnapshotOut(BaseModel):
    id: str
    case_id: str
    parent_id: str | None
    number: int
    reason: str
    note: str
    version_id: str | None
    simulation_id: str | None
    step: int | None
    event_seq: int | None
    reaction_run_id: str | None
    graph_version: int
    created_by: str
    created_at: datetime
    content_hash: str
    integrity: Literal["verified", "mismatch"]
    counts: dict[str, Any]


class GraphEventIn(BaseModel):
    event_type: Literal["STATEMENT_PUBLISHED", "RESPONDED_TO", "REACTED_TO_EVENT", "POSITION_CHANGED", "RELATIONSHIP_FORMED", "RELATIONSHIP_STRENGTHENED",
                        "RELATIONSHIP_WEAKENED", "ALLIANCE_FORMED"]
    step: int = Field(ge=-1, le=10_000)
    actor_ids: list[str] = Field(default_factory=list, max_length=8)
    description: str = Field("", max_length=1000)
    nodes: list[str] = Field(default_factory=list, max_length=20)
    edges: list[str] = Field(default_factory=list, max_length=20)
    before: dict[str, Any] = Field(default_factory=dict)
    after: dict[str, Any]
    trigger_event_id: str | None = None


class GraphEventsIn(BaseModel):
    events: list[GraphEventIn] = Field(min_length=1, max_length=500)


class GraphEventOut(BaseModel):
    id: str
    case_id: str
    run_id: str
    attempt: int
    seq: int
    step: int
    ts: datetime
    event_type: str
    actor_ids: list[str]
    description: str
    nodes: list[str]
    edges: list[str]
    before: dict[str, Any]
    after: dict[str, Any]
    trigger_event_id: str | None
    provenance: str
    graph_version: int


# ---------------------------------------------------------------- helpers
def _uncertainty(c: float) -> str:
    return "low" if c >= 0.7 else "medium" if c >= 0.4 else "high"


def reaction_out(r: Reaction) -> ReactionOut:
    return ReactionOut.model_validate({**{k: getattr(r, k) for k in ReactionOut.model_fields if hasattr(r, k)}, "uncertainty": _uncertainty(r.confidence)})


def run_out(db: Session, r: ReactionRun) -> dict:
    job = db.get(ProcessingJob, r.job_id) if r.job_id else None
    return {"id": r.id, "case_id": r.case_id, "version_id": r.version_id, "number": r.number, "status": r.status, "mode": r.mode, "provider": r.provider,
            "template_version": r.template_version, "stats": r.stats, "note": r.note, "created_by": r.created_by, "created_at": r.created_at, "job_id": r.job_id,
            "job": {"id": job.id, "status": job.status, "stage": job.stage, "progress": job.progress, "error": job.error} if job else None,
            "demo": r.mode == "demo-rules", "label": LABEL}


def _own_reaction(db: Session, user: User, reaction_id: str) -> Reaction:
    r = db.get(Reaction, reaction_id)
    if r is None:
        raise HTTPException(404, "Reaction not found")
    get_case(db, user, r.case_id)
    return r


def _own_snapshot(db: Session, user: User, snapshot_id: str) -> GraphSnapshot:
    s = db.get(GraphSnapshot, snapshot_id)
    if s is None:
        raise HTTPException(404, "Snapshot not found")
    get_case(db, user, s.case_id)
    return s


def snapshot_out(s: GraphSnapshot) -> SnapshotOut:
    g = dg.to_graph(s.state, include_statements=True)
    return SnapshotOut.model_validate({**{k: getattr(s, k) for k in SnapshotOut.model_fields if hasattr(s, k)},
                                       "integrity": "verified" if dg.verify(s) else "mismatch", "counts": g["counts"]})


def _sim(db: Session, user: User, sim_id: str) -> Simulation:
    sim = db.get(Simulation, sim_id)
    if sim is None:
        raise HTTPException(404, "Simulation not found")
    get_case(db, user, sim.case_id)
    return sim


def _layers(layers: str | None) -> set[str]:
    want = {x.strip() for x in (layers or ",".join(dg.LAYERS)).split(",") if x.strip()}
    bad = want - set(dg.LAYERS)
    if bad:
        raise HTTPException(422, f"Unknown layer: {', '.join(sorted(bad))}. Use {', '.join(dg.LAYERS)}")
    return want


def _filtered(graph: dict, layers: set[str]) -> dict:
    nodes = [n for n in graph["nodes"] if n["layer"] in layers]
    ids = {n["id"] for n in nodes}
    return {**graph, "nodes": nodes, "edges": [e for e in graph["edges"] if e["layer"] in layers and e["s"] in ids and e["o"] in ids]}


# ---------------------------------------------------------------- reactions
@router.get("/cases/{case_id}/reaction-runs")
def list_runs(case_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_case(db, user, case_id)
    rows = db.scalars(select(ReactionRun).where(ReactionRun.case_id == case_id).order_by(ReactionRun.number.desc()))
    return [run_out(db, r) for r in rows]


@router.post("/cases/{case_id}/reaction-runs", status_code=202)
def start_run(case_id: str, body: ReactionRunIn, bg: BackgroundTasks, db: Session = Depends(get_db), user: User = Depends(require("graph.review"))):
    """Generate a new set of hypotheses from an approved graph version. Earlier runs are kept."""
    case = get_case(db, user, case_id)
    if body.version_id:
        v = db.get(GraphVersion, body.version_id)
        if v is None or v.case_id != case.id:
            raise HTTPException(404, "That graph version does not exist in this case.")
    else:
        v = dg.version_for(db, case.id)
        if v is None:
            raise HTTPException(409, "This case has no approved graph yet. Reactions are generated only from approved entities and relationships, so "
                                     "open the Review queue, approve the entities and relationships you trust, then press Approve on the graph. "
                                     "Reactions are generated automatically after approval.")
    if v.status != "approved":
        raise HTTPException(409, f"{v.label} is not approved. Approve the graph first; reactions are generated only from approved entities and relationships.")
    busy = db.scalar(select(ReactionRun).where(ReactionRun.case_id == case.id, ReactionRun.status == "generating"))
    if busy is not None:
        raise HTTPException(409, f"Reaction run {busy.number} is still generating")
    run, job = reaction_gen.start_run(db, case, v, user.name, user.tenant_id, body.note)
    audit(db, user, "reaction.run", f"{case.title}: run {run.number} on {v.label}", case.id)
    db.commit()
    enqueue(job.id, bg)
    return run_out(db, run)


@router.get("/reaction-runs/{run_id}")
def read_run(run_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    run = db.get(ReactionRun, run_id)
    if run is None:
        raise HTTPException(404, "Reaction run not found")
    get_case(db, user, run.case_id)
    return run_out(db, run)


@router.get("/cases/{case_id}/reactions", response_model=ReactionPage)
def list_reactions(case_id: str, run_id: str | None = None, actor_id: str | None = None, actor_type: str | None = None, category: str | None = None,
                   status: str | None = None, min_confidence: float | None = Query(None, ge=0, le=1), q: str | None = None,
                   limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_case(db, user, case_id)
    run = db.get(ReactionRun, run_id) if run_id else db.scalar(
        select(ReactionRun).where(ReactionRun.case_id == case_id, ReactionRun.status == "ready").order_by(ReactionRun.number.desc()))
    if run is not None and run.case_id != case_id:
        raise HTTPException(404, "Reaction run not found")
    if run is None:
        return ReactionPage(items=[], total=0, limit=limit, offset=offset, run=None)
    stmt = select(Reaction).where(Reaction.run_id == run.id)
    for col, val in ((Reaction.actor_id, actor_id), (Reaction.actor_type, actor_type), (Reaction.category, category), (Reaction.status, status)):
        if val:
            stmt = stmt.where(col == val)
    if min_confidence is not None:
        stmt = stmt.where(Reaction.confidence >= min_confidence)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(Reaction.title).like(like), func.lower(Reaction.actor_name).like(like), func.lower(Reaction.description).like(like)))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(Reaction.actor_name, Reaction.confidence.desc(), Reaction.id).limit(limit).offset(offset))
    return ReactionPage(items=[reaction_out(r) for r in rows], total=total or 0, limit=limit, offset=offset, run=run_out(db, run))


@router.get("/reactions/{reaction_id}")
def read_reaction(reaction_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """One reaction with the evidence passages and graph context it relied on."""
    r = _own_reaction(db, user, reaction_id)
    ev = reaction_gen.load_evidence(db, r.case_id, set(r.evidence_ids))
    run = db.get(ReactionRun, r.run_id)
    return {"reaction": reaction_out(r), "evidence": [ev[i] for i in r.evidence_ids if i in ev], "run": run_out(db, run) if run else None,
            "actor": {"id": r.actor_id, "name": r.actor_name, "type": r.actor_type}, "basis": {
                "evidence_supported": [a for a in r.assumptions if a.get("basis") == "evidence_supported"],
                "model_inferred": [a for a in r.assumptions if a.get("basis") == "model_inferred"],
                "synthetic": [a for a in r.assumptions if a.get("basis") == "synthetic"]}}


@router.patch("/reactions/{reaction_id}", response_model=ReactionOut)
def edit_reaction(reaction_id: str, body: ReactionPatch, db: Session = Depends(get_db), user: User = Depends(require("graph.review"))):
    r = _own_reaction(db, user, reaction_id)
    changes = body.model_dump(exclude_none=True)
    content = {k: v for k, v in changes.items() if k in ("title", "description", "category")}
    for k, v in changes.items():
        if getattr(r, k) != v:
            setattr(r, k, v)
    if content:
        r.edited = True
        if r.status == "generated":
            r.status = "reviewed"
    audit(db, user, "reaction.edit", r.title, r.case_id, reaction=r.id, fields=sorted(changes))
    db.commit()
    return reaction_out(r)


@router.post("/cases/{case_id}/reactions/bulk")
def bulk_status(case_id: str, body: BulkIn, db: Session = Depends(get_db), user: User = Depends(require("graph.review"))):
    get_case(db, user, case_id)
    rows = list(db.scalars(select(Reaction).where(Reaction.case_id == case_id, Reaction.id.in_(body.ids))))
    missing = set(body.ids) - {r.id for r in rows}
    if missing:
        raise HTTPException(404, f"Reactions not found in this case: {', '.join(sorted(missing)[:5])}")
    for r in rows:
        r.status = body.status
    audit(db, user, "reaction.status", f"{len(rows)} reaction(s) → {body.status}", case_id, ids=body.ids[:20])
    db.commit()
    return {"updated": len(rows), "status": body.status}


# ---------------------------------------------------------------- the layered graph
@router.get("/cases/{case_id}/dynamic-graph")
def dynamic_graph(case_id: str, snapshot_id: str | None = None, simulation_id: str | None = None, upto_seq: int | None = Query(None, ge=0),
                  layers: str | None = None, statements: bool = False, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """The current graph (live projection), or the graph exactly as it was at a snapshot. Layers can be switched off with `layers`."""
    case = get_case(db, user, case_id)
    want = _layers(layers)
    if snapshot_id:
        snap = _own_snapshot(db, user, snapshot_id)
        if snap.case_id != case.id:
            raise HTTPException(404, "Snapshot not found")
        graph = dg.to_graph(snap.state, statements)
        view = {"mode": "snapshot", "snapshot": snapshot_out(snap)}
    else:
        if simulation_id:
            _sim(db, user, simulation_id)
        state = dg.live_state(db, case, simulation_id=simulation_id, upto_seq=upto_seq)
        graph = dg.to_graph(state, statements)
        view = {"mode": "live", "snapshot": None}
    return {**_filtered(graph, want), "view": view, "layers": sorted(want),
            "labels": {"research": "Source-grounded (approved)", "reaction": LABEL, "simulation": "Simulation-generated (synthetic)"}}


@router.get("/cases/{case_id}/graph-entity/{node_id}")
def entity_context(case_id: str, node_id: str, simulation_id: str | None = None, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Reactions and simulation events involving one research entity (for the inspector)."""
    case = get_case(db, user, case_id)
    run = db.scalar(select(ReactionRun).where(ReactionRun.case_id == case.id, ReactionRun.status == "ready").order_by(ReactionRun.number.desc()))
    reactions = list(db.scalars(select(Reaction).where(Reaction.run_id == run.id, Reaction.actor_id == node_id))) if run else []
    sim = _sim(db, user, simulation_id) if simulation_id else dg.latest_sim(db, case.id)
    events: list[GraphEvent] = []
    if sim is not None:
        agent_ids = [a["id"] for a in (sim.config or {}).get("agents", []) if a.get("node_id") == node_id or a["id"] == node_id]
        if agent_ids:
            att = dg.latest_attempt(db, sim.id)
            evs = db.scalars(select(GraphEvent).where(GraphEvent.run_id == sim.id, GraphEvent.attempt == att).order_by(GraphEvent.seq.desc()).limit(400))
            events = [e for e in evs if set(e.actor_ids) & set(agent_ids)][:30]
    return {"reactions": [reaction_out(r) for r in reactions], "events": [GraphEventOut.model_validate(e, from_attributes=True) for e in events]}


# ---------------------------------------------------------------- snapshots
@router.get("/cases/{case_id}/snapshots")
def list_snapshots(case_id: str, simulation_id: str | None = None, limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
                   db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_case(db, user, case_id)
    stmt = select(GraphSnapshot).where(GraphSnapshot.case_id == case_id)
    if simulation_id:
        stmt = stmt.where(GraphSnapshot.simulation_id == simulation_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(GraphSnapshot.number).limit(limit).offset(offset))
    return {"items": [snapshot_out(s) for s in rows], "total": total or 0, "limit": limit, "offset": offset}


@router.post("/cases/{case_id}/snapshots", response_model=SnapshotOut, status_code=201)
def create_snapshot(case_id: str, body: SnapshotIn, db: Session = Depends(get_db), user: User = Depends(require("graph.review"))):
    """An analyst checkpoint of the graph as it is now. Snapshots are append-only and can never be edited."""
    case = get_case(db, user, case_id)
    sim_id = body.simulation_id
    if sim_id:
        _sim(db, user, sim_id)
    snap = dg.create_snapshot(db, case, "manual", user.name, note=body.note, simulation_id=sim_id)
    audit(db, user, "snapshot.create", f"{case.title}: snapshot {snap.number}", case.id, snapshot=snap.id)
    db.commit()
    return snapshot_out(snap)


@router.get("/snapshots/{snapshot_id}", response_model=SnapshotOut)
def read_snapshot(snapshot_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return snapshot_out(_own_snapshot(db, user, snapshot_id))


@router.get("/cases/{case_id}/snapshots/compare")
def compare(case_id: str, a: str, b: str = "live", simulation_id: str | None = None, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Added, removed and changed nodes and edges from snapshot `a` to snapshot `b` (or `live`), per layer."""
    case = get_case(db, user, case_id)

    def state(ref: str) -> tuple[dict, dict]:
        if ref == "live":
            if simulation_id:
                _sim(db, user, simulation_id)
            return dg.live_state(db, case, simulation_id=simulation_id), {"id": "live", "label": "Current graph"}
        s = _own_snapshot(db, user, ref)
        if s.case_id != case.id:
            raise HTTPException(404, "Snapshot not found")
        return s.state, {"id": s.id, "label": f"Snapshot {s.number} · {s.reason.replace('_', ' ')}", "number": s.number, "created_at": s.created_at}

    sa, ma = state(a)
    sb, mb = state(b)
    return {"a": ma, "b": mb, **dg.diff(sa, sb)}


# ---------------------------------------------------------------- timeline and graph events
@router.get("/cases/{case_id}/timeline")
def timeline(case_id: str, simulation_id: str | None = None, agent_id: str | None = None, event_type: str | None = None,
             limit: int = Query(200, ge=1, le=1000), offset: int = Query(0, ge=0), db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Snapshots and graph events in time order, plus a per-step summary for a slider. Filter by run, agent or event type."""
    case = get_case(db, user, case_id)
    sim = _sim(db, user, simulation_id) if simulation_id else dg.latest_sim(db, case.id)
    ev_stmt = select(GraphEvent).where(GraphEvent.case_id == case.id)
    snap_stmt = select(GraphSnapshot).where(GraphSnapshot.case_id == case.id)
    if sim is not None:
        att = dg.latest_attempt(db, sim.id)
        ev_stmt = ev_stmt.where(GraphEvent.run_id == sim.id, GraphEvent.attempt == att)
        snap_stmt = snap_stmt.where(or_(GraphSnapshot.simulation_id == sim.id, GraphSnapshot.simulation_id.is_(None)))
    else:
        ev_stmt = ev_stmt.where(GraphEvent.id == "none")
    if event_type:
        if event_type not in dg.EVENT_TYPES:
            raise HTTPException(422, f"event_type must be one of {', '.join(dg.EVENT_TYPES)}")
        ev_stmt = ev_stmt.where(GraphEvent.event_type == event_type)
    events = list(db.scalars(ev_stmt.order_by(GraphEvent.seq)))
    if agent_id:
        events = [e for e in events if agent_id in e.actor_ids]
    snaps = list(db.scalars(snap_stmt.order_by(GraphSnapshot.number)))
    steps: dict[int, dict] = {}
    for e in events:
        s = steps.setdefault(e.step, {"step": e.step, "events": 0, "types": {}, "snapshot_ids": []})
        s["events"] += 1
        s["types"][e.event_type] = s["types"].get(e.event_type, 0) + 1
    for sn in snaps:
        if sn.step is not None:
            steps.setdefault(sn.step, {"step": sn.step, "events": 0, "types": {}, "snapshot_ids": []})["snapshot_ids"].append(sn.id)
    items = sorted([{"kind": "snapshot", "ts": s.created_at, "step": s.step, "snapshot": snapshot_out(s)} for s in snaps] +
                   [{"kind": "event", "ts": e.ts, "step": e.step, "event": GraphEventOut.model_validate(e, from_attributes=True)} for e in events],
                   key=lambda x: (x["ts"], x["kind"] != "snapshot"))
    return {"items": items[offset:offset + limit], "total": len(items), "limit": limit, "offset": offset, "steps": [steps[k] for k in sorted(steps)],
            "simulation": {"id": sim.id, "name": sim.name, "attempt": dg.latest_attempt(db, sim.id)} if sim else None,
            "event_types": list(dg.EVENT_TYPES),
            "agents": [{"id": a["id"], "name": a["name"]} for a in (sim.config or {}).get("agents", [])] if sim else []}


@router.get("/simulations/{sim_id}/graph-events")
def list_events(sim_id: str, event_type: str | None = None, limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
                db: Session = Depends(get_db), user: User = Depends(current_user)):
    sim = _sim(db, user, sim_id)
    stmt = select(GraphEvent).where(GraphEvent.run_id == sim.id, GraphEvent.attempt == dg.latest_attempt(db, sim.id))
    if event_type:
        stmt = stmt.where(GraphEvent.event_type == event_type)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(GraphEvent.seq).limit(limit).offset(offset))
    return {"items": [GraphEventOut.model_validate(e, from_attributes=True) for e in rows], "total": total or 0, "limit": limit, "offset": offset}


@router.post("/simulations/{sim_id}/graph-events", status_code=201)
def ingest_events(sim_id: str, body: GraphEventsIn, db: Session = Depends(get_db), user: User = Depends(require("sim.run"))):
    """Append graph-change events from a simulation engine. They are stamped `simulation_generated`, validated against the run's
    agents, and applied all-or-nothing. They can only change the simulation layer: research facts have no write path here."""
    sim = _sim(db, user, sim_id)
    rec = dg.Recorder(db, sim, attempt=dg.latest_attempt(db, sim.id), resume=True)
    try:
        rows = rec.ingest_external([e.model_dump() for e in body.events])
    except dg.EventError as e:
        raise HTTPException(422, str(e)) from None
    audit(db, user, "graph.events.ingest", f"{sim.name}: {len(rows)} event(s)", sim.case_id, simulation=sim.id)
    db.commit()
    return {"ingested": len(rows), "graph_version": rows[-1].graph_version, "events": [GraphEventOut.model_validate(e, from_attributes=True) for e in rows]}


@router.get("/graph-events/{event_id}")
def read_event(event_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """One event with its explanation, the simulation action that triggered it, and the events around it."""
    e = db.get(GraphEvent, event_id)
    if e is None:
        raise HTTPException(404, "Graph event not found")
    get_case(db, user, e.case_id)
    from app.models import SimEvent
    trig = db.get(SimEvent, e.trigger_event_id) if e.trigger_event_id else None
    near = db.scalars(select(GraphEvent).where(GraphEvent.run_id == e.run_id, GraphEvent.attempt == e.attempt, GraphEvent.trigger_event_id == e.trigger_event_id)
                      .order_by(GraphEvent.seq)) if e.trigger_event_id else []
    return {"event": GraphEventOut.model_validate(e, from_attributes=True), "label": "Simulation-generated: a synthetic agent action, not a real-world event",
            "trigger": {"id": trig.id, "agent": trig.agent_name, "action": trig.action, "round": trig.round, "platform": trig.platform, "content": trig.content,
                        "generated_by": trig.generated_by} if trig else None,
            "related_events": [GraphEventOut.model_validate(x, from_attributes=True) for x in near if x.id != e.id]}
