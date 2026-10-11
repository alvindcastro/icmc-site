import pytest
from pydantic import ValidationError

from app.actions import PermittedAction, allowed, blocked


def test_an_allowed_action_has_no_reason() -> None:
    assert allowed().model_dump() == {"allowed": True, "reason_code": None, "reason": None}


def test_a_blocked_action_says_why() -> None:
    action = blocked("order_cancelled", "A cancelled order cannot be edited.")

    assert action.model_dump() == {
        "allowed": False,
        "reason_code": "order_cancelled",
        "reason": "A cancelled order cannot be edited.",
    }


@pytest.mark.parametrize(("code", "reason"), [("", "Why"), ("code", ""), (" ", "Why"), ("c", " ")])
def test_a_blocked_action_cannot_be_built_without_a_code_and_a_reason(
    code: str, reason: str
) -> None:
    with pytest.raises(ValueError):
        blocked(code, reason)


def test_the_shape_itself_refuses_inconsistent_actions() -> None:
    with pytest.raises(ValidationError):
        PermittedAction(allowed=False, reason_code=None, reason=None)
    with pytest.raises(ValidationError):
        PermittedAction(allowed=True, reason_code="order_cancelled", reason="Cancelled.")
