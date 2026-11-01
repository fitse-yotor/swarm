from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import audit, current_user, get_case, require
from app.models import DocumentChunk, Evidence, SourceDocument, User
from app.schemas import ChunkOut, DocumentOut, PasteIn, UploadResult
from app.services import storage

router = APIRouter(tags=["documents"])


def doc_out(db: Session, d: SourceDocument) -> DocumentOut:
    chunks = db.scalar(select(func.count()).select_from(DocumentChunk).where(DocumentChunk.document_id == d.id)) or 0
    claims = db.scalar(select(func.count()).select_from(Evidence).where(Evidence.document_id == d.id)) or 0
    return DocumentOut.model_validate({**{k: getattr(d, k) for k in DocumentOut.model_fields if hasattr(d, k)},
                                       "chunk_count": chunks, "claim_count": claims})


def _ingest(db: Session, user: User, case_id: str, filename: str, data: bytes) -> SourceDocument:
    kind, media = storage.sniff(filename, data)
    digest = storage.checksum(data)
    dup = db.scalar(select(SourceDocument).where(SourceDocument.case_id == case_id, SourceDocument.checksum == digest))
    if dup:
        raise storage.UploadRejected(f"Duplicate of “{dup.filename}” already in this case")
    path = storage.store(user.tenant_id, case_id, digest, Path(filename).suffix.lower(), data)
    d = SourceDocument(case_id=case_id, filename=Path(filename).name, kind=kind, media_type=media, size=len(data),
                       checksum=digest, storage_path=path, uploaded_by=user.name)
    db.add(d)
    db.flush()
    audit(db, user, "doc.upload", d.filename, case_id, checksum=digest)
    return d


@router.post("/cases/{case_id}/documents", response_model=UploadResult, status_code=201)
async def upload(case_id: str, files: list[UploadFile] = File(...), db: Session = Depends(get_db),
                 user: User = Depends(require("doc.upload"))):
    case = get_case(db, user, case_id)
    if case.status == "Archived":
        raise HTTPException(409, "Archived cases cannot take new sources")
    ok, rejected = [], []
    for f in files:
        try:
            ok.append(_ingest(db, user, case_id, f.filename or "upload", await f.read()))
        except storage.UploadRejected as e:
            rejected.append({"filename": f.filename, "error": str(e)})
    db.commit()
    return UploadResult(documents=[doc_out(db, d) for d in ok], rejected=rejected)


@router.post("/cases/{case_id}/documents/text", response_model=DocumentOut, status_code=201)
def paste_text(case_id: str, body: PasteIn, db: Session = Depends(get_db), user: User = Depends(require("doc.upload"))):
    get_case(db, user, case_id)
    name = body.name.strip()
    try:
        d = _ingest(db, user, case_id, name if name.lower().endswith((".txt", ".md")) else f"{name}.txt",
                    body.text.encode("utf-8"))
    except storage.UploadRejected as e:
        raise HTTPException(422, str(e)) from None
    db.commit()
    return doc_out(db, d)


@router.get("/cases/{case_id}/documents", response_model=list[DocumentOut])
def list_documents(case_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_case(db, user, case_id)
    docs = db.scalars(select(SourceDocument).where(SourceDocument.case_id == case_id).order_by(SourceDocument.uploaded_at))
    return [doc_out(db, d) for d in docs]


def _doc(db: Session, user: User, doc_id: str) -> SourceDocument:
    d = db.get(SourceDocument, doc_id)
    if not d:
        raise HTTPException(404, "Document not found")
    get_case(db, user, d.case_id)
    return d


@router.get("/documents/{doc_id}", response_model=DocumentOut)
def read_document(doc_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    return doc_out(db, _doc(db, user, doc_id))


@router.get("/documents/{doc_id}/chunks", response_model=list[ChunkOut])
def document_chunks(doc_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    _doc(db, user, doc_id)
    return list(db.scalars(select(DocumentChunk).where(DocumentChunk.document_id == doc_id).order_by(DocumentChunk.ordinal)))


@router.get("/cases/{case_id}/chunks", response_model=list[ChunkOut])
def case_chunks(case_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Passages analysts can cite when adding or correcting a claim."""
    get_case(db, user, case_id)
    return list(db.scalars(select(DocumentChunk).where(DocumentChunk.case_id == case_id)
                           .order_by(DocumentChunk.document_id, DocumentChunk.ordinal)))


@router.get("/documents/{doc_id}/file")
def download_original(doc_id: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    d = _doc(db, user, doc_id)
    return Response(storage.read(d.storage_path), media_type=d.media_type,
                    headers={"Content-Disposition": f'inline; filename="{d.filename}"'})


@router.delete("/documents/{doc_id}", status_code=204)
def remove_document(doc_id: str, db: Session = Depends(get_db), user: User = Depends(require("doc.upload"))):
    """Removes the source and its chunks. Graph claims keep their evidence ids; versions are not rewritten."""
    d = _doc(db, user, doc_id)
    cited = db.scalar(select(func.count()).select_from(Evidence).where(Evidence.document_id == d.id)) or 0
    if cited:
        raise HTTPException(409, f"{cited} graph claims cite this source. Reject them in a draft before removing it.")
    audit(db, user, "doc.delete", d.filename, d.case_id)
    db.delete(d)
    db.commit()
