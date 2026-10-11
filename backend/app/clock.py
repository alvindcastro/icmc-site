from collections.abc import Callable
from datetime import UTC, datetime

Clock = Callable[[], datetime]


def utc_now() -> datetime:
    """The current instant in UTC, to the whole second: the precision stored and sent."""
    return datetime.now(UTC).replace(microsecond=0)
