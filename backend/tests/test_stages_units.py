from types import SimpleNamespace

import pytest

from app.services import llm, simulation
from app.services.extraction import SpacyExtractor, spacy_ready
from app.services.ontology import ENTITY_TYPES

needs_spacy = pytest.mark.skipif(not spacy_ready(), reason="spaCy model not installed")


@needs_spacy
def test_spacy_typed_relations_from_grammar():
    x = SpacyExtractor()
    out = x.extract("Thousands joined the Kesh Valley Farmers' March, organised by the Riverside Farmers Union. "
                    "The Borovian Energy Authority operates the Varn Dam.", set(ENTITY_TYPES))
    typed = {(r.subject, r.predicate, r.object) for r in out.relationships if r.predicate != "CO_OCCURS_WITH"}
    assert ("Riverside Farmers Union", "ORGANIZED", "Kesh Valley Farmers' March") in typed
    assert ("Borovian Energy Authority", "OPERATES", "Varn Dam") in typed
    text = out.relationships[0].quote + " " + out.relationships[-1].quote
    assert all(r.quote and r.quote in text for r in out.relationships)  # quotes are verbatim sentences


@needs_spacy
def test_spacy_negation_marks_denied():
    out = SpacyExtractor().extract("The Ministry of Water does not support the Basin Allocation Accord.", set(ENTITY_TYPES))
    rel = next(r for r in out.relationships if r.predicate == "SUPPORTS")
    assert rel.assertion == "denied"


class _Db:
    def add(self, _row):
        pass


def _sim(seed: int = 7) -> SimpleNamespace:
    agents = [{"id": f"a{i}", "name": f"Agent {i}", "handle": f"@a{i}", "stance": s, "influence": 0.5 + i / 10,
               "activity": 0.9, "interests": ["water"], "persona": "", "profession": "x", "tone": "plain", "facts": [],
               "platforms": ["microblog", "forum"]} for i, s in enumerate([0.8, 0.6, -0.7, -0.5, 0.0])]
    links = [{"s": "a0", "o": "a1", "kind": "ally"}, {"s": "a2", "o": "a3", "kind": "ally"}, {"s": "a0", "o": "a2", "kind": "opponent"}]
    cfg = {"seed": seed, "platforms": ["microblog", "forum"], "rounds": 6, "minutes_per_round": 60, "epsilon": 0.6,
           "mu": 0.2, "backfire": 0.04, "llm_posts_per_round": 0, "focus_name": "the Accord"}
    return SimpleNamespace(id="sim_t", config={"config": cfg, "agents": agents, "links": links,
                                               "seed_posts": [{"round": 0, "content": "News", "source": "case evidence"}]})


def _run(seed: int) -> list[dict]:
    eng = simulation.Engine(SimpleNamespace(db=_Db(), log=lambda *a, **k: None), _sim(seed))
    return [eng.round(r) for r in range(7)]


def test_simulation_is_seeded_and_bounded(monkeypatch):
    monkeypatch.setattr(llm, "available", lambda: False)
    a, b = _run(7), _run(7)
    assert a == b  # same environment + seed reproduces exactly
    assert _run(8) != a
    for m in a:
        assert -1 <= m["mean_stance"] <= 1 and 0 <= m["support"] <= 1 and 0 <= m["oppose"] <= 1
        assert m["active"] <= 5


def test_graphrag_drops_invented_citations(monkeypatch):
    from app.services import graphrag
    ctx = {"chunks": [{"chunk_id": "k1", "document_id": "d", "document": "D", "page": 1, "section": "s", "text": "t", "score": 1}],
           "relationships": [], "seed_ids": [], "nodes": []}
    monkeypatch.setattr(graphrag, "retrieve", lambda *a, **k: ctx)
    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "structured", lambda *a, **k: graphrag.GroundedAnswer(
        answer="x [S1][S9]", cited_sources=["S1", "[S9]"], cited_relationships=["R3"], support="partial", caveats=""))
    out = graphrag.answer(None, SimpleNamespace(label="v1"), "q")
    assert out["cited_sources"] == ["S1"] and out["cited_relationships"] == []


def test_markdown_links_and_anchors_are_stripped():
    from app.services.parsing import parse_text
    doc = parse_text(b"# Sources\n\n<a id=\"s05\"></a>**S05.** 2024 VOA: [Djibouti Tadjoura offer](https://example.org/x) ([S05](#s05)).",
                     markdown=True)
    assert "](" not in doc.text and "<a" not in doc.text and "**" not in doc.text
    assert "Djibouti Tadjoura offer" in doc.text


def test_persona_import_parses_case_study_lines():
    from app.services.personas import parse, to_agents
    text = ("Topic codes: T01 commerce; T02 sovereignty\n"
            "- **SIM06 — Somali civil society observer (Somalia; sovereignty focused)**: “Agreements need to respect "
            "Somalia’s territorial integrity.” [simulation topic T02]\n"
            "- SIM04 - Diaspora engineer in Washington DC (Ethiopian diaspora; government-aligned) [stance +0.6]: "
            "“Investment will follow\n stability.” [simulation topic T01]")
    found, skipped = parse(text)
    assert not skipped and [p["pid"] for p in found] == ["SIM06", "SIM04"]
    assert found[0]["stance"] == -0.5 and found[0]["topic"] == "sovereignty"
    assert found[1]["stance"] == 0.6 and "stability" in found[1]["quote"]
    agents = to_agents(found, ["microblog"], set())
    assert all(a["synthetic"] and a["speaks"] and "Not a real person" in a["bio"] for a in agents)


def test_scenario_push_moves_stance_in_its_direction(monkeypatch):
    monkeypatch.setattr(llm, "available", lambda: False)

    def mean_after(shock: float) -> float:
        sim = _sim(7)
        sim.config["config"].update(scenario_shock=shock, inject_round=1)
        sim.config["seed_posts"].append({"round": 1, "content": "Hypothetical event", "source": "scenario injection"})
        eng = simulation.Engine(SimpleNamespace(db=_Db(), log=lambda *a, **k: None), sim)
        return [eng.round(r) for r in range(7)][-1]["mean_stance"]

    assert mean_after(0.8) > mean_after(0.0) > mean_after(-0.8)


def test_trigger_repost_and_reaction_graph():
    """An analyst-triggered repost lands on the target, bumps its counter and shows up in the cascade graph."""
    from app.models import SimEvent, Simulation
    from app.services import reactions

    agents = [{"id": f"a{i}", "name": f"Persona {i}", "stance": s, "influence": 0.5, "activity": 0.9, "interests": ["water"], "persona": "",
               "profession": "x", "synthetic": True, "speaks": True} for i, s in enumerate([0.6, 0.5, -0.6, 0.0])]
    sim = Simulation(id="sim_x", case_id="c", environment_id="e", name="t", created_by="u", status="done", stats={"series": {a["id"]: [a["stance"]] for a in agents}},
                     config={"config": {"epsilon": 0.6, "mu": 0.2, "backfire": 0.04, "focus_name": "the Accord"}, "agents": agents, "links": []})
    post = SimEvent(id="se_root", simulation_id="sim_x", round=1, platform="microblog", agent_id="a0", agent_name="Persona 0", action="CREATE_POST",
                    content="Backing the Accord.", stance=0.6, likes=0, replies=0, reposts=0, generated_by="template")

    class FakeDb:
        def __init__(self): self.rows = [post]
        def add(self, r): self.rows.append(r)
        def flush(self): pass
        def scalars(self, _q): return iter(sorted(self.rows, key=lambda e: e.round))

    db = FakeDb()
    created = reactions.trigger(db, sim, agent_id="a1", action="REPOST", platform="microblog", target=post, content="", react=False, use_llm=False, actor="me")
    assert created[0].action == "REPOST" and created[0].content == post.content and post.reposts == 1
    g = reactions.cascade_graph(db, sim, ["se_root"])
    assert {"source": created[0].id, "target": "se_root", "type": "REPOST_OF"} in g["links"]
    assert any(n["id"] == "a1" and n["type"] == "persona" for n in g["nodes"])
    created2 = reactions.trigger(db, sim, agent_id="a0", action="CREATE_POST", platform="microblog", target=None, content="", react=True, use_llm=False, actor="me")
    assert created2[0].generated_by.startswith("analyst-trigger") and all(e.round > created[0].round for e in created2)
    assert all(e.agent_id != "a0" for e in created2[1:])  # reactions come from other personas
