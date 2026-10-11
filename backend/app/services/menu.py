from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.errors import ApiError, FieldError, OperatorError, invalid
from app.ids import new_id
from app.persistence.models import Category, Food, Variant
from app.schemas.menu import (
    FoodCreate,
    FoodUpdate,
    VariantCreate,
    VariantUpdate,
    food_out,
    variant_out,
)
from app.services import audit, business_settings
from app.services.versions import advance

# The rows the decision register knows, all unconfirmed. The two Pork BBQ options are unknown
# there, so none is invented here.
_SEED_CATEGORIES = ("Beef", "Chicken", "Fish, Lumpia & More", "Pork")
_SEED_FOODS: tuple[tuple[str, str, tuple[tuple[str, str, int, int | None], ...]], ...] = (
    (
        "Beef Caldereta",
        "Beef",
        (
            ("Small", "tray", 6000, None),
            ("Medium", "tray", 8000, None),
            ("Large", "tray", 10500, None),
        ),
    ),
    ("Fresh Lumpia", "Fish, Lumpia & More", (("Each", "piece", 300, None),)),
    ("Shanghai Spring Rolls", "Fish, Lumpia & More", (("100 pieces", "package", 5500, 100),)),
)


def _not_found(what: str) -> ApiError:
    return ApiError(404, "not_found", f"This {what} does not exist.")


def _require_category(db: Session, category_id: str, path: str = "/category_id") -> None:
    if db.get(Category, category_id) is None:
        raise invalid(FieldError(path, "unknown_category", "Choose an existing category."))


def require_category_filter(db: Session, category_id: str) -> None:
    _require_category(db, category_id, "/query/category_id")


def _check_package(unit: str, quantity: int | None) -> None:
    if unit == "package" and quantity is None:
        raise invalid(
            FieldError(
                "/package_contents/quantity", "required", "Enter how many pieces one package holds."
            )
        )
    if unit != "package" and quantity is not None:
        raise invalid(
            FieldError("/package_contents", "not_a_package", "Only a package has package contents.")
        )


def add_category(db: Session, name: str, now: datetime) -> Category:
    name = name.strip()
    if not name or len(name) > 200:
        raise OperatorError("A category name is 1 to 200 characters.")
    if db.scalar(select(Category).where(Category.name_key == name.casefold())) is not None:
        raise OperatorError("A category with this name already exists.")
    category = Category(id=new_id("cat"), name=name, name_key=name.casefold(), created_at=now)
    db.add(category)
    return category


def create_food(db: Session, body: FoodCreate, now: datetime) -> Food:
    _require_category(db, body.category_id)
    food = Food(
        id=new_id("food"),
        version=1,
        name=body.name,
        name_key=body.name.casefold(),
        category_id=body.category_id,
        description=body.description,
        available=body.available,
        confirmation_status="provisional",
        created_at=now,
        updated_at=now,
    )
    db.add(food)
    return food


def update_food(db: Session, food_id: str, body: FoodUpdate, now: datetime, actor: str) -> Food:
    food = db.get(Food, food_id)
    if food is None:
        raise _not_found("food")
    changes = body.changes()
    if "category_id" in changes:
        _require_category(db, changes["category_id"])
    advance(food, body.expected_version, "food", lambda: food_out(food).model_dump(mode="json"))
    # A confirmation vouches for the name; renaming withdraws it.
    if changes.get("name", food.name) != food.name and food.confirmation_status == "confirmed":
        food.confirmation_status = "provisional"
        audit.record(db, now, actor, "menu.confirmation_reset", "food", food.id)
    for name, value in changes.items():
        setattr(food, name, value)
    food.name_key = food.name.casefold()
    food.updated_at = now
    return food


def create_variant(db: Session, food_id: str, body: VariantCreate, now: datetime) -> Variant:
    food = db.get(Food, food_id)
    if food is None:
        raise _not_found("food")
    quantity = body.package_contents.quantity if body.package_contents else None
    _check_package(body.selling_unit, quantity)
    variant = Variant(
        id=new_id("var"),
        version=1,
        food_id=food.id,
        position=len(food.variants),
        label=body.label,
        selling_unit=body.selling_unit,
        price_minor=body.price_minor,
        available=body.available,
        confirmation_status="provisional",
        package_quantity=quantity,
        used_on_order=False,
        created_at=now,
        updated_at=now,
    )
    food.variants.append(variant)
    # The food is the aggregate: any change to its variants moves its version too.
    food.version += 1
    food.updated_at = now
    return variant


def update_variant(
    db: Session, variant_id: str, body: VariantUpdate, now: datetime, actor: str
) -> Variant:
    variant = db.get(Variant, variant_id)
    food = db.get(Food, variant.food_id) if variant is not None else None
    if variant is None or food is None:
        raise _not_found("variant")
    changes = body.changes()
    quantity = variant.package_quantity
    if "package_contents" in changes:
        contents = changes.pop("package_contents")
        quantity = contents["quantity"] if contents else None
    unit = changes.get("selling_unit", variant.selling_unit)
    if variant.used_on_order:
        # Orders already count this variant in its unit; what one of it means cannot move.
        fixed = "Cannot change after the variant has been used on an order."
        if unit != variant.selling_unit:
            raise invalid(FieldError("/selling_unit", "immutable_after_order", fixed))
        if quantity != variant.package_quantity:
            raise invalid(FieldError("/package_contents/quantity", "immutable_after_order", fixed))
    _check_package(unit, quantity)
    advance(
        variant,
        body.expected_version,
        "variant",
        lambda: variant_out(variant).model_dump(mode="json"),
    )
    changes["package_quantity"] = quantity
    material = ("label", "selling_unit", "price_minor", "package_quantity")
    if variant.confirmation_status == "confirmed" and any(
        changes.get(name, getattr(variant, name)) != getattr(variant, name) for name in material
    ):
        variant.confirmation_status = "provisional"
        audit.record(db, now, actor, "menu.confirmation_reset", "variant", variant.id)
    for name, value in changes.items():
        setattr(variant, name, value)
    variant.updated_at = now
    food.version += 1
    food.updated_at = now
    return variant


def confirm(db: Session, kind: str, record_id: str, version: int, now: datetime) -> None:
    """Record that the operator reviewed this exact version of a food or variant."""
    record: Food | Variant | None
    record = db.get(Food, record_id) if kind == "food" else db.get(Variant, record_id)
    if record is None:
        raise OperatorError(f"No {kind} has this ID. `food-admin menu show` lists them.")
    if record.version != version:
        raise OperatorError(
            f"This {kind} is now at version {record.version}. Review it again before confirming."
        )
    if record.confirmation_status == "confirmed":
        raise OperatorError(f"This {kind} is already confirmed.")
    record.confirmation_status = "confirmed"
    record.version += 1
    record.updated_at = now
    if isinstance(record, Variant):
        food = db.get(Food, record.food_id)
        if food is not None:
            food.version += 1
            food.updated_at = now
    audit.record(
        db, now, audit.OPERATOR, "menu.confirmed", kind, record.id, {"version": record.version}
    )


def seed(db: Session, now: datetime) -> int:
    """Fill an empty development menu with the provisional rows; returns how many foods."""
    if business_settings.is_live(db):
        raise OperatorError("The seed is development data and is never loaded into live settings.")
    if db.scalar(select(func.count()).select_from(Food)):
        raise OperatorError("The menu already has foods. The seed only fills an empty menu.")
    categories = {category.name_key: category for category in db.scalars(select(Category))}
    for name in _SEED_CATEGORIES:
        if name.casefold() not in categories:
            categories[name.casefold()] = add_category(db, name, now)
    for name, category, variants in _SEED_FOODS:
        food = Food(
            id=new_id("food"),
            version=1,
            name=name,
            name_key=name.casefold(),
            category_id=categories[category.casefold()].id,
            description="",
            available=True,
            confirmation_status="provisional",
            created_at=now,
            updated_at=now,
        )
        db.add(food)
        for position, (label, unit, price, quantity) in enumerate(variants):
            food.variants.append(
                Variant(
                    id=new_id("var"),
                    version=1,
                    position=position,
                    label=label,
                    selling_unit=unit,
                    price_minor=price,
                    available=True,
                    confirmation_status="provisional",
                    package_quantity=quantity,
                    used_on_order=False,
                    created_at=now,
                    updated_at=now,
                )
            )
    return len(_SEED_FOODS)
