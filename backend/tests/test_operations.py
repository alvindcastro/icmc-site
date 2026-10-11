import threading
import time
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi import APIRouter, Depends, FastAPI, Request, Response
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.deps import App, JsonBody, Staff, guard_mutation
from app.config import Settings
from app.errors import ApiError, parse
from app.main import create_app
from app.persistence.database import Database
from app.persistence.models import Operation, StaffUser
from app.services import operations
from app.services.operations import Done
from app.services.sessions import SESSION_COOKIE
from tests.support import API, ORIGIN, Cli, FakeClock, error_of, sign_in

Browser = Callable[..., TestClient]
NOTES = f"{API}/probe/notes"


class NoteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str
    tags: list[str] = []


def add_probe(app: FastAPI) -> None:
    """A stand-in keyed mutation: it saves a note, and can be told to refuse, crash or dawdle."""
    probe = APIRouter(prefix=API, dependencies=[Depends(guard_mutation)])

    def save(payload: Any, request: Request, context: App) -> Response:
        def change(db: Session) -> Done:
            note = parse(NoteIn, payload)
            taken = db.execute(
                text("select count(*) from probe_notes where body = :body"), {"body": note.text}
            ).scalar()
            db.execute(text("insert into probe_notes (body) values (:body)"), {"body": note.text})
            if getattr(request.app.state, "dawdle", 0):
                time.sleep(request.app.state.dawdle)
            if taken:
                raise ApiError(409, "action_not_allowed", "That note already exists.")
            if getattr(request.app.state, "crash", False):
                request.app.state.crash = False
                raise RuntimeError("the disk caught fire")
            identifier = f"note_{note.text}"
            return Done(201, "note", identifier, {"id": identifier, "text": note.text})

        return operations.execute(context, request, payload, change)

    @probe.post("/probe/notes")
    def add_note(payload: JsonBody, request: Request, staff: Staff, context: App) -> Response:
        return save(payload, request, context)

    @probe.post("/probe/other-notes")
    def add_other(payload: JsonBody, request: Request, staff: Staff, context: App) -> Response:
        return save(payload, request, context)

    app.include_router(probe)


@pytest.fixture(autouse=True)
def notes(app: FastAPI, database: Database) -> None:
    add_probe(app)
    with database.write() as db:
        db.execute(text("create table probe_notes (body text)"))


@pytest.fixture
def staff(client: TestClient, admin: StaffUser) -> TestClient:
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
    return client


def key() -> str:
    return str(uuid.uuid4())


def post(client: TestClient, body: Any, operation: str | None, path: str = NOTES) -> Any:
    return client.post(path, json=body, headers={"Idempotency-Key": operation} if operation else {})


def saved(database: Database) -> list[str]:
    with database.read() as db:
        return list(db.execute(text("select body from probe_notes order by body")).scalars())


def lookup(client: TestClient, operation: str) -> Any:
    return client.get(f"{API}/operations/{operation}")


# --- Keys ------------------------------------------------------------------------------------


def test_a_keyed_change_is_refused_without_its_operation_key(
    staff: TestClient, database: Database
) -> None:
    error = error_of(post(staff, {"text": "milk"}, None), 422, "validation_failed")

    assert [(field["path"], field["code"]) for field in error["field_errors"]] == [
        ("/header/Idempotency-Key", "required")
    ]
    assert saved(database) == []


@pytest.mark.parametrize("operation", ["same-key", "1234", "x" * 36, uuid.uuid4().hex])
def test_an_operation_key_is_a_uuid(staff: TestClient, database: Database, operation: str) -> None:
    error = error_of(post(staff, {"text": "milk"}, operation), 422, "validation_failed")

    assert [field["path"] for field in error["field_errors"]] == ["/header/Idempotency-Key"]
    assert saved(database) == []


def test_a_key_means_the_same_in_either_letter_case(staff: TestClient, database: Database) -> None:
    operation = key()

    first = post(staff, {"text": "milk"}, operation.upper())
    again = post(staff, {"text": "milk"}, operation.lower())

    assert (first.status_code, again.status_code) == (201, 201)
    assert again.headers["Idempotency-Replayed"] == "true"
    assert saved(database) == ["milk"]


# --- Once, and only once ---------------------------------------------------------------------


def test_a_first_request_takes_effect_and_is_not_a_replay(
    staff: TestClient, database: Database
) -> None:
    response = post(staff, {"text": "milk"}, key())

    assert response.status_code == 201
    assert response.json() == {"id": "note_milk", "text": "milk"}
    assert "Idempotency-Replayed" not in response.headers
    assert saved(database) == ["milk"]


def test_repeating_a_request_whose_answer_was_lost_replays_the_original(
    staff: TestClient, database: Database
) -> None:
    operation = key()
    first = post(staff, {"text": "milk"}, operation)

    again = post(staff, {"text": "milk"}, operation)

    assert (again.status_code, again.content) == (first.status_code, first.content)
    assert again.headers["Idempotency-Replayed"] == "true"
    assert saved(database) == ["milk"]


def test_the_same_json_written_differently_is_the_same_request(
    staff: TestClient, database: Database
) -> None:
    operation = key()
    headers = {"Idempotency-Key": operation, "Content-Type": "application/json"}
    staff.post(NOTES, content='{"text": "milk", "tags": ["a", "b"]}', headers=headers)

    again = staff.post(NOTES, content='{ "tags":["a","b"],\n"text":"milk" }', headers=headers)

    assert again.status_code == 201
    assert again.headers["Idempotency-Replayed"] == "true"
    assert saved(database) == ["milk"]


@pytest.mark.parametrize(
    ("body", "path"),
    [
        ({"text": "cream"}, NOTES),
        ({"text": "milk", "tags": ["b", "a"]}, NOTES),
        ({"text": "milk", "tags": ["a", "b"], "extra": None}, NOTES),
        ({"text": "milk", "tags": ["a", "b"]}, f"{API}/probe/other-notes"),
    ],
)
def test_a_key_reused_for_a_different_request_is_refused_without_effect(
    staff: TestClient, database: Database, body: dict[str, Any], path: str
) -> None:
    operation = key()
    original = post(staff, {"text": "milk", "tags": ["a", "b"]}, operation)

    different = post(staff, body, operation, path)

    error_of(different, 409, "operation_payload_mismatch")
    assert "Idempotency-Replayed" not in different.headers
    assert saved(database) == ["milk"]
    assert lookup(staff, operation).json()["result"]["body"] == original.json()


def test_a_refusal_is_remembered_so_a_late_copy_can_never_succeed(
    staff: TestClient, database: Database
) -> None:
    post(staff, {"text": "milk"}, key())
    operation = key()
    refused = post(staff, {"text": "milk"}, operation)
    error_of(refused, 409, "action_not_allowed")
    # The obstacle goes away, so the same request would now be accepted if it were new.
    with database.write() as db:
        db.execute(text("delete from probe_notes"))

    late = post(staff, {"text": "milk"}, operation)

    assert (late.status_code, late.content) == (409, refused.content)
    assert late.headers["Idempotency-Replayed"] == "true"
    assert saved(database) == []


def test_a_refused_change_takes_back_what_it_had_already_written(
    staff: TestClient, database: Database
) -> None:
    post(staff, {"text": "milk"}, key())

    # The stand-in writes its row before it discovers the duplicate.
    error_of(post(staff, {"text": "milk"}, key()), 409, "action_not_allowed")

    assert saved(database) == ["milk"]


def test_a_validation_refusal_is_remembered_with_its_field_errors(
    staff: TestClient, database: Database
) -> None:
    operation = key()
    refused = post(staff, {"text": 7, "colour": "blue"}, operation)
    error = error_of(refused, 422, "validation_failed")

    again = post(staff, {"text": 7, "colour": "blue"}, operation)

    assert {field["path"] for field in error["field_errors"]} == {"/text", "/colour"}
    assert (again.status_code, again.content) == (422, refused.content)
    assert again.headers["Idempotency-Replayed"] == "true"
    assert saved(database) == []


def test_a_failure_midway_leaves_no_effect_and_no_record_and_can_be_retried(
    staff: TestClient, app: FastAPI, database: Database
) -> None:
    operation = key()
    app.state.crash = True

    error_of(post(staff, {"text": "milk"}, operation), 500, "internal_error")

    assert saved(database) == []
    error_of(lookup(staff, operation), 404, "not_found")
    retried = post(staff, {"text": "milk"}, operation)
    assert retried.status_code == 201
    assert "Idempotency-Replayed" not in retried.headers
    assert saved(database) == ["milk"]


def test_two_identical_requests_at_once_take_effect_once(
    staff: TestClient, browser: Browser, app: FastAPI, database: Database
) -> None:
    operation = key()
    app.state.dawdle = 0.2
    second = browser()
    second.headers["X-CSRF-Token"] = staff.headers["X-CSRF-Token"]
    second.headers["Cookie"] = f"{SESSION_COOKIE}={staff.cookies.get(SESSION_COOKIE)}"
    answers: list[Any] = []
    start = threading.Barrier(2)

    def send(client: TestClient) -> None:
        start.wait()
        answers.append(post(client, {"text": "milk"}, operation))

    threads = [threading.Thread(target=send, args=(client,)) for client in (staff, second)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert [answer.status_code for answer in answers] == [201, 201]
    assert answers[0].content == answers[1].content
    assert sorted("Idempotency-Replayed" in answer.headers for answer in answers) == [False, True]
    assert saved(database) == ["milk"]


def test_requests_refused_before_the_change_is_attempted_are_not_recorded(
    staff: TestClient, browser: Browser, database: Database
) -> None:
    operation = key()
    headers = {"Idempotency-Key": operation, "Content-Type": "application/json"}

    error_of(staff.post(NOTES, content='{"text": ', headers=headers), 400, "invalid_json")
    whole = error_of(staff.post(NOTES, json=["milk"], headers=headers), 422, "validation_failed")
    assert [field["path"] for field in whole["field_errors"]] == [""]
    error_of(browser().post(NOTES, json={"text": "milk"}, headers=headers), 403, "csrf_invalid")

    error_of(lookup(staff, operation), 404, "not_found")
    assert post(staff, {"text": "milk"}, operation).status_code == 201


# --- Looking an operation up -----------------------------------------------------------------


def test_a_succeeded_operation_reports_its_result(staff: TestClient, clock: FakeClock) -> None:
    operation = key()
    post(staff, {"text": "milk"}, operation)

    response = lookup(staff, operation)

    assert response.status_code == 200
    assert response.json() == {
        "operation_id": operation,
        "state": "succeeded",
        "resource_type": "note",
        "resource_id": "note_milk",
        "result": {"http_status": 201, "body": {"id": "note_milk", "text": "milk"}},
        "error": None,
        "started_at": "2026-10-10T19:00:00Z",
        "completed_at": "2026-10-10T19:00:00Z",
    }


def test_a_rejected_operation_reports_the_original_error_and_no_resource(
    staff: TestClient,
) -> None:
    post(staff, {"text": "milk"}, key())
    operation = key()
    refused = post(staff, {"text": "milk"}, operation)

    body = lookup(staff, operation).json()

    assert body["state"] == "rejected"
    assert (body["resource_type"], body["resource_id"], body["result"]) == (None, None, None)
    assert body["error"] == {"http_status": 409, **refused.json()}
    assert body["completed_at"]


def test_an_operation_in_progress_blocks_its_copy_and_says_so(
    staff: TestClient, database: Database, clock: FakeClock
) -> None:
    operation = key()
    with database.write() as db:
        db.add(
            Operation(
                key=operation,
                method="POST",
                path=NOTES,
                fingerprint=operations.fingerprint("POST", NOTES, {"text": "milk"}),
                state="processing",
                started_at=clock.now,
            )
        )

    blocked = post(staff, {"text": "milk"}, operation)

    error_of(blocked, 409, "operation_in_progress")
    assert int(blocked.headers["Retry-After"]) >= 1
    assert saved(database) == []
    body = lookup(staff, operation).json()
    assert body["state"] == "processing"
    assert (body["result"], body["error"], body["completed_at"]) == (None, None, None)
    assert (body["resource_type"], body["resource_id"]) == (None, None)


@pytest.mark.parametrize("operation", [str(uuid.uuid4()), "never-a-key", "a/b"])
def test_an_unknown_operation_is_not_found(staff: TestClient, operation: str) -> None:
    error_of(lookup(staff, operation), 404, "not_found")


def test_lookups_and_replays_are_authorized_like_any_request(
    staff: TestClient, browser: Browser
) -> None:
    operation = key()
    post(staff, {"text": "milk"}, operation)
    stranger = browser()

    error_of(lookup(stranger, operation), 401, "unauthenticated")
    replay = stranger.post(NOTES, json={"text": "milk"}, headers={"Idempotency-Key": operation})
    error_of(replay, 403, "csrf_invalid")
    error = error_of(staff.get(f"{API}/operations/{operation}?wait=1"), 422, "validation_failed")
    assert [field["path"] for field in error["field_errors"]] == ["/query/wait"]


def test_a_busy_database_is_temporarily_unavailable_not_a_crash(
    config: Settings, clock: FakeClock, database: Database, admin: StaffUser
) -> None:
    impatient = config.model_copy(update={"database_busy_timeout_ms": 50})
    app = create_app(impatient, clock=clock)
    add_probe(app)
    operation = key()

    with TestClient(app, base_url=ORIGIN, headers={"Origin": ORIGIN}) as client:
        client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
        with database.write():
            busy = post(client, {"text": "milk"}, operation)
        error_of(busy, 503, "temporarily_unavailable")
        assert int(busy.headers["Retry-After"]) >= 1
        error_of(lookup(client, operation), 404, "not_found")
        assert post(client, {"text": "milk"}, operation).status_code == 201


# --- The operator ----------------------------------------------------------------------------


def test_the_operator_lists_operations_that_never_finished(
    cli: Cli, database: Database, clock: FakeClock, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli("operations", "unresolved") == 0
    assert "No unresolved operations" in capsys.readouterr().out
    stuck = key()
    with database.write() as db:
        db.add(
            Operation(
                key=stuck,
                method="POST",
                path=NOTES,
                fingerprint="f",
                state="processing",
                started_at=clock.now,
            )
        )

    assert cli("operations", "unresolved") == 0

    listed = capsys.readouterr().out
    assert stuck in listed
    assert NOTES in listed


def test_the_operator_closes_a_key_the_server_never_saw(
    cli: Cli, staff: TestClient, database: Database
) -> None:
    lost = key()
    error_of(lookup(staff, lost), 404, "not_found")

    assert cli("operations", "close", lost, "--reason", "Draft lost when the session expired") == 0

    body = lookup(staff, lost).json()
    assert body["state"] == "rejected"
    assert body["error"]["http_status"] == 409
    assert body["error"]["error"]["code"] == "operation_closed"
    assert "Draft lost when the session expired" in body["error"]["error"]["message"]
    assert body["error"]["error"]["field_errors"] == []
    # If the original request turns up after all, it cannot take effect under that key.
    error_of(post(staff, {"text": "milk"}, lost), 409, "operation_payload_mismatch")
    assert saved(database) == []


def test_closing_needs_a_new_key_and_a_reason(
    cli: Cli, staff: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    done = key()
    post(staff, {"text": "milk"}, done)

    assert cli("operations", "close", done, "--reason", "Tidying up") == 1
    assert "succeeded" in capsys.readouterr().err
    assert cli("operations", "close", "not-a-key", "--reason", "Tidying up") == 1
    assert cli("operations", "close", key(), "--reason", "   ") == 1
    assert cli("operations", "close", key()) != 0
    assert lookup(staff, done).json()["state"] == "succeeded"
