from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import ColumnExpressionArgument, Select, func, select
from sqlalchemy.orm import Session

from app.values import MAX_SAFE_INTEGER


class PageQuery(BaseModel):
    """Paging accepted by every list. A list's own filters extend this model.

    Declared on a route as `Annotated[PageQuery, Query()]`, it also refuses query parameters
    the list does not define.
    """

    model_config = ConfigDict(extra="forbid")

    page: int = Field(default=1, ge=1, le=MAX_SAFE_INTEGER)
    limit: int = Field(default=25, ge=1, le=100)

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.limit


class Page[T](BaseModel):
    items: list[T]
    page: int
    limit: int
    total: int
    has_next: bool


def page_of[T](items: Sequence[T], total: int, query: PageQuery) -> Page[T]:
    """One page of a list. `total` counts every match, so a page past the end is simply empty."""
    return Page(
        items=list(items),
        page=query.page,
        limit=query.limit,
        total=total,
        has_next=query.page * query.limit < total,
    )


def select_page[T](
    session: Session,
    statement: Select[T],
    query: PageQuery,
    *order: ColumnExpressionArgument[Any],
    tie_breaker: ColumnExpressionArgument[Any],
) -> tuple[list[T], int]:
    """The requested page of `statement` and its total, ordered with the ID settling ties."""
    total = session.scalar(select(func.count()).select_from(statement.order_by(None).subquery()))
    rows = session.scalars(
        statement.order_by(*order, tie_breaker).limit(query.limit).offset(query.offset)
    )
    return list(rows), total or 0
