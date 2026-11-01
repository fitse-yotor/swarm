"""Entity resolution and evidence validation.

Merges per-chunk candidates into one candidate graph (optionally on top of the nodes
and edges of the previous graph version) without silently merging uncertain matches:
- exact normalized name or alias match within a type  -> merged (deterministic)
- a lone surname matching exactly one person         -> merged as an alias
- similar names / same name across types             -> kept separate, flagged `dup_of`
Every claim's quote is located in its chunk; a claim whose quote cannot be found is
kept but flagged unsupported, so a reviewer sees it instead of it disappearing.
"""
import re
import uuid
from dataclasses import dataclass, field

from rapidfuzz import fuzz

from app.services.extraction import ChunkExtraction
from app.services.ontology import CO_OCCURS

_TITLES = re.compile(r"^(dr|mr|mrs|ms|prof|minister|president|director|mayor|chair|chairman|chairwoman|envoy|"
                     r"commissioner|ambassador|secretary|sir|madam)\s+")


def norm_name(name: str) -> str:
    n = re.sub(r"[^\w\s]", " ", name.casefold())
    n = re.sub(r"\s+", " ", n).strip()
    n = _TITLES.sub("", n)
    return re.sub(r"^the\s+", "", n)


@dataclass
class Span:
    document_id: str
    chunk_id: str
    page: int
    section: str
    quote: str
    start: int  # offsets into the document text
    end: int
    support_type: str = "supports"
    confidence: float = 0.5


@dataclass
class ChunkRef:
    id: str
    document_id: str
    page: int
    section: str
    text: str
    start: int  # chunk offset in its document


def locate(quote: str, text: str) -> tuple[int, int] | None:
    """Find `quote` in `text` tolerating whitespace/quote-mark differences; return offsets in `text`."""
    norm, idx = [], []
    prev_space = False
    trans = {"“": '"', "”": '"', "‘": "'", "’": "'", "–": "-", "—": "-"}
    for i, ch in enumerate(text):
        ch = trans.get(ch, ch)
        if ch.isspace():
            if prev_space:
                continue
            ch, prev_space = " ", True
        else:
            prev_space = False
        norm.append(ch)
        idx.append(i)
    hay = "".join(norm)
    q = re.sub(r"\s+", " ", "".join(trans.get(c, c) for c in quote)).strip()
    if len(q) < 3:
        return None
    pos = hay.find(q)
    if pos < 0:
        pos = hay.casefold().find(q.casefold())
    if pos >= 0:
        return idx[pos], idx[pos + len(q) - 1] + 1
    al = fuzz.partial_ratio_alignment(q, hay, score_cutoff=92)
    if al and al.dest_end > al.dest_start:
        return idx[al.dest_start], idx[al.dest_end - 1] + 1
    return None


@dataclass
class Node:
    id: str
    type: str
    name: str
    aliases: list[str] = field(default_factory=list)
    description: str = ""
    status: str = "pending"
    confidence: float = 0.0
    doc_ids: list[str] = field(default_factory=list)
    evidence_ids: list[str] = field(default_factory=list)
    new_evidence: list[Span] = field(default_factory=list)
    dup_of: str | None = None
    not_dup: bool = False
    attrs: dict = field(default_factory=dict)
    mentions: int = 0


@dataclass
class Edge:
    id: str
    s: str
    o: str
    type: str
    statement: str = ""
    confidence: float = 0.0
    status: str = "pending"
    flag: str | None = None
    directed: bool = True
    epistemic_status: str = "reported"
    evidence_ids: list[str] = field(default_factory=list)
    new_evidence: list[Span] = field(default_factory=list)
    valid_from: str | None = None
    valid_to: str | None = None


def _nid() -> str:
    return "n_" + uuid.uuid4().hex[:10]


def _eid() -> str:
    return "e_" + uuid.uuid4().hex[:10]


class Resolver:
    def __init__(self, existing_nodes: list[dict] | None = None, existing_edges: list[dict] | None = None):
        self.nodes: dict[str, Node] = {}
        self.edges: dict[tuple, Edge] = {}
        self.index: dict[tuple[str, str], str] = {}  # (type, norm) -> node id
        self.by_norm: dict[str, set[str]] = {}
        self.unresolved = 0
        self.unsupported = 0
        self.verified = 0
        self.prior_nodes: set[str] = set()
        for d in existing_nodes or []:
            n = Node(**{k: d.get(k) for k in ("id", "type", "name", "description", "status", "dup_of")},
                     aliases=list(d.get("aliases") or []), confidence=d.get("confidence") or 0.0,
                     doc_ids=list(d.get("doc_ids") or []), evidence_ids=list(d.get("evidence_ids") or []),
                     not_dup=bool(d.get("not_dup")), attrs=dict(d.get("attrs") or {}))
            self._add_node(n)
            self.prior_nodes.add(n.id)
        for d in existing_edges or []:
            e = Edge(**{k: d.get(k) for k in ("id", "s", "o", "type", "statement", "status", "flag", "epistemic_status",
                                               "valid_from", "valid_to")},
                     confidence=d.get("confidence") or 0.0, directed=d.get("directed", True),
                     evidence_ids=list(d.get("evidence_ids") or []))
            self.edges[self._ekey(e.s, e.type, e.o, e.directed)] = e

    # ----- nodes -----
    def _add_node(self, n: Node) -> None:
        self.nodes[n.id] = n
        for key in [n.name, *n.aliases]:
            k = norm_name(key)
            if k:
                self.index.setdefault((n.type, k), n.id)
                self.by_norm.setdefault(k, set()).add(n.id)

    def lookup(self, name: str, prefer: set[str] | None = None) -> str | None:
        ids = self.by_norm.get(norm_name(name), set())
        if prefer and ids & prefer:
            return sorted(ids & prefer)[0]
        return sorted(ids)[0] if ids else None

    def add_entity(self, name: str, etype: str, aliases: list[str], desc: str, span: Span | None,
                   confidence: float) -> str:
        keys = [norm_name(x) for x in [name, *aliases] if norm_name(x)]
        nid = next((self.index[(etype, k)] for k in keys if (etype, k) in self.index), None)
        if nid is None and etype == "person" and len(keys[0].split()) == 1:
            # A bare surname ("Mwangi") resolves to the single person whose name ends with it.
            hits = [n.id for n in self.nodes.values() if n.type == "person" and norm_name(n.name).split()[-1:] == keys[:1]]
            nid = hits[0] if len(hits) == 1 else None
        if nid is None:
            node = Node(id=_nid(), type=etype, name=name.strip(), description=desc, confidence=confidence)
            other = next((i for k in keys for i in self.by_norm.get(k, set())), None)
            if other:
                node.dup_of = other
            self._add_node(node)
            nid = node.id
        node = self.nodes[nid]
        new_aliases = [a for a in [name, *aliases] if a.strip() and norm_name(a) != norm_name(node.name)
                       and norm_name(a) not in {norm_name(x) for x in node.aliases}]
        if new_aliases:
            node.aliases.extend(a.strip() for a in new_aliases)
            for a in new_aliases:
                self.index.setdefault((etype, norm_name(a)), nid)
                self.by_norm.setdefault(norm_name(a), set()).add(nid)
        if not node.description and desc:
            node.description = desc
        node.mentions += 1
        node.confidence = max(node.confidence, confidence)
        if span:
            if span.document_id not in node.doc_ids:
                node.doc_ids.append(span.document_id)
            if len(node.new_evidence) < 5:
                node.new_evidence.append(span)
        return nid

    # ----- edges -----
    @staticmethod
    def _ekey(s: str, t: str, o: str, directed: bool) -> tuple:
        return (s, t, o) if directed else (min(s, o), t, max(s, o))

    def add_relationship(self, s: str, t: str, o: str, statement: str, span: Span | None, epistemic: str) -> None:
        directed = t != CO_OCCURS
        key = self._ekey(s, t, o, directed)
        e = self.edges.get(key)
        if e is None:
            s2, o2 = (key[0], key[2])
            e = Edge(id=_eid(), s=s2, o=o2, type=t, statement=statement, directed=directed, epistemic_status=epistemic)
            self.edges[key] = e
        if span:
            e.new_evidence.append(span)
            e.confidence = max(e.confidence, span.confidence)
            for nid in (s, o):
                if span.document_id not in self.nodes[nid].doc_ids:
                    self.nodes[nid].doc_ids.append(span.document_id)

    # ----- ingest one chunk -----
    def ingest(self, chunk: ChunkRef, ex: ChunkExtraction) -> None:
        def span_for(quote: str, support: str = "supports", conf: float = 0.5) -> Span | None:
            loc = locate(quote, chunk.text)
            if not loc:
                self.unsupported += 1
                return None
            self.verified += 1
            a, b = loc
            return Span(chunk.document_id, chunk.id, chunk.page, chunk.section, chunk.text[a:b],
                        chunk.start + a, chunk.start + b, support, conf)

        local: set[str] = set()
        for ent in ex.entities:
            sp = span_for(ent.quote, conf=0.6)
            local.add(self.add_entity(ent.name, ent.type, ent.aliases, ent.description, sp, 0.6 if sp else 0.3))
        for r in ex.relationships:
            s, o = self.lookup(r.subject, local), self.lookup(r.object, local)
            if not s or not o or s == o:
                self.unresolved += 1
                continue
            conf = max(0.0, min(1.0, r.confidence))
            sp = span_for(r.quote, "contradicts" if r.assertion == "denied" else "supports",
                          conf * (0.6 if r.assertion == "uncertain" else 1.0))
            self.add_relationship(s, r.predicate, o, r.statement, sp, r.epistemic_status)

    # ----- finalize -----
    def finalize(self) -> tuple[list[Node], list[Edge]]:
        for e in self.edges.values():
            kinds = {sp.support_type for sp in e.new_evidence}
            if "contradicts" in kinds and ("supports" in kinds or e.evidence_ids) and e.status != "rejected":
                e.status = "conflict"
            if not e.evidence_ids and not e.new_evidence:
                e.flag = "unsupported"
            elif e.flag == "unsupported":
                e.flag = None
            for nid in (e.s, e.o):
                self.nodes[nid].confidence = max(self.nodes[nid].confidence, e.confidence)
        # Fuzzy duplicate suggestions for new nodes only; analysts decide.
        nodes = list(self.nodes.values())
        for n in nodes:
            if n.id in self.prior_nodes or n.dup_of or n.not_dup:
                continue
            a = norm_name(n.name)
            for m in nodes:
                if m.id == n.id or m.type != n.type or m.dup_of == n.id:
                    continue
                b = norm_name(m.name)
                if (len(a) > 4 and len(b) > 4 and (a in b or b in a)) or fuzz.token_sort_ratio(a, b) >= 90:
                    # Suggest merging into the reviewed (prior) node, else the more specific (longer) name.
                    rank = lambda x: (x.id in self.prior_nodes, len(norm_name(x.name)), x.mentions)  # noqa: E731
                    canon, other = (m, n) if rank(m) >= rank(n) else (n, m)
                    if not other.dup_of and not other.not_dup:
                        other.dup_of = canon.id
                    break
        for n in nodes:
            n.confidence = round(n.confidence or 0.5, 2)
        for e in self.edges.values():
            e.confidence = round(e.confidence or 0.3, 2)
        return nodes, list(self.edges.values())
