from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ScopeType = Literal["person", "organization", "country"]
EntityType = Literal["person", "organization", "country", "location", "event", "policy", "topic", "document"]
ReviewStatus = Literal["approved", "rejected", "pending"]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ----- auth -----
class LoginIn(BaseModel):
    email: str
    password: str


class UserOut(ORM):
    id: str
    name: str
    email: str
    role: str
    status: str
    permissions: list[str] = []


class TokenOut(BaseModel):
    access_token: str
    user: UserOut


# ----- cases -----
class CaseIn(BaseModel):
    title: str = Field(min_length=3, max_length=160)
    description: str = Field("", max_length=1500)
    research_question: str = Field("", max_length=3000)
    objective: str = Field("", max_length=3000)
    scope_type: ScopeType | None = None
    tags: list[str] = []
    visibility: Literal["Private", "Team", "Organization"] = "Team"
    extract_types: list[EntityType] = ["person", "organization", "country", "location", "event", "policy", "topic"]


class CasePatch(BaseModel):
    title: str | None = Field(None, min_length=3, max_length=160)
    description: str | None = Field(None, max_length=1500)
    research_question: str | None = Field(None, max_length=3000)
    objective: str | None = Field(None, max_length=3000)
    scope_type: ScopeType | None = None
    tags: list[str] | None = None
    visibility: Literal["Private", "Team", "Organization"] | None = None
    extract_types: list[EntityType] | None = None
    revision: int  # optimistic locking


class CaseOut(ORM):
    id: str
    title: str
    description: str
    research_question: str
    objective: str
    scope_type: str | None
    tags: list[str]
    visibility: str
    status: str
    stage: int
    extract_types: list[str]
    current_version_id: str | None
    revision: int
    owner_name: str
    created_at: datetime
    updated_at: datetime
    document_count: int = 0
    graph_label: str | None = None
    graph_status: str | None = None


# ----- documents -----
class DocumentOut(ORM):
    id: str
    case_id: str
    filename: str
    kind: str
    size: int
    checksum: str
    status: str
    parser: str | None
    page_count: int | None
    error: str | None
    warnings: list[str]
    uploaded_by: str
    uploaded_at: datetime
    extracted_at: datetime | None
    chunk_count: int = 0
    claim_count: int = 0


class UploadResult(BaseModel):
    documents: list[DocumentOut]
    rejected: list[dict]


class PasteIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=20)


class ChunkOut(ORM):
    id: str
    ordinal: int
    page: int
    section: str
    text: str
    char_start: int
    char_end: int


# ----- jobs -----
class JobOut(ORM):
    id: str
    case_id: str
    kind: str
    status: str
    stage: int
    progress: int
    logs: list[dict]
    per_doc: dict
    stats: dict
    error: str | None
    created_by: str
    created_at: datetime
    finished_at: datetime | None
    stages: list[str] = []


class BuildIn(BaseModel):
    reextract: bool = False


# ----- graph -----
class VersionOut(ORM):
    id: str
    number: int
    label: str
    status: str
    note: str
    parent_id: str | None
    extractor: str
    created_by: str
    created_at: datetime
    approved_by: str | None
    approved_at: datetime | None
    content_hash: str | None
    node_count: int
    edge_count: int


class NodeOut(BaseModel):
    id: str
    type: str
    name: str
    aliases: list[str]
    description: str | None
    status: str
    confidence: float
    doc_ids: list[str]
    evidence_ids: list[str]
    dup_of: str | None
    not_dup: bool
    attrs: dict
    community: str | None = None
    degree: int = 0


class EdgeOut(BaseModel):
    id: str
    s: str
    o: str
    type: str
    statement: str | None
    confidence: float
    status: str
    flag: str | None
    directed: bool
    epistemic_status: str | None
    evidence_ids: list[str]
    valid_from: str | None
    valid_to: str | None


class GraphOut(BaseModel):
    version: VersionOut
    versions: list[VersionOut]
    nodes: list[NodeOut]
    edges: list[EdgeOut]
    communities: list[dict]
    community_method: str
    documents: dict[str, str]
    editable: bool


class EvidenceOut(ORM):
    id: str
    document_id: str
    document: str = ""
    chunk_id: str
    page: int
    section: str
    quote: str
    char_start: int
    char_end: int
    support_type: str
    extractor: str
    confidence: float


class NodePatch(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=300)
    type: EntityType | None = None
    description: str | None = None
    aliases: list[str] | None = None
    status: ReviewStatus | None = None


class NodeIn(BaseModel):
    name: str = Field(min_length=2, max_length=300)
    type: EntityType
    description: str = ""
    chunk_id: str | None = None  # supporting passage


class EdgePatch(BaseModel):
    type: str | None = None
    confidence: float | None = Field(None, ge=0, le=1)
    swap: bool = False
    directed: bool | None = None
    valid_from: str | None = None
    valid_to: str | None = None
    add_chunk_id: str | None = None
    quote: str | None = None
    status: ReviewStatus | None = None


class EdgeIn(BaseModel):
    s: str
    o: str
    type: str
    chunk_id: str | None = None
    quote: str | None = None


class MergeIn(BaseModel):
    keep_id: str
    drop_ids: list[str] = Field(min_length=1)


class BulkStatusIn(BaseModel):
    node_ids: list[str] = []
    edge_ids: list[str] = []
    status: ReviewStatus


class HistoryOut(ORM):
    id: str
    object_kind: str
    object_id: str
    action: str
    actor: str
    at: datetime


class QueryIn(BaseModel):
    question: str = Field(min_length=3, max_length=2000)
    version_id: str | None = None


class AuditOut(ORM):
    id: str
    case_id: str | None
    actor: str
    action: str
    target: str
    at: datetime
