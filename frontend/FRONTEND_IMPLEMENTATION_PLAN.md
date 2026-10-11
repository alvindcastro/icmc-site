# Frontend Implementation Plan

Status: Phases 1-5 frontend implemented and verified against explicit development fixtures on 2026-10-07; their frontend tasks are complete. A code review on 2026-10-10 found four defects in the delivered phases; all four are fixed and verified against fixtures ([review fixes](#post-delivery-review-fixes)). Phase 6 recipes and ingredient estimates were implemented and verified against fixtures on 2026-10-10; six of its eight tasks are complete, while collecting actual recipes and the staff review remain open. All live backend completion gates remain open; the technical parts of the Phase 1 to 4 gates were verified against the local FastAPI backend on 2026-10-10 and 2026-10-11, when backend Phases B1 to B4 delivered sign-in, sessions, settings, operation keys, the menu, orders with quotes and the dashboard, fulfillment steps, cancellation and the payment ledger. The workspace has been under version control since 2026-10-10: the initial commit holds the Phase 0 documents, the Phase 1-6 frontend, the review fixes and the placeholder recipes. Phase 0 documentation has seven of twelve tasks complete; business settings, menu confirmation, initial staff/sign-in confirmation, and the two backend contract agreement tasks remain open. Phase 7 started on 2026-10-10 with the planning view, dashboard summary and printable shopping list, followed by preparation recording with its review and reconciliation, the order screens after partial preparation and the reviewed correction of prepared counts: nine of its ten tasks are complete. The staff review remains.

Source: [Food reservation MVP checklist](../food_reservation_mvp_checklist.md), especially sections 6.1-6.12.

This plan breaks the original three product phases into eight frontend work phases. The workspace now contains the foundation, menu management, reservations, dashboard, fulfillment, payment/refund ledger, printable order summaries, ingredients/stock movements, normalized purchases, comparable price history, and per-variant recipes with backend-calculated ingredient estimates, with explicit fixture and live API modes. It targets the Python/FastAPI backend described in the source checklist. That backend exists in `backend/` since 2026-10-10 and so far implements sign-in, sessions, business settings, the menu with version checks and operation keys, orders with quotes, snapshots and the dashboard, and fulfillment, cancellation, payments and refunds (its Phases B1 to B4); ingredients, purchases, recipes, planning and preparation still run only against fixtures. See the [backend plan](../backend/BACKEND_IMPLEMENTATION_PLAN.md).

## Delivery Order

| Work phase | Result | Original product phase | Depends on |
|---|---|---|---|
| 0. Decisions and contracts | Agreed rules and API behavior for each upcoming feature | All | None; run alongside foundation work |
| 1. Foundation and staff access | Responsive application shell and session handling | 1 | Auth and settings contracts for live verification |
| 2. Menu management | Staff can maintain foods, variants, prices, and availability | 1 | 1; menu contract |
| 3. Reservations and dashboard | Staff can create, review, edit, and find orders | 1 | 2; order and totals contracts |
| 4. Fulfillment, payments, and pilot | Staff can fulfill, take payments, refund, and print orders | 1 | 3; status and payment contracts |
| 5. Ingredients and purchases | Staff can track stock, purchases, and comparable prices | 2 | 4; inventory and purchase contracts |
| 6. Recipes and estimates | Staff can maintain recipes and understand ingredient costs | 2 | 5; recipe and costing contracts |
| 7. Preparation and shopping | Staff can plan demand, record cooking, and print shortages | 3 | 6; planning and preparation contracts |

Work phases 1-4 deliver the first usable order-management pilot. Work phases 5-6 complete the inventory and costing release. Work phase 7 completes kitchen planning.

## Rules for Every Phase

- [ ] Deliver each screen with loading, empty, no-results where applicable, success, and recoverable error states.
- [ ] Preserve form values after failures; protect unsaved changes and prevent repeated submission while saving.
- [ ] Use labeled controls, accessible Lucide actions, visible focus, field-associated errors, and announced save results.
- [ ] Support keyboard navigation, dialog focus return, adequate contrast, and comfortable touch targets.
- [ ] Verify phone, tablet, and desktop layouts, including 320-pixel width, 200% zoom, and long text or large amounts.
- [ ] Format business dates, monetary amounts, and ingredient units consistently.
- [ ] Show navigation and actions only when their workflows are available.
- [ ] Keep totals, conversions, cost estimates, stock changes, and authorization authoritative in the backend.

Development fixtures can support frontend work before APIs exist. A feature is not complete for real use until its behavior has been verified against the backend. Mocked responses do not prove authentication, price preservation, or duplicate prevention.

For every code change, use strict TDD: write a behavioral test first, observe it fail for the missing behavior, implement the minimum passing change, then refactor with tests passing. Record red/green verification when implementing each task. Phase 0 documentation introduces no executable code.

## Phase 0: Decisions and Contracts

Purpose: Resolve the rules needed by each feature before implementing its live workflow. Foundation work can begin immediately; later business decisions do not block the application shell.

- [ ] Confirm business currency, timezone, pickup/delivery options, delivery charges, and tax entry rules before live reservations. Questions and provisional fixture assumptions: [B01-B05](docs/phase-0/DECISIONS.md#business-confirmations).
- [ ] Confirm menu transcription, both Pork BBQ options, and Shanghai package quantity rules before enabling those items for real orders. [Transcription register](docs/phase-0/DECISIONS.md#menu-transcription-register) written; source photograph and owner confirmation pending.
- [ ] Identify initial staff and sign-in requirements. [Requirements](docs/phase-0/DECISIONS.md#staff-and-session-requirements) updated: user requested temporary `admin`/token login; actual staff identities and live provisioning remain pending.
- [x] Sketch desktop and phone layouts for the five main screens, sign-in, reservation entry/review/details, and preparation/shopping views. [Layout sketches](docs/phase-0/LAYOUTS.md) reviewed; implementation/browser verification belongs to later phases.
- [ ] Agree on auth/session, settings, menu, order, quote/recalculation, status, and payment API contracts before phases 1-4 need them. [v1 contract proposal](docs/phase-0/API_CONTRACT.md) written; backend agreement pending.
- [ ] Agree on inventory, purchase, recipe, planning, and preparation contracts before phases 5-7 need them. [v1 contract proposal](docs/phase-0/API_CONTRACT.md) written; backend agreement pending.
- [x] Define money representation, business-date/time serialization, pagination, field errors, session expiry, and permitted-action responses. [Shared representations](docs/phase-0/API_CONTRACT.md#shared-representations) and [auth/session](docs/phase-0/API_CONTRACT.md#auth-and-settings-phase-1).
- [x] Define backend order versions and conflict responses so concurrent staff edits cannot silently overwrite changes. [Atomic version rules](docs/phase-0/API_CONTRACT.md#versions-and-conflict-handling).
- [x] Define operation identifiers and backend deduplication for order creation, payments, refunds, purchases, and preparation; specify how an uncertain result is reconciled. [Durable operation protocol](docs/phase-0/API_CONTRACT.md#operation-ids-and-uncertain-results).
- [x] Decide overpayment policy, refund limits, and how an order total below net payments appears as a customer credit. [Selected financial policy](docs/phase-0/DECISIONS.md#money-payments-refunds-and-credit).
- [x] Define demand eligibility across Confirmed, Preparing, and Ready orders using remaining preparation quantities; specify completion consistency rules. [Preparation eligibility](docs/phase-0/DECISIONS.md#preparation-eligibility-and-completion), including manual pilot fulfillment and later baseline reconciliation.
- [x] Define permitted edits/cancellation after partial preparation and the required explicit stock corrections before phase 7. [Edit/correction policy](docs/phase-0/DECISIONS.md#edits-and-cancellation-after-preparation).

Ready to proceed: The next feature has an agreed contract and documented unresolved decisions. Currency and timezone must remain visibly provisional in development until confirmed; incomplete menu information must not become live selling data.

Review and handoff: [Decision register](docs/phase-0/DECISIONS.md#review-findings), [feature gates](docs/phase-0/DECISIONS.md#feature-gates-and-handoff), and [acceptance scenarios](docs/phase-0/ACCEPTANCE.md) document the concrete outputs and review findings. Phase 0 documentation has been checked for coverage, links, example arithmetic, and policy consistency. Business/staff/menu confirmations and backend acceptance have not been supplied, so Phase 0 is not fully complete. Runtime scenarios are specified but have not been executed.

Source: Sections 1, 6.1, 6.5, 6.6, 6.10, and 7; incorporates the four review findings.

## Phase 1: Foundation and Staff Access

Purpose: Establish the shared frontend and a reliable staff session.

- [x] Scaffold the React application, routing, development/build scripts, and WebStorm run instructions. [Run instructions](README.md).
- [x] Add central API configuration and an API boundary that can use explicit development fixtures while backend integration is pending. Live mode is the default; fixtures require explicit development mode and are excluded from production builds.
- [x] Add centrally configured currency/timezone formatting and shared spacing, type, surfaces, status labels, and semantic colors. Money preserves safe-integer minor units; missing timezone/settings produces recoverable feedback instead of browser defaults.
- [x] Build compact desktop navigation, a phone menu, headings, and a consistent action area; add workflow links as subsequent phases deliver them. Workspace/My account were delivered in Phase 1; Phase 2 adds Menu only when the backend menu capability is enabled.
- [x] Build reusable labeled fields, quantities, availability toggles, tables/phone rows, dialogs, and feedback states as needed by delivered screens. Phase 1 needs labeled fields, icon actions, loading/error/status feedback, and the focus-managed navigation dialog; quantity/toggle/list components remain scoped to their later screens.
- [x] Build temporary `admin`/token sign-in with token visibility, validation, pending state, failed-login feedback, and connection retry without clearing the username. This interim requirement replaces password entry at the user's request.
- [x] Handle protected routes, session expiry, return to the intended screen, and visible sign-out; clear protected data when the session ends. Late responses cannot restore cleared state; uncertain remote sign-out blocks reentry and survives reload until explicitly confirmed.
- [x] Ensure signing in after expiry never automatically repeats a previous mutation. Requests are not queued/retried; obsolete CSRF responses cannot submit after session cleanup.

Backend dependency: Auth/session endpoints and business settings.

Completion check: Keyboard-only sign-in, expiry, and sign-out work against the backend; protected information is cleared and layouts work on desktop and phone.

Frontend verification: strict red/green cycles, 37 passing behavioral/build tests, type checking, production build, and 8 passing Chromium checks. Phone/tablet/desktop layouts, long names, image loading, keyboard use, dialog focus, and 200% text zoom were checked. Temporary admin/token credentials, request fields, validation, and production exclusion are covered. See the [Phase 1 verification record](docs/phase-1/VERIFICATION.md) for evidence and review findings.

- [ ] Live completion gate: repeat auth/session/settings, expiry, sign-out, cookie/CSRF/authorization, and staff walkthrough checks against FastAPI after Phase 0 confirmations/agreement. Fixture verification does not close this gate or make Phase 1 ready for real staff data. Progress, 2026-10-10: the auth, session, settings, expiry, sign-out, cookie, CSRF and Origin checks passed against the local FastAPI server, and one client defect they exposed (a refused CSRF token was kept) is fixed; see the [Phase 1 record](docs/phase-1/VERIFICATION.md#live-verification-against-the-local-backend-2026-10-10). The gate stays open for the Phase 0 confirmations and agreement and the staff walkthrough.

Source: Sections 6.1, 6.2, 6.11, and 6.12.

## Phase 2: Menu Management

Purpose: Supply the selectable, maintainable menu required by reservation entry.

- [x] Build menu search, category/availability filters, empty/no-results states, and Add food. URL-backed filters/pagination, complete category loading, stale-response cleanup, and recoverable loading/errors are tested.
- [x] Build food editors for name, category, description, and availability. Retained input, unsaved-change protection, first-invalid-field focus, announced saves, and duplicate-submission protection are verified.
- [x] Build variant editors for label, selling unit, price, availability, and package contents where applicable. Multiple variants, changes to price/availability, field errors, and explicit conflict review are verified.
- [x] Support trays, pieces, sticks, and fixed-size packages with explicit quantity labels. Package labels count packages and state their whole-piece contents; changing to another selling unit sends null contents.
- [x] Validate required fields and prices; keep unavailable foods/variants accessible for staff editing. Exact configured minor-unit input supports explicit zero and rejects unsafe/negative/excess-precision amounts. Backend capabilities/actions remain authoritative.
- [x] Seed only confirmed live menu data; keep provisional examples in development fixtures. No live seed is installed because no items are confirmed. Fixture records are provisional and excluded from production; unresolved Pork BBQ options are not invented.
- [x] Verify saves, errors, and returned records against the menu API. Frontend verification uses the explicit fixture contract; malformed responses, version conflicts, field errors, and operation reconciliation are tested. Actual FastAPI verification remains below.

Backend dependency: Categories, foods, variants, availability, and menu persistence. Historical order snapshots belong to the order API and are checked once orders exist.

Completion check: Staff can create and edit a food with multiple variants, change prices, and change availability on desktop and phone.

Frontend verification: strict red/green cycles; 98 passing tests across the application, 14 passing Chromium checks, type checking, and production build. Menu/editor layouts at 320/375/768/1280 pixels, long text, maximum safe prices, keyboard focus, discard protection, 200% text zoom, expiry cleanup, and uncertain saves were checked. See the [Phase 2 verification record](docs/phase-2/VERIFICATION.md).

- [ ] Live completion gate: agree on the refined menu/operation contract, confirm business currency and menu transcription/package rules, and repeat CRUD/availability/validation/conflict/reconciliation checks against persistent FastAPI storage. Verify backend authorization/CSRF and confirmation-reset/used-unit rules. Historical order snapshot preservation remains a Phase 3 check. Fixtures do not prove live persistence or duplicate prevention. Progress, 2026-10-10: create, edit, availability, validation, a version conflict between two browsers and reconciliation of a lost answer passed against the local FastAPI server, which now serves the menu with durable operation keys; see the [Phase 2 record](docs/phase-2/VERIFICATION.md#live-verification-against-the-local-backend-2026-10-10). The gate stays open for contract agreement, the currency and menu confirmations (B01, B06-B08) and a staff walkthrough.

Source: Sections 3 (menu and selling formats), 6.7 (Phase 1 items), and 6.11.

## Phase 3: Reservations and Dashboard

Purpose: Deliver the first complete reservation workflow, from entry to review and confirmation.

- [x] Build the order list with reference, customer, fulfillment, totals, balance, and separate preparation/payment statuses.
- [x] Add customer search, date/status filters, clear filters, chronological sorting, and pagination; preserve query state and scroll on return from details.
- [x] Build grouped reservation entry for customer, fulfillment, items, and totals; require a delivery address only for delivery.
- [x] Add searchable available-food/variant selection, repeatable item rows, quantity, preparation notes, line totals, and remove actions.
- [x] Request backend-calculated previews for subtotal, delivery, tax, and total before review/save; show failures without presenting stale totals as current. Frontend consumes quote responses; calculations exist only in development fixtures until FastAPI supplies them.
- [x] Implement Save pending, review before confirmation, field errors, first-invalid-field focus, and retained inputs after failures.
- [x] Build order details with fulfillment, snapshot item names/units/prices, totals, notes, balance, and status history.
- [x] Allow permitted pending/confirmed edits while preserving agreed prices on existing lines; review recalculated totals before saving.
- [x] Detect stale order versions; preserve unsaved input while staff review the latest record and resolve the conflict.
- [x] Build today's orders and upcoming pickup/delivery dashboard in business-time order, with order links and New order.
- [x] Reconcile uncertain order creation using its operation identifier before enabling another submission. Processing uses bounded read-only polling; unknown status allows only an explicit identical-body/key retry while the in-memory request survives.

Backend dependency: Order queries/details, calculated previews, create/update/confirm, immutable line snapshots, permitted actions, versions, and operation reconciliation.

Completion check: Create two medium Beef Caldereta trays and one 100-piece Shanghai package; verify a $215 food subtotal using the checklist's provisional example prices. Confirm the order, change a menu price/name/availability, and verify the existing order snapshots and total remain unchanged. Verify a two-staff edit conflict does not lose entered changes.

Frontend verification: strict red/green cycles; 152 passing tests, 23 passing Chromium checks, type checking, and production build. Verified $215 creation, snapshots after menu changes, $135 retained-price edits, conflicts, DST choices, uncertain saves, session cleanup, filters/scroll return, keyboard focus and history-navigation protection, 320/375/768/1280-pixel layouts, long text, and 200% text zoom. The actual fixture preview was also exercised without API interception. See the [Phase 3 verification record](docs/phase-3/VERIFICATION.md).

- [ ] Live completion gate: agree on the refined order/quote/confirmation contract, confirm business settings and menu transcription, and repeat quote binding/expiry, immutable snapshots, permitted edits, concurrency, durable operation reconciliation, business-time grouping, authorization/CSRF, and staff walkthroughs against persistent FastAPI storage. Fixture verification does not prove production transactions, persistence, or duplicate prevention. Payments and later fulfillment transitions remain Phase 4. Progress, 2026-10-11: quoting, saving, immutable snapshots after menu changes, editing with a version conflict between two browsers, pending confirmation, search, the dashboard by business date and both daylight-saving cases passed against the local FastAPI server; see the [Phase 3 record](docs/phase-3/VERIFICATION.md#live-verification-against-the-local-backend-2026-10-11). The gate stays open for contract agreement, the business and menu confirmations and a staff walkthrough.

Source: Sections 6.3 (Phase 1 items), 6.4, 6.5, 6.6 (details), 6.12, and 8.

## Phase 4: Fulfillment, Payments, and Order Pilot

Purpose: Make the reservation workflow usable for real daily work.

- [x] Add the next permitted status action and dated history for Pending, Confirmed, Preparing, Ready, and Completed. Ready/completion require staff attestation in the manual pilot; completion is independent of payment status.
- [x] Add cancellation confirmation with a required reason and retained payment history; explain unavailable actions. Backend-requested consumed-stock acknowledgment is respected; cancellation never restores stock.
- [x] Build Record payment with amount, date, method, reference/note, validation, and refreshed balance after confirmed success. Explicit review, exact minor-unit input, backend business-date defaults, retained errors/conflicts, and recoverable payment settings are verified.
- [x] Show payments and refunds as separate dated entries; add a validated, confirmed refund action. Refunds select an original payment and require a reason; ledger entries retain amount, method, reference, note, actor, and audit timestamp.
- [x] Apply agreed overpayment/refund rules and display customer credit clearly when order edits reduce the total below net payments. Backend balance/refundable caps remain authoritative; the $180 deposit -> $150 edited total -> separate $30 refund is verified.
- [x] Retain one operation identifier for a payment/refund attempt across retries; reconcile uncertain outcomes with the backend before allowing a new attempt. Unknown results freeze the attempt; only explicit identical-body/key retries are offered after a 404 while the in-memory request survives. Expiry retains only the UUID.
- [x] Refresh dashboard/list/detail balances and statuses after confirmed changes. Financial results and operation wrappers are validated before a fresh current-order read; concurrent edits/payments cannot overwrite the fixture ledger.
- [x] Build printable order summaries with fulfillment, items, units, totals, and balance; hide navigation and editing controls. Protected print routes validate order identity, preserve list-return filters, and print saved snapshots rather than current menu data.
- [x] Complete frontend desktop, phone, keyboard, failure, expiry, conflict, print, and developer workflow walkthroughs. Automated checks and an actual fixture-preview walkthrough are complete; real staff usability acceptance remains in the live gate below.

Backend dependency: Status transitions/history, cancellation, payment/refund ledger, balances/credits, amount validation, and idempotent mutation handling.

Product Phase 1 release check: Staff can create, review, confirm, take a deposit, edit where permitted, fulfill, cancel/refund where appropriate, and print an order. Delayed or repeated payment requests produce one entry. Menu edits preserve historical prices. Backend access protection, live business settings, confirmed menu data, and backend backup/restore readiness are required before real use.

Frontend verification: strict red/green cycles; 201 passing tests across 18 files, 31 passing Chromium checks, type checking, and production build. Verified sequential/unpaid fulfillment, cancellation credit, deposits/refunds and limits, concurrent financial changes, exact retry/reconciliation, retained conflict inputs, expiry cleanup, fresh balances, protected printing, 320/375/768/1280-pixel layouts, long text, and 200% text zoom. The actual fixture preview was also exercised without API interception. See the [Phase 4 verification record](docs/phase-4/VERIFICATION.md).

- [ ] Live completion gate: agree on the refined status/ledger/operation contract and complete Phase 0 confirmations plus the Phase 1-3 live gates. Repeat status/cancellation, append-only financial limits, concurrent edits/payments/refunds, durable operation recovery across restart/expiry, cookie/CSRF/authorization, snapshot printing on staff devices, real staff walkthroughs, and backend backup/restore verification against persistent FastAPI storage. Fixture success does not make the order pilot ready for real data. Progress, 2026-10-11: every fulfillment step, cancellation after a deposit, a deposit with a lost answer reconciled to one ledger entry, a reduced total with acknowledged credit, a separate refund, completion of an unpaid order and a duplicated payment request passed against the local FastAPI server; see the [Phase 4 record](docs/phase-4/VERIFICATION.md#live-verification-against-the-local-backend-2026-10-11). The gate stays open for contract agreement, the Phase 0 confirmations, a verified backup and restore, printing on real devices and a staff walkthrough.

Source: Sections 6.6, 6.11, 6.12, and Phase 1 completion.

## Phase 5: Ingredients and Purchases

Purpose: Add physical inventory and purchase history after the order pilot is usable.

- [x] Add Ingredients and Purchases navigation when their workflows are available. Direct routes enforce capabilities and live currency/timezone gates.
- [x] Build ingredient search and low-stock filtering with base unit, stock, threshold, latest cost, and purchase date. URL filters/pagination and detail-return scroll are verified.
- [x] Build ingredient entry with grams, millilitres, or pieces and optional low-stock threshold. Exact quantities, whole pieces, threshold clearing and immutable base-unit editing are verified.
- [x] Build linked chronological stock movements and opening-stock, waste, and correction forms with reasons and before/after previews. Signed changes, audit links across pages and nonnegative stock are verified.
- [x] Build purchase search/list, supplier/date filters, receipt details, and repeatable purchase item rows. Lightweight list summaries and immutable receipt snapshots are verified.
- [x] Capture quantity, purchase unit, total ingredient cost, and declared pack contents; request backend normalization previews before saving. Review shows normalized quantities, costs and per-row stock effects; arithmetic is fixture-only until FastAPI exists.
- [x] Preserve entered values on invalid conversions/failures; reconcile uncertain purchase results before retrying. Explicit conflict review, bounded GET polling, exact-body/key retry, orphan blocking and expiry/late-response cleanup are verified.
- [x] Show saved receipts, updated stock, comparable unit-price history, and unknown prices distinctly from zero. Backdated receipts and physical corrections preserve the appropriate latest purchase basis.
- [x] Add linked low-stock warnings to the dashboard; keep physical stock distinct from planned demand. Current inventory queries are independent of the selected order date; preparation/planning remain disabled.

Backend dependency: Ingredient records, supported conversions, stock movements, purchase normalization/persistence, price history, and purchase deduplication.

Completion check: Record 2 kg costing $24 and verify 2,000 g added to stock and a comparable $12/kg price. Check declared-pack conversion, incompatible units, adjustments, and duplicate purchase submission.

Frontend verification: strict red/green cycles; 258 passing tests, 40 passing Chromium checks, type checking and production build. Verified the completion example, declared packs, dimensions/precision/overflow, repeated rows, immutable receipts, price history, linked adjustments, concurrency/deduplication, retained failures/conflicts, bounded reconciliation, expiry, keyboard focus/navigation, 320/375/768/1280-pixel layouts and 200% text zoom. The actual fixture preview was exercised without interception. See the [Phase 5 verification record](docs/phase-5/VERIFICATION.md).

- [ ] Live completion gate: agree on the refined inventory/purchase/operation schema, confirm currency/timezone and actual ingredient/opening-stock data, and close relevant earlier live gates. Repeat normalization, preview expiry/binding, transactional stock/history persistence, concurrent edits/purchases/adjustments, durable operation recovery across restart, cookie/CSRF/authorization, audit attribution, pagination links and staff walkthroughs against persistent FastAPI storage. Fixtures do not prove live inventory accuracy or duplicate prevention.

Source: Sections 6.3 (Phase 2 items), 6.8, 6.9, and 6.12.

## Post-Delivery Review Fixes

Purpose: Correct the defects found by the 2026-10-10 code review of the delivered Phase 1-5 frontend before Phase 6 starts. No new workflow is added.

- [x] Keep an unresolved save recoverable after its editor closes (Phases 2-5). Closing a menu, order, transaction or inventory editor while a save is unconfirmed now asks for confirmation. The exact request stays in memory, never in browser storage, so the page banner can check it and, after a 404, retry it with the original key/body. Previously the editor closed at once, the request was discarded, and a save that never reached the server left the whole area blocked with no in-app recovery. Reload or session end still clears the request, after which a missing operation requires operator reconciliation.
- [x] Open a saved delivery order after delivery is disabled (Phase 3). The editor shows a notice, offers only enabled methods and blocks review until one is chosen; new orders default to an offered method. Previously it formatted a null fixed charge and the whole application went blank.
- [x] Contain page rendering failures (Phase 1). The workspace content area shows a recoverable message with Try again, keeps navigation usable, and renders again on another route.
- [x] Accept zero stock written with fixed decimals (Phase 5). Saved-ingredient verification compares stock numerically, so `0` and `0.000` agree. Previously a new ingredient returned as `"0.000"` was reported as an unconfirmed save.
- [x] Evaluate session, quote and preview deadlines on the server clock (Phases 1, 3, 5). The API client follows each response's `Date` header. Previously a device clock 31 minutes ahead ended every new session at once, and six minutes ahead expired every quote or preview on arrival.
- [x] Add regression tests for each fix and update the [README](README.md), [API contract proposal](docs/phase-0/API_CONTRACT.md) and the Phase 1-5 verification records.

Backend dependency: Responses carry the standard `Date` header; a separate API origin must expose it through CORS, otherwise the device clock is used. No endpoint or payload changes.

Frontend verification: 11 new regression tests failed against a preserved copy of the pre-fix source while the existing 258 passed; all 269 tests in 23 files now pass, with type checking, the production build and all 40 Chromium checks. The fixes were written before their tests, so red was observed against the preserved pre-fix source rather than test-first; this departs from the strict TDD order above. Checks ran in a Linux copy of the workspace with a clean `npm ci`, because the workspace `node_modules` is a Windows install. Screenshot review and the uninstrumented fixture-preview walkthrough were not repeated. Evidence is in the review sections of the [Phase 1](docs/phase-1/VERIFICATION.md#post-delivery-review-fixes-2026-10-10), [Phase 2](docs/phase-2/VERIFICATION.md#post-delivery-review-fixes-2026-10-10), [Phase 3](docs/phase-3/VERIFICATION.md#post-delivery-review-fixes-2026-10-10), [Phase 4](docs/phase-4/VERIFICATION.md#post-delivery-review-fixes-2026-10-10) and [Phase 5](docs/phase-5/VERIFICATION.md#post-delivery-review-fixes-2026-10-10) records.

- [ ] Live completion gate: within the Phase 1-5 live gates, verify server-clock deadlines from real `Date` headers (including CORS exposure if a separate API origin is used) and the page-level identical-request retry against durable FastAPI operation storage.

## Phase 6: Recipes and Cost Estimates

Purpose: Turn menu variants and purchase history into understandable ingredient estimates.

- [x] Add recipe editing to Menu & Recipes for each sellable variant. Navigation reads Menu & Recipes when the menu, recipes and inventory capabilities are enabled; every variant links to a protected recipe page with an editor, dirty/history protection and explicit conflict review.
- [x] Make yield explicit for one tray, piece, stick, or package; enter each tray size independently. The page and editor state the exact selling unit; each variant has its own recipe and nothing is scaled between sizes. A recipe written for an earlier selling format is flagged and not estimated until saved for the current one.
- [x] Add ingredient selection, quantities, and compatible units with field validation. Searched, paginated inventory selection; one row per ingredient; grams/kilograms, millilitres/litres or whole pieces; retained backend field errors with focus.
- [x] Display backend-calculated selling price, ingredient cost, and ingredient contribution estimate separately. The frontend only displays the estimate; arithmetic exists solely in development fixtures. The contribution is labelled an ingredient estimate, not net profit.
- [x] Show the purchase dates/cost basis used and refresh estimates after recipe or price changes. Each ingredient shows its latest purchase date, receipt link, comparable unit cost and exact row amount; the estimate is reread after a recipe save and on each visit.
- [x] Mark missing recipes/prices as incomplete and link to the affected records. The menu marks variants without a recipe; the recipe page marks the estimate Incomplete, never zero, and links each unpriced ingredient. Estimate completeness is not shown in the menu list because the contract has no list-level estimate field.
- [ ] Collect actual recipes for live planning; distinguish sample recipes used during development. Development recipes are labelled as samples. Until actual recipes arrive, the fixture preview seeds lorem ipsum placeholders: four placeholder ingredients, one placeholder receipt and a one-unit recipe per provisional variant. Actual recipes must still be supplied by the business, so this task stays open.
- [ ] Complete the purchase-to-recipe walkthrough and staff review on desktop and phone. The developer walkthrough against the actual fixture preview is complete on desktop and phone; staff review is pending.

Backend dependency: Recipes/yields, compatible units, latest purchase cost basis, recalculated estimates, and incomplete-estimate information.

Product Phase 2 release check: Purchases update stock/history; recipes produce correct estimates. With the previous $12/kg example, 750 g contributes $9 to ingredient cost. Missing prices never appear as zero, and ingredient contribution is not labeled net profit.

Frontend verification: test-first red/green cycles; 306 passing tests across 27 files, 48 passing Chromium checks, type checking and production build. Verified the $9 completion example, kilogram/litre/piece normalization, total rounded once, latest business-date basis, recomputation after recipe/price/purchase changes, unknown versus zero cost, yield mismatch, validation and conflicts, reread-based recovery of unconfirmed saves, capability and live-settings gates, expiry, keyboard focus/navigation, 320/375/768/1280-pixel layouts and 200% text zoom. The actual fixture preview was exercised without interception. See the [Phase 6 verification record](docs/phase-6/VERIFICATION.md).

- [ ] Live completion gate: agree on the refined recipe/estimate contract, supply actual recipes and ingredient purchase prices, and close the relevant earlier live gates. Repeat yield/unit validation, version conflicts and raced creation, unrounded cost basis and single rounding, latest-basis selection, recomputation, incomplete estimates, cookie/CSRF/authorization and staff walkthroughs against persistent FastAPI storage. Fixture estimates do not prove live costing.

Source: Sections 6.7 (Phase 2 items), 6.11, 6.12, and Phase 2 completion.

## Phase 7: Preparation and Shopping

Purpose: Convert committed orders into remaining cooking quantities and practical shopping needs.

- [x] Add dashboard preparation summaries and links to preparation/shopping views. The dashboard shows what remains to prepare, ingredient shortages and incompleteness for its date, and links to Planning and the shopping list for that date.
- [x] Add date/range selection, food/variant grouping, contributing-order links, and ordered/prepared/remaining quantities. The period lives in the URL, defaults to the backend's business date, and stays valid when one end is moved past the other. Prepared quantities read 0 until preparation recording exists.
- [x] Apply agreed status eligibility so moving Confirmed orders to Preparing does not incorrectly remove their remaining demand. Confirmed, Preparing and Ready orders stay in demand; Pending, Completed and Cancelled do not. The frontend rejects a plan that lists any other status.
- [x] Show backend-calculated demand, stock after earlier commitments, and shortages without double-counting commitments. A negative stock after earlier commitments stays visible. The frontend checks every ingredient row against the register's formulas and refuses a plan that double-counts or hides a shortage.
- [x] Mark missing-recipe demand and the shopping list incomplete; link to recipe editors. Planning, the dashboard summary and the shopping list are marked Incomplete, state that quantities are a lower bound, and link each variant to its recipe page and affected orders. The warning is kept when the list is printed.
- [x] Build preparation entry for quantities prepared and actual ingredient consumption, with stock-deduction review. Staff choose remaining order lines from the plan, enter what was prepared and what was actually used, and review prepared counts, stock before and after, recipe versions and the estimated cost before anything is deducted. The saved record links to its orders and stock movements.
- [x] Show permitted edits/cancellation after partial preparation and required explicit stock corrections. Orders show prepared and remaining quantities, keep prepared lines in the editor, review what was prepared before cancelling with the consumed-stock acknowledgment, and can be marked ready without attestation once every line is prepared. Waste and correction movements are linked to their preparation, and a wrong prepared count is corrected in a reviewed form together with its stock adjustments, beside the unchanged record.
- [x] Reconcile uncertain preparation operations before retrying; refresh remaining demand and physical stock after confirmed success. An unconfirmed save locks the entry until its status is read; only the identical request may be retried, and only when no operation was recorded. Planning, orders and ingredients are read again after a recorded preparation.
- [x] Build printable shopping lists with the selected period, shortages, ingredient names, units, and readable page breaks. The list shows what to buy with physical stock, earlier commitments and this period's demand; printing hides navigation and actions, keeps the table header on each page and never splits a row.
- [ ] Complete partial-preparation, status-change, earlier-commitment, cancellation, repeated-request, print, and staff walkthroughs. All but the staff walkthrough are covered by automated checks and two walkthroughs of the fixture preview; the staff review needs people.

Backend dependency: Planning eligibility, remaining quantities, earlier commitments, shortages, preparation snapshots, exactly-once stock consumption, and explicit corrections.

Frontend verification so far: test-first red/green cycles; 380 passing tests across 33 files, 73 passing Chromium checks, type checking and production build. Verified status eligibility, earlier commitments counted once, negative stock after them, period and cumulative shortages, missing recipes in and before the period, period validation and the default business date, capability gates, inconsistent plans, preparation previews without effect, one stock deduction per operation key, stock bounds, changed versions, lost responses and the identical retry, limits on edits and cancellation after partial preparation, linked stock corrections, bounded corrections of prepared counts applied once, 320/375/768/1280-pixel layouts and 200% text zoom. The actual fixture preview was exercised without interception for planning and for preparation. See the [Phase 7 verification record](docs/phase-7/VERIFICATION.md).

Product Phase 3 release check: Staff can see what to cook and buy for a period. Pending/cancelled orders do not create outstanding demand; active remaining quantities stay visible across status changes. Partial preparation reduces demand correctly, repeated submissions deduct stock once, and cancellation never automatically restores consumed ingredients.

Source: Sections 6.3 (Phase 3 items), 6.10, 6.11, 6.12, and Phase 3 completion.

## First Work Package

Phases 1-6 frontend work are delivered: the foundation, maintainable food/variant menu, reservations, dashboard, fulfillment, deposits/refunds, print summaries, ingredients/stock movements, normalized purchases/price history and per-variant recipes/ingredient estimates are verified with explicit fixtures. The 2026-10-10 review fixes are applied and verified the same way. Two Phase 6 tasks stay open because they need the business: actual recipes and the staff review. Phase 7 is under way: the planning view, dashboard summary, printable shopping list, preparation recording with reconciliation, the order screens after partial preparation and corrections of prepared counts are delivered; the staff review remains. Complete Phase 0 confirmations and backend contract agreement, then repeat the open Phase 1-6 live checks and the order-pilot release check before real use. Actual recipes and costing agreement are required for the inventory/costing release.

Implementation artifacts are linked from completed tasks. Phase 0 definition/sketch tasks are complete when their artifacts have been written and reviewed; confirmation/agreement tasks require explicit evidence. For phases 1-7, mark frontend tasks complete only after the corresponding behavior has been implemented and verified, following strict TDD for code changes. Keep a separate live completion gate open until backend integration and real-use requirements have been verified.
