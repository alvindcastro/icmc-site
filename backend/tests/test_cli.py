from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import inspect, select

from app.cli import main
from app.config import Settings
from app.main import create_app
from app.persistence.database import Database
from app.persistence.models import StaffUser
from app.services import business_settings
from tests.support import API, ORIGIN, Cli, FakeClock, error_of, sign_in, sqlite_url

FIRST = "first operator token"
SECOND = "second operator token"


def database_bytes(config: Settings) -> bytes:
    path = Path(config.database_url.removeprefix("sqlite:///"))
    return b"".join(file.read_bytes() for file in path.parent.glob(f"{path.name}*"))


def test_migrate_builds_a_new_database_and_can_be_repeated(
    tmp_path: Path, clock: FakeClock
) -> None:
    config = Settings(_env_file=None, database_url=sqlite_url(tmp_path / "new.db"))

    assert main(["migrate"], config=config, clock=clock) == 0
    assert main(["migrate"], config=config, clock=clock) == 0

    database = Database(config.database_url)
    with database.read() as session:
        assert "staff_users" in inspect(session.connection()).get_table_names()
    database.dispose()


def test_a_command_explains_a_database_that_was_never_migrated(
    tmp_path: Path, clock: FakeClock, capsys: pytest.CaptureFixture[str]
) -> None:
    config = Settings(_env_file=None, database_url=sqlite_url(tmp_path / "new.db"))

    code = main(["token", "set"], config=config, clock=clock, secret=lambda _: FIRST)

    assert code == 1
    assert "food-admin migrate" in capsys.readouterr().err


def test_the_operator_sets_the_admin_token(
    cli: Cli,
    client: TestClient,
    database: Database,
    config: Settings,
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert cli("token", "set", entries=[FIRST, FIRST]) == 0

    output = capsys.readouterr()
    assert FIRST not in output.out + output.err
    assert sign_in(client, FIRST).json()["user"]["username"] == "admin"
    with database.read() as session:
        user = session.scalars(select(StaffUser)).one()
    assert (user.username, user.display_name, user.role) == ("admin", "Admin", "staff")
    assert user.token_hash and FIRST not in user.token_hash
    # Only a salted hash is stored: the same token never hashes to the same text twice.
    assert FIRST.encode() not in database_bytes(config)


def test_setting_a_token_twice_is_refused_in_favour_of_rotation(
    cli: Cli, client: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    cli("token", "set", entries=[FIRST, FIRST])

    assert cli("token", "set", entries=[SECOND, SECOND]) == 1

    assert "token rotate" in capsys.readouterr().err
    error_of(sign_in(client, SECOND), 401, "invalid_credentials")
    assert sign_in(client, FIRST).status_code == 200


def test_rotating_replaces_the_token_and_ends_open_sessions(cli: Cli, client: TestClient) -> None:
    cli("token", "set", entries=[FIRST, FIRST])
    sign_in(client, FIRST)
    assert client.get(f"{API}/auth/session").status_code == 200

    assert cli("token", "rotate", entries=[SECOND, SECOND]) == 0

    error_of(client.get(f"{API}/auth/session"), 401, "unauthenticated")
    error_of(sign_in(client, FIRST), 401, "invalid_credentials")
    assert sign_in(client, SECOND).status_code == 200


def test_rotating_needs_a_token_to_replace(cli: Cli, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli("token", "rotate", entries=[SECOND, SECOND]) == 1
    assert "token set" in capsys.readouterr().err


def test_a_generated_token_is_shown_once_and_works(
    cli: Cli, client: TestClient, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli("token", "set", "--generate") == 0

    generated = capsys.readouterr().out.strip().splitlines()[-1].strip()
    assert len(generated) >= 32
    assert sign_in(client, generated).status_code == 200
    assert cli("token", "rotate", "--generate") == 0
    assert capsys.readouterr().out.strip().splitlines()[-1].strip() != generated


@pytest.mark.parametrize(
    "entries",
    [
        ["too short", "too short"],
        ["a long enough token", "a different long token"],
        [" " * 20, " " * 20],
    ],
)
def test_weak_blank_or_mistyped_tokens_are_refused(
    cli: Cli, client: TestClient, database: Database, entries: list[str]
) -> None:
    assert cli("token", "set", entries=entries) == 1

    with database.read() as session:
        assert session.scalars(select(StaffUser.token_hash)).all() in ([], [None])
    assert sign_in(client, entries[0]).status_code in {401, 422}


# --- One-command local setup -----------------------------------------------------------------


def fresh(tmp_path: Path) -> Settings:
    return Settings(
        _env_file=None, database_url=sqlite_url(tmp_path / "new.db"), allowed_origins=ORIGIN
    )


def browser_on(config: Settings, clock: FakeClock) -> TestClient:
    return TestClient(create_app(config, clock=clock), base_url=ORIGIN, headers={"Origin": ORIGIN})


def test_local_setup_makes_a_new_machine_ready_in_one_command(
    tmp_path: Path, clock: FakeClock, capsys: pytest.CaptureFixture[str]
) -> None:
    config = fresh(tmp_path)

    assert main(["setup-local"], config=config, clock=clock) == 0

    token = capsys.readouterr().out.strip().splitlines()[-1].strip()
    with browser_on(config, clock) as client:
        assert sign_in(client, token).status_code == 200
        settings = client.get(f"{API}/settings").json()
        foods = client.get(f"{API}/foods").json()["items"]
    assert (settings["environment"], settings["currency"], settings["minor_digits"]) == (
        "development",
        "USD",
        2,
    )
    assert settings["timezone"] == "America/Los_Angeles"
    assert settings["fulfillment_methods"] == ["pickup", "delivery"]
    assert settings["delivery_policy"] == {"mode": "manual_amount", "fixed_charge_minor": None}
    assert settings["payment_methods"] == ["cash", "bank_transfer", "other"]
    # Provisional values stay unconfirmed, and only workflows this server has are switched on.
    assert not any(value for value in settings["confirmation"].values())
    enabled = {name for name, enabled in settings["capabilities"].items() if enabled}
    assert enabled == business_settings.RELEASED
    assert "inventory" not in enabled
    assert [food["name"] for food in foods] == [
        "Beef Caldereta",
        "Fresh Lumpia",
        "Shanghai Spring Rolls",
    ]


def test_local_setup_can_be_repeated_and_then_changes_nothing(
    tmp_path: Path, clock: FakeClock, capsys: pytest.CaptureFixture[str]
) -> None:
    config = fresh(tmp_path)
    main(["setup-local"], config=config, clock=clock)
    token = capsys.readouterr().out.strip().splitlines()[-1].strip()

    assert main(["setup-local"], config=config, clock=clock) == 0

    assert token not in capsys.readouterr().out
    with browser_on(config, clock) as client:
        assert sign_in(client, token).status_code == 200
        assert client.get(f"{API}/settings").json()["version"] == 1
        assert client.get(f"{API}/foods").json()["total"] == 3


def test_local_setup_keeps_what_the_operator_already_chose(
    tmp_path: Path, clock: FakeClock, capsys: pytest.CaptureFixture[str]
) -> None:
    config = fresh(tmp_path)
    main(["migrate"], config=config, clock=clock)
    main(["token", "set"], config=config, clock=clock, secret=lambda _: FIRST)
    main(
        [
            "settings",
            "set",
            "--currency=PHP",
            "--minor-digits=2",
            "--timezone=Asia/Manila",
            "--fulfillment=pickup",
            "--enable=menu",
        ],
        config=config,
        clock=clock,
    )
    capsys.readouterr()

    assert main(["setup-local"], config=config, clock=clock) == 0

    assert "shown once" not in capsys.readouterr().out
    with browser_on(config, clock) as client:
        assert sign_in(client, FIRST).status_code == 200
        settings = client.get(f"{API}/settings").json()
        assert (settings["currency"], settings["timezone"], settings["version"]) == (
            "PHP",
            "Asia/Manila",
            1,
        )
        assert client.get(f"{API}/foods").json()["total"] == 3


def test_local_setup_refuses_live_settings(
    tmp_path: Path, clock: FakeClock, capsys: pytest.CaptureFixture[str]
) -> None:
    config = fresh(tmp_path)
    main(["setup-local"], config=config, clock=clock)
    main(["settings", "set", "--environment=live"], config=config, clock=clock)
    capsys.readouterr()

    assert main(["setup-local"], config=config, clock=clock) == 1
    assert "live" in capsys.readouterr().err
