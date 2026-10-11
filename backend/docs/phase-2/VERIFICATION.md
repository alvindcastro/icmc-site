# Phase B2 Verification

Date: 2026-10-10. Phase B2 delivered: all 23 tasks are complete. Not committed at the time of writing.

## Plan Review

- B2 rested on decision D06, operation admission. Its stated default was adopted: the operation record, the change and the stored answer commit in one write transaction. The owner had been told this was the next decision and said to continue; it is marked in the plan and can still be reversed.
- The contract says rejections must be stored so that a late copy of a refused request can never succeed. FastAPI validates a typed body before the route runs, which would leave validation refusals unrecorded. Keyed routes therefore take the body as plain JSON and validate it inside the operation, so every refusal the change produces is stored the same way.
- "Used on an order" cannot happen before Phase B3. The variant carries the flag and the rule is enforced and tested by setting the flag directly; B3 will set it for real.
- The plan's local setup command was written for this phase because it needs the menu seed.

## Delivered Scope

**Versions.** One helper compares the version the editor saw with the current one and advances it by one, inside the write transaction that makes the change. A stale editor gets 409 `version_conflict` with the complete current record and nothing changes.

**Operation keys.** Every menu mutation needs an `Idempotency-Key`. The first request with a key takes effect once; an identical repeat gets the original answer back, byte for byte, with `Idempotency-Replayed: true`; the same key with a different method, path or body is refused. Refusals are stored like successes, after undoing anything the change had written. `GET /operations/{id}` reports what became of a key. Two operator commands list unfinished operations and close a key the server never saw.

**Menu.** `GET /categories`, `GET /foods` with search, category and availability filters, `GET /foods/{id}`, and the four mutations for foods and variants. Adding or editing a variant also advances its food. An operator command confirms the reviewed version of a food or variant; a later change to its name, unit, package contents or price makes it provisional again, and both events go to an append-only audit table. The whole area needs the `menu` workflow enabled.

**Setup.** `food-admin menu seed` loads the five menu rows the decision register knows, all provisional, and nothing for the two unknown Pork BBQ options. `food-admin setup-local` prepares a development machine in one command.

## Clarifications Written Into the Contract

| Subject | Choice | Reason |
|---|---|---|
| Operation key | Must be a UUID in its usual hyphenated form; letter case is ignored. Anything else is 422 at `/header/Idempotency-Key`. | The contract defines `operation_id` as a client-generated UUID. The frontend's fixture accepts any text. |
| What is recorded | Every 4xx the change itself produces: validation, conflict, a missing record. Not refusals before it is attempted: session, CSRF, capability, malformed JSON, a body that is not an object, a missing or malformed key. | A request that never reached the change has no outcome to remember, and can safely be sent again. |
| Identical request in flight | It waits for the write lock and is then replayed. `operation_in_progress` is answered only if a `processing` record exists, which this design never leaves behind. | Decision D06. |
| Busy database | A write that cannot get the lock within five seconds is 503 `temporarily_unavailable` with `Retry-After`. Nothing is recorded. | The frontend treats 5xx on a save as uncertain and checks its status, which then answers 404. |
| Key closed by the operator | The lookup answers `rejected` with HTTP status 409 and code `operation_closed`. | The contract requires operator reconciliation for a key the server never saw but names no code for it. |
| PATCH | Changes only the fields sent. An explicit null for a field that cannot be empty is a field error. An edit that changes nothing still advances the version. | The contract says "changed editable fields"; the frontend sends them all. |
| Order of checks | The shape of the body, then a missing record, then rules that depend on the record (category, package contents, used on an order), then the version. | Staff see their mistakes before the conflict, as in the fixture. |
| Confirmation | Confirming advances the version (and the food's, for a variant). Only a change to a material value withdraws it; the fixture withdraws it on every edit. | The contract lists the material values. |
| Access | Every menu route, reading included, is 403 `action_forbidden` unless the `menu` workflow is enabled. Operation lookups need only a session. | The contract makes the capability a backend decision. |
| Search and order | Letter case is ignored for the whole of Unicode. `%` and `_` in search text are literal. | The contract says case-insensitive substring. |
| Field error codes | `unknown_category`, `immutable_after_order`, `not_a_package`, `too_long`, `invalid_operation_id`, beside `required` and `unknown_field`. | The contract leaves codes to the backend. |

## Observed TDD

Tests were written first and run against importable stubs. Counts are from `uv run pytest`.

| Cycle | Observed red | Green result |
|---|---|---|
| Version helper, operation protocol, lookup, busy database, operator commands | 29 failed, 13 passed, of the operation, version and database tests. The 13: seven database tests that were unaffected, and six operation tests a plain transaction already satisfies (a first request takes effect, a crash or refusal leaves nothing behind, three unknown lookups are 404 because the route did not exist). | 303 passed. |
| Menu: reading, mutations, conflicts, confirmation, seed, capability | Of 101 menu tests, 3 failed and 98 errored in the shared fixture, whose operator commands (`--enable=menu`, `category add`) did not exist. | 403 passed and 1 failed: a scaffold test that used `/api/v1/foods` as its example of an unbuilt route. It now uses orders and ingredients; 404 passed. |
| One-command local setup | 4 failed, 10 passed, of the command tests: the command did not exist. | 408 passed. |

Not test-first, or changed without a red run:

- The table definitions and migrations for operations and the menu were written with the stubs, before their red runs. The existing test that migrations and models agree covered them from the start.
- Three settings tests used `menu` as their example of an unreleased workflow. They now use `planning` and `orders`.
- No test correction was needed in this phase.

Refactoring with tests passing: the request context moved out of the API layer so services no longer import from it, and the package-contents handling in the variant edit was simplified.

## Live Verification

Run on 2026-10-10 on one machine: a new database made by `uv run food-admin setup-local`, uvicorn on `127.0.0.1:8000`, the frontend's development server in live mode on `127.0.0.1:5173`, and Chromium driven by `frontend/.playwright/phase2-live.mjs`. No request was intercepted except the one answer that was deliberately dropped.

- [x] `setup-local` on an empty directory created the database, token, provisional settings and three foods; a second run changed nothing.
- [x] The menu page shows the seeded foods as provisional, and the Menu link is offered while unreleased workflows are not.
- [x] A food was created with three variants: a tray, a 50-piece package and an unavailable piece at an explicit zero price. The server holds exactly those values, and the food is at version 4.
- [x] A price edit survives a reload.
- [x] Two browsers edit the same food. The second saves. The first is shown "Latest saved record" with the other browser's text, keeps its own draft, and cannot save until it reviews. After "Keep draft with reviewed version" it saves.
- [x] A variant save whose answer is dropped: the page says the result is unconfirmed and blocks another save. "Check save status" reports it saved. The variant's version went up by exactly one.
- [x] Search is answered by the server without regard to letter case and kept in the address; a search with no match shows the no-results state.
- [x] The page fits a 375-pixel phone. No page errors.
- [x] The Phase B1 access walkthrough was repeated against this server and passed.

Not covered in the browser:

- The operator's confirm command and its reset on a material change, the used-on-order rule, and closing a lost key are covered by the server tests only.
- The frontend's "Check previous save" on the menu page after an editor is closed, and the identical retry after a 404, were not driven live. The server behaviours they rely on are tested: an unknown key is 404, and the identical request then takes effect once.
- Nothing was run on Windows.

## Final Verification

- [x] `uv sync --locked` and `uv lock --check`: the lockfile is current. No dependency was added in this phase.
- [x] `uv run pytest`: 408 passed across 13 files.
- [x] `uv run ruff check .` and `uv run ruff format --check .`: passed.
- [x] `uv run mypy`: no issues in 58 source files, strict mode.
- [x] Frontend source is unchanged since Phase B1, when its type check, 382 unit tests, build and 73 Chromium checks passed.
- [x] Checks ran in a Linux copy of the workspace.

## Known Limits

- **The API description does not show the bodies of the four menu mutations.** They are read as plain JSON so refusals can be recorded. Phase B8's task of publishing the schema and comparing it with the contract will need to declare them.
- **The conformance run has not happened.** Phase B8 will run the frontend's fixture contract tests against this server. Known differences to expect: the fixture accepts any text as an operation key, and it makes a record provisional on every edit.
- Categories can be added but not renamed or removed.
- Operation records are kept for good and hold the full answer, as the contract requires. Nothing bounds their growth yet.
- Windows is still unverified. See the [Phase B1 record](../phase-1/VERIFICATION.md#known-limits).

## Entry Points

| File | Responsibility |
|---|---|
| [services/versions.py](../../app/services/versions.py) | Version comparison and increment |
| [services/operations.py](../../app/services/operations.py) | Operation keys: fingerprint, execute once, replay, close |
| [services/menu.py](../../app/services/menu.py) | Menu rules, confirmation, seed |
| [services/audit.py](../../app/services/audit.py) | Append-only audit events |
| [schemas/menu.py](../../app/schemas/menu.py), [schemas/operations.py](../../app/schemas/operations.py) | Request and response models |
| [api/v1/menu.py](../../app/api/v1/menu.py), [api/v1/operations.py](../../app/api/v1/operations.py) | Contract routes |
| [cli.py](../../app/cli.py) | `setup-local`, `category`, `menu` and `operations` commands |
| [tests/test_operations.py](../../tests/test_operations.py), [tests/test_menu.py](../../tests/test_menu.py), [tests/test_versions.py](../../tests/test_versions.py) | Behavioral tests |
