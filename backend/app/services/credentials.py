import base64
import hashlib
import hmac
import secrets
from functools import cache

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.persistence.models import StaffUser

# scrypt cost: about 16 MiB and tens of milliseconds per check.
_N, _R, _P, _LENGTH = 2**14, 8, 1, 32


def _derive(token: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    # The token is hashed exactly as entered, whatever characters it holds.
    return hashlib.scrypt(
        token.encode("utf-8", "surrogatepass"), salt=salt, n=n, r=r, p=p, dklen=_LENGTH
    )


def hash_token(token: str) -> str:
    """A salted hash of a sign-in token, safe to store. The token cannot be recovered."""
    salt = secrets.token_bytes(16)
    derived = _derive(token, salt, _N, _R, _P)
    parts = [
        str(_N),
        str(_R),
        str(_P),
        *(base64.b64encode(part).decode() for part in (salt, derived)),
    ]
    return "$".join(["scrypt", *parts])


@cache
def _nobody() -> str:
    # Checked when there is no account or no token, so that answer takes as long as a wrong one.
    return hash_token(secrets.token_urlsafe(32))


def verify_token(token: str, stored: str | None) -> bool:
    _, n, r, p, salt, expected = (stored or _nobody()).split("$")
    derived = _derive(token, base64.b64decode(salt), int(n), int(r), int(p))
    return hmac.compare_digest(derived, base64.b64decode(expected)) and stored is not None


def check(db: Session, username: str, token: str) -> StaffUser | None:
    """The account for an exact username and token pair, or None without saying which was wrong."""
    user = db.scalar(select(StaffUser).where(StaffUser.username == username))
    return user if verify_token(token, user.token_hash if user else None) else None
