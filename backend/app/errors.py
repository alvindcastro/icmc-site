from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError
from sqlalchemy.exc import OperationalError
from starlette.exceptions import HTTPException

from app.ids import new_id


@dataclass(frozen=True)
class FieldError:
    path: str
    code: str
    message: str


class ApiError(Exception):
    """A failure the client is told about, in the contract's error envelope."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        field_errors: Sequence[FieldError] = (),
        details: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.field_errors = tuple(field_errors)
        self.details = dict(details or {})
        self.headers = dict(headers or {})


class OperatorError(Exception):
    """A problem the operator can fix, reported by a command without a traceback."""


def pointer(*parts: str | int) -> str:
    """A JSON Pointer (RFC 6901) to a place in the request, such as `/draft/items/0/quantity`."""
    return "".join("/" + str(part).replace("~", "~0").replace("/", "~1") for part in parts)


def invalid(*field_errors: FieldError) -> ApiError:
    return ApiError(
        422, "validation_failed", "Check the highlighted fields.", field_errors=field_errors
    )


def error_response(request_id: str, error: ApiError) -> JSONResponse:
    return JSONResponse(
        {
            "error": {
                "code": error.code,
                "message": error.message,
                "request_id": request_id,
                "field_errors": [asdict(field) for field in error.field_errors],
                "details": error.details,
            }
        },
        status_code=error.status,
        headers=error.headers,
    )


# Framework error types with a wording of our own; any other keeps the framework's type as its
# code and its message, neither of which repeats the submitted value.
_WORDING = {
    "missing": ("required", "This field is required."),
    "extra_forbidden": ("unknown_field", "This field is not accepted."),
}
_STATUS_CODES = {404: "not_found", 405: "method_not_allowed"}
_STATUS_MESSAGES = {
    404: "This record or address does not exist.",
    405: "This address does not support that method.",
}


def _field_error(error: Mapping[str, Any]) -> FieldError:
    source, *rest = error["loc"]
    # Body errors point into the body itself; query, path and header errors name their source.
    path = pointer(*rest) if source == "body" else pointer(source, *rest)
    code, message = _WORDING.get(error["type"], (error["type"], error["msg"]))
    return FieldError(path, code, message)


def _request_id(request: Request) -> str:
    request_id: str = getattr(request.state, "request_id", "") or new_id("req")
    return request_id


def install(app: FastAPI) -> None:
    """Answer every handled failure in the envelope instead of the framework's own shapes."""

    @app.exception_handler(ApiError)
    def api_error(request: Request, error: ApiError) -> JSONResponse:
        return error_response(_request_id(request), error)

    @app.exception_handler(RequestValidationError)
    def validation_error(request: Request, error: RequestValidationError) -> JSONResponse:
        errors = error.errors()
        if any(item["type"] == "json_invalid" for item in errors):
            failure = ApiError(400, "invalid_json", "The request body is not valid JSON.")
        else:
            failure = invalid(*(_field_error(item) for item in errors))
        return error_response(_request_id(request), failure)

    @app.exception_handler(OperationalError)
    def database_busy(request: Request, error: OperationalError) -> JSONResponse:
        # Another write held the lock for longer than this request was willing to wait.
        if "database is locked" not in str(error.orig):
            raise error
        failure = ApiError(
            503,
            "temporarily_unavailable",
            "The server is busy. Try again in a moment.",
            headers={"Retry-After": "1"},
        )
        return error_response(_request_id(request), failure)

    @app.exception_handler(HTTPException)
    def http_error(request: Request, error: HTTPException) -> JSONResponse:
        failure = ApiError(
            error.status_code,
            _STATUS_CODES.get(error.status_code, "request_failed"),
            _STATUS_MESSAGES.get(error.status_code, "The request could not be completed."),
            headers=error.headers,
        )
        return error_response(_request_id(request), failure)


def parse[T: BaseModel](model: type[T], payload: object) -> T:
    """Check a JSON body against its model, reporting every problem as a field error."""
    try:
        return model.model_validate(payload)
    except ValidationError as error:
        problems = error.errors(include_url=False, include_input=False)
        # Raised bare: the validation error itself holds the submitted values.
        raise invalid(
            *(_field_error({**problem, "loc": ("body", *problem["loc"])}) for problem in problems)
        ) from None
