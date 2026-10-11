"""The published API description: FastAPI's own, corrected where this API departs from it.

Three things FastAPI cannot know by itself:

- A keyed save reads its body as plain JSON, so that a refusal can be stored under the
  operation key like a success. Each such route says which model it reads with `keyed(...)`.
- Every refusal is the contract's error envelope, not the framework's validation error.
- A request that changes something carries the CSRF token of its session in a header.
"""

from typing import Any, Literal, get_args

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from pydantic import BaseModel
from pydantic.json_schema import models_json_schema

_REFERENCE = "#/components/schemas/{model}"
_KEYED: list[type[BaseModel]] = []

ErrorCode = Literal[
    "invalid_json",
    "unauthenticated",
    "session_expired",
    "invalid_credentials",
    "action_forbidden",
    "csrf_invalid",
    "not_found",
    "method_not_allowed",
    "version_conflict",
    "operation_payload_mismatch",
    "operation_in_progress",
    "operation_closed",
    "quote_stale",
    "action_not_allowed",
    "settings_unconfirmed",
    "menu_unconfirmed",
    "insufficient_stock",
    "validation_failed",
    "rate_limited",
    "internal_error",
    "temporarily_unavailable",
]
ERROR_CODES: frozenset[str] = frozenset(get_args(ErrorCode))


class FieldErrorOut(BaseModel):
    # A JSON Pointer into the request body, or `/query/<name>` or `/header/<name>`.
    path: str
    code: str
    message: str


class ErrorOut(BaseModel):
    code: ErrorCode
    message: str
    request_id: str
    # Empty unless particular fields of the request were at fault.
    field_errors: list[FieldErrorOut]
    # What a client needs to recover, such as `latest_resource` on a version conflict.
    details: dict[str, Any]


class ErrorEnvelope(BaseModel):
    """How every refusal is answered, whatever its status."""

    error: ErrorOut


def keyed(model: type[BaseModel]) -> dict[str, Any]:
    """The `openapi_extra` of a keyed save: the body it reads and the operation key it needs."""
    if model not in _KEYED:
        _KEYED.append(model)
    return {
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {"schema": {"$ref": _REFERENCE.format(model=model.__name__)}}
            },
        },
        "parameters": [
            {
                "name": "Idempotency-Key",
                "in": "header",
                "required": True,
                "description": "A UUID the client makes for this save. Sending the same request "
                "again with the same key returns the first answer and changes nothing more.",
                "schema": {"type": "string", "format": "uuid"},
            }
        ],
    }


_CSRF = {
    "name": "X-CSRF-Token",
    "in": "header",
    "required": True,
    "description": "The `csrf_token` of the session the cookie names, from `GET /auth/csrf` "
    "or the sign-in answer.",
    "schema": {"type": "string"},
}
_REFUSAL = {
    "description": "A refusal, in the error envelope. The status says what kind.",
    "content": {"application/json": {"schema": {"$ref": _REFERENCE.format(model="ErrorEnvelope")}}},
}


def describe(app: FastAPI) -> dict[str, Any]:
    """Build the description once and keep it, as FastAPI's own `openapi()` does."""
    if app.openapi_schema is None:
        schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
        schemas = schema.setdefault("components", {}).setdefault("schemas", {})
        _, extra = models_json_schema(
            [(model, "validation") for model in _KEYED] + [(ErrorEnvelope, "serialization")],
            ref_template=_REFERENCE,
        )
        for name, definition in extra.get("$defs", {}).items():
            schemas.setdefault(name, definition)
        for name in ("HTTPValidationError", "ValidationError"):
            schemas.pop(name, None)
        for path, entries in schema["paths"].items():
            for method, operation in entries.items():
                responses = operation["responses"]
                responses.pop("422", None)
                responses["default"] = _REFUSAL
                body = operation.get("requestBody", {}).get("content", {}).get("application/json")
                if body is not None:
                    # A reference stands alone; the title FastAPI gave the untyped body goes.
                    reference = body["schema"].get("$ref")
                    if reference is not None:
                        body["schema"] = {"$ref": reference}
                if path.startswith("/api/") and method not in ("get", "head"):
                    operation.setdefault("parameters", []).append(_CSRF)
        app.openapi_schema = schema
    return app.openapi_schema
