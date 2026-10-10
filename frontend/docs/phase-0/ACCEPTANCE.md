# Phase 0 Acceptance Scenarios

Status: test specifications only. No application/backend exists, and none of these runtime scenarios has been executed. Phase 0 verification is a document review of contracts, invariants, example arithmetic, links, and task coverage. These scenarios become executable tests as their corresponding behavior is implemented.

Historical scope note: the status above describes Phase 0 delivery. Implemented Phase 1 session/formatting/responsive checks and their observed test results are recorded separately in [Phase 1 verification](../phase-1/VERIFICATION.md). Later business behavior and live backend checks remain pending.

## Strict TDD for Coding

For each executable behavior: write the focused behavioral test first, run it and observe failure for the missing behavior, implement the smallest change that passes, then refactor with the test still passing. Record the red and green commands/results in the implementation task. A test failing from bad setup is not the required behavioral red. Tests must precede implementation; adding tests after coding is not strict TDD.

Use frontend integration tests for observable form/session/navigation behavior and backend integration tests for authoritative calculations, constraints, and transactions. Fixtures can establish a frontend contract but cannot establish backend protection, deduplication, or actual live settings. Phase 0 itself changes only Markdown documents, so it introduces no executable code requiring a red/green cycle.

## Contract Scenarios

| ID / phase | Given / action | Expected observable result |
|---|---|---|
| A01 / 3 | Fixture medium Caldereta 8000, Shanghai 5500; quote quantities 2 and 1 | Backend subtotal 21500; separate delivery/tax; package label means 100 pieces, not 1 piece |
| A02 / 5-6 | Buy 2 kg for 2400 USD minor units; recipe uses 750 g | Stock +2000 g once; normalized 0.012 USD/g; recipe contribution to cost 900 minor units; no float drift |
| A03 / 1,3 | Browser in another timezone; business America/Los_Angeles; enter date/time across DST boundaries | Business-local grouping/printing unchanged; nonexistent 2026-03-08 02:30 rejected; ambiguous 2026-11-01 01:30 requires explicit valid -07:00/-08:00 choice |
| A04 / 3 | Search/filter list, go to another page, open details, return; then filter to no match | Filters/page/sort/scroll preserved; new filter resets page; no match distinct from no records; stable tie ordering |
| A05 / 1-7 | Field error `/draft/items/0/quantity`; denied resource action | Field shows associated message and first-invalid focus; retained inputs; backend rejects action even if requested directly |
| A06 / 3-4 | Staff A/B read order version 5; A saves to 6; B submits 5 | B receives 409/latest version with no partial change; draft remains available; fresh quote and explicit resolution required |
| A07 / 3-5 | Response lost after order/payment/refund/purchase commit; repeat original key/body | Lookup identifies success; replay returns original success; exactly one order/ledger entry/receipt/movement |
| A08 / 3-7 | Lookup processing, 404, unavailable, or expired session; or reuse key with changed input | New attempt stays blocked while uncertain; 404 offers same-key retry only; changed body rejected; sign-in never resubmits |
| A09 / 4 | Due 3500; payment is 0, negative, 3501, then valid 3500; simultaneous staff payments | Invalid amounts rejected; atomic version/balance checks prevent overpayment; one confirmed ledger entry per operation |
| A10 / 3-4 | Total 21500, net paid 18000; edit total to 15000; refund 3000 | Reviewed acknowledgment; due 0, credit 3000 then 0; refund separate; original payment retained; excess refund rejected |
| A11 / 7 | Quantity 5, recorded prepared 2; status Confirmed then Preparing then legacy Ready | Remaining 3 stays in demand across each eligible status; Pending/Cancelled excluded; no status-driven stock movement |
| A12 / 4,7 | Try completing unprepared order before and after preparation capability enabled | Manual pilot permits attested completion with no stock movement; recorded mode blocks Ready/Completed until all remaining is zero |
| A13 / 7 | Partially prepared Confirmed line: ordered 5/prepared 2; edit/removal/swap | Removing/swapping or quantity <2 rejected; increasing to 6 yields remaining 4; snapshots retained; Preparing/Ready edits unavailable |
| A14 / 7 | Cancel partially prepared order, then record explicit physical correction | Remaining demand removed; no automatic stock return; reason/link/stock review required; append-only correction, not rewritten history |
| A15 / 1 | Failed login, connection failure, expiry during mutation, sign-out with lost response | Username retained where appropriate; protected data cleared on end; safe return route; no automatic mutation; remote sign-out not claimed until confirmed |
| A16 / each screen phase | Desktop/phone/keyboard/print, 320-pixel width, 200% zoom, long text/large money | No overlap/clipping, accessible labels/actions/focus/announcements, retained forms, correct print units and snapshots |
| A17 / 1-3 | Provisional settings/unknown Pork options/unconfirmed Shanghai; try live order | Provisional visibly labeled in development; live quote/save blocked; incomplete menu never seeded as confirmed live data |
| A18 / 3 | Quote expires, menu new-line price/availability changes, or payment advances order version | Stale quote/save rejected without side effects; old totals labeled stale; review a new quote; existing agreed lines stay unchanged |
| A19 / 5-7 | Transaction fails midway through multi-line purchase/preparation; preparation request repeated | Full rollback or exactly one atomic success; no partial allocations/stock/ledger effects; lookup resolves committed result |
| A20 / 6-7 | Missing recipe/purchase price or later recipe/cost edit | Aggregate estimate incomplete/null; known zero distinct; demand/list warns incomplete; historical preparation basis remains unchanged |

## Worked Financial Cases

All values here are provisional USD minor units; they do not confirm business currency or tax.

| Case | Original total | Settlement total | Payments | Refunds | Net paid | Due | Credit | Payment status |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Unpaid order | 21500 | 21500 | 0 | 0 | 0 | 21500 | 0 | unpaid |
| Deposit | 21500 | 21500 | 5000 | 0 | 5000 | 16500 | 0 | partial |
| Fully paid | 21500 | 21500 | 21500 | 0 | 21500 | 0 | 0 | paid |
| Reduced total after payment | 15000 | 15000 | 18000 | 0 | 18000 | 0 | 3000 | credit_due |
| Credit refunded | 15000 | 15000 | 18000 | 3000 | 15000 | 0 | 0 | paid |
| Cancelled deposit | 21500 | 0 | 5000 | 0 | 5000 | 0 | 5000 | credit_due |
| Cancelled and refunded | 21500 | 0 | 5000 | 5000 | 0 | 0 | 0 | paid |

A payment with 3500 due cannot accept 3501. A payment originally 5000 with prior refunds 2000 has a refundable limit of 3000; attempting 3001 fails, even when another payment leaves the order's net funds larger. Cancelling keeps original totals; settlement becomes zero and remaining funds are credit/refund due.

## Worked Planning Cases

Use one fixture ingredient in grams. Earlier and selected demand are remaining eligible quantities multiplied by recipes; prepared usage has already been removed from physical stock and is excluded from remaining demand.

| Physical stock S | Earlier E | Selected D | Stock after earlier S-E | Earlier shortage | Selected period shortage | Cumulative shopping shortage |
|---:|---:|---:|---:|---:|---:|---:|
| 1000 | 300 | 900 | 700 | 0 | 200 | 200 |
| 1000 | 1200 | 500 | -200 | 200 | 500 | 700 |
| 2000 | 300 | 900 | 1700 | 0 | 0 | 0 |

For an order of 5 units requiring 100 g each and physical stock of 1000 g, initially remaining demand is 500 g. Recording 2 prepared units consuming an actual 180 g makes stock 820 g and remaining estimated demand 300 g. Replaying that operation leaves both unchanged. Cancelling then removes the 300 g demand and leaves stock 820 g. Only an explicit physical correction can change stock afterward.

If either earlier or selected demand has missing recipes, the computed shortage is a known lower bound. The screen/print must remain incomplete even if that known shortage is zero.

## Failure and Recovery Walkthroughs

1. Create an order, lose the response, and look up its original operation ID. Verify no replacement ID is offered while the result is processing/unknown. A 404 permits only an explicit exact same-key/body retry; a delayed original request still produces one order.
2. Submit payment, expire the session, and sign in. Verify there is no automatic payment request. Reconcile the retained non-sensitive operation ID; fetch current authorized order state before any fresh reviewed attempt.
3. Let a quote expire while staff review it. Verify Save/Confirm cannot present success from the old total. Refresh/review and use a new operation only when the original attempt is definitively rejected or never submitted.
4. Record a receipt with incompatible units or missing pack contents. Verify affected fields identify the errors and all other receipt fields survive. Declared packs normalize correctly and increment stock once on confirmed success.
5. Preview preparation, then change one referenced order/ingredient/recipe. Verify save rejects the stale preview and applies no allocations or stock movements. A fresh review reflects the change.
6. Enable recorded preparation on existing active orders only after auditing baseline prepared quantities and current physical stock. Verify baseline import does not consume stock again and no inconsistent Ready record disappears from demand.
7. Submit a preparation correction with an impossible prepared count or stock return. Verify atomic rejection preserves all quantities/history. A valid correction appends linked movements and does not reopen cancelled demand.

## Phase 0 Verification Record

- Reviewed source checklist sections 1, 3-8 and all 12 Phase 0 tasks.
- Specified requests/responses for all named contract groups and their cross-cutting errors, versions, permissions, and reconciliation.
- Sketched desktop/phone layouts for five main screens, sign-in, reservation entry/review/details, preparation, and shopping.
- Checked sample money/conversion/shortage arithmetic and internal policy consistency.
- Checked local document links and task status counts using read-only workspace checks.
- Runtime, browser, and backend checks: not run; no implementation exists.
- Business/staff/menu confirmations and backend agreement: pending, as tracked in the decision register and frontend plan.

Repeat or extend executable tests only when later implementation changes, failures, or unresolved behavior warrant them. A documented scenario is not a passing runtime test.
