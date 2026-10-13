"""Plan runs and the weather cache (the schema before migrations were introduced).

Revision ID: 0001
Revises:
Create Date: 2026-10-11
"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "runs",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("plan_date", sa.String(10), nullable=False),
        sa.Column("location", sa.String(32), nullable=False),
        sa.Column("engine", sa.String(16), nullable=False),
        sa.Column("solve_seconds", sa.Float, nullable=False),
        sa.Column("params", sa.JSON, nullable=False),
        sa.Column("summary", sa.JSON, nullable=False),
    )
    op.create_index("ix_runs_created_at", "runs", ["created_at"])
    op.create_table(
        "weather_cache",
        sa.Column("key", sa.String(160), primary_key=True),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", sa.JSON, nullable=False),
    )


def downgrade() -> None:
    op.drop_table("weather_cache")
    op.drop_index("ix_runs_created_at", table_name="runs")
    op.drop_table("runs")
