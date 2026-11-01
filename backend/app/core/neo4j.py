from functools import lru_cache

from neo4j import Driver, GraphDatabase

from app.core.config import settings


@lru_cache
def get_driver() -> Driver:
    return GraphDatabase.driver(settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password))


SCHEMA = [
    "CREATE INDEX entity_version IF NOT EXISTS FOR (n:Entity) ON (n.version_id, n.id)",
    "CREATE INDEX entity_case IF NOT EXISTS FOR (n:Entity) ON (n.case_id)",
    "CREATE INDEX rel_version IF NOT EXISTS FOR ()-[r:REL]-() ON (r.version_id, r.id)",
]


def ensure_schema() -> None:
    with get_driver().session() as s:
        for stmt in SCHEMA:
            s.run(stmt)
