"""`food-local`: run both sides of the project on this machine with one command.

It starts the server on 127.0.0.1 and the frontend's development server in live mode, which
forwards `/api` to it, and stops both together. For development only: nothing here is how a
hosted system would be run.
"""

import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, Protocol

from app.config import Settings
from app.errors import OperatorError
from app.persistence import migrate
from app.persistence.database import Database
from app.services import accounts, business_settings

_SETUP = "Run `uv run food-admin setup-local` first."


class Running(Protocol):
    pid: int

    def poll(self) -> int | None: ...
    def terminate(self) -> None: ...
    def wait(self, timeout: float | None = None) -> int: ...


def _check(config: Settings, frontend: Path, npm: str) -> None:
    """Refuse to start anything that could not work, and say what to do about it."""
    database = Database(config.database_url)
    try:
        if not migrate.is_current(database):
            raise OperatorError(f"The database is missing or out of date. {_SETUP}")
        with database.read() as db:
            if business_settings.load(db) is None or not accounts.has_token(db):
                raise OperatorError(f"Local setup is not finished. {_SETUP}")
    finally:
        database.dispose()
    if config.cookie_secure:
        raise OperatorError(
            "The session cookie is set to travel over HTTPS only, so sign-in from the "
            "frontend's development server cannot work. Copy `.env.example` to `.env`, or "
            "set FOOD_API_COOKIE_SECURE=false."
        )
    if not frontend.is_dir():
        raise OperatorError(f"No frontend at {frontend}. Give its directory with --frontend.")
    if not (frontend / "node_modules").is_dir():
        raise OperatorError(
            f"The frontend's packages are not installed. Run `npm ci` in {frontend} first."
        )
    if not npm:
        raise OperatorError("npm was not found. Install Node.js 22.12 or newer.")


def _apart() -> dict[str, Any]:
    """Start a program in a group of its own, so that it and whatever it starts can be stopped
    together and Ctrl+C reaches only this command, which then stops both sides in order."""
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


def _stop(process: Running) -> None:
    """Stop a program and everything it started: npm runs the development server as a child."""
    if process.poll() is not None:
        return
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=False
        )
    else:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.terminate()


def main(
    argv: Sequence[str] | None = None,
    *,
    config: Settings | None = None,
    spawn: Callable[..., Running] = subprocess.Popen,
    pause: Callable[[float], None] = time.sleep,
    npm: str | None = None,
    stop: Callable[[Running], None] = _stop,
) -> int:
    parser = argparse.ArgumentParser(prog="food-local", description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8000, help="the server's port")
    parser.add_argument(
        "--frontend",
        type=Path,
        default=Path(__file__).resolve().parents[2] / "frontend",
        help="the frontend's directory, if it is not beside this one",
    )
    args = parser.parse_args(argv)
    config = config or Settings()
    program = (shutil.which("npm") or "") if npm is None else npm
    try:
        _check(config, args.frontend, program)
    except OperatorError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    address = f"http://127.0.0.1:{args.port}"
    server = spawn(
        [sys.executable, "-m", "uvicorn", "app.main:create_app", "--factory"]
        + ["--host", "127.0.0.1", "--port", str(args.port)],
        **_apart(),
    )
    web = spawn(
        [program, "run", "dev"],
        cwd=args.frontend,
        env={**os.environ, "API_PROXY_TARGET": address},
        **_apart(),
    )
    sides = (("The server", server), ("The frontend", web))
    print(f"The server is starting on {address}; the frontend prints its own address,")
    print(
        "normally http://127.0.0.1:5173. Sign in there as admin. Press Ctrl+C to stop both.",
        flush=True,
    )
    try:
        while True:
            for name, process in sides:
                code = process.poll()
                if code is not None:
                    print(f"{name} stopped with code {code}; stopping the other.", file=sys.stderr)
                    for _, other in sides:
                        if other is not process:
                            stop(other)
                    return code or 1
            pause(0.5)
    except KeyboardInterrupt:
        for _, process in sides:
            stop(process)
        print("Both sides are stopped.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
