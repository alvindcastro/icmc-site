import json
from dataclasses import dataclass
from datetime import datetime
from fractions import Fraction
from functools import partial
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.errors import ApiError, FieldError, OperatorError, invalid
from app.ids import new_id
from app.persistence.models import (
    BusinessSettings,
    CorrectionAllocation,
    CorrectionStock,
    Ingredient,
    Order,
    OrderItem,
    Preparation,
    PreparationAllocation,
    PreparationConsumption,
    PreparationCorrection,
    PurchaseLine,
    Recipe,
    StaffUser,
    Variant,
)
from app.schemas.menu import PackageContents
from app.schemas.preparations import (
    CorrectionIn,
    CorrectionOut,
    CorrectionPreviewOut,
    CorrectionSave,
    PreparationDraftIn,
    PreparationOut,
    PreparationPreviewIn,
    PreparationPreviewOut,
    PreparationSave,
)
from app.services import audit, business_settings, inventory, orders
from app.services.inventory import COMPATIBLE, FACTOR, STOCK_LIMIT
from app.services.planning import DEMAND
from app.services.versions import require_current
from app.values import MAX_SAFE_INTEGER, ValueRejected, format_quantity, parse_quantity

CONSUMED = "Preparation recorded"


def _not_found() -> ApiError:
    return ApiError(404, "not_found", "This preparation does not exist.")


def _contents(quantity: int | None) -> PackageContents | None:
    return None if quantity is None else PackageContents(quantity=quantity, unit="piece")


def _amount(text: str, *, signed: bool = False) -> object:
    """A quantity as it counts for "the same draft": `1.5` and `1.500` are one amount."""
    try:
        return parse_quantity(text, "g", signed=signed)
    except ValueRejected:
        return text


def _short(problems: list[FieldError]) -> ApiError:
    return ApiError(
        409,
        "insufficient_stock",
        "There is not enough on the shelf for this.",
        field_errors=problems,
    )


# --- Recording what was cooked ---------------------------------------------------------------


@dataclass(frozen=True)
class Cooked:
    """One allocation of a draft, with the order line it is for and the recipe of the day."""

    quantity: int
    expected_version: int
    order: Order
    line: OrderItem
    recipe: Recipe | None

    @property
    def before(self) -> int:
        return self.line.prepared_quantity or 0


@dataclass(frozen=True)
class Used:
    """One consumption row of a draft, in base units, with the receipt line that prices it."""

    quantity: str
    unit: str
    expected_version: int
    ingredient: Ingredient
    base: int
    basis: PurchaseLine | None


@dataclass(frozen=True)
class Reviewed:
    settings: BusinessSettings
    note: str
    cooked: list[Cooked]
    used: list[Used]
    cost: int | None

    def bound(self) -> dict[str, Any]:
        """What the result rests on beyond the versions the draft itself quotes."""
        return {
            "settings": self.settings.version,
            "recipes": {
                entry.line.variant_id: [entry.recipe.id, entry.recipe.version]
                if entry.recipe is not None
                else None
                for entry in self.cooked
            },
            "bases": {
                entry.ingredient.id: entry.basis.id if entry.basis is not None else None
                for entry in self.used
            },
        }


def _fingerprint(draft: PreparationDraftIn) -> str:
    """The draft as reviewed. Spelling that validation removes does not make it another one."""
    return inventory.fingerprint_of(
        [
            draft.prepared_on.isoformat(),
            draft.note.strip(),
            [
                [row.order_id, row.expected_version, row.order_item_id, row.quantity]
                for row in draft.allocations
            ],
            [
                [row.ingredient_id, row.expected_version, _amount(row.quantity), row.unit]
                for row in draft.consumption
            ],
        ]
    )


def _review(db: Session, draft: PreparationDraftIn) -> Reviewed:
    """Check a draft against the orders and the shelf as they are now. Nothing is changed.

    What is wrong with the draft itself is reported first, all of it. Then versions, so that
    staff looking at an old page are shown the new one. Only then the shelf: usage beyond
    what is there is refused, never trimmed.
    """
    settings = business_settings.require(db)
    problems: list[FieldError] = []
    cooked: list[Cooked] = []
    lines: set[str] = set()
    for index, row in enumerate(draft.allocations):
        at = f"/draft/allocations/{index}"
        order = db.get(Order, row.order_id)
        if order is None or not orders.recorded(order) or order.status not in DEMAND:
            problems.append(
                FieldError(
                    f"{at}/order_id",
                    "order_not_preparable",
                    "Choose a confirmed, preparing or ready order whose preparation is recorded.",
                )
            )
            continue
        line = next(
            (item for item in orders.active_lines(order) if item.id == row.order_item_id), None
        )
        if line is None or line.id in lines:
            problems.append(
                FieldError(
                    f"{at}/order_item_id",
                    "unknown_line" if line is None else "repeated_line",
                    "Choose a line of this order."
                    if line is None
                    else "Each order line appears once.",
                )
            )
            continue
        lines.add(line.id)
        left = line.quantity - (line.prepared_quantity or 0)
        if row.quantity > left:
            problems.append(
                FieldError(
                    f"{at}/quantity",
                    "exceeds_remaining",
                    f"Only {left} of this line remain to prepare.",
                )
            )
            continue
        variant = db.get(Variant, line.variant_id)
        cooked.append(
            Cooked(
                row.quantity,
                row.expected_version,
                order,
                line,
                variant.recipe if variant is not None else None,
            )
        )
    used: list[Used] = []
    named: set[str] = set()
    for index, usage in enumerate(draft.consumption):
        at = f"/draft/consumption/{index}"
        ingredient = db.get(Ingredient, usage.ingredient_id)
        if ingredient is None or ingredient.id in named:
            problems.append(
                FieldError(
                    f"{at}/ingredient_id",
                    "unknown_ingredient" if ingredient is None else "repeated_ingredient",
                    "Choose an ingredient."
                    if ingredient is None
                    else "Each ingredient appears once.",
                )
            )
            continue
        named.add(ingredient.id)
        if usage.unit not in COMPATIBLE[ingredient.base_unit]:
            problems.append(
                FieldError(
                    f"{at}/unit",
                    "incompatible_unit",
                    f"{ingredient.name} is measured in {ingredient.base_unit}.",
                )
            )
            continue
        try:
            entered = parse_quantity(usage.quantity, "piece" if usage.unit == "piece" else "g")
        except ValueRejected as problem:
            problems.append(FieldError(f"{at}/quantity", problem.code, problem.message))
            continue
        base = entered * FACTOR.get(usage.unit, 1)
        if entered == 0 or base > STOCK_LIMIT:
            problems.append(
                FieldError(
                    f"{at}/quantity",
                    "zero" if entered == 0 else "overflow",
                    "Enter a quantity above zero." if entered == 0 else "This is too large.",
                )
            )
            continue
        used.append(
            Used(
                usage.quantity,
                usage.unit,
                usage.expected_version,
                ingredient,
                base,
                inventory.cost_basis(ingredient, settings.currency),
            )
        )
    note = draft.note.strip()
    if not draft.consumption and not note:
        # A recipe estimate is never put in the place of what was actually used.
        problems.append(
            FieldError(
                "/draft/note", "required", "Say why this preparation used no tracked ingredients."
            )
        )
    if problems:
        raise invalid(*problems)

    for entry in cooked:
        order = entry.order
        require_current(order, entry.expected_version, "order", partial(orders.latest, db, order))
    for item in used:
        require_current(
            item.ingredient,
            item.expected_version,
            "ingredient",
            partial(inventory.latest, item.ingredient),
        )
    short = [
        FieldError(
            f"/draft/consumption/{index}/quantity",
            "insufficient_stock",
            f"Only {format_quantity(item.ingredient.stock_thousandths)} "
            f"{item.ingredient.base_unit} is in stock. If the count is wrong, correct the stock "
            "first.",
        )
        for index, item in enumerate(used)
        if item.base > item.ingredient.stock_thousandths
    ]
    if short:
        raise _short(short)

    # Actual usage at the exact receipt cost of the day, added up exactly and rounded once.
    cost = None
    if all(item.basis is not None for item in used):
        total = sum(
            (inventory.exact_cost(item.basis, item.base) for item in used if item.basis),
            Fraction(0),
        )
        cost = inventory.to_minor(total, settings.minor_digits)
        if cost > MAX_SAFE_INTEGER:
            raise invalid(
                FieldError("/draft/consumption", "overflow", "This cost is too large to state.")
            )
    return Reviewed(settings, note, cooked, used, cost)


def _line(order: Order, line: OrderItem) -> dict[str, Any]:
    return {
        "order_id": order.id,
        "reference": order.reference,
        "order_item_id": line.id,
        "variant_id": line.variant_id,
        "food_name": line.food_name,
        "variant_label": line.variant_label,
        "selling_unit": line.selling_unit,
        "package_contents": _contents(line.package_quantity),
    }


def _basis(ingredient_id: str, basis: PurchaseLine | None) -> dict[str, Any]:
    return {
        "ingredient_id": ingredient_id,
        "purchase_id": basis.purchase_id if basis else None,
        "purchase_line_id": basis.id if basis else None,
        "purchased_on": basis.purchase.purchased_on if basis else None,
        "unit_cost": inventory.line_cost(basis) if basis else None,
    }


def _recipes(rows: list[tuple[str, str | None, int | None]]) -> list[dict[str, Any]]:
    """One snapshot for each variant cooked, in the order the draft first names it."""
    seen: dict[str, dict[str, Any]] = {}
    for variant_id, recipe_id, version in rows:
        seen.setdefault(
            variant_id,
            {"variant_id": variant_id, "recipe_id": recipe_id, "recipe_version": version},
        )
    return list(seen.values())


def preview(db: Session, body: PreparationPreviewIn, now: datetime) -> PreparationPreviewOut:
    draft = body.draft
    reviewed = _review(db, draft)
    stored = inventory.remember(db, "preparation", "", _fingerprint(draft), reviewed.bound(), now)
    return PreparationPreviewOut.model_validate(
        {
            "id": stored.id,
            "expires_at": stored.expires_at,
            "prepared_on": draft.prepared_on,
            "note": reviewed.note,
            "allocations": [
                {
                    **_line(entry.order, entry.line),
                    "expected_version": entry.expected_version,
                    "ordered_quantity": entry.line.quantity,
                    "prepared_before": entry.before,
                    "quantity": entry.quantity,
                    "prepared_after": entry.before + entry.quantity,
                    "remaining_after": entry.line.quantity - entry.before - entry.quantity,
                }
                for entry in reviewed.cooked
            ],
            "consumption": [
                {
                    "ingredient_id": item.ingredient.id,
                    "ingredient_name": item.ingredient.name,
                    "base_unit": item.ingredient.base_unit,
                    "expected_version": item.expected_version,
                    "quantity": item.quantity,
                    "unit": item.unit,
                    "base_quantity": format_quantity(item.base),
                    "before_quantity": format_quantity(item.ingredient.stock_thousandths),
                    "after_quantity": format_quantity(
                        item.ingredient.stock_thousandths - item.base
                    ),
                }
                for item in reviewed.used
            ],
            "recipe_snapshots": _recipes(
                [
                    (
                        entry.line.variant_id,
                        entry.recipe.id if entry.recipe else None,
                        entry.recipe.version if entry.recipe else None,
                    )
                    for entry in reviewed.cooked
                ]
            ),
            "cost_basis_snapshots": [
                _basis(item.ingredient.id, item.basis) for item in reviewed.used
            ],
            "estimated_ingredient_cost_minor": reviewed.cost,
            "estimate_complete": reviewed.cost is not None,
            "currency": reviewed.settings.currency,
            "minor_digits": reviewed.settings.minor_digits,
        }
    )


def save(
    db: Session, body: PreparationSave, key: str, actor: StaffUser, now: datetime
) -> tuple[Preparation, list[Order], list[Ingredient]]:
    """Commit a reviewed preparation: prepared counts, one stock movement per ingredient, the
    stock and the record, all in the caller's transaction or not at all.

    An order's status is never touched: recording what was cooked and saying an order is
    ready are separate acts.
    """
    draft = body.draft
    stored = inventory.spend(db, body.preview_id, "preparation", "", _fingerprint(draft), now)
    reviewed = _review(db, draft)
    if json.loads(stored.dependencies) != reviewed.bound():
        raise inventory.stale()
    settings = reviewed.settings
    record = Preparation(
        id=new_id("prep"),
        prepared_on=draft.prepared_on,
        note=reviewed.note,
        currency=settings.currency,
        minor_digits=settings.minor_digits,
        estimated_cost_minor=reviewed.cost,
        operation_id=key,
        recorded_at=now,
        actor_id=actor.id,
        actor_display_name=actor.display_name,
    )
    db.add(record)
    db.flush()
    changed: dict[str, Order] = {}
    for position, entry in enumerate(reviewed.cooked):
        order, line = entry.order, entry.line
        line.prepared_quantity = entry.before + entry.quantity
        record.allocations.append(
            PreparationAllocation(
                position=position,
                order_id=order.id,
                order_item_id=line.id,
                reference=order.reference,
                variant_id=line.variant_id,
                food_name=line.food_name,
                variant_label=line.variant_label,
                selling_unit=line.selling_unit,
                package_quantity=line.package_quantity,
                quantity=entry.quantity,
                recipe_id=entry.recipe.id if entry.recipe else None,
                recipe_version=entry.recipe.version if entry.recipe else None,
            )
        )
        changed.setdefault(order.id, order)
    for order in changed.values():
        order.version += 1
        order.updated_at = now
    stock: list[Ingredient] = []
    for position, item in enumerate(reviewed.used):
        ingredient, basis = item.ingredient, item.basis
        movement = inventory.move(
            db, ingredient, -item.base, "consumption", CONSUMED, key, actor, now,
            preparation_id=record.id,
        )  # fmt: skip
        ingredient.version += 1
        record.consumption.append(
            PreparationConsumption(
                position=position,
                ingredient_id=ingredient.id,
                ingredient_name=ingredient.name,
                base_unit=ingredient.base_unit,
                quantity=item.quantity,
                unit=item.unit,
                base_thousandths=item.base,
                before_thousandths=movement.before_thousandths,
                after_thousandths=movement.after_thousandths,
                stock_movement_id=movement.id,
                purchase_id=basis.purchase_id if basis else None,
                purchase_line_id=basis.id if basis else None,
                purchased_on=basis.purchase.purchased_on if basis else None,
                unit_cost=inventory.line_cost(basis) if basis else None,
            )
        )
        stock.append(ingredient)
    db.flush()
    return record, list(changed.values()), stock


def get(db: Session, preparation_id: str) -> Preparation:
    record = db.get(Preparation, preparation_id)
    if record is None:
        raise _not_found()
    return record


def preparation_out(record: Preparation) -> PreparationOut:
    return PreparationOut.model_validate(
        {
            "id": record.id,
            "prepared_on": record.prepared_on,
            "note": record.note,
            "allocations": [
                {
                    "order_id": row.order_id,
                    "reference": row.reference,
                    "order_item_id": row.order_item_id,
                    "variant_id": row.variant_id,
                    "food_name": row.food_name,
                    "variant_label": row.variant_label,
                    "selling_unit": row.selling_unit,
                    "package_contents": _contents(row.package_quantity),
                    "quantity": row.quantity,
                }
                for row in record.allocations
            ],
            "consumption": [
                {
                    "ingredient_id": row.ingredient_id,
                    "ingredient_name": row.ingredient_name,
                    "base_unit": row.base_unit,
                    "quantity": row.quantity,
                    "unit": row.unit,
                    "base_quantity": format_quantity(row.base_thousandths),
                    "before_quantity": format_quantity(row.before_thousandths),
                    "after_quantity": format_quantity(row.after_thousandths),
                    "stock_movement_id": row.stock_movement_id,
                }
                for row in record.consumption
            ],
            "recipe_snapshots": _recipes(
                [(row.variant_id, row.recipe_id, row.recipe_version) for row in record.allocations]
            ),
            "cost_basis_snapshots": [
                {
                    "ingredient_id": row.ingredient_id,
                    "purchase_id": row.purchase_id,
                    "purchase_line_id": row.purchase_line_id,
                    "purchased_on": row.purchased_on,
                    "unit_cost": row.unit_cost,
                }
                for row in record.consumption
            ],
            "estimated_ingredient_cost_minor": record.estimated_cost_minor,
            "estimate_complete": record.estimated_cost_minor is not None,
            "currency": record.currency,
            "minor_digits": record.minor_digits,
            "operation_id": record.operation_id,
            "recorded_at": record.recorded_at,
            "recorded_by": record.actor_display_name,
        }
    )


# --- Corrections -----------------------------------------------------------------------------


@dataclass(frozen=True)
class Recount:
    delta: int
    expected_version: int
    original: PreparationAllocation
    order: Order
    line: OrderItem

    @property
    def before(self) -> int:
        return self.line.prepared_quantity or 0


@dataclass(frozen=True)
class Restock:
    delta: int
    expected_version: int
    original: PreparationConsumption
    ingredient: Ingredient


def _contributed(db: Session, record: Preparation, order_item_id: str) -> int:
    """What one preparation accounts for on a line now: its own allocation and every later
    correction of it."""
    recorded = sum(row.quantity for row in record.allocations if row.order_item_id == order_item_id)
    later = db.scalar(
        select(func.coalesce(func.sum(CorrectionAllocation.delta_quantity), 0))
        .join(PreparationCorrection, PreparationCorrection.id == CorrectionAllocation.correction_id)
        .where(
            PreparationCorrection.preparation_id == record.id,
            CorrectionAllocation.order_item_id == order_item_id,
        )
    )
    return recorded + int(later or 0)


def _correction_fingerprint(body: CorrectionIn) -> str:
    return inventory.fingerprint_of(
        [
            body.reason,
            [
                [row.order_id, row.expected_version, row.order_item_id, row.delta_quantity]
                for row in body.allocations
            ],
            [
                [
                    row.ingredient_id,
                    row.expected_version,
                    _amount(row.delta_base_quantity, signed=True),
                    row.corrects_movement_id,
                ]
                for row in body.stock_corrections
            ],
        ]
    )


def _review_correction(
    db: Session, record: Preparation, body: CorrectionIn
) -> tuple[list[Recount], list[Restock]]:
    """Check a correction of one preparation against the orders and the shelf as they are.

    A count may move only within what this preparation recorded and what was ordered, and is
    not lowered once the order is ready or completed. Stock may be adjusted only for an
    ingredient this preparation used, against the deduction it made.
    """
    problems: list[FieldError] = []
    if not body.allocations and not body.stock_corrections:
        problems.append(FieldError("/allocations", "required", "Enter at least one change."))
    recounts: list[Recount] = []
    lines: set[str] = set()
    for index, row in enumerate(body.allocations):
        at = f"/allocations/{index}"
        original = next(
            (
                entry
                for entry in record.allocations
                if entry.order_item_id == row.order_item_id and entry.order_id == row.order_id
            ),
            None,
        )
        order = db.get(Order, original.order_id) if original is not None else None
        line = (
            next(
                (item for item in orders.active_lines(order) if item.id == row.order_item_id), None
            )
            if order is not None
            else None
        )
        if original is None or order is None or line is None or line.id in lines:
            repeated = line is not None and line.id in lines
            problems.append(
                FieldError(
                    f"{at}/order_item_id",
                    "repeated_line" if repeated else "unknown_line",
                    "Each order line appears once."
                    if repeated
                    else "Choose a line this preparation recorded.",
                )
            )
            continue
        lines.add(line.id)
        after = (line.prepared_quantity or 0) + row.delta_quantity
        if (
            row.delta_quantity == 0
            or _contributed(db, record, line.id) + row.delta_quantity < 0
            or not 0 <= after <= line.quantity
        ):
            problems.append(
                FieldError(
                    f"{at}/delta_quantity",
                    "out_of_range",
                    "Enter a change that is not zero and stays within what this preparation "
                    "recorded and what was ordered.",
                )
            )
            continue
        if row.delta_quantity < 0 and order.status in ("ready", "completed"):
            # Lowering it would leave a finished order with food still to cook.
            problems.append(
                FieldError(
                    f"{at}/delta_quantity",
                    "order_finished",
                    "A prepared count cannot be lowered while the order is ready or completed.",
                )
            )
            continue
        recounts.append(Recount(row.delta_quantity, row.expected_version, original, order, line))
    restocks: list[Restock] = []
    named: set[str] = set()
    for index, change in enumerate(body.stock_corrections):
        at = f"/stock_corrections/{index}"
        used = next(
            (entry for entry in record.consumption if entry.ingredient_id == change.ingredient_id),
            None,
        )
        ingredient = db.get(Ingredient, used.ingredient_id) if used is not None else None
        if used is None or ingredient is None or ingredient.id in named:
            repeated = ingredient is not None and ingredient.id in named
            problems.append(
                FieldError(
                    f"{at}/ingredient_id",
                    "repeated_ingredient" if repeated else "unknown_ingredient",
                    "Each ingredient appears once."
                    if repeated
                    else "Choose an ingredient this preparation used.",
                )
            )
            continue
        named.add(ingredient.id)
        if change.corrects_movement_id != used.stock_movement_id:
            problems.append(
                FieldError(
                    f"{at}/corrects_movement_id",
                    "wrong_movement",
                    "Name the deduction this preparation recorded for the ingredient.",
                )
            )
            continue
        try:
            delta = parse_quantity(change.delta_base_quantity, ingredient.base_unit, signed=True)
        except ValueRejected as problem:
            problems.append(FieldError(f"{at}/delta_base_quantity", problem.code, problem.message))
            continue
        if delta == 0 or ingredient.stock_thousandths + delta > STOCK_LIMIT:
            problems.append(
                FieldError(
                    f"{at}/delta_base_quantity",
                    "zero" if delta == 0 else "overflow",
                    "Enter a change that is not zero."
                    if delta == 0
                    else "This would be more stock than can be recorded.",
                )
            )
            continue
        restocks.append(Restock(delta, change.expected_version, used, ingredient))
    if problems:
        raise invalid(*problems)

    for recount in recounts:
        order = recount.order
        require_current(order, recount.expected_version, "order", partial(orders.latest, db, order))
    for restock in restocks:
        require_current(
            restock.ingredient,
            restock.expected_version,
            "ingredient",
            partial(inventory.latest, restock.ingredient),
        )
    short = [
        FieldError(
            f"/stock_corrections/{index}/delta_base_quantity",
            "insufficient_stock",
            f"Only {format_quantity(restock.ingredient.stock_thousandths)} "
            f"{restock.ingredient.base_unit} is in stock.",
        )
        for index, restock in enumerate(restocks)
        if restock.ingredient.stock_thousandths + restock.delta < 0
    ]
    if short:
        raise _short(short)
    return recounts, restocks


def _recount_out(recount: Recount) -> dict[str, Any]:
    original, after = recount.original, recount.before + recount.delta
    return {
        "order_id": original.order_id,
        "reference": original.reference,
        "order_item_id": original.order_item_id,
        "variant_id": original.variant_id,
        "food_name": original.food_name,
        "variant_label": original.variant_label,
        "selling_unit": original.selling_unit,
        "package_contents": _contents(original.package_quantity),
        "expected_version": recount.expected_version,
        "ordered_quantity": recount.line.quantity,
        "prepared_before": recount.before,
        "delta_quantity": recount.delta,
        "prepared_after": after,
        "remaining_after": recount.line.quantity - after,
    }


def preview_correction(
    db: Session, preparation_id: str, body: CorrectionIn, now: datetime
) -> CorrectionPreviewOut:
    record = get(db, preparation_id)
    recounts, restocks = _review_correction(db, record, body)
    stored = inventory.remember(db, "correction", record.id, _correction_fingerprint(body), {}, now)
    return CorrectionPreviewOut.model_validate(
        {
            "id": stored.id,
            "expires_at": stored.expires_at,
            "preparation_id": record.id,
            "reason": body.reason,
            "allocations": [_recount_out(recount) for recount in recounts],
            "stock_corrections": [
                {
                    "ingredient_id": restock.ingredient.id,
                    "ingredient_name": restock.ingredient.name,
                    "base_unit": restock.ingredient.base_unit,
                    "expected_version": restock.expected_version,
                    "corrects_movement_id": restock.original.stock_movement_id,
                    "delta_base_quantity": format_quantity(restock.delta),
                    "before_quantity": format_quantity(restock.ingredient.stock_thousandths),
                    "after_quantity": format_quantity(
                        restock.ingredient.stock_thousandths + restock.delta
                    ),
                }
                for restock in restocks
            ],
        }
    )


def save_correction(
    db: Session,
    preparation_id: str,
    body: CorrectionSave,
    key: str,
    actor: StaffUser,
    now: datetime,
) -> tuple[PreparationCorrection, list[Order], list[Ingredient]]:
    """Commit a reviewed correction beside its preparation, which stays as it was written.

    Counts and stock change together. Each stock change is its own movement of type
    `correction`, linked to the preparation and to the deduction it corrects.
    """
    record = get(db, preparation_id)
    inventory.spend(
        db, body.preview_id, "correction", record.id, _correction_fingerprint(body), now
    )
    recounts, restocks = _review_correction(db, record, body)
    earlier = db.scalar(
        select(func.count())
        .select_from(PreparationCorrection)
        .where(PreparationCorrection.preparation_id == record.id)
    )
    saved = PreparationCorrection(
        id=new_id("corr"),
        preparation_id=record.id,
        sequence=int(earlier or 0),
        reason=body.reason,
        operation_id=key,
        recorded_at=now,
        actor_id=actor.id,
        actor_display_name=actor.display_name,
    )
    db.add(saved)
    db.flush()
    changed: dict[str, Order] = {}
    for position, recount in enumerate(recounts):
        original, before = recount.original, recount.before
        recount.line.prepared_quantity = before + recount.delta
        saved.allocations.append(
            CorrectionAllocation(
                position=position,
                order_id=original.order_id,
                order_item_id=original.order_item_id,
                reference=original.reference,
                variant_id=original.variant_id,
                food_name=original.food_name,
                variant_label=original.variant_label,
                selling_unit=original.selling_unit,
                package_quantity=original.package_quantity,
                ordered_quantity=recount.line.quantity,
                prepared_before=before,
                delta_quantity=recount.delta,
                prepared_after=before + recount.delta,
            )
        )
        changed.setdefault(recount.order.id, recount.order)
    for order in changed.values():
        order.version += 1
        order.updated_at = now
    stock: list[Ingredient] = []
    for position, restock in enumerate(restocks):
        ingredient = restock.ingredient
        movement = inventory.move(
            db, ingredient, restock.delta, "correction", body.reason, key, actor, now,
            preparation_id=record.id, corrects_movement_id=restock.original.stock_movement_id,
        )  # fmt: skip
        ingredient.version += 1
        saved.stock.append(
            CorrectionStock(
                position=position,
                ingredient_id=ingredient.id,
                ingredient_name=ingredient.name,
                base_unit=ingredient.base_unit,
                corrects_movement_id=restock.original.stock_movement_id,
                delta_thousandths=restock.delta,
                before_thousandths=movement.before_thousandths,
                after_thousandths=movement.after_thousandths,
                stock_movement_id=movement.id,
            )
        )
        stock.append(ingredient)
    db.flush()
    return saved, list(changed.values()), stock


def correction_out(saved: PreparationCorrection) -> CorrectionOut:
    return CorrectionOut.model_validate(
        {
            "id": saved.id,
            "preparation_id": saved.preparation_id,
            "reason": saved.reason,
            "allocations": [
                {
                    "order_id": row.order_id,
                    "reference": row.reference,
                    "order_item_id": row.order_item_id,
                    "variant_id": row.variant_id,
                    "food_name": row.food_name,
                    "variant_label": row.variant_label,
                    "selling_unit": row.selling_unit,
                    "package_contents": _contents(row.package_quantity),
                    "ordered_quantity": row.ordered_quantity,
                    "prepared_before": row.prepared_before,
                    "delta_quantity": row.delta_quantity,
                    "prepared_after": row.prepared_after,
                    "remaining_after": row.ordered_quantity - row.prepared_after,
                }
                for row in saved.allocations
            ],
            "stock_corrections": [
                {
                    "ingredient_id": row.ingredient_id,
                    "ingredient_name": row.ingredient_name,
                    "base_unit": row.base_unit,
                    "corrects_movement_id": row.corrects_movement_id,
                    "delta_base_quantity": format_quantity(row.delta_thousandths),
                    "before_quantity": format_quantity(row.before_thousandths),
                    "after_quantity": format_quantity(row.after_thousandths),
                    "stock_movement_id": row.stock_movement_id,
                }
                for row in saved.stock
            ],
            "operation_id": saved.operation_id,
            "recorded_at": saved.recorded_at,
            "recorded_by": saved.actor_display_name,
        }
    )


def corrections_of(db: Session, preparation_id: str) -> list[PreparationCorrection]:
    """The corrections of one preparation, in the order they were recorded."""
    record = get(db, preparation_id)
    return list(
        db.scalars(
            select(PreparationCorrection)
            .where(PreparationCorrection.preparation_id == record.id)
            .order_by(PreparationCorrection.sequence)
        )
    )


# --- Bringing a kitchen already at work into recording ---------------------------------------

OPEN = ("pending", "confirmed", "preparing", "ready")


def tracked_by_hand(db: Session) -> list[Order]:
    """Open orders that keep no count of what has been cooked, soonest first."""
    return list(
        db.scalars(
            select(Order)
            .where(Order.status.in_(OPEN), Order.preparation_tracking == "manual")
            .order_by(Order.fulfillment_at, Order.reference)
        )
    )


def baseline(
    db: Session,
    reference: str,
    prepared: dict[int, int],
    everything: bool,
    reason: str,
    now: datetime,
) -> Order:
    """Give an open order its prepared counts as the operator found them, and start counting.

    This is for food cooked before recording began. Its ingredients left the shelf then, and
    the stock count agreed when recording was turned on already reflects that, so nothing is
    deducted here. The counts and the reason go to the audit log. `prepared` maps a line
    number, as `preparation status` lists them, to how many of it are done; other lines start
    at nothing.
    """
    if not business_settings.enabled(db, "preparation_recording"):
        raise OperatorError(
            "Preparation recording is off. Turn it on first: "
            "`food-admin settings set --enable preparation_recording`."
        )
    order = db.scalar(select(Order).where(Order.reference == reference))
    if order is None:
        raise OperatorError(f"There is no order {reference}.")
    if order.status not in OPEN:
        raise OperatorError(f"{reference} is {order.status}; only an open order takes a baseline.")
    cooked = db.scalar(
        select(PreparationAllocation.preparation_id)
        .where(PreparationAllocation.order_id == order.id)
        .limit(1)
    )
    if cooked is not None:
        raise OperatorError(
            f"Cooking has already been recorded against {reference}. "
            "Change its counts with a preparation correction instead."
        )
    lines = orders.active_lines(order)
    for number, quantity in prepared.items():
        if not 1 <= number <= len(lines):
            raise OperatorError(f"{reference} has no line {number}.")
        ordered = lines[number - 1].quantity
        if quantity > ordered:
            raise OperatorError(
                f"Line {number}: {quantity} prepared, but only {ordered} were ordered."
            )
    previous = order.preparation_tracking
    order.preparation_tracking = "recorded"
    for number, line in enumerate(lines, start=1):
        line.prepared_quantity = line.quantity if everything else prepared.get(number, 0)
    order.version += 1
    order.updated_at = now
    audit.record(
        db,
        now,
        audit.OPERATOR,
        "preparation.baseline",
        "order",
        order.id,
        {
            "reason": reason,
            "previous_tracking": previous,
            "lines": [
                {
                    "order_item_id": line.id,
                    "ordered": line.quantity,
                    "prepared": line.prepared_quantity,
                }
                for line in lines
            ],
        },
    )
    return order
