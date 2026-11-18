"""Read and edit the deployment's .env files from the Settings page.

Rules that keep this safe:
- only the files listed in FILES can be read or written; nothing is resolved from user input;
- secret values (passwords, tokens, keys, credentials inside URLs) are never sent to the browser;
  the masked value comes back unchanged when the admin does not edit it;
- keys must look like environment variables and values must be one line;
- comments, blank lines and key order in the file are kept, a backup (.env.bak) is written first,
  and the new file replaces the old one atomically;
- changes apply after the API (and worker) restart, because settings are read once at start-up; with Docker the
  containers must be recreated (`docker compose up -d --force-recreate api worker`) so their environment is re-read.
"""
from __future__ import annotations

import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from app.core.config import Settings

KEY_RE = re.compile(r"^[A-Z][A-Z0-9_]{0,99}$")
SECRET_RE = re.compile(r"(SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|PRIVATE_KEY)", re.IGNORECASE)
URL_CRED_RE = re.compile(r"^(?P<scheme>[a-z][a-z0-9+.\-]*://)(?P<user>[^:/@\s]*):(?P<pw>[^@\s]+)@", re.IGNORECASE)
MASK = "••••••••"
MAX_VALUE = 2000

BACKEND_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = BACKEND_DIR.parent

# id -> (label, file, template, description)
FILES: dict[str, tuple[str, Path, Path | None, str]] = {
    "backend": ("Backend · API and worker", BACKEND_DIR / ".env", BACKEND_DIR / ".env.example",
                "Database, graph store, queue, local models, extraction, embeddings and security."),
    "frontend": ("Frontend · Vite", REPO_DIR / "frontend" / ".env", REPO_DIR / "frontend" / ".env.example",
                 "Build-time VITE_* variables for the web app. Needs a rebuild or dev-server restart."),
}

# Settings fields shown even when a file does not set them, grouped for the page.
GROUPS: list[tuple[str, list[str]]] = [
    ("Local models", ["LLM_PROVIDER", "OLLAMA_URL", "OLLAMA_MODEL", "OLLAMA_AGENT_MODEL", "OLLAMA_NUM_CTX", "OLLAMA_TIMEOUT"]),
    ("Extraction and embeddings", ["EXTRACTION_PROVIDER", "SPACY_MODEL", "EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "EMBEDDING_DIM",
                                   "CHUNK_TARGET_CHARS", "CHUNK_OVERLAP_CHARS"]),
    ("Data stores", ["DATABASE_URL", "NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD", "REDIS_URL", "CELERY_EAGER", "STORAGE_DIR", "MAX_UPLOAD_MB"]),
    ("Security and access", ["JWT_SECRET", "JWT_MINUTES", "DEMO_ACCOUNTS", "CORS_ORIGINS"]),
    ("Application", ["APP_NAME", "API_PREFIX"]),
]


@dataclass
class Line:
    raw: str
    key: str | None = None
    value: str | None = None


def parse(text: str) -> list[Line]:
    out: list[Line] = []
    for raw in text.splitlines():
        s = raw.strip()
        if not s or s.startswith("#") or "=" not in s:
            out.append(Line(raw))
            continue
        k, _, v = s.removeprefix("export ").partition("=")
        k, v = k.strip(), v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = v[1:-1]
        out.append(Line(raw, k, v))
    return out


def comments_by_key(lines: list[Line]) -> dict[str, str]:
    """The comment block directly above each key in a template file."""
    notes: dict[str, str] = {}
    block: list[str] = []
    header = True  # the file's opening comment describes the file, not its first key
    for ln in lines:
        s = ln.raw.strip()
        if ln.key:
            if block and not header:
                notes[ln.key] = " ".join(block)
            block, header = [], False
        elif s.startswith("#"):
            block.append(s.lstrip("#").strip())
        else:
            block, header = [], False
    return notes


def is_secret(key: str, value: str = "") -> bool:
    return bool(SECRET_RE.search(key)) or bool(URL_CRED_RE.match(value or ""))


def mask(key: str, value: str) -> str:
    if not value:
        return value
    m = URL_CRED_RE.match(value)
    if m:
        return f"{m['scheme']}{m['user']}:{MASK}@{value[m.end():]}"
    return MASK if SECRET_RE.search(key) else value


def unmask(key: str, new: str, old: str | None) -> str:
    """The browser only ever saw the masked value; if it sends that back, keep what the file holds."""
    if old is not None and new == mask(key, old):
        return old
    if MASK in new:
        raise ValueError(f"{key}: replace the whole masked value, or leave it unchanged")
    return new


def _quote(v: str) -> str:
    return f'"{v}"' if (v != v.strip() or any(c in v for c in " #'\"")) else v


def validate(key: str, value: str | None) -> None:
    if not KEY_RE.match(key):
        raise ValueError(f"{key!r} is not a valid variable name (A–Z, 0–9 and _; starts with a letter)")
    if value is not None and (len(value) > MAX_VALUE or any(c in value for c in "\n\r\x00")):
        raise ValueError(f"{key}: the value must be one line of at most {MAX_VALUE} characters")


def apply(lines: list[Line], changes: dict[str, str | None]) -> tuple[list[Line], list[str]]:
    """Set (str) or remove (None) keys, keeping comments and order. Returns new lines and the keys that changed."""
    current = {ln.key: ln.value for ln in lines if ln.key}
    changed: list[str] = []
    resolved: dict[str, str | None] = {}
    for k, v in changes.items():
        validate(k, v)
        nv = None if v is None else unmask(k, v, current.get(k))
        if nv != current.get(k) and not (nv is None and k not in current):
            resolved[k] = nv
            changed.append(k)
    out: list[Line] = []
    for ln in lines:
        if ln.key in resolved:
            v = resolved.pop(ln.key)
            if v is not None:
                out.append(Line(f"{ln.key}={_quote(v)}", ln.key, v))
            continue
        out.append(ln)
    for k, v in resolved.items():
        if v is not None:
            out.append(Line(f"{k}={_quote(v)}", k, v))
    return out, changed


def render(lines: list[Line]) -> str:
    return "\n".join(ln.raw for ln in lines).rstrip("\n") + "\n"


def defaults() -> dict[str, str]:
    """Built-in defaults from the Settings model, keyed like environment variables."""
    out = {}
    for name, field in Settings.model_fields.items():
        d = field.default
        out[name.upper()] = ",".join(d) if isinstance(d, list) else ("" if d is None else str(d).lower() if isinstance(d, bool) else str(d))
    return out


def describe(file_id: str) -> dict:
    label, path, template, desc = FILES[file_id]
    lines = parse(path.read_text(encoding="utf-8")) if path.exists() else []
    tmpl = parse(template.read_text(encoding="utf-8")) if template and template.exists() else []
    notes = comments_by_key(tmpl)
    set_vals = {ln.key: ln.value or "" for ln in lines if ln.key}
    tmpl_vals = {ln.key: ln.value or "" for ln in tmpl if ln.key}
    defs = defaults() if file_id == "backend" else {}
    keys: list[str] = []
    for k in [*set_vals, *tmpl_vals, *(k for _, ks in GROUPS for k in ks if file_id == "backend")]:
        if k not in keys:
            keys.append(k)
    group_of = {k: g for g, ks in GROUPS for k in ks} if file_id == "backend" else {}
    entries = []
    for k in keys:
        v = set_vals.get(k)
        entries.append({
            "key": k, "set": v is not None, "value": mask(k, v) if v is not None else "",
            "secret": is_secret(k, v or tmpl_vals.get(k, "") or defs.get(k, "")),
            "example": mask(k, tmpl_vals[k]) if k in tmpl_vals else None,
            "default": mask(k, defs[k]) if k in defs else None,
            "note": notes.get(k, ""), "group": group_of.get(k, "Other"),
            # True when the running process sees a different value (not yet restarted, or set by docker-compose `environment:`).
            # Only the flag is returned, never the running value.
            "running_differs": k in os.environ and os.environ[k] != v,
        })
    return {"id": file_id, "label": label, "description": desc, "path": str(path.relative_to(REPO_DIR)),
            "exists": path.exists(), "writable": os.access(path if path.exists() else path.parent, os.W_OK),
            "template": str(template.relative_to(REPO_DIR)) if template and template.exists() else None, "entries": entries}


def write(file_id: str, changes: dict[str, str | None]) -> list[str]:
    _, path, template, _ = FILES[file_id]
    if path.exists():
        original = path.read_text(encoding="utf-8")
    elif template and template.exists():
        original = template.read_text(encoding="utf-8")  # first save starts from the documented template
    else:
        original = ""
    lines, changed = apply(parse(original), changes)
    if not changed:
        return []
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.with_name(path.name + ".bak").write_text(original, encoding="utf-8")
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".env.", text=True)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(render(lines))
    os.chmod(tmp, 0o600)
    try:
        os.replace(tmp, path)
    except OSError:
        # A single bind-mounted file (docker-compose: ./backend/.env:/app/.env) cannot be renamed over: write in place.
        with open(path, "w", encoding="utf-8") as f:
            f.write(render(lines))
        os.unlink(tmp)
    return changed


def available() -> list[str]:
    """Files whose folder exists in this deployment (inside the API container only the backend file is there)."""
    return [f for f, (_, path, _, _) in FILES.items() if path.parent.exists()]
