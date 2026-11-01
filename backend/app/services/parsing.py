"""Turn PDF / Markdown / TXT bytes into normalized text with page- and section-anchored blocks.

PDFs go through Docling (layout-aware, keeps headings and tables). If Docling is not
installed, PDFs fall back to pypdf page text and the parser name records that.
"""
import io
import logging
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)


@dataclass
class Block:
    text: str
    page: int
    section: str
    start: int = 0  # offsets into ParsedDocument.text
    end: int = 0


@dataclass
class ParsedDocument:
    text: str
    blocks: list[Block]
    page_count: int
    parser: str
    warnings: list[str] = field(default_factory=list)


def _assemble(raw: list[Block], page_count: int, parser: str, warnings: list[str] | None = None) -> ParsedDocument:
    parts, blocks, pos = [], [], 0
    for b in raw:
        t = re.sub(r"[ \t]+", " ", b.text).strip()
        if not t:
            continue
        if parts:
            parts.append("\n\n")
            pos += 2
        blocks.append(Block(t, b.page, b.section, pos, pos + len(t)))
        parts.append(t)
        pos += len(t)
    return ParsedDocument("".join(parts), blocks, page_count, parser, warnings or [])


def parse_text(data: bytes, markdown: bool) -> ParsedDocument:
    text = data.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    section, raw = "Body", []
    for chunk in re.split(r"\n\s*\n", text):
        chunk = chunk.strip()
        if not chunk:
            continue
        heading = re.match(r"^(#{1,6})\s+(.+)$", chunk) if markdown else None
        if heading and "\n" not in chunk:
            section = heading.group(2).strip()
            continue
        if markdown:
            lines = chunk.split("\n")
            if re.match(r"^#{1,6}\s+", lines[0]):
                section = re.sub(r"^#{1,6}\s+", "", lines[0]).strip()
                chunk = "\n".join(lines[1:])
        # Short unterminated lines in plain text act as headings, as they do in most notes.
        elif len(chunk) < 60 and "\n" not in chunk and not re.search(r"[.!?:;]$", chunk):
            section = chunk
            continue
        if markdown:  # keep link text, drop URLs, anchors and emphasis markers so they never become "entities"
            chunk = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", chunk)
            chunk = re.sub(r"</?a\b[^>]*>", "", chunk)
            chunk = re.sub(r"(\*\*|__)(.+?)\1", r"\2", chunk)
        raw.append(Block(re.sub(r"\s*\n\s*", " ", chunk), 1, section))
    return _assemble(raw, 1, "markdown" if markdown else "plaintext")


def _parse_pdf_docling(data: bytes) -> ParsedDocument:
    from docling.document_converter import DocumentConverter
    from docling_core.types.doc import SectionHeaderItem, TableItem, TextItem, TitleItem

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=True) as f:
        f.write(data)
        f.flush()
        doc = DocumentConverter().convert(Path(f.name)).document
    section, raw, pages = "Body", [], 1
    for item, _level in doc.iterate_items():
        page = item.prov[0].page_no if getattr(item, "prov", None) else 1
        pages = max(pages, page)
        if isinstance(item, (SectionHeaderItem, TitleItem)):
            section = item.text.strip() or section
        elif isinstance(item, TableItem):
            raw.append(Block(item.export_to_markdown(doc), page, section))
        elif isinstance(item, TextItem):
            raw.append(Block(item.text, page, section))
    return _assemble(raw, max(pages, doc.num_pages() if hasattr(doc, "num_pages") else pages), "docling")


def _parse_pdf_pypdf(data: bytes) -> ParsedDocument:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    raw = []
    for i, page in enumerate(reader.pages, start=1):
        for para in re.split(r"\n\s*\n", page.extract_text() or ""):
            if para.strip():
                raw.append(Block(re.sub(r"\s*\n\s*", " ", para), i, f"Page {i}"))
    warnings = [] if raw else ["No extractable text — the PDF may be scanned and need OCR"]
    return _assemble(raw, len(reader.pages), "pypdf", warnings)


def parse(kind: str, data: bytes) -> ParsedDocument:
    if kind == "Markdown":
        return parse_text(data, markdown=True)
    if kind == "TXT":
        return parse_text(data, markdown=False)
    try:
        return _parse_pdf_docling(data)
    except Exception as e:  # not installed, or its models/torch can't load on this host
        reason = "not installed" if isinstance(e, ImportError) else f"failed: {str(e).strip().splitlines()[0][:160]}"
        log.warning("Docling %s; using pypdf for PDF text", reason)
        doc = _parse_pdf_pypdf(data)
        doc.warnings.append(f"Parsed with pypdf because Docling {reason} — headings and tables are not preserved")
        return doc
