from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import audit, current_user, get_case, has_perm, require
from app.models import AuditEvent, Case, GraphVersion, ProcessingJob, SourceDocument, User
from app.schemas import AuditOut, CaseIn, CaseOut, CasePatch
from app.services import graph_store

router = APIRouter(tags=["cases"])


def case_out(db: Session, c: Case) -> CaseOut:
    v = db.get(GraphVersion, c.current_version_id) if c.current_version_id else None
    n = db.scalar(select(func.count()).select_from(SourceDocument).where(SourceDocument.case_id == c.id)) or 0
    return CaseOut.model_validate({**{k: getattr(c, k) for k in CaseOut.model_fields if hasattr(c, k)},
                                   "owner_name": c.owner.name, "document_count": n,
                                   "graph_label": v.label if v else None, "graph_status": v.status if v else None})


def visible_cases(db: Session, user: User):
    q = select(Case).where(Case.tenant_id == user.tenant_id)
    if not has_perm(user, "admin.access"):
        q = q.where(or_(Case.visibility != "Private", Case.owner_id == user.id))
    return q


@router.get("/cases", response_model=list[CaseOut])
def list_cases(status: str | None = None, q: str | None = None, db: Session = Depends(get_db),
               user: User = Depends(current_user)):
    stmt = visible_cases(db, user).order_by(Case.updated_at.desc())
    if status and status != "All":
        stmt = stmt.where(Case.status == status)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(Case.title).like(like), func.lower(Case.description).like(like)))
    return [case_out(db, c) for c in db.scalars(stmt)]


@router.post("/cases", response_model=CaseOut, status_code=201)
def create_case(body: CaseIn, db: Session = Depends(get_db), user: User = Depends(require("case.create"))):
    c = Case(tenant_id=user.tenant_id, owner_id=user.id, title=body.title.strip(), description=body.description.strip(),
             research_question=body.research_question.strip(), objective=body.objective.strip(),
             scope_type=body.scope_type, tags=[t.strip() for t in body.tags if t.strip()], visibility=body.visibility,
             extract_types=list(body.extract_types))
    db.add(c)
    db.flush()
    audit(db, user, "case.create", c.title, c.id)
    db.commit()
    db.refresh(c)
    return case_out(db, c)


@router.get("/cases/{case_id}", response_model=CaseOut)
def read_case(case_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return case_out(db, get_case(db, user, case_id))


@router.patch("/cases/{case_id}", response_model=CaseOut)
def update_case(case_id: str, body: CasePatch, db: Session = Depends(get_db), user: User = Depends(require("case.create"))):
    c = get_case(db, user, case_id)
    if body.revision != c.revision:
        raise HTTPException(409, "This case was changed by someone else — reload to see the latest version")
    changes = body.model_dump(exclude_unset=True, exclude={"revision"})
    for k, v in changes.items():
        setattr(c, k, v)
    c.revision += 1
    audit(db, user, "case.update", c.title, c.id, fields=sorted(changes))
    db.commit()
    db.refresh(c)
    return case_out(db, c)


@router.post("/cases/{case_id}/archive", response_model=CaseOut)
def archive_case(case_id: str, restore: bool = False, db: Session = Depends(get_db),
                 user: User = Depends(require("case.archive"))):
    c = get_case(db, user, case_id)
    c.status = ("Active" if c.current_version_id else "Draft") if restore else "Archived"
    c.revision += 1
    audit(db, user, "case.restore" if restore else "case.archive", c.title, c.id)
    db.commit()
    db.refresh(c)
    return case_out(db, c)


@router.get("/dashboard")
def dashboard(db: Session = Depends(get_db), user: User = Depends(current_user)):
    cases = list(db.scalars(visible_cases(db, user)))
    ids = [c.id for c in cases]
    current = [db.get(GraphVersion, c.current_version_id) for c in cases if c.current_version_id]
    ents = rels = pending = 0
    for v in current:
        ents += v.node_count
        rels += v.edge_count
        if v.status == "draft":
            nodes, edges = graph_store.read_version(v.id)
            pending += sum(x["status"] in ("pending", "conflict") for x in [*nodes, *edges])
    docs = list(db.scalars(select(SourceDocument).where(SourceDocument.case_id.in_(ids)))) if ids else []
    return {
        "total_cases": len(cases), "archived": sum(c.status == "Archived" for c in cases),
        "active_cases": sum(c.status in ("Active", "Review") for c in cases),
        "documents_uploaded": len(docs), "documents_parsed": sum(d.status == "parsed" for d in docs),
        "entities": ents, "relationships": rels, "pending_reviews": pending,
        "approved_versions": db.scalar(select(func.count()).select_from(GraphVersion).where(
            GraphVersion.case_id.in_(ids), GraphVersion.status == "approved")) if ids else 0,
        "running_jobs": db.scalar(select(func.count()).select_from(ProcessingJob).where(
            ProcessingJob.case_id.in_(ids), ProcessingJob.status.in_(["queued", "running"]))) if ids else 0,
    }


@router.get("/audit", response_model=list[AuditOut])
def audit_log(case_id: str | None = None, limit: int = 50, db: Session = Depends(get_db),
              user: User = Depends(current_user)):
    q = select(AuditEvent).where(AuditEvent.tenant_id == user.tenant_id)
    if case_id:
        get_case(db, user, case_id)
        q = q.where(AuditEvent.case_id == case_id)
    elif not has_perm(user, "admin.access"):
        q = q.where(AuditEvent.case_id.in_(select(Case.id).where(visible_cases(db, user).whereclause)))
    return list(db.scalars(q.order_by(AuditEvent.at.desc()).limit(min(limit, 500))))
