from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field
from pydantic_core import PydanticCustomError

from app.values import Instant


def _entered(message: str) -> AfterValidator:
    def check(value: str) -> str:
        if not value.strip():
            raise PydanticCustomError("required", message)
        return value

    return AfterValidator(check)


class Credentials(BaseModel):
    """The interim sign-in: a username and a token, each taken exactly as entered."""

    model_config = ConfigDict(extra="forbid")

    username: Annotated[str, Field(strict=True, max_length=200), _entered("Enter your username.")]
    token: Annotated[str, Field(strict=True, max_length=1024), _entered("Enter your token.")]


class Empty(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CsrfOut(BaseModel):
    csrf_token: str


class UserOut(BaseModel):
    id: str
    username: str
    display_name: str
    role: Literal["staff"]


class SessionOut(BaseModel):
    user: UserOut
    csrf_token: str
    idle_expires_at: Instant
    absolute_expires_at: Instant
