from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "M2 Swarm"
    api_prefix: str = "/api/v1"
    cors_origins: list[str] = ["http://localhost:5173"]

    database_url: str = "postgresql+psycopg://swarm:swarm@localhost:5432/swarm"
    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "swarm-neo4j"
    redis_url: str = "redis://localhost:6379/0"
    # Run Celery tasks in-process (tests, or local dev without a worker).
    celery_eager: bool = False

    jwt_secret: str = "change-me-in-production"
    jwt_minutes: int = 60 * 8

    storage_dir: Path = Path("./var/storage")
    max_upload_mb: int = 50

    # Everything runs on local models; no hosted API is called.
    # Extraction: "auto" uses spaCy (fast on CPU), else the regex heuristic. "ollama" sends each
    # chunk to the local LLM: better relations, but minutes per chunk on a CPU-only machine.
    extraction_provider: str = "auto"  # auto | ollama | spacy | heuristic
    spacy_model: str = "en_core_web_sm"
    # Local LLM for GraphRAG answers, agent personas, simulated posts, reports and chat.
    llm_provider: str = "ollama"  # ollama | none
    ollama_url: str = "http://localhost:11434"
    ollama_model: str = "gemma4"
    ollama_agent_model: str = ""  # model for AI-agent turns; empty = ollama_model (a smaller one is faster on CPU)
    ollama_num_ctx: int = 8192
    ollama_timeout: float = 900

    embedding_provider: str = "fastembed"  # fastembed | hash
    embedding_model: str = "BAAI/bge-small-en-v1.5"
    embedding_dim: int = 384

    chunk_target_chars: int = 1200
    chunk_overlap_chars: int = 150


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
