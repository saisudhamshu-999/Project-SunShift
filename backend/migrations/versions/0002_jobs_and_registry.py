"""Solver jobs, and the farm registry (feeders, farms, pumps).

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-11
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "jobs",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("status", sa.String(10), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("result", sa.JSON, nullable=True),
        sa.Column("error", sa.String(300), nullable=True),
    )
    op.create_index("ix_jobs_key", "jobs", ["key"])
    op.create_index("ix_jobs_status", "jobs", ["status"])
    op.create_index("ix_jobs_created_at", "jobs", ["created_at"])

    op.create_table(
        "feeders",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("location_id", sa.String(32), nullable=False),
        sa.Column("pv_kwp", sa.Float, nullable=False),
        sa.Column("inverter_kw", sa.Float, nullable=False),
        sa.Column("feeder_limit_kw", sa.Float, nullable=False),
        sa.Column("grid_backup_kw", sa.Float, nullable=False),
        sa.Column("simulated", sa.Boolean, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "farms",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=False),
        sa.Column("feeder_id", sa.String(32), sa.ForeignKey("feeders.id"), nullable=False),
        sa.Column("label", sa.String(60), nullable=True),
        sa.Column("crop", sa.String(20), nullable=False),
        sa.Column("area_ha", sa.Float, nullable=False),
        sa.Column("soil", sa.String(30), nullable=False),
        sa.Column("method", sa.String(20), nullable=False),
        sa.Column("das", sa.Integer, nullable=True),
        sa.Column("sowing_date", sa.String(10), nullable=True),
        sa.Column("available", sa.JSON, nullable=False),
        sa.Column("habit_start", sa.String(5), nullable=False),
        sa.Column("dr0_frac", sa.Float, nullable=False),
        sa.Column("served_yesterday", sa.Float, nullable=False),
        sa.Column("last_irrigated_days", sa.Integer, nullable=False),
        sa.Column("map_x", sa.Float, nullable=True),
        sa.Column("map_y", sa.Float, nullable=True),
        sa.Column("simulated", sa.Boolean, nullable=False),
        sa.Column("active", sa.Boolean, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_farms_feeder_id", "farms", ["feeder_id"])
    op.create_table(
        "pumps",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("farm_id", sa.Integer, sa.ForeignKey("farms.id"), nullable=False, unique=True),
        sa.Column("hp", sa.Float, nullable=False),
        sa.Column("head_m", sa.Float, nullable=False),
        sa.Column("controller", sa.String(12), nullable=False),
        sa.Column("measured_kw", sa.Float, nullable=True),
        sa.Column("measured_flow_m3h", sa.Float, nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("pumps")
    op.drop_index("ix_farms_feeder_id", table_name="farms")
    op.drop_table("farms")
    op.drop_table("feeders")
    op.drop_index("ix_jobs_created_at", table_name="jobs")
    op.drop_index("ix_jobs_status", table_name="jobs")
    op.drop_index("ix_jobs_key", table_name="jobs")
    op.drop_table("jobs")
