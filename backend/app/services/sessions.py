import hashlib
import secrets
from datetime import datetime, timedelta
from math import ceil
from typing import Literal

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from app.config import Settings
from app.persistence.models import AuthSession, SignInFailure

SESSION_COOKIE = "food_session"


def _hash(cookie: str) -> str:
    return hashlib.sha256(cookie.encode("utf-8", "surrogatepass")).hexdigest()


def find(db: Session, cookie: str | None) -> AuthSession | None:
    return db.get(AuthSession, _hash(cookie)) if cookie else None


def state(row: AuthSession, now: datetime) -> Literal["live", "expired", "ended"]:
    if row.ended_at is not None:
        return "ended"
    if now >= row.idle_expires_at or now >= row.absolute_expires_at:
        return "expired"
    return "live"


def _start(
    db: Session, now: datetime, user_id: str | None, idle: int, absolute: int
) -> tuple[str, AuthSession]:
    cookie = secrets.token_urlsafe(32)
    row = AuthSession(
        id_hash=_hash(cookie),
        user_id=user_id,
        csrf_token=secrets.token_urlsafe(32),
        created_at=now,
        idle_expires_at=now + timedelta(seconds=min(idle, absolute)),
        absolute_expires_at=now + timedelta(seconds=absolute),
        ended_at=None,
    )
    db.add(row)
    return cookie, row


def open_pre_auth(db: Session, now: datetime, config: Settings) -> tuple[str, AuthSession]:
    """A short-lived session with no user, which exists only to carry a CSRF token to sign-in.

    Anyone can ask for one, so the ones that are over are cleared away as new ones arrive.
    """
    db.execute(
        delete(AuthSession).where(
            AuthSession.user_id.is_(None),
            or_(AuthSession.ended_at.is_not(None), AuthSession.absolute_expires_at <= now),
        )
    )
    return _start(db, now, None, config.pre_auth_seconds, config.pre_auth_seconds)


def open_for(db: Session, user_id: str, now: datetime, config: Settings) -> tuple[str, AuthSession]:
    return _start(db, now, user_id, config.session_idle_seconds, config.session_absolute_seconds)


def renew(row: AuthSession, now: datetime, config: Settings) -> None:
    """Push the idle limit out from now, but never past the absolute limit."""
    row.idle_expires_at = min(
        now + timedelta(seconds=config.session_idle_seconds), row.absolute_expires_at
    )


def end(row: AuthSession, now: datetime) -> None:
    if row.ended_at is None:
        row.ended_at = now


def end_all(db: Session, user_id: str, now: datetime) -> int:
    """End every session of a user; returns how many were still open."""
    unended = (AuthSession.user_id == user_id, AuthSession.ended_at.is_(None))
    still_open = db.scalar(
        select(func.count())
        .select_from(AuthSession)
        .where(*unended, AuthSession.idle_expires_at > now, AuthSession.absolute_expires_at > now)
    )
    db.execute(update(AuthSession).where(*unended).values(ended_at=now))
    return still_open or 0


def sign_in_locked_for(db: Session, now: datetime, config: Settings) -> int | None:
    """Seconds until sign-in may be tried again, or None while it is open.

    Failures are counted for the whole server, not per username: the pilot has one account,
    and a count per name would tell an attacker which names exist.
    """
    window = timedelta(seconds=config.sign_in_window_seconds)
    recent = db.scalars(
        select(SignInFailure.failed_at)
        .where(SignInFailure.failed_at > now - window)
        .order_by(SignInFailure.failed_at.desc(), SignInFailure.id.desc())
        .limit(config.sign_in_max_failures)
    ).all()
    if len(recent) < config.sign_in_max_failures:
        return None
    return max(1, ceil((recent[-1] + window - now).total_seconds()))


def record_sign_in_failure(db: Session, now: datetime, config: Settings) -> None:
    window = timedelta(seconds=config.sign_in_window_seconds)
    db.execute(delete(SignInFailure).where(SignInFailure.failed_at <= now - window))
    db.add(SignInFailure(failed_at=now))


def forget_sign_in_failures(db: Session) -> None:
    db.execute(delete(SignInFailure))
