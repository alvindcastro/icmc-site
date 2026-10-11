# Phase B0 Verification

Date: 2026-10-10. Backend scaffold delivered. Six of the eight Phase B0 tasks are complete; contract agreement and the remaining decisions are open and need the project owner. Not committed at the time of writing.

## Plan Review

- Phase B0 is setup only. No contract endpoint, database, session or business rule belongs here, so the scaffold contains nothing that a later phase would have to remove.
- The scaffold must not pretend the API exists. Contract routes answer 404 until their phase delivers them, and the frontend shows its ordinary recoverable error.
- The "local setup command" task that was listed under B0 cannot be completed here: it creates the database, the sign-in token, settings and the menu seed, none of which exist before Phases B1 and B2. It has been moved to the end of Phase B2.
- Two decisions were settled by building the scaffold as the plan recommended: tooling (D10) and repository layout (D13). The other open decisions are not needed until Phase B1.

## Delivered Scope

A Python package `app` with an application factory, settings read from `FOOD_API_*` environment variables or a local `.env` file, a health check at `/healthz` outside the versioned API, and an empty `/api/v1` router that each contract area will add to. The API description is served at `/docs` and `/openapi.json` and can be switched off with `FOOD_API_DOCS_ENABLED=false`.

Tooling is uv with a cross-platform `uv.lock`, Python 3.12, ruff for linting and formatting, mypy in strict mode and pytest. The repository has a CI workflow that runs the four backend checks and, in a second job, the frontend type check and unit tests on every push and pull request. The backend README covers setup, running, configuration, checks, PyCharm and the layout.

## Observed TDD

Tests were written first against importable stubs: a factory returning a bare application and a settings class that ignored its input.

| Cycle | Observed Red | Green Result |
|---|---|---|
| Health, API description, settings | 5 of 7 tests failed: `/healthz` was 404, the description had the framework's default title and could not be switched off, and settings ignored the environment and the `.env` file. The two tests that unbuilt contract routes are 404 passed against the bare application | Health answers `{"status": "ok"}`, the description is titled and can be disabled, settings read the environment and a local file: 7 tests pass. |

Tooling correction, not counted as red: the first run warned that the test client's `httpx` dependency is deprecated in favour of `httpx2`; the development dependency was changed and the warning is gone.

## Final Verification

- [x] `uv sync --locked`: installs from the committed lockfile on a clean copy.
- [x] `uv run pytest`: 7 tests passed.
- [x] `uv run ruff check .` and `uv run ruff format --check .`: passed.
- [x] `uv run mypy`: no issues in 8 source files, strict mode.
- [x] Server started with `uvicorn app.main:create_app --factory` on `127.0.0.1:8000`; `/healthz` answered 200 with a `Date` header.
- [x] Frontend development proxy confirmed: with the frontend running in live mode, `GET /api/v1/auth/session` on the frontend's port was answered by the backend (404 from uvicorn, visible in the backend's access log), while `/healthz` on the frontend's port was not forwarded.
- [x] The frontend opened against the scaffold shows "The request could not be completed." with Retry session check, sign-in disabled and no page errors, which is the expected state until Phase B1.
- [x] Checks ran in a Linux copy of the workspace with uv and Python 3.12 kept inside a temporary directory.
- [x] The CI workflow's first run, on the commit that added it (`22894dd`), passed in both the backend and frontend jobs.

Resolved versions in the lockfile include FastAPI 0.143.0, Starlette 1.7.0, Pydantic 2.14.0, uvicorn 0.54.0, pytest 9.1.1, ruff 0.17.0 and mypy 2.4.0.

## Still Open in Phase B0

- [ ] Review each contract section and record what is accepted or changed (decision D11). This is the owner's decision and closes the two agreement tasks in the frontend plan.
- [ ] Resolve the remaining decisions: D01 and D03-D09 before Phase B1 and B2 build on them, and D12 before Phase B6.

## Entry Points

| File | Responsibility |
|---|---|
| [main.py](../../app/main.py) | Application factory |
| [config.py](../../app/config.py) | Settings from the environment |
| [health.py](../../app/api/health.py) | Health check outside the versioned API |
| [v1/\_\_init\_\_.py](../../app/api/v1/__init__.py) | Mount point for contract routers |
| [test_app.py](../../tests/test_app.py) | Behavioral tests for the scaffold |
