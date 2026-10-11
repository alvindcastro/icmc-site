from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from app.api.deps import App, JsonBody, Staff, no_query
from app.api.description import keyed
from app.errors import parse
from app.listing import Page, PageQuery
from app.schemas.inventory import (
    IngredientCreate,
    IngredientOut,
    IngredientQuery,
    IngredientUpdate,
    MovementIn,
    MovementOut,
    MovementPreviewOut,
    MovementResultOut,
    MovementSave,
    PriceOut,
    PurchaseOut,
    PurchasePreviewIn,
    PurchasePreviewOut,
    PurchaseQuery,
    PurchaseResultOut,
    PurchaseSave,
    PurchaseSummaryOut,
)
from app.services import business_settings, inventory, operations
from app.services.operations import Done


def inventory_enabled(staff: Staff, app: App) -> None:
    """The stockroom needs its workflow enabled and, in a live system, a confirmed currency
    and timezone. Fulfillment, delivery and tax do not concern it."""
    with app.database.read() as db:
        business_settings.require_capability(db, "inventory")
        business_settings.require_confirmed(business_settings.require(db), "currency", "timezone")


def purchases_enabled(app: App) -> None:
    with app.database.read() as db:
        business_settings.require_capability(db, "purchases")


router = APIRouter(tags=["inventory"], dependencies=[Depends(inventory_enabled)])
_plain = [Depends(no_query)]
_buying = [Depends(purchases_enabled)]
_buying_plain = [Depends(purchases_enabled), Depends(no_query)]


@router.get("/ingredients")
def ingredients(query: Annotated[IngredientQuery, Query()], app: App) -> Page[IngredientOut]:
    with app.database.read() as db:
        return inventory.find_ingredients(db, query)


@router.get("/ingredients/{ingredient_id}", dependencies=_plain)
def ingredient(ingredient_id: str, app: App) -> IngredientOut:
    with app.database.read() as db:
        return inventory.ingredient_out(inventory.get_ingredient(db, ingredient_id))


@router.post(
    "/ingredients",
    status_code=201,
    response_model=IngredientOut,
    dependencies=_plain,
    openapi_extra=keyed(IngredientCreate),
)
def create_ingredient(payload: JsonBody, request: Request, app: App) -> Response:
    def change(db: Session) -> Done:
        created = inventory.create_ingredient(db, parse(IngredientCreate, payload), app.clock())
        return Done(201, "ingredient", created.id, inventory.ingredient_out(created))

    return operations.execute(app, request, payload, change)


@router.patch(
    "/ingredients/{ingredient_id}",
    response_model=IngredientOut,
    dependencies=_plain,
    openapi_extra=keyed(IngredientUpdate),
)
def update_ingredient(
    ingredient_id: str, payload: JsonBody, request: Request, app: App
) -> Response:
    def change(db: Session) -> Done:
        body = parse(IngredientUpdate, payload)
        updated = inventory.update_ingredient(db, ingredient_id, body, app.clock())
        return Done(200, "ingredient", updated.id, inventory.ingredient_out(updated))

    return operations.execute(app, request, payload, change)


@router.get("/ingredients/{ingredient_id}/movements")
def movements(
    ingredient_id: str, query: Annotated[PageQuery, Query()], app: App
) -> Page[MovementOut]:
    with app.database.read() as db:
        return inventory.list_movements(db, ingredient_id, query)


@router.get("/ingredients/{ingredient_id}/prices")
def prices(ingredient_id: str, query: Annotated[PageQuery, Query()], app: App) -> Page[PriceOut]:
    with app.database.read() as db:
        return inventory.list_prices(db, ingredient_id, query)


@router.post("/ingredients/{ingredient_id}/movement-preview", dependencies=_plain)
def preview_movement(ingredient_id: str, body: MovementIn, app: App) -> MovementPreviewOut:
    """Show what a movement would do. Nothing is saved but the preview itself."""
    with app.database.write() as db:
        return inventory.preview_movement(db, ingredient_id, body, app.clock())


@router.post(
    "/ingredients/{ingredient_id}/movements",
    status_code=201,
    response_model=MovementResultOut,
    dependencies=_plain,
    openapi_extra=keyed(MovementSave),
)
def save_movement(
    ingredient_id: str, payload: JsonBody, request: Request, staff: Staff, app: App
) -> Response:
    def change(db: Session) -> Done:
        body = parse(MovementSave, payload)
        key = operations.key_of(request)
        movement, changed = inventory.save_movement(
            db, ingredient_id, body, key, staff.user, app.clock()
        )
        result = MovementResultOut(
            movement=inventory.movement_out(movement), ingredient=inventory.ingredient_out(changed)
        )
        return Done(201, "ingredient", changed.id, result)

    return operations.execute(app, request, payload, change)


@router.get("/purchases", dependencies=_buying)
def purchases(query: Annotated[PurchaseQuery, Query()], app: App) -> Page[PurchaseSummaryOut]:
    with app.database.read() as db:
        return inventory.find_purchases(db, query)


@router.post("/purchases/preview", dependencies=_buying_plain)
def preview_purchase(body: PurchasePreviewIn, app: App) -> PurchasePreviewOut:
    """Normalize a receipt and show its effect on stock. Nothing is saved but the preview."""
    with app.database.write() as db:
        return inventory.preview_purchase(db, body.draft, app.clock())


@router.get("/purchases/{purchase_id}", dependencies=_buying_plain)
def purchase(purchase_id: str, app: App) -> PurchaseOut:
    with app.database.read() as db:
        return inventory.purchase_out(inventory.get_purchase(db, purchase_id))


@router.post(
    "/purchases",
    status_code=201,
    response_model=PurchaseResultOut,
    dependencies=_buying_plain,
    openapi_extra=keyed(PurchaseSave),
)
def save_purchase(payload: JsonBody, request: Request, staff: Staff, app: App) -> Response:
    def change(db: Session) -> Done:
        body = parse(PurchaseSave, payload)
        key = operations.key_of(request)
        saved, changed = inventory.save_purchase(db, body, key, staff.user, app.clock())
        db.flush()
        result = PurchaseResultOut(
            purchase=inventory.purchase_out(saved),
            ingredients=[inventory.ingredient_out(item) for item in changed],
        )
        return Done(201, "purchase", saved.id, result)

    return operations.execute(app, request, payload, change)
