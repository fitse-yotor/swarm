"""Settings page: view and edit the deployment's .env files. Administrators only (`admin.access`)."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import audit, require
from app.models import User
from app.services import envfiles, workspace

router = APIRouter(prefix="/admin/env", tags=["admin"])
admin_only = require(workspace.ADMIN_PERM)


class EnvChanges(BaseModel):
    # KEY -> new value, or null to remove the key from the file
    changes: dict[str, str | None] = Field(default_factory=dict, max_length=200)


@router.get("")
def list_env_files(admin: User = Depends(admin_only)):
    return {"files": [envfiles.describe(f) for f in envfiles.available()],
            "note": "Changes are saved to disk and take effect after the API and worker restart "
                    "(Docker: docker compose up -d --force-recreate api worker)."}


@router.put("/{file_id}")
def update_env_file(file_id: str, body: EnvChanges, db: Session = Depends(get_db), admin: User = Depends(admin_only)):
    if file_id not in envfiles.available():
        raise HTTPException(404, "Unknown settings file")
    try:
        changed = envfiles.write(file_id, body.changes)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    except OSError as e:
        raise HTTPException(409, f"Could not write the file: {e.strerror or e}") from e
    if changed:
        # Keys only: values (and secrets) never go into the audit log.
        audit(db, admin, "settings.env.update", f"{envfiles.FILES[file_id][1].name} ({file_id})", keys=changed)
        db.commit()
    return {"changed": changed, "restart_required": bool(changed), "file": envfiles.describe(file_id)}
