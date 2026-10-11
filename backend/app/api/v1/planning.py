from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.api.deps import App, Staff
from app.schemas.planning import PlanningOut, PlanningQuery, ShoppingListOut
from app.services import business_settings, planning


def planning_enabled(staff: Staff, app: App) -> None:
    """Planning reads orders, so both workflows must be enabled."""
    with app.database.read() as db:
        for name in ("orders", "planning"):
            business_settings.require_capability(db, name)


router = APIRouter(tags=["planning"], dependencies=[Depends(planning_enabled)])


@router.get("/planning")
def plan(query: Annotated[PlanningQuery, Query()], app: App) -> PlanningOut:
    """What remains to cook in a period and what that needs. Nothing is stored or moved."""
    with app.database.read() as db:
        return planning.calculate(db, query, app.clock())


@router.get("/planning/shopping-list")
def shopping_list(query: Annotated[PlanningQuery, Query()], app: App) -> ShoppingListOut:
    with app.database.read() as db:
        return planning.shopping_list(db, query, app.clock())
