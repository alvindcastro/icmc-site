# Phase B1 Verification

Date: 2026-10-10. Phase B1 delivered: 24 of its 25 tasks are complete. The remaining one, cross-origin support, applies only if a separate development origin is ever used, and none is. Not committed at the time of writing.

## Plan Review

- B1 depended on decisions D01, D03-D05 and D07-D09. Each had a stated default in the plan, and the plan says the default stands if nobody objects. They were adopted by building on them and are marked so in the plan. The owner was not asked about each one separately and can still reverse any of them. D06 is not needed until Phase B2.
- The auth and settings group was built as the [contract](../../../frontend/docs/phase-0/API_CONTRACT.md#auth-and-settings-phase-1) proposes. Where the contract was silent or ambiguous, the choice is listed under Clarifications below and written into the contract. The owner's formal agreement (D11) is still open.
- The plan's fail-closed task names "reservation and financial mutations", and none exists before Phase B3. The guard was built and tested with a stand-in route; Phase B3 applies it.
- The plan asked the application to make sure every response carries a `Date` header. uvicorn already adds one to every response, and a second copy from the application would reach the browser as an unreadable combined value. The header is therefore left to the server, and a test over a real socket checks there is exactly one.

## Delivered Scope

**Application core.** One SQLite file in WAL mode with foreign keys enforced and a five-second busy timeout. A read sees a committed snapshot and is never blocked; a write takes the only write lock at its first moment and commits or leaves nothing behind. The baseline migration creates the staff account, session, sign-in failure and business settings tables, and the server refuses to start on a database that was never migrated. Every request gets an ID, returned as `X-Request-ID`, included in the error envelope and written to the log. Every handled failure answers in the contract envelope, with JSON Pointer paths for field errors. Shared value types, the paging helper and the permitted-action helper are built and tested ahead of the phases that use them.

**Sessions.** `GET /auth/csrf`, `POST /auth/sign-in`, `GET /auth/session` and `POST /auth/sign-out`. The cookie is an opaque random value; the database holds only its hash. Sign-in rotates the cookie and the CSRF token. Sessions end after 30 idle minutes or 12 hours, both configurable. Every request that can change something needs an approved `Origin` and the CSRF token of the session its cookie names. Five failed sign-ins in 15 minutes lock sign-in until the oldest leaves the window.

**Business settings.** `GET /settings` returns the contract shape from a single versioned record. The operator creates and changes it, confirms groups of values, and switches workflows on, all by command. New settings start closed and unconfirmed.

**Operator commands.** `food-admin migrate`, `token set`, `token rotate`, `settings show`, `settings set` and `settings confirm`. They are described in the [README](../../README.md#operator-commands).

**Frontend.** One defect found while connecting the two sides is fixed: the API client kept a CSRF token after the server refused it, so a sign-in page left open past the pre-auth lifetime could never sign in without a reload. The client now forgets a refused token and fetches a new one on the next attempt. It does not resend anything on its own.

## Clarifications Written Into the Contract

| Subject | Choice | Reason |
|---|---|---|
| Idle renewal | A business request that passes authentication renews the idle limit whatever its own outcome. Requests under `/auth` never do. | The contract says "successful authenticated business requests". Reading that as 2xx only would sign staff out while they correct a refused save. The frontend's fixture already renews on any handled response. |
| Missing settings | `GET /settings` is 503 `temporarily_unavailable` until the operator creates the record. | The contract forbids serving fixture defaults. |
| Stale CSRF token | 403 `csrf_invalid`; the client forgets its token, and staff try again. | A pre-auth session lasts 15 minutes. |
| Sign-in lock | Counted for the whole server, not per username or address. | One account, and behind the development proxy every client has the same address. Revisit when hosted. |
| Sign-out of a finished session | 204, provided the CSRF token matches the session the cookie names. | The contract requires the repeat to succeed; checking the token keeps it protected. |
| Save on an expired session | 401 `session_expired` when the CSRF token is the session's own, not 403. | The frontend then explains the expiry instead of asking staff to retry. |
| Capabilities | Reported as on only when stored as on and implemented by this version of the server. | The contract says the backend enables only released workflows. |
| Cookie | Named `food_session`, with no lifetime of its own. `Secure` is always set when settings are `live`. | The server alone decides how long a session lasts. |
| Query parameters | An unknown one is 422 at `/query/<name>` on every route. | The plan's rule for every phase. |
| Instants | Stored and sent to the whole second. | Matches the contract's examples; no caller needs more. |

## Observed TDD

Tests were written first and run against importable stubs, as in Phase B0. Counts are from `uv run pytest`.

| Cycle | Observed red | Green result |
|---|---|---|
| Application core: database, migration, request IDs, error envelope, value types, paging, permitted actions | 104 failed, 28 passed. The 28 were the 7 scaffold tests, 20 value cases that a bare `int` or `date` already satisfies, and "a failed write leaves nothing behind", which an ordinary database session already does. The two running-server tests failed only for the missing request ID; the single `Date` header was already true. | 132 passed. |
| Sessions, CSRF, sign-in, sign-out, rate limit, token commands | 72 failed, 0 passed: 62 session tests and 10 command tests. The endpoints were 404 and the command did nothing. | 206 passed after two test corrections, below. |
| Business settings, their commands, the fail-closed guard, `Secure` when live | 60 failed, 0 passed, with the other 206 still passing. | 266 passed after one test correction, below. |
| Request log shown under plain uvicorn | 1 failed: no handler was attached. Two companions passed at once: the request line was already written by the first cycle's middleware, and an existing logging setup was trivially left alone. | 269 passed. |
| Frontend client forgets a refused CSRF token | `npx vitest run tests/client.test.ts`: 1 failed, 10 passed. The stale token was sent again. A companion test, that a late refusal does not discard a newer token, passed before the change and guards it. | 11 passed; full suite 382 passed. |

Test corrections, not counted as red:

- A sign-in case with half of a surrogate pair could not be encoded by the test client itself. It became its own test that posts raw bytes. It passed without new code: the framework already answers 422 at `/token`, and the test pins that instead of a crash.
- The blank-token command test expected sign-in with a blank token to be 401. The API correctly answers 422. The expectation was fixed.
- Two settings tests advanced the clock by an hour and expired their own session. They now advance ten minutes.
- The first red run of the first cycle errored instead of failing, because the stub migration never created the database file. The stub was changed to open a connection and the run repeated; the figures above are from the repeat.

Not test-first:

- The server's refusal to start on an unmigrated database was tested before it was written, but the test was first run after. Disabling the check in a scratch copy made that test fail and nothing else.
- The request log line existed from the first cycle without a test of its own until the fourth.
- The wording of the `csrf_invalid` message changed after the live walkthrough, in the server, the frontend fixture and the test together. "Refresh the sign-in token and try again" read like an instruction staff could not follow; it is now "The security token for this page is out of date. Try again."

Refactoring with tests passing: confirmation group names are validated in the service instead of by the argument parser, and the options the first `settings set` needs are an explicit mapping.

## Live Verification

Run on 2026-10-10 on one machine: uvicorn on `127.0.0.1:8000` with a fresh database made by the operator commands, the frontend's development server in live mode on `127.0.0.1:5173`, and Chromium driven by `frontend/.playwright/phase1-live.mjs`. No request was intercepted except the one sign-out answer that was deliberately dropped.

With the default limits:

- [x] Opening `/account` signed out leads to sign-in with the return route kept.
- [x] A wrong token typed and submitted by keyboard gives "The username or token is incorrect.", keeps the username and creates no session.
- [x] Keyboard-only sign-in (Tab from username to token, Enter) lands on the remembered route.
- [x] The session cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, has no lifetime, and is invisible to the page. The token is in neither storage area.
- [x] A reload keeps the session. Settings come from the server and are labelled Provisional.
- [x] No workflow link is offered, because the server has released none.
- [x] A response through the proxy carries exactly one `Date` header within five seconds of the browser's clock, `Cache-Control: no-store` and a request ID.
- [x] Sign-out without the CSRF token, with a foreign `Origin`, or with no `Origin` is 403, and the session survives.
- [x] Sign-out whose answer is dropped: the server ends the session, the page says "Server sign-out is unconfirmed" and blocks sign-in, the state survives a reload, and Retry sign-out finishes.
- [x] An ordinary sign-out removes the cookie and the server then answers `unauthenticated`.
- [x] The sign-in page fits a 375-pixel phone. No page errors.

With the server restarted on short limits (15-second idle, 6-second pre-auth, 20-second lock window):

- [x] A CSRF token older than its pre-auth session: the first try is refused with the new message and the second signs in. This is the frontend fix, seen working.
- [x] An idle session expires on the server. The page clears itself and shows "Your session expired. Sign in to continue." The server answers `session_expired`.
- [x] Signing in after expiry starts a fresh session.
- [x] Five wrong tokens lock sign-in, the right token is refused with "Too many failed sign-in attempts. Try again later.", and sign-in works again after the window.

The server log from these runs holds one line per request with its ID and status, and neither the token nor the wrong tokens appear in it.

Not covered:

- Expiry during a save cannot be shown in the browser until Phase B2 provides a save. The server test covers the answer: 401 `session_expired`.
- Whether the old cookie survived the dropped sign-out answer was not checked: the browser tool may apply a response's cookies before discarding it. The case where the cookie survives, and the repeat arrives with it, is covered by the server tests.
- Nothing was run on Windows. See below.

## Final Verification

- [x] `uv sync --locked`: installs from the committed lockfile.
- [x] `uv run pytest`: 269 passed across 10 files.
- [x] `uv run ruff check .` and `uv run ruff format --check .`: passed.
- [x] `uv run mypy`: no issues in 44 source files, strict mode.
- [x] `uv run food-admin migrate`, `token set --generate`, `settings set` and `settings show` run from the console script against a new database.
- [x] Frontend after the client fix and the fixture wording change: type check clean, 382 unit tests in 33 files, production build, 73 Chromium checks.
- [x] Checks ran in a Linux copy of the workspace, because the repository sits on a Windows drive whose installed tooling is Windows-only.

New dependencies in the lockfile: SQLAlchemy 2.1.4, Alembic 1.20.0 with Mako and MarkupSafe, and tzdata 2026.5. tzdata is there because Windows has no timezone database of its own, and the settings command validates timezones.

## Known Limits

- **Windows is unverified.** The owner develops on Windows and every check here ran on Linux. The code uses nothing Linux-specific, CI runs on Linux, and two things deserve a look on the first Windows run: `hashlib.scrypt` needs the OpenSSL that python.org and uv builds include, and the quoted comma-separated values in the README's `settings set` command.
- The sign-in lock is shared by everyone who can reach the server, so anyone who can reach it can lock the one account for up to 15 minutes. Acceptable on one machine; revisit before hosting.
- There is no limit on request body size. It belongs to the security review in Phase B8.
- A failed sign-in holds the database write lock for the tens of milliseconds the hash takes. The lock bounds this to five attempts per window.

## Entry Points

| File | Responsibility |
|---|---|
| [main.py](../../app/main.py) | Application factory, startup schema check, request log setup |
| [config.py](../../app/config.py) | Process settings from the environment |
| [cli.py](../../app/cli.py) | Operator commands |
| [http.py](../../app/http.py) | Request IDs, `no-store`, answer to an unexpected failure |
| [errors.py](../../app/errors.py) | Error envelope and validation adaptation |
| [values.py](../../app/values.py), [listing.py](../../app/listing.py), [actions.py](../../app/actions.py) | Shared value types, paging, permitted actions |
| [api/deps.py](../../app/api/deps.py) | Origin and CSRF guard, signed-in session with and without renewal |
| [api/v1/auth.py](../../app/api/v1/auth.py), [api/v1/settings.py](../../app/api/v1/settings.py) | Contract routes |
| [services/](../../app/services) | Credentials, sessions and the sign-in lock, the admin account, business settings |
| [persistence/](../../app/persistence) | Database connection, models, migrations |
| [tests/](../../tests) | Behavioral tests; `support.py` and `conftest.py` hold the shared fixtures |
