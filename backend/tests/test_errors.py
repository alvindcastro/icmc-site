import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict

from app.errors import ApiError, FieldError, pointer
from app.values import SellingQuantity
from tests.support import API, error_of


class Line(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quantity: SellingQuantity


class Draft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[Line]


class Save(BaseModel):
    model_config = ConfigDict(extra="forbid")
    draft: Draft


@pytest.fixture(autouse=True)
def probes(app: FastAPI) -> None:
    """Throwaway routes that exercise the shared error handling without any business area."""

    @app.post("/probe/drafts")
    def save(body: Save) -> dict[str, int]:
        return {"lines": len(body.draft.items)}

    @app.get("/probe/failure")
    def failure() -> None:
        raise RuntimeError("database password is hunter2")

    @app.get("/probe/in-progress")
    def in_progress() -> None:
        raise ApiError(
            409,
            "operation_in_progress",
            "This save is still being processed.",
            details={"operation_id": "op_1"},
            headers={"Retry-After": "2"},
        )

    @app.get("/probe/fields")
    def fields() -> None:
        raise ApiError(
            422,
            "validation_failed",
            "Check the highlighted fields.",
            field_errors=[
                FieldError(
                    "/draft/items/0/quantity",
                    "positive_integer_required",
                    "Enter a whole package quantity greater than zero.",
                )
            ],
        )


def test_every_response_carries_its_own_request_id(client: TestClient) -> None:
    first = client.get("/healthz").headers["X-Request-ID"]
    second = client.get("/healthz").headers["X-Request-ID"]

    assert first.startswith("req_")
    assert first != second


def test_an_unknown_route_is_not_found_in_the_envelope(client: TestClient) -> None:
    error = error_of(client.get(f"{API}/nothing-here"), 404, "not_found")

    assert error["field_errors"] == []
    assert error["details"] == {}


def test_an_unsupported_method_answers_in_the_envelope(client: TestClient) -> None:
    response = client.delete("/healthz")

    error_of(response, 405, "method_not_allowed")
    assert response.headers["Allow"] == "GET"


def test_malformed_json_is_invalid_json(client: TestClient) -> None:
    response = client.post(
        "/probe/drafts", content='{"draft": ', headers={"Content-Type": "application/json"}
    )

    assert error_of(response, 400, "invalid_json")["field_errors"] == []


def test_validation_errors_point_at_the_field_with_a_json_pointer(client: TestClient) -> None:
    response = client.post("/probe/drafts", json={"draft": {"items": [{"quantity": 0}]}})

    error = error_of(response, 422, "validation_failed")
    assert error["message"] == "Check the highlighted fields."
    assert [field["path"] for field in error["field_errors"]] == ["/draft/items/0/quantity"]
    assert set(error["field_errors"][0]) == {"path", "code", "message"}
    assert error["field_errors"][0]["code"].strip()
    assert error["field_errors"][0]["message"].strip()


def test_missing_and_unknown_fields_are_field_errors(client: TestClient) -> None:
    unknown = client.post(
        "/probe/drafts",
        json={"draft": {"items": [{"quantity": 1, "price_minor": 5}]}, "total_minor": 3},
    )
    missing = client.post("/probe/drafts", json={})

    assert {
        (field["path"], field["code"])
        for field in error_of(unknown, 422, "validation_failed")["field_errors"]
    } == {("/draft/items/0/price_minor", "unknown_field"), ("/total_minor", "unknown_field")}
    assert [
        (field["path"], field["code"])
        for field in error_of(missing, 422, "validation_failed")["field_errors"]
    ] == [("/draft", "required")]


def test_a_body_that_is_not_an_object_is_a_field_error_on_the_whole_body(
    client: TestClient,
) -> None:
    error = error_of(client.post("/probe/drafts", json=[1, 2]), 422, "validation_failed")

    assert [field["path"] for field in error["field_errors"]] == [""]


def test_validation_errors_never_echo_the_submitted_value(client: TestClient) -> None:
    response = client.post(
        "/probe/drafts", json={"draft": {"items": [{"quantity": "customer note 4471"}]}}
    )

    error_of(response, 422, "validation_failed")
    assert "4471" not in response.text


def test_an_application_error_keeps_its_details_field_errors_and_headers(
    client: TestClient,
) -> None:
    conflict = client.get("/probe/in-progress")
    fields = client.get("/probe/fields")

    assert error_of(conflict, 409, "operation_in_progress")["details"] == {"operation_id": "op_1"}
    assert conflict.headers["Retry-After"] == "2"
    assert error_of(fields, 422, "validation_failed")["field_errors"] == [
        {
            "path": "/draft/items/0/quantity",
            "code": "positive_integer_required",
            "message": "Enter a whole package quantity greater than zero.",
        }
    ]


def test_an_unexpected_failure_is_internal_error_with_nothing_leaked(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.ERROR, logger="app"):
        response = client.get("/probe/failure")

    error = error_of(response, 500, "internal_error")
    assert "hunter2" not in response.text
    assert "Traceback" not in response.text
    assert "RuntimeError" not in response.text
    # The operator can find the failure in the logs by the ID the browser was given.
    assert any(error["request_id"] in record.getMessage() for record in caplog.records)


def test_api_responses_are_never_stored_by_the_browser(client: TestClient) -> None:
    assert client.get(f"{API}/auth/session").headers["Cache-Control"] == "no-store"
    assert client.get(f"{API}/nothing-here").headers["Cache-Control"] == "no-store"


def test_json_pointers_escape_their_reserved_characters() -> None:
    assert pointer("draft", "items", 0, "quantity") == "/draft/items/0/quantity"
    assert pointer("a/b", "c~d") == "/a~1b/c~0d"
    assert pointer() == ""


def test_each_request_is_logged_with_its_id_and_without_its_query(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="app"):
        response = client.get(f"{API}/nothing-here?q=customer+name")

    lines = [record.getMessage() for record in caplog.records]
    assert lines == [f"{response.headers['X-Request-ID']} GET {API}/nothing-here 404"]
