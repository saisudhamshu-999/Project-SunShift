"""Farmer messaging: phone, language and opt-in on farms; dispatches, messages and
same-day overrides from farmers' replies.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-13
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Plain ADD COLUMN (no batch rebuild): rebuilding "farms" on SQLite means dropping a table that pumps
    # reference, which fails once the registry has rows. A failed rebuild left this table behind before.
    op.execute("DROP TABLE IF EXISTS _alembic_tmp_farms")
    op.add_column("farms", sa.Column("phone", sa.String(20), nullable=True))
    op.add_column("farms", sa.Column("language", sa.String(2), nullable=False, server_default="te"))
    op.add_column("farms", sa.Column("sms_opt_in", sa.Boolean, nullable=False, server_default=sa.false()))
    op.create_index("ix_farms_phone", "farms", ["phone"])

    op.create_table(
        "dispatches",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("feeder_id", sa.String(32), nullable=False),
        sa.Column("plan_date", sa.String(10), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("schedule", sa.JSON, nullable=False),
        sa.Column("reason", sa.String(40), nullable=False),
    )
    op.create_index("ix_dispatches_plan_date", "dispatches", ["plan_date"])
    op.create_table(
        "messages",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("dispatch_id", sa.String(32), nullable=True),
        sa.Column("farm_id", sa.Integer, nullable=True),
        sa.Column("direction", sa.String(3), nullable=False),
        sa.Column("phone_masked", sa.String(20), nullable=False),
        sa.Column("language", sa.String(2), nullable=False),
        sa.Column("body", sa.String(1000), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("provider", sa.String(12), nullable=False),
        sa.Column("provider_id", sa.String(64), nullable=True),
        sa.Column("error", sa.String(300), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_messages_created_at", "messages", ["created_at"])
    op.create_table(
        "farm_overrides",
        sa.Column("farm_id", sa.Integer, sa.ForeignKey("farms.id"), primary_key=True),
        sa.Column("plan_date", sa.String(10), primary_key=True),
        sa.Column("skip", sa.Boolean, nullable=False),
        sa.Column("earliest_hour", sa.Float, nullable=True),
        sa.Column("source", sa.String(12), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("farm_overrides")
    op.drop_index("ix_messages_created_at", table_name="messages")
    op.drop_table("messages")
    op.drop_index("ix_dispatches_plan_date", table_name="dispatches")
    op.drop_table("dispatches")
    op.drop_index("ix_farms_phone", table_name="farms")
    with op.batch_alter_table("farms") as batch:
        batch.drop_column("sms_opt_in")
        batch.drop_column("language")
        batch.drop_column("phone")
