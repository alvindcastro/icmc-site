from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app.api.deps import App, JsonBody, Staff, no_query
from app.errors import parse
from app.schemas.preparations import (
    CorrectionIn,
    CorrectionListOut,
    CorrectionPreviewOut,
    CorrectionResultOut,
    CorrectionSave,
    PreparationOut,
    PreparationPreviewIn,
    PreparationPreviewOut,
    PreparationResultOut,
    PreparationSave,
)
from app.services import business_settings, inventory, operations, orders, preparations
from app.services.operations import Done


def recording_enabled(staff: Staff, app: App) -> None:
    """Recording works from the plan and takes from the shelf, so it needs orders, planning,
    the stockroom and its own workflow; a live system also needs currency and timezone
    confirmed, as the stockroom does."""
    with app.database.read() as db:
        for name in ("orders", "planning", "inventory", "preparation_recording"):
            business_settings.require_capability(db, name)
        business_settings.require_confirmed(business_settings.require(db), "currency", "timezone")


router = APIRouter(
    tags=["preparations"], dependencies=[Depends(recording_enabled), Depends(no_query)]
)


@router.post("/preparations/preview")
def preview(body: PreparationPreviewIn, app: App) -> PreparationPreviewOut:
    """Review a draft. Nothing is saved but the review itself, so no operation key is needed."""
    with app.database.write() as db:
        return preparations.preview(db, body, app.clock())


@router.post("/preparations", status_code=201, response_model=PreparationResultOut)
def save(payload: JsonBody, request: Request, staff: Staff, app: App) -> Response:
    def change(db: Session) -> Done:
        body = parse(PreparationSave, payload)
        key = operations.key_of(request)
        record, changed, stock = preparations.save(db, body, key, staff.user, app.clock())
        result = PreparationResultOut(
            preparation=preparations.preparation_out(record),
            orders=[orders.order_out(db, order) for order in changed],
            ingredients=[inventory.ingredient_out(item) for item in stock],
        )
        return Done(201, "preparation", record.id, result)

    return operations.execute(app, request, payload, change)


@router.get("/preparations/{preparation_id}")
def read(preparation_id: str, app: App) -> PreparationOut:
    with app.database.read() as db:
        return preparations.preparation_out(preparations.get(db, preparation_id))


@router.get("/preparations/{preparation_id}/corrections")
def corrections(preparation_id: str, app: App) -> CorrectionListOut:
    with app.database.read() as db:
        found = preparations.corrections_of(db, preparation_id)
        return CorrectionListOut(items=[preparations.correction_out(item) for item in found])


@router.post("/preparations/{preparation_id}/correction-preview")
def preview_correction(preparation_id: str, body: CorrectionIn, app: App) -> CorrectionPreviewOut:
    with app.database.write() as db:
        return preparations.preview_correction(db, preparation_id, body, app.clock())


@router.post(
    "/preparations/{preparation_id}/corrections",
    status_code=201,
    response_model=CorrectionResultOut,
)
def save_correction(
    preparation_id: str, payload: JsonBody, request: Request, staff: Staff, app: App
) -> Response:
    def change(db: Session) -> Done:
        body = parse(CorrectionSave, payload)
        key = operations.key_of(request)
        saved, changed, stock = preparations.save_correction(
            db, preparation_id, body, key, staff.user, app.clock()
        )
        result = CorrectionResultOut(
            correction=preparations.correction_out(saved),
            orders=[orders.order_out(db, order) for order in changed],
            ingredients=[inventory.ingredient_out(item) for item in stock],
        )
        return Done(201, "preparation_correction", saved.id, result)

    return operations.execute(app, request, payload, change)
