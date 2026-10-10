# Food Reservations Backend

Phase B0 scaffold of the Python/FastAPI backend the [frontend](../frontend/README.md) targets. It starts, answers a health check and serves its API description. No endpoint from the [API contract](../frontend/docs/phase-0/API_CONTRACT.md) exists yet, so the frontend in live mode shows "The request could not be completed." until Phase B1 delivers sign-in. Work is tracked in the [backend plan](BACKEND_IMPLEMENTATION_PLAN.md). This is a local project for now: it runs on the developer's machine only.

## Requirements and Setup

Install [uv](https://docs.astral.sh/uv/). It provides Python 3.12 itself if the machine does not have it.

```powershell
cd backend
uv sync
```

`uv sync` creates `.venv` with the versions pinned in `uv.lock`.

## Run Locally

```powershell
uv run uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000 --reload
```

- `http://127.0.0.1:8000/healthz` answers `{"status":"ok"}`.
- `http://127.0.0.1:8000/docs` shows the API description.

To use it with the frontend, keep the server running and start the frontend in live mode from `frontend/` with `npm run dev`. The frontend's development server forwards `/api` to `127.0.0.1:8000`. `npm run dev:fixtures` does not use this backend.

## Configuration

Settings come from `FOOD_API_*` environment variables or a `.env` file in this directory. Copy `.env.example` to `.env` to change them; `.env` is ignored by git.

| Variable | Default | Effect |
|---|---|---|
| `FOOD_API_DOCS_ENABLED` | `true` | Serves `/docs` and `/openapi.json`. Set to `false` to hide them. |

## Checks

```powershell
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run mypy
```

The repository's CI workflow runs the same four commands, plus the frontend type check and unit tests, on every push.

## PyCharm

1. Open this `backend` directory and run `uv sync` once in the terminal.
2. Under Settings > Project > Python Interpreter, add the existing interpreter in `backend/.venv`.
3. Create a Python run configuration with module `uvicorn`, parameters `app.main:create_app --factory --host 127.0.0.1 --port 8000 --reload`, and this directory as the working directory. It can be run or debugged with breakpoints.
4. Create a pytest run configuration for the `tests` directory with the same working directory.

## Layout

```text
app/main.py         application factory
app/config.py       settings read from the environment
app/api/health.py   health check, outside the versioned API
app/api/v1/         contract routers under /api/v1, one module per area, added phase by phase
tests/              behavioral tests
docs/               verification record for each phase
```

Later phases add `app/services/` for business rules, `app/persistence/` for the database and `app/schemas/` for request and response models. Database migrations arrive with the database in Phase B1.
