from typing import Annotated, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool

from app.actions import PermittedAction, allowed
from app.listing import PageQuery
from app.persistence.models import Category, Food, Variant
from app.schemas.shared import Text, Update, entered
from app.values import Money, SellingQuantity

SellingUnit = Literal["tray", "piece", "stick", "package"]
Confirmation = Literal["provisional", "confirmed"]

FoodName = Annotated[Text, entered(200, "Enter a food name.")]
Label = Annotated[Text, entered(200, "Enter a variant label.")]
Description = Annotated[str, Field(strict=True, max_length=2000)]


class PackageContents(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quantity: SellingQuantity
    unit: Literal["piece"]


class FoodCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: FoodName
    category_id: Text
    description: Description = ""
    available: StrictBool


class VariantCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: Label
    selling_unit: SellingUnit
    price_minor: Money
    available: StrictBool
    # Always stated: the piece count for a package, null for every other unit.
    package_contents: PackageContents | None


class FoodUpdate(Update):
    name: FoodName | None = None
    category_id: Text | None = None
    description: Description | None = None
    available: StrictBool | None = None


class VariantUpdate(Update):
    nullable: ClassVar[frozenset[str]] = frozenset({"package_contents"})

    label: Label | None = None
    selling_unit: SellingUnit | None = None
    price_minor: Money | None = None
    available: StrictBool | None = None
    package_contents: PackageContents | None = None


class FoodQuery(PageQuery):
    q: Annotated[str | None, Field(max_length=200)] = None
    category_id: str | None = None
    # Exactly these two words; "1", "yes" and the like are refused rather than guessed at.
    available: Literal["true", "false"] | None = None


class CategoryOut(BaseModel):
    id: str
    name: str


class VariantOut(BaseModel):
    id: str
    version: int
    food_id: str
    label: str
    selling_unit: SellingUnit
    price_minor: Money
    available: bool
    confirmation_status: Confirmation
    package_contents: PackageContents | None
    recipe_id: str | None
    permitted_actions: dict[Literal["edit"], PermittedAction]


class FoodOut(BaseModel):
    id: str
    version: int
    name: str
    category_id: str
    description: str
    available: bool
    confirmation_status: Confirmation
    variants: list[VariantOut]
    permitted_actions: dict[Literal["edit", "add_variant"], PermittedAction]


def category_out(category: Category) -> CategoryOut:
    return CategoryOut(id=category.id, name=category.name)


def variant_out(variant: Variant) -> VariantOut:
    contents = (
        None
        if variant.package_quantity is None
        else PackageContents(quantity=variant.package_quantity, unit="piece")
    )
    return VariantOut.model_validate(
        {
            "id": variant.id,
            "version": variant.version,
            "food_id": variant.food_id,
            "label": variant.label,
            "selling_unit": variant.selling_unit,
            "price_minor": variant.price_minor,
            "available": variant.available,
            "confirmation_status": variant.confirmation_status,
            "package_contents": contents,
            # Recipes arrive in a later phase.
            "recipe_id": None,
            "permitted_actions": {"edit": allowed()},
        }
    )


def food_out(food: Food) -> FoodOut:
    return FoodOut.model_validate(
        {
            "id": food.id,
            "version": food.version,
            "name": food.name,
            "category_id": food.category_id,
            "description": food.description,
            "available": food.available,
            "confirmation_status": food.confirmation_status,
            "variants": [variant_out(variant) for variant in food.variants],
            "permitted_actions": {"edit": allowed(), "add_variant": allowed()},
        }
    )
