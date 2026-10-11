from datetime import date
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool
from pydantic_core import PydanticCustomError

from app.actions import PermittedAction
from app.listing import Page, PageQuery
from app.schemas.menu import PackageContents, SellingUnit, Version
from app.values import MAX_SAFE_INTEGER, CalendarDate, Instant, Money, SellingQuantity

OrderStatus = Literal["pending", "confirmed", "preparing", "ready", "completed", "cancelled"]
PaymentStatus = Literal["unpaid", "partial", "paid", "credit_due"]
Method = Literal["pickup", "delivery"]
STATUSES: tuple[str, ...] = ("pending", "confirmed", "preparing", "ready", "completed", "cancelled")


def _entered(limit: int, message: str) -> AfterValidator:
    """Trimmed, not blank, and at most `limit` characters once trimmed."""

    def check(value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise PydanticCustomError("required", message)
        if len(trimmed) > limit:
            raise PydanticCustomError("too_long", f"Use at most {limit} characters.")
        return trimmed

    return AfterValidator(check)


def _at_least_one(items: list["ItemIn"]) -> list["ItemIn"]:
    if not items:
        raise PydanticCustomError("required", "Add at least one item.")
    return items


Text = Annotated[str, Field(strict=True)]
Notes = Annotated[str, Field(strict=True, max_length=2000)]
LocalTime = Annotated[str, Field(strict=True, pattern=r"^([01][0-9]|2[0-3]):[0-5][0-9]$")]
Offset = Annotated[str, Field(strict=True, pattern=r"^[+-][0-9]{2}:[0-9]{2}$")]
Address = Annotated[str, Field(strict=True, max_length=1000), AfterValidator(str.strip)]


class CustomerIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[Text, _entered(200, "Enter the customer name.")]
    phone: Annotated[Text, _entered(50, "Enter a contact phone.")]
    notes: Notes = ""


class FulfillmentIn(BaseModel):
    """When and how, in business-local terms. The server works out the instant."""

    model_config = ConfigDict(extra="forbid")

    method: Method
    local_date: CalendarDate
    local_time: LocalTime
    timezone: Text
    utc_offset: Offset | None = None
    address: Address | None = None


class ItemIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_line_id: Annotated[Text, _entered(200, "Give each item row an identifier.")]
    # Present for a line the order already has; such a line keeps its agreed snapshot.
    order_item_id: Text | None = None
    variant_id: Text
    quantity: SellingQuantity
    preparation_notes: Annotated[str, Field(strict=True, max_length=1000)] = ""


class DraftIn(BaseModel):
    """An order as staff entered it. It carries no prices or totals: those are the server's."""

    model_config = ConfigDict(extra="forbid")

    customer: CustomerIn
    fulfillment: FulfillmentIn
    items: Annotated[list[ItemIn], AfterValidator(_at_least_one)]
    notes: Notes = ""
    delivery_charge_minor: Money
    tax_minor: Money


class QuoteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    order_id: Text | None = None
    expected_version: Version | None = None
    draft: DraftIn


class OrderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quote_id: Text
    draft: DraftIn
    initial_status: Literal["pending", "confirmed"]
    acknowledge_credit: StrictBool


class OrderUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: Version
    quote_id: Text
    draft: DraftIn
    acknowledge_credit: StrictBool


class TransitionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: Version
    to_status: OrderStatus


class CancelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: Version
    reason: Annotated[Text, _entered(1000, "Enter a reason.")]
    # Must be true once preparation has consumed stock, which cancelling never returns.
    acknowledge_consumed_stock: StrictBool


Amount = Annotated[int, Field(strict=True, ge=1, le=MAX_SAFE_INTEGER)]
PaymentMethod = Literal["cash", "bank_transfer", "other"]
Reference = Annotated[str, Field(strict=True, max_length=200)]


class PaymentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: Version
    amount_minor: Amount
    paid_on: CalendarDate
    method: PaymentMethod
    reference: Reference = ""
    note: Notes = ""


class RefundIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: Version
    payment_id: Text
    amount_minor: Amount
    refunded_on: CalendarDate
    method: PaymentMethod
    reason: Annotated[Text, _entered(1000, "Enter a reason.")]
    reference: Reference = ""
    note: Notes = ""


class OrderQuery(PageQuery):
    q: Annotated[str | None, Field(max_length=200)] = None
    date_from: CalendarDate | None = None
    date_to: CalendarDate | None = None
    # One or more statuses separated by commas.
    status: str | None = None
    sort: Literal["fulfillment_asc", "fulfillment_desc"] = "fulfillment_asc"


class DashboardQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: CalendarDate | None = None


class FulfillmentOut(BaseModel):
    method: Method
    local_date: date
    local_time: str
    timezone: str
    utc_offset: str
    address: str | None
    fulfillment_at: Instant
    pickup_location: str | None


class LineOut(BaseModel):
    """The snapshot of a line: what was agreed, independent of the menu from then on."""

    variant_id: str
    food_name: str
    variant_label: str
    selling_unit: SellingUnit
    package_contents: PackageContents | None
    unit_price_minor: Money
    quantity: SellingQuantity
    line_total_minor: Money
    preparation_notes: str
    # Null while preparation recording is off.
    prepared_quantity: int | None
    remaining_quantity: int | None


class QuoteLineOut(LineOut):
    client_line_id: str
    order_item_id: str | None


class OrderItemOut(LineOut):
    id: str


class Amounts(BaseModel):
    currency: str
    minor_digits: int
    subtotal_minor: Money
    delivery_charge_minor: Money
    tax_minor: Money
    total_minor: Money
    settlement_total_minor: Money
    net_paid_minor: Money
    balance_due_minor: Money
    customer_credit_minor: Money


class QuoteOut(Amounts):
    id: str
    expires_at: Instant
    order_id: str | None
    expected_version: int | None
    settings_version: int
    fulfillment: FulfillmentOut
    lines: list[QuoteLineOut]
    credit_acknowledgment_required: bool


class CustomerOut(BaseModel):
    name: str
    phone: str
    notes: str


class ActorOut(BaseModel):
    id: str
    display_name: str


class StatusEventOut(BaseModel):
    id: str
    from_status: OrderStatus | None
    to_status: OrderStatus
    changed_at: Instant
    actor: ActorOut
    reason: str | None


class LedgerEntryOut(BaseModel):
    id: str
    type: Literal["payment", "refund"]
    payment_id: str | None
    amount_minor: Amount
    # For a payment, what can still be refunded from it; null for a refund.
    refundable_minor: Money | None
    business_date: date
    method: PaymentMethod
    reference: str
    note: str
    reason: str | None
    operation_id: str
    recorded_at: Instant
    recorded_by: ActorOut


class OrderOut(Amounts):
    id: str
    reference: str
    version: int
    customer: CustomerOut
    fulfillment: FulfillmentOut
    items: list[OrderItemOut]
    notes: str
    status: OrderStatus
    preparation_tracking: Literal["manual", "recorded"]
    cancellation_requires_stock_acknowledgment: bool
    payments_minor: Money
    refunds_minor: Money
    payment_status: PaymentStatus
    ledger: list[LedgerEntryOut]
    status_history: list[StatusEventOut]
    permitted_actions: dict[str, PermittedAction]
    created_at: Instant
    updated_at: Instant


class LedgerResultOut(BaseModel):
    """A recorded payment or refund together with the order as it then stands."""

    entry: LedgerEntryOut
    order: OrderOut


class OrderSummaryOut(BaseModel):
    id: str
    reference: str
    version: int
    customer_name: str
    customer_phone: str
    fulfillment_at: Instant
    fulfillment_local_date: date
    fulfillment_local_time: str
    fulfillment_timezone: str
    fulfillment_method: Method
    status: OrderStatus
    payment_status: PaymentStatus
    currency: str
    minor_digits: int
    total_minor: Money
    balance_due_minor: Money
    customer_credit_minor: Money


class DashboardOut(BaseModel):
    business_date: date
    timezone: str
    today: Page[OrderSummaryOut]
    upcoming: Page[OrderSummaryOut]
