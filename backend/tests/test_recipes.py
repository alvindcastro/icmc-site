from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.persistence.models import StaffUser
from tests.inventory_support import buy, line, new_ingredient, receipt
from tests.support import API, Cli, FakeClock, error_of, field_paths, keyed, sign_in

RECIPE_SETTINGS = [
    "settings",
    "set",
    "--currency=USD",
    "--minor-digits=2",
    "--timezone=America/Los_Angeles",
    "--fulfillment=pickup",
    "--enable=menu",
    "--enable=inventory",
    "--enable=purchases",
    "--enable=recipes",
]


@pytest.fixture
def staff(client: TestClient, admin: StaffUser, cli: Cli) -> TestClient:
    """Signed-in staff with the menu, the stockroom and recipes enabled, and the seeded menu."""
    assert cli(*RECIPE_SETTINGS) == 0
    assert cli("menu", "seed") == 0
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
    return client


def variant(
    client: TestClient, food: str = "Beef Caldereta", label: str = "Medium"
) -> dict[str, Any]:
    foods = client.get(f"{API}/foods?limit=100").json()["items"]
    found: dict[str, Any] = next(
        item
        for entry in foods
        if entry["name"] == food
        for item in entry["variants"]
        if item["label"] == label
    )
    return found


def yield_of(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "quantity": 1,
        "selling_unit": item["selling_unit"],
        "package_contents": item["package_contents"],
    }


def rows(*items: tuple[dict[str, Any], str, str]) -> list[dict[str, Any]]:
    return [
        {"ingredient_id": ingredient["id"], "quantity": quantity, "unit": unit}
        for ingredient, quantity, unit in items
    ]


def put(
    client: TestClient,
    item: dict[str, Any],
    items: list[dict[str, Any]],
    expected_version: Any = None,
    written_for: dict[str, Any] | None = None,
) -> Any:
    body = {
        "expected_version": expected_version,
        "yield": written_for or yield_of(item),
        "items": items,
    }
    return client.put(f"{API}/variants/{item['id']}/recipe", json=body)


def saved(
    client: TestClient, item: dict[str, Any], *items: tuple[dict[str, Any], str, str]
) -> dict[str, Any]:
    response = put(client, item, rows(*items))
    assert response.status_code == 201, response.text
    recipe: dict[str, Any] = response.json()
    return recipe


def estimate(client: TestClient, item: dict[str, Any]) -> dict[str, Any]:
    response = client.get(f"{API}/variants/{item['id']}/estimate")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


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


# --- Access ----------------------------------------------------------------------------------


@pytest.mark.parametrize("missing", ["menu", "inventory", "recipes"])
def test_recipes_need_the_menu_the_stockroom_and_the_recipes_workflow(
    client: TestClient, admin: StaffUser, cli: Cli, missing: str
) -> None:
    cli(*RECIPE_SETTINGS)
    cli("menu", "seed")
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
    medium = variant(client)
    cli("settings", "set", f"--disable={missing}")

    for path in ["recipe", "estimate"]:
        error_of(client.get(f"{API}/variants/{medium['id']}/{path}"), 403, "action_forbidden")
    error_of(put(client, medium, []), 403, "action_forbidden")


def test_recipes_need_a_session_and_the_csrf_token(staff: TestClient, browser: Any) -> None:
    medium = variant(staff)
    stranger = browser()

    error_of(stranger.get(f"{API}/variants/{medium['id']}/recipe"), 401, "unauthenticated")
    error_of(stranger.get(f"{API}/variants/{medium['id']}/estimate"), 401, "unauthenticated")
    error_of(put(stranger, medium, []), 403, "csrf_invalid")


def test_a_live_system_needs_currency_and_timezone_confirmed(staff: TestClient, cli: Cli) -> None:
    medium = variant(staff)
    cli("settings", "set", "--environment=live")

    refused = error_of(
        staff.get(f"{API}/variants/{medium['id']}/estimate"), 409, "settings_unconfirmed"
    )
    assert refused["details"] == {"unconfirmed": ["currency", "timezone"]}

    cli("settings", "confirm", "currency", "timezone")
    assert estimate(staff, medium)["complete"] is False


# --- Saving a recipe -------------------------------------------------------------------------


def test_a_new_recipe_describes_one_selling_unit_and_marks_the_variant(
    staff: TestClient, clock: FakeClock
) -> None:
    medium = variant(staff)
    flour, oil = new_ingredient(staff), new_ingredient(staff, "Annatto oil", "ml")
    error_of(staff.get(f"{API}/variants/{medium['id']}/recipe"), 404, "not_found")

    response = put(staff, medium, rows((flour, "0.75", "kg"), (oil, "30", "ml")))

    assert response.status_code == 201
    recipe = response.json()
    assert recipe == {
        "id": recipe["id"],
        "version": 1,
        "variant_id": medium["id"],
        "yield": {"quantity": 1, "selling_unit": "tray", "package_contents": None},
        "items": [
            {
                "ingredient_id": flour["id"],
                "ingredient_name": "Flour",
                "base_unit": "g",
                "quantity": "0.75",
                "unit": "kg",
            },
            {
                "ingredient_id": oil["id"],
                "ingredient_name": "Annatto oil",
                "base_unit": "ml",
                "quantity": "30",
                "unit": "ml",
            },
        ],
        "recorded_at": "2026-10-10T19:00:00Z",
        "updated_at": "2026-10-10T19:00:00Z",
    }
    assert recipe["id"].startswith("rec_")
    assert staff.get(f"{API}/variants/{medium['id']}/recipe").json() == recipe
    # The variant now points at its recipe, and that is not an edit of the variant.
    assert variant(staff) == {**medium, "recipe_id": recipe["id"]}


def test_a_package_recipe_covers_the_whole_package(staff: TestClient) -> None:
    package = variant(staff, "Shanghai Spring Rolls", "100 pieces")
    wrappers = new_ingredient(staff, "Wrappers", "piece")

    recipe = saved(staff, package, (wrappers, "100", "piece"))

    assert recipe["yield"] == {
        "quantity": 1,
        "selling_unit": "package",
        "package_contents": {"quantity": 100, "unit": "piece"},
    }


def test_an_edit_replaces_the_rows_and_advances_the_version_once(
    staff: TestClient, clock: FakeClock
) -> None:
    medium = variant(staff)
    flour, oil = new_ingredient(staff), new_ingredient(staff, "Annatto oil", "ml")
    first = saved(staff, medium, (flour, "750", "g"))
    clock.advance(minutes=4)

    response = put(staff, medium, rows((oil, "0.03", "l"), (flour, "800", "g")), 1)

    assert response.status_code == 200
    recipe = response.json()
    assert (recipe["id"], recipe["version"]) == (first["id"], 2)
    assert [(row["ingredient_name"], row["quantity"], row["unit"]) for row in recipe["items"]] == [
        ("Annatto oil", "0.03", "l"),
        ("Flour", "800", "g"),
    ]
    assert (recipe["recorded_at"], recipe["updated_at"]) == (
        "2026-10-10T19:00:00Z",
        "2026-10-10T19:04:00Z",
    )
    assert staff.get(f"{API}/variants/{medium['id']}/recipe").json() == recipe
    assert variant(staff) == {**medium, "recipe_id": first["id"]}


def test_a_recipe_shows_an_ingredient_under_its_current_name(staff: TestClient) -> None:
    medium = variant(staff)
    flour = new_ingredient(staff)
    saved(staff, medium, (flour, "750", "g"))

    keyed(staff, "PATCH", f"/ingredients/{flour['id']}", {"expected_version": 1, "name": "Rye"})

    recipe = staff.get(f"{API}/variants/{medium['id']}/recipe").json()
    assert (recipe["items"][0]["ingredient_name"], recipe["version"]) == ("Rye", 1)


@pytest.mark.parametrize(
    ("changes", "path"),
    [
        ({"expected_version": 1}, "/expected_version"),
        ({"expected_version": 0}, "/expected_version"),
        ({"expected_version": "1"}, "/expected_version"),
        ({"expected_version": ...}, "/expected_version"),
        ({"yield": {"quantity": 1, "selling_unit": "piece", "package_contents": None}}, "/yield"),
        ({"yield": {"quantity": 2, "selling_unit": "tray", "package_contents": None}}, "/yield"),
        (
            {
                "yield": {
                    "quantity": 1,
                    "selling_unit": "tray",
                    "package_contents": {"quantity": 6, "unit": "piece"},
                }
            },
            "/yield",
        ),
        ({"yield": {"quantity": 1, "selling_unit": "tray"}}, "/yield"),
        ({"yield": None}, "/yield"),
        ({"yield": "one tray"}, "/yield"),
        ({"yield": ...}, "/yield"),
        ({"items": []}, "/items"),
        ({"items": ...}, "/items"),
        ({"items": None}, "/items"),
        ({"recipe_id": "rec_1"}, "/recipe_id"),
        ({"variant_id": "var_1"}, "/variant_id"),
    ],
)
def test_a_malformed_recipe_is_refused_at_the_field(
    staff: TestClient, changes: dict[str, Any], path: str
) -> None:
    medium = variant(staff)
    flour = new_ingredient(staff)

    body: dict[str, Any] = {
        "expected_version": None,
        "yield": yield_of(medium),
        "items": rows((flour, "750", "g")),
    }
    for name, value in changes.items():
        if value is ...:
            del body[name]
        else:
            body[name] = value

    refused = staff.put(f"{API}/variants/{medium['id']}/recipe", json=body)

    assert field_paths(refused) == {path}
    error_of(staff.get(f"{API}/variants/{medium['id']}/recipe"), 404, "not_found")


@pytest.mark.parametrize(
    ("quantity", "unit", "path"),
    [
        ("0", "g", "quantity"),
        ("-1", "g", "quantity"),
        ("1.2345", "g", "quantity"),
        ("1e3", "g", "quantity"),
        ("lots", "g", "quantity"),
        (750, "g", "quantity"),
        ("9007199254740992", "g", "quantity"),
        ("9007199254740991", "kg", "quantity"),
        ("750", "ml", "unit"),
        ("1", "l", "unit"),
        ("2", "piece", "unit"),
        ("1", "bag", "unit"),
        ("1", "cup", "unit"),
    ],
)
def test_a_row_must_be_a_positive_quantity_in_a_unit_of_its_ingredient(
    staff: TestClient, quantity: Any, unit: str, path: str
) -> None:
    medium = variant(staff)
    flour = new_ingredient(staff)

    refused = put(
        staff, medium, [{"ingredient_id": flour["id"], "quantity": quantity, "unit": unit}]
    )

    assert field_paths(refused) == {f"/items/0/{path}"}


def test_rows_name_known_ingredients_once_each_in_whole_pieces(staff: TestClient) -> None:
    medium = variant(staff)
    flour, eggs = new_ingredient(staff), new_ingredient(staff, "Eggs", "piece")
    good = {"ingredient_id": flour["id"], "quantity": "750", "unit": "g"}

    unknown = put(staff, medium, [{**good, "ingredient_id": "ing_nowhere"}])
    repeated = put(staff, medium, [good, {**good, "quantity": "1"}])
    halves = put(staff, medium, [{"ingredient_id": eggs["id"], "quantity": "2.5", "unit": "piece"}])
    extra = put(staff, medium, [{**good, "unit_cost": "0.010000000"}])
    several = put(
        staff,
        medium,
        [good, {**good, "ingredient_id": "ing_nowhere"}, {**good, "quantity": "0"}],
    )

    assert field_paths(unknown) == {"/items/0/ingredient_id"}
    assert field_paths(repeated) == {"/items/1/ingredient_id"}
    assert field_paths(halves) == {"/items/0/quantity"}
    assert field_paths(extra) == {"/items/0/unit_cost"}
    assert field_paths(several) == {"/items/1/ingredient_id", "/items/2/ingredient_id"}
    error_of(staff.get(f"{API}/variants/{medium['id']}/recipe"), 404, "not_found")


def test_a_recipe_has_one_to_a_hundred_rows(staff: TestClient) -> None:
    medium = variant(staff)
    many = [new_ingredient(staff, f"Spice {number}") for number in range(101)]

    too_many = put(staff, medium, rows(*((item, "1", "g") for item in many)))
    hundred = put(staff, medium, rows(*((item, "1", "g") for item in many[:100])))

    assert field_paths(too_many) == {"/items"}
    assert (hundred.status_code, len(hundred.json()["items"])) == (201, 100)


def test_recipes_of_unknown_variants_are_not_found(staff: TestClient) -> None:
    flour = new_ingredient(staff)
    ghost = {"id": "var_nowhere", "selling_unit": "tray", "package_contents": None}

    error_of(staff.get(f"{API}/variants/var_nowhere/recipe"), 404, "not_found")
    error_of(staff.get(f"{API}/variants/var_nowhere/estimate"), 404, "not_found")
    error_of(put(staff, ghost, rows((flour, "750", "g"))), 404, "not_found")


def test_a_second_creation_or_a_stale_edit_gets_the_latest_recipe_and_changes_nothing(
    staff: TestClient,
) -> None:
    medium = variant(staff)
    flour = new_ingredient(staff)
    first = saved(staff, medium, (flour, "750", "g"))

    raced = put(staff, medium, rows((flour, "900", "g")))
    conflict = error_of(raced, 409, "version_conflict")
    assert conflict["details"] == {
        "resource_type": "recipe",
        "resource_id": first["id"],
        "expected_version": None,
        "current_version": 1,
        "latest_resource": first,
    }

    second = put(staff, medium, rows((flour, "800", "g")), 1).json()
    stale = error_of(put(staff, medium, rows((flour, "900", "g")), 1), 409, "version_conflict")
    assert (stale["details"]["expected_version"], stale["details"]["current_version"]) == (1, 2)
    assert stale["details"]["latest_resource"] == second
    # The same save sent twice cannot apply twice: the second is simply stale.
    assert staff.get(f"{API}/variants/{medium['id']}/recipe").json() == second


def test_a_recipe_takes_no_query_parameters(staff: TestClient) -> None:
    medium = variant(staff)
    at = f"{API}/variants/{medium['id']}"

    assert field_paths(staff.get(f"{at}/recipe?version=1")) == {"/query/version"}
    assert field_paths(staff.get(f"{at}/estimate?as_of=2026-10-01")) == {"/query/as_of"}


# --- Estimates -------------------------------------------------------------------------------


def test_750_grams_of_flour_bought_at_2400_for_2_kg_costs_900(
    staff: TestClient, clock: FakeClock
) -> None:
    medium = variant(staff)
    flour = bought(staff)
    saved(staff, medium, (flour, "750", "g"))
    clock.advance(minutes=1)

    body = estimate(staff, medium)

    assert body == {
        "variant_id": medium["id"],
        "recipe_version": 1,
        "currency": "USD",
        "selling_price_minor": 8000,
        "ingredient_cost_minor": 900,
        "ingredient_contribution_minor": 7100,
        "complete": True,
        "missing": [],
        "basis": [
            {
                "ingredient_id": flour["id"],
                "ingredient_name": "Flour",
                "base_unit": "g",
                "base_quantity": "750",
                "purchase_id": flour["purchase"]["id"],
                "purchase_line_id": flour["purchase"]["items"][0]["id"],
                "purchased_on": "2026-10-07",
                "unit_cost": "0.012000000",
                "estimated_cost": "9.000000000",
            }
        ],
        "calculated_at": "2026-10-10T19:01:00Z",
    }


def test_without_a_recipe_the_estimate_is_incomplete_not_zero(staff: TestClient) -> None:
    medium = variant(staff)

    body = estimate(staff, medium)

    assert (body["complete"], body["recipe_version"], body["basis"]) == (False, None, [])
    assert (body["ingredient_cost_minor"], body["ingredient_contribution_minor"]) == (None, None)
    assert body["missing"] == [
        {"code": "recipe_missing", "ingredient_id": None, "variant_id": medium["id"]}
    ]
    assert body["selling_price_minor"] == 8000


def test_an_unpriced_ingredient_leaves_the_estimate_incomplete(staff: TestClient) -> None:
    medium = variant(staff)
    flour, salt = bought(staff), new_ingredient(staff, "Salt")
    saved(staff, medium, (salt, "20", "g"), (flour, "750", "g"))

    body = estimate(staff, medium)

    assert (body["complete"], body["recipe_version"]) == (False, 1)
    assert (body["ingredient_cost_minor"], body["ingredient_contribution_minor"]) == (None, None)
    assert body["missing"] == [
        {"code": "price_missing", "ingredient_id": salt["id"], "variant_id": medium["id"]}
    ]
    unpriced, priced = body["basis"]
    assert unpriced == {
        "ingredient_id": salt["id"],
        "ingredient_name": "Salt",
        "base_unit": "g",
        "base_quantity": "20",
        "purchase_id": None,
        "purchase_line_id": None,
        "purchased_on": None,
        "unit_cost": None,
        "estimated_cost": None,
    }
    # What is known is still shown, in recipe order.
    assert (priced["ingredient_name"], priced["estimated_cost"]) == ("Flour", "9.000000000")


def test_an_ingredient_bought_for_nothing_is_priced_at_zero_not_unknown(staff: TestClient) -> None:
    medium = variant(staff)
    herbs = bought(staff, "Garden herbs", cost=0)
    saved(staff, medium, (herbs, "50", "g"))

    body = estimate(staff, medium)

    assert (body["complete"], body["ingredient_cost_minor"], body["missing"]) == (True, 0, [])
    assert body["ingredient_contribution_minor"] == 8000
    assert (body["basis"][0]["unit_cost"], body["basis"][0]["estimated_cost"]) == (
        "0.000000000",
        "0.000000000",
    )


def test_the_total_is_rounded_once_from_the_exact_row_amounts(staff: TestClient) -> None:
    medium = variant(staff)
    # Each row comes to exactly half a cent: 500 g of something bought at 1 cent per kg.
    first, second = (
        bought(staff, "Salt", cost=1, quantity="1"),
        bought(staff, "Sugar", cost=1, quantity="1"),
    )
    saved(staff, medium, (first, "500", "g"))

    half = estimate(staff, medium)
    put(staff, medium, rows((first, "500", "g"), (second, "500", "g")), 1)
    whole = estimate(staff, medium)
    put(staff, medium, rows((first, "400", "g")), 2)
    under = estimate(staff, medium)

    assert (half["basis"][0]["estimated_cost"], half["ingredient_cost_minor"]) == ("0.005000000", 1)
    # Two halves make one cent. Rounding each row first would have made two.
    assert whole["ingredient_cost_minor"] == 1
    assert (under["basis"][0]["estimated_cost"], under["ingredient_cost_minor"]) == (
        "0.004000000",
        0,
    )


def test_a_row_is_costed_from_the_receipts_exact_total_not_the_displayed_unit_cost(
    staff: TestClient,
) -> None:
    medium = variant(staff)
    # 3 kg for 10.00 is shown as 0.003333333 per gram, which is a little too low.
    flour = bought(staff, cost=1000, quantity="3")
    saved(staff, medium, (flour, "150000", "kg"))

    body = estimate(staff, medium)

    assert body["basis"][0]["unit_cost"] == "0.003333333"
    assert body["basis"][0]["estimated_cost"] == "500000.000000000"
    # From the displayed unit cost this would have been 49999995.
    assert body["ingredient_cost_minor"] == 50_000_000
    assert body["ingredient_contribution_minor"] == 8000 - 50_000_000


def test_rows_in_larger_units_and_in_pieces_are_costed_in_base_units(staff: TestClient) -> None:
    package = variant(staff, "Shanghai Spring Rolls", "100 pieces")
    flour = bought(staff)
    oil = bought(staff, "Oil", cost=900, quantity="1", unit="l", base="ml")
    wrappers = bought(staff, "Wrappers", cost=600, quantity="200", unit="piece", base="piece")
    saved(staff, package, (flour, "0.5", "kg"), (oil, "0.25", "l"), (wrappers, "100", "piece"))

    body = estimate(staff, package)

    assert [
        (row["base_quantity"], row["base_unit"], row["estimated_cost"]) for row in body["basis"]
    ] == [
        ("500", "g", "6.000000000"),
        ("250", "ml", "2.250000000"),
        ("100", "piece", "3.000000000"),
    ]
    assert (body["ingredient_cost_minor"], body["ingredient_contribution_minor"]) == (1125, 4375)


def test_the_estimate_follows_the_latest_purchase_basis_and_the_selling_price(
    staff: TestClient, clock: FakeClock
) -> None:
    medium = variant(staff)
    flour = bought(staff)
    saved(staff, medium, (flour, "750", "g"))
    assert estimate(staff, medium)["ingredient_cost_minor"] == 900

    clock.advance(minutes=1)
    buy(staff, receipt(line(flour, "1", "kg", 500), on="2026-10-01"))
    assert estimate(staff, medium)["ingredient_cost_minor"] == 900

    clock.advance(minutes=1)
    newer = buy(staff, receipt(line(flour, "1", "kg", 2000), on="2026-10-09"))["purchase"]
    after = estimate(staff, medium)
    assert (after["ingredient_cost_minor"], after["basis"][0]["purchase_id"]) == (1500, newer["id"])
    assert after["basis"][0]["purchased_on"] == "2026-10-09"

    keyed(staff, "PATCH", f"/variants/{medium['id']}", {"expected_version": 1, "price_minor": 1000})
    repriced = estimate(staff, medium)
    # Costing more than it sells for is reported as it is.
    assert (repriced["selling_price_minor"], repriced["ingredient_contribution_minor"]) == (
        1000,
        -500,
    )
    assert repriced["complete"] is True


def test_amounts_use_the_settings_decimal_places(staff: TestClient, cli: Cli) -> None:
    cli("settings", "set", "--currency=JPY", "--minor-digits=0")
    medium = variant(staff)
    flour = bought(staff, cost=500, quantity="1")
    saved(staff, medium, (flour, "500", "g"))

    body = estimate(staff, medium)

    assert (body["currency"], body["ingredient_cost_minor"]) == ("JPY", 250)
    assert (body["basis"][0]["unit_cost"], body["basis"][0]["estimated_cost"]) == (
        "0.500000000",
        "250.000000000",
    )


def test_a_purchase_in_another_currency_is_not_a_price(staff: TestClient, cli: Cli) -> None:
    medium = variant(staff)
    flour = bought(staff)
    saved(staff, medium, (flour, "750", "g"))
    cli("settings", "set", "--currency=JPY", "--minor-digits=0")

    body = estimate(staff, medium)

    # 2400 US cents are not 2400 yen: without a purchase in yen there is no figure to give.
    assert (body["currency"], body["complete"], body["ingredient_cost_minor"]) == (
        "JPY",
        False,
        None,
    )
    assert body["missing"] == [
        {"code": "price_missing", "ingredient_id": flour["id"], "variant_id": medium["id"]}
    ]
    assert (body["basis"][0]["purchase_id"], body["basis"][0]["unit_cost"]) == (None, None)

    buy(staff, receipt(line(flour, "1", "kg", 400), on="2026-10-09"))
    assert estimate(staff, medium)["ingredient_cost_minor"] == 300


def test_a_recipe_written_for_another_selling_format_no_longer_counts(staff: TestClient) -> None:
    medium = variant(staff)
    flour = bought(staff)
    recipe = saved(staff, medium, (flour, "750", "g"))
    as_package = {
        "expected_version": 1,
        "selling_unit": "package",
        "package_contents": {"quantity": 6, "unit": "piece"},
    }
    assert keyed(staff, "PATCH", f"/variants/{medium['id']}", as_package).status_code == 200
    changed = variant(staff)

    body = estimate(staff, changed)

    assert (body["complete"], body["recipe_version"], body["basis"]) == (False, 1, [])
    assert body["missing"] == [
        {"code": "recipe_missing", "ingredient_id": None, "variant_id": medium["id"]}
    ]
    # The recipe is still on record as it was written, for one tray.
    assert staff.get(f"{API}/variants/{medium['id']}/recipe").json() == recipe
    old_format = put(staff, changed, rows((flour, "750", "g")), 1, written_for=recipe["yield"])
    assert field_paths(old_format) == {"/yield"}

    rewritten = put(staff, changed, rows((flour, "600", "g")), 1)
    assert (rewritten.status_code, rewritten.json()["yield"]) == (200, yield_of(changed))
    assert estimate(staff, changed)["ingredient_cost_minor"] == 720


def test_an_estimate_too_large_to_state_is_refused_rather_than_wrong(staff: TestClient) -> None:
    medium = variant(staff)
    # A thousandth of a gram for the largest amount there is, and a recipe wanting a kilogram.
    saffron = bought(staff, "Saffron", cost=9007199254740991, quantity="0.001", unit="g")
    saved(staff, medium, (saffron, "1", "kg"))

    refused = staff.get(f"{API}/variants/{medium['id']}/estimate")

    assert field_paths(refused) == {"/ingredient_cost_minor"}
