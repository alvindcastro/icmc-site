from typing import Self

from pydantic import BaseModel, model_validator


class PermittedAction(BaseModel):
    """Whether staff may take an action on a record now, and if not, why."""

    allowed: bool
    reason_code: str | None
    reason: str | None

    @model_validator(mode="after")
    def _explained(self) -> Self:
        if self.allowed and (self.reason_code is not None or self.reason is not None):
            raise ValueError("An allowed action carries no reason.")
        if not self.allowed and not (
            self.reason_code and self.reason_code.strip() and self.reason and self.reason.strip()
        ):
            raise ValueError("A blocked action needs a reason code and a reason.")
        return self


def allowed() -> PermittedAction:
    return PermittedAction(allowed=True, reason_code=None, reason=None)


def blocked(reason_code: str, reason: str) -> PermittedAction:
    return PermittedAction(allowed=False, reason_code=reason_code, reason=reason)
