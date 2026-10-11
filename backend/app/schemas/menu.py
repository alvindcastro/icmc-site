from typing import Annotated, Any, ClassVar, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool
from pydantic_core import PydanticCustomError

from app.actions import PermittedAction, allowed
from app.errors import FieldError, invalid, pointer
from app.listing import PageQuery
from app.persistence.models import Category, Food, Variant
from app.values import MAX_SAFE_INTEGER, Money, SellingQuantity

SellingUnit = Literal["tray", "piece", "stick", "package"]
Confirmation = Literal["provisional", "confirmed"]


def _named(message: str) -> AfterValidator:
    """Trimmed, not blank, and at most 200 characters once trimmed."""

    def check(value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise PydanticCustomError("required", message)
        if len(trimmed) > 200:
            raise PydanticCustomError("too_long", "Use at most 200 characters.")
        return trimmed

    return AfterValidator(check)


Text = Annotated[str, Field(strict=True)]
FoodName = Annotated[Text, _named("Enter a food name.")]
Label = Annotated[Text, _named("Enter a variant label.")]
Description = Annotated[str, Field(strict=True, max_length=2000)]
Version = Annotated[int, Field(strict=True, ge=1, le=MAX_SAFE_INTEGER)]


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


class Update(BaseModel):
    """An edit: the version the editor saw, plus only the fields being changed."""

    model_config = ConfigDict(extra="forbid")
    nullable: ClassVar[frozenset[str]] = frozenset()

    expected_version: Version

    def changes(self) -> dict[str, Any]:
        """The fields that were sent. Leaving a field out keeps it; sending null does not."""
        sent = self.model_dump(exclude_unset=True, exclude={"expected_version"})
        empty = [
            name for name, value in sent.items() if value is None and name not in self.nullable
        ]
        if empty:
            raise invalid(
                *(
                    FieldError(pointer(name), "required", "Give a value or leave this out.")
                    for name in empty
                )
            )
        return sent


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
