"""Local LLM access through Ollama. No hosted model API is used anywhere in the backend.

Structured calls pass a Pydantic JSON schema as Ollama's `format`, so generation is
constrained to that schema and then validated. `available()` is cached for 30 s so
callers can cheaply fall back to template / retrieval-only paths when Ollama is down.
"""
import json
import logging
import time
from collections.abc import Iterator
from typing import TypeVar

import httpx
from pydantic import BaseModel

from app.core.config import settings

log = logging.getLogger(__name__)
T = TypeVar("T", bound=BaseModel)
_probe = {"at": 0.0, "ok": False}


def name() -> str:
    return f"ollama:{settings.ollama_model}"


def available() -> bool:
    if settings.llm_provider != "ollama":
        return False
    if time.monotonic() - _probe["at"] < 30:
        return _probe["ok"]
    want = settings.ollama_model if ":" in settings.ollama_model else f"{settings.ollama_model}:latest"
    try:
        tags = httpx.get(f"{settings.ollama_url}/api/tags", timeout=2).json()
        ok = any(m.get("name") == want for m in tags.get("models", []))
        if not ok:
            log.warning("Ollama is running but model %s is not pulled", want)
    except (httpx.HTTPError, ValueError):
        ok = False
    _probe.update(at=time.monotonic(), ok=ok)
    return ok


def _body(system: str, messages: list[dict], fmt: dict | None, temperature: float, max_tokens: int, stream: bool) -> dict:
    body = {"model": settings.ollama_model, "stream": stream, "think": False,
            "messages": [{"role": "system", "content": system}, *messages],
            "options": {"temperature": temperature, "num_predict": max_tokens, "num_ctx": settings.ollama_num_ctx}}
    if fmt:
        body["format"] = fmt
    return body


def chat(system: str, messages: list[dict], *, temperature: float = 0.3, max_tokens: int = 800) -> str:
    r = httpx.post(f"{settings.ollama_url}/api/chat", json=_body(system, messages, None, temperature, max_tokens, False),
                   timeout=settings.ollama_timeout)
    r.raise_for_status()
    return r.json()["message"]["content"].strip()


def structured(system: str, user: str, schema: type[T], *, temperature: float = 0.0, max_tokens: int = 2048) -> T:
    r = httpx.post(f"{settings.ollama_url}/api/chat",
                   json=_body(system, [{"role": "user", "content": user}], schema.model_json_schema(), temperature,
                              max_tokens, False), timeout=settings.ollama_timeout)
    r.raise_for_status()
    return schema.model_validate_json(r.json()["message"]["content"])


def stream(system: str, messages: list[dict], *, temperature: float = 0.4, max_tokens: int = 700) -> Iterator[str]:
    with httpx.stream("POST", f"{settings.ollama_url}/api/chat",
                      json=_body(system, messages, None, temperature, max_tokens, True),
                      timeout=settings.ollama_timeout) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line:
                continue
            d = json.loads(line)
            if piece := d.get("message", {}).get("content"):
                yield piece
            if d.get("done"):
                return
