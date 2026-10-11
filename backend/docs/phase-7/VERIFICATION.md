# Phase B7 Verification

Date: 2026-10-11. Phase B7 delivered: all 10 tasks are complete. Not committed at the time of writing; Phase B6 is uncommitted as well.

## Plan Review

- No decision was open for this phase.
- The contract says recording is enabled only after the operator has agreed prepared counts and stock for the orders already open. So an order taken while recording was off stays tracked by hand, and an operator command brings it in. `food-admin setup-local` therefore leaves `preparation_recording` off, which is also the frontend fixture's default. It is the one released workflow that local setup does not enable.
- The frontend's fixture reads recipes and stock through their own routes, so with the `recipes` or `inventory` workflow off it plans as if no recipe existed. The server reads its own tables: planning needs only `orders` and `planning`.
- The contract gives no limit for the rows of a preparation or a correction. Both are bounded at 500 of each kind.
- With this phase every workflow the contract names is implemented.

## Delivered Scope

**Planning.** `GET /planning` for an inclusive period of business dates, at most 366 days, or the business date when none is given. It lists what was ordered, prepared and remains for each variant and selling format in the period, with the contributing order lines. For each ingredient it gives physical stock, demand from earlier commitments, demand in the period, stock after the earlier commitments (which may be negative) and the three shortages, by the decision register's formulas. A variant with no recipe for the ordered format makes the plan incomplete and is named with its orders. `GET /planning/shopping-list` is the same calculation reduced to the ingredients that are short. Neither stores or moves anything.

**Orders once preparation is recorded.** A new order keeps a count per line, starting at nothing. It can be marked ready, and completed, only when nothing remains. A line cannot be edited below what is prepared, or removed once anything of it is. Cancelling an order with anything prepared needs the acknowledgment that stock is not returned.

**Recording.** `POST /preparations/preview` reviews a draft: which order lines were cooked and how many, and what was actually used of each ingredient. `POST /preparations` saves exactly what was reviewed, with an operation key, and answers with the record and each order and ingredient it changed. Prepared counts, one stock movement per ingredient, the stock and the record commit together or not at all. The record keeps the lines, the usage with stock before and after, the recipe of each variant and the receipt each ingredient was priced from, and it never changes. `GET /preparations/{id}` returns it. An order's status is never changed by recording.

**Corrections.** `POST /preparations/{id}/correction-preview` and `POST /preparations/{id}/corrections` change prepared counts and stock together, beside the record. `GET /preparations/{id}/corrections` lists them in order. A count stays within what its preparation recorded and what was ordered, and is not lowered once the order is ready or completed. Each stock change is a new movement of type `correction`, linked to the preparation and to the deduction it corrects.

**Linked stock movements.** A waste or correction entry on the Ingredients screen may name a preparation that used the ingredient, and the movement carries that link.

**Operator procedure.** `food-admin preparation status` lists the open orders still tracked by hand. `food-admin preparation baseline` brings one into recording with the counts the kitchen reports, writes them and the reason to the audit log, and moves no stock. The procedure is in the [README](../../README.md#turning-preparation-recording-on).

`planning` and `preparation_recording` join the released workflows.

## Clarifications Written Into the Contract

The contract has the full list under "Backend refinement (2026-10-11), from implementing this section in backend Phase B7". The choices that are more than a detail:

| Subject | Choice | Reason |
|---|---|---|
| Orders taken before recording | They stay `manual` after recording is turned on: null counts, attested readiness, `record_preparation` blocked with `tracked_by_hand`. Planning counts them in full until completed. | The register requires agreed counts before an open order is counted. Guessing zero would ask the kitchen to cook food twice. |
| Local setup | Enables every workflow except `preparation_recording`. | Turning it on changes how orders become ready. It is a deliberate step with a procedure. |
| Planning's reads | Recipes and stock are read whether or not their workflows are enabled, and no settings need confirming. | Planning is derived from records the server already holds, and the frontend shows no confirmation gate for it. |
| Recipe and ordered format | A recipe counts for a line only if it was written for the format that was ordered. A preparation's recipe snapshot still names the variant's recipe whatever its format. | Planning must not turn a tray recipe into package quantities. The snapshot records what existed. |
| Order of checks | The draft's own fields, then versions (orders before ingredients), then the shelf. A save finds its review before any of that. | As in Phases B5 and B6: a stale page is shown the new state rather than a refusal that contradicts what staff see. |
| What a review is bound to | The validated draft, and through it every order and ingredient version; also the settings version, each cooked variant's recipe version and each ingredient's cost basis. A successful save spends it. | The contract's list. Spending it stops a repeat under a new operation key from cooking twice. |
| "The identical input" | `1.5` and `1.500`, and spaces around the note, are the same draft. 1.5 kg and 1500 g are not. | The record keeps the quantity and unit as entered. |
| Cost of a preparation | Actual usage at each ingredient's exact receipt cost, added up exactly and rounded once. Unknown if any ingredient has no usable price; zero, and known, if nothing was used. A receipt in another currency is not a price. | The contract's rules, and the Phase B6 rule for currencies. |
| Corrections on finished orders | A count is not lowered on a Ready or Completed order. It can be changed on a cancelled one, which never restores demand. Stock can be corrected whatever the order's status. | The contract's rules. |
| Things too large to state | Demand beyond the quantity bound is 422 at `/ingredients` or `/foods`; a cost beyond the money bound is 422 at `/draft/consumption`. | The contract's rule for overflow. |
| Live systems | The preparation routes need currency and timezone confirmed. Planning does not. | Recording moves stock and states a cost, as the stockroom does. |

## Observed TDD

Tests were written first, in four new files, with their helpers. Counts are from `uv run pytest`.

| Cycle | Observed red | Green result |
|---|---|---|
| Planning, recording, corrections and the operator procedure, written together | Of 159 new tests, 2 failed and 157 errored in the shared fixture, because the `planning` workflow could not be enabled. | Reached in the four steps below. |
| Planning and the order rules | - | 32 of the 35 planning tests passed. The other 3 needed a preparation to exist. |
| Recording and corrections | - | A run stopped at its first failure after 46 passes: the operator command did not exist yet. |
| Operator commands | - | 150 passed and 9 failed. All nine were one mistake in the baseline tests, which compared an order read before recording was turned on with the same order read after. The reason its `record_preparation` is blocked legitimately differs. The tests were corrected to read the order at the right moment; all 159 passed. |
| Whole suite | 1 failed: a new assertion of mine expected 404 from `GET /preparations`, which correctly answers 405 because the address exists for saving. The assertion was changed to an address that does not exist. | The other 1,073 passed. With the assertion corrected and the three guard tests below added, 1,077 passed. |

Changed in existing tests because the behaviour changed on purpose:

- The test for routes not built yet became a test for addresses the contract does not define: every route is built now.
- The local-setup test expects every workflow except `preparation_recording`.
- Two settings tests relied on some workflow being unreleased. They now pin the released set themselves. A new test states that every workflow the contract names is released and that only recording is left to the operator.
- The list of expected tables gained the six new ones.

Not test-first:

- The tables and migration were written with the tests, before the red run, as in earlier phases.
- Three guards were in the first implementation without tests: demand too large to state, a cost too large to state, and the 500-row limits. Their tests were added afterwards and passed at once.

Refactoring with tests passing: the helpers for reviews (`remember`, `spend`), for adding a stock movement and for the exact cost of a quantity moved from private to shared functions of the inventory service, and the recipe estimate now uses the same cost functions as a preparation. Strict type checking found two annotations to correct.

After the additions the four new files hold 162 tests and the suite 1,077.

## Live Verification

Run on 2026-10-11 on one machine: a new database made by `uv run food-admin setup-local`, uvicorn on `127.0.0.1:8000`, the frontend's development server in live mode on `127.0.0.1:5173`, and Chromium driven by `frontend/.playwright/phase7-live.mjs`. The script also runs the operator commands against the same database. One answer was deliberately dropped; nothing else was intercepted. Dates are taken from the server's business date. Steps marked "by request" were sent to the server from the signed-in browser session rather than typed into a form.

- [x] Local setup leaves preparation recording off.
- [x] By request: flour is created and 2 kg bought for 24.00; the Medium tray gets a recipe of 750 g; an order of three trays for today is placed and started. It is tracked by hand.
- [x] The Planning screen shows 3 remaining for that order, flour demand of 2250 g against 2000 g, and a shortage of 250 g. It offers no recording. The shopping list shows flour, 250 g.
- [x] Operator procedure. The shelf count of 2000 g is taken as agreed. `settings set --enable preparation_recording`, then `preparation status` lists the order with its line, then `preparation baseline <reference> --prepared 1=1 --reason "..."` reports it recorded with 1 of 3 prepared. `preparation status` then lists no orders. From the server: the order is `recorded`, still Preparing, with 1 prepared and 2 remaining; flour is still 2000 g with one movement.
- [x] The Planning screen now shows 2 remaining, no shortage, and offers "Record preparation".
- [x] By request: an order of two trays for tomorrow is placed. It is recorded from the start, with nothing prepared.
- [x] One tray and 0.8 kg of flour are entered and reviewed as "1 -> 2 of 3", "2000 g -> 1200 g" and $9.60. The answer to the save is dropped; "Check save status" opens the preparation record. The server holds one consumption movement of 800 g, linked to the record; cost 960, recipe version 1.
- [x] The order is still Preparing with 2 prepared and 1 remaining. Its page shows the counts, a disabled "Mark ready" and the server's reason.
- [x] By request: a preparation for tomorrow's order sent twice with one operation key gives two identical answers, the second marked as a replay. One tray is counted and 750 g taken once: flour is at 450 g.
- [x] A correction of today's record is entered in the browser: one tray fewer and 400 g back, reviewed as "2 -> 1 of 3", "+400 g" and "450 g -> 850 g", and recorded. It is listed beside the record, which itself reads exactly as before. The new movement is a correction linked to the record and to its deduction.
- [x] By request: cancelling tomorrow's order without the acknowledgment is refused at `/acknowledge_consumed_stock`. In the browser, with the acknowledgment ticked, it is cancelled. Flour stays at 850 g, the order keeps its count of 1, and tomorrow's plan is empty.
- [x] From that order's preparation record, "Correct stock for Flour" enters 200 g returned, reviews and saves it. The movement is linked to the record and to its deduction; flour is at 1050 g.
- [x] The last two trays of today's order are recorded with 1 kg, reviewed as "1 -> 3 of 3" and "1050 g -> 50 g". Its page then shows 3 prepared and 0 remaining, and it is marked ready and completed in the browser with no attestation asked.
- [x] Flour stock, 50 g, equals the sum of its six movements. Today's plan has nothing left to prepare. The Planning screen fits a 375-pixel phone. No page errors, and no traceback in the server log.

The script was run three times, each on a new database. The first stopped at a mistake in the script, which looked for dashboard wording on the Planning screen. The second passed. The third, after the last tidying of the code and the added tests, passed too and is the run described above. The server log of that run shows four preparation saves answered 201: the one whose answer was dropped, the repeated request and its replay, and the last trays.

Not covered in the browser:

- A plan with earlier commitments, a missing recipe, two selling formats, or a period longer than a day is covered by the server tests only.
- Stale versions, usage beyond stock, an expired or changed review, a recipe changed after the review, an unpriced ingredient and a draft that used nothing were not driven in the browser.
- Editing a partly prepared order, and correcting a count on a ready, completed or cancelled order, are covered by the server tests only.
- The workflow switches and live settings with unconfirmed currency or timezone were not driven in the browser.
- The operator procedure was rehearsed on synthetic orders. There are no real orders to bring in.
- Nothing was run on Windows.

## Final Verification

- [x] `uv lock --check`: the lockfile is current. No dependency was added in this phase.
- [x] `uv run pytest`: 1,077 passed across 24 files.
- [x] `uv run ruff check .` and `uv run ruff format --check .`: passed.
- [x] `uv run mypy`: no issues in 95 source files, strict mode.
- [x] Frontend source is unchanged in this phase.
- [x] Checks ran in a Linux copy of the workspace.

## Known Limits

- Turning recording off again while recorded orders are open leaves them unable to be marked ready: their counts can no longer be completed, and no command returns an order to tracking by hand. The README says not to do it.
- A baseline can be given to any open order that has no preparation recorded against it, including one that was recorded from the start. It is an operator command and it is audited, but it is not limited to orders that were once tracked by hand.
- The contract has no list of preparations. A record is reached from the save that made it or from a linked stock movement.
- Planning reads every confirmed, preparing and ready order up to the end of the period on each request, and each recipe once. That is fine for one kitchen's open orders. It is not paged.
- Orders fulfilled at the same instant are listed by reference, which sorts as text.
- Planning and the dashboard summary treat an order tracked by hand as wholly uncooked, because nothing is known about it.
- The suite now takes a little over two minutes.
- The API description does not show the bodies of the keyed requests, as noted in the [Phase B2 record](../phase-2/VERIFICATION.md#known-limits).
- Windows is still unverified.

## Entry Points

| File | Responsibility |
|---|---|
| [services/planning.py](../../app/services/planning.py) | The plan and the shopping list |
| [services/preparations.py](../../app/services/preparations.py) | Reviewing and saving preparations and corrections; the operator's baseline |
| [services/orders.py](../../app/services/orders.py) | Prepared counts, the ready and completed rules, edits and cancellation after preparation |
| [services/inventory.py](../../app/services/inventory.py) | Stock movements, reviews and exact costs shared with preparation; linked movements |
| [schemas/planning.py](../../app/schemas/planning.py), [schemas/preparations.py](../../app/schemas/preparations.py) | Request and response models |
| [api/v1/planning.py](../../app/api/v1/planning.py), [api/v1/preparations.py](../../app/api/v1/preparations.py) | Contract routes and their access rules |
| [cli.py](../../app/cli.py) | `preparation status` and `preparation baseline` |
| [persistence/migrations/versions/0008_preparations.py](../../app/persistence/migrations/versions/0008_preparations.py) | Prepared counts on order lines and the preparation tables |
| [tests/test_planning.py](../../tests/test_planning.py), [tests/test_preparations.py](../../tests/test_preparations.py), [tests/test_corrections.py](../../tests/test_corrections.py), [tests/test_baseline.py](../../tests/test_baseline.py) | Behavioral tests |
| [tests/preparation_support.py](../../tests/preparation_support.py) | Helpers shared by those files |
