from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from sqlalchemy import Connection, create_engine, event
from sqlalchemy.orm import Session


def _begin(connection: Connection) -> None:
    # The driver's own transaction handling is off, so this BEGIN is the real one and covers
    # schema changes too. A write asks for the lock here instead of at its first statement.
    mode = connection.get_execution_options().get("begin", "DEFERRED")
    connection.exec_driver_sql(f"BEGIN {mode}")


class Database:
    """One SQLite file in WAL mode.

    A read sees a committed snapshot and is never blocked. A write holds the only write lock
    from its first moment, so two writes queue instead of racing, and it commits or leaves
    nothing behind.
    """

    def __init__(self, url: str, *, busy_timeout_ms: int = 5000) -> None:
        # Statement parameters stay out of error messages and logs: they can be customer data.
        self.engine = create_engine(
            url, connect_args={"timeout": busy_timeout_ms / 1000}, hide_parameters=True
        )
        self._writer = self.engine.execution_options(begin="IMMEDIATE")

        @event.listens_for(self.engine, "connect")
        def configure(connection: Any, _: Any) -> None:
            connection.isolation_level = None
            cursor = connection.cursor()
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute(f"PRAGMA busy_timeout={busy_timeout_ms}")
            cursor.close()

        event.listen(self.engine, "begin", _begin)

    @contextmanager
    def read(self) -> Iterator[Session]:
        with Session(self.engine, expire_on_commit=False) as session:
            yield session

    @contextmanager
    def write(self) -> Iterator[Session]:
        with Session(self._writer, expire_on_commit=False) as session, session.begin():
            session.connection()
            yield session

    def dispose(self) -> None:
        self.engine.dispose()
