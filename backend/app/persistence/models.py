from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
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
