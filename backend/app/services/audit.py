from collections.abc import Mapping
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.persistence.models import AuditEvent

OPERATOR = "operator"


def record(
    db: Session,
    now: datetime,
    actor: str,
    action: str,
    resource_type: str,
    resource_id: str,
    details: Mapping[str, Any] | None = None,
) -> None:
    db.add(
        AuditEvent(
            at=now,
            actor=actor,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            details=dict(details or {}),
        )
    )
