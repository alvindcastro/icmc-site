# Phase 3 Verification

Date: 2026-10-07. Frontend delivered against explicit development fixtures. Live FastAPI verification remains pending; no backend exists in this workspace. No commit was created.

## Plan Review

- Phase 3 requires confirmation even though the transition endpoint was listed under Phase 4. Reuse that endpoint for reviewed Pending -> Confirmed only; no later status/payment actions were introduced.
- Totals must come from matched, unexpired quotes. Frontend does not calculate line/subtotal/tax totals; exact BigInt calculations and Temporal DST resolution live only in the excluded development fixture transport.
- Editing existing lines must not rebuild prices or identities from current menu data. Retained snapshots, unavailable-line decreases, used-unit immutability, dependency changes, and two-staff version conflicts are exercised.
- Business settings/menu confirmation and durable operation storage are not supplied. Keep their live gates open, prevent unconfirmed live reservations, and never treat mocked deduplication as backend transaction proof.

## Delivered Scope

Orders and Dashboard are protected, capability-gated routes. Order search/date/status/sort/page state is in the URL, with in-memory scroll restoration and retained return routes after editing. Lists/details have independent preparation/payment statuses, loading/empty/no-results/retry states, exact amounts, snapshot lines, customer/fulfillment notes, and dated staff history.

The entry dialog groups customer, fulfillment, items, and totals. It supports available-menu search, repeated variants, quantities/notes/removal, conditional delivery address, manual or fixed configured delivery charges, configured-currency tax entry, and server-resolved DST occurrences. Entry changes immediately clear quoted totals; late responses, quote expiry, field errors, and stale dependencies cannot become a current review. Saved pending orders require a separate confirmation review. Edits require permitted actions and preserve agreed snapshots; explicit latest-record review is required after conflict, without discarding the draft or auto-saving.

Dirty drafts warn on dismissal/reload/history navigation. Radix handles focus trapping; React Router's data router handles navigation blocking. Submission is guarded synchronously as well as through disabled controls. Only the unresolved operation UUID survives draft/session loss. Check status uses read-only bounded backoff for processing; unknown status permits only an explicit exact request/key retry when the in-memory attempt survives. Reconciliation is aborted on unmount/session end, and confirmed outcomes refresh the current record. Backend-requested customer credit requires acknowledgment before an edited save; payment/refund entry remains Phase 4.

## Observed TDD

Tests preceded behavior changes; behavioral failures were observed before implementation. Importable validator/polling stubs provided only a testable boundary. Harness/type/setup failures were not counted as behavioral red.

| Cycle | Observed Red | Green Result |
|---|---|---|
| Order contract | Initial six tests failed because order endpoints/capability were absent | Quotes, snapshots, creation/edit/confirmation, filters/dashboard, DST, version conflicts and shared operation replay passed. |
| Unknown request fields | One failed, seven passed: an unexpected quote field was accepted | Strict structured field validation; eight fixture tests passed. |
| Response boundaries | Seventeen failed, one passed: invalid money/status/snapshot/quote/operation responses were accepted | Eighteen response-validation tests passed. |
| Reservation UI | Seven failed after correcting signed-in seeding: protected order routes/screens were absent | Seven entry/review/details/filter/dashboard/conflict/recovery tests passed. |
| History guard | Chromium expected Leave order?, but browser Back navigated without a decision | Data-router guard passed; stay retains the draft, leave requires explicit action. |
| Safety and focus | Two failed, thirteen passed: invalidating an in-flight quote left focus blocked; unconfirmed live settings remained usable. Keyboard browser checks separately failed opening and return focus. | Reset obsolete loading state, fail closed, set/restore dialog focus. Fifteen UI tests and keyboard check passed. |
| Quote/session races | Two failed, eighteen passed: a quote for another date was accepted; late reconciliation cleared a UUID after logout | Match draft fulfillment and ignore/abort late recovery; twenty UI tests passed. |
| Processing/dashboard links | Three polling tests and one dashboard-link test failed | Bounded GET-only backoff, cancellation, and collection-specific business-date/status links passed. |
| Review/zoom | Review heading was offscreen; snapshot name occupied 224 of 560 pixels at text zoom; Quantity split within its label track | Reset review scroll, stacked snapshot rows, font-relative label tracks. Browser regressions passed. |
| Notes/zero amounts | Missing notes returned undefined, oversized/type-invalid fields were accepted, zero settlement was Unpaid | Normalize and bound text; derive payment status from authoritative settlement. Eleven fixture tests passed. |
| Return destinations | Refreshed edited details lost query state; dashboard-created order returned to Orders | Preserve detail location state and pass the origin on creation; both tests passed. |

Tests were strengthened where an early assertion ran before the refreshed record. Non-behavioral corrections included complete fixture Order typing, UUID parameter typing, selecting repeated package text, and matching a table row header rather than its combined child text.

## Final Verification

- [x] `npm test -- --reporter=dot`: 152 tests in 14 files passed, including production fixture/account exclusion.
- [x] `npm run typecheck`: passed.
- [x] `npm run build`: passed; fixture order/menu data and Temporal logic excluded from production.
- [x] `npm run test:e2e`: 23 Chromium checks passed (8 foundation, 6 menu, 9 reservations/dashboard).
- [x] Browser widths 320/375/768/1280, long names/notes, maximum safe monetary amount, 200% text zoom, keyboard focus/trap/return, dirty history navigation, real list scroll return, and snapshots after menu changes checked. Screenshots inspected from ignored `test-results/`.
- [x] Actual fixture preview at `http://127.0.0.1:5173` exercised without interception: admin/token login, first-error focus, $215 review/confirmation, $135 retained-price edit, dashboard date/return, desktop/320-pixel layouts, completed sign-out and empty browser storage; no page errors. Sign-out cleanup was checked after the remote fixture acknowledgment, not while its expected pending marker remained.
- [x] All eleven Phase 3 frontend tasks checked; next implementation package is Phase 4. Global rules and live gates remain open where future phases/backend verification are required.
- [x] No git commit created.

The jsdom scroll warning is a platform limitation; real scroll restoration is verified in Chromium. Fixtures, browser interception, and the actual fixture preview do not prove live persistence, authorization, CSRF enforcement, atomic versioning, durable snapshots, or duplicate prevention.

## Post-Delivery Review Fixes (2026-10-10)

A code review of the delivered Phase 1-5 frontend found three reservation defects. The fixes were written first; their regression tests were then observed red against a preserved copy of the pre-fix source, so this was not test-first.

| Fix | Observed Red (pre-fix source) | Green Result |
|---|---|---|
| Unresolved order save after its editor closes | Escape during an unconfirmed order save closed the editor with no confirmation; the request was discarded and New order stayed blocked behind a lookup that could only return 404 | Closing asks for confirmation. After discarding, the exact request stays in memory; Check save status followed by Retry identical save sends the same key and body once more, opens the saved order and clears the marker. |
| Saved delivery order after delivery is disabled | Edit order threw `Invalid monetary amount or precision.` while formatting a null fixed charge, and the whole application went blank | The editor opens with a notice, offers only enabled methods, shows no delivery-charge field and blocks review until another method is chosen. New orders default to an offered method. |
| Quote deadline on the server clock | With the device clock six minutes ahead of the server every quote was treated as expired on arrival, so the review never opened | Quote arrival, the expiry timer and the save check use the server-relative time; the order is reviewed and saved. |

Only the operation UUID is kept in browser storage, as before; the retained request lives in protected memory and is cleared by reload or the end of the session. Combined results after all review fixes are recorded in the [plan](../../FRONTEND_IMPLEMENTATION_PLAN.md#post-delivery-review-fixes). Committed on 2026-10-10 in the repository's initial commit.

## Date-Dependent Tests (2026-10-11)

Two unit tests passed only while the business date was 2026-10-10, the date of their sample order, and failed in CI the day after: "filters list state, returns from details, and groups dashboard by the selected business date" here and "validates, reviews and records a deposit" in the Phase 4 suite. Both cleared the Dashboard date field and then typed a date. Clearing that field is defined to fall back to today's business date, so the field was never empty and the typed date was not accepted; on 2026-10-10 the fallback happened to be the date they wanted.

The tests now set the date with one change event, as a browser's date field does and as the planning tests already did. No application code changed. Observed red: both failed on 2026-10-11, in CI and locally. Green: 382 unit tests in 33 files and 73 Chromium checks pass on 2026-10-11. No other test in either suite failed with the date change; the suite has not been run under any other simulated date.

## Live Verification Against the Local Backend (2026-10-11)

Backend Phase B3 delivered orders, quotes and the dashboard, so the Phase 3 screens were run in live mode against the real FastAPI server through the development proxy, with no interception. The steps and results are in the [backend Phase B3 record](../../../backend/docs/phase-3/VERIFICATION.md#live-verification); the script is `.playwright/phase3-live.mjs`.

Seen working in the browser: two trays and a package quoted and saved at 215.00; the saved order unchanged after the menu's price, name and availability were changed; two browsers editing one order, with the later save refused, its draft kept, and the conflict resolved by explicit review; the agreed line price kept through both edits; an order saved as pending and confirmed as a separate step; search; the dashboard for a chosen business date; a repeated hour resolved by the chosen offset and a skipped hour refused. No frontend change was needed.

Because the backend does not serve Phase 4 yet, it reports the later fulfillment steps, cancellation and payments as unavailable on every order, each with a reason. How the order page presents those reasons was not reviewed in this run.

Covered by the backend's own tests rather than the browser: stale and expired quotes at the save, a lost answer on an order save, live settings with unconfirmed values, and delivery orders.

Still open for this gate: agreement on the refined contract, the business and menu confirmations, and a staff walkthrough. Nothing was run on Windows.

## Live Handoff

- [ ] Agree on order/quote/confirmation/operation refinements and confirm business currency/timezone, fulfillment/charge/tax policies, menu transcription, and staff provisioning.
- [ ] Verify persistent quotes bind exact drafts/settings/new menu dependencies, expire, and revalidate atomically.
- [ ] Repeat the $215 order, menu price/name/availability changes, retained $80 snapshots, unavailable-line restrictions, used-unit immutability, and two-staff conflict against FastAPI.
- [ ] Verify durable operation admission/result recovery across timeouts, processing, delayed requests, restart, 404, session expiry, and replay.
- [ ] Verify business-time list/dashboard grouping, DST, backend permissions, cookie/CSRF/authorization, and a staff walkthrough.
- [ ] Deliver and verify Phase 4 fulfillment/payment/refund/printing workflows before calling this a daily-work pilot.
