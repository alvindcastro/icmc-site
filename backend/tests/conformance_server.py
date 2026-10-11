"""The server the frontend's conformance run talks to. Development tooling; never deployed.

The frontend's fixture contract tests each start from a new in-memory fixture. Here each one
gets a "world": its own database, seeded to match the fixture's starting state, behind the
real application. Nothing is added inside the application. Around it:

- `POST /__conformance__/worlds` makes a world and answers `{"world": "<id>"}`. The body may
  say `{"preparation": true}` for a world that records preparation.
- Every other request names its world in `X-Conformance-World`. It may give the time in
  `X-Conformance-Now` as milliseconds since 1970, so a test that moves its own clock moves
  the server's with it.
- `POST /__conformance__/worlds/<id>/expire` lets the world's sessions run out, which is what
  the fixture's `expire()` stands for.
- `POST /__conformance__/stop` ends the server once the run is over.

Run it from `backend/` with `uv run python -m tests.conformance_server`.
"""

import argparse
import shutil
import tempfile
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI
from sqlalchemy import event, update
from sqlalchemy.orm import Session
from starlette.datastructures import Headers
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import Receive, Scope, Send

from app.clock import utc_now
from app.config import Settings
from app.ids import new_id
from app.main import create_app
from app.persistence.database import Database
from app.persistence.migrate import upgrade
from app.persistence.models import AuthSession, Category, Food, StaffUser, Variant
from app.services import business_settings
from app.services.credentials import hash_token

ORIGIN = "http://conformance.local"
# The fixture's documented sign-in. It is synthetic and exists nowhere but in these worlds.
TOKEN = "local-admin-token"
CONTROL = "/__conformance__"

# The fixture's starting menu, with its fixed IDs, so that tests which name them still do.
CATEGORIES = (
    ("beef", "Beef"),
    ("chicken", "Chicken"),
    ("fish-more", "Fish, Lumpia & More"),
    ("pork", "Pork"),
)
FOODS: tuple[tuple[str, str, str, bool, tuple[tuple[str, str, int, int | None], ...]], ...] = (
    (
        "fixture_caldereta",
        "Beef Caldereta",
        "beef",
        True,
        (
            ("Small", "tray", 6000, None),
            ("Medium", "tray", 8000, None),
            ("Large", "tray", 10500, None),
        ),
    ),
    ("fixture_fresh_lumpia", "Fresh Lumpia", "fish-more", True, (("Each", "piece", 300, None),)),
    (
        "fixture_shanghai",
        "Shanghai Spring Rolls",
        "fish-more",
        True,
        (("100 pieces", "package", 5500, 100),),
    ),
    (
        "fixture_development_skewers",
        "Development skewers",
        "pork",
        False,
        (("Each stick", "stick", 150, None),),
    ),
)


def sqlite_url(path: Path) -> str:
    return f"sqlite:///{path.as_posix()}"


def seed(db: Session, token_hash: str, preparation: bool, now: datetime) -> None:
    """Put a new database in the state the frontend's fixture starts in."""
    db.add(
        StaffUser(
            id="fixture_admin",
            username="admin",
            display_name="Admin",
            role="staff",
            token_hash=token_hash,
            token_set_at=now,
            created_at=now,
        )
    )
    enabled = sorted(business_settings.RELEASED - business_settings.OPT_IN)
    if preparation:
        enabled.append("preparation_recording")
    business_settings.change(db, now, business_settings.PROVISIONAL_DEVELOPMENT, enable=enabled)
    for category_id, name in CATEGORIES:
        db.add(Category(id=category_id, name=name, name_key=name.casefold(), created_at=now))
    db.flush()
    for food_id, name, category_id, available, variants in FOODS:
        food = Food(
            id=food_id,
            version=1,
            name=name,
            name_key=name.casefold(),
            category_id=category_id,
            description="",
            available=available,
            confirmation_status="provisional",
            created_at=now,
            updated_at=now,
        )
        db.add(food)
        for position, (label, unit, price, quantity) in enumerate(variants):
            food.variants.append(
                Variant(
                    id=new_id("var"),
                    version=1,
                    position=position,
                    label=label,
                    selling_unit=unit,
                    price_minor=price,
                    available=True,
                    confirmation_status="provisional",
                    package_quantity=quantity,
                    used_on_order=False,
                    created_at=now,
                    updated_at=now,
                )
            )


class WorldClock:
    """The real time, unless the test that owns the world has said what time it is."""

    def __init__(self) -> None:
        self.now: datetime | None = None

    def __call__(self) -> datetime:
        return self.now or utc_now()


@dataclass
class World:
    app: FastAPI
    clock: WorldClock

    @property
    def database(self) -> Database:
        database: Database = self.app.state.database
        return database


class Conformance:
    """An ASGI application that hands each request to the world it names."""

    def __init__(self, root: Path) -> None:
        self.root = root
        # Set by whoever runs the server, so that a run can ask it to stop when it is done.
        self.stop: Callable[[], None] | None = None
        self.worlds: dict[str, World] = {}
        self.templates: dict[bool, Path] = {}
        # Hashing is deliberately slow, so the one token is hashed once.
        self.token_hash = hash_token(TOKEN)

    def _template(self, preparation: bool) -> Path:
        """A migrated, seeded database to copy; made the first time it is wanted."""
        if preparation not in self.templates:
            path = self.root / f"template-{int(preparation)}.db"
            database = Database(sqlite_url(path))
            upgrade(database)
            with database.write() as db:
                seed(db, self.token_hash, preparation, utc_now())
            database.dispose()
            self.templates[preparation] = path
        return self.templates[preparation]

    def create(self, preparation: bool) -> str:
        world_id = uuid.uuid4().hex
        path = self.root / f"{world_id}.db"
        shutil.copyfile(self._template(preparation), path)
        clock = WorldClock()
        config = Settings(
            _env_file=None,
            database_url=sqlite_url(path),
            allowed_origins=ORIGIN,
            cookie_secure=False,
            docs_enabled=False,
        )
        app = create_app(config, clock=clock)

        # A world dies with its test, so it need not survive a power cut.
        @event.listens_for(app.state.database.engine, "connect")
        def hurry(connection: Any, _: Any) -> None:
            connection.execute("PRAGMA synchronous=OFF")

        self.worlds[world_id] = World(app, clock)
        return world_id

    def expire(self, world: World) -> None:
        """Let every open session of the world run out, as if staff had been away too long."""
        past = world.clock() - timedelta(seconds=1)
        with world.database.write() as db:
            db.execute(
                update(AuthSession)
                .where(AuthSession.user_id.is_not(None), AuthSession.ended_at.is_(None))
                .values(idle_expires_at=past)
            )

    async def _control(self, request: Request) -> Response:
        parts = request.url.path.removeprefix(CONTROL).strip("/").split("/")
        if request.method == "GET" and parts == ["health"]:
            return JSONResponse({"status": "ok"})
        if request.method == "POST" and parts == ["worlds"]:
            options = await request.json() if await request.body() else {}
            return JSONResponse({"world": self.create(bool(options.get("preparation")))}, 201)
        if request.method == "POST" and len(parts) == 3 and parts[::2] == ["worlds", "expire"]:
            world = self.worlds.get(parts[1])
            if world is None:
                return JSONResponse({"error": "No such world."}, 404)
            self.expire(world)
            return Response(status_code=204)
        if request.method == "POST" and parts == ["stop"] and self.stop is not None:
            self.stop()
            return Response(status_code=204)
        return JSONResponse({"error": "No such conformance control."}, 404)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                else:
                    for existing in self.worlds.values():
                        existing.database.dispose()
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            return
        if scope["path"].startswith(CONTROL):
            response = await self._control(Request(scope, receive))
            await response(scope, receive, send)
            return
        headers = Headers(scope=scope)
        world = self.worlds.get(headers.get("x-conformance-world", ""))
        if world is None:
            refusal = JSONResponse({"error": "Name a world in X-Conformance-World."}, 400)
            await refusal(scope, receive, send)
            return
        stated = headers.get("x-conformance-now")
        world.clock.now = datetime.fromtimestamp(int(stated) / 1000, UTC) if stated else None
        await world.app(scope, receive, send)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8010)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="food-conformance-") as root:
        print(f"Conformance worlds are kept in {root} until this server stops.")
        application = Conformance(Path(root))
        server = uvicorn.Server(
            uvicorn.Config(application, host="127.0.0.1", port=args.port, log_level="warning")
        )
        application.stop = lambda: setattr(server, "should_exit", True)
        server.run()


if __name__ == "__main__":
    main()
