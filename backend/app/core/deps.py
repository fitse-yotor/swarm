from collections.abc import Callable

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.security import decode_token
from app.models import AuditEvent, Case, User
from app.services.workspace import permissions_of

bearer = HTTPBearer(auto_error=False)


def current_user(creds: HTTPAuthorizationCredentials | None = Depends(bearer), db: Session = Depends(get_db)) -> User:
    if not creds:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        claims = decode_token(creds.credentials)
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired or invalid") from None
    user = db.get(User, claims["sub"])
    if not user or user.status != "Active":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account unavailable")
    return user


def has_perm(user: User, perm: str) -> bool:
    return perm in permissions_of(user)


def require(perm: str) -> Callable[..., User]:
    def dep(user: User = Depends(current_user)) -> User:
        if not has_perm(user, perm):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Your role does not include {perm}")
        return user
    return dep


def get_case(db: Session, user: User, case_id: str) -> Case:
    """Load a case inside the caller's tenant; other tenants' cases read as not found."""
    case = db.get(Case, case_id)
    if not case or case.tenant_id != user.tenant_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Case not found")
    if case.visibility == "Private" and case.owner_id != user.id and not has_perm(user, "admin.access"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Case not found")
    return case


def audit(db: Session, user: User | None, action: str, target: str, case_id: str | None = None,
          tenant_id: str | None = None, **meta) -> None:
    db.add(AuditEvent(tenant_id=tenant_id or (user.tenant_id if user else ""), case_id=case_id,
                      actor=user.name if user else "System", action=action, target=target, meta=meta))
