"""Reachability of the services the app depends on, for the status endpoint and the admin System panel.

Each probe is short (about 2 s at most) and the combined result is cached for 15 s, so pages that poll
the status do not hammer the databases.
"""
import time
from functools import lru_cache

from neo4j import GraphDatabase
from sqlalchemy import text

from app.core.config import settings
from app.core.db import engine
from app.services import llm

_cache: dict = {"at": 0.0, "value": None}
TTL = 15


@lru_cache
def _probe_driver():
    return GraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password),
                                connection_timeout=2, max_connection_lifetime=60)


def _check(fn) -> dict:
    t = time.monotonic()
    try:
        detail = fn() or ""
        return {"ok": True, "detail": detail, "ms": round((time.monotonic() - t) * 1000)}
    except Exception as e:  # noqa: BLE001 — any failure means "not reachable"; the message helps the admin
        return {"ok": False, "detail": f"{type(e).__name__}: {str(e)[:160]}", "ms": round((time.monotonic() - t) * 1000)}


def _postgres() -> str:
    with engine.connect() as c:
        c.execute(text("SELECT 1"))
    return "connected"


def _neo4j() -> str:
    _probe_driver().verify_connectivity()
    return "connected"


def _queue() -> str:
    if settings.celery_eager:
        return "jobs run inside the API process (CELERY_EAGER)"
    import redis

    redis.Redis.from_url(settings.redis_url, socket_connect_timeout=1, socket_timeout=1).ping()
    from app.workers.celery_app import celery

    workers = celery.control.inspect(timeout=1).ping() or {}
    if not workers:
        raise RuntimeError("Redis is reachable but no worker answered; start the Celery worker")
    return f"{len(workers)} worker(s) online"


def _embeddings() -> str:
    from app.services import embeddings

    st = embeddings.status()
    if not st["ok"]:
        raise RuntimeError(st["detail"])
    return st["detail"]


def _llm() -> str:
    if settings.llm_provider == "none":
        return "disabled"
    if not llm.available():
        raise RuntimeError(f"{llm.name()} is not reachable at {settings.ollama_url}; features use labelled fallbacks")
    return llm.name()


def services(force: bool = False) -> dict:
    if not force and _cache["value"] is not None and time.monotonic() - _cache["at"] < TTL:
        return _cache["value"]
    value = {"database": _check(_postgres), "graph": _check(_neo4j), "jobs": _check(_queue), "embeddings": _check(_embeddings), "llm": _check(_llm)}
    value["llm"]["optional"] = True  # everything degrades to templates without it
    _cache.update(at=time.monotonic(), value=value)
    return value
