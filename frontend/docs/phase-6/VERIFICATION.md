# Phase 6 Verification

Date: 2026-10-10. Frontend delivered against explicit development fixtures. Backend agreement/integration, confirmed business settings, actual recipes and purchase prices, and real staff review remain pending. Committed on 2026-10-10 in the repository's initial commit, together with Phases 0-5 and the review fixes.

## Plan Review

- The frontend never calculates a cost. It displays the backend estimate and checks that the estimate is internally consistent; exact arithmetic exists only in the development fixture.
- A recipe describes exactly one selling unit of one variant. Each tray size has its own recipe and nothing is scaled between sizes. A recipe whose yield no longer equals the variant's selling format must not be estimated as if it did.
- Unknown cost is null and makes the whole estimate incomplete; a known zero cost is a real basis. Neither a missing recipe nor a missing price may appear as $0.00.
- Row amounts come from the unrounded receipt basis and the total is rounded once, half-up. Summing per-row rounded amounts would give a different total, so the frontend shows exact row amounts and the backend total, and does not re-sum.
- The contract leaves recipe saves out of the operation-key list. A version-guarded `PUT` cannot apply twice, so an unknown outcome is settled by rereading the recipe rather than by the durable operation protocol. This and the estimate/basis fields the screens need are recorded as refinements in the [API proposal](../phase-0/API_CONTRACT.md#recipes-and-cost-estimates-phase-6); backend acceptance is open.
- The contract has no list-level estimate field. Fetching one estimate per variant from the menu list would multiply requests on every search keystroke, so the list shows recipe presence only and completeness lives on the recipe page.

## Delivered Scope

Navigation reads Menu & Recipes when the menu, recipes and inventory capabilities are all enabled. Each variant row links to its protected recipe page at `/menu/:foodId/variants/:variantId/recipe` and a variant without a recipe is marked. The page returns to the filtered menu, survives sign-in return, and is blocked for live use until business currency and timezone are confirmed. Development data is labelled as sample recipes. The fixture preview opens with lorem ipsum placeholders in place of recipes the business has not yet supplied: ingredients Lorem, Ipsum, Dolor and Amet, one receipt from "Lorem ipsum supplier", and a one-unit recipe with a complete estimate for each of the six provisional variants. The seed is opt-in on the fixture transport, runs through the fixture's own endpoints so it passes the same validation as staff entries, and is excluded from production builds; the automated tests otherwise start from an empty fixture.

The recipe page states the yield, the saved rows with links to their ingredients, and the recipe version. The editor states the exact selling unit, selects ingredients through searched and paginated inventory, allows each ingredient once, and accepts grams/kilograms, millilitres/litres or whole pieces to match the ingredient's base unit. Quantities are positive with at most three decimals. Backend field errors keep the draft and focus the field. Dirty drafts are protected against dismissal, reload and history navigation.

The estimate section shows selling price, estimated ingredient cost and ingredient contribution estimate as separate amounts, labelled Complete or Incomplete, with a note that the contribution is not net profit. Each ingredient row shows its base quantity, latest purchase date, receipt link, comparable unit cost and exact row amount. A missing recipe or price shows Incomplete with a link to the affected ingredient; unpriced rows show Unknown. The estimate is reread after a recipe save and on every visit, so recipe, selling-price and purchase changes appear.

A stale version or a raced creation shows the latest saved recipe and requires an explicit choice between keeping the draft against the reviewed version and replacing it. An unconfirmed save freezes the form; Check saved recipe rereads the recipe and reports saved, not saved (the same draft can be saved again), or changed by someone else (conflict review). Nothing about a recipe draft is written to browser storage, and expiry clears it without replay.

Response validation rejects recipes with an invalid identity, yield, ingredient list, unit or quantity, and estimates whose totals, missing list and basis disagree, including an incomplete estimate carrying a numeric cost, a contribution that is not price minus cost, and a row that mixes known and unknown price fields.

## Observed TDD

Behavioral tests preceded each implementation. Boundaries started as importable stubs so that red was behavioral, not a missing import. Test-harness corrections are listed separately and are not counted as feature red.

| Cycle | Observed Red | Green Result |
|---|---|---|
| Recipe/estimate contract | 10 tests failed: recipes capability disabled and recipe routes answered "Menu action not found" | Creation, the 750 g of 2 kg/$24 = $9 example, kilogram/litre/piece normalization, unknown versus zero cost, single half-up rounding, latest business-date basis, recomputation, field validation, version/raced-creation conflicts, yield mismatch and capability refusal passed. |
| Response boundary | 3 of 4 tests failed: the stubs accepted every recipe and estimate and the exact-amount formatter returned nothing | Invalid recipes and self-contradictory estimates are rejected; exact nine-decimal amounts format without rounding; saved rows compare by value. The comparable-cost formatter was refactored onto the shared helper with its existing tests passing. |
| Screens and navigation | Full suite: 19 failed, 281 passed. 16 new screen tests failed on the missing route, links and editor; three existing navigation tests, changed first to expect Menu & Recipes, failed | Menu links, recipe entry and validation, estimate and basis display, incomplete and zero-cost states, kilogram edit and refresh, conflict review, reread recovery, retained backend errors, dirty protection, yield mismatch, mismatched estimate, capability and live gates passed: 300 tests. |
| Narrow menu layout | Three existing Chromium checks failed at 320/375/768 pixels: the new recipe column width rule out-ranked the phone rule and narrowed the variant label | Column widths are scoped to header cells; all 40 earlier checks pass again. |
| Long names at text zoom | The 200% zoom check failed: a 198-character ingredient name in a field label overflowed the editor | Field labels wrap; the check passes. |
| Lorem ipsum placeholder recipes | 4 tests failed: requesting samples left the fixture without ingredients, receipts or recipes, and the menu still showed No recipe | Four placeholder ingredients, one receipt and six one-unit recipes are seeded with complete estimates (Medium Caldereta $9.60 cost, $70.40 contribution); the default fixture stays empty and a placeholder can be replaced. |

One screen test, that no recipe links appear without the capability, passed before implementation because no links existed yet. A selling-price test (edit the variant price in the menu, then open the recipe) was added afterwards and passed against the already-implemented reread. Test-harness corrections: three screen tests queried the estimate region before the page had loaded, and the first browser run asserted the navigation link at phone widths where it is inside the closed drawer.

## Final Verification

- [x] `npm test`: 306 tests in 27 files passed, including production exclusion of fixture recipe identifiers and placeholder data.
- [x] `npm run typecheck`: passed.
- [x] `npm run build`: passed. Main chunk 541.59 kB (162.84 kB gzip); the size advisory from Phase 5 remains and route code splitting is still a future improvement.
- [x] `npm run test:e2e`: 48 Chromium checks passed, eight for Phase 6 and all 40 earlier checks.
- [x] 320/375/768/1280-pixel layouts, a 198-character ingredient name, the maximum safe cost with a negative contribution, 200% text zoom, keyboard focus/trap/return, discard and history protection, and expiry recovery checked. Screenshots of the menu links, editor, complete, incomplete and zoomed estimates were inspected.
- [x] Actual fixture preview exercised without interception: placeholder recipes on all six variants (Medium $9.60 cost, $70.40 contribution) and the placeholder receipt; then a new Party variant at $150.00, ingredient creation, 2 kg/$24 purchase, 750 g recipe, $9.00 cost and $141.00 contribution, receipt link, a second unpriced ingredient showing Incomplete, its purchase giving $9.01, a menu price change to $160.00 giving $150.99, phone layout and sign-out. No page errors; session storage empty after sign-out.
- [x] Checks ran in a Linux copy of the workspace with a clean `npm ci`, because the workspace `node_modules` is a Windows install. The preview used a temporary fixture-mode server on port 5199.
- [x] Six of eight Phase 6 frontend tasks checked. Collecting actual recipes and the staff review stay open.
- [x] Committed on 2026-10-10 in the repository's initial commit. Verification above was completed before that commit.

The jsdom scroll warning is a platform limitation. Fixtures are memory-only and reset on reload. They do not establish persistent recipes, backend costing, authorization or real staff acceptance.

## Live Verification Against the Local Backend (2026-10-11)

Backend Phase B6 delivered recipes and ingredient cost estimates, so the Phase 6 screens were run in live mode against the real FastAPI server through the development proxy. One answer was deliberately dropped; nothing else was intercepted. The steps and results are in the [backend Phase B6 record](../../../backend/docs/phase-6/VERIFICATION.md#live-verification); the script is `.playwright/phase6-live.mjs`.

Seen working in the browser: the menu's "Add recipe" link and the empty recipe page with an Incomplete estimate; a 750 g recipe entered in the editor, saved with a lost answer and found saved once by "Check saved recipe"; the Complete estimate of $9.00 with $71.00 contribution and $12.00 per kg; an unpriced ingredient added through the editor, leaving the estimate Incomplete with no $0.00, a link to the ingredient and "No purchase price"; $9.01 after that ingredient was bought; $15.01 after a newer flour purchase, with no recipe save in between; a save overtaken by another one, shown the latest recipe, kept as a draft and saved as the next version; and the menu marking the variant "Recipe and estimate". No frontend change was needed.

Sent as requests from the signed-in browser session rather than typed into a form: the two ingredients, the three purchases, and the save that overtook the page.

Not repeated in the browser against the live server: a recipe left behind by a changed selling format, a second creation, refused units and quantities, and the workflow and live-settings gates. The backend's tests cover them.

Still open for this gate: agreement on the refined contract, actual recipes and purchase prices, confirmed currency and timezone, and a staff walkthrough. Nothing was run on Windows.

## Live Handoff

- [ ] Obtain backend acceptance of the refined recipe/estimate contract, including the basis row fields, the null rules for incomplete estimates, the yield-mismatch rule and saves without operation keys.
- [ ] Decide whether the menu list needs a backend-derived estimate status per variant; the current contract cannot show missing prices in the list. Progress, 2026-10-11: backend decision D12 keeps the status on the recipe page. It was adopted by default when backend Phase B6 was built; the owner has not confirmed it.
- [ ] Collect actual recipes per sellable variant and size from the business. Do not provision development samples or the lorem ipsum placeholders as live recipes.
- [ ] Repeat yield and unit validation, raced creation and stale-version conflicts, the unrounded cost basis with a single rounding, latest business-date basis selection, and recomputation after recipe, price and purchase changes against persistent FastAPI storage. Progress, 2026-10-11: a stale-version conflict, single rounding, the latest basis and recomputation after recipe and purchase changes were seen in the browser against the local server; the rest is covered by the backend's tests only.
- [ ] Verify cookies/CSRF and capability authorization on recipe and estimate reads and saves.
- [ ] Obtain staff review of the purchase-to-recipe workflow on desktop and phone.
