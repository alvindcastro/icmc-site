from fastapi import APIRouter, Depends

from app.api.deps import App, Staff, no_query
from app.errors import ApiError
from app.schemas.operations import OperationOut, operation_out
from app.services import operations

router = APIRouter(tags=["operations"], dependencies=[Depends(no_query)])


@router.get("/operations/{operation_id}")
def read(operation_id: str, staff: Staff, app: App) -> OperationOut:
    """What became of a keyed mutation. An unknown key is 404, which does not prove that the
    original request will never arrive."""
    with app.database.read() as db:
        operation = operations.find(db, operation_id)
        if operation is None:
            raise ApiError(404, "not_found", "No operation with this identifier is recorded.")
        return operation_out(operation)
