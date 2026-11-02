"""PostgreSQL system of record for cases, sources, jobs, versions, evidence and audit.

Graph nodes and relationships live in Neo4j (see services/graph_store.py); Postgres
holds everything that must be relational, versioned metadata or vector-indexed.
"""
import uuid
from datetime import UTC, datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import JSON, BigInteger, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.config import settings
from app.core.db import Base


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def utcnow() -> datetime:
    return datetime.now(UTC)


class Tenant(Base):
    __tablename__ = "tenants"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("t"))
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("u"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    email: Mapped[str] = mapped_column(String(320), unique=True)
    role: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(20), default="Active")
    password_hash: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Role(Base):
    """A named permission set inside a tenant. Users reference it by name (User.role).

    Built-in roles are seeded from core.security.ROLES; their permissions can be edited (except
    Administrator, which always holds every permission) but they cannot be renamed or deleted.
    """
    __tablename__ = "roles"
    __table_args__ = (UniqueConstraint("tenant_id", "name"),)
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("r"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    name: Mapped[str] = mapped_column(String(40))
    description: Mapped[str] = mapped_column(Text, default="")
    permissions: Mapped[list] = mapped_column(JSON, default=list)
    builtin: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class TenantSettings(Base):
    """Workspace settings edited in Administration (a separate table so create_all can add it)."""
    __tablename__ = "tenant_settings"
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), primary_key=True)
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_by: Mapped[str | None] = mapped_column(String(200), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Case(Base):
    __tablename__ = "cases"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("c"))
    tenant_id: Mapped[str] = mapped_column(ForeignKey("tenants.id"), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    title: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text, default="")
    research_question: Mapped[str] = mapped_column(Text, default="")
    objective: Mapped[str] = mapped_column(Text, default="")
    scope_type: Mapped[str | None] = mapped_column(String(20), nullable=True)  # person | organization | country
    tags: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    visibility: Mapped[str] = mapped_column(String(20), default="Team")
    status: Mapped[str] = mapped_column(String(20), default="Draft")  # Draft | Review | Active | Archived
    stage: Mapped[int] = mapped_column(Integer, default=-1)  # index into the five workflow stages
    extract_types: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    current_version_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    owner: Mapped[User] = relationship()


class SourceDocument(Base):
    __tablename__ = "source_documents"
    __table_args__ = (UniqueConstraint("case_id", "checksum"),)
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("d"))
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(300))
    kind: Mapped[str] = mapped_column(String(20))  # PDF | Markdown | TXT
    media_type: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(BigInteger)
    checksum: Mapped[str] = mapped_column(String(64))
    storage_path: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(20), default="stored")  # stored | parsed | failed
    parser: Mapped[str | None] = mapped_column(String(40), nullable=True)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    text: Mapped[str] = mapped_column(Text, default="")  # normalized text; chunk/evidence offsets index into it
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    extracted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    uploaded_by: Mapped[str] = mapped_column(String(200))
    uploaded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DocumentChunk(Base):
    __tablename__ = "document_chunks"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("k"))
    document_id: Mapped[str] = mapped_column(ForeignKey("source_documents.id", ondelete="CASCADE"), index=True)
    case_id: Mapped[str] = mapped_column(String(40), index=True)
    ordinal: Mapped[int] = mapped_column(Integer)
    page: Mapped[int] = mapped_column(Integer, default=1)
    section: Mapped[str] = mapped_column(String(300), default="")
    text: Mapped[str] = mapped_column(Text)
    char_start: Mapped[int] = mapped_column(Integer)
    char_end: Mapped[int] = mapped_column(Integer)
    token_count: Mapped[int] = mapped_column(Integer)
    chunk_version: Mapped[str] = mapped_column(String(20), default="v1")
    embedding = mapped_column(Vector(settings.embedding_dim), nullable=True)


class ProcessingJob(Base):
    __tablename__ = "processing_jobs"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("job"))
    tenant_id: Mapped[str] = mapped_column(String(40), index=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(40))  # graph_build
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued | running | done | failed | cancelled
    stage: Mapped[int] = mapped_column(Integer, default=0)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    logs: Mapped[list] = mapped_column(JSON, default=list)
    per_doc: Mapped[dict] = mapped_column(JSON, default=dict)
    stats: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class GraphVersion(Base):
    __tablename__ = "graph_versions"
    __table_args__ = (UniqueConstraint("case_id", "number"),)
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("gv"))
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="draft")  # draft | approved
    note: Mapped[str] = mapped_column(Text, default="")
    parent_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    extractor: Mapped[str] = mapped_column(String(80), default="")
    created_by: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    approved_by: Mapped[str | None] = mapped_column(String(200), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    content_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    node_count: Mapped[int] = mapped_column(Integer, default=0)
    edge_count: Mapped[int] = mapped_column(Integer, default=0)

    @property
    def label(self) -> str:
        return f"v{self.number}"


class Evidence(Base):
    """An exact source span supporting (or contradicting) a graph claim. Immutable."""
    __tablename__ = "evidence"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("ev"))
    case_id: Mapped[str] = mapped_column(String(40), index=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("source_documents.id", ondelete="CASCADE"))
    chunk_id: Mapped[str] = mapped_column(ForeignKey("document_chunks.id", ondelete="CASCADE"))
    page: Mapped[int] = mapped_column(Integer, default=1)
    section: Mapped[str] = mapped_column(String(300), default="")
    quote: Mapped[str] = mapped_column(Text)
    char_start: Mapped[int] = mapped_column(Integer)  # offsets into SourceDocument.text
    char_end: Mapped[int] = mapped_column(Integer)
    support_type: Mapped[str] = mapped_column(String(20), default="supports")  # supports | contradicts
    extractor: Mapped[str] = mapped_column(String(80), default="")
    job_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ReviewAction(Base):
    __tablename__ = "review_actions"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("ra"))
    case_id: Mapped[str] = mapped_column(String(40), index=True)
    version_id: Mapped[str] = mapped_column(String(40), index=True)
    object_kind: Mapped[str] = mapped_column(String(10))  # node | edge | version
    object_id: Mapped[str] = mapped_column(String(40), index=True)
    action: Mapped[str] = mapped_column(String(300))
    actor: Mapped[str] = mapped_column(String(200))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("a"))
    tenant_id: Mapped[str] = mapped_column(String(40), index=True)
    case_id: Mapped[str | None] = mapped_column(String(40), index=True, nullable=True)
    actor: Mapped[str] = mapped_column(String(200))
    action: Mapped[str] = mapped_column(String(60))
    target: Mapped[str] = mapped_column(Text)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# ---------------------------------------------------------------- Stages 2-5
class Environment(Base):
    """Stage 2: agents derived from a graph version, their social links and run settings."""
    __tablename__ = "environments"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("env"))
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[str] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(160))
    scenario: Mapped[str] = mapped_column(Text, default="")  # what-if the simulation explores
    status: Mapped[str] = mapped_column(String(20), default="preparing")  # preparing | ready | approved | failed
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    agents: Mapped[list] = mapped_column(JSON, default=list)
    links: Mapped[list] = mapped_column(JSON, default=list)
    seed_posts: Mapped[list] = mapped_column(JSON, default=list)
    job_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    created_by: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Simulation(Base):
    """Stage 3: one run of an environment. Progress and logs live on its ProcessingJob."""
    __tablename__ = "simulations"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("sim"))
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    environment_id: Mapped[str] = mapped_column(ForeignKey("environments.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(160))
    engine: Mapped[str] = mapped_column(String(80), default="")
    status: Mapped[str] = mapped_column(String(20), default="queued")
    config: Mapped[dict] = mapped_column(JSON, default=dict)  # frozen copy of the environment at start
    rounds: Mapped[list] = mapped_column(JSON, default=list)  # per-round metrics
    stats: Mapped[dict] = mapped_column(JSON, default=dict)
    job_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_by: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SimEvent(Base):
    __tablename__ = "sim_events"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("se"))
    simulation_id: Mapped[str] = mapped_column(ForeignKey("simulations.id", ondelete="CASCADE"), index=True)
    round: Mapped[int] = mapped_column(Integer, index=True)
    platform: Mapped[str] = mapped_column(String(20))  # microblog | forum
    agent_id: Mapped[str] = mapped_column(String(40))
    agent_name: Mapped[str] = mapped_column(String(300))
    action: Mapped[str] = mapped_column(String(30))  # CREATE_POST | CREATE_COMMENT | REPOST | LIKE_POST | ...
    content: Mapped[str] = mapped_column(Text, default="")
    target_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    stance: Mapped[float] = mapped_column(Float, default=0.0)
    likes: Mapped[int] = mapped_column(Integer, default=0)
    replies: Mapped[int] = mapped_column(Integer, default=0)
    reposts: Mapped[int] = mapped_column(Integer, default=0)
    generated_by: Mapped[str] = mapped_column(String(80), default="template")


class Report(Base):
    """Stage 4: findings computed from a simulation, written up with section provenance."""
    __tablename__ = "reports"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("rep"))
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    simulation_id: Mapped[str] = mapped_column(ForeignKey("simulations.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    status: Mapped[str] = mapped_column(String(20), default="generating")  # generating | draft | approved | failed
    sections: Mapped[list] = mapped_column(JSON, default=list)
    facts: Mapped[dict] = mapped_column(JSON, default=dict)
    model: Mapped[str] = mapped_column(String(80), default="")
    job_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_by: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    approved_by: Mapped[str | None] = mapped_column(String(200), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Conversation(Base):
    """Stage 5: a chat with the report agent, a simulated agent, or the graph."""
    __tablename__ = "conversations"
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("cv"))
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    simulation_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    target: Mapped[str] = mapped_column(String(120))  # report:<id> | agent:<agent id> | graph
    title: Mapped[str] = mapped_column(String(200))
    messages: Mapped[list] = mapped_column(JSON, default=list)
    created_by: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


# ---------------------------------------------------------------- generated reactions, graph events, snapshots
class ReactionRun(Base):
    """One automatic generation of reaction hypotheses from an approved graph version. Re-running adds a new run."""
    __tablename__ = "reaction_runs"
    __table_args__ = (UniqueConstraint("case_id", "number"),)
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("rr"))
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[str] = mapped_column(String(40))  # the approved graph version the hypotheses were generated from
    number: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="generating")  # generating | ready | failed
    mode: Mapped[str] = mapped_column(String(20), default="demo-rules")  # llm | demo-rules
    provider: Mapped[str] = mapped_column(String(120), default="")
    template_version: Mapped[str] = mapped_column(String(40), default="")
    stats: Mapped[dict] = mapped_column(JSON, default=dict)
    job_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Reaction(Base):
    """A generated hypothesis about how an actor might respond. Never a verified statement or real-world event."""
    __tablename__ = "reactions"
    __table_args__ = (Index("ix_reactions_case_status", "case_id", "status"), Index("ix_reactions_run_actor", "run_id", "actor_id"))
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("rx"))
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("reaction_runs.id", ondelete="CASCADE"))
    version_id: Mapped[str] = mapped_column(String(40))
    actor_id: Mapped[str] = mapped_column(String(40))  # research-graph node id
    actor_name: Mapped[str] = mapped_column(String(300))
    actor_type: Mapped[str] = mapped_column(String(30))
    title: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(40))
    trigger: Mapped[str] = mapped_column(String(400))
    related: Mapped[list] = mapped_column(JSON, default=list)       # [{id, name, relation}] connected entities used
    evidence_ids: Mapped[list] = mapped_column(JSON, default=list)  # Evidence rows that ground the context
    reasoning: Mapped[str] = mapped_column(Text, default="")
    confidence: Mapped[float] = mapped_column(Float, default=0.3)
    assumptions: Mapped[list] = mapped_column(JSON, default=list)   # [{text, basis: evidence_supported|model_inferred|synthetic}]
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    provenance: Mapped[str] = mapped_column(String(30), default="generated_hypothesis")
    status: Mapped[str] = mapped_column(String(20), default="generated")  # generated | reviewed | selected | excluded
    edited: Mapped[bool] = mapped_column(default=False)
    environment_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    generator: Mapped[dict] = mapped_column(JSON, default=dict)     # {mode, provider, template_version}
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class GraphEvent(Base):
    """Append-only record of one change to the simulation layer of the case graph. Never edited or deleted individually."""
    __tablename__ = "graph_events"
    __table_args__ = (UniqueConstraint("run_id", "attempt", "seq"), Index("ix_graph_events_case_run", "case_id", "run_id"))
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("ge"))
    case_id: Mapped[str] = mapped_column(String(40), index=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("simulations.id", ondelete="CASCADE"))
    attempt: Mapped[int] = mapped_column(Integer, default=1)  # a retried run starts a new attempt; old events stay as history
    seq: Mapped[int] = mapped_column(Integer)
    step: Mapped[int] = mapped_column(Integer)  # simulation round
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    event_type: Mapped[str] = mapped_column(String(40), index=True)
    actor_ids: Mapped[list] = mapped_column(JSON, default=list)
    description: Mapped[str] = mapped_column(Text, default="")
    nodes: Mapped[list] = mapped_column(JSON, default=list)   # affected node ids (unified graph ids)
    edges: Mapped[list] = mapped_column(JSON, default=list)   # affected edge ids
    before: Mapped[dict] = mapped_column(JSON, default=dict)
    after: Mapped[dict] = mapped_column(JSON, default=dict)
    trigger_event_id: Mapped[str | None] = mapped_column(String(40), nullable=True)  # the SimEvent that caused it
    provenance: Mapped[str] = mapped_column(String(30), default="simulation_generated")
    graph_version: Mapped[int] = mapped_column(Integer, default=0)  # dynamic graph version this event created


class GraphSnapshot(Base):
    """Immutable copy of the layered graph at a point in time. There is deliberately no update path."""
    __tablename__ = "graph_snapshots"
    __table_args__ = (UniqueConstraint("case_id", "number"),)
    id: Mapped[str] = mapped_column(String(40), primary_key=True, default=lambda: new_id("sn"))
    case_id: Mapped[str] = mapped_column(ForeignKey("cases.id", ondelete="CASCADE"), index=True)
    parent_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    number: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(40))  # research_approved | reactions_generated | simulation_start | checkpoint | simulation_complete | manual
    note: Mapped[str] = mapped_column(Text, default="")
    version_id: Mapped[str | None] = mapped_column(String(40), nullable=True)  # research graph version
    simulation_id: Mapped[str | None] = mapped_column(String(40), nullable=True, index=True)
    step: Mapped[int | None] = mapped_column(Integer, nullable=True)
    event_seq: Mapped[int | None] = mapped_column(Integer, nullable=True)  # last graph event included
    reaction_run_id: Mapped[str | None] = mapped_column(String(40), nullable=True)
    graph_version: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    state: Mapped[dict] = mapped_column(JSON, default=dict)
    content_hash: Mapped[str] = mapped_column(String(64))
