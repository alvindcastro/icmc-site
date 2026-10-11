from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from app.api.deps import App, JsonBody, Staff, no_query
from app.errors import ApiError, parse
from app.listing import Page
from app.persistence.models import Order
from app.schemas.orders import (
    CancelIn,
    DashboardOut,
    DashboardQuery,
    LedgerResultOut,
    OrderCreate,
    OrderOut,
    OrderQuery,
    OrderSummaryOut,
    OrderUpdate,
    PaymentIn,
    QuoteIn,
    QuoteOut,
    RefundIn,
    TransitionIn,
)
from app.services import business_settings, operations, orders
from app.services.operations import Done


def orders_enabled(staff: Staff, app: App) -> None:
    with app.database.read() as db:
        business_settings.require_capability(db, "orders")


def payments_enabled(app: App) -> None:
    with app.database.read() as db:
        if not business_settings.enabled(db, "payments"):
            raise ApiError(403, "action_forbidden", "Payments are not enabled.")


router = APIRouter(tags=["orders"], dependencies=[Depends(orders_enabled)])
_plain = [Depends(no_query)]
_money = [Depends(no_query), Depends(payments_enabled)]


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
        return orders.order_out(db, order)


@router.post("/orders", status_code=201, response_model=OrderOut, dependencies=_plain)
def create(payload: JsonBody, request: Request, staff: Staff, app: App) -> Response:
    def change(db: Session) -> Done:
        order = orders.create(db, parse(OrderCreate, payload), staff.user, app.clock())
        db.flush()
        return Done(201, "order", order.id, orders.order_out(db, order))

    return operations.execute(app, request, payload, change)


@router.put("/orders/{order_id}", response_model=OrderOut, dependencies=_plain)
def update(order_id: str, payload: JsonBody, request: Request, staff: Staff, app: App) -> Response:
    def change(db: Session) -> Done:
        body = parse(OrderUpdate, payload)
        order = orders.update(db, order_id, body, staff.user, app.clock())
        db.flush()
        return Done(200, "order", order.id, orders.order_out(db, order))

    return operations.execute(app, request, payload, change)


@router.post("/orders/{order_id}/transitions", response_model=OrderOut, dependencies=_plain)
def transition(
    order_id: str, payload: JsonBody, request: Request, staff: Staff, app: App
) -> Response:
    def change(db: Session) -> Done:
        body = parse(TransitionIn, payload)
        order = orders.transition(db, order_id, body, staff.user, app.clock())
        db.flush()
        return Done(200, "order", order.id, orders.order_out(db, order))

    return operations.execute(app, request, payload, change)


@router.post("/orders/{order_id}/cancel", response_model=OrderOut, dependencies=_plain)
def cancel(order_id: str, payload: JsonBody, request: Request, staff: Staff, app: App) -> Response:
    def change(db: Session) -> Done:
        body = parse(CancelIn, payload)
        order = orders.cancel(db, order_id, body, staff.user, app.clock())
        db.flush()
        return Done(200, "order", order.id, orders.order_out(db, order))

    return operations.execute(app, request, payload, change)


@router.post(
    "/orders/{order_id}/payments",
    status_code=201,
    response_model=LedgerResultOut,
    dependencies=_money,
)
def pay(order_id: str, payload: JsonBody, request: Request, staff: Staff, app: App) -> Response:
    def change(db: Session) -> Done:
        body = parse(PaymentIn, payload)
        key = operations.key_of(request)
        entry, order = orders.pay(db, order_id, body, key, staff.user, app.clock())
        db.flush()
        result = LedgerResultOut(
            entry=orders.entry_out(order, entry), order=orders.order_out(db, order)
        )
        return Done(201, "order", order.id, result)

    return operations.execute(app, request, payload, change)


@router.post(
    "/orders/{order_id}/refunds",
    status_code=201,
    response_model=LedgerResultOut,
    dependencies=_money,
)
def refund(order_id: str, payload: JsonBody, request: Request, staff: Staff, app: App) -> Response:
    def change(db: Session) -> Done:
        body = parse(RefundIn, payload)
        key = operations.key_of(request)
        entry, order = orders.refund(db, order_id, body, key, staff.user, app.clock())
        db.flush()
        result = LedgerResultOut(
            entry=orders.entry_out(order, entry), order=orders.order_out(db, order)
        )
        return Done(201, "order", order.id, result)

    return operations.execute(app, request, payload, change)
