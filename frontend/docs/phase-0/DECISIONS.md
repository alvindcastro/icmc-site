# Phase 0 Decision Register

Date: 2026-10-07. Scope: decisions and contracts only; no application or backend has been implemented.

Historical scope note: the statement above describes the Phase 0 delivery. Phase 1 frontend implementation and fixture verification are now recorded in the [Phase 1 verification record](../phase-1/VERIFICATION.md); business confirmations and backend agreement below remain pending.

The source is the [MVP checklist](../../../food_reservation_mvp_checklist.md). The [frontend plan](../../FRONTEND_IMPLEMENTATION_PLAN.md) tracks delivery. Technical choices below are the proposed v1 implementation baseline. Business facts and backend agreement are pending until explicitly confirmed; a written proposal is not evidence of live behavior.

## Deliverables

| Artifact | Purpose | Verification at this phase |
|---|---|---|
| This register | Business questions, selected technical policies, and feature gates | Cross-check against every Phase 0 task and the source |
| [API contract](API_CONTRACT.md) | Requests, responses, invariants, concurrency, and retry rules | Review examples and endpoint coverage; backend acceptance pending |
| [Layouts](LAYOUTS.md) | Desktop and phone sketches for all requested views | Review actions, states, and responsive requirements |
| [Acceptance scenarios](ACCEPTANCE.md) | Observable contracts for later tests | Review expected results; no executable tests or live verification yet |

## Review Findings

1. Phase 0 had no named output or distinction between documented rules, confirmed business facts, and backend agreement. These artifacts supply that distinction. Only completed documentation tasks can be checked now.
2. Currency, tax, delivery, the source menu photograph, and actual staff are unavailable. Illustrative dollar prices do not establish a currency, and the development machine timezone does not establish the business timezone. Live selling must be blocked until confirmation.
3. The order pilot allows completion before preparation recording is delivered. Completion checks must depend on the released preparation capability so the Phase 4 pilot remains usable. Enabling preparation later requires reconciliation of existing active orders.

## Business Confirmations

Owner: business owner. Status: unanswered as of this document. Do not replace unknown facts with a development default when provisioning live data.

| ID | Required confirmation | Development assumption only | Gates |
|---|---|---|---|
| B01 | ISO currency code and fractional digits | USD, 2 fractional digits; explicitly labeled provisional | Live settings, menu prices, reservations, payments, purchases |
| B02 | IANA business timezone | America/Los_Angeles; explicitly labeled provisional | Live fulfillment entry, dashboard dates, date filters, printing |
| B03 | Whether pickup, delivery, or both are offered; pickup location | Both options in fixtures; no real pickup address | Live fulfillment |
| B04 | Delivery charge: fixed, manual per order, or another rule | Manual nonnegative charge in fixtures; pickup is zero | Live delivery quotes |
| B05 | Whether tax applies; inclusive/exclusive; amount or rate; taxable delivery | Separate manually entered tax amount in fixtures; no tax rate or legal treatment inferred | Live quotes and totals |
| B06 | Verify the full transcription against the original menu photograph | Only the five rows below are known; photograph absent | Each live menu variant |
| B07 | Names, units, quantities, and prices of both Pork BBQ options | No price, unit, or invented variant | Pork BBQ availability |
| B08 | Whether Shanghai is sold only in whole 100-piece packages | Whole packages in fixtures | Shanghai availability |
| B09 | Staff names/account labels and account provisioning owner | Synthetic fixture users only | Live sign-in |
| B10 | Eventual staff sign-in and provisioning requirements | Temporary `admin`/token login requested by user on 2026-10-07; one staff permission set | Live provisioning and later staff access |

Business confirmations were requested during Phase 0. Record actual answers here with confirmation date and owner when provided. No passwords belong in these documents.

### Menu Transcription Register

All entries are `provisional`, unavailable for live ordering, and have no approved seed identifier. A confirmed item requires a verified label, unit, quantity rule, price, and currency. Do not assume that confirming one row confirms the rest of the menu.

| Food | Variant | Selling unit | Package contents | Example minor units, assuming B01 | Confirmation |
|---|---|---|---|---:|---|
| Beef Caldereta | Small | tray | Not applicable | 6000 | Pending |
| Beef Caldereta | Medium | tray | Not applicable | 8000 | Pending |
| Beef Caldereta | Large | tray | Not applicable | 10500 | Pending |
| Fresh Lumpia | Each | piece | Not applicable | 300 | Pending |
| Shanghai Spring Rolls | 100 pieces | package | 100 pieces | 5500 | Price and whole-package rule pending |
| Pork BBQ | Option 1: unknown | Unknown | Unknown | Unknown | Original photograph and owner clarification required |
| Pork BBQ | Option 2: unknown | Unknown | Unknown | Unknown | Original photograph and owner clarification required |

Quantities count sellable units: two Shanghai packages mean 200 pieces. Do not accept an individual-piece quantity against the package variant. Menus may use Beef, Pork, Chicken, and Fish, Lumpia & More categories from the source, subject to transcription review.

## Staff and Session Requirements

Current interim requirement, requested by the user on 2026-10-07: `admin` plus a token, no public registration, one `staff` permission set, and manual provisioning/token rotation by the backend operator. Development fixtures use a synthetic token; the frontend sends `{username, token}` to the session endpoint. Eventual individual staff identities and live provisioning remain pending. Staff can use delivered order, menu, payment, inventory, recipe, and preparation workflows. Provisioning, enabling capabilities, and confirming settings are operator responsibilities outside the frontend pilot.

Opaque server sessions use a same-origin cookie, CSRF protection, a 30-minute idle limit, and a 12-hour absolute limit. The backend declares expiry and authorizes every action. Login tokens and session credentials must not be stored in browser storage. Actual staff identities, account owner, and eventual provisioning remain B09/B10 confirmations; the temporary admin/token method is now specified.

On expiry or sign-out, clear protected caches and customer/order drafts from browser memory and storage. Retain only a safe relative return route and a non-sensitive unresolved operation identifier. Sign-in returns to that route; it never submits a mutation. An operation with an uncertain result must be reconciled after sign-in before staff start a replacement attempt.

## Selected Technical Policies

These are defined for implementation under the requested Phase 0 work. Backend agreement and verification remain separate gates.

| ID | Decision | Contract / evidence |
|---|---|---|
| T01 | Integer minor units for money; integer sellable quantities; exact decimal strings for ingredient quantities and normalized costs | API contract: shared representations; acceptance A01/A02 |
| T02 | UTC timestamps plus IANA business timezone; calendar dates stay calendar dates; backend validates DST offsets | API contract: dates and times; A03 |
| T03 | Bounded page/limit lists, stable sorting, field errors by JSON Pointer, backend action permissions | API contract: lists/errors/actions; A04/A05 |
| T04 | Required order `expected_version`, atomic comparisons, and 409 conflicts; never force overwrite | API contract: versions; A06 |
| T05 | Durable operation IDs bound to exact requests and atomic side effects; reconcile before retry/new attempt | API contract: operation protocol; A07/A08 |
| T06 | Reject new payments above collectible balance; positive append-only refunds bounded by unrefunded payments | Financial rules below; A09/A10 |
| T07 | Active remaining quantities stay eligible in Confirmed, Preparing, and Ready; Pending/Cancelled/Completed excluded | Preparation rules below; A11/A12 |
| T08 | Prepared lines cannot be removed, swapped, or reduced below already-prepared quantity; consumption changes use explicit movements | Edit rules below; A13/A14 |

### Money, Payments, Refunds, and Credit

The backend computes `subtotal_minor = sum(quantity * snapshot_unit_price_minor)`, then `total_minor = subtotal_minor + delivery_charge_minor + tax_minor` for the selected separate-amount policy. An alternative confirmed tax model must update the settings and quote contracts before live use. All examples are fixtures, not tax advice or confirmation.

The ledger retains positive amounts and distinguishes `payment` from `refund`. `net_paid_minor = payments_minor - refunds_minor` must remain nonnegative. Refunds reference an original payment and cannot exceed that payment's remaining refundable amount or the order's net paid amount. A partial/full refund is allowed on any order with refundable funds, with a required reason and permission; it never changes preparation status or restores stock.

For active/completed orders, `settlement_total_minor = total_minor`. For Cancelled orders, `settlement_total_minor = 0`: original item snapshots/totals remain for audit, and retained net funds appear as credit/refund due. Cancellation charges are outside this pilot; adding them requires a new explicit policy.

`balance_due_minor = max(0, settlement_total_minor - net_paid_minor)` and `customer_credit_minor = max(0, net_paid_minor - settlement_total_minor)`. Never render credit as a negative balance due. Payment status is independently `unpaid` (net zero, positive settlement), `partial` (between zero and settlement), `paid` (equal), or `credit_due` (above settlement). An order with zero settlement and zero net is `paid` with no credit.

Reject zero/negative payments and payments larger than the current balance, including races between staff. Cancelled orders accept refunds but no new payments. Completed orders may accept an outstanding payment or refund. Lowering an editable order from 21500 to 15000 after 18000 net paid yields 0 due and 3000 credit; require explicit credit acknowledgment in the quote review, then a separate refund action. Do not automatically refund, transfer credit to another order, or delete ledger entries.

### Preparation Eligibility and Completion

Per line: `remaining_quantity = ordered_quantity - prepared_quantity`, with `0 <= prepared_quantity <= ordered_quantity`. Confirmed, Preparing, and Ready orders contribute only positive remaining quantities. Pending and Cancelled contribute none. Completed contributes none and, when preparation recording is enabled, must have zero remaining quantities before completion.

Phases 1-4 use manual preparation status: staff attest readiness/completion without ingredient movements. `preparation_recording` is disabled and prepared/remaining quantities are `null`, not a misleading zero. Changing status never deducts stock.

In Phase 7, preparation recording becomes available and the backend enforces quantity consistency. Transition to Ready or Completed requires all lines fully prepared. Include any legacy/inconsistent Ready record with positive remaining quantity in planning, flag it, and reject completion until resolved. Missing recipes block complete planning estimates, not demand visibility; actual consumption can still be entered explicitly in a preparation review.

Before enabling this capability, reconcile active pilot orders. Record audited baseline prepared quantities for food already prepared, using a backend migration/operator procedure that does not deduct those ingredients again; establish physical opening stock after that past consumption. Unprepared lines start at zero. Review active Ready orders, preserve their payment history, and enable the capability only after baseline/stock agreement. This operator procedure is a Phase 7 release dependency, not an extra frontend workflow.

Physical stock is the movement sum. Planning reserves no physical stock. For each ingredient, with disjoint earlier commitments `E`, selected-period remaining demand `D`, and physical stock `S`: `stock_after_earlier = S - E`, `period_shortage = max(0, D - max(0, S - E))`, `cumulative_shortage = max(0, E + D - S)`. Preserve the possibly negative `stock_after_earlier` so earlier deficits stay visible. Shopping lists use cumulative shortage through the selected period and expose earlier shortage separately. Never subtract both consumed quantities and the former full-order commitment.

### Edits and Cancellation After Preparation

Pending and Confirmed orders are editable; Preparing, Ready, Completed, and Cancelled orders are read-only for customer, fulfillment, and item changes in this pilot. Confirmed orders with partial preparation remain editable only within these constraints: keep prepared line identity and snapshots, do not decrease below prepared quantity, and do not remove prepared lines. Unprepared lines may be added, changed, or removed; increased quantities contribute new remaining demand. All edits require a fresh quote and expected version.

Cancellation is permitted before Completed, including partial preparation, with a required reason and review of prepared quantities, consumed stock, and refund due. Cancelled orders lose remaining demand; consumed stock stays consumed. Returned, wasted, or mistakenly recorded ingredients require a separate signed correction/waste movement with a reason and a link to the affected preparation. Incorrect prepared counts require an explicit preparation correction with linked stock adjustments reviewed atomically. Positive stock returns must represent actual recovered stock, not the assumption that cancelling restores ingredients.

Completion does not require full payment; preparation and payment status remain separate. Completed orders cannot be cancelled in this pilot, but retained funds may be refunded. Historical records are never hard-deleted.

## Feature Gates and Handoff

| Next work | Required before development | Required before live use |
|---|---|---|
| Phase 1 foundation | Auth/settings proposals and layout sketches | B01/B02/B09/B10, backend session/settings agreement and expiry verification |
| Phase 2 menu | Menu proposal and fixture labels | Confirm each sellable item, B06-B08 as applicable, backend menu agreement |
| Phase 3 reservations | Orders/quotes/version/operation proposals | B01-B05, confirmed variants, backend snapshots/concurrency/reconciliation verification |
| Phase 4 pilot | Status/payment proposals and financial policy | Backend ledger/deduplication verification, staff walkthrough, backend backup/restore |
| Phases 5-6 inventory/costs | Units/purchases/recipes proposals | Actual stock/recipes, backend conversion/cost/purchase agreement |
| Phase 7 kitchen | Planning/preparation/correction proposals | Baseline reconciliation, backend demand/stock/exactly-once verification |

Backend contract agreement: pending. No backend project, implemented endpoints, or backend maintainer acceptance is present in this workspace. Review the two endpoint groups in the API contract before their respective feature implementation and record any agreed changes here. No mock response can close that integration gate.

## Completion Record

- [x] Reviewed Phase 0 against the source and identified concrete delivery gaps.
- [x] Wrote the decision register, endpoint contracts, desktop/phone sketches, and acceptance scenarios.
- [x] Defined representations, conflicts, deduplication, financial rules, preparation eligibility, and correction rules.
- [ ] Confirm B01-B05 business settings.
- [ ] Confirm B06-B08 menu transcription/options/quantities.
- [ ] Identify B09 staff and confirm B10 sign-in requirements.
- [ ] Obtain backend agreement for Phase 1-4 contracts.
- [ ] Obtain backend agreement for Phase 5-7 contracts.

Phase 0 documentation is ready for implementation review. Phase 0 as a whole remains awaiting the five confirmation/agreement tasks. No application code, runtime tests, backend integration, or commit is part of this work.
