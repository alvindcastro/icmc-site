"""Preparation recording: prepared counts on order lines, preparations and their corrections.

Revision ID: 0008
Revises: 0007
"""

from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | None = None
depends_on: str | None = None


def _line_snapshot() -> list[sa.Column[Any]]:
    """The order line a row is about, as it was when the row was written."""
    return [
        sa.Column("order_id", sa.String(), nullable=False),
        sa.Column("order_item_id", sa.String(), nullable=False),
        sa.Column("reference", sa.String(), nullable=False),
        sa.Column("variant_id", sa.String(), nullable=False),
        sa.Column("food_name", sa.String(), nullable=False),
        sa.Column("variant_label", sa.String(), nullable=False),
        sa.Column("selling_unit", sa.String(), nullable=False),
        sa.Column("package_quantity", sa.BigInteger(), nullable=True),
    ]


def upgrade() -> None:
    # Null on every existing line: orders taken so far are tracked by hand.
    op.add_column("order_items", sa.Column("prepared_quantity", sa.BigInteger(), nullable=True))
    op.create_table(
        "preparations",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("prepared_on", sa.Date(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("currency", sa.String(), nullable=False),
        sa.Column("minor_digits", sa.Integer(), nullable=False),
        sa.Column("estimated_cost_minor", sa.BigInteger(), nullable=True),
        sa.Column("operation_id", sa.String(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(), nullable=False),
        sa.Column("actor_id", sa.String(), nullable=False),
        sa.Column("actor_display_name", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_preparations")),
        sa.UniqueConstraint("operation_id", name=op.f("uq_preparations_operation_id")),
    )
    op.create_index(op.f("ix_preparations_prepared_on"), "preparations", ["prepared_on"])
    op.create_table(
        "preparation_allocations",
        sa.Column("preparation_id", sa.String(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        *_line_snapshot(),
        sa.Column("quantity", sa.BigInteger(), nullable=False),
        sa.Column("recipe_id", sa.String(), nullable=True),
        sa.Column("recipe_version", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["order_id"], ["orders.id"], name=op.f("fk_preparation_allocations_order_id_orders")
        ),
        sa.ForeignKeyConstraint(
            ["order_item_id"],
            ["order_items.id"],
            name=op.f("fk_preparation_allocations_order_item_id_order_items"),
        ),
        sa.ForeignKeyConstraint(
            ["preparation_id"],
            ["preparations.id"],
            name=op.f("fk_preparation_allocations_preparation_id_preparations"),
        ),
        sa.PrimaryKeyConstraint(
            "preparation_id", "position", name=op.f("pk_preparation_allocations")
        ),
    )
    op.create_index(
        op.f("ix_preparation_allocations_order_id"), "preparation_allocations", ["order_id"]
    )
    op.create_index(
        op.f("ix_preparation_allocations_order_item_id"),
        "preparation_allocations",
        ["order_item_id"],
    )
    op.create_table(
        "preparation_consumptions",
        sa.Column("preparation_id", sa.String(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("ingredient_id", sa.String(), nullable=False),
        sa.Column("ingredient_name", sa.String(), nullable=False),
        sa.Column("base_unit", sa.String(), nullable=False),
        sa.Column("quantity", sa.String(), nullable=False),
        sa.Column("unit", sa.String(), nullable=False),
        sa.Column("base_thousandths", sa.BigInteger(), nullable=False),
        sa.Column("before_thousandths", sa.BigInteger(), nullable=False),
        sa.Column("after_thousandths", sa.BigInteger(), nullable=False),
        sa.Column("stock_movement_id", sa.String(), nullable=False),
        sa.Column("purchase_id", sa.String(), nullable=True),
        sa.Column("purchase_line_id", sa.String(), nullable=True),
        sa.Column("purchased_on", sa.Date(), nullable=True),
        sa.Column("unit_cost", sa.String(), nullable=True),
        sa.ForeignKeyConstraint(
            ["ingredient_id"],
            ["ingredients.id"],
            name=op.f("fk_preparation_consumptions_ingredient_id_ingredients"),
        ),
        sa.ForeignKeyConstraint(
            ["preparation_id"],
            ["preparations.id"],
            name=op.f("fk_preparation_consumptions_preparation_id_preparations"),
        ),
        sa.ForeignKeyConstraint(
            ["stock_movement_id"],
            ["stock_movements.id"],
            name=op.f("fk_preparation_consumptions_stock_movement_id_stock_movements"),
        ),
        sa.PrimaryKeyConstraint(
            "preparation_id", "position", name=op.f("pk_preparation_consumptions")
        ),
    )
    op.create_index(
        op.f("ix_preparation_consumptions_ingredient_id"),
        "preparation_consumptions",
        ["ingredient_id"],
    )
    op.create_table(
        "preparation_corrections",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("preparation_id", sa.String(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("operation_id", sa.String(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(), nullable=False),
        sa.Column("actor_id", sa.String(), nullable=False),
        sa.Column("actor_display_name", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["preparation_id"],
            ["preparations.id"],
            name=op.f("fk_preparation_corrections_preparation_id_preparations"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_preparation_corrections")),
        sa.UniqueConstraint("operation_id", name=op.f("uq_preparation_corrections_operation_id")),
    )
    op.create_index(
        op.f("ix_preparation_corrections_preparation_id"),
        "preparation_corrections",
        ["preparation_id"],
    )
    op.create_table(
        "correction_allocations",
        sa.Column("correction_id", sa.String(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        *_line_snapshot(),
        sa.Column("ordered_quantity", sa.BigInteger(), nullable=False),
        sa.Column("prepared_before", sa.BigInteger(), nullable=False),
        sa.Column("delta_quantity", sa.BigInteger(), nullable=False),
        sa.Column("prepared_after", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(
            ["correction_id"],
            ["preparation_corrections.id"],
            name=op.f("fk_correction_allocations_correction_id_preparation_corrections"),
        ),
        sa.ForeignKeyConstraint(
            ["order_id"], ["orders.id"], name=op.f("fk_correction_allocations_order_id_orders")
        ),
        sa.ForeignKeyConstraint(
            ["order_item_id"],
            ["order_items.id"],
            name=op.f("fk_correction_allocations_order_item_id_order_items"),
        ),
        sa.PrimaryKeyConstraint(
            "correction_id", "position", name=op.f("pk_correction_allocations")
        ),
    )
    op.create_index(
        op.f("ix_correction_allocations_order_item_id"),
        "correction_allocations",
        ["order_item_id"],
    )
    op.create_table(
        "correction_stock",
        sa.Column("correction_id", sa.String(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("ingredient_id", sa.String(), nullable=False),
        sa.Column("ingredient_name", sa.String(), nullable=False),
        sa.Column("base_unit", sa.String(), nullable=False),
        sa.Column("corrects_movement_id", sa.String(), nullable=False),
        sa.Column("delta_thousandths", sa.BigInteger(), nullable=False),
        sa.Column("before_thousandths", sa.BigInteger(), nullable=False),
        sa.Column("after_thousandths", sa.BigInteger(), nullable=False),
        sa.Column("stock_movement_id", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["correction_id"],
            ["preparation_corrections.id"],
            name=op.f("fk_correction_stock_correction_id_preparation_corrections"),
        ),
        sa.ForeignKeyConstraint(
            ["corrects_movement_id"],
            ["stock_movements.id"],
            name=op.f("fk_correction_stock_corrects_movement_id_stock_movements"),
        ),
        sa.ForeignKeyConstraint(
            ["ingredient_id"],
            ["ingredients.id"],
            name=op.f("fk_correction_stock_ingredient_id_ingredients"),
        ),
        sa.ForeignKeyConstraint(
            ["stock_movement_id"],
            ["stock_movements.id"],
            name=op.f("fk_correction_stock_stock_movement_id_stock_movements"),
        ),
        sa.PrimaryKeyConstraint("correction_id", "position", name=op.f("pk_correction_stock")),
    )


def downgrade() -> None:
    op.drop_table("correction_stock")
    op.drop_index(
        op.f("ix_correction_allocations_order_item_id"), table_name="correction_allocations"
    )
    op.drop_table("correction_allocations")
    op.drop_index(
        op.f("ix_preparation_corrections_preparation_id"), table_name="preparation_corrections"
    )
    op.drop_table("preparation_corrections")
    op.drop_index(
        op.f("ix_preparation_consumptions_ingredient_id"), table_name="preparation_consumptions"
    )
    op.drop_table("preparation_consumptions")
    op.drop_index(
        op.f("ix_preparation_allocations_order_item_id"), table_name="preparation_allocations"
    )
    op.drop_index(op.f("ix_preparation_allocations_order_id"), table_name="preparation_allocations")
    op.drop_table("preparation_allocations")
    op.drop_index(op.f("ix_preparations_prepared_on"), table_name="preparations")
    op.drop_table("preparations")
    op.drop_column("order_items", "prepared_quantity")
