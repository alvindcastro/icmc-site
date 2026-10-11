from fastapi import APIRouter, Depends

from app.api.deps import App, Staff, no_query
from app.schemas.settings import SettingsOut, settings_out
from app.services import business_settings

router = APIRouter(tags=["settings"], dependencies=[Depends(no_query)])


@router.get("/settings")
def read(staff: Staff, app: App) -> SettingsOut:
    with app.database.read() as db:
        return settings_out(business_settings.require(db))
