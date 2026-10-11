# Food Reservations Backend

The Python/FastAPI backend the [frontend](../frontend/README.md) targets. Phases B1 to B7 are delivered: staff can sign in with the interim `admin` token, sessions expire and can be signed out, business settings are served, the menu can be read and edited with version checks and durable operation keys, orders can be quoted, saved, edited, taken through their fulfillment steps, cancelled, paid and refunded, with a dashboard by business date, ingredients can be kept with their stock movements, purchases and price history, each menu variant can have a recipe with an ingredient cost estimate taken from the latest purchases, a period can be planned into what to cook and what to buy, and what was cooked can be recorded against orders and stock, with corrections. Every area of the contract is now served, and the frontend's fixture contract tests pass against this server (the conformance run). The [API contract](../frontend/docs/phase-0/API_CONTRACT.md) describes each area. Day-to-day tasks are in the [runbook](RUNBOOK.md). Work is tracked in the [backend plan](BACKEND_IMPLEMENTATION_PLAN.md). This is a local project for now: it runs on the developer's machine only.

## Requirements and Setup

Install [uv](https://docs.astral.sh/uv/). It provides Python 3.12 itself if the machine does not have it. Then, once:

```powershell
cd backend
uv sync
Copy-Item .env.example .env
uv run food-admin setup-local
```

- `uv sync` creates `.venv` with the versions pinned in `uv.lock`.
- `.env` holds the local settings. It allows the session cookie over plain HTTP, which this machine needs and a hosted system must not have. Git ignores it.
- `setup-local` creates `food-reservations.db` in this directory (git ignores it too), sets the `admin` token, creates provisional development settings with every workflow enabled except preparation recording, and seeds the provisional menu. It prints the token once: store it, because only a salted hash is kept. Running it again changes nothing.

The provisional settings and menu are the decision register's unconfirmed assumptions (USD, America/Los_Angeles, the five known menu rows). Nothing is confirmed, and the frontend labels it provisional. To choose your own values instead, run the steps separately before `setup-local`, or change them afterwards:

```powershell
uv run food-admin migrate
uv run food-admin token set
uv run food-admin settings set --currency USD --minor-digits 2 --timezone America/Los_Angeles --fulfillment "pickup,delivery" --delivery-mode manual_amount --payment-methods "cash,bank_transfer,other" --enable menu --enable orders --enable payments --enable inventory --enable purchases --enable recipes --enable planning
```

Keep the quotes around the comma-separated values: PowerShell otherwise splits them into separate arguments. `token set` asks twice for a token of at least 12 characters; `token set --generate` creates one and prints it once.

## Run Locally

Both sides with one command, once `npm ci` has been run in `frontend/`:

```powershell
uv run food-local
```

It starts this server and the frontend's development server in live mode, and Ctrl+C stops both. The server alone, for example under PyCharm:

```powershell
uv run uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000 --reload
```

- `http://127.0.0.1:8000/healthz` answers `{"status":"ok"}`.
- `http://127.0.0.1:8000/docs` shows the API description.
- The server refuses to start on a database that was never migrated and says which command to run.
- Do not pass `--no-date-header`. The frontend reads the `Date` header to judge session deadlines.

To use it with the frontend, keep the server running and start the frontend in live mode from `frontend/` with `npm run dev`, then open `http://127.0.0.1:5173` and sign in as `admin`. Menu, Orders and Dashboard appear because those workflows are enabled. The frontend's development server forwards `/api` to `127.0.0.1:8000`, so the browser sees one origin. `npm run dev:fixtures` does not use this backend.

## Operator Commands

The contract has no endpoints for these. Whoever runs the server uses `uv run food-admin <command>` from this directory; each has `--help`.

| Command | Effect |
|---|---|
| `setup-local` | Prepares a development machine in one step: database, token, provisional settings and menu. Keeps whatever already exists. Refuses live settings. |
| `migrate` | Creates the database or brings its schema up to date. Safe to repeat. |
| `token set` | Sets the first `admin` token and creates the account. Refused once a token exists. |
| `token rotate` | Replaces the token and ends every open session. |
| `settings show` | Prints the settings exactly as `GET /settings` returns them. |
| `settings set ...` | Changes settings. The first use needs `--currency`, `--minor-digits`, `--timezone` and `--fulfillment`. Other options: `--environment`, `--pickup-location` or `--no-pickup-location`, `--delivery-mode`, `--fixed-charge-minor`, `--tax-mode`, `--payment-methods`, `--enable` and `--disable` for workflows. |
| `settings confirm <groups>` | Records that `currency`, `timezone`, `fulfillment`, `delivery` or `tax` were confirmed, and when. `--all` confirms every group. |
| `category add <name>`, `category list` | Adds a menu category, or lists them with their IDs. Staff cannot edit categories. |
| `menu show` | Lists foods and variants with their IDs, versions and confirmation status. |
| `menu confirm food\|variant <id> --version N` | Records that you reviewed version N and it is correct. The record becomes `confirmed` at version N+1. |
| `menu seed` | Fills an empty development menu with the provisional rows. Refuses live settings. |
| `preparation status` | Says whether preparation recording is on, and lists the open orders still tracked by hand with their numbered lines. |
| `preparation baseline <reference> --reason "..."` | Brings one open order into recording. `--prepared LINE=QUANTITY` (repeatable) says how many of a line are already cooked; lines not named start at nothing; `--all` means every line is done. Moves no stock. See [Turning Preparation Recording On](#turning-preparation-recording-on). |
| `backup <file>` | Writes the whole database, as committed at that moment, into one new file. Safe while the server runs; never overwrites. The [runbook](RUNBOOK.md#back-up) has the restore. |
| `operations unresolved` | Lists keyed saves that were admitted and never finished. Normally there are none. |
| `operations close <key> --reason "..."` | Records a key the server never saw as rejected, so a browser stuck on that key can move on. |

Rules worth knowing:

- Every change raises the settings version by one. A command that changes nothing says so and leaves the version alone.
- Changing a confirmed value withdraws that group's confirmation.
- New settings start closed: delivery disabled, no payment methods, no workflows, nothing confirmed, environment `development`.
- A workflow can be enabled only once this version of the server implements it. All eight are implemented now: `menu`, `orders`, `payments`, `inventory`, `purchases`, `recipes`, `planning` and `preparation_recording`. Orders need the menu enabled too, because the order editor reads it; payments need at least one payment method in the settings; purchases need `inventory` as well; recipes need `menu` and `inventory`; planning needs `orders`; preparation recording needs `orders`, `planning` and `inventory`.
- Orders created under development settings get references that start with `DEV-`; under live settings they start with `ORD-`.
- Live settings take no orders until all five groups are confirmed, and sell only confirmed foods and variants.
- The stockroom needs only currency and timezone confirmed in a live system. Stock movements and receipts are only ever added to; a mistake is put right with a correction, not an edit.
- Recipes and estimates need the same two confirmations in a live system. An estimate is worked out each time it is asked for, from each ingredient's latest purchase. When a recipe is missing, was written for a selling format the variant no longer has, or uses an ingredient whose latest purchase is missing or in another currency, the estimate has no total at all rather than a low one.
- Planning reads orders, recipes and stock and changes nothing. Its figures are a lower bound whenever it says a recipe is missing.
- `setup-local` enables every workflow except `preparation_recording`. That one changes how orders become ready, so it is turned on deliberately; see [Turning Preparation Recording On](#turning-preparation-recording-on).
- A preparation and a correction are records that never change. Recording what was cooked never moves an order to its next step, and cancelling an order never returns stock.
- Payments and refunds are entries in a ledger that is only ever added to. Back up with `food-admin backup`, not by copying the database file. The tests rehearse a backup and its restore on synthetic data. Before real payments are entered, backups must also be scheduled and kept off the machine, and one taken from the real system must have been restored; that is deferred with hosting.
- A staff edit that changes a confirmed food's name, or a confirmed variant's label, unit, package contents or price, makes it provisional again.
- `operations close` is for one situation: the frontend reports a save it cannot resolve, its status check keeps answering "not found", and the draft is gone. Closing the key tells the frontend the save did not happen. If the original request arrives later it is refused.
- With `--environment live`, work that depends on unconfirmed settings is refused, and the session cookie is always HTTPS-only whatever `.env` says.

## Turning Preparation Recording On

While `preparation_recording` is off, staff vouch for each order themselves: they mark it ready and completed, and no stock moves. Once it is on, every new order keeps a count of what has been cooked. Such an order can be marked ready, and completed, only when nothing is left to cook, and each recorded preparation takes its ingredients from stock.

Orders that were already open when it is turned on keep being tracked by hand until you bring them in. Do it in this order, at a quiet moment:

1. Count the shelves. Put the stock right with opening counts or corrections on the Ingredients screen, so that stock on hand is what is physically there now. Food cooked before today has already left the shelf, so this count already allows for it.
2. Turn recording on:

   ```powershell
   uv run food-admin settings set --enable preparation_recording
   ```

3. List the open orders still tracked by hand, with their numbered lines:

   ```powershell
   uv run food-admin preparation status
   ```

4. For each one, say what the kitchen has already cooked. Lines you do not name start at nothing; `--all` means the whole order is done.

   ```powershell
   uv run food-admin preparation baseline DEV-0001 --prepared 1=2 --prepared 2=30 --reason "Counted with the kitchen on 10 October"
   ```

   This sets the prepared counts, starts counting the order, raises its version by one and writes the counts and your reason to the audit log. It moves no stock: step 1 already accounts for that food.
5. Run `preparation status` again. It should list no orders. Staff now record the rest of each order on the Planning screen.

Things to know:

- A baseline can be run again to put a mistake right, until cooking has been recorded against the order. After that, change its counts with a preparation correction in the application.
- An order left tracked by hand still works as before, and planning counts all of it as still to cook until it is completed.
- An order that is already Ready can be given a baseline with food still to cook. The command says so. The order cannot be completed until the rest is recorded.
- Do not turn recording off again while recorded orders are open. Their counts could then not be completed, and they could not be marked ready.
- Rehearsed on 2026-10-11 against a local server; see the [Phase B7 record](docs/phase-7/VERIFICATION.md#live-verification).

## Configuration

Settings come from `FOOD_API_*` environment variables or the `.env` file in this directory.

| Variable | Default | Effect |
|---|---|---|
| `FOOD_API_DOCS_ENABLED` | `true` | Serves `/docs` and `/openapi.json`. |
| `FOOD_API_DATABASE_URL` | `sqlite:///food-reservations.db` | The SQLite file, relative to where the server starts. |
| `FOOD_API_DATABASE_BUSY_TIMEOUT_MS` | `5000` | How long a request waits for another write before answering 503. |
| `FOOD_API_ALLOWED_ORIGINS` | `http://127.0.0.1:5173,http://localhost:5173` | Comma-separated origins the browser may send changes from. |
| `FOOD_API_COOKIE_SECURE` | `true` | `false` lets the session cookie travel over plain HTTP. `.env.example` sets `false` for local use. |
| `FOOD_API_SESSION_IDLE_SECONDS` | `1800` | A session ends after this long without a business request. |
| `FOOD_API_SESSION_ABSOLUTE_SECONDS` | `43200` | A session ends this long after sign-in, however busy. |
| `FOOD_API_PRE_AUTH_SECONDS` | `900` | Lifetime of the session that carries the CSRF token before sign-in. |
| `FOOD_API_SIGN_IN_MAX_FAILURES` | `5` | Failed sign-ins within the window that lock sign-in. |
| `FOOD_API_SIGN_IN_WINDOW_SECONDS` | `900` | The window for counting failures, and so the longest lock. |

## Checks

```powershell
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run mypy
```

The tests create their own temporary databases and never touch `food-reservations.db`.

The conformance run executes the frontend's fixture contract tests against this server instead of the frontend's in-memory fixtures. It is started from the frontend, and starts and stops a test-only server (`tests/conformance_server.py`) by itself:

```powershell
cd ..\frontend
npm run test:conformance
```

The repository's CI workflow runs the four commands above, the frontend type check and unit tests, and the conformance run, on every push.

## Changing the Schema

Change the models in `app/persistence/models.py`, then write a revision:

```powershell
uv run alembic revision --autogenerate -m "what changed"
```

Review the new file under `app/persistence/migrations/versions/` and apply it with `uv run food-admin migrate`. A test fails if the migrations and the models describe different tables.

## PyCharm

1. Open this `backend` directory and run the setup commands once in the terminal.
2. Under Settings > Project > Python Interpreter, add the existing interpreter in `backend/.venv`.
3. Create a Python run configuration with module `uvicorn`, parameters `app.main:create_app --factory --host 127.0.0.1 --port 8000 --reload`, and this directory as the working directory. It can be run or debugged with breakpoints.
4. Create a pytest run configuration for the `tests` directory with the same working directory.

## Layout

```text
app/main.py           application factory
app/config.py         process settings read from the environment
app/cli.py            operator commands (food-admin)
app/local.py          one command to run both sides on this machine (food-local)
app/http.py           request IDs, no-store, and the answer to an unexpected failure
app/errors.py         the error envelope and the adaptation of validation errors
app/values.py         shared value types: money, quantities, dates, instants
app/listing.py        paging for list endpoints
app/actions.py        permitted actions with their reasons
app/api/health.py     health check, outside the versioned API
app/context.py        the database, clock and settings a request works with
app/api/deps.py       session, CSRF and Origin checks shared by every route
app/api/description.py  the published API description, where it departs from FastAPI's own
app/api/v1/           contract routers under /api/v1, one module per area
app/schemas/          request and response models
app/services/         business rules: credentials, sessions, accounts, business settings,
                      versions, operation keys, menu, audit, business time, orders,
                      inventory, counters, recipes, planning, preparations
app/persistence/      database connection, models and migrations
tests/                behavioral tests, and the server for the frontend's conformance run
docs/                 verification record for each phase
```
