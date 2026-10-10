# Food Reservation and Ingredient Tracker
## Initial implementation checklist

Status: Draft  
Stack: React frontend, Python/FastAPI backend, SQLite for the initial single-server pilot  
Purpose: Record food preorders, organize preparation, track ingredient stock and purchase prices, and estimate food costs.

All tasks are unchecked. This document describes proposed work; no application has been implemented.

## Development context

The user can use PyCharm and WebStorm. Setup and debugging instructions can reference PyCharm for the Python/FastAPI backend and WebStorm for the React frontend.

## 1. Scope and assumptions

The first version is an internal tool. Staff enter reservations received by phone or messages, confirm fulfillment details, and manually record payments.

A reservation is an order for food on a specified date and time. One order can contain several dishes, sizes, and quantities.

- [ ] Confirm the business currency and local timezone.
- [ ] Confirm pickup and delivery options, delivery charges, and how applicable tax should be entered.
- [ ] Clarify the two Pork BBQ options before adding their prices to the live menu.
- [ ] Confirm whether Shanghai Spring Rolls must be ordered in whole 100-piece packages.
- [ ] Collect actual recipes and quantities for each sellable variant.
- [ ] Agree on the staff who will use the first version.

The menu photograph supplies selling prices. It does not supply recipes, stock levels, ingredient costs, or tax treatment.

## 2. Core use cases

| User need | Expected result |
|---|---|
| Maintain the menu | Staff can edit dishes, variants, selling prices, and availability. |
| Reserve food | Staff can create an order with customer details, items, and fulfillment time. |
| Track progress | Staff can see pending, confirmed, preparing, ready, completed, and cancelled orders. |
| Track payments | Staff can record deposits and payments and see the remaining balance. |
| Track ingredients | Staff can see stock quantities and record purchases, cooking usage, waste, and corrections. |
| Track ingredient prices | Staff can review purchase history and normalized unit costs. |
| Estimate recipe costs | Staff can see ingredient cost and selling price for each variant. |
| Plan preparation | Staff can see what to cook and what to buy for a selected date range. |

## 3. Phase 1: Menu and reservations

Goal: Staff can record and fulfill real orders.

### Application foundation

- [ ] Create the React application and Python/FastAPI service.
- [ ] Create the SQLite database and a repeatable migration process.
- [ ] Add staff sign-in and protect access to customer, order, and purchasing data.
- [ ] Add shared navigation, form validation, loading states, and clear error messages.
- [ ] Store money using decimal values or integer minor units; calculate totals in the backend.
- [ ] Configure currency and business timezone centrally.

### Menu and selling formats

- [ ] Create food categories: Beef, Pork, Chicken, and Fish, Lumpia & More.
- [ ] Add food records with a name, category, optional description, and availability.
- [ ] Give each food one or more sellable variants with a label, selling unit, and price.
- [ ] Support trays, individual pieces, sticks, and fixed-size packages.
- [ ] Allow prices to be edited and variants to be made unavailable.
- [ ] Seed the menu from the supplied photograph and check the transcription before use.
- [ ] Preserve past order items when a dish is renamed, repriced, or made unavailable.

Examples transcribed from the supplied menu, subject to confirmation:

| Food | Variant / selling unit | Listed price |
|---|---|---:|
| Beef Caldereta | Small tray | $60.00 |
| Beef Caldereta | Medium tray | $80.00 |
| Beef Caldereta | Large tray | $105.00 |
| Fresh Lumpia | Each | $3.00 |
| Shanghai Spring Rolls | Package of 100 pieces | $55.00 |

For packaged food, an order quantity of 2 means two packages, not two individual pieces.

### Reservation entry

- [ ] Capture customer name, phone number, and optional notes.
- [ ] Capture pickup or delivery, fulfillment date and time, and delivery address when needed.
- [ ] Add multiple order items with variant, quantity, and optional preparation notes.
- [ ] Calculate the food subtotal and separately display delivery charges and applicable tax.
- [ ] Save a snapshot of the item name, variant, selling unit, and agreed unit price on each order line.
- [ ] Allow staff to edit pending and confirmed orders and recalculate their totals.
- [ ] Show a clear order summary before confirmation.
- [ ] Add a printable order summary.

### Order status and payments

Normal status flow: Pending → Confirmed → Preparing → Ready → Completed.

- [ ] Implement the normal status flow and record the time of each status change.
- [ ] Allow cancellation with a reason.
- [ ] Keep payment status separate from preparation status.
- [ ] Record manual payments with amount, date, method, and reference or note.
- [ ] Calculate the outstanding balance from the order total and payments.
- [ ] Record refunds separately when needed; cancellation must not erase payment history.
- [ ] Display upcoming orders with filters for fulfillment date, status, and customer.

Phase 1 completion:

- [ ] A staff member can create, confirm, update, and complete a reservation.
- [ ] An existing reservation keeps its agreed price after the menu price changes.
- [ ] Deposits and outstanding balances are visible without opening a separate spreadsheet.

## 4. Phase 2: Ingredients, purchases, and recipes

Goal: Staff can track stock and understand estimated ingredient costs.

### Ingredient records and stock

- [ ] Create ingredients with a name, base unit, and optional low-stock threshold.
- [ ] Use grams, millilitres, or pieces as base units.
- [ ] Support explicit conversions such as kilograms to grams and litres to millilitres.
- [ ] Require a declared pack quantity for purchases described as bags, bottles, or boxes.
- [ ] Prevent unsupported conversions between weight, volume, and count.
- [ ] Record opening stock and adjustments with a reason.
- [ ] Derive stock on hand from purchases, consumption, waste, and adjustments.
- [ ] Show low-stock warnings.

### Purchases and price history

- [ ] Record purchase date, supplier, ingredient, quantity, unit, and total ingredient cost.
- [ ] Convert purchased quantities to the ingredient's base unit.
- [ ] Calculate and retain the normalized purchase cost per base unit.
- [ ] Keep each purchase record instead of overwriting the previous price.
- [ ] Display purchase history with quantity, total cost, and comparable unit cost.
- [ ] Show the latest purchase price and its date for each ingredient.
- [ ] Use the latest purchase unit cost for initial recipe estimates.

Illustration only: a 2 kg purchase costing $24 has a unit cost of $12/kg. A recipe using 750 g includes $9 of that ingredient.

### Recipes and estimated costs

- [ ] Define a recipe for one sellable variant, including ingredient quantities and units.
- [ ] Make the recipe yield explicit: one tray, one piece, one stick, or one package.
- [ ] Enter quantities for each tray size rather than assuming size ratios.
- [ ] Calculate the estimated ingredient cost per sellable unit.
- [ ] Flag missing recipes or ingredient prices as incomplete estimates, not zero costs.
- [ ] Display selling price, estimated ingredient cost, and ingredient contribution.
- [ ] Recalculate current estimates when ingredient prices or recipes change.
- [ ] Save the recipe quantities and cost basis used when recording preparation, so later edits do not rewrite past preparation records.

Ingredient contribution = selling price − estimated ingredient cost.

Label this as an ingredient contribution estimate. It is not net profit and does not account for labour, packaging, utilities, delivery, or other expenses unless those costs are explicitly added.

Phase 2 completion:

- [ ] Recording a purchase increases stock and adds a price-history entry.
- [ ] Recipe quantities and purchase units produce correct cost calculations.
- [ ] Staff can see which dishes have incomplete recipes or missing costs.

## 5. Phase 3: Kitchen planning and shopping

Goal: Staff can turn confirmed reservations into a practical preparation and shopping list.

- [ ] Create a preparation view for a selected date or date range.
- [ ] Group confirmed, unprepared order quantities by food and variant.
- [ ] Multiply those quantities by their recipes to calculate ingredient demand.
- [ ] Display stock on hand, planned demand, and shortages for each ingredient.
- [ ] Include earlier outstanding commitments when checking availability for a later date.
- [ ] Generate a shopping list using shortage = max(0, planned demand − stock available).
- [ ] Flag orders whose ingredient demand cannot be calculated because a recipe is missing.
- [ ] Keep planned demand separate from physical stock.
- [ ] Let staff record quantities prepared and the ingredients actually consumed.
- [ ] Deduct stock exactly once when preparation is recorded.
- [ ] Remove fulfilled preparation quantities from outstanding demand.
- [ ] Remove demand when an unprepared order is cancelled.
- [ ] Require an explicit correction for consumed ingredients; cancellation must not automatically restore them.

Phase 3 completion:

- [ ] Staff can see what to cook and buy for a selected fulfillment period.
- [ ] Pending orders do not consume stock or create confirmed demand.
- [ ] Repeated preparation submissions do not deduct ingredients twice.
- [ ] Cancelled and already-prepared quantities are handled correctly in the shopping list.

## 6. UI/UX implementation checklist

Use this section to track the React frontend work in WebStorm. Check each task only after its behavior has been implemented and verified. These tasks describe proposed work, not completed screens.

Phase 1 covers sign-in, navigation, reservations, payments, and menu management. Phase 2 adds ingredients, purchases, recipes, and cost estimates. Phase 3 adds preparation and shopping workflows. Show navigation and actions only when their corresponding workflow is available.

| Screen | Main contents | Delivery phase |
|---|---|---|
| Dashboard | Today's orders, upcoming pickups/deliveries, balances, low-stock warnings, and preparation summary. | Orders and balances in Phase 1; stock in Phase 2; preparation in Phase 3. |
| Orders | Reservation list, order form, detail view, status updates, and payment records. | Phase 1. |
| Menu & Recipes | Categories, foods, sellable variants, prices, recipes, and cost estimates. | Menu in Phase 1; recipes and costs in Phase 2. |
| Ingredients | Stock on hand, unit definitions, adjustments, usage, and price history. | Phase 2. |
| Purchases | Ingredient purchases, supplier details, quantities, and costs. | Phase 2. |

Expose preparation and the printable shopping list as views reached from the Dashboard in Phase 3.

### 6.1. Layout and shared controls - Phase 1 foundation

- [ ] Sketch desktop and phone layouts for the five screens, including their primary actions and empty states.
- [ ] Build a compact application layout with desktop navigation, a phone navigation menu, a page heading, and a consistent action area.
- [ ] Highlight the current screen and preserve filters and scroll position when returning from a detail view.
- [ ] Define shared spacing, readable type sizes, neutral surfaces, and distinct success, warning, and error colors; pair status colors with text.
- [ ] Use tables for desktop lists and readable stacked rows on phones, with stable action positions and no overlapping content.
- [ ] Use labeled inputs, select menus for options, toggles for availability, and numeric inputs or steppers for quantities.
- [ ] Use Lucide icons for familiar tools such as print, edit, and close, with accessible names and tooltips for icon-only actions.
- [ ] Keep common commands visible in the relevant view: New order, Record payment, Record purchase, and Record preparation.

### 6.2. Staff access - Phase 1

- [ ] Build a sign-in form with visible field labels, a password visibility control, validation, and a submitting state.
- [ ] Show failed sign-in and connection errors with a retry path; do not clear the entered username unnecessarily.
- [ ] Handle signed-out and expired-session states, returning staff to their intended screen after sign-in without resubmitting an action.
- [ ] Provide a visible sign-out action and clear protected screen data when the session ends.

### 6.3. Dashboard - Phases 1 to 3

- [ ] Show today's orders and upcoming pickups/deliveries in fulfillment-time order using the configured business timezone.
- [ ] Display customer, fulfillment time, pickup/delivery, preparation status, and outstanding balance for each order.
- [ ] Make order summaries open the corresponding detail view and provide a prominent New order action.
- [ ] Give an empty day its own state, distinct from loading or failing to retrieve orders.
- [ ] Add low-stock warnings linked to ingredient details in Phase 2.
- [ ] Add a date-range preparation summary and links to preparation and shopping views in Phase 3.

### 6.4. Order list - Phase 1

- [ ] Display order reference, customer, fulfillment date/time, pickup/delivery, order total, balance, and separate preparation and payment statuses.
- [ ] Provide customer search, fulfillment-date and status filters, and a clear-filters action.
- [ ] Support chronological sorting and pagination while retaining the active search and filters.
- [ ] Distinguish no reservations from no matching results, with New order or Clear filters as the appropriate action.
- [ ] Make order details accessible through a visible link that works with both keyboard and touch.

### 6.5. New and edited reservations - Phase 1

- [ ] Group the form into customer details, fulfillment, order items, and totals, with a single-column flow on phones.
- [ ] Capture customer name, phone, optional notes, and fulfillment date/time with clear required-field indicators and business-timezone context.
- [ ] Use a pickup/delivery control and require an address only when delivery is selected.
- [ ] Provide searchable food and variant selection showing selling unit, price, and availability; prevent adding unavailable variants.
- [ ] Add editable item rows with quantity, preparation notes, line total, and remove action; label package quantities explicitly, such as "2 packages of 100 pieces".
- [ ] Show subtotal, delivery charge, applicable tax, and total separately using the backend-calculated amounts.
- [ ] Place validation messages next to affected fields and focus the first invalid field when submission fails.
- [ ] Offer Save pending and a review step before confirmation, retaining entered values if saving fails.
- [ ] Preserve agreed prices when editing existing order lines and show the recalculated total before saving changes.
- [ ] Warn before leaving a form with unsaved changes and prevent duplicate clicks while a save is in progress.

### 6.6. Order details, status, and payments - Phase 1

- [ ] Show fulfillment details, agreed item prices, item notes, totals, payment balance, and a dated status history.
- [ ] Show the next allowed status action; make permitted edits available for pending and confirmed orders and explain unavailable actions.
- [ ] Require a cancellation reason and confirm cancellation while keeping existing payment history visible.
- [ ] Provide a Record payment form with amount, date, method, and reference or note, followed by an updated balance after successful saving.
- [ ] Show payments and refunds as distinct dated entries, with a separate refund action and confirmation.
- [ ] Disable payment and refund submission while saving; after an uncertain response, reload the recorded entries before offering another submission.
- [ ] Provide a print view of the order summary that includes fulfillment details, items, totals, and balance while hiding navigation and editing controls.

### 6.7. Menu and recipes - Phases 1 and 2

- [ ] Build a searchable menu list with category and availability filters and an Add food action.
- [ ] Provide food and variant editors for names, category, selling unit, price, and availability, with required-field and price validation.
- [ ] Keep unavailable items accessible to staff for editing, and retain their snapshots on historical orders.
- [ ] Add a Phase 2 recipe editor per variant with explicit yield, ingredient selection, quantities, and compatible units.
- [ ] Display selling price, estimated ingredient cost, and ingredient contribution separately, with the purchase dates used for the estimate.
- [ ] Mark missing recipes or prices as incomplete and link to the affected records instead of displaying a misleading zero cost.

### 6.8. Ingredients and stock - Phase 2

- [ ] Show ingredient name, base unit, stock on hand, low-stock threshold, latest unit cost, and purchase date, with search and a low-stock filter.
- [ ] Provide an ingredient form with name, supported base-unit selection, and optional low-stock threshold.
- [ ] Show a chronological movement history with quantity, unit, reason, and links to the related purchase or preparation record.
- [ ] Provide opening-stock, waste, and correction forms with a required reason and a before/after stock preview.
- [ ] Keep physical stock separate from planned demand and show missing purchase prices as unknown values.

### 6.9. Purchases and price history - Phase 2

- [ ] Build a purchase list with supplier and date filters and links to receipt details.
- [ ] Provide a purchase form with date, supplier, and repeatable ingredient rows containing quantity, purchase unit, and total ingredient cost.
- [ ] Request pack contents for bags, bottles, and boxes; show the normalized base quantity and unit cost before saving.
- [ ] Show field errors for unsupported unit conversions or invalid amounts without clearing the rest of the purchase form.
- [ ] Show the saved purchase and updated stock after success; retain form values on failure and reconcile an uncertain save before retrying.
- [ ] Display comparable ingredient purchase prices by date, supplier, quantity, and normalized unit cost.

### 6.10. Preparation and shopping - Phase 3

- [ ] Provide a date or date-range selector and group outstanding confirmed quantities by food and variant.
- [ ] Show ordered, already prepared, and remaining quantities, with links to the contributing orders.
- [ ] Display ingredient demand, stock available after earlier commitments, and shortages without counting the same commitment twice.
- [ ] Highlight missing recipes and link to their editors; mark the shopping list incomplete while demand is unknown.
- [ ] Provide a preparation form for quantities prepared and ingredients actually consumed, followed by a review of stock deductions.
- [ ] Define which order edits remain allowed after partial preparation, and show prepared quantities and required stock corrections before staff change or cancel an order.
- [ ] Refresh prepared quantities and stock after saving, and reconcile uncertain submissions before allowing a retry.
- [ ] Provide a printable shopping list with the selected period, ingredient names, shortage quantities, and units.

### 6.11. Feedback, accessibility, and responsive behavior - Every phase

- [ ] Add loading, empty, no-results, success, and failure states to every delivered screen, with a recovery action where appropriate.
- [ ] Keep failed submissions and unsaved changes visible; never display a successful save until the backend confirms it.
- [ ] Make forms, filters, menus, and dialogs usable by keyboard, with visible focus and focus returned to the triggering control when a dialog closes.
- [ ] Associate labels and validation messages with their fields and announce save results and errors to assistive technology.
- [ ] Check text and control contrast, pair status colors with labels, and provide comfortably sized touch targets.
- [ ] Verify phone, tablet, and desktop layouts, including 320-pixel-wide screens and 200% zoom, without clipped text or overlapping actions.
- [ ] Keep long customer names, food names, addresses, and large monetary values readable without displacing adjacent controls.
- [ ] Display monetary amounts, ingredient units, and business dates consistently across lists, forms, details, and print views.

### 6.12. UI acceptance checks - Before each phase is complete

- [ ] Complete the Phase 1 order workflow on desktop and phone: create, review, confirm, record deposit, update status, and print.
- [ ] Complete a keyboard-only sign-in and reservation workflow, checking focus order, field errors, and dialog behavior.
- [ ] Verify empty data, no search results, failed requests, expired sessions, and recovery without accidental duplicate submissions.
- [ ] Verify a menu price change does not alter an existing order's displayed agreed price or total.
- [ ] In Phase 2, record a purchase and a recipe, then verify the stock, unit costs, and incomplete-cost states shown to staff.
- [ ] In Phase 3, test partial preparation, repeated submissions, and cancellation against the displayed demand and stock movements.
- [ ] Check printed order summaries and shopping lists for readable page breaks, visible units, and absence of editing controls.
- [ ] Walk through the delivered screens with a staff member and resolve blocking usability issues before marking the phase complete.

## 7. Suggested data records

| Record | Purpose |
|---|---|
| Food / category | Menu organization and food descriptions. |
| Food variant | Sellable size or format, selling unit, current price, and availability. |
| Order / order item | Customer and fulfillment details, quantities, and agreed price snapshots. |
| Payment | Manual payments and refunds associated with an order. |
| Ingredient | Name, base unit, and low-stock threshold. |
| Purchase / purchase item | Supplier, purchase date, quantities, costs, and price history. |
| Recipe / recipe ingredient | Variant yield and ingredient quantities. |
| Stock movement | Purchase receipts, consumption, waste, and corrections. |
| Preparation record | Prepared quantities, linked order items, ingredient usage, and cost basis. |

- [ ] Keep order totals, unit conversions, recipe costs, and stock rules in the Python backend.
- [ ] Link purchase receipts and preparation records to their stock movements so retries cannot duplicate inventory changes.
- [ ] Document how to run the frontend, backend, migrations, and seed data.
- [ ] Add a database backup procedure and verify one restore before real use.

## 8. Acceptance walkthrough

Use two medium Beef Caldereta trays and one 100-piece Shanghai Spring Rolls package. Based on the photographed prices, the food subtotal is $215 before delivery charges or applicable tax.

- [ ] Create the reservation with a customer and fulfillment date.
- [ ] Confirm that the food subtotal is $215.
- [ ] Record a deposit and verify the remaining balance.
- [ ] Change the current menu price and verify that the agreed order total stays unchanged.
- [ ] Confirm the order and verify its preparation quantities.
- [ ] With sample recipes entered, verify ingredient demand and shortages.
- [ ] Record an ingredient purchase and verify both stock and price history.
- [ ] Record preparation and verify stock is deducted once.
- [ ] Complete the order and verify that payment history remains available.
- [ ] In a separate unprepared order, verify cancellation releases demand without changing stock.

## 9. Later options

These are optional follow-up features outside the initial implementation.

- [ ] Customer self-service ordering.
- [ ] Online payments.
- [ ] Email or SMS confirmations and reminders.
- [ ] Daily production limits and booking cutoffs.
- [ ] Supplier comparison and purchase suggestions.
- [ ] Packaging, labour, and overhead costing.
- [ ] Ingredient expiry dates and batch tracking.
- [ ] PostgreSQL migration if hosting or concurrent use requires it.

## Technical references

- [React documentation](https://react.dev/)
- [FastAPI documentation](https://fastapi.tiangolo.com/)
- [Appropriate uses for SQLite](https://www.sqlite.org/whentouse.html)
