# Phase B5 Verification

Date: 2026-10-11. Phase B5 delivered: all 13 tasks are complete. Not committed at the time of writing.

## Plan Review

- No decision was open for this phase.
- Phase B1 wrote quantities with three decimals, following the contract's example of `"2000.000"`. The frontend prints these strings as they are, so staff would have read "2000.000 g". Quantities are now written without padding: `"2000"`, `"0.5"`, `"0"`. The contract already says the frontend compares quantities numerically, and the frontend's fixture writes them the same way.
- The contract's price history sits under `/ingredients/{id}/prices`. It is served with the ingredient record and needs only the `inventory` workflow; the receipts themselves need `purchases` as well.
- A movement can name a preparation only once preparation recording exists, which is Phase B7. Until then any such link is refused.

## Delivered Scope

**Ingredients.** `GET /ingredients` with search and a low-stock filter, `GET /ingredients/{id}`, and keyed `POST` and `PATCH`. An ingredient has a name, a base unit of grams, millilitres or pieces that never changes, and an optional warning level. Low stock means a warning level exists and stock is at or below it.

**Stock movements.** `POST /ingredients/{id}/movement-preview` shows before, change and after for an opening count, waste or a correction. `POST /ingredients/{id}/movements` saves exactly what was previewed, with an operation key, and answers with the movement and the ingredient. `GET /ingredients/{id}/movements` lists them newest first. Opening stock is allowed once, before any other movement. Stock never goes below zero. A correction can point at the movement it corrects.

**Purchases.** `POST /purchases/preview` normalizes each row to the ingredient's base unit and shows the effect on stock, rows for the same ingredient adding up in order. `POST /purchases` commits the receipt, one movement per row, the stock and the cost basis together. `GET /purchases` lists summaries, `GET /purchases/{id}` returns the receipt, and `GET /ingredients/{id}/prices` the price history.

**Exactness.** Quantities are integers in thousandths of the base unit. A kilogram is 1000 grams and a litre 1000 millilitres; a pack count multiplies its declared contents; nothing else converts. A unit cost is worked out from a receipt line's exact total and quantity each time it is shown, to nine decimals, and never stored rounded.

`inventory` and `purchases` join the released workflows, so `food-admin setup-local` enables them.

## Clarifications Written Into the Contract

| Subject | Choice | Reason |
|---|---|---|
| Quantity strings | No padding zeros: `"2000"`, `"12.34"`, `"0"`. Receipt quantities and pack contents are returned exactly as entered. | See Plan Review; the frontend checks that a receipt repeats what was typed. |
| Order of checks for a movement | The entry itself, then the version, then the entry against the shelf as it is now. | With a stale page, "less than nothing in stock" would contradict the count staff are looking at; the conflict shows them the new one. The fixture checks stock first. |
| Opening stock | Allowed only while the ingredient has no movement of any kind, purchases included. Refused at `/type` with code `opening_used`. | The contract says before other movements. |
| A preview is spent | A successful save uses up its preview. | A repeat under a new operation key would otherwise add the stock twice. |
| Stale purchase | A changed ingredient is 409 `version_conflict` naming that ingredient. A changed settings version, an expired or spent preview, or a different draft is 409 `quote_stale`. | Follows the fixture, with settings added because currency and decimal places come from them. |
| "The identical input" | Compared after validation: `100` and `100.000`, surrounding spaces and an omitted empty note are not differences. | As for order drafts in Phase B3. |
| Receipt references | `DEV-P0001`, ... under development settings and `PUR-...` under live ones. | Matches the fixture in development. |
| Order of lists | Movements of one second in the order they were made; receipts of one date newest entry first. The ID remains the last tie-breaker. | IDs are random, so they cannot say which came first. |
| Field errors for a row | An unknown ingredient at `ingredient_id`; a quantity that is zero, fractional for packs or pieces, or too large at `quantity`; an incompatible unit at `unit`; missing, zero or misplaced pack contents at `pack_contents/quantity`. | The paths the frontend shows beside each row. |
| Live systems | Every stockroom route, reading included, is 409 `settings_unconfirmed` until currency and timezone are confirmed. | The contract says live inventory access requires them. |
| `recorded_by` | A display-name string on movements and receipts, as the frontend expects; the staff ID is stored beside it. | The contract's wording for inventory, which differs from the order ledger's object. |

## Observed TDD

Tests were written first. Counts are from `uv run pytest`.

| Cycle | Observed red | Green result |
|---|---|---|
| Quantities without padding | 6 failed, 2 passed, of the 8 formatting cases. The 2 are quantities that look the same either way. | 83 value tests passed. |
| Ingredients, movements, previews, purchases, price history | Of 184 new tests, 2 failed and 182 errored in the shared fixture, because the `inventory` workflow could not be enabled. | The first run was stopped at its first failure, after 86 passes: a stale waste entry was refused for its stock instead of its version. The order of checks was changed as described above, and all 184 passed. Across the suite, 859 passed. |

Changed in existing tests because the behaviour changed on purpose:

- The Phase B1 test that pinned three-decimal quantities now pins the unpadded form, with more cases.
- Two tests tied to the set of released workflows moved to workflows that are still unreleased.

Not test-first:

- The tables and migration were written with the tests, before the red run, as in earlier phases.
- The one failure after implementation was a real disagreement between the test and the code about which refusal comes first. The test was kept and the code changed.

Refactoring with tests passing: the helpers shared by request models (`Text`, `Version`, the trimmed-text rule and the edit base class) moved from the menu and order models into `app/schemas/shared.py`, and the reference counter moved out of the order service.

## Live Verification

Run on 2026-10-11 on one machine: a new database made by `uv run food-admin setup-local`, uvicorn on `127.0.0.1:8000`, the frontend's development server in live mode on `127.0.0.1:5173`, and Chromium driven by `frontend/.playwright/phase5-live.mjs`. One answer was deliberately dropped; nothing else was intercepted. Steps marked "by request" were sent to the server from the signed-in browser session rather than typed into a form.

- [x] Ingredients and Purchases are offered in the navigation.
- [x] Flour (grams, warning level 500) and Oil (millilitres) are added through the form. Flour starts at version 1 with no stock, low, and no cost.
- [x] 2 kg of flour for 24.00 is reviewed as 2000 g. The answer to the save is dropped; "Check save status" opens receipt DEV-P0001. The server holds one receipt and one movement of 2000 g; flour is at 2000 g, no longer low, at `0.012000000` per gram, bought 2026-10-07.
- [x] Three 25 kg bags for 45.00 are reviewed as 75000 g and saved. The receipt keeps "3", "bag" and "25 kg" as entered beside 75000 g at `0.000600000`.
- [x] By request: 2 kg for an ingredient measured in millilitres is refused at `/draft/items/0/unit`.
- [x] By request: the same purchase sent twice with one operation key gives two identical answers, the second marked as a replay, and adds 1000 g once.
- [x] A waste entry of 100 g is reviewed as "78000 g -> 77900 g" and saved.
- [x] By request: a correction of -500 g linked to the bag receipt's own movement. The ingredient page then shows it with its "Corrected movement" link and reason.
- [x] Stock, 77400 g, equals the sum of the five movements. The correction did not change the cost basis, which is the latest purchase by date.
- [x] Price history and the receipt list are newest first. The purchases page fits a 375-pixel phone. No page errors.
- [x] The ingredient page shows quantities as "77400 g" and the server's reason under the disabled Opening stock button.

An earlier run stopped on a mistake in the script: after saving an ingredient the frontend opens that ingredient's page, not the list.

Not covered in the browser:

- The linked-correction form itself and the opening-stock form were not driven; their requests were. A purchase overtaken by another change, an expired preview and the low-stock filter are covered by the server tests only.
- Live settings with unconfirmed currency or timezone were not driven in the browser.
- Nothing was run on Windows.

## Final Verification

- [x] `uv sync --locked` and `uv lock --check`: the lockfile is current. No dependency was added in this phase.
- [x] `uv run pytest`: 859 passed across 19 files.
- [x] `uv run ruff check .` and `uv run ruff format --check .`: passed.
- [x] `uv run mypy`: no issues in 78 source files, strict mode.
- [x] Frontend source is unchanged in this phase.
- [x] Checks ran in a Linux copy of the workspace.

## Known Limits

- Two receipt lines for the same ingredient on the same receipt have the same date and time, so which of them is the cost basis is settled by their IDs, which are random. The contract defines it that way. It matters only if one receipt prices the same ingredient twice at different unit costs.
- Ingredient names are not required to be unique.
- The suite now takes about a minute and a half.
- The API description does not show the bodies of the keyed requests, as noted in the [Phase B2 record](../phase-2/VERIFICATION.md#known-limits).
- Windows is still unverified.

## Entry Points

| File | Responsibility |
|---|---|
| [services/inventory.py](../../app/services/inventory.py) | Ingredients, movements, previews, normalization, purchases, cost basis, lists |
| [schemas/inventory.py](../../app/schemas/inventory.py) | Request and response models |
| [schemas/shared.py](../../app/schemas/shared.py) | Rules shared by every area's request models |
| [api/v1/inventory.py](../../app/api/v1/inventory.py) | Contract routes |
| [services/counters.py](../../app/services/counters.py) | Running numbers for order and receipt references |
| [persistence/migrations/versions/0006_inventory.py](../../app/persistence/migrations/versions/0006_inventory.py) | The inventory tables |
| [tests/test_inventory.py](../../tests/test_inventory.py), [tests/test_purchases.py](../../tests/test_purchases.py) | Behavioral tests |
| [tests/inventory_support.py](../../tests/inventory_support.py) | Helpers shared by the inventory test files |
