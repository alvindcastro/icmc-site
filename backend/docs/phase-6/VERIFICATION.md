# Phase B6 Verification

Date: 2026-10-11. Phase B6 delivered: all 8 tasks are complete. Not committed at the time of writing.

## Plan Review

- Decision D12 was open and the plan gave no recommendation. It was adopted as "recipe page only": the food list carries no estimate status. That is what the contract proposes and what the frontend was built for, so nothing else had to change. The owner was told the phase needed the choice and named neither option. Reversing it would add one derived field per variant to the food list.
- The contract says a calculation beyond the money bound is a 422 field error. An estimate is a read with no input, so the error is reported at the figure that could not be stated, `/ingredient_cost_minor`.
- Receipts record the currency they were entered in. The contract does not say what an estimate should do when the settings currency has changed since. It now treats such a receipt as no price; see the table below.

## Delivered Scope

**Recipes.** `GET /variants/{id}/recipe` and `PUT /variants/{id}/recipe`. A recipe says what goes into exactly one selling unit of a variant: 1 to 100 rows, each ingredient once, a positive quantity in one of that ingredient's own units. Rows come back in the order and form they were entered, with the ingredient's present name. The first save is version 1 and marks the variant with its `recipe_id`; the variant's own version does not move. Each later save replaces the rows and advances the recipe version once. A stale version, or a second creation, is a conflict that carries the latest recipe. The save takes no operation key.

**Estimates.** `GET /variants/{id}/estimate` works out the ingredient cost of one selling unit from the latest purchase of each ingredient, and the contribution left from the selling price. Nothing is stored: a new purchase or a new selling price shows on the next read. Each row names the receipt line it was costed from. When the recipe is missing, was written for a selling format the variant no longer has, or an ingredient has no usable price, the estimate is incomplete and has no cost and no contribution.

**Exactness.** Row amounts are exact fractions of the receipt line's total and quantity. They are added up exactly and the sum is rounded once, half-up. The nine-decimal unit cost is for display only and is never used in the sum.

`recipes` joins the released workflows, so `food-admin setup-local` enables it.

## Clarifications Written Into the Contract

| Subject | Choice | Reason |
|---|---|---|
| `yield` | Compared whole with one selling unit of the variant as it is now. A missing or extra member is one error at `/yield`. | The contract names only `/yield`; the frontend shows it as one message. |
| Order of checks | The fields, then the version. | As the fixture does. An integer version with no recipe is a field error; a null version after another creation is the conflict. |
| Row problems | One per row, the first found: ingredient, unit, quantity. | The paths the frontend shows beside each row. |
| Large quantities | Refused at `quantity` when the amount in the base unit is beyond the quantity bound, so `9007199254740991` in `kg` is too large. | The fixture checks only the entered number, but the frontend refuses an estimate whose base quantity is beyond the bound. |
| Ingredient names | A recipe and an estimate show the present name. Renaming does not change the recipe version. | A recipe is a working document, not a receipt. |
| Earlier versions | Saving replaces the rows that are served. The rows of earlier versions stay in the database. | Business records are never hard-deleted; nothing reads them yet. |
| Another currency | The latest purchase counts as a price only when its receipt is in the settings currency. Otherwise the row is unpriced, `price_missing`. Older receipts are not searched. | 2400 US cents are not 2400 yen. An unknown cost must be shown as unknown. |
| Unit cost in a row | The same string the ingredient and its price history show for that receipt line. | One figure, worked out in one place. |
| A total too large to state | 422 `validation_failed`, one field error at `/ingredient_cost_minor`, code `overflow`. | The contract's rule for overflow. |
| Live systems | Every recipe and estimate route, reading included, is 409 `settings_unconfirmed` until currency and timezone are confirmed. | The contract says live use requires them. |
| Estimate status in the food list | None. | Decision D12. |

## Observed TDD

Tests were written first. Counts are from `uv run pytest`.

| Cycle | Observed red | Green result |
|---|---|---|
| Recipes, estimates and their access rules | Of 53 new tests, 3 failed and 50 errored in the shared fixture, because the `recipes` workflow could not be enabled. | The first run after implementation: 49 passed and 4 failed. All four were one mistake in a test helper, which was handed the same argument twice; the server was not involved. With the helper corrected, 53 passed. Across the suite, 912 passed. |

Changed in existing tests because the behaviour changed on purpose:

- The test that names a workflow the server has not released moved from `recipes` to `planning`.
- The list of expected tables gained `recipes` and `recipe_items`.

Not test-first:

- The tables and migration were written with the tests, before the red run, as in earlier phases.
- The refusal of a total too large to state was in the first implementation without a test. Its test was added afterwards and passed at once.
- The rule about a receipt in another currency was written together with its test. No red run was observed for it.
- One test compared the refused query parameters loosely. It was tightened to the exact paths afterwards and passed.

Refactoring with tests passing: rounding to nine decimals and to minor units was moved to exact integer arithmetic; the unit cost of a receipt line, the table of compatible units and the stock bound are now shared with the inventory service instead of repeated; the version check accepts "no version" as what the caller saw.

After these additions the recipe file holds 55 tests and the suite 914.

## Live Verification

Run on 2026-10-11 on one machine: a new database made by `uv run food-admin setup-local`, uvicorn on `127.0.0.1:8000`, the frontend's development server in live mode on `127.0.0.1:5173`, and Chromium driven by `frontend/.playwright/phase6-live.mjs`. One answer was deliberately dropped; nothing else was intercepted. Steps marked "by request" were sent to the server from the signed-in browser session rather than typed into a form.

- [x] "Menu & Recipes" is offered in the navigation, and the menu offers "Add recipe" for the Medium tray of Beef Caldereta.
- [x] By request: Flour and Salt are created, and 2 kg of flour is bought for 24.00 on 2026-10-07.
- [x] The recipe page says there is no recipe and shows the estimate as Incomplete.
- [x] 750 g of flour is entered in the editor. The answer to the save is dropped; "Check saved recipe" reads the recipe again and reports it saved. The server log shows one save, answered 201.
- [x] The estimate is Complete: $9.00 of ingredients, $71.00 contribution, flour at $12.00 per kg. From the server: 900 and 7100 minor units, `0.012000000` per gram, a row amount of `9.000000000`, purchased 2026-10-07.
- [x] The variant now carries its `recipe_id` and is still at version 1.
- [x] 5 g of salt, never bought, is added through the editor. The estimate is Incomplete, shows no $0.00, links to Salt's own page and says "No purchase price". From the server: recipe version 2, cost and contribution null, one `price_missing` entry for salt.
- [x] By request: 1 kg of salt is bought for 1.00. The estimate is Complete at $9.01: row amounts `9.000000000` and `0.005000000`, rounded once to 901.
- [x] By request: 1 kg of flour is bought for 20.00 on 2026-10-09. Without anyone saving the recipe, the estimate reads $15.01.
- [x] By request: the recipe is saved from version 2 to version 3 with 800 g of flour. The page, still holding version 2, tries to save 700 g: it is shown "Version 3" with 800 g, keeps its draft, and saves version 4 with 700 g. The estimate reads $14.01. The server log shows the 409 between the two saves.
- [x] Back on the menu the Medium tray is marked "Recipe and estimate" and the Small tray still offers "Add recipe". The menu fits a 375-pixel phone. No page errors.

The script was run three times, each on a new database. The first run passed before the changes to rounding, the shared unit cost and the currency rule. The second, after them, added the overtaken save. The third added the lost answer; it is the run described above.

Not covered in the browser:

- A recipe left behind by a change of selling format, a second creation, refused units and quantities, the 100-row limit, a receipt in another currency and a total too large to state are covered by the server tests only.
- The workflow switches and live settings with unconfirmed currency or timezone were not driven in the browser.
- Ingredients and purchases were made by request here; their forms were driven in Phase B5.
- Nothing was run on Windows.

## Final Verification

- [x] `uv lock --check`: the lockfile is current. No dependency was added in this phase.
- [x] `uv run pytest`: 914 passed across 20 files.
- [x] `uv run ruff check .` and `uv run ruff format --check .`: passed.
- [x] `uv run mypy`: no issues in 83 source files, strict mode.
- [x] Frontend source is unchanged in this phase.
- [x] Checks ran in a Linux copy of the workspace.

## Known Limits

- Only the latest purchase of an ingredient is looked at. If the settings currency was changed and that purchase is in the old one, the row is unpriced even when an earlier receipt in the new currency exists.
- An estimate too large to state is refused as a whole; the rows that could be costed are not returned with it.
- A recipe cannot be deleted. The contract leaves deletion out of the pilot.
- Earlier versions of a recipe are kept but no route serves them.
- The estimate reads each ingredient and its receipt separately, at most 100 of each for one recipe.
- The suite now takes about a minute and three quarters.
- Windows is still unverified.

## Entry Points

| File | Responsibility |
|---|---|
| [services/recipes.py](../../app/services/recipes.py) | Saving and reading recipes, and the estimate |
| [schemas/recipes.py](../../app/schemas/recipes.py) | Request and response models |
| [api/v1/recipes.py](../../app/api/v1/recipes.py) | Contract routes and their access rule |
| [persistence/migrations/versions/0007_recipes.py](../../app/persistence/migrations/versions/0007_recipes.py) | The recipe tables |
| [tests/test_recipes.py](../../tests/test_recipes.py) | Behavioral tests |
