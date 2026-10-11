from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from pydantic import TypeAdapter, ValidationError

from app.values import (
    MAX_SAFE_INTEGER,
    CalendarDate,
    Instant,
    Money,
    SellingQuantity,
    ValueRejected,
    format_instant,
    format_quantity,
    format_unit_cost,
    parse_quantity,
)

money = TypeAdapter(Money)
selling = TypeAdapter(SellingQuantity)
calendar = TypeAdapter(CalendarDate)
instant = TypeAdapter(Instant)


@pytest.mark.parametrize("value", [0, 1, 21500, MAX_SAFE_INTEGER])
def test_money_accepts_whole_minor_units_up_to_the_safe_bound(value: int) -> None:
    assert money.validate_python(value) == value


@pytest.mark.parametrize("value", [-1, MAX_SAFE_INTEGER + 1, 1.5, 1.0, "100", True, None])
def test_money_rejects_everything_else(value: object) -> None:
    with pytest.raises(ValidationError):
        money.validate_python(value)


@pytest.mark.parametrize("text", ["1.0", "1e3", '"100"', "true", "9007199254740992"])
def test_money_is_strict_about_json_numbers(text: str) -> None:
    with pytest.raises(ValidationError):
        money.validate_json(text)


@pytest.mark.parametrize("value", [1, 2, MAX_SAFE_INTEGER])
def test_selling_quantity_is_a_positive_whole_number(value: int) -> None:
    assert selling.validate_python(value) == value


@pytest.mark.parametrize("value", [0, -1, MAX_SAFE_INTEGER + 1, 2.0, "2", True])
def test_selling_quantity_rejects_zero_fractions_and_text(value: object) -> None:
    with pytest.raises(ValidationError):
        selling.validate_python(value)


@pytest.mark.parametrize(
    ("text", "unit", "thousandths"),
    [
        ("0", "g", 0),
        ("0.001", "g", 1),
        ("2000.000", "g", 2_000_000),
        ("750", "ml", 750_000),
        ("12.5", "ml", 12_500),
        ("3", "piece", 3_000),
        ("3.000", "piece", 3_000),
        ("9007199254740991", "g", MAX_SAFE_INTEGER * 1000),
        ("9007199254740991.000", "g", MAX_SAFE_INTEGER * 1000),
    ],
)
def test_ingredient_quantities_become_exact_thousandths(
    text: str, unit: str, thousandths: int
) -> None:
    assert parse_quantity(text, unit) == thousandths


@pytest.mark.parametrize(
    "text",
    [
        "",
        " 1",
        "1 ",
        "+1",
        "-1",
        "-0",
        "-0.000",
        "01",
        "1.",
        ".5",
        "1.0000",
        "1e3",
        "1E3",
        "1,5",
        "NaN",
        "Infinity",
        "٣",
        "9007199254740991.001",
        "9007199254740992",
    ],
)
def test_ingredient_quantities_reject_inexact_or_unsafe_text(text: str) -> None:
    with pytest.raises(ValueRejected):
        parse_quantity(text, "g")


@pytest.mark.parametrize("value", [1, 1.5, None, Decimal("1.5")])
def test_ingredient_quantities_must_be_strings(value: object) -> None:
    with pytest.raises(ValueRejected):
        parse_quantity(value, "g")


@pytest.mark.parametrize("text", ["2.5", "0.001", "3.100"])
def test_pieces_are_whole(text: str) -> None:
    with pytest.raises(ValueRejected) as rejected:
        parse_quantity(text, "piece")

    assert rejected.value.code == "whole_number_required"


def test_signed_quantities_are_accepted_only_where_a_change_is_expected() -> None:
    assert parse_quantity("-5.250", "g", signed=True) == -5_250
    assert parse_quantity("5.25", "g", signed=True) == 5_250
    assert parse_quantity("-9007199254740991", "g", signed=True) == -MAX_SAFE_INTEGER * 1000
    for text in ["-0", "-0.0", "+5", "-9007199254740991.001"]:
        with pytest.raises(ValueRejected):
            parse_quantity(text, "g", signed=True)


@pytest.mark.parametrize(
    ("thousandths", "text"),
    [(0, "0.000"), (1, "0.001"), (2_000_000, "2000.000"), (-5_250, "-5.250"), (999, "0.999")],
)
def test_quantities_are_written_with_three_decimals(thousandths: int, text: str) -> None:
    assert format_quantity(thousandths) == text
    assert parse_quantity(text, "g", signed=True) == thousandths


def test_unit_cost_is_written_with_nine_decimals_and_unknown_stays_unknown() -> None:
    assert format_unit_cost(Decimal("0.012")) == "0.012000000"
    assert format_unit_cost(Decimal(0)) == "0.000000000"
    assert format_unit_cost(Decimal(2400) / Decimal(2000) / Decimal(100)) == "0.012000000"
    assert format_unit_cost(Decimal("0.0000000005")) == "0.000000001"
    assert format_unit_cost(Decimal("0.0000000004")) == "0.000000000"
    assert format_unit_cost(None) is None


def test_calendar_dates_are_real_dates_in_one_format() -> None:
    assert calendar.validate_python("2026-10-10") == date(2026, 10, 10)
    assert calendar.validate_python("2028-02-29") == date(2028, 2, 29)
    assert calendar.dump_python(date(2026, 3, 9), mode="json") == "2026-03-09"


@pytest.mark.parametrize(
    "value",
    [
        "2026-02-30",
        "2026-2-3",
        "20261010",
        "2026-10-10T00:00:00Z",
        "2026-W41-6",
        "10/10/2026",
        " 2026-10-10",
        "",
        1760122800,
        None,
    ],
)
def test_calendar_dates_reject_other_shapes_and_impossible_days(value: object) -> None:
    with pytest.raises(ValidationError):
        calendar.validate_python(value)


def test_instants_are_written_in_utc_with_a_z() -> None:
    evening = datetime(2026, 10, 10, 19, 0, tzinfo=UTC)

    assert format_instant(evening) == "2026-10-10T19:00:00Z"
    assert format_instant(evening.astimezone(timezone(timedelta(hours=-7)))) == (
        "2026-10-10T19:00:00Z"
    )
    assert format_instant(evening.replace(microsecond=999_999)) == "2026-10-10T19:00:00Z"
    assert instant.dump_python(evening, mode="json") == "2026-10-10T19:00:00Z"


def test_an_instant_without_a_timezone_is_refused() -> None:
    with pytest.raises(ValueError):
        format_instant(datetime(2026, 10, 10, 19, 0))
