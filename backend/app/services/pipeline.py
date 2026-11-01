"""Graph build job: the Stage 1 pipeline from uploaded sources to a reviewable draft graph.

Idempotent and retryable: parsing, chunking and embedding skip work already done, and
only documents not yet extracted are sent to the extractor. Each build produces a new
draft version layered on the case's latest version, so prior review decisions survive.
"""
import logging
import time
from dataclasses import asdict
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import SessionLocal
from app.models import AuditEvent, Case, DocumentChunk, Evidence, ProcessingJob, SourceDocument, utcnow
from app.services import analytics, embeddings, graph_store, parsing, storage, versions
from app.services.chunking import chunk_document
from app.services.extraction import get_extractor
from app.services.resolution import ChunkRef, Resolver

log = logging.getLogger(__name__)

STAGES = ["Document validation", "Document parsing", "Text normalization & chunking", "Embedding & vector indexing",
          "Entity & relationship extraction", "Entity resolution", "Evidence validation",
          "Knowledge graph construction", "Community detection", "Graph ready for review"]


class Cancelled(Exception):
    pass


class Build:
    def __init__(self, db: Session, job: ProcessingJob):
        self.db, self.job = db, job
        self.case: Case = db.get(Case, job.case_id)
        self.docs = list(db.scalars(select(SourceDocument).where(SourceDocument.case_id == job.case_id)
                                    .order_by(SourceDocument.uploaded_at)))
        self.parsed: dict[str, parsing.ParsedDocument] = {}
        self.extractions: list = []
        self.resolver: Resolver | None = None
        self.nodes, self.edges = [], []
        self.extracted_docs: list[str] = []
        self.pv_nodes: dict[str, list] = {}  # live preview for the build view: name -> [name, type, doc]
        self.pv_edges: dict[tuple, list] = {}

    # ----- job bookkeeping -----
    def log(self, msg: str, kind: str = "") -> None:
        self.job.logs = [*self.job.logs, {"t": datetime.now().strftime("%H:%M:%S"), "m": msg, "k": kind}]

    def doc_progress(self, doc_id: str, pct: int) -> None:
        self.job.per_doc = {**self.job.per_doc, doc_id: pct}

    def commit(self) -> None:
        self.db.commit()

    def check_cancel(self) -> None:
        self.commit()
        self.db.refresh(self.job, ["status"])
        if self.job.status == "cancelled":
            raise Cancelled()

    def stat(self, **kw) -> None:
        self.job.stats = {**self.job.stats, **kw}

    def preview(self, doc_name: str | None = None, ex=None) -> None:
        """Publish a capped, growing sketch of the graph so the UI can animate the build before Neo4j is written."""
        if doc_name and doc_name not in self.pv_nodes:
            self.pv_nodes[doc_name] = [doc_name, "document", None]
        if ex is not None:
            for e in ex.entities:
                if len(self.pv_nodes) < 700:
                    self.pv_nodes.setdefault(e.name, [e.name, e.type, doc_name])
            for r in ex.relationships:
                if r.subject in self.pv_nodes and r.object in self.pv_nodes and len(self.pv_edges) < 1600:
                    self.pv_edges.setdefault((r.subject, r.object), [r.subject, r.object, r.predicate])
        self.stat(preview={"nodes": list(self.pv_nodes.values()), "edges": list(self.pv_edges.values())})

    # ----- stages -----
    def validate(self) -> None:
        if not self.docs:
            self.log("No sources attached to this case", "e")
        for d in self.docs:
            try:
                ok = storage.checksum(storage.read(d.storage_path)) == d.checksum
                self.log(f"{d.filename}: valid {d.kind}, checksum verified" if ok else f"{d.filename}: checksum mismatch",
                         "o" if ok else "e")
                if not ok:
                    d.status, d.error = "failed", "Stored file does not match its checksum"
                elif d.status == "failed":
                    d.status, d.error = "stored", None  # earlier parse failure: try again
            except FileNotFoundError:
                d.status, d.error = "failed", "Stored file missing"
                self.log(f"{d.filename}: stored file missing", "e")
            self.doc_progress(d.id, 10)
            self.preview(d.filename)

    def parse(self) -> None:
        for d in self.docs:
            if d.status == "failed" or d.status == "parsed":
                self.doc_progress(d.id, 40)
                continue
            try:
                p = parsing.parse(d.kind, storage.read(d.storage_path))
                d.text, d.page_count, d.parser, d.warnings = p.text, p.page_count, p.parser, p.warnings
                d.status, d.error = ("parsed", None) if p.text else ("failed", "No extractable text")
                self.parsed[d.id] = p
                self.log(f"{d.filename}: {len(p.blocks)} blocks across {p.page_count} page(s) via {p.parser}",
                         "o" if p.text else "e")
                for w in p.warnings:
                    self.log(f"{d.filename}: {w}", "e")
            except Exception as e:  # parser failures are per document, never fatal for the build
                d.status, d.error = "failed", f"Parse error: {e}"
                self.log(f"{d.filename}: parse failed — {e}", "e")
            self.doc_progress(d.id, 40)
            self.check_cancel()

    def chunk(self) -> None:
        for d in self.docs:
            if d.id not in self.parsed:
                continue
            self.db.query(DocumentChunk).filter(DocumentChunk.document_id == d.id).delete()
            chunks = chunk_document(self.parsed[d.id])
            self.db.add_all(DocumentChunk(document_id=d.id, case_id=d.case_id, ordinal=c.ordinal, page=c.page,
                                          section=c.section, text=c.text, char_start=c.start, char_end=c.end,
                                          token_count=c.token_count) for c in chunks)
            self.log(f"{d.filename}: {len(chunks)} chunks")
            self.doc_progress(d.id, 55)

    def embed(self) -> None:
        todo = list(self.db.scalars(select(DocumentChunk).where(DocumentChunk.case_id == self.case.id,
                                                                DocumentChunk.embedding.is_(None))))
        for i in range(0, len(todo), 64):
            batch = todo[i:i + 64]
            for c, vec in zip(batch, embeddings.embed([c.text for c in batch]), strict=True):
                c.embedding = vec
            self.check_cancel()
        self.log(f"{len(todo)} chunks embedded with {embeddings.embedder_name()} into pgvector", "o")

    def extract(self) -> None:
        extractor = get_extractor()
        self.stat(extractor=extractor.name)
        if extractor.name.startswith("heuristic"):
            self.log("spaCy is not installed — regex heuristic in use (proper nouns + co-occurrence). "
                     "Install spaCy and en_core_web_sm for typed relations.", "e")
        else:
            self.log(f"Extracting locally with {extractor.name}")
        reextract = bool(self.job.stats.get("reextract"))
        targets = [d for d in self.docs if d.status == "parsed" and (reextract or d.extracted_at is None)]
        types = set(self.case.extract_types or [])
        failures = attempts = ents = rels = 0
        for d in targets:
            chunks = list(self.db.scalars(select(DocumentChunk).where(DocumentChunk.document_id == d.id)
                                          .order_by(DocumentChunk.ordinal)))
            for i, c in enumerate(chunks):
                attempts += 1
                try:
                    ex = extractor.extract(c.text, types)
                except Exception as e:  # one failed chunk is logged, not fatal
                    failures += 1
                    self.log(f"{d.filename} chunk {c.ordinal}: extraction failed — {type(e).__name__}: {e}", "e")
                    continue
                ents += len(ex.entities)
                self.preview(d.filename, ex)
                rels += len(ex.relationships)
                self.extractions.append((ChunkRef(c.id, d.id, c.page, c.section, c.text, c.char_start), ex))
                self.doc_progress(d.id, 55 + round(35 * (i + 1) / max(1, len(chunks))))
                self.check_cancel()
            self.extracted_docs.append(d.id)
        if attempts and failures == attempts:
            raise RuntimeError("Extraction failed for every chunk — see log")
        self.stat(candidate_entities=ents, candidate_relationships=rels)
        self.log(f"{ents} entity mentions and {rels} relationship candidates from {attempts} chunks", "o")

    def resolve(self) -> None:
        base = versions.latest(self.db, self.case.id)
        prior_n, prior_e = graph_store.read_version(base.id) if base else ([], [])
        self.base = base
        r = self.resolver = Resolver(prior_n, prior_e)
        for ref, ex in self.extractions:
            r.ingest(ref, ex)
        self.nodes, self.edges = r.finalize()
        dups = sum(1 for n in self.nodes if n.dup_of)
        self.log(f"{len(self.nodes)} entities after normalized-name and alias resolution"
                 f"{f' ({len(prior_n)} carried from {base.label})' if base else ''}; {dups} possible duplicates flagged")
        if r.unresolved:
            self.log(f"{r.unresolved} relationships dropped: subject or object did not resolve to an extracted entity", "e")

    def validate_evidence(self) -> None:
        r = self.resolver
        existing = {(e.chunk_id, e.char_start, e.char_end, e.support_type): e.id for e in self.db.scalars(
            select(Evidence).where(Evidence.case_id == self.case.id))}
        extractor = self.job.stats.get("extractor", "")

        def persist(spans) -> list[str]:
            ids = []
            for sp in spans:
                k = (sp.chunk_id, sp.start, sp.end, sp.support_type)
                if k not in existing:
                    ev = Evidence(case_id=self.case.id, document_id=sp.document_id, chunk_id=sp.chunk_id, page=sp.page,
                                  section=sp.section, quote=sp.quote, char_start=sp.start, char_end=sp.end,
                                  support_type=sp.support_type, extractor=extractor, job_id=self.job.id,
                                  confidence=sp.confidence)
                    self.db.add(ev)
                    self.db.flush()
                    existing[k] = ev.id
                ids.append(existing[k])
            return ids

        for n in self.nodes:
            n.evidence_ids = list(dict.fromkeys([*n.evidence_ids, *persist(n.new_evidence)]))
        for e in self.edges:
            e.evidence_ids = list(dict.fromkeys([*e.evidence_ids, *persist(e.new_evidence)]))
        conflicts = sum(e.status == "conflict" for e in self.edges)
        unsupported = sum(e.flag == "unsupported" for e in self.edges)
        self.log(f"{r.verified} quotes verified against source text; {r.unsupported} quotes not found in their chunk", "o")
        self.log(f"{conflicts} relationships with conflicting evidence; {unsupported} unsupported claims kept for review")

    def construct(self) -> None:
        if not self.extractions and self.base:
            self.log(f"No new sources to extract — {self.base.label} unchanged", "o")
            self.version = self.base
            return
        strip = {"new_evidence", "mentions"}
        nodes = [{k: v for k, v in asdict(n).items() if k not in strip} for n in self.nodes]
        edges = [{k: v for k, v in asdict(e).items() if k not in strip} for e in self.edges]
        self.version = versions.create_version(
            self.db, self.case, nodes, edges, self.job.created_by,
            "Initial extraction — review required" if not self.base else f"Rebuild on {self.base.label} with new sources",
            self.base.id if self.base else None, self.job.stats.get("extractor", ""))
        for d in self.docs:
            if d.id in self.extracted_docs:
                d.extracted_at = utcnow()
                self.doc_progress(d.id, 100)
        self.stat(version_id=self.version.id, entities=len(nodes), relationships=len(edges))
        self.log(f"Graph {self.version.label} written to Neo4j: {len(nodes)} entities, {len(edges)} relationships", "o")

    def detect_communities(self) -> None:
        nodes, edges = graph_store.read_version(self.version.id)
        _, comms, _ = analytics.communities(nodes, edges)
        self.log(f"{len(comms)} communities detected ({analytics.METHOD})")

    def finish(self) -> None:
        self.case.status = "Review" if self.case.status in ("Draft", "Review") else self.case.status
        self.case.stage = max(self.case.stage, 0)
        self.case.updated_at = utcnow()
        for d in self.docs:
            self.doc_progress(d.id, 100 if d.status == "parsed" else self.job.per_doc.get(d.id, 0))
        self.db.add(AuditEvent(tenant_id=self.case.tenant_id, case_id=self.case.id, actor=self.job.created_by,
                               action="graph.build", target=f"{self.case.title} — {self.version.label}"))
        self.log("Graph ready for review", "o")


def run_graph_build(job_id: str) -> None:
    db = SessionLocal()
    try:
        job = db.get(ProcessingJob, job_id)
        if not job or job.status in ("done", "cancelled"):
            return
        b = Build(db, job)
        steps = [b.validate, b.parse, b.chunk, b.embed, b.extract, b.resolve, b.validate_evidence, b.construct,
                 b.detect_communities, b.finish]
        # Stages are idempotent (finished parsing/chunking/embedding is skipped), so a retry replays from the top.
        b.log(f"{'Retry' if job.logs else 'Build'} started for {len(b.docs)} source(s)")
        job.status, job.error = "running", None
        for i, step in enumerate(steps):
            job.stage, job.progress = i, round(i / len(steps) * 100)
            b.check_cancel()
            t0 = time.monotonic()
            step()
            log.info("job %s stage %s done in %.2fs", job_id, STAGES[i], time.monotonic() - t0)
        job.status, job.progress, job.stage, job.finished_at = "done", 100, len(steps) - 1, utcnow()
        db.commit()
    except Cancelled:
        db.rollback()
        job = db.get(ProcessingJob, job_id)
        job.logs = [*job.logs, {"t": datetime.now().strftime("%H:%M:%S"), "m": "Build cancelled by user", "k": "e"}]
        job.finished_at = utcnow()
        db.commit()
    except Exception as e:
        log.exception("graph build %s failed", job_id)
        db.rollback()
        job = db.get(ProcessingJob, job_id)
        job.status, job.error, job.finished_at = "failed", f"{type(e).__name__}: {e}", utcnow()
        job.logs = [*job.logs, {"t": datetime.now().strftime("%H:%M:%S"), "m": f"Failed: {e}", "k": "e"}]
        db.commit()
    finally:
        db.close()
