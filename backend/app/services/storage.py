"""Immutable original-file storage, content-addressed by SHA-256.

Local filesystem for now; the interface is what an S3/MinIO adapter would implement.
"""
import hashlib
from pathlib import Path

from app.core.config import settings

KINDS = {".pdf": ("PDF", "application/pdf"), ".md": ("Markdown", "text/markdown"),
         ".markdown": ("Markdown", "text/markdown"), ".txt": ("TXT", "text/plain")}


class UploadRejected(ValueError):
    pass


def sniff(filename: str, data: bytes) -> tuple[str, str]:
    """Validate extension against content, returning (kind, media_type)."""
    ext = Path(filename).suffix.lower()
    if ext not in KINDS:
        raise UploadRejected("Unsupported type — PDF, Markdown or TXT only")
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise UploadRejected(f"Larger than {settings.max_upload_mb} MB")
    if not data:
        raise UploadRejected("File is empty")
    kind, media = KINDS[ext]
    if kind == "PDF":
        if not data.lstrip()[:5].startswith(b"%PDF-"):
            raise UploadRejected("Content is not a PDF")
    else:
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            raise UploadRejected("Text file is not valid UTF-8") from None
        if b"\x00" in data:
            raise UploadRejected("Text file contains binary content")
    return kind, media


def checksum(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def store(tenant_id: str, case_id: str, digest: str, ext: str, data: bytes) -> str:
    path = settings.storage_dir / tenant_id / case_id / f"{digest}{ext}"
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_bytes(data)
        path.chmod(0o444)
    return str(path)


def read(storage_path: str) -> bytes:
    return Path(storage_path).read_bytes()
