"""Graph version lifecycle: drafts are editable; approval freezes a hashed, immutable snapshot."""
import hashlib
import json

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Case, GraphVersion, ReviewAction, utcnow
from app.services import graph_store

APPROVED_STATUSES = {"approved", "manual"}
OPEN_STATUSES = {"pending", "conflict"}


def content_hash(nodes: list[dict], edges: list[dict]) -> str:
    body = json.dumps({"nodes": sorted(nodes, key=lambda n: n["id"]), "edges": sorted(edges, key=lambda e: e["id"])},
                      sort_keys=True, default=str)
    return hashlib.sha256(body.encode()).hexdigest()


def next_number(db: Session, case_id: str) -> int:
    return (db.scalar(select(func.max(GraphVersion.number)).where(GraphVersion.case_id == case_id)) or 0) + 1


def create_version(db: Session, case: Case, nodes: list[dict], edges: list[dict], by: str, note: str,
                   parent_id: str | None, extractor: str = "") -> GraphVersion:
    v = GraphVersion(case_id=case.id, number=next_number(db, case.id), status="draft", note=note, parent_id=parent_id,
                     extractor=extractor, created_by=by, node_count=len(nodes), edge_count=len(edges))
    db.add(v)
    db.flush()
    graph_store.write_version(case.id, v.id, nodes, edges)
    case.current_version_id = v.id
    return v


def latest(db: Session, case_id: str) -> GraphVersion | None:
    return db.scalar(select(GraphVersion).where(GraphVersion.case_id == case_id).order_by(GraphVersion.number.desc()))


def latest_approved(db: Session, case_id: str) -> GraphVersion | None:
    return db.scalar(select(GraphVersion).where(GraphVersion.case_id == case_id, GraphVersion.status == "approved")
                     .order_by(GraphVersion.number.desc()))


def get_version(db: Session, case: Case, version_id: str | None) -> GraphVersion:
    vid = version_id or case.current_version_id
    v = db.get(GraphVersion, vid) if vid else latest(db, case.id)
    if not v or v.case_id != case.id:
        raise HTTPException(404, "Graph version not found")
    return v


def require_draft(v: GraphVersion) -> None:
    if v.status != "draft":
        raise HTTPException(409, f"{v.label} is approved and read only — start a new draft to make changes")


def record(db: Session, case_id: str, version_id: str, kind: str, object_id: str, action: str, actor: str) -> None:
    db.add(ReviewAction(case_id=case_id, version_id=version_id, object_kind=kind, object_id=object_id, action=action,
                        actor=actor))


def refresh_counts(v: GraphVersion) -> None:
    nodes, edges = graph_store.read_version(v.id)
    v.node_count, v.edge_count = len(nodes), len(edges)


def approval_preview(v: GraphVersion) -> dict:
    nodes, edges = graph_store.read_version(v.id)
    ok_ids = {n["id"] for n in nodes if n["status"] in APPROVED_STATUSES}
    ok_edges = [e for e in edges if e["status"] in APPROVED_STATUSES and e["evidence_ids"] and e["s"] in ok_ids
                and e["o"] in ok_ids]
    pending = sum(n["status"] in OPEN_STATUSES for n in nodes) + sum(e["status"] in OPEN_STATUSES for e in edges)
    rejected = sum(n["status"] == "rejected" for n in nodes) + sum(e["status"] == "rejected" for e in edges)
    return {"nodes": nodes, "edges": edges, "ok_ids": ok_ids, "ok_edges": ok_edges, "pending": pending,
            "rejected": rejected}


def approve(db: Session, case: Case, v: GraphVersion, by: str) -> tuple[GraphVersion, GraphVersion | None]:
    """Approved version keeps verified/analyst-added entities and evidenced relationships between them.
    Open claims carry forward into a new draft so review can continue without blocking approval."""
    require_draft(v)
    p = approval_preview(v)
    if not p["ok_ids"]:
        raise HTTPException(422, "Approve at least one entity before approving the version")
    keep_nodes = [n for n in p["nodes"] if n["id"] in p["ok_ids"]]
    full_nodes = [n for n in p["nodes"] if n["status"] != "rejected"]
    full_edges = [e for e in p["edges"] if e["status"] != "rejected"]
    graph_store.delete_version(v.id)
    graph_store.write_version(case.id, v.id, keep_nodes, p["ok_edges"])
    v.status, v.approved_by, v.approved_at = "approved", by, utcnow()
    v.content_hash = content_hash(keep_nodes, p["ok_edges"])
    v.node_count, v.edge_count = len(keep_nodes), len(p["ok_edges"])
    record(db, case.id, v.id, "version", v.id, f"Approved {v.label} ({v.node_count} entities, {v.edge_count} relationships)", by)
    draft = None
    if p["pending"]:
        draft = create_version(db, case, full_nodes, full_edges, by, f"Continues {v.label} — pending claims", v.id,
                               v.extractor)
    case.current_version_id = (draft or v).id
    case.stage = max(case.stage, 1)
    if case.status in ("Draft", "Review"):
        case.status = "Active"
    return v, draft


def new_draft(db: Session, case: Case, src: GraphVersion, by: str) -> GraphVersion:
    nodes, edges = graph_store.read_version(src.id)
    return create_version(db, case, nodes, edges, by, f"Draft from {src.label}", src.id, src.extractor)


def diff(a: GraphVersion, b: GraphVersion) -> dict:
    an, ae = graph_store.read_version(a.id)
    bn, be = graph_store.read_version(b.id)
    amap, bmap = {n["id"]: n for n in an}, {n["id"]: n for n in bn}
    key = lambda e: (e["s"], e["type"], e["o"])  # noqa: E731
    akeys, bkeys = {key(e): e for e in ae}, {key(e): e for e in be}
    name = lambda m, i: m.get(i, {}).get("name", i)  # noqa: E731
    fmt = lambda e, m: {"s": name(m, e["s"]), "type": e["type"], "o": name(m, e["o"])}  # noqa: E731
    return {
        "added_nodes": [{"name": n["name"], "type": n["type"]} for n in bn if n["id"] not in amap],
        "removed_nodes": [{"name": n["name"], "type": n["type"]} for n in an if n["id"] not in bmap],
        "changed_nodes": [{"name": n["name"], "type": n["type"], "status": n["status"]} for n in bn
                          if n["id"] in amap and (amap[n["id"]]["status"] != n["status"] or amap[n["id"]]["name"] != n["name"])],
        "added_edges": [fmt(e, bmap) for k, e in bkeys.items() if k not in akeys],
        "removed_edges": [fmt(e, amap) for k, e in akeys.items() if k not in bkeys],
    }
