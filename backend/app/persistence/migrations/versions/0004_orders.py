"""Orders: orders, their lines and status events, quotes and reference counters.

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "counters",
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("value", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("name", name=op.f("pk_counters")),
    )
    op.create_table(
        "orders",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("reference", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("customer_name", sa.String(), nullable=False),
        sa.Column("customer_phone", sa.String(), nullable=False),
        sa.Column("customer_notes", sa.Text(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("search_key", sa.Text(), nullable=False),
        sa.Column("fulfillment_method", sa.String(), nullable=False),
        sa.Column("local_date", sa.Date(), nullable=False),
        sa.Column("local_time", sa.String(), nullable=False),
        sa.Column("timezone", sa.String(), nullable=False),
        sa.Column("utc_offset", sa.String(), nullable=False),
        sa.Column("fulfillment_at", sa.DateTime(), nullable=False),
        sa.Column("address", sa.Text(), nullable=True),
        sa.Column("pickup_location", sa.String(), nullable=True),
        sa.Column("currency", sa.String(), nullable=False),
        sa.Column("minor_digits", sa.Integer(), nullable=False),
        sa.Column("subtotal_minor", sa.BigInteger(), nullable=False),
        sa.Column("delivery_charge_minor", sa.BigInteger(), nullable=False),
        sa.Column("tax_minor", sa.BigInteger(), nullable=False),
        sa.Column("total_minor", sa.BigInteger(), nullable=False),
        sa.Column("preparation_tracking", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_orders")),
        sa.UniqueConstraint("reference", name=op.f("uq_orders_reference")),
    )
    op.create_index(op.f("ix_orders_fulfillment_at"), "orders", ["fulfillment_at"])
    op.create_index(op.f("ix_orders_local_date"), "orders", ["local_date"])
    op.create_index(op.f("ix_orders_status"), "orders", ["status"])
    op.create_table(
        "order_items",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("order_id", sa.String(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("variant_id", sa.String(), nullable=False),
        sa.Column("food_name", sa.String(), nullable=False),
        sa.Column("variant_label", sa.String(), nullable=False),
        sa.Column("selling_unit", sa.String(), nullable=False),
        sa.Column("package_quantity", sa.BigInteger(), nullable=True),
        sa.Column("unit_price_minor", sa.BigInteger(), nullable=False),
        sa.Column("quantity", sa.BigInteger(), nullable=False),
        sa.Column("preparation_notes", sa.Text(), nullable=False),
        sa.Column("removed_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["order_id"], ["orders.id"], name=op.f("fk_order_items_order_id_orders")
        ),
        sa.ForeignKeyConstraint(
            ["variant_id"], ["variants.id"], name=op.f("fk_order_items_variant_id_variants")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_order_items")),
    )
    op.create_index(op.f("ix_order_items_order_id"), "order_items", ["order_id"])
    op.create_index(op.f("ix_order_items_variant_id"), "order_items", ["variant_id"])
    op.create_table(
        "order_status_events",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("order_id", sa.String(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("from_status", sa.String(), nullable=True),
        sa.Column("to_status", sa.String(), nullable=False),
        sa.Column("changed_at", sa.DateTime(), nullable=False),
        sa.Column("actor_id", sa.String(), nullable=False),
        sa.Column("actor_display_name", sa.String(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(
            ["order_id"], ["orders.id"], name=op.f("fk_order_status_events_order_id_orders")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_order_status_events")),
    )
    op.create_index(op.f("ix_order_status_events_order_id"), "order_status_events", ["order_id"])
    op.create_table(
        "quotes",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("order_id", sa.String(), nullable=True),
        sa.Column("expected_version", sa.Integer(), nullable=True),
        sa.Column("draft_fingerprint", sa.String(), nullable=False),
        sa.Column("dependencies", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_quotes")),
    )
    op.create_index(op.f("ix_quotes_expires_at"), "quotes", ["expires_at"])


def downgrade() -> None:
    op.drop_index(op.f("ix_quotes_expires_at"), table_name="quotes")
    op.drop_table("quotes")
    op.drop_index(op.f("ix_order_status_events_order_id"), table_name="order_status_events")
    op.drop_table("order_status_events")
    op.drop_index(op.f("ix_order_items_variant_id"), table_name="order_items")
    op.drop_index(op.f("ix_order_items_order_id"), table_name="order_items")
    op.drop_table("order_items")
    op.drop_index(op.f("ix_orders_status"), table_name="orders")
    op.drop_index(op.f("ix_orders_local_date"), table_name="orders")
    op.drop_index(op.f("ix_orders_fulfillment_at"), table_name="orders")
    op.drop_table("orders")
    op.drop_table("counters")
