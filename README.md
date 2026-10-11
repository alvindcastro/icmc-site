# Food Reservation and Ingredient Tracker

An internal tool for a small food business. Staff record preorders taken by phone or message, follow each order through preparation and payment, keep ingredient stock and purchase prices, and see what to cook and what to buy.

It has two parts: a React frontend in [`frontend/`](frontend/README.md) and a Python/FastAPI backend in [`backend/`](backend/README.md), with SQLite for storage.

## Status

This is a local project. It runs on the developer's machine only; it is not hosted and holds no real data.

- Every screen and every area of the [API contract](frontend/docs/phase-0/API_CONTRACT.md) is built, and each was checked with the frontend running against the real backend. The frontend's contract tests also run against the backend itself.
- The settings and the menu that local setup creates are provisional. Currency, timezone, delivery and tax rules, the menu prices and the recipes have not been confirmed by the business.
- Still to do before real use: hosting behind HTTPS, backups that are scheduled and kept off the machine, a restore of a real system's backup, a security review, and a review with staff. Do not enter real payments before then.
- The automated checks have been run on Linux only. The commands below are written for Windows PowerShell and have not been verified there.

## What It Does

- **Menu:** foods with their sizes, selling units and prices.
- **Orders:** quotes and reservations whose prices do not change once agreed, a dashboard by business date, and the steps from confirmed to completed, or cancelled.
- **Payments:** deposits, payments and refunds in a ledger that is only ever added to.
- **Stockroom:** ingredients, stock movements, and purchase receipts with a price history.
- **Recipes:** what goes into one selling unit of each size, and an ingredient cost estimate from the latest purchases.
- **Planning:** what remains to cook in a period, which ingredients fall short, and a printable shopping list.
- **Preparation:** what was actually cooked and used, deducted from stock exactly once, with corrections kept as separate records.

## Run It Locally

You need [uv](https://docs.astral.sh/uv/), which installs Python 3.12 itself, and Node.js 22.12 or newer.

Backend, in one terminal:

```powershell
cd backend
uv sync
Copy-Item .env.example .env
uv run food-admin setup-local
uv run uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000 --reload
```

`setup-local` creates the database, provisional settings and a small provisional menu, and prints the `admin` token once. Keep it: only a hash is stored.

Frontend, in a second terminal:

```powershell
cd frontend
npm ci
npm run dev
```

Open `http://127.0.0.1:5173` and sign in as `admin` with that token.

Once both are set up, one command in `backend/` starts both sides and Ctrl+C stops them:

```powershell
uv run food-local
```

The [runbook](backend/RUNBOOK.md) covers the day-to-day tasks: the token, settings, backing up and restoring, and starting over.

To look at the frontend without any backend, run `npm run dev:fixtures` instead and sign in as `admin` with the token `local-admin-token`. That token is synthetic and works only in fixture mode; the data lives in memory and is gone on reload.

Preparation recording is off after local setup, because it changes how orders become ready. The backend README explains [how to turn it on](backend/README.md#turning-preparation-recording-on).

## Checks

```powershell
cd backend
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run mypy
```

```powershell
cd frontend
npm run typecheck
npm test
npm run build
npm exec -- playwright install chromium
npm run test:e2e
npm run test:conformance
```

`test:conformance` runs the frontend's contract tests against the real backend; it needs the backend set up and starts a test-only server by itself.

CI runs the four backend commands, the frontend type check and unit tests, and the conformance run on every push. It does not run the browser tests.

## Layout

```text
frontend/                           React/TypeScript application, its tests and its documents
backend/                            FastAPI application, operator commands, migrations and tests
food_reservation_mvp_checklist.md   the original checklist the work started from
.github/workflows/ci.yml            the checks run on every push
```

## Documents

| Document | What it is |
|---|---|
| [API contract](frontend/docs/phase-0/API_CONTRACT.md) | Every request and response both sides agree on, with the backend's clarifications |
| [Decision register](frontend/docs/phase-0/DECISIONS.md) | The business rules, and which of them still await confirmation |
| [Acceptance scenarios](frontend/docs/phase-0/ACCEPTANCE.md) | The worked cases the system must get right |
| [Runbook](backend/RUNBOOK.md) | Day-to-day tasks on one machine |
| [Frontend plan](frontend/FRONTEND_IMPLEMENTATION_PLAN.md), [backend plan](backend/BACKEND_IMPLEMENTATION_PLAN.md) | The work by phase, with what is done and what is open |
| `frontend/docs/phase-N/VERIFICATION.md`, `backend/docs/phase-N/VERIFICATION.md` | What was tested for each phase, what was seen, and what was not covered |
| [Original checklist](food_reservation_mvp_checklist.md) | The first statement of scope; the plans above supersede its task lists |

Each phase was written test-first and ended with the frontend run against the real server. The verification records say what was observed, including the mistakes along the way.
