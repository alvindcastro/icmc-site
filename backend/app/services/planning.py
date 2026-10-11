from datetime import date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.actions import PermittedAction, allowed, blocked
from app.errors import FieldError, invalid
from app.ids import new_id
from app.persistence.models import Ingredient, Order, Recipe, RecipeItem, Variant
from app.schemas.menu import PackageContents
from app.schemas.planning import PlanningOut, PlanningQuery, ShoppingListOut
from app.services import business_settings, business_time, orders, recipes
from app.services.inventory import STOCK_LIMIT
from app.values import MAX_SAFE_INTEGER, format_quantity

MAX_DAYS = 366
# Orders that can still be cooked. Pending is not agreed yet; completed and cancelled want nothing.
DEMAND = ("confirmed", "preparing", "ready")


def _period(query: PlanningQuery, today: date) -> tuple[date, date]:
    start, end = query.date_from, query.date_to
    if start is None and end is None:
        return today, today
    if start is None or end is None:
        missing = "date_from" if start is None else "date_to"
        raise invalid(
            FieldError(f"/query/{missing}", "required", "Give both ends of the period, or neither.")
        )
    if start > end:
        raise invalid(
            FieldError("/query/date_to", "before_start", "The period ends before it starts.")
        )
    if (end - start).days + 1 > MAX_DAYS:
        raise invalid(
            FieldError(
                "/query/date_to", "period_too_long", f"Plan at most {MAX_DAYS} days at a time."
            )
        )
    return start, end


def _recording(db: Session) -> PermittedAction:
    if not business_settings.enabled(db, "preparation_recording"):
        return blocked("preparation_recording_disabled", "Preparation recording is not enabled.")
    if not business_settings.enabled(db, "inventory"):
        return blocked("inventory_disabled", "The stockroom is not enabled.")
    return allowed()


def _too_much(what: str) -> Exception:
    return invalid(FieldError(f"/{what}", "overflow", "This demand is too large to state."))


def calculate(db: Session, query: PlanningQuery, now: datetime) -> PlanningOut:
    """What remains to cook in a period, and what that needs against the shelf.

    Demand is what is left to cook on confirmed, preparing and ready orders. Lines fulfilled in
    the period are listed. Lines fulfilled before it, overdue ones included, are earlier
    commitments: they are not listed, but their ingredients are counted, once, ahead of the
    period's own. Nothing here reserves or moves stock.
    """
    settings = business_settings.require(db)
    start, end = _period(query, business_time.today(now, ZoneInfo(settings.timezone)))
    wanted = db.scalars(
        select(Order)
        .where(Order.status.in_(DEMAND), Order.local_date <= end)
        .order_by(Order.fulfillment_at, Order.reference)
    )
    foods: dict[tuple[str, str, int | None], dict[str, Any]] = {}
    gaps: dict[str, dict[str, Any]] = {}
    # For each ingredient, thousandths wanted before the period and within it.
    needs: dict[str, list[int]] = {}
    known: dict[str, tuple[Variant, Recipe | None, list[RecipeItem]]] = {}
    for order in wanted:
        within = order.local_date >= start
        for item in orders.active_lines(order):
            prepared = item.prepared_quantity or 0
            left = item.quantity - prepared
            if within:
                # A variant sold in two formats is two rows: unlike quantities never merge.
                key = (item.variant_id, item.selling_unit, item.package_quantity)
                row = foods.setdefault(
                    key,
                    {
                        "variant_id": item.variant_id,
                        "food_name": item.food_name,
                        "variant_label": item.variant_label,
                        "selling_unit": item.selling_unit,
                        "package_contents": None
                        if item.package_quantity is None
                        else PackageContents(quantity=item.package_quantity, unit="piece"),
                        "ordered_quantity": 0,
                        "prepared_quantity": 0,
                        "remaining_quantity": 0,
                        "orders": [],
                    },
                )
                row["ordered_quantity"] += item.quantity
                row["prepared_quantity"] += prepared
                row["remaining_quantity"] += left
                row["orders"].append(
                    {
                        "order_id": order.id,
                        "order_version": order.version,
                        "reference": order.reference,
                        "order_item_id": item.id,
                        "status": order.status,
                        "ordered_quantity": item.quantity,
                        "prepared_quantity": prepared,
                        "remaining_quantity": left,
                    }
                )
            if left <= 0:
                continue
            if item.variant_id not in known:
                variant = db.get(Variant, item.variant_id)
                assert variant is not None
                recipe = variant.recipe
                rows = recipes.rows_of(db, recipe) if recipe is not None else []
                known[item.variant_id] = (variant, recipe, rows)
            variant, recipe, rows = known[item.variant_id]
            # The recipe must be for the format that was ordered, not the variant's present one.
            if recipe is None or (recipe.yield_selling_unit, recipe.yield_package_quantity) != (
                item.selling_unit,
                item.package_quantity,
            ):
                gap = gaps.setdefault(
                    item.variant_id,
                    {
                        "code": "recipe_missing",
                        "variant_id": item.variant_id,
                        "food_id": variant.food_id,
                        "food_name": item.food_name,
                        "variant_label": item.variant_label,
                        "orders": [],
                    },
                )
                if all(entry["order_id"] != order.id for entry in gap["orders"]):
                    gap["orders"].append({"order_id": order.id, "reference": order.reference})
                continue
            for needed in rows:
                need = needs.setdefault(needed.ingredient_id, [0, 0])
                need[1 if within else 0] += needed.base_thousandths * left

    if any(row["ordered_quantity"] > MAX_SAFE_INTEGER for row in foods.values()):
        raise _too_much("foods")
    ingredients = []
    for ingredient_id, (earlier, period) in needs.items():
        ingredient = db.get(Ingredient, ingredient_id)
        assert ingredient is not None
        if earlier + period > STOCK_LIMIT:
            raise _too_much("ingredients")
        stock = ingredient.stock_thousandths
        after = stock - earlier
        ingredients.append(
            {
                "ingredient_id": ingredient.id,
                "ingredient_name": ingredient.name,
                "base_unit": ingredient.base_unit,
                "stock_on_hand": format_quantity(stock),
                "earlier_demand": format_quantity(earlier),
                "period_demand": format_quantity(period),
                # Earlier commitments come off once. What they leave short stays visible as
                # negative stock, and the period is then measured against nothing, not less.
                "stock_after_earlier": format_quantity(after),
                "earlier_shortage": format_quantity(max(0, -after)),
                "period_shortage": format_quantity(max(0, period - max(0, after))),
                "cumulative_shortage": format_quantity(max(0, earlier + period - stock)),
            }
        )

    def by_name(row: dict[str, Any]) -> tuple[Any, ...]:
        contents = row.get("package_contents")
        return (
            row["food_name"].casefold(),
            row["variant_label"].casefold(),
            row["food_name"],
            row["variant_label"],
            row["variant_id"],
            row.get("selling_unit", ""),
            contents.quantity if contents is not None else 0,
        )

    return PlanningOut.model_validate(
        {
            "id": new_id("plan"),
            "calculated_at": now,
            "timezone": settings.timezone,
            "period": {"date_from": start, "date_to": end},
            "complete": not gaps,
            "missing": sorted(gaps.values(), key=by_name),
            "foods": sorted(foods.values(), key=by_name),
            "ingredients": sorted(
                ingredients,
                key=lambda row: (
                    row["ingredient_name"].casefold(),
                    row["ingredient_name"],
                    row["ingredient_id"],
                ),
            ),
            "permitted_actions": {"record_preparation": _recording(db)},
        }
    )


def shopping_list(db: Session, query: PlanningQuery, now: datetime) -> ShoppingListOut:
    """The same calculation, reduced to what stock cannot cover through the period."""
    plan = calculate(db, query, now)
    return ShoppingListOut.model_validate(
        {
            "id": plan.id,
            "calculated_at": plan.calculated_at,
            "timezone": plan.timezone,
            "period": plan.period,
            "complete": plan.complete,
            "missing": plan.missing,
            "items": [
                {
                    "ingredient_id": row.ingredient_id,
                    "ingredient_name": row.ingredient_name,
                    "base_unit": row.base_unit,
                    "stock_on_hand": row.stock_on_hand,
                    "earlier_demand": row.earlier_demand,
                    "period_demand": row.period_demand,
                    "cumulative_shortage": row.cumulative_shortage,
                }
                for row in plan.ingredients
                if row.cumulative_shortage != "0"
            ],
        }
    )
