from datetime import date
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from pydantic_core import PydanticCustomError

from app.schemas.inventory import BaseUnit, PhysicalUnit
from app.schemas.menu import PackageContents, SellingUnit
from app.schemas.shared import Text, Version
from app.values import Instant, Money


def _one_to_a_hundred(items: list["RecipeItemIn"]) -> list["RecipeItemIn"]:
    if not 1 <= len(items) <= 100:
        raise PydanticCustomError("row_count", "Enter 1 to 100 recipe ingredients.")
    return items


class RecipeItemIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ingredient_id: Text
    # A positive exact decimal string, in one of the ingredient's own physical units.
    quantity: Text
    unit: PhysicalUnit


class RecipeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Null to create the recipe; the version being replaced to edit it.
    expected_version: Version | None
    # Must be exactly one selling unit of the variant as it is now. Taken as it comes and
    # compared whole, so anything else is reported at `/yield` and nowhere deeper.
    yield_: Any = Field(alias="yield")
    items: Annotated[list[RecipeItemIn], AfterValidator(_one_to_a_hundred)]


class YieldOut(BaseModel):
    quantity: Literal[1]
    selling_unit: SellingUnit
    package_contents: PackageContents | None


class RecipeItemOut(BaseModel):
    ingredient_id: str
    ingredient_name: str
    base_unit: BaseUnit
    quantity: str
    unit: PhysicalUnit


class RecipeOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    version: int
    variant_id: str
    yield_: YieldOut = Field(alias="yield")
    items: list[RecipeItemOut]
    recorded_at: Instant
    updated_at: Instant


class MissingOut(BaseModel):
    code: Literal["recipe_missing", "price_missing"]
    # The unpriced ingredient; null when it is the recipe itself that is missing.
    ingredient_id: str | None
    variant_id: str


class BasisOut(BaseModel):
    """One recipe row and the receipt line it is costed from, or five nulls if never bought."""

    ingredient_id: str
    ingredient_name: str
    base_unit: BaseUnit
    base_quantity: str
    purchase_id: str | None
    purchase_line_id: str | None
    purchased_on: date | None
    unit_cost: str | None
    estimated_cost: str | None


class EstimateOut(BaseModel):
    variant_id: str
    recipe_version: int | None
    currency: str
    selling_price_minor: Money
    # Both null unless the estimate is complete; never a guess and never a silent zero.
    ingredient_cost_minor: Money | None
    ingredient_contribution_minor: int | None
    complete: bool
    missing: list[MissingOut]
    basis: list[BasisOut]
    calculated_at: Instant
