import json
from datetime import timedelta
from typing import Any

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import App, Staff, guard_mutation
from app.config import Settings
from app.main import create_app
from app.persistence.models import StaffUser
from app.services import business_settings
from app.services.sessions import SESSION_COOKIE
from app.values import format_instant
from tests.support import API, ORIGIN, Cli, FakeClock, csrf, error_of, set_cookie, sign_in

FIRST = [
    "settings",
    "set",
    "--currency=USD",
    "--minor-digits=2",
    "--timezone=America/Los_Angeles",
    "--fulfillment=pickup,delivery",
]
GROUPS = ["currency", "timezone", "fulfillment", "delivery", "tax"]
CAPABILITIES = [
    "orders",
    "menu",
    "payments",
    "inventory",
    "purchases",
    "recipes",
    "planning",
    "preparation_recording",
]


@pytest.fixture
def staff(client: TestClient, admin: StaffUser) -> TestClient:
    sign_in(client)
    return client


def settings(client: TestClient) -> dict[str, Any]:
    response = client.get(f"{API}/settings")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


# --- Reading ---------------------------------------------------------------------------------


@pytest.mark.parametrize("pre_auth", [False, True])
def test_settings_need_a_signed_in_session(client: TestClient, cli: Cli, pre_auth: bool) -> None:
    cli(*FIRST)
    if pre_auth:
        csrf(client)

    error_of(client.get(f"{API}/settings"), 401, "unauthenticated")


def test_settings_are_unavailable_until_the_operator_sets_them(staff: TestClient) -> None:
    error = error_of(staff.get(f"{API}/settings"), 503, "temporarily_unavailable")

    assert "settings" in error["message"]
    assert error["field_errors"] == []


def test_settings_have_the_contract_shape(staff: TestClient, cli: Cli) -> None:
    assert cli(*FIRST, "--delivery-mode=manual_amount", "--payment-methods=other,cash") == 0

    assert settings(staff) == {
        "version": 1,
        "environment": "development",
        "confirmation": {
            "currency": False,
            "timezone": False,
            "fulfillment": False,
            "delivery": False,
            "tax": False,
            "confirmed_at": None,
        },
        "currency": "USD",
        "minor_digits": 2,
        "timezone": "America/Los_Angeles",
        "fulfillment_methods": ["pickup", "delivery"],
        "pickup_location": None,
        "delivery_policy": {"mode": "manual_amount", "fixed_charge_minor": None},
        "tax_policy": {"mode": "manual_amount", "inclusive": False},
        "payment_methods": ["cash", "other"],
        "capabilities": dict.fromkeys(CAPABILITIES, False),
    }


def test_the_first_settings_start_closed(staff: TestClient, cli: Cli) -> None:
    cli(*FIRST)

    body = settings(staff)
    # Nothing the operator did not choose is switched on: no delivery, payments or workflows.
    assert body["delivery_policy"] == {"mode": "disabled", "fixed_charge_minor": None}
    assert body["payment_methods"] == []
    assert body["environment"] == "development"
    assert not any(body["capabilities"].values())
    assert not any(body["confirmation"][group] for group in GROUPS)


def test_reading_settings_counts_as_activity(staff: TestClient, cli: Cli, clock: FakeClock) -> None:
    cli(*FIRST)
    clock.advance(minutes=12)

    settings(staff)

    session = staff.get(f"{API}/auth/session").json()
    assert session["idle_expires_at"] == format_instant(clock.now + timedelta(minutes=30))


def test_settings_take_no_query_parameters(staff: TestClient, cli: Cli) -> None:
    cli(*FIRST)

    error = error_of(staff.get(f"{API}/settings?fields=currency"), 422, "validation_failed")
    assert [field["path"] for field in error["field_errors"]] == ["/query/fields"]


def test_the_operator_can_print_the_settings(
    staff: TestClient, cli: Cli, capsys: pytest.CaptureFixture[str]
) -> None:
    assert cli("settings", "show") == 1
    assert "settings set" in capsys.readouterr().err
    cli(*FIRST)
    capsys.readouterr()

    assert cli("settings", "show") == 0

    assert json.loads(capsys.readouterr().out) == settings(staff)


# --- Changing --------------------------------------------------------------------------------


@pytest.mark.parametrize("missing", range(2, len(FIRST)))
def test_the_first_settings_need_currency_digits_timezone_and_fulfillment(
    staff: TestClient, cli: Cli, capsys: pytest.CaptureFixture[str], missing: int
) -> None:
    arguments = FIRST[:missing] + FIRST[missing + 1 :]

    assert cli(*arguments) == 1

    assert FIRST[missing].split("=")[0] in capsys.readouterr().err
    error_of(staff.get(f"{API}/settings"), 503, "temporarily_unavailable")


def test_each_change_raises_the_version_by_exactly_one(
    staff: TestClient, cli: Cli, capsys: pytest.CaptureFixture[str]
) -> None:
    cli(*FIRST)
    assert settings(staff)["version"] == 1

    assert cli("settings", "set", "--timezone=Asia/Manila") == 0
    assert (settings(staff)["version"], settings(staff)["timezone"]) == (2, "Asia/Manila")

    capsys.readouterr()
    assert cli("settings", "set", "--timezone=Asia/Manila", "--currency=USD") == 0
    assert "No change" in capsys.readouterr().out
    assert settings(staff)["version"] == 2

    assert cli("settings", "set", "--currency=PHP", "--payment-methods=cash") == 0
    body = settings(staff)
    assert (body["version"], body["currency"], body["payment_methods"]) == (3, "PHP", ["cash"])


@pytest.mark.parametrize(
    "arguments",
    [
        ["--currency=usd"],
        ["--currency=US"],
        ["--currency=DOLLAR"],
        ["--minor-digits=-1"],
        ["--minor-digits=5"],
        ["--minor-digits=two"],
        ["--timezone=Mars/Olympus_Mons"],
        ["--timezone="],
        ["--fulfillment=pickup,courier"],
        ["--fulfillment="],
        ["--fulfillment=pickup,pickup"],
        ["--payment-methods=cash,card"],
        ["--payment-methods="],
        ["--pickup-location=   "],
        ["--delivery-mode=free"],
        ["--delivery-mode=fixed_amount"],
        ["--fixed-charge-minor=500"],
        ["--delivery-mode=fixed_amount", "--fixed-charge-minor=-1"],
        ["--delivery-mode=fixed_amount", "--fixed-charge-minor=9007199254740992"],
        ["--environment=production"],
        ["--tax-mode=rate"],
        ["--enable=loyalty"],
        ["--pickup-location=Stall 4", "--no-pickup-location"],
    ],
)
def test_a_value_that_makes_no_sense_changes_nothing(
    staff: TestClient, cli: Cli, arguments: list[str]
) -> None:
    cli(*FIRST)

    assert cli("settings", "set", "--currency=PHP", *arguments) != 0

    body = settings(staff)
    assert (body["version"], body["currency"]) == (1, "USD")


def test_a_fixed_delivery_charge_lives_and_dies_with_its_mode(staff: TestClient, cli: Cli) -> None:
    cli(*FIRST)

    assert cli("settings", "set", "--delivery-mode=fixed_amount", "--fixed-charge-minor=5000") == 0
    assert settings(staff)["delivery_policy"] == {
        "mode": "fixed_amount",
        "fixed_charge_minor": 5000,
    }

    assert cli("settings", "set", "--fixed-charge-minor=0") == 0
    assert settings(staff)["delivery_policy"] == {"mode": "fixed_amount", "fixed_charge_minor": 0}

    assert cli("settings", "set", "--delivery-mode=manual_amount") == 0
    assert settings(staff)["delivery_policy"] == {
        "mode": "manual_amount",
        "fixed_charge_minor": None,
    }


def test_the_pickup_location_can_be_set_and_cleared(staff: TestClient, cli: Cli) -> None:
    cli(*FIRST)

    assert cli("settings", "set", "--pickup-location=  Stall 4, Public Market ") == 0
    assert settings(staff)["pickup_location"] == "Stall 4, Public Market"

    assert cli("settings", "set", "--no-pickup-location") == 0
    assert settings(staff)["pickup_location"] is None


def test_the_environment_is_the_operators_choice(staff: TestClient, cli: Cli) -> None:
    cli(*FIRST)

    assert cli("settings", "set", "--environment=live") == 0

    assert settings(staff)["environment"] == "live"


# --- Confirmation ----------------------------------------------------------------------------


def test_the_operator_confirms_groups_and_the_time_is_recorded(
    staff: TestClient, cli: Cli, clock: FakeClock
) -> None:
    cli(*FIRST)
    clock.advance(minutes=10)

    assert cli("settings", "confirm", "currency", "timezone") == 0

    body = settings(staff)
    assert body["confirmation"] == {
        "currency": True,
        "timezone": True,
        "fulfillment": False,
        "delivery": False,
        "tax": False,
        "confirmed_at": format_instant(clock.now),
    }
    assert body["version"] == 2


def test_everything_can_be_confirmed_at_once_and_repeating_changes_nothing(
    staff: TestClient, cli: Cli, clock: FakeClock
) -> None:
    cli(*FIRST)
    assert cli("settings", "confirm", "--all") == 0
    confirmed = settings(staff)
    clock.advance(minutes=10)

    assert cli("settings", "confirm", "--all") == 0
    assert cli("settings", "confirm", "tax") == 0

    assert all(confirmed["confirmation"][group] for group in GROUPS)
    assert settings(staff) == confirmed


@pytest.mark.parametrize("arguments", [[], ["prices"], ["--all", "tax"]])
def test_confirm_needs_known_groups(staff: TestClient, cli: Cli, arguments: list[str]) -> None:
    cli(*FIRST)

    assert cli("settings", "confirm", *arguments) != 0
    assert settings(staff)["version"] == 1


def test_confirming_needs_settings_to_confirm(cli: Cli) -> None:
    assert cli("settings", "confirm", "--all") == 1


@pytest.mark.parametrize(
    ("change", "withdrawn"),
    [
        ("--currency=PHP", "currency"),
        ("--minor-digits=0", "currency"),
        ("--timezone=Asia/Manila", "timezone"),
        ("--fulfillment=pickup", "fulfillment"),
        ("--pickup-location=Stall 4", "fulfillment"),
        ("--delivery-mode=manual_amount", "delivery"),
    ],
)
def test_changing_a_confirmed_value_withdraws_only_its_confirmation(
    staff: TestClient, cli: Cli, change: str, withdrawn: str
) -> None:
    cli(*FIRST)
    cli("settings", "confirm", "--all")
    confirmed_at = settings(staff)["confirmation"]["confirmed_at"]

    assert cli("settings", "set", change) == 0

    confirmation = settings(staff)["confirmation"]
    assert [group for group in GROUPS if not confirmation[group]] == [withdrawn]
    assert confirmation["confirmed_at"] == confirmed_at


def test_changes_elsewhere_leave_confirmations_alone(staff: TestClient, cli: Cli) -> None:
    cli(*FIRST)
    cli("settings", "confirm", "--all")

    cli("settings", "set", "--payment-methods=cash", "--environment=live")

    assert all(settings(staff)["confirmation"][group] for group in GROUPS)


def test_with_nothing_left_confirmed_there_is_no_confirmation_time(
    staff: TestClient, cli: Cli
) -> None:
    cli(*FIRST)
    cli("settings", "confirm", "timezone")

    cli("settings", "set", "--timezone=Asia/Manila")

    assert settings(staff)["confirmation"]["confirmed_at"] is None


# --- Capabilities ----------------------------------------------------------------------------


def test_a_workflow_that_is_not_released_cannot_be_switched_on(
    staff: TestClient, cli: Cli, capsys: pytest.CaptureFixture[str]
) -> None:
    cli(*FIRST)

    unreleased = [name for name in CAPABILITIES if name not in business_settings.RELEASED]
    for capability in unreleased:
        assert cli("settings", "set", f"--enable={capability}") == 1
        assert capability in capsys.readouterr().err

    body = settings(staff)
    assert body["capabilities"] == dict.fromkeys(CAPABILITIES, False)
    assert body["version"] == 1
    # Everything from orders onward is still to come.
    assert len(unreleased) >= 7


def test_a_released_workflow_is_switched_on_and_off_by_the_operator(
    staff: TestClient, cli: Cli, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(business_settings, "RELEASED", frozenset({"planning", "orders"}))
    cli(*FIRST)

    assert cli("settings", "set", "--enable=planning") == 0
    assert settings(staff)["capabilities"] == {
        **dict.fromkeys(CAPABILITIES, False),
        "planning": True,
    }
    assert settings(staff)["version"] == 2

    assert cli("settings", "set", "--enable=orders", "--disable=planning") == 0
    assert settings(staff)["capabilities"] == {**dict.fromkeys(CAPABILITIES, False), "orders": True}
    assert cli("settings", "set", "--enable=orders", "--disable=orders") != 0


def test_a_workflow_this_version_does_not_have_is_never_reported_as_on(
    staff: TestClient, cli: Cli, monkeypatch: pytest.MonkeyPatch
) -> None:
    cli(*FIRST)
    with monkeypatch.context() as newer:
        newer.setattr(business_settings, "RELEASED", frozenset({"planning"}))
        cli("settings", "set", "--enable=planning")
        assert settings(staff)["capabilities"]["planning"] is True

    # The same database under code that has no planning workflow.
    assert settings(staff)["capabilities"]["planning"] is False


# --- Failing closed --------------------------------------------------------------------------


@pytest.fixture
def reservations(app: FastAPI) -> None:
    """A stand-in for the first reservation mutation, which arrives with orders."""
    probe = APIRouter(prefix=API, dependencies=[Depends(guard_mutation)])

    @probe.post("/probe/reservations")
    def reserve(staff: Staff, app: App) -> dict[str, bool]:
        with app.database.read() as db:
            business_settings.require_confirmed(
                business_settings.require(db), "currency", "timezone", "fulfillment"
            )
        return {"reserved": True}

    app.include_router(probe)


def reserve(client: TestClient) -> Any:
    return client.post(f"{API}/probe/reservations", headers={"X-CSRF-Token": csrf(client)})


@pytest.mark.usefixtures("reservations")
def test_development_settings_may_be_used_unconfirmed(staff: TestClient, cli: Cli) -> None:
    cli(*FIRST)

    assert reserve(staff).json() == {"reserved": True}


@pytest.mark.usefixtures("reservations")
def test_live_settings_fail_closed_until_the_relevant_groups_are_confirmed(
    staff: TestClient, cli: Cli
) -> None:
    cli(*FIRST, "--environment=live")
    cli("settings", "confirm", "timezone", "tax", "delivery")

    error = error_of(reserve(staff), 409, "settings_unconfirmed")
    assert error["details"] == {"unconfirmed": ["currency", "fulfillment"]}

    cli("settings", "confirm", "currency", "fulfillment")
    assert reserve(staff).json() == {"reserved": True}

    # A later change to a confirmed value closes the door again.
    cli("settings", "set", "--currency=PHP")
    assert error_of(reserve(staff), 409, "settings_unconfirmed")["details"] == {
        "unconfirmed": ["currency"]
    }


@pytest.mark.usefixtures("reservations")
def test_without_settings_a_reservation_is_refused(staff: TestClient) -> None:
    error_of(reserve(staff), 503, "temporarily_unavailable")


def test_live_settings_never_send_the_session_cookie_over_plain_http(
    config: Settings, clock: FakeClock, cli: Cli, admin: StaffUser
) -> None:
    development = config.model_copy(update={"cookie_secure": False})
    cli(*FIRST)

    with TestClient(
        create_app(development, clock=clock), base_url=ORIGIN, headers={"Origin": ORIGIN}
    ) as client:
        assert "secure" not in set_cookie(client.get(f"{API}/auth/csrf"), SESSION_COOKIE)
        cli("settings", "set", "--environment=live")
        client.cookies.clear()

        assert "secure" in set_cookie(client.get(f"{API}/auth/csrf"), SESSION_COOKIE)
        signed_in = sign_in(client)
        assert "secure" in set_cookie(signed_in, SESSION_COOKIE)
        signed_out = client.post(
            f"{API}/auth/sign-out",
            json={},
            headers={"X-CSRF-Token": signed_in.json()["csrf_token"]},
        )
        assert "secure" in set_cookie(signed_out, SESSION_COOKIE)
