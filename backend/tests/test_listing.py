from typing import Annotated

import pytest
from fastapi import FastAPI, Query
from fastapi.testclient import TestClient
from sqlalchemy import String, select
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.listing import Page, PageQuery, page_of, select_page
from app.persistence.database import Database
from tests.support import error_of

NAMES = [f"Dish {number:02}" for number in range(1, 61)]


class Scratch(DeclarativeBase):
    pass


class Dish(Scratch):
    __tablename__ = "probe_dishes"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)


@pytest.fixture(autouse=True)
def probe(app: FastAPI) -> None:
    @app.get("/probe/dishes")
    def dishes(query: Annotated[PageQuery, Query()]) -> Page[str]:
        return page_of(NAMES[query.offset : query.offset + query.limit], len(NAMES), query)


def test_a_list_defaults_to_the_first_page_of_twenty_five(client: TestClient) -> None:
    body = client.get("/probe/dishes").json()

    assert set(body) == {"items", "page", "limit", "total", "has_next"}
    assert body["items"] == NAMES[:25]
    assert (body["page"], body["limit"], body["total"], body["has_next"]) == (1, 25, 60, True)


def test_the_last_page_says_nothing_follows(client: TestClient) -> None:
    body = client.get("/probe/dishes", params={"page": 3, "limit": 25}).json()

    assert body["items"] == NAMES[50:]
    assert (body["page"], body["limit"], body["total"], body["has_next"]) == (3, 25, 60, False)


def test_a_page_ending_exactly_at_the_total_has_no_next(client: TestClient) -> None:
    body = client.get("/probe/dishes", params={"page": 3, "limit": 20}).json()

    assert len(body["items"]) == 20
    assert body["has_next"] is False


def test_a_page_past_the_end_is_an_empty_success_that_keeps_the_total(
    client: TestClient,
) -> None:
    response = client.get("/probe/dishes", params={"page": 9})

    assert response.status_code == 200
    assert response.json() == {"items": [], "page": 9, "limit": 25, "total": 60, "has_next": False}


def test_one_hundred_is_the_largest_page(client: TestClient) -> None:
    assert len(client.get("/probe/dishes", params={"limit": 100}).json()["items"]) == 60

    error = error_of(client.get("/probe/dishes", params={"limit": 101}), 422, "validation_failed")
    assert [field["path"] for field in error["field_errors"]] == ["/query/limit"]


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("page", "0"),
        ("page", "-1"),
        ("page", "abc"),
        ("page", "1.5"),
        ("page", ""),
        ("page", "9007199254740992"),
        ("limit", "0"),
        ("limit", "ten"),
    ],
)
def test_bad_paging_is_a_field_error_on_the_query(
    client: TestClient, name: str, value: str
) -> None:
    error = error_of(client.get("/probe/dishes", params={name: value}), 422, "validation_failed")

    assert [field["path"] for field in error["field_errors"]] == [f"/query/{name}"]


def test_an_unknown_query_parameter_is_refused_instead_of_ignored(client: TestClient) -> None:
    error = error_of(
        client.get("/probe/dishes", params={"sort": "price", "page": 1}), 422, "validation_failed"
    )

    assert [(field["path"], field["code"]) for field in error["field_errors"]] == [
        ("/query/sort", "unknown_field")
    ]


@pytest.fixture
def dishes(database: Database) -> list[tuple[str, str]]:
    """Rows inserted out of order, with repeated names so only the ID can settle ties."""
    rows = [
        ("d7", "Pancit"),
        ("d2", "Adobo"),
        ("d5", "Pancit"),
        ("d1", "Lumpia"),
        ("d9", "Adobo"),
        ("d3", "Pancit"),
        ("d4", "Bibingka"),
    ]
    with database.write() as session:
        Scratch.metadata.create_all(session.connection())
        session.add_all(Dish(id=id, name=name) for id, name in rows)
    return sorted(rows, key=lambda row: (row[1], row[0]))


def test_pages_follow_the_stated_order_with_the_id_settling_ties(
    database: Database, dishes: list[tuple[str, str]]
) -> None:
    seen: list[tuple[str, str]] = []
    for number in range(1, 5):
        with database.read() as session:
            items, total = select_page(
                session,
                select(Dish),
                PageQuery(page=number, limit=2),
                Dish.name,
                tie_breaker=Dish.id,
            )
        assert total == 7
        seen += [(dish.id, dish.name) for dish in items]

    assert seen == dishes


def test_the_total_counts_matches_not_the_page(
    database: Database, dishes: list[tuple[str, str]]
) -> None:
    with database.read() as session:
        items, total = select_page(
            session,
            select(Dish).where(Dish.name == "Pancit"),
            PageQuery(page=1, limit=2),
            Dish.name,
            tie_breaker=Dish.id,
        )
        beyond, beyond_total = select_page(
            session,
            select(Dish).where(Dish.name == "Pancit"),
            PageQuery(page=5, limit=2),
            Dish.name,
            tie_breaker=Dish.id,
        )

    assert ([dish.id for dish in items], total) == (["d3", "d5"], 3)
    assert (beyond, beyond_total) == ([], 3)
    assert page_of(items, total, PageQuery(page=1, limit=2)).has_next is True
