"""Inventory: ingredients, stock movements, purchases and previews.

Revision ID: 0006
Revises: 0005
"""

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "purchases",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("reference", sa.String(), nullable=False),
        sa.Column("number", sa.BigInteger(), nullable=False),
        sa.Column("purchased_on", sa.Date(), nullable=False),
        sa.Column("supplier", sa.String(), nullable=False),
        sa.Column("supplier_key", sa.String(), nullable=False),
        sa.Column("search_key", sa.Text(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("currency", sa.String(), nullable=False),
        sa.Column("minor_digits", sa.Integer(), nullable=False),
        sa.Column("total_cost_minor", sa.BigInteger(), nullable=False),
        sa.Column("operation_id", sa.String(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(), nullable=False),
        sa.Column("actor_id", sa.String(), nullable=False),
        sa.Column("actor_display_name", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_purchases")),
        sa.UniqueConstraint("operation_id", name=op.f("uq_purchases_operation_id")),
        sa.UniqueConstraint("reference", name=op.f("uq_purchases_reference")),
    )
    op.create_index(op.f("ix_purchases_purchased_on"), "purchases", ["purchased_on"])
    # Ingredients and receipt lines point at each other, so both tables are made together.
    op.create_table(
        "ingredients",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("name_key", sa.String(), nullable=False),
        sa.Column("base_unit", sa.String(), nullable=False),
        sa.Column("threshold_thousandths", sa.BigInteger(), nullable=True),
        sa.Column("stock_thousandths", sa.BigInteger(), nullable=False),
        sa.Column("movement_count", sa.Integer(), nullable=False),
        sa.Column("latest_line_id", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["latest_line_id"],
            ["purchase_lines.id"],
            name=op.f("fk_ingredients_latest_line_id_purchase_lines"),
            use_alter=True,
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ingredients")),
    )
    op.create_index(op.f("ix_ingredients_name_key"), "ingredients", ["name_key"])
    op.create_table(
        "stock_movements",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("ingredient_id", sa.String(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("delta_thousandths", sa.BigInteger(), nullable=False),
        sa.Column("before_thousandths", sa.BigInteger(), nullable=False),
        sa.Column("after_thousandths", sa.BigInteger(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("purchase_id", sa.String(), nullable=True),
        sa.Column("preparation_id", sa.String(), nullable=True),
        sa.Column("corrects_movement_id", sa.String(), nullable=True),
        sa.Column("operation_id", sa.String(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(), nullable=False),
        sa.Column("actor_id", sa.String(), nullable=False),
        sa.Column("actor_display_name", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["corrects_movement_id"],
            ["stock_movements.id"],
            name=op.f("fk_stock_movements_corrects_movement_id_stock_movements"),
        ),
        sa.ForeignKeyConstraint(
            ["ingredient_id"],
            ["ingredients.id"],
            name=op.f("fk_stock_movements_ingredient_id_ingredients"),
        ),
        sa.ForeignKeyConstraint(
            ["purchase_id"], ["purchases.id"], name=op.f("fk_stock_movements_purchase_id_purchases")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_stock_movements")),
    )
    op.create_index(op.f("ix_stock_movements_ingredient_id"), "stock_movements", ["ingredient_id"])
    op.create_index(op.f("ix_stock_movements_operation_id"), "stock_movements", ["operation_id"])
    op.create_index(
        op.f("ix_stock_movements_preparation_id"), "stock_movements", ["preparation_id"]
    )
    op.create_index(op.f("ix_stock_movements_purchase_id"), "stock_movements", ["purchase_id"])
    op.create_table(
        "purchase_lines",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("purchase_id", sa.String(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("ingredient_id", sa.String(), nullable=False),
        sa.Column("ingredient_name", sa.String(), nullable=False),
        sa.Column("base_unit", sa.String(), nullable=False),
        sa.Column("quantity", sa.String(), nullable=False),
        sa.Column("unit", sa.String(), nullable=False),
        sa.Column("pack_quantity", sa.String(), nullable=True),
        sa.Column("pack_unit", sa.String(), nullable=True),
        sa.Column("base_thousandths", sa.BigInteger(), nullable=False),
        sa.Column("total_cost_minor", sa.BigInteger(), nullable=False),
        sa.Column("stock_movement_id", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["ingredient_id"],
            ["ingredients.id"],
            name=op.f("fk_purchase_lines_ingredient_id_ingredients"),
        ),
        sa.ForeignKeyConstraint(
            ["purchase_id"], ["purchases.id"], name=op.f("fk_purchase_lines_purchase_id_purchases")
        ),
        sa.ForeignKeyConstraint(
            ["stock_movement_id"],
            ["stock_movements.id"],
            name=op.f("fk_purchase_lines_stock_movement_id_stock_movements"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_purchase_lines")),
    )
    op.create_index(op.f("ix_purchase_lines_ingredient_id"), "purchase_lines", ["ingredient_id"])
    op.create_index(op.f("ix_purchase_lines_purchase_id"), "purchase_lines", ["purchase_id"])
    op.create_table(
        "previews",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("subject_id", sa.String(), nullable=False),
        sa.Column("input_fingerprint", sa.String(), nullable=False),
        sa.Column("dependencies", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_previews")),
    )
    op.create_index(op.f("ix_previews_expires_at"), "previews", ["expires_at"])


def downgrade() -> None:
    op.drop_index(op.f("ix_previews_expires_at"), table_name="previews")
    op.drop_table("previews")
    op.drop_index(op.f("ix_purchase_lines_purchase_id"), table_name="purchase_lines")
    op.drop_index(op.f("ix_purchase_lines_ingredient_id"), table_name="purchase_lines")
    op.drop_table("purchase_lines")
    op.drop_index(op.f("ix_stock_movements_purchase_id"), table_name="stock_movements")
    op.drop_index(op.f("ix_stock_movements_preparation_id"), table_name="stock_movements")
    op.drop_index(op.f("ix_stock_movements_operation_id"), table_name="stock_movements")
    op.drop_index(op.f("ix_stock_movements_ingredient_id"), table_name="stock_movements")
    op.drop_table("stock_movements")
    op.drop_index(op.f("ix_ingredients_name_key"), table_name="ingredients")
    op.drop_table("ingredients")
    op.drop_index(op.f("ix_purchases_purchased_on"), table_name="purchases")
    op.drop_table("purchases")
