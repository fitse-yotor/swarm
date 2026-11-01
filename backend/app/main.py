import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import admin, auth, cases, documents, graph, jobs, workflow
from app.core.config import settings
from app.core.db import Base, engine
from app.services import embeddings, llm
from app.services.extraction import get_extractor
from app.services.ontology import ENTITY_TYPES, RELATION_TYPES

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title=f"{settings.app_name} API", version="0.1.0",
              description="Case intelligence: graph build, environments, simulation, reports and interaction — local models only.")
Base.metadata.create_all(engine)  # adds new tables; schema changes still need a migration
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

for r in (auth.router, cases.router, documents.router, jobs.router, graph.router, workflow.router, admin.router,
          admin.public):
    app.include_router(r, prefix=settings.api_prefix)


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
            "extractor": get_extractor().name, "embedder": embeddings.embedder_name()}
