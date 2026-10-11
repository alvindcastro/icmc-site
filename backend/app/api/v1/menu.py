from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import App, JsonBody, Staff, no_query
from app.api.description import keyed
from app.errors import ApiError, parse
from app.listing import Page, PageQuery, page_of, select_page
from app.persistence.models import Category, Food
from app.schemas.menu import (
    CategoryOut,
    FoodCreate,
    FoodOut,
    FoodQuery,
    FoodUpdate,
    VariantCreate,
    VariantOut,
    VariantUpdate,
    category_out,
    food_out,
    variant_out,
)
from app.services import business_settings, menu, operations
from app.services.operations import Done


def menu_enabled(staff: Staff, app: App) -> None:
    """Every menu route, reading included, needs the operator to have enabled the workflow."""
    with app.database.read() as db:
        business_settings.require_capability(db, "menu")


router = APIRouter(tags=["menu"], dependencies=[Depends(menu_enabled)])
_plain = [Depends(no_query)]


@router.get("/categories")
def categories(query: Annotated[PageQuery, Query()], app: App) -> Page[CategoryOut]:
    with app.database.read() as db:
        found, total = select_page(
            db, select(Category), query, Category.name_key, tie_breaker=Category.id
        )
        return page_of([category_out(category) for category in found], total, query)


@router.get("/foods")
def foods(query: Annotated[FoodQuery, Query()], app: App) -> Page[FoodOut]:
    statement = select(Food)
    text = (query.q or "").strip()
    if text:
        statement = statement.where(Food.name_key.contains(text.casefold(), autoescape=True))
    if query.available is not None:
        # Availability of the food itself; its unavailable variants still come back with it.
        statement = statement.where(Food.available == (query.available == "true"))
    with app.database.read() as db:
        if query.category_id is not None:
            menu.require_category_filter(db, query.category_id)
            statement = statement.where(Food.category_id == query.category_id)
        found, total = select_page(db, statement, query, Food.name_key, tie_breaker=Food.id)
        return page_of([food_out(food) for food in found], total, query)


@router.get("/foods/{food_id}", dependencies=_plain)
def food(food_id: str, app: App) -> FoodOut:
    with app.database.read() as db:
        found = db.get(Food, food_id)
        if found is None:
            raise ApiError(404, "not_found", "This food does not exist.")
        return food_out(found)


@router.post(
    "/foods",
    status_code=201,
    response_model=FoodOut,
    dependencies=_plain,
    openapi_extra=keyed(FoodCreate),
)
def create_food(payload: JsonBody, request: Request, app: App) -> Response:
    def change(db: Session) -> Done:
        created = menu.create_food(db, parse(FoodCreate, payload), app.clock())
        return Done(201, "food", created.id, food_out(created))

    return operations.execute(app, request, payload, change)


@router.patch(
    "/foods/{food_id}", response_model=FoodOut, dependencies=_plain, openapi_extra=keyed(FoodUpdate)
)
def update_food(
    food_id: str, payload: JsonBody, request: Request, staff: Staff, app: App
) -> Response:
    def change(db: Session) -> Done:
        body = parse(FoodUpdate, payload)
        updated = menu.update_food(db, food_id, body, app.clock(), staff.user.id)
        return Done(200, "food", updated.id, food_out(updated))

    return operations.execute(app, request, payload, change)


@router.post(
    "/foods/{food_id}/variants",
    status_code=201,
    response_model=VariantOut,
    dependencies=_plain,
    openapi_extra=keyed(VariantCreate),
)
def create_variant(food_id: str, payload: JsonBody, request: Request, app: App) -> Response:
    def change(db: Session) -> Done:
        created = menu.create_variant(db, food_id, parse(VariantCreate, payload), app.clock())
        db.flush()
        return Done(201, "variant", created.id, variant_out(created))

    return operations.execute(app, request, payload, change)


@router.patch(
    "/variants/{variant_id}",
    response_model=VariantOut,
    dependencies=_plain,
    openapi_extra=keyed(VariantUpdate),
)
def update_variant(
    variant_id: str, payload: JsonBody, request: Request, staff: Staff, app: App
) -> Response:
    def change(db: Session) -> Done:
        body = parse(VariantUpdate, payload)
        updated = menu.update_variant(db, variant_id, body, app.clock(), staff.user.id)
        return Done(200, "variant", updated.id, variant_out(updated))

    return operations.execute(app, request, payload, change)
