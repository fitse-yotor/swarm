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


@lru_cache
def _fastembed():
    from fastembed import TextEmbedding
    return TextEmbedding(model_name=settings.embedding_model)


def embed(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    if settings.embedding_provider == "fastembed":
        return [list(map(float, v)) for v in _fastembed().embed(texts)]
    return [_hash_embed(t, settings.embedding_dim) for t in texts]


def embedder_name() -> str:
    return settings.embedding_model if settings.embedding_provider == "fastembed" else "hash-bow"
