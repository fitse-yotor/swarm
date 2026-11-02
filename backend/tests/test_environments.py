"""Several environments per case, persona reuse, and a clear refusal to launch when nobody can post."""
import pytest
from test_dynamic_graph import db_only, world  # noqa: F401  (the shared case fixture)

PERSONAS = """Topic codes: T01 water; T02 power.
- SIM01 — Maize farmer (Ethiopia; supportive) [stance +0.6]: "The canal must carry water in planting week." [simulation topic T01]
- SIM02 — Plant engineer (Ethiopia; sceptical) [stance -0.5]: "Every metre of drawdown costs us output." [simulation topic T02]
"""


def make_env(client, h, case, name, **extra):
    r = client.post(f"/api/v1/cases/{case}/environments", headers=h, json={"name": name, "scenario": "Hypothetical: test", "config": {"rounds": 6}, **extra})
    assert r.status_code == 202, r.text
    e = client.get(f"/api/v1/environments/{r.json()['id']}", headers=h).json()
    assert e["status"] == "ready", e
    return e


@db_only
def test_a_case_can_have_many_environments(world):  # noqa: F811
    client, h, _, _, ids, _ = world
    made = [make_env(client, h, ids["case"], f"Env {i}") for i in range(4)]
    assert len({e["id"] for e in made}) == 4
    listed = client.get(f"/api/v1/cases/{ids['case']}/environments", headers=h).json()
    assert len([e for e in listed if e["name"].startswith("Env ")]) == 4  # nothing limits the count
    assert all("synthetic_count" in e and "speaking_count" in e for e in listed)


@db_only
def test_new_environment_can_reuse_personas_and_can_then_run(world):  # noqa: F811
    client, h, _, _, ids, _ = world
    base = make_env(client, h, ids["case"], "Base")
    imported = client.post(f"/api/v1/environments/{base['id']}/personas", headers=h, json={"text": PERSONAS}).json()
    assert imported["imported"] == 2
    base = client.get(f"/api/v1/environments/{base['id']}", headers=h).json()
    plain = make_env(client, h, ids["case"], "Plain")
    reuse = make_env(client, h, ids["case"], "Reuse", copy_personas_from=base["id"])
    assert plain["synthetic_count"] == 0
    assert reuse["synthetic_count"] == 2 and reuse["speaking_count"] >= 2
    base_syn = {a["id"]: a for a in base["agents"] if a.get("synthetic")}
    copied = {a["id"]: a for a in reuse["agents"] if a.get("synthetic")}
    assert set(copied) == set(base_syn)
    assert all(a["behavior"] and a["stance"] == base_syn[i]["stance"] for i, a in copied.items())  # same personas, same stances and behaviour
    assert {(x["s"], x["o"]) for x in reuse["links"] if x["s"] in copied and x["o"] in copied} == {(x["s"], x["o"]) for x in base["links"] if x["s"] in base_syn and x["o"] in base_syn}
    assert client.post(f"/api/v1/environments/{reuse['id']}/simulations", headers=h, json={"rounds": 3}).status_code == 202  # and it can run


@db_only
def test_launch_is_refused_with_a_clear_message_when_nobody_can_post(world):  # noqa: F811
    client, h, _, _, ids, _ = world
    env = make_env(client, h, ids["case"], "No posters")
    assert env["speaking_count"] == 0
    r = client.post(f"/api/v1/environments/{env['id']}/simulations", headers=h, json={"rounds": 3})
    assert r.status_code == 409
    detail = r.json()["detail"]
    assert "Import synthetic personas" in detail and "context-only" in detail
    sims = client.get(f"/api/v1/cases/{ids['case']}/simulations", headers=h).json()
    assert not [s for s in sims if s["environment_id"] == env["id"]]  # no failed run was left behind
    client.post(f"/api/v1/environments/{env['id']}/personas", headers=h, json={"text": PERSONAS})
    assert client.post(f"/api/v1/environments/{env['id']}/simulations", headers=h, json={"rounds": 3}).status_code == 202


@db_only
def test_copy_personas_from_must_be_an_environment_of_the_same_case(world):  # noqa: F811
    client, h, other, _, ids, _ = world
    base = make_env(client, h, ids["case"], "Base")
    r = client.post(f"/api/v1/cases/{ids['case']}/environments", headers=h, json={"name": "X", "copy_personas_from": "env_nope"})
    assert r.status_code == 404
    # another tenant cannot name this case's environment as a source for its own case
    cross = client.post(f"/api/v1/cases/{ids['case']}/environments", headers=other, json={"name": "Y", "copy_personas_from": base["id"]})
    assert cross.status_code == 404
