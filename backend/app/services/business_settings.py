import re
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from typing import Any
from zoneinfo import available_timezones

from sqlalchemy.orm import Session

from app.errors import ApiError, OperatorError
from app.persistence.models import BusinessSettings
from app.values import MAX_SAFE_INTEGER

CAPABILITIES = (
    "orders",
    "menu",
    "payments",
    "inventory",
    "purchases",
    "recipes",
    "planning",
    "preparation_recording",
)
# Workflows this version of the server actually implements. Each backend phase adds its own;
# nothing outside this set can be switched on or is ever reported as on.
RELEASED: frozenset[str] = frozenset({"menu", "orders", "payments"})

ENVIRONMENTS = ("development", "live")
FULFILLMENT_METHODS = ("pickup", "delivery")
DELIVERY_MODES = ("manual_amount", "fixed_amount", "disabled")
TAX_MODES = ("manual_amount",)
PAYMENT_METHODS = ("cash", "bank_transfer", "other")

# The groups the operator confirms, and the values each confirmation vouches for. Changing
# one of those values withdraws the confirmation.
CONFIRMABLE: dict[str, tuple[str, ...]] = {
    "currency": ("currency", "minor_digits"),
    "timezone": ("timezone",),
    "fulfillment": ("fulfillment_methods", "pickup_location"),
    "delivery": ("delivery_mode", "fixed_charge_minor"),
    "tax": ("tax_mode", "tax_inclusive"),
}
# What the first `settings set` must supply, with the command-line option that supplies it.
_FIRST_TIME = {
    "currency": "--currency",
    "minor_digits": "--minor-digits",
    "timezone": "--timezone",
    "fulfillment_methods": "--fulfillment",
}


# What local setup starts a development machine with: the provisional assumptions the decision
# register lists for B01-B04. None is a business fact, and none is ever confirmed here.
PROVISIONAL_DEVELOPMENT: dict[str, Any] = {
    "currency": "USD",
    "minor_digits": 2,
    "timezone": "America/Los_Angeles",
    "fulfillment_methods": "pickup,delivery",
    "delivery_mode": "manual_amount",
    "payment_methods": "cash,bank_transfer,other",
}


def load(db: Session) -> BusinessSettings | None:
    return db.get(BusinessSettings, 1)


def require(db: Session) -> BusinessSettings:
    """The settings, or a refusal: no request is ever served from built-in defaults."""
    settings = load(db)
    if settings is None:
        raise ApiError(
            503,
            "temporarily_unavailable",
            "Business settings have not been set up yet. Ask whoever runs the server.",
        )
    return settings


def enabled(db: Session, name: str) -> bool:
    """Whether the operator has enabled a workflow this server implements."""
    settings = load(db)
    return settings is not None and name in settings.capabilities and name in RELEASED


def require_capability(db: Session, name: str) -> None:
    """Refuse unless the operator has enabled a workflow this server implements."""
    settings = require(db)
    if name not in settings.capabilities or name not in RELEASED:
        raise ApiError(403, "action_forbidden", f"The {name} workflow is not enabled.")


def is_live(db: Session) -> bool:
    settings = load(db)
    return settings is not None and settings.environment == "live"


def require_confirmed(settings: BusinessSettings, *groups: str) -> None:
    """Fail closed: a live system refuses work that depends on settings nobody has confirmed.

    Development settings stay usable unconfirmed; the frontend labels them provisional.
    """
    unconfirmed = [group for group in groups if group not in settings.confirmed]
    if settings.environment == "live" and unconfirmed:
        raise ApiError(
            409,
            "settings_unconfirmed",
            "Business settings must be confirmed before this can be saved.",
            details={"unconfirmed": unconfirmed},
        )


def _choice(label: str, allowed: Sequence[str]) -> Callable[[Any], str]:
    def check(value: Any) -> str:
        if value not in allowed:
            raise OperatorError(f"{label} must be one of: {', '.join(allowed)}.")
        return str(value)

    return check


def _subset(label: str, allowed: Sequence[str]) -> Callable[[Any], list[str]]:
    def check(value: Any) -> list[str]:
        chosen = [part.strip() for part in str(value).split(",")]
        if set(chosen) - set(allowed) or len(set(chosen)) != len(chosen):
            raise OperatorError(
                f"{label} takes one or more of: {', '.join(allowed)}, separated by commas."
            )
        # Stored in one fixed order, so the same choice never looks like a change.
        return [name for name in allowed if name in chosen]

    return check


def _currency(value: Any) -> str:
    if not re.fullmatch("[A-Z]{3}", str(value)):
        raise OperatorError("Currency must be a three-letter ISO code in capitals, such as USD.")
    return str(value)


def _whole(label: str, lowest: int, highest: int) -> Callable[[Any], int]:
    def check(value: Any) -> int:
        if not isinstance(value, int) or not lowest <= value <= highest:
            raise OperatorError(f"{label} must be a whole number from {lowest} to {highest}.")
        return value

    return check


def _timezone(value: Any) -> str:
    if value not in available_timezones():
        raise OperatorError(f"`{value}` is not a known IANA timezone, such as Asia/Manila.")
    return str(value)


def _pickup_location(value: Any) -> str | None:
    if value is None:
        return None
    location = str(value).strip()
    if not location or len(location) > 500:
        raise OperatorError("The pickup location must be 1 to 500 characters.")
    return location


_RULES: dict[str, Callable[[Any], Any]] = {
    "environment": _choice("Environment", ENVIRONMENTS),
    "currency": _currency,
    "minor_digits": _whole("Minor digits", 0, 4),
    "timezone": _timezone,
    "fulfillment_methods": _subset("Fulfillment", FULFILLMENT_METHODS),
    "pickup_location": _pickup_location,
    "delivery_mode": _choice("Delivery mode", DELIVERY_MODES),
    "fixed_charge_minor": _whole("The fixed delivery charge", 0, MAX_SAFE_INTEGER),
    "tax_mode": _choice("Tax mode", TAX_MODES),
    "payment_methods": _subset("Payment methods", PAYMENT_METHODS),
}


def _values(settings: BusinessSettings) -> dict[str, Any]:
    return {name: getattr(settings, name) for name in (*_RULES, "capabilities")}


def change(
    db: Session,
    now: datetime,
    changes: Mapping[str, Any],
    *,
    enable: Sequence[str] = (),
    disable: Sequence[str] = (),
) -> bool:
    """Apply the operator's changes to the single settings record, creating it the first time.

    Returns whether anything changed. A change raises the version by one and withdraws the
    confirmation of every group it touched.
    """
    clean = {name: _RULES[name](value) for name, value in changes.items()}
    settings = load(db)
    if settings is None:
        missing = [option for name, option in _FIRST_TIME.items() if name not in clean]
        if missing:
            raise OperatorError(
                f"No settings exist yet. The first `settings set` also needs {', '.join(missing)}."
            )
        # Everything the operator did not choose starts closed.
        settings = BusinessSettings(
            id=1,
            version=0,
            environment="development",
            pickup_location=None,
            delivery_mode="disabled",
            fixed_charge_minor=None,
            tax_mode="manual_amount",
            tax_inclusive=False,
            payment_methods=[],
            capabilities=[],
            confirmed=[],
            confirmed_at=None,
            updated_at=now,
            **{name: clean[name] for name in _FIRST_TIME},
        )
        db.add(settings)
        before: dict[str, Any] = {}
    else:
        before = _values(settings)

    for name, value in clean.items():
        setattr(settings, name, value)
    if settings.delivery_mode != "fixed_amount":
        if "fixed_charge_minor" in clean:
            raise OperatorError(
                "--fixed-charge-minor applies only with --delivery-mode fixed_amount."
            )
        settings.fixed_charge_minor = None
    elif settings.fixed_charge_minor is None:
        raise OperatorError("The fixed_amount delivery mode needs --fixed-charge-minor.")

    unreleased = [name for name in enable if name not in RELEASED]
    if unreleased:
        raise OperatorError(
            f"Not available in this version of the server: {', '.join(unreleased)}."
        )
    if set(enable) & set(disable):
        raise OperatorError("A workflow cannot be enabled and disabled in one command.")
    switched_on = (set(settings.capabilities) | set(enable)) - set(disable)
    settings.capabilities = [name for name in CAPABILITIES if name in switched_on]

    after = _values(settings)
    if after == before:
        return False
    touched = {name for name in after if after[name] != before.get(name)}
    if before:
        settings.confirmed = [
            group for group in settings.confirmed if not touched & set(CONFIRMABLE[group])
        ]
    if not settings.confirmed:
        settings.confirmed_at = None
    settings.version += 1
    settings.updated_at = now
    return True


def confirm(db: Session, now: datetime, groups: Sequence[str]) -> bool:
    """Record that the operator confirmed these groups, and when. Returns whether any was new."""
    unknown = [group for group in groups if group not in CONFIRMABLE]
    if unknown:
        raise OperatorError(
            f"Unknown group: {', '.join(unknown)}. Choose from: {', '.join(CONFIRMABLE)}."
        )
    settings = load(db)
    if settings is None:
        raise OperatorError("No settings exist yet. Use `food-admin settings set` first.")
    newly = set(groups) - set(settings.confirmed)
    if not newly:
        return False
    settings.confirmed = [
        group for group in CONFIRMABLE if group in newly | set(settings.confirmed)
    ]
    settings.confirmed_at = now
    settings.version += 1
    settings.updated_at = now
    return True
