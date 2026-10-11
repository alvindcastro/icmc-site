from typing import Any

from fastapi.testclient import TestClient

from app.persistence.models import StaffUser
from tests.inventory_support import buy, line, new_ingredient, receipt
from tests.order_support import draft, menu, moved_to, place
from tests.support import API, Cli, keyed, sign_in

# Everything the kitchen needs short of recording what was cooked.
KITCHEN_SETTINGS = [
    "settings",
    "set",
    "--currency=USD",
    "--minor-digits=2",
    "--timezone=America/Los_Angeles",
    "--fulfillment=pickup,delivery",
    "--delivery-mode=manual_amount",
    "--enable=menu",
    "--enable=orders",
    "--enable=inventory",
    "--enable=purchases",
    "--enable=recipes",
    "--enable=planning",
]
RECORDING = "--enable=preparation_recording"
ALLOWED = {"allowed": True, "reason_code": None, "reason": None}
TODAY = "2026-10-10"
FIVE_TRAYS = [("Beef Caldereta", "Medium", 5)]


def open_kitchen(client: TestClient, admin: StaffUser, cli: Cli, *, recording: bool) -> TestClient:
    """Sign in to a business with the seeded menu and the kitchen workflows enabled."""
    assert cli(*KITCHEN_SETTINGS, *([RECORDING] if recording else [])) == 0
    assert cli("menu", "seed") == 0
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
    return client


def variant(
    client: TestClient, food: str = "Beef Caldereta", label: str = "Medium"
) -> dict[str, Any]:
    return menu(client)[(food, label)]


def order_on(
    client: TestClient,
    day: str = "2026-10-12",
    lines: list[tuple[str, str, int]] | None = None,
    status: str = "confirmed",
) -> dict[str, Any]:
    """An order fulfilled on `day`, taken through the ordinary steps to `status`."""
    body = draft(client, lines or FIVE_TRAYS)
    body["fulfillment"]["local_date"] = day
    order = place(client, body, "pending" if status == "pending" else "confirmed")
    return order if status in ("pending", "confirmed") else moved_to(client, order, status)


def write_recipe(
    client: TestClient, item: dict[str, Any], *rows: tuple[dict[str, Any], str, str]
) -> dict[str, Any]:
    """Save the first recipe of a variant; each row is an ingredient, a quantity and a unit."""
    body = {
        "expected_version": None,
        "yield": {
            "quantity": 1,
            "selling_unit": item["selling_unit"],
            "package_contents": item["package_contents"],
        },
        "items": [
            {"ingredient_id": ingredient["id"], "quantity": quantity, "unit": unit}
            for ingredient, quantity, unit in rows
        ],
    }
    response = client.put(f"{API}/variants/{item['id']}/recipe", json=body)
    assert response.status_code == 201, response.text
    recipe: dict[str, Any] = response.json()
    return recipe


def bought(
    client: TestClient,
    name: str = "Flour",
    cost: int = 2400,
    quantity: str = "2",
    unit: str = "kg",
    base: str = "g",
    on: str = "2026-10-07",
) -> dict[str, Any]:
    """A new ingredient with one receipt line; returns the ingredient with its purchase."""
    ingredient = new_ingredient(client, name, base)
    result = buy(client, receipt(line(ingredient, quantity, unit, cost), on=on))
    return {**result["ingredients"][0], "purchase": result["purchase"]}


def plan(client: TestClient, query: str = "") -> dict[str, Any]:
    response = client.get(f"{API}/planning{query}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def shopping(client: TestClient, query: str = "") -> dict[str, Any]:
    response = client.get(f"{API}/planning/shopping-list{query}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


# --- Recording what was cooked ---------------------------------------------------------------


def allocation(order: dict[str, Any], quantity: Any, index: int = 0) -> dict[str, Any]:
    return {
        "order_id": order["id"],
        "expected_version": order["version"],
        "order_item_id": order["items"][index]["id"],
        "quantity": quantity,
    }


def usage(ingredient: dict[str, Any], quantity: Any, unit: str = "g") -> dict[str, Any]:
    return {
        "ingredient_id": ingredient["id"],
        "expected_version": ingredient["version"],
        "quantity": quantity,
        "unit": unit,
    }


def cooking(
    allocations: list[dict[str, Any]],
    consumption: list[dict[str, Any]],
    note: str = "",
    on: str = TODAY,
) -> dict[str, Any]:
    return {
        "prepared_on": on,
        "allocations": allocations,
        "consumption": consumption,
        "note": note,
    }


def preview_preparation(client: TestClient, body: dict[str, Any]) -> Any:
    return client.post(f"{API}/preparations/preview", json={"draft": body})


def save_preparation(
    client: TestClient, body: dict[str, Any], preview: dict[str, Any], key: str | None = None
) -> Any:
    return keyed(client, "POST", "/preparations", {"preview_id": preview["id"], "draft": body}, key)


def prepare(client: TestClient, body: dict[str, Any]) -> dict[str, Any]:
    """Preview and save a preparation that must succeed; returns `{preparation, orders,
    ingredients}`."""
    preview = preview_preparation(client, body)
    assert preview.status_code == 200, preview.text
    saved = save_preparation(client, body, preview.json())
    assert saved.status_code == 201, saved.text
    result: dict[str, Any] = saved.json()
    return result


def read_preparation(client: TestClient, preparation_id: str) -> dict[str, Any]:
    response = client.get(f"{API}/preparations/{preparation_id}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


# --- Corrections -----------------------------------------------------------------------------


def count_change(order: dict[str, Any], delta: Any, index: int = 0) -> dict[str, Any]:
    return {
        "order_id": order["id"],
        "expected_version": order["version"],
        "order_item_id": order["items"][index]["id"],
        "delta_quantity": delta,
    }


def stock_change(ingredient: dict[str, Any], delta: Any, movement_id: Any) -> dict[str, Any]:
    return {
        "ingredient_id": ingredient["id"],
        "expected_version": ingredient["version"],
        "delta_base_quantity": delta,
        "corrects_movement_id": movement_id,
    }


def amendment(
    allocations: list[dict[str, Any]] | None = None,
    stock: list[dict[str, Any]] | None = None,
    reason: str = "Counted one tray too many",
) -> dict[str, Any]:
    return {
        "reason": reason,
        "allocations": allocations or [],
        "stock_corrections": stock or [],
    }


def preview_correction(client: TestClient, preparation_id: str, body: dict[str, Any]) -> Any:
    return client.post(f"{API}/preparations/{preparation_id}/correction-preview", json=body)


def save_correction(
    client: TestClient,
    preparation_id: str,
    body: dict[str, Any],
    preview: dict[str, Any],
    key: str | None = None,
) -> Any:
    request = {**body, "preview_id": preview["id"]}
    return keyed(client, "POST", f"/preparations/{preparation_id}/corrections", request, key)


def correct(client: TestClient, preparation_id: str, body: dict[str, Any]) -> dict[str, Any]:
    """Preview and save a correction that must succeed; returns `{correction, orders,
    ingredients}`."""
    preview = preview_correction(client, preparation_id, body)
    assert preview.status_code == 200, preview.text
    saved = save_correction(client, preparation_id, body, preview.json())
    assert saved.status_code == 201, saved.text
    result: dict[str, Any] = saved.json()
    return result


def corrections(client: TestClient, preparation_id: str) -> list[dict[str, Any]]:
    response = client.get(f"{API}/preparations/{preparation_id}/corrections")
    assert response.status_code == 200, response.text
    items: list[dict[str, Any]] = response.json()["items"]
    return items
