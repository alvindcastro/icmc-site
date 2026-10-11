"""Baseline: staff account, sessions, sign-in failures and business settings.

Revision ID: 0001
Revises:
"""

import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "staff_users",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("username", sa.String(), nullable=False),
        sa.Column("display_name", sa.String(), nullable=False),
        sa.Column("role", sa.String(), nullable=False),
        sa.Column("token_hash", sa.String(), nullable=True),
        sa.Column("token_set_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_staff_users")),
        sa.UniqueConstraint("username", name=op.f("uq_staff_users_username")),
    )
    op.create_table(
        "auth_sessions",
        sa.Column("id_hash", sa.String(), nullable=False),
        sa.Column("user_id", sa.String(), nullable=True),
        sa.Column("csrf_token", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("idle_expires_at", sa.DateTime(), nullable=False),
        sa.Column("absolute_expires_at", sa.DateTime(), nullable=False),
        sa.Column("ended_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"], ["staff_users.id"], name=op.f("fk_auth_sessions_user_id_staff_users")
        ),
        sa.PrimaryKeyConstraint("id_hash", name=op.f("pk_auth_sessions")),
    )
    op.create_index(op.f("ix_auth_sessions_user_id"), "auth_sessions", ["user_id"])
    op.create_table(
        "sign_in_failures",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("failed_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_sign_in_failures")),
    )
    op.create_table(
        "business_settings",
        sa.Column("id", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("environment", sa.String(), nullable=False),
        sa.Column("currency", sa.String(), nullable=False),
        sa.Column("minor_digits", sa.Integer(), nullable=False),
        sa.Column("timezone", sa.String(), nullable=False),
        sa.Column("fulfillment_methods", sa.JSON(), nullable=False),
        sa.Column("pickup_location", sa.String(), nullable=True),
        sa.Column("delivery_mode", sa.String(), nullable=False),
        sa.Column("fixed_charge_minor", sa.BigInteger(), nullable=True),
        sa.Column("tax_mode", sa.String(), nullable=False),
        sa.Column("tax_inclusive", sa.Boolean(), nullable=False),
        sa.Column("payment_methods", sa.JSON(), nullable=False),
        sa.Column("capabilities", sa.JSON(), nullable=False),
        sa.Column("confirmed", sa.JSON(), nullable=False),
        sa.Column("confirmed_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("id = 1", name=op.f("ck_business_settings_single_row")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_business_settings")),
    )


def downgrade() -> None:
    op.drop_table("business_settings")
    op.drop_table("sign_in_failures")
    op.drop_index(op.f("ix_auth_sessions_user_id"), table_name="auth_sessions")
    op.drop_table("auth_sessions")
    op.drop_table("staff_users")
