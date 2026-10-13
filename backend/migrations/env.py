"""Alembic environment. The app passes its own connection (see app.db.migrate); the CLI
connects with DATABASE_URL."""

from __future__ import annotations

import logging.config

from alembic import context
from sqlalchemy import create_engine, pool

from app import db as app_db

config = context.config
if config.config_file_name is not None:
    logging.config.fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = app_db.Base.metadata


def _run(connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        render_as_batch=connection.dialect.name == "sqlite",  # SQLite needs table rebuilds for ALTERs
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


if context.is_offline_mode():
    context.configure(url=app_db.database_url(), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    connection = config.attributes.get("connection")
    if connection is not None:
        _run(connection)
    else:
        engine = create_engine(app_db.database_url(), poolclass=pool.NullPool)
        with engine.begin() as conn:
            _run(conn)
