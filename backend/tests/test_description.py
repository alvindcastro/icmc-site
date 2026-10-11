"""The published API description, checked against the server itself and against the contract."""

import re
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.persistence.models import StaffUser
from tests.preparation_support import KITCHEN_SETTINGS, RECORDING
from tests.support import API, Cli, field_paths, keyed, sign_in

CONTRACT = Path(__file__).parents[2] / "frontend" / "docs" / "phase-0" / "API_CONTRACT.md"
ENVELOPE = {"$ref": "#/components/schemas/ErrorEnvelope"}
# The contract's error table, and two codes the backend added and wrote into the contract:
# 405 for a method an address does not take, and 409 for an operation key the operator closed.
CODES = {
    "invalid_json",
    "unauthenticated",
    "session_expired",
    "invalid_credentials",
    "action_forbidden",
    "csrf_invalid",
    "not_found",
    "method_not_allowed",
    "version_conflict",
    "operation_payload_mismatch",
    "operation_in_progress",
    "operation_closed",
    "quote_stale",
    "action_not_allowed",
    "settings_unconfirmed",
    "menu_unconfirmed",
    "insufficient_stock",
    "validation_failed",
    "rate_limited",
    "internal_error",
    "temporarily_unavailable",
}


@pytest.fixture
def description(app: FastAPI) -> dict[str, Any]:
    return app.openapi()


def operations(description: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    """Every operation under the versioned API, as method, path and its description."""
    return [
        (method.upper(), path, operation)
        for path, entries in description["paths"].items()
        if path.startswith(API)
        for method, operation in entries.items()
    ]


def resolve(description: dict[str, Any], node: dict[str, Any]) -> dict[str, Any]:
    while "$ref" in node:
        node = description["components"]["schemas"][node["$ref"].rsplit("/", 1)[1]]
    return node


def header_names(operation: dict[str, Any]) -> set[str]:
    return {
        parameter["name"]
        for parameter in operation.get("parameters", [])
        if parameter["in"] == "header"
    }


def test_every_keyed_save_describes_the_body_it_actually_reads(
    description: dict[str, Any], client: TestClient, admin: StaffUser, cli: Cli
) -> None:
    assert cli(*KITCHEN_SETTINGS, RECORDING, "--payment-methods=cash", "--enable=payments") == 0
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
    saves = [
        entry for entry in operations(description) if "Idempotency-Key" in header_names(entry[2])
    ]

    for method, path, operation in saves:
        body = resolve(
            description, operation["requestBody"]["content"]["application/json"]["schema"]
        )
        address = re.sub(r"\{[a-z_]+\}", "none", path).removeprefix(API)
        # An empty object is refused for exactly the fields the description calls required,
        # so the model it names is the model the route reads.
        refused = keyed(client, method, address, {})
        assert field_paths(refused) == {f"/{name}" for name in body["required"]}, (method, path)
        assert body["additionalProperties"] is False

    # Every save that changes a record goes through an operation key; a recipe is the exception.
    assert len(saves) == 16
    assert {entry[0] for entry in saves} == {"POST", "PUT", "PATCH"}


def test_the_operation_key_is_described_as_a_required_uuid(description: dict[str, Any]) -> None:
    operation = description["paths"][f"{API}/purchases"]["post"]

    (key,) = [item for item in operation["parameters"] if item["name"] == "Idempotency-Key"]

    assert (key["in"], key["required"], key["schema"]) == (
        "header",
        True,
        {"type": "string", "format": "uuid"},
    )


def test_every_request_that_changes_something_names_the_csrf_header(
    description: dict[str, Any],
) -> None:
    for method, path, operation in operations(description):
        changes = method not in ("GET", "HEAD")
        assert ("X-CSRF-Token" in header_names(operation)) is changes, (method, path)


def test_refusals_are_described_by_the_envelope_not_the_frameworks_default(
    description: dict[str, Any],
) -> None:
    schemas = description["components"]["schemas"]

    assert "HTTPValidationError" not in schemas
    assert "ValidationError" not in schemas
    for method, path, operation in operations(description):
        responses = operation["responses"]
        assert responses["default"]["content"]["application/json"]["schema"] == ENVELOPE, (
            method,
            path,
        )
        assert "422" not in responses, (method, path)
    error = resolve(description, resolve(description, ENVELOPE)["properties"]["error"])
    assert set(error["required"]) == {"code", "message", "request_id", "field_errors", "details"}
    field = resolve(description, error["properties"]["field_errors"]["items"])
    assert set(field["required"]) == {"path", "code", "message"}


def test_the_envelope_lists_every_code_the_server_answers_with(description: dict[str, Any]) -> None:
    error = resolve(description, resolve(description, ENVELOPE)["properties"]["error"])

    assert set(error["properties"]["code"]["enum"]) == CODES
    # No refusal in the code can carry a code the description does not list.
    source = "\n".join(path.read_text() for path in Path("app").rglob("*.py"))
    raised = set(re.findall(r'ApiError\(\s*\d{3},\s*"([a-z_]+)"', source))
    assert raised and raised <= CODES, raised - CODES


def test_the_description_and_the_contract_name_the_same_routes(description: dict[str, Any]) -> None:
    if not CONTRACT.exists():
        pytest.skip("The contract lives in the frontend's documents, which are not here.")
    named = {
        (method, re.sub(r"\{[^}]*\}", "{}", path.rstrip("/")))
        for method, path in re.findall(
            r"`(GET|POST|PUT|PATCH|DELETE) (/[A-Za-z0-9_/{}-]*)(?=[`?\s])",
            CONTRACT.read_text(encoding="utf-8"),
        )
    }
    served = {
        (method, re.sub(r"\{[^}]*\}", "{}", path.removeprefix(API)))
        for method, path, _ in operations(description)
    }

    assert served - named == set(), "served but not in the contract"
    assert named - served == set(), "in the contract but not served"


def test_the_description_carries_the_contracts_enumerations(description: dict[str, Any]) -> None:
    schemas = description["components"]["schemas"]

    def values(schema: str, name: str) -> list[str]:
        found: list[str] = resolve(description, schemas[schema]["properties"][name])["enum"]
        return found

    assert values("OrderOut", "status") == [
        "pending",
        "confirmed",
        "preparing",
        "ready",
        "completed",
        "cancelled",
    ]
    assert values("OrderOut", "payment_status") == ["unpaid", "partial", "paid", "credit_due"]
    assert values("OrderOut", "preparation_tracking") == ["manual", "recorded"]
    assert values("LedgerEntryOut", "type") == ["payment", "refund"]
    assert values("LedgerEntryOut", "method") == ["cash", "bank_transfer", "other"]
    assert values("FulfillmentIn", "method") == ["pickup", "delivery"]
    assert values("VariantOut", "selling_unit") == ["tray", "piece", "stick", "package"]
    assert values("FoodOut", "confirmation_status") == ["provisional", "confirmed"]
    assert values("IngredientOut", "base_unit") == ["g", "ml", "piece"]
    assert values("MovementOut", "type") == [
        "opening",
        "purchase",
        "consumption",
        "waste",
        "correction",
    ]
    assert values("OperationOut", "state") == ["processing", "succeeded", "rejected"]
    assert values("SettingsOut", "environment") == ["development", "live"]


def test_the_description_is_built_once_and_survives_being_asked_again(app: FastAPI) -> None:
    assert app.openapi() is app.openapi()
