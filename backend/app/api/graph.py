import csv
import io
import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import audit, current_user, get_case, has_perm, require
from app.models import Case, DocumentChunk, Evidence, GraphVersion, ReviewAction, SourceDocument, User, utcnow
from app.schemas import (BulkStatusIn, EdgeIn, EdgeOut, EdgePatch, EvidenceOut, GraphOut, HistoryOut, MergeIn, NodeIn,
                         NodeOut, NodePatch, QueryIn, VersionOut)
from app.services import analytics, graph_store, graphrag, versions
from app.services.ontology import normalize_rel_type
from app.services.resolution import locate

router = APIRouter(tags=["graph"])

STATUS_WORD = {"approved": "Approved", "rejected": "Rejected — unsupported or incorrect", "pending": "Returned to pending"}


def version_out(v: GraphVersion) -> VersionOut:
    return VersionOut.model_validate({**{k: getattr(v, k) for k in VersionOut.model_fields if k != "label"}, "label": v.label})


def _ctx(db: Session, user: User, case_id: str, version_id: str | None = None) -> tuple[Case, GraphVersion]:
    case = get_case(db, user, case_id)
    return case, versions.get_version(db, case, version_id)


def _touch(db: Session, user: User, case: Case, v: GraphVersion, kind: str, oid: str, what: str, action="graph.edit"):
    versions.record(db, case.id, v.id, kind, oid, what, user.name)
    case.updated_at = utcnow()
    audit(db, user, action, f"{case.title} ({v.label}): {what}", case.id)


@router.get("/cases/{case_id}/graph", response_model=GraphOut)
def read_graph(case_id: str, version_id: str | None = None, db: Session = Depends(get_db),
               user: User = Depends(current_user)):
    case = get_case(db, user, case_id)
    all_v = list(db.scalars(select(GraphVersion).where(GraphVersion.case_id == case_id).order_by(GraphVersion.number)))
    if not all_v:
        raise HTTPException(404, "This case has no graph yet")
    v = versions.get_version(db, case, version_id)
    nodes, edges = graph_store.read_version(v.id)
    of, comms, deg = analytics.communities(nodes, edges)
    docs = dict(db.execute(select(SourceDocument.id, SourceDocument.filename).where(SourceDocument.case_id == case_id)).all())
    return GraphOut(
        version=version_out(v), versions=[version_out(x) for x in all_v],
        nodes=[NodeOut(**n, community=of.get(n["id"]), degree=deg.get(n["id"], 0)) for n in nodes],
        edges=[EdgeOut(**e) for e in edges], communities=comms, community_method=analytics.METHOD, documents=docs,
        editable=v.status == "draft" and has_perm(user, "graph.review"))


@router.get("/cases/{case_id}/evidence", response_model=list[EvidenceOut])
def read_evidence(case_id: str, ids: list[str] = Query(default=[]), db: Session = Depends(get_db),
                  user: User = Depends(current_user)):
    get_case(db, user, case_id)
    if not ids:
        return []
    rows = db.execute(select(Evidence, SourceDocument.filename).join(SourceDocument, SourceDocument.id == Evidence.document_id)
                      .where(Evidence.case_id == case_id, Evidence.id.in_(ids[:200]))).all()
    order = {i: n for n, i in enumerate(ids)}
    out = [EvidenceOut.model_validate({**{k: getattr(e, k) for k in EvidenceOut.model_fields if hasattr(e, k)},
                                       "document": fn}) for e, fn in rows]
    return sorted(out, key=lambda e: order.get(e.id, 0))


@router.get("/cases/{case_id}/graph/versions/{version_id}/history", response_model=list[HistoryOut])
def history(case_id: str, version_id: str, object_id: str | None = None, db: Session = Depends(get_db),
            user: User = Depends(current_user)):
    case, v = _ctx(db, user, case_id, version_id)
    # A version's history includes the lineage of drafts it continues.
    chain, cur = [], v
    while cur and len(chain) < 50:
        chain.append(cur.id)
        cur = db.get(GraphVersion, cur.parent_id) if cur.parent_id else None
    q = select(ReviewAction).where(ReviewAction.case_id == case.id, ReviewAction.version_id.in_(chain))
    if object_id:
        q = q.where(ReviewAction.object_id == object_id)
    return list(db.scalars(q.order_by(ReviewAction.at.desc()).limit(300)))


# ---------- review & edits (draft versions only) ----------
def _draft(db: Session, user: User, case_id: str, version_id: str) -> tuple[Case, GraphVersion]:
    case, v = _ctx(db, user, case_id, version_id)
    versions.require_draft(v)
    return case, v


def _node(v: GraphVersion, node_id: str) -> dict:
    n = graph_store.get_node(v.id, node_id)
    if not n:
        raise HTTPException(404, "Entity not found in this version")
    return n


def _edge(v: GraphVersion, edge_id: str) -> dict:
    e = graph_store.get_edge(v.id, edge_id)
    if not e:
        raise HTTPException(404, "Relationship not found in this version")
    return e


def _cite(db: Session, case: Case, chunk_id: str, quote: str | None, by: str) -> str:
    c = db.get(DocumentChunk, chunk_id)
    if not c or c.case_id != case.id:
        raise HTTPException(422, "Cited passage is not part of this case")
    loc = locate(quote, c.text) if quote else (0, len(c.text))
    if not loc:
        raise HTTPException(422, "The quoted text does not appear in the cited passage")
    a, b = loc
    ev = Evidence(case_id=case.id, document_id=c.document_id, chunk_id=c.id, page=c.page, section=c.section,
                  quote=c.text[a:b], char_start=c.char_start + a, char_end=c.char_start + b, extractor=f"analyst:{by}",
                  confidence=1.0)
    db.add(ev)
    db.flush()
    return ev.id


@router.patch("/cases/{case_id}/graph/versions/{version_id}/nodes/{node_id}", response_model=NodeOut)
def patch_node(case_id: str, version_id: str, node_id: str, body: NodePatch, db: Session = Depends(get_db),
               user: User = Depends(require("graph.review"))):
    case, v = _draft(db, user, case_id, version_id)
    n = _node(v, node_id)
    ch = body.model_dump(exclude_unset=True)
    if "aliases" in ch:
        ch["aliases"] = [a.strip() for a in ch["aliases"] if a.strip()]
    graph_store.update_node(case.id, v.id, node_id, ch)
    notes = []
    if "status" in ch:
        notes.append(STATUS_WORD[ch["status"]])
    if ch.get("name") and ch["name"] != n["name"]:
        notes.append(f"renamed from “{n['name']}”")
    if ch.get("type") and ch["type"] != n["type"]:
        notes.append(f"type {n['type']} → {ch['type']}")
    if {"description", "aliases"} & ch.keys():
        notes.append("details edited")
    _touch(db, user, case, v, "node", node_id, "; ".join(notes) or "Edited",
           "graph.review" if "status" in ch else "graph.edit")
    db.commit()
    return NodeOut(**_node(v, node_id))


@router.post("/cases/{case_id}/graph/versions/{version_id}/nodes", response_model=NodeOut, status_code=201)
def add_node(case_id: str, version_id: str, body: NodeIn, db: Session = Depends(get_db),
             user: User = Depends(require("graph.review"))):
    case, v = _draft(db, user, case_id, version_id)
    nodes, _ = graph_store.read_version(v.id)
    if any(n["name"].casefold() == body.name.strip().casefold() for n in nodes):
        raise HTTPException(409, "An entity with this name exists — merge or edit it instead")
    ev = [_cite(db, case, body.chunk_id, None, user.name)] if body.chunk_id else []
    doc = db.get(DocumentChunk, body.chunk_id).document_id if body.chunk_id else None
    node = {"id": "n_" + uuid.uuid4().hex[:10], "type": body.type, "name": body.name.strip(),
            "description": body.description.strip(), "aliases": [], "status": "manual", "confidence": 1.0,
            "doc_ids": [doc] if doc else [], "evidence_ids": ev, "dup_of": None, "not_dup": False, "attrs": {}}
    graph_store.create_node(case.id, v.id, node)
    _touch(db, user, case, v, "node", node["id"], "Added manually by analyst")
    versions.refresh_counts(v)
    db.commit()
    return NodeOut(**node)


@router.post("/cases/{case_id}/graph/versions/{version_id}/nodes/{node_id}/not-duplicate", response_model=NodeOut)
def not_duplicate(case_id: str, version_id: str, node_id: str, db: Session = Depends(get_db),
                  user: User = Depends(require("graph.review"))):
    case, v = _draft(db, user, case_id, version_id)
    _node(v, node_id)
    graph_store.update_node(case.id, v.id, node_id, {"dup_of": None, "not_dup": True})
    _touch(db, user, case, v, "node", node_id, "Marked as not a duplicate", "graph.review")
    db.commit()
    return NodeOut(**_node(v, node_id))


@router.post("/cases/{case_id}/graph/versions/{version_id}/merge", response_model=NodeOut)
def merge(case_id: str, version_id: str, body: MergeIn, db: Session = Depends(get_db),
          user: User = Depends(require("graph.review"))):
    case, v = _draft(db, user, case_id, version_id)
    keep = _node(v, body.keep_id)
    drops = [_node(v, i) for i in body.drop_ids if i != body.keep_id]
    aliases = list(dict.fromkeys([*keep["aliases"], *[x for d in drops for x in [d["name"], *d["aliases"]]]]))
    changes = {"aliases": [a for a in aliases if a.casefold() != keep["name"].casefold()],
               "doc_ids": list(dict.fromkeys([*keep["doc_ids"], *[x for d in drops for x in d["doc_ids"]]])),
               "evidence_ids": list(dict.fromkeys([*keep["evidence_ids"], *[x for d in drops for x in d["evidence_ids"]]])),
               "confidence": max([keep["confidence"], *[d["confidence"] for d in drops]]), "dup_of": None}
    graph_store.merge_nodes(case.id, v.id, keep["id"], [d["id"] for d in drops], changes)
    for d in drops:
        _touch(db, user, case, v, "node", keep["id"], f"Merged “{d['name']}” into this entity", "graph.merge")
    versions.refresh_counts(v)
    db.commit()
    return NodeOut(**_node(v, keep["id"]))


@router.patch("/cases/{case_id}/graph/versions/{version_id}/edges/{edge_id}", response_model=EdgeOut)
def patch_edge(case_id: str, version_id: str, edge_id: str, body: EdgePatch, db: Session = Depends(get_db),
               user: User = Depends(require("graph.review"))):
    case, v = _draft(db, user, case_id, version_id)
    e = _edge(v, edge_id)
    ch, notes = {}, []
    if body.type is not None:
        try:
            t = normalize_rel_type(body.type)
        except ValueError as err:
            raise HTTPException(422, str(err)) from None
        if t != e["type"]:
            ch["type"] = t
            notes.append(f"{e['type']} → {t}")
    for k in ("confidence", "directed", "valid_from", "valid_to"):
        val = getattr(body, k)
        if k in body.model_fields_set:
            ch[k] = val.strip() or None if isinstance(val, str) else val
    if body.add_chunk_id:
        ch["evidence_ids"] = [*e["evidence_ids"], _cite(db, case, body.add_chunk_id, body.quote, user.name)]
        ch["flag"] = None
        notes.append("citation added")
    if body.status:
        if body.status == "approved" and not (ch.get("evidence_ids") or e["evidence_ids"]):
            raise HTTPException(422, "Add a citation before verifying this relationship")
        ch["status"] = body.status
        notes.insert(0, STATUS_WORD[body.status])
    if ch:
        graph_store.update_edge(v.id, edge_id, ch)
    if body.swap:
        graph_store.swap_edge(case.id, v.id, edge_id)
        notes.append("direction swapped")
    _touch(db, user, case, v, "edge", edge_id, "; ".join(notes) or "Corrected",
           "graph.review" if body.status else "graph.edit")
    db.commit()
    return EdgeOut(**_edge(v, edge_id))


@router.post("/cases/{case_id}/graph/versions/{version_id}/edges", response_model=EdgeOut, status_code=201)
def add_edge(case_id: str, version_id: str, body: EdgeIn, db: Session = Depends(get_db),
             user: User = Depends(require("graph.review"))):
    case, v = _draft(db, user, case_id, version_id)
    if body.s == body.o:
        raise HTTPException(422, "Subject and object must differ")
    _node(v, body.s)
    _node(v, body.o)
    try:
        t = normalize_rel_type(body.type)
    except ValueError as err:
        raise HTTPException(422, str(err)) from None
    ev = [_cite(db, case, body.chunk_id, body.quote, user.name)] if body.chunk_id else []
    edge = {"id": "e_" + uuid.uuid4().hex[:10], "s": body.s, "o": body.o, "type": t, "statement": "", "confidence": 1.0,
            "status": "manual", "flag": None if ev else "unsupported", "directed": True, "epistemic_status": "observed",
            "evidence_ids": ev, "valid_from": None, "valid_to": None}
    graph_store.create_edge(case.id, v.id, edge)
    _touch(db, user, case, v, "edge", edge["id"], "Added manually by analyst")
    versions.refresh_counts(v)
    db.commit()
    return EdgeOut(**edge)


@router.post("/cases/{case_id}/graph/versions/{version_id}/bulk-status")
def bulk_status(case_id: str, version_id: str, body: BulkStatusIn, db: Session = Depends(get_db),
                user: User = Depends(require("graph.review"))):
    case, v = _draft(db, user, case_id, version_id)
    for nid in body.node_ids:
        _node(v, nid)
        graph_store.update_node(case.id, v.id, nid, {"status": body.status})
        versions.record(db, case.id, v.id, "node", nid, STATUS_WORD[body.status], user.name)
    skipped = 0
    for eid in body.edge_ids:
        e = _edge(v, eid)
        if body.status == "approved" and not e["evidence_ids"]:
            skipped += 1
            continue
        graph_store.update_edge(v.id, eid, {"status": body.status})
        versions.record(db, case.id, v.id, "edge", eid, STATUS_WORD[body.status], user.name)
    audit(db, user, "graph.review", f"{case.title} ({v.label}): {body.status} {len(body.node_ids)} entities, "
          f"{len(body.edge_ids) - skipped} relationships", case.id)
    db.commit()
    return {"updated": len(body.node_ids) + len(body.edge_ids) - skipped, "skipped_unsupported": skipped}


# ---------- versions ----------
@router.get("/cases/{case_id}/graph/versions", response_model=list[VersionOut])
def list_versions(case_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_case(db, user, case_id)
    return [version_out(v) for v in db.scalars(select(GraphVersion).where(GraphVersion.case_id == case_id)
                                               .order_by(GraphVersion.number))]


@router.get("/cases/{case_id}/graph/versions/{version_id}/approval-preview")
def approval_preview(case_id: str, version_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    _, v = _draft(db, user, case_id, version_id)
    p = versions.approval_preview(v)
    return {"entities": len(p["ok_ids"]), "relationships": len(p["ok_edges"]), "pending": p["pending"],
            "rejected": p["rejected"]}


@router.post("/cases/{case_id}/graph/versions/{version_id}/approve")
def approve_version(case_id: str, version_id: str, db: Session = Depends(get_db),
                    user: User = Depends(require("graph.approve"))):
    case, v = _ctx(db, user, case_id, version_id)
    approved, draft = versions.approve(db, case, v, user.name)
    audit(db, user, "graph.approve", f"{case.title} — {approved.label}", case.id, content_hash=approved.content_hash)
    db.commit()
    return {"approved": version_out(approved), "draft": version_out(draft) if draft else None}


@router.post("/cases/{case_id}/graph/drafts", response_model=VersionOut, status_code=201)
def create_draft(case_id: str, from_version: str | None = None, db: Session = Depends(get_db),
                 user: User = Depends(require("graph.review"))):
    case, src = _ctx(db, user, case_id, from_version)
    v = versions.new_draft(db, case, src, user.name)
    audit(db, user, "graph.draft", f"{case.title} — {v.label} from {src.label}", case.id)
    db.commit()
    return version_out(v)


@router.get("/cases/{case_id}/graph/compare")
def compare(case_id: str, a: str, b: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    case = get_case(db, user, case_id)
    return versions.diff(versions.get_version(db, case, a), versions.get_version(db, case, b))


@router.get("/cases/{case_id}/graph/versions/{version_id}/export")
def export(case_id: str, version_id: str, format: str = "json", db: Session = Depends(get_db),
           user: User = Depends(current_user)):
    case, v = _ctx(db, user, case_id, version_id)
    nodes, edges = graph_store.read_version(v.id)
    ev_ids = {i for x in [*nodes, *edges] for i in x["evidence_ids"]}
    evs = {e.id: (e, fn) for e, fn in db.execute(select(Evidence, SourceDocument.filename).join(
        SourceDocument, SourceDocument.id == Evidence.document_id).where(Evidence.id.in_(ev_ids))).all()} if ev_ids else {}
    cite = lambda i: {"document": evs[i][1], "page": evs[i][0].page, "quote": evs[i][0].quote,  # noqa: E731
                      "support": evs[i][0].support_type} if i in evs else None
    base = f"{case.title.lower().replace(' ', '-')}-{v.label}"
    audit(db, user, "graph.export", f"{case.title} — {v.label} ({format})", case.id)
    db.commit()
    if format == "csv":
        names = {n["id"]: n["name"] for n in nodes}
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["subject", "relationship", "object", "status", "confidence", "document", "page", "cited_text"])
        for e in edges:
            c = cite(e["evidence_ids"][0]) if e["evidence_ids"] else None
            w.writerow([names.get(e["s"]), e["type"], names.get(e["o"]), e["status"], e["confidence"],
                        c and c["document"], c and c["page"], c and c["quote"]])
        return Response(buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{base}-relationships.csv"'})
    body = {"case": case.title, "version": v.label, "status": v.status, "content_hash": v.content_hash,
            "exported_at": utcnow().isoformat(), "nodes": nodes,
            "edges": [{**e, "evidence": [cite(i) for i in e["evidence_ids"]]} for e in edges]}
    return Response(json.dumps(body, indent=2, default=str), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{base}.json"'})


@router.post("/cases/{case_id}/graphrag/query")
def graphrag_query(case_id: str, body: QueryIn, db: Session = Depends(get_db), user: User = Depends(require("chat.use"))):
    case, v = _ctx(db, user, case_id, body.version_id)
    result = graphrag.answer(db, v, body.question)
    audit(db, user, "graphrag.query", f"{case.title} ({v.label}): {body.question[:120]}", case.id)
    db.commit()
    return result
