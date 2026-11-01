from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import audit, current_user
from app.core.security import ROLES, create_token, verify_password
from app.models import User
from app.schemas import LoginIn, TokenOut, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


def user_out(u: User) -> UserOut:
    return UserOut(id=u.id, name=u.name, email=u.email, role=u.role, status=u.status, permissions=ROLES.get(u.role, []))


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, db: Session = Depends(get_db)):
    u = db.scalar(select(User).where(User.email == body.email.strip().lower()))
    if not u or not verify_password(body.password, u.password_hash):
        raise HTTPException(401, "Email or password is incorrect")
    if u.status != "Active":
        raise HTTPException(403, "This account is suspended — contact an administrator")
    audit(db, u, "auth.login", u.email)
    db.commit()
    return TokenOut(access_token=create_token(u.id, u.tenant_id), user=user_out(u))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user_out(user)
