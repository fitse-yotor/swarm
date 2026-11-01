"""Background jobs for every stage: one ProcessingJob row carries status, stage, progress and logs.

Graph builds keep their own pipeline (services/pipeline.py); environment preparation,
simulations and reports run through `run_job`, which handles cancel / failure uniformly
and marks the job's target row (job.stats["target_id"]) failed or cancelled.
"""
import logging
from collections.abc import Callable
from datetime import datetime

from sqlalchemy.orm import Session

from app.core.db import SessionLocal
from app.models import Environment, ProcessingJob, Report, Simulation, utcnow
from app.services.pipeline import STAGES as GRAPH_STAGES

log = logging.getLogger(__name__)

JOB_STAGES: dict[str, list[str]] = {
    "graph_build": GRAPH_STAGES,
    "environment": ["Read graph version", "Select agent entities", "Generate agent profiles", "Build social network",
                    "Generate simulation config", "Environment ready"],
    "simulation": ["Initialize agents", "Run simulation rounds", "Compute metrics", "Simulation complete"],
    "report": ["Collect simulation results", "Compute findings", "Retrieve graph evidence", "Write report sections",
               "Report ready"],
}
TARGETS = {"environment": Environment, "simulation": Simulation, "report": Report}


class Cancelled(Exception):
    pass


class JobCtx:
    def __init__(self, db: Session, job: ProcessingJob):
        self.db, self.job = db, job
        self.stages = JOB_STAGES[job.kind]

    def log(self, msg: str, kind: str = "") -> None:
        self.job.logs = [*self.job.logs, {"t": datetime.now().strftime("%H:%M:%S"), "m": msg, "k": kind}]

    def stat(self, **kw) -> None:
        self.job.stats = {**self.job.stats, **kw}

    def stage(self, i: int) -> None:
        self.job.stage, self.job.progress = i, max(self.job.progress, round(i / len(self.stages) * 100))
        self.check_cancel()

    def progress(self, pct: float) -> None:
        self.job.progress = max(self.job.progress, min(99, round(pct)))

    def check_cancel(self) -> None:
        self.db.commit()
        self.db.refresh(self.job, ["status"])
        if self.job.status == "cancelled":
            raise Cancelled()


def _runner(kind: str) -> Callable[[JobCtx], None]:
    from app.services import environment, reporting, simulation
    return {"environment": environment.prepare, "simulation": simulation.run, "report": reporting.generate}[kind]


def run_job(job_id: str) -> None:
    db = SessionLocal()
    try:
        job = db.get(ProcessingJob, job_id)
        if not job or job.status in ("done", "cancelled"):
            return
        if job.kind == "graph_build":
            db.close()
            from app.services.pipeline import run_graph_build
            return run_graph_build(job_id)
        ctx = JobCtx(db, job)
        ctx.log(f"{'Retry' if job.logs else 'Job'} started: {job.kind}")
        job.status, job.error = "running", None
        db.commit()
        _runner(job.kind)(ctx)
        job.status, job.progress, job.stage, job.finished_at = "done", 100, len(ctx.stages) - 1, utcnow()
        db.commit()
    except Exception as e:
        cancelled = isinstance(e, Cancelled)
        if not cancelled:
            log.exception("job %s failed", job_id)
        db.rollback()
        job = db.get(ProcessingJob, job_id)
        msg = "Cancelled by user" if cancelled else f"Failed: {e}"
        job.logs = [*job.logs, {"t": datetime.now().strftime("%H:%M:%S"), "m": msg, "k": "e"}]
        job.finished_at = utcnow()
        if not cancelled:
            job.status, job.error = "failed", f"{type(e).__name__}: {e}"
        target = TARGETS.get(job.kind)
        row = db.get(target, job.stats.get("target_id")) if target else None
        if row is not None:
            row.status = "cancelled" if cancelled and job.kind == "simulation" else "failed"
        db.commit()
    finally:
        db.close()
