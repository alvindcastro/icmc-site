from datetime import date
from typing import Annotated, ClassVar, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from pydantic_core import PydanticCustomError

from app.actions import PermittedAction
from app.listing import PageQuery
from app.schemas.shared import Notes, Text, Update, Version, entered
from app.values import CalendarDate, Instant, Money

BaseUnit = Literal["g", "ml", "piece"]
PhysicalUnit = Literal["g", "kg", "ml", "l", "piece"]
PurchaseUnit = Literal["g", "kg", "ml", "l", "piece", "bag", "bottle", "box"]
MovementType = Literal["opening", "purchase", "consumption", "waste", "correction"]

IngredientName = Annotated[Text, entered(200, "Enter an ingredient name.")]


class IngredientCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: IngredientName
    # Fixed for the life of the ingredient: every quantity of it is counted in this unit.
    base_unit: BaseUnit
    # A quantity in the base unit, as an exact decimal string; null for no warning level.
    low_stock_threshold: Text | None = None


class IngredientUpdate(Update):
    nullable: ClassVar[frozenset[str]] = frozenset({"low_stock_threshold"})

    name: IngredientName | None = None
    low_stock_threshold: Text | None = None


class MovementIn(BaseModel):
    """A stock movement staff enter by hand. Purchases and preparation make their own."""

    model_config = ConfigDict(extra="forbid")

    expected_version: Version
    type: Literal["opening", "waste", "correction"]
    # A signed exact decimal string in the ingredient's base unit.
    delta_base_quantity: Text
    reason: Annotated[Text, entered(2000, "Enter a reason.")]
    preparation_id: Text | None = None
    corrects_movement_id: Text | None = None


class MovementSave(MovementIn):
    preview_id: Text


class PackContentsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quantity: Text
    unit: PhysicalUnit


def _one_to_a_hundred(items: list["PurchaseLineIn"]) -> list["PurchaseLineIn"]:
    if not 1 <= len(items) <= 100:
        raise PydanticCustomError("row_count", "Enter 1 to 100 purchase lines.")
    return items


class PurchaseLineIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_line_id: Annotated[Text, entered(200, "Give each row an identifier.")]
    ingredient_id: Text
    quantity: Text
    unit: PurchaseUnit
    # What one bag, bottle or box holds; null for a quantity given in a physical unit.
    pack_contents: PackContentsIn | None = None
    total_cost_minor: Money


class PurchaseDraftIn(BaseModel):
    """A receipt as staff entered it. Normalized quantities and unit costs are the server's."""

    model_config = ConfigDict(extra="forbid")

    purchased_on: CalendarDate
    supplier: Annotated[Text, entered(200, "Enter a supplier.")]
    note: Notes = ""
    items: Annotated[list[PurchaseLineIn], AfterValidator(_one_to_a_hundred)]


class PurchasePreviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    draft: PurchaseDraftIn


class PurchaseSave(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preview_id: Text
    draft: PurchaseDraftIn


class IngredientQuery(PageQuery):
    q: Annotated[str | None, Field(max_length=200)] = None
    low_stock: Literal["true", "false"] | None = None


class PurchaseQuery(PageQuery):
    q: Annotated[str | None, Field(max_length=200)] = None
    supplier: Annotated[str | None, Field(max_length=200)] = None
    date_from: CalendarDate | None = None
    date_to: CalendarDate | None = None


class IngredientOut(BaseModel):
    id: str
    version: int
    name: str
    base_unit: BaseUnit
    low_stock_threshold: str | None
    stock_on_hand: str
    low_stock: bool
    # Both null until the ingredient has been bought; a known zero cost is not unknown.
    latest_unit_cost: str | None
    latest_purchase_date: date | None
    permitted_actions: dict[Literal["edit", "opening", "waste", "correction"], PermittedAction]


class MovementPreviewOut(BaseModel):
    id: str
    expires_at: Instant
    ingredient_id: str
    expected_version: int
    before_quantity: str
    delta_base_quantity: str
    after_quantity: str


class MovementOut(BaseModel):
    id: str
    ingredient_id: str
    delta_base_quantity: str
    before_quantity: str
    after_quantity: str
    type: MovementType
    reason: str
    purchase_id: str | None
    preparation_id: str | None
    corrects_movement_id: str | None
    operation_id: str
    recorded_at: Instant
    # The display name of whoever recorded it, as it was then.
    recorded_by: str


class MovementResultOut(BaseModel):
    movement: MovementOut
    ingredient: IngredientOut


class PreviewLineOut(BaseModel):
    client_line_id: str
    ingredient_id: str
    base_quantity: str
    base_unit: BaseUnit
    total_cost_minor: Money
    unit_cost: str
    ingredient_version: int
    before_quantity: str
    after_quantity: str


class PurchasePreviewOut(BaseModel):
    id: str
    expires_at: Instant
    currency: str
    minor_digits: int
    total_cost_minor: Money
    items: list[PreviewLineOut]


class PackContentsOut(BaseModel):
    quantity: str
    unit: PhysicalUnit


class ReceiptLineOut(BaseModel):
    id: str
    ingredient_id: str
    ingredient_name: str
    base_unit: BaseUnit
    quantity: str
    unit: PurchaseUnit
    pack_contents: PackContentsOut | None
    base_quantity: str
    unit_cost: str
    total_cost_minor: Money
    stock_movement_id: str


class PurchaseSummaryOut(BaseModel):
    id: str
    reference: str
    purchased_on: date
    supplier: str
    currency: str
    minor_digits: int
    total_cost_minor: Money
    recorded_at: Instant


class PurchaseOut(BaseModel):
    id: str
    reference: str
    purchased_on: date
    supplier: str
    note: str
    currency: str
    minor_digits: int
    total_cost_minor: Money
    items: list[ReceiptLineOut]
    operation_id: str
    recorded_at: Instant
    recorded_by: str


class PurchaseResultOut(BaseModel):
    purchase: PurchaseOut
    ingredients: list[IngredientOut]


class PriceOut(ReceiptLineOut):
    """A receipt line seen from its ingredient: what was paid, when, and to whom."""

    purchase_id: str
    reference: str
    supplier: str
    purchased_on: date
    recorded_at: Instant
    currency: str
    minor_digits: int
