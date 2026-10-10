# Phase 2 Implementation and Verification

Date: 2026-10-07. Frontend delivered against explicit development fixtures. Live FastAPI verification remains pending; no backend exists in this workspace. No commit was created.

## Plan Review

The plan permits provisional development fixtures before backend agreement. Phase 2 adds only Menu: search, category/food-availability filters, URL pagination, food fields, multiple variant editors, four selling units, exact configured-currency prices, package contents, and availability. Unavailable records remain editable. Recipe/order workflows remain hidden until their phases.

Review identified three contract gaps that are now documented proposals, not claims of backend implementation:

- Menu creates need durable operation keys/status lookup to resolve a lost response without duplicate foods/variants. The shared operation protocol now includes menu saves. Only UUIDs survive reload/expiry; protected drafts do not. A missing result after draft loss requires backend/operator reconciliation.
- Food and variant actions need named permissions. Food responses expose `edit`/`add_variant`; variants expose `edit`. Capability/action controls are respected, but authorization remains server-side.
- Nested variant changes advance their parent food aggregate version. Editors require explicit current-record review after a conflict; returned versions are never synthesized or automatically resubmitted.

Fixture examples use the provisional transcription prices for Beef Caldereta, Fresh Lumpia, and Shanghai. A clearly named synthetic development skewer demonstrates sticks without inventing either unresolved Pork BBQ option. No live seed or confirmation control is installed. Recipe IDs remain null.

## Strict TDD Record

Tests preceded runtime behavior. Minimal export stubs were used only to establish importable test harnesses. Tool/setup/type issues were not counted as behavioral red results.

| Cycle | Observed red | Implementation / green |
|---|---|---|
| Exact money/units and menu contract | `npm test -- tests/menu-model.test.ts tests/menu-fixtures.test.ts --reporter=dot`: 6 failed, 9 passed; units/prices and menu endpoints absent | Exact BigInt input conversion, four units, fixture CRUD/filtering/pagination/validation/versioning/operation lookup; 15 passed. One test was corrected to read the current parent version after changing a variant. |
| Staff workflow | Combined menu test run: 7 UI tests failed, 15 contract/model tests passed; protected menu return/screens absent | Capability-gated route/nav, list and editors, retained errors, dirty protection, conflict review, and uncertain-result checks. A duplicate Clear filters action found during green verification was removed; all 22 passed. |
| Phone layout and keyboard focus | `npm run test:e2e -- --grep 'menu editor.*320'`: horizontal overflow. `--grep 'menu keyboard'`: close button had focus instead of first field | Responsive table/phone rows, constrained scrollable dialog, first-field focus, and focus return. All 6 menu Chromium tests passed. |
| Returned-record validation | Menu UI suite: 2 failed, 11 passed; blank server names accepted and malformed saves claimed success. Response suite: 29 failed, 1 passed against stubs | Validate categories, pages, food/variant identities, money/contents/actions, and operation results before display/confirmation. Combined suites: 43 passed. |
| Review regressions | Resource-permission test failed because IconButton replaced the backend reason. 320-pixel browser test failed because variant label retained desktop 25% width | Preserve supplied tooltip title; remove inherited width in phone rows. Included in final 98 unit/component/build and 14 browser passes. |

Additional passing regression tests cover disabled capability/no requests, exact-body/key retries after 404, read-only recovery after remount, expiry without draft retention/replay, all category pages, URL page resets, and obsolete list responses. Existing auth/session/CSRF and production-exclusion tests also pass. No failing tests were hidden or skipped in the final run.

## Final Checks

- [x] `npm test -- --reporter=dot`: 98 tests in 10 files passed.
- [x] `npm run typecheck`: passed.
- [x] `npm run build`: passed; fixture credentials/menu IDs/examples excluded from production JavaScript by a build regression test.
- [x] `npm run test:e2e`: all 14 Chromium checks passed (8 foundation, 6 menu).
- [x] Food and multiple-variant creation, edit/price/availability changes, field validation, retained errors, conflict resolution, and save reconciliation checked against the fixture contract.
- [x] Phone/tablet/desktop and editor screenshots reviewed; no document overflow at 320/375/768/1280 pixels, including long names and maximum safe prices.
- [x] Keyboard dialog focus trapping/return, dirty close/discard, and 200% text zoom checked.
- [x] Protected draft cleanup, late response isolation, no automatic mutation replay, and unresolved-operation blocking checked.
- [x] Actual fixture preview at `http://127.0.0.1:5173/menu`, without API interception: admin/token login, food creation, tray/package variants, price and food/variant availability edits, search, phone editor, and sign-out passed without browser errors. Desktop/phone/editor screenshots were captured and reviewed.
- [ ] Actual FastAPI persistence/auth/CSRF/authorization, durable deduplication/lookups, used selling-identity restrictions, confirmation resetting, and staff walkthrough.
- [ ] Business currency, menu transcription/package-rule confirmations, and backend agreement on the refined contract.

Browser tests intercept requests with deterministic development responses; they do not prove live authorization, transactions, persistence, or duplicate prevention. Historical order snapshots cannot be verified until Phase 3.

## Post-Delivery Review Fixes (2026-10-10)

A code review of the delivered Phase 1-5 frontend found one menu defect. The fix was written first; its regression test was then observed red against a preserved copy of the pre-fix source, so this was not test-first.

| Fix | Observed Red (pre-fix source) | Green Result |
|---|---|---|
| Unresolved save after its editor closes | Escape during an unconfirmed food save closed the editor with no confirmation. The request was discarded, so a save that never reached the server left every menu action blocked behind a lookup that could only return 404 | Closing asks for confirmation and Keep editing returns to the frozen draft. After discarding, the exact request stays in memory; Check previous save followed by Retry original save sends the same key and body once more, confirms the food and clears the marker. |

This supersedes the plan-review note above that a missing result after draft loss always needs operator reconciliation: that now applies only after a reload or the end of the session, which clear the in-memory request. Browser storage still holds only the operation UUID. Combined results after all review fixes are recorded in the [plan](../../FRONTEND_IMPLEMENTATION_PLAN.md#post-delivery-review-fixes). Committed on 2026-10-10 in the repository's initial commit.

## Entry Points

| File | Responsibility |
|---|---|
| [MenuPage.tsx](../../src/menu/MenuPage.tsx) | Capability gate, list/query state, responsive rows, pending-operation recovery |
| [Editor.tsx](../../src/menu/Editor.tsx) | Food/variant forms, validation, dirty protection, version review, save status/retry |
| [model.ts](../../src/menu/model.ts) | Exact price input and explicit selling quantity labels |
| [responses.ts](../../src/menu/responses.ts) | Runtime validation of returned records/pages/operations |
| [menu-fixtures.ts](../../src/api/menu-fixtures.ts) | Explicit development-only provisional menu contract simulation |
| [pending.ts](../../src/api/pending.ts) | In-memory retention of the exact unresolved request, shared by menu, order and inventory saves |

Run and live backend requirements are in [README](../../README.md).
