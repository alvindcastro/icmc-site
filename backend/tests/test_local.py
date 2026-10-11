"""`food-local`: both sides of the project started, watched and stopped by one command."""

import sys
from pathlib import Path
from typing import Any

import pytest

from app.cli import main as admin
from app.config import Settings
from app.local import main
from tests.support import FakeClock, sqlite_url


class Process:
    """Stands in for a started program: it runs until told what it exited with."""

    def __init__(self, command: list[str], options: dict[str, Any]) -> None:
        self.command, self.options = command, options
        self.pid = 4242
        self.code: int | None = None
        self.stopped = False

    def poll(self) -> int | None:
        return self.code

    def terminate(self) -> None:
        self.stopped, self.code = True, -15

    def wait(self, timeout: float | None = None) -> int:
        return self.code or 0


class Programs:
    """Records what was started. `on_wait` is called each time the launcher pauses."""

    def __init__(self) -> None:
        self.started: list[Process] = []
        self.pauses = 0
        self.on_wait: Any = lambda programs: None

    def spawn(self, command: list[str], **options: Any) -> Process:
        process = Process(command, options)
        self.started.append(process)
        return process

    def pause(self, seconds: float) -> None:
        self.pauses += 1
        self.on_wait(self)


@pytest.fixture
def frontend(tmp_path: Path) -> Path:
    path = tmp_path / "frontend"
    (path / "node_modules").mkdir(parents=True)
    return path


@pytest.fixture
def ready(tmp_path: Path, clock: FakeClock) -> Settings:
    """A database on which local setup has been run, with the cookie allowed over plain HTTP."""
    config = Settings(
        _env_file=None, database_url=sqlite_url(tmp_path / "local.db"), cookie_secure=False
    )
    assert admin(["setup-local"], config=config, clock=clock) == 0
    return config


def run(config: Settings, frontend: Path, programs: Programs, *argv: str) -> int:
    return main(
        ["--frontend", str(frontend), *argv],
        config=config,
        spawn=programs.spawn,
        pause=programs.pause,
        npm="npm",
        stop=lambda process: process.terminate(),
    )


def test_it_starts_the_server_and_the_frontend_and_stops_both_on_ctrl_c(
    ready: Settings, frontend: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    programs = Programs()

    def interrupt(_: Programs) -> None:
        raise KeyboardInterrupt

    programs.on_wait = interrupt

    assert run(ready, frontend, programs) == 0

    server, web = programs.started
    assert server.command == [
        sys.executable,
        "-m",
        "uvicorn",
        "app.main:create_app",
        "--factory",
        "--host",
        "127.0.0.1",
        "--port",
        "8000",
    ]
    assert (web.command, web.options["cwd"]) == (["npm", "run", "dev"], frontend)
    # The frontend is told where the server is, whatever port was chosen.
    assert web.options["env"]["API_PROXY_TARGET"] == "http://127.0.0.1:8000"
    assert (server.stopped, web.stopped) == (True, True)
    shown = capsys.readouterr().out
    assert "http://127.0.0.1:5173" in shown
    assert "Ctrl+C" in shown


def test_another_port_reaches_the_server_and_the_frontends_proxy(
    ready: Settings, frontend: Path
) -> None:
    programs = Programs()

    def interrupt(_: Programs) -> None:
        raise KeyboardInterrupt

    programs.on_wait = interrupt

    assert run(ready, frontend, programs, "--port", "8123") == 0

    server, web = programs.started
    assert server.command[-2:] == ["--port", "8123"]
    assert web.options["env"]["API_PROXY_TARGET"] == "http://127.0.0.1:8123"


def test_when_one_side_stops_the_other_is_stopped_and_its_code_is_returned(
    ready: Settings, frontend: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    programs = Programs()

    def frontend_dies(running: Programs) -> None:
        if running.pauses == 2:
            running.started[1].code = 3

    programs.on_wait = frontend_dies

    assert run(ready, frontend, programs) == 3

    server, web = programs.started
    assert (server.stopped, web.stopped) == (True, False)
    assert "The frontend stopped" in capsys.readouterr().err


@pytest.mark.parametrize("without", ["database", "setup", "cookie", "frontend", "packages", "npm"])
def test_it_says_what_is_missing_and_starts_nothing(
    tmp_path: Path,
    ready: Settings,
    frontend: Path,
    clock: FakeClock,
    capsys: pytest.CaptureFixture[str],
    without: str,
) -> None:
    programs = Programs()
    config, npm = ready, "npm"
    expected = {
        "database": "food-admin setup-local",
        "setup": "food-admin setup-local",
        "cookie": "FOOD_API_COOKIE_SECURE=false",
        "frontend": "No frontend",
        "packages": "npm ci",
        "npm": "Node.js",
    }[without]
    if without == "database":
        config = Settings(_env_file=None, database_url=sqlite_url(tmp_path / "none.db"))
    elif without == "setup":
        config = Settings(
            _env_file=None, database_url=sqlite_url(tmp_path / "empty.db"), cookie_secure=False
        )
        assert admin(["migrate"], config=config, clock=clock) == 0
    elif without == "cookie":
        config = Settings(_env_file=None, database_url=ready.database_url)
    elif without == "frontend":
        frontend = tmp_path / "elsewhere"
    elif without == "packages":
        (frontend / "node_modules").rmdir()
    else:
        npm = ""
    capsys.readouterr()

    code = main(
        ["--frontend", str(frontend)],
        config=config,
        spawn=programs.spawn,
        pause=programs.pause,
        npm=npm,
        stop=lambda process: process.terminate(),
    )

    assert code == 1
    assert expected in capsys.readouterr().err
    assert programs.started == []


def test_the_environment_file_may_hold_notes_the_server_does_not_read(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    env.write_text("FOOD_API_COOKIE_SECURE=false\nLOCAL_ADMIN_TOKEN=kept-here-by-the-developer\n")

    config = Settings(_env_file=env)

    assert config.cookie_secure is False
    assert "LOCAL_ADMIN_TOKEN" not in config.model_dump()
