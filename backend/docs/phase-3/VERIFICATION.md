# Phase B3 Verification

Date: 2026-10-11. Phase B3 delivered: all 17 tasks are complete. Not committed at the time of writing.

## Plan Review

- No decision was open for this phase. D11, the owner's agreement to the contract, and D12 remain.
- The order shape reports nine permitted actions, and five of them belong to Phase B4: the later fulfillment steps, cancellation, payment and refund. Reporting them as allowed would offer buttons the server cannot honour. They are reported as blocked, with reason code `not_released` or `payments_disabled`, until B4 delivers them.
- The plan asks an edit to require the credit acknowledgment "when the quote says so". Credit needs a payment, and payments are Phase B4. The check is written, but no test can reach it yet; B4 must test it.
- "Never hard-delete business records" applies to a line that an edit removes. The line is marked removed and kept.

## Delivered Scope

**Business time.** A business-local date and time resolve to one instant in the settings timezone. A time in the hour daylight saving skips is refused. A time in the hour it repeats is refused until the draft says which UTC offset is meant, and the refusal lists the two. "Today" and every date filter use the business calendar, and each order stores its business-local date.

**Quotes.** `POST /orders/quote` validates a draft, prices new lines from the menu as it is now, and returns lines and totals. A line the order already has keeps its saved name, unit and price. A quote lasts five minutes and is tied to the draft, the settings version, the order version when editing, and the versions of the foods and variants it priced.

**Saving.** `POST /orders` and `PUT /orders/{id}` take the quote and the same draft, check again inside the transaction that nothing the quote rests on has moved, and otherwise answer 409 `quote_stale` and save nothing. A new order gets a reference, snapshot lines, totals, version 1 and its status history. An edit keeps the identity and price of retained lines, adds and removes others, advances the version, and never changes the status. `POST /orders/{id}/transitions` confirms a pending order. All three need an operation key.

**Reading.** `GET /orders` with search, inclusive business-date range, statuses and sort; `GET /orders/{id}`; `GET /dashboard` for a business date, defaulting to today.

`orders` joins `menu` as a released workflow, so `food-admin setup-local` now enables both.

## Clarifications Written Into the Contract

| Subject | Choice | Reason |
|---|---|---|
| "The identical draft" | Compared after validation: surrounding spaces, an omitted empty note and key order do not make a draft different. | Staff reviewed the content, not the spelling. |
| One quote, one save | A successful save spends its quote. Using it again is `quote_stale`. | Otherwise a repeat under a new operation key would create a second identical order. |
| What a quote is tied to | The whole settings version, and for each new or growing line the versions of its variant and of its food. | The food's name is part of the snapshot, and any settings change is cheap to re-quote. |
| Stale edit | A stale `expected_version` is 409 `version_conflict` at the quote as well as at the save. A current version with a quote made against an older one is `quote_stale`. | The version check comes first, as in the fixture. |
| Order that cannot be edited | 403 `action_forbidden` with the edit action's reason, at the quote and at the save. | Same as the fixture. |
| Unavailable or unconfirmed line | Unavailable: a field error at `/draft/items/{i}/variant_id`. Unconfirmed in a live system: 409 `menu_unconfirmed` with the food and variant in `details`. | The first is something staff fix in the draft; the second needs the operator. |
| Fixed delivery charge | The settings' amount is used whatever the draft sends. Pickup with a nonzero charge is a field error. | The contract says the backend supplies it. |
| References | `DEV-0001`, `DEV-0002`, ... under development settings and `ORD-...` under live ones, from one counter. | A development order is recognisable wherever its reference is quoted. |
| Actions not yet served | `start_preparing`, `mark_ready`, `complete` and `cancel` are blocked with `not_released`; `record_payment` and `refund` with `payments_disabled`. | See Plan Review. |
| Removed lines | Kept in the database, marked removed, and absent from every response. | Order history is not deleted. |
| Order of lines | The order of the saved draft. | It is what staff reviewed. |
| Descending sort | Fulfillment time descending, then ID descending. | Paging stays stable in both directions. |

## Observed TDD

Tests were written first. Counts are from `uv run pytest`.

| Cycle | Observed red | Green result |
|---|---|---|
| Business time | 24 failed of 24: the functions were stubs. | 24 passed. |
| Orders: quotes, saving, editing, confirming, lists, dashboard | Of 128 order tests, 1 failed and 127 errored in the shared fixture, because the `orders` workflow could not be enabled. The 8 database tests passed. | 556 passed and 4 failed, all four test issues listed below. After correcting them, 560 passed. |

Test corrections, not counted as red:

- One list test expected two orders due at the same moment in reference order. Only the random ID orders them, so it passed or failed by chance. It now compares them as a set. Three further runs of the order tests passed.
- Three older tests were tied to the set of released workflows: the scaffold test that used `/api/v1/orders` as an unbuilt route, the local-setup test that expected only `menu` to be enabled, and a settings test that counted the unreleased workflows. They now use routes still unbuilt, compare with the released set, and name one unreleased workflow.

Not test-first:

- The table definitions and migration were written with the stubs, before the red run, as in Phase B2.
- No test reaches the credit acknowledgment on an edit. See Plan Review.

The order tests passed on the first run of the implementation, so the red run above is the only failure this code was seen to produce apart from the corrections listed.

## Live Verification

Run on 2026-10-11 on one machine: a new database made by `uv run food-admin setup-local`, uvicorn on `127.0.0.1:8000`, the frontend's development server in live mode on `127.0.0.1:5173`, and Chromium driven by `frontend/.playwright/phase3-live.mjs`. No request was intercepted.

- [x] Orders and Dashboard are offered beside Menu; workflows not yet served are not.
- [x] Two medium Beef Caldereta trays and one 100-piece Shanghai package are quoted and saved at a subtotal of 21500. The order is DEV-0001, confirmed, with both history events, resolved to 19:00 UTC at offset -07:00.
- [x] The menu is then changed through its own screens: the tray's price to 99.00, the variant to unavailable, the food renamed. The saved order is identical before and after, and its page still shows Beef Caldereta and 215.00.
- [x] Two browsers edit the order. The first reviews its quote; the second saves; the first's save is refused and it is shown "Latest saved order" with the other browser's note. The server holds the second browser's note at version 2. After "Keep draft with reviewed version" the first saves at version 3. The tray's identity, name, price and quantity are the same through all three versions, although the menu now says otherwise.
- [x] A second order is saved as pending and confirmed as a separate reviewed step: version 2, two history events.
- [x] Search finds an order by customer name without regard to letter case, and a search with no match shows the no-results state.
- [x] The dashboard for 2026-10-12 lists DEV-0001 under today and DEV-0002 under upcoming, and fits a 375-pixel phone.
- [x] 01:30 on 2026-11-01 asks which occurrence is meant, offers -07:00 and -08:00, and saves with -08:00 as 09:30 UTC. 02:30 on 2026-03-08 is refused with "This time is skipped by the clocks." and nothing is saved.
- [x] No page errors.

Two earlier runs of the walkthrough stopped on mistakes in the script, not in either application. The first used a text selector that the order page splits across elements. The second expected the conflict at the save, but the first browser had not yet asked for its quote, so the server refused the quote itself; that is correct, and the script now takes the quote before the other browser saves so that the conflict arrives at the save.

Not covered in the browser:

- A quote going stale at the save because the menu or settings changed in between, an expired quote, and a lost answer on an order save are covered by the server tests only.
- Live settings with unconfirmed values, and delivery orders, were not driven in the browser.
- Nothing was run on Windows.

## Final Verification

- [x] `uv sync --locked` and `uv lock --check`: the lockfile is current. No dependency was added in this phase.
- [x] `uv run pytest`: 560 passed across 15 files.
- [x] `uv run ruff check .` and `uv run ruff format --check .`: passed.
- [x] `uv run mypy`: no issues in 65 source files, strict mode.
- [x] Frontend source is unchanged in this phase. Its 382 unit tests and 73 Chromium checks last passed on 2026-10-11.
- [x] Checks ran in a Linux copy of the workspace.

## Known Limits

- The suite now takes about a minute. Most of that is real database commits and deliberately slow token hashing.
- The API description does not show the bodies of the three keyed order requests, for the reason given in the [Phase B2 record](../phase-2/VERIFICATION.md#known-limits).
- Any settings change, including one unrelated to orders, makes open quotes stale. Staff see "review a new quote" and lose nothing.
- An edit takes the currency from the settings as they are at the save. Changing the currency of a system that already holds orders is an operator migration the contract leaves undefined.
- Windows is still unverified.

## Entry Points

| File | Responsibility |
|---|---|
| [services/business_time.py](../../app/services/business_time.py) | Local time to instant, daylight-saving cases, the business date |
| [services/orders.py](../../app/services/orders.py) | Quote calculation, saving, editing, confirming, lists, dashboard, permitted actions |
| [schemas/orders.py](../../app/schemas/orders.py) | Request and response models |
| [api/v1/orders.py](../../app/api/v1/orders.py) | Contract routes |
| [tests/test_business_time.py](../../tests/test_business_time.py), [tests/test_orders.py](../../tests/test_orders.py) | Behavioral tests |
