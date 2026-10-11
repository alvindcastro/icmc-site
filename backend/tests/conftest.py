import shutil
from collections.abc import Callable, Iterator, Sequence
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event

from app.cli import main
from app.config import Settings
from app.main import create_app
from app.persistence.database import Database
from app.persistence.migrate import upgrade
from app.persistence.models import StaffUser
from app.services.credentials import hash_token
from tests.support import ORIGIN, TOKEN, Cli, FakeClock, sqlite_url


@pytest.fixture(scope="session")
def migrated(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """One migrated database per test run; each test works on its own copy."""
    path = tmp_path_factory.mktemp("template") / "template.db"
    database = Database(sqlite_url(path))
    upgrade(database)
    database.dispose()
    return path


@pytest.fixture
def config(tmp_path: Path, migrated: Path) -> Settings:
    path = tmp_path / "app.db"
    shutil.copyfile(migrated, path)
    return Settings(_env_file=None, database_url=sqlite_url(path), allowed_origins=ORIGIN)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def app(config: Settings, clock: FakeClock) -> FastAPI:
    app = create_app(config, clock=clock)

    # A test database dies with its test, so it need not survive a power cut. Skipping the
    # wait for the disk on every commit takes about a third off the suite.
    @event.listens_for(app.state.database.engine, "connect")
    def hurry(connection: Any, _: Any) -> None:
        connection.execute("PRAGMA synchronous=OFF")

    return app


@pytest.fixture
def database(app: FastAPI) -> Database:
    database: Database = app.state.database
    return database


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    """A browser on the approved origin: it keeps cookies and sends Origin like a real one."""
    with TestClient(app, base_url=ORIGIN, headers={"Origin": ORIGIN}) as client:
        yield client


@pytest.fixture
def browser(app: FastAPI) -> Iterator[Callable[..., TestClient]]:
    """Further browsers on the same server: another tab, another site, or no Origin at all."""
    opened: list[TestClient] = []

    def open(origin: str | None = ORIGIN) -> TestClient:
        client = TestClient(app, base_url=ORIGIN, headers={"Origin": origin} if origin else {})
        opened.append(client)
        return client

    yield open
    for client in opened:
        client.close()


@pytest.fixture(scope="session")
def token_hash() -> str:
    """Hashing is deliberately slow, so the test token is hashed once for the whole run."""
    return hash_token(TOKEN)


@pytest.fixture
def admin(database: Database, clock: FakeClock, token_hash: str) -> StaffUser:
    user = StaffUser(
        id="usr_admin",
        username="admin",
        display_name="Admin",
        role="staff",
        token_hash=token_hash,
        token_set_at=clock.now,
        created_at=clock.now,
    )
    with database.write() as session:
        session.add(user)
    return user


@pytest.fixture
def cli(config: Settings, clock: FakeClock) -> Cli:
    """Run an operator command against the test database, typing `entries` at its prompts.

    Returns the exit code, including the one argparse exits with for arguments it rejects.
    """

    def run(*argv: str, entries: Sequence[str] = ()) -> int:
        typed = iter(entries)
        try:
            return main(list(argv), config=config, clock=clock, secret=lambda _: next(typed))
        except SystemExit as exit:
            return exit.code if isinstance(exit.code, int) else 1

    return run
