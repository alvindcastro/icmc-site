from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    Dialect,
    ForeignKey,
    MetaData,
    String,
    Text,
    TypeDecorator,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class UtcInstant(TypeDecorator[datetime]):
    """An instant, stored in UTC and always returned with its timezone."""

    impl = DateTime
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if value.utcoffset() is None:
            raise ValueError("An instant needs a timezone.")
        return value.astimezone(UTC).replace(tzinfo=None)

    def process_result_value(self, value: Any | None, dialect: Dialect) -> datetime | None:
        return None if value is None else value.replace(tzinfo=UTC)


class Base(DeclarativeBase):
    # Every constraint gets a predictable name, which later migrations need to alter it.
    metadata = MetaData(
        naming_convention={
            "ix": "ix_%(column_0_label)s",
            "uq": "uq_%(table_name)s_%(column_0_name)s",
            "ck": "ck_%(table_name)s_%(constraint_name)s",
            "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
            "pk": "pk_%(table_name)s",
        }
    )


class StaffUser(Base):
    __tablename__ = "staff_users"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    username: Mapped[str] = mapped_column(String, unique=True)
    display_name: Mapped[str] = mapped_column(String)
    role: Mapped[str] = mapped_column(String)
    # A salted hash of the sign-in token; null until the operator sets one.
    token_hash: Mapped[str | None] = mapped_column(String)
    token_set_at: Mapped[datetime | None] = mapped_column(UtcInstant)
    created_at: Mapped[datetime] = mapped_column(UtcInstant)


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    # A hash of the cookie value, so a copy of the database cannot be replayed as a session.
    id_hash: Mapped[str] = mapped_column(String, primary_key=True)
    # Null while nobody has signed in on it yet: a short-lived session that only carries CSRF.
    user_id: Mapped[str | None] = mapped_column(ForeignKey("staff_users.id"), index=True)
    csrf_token: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(UtcInstant)
    idle_expires_at: Mapped[datetime] = mapped_column(UtcInstant)
    absolute_expires_at: Mapped[datetime] = mapped_column(UtcInstant)
    ended_at: Mapped[datetime | None] = mapped_column(UtcInstant)


class SignInFailure(Base):
    __tablename__ = "sign_in_failures"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    failed_at: Mapped[datetime] = mapped_column(UtcInstant)


class BusinessSettings(Base):
    __tablename__ = "business_settings"
    __table_args__ = (CheckConstraint("id = 1", name="single_row"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=False)
    version: Mapped[int] = mapped_column()
    environment: Mapped[str] = mapped_column(String)
    currency: Mapped[str] = mapped_column(String)
    minor_digits: Mapped[int] = mapped_column()
    timezone: Mapped[str] = mapped_column(String)
    fulfillment_methods: Mapped[list[str]] = mapped_column(JSON)
    pickup_location: Mapped[str | None] = mapped_column(String)
    delivery_mode: Mapped[str] = mapped_column(String)
    fixed_charge_minor: Mapped[int | None] = mapped_column(BigInteger)
    tax_mode: Mapped[str] = mapped_column(String)
    tax_inclusive: Mapped[bool] = mapped_column()
    payment_methods: Mapped[list[str]] = mapped_column(JSON)
    # Names of the enabled capabilities and of the confirmed setting groups.
    capabilities: Mapped[list[str]] = mapped_column(JSON)
    confirmed: Mapped[list[str]] = mapped_column(JSON)
    confirmed_at: Mapped[datetime | None] = mapped_column(UtcInstant)
    updated_at: Mapped[datetime] = mapped_column(UtcInstant)


class Operation(Base):
    """One keyed mutation: what was asked, and the answer it was given, kept for good."""

    __tablename__ = "operations"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    method: Mapped[str] = mapped_column(String)
    path: Mapped[str] = mapped_column(String)
    # A hash of method, path and canonical JSON body: the same key must mean the same request.
    fingerprint: Mapped[str] = mapped_column(String)
    state: Mapped[str] = mapped_column(String)
    resource_type: Mapped[str | None] = mapped_column(String)
    resource_id: Mapped[str | None] = mapped_column(String)
    # The answer exactly as it was sent, so a replay is the same bytes.
    http_status: Mapped[int | None] = mapped_column()
    body: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(UtcInstant)
    completed_at: Mapped[datetime | None] = mapped_column(UtcInstant)


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    # The name with letter case folded away: what uniqueness, search and ordering go by.
    name_key: Mapped[str] = mapped_column(String, unique=True)
    created_at: Mapped[datetime] = mapped_column(UtcInstant)


class Food(Base):
    __tablename__ = "foods"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    version: Mapped[int] = mapped_column()
    name: Mapped[str] = mapped_column(String)
    name_key: Mapped[str] = mapped_column(String, index=True)
    category_id: Mapped[str] = mapped_column(ForeignKey("categories.id"), index=True)
    description: Mapped[str] = mapped_column(Text)
    available: Mapped[bool] = mapped_column()
    confirmation_status: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(UtcInstant)
    updated_at: Mapped[datetime] = mapped_column(UtcInstant)

    variants: Mapped[list["Variant"]] = relationship(order_by="Variant.position", lazy="selectin")


class Variant(Base):
    __tablename__ = "variants"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    version: Mapped[int] = mapped_column()
    food_id: Mapped[str] = mapped_column(ForeignKey("foods.id"), index=True)
    # The order variants were added in, which is the order staff see them in.
    position: Mapped[int] = mapped_column()
    label: Mapped[str] = mapped_column(String)
    selling_unit: Mapped[str] = mapped_column(String)
    price_minor: Mapped[int] = mapped_column(BigInteger)
    available: Mapped[bool] = mapped_column()
    confirmation_status: Mapped[str] = mapped_column(String)
    # Pieces in one package; null for every other selling unit.
    package_quantity: Mapped[int | None] = mapped_column(BigInteger)
    # Set by the first order that uses the variant; its unit and package are fixed from then on.
    used_on_order: Mapped[bool] = mapped_column()
    created_at: Mapped[datetime] = mapped_column(UtcInstant)
    updated_at: Mapped[datetime] = mapped_column(UtcInstant)


class AuditEvent(Base):
    """An append-only note of something done outside the ordinary record history."""

    __tablename__ = "audit_events"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(UtcInstant)
    actor: Mapped[str] = mapped_column(String)
    action: Mapped[str] = mapped_column(String)
    resource_type: Mapped[str] = mapped_column(String)
    resource_id: Mapped[str] = mapped_column(String)
    details: Mapped[dict[str, Any]] = mapped_column(JSON)


class Counter(Base):
    """A named running number, advanced inside the transaction that uses it."""

    __tablename__ = "counters"

    name: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[int] = mapped_column(BigInteger)


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    # What staff and customers call the order, such as DEV-0001.
    reference: Mapped[str] = mapped_column(String, unique=True)
    version: Mapped[int] = mapped_column()
    status: Mapped[str] = mapped_column(String, index=True)
    customer_name: Mapped[str] = mapped_column(String)
    customer_phone: Mapped[str] = mapped_column(String)
    customer_notes: Mapped[str] = mapped_column(Text)
    notes: Mapped[str] = mapped_column(Text)
    # Reference, name and phone with letter case folded away, for search.
    search_key: Mapped[str] = mapped_column(Text)
    fulfillment_method: Mapped[str] = mapped_column(String)
    # The business-local date and time as staff entered them, with the timezone they meant.
    local_date: Mapped[date] = mapped_column(Date, index=True)
    local_time: Mapped[str] = mapped_column(String)
    timezone: Mapped[str] = mapped_column(String)
    utc_offset: Mapped[str] = mapped_column(String)
    fulfillment_at: Mapped[datetime] = mapped_column(UtcInstant, index=True)
    address: Mapped[str | None] = mapped_column(Text)
    pickup_location: Mapped[str | None] = mapped_column(String)
    # The currency the totals were agreed in.
    currency: Mapped[str] = mapped_column(String)
    minor_digits: Mapped[int] = mapped_column()
    subtotal_minor: Mapped[int] = mapped_column(BigInteger)
    delivery_charge_minor: Mapped[int] = mapped_column(BigInteger)
    tax_minor: Mapped[int] = mapped_column(BigInteger)
    total_minor: Mapped[int] = mapped_column(BigInteger)
    preparation_tracking: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(UtcInstant)
    updated_at: Mapped[datetime] = mapped_column(UtcInstant)

    # Every line the order has ever had; `OrderItem.removed_at` marks the ones edited away.
    lines: Mapped[list["OrderItem"]] = relationship(order_by="OrderItem.position", lazy="selectin")
    events: Mapped[list["OrderStatusEvent"]] = relationship(
        order_by="OrderStatusEvent.sequence", lazy="selectin"
    )
    ledger: Mapped[list["LedgerEntry"]] = relationship(
        order_by="LedgerEntry.sequence", lazy="selectin"
    )


class OrderItem(Base):
    """One line of an order: a snapshot of what was agreed, which never follows the menu."""

    __tablename__ = "order_items"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    position: Mapped[int] = mapped_column()
    variant_id: Mapped[str] = mapped_column(ForeignKey("variants.id"), index=True)
    food_name: Mapped[str] = mapped_column(String)
    variant_label: Mapped[str] = mapped_column(String)
    selling_unit: Mapped[str] = mapped_column(String)
    package_quantity: Mapped[int | None] = mapped_column(BigInteger)
    unit_price_minor: Mapped[int] = mapped_column(BigInteger)
    quantity: Mapped[int] = mapped_column(BigInteger)
    preparation_notes: Mapped[str] = mapped_column(Text)
    # Set when an edit removes the line. The row stays: order history is never deleted.
    removed_at: Mapped[datetime | None] = mapped_column(UtcInstant)


class OrderStatusEvent(Base):
    __tablename__ = "order_status_events"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    sequence: Mapped[int] = mapped_column()
    from_status: Mapped[str | None] = mapped_column(String)
    to_status: Mapped[str] = mapped_column(String)
    changed_at: Mapped[datetime] = mapped_column(UtcInstant)
    # Who did it, as they were named at the time.
    actor_id: Mapped[str] = mapped_column(String)
    actor_display_name: Mapped[str] = mapped_column(String)
    reason: Mapped[str | None] = mapped_column(Text)


class Quote(Base):
    """A short-lived calculation of a draft, bound to everything its totals depend on."""

    __tablename__ = "quotes"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    order_id: Mapped[str | None] = mapped_column(String)
    expected_version: Mapped[int | None] = mapped_column()
    # Hashes of the validated draft and of the settings and menu versions it was priced from.
    draft_fingerprint: Mapped[str] = mapped_column(String)
    dependencies: Mapped[str] = mapped_column(String)
    expires_at: Mapped[datetime] = mapped_column(UtcInstant, index=True)
    created_at: Mapped[datetime] = mapped_column(UtcInstant)


class LedgerEntry(Base):
    """One payment or refund. Entries are only ever added; none is changed or removed."""

    __tablename__ = "ledger_entries"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    sequence: Mapped[int] = mapped_column()
    type: Mapped[str] = mapped_column(String)
    # For a refund, the payment it returns money from.
    payment_id: Mapped[str | None] = mapped_column(ForeignKey("ledger_entries.id"), index=True)
    amount_minor: Mapped[int] = mapped_column(BigInteger)
    # The business day the money changed hands, as staff entered it.
    business_date: Mapped[date] = mapped_column(Date)
    method: Mapped[str] = mapped_column(String)
    reference: Mapped[str] = mapped_column(String)
    note: Mapped[str] = mapped_column(Text)
    reason: Mapped[str | None] = mapped_column(Text)
    # The operation key of the request that recorded it: one entry per key, ever.
    operation_id: Mapped[str] = mapped_column(String, unique=True)
    recorded_at: Mapped[datetime] = mapped_column(UtcInstant)
    actor_id: Mapped[str] = mapped_column(String)
    actor_display_name: Mapped[str] = mapped_column(String)
