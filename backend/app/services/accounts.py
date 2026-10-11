from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import OperatorError
from app.ids import new_id
from app.persistence.models import StaffUser
from app.services import sessions

# The pilot has one account. It uses the staff permission set; there is no registration.
ADMIN = "admin"


def _admin(db: Session) -> StaffUser | None:
    return db.scalar(select(StaffUser).where(StaffUser.username == ADMIN))


def has_token(db: Session) -> bool:
    user = _admin(db)
    return user is not None and bool(user.token_hash)


def set_token(db: Session, token_hash: str, now: datetime) -> None:
    """Give the admin account its first token, creating the account if this is a new database."""
    user = _admin(db)
    if user is not None and user.token_hash:
        raise OperatorError("A token is already set. Use `food-admin token rotate` to replace it.")
    if user is None:
        user = StaffUser(
            id=new_id("usr"), username=ADMIN, display_name="Admin", role="staff", created_at=now
        )
        db.add(user)
    user.token_hash = token_hash
    user.token_set_at = now


def rotate_token(db: Session, token_hash: str, now: datetime) -> int:
    """Replace the admin token and end every open session; returns how many were open."""
    user = _admin(db)
    if user is None or not user.token_hash:
        raise OperatorError("No token is set yet. Use `food-admin token set` first.")
    user.token_hash = token_hash
    user.token_set_at = now
    return sessions.end_all(db, user.id, now)
