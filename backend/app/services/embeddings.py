"""Text embeddings for pgvector retrieval.

fastembed runs a small ONNX model locally (no data leaves the deployment). The hash
embedder is a deterministic bag-of-words fallback for tests and offline development.
"""
import hashlib
import math
import re
from functools import lru_cache

from app.core.config import settings


def _hash_embed(text: str, dim: int) -> list[float]:
    v = [0.0] * dim
    for tok in re.findall(r"[a-z0-9]+", text.lower()):
        h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
        v[h % dim] += 1.0 if (h >> 8) & 1 else -1.0
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


class EmbeddingUnavailable(RuntimeError):
    """The embedding model could not be loaded or run. The message says what to do about it."""


_state: dict = {"loaded": False, "error": None}


@lru_cache
def _fastembed():
    from fastembed import TextEmbedding
    return TextEmbedding(model_name=settings.embedding_model)


def embed(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    if settings.embedding_provider == "fastembed":
        try:
            out = [list(map(float, v)) for v in _fastembed().embed(texts)]
        except Exception as e:
            _state.update(loaded=False, error=f"{type(e).__name__}: {str(e)[:200]}")
            raise EmbeddingUnavailable(
                f"The embedding model {settings.embedding_model} could not be loaded ({type(e).__name__}). It is downloaded once, on first use, so "
                "this machine needs internet access for that first run. To work offline, set EMBEDDING_PROVIDER=hash in backend/.env and restart "
                "the API (search quality is lower), or fix the network and try again.") from e
        _state.update(loaded=True, error=None)
        return out
    return [_hash_embed(t, settings.embedding_dim) for t in texts]


def status() -> dict:
    """What is known about the embedder without loading it: the last load error, if any."""
    if settings.embedding_provider != "fastembed":
        return {"ok": True, "detail": "hash embedder (offline development mode)"}
    if _state["error"]:
        return {"ok": False, "detail": f"{settings.embedding_model} failed to load: {_state['error']}"}
    return {"ok": True, "detail": f"{settings.embedding_model} " + ("loaded" if _state["loaded"] else "will download on first use")}


def embedder_name() -> str:
    return settings.embedding_model if settings.embedding_provider == "fastembed" else "hash-bow"
