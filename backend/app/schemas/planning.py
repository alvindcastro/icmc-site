from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.actions import PermittedAction
from app.schemas.inventory import BaseUnit
from app.schemas.menu import PackageContents, SellingUnit
from app.values import CalendarDate, Instant


class PlanningQuery(BaseModel):
    """An inclusive period of business dates. Both ends, or neither for the business date."""

    model_config = ConfigDict(extra="forbid")

    date_from: CalendarDate | None = None
    date_to: CalendarDate | None = None


class PeriodOut(BaseModel):
    date_from: date
    date_to: date


class PlanningOrderOut(BaseModel):
    order_id: str
    # The version an allocation to this line must quote.
    order_version: int
    reference: str
    order_item_id: str
    status: Literal["confirmed", "preparing", "ready"]
    ordered_quantity: int
    # Zero, not null, on an order tracked by hand: nothing is known to be cooked.
    prepared_quantity: int
    remaining_quantity: int


class PlanningFoodOut(BaseModel):
    """What is wanted of one variant in one selling format; the sums of its order lines."""

    variant_id: str
    food_name: str
    variant_label: str
    selling_unit: SellingUnit
    package_contents: PackageContents | None
    ordered_quantity: int
    prepared_quantity: int
    remaining_quantity: int
    orders: list[PlanningOrderOut]


class PlanningIngredientOut(BaseModel):
    """Stock against demand, as ingredient-quantity strings in the base unit."""

    ingredient_id: str
    ingredient_name: str
    base_unit: BaseUnit
    stock_on_hand: str
    earlier_demand: str
    period_demand: str
    # Signed: a deficit left by earlier commitments stays visible.
    stock_after_earlier: str
    earlier_shortage: str
    period_shortage: str
    cumulative_shortage: str


class MissingOrderOut(BaseModel):
    order_id: str
    reference: str


class PlanningMissingOut(BaseModel):
    code: Literal["recipe_missing"]
    variant_id: str
    food_id: str
    food_name: str
    variant_label: str
    orders: list[MissingOrderOut]


class PlanningOut(BaseModel):
    id: str
    calculated_at: Instant
    timezone: str
    period: PeriodOut
    # False when any demand could not be turned into ingredients; the quantities are then a
    # lower bound.
    complete: bool
    missing: list[PlanningMissingOut]
    foods: list[PlanningFoodOut]
    ingredients: list[PlanningIngredientOut]
    permitted_actions: dict[str, PermittedAction]


class ShoppingItemOut(BaseModel):
    ingredient_id: str
    ingredient_name: str
    base_unit: BaseUnit
    stock_on_hand: str
    earlier_demand: str
    period_demand: str
    cumulative_shortage: str


class ShoppingListOut(BaseModel):
    id: str
    calculated_at: Instant
    timezone: str
    period: PeriodOut
    complete: bool
    missing: list[PlanningMissingOut]
    items: list[ShoppingItemOut]
