from dataclasses import dataclass

import pytest

from app.errors import ApiError
from app.services.versions import advance


@dataclass
class Record:
    id: str
    version: int


def test_a_matching_version_advances_by_exactly_one() -> None:
    record = Record("food_1", 3)

    advance(record, 3, "food", lambda: {"id": "food_1", "version": 3})

    assert record.version == 4


@pytest.mark.parametrize("expected", [1, 2, 4])
def test_a_stale_or_future_version_is_a_conflict_that_changes_nothing(expected: int) -> None:
    record = Record("food_1", 3)

    with pytest.raises(ApiError) as conflict:
        advance(record, expected, "food", lambda: {"id": "food_1", "version": 3, "name": "Adobo"})

    assert (conflict.value.status, conflict.value.code) == (409, "version_conflict")
    assert conflict.value.details == {
        "resource_type": "food",
        "resource_id": "food_1",
        "expected_version": expected,
        "current_version": 3,
        "latest_resource": {"id": "food_1", "version": 3, "name": "Adobo"},
    }
    assert record.version == 3
