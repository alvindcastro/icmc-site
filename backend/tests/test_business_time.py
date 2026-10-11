from datetime import UTC, date, datetime, time
from zoneinfo import ZoneInfo

import pytest

from app.services.business_time import AmbiguousTime, NonexistentTime, WrongOffset, resolve, today

LA = ZoneInfo("America/Los_Angeles")


def at(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


@pytest.mark.parametrize(
    ("day", "clock", "zone", "instant", "offset"),
    [
        (date(2026, 10, 10), time(12, 0), LA, "2026-10-10T19:00", "-07:00"),
        (date(2026, 12, 24), time(12, 0), LA, "2026-12-24T20:00", "-08:00"),
        (date(2026, 10, 10), time(23, 30), LA, "2026-10-11T06:30", "-07:00"),
        (date(2026, 10, 10), time(0, 0), ZoneInfo("Asia/Manila"), "2026-10-09T16:00", "+08:00"),
        (date(2026, 10, 10), time(9, 15), ZoneInfo("Asia/Kolkata"), "2026-10-10T03:45", "+05:30"),
        (date(2026, 1, 5), time(9, 0), ZoneInfo("America/St_Johns"), "2026-01-05T12:30", "-03:30"),
        (date(2026, 10, 10), time(12, 0), ZoneInfo("UTC"), "2026-10-10T12:00", "+00:00"),
    ],
)
def test_a_local_time_becomes_one_instant_and_its_offset(
    day: date, clock: time, zone: ZoneInfo, instant: str, offset: str
) -> None:
    assert resolve(day, clock, zone, None) == (at(instant), offset)
    assert resolve(day, clock, zone, offset) == (at(instant), offset)


@pytest.mark.parametrize("clock", [time(2, 0), time(2, 30), time(2, 59)])
def test_a_time_skipped_by_daylight_saving_does_not_exist(clock: time) -> None:
    with pytest.raises(NonexistentTime):
        resolve(date(2026, 3, 8), clock, LA, None)
    with pytest.raises(NonexistentTime):
        resolve(date(2026, 3, 8), clock, LA, "-08:00")


def test_the_minutes_either_side_of_the_skipped_hour_exist() -> None:
    assert resolve(date(2026, 3, 8), time(1, 59), LA, None) == (at("2026-03-08T09:59"), "-08:00")
    assert resolve(date(2026, 3, 8), time(3, 0), LA, None) == (at("2026-03-08T10:00"), "-07:00")


@pytest.mark.parametrize("clock", [time(1, 0), time(1, 30), time(1, 59)])
def test_a_time_that_happens_twice_needs_a_choice_of_offset(clock: time) -> None:
    with pytest.raises(AmbiguousTime) as ambiguous:
        resolve(date(2026, 11, 1), clock, LA, None)

    # The earlier occurrence, still on summer time, comes first.
    assert ambiguous.value.offsets == ["-07:00", "-08:00"]


def test_the_chosen_offset_picks_the_occurrence() -> None:
    day, clock = date(2026, 11, 1), time(1, 30)

    assert resolve(day, clock, LA, "-07:00") == (at("2026-11-01T08:30"), "-07:00")
    assert resolve(day, clock, LA, "-08:00") == (at("2026-11-01T09:30"), "-08:00")


def test_the_minutes_either_side_of_the_repeated_hour_happen_once() -> None:
    assert resolve(date(2026, 11, 1), time(0, 59), LA, None) == (at("2026-11-01T07:59"), "-07:00")
    assert resolve(date(2026, 11, 1), time(2, 0), LA, None) == (at("2026-11-01T10:00"), "-08:00")


@pytest.mark.parametrize(
    ("day", "clock", "offset"),
    [
        (date(2026, 10, 10), time(12, 0), "-08:00"),
        (date(2026, 10, 10), time(12, 0), "+07:00"),
        (date(2026, 11, 1), time(1, 30), "-05:00"),
        (date(2026, 12, 24), time(12, 0), "-07:00"),
    ],
)
def test_an_offset_that_does_not_belong_to_the_time_is_refused(
    day: date, clock: time, offset: str
) -> None:
    with pytest.raises(WrongOffset):
        resolve(day, clock, LA, offset)


@pytest.mark.parametrize(
    ("now", "business_date"),
    [
        ("2026-10-10T19:00", date(2026, 10, 10)),
        ("2026-10-11T06:59", date(2026, 10, 10)),
        ("2026-10-11T07:00", date(2026, 10, 11)),
        ("2026-01-01T07:59", date(2025, 12, 31)),
    ],
)
def test_today_is_the_date_in_the_business_timezone(now: str, business_date: date) -> None:
    assert today(at(now), LA) == business_date
