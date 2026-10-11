import threading
import uuid
from collections.abc import Callable
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.persistence.models import StaffUser
from app.services.sessions import SESSION_COOKIE
from tests.order_support import (
    PAYING_SETTINGS,
    SETTINGS,
    as_saved,
    cancel,
    menu,
    money,
    moved_to,
    paid,
    pay,
    place,
    quoted,
    read,
    refund,
    revise,
)
from tests.support import API, Cli, error_of, field_paths, keyed, sign_in

Browser = Callable[..., TestClient]


@pytest.fixture
def staff(client: TestClient, admin: StaffUser, cli: Cli) -> TestClient:
    """Signed-in staff with orders, the menu and payments enabled."""
    assert cli(*PAYING_SETTINGS) == 0
    assert cli("menu", "seed") == 0
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
    return client


def payment_of(order: dict[str, Any], index: int = 0) -> dict[str, Any]:
    payments = [entry for entry in order["ledger"] if entry["type"] == "payment"]
    entry: dict[str, Any] = payments[index]
    return entry


# --- Payments --------------------------------------------------------------------------------


def test_a_deposit_is_recorded_as_one_ledger_entry_and_returned_with_the_order(
    staff: TestClient, admin: StaffUser
) -> None:
    order = place(staff)
    key = str(uuid.uuid4())

    response = pay(
        staff,
        order,
        5000,
        key,
        paid_on="2026-10-09",
        method="bank_transfer",
        reference="Transfer ABC",
        note="Deposit by phone",
    )

    assert response.status_code == 201
    result = response.json()
    assert set(result) == {"entry", "order"}
    entry, after = result["entry"], result["order"]
    assert entry == {
        "id": entry["id"],
        "type": "payment",
        "payment_id": None,
        "amount_minor": 5000,
        "refundable_minor": 5000,
        "business_date": "2026-10-09",
        "method": "bank_transfer",
        "reference": "Transfer ABC",
        "note": "Deposit by phone",
        "reason": None,
        "operation_id": key,
        "recorded_at": "2026-10-10T19:00:00Z",
        "recorded_by": {"id": admin.id, "display_name": "Admin"},
    }
    assert entry["id"].startswith("led_")
    assert after["ledger"] == [entry]
    assert (after["version"], after["status"]) == (order["version"] + 1, order["status"])
    assert money(after) == (21500, 21500, 5000, 0, 5000, 16500, 0, "partial")
    assert after["items"] == order["items"]
    assert read(staff, order["id"]) == after
    operation = staff.get(f"{API}/operations/{key}").json()
    assert (operation["state"], operation["resource_type"], operation["resource_id"]) == (
        "succeeded",
        "order",
        order["id"],
    )
    assert operation["result"] == {"http_status": 201, "body": result}


def test_the_worked_cases_from_unpaid_to_fully_paid(staff: TestClient) -> None:
    order = place(staff)
    assert money(order) == (21500, 21500, 0, 0, 0, 21500, 0, "unpaid")

    order = paid(staff, order, 5000)
    assert money(order) == (21500, 21500, 5000, 0, 5000, 16500, 0, "partial")

    order = paid(staff, order, 16500)
    assert money(order) == (21500, 21500, 21500, 0, 21500, 0, 0, "paid")
    assert [entry["refundable_minor"] for entry in order["ledger"]] == [5000, 16500]
    summary = staff.get(f"{API}/orders").json()["items"][0]
    assert (summary["payment_status"], summary["balance_due_minor"], summary["version"]) == (
        "paid",
        0,
        3,
    )


def test_the_worked_cases_for_a_cancelled_deposit(staff: TestClient) -> None:
    order = paid(staff, place(staff), 5000)

    order = cancel(staff, order).json()
    assert money(order) == (21500, 0, 5000, 0, 5000, 0, 5000, "credit_due")

    order = refund(staff, order, payment_of(order)["id"], 5000).json()["order"]
    assert money(order) == (21500, 0, 5000, 5000, 0, 0, 0, "paid")


def test_with_3500_due_only_an_amount_from_one_to_3500_is_accepted(staff: TestClient) -> None:
    order = paid(staff, place(staff), 18000)
    assert order["balance_due_minor"] == 3500

    for amount in [0, -1, 3501, 21500]:
        error = error_of(pay(staff, order, amount), 422, "validation_failed")
        assert [field["path"] for field in error["field_errors"]] == ["/amount_minor"]
        if amount > 0:
            assert error["details"] == {"maximum_amount_minor": 3500}
    for malformed in [1.5, "3500", None, True]:
        assert field_paths(pay(staff, order, malformed)) == {"/amount_minor"}
    assert read(staff, order["id"]) == order

    settled = paid(staff, order, 3500)
    assert money(settled) == (21500, 21500, 21500, 0, 21500, 0, 0, "paid")


def test_the_same_payment_sent_twice_is_one_entry(staff: TestClient) -> None:
    order = place(staff)
    key = str(uuid.uuid4())

    first = pay(staff, order, 5000, key)
    again = pay(staff, order, 5000, key)

    assert (first.status_code, again.status_code) == (201, 201)
    assert again.content == first.content
    assert again.headers["Idempotency-Replayed"] == "true"
    current = read(staff, order["id"])
    assert (len(current["ledger"]), current["payments_minor"], current["version"]) == (1, 5000, 2)


def test_two_payments_at_the_same_moment_cannot_overpay(
    staff: TestClient, browser: Browser
) -> None:
    order = place(staff)
    second = browser()
    second.headers["X-CSRF-Token"] = staff.headers["X-CSRF-Token"]
    second.headers["Cookie"] = f"{SESSION_COOKIE}={staff.cookies.get(SESSION_COOKIE)}"
    answers: list[Any] = []
    start = threading.Barrier(2)

    def send(client: TestClient) -> None:
        start.wait()
        answers.append(pay(client, order, 21500))

    threads = [threading.Thread(target=send, args=(client,)) for client in (staff, second)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert sorted(answer.status_code for answer in answers) == [201, 409]
    refused = next(answer for answer in answers if answer.status_code == 409)
    conflict = error_of(refused, 409, "version_conflict")
    current = read(staff, order["id"])
    assert conflict["details"]["latest_resource"] == current
    assert (len(current["ledger"]), money(current)[2:]) == (1, (21500, 0, 21500, 0, 0, "paid"))


def test_a_second_payment_is_measured_against_what_is_still_due(staff: TestClient) -> None:
    order = place(staff)
    after_first = paid(staff, order, 18000)

    # Someone who has seen the new version still cannot pay more than the 3500 left.
    too_much = error_of(pay(staff, after_first, 5000), 422, "validation_failed")

    assert too_much["details"] == {"maximum_amount_minor": 3500}
    error_of(pay(staff, order, 3500), 409, "version_conflict")
    assert read(staff, order["id"]) == after_first


@pytest.mark.parametrize(
    ("changes", "path"),
    [
        ({"paid_on": "2026-02-30"}, "/paid_on"),
        ({"paid_on": "10/10/2026"}, "/paid_on"),
        ({"paid_on": ...}, "/paid_on"),
        ({"method": "card"}, "/method"),
        ({"method": ...}, "/method"),
        ({"reference": "x" * 201}, "/reference"),
        ({"reference": None}, "/reference"),
        ({"note": "x" * 2001}, "/note"),
        ({"expected_version": ...}, "/expected_version"),
        ({"amount_minor": ...}, "/amount_minor"),
        ({"reason": "Because"}, "/reason"),
        ({"payment_id": "led_1"}, "/payment_id"),
        ({"refundable_minor": 1}, "/refundable_minor"),
    ],
)
def test_a_malformed_payment_is_refused_at_the_field(
    staff: TestClient, changes: dict[str, Any], path: str
) -> None:
    order = place(staff)

    assert field_paths(pay(staff, order, 5000, **changes)) == {path}
    assert read(staff, order["id"]) == order


def test_reference_and_note_are_optional_and_come_back_empty(staff: TestClient) -> None:
    order = place(staff)

    entry = pay(staff, order, 5000).json()["entry"]
    longest = pay(
        staff,
        {**order, "version": 2},
        100,
        reference="r" * 200,
        note="n" * 2000,
        paid_on="2031-01-01",
    ).json()["entry"]

    assert (entry["reference"], entry["note"]) == ("", "")
    assert (len(longest["reference"]), len(longest["note"])) == (200, 2000)
    # The business date is what staff entered; no past or future limit applies.
    assert longest["business_date"] == "2031-01-01"


def test_only_a_method_the_business_accepts_can_be_used(staff: TestClient, cli: Cli) -> None:
    cli("settings", "set", "--payment-methods=cash")
    order = place(staff)

    assert field_paths(pay(staff, order, 5000, method="bank_transfer")) == {"/method"}
    assert pay(staff, order, 5000, method="cash").status_code == 201


def test_payments_need_the_payments_workflow(
    client: TestClient, admin: StaffUser, cli: Cli
) -> None:
    cli(*SETTINGS, "--payment-methods=cash")
    cli("menu", "seed")
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
    order = place(client)

    for response in (pay(client, order, 5000), refund(client, order, "led_1", 5000)):
        assert error_of(response, 403, "action_forbidden")["message"] == "Payments are not enabled."
    for name in ("record_payment", "refund"):
        assert order["permitted_actions"][name]["reason"] == "Payments are not enabled."
    assert read(client, order["id"]) == order


def test_a_payment_is_refused_when_nothing_is_due_or_the_order_is_cancelled(
    staff: TestClient,
) -> None:
    settled = paid(staff, place(staff), 21500)
    cancelled = cancel(staff, place(staff)).json()

    nothing_due = error_of(pay(staff, settled, 1), 403, "action_forbidden")
    after_cancel = error_of(pay(staff, cancelled, 1), 403, "action_forbidden")

    assert nothing_due["message"] == "No balance is due."
    assert after_cancel["message"] == "Cancelled orders cannot accept payments."
    assert (read(staff, settled["id"]), read(staff, cancelled["id"])) == (settled, cancelled)


def test_payments_are_refused_when_stale_unknown_or_unkeyed(staff: TestClient) -> None:
    order = place(staff)
    body = {"expected_version": 1, "amount_minor": 5000, "paid_on": "2026-10-10", "method": "cash"}

    stale = error_of(pay(staff, order, 5000, expected_version=3), 409, "version_conflict")
    assert stale["details"]["latest_resource"] == order
    error_of(pay(staff, {"id": "ord_nowhere", "version": 1}, 5000), 404, "not_found")
    unkeyed = staff.post(f"{API}/orders/{order['id']}/payments", json=body)
    assert field_paths(unkeyed) == {"/header/Idempotency-Key"}
    assert read(staff, order["id"]) == order


def test_ledger_entries_cannot_be_edited_or_deleted(staff: TestClient) -> None:
    order = paid(staff, place(staff), 5000)
    entry = payment_of(order)

    for method in ("PATCH", "PUT", "DELETE"):
        for path in (
            f"/orders/{order['id']}/payments/{entry['id']}",
            f"/orders/{order['id']}/payments",
            f"/ledger/{entry['id']}",
        ):
            response = keyed(staff, method, path, {"amount_minor": 1})
            assert response.status_code in {404, 405}
    assert read(staff, order["id"]) == order


# --- Refunds ---------------------------------------------------------------------------------


def test_a_refund_is_a_separate_entry_that_points_at_its_payment(
    staff: TestClient, admin: StaffUser
) -> None:
    order = paid(staff, place(staff), 18000)
    original = payment_of(order)
    key = str(uuid.uuid4())

    response = refund(
        staff,
        order,
        original["id"],
        2000,
        key,
        refunded_on="2026-10-11",
        method="bank_transfer",
        reason="  Charged twice at the counter ",
        reference="Reversal 7",
    )

    assert response.status_code == 201
    entry, after = response.json()["entry"], response.json()["order"]
    assert entry == {
        "id": entry["id"],
        "type": "refund",
        "payment_id": original["id"],
        "amount_minor": 2000,
        "refundable_minor": None,
        "business_date": "2026-10-11",
        "method": "bank_transfer",
        "reference": "Reversal 7",
        "note": "",
        "reason": "Charged twice at the counter",
        "operation_id": key,
        "recorded_at": "2026-10-10T19:00:00Z",
        "recorded_by": {"id": admin.id, "display_name": "Admin"},
    }
    # The payment itself is untouched; only what can still be returned from it has changed.
    assert after["ledger"] == [{**original, "refundable_minor": 16000}, entry]
    assert money(after) == (21500, 21500, 18000, 2000, 16000, 5500, 0, "partial")
    assert (after["version"], after["status"]) == (order["version"] + 1, "confirmed")
    assert read(staff, order["id"]) == after
    operation = staff.get(f"{API}/operations/{key}").json()
    assert (operation["resource_type"], operation["resource_id"]) == ("order", order["id"])
    assert operation["result"]["body"] == response.json()


def test_a_refund_is_capped_by_its_own_payment_not_by_the_orders_funds(staff: TestClient) -> None:
    order = paid(staff, place(staff), 5000)
    order = paid(staff, order, 10000)
    first = payment_of(order, 0)
    order = refund(staff, order, first["id"], 2000).json()["order"]
    assert (payment_of(order, 0)["refundable_minor"], order["net_paid_minor"]) == (3000, 13000)

    over = error_of(refund(staff, order, first["id"], 3001), 422, "validation_failed")

    assert [field["path"] for field in over["field_errors"]] == ["/amount_minor"]
    assert over["details"] == {"maximum_amount_minor": 3000}
    order = refund(staff, order, first["id"], 3000).json()["order"]
    assert [entry["refundable_minor"] for entry in order["ledger"]] == [0, 10000, None, None]
    spent = error_of(refund(staff, order, first["id"], 1), 422, "validation_failed")
    assert spent["details"] == {"maximum_amount_minor": 0}
    assert money(order) == (21500, 21500, 15000, 5000, 10000, 11500, 0, "partial")


@pytest.mark.parametrize("amount", [0, -5, 1.5, "100", None])
def test_a_refund_amount_is_a_positive_whole_number(staff: TestClient, amount: Any) -> None:
    order = paid(staff, place(staff), 5000)

    assert field_paths(refund(staff, order, payment_of(order)["id"], amount)) == {"/amount_minor"}
    assert read(staff, order["id"]) == order


def test_a_refund_names_a_payment_of_the_same_order(staff: TestClient) -> None:
    order = paid(staff, place(staff), 5000)
    order = refund(staff, order, payment_of(order)["id"], 1000).json()["order"]
    earlier_refund = order["ledger"][1]
    other = paid(staff, place(staff), 5000)

    candidates = ["led_nowhere", earlier_refund["id"], payment_of(other)["id"], None, 7, ...]
    for payment_id in candidates:
        assert field_paths(refund(staff, order, payment_id, 500)) == {"/payment_id"}
    assert read(staff, order["id"]) == order


@pytest.mark.parametrize(
    ("changes", "path"),
    [
        ({"reason": ""}, "/reason"),
        ({"reason": "   "}, "/reason"),
        ({"reason": "x" * 1001}, "/reason"),
        ({"reason": ...}, "/reason"),
        ({"refunded_on": "2026-13-01"}, "/refunded_on"),
        ({"refunded_on": ...}, "/refunded_on"),
        ({"paid_on": "2026-10-10"}, "/paid_on"),
        ({"method": "voucher"}, "/method"),
        ({"reference": "x" * 201}, "/reference"),
        ({"note": "x" * 2001}, "/note"),
        ({"expected_version": ...}, "/expected_version"),
    ],
)
def test_a_malformed_refund_is_refused_at_the_field(
    staff: TestClient, changes: dict[str, Any], path: str
) -> None:
    order = paid(staff, place(staff), 5000)

    refused = refund(staff, order, payment_of(order)["id"], 1000, **changes)

    assert field_paths(refused) == {path}
    assert read(staff, order["id"]) == order


def test_a_refund_is_possible_on_a_completed_order(staff: TestClient) -> None:
    order = paid(staff, moved_to(staff, place(staff), "completed"), 21500)

    after = refund(staff, order, payment_of(order)["id"], 500).json()["order"]

    assert (after["status"], money(after)[2:]) == (
        "completed",
        (21500, 500, 21000, 500, 0, "partial"),
    )


def test_there_is_nothing_to_refund_before_anything_is_paid(staff: TestClient) -> None:
    order = place(staff)

    refused = error_of(refund(staff, order, "led_nowhere", 100), 403, "action_forbidden")

    assert refused["message"] == "No refundable funds remain."
    assert order["permitted_actions"]["refund"]["allowed"] is False


def test_the_same_refund_sent_twice_is_one_entry(staff: TestClient) -> None:
    order = paid(staff, place(staff), 5000)
    key = str(uuid.uuid4())

    first = refund(staff, order, payment_of(order)["id"], 1000, key)
    again = refund(staff, order, payment_of(order)["id"], 1000, key)

    assert (first.status_code, again.content) == (201, first.content)
    assert again.headers["Idempotency-Replayed"] == "true"
    current = read(staff, order["id"])
    assert (len(current["ledger"]), current["refunds_minor"]) == (2, 1000)


def test_a_refund_only_a_method_the_business_accepts(staff: TestClient, cli: Cli) -> None:
    order = paid(staff, place(staff), 5000)
    cli("settings", "set", "--payment-methods=bank_transfer")

    assert field_paths(refund(staff, order, payment_of(order)["id"], 100)) == {"/method"}


# --- Credit after an edit --------------------------------------------------------------------


def lowered_to_15000(client: TestClient, order: dict[str, Any]) -> dict[str, Any]:
    """One tray, the package and five lumpia: 8000 + 5500 + 1500."""
    body = as_saved(order)
    body["items"][0]["quantity"] = 1
    body["items"].append(
        {
            "client_line_id": "new",
            "variant_id": menu(client)[("Fresh Lumpia", "Each")]["id"],
            "quantity": 5,
            "preparation_notes": "",
        }
    )
    return body


def put(
    client: TestClient, order: dict[str, Any], body: dict[str, Any], quote: Any, ack: bool
) -> Any:
    request = {
        "expected_version": order["version"],
        "quote_id": quote["id"],
        "draft": body,
        "acknowledge_credit": ack,
    }
    return keyed(client, "PUT", f"/orders/{order['id']}", request)


def test_lowering_a_paid_order_needs_the_credit_acknowledged_then_a_separate_refund(
    staff: TestClient,
) -> None:
    order = paid(staff, place(staff), 18000)
    body = lowered_to_15000(staff, order)

    quote = quoted(staff, body, order)

    assert (quote["total_minor"], quote["net_paid_minor"]) == (15000, 18000)
    assert (quote["balance_due_minor"], quote["customer_credit_minor"]) == (0, 3000)
    assert quote["credit_acknowledgment_required"] is True
    assert field_paths(put(staff, order, body, quote, ack=False)) == {"/acknowledge_credit"}
    assert read(staff, order["id"]) == order

    edited = put(staff, order, body, quote, ack=True)

    assert edited.status_code == 200
    order = edited.json()
    assert money(order) == (15000, 15000, 18000, 0, 18000, 0, 3000, "credit_due")
    # Nothing was refunded by the edit; staff do that as its own recorded step.
    assert len(order["ledger"]) == 1
    payment = payment_of(order)
    order = refund(staff, order, payment["id"], 3000).json()["order"]
    assert money(order) == (15000, 15000, 18000, 3000, 15000, 0, 0, "paid")
    kept = payment_of(order)
    assert (kept["amount_minor"], kept["refundable_minor"]) == (18000, 15000)
    excess = error_of(refund(staff, order, payment["id"], 15001), 422, "validation_failed")
    assert excess["details"] == {"maximum_amount_minor": 15000}


def test_an_edit_that_leaves_no_credit_needs_no_acknowledgment(staff: TestClient) -> None:
    order = paid(staff, place(staff), 5000)
    body = lowered_to_15000(staff, order)

    quote = quoted(staff, body, order)
    edited = put(staff, order, body, quote, ack=False)

    assert quote["credit_acknowledgment_required"] is False
    assert money(edited.json()) == (15000, 15000, 5000, 0, 5000, 10000, 0, "partial")
    assert edited.json()["ledger"] == order["ledger"]


def test_an_edit_cannot_overwrite_a_payment_that_arrived_during_its_review(
    staff: TestClient,
) -> None:
    order = place(staff)
    body = as_saved(order)
    body["notes"] = "Reviewed before the payment came in"
    quote = quoted(staff, body, order)
    with_payment = paid(staff, order, 5000)

    late = put(staff, order, body, quote, ack=False)

    conflict = error_of(late, 409, "version_conflict")
    assert conflict["details"]["latest_resource"] == with_payment
    assert read(staff, order["id"]) == with_payment
    # Reviewed again against the paid order, the same edit goes through and the payment stays.
    saved = revise(staff, with_payment, body).json()
    assert (saved["notes"], saved["payments_minor"], len(saved["ledger"])) == (
        "Reviewed before the payment came in",
        5000,
        1,
    )
