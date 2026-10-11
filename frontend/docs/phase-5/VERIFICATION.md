# Phase 5 Verification

Date: 2026-10-07. Frontend delivered against explicit development fixtures. Backend agreement/integration, confirmed business settings, actual starting stock and real staff acceptance remain pending. No code commit created.

## Plan Review

- Keep physical stock and planned demand separate. This phase adds current low-stock warnings; recipes, demand, preparation and shopping actions remain disabled.
- Pack contents must be declared, dimensions must match, pieces must be integral, and grams/milliliters support at most three decimal places. Never infer bag size, density or weight per piece.
- Purchases are immutable receipts with original quantities and normalized snapshots. Stock corrections append linked movements rather than editing/repricing receipts. Unknown cost is null, not zero.
- The proposed contract needed explicit ingredient permissions, summary/receipt/price-history fields, historical monetary precision, per-row stock effects, and ingredient operation keys. These refinements are documented in the [API proposal](../phase-0/API_CONTRACT.md#inventory-and-purchases-phase-5); backend acceptance is still open.
- A lost/malformed mutation reply is not a failed purchase. Preserve one UUID and the exact request, check its operation, and only allow an explicit identical-key/body retry after a missing lookup while that in-memory request survives.

## Delivered Scope

Capability-gated Ingredients/Purchases navigation and protected list/detail routes support URL search/filters/pagination and list-scroll return. Ingredient lists/details show base unit, physical stock, optional threshold, low-stock status, latest comparable cost and purchase date. Creation supports grams, milliliters and pieces; editing changes name/threshold without altering the base unit. Loading, empty/no-results and recoverable errors are distinct.

Chronological stock history shows before/change/after quantities, reason, audit time/staff and receipt/correction links. Opening stock is available only before the first movement. Waste removes stock; corrections may add/remove it but cannot make stock negative. Each form requires a reason and an authoritative preview. Related movement selection is paginated; linked audit records can be located beyond the first history page.

Purchase entry supports business date, supplier/note, searched and paginated ingredient selection, repeated rows, quantities, compatible physical units, bag/bottle/box counts, declared contents and exact configured total-cost entry. Review displays original pack declarations, backend-normalized quantities, per-row/receipt costs, comparable prices and sequential physical-stock effects. Backend rejections retain entry and focus associated field errors. Previews expire after five minutes; changes/errors require fresh review. Saved receipts, current stock and chronological comparable-price history remain accessible. Older business-date receipts do not replace a newer cost basis; waste/corrections do not change purchase prices.

Conflicts show the latest ingredient and require explicit version review plus a fresh preview. Invalid latest records block saving until verified recovery. Updated denied permissions remain disabled with their reason. Response validation rejects wrong identities, dimensions, versions, thresholds, metadata, quantities, totals and operation links before announcing success.

Saving is synchronously guarded against repeat clicks. Uncertain outcomes freeze input/submission and use read-only operation polling with backoff bounded to 30 seconds. A verified success rereads current records, rather than displaying a potentially old operation snapshot. Expiry/sign-out clear protected drafts, including late responses from the old session; only an unresolved operation UUID survives. Re-login never submits automatically. Missing orphan operations require backend/operator reconciliation before another save.

The dashboard's low-stock section is independent of its selected order date. It labels current physical stock and links to all matching ingredients. No recipe estimate, planned demand or preparation deduction is calculated in this phase. Exact normalization/transaction arithmetic uses the existing decimal.js library only in development fixtures; production consumes backend previews and formats returned costs without floating-point loss.

## Observed TDD

Behavioral tests preceded implementation and fixes. Response/model boundaries started as importable throw/false stubs. Test-helper, selector and compiler errors were corrected separately, not counted as feature red.

| Cycle | Observed Red | Green Result |
|---|---|---|
| Inventory/purchase contract | 20 tests failed: capabilities disabled and endpoints absent | Creation/filtering, 2 kg/$24 normalization, declared packs, repeated rows, immutable receipts, history, adjustments, stale/expired preview rejection and replay passed. |
| Representation boundary | Valid quantity formatting and linked response checks failed | Exact display, unknown/zero distinction, stock arithmetic, safe totals, dimensions and operation identities passed. |
| Staff screens | Eight UI scenarios failed on missing Ingredients/Purchases routes and views | Ingredient entry/edit, stock reviews/history, receipts, repeated rows, filters, dashboard warnings, field errors and capability gates passed. |
| Uncertain saves | Five safety scenarios failed on missing workflows | Lost-success reconciliation, explicit original retry, conflict review, orphan blocking and live-settings gates passed. |
| Concurrent key admission | Simultaneous identical creates produced different ingredients | Synchronous admission/snapshotting prevents a second effect and preserves the original replay. |
| Navigation/audit links | Guard said order; older receipt movement was absent on page one | Inventory-named history protection and bounded paginated movement location passed. |
| Invalid responses | Five failures: invalid conflict allowed saving, altered receipt quantity/note announced success, unrelated collection requested, wrong dimension preview accepted | Verified conflict recovery, matched acknowledgments, scoped reads and dimension validation passed. |
| History scope | Another ingredient's movement/price rows were accepted | Current-ingredient history validation and recoverable errors passed. |
| Complete review | Signed stock delta and declared contents were missing from review | Backend delta and original pack contents are visible before save. |
| Permission/acknowledgment | Newly denied edits stayed enabled; wrong version/threshold announced success | Reviewed permissions and matched ingredient results passed; mismatches reconcile instead. |
| Audit-link layout | Phone receipt link occupied the label column | Value-column placement and 44-pixel audit-link targets passed. |
| Summary contract | Purchase list rejected summaries without receipt items | Lightweight list validation and full immutable-detail validation passed. |

Additional regression coverage checks compatible volume/count conversions, fractional/incompatible units, overflow, genuine dates, zero cost, bounded GET-only polling/cancellation, private-draft expiry and ignored late committed responses. Browser harness fixes scope quantity assertions to their cells after adding line cost, pass scroll offsets into browser evaluation, and uniquely identify the related-movement select.

## Final Verification

- [x] `npm test -- --reporter=dot`: 258 tests in 22 files passed, including production exclusion of fixture ingredient/purchase/movement data and decimal arithmetic.
- [x] `npm run typecheck`: passed.
- [x] `npm run build`: passed. Vite reports a nonblocking 518.91 kB main-chunk advisory (156.33 kB gzip); route code splitting remains a future performance improvement.
- [x] `npm run test:e2e`: 40 Chromium checks passed, including nine Phase 5 checks and all 31 earlier-phase checks.
- [x] 320/375/768/1280-pixel layouts, long supplier/notes, maximum safe costs, 200% text zoom, keyboard focus/trap/return, discard/history protection, expiry recovery, filter/pagination/scroll return and off-page audit links checked; screenshots inspected in ignored `test-results/`.
- [x] Actual fixture preview at `http://127.0.0.1:5173` exercised without interception: ingredient creation, 2 kg/$24 purchase, $12/kg history, waste, linked correction, two declared 500 g bags, receipt/current stock, phone dashboard warning and sign-out. No page errors; browser storage empty after sign-out.
- [x] Nine Phase 5 frontend tasks checked. Phase 6 recipes/estimates is next; real staff acceptance remains separate from the developer walkthrough.
- [x] No code commit created.

The jsdom scroll warning is a platform limitation; Chromium checks actual restoration. Fixtures are memory-only and reset on reload. They do not establish durable operation admission, transactional stock/purchase persistence, backend authorization, individual audit attribution or real staff acceptance.

## Post-Delivery Review Fixes (2026-10-10)

A code review of the delivered Phase 1-5 frontend found three inventory defects. The fixes were written first; their regression tests were then observed red against a preserved copy of the pre-fix source, so this was not test-first.

| Fix | Observed Red (pre-fix source) | Green Result |
|---|---|---|
| Unresolved inventory save after its editor closes | Escape during an unconfirmed ingredient save closed the editor with no confirmation; the request was discarded and Add ingredient stayed blocked behind a lookup that could only return 404 | Closing asks for confirmation and Keep editing returns to the frozen draft. After discarding, the exact request stays in memory; Check save status followed by Retry original save sends the same key and body once more, saves the ingredient and clears the marker. |
| Zero stock written with fixed decimals | A created ingredient returned with `stock_on_hand: "0.000"` was reported as "Save result unconfirmed" | Saved-ingredient verification compares stock numerically, so `0` and `0.000` agree and the save is confirmed. |
| Preview deadline on the server clock | With the device clock six minutes ahead of the server a reviewed purchase could not be saved | The preview expiry check uses the server-relative time and the purchase is saved. |

Combined verification after all Phase 1-5 review fixes:

- [x] `npm test`: 269 tests in 23 files passed. Against the preserved pre-fix source the 11 new regression tests failed and the earlier 258 passed.
- [x] `npm run typecheck`: passed.
- [x] `npm run build`: passed; main chunk 522.28 kB (157.44 kB gzip), fixture credentials and example identifiers absent from production JavaScript.
- [x] `npm run test:e2e`: 40 Chromium checks passed, unchanged from the delivery run.
- [x] Checks ran in a Linux copy of the workspace with a clean `npm ci`, because the workspace `node_modules` is a Windows install.
- [ ] Screenshot review and the uninstrumented fixture-preview walkthrough were not repeated for these fixes.
- [x] Committed on 2026-10-10 in the repository's initial commit. Nothing had been committed while these fixes were verified.

## Live Verification Against the Local Backend (2026-10-11)

Backend Phase B5 delivered ingredients, stock movements and purchases, so the Phase 5 screens were run in live mode against the real FastAPI server through the development proxy. One answer was deliberately dropped; nothing else was intercepted. The steps and results are in the [backend Phase B5 record](../../../backend/docs/phase-5/VERIFICATION.md#live-verification); the script is `.playwright/phase5-live.mjs`.

Seen working in the browser: two ingredients added through the form; a 2 kg purchase reviewed as 2000 g, saved with a lost answer and reconciled by "Check save status" to one receipt; three declared 25 kg bags reviewed as 75000 g; a reviewed waste entry; a linked correction shown in the movement history with its "Corrected movement" link; the latest unit cost, price history and receipt list; and the server's reason shown under the disabled Opening stock action. No frontend change was needed.

Sent as requests from the signed-in browser session rather than typed into a form: an incompatible unit, a repeated purchase request, and the linked correction itself.

The live server writes quantities without padding zeros ("77400 g"), as the fixture does.

Still open for this gate: agreement on the refined contract, confirmed currency and timezone, actual ingredient and opening-stock data, and a staff walkthrough. Nothing was run on Windows.

## Live Handoff

- [ ] Close relevant Phase 0 business/staff confirmations and earlier-phase live gates before real use; obtain backend acceptance of the refined inventory/purchase/operation contract.
- [ ] Confirm actual ingredient names/base units, thresholds and reasoned opening-stock counts. Do not provision fixture data as live inventory.
- [ ] Repeat physical/pack normalization, precision/overflow, dimensions, repeated ingredient rows, nonnegative stock and opening/correction rules against persistent FastAPI storage.
- [ ] Verify preview binding/TTL, simultaneous purchase/adjustment/edit races, atomic rollback and one durable receipt/movement effect per UUID across delays, restart, response loss and expiry.
- [ ] Verify immutable receipt/name/unit/currency snapshots, chronological price basis, historical-date entry, zero/unknown costs and correction links across pagination.
- [ ] Verify cookies/CSRF, capability/action authorization and server staff attribution on reads, new writes, operation lookups and replays.
- [ ] Obtain staff approval on desktop/phone and verify current detail/list/dashboard refresh plus backend backup/restore readiness before entering real receipts.
