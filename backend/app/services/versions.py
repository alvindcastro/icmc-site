from collections.abc import Callable
from typing import Any, Protocol

from app.errors import ApiError


class Versioned(Protocol):
    id: str
    version: int


def require_current(
    record: Versioned, expected: int, resource_type: str, latest: Callable[[], Any]
) -> None:
    """Refuse a caller who has not seen the record as it is now, handing back the latest."""
    if record.version != expected:
        raise ApiError(
            409,
            "version_conflict",
            "Someone else changed this record. Review the latest version before saving.",
            details={
                "resource_type": resource_type,
                "resource_id": record.id,
                "expected_version": expected,
                "current_version": record.version,
                "latest_resource": latest(),
            },
        )


def advance(
    record: Versioned, expected: int, resource_type: str, latest: Callable[[], Any]
) -> None:
    """Move a record to its next version, provided the caller saw the current one.

    Called inside the write transaction that makes the change, so the comparison and the
    increment cannot be separated. A stale caller gets the complete current record back and
    nothing is changed.
    """
    require_current(record, expected, resource_type, latest)
    record.version += 1
