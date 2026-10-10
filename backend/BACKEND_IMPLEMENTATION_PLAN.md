# Backend Implementation Plan

Status: Draft written 2026-10-10. Phase B0's scaffold was delivered the same day ([verification record](docs/phase-0/VERIFICATION.md)); no contract endpoint is implemented and Phases B1-B8 are untouched. The frontend for Phases 1-6 exists and is verified only against development fixtures; this backend is what turns those fixtures into a real system. Scope decided 2026-10-10: this is a local project for now.

Sources: [MVP checklist](../food_reservation_mvp_checklist.md), [API contract proposal](../frontend/docs/phase-0/API_CONTRACT.md), [decision register](../frontend/docs/phase-0/DECISIONS.md), [acceptance scenarios](../frontend/docs/phase-0/ACCEPTANCE.md), and the [frontend plan](../frontend/FRONTEND_IMPLEMENTATION_PLAN.md) with its open live completion gates.

## What the Backend Is For

The frontend deliberately computes nothing that matters. It sends drafts and shows what comes back. The backend is therefore the only authority for:

- who is signed in, when the session ends, and what each staff member may do;
- prices, totals, balances, credit, refund limits and payment status;
- unit conversion, stock on hand, purchase cost basis and recipe estimates;
- business dates and times, including daylight-saving decisions;
- preventing lost updates (versions) and duplicate effects (operation keys).

A request that reaches the server must either take full effect once or take no effect at all, and the browser must be able to find out which.

## Local-Only Scope

Decided by the project owner on 2026-10-10: for now this is just a local project. That means:

- It runs on the developer's own machine. FastAPI listens on `127.0.0.1:8000`, the frontend runs in live mode through its development proxy, and the database is one SQLite file.
- There is no hosting, no public access and no real customer, payment or stock data. Settings stay in the `development` environment and stay provisional; development seeds and placeholders are acceptable.
- Phases B0-B7 are unaffected. The contract behaviours are the same on one machine, and the technical part of each frontend live gate can be verified against the local server.
- Everything that exists only for hosting or real business use is deferred, not dropped: HTTPS and a reverse proxy, off-machine backups with a restore test, the security review, live data provisioning, business confirmations B01-B10 and the staff walkthrough. Phase B8 separates what applies now from what waits.

Revisit this section before anyone outside the developer uses the system or any real order is entered.

## How This Plan Closes the Frontend Gates

Each backend phase is finished when the matching frontend live completion gate can be ticked against it.

| Backend phase | Delivers | Closes frontend gate | Acceptance scenarios |
|---|---|---|---|
| B0. Agreement and setup | Agreed contract, decisions, project scaffold | Phase 0 agreement tasks | - |
| B1. Foundation, sessions, settings | Sign-in, sessions, CSRF, settings, error and list conventions | Phase 1 | A05, A15 |
| B2. Versions, operations, menu | Conflict handling, duplicate prevention, foods and variants | Phase 2 | A05, A07, A08, A17 |
| B3. Orders, quotes, dashboard | Reservations with price snapshots and business-time lists | Phase 3 | A01, A03, A04, A06, A17, A18 |
| B4. Status and payments | Fulfillment steps, cancellation, payment and refund ledger | Phase 4 | A09, A10, A12 |
| B5. Ingredients and purchases | Stock movements, normalized purchases, price history | Phase 5 | A02, A19 |
| B6. Recipes and estimates | Per-variant recipes and ingredient cost estimates | Phase 6 | A02, A20 |
| B7. Planning and preparation | Demand, shortages, preparation recording | Phase 7 (frontend not built yet) | A11-A14, A19, A20 |
| B8. Running locally, later release | Local running and conformance now; deployment, backup and restore, provisioning and walkthroughs deferred | Technical part of each gate now; real-use checks later | A16 with the frontend |

## Proposed Shape

This is the starting proposal, chosen to be the simplest thing that satisfies the contract for a single-business pilot.

- **Stack.** Python with FastAPI, as the checklist states, and SQLite for the single-server pilot. Pydantic models reject unknown fields. SQLAlchemy with Alembic migrations keeps a later PostgreSQL move possible.
- **One writer at a time.** Every mutation runs in one database transaction that takes the write lock at the start. With one server process this makes "two staff pay at the same moment" a queue, not a race, and makes version checks and operation keys straightforward.
- **Exact numbers only.** Money is integer minor units. Ingredient quantities are stored as integer thousandths of the base unit. Costs are calculated with decimal arithmetic from those integers and rounded once, where the contract says so. No floating point anywhere.
- **Time.** Instants are stored in UTC. Business dates stay calendar dates. The business timezone from settings decides "today", date filters and daylight-saving resolution.
- **Sessions on the server.** An opaque cookie points at a session row, so sign-out and expiry are real. Signed self-contained cookies are not enough because they cannot be revoked.
- **Operation keys in the same transaction.** The operation record, the business effects and the stored response commit together. A crash leaves nothing behind, and the browser's "check status" gets a truthful answer.
- **An operator, not an admin screen.** Provisioning the sign-in token, confirming settings and menu items, enabling capabilities, closing an orphaned operation key, and backup and restore are command-line tasks for whoever runs the server. The contract has no endpoints for them.
- **Same origin.** Locally, the frontend's development proxy forwards `/api` to FastAPI, so cookies and CSRF work without cross-origin exceptions. A reverse proxy takes over that job only if the project is hosted later.

### Decisions to Confirm

Tick each when decided. The recommendation is the default if nobody objects.

- [ ] D01 Database. Recommended: SQLite in WAL mode with foreign keys on, as the checklist says. Revisit PostgreSQL only if hosting or concurrent use requires it.
- [x] D02 Where it runs. Decided 2026-10-10: the developer's own machine only, for now. The developer is the operator. Hosting, HTTPS and off-machine backups are deferred; see Local-Only Scope.
- [ ] D03 Process model. Recommended: one application process behind the proxy while on SQLite.
- [ ] D04 Persistence layer. Recommended: SQLAlchemy 2 with Alembic migrations.
- [ ] D05 Number storage. Recommended: integer minor units for money, integer thousandths for ingredient quantities, decimal arithmetic for costs.
- [ ] D06 Operation admission. Recommended: admit, apply and store the result in one transaction, so the `processing` state exists in the contract but is not normally observable.
- [ ] D07 Session storage. Recommended: a sessions table keyed by a hash of the cookie value.
- [ ] D08 Interim sign-in secret. Recommended: the operator sets the `admin` token by command; only a salted hash is stored; rotation is another command.
- [ ] D09 Identifiers. Recommended: random opaque IDs with a short type prefix, plus a separate human-readable order reference and purchase reference sequence.
- [x] D10 Tooling. Decided 2026-10-10 by building the scaffold: Python 3.12, uv with a cross-platform `uv.lock`, ruff, mypy in strict mode and pytest.
- [ ] D11 Contract refinements. Accept the frontend's Phase 2-6 refinements and the 2026-10-10 additions as written, or list the changes. This closes the two open agreement tasks in the frontend plan.
- [ ] D12 Estimate status in the menu list. Either add a backend-derived estimate status per variant to the food list, or keep it on the recipe page only. Open question from frontend Phase 6.
- [x] D13 Repository layout. Decided 2026-10-10: this `backend/` directory beside `frontend/` in the same repository, with its own README and CI job.

## Rules for Every Phase

- [ ] Use strict TDD: write a failing behavioral test, see it fail for the right reason, make it pass, then refactor. Record red and green in `backend/docs/phase-N/VERIFICATION.md`, as the frontend does.
- [ ] Treat the API contract as the source of truth. Agree any deviation and write it into the contract before coding it, and adjust the frontend fixture in the same change.
- [ ] Run every mutation in one transaction: precondition checks, business effects, version increment and stored operation result commit together or not at all.
- [ ] Never accept client-supplied totals, prices, balances, normalized quantities, stock, actor names or permissions as facts.
- [ ] Authorize every endpoint: session, CSRF and Origin for mutations, capability, and the resource's permitted action. Return `permitted_actions` with a reason for every blocked action.
- [ ] Reject unknown request fields and unknown query parameters with field errors instead of ignoring them.
- [ ] Return every error in the contract envelope. No tracebacks, secrets or customer notes in responses or logs.
- [ ] Never hard-delete business records. Ledgers, stock movements, receipts and status history are append-only.
- [ ] Use exact integer and decimal arithmetic. A result beyond the safe integer bound is a 422 field error, not a rounded value.
- [ ] End each phase by running the frontend in live mode against it and ticking the matching items in the frontend plan and verification records.

## Phase B0: Agreement and Project Setup

Purpose: Agree what is being built and create a project that can be run, tested and reviewed.

- [ ] Review each [contract section](../frontend/docs/phase-0/API_CONTRACT.md) with the frontend maintainer and record accepted or changed items in the decision register. Tick the contract's Backend Agreement Checklist as each group is accepted.
- [ ] Resolve decisions D01-D13 above.
- [x] Scaffold the package: application factory, one router per area, services holding the business rules, persistence, request and response schemas, and settings read from the environment. The factory, settings and the `/api/v1` mount point exist; each area's router, services, persistence and schemas are added by the phase that needs them.
- [x] Add dependency lockfile, linting, type checking and pytest, runnable with one command each.
- [x] Add a CI workflow that runs the backend checks on every push. Consider adding the frontend type check and unit tests to the same workflow; neither has CI today. Both jobs are in `.github/workflows/ci.yml`; its first run happens on the next push.
- [x] Add an unauthenticated health endpoint outside `/api/v1` for the proxy, exposing no data. It is `GET /healthz`.
- [x] Write `backend/README.md`: setup, running in PyCharm, migrations, tests, environment variables, and how to run with the frontend. Migrations are described when the database arrives in Phase B1.
- [x] Confirm the frontend's development proxy reaches the server: `npm run dev` in live mode forwards `/api` to `127.0.0.1:8000`.

Ready to proceed: A blank application starts, tests run, and the first contract group is agreed. The first two are true as of 2026-10-10; agreement is still open.

## Phase B1: Foundation, Sessions and Settings

Purpose: Everything later phases stand on, plus a real sign-in. Contract: [shared representations](../frontend/docs/phase-0/API_CONTRACT.md#shared-representations) and [auth and settings](../frontend/docs/phase-0/API_CONTRACT.md#auth-and-settings-phase-1).

### Application core

- [ ] Configure the database connection: WAL mode, foreign keys on, a busy timeout, and write transactions that take the lock at the start. Create the baseline migration.
- [ ] Give every request an ID and include it in the error envelope and the logs.
- [ ] Implement the error envelope `{error: {code, message, request_id, field_errors, details}}` and adapt framework validation errors to it, with JSON Pointer paths such as `/draft/items/0/quantity` and `/query/page`.
- [ ] Map malformed JSON to 400 `invalid_json`, unknown routes and records to 404 `not_found`, and unexpected failures to 500 `internal_error` with no traceback.
- [ ] Build the shared value types with boundary tests: money (integer, zero to 9007199254740991), selling quantity (positive integer), ingredient quantity (decimal string, at most three decimals, whole numbers for pieces, no exponent or negative zero), nine-decimal unit cost, calendar date and UTC instant.
- [ ] Build the list helper: `page` and `limit` validation (default 25, maximum 100), the `{items, page, limit, total, has_next}` shape, an empty 200 for an out-of-range page, and stable ordering with ID as the final tie-breaker.
- [ ] Send `Cache-Control: no-store` on auth and protected responses, and make sure every response carries the standard `Date` header; the frontend uses it to judge deadlines.
- [ ] Build the permitted-action helper `{allowed, reason_code, reason}`. A blocked action always has both a reason and a reason code.

### Sessions, CSRF and sign-in

- [ ] Create the sessions table: hashed session ID, user, CSRF token, created time, idle and absolute expiry, ended time. Pre-auth sessions are short-lived.
- [ ] `GET /auth/csrf` works while signed out and returns a token bound to the pre-auth or current session, with no protected data.
- [ ] `POST /auth/sign-in` accepts `{username, token}` exactly as entered, verifies in constant time against the stored hash, and answers a wrong pair with a generic 401 `invalid_credentials`. Blank values are 422 at `/username` or `/token`.
- [ ] A successful sign-in rotates the session cookie and the CSRF token and returns `{user, csrf_token, idle_expires_at, absolute_expires_at}`.
- [ ] Set the cookie as an opaque ID with `HttpOnly`, `Secure`, `SameSite=Lax` and `Path=/`. A plain-HTTP cookie is allowed only by an explicit development setting, which is the normal setting while the project is local.
- [ ] `GET /auth/session` returns the session or 401, distinguishes `session_expired` from `unauthenticated`, and does not extend idle expiry.
- [ ] Extend idle expiry on successful authenticated business requests, never past the absolute limit. Limits are 30 idle minutes and 12 absolute hours, configurable.
- [ ] `POST /auth/sign-out` requires the CSRF token, ends the server session, clears the cookie and returns 204. An already-ended session also returns 204, so the frontend's "retry sign-out" can always finish.
- [ ] Enforce CSRF token and approved Origin on every non-GET request, including sign-in and sign-out, with 403 `csrf_invalid`.
- [ ] Rate-limit sign-in attempts with 429 `rate_limited` and a `Retry-After` header.
- [ ] Provide the single pilot `admin` account with role `staff`, and operator commands to set and rotate its token. There is no registration endpoint.
- [ ] If a separate development origin is ever used, allow only exact origins with credentials, the three request headers, and expose `Date`.

### Business settings

- [ ] Create the single settings record with a version and return the contract shape from `GET /settings`.
- [ ] Add operator commands to set currency and minor digits, timezone (validated as a real zone), fulfillment methods, pickup location, delivery policy, tax policy, payment methods, capabilities and environment. Each change increases the settings version.
- [ ] Add a separate operator command to confirm currency, timezone, fulfillment, delivery and tax, recording when. Nothing is confirmed by default.
- [ ] In the live environment, fail closed: reservation and financial mutations return 409 `settings_unconfirmed` until the relevant confirmations are true.
- [ ] Start with every capability off and enable each only when its backend phase is released.

Completion check: Against the real server, sign in by keyboard, let a session expire, sign out with and without a lost response, try a wrong token, and return to a protected route. Tick the frontend Phase 1 live items.

## Phase B2: Versions, Durable Operations and Menu

Purpose: The two safety mechanisms every later mutation uses, proven on the menu. Contract: [versions](../frontend/docs/phase-0/API_CONTRACT.md#versions-and-conflict-handling), [operations](../frontend/docs/phase-0/API_CONTRACT.md#operation-ids-and-uncertain-results) and [menu](../frontend/docs/phase-0/API_CONTRACT.md#menu-phase-2).

### Version preconditions

- [ ] Build one helper that compares `expected_version` and increments the version inside the write transaction. Each successful mutation increments by exactly one; the frontend verifies this.
- [ ] Answer a stale version with 409 `version_conflict` and `details: {resource_type, resource_id, expected_version, current_version, latest_resource}`, where `latest_resource` is the complete current record with its permitted actions. A missing version is a 422 field error.

### Operation protocol

- [ ] Create the operations table: key, method, path, fingerprint, state, resource type and ID, stored status and body, stored error, started and completed times.
- [ ] Require `Idempotency-Key` on every mutation the contract lists, with 422 when it is missing. Quotes, previews and recipe saves do not use keys.
- [ ] Fingerprint each request as method, path and canonical JSON body. Cookies and CSRF tokens are not part of it.
- [ ] Commit the operation record, the business effects and the stored success response in the same transaction.
- [ ] Replay an identical completed request with its stored status and body and `Idempotency-Replayed: true`, before re-checking versions or expired quotes.
- [ ] Store terminal validation and conflict rejections as `rejected`, so a delayed copy of the same request can never succeed later.
- [ ] Answer the same key with a different fingerprint with 409 `operation_payload_mismatch`, and an identical request still in flight with 409 `operation_in_progress` and `Retry-After`.
- [ ] `GET /operations/{operation_id}` requires authorization and returns `{operation_id, state, resource_type, resource_id, result, error, started_at, completed_at}` with fields irrelevant to the state set to null. An unknown key is 404.
- [ ] Never expire operation records while the business record exists, and include them in backups.
- [ ] Add operator commands to list unresolved keys and to close an unknown key as rejected with a reason. The frontend blocks an area when a browser holds a key the server has never seen; this is the only way to unblock it after the draft is lost.
- [ ] Test the protocol directly: lost response then replay, changed body, two identical requests at once producing one effect, and a failure midway leaving no partial effect.

### Menu

- [ ] Create categories and serve `GET /categories`, paginated, name ascending. Categories are operator-managed; the contract has no category editing.
- [ ] Create foods and variants and serve `GET /foods` with `q`, `category_id` and `available` filters, name ascending, and `GET /foods/{id}`. The `available` filter applies to foods; unavailable variants stay in the response.
- [ ] `POST /foods` and `PATCH /foods/{id}`: trimmed non-blank name up to 200 characters, existing category, description up to 2000 characters returned as an empty string when absent. New records are `provisional`.
- [ ] `POST /foods/{id}/variants` and `PATCH /variants/{id}`: label rules, selling unit `tray|piece|stick|package`, non-negative price including an explicit zero, and package contents required for packages and null otherwise.
- [ ] Advance the parent food's version together with the variant's version, atomically, whenever a variant is added or edited.
- [ ] Refuse to change a variant's selling unit or package contents once it has been used on an order.
- [ ] Add an audited operator command to confirm a food or variant. A later change to its name, unit, package contents or price resets it to provisional.
- [ ] Return `permitted_actions` for foods (`edit`, `add_variant`) and variants (`edit`). Keep `recipe_id` null until Phase B6.
- [ ] Add a development seed with the provisional transcription rows from the decision register. Do not invent the Pork BBQ options, and do not seed live data.
- [ ] Add a local setup command that creates the database, sets a local `admin` token, loads provisional development settings, and seeds the provisional menu, so the project runs locally after one command.

Completion check: Create and edit a food with several variants from two browsers, force a version conflict, lose a response and recover it by status check. Tick the frontend Phase 2 live items.

## Phase B3: Orders, Quotes and Dashboard

Purpose: Reservations whose prices never change after they are agreed. Contract: [orders and quotes](../frontend/docs/phase-0/API_CONTRACT.md#orders-and-quotes-phase-3).

### Business time

- [ ] Resolve local fulfillment date and time in the settings timezone. Reject a different timezone, reject a time that does not exist, and for a time that occurs twice return a field error at `/draft/fulfillment/utc_offset` with `details.utc_offsets` unless a valid offset was supplied.
- [ ] Return `fulfillment_at` in UTC together with the chosen `utc_offset`, and use the business timezone for "today", date filters and dashboard grouping.

### Quotes

- [ ] `POST /orders/quote` validates the draft: customer name up to 200 and phone up to 50 characters, notes up to 2000, address and preparation notes up to 1000, at least one item, unique `client_line_id`, positive whole quantities, delivery address required for delivery and null for pickup.
- [ ] Price new lines from the current variant and snapshot its food name, label, unit, package contents and price. Lines carrying an existing `order_item_id` keep their saved snapshot whatever the menu says now.
- [ ] Apply the delivery and tax policy: zero charge for pickup, a validated manual amount, a backend-supplied fixed charge, or a rejection at `/draft/fulfillment/method` when delivery is disabled.
- [ ] In the live environment require confirmed settings, and require an available, confirmed variant of an available food for any new, increased or swapped line. Existing unavailable lines may stay, decrease or change notes.
- [ ] Store the quote with a five-minute expiry, bound to the exact draft, the settings version, the order version when editing, and the versions of newly priced variants.
- [ ] Return the quote shape with subtotal, delivery, tax, total, net paid, balance due, customer credit and `credit_acknowledgment_required`.

### Saving

- [ ] `POST /orders` requires the quote, the identical draft, `initial_status`, `acknowledge_credit` and an operation key. Re-check the quote's binding and expiry inside the transaction and answer a changed dependency with 409 `quote_stale` and no save.
- [ ] Create the order with a human-readable reference, snapshot lines, totals, version 1 and status history. A confirmed creation records Pending then Confirmed in one transaction.
- [ ] `PUT /orders/{id}` requires `expected_version` and a fresh quote, is allowed only for Pending and Confirmed orders, keeps the identity and snapshots of retained lines, removes omitted lines, requires credit acknowledgment when the quote says so, and never changes status.
- [ ] `POST /orders/{id}/transitions` with `to_status: "confirmed"` confirms a pending order.
- [ ] Return the full order shape, including all nine `permitted_actions` with reasons, `preparation_tracking: "manual"`, null prepared and remaining quantities, and `cancellation_requires_stock_acknowledgment: false` while preparation recording is off.
- [ ] Mark each variant as used when it first appears on a saved order.

### Reading

- [ ] `GET /orders` with `q` over customer name, phone and reference, inclusive `date_from` and `date_to` on the business date, comma-separated `status`, `sort=fulfillment_asc|fulfillment_desc` and pagination, returning summaries.
- [ ] `GET /orders/{id}` returns the full order.
- [ ] `GET /dashboard` with an optional `date` returns `{business_date, timezone, today, upcoming}`. `today` excludes Cancelled and includes Completed; `upcoming` is after that date and excludes Cancelled and Completed. Each is a paginated collection of the first 25.

Completion check: Two medium Beef Caldereta trays and one 100-piece Shanghai package give a subtotal of 21500. Change the menu price, name and availability and confirm the saved order is unchanged. Have two staff edit the same order and confirm nothing is lost. Tick the frontend Phase 3 live items.

## Phase B4: Status and Payments

Purpose: Make the order workflow usable for daily work, with money that cannot be double-counted. Contract: [status and payments](../frontend/docs/phase-0/API_CONTRACT.md#status-and-payments-phase-4) and the [financial policy](../frontend/docs/phase-0/DECISIONS.md#money-payments-refunds-and-credit).

- [ ] Allow only the next step: Confirmed to Preparing to Ready to Completed. Reject jumps and reversals with 409 `action_not_allowed`. Record each change in history with the actor's ID and display name and the time.
- [ ] While preparation recording is off, Ready and Completed need no stock change and no extra request field, and completion does not depend on payment.
- [ ] `POST /orders/{id}/cancel` requires a trimmed reason of 1-1000 characters, is allowed from Pending to Ready, keeps totals, ledger and consumption, sets the settlement total to zero and never restores stock. Require `acknowledge_consumed_stock: true` when recorded consumption exists.
- [ ] Create the append-only ledger: payment and refund entries with positive amounts, business date, method from `settings.payment_methods`, reference up to 200 and note up to 2000 characters, actor snapshot, and a unique operation key per entry.
- [ ] `POST /orders/{id}/payments` accepts a positive amount no larger than the current balance due, checked inside the transaction, and is refused on cancelled orders. Return 201 `{entry, order}`.
- [ ] `POST /orders/{id}/refunds` requires an original payment of the same order, a reason, and an amount within that payment's remaining refundable amount and the order's net paid amount. Refunds are allowed on cancelled and completed orders.
- [ ] Attach an amount that is too large to `/amount_minor` with `details.maximum_amount_minor`.
- [ ] Derive, never store by hand: payments, refunds, net paid, settlement total, balance due, customer credit, payment status (zero settlement with zero net paid is Paid) and each payment's `refundable_minor`.
- [ ] Prove with concurrent tests that two simultaneous payments cannot overpay and that an edit cannot overwrite a payment that arrived while it was being reviewed.
- [ ] Store financial operation results as `resource_type: "order"` with the exact `{entry, order}` body, the entry carrying the request's operation key and appearing in the order's ledger.

Completion check: Take a deposit of 18000 on a 21500 order, lower the total to 15000, acknowledge the 3000 credit and refund it separately. Send the same payment twice and get one entry. Complete an unpaid order. Tick the frontend Phase 4 live items; backup and restore from Phase B8 must be verified before real payments are entered.

## Phase B5: Ingredients and Purchases

Purpose: Physical stock and purchase prices that add up exactly. Contract: [inventory and purchases](../frontend/docs/phase-0/API_CONTRACT.md#inventory-and-purchases-phase-5).

- [ ] Create ingredients with a name of 1-200 characters, an immutable base unit `g|ml|piece`, an optional low-stock threshold and a version. Serve `GET /ingredients` (`q`, `low_stock`, name ascending), `GET /ingredients/{id}`, `POST /ingredients` and `PATCH /ingredients/{id}`.
- [ ] Keep stock on hand equal to the sum of movements and never negative. `low_stock` is true only when a threshold exists and stock is at or below it.
- [ ] Return `permitted_actions` for `edit`, `opening`, `waste` and `correction`, with opening stock allowed only before the first movement.
- [ ] `POST /ingredients/{id}/movement-preview` validates the type, a non-zero change with the right sign (opening adds, waste removes, correction either), a reason up to 2000 characters, and a related movement of the same ingredient. Return before, change and after with a five-minute expiry bound to the input and the ingredient version. Reject a preparation link while recording is off.
- [ ] `POST /ingredients/{id}/movements` with the preview ID and an operation key re-checks everything, appends the movement, increases the ingredient version once and returns 201 `{movement, ingredient}`. Serve `GET /ingredients/{id}/movements`, newest first.
- [ ] `POST /purchases/preview` validates date, supplier, note, 1-100 rows, unique `client_line_id`, unit compatibility with each ingredient, whole pack counts with declared contents, and a non-negative total cost per row.
- [ ] Normalize exactly: 1 kg is 1000 g, 1 l is 1000 ml, pieces stay pieces, and a pack count multiplies its declared contents. No density, no count-to-weight, no assumed bag size.
- [ ] Return preview rows in draft order with base quantity, nine-decimal unit cost, ingredient version and sequential before and after stock, so repeated rows for one ingredient add up.
- [ ] `POST /purchases` with the preview ID and an operation key commits the receipt, its lines, one stock movement per line, price history and stock in one transaction, increases each ingredient's version once per receipt, and returns 201 `{purchase, ingredients}`. A changed dependency is 409 `quote_stale` or `version_conflict`.
- [ ] Keep receipts immutable, with the quantities, units and pack declarations exactly as entered, and ingredient name and base unit as snapshots.
- [ ] Serve `GET /purchases` (`q`, `supplier`, dates; newest purchase date first) as summaries, `GET /purchases/{id}` as the full receipt, and `GET /ingredients/{id}/prices` as price history.
- [ ] Take the latest cost basis from the highest `(purchased_on, recorded_at, line id)`, so entering an older receipt does not replace a newer price. Unknown cost and date are both null; a known zero cost is a real basis.
- [ ] Require the `inventory` capability for ingredients, both `inventory` and `purchases` for purchases, and confirmed currency and timezone in the live environment.

Completion check: Buy 2 kg for 2400 minor units and see 2000 g added once and a cost of `0.012000000` per gram. Check a declared pack, an incompatible unit, a waste entry, a linked correction and a repeated purchase request. Tick the frontend Phase 5 live items.

## Phase B6: Recipes and Estimates

Purpose: Turn purchases into an ingredient cost per sellable unit. Contract: [recipes and cost estimates](../frontend/docs/phase-0/API_CONTRACT.md#recipes-and-cost-estimates-phase-6), including the Phase 6 refinements.

- [ ] Create one recipe per variant with ordered rows of ingredient, quantity and unit. Serve `GET /variants/{id}/recipe`, returning 404 when the variant is unknown or has no recipe.
- [ ] `PUT /variants/{id}/recipe` requires `yield` to equal the variant's current selling unit and package contents, 1-100 rows, each ingredient once, a unit matching the ingredient's dimension and a positive quantity, with the field pointers the contract lists.
- [ ] Accept a null `expected_version` only while no recipe exists. Answer a stale version or a second creation with 409 `version_conflict` and the complete latest recipe. A save increases the recipe version once and sets the variant's `recipe_id` without changing the variant version. No operation key.
- [ ] `GET /variants/{id}/estimate` returns the estimate shape: one basis row per recipe ingredient in recipe order, priced from the latest purchase basis, with the row amount calculated from the unrounded receipt cost.
- [ ] Round the total once, half-up, from the exact row amounts. The contribution is selling price minus ingredient cost and may be negative.
- [ ] Mark the estimate incomplete with null cost and contribution when a recipe is missing, a price is missing, or the recipe was written for a different selling format than the variant now has.
- [ ] Require the `menu`, `recipes` and `inventory` capabilities, and confirmed currency and timezone in the live environment.
- [ ] If decision D12 adds an estimate status to the food list, implement it and update the contract and the frontend together.

Completion check: With the 2 kg for 2400 purchase, a 750 g recipe costs 900 minor units. An unpriced ingredient makes the estimate incomplete, never zero. Tick the frontend Phase 6 live items once actual recipes exist.

## Phase B7: Planning and Preparation

Purpose: Say what to cook and what to buy, and record cooking exactly once. The frontend for this phase is not built; build both sides together. Contract: [planning and preparation](../frontend/docs/phase-0/API_CONTRACT.md#planning-and-preparation-phase-7) and the [preparation rules](../frontend/docs/phase-0/DECISIONS.md#preparation-eligibility-and-completion).

- [ ] `GET /planning` for an inclusive date range of at most 366 days. Demand comes from the remaining quantities of Confirmed, Preparing and Ready orders; Pending, Cancelled and Completed contribute nothing.
- [ ] Group food demand by variant and selling format snapshot, with the contributing orders and ordered, prepared and remaining quantities.
- [ ] For each ingredient return physical stock, earlier remaining demand, selected-period demand, stock after earlier commitments (which may be negative), period shortage and cumulative shortage, using the register's formulas so no commitment is counted twice.
- [ ] Mark the result incomplete when any contributing variant lacks a recipe, and name the affected orders and variants. Planning never moves stock.
- [ ] `GET /planning/shopping-list` returns the same period and calculation with the cumulative shortage per ingredient.
- [ ] `POST /preparations/preview` and `POST /preparations` (with an operation key): allocations cannot exceed remaining quantities, consumption is explicit actual usage, and stock is deducted in one transaction exactly once. Snapshot the recipe and cost basis used. Recording preparation never changes order status.
- [ ] `GET /preparations/{id}`, plus correction preview and save, bounded so prepared quantities stay between zero and ordered and stock stays non-negative. Corrections are append-only and linked.
- [ ] When `preparation_recording` is enabled: order responses carry prepared and remaining quantities, Ready and Completed require nothing remaining, prepared lines cannot be removed or reduced below what is prepared, and cancellation requires the consumed-stock acknowledgment.
- [ ] Write and rehearse the operator procedure for enabling recording on a running system: audited baseline prepared quantities that do not deduct stock again, and an agreed physical opening stock.

Completion check: The checklist's acceptance walkthrough passes end to end, including partial preparation, a repeated preparation request deducting stock once, and cancellation that removes demand without returning stock.

## Phase B8: Running Locally, and Later Release Readiness

Purpose: Make the local project easy to run and check now, and keep a clear list of what must be true before it is hosted or holds real data.

### Applies now, while the project is local

- [ ] Document and script running both sides on one machine: the server on `127.0.0.1:8000` and the frontend in live mode through its development proxy.
- [ ] Keep configuration and the local token in an environment file that is excluded from the repository.
- [ ] Publish the OpenAPI schema and compare its fields, enums and error codes with the contract.
- [ ] Build a conformance run: execute the behaviors in the frontend's fixture contract tests against the real server through a live transport, and record every difference. The fixtures are the frontend's working definition of this API.
- [ ] Walk through every open live completion gate in the frontend plan against the local server and tick the technical items with evidence. Leave the items that need business confirmations, real data or staff unticked.
- [ ] Write the local runbook: start and stop, migrate, reset the database, set the token, confirm settings and menu items, enable a capability, and close an orphaned operation key.
- [ ] Note in the runbook that copying the database file is enough of a backup while it holds no real data.

### Deferred until the project is hosted or holds real data

- [ ] Deploy behind a reverse proxy on one origin: it serves the built frontend, answers the application routes listed in the frontend README with `index.html`, and forwards `/api` to the server. Use HTTPS and secure cookies.
- [ ] Move configuration and secrets to the host's environment or a secret store.
- [ ] Schedule database backups that include the operations table, keep a copy off the machine, and document the restore. Perform one real restore and record it; the frontend Phase 4 gate requires this before real payments.
- [ ] Write structured logs with request IDs and without tokens, customer notes or financial drafts. Decide how errors reach the operator.
- [ ] Keep the server clock synchronized. The frontend follows the server's `Date` header for session, quote and preview deadlines.
- [ ] Review security before real use: cookie flags, CSRF and Origin on every mutation, authorization on every route including operation lookups and replays, rate limits, request size limits and dependency advisories.
- [ ] Provision live data only after confirmations B01-B10: settings, the staff token, confirmed menu items, opening stock and actual recipes. Never load development fixtures or the lorem ipsum placeholders into a live system.
- [ ] Tick the remaining real-use items in the frontend plan's live gates, including the review-fix gate.
- [ ] Hold a staff walkthrough on desktop and phone, including printing an order.
- [ ] Extend the runbook for a hosted system: deploy, back up and restore, rotate the token on the host.

Local check: A fresh clone runs both sides with the documented commands and the conformance run passes. Release check, later: a stranger with the runbook can restore last night's backup onto a clean machine and staff can carry on.

## Response Details the Frontend Verifies

The frontend rejects or flags a response that breaks any of these, usually as "save result unconfirmed". Test each on the server.

- [ ] Every successful mutation raises the record's version by exactly one.
- [ ] A blocked permitted action has a non-blank `reason` and `reason_code`.
- [ ] Order amounts are consistent: settlement total is zero when cancelled and the total otherwise; balance due and credit follow the policy formulas; payment status matches them; ledger sums equal `payments_minor` and `refunds_minor`.
- [ ] Payment entries have a null `payment_id` and `reason` and a `refundable_minor` equal to the amount minus its refunds. Refund entries have a `payment_id`, a `reason` and a null `refundable_minor`. Ledger IDs and operation keys are unique within an order.
- [ ] A financial result's entry appears unchanged in the returned order's ledger and carries the request's operation key.
- [ ] Fulfillment always returns `utc_offset` as `±HH:MM`, a null address for pickup, and a null or non-blank pickup location.
- [ ] Status history is never empty, and a cancellation event carries its reason.
- [ ] A quote echoes the draft's lines by `client_line_id`, variant and quantity, the local fulfillment fields, the settings version, and the settings currency and minor digits.
- [ ] An ingredient's `low_stock` agrees with its stock and threshold; latest unit cost and latest purchase date are both null or both present.
- [ ] A movement result's `stock_on_hand` is the identical string to the movement's `after_quantity`, and before plus change equals after.
- [ ] A purchase's line costs sum to its total, its lines repeat the entered quantities and units unchanged, and it carries the request's operation key.
- [ ] An estimate is complete exactly when nothing is missing, has null cost and contribution when incomplete, and its contribution equals selling price minus cost.
- [ ] A list page never returns more items than `limit` or `total`, and never repeats an ID.
- [ ] Instants end in `Z` or an explicit offset; calendar dates are real dates.

## Appendix A: Records to Store

A first sketch for the migration, to be refined in each phase.

| Record | Key contents | Notes |
|---|---|---|
| Staff user | Username, display name, role, token hash | One `admin` account for the pilot |
| Session | Hashed ID, user, CSRF token, idle and absolute expiry, ended time | Includes short-lived pre-auth sessions |
| Business settings | Version, environment, currency, timezone, policies, capabilities, confirmations | Single row; changed only by the operator |
| Operation | Key, fingerprint, state, resource, stored response or error, times | Kept as long as the business record |
| Category, food, variant | Names, unit, price, availability, confirmation, versions, used-on-order flag | Variant links to its recipe |
| Order, order item | Reference, customer, fulfillment, snapshot lines, totals, status, version | Snapshots never follow the menu |
| Quote | Draft fingerprint, bound versions, totals, expiry | Short-lived |
| Status event | From, to, actor snapshot, time, reason | Append-only |
| Ledger entry | Type, amount, business date, method, reference, note, reason, original payment, actor, operation key | Append-only |
| Ingredient | Name, base unit, threshold, version | Stock is the sum of movements |
| Stock movement | Change, before, after, type, reason, links, actor, operation key | Append-only |
| Purchase, purchase line | Reference, date, supplier, entered and normalized quantities, costs | Immutable; price history reads from lines |
| Preview | Kind, input fingerprint, bound versions, result, expiry | Movement and purchase previews |
| Recipe, recipe row | Variant, yield, ordered ingredient quantities, version | One per variant |
| Preparation, correction | Allocations, consumption, recipe and cost snapshots | Phase B7 |

## Appendix B: Acceptance Scenario Coverage

| Scenario | Subject | Phase |
|---|---|---|
| A01 | 21500 subtotal from two trays and one package | B3 |
| A02 | 2 kg for 2400, 750 g costs 900 | B5, B6 |
| A03 | Business time across daylight-saving changes | B3 |
| A04 | List filters, pages and empty results | B3 |
| A05 | Field errors and denied actions | B1, B2 |
| A06 | Two staff edit the same order | B3, B4 |
| A07 | Lost response, replay returns the original | B2 onward |
| A08 | Processing, unknown, expired session, changed body | B2 |
| A09 | Payment limits and simultaneous payments | B4 |
| A10 | Credit after an edit, then a refund | B4 |
| A11 | Remaining demand across statuses | B7 |
| A12 | Completion with and without preparation recording | B4, B7 |
| A13 | Editing a partially prepared order | B7 |
| A14 | Cancelling after partial preparation | B7 |
| A15 | Sign-in failures, expiry, sign-out | B1 |
| A16 | Layout, keyboard and print | Frontend, checked together in B8 |
| A17 | Provisional settings and unconfirmed menu block live orders | B1, B2, B3 |
| A18 | Expired or stale quote | B3 |
| A19 | Failure midway through a purchase or preparation | B5, B7 |
| A20 | Missing recipe or price | B6, B7 |
