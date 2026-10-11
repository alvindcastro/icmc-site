from fastapi import APIRouter, Depends

from app.api.deps import guard_mutation
from app.api.v1 import auth, menu, operations, orders, settings

# Each contract area adds its router here when its phase is delivered. The guard covers every
# route, so a later mutation cannot be added without its Origin and CSRF checks.
router = APIRouter(prefix="/api/v1", dependencies=[Depends(guard_mutation)])
router.include_router(auth.router)
router.include_router(settings.router)
router.include_router(operations.router)
router.include_router(menu.router)
router.include_router(orders.router)
