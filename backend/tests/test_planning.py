from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import update

from app.persistence.database import Database
from app.persistence.models import StaffUser, Variant
from tests.inventory_support import move, movements, new_ingredient, read_ingredient
from tests.order_support import cancel, moved_to, read
from tests.preparation_support import (
    ALLOWED,
    allocation,
    cooking,
    open_kitchen,
    order_on,
    plan,
    prepare,
    shopping,
    usage,
    variant,
    write_recipe,
)
from tests.support import API, Cli, FakeClock, error_of, field_paths, keyed, sign_in

PERIOD = "?date_from=2026-10-12&date_to=2026-10-13"


@pytest.fixture
def kitchen(client: TestClient, admin: StaffUser, cli: Cli) -> TestClient:
    """Signed-in staff who can plan; what was cooked is not being recorded yet."""
    return open_kitchen(client, admin, cli, recording=False)


@pytest.fixture
def recording(client: TestClient, admin: StaffUser, cli: Cli) -> TestClient:
    return open_kitchen(client, admin, cli, recording=True)


def stocked(
    client: TestClient, name: str = "Flour", stock: str = "2000", base: str = "g"
) -> dict[str, Any]:
    """An ingredient with that much on the shelf."""
    ingredient = new_ingredient(client, name, base)
    if stock == "0":
        return ingredient
    counted: dict[str, Any] = move(client, ingredient, "opening", stock)["ingredient"]
    return counted


def order_row(order: dict[str, Any], index: int = 0, prepared: int = 0) -> dict[str, Any]:
    item = order["items"][index]
    return {
        "order_id": order["id"],
        "order_version": order["version"],
        "reference": order["reference"],
        "order_item_id": item["id"],
        "status": order["status"],
        "ordered_quantity": item["quantity"],
        "prepared_quantity": prepared,
        "remaining_quantity": item["quantity"] - prepared,
    }


def quantities(row: dict[str, Any]) -> tuple[str, ...]:
    return (
        row["stock_on_hand"],
        row["earlier_demand"],
        row["period_demand"],
        row["stock_after_earlier"],
        row["earlier_shortage"],
        row["period_shortage"],
        row["cumulative_shortage"],
    )


# --- Access and the period -------------------------------------------------------------------


@pytest.mark.parametrize("missing", ["orders", "planning"])
def test_planning_needs_the_orders_and_planning_workflows(
    kitchen: TestClient, cli: Cli, missing: str
) -> None:
    cli("settings", "set", f"--disable={missing}")

    error_of(kitchen.get(f"{API}/planning"), 403, "action_forbidden")
    error_of(kitchen.get(f"{API}/planning/shopping-list"), 403, "action_forbidden")


def test_planning_needs_a_session(kitchen: TestClient, browser: Any) -> None:
    stranger = browser()

    error_of(stranger.get(f"{API}/planning"), 401, "unauthenticated")
    error_of(stranger.get(f"{API}/planning/shopping-list"), 401, "unauthenticated")


def test_with_no_period_the_plan_is_for_the_business_date(kitchen: TestClient) -> None:
    body = plan(kitchen)

    assert body == {
        "id": body["id"],
        "calculated_at": "2026-10-10T19:00:00Z",
        "timezone": "America/Los_Angeles",
        "period": {"date_from": "2026-10-10", "date_to": "2026-10-10"},
        "complete": True,
        "missing": [],
        "foods": [],
        "ingredients": [],
        "permitted_actions": {
            "record_preparation": {
                "allowed": False,
                "reason_code": "preparation_recording_disabled",
                "reason": "Preparation recording is not enabled.",
            }
        },
    }
    assert body["id"].startswith("plan_")
    assert plan(kitchen)["id"] != body["id"]


def test_the_business_date_is_the_one_in_the_business_timezone(
    kitchen: TestClient, clock: FakeClock
) -> None:
    # Eleven at night in Los Angeles is already tomorrow in UTC. The session has run out by
    # then, so staff sign in again.
    clock.advance(hours=11)
    assert sign_in(kitchen).status_code == 200

    assert plan(kitchen)["period"] == {"date_from": "2026-10-10", "date_to": "2026-10-10"}
    clock.advance(hours=1)
    assert sign_in(kitchen).status_code == 200
    assert shopping(kitchen)["period"] == {"date_from": "2026-10-11", "date_to": "2026-10-11"}


@pytest.mark.parametrize(
    ("query", "path"),
    [
        ("?date_from=2026-10-12", "/query/date_to"),
        ("?date_to=2026-10-12", "/query/date_from"),
        ("?date_from=2026-10-13&date_to=2026-10-12", "/query/date_to"),
        ("?date_from=2026-01-01&date_to=2027-01-02", "/query/date_to"),
        ("?date_from=2026-02-30&date_to=2026-03-01", "/query/date_from"),
        ("?date_from=12/10/2026&date_to=2026-10-12", "/query/date_from"),
        ("?date_from=2026-10-12&date_to=soon", "/query/date_to"),
        ("?date_from=2026-10-12&date_to=2026-10-12&page=2", "/query/page"),
        ("?status=confirmed", "/query/status"),
    ],
)
def test_a_period_is_both_dates_in_order_and_at_most_366_days(
    kitchen: TestClient, query: str, path: str
) -> None:
    assert field_paths(kitchen.get(f"{API}/planning{query}")) == {path}
    assert field_paths(kitchen.get(f"{API}/planning/shopping-list{query}")) == {path}


def test_a_period_may_be_one_day_or_366(kitchen: TestClient) -> None:
    year = plan(kitchen, "?date_from=2026-01-01&date_to=2027-01-01")
    day = shopping(kitchen, "?date_from=2026-10-12&date_to=2026-10-12")

    assert year["period"] == {"date_from": "2026-01-01", "date_to": "2027-01-01"}
    assert day["period"] == {"date_from": "2026-10-12", "date_to": "2026-10-12"}


# --- What to cook ----------------------------------------------------------------------------


def test_foods_are_the_lines_fulfilled_in_the_period_one_row_per_variant(
    kitchen: TestClient,
) -> None:
    first = order_on(
        kitchen, "2026-10-12", [("Fresh Lumpia", "Each", 30), ("Beef Caldereta", "Medium", 2)]
    )
    second = order_on(kitchen, "2026-10-13", [("Beef Caldereta", "Medium", 3)], "preparing")
    order_on(kitchen, "2026-10-11", [("Beef Caldereta", "Medium", 7)])
    order_on(kitchen, "2026-10-14", [("Beef Caldereta", "Medium", 9)])

    body = plan(kitchen, PERIOD)

    assert body["period"] == {"date_from": "2026-10-12", "date_to": "2026-10-13"}
    assert body["foods"] == [
        {
            "variant_id": variant(kitchen)["id"],
            "food_name": "Beef Caldereta",
            "variant_label": "Medium",
            "selling_unit": "tray",
            "package_contents": None,
            "ordered_quantity": 5,
            "prepared_quantity": 0,
            "remaining_quantity": 5,
            # Soonest first.
            "orders": [order_row(first, 1), order_row(second)],
        },
        {
            "variant_id": variant(kitchen, "Fresh Lumpia", "Each")["id"],
            "food_name": "Fresh Lumpia",
            "variant_label": "Each",
            "selling_unit": "piece",
            "package_contents": None,
            "ordered_quantity": 30,
            "prepared_quantity": 0,
            "remaining_quantity": 30,
            "orders": [order_row(first, 0)],
        },
    ]


def test_only_confirmed_preparing_and_ready_orders_are_demand(kitchen: TestClient) -> None:
    flour = stocked(kitchen)
    write_recipe(kitchen, variant(kitchen), (flour, "100", "g"))
    wanted = [order_on(kitchen, status=status) for status in ("confirmed", "preparing", "ready")]
    order_on(kitchen, status="pending")
    order_on(kitchen, status="completed")
    moved_to(kitchen, order_on(kitchen), "cancelled")

    body = plan(kitchen, PERIOD)

    (row,) = body["foods"]
    assert [entry["status"] for entry in row["orders"]] == ["confirmed", "preparing", "ready"]
    assert [entry["order_id"] for entry in row["orders"]] == [order["id"] for order in wanted]
    # While nothing is recorded, an order stays in demand in full until it is completed.
    assert (row["ordered_quantity"], row["prepared_quantity"], row["remaining_quantity"]) == (
        15,
        0,
        15,
    )
    assert body["ingredients"][0]["period_demand"] == "1500"


def test_a_package_keeps_its_contents_and_is_counted_in_packages(kitchen: TestClient) -> None:
    order = order_on(kitchen, lines=[("Shanghai Spring Rolls", "100 pieces", 2)])

    (row,) = plan(kitchen, PERIOD)["foods"]

    assert (row["selling_unit"], row["package_contents"]) == (
        "package",
        {"quantity": 100, "unit": "piece"},
    )
    assert (row["ordered_quantity"], row["orders"]) == (2, [order_row(order)])


def test_a_variant_sold_in_two_formats_is_two_rows(kitchen: TestClient, database: Database) -> None:
    medium = variant(kitchen)
    flour = stocked(kitchen)
    write_recipe(kitchen, medium, (flour, "750", "g"))
    by_tray = order_on(kitchen, lines=[("Beef Caldereta", "Medium", 2)])
    # A variant's format is fixed once it has been ordered, so only old data can look like this.
    with database.write() as db:
        db.execute(
            update(Variant)
            .where(Variant.id == medium["id"])
            .values(selling_unit="package", package_quantity=6)
        )
    by_package = order_on(kitchen, lines=[("Beef Caldereta", "Medium", 3)])

    body = plan(kitchen, PERIOD)

    assert [
        (row["variant_id"], row["selling_unit"], row["package_contents"], row["orders"])
        for row in body["foods"]
    ] == [
        (medium["id"], "package", {"quantity": 6, "unit": "piece"}, [order_row(by_package)]),
        (medium["id"], "tray", None, [order_row(by_tray)]),
    ]
    # The recipe was written for a tray: it says nothing about a package of six.
    assert body["ingredients"][0]["period_demand"] == "1500"
    assert [(gap["variant_id"], gap["orders"]) for gap in body["missing"]] == [
        (medium["id"], [{"order_id": by_package["id"], "reference": by_package["reference"]}])
    ]


# --- What that needs -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("stock", "earlier", "period", "expected"),
    [
        # Stock covers the earlier order and part of the period.
        ("2000", 1, 3, ("2000", "750", "2250", "1250", "0", "1000", "1000")),
        # Stock does not even cover what was promised earlier: the deficit stays visible.
        ("500", 2, 1, ("500", "1500", "750", "-1000", "1000", "750", "1750")),
        # Plenty of everything.
        ("5000", 1, 1, ("5000", "750", "750", "4250", "0", "0", "0")),
        # Nothing on the shelf and nothing promised earlier.
        ("0", 0, 2, ("0", "0", "1500", "0", "0", "1500", "1500")),
        # Only earlier commitments: they are still shown, and still short.
        ("100", 1, 0, ("100", "750", "0", "-650", "650", "0", "650")),
        # Exactly enough.
        ("1500", 1, 1, ("1500", "750", "750", "750", "0", "0", "0")),
    ],
)
def test_each_ingredient_shows_stock_demand_and_shortage_by_the_registers_formulas(
    kitchen: TestClient, stock: str, earlier: int, period: int, expected: tuple[str, ...]
) -> None:
    flour = stocked(kitchen, stock=stock)
    write_recipe(kitchen, variant(kitchen), (flour, "750", "g"))
    if earlier:
        # Before the period, overdue included: yesterday's order that was never completed.
        order_on(kitchen, "2026-10-09", [("Beef Caldereta", "Medium", earlier)])
    if period:
        order_on(kitchen, "2026-10-12", [("Beef Caldereta", "Medium", period)])

    (row,) = plan(kitchen, PERIOD)["ingredients"]

    assert row == {
        "ingredient_id": flour["id"],
        "ingredient_name": "Flour",
        "base_unit": "g",
        "stock_on_hand": expected[0],
        "earlier_demand": expected[1],
        "period_demand": expected[2],
        "stock_after_earlier": expected[3],
        "earlier_shortage": expected[4],
        "period_shortage": expected[5],
        "cumulative_shortage": expected[6],
    }


def test_demand_is_the_recipe_times_what_remains_in_base_units(kitchen: TestClient) -> None:
    flour, oil = stocked(kitchen), stocked(kitchen, "Annatto oil", "0", "ml")
    wrappers = stocked(kitchen, "Wrappers", "150", "piece")
    saffron = stocked(kitchen, "Saffron", "1")
    write_recipe(
        kitchen, variant(kitchen), (flour, "0.75", "kg"), (oil, "0.03", "l"), (saffron, "0.5", "g")
    )
    write_recipe(
        kitchen,
        variant(kitchen, "Shanghai Spring Rolls", "100 pieces"),
        (wrappers, "100", "piece"),
        (flour, "200", "g"),
    )
    order_on(
        kitchen, lines=[("Beef Caldereta", "Medium", 3), ("Shanghai Spring Rolls", "100 pieces", 2)]
    )

    body = plan(kitchen, PERIOD)

    # By name, whatever the order of the recipes.
    assert [
        (row["ingredient_name"], row["base_unit"], *quantities(row)) for row in body["ingredients"]
    ] == [
        ("Annatto oil", "ml", "0", "0", "90", "0", "0", "90", "90"),
        ("Flour", "g", "2000", "0", "2650", "2000", "0", "650", "650"),
        ("Saffron", "g", "1", "0", "1.5", "1", "0", "0.5", "0.5"),
        ("Wrappers", "piece", "150", "0", "200", "150", "0", "50", "50"),
    ]
    assert body["complete"] is True


def test_an_order_after_the_period_is_no_commitment_yet(kitchen: TestClient) -> None:
    flour = stocked(kitchen)
    write_recipe(kitchen, variant(kitchen), (flour, "750", "g"))
    order_on(kitchen, "2026-10-14", [("Beef Caldereta", "Medium", 9)])

    body = plan(kitchen, PERIOD)

    assert (body["foods"], body["ingredients"], body["complete"]) == ([], [], True)


def test_demand_too_large_to_state_is_refused_rather_than_wrong(kitchen: TestClient) -> None:
    saffron = stocked(kitchen, "Saffron", "0")
    write_recipe(kitchen, variant(kitchen), (saffron, "9007199254740991", "g"))
    order_on(kitchen, lines=[("Beef Caldereta", "Medium", 2)])

    assert field_paths(kitchen.get(f"{API}/planning{PERIOD}")) == {"/ingredients"}
    assert field_paths(kitchen.get(f"{API}/planning/shopping-list{PERIOD}")) == {"/ingredients"}


def test_planning_moves_no_stock_and_changes_nothing(kitchen: TestClient) -> None:
    flour = stocked(kitchen)
    write_recipe(kitchen, variant(kitchen), (flour, "750", "g"))
    order = order_on(kitchen)

    plan(kitchen, PERIOD)
    shopping(kitchen, PERIOD)

    assert read_ingredient(kitchen, flour["id"]) == flour
    assert len(movements(kitchen, flour["id"])) == 1
    assert read(kitchen, order["id"]) == order


# --- Missing recipes -------------------------------------------------------------------------


def test_a_variant_without_a_recipe_makes_the_plan_incomplete_and_is_named(
    kitchen: TestClient,
) -> None:
    flour = stocked(kitchen)
    write_recipe(kitchen, variant(kitchen), (flour, "750", "g"))
    mixed = order_on(
        kitchen, lines=[("Beef Caldereta", "Medium", 2), ("Beef Caldereta", "Small", 1)]
    )
    again = order_on(kitchen, "2026-10-13", [("Beef Caldereta", "Small", 4)])
    overdue = order_on(kitchen, "2026-10-09", [("Beef Caldereta", "Large", 1)])
    small, large = variant(kitchen, label="Small"), variant(kitchen, label="Large")
    food_id = kitchen.get(f"{API}/foods?q=caldereta").json()["items"][0]["id"]

    body = plan(kitchen, PERIOD)

    assert body["complete"] is False
    assert body["missing"] == [
        {
            "code": "recipe_missing",
            "variant_id": large["id"],
            "food_id": food_id,
            "food_name": "Beef Caldereta",
            "variant_label": "Large",
            # An earlier commitment without a recipe hides demand just as much.
            "orders": [{"order_id": overdue["id"], "reference": overdue["reference"]}],
        },
        {
            "code": "recipe_missing",
            "variant_id": small["id"],
            "food_id": food_id,
            "food_name": "Beef Caldereta",
            "variant_label": "Small",
            "orders": [
                {"order_id": mixed["id"], "reference": mixed["reference"]},
                {"order_id": again["id"], "reference": again["reference"]},
            ],
        },
    ]
    # What is known is still worked out: a lower bound, and the demand itself stays visible.
    assert [row["variant_label"] for row in body["foods"]] == ["Medium", "Small"]
    assert quantities(body["ingredients"][0])[2] == "1500"


def test_a_recipe_written_for_another_format_does_not_count(kitchen: TestClient) -> None:
    medium = variant(kitchen)
    flour = stocked(kitchen)
    write_recipe(kitchen, medium, (flour, "750", "g"))
    as_package = {
        "expected_version": 1,
        "selling_unit": "package",
        "package_contents": {"quantity": 6, "unit": "piece"},
    }
    assert keyed(kitchen, "PATCH", f"/variants/{medium['id']}", as_package).status_code == 200
    order = order_on(kitchen, lines=[("Beef Caldereta", "Medium", 2)])

    body = plan(kitchen, PERIOD)

    assert (body["complete"], body["ingredients"]) == (False, [])
    assert [(gap["variant_id"], gap["orders"]) for gap in body["missing"]] == [
        (medium["id"], [{"order_id": order["id"], "reference": order["reference"]}])
    ]


# --- With preparation recorded ---------------------------------------------------------------


def test_recorded_preparation_leaves_only_what_remains_in_demand(recording: TestClient) -> None:
    flour = stocked(recording)
    write_recipe(recording, variant(recording), (flour, "100", "g"))
    order = order_on(recording)
    assert plan(recording, PERIOD)["permitted_actions"] == {"record_preparation": ALLOWED}

    done = prepare(recording, cooking([allocation(order, 2)], [usage(flour, "200")]))
    order = done["orders"][0]

    for status in ("confirmed", "preparing"):
        order = moved_to(recording, order, status)
        body = plan(recording, PERIOD)
        (row,) = body["foods"]
        assert row["orders"] == [order_row(order, prepared=2)]
        assert (row["ordered_quantity"], row["prepared_quantity"], row["remaining_quantity"]) == (
            5,
            2,
            3,
        )
        # What was used is gone from the shelf, and only the three left to cook are wanted:
        # the two that are done are not counted against stock a second time.
        assert quantities(body["ingredients"][0]) == ("1800", "0", "300", "1800", "0", "0", "0")


def test_a_fully_prepared_line_is_still_listed_but_wants_nothing(recording: TestClient) -> None:
    order = order_on(recording, lines=[("Beef Caldereta", "Small", 2)])

    done = prepare(recording, cooking([allocation(order, 2)], [], "Used what was left over"))

    body = plan(recording, PERIOD)
    (row,) = body["foods"]
    assert (row["prepared_quantity"], row["remaining_quantity"]) == (2, 0)
    assert row["orders"] == [order_row(done["orders"][0], prepared=2)]
    # Nothing is left to cook, so the missing recipe hides nothing.
    assert (body["complete"], body["missing"], body["ingredients"]) == (True, [], [])


def test_a_cancelled_order_loses_its_demand_but_the_stock_stays_used(recording: TestClient) -> None:
    flour = stocked(recording)
    write_recipe(recording, variant(recording), (flour, "100", "g"))
    order = prepare(
        recording, cooking([allocation(order_on(recording), 2)], [usage(flour, "200")])
    )["orders"][0]

    assert cancel(recording, order, acknowledge_consumed_stock=True).status_code == 200

    body = plan(recording, PERIOD)
    assert (body["foods"], body["ingredients"]) == ([], [])
    assert read_ingredient(recording, flour["id"])["stock_on_hand"] == "1800"


# --- The shopping list -----------------------------------------------------------------------


def test_the_shopping_list_is_what_stock_cannot_cover_through_the_period(
    kitchen: TestClient,
) -> None:
    flour, salt = stocked(kitchen), stocked(kitchen, "Salt", "5000")
    oil = stocked(kitchen, "Annatto oil", "0", "ml")
    write_recipe(
        kitchen, variant(kitchen), (flour, "750", "g"), (salt, "20", "g"), (oil, "30", "ml")
    )
    order_on(kitchen, "2026-10-09", [("Beef Caldereta", "Medium", 1)])
    order_on(kitchen, "2026-10-12", [("Beef Caldereta", "Medium", 3)])
    lumpia = order_on(kitchen, "2026-10-12", [("Fresh Lumpia", "Each", 10)])

    body = shopping(kitchen, PERIOD)

    assert body == {
        "id": body["id"],
        "calculated_at": "2026-10-10T19:00:00Z",
        "timezone": "America/Los_Angeles",
        "period": {"date_from": "2026-10-12", "date_to": "2026-10-13"},
        "complete": False,
        "missing": plan(kitchen, PERIOD)["missing"],
        # Name ascending; salt is covered, so it is not on the list.
        "items": [
            {
                "ingredient_id": oil["id"],
                "ingredient_name": "Annatto oil",
                "base_unit": "ml",
                "stock_on_hand": "0",
                "earlier_demand": "30",
                "period_demand": "90",
                "cumulative_shortage": "120",
            },
            {
                "ingredient_id": flour["id"],
                "ingredient_name": "Flour",
                "base_unit": "g",
                "stock_on_hand": "2000",
                "earlier_demand": "750",
                "period_demand": "2250",
                "cumulative_shortage": "1000",
            },
        ],
    }
    assert [gap["orders"] for gap in body["missing"]] == [
        [{"order_id": lumpia["id"], "reference": lumpia["reference"]}]
    ]


def test_an_empty_shopping_list_is_complete(kitchen: TestClient) -> None:
    body = shopping(kitchen)

    assert (body["complete"], body["missing"], body["items"]) == (True, [], [])
    assert set(body) == {
        "id",
        "calculated_at",
        "timezone",
        "period",
        "complete",
        "missing",
        "items",
    }
