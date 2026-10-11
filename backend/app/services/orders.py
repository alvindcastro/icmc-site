import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.actions import PermittedAction, allowed, blocked
from app.errors import ApiError, FieldError, invalid
from app.ids import new_id
from app.listing import Page, PageQuery, page_of, select_page
from app.persistence.models import (
    BusinessSettings,
    Counter,
    Food,
    LedgerEntry,
    Order,
    OrderItem,
    OrderStatusEvent,
    Quote,
    StaffUser,
    Variant,
)
from app.schemas.menu import PackageContents
from app.schemas.orders import (
    STATUSES,
    CancelIn,
    DashboardOut,
    DraftIn,
    LedgerEntryOut,
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
from app.services import business_settings, business_time
from app.services.versions import advance, require_current
from app.values import MAX_SAFE_INTEGER

QUOTE_SECONDS = 300
_EDITABLE = ("pending", "confirmed")
# The action that moves an order to each status. Cancelling is a separate request.
_STEPS = {
    "confirmed": "confirm",
    "preparing": "start_preparing",
    "ready": "mark_ready",
    "completed": "complete",
}


@dataclass(frozen=True)
class PricedLine:
    """A draft line with the snapshot it will be saved with."""

    client_line_id: str
    saved: OrderItem | None
    variant: Variant
    food_name: str
    variant_label: str
    selling_unit: str
    package_quantity: int | None
    unit_price_minor: int
    quantity: int
    preparation_notes: str

    @property
    def total(self) -> int:
        return self.unit_price_minor * self.quantity

    def snapshot(self) -> dict[str, Any]:
        return {
            "variant_id": self.variant.id,
            "food_name": self.food_name,
            "variant_label": self.variant_label,
            "selling_unit": self.selling_unit,
            "package_contents": _contents(self.package_quantity),
            "unit_price_minor": self.unit_price_minor,
            "quantity": self.quantity,
            "line_total_minor": self.total,
            "preparation_notes": self.preparation_notes,
            "prepared_quantity": None,
            "remaining_quantity": None,
        }


@dataclass(frozen=True)
class Calculation:
    """Everything the server derives from a draft, and what that derivation depended on."""

    settings: BusinessSettings
    fulfillment_at: datetime
    utc_offset: str
    pickup_location: str | None
    lines: list[PricedLine]
    subtotal: int
    delivery_charge: int
    total: int
    net_paid: int
    dependencies: str


@dataclass(frozen=True)
class Settlement:
    payments: int
    refunds: int
    net_paid: int
    settlement_total: int
    balance_due: int
    customer_credit: int
    payment_status: str


def settle(total: int, status: str, payments: int = 0, refunds: int = 0) -> Settlement:
    """What is owed and what is held, by the financial policy in the decision register.

    A cancelled order owes nothing, so whatever was paid becomes credit. An order that owes
    nothing and holds nothing is paid, not unpaid.
    """
    net_paid = payments - refunds
    owed = 0 if status == "cancelled" else total
    balance, credit = max(0, owed - net_paid), max(0, net_paid - owed)
    if credit:
        payment_status = "credit_due"
    elif balance:
        payment_status = "partial" if net_paid else "unpaid"
    else:
        payment_status = "paid"
    return Settlement(payments, refunds, net_paid, owed, balance, credit, payment_status)


def _ledger_totals(order: Order) -> tuple[int, int]:
    """Payments and refunds, added up from the ledger every time: no total is stored."""
    payments = sum(entry.amount_minor for entry in order.ledger if entry.type == "payment")
    refunds = sum(entry.amount_minor for entry in order.ledger if entry.type == "refund")
    return payments, refunds


def _refundable(order: Order, payment: LedgerEntry) -> int:
    """What is left of a payment after the refunds already made from it."""
    returned = sum(entry.amount_minor for entry in order.ledger if entry.payment_id == payment.id)
    return payment.amount_minor - returned


def entry_out(order: Order, entry: LedgerEntry) -> LedgerEntryOut:
    return LedgerEntryOut.model_validate(
        {
            "id": entry.id,
            "type": entry.type,
            "payment_id": entry.payment_id,
            "amount_minor": entry.amount_minor,
            "refundable_minor": _refundable(order, entry) if entry.type == "payment" else None,
            "business_date": entry.business_date,
            "method": entry.method,
            "reference": entry.reference,
            "note": entry.note,
            "reason": entry.reason,
            "operation_id": entry.operation_id,
            "recorded_at": entry.recorded_at,
            "recorded_by": {"id": entry.actor_id, "display_name": entry.actor_display_name},
        }
    )


def _contents(quantity: int | None) -> PackageContents | None:
    return None if quantity is None else PackageContents(quantity=quantity, unit="piece")


def _hash(value: object) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8", "surrogatepass")).hexdigest()


def _fingerprint(draft: DraftIn) -> str:
    """The validated draft's content. Spelling differences that validation removes, such as
    surrounding spaces or an omitted empty note, do not make it a different draft."""
    return _hash(draft.model_dump(mode="json"))


def _stale() -> ApiError:
    return ApiError(
        409, "quote_stale", "This quote is out of date. Review a new quote before saving."
    )


def _not_found() -> ApiError:
    return ApiError(404, "not_found", "This order does not exist.")


def permitted_actions(order: Order, payments_enabled: bool) -> dict[str, PermittedAction]:
    """Every action staff could take on an order, each allowed or blocked with its reason."""
    status = order.status
    money = settle(order.total_minor, status, *_ledger_totals(order))

    def when(condition: bool, code: str, reason: str) -> PermittedAction:
        return allowed() if condition else blocked(code, reason)

    if not payments_enabled:
        pay = refund = blocked("payments_disabled", "Payments are not enabled.")
    else:
        pay = (
            blocked("order_cancelled", "Cancelled orders cannot accept payments.")
            if status == "cancelled"
            else when(money.balance_due > 0, "nothing_due", "No balance is due.")
        )
        refund = when(money.net_paid > 0, "nothing_refundable", "No refundable funds remain.")
    return {
        "edit": when(
            status in _EDITABLE,
            "order_not_editable",
            "Only pending or confirmed orders can be edited.",
        ),
        "confirm": when(
            status == "pending", "order_not_pending", "Only a pending order can be confirmed."
        ),
        "start_preparing": when(
            status == "confirmed", "order_not_confirmed", "Start preparing a confirmed order."
        ),
        # While preparation recording is off, staff attest that the food is ready.
        "mark_ready": when(
            status == "preparing", "order_not_preparing", "Mark ready after preparation starts."
        ),
        "complete": when(status == "ready", "order_not_ready", "Complete a ready order."),
        "cancel": when(
            status in ("pending", "confirmed", "preparing", "ready"),
            "order_finished",
            "Completed or cancelled orders cannot be cancelled.",
        ),
        "record_payment": pay,
        "refund": refund,
        "record_preparation": blocked(
            "preparation_recording_disabled", "Preparation recording is not enabled."
        ),
    }


def order_out(db: Session, order: Order) -> OrderOut:
    money = settle(order.total_minor, order.status, *_ledger_totals(order))
    payments_enabled = business_settings.enabled(db, "payments")
    items = sorted(
        (item for item in order.lines if item.removed_at is None), key=lambda item: item.position
    )
    return OrderOut.model_validate(
        {
            "id": order.id,
            "reference": order.reference,
            "version": order.version,
            "currency": order.currency,
            "minor_digits": order.minor_digits,
            "customer": {
                "name": order.customer_name,
                "phone": order.customer_phone,
                "notes": order.customer_notes,
            },
            "fulfillment": {
                "method": order.fulfillment_method,
                "local_date": order.local_date,
                "local_time": order.local_time,
                "timezone": order.timezone,
                "utc_offset": order.utc_offset,
                "address": order.address,
                "fulfillment_at": order.fulfillment_at,
                "pickup_location": order.pickup_location,
            },
            "items": [
                {
                    "id": item.id,
                    "variant_id": item.variant_id,
                    "food_name": item.food_name,
                    "variant_label": item.variant_label,
                    "selling_unit": item.selling_unit,
                    "package_contents": _contents(item.package_quantity),
                    "unit_price_minor": item.unit_price_minor,
                    "quantity": item.quantity,
                    "line_total_minor": item.unit_price_minor * item.quantity,
                    "preparation_notes": item.preparation_notes,
                    "prepared_quantity": None,
                    "remaining_quantity": None,
                }
                for item in items
            ],
            "notes": order.notes,
            "status": order.status,
            "preparation_tracking": order.preparation_tracking,
            "cancellation_requires_stock_acknowledgment": False,
            "subtotal_minor": order.subtotal_minor,
            "delivery_charge_minor": order.delivery_charge_minor,
            "tax_minor": order.tax_minor,
            "total_minor": order.total_minor,
            "settlement_total_minor": money.settlement_total,
            "payments_minor": money.payments,
            "refunds_minor": money.refunds,
            "net_paid_minor": money.net_paid,
            "balance_due_minor": money.balance_due,
            "customer_credit_minor": money.customer_credit,
            "payment_status": money.payment_status,
            "ledger": [entry_out(order, entry) for entry in order.ledger],
            "status_history": [
                {
                    "id": event.id,
                    "from_status": event.from_status,
                    "to_status": event.to_status,
                    "changed_at": event.changed_at,
                    "actor": {"id": event.actor_id, "display_name": event.actor_display_name},
                    "reason": event.reason,
                }
                for event in sorted(order.events, key=lambda event: event.sequence)
            ],
            "permitted_actions": permitted_actions(order, payments_enabled),
            "created_at": order.created_at,
            "updated_at": order.updated_at,
        }
    )


def summary_out(order: Order) -> OrderSummaryOut:
    money = settle(order.total_minor, order.status, *_ledger_totals(order))
    return OrderSummaryOut(
        id=order.id,
        reference=order.reference,
        version=order.version,
        customer_name=order.customer_name,
        customer_phone=order.customer_phone,
        fulfillment_at=order.fulfillment_at,
        fulfillment_local_date=order.local_date,
        fulfillment_local_time=order.local_time,
        fulfillment_timezone=order.timezone,
        fulfillment_method=order.fulfillment_method,
        status=order.status,
        payment_status=money.payment_status,
        currency=order.currency,
        minor_digits=order.minor_digits,
        total_minor=order.total_minor,
        balance_due_minor=money.balance_due,
        customer_credit_minor=money.customer_credit,
    )


def _latest(db: Session, order: Order) -> Any:
    return order_out(db, order).model_dump(mode="json")


def calculate(db: Session, draft: DraftIn, order: Order | None) -> Calculation:
    """Validate a draft against the business as it is now and work out its totals.

    Lines the order already has keep their agreed snapshot. New lines, and lines whose
    quantity grows, need a variant that can be sold now, and tie the result to the versions
    of that variant and its food.
    """
    settings = business_settings.require(db)
    business_settings.require_confirmed(settings, *business_settings.CONFIRMABLE)
    chosen = draft.fulfillment
    problems: list[FieldError] = []

    def refuse(path: str, code: str, message: str) -> None:
        problems.append(FieldError(f"/draft/{path}", code, message))

    if chosen.method not in settings.fulfillment_methods:
        refuse("fulfillment/method", "method_not_offered", "This method is not offered.")
    elif chosen.method == "delivery" and settings.delivery_mode == "disabled":
        refuse("fulfillment/method", "delivery_disabled", "Delivery is not enabled.")
    if chosen.timezone != settings.timezone:
        refuse("fulfillment/timezone", "wrong_timezone", "Use the business timezone.")
    if chosen.method == "delivery" and not chosen.address:
        refuse("fulfillment/address", "required", "Enter a delivery address.")
    if chosen.method == "pickup" and chosen.address is not None:
        refuse("fulfillment/address", "not_delivery", "Pickup has no delivery address.")
    if chosen.method == "pickup" and draft.delivery_charge_minor != 0:
        refuse("delivery_charge_minor", "not_delivery", "Pickup has no delivery charge.")
    if problems:
        raise invalid(*problems)

    try:
        fulfillment_at, utc_offset = business_time.resolve(
            chosen.local_date,
            time.fromisoformat(chosen.local_time),
            ZoneInfo(settings.timezone),
            chosen.utc_offset,
        )
    except business_time.NonexistentTime:
        refuse("fulfillment/local_time", "nonexistent_time", "This time is skipped by the clocks.")
        raise invalid(*problems) from None
    except business_time.WrongOffset:
        refuse("fulfillment/utc_offset", "invalid_offset", "This offset does not fit the time.")
        raise invalid(*problems) from None
    except business_time.AmbiguousTime as twice:
        refuse("fulfillment/utc_offset", "ambiguous_time", "Choose which occurrence is meant.")
        raise ApiError(
            422,
            "validation_failed",
            "Check the highlighted fields.",
            field_errors=problems,
            details={"utc_offsets": twice.offsets},
        ) from None

    saved_lines = (
        {item.id: item for item in order.lines if item.removed_at is None} if order else {}
    )
    lines: list[PricedLine] = []
    bound: list[list[Any]] = []
    client_ids: set[str] = set()
    saved_ids: set[str] = set()
    for index, item in enumerate(draft.items):
        if item.client_line_id in client_ids:
            refuse(f"items/{index}/client_line_id", "duplicate", "Row identifiers must differ.")
            continue
        client_ids.add(item.client_line_id)
        saved = None
        if item.order_item_id is not None:
            saved = saved_lines.get(item.order_item_id)
            if saved is None or saved.variant_id != item.variant_id or saved.id in saved_ids:
                refuse(
                    f"items/{index}/variant_id",
                    "saved_line_mismatch",
                    "A saved line keeps its variant. Remove it and add a new line instead.",
                )
                continue
            saved_ids.add(saved.id)
        variant = db.get(Variant, item.variant_id)
        food = db.get(Food, variant.food_id) if variant is not None else None
        growing = saved is None or item.quantity > saved.quantity
        if (
            variant is None
            or food is None
            or (growing and not (food.available and variant.available))
        ):
            refuse(
                f"items/{index}/variant_id",
                "unavailable",
                "This variant is not available for new or larger quantities.",
            )
            continue
        if growing:
            confirmed = "confirmed" == food.confirmation_status == variant.confirmation_status
            if settings.environment == "live" and not confirmed:
                raise ApiError(
                    409,
                    "menu_unconfirmed",
                    "This menu item must be confirmed before it can be sold.",
                    details={"food_id": food.id, "variant_id": variant.id},
                )
            bound.append([food.id, food.version, variant.id, variant.version])
        source: OrderItem | Variant = saved if saved is not None else variant
        line = PricedLine(
            client_line_id=item.client_line_id,
            saved=saved,
            variant=variant,
            food_name=saved.food_name if saved is not None else food.name,
            variant_label=saved.variant_label if saved is not None else variant.label,
            selling_unit=source.selling_unit,
            package_quantity=source.package_quantity,
            unit_price_minor=saved.unit_price_minor if saved is not None else variant.price_minor,
            quantity=item.quantity,
            preparation_notes=item.preparation_notes,
        )
        if line.total > MAX_SAFE_INTEGER:
            refuse(f"items/{index}/quantity", "overflow", "This quantity is too large.")
            continue
        lines.append(line)
    if problems:
        raise invalid(*problems)

    subtotal = sum(line.total for line in lines)
    if subtotal > MAX_SAFE_INTEGER:
        raise invalid(FieldError("/draft/items", "overflow", "The order amount is too large."))
    if chosen.method == "pickup":
        charge = 0
    elif settings.delivery_mode == "fixed_amount" and settings.fixed_charge_minor is not None:
        # The business sets the charge; whatever the draft says is not used.
        charge = settings.fixed_charge_minor
    else:
        charge = draft.delivery_charge_minor
    total = subtotal + charge + draft.tax_minor
    if total > MAX_SAFE_INTEGER:
        raise invalid(FieldError("/draft/tax_minor", "overflow", "The order total is too large."))
    payments, refunds = _ledger_totals(order) if order else (0, 0)
    return Calculation(
        settings=settings,
        fulfillment_at=fulfillment_at,
        utc_offset=utc_offset,
        pickup_location=settings.pickup_location if chosen.method == "pickup" else None,
        lines=lines,
        subtotal=subtotal,
        delivery_charge=charge,
        total=total,
        net_paid=payments - refunds,
        dependencies=_hash([settings.version, sorted(bound)]),
    )


def quote(db: Session, body: QuoteIn, now: datetime) -> QuoteOut:
    """Price a draft and remember what the price depends on, for five minutes."""
    order = None
    if (body.order_id is None) != (body.expected_version is None):
        missing = "/order_id" if body.order_id is None else "/expected_version"
        raise invalid(FieldError(missing, "required", "State the order and its version together."))
    if body.order_id is not None and body.expected_version is not None:
        order = db.get(Order, body.order_id)
        if order is None:
            raise _not_found()
        require_current(order, body.expected_version, "order", lambda: _latest(db, order))
        _require_editable(db, order)
    result = calculate(db, body.draft, order)
    # Anyone signed in can ask for quotes freely, so finished ones are cleared as new ones come.
    db.execute(delete(Quote).where(Quote.expires_at <= now))
    stored = Quote(
        id=new_id("quote"),
        order_id=body.order_id,
        expected_version=body.expected_version,
        draft_fingerprint=_fingerprint(body.draft),
        dependencies=result.dependencies,
        expires_at=now + timedelta(seconds=QUOTE_SECONDS),
        created_at=now,
    )
    db.add(stored)
    money = settle(result.total, order.status if order else "pending", result.net_paid)
    chosen = body.draft.fulfillment
    return QuoteOut.model_validate(
        {
            "id": stored.id,
            "expires_at": stored.expires_at,
            "order_id": stored.order_id,
            "expected_version": stored.expected_version,
            "settings_version": result.settings.version,
            "currency": result.settings.currency,
            "minor_digits": result.settings.minor_digits,
            "fulfillment": {
                "method": chosen.method,
                "local_date": chosen.local_date,
                "local_time": chosen.local_time,
                "timezone": chosen.timezone,
                "utc_offset": result.utc_offset,
                "address": chosen.address,
                "fulfillment_at": result.fulfillment_at,
                "pickup_location": result.pickup_location,
            },
            "lines": [
                {
                    **line.snapshot(),
                    "client_line_id": line.client_line_id,
                    "order_item_id": line.saved.id if line.saved is not None else None,
                }
                for line in result.lines
            ],
            "subtotal_minor": result.subtotal,
            "delivery_charge_minor": result.delivery_charge,
            "tax_minor": body.draft.tax_minor,
            "total_minor": result.total,
            "settlement_total_minor": money.settlement_total,
            "net_paid_minor": money.net_paid,
            "balance_due_minor": money.balance_due,
            "customer_credit_minor": money.customer_credit,
            "credit_acknowledgment_required": money.customer_credit > 0,
        }
    )


def _actions(db: Session, order: Order) -> dict[str, PermittedAction]:
    return permitted_actions(order, business_settings.enabled(db, "payments"))


def _require_editable(db: Session, order: Order) -> None:
    edit = _actions(db, order)["edit"]
    if not edit.allowed:
        raise ApiError(403, "action_forbidden", edit.reason or "This order cannot be edited.")


def _agreed(
    db: Session,
    quote_id: str,
    draft: DraftIn,
    order: Order | None,
    expected_version: int | None,
    now: datetime,
) -> Calculation:
    """Check that a save is exactly what was quoted and that nothing it rests on has moved,
    then spend the quote. Returns the calculation to save."""
    stored = db.get(Quote, quote_id)
    if (
        stored is None
        or now >= stored.expires_at
        or stored.order_id != (order.id if order else None)
        or stored.expected_version != expected_version
        or stored.draft_fingerprint != _fingerprint(draft)
    ):
        raise _stale()
    result = calculate(db, draft, order)
    if result.dependencies != stored.dependencies:
        raise _stale()
    # One quote buys one save, so a repeat under a new operation key cannot duplicate it.
    db.delete(stored)
    return result


def _event(
    order: Order,
    from_status: str | None,
    to_status: str,
    actor: StaffUser,
    now: datetime,
    reason: str | None = None,
) -> None:
    order.events.append(
        OrderStatusEvent(
            id=new_id("evt"),
            sequence=len(order.events),
            from_status=from_status,
            to_status=to_status,
            changed_at=now,
            actor_id=actor.id,
            actor_display_name=actor.display_name,
            reason=reason,
        )
    )


def _write(order: Order, draft: DraftIn, result: Calculation, now: datetime) -> None:
    """Put a calculated draft onto an order: details, totals and lines in the draft's order."""
    chosen = draft.fulfillment
    order.customer_name = draft.customer.name
    order.customer_phone = draft.customer.phone
    order.customer_notes = draft.customer.notes
    order.notes = draft.notes
    order.search_key = f"{order.reference} {order.customer_name} {order.customer_phone}".casefold()
    order.fulfillment_method = chosen.method
    order.local_date = chosen.local_date
    order.local_time = chosen.local_time
    order.timezone = chosen.timezone
    order.utc_offset = result.utc_offset
    order.fulfillment_at = result.fulfillment_at
    order.address = chosen.address
    order.pickup_location = result.pickup_location
    order.currency = result.settings.currency
    order.minor_digits = result.settings.minor_digits
    order.subtotal_minor = result.subtotal
    order.delivery_charge_minor = result.delivery_charge
    order.tax_minor = draft.tax_minor
    order.total_minor = result.total
    order.updated_at = now
    current: set[str] = set()
    for position, line in enumerate(result.lines):
        item = line.saved
        if item is None:
            item = OrderItem(
                id=new_id("item"),
                variant_id=line.variant.id,
                food_name=line.food_name,
                variant_label=line.variant_label,
                selling_unit=line.selling_unit,
                package_quantity=line.package_quantity,
                unit_price_minor=line.unit_price_minor,
                removed_at=None,
            )
            order.lines.append(item)
        item.position = position
        item.quantity = line.quantity
        item.preparation_notes = line.preparation_notes
        current.add(item.id)
        # From now on the variant's unit and package contents are fixed.
        line.variant.used_on_order = True
    for item in order.lines:
        if item.removed_at is None and item.id not in current:
            item.removed_at = now


def _next_number(db: Session, name: str) -> int:
    counter = db.get(Counter, name)
    if counter is None:
        counter = Counter(name=name, value=0)
        db.add(counter)
    counter.value += 1
    return counter.value


def create(db: Session, body: OrderCreate, actor: StaffUser, now: datetime) -> Order:
    result = _agreed(db, body.quote_id, body.draft, None, None, now)
    # Development orders are marked as such in the reference staff and customers see.
    prefix = "ORD" if result.settings.environment == "live" else "DEV"
    order = Order(
        id=new_id("ord"),
        reference=f"{prefix}-{_next_number(db, 'order_reference'):04d}",
        version=1,
        status=body.initial_status,
        preparation_tracking="manual",
        created_at=now,
    )
    _write(order, body.draft, result, now)
    _event(order, None, "pending", actor, now)
    if body.initial_status == "confirmed":
        _event(order, "pending", "confirmed", actor, now)
    db.add(order)
    return order


def update(db: Session, order_id: str, body: OrderUpdate, actor: StaffUser, now: datetime) -> Order:
    """Replace an order's details and lines with a reviewed draft. Its status never changes."""
    order = db.get(Order, order_id)
    if order is None:
        raise _not_found()
    advance(order, body.expected_version, "order", lambda: _latest(db, order))
    _require_editable(db, order)
    result = _agreed(db, body.quote_id, body.draft, order, body.expected_version, now)
    if result.net_paid > result.total and not body.acknowledge_credit:
        raise invalid(
            FieldError(
                "/acknowledge_credit",
                "required",
                "Acknowledge that this edit leaves the customer in credit.",
            )
        )
    _write(order, body.draft, result, now)
    return order


def transition(
    db: Session, order_id: str, body: TransitionIn, actor: StaffUser, now: datetime
) -> Order:
    order = db.get(Order, order_id)
    if order is None:
        raise _not_found()
    advance(order, body.expected_version, "order", lambda: _latest(db, order))
    step = _STEPS.get(body.to_status)
    action = _actions(db, order).get(step) if step else None
    if action is None or not action.allowed:
        reason = action.reason if action else None
        raise ApiError(
            409, "action_not_allowed", reason or "Only the next fulfillment step is allowed."
        )
    _event(order, order.status, body.to_status, actor, now)
    order.status = body.to_status
    order.updated_at = now
    return order


def cancel(db: Session, order_id: str, body: CancelIn, actor: StaffUser, now: datetime) -> Order:
    """Cancel an open order. Its lines, totals and ledger stay as they were: only what is owed
    goes to nothing, so anything already paid shows as credit to be refunded separately."""
    order = db.get(Order, order_id)
    if order is None:
        raise _not_found()
    advance(order, body.expected_version, "order", lambda: _latest(db, order))
    action = _actions(db, order)["cancel"]
    if not action.allowed:
        raise ApiError(
            409, "action_not_allowed", action.reason or "This order cannot be cancelled."
        )
    _event(order, order.status, "cancelled", actor, now, body.reason)
    order.status = "cancelled"
    order.updated_at = now
    return order


def _too_much(maximum: int, message: str) -> ApiError:
    return ApiError(
        422,
        "validation_failed",
        "Check the highlighted fields.",
        field_errors=[FieldError("/amount_minor", "exceeds_maximum", message)],
        details={"maximum_amount_minor": maximum},
    )


def _record(
    db: Session,
    order_id: str,
    expected_version: int,
    action_name: str,
    method: str,
) -> Order:
    """The checks a payment and a refund share: the order, its version, the action, the method."""
    order = db.get(Order, order_id)
    if order is None:
        raise _not_found()
    advance(order, expected_version, "order", lambda: _latest(db, order))
    action = _actions(db, order)[action_name]
    if not action.allowed:
        raise ApiError(403, "action_forbidden", action.reason or "This is not allowed.")
    if method not in business_settings.require(db).payment_methods:
        raise invalid(
            FieldError(
                "/method", "method_not_accepted", "The business does not accept this method."
            )
        )
    return order


def _append(
    order: Order,
    kind: str,
    amount: int,
    business_date: date,
    body: PaymentIn | RefundIn,
    key: str,
    actor: StaffUser,
    now: datetime,
) -> LedgerEntry:
    entry = LedgerEntry(
        id=new_id("led"),
        sequence=len(order.ledger),
        type=kind,
        payment_id=body.payment_id if isinstance(body, RefundIn) else None,
        amount_minor=amount,
        business_date=business_date,
        method=body.method,
        reference=body.reference,
        note=body.note,
        reason=body.reason if isinstance(body, RefundIn) else None,
        operation_id=key,
        recorded_at=now,
        actor_id=actor.id,
        actor_display_name=actor.display_name,
    )
    order.ledger.append(entry)
    order.updated_at = now
    return entry


def pay(
    db: Session, order_id: str, body: PaymentIn, key: str, actor: StaffUser, now: datetime
) -> tuple[LedgerEntry, Order]:
    """Record a payment of no more than is due. The balance is read inside the transaction
    that adds the entry, and the order's version moves with it, so two payments made at once
    cannot both be accepted."""
    order = _record(db, order_id, body.expected_version, "record_payment", body.method)
    payments, refunds = _ledger_totals(order)
    due = settle(order.total_minor, order.status, payments, refunds).balance_due
    if body.amount_minor > due:
        raise _too_much(due, "Enter no more than the balance due.")
    if payments + body.amount_minor > MAX_SAFE_INTEGER:
        raise invalid(FieldError("/amount_minor", "overflow", "This amount is too large."))
    return _append(order, "payment", body.amount_minor, body.paid_on, body, key, actor, now), order


def refund(
    db: Session, order_id: str, body: RefundIn, key: str, actor: StaffUser, now: datetime
) -> tuple[LedgerEntry, Order]:
    """Record a refund from one original payment, up to what is left of that payment."""
    order = _record(db, order_id, body.expected_version, "refund", body.method)
    original = next(
        (
            entry
            for entry in order.ledger
            if entry.id == body.payment_id and entry.type == "payment"
        ),
        None,
    )
    if original is None:
        raise invalid(
            FieldError("/payment_id", "unknown_payment", "Choose a payment of this order.")
        )
    # A payment's refunds never exceed it, so this limit also keeps net paid from going negative.
    remaining = _refundable(order, original)
    if body.amount_minor > remaining:
        raise _too_much(remaining, "Enter no more than is left of this payment.")
    return _append(
        order, "refund", body.amount_minor, body.refunded_on, body, key, actor, now
    ), order


def _statuses(text: str | None) -> list[str]:
    if text is None:
        return []
    chosen = text.split(",")
    if any(status not in STATUSES for status in chosen):
        raise invalid(
            FieldError(
                "/query/status", "invalid_status", f"Use one or more of: {', '.join(STATUSES)}."
            )
        )
    return chosen


def find(db: Session, query: OrderQuery) -> Page[OrderSummaryOut]:
    statement = select(Order)
    text = (query.q or "").strip()
    if text:
        statement = statement.where(Order.search_key.contains(text.casefold(), autoescape=True))
    if query.date_from and query.date_to and query.date_from > query.date_to:
        raise invalid(
            FieldError("/query/date_to", "before_date_from", "End on or after the start date.")
        )
    # Dates are days of the business calendar, compared with the day the order was entered for.
    if query.date_from:
        statement = statement.where(Order.local_date >= query.date_from)
    if query.date_to:
        statement = statement.where(Order.local_date <= query.date_to)
    statuses = _statuses(query.status)
    if statuses:
        statement = statement.where(Order.status.in_(statuses))
    if query.sort == "fulfillment_desc":
        found, total = select_page(
            db, statement, query, Order.fulfillment_at.desc(), tie_breaker=Order.id.desc()
        )
    else:
        found, total = select_page(db, statement, query, Order.fulfillment_at, tie_breaker=Order.id)
    return page_of([summary_out(order) for order in found], total, query)


def dashboard(db: Session, day: date | None, now: datetime) -> DashboardOut:
    """One business day's orders and what comes after it: the first 25 of each."""
    settings = business_settings.require(db)
    day = day or business_time.today(now, ZoneInfo(settings.timezone))
    first = PageQuery()

    def collection(*conditions: Any) -> Page[OrderSummaryOut]:
        found, total = select_page(
            db, select(Order).where(*conditions), first, Order.fulfillment_at, tie_breaker=Order.id
        )
        return page_of([summary_out(order) for order in found], total, first)

    return DashboardOut(
        business_date=day,
        timezone=settings.timezone,
        # Today keeps completed orders for the day's review; neither list shows cancelled ones.
        today=collection(Order.local_date == day, Order.status != "cancelled"),
        upcoming=collection(
            Order.local_date > day, Order.status.not_in(("cancelled", "completed"))
        ),
    )
