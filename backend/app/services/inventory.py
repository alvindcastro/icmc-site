import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Context, Decimal, localcontext
from functools import partial
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.actions import PermittedAction, allowed, blocked
from app.errors import ApiError, FieldError, invalid
from app.ids import new_id
from app.listing import Page, PageQuery, page_of, select_page
from app.persistence.models import (
    BusinessSettings,
    Ingredient,
    Preview,
    Purchase,
    PurchaseLine,
    StaffUser,
    StockMovement,
)
from app.schemas.inventory import (
    IngredientCreate,
    IngredientOut,
    IngredientQuery,
    IngredientUpdate,
    MovementIn,
    MovementOut,
    MovementPreviewOut,
    MovementSave,
    PriceOut,
    PurchaseDraftIn,
    PurchaseLineIn,
    PurchaseOut,
    PurchasePreviewOut,
    PurchaseQuery,
    PurchaseSave,
    PurchaseSummaryOut,
)
from app.services import business_settings
from app.services.counters import next_number
from app.services.versions import advance, require_current
from app.values import (
    MAX_SAFE_INTEGER,
    ValueRejected,
    format_quantity,
    format_unit_cost,
    parse_quantity,
)

PREVIEW_SECONDS = 300
# The only conversions there are: within a dimension, by exact factors. No density, no
# count-to-weight, and no assumed size for a bag, bottle or box.
_COMPATIBLE = {"g": ("g", "kg"), "ml": ("ml", "l"), "piece": ("piece",)}
_FACTOR = {"kg": 1000, "l": 1000}
_PACKS = ("bag", "bottle", "box")
# The most of anything that can be in stock, in thousandths of its base unit.
_LIMIT = MAX_SAFE_INTEGER * 1000


def _hash(value: object) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8", "surrogatepass")).hexdigest()


def _stale() -> ApiError:
    return ApiError(
        409, "quote_stale", "This preview is out of date. Review a new one before saving."
    )


def _not_found(what: str) -> ApiError:
    return ApiError(404, "not_found", f"This {what} does not exist.")


def unit_cost(total_minor: int, minor_digits: int, base_thousandths: int) -> Decimal:
    """The exact cost of one base unit, in major currency. Rounded only when it is displayed."""
    with localcontext(Context(prec=60)):
        return Decimal(total_minor) * 1000 / (Decimal(10) ** minor_digits * base_thousandths)


def _line_cost(line: PurchaseLine) -> str | None:
    return format_unit_cost(
        unit_cost(line.total_cost_minor, line.purchase.minor_digits, line.base_thousandths)
    )


def _permitted(ingredient: Ingredient) -> dict[str, PermittedAction]:
    return {
        "edit": allowed(),
        "opening": allowed()
        if ingredient.movement_count == 0
        else blocked("opening_used", "Opening stock can only be entered before any movement."),
        "waste": allowed(),
        "correction": allowed(),
    }


def ingredient_out(ingredient: Ingredient) -> IngredientOut:
    threshold = ingredient.threshold_thousandths
    latest = ingredient.latest_line
    return IngredientOut.model_validate(
        {
            "id": ingredient.id,
            "version": ingredient.version,
            "name": ingredient.name,
            "base_unit": ingredient.base_unit,
            "low_stock_threshold": None if threshold is None else format_quantity(threshold),
            "stock_on_hand": format_quantity(ingredient.stock_thousandths),
            "low_stock": threshold is not None and ingredient.stock_thousandths <= threshold,
            "latest_unit_cost": _line_cost(latest) if latest is not None else None,
            "latest_purchase_date": latest.purchase.purchased_on if latest is not None else None,
            "permitted_actions": _permitted(ingredient),
        }
    )


def _latest(ingredient: Ingredient) -> Any:
    return ingredient_out(ingredient).model_dump(mode="json")


def movement_out(movement: StockMovement) -> MovementOut:
    return MovementOut.model_validate(
        {
            "id": movement.id,
            "ingredient_id": movement.ingredient_id,
            "delta_base_quantity": format_quantity(movement.delta_thousandths),
            "before_quantity": format_quantity(movement.before_thousandths),
            "after_quantity": format_quantity(movement.after_thousandths),
            "type": movement.type,
            "reason": movement.reason,
            "purchase_id": movement.purchase_id,
            "preparation_id": movement.preparation_id,
            "corrects_movement_id": movement.corrects_movement_id,
            "operation_id": movement.operation_id,
            "recorded_at": movement.recorded_at,
            "recorded_by": movement.actor_display_name,
        }
    )


def _receipt_line(line: PurchaseLine) -> dict[str, Any]:
    contents = (
        None
        if line.pack_quantity is None
        else {"quantity": line.pack_quantity, "unit": line.pack_unit}
    )
    return {
        "id": line.id,
        "ingredient_id": line.ingredient_id,
        "ingredient_name": line.ingredient_name,
        "base_unit": line.base_unit,
        "quantity": line.quantity,
        "unit": line.unit,
        "pack_contents": contents,
        "base_quantity": format_quantity(line.base_thousandths),
        "unit_cost": _line_cost(line),
        "total_cost_minor": line.total_cost_minor,
        "stock_movement_id": line.stock_movement_id,
    }


def purchase_out(purchase: Purchase) -> PurchaseOut:
    return PurchaseOut.model_validate(
        {
            "id": purchase.id,
            "reference": purchase.reference,
            "purchased_on": purchase.purchased_on,
            "supplier": purchase.supplier,
            "note": purchase.note,
            "currency": purchase.currency,
            "minor_digits": purchase.minor_digits,
            "total_cost_minor": purchase.total_cost_minor,
            "items": [_receipt_line(line) for line in purchase.lines],
            "operation_id": purchase.operation_id,
            "recorded_at": purchase.recorded_at,
            "recorded_by": purchase.actor_display_name,
        }
    )


def _price_out(line: PurchaseLine) -> PriceOut:
    purchase = line.purchase
    return PriceOut.model_validate(
        {
            **_receipt_line(line),
            "purchase_id": purchase.id,
            "reference": purchase.reference,
            "supplier": purchase.supplier,
            "purchased_on": purchase.purchased_on,
            "recorded_at": purchase.recorded_at,
            "currency": purchase.currency,
            "minor_digits": purchase.minor_digits,
        }
    )


def _threshold(text: str | None, unit: str) -> int | None:
    if text is None:
        return None
    try:
        return parse_quantity(text, unit)
    except ValueRejected as problem:
        raise invalid(FieldError("/low_stock_threshold", problem.code, problem.message)) from None


def get_ingredient(db: Session, ingredient_id: str) -> Ingredient:
    ingredient = db.get(Ingredient, ingredient_id)
    if ingredient is None:
        raise _not_found("ingredient")
    return ingredient


def create_ingredient(db: Session, body: IngredientCreate, now: datetime) -> Ingredient:
    ingredient = Ingredient(
        id=new_id("ing"),
        version=1,
        name=body.name,
        name_key=body.name.casefold(),
        base_unit=body.base_unit,
        threshold_thousandths=_threshold(body.low_stock_threshold, body.base_unit),
        stock_thousandths=0,
        movement_count=0,
        latest_line_id=None,
        created_at=now,
        updated_at=now,
    )
    db.add(ingredient)
    return ingredient


def update_ingredient(
    db: Session, ingredient_id: str, body: IngredientUpdate, now: datetime
) -> Ingredient:
    """Change an ingredient's name or warning level. Its unit, stock and prices are not
    something an edit can touch."""
    ingredient = get_ingredient(db, ingredient_id)
    changes = body.changes()
    if "low_stock_threshold" in changes:
        threshold = _threshold(changes["low_stock_threshold"], ingredient.base_unit)
    advance(ingredient, body.expected_version, "ingredient", lambda: _latest(ingredient))
    if "name" in changes:
        ingredient.name = changes["name"]
        ingredient.name_key = ingredient.name.casefold()
    if "low_stock_threshold" in changes:
        ingredient.threshold_thousandths = threshold
    ingredient.updated_at = now
    return ingredient


def find_ingredients(db: Session, query: IngredientQuery) -> Page[IngredientOut]:
    statement = select(Ingredient)
    text = (query.q or "").strip()
    if text:
        statement = statement.where(Ingredient.name_key.contains(text.casefold(), autoescape=True))
    if query.low_stock is not None:
        # Low stock needs a threshold: an ingredient without one is never low.
        low = Ingredient.threshold_thousandths.is_not(None) & (
            Ingredient.stock_thousandths <= Ingredient.threshold_thousandths
        )
        statement = statement.where(low if query.low_stock == "true" else ~low)
    found, total = select_page(db, statement, query, Ingredient.name_key, tie_breaker=Ingredient.id)
    return page_of([ingredient_out(ingredient) for ingredient in found], total, query)


def list_movements(db: Session, ingredient_id: str, query: PageQuery) -> Page[MovementOut]:
    ingredient = get_ingredient(db, ingredient_id)
    statement = select(StockMovement).where(StockMovement.ingredient_id == ingredient.id)
    # Newest first. Several movements can share a second, so their own order settles it.
    found, total = select_page(
        db,
        statement,
        query,
        StockMovement.recorded_at.desc(),
        StockMovement.sequence.desc(),
        tie_breaker=StockMovement.id.desc(),
    )
    return page_of([movement_out(movement) for movement in found], total, query)


def list_prices(db: Session, ingredient_id: str, query: PageQuery) -> Page[PriceOut]:
    ingredient = get_ingredient(db, ingredient_id)
    statement = (
        select(PurchaseLine).join(Purchase).where(PurchaseLine.ingredient_id == ingredient.id)
    )
    found, total = select_page(
        db,
        statement,
        query,
        Purchase.purchased_on.desc(),
        Purchase.recorded_at.desc(),
        tie_breaker=PurchaseLine.id.desc(),
    )
    return page_of([_price_out(line) for line in found], total, query)


# --- Stock movements -------------------------------------------------------------------------


def _move(
    db: Session,
    ingredient: Ingredient,
    delta: int,
    kind: str,
    reason: str,
    key: str,
    actor: StaffUser,
    now: datetime,
    *,
    purchase_id: str | None = None,
    preparation_id: str | None = None,
    corrects_movement_id: str | None = None,
) -> StockMovement:
    """Add one movement and move the stock with it. Every change to stock goes through here,
    which is what keeps stock on hand equal to the sum of the movements."""
    before = ingredient.stock_thousandths
    movement = StockMovement(
        id=new_id("mov"),
        ingredient_id=ingredient.id,
        sequence=ingredient.movement_count,
        delta_thousandths=delta,
        before_thousandths=before,
        after_thousandths=before + delta,
        type=kind,
        reason=reason,
        purchase_id=purchase_id,
        preparation_id=preparation_id,
        corrects_movement_id=corrects_movement_id,
        operation_id=key,
        recorded_at=now,
        actor_id=actor.id,
        actor_display_name=actor.display_name,
    )
    db.add(movement)
    ingredient.stock_thousandths = before + delta
    ingredient.movement_count += 1
    ingredient.updated_at = now
    # Written now, so that whatever refers to this movement next finds it there.
    db.flush()
    return movement


def _review_movement(db: Session, ingredient: Ingredient, body: MovementIn) -> int:
    """Check a hand-entered movement and return the change in thousandths.

    What is wrong with the entry itself is reported first. Then the version, so that staff
    looking at an old count are shown the new one. Only then is the entry judged against the
    shelf as it is now: opening only before any movement, and never less than nothing left.
    """
    problems: list[FieldError] = []
    delta = 0
    try:
        delta = parse_quantity(body.delta_base_quantity, ingredient.base_unit, signed=True)
    except ValueRejected as problem:
        problems.append(FieldError("/delta_base_quantity", problem.code, problem.message))
    else:
        wrong = None
        if delta == 0:
            wrong = "Enter a change that is not zero."
        elif body.type == "opening" and delta < 0:
            wrong = "Opening stock adds to the shelf."
        elif body.type == "waste" and delta > 0:
            wrong = "Waste removes from the shelf; enter a negative change."
        if wrong:
            problems.append(FieldError("/delta_base_quantity", "invalid_change", wrong))
    if body.preparation_id is not None:
        problems.append(
            FieldError(
                "/preparation_id",
                "preparation_recording_disabled",
                "Preparation recording is not enabled.",
            )
        )
    if body.corrects_movement_id is not None:
        related = db.get(StockMovement, body.corrects_movement_id)
        if related is None or related.ingredient_id != ingredient.id:
            problems.append(
                FieldError(
                    "/corrects_movement_id",
                    "unknown_movement",
                    "Choose a movement of this ingredient.",
                )
            )
    if problems:
        raise invalid(*problems)
    require_current(ingredient, body.expected_version, "ingredient", lambda: _latest(ingredient))
    action = _permitted(ingredient)[body.type]
    if not action.allowed:
        raise invalid(FieldError("/type", action.reason_code or "", action.reason or ""))
    after = ingredient.stock_thousandths + delta
    if after < 0:
        raise invalid(
            FieldError(
                "/delta_base_quantity",
                "insufficient_stock",
                "This would leave less than nothing in stock.",
            )
        )
    if after > _LIMIT:
        raise invalid(
            FieldError(
                "/delta_base_quantity", "overflow", "This would be more stock than can be recorded."
            )
        )
    return delta


def _movement_fingerprint(body: MovementIn, delta: int) -> str:
    """What was reviewed, after validation: `100` and `100.000` are the same movement."""
    return _hash(
        [
            body.expected_version,
            body.type,
            delta,
            body.reason,
            body.preparation_id,
            body.corrects_movement_id,
        ]
    )


def _remember(
    db: Session, kind: str, subject_id: str, fingerprint: str, dependencies: object, now: datetime
) -> Preview:
    # Previews are free to ask for, so finished ones are cleared as new ones arrive.
    db.execute(delete(Preview).where(Preview.expires_at <= now))
    preview = Preview(
        id=new_id("prev"),
        kind=kind,
        subject_id=subject_id,
        input_fingerprint=fingerprint,
        dependencies=json.dumps(dependencies),
        expires_at=now + timedelta(seconds=PREVIEW_SECONDS),
        created_at=now,
    )
    db.add(preview)
    return preview


def _spend(
    db: Session, preview_id: str, kind: str, subject_id: str, fingerprint: str, now: datetime
) -> Preview:
    """The preview a save refers to, if it is still the one that was reviewed. It is spent by
    the save, so the same review cannot be saved twice under different operation keys."""
    preview = db.get(Preview, preview_id)
    if (
        preview is None
        or preview.kind != kind
        or preview.subject_id != subject_id
        or now >= preview.expires_at
        or preview.input_fingerprint != fingerprint
    ):
        raise _stale()
    db.delete(preview)
    return preview


def preview_movement(
    db: Session, ingredient_id: str, body: MovementIn, now: datetime
) -> MovementPreviewOut:
    ingredient = get_ingredient(db, ingredient_id)
    delta = _review_movement(db, ingredient, body)
    preview = _remember(db, "movement", ingredient.id, _movement_fingerprint(body, delta), {}, now)
    return MovementPreviewOut(
        id=preview.id,
        expires_at=preview.expires_at,
        ingredient_id=ingredient.id,
        expected_version=ingredient.version,
        before_quantity=format_quantity(ingredient.stock_thousandths),
        delta_base_quantity=format_quantity(delta),
        after_quantity=format_quantity(ingredient.stock_thousandths + delta),
    )


def save_movement(
    db: Session, ingredient_id: str, body: MovementSave, key: str, actor: StaffUser, now: datetime
) -> tuple[StockMovement, Ingredient]:
    ingredient = get_ingredient(db, ingredient_id)
    delta = _review_movement(db, ingredient, body)
    _spend(db, body.preview_id, "movement", ingredient.id, _movement_fingerprint(body, delta), now)
    movement = _move(
        db,
        ingredient,
        delta,
        body.type,
        body.reason,
        key,
        actor,
        now,
        corrects_movement_id=body.corrects_movement_id,
    )
    ingredient.version += 1
    return movement, ingredient


# --- Purchases -------------------------------------------------------------------------------


@dataclass(frozen=True)
class ReviewedLine:
    item: PurchaseLineIn
    ingredient: Ingredient
    base: int
    before: int

    @property
    def after(self) -> int:
        return self.before + self.base


@dataclass(frozen=True)
class ReviewedPurchase:
    settings: BusinessSettings
    lines: list[ReviewedLine]
    total: int

    def bound(self) -> dict[str, Any]:
        """The versions the review was made against: what a save must find unchanged."""
        return {
            "settings": self.settings.version,
            "ingredients": {line.ingredient.id: line.ingredient.version for line in self.lines},
        }


def _base_quantity(
    item: PurchaseLineIn, ingredient: Ingredient | None
) -> tuple[int, list[tuple[str, str, str]]]:
    """A row's quantity in thousandths of its ingredient's base unit, or what is wrong with it."""
    problems: list[tuple[str, str, str]] = []
    packed = item.unit in _PACKS
    count = 0
    try:
        # Packs and pieces are counted, so their quantity is whole.
        count = parse_quantity(item.quantity, "piece" if packed or item.unit == "piece" else "g")
        if count == 0:
            problems.append(("quantity", "zero", "Enter a quantity above zero."))
    except ValueRejected as problem:
        problems.append(("quantity", problem.code, problem.message))
    physical: str | None = item.unit
    contents = 1000
    if packed:
        physical = None
        if item.pack_contents is None:
            problems.append(
                ("pack_contents/quantity", "required", "Declare what one pack contains.")
            )
        else:
            physical = item.pack_contents.unit
            try:
                contents = parse_quantity(
                    item.pack_contents.quantity, "piece" if physical == "piece" else "g"
                )
                if contents == 0:
                    problems.append(
                        ("pack_contents/quantity", "zero", "Declare contents above zero.")
                    )
            except ValueRejected as problem:
                problems.append(("pack_contents/quantity", problem.code, problem.message))
    elif item.pack_contents is not None:
        problems.append(
            ("pack_contents/quantity", "not_a_pack", "Only a bag, bottle or box has contents.")
        )
    if (
        ingredient is not None
        and physical is not None
        and physical not in _COMPATIBLE[ingredient.base_unit]
    ):
        problems.append(
            (
                "unit",
                "incompatible_unit",
                f"{ingredient.name} is measured in {ingredient.base_unit}; "
                "this unit cannot be converted to it.",
            )
        )
    if problems or physical is None:
        return 0, problems
    return count * contents // 1000 * _FACTOR.get(physical, 1), problems


def _review_purchase(db: Session, draft: PurchaseDraftIn) -> ReviewedPurchase:
    """Check a receipt against the stockroom as it is now and normalize every row. Rows are
    taken in order, so rows for the same ingredient build on each other."""
    settings = business_settings.require(db)
    problems: list[FieldError] = []
    lines: list[ReviewedLine] = []
    running: dict[str, int] = {}
    seen: set[str] = set()
    for index, item in enumerate(draft.items):
        at = f"/draft/items/{index}"
        found: list[tuple[str, str, str]] = []
        if item.client_line_id in seen:
            found.append(("client_line_id", "duplicate", "Row identifiers must differ."))
        seen.add(item.client_line_id)
        ingredient = db.get(Ingredient, item.ingredient_id)
        if ingredient is None:
            found.append(("ingredient_id", "unknown_ingredient", "Choose an ingredient."))
        base, wrong = _base_quantity(item, ingredient)
        found += wrong
        if ingredient is not None and not found:
            before = running.get(ingredient.id, ingredient.stock_thousandths)
            if base > _LIMIT or before + base > _LIMIT:
                found.append(("quantity", "overflow", "This is more stock than can be recorded."))
            else:
                running[ingredient.id] = before + base
                lines.append(ReviewedLine(item, ingredient, base, before))
        problems += [FieldError(f"{at}/{name}", code, message) for name, code, message in found]
    total = sum(item.total_cost_minor for item in draft.items)
    if total > MAX_SAFE_INTEGER:
        problems.append(FieldError("/draft/items", "overflow", "The receipt total is too large."))
    if problems:
        raise invalid(*problems)
    return ReviewedPurchase(settings, lines, total)


def _purchase_fingerprint(draft: PurchaseDraftIn) -> str:
    return _hash(draft.model_dump(mode="json"))


def preview_purchase(db: Session, draft: PurchaseDraftIn, now: datetime) -> PurchasePreviewOut:
    reviewed = _review_purchase(db, draft)
    preview = _remember(db, "purchase", "", _purchase_fingerprint(draft), reviewed.bound(), now)
    digits = reviewed.settings.minor_digits
    return PurchasePreviewOut.model_validate(
        {
            "id": preview.id,
            "expires_at": preview.expires_at,
            "currency": reviewed.settings.currency,
            "minor_digits": digits,
            "total_cost_minor": reviewed.total,
            "items": [
                {
                    "client_line_id": line.item.client_line_id,
                    "ingredient_id": line.ingredient.id,
                    "base_quantity": format_quantity(line.base),
                    "base_unit": line.ingredient.base_unit,
                    "total_cost_minor": line.item.total_cost_minor,
                    "unit_cost": format_unit_cost(
                        unit_cost(line.item.total_cost_minor, digits, line.base)
                    ),
                    "ingredient_version": line.ingredient.version,
                    "before_quantity": format_quantity(line.before),
                    "after_quantity": format_quantity(line.after),
                }
                for line in reviewed.lines
            ],
        }
    )


def _newer(purchase: Purchase, line: PurchaseLine, current: PurchaseLine | None) -> bool:
    """Whether a new receipt line becomes the cost basis: the latest purchase date wins, then
    the later entry, so an old receipt entered today does not replace a newer price."""
    if current is None:
        return True
    return (purchase.purchased_on, purchase.recorded_at, line.id) > (
        current.purchase.purchased_on,
        current.purchase.recorded_at,
        current.id,
    )


def save_purchase(
    db: Session, body: PurchaseSave, key: str, actor: StaffUser, now: datetime
) -> tuple[Purchase, list[Ingredient]]:
    """Commit a reviewed receipt: its lines, one stock movement per line, the stock and the
    cost basis, all in the caller's transaction or not at all."""
    preview = _spend(db, body.preview_id, "purchase", "", _purchase_fingerprint(body.draft), now)
    reviewed = _review_purchase(db, body.draft)
    bound = json.loads(preview.dependencies)
    if bound["settings"] != reviewed.settings.version:
        raise _stale()
    for line in reviewed.lines:
        ingredient = line.ingredient
        require_current(
            ingredient,
            bound["ingredients"].get(ingredient.id, 0),
            "ingredient",
            partial(_latest, ingredient),
        )
    number = next_number(db, "purchase_reference")
    # Development receipts are marked as such in the reference, like development orders.
    live = reviewed.settings.environment == "live"
    reference = f"PUR-{number:04d}" if live else f"DEV-P{number:04d}"
    draft = body.draft
    purchase = Purchase(
        id=new_id("pur"),
        reference=reference,
        number=number,
        purchased_on=draft.purchased_on,
        supplier=draft.supplier,
        supplier_key=draft.supplier.casefold(),
        search_key=f"{reference} {draft.supplier}".casefold(),
        note=draft.note,
        currency=reviewed.settings.currency,
        minor_digits=reviewed.settings.minor_digits,
        total_cost_minor=reviewed.total,
        operation_id=key,
        recorded_at=now,
        actor_id=actor.id,
        actor_display_name=actor.display_name,
    )
    db.add(purchase)
    db.flush()
    changed: dict[str, Ingredient] = {}
    for position, line in enumerate(reviewed.lines):
        ingredient, item = line.ingredient, line.item
        movement = _move(
            db,
            ingredient,
            line.base,
            "purchase",
            purchase.reference,
            key,
            actor,
            now,
            purchase_id=purchase.id,
        )
        saved = PurchaseLine(
            id=new_id("pln"),
            position=position,
            ingredient_id=ingredient.id,
            ingredient_name=ingredient.name,
            base_unit=ingredient.base_unit,
            quantity=item.quantity,
            unit=item.unit,
            pack_quantity=item.pack_contents.quantity if item.pack_contents else None,
            pack_unit=item.pack_contents.unit if item.pack_contents else None,
            base_thousandths=line.base,
            total_cost_minor=item.total_cost_minor,
            stock_movement_id=movement.id,
        )
        purchase.lines.append(saved)
        db.flush()
        if _newer(purchase, saved, ingredient.latest_line):
            ingredient.latest_line = saved
        changed[ingredient.id] = ingredient
    # One version step per ingredient for the whole receipt, however many rows named it.
    for ingredient in changed.values():
        ingredient.version += 1
    return purchase, list(changed.values())


def find_purchases(db: Session, query: PurchaseQuery) -> Page[PurchaseSummaryOut]:
    statement = select(Purchase)
    text = (query.q or "").strip()
    if text:
        statement = statement.where(Purchase.search_key.contains(text.casefold(), autoescape=True))
    supplier = (query.supplier or "").strip()
    if supplier:
        statement = statement.where(
            Purchase.supplier_key.contains(supplier.casefold(), autoescape=True)
        )
    if query.date_from and query.date_to and query.date_from > query.date_to:
        raise invalid(
            FieldError("/query/date_to", "before_date_from", "End on or after the start date.")
        )
    if query.date_from:
        statement = statement.where(Purchase.purchased_on >= query.date_from)
    if query.date_to:
        statement = statement.where(Purchase.purchased_on <= query.date_to)
    # Newest purchase date first; receipts of one day in the order they were entered, newest first.
    found, total = select_page(
        db,
        statement,
        query,
        Purchase.purchased_on.desc(),
        Purchase.number.desc(),
        tie_breaker=Purchase.id.desc(),
    )
    summaries = [
        PurchaseSummaryOut(
            id=purchase.id,
            reference=purchase.reference,
            purchased_on=purchase.purchased_on,
            supplier=purchase.supplier,
            currency=purchase.currency,
            minor_digits=purchase.minor_digits,
            total_cost_minor=purchase.total_cost_minor,
            recorded_at=purchase.recorded_at,
        )
        for purchase in found
    ]
    return page_of(summaries, total, query)


def get_purchase(db: Session, purchase_id: str) -> Purchase:
    purchase = db.get(Purchase, purchase_id)
    if purchase is None:
        raise _not_found("receipt")
    return purchase
