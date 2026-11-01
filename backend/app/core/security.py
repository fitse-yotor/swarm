from datetime import UTC, datetime, timedelta

import bcrypt
import jwt

from app.core.config import settings

PERMISSIONS: dict[str, str] = {
    "case.create": "Create and edit cases",
    "case.archive": "Archive cases",
    "doc.upload": "Upload sources",
    "graph.review": "Review graph claims",
    "graph.approve": "Approve graph versions",
    "env.edit": "Configure environments",
    "env.approve": "Approve environments",
    "sim.run": "Start simulations",
    "report.edit": "Edit reports",
    "report.approve": "Approve reports",
    "chat.use": "Use conversations",
    "admin.access": "Administration",
}

ROLES: dict[str, list[str]] = {
    "Administrator": list(PERMISSIONS),
    "Lead analyst": ["case.create", "case.archive", "doc.upload", "graph.review", "graph.approve", "env.edit",
                     "env.approve", "sim.run", "report.edit", "report.approve", "chat.use"],
    "Analyst": ["case.create", "doc.upload", "graph.review", "env.edit", "sim.run", "report.edit", "chat.use"],
    "Reviewer": ["graph.review", "graph.approve", "report.approve", "chat.use"],
    "Viewer": ["chat.use"],
}


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    return bcrypt.checkpw(pw.encode(), hashed.encode())


def create_token(user_id: str, tenant_id: str) -> str:
    exp = datetime.now(UTC) + timedelta(minutes=settings.jwt_minutes)
    return jwt.encode({"sub": user_id, "tid": tenant_id, "exp": exp}, settings.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
