from fastapi import FastAPI

from app.api import health, v1
from app.config import Settings


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    app = FastAPI(
        title="Food Reservations API",
        version="0.1.0",
        openapi_url="/openapi.json" if settings.docs_enabled else None,
        docs_url="/docs" if settings.docs_enabled else None,
        redoc_url=None,
    )
    app.include_router(health.router)
    app.include_router(v1.router)
    return app
