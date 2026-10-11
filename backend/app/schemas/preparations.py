from datetime import date
from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from pydantic_core import PydanticCustomError

from app.schemas.inventory import BaseUnit, IngredientOut, PhysicalUnit
from app.schemas.menu import PackageContents, SellingUnit
from app.schemas.orders import OrderOut
from app.schemas.shared import Notes, Text, Version, entered
from app.values import MAX_SAFE_INTEGER, CalendarDate, Instant, Money, SellingQuantity

MAX_ROWS = 500


def _some(rows: list["AllocationIn"]) -> list["AllocationIn"]:
    if not 1 <= len(rows) <= MAX_ROWS:
        raise PydanticCustomError("row_count", f"Allocate 1 to {MAX_ROWS} order lines.")
    return rows


def _bounded[Row](rows: list[Row]) -> list[Row]:
    if len(rows) > MAX_ROWS:
        raise PydanticCustomError("row_count", f"Use at most {MAX_ROWS} rows.")
    return rows


class AllocationIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    order_id: Text
    # The order version the page read, from the plan's `order_version`.
    expected_version: Version
    order_item_id: Text
    quantity: SellingQuantity


class ConsumptionIn(BaseModel):
    """What was actually used of one ingredient. Never taken from a recipe by the server."""

    model_config = ConfigDict(extra="forbid")

    ingredient_id: Text
    expected_version: Version
    # A positive exact decimal string, in one of the ingredient's own physical units.
    quantity: Text
    unit: PhysicalUnit


class PreparationDraftIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prepared_on: CalendarDate
    allocations: Annotated[list[AllocationIn], AfterValidator(_some)]
    # May be empty, but then the note must say why nothing tracked was used.
    consumption: Annotated[list[ConsumptionIn], AfterValidator(_bounded)]
    note: Notes = ""


class PreparationPreviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    draft: PreparationDraftIn


class PreparationSave(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preview_id: Text
    draft: PreparationDraftIn


class CountChangeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    order_id: Text
    expected_version: Version
    order_item_id: Text
    # Signed: negative lowers the prepared count.
    delta_quantity: Annotated[int, Field(strict=True, ge=-MAX_SAFE_INTEGER, le=MAX_SAFE_INTEGER)]


class StockChangeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ingredient_id: Text
    expected_version: Version
    # A signed exact decimal string in the base unit: positive puts stock back.
    delta_base_quantity: Text
    # The deduction this preparation recorded for the ingredient.
    corrects_movement_id: Text


class CorrectionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Annotated[Text, entered(2000, "Enter a reason.")]
    allocations: Annotated[list[CountChangeIn], AfterValidator(_bounded)]
    stock_corrections: Annotated[list[StockChangeIn], AfterValidator(_bounded)]


class CorrectionSave(CorrectionIn):
    preview_id: Text


class LineOut(BaseModel):
    """An order line as it was when the row was written."""

    order_id: str
    reference: str
    order_item_id: str
    variant_id: str
    food_name: str
    variant_label: str
    selling_unit: SellingUnit
    package_contents: PackageContents | None


class AllocationOut(LineOut):
    quantity: int


class AllocationPreviewOut(AllocationOut):
    expected_version: int
    ordered_quantity: int
    prepared_before: int
    prepared_after: int
    remaining_after: int


class UsageOut(BaseModel):
    ingredient_id: str
    ingredient_name: str
    base_unit: BaseUnit
    # As entered, then what that comes to in the base unit, and the shelf before and after.
    quantity: str
    unit: PhysicalUnit
    base_quantity: str
    before_quantity: str
    after_quantity: str


class UsagePreviewOut(UsageOut):
    expected_version: int


class UsageSavedOut(UsageOut):
    stock_movement_id: str


class RecipeSnapshotOut(BaseModel):
    variant_id: str
    # Both null when the variant had no recipe.
    recipe_id: str | None
    recipe_version: int | None


class CostBasisOut(BaseModel):
    """The receipt line an ingredient was priced from; four nulls when it had no price."""

    ingredient_id: str
    purchase_id: str | None
    purchase_line_id: str | None
    purchased_on: date | None
    unit_cost: str | None


class Costing(BaseModel):
    recipe_snapshots: list[RecipeSnapshotOut]
    cost_basis_snapshots: list[CostBasisOut]
    # Null unless every basis is known; never a guess and never a silent zero.
    estimated_ingredient_cost_minor: Money | None
    estimate_complete: bool
    currency: str
    minor_digits: int


class PreparationPreviewOut(Costing):
    id: str
    expires_at: Instant
    prepared_on: date
    note: str
    allocations: list[AllocationPreviewOut]
    consumption: list[UsagePreviewOut]


class PreparationOut(Costing):
    id: str
    prepared_on: date
    note: str
    allocations: list[AllocationOut]
    consumption: list[UsageSavedOut]
    operation_id: str
    recorded_at: Instant
    recorded_by: str


class PreparationResultOut(BaseModel):
    """The record and everything it changed: each order and each ingredient once."""

    preparation: PreparationOut
    orders: list[OrderOut]
    ingredients: list[IngredientOut]


class CountChangeOut(LineOut):
    ordered_quantity: int
    prepared_before: int
    delta_quantity: int
    prepared_after: int
    remaining_after: int


class CountChangePreviewOut(CountChangeOut):
    expected_version: int


class StockChangeOut(BaseModel):
    ingredient_id: str
    ingredient_name: str
    base_unit: BaseUnit
    corrects_movement_id: str
    delta_base_quantity: str
    before_quantity: str
    after_quantity: str


class StockChangePreviewOut(StockChangeOut):
    expected_version: int


class StockChangeSavedOut(StockChangeOut):
    stock_movement_id: str


class CorrectionPreviewOut(BaseModel):
    id: str
    expires_at: Instant
    preparation_id: str
    reason: str
    allocations: list[CountChangePreviewOut]
    stock_corrections: list[StockChangePreviewOut]


class CorrectionOut(BaseModel):
    id: str
    preparation_id: str
    reason: str
    allocations: list[CountChangeOut]
    stock_corrections: list[StockChangeSavedOut]
    operation_id: str
    recorded_at: Instant
    recorded_by: str


class CorrectionResultOut(BaseModel):
    correction: CorrectionOut
    orders: list[OrderOut]
    ingredients: list[IngredientOut]


class CorrectionListOut(BaseModel):
    items: list[CorrectionOut]
