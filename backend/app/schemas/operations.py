import json
from typing import Any, Literal

from pydantic import BaseModel

from app.persistence.models import Operation
from app.values import Instant


class ResultOut(BaseModel):
    http_status: int
    body: Any


class OperationOut(BaseModel):
    operation_id: str
    state: Literal["processing", "succeeded", "rejected"]
    resource_type: str | None
    resource_id: str | None
    result: ResultOut | None
    # The original error envelope with its HTTP status beside it.
    error: dict[str, Any] | None
    started_at: Instant
    completed_at: Instant | None


def operation_out(operation: Operation) -> OperationOut:
    stored: Any = json.loads(operation.body or "{}")
    succeeded, rejected = operation.state == "succeeded", operation.state == "rejected"
    return OperationOut.model_validate(
        {
            "operation_id": operation.key,
            "state": operation.state,
            "resource_type": operation.resource_type if succeeded else None,
            "resource_id": operation.resource_id if succeeded else None,
            "result": {"http_status": operation.http_status, "body": stored} if succeeded else None,
            "error": {"http_status": operation.http_status, **stored} if rejected else None,
            "started_at": operation.started_at,
            "completed_at": operation.completed_at if succeeded or rejected else None,
        }
    )
