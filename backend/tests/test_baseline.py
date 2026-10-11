"""The operator's procedure for turning preparation recording on in a kitchen already at work."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.persistence.database import Database
from app.persistence.models import AuditEvent, StaffUser
from tests.inventory_support import move, movements, new_ingredient, read_ingredient
from tests.order_support import moved_to, read
from tests.preparation_support import (
    ALLOWED,
    RECORDING,
    allocation,
    cooking,
    open_kitchen,
    order_on,
    plan,
    prepare,
    usage,
    variant,
    write_recipe,
)
from tests.support import Cli

TRAYS_AND_LUMPIA = [("Beef Caldereta", "Medium", 5), ("Fresh Lumpia", "Each", 30)]
REASON = "--reason=Counted with the kitchen on 10 October"


@pytest.fixture
def kitchen(client: TestClient, admin: StaffUser, cli: Cli) -> TestClient:
    """A kitchen at work before anything it cooks is recorded."""
    return open_kitchen(client, admin, cli, recording=False)


def counts(order: dict[str, Any]) -> list[tuple[int | None, int | None]]:
    return [(item["prepared_quantity"], item["remaining_quantity"]) for item in order["items"]]


def baselines(database: Database) -> list[AuditEvent]:
    with database.read() as db:
        return list(
            db.scalars(
                select(AuditEvent)
                .where(AuditEvent.action == "preparation.baseline")
                .order_by(AuditEvent.id)
            )
        )


def test_status_lists_the_open_orders_still_tracked_by_hand(
    kitchen: TestClient, cli: Cli, capsys: pytest.CaptureFixture[str]
) -> None:
    preparing = moved_to(kitchen, order_on(kitchen, lines=TRAYS_AND_LUMPIA), "preparing")
    completed = moved_to(kitchen, order_on(kitchen, "2026-10-13"), "completed")
    cancelled = moved_to(kitchen, order_on(kitchen, "2026-10-14"), "cancelled")
    capsys.readouterr()

    assert cli("preparation", "status") == 0

    shown = capsys.readouterr().out
    assert "Preparation recording is off." in shown
    assert "Open orders still tracked by hand: 1" in shown
    assert f"{preparing['reference']}  preparing  2026-10-12" in shown
    assert "1. Beef Caldereta, Medium: 5" in shown
    assert "2. Fresh Lumpia, Each: 30" in shown
    # Finished orders need nothing: they are no longer demand.
    assert completed["reference"] not in shown
    assert cancelled["reference"] not in shown

    assert cli("settings", "set", RECORDING) == 0
    recorded = order_on(kitchen, "2026-10-15")
    capsys.readouterr()
    assert cli("preparation", "status") == 0
    shown = capsys.readouterr().out
    assert "Preparation recording is on." in shown
    assert "Open orders still tracked by hand: 1" in shown
    assert recorded["reference"] not in shown


def test_a_baseline_brings_an_order_into_recording_without_touching_stock(
    kitchen: TestClient, cli: Cli, database: Database, capsys: pytest.CaptureFixture[str]
) -> None:
    flour = move(kitchen, new_ingredient(kitchen), "opening", "2000")["ingredient"]
    write_recipe(kitchen, variant(kitchen), (flour, "100", "g"))
    order = moved_to(kitchen, order_on(kitchen, lines=TRAYS_AND_LUMPIA), "preparing")
    assert cli("settings", "set", RECORDING) == 0
    capsys.readouterr()

    assert (
        cli(
            "preparation",
            "baseline",
            order["reference"],
            "--prepared=1=2",
            "--prepared=2=30",
            REASON,
        )
        == 0
    )

    shown = capsys.readouterr().out
    assert f"{order['reference']} is now recorded" in shown
    assert "1. Beef Caldereta, Medium: 2 of 5 prepared" in shown
    assert "2. Fresh Lumpia, Each: 30 of 30 prepared" in shown
    after = read(kitchen, order["id"])
    assert (after["preparation_tracking"], after["status"], after["version"]) == (
        "recorded",
        "preparing",
        order["version"] + 1,
    )
    assert counts(after) == [(2, 3), (30, 0)]
    assert after["permitted_actions"]["record_preparation"] == ALLOWED
    assert after["cancellation_requires_stock_acknowledgment"] is True
    # The two trays were cooked before recording began: their ingredients left the shelf then,
    # and the count agreed afterwards already reflects that. Nothing is deducted again.
    assert read_ingredient(kitchen, flour["id"]) == flour
    assert len(movements(kitchen, flour["id"])) == 1
    (event,) = baselines(database)
    assert (event.actor, event.resource_type, event.resource_id) == (
        "operator",
        "order",
        order["id"],
    )
    assert event.details == {
        "reason": "Counted with the kitchen on 10 October",
        "previous_tracking": "manual",
        "lines": [
            {"order_item_id": order["items"][0]["id"], "ordered": 5, "prepared": 2},
            {"order_item_id": order["items"][1]["id"], "ordered": 30, "prepared": 30},
        ],
    }
    # From here the order is planned and cooked like any other.
    body = plan(kitchen, "?date_from=2026-10-12&date_to=2026-10-12")
    assert [(row["prepared_quantity"], row["remaining_quantity"]) for row in body["foods"]] == [
        (2, 3),
        (30, 0),
    ]
    assert body["ingredients"][0]["period_demand"] == "300"
    done = prepare(kitchen, cooking([allocation(after, 3)], [usage(flour, "300")]))
    assert counts(done["orders"][0]) == [(5, 0), (30, 0)]
    assert done["ingredients"][0]["stock_on_hand"] == "1700"


def test_lines_not_named_start_at_nothing_and_all_means_everything(
    kitchen: TestClient, cli: Cli
) -> None:
    confirmed = order_on(kitchen, lines=TRAYS_AND_LUMPIA)
    ready = moved_to(kitchen, order_on(kitchen, "2026-10-13", TRAYS_AND_LUMPIA), "ready")
    assert cli("settings", "set", RECORDING) == 0

    assert cli("preparation", "baseline", confirmed["reference"], "--prepared=2=10", REASON) == 0
    assert cli("preparation", "baseline", ready["reference"], "--all", REASON) == 0

    assert counts(read(kitchen, confirmed["id"])) == [(0, 5), (10, 20)]
    done = read(kitchen, ready["id"])
    assert counts(done) == [(5, 0), (30, 0)]
    assert moved_to(kitchen, done, "completed")["status"] == "completed"


def test_a_ready_order_with_food_still_to_cook_is_pointed_out(
    kitchen: TestClient, cli: Cli, capsys: pytest.CaptureFixture[str]
) -> None:
    ready = moved_to(kitchen, order_on(kitchen), "ready")
    assert cli("settings", "set", RECORDING) == 0
    capsys.readouterr()

    assert cli("preparation", "baseline", ready["reference"], "--prepared=1=2", REASON) == 0

    assert "cannot be completed until the rest is recorded" in capsys.readouterr().out
    body = plan(kitchen, "?date_from=2026-10-12&date_to=2026-10-12")
    # It stays in the plan as it is: ready, with three still wanted.
    assert [(row["status"], row["remaining_quantity"]) for row in body["foods"][0]["orders"]] == [
        ("ready", 3)
    ]


def test_a_baseline_can_be_put_right_until_cooking_is_recorded_against_the_order(
    kitchen: TestClient, cli: Cli, database: Database, capsys: pytest.CaptureFixture[str]
) -> None:
    order = order_on(kitchen)
    assert cli("settings", "set", RECORDING) == 0
    assert cli("preparation", "baseline", order["reference"], "--prepared=1=4", REASON) == 0

    assert (
        cli(
            "preparation",
            "baseline",
            order["reference"],
            "--prepared=1=1",
            "--reason=Typed 4 for 1",
        )
        == 0
    )

    after = read(kitchen, order["id"])
    assert (counts(after), after["version"]) == ([(1, 4)], order["version"] + 2)
    assert [event.details["previous_tracking"] for event in baselines(database)] == [
        "manual",
        "recorded",
    ]
    prepare(kitchen, cooking([allocation(after, 1)], [], "Leftovers"))
    capsys.readouterr()
    assert cli("preparation", "baseline", order["reference"], "--prepared=1=0", REASON) == 1
    assert "preparation correction" in capsys.readouterr().err
    assert counts(read(kitchen, order["id"])) == [(2, 3)]


@pytest.mark.parametrize(
    ("arguments", "said"),
    [
        (["--prepared=3=1"], "line 3"),
        (["--prepared=0=1"], "line 0"),
        (["--prepared=1=6"], "5 were ordered"),
        (["--prepared=1=-1"], "LINE=QUANTITY"),
        (["--prepared=one=2"], "LINE=QUANTITY"),
        (["--prepared=1"], "LINE=QUANTITY"),
        (["--prepared=1=2", "--prepared=1=3"], "line 1 twice"),
        (["--prepared=1=2", "--all"], "--all"),
    ],
)
def test_a_baseline_that_makes_no_sense_is_refused_and_changes_nothing(
    kitchen: TestClient,
    cli: Cli,
    database: Database,
    capsys: pytest.CaptureFixture[str],
    arguments: list[str],
    said: str,
) -> None:
    placed = order_on(kitchen, lines=TRAYS_AND_LUMPIA)
    assert cli("settings", "set", RECORDING) == 0
    order = read(kitchen, placed["id"])
    capsys.readouterr()

    assert cli("preparation", "baseline", order["reference"], *arguments, REASON) == 1

    assert said in capsys.readouterr().err
    assert read(kitchen, order["id"]) == order
    assert baselines(database) == []


def test_a_baseline_needs_recording_on_an_open_order_and_a_reason(
    kitchen: TestClient, cli: Cli, database: Database, capsys: pytest.CaptureFixture[str]
) -> None:
    order = order_on(kitchen)
    completed = moved_to(kitchen, order_on(kitchen), "completed")
    cancelled = moved_to(kitchen, order_on(kitchen), "cancelled")
    capsys.readouterr()

    assert cli("preparation", "baseline", order["reference"], "--all", REASON) == 1
    assert "settings set --enable preparation_recording" in capsys.readouterr().err
    assert read(kitchen, order["id"]) == order

    assert cli("settings", "set", RECORDING) == 0
    order = read(kitchen, order["id"])
    assert cli("preparation", "baseline", "DEV-9999", "--all", REASON) == 1
    assert "DEV-9999" in capsys.readouterr().err
    for finished in (completed, cancelled):
        assert cli("preparation", "baseline", finished["reference"], "--all", REASON) == 1
        assert finished["status"] in capsys.readouterr().err
    assert cli("preparation", "baseline", order["reference"], "--all", "--reason=   ") == 1
    assert "reason" in capsys.readouterr().err
    # Without --reason the command is not even understood.
    assert cli("preparation", "baseline", order["reference"], "--all") == 2

    assert read(kitchen, order["id"]) == order
    assert baselines(database) == []
