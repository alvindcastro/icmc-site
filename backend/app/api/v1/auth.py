from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app.api.deps import App, Current, StaffSession, csrf_invalid, no_query
from app.context import Context
from app.errors import ApiError
from app.schemas.auth import Credentials, CsrfOut, Empty, SessionOut, UserOut
from app.services import business_settings, credentials, sessions
from app.services.sessions import SESSION_COOKIE

router = APIRouter(prefix="/auth", tags=["auth"], dependencies=[Depends(no_query)])


def _session_out(session: StaffSession) -> SessionOut:
    user = session.user
    return SessionOut(
        user=UserOut(
            id=user.id, username=user.username, display_name=user.display_name, role="staff"
        ),
        csrf_token=session.csrf_token,
        idle_expires_at=session.idle_expires_at,
        absolute_expires_at=session.absolute_expires_at,
    )


def _secure(app: Context, db: Session) -> bool:
    # A cookie over plain HTTP is a development convenience. Live settings always get Secure,
    # whatever the process was configured with.
    return app.config.cookie_secure or business_settings.is_live(db)


def _set_cookie(response: Response, value: str, secure: bool) -> None:
    # No lifetime of its own: the server alone decides how long the session lasts.
    response.set_cookie(
        SESSION_COOKIE, value, httponly=True, secure=secure, samesite="lax", path="/"
    )


@router.get("/csrf")
def csrf(request: Request, response: Response, app: App) -> CsrfOut:
    """The CSRF token of the current session, starting a pre-auth session when there is none."""
    now = app.clock()
    cookie = request.cookies.get(SESSION_COOKIE)
    with app.database.read() as db:
        row = sessions.find(db, cookie)
        if row is not None and sessions.state(row, now) == "live":
            return CsrfOut(csrf_token=row.csrf_token)
    with app.database.write() as db:
        value, row = sessions.open_pre_auth(db, now, app.config)
        token = row.csrf_token
        secure = _secure(app, db)
    _set_cookie(response, value, secure)
    return CsrfOut(csrf_token=token)


@router.post("/sign-in")
def sign_in(body: Credentials, request: Request, response: Response, app: App) -> SessionOut:
    now = app.clock()
    with app.database.write() as db:
        current = sessions.find(db, request.cookies.get(SESSION_COOKIE))
        if current is None or sessions.state(current, now) != "live":
            raise csrf_invalid()
        # A failure has to be recorded, so the refusals are raised after the transaction commits.
        secure = _secure(app, db)
        wait = sessions.sign_in_locked_for(db, now, app.config)
        user = None if wait else credentials.check(db, body.username, body.token)
        if user is not None:
            sessions.forget_sign_in_failures(db)
            # A new cookie and CSRF token: nothing held before sign-in stays valid after it.
            sessions.end(current, now)
            value, row = sessions.open_for(db, user.id, now, app.config)
            signed_in = _session_out(
                StaffSession(user, row.csrf_token, row.idle_expires_at, row.absolute_expires_at)
            )
        elif wait is None:
            sessions.record_sign_in_failure(db, now, app.config)
    if wait is not None:
        raise ApiError(
            429,
            "rate_limited",
            "Too many failed sign-in attempts. Try again later.",
            headers={"Retry-After": str(wait)},
        )
    if user is None:
        raise ApiError(401, "invalid_credentials", "The username or token is incorrect.")
    _set_cookie(response, value, secure)
    return signed_in


@router.get("/session")
def session(current: Current) -> SessionOut:
    return _session_out(current)


@router.post("/sign-out", status_code=204)
def sign_out(body: Empty, request: Request, app: App) -> Response:
    """End the session and clear the cookie. Signing out of a session that is already over
    succeeds too, so a browser that lost the first answer can always finish."""
    now = app.clock()
    with app.database.write() as db:
        row = sessions.find(db, request.cookies.get(SESSION_COOKIE))
        if row is not None:
            sessions.end(row, now)
        secure = _secure(app, db)
    response = Response(status_code=204)
    response.delete_cookie(SESSION_COOKIE, path="/", secure=secure, httponly=True, samesite="lax")
    return response
