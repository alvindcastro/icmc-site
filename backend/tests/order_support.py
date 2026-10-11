import copy
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import update

from app.persistence.database import Database
from app.persistence.models import Order
from tests.support import API, keyed

SETTINGS = [
    "settings",
    "set",
    "--currency=USD",
    "--minor-digits=2",
    "--timezone=America/Los_Angeles",
    "--fulfillment=pickup,delivery",
    "--delivery-mode=manual_amount",
    "--enable=menu",
    "--enable=orders",
]
ALLOWED = {"allowed": True, "reason_code": None, "reason": None}
ACTIONS = {
    "edit",
    "confirm",
    "start_preparing",
    "mark_ready",
    "complete",
    "cancel",
    "record_payment",
    "refund",
    "record_preparation",
}
PICKUP = {
    "method": "pickup",
    "local_date": "2026-10-12",
    "local_time": "12:00",
    "timezone": "America/Los_Angeles",
    "utc_offset": None,
    "address": None,
}
DELIVERY = {**PICKUP, "method": "delivery", "address": "12 Mabini Street"}
TWO_TRAYS_AND_A_PACKAGE = [
    ("Beef Caldereta", "Medium", 2),
    ("Shanghai Spring Rolls", "100 pieces", 1),
]


def menu(client: TestClient) -> dict[tuple[str, str], dict[str, Any]]:
    foods = client.get(f"{API}/foods?limit=100").json()["items"]
    return {
        (food["name"], variant["label"]): variant for food in foods for variant in food["variants"]
    }


def draft(client: TestClient, lines: list[tuple[str, str, int]] | None = None) -> dict[str, Any]:
    variants = menu(client)
    return {
        "customer": {"name": "Sample Customer", "phone": "555-0100", "notes": ""},
        "fulfillment": dict(PICKUP),
        "items": [
            {
                "client_line_id": f"line_{index}",
                "variant_id": variants[(food, label)]["id"],
                "quantity": quantity,
                "preparation_notes": "",
            }
            for index, (food, label, quantity) in enumerate(lines or TWO_TRAYS_AND_A_PACKAGE)
        ],
        "notes": "",
        "delivery_charge_minor": 0,
        "tax_minor": 0,
    }


def ask(client: TestClient, body: dict[str, Any], order: dict[str, Any] | None = None) -> Any:
    editing = {"order_id": order["id"], "expected_version": order["version"]} if order else {}
    return client.post(f"{API}/orders/quote", json={**editing, "draft": body})


def quoted(client: TestClient, body: dict[str, Any], order: dict[str, Any] | None = None) -> Any:
    response = ask(client, body, order)
    assert response.status_code == 200, response.text
    return response.json()


def creation(
    body: dict[str, Any], quote: dict[str, Any], status: str = "confirmed"
) -> dict[str, Any]:
    return {
        "quote_id": quote["id"],
        "draft": body,
        "initial_status": status,
        "acknowledge_credit": False,
    }


def place(
    client: TestClient, body: dict[str, Any] | None = None, status: str = "confirmed"
) -> dict[str, Any]:
    body = body or draft(client)
    response = keyed(client, "POST", "/orders", creation(body, quoted(client, body), status))
    assert response.status_code == 201, response.text
    order: dict[str, Any] = response.json()
    return order


def revise(client: TestClient, order: dict[str, Any], body: dict[str, Any]) -> Any:
    quote = quoted(client, body, order)
    return keyed(
        client,
        "PUT",
        f"/orders/{order['id']}",
        {
            "expected_version": order["version"],
            "quote_id": quote["id"],
            "draft": body,
            "acknowledge_credit": False,
        },
    )


def as_saved(order: dict[str, Any]) -> dict[str, Any]:
    """A draft that repeats a saved order line for line, as the editor sends it."""
    return {
        "customer": dict(order["customer"]),
        "fulfillment": {
            key: order["fulfillment"][key]
            for key in ("method", "local_date", "local_time", "timezone", "utc_offset", "address")
        },
        "items": [
            {
                "client_line_id": f"saved_{index}",
                "order_item_id": item["id"],
                "variant_id": item["variant_id"],
                "quantity": item["quantity"],
                "preparation_notes": item["preparation_notes"],
            }
            for index, item in enumerate(order["items"])
        ],
        "notes": order["notes"],
        "delivery_charge_minor": order["delivery_charge_minor"],
        "tax_minor": order["tax_minor"],
    }


def read(client: TestClient, order_id: str) -> dict[str, Any]:
    response = client.get(f"{API}/orders/{order_id}")
    assert response.status_code == 200, response.text
    order: dict[str, Any] = response.json()
    return order


def references(client: TestClient, query: str = "") -> list[str]:
    response = client.get(f"{API}/orders{query}")
    assert response.status_code == 200, response.text
    return [item["reference"] for item in response.json()["items"]]


def set_status(database: Database, order: dict[str, Any], status: str) -> None:
    """Later statuses arrive with the next backend phase; tests that need one write it."""
    with database.write() as db:
        db.execute(update(Order).where(Order.id == order["id"]).values(status=status))


def change(body: dict[str, Any], path: str, value: Any) -> dict[str, Any]:
    """A copy of a draft with one nested value replaced, or removed when value is `...`."""
    changed = copy.deepcopy(body)
    target: Any = changed
    *parents, last = path.strip("/").split("/")
    for part in parents:
        target = target[int(part)] if isinstance(target, list) else target[part]
    if value is ...:
        del target[last]
    else:
        target[last] = value
    return changed


# --- Fulfillment steps and the ledger --------------------------------------------------------

PAYING_SETTINGS = [*SETTINGS, "--payment-methods=cash,bank_transfer,other", "--enable=payments"]
STEPS = ["pending", "confirmed", "preparing", "ready", "completed"]


def _with(body: dict[str, Any], changes: dict[str, Any]) -> dict[str, Any]:
    """Apply keyword changes to a request body; a value of `...` removes the field."""
    for name, value in changes.items():
        if value is ...:
            body.pop(name, None)
        else:
            body[name] = value
    return body


def step(client: TestClient, order: dict[str, Any], to_status: str, **changes: Any) -> Any:
    body = _with({"expected_version": order["version"], "to_status": to_status}, changes)
    return keyed(client, "POST", f"/orders/{order['id']}/transitions", body)


def cancel(
    client: TestClient, order: dict[str, Any], key: str | None = None, **changes: Any
) -> Any:
    body = {
        "expected_version": order["version"],
        "reason": "Customer called it off",
        "acknowledge_consumed_stock": False,
    }
    return keyed(client, "POST", f"/orders/{order['id']}/cancel", _with(body, changes), key)


def moved_to(client: TestClient, order: dict[str, Any], status: str) -> dict[str, Any]:
    """Take an order through the ordinary steps until it has the wanted status."""
    if status == "cancelled":
        response = cancel(client, order)
        assert response.status_code == 200, response.text
        cancelled: dict[str, Any] = response.json()
        return cancelled
    while order["status"] != status:
        response = step(client, order, STEPS[STEPS.index(order["status"]) + 1])
        assert response.status_code == 200, response.text
        order = response.json()
    return order


def pay(
    client: TestClient, order: dict[str, Any], amount: Any, key: str | None = None, **changes: Any
) -> Any:
    body = {
        "expected_version": order["version"],
        "amount_minor": amount,
        "paid_on": "2026-10-10",
        "method": "cash",
    }
    return keyed(client, "POST", f"/orders/{order['id']}/payments", _with(body, changes), key)


def paid(client: TestClient, order: dict[str, Any], amount: int, **changes: Any) -> dict[str, Any]:
    """Record a payment that must succeed, and return the order as it then stands."""
    response = pay(client, order, amount, **changes)
    assert response.status_code == 201, response.text
    after: dict[str, Any] = response.json()["order"]
    return after


def refund(
    client: TestClient,
    order: dict[str, Any],
    payment_id: Any,
    amount: Any,
    key: str | None = None,
    **changes: Any,
) -> Any:
    body = {
        "expected_version": order["version"],
        "payment_id": payment_id,
        "amount_minor": amount,
        "refunded_on": "2026-10-10",
        "method": "cash",
        "reason": "Customer was owed this back",
    }
    if payment_id is ...:
        del body["payment_id"]
    return keyed(client, "POST", f"/orders/{order['id']}/refunds", _with(body, changes), key)


def money(order: dict[str, Any]) -> tuple[int, int, int, int, int, int, int, str]:
    """The columns of the worked financial cases, in their order."""
    return (
        order["total_minor"],
        order["settlement_total_minor"],
        order["payments_minor"],
        order["refunds_minor"],
        order["net_paid_minor"],
        order["balance_due_minor"],
        order["customer_credit_minor"],
        order["payment_status"],
    )
