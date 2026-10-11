from dataclasses import dataclass
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.persistence.models import StaffUser
from tests.inventory_support import move, movements, new_ingredient, read_ingredient
from tests.order_support import cancel, change, moved_to, read
from tests.preparation_support import (
    allocation,
    amendment,
    bought,
    cooking,
    correct,
    corrections,
    count_change,
    open_kitchen,
    order_on,
    plan,
    prepare,
    preview_correction,
    read_preparation,
    save_correction,
    stock_change,
    usage,
    variant,
    write_recipe,
)
from tests.support import API, Cli, FakeClock, error_of, field_paths, keyed

REASON = "Counted one tray too many"


@dataclass
class Cooked:
    """Two of five trays recorded as cooked with 1.5 kg of flour, leaving 500 g."""

    client: TestClient
    record: dict[str, Any]
    order: dict[str, Any]
    flour: dict[str, Any]

    @property
    def used(self) -> str:
        movement_id: str = self.record["consumption"][0]["stock_movement_id"]
        return movement_id

    def amendment(
        self, trays: Any = -1, flour: Any = "750", reason: str = REASON
    ) -> dict[str, Any]:
        return amendment(
            [count_change(self.order, trays)], [stock_change(self.flour, flour, self.used)], reason
        )


@pytest.fixture
def cooked(client: TestClient, admin: StaffUser, cli: Cli) -> Cooked:
    open_kitchen(client, admin, cli, recording=True)
    flour = bought(client)
    write_recipe(client, variant(client), (flour, "750", "g"))
    done = prepare(client, cooking([allocation(order_on(client), 2)], [usage(flour, "1.5", "kg")]))
    return Cooked(client, done["preparation"], done["orders"][0], done["ingredients"][0])


def reviewed(client: TestClient, preparation_id: str, body: dict[str, Any]) -> dict[str, Any]:
    response = preview_correction(client, preparation_id, body)
    assert response.status_code == 200, response.text
    preview: dict[str, Any] = response.json()
    return preview


def counts(order: dict[str, Any]) -> list[tuple[int, int]]:
    return [(item["prepared_quantity"], item["remaining_quantity"]) for item in order["items"]]


# --- Reviewing and saving --------------------------------------------------------------------


def test_a_correction_preview_shows_counts_and_stock_before_and_after(cooked: Cooked) -> None:
    client, order, flour = cooked.client, cooked.order, cooked.flour
    line = cooked.record["allocations"][0]

    response = preview_correction(
        client, cooked.record["id"], cooked.amendment(reason=f"  {REASON} ")
    )

    assert response.status_code == 200
    preview = response.json()
    assert preview == {
        "id": preview["id"],
        "expires_at": "2026-10-10T19:05:00Z",
        "preparation_id": cooked.record["id"],
        "reason": REASON,
        "allocations": [
            {
                **{name: value for name, value in line.items() if name != "quantity"},
                "expected_version": order["version"],
                "ordered_quantity": 5,
                "prepared_before": 2,
                "delta_quantity": -1,
                "prepared_after": 1,
                "remaining_after": 4,
            }
        ],
        "stock_corrections": [
            {
                "ingredient_id": flour["id"],
                "ingredient_name": "Flour",
                "base_unit": "g",
                "expected_version": flour["version"],
                "corrects_movement_id": cooked.used,
                "delta_base_quantity": "750",
                "before_quantity": "500",
                "after_quantity": "1250",
            }
        ],
    }
    assert read(client, order["id"]) == order
    assert read_ingredient(client, flour["id"]) == flour
    assert corrections(client, cooked.record["id"]) == []


def test_saving_a_correction_amends_counts_and_stock_and_leaves_the_record_alone(
    cooked: Cooked, clock: FakeClock
) -> None:
    client, body = cooked.client, cooked.amendment()
    preview = reviewed(client, cooked.record["id"], body)
    clock.advance(minutes=3)
    key = "3f2e1d0c-9b8a-4765-8432-10fedcba9876"

    response = save_correction(client, cooked.record["id"], body, preview, key)

    assert response.status_code == 201
    result = response.json()
    assert set(result) == {"correction", "orders", "ingredients"}
    saved = result["correction"]
    newest = movements(client, cooked.flour["id"])[0]
    assert saved == {
        "id": saved["id"],
        "preparation_id": cooked.record["id"],
        "reason": REASON,
        "allocations": [
            {
                name: value
                for name, value in preview["allocations"][0].items()
                if name != "expected_version"
            }
        ],
        "stock_corrections": [
            {
                **{
                    k: v
                    for k, v in preview["stock_corrections"][0].items()
                    if k != "expected_version"
                },
                "stock_movement_id": newest["id"],
            }
        ],
        "operation_id": key,
        "recorded_at": "2026-10-10T19:03:00Z",
        "recorded_by": "Admin",
    }
    assert saved["id"].startswith("corr_")

    (order,) = result["orders"]
    assert (order["version"], counts(order)) == (cooked.order["version"] + 1, [(1, 4)])
    assert order == read(client, order["id"])
    (flour,) = result["ingredients"]
    assert (flour["version"], flour["stock_on_hand"]) == (cooked.flour["version"] + 1, "1250")
    assert flour == read_ingredient(client, flour["id"])
    # The stock comes back as its own movement, linked both ways; nothing earlier is rewritten.
    assert newest == {
        **newest,
        "type": "correction",
        "delta_base_quantity": "750",
        "before_quantity": "500",
        "after_quantity": "1250",
        "reason": REASON,
        "preparation_id": cooked.record["id"],
        "corrects_movement_id": cooked.used,
        "operation_id": key,
    }
    assert read_preparation(client, cooked.record["id"]) == cooked.record
    assert corrections(client, cooked.record["id"]) == [saved]
    operation = client.get(f"{API}/operations/{key}").json()
    assert (operation["state"], operation["resource_type"], operation["resource_id"]) == (
        "succeeded",
        "preparation_correction",
        saved["id"],
    )


def test_the_same_correction_sent_twice_applies_once_and_its_review_is_spent(
    cooked: Cooked,
) -> None:
    client, body = cooked.client, cooked.amendment()
    preview = reviewed(client, cooked.record["id"], body)
    key = "7c6b5a49-3827-4615-9a0b-ccddeeff0011"

    first = save_correction(client, cooked.record["id"], body, preview, key)
    second = save_correction(client, cooked.record["id"], body, preview, key)

    assert (first.status_code, second.status_code) == (201, 201)
    assert second.headers["Idempotency-Replayed"] == "true"
    assert second.content == first.content
    error_of(save_correction(client, cooked.record["id"], body, preview), 409, "quote_stale")
    assert counts(read(client, cooked.order["id"])) == [(1, 4)]
    assert read_ingredient(client, cooked.flour["id"])["stock_on_hand"] == "1250"
    assert len(corrections(client, cooked.record["id"])) == 1


def test_counts_and_stock_can_each_be_corrected_alone_and_are_listed_in_order(
    cooked: Cooked,
) -> None:
    client, record = cooked.client, cooked.record

    first = correct(
        client, record["id"], amendment([count_change(cooked.order, 1)], reason="One more")
    )
    second = correct(
        client,
        record["id"],
        amendment(
            stock=[stock_change(cooked.flour, "-100", cooked.used)], reason="Used a little more"
        ),
    )

    assert (first["ingredients"], counts(first["orders"][0])) == ([], [(3, 2)])
    assert (second["orders"], second["ingredients"][0]["stock_on_hand"]) == ([], "400")
    assert second["correction"]["stock_corrections"][0]["delta_base_quantity"] == "-100"
    assert [item["reason"] for item in corrections(client, record["id"])] == [
        "One more",
        "Used a little more",
    ]


# --- What a correction may say ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "value", "refused_at"),
    [
        ("reason", "", "/reason"),
        ("reason", "   ", "/reason"),
        ("reason", "x" * 2001, "/reason"),
        ("reason", ..., "/reason"),
        ("allocations", ..., "/allocations"),
        ("allocations", None, "/allocations"),
        ("stock_corrections", ..., "/stock_corrections"),
        ("allocations/0/delta_quantity", 0, "/allocations/0/delta_quantity"),
        ("allocations/0/delta_quantity", "-1", "/allocations/0/delta_quantity"),
        ("allocations/0/delta_quantity", -1.5, "/allocations/0/delta_quantity"),
        # The preparation recorded two, and five were ordered.
        ("allocations/0/delta_quantity", -3, "/allocations/0/delta_quantity"),
        ("allocations/0/delta_quantity", 4, "/allocations/0/delta_quantity"),
        ("allocations/0/order_item_id", "item_nowhere", "/allocations/0/order_item_id"),
        ("allocations/0/order_id", "ord_nowhere", "/allocations/0/order_item_id"),
        ("allocations/0/expected_version", 0, "/allocations/0/expected_version"),
        ("allocations/0/quantity", 1, "/allocations/0/quantity"),
        ("stock_corrections/0/ingredient_id", "ing_nowhere", "/stock_corrections/0/ingredient_id"),
        (
            "stock_corrections/0/corrects_movement_id",
            "mov_nowhere",
            "/stock_corrections/0/corrects_movement_id",
        ),
        (
            "stock_corrections/0/corrects_movement_id",
            ...,
            "/stock_corrections/0/corrects_movement_id",
        ),
        (
            "stock_corrections/0/delta_base_quantity",
            "0",
            "/stock_corrections/0/delta_base_quantity",
        ),
        (
            "stock_corrections/0/delta_base_quantity",
            "1.2345",
            "/stock_corrections/0/delta_base_quantity",
        ),
        (
            "stock_corrections/0/delta_base_quantity",
            750,
            "/stock_corrections/0/delta_base_quantity",
        ),
        ("stock_corrections/0/expected_version", ..., "/stock_corrections/0/expected_version"),
        ("note", "x", "/note"),
        ("preview_id", "prev_1", "/preview_id"),
    ],
)
def test_a_malformed_correction_is_refused_at_the_field(
    cooked: Cooked, path: str, value: Any, refused_at: str
) -> None:
    body = change(cooked.amendment(), path, value)

    assert field_paths(preview_correction(cooked.client, cooked.record["id"], body)) == {refused_at}
    assert counts(read(cooked.client, cooked.order["id"])) == [(2, 3)]


def test_a_correction_changes_something(cooked: Cooked) -> None:
    nothing = preview_correction(cooked.client, cooked.record["id"], amendment())

    assert field_paths(nothing) == {"/allocations"}


def test_a_correction_names_only_what_its_preparation_recorded(cooked: Cooked) -> None:
    client, record = cooked.client, cooked.record
    other = order_on(client, lines=[("Beef Caldereta", "Small", 3)])
    oil = move(client, new_ingredient(client, "Annatto oil", "ml"), "opening", "1000")["ingredient"]
    waste = move(client, cooked.flour, "waste", "-10")
    flour = waste["ingredient"]

    another_line = amendment([count_change(other, 1)])
    twice = amendment(
        [count_change(cooked.order, 1), count_change(cooked.order, 1)],
        [stock_change(flour, "10", cooked.used), stock_change(flour, "10", cooked.used)],
    )
    unused = amendment(stock=[stock_change(oil, "-10", cooked.used)])
    another_movement = amendment(stock=[stock_change(flour, "10", waste["movement"]["id"])])

    assert field_paths(preview_correction(client, record["id"], another_line)) == {
        "/allocations/0/order_item_id"
    }
    assert field_paths(preview_correction(client, record["id"], twice)) == {
        "/allocations/1/order_item_id",
        "/stock_corrections/1/ingredient_id",
    }
    assert field_paths(preview_correction(client, record["id"], unused)) == {
        "/stock_corrections/0/ingredient_id"
    }
    assert field_paths(preview_correction(client, record["id"], another_movement)) == {
        "/stock_corrections/0/corrects_movement_id"
    }


def test_a_count_cannot_go_below_what_its_own_preparation_recorded(cooked: Cooked) -> None:
    client, first = cooked.client, cooked.record
    again = prepare(client, cooking([allocation(cooked.order, 2)], [usage(cooked.flour, "500")]))
    second, order = again["preparation"], again["orders"][0]
    assert counts(order) == [(4, 1)]

    order = correct(client, first["id"], amendment([count_change(order, -2)]))["orders"][0]
    assert counts(order) == [(2, 3)]

    # Two trays are still recorded, but they are the second preparation's, not the first's.
    below = preview_correction(client, first["id"], amendment([count_change(order, -1)]))
    assert field_paths(below) == {"/allocations/0/delta_quantity"}
    too_many = preview_correction(client, second["id"], amendment([count_change(order, 4)]))
    assert field_paths(too_many) == {"/allocations/0/delta_quantity"}

    order = correct(client, first["id"], amendment([count_change(order, 1)]))["orders"][0]
    order = correct(client, second["id"], amendment([count_change(order, -2)]))["orders"][0]
    assert counts(order) == [(1, 4)]


@pytest.mark.parametrize("status", ["ready", "completed"])
def test_a_count_is_not_lowered_once_the_order_is_ready_or_completed(
    cooked: Cooked, status: str
) -> None:
    client, record = cooked.client, cooked.record
    done = prepare(client, cooking([allocation(cooked.order, 3)], [usage(cooked.flour, "500")]))
    order = moved_to(client, done["orders"][0], status)
    flour = done["ingredients"][0]

    lowered = preview_correction(client, record["id"], amendment([count_change(order, -1)]))

    assert field_paths(lowered) == {"/allocations/0/delta_quantity"}
    # What the shelf really holds can still be put right.
    found = amendment(stock=[stock_change(flour, "5", cooked.used)])
    assert correct(client, record["id"], found)["ingredients"][0]["stock_on_hand"] == "5"


def test_a_cancelled_order_can_be_corrected_but_its_demand_does_not_return(cooked: Cooked) -> None:
    client, record = cooked.client, cooked.record
    cancelled = cancel(client, cooked.order, acknowledge_consumed_stock=True).json()

    result = correct(
        client,
        record["id"],
        amendment([count_change(cancelled, -2)], [stock_change(cooked.flour, "1500", cooked.used)]),
    )

    assert (result["orders"][0]["status"], counts(result["orders"][0])) == ("cancelled", [(0, 5)])
    assert result["ingredients"][0]["stock_on_hand"] == "2000"
    body = plan(client, "?date_from=2026-10-12&date_to=2026-10-12")
    assert (body["foods"], body["ingredients"]) == ([], [])


# --- Stale pages, short shelves and old reviews ----------------------------------------------


def test_a_correction_of_something_changed_since_is_a_conflict(cooked: Cooked) -> None:
    client, record, body = cooked.client, cooked.record, cooked.amendment()
    preview = reviewed(client, record["id"], body)
    order = moved_to(client, cooked.order, "preparing")

    for response in (
        preview_correction(client, record["id"], body),
        save_correction(client, record["id"], body, preview),
    ):
        conflict = error_of(response, 409, "version_conflict")
        assert (conflict["details"]["resource_type"], conflict["details"]["latest_resource"]) == (
            "order",
            order,
        )

    current = change(body, "allocations/0/expected_version", order["version"])
    flour = move(client, cooked.flour, "waste", "-100")["ingredient"]
    conflict = error_of(preview_correction(client, record["id"], current), 409, "version_conflict")
    assert conflict["details"] == {
        "resource_type": "ingredient",
        "resource_id": flour["id"],
        "expected_version": cooked.flour["version"],
        "current_version": flour["version"],
        "latest_resource": flour,
    }
    assert counts(read(client, order["id"])) == [(2, 3)]


def test_a_correction_cannot_take_more_than_is_on_the_shelf(cooked: Cooked) -> None:
    client, record = cooked.client, cooked.record

    short = error_of(
        preview_correction(client, record["id"], cooked.amendment(flour="-500.001")),
        409,
        "insufficient_stock",
    )

    assert [(field["path"], field["code"]) for field in short["field_errors"]] == [
        ("/stock_corrections/0/delta_base_quantity", "insufficient_stock")
    ]
    assert counts(read(client, cooked.order["id"])) == [(2, 3)]
    all_of_it = correct(client, record["id"], cooked.amendment(flour="-500"))
    assert all_of_it["ingredients"][0]["stock_on_hand"] == "0"


def test_a_correction_review_lasts_five_minutes_and_is_for_exactly_what_was_reviewed(
    cooked: Cooked, clock: FakeClock
) -> None:
    client, record, body = cooked.client, cooked.record, cooked.amendment()
    preview = reviewed(client, record["id"], body)
    other = prepare(client, cooking([allocation(order_on(client), 1)], [], "Leftovers"))[
        "preparation"
    ]

    error_of(
        save_correction(client, record["id"], cooked.amendment(trays=-2), preview),
        409,
        "quote_stale",
    )
    error_of(
        save_correction(client, record["id"], cooked.amendment(flour="700"), preview),
        409,
        "quote_stale",
    )
    error_of(
        save_correction(client, record["id"], cooked.amendment(reason="Other"), preview),
        409,
        "quote_stale",
    )
    error_of(save_correction(client, other["id"], body, preview), 409, "quote_stale")
    error_of(
        save_correction(client, record["id"], body, {"id": "prev_nowhere"}), 409, "quote_stale"
    )

    clock.advance(minutes=5)
    error_of(save_correction(client, record["id"], body, preview), 409, "quote_stale")
    assert corrections(client, record["id"]) == []

    again = reviewed(client, record["id"], body)
    same = cooked.amendment(flour="750.0", reason=f" {REASON} ")
    assert save_correction(client, record["id"], same, again).status_code == 201


def test_a_correction_needs_its_preparation_and_an_operation_key(cooked: Cooked) -> None:
    client, body = cooked.client, cooked.amendment()
    preview = reviewed(client, cooked.record["id"], body)

    error_of(preview_correction(client, "prep_nowhere", body), 404, "not_found")
    error_of(save_correction(client, "prep_nowhere", body, preview), 404, "not_found")
    unkeyed = client.post(
        f"{API}/preparations/{cooked.record['id']}/corrections",
        json={**body, "preview_id": preview["id"]},
    )
    assert field_paths(unkeyed) == {"/header/Idempotency-Key"}
    assert field_paths(
        keyed(client, "POST", f"/preparations/{cooked.record['id']}/corrections", body)
    ) == {"/preview_id"}
    assert field_paths(
        client.get(f"{API}/preparations/{cooked.record['id']}/corrections?page=1")
    ) == {"/query/page"}
