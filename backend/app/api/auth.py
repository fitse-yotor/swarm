from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.db import get_db
from app.core.deps import audit, current_user
from app.core.security import create_token, hash_password, verify_password
from app.models import AuditEvent, Tenant, User
from app.schemas import LoginIn, TokenOut, UserOut
from app.services import workspace

router = APIRouter(prefix="/auth", tags=["auth"])
DEMO_DOMAIN = "@lattice.demo"


def user_out(u: User) -> UserOut:
    return UserOut(id=u.id, name=u.name, email=u.email, role=u.role, status=u.status, permissions=workspace.permissions_of(u))


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: Session = Depends(get_db)):
    u = db.scalar(select(User).where(User.email == body.email.strip().lower()))
    if not u or not verify_password(body.password, u.password_hash):
        raise HTTPException(401, "Email or password is incorrect")
    if u.status != "Active":
        raise HTTPException(403, "This account is suspended — contact an administrator")
    audit(db, u, "auth.login", u.email)
    db.commit()
    hours = workspace.get_settings(db, u.tenant_id)["session_hours"]
    return TokenOut(access_token=create_token(u.id, u.tenant_id, hours * 60), user=user_out(u))


@router.get("/demo-accounts")
def demo_accounts(db: Session = Depends(get_db)):
    """Seeded demo users for the sign-in page; empty unless DEMO_ACCOUNTS is on."""
    if not settings.demo_accounts:
        return []
    users = db.scalars(select(User).where(User.email.like(f"%{DEMO_DOMAIN}"), User.status == "Active").order_by(User.name))
    return [{"name": u.name, "email": u.email, "role": u.role} for u in users]


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user_out(user)


class ProfileIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str = Field(max_length=200)


@router.patch("/me", response_model=UserOut)
def update_me(body: ProfileIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    name = body.name.strip()
    if name != user.name:
        user.name = name
        audit(db, user, "account.update", user.email, fields=["name"])
        db.commit()
    return user_out(user)


@router.post("/me/password", status_code=204)
def change_password(body: PasswordChangeIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(422, "Your current password is incorrect")
    n = workspace.get_settings(db, user.tenant_id)["password_min_length"]
    if len(body.new_password) < n:
        raise HTTPException(422, f"Passwords need at least {n} characters")
    if body.new_password == body.current_password:
        raise HTTPException(422, "Choose a password different from the current one")
    user.password_hash = hash_password(body.new_password)
    audit(db, user, "account.password", user.email)
    db.commit()


@router.get("/me/activity")
def my_activity(limit: int = 20, db: Session = Depends(get_db), user: User = Depends(current_user)):
    """Recent sign-ins and account changes for the signed-in user."""
    q = (select(AuditEvent).where(AuditEvent.tenant_id == user.tenant_id, AuditEvent.target == user.email,
                                  AuditEvent.action.in_(["auth.login", "account.update", "account.password",
                                                         "admin.user.update", "admin.user.password"]))
         .order_by(AuditEvent.at.desc()).limit(min(limit, 100)))
    tenant = db.get(Tenant, user.tenant_id)
    return {"workspace": tenant.name, "created_at": user.created_at,
            "session_hours": workspace.get_settings(db, user.tenant_id)["session_hours"],
            "events": [{"id": e.id, "action": e.action, "actor": e.actor, "at": e.at} for e in db.scalars(q)]}
