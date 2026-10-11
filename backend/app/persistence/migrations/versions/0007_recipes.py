"""Recipes: one per variant, with the ingredient rows of every version.

Revision ID: 0007
Revises: 0006
"""

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "recipes",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("variant_id", sa.String(), nullable=False),
        sa.Column("yield_selling_unit", sa.String(), nullable=False),
        sa.Column("yield_package_quantity", sa.BigInteger(), nullable=True),
        sa.Column("recorded_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(
            ["variant_id"], ["variants.id"], name=op.f("fk_recipes_variant_id_variants")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_recipes")),
        sa.UniqueConstraint("variant_id", name=op.f("uq_recipes_variant_id")),
    )
    op.create_table(
        "recipe_items",
        sa.Column("recipe_id", sa.String(), nullable=False),
        sa.Column("recipe_version", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("ingredient_id", sa.String(), nullable=False),
        sa.Column("quantity", sa.String(), nullable=False),
        sa.Column("unit", sa.String(), nullable=False),
        sa.Column("base_thousandths", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(
            ["ingredient_id"],
            ["ingredients.id"],
            name=op.f("fk_recipe_items_ingredient_id_ingredients"),
        ),
        sa.ForeignKeyConstraint(
            ["recipe_id"], ["recipes.id"], name=op.f("fk_recipe_items_recipe_id_recipes")
        ),
        sa.PrimaryKeyConstraint(
            "recipe_id", "recipe_version", "position", name=op.f("pk_recipe_items")
        ),
    )
    op.create_index(op.f("ix_recipe_items_ingredient_id"), "recipe_items", ["ingredient_id"])


def downgrade() -> None:
    op.drop_index(op.f("ix_recipe_items_ingredient_id"), table_name="recipe_items")
    op.drop_table("recipe_items")
    op.drop_table("recipes")
