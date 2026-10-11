from dataclasses import dataclass
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.persistence.models import StaffUser
from app.services import inventory
from tests.inventory_support import (
    buy,
    line,
    move,
    movement_input,
    movements,
    new_ingredient,
    preview_movement,
    read_ingredient,
    receipt,
)
from tests.order_support import (
    as_saved,
    ask,
    cancel,
    change,
    draft,
    moved_to,
    quoted,
    read,
    revise,
    step,
)
from tests.preparation_support import (
    ALLOWED,
    RECORDING,
    TODAY,
    allocation,
    bought,
    cooking,
    open_kitchen,
    order_on,
    prepare,
    preview_preparation,
    read_preparation,
    save_preparation,
    usage,
    variant,
    write_recipe,
)
from tests.support import API, Cli, FakeClock, error_of, field_paths, keyed


@pytest.fixture
def recording(client: TestClient, admin: StaffUser, cli: Cli) -> TestClient:
    """Signed-in staff in a kitchen that records what it cooks."""
    return open_kitchen(client, admin, cli, recording=True)


@dataclass
class Scene:
    """Two kilograms of flour bought for 24.00, a recipe that uses it, and five trays ordered."""

    client: TestClient
    flour: dict[str, Any]
    recipe: dict[str, Any]
    order: dict[str, Any]

    def cooking(
        self, trays: Any = 2, flour: Any = "1.5", unit: str = "kg", note: str = ""
    ) -> dict[str, Any]:
        return cooking([allocation(self.order, trays)], [usage(self.flour, flour, unit)], note)


@pytest.fixture
def scene(recording: TestClient) -> Scene:
    flour = bought(recording)
    recipe = write_recipe(recording, variant(recording), (flour, "750", "g"))
    return Scene(recording, flour, recipe, order_on(recording))


def reviewed(client: TestClient, body: dict[str, Any]) -> dict[str, Any]:
    response = preview_preparation(client, body)
    assert response.status_code == 200, response.text
    preview: dict[str, Any] = response.json()
    return preview


def counts(order: dict[str, Any]) -> list[tuple[int | None, int | None]]:
    return [(item["prepared_quantity"], item["remaining_quantity"]) for item in order["items"]]


# --- Access ----------------------------------------------------------------------------------


@pytest.mark.parametrize("missing", ["orders", "planning", "inventory", "preparation_recording"])
def test_recording_needs_orders_planning_the_stockroom_and_the_recording_workflow(
    recording: TestClient, cli: Cli, missing: str
) -> None:
    cli("settings", "set", f"--disable={missing}")

    error_of(recording.post(f"{API}/preparations/preview", json={}), 403, "action_forbidden")
    error_of(keyed(recording, "POST", "/preparations", {}), 403, "action_forbidden")
    error_of(recording.get(f"{API}/preparations/prep_1"), 403, "action_forbidden")
    error_of(recording.get(f"{API}/preparations/prep_1/corrections"), 403, "action_forbidden")
    error_of(
        recording.post(f"{API}/preparations/prep_1/correction-preview", json={}),
        403,
        "action_forbidden",
    )
    error_of(
        keyed(recording, "POST", "/preparations/prep_1/corrections", {}), 403, "action_forbidden"
    )


def test_recording_needs_a_session_and_the_csrf_token(recording: TestClient, browser: Any) -> None:
    stranger = browser()

    error_of(stranger.get(f"{API}/preparations/prep_1"), 401, "unauthenticated")
    error_of(stranger.post(f"{API}/preparations/preview", json={}), 403, "csrf_invalid")
    error_of(keyed(stranger, "POST", "/preparations", {}), 403, "csrf_invalid")


def test_a_live_kitchen_needs_currency_and_timezone_confirmed(
    recording: TestClient, cli: Cli
) -> None:
    cli("settings", "set", "--environment=live")

    refused = error_of(recording.get(f"{API}/preparations/prep_1"), 409, "settings_unconfirmed")
    assert refused["details"] == {"unconfirmed": ["currency", "timezone"]}

    cli("settings", "confirm", "currency", "timezone")
    error_of(recording.get(f"{API}/preparations/prep_1"), 404, "not_found")


def test_a_preparation_takes_no_query_parameters_and_must_exist(recording: TestClient) -> None:
    error_of(recording.get(f"{API}/preparations/prep_nowhere"), 404, "not_found")
    error_of(recording.get(f"{API}/preparations/prep_nowhere/corrections"), 404, "not_found")
    assert field_paths(recording.get(f"{API}/preparations/prep_nowhere?full=1")) == {"/query/full"}


# --- Orders once preparation is recorded -----------------------------------------------------


def test_a_new_order_starts_with_nothing_prepared(recording: TestClient) -> None:
    body = draft(recording, [("Beef Caldereta", "Medium", 5), ("Fresh Lumpia", "Each", 30)])

    quote = quoted(recording, body)
    order = order_on(
        recording, lines=[("Beef Caldereta", "Medium", 5), ("Fresh Lumpia", "Each", 30)]
    )

    assert [(row["prepared_quantity"], row["remaining_quantity"]) for row in quote["lines"]] == [
        (0, 5),
        (0, 30),
    ]
    assert order["preparation_tracking"] == "recorded"
    assert counts(order) == [(0, 5), (0, 30)]
    assert order["cancellation_requires_stock_acknowledgment"] is False
    assert order["permitted_actions"]["record_preparation"] == ALLOWED
    assert read(recording, order["id"]) == order


def test_a_pending_order_cannot_be_prepared_yet(recording: TestClient) -> None:
    order = order_on(recording, status="pending")

    assert order["permitted_actions"]["record_preparation"] == {
        "allowed": False,
        "reason_code": "order_not_preparable",
        "reason": "Only confirmed, preparing or ready orders can be prepared.",
    }


def test_an_order_taken_before_recording_stays_tracked_by_hand(
    client: TestClient, admin: StaffUser, cli: Cli
) -> None:
    kitchen = open_kitchen(client, admin, cli, recording=False)
    old = order_on(kitchen)
    assert cli("settings", "set", RECORDING) == 0
    new = order_on(kitchen)

    old = read(kitchen, old["id"])
    assert (old["preparation_tracking"], counts(old)) == ("manual", [(None, None)])
    assert old["permitted_actions"]["record_preparation"] == {
        "allowed": False,
        "reason_code": "tracked_by_hand",
        "reason": "This order was taken before preparation was recorded and is tracked by hand.",
    }
    refused = preview_preparation(kitchen, cooking([allocation(old, 1)], [], "Leftovers"))
    assert field_paths(refused) == {"/draft/allocations/0/order_id"}
    # Staff still vouch for it themselves, as before.
    assert moved_to(kitchen, old, "completed")["status"] == "completed"
    assert new["preparation_tracking"] == "recorded"


def test_ready_and_completed_wait_until_nothing_remains(scene: Scene) -> None:
    client = scene.client
    order = moved_to(client, scene.order, "preparing")
    waiting = {
        "allowed": False,
        "reason_code": "preparation_incomplete",
        "reason": "Record all remaining preparation before marking ready.",
    }
    assert order["permitted_actions"]["mark_ready"] == waiting
    refused = error_of(step(client, order, "ready"), 409, "action_not_allowed")
    assert refused["message"] == waiting["reason"]

    part = prepare(client, cooking([allocation(order, 2)], [usage(scene.flour, "1", "kg")]))
    order, flour = part["orders"][0], part["ingredients"][0]
    # Recording what was cooked never moves the order along by itself.
    assert (order["status"], order["permitted_actions"]["mark_ready"]) == ("preparing", waiting)

    order = prepare(client, cooking([allocation(order, 3)], [usage(flour, "1", "kg")]))["orders"][0]
    assert (order["status"], counts(order)) == ("preparing", [(5, 0)])
    assert order["permitted_actions"]["mark_ready"] == ALLOWED
    assert order["permitted_actions"]["record_preparation"] == {
        "allowed": False,
        "reason_code": "nothing_remaining",
        "reason": "Nothing remains to prepare.",
    }
    assert moved_to(client, order, "completed")["status"] == "completed"


def test_completion_waits_for_a_ready_order_with_food_still_to_cook(
    client: TestClient, admin: StaffUser, cli: Cli
) -> None:
    kitchen = open_kitchen(client, admin, cli, recording=False)
    ready = moved_to(kitchen, order_on(kitchen), "ready")
    assert cli("settings", "set", RECORDING) == 0
    # The operator brings the order into recording with two of its five trays counted as done.
    assert (
        cli("preparation", "baseline", ready["reference"], "--prepared=1=2", "--reason=Count") == 0
    )

    order = read(kitchen, ready["id"])

    assert (order["status"], counts(order)) == ("ready", [(2, 3)])
    assert order["permitted_actions"]["complete"] == {
        "allowed": False,
        "reason_code": "preparation_incomplete",
        "reason": "Record all remaining preparation before completion.",
    }
    error_of(step(kitchen, order, "completed"), 409, "action_not_allowed")
    order = prepare(kitchen, cooking([allocation(order, 3)], [], "Cooked the rest"))["orders"][0]
    assert moved_to(kitchen, order, "completed")["status"] == "completed"


# --- Reviewing -------------------------------------------------------------------------------


def test_a_preview_shows_what_recording_would_do_and_changes_nothing(scene: Scene) -> None:
    client, order, flour = scene.client, scene.order, scene.flour
    item = order["items"][0]

    response = preview_preparation(client, scene.cooking(note="  First batch  "))

    assert response.status_code == 200
    preview = response.json()
    assert preview == {
        "id": preview["id"],
        "expires_at": "2026-10-10T19:05:00Z",
        "prepared_on": TODAY,
        "note": "First batch",
        "allocations": [
            {
                "order_id": order["id"],
                "reference": order["reference"],
                "order_item_id": item["id"],
                "variant_id": item["variant_id"],
                "expected_version": 1,
                "food_name": "Beef Caldereta",
                "variant_label": "Medium",
                "selling_unit": "tray",
                "package_contents": None,
                "ordered_quantity": 5,
                "prepared_before": 0,
                "quantity": 2,
                "prepared_after": 2,
                "remaining_after": 3,
            }
        ],
        "consumption": [
            {
                "ingredient_id": flour["id"],
                "ingredient_name": "Flour",
                "base_unit": "g",
                "expected_version": flour["version"],
                "quantity": "1.5",
                "unit": "kg",
                "base_quantity": "1500",
                "before_quantity": "2000",
                "after_quantity": "500",
            }
        ],
        "recipe_snapshots": [
            {"variant_id": item["variant_id"], "recipe_id": scene.recipe["id"], "recipe_version": 1}
        ],
        "cost_basis_snapshots": [
            {
                "ingredient_id": flour["id"],
                "purchase_id": flour["purchase"]["id"],
                "purchase_line_id": flour["purchase"]["items"][0]["id"],
                "purchased_on": "2026-10-07",
                "unit_cost": "0.012000000",
            }
        ],
        # What was actually used, at the exact receipt cost: 1500 g of 2 kg for 24.00.
        "estimated_ingredient_cost_minor": 1800,
        "estimate_complete": True,
        "currency": "USD",
        "minor_digits": 2,
    }
    assert read(client, order["id"]) == order
    assert read_ingredient(client, flour["id"])["stock_on_hand"] == "2000"
    assert len(movements(client, flour["id"])) == 1


def test_saving_moves_the_counts_and_the_stock_together_and_keeps_the_record(
    scene: Scene, clock: FakeClock
) -> None:
    client, order, flour = scene.client, scene.order, scene.flour
    body = scene.cooking(note="First batch")
    preview = reviewed(client, body)
    clock.advance(minutes=2)
    key = "0b4c7f0e-6f3a-4b53-9d8e-1f2a3b4c5d6e"

    response = save_preparation(client, body, preview, key)

    assert response.status_code == 201
    result = response.json()
    assert set(result) == {"preparation", "orders", "ingredients"}
    record = result["preparation"]
    (movement,) = [row for row in movements(client, flour["id"]) if row["type"] == "consumption"]
    assert record == {
        "id": record["id"],
        "prepared_on": TODAY,
        "note": "First batch",
        "allocations": [
            {
                key_: value
                for key_, value in preview["allocations"][0].items()
                if key_
                not in (
                    "expected_version",
                    "ordered_quantity",
                    "prepared_before",
                    "prepared_after",
                    "remaining_after",
                )
            }
        ],
        "consumption": [
            {
                **{k: v for k, v in preview["consumption"][0].items() if k != "expected_version"},
                "stock_movement_id": movement["id"],
            }
        ],
        "recipe_snapshots": preview["recipe_snapshots"],
        "cost_basis_snapshots": preview["cost_basis_snapshots"],
        "estimated_ingredient_cost_minor": 1800,
        "estimate_complete": True,
        "currency": "USD",
        "minor_digits": 2,
        "operation_id": key,
        "recorded_at": "2026-10-10T19:02:00Z",
        "recorded_by": "Admin",
    }
    assert record["id"].startswith("prep_")
    assert record["allocations"][0]["quantity"] == 2

    (after,) = result["orders"]
    assert (after["version"], after["status"], counts(after)) == (2, "confirmed", [(2, 3)])
    assert after["cancellation_requires_stock_acknowledgment"] is True
    assert after == read(client, order["id"])
    (stock,) = result["ingredients"]
    assert (stock["version"], stock["stock_on_hand"]) == (flour["version"] + 1, "500")
    assert stock == read_ingredient(client, flour["id"])
    assert movement == {
        **movement,
        "delta_base_quantity": "-1500",
        "before_quantity": "2000",
        "after_quantity": "500",
        "reason": "Preparation recorded",
        "purchase_id": None,
        "preparation_id": record["id"],
        "corrects_movement_id": None,
        "operation_id": key,
        "recorded_by": "Admin",
    }
    assert read_preparation(client, record["id"]) == record
    operation = client.get(f"{API}/operations/{key}").json()
    assert (operation["state"], operation["resource_type"], operation["resource_id"]) == (
        "succeeded",
        "preparation",
        record["id"],
    )


def test_the_same_request_sent_twice_cooks_once(scene: Scene) -> None:
    client, body = scene.client, scene.cooking()
    preview = reviewed(client, body)
    key = "5d0f1a52-8c0e-4d0b-8a52-6f1c3e7d9b10"

    first = save_preparation(client, body, preview, key)
    second = save_preparation(client, body, preview, key)

    assert (first.status_code, second.status_code) == (201, 201)
    assert second.headers["Idempotency-Replayed"] == "true"
    assert second.content == first.content
    assert read_ingredient(client, scene.flour["id"])["stock_on_hand"] == "500"
    assert counts(read(client, scene.order["id"])) == [(2, 3)]
    assert len(movements(client, scene.flour["id"])) == 2


def test_a_review_can_be_saved_only_once(scene: Scene) -> None:
    client, body = scene.client, scene.cooking(trays=1, flour="500", unit="g")
    preview = reviewed(client, body)
    assert save_preparation(client, body, preview).status_code == 201

    # A second save of the same review under a new key would cook the same trays again.
    error_of(save_preparation(client, body, preview), 409, "quote_stale")

    assert counts(read(client, scene.order["id"])) == [(1, 4)]
    assert read_ingredient(client, scene.flour["id"])["stock_on_hand"] == "1500"


def test_several_orders_and_ingredients_are_recorded_together(scene: Scene) -> None:
    client = scene.client
    oil = move(client, new_ingredient(client, "Annatto oil", "ml"), "opening", "1000")["ingredient"]
    mixed = order_on(
        client, lines=[("Beef Caldereta", "Medium", 1), ("Beef Caldereta", "Small", 4)]
    )
    body = cooking(
        [allocation(mixed, 1), allocation(scene.order, 3), allocation(mixed, 4, index=1)],
        [usage(oil, "0.25", "l"), usage(scene.flour, "2000")],
    )

    result = prepare(client, body)

    record = result["preparation"]
    assert [
        (row["reference"], row["variant_label"], row["quantity"]) for row in record["allocations"]
    ] == [
        (mixed["reference"], "Medium", 1),
        (scene.order["reference"], "Medium", 3),
        (mixed["reference"], "Small", 4),
    ]
    assert [
        (row["ingredient_name"], row["base_quantity"], row["after_quantity"])
        for row in record["consumption"]
    ] == [
        ("Annatto oil", "250", "750"),
        ("Flour", "2000", "0"),
    ]
    # One snapshot for each variant cooked, whether or not it has a recipe.
    assert record["recipe_snapshots"] == [
        {"variant_id": variant(client)["id"], "recipe_id": scene.recipe["id"], "recipe_version": 1},
        {
            "variant_id": variant(client, label="Small")["id"],
            "recipe_id": None,
            "recipe_version": None,
        },
    ]
    # Each order and each ingredient once, in the order the draft first named them.
    assert [(order["id"], order["version"], counts(order)) for order in result["orders"]] == [
        (mixed["id"], 2, [(1, 0), (4, 0)]),
        (scene.order["id"], 2, [(3, 2)]),
    ]
    assert [(item["name"], item["stock_on_hand"]) for item in result["ingredients"]] == [
        ("Annatto oil", "750"),
        ("Flour", "0"),
    ]
    assert len(movements(client, oil["id"])) == 2


# --- What a draft may say --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "value", "refused_at"),
    [
        ("prepared_on", "2026-02-30", "/draft/prepared_on"),
        ("prepared_on", 20261010, "/draft/prepared_on"),
        ("prepared_on", ..., "/draft/prepared_on"),
        ("note", "x" * 2001, "/draft/note"),
        ("note", 5, "/draft/note"),
        ("allocations", [], "/draft/allocations"),
        ("allocations", ..., "/draft/allocations"),
        ("allocations/0/quantity", 0, "/draft/allocations/0/quantity"),
        ("allocations/0/quantity", 6, "/draft/allocations/0/quantity"),
        ("allocations/0/quantity", "2", "/draft/allocations/0/quantity"),
        ("allocations/0/quantity", 2.5, "/draft/allocations/0/quantity"),
        ("allocations/0/expected_version", 0, "/draft/allocations/0/expected_version"),
        ("allocations/0/expected_version", ..., "/draft/allocations/0/expected_version"),
        ("allocations/0/order_id", "ord_nowhere", "/draft/allocations/0/order_id"),
        ("allocations/0/order_item_id", "item_nowhere", "/draft/allocations/0/order_item_id"),
        ("allocations/0/prepared_before", 0, "/draft/allocations/0/prepared_before"),
        ("consumption", ..., "/draft/consumption"),
        ("consumption", None, "/draft/consumption"),
        ("consumption/0/ingredient_id", "ing_nowhere", "/draft/consumption/0/ingredient_id"),
        ("consumption/0/unit", "l", "/draft/consumption/0/unit"),
        ("consumption/0/unit", "cup", "/draft/consumption/0/unit"),
        ("consumption/0/quantity", "0", "/draft/consumption/0/quantity"),
        ("consumption/0/quantity", "-1", "/draft/consumption/0/quantity"),
        ("consumption/0/quantity", "1.2345", "/draft/consumption/0/quantity"),
        ("consumption/0/quantity", 1.5, "/draft/consumption/0/quantity"),
        ("consumption/0/expected_version", "2", "/draft/consumption/0/expected_version"),
        ("consumption/0/base_quantity", "1500", "/draft/consumption/0/base_quantity"),
        ("estimated_ingredient_cost_minor", 0, "/draft/estimated_ingredient_cost_minor"),
    ],
)
def test_a_malformed_draft_is_refused_at_the_field(
    scene: Scene, path: str, value: Any, refused_at: str
) -> None:
    body = change(scene.cooking(), path, value)

    assert field_paths(preview_preparation(scene.client, body)) == {refused_at}
    assert counts(read(scene.client, scene.order["id"])) == [(0, 5)]


def test_the_request_itself_is_checked_too(scene: Scene) -> None:
    client, body = scene.client, scene.cooking()
    preview = reviewed(client, body)

    assert field_paths(
        client.post(f"{API}/preparations/preview", json={"draft": body, "id": 1})
    ) == {"/id"}
    assert field_paths(
        client.post(f"{API}/preparations/preview", json={"draft": "five trays"})
    ) == {"/draft"}
    assert field_paths(client.post(f"{API}/preparations/preview", json={})) == {"/draft"}
    assert field_paths(keyed(client, "POST", "/preparations", {"draft": body})) == {"/preview_id"}
    bad = change(body, "allocations/0/quantity", 0)
    assert field_paths(save_preparation(client, bad, preview)) == {"/draft/allocations/0/quantity"}
    error_of(
        client.post(f"{API}/preparations", json={"preview_id": preview["id"], "draft": body}),
        422,
        "validation_failed",
    )
    assert counts(read(client, scene.order["id"])) == [(0, 5)]


def test_a_draft_has_at_most_500_rows_of_each_kind(scene: Scene) -> None:
    client, order, flour = scene.client, scene.order, scene.flour

    lines = cooking([allocation(order, 1)] * 501, [usage(flour, "1")])
    rows = cooking([allocation(order, 1)], [usage(flour, "1")] * 501)

    assert field_paths(preview_preparation(client, lines)) == {"/draft/allocations"}
    assert field_paths(preview_preparation(client, rows)) == {"/draft/consumption"}


def test_a_line_or_an_ingredient_appears_once(scene: Scene) -> None:
    client, order, flour = scene.client, scene.order, scene.flour
    twice = cooking(
        [allocation(order, 1), allocation(order, 1)], [usage(flour, "100"), usage(flour, "100")]
    )

    assert field_paths(preview_preparation(client, twice)) == {
        "/draft/allocations/1/order_item_id",
        "/draft/consumption/1/ingredient_id",
    }


@pytest.mark.parametrize("status", ["pending", "cancelled"])
def test_only_an_order_that_can_still_be_cooked_takes_preparation(
    scene: Scene, status: str
) -> None:
    order = moved_to(scene.client, order_on(scene.client, status="pending"), status)

    refused = preview_preparation(scene.client, cooking([allocation(order, 1)], [], "Leftovers"))

    assert field_paths(refused) == {"/draft/allocations/0/order_id"}


def test_a_line_belongs_to_the_order_named_with_it_and_is_still_on_it(scene: Scene) -> None:
    client = scene.client
    other = order_on(client, lines=[("Beef Caldereta", "Small", 1), ("Fresh Lumpia", "Each", 10)])
    mismatched = {**allocation(scene.order, 1), "order_item_id": other["items"][0]["id"]}
    edited = as_saved(other)
    del edited["items"][1]
    after = revise(client, other, edited).json()
    removed = {**allocation(after, 1), "order_item_id": other["items"][1]["id"]}

    assert field_paths(preview_preparation(client, cooking([mismatched], [], "x"))) == {
        "/draft/allocations/0/order_item_id"
    }
    assert field_paths(preview_preparation(client, cooking([removed], [], "x"))) == {
        "/draft/allocations/0/order_item_id"
    }


def test_no_more_can_be_prepared_than_remains(scene: Scene) -> None:
    client = scene.client
    order = prepare(client, scene.cooking(trays=4, flour="100", unit="g"))["orders"][0]
    flour = read_ingredient(client, scene.flour["id"])

    too_many = preview_preparation(client, cooking([allocation(order, 2)], [usage(flour, "100")]))
    last = preview_preparation(client, cooking([allocation(order, 1)], [usage(flour, "100")]))

    assert field_paths(too_many) == {"/draft/allocations/0/quantity"}
    assert last.json()["allocations"][0] == {
        **last.json()["allocations"][0],
        "prepared_before": 4,
        "quantity": 1,
        "prepared_after": 5,
        "remaining_after": 0,
    }


def test_a_preparation_that_used_nothing_tracked_says_why(scene: Scene) -> None:
    client, order = scene.client, scene.order

    silent = preview_preparation(client, cooking([allocation(order, 1)], []))
    blank = preview_preparation(client, cooking([allocation(order, 1)], [], "   "))
    explained = preview_preparation(
        client, cooking([allocation(order, 1)], [], " Bought in ready made ")
    )

    assert field_paths(silent) == {"/draft/note"}
    assert field_paths(blank) == {"/draft/note"}
    preview = explained.json()
    assert (preview["note"], preview["consumption"], preview["cost_basis_snapshots"]) == (
        "Bought in ready made",
        [],
        [],
    )
    # Nothing used costs nothing, and that is known.
    assert (preview["estimated_ingredient_cost_minor"], preview["estimate_complete"]) == (0, True)
    saved = save_preparation(
        client, cooking([allocation(order, 1)], [], " Bought in ready made "), preview
    )
    assert (saved.status_code, saved.json()["ingredients"]) == (201, [])


# --- Stale pages and short shelves -----------------------------------------------------------


def test_an_order_changed_since_it_was_read_is_a_conflict_with_the_latest_order(
    scene: Scene,
) -> None:
    client, body = scene.client, scene.cooking()
    latest = moved_to(client, scene.order, "preparing")

    conflict = error_of(preview_preparation(client, body), 409, "version_conflict")

    assert conflict["details"] == {
        "resource_type": "order",
        "resource_id": scene.order["id"],
        "expected_version": 1,
        "current_version": 2,
        "latest_resource": latest,
    }
    assert counts(read(client, scene.order["id"])) == [(0, 5)]


def test_stock_changed_since_it_was_read_is_a_conflict_with_the_latest_ingredient(
    scene: Scene,
) -> None:
    client, body = scene.client, scene.cooking()
    preview = reviewed(client, body)
    latest = move(client, scene.flour, "waste", "-100")["ingredient"]

    for response in (preview_preparation(client, body), save_preparation(client, body, preview)):
        conflict = error_of(response, 409, "version_conflict")
        assert conflict["details"] == {
            "resource_type": "ingredient",
            "resource_id": scene.flour["id"],
            "expected_version": scene.flour["version"],
            "current_version": scene.flour["version"] + 1,
            "latest_resource": latest,
        }
    assert counts(read(client, scene.order["id"])) == [(0, 5)]
    assert read_ingredient(client, scene.flour["id"])["stock_on_hand"] == "1900"


def test_using_more_than_is_on_the_shelf_is_refused_on_that_row(scene: Scene) -> None:
    client = scene.client
    oil = move(client, new_ingredient(client, "Annatto oil", "ml"), "opening", "100")["ingredient"]
    body = cooking(
        [allocation(scene.order, 2)], [usage(oil, "100", "ml"), usage(scene.flour, "2.001", "kg")]
    )

    short = error_of(preview_preparation(client, body), 409, "insufficient_stock")

    assert [(field["path"], field["code"]) for field in short["field_errors"]] == [
        ("/draft/consumption/1/quantity", "insufficient_stock")
    ]
    # Nothing was taken for the row that would have fitted, and nothing was cooked.
    assert read_ingredient(client, oil["id"]) == oil
    assert counts(read(client, scene.order["id"])) == [(0, 5)]
    all_of_it = cooking([allocation(scene.order, 2)], [usage(scene.flour, "2", "kg")])
    assert prepare(client, all_of_it)["ingredients"][0]["stock_on_hand"] == "0"


def test_what_is_wrong_with_the_draft_comes_before_versions_and_versions_before_the_shelf(
    scene: Scene,
) -> None:
    client = scene.client
    stale = scene.cooking(flour="9", unit="kg")
    moved_to(client, scene.order, "preparing")
    move(client, scene.flour, "waste", "-100")

    assert field_paths(preview_preparation(client, change(stale, "allocations/0/quantity", 9))) == {
        "/draft/allocations/0/quantity"
    }
    # Both are stale; the first one the draft names is reported.
    conflict = error_of(preview_preparation(client, stale), 409, "version_conflict")
    assert conflict["details"]["resource_type"] == "order"
    current = change(stale, "allocations/0/expected_version", 2)
    conflict = error_of(preview_preparation(client, current), 409, "version_conflict")
    assert conflict["details"]["resource_type"] == "ingredient"


# --- What it cost ----------------------------------------------------------------------------


def test_an_ingredient_never_bought_leaves_the_cost_unknown_not_zero(scene: Scene) -> None:
    client = scene.client
    oil = move(client, new_ingredient(client, "Annatto oil", "ml"), "opening", "1000")["ingredient"]
    body = cooking(
        [allocation(scene.order, 2)], [usage(scene.flour, "1.5", "kg"), usage(oil, "60", "ml")]
    )

    preview = reviewed(client, body)
    record = save_preparation(client, body, preview).json()["preparation"]

    for item in (preview, record):
        assert (item["estimated_ingredient_cost_minor"], item["estimate_complete"]) == (None, False)
        assert item["cost_basis_snapshots"] == [
            preview["cost_basis_snapshots"][0],
            {
                "ingredient_id": oil["id"],
                "purchase_id": None,
                "purchase_line_id": None,
                "purchased_on": None,
                "unit_cost": None,
            },
        ]
    assert preview["cost_basis_snapshots"][0]["unit_cost"] == "0.012000000"


def test_an_ingredient_bought_for_nothing_costs_zero_and_that_is_known(scene: Scene) -> None:
    client = scene.client
    herbs = bought(client, "Garden herbs", cost=0)

    preview = reviewed(client, cooking([allocation(scene.order, 1)], [usage(herbs, "50")]))

    assert (preview["estimated_ingredient_cost_minor"], preview["estimate_complete"]) == (0, True)
    assert preview["cost_basis_snapshots"][0]["unit_cost"] == "0.000000000"


def test_the_cost_is_rounded_once_from_the_exact_receipt_costs(scene: Scene) -> None:
    client, order = scene.client, scene.order
    # A cent a kilogram: 500 g is exactly half a cent.
    salt, sugar = (
        bought(client, "Salt", cost=1, quantity="1"),
        bought(client, "Sugar", cost=1, quantity="1"),
    )
    # 300 t for 1,000,000.00 shows as 0.003333333 a gram, which is a little too low.
    grain = bought(client, "Grain", cost=100_000_000, quantity="300000")

    def cost(*rows: dict[str, Any]) -> Any:
        return reviewed(client, cooking([allocation(order, 1)], list(rows)))[
            "estimated_ingredient_cost_minor"
        ]

    assert cost(usage(salt, "500")) == 1
    assert cost(usage(salt, "400")) == 0
    # Two halves make one cent. Rounding each row first would have made two.
    assert cost(usage(salt, "500"), usage(sugar, "500")) == 1
    # From the displayed unit cost this would have been 49999995.
    assert cost(usage(grain, "150000", "kg")) == 50_000_000


def test_a_cost_too_large_to_state_is_refused_rather_than_wrong(scene: Scene) -> None:
    client = scene.client
    # A thousandth of a gram for the largest amount there is; then a full jar turns up.
    saffron = bought(client, "Saffron", cost=9007199254740991, quantity="0.001", unit="g")
    saffron = move(client, saffron, "correction", "1000", reason="Found a full jar")["ingredient"]

    refused = preview_preparation(
        client, cooking([allocation(scene.order, 1)], [usage(saffron, "1", "kg")])
    )

    assert field_paths(refused) == {"/draft/consumption"}


def test_a_receipt_in_another_currency_is_not_a_cost_basis(scene: Scene, cli: Cli) -> None:
    cli("settings", "set", "--currency=JPY", "--minor-digits=0")

    preview = reviewed(scene.client, scene.cooking())

    assert (preview["currency"], preview["minor_digits"]) == ("JPY", 0)
    assert (preview["estimated_ingredient_cost_minor"], preview["estimate_complete"]) == (
        None,
        False,
    )
    assert preview["cost_basis_snapshots"][0]["purchase_id"] is None


# --- The review that is saved ----------------------------------------------------------------


def test_a_review_lasts_five_minutes(scene: Scene, clock: FakeClock) -> None:
    client, body = scene.client, scene.cooking()
    late, in_time = reviewed(client, body), reviewed(client, body)

    clock.advance(minutes=4, seconds=59)
    assert save_preparation(client, body, in_time).status_code == 201
    clock.advance(seconds=1)

    error_of(save_preparation(client, body, late), 409, "quote_stale")


def test_what_is_saved_is_what_was_reviewed(scene: Scene) -> None:
    client, body = scene.client, scene.cooking(note="First batch")
    preview = reviewed(client, body)
    movement = preview_movement(
        client, scene.flour, movement_input(scene.flour, "waste", "-1")
    ).json()

    more = change(body, "allocations/0/quantity", 3)
    other_day = change(body, "prepared_on", "2026-10-09")
    error_of(save_preparation(client, more, preview), 409, "quote_stale")
    error_of(save_preparation(client, other_day, preview), 409, "quote_stale")
    error_of(save_preparation(client, body, {"id": "prev_nowhere"}), 409, "quote_stale")
    error_of(save_preparation(client, body, movement), 409, "quote_stale")
    assert counts(read(client, scene.order["id"])) == [(0, 5)]

    # The same thing written another way is still what was reviewed.
    same = change(change(body, "consumption/0/quantity", "1.500"), "note", "  First batch ")
    saved = save_preparation(client, same, preview)
    assert saved.status_code == 201
    assert saved.json()["preparation"]["consumption"][0]["quantity"] == "1.500"


def test_a_recipe_changed_after_the_review_means_reviewing_again(scene: Scene) -> None:
    client, body = scene.client, scene.cooking()
    preview = reviewed(client, body)
    rewritten = {
        "expected_version": 1,
        "yield": scene.recipe["yield"],
        "items": [{"ingredient_id": scene.flour["id"], "quantity": "800", "unit": "g"}],
    }
    assert (
        client.put(f"{API}/variants/{variant(client)['id']}/recipe", json=rewritten).status_code
        == 200
    )

    error_of(save_preparation(client, body, preview), 409, "quote_stale")

    again = reviewed(client, body)
    assert again["recipe_snapshots"][0]["recipe_version"] == 2
    assert save_preparation(client, body, again).status_code == 201


def test_a_record_never_changes_whatever_happens_afterwards(scene: Scene, clock: FakeClock) -> None:
    client = scene.client
    done = prepare(client, scene.cooking(note="First batch"))
    record, order, flour = done["preparation"], done["orders"][0], done["ingredients"][0]

    clock.advance(minutes=1)
    rewritten = {
        "expected_version": 1,
        "yield": scene.recipe["yield"],
        "items": [{"ingredient_id": flour["id"], "quantity": "800", "unit": "g"}],
    }
    assert (
        client.put(f"{API}/variants/{variant(client)['id']}/recipe", json=rewritten).status_code
        == 200
    )
    buy(client, receipt(line(flour, "1", "kg", 9900), on="2026-10-09"))
    flour = read_ingredient(client, flour["id"])
    keyed(
        client,
        "PATCH",
        f"/ingredients/{flour['id']}",
        {"expected_version": flour["version"], "name": "Rye"},
    )
    larger = as_saved(order)
    larger["items"][0]["quantity"] = 8
    assert revise(client, order, larger).status_code == 200
    medium = variant(client)
    keyed(
        client,
        "PATCH",
        f"/variants/{medium['id']}",
        {"expected_version": medium["version"], "label": "Party"},
    )

    assert read_preparation(client, record["id"]) == record


# --- Editing and cancelling after preparation ------------------------------------------------


def test_a_partly_prepared_line_cannot_shrink_below_what_is_done_or_be_removed(
    scene: Scene,
) -> None:
    client = scene.client
    order = prepare(client, scene.cooking())["orders"][0]
    same = as_saved(order)

    below = change(same, "items/0/quantity", 1)
    swapped = change(same, "items/0/variant_id", variant(client, label="Small")["id"])
    replaced = {**same, "items": draft(client, [("Beef Caldereta", "Small", 5)])["items"]}
    assert field_paths(ask(client, below, order)) == {"/draft/items/0/quantity"}
    assert field_paths(ask(client, swapped, order)) == {"/draft/items/0/variant_id"}
    assert field_paths(ask(client, replaced, order)) == {"/draft/items"}

    exactly = change(same, "items/0/quantity", 2)
    assert quoted(client, exactly, order)["lines"][0]["remaining_quantity"] == 0
    larger = change(same, "items/0/quantity", 6)
    line_ = quoted(client, larger, order)["lines"][0]
    assert (line_["prepared_quantity"], line_["remaining_quantity"]) == (2, 4)
    after = revise(client, order, larger).json()
    assert (after["items"][0]["id"], counts(after)) == (order["items"][0]["id"], [(2, 4)])
    assert after["items"][0]["unit_price_minor"] == order["items"][0]["unit_price_minor"]


def test_an_unprepared_line_can_still_be_added_or_removed(scene: Scene) -> None:
    client = scene.client
    order = prepare(client, scene.cooking())["orders"][0]
    wider = as_saved(order)
    wider["items"].append(draft(client, [("Fresh Lumpia", "Each", 10)])["items"][0])

    after = revise(client, order, wider).json()
    assert counts(after) == [(2, 3), (0, 10)]

    narrower = as_saved(after)
    del narrower["items"][1]
    assert counts(revise(client, after, narrower).json()) == [(2, 3)]


def test_cancelling_after_preparation_acknowledges_that_stock_is_not_returned(
    scene: Scene,
) -> None:
    client = scene.client
    done = prepare(client, scene.cooking())
    order, record = done["orders"][0], done["preparation"]
    assert order["cancellation_requires_stock_acknowledgment"] is True

    assert field_paths(cancel(client, order)) == {"/acknowledge_consumed_stock"}
    assert read(client, order["id"])["status"] == "confirmed"
    cancelled = cancel(client, order, acknowledge_consumed_stock=True).json()

    assert (cancelled["status"], counts(cancelled)) == ("cancelled", [(2, 3)])
    assert cancelled["permitted_actions"]["record_preparation"]["allowed"] is False
    # Nothing comes back by itself. What was really recovered is entered as its own movement,
    # with a reason and a link to the preparation it came from.
    flour = read_ingredient(client, scene.flour["id"])
    assert flour["stock_on_hand"] == "500"
    used = record["consumption"][0]["stock_movement_id"]
    back = move(
        client,
        flour,
        "correction",
        "750",
        reason="One tray was never started",
        preparation_id=record["id"],
        corrects_movement_id=used,
    )
    assert (back["movement"]["preparation_id"], back["movement"]["corrects_movement_id"]) == (
        record["id"],
        used,
    )
    assert back["ingredient"]["stock_on_hand"] == "1250"
    assert read_preparation(client, record["id"]) == record


def test_an_unprepared_order_cancels_without_the_acknowledgment(scene: Scene) -> None:
    assert cancel(scene.client, scene.order).json()["status"] == "cancelled"


# --- Stock movements linked to a preparation -------------------------------------------------


def test_a_movement_may_name_only_a_preparation_that_used_the_ingredient(scene: Scene) -> None:
    client = scene.client
    record = prepare(client, scene.cooking())["preparation"]
    flour = read_ingredient(client, scene.flour["id"])
    oil = move(client, new_ingredient(client, "Annatto oil", "ml"), "opening", "1000")["ingredient"]
    salt = new_ingredient(client, "Salt")

    wasted = move(client, flour, "waste", "-100", preparation_id=record["id"])
    assert wasted["movement"]["preparation_id"] == record["id"]
    assert movements(client, flour["id"])[0]["preparation_id"] == record["id"]

    def refused(ingredient: dict[str, Any], kind: str, delta: str, preparation_id: str) -> set[str]:
        body = movement_input(ingredient, kind, delta, preparation_id=preparation_id)
        return field_paths(preview_movement(client, ingredient, body))

    assert refused(oil, "waste", "-10", record["id"]) == {"/preparation_id"}
    assert refused(wasted["ingredient"], "waste", "-10", "prep_nowhere") == {"/preparation_id"}
    assert refused(salt, "opening", "10", record["id"]) == {"/preparation_id"}


def test_a_movement_names_no_preparation_while_recording_is_off(scene: Scene, cli: Cli) -> None:
    record = prepare(scene.client, scene.cooking())["preparation"]
    flour = read_ingredient(scene.client, scene.flour["id"])
    cli("settings", "set", "--disable=preparation_recording")

    body = movement_input(flour, "waste", "-10", preparation_id=record["id"])

    assert field_paths(preview_movement(scene.client, flour, body)) == {"/preparation_id"}


# --- All or nothing --------------------------------------------------------------------------


def test_a_failure_midway_leaves_nothing_cooked_and_nothing_used(
    scene: Scene, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = scene.client
    oil = move(client, new_ingredient(client, "Annatto oil", "ml"), "opening", "1000")["ingredient"]
    body = cooking(
        [allocation(scene.order, 2)], [usage(oil, "60", "ml"), usage(scene.flour, "1.5", "kg")]
    )
    preview = reviewed(client, body)
    key = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d"
    real, calls = inventory.move, []

    def failing(*args: Any, **kwargs: Any) -> Any:
        calls.append(args)
        if len(calls) == 2:
            raise RuntimeError("the disk is full")
        return real(*args, **kwargs)

    monkeypatch.setattr(inventory, "move", failing)
    error_of(save_preparation(client, body, preview, key), 500, "internal_error")

    # The first ingredient had already been taken when the second failed. None of it stays.
    assert len(calls) == 2
    assert read_ingredient(client, oil["id"]) == oil
    assert read_ingredient(client, scene.flour["id"])["stock_on_hand"] == "2000"
    assert read(client, scene.order["id"]) == scene.order
    error_of(client.get(f"{API}/operations/{key}"), 404, "not_found")

    monkeypatch.setattr(inventory, "move", real)
    retried = save_preparation(client, body, preview, key)
    assert retried.status_code == 201
    assert "Idempotency-Replayed" not in retried.headers
    assert [item["stock_on_hand"] for item in retried.json()["ingredients"]] == ["940", "500"]
