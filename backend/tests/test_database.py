import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError, OperationalError

from app.config import Settings
from app.persistence.database import Database
from app.persistence.migrate import upgrade
from app.persistence.models import Base

TABLES = {
    "staff_users",
    "auth_sessions",
    "sign_in_failures",
    "business_settings",
    "operations",
    "categories",
    "foods",
    "variants",
    "audit_events",
    "counters",
    "orders",
    "order_items",
    "order_status_events",
    "quotes",
    "ledger_entries",
    "ingredients",
    "stock_movements",
    "purchases",
    "purchase_lines",
    "previews",
    "recipes",
    "recipe_items",
    "preparations",
    "preparation_allocations",
    "preparation_consumptions",
    "preparation_corrections",
    "correction_allocations",
    "correction_stock",
}


def test_connections_use_wal_foreign_keys_and_a_busy_timeout(database: Database) -> None:
    with database.read() as session:
        assert session.execute(text("pragma journal_mode")).scalar() == "wal"
        assert session.execute(text("pragma foreign_keys")).scalar() == 1
        assert session.execute(text("pragma busy_timeout")).scalar() == 5000


def test_a_write_takes_the_lock_before_its_first_statement(config: Settings) -> None:
    first = Database(config.database_url)
    second = Database(config.database_url, busy_timeout_ms=50)

    with first.write(), pytest.raises(OperationalError, match="locked"), second.write():
        pass
    with second.write() as session:
        assert session.execute(text("select 1")).scalar() == 1
    first.dispose()
    second.dispose()


def test_a_reader_is_not_blocked_and_sees_only_committed_rows(config: Settings) -> None:
    first = Database(config.database_url)
    second = Database(config.database_url, busy_timeout_ms=50)
    with first.write() as session:
        session.execute(text("create table notes (body text)"))

    with first.write() as writing:
        writing.execute(text("insert into notes values ('draft')"))
        with second.read() as reading:
            assert reading.execute(text("select count(*) from notes")).scalar() == 0
    with second.read() as reading:
        assert reading.execute(text("select count(*) from notes")).scalar() == 1
    first.dispose()
    second.dispose()


def test_a_failed_write_leaves_nothing_behind(database: Database) -> None:
    with database.write() as session:
        session.execute(text("create table notes (body text)"))

    with pytest.raises(RuntimeError), database.write() as session:
        session.execute(text("insert into notes values ('half a purchase')"))
        raise RuntimeError("failure midway")

    with database.read() as session:
        assert session.execute(text("select count(*) from notes")).scalar() == 0


def test_foreign_keys_are_enforced(database: Database) -> None:
    with database.write() as session:
        session.execute(text("create table parents (id text primary key)"))
        session.execute(text("create table children (parent_id text references parents (id))"))

    with pytest.raises(IntegrityError), database.write() as session:
        session.execute(text("insert into children values ('nobody')"))


def test_the_migration_builds_exactly_what_the_models_describe(database: Database) -> None:
    with database.read() as session:
        connection = session.connection()
        assert set(inspect(connection).get_table_names()) == TABLES | {"alembic_version"}
        assert compare_metadata(MigrationContext.configure(connection), Base.metadata) == []


def test_migrating_again_changes_nothing(database: Database) -> None:
    upgrade(database)

    with database.read() as session:
        assert set(inspect(session.connection()).get_table_names()) == TABLES | {"alembic_version"}


def test_a_new_database_holds_no_account_settings_or_sessions(database: Database) -> None:
    with database.read() as session:
        for table in sorted(TABLES):
            assert session.execute(text(f"select count(*) from {table}")).scalar() == 0
