from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from httpx2 import Response

ORIGIN = "https://testserver"
API = "/api/v1"
Cli = Callable[..., int]


class FakeClock:
    """A clock the test moves by hand, so expiry never depends on real time."""

    def __init__(self) -> None:
        self.now = datetime(2026, 10, 10, 19, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now += timedelta(**delta)


def sqlite_url(path: Path) -> str:
    return f"sqlite:///{path.as_posix()}"


def error_of(response: Response, status: int, code: str) -> dict[str, Any]:
    """The error envelope of a response, after checking its status, code and exact shape."""
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"error"}
    error: dict[str, Any] = body["error"]
    assert set(error) == {"code", "message", "request_id", "field_errors", "details"}
    assert error["code"] == code
    assert error["message"].strip()
    assert error["request_id"] == response.headers["X-Request-ID"]
    assert isinstance(error["field_errors"], list)
    assert isinstance(error["details"], dict)
    return error


TOKEN = "correct horse battery staple"


def csrf(client: Any) -> str:
    token: str = client.get(f"{API}/auth/csrf").json()["csrf_token"]
    return token


def sign_in(client: Any, token: str = TOKEN, username: str = "admin") -> Response:
    """Sign in the way the frontend does: fetch a CSRF token, then post the credentials."""
    response: Response = client.post(
        f"{API}/auth/sign-in",
        json={"username": username, "token": token},
        headers={"X-CSRF-Token": csrf(client)},
    )
    return response


def set_cookie(response: Response, name: str) -> dict[str, str]:
    """The attributes of the one Set-Cookie header for `name`, with `value` for its value."""
    headers = [
        header
        for header in response.headers.get_list("set-cookie")
        if header.startswith(f"{name}=")
    ]
    assert len(headers) == 1, headers
    value, *attributes = [part.strip() for part in headers[0].split(";")]
    parsed = {"value": value.partition("=")[2]}
    for attribute in attributes:
        key, _, setting = attribute.partition("=")
        parsed[key.lower()] = setting
    return parsed
