import copy
import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.persistence.models import StaffUser
from app.values import MAX_SAFE_INTEGER
from tests.inventory_support import (
    STOCK_SETTINGS,
    buy,
    line,
    move,
    movements,
    new_ingredient,
    preview_purchase,
    read_ingredient,
    receipt,
    save_purchase,
)
from tests.support import API, Cli, FakeClock, error_of, field_paths, keyed, sign_in


@pytest.fixture
def staff(client: TestClient, admin: StaffUser, cli: Cli) -> TestClient:
    """Signed-in staff with ingredients and purchases enabled."""
    assert cli(*STOCK_SETTINGS) == 0
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
    return client


def references(client: TestClient, query: str = "") -> list[str]:
    response = client.get(f"{API}/purchases{query}")
    assert response.status_code == 200, response.text
    return [item["reference"] for item in response.json()["items"]]


def changed(draft: dict[str, Any], path: str, value: Any) -> dict[str, Any]:
    """A copy of a draft with one nested value replaced, or removed when value is `...`."""
    copied = copy.deepcopy(draft)
    target: Any = copied
    *parents, last = path.strip("/").split("/")
    for part in parents:
        target = target[int(part)] if isinstance(target, list) else target[part]
    if value is ...:
        del target[last]
    else:
        target[last] = value
    return copied


# --- Access ----------------------------------------------------------------------------------


def test_purchases_need_both_the_inventory_and_purchases_workflows(
    client: TestClient, admin: StaffUser, cli: Cli
) -> None:
    for path in ["/purchases", "/purchases/pur_1"]:
        error_of(client.get(f"{API}{path}"), 401, "unauthenticated")
    cli(*STOCK_SETTINGS[:-1])
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
    flour = new_ingredient(client)
    draft = receipt(line(flour))

    for path in ["/purchases", "/purchases/pur_1"]:
        error_of(client.get(f"{API}{path}"), 403, "action_forbidden")
    error_of(preview_purchase(client, draft), 403, "action_forbidden")
    error_of(save_purchase(client, draft, {"id": "prev_1"}), 403, "action_forbidden")
    # Price history is part of the ingredient record, which this workflow does cover.
    assert client.get(f"{API}/ingredients/{flour['id']}/prices").json()["items"] == []

    cli("settings", "set", "--enable=purchases")
    assert references(client) == []
    cli("settings", "set", "--disable=inventory")
    error_of(client.get(f"{API}/purchases"), 403, "action_forbidden")


# --- Preview ---------------------------------------------------------------------------------


def test_two_kilograms_for_2400_preview_as_2000_grams_at_twelve_thousandths(
    staff: TestClient, clock: FakeClock
) -> None:
    flour = new_ingredient(staff)
    draft = receipt(line(flour, "2", "kg", 2400, line_id="row-1"))

    response = preview_purchase(staff, draft)

    assert response.status_code == 200
    preview = response.json()
    assert preview == {
        "id": preview["id"],
        "expires_at": "2026-10-10T19:05:00Z",
        "currency": "USD",
        "minor_digits": 2,
        "total_cost_minor": 2400,
        "items": [
            {
                "client_line_id": "row-1",
                "ingredient_id": flour["id"],
                "base_quantity": "2000",
                "base_unit": "g",
                "total_cost_minor": 2400,
                "unit_cost": "0.012000000",
                "ingredient_version": 1,
                "before_quantity": "0",
                "after_quantity": "2000",
            }
        ],
    }
    # A preview changes nothing.
    assert read_ingredient(staff, flour["id"]) == flour
    assert references(staff) == []


@pytest.mark.parametrize(
    ("base_unit", "quantity", "unit", "pack", "base_quantity"),
    [
        ("g", "1", "kg", None, "1000"),
        ("g", "0.5", "kg", None, "500"),
        ("g", "0.001", "kg", None, "1"),
        ("g", "750", "g", None, "750"),
        ("g", "12.345", "g", None, "12.345"),
        ("ml", "1.5", "l", None, "1500"),
        ("ml", "250", "ml", None, "250"),
        ("piece", "12", "piece", None, "12"),
        ("g", "3", "bag", ("25", "kg"), "75000"),
        ("g", "2", "box", ("0.5", "kg"), "1000"),
        ("g", "4", "bag", ("12.5", "g"), "50"),
        ("ml", "6", "bottle", ("750", "ml"), "4500"),
        ("ml", "2", "bottle", ("1.5", "l"), "3000"),
        ("piece", "2", "box", ("12", "piece"), "24"),
    ],
)
def test_quantities_are_normalized_exactly_to_the_base_unit(
    staff: TestClient,
    base_unit: str,
    quantity: str,
    unit: str,
    pack: tuple[str, str] | None,
    base_quantity: str,
) -> None:
    ingredient = new_ingredient(staff, "Item", base_unit)
    draft = receipt(line(ingredient, quantity, unit, 1000, pack))

    row = preview_purchase(staff, draft).json()["items"][0]
    saved = buy(staff, draft)

    assert (row["base_quantity"], row["base_unit"]) == (base_quantity, base_unit)
    assert saved["ingredients"][0]["stock_on_hand"] == base_quantity
    # The receipt keeps what staff typed, beside what it came to.
    item = saved["purchase"]["items"][0]
    assert (item["quantity"], item["unit"], item["base_quantity"]) == (
        quantity,
        unit,
        base_quantity,
    )
    assert item["pack_contents"] == ({"quantity": pack[0], "unit": pack[1]} if pack else None)


@pytest.mark.parametrize(
    ("base_unit", "quantity", "unit", "pack", "path"),
    [
        ("ml", "2", "kg", None, "unit"),
        ("g", "2", "l", None, "unit"),
        ("g", "2", "piece", None, "unit"),
        ("piece", "2", "kg", None, "unit"),
        ("piece", "2", "ml", None, "unit"),
        ("g", "2", "bottle", ("750", "ml"), "unit"),
        ("piece", "2", "bag", ("1", "kg"), "unit"),
        ("g", "2", "bag", None, "pack_contents/quantity"),
        ("g", "2", "bag", ("0", "kg"), "pack_contents/quantity"),
        ("g", "2", "bag", ("-1", "kg"), "pack_contents/quantity"),
        ("g", "2", "bag", ("1.2345", "kg"), "pack_contents/quantity"),
        ("piece", "2", "box", ("2.5", "piece"), "pack_contents/quantity"),
        ("g", "2", "kg", ("1", "kg"), "pack_contents/quantity"),
        ("g", "1.5", "bag", ("25", "kg"), "quantity"),
        ("piece", "2.5", "piece", None, "quantity"),
        ("g", "0", "kg", None, "quantity"),
        ("g", "-2", "kg", None, "quantity"),
        ("g", "1.2345", "kg", None, "quantity"),
        ("g", "two", "kg", None, "quantity"),
        ("g", "9007199254740991", "kg", None, "quantity"),
    ],
)
def test_a_row_that_cannot_be_normalized_is_refused_at_the_field(
    staff: TestClient,
    base_unit: str,
    quantity: str,
    unit: str,
    pack: tuple[str, str] | None,
    path: str,
) -> None:
    ingredient = new_ingredient(staff, "Item", base_unit)

    refused = preview_purchase(staff, receipt(line(ingredient, quantity, unit, 1000, pack)))

    assert field_paths(refused) == {f"/draft/items/0/{path}"}


def test_repeated_rows_for_one_ingredient_add_up_in_order(staff: TestClient) -> None:
    flour = move(staff, new_ingredient(staff), "opening", "500")["ingredient"]
    eggs = new_ingredient(staff, "Eggs", "piece")
    draft = receipt(
        line(flour, "2", "kg", 2400, line_id="a"),
        line(eggs, "30", "piece", 900, line_id="b"),
        line(flour, "1", "bag", 1500, ("25", "kg"), line_id="c"),
    )

    preview = preview_purchase(staff, draft).json()

    assert [
        (row["client_line_id"], row["before_quantity"], row["base_quantity"], row["after_quantity"])
        for row in preview["items"]
    ] == [("a", "500", "2000", "2500"), ("b", "0", "30", "30"), ("c", "2500", "25000", "27500")]
    assert [row["ingredient_version"] for row in preview["items"]] == [2, 1, 2]
    assert preview["total_cost_minor"] == 4800
    assert [row["unit_cost"] for row in preview["items"]] == [
        "0.012000000",
        "0.300000000",
        "0.000600000",
    ]


@pytest.mark.parametrize(
    ("digits", "cost", "quantity", "unit", "unit_cost"),
    [
        (2, 2400, "2", "kg", "0.012000000"),
        (2, 1000, "3", "kg", "0.003333333"),
        (2, 2000, "3", "kg", "0.006666667"),
        (2, 0, "2", "kg", "0.000000000"),
        (2, 1, "1000", "kg", "0.000000010"),
        (0, 500, "1", "kg", "0.500000000"),
        (3, 1500, "1", "kg", "0.001500000"),
        (2, MAX_SAFE_INTEGER, "1", "g", "90071992547409.910000000"),
    ],
)
def test_unit_cost_is_major_currency_per_base_unit_to_nine_decimals(
    staff: TestClient, cli: Cli, digits: int, cost: int, quantity: str, unit: str, unit_cost: str
) -> None:
    cli("settings", "set", f"--minor-digits={digits}")
    flour = new_ingredient(staff)

    preview = preview_purchase(staff, receipt(line(flour, quantity, unit, cost))).json()

    assert (preview["minor_digits"], preview["items"][0]["unit_cost"]) == (digits, unit_cost)


@pytest.mark.parametrize(
    ("path", "value", "reported"),
    [
        ("/purchased_on", "2026-02-30", "/draft/purchased_on"),
        ("/purchased_on", ..., "/draft/purchased_on"),
        ("/supplier", " ", "/draft/supplier"),
        ("/supplier", "x" * 201, "/draft/supplier"),
        ("/supplier", ..., "/draft/supplier"),
        ("/note", "x" * 2001, "/draft/note"),
        ("/note", None, "/draft/note"),
        ("/items", [], "/draft/items"),
        ("/items", ..., "/draft/items"),
        ("/items/0/client_line_id", " ", "/draft/items/0/client_line_id"),
        ("/items/0/ingredient_id", "ing_nowhere", "/draft/items/0/ingredient_id"),
        ("/items/0/unit", "sack", "/draft/items/0/unit"),
        ("/items/0/quantity", 2, "/draft/items/0/quantity"),
        ("/items/0/total_cost_minor", -1, "/draft/items/0/total_cost_minor"),
        ("/items/0/total_cost_minor", 24.5, "/draft/items/0/total_cost_minor"),
        ("/items/0/total_cost_minor", "2400", "/draft/items/0/total_cost_minor"),
        ("/items/0/total_cost_minor", ..., "/draft/items/0/total_cost_minor"),
        ("/items/0/unit_cost", "0.001000000", "/draft/items/0/unit_cost"),
        ("/items/0/base_quantity", "5000", "/draft/items/0/base_quantity"),
        ("/total_cost_minor", 1, "/draft/total_cost_minor"),
        ("/currency", "PHP", "/draft/currency"),
    ],
)
def test_an_invalid_receipt_is_refused_at_the_field(
    staff: TestClient, path: str, value: Any, reported: str
) -> None:
    flour = new_ingredient(staff)

    refused = preview_purchase(staff, changed(receipt(line(flour)), path, value))

    assert field_paths(refused) == {reported}


def test_a_receipt_has_one_to_a_hundred_rows_with_their_own_identifiers(
    staff: TestClient,
) -> None:
    flour = new_ingredient(staff)
    hundred = [line(flour, "1", "g", 1, line_id=f"row-{index}") for index in range(100)]

    assert preview_purchase(staff, receipt(*hundred)).json()["items"][-1]["after_quantity"] == "100"
    too_many = receipt(*hundred, line(flour, "1", "g", 1, line_id="row-100"))
    assert field_paths(preview_purchase(staff, too_many)) == {"/draft/items"}
    twins = receipt(line(flour, line_id="same"), line(flour, "1", "kg", 5, line_id="same"))
    assert field_paths(preview_purchase(staff, twins)) == {"/draft/items/1/client_line_id"}


def test_a_receipt_total_beyond_the_safe_bound_is_refused(staff: TestClient) -> None:
    flour = new_ingredient(staff)
    draft = receipt(
        line(flour, "1", "kg", MAX_SAFE_INTEGER, line_id="a"),
        line(flour, "1", "kg", 1, line_id="b"),
    )

    assert field_paths(preview_purchase(staff, draft)) == {"/draft/items"}


def test_one_bad_row_refuses_the_whole_receipt(staff: TestClient) -> None:
    flour, oil = new_ingredient(staff), new_ingredient(staff, "Oil", "ml")
    draft = receipt(line(flour), line(oil, "2", "kg", 500))

    assert field_paths(preview_purchase(staff, draft)) == {"/draft/items/1/unit"}
    assert read_ingredient(staff, flour["id"]) == flour


# --- Saving ----------------------------------------------------------------------------------


def test_a_saved_receipt_adds_its_stock_once_and_sets_the_cost_basis(
    staff: TestClient, clock: FakeClock
) -> None:
    flour = new_ingredient(staff)
    draft = receipt(line(flour, "2", "kg", 2400), supplier="  Corner Market ")
    draft["note"] = " Weekly run "
    preview = preview_purchase(staff, draft).json()
    key = str(uuid.uuid4())
    clock.advance(minutes=1)

    response = save_purchase(staff, draft, preview, key)

    assert response.status_code == 201
    result = response.json()
    assert set(result) == {"purchase", "ingredients"}
    purchase = result["purchase"]
    item = purchase["items"][0]
    assert purchase == {
        "id": purchase["id"],
        "reference": "DEV-P0001",
        "purchased_on": "2026-10-07",
        "supplier": "Corner Market",
        "note": " Weekly run ",
        "currency": "USD",
        "minor_digits": 2,
        "total_cost_minor": 2400,
        "items": [
            {
                "id": item["id"],
                "ingredient_id": flour["id"],
                "ingredient_name": "Flour",
                "base_unit": "g",
                "quantity": "2",
                "unit": "kg",
                "pack_contents": None,
                "base_quantity": "2000",
                "unit_cost": "0.012000000",
                "total_cost_minor": 2400,
                "stock_movement_id": item["stock_movement_id"],
            }
        ],
        "operation_id": key,
        "recorded_at": "2026-10-10T19:01:00Z",
        "recorded_by": "Admin",
    }
    assert purchase["id"].startswith("pur_") and item["id"].startswith("pln_")
    after = result["ingredients"]
    assert after == [
        {
            **flour,
            "version": 2,
            "stock_on_hand": "2000",
            "latest_unit_cost": "0.012000000",
            "latest_purchase_date": "2026-10-07",
            "permitted_actions": after[0]["permitted_actions"],
        }
    ]
    assert after[0]["permitted_actions"]["opening"]["allowed"] is False
    assert read_ingredient(staff, flour["id"]) == after[0]
    assert staff.get(f"{API}/purchases/{purchase['id']}").json() == purchase
    assert movements(staff, flour["id"]) == [
        {
            "id": item["stock_movement_id"],
            "ingredient_id": flour["id"],
            "delta_base_quantity": "2000",
            "before_quantity": "0",
            "after_quantity": "2000",
            "type": "purchase",
            "reason": "DEV-P0001",
            "purchase_id": purchase["id"],
            "preparation_id": None,
            "corrects_movement_id": None,
            "operation_id": key,
            "recorded_at": "2026-10-10T19:01:00Z",
            "recorded_by": "Admin",
        }
    ]
    operation = staff.get(f"{API}/operations/{key}").json()
    assert (operation["state"], operation["resource_type"], operation["resource_id"]) == (
        "succeeded",
        "purchase",
        purchase["id"],
    )
    assert operation["result"] == {"http_status": 201, "body": result}


def test_a_receipt_with_repeated_ingredients_moves_each_row_and_versions_once(
    staff: TestClient,
) -> None:
    flour = move(staff, new_ingredient(staff), "opening", "500")["ingredient"]
    eggs = new_ingredient(staff, "Eggs", "piece")
    draft = receipt(
        line(flour, "2", "kg", 2400, line_id="a"),
        line(eggs, "30", "piece", 900, line_id="b"),
        line(flour, "1", "bag", 1500, ("25", "kg"), line_id="c"),
    )

    result = buy(staff, draft)

    assert result["purchase"]["total_cost_minor"] == 4800
    assert [row["ingredient_name"] for row in result["purchase"]["items"]] == [
        "Flour",
        "Eggs",
        "Flour",
    ]
    by_id = {item["id"]: item for item in result["ingredients"]}
    assert len(result["ingredients"]) == 2
    # One version step per ingredient for the whole receipt, however many rows named it.
    assert (by_id[flour["id"]]["version"], by_id[flour["id"]]["stock_on_hand"]) == (3, "27500")
    assert (by_id[eggs["id"]]["version"], by_id[eggs["id"]]["stock_on_hand"]) == (2, "30")
    history = movements(staff, flour["id"])
    assert [
        (row["type"], row["delta_base_quantity"], row["after_quantity"]) for row in history
    ] == [
        ("purchase", "25000", "27500"),
        ("purchase", "2000", "2500"),
        ("opening", "500", "500"),
    ]
    assert {row["id"] for row in history[:2]} == {
        item["stock_movement_id"]
        for item in result["purchase"]["items"]
        if item["ingredient_id"] == flour["id"]
    }


def test_a_repeated_purchase_request_adds_its_stock_once(staff: TestClient) -> None:
    flour = new_ingredient(staff)
    draft = receipt(line(flour))
    preview = preview_purchase(staff, draft).json()
    request = {"preview_id": preview["id"], "draft": draft}
    assert field_paths(staff.post(f"{API}/purchases", json=request)) == {"/header/Idempotency-Key"}
    key = str(uuid.uuid4())

    first = keyed(staff, "POST", "/purchases", request, key)
    again = keyed(staff, "POST", "/purchases", request, key)

    assert (first.status_code, again.content) == (201, first.content)
    assert again.headers["Idempotency-Replayed"] == "true"
    assert read_ingredient(staff, flour["id"])["stock_on_hand"] == "2000"
    assert references(staff) == ["DEV-P0001"]
    # The preview is spent, so the same receipt under a new key is not a second purchase.
    error_of(keyed(staff, "POST", "/purchases", request), 409, "quote_stale")
    assert read_ingredient(staff, flour["id"])["stock_on_hand"] == "2000"


def test_a_save_must_be_exactly_what_was_previewed(staff: TestClient, clock: FakeClock) -> None:
    flour = new_ingredient(staff)
    draft = receipt(line(flour))
    preview = preview_purchase(staff, draft).json()

    unknown = save_purchase(staff, draft, {"id": "prev_nowhere"})
    dearer = save_purchase(staff, changed(draft, "/items/0/total_cost_minor", 2500), preview)
    redated = save_purchase(staff, changed(draft, "/purchased_on", "2026-10-08"), preview)

    for response in (unknown, dearer, redated):
        error_of(response, 409, "quote_stale")
    clock.advance(minutes=5)
    error_of(save_purchase(staff, draft, preview), 409, "quote_stale")
    assert read_ingredient(staff, flour["id"]) == flour
    assert references(staff) == []


def test_the_same_receipt_written_differently_is_the_previewed_receipt(staff: TestClient) -> None:
    flour = new_ingredient(staff)
    draft = receipt(line(flour))
    preview = preview_purchase(staff, draft).json()
    rewritten = changed(changed(draft, "/note", ...), "/supplier", "  Market ")

    assert save_purchase(staff, rewritten, preview).status_code == 201


def test_a_receipt_is_refused_when_an_ingredient_changed_after_its_preview(
    staff: TestClient,
) -> None:
    flour, eggs = new_ingredient(staff), new_ingredient(staff, "Eggs", "piece")
    draft = receipt(line(flour), line(eggs, "30", "piece", 900))
    preview = preview_purchase(staff, draft).json()
    current = move(staff, eggs, "opening", "6")["ingredient"]

    late = save_purchase(staff, draft, preview)

    conflict = error_of(late, 409, "version_conflict")
    assert conflict["details"] == {
        "resource_type": "ingredient",
        "resource_id": eggs["id"],
        "expected_version": 1,
        "current_version": 2,
        "latest_resource": current,
    }
    # Nothing of the receipt was kept, not even the row whose ingredient had not changed.
    assert read_ingredient(staff, flour["id"]) == flour
    assert references(staff) == []


def test_a_settings_change_after_the_preview_makes_it_stale(staff: TestClient, cli: Cli) -> None:
    flour = new_ingredient(staff)
    draft = receipt(line(flour))
    preview = preview_purchase(staff, draft).json()
    cli("settings", "set", "--minor-digits=3")

    error_of(save_purchase(staff, draft, preview), 409, "quote_stale")
    assert references(staff) == []


@pytest.mark.parametrize(
    ("changes", "path"),
    [
        ({"preview_id": ...}, "/preview_id"),
        ({"preview_id": 7}, "/preview_id"),
        ({"draft": ...}, "/draft"),
        ({"total_cost_minor": 2400}, "/total_cost_minor"),
        ({"recorded_by": "Somebody Else"}, "/recorded_by"),
    ],
)
def test_a_malformed_save_is_refused_at_the_field(
    staff: TestClient, changes: dict[str, Any], path: str
) -> None:
    flour = new_ingredient(staff)
    draft = receipt(line(flour))
    request: dict[str, Any] = {
        "preview_id": preview_purchase(staff, draft).json()["id"],
        "draft": draft,
    }
    for name, value in changes.items():
        if value is ...:
            del request[name]
        else:
            request[name] = value

    assert field_paths(keyed(staff, "POST", "/purchases", request)) == {path}
    assert references(staff) == []


# --- Cost basis and price history ------------------------------------------------------------


def test_the_cost_basis_follows_the_latest_purchase_date_not_the_latest_entry(
    staff: TestClient, clock: FakeClock
) -> None:
    flour = new_ingredient(staff)
    buy(staff, receipt(line(flour, "1", "kg", 1200), on="2026-10-07"))
    clock.advance(minutes=1)
    buy(staff, receipt(line(flour, "1", "kg", 900), on="2026-10-01"))

    # The older receipt was entered later; it adds stock but does not replace the newer price.
    after_older = read_ingredient(staff, flour["id"])
    assert (after_older["latest_unit_cost"], after_older["latest_purchase_date"]) == (
        "0.012000000",
        "2026-10-07",
    )
    assert after_older["stock_on_hand"] == "2000"

    clock.advance(minutes=1)
    buy(staff, receipt(line(flour, "1", "kg", 1500), on="2026-10-07"))
    same_day = read_ingredient(staff, flour["id"])
    assert (same_day["latest_unit_cost"], same_day["latest_purchase_date"]) == (
        "0.015000000",
        "2026-10-07",
    )

    clock.advance(minutes=1)
    buy(staff, receipt(line(flour, "1", "kg", 0), on="2026-10-09"))
    free = read_ingredient(staff, flour["id"])
    # A known zero cost is a real basis with a date, not an unknown one.
    assert (free["latest_unit_cost"], free["latest_purchase_date"]) == ("0.000000000", "2026-10-09")


def test_price_history_lists_an_ingredients_receipt_lines_newest_first(
    staff: TestClient, clock: FakeClock
) -> None:
    flour, eggs = new_ingredient(staff), new_ingredient(staff, "Eggs", "piece")
    first = buy(staff, receipt(line(flour, "2", "kg", 2400), on="2026-10-07", supplier="Market"))
    clock.advance(minutes=1)
    buy(staff, receipt(line(eggs, "30", "piece", 900), on="2026-10-08"))
    older = buy(
        staff,
        receipt(line(flour, "1", "bag", 1500, ("25", "kg")), on="2026-10-01", supplier="Mill"),
    )
    clock.advance(minutes=1)
    latest = buy(staff, receipt(line(flour, "500", "g", 700), on="2026-10-07", supplier="Market"))

    body = staff.get(f"{API}/ingredients/{flour['id']}/prices").json()

    assert [row["reference"] for row in body["items"]] == [
        latest["purchase"]["reference"],
        first["purchase"]["reference"],
        older["purchase"]["reference"],
    ]
    item = first["purchase"]["items"][0]
    assert body["items"][1] == {
        **item,
        "purchase_id": first["purchase"]["id"],
        "reference": "DEV-P0001",
        "supplier": "Market",
        "purchased_on": "2026-10-07",
        "recorded_at": "2026-10-10T19:00:00Z",
        "currency": "USD",
        "minor_digits": 2,
    }
    assert body["items"][2]["pack_contents"] == {"quantity": "25", "unit": "kg"}
    assert (body["total"], body["has_next"]) == (3, False)
    page = staff.get(f"{API}/ingredients/{flour['id']}/prices?limit=2&page=2").json()
    assert [row["reference"] for row in page["items"]] == [older["purchase"]["reference"]]
    # Stock corrections never enter the price history.
    move(staff, read_ingredient(staff, flour["id"]), "correction", "-5")
    assert staff.get(f"{API}/ingredients/{flour['id']}/prices").json()["total"] == 3


def test_a_receipt_keeps_the_ingredient_name_it_was_bought_under(staff: TestClient) -> None:
    flour = new_ingredient(staff)
    purchase = buy(staff, receipt(line(flour)))["purchase"]

    keyed(staff, "PATCH", f"/ingredients/{flour['id']}", {"expected_version": 2, "name": "Rye"})

    assert staff.get(f"{API}/purchases/{purchase['id']}").json() == purchase
    assert purchase["items"][0]["ingredient_name"] == "Flour"


def test_receipts_cannot_be_edited_or_deleted(staff: TestClient) -> None:
    flour = new_ingredient(staff)
    purchase = buy(staff, receipt(line(flour)))["purchase"]

    for method in ("PATCH", "PUT", "DELETE"):
        for path in (f"/purchases/{purchase['id']}", "/purchases"):
            response = keyed(staff, method, path, {"supplier": "Someone else"})
            assert response.status_code in {404, 405}
    assert staff.get(f"{API}/purchases/{purchase['id']}").json() == purchase


# --- Finding receipts ------------------------------------------------------------------------


@pytest.fixture
def receipts(staff: TestClient, clock: FakeClock) -> list[dict[str, Any]]:
    flour = new_ingredient(staff)
    made = []
    for on, supplier in [
        ("2026-10-07", "Corner Market"),
        ("2026-10-09", "City Mill"),
        ("2026-10-07", "corner market annex"),
        ("2026-10-01", "Harbour Traders"),
    ]:
        made.append(buy(staff, receipt(line(flour, "1", "kg", 1000), on=on, supplier=supplier)))
        clock.advance(minutes=1)
    return [result["purchase"] for result in made]


def test_receipts_are_listed_as_summaries_with_the_newest_purchase_date_first(
    staff: TestClient, receipts: list[dict[str, Any]]
) -> None:
    body = staff.get(f"{API}/purchases").json()

    # Two receipts share 7 October; the one entered later comes first.
    assert [item["reference"] for item in body["items"]] == [
        "DEV-P0002",
        "DEV-P0003",
        "DEV-P0001",
        "DEV-P0004",
    ]
    first = receipts[1]
    assert body["items"][0] == {
        "id": first["id"],
        "reference": "DEV-P0002",
        "purchased_on": "2026-10-09",
        "supplier": "City Mill",
        "currency": "USD",
        "minor_digits": 2,
        "total_cost_minor": 1000,
        "recorded_at": first["recorded_at"],
    }
    assert (body["page"], body["limit"], body["total"], body["has_next"]) == (1, 25, 4, False)
    assert references(staff, "?limit=3&page=2") == ["DEV-P0004"]


@pytest.mark.usefixtures("receipts")
def test_receipts_are_found_by_supplier_reference_and_date(staff: TestClient) -> None:
    assert references(staff, "?q=CORNER") == ["DEV-P0003", "DEV-P0001"]
    assert references(staff, "?q=dev-p0004") == ["DEV-P0004"]
    assert references(staff, "?q=%20mill%20") == ["DEV-P0002"]
    assert references(staff, "?supplier=annex") == ["DEV-P0003"]
    assert references(staff, "?supplier=market&q=p0001") == ["DEV-P0001"]
    assert references(staff, "?date_from=2026-10-07&date_to=2026-10-07") == [
        "DEV-P0003",
        "DEV-P0001",
    ]
    assert references(staff, "?date_from=2026-10-08") == ["DEV-P0002"]
    assert references(staff, "?date_to=2026-10-01") == ["DEV-P0004"]
    assert references(staff, "?q=bakery") == []


@pytest.mark.parametrize(
    ("query", "path"),
    [
        ("?date_from=2026-02-30", "/query/date_from"),
        ("?date_from=2026-10-09&date_to=2026-10-07", "/query/date_to"),
        (f"?q={'x' * 201}", "/query/q"),
        (f"?supplier={'x' * 201}", "/query/supplier"),
        ("?ingredient_id=ing_1", "/query/ingredient_id"),
        ("?page=0", "/query/page"),
    ],
)
def test_an_unknown_or_invalid_receipt_filter_is_refused(
    staff: TestClient, query: str, path: str
) -> None:
    assert field_paths(staff.get(f"{API}/purchases{query}")) == {path}


def test_an_unknown_receipt_is_not_found(staff: TestClient) -> None:
    error_of(staff.get(f"{API}/purchases/pur_nowhere"), 404, "not_found")
