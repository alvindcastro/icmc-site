from datetime import UTC, date, datetime, time
from zoneinfo import ZoneInfo


class NonexistentTime(ValueError):
    """The local time falls in an hour that daylight saving skips."""


class WrongOffset(ValueError):
    """The stated UTC offset is not one this local time can have."""


class AmbiguousTime(ValueError):
    """The local time happens twice; `offsets` lists its occurrences, earlier first."""

    def __init__(self, offsets: list[str]) -> None:
        super().__init__("This local time happens twice.")
        self.offsets = offsets


def _offset(moment: datetime) -> str:
    offset = moment.utcoffset()
    assert offset is not None
    minutes = int(offset.total_seconds()) // 60
    return f"{'-' if minutes < 0 else '+'}{abs(minutes) // 60:02}:{abs(minutes) % 60:02}"


def resolve(day: date, clock: time, zone: ZoneInfo, offset: str | None) -> tuple[datetime, str]:
    """The instant a business-local date and time means, and the UTC offset in force then.

    Most times happen once. A time in the hour daylight saving skips does not exist. A time in
    the hour it repeats needs `offset` to say which occurrence is meant; stating an offset for
    any other time is allowed only if it is the right one.
    """
    wall = datetime.combine(day, clock)
    occurrences: dict[str, datetime] = {}
    for fold in (0, 1):
        local = wall.replace(tzinfo=zone, fold=fold)
        instant = local.astimezone(UTC)
        # A skipped time does not survive the trip to UTC and back.
        if instant.astimezone(zone).replace(tzinfo=None) == wall:
            occurrences[_offset(local)] = instant
    if not occurrences:
        raise NonexistentTime
    if offset is None:
        if len(occurrences) > 1:
            raise AmbiguousTime(list(occurrences))
        offset = next(iter(occurrences))
    if offset not in occurrences:
        raise WrongOffset
    return occurrences[offset], offset


def today(now: datetime, zone: ZoneInfo) -> date:
    """The business date: the calendar day it is now in the business timezone."""
    return now.astimezone(zone).date()
