"""Reactions, the layered dynamic graph, graph events, snapshots, timeline and comparison."""
import uuid

import pytest
from sqlalchemy import create_engine, delete, select, text

from app.core.config import settings
from app.services import dynamic_graph as dg
from app.services import graph_store, llm, reaction_gen


def _db_ready() -> bool:
    try:
        with create_engine(settings.database_url).begin() as c:
            c.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        return True
    except Exception:
        return False


db_only = pytest.mark.skipif(not _db_ready(), reason="PostgreSQL with pgvector is not reachable")

QUOTE1 = "The Ministry of Water opposes accelerated filling of the Varn Dam before the summit."
QUOTE2 = "The Borovian Energy Authority operates the Varn Dam and plans to raise output."


def node(i, name, typ, status="approved", ev=(), conf=0.8):
    return {"id": i, "name": name, "type": typ, "status": status, "confidence": conf, "aliases": [], "description": f"{name} in the case.", "evidence_ids": list(ev)}


def edge(i, s, o, typ, status="approved", ev=(), conf=0.8):
    return {"id": i, "s": s, "o": o, "type": typ, "status": status, "confidence": conf, "directed": True, "statement": f"{typ} statement", "evidence_ids": list(ev)}


def fake_graph(ev1="ev_1", ev2="ev_2"):
    nodes = [node("n_gov", "Ministry of Water", "organization", ev=[ev1]), node("n_co", "Borovian Energy Authority", "organization", ev=[ev2]),
             node("n_off", "Dr. Amara Sel", "person", ev=[ev1]), node("n_media", "Northline Press", "organization"),
             node("n_dam", "Accelerated dam filling", "policy"), node("n_loc", "Varn Valley", "location"),
             node("n_pending", "Pending Group", "organization", status="pending"), node("n_rej", "Rejected Person", "person", status="rejected")]
    edges = [edge("e1", "n_gov", "n_dam", "OPPOSES", ev=[ev1]), edge("e2", "n_co", "n_dam", "OPERATES", ev=[ev2]), edge("e3", "n_off", "n_gov", "ADVISES", ev=[ev1]),
             edge("e4", "n_media", "n_dam", "REPORTS_ON"), edge("e5", "n_pending", "n_dam", "SUPPORTS", status="pending"), edge("e6", "n_rej", "n_dam", "OPPOSES", status="rejected"),
             edge("e7", "n_dam", "n_loc", "AFFECTS")]
    return nodes, edges


@pytest.fixture()
def world(monkeypatch):
    from fastapi.testclient import TestClient

    from app.core.db import SessionLocal
    from app.core.security import hash_password
    from app.main import app
    from app.models import (Case, DocumentChunk, Environment, Evidence, GraphVersion, ProcessingJob, SourceDocument, Tenant, TenantSettings, User, new_id)
    from app.services import workspace

    monkeypatch.setattr(settings, "llm_provider", "none")
    monkeypatch.setattr(settings, "celery_eager", True)
    monkeypatch.setattr(llm, "available", lambda: False)
    tag = uuid.uuid4().hex[:8]
    ids = {}
    with SessionLocal() as db:
        t = Tenant(name=f"D {tag}")
        t2 = Tenant(name=f"D2 {tag}")
        db.add_all([t, t2])
        db.flush()
        workspace.ensure_roles(db, t.id)
        workspace.ensure_roles(db, t2.id)
        u = User(tenant_id=t.id, name="Lead", email=f"lead-{tag}@test.local", role="Lead analyst", password_hash=hash_password("demo1234"))
        o = User(tenant_id=t2.id, name="Other", email=f"other-{tag}@test.local", role="Lead analyst", password_hash=hash_password("demo1234"))
        v = User(tenant_id=t.id, name="Viewer", email=f"viewer-{tag}@test.local", role="Viewer", password_hash=hash_password("demo1234"))
        db.add_all([u, o, v])
        db.flush()
        case = Case(tenant_id=t.id, owner_id=u.id, title="Varn Dam", research_question="How will actors respond to accelerated dam filling?", tags=[], extract_types=[])
        db.add(case)
        db.flush()
        gv = GraphVersion(case_id=case.id, number=1, status="approved", created_by="x", content_hash="h" + tag)
        draft = GraphVersion(case_id=case.id, number=2, status="draft", created_by="x")
        doc = SourceDocument(case_id=case.id, filename="briefing.md", kind="Markdown", media_type="text/markdown", size=10, checksum=tag, storage_path="x", text=QUOTE1 + " " + QUOTE2, uploaded_by="x")
        db.add_all([gv, draft, doc])
        db.flush()
        ch = DocumentChunk(document_id=doc.id, case_id=case.id, ordinal=0, page=1, text=QUOTE1 + " " + QUOTE2, char_start=0, char_end=len(QUOTE1 + " " + QUOTE2), token_count=30)
        db.add(ch)
        db.flush()
        ev1 = Evidence(id=new_id("ev"), case_id=case.id, document_id=doc.id, chunk_id=ch.id, page=1, quote=QUOTE1, char_start=0, char_end=len(QUOTE1))
        ev2 = Evidence(id=new_id("ev"), case_id=case.id, document_id=doc.id, chunk_id=ch.id, page=1, quote=QUOTE2, char_start=len(QUOTE1) + 1, char_end=len(QUOTE1) + 1 + len(QUOTE2))
        db.add_all([ev1, ev2])

        def ag(i, name, stance, node_id, kind="individual"):
            return {"id": f"ag{i}", "node_id": node_id, "name": name, "handle": f"@{name[:4].lower()}", "kind": kind, "entity_type": "person", "profession": "x", "interests": ["water"],
                    "persona": "", "facts": [], "stance": stance, "influence": 0.7, "activity": 0.95, "tone": "plain", "platforms": ["microblog", "forum"],
                    "synthetic": node_id is None, "speaks": True}
        agents = [ag(0, "Ministry of Water", -0.7, "n_gov", "institution"), ag(1, "Borovian Energy Authority", 0.8, "n_co", "institution"),
                  ag(2, "Dr. Amara Sel", 0.2, "n_off"), ag(3, "Synthetic Farmer", -0.3, None), ag(4, "Northline Press", 0.0, "n_media", "institution")]
        links = [{"id": "l1", "s": "ag0", "o": "ag2", "kind": "ally", "relation": "ADVISES", "weight": 0.6}]
        cfg = {"platforms": ["microblog", "forum"], "rounds": 12, "minutes_per_round": 60, "seed": 11, "llm_personas": 0, "llm_posts_per_round": 0, "inject_round": 3,
               "epsilon": 0.6, "mu": 0.2, "backfire": 0.04, "real_actors_context_only": False, "scenario_shock": 0.5, "snapshot_every": 4, "focus_name": "accelerated dam filling"}
        env = Environment(case_id=case.id, version_id=gv.id, name="E", status="ready", config=cfg, agents=agents, links=links, created_by="x",
                          seed_posts=[{"round": 0, "content": "Case sources describe the Varn Dam dispute.", "source": "case evidence"},
                                      {"round": 3, "content": "The authority announces accelerated filling.", "source": "scenario injection"}])
        db.add(env)
        db.commit()
        ids = {"tenant": t.id, "tenant2": t2.id, "case": case.id, "version": gv.id, "draft": draft.id, "env": env.id, "ev1": ev1.id, "ev2": ev2.id, "tag": tag,
               "users": [u.id, o.id, v.id]}
    nodes, edges = fake_graph(ids["ev1"], ids["ev2"])
    monkeypatch.setattr(graph_store, "read_version", lambda vid: (nodes, edges))
    client = TestClient(app)

    def login(prefix):
        r = client.post("/api/v1/auth/login", json={"email": f"{prefix}-{tag}@test.local", "password": "demo1234"})
        return {"Authorization": f"Bearer {r.json()['access_token']}"}

    def new_sim():
        from app.models import ProcessingJob as PJ
        from app.models import Simulation
        with SessionLocal() as db:
            env = db.get(Environment, ids["env"])
            sim = Simulation(case_id=ids["case"], environment_id=env.id, name="Run", status="queued", created_by="x",
                             config={"config": env.config, "agents": env.agents, "links": env.links, "seed_posts": env.seed_posts})
            db.add(sim)
            db.flush()
            job = PJ(tenant_id=ids["tenant"], case_id=ids["case"], kind="simulation", created_by="Tester", stats={"target_id": sim.id})
            db.add(job)
            db.flush()
            sim.job_id = job.id
            db.commit()
            return sim.id, job.id

    yield client, login("lead"), login("other"), login("viewer"), ids, new_sim
    with SessionLocal() as db:
        db.execute(text("DELETE FROM audit_events WHERE tenant_id IN (:a, :b)"), {"a": ids["tenant"], "b": ids["tenant2"]})
        db.execute(delete(Case).where(Case.tenant_id == ids["tenant"]))
        db.execute(delete(User).where(User.id.in_(ids["users"])))
        for tid in (ids["tenant"], ids["tenant2"]):
            db.execute(text("DELETE FROM roles WHERE tenant_id = :t"), {"t": tid})
            db.execute(delete(TenantSettings).where(TenantSettings.tenant_id == tid))
            db.execute(delete(Tenant).where(Tenant.id == tid))
        db.commit()


def run_sim(new_sim):
    from app.services.jobrunner import run_job
    sid, jid = new_sim()
    run_job(jid)
    return sid, jid


# ---------------------------------------------------------------- pure logic
def test_fold_is_deterministic_and_applies_events_in_order():
    sim = type("S", (), {"id": "s", "name": "n", "config": {"agents": [{"id": "a", "name": "A", "stance": 0.0}, {"id": "b", "name": "B", "stance": 0.1}]}})()
    evs = [{"after": {"edge": {"key": "LIKED:a>b", "s": "a", "o": "b", "kind": "LIKED", "strength": 1}}, "step": 1, "seq": 1, "graph_version": 1},
           {"after": {"edge": {"key": "LIKED:a>b", "s": "a", "o": "b", "kind": "LIKED", "strength": 2}, "agent": {"id": "a", "stance": 0.4}}, "step": 2, "seq": 2, "graph_version": 2},
           {"after": {"edge": {"key": "LIKED:a>b", "s": "a", "o": "b", "kind": "LIKED", "strength": 0}}, "step": 3, "seq": 3, "graph_version": 3}]
    one = dg.fold(dg.sim_base(sim), evs[:2])
    assert one["edges"]["LIKED:a>b"]["strength"] == 2 and one["agents"]["a"]["stance"] == 0.4 and one["seq"] == 2
    assert dg.fold(dg.sim_base(sim), evs) == dg.fold(dg.sim_base(sim), evs)
    assert "LIKED:a>b" not in dg.fold(dg.sim_base(sim), evs)["edges"]  # strength 0 removes the relationship


def test_diff_reports_added_removed_changed_per_layer():
    a = {"research": {"nodes": [{"id": "n1", "name": "X", "type": "organization", "status": "approved", "confidence": 0.8, "description": "", "evidence_ids": []}], "edges": [], "unavailable": False},
         "reactions": {"items": []}, "simulation": {"agents": {"g": {"name": "G", "stance": 0.0, "stance0": 0.0, "synthetic": False, "speaks": True, "node_id": None}}, "edges": {}, "statements": {}, "run_id": "s"}}
    b = {"research": a["research"], "reactions": {"items": [{"id": "rx1", "actor_id": "n1", "title": "T", "category": "support", "status": "generated", "confidence": 0.4, "edited": False}]},
         "simulation": {"agents": {"g": {"name": "G", "stance": 0.5, "stance0": 0.0, "synthetic": False, "speaks": True, "node_id": None}}, "edges": {}, "statements": {}, "run_id": "s"}}
    d = dg.diff(a, b)
    assert d["summary"]["research"] == {"added": 0, "removed": 0, "changed": 0}
    assert d["layers"]["reaction"]["nodes"]["added"][0]["id"] == "rx1"
    assert d["layers"]["simulation"]["nodes"]["changed"][0]["fields"]["stance"] == [0.0, 0.5]
    assert dg.diff(b, a)["layers"]["reaction"]["nodes"]["removed"][0]["id"] == "rx1"


def test_snapshot_integrity_check_detects_tampering():
    from app.models import GraphSnapshot
    state = {"research": {"nodes": [], "edges": []}, "reactions": {"items": []}, "simulation": None}
    snap = GraphSnapshot(state=state, content_hash=dg.hash_state(state))
    assert dg.verify(snap)
    snap.state = {**state, "reactions": {"items": [{"id": "rx_forged"}]}}  # a changed copy no longer matches its recorded hash
    assert not dg.verify(snap)


def test_every_graph_item_carries_layer_and_provenance():
    state = {"research": {"nodes": [{"id": "n1", "name": "X", "type": "person", "status": "approved", "confidence": 0.8, "description": "", "evidence_ids": []}], "edges": [], "unavailable": False,
                          "version_id": "v", "version_label": "v1", "content_hash": "h"},
             "reactions": {"items": [{"id": "rx1", "actor_id": "n1", "title": "T", "category": "support", "status": "generated", "confidence": 0.4, "edited": False}], "run_id": "r", "run_number": 1, "mode": "demo-rules"},
             "simulation": {"run_id": "s", "run_name": "n", "attempt": 1, "step": 0, "seq": 0, "graph_version": 0, "edges": {}, "statements": {},
                            "agents": {"a": {"name": "A", "stance": 0, "stance0": 0, "synthetic": True, "speaks": True, "node_id": "n1"}}}}
    g = dg.to_graph(state)
    prov = {n["layer"]: n["provenance"] for n in g["nodes"]}
    assert prov == {"research": "sourced", "reaction": "generated_hypothesis", "simulation": "simulation_generated"}
    assert {e["type"] for e in g["edges"]} == {"HYPOTHESIS_ABOUT", "SIMULATES"}
    assert all(n["id"].startswith("sim:") for n in g["nodes"] if n["layer"] == "simulation")  # simulation ids never collide with research ids


def test_select_actors_uses_only_approved_items_and_relevance():
    from types import SimpleNamespace
    nodes, edges = fake_graph()
    actors, issue = reaction_gen.select_actors(nodes, edges, SimpleNamespace(research_question="How will actors respond to accelerated dam filling?", objective="", title="Varn Dam"))
    names = [a["node"]["name"] for a in actors]
    assert issue == "Accelerated dam filling"
    assert "Pending Group" not in names and "Rejected Person" not in names  # unapproved extractions never reach reactions
    assert "Varn Valley" not in names and "Accelerated dam filling" not in names  # locations and the issue itself are not actors
    assert {"Ministry of Water", "Borovian Energy Authority", "Northline Press", "Dr. Amara Sel"} <= set(names)
    assert all(r["type"] != "SUPPORTS" for a in actors for r in a["relations"])  # the pending relationship is not used


def _actor():
    from types import SimpleNamespace
    nodes, edges = fake_graph()
    actors, issue = reaction_gen.select_actors(nodes, edges, SimpleNamespace(research_question="dam", objective="", title="t"))
    return next(a for a in actors if a["node"]["id"] == "n_gov"), issue


def test_validation_rejects_fabricated_quotes_and_unknown_context():
    a, issue = _actor()
    ev = {"ev_1": {"id": "ev_1", "quote": QUOTE1, "document": "d", "page": 1, "section": "", "support_type": "supports"}}
    base = {"title": "May push back on the plan", "description": "A plausible response that follows from the documented opposition to the plan.", "category": "opposition",
            "trigger": "Accelerated filling", "related_entity_ids": ["n_dam"], "evidence_ids": ["ev_1"], "reasoning": "Relies on the approved OPPOSES relationship and its source passage.",
            "confidence": 0.9, "assumptions": []}
    ok, why = reaction_gen.validate(base, a, ev, set(), issue)
    assert ok is not None and why is None
    quoted_real = {**base, "title": "Opposes the plan", "description": f"The passage says “{QUOTE1[:40]}” which supports a cautious reading of its position."}
    assert reaction_gen.validate(quoted_real, a, ev, set(), issue)[0] is not None
    fake = {**base, "title": "Says it will block it", "description": "The minister said “we will block this plan by any means necessary” according to the hypothesis."}
    d, why = reaction_gen.validate(fake, a, ev, set(), issue)
    assert d is None and "quotes text" in why
    assert reaction_gen.validate({**base, "related_entity_ids": ["zzz"], "evidence_ids": ["nope"]}, a, ev, set(), issue)[1].startswith("no graph context")
    assert reaction_gen.validate({**base, "category": "magic"}, a, ev, set(), issue)[1].startswith("schema")
    assert reaction_gen.validate(base, a, ev, {"may push back on the plan"}, issue)[1].startswith("duplicate")
    no_ev = reaction_gen.validate({**base, "evidence_ids": []}, a, ev, set(), issue)[0]
    assert no_ev.confidence <= 0.4  # no linked evidence caps confidence


def test_demo_rules_read_naturally_and_respect_relationship_direction():
    from types import SimpleNamespace
    a, issue = _actor()  # Ministry of Water: it OPPOSES the issue itself, and is the object of "Dr. Amara Sel ADVISES it"
    ev = {"ev_1": {"id": "ev_1", "quote": QUOTE1, "document": "d", "page": 1, "section": "", "support_type": "supports"}}
    drafts = reaction_gen.DemoRulesProvider().generate(a, issue, SimpleNamespace(), ev)
    assert len(drafts) == 2 and {d["category"] for d in drafts} == {"opposition", "concern"}
    for d in drafts:
        assert "response response" not in d["description"] and " a operational" not in d["description"]
        assert reaction_gen.ReactionDraft.model_validate(d)  # the demo output passes the same schema as model output
    own = next(d for d in drafts if d["category"] == "opposition")
    assert own["title"] == f"May push back on {issue}" and own["evidence_ids"] == ["ev_1"]
    incoming = next(d for d in drafts if d["category"] == "concern")
    assert incoming["title"].startswith("May react to Dr. Amara Sel") and "Dr. Amara Sel advises Ministry of Water" in incoming["description"]
    assert not any("negotiate over Dr. Amara Sel" in d["title"] for d in drafts)  # an advisor is not a negotiation topic


def test_labels_cover_inference_synthesis_demo_and_real_people():
    a, _ = _actor()
    d = reaction_gen.ReactionDraft(title="May push back", description="x" * 30, category="opposition", trigger="trigger", related_entity_ids=["n_dam"], reasoning="y" * 30,
                                   confidence=0.3, assumptions=[{"text": "Inferred from the relationship type", "basis": "model_inferred"}])
    assumptions, warnings = reaction_gen.labelled(d, a, "demo-rules")
    assert {x["basis"] for x in assumptions} == {"model_inferred", "synthetic"}
    assert any("Demo output" in w for w in warnings) and any("inferred" in w for w in warnings) and any("No source passage" in w for w in warnings)
    person = {"node": {"type": "person"}}
    assert any("real person" in w for w in reaction_gen.labelled(d, person, "llm")[1])


# ---------------------------------------------------------------- reactions (database)
@db_only
def test_reaction_run_creates_labelled_hypotheses_from_the_approved_graph(world):
    client, h, _, hv, ids, _ = world
    r = client.post(f"/api/v1/cases/{ids['case']}/reaction-runs", headers=h, json={})
    assert r.status_code == 202, r.text
    page = client.get(f"/api/v1/cases/{ids['case']}/reactions", headers=h).json()
    assert page["run"]["status"] == "ready" and page["run"]["mode"] == "demo-rules" and page["run"]["demo"] is True
    assert page["total"] >= 4
    actors = {x["actor_name"] for x in page["items"]}
    assert "Pending Group" not in actors and "Rejected Person" not in actors
    for x in page["items"]:
        assert x["provenance"] == "generated_hypothesis" and x["label"].startswith("AI-generated hypothesis")
        assert x["status"] == "generated" and x["generator"]["mode"] == "demo-rules" and x["generator"]["template_version"] == reaction_gen.TEMPLATE_VERSION
        assert {a["basis"] for a in x["assumptions"]} >= {"synthetic"} and any("Demo output" in w for w in x["warnings"])
        assert set(x["evidence_ids"]) <= {ids["ev1"], ids["ev2"]} and x["related"]
    sel = next(x for x in page["items"] if x["actor_name"] == "Ministry of Water")
    assert ids["ev1"] in sel["evidence_ids"] or sel["evidence_ids"] == []
    person = [x for x in page["items"] if x["actor_type"] == "person"]
    assert person and all(any("real person" in w for w in x["warnings"]) for x in person)
    detail = client.get(f"/api/v1/reactions/{sel['id']}", headers=hv).json()
    assert detail["reaction"]["id"] == sel["id"] and detail["basis"]["synthetic"] and detail["run"]["id"] == page["run"]["id"]
    if detail["evidence"]:
        assert detail["evidence"][0]["document"] == "briefing.md" and detail["evidence"][0]["quote"] in (QUOTE1, QUOTE2)
    # a "reactions generated" snapshot was taken
    snaps = client.get(f"/api/v1/cases/{ids['case']}/snapshots", headers=h).json()["items"]
    assert [s["reason"] for s in snaps] == ["reactions_generated"]


@db_only
def test_rerun_adds_a_new_run_and_keeps_history_and_unapproved_graphs_are_refused(world):
    client, h, _, _, ids, _ = world
    first = client.post(f"/api/v1/cases/{ids['case']}/reaction-runs", headers=h, json={}).json()
    page1 = client.get(f"/api/v1/cases/{ids['case']}/reactions", headers=h).json()
    ids1 = {x["id"] for x in page1["items"]}
    client.patch(f"/api/v1/reactions/{page1['items'][0]['id']}", headers=h, json={"status": "selected"})
    second = client.post(f"/api/v1/cases/{ids['case']}/reaction-runs", headers=h, json={"note": "second pass"}).json()
    assert second["number"] == first["number"] + 1 and second["id"] != first["id"]
    runs = client.get(f"/api/v1/cases/{ids['case']}/reaction-runs", headers=h).json()
    assert [r["number"] for r in runs] == [2, 1]
    old = client.get(f"/api/v1/cases/{ids['case']}/reactions?run_id={first['id']}", headers=h).json()
    assert {x["id"] for x in old["items"]} == ids1  # run 1 is untouched
    assert next(x for x in old["items"] if x["id"] == page1["items"][0]["id"])["status"] == "selected"
    new = client.get(f"/api/v1/cases/{ids['case']}/reactions", headers=h).json()
    assert new["run"]["id"] == second["id"] and not ids1 & {x["id"] for x in new["items"]}
    refused = client.post(f"/api/v1/cases/{ids['case']}/reaction-runs", headers=h, json={"version_id": ids["draft"]})
    assert refused.status_code == 409 and "not approved" in refused.json()["detail"]


@db_only
def test_review_edit_select_exclude_and_filters(world):
    client, h, _, hv, ids, _ = world
    client.post(f"/api/v1/cases/{ids['case']}/reaction-runs", headers=h, json={})
    items = client.get(f"/api/v1/cases/{ids['case']}/reactions", headers=h).json()["items"]
    r = items[0]
    edited = client.patch(f"/api/v1/reactions/{r['id']}", headers=h, json={"title": "A rewritten title", "category": "concern"}).json()
    assert edited["edited"] is True and edited["status"] == "reviewed" and edited["category"] == "concern"
    assert client.patch(f"/api/v1/reactions/{r['id']}", headers=hv, json={"status": "excluded"}).status_code == 403  # viewers cannot review
    bulk = client.post(f"/api/v1/cases/{ids['case']}/reactions/bulk", headers=h, json={"ids": [items[1]["id"], items[2]["id"]], "status": "excluded"})
    assert bulk.json()["updated"] == 2
    ex = client.get(f"/api/v1/cases/{ids['case']}/reactions?status=excluded", headers=h).json()
    assert ex["total"] == 2
    assert client.get(f"/api/v1/cases/{ids['case']}/reactions?category=concern&limit=1", headers=h).json()["items"][0]["id"] == r["id"]
    assert client.get(f"/api/v1/cases/{ids['case']}/reactions?min_confidence=0.99", headers=h).json()["total"] == 0
    assert client.get(f"/api/v1/cases/{ids['case']}/reactions?q=rewritten", headers=h).json()["total"] == 1
    page = client.get(f"/api/v1/cases/{ids['case']}/reactions?limit=2&offset=2", headers=h).json()
    assert len(page["items"]) <= 2 and page["offset"] == 2
    assert client.post(f"/api/v1/cases/{ids['case']}/reactions/bulk", headers=h, json={"ids": ["rx_nope"], "status": "selected"}).status_code == 404
    audit = client.get("/api/v1/audit?limit=50", headers=h).json()
    assert {"reaction.run", "reaction.edit", "reaction.status"} <= {a["action"] for a in audit}


@db_only
def test_approval_takes_a_snapshot_and_starts_reactions_once(world, monkeypatch):
    client, h, _, _, ids, _ = world
    from app.services import versions

    def fake_approve(db, case, v, by):
        v.status = "approved"
        return v, None
    monkeypatch.setattr(versions, "approve", fake_approve)
    r = client.post(f"/api/v1/cases/{ids['case']}/graph/versions/{ids['version']}/approve", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["snapshot_id"] and body["reaction_run_id"]
    assert client.get(f"/api/v1/cases/{ids['case']}/reactions", headers=h).json()["total"] > 0  # generated automatically
    again = client.post(f"/api/v1/cases/{ids['case']}/graph/versions/{ids['version']}/approve", headers=h).json()
    assert again["reaction_run_id"] is None  # idempotent: no second run for the same version
    reasons = [s["reason"] for s in client.get(f"/api/v1/cases/{ids['case']}/snapshots", headers=h).json()["items"]]
    assert reasons[0] == "research_approved" and "reactions_generated" in reasons


# ---------------------------------------------------------------- the evolving graph (database)
@db_only
def test_simulation_records_events_and_snapshots_and_never_touches_research(world):
    client, h, _, _, ids, new_sim = world
    client.post(f"/api/v1/cases/{ids['case']}/reaction-runs", headers=h, json={})
    sid, _ = run_sim(new_sim)
    ev = client.get(f"/api/v1/simulations/{sid}/graph-events?limit=500", headers=h).json()
    assert ev["total"] > 10
    kinds = {e["event_type"] for e in ev["items"]}
    assert {"STATEMENT_PUBLISHED", "POSITION_CHANGED"} <= kinds and kinds <= set(dg.EVENT_TYPES)
    for e in ev["items"]:
        assert e["provenance"] == "simulation_generated" and e["run_id"] == sid and e["case_id"] == ids["case"] and e["attempt"] == 1 and e["graph_version"] >= 1
    seqs = [e["seq"] for e in ev["items"]]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)
    pos = next(e for e in ev["items"] if e["event_type"] == "POSITION_CHANGED")
    assert pos["before"]["stance"] != pos["after"]["agent"]["stance"] and pos["trigger_event_id"] is None or pos["trigger_event_id"]
    reasons = [s["reason"] for s in client.get(f"/api/v1/cases/{ids['case']}/snapshots?simulation_id={sid}", headers=h).json()["items"]]
    assert reasons[0] == "simulation_start" and reasons[-1] == "simulation_complete" and reasons.count("checkpoint") == 3  # after rounds 3, 7 and 11
    # research facts are identical in the live graph before and after the run, and the simulation layer is separate
    g = client.get(f"/api/v1/cases/{ids['case']}/dynamic-graph", headers=h).json()
    research = [n for n in g["nodes"] if n["layer"] == "research"]
    assert {n["id"] for n in research} == {"n_gov", "n_co", "n_off", "n_media", "n_dam", "n_loc"}
    assert all(n["provenance"] == "sourced" and n["status"] in ("approved", "manual") for n in research)
    assert any(n["layer"] == "simulation" and n["provenance"] == "simulation_generated" for n in g["nodes"])
    assert any(n["layer"] == "reaction" and n["provenance"] == "generated_hypothesis" for n in g["nodes"])
    first, last = [s for s in client.get(f"/api/v1/cases/{ids['case']}/snapshots?simulation_id={sid}", headers=h).json()["items"]][0::len(reasons) - 1]
    d = client.get(f"/api/v1/cases/{ids['case']}/snapshots/compare?a={first['id']}&b={last['id']}", headers=h).json()
    assert d["summary"]["research"] == {"added": 0, "removed": 0, "changed": 0}
    assert d["summary"]["simulation"]["added"] > 0 and d["summary"]["simulation"]["changed"] > 0
    assert any("stance" in c["fields"] for c in d["layers"]["simulation"]["nodes"]["changed"])


@db_only
def test_snapshots_are_immutable_and_historical_views_do_not_change(world):
    client, h, _, _, ids, new_sim = world
    sid, _ = run_sim(new_sim)
    snaps = client.get(f"/api/v1/cases/{ids['case']}/snapshots?simulation_id={sid}", headers=h).json()["items"]
    mid = snaps[1]
    before = client.get(f"/api/v1/cases/{ids['case']}/dynamic-graph?snapshot_id={mid['id']}&statements=true", headers=h).json()
    assert before["view"]["mode"] == "snapshot" and before["view"]["snapshot"]["integrity"] == "verified"
    # more simulation activity after the snapshot: an external event and a manual checkpoint
    agents = [a["id"] for a in client.get(f"/api/v1/simulations/{sid}", headers=h).json()["agents"]]
    r = client.post(f"/api/v1/simulations/{sid}/graph-events", headers=h, json={"events": [{
        "event_type": "POSITION_CHANGED", "step": 99, "actor_ids": [agents[0]], "description": "late change", "after": {"agent": {"id": agents[0], "stance": 0.99}}}]})
    assert r.status_code == 201, r.text
    manual = client.post(f"/api/v1/cases/{ids['case']}/snapshots", headers=h, json={"note": "after the late change", "simulation_id": sid}).json()
    after = client.get(f"/api/v1/cases/{ids['case']}/dynamic-graph?snapshot_id={mid['id']}&statements=true", headers=h).json()
    assert after["nodes"] == before["nodes"] and after["edges"] == before["edges"]  # history did not move
    assert client.get(f"/api/v1/snapshots/{mid['id']}", headers=h).json()["content_hash"] == mid["content_hash"]
    live = client.get(f"/api/v1/cases/{ids['case']}/dynamic-graph?simulation_id={sid}", headers=h).json()
    assert live["view"]["mode"] == "live" and next(n for n in live["nodes"] if n["id"] == f"sim:{agents[0]}")["stance"] == 0.99
    d = client.get(f"/api/v1/cases/{ids['case']}/snapshots/compare?a={mid['id']}&b=live&simulation_id={sid}", headers=h).json()
    assert d["b"]["id"] == "live" and d["summary"]["simulation"]["changed"] > 0
    assert manual["reason"] == "manual" and manual["parent_id"] == snaps[-1]["id"] and manual["number"] == snaps[-1]["number"] + 1
    # there is no way to edit or delete a snapshot through the API
    assert client.patch(f"/api/v1/snapshots/{mid['id']}", headers=h, json={"note": "x"}).status_code == 405
    assert client.delete(f"/api/v1/snapshots/{mid['id']}", headers=h).status_code == 405


@db_only
def test_external_events_are_validated_all_or_nothing_and_cannot_write_research(world):
    client, h, _, hv, ids, new_sim = world
    sid, _ = run_sim(new_sim)
    total = client.get(f"/api/v1/simulations/{sid}/graph-events", headers=h).json()["total"]
    good = {"event_type": "ALLIANCE_FORMED", "step": 50, "actor_ids": ["ag0", "ag2"], "description": "alliance",
            "after": {"edge": {"key": "ALLIED_WITH:ag0>ag2", "s": "ag0", "o": "ag2", "kind": "ALLIED_WITH", "strength": 1}}}
    bad = {"event_type": "RELATIONSHIP_FORMED", "step": 50, "actor_ids": ["ghost"], "after": {"edge": {"key": "k", "s": "ghost", "o": "ag2", "kind": "LIKED", "strength": 1}}}
    r = client.post(f"/api/v1/simulations/{sid}/graph-events", headers=h, json={"events": [good, bad]})
    assert r.status_code == 422 and "ghost" in r.json()["detail"]
    assert client.get(f"/api/v1/simulations/{sid}/graph-events", headers=h).json()["total"] == total  # nothing was stored
    research = {"event_type": "RELATIONSHIP_FORMED", "step": 1, "after": {"research": {"id": "e1", "status": "rejected"}}}
    assert client.post(f"/api/v1/simulations/{sid}/graph-events", headers=h, json={"events": [research]}).status_code == 422
    assert client.post(f"/api/v1/simulations/{sid}/graph-events", headers=h, json={"events": [{**good, "event_type": "MAGIC"}]}).status_code == 422
    assert client.post(f"/api/v1/simulations/{sid}/graph-events", headers=hv, json={"events": [good]}).status_code == 403
    ok = client.post(f"/api/v1/simulations/{sid}/graph-events", headers=h, json={"events": [good]})
    assert ok.status_code == 201 and ok.json()["events"][0]["provenance"] == "simulation_generated"
    g = client.get(f"/api/v1/cases/{ids['case']}/dynamic-graph?simulation_id={sid}", headers=h).json()
    assert any(e["type"] == "ALLIED_WITH" for e in g["edges"])
    assert {n["id"] for n in g["nodes"] if n["layer"] == "research"} == {"n_gov", "n_co", "n_off", "n_media", "n_dam", "n_loc"}


@db_only
def test_triggered_actions_append_graph_events(world):
    client, h, _, _, ids, new_sim = world
    sid, _ = run_sim(new_sim)
    posts = client.get(f"/api/v1/simulations/{sid}/events", headers=h).json()
    posts = posts if isinstance(posts, list) else posts.get("events", posts)
    target = next(p for p in posts if p["action"] == "CREATE_POST" and p["agent_id"] != "src")
    actor = next(a for a in ("ag0", "ag1", "ag2", "ag3", "ag4") if a != target["agent_id"])
    n0 = client.get(f"/api/v1/simulations/{sid}/graph-events?limit=1", headers=h).json()["total"]
    r = client.post(f"/api/v1/simulations/{sid}/actions", headers=h, json={"agent_id": actor, "action": "CREATE_COMMENT", "target_id": target["id"], "content": "I disagree.", "react": True})
    assert r.status_code == 201, r.text
    ev = client.get(f"/api/v1/simulations/{sid}/graph-events?limit=500", headers=h).json()
    assert ev["total"] > n0
    new = ev["items"][n0:]
    assert any(e["event_type"] == "RESPONDED_TO" and actor in e["actor_ids"] for e in new)
    detail = client.get(f"/api/v1/graph-events/{next(e for e in new if e['event_type'] == 'RESPONDED_TO')['id']}", headers=h).json()
    assert detail["trigger"]["action"] == "CREATE_COMMENT" and "not a real-world event" in detail["label"]


@db_only
def test_a_retried_run_opens_a_new_attempt_and_keeps_the_old_events(world):
    client, h, _, _, ids, new_sim = world
    from app.core.db import SessionLocal
    from app.models import GraphEvent, ProcessingJob, Simulation
    from app.services.jobrunner import run_job
    sid, jid = run_sim(new_sim)
    with SessionLocal() as db:
        n1 = db.scalar(text("SELECT count(*) FROM graph_events WHERE run_id = :s AND attempt = 1"), {"s": sid}) if False else len(list(db.scalars(select(GraphEvent).where(GraphEvent.run_id == sid, GraphEvent.attempt == 1))))
        db.get(Simulation, sid).status = "queued"
        j = db.get(ProcessingJob, jid)
        j.status, j.progress = "queued", 0
        db.commit()
    run_job(jid)
    with SessionLocal() as db:
        a1 = len(list(db.scalars(select(GraphEvent).where(GraphEvent.run_id == sid, GraphEvent.attempt == 1))))
        a2 = len(list(db.scalars(select(GraphEvent).where(GraphEvent.run_id == sid, GraphEvent.attempt == 2))))
    assert a1 == n1 and a2 > 0  # the first attempt's history is still there
    tl = client.get(f"/api/v1/cases/{ids['case']}/timeline?simulation_id={sid}", headers=h).json()
    assert tl["simulation"]["attempt"] == 2 and all(i["event"]["attempt"] == 2 for i in tl["items"] if i["kind"] == "event")


@db_only
def test_timeline_filters_paginates_and_summarises_steps(world):
    client, h, _, _, ids, new_sim = world
    sid, _ = run_sim(new_sim)
    tl = client.get(f"/api/v1/cases/{ids['case']}/timeline?simulation_id={sid}&limit=1000", headers=h).json()
    kinds = {i["kind"] for i in tl["items"]}
    assert kinds == {"event", "snapshot"} and tl["steps"] and tl["agents"] and "POSITION_CHANGED" in tl["event_types"]
    assert [s["step"] for s in tl["steps"]] == sorted(s["step"] for s in tl["steps"])
    assert any(s["snapshot_ids"] for s in tl["steps"])
    only = client.get(f"/api/v1/cases/{ids['case']}/timeline?simulation_id={sid}&event_type=POSITION_CHANGED&limit=1000", headers=h).json()
    assert {i["event"]["event_type"] for i in only["items"] if i["kind"] == "event"} == {"POSITION_CHANGED"}
    who = client.get(f"/api/v1/cases/{ids['case']}/timeline?simulation_id={sid}&agent_id=ag1&limit=1000", headers=h).json()
    assert all("ag1" in i["event"]["actor_ids"] for i in who["items"] if i["kind"] == "event")
    p1 = client.get(f"/api/v1/cases/{ids['case']}/timeline?simulation_id={sid}&limit=5&offset=0", headers=h).json()
    p2 = client.get(f"/api/v1/cases/{ids['case']}/timeline?simulation_id={sid}&limit=5&offset=5", headers=h).json()
    assert len(p1["items"]) == 5 and p1["total"] == tl["total"] and p1["items"] != p2["items"]
    assert client.get(f"/api/v1/cases/{ids['case']}/timeline?event_type=NOPE", headers=h).status_code == 422
    assert client.get(f"/api/v1/cases/{ids['case']}/dynamic-graph?layers=research,nope", headers=h).status_code == 422
    only_research = client.get(f"/api/v1/cases/{ids['case']}/dynamic-graph?layers=research", headers=h).json()
    assert {n["layer"] for n in only_research["nodes"]} <= {"research"} and all(e["layer"] == "research" for e in only_research["edges"])


@db_only
def test_entity_context_links_reactions_and_events_to_a_research_entity(world):
    client, h, _, _, ids, new_sim = world
    client.post(f"/api/v1/cases/{ids['case']}/reaction-runs", headers=h, json={})
    run_sim(new_sim)
    ctx = client.get(f"/api/v1/cases/{ids['case']}/graph-entity/n_gov", headers=h).json()
    assert ctx["reactions"] and all(r["actor_id"] == "n_gov" for r in ctx["reactions"])
    assert ctx["events"] and all("ag0" in e["actor_ids"] for e in ctx["events"])


@db_only
def test_other_tenants_cannot_see_reactions_snapshots_or_the_graph(world):
    client, h, other, _, ids, new_sim = world
    client.post(f"/api/v1/cases/{ids['case']}/reaction-runs", headers=h, json={})
    sid, _ = run_sim(new_sim)
    snap = client.get(f"/api/v1/cases/{ids['case']}/snapshots", headers=h).json()["items"][0]
    rx = client.get(f"/api/v1/cases/{ids['case']}/reactions", headers=h).json()["items"][0]
    for path in (f"/cases/{ids['case']}/dynamic-graph", f"/cases/{ids['case']}/reactions", f"/cases/{ids['case']}/reaction-runs", f"/cases/{ids['case']}/snapshots",
                 f"/cases/{ids['case']}/timeline", f"/snapshots/{snap['id']}", f"/reactions/{rx['id']}", f"/simulations/{sid}/graph-events",
                 f"/cases/{ids['case']}/snapshots/compare?a={snap['id']}&b=live"):
        assert client.get("/api/v1" + path, headers=other).status_code == 404, path
    assert client.patch(f"/api/v1/reactions/{rx['id']}", headers=other, json={"status": "excluded"}).status_code == 404
    assert client.post(f"/api/v1/cases/{ids['case']}/snapshots", headers=other, json={}).status_code == 404
    assert client.post(f"/api/v1/cases/{ids['case']}/reaction-runs", headers=other, json={}).status_code == 404
    assert client.get(f"/api/v1/cases/{ids['case']}/dynamic-graph").status_code == 401


# ---------------------------------------------------------------- chat when the embedding model cannot load
@db_only
def test_graph_chat_explains_a_missing_embedding_model_and_other_chats_still_work(world, monkeypatch):
    from app.services import embeddings, interaction
    client, h, _, _, ids, new_sim = world
    sid, _ = run_sim(new_sim)

    def broken():
        raise OSError("no network for the first-use download")
    monkeypatch.setattr(settings, "embedding_provider", "fastembed")
    monkeypatch.setattr(embeddings, "_fastembed", broken)
    monkeypatch.setattr(interaction.llm, "available", lambda: False)  # offline answers: no model server needed for this test
    conv = client.post(f"/api/v1/cases/{ids['case']}/conversations", headers=h, json={"target": "graph"}).json()
    r = client.post(f"/api/v1/conversations/{conv['id']}/messages", headers=h, json={"content": "Who opposes the protocol?"})
    assert r.status_code == 503  # not a bare 500
    detail = r.json()["detail"]
    assert "embedding model" in detail and "EMBEDDING_PROVIDER=hash" in detail and "first" in detail
    assert embeddings.status()["ok"] is False and "failed to load" in embeddings.status()["detail"]
    st = client.get("/api/v1/admin/settings", headers=h)  # the System panel reports it too (admin only; the lead analyst is not one)
    assert st.status_code == 403
    agent = client.post(f"/api/v1/cases/{ids['case']}/conversations", headers=h, json={"target": "agent:ag0", "simulation_id": sid}).json()
    ok = client.post(f"/api/v1/conversations/{agent['id']}/messages", headers=h, json={"content": "What is your position?"})
    assert ok.status_code == 200 and "offline answer" in ok.text  # agent chat does not need embeddings and still answers
    embeddings._state.update(loaded=False, error=None)  # do not leak the simulated failure into other tests
