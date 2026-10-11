from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from app.api.deps import App, JsonBody, Staff, no_query
from app.errors import ApiError, parse
from app.listing import Page
from app.persistence.models import Order
from app.schemas.orders import (
    DashboardOut,
    DashboardQuery,
    OrderCreate,
    OrderOut,
    OrderQuery,
    OrderSummaryOut,
    OrderUpdate,
    QuoteIn,
    QuoteOut,
    TransitionIn,
)
from app.services import business_settings, operations, orders
from app.services.operations import Done


def orders_enabled(staff: Staff, app: App) -> None:
    with app.database.read() as db:
        business_settings.require_capability(db, "orders")


router = APIRouter(tags=["orders"], dependencies=[Depends(orders_enabled)])
_plain = [Depends(no_query)]


@router.get("/orders")
def find(query: Annotated[OrderQuery, Query()], app: App) -> Page[OrderSummaryOut]:
    with app.database.read() as db:
        return orders.find(db, query)


@router.get("/dashboard")
def dashboard(query: Annotated[DashboardQuery, Query()], app: App) -> DashboardOut:
    with app.database.read() as db:
        return orders.dashboard(db, query.date, app.clock())


@router.post("/orders/quote", dependencies=_plain)
def quote(body: QuoteIn, app: App) -> QuoteOut:
    """Price a draft. Nothing is saved but the quote itself, so no operation key is needed."""
    with app.database.write() as db:
        return orders.quote(db, body, app.clock())


@router.get("/orders/{order_id}", dependencies=_plain)
def read(order_id: str, app: App) -> OrderOut:
    with app.database.read() as db:
        order = db.get(Order, order_id)
        if order is None:
            raise ApiError(404, "not_found", "This order does not exist.")
        return orders.order_out(order)


@router.post("/orders", status_code=201, response_model=OrderOut, dependencies=_plain)
def create(payload: JsonBody, request: Request, staff: Staff, app: App) -> Response:
    def change(db: Session) -> Done:
        order = orders.create(db, parse(OrderCreate, payload), staff.user, app.clock())
        db.flush()
        return Done(201, "order", order.id, orders.order_out(order))

    return operations.execute(app, request, payload, change)


@router.put("/orders/{order_id}", response_model=OrderOut, dependencies=_plain)
def update(order_id: str, payload: JsonBody, request: Request, staff: Staff, app: App) -> Response:
    def change(db: Session) -> Done:
        body = parse(OrderUpdate, payload)
        order = orders.update(db, order_id, body, staff.user, app.clock())
        db.flush()
        return Done(200, "order", order.id, orders.order_out(order))

    return operations.execute(app, request, payload, change)


@router.post("/orders/{order_id}/transitions", response_model=OrderOut, dependencies=_plain)
def transition(
    order_id: str, payload: JsonBody, request: Request, staff: Staff, app: App
) -> Response:
    def change(db: Session) -> Done:
        body = parse(TransitionIn, payload)
        order = orders.transition(db, order_id, body, staff.user, app.clock())
        db.flush()
        return Done(200, "order", order.id, orders.order_out(order))

    return operations.execute(app, request, payload, change)
