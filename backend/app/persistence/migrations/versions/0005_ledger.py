"""Ledger: append-only payment and refund entries.

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | None = None
depends_on: str | None = None


def upgrade() -> None:
    op.create_table(
        "ledger_entries",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("order_id", sa.String(), nullable=False),
        sa.Column("sequence", sa.Integer(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("payment_id", sa.String(), nullable=True),
        sa.Column("amount_minor", sa.BigInteger(), nullable=False),
        sa.Column("business_date", sa.Date(), nullable=False),
        sa.Column("method", sa.String(), nullable=False),
        sa.Column("reference", sa.String(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("operation_id", sa.String(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(), nullable=False),
        sa.Column("actor_id", sa.String(), nullable=False),
        sa.Column("actor_display_name", sa.String(), nullable=False),
        sa.ForeignKeyConstraint(
            ["order_id"], ["orders.id"], name=op.f("fk_ledger_entries_order_id_orders")
        ),
        sa.ForeignKeyConstraint(
            ["payment_id"],
            ["ledger_entries.id"],
            name=op.f("fk_ledger_entries_payment_id_ledger_entries"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_ledger_entries")),
        sa.UniqueConstraint("operation_id", name=op.f("uq_ledger_entries_operation_id")),
    )
    op.create_index(op.f("ix_ledger_entries_order_id"), "ledger_entries", ["order_id"])
    op.create_index(op.f("ix_ledger_entries_payment_id"), "ledger_entries", ["payment_id"])


def downgrade() -> None:
    op.drop_index(op.f("ix_ledger_entries_payment_id"), table_name="ledger_entries")
    op.drop_index(op.f("ix_ledger_entries_order_id"), table_name="ledger_entries")
    op.drop_table("ledger_entries")
