from fastapi import APIRouter, Depends

from app.api.deps import guard_mutation
from app.api.v1 import (
    auth,
    inventory,
    menu,
    operations,
    orders,
    planning,
    preparations,
    recipes,
    settings,
)

# Each contract area adds its router here when its phase is delivered. The guard covers every
# route, so a later mutation cannot be added without its Origin and CSRF checks.
router = APIRouter(prefix="/api/v1", dependencies=[Depends(guard_mutation)])
router.include_router(auth.router)
router.include_router(settings.router)
router.include_router(operations.router)
router.include_router(menu.router)
router.include_router(orders.router)
router.include_router(inventory.router)
router.include_router(recipes.router)
router.include_router(planning.router)
router.include_router(preparations.router)
