import hashlib
import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from fastapi import Request, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.context import Context
from app.errors import ApiError, FieldError, OperatorError, error_response, invalid
from app.ids import new_id
from app.persistence.models import Operation

_HEADER = "/header/Idempotency-Key"
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


@dataclass(frozen=True)
class Done:
    """What a keyed change produced: the answer to send, and the record it concerns."""

    status: int
    resource_type: str
    resource_id: str
    body: BaseModel | Mapping[str, Any]


def _json(value: object) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def fingerprint(method: str, path: str, payload: object) -> str:
    """What makes two requests the same request: method, path and the JSON body's content.

    Key order and spacing in the body do not matter. Cookies and CSRF tokens are not part of it.
    """
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(
        f"{method}\n{path}\n{canonical}".encode("utf-8", "surrogatepass")
    ).hexdigest()


def key_of(request: Request) -> str:
    """The request's operation key, checked: a UUID, compared without regard to letter case."""
    sent = request.headers.get("Idempotency-Key")
    if sent is None:
        raise invalid(FieldError(_HEADER, "required", "An operation identifier is required."))
    key = sent.lower()
    if not _UUID.fullmatch(key):
        raise invalid(
            FieldError(_HEADER, "invalid_operation_id", "The operation identifier must be a UUID.")
        )
    return key


def execute(
    app: Context, request: Request, payload: object, change: Callable[[Session], Done]
) -> Response:
    """Run a keyed change exactly once and answer with its outcome, now or on any repeat.

    The operation record, the change and the stored answer commit in one write transaction, so
    a crash leaves none of them and a status check always tells the truth. A refusal is stored
    like a success, after undoing whatever the change had written, so a late copy of a refused
    request can never succeed. An identical repeat gets the stored answer without the change
    being looked at again.
    """
    key = key_of(request)
    if not isinstance(payload, dict):
        raise invalid(FieldError("", "invalid_type", "Send a JSON object."))
    method, path = request.method, request.url.path
    asked = fingerprint(method, path, payload)
    now = app.clock()
    with app.database.write() as db:
        known = db.get(Operation, key)
        if known is not None:
            if known.fingerprint != asked:
                raise ApiError(
                    409,
                    "operation_payload_mismatch",
                    "This operation identifier belongs to a different request.",
                )
            if known.state == "processing":
                raise ApiError(
                    409,
                    "operation_in_progress",
                    "This save is still being processed.",
                    headers={"Retry-After": "2"},
                )
            return Response(
                known.body,
                status_code=known.http_status or 200,
                media_type="application/json",
                headers={"Idempotency-Replayed": "true"},
            )
        operation = Operation(
            key=key,
            method=method,
            path=path,
            fingerprint=asked,
            state="processing",
            started_at=now,
            completed_at=now,
        )
        headers: dict[str, str] = {}
        try:
            with db.begin_nested():
                done = change(db)
        except ApiError as refusal:
            if refusal.status >= 500:
                raise
            answer = error_response(request.state.request_id, refusal)
            operation.state = "rejected"
            operation.http_status = refusal.status
            operation.body = bytes(answer.body).decode()
            headers = refusal.headers
        else:
            body = (
                done.body.model_dump(mode="json") if isinstance(done.body, BaseModel) else done.body
            )
            operation.state = "succeeded"
            operation.http_status = done.status
            operation.resource_type = done.resource_type
            operation.resource_id = done.resource_id
            operation.body = _json(body)
        db.add(operation)
        return Response(
            operation.body,
            status_code=operation.http_status,
            media_type="application/json",
            headers=headers,
        )


def find(db: Session, key: str) -> Operation | None:
    key = key.lower()
    return db.get(Operation, key) if _UUID.fullmatch(key) else None


def unresolved(db: Session) -> list[Operation]:
    """Operations that were admitted and never finished. Normally there are none."""
    return list(
        db.scalars(
            select(Operation)
            .where(Operation.state == "processing")
            .order_by(Operation.started_at, Operation.key)
        )
    )


def close(db: Session, key: str, reason: str, now: datetime) -> None:
    """Record a key the server never saw as rejected, so the browser holding it can move on.

    The record matches no real request, so if the original turns up later it is refused.
    """
    key = key.lower()
    if not _UUID.fullmatch(key):
        raise OperatorError("An operation identifier is a UUID, as shown by the frontend.")
    if not reason.strip():
        raise OperatorError("Give a reason; staff will see it.")
    known = db.get(Operation, key)
    if known is not None:
        raise OperatorError(f"This operation is already recorded as {known.state}.")
    refusal = ApiError(
        409,
        "operation_closed",
        f"This save did not take effect and was closed by the operator: {reason.strip()}",
    )
    db.add(
        Operation(
            key=key,
            method="",
            path="",
            fingerprint="",
            state="rejected",
            http_status=refusal.status,
            body=bytes(error_response(new_id("req"), refusal).body).decode(),
            started_at=now,
            completed_at=now,
        )
    )
