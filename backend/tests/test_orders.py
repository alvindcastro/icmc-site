import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.persistence.database import Database
from app.persistence.models import Quote as StoredQuote
from app.persistence.models import StaffUser
from app.values import MAX_SAFE_INTEGER
from tests.order_support import (
    ACTIONS,
    ALLOWED,
    DELIVERY,
    PICKUP,
    SETTINGS,
    as_saved,
    ask,
    change,
    creation,
    draft,
    menu,
    place,
    quoted,
    read,
    references,
    revise,
    set_status,
)
from tests.support import API, Cli, FakeClock, error_of, field_paths, keyed, sign_in


@pytest.fixture
def staff(client: TestClient, admin: StaffUser, cli: Cli) -> TestClient:
    """Signed-in staff with orders and the menu enabled and the provisional menu seeded."""
    assert cli(*SETTINGS) == 0
    assert cli("menu", "seed") == 0
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
    return client


# --- Access ----------------------------------------------------------------------------------


def test_orders_need_a_session_and_the_orders_workflow(
    client: TestClient, admin: StaffUser, cli: Cli
) -> None:
    paths = ["/orders", "/orders/ord_1", "/dashboard"]
    for path in paths:
        error_of(client.get(f"{API}{path}"), 401, "unauthenticated")
    cli(*SETTINGS[:-1])
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]

    for path in paths:
        error_of(client.get(f"{API}{path}"), 403, "action_forbidden")
    error_of(client.post(f"{API}/orders/quote", json={"draft": {}}), 403, "action_forbidden")
    error_of(keyed(client, "POST", "/orders", {}), 403, "action_forbidden")

    cli("settings", "set", "--enable=orders")
    assert client.get(f"{API}/orders").json()["items"] == []


# --- Quotes ----------------------------------------------------------------------------------


def test_two_medium_trays_and_one_package_are_quoted_at_21500(
    staff: TestClient, clock: FakeClock
) -> None:
    body = draft(staff)
    variants = menu(staff)

    quote = quoted(staff, body)

    assert set(quote) == {
        "id",
        "expires_at",
        "order_id",
        "expected_version",
        "settings_version",
        "currency",
        "minor_digits",
        "fulfillment",
        "lines",
        "subtotal_minor",
        "delivery_charge_minor",
        "tax_minor",
        "total_minor",
        "settlement_total_minor",
        "net_paid_minor",
        "balance_due_minor",
        "customer_credit_minor",
        "credit_acknowledgment_required",
    }
    assert quote["lines"] == [
        {
            "client_line_id": "line_0",
            "order_item_id": None,
            "variant_id": variants[("Beef Caldereta", "Medium")]["id"],
            "food_name": "Beef Caldereta",
            "variant_label": "Medium",
            "selling_unit": "tray",
            "package_contents": None,
            "unit_price_minor": 8000,
            "quantity": 2,
            "line_total_minor": 16000,
            "preparation_notes": "",
            "prepared_quantity": None,
            "remaining_quantity": None,
        },
        {
            "client_line_id": "line_1",
            "order_item_id": None,
            "variant_id": variants[("Shanghai Spring Rolls", "100 pieces")]["id"],
            "food_name": "Shanghai Spring Rolls",
            "variant_label": "100 pieces",
            "selling_unit": "package",
            "package_contents": {"quantity": 100, "unit": "piece"},
            "unit_price_minor": 5500,
            "quantity": 1,
            "line_total_minor": 5500,
            "preparation_notes": "",
            "prepared_quantity": None,
            "remaining_quantity": None,
        },
    ]
    assert quote["fulfillment"] == {
        **PICKUP,
        "utc_offset": "-07:00",
        "fulfillment_at": "2026-10-12T19:00:00Z",
        "pickup_location": None,
    }
    amounts = {key: value for key, value in quote.items() if key.endswith("_minor")}
    assert amounts == {
        "subtotal_minor": 21500,
        "delivery_charge_minor": 0,
        "tax_minor": 0,
        "total_minor": 21500,
        "settlement_total_minor": 21500,
        "net_paid_minor": 0,
        "balance_due_minor": 21500,
        "customer_credit_minor": 0,
    }
    assert (quote["order_id"], quote["expected_version"]) == (None, None)
    assert (quote["currency"], quote["minor_digits"], quote["settings_version"]) == ("USD", 2, 1)
    assert quote["credit_acknowledgment_required"] is False
    assert quote["expires_at"] == "2026-10-10T19:05:00Z"
    assert quote["id"].startswith("quote_")


def test_a_quote_saves_nothing(staff: TestClient) -> None:
    quoted(staff, draft(staff))

    assert staff.get(f"{API}/orders").json()["total"] == 0


def test_a_quote_needs_the_csrf_token_but_no_operation_key(staff: TestClient, browser: Any) -> None:
    body = draft(staff)
    assert ask(staff, body).status_code == 200

    forged = browser("https://evil.example").post(f"{API}/orders/quote", json={"draft": body})
    error_of(forged, 403, "csrf_invalid")


def test_delivery_and_tax_are_added_to_the_total(staff: TestClient) -> None:
    body = draft(staff)
    body.update(fulfillment=dict(DELIVERY), delivery_charge_minor=1500, tax_minor=250)

    quote = quoted(staff, body)

    assert (quote["subtotal_minor"], quote["delivery_charge_minor"], quote["tax_minor"]) == (
        21500,
        1500,
        250,
    )
    assert (quote["total_minor"], quote["balance_due_minor"]) == (23250, 23250)
    assert quote["fulfillment"]["address"] == "12 Mabini Street"
    assert quote["fulfillment"]["pickup_location"] is None


def test_a_fixed_delivery_charge_is_the_servers_whatever_the_draft_says(
    staff: TestClient, cli: Cli
) -> None:
    cli("settings", "set", "--delivery-mode=fixed_amount", "--fixed-charge-minor=900")
    body = draft(staff)
    body.update(fulfillment=dict(DELIVERY), delivery_charge_minor=1)

    quote = quoted(staff, body)

    assert (quote["delivery_charge_minor"], quote["total_minor"]) == (900, 22400)
    assert quote["settings_version"] == 2


def test_disabled_delivery_is_refused_at_the_method(staff: TestClient, cli: Cli) -> None:
    cli("settings", "set", "--delivery-mode=disabled")
    body = draft(staff)
    body["fulfillment"] = dict(DELIVERY)

    assert field_paths(ask(staff, body)) == {"/draft/fulfillment/method"}


def test_a_method_the_business_does_not_offer_is_refused(staff: TestClient, cli: Cli) -> None:
    cli("settings", "set", "--fulfillment=delivery")

    assert field_paths(ask(staff, draft(staff))) == {"/draft/fulfillment/method"}


def test_pickup_shows_the_configured_pickup_location(staff: TestClient, cli: Cli) -> None:
    cli("settings", "set", "--pickup-location=Stall 4, Public Market")

    assert quoted(staff, draft(staff))["fulfillment"]["pickup_location"] == "Stall 4, Public Market"


@pytest.mark.parametrize(
    ("path", "value", "reported"),
    [
        ("/customer/name", " ", "/draft/customer/name"),
        ("/customer/name", "x" * 201, "/draft/customer/name"),
        ("/customer/name", ..., "/draft/customer/name"),
        ("/customer/phone", "", "/draft/customer/phone"),
        ("/customer/phone", "5" * 51, "/draft/customer/phone"),
        ("/customer/phone", 5550100, "/draft/customer/phone"),
        ("/customer/notes", "x" * 2001, "/draft/customer/notes"),
        ("/customer/email", "a@b.example", "/draft/customer/email"),
        ("/notes", "x" * 2001, "/draft/notes"),
        ("/notes", None, "/draft/notes"),
        ("/items", [], "/draft/items"),
        ("/items", ..., "/draft/items"),
        ("/items/0/quantity", 0, "/draft/items/0/quantity"),
        ("/items/0/quantity", -2, "/draft/items/0/quantity"),
        ("/items/1/quantity", 1.5, "/draft/items/1/quantity"),
        ("/items/0/quantity", "2", "/draft/items/0/quantity"),
        ("/items/0/quantity", MAX_SAFE_INTEGER, "/draft/items/0/quantity"),
        ("/items/1/client_line_id", "line_0", "/draft/items/1/client_line_id"),
        ("/items/0/client_line_id", " ", "/draft/items/0/client_line_id"),
        ("/items/0/variant_id", "var_nowhere", "/draft/items/0/variant_id"),
        ("/items/0/order_item_id", "item_nowhere", "/draft/items/0/variant_id"),
        ("/items/0/preparation_notes", "x" * 1001, "/draft/items/0/preparation_notes"),
        ("/items/0/unit_price_minor", 1, "/draft/items/0/unit_price_minor"),
        ("/items/0/food_name", "Free lunch", "/draft/items/0/food_name"),
        ("/fulfillment/address", "12 Mabini Street", "/draft/fulfillment/address"),
        ("/fulfillment/timezone", "Asia/Manila", "/draft/fulfillment/timezone"),
        ("/fulfillment/local_date", "2026-02-30", "/draft/fulfillment/local_date"),
        ("/fulfillment/local_date", "12 Oct 2026", "/draft/fulfillment/local_date"),
        ("/fulfillment/local_time", "24:00", "/draft/fulfillment/local_time"),
        ("/fulfillment/local_time", "9:00", "/draft/fulfillment/local_time"),
        ("/fulfillment/local_time", "12:00:00", "/draft/fulfillment/local_time"),
        ("/fulfillment/utc_offset", "PDT", "/draft/fulfillment/utc_offset"),
        ("/fulfillment/utc_offset", "-08:00", "/draft/fulfillment/utc_offset"),
        ("/fulfillment/method", "courier", "/draft/fulfillment/method"),
        (
            "/fulfillment/fulfillment_at",
            "2026-10-12T19:00:00Z",
            "/draft/fulfillment/fulfillment_at",
        ),
        ("/delivery_charge_minor", -1, "/draft/delivery_charge_minor"),
        ("/delivery_charge_minor", 500, "/draft/delivery_charge_minor"),
        ("/tax_minor", -1, "/draft/tax_minor"),
        ("/tax_minor", 1.5, "/draft/tax_minor"),
        ("/tax_minor", ..., "/draft/tax_minor"),
        ("/total_minor", 1, "/draft/total_minor"),
        ("/subtotal_minor", 1, "/draft/subtotal_minor"),
    ],
)
def test_an_invalid_draft_is_refused_at_the_field(
    staff: TestClient, path: str, value: Any, reported: str
) -> None:
    assert field_paths(ask(staff, change(draft(staff), path, value))) == {reported}


@pytest.mark.parametrize(
    ("path", "value", "reported"),
    [
        ("/address", None, "/draft/fulfillment/address"),
        ("/address", "   ", "/draft/fulfillment/address"),
        ("/address", "x" * 1001, "/draft/fulfillment/address"),
    ],
)
def test_delivery_needs_an_address(staff: TestClient, path: str, value: Any, reported: str) -> None:
    body = draft(staff)
    body["fulfillment"] = change(DELIVERY, path, value)

    assert field_paths(ask(staff, body)) == {reported}


def test_a_total_beyond_the_safe_bound_is_a_field_error_not_a_rounded_number(
    staff: TestClient,
) -> None:
    body = draft(staff, [("Fresh Lumpia", "Each", MAX_SAFE_INTEGER // 300)])
    assert quoted(staff, body)["total_minor"] == (MAX_SAFE_INTEGER // 300) * 300
    body["tax_minor"] = 300

    assert field_paths(ask(staff, body)) == {"/draft/tax_minor"}


def test_text_is_trimmed_and_missing_notes_come_back_empty(staff: TestClient) -> None:
    body = draft(staff)
    body["customer"] = {"name": "  Maria Clara ", "phone": " 555-0199  "}
    del body["notes"]
    del body["items"][0]["preparation_notes"]
    body["fulfillment"] = {**DELIVERY, "address": "  12 Mabini Street  "}

    order = place(staff, body)

    assert order["customer"] == {"name": "Maria Clara", "phone": "555-0199", "notes": ""}
    assert (order["notes"], order["items"][0]["preparation_notes"]) == ("", "")
    assert order["fulfillment"]["address"] == "12 Mabini Street"


# --- Business time ---------------------------------------------------------------------------


def test_a_time_that_happens_twice_asks_for_its_offset(staff: TestClient) -> None:
    body = draft(staff)
    body["fulfillment"] = {**PICKUP, "local_date": "2026-11-01", "local_time": "01:30"}

    error = error_of(ask(staff, body), 422, "validation_failed")

    assert [field["path"] for field in error["field_errors"]] == ["/draft/fulfillment/utc_offset"]
    assert error["details"] == {"utc_offsets": ["-07:00", "-08:00"]}
    for offset, instant in [("-07:00", "2026-11-01T08:30:00Z"), ("-08:00", "2026-11-01T09:30:00Z")]:
        body["fulfillment"]["utc_offset"] = offset
        fulfillment = quoted(staff, body)["fulfillment"]
        assert (fulfillment["utc_offset"], fulfillment["fulfillment_at"]) == (offset, instant)


def test_a_time_skipped_by_daylight_saving_is_refused(staff: TestClient) -> None:
    body = draft(staff)
    body["fulfillment"] = {**PICKUP, "local_date": "2026-03-08", "local_time": "02:30"}

    assert field_paths(ask(staff, body)) == {"/draft/fulfillment/local_time"}


def test_a_winter_order_resolves_with_the_winter_offset(staff: TestClient) -> None:
    body = draft(staff)
    body["fulfillment"] = {**PICKUP, "local_date": "2026-12-24", "local_time": "18:30"}

    fulfillment = place(staff, body)["fulfillment"]

    assert (fulfillment["utc_offset"], fulfillment["fulfillment_at"]) == (
        "-08:00",
        "2026-12-25T02:30:00Z",
    )


# --- Availability and confirmation -----------------------------------------------------------


def test_an_unavailable_variant_or_food_cannot_be_newly_ordered(staff: TestClient) -> None:
    variants = menu(staff)
    medium = variants[("Beef Caldereta", "Medium")]
    keyed(staff, "PATCH", f"/variants/{medium['id']}", {"expected_version": 1, "available": False})
    assert field_paths(ask(staff, draft(staff))) == {"/draft/items/0/variant_id"}

    keyed(staff, "PATCH", f"/variants/{medium['id']}", {"expected_version": 2, "available": True})
    food = staff.get(f"{API}/foods/{medium['food_id']}").json()
    keyed(
        staff,
        "PATCH",
        f"/foods/{food['id']}",
        {"expected_version": food["version"], "available": False},
    )
    assert field_paths(ask(staff, draft(staff))) == {"/draft/items/0/variant_id"}


def test_development_settings_take_orders_unconfirmed(staff: TestClient) -> None:
    assert place(staff)["total_minor"] == 21500


def test_live_orders_wait_for_confirmed_settings_and_a_confirmed_menu(
    staff: TestClient, cli: Cli
) -> None:
    cli("settings", "set", "--environment=live")
    body = draft(staff, [("Fresh Lumpia", "Each", 10)])

    unconfirmed = error_of(ask(staff, body), 409, "settings_unconfirmed")
    assert unconfirmed["details"] == {
        "unconfirmed": ["currency", "timezone", "fulfillment", "delivery", "tax"]
    }
    cli("settings", "confirm", "--all")
    error_of(ask(staff, body), 409, "menu_unconfirmed")

    lumpia = menu(staff)[("Fresh Lumpia", "Each")]
    cli("menu", "confirm", "variant", lumpia["id"], "--version", "1")
    error_of(ask(staff, body), 409, "menu_unconfirmed")
    cli("menu", "confirm", "food", lumpia["food_id"], "--version", "2")

    assert quoted(staff, body)["total_minor"] == 3000
    # In a live system the reference no longer marks the order as development data.
    assert not place(staff, body)["reference"].startswith("DEV-")


# --- Saving a new order ----------------------------------------------------------------------


def test_a_confirmed_order_is_saved_with_snapshots_totals_and_history(
    staff: TestClient, admin: StaffUser, clock: FakeClock
) -> None:
    body = draft(staff)
    quote = quoted(staff, body)
    key = str(uuid.uuid4())

    response = keyed(staff, "POST", "/orders", creation(body, quote), key)

    assert response.status_code == 201
    order = response.json()
    assert set(order) == {
        "id",
        "reference",
        "version",
        "currency",
        "minor_digits",
        "customer",
        "fulfillment",
        "items",
        "notes",
        "status",
        "preparation_tracking",
        "cancellation_requires_stock_acknowledgment",
        "subtotal_minor",
        "delivery_charge_minor",
        "tax_minor",
        "total_minor",
        "settlement_total_minor",
        "payments_minor",
        "refunds_minor",
        "net_paid_minor",
        "balance_due_minor",
        "customer_credit_minor",
        "payment_status",
        "ledger",
        "status_history",
        "permitted_actions",
        "created_at",
        "updated_at",
    }
    assert order["id"].startswith("ord_")
    assert (order["reference"], order["version"], order["status"]) == ("DEV-0001", 1, "confirmed")
    assert (order["currency"], order["minor_digits"]) == ("USD", 2)
    assert order["customer"] == {"name": "Sample Customer", "phone": "555-0100", "notes": ""}
    assert order["fulfillment"] == quote["fulfillment"]
    assert [
        {key: value for key, value in item.items() if key != "id"} for item in order["items"]
    ] == [
        {
            key: value
            for key, value in line.items()
            if key not in ("client_line_id", "order_item_id")
        }
        for line in quote["lines"]
    ]
    assert all(item["id"].startswith("item_") for item in order["items"])
    assert len({item["id"] for item in order["items"]}) == 2
    amounts = {key: value for key, value in order.items() if key.endswith("_minor")}
    assert amounts == {
        "subtotal_minor": 21500,
        "delivery_charge_minor": 0,
        "tax_minor": 0,
        "total_minor": 21500,
        "settlement_total_minor": 21500,
        "payments_minor": 0,
        "refunds_minor": 0,
        "net_paid_minor": 0,
        "balance_due_minor": 21500,
        "customer_credit_minor": 0,
    }
    assert (order["payment_status"], order["ledger"]) == ("unpaid", [])
    assert order["preparation_tracking"] == "manual"
    assert order["cancellation_requires_stock_acknowledgment"] is False
    actor = {"id": admin.id, "display_name": "Admin"}
    assert [
        {key: value for key, value in event.items() if key != "id"}
        for event in order["status_history"]
    ] == [
        {
            "from_status": None,
            "to_status": "pending",
            "changed_at": "2026-10-10T19:00:00Z",
            "actor": actor,
            "reason": None,
        },
        {
            "from_status": "pending",
            "to_status": "confirmed",
            "changed_at": "2026-10-10T19:00:00Z",
            "actor": actor,
            "reason": None,
        },
    ]
    assert len({event["id"] for event in order["status_history"]}) == 2
    assert (order["created_at"], order["updated_at"]) == (
        "2026-10-10T19:00:00Z",
        "2026-10-10T19:00:00Z",
    )
    assert read(staff, order["id"]) == order
    operation = staff.get(f"{API}/operations/{key}").json()
    assert (operation["state"], operation["resource_type"], operation["resource_id"]) == (
        "succeeded",
        "order",
        order["id"],
    )
    assert operation["result"] == {"http_status": 201, "body": order}


def test_every_action_is_reported_and_a_blocked_one_says_why(staff: TestClient) -> None:
    pending = place(staff, status="pending")
    confirmed = place(staff)

    for order in (pending, confirmed):
        actions = order["permitted_actions"]
        assert set(actions) == ACTIONS
        for action in actions.values():
            assert action == ALLOWED or (
                action["allowed"] is False
                and action["reason"].strip()
                and action["reason_code"].strip()
            )
    assert (pending["permitted_actions"]["edit"], pending["permitted_actions"]["confirm"]) == (
        ALLOWED,
        ALLOWED,
    )
    assert confirmed["permitted_actions"]["edit"] == ALLOWED
    assert confirmed["permitted_actions"]["confirm"]["allowed"] is False
    # Payments are not enabled here, and nothing is recorded as prepared.
    for name in ("record_payment", "refund", "record_preparation"):
        assert pending["permitted_actions"][name]["allowed"] is False
        assert confirmed["permitted_actions"][name]["allowed"] is False


def test_a_pending_order_starts_with_one_history_event(staff: TestClient) -> None:
    order = place(staff, status="pending")

    assert order["status"] == "pending"
    assert [(event["from_status"], event["to_status"]) for event in order["status_history"]] == [
        (None, "pending")
    ]


def test_references_count_up_and_a_refused_save_does_not_use_one(staff: TestClient) -> None:
    first = place(staff)
    body = draft(staff)
    stale = keyed(staff, "POST", "/orders", creation(body, {"id": "quote_nowhere"}))
    error_of(stale, 409, "quote_stale")
    second = place(staff)

    assert (first["reference"], second["reference"]) == ("DEV-0001", "DEV-0002")
    assert first["id"] != second["id"]


def test_an_order_that_costs_nothing_is_paid_not_unpaid(staff: TestClient) -> None:
    lumpia = menu(staff)[("Fresh Lumpia", "Each")]
    keyed(staff, "PATCH", f"/variants/{lumpia['id']}", {"expected_version": 1, "price_minor": 0})

    order = place(staff, draft(staff, [("Fresh Lumpia", "Each", 12)]))

    assert (order["total_minor"], order["balance_due_minor"], order["payment_status"]) == (
        0,
        0,
        "paid",
    )


def test_saving_needs_an_operation_key_and_repeats_are_one_order(staff: TestClient) -> None:
    body = draft(staff)
    request = creation(body, quoted(staff, body))
    assert field_paths(staff.post(f"{API}/orders", json=request)) == {"/header/Idempotency-Key"}
    key = str(uuid.uuid4())

    first = keyed(staff, "POST", "/orders", request, key)
    again = keyed(staff, "POST", "/orders", request, key)

    assert (first.status_code, again.status_code) == (201, 201)
    assert again.content == first.content
    assert again.headers["Idempotency-Replayed"] == "true"
    assert references(staff) == ["DEV-0001"]


@pytest.mark.parametrize(
    ("changes", "path"),
    [
        ({"initial_status": "preparing"}, "/initial_status"),
        ({"initial_status": None}, "/initial_status"),
        ({"acknowledge_credit": "no"}, "/acknowledge_credit"),
        ({"acknowledge_credit": ...}, "/acknowledge_credit"),
        ({"quote_id": ...}, "/quote_id"),
        ({"total_minor": 1}, "/total_minor"),
        ({"status": "completed"}, "/status"),
    ],
)
def test_a_malformed_save_is_refused_at_the_field(
    staff: TestClient, changes: dict[str, Any], path: str
) -> None:
    body = draft(staff)
    request = creation(body, quoted(staff, body))
    for name, value in changes.items():
        request = change(request, f"/{name}", value)

    assert field_paths(keyed(staff, "POST", "/orders", request)) == {path}
    assert references(staff) == []


# --- A quote that no longer holds ------------------------------------------------------------


def test_an_unknown_or_expired_quote_is_stale(staff: TestClient, clock: FakeClock) -> None:
    body = draft(staff)
    quote = quoted(staff, body)
    error_of(
        keyed(staff, "POST", "/orders", creation(body, {"id": "quote_nowhere"})), 409, "quote_stale"
    )
    clock.advance(minutes=4, seconds=59)
    fresh_enough = quoted(staff, body)
    clock.advance(seconds=1)

    error_of(keyed(staff, "POST", "/orders", creation(body, quote)), 409, "quote_stale")

    assert references(staff) == []
    assert keyed(staff, "POST", "/orders", creation(body, fresh_enough)).status_code == 201


def test_the_saved_draft_must_be_the_quoted_draft(staff: TestClient) -> None:
    body = draft(staff)
    quote = quoted(staff, body)

    for path, value in [
        ("/items/0/quantity", 3),
        ("/customer/name", "Someone Else"),
        ("/tax_minor", 1),
    ]:
        different = change(body, path, value)
        error_of(keyed(staff, "POST", "/orders", creation(different, quote)), 409, "quote_stale")

    assert references(staff) == []


def test_the_same_draft_written_differently_is_still_the_quoted_draft(staff: TestClient) -> None:
    body = draft(staff)
    quote = quoted(staff, body)
    rewritten = change(change(body, "/notes", ...), "/customer/name", "  Sample Customer ")
    rewritten["fulfillment"] = dict(reversed(list(rewritten["fulfillment"].items())))

    assert keyed(staff, "POST", "/orders", creation(rewritten, quote)).status_code == 201


def test_a_quote_buys_one_order(staff: TestClient) -> None:
    body = draft(staff)
    quote = quoted(staff, body)
    assert keyed(staff, "POST", "/orders", creation(body, quote)).status_code == 201

    error_of(keyed(staff, "POST", "/orders", creation(body, quote)), 409, "quote_stale")

    assert references(staff) == ["DEV-0001"]


def test_a_price_change_after_the_quote_makes_it_stale(staff: TestClient) -> None:
    body = draft(staff)
    quote = quoted(staff, body)
    medium = menu(staff)[("Beef Caldereta", "Medium")]
    keyed(staff, "PATCH", f"/variants/{medium['id']}", {"expected_version": 1, "price_minor": 8500})
    key = str(uuid.uuid4())

    stale = keyed(staff, "POST", "/orders", creation(body, quote), key)

    error_of(stale, 409, "quote_stale")
    assert references(staff) == []
    # The refusal is the recorded outcome of that key.
    assert staff.get(f"{API}/operations/{key}").json()["state"] == "rejected"
    assert place(staff, body)["subtotal_minor"] == 22500


def test_a_rename_after_the_quote_makes_it_stale(staff: TestClient) -> None:
    body = draft(staff)
    quote = quoted(staff, body)
    medium = menu(staff)[("Beef Caldereta", "Medium")]
    food = staff.get(f"{API}/foods/{medium['food_id']}").json()
    keyed(staff, "PATCH", f"/foods/{food['id']}", {"expected_version": 1, "name": "Kaldereta"})

    error_of(keyed(staff, "POST", "/orders", creation(body, quote)), 409, "quote_stale")


def test_a_variant_withdrawn_after_the_quote_is_refused_at_the_line(staff: TestClient) -> None:
    body = draft(staff)
    quote = quoted(staff, body)
    package = menu(staff)[("Shanghai Spring Rolls", "100 pieces")]
    keyed(staff, "PATCH", f"/variants/{package['id']}", {"expected_version": 1, "available": False})

    refused = keyed(staff, "POST", "/orders", creation(body, quote))

    assert field_paths(refused) == {"/draft/items/1/variant_id"}
    assert references(staff) == []


def test_a_settings_change_after_the_quote_makes_it_stale(staff: TestClient, cli: Cli) -> None:
    body = draft(staff)
    quote = quoted(staff, body)
    cli("settings", "set", "--pickup-location=Stall 4")

    error_of(keyed(staff, "POST", "/orders", creation(body, quote)), 409, "quote_stale")
    assert references(staff) == []


def test_changes_elsewhere_on_the_menu_leave_a_quote_valid(staff: TestClient) -> None:
    body = draft(staff)
    quote = quoted(staff, body)
    lumpia = menu(staff)[("Fresh Lumpia", "Each")]
    keyed(staff, "PATCH", f"/variants/{lumpia['id']}", {"expected_version": 1, "price_minor": 350})

    assert keyed(staff, "POST", "/orders", creation(body, quote)).status_code == 201


def test_expired_quotes_are_cleared_away(
    staff: TestClient, clock: FakeClock, database: Database
) -> None:
    for _ in range(3):
        quoted(staff, draft(staff))
    clock.advance(minutes=5)
    quoted(staff, draft(staff))

    with database.read() as db:
        assert len(db.scalars(select(StoredQuote)).all()) == 1


# --- Agreed prices never change --------------------------------------------------------------


def test_a_saved_order_ignores_later_changes_to_the_menu(staff: TestClient) -> None:
    order = place(staff)
    variants = menu(staff)
    medium = variants[("Beef Caldereta", "Medium")]
    keyed(
        staff,
        "PATCH",
        f"/variants/{medium['id']}",
        {"expected_version": 1, "price_minor": 9900, "label": "Regular", "available": False},
    )
    food = staff.get(f"{API}/foods/{medium['food_id']}").json()
    keyed(
        staff,
        "PATCH",
        f"/foods/{food['id']}",
        {"expected_version": food["version"], "name": "Kaldereta", "available": False},
    )

    assert read(staff, order["id"]) == order
    assert order["items"][0]["food_name"] == "Beef Caldereta"
    assert (order["items"][0]["unit_price_minor"], order["subtotal_minor"]) == (8000, 21500)


def test_an_ordered_variant_keeps_its_selling_unit(staff: TestClient) -> None:
    place(staff)
    medium = menu(staff)[("Beef Caldereta", "Medium")]
    small = menu(staff)[("Beef Caldereta", "Small")]
    as_package = {
        "expected_version": 1,
        "selling_unit": "package",
        "package_contents": {"quantity": 6, "unit": "piece"},
    }

    assert field_paths(keyed(staff, "PATCH", f"/variants/{medium['id']}", as_package)) == {
        "/selling_unit"
    }
    # A variant nobody has ordered is still free to change.
    assert keyed(staff, "PATCH", f"/variants/{small['id']}", as_package).status_code == 200


# --- Editing ---------------------------------------------------------------------------------


def test_an_edit_keeps_agreed_lines_and_prices_new_ones_from_the_menu(
    staff: TestClient, clock: FakeClock
) -> None:
    order = place(staff)
    variants = menu(staff)
    medium, lumpia = variants[("Beef Caldereta", "Medium")], variants[("Fresh Lumpia", "Each")]
    keyed(staff, "PATCH", f"/variants/{medium['id']}", {"expected_version": 1, "price_minor": 9900})
    keyed(staff, "PATCH", f"/variants/{lumpia['id']}", {"expected_version": 1, "price_minor": 350})
    clock.advance(minutes=3)
    body = as_saved(order)
    body["items"][0].update(quantity=3, preparation_notes="Less spicy")
    del body["items"][1]
    body["items"].append(
        {
            "client_line_id": "new",
            "variant_id": lumpia["id"],
            "quantity": 10,
            "preparation_notes": "",
        }
    )
    body["notes"] = "Call on arrival"

    quote = quoted(staff, body, order)
    response = revise(staff, order, body)

    assert (quote["order_id"], quote["expected_version"]) == (order["id"], 1)
    assert [line["order_item_id"] for line in quote["lines"]] == [order["items"][0]["id"], None]
    assert response.status_code == 200
    edited = response.json()
    kept, added = edited["items"]
    # The agreed tray keeps its identity and its price, whatever the menu says now.
    assert (kept["id"], kept["unit_price_minor"], kept["quantity"], kept["line_total_minor"]) == (
        order["items"][0]["id"],
        8000,
        3,
        24000,
    )
    assert kept["preparation_notes"] == "Less spicy"
    assert (added["food_name"], added["unit_price_minor"], added["line_total_minor"]) == (
        "Fresh Lumpia",
        350,
        3500,
    )
    assert added["id"] not in {item["id"] for item in order["items"]}
    assert (edited["subtotal_minor"], edited["total_minor"], edited["balance_due_minor"]) == (
        27500,
        27500,
        27500,
    )
    assert (edited["version"], edited["status"], edited["reference"]) == (
        2,
        "confirmed",
        "DEV-0001",
    )
    assert edited["status_history"] == order["status_history"]
    assert (edited["created_at"], edited["updated_at"]) == (
        order["created_at"],
        "2026-10-10T19:03:00Z",
    )
    assert edited["notes"] == "Call on arrival"
    assert read(staff, order["id"]) == edited


def test_an_edit_can_move_the_order_to_another_time_and_method(staff: TestClient) -> None:
    order = place(staff)
    body = as_saved(order)
    body.update(
        fulfillment={**DELIVERY, "local_date": "2026-12-24", "local_time": "18:30"},
        delivery_charge_minor=1200,
    )

    edited = revise(staff, order, body).json()

    assert edited["fulfillment"] == {
        **DELIVERY,
        "local_date": "2026-12-24",
        "local_time": "18:30",
        "utc_offset": "-08:00",
        "fulfillment_at": "2026-12-25T02:30:00Z",
        "pickup_location": None,
    }
    assert (edited["delivery_charge_minor"], edited["total_minor"]) == (1200, 22700)


def test_a_withdrawn_variant_may_stay_or_shrink_on_an_order_but_not_grow(
    staff: TestClient,
) -> None:
    order = place(staff)
    medium = menu(staff)[("Beef Caldereta", "Medium")]
    keyed(staff, "PATCH", f"/variants/{medium['id']}", {"expected_version": 1, "available": False})
    body = as_saved(order)

    body["items"][0]["quantity"] = 3
    assert field_paths(ask(staff, body, order)) == {"/draft/items/0/variant_id"}
    body["items"][0]["quantity"] = 1
    body["items"][0]["preparation_notes"] = "Half portion of rice"

    edited = revise(staff, order, body)

    assert edited.status_code == 200
    assert edited.json()["items"][0]["quantity"] == 1
    another = as_saved(edited.json())
    another["items"].append(
        {
            "client_line_id": "new",
            "variant_id": medium["id"],
            "quantity": 1,
            "preparation_notes": "",
        }
    )
    assert field_paths(ask(staff, another, edited.json())) == {"/draft/items/2/variant_id"}


def test_a_saved_line_cannot_be_swapped_repeated_or_borrowed(staff: TestClient) -> None:
    order = place(staff)
    other = place(staff)
    small = menu(staff)[("Beef Caldereta", "Small")]

    swapped = as_saved(order)
    swapped["items"][0]["variant_id"] = small["id"]
    repeated = as_saved(order)
    repeated["items"][1]["order_item_id"] = order["items"][0]["id"]
    repeated["items"][1]["variant_id"] = order["items"][0]["variant_id"]
    borrowed = as_saved(order)
    borrowed["items"][0]["order_item_id"] = other["items"][0]["id"]

    assert field_paths(ask(staff, swapped, order)) == {"/draft/items/0/variant_id"}
    assert field_paths(ask(staff, repeated, order)) == {"/draft/items/1/variant_id"}
    assert field_paths(ask(staff, borrowed, order)) == {"/draft/items/0/variant_id"}


def test_two_staff_editing_the_same_order_cannot_overwrite_each_other(
    staff: TestClient,
) -> None:
    order = place(staff)
    mine, theirs = as_saved(order), as_saved(order)
    mine["notes"] = "Mine"
    theirs["notes"] = "Theirs"
    my_quote, their_quote = quoted(staff, mine, order), quoted(staff, theirs, order)

    def put(body: dict[str, Any], quote: dict[str, Any], version: int) -> Any:
        return keyed(
            staff,
            "PUT",
            f"/orders/{order['id']}",
            {
                "expected_version": version,
                "quote_id": quote["id"],
                "draft": body,
                "acknowledge_credit": False,
            },
        )

    saved = put(theirs, their_quote, 1)
    late = put(mine, my_quote, 1)

    assert saved.status_code == 200
    conflict = error_of(late, 409, "version_conflict")
    assert conflict["details"] == {
        "resource_type": "order",
        "resource_id": order["id"],
        "expected_version": 1,
        "current_version": 2,
        "latest_resource": saved.json(),
    }
    assert read(staff, order["id"])["notes"] == "Theirs"
    # Claiming the new version does not rescue a quote that was made against the old one.
    error_of(put(mine, my_quote, 2), 409, "quote_stale")
    assert revise(staff, saved.json(), mine).json()["notes"] == "Mine"


def test_a_quote_for_an_edit_states_the_order_and_version_together(staff: TestClient) -> None:
    order = place(staff)
    body = as_saved(order)

    only_id = staff.post(f"{API}/orders/quote", json={"order_id": order["id"], "draft": body})
    only_version = staff.post(f"{API}/orders/quote", json={"expected_version": 1, "draft": body})
    unknown = staff.post(
        f"{API}/orders/quote",
        json={"order_id": "ord_nowhere", "expected_version": 1, "draft": body},
    )
    stale = staff.post(
        f"{API}/orders/quote", json={"order_id": order["id"], "expected_version": 2, "draft": body}
    )

    assert field_paths(only_id) == {"/expected_version"}
    assert field_paths(only_version) == {"/order_id"}
    error_of(unknown, 404, "not_found")
    assert error_of(stale, 409, "version_conflict")["details"]["latest_resource"] == order


def test_a_quote_belongs_to_the_order_it_was_made_for(staff: TestClient) -> None:
    order = place(staff)
    body = draft(staff)
    new_order_quote = quoted(staff, body)
    edit_quote = quoted(staff, as_saved(order), order)

    as_edit = keyed(
        staff,
        "PUT",
        f"/orders/{order['id']}",
        {
            "expected_version": 1,
            "quote_id": new_order_quote["id"],
            "draft": body,
            "acknowledge_credit": False,
        },
    )
    as_new = keyed(staff, "POST", "/orders", creation(as_saved(order), edit_quote))

    error_of(as_edit, 409, "quote_stale")
    assert as_new.status_code in {409, 422}
    assert references(staff) == ["DEV-0001"]


def test_only_pending_and_confirmed_orders_can_be_edited(
    staff: TestClient, database: Database
) -> None:
    order = place(staff)
    body = as_saved(order)
    quote = quoted(staff, body, order)
    set_status(database, order, "preparing")

    refused_quote = ask(staff, body, order)
    refused_save = keyed(
        staff,
        "PUT",
        f"/orders/{order['id']}",
        {
            "expected_version": 1,
            "quote_id": quote["id"],
            "draft": body,
            "acknowledge_credit": False,
        },
    )

    for response in (refused_quote, refused_save):
        assert error_of(response, 403, "action_forbidden")["message"].strip()
    current = read(staff, order["id"])
    assert (current["version"], current["permitted_actions"]["edit"]["allowed"]) == (1, False)


def test_an_edit_of_an_unknown_order_is_not_found(staff: TestClient) -> None:
    body = draft(staff)
    request = {
        "expected_version": 1,
        "quote_id": quoted(staff, body)["id"],
        "draft": body,
        "acknowledge_credit": False,
    }

    error_of(keyed(staff, "PUT", "/orders/ord_nowhere", request), 404, "not_found")
    error_of(staff.get(f"{API}/orders/ord_nowhere"), 404, "not_found")


@pytest.mark.parametrize(
    ("changes", "path"),
    [
        ({"expected_version": ...}, "/expected_version"),
        ({"expected_version": 0}, "/expected_version"),
        ({"initial_status": "confirmed"}, "/initial_status"),
        ({"acknowledge_credit": ...}, "/acknowledge_credit"),
    ],
)
def test_a_malformed_edit_is_refused_at_the_field(
    staff: TestClient, changes: dict[str, Any], path: str
) -> None:
    order = place(staff)
    body = as_saved(order)
    request: dict[str, Any] = {
        "expected_version": 1,
        "quote_id": quoted(staff, body, order)["id"],
        "draft": body,
        "acknowledge_credit": False,
    }
    for name, value in changes.items():
        request = change(request, f"/{name}", value)

    assert field_paths(keyed(staff, "PUT", f"/orders/{order['id']}", request)) == {path}
    assert read(staff, order["id"]) == order


# --- Confirming a pending order --------------------------------------------------------------


def confirm(client: TestClient, order: dict[str, Any], **changes: Any) -> Any:
    body = {"expected_version": order["version"], "to_status": "confirmed", **changes}
    return keyed(client, "POST", f"/orders/{order['id']}/transitions", body)


def test_a_pending_order_is_confirmed_as_a_dated_step(
    staff: TestClient, admin: StaffUser, clock: FakeClock
) -> None:
    order = place(staff, status="pending")
    clock.advance(minutes=20)

    response = confirm(staff, order)

    assert response.status_code == 200
    confirmed = response.json()
    assert (confirmed["status"], confirmed["version"]) == ("confirmed", 2)
    assert confirmed["status_history"][:1] == order["status_history"]
    event = confirmed["status_history"][1]
    assert {key: value for key, value in event.items() if key != "id"} == {
        "from_status": "pending",
        "to_status": "confirmed",
        "changed_at": "2026-10-10T19:20:00Z",
        "actor": {"id": admin.id, "display_name": "Admin"},
        "reason": None,
    }
    assert confirmed["permitted_actions"]["confirm"]["allowed"] is False
    assert confirmed["updated_at"] == "2026-10-10T19:20:00Z"
    # Confirming touches nothing else.
    untouched = {"version", "status", "status_history", "permitted_actions", "updated_at"}
    assert {key: value for key, value in confirmed.items() if key not in untouched} == {
        key: value for key, value in order.items() if key not in untouched
    }
    assert read(staff, order["id"]) == confirmed


def test_confirming_is_refused_when_stale_repeated_or_not_the_next_step(
    staff: TestClient,
) -> None:
    order = place(staff, status="pending")

    stale = error_of(confirm(staff, order, expected_version=2), 409, "version_conflict")
    assert stale["details"]["latest_resource"] == order
    for status in ["preparing", "ready", "completed", "pending"]:
        refused = error_of(confirm(staff, order, to_status=status), 409, "action_not_allowed")
        assert refused["message"].strip()
    assert field_paths(confirm(staff, order, to_status="shipped")) == {"/to_status"}
    assert field_paths(confirm(staff, order, reason="Because")) == {"/reason"}
    assert read(staff, order["id"]) == order

    confirmed = confirm(staff, order).json()
    error_of(confirm(staff, confirmed), 409, "action_not_allowed")
    error_of(confirm(staff, {"id": "ord_nowhere", "version": 1}), 404, "not_found")
    assert read(staff, order["id"])["version"] == 2


def test_confirming_needs_an_operation_key_and_happens_once(staff: TestClient) -> None:
    order = place(staff, status="pending")
    body = {"expected_version": 1, "to_status": "confirmed"}
    path = f"/orders/{order['id']}/transitions"
    assert field_paths(staff.post(f"{API}{path}", json=body)) == {"/header/Idempotency-Key"}
    key = str(uuid.uuid4())

    first = keyed(staff, "POST", path, body, key)
    again = keyed(staff, "POST", path, body, key)

    assert (first.status_code, again.content) == (200, first.content)
    assert again.headers["Idempotency-Replayed"] == "true"
    assert len(read(staff, order["id"])["status_history"]) == 2


# --- Finding orders --------------------------------------------------------------------------


def at(client: TestClient, date: str, time: str, name: str = "Sample Customer") -> dict[str, Any]:
    body = draft(client, [("Fresh Lumpia", "Each", 1)])
    body["fulfillment"] = {**PICKUP, "local_date": date, "local_time": time}
    body["customer"] = {"name": name, "phone": "555-0100", "notes": ""}
    return place(client, body)


def test_a_summary_carries_what_a_list_row_needs(staff: TestClient) -> None:
    order = place(staff)

    body = staff.get(f"{API}/orders").json()

    assert body["items"] == [
        {
            "id": order["id"],
            "reference": "DEV-0001",
            "version": 1,
            "customer_name": "Sample Customer",
            "customer_phone": "555-0100",
            "fulfillment_at": "2026-10-12T19:00:00Z",
            "fulfillment_local_date": "2026-10-12",
            "fulfillment_local_time": "12:00",
            "fulfillment_timezone": "America/Los_Angeles",
            "fulfillment_method": "pickup",
            "status": "confirmed",
            "payment_status": "unpaid",
            "currency": "USD",
            "minor_digits": 2,
            "total_minor": 21500,
            "balance_due_minor": 21500,
            "customer_credit_minor": 0,
        }
    ]
    assert (body["page"], body["limit"], body["total"], body["has_next"]) == (1, 25, 1, False)


def test_orders_are_listed_by_fulfillment_time_either_way(staff: TestClient) -> None:
    at(staff, "2026-10-14", "09:00")
    at(staff, "2026-10-12", "17:00")
    at(staff, "2026-10-12", "08:00")
    at(staff, "2026-10-13", "12:00")

    ascending = ["DEV-0003", "DEV-0002", "DEV-0004", "DEV-0001"]
    assert references(staff) == ascending
    assert references(staff, "?sort=fulfillment_asc") == ascending
    assert references(staff, "?sort=fulfillment_desc") == ascending[::-1]


def test_orders_at_the_same_moment_keep_one_order_across_pages(staff: TestClient) -> None:
    for _ in range(5):
        at(staff, "2026-10-12", "12:00")

    for sort in ["fulfillment_asc", "fulfillment_desc"]:
        whole = references(staff, f"?sort={sort}")
        paged = [
            reference
            for page in (1, 2, 3)
            for reference in references(staff, f"?sort={sort}&limit=2&page={page}")
        ]
        assert paged == whole
        assert len(set(paged)) == 5
    last = staff.get(f"{API}/orders?limit=2&page=3").json()
    assert (last["total"], last["has_next"], len(last["items"])) == (5, False, 1)


def test_orders_are_found_by_customer_phone_or_reference(staff: TestClient) -> None:
    at(staff, "2026-10-12", "09:00", "Maria Clara")
    body = draft(staff, [("Fresh Lumpia", "Each", 1)])
    body["customer"] = {"name": "Crisostomo Ibarra", "phone": "0917 555 0142", "notes": ""}
    place(staff, body)

    assert references(staff, "?q=maria") == ["DEV-0001"]
    assert references(staff, "?q=%20IBARRA%20") == ["DEV-0002"]
    assert references(staff, "?q=555%200142") == ["DEV-0002"]
    assert references(staff, "?q=dev-0002") == ["DEV-0002"]
    assert references(staff, "?q=a") == ["DEV-0001", "DEV-0002"]
    assert references(staff, "?q=%25") == []
    assert references(staff, "?q=sisa") == []


def test_date_filters_are_inclusive_days_of_the_business_calendar(staff: TestClient) -> None:
    at(staff, "2026-10-11", "23:30")
    at(staff, "2026-10-12", "00:15")
    at(staff, "2026-10-12", "23:45")
    at(staff, "2026-10-13", "06:00")

    # 23:30 and 23:45 local are already the next day in UTC; they still belong to their own day.
    assert references(staff, "?date_from=2026-10-12&date_to=2026-10-12") == ["DEV-0002", "DEV-0003"]
    assert references(staff, "?date_from=2026-10-12") == ["DEV-0002", "DEV-0003", "DEV-0004"]
    assert references(staff, "?date_to=2026-10-11") == ["DEV-0001"]
    assert references(staff, "?date_from=2026-10-14") == []


def test_orders_are_filtered_by_one_or_more_statuses(staff: TestClient, database: Database) -> None:
    pending = place(staff, status="pending")
    place(staff)
    cancelled = place(staff)
    set_status(database, cancelled, "cancelled")

    assert references(staff, "?status=pending") == [pending["reference"]]
    # All three are due at the same moment, so only the ID orders them.
    assert sorted(references(staff, "?status=pending,confirmed")) == ["DEV-0001", "DEV-0002"]
    assert references(staff, "?status=cancelled") == ["DEV-0003"]
    assert references(staff, "?status=completed") == []
    assert references(staff, "?status=confirmed&q=sample&date_from=2026-10-12") == ["DEV-0002"]


@pytest.mark.parametrize(
    ("query", "path"),
    [
        ("?status=shipped", "/query/status"),
        ("?status=pending,shipped", "/query/status"),
        ("?status=", "/query/status"),
        ("?sort=newest", "/query/sort"),
        ("?date_from=2026-02-30", "/query/date_from"),
        ("?date_to=12/10/2026", "/query/date_to"),
        ("?date_from=2026-10-13&date_to=2026-10-12", "/query/date_to"),
        (f"?q={'x' * 201}", "/query/q"),
        ("?customer=maria", "/query/customer"),
        ("?page=0", "/query/page"),
        ("?limit=101", "/query/limit"),
    ],
)
def test_an_unknown_or_invalid_order_filter_is_refused(
    staff: TestClient, query: str, path: str
) -> None:
    assert field_paths(staff.get(f"{API}/orders{query}")) == {path}


# --- Dashboard -------------------------------------------------------------------------------


def dashboard(client: TestClient, query: str = "") -> dict[str, Any]:
    response = client.get(f"{API}/dashboard{query}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def listed(collection: dict[str, Any]) -> list[str]:
    return [item["reference"] for item in collection["items"]]


def test_the_dashboard_defaults_to_today_in_the_business_timezone(
    staff: TestClient, clock: FakeClock
) -> None:
    assert dashboard(staff)["business_date"] == "2026-10-10"
    assert dashboard(staff)["timezone"] == "America/Los_Angeles"
    # 23:59 in Los Angeles is already tomorrow in UTC.
    clock.advance(hours=11, minutes=59)
    staff.headers["X-CSRF-Token"] = sign_in(staff).json()["csrf_token"]
    assert dashboard(staff)["business_date"] == "2026-10-10"
    clock.advance(minutes=1)
    assert dashboard(staff)["business_date"] == "2026-10-11"


def test_the_dashboard_groups_today_and_what_comes_after(
    staff: TestClient, database: Database
) -> None:
    at(staff, "2026-10-09", "12:00")
    late_today = at(staff, "2026-10-10", "23:30")
    done_today = at(staff, "2026-10-10", "08:00")
    cancelled_today = at(staff, "2026-10-10", "10:00")
    tomorrow = at(staff, "2026-10-11", "00:15")
    at(staff, "2026-10-20", "12:00")
    done_later = at(staff, "2026-10-15", "12:00")
    cancelled_later = at(staff, "2026-10-16", "12:00")
    set_status(database, done_today, "completed")
    set_status(database, cancelled_today, "cancelled")
    set_status(database, done_later, "completed")
    set_status(database, cancelled_later, "cancelled")

    board = dashboard(staff)

    assert set(board) == {"business_date", "timezone", "today", "upcoming"}
    # Today keeps finished orders for the day's review and drops cancelled ones.
    assert listed(board["today"]) == [done_today["reference"], late_today["reference"]]
    assert listed(board["upcoming"]) == [tomorrow["reference"], "DEV-0006"]
    for collection in (board["today"], board["upcoming"]):
        assert (collection["page"], collection["limit"], collection["has_next"]) == (1, 25, False)
        assert collection["total"] == 2
    assert board["today"]["items"][0]["status"] == "completed"


def test_the_dashboard_can_be_asked_for_another_day(staff: TestClient) -> None:
    at(staff, "2026-10-10", "12:00")
    at(staff, "2026-10-12", "12:00")
    at(staff, "2026-10-13", "12:00")

    board = dashboard(staff, "?date=2026-10-12")

    assert board["business_date"] == "2026-10-12"
    assert (listed(board["today"]), listed(board["upcoming"])) == (["DEV-0002"], ["DEV-0003"])


def test_the_dashboard_shows_the_first_twenty_five_and_counts_the_rest(staff: TestClient) -> None:
    for _ in range(26):
        at(staff, "2026-10-10", "12:00")

    today = dashboard(staff)["today"]

    assert (len(today["items"]), today["total"], today["has_next"]) == (25, 26, True)
    assert len({item["id"] for item in today["items"]}) == 25


@pytest.mark.parametrize(
    ("query", "path"),
    [
        ("?date=2026-02-30", "/query/date"),
        ("?date=today", "/query/date"),
        ("?page=2", "/query/page"),
        ("?status=pending", "/query/status"),
    ],
)
def test_the_dashboard_refuses_anything_but_a_real_date(
    staff: TestClient, query: str, path: str
) -> None:
    assert field_paths(staff.get(f"{API}/dashboard{query}")) == {path}
