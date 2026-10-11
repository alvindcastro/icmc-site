from typing import Annotated, Any, ClassVar

from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from pydantic_core import PydanticCustomError

from app.errors import FieldError, invalid, pointer
from app.values import MAX_SAFE_INTEGER

# A JSON string only: numbers and booleans are not coerced into text.
Text = Annotated[str, Field(strict=True)]
Notes = Annotated[str, Field(strict=True, max_length=2000)]
Version = Annotated[int, Field(strict=True, ge=1, le=MAX_SAFE_INTEGER)]


def entered(limit: int, message: str) -> AfterValidator:
    """Trimmed, not blank, and at most `limit` characters once trimmed."""

    def check(value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise PydanticCustomError("required", message)
        if len(trimmed) > limit:
            raise PydanticCustomError("too_long", f"Use at most {limit} characters.")
        return trimmed

    return AfterValidator(check)


class Update(BaseModel):
    """An edit: the version the editor saw, plus only the fields being changed."""

    model_config = ConfigDict(extra="forbid")
    nullable: ClassVar[frozenset[str]] = frozenset()

    expected_version: Version

    def changes(self) -> dict[str, Any]:
        """The fields that were sent. Leaving a field out keeps it; sending null does not."""
        sent = self.model_dump(exclude_unset=True, exclude={"expected_version"})
        empty = [
            name for name, value in sent.items() if value is None and name not in self.nullable
        ]
        if empty:
            raise invalid(
                *(
                    FieldError(pointer(name), "required", "Give a value or leave this out.")
                    for name in empty
                )
            )
        return sent
