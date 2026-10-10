# Phase 4 Verification

Date: 2026-10-07. Frontend delivered against explicit development fixtures. Live FastAPI integration, business confirmations, backup/restore readiness, and real staff acceptance remain pending. No commit was created.

## Plan Review

- The Phase 4 pilot must remain usable before Phase 7 preparation recording. Keep manual quantities null, require human readiness/fulfillment attestation, and never deduct or restore stock. Completion does not require full payment.
- Sequential fulfillment and cancellation are distinct from settlement. Cancellation keeps original item totals/history, sets collectible settlement to zero, and makes retained funds credit due until separately refunded.
- Refund selection needs a backend-provided original-payment cap, and recorded consumption needs a backend-provided cancellation-acknowledgment flag. The proposed ledger/Order contract now specifies both. Actual backend agreement remains open.
- Payment/refund success and operation lookup return `{entry, order}`, not a raw Order. Validate identities, operation UUID, amount/metadata, version, ledger consistency, and settlement before reporting success; reread the current Order afterward.
- The plan's real-use release check cannot close from fixtures. Durable deduplication, concurrent transactions, authorization/CSRF, confirmed selling data, staff devices/usability, and backup/restore still require live evidence.

## Delivered Scope

Details offer the next permitted fulfillment action, cancellation, payments/refunds when enabled, and printing. Forbidden actions have visible explanations. Each status command reviews saved details; Ready/Completed require an attestation. Cancellation requires a reason, preserves payments, and respects backend-requested consumed-stock acknowledgment without introducing inventory/preparation workflows.

Payment/refund entry has exact configured minor-unit amounts, a backend business-date default, enabled methods, reference/note, original payment and required refund reason. Review precedes submission. Frontend limits use backend amounts/caps; authoritative field errors focus the first invalid control and preserve input. Conflicts retain the draft, show the latest complete order, and require explicit version review plus a new financial review. An unverifiable latest record blocks submission. Missing/invalid payment methods disable finance with an explicit settings retry while leaving fulfillment usable.

The append-only ledger shows payments and refunds separately with dates, method/reference, notes/reason, actor, and audit time. Deposits refresh detail/list/dashboard balances. Reducing a $215 order after a $180 deposit to $150 requires acknowledgment of $30 credit; a separate $30 refund makes it Paid. Cancelling retains funds as credit; a separate remaining refund settles that credit. Unpaid completion and outstanding completed-order payments remain allowed.

One UUID and immutable in-memory request identify each attempt. Pending controls and synchronous guards prevent duplicate submission. Unknown/malformed results freeze editing/submission until bounded read-only status reconciliation. An unrecorded attempt permits only an explicit exact-body/key retry. Expiry clears sensitive drafts and retains only the UUID; re-login never replays a mutation. Late responses cannot clear a marker or restore protected state after session end. Recovery handles wrapped financial successes and fetches the current record.

The protected print view verifies the requested order ID and saved snapshot, includes customer/contact/notes, local fulfillment/timezone/location, item quantities/units/prices/notes, statuses, totals, balance/credit, and cancellation reason. It preserves filtered-list return state. Print CSS hides navigation/actions, keeps item tables at phone widths, repeats headers, and avoids splitting item rows/totals where possible. It does not print a current-menu reconstruction.

## Observed TDD

Behavioral tests preceded implementation. Missing response exports used importable throw stubs only to expose the test boundary. Harness/setup/type failures were corrected separately and not treated as feature red.

| Cycle | Observed Red | Green Result |
|---|---|---|
| Status/ledger contract | Eight failures: payment capability and endpoints were absent | Sequential transitions, cancellation, deposits/refunds, credit/limits, operation replay, and two-staff payments passed. |
| Financial response boundaries | Fourteen failures: ledger/result validation was absent or accepted malformed data | Complete wrappers, ledger identity/amount/date/audit/aggregate checks and operation UUID matching passed. |
| Fulfillment/financial UI | Nine failures: commands, dialogs, ledger, and print route were absent | Deposits, refunds, cancellation, manual fulfillment, conflicts, exact retries, protected print return, capability hiding, and expiry recovery passed. |
| Safety/review | Missing initial focus, date/method dirty tracking, response-version matching, and invalid-conflict blocking; audit actors depended on JSON key order | Focus/dirty guards, matched mutation versions, blocked unverifiable conflicts, and structural audit comparison passed. |
| Preparation focus | Confirmation retained focus outside its dialog | Preparation-start command receives focus; Ready/Completed focus the attestation. |
| Edit/payment race | With calculation deliberately paused, an old-version edit accepted a deposit arriving before commit | Commit rechecks expected version and preserves the committed payment/current balance. |
| Native print | At 320/375/768 pixels item cells printed as grids | Print-specific table-cell overrides passed at all four widths; an A4 PDF was generated. |
| Method labels | Bank transfer option exposed its wire enum | Readable method labels in entry, review, and ledger passed. |
| Print identity/return | Wrong-ID Order could print; list filters disappeared after print return | Matching-ID reads, disabled/recoverable print failures, and retained return state passed. |
| Payment settings | Four failures: missing/null method settings crashed details; empty/unsupported methods had no retry | Finance fails closed, explicit reload recovers, and fulfillment remains available. |
| Accessible errors | Method/consumed-stock errors lacked accessible descriptions | First-invalid focus and associated descriptions passed. |

Browser harness corrections waited for refreshed state/recovery cleanup and a dismissed nested navigation dialog, supplied an in-app history entry, and scoped repeated status text to its table. The existing scroll test now chooses the actual tenth row: equal-time fixture orders sort by random IDs, so assuming DEV-0010 was below the fold was nondeterministic. The actual-preview capture waits for the saved version rather than photographing its loading state.

## Final Verification

- [x] `npm test -- --reporter=dot`: 201 tests in 18 files passed, including production exclusion of fixture accounts/menu/order/ledger data.
- [x] `npm run typecheck`: passed.
- [x] `npm run build`: passed; fixture data and fixture-only Temporal calculations excluded.
- [x] `npm run test:e2e`: 31 Chromium checks passed (8 foundation, 6 menu, 9 reservations/dashboard, 8 fulfillment/finance/print).
- [x] 320/375/768/1280-pixel layouts, long references/reasons/notes, maximum safe monetary amounts, 200% text zoom, keyboard focus/trap/return, dirty history protection, expiry/recovery, and print emulation checked; screenshots inspected from ignored `test-results/`.
- [x] Actual fixture preview at `http://127.0.0.1:5173` exercised without interception: admin/token login, Pending -> Confirmed, $180 deposit, $150 credit edit/$30 refund, print, 375-pixel cancellation/$150 remaining refund, a separate unpaid fulfillment through Completed, and completed sign-out with empty storage/no page errors.
- [x] Nine Phase 4 frontend tasks checked; Phase 5 is the next implementation package. Real staff acceptance is explicitly separate from the developer fixture walkthrough.
- [x] No code commit created.

The jsdom scroll warning is a platform limitation; Chromium verifies real scroll restoration. Fixture success and browser interception do not prove persistent transactions, backend authorization, durable operation admission, duplicate prevention across restart, or real staff/printer acceptance.

## Post-Delivery Review Fixes (2026-10-10)

A code review of the delivered Phase 1-5 frontend found one defect in the status/financial dialog. The fix was written first; its regression test was then observed red against a preserved copy of the pre-fix source, so this was not test-first.

| Fix | Observed Red (pre-fix source) | Green Result |
|---|---|---|
| Unresolved transaction after its dialog closes | Escape during an unconfirmed payment closed the dialog with no confirmation; the request was discarded and every order action stayed blocked behind a lookup that could only return 404 | Closing asks for confirmation. After discarding, the exact request stays in memory; Check save status followed by Retry identical save sends the same key and body once more, records one payment (Version 2) and clears the marker. |

The financial draft is still never written to browser storage; the retained request lives in protected memory and is cleared by reload or the end of the session. The same change covers status transitions and cancellation, which share the dialog. Combined results after all review fixes are recorded in the [plan](../../FRONTEND_IMPLEMENTATION_PLAN.md#post-delivery-review-fixes). Committed on 2026-10-10 in the repository's initial commit.

## Live Handoff

- [ ] Close Phase 0 confirmations and the Phase 1-3 live gates; accept the refined status/ledger/history/operation schema with the backend maintainer.
- [ ] Verify persistent sequential statuses, cancellation reasons/permissions, manual versus recorded preparation rules, and retained consumption/ledger data.
- [ ] Repeat payment/refund bounds, original-payment caps, credit edits, cancellation settlement, and concurrent edit/payment/refund scenarios against transactional FastAPI storage.
- [ ] Verify one durable effect per operation across delayed/repeated requests, timeouts, malformed replies, processing, restart, 404, session expiry, and explicit same-key retries.
- [ ] Verify cookie sessions, CSRF/authorization, actor attribution, protected-data cleanup, and current detail/list/dashboard/print reads against the live backend.
- [ ] Obtain real staff usability approval and test printing on their desktop/phone/printer, including long multipage orders.
- [ ] Verify backend backup/restore readiness before permitting real pilot data. Development fixtures are memory-only and intentionally reset on reload.
