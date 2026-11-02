"""Tenant roles and workspace settings: the data behind the Administration section.

Permissions are resolved from the tenant's `roles` table. A tenant that has no role rows yet
(a database created before roles were editable) falls back to the built-in defaults in
core.security.ROLES, and `ensure_roles` writes those defaults the first time they are needed.
"""
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session, object_session

from app.core.config import settings as app_settings
from app.core.security import PERMISSIONS, ROLES
from app.models import Role, TenantSettings, User

ADMIN_ROLE = "Administrator"
ADMIN_PERM = "admin.access"
ROLE_DESCRIPTIONS = {
    "Administrator": "Full access, including users, roles and workspace settings.",
    "Lead analyst": "Runs cases end to end and approves graphs, environments and reports.",
    "Analyst": "Builds graphs, configures environments, runs simulations and edits reports.",
    "Reviewer": "Reviews and approves graph versions and reports.",
    "Viewer": "Reads cases and uses conversations.",
}

# Workspace settings with their defaults. Only these keys are stored or returned.
DEFAULT_SETTINGS: dict[str, Any] = {
    "default_case_visibility": "Team",       # applied when a new case does not choose one
    "session_hours": app_settings.jwt_minutes // 60,  # lifetime of a sign-in token
    "password_min_length": 8,                # for passwords set by an administrator
    "sim_rounds": 24,                        # defaults for new environments
    "sim_llm_personas": 6,
    "sim_llm_posts_per_round": 1,
    "sim_real_actors_context_only": True,
}
SIM_KEYS = {"sim_rounds": "rounds", "sim_llm_personas": "llm_personas",
            "sim_llm_posts_per_round": "llm_posts_per_round",
            "sim_real_actors_context_only": "real_actors_context_only"}


def ensure_roles(db: Session, tenant_id: str) -> list[Role]:
    """Return the tenant's roles, creating the built-in ones if the tenant has none."""
    rows = list(db.scalars(select(Role).where(Role.tenant_id == tenant_id).order_by(Role.created_at)))
    if rows:
        return rows
    rows = [Role(tenant_id=tenant_id, name=name, description=ROLE_DESCRIPTIONS.get(name, ""), permissions=list(perms),
                 builtin=True) for name, perms in ROLES.items()]
    db.add_all(rows)
    db.flush()
    return rows


def role_permissions(role: Role | None, name: str) -> list[str]:
    if name == ADMIN_ROLE:
        return list(PERMISSIONS)  # cannot be reduced, so a workspace is never locked out
    if role is None:
        return list(ROLES.get(name, []))
    return [p for p in role.permissions if p in PERMISSIONS]


def permissions_of(user: User, db: Session | None = None) -> list[str]:
    """The user's effective permissions, cached on the instance for the rest of the request."""
    cached = getattr(user, "_perms", None)
    if cached is not None:
        return cached
    db = db or object_session(user)
    role = db.scalar(select(Role).where(Role.tenant_id == user.tenant_id, Role.name == user.role)) if db else None
    perms = role_permissions(role, user.role)
    user._perms = perms
    return perms


def get_settings(db: Session, tenant_id: str) -> dict[str, Any]:
    row = db.get(TenantSettings, tenant_id)
    stored = row.data if row else {}
    return {k: stored.get(k, v) for k, v in DEFAULT_SETTINGS.items()}


def save_settings(db: Session, tenant_id: str, changes: dict[str, Any], by: str) -> dict[str, Any]:
    row = db.get(TenantSettings, tenant_id)
    if row is None:
        row = TenantSettings(tenant_id=tenant_id, data={})
        db.add(row)
    row.data = {**{k: v for k, v in (row.data or {}).items() if k in DEFAULT_SETTINGS},
                **{k: v for k, v in changes.items() if k in DEFAULT_SETTINGS}}
    row.updated_by = by
    db.flush()
    return get_settings(db, tenant_id)


def sim_defaults(db: Session, tenant_id: str) -> dict[str, Any]:
    """Workspace overrides for a new environment's config (keys as in environment.DEFAULT_CONFIG)."""
    s = get_settings(db, tenant_id)
    return {cfg_key: s[key] for key, cfg_key in SIM_KEYS.items()}
