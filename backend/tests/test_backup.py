"""The local backup: one file that holds every record and every stored operation answer."""

import shutil
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import httpx2 as httpx
import pytest
from sqlalchemy import text

from app.config import Settings
from app.main import create_app
from app.persistence.database import Database
from app.persistence.migrate import is_current
from app.persistence.models import StaffUser
from app.services import business_settings
from tests.inventory_support import STOCK_SETTINGS
from tests.support import API, ORIGIN, TOKEN, Cli, FakeClock, sqlite_url
from tests.test_server import serving

FLOUR = {"name": "Flour", "base_unit": "g", "low_stock_threshold": None}


@contextmanager
def signed_in(port: int) -> Iterator[httpx.Client]:
    """A browser's worth of HTTP against the running server: cookies, Origin and CSRF token."""
    address = f"http://127.0.0.1:{port}{API}"
    with httpx.Client(base_url=address, headers={"Origin": ORIGIN}) as client:
        token = client.get("/auth/csrf").json()["csrf_token"]
        session = client.post(
            "/auth/sign-in",
            json={"username": "admin", "token": TOKEN},
            headers={"X-CSRF-Token": token},
        )
        assert session.status_code == 200, session.text
        client.headers["X-CSRF-Token"] = session.json()["csrf_token"]
        yield client


def keyed(client: httpx.Client, path: str, body: Any, key: str | None = None) -> httpx.Response:
    return client.post(path, json=body, headers={"Idempotency-Key": key or str(uuid.uuid4())})


def move(client: httpx.Client, ingredient: dict[str, Any], kind: str, delta: str) -> None:
    entry = {
        "expected_version": ingredient["version"],
        "type": kind,
        "delta_base_quantity": delta,
        "reason": "Counted on the shelf",
        "preparation_id": None,
        "corrects_movement_id": None,
    }
    preview = client.post(f"/ingredients/{ingredient['id']}/movement-preview", json=entry).json()
    saved = keyed(
        client, f"/ingredients/{ingredient['id']}/movements", {**entry, "preview_id": preview["id"]}
    )
    assert saved.status_code == 201, saved.text


def test_a_backup_taken_while_the_server_runs_brings_back_every_record_and_stored_answer(
    config: Settings, clock: FakeClock, admin: StaffUser, cli: Cli, tmp_path: Path
) -> None:
    database = Path(config.database_url.removeprefix("sqlite:///"))
    # Plain HTTP on this machine, as the local environment file sets it.
    serving_config = config.model_copy(update={"cookie_secure": False})
    assert cli(*STOCK_SETTINGS) == 0
    key = str(uuid.uuid4())
    backup = tmp_path / "backups" / "monday.db"
    backup.parent.mkdir()

    with serving(create_app(serving_config, clock=clock)) as port, signed_in(port) as client:
        # A day's work: an ingredient is added under an operation key and its stock is counted.
        first = keyed(client, "/ingredients", FLOUR, key)
        assert first.status_code == 201
        move(client, first.json(), "opening", "2000")

        # The backup is taken with the server still running and staff still signed in.
        assert cli("backup", str(backup)) == 0

        # Work goes on after it.
        flour = client.get("/ingredients").json()["items"][0]
        move(client, flour, "waste", "-500")
        assert keyed(client, "/ingredients", {**FLOUR, "name": "Salt"}).status_code == 201
        assert client.get("/ingredients").json()["total"] == 2

    # The database is lost. Restoring is the runbook's steps: with the server stopped, the old
    # file and whatever lies beside it are moved away, and the backup takes its place.
    aside = tmp_path / "replaced"
    aside.mkdir()
    for leftover in database.parent.glob(f"{database.name}*"):
        leftover.rename(aside / leftover.name)
    shutil.copyfile(backup, database)
    assert cli("migrate") == 0

    # The restored server starts and holds exactly what the backup held, in one file.
    with serving(create_app(serving_config, clock=clock)) as port, signed_in(port) as client:
        found = client.get("/ingredients").json()
        assert [(item["name"], item["stock_on_hand"]) for item in found["items"]] == [
            ("Flour", "2000")
        ]
        assert client.get(f"/ingredients/{found['items'][0]['id']}/movements").json()["total"] == 1
        # Operation results are in the same file: the save from before the backup is still
        # known, so sending it again changes nothing and returns the first answer.
        again = keyed(client, "/ingredients", FLOUR, key)
        assert (again.status_code, again.headers["Idempotency-Replayed"]) == (201, "true")
        assert again.content == first.content
        assert client.get(f"/operations/{key}").json()["state"] == "succeeded"
        assert client.get("/ingredients").json()["total"] == 1


def test_a_backup_is_one_complete_file_where_a_copy_of_the_main_file_is_not(
    config: Settings, cli: Cli, database: Database, tmp_path: Path
) -> None:
    source = Path(config.database_url.removeprefix("sqlite:///"))
    plain, target = tmp_path / "plain-copy.db", tmp_path / "backup.db"

    def currency_in(path: Path) -> str | None:
        copy = Database(sqlite_url(path))
        try:
            assert is_current(copy)
            with copy.read() as db:
                settings = business_settings.load(db)
                return settings.currency if settings is not None else None
        finally:
            copy.dispose()

    # Something still has the database open, as a running server does, or one that did not
    # stop cleanly. What is written meanwhile sits in the write-ahead file beside the database.
    with database.read() as held:
        held.execute(text("SELECT 1"))
        assert cli(*STOCK_SETTINGS) == 0
        assert source.with_name(source.name + "-wal").exists()
        shutil.copyfile(source, plain)

        assert cli("backup", str(target)) == 0
        assert [path.name for path in tmp_path.glob("backup.db*")] == ["backup.db"]

    # The plain copy of the main file has lost the settings. The backup has everything, alone.
    assert currency_in(plain) is None
    assert currency_in(target) == "USD"


def test_a_backup_never_overwrites_a_file_or_guesses_a_directory(
    cli: Cli, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    taken = tmp_path / "taken.db"
    taken.write_text("an earlier backup")
    capsys.readouterr()

    assert cli("backup", str(taken)) == 1
    assert "already exists" in capsys.readouterr().err
    assert cli("backup", str(tmp_path / "nowhere" / "copy.db")) == 1
    assert "directory" in capsys.readouterr().err

    assert taken.read_text() == "an earlier backup"
    assert not (tmp_path / "nowhere").exists()
