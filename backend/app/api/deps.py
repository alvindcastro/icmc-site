import hmac
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any

from fastapi import Body, Depends, Request
from sqlalchemy.orm import Session

from app.context import Context
from app.errors import ApiError, FieldError, invalid, pointer
from app.persistence.models import AuthSession, StaffUser
from app.services import sessions
from app.services.sessions import SESSION_COOKIE

_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def context(request: Request) -> Context:
    state = request.app.state
    return Context(state.database, state.clock, state.settings)


@dataclass(frozen=True)
class StaffSession:
    user: StaffUser
    csrf_token: str
    idle_expires_at: datetime
    absolute_expires_at: datetime


def csrf_invalid() -> ApiError:
    return ApiError(
        403, "csrf_invalid", "The security token for this page is out of date. Try again."
    )


def guard_mutation(request: Request, app: Annotated[Context, Depends(context)]) -> None:
    """Refuse a request that could change something unless it comes from an approved origin
    and carries the CSRF token of the session its cookie names.

    The token is checked against the session whatever its state, so an expired session can
    still be told it expired, and a lost sign-out can be repeated. Routes decide what state
    they need.
    """
    if request.method in _SAFE_METHODS:
        return
    if request.headers.get("Origin") not in app.config.origins:
        raise csrf_invalid()
    with app.database.read() as db:
        row = sessions.find(db, request.cookies.get(SESSION_COOKIE))
    sent = request.headers.get("X-CSRF-Token", "")
    if row is None or not hmac.compare_digest(sent.encode(), row.csrf_token.encode()):
        raise csrf_invalid()


def no_query(request: Request) -> None:
    """For routes without query parameters: an unknown one is refused, not ignored."""
    if request.query_params:
        raise invalid(
            *(
                FieldError(pointer("query", name), "unknown_field", "This field is not accepted.")
                for name in dict.fromkeys(request.query_params.keys())
            )
        )


def _signed_in(db: Session, request: Request, now: datetime) -> tuple[AuthSession, StaffUser]:
    row = sessions.find(db, request.cookies.get(SESSION_COOKIE))
    user = db.get(StaffUser, row.user_id) if row is not None and row.user_id else None
    if row is None or user is None or row.ended_at is not None:
        raise ApiError(401, "unauthenticated", "Sign in to continue.")
    if sessions.state(row, now) == "expired":
        raise ApiError(401, "session_expired", "Your session has expired. Sign in again.")
    return row, user


def _snapshot(row: AuthSession, user: StaffUser) -> StaffSession:
    return StaffSession(user, row.csrf_token, row.idle_expires_at, row.absolute_expires_at)


def current_session(request: Request, app: Annotated[Context, Depends(context)]) -> StaffSession:
    """The signed-in session, read without renewing it: asking about a session is not activity."""
    with app.database.read() as db:
        return _snapshot(*_signed_in(db, request, app.clock()))


def staff_session(request: Request, app: Annotated[Context, Depends(context)]) -> StaffSession:
    """The signed-in session for a business request, which counts as activity whatever the
    request's own outcome, and so renews the idle limit."""
    now = app.clock()
    with app.database.write() as db:
        row, user = _signed_in(db, request, now)
        sessions.renew(row, now, app.config)
        return _snapshot(row, user)


App = Annotated[Context, Depends(context)]
Current = Annotated[StaffSession, Depends(current_session)]
Staff = Annotated[StaffSession, Depends(staff_session)]

# A keyed mutation takes its body as plain JSON and validates it inside the operation, so that
# a refusal is recorded under the key like any other outcome.
JsonBody = Annotated[Any, Body()]
