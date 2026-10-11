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

    recipe: Mapped["Recipe | None"] = relationship(lazy="selectin")


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
    # How many have been cooked. Null on an order tracked by hand, which keeps no count.
    prepared_quantity: Mapped[int | None] = mapped_column(BigInteger)
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


class Ingredient(Base):
    __tablename__ = "ingredients"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    version: Mapped[int] = mapped_column()
    name: Mapped[str] = mapped_column(String)
    name_key: Mapped[str] = mapped_column(String, index=True)
    # Grams, millilitres or pieces. Every quantity of the ingredient is in thousandths of it.
    base_unit: Mapped[str] = mapped_column(String)
    threshold_thousandths: Mapped[int | None] = mapped_column(BigInteger)
    # Kept equal to the sum of the ingredient's movements by the one function that adds them.
    stock_thousandths: Mapped[int] = mapped_column(BigInteger)
    movement_count: Mapped[int] = mapped_column()
    # The receipt line that is the current cost basis: the latest by purchase date.
    latest_line_id: Mapped[str | None] = mapped_column(
        ForeignKey("purchase_lines.id", use_alter=True)
    )
    created_at: Mapped[datetime] = mapped_column(UtcInstant)
    updated_at: Mapped[datetime] = mapped_column(UtcInstant)

    latest_line: Mapped["PurchaseLine | None"] = relationship(
        foreign_keys=[latest_line_id], lazy="selectin"
    )


class StockMovement(Base):
    """One change to physical stock. Movements are only ever added."""

    __tablename__ = "stock_movements"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    ingredient_id: Mapped[str] = mapped_column(ForeignKey("ingredients.id"), index=True)
    sequence: Mapped[int] = mapped_column()
    delta_thousandths: Mapped[int] = mapped_column(BigInteger)
    before_thousandths: Mapped[int] = mapped_column(BigInteger)
    after_thousandths: Mapped[int] = mapped_column(BigInteger)
    type: Mapped[str] = mapped_column(String)
    reason: Mapped[str] = mapped_column(Text)
    purchase_id: Mapped[str | None] = mapped_column(ForeignKey("purchases.id"), index=True)
    preparation_id: Mapped[str | None] = mapped_column(String, index=True)
    corrects_movement_id: Mapped[str | None] = mapped_column(ForeignKey("stock_movements.id"))
    operation_id: Mapped[str] = mapped_column(String, index=True)
    recorded_at: Mapped[datetime] = mapped_column(UtcInstant)
    actor_id: Mapped[str] = mapped_column(String)
    actor_display_name: Mapped[str] = mapped_column(String)


class Purchase(Base):
    """A receipt. Once saved it never changes."""

    __tablename__ = "purchases"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    reference: Mapped[str] = mapped_column(String, unique=True)
    # The running number inside the reference, which also orders receipts of one day.
    number: Mapped[int] = mapped_column(BigInteger)
    purchased_on: Mapped[date] = mapped_column(Date, index=True)
    supplier: Mapped[str] = mapped_column(String)
    supplier_key: Mapped[str] = mapped_column(String)
    search_key: Mapped[str] = mapped_column(Text)
    note: Mapped[str] = mapped_column(Text)
    currency: Mapped[str] = mapped_column(String)
    minor_digits: Mapped[int] = mapped_column()
    total_cost_minor: Mapped[int] = mapped_column(BigInteger)
    operation_id: Mapped[str] = mapped_column(String, unique=True)
    recorded_at: Mapped[datetime] = mapped_column(UtcInstant)
    actor_id: Mapped[str] = mapped_column(String)
    actor_display_name: Mapped[str] = mapped_column(String)

    lines: Mapped[list["PurchaseLine"]] = relationship(
        order_by="PurchaseLine.position", lazy="selectin", back_populates="purchase"
    )


class PurchaseLine(Base):
    __tablename__ = "purchase_lines"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    purchase_id: Mapped[str] = mapped_column(ForeignKey("purchases.id"), index=True)
    position: Mapped[int] = mapped_column()
    ingredient_id: Mapped[str] = mapped_column(ForeignKey("ingredients.id"), index=True)
    # The ingredient as it was named and measured when the receipt was saved.
    ingredient_name: Mapped[str] = mapped_column(String)
    base_unit: Mapped[str] = mapped_column(String)
    # Quantity, unit and pack contents exactly as staff entered them.
    quantity: Mapped[str] = mapped_column(String)
    unit: Mapped[str] = mapped_column(String)
    pack_quantity: Mapped[str | None] = mapped_column(String)
    pack_unit: Mapped[str | None] = mapped_column(String)
    # What that came to, and what it cost: the exact cost basis, never a rounded unit cost.
    base_thousandths: Mapped[int] = mapped_column(BigInteger)
    total_cost_minor: Mapped[int] = mapped_column(BigInteger)
    stock_movement_id: Mapped[str] = mapped_column(ForeignKey("stock_movements.id"))

    purchase: Mapped["Purchase"] = relationship(back_populates="lines", lazy="joined")


class Preview(Base):
    """A reviewed stock movement or receipt, waiting up to five minutes to be saved."""

    __tablename__ = "previews"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    kind: Mapped[str] = mapped_column(String)
    # The ingredient a movement preview is for; empty for a receipt.
    subject_id: Mapped[str] = mapped_column(String)
    input_fingerprint: Mapped[str] = mapped_column(String)
    # The versions the result was calculated from, as JSON.
    dependencies: Mapped[str] = mapped_column(Text)
    expires_at: Mapped[datetime] = mapped_column(UtcInstant, index=True)
    created_at: Mapped[datetime] = mapped_column(UtcInstant)


class Recipe(Base):
    """What goes into one selling unit of a variant. One recipe per variant."""

    __tablename__ = "recipes"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    version: Mapped[int] = mapped_column()
    variant_id: Mapped[str] = mapped_column(ForeignKey("variants.id"), unique=True)
    # The selling format the recipe was written for. If the variant's format changes, the
    # recipe no longer describes it until it is saved again.
    yield_selling_unit: Mapped[str] = mapped_column(String)
    yield_package_quantity: Mapped[int | None] = mapped_column(BigInteger)
    recorded_at: Mapped[datetime] = mapped_column(UtcInstant)
    updated_at: Mapped[datetime] = mapped_column(UtcInstant)


class RecipeItem(Base):
    """One ingredient row of one version of a recipe. Rows of earlier versions are kept."""

    __tablename__ = "recipe_items"

    recipe_id: Mapped[str] = mapped_column(ForeignKey("recipes.id"), primary_key=True)
    recipe_version: Mapped[int] = mapped_column(primary_key=True)
    position: Mapped[int] = mapped_column(primary_key=True)
    ingredient_id: Mapped[str] = mapped_column(ForeignKey("ingredients.id"), index=True)
    # The quantity and unit as staff entered them, and what they come to in the base unit.
    quantity: Mapped[str] = mapped_column(String)
    unit: Mapped[str] = mapped_column(String)
    base_thousandths: Mapped[int] = mapped_column(BigInteger)


class Preparation(Base):
    """What was cooked at one time, for which order lines, and what it took from the shelf.

    Once saved it never changes. A mistake is put right by a correction beside it.
    """

    __tablename__ = "preparations"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    prepared_on: Mapped[date] = mapped_column(Date, index=True)
    note: Mapped[str] = mapped_column(Text)
    currency: Mapped[str] = mapped_column(String)
    minor_digits: Mapped[int] = mapped_column()
    # What the ingredients used cost at the receipts of the day; null if any was never bought.
    estimated_cost_minor: Mapped[int | None] = mapped_column(BigInteger)
    operation_id: Mapped[str] = mapped_column(String, unique=True)
    recorded_at: Mapped[datetime] = mapped_column(UtcInstant)
    actor_id: Mapped[str] = mapped_column(String)
    actor_display_name: Mapped[str] = mapped_column(String)

    allocations: Mapped[list["PreparationAllocation"]] = relationship(
        order_by="PreparationAllocation.position", lazy="selectin"
    )
    consumption: Mapped[list["PreparationConsumption"]] = relationship(
        order_by="PreparationConsumption.position", lazy="selectin"
    )


class PreparationAllocation(Base):
    """How many of one order line a preparation cooked, with the line as it then was."""

    __tablename__ = "preparation_allocations"

    preparation_id: Mapped[str] = mapped_column(ForeignKey("preparations.id"), primary_key=True)
    position: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    order_item_id: Mapped[str] = mapped_column(ForeignKey("order_items.id"), index=True)
    reference: Mapped[str] = mapped_column(String)
    variant_id: Mapped[str] = mapped_column(String)
    food_name: Mapped[str] = mapped_column(String)
    variant_label: Mapped[str] = mapped_column(String)
    selling_unit: Mapped[str] = mapped_column(String)
    package_quantity: Mapped[int | None] = mapped_column(BigInteger)
    quantity: Mapped[int] = mapped_column(BigInteger)
    # The variant's recipe at the time, if it had one. Its rows of that version are kept.
    recipe_id: Mapped[str | None] = mapped_column(String)
    recipe_version: Mapped[int | None] = mapped_column()


class PreparationConsumption(Base):
    """What a preparation actually used of one ingredient, and the receipt that priced it."""

    __tablename__ = "preparation_consumptions"

    preparation_id: Mapped[str] = mapped_column(ForeignKey("preparations.id"), primary_key=True)
    position: Mapped[int] = mapped_column(primary_key=True)
    ingredient_id: Mapped[str] = mapped_column(ForeignKey("ingredients.id"), index=True)
    ingredient_name: Mapped[str] = mapped_column(String)
    base_unit: Mapped[str] = mapped_column(String)
    # Quantity and unit exactly as staff entered them, and what that came to.
    quantity: Mapped[str] = mapped_column(String)
    unit: Mapped[str] = mapped_column(String)
    base_thousandths: Mapped[int] = mapped_column(BigInteger)
    before_thousandths: Mapped[int] = mapped_column(BigInteger)
    after_thousandths: Mapped[int] = mapped_column(BigInteger)
    stock_movement_id: Mapped[str] = mapped_column(ForeignKey("stock_movements.id"))
    # The cost basis of the day: all four null when the ingredient had no usable price.
    purchase_id: Mapped[str | None] = mapped_column(String)
    purchase_line_id: Mapped[str | None] = mapped_column(String)
    purchased_on: Mapped[date | None] = mapped_column(Date)
    unit_cost: Mapped[str | None] = mapped_column(String)


class PreparationCorrection(Base):
    """A later change to what a preparation recorded. Corrections are only ever added."""

    __tablename__ = "preparation_corrections"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    preparation_id: Mapped[str] = mapped_column(ForeignKey("preparations.id"), index=True)
    sequence: Mapped[int] = mapped_column()
    reason: Mapped[str] = mapped_column(Text)
    operation_id: Mapped[str] = mapped_column(String, unique=True)
    recorded_at: Mapped[datetime] = mapped_column(UtcInstant)
    actor_id: Mapped[str] = mapped_column(String)
    actor_display_name: Mapped[str] = mapped_column(String)

    allocations: Mapped[list["CorrectionAllocation"]] = relationship(
        order_by="CorrectionAllocation.position", lazy="selectin"
    )
    stock: Mapped[list["CorrectionStock"]] = relationship(
        order_by="CorrectionStock.position", lazy="selectin"
    )


class CorrectionAllocation(Base):
    """A change to the prepared count of one order line, with the count before and after."""

    __tablename__ = "correction_allocations"

    correction_id: Mapped[str] = mapped_column(
        ForeignKey("preparation_corrections.id"), primary_key=True
    )
    position: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"))
    order_item_id: Mapped[str] = mapped_column(ForeignKey("order_items.id"), index=True)
    reference: Mapped[str] = mapped_column(String)
    variant_id: Mapped[str] = mapped_column(String)
    food_name: Mapped[str] = mapped_column(String)
    variant_label: Mapped[str] = mapped_column(String)
    selling_unit: Mapped[str] = mapped_column(String)
    package_quantity: Mapped[int | None] = mapped_column(BigInteger)
    ordered_quantity: Mapped[int] = mapped_column(BigInteger)
    prepared_before: Mapped[int] = mapped_column(BigInteger)
    delta_quantity: Mapped[int] = mapped_column(BigInteger)
    prepared_after: Mapped[int] = mapped_column(BigInteger)


class CorrectionStock(Base):
    """A signed stock adjustment made by a correction, and the movement that carried it."""

    __tablename__ = "correction_stock"

    correction_id: Mapped[str] = mapped_column(
        ForeignKey("preparation_corrections.id"), primary_key=True
    )
    position: Mapped[int] = mapped_column(primary_key=True)
    ingredient_id: Mapped[str] = mapped_column(ForeignKey("ingredients.id"))
    ingredient_name: Mapped[str] = mapped_column(String)
    base_unit: Mapped[str] = mapped_column(String)
    corrects_movement_id: Mapped[str] = mapped_column(ForeignKey("stock_movements.id"))
    delta_thousandths: Mapped[int] = mapped_column(BigInteger)
    before_thousandths: Mapped[int] = mapped_column(BigInteger)
    after_thousandths: Mapped[int] = mapped_column(BigInteger)
    stock_movement_id: Mapped[str] = mapped_column(ForeignKey("stock_movements.id"))
