import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from neo4j.exceptions import ServiceUnavailable, SessionExpired

from app.api import admin, auth, cases, documents, dynamic, graph, jobs, workflow
from app.core.config import settings
from app.core.db import Base, engine
from app.services import embeddings, llm
from app.services import health as service_health
from app.services.extraction import get_extractor
from app.services.ontology import ENTITY_TYPES, RELATION_TYPES

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title=f"{settings.app_name} API", version="0.1.0",
              description="Case intelligence: graph build, environments, simulation, reports and interaction — local models only.")
Base.metadata.create_all(engine)  # adds new tables; schema changes still need a migration
with engine.begin() as _c:  # no Alembic yet: additive column changes are applied here
    _c.exec_driver_sql("ALTER TABLE sim_events ADD COLUMN IF NOT EXISTS why TEXT NOT NULL DEFAULT ''")
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

for r in (auth.router, cases.router, documents.router, jobs.router, graph.router, workflow.router, admin.router,
          admin.public, dynamic.router):
    app.include_router(r, prefix=settings.api_prefix)


@app.exception_handler(ServiceUnavailable)
@app.exception_handler(SessionExpired)
def graph_unavailable(_request: Request, _exc: Exception) -> JSONResponse:
    """Neo4j down: answer 503 with a message the UI can show, instead of a bare 500."""
    logging.getLogger("app").warning("Graph database unreachable at %s", settings.neo4j_uri)
    return JSONResponse(status_code=503, content={
        "detail": "The graph database is not reachable right now, so graph data cannot be loaded. "
                  "Everything else keeps working; try again once Neo4j is running."})


@app.get(f"{settings.api_prefix}/health")
def health():
    return {"ok": True}


@app.get(f"{settings.api_prefix}/ontology")
def ontology():
    return {"entity_types": ENTITY_TYPES, "relation_types": RELATION_TYPES, "extractor": get_extractor().name}


@app.get(f"{settings.api_prefix}/system/status")
def system_status():
    return {"llm": {"provider": settings.llm_provider, "model": llm.name(), "available": llm.available(),
                    "url": settings.ollama_url},
            "extractor": get_extractor().name, "embedder": embeddings.embedder_name(), # unauthenticated: up/down only; details (hosts, errors) are on the admin settings page
            "services": {k: {"ok": v["ok"]} for k, v in service_health.services().items()}}
