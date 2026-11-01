from app.services.jobrunner import run_job
from app.services.pipeline import run_graph_build
from app.workers.celery_app import celery


@celery.task(name="graph.build", max_retries=2, default_retry_delay=10)
def build_graph(job_id: str) -> None:
    run_graph_build(job_id)  # kept for builds queued before job.run existed


@celery.task(name="job.run")
def run_job_task(job_id: str) -> None:
    run_job(job_id)
