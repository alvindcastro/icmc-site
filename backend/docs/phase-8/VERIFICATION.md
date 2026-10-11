# Phase B8 Verification

Date: 2026-10-11. The seven Phase B8 tasks that apply while the project is local are complete. The eleven it defers until the project is hosted or holds real data are untouched. Not committed at the time of writing.

## Plan Review

- The plan asked for a note that copying the database file is enough of a backup. Writing the test for that showed it is not always true. SQLite keeps recent changes in a write-ahead file beside the database until they are folded in, so a copy of the main file can silently miss the latest work. A backup command was added instead, and the runbook tells the operator to use it.
- The plan's rule is that the frontend's fixture follows any agreed deviation. So where the conformance run found the server stricter by design, the fixture and its test were changed, not the server.
- Each live gate in the frontend plan is a single checkbox that also needs the business: confirmations, real data, a staff review. None can be ticked on technical evidence alone. Each already carries a dated progress note, and all the walkthroughs behind those notes were run again against the finished server.

## Delivered Scope

**One command for both sides.** `uv run food-local` starts the server on `127.0.0.1:8000` and the frontend's development server in live mode, and stops both on Ctrl+C. If one side stops, it stops the other and says which went first. It starts nothing, and says what to do, when the database is not set up, the session cookie is HTTPS-only, or the frontend's packages are missing.

**Runbook.** [RUNBOOK.md](../../RUNBOOK.md): start and stop, after pulling changes, the token, settings and workflows, confirming menu items, a save the browser cannot resolve, back up, restore, start over, checks, and what to do when something is wrong.

**Backup.** `uv run food-admin backup <file>` writes everything committed at that moment into one new file, using SQLite's own backup. It is safe while the server runs and never overwrites a file. Restore is four manual steps in the runbook.

**API description.** `/openapi.json` now describes the body and the operation key of each of the 16 keyed saves, the CSRF header on every request that changes something, and every refusal as the contract's error envelope with its list of codes. It no longer shows the framework's own validation error, which this API never sends.

**Conformance run.** `npm run test:conformance` in `frontend/` runs the frontend's fixture contract tests with the in-memory fixture exchanged for this server. A test-only server, `tests/conformance_server.py`, gives each test a new database seeded like the fixture and lets the test's clock drive the server's. CI runs it on every push.

**Environment file.** `.env.example` gained a commented `LOCAL_ADMIN_TOKEN=` line: a place to keep the token on the machine, which the server never reads.

## The Conformance Run

The frontend has 82 fixture contract tests in eight files. They are the frontend's working definition of the API.

| Run | Result |
|---|---|
| First, before any change | 80 passed, 2 failed. |
| After resolving both differences, marking five tests that cannot be pointed at a server, and adding the response scenario | 78 passed, 5 skipped, in 9 files. |

Differences found and how each was settled:

| Difference | Settled by |
|---|---|
| A sign-in body with `password` in place of `token`. The fixture answered 401 `invalid_credentials`; the server answers 422 `validation_failed`, because a sign-in is exactly a username and a token and unknown fields are refused everywhere. | The fixture now refuses a malformed sign-in the same way, and its test expects it. |
| The message for lowering a prepared count on a Ready or Completed order was worded differently. The test compares it exactly. | The server now uses the fixture's wording. |

Differences that stand, and are handled in the run's transport rather than hidden:

- **Operation keys.** The server accepts only UUIDs; the tests use readable keys such as `food-create`. The transport exchanges each readable key for a UUID on the way out and puts it back on the way in. The real frontend always sends UUIDs.
- **Starting state.** Each transport gets its own database, seeded with the fixture's four categories, four foods and the `admin` account under the same IDs.
- **Time.** Each request carries the test's clock, and the server uses it, so a test that moves time to expire a quote expires it on the server.
- **Sample recipes.** The fixture's placeholder recipes are never loaded into a server. No test in the run uses them.

Five tests build fixture internals directly and have no server to talk to. They are skipped in the run by name, and the server's own tests cover the same behaviour:

| Skipped test | Covered on the server by |
|---|---|
| A quoted edit rechecks its version after a concurrent deposit | `tests/test_ledger.py`: a deposit recorded while an edit was being reviewed is not overwritten. Added in this phase; it passed at once. Write transactions take the lock at their start, so the two cannot interleave. |
| Simultaneous identical operation keys are admitted once | `tests/test_operations.py` |
| Planning refuses without its workflow | `tests/test_planning.py` |
| Preparation refuses without its workflows | `tests/test_preparations.py` |
| Recipes refuse without their workflows | `tests/test_recipes.py` |

**The response scenario.** The frontend refuses any response that fails its own checks. A new file, `frontend/tests/conformance/responses.live.ts`, takes one working day through the real server and passes every answer through those checks: categories and foods, a new food and variant, ingredients, an opening count, two receipts, a recipe with an incomplete and then a complete estimate, a quote, an order, a payment, a refund, a status step, the dashboard, the plan and shopping list, a preparation with its review, a correction with its review, a cancellation, seven lists, and the stored result of a keyed save from each family: menu, stockroom, orders, preparation and correction. It passed on its first run. It is the evidence for the plan's "Response Details the Frontend Verifies", all 14 of which are now ticked.

## Observed TDD

Counts are from `uv run pytest` and from Vitest.

| Cycle | Observed red | Green result |
|---|---|---|
| API description | Of 8 new tests, 6 failed and 2 passed. The two were the enumerations, which were already right, and the description being built once. | 8 passed. |
| Backup command | 3 failed: the command did not exist. | 2 passed and 1 failed on a mistake in the test, which expected a write-ahead file without holding the database open. With that corrected, 3 passed. |
| Conformance differences | 2 of 82 failed, as above. | 78 passed, 5 skipped. |

Not test-first:

- The launcher's tests were written before the launcher but first run after it existed. All 10 passed on that run; no red was observed.
- The conformance server and the frontend's transport are tooling with no tests of their own. The run itself is what exercises them.
- An earlier draft of the backup test, which copied the database file, is what failed and showed the write-ahead problem. It was replaced by the three tests above.
- One test was added to the ledger tests to match a fixture test that cannot run against a server. It describes behaviour that already existed and passed at once.

One comparison failed for a reason in the test itself: its pattern read the contract's phrase `GET /dashboard.business_date` as a route. The pattern was tightened. With that, every route the server describes is named in the contract and every route the contract names is served: 46 operations.

Existing behaviour changed on purpose: the server's wording of one refusal, and the frontend fixture's answer to a malformed sign-in.

## Live Verification

Run on 2026-10-11 on one machine, in a Linux copy of the workspace.

**The launcher.** With a database made by `setup-local`, `uv run food-local` brought up both sides. The server's health check answered, a request for a CSRF token through the frontend's proxy on port 5173 reached the server, and the frontend's page loaded. An interrupt stopped both: the command printed "Both sides are stopped." and exited with 0, and both ports were free.

**The walkthroughs.** Each script in `frontend/.playwright/` was run against the finished server, each on a new database and a newly started server.

- [x] Phase 1, access: return route, wrong token, keyboard sign-in, cookie, reload, settings, sign-out.
- [x] Phase 1, limits, with short session limits: stale CSRF token, idle expiry, sign-in lock.
- [x] Phase 2: menu editing, version conflict between two browsers, lost answer.
- [x] Phase 3: quotes, orders, snapshots, conflict, dashboard, daylight-saving cases.
- [x] Phase 4: fulfillment steps, cancellation, deposit with a lost answer, credit, refund.
- [x] Phase 5: ingredients, purchases, a lost answer, waste, a linked correction.
- [x] Phase 6: recipe with a lost answer, estimates, an overtaken save.
- [x] Phase 7: planning, the operator procedure, recording, a repeated request, correction, cancellation, completion.

No server log held a traceback. Three of the older scripts first stopped on what they assumed about the navigation: when they were written, fewer workflows existed, so they expected links such as Orders or Planning to be absent and the menu link to read "Menu" rather than "Menu & Recipes". Those expectations were brought up to date. Nothing in the server or the frontend was at fault.

**Backup and restore** are rehearsed by `tests/test_backup.py` over a real server on a local socket: a backup taken while the server runs and staff are signed in, more work, the database replaced by the backup, and the restored server holding exactly what the backup held, including the stored answer of a save from before it.

Not covered:

- Nothing was run on Windows. The launcher has Windows-specific code for starting and stopping its two programs that has never been executed. The runbook's PowerShell commands are unverified.
- "A fresh clone runs both sides" was checked in a copy of the working tree, not from a new clone.
- The restore was rehearsed by a test, not by a person following the runbook.
- The conformance run exercises what the fixture tests assert. A behaviour no fixture test asserts is not compared.

## Final Verification

- [x] `uv lock --check`: the lockfile is current. No dependency was added; `pyproject.toml` gained the `food-local` command.
- [x] `uv run pytest`: 1,099 passed across 27 files.
- [x] `uv run ruff check .` and `uv run ruff format --check .`: passed.
- [x] `uv run mypy`: no issues in 101 source files, strict mode.
- [x] Frontend `npm run typecheck`: passed.
- [x] Frontend `npm test`: 382 passed in 33 files.
- [x] Frontend `npm run build`: passed, with the existing chunk-size advisory.
- [x] Frontend `npm run test:e2e`: 73 Chromium checks passed.
- [x] Frontend `npm run test:conformance`: 78 passed, 5 skipped. The run started and stopped its own server.
- [x] Checks ran in a Linux copy of the workspace.

## Known Limits

- The conformance job in CI has not run yet; it was added in this phase and runs on the next push.
- `food-local` puts each side in a process group of its own and stops the whole group. On Windows it uses `taskkill /T /F`, which is unverified.
- A backup is taken by command and restored by hand. Nothing schedules backups or keeps a copy off the machine.
- The API description lists refusal codes for the envelope as a whole, not which codes each route can answer with.
- The conformance server's control routes are not protected. It listens on `127.0.0.1` only, holds synthetic data, and stops when the run ends.
- Still deferred: hosting behind one origin with HTTPS, secrets off the machine, scheduled backups with a real restore, structured logs, a security review, live data, and the staff walkthrough.

## Entry Points

| File | Responsibility |
|---|---|
| [app/local.py](../../app/local.py) | `food-local`: start, watch and stop both sides |
| [app/api/description.py](../../app/api/description.py) | The API description where it departs from the framework's |
| [app/cli.py](../../app/cli.py) | `food-admin backup` |
| [tests/conformance_server.py](../../tests/conformance_server.py) | The server the conformance run talks to |
| [RUNBOOK.md](../../RUNBOOK.md) | Day-to-day tasks on one machine |
| [tests/test_description.py](../../tests/test_description.py), [tests/test_local.py](../../tests/test_local.py), [tests/test_backup.py](../../tests/test_backup.py) | Behavioral tests |
| `frontend/tests/conformance/` | The run's transport, its setup and the response scenario |
| `frontend/vitest.conformance.config.ts` | Which tests the run includes and how the fixture is exchanged |
