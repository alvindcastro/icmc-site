"""Menu: categories, foods, variants and an audit trail.

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "categories",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("name_key", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_categories")),
        sa.UniqueConstraint("name_key", name=op.f("uq_categories_name_key")),
    )
    op.create_table(
        "foods",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("name_key", sa.String(), nullable=False),
        sa.Column("category_id", sa.String(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("available", sa.Boolean(), nullable=False),
        sa.Column("confirmation_status", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["category_id"], ["categories.id"], name=op.f("fk_foods_category_id_categories")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_foods")),
    )
    op.create_index(op.f("ix_foods_category_id"), "foods", ["category_id"])
    op.create_index(op.f("ix_foods_name_key"), "foods", ["name_key"])
    op.create_table(
        "variants",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("food_id", sa.String(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("selling_unit", sa.String(), nullable=False),
        sa.Column("price_minor", sa.BigInteger(), nullable=False),
        sa.Column("available", sa.Boolean(), nullable=False),
        sa.Column("confirmation_status", sa.String(), nullable=False),
        sa.Column("package_quantity", sa.BigInteger(), nullable=True),
        sa.Column("used_on_order", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["food_id"], ["foods.id"], name=op.f("fk_variants_food_id_foods")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_variants")),
    )
    op.create_index(op.f("ix_variants_food_id"), "variants", ["food_id"])
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("at", sa.DateTime(), nullable=False),
        sa.Column("actor", sa.String(), nullable=False),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("resource_type", sa.String(), nullable=False),
        sa.Column("resource_id", sa.String(), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_audit_events")),
    )


def downgrade() -> None:
    op.drop_table("audit_events")
    op.drop_index(op.f("ix_variants_food_id"), table_name="variants")
    op.drop_table("variants")
    op.drop_index(op.f("ix_foods_name_key"), table_name="foods")
    op.drop_index(op.f("ix_foods_category_id"), table_name="foods")
    op.drop_table("foods")
    op.drop_table("categories")
