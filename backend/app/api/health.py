from fastapi import APIRouter

router = APIRouter()


@router.get("/healthz")
def health() -> dict[str, str]:
    """Liveness for whatever fronts the server; outside /api/v1 and free of business data."""
    return {"status": "ok"}
