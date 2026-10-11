import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.persistence.models import StaffUser
from tests.inventory_support import (
    ALLOWED,
    STOCK_SETTINGS,
    move,
    movement_input,
    movements,
    new_ingredient,
    preview_movement,
    read_ingredient,
    save_movement,
)
from tests.support import API, Cli, FakeClock, error_of, field_paths, keyed, sign_in


@pytest.fixture
def staff(client: TestClient, admin: StaffUser, cli: Cli) -> TestClient:
    """Signed-in staff with ingredients and purchases enabled."""
    assert cli(*STOCK_SETTINGS) == 0
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
    return client


def names(client: TestClient, query: str = "") -> list[str]:
    response = client.get(f"{API}/ingredients{query}")
    assert response.status_code == 200, response.text
    return [item["name"] for item in response.json()["items"]]


# --- Access ----------------------------------------------------------------------------------


def test_ingredients_need_a_session_and_the_inventory_workflow(
    client: TestClient, admin: StaffUser, cli: Cli
) -> None:
    paths = ["/ingredients", "/ingredients/ing_1", "/ingredients/ing_1/movements"]
    for path in paths:
        error_of(client.get(f"{API}{path}"), 401, "unauthenticated")
    cli(*STOCK_SETTINGS[:-2])
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]

    for path in paths:
        error_of(client.get(f"{API}{path}"), 403, "action_forbidden")
    error_of(keyed(client, "POST", "/ingredients", {"name": "Flour"}), 403, "action_forbidden")

    cli("settings", "set", "--enable=inventory")
    assert names(client) == []


def test_a_live_system_keeps_stock_closed_until_currency_and_timezone_are_confirmed(
    staff: TestClient, cli: Cli
) -> None:
    cli("settings", "set", "--environment=live")

    refused = error_of(staff.get(f"{API}/ingredients"), 409, "settings_unconfirmed")
    assert refused["details"] == {"unconfirmed": ["currency", "timezone"]}
    cli("settings", "confirm", "currency")
    assert error_of(staff.get(f"{API}/ingredients"), 409, "settings_unconfirmed")["details"] == {
        "unconfirmed": ["timezone"]
    }

    # Fulfillment, delivery and tax do not concern the stockroom.
    cli("settings", "confirm", "timezone")
    assert names(staff) == []
    assert new_ingredient(staff)["name"] == "Flour"


# --- Ingredients -----------------------------------------------------------------------------


def test_a_new_ingredient_has_no_stock_no_cost_and_every_action(staff: TestClient) -> None:
    key = str(uuid.uuid4())
    body = {"name": "  Rice flour ", "base_unit": "g", "low_stock_threshold": None}

    response = keyed(staff, "POST", "/ingredients", body, key)

    assert response.status_code == 201
    ingredient = response.json()
    assert ingredient == {
        "id": ingredient["id"],
        "version": 1,
        "name": "Rice flour",
        "base_unit": "g",
        "low_stock_threshold": None,
        "stock_on_hand": "0",
        "low_stock": False,
        "latest_unit_cost": None,
        "latest_purchase_date": None,
        "permitted_actions": dict.fromkeys(["edit", "opening", "waste", "correction"], ALLOWED),
    }
    assert ingredient["id"].startswith("ing_")
    assert read_ingredient(staff, ingredient["id"]) == ingredient
    operation = staff.get(f"{API}/operations/{key}").json()
    assert (operation["state"], operation["resource_type"], operation["resource_id"]) == (
        "succeeded",
        "ingredient",
        ingredient["id"],
    )
    assert operation["result"] == {"http_status": 201, "body": ingredient}


@pytest.mark.parametrize(
    ("unit", "threshold", "stored"),
    [
        ("g", "500", "500"),
        ("g", "0.5", "0.5"),
        ("g", "12.340", "12.34"),
        ("g", "0", "0"),
        ("ml", "250.125", "250.125"),
        ("piece", "12", "12"),
        ("piece", "3.000", "3"),
    ],
)
def test_a_threshold_is_an_exact_quantity_in_the_base_unit(
    staff: TestClient, unit: str, threshold: str, stored: str
) -> None:
    ingredient = new_ingredient(staff, base_unit=unit, threshold=threshold)

    assert ingredient["low_stock_threshold"] == stored
    # Nothing is in stock yet, which is at or below any threshold.
    assert ingredient["low_stock"] is True


@pytest.mark.parametrize(
    ("changes", "path"),
    [
        ({"name": ""}, "/name"),
        ({"name": "   "}, "/name"),
        ({"name": "x" * 201}, "/name"),
        ({"name": ...}, "/name"),
        ({"name": 5}, "/name"),
        ({"base_unit": "kg"}, "/base_unit"),
        ({"base_unit": "cup"}, "/base_unit"),
        ({"base_unit": ...}, "/base_unit"),
        ({"low_stock_threshold": "-1"}, "/low_stock_threshold"),
        ({"low_stock_threshold": "1.2345"}, "/low_stock_threshold"),
        ({"low_stock_threshold": "1e3"}, "/low_stock_threshold"),
        ({"low_stock_threshold": "lots"}, "/low_stock_threshold"),
        ({"low_stock_threshold": 500}, "/low_stock_threshold"),
        ({"low_stock_threshold": "9007199254740992"}, "/low_stock_threshold"),
        ({"base_unit": "piece", "low_stock_threshold": "2.5"}, "/low_stock_threshold"),
        ({"stock_on_hand": "100"}, "/stock_on_hand"),
        ({"latest_unit_cost": "0.010000000"}, "/latest_unit_cost"),
        ({"version": 3}, "/version"),
    ],
)
def test_an_invalid_ingredient_is_refused_at_the_field(
    staff: TestClient, changes: dict[str, Any], path: str
) -> None:
    body: dict[str, Any] = {"name": "Flour", "base_unit": "g", "low_stock_threshold": None}
    for name, value in changes.items():
        if value is ...:
            del body[name]
        else:
            body[name] = value

    assert field_paths(keyed(staff, "POST", "/ingredients", body)) == {path}
    assert names(staff) == []


def test_the_threshold_may_be_left_out_and_the_name_may_be_200_characters(
    staff: TestClient,
) -> None:
    response = keyed(staff, "POST", "/ingredients", {"name": " " + "x" * 200, "base_unit": "ml"})

    assert response.status_code == 201
    assert (len(response.json()["name"]), response.json()["low_stock_threshold"]) == (200, None)


def test_an_ingredient_is_created_once_per_operation_key(staff: TestClient) -> None:
    body = {"name": "Flour", "base_unit": "g", "low_stock_threshold": None}
    assert field_paths(staff.post(f"{API}/ingredients", json=body)) == {"/header/Idempotency-Key"}
    key = str(uuid.uuid4())

    first = keyed(staff, "POST", "/ingredients", body, key)
    again = keyed(staff, "POST", "/ingredients", body, key)

    assert (first.status_code, again.content) == (201, first.content)
    assert again.headers["Idempotency-Replayed"] == "true"
    assert names(staff) == ["Flour"]


def test_an_edit_changes_name_and_threshold_and_nothing_else(staff: TestClient) -> None:
    ingredient = move(staff, new_ingredient(staff), "opening", "2000")["ingredient"]
    path = f"/ingredients/{ingredient['id']}"

    renamed = keyed(staff, "PATCH", path, {"expected_version": 2, "name": " Bread flour "})
    with_threshold = keyed(
        staff, "PATCH", path, {"expected_version": 3, "low_stock_threshold": "2500"}
    )
    cleared = keyed(staff, "PATCH", path, {"expected_version": 4, "low_stock_threshold": None})

    assert renamed.status_code == 200
    assert renamed.json() == {**ingredient, "version": 3, "name": "Bread flour"}
    assert with_threshold.json() == {
        **renamed.json(),
        "version": 4,
        "low_stock_threshold": "2500",
        "low_stock": True,
    }
    assert cleared.json() == {**renamed.json(), "version": 5}
    assert read_ingredient(staff, ingredient["id"]) == cleared.json()
    # Editing the record is not a stock movement.
    assert len(movements(staff, ingredient["id"])) == 1


@pytest.mark.parametrize(
    ("body", "path"),
    [
        ({"name": "Rye"}, "/expected_version"),
        ({"expected_version": 0, "name": "Rye"}, "/expected_version"),
        ({"expected_version": 1, "name": None}, "/name"),
        ({"expected_version": 1, "name": " "}, "/name"),
        ({"expected_version": 1, "base_unit": "ml"}, "/base_unit"),
        ({"expected_version": 1, "low_stock_threshold": "1.2345"}, "/low_stock_threshold"),
        ({"expected_version": 1, "stock_on_hand": "50"}, "/stock_on_hand"),
        ({"expected_version": 9, "low_stock_threshold": "-1"}, "/low_stock_threshold"),
    ],
)
def test_an_invalid_edit_is_refused_at_the_field(
    staff: TestClient, body: dict[str, Any], path: str
) -> None:
    ingredient = new_ingredient(staff)

    refused = keyed(staff, "PATCH", f"/ingredients/{ingredient['id']}", body)

    assert field_paths(refused) == {path}
    assert read_ingredient(staff, ingredient["id"]) == ingredient


def test_a_stale_or_unknown_edit_changes_nothing(staff: TestClient) -> None:
    ingredient = new_ingredient(staff)

    stale = keyed(
        staff, "PATCH", f"/ingredients/{ingredient['id']}", {"expected_version": 2, "name": "Rye"}
    )
    missing = keyed(staff, "PATCH", "/ingredients/ing_nowhere", {"expected_version": 1})

    conflict = error_of(stale, 409, "version_conflict")
    assert conflict["details"] == {
        "resource_type": "ingredient",
        "resource_id": ingredient["id"],
        "expected_version": 2,
        "current_version": 1,
        "latest_resource": ingredient,
    }
    error_of(missing, 404, "not_found")
    error_of(staff.get(f"{API}/ingredients/ing_nowhere"), 404, "not_found")
    assert read_ingredient(staff, ingredient["id"]) == ingredient


@pytest.fixture
def stockroom(staff: TestClient) -> dict[str, dict[str, Any]]:
    """Four ingredients: two below their threshold, one above, one with no threshold."""
    made = {
        "sugar": new_ingredient(staff, "sugar", threshold="1000"),
        "Flour": new_ingredient(staff, "Flour", threshold="500"),
        "Eggs": new_ingredient(staff, "Eggs", "piece", threshold="12"),
        "Annatto oil": new_ingredient(staff, "Annatto oil", "ml"),
    }
    made["Flour"] = move(staff, made["Flour"], "opening", "2000")["ingredient"]
    made["Eggs"] = move(staff, made["Eggs"], "opening", "12")["ingredient"]
    made["Annatto oil"] = move(staff, made["Annatto oil"], "opening", "5")["ingredient"]
    return made


@pytest.mark.usefixtures("stockroom")
def test_ingredients_are_listed_by_name_and_found_by_text(staff: TestClient) -> None:
    body = staff.get(f"{API}/ingredients").json()

    assert [item["name"] for item in body["items"]] == ["Annatto oil", "Eggs", "Flour", "sugar"]
    assert (body["page"], body["limit"], body["total"], body["has_next"]) == (1, 25, 4, False)
    assert names(staff, "?q=%20FLO%20") == ["Flour"]
    assert names(staff, "?q=o") == ["Annatto oil", "Flour"]
    assert names(staff, "?q=salt") == []
    assert names(staff, "?limit=3&page=2") == ["sugar"]


@pytest.mark.usefixtures("stockroom")
def test_low_stock_means_a_threshold_exists_and_stock_is_at_or_below_it(
    staff: TestClient,
) -> None:
    listed = {
        item["name"]: item["low_stock"] for item in staff.get(f"{API}/ingredients").json()["items"]
    }

    # Sugar has nothing; eggs are exactly at their threshold; oil has no threshold at all.
    assert listed == {"Annatto oil": False, "Eggs": True, "Flour": False, "sugar": True}
    assert names(staff, "?low_stock=true") == ["Eggs", "sugar"]
    assert names(staff, "?low_stock=false") == ["Annatto oil", "Flour"]
    assert names(staff, "?low_stock=true&q=egg") == ["Eggs"]


@pytest.mark.parametrize(
    ("query", "path"),
    [
        ("?low_stock=yes", "/query/low_stock"),
        ("?low_stock=1", "/query/low_stock"),
        (f"?q={'x' * 201}", "/query/q"),
        ("?base_unit=g", "/query/base_unit"),
        ("?page=0", "/query/page"),
        ("?limit=101", "/query/limit"),
    ],
)
def test_an_unknown_or_invalid_ingredient_filter_is_refused(
    staff: TestClient, query: str, path: str
) -> None:
    assert field_paths(staff.get(f"{API}/ingredients{query}")) == {path}


# --- Movement previews -----------------------------------------------------------------------


def test_a_preview_shows_before_change_and_after_and_saves_nothing(
    staff: TestClient, clock: FakeClock
) -> None:
    ingredient = new_ingredient(staff)
    body = movement_input(ingredient, "opening", "2000.000", reason="  First count ")

    response = preview_movement(staff, ingredient, body)

    assert response.status_code == 200
    preview = response.json()
    assert preview == {
        "id": preview["id"],
        "expires_at": "2026-10-10T19:05:00Z",
        "ingredient_id": ingredient["id"],
        "expected_version": 1,
        "before_quantity": "0",
        "delta_base_quantity": "2000",
        "after_quantity": "2000",
    }
    assert read_ingredient(staff, ingredient["id"]) == ingredient
    assert movements(staff, ingredient["id"]) == []


@pytest.mark.parametrize(
    ("kind", "delta", "path"),
    [
        ("opening", "-5", "/delta_base_quantity"),
        ("opening", "0", "/delta_base_quantity"),
        ("opening", "0.000", "/delta_base_quantity"),
        ("opening", "1.2345", "/delta_base_quantity"),
        ("opening", "1e3", "/delta_base_quantity"),
        ("opening", "+5", "/delta_base_quantity"),
        ("opening", 5, "/delta_base_quantity"),
        ("opening", None, "/delta_base_quantity"),
        ("opening", "9007199254740992", "/delta_base_quantity"),
        ("waste", "5", "/delta_base_quantity"),
        ("waste", "-0", "/delta_base_quantity"),
        ("waste", "-1", "/delta_base_quantity"),
        ("correction", "-0.001", "/delta_base_quantity"),
        ("purchase", "5", "/type"),
        ("consumption", "-5", "/type"),
        ("transfer", "5", "/type"),
        (None, "5", "/type"),
    ],
)
def test_a_movement_on_an_empty_shelf_is_checked_for_type_sign_and_exactness(
    staff: TestClient, kind: Any, delta: Any, path: str
) -> None:
    ingredient = new_ingredient(staff)

    refused = preview_movement(staff, ingredient, movement_input(ingredient, kind, delta))

    assert field_paths(refused) == {path}


def test_pieces_move_in_whole_numbers(staff: TestClient) -> None:
    eggs = new_ingredient(staff, "Eggs", "piece")

    refused = preview_movement(staff, eggs, movement_input(eggs, "opening", "2.5"))

    assert field_paths(refused) == {"/delta_base_quantity"}
    assert move(staff, eggs, "opening", "24")["ingredient"]["stock_on_hand"] == "24"


@pytest.mark.parametrize(
    ("changes", "path"),
    [
        ({"reason": ""}, "/reason"),
        ({"reason": "  "}, "/reason"),
        ({"reason": "x" * 2001}, "/reason"),
        ({"reason": ...}, "/reason"),
        ({"expected_version": ...}, "/expected_version"),
        ({"expected_version": "1"}, "/expected_version"),
        ({"preparation_id": "prep_1"}, "/preparation_id"),
        ({"corrects_movement_id": "mov_nowhere"}, "/corrects_movement_id"),
        ({"recorded_by": "Somebody Else"}, "/recorded_by"),
        ({"after_quantity": "100"}, "/after_quantity"),
        ({"preview_id": "prev_1"}, "/preview_id"),
    ],
)
def test_a_malformed_movement_is_refused_at_the_field(
    staff: TestClient, changes: dict[str, Any], path: str
) -> None:
    ingredient = new_ingredient(staff)

    refused = preview_movement(
        staff, ingredient, movement_input(ingredient, "opening", "100", **changes)
    )

    assert field_paths(refused) == {path}


def test_a_stale_or_unknown_preview_request_is_refused(staff: TestClient) -> None:
    ingredient = new_ingredient(staff)
    body = movement_input(ingredient, "opening", "100", expected_version=2)

    conflict = error_of(preview_movement(staff, ingredient, body), 409, "version_conflict")
    missing = staff.post(f"{API}/ingredients/ing_nowhere/movement-preview", json=body)

    assert conflict["details"]["latest_resource"] == ingredient
    error_of(missing, 404, "not_found")


# --- Saving movements ------------------------------------------------------------------------


def test_opening_stock_is_recorded_once_and_closes_the_opening_action(
    staff: TestClient, clock: FakeClock
) -> None:
    ingredient = new_ingredient(staff)
    body = movement_input(ingredient, "opening", "2000", reason="  First count ")
    preview = preview_movement(staff, ingredient, body).json()
    key = str(uuid.uuid4())
    clock.advance(minutes=2)

    response = save_movement(staff, ingredient, body, preview, key)

    assert response.status_code == 201
    result = response.json()
    assert set(result) == {"movement", "ingredient"}
    movement, after = result["movement"], result["ingredient"]
    assert movement == {
        "id": movement["id"],
        "ingredient_id": ingredient["id"],
        "delta_base_quantity": "2000",
        "before_quantity": "0",
        "after_quantity": "2000",
        "type": "opening",
        "reason": "First count",
        "purchase_id": None,
        "preparation_id": None,
        "corrects_movement_id": None,
        "operation_id": key,
        "recorded_at": "2026-10-10T19:02:00Z",
        "recorded_by": "Admin",
    }
    assert movement["id"].startswith("mov_")
    assert (after["version"], after["stock_on_hand"]) == (2, "2000")
    assert after["stock_on_hand"] == movement["after_quantity"]
    opening = after["permitted_actions"]["opening"]
    assert (opening["allowed"], opening["reason_code"]) == (False, "opening_used")
    assert opening["reason"].strip()
    assert {**after, "permitted_actions": {**after["permitted_actions"], "opening": ALLOWED}} == {
        **ingredient,
        "version": 2,
        "stock_on_hand": "2000",
    }
    assert read_ingredient(staff, ingredient["id"]) == after
    assert movements(staff, ingredient["id"]) == [movement]
    operation = staff.get(f"{API}/operations/{key}").json()
    assert (operation["resource_type"], operation["resource_id"]) == (
        "ingredient",
        ingredient["id"],
    )
    assert operation["result"] == {"http_status": 201, "body": result}
    # A second opening count is refused, with the reason the action gives.
    again = preview_movement(staff, after, movement_input(after, "opening", "5"))
    assert field_paths(again) == {"/type"}


def test_waste_and_corrections_move_stock_and_never_below_zero(staff: TestClient) -> None:
    ingredient = move(staff, new_ingredient(staff), "opening", "2000")["ingredient"]

    wasted = move(staff, ingredient, "waste", "-250.5", reason="Spilled")
    up = move(staff, wasted["ingredient"], "correction", "100.25", reason="Recount")
    down = move(staff, up["ingredient"], "correction", "-1849.75", reason="Recount")

    assert [step["ingredient"]["stock_on_hand"] for step in (wasted, up, down)] == [
        "1749.5",
        "1849.75",
        "0",
    ]
    assert (down["movement"]["before_quantity"], down["movement"]["delta_base_quantity"]) == (
        "1849.75",
        "-1849.75",
    )
    assert down["ingredient"]["version"] == 5
    empty = down["ingredient"]
    for kind, delta in [("waste", "-0.001"), ("correction", "-0.001")]:
        refused = preview_movement(staff, empty, movement_input(empty, kind, delta))
        assert field_paths(refused) == {"/delta_base_quantity"}
    assert move(staff, empty, "correction", "0.001")["ingredient"]["stock_on_hand"] == "0.001"


def test_stock_is_always_the_sum_of_its_movements_newest_first(staff: TestClient) -> None:
    ingredient = move(staff, new_ingredient(staff), "opening", "1000")["ingredient"]
    for kind, delta in [("waste", "-10.5"), ("correction", "3"), ("waste", "-0.125")]:
        ingredient = move(staff, ingredient, kind, delta)["ingredient"]

    history = movements(staff, ingredient["id"])

    assert [row["type"] for row in history] == ["waste", "correction", "waste", "opening"]
    assert [row["delta_base_quantity"] for row in history] == ["-0.125", "3", "-10.5", "1000"]
    # Each movement starts where the one before it ended.
    for newer, older in zip(history, history[1:], strict=False):
        assert newer["before_quantity"] == older["after_quantity"]
    assert history[0]["after_quantity"] == ingredient["stock_on_hand"] == "992.375"
    page = staff.get(f"{API}/ingredients/{ingredient['id']}/movements?limit=3&page=2").json()
    assert ([row["type"] for row in page["items"]], page["total"], page["has_next"]) == (
        ["opening"],
        4,
        False,
    )
    assert field_paths(staff.get(f"{API}/ingredients/{ingredient['id']}/movements?type=waste")) == {
        "/query/type"
    }


def test_a_correction_can_point_at_the_movement_it_corrects(staff: TestClient) -> None:
    flour = move(staff, new_ingredient(staff), "opening", "2000")
    eggs = move(staff, new_ingredient(staff, "Eggs", "piece"), "opening", "12")
    counted = flour["movement"]["id"]

    linked = move(staff, flour["ingredient"], "correction", "-50", corrects_movement_id=counted)
    foreign = preview_movement(
        staff,
        linked["ingredient"],
        movement_input(
            linked["ingredient"], "correction", "-1", corrects_movement_id=eggs["movement"]["id"]
        ),
    )

    assert linked["movement"]["corrects_movement_id"] == counted
    assert linked["movement"]["type"] == "correction"
    assert field_paths(foreign) == {"/corrects_movement_id"}


def test_a_movement_cannot_claim_a_preparation_while_recording_is_off(staff: TestClient) -> None:
    ingredient = move(staff, new_ingredient(staff), "opening", "2000")["ingredient"]
    body = movement_input(ingredient, "waste", "-5", preparation_id="prep_made_up")

    error = error_of(preview_movement(staff, ingredient, body), 422, "validation_failed")

    assert [(field["path"], field["message"]) for field in error["field_errors"]] == [
        ("/preparation_id", "Preparation recording is not enabled.")
    ]


def test_a_save_must_be_exactly_what_was_previewed(staff: TestClient, clock: FakeClock) -> None:
    ingredient = new_ingredient(staff)
    other = new_ingredient(staff, "Sugar")
    body = movement_input(ingredient, "opening", "100")
    preview = preview_movement(staff, ingredient, body).json()
    elsewhere = preview_movement(staff, other, movement_input(other, "opening", "100")).json()

    unknown = save_movement(staff, ingredient, body, {"id": "prev_nowhere"})
    different = save_movement(staff, ingredient, {**body, "delta_base_quantity": "101"}, preview)
    reworded = save_movement(staff, ingredient, {**body, "reason": "Another reason"}, preview)
    borrowed = save_movement(staff, ingredient, body, elsewhere)

    for response in (unknown, different, reworded, borrowed):
        error_of(response, 409, "quote_stale")
    assert movements(staff, ingredient["id"]) == []
    clock.advance(minutes=5)
    error_of(save_movement(staff, ingredient, body, preview), 409, "quote_stale")
    fresh = preview_movement(staff, ingredient, body).json()
    assert save_movement(staff, ingredient, body, fresh).status_code == 201


def test_the_same_quantity_written_differently_is_the_previewed_movement(
    staff: TestClient,
) -> None:
    ingredient = new_ingredient(staff)
    preview = preview_movement(
        staff, ingredient, movement_input(ingredient, "opening", "100")
    ).json()

    rewritten = movement_input(ingredient, "opening", "100.000", reason="  Counted on the shelf ")
    saved = save_movement(staff, ingredient, rewritten, preview)

    assert saved.status_code == 201
    assert saved.json()["movement"]["delta_base_quantity"] == "100"


def test_a_movement_is_refused_when_the_ingredient_changed_after_its_preview(
    staff: TestClient,
) -> None:
    ingredient = move(staff, new_ingredient(staff), "opening", "100")["ingredient"]
    body = movement_input(ingredient, "waste", "-80")
    preview = preview_movement(staff, ingredient, body).json()
    current = move(staff, ingredient, "waste", "-50")["ingredient"]

    late = save_movement(staff, ingredient, body, preview)

    conflict = error_of(late, 409, "version_conflict")
    assert conflict["details"]["latest_resource"] == current
    assert (conflict["details"]["expected_version"], conflict["details"]["current_version"]) == (
        2,
        3,
    )
    assert read_ingredient(staff, ingredient["id"])["stock_on_hand"] == "50"


def test_a_movement_needs_an_operation_key_and_is_recorded_once(staff: TestClient) -> None:
    ingredient = new_ingredient(staff)
    body = movement_input(ingredient, "opening", "100")
    preview = preview_movement(staff, ingredient, body).json()
    request = {**body, "preview_id": preview["id"]}
    path = f"/ingredients/{ingredient['id']}/movements"
    assert field_paths(staff.post(f"{API}{path}", json=request)) == {"/header/Idempotency-Key"}
    key = str(uuid.uuid4())

    first = keyed(staff, "POST", path, request, key)
    again = keyed(staff, "POST", path, request, key)

    assert (first.status_code, again.content) == (201, first.content)
    assert again.headers["Idempotency-Replayed"] == "true"
    assert len(movements(staff, ingredient["id"])) == 1
    assert read_ingredient(staff, ingredient["id"])["stock_on_hand"] == "100"
    # The preview was spent by that save.
    spent = keyed(staff, "POST", path, {**request, "expected_version": 2})
    assert spent.status_code in {409, 422}


def test_movements_of_an_unknown_ingredient_are_not_found(staff: TestClient) -> None:
    body = {**movement_input({"version": 1}, "opening", "100"), "preview_id": "prev_1"}

    error_of(keyed(staff, "POST", "/ingredients/ing_nowhere/movements", body), 404, "not_found")
    error_of(staff.get(f"{API}/ingredients/ing_nowhere/movements"), 404, "not_found")
    error_of(staff.get(f"{API}/ingredients/ing_nowhere/prices"), 404, "not_found")


def test_stock_movements_cannot_be_edited_or_deleted(staff: TestClient) -> None:
    result = move(staff, new_ingredient(staff), "opening", "100")
    ingredient, movement = result["ingredient"], result["movement"]

    for method in ("PATCH", "PUT", "DELETE"):
        for path in (
            f"/ingredients/{ingredient['id']}/movements/{movement['id']}",
            f"/ingredients/{ingredient['id']}/movements",
            f"/ingredients/{ingredient['id']}",
        ):
            if (method, path) == ("PATCH", f"/ingredients/{ingredient['id']}"):
                continue
            response = keyed(staff, method, path, {"delta_base_quantity": "1"})
            assert response.status_code in {404, 405}
    assert movements(staff, ingredient["id"]) == [movement]
