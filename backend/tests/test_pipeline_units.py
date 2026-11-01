from pathlib import Path

from app.services.chunking import chunk_document, sentence_spans
from app.services.extraction import ChunkExtraction, ExtractedEntity, ExtractedRelationship, HeuristicExtractor
from app.services.parsing import parse_text
from app.services.resolution import ChunkRef, Resolver, locate, norm_name
from app.services.storage import UploadRejected, sniff

SEED = Path(__file__).resolve().parent.parent / "seed_data"


def test_markdown_sections_and_offsets():
    doc = parse_text((SEED / "VBC Quarterly Briefing — Q3.md").read_bytes(), markdown=True)
    assert [b.section for b in doc.blocks] == ["Summary", "Reservoir status", "Delegation positions", "Next steps"]
    for b in doc.blocks:
        assert doc.text[b.start:b.end] == b.text


def test_plaintext_headings():
    doc = parse_text((SEED / "IHC Technical Note — Inflow Modelling.txt").read_bytes(), markdown=False)
    assert [b.section for b in doc.blocks] == ["Abstract", "Findings", "Limitations"]


def test_chunking_is_deterministic_and_offset_exact():
    doc = parse_text((SEED / "VBC Quarterly Briefing — Q3.md").read_bytes(), markdown=True)
    a, b = chunk_document(doc, target=200, overlap=60), chunk_document(doc, target=200, overlap=60)
    assert [(c.start, c.end) for c in a] == [(c.start, c.end) for c in b]
    assert all(doc.text[c.start:c.end] == c.text for c in a)
    assert len({c.section for c in a}) == 4  # chunks never cross a section
    covered = set()
    for c in a:
        covered.update(range(c.start, c.end))
    for s, e in sentence_spans(doc.text):
        if doc.text[s:e].strip():
            assert s in covered  # no sentence dropped


def test_locate_tolerates_whitespace_and_quotes():
    text = "Union chair Marta Sol said members  oppose the filling schedule."
    s, e = locate("Marta Sol said members oppose", text)
    assert text[s:e] == "Marta Sol said members  oppose"
    assert locate("not in the passage at all", text) is None


def test_norm_name_strips_titles_and_articles():
    assert norm_name("Commissioner Ada Mwangi") == "ada mwangi"
    assert norm_name("The Varn Basin Commission") == "varn basin commission"


def test_upload_validation():
    assert sniff("a.md", b"# hi")[0] == "Markdown"
    for name, data in [("a.pdf", b"not a pdf"), ("a.docx", b"x"), ("a.txt", b"\xff\xfe")]:
        try:
            sniff(name, data)
            raise AssertionError(f"{name} accepted")
        except UploadRejected:
            pass


def _chunk(text: str) -> ChunkRef:
    return ChunkRef("k1", "d1", 1, "S", text, 0)


def test_resolver_merges_aliases_flags_conflicts_and_unsupported():
    t = ("Commissioner Mwangi leads the Varn Basin Commission. Ada Mwangi leads the VBC. "
         "One official claimed the Ministry would suspend the Accord, a statement the Ministry later denied.")
    ex = ChunkExtraction(
        entities=[
            ExtractedEntity(name="Ada Mwangi", type="person", aliases=["Commissioner Mwangi"], description="", quote="Ada Mwangi"),
            ExtractedEntity(name="Varn Basin Commission", type="organization", aliases=["VBC"], description="", quote="Varn Basin Commission"),
            ExtractedEntity(name="Mwangi", type="person", aliases=[], description="", quote="Commissioner Mwangi"),
            ExtractedEntity(name="Ministry", type="organization", aliases=[], description="", quote="the Ministry"),
            ExtractedEntity(name="Accord", type="policy", aliases=[], description="", quote="the Accord"),
        ],
        relationships=[
            ExtractedRelationship(subject="Commissioner Mwangi", predicate="LEADS", object="VBC", statement="",
                                  quote="Ada Mwangi leads the VBC.", assertion="affirmed", epistemic_status="observed",
                                  confidence=0.9),
            ExtractedRelationship(subject="Ministry", predicate="RELATED_TO", object="Accord", statement="",
                                  quote="claimed the Ministry would suspend the Accord", assertion="affirmed",
                                  epistemic_status="reported", confidence=0.4),
            ExtractedRelationship(subject="Ministry", predicate="RELATED_TO", object="Accord", statement="",
                                  quote="a statement the Ministry later denied", assertion="denied",
                                  epistemic_status="reported", confidence=0.6),
            ExtractedRelationship(subject="Ministry", predicate="SUPPORTS", object="Accord", statement="",
                                  quote="this sentence is invented", assertion="affirmed",
                                  epistemic_status="inferred", confidence=0.5),
        ])
    r = Resolver()
    r.ingest(_chunk(t), ex)
    nodes, edges = r.finalize()
    people = [n for n in nodes if n.type == "person"]
    assert len(people) == 1 and "Commissioner Mwangi" in people[0].aliases
    by_type = {e.type: e for e in edges}
    assert by_type["LEADS"].status == "pending" and by_type["LEADS"].new_evidence
    assert by_type["RELATED_TO"].status == "conflict"
    assert by_type["SUPPORTS"].flag == "unsupported"


def test_resolver_layers_on_previous_version():
    prior = [{"id": "n_a", "type": "organization", "name": "Riverside Farmers Union", "aliases": ["RFU"],
              "status": "approved", "doc_ids": [], "evidence_ids": []}]
    r = Resolver(prior, [])
    ex = ChunkExtraction(entities=[ExtractedEntity(name="RFU", type="organization", aliases=[], description="",
                                                   quote="RFU")], relationships=[])
    r.ingest(_chunk("The RFU marched."), ex)
    nodes, _ = r.finalize()
    assert len(nodes) == 1 and nodes[0].status == "approved"


def test_heuristic_extractor_finds_candidates():
    text = (SEED / "Harbor City Labour Bulletin.txt").read_text()
    out = HeuristicExtractor().extract(text, {"person", "organization", "event", "policy", "location", "topic"})
    names = {e.name for e in out.entities}
    assert "Harbor Transit Workers Guild" in names and "Noor Haddad" in names
    assert all(r.predicate == "CO_OCCURS_WITH" for r in out.relationships)
