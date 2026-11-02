"""Agent behaviour profiles, reply-back in the engine, and the targeted response to a triggered comment."""
import random
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, delete, text

from app.core.config import settings
from app.services import behavior, llm, simulation


def agent(**kw):
    return {"id": "a", "name": "A", "kind": "individual", "stance": 0.0, **kw}


def test_defaults_follow_kind_and_stance():
    assert behavior.resolve(agent(kind="state"))["preset"] == "broadcaster"
    assert behavior.resolve(agent(kind="institution"))["preset"] == "broadcaster"
    assert behavior.resolve(agent(stance=0.8))["preset"] == "debater"
    assert behavior.resolve(agent(stance=0.1))["preset"] == "balanced"


def test_stored_values_win_and_are_clamped():
    r = behavior.resolve(agent(behavior={"preset": "lurker", "responsiveness": 7, "reply_style": "nonsense",
                                         "mix": {"post": 1, "comment": 1}}))
    assert r["preset"] == "lurker" and r["responsiveness"] == 1.0
    assert r["reply_style"] == "acknowledge"  # invalid style falls back to the preset's
    assert r["mix"]["post"] == r["mix"]["comment"] == 0.5 and r["mix"]["like"] == 0  # normalised
    assert behavior.clean(agent(behavior={"preset": "nope"}))["preset"] == "balanced"


def test_action_weights_respect_the_platform():
    micro = dict(behavior.action_weights(agent(), "microblog"))
    forum = dict(behavior.action_weights(agent(), "forum"))
    assert "DISLIKE_POST" not in micro and "REPOST" in micro and "FOLLOW" in micro
    assert "REPOST" not in forum and "FOLLOW" not in forum and "DISLIKE_POST" in forum
    for w in (micro, forum):
        assert sum(w.values()) == pytest.approx(1.0) and w["DO_NOTHING"] == pytest.approx(behavior.IDLE)


def test_a_lurker_mostly_likes_and_a_broadcaster_mostly_posts():
    lurk = dict(behavior.action_weights(agent(behavior={"preset": "lurker"}), "microblog"))
    cast = dict(behavior.action_weights(agent(behavior={"preset": "broadcaster"}), "microblog"))
    assert max(lurk, key=lurk.get) == "LIKE_POST" and max(cast, key=cast.get) == "CREATE_POST"


def decide(style, own, incoming, resp=1.0, seed=1):
    a = agent(behavior={"preset": "balanced", "responsiveness": resp, "reply_style": style})
    return behavior.decide_response(a, own, incoming, 0.6, random.Random(seed))


def test_reply_styles():
    assert decide("ignore", 0, 0.1)["action"] is None
    assert decide("debate", 0.8, -0.8)["action"] == "CREATE_COMMENT"      # rebuts disagreement
    assert decide("debate", 0.8, 0.7)["action"] == "LIKE_POST"            # only nods at agreement
    assert decide("acknowledge", 0.8, 0.7)["action"] == "LIKE_POST"
    assert decide("engage", 0.8, -0.8)["action"] == "CREATE_COMMENT"
    assert decide("engage", 0.5, 0.5, resp=0.0)["action"] is None         # never responsive
    d = decide("debate", 0.8, -0.8)
    assert not d["agrees"] and d["gap"] == pytest.approx(1.6) and "disagrees" in d["reason"]


def test_acknowledge_style_often_lets_disagreement_pass():
    answered = sum(decide("acknowledge", 0.8, -0.8, seed=s)["action"] is not None for s in range(200))
    assert 40 < answered < 110  # about 35 %


def _sim(behaviors):
    agents = [{"id": f"a{i}", "name": f"Agent {i}", "handle": f"@a{i}", "stance": s, "influence": 0.6, "activity": 0.95,
               "interests": ["water"], "persona": "", "profession": "x", "tone": "plain", "facts": [],
               "platforms": ["microblog"], "kind": "individual", "behavior": behaviors[i]}
              for i, s in enumerate([0.8, -0.7, 0.1, -0.2])]
    cfg = {"seed": 5, "platforms": ["microblog"], "rounds": 12, "minutes_per_round": 60, "epsilon": 0.6, "mu": 0.2,
           "backfire": 0.04, "llm_posts_per_round": 0, "focus_name": "the Accord"}
    return SimpleNamespace(id="sim_b", config={"config": cfg, "agents": agents, "links": [], "seed_posts": []})


class _Db:
    def add(self, _row):
        pass


def _events(behaviors):
    sim = _sim(behaviors)
    eng = simulation.Engine(SimpleNamespace(db=_Db(), log=lambda *a, **k: None), sim)
    for r in range(13):
        eng.round(r)
    return list(eng.by_id.values())


def test_replies_back_when_responsive_and_not_when_ignoring(monkeypatch):
    monkeypatch.setattr(llm, "available", lambda: False)
    talkative = {"preset": "commenter", "responsiveness": 1.0, "reply_style": "engage"}
    silent = {"preset": "commenter", "responsiveness": 1.0, "reply_style": "ignore"}
    on = _events([talkative] * 4)
    off = _events([silent] * 4)
    assert any(e.generated_by.endswith("reply-back") or e.generated_by == "reply-back" for e in on)
    assert not any("reply-back" in e.generated_by for e in off)
    assert [(e.agent_id, e.action, e.round) for e in on] == [(e.agent_id, e.action, e.round) for e in _events([talkative] * 4)]  # seeded
    # replies answer a comment, and never the agent's own
    by_id = {e.id: e for e in on}
    for e in on:
        if "reply-back" in e.generated_by:
            assert e.target_id in by_id and by_id[e.target_id].agent_id != e.agent_id


# ---------------------------------------------------------------- API (needs PostgreSQL)
def _db_ready() -> bool:
    try:
        with create_engine(settings.database_url).begin() as c:
            c.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        return True
    except Exception:
        return False


db_only = pytest.mark.skipif(not _db_ready(), reason="PostgreSQL with pgvector is not reachable")


@pytest.fixture()
def run():
    from fastapi.testclient import TestClient

    from app.core.db import SessionLocal
    from app.core.security import hash_password
    from app.main import app
    from app.models import (
        Case,
        Environment,
        GraphVersion,
        SimEvent,
        Simulation,
        Tenant,
        TenantSettings,
        User,
        new_id,
    )
    from app.services import workspace

    tag = uuid.uuid4().hex[:8]
    ids = {}
    with SessionLocal() as db:
        t = Tenant(name=f"B {tag}")
        db.add(t)
        db.flush()
        workspace.ensure_roles(db, t.id)
        u = User(tenant_id=t.id, name="Lead", email=f"lead-{tag}@test.local", role="Lead analyst", password_hash=hash_password("demo1234"))
        db.add(u)
        db.flush()
        case = Case(tenant_id=t.id, owner_id=u.id, title="Behaviour case", tags=[], extract_types=[])
        db.add(case)
        db.flush()
        gv = GraphVersion(case_id=case.id, number=1, status="approved", created_by="x")
        db.add(gv)
        db.flush()

        def ag(i, name, stance, preset, resp, style, kind="individual"):
            return {"id": f"ag{i}", "node_id": f"n{i}", "name": name, "handle": f"@{name.lower()}", "kind": kind, "entity_type": "person",
                    "profession": "x", "interests": ["water"], "persona": "", "facts": [], "stance": stance, "influence": 0.6,
                    "activity": 0.9, "tone": "plain", "platforms": ["microblog"], "synthetic": True, "speaks": True,
                    "behavior": {"preset": preset, "responsiveness": resp, "reply_style": style}}
        agents = [ag(0, "Author", 0.8, "debater", 1.0, "debate"), ag(1, "Critic", -0.7, "commenter", 0.5, "engage"),
                  ag(2, "Ally", 0.7, "amplifier", 0.3, "acknowledge"), ag(3, "Quiet", 0.1, "lurker", 0.1, "ignore")]
        links = [{"id": "l1", "s": "ag0", "o": "ag2", "kind": "ally", "relation": "SUPPORTS", "weight": .6},
                 {"id": "l2", "s": "ag0", "o": "ag1", "kind": "opponent", "relation": "OPPOSES", "weight": .6}]
        cfg = {"platforms": ["microblog"], "rounds": 3, "epsilon": 0.6, "mu": 0.2, "backfire": 0.04, "seed": 1, "focus_name": "the Accord"}
        env = Environment(case_id=case.id, version_id=gv.id, name="E", status="ready", config=cfg, agents=agents, links=links, created_by="x")
        db.add(env)
        db.flush()
        sim = Simulation(case_id=case.id, environment_id=env.id, name="S", status="done",
                         config={"config": cfg, "agents": agents, "links": links, "seed_posts": []},
                         stats={"series": {a["id"]: [a["stance"]] for a in agents}, "focus": "the Accord"}, created_by="x")
        db.add(sim)
        db.flush()
        post = SimEvent(id=new_id("se"), simulation_id=sim.id, round=1, platform="microblog", agent_id="ag0", agent_name="Author",
                        action="CREATE_POST", content="The accord protects downstream farmers.", stance=0.8, generated_by="template")
        db.add(post)
        db.commit()
        ids = {"tenant": t.id, "user": u.id, "case": case.id, "sim": sim.id, "post": post.id, "email": u.email}
    client = TestClient(app)
    tok = client.post("/api/v1/auth/login", json={"email": ids["email"], "password": "demo1234"}).json()["access_token"]
    yield client, {"Authorization": f"Bearer {tok}"}, ids
    with SessionLocal() as db:
        sim_ids = [s for (s,) in db.execute(text("SELECT id FROM simulations WHERE case_id = :c"), {"c": ids["case"]})]
        db.execute(delete(SimEvent).where(SimEvent.simulation_id.in_(sim_ids)))
        db.execute(delete(Simulation).where(Simulation.case_id == ids["case"]))
        db.execute(delete(Environment).where(Environment.case_id == ids["case"]))
        db.execute(delete(GraphVersion).where(GraphVersion.case_id == ids["case"]))
        db.execute(text("DELETE FROM audit_events WHERE tenant_id = :t"), {"t": ids["tenant"]})
        db.execute(delete(Case).where(Case.tenant_id == ids["tenant"]))
        db.execute(delete(User).where(User.tenant_id == ids["tenant"]))
        db.execute(text("DELETE FROM roles WHERE tenant_id = :t"), {"t": ids["tenant"]})
        db.execute(delete(TenantSettings).where(TenantSettings.tenant_id == ids["tenant"]))
        db.execute(delete(Tenant).where(Tenant.id == ids["tenant"]))
        db.commit()


@db_only
def test_comment_gets_an_answer_from_the_posts_author(run):
    client, h, ids = run
    r = client.post(f"/api/v1/simulations/{ids['sim']}/actions", headers=h, json={
        "agent_id": "ag1", "action": "CREATE_COMMENT", "target_id": ids["post"], "content": "This ignores upstream farmers.", "react": True})
    assert r.status_code == 201, r.text
    body = r.json()
    author = next(x for x in body["responses"] if x["role"] == "author")
    # Author is a Debater (responsiveness 1.0) and the critic opposes them: a rebuttal comment is certain.
    assert author["agent_id"] == "ag0" and author["decision"] == "replied" and author["profile"] == "Debater"
    assert "disagrees" in author["reason"] and author["event_id"]
    reply = next(e for e in body["events"] if e["id"] == author["event_id"])
    assert reply["action"] == "CREATE_COMMENT" and reply["generated_by"].startswith("reaction-model")
    assert reply["target_id"] == body["events"][0]["id"]  # the reply answers the analyst's comment
    assert all(x["agent_id"] != "ag0" for x in body["responses"] if x["role"] == "bystander")


@db_only
def test_without_react_only_the_trigger_itself_is_recorded(run):
    client, h, ids = run
    body = {"agent_id": "ag1", "action": "CREATE_COMMENT", "target_id": ids["post"], "content": "x", "react": False}
    r = client.post(f"/api/v1/simulations/{ids['sim']}/actions", headers=h, json=body).json()
    assert len(r["events"]) == 1 and r["responses"] == []


@db_only
def test_overlay_graph_layers_and_scopes(run):
    client, h, ids = run
    client.post(f"/api/v1/simulations/{ids['sim']}/actions", headers=h, json={
        "agent_id": "ag1", "action": "CREATE_COMMENT", "target_id": ids["post"], "content": "No.", "react": True})
    g = client.get(f"/api/v1/simulations/{ids['sim']}/overlay-graph", headers=h).json()
    base = [n for n in g["nodes"] if n["layer"] == "base"]
    assert {n["id"] for n in base} == {"ag0", "ag1", "ag2", "ag3"}                   # every actor is always drawn
    assert {lk["type"] for lk in g["links"] if lk["layer"] == "base"} == {"SUPPORTS", "OPPOSES"}  # original relations
    assert any(n["layer"] == "interaction" and n["type"] in ("post", "comment") for n in g["nodes"])
    assert any(lk["layer"] == "interaction" for lk in g["links"])
    author = next(n for n in base if n["id"] == "ag0")
    assert author["profile"] == "Debater" and author["actions"]["posts"] == 1
    t = client.get(f"/api/v1/simulations/{ids['sim']}/overlay-graph?post_id={ids['post']}", headers=h).json()
    assert t["scope"] == "thread" and t["focus"] == [ids["post"]]
    assert client.get(f"/api/v1/simulations/{ids['sim']}/overlay-graph?post_id=nope", headers=h).status_code == 404
    assert client.get(f"/api/v1/simulations/{ids['sim']}/overlay-graph?agent_id=nope", headers=h).status_code == 404
    a = client.get(f"/api/v1/simulations/{ids['sim']}/overlay-graph?agent_id=ag0", headers=h).json()
    assert a["scope"] == "agent"


@db_only
def test_presets_and_saved_behavior(run):
    client, h, ids = run
    p = client.get("/api/v1/behavior/presets", headers=h).json()
    assert {"balanced", "broadcaster", "commenter", "debater", "amplifier", "lurker"} == {x["id"] for x in p["presets"]}
    s = client.get(f"/api/v1/simulations/{ids['sim']}", headers=h).json()
    assert all("behavior" in a for a in s["agents"])
