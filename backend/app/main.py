import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import partial

from fastapi import FastAPI

from app import errors
from app.api import health, v1
from app.api.description import describe
from app.clock import Clock, utc_now
from app.config import Settings
from app.http import RequestContext
from app.persistence.database import Database
from app.persistence.migrate import is_current


def _show_request_logs() -> None:
    """Send this package's logs to the terminal, unless logging is already set up.

    uvicorn configures only its own loggers, so without this the request lines, which carry
    the request IDs, would be dropped.
    """
    logger = logging.getLogger("app")
    if logging.getLogger().handlers or logger.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


def create_app(settings: Settings | None = None, *, clock: Clock = utc_now) -> FastAPI:
    settings = settings or Settings()
    _show_request_logs()
    database = Database(settings.database_url, busy_timeout_ms=settings.database_busy_timeout_ms)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if not is_current(database):
            raise RuntimeError(
                "The database is missing or out of date. Run `uv run food-admin migrate` first."
            )
        yield
        database.dispose()

    app = FastAPI(
        title="Food Reservations API",
        version="0.1.0",
        openapi_url="/openapi.json" if settings.docs_enabled else None,
        docs_url="/docs" if settings.docs_enabled else None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.database = database
    app.state.clock = clock
    app.add_middleware(RequestContext)
    errors.install(app)
    app.include_router(health.router)
    app.include_router(v1.router)
    app.openapi = partial(describe, app)  # type: ignore[method-assign]
    return app
