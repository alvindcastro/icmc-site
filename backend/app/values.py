import re
from datetime import UTC, date, datetime
from decimal import ROUND_HALF_UP, Context, Decimal
from typing import Annotated

from pydantic import BeforeValidator, Field, PlainSerializer
from pydantic_core import PydanticCustomError

# The largest integer a browser reads from JSON without losing exactness.
MAX_SAFE_INTEGER = 9007199254740991

# Money in minor units and selling quantities are JSON integers only: no strings, floats or bools.
Money = Annotated[int, Field(strict=True, ge=0, le=MAX_SAFE_INTEGER)]
SellingQuantity = Annotated[int, Field(strict=True, ge=1, le=MAX_SAFE_INTEGER)]

# ASCII digits only; `\d` would also accept digits from other scripts.
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_QUANTITY = re.compile(r"(-?)(0|[1-9][0-9]*)(?:\.([0-9]{1,3}))?")
_NINE_DECIMALS = Decimal("0.000000001")
_EXACT = Context(prec=60)


class ValueRejected(ValueError):
    """A value that breaks a shared rule, with the field error code the client should see."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _calendar_date(value: object) -> date:
    if type(value) is date:
        return value
    if isinstance(value, str) and _DATE.fullmatch(value):
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    raise PydanticCustomError("invalid_date", "Enter a real date as YYYY-MM-DD.")


# A day in the business calendar, never a midnight instant.
CalendarDate = Annotated[date, BeforeValidator(_calendar_date)]


def format_instant(value: datetime) -> str:
    """An instant as RFC 3339 UTC to the second, such as `2026-10-10T19:00:00Z`."""
    if value.utcoffset() is None:
        raise ValueError("An instant needs a timezone.")
    return value.astimezone(UTC).replace(microsecond=0, tzinfo=None).isoformat() + "Z"


Instant = Annotated[datetime, PlainSerializer(format_instant, return_type=str)]


def parse_quantity(text: object, unit: str, *, signed: bool = False) -> int:
    """An ingredient quantity as exact thousandths of its base unit.

    Accepts a plain decimal string with at most three decimals. A sign is accepted only for a
    change in stock, and never on zero. Pieces are whole.
    """
    match = _QUANTITY.fullmatch(text) if isinstance(text, str) else None
    if match is None or (match[1] and not signed):
        raise ValueRejected(
            "invalid_quantity", "Enter a quantity with at most three decimal places."
        )
    if len(match[2]) > len(str(MAX_SAFE_INTEGER)):
        raise ValueRejected("quantity_out_of_range", "This quantity is too large.")
    thousandths = int(match[2]) * 1000 + int((match[3] or "").ljust(3, "0"))
    if match[1] and not thousandths:
        raise ValueRejected("invalid_quantity", "Enter zero without a sign.")
    if thousandths > MAX_SAFE_INTEGER * 1000:
        raise ValueRejected("quantity_out_of_range", "This quantity is too large.")
    if unit == "piece" and thousandths % 1000:
        raise ValueRejected("whole_number_required", "Pieces are counted in whole numbers.")
    return -thousandths if match[1] else thousandths


def format_quantity(thousandths: int) -> str:
    """An exact quantity as staff read it: no padding zeros, so 2000 g and not 2000.000 g."""
    whole, fraction = divmod(abs(thousandths), 1000)
    text = f"{whole}.{fraction:03}".rstrip("0").rstrip(".")
    return f"-{text}" if thousandths < 0 else text


def format_unit_cost(cost: Decimal | None) -> str | None:
    """A cost per base unit to nine decimals; an unknown cost stays unknown, never zero."""
    if cost is None:
        return None
    return f"{cost.quantize(_NINE_DECIMALS, rounding=ROUND_HALF_UP, context=_EXACT):f}"
