"""Message idempotency: the plan date and a dedupe key on each message.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-22
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("messages", sa.Column("plan_date", sa.String(10), nullable=True))
    op.add_column("messages", sa.Column("dedupe_key", sa.String(64), nullable=True))
    op.create_index("ix_messages_dedupe_key", "messages", ["dedupe_key"])


def downgrade() -> None:
    op.drop_index("ix_messages_dedupe_key", table_name="messages")
    with op.batch_alter_table("messages") as batch:
        batch.drop_column("dedupe_key")
        batch.drop_column("plan_date")
