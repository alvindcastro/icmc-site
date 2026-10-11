import json
import math
from datetime import datetime
from fractions import Fraction
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.errors import ApiError, FieldError, invalid
from app.ids import new_id
from app.persistence.models import Ingredient, Recipe, RecipeItem, Variant
from app.schemas.recipes import EstimateOut, RecipeIn, RecipeOut
from app.services import business_settings
from app.services.inventory import (
    COMPATIBLE,
    FACTOR,
    STOCK_LIMIT,
    cost_basis,
    exact_cost,
    line_cost,
    to_minor,
)
from app.services.versions import require_current
from app.values import (
    MAX_SAFE_INTEGER,
    ValueRejected,
    format_quantity,
    parse_quantity,
)


def _not_found(what: str) -> ApiError:
    return ApiError(404, "not_found", f"This {what} does not exist.")


def _selling_format(variant: Variant) -> dict[str, Any]:
    """What a recipe's yield must be: exactly one selling unit of the variant as it is now."""
    quantity = variant.package_quantity
    return {
        "quantity": 1,
        "selling_unit": variant.selling_unit,
        "package_contents": None if quantity is None else {"quantity": quantity, "unit": "piece"},
    }


def _same(left: object, right: object) -> bool:
    # Compared as JSON text, so that `true` or `1.0` is not taken for the number 1.
    return json.dumps(left, sort_keys=True) == json.dumps(right, sort_keys=True)


def rows_of(db: Session, recipe: Recipe) -> list[RecipeItem]:
    """The rows of the recipe as it stands. Rows of earlier versions stay in the table."""
    return list(
        db.scalars(
            select(RecipeItem)
            .where(RecipeItem.recipe_id == recipe.id, RecipeItem.recipe_version == recipe.version)
            .order_by(RecipeItem.position)
        )
    )


def describes(recipe: Recipe, variant: Variant) -> bool:
    """Whether the recipe was written for the variant's present selling format."""
    return (recipe.yield_selling_unit, recipe.yield_package_quantity) == (
        variant.selling_unit,
        variant.package_quantity,
    )


def recipe_out(db: Session, recipe: Recipe) -> RecipeOut:
    quantity = recipe.yield_package_quantity
    items = []
    for row in rows_of(db, recipe):
        ingredient = db.get(Ingredient, row.ingredient_id)
        assert ingredient is not None
        items.append(
            {
                "ingredient_id": row.ingredient_id,
                # The ingredient's present name: a recipe is a working document, not a receipt.
                "ingredient_name": ingredient.name,
                "base_unit": ingredient.base_unit,
                "quantity": row.quantity,
                "unit": row.unit,
            }
        )
    return RecipeOut.model_validate(
        {
            "id": recipe.id,
            "version": recipe.version,
            "variant_id": recipe.variant_id,
            "yield": {
                "quantity": 1,
                "selling_unit": recipe.yield_selling_unit,
                "package_contents": None
                if quantity is None
                else {"quantity": quantity, "unit": "piece"},
            },
            "items": items,
            "recorded_at": recipe.recorded_at,
            "updated_at": recipe.updated_at,
        }
    )


def _variant(db: Session, variant_id: str) -> Variant:
    variant = db.get(Variant, variant_id)
    if variant is None:
        raise _not_found("variant")
    return variant


def get(db: Session, variant_id: str) -> Recipe:
    recipe = _variant(db, variant_id).recipe
    if recipe is None:
        raise _not_found("recipe")
    return recipe


def save(db: Session, variant_id: str, body: RecipeIn, now: datetime) -> tuple[Recipe, bool]:
    """Create or replace a variant's recipe; returns it and whether it is new.

    A save is guarded by the version alone: sent twice, the second is stale. That is why it
    needs no operation key.
    """
    variant = _variant(db, variant_id)
    recipe = variant.recipe
    problems: list[FieldError] = []
    if recipe is None and body.expected_version is not None:
        problems.append(
            FieldError(
                "/expected_version", "must_be_null", "Send a null version to create a recipe."
            )
        )
    if not _same(body.yield_, _selling_format(variant)):
        problems.append(
            FieldError(
                "/yield",
                "wrong_selling_format",
                "A recipe is for exactly one selling unit of this variant as it is now.",
            )
        )
    rows: list[tuple[Ingredient, str, str, int]] = []
    seen: set[str] = set()
    for index, item in enumerate(body.items):
        at = f"/items/{index}"
        ingredient = db.get(Ingredient, item.ingredient_id)
        if ingredient is None:
            problems.append(
                FieldError(f"{at}/ingredient_id", "unknown_ingredient", "Choose an ingredient.")
            )
            continue
        if ingredient.id in seen:
            problems.append(
                FieldError(
                    f"{at}/ingredient_id", "repeated_ingredient", "Each ingredient appears once."
                )
            )
            continue
        seen.add(ingredient.id)
        if item.unit not in COMPATIBLE[ingredient.base_unit]:
            problems.append(
                FieldError(
                    f"{at}/unit",
                    "incompatible_unit",
                    f"{ingredient.name} is measured in {ingredient.base_unit}.",
                )
            )
            continue
        try:
            entered = parse_quantity(item.quantity, "piece" if item.unit == "piece" else "g")
        except ValueRejected as problem:
            problems.append(FieldError(f"{at}/quantity", problem.code, problem.message))
            continue
        base = entered * FACTOR.get(item.unit, 1)
        if entered == 0 or base > STOCK_LIMIT:
            problems.append(
                FieldError(
                    f"{at}/quantity",
                    "zero" if entered == 0 else "overflow",
                    "Enter a quantity above zero." if entered == 0 else "This is too large.",
                )
            )
            continue
        rows.append((ingredient, item.quantity, item.unit, base))
    if problems:
        raise invalid(*problems)

    created = recipe is None
    if recipe is None:
        recipe = Recipe(
            id=new_id("rec"), version=1, variant_id=variant.id, recorded_at=now, updated_at=now
        )
        variant.recipe = recipe
    else:
        # A null version here means someone else created the recipe first: a conflict too.
        current = recipe
        require_current(
            current,
            body.expected_version,
            "recipe",
            lambda: recipe_out(db, current).model_dump(mode="json", by_alias=True),
        )
        recipe.version += 1
        recipe.updated_at = now
    recipe.yield_selling_unit = variant.selling_unit
    recipe.yield_package_quantity = variant.package_quantity
    db.flush()
    for position, (ingredient, quantity, unit, base) in enumerate(rows):
        db.add(
            RecipeItem(
                recipe_id=recipe.id,
                recipe_version=recipe.version,
                position=position,
                ingredient_id=ingredient.id,
                quantity=quantity,
                unit=unit,
                base_thousandths=base,
            )
        )
    db.flush()
    return recipe, created


def _nine_decimals(amount: Fraction) -> str:
    """An exact amount that is never negative, to nine decimals, half-up."""
    whole, billionths = divmod(math.floor(amount * 10**9 + Fraction(1, 2)), 10**9)
    return f"{whole}.{billionths:09d}"


def estimate(db: Session, variant_id: str, now: datetime) -> EstimateOut:
    """What the ingredients of one selling unit cost, from the latest purchase of each.

    Every row is costed from its receipt line's exact total and quantity. The rows are added
    up exactly and the sum is rounded once, half-up. If the recipe is missing, was written for
    another selling format, or any ingredient's latest purchase is missing or in another
    currency, there is no total at all.
    """
    variant = _variant(db, variant_id)
    settings = business_settings.require(db)
    recipe = variant.recipe
    missing: list[dict[str, Any]] = []
    basis: list[dict[str, Any]] = []
    total = Fraction(0)
    if recipe is None or not describes(recipe, variant):
        missing.append({"code": "recipe_missing", "ingredient_id": None, "variant_id": variant.id})
    else:
        for row in rows_of(db, recipe):
            ingredient = db.get(Ingredient, row.ingredient_id)
            assert ingredient is not None
            line = cost_basis(ingredient, settings.currency)
            entry: dict[str, Any] = {
                "ingredient_id": ingredient.id,
                "ingredient_name": ingredient.name,
                "base_unit": ingredient.base_unit,
                "base_quantity": format_quantity(row.base_thousandths),
                "purchase_id": None,
                "purchase_line_id": None,
                "purchased_on": None,
                "unit_cost": None,
                "estimated_cost": None,
            }
            if line is None:
                missing.append(
                    {
                        "code": "price_missing",
                        "ingredient_id": ingredient.id,
                        "variant_id": variant.id,
                    }
                )
            else:
                purchase = line.purchase
                amount = exact_cost(line, row.base_thousandths)
                total += amount
                entry.update(
                    purchase_id=purchase.id,
                    purchase_line_id=line.id,
                    purchased_on=purchase.purchased_on,
                    # The same figure the ingredient's own page shows for this receipt line.
                    unit_cost=line_cost(line),
                    estimated_cost=_nine_decimals(amount),
                )
            basis.append(entry)
    cost = None
    if not missing:
        # Half-up, once, on the exact sum.
        cost = to_minor(total, settings.minor_digits)
        if cost > MAX_SAFE_INTEGER:
            raise invalid(
                FieldError(
                    "/ingredient_cost_minor", "overflow", "This estimate is too large to state."
                )
            )
    return EstimateOut.model_validate(
        {
            "variant_id": variant.id,
            "recipe_version": recipe.version if recipe is not None else None,
            "currency": settings.currency,
            "selling_price_minor": variant.price_minor,
            "ingredient_cost_minor": cost,
            "ingredient_contribution_minor": None if cost is None else variant.price_minor - cost,
            "complete": not missing,
            "missing": missing,
            "basis": basis,
            "calculated_at": now,
        }
    )
