import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.persistence.models import StaffUser
from app.values import format_instant
from tests.order_support import (
    ACTIONS,
    PAYING_SETTINGS,
    STEPS,
    cancel,
    money,
    moved_to,
    paid,
    place,
    read,
    step,
)
from tests.support import API, Cli, FakeClock, error_of, field_paths, keyed, sign_in

EVERY_STATUS = [*STEPS, "cancelled"]


@pytest.fixture
def staff(client: TestClient, admin: StaffUser, cli: Cli) -> TestClient:
    """Signed-in staff with orders, the menu and payments enabled."""
    assert cli(*PAYING_SETTINGS) == 0
    assert cli("menu", "seed") == 0
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
    return client


def allowed(order: dict[str, Any]) -> set[str]:
    return {name for name, action in order["permitted_actions"].items() if action["allowed"]}


# --- One step at a time ----------------------------------------------------------------------


def test_an_order_moves_one_step_at_a_time_and_each_step_is_dated(
    staff: TestClient, admin: StaffUser, clock: FakeClock
) -> None:
    order = place(staff, status="pending")

    for previous, status in zip(STEPS, STEPS[1:], strict=False):
        clock.advance(minutes=5)
        response = step(staff, order, status)
        assert response.status_code == 200
        moved = response.json()
        assert (moved["status"], moved["version"]) == (status, order["version"] + 1)
        assert moved["status_history"][:-1] == order["status_history"]
        event = moved["status_history"][-1]
        assert {key: value for key, value in event.items() if key != "id"} == {
            "from_status": previous,
            "to_status": status,
            "changed_at": format_instant(clock.now),
            "actor": {"id": admin.id, "display_name": "Admin"},
            "reason": None,
        }
        assert moved["updated_at"] == format_instant(clock.now)
        order = moved

    assert len({event["id"] for event in order["status_history"]}) == 5
    assert read(staff, order["id"]) == order
    # No step touched the agreed lines or the money.
    assert (order["total_minor"], order["balance_due_minor"], order["ledger"]) == (21500, 21500, [])


@pytest.mark.parametrize(
    ("current", "target"),
    [
        (current, target)
        for current in EVERY_STATUS
        for target in EVERY_STATUS
        if (current, target) not in set(zip(STEPS, STEPS[1:], strict=False))
    ],
)
def test_jumps_reversals_and_repeats_are_refused(
    staff: TestClient, current: str, target: str
) -> None:
    order = moved_to(staff, place(staff, status="pending"), current)

    refused = step(staff, order, target)

    assert error_of(refused, 409, "action_not_allowed")["message"].strip()
    assert read(staff, order["id"]) == order


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        ("pending", {"edit", "confirm", "cancel", "record_payment"}),
        ("confirmed", {"edit", "start_preparing", "cancel", "record_payment"}),
        ("preparing", {"mark_ready", "cancel", "record_payment"}),
        ("ready", {"complete", "cancel", "record_payment"}),
        ("completed", {"record_payment"}),
        ("cancelled", set()),
    ],
)
def test_each_status_offers_exactly_its_own_actions(
    staff: TestClient, status: str, expected: set[str]
) -> None:
    order = moved_to(staff, place(staff, status="pending"), status)

    assert allowed(order) == expected
    for name in ACTIONS - expected:
        action = order["permitted_actions"][name]
        assert action["reason"].strip() and action["reason_code"].strip()


def test_an_unpaid_order_can_be_completed_and_paid_afterwards(staff: TestClient) -> None:
    order = moved_to(staff, place(staff), "completed")

    assert (order["status"], order["balance_due_minor"], order["payment_status"]) == (
        "completed",
        21500,
        "unpaid",
    )
    settled = paid(staff, order, 21500)
    assert (settled["status"], settled["payment_status"]) == ("completed", "paid")


def test_a_step_takes_only_the_version_and_the_target(staff: TestClient) -> None:
    order = moved_to(staff, place(staff), "preparing")

    assert field_paths(step(staff, order, "ready", attested=True)) == {"/attested"}
    assert field_paths(step(staff, order, "ready", expected_version=...)) == {"/expected_version"}
    stale = error_of(step(staff, order, "ready", expected_version=1), 409, "version_conflict")
    assert stale["details"]["latest_resource"] == order
    assert step(staff, order, "ready").json()["status"] == "ready"


# --- Cancelling ------------------------------------------------------------------------------


@pytest.mark.parametrize("status", ["pending", "confirmed", "preparing", "ready"])
def test_an_open_order_can_be_cancelled_with_a_reason(
    staff: TestClient, admin: StaffUser, clock: FakeClock, status: str
) -> None:
    order = moved_to(staff, place(staff, status="pending"), status)
    clock.advance(minutes=7)

    response = cancel(staff, order, reason="  Customer called it off \n")

    assert response.status_code == 200
    cancelled = response.json()
    assert (cancelled["status"], cancelled["version"]) == ("cancelled", order["version"] + 1)
    event = cancelled["status_history"][-1]
    assert {key: value for key, value in event.items() if key != "id"} == {
        "from_status": status,
        "to_status": "cancelled",
        "changed_at": format_instant(clock.now),
        "actor": {"id": admin.id, "display_name": "Admin"},
        "reason": "Customer called it off",
    }
    # What was agreed stays on record; only what is owed goes to nothing.
    assert cancelled["items"] == order["items"]
    assert money(cancelled) == (21500, 0, 0, 0, 0, 0, 0, "paid")
    assert allowed(cancelled) == set()
    assert cancelled["cancellation_requires_stock_acknowledgment"] is False
    assert read(staff, order["id"]) == cancelled


@pytest.mark.parametrize("status", ["completed", "cancelled"])
def test_a_finished_order_cannot_be_cancelled(staff: TestClient, status: str) -> None:
    order = moved_to(staff, place(staff), status)

    refused = error_of(cancel(staff, order), 409, "action_not_allowed")

    assert refused["message"].strip()
    assert read(staff, order["id"]) == order


def test_cancelling_keeps_the_money_already_taken_as_credit(staff: TestClient) -> None:
    order = paid(staff, place(staff), 5000)

    cancelled = cancel(staff, order).json()

    assert money(cancelled) == (21500, 0, 5000, 0, 5000, 0, 5000, "credit_due")
    assert cancelled["ledger"] == order["ledger"]
    assert allowed(cancelled) == {"refund"}
    payment = cancelled["permitted_actions"]["record_payment"]
    assert (payment["allowed"], payment["reason"]) == (
        False,
        "Cancelled orders cannot accept payments.",
    )


@pytest.mark.parametrize(
    ("changes", "path"),
    [
        ({"reason": ""}, "/reason"),
        ({"reason": "  \n "}, "/reason"),
        ({"reason": "x" * 1001}, "/reason"),
        ({"reason": None}, "/reason"),
        ({"reason": ...}, "/reason"),
        ({"acknowledge_consumed_stock": ...}, "/acknowledge_consumed_stock"),
        ({"acknowledge_consumed_stock": "yes"}, "/acknowledge_consumed_stock"),
        ({"expected_version": ...}, "/expected_version"),
        ({"refund": True}, "/refund"),
    ],
)
def test_a_malformed_cancellation_is_refused_at_the_field(
    staff: TestClient, changes: dict[str, Any], path: str
) -> None:
    order = place(staff)

    assert field_paths(cancel(staff, order, **changes)) == {path}
    assert read(staff, order["id"]) == order


def test_the_longest_reason_is_one_thousand_characters_after_trimming(staff: TestClient) -> None:
    order = place(staff)

    cancelled = cancel(staff, order, reason=" " + "x" * 1000 + " ").json()

    assert len(cancelled["status_history"][-1]["reason"]) == 1000


def test_cancelling_is_refused_when_stale_or_unknown_and_happens_once(staff: TestClient) -> None:
    order = place(staff)
    stale = error_of(cancel(staff, order, expected_version=2), 409, "version_conflict")
    assert stale["details"]["latest_resource"] == order
    error_of(cancel(staff, {"id": "ord_nowhere", "version": 1}), 404, "not_found")
    body = {"expected_version": 1, "reason": "Rain", "acknowledge_consumed_stock": True}
    path = f"/orders/{order['id']}/cancel"
    assert field_paths(staff.post(f"{API}{path}", json=body)) == {"/header/Idempotency-Key"}
    key = str(uuid.uuid4())

    first = keyed(staff, "POST", path, body, key)
    again = keyed(staff, "POST", path, body, key)

    assert (first.status_code, again.content) == (200, first.content)
    assert again.headers["Idempotency-Replayed"] == "true"
    history = read(staff, order["id"])["status_history"]
    assert [event["to_status"] for event in history] == ["pending", "confirmed", "cancelled"]


def test_a_cancelled_order_leaves_the_active_lists(staff: TestClient) -> None:
    order = place(staff)
    day = order["fulfillment"]["local_date"]
    cancel(staff, order)

    board = staff.get(f"{API}/dashboard?date={day}").json()
    listed = staff.get(f"{API}/orders?status=cancelled").json()["items"]

    assert (board["today"]["items"], board["upcoming"]["items"]) == ([], [])
    assert [(item["reference"], item["status"], item["balance_due_minor"]) for item in listed] == [
        (order["reference"], "cancelled", 0)
    ]
