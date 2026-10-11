import logging
from collections.abc import Callable
from datetime import timedelta

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.deps import Staff, guard_mutation
from app.config import Settings
from app.errors import ApiError
from app.main import create_app
from app.persistence.database import Database
from app.persistence.models import AuthSession, StaffUser
from app.services.credentials import hash_token
from app.services.sessions import SESSION_COOKIE
from app.values import format_instant
from tests.support import API, ORIGIN, TOKEN, FakeClock, csrf, error_of, set_cookie, sign_in

Browser = Callable[..., TestClient]
WRONG = "not the right token at all"


@pytest.fixture(autouse=True)
def business(app: FastAPI) -> None:
    """Stand-ins for the business endpoints of later phases, wired like the real API router."""
    probe = APIRouter(prefix=API, dependencies=[Depends(guard_mutation)])

    @probe.get("/probe/orders")
    def read(staff: Staff) -> dict[str, str]:
        return {"served": staff.user.username}

    @probe.post("/probe/orders")
    def save(staff: Staff) -> dict[str, str]:
        return {"saved_by": staff.user.username}

    @probe.post("/probe/refused")
    def refused(staff: Staff) -> None:
        raise ApiError(409, "action_not_allowed", "This order is already complete.")

    app.include_router(probe)


def cookie_header(value: str) -> dict[str, str]:
    return {"Cookie": f"{SESSION_COOKIE}={value}"}


def session_cookie(client: TestClient) -> str:
    value = client.cookies.get(SESSION_COOKIE)
    assert value
    return value


# --- CSRF tokens and pre-auth sessions -------------------------------------------------------


def test_a_signed_out_browser_gets_a_csrf_token_and_an_opaque_session_cookie(
    client: TestClient,
) -> None:
    response = client.get(f"{API}/auth/csrf")

    assert response.status_code == 200
    assert set(response.json()) == {"csrf_token"}
    assert len(response.json()["csrf_token"]) >= 32
    cookie = set_cookie(response, SESSION_COOKIE)
    assert len(cookie["value"]) >= 32
    assert cookie["value"] != response.json()["csrf_token"]
    assert {"httponly", "secure"} <= set(cookie)
    assert (cookie["samesite"], cookie["path"]) == ("lax", "/")
    # A browser-session cookie: the server alone decides how long the session lasts.
    assert not {"max-age", "expires", "domain"} & set(cookie)


def test_the_csrf_token_is_stable_while_its_session_lasts(client: TestClient) -> None:
    first = client.get(f"{API}/auth/csrf")
    second = client.get(f"{API}/auth/csrf")

    assert second.json() == first.json()
    assert second.headers.get_list("set-cookie") == []


def test_the_database_never_holds_the_cookie_value(client: TestClient, database: Database) -> None:
    client.get(f"{API}/auth/csrf")

    with database.read() as session:
        stored = session.scalars(select(AuthSession.id_hash)).all()
    assert len(stored) == 1
    assert stored[0] != session_cookie(client)


def test_a_pre_auth_session_is_short_lived(
    client: TestClient, clock: FakeClock, admin: StaffUser
) -> None:
    stale = csrf(client)
    clock.advance(minutes=15)

    refused = client.post(
        f"{API}/auth/sign-in",
        json={"username": "admin", "token": TOKEN},
        headers={"X-CSRF-Token": stale},
    )
    error_of(refused, 403, "csrf_invalid")
    assert csrf(client) != stale
    assert sign_in(client).status_code == 200


def test_expired_pre_auth_sessions_do_not_pile_up(
    browser: Browser, clock: FakeClock, database: Database
) -> None:
    for _ in range(3):
        browser().get(f"{API}/auth/csrf")
    clock.advance(minutes=15)
    browser().get(f"{API}/auth/csrf")

    with database.read() as session:
        assert len(session.scalars(select(AuthSession)).all()) == 1


@pytest.mark.parametrize("cookie", [None, "pre-auth", "made-up-value"])
def test_without_a_signed_in_session_the_answer_is_unauthenticated(
    client: TestClient, cookie: str | None
) -> None:
    headers = {}
    if cookie == "pre-auth":
        client.get(f"{API}/auth/csrf")
    elif cookie:
        headers = cookie_header(cookie)

    error = error_of(client.get(f"{API}/auth/session", headers=headers), 401, "unauthenticated")
    assert error["field_errors"] == []
    error_of(client.get(f"{API}/probe/orders", headers=headers), 401, "unauthenticated")


# --- Sign-in ---------------------------------------------------------------------------------


def test_signing_in_returns_the_session_and_rotates_the_cookie_and_csrf_token(
    client: TestClient, clock: FakeClock, admin: StaffUser
) -> None:
    before_token = csrf(client)
    before_cookie = session_cookie(client)

    response = sign_in(client)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"user", "csrf_token", "idle_expires_at", "absolute_expires_at"}
    assert body["user"] == {
        "id": "usr_admin",
        "username": "admin",
        "display_name": "Admin",
        "role": "staff",
    }
    assert body["csrf_token"] != before_token
    assert body["idle_expires_at"] == format_instant(clock.now + timedelta(minutes=30))
    assert body["absolute_expires_at"] == format_instant(clock.now + timedelta(hours=12))
    cookie = set_cookie(response, SESSION_COOKIE)
    assert cookie["value"] != before_cookie
    assert {"httponly", "secure"} <= set(cookie)
    assert (cookie["samesite"], cookie["path"]) == ("lax", "/")
    assert TOKEN not in response.text


def test_the_pre_auth_session_ends_when_someone_signs_in_on_it(
    client: TestClient, browser: Browser, admin: StaffUser
) -> None:
    old_token = csrf(client)
    old_cookie = session_cookie(client)
    sign_in(client)

    thief = browser()
    error_of(
        thief.get(f"{API}/auth/session", headers=cookie_header(old_cookie)), 401, "unauthenticated"
    )
    replay = thief.post(
        f"{API}/auth/sign-in",
        json={"username": "admin", "token": TOKEN},
        headers={"X-CSRF-Token": old_token, **cookie_header(old_cookie)},
    )
    error_of(replay, 403, "csrf_invalid")


@pytest.mark.parametrize(
    ("username", "token"),
    [
        ("admin", WRONG),
        ("admin", TOKEN + " "),
        ("admin", " " + TOKEN),
        ("admin", TOKEN.upper()),
        ("Admin", TOKEN),
        ("admin ", TOKEN),
        ("nobody", TOKEN),
    ],
)
def test_a_wrong_pair_gets_one_generic_answer_and_no_session(
    client: TestClient, admin: StaffUser, username: str, token: str
) -> None:
    response = sign_in(client, token, username)

    error = error_of(response, 401, "invalid_credentials")
    assert error["message"] == "The username or token is incorrect."
    assert error["field_errors"] == []
    assert token not in response.text
    error_of(client.get(f"{API}/auth/session"), 401, "unauthenticated")


def test_the_token_is_compared_exactly_as_entered(
    client: TestClient, database: Database, clock: FakeClock
) -> None:
    spaced = "  spaces are part of it  "
    with database.write() as session:
        session.add(
            StaffUser(
                id="usr_admin",
                username="admin",
                display_name="Admin",
                role="staff",
                token_hash=hash_token(spaced),
                token_set_at=clock.now,
                created_at=clock.now,
            )
        )

    error_of(sign_in(client, spaced.strip()), 401, "invalid_credentials")
    assert sign_in(client, spaced).status_code == 200


@pytest.mark.parametrize(
    ("body", "fields"),
    [
        ({"username": "", "token": TOKEN}, {"/username"}),
        ({"username": "   ", "token": TOKEN}, {"/username"}),
        ({"username": "admin", "token": ""}, {"/token"}),
        ({"username": "admin", "token": " \t "}, {"/token"}),
        ({"username": "admin"}, {"/token"}),
        ({}, {"/username", "/token"}),
        ({"username": 5, "token": TOKEN}, {"/username"}),
        ({"username": "admin", "token": None}, {"/token"}),
        ({"username": "a" * 201, "token": TOKEN}, {"/username"}),
        ({"username": "admin", "token": "t" * 1025}, {"/token"}),
        ({"username": "admin", "token": TOKEN, "remember": True}, {"/remember"}),
    ],
)
def test_blank_malformed_or_unknown_fields_are_field_errors(
    client: TestClient, admin: StaffUser, body: dict[str, object], fields: set[str]
) -> None:
    response = client.post(f"{API}/auth/sign-in", json=body, headers={"X-CSRF-Token": csrf(client)})

    error = error_of(response, 422, "validation_failed")
    assert {field["path"] for field in error["field_errors"]} == fields
    assert TOKEN not in response.text


def test_a_token_that_is_not_valid_text_is_refused_without_a_crash(
    client: TestClient, admin: StaffUser
) -> None:
    # Half of a surrogate pair: legal in JSON, impossible to encode as text.
    response = client.post(
        f"{API}/auth/sign-in",
        content=b'{"username": "admin", "token": "half a pair \\ud83d"}',
        headers={"X-CSRF-Token": csrf(client), "Content-Type": "application/json"},
    )

    error = error_of(response, 422, "validation_failed")
    assert [field["path"] for field in error["field_errors"]] == ["/token"]


@pytest.mark.parametrize("account", ["no token", "no account"])
def test_nobody_signs_in_before_the_operator_sets_a_token(
    client: TestClient, database: Database, clock: FakeClock, account: str
) -> None:
    if account == "no token":
        with database.write() as session:
            session.add(
                StaffUser(
                    id="usr_admin",
                    username="admin",
                    display_name="Admin",
                    role="staff",
                    token_hash=None,
                    token_set_at=None,
                    created_at=clock.now,
                )
            )

    for token in ["None", "null", TOKEN]:
        error_of(sign_in(client, token), 401, "invalid_credentials")


def test_sign_in_needs_the_csrf_token_of_its_own_session(
    client: TestClient, browser: Browser, admin: StaffUser
) -> None:
    credentials = {"username": "admin", "token": TOKEN}
    token = csrf(client)
    other_session_token = csrf(browser())

    missing = client.post(f"{API}/auth/sign-in", json=credentials)
    wrong = client.post(
        f"{API}/auth/sign-in", json=credentials, headers={"X-CSRF-Token": other_session_token}
    )
    no_cookie = browser().post(
        f"{API}/auth/sign-in", json=credentials, headers={"X-CSRF-Token": token}
    )

    for response in [missing, wrong, no_cookie]:
        error = error_of(response, 403, "csrf_invalid")
        assert error["message"] == "The security token for this page is out of date. Try again."
    error_of(client.get(f"{API}/auth/session"), 401, "unauthenticated")


@pytest.mark.parametrize("origin", [None, "https://evil.example", "null", ORIGIN + ".evil.example"])
def test_sign_in_needs_an_approved_origin(
    client: TestClient, browser: Browser, admin: StaffUser, origin: str | None
) -> None:
    token = csrf(client)
    elsewhere = browser(origin)

    response = elsewhere.post(
        f"{API}/auth/sign-in",
        json={"username": "admin", "token": TOKEN},
        headers={"X-CSRF-Token": token, **cookie_header(session_cookie(client))},
    )

    error_of(response, 403, "csrf_invalid")
    assert elsewhere.cookies.get(SESSION_COOKIE) is None


def test_signing_in_again_replaces_the_earlier_session(
    client: TestClient, browser: Browser, admin: StaffUser
) -> None:
    first = sign_in(client).json()
    first_cookie = session_cookie(client)

    second = sign_in(client).json()

    assert second["csrf_token"] != first["csrf_token"]
    assert session_cookie(client) != first_cookie
    assert client.get(f"{API}/auth/session").json()["csrf_token"] == second["csrf_token"]
    error_of(
        browser().get(f"{API}/auth/session", headers=cookie_header(first_cookie)),
        401,
        "unauthenticated",
    )


def test_credentials_never_reach_the_logs(
    client: TestClient, admin: StaffUser, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        sign_in(client, WRONG)
        signed_in = sign_in(client).json()
        client.get(f"{API}/probe/orders")

    logged = "\n".join(record.getMessage() for record in caplog.records)
    assert f"{API}/auth/sign-in" in logged
    for secret in [WRONG, TOKEN, signed_in["csrf_token"], session_cookie(client)]:
        assert secret not in logged


# --- The session and its limits --------------------------------------------------------------


def test_the_session_endpoint_reports_the_current_session(
    client: TestClient, admin: StaffUser
) -> None:
    signed_in = sign_in(client).json()

    response = client.get(f"{API}/auth/session")

    assert response.status_code == 200
    assert response.json() == signed_in


def test_an_unknown_query_parameter_is_refused(client: TestClient, admin: StaffUser) -> None:
    sign_in(client)

    for path in ["/auth/session", "/auth/csrf"]:
        error = error_of(client.get(f"{API}{path}?verbose=1"), 422, "validation_failed")
        assert [(field["path"], field["code"]) for field in error["field_errors"]] == [
            ("/query/verbose", "unknown_field")
        ]


def test_polling_the_session_does_not_keep_it_alive(
    client: TestClient, clock: FakeClock, admin: StaffUser
) -> None:
    signed_in = sign_in(client).json()

    for _ in range(29):
        clock.advance(minutes=1)
        polled = client.get(f"{API}/auth/session")
        assert polled.json()["idle_expires_at"] == signed_in["idle_expires_at"]
        client.get(f"{API}/auth/csrf")
    clock.advance(minutes=1)

    error_of(client.get(f"{API}/auth/session"), 401, "session_expired")


def test_a_business_request_renews_the_idle_limit(
    client: TestClient, clock: FakeClock, admin: StaffUser
) -> None:
    signed_in = sign_in(client).json()
    clock.advance(minutes=10)

    assert client.get(f"{API}/probe/orders").json() == {"served": "admin"}

    session = client.get(f"{API}/auth/session").json()
    assert session["idle_expires_at"] == format_instant(clock.now + timedelta(minutes=30))
    assert session["absolute_expires_at"] == signed_in["absolute_expires_at"]
    clock.advance(minutes=29, seconds=59)
    assert client.get(f"{API}/auth/session").status_code == 200


def test_a_refused_business_request_still_counts_as_activity(
    client: TestClient, clock: FakeClock, admin: StaffUser
) -> None:
    token = sign_in(client).json()["csrf_token"]
    clock.advance(minutes=20)

    refused = client.post(f"{API}/probe/refused", headers={"X-CSRF-Token": token})

    error_of(refused, 409, "action_not_allowed")
    session = client.get(f"{API}/auth/session").json()
    assert session["idle_expires_at"] == format_instant(clock.now + timedelta(minutes=30))


def test_the_idle_limit_never_passes_the_absolute_limit(
    client: TestClient, clock: FakeClock, admin: StaffUser
) -> None:
    signed_in = sign_in(client).json()

    for _ in range(47):
        clock.advance(minutes=15)
        assert client.get(f"{API}/probe/orders").status_code == 200
    # 11 hours 45 minutes in: fifteen minutes remain however busy the session is.
    session = client.get(f"{API}/auth/session").json()
    assert session["idle_expires_at"] == signed_in["absolute_expires_at"]
    clock.advance(minutes=14, seconds=59)
    assert client.get(f"{API}/probe/orders").status_code == 200
    clock.advance(seconds=1)

    error_of(client.get(f"{API}/probe/orders"), 401, "session_expired")
    error_of(client.get(f"{API}/auth/session"), 401, "session_expired")


def test_an_idle_session_expires_and_says_so(
    client: TestClient, clock: FakeClock, admin: StaffUser
) -> None:
    token = sign_in(client).json()["csrf_token"]
    clock.advance(minutes=29, seconds=59)
    assert client.get(f"{API}/auth/session").status_code == 200
    clock.advance(seconds=1)

    error = error_of(client.get(f"{API}/auth/session"), 401, "session_expired")
    assert error["message"] == "Your session has expired. Sign in again."
    error_of(client.get(f"{API}/probe/orders"), 401, "session_expired")
    # A save sent at the moment of expiry is told the truth, not sent to fix its CSRF token.
    error_of(
        client.post(f"{API}/probe/orders", headers={"X-CSRF-Token": token}), 401, "session_expired"
    )
    # Being asked again does not revive it.
    error_of(client.get(f"{API}/auth/session"), 401, "session_expired")


def test_after_expiry_a_new_csrf_token_starts_a_fresh_sign_in(
    client: TestClient, clock: FakeClock, admin: StaffUser
) -> None:
    old = sign_in(client).json()["csrf_token"]
    clock.advance(minutes=30)

    fresh = csrf(client)

    assert fresh != old
    error_of(client.get(f"{API}/auth/session"), 401, "unauthenticated")
    assert sign_in(client).status_code == 200
    assert client.get(f"{API}/probe/orders").status_code == 200


def test_a_pre_auth_session_cannot_reach_business_endpoints(client: TestClient) -> None:
    token = csrf(client)

    error_of(client.get(f"{API}/probe/orders"), 401, "unauthenticated")
    error_of(
        client.post(f"{API}/probe/orders", headers={"X-CSRF-Token": token}), 401, "unauthenticated"
    )


def test_a_business_save_needs_the_sessions_csrf_token_and_an_approved_origin(
    client: TestClient, browser: Browser, admin: StaffUser
) -> None:
    pre_auth = csrf(client)
    token = sign_in(client).json()["csrf_token"]
    cookie = cookie_header(session_cookie(client))

    error_of(client.post(f"{API}/probe/orders"), 403, "csrf_invalid")
    error_of(
        client.post(f"{API}/probe/orders", headers={"X-CSRF-Token": pre_auth}), 403, "csrf_invalid"
    )
    for origin in [None, "https://evil.example"]:
        forged = browser(origin).post(
            f"{API}/probe/orders", headers={"X-CSRF-Token": token, **cookie}
        )
        error_of(forged, 403, "csrf_invalid")
    # None of those refusals ended the session.
    saved = client.post(f"{API}/probe/orders", headers={"X-CSRF-Token": token})
    assert saved.json() == {"saved_by": "admin"}


def test_reading_needs_no_csrf_token_or_origin(
    client: TestClient, browser: Browser, admin: StaffUser
) -> None:
    sign_in(client)

    response = browser(None).get(
        f"{API}/probe/orders", headers=cookie_header(session_cookie(client))
    )

    assert response.status_code == 200


# --- Sign-out --------------------------------------------------------------------------------


def test_sign_out_ends_the_session_and_clears_the_cookie(
    client: TestClient, browser: Browser, admin: StaffUser
) -> None:
    token = sign_in(client).json()["csrf_token"]
    cookie = session_cookie(client)

    response = client.post(f"{API}/auth/sign-out", json={}, headers={"X-CSRF-Token": token})

    assert response.status_code == 204
    assert response.content == b""
    cleared = set_cookie(response, SESSION_COOKIE)
    assert cleared["value"] in {"", '""'}
    assert cleared["max-age"] == "0"
    assert (cleared["samesite"], cleared["path"]) == ("lax", "/")
    assert {"httponly", "secure"} <= set(cleared)
    assert client.cookies.get(SESSION_COOKIE) is None
    # The server ended it too: the old cookie is worthless wherever it is replayed.
    replayed = browser()
    error_of(
        replayed.get(f"{API}/auth/session", headers=cookie_header(cookie)), 401, "unauthenticated"
    )
    error_of(
        replayed.get(f"{API}/probe/orders", headers=cookie_header(cookie)), 401, "unauthenticated"
    )


def test_repeating_a_sign_out_whose_answer_was_lost_also_succeeds(
    client: TestClient, browser: Browser, admin: StaffUser
) -> None:
    token = sign_in(client).json()["csrf_token"]
    cookie = cookie_header(session_cookie(client))
    client.post(f"{API}/auth/sign-out", json={}, headers={"X-CSRF-Token": token})

    # The browser never saw the answer, so it still holds the cookie and repeats the request.
    again = browser().post(
        f"{API}/auth/sign-out", json={}, headers={"X-CSRF-Token": token, **cookie}
    )

    assert again.status_code == 204


def test_the_frontend_can_retry_sign_out_with_a_new_csrf_token(
    client: TestClient, browser: Browser, admin: StaffUser
) -> None:
    token = sign_in(client).json()["csrf_token"]
    cookie = session_cookie(client)
    client.post(f"{API}/auth/sign-out", json={}, headers={"X-CSRF-Token": token})

    # It dropped its CSRF token when signing out locally, so the retry starts by fetching one.
    retry = browser()
    retry.cookies.set(SESSION_COOKIE, cookie, domain="testserver", path="/")
    fresh = csrf(retry)
    again = retry.post(f"{API}/auth/sign-out", json={}, headers={"X-CSRF-Token": fresh})

    assert again.status_code == 204
    error_of(retry.get(f"{API}/auth/session"), 401, "unauthenticated")


def test_sign_out_needs_the_csrf_token_and_an_approved_origin(
    client: TestClient, browser: Browser, admin: StaffUser
) -> None:
    token = sign_in(client).json()["csrf_token"]
    cookie = cookie_header(session_cookie(client))

    error_of(client.post(f"{API}/auth/sign-out", json={}), 403, "csrf_invalid")
    error_of(
        client.post(f"{API}/auth/sign-out", json={}, headers={"X-CSRF-Token": "guess"}),
        403,
        "csrf_invalid",
    )
    forged = browser("https://evil.example").post(
        f"{API}/auth/sign-out", json={}, headers={"X-CSRF-Token": token, **cookie}
    )
    error_of(forged, 403, "csrf_invalid")
    # Nobody else can sign staff out.
    assert client.get(f"{API}/auth/session").status_code == 200


def test_an_expired_session_can_still_be_signed_out(
    client: TestClient, clock: FakeClock, admin: StaffUser
) -> None:
    token = sign_in(client).json()["csrf_token"]
    clock.advance(hours=13)

    response = client.post(f"{API}/auth/sign-out", json={}, headers={"X-CSRF-Token": token})

    assert response.status_code == 204
    error_of(client.get(f"{API}/auth/session"), 401, "unauthenticated")


def test_sign_out_takes_an_empty_object(client: TestClient, admin: StaffUser) -> None:
    token = sign_in(client).json()["csrf_token"]

    response = client.post(
        f"{API}/auth/sign-out", json={"everywhere": True}, headers={"X-CSRF-Token": token}
    )

    error = error_of(response, 422, "validation_failed")
    assert [field["path"] for field in error["field_errors"]] == ["/everywhere"]
    assert client.get(f"{API}/auth/session").status_code == 200


# --- Sign-in rate limit ----------------------------------------------------------------------


def test_repeated_failures_lock_sign_in_even_for_the_right_token(
    client: TestClient, clock: FakeClock, admin: StaffUser
) -> None:
    for _ in range(5):
        error_of(sign_in(client, WRONG), 401, "invalid_credentials")
        clock.advance(seconds=10)

    locked = sign_in(client)

    error = error_of(locked, 429, "rate_limited")
    assert error["field_errors"] == []
    # Five failures began 50 seconds ago; the oldest leaves the 15-minute window in 850.
    assert locked.headers["Retry-After"] == "850"
    clock.advance(seconds=849)
    assert sign_in(client).headers["Retry-After"] == "1"
    clock.advance(seconds=1)
    assert sign_in(client).status_code == 200


def test_attempts_made_while_locked_do_not_extend_the_lock(
    client: TestClient, clock: FakeClock, admin: StaffUser
) -> None:
    for _ in range(5):
        sign_in(client, WRONG)
    for _ in range(20):
        clock.advance(seconds=30)
        error_of(sign_in(client, WRONG), 429, "rate_limited")
    clock.advance(minutes=5)

    assert sign_in(client).status_code == 200


def test_a_successful_sign_in_forgets_earlier_failures(
    client: TestClient, admin: StaffUser
) -> None:
    for _ in range(4):
        error_of(sign_in(client, WRONG), 401, "invalid_credentials")
    assert sign_in(client).status_code == 200

    for _ in range(4):
        error_of(sign_in(client, WRONG), 401, "invalid_credentials")
    assert sign_in(client).status_code == 200


def test_failures_older_than_the_window_are_forgotten(
    client: TestClient, clock: FakeClock, admin: StaffUser
) -> None:
    for _ in range(4):
        sign_in(client, WRONG)
    clock.advance(minutes=15)

    for _ in range(4):
        error_of(sign_in(client, WRONG), 401, "invalid_credentials")
    assert sign_in(client).status_code == 200


def test_refusals_before_the_token_is_checked_are_not_attempts(
    client: TestClient, admin: StaffUser
) -> None:
    for _ in range(8):
        blank = client.post(
            f"{API}/auth/sign-in",
            json={"username": "admin", "token": ""},
            headers={"X-CSRF-Token": csrf(client)},
        )
        error_of(blank, 422, "validation_failed")
        no_csrf = client.post(f"{API}/auth/sign-in", json={"username": "admin", "token": WRONG})
        error_of(no_csrf, 403, "csrf_invalid")

    assert sign_in(client).status_code == 200


# --- Configuration ---------------------------------------------------------------------------


def test_a_plain_http_cookie_needs_the_explicit_development_setting(
    config: Settings, clock: FakeClock
) -> None:
    insecure = config.model_copy(update={"cookie_secure": False})

    with TestClient(create_app(insecure, clock=clock), base_url="http://testserver") as http:
        cookie = set_cookie(http.get(f"{API}/auth/csrf"), SESSION_COOKIE)

    assert "secure" not in cookie
    assert "httponly" in cookie


def test_session_limits_are_configurable(
    config: Settings, clock: FakeClock, database: Database, token_hash: str
) -> None:
    short = config.model_copy(update={"session_idle_seconds": 60, "session_absolute_seconds": 300})
    with database.write() as session:
        session.add(
            StaffUser(
                id="usr_admin",
                username="admin",
                display_name="Admin",
                role="staff",
                token_hash=token_hash,
                token_set_at=clock.now,
                created_at=clock.now,
            )
        )

    with TestClient(
        create_app(short, clock=clock), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        body = sign_in(client).json()
        assert body["idle_expires_at"] == format_instant(clock.now + timedelta(seconds=60))
        assert body["absolute_expires_at"] == format_instant(clock.now + timedelta(seconds=300))
        clock.advance(seconds=60)
        error_of(client.get(f"{API}/auth/session"), 401, "session_expired")
