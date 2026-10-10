# Phase 0 Layout Sketches

Status: desktop and phone wireframes documented; no screens implemented or browser-tested. Business labels and sample data are fixtures. The five main screens are Dashboard, Orders, Menu & Recipes, Ingredients, and Purchases; preparation/shopping are reached from Dashboard. This document also sketches sign-in and reservation entry/review/details.

Historical scope note: this is the Phase 0 sketch baseline. The shared shell and sign-in have since been implemented and browser-verified in [Phase 1](../phase-1/VERIFICATION.md); the remaining business screens are later work.

## Shared Layout

Desktop: a compact 200-pixel navigation column and an unframed content area. Page heading and primary command share a row; filters follow; data is the main visual content. Navigation expands only as corresponding workflows become available. Ingredients/Purchases arrive in Phase 5; recipes in Phase 6; planning/preparation in Phase 7. Current staff and sign-out remain accessible.

Phone: a single column with a menu icon, heading, and primary command. Navigation is a modal drawer with focus management. Tables become stacked rows with explicit labels and consistent action positions. The action row wraps into its own line at narrow widths; it never shares space with long data text. Desktop and phone have the same data/actions, subject to backend permissions.

```text
Desktop                                  Phone
+------------------+------------------+  +----------------------------+
| Food reservations| Orders    + New  |  | Menu  Orders               |
| Dashboard        | Search / filters |  | + New order                |
| Orders           |                  |  | Search                     |
| Menu & Recipes   | Data / form      |  | Date / status              |
| Ingredients*     |                  |  |                            |
| Purchases*       |                  |  | Stacked rows / form        |
|                  |                  |  |                            |
| Staff  Sign out  | Page controls    |  | Page controls              |
+------------------+------------------+  +----------------------------+
```

`*` denotes a later workflow in the sketch, not a literal label in the product. Familiar actions use Lucide Menu, Plus, Search, Pencil, Printer, X, Trash2, ChevronLeft/Right, Eye/EyeOff, and LogOut where appropriate, with accessible names and tooltips. Text commands remain appropriate for New order, Review, Confirm order, Record payment, Record purchase, and Record preparation.

Use neutral surfaces/dark text, green for success, amber for warnings, and red for errors, always with labels. Spacing follows a 4/8/12/16/24-pixel scale, body text 16 pixels, compact headings 20-24 pixels; no viewport-scaled fonts. Touch actions have 44-pixel targets. Break long names/addresses into lines, keep amount labels with their values, and let action rows wrap independently. Use full-width sections rather than decorative floating cards.

## Sign-In (Phase 1)

```text
Desktop                                  Phone
+-------------------------------------+  +----------------------------+
| Food reservations                   |  | Food reservations          |
| Staff sign-in                       |  | Staff sign-in              |
| Username [_________________]        |  | Username                   |
| Password [_______________] Eye      |  | [______________________]   |
| Field / connection error            |  | Password                   |
| [Sign in]                           |  | [__________________] Eye   |
|                                     |  | Error                      |
+-------------------------------------+  | [Sign in]                  |
                                         +----------------------------+
```

Initial focus follows normal reading order; password visibility preserves focus. Pending disables repeat submission. Failed credentials retain username; connection failure offers explicit retry. Expiry uses this same view with an expired-session message and safe return route. Successful sign-in never repeats the action that expired.

## Dashboard (Phase 3, Expanded in Phases 5/7)

```text
Desktop                                  Phone
+-------------------------------------+  +----------------------------+
| Dashboard              + New order  |  | Menu  Dashboard            |
| Today: business date / timezone     |  | + New order                |
| Time  Customer  Method Status Due   |  | Today: date / timezone     |
| 12:00 Sample A  Pickup Ready  35.00  |  | 12:00  Sample A             |
| ...                                 |  | Pickup  Ready  Due 35.00    |
| Upcoming pickups / deliveries       |  | Order reference link       |
| Date/time  Customer  Method Due     |  | Upcoming                   |
| ...                                 |  | Date/time  Sample B         |
| Low stock* -> ingredient links      |  | Delivery  Due 80.00         |
| Preparation*  Date range  Open      |  | Low stock*                 |
+-------------------------------------+  | Preparation* Date / Open   |
                                         +----------------------------+
```

Rows open order details; full-day/order links expose additional paginated results. Preparation/payment status stay separate. Empty today says no orders today; failure shows retry and never implies an empty day. Later warnings link to affected ingredients/recipes. Display business timezone adjacent to date selection.

## Orders (Phase 3)

```text
Desktop                                  Phone
+-------------------------------------+  +----------------------------+
| Orders                 + New order  |  | Menu  Orders               |
| Search  From/To  Status  Clear       |  | + New order                |
| Ref Customer Date Method Total Due  |  | Search                     |
|     Preparation / payment statuses  |  | From / To  Status  Clear   |
| ORD1 Sample A ... 215.00 35.00       |  | ORD1  Sample A             |
|     Ready / Partial                 |  | Pickup: date and time      |
| ...                                 |  | Ready / Partial            |
| Sort   Previous  Page 1/4  Next      |  | Total 215.00  Due 35.00     |
+-------------------------------------+  | Previous  Page 1/4  Next    |
                                         +----------------------------+
```

Reference/customer is an actual keyboard/touch link. A dataset with no orders offers New order; filtered no-results offers Clear filters. Preserve search/date/status/sort/page and return scroll when opening details. Credit uses an explicit Credit label in the balance area.

## Reservation Entry and Edit (Phase 3)

```text
Desktop                                  Phone
+-------------------------------------+  +----------------------------+
| Back  New order / Edit ORD1          |  | Back  New order            |
| Customer                            |  | Customer                   |
| Name [________] Phone [________]    |  | Name [________________]    |
| Notes [________________________]    |  | Phone [_______________]    |
| Fulfillment                         |  | Notes [_______________]    |
| (Pickup | Delivery) Date Time Zone   |  | Pickup | Delivery          |
| Address if delivery                 |  | Date  Time  Timezone        |
| Items                      + Add    |  | Address if delivery        |
| Food/variant Unit Qty Total Remove  |  | Items                 + Add|
| Caldereta M   tray  2 160.00   X     |  | Caldereta / Medium         |
| Shanghai     package 1 55.00   X     |  | Quantity [2] trays         |
| Per-line preparation notes          |  | Notes  Line total 160.00  X |
| Subtotal / Delivery / Tax / Total   |  | Shanghai / 100 pieces      |
| [Save pending] [Review]             |  | Quantity [1] package       |
+-------------------------------------+  | Total / Delivery / Tax     |
                                         | [Save pending] [Review]    |
                                         +----------------------------+
```

Searchable food/variant selection shows available confirmed options for live orders and explicit units; fixture options remain labeled provisional. Show package quantity as packages with contents, e.g. 2 packages of 100 pieces. Keep notes and remove targets stable while text wraps. Existing line snapshots stay visible in edit mode; blocked prepared-line changes show the backend reason.

Totals request backend quotes as draft values change; indicate calculating/stale/unavailable without presenting old values as current. Save pending also requires a current quote. Submission errors focus the first invalid field and retain input. Unsaved navigation asks for a clear leave/stay decision. An uncertain save blocks a new attempt and exposes Check status.

## Reservation Review (Phase 3)

```text
Desktop                                  Phone
+-------------------------------------+  +----------------------------+
| Back to edit          Review order  |  | Back to edit               |
| Customer / contact                  |  | Review order               |
| Pickup/delivery: date time timezone  |  | Customer / phone           |
| Address or pickup location          |  | Fulfillment / location     |
| Item / unit / qty / agreed price    |  | Items and quantities       |
| Subtotal                  215.00     |  | 2 medium trays / 160.00     |
| Delivery                    0.00     |  | 1 package / 55.00          |
| Tax                         0.00     |  | Subtotal / Delivery / Tax   |
| Total                     215.00     |  | Total 215.00               |
| Credit acknowledgment if required   |  | Credit acknowledgment      |
| [Edit] [Confirm order / Save changes]|  | [Edit] [Confirm order]     |
+-------------------------------------+  +----------------------------+
```

Review contains the backend quote and all entered fulfillment/notes. Expired quotes require refresh and review before save. Saving an existing order retains status. Show any credit resulting from the edit and require an acknowledgment before the edit; refund is a separate workflow. Quote failure preserves the draft and offers retry/edit.

## Order Details, Payment, and Conflict (Phases 3/4)

```text
Desktop                                  Phone
+-------------------------------------+  +----------------------------+
| Back  ORD1             Edit  Print  |  | Back  ORD1       Edit Print|
| Sample A  Phone   Ready / Partial   |  | Sample A / phone           |
| Fulfillment: time zone location     |  | Ready / Partial            |
| Snapshot items / notes / quantities |  | Fulfillment / location     |
| Totals / paid / due / credit        |  | Snapshot items / notes     |
| [Next status] [Record payment]      |  | Total / Paid / Due / Credit|
| Payments / refunds  Date Amt Method |  | [Next status]              |
| [Refund]   Status history           |  | [Record payment]           |
| Cancel with reason / stock warning  |  | Payments / refunds         |
+-------------------------------------+  | History  Refund / Cancel   |
                                         +----------------------------+
```

Record payment/refund opens a labeled dialog on desktop and a full-width dialog on phones, with amount/date/method/reference/note and Save/Cancel. Refund also selects the original payment and requires a reason/confirmation. Entered values survive field/network failures; pending/uncertain state prevents another attempt. Closing an unresolved operation leaves a visible detail-level Check status action.

Cancellation review shows remaining/prepared quantities, consumed-stock warning, and refundable credit without silently restoring stock. Unavailable next actions have an explanatory reason. Conflict review uses a desktop side-by-side draft/latest comparison and phone stacked, field-labeled comparison; resolution returns to entry/review, retaining draft input. Print uses the order's snapshots and current due/credit and hides navigation, dialogs, and editing actions.

## Menu & Recipes (Phases 2/6)

```text
Desktop                                  Phone
+-------------------------------------+  +----------------------------+
| Menu & Recipes            + Food    |  | Menu  Menu & Recipes       |
| Search  Category  Availability      |  | + Add food                 |
| Food / category / availability Edit |  | Search / category          |
| Caldereta                           |  | Availability               |
| Small tray 60.00 Available Edit     |  | Caldereta                  |
| Medium tray 80.00 Available Edit    |  | Medium tray 80.00  Edit    |
| Recipe* / estimate* per variant     |  | Available [toggle]         |
| Previous  Page 1  Next              |  | Recipe* / estimate*        |
+-------------------------------------+  | Previous  Page 1  Next      |
                                         +----------------------------+
```

Food editor contains name/category/description/availability; variant editor contains label/unit/price/availability/package contents. A confirmation badge shows provisional items distinctly; availability cannot override live-confirmation gates. Phase 6 exposes recipe editor per variant, yield for one sellable unit, ingredient rows/units, and selling price/ingredient cost/contribution with purchase dates. Missing recipe/prices display Incomplete and links to fix affected records, not zero estimates.

## Ingredients (Phase 5)

```text
Desktop                                  Phone
+-------------------------------------+  +----------------------------+
| Ingredients            + Ingredient |  | Menu  Ingredients          |
| Search   Low stock [checkbox]       |  | + Ingredient               |
| Name Unit Stock Threshold Cost Date |  | Search  Low stock [check]  |
| ...                            Open |  | Ingredient name            |
| Detail: movements / purchase links  |  | Stock 2000 g               |
| [Opening stock] [Waste] [Correction]|  | Threshold / latest cost    |
| Preview: before -> delta -> after   |  | Open -> detail             |
+-------------------------------------+  | Movements / adjustments    |
                                         +----------------------------+
```

Unknown cost/date has an explicit unknown state. Add/edit specifies base unit and optional threshold. Movement detail links to receipts/preparation. Adjustment form shows signed quantity and required reason; review shows before/change/after stock. Keep physical stock and planning figures separately labeled. Incompatible units/errors preserve form data.

## Purchases (Phase 5)

```text
Desktop                                  Phone
+-------------------------------------+  +----------------------------+
| Purchases        + Record purchase  |  | Menu  Purchases            |
| Search / supplier / date range      |  | + Record purchase          |
| Receipt Date Supplier Total Open    |  | Supplier / date filters    |
| ...                                 |  | Receipt / supplier         |
| Entry: Date Supplier Note           |  | Date  Total  Open          |
| Ingredient Qty Unit Pack Cost       |  | Entry: Date / Supplier     |
| ...                     + Add item  |  | Ingredient                 |
| Preview: normalized qty / unit cost |  | Quantity / Unit / Pack     |
| [Review] then [Save purchase]        |  | Total ingredient cost      |
+-------------------------------------+  | + Add / Review / Save      |
                                         +----------------------------+
```

Pack fields appear only for bags/bottles/boxes. Review displays normalized quantity, comparable cost, and stock changes, all returned by backend. Saved receipt and price history stay accessible. Empty receipts offers Record purchase; no filtered match offers Clear filters. Uncertain save provides Check status before another receipt can be submitted.

## Preparation (Phase 7)

```text
Desktop                                  Phone
+-------------------------------------+  +----------------------------+
| Dashboard > Preparation             |  | Back  Preparation          |
| From / To          Record preparation| | From / To                  |
| Food Unit Ordered Prepared Remaining|  | [Record preparation]       |
| ...                 Order links     |  | Food / variant / unit      |
| Missing recipes / affected links    |  | Ordered / prepared / left  |
| Ingredient Stock Earlier Demand Gap |  | Contributing order links   |
| Shopping list                       |  | Stock / earlier / demand   |
| Entry: allocations / actual usage   |  | Missing recipe links       |
| Preview: count + stock changes      |  | Shopping list              |
+-------------------------------------+  | Entry -> Review -> Save     |
                                         +----------------------------+
```

Preparation entry selects remaining order-line quantities and explicit actual ingredient usage. Review shows versioned allocations, snapshot cost completeness, and stock before/after. Nothing consumes stock before backend-confirmed save. After success refresh demand/stock and available status actions. Corrections use a separate reviewed form with reason, changed prepared counts, and explicit signed stock movements.

## Shopping and Print (Phase 7)

```text
Desktop                                  Phone
+-------------------------------------+  +----------------------------+
| Back  Shopping list          Print  |  | Back  Shopping list  Print |
| Period / timezone / calculated time |  | Period / timezone          |
| Incomplete warning + recipe links   |  | Incomplete warning         |
| Ingredient Unit Earlier Period Buy  |  | Ingredient name            |
| ...                                 |  | Base unit / shortage       |
| Earlier shortage shown separately   |  | Earlier shortage           |
+-------------------------------------+  +----------------------------+
```

Use backend cumulative shortage through the chosen period; earlier/selected demand labels explain the values without duplicating commitments. Unknown demand keeps a visible Incomplete warning on screen and print. Complete zero-shortage state says no shortages for the period; an incomplete calculation cannot assert that nothing is needed. Print repeats table headers, avoids splitting ingredient/item rows where practical, preserves units/period/warnings, and hides application controls.

## State Coverage and Responsive Verification Handoff

| View | Empty / no-results | Recoverable failure | Success |
|---|---|---|---|
| Sign-in | Blank labeled form | Credentials/connection/expiry feedback | Return to requested route |
| Dashboard | No orders today / no upcoming orders | Retry each failed data section | Updated order summary after mutation |
| Orders | No reservations / no matching results | Retry preserving query state | Refreshed rows/status/balance |
| Entry/review | No item rows prompts Add item | Field errors, stale quote, conflict, uncertain operation | Open confirmed saved order |
| Details | No payments/history entries where applicable | Retry / Check status / conflict review | Announced status/payment/refund result |
| Menu & Recipes | No foods / no matches / incomplete estimate | Retained editor and linked missing basis | Saved variant/recipe |
| Ingredients | No ingredients / no matches / no movements | Retained adjustment / refresh stale stock | Confirmed movement and stock |
| Purchases | No receipts / no matches | Conversion errors / retained receipt / Check status | Saved receipt and stock |
| Preparation | No eligible remaining demand | Missing recipes / stock bounds / conflict / Check status | Recorded counts and physical stock |
| Shopping | No shortages when complete | Retry / incomplete-demand warning | Current backend shopping snapshot |

Every view also has a loading state distinct from empty/failure; save results use an announced live region, and errors associate with their fields. Do not clear forms until confirmed success. Dialogs trap focus, support keyboard dismissal when safe, and return focus to the trigger. Verify at 320/375/768/1280 pixels and 200% zoom in later implementation, including long names/addresses and large amounts. These sketches specify the checks; they do not mark those browser checks complete.
