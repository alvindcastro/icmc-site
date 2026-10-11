# Phase B4 Verification

Date: 2026-10-11. Phase B4 delivered: all 10 tasks are complete. Not committed at the time of writing.

## Plan Review

- No decision was open for this phase.
- Phase B3 reported five order actions as blocked because the server could not perform them. This phase performs them, so each is now allowed or blocked by the order's own state.
- The credit acknowledgment on an edit, written in Phase B3 without a test, is now tested.
- The plan asks for the cancellation acknowledgment "when recorded consumption exists". Preparation recording is Phase B7, so no order has consumption yet. The field is required and must be a boolean; false is accepted.
- The completion check ends with a condition this phase cannot meet: backup and restore must be verified before real payments are entered. That belongs to Phase B8 and is not done.

## Delivered Scope

**Fulfillment steps.** `POST /orders/{id}/transitions` moves an order one step: Pending, Confirmed, Preparing, Ready, Completed. Any other target is 409 `action_not_allowed`. Each step is a dated history event with the actor. While preparation recording is off, Ready and Completed need nothing but the request, and completion does not depend on payment.

**Cancellation.** `POST /orders/{id}/cancel` takes a reason and is allowed from Pending to Ready. Lines, totals and ledger stay as they were. The settlement total becomes zero, so anything already paid shows as credit.

**Ledger.** `POST /orders/{id}/payments` and `/refunds` add entries that are never changed or removed. A payment is at most the balance due. A refund names one original payment and is at most what is left of it. Both answer 201 with the entry and the order together. Both need the `payments` workflow and a method the settings accept.

**Derived amounts.** Payments, refunds, net paid, settlement total, balance due, customer credit, payment status and each payment's refundable amount are added up from the ledger on every read. The order row stores only the agreed totals.

`payments` joins the released workflows, so `food-admin setup-local` enables it.

## Clarifications Written Into the Contract

| Subject | Choice | Reason |
|---|---|---|
| Refused payment or refund by state | Nothing due, a cancelled order, or nothing refundable: 403 `action_forbidden` with the action's reason. | Same as the fixture; a step or cancellation that is not allowed stays 409 `action_not_allowed`. |
| Refund limit | What is left of the named payment. | Net paid is the sum of what is left of every payment, so this limit also keeps net paid from going negative. |
| Amount too large | 422 at `/amount_minor`, code `exceeds_maximum`, with `details.maximum_amount_minor`. The maximum can be zero. | The contract asks for the field and the detail. |
| Order of checks | The workflow, the shape of the body, the order (404), the version (409), the action (403 or 409), the method, the payment named by a refund, then the amount. | Staff with a stale page are told about the newer version before anything else. |
| Cancellation acknowledgment | Required as a boolean. False is accepted while the order has no recorded consumption. | See Plan Review. |
| Reason codes | `order_cancelled`, `nothing_due`, `nothing_refundable`, `order_finished`, `order_not_confirmed`, `order_not_preparing`, `order_not_ready`, beside those of Phase B3. | The contract leaves codes to the backend. |
| Payments switched off | Both financial routes are 403 `action_forbidden` "Payments are not enabled.", and both actions carry that reason. | The frontend shows the reason beside the disabled button. |

## Observed TDD

Tests were written first. Counts are from `uv run pytest`.

| Cycle | Observed red | Green result |
|---|---|---|
| Steps and cancellation | 50 failed, 10 passed. The 10 were jumps from Pending or Confirmed that the Phase B3 server already refused. | 60 passed. |
| Payments, refunds and credit | 53 failed, 0 passed. | 671 passed and 2 failed across the suite, both test issues listed below. After correcting them, 672 passed. |

Test corrections, not counted as red:

- One refund case passed `payment_id` twice to a test helper, which is an error in the test, not an answer from the server. The case moved into the test that tries other bad payment IDs.
- The local-setup test named `payments` as its example of a workflow that is not enabled. It now names `inventory`.
- The type checker found a loop variable reused for values of another type in one test.

Changed in existing tests because the behaviour changed on purpose:

- A Phase B3 test asserted that every action except edit and confirm was blocked. It now asserts only what is still true without payments, and the new tests cover each status.

Not test-first:

- The ledger table and migration were written with the tests, before the red run, as in earlier phases.
- Test databases now skip the wait for the disk on each commit. This is test setup only; the application's own durability setting is unchanged. The suite went from about 100 seconds to about 64.
- The shared order helpers moved from the Phase B3 test file into `tests/order_support.py`. The 128 order tests passed before and after.

## Live Verification

Run on 2026-10-11 on one machine: a new database made by `uv run food-admin setup-local`, uvicorn on `127.0.0.1:8000`, the frontend's development server in live mode on `127.0.0.1:5173`, and Chromium driven by `frontend/.playwright/phase4-live.mjs`. One answer was deliberately dropped; nothing else was intercepted.

- [x] A 215.00 order takes a deposit of 180.00 whose answer never reaches the browser. The page blocks another attempt, "Check transaction status" reports it recorded, and the server holds exactly one entry: 3500 due, Partial.
- [x] The order is edited down to 150.00. Save stays disabled until "Acknowledge customer credit of $30.00" is ticked. Afterwards: nothing due, 3000 credit, Credit due, and still one ledger entry.
- [x] The credit is refunded as its own step with a reason. Afterwards: no credit, Paid, the payment still 18000 with 15000 left to refund, and the refund pointing at it.
- [x] A second order, unpaid, goes through Start preparing, Mark ready and Complete order with the page's attestations. It ends Completed and Unpaid with 3000 due and five history events; Cancel order is disabled and Record payment is still offered.
- [x] On a third order the same payment request is sent twice with the same operation key. Both answers are 201 and identical, the second marked as a replay, and the ledger holds one entry carrying that key.
- [x] That order is cancelled with a reason. Its line and total stay, the settlement total is zero, the 1000 deposit is credit, Record payment is disabled and Record refund is offered.
- [x] A blocked action shows the server's reason on the page: "No balance is due." under Record payment on the paid order.
- [x] The cancelled order page fits a 375-pixel phone. No page errors.

Not covered in the browser:

- Two payments at the same moment, an edit overtaken by a payment, an amount over the limit, and refunds on completed orders are covered by the server tests only.
- Printing an order was not exercised; it adds no request.
- Nothing was run on Windows.

## Final Verification

- [x] `uv sync --locked` and `uv lock --check`: the lockfile is current. No dependency was added in this phase.
- [x] `uv run pytest`: 672 passed across 17 files.
- [x] `uv run ruff check .` and `uv run ruff format --check .`: passed.
- [x] `uv run mypy`: no issues in 69 source files, strict mode.
- [x] Frontend source is unchanged in this phase.
- [x] Checks ran in a Linux copy of the workspace.

## Known Limits

- **Do not enter real payments yet.** The plan requires one verified backup and restore first, which is Phase B8.
- A refund's method need not match its payment's method, and neither date is restricted. The contract selects no rule for either.
- Every financial request carries the order version, so two staff recording unrelated payments on the same order at the same moment will see one conflict and must look again. That is the contract's rule; it trades a retry for certainty.
- The API description does not show the bodies of the keyed requests, as noted in the [Phase B2 record](../phase-2/VERIFICATION.md#known-limits).
- Windows is still unverified.

## Entry Points

| File | Responsibility |
|---|---|
| [services/orders.py](../../app/services/orders.py) | Permitted actions, steps, cancellation, payments, refunds, derived amounts |
| [schemas/orders.py](../../app/schemas/orders.py) | Cancellation, payment and refund requests; ledger entry and result |
| [api/v1/orders.py](../../app/api/v1/orders.py) | Contract routes |
| [persistence/migrations/versions/0005_ledger.py](../../app/persistence/migrations/versions/0005_ledger.py) | The ledger table |
| [tests/test_fulfillment.py](../../tests/test_fulfillment.py), [tests/test_ledger.py](../../tests/test_ledger.py) | Behavioral tests |
| [tests/order_support.py](../../tests/order_support.py) | Helpers shared by the order test files |
