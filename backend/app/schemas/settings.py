from typing import Literal

from pydantic import BaseModel

from app.persistence.models import BusinessSettings
from app.services import business_settings
from app.values import Instant, Money


class ConfirmationOut(BaseModel):
    currency: bool
    timezone: bool
    fulfillment: bool
    delivery: bool
    tax: bool
    confirmed_at: Instant | None


class DeliveryPolicyOut(BaseModel):
    mode: Literal["manual_amount", "fixed_amount", "disabled"]
    fixed_charge_minor: Money | None


class TaxPolicyOut(BaseModel):
    mode: Literal["manual_amount"]
    inclusive: bool


class SettingsOut(BaseModel):
    version: int
    environment: Literal["development", "live"]
    confirmation: ConfirmationOut
    currency: str
    minor_digits: int
    timezone: str
    fulfillment_methods: list[Literal["pickup", "delivery"]]
    pickup_location: str | None
    delivery_policy: DeliveryPolicyOut
    tax_policy: TaxPolicyOut
    payment_methods: list[Literal["cash", "bank_transfer", "other"]]
    capabilities: dict[str, bool]


def settings_out(settings: BusinessSettings) -> SettingsOut:
    confirmed = set(settings.confirmed)
    return SettingsOut.model_validate(
        {
            "version": settings.version,
            "environment": settings.environment,
            "confirmation": {
                **{group: group in confirmed for group in business_settings.CONFIRMABLE},
                "confirmed_at": settings.confirmed_at,
            },
            "currency": settings.currency,
            "minor_digits": settings.minor_digits,
            "timezone": settings.timezone,
            "fulfillment_methods": settings.fulfillment_methods,
            "pickup_location": settings.pickup_location,
            "delivery_policy": {
                "mode": settings.delivery_mode,
                "fixed_charge_minor": settings.fixed_charge_minor,
            },
            "tax_policy": {"mode": settings.tax_mode, "inclusive": settings.tax_inclusive},
            "payment_methods": settings.payment_methods,
            # Stored and released: a workflow this version lacks is never reported as on.
            "capabilities": {
                name: name in settings.capabilities and name in business_settings.RELEASED
                for name in business_settings.CAPABILITIES
            },
        }
    )
