from typing import Any

from fastapi.testclient import TestClient

from tests.support import API, keyed

STOCK_SETTINGS = [
    "settings",
    "set",
    "--currency=USD",
    "--minor-digits=2",
    "--timezone=America/Los_Angeles",
    "--fulfillment=pickup",
    "--enable=inventory",
    "--enable=purchases",
]
ALLOWED = {"allowed": True, "reason_code": None, "reason": None}


def new_ingredient(
    client: TestClient, name: str = "Flour", base_unit: str = "g", threshold: Any = None
) -> dict[str, Any]:
    body = {"name": name, "base_unit": base_unit, "low_stock_threshold": threshold}
    response = keyed(client, "POST", "/ingredients", body)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


def read_ingredient(client: TestClient, ingredient_id: str) -> dict[str, Any]:
    response = client.get(f"{API}/ingredients/{ingredient_id}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def movement_input(
    ingredient: dict[str, Any], kind: str, delta: Any, **changes: Any
) -> dict[str, Any]:
    body = {
        "expected_version": ingredient["version"],
        "type": kind,
        "delta_base_quantity": delta,
        "reason": "Counted on the shelf",
        "preparation_id": None,
        "corrects_movement_id": None,
    }
    for name, value in changes.items():
        if value is ...:
            body.pop(name, None)
        else:
            body[name] = value
    return body


def preview_movement(client: TestClient, ingredient: dict[str, Any], body: dict[str, Any]) -> Any:
    return client.post(f"{API}/ingredients/{ingredient['id']}/movement-preview", json=body)


def save_movement(
    client: TestClient,
    ingredient: dict[str, Any],
    body: dict[str, Any],
    preview: dict[str, Any],
    key: str | None = None,
) -> Any:
    request = {**body, "preview_id": preview["id"]}
    return keyed(client, "POST", f"/ingredients/{ingredient['id']}/movements", request, key)


def move(
    client: TestClient, ingredient: dict[str, Any], kind: str, delta: str, **changes: Any
) -> dict[str, Any]:
    """Preview and save a stock movement that must succeed; returns `{movement, ingredient}`."""
    body = movement_input(ingredient, kind, delta, **changes)
    preview = preview_movement(client, ingredient, body)
    assert preview.status_code == 200, preview.text
    saved = save_movement(client, ingredient, body, preview.json())
    assert saved.status_code == 201, saved.text
    result: dict[str, Any] = saved.json()
    return result


def line(
    ingredient: dict[str, Any],
    quantity: str = "2",
    unit: str = "kg",
    cost: Any = 2400,
    pack: tuple[str, str] | None = None,
    line_id: str | None = None,
) -> dict[str, Any]:
    return {
        "client_line_id": line_id or f"line_{ingredient['id']}_{quantity}_{unit}_{cost}",
        "ingredient_id": ingredient["id"],
        "quantity": quantity,
        "unit": unit,
        "pack_contents": {"quantity": pack[0], "unit": pack[1]} if pack else None,
        "total_cost_minor": cost,
    }


def receipt(
    *lines: dict[str, Any], on: str = "2026-10-07", supplier: str = "Market"
) -> dict[str, Any]:
    return {"purchased_on": on, "supplier": supplier, "note": "", "items": list(lines)}


def preview_purchase(client: TestClient, draft: dict[str, Any]) -> Any:
    return client.post(f"{API}/purchases/preview", json={"draft": draft})


def save_purchase(
    client: TestClient, draft: dict[str, Any], preview: dict[str, Any], key: str | None = None
) -> Any:
    return keyed(client, "POST", "/purchases", {"preview_id": preview["id"], "draft": draft}, key)


def buy(client: TestClient, draft: dict[str, Any]) -> dict[str, Any]:
    """Preview and save a receipt that must succeed; returns `{purchase, ingredients}`."""
    preview = preview_purchase(client, draft)
    assert preview.status_code == 200, preview.text
    saved = save_purchase(client, draft, preview.json())
    assert saved.status_code == 201, saved.text
    result: dict[str, Any] = saved.json()
    return result


def movements(client: TestClient, ingredient_id: str, query: str = "") -> list[dict[str, Any]]:
    response = client.get(f"{API}/ingredients/{ingredient_id}/movements{query}")
    assert response.status_code == 200, response.text
    items: list[dict[str, Any]] = response.json()["items"]
    return items
