# Phase 1 Implementation and Verification

Date: 2026-10-07. Frontend implementation: delivered. Live completion gate: pending; no FastAPI backend exists in this workspace. No commit was created.

## Plan Review and Scope

The [plan](../../FRONTEND_IMPLEMENTATION_PLAN.md) permits explicit fixtures while Phase 0 agreements are pending. Phase 1 delivers only the foundation: the protected Workspace and My account routes, sign-in, settings display, shared controls, and responsive navigation. Dashboard/order/menu workflows belong to later phases and are not exposed prematurely. Quantities, availability controls, and table/phone list components will be added when a delivered screen needs them.

The auth/settings proposals remain the implementation baseline, with live acceptance still required. Review identified two session hazards worth explicit coverage: protected responses arriving after sign-out, and uncertain remote sign-out surviving a reload. Both are implemented without exposing retained staff/settings data. Final review also added regressions for obsolete CSRF requests and missing business timezones.

## Strict TDD Record

Harness/configuration and minimal export/component stubs were established first. Tests were written before the corresponding runtime behavior. Setup/tool failures were resolved and were not counted as behavioral red results.

| Cycle | Red command / observed failure | Implementation | Green verification |
|---|---|---|---|
| API configuration and formatting | `npm test -- tests/config.test.ts tests/format.test.ts`: 9 failed, 4 passed; defaults/fixture gates and formatter results missing | Explicit live default, development-only fixture gate, exact minor-unit formatting, business/calendar time, status labels | 13 tests passed in next combined run |
| API boundary | `npm test -- tests/config.test.ts tests/format.test.ts tests/client.test.ts`: 7 API tests failed, 13 passed | Cookie credentials, CSRF, operation ID headers, error envelope, expiry notification, no automatic retries | 20 tests passed in next combined run |
| Fixtures and session/UI | `npm test -- --reporter=dot`: 11 fixture/session/UI tests failed, 20 passed; auth form and fixture behavior absent | Fixture auth/settings, protected routing, retained failures, session cleanup, return routes, sign-out reconciliation | 31 tests passed |
| Local image | `npm run test:e2e -- --grep "renders assets.*320"`: failed because natural image width was 0 | Local illustrative food image and attribution | Image loaded in next run |
| Responsive presentation | Same 320-pixel browser command: failed on horizontal overflow after the image loaded | Stable image dimensions, phone/desktop shell, shared tokens, focus and form styling | All 8 browser tests passed; screenshots reviewed |
| Session-boundary regressions | `npm test -- tests/client.test.ts tests/app.test.ts --reporter=dot`: 2 failed, 17 passed; obsolete CSRF allowed submission and missing timezone used browser time | Credential generation check; reject missing business timezone | Included in final 35 passing tests |
| Production fixture exclusion | `npm test -- tests/production.test.ts --reporter=dot`: 1 failed after harness correction; fixture credentials present in build | Compile-time development guard removes fixture module from production | Production exclusion test passed |

An additional sign-in pending/duplicate-submission test passed against the already-tested pending implementation. Type checking caught unsupported Testing Library selector options; removing those options preserved the existing passing behavior. No test failures were hidden or skipped.

### Temporary Admin/Token Update

User requested temporary `admin`/token login after Phase 1 delivery. Tests were changed first to require prefilled `admin`, token visibility/validation, `{username, token}` requests, rejection of the previous credentials/other accounts, no browser token persistence, and fixture-token exclusion from production. `npm test -- tests/app.test.tsx tests/fixtures.test.ts --reporter=dot` produced 13 behavioral failures and 2 passes before implementation.

After implementation, 36 tests passed and one new server-field-error test exposed focus being attempted while the input was disabled. Moving invalid-field focus until pending submission finished made all 37 tests pass. Type checking, production build, and all 8 updated Chromium checks also pass. The temporary fixture token is `local-admin-token`; the live backend contract now accepts a token and still requires backend implementation/verification.

An additional Chromium check against the actual fixture preview, without API interception, confirmed prefilled `admin`, token sign-in, return to My account, workspace settings, and phone-menu sign-out. Desktop and phone screenshots were captured, and the phone layout was visually reviewed.

## Final Checks

- [x] `npm test -- --reporter=dot`: 37 tests in 6 files passed.
- [x] `npm run typecheck`: passed.
- [x] `npm run build`: passed; fixture transport/accounts excluded from production JavaScript.
- [x] `npm run test:e2e`: 8 Chromium tests passed against explicitly intercepted auth/settings responses.
- [x] Desktop/320-pixel sign-in and workspace screenshots visually reviewed; readable layout and loaded image.
- [x] Browser asset/overflow checks at 320, 375, 768, and 1280 pixels with long staff names; 200% text zoom checked.
- [x] Keyboard sign-in/expiry/sign-out and phone-dialog focus trapping/return verified.
- [x] Protected state and late responses cleared; uncertain sign-out blocks reentry after reload; no mutation replay after sign-in.
- [x] Actual fixture-mode preview at `http://127.0.0.1:5173`: sign-in, return to My account, provisional settings, desktop/phone screenshots, and phone-menu sign-out passed without browser API interception.
- [x] Repeat sign-in/session/settings/expiry/sign-out checks against the implemented FastAPI backend. Done on 2026-10-10 against the local server; see [Live Verification](#live-verification-against-the-local-backend-2026-10-10).
- [ ] Confirm actual staff accounts, business settings, and auth/settings agreement from Phase 0.
- [ ] Perform live server-cookie/CSRF/authorization checks and the staff walkthrough before real use. The cookie, CSRF and Origin checks passed against the local server on 2026-10-10; the staff walkthrough has not happened.

Fixtures and browser interception verify the frontend's proposed contract behavior only. They do not prove server authentication, password handling, secure cookie settings, persistence, or live authorization. The separate live completion gate remains open in the plan.

## Post-Delivery Review Fixes (2026-10-10)

A code review of the delivered Phase 1-5 frontend found two foundation defects. The fixes were written first; their regression tests were then observed red against a preserved copy of the pre-fix source, so this was not test-first.

| Fix | Observed Red (pre-fix source) | Green Result |
|---|---|---|
| Server-clock deadlines | `client.now is not a function`; with the device clock 31 minutes ahead of the server, sign-in returned to "Your session expired. Sign in to continue." | The API client follows each response's `Date` header and exposes the server-relative time; session expiry checks and the expiry timer use it. A valid session survives the skewed device clock. Without a `Date` header the device clock is used as before. |
| Contained rendering failure | A page that threw while rendering showed no recoverable message; React reported an uncaught error in the page component and removed the application | The shell wraps the page area in an error boundary: a recoverable message with Try again, navigation still usable, and a fresh render on another route. |

Combined results after all review fixes (269 tests in 23 files, type checking, build, 40 Chromium checks) are recorded in the [plan](../../FRONTEND_IMPLEMENTATION_PLAN.md#post-delivery-review-fixes). Real `Date` headers, including CORS exposure for a separate API origin, join the open live checks. Committed on 2026-10-10 in the repository's initial commit.

## Live Verification Against the Local Backend (2026-10-10)

Backend Phase B1 delivered sign-in, sessions and settings, so the Phase 1 screens were run in live mode against the real FastAPI server through the development proxy, with no interception. The steps and results are in the [backend Phase B1 record](../../../backend/docs/phase-1/VERIFICATION.md#live-verification); the script is `.playwright/phase1-live.mjs`. In short: return route, wrong token, keyboard-only sign-in, an `HttpOnly` cookie the page cannot read, a session that survives reload, provisional settings from the server, no unreleased workflow links, CSRF and Origin enforced by the server, a dropped sign-out answer recovered by Retry sign-out, idle expiry announced and cleared, and the sign-in lock after five failures all behaved as designed.

One defect surfaced and is fixed. The API client kept its CSRF token after the server refused it, so a sign-in page left open longer than the server's pre-auth session could not sign in without a reload. Fixtures never showed this because their token does not expire.

| Fix | Observed Red | Green Result |
|---|---|---|
| Forget a refused CSRF token | `npx vitest run tests/client.test.ts`: 1 failed, 10 passed; after a 403 `csrf_invalid` the next attempt sent the same stale token | The client drops the token it sent when the server refuses it, and the next attempt fetches a new one. Nothing is resent automatically, and a newer token set meanwhile is kept. 11 passed; full suite 382 tests in 33 files, type check, build and 73 Chromium checks pass. |

The fixture's `csrf_invalid` message was changed with the server's to "The security token for this page is out of date. Try again."

Still open for this gate: the business confirmations and auth agreement from Phase 0, and a staff walkthrough. Expiry during a save waits for the first live save endpoint in backend Phase B2. Nothing was run on Windows.

## Entry Points

| File | Responsibility |
|---|---|
| [main.tsx](../../src/main.tsx) | Select explicit API mode and mount React/router |
| [client.ts](../../src/api/client.ts) | Cookie/CSRF requests, errors, cancellation, server-clock offset, no retry queue |
| [session.tsx](../../src/auth/session.tsx) | Session lifecycle, settings, expiry, protected cleanup, remote sign-out reconciliation |
| [SignIn.tsx](../../src/pages/SignIn.tsx) | Labeled credentials, visibility, validation, pending/error/retry states |
| [Shell.tsx](../../src/components/Shell.tsx) | Delivered desktop navigation, accessible phone drawer and page error boundary |
| [format.ts](../../src/lib/format.ts) | Configured money/date/status display |

Run and WebStorm instructions are in [README](../../README.md). The local preview uses explicit fixtures and synthetic credentials.
