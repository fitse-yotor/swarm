"""Deterministic, offset-preserving chunking: the same parsed text and settings give the same chunks."""
import re
from dataclasses import dataclass

from app.core.config import settings
from app.services.parsing import ParsedDocument

_SENT = re.compile(r"[^.!?]+(?:[.!?]+[\"'”’)]*|$)\s*")


@dataclass
class Chunk:
    ordinal: int
    page: int
    section: str
    start: int
    end: int
    text: str

    @property
    def token_count(self) -> int:
        return max(1, round(len(self.text) / 4))


def sentence_spans(text: str, base: int = 0) -> list[tuple[int, int]]:
    """Character spans of sentences, trimmed of surrounding whitespace."""
    spans = []
    for m in _SENT.finditer(text):
        s, e = m.start(), m.end()
        while s < e and text[s].isspace():
            s += 1
        while e > s and text[e - 1].isspace():
            e -= 1
        if e > s:
            spans.append((base + s, base + e))
    return spans


def chunk_document(doc: ParsedDocument, target: int | None = None, overlap: int | None = None) -> list[Chunk]:
    target = target or settings.chunk_target_chars
    overlap = settings.chunk_overlap_chars if overlap is None else overlap
    # Work in sentence units so chunk edges never cut a sentence; never cross a section.
    units: list[tuple[int, int, int, str]] = []  # start, end, page, section
    for b in doc.blocks:
        for s, e in sentence_spans(doc.text[b.start:b.end], b.start):
            units.append((s, e, b.page, b.section))

    chunks: list[Chunk] = []
    i = 0
    while i < len(units):
        s0, e0, page, section = units[i]
        j = i
        while j + 1 < len(units) and units[j + 1][3] == section and units[j + 1][1] - s0 <= target:
            j += 1
        end = units[j][1]
        chunks.append(Chunk(len(chunks), page, section, s0, end, doc.text[s0:end]))
        if j + 1 >= len(units):
            break
        # Step back over trailing sentences that fit inside the overlap window.
        nxt = j + 1
        if overlap and units[nxt][3] == section:
            k = j
            while k > i and end - units[k][0] <= overlap:
                k -= 1
            nxt = k + 1 if k + 1 > i else j + 1
        i = nxt
    return chunks
