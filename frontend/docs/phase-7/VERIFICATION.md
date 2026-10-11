# Phase 7 Verification

Date: 2026-10-10. Five slices, delivered against explicit development fixtures: the planning view with the dashboard preparation summary, the printable shopping list, preparation recording with its review and reconciliation, the order screens after partial preparation with linked stock corrections, and the reviewed correction of prepared counts. Nine of the ten Phase 7 tasks are complete. Still open: the staff review, which needs people. Not committed at the time of writing.

## Plan Review

- The frontend shows a plan; it does not make one. Demand, earlier commitments, stock after them and shortages come from the backend. The exact arithmetic exists only in the development fixture.
- The decision register fixes the rules. Confirmed, Preparing and Ready orders contribute their remaining quantities; Pending, Completed and Cancelled contribute nothing. Earlier commitments are subtracted once, and a deficit before the period stays visible as negative stock.
- Because every input to the shortage formulas is on the row, the frontend can check the backend's numbers instead of trusting them. A plan that double-counts commitments or hides a shortage is refused.
- A variant without a recipe must not look like zero demand. The plan is marked incomplete and the known quantities are described as a lower bound.
- The first Phase 7 task links to "preparation/shopping views" and another marks the shopping list incomplete. Both were recorded as partly delivered after the first slice and were completed by the shopping list in the second.
- The proposed contract left the planning row fields unnamed. They are named in the [API proposal](../phase-0/API_CONTRACT.md#planning-and-preparation-phase-7); backend acceptance is open.
- Recording preparation is the first Phase 7 action that changes stock. Nothing may be deducted before a backend-confirmed save, a lost response must never lead to a second deduction, and actual usage is entered by staff. A recipe estimate is never recorded in its place.
- Preparation recording changes how an order becomes Ready, so it is a capability. Fixtures keep it off unless a transport asks for it, which leaves every earlier manual-fulfillment test unchanged.
- An allocation must quote the order version it was read at. The plan is where staff choose what they cooked, so each contributing order row now carries its order version. This is an addition to the planning proposal.
- Mistakes have two remedies in the decision register, and both are built. Returned, wasted or miscounted ingredients are a separate signed stock movement linked to the preparation. A wrong prepared count is an explicit correction reviewed together with its stock adjustments.
- A correction never rewrites the record. The proposal did not say how saved corrections are read back, so a list endpoint beside the record is proposed.

## Delivered Scope

Navigation shows Planning when the orders and planning capabilities are enabled. The page at `/planning` keeps its period in the URL and survives sign-in return. Without a period the backend plans for its own business date. Moving one date past the other moves both, so the period sent is always valid; clearing a date returns to the default.

What to cook lists each variant and selling format with ordered, prepared and remaining quantities and links to the contributing orders with their status. Ingredients needed lists physical stock, earlier commitments, this period's demand, stock after earlier commitments and the shortage for the period and through it. Empty periods say so plainly.

A plan with demand for a variant that has no recipe, in the period or before it, is labelled Incomplete with a statement that quantities are a lower bound and links to the recipe page and the affected orders.

The dashboard has a Preparation section for its date: units and variants remaining, the number of ingredients short, an Incomplete note when recipes are missing, and links to Planning and the shopping list for that date.

The shopping list at `/planning/shopping-list` takes its period from Planning. It lists only ingredients that stock cannot cover through the period: what to buy, physical stock, earlier commitments and this period's demand, with the period, timezone and calculation time. An incomplete list carries the same lower-bound warning and recipe links. Print hides navigation, the back link and the print button, keeps the warning, repeats the table header and does not split rows. An empty list says there is nothing to buy and can still be printed.

Response validation rejects a shopping list that misstates a shortage, includes an ingredient with nothing to buy, or repeats one. It rejects a plan with an invalid identity or period, a completeness flag that disagrees with its missing list, rows whose quantities do not equal the sum of their orders, any order status outside Confirmed, Preparing and Ready, a contributing order without a version, and ingredient rows that break the shortage formulas.

### Preparation recording

Planning offers Record preparation when the capability is on, the backend permits it and something remains to prepare. The entry page at `/planning/prepare` uses the same period. It lists every order line with a remaining quantity, with its order, status and what remains, and takes a whole number prepared now for each. Ingredients used are added from a searchable ingredient list; each takes the actual quantity in a unit of its own dimension and shows current physical stock. A preparation that used no tracked ingredient needs a note explaining it.

Review asks the backend for a preview and changes nothing. It shows prepared counts before and after against the ordered quantity, what remains, each ingredient's usage in the entered and the normalized unit, physical stock before and after, the recipe version on record for each variant, and the estimated ingredient cost. A cost is shown as unknown, never zero, when an ingredient has no purchase. The frontend refuses a preview that does not match the entry or whose counts, stock effects or cost flags disagree.

Recording sends the reviewed draft once under an operation key and opens the saved record at `/preparations/{id}`. The record shows what was prepared for which orders, each ingredient's usage and stock before and after, the estimated cost, who recorded it and when. Each ingredient links to the exact stock movement, and consumption movements on the ingredient page link back to the record.

Backend refusals keep the entry. Usage beyond physical stock is shown on its ingredient. When an order or stock changed after the page loaded, the latest plan and stock are loaded, the entries are kept and a new review is required. An expired preview requires a new review.

An unconfirmed save locks the entry until its status is checked. A recorded operation opens its record without sending anything again. A rejected one releases the entry with the backend's reason. When no operation was recorded, only the identical request with its original key can be retried, and only while the original draft is still in memory; after a reload a missing operation is left to an operator. Leaving the page with entries or an unresolved save asks first.

Keyboard focus moves to the review when it appears, back to the entry when editing again, to the first invalid field or the error message after a refusal, and to the quantity of a newly added ingredient.

### Orders after partial preparation

Order details, reviews and printed summaries show prepared and remaining quantities per line when preparation is recorded; manual orders show neither. An order with something left links to preparation for its fulfillment date. Mark ready and Complete order no longer ask for a staff attestation on recorded orders: the backend permits them only when every line is prepared, and the dialog says so. On manual orders the attestation is unchanged.

Editing a partly prepared order keeps each prepared line: its remove action is disabled with the prepared count stated, and the backend's refusal is shown if the quantity is taken below it. Cancelling lists what was already prepared and requires acknowledging that consumed ingredients are not restored.

The preparation record offers Correct stock and Record waste for each ingredient it used. Both open the existing reviewed stock-movement form against the ingredient's current version. The saved movement is linked to the preparation, and a correction also names the deduction it corrects. The record itself never changes.

### Corrections of prepared counts

The record links to a correction page at `/preparations/{id}/correct`. It shows each line the preparation recorded with the order's current prepared count and status, and each ingredient it deducted with current physical stock. Staff enter a reason, a signed change to any prepared count, and a signed stock change for any ingredient: positive for stock that is back on the shelf, negative for more that was used.

Review shows each count before and after against the ordered quantity, what will remain, and stock before and after. Recording applies the counts and the stock together, once, under an operation key, and returns to the record, where corrections are listed with their reason, time, staff name and links to the orders and stock movements. The original figures on the record stay as they were.

The backend's limits are shown on the line they concern: a count cannot go below zero, below what this preparation recorded, or above what was ordered; it cannot be lowered while the order is Ready or Completed; stock cannot go negative. A lowered count returns to what remains to prepare, except on a cancelled order, which stays out of demand. Changed versions reload the latest orders and stock and keep the entries. An unconfirmed save is reconciled the same way as a preparation: status first, and only the identical request may be retried when nothing was recorded.

## Observed TDD

Behavioral tests preceded each implementation, against importable stubs.

| Cycle | Observed Red | Green Result |
|---|---|---|
| Planning contract | 6 tests failed: the planning capability was off and the route answered "This workflow is not available" | Remaining demand with contributing orders, status eligibility, earlier commitments counted once, negative stock after them, period and cumulative shortages, missing recipes in and before the period, the default business date, period validation and capability refusal passed. |
| Response boundary | 3 of 4 tests failed: the stub accepted every plan | Invalid identity, period and completeness, rows that do not add up, ineligible statuses, and ingredient rows that double-count or hide a shortage are rejected. |
| Planning screens and navigation | Full suite: 11 failed, 314 passed. Nine new screen tests failed on the missing route, navigation link and dashboard section; the navigation test, changed first to expect Planning, failed; and an existing fixture test that used `/planning` as its example of an unimplemented workflow failed and now uses another route | Planning view, changed periods in the URL, incomplete warning with links, empty period, dashboard summary, inconsistent plan, oversized period and capability gates passed: 325 tests. |
| Shopping-list contract and boundary | 7 tests failed: the shopping-list route answered "This workflow is not available", which also failed the response tests that share its examples | Only cumulative shortages are listed, with the plan's period, completeness and commitments; a list that miscounts, pads or mislabels what to buy is rejected. |
| Shopping-list screens | 5 tests failed on the missing route and links | List with stock and commitments, print action, return to the same plan, incomplete warning, empty list, links from planning and the dashboard, and an understated shortage refused with printing disabled passed: 332 tests. |
| Preparation contract | 8 tests failed against a handler that answered nothing. After the implementation the full suite had one failure: an existing test used a preparation route as its example of an unimplemented workflow; it now uses a route that is not planned | Prepared and remaining quantities on orders, readiness gated on them, preview without effect, one deduction per operation key, replay, allocation and usage validation, stock bounds, unknown cost, preview binding, edit and cancellation limits after partial preparation, and capability refusal passed: 340 tests. |
| Preparation responses and order versions | First run 5 failed: the stubs accepted everything and planning rows had no order version. The tests were then tightened before any implementation (stock effect on the saved record, variant identity, operation reads) and 8 failed | Previews, saved preparations, save results and operation reads are checked against the draft that produced them; planning rows without a version are rejected: 344 tests. |
| Preparation screens | 13 of 14 tests failed on the missing routes and links. The one that passed asserts that nothing is offered while recording is disabled | Entry, review, recording, the saved record, stock bounds, changed versions, a mismatched preview, lost responses, the identical retry, a rejected earlier save, an unresolved save after reload and movement links passed: 358 tests. |
| Orders after partial preparation and linked corrections | 7 tests failed. Two new tests passed at once because they assert behavior that already existed: manual orders show no prepared counts, and a disabled Mark ready shows the backend's reason | Prepared counts, the preparation link, readiness without attestation, the cancellation review, edit limits, and waste and correction movements linked to their preparation passed: 367 tests. |
| Focus on a new ingredient; no offer when nothing remains | 1 test failed in each of two small cycles | A newly added ingredient takes focus, and Planning stops offering recording once every line is prepared: 368 tests. |
| Correction contract and responses | 4 tests failed: the correction routes answered "Preparation action unavailable" and the response stubs accepted everything | Preview without effect, counts and stock amended once per operation key, replay, the listed corrections, bounds on counts and stock, the Ready and Completed rule, cancelled orders kept out of demand, stale versions and preview binding passed; previews, results, lists and operations that disagree with the draft or the record are rejected. |
| Correction screens | 8 tests failed on the missing route and link | The link from the record, entry, review, recording, the listed correction, entry checks, a backend refusal on its line, changed versions, a lost response, the identical retry and a mismatched preview passed: 380 tests. |

Corrections not counted as feature red. Two planning screen tests queried a page region before the plan had loaded. The first browser run expected an exact text on an element that also held the Incomplete note; the count now has its own element. The first walkthrough script reloaded the page, which resets in-memory fixtures; it now navigates inside the page. Screenshot review led to spacing under the period line, the incomplete warning and the preparation entry fields.

One response test case was wrong when written: it described a preview that was internally consistent, so nothing could reject it. It was replaced by a prepared count above the ordered quantity. One screen expectation was changed after the implementation chose to link a record's ingredient to its exact stock movement instead of the ingredient page. One screen test asserted the redirect after a stock movement in the same instant as the saved message and failed once in a full run; it now waits, and three consecutive full runs passed. The preparation walkthrough script first expected a fully prepared Ready order to vanish from the plan; the plan correctly keeps it with nothing remaining.

Not test-first: the loss of keyboard focus after a review was found with a browser probe (focus on the document body), and the fix was written together with its browser check. The correction page reuses that focus handling, and its browser checks were written after the page. Three copies of the operation polling loop were replaced by one shared function without new tests; the existing order and inventory operation tests cover it and pass.

Two full-page screenshots show the skip link although nothing has focused it. A probe of the same state reported the link unfocused and off screen, so this is a capture effect and not page behavior.

One rule is implemented but not exercised: a variant ordered in two selling formats is planned as two rows. The fixture forbids changing a variant's format once it has been ordered, so the case cannot be produced through it.

## Final Verification

- [x] `npm test`: 380 tests in 33 files passed, including production exclusion of fixture planning, preparation and correction identifiers.
- [x] `npm run typecheck`: passed.
- [x] `npm run build`: passed. Main chunk 603.04 kB (176.94 kB gzip); the size advisory remains.
- [x] `npm run test:e2e`: 73 Chromium checks passed: twelve for planning and the shopping list, thirteen for preparation recording and corrections, and all 48 earlier checks.
- [x] 320/375/768/1280-pixel layouts, a ten-digit order quantity at 200% text zoom, 44-pixel order links on narrow screens, a changed period in the address bar and the dashboard summary on a phone checked. Desktop and phone screenshots of planning and the dashboard summary were inspected. The shopping list was checked under print emulation at each width, with a PDF produced at 1280 pixels; its print and phone screenshots were inspected.
- [x] Preparation entry, review and record checked at 320/375/768/1280 pixels, with 44-pixel inputs and buttons on narrow screens; a ten-digit quantity and a 190-character ingredient name at 200% text zoom; the leave prompt with entries kept; keyboard focus through the review; a partly prepared order and a linked stock correction on a phone. The correction entry, its review with focus on the review, and the corrected record were checked at the same four widths. Entry, review, record, order, cancellation and corrected-record screenshots were inspected.
- [x] Actual fixture preview exercised without interception for planning: an empty default day, a three-tray order against the placeholder recipes giving a 250 g shortage of one ingredient and none of the other, demand unchanged after the order moved to Preparing, the dashboard summary, phone layout and sign-out.
- [x] Actual fixture preview exercised without interception for preparation: one of two trays prepared with actual usage, the plan and stock refreshed, Mark ready refused until the second tray was recorded and then allowed without attestation, two linked consumption movements, a linked stock correction, a second order recorded with one tray too many and corrected with stock returned, that order then cancelled with its remaining stock left consumed, the entry page on a phone and sign-out. No page errors; session storage empty after sign-out.
- [x] Checks ran in a Linux copy of the workspace with a clean `npm ci`, because the workspace `node_modules` is a Windows install.

Fixtures are memory-only. They do not establish persistent planning, backend demand calculation, exactly-once stock consumption by a real backend, or real staff acceptance. The fixture preview now runs with preparation recording enabled, so orders created there need recorded preparation before they can be marked ready.

## Flaky Assertion (2026-10-11)

"reviews the stock deduction and records a partial preparation once" failed once in CI on a commit that changed no frontend code, and passed on every local run. After the save the test read the "Ingredients used" region of the preparation record page straight away, but that page shows its heading first and its regions only once the record has loaded. The assertion now waits for the region. No application code changed. Observed red: once, in CI. Green: the file passed three times in a row locally, and the full suite of 382 passes.

The other three places where the preparation tests read a region without waiting come after the same page has already been seen loaded, so they were left as they are. Other test files were not audited for the same pattern.

## Remaining in Phase 7

- [x] Preparation entry with quantities prepared, actual ingredient consumption and a stock-deduction review.
- [x] Permitted edits and cancellation after partial preparation, and the explicit stock corrections they require: prepared counts on orders, edit limits, the cancellation review, stock movements linked to a preparation and the reviewed correction of prepared counts.
- [x] Reconciliation of uncertain preparation operations, with remaining demand and stock refreshed after success.
- [ ] Walkthroughs. Partial preparation, status changes, earlier commitments, cancellation, repeated requests and printing are covered by the automated checks and the two preview walkthroughs above. The staff review needs people and has not happened.
