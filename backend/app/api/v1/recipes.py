from fastapi import APIRouter, Depends, Response

from app.api.deps import App, Staff, no_query
from app.schemas.recipes import EstimateOut, RecipeIn, RecipeOut
from app.services import business_settings, recipes


def recipes_enabled(staff: Staff, app: App) -> None:
    """Recipes join the menu to the stockroom, so all three workflows must be enabled; a live
    system also needs its currency and timezone confirmed."""
    with app.database.read() as db:
        for name in ("menu", "recipes", "inventory"):
            business_settings.require_capability(db, name)
        business_settings.require_confirmed(business_settings.require(db), "currency", "timezone")


router = APIRouter(tags=["recipes"], dependencies=[Depends(recipes_enabled), Depends(no_query)])


@router.get("/variants/{variant_id}/recipe", response_model_by_alias=True)
def read(variant_id: str, app: App) -> RecipeOut:
    with app.database.read() as db:
        return recipes.recipe_out(db, recipes.get(db, variant_id))


@router.put("/variants/{variant_id}/recipe", response_model_by_alias=True)
def save(variant_id: str, body: RecipeIn, response: Response, app: App) -> RecipeOut:
    """Create or replace the recipe. No operation key: the version guard makes a repeat stale."""
    with app.database.write() as db:
        recipe, created = recipes.save(db, variant_id, body, app.clock())
        response.status_code = 201 if created else 200
        return recipes.recipe_out(db, recipe)


@router.get("/variants/{variant_id}/estimate")
def estimate(variant_id: str, app: App) -> EstimateOut:
    with app.database.read() as db:
        return recipes.estimate(db, variant_id, app.clock())
