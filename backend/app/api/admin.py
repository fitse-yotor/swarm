"""Administration: users, roles and workspace settings. Every route needs `admin.access`.

Guards that keep a workspace usable:
- at least one active user always holds `admin.access`;
- administrators cannot suspend, delete or demote themselves;
- the Administrator role always has every permission and cannot be renamed or deleted;
- a role in use cannot be deleted, and a user who owns cases cannot be deleted (suspend instead).
"""
import secrets
import string
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import jwt_secret_is_weak
from app.core.config import settings as app_settings
from app.core.db import get_db
from app.core.deps import audit, current_user, require
from app.core.security import PERMISSIONS, hash_password
from app.models import AuditEvent, Case, Role, Tenant, User
from app.services import embeddings, health, llm, workspace
from app.services.extraction import get_extractor

router = APIRouter(prefix="/admin", tags=["admin"])
admin_only = require(workspace.ADMIN_PERM)

EMAIL_CHARS = set(string.ascii_lowercase + string.digits + "@._+-")


# ----------------------------------------------------------------- schemas
def _email(v: str) -> str:
    v = v.strip().lower()
    local, _, domain = v.partition("@")
    if not local or "." not in domain or domain.startswith(".") or domain.endswith(".") or set(v) - EMAIL_CHARS:
        raise ValueError("Enter a valid email address")
    return v


class UserIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    email: str = Field(max_length=320)
    role: str
    password: str | None = Field(None, max_length=200)  # empty: generate a temporary password

    _check_email = field_validator("email")(_email)


class UserPatch(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=200)
    email: str | None = Field(None, max_length=320)
    role: str | None = None
    status: Literal["Active", "Suspended"] | None = None

    @field_validator("email")
    @classmethod
    def _e(cls, v: str | None) -> str | None:
        return None if v is None else _email(v)


class PasswordIn(BaseModel):
    password: str | None = Field(None, max_length=200)


class RoleIn(BaseModel):
    name: str = Field(min_length=2, max_length=40)
    description: str = Field("", max_length=500)
    permissions: list[str] = []


class RolePatch(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=40)
    description: str | None = Field(None, max_length=500)
    permissions: list[str] | None = None


class SettingsIn(BaseModel):
    workspace_name: str | None = Field(None, min_length=2, max_length=200)
    default_case_visibility: Literal["Private", "Team", "Organization"] | None = None
    session_hours: int | None = Field(None, ge=1, le=72)
    password_min_length: int | None = Field(None, ge=8, le=64)
    sim_rounds: int | None = Field(None, ge=1, le=200)
    sim_llm_personas: int | None = Field(None, ge=0, le=50)
    sim_llm_posts_per_round: int | None = Field(None, ge=0, le=20)
    sim_real_actors_context_only: bool | None = None


# ----------------------------------------------------------------- helpers
def _admin_count(db: Session, tenant_id: str, roles: list[Role]) -> int:
    names = [r.name for r in roles if workspace.ADMIN_PERM in workspace.role_permissions(r, r.name)]
    return db.scalar(select(func.count()).select_from(User).where(
        User.tenant_id == tenant_id, User.status == "Active", User.role.in_(names))) or 0


def _role_has_admin(roles: list[Role], name: str) -> bool:
    role = next((r for r in roles if r.name == name), None)
    return workspace.ADMIN_PERM in workspace.role_permissions(role, name)


def _temp_password() -> str:
    return secrets.token_urlsafe(9)  # 12 characters


def _password(db: Session, tenant_id: str, given: str | None) -> tuple[str, bool]:
    """Return (password, generated)."""
    if not given:
        return _temp_password(), True
    n = workspace.get_settings(db, tenant_id)["password_min_length"]
    if len(given) < n:
        raise HTTPException(422, f"Passwords need at least {n} characters")
    return given, False


def _user(db: Session, admin: User, user_id: str) -> User:
    u = db.get(User, user_id)
    if u is None or u.tenant_id != admin.tenant_id:
        raise HTTPException(404, "User not found")
    return u


def _role(db: Session, admin: User, role_id: str) -> Role:
    r = db.get(Role, role_id)
    if r is None or r.tenant_id != admin.tenant_id:
        raise HTTPException(404, "Role not found")
    return r


def _clean_perms(perms: list[str]) -> list[str]:
    unknown = sorted(set(perms) - set(PERMISSIONS))
    if unknown:
        raise HTTPException(422, f"Unknown permission: {', '.join(unknown)}")
    return [p for p in PERMISSIONS if p in perms]  # catalogue order, no duplicates


def user_row(u: User, perms: list[str], cases: int, last_login) -> dict:
    return {"id": u.id, "name": u.name, "email": u.email, "role": u.role, "status": u.status, "permissions": perms,
            "created_at": u.created_at, "case_count": cases, "last_login_at": last_login}


def _users_out(db: Session, tenant_id: str, only: list[User] | None = None) -> list[dict]:
    roles = {r.name: r for r in workspace.ensure_roles(db, tenant_id)}
    users = only if only is not None else list(db.scalars(select(User).where(User.tenant_id == tenant_id).order_by(User.name)))
    ids = [u.id for u in users]
    cases = dict(db.execute(select(Case.owner_id, func.count()).where(Case.owner_id.in_(ids)).group_by(Case.owner_id)).all())
    logins = dict(db.execute(select(AuditEvent.target, func.max(AuditEvent.at)).where(
        AuditEvent.tenant_id == tenant_id, AuditEvent.action == "auth.login").group_by(AuditEvent.target)).all())
    return [user_row(u, workspace.role_permissions(roles.get(u.role), u.role), cases.get(u.id, 0), logins.get(u.email))
            for u in users]


def _roles_out(db: Session, tenant_id: str) -> list[dict]:
    roles = workspace.ensure_roles(db, tenant_id)
    counts = dict(db.execute(select(User.role, func.count()).where(User.tenant_id == tenant_id).group_by(User.role)).all())
    return [{"id": r.id, "name": r.name, "description": r.description, "builtin": r.builtin,
             "locked": r.name == workspace.ADMIN_ROLE, "permissions": workspace.role_permissions(r, r.name),
             "user_count": counts.get(r.name, 0), "updated_at": r.updated_at} for r in roles]


# ----------------------------------------------------------------- users
@router.get("/users")
def list_users(db: Session = Depends(get_db), admin: User = Depends(admin_only)):
    out = _users_out(db, admin.tenant_id)
    db.commit()  # ensure_roles may have written the built-in roles
    return out


@router.post("/users", status_code=201)
def create_user(body: UserIn, db: Session = Depends(get_db), admin: User = Depends(admin_only)):
    roles = workspace.ensure_roles(db, admin.tenant_id)
    if body.role not in {r.name for r in roles}:
        raise HTTPException(422, f"Unknown role: {body.role}")
    if db.scalar(select(User).where(User.email == body.email)):
        raise HTTPException(409, "A user with this email already exists")
    pw, generated = _password(db, admin.tenant_id, body.password)
    u = User(tenant_id=admin.tenant_id, name=body.name.strip(), email=body.email, role=body.role, status="Active",
             password_hash=hash_password(pw))
    db.add(u)
    db.flush()
    audit(db, admin, "admin.user.create", f"{u.email} as {u.role}")
    out = _users_out(db, admin.tenant_id, [u])[0]
    db.commit()
    return {"user": out, "temporary_password": pw if generated else None}


@router.patch("/users/{user_id}")
def update_user(user_id: str, body: UserPatch, db: Session = Depends(get_db), admin: User = Depends(admin_only)):
    u = _user(db, admin, user_id)
    roles = workspace.ensure_roles(db, admin.tenant_id)
    changes = body.model_dump(exclude_none=True)
    if "role" in changes and changes["role"] not in {r.name for r in roles}:
        raise HTTPException(422, f"Unknown role: {changes['role']}")
    if "email" in changes and changes["email"] != u.email and db.scalar(select(User).where(User.email == changes["email"])):
        raise HTTPException(409, "A user with this email already exists")
    if u.id == admin.id:
        if changes.get("status") == "Suspended":
            raise HTTPException(409, "You cannot suspend your own account")
        if "role" in changes and not _role_has_admin(roles, changes["role"]):
            raise HTTPException(409, "You cannot remove your own administration access")
    loses_admin = (_role_has_admin(roles, u.role) and u.status == "Active"
                   and (changes.get("status") == "Suspended"
                        or ("role" in changes and not _role_has_admin(roles, changes["role"]))))
    if loses_admin and _admin_count(db, admin.tenant_id, roles) <= 1:
        raise HTTPException(409, "This is the last active administrator; give someone else administration access first")
    changed = {k: v for k, v in changes.items() if getattr(u, k) != v}
    for k, v in changed.items():
        setattr(u, k, v.strip() if k == "name" else v)
    if changed:
        audit(db, admin, "admin.user.update", u.email, fields=sorted(changed),
              **{k: changed[k] for k in ("role", "status") if k in changed})
    db.flush()
    out = _users_out(db, admin.tenant_id, [u])[0]
    db.commit()
    return out


@router.post("/users/{user_id}/password")
def reset_password(user_id: str, body: PasswordIn, db: Session = Depends(get_db), admin: User = Depends(admin_only)):
    u = _user(db, admin, user_id)
    pw, generated = _password(db, admin.tenant_id, body.password)
    u.password_hash = hash_password(pw)
    audit(db, admin, "admin.user.password", u.email, generated=generated)
    db.commit()
    return {"temporary_password": pw if generated else None}


@router.delete("/users/{user_id}", status_code=204)
def delete_user(user_id: str, db: Session = Depends(get_db), admin: User = Depends(admin_only)):
    u = _user(db, admin, user_id)
    if u.id == admin.id:
        raise HTTPException(409, "You cannot delete your own account")
    if db.scalar(select(func.count()).select_from(Case).where(Case.owner_id == u.id)):
        raise HTTPException(409, "This user owns cases; suspend the account instead")
    roles = workspace.ensure_roles(db, admin.tenant_id)
    if u.status == "Active" and _role_has_admin(roles, u.role) and _admin_count(db, admin.tenant_id, roles) <= 1:
        raise HTTPException(409, "This is the last active administrator")
    audit(db, admin, "admin.user.delete", u.email)
    db.delete(u)
    db.commit()


# ----------------------------------------------------------------- roles
@router.get("/roles")
def list_roles(db: Session = Depends(get_db), admin: User = Depends(admin_only)):
    out = {"roles": _roles_out(db, admin.tenant_id),
           "permissions": [{"id": k, "label": v} for k, v in PERMISSIONS.items()]}
    db.commit()
    return out


@router.post("/roles", status_code=201)
def create_role(body: RoleIn, db: Session = Depends(get_db), admin: User = Depends(admin_only)):
    roles = workspace.ensure_roles(db, admin.tenant_id)
    name = body.name.strip()
    if name.lower() in {r.name.lower() for r in roles}:
        raise HTTPException(409, "A role with this name already exists")
    r = Role(tenant_id=admin.tenant_id, name=name, description=body.description.strip(),
             permissions=_clean_perms(body.permissions), builtin=False)
    db.add(r)
    db.flush()
    audit(db, admin, "admin.role.create", name, permissions=r.permissions)
    out = next(x for x in _roles_out(db, admin.tenant_id) if x["id"] == r.id)
    db.commit()
    return out


@router.patch("/roles/{role_id}")
def update_role(role_id: str, body: RolePatch, db: Session = Depends(get_db), admin: User = Depends(admin_only)):
    r = _role(db, admin, role_id)
    roles = workspace.ensure_roles(db, admin.tenant_id)
    if r.name == workspace.ADMIN_ROLE and (body.permissions is not None or (body.name and body.name.strip() != r.name)):
        raise HTTPException(409, "The Administrator role always holds every permission and keeps its name")
    old_name = r.name
    if body.name is not None and body.name.strip() != r.name:
        name = body.name.strip()
        if r.builtin:
            raise HTTPException(409, "Built-in roles keep their names; create a new role instead")
        if name.lower() in {x.name.lower() for x in roles if x.id != r.id}:
            raise HTTPException(409, "A role with this name already exists")
        r.name = name
        for u in db.scalars(select(User).where(User.tenant_id == admin.tenant_id, User.role == old_name)):
            u.role = name
    if body.description is not None:
        r.description = body.description.strip()
    if body.permissions is not None:
        perms = _clean_perms(body.permissions)
        if workspace.ADMIN_PERM in r.permissions and workspace.ADMIN_PERM not in perms:
            if admin.role == r.name:
                raise HTTPException(409, "You cannot remove administration access from your own role")
            db.flush()
            remaining = _admin_count(db, admin.tenant_id, [x for x in roles if x.id != r.id])
            if remaining < 1:
                raise HTTPException(409, "No active administrator would remain")
        r.permissions = perms
    audit(db, admin, "admin.role.update", r.name, **({"renamed_from": old_name} if old_name != r.name else {}),
          permissions=workspace.role_permissions(r, r.name))
    db.flush()
    out = next(x for x in _roles_out(db, admin.tenant_id) if x["id"] == r.id)
    db.commit()
    return out


@router.delete("/roles/{role_id}", status_code=204)
def delete_role(role_id: str, db: Session = Depends(get_db), admin: User = Depends(admin_only)):
    r = _role(db, admin, role_id)
    if r.builtin:
        raise HTTPException(409, "Built-in roles cannot be deleted")
    n = db.scalar(select(func.count()).select_from(User).where(User.tenant_id == admin.tenant_id, User.role == r.name))
    if n:
        raise HTTPException(409, f"{n} user{'s' if n != 1 else ''} still have this role; move them to another role first")
    audit(db, admin, "admin.role.delete", r.name)
    db.delete(r)
    db.commit()


# ----------------------------------------------------------------- settings
def _settings_out(db: Session, tenant: Tenant) -> dict:
    return {"workspace_name": tenant.name, **workspace.get_settings(db, tenant.id),
            "system": {"llm": {"provider": app_settings.llm_provider, "model": llm.name(), "available": llm.available(),
                               "url": app_settings.ollama_url},
                       "extractor": get_extractor().name, "embedder": embeddings.embedder_name(),
                       "max_upload_mb": app_settings.max_upload_mb, "storage": "local disk",
                       "jwt_secret_is_default": jwt_secret_is_weak(app_settings.jwt_secret),
                       "demo_accounts": app_settings.demo_accounts, "services": health.services()}}


@router.get("/settings")
def read_settings(db: Session = Depends(get_db), admin: User = Depends(admin_only)):
    return _settings_out(db, db.get(Tenant, admin.tenant_id))


@router.patch("/settings")
def update_settings(body: SettingsIn, db: Session = Depends(get_db), admin: User = Depends(admin_only)):
    tenant = db.get(Tenant, admin.tenant_id)
    changes = body.model_dump(exclude_none=True)
    if "workspace_name" in changes:
        tenant.name = changes.pop("workspace_name").strip()
    before = workspace.get_settings(db, tenant.id)
    workspace.save_settings(db, tenant.id, changes, admin.name)
    audit(db, admin, "admin.settings.update", "workspace",
          fields=sorted([k for k, v in changes.items() if before.get(k) != v] + (["workspace_name"] if body.workspace_name else [])))
    db.commit()
    return _settings_out(db, tenant)


# ----------------------------------------------------------------- activity
AUDIT_GROUPS = {"auth": ["auth."], "account": ["account."], "admin": ["admin."], "cases": ["case."],
                "sources": ["doc."], "graph": ["graph.", "graphrag."], "workflow": ["environment.", "simulation.", "report."]}


@router.get("/audit")
def activity(group: str | None = None, actor: str | None = None, q: str | None = None, before: str | None = None,
             limit: int = 50, db: Session = Depends(get_db), admin: User = Depends(admin_only)):
    """Workspace activity, newest first. Page with `before` = the `next` value of the previous page."""
    from sqlalchemy import or_

    stmt = select(AuditEvent, Case.title).outerjoin(Case, Case.id == AuditEvent.case_id).where(
        AuditEvent.tenant_id == admin.tenant_id)
    if group:
        prefixes = AUDIT_GROUPS.get(group)
        if prefixes is None:
            raise HTTPException(422, f"Unknown group: {group}")
        stmt = stmt.where(or_(*[AuditEvent.action.startswith(p) for p in prefixes]))
    if actor:
        stmt = stmt.where(AuditEvent.actor == actor)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(AuditEvent.target).like(like), func.lower(AuditEvent.action).like(like),
                              func.lower(Case.title).like(like)))
    if before:
        cur = db.get(AuditEvent, before)
        if cur is not None:
            stmt = stmt.where(or_(AuditEvent.at < cur.at, (AuditEvent.at == cur.at) & (AuditEvent.id < cur.id)))
    n = max(1, min(limit, 200))
    rows = db.execute(stmt.order_by(AuditEvent.at.desc(), AuditEvent.id.desc()).limit(n + 1)).all()
    items = [{"id": e.id, "at": e.at, "actor": e.actor, "action": e.action, "target": e.target, "case_id": e.case_id,
              "case_title": title, "meta": e.meta or {}} for e, title in rows[:n]]
    actors = [a for (a,) in db.execute(select(AuditEvent.actor).where(AuditEvent.tenant_id == admin.tenant_id)
                                       .distinct().order_by(AuditEvent.actor))]
    return {"items": items, "next": items[-1]["id"] if len(rows) > n else None, "actors": actors,
            "groups": list(AUDIT_GROUPS)}


# A small, non-admin view of the workspace for the app shell (name and defaults the UI needs).
public = APIRouter(tags=["workspace"])


@public.get("/workspace")
def read_workspace(db: Session = Depends(get_db), user: User = Depends(current_user)):
    s = workspace.get_settings(db, user.tenant_id)
    return {"name": db.get(Tenant, user.tenant_id).name, "default_case_visibility": s["default_case_visibility"]}
