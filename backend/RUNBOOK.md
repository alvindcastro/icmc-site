# Local Runbook

How to run and look after the project on one machine. It covers the local project only: hosting, HTTPS and backups kept off the machine are [deferred](BACKEND_IMPLEMENTATION_PLAN.md#phase-b8-running-locally-and-later-release-readiness) until the project is hosted or holds real data.

Commands are for Windows PowerShell and are run from `backend/` unless a step says otherwise. They were written and checked on Linux and have not been run on Windows.

## First Time

Follow [Requirements and Setup](README.md#requirements-and-setup): `uv sync`, copy `.env.example` to `.env`, then `uv run food-admin setup-local`. In `frontend/`, run `npm ci` once.

`setup-local` prints the `admin` token once. The server keeps only a hash of it. If you want the token kept on this machine, `.env` has a commented line for it, `LOCAL_ADMIN_TOKEN=`. The server never reads that line, and git ignores `.env`.

## Start and Stop

One command starts both sides:

```powershell
uv run food-local
```

It starts the server on `http://127.0.0.1:8000` and the frontend's development server, normally on `http://127.0.0.1:5173`, which forwards `/api` to the server. Open the frontend's address and sign in as `admin`. Press Ctrl+C once to stop both. If either side stops by itself, the other is stopped too and the command says which one went first.

It refuses to start, and says what to do, when the database has not been set up, the session cookie is still HTTPS-only, or the frontend's packages are not installed. `--port 8123` moves the server; the frontend is told where it went.

To run the two sides separately, for example under PyCharm and WebStorm:

```powershell
uv run uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000 --reload
```

```powershell
cd ..\frontend
npm run dev
```

## After Pulling Changes

```powershell
uv sync
uv run food-admin migrate
cd ..\frontend
npm ci
```

`migrate` is safe to repeat. The server refuses to start on a database whose schema is behind and names this command.

## The Sign-In Token

| Situation | Command |
|---|---|
| The token is lost, or someone else has seen it | `uv run food-admin token rotate --generate` prints a new one and ends every open session. |
| You want to choose it | `uv run food-admin token rotate` asks twice for a token of at least 12 characters. |
| Sign-in answers "Too many failed sign-in attempts" | Five wrong attempts lock sign-in for everyone for 15 minutes. Wait; the right token is refused too until then. |

## Settings and Workflows

```powershell
uv run food-admin settings show
uv run food-admin settings set --timezone Asia/Manila
uv run food-admin settings set --enable payments
uv run food-admin settings set --disable payments
uv run food-admin settings confirm currency timezone
```

- Every change raises the settings version, and changing a confirmed value withdraws that group's confirmation.
- A workflow appears in the frontend's navigation once it is enabled. Staff see the change the next time the page loads.
- `preparation_recording` is the one workflow to turn on with care. Follow [Turning Preparation Recording On](README.md#turning-preparation-recording-on).
- Do not set `--environment live` on this machine unless you mean it. Live settings refuse work that rests on anything unconfirmed, sell only confirmed menu items, and force the session cookie to HTTPS, which the local frontend cannot use.

## Confirming Menu Items

```powershell
uv run food-admin menu show
uv run food-admin menu confirm food <id> --version 3
uv run food-admin menu confirm variant <id> --version 1
```

`menu show` lists every food and variant with its ID, version and status. A confirmation names the version you reviewed, so an edit made meanwhile is not confirmed by accident. A later edit of the name, label, unit, package contents or price makes the record provisional again.

## A Save the Browser Cannot Resolve

When the frontend reports a save it cannot settle and "Check save status" keeps answering "not found", the request never reached the server and the draft is gone from the page.

```powershell
uv run food-admin operations unresolved
uv run food-admin operations close <key> --reason "The request never arrived"
```

`unresolved` lists saves the server admitted and never finished; normally it lists none. `close` records the key as rejected, so the browser stuck on it can move on and a late copy of the request can never take effect.

## Back Up

```powershell
New-Item -ItemType Directory -Force backups
uv run food-admin backup backups\food-2026-10-11.db
```

This writes everything committed up to that moment into one new file. It is safe while the server is running and staff are working. It never overwrites a file: pick a new name each time.

Use this command, not a copy of `food-reservations.db`. Recent changes can still be in the write-ahead file beside the database, and a copy of the main file alone would silently lose them. A test shows exactly that.

While the database holds no real data, a backup made this way and kept on this machine is enough. Before it holds real data, backups must be scheduled and a copy kept somewhere else; that belongs to the deferred hosting work.

## Restore

1. Stop the server.
2. Move the current database out of the way, together with anything beside it. Do not leave an old `-wal` or `-shm` file next to a restored database.

   ```powershell
   New-Item -ItemType Directory -Force replaced
   Move-Item food-reservations.db* replaced\
   ```

3. Put the backup in its place and bring its schema up to date:

   ```powershell
   Copy-Item backups\food-2026-10-11.db food-reservations.db
   uv run food-admin migrate
   ```

4. Start the server and sign in.

Everything is as it was when the backup was taken: records, settings, the sign-in token and the results of every keyed save. A save from before the backup that is sent again is recognised and changes nothing. Work done after the backup is gone. This procedure is rehearsed by `tests/test_backup.py` on every run of the tests.

## Start Over

To return to an empty development system, stop the server, move the database away as in Restore step 2, and run local setup again:

```powershell
uv run food-admin setup-local
```

It creates a new database, provisional settings and menu, and prints a new token.

## Checks

```powershell
uv run pytest
uv run ruff check .
uv run ruff format --check .
uv run mypy
```

The conformance run executes the frontend's fixture contract tests against this server. It starts and stops a test-only server by itself:

```powershell
cd ..\frontend
npm run test:conformance
```

The API description is at `http://127.0.0.1:8000/docs` and `http://127.0.0.1:8000/openapi.json` while the server runs with `FOOD_API_DOCS_ENABLED=true`.

## When Something Is Wrong

| What you see | What to do |
|---|---|
| "The database is missing or out of date" | `uv run food-admin migrate`, or `setup-local` on a new machine. |
| Every request answers 503 with "settings" in the message | No settings exist yet. Run `setup-local`, or `settings set` with the first-time options. |
| Sign-in succeeds but the next page asks to sign in again | The session cookie is HTTPS-only. Copy `.env.example` to `.env`, or set `FOOD_API_COOKIE_SECURE=false`, and restart the server. |
| A save answers 403 with "security token" | The page's token is out of date, usually after signing in on another tab. Try again; the frontend fetches a new one. |
| A change answers 403 at once, from a page on another address | The browser's origin is not in `FOOD_API_ALLOWED_ORIGINS`. Add the address the frontend really runs on. |
| The server will not start because the port is taken | Another server is still running. Stop it, or start this one with `uv run food-local --port 8123`. |
| An error page with a request ID | The traceback is in the server's terminal under the same ID. |
