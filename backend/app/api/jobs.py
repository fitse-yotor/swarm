from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db
from app.core.deps import audit, current_user, get_case, has_perm, require
from app.models import ProcessingJob, User, utcnow
from app.schemas import BuildIn, JobOut
from app.services.jobrunner import JOB_STAGES, run_job

JOB_PERM = {"graph_build": "doc.upload", "environment": "env.edit", "simulation": "sim.run", "report": "report.edit"}

router = APIRouter(tags=["jobs"])


def job_out(j: ProcessingJob) -> JobOut:
    return JobOut.model_validate({**{k: getattr(j, k) for k in JobOut.model_fields if hasattr(j, k)}, "stages": JOB_STAGES.get(j.kind, [])})


def enqueue(job_id: str, bg: BackgroundTasks) -> None:
    if settings.celery_eager:
        bg.add_task(run_job, job_id)  # in-process for local development without a worker
    else:
        from app.workers.tasks import run_job_task
        run_job_task.delay(job_id)


@router.post("/cases/{case_id}/graph/build", response_model=JobOut, status_code=202)
def start_build(case_id: str, bg: BackgroundTasks, body: BuildIn | None = None, db: Session = Depends(get_db),
                user: User = Depends(require("doc.upload"))):
    case = get_case(db, user, case_id)
    running = db.scalar(select(ProcessingJob).where(ProcessingJob.case_id == case_id, ProcessingJob.kind == "graph_build",
                                                    ProcessingJob.status.in_(["queued", "running"])))
    if running:
        return job_out(running)  # idempotent: one build per case at a time
    job = ProcessingJob(tenant_id=user.tenant_id, case_id=case_id, kind="graph_build", created_by=user.name,
                        stats={"reextract": bool(body and body.reextract)})
    db.add(job)
    case.status = "Review" if case.status == "Draft" else case.status
    db.flush()
    audit(db, user, "graph.build.start", case.title, case_id, job_id=job.id)
    db.commit()
    enqueue(job.id, bg)
    return job_out(job)


def _job(db: Session, user: User, job_id: str, act: bool = False) -> ProcessingJob:
    j = db.get(ProcessingJob, job_id)
    if not j or j.tenant_id != user.tenant_id:
        raise HTTPException(404, "Job not found")
    get_case(db, user, j.case_id)
    if act and not has_perm(user, JOB_PERM.get(j.kind, "admin.access")):
        raise HTTPException(403, f"Your role does not include {JOB_PERM.get(j.kind)}")
    return j


@router.get("/jobs/{job_id}", response_model=JobOut)
def read_job(job_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return job_out(_job(db, user, job_id))


@router.get("/cases/{case_id}/jobs", response_model=list[JobOut])
def case_jobs(case_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_case(db, user, case_id)
    return [job_out(j) for j in db.scalars(select(ProcessingJob).where(ProcessingJob.case_id == case_id)
                                           .order_by(ProcessingJob.created_at.desc()).limit(20))]


@router.post("/jobs/{job_id}/cancel", response_model=JobOut)
def cancel_job(job_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    j = _job(db, user, job_id, act=True)
    if j.status in ("queued", "running"):
        j.status, j.finished_at = "cancelled", utcnow()
        audit(db, user, f"{j.kind}.cancel", job_id, j.case_id)
        db.commit()
    return job_out(j)


@router.post("/jobs/{job_id}/retry", response_model=JobOut)
def retry_job(job_id: str, bg: BackgroundTasks, db: Session = Depends(get_db), user: User = Depends(current_user)):
    j = _job(db, user, job_id, act=True)
    if j.status not in ("failed", "cancelled"):
        raise HTTPException(409, "Only failed or cancelled jobs can be retried")
    j.status, j.finished_at, j.error = "queued", None, None
    db.commit()
    enqueue(j.id, bg)
    return job_out(j)
