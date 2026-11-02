"""Administration API: users, roles and settings, against a real PostgreSQL (skipped when none is reachable).

Each test builds its own tenant with unique emails and removes it afterwards, so it is safe to run
against a development database.
"""
import uuid

import pytest
from sqlalchemy import create_engine, delete, text

from app.core.config import settings


def _db_ready() -> bool:
    try:
        with create_engine(settings.database_url).begin() as c:
            c.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_ready(), reason="PostgreSQL with pgvector is not reachable")
PW = "demo1234"


@pytest.fixture()
def ws():
    from fastapi.testclient import TestClient

    from app.core.db import SessionLocal
    from app.core.security import hash_password
    from app.main import app
    from app.models import AuditEvent, Case, Role, Tenant, TenantSettings, User
    from app.services import workspace

    tag = uuid.uuid4().hex[:8]
    with SessionLocal() as db:
        t = Tenant(name=f"Test {tag}")
        db.add(t)
        db.flush()
        workspace.ensure_roles(db, t.id)
        emails = {}
        for key, role in [("admin", "Administrator"), ("analyst", "Analyst"), ("viewer", "Viewer")]:
            email = f"{key}-{tag}@test.local"
            db.add(User(tenant_id=t.id, name=f"{key.title()} {tag}", email=email, role=role,
                        password_hash=hash_password(PW)))
            emails[key] = email
        db.commit()
        tid = t.id
    client = TestClient(app)

    def login(key: str) -> dict:
        r = client.post("/api/v1/auth/login", json={"email": emails[key], "password": PW})
        assert r.status_code == 200, r.text
        return {"Authorization": f"Bearer {r.json()['access_token']}"}

    yield client, login, emails, tag
    with SessionLocal() as db:
        ids = [u for (u,) in db.execute(text("SELECT id FROM users WHERE tenant_id = :t"), {"t": tid})]
        db.execute(delete(Case).where(Case.tenant_id == tid))
        db.execute(delete(AuditEvent).where(AuditEvent.tenant_id == tid))
        db.execute(delete(User).where(User.id.in_(ids)))
        db.execute(delete(Role).where(Role.tenant_id == tid))
        db.execute(delete(TenantSettings).where(TenantSettings.tenant_id == tid))
        db.execute(delete(Tenant).where(Tenant.id == tid))
        db.commit()


def test_admin_routes_need_admin_access(ws):
    client, login, *_ = ws
    for key in ("analyst", "viewer"):
        h = login(key)
        for path in ("/api/v1/admin/users", "/api/v1/admin/roles", "/api/v1/admin/settings"):
            assert client.get(path, headers=h).status_code == 403
    assert client.get("/api/v1/admin/users").status_code == 401


def test_user_lifecycle_and_temporary_password(ws):
    client, login, emails, tag = ws
    h = login("admin")
    r = client.post("/api/v1/admin/users", headers=h, json={"name": "New Person", "email": f"New-{tag}@Test.local",
                                                             "role": "Reviewer"})
    assert r.status_code == 201, r.text
    body = r.json()
    temp, uid = body["temporary_password"], body["user"]["id"]
    assert temp and body["user"]["email"] == f"new-{tag}@test.local"
    assert "graph.approve" in body["user"]["permissions"]
    assert client.post("/api/v1/auth/login", json={"email": f"new-{tag}@test.local", "password": temp}).status_code == 200
    # Duplicate email, unknown role, short password.
    assert client.post("/api/v1/admin/users", headers=h, json={"name": "Dup", "email": f"new-{tag}@test.local",
                                                                "role": "Viewer"}).status_code == 409
    assert client.post("/api/v1/admin/users", headers=h, json={"name": "X Y", "email": f"x-{tag}@test.local",
                                                                "role": "Nope"}).status_code == 422
    assert client.post("/api/v1/admin/users", headers=h, json={"name": "X Y", "email": f"x-{tag}@test.local",
                                                                "role": "Viewer", "password": "short"}).status_code == 422
    # Suspend blocks sign-in; reactivate and reset the password.
    assert client.patch(f"/api/v1/admin/users/{uid}", headers=h, json={"status": "Suspended"}).json()["status"] == "Suspended"
    assert client.post("/api/v1/auth/login", json={"email": f"new-{tag}@test.local", "password": temp}).status_code == 403
    client.patch(f"/api/v1/admin/users/{uid}", headers=h, json={"status": "Active"})
    assert client.post(f"/api/v1/admin/users/{uid}/password", headers=h, json={"password": "a-long-password"}).json() == \
        {"temporary_password": None}
    assert client.post("/api/v1/auth/login", json={"email": f"new-{tag}@test.local", "password": "a-long-password"}).status_code == 200
    assert client.delete(f"/api/v1/admin/users/{uid}", headers=h).status_code == 204
    assert all(u["id"] != uid for u in client.get("/api/v1/admin/users", headers=h).json())


def test_last_administrator_is_protected(ws):
    client, login, emails, _ = ws
    h = login("admin")
    users = {u["email"]: u for u in client.get("/api/v1/admin/users", headers=h).json()}
    me = users[emails["admin"]]
    assert client.patch(f"/api/v1/admin/users/{me['id']}", headers=h, json={"status": "Suspended"}).status_code == 409
    assert client.patch(f"/api/v1/admin/users/{me['id']}", headers=h, json={"role": "Viewer"}).status_code == 409
    assert client.delete(f"/api/v1/admin/users/{me['id']}", headers=h).status_code == 409
    # Promote the analyst, who may then demote the original administrator.
    analyst = users[emails["analyst"]]
    assert client.patch(f"/api/v1/admin/users/{analyst['id']}", headers=h, json={"role": "Administrator"}).status_code == 200
    h2 = login("analyst")
    assert client.patch(f"/api/v1/admin/users/{me['id']}", headers=h2, json={"role": "Viewer"}).status_code == 200
    assert client.get("/api/v1/admin/users", headers=h).status_code == 403  # permissions follow the new role at once


def test_custom_role_and_builtin_rules(ws):
    client, login, emails, _ = ws
    h = login("admin")
    data = client.get("/api/v1/admin/roles", headers=h).json()
    roles = {r["name"]: r for r in data["roles"]}
    assert {"Administrator", "Lead analyst", "Analyst", "Reviewer", "Viewer"} <= set(roles)
    assert len(data["permissions"]) == len(roles["Administrator"]["permissions"])
    admin_role = roles["Administrator"]
    assert client.patch(f"/api/v1/admin/roles/{admin_role['id']}", headers=h, json={"permissions": []}).status_code == 409
    assert client.delete(f"/api/v1/admin/roles/{roles['Viewer']['id']}", headers=h).status_code == 409
    assert client.post("/api/v1/admin/roles", headers=h, json={"name": "Bad", "permissions": ["nope"]}).status_code == 422

    r = client.post("/api/v1/admin/roles", headers=h, json={"name": "Auditor", "description": "Reads cases",
                                                             "permissions": ["chat.use", "graph.review"]})
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    users = {u["email"]: u for u in client.get("/api/v1/admin/users", headers=h).json()}
    viewer = users[emails["viewer"]]
    client.patch(f"/api/v1/admin/users/{viewer['id']}", headers=h, json={"role": "Auditor"})
    hv = login("viewer")
    assert "graph.review" in client.get("/api/v1/auth/me", headers=hv).json()["permissions"]
    # Renaming carries the users along; a role in use cannot be deleted.
    assert client.patch(f"/api/v1/admin/roles/{rid}", headers=h, json={"name": "Graph auditor"}).status_code == 200
    assert client.get("/api/v1/auth/me", headers=hv).json()["role"] == "Graph auditor"
    assert client.delete(f"/api/v1/admin/roles/{rid}", headers=h).status_code == 409
    # Editing a built-in role's permissions takes effect for its users.
    analyst_role = roles["Analyst"]
    client.patch(f"/api/v1/admin/roles/{analyst_role['id']}", headers=h, json={"permissions": ["chat.use"]})
    ha = login("analyst")
    assert client.get("/api/v1/auth/me", headers=ha).json()["permissions"] == ["chat.use"]
    assert client.post("/api/v1/cases", headers=ha, json={"title": "Not allowed"}).status_code == 403


def test_settings_apply_to_new_cases(ws):
    client, login, _, tag = ws
    h = login("admin")
    s = client.get("/api/v1/admin/settings", headers=h).json()
    assert s["default_case_visibility"] == "Team" and "system" in s
    r = client.patch("/api/v1/admin/settings", headers=h, json={"workspace_name": f"Renamed {tag}",
                                                                "default_case_visibility": "Private", "session_hours": 2})
    assert r.status_code == 200 and r.json()["workspace_name"] == f"Renamed {tag}"
    assert client.patch("/api/v1/admin/settings", headers=h, json={"session_hours": 500}).status_code == 422
    assert client.get("/api/v1/workspace", headers=h).json() == {"name": f"Renamed {tag}", "default_case_visibility": "Private"}
    c = client.post("/api/v1/cases", headers=h, json={"title": "Settings check"})
    assert c.status_code == 201 and c.json()["visibility"] == "Private"


def test_account_self_service(ws):
    client, login, emails, _ = ws
    h = login("viewer")
    assert client.patch("/api/v1/auth/me", headers=h, json={"name": "Renamed Viewer"}).json()["name"] == "Renamed Viewer"
    bad = client.post("/api/v1/auth/me/password", headers=h, json={"current_password": "nope", "new_password": "long-enough-1"})
    assert bad.status_code == 422
    assert client.post("/api/v1/auth/me/password", headers=h, json={"current_password": PW, "new_password": "short"}).status_code == 422
    assert client.post("/api/v1/auth/me/password", headers=h, json={"current_password": PW, "new_password": "long-enough-1"}).status_code == 204
    assert client.post("/api/v1/auth/login", json={"email": emails["viewer"], "password": "long-enough-1"}).status_code == 200
    act = client.get("/api/v1/auth/me/activity", headers=h).json()
    assert {"account.password", "account.update", "auth.login"} <= {e["action"] for e in act["events"]}


def test_activity_log_filters_and_pages(ws):
    client, login, emails, tag = ws
    h = login("admin")
    for i in range(3):
        client.post("/api/v1/admin/roles", headers=h, json={"name": f"Temp {i}", "permissions": ["chat.use"]})
    assert client.get("/api/v1/admin/audit", headers=login("analyst")).status_code == 403
    page = client.get("/api/v1/admin/audit?group=admin&limit=2", headers=h).json()
    assert len(page["items"]) == 2 and page["next"] and all(i["action"].startswith("admin.") for i in page["items"])
    rest = client.get(f"/api/v1/admin/audit?group=admin&limit=2&before={page['next']}", headers=h).json()
    assert rest["items"] and not {i["id"] for i in rest["items"]} & {i["id"] for i in page["items"]}
    assert client.get("/api/v1/admin/audit?q=temp%202", headers=h).json()["items"][0]["target"] == "Temp 2"
    assert client.get("/api/v1/admin/audit?group=nope", headers=h).status_code == 422


def test_status_reports_services(ws):
    client, login, *_ = ws
    s = client.get("/api/v1/system/status").json()["services"]
    assert s["database"]["ok"] is True and set(s) == {"database", "graph", "jobs", "llm"}
