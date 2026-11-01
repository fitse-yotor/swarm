from celery import Celery

from app.core.config import settings

celery = Celery("swarm", broker=settings.redis_url, backend=settings.redis_url, include=["app.workers.tasks"])
celery.conf.update(
    task_acks_late=True,  # a crashed worker's build is redelivered; the pipeline is idempotent
    worker_prefetch_multiplier=1,
    task_track_started=True,
    task_always_eager=settings.celery_eager,
)
