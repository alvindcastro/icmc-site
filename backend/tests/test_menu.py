import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app.persistence.database import Database
from app.persistence.models import AuditEvent, StaffUser, Variant
from app.values import MAX_SAFE_INTEGER
from tests.support import API, Cli, error_of, sign_in

SETTINGS = [
    "settings",
    "set",
    "--currency=USD",
    "--minor-digits=2",
    "--timezone=America/Los_Angeles",
    "--fulfillment=pickup,delivery",
]
ALLOWED = {"allowed": True, "reason_code": None, "reason": None}
TRAY = {
    "label": "Medium",
    "selling_unit": "tray",
    "price_minor": 8000,
    "available": True,
    "package_contents": None,
}


@pytest.fixture
def staff(client: TestClient, admin: StaffUser, cli: Cli) -> TestClient:
    """Signed-in staff on a server whose operator set it up and switched the menu on."""
    cli(*SETTINGS, "--enable=menu")
    for name in ["Pork", "beef", "Fish, Lumpia & More"]:
        assert cli("category", "add", name) == 0
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
    return client


def save(client: TestClient, method: str, path: str, body: Any, key: str | None = None) -> Any:
    return client.request(
        method, f"{API}{path}", json=body, headers={"Idempotency-Key": key or str(uuid.uuid4())}
    )


def category(client: TestClient, name: str) -> str:
    items = client.get(f"{API}/categories").json()["items"]
    identifier: str = next(item["id"] for item in items if item["name"] == name)
    return identifier


def new_food(client: TestClient, name: str = "Beef Caldereta", **changes: Any) -> dict[str, Any]:
    body = {"name": name, "category_id": category(client, "beef"), "available": True, **changes}
    response = save(client, "POST", "/foods", body)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


def new_variant(client: TestClient, food_id: str, **changes: Any) -> dict[str, Any]:
    response = save(client, "POST", f"/foods/{food_id}/variants", {**TRAY, **changes})
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


def read_food(client: TestClient, food_id: str) -> dict[str, Any]:
    response = client.get(f"{API}/foods/{food_id}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def names(client: TestClient, query: str = "") -> list[str]:
    response = client.get(f"{API}/foods{query}")
    assert response.status_code == 200, response.text
    return [item["name"] for item in response.json()["items"]]


def paths(response: Any) -> set[str]:
    return {field["path"] for field in error_of(response, 422, "validation_failed")["field_errors"]}


# --- Who may use the menu --------------------------------------------------------------------


def test_the_menu_needs_a_signed_in_session(client: TestClient, cli: Cli) -> None:
    cli(*SETTINGS, "--enable=menu")

    for path in ["/categories", "/foods", "/foods/food_1"]:
        error_of(client.get(f"{API}{path}"), 401, "unauthenticated")


def test_the_menu_is_forbidden_until_the_operator_enables_it(
    client: TestClient, admin: StaffUser, cli: Cli
) -> None:
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]
    error_of(client.get(f"{API}/foods"), 503, "temporarily_unavailable")
    cli(*SETTINGS)

    for path in ["/categories", "/foods", "/foods/food_1"]:
        error = error_of(client.get(f"{API}{path}"), 403, "action_forbidden")
        assert error["message"].strip()
    refused = save(client, "POST", "/foods", {"name": "Adobo", "available": True})
    error_of(refused, 403, "action_forbidden")

    cli("settings", "set", "--enable=menu")
    assert client.get(f"{API}/foods").status_code == 200


# --- Categories ------------------------------------------------------------------------------


def test_categories_are_listed_by_name_whatever_their_letter_case(staff: TestClient) -> None:
    body = staff.get(f"{API}/categories").json()

    assert [item["name"] for item in body["items"]] == ["beef", "Fish, Lumpia & More", "Pork"]
    assert all(set(item) == {"id", "name"} and item["id"] for item in body["items"])
    assert (body["page"], body["limit"], body["total"], body["has_next"]) == (1, 25, 3, False)
    paged = staff.get(f"{API}/categories?limit=2&page=2").json()
    assert ([item["name"] for item in paged["items"]], paged["has_next"]) == (["Pork"], False)
    assert paths(staff.get(f"{API}/categories?q=beef")) == {"/query/q"}


@pytest.mark.parametrize("name", ["BEEF", " Pork ", "", "   ", "x" * 201])
def test_the_operator_cannot_add_a_blank_overlong_or_repeated_category(
    staff: TestClient, cli: Cli, name: str
) -> None:
    assert cli("category", "add", name) == 1
    assert staff.get(f"{API}/categories").json()["total"] == 3


def test_the_operator_lists_categories_with_their_ids(
    staff: TestClient, cli: Cli, capsys: pytest.CaptureFixture[str]
) -> None:
    capsys.readouterr()

    assert cli("category", "list") == 0

    listed = capsys.readouterr().out
    assert category(staff, "Pork") in listed
    assert "Fish, Lumpia & More" in listed


# --- Creating a food -------------------------------------------------------------------------


def test_a_new_food_is_provisional_at_version_one_with_no_variants(staff: TestClient) -> None:
    key = str(uuid.uuid4())
    body = {"name": "  Beef Caldereta ", "category_id": category(staff, "beef"), "available": True}

    response = save(staff, "POST", "/foods", body, key)

    assert response.status_code == 201
    food = response.json()
    assert food == {
        "id": food["id"],
        "version": 1,
        "name": "Beef Caldereta",
        "category_id": body["category_id"],
        "description": "",
        "available": True,
        "confirmation_status": "provisional",
        "variants": [],
        "permitted_actions": {"edit": ALLOWED, "add_variant": ALLOWED},
    }
    assert food["id"].startswith("food_")
    assert read_food(staff, food["id"]) == food
    operation = staff.get(f"{API}/operations/{key}").json()
    assert (operation["state"], operation["resource_type"], operation["resource_id"]) == (
        "succeeded",
        "food",
        food["id"],
    )
    assert operation["result"] == {"http_status": 201, "body": food}


@pytest.mark.parametrize(
    ("changes", "path"),
    [
        ({"name": ""}, "/name"),
        ({"name": "   "}, "/name"),
        ({"name": "x" * 201}, "/name"),
        ({"name": 7}, "/name"),
        ({"name": None}, "/name"),
        ({"category_id": "cat_nowhere"}, "/category_id"),
        ({"category_id": None}, "/category_id"),
        ({"available": "yes"}, "/available"),
        ({"available": 1}, "/available"),
        ({"available": None}, "/available"),
        ({"description": "x" * 2001}, "/description"),
        ({"description": None}, "/description"),
        ({"confirmation_status": "confirmed"}, "/confirmation_status"),
        ({"version": 4}, "/version"),
    ],
)
def test_an_invalid_food_is_refused_at_the_field(
    staff: TestClient, changes: dict[str, Any], path: str
) -> None:
    body = {"name": "Adobo", "category_id": category(staff, "beef"), "available": True, **changes}

    assert paths(save(staff, "POST", "/foods", body)) == {path}
    assert names(staff) == []


def test_every_missing_field_of_a_new_food_is_named(staff: TestClient) -> None:
    assert paths(save(staff, "POST", "/foods", {})) == {"/name", "/category_id", "/available"}


def test_names_and_descriptions_may_be_as_long_as_the_contract_allows(staff: TestClient) -> None:
    food = new_food(staff, name=" " + "x" * 200 + " ", description="d" * 2000)

    assert (len(food["name"]), len(food["description"])) == (200, 2000)


def test_a_food_is_not_created_without_an_operation_key(staff: TestClient) -> None:
    body = {"name": "Adobo", "category_id": category(staff, "beef"), "available": True}

    assert paths(staff.post(f"{API}/foods", json=body)) == {"/header/Idempotency-Key"}
    assert names(staff) == []


# --- Editing a food --------------------------------------------------------------------------


def test_an_edit_changes_what_was_sent_and_raises_the_version_by_one(staff: TestClient) -> None:
    food = new_food(staff, description="Slow-cooked")

    response = save(
        staff, "PATCH", f"/foods/{food['id']}", {"expected_version": 1, "available": False}
    )

    assert response.status_code == 200
    assert response.json() == {**food, "version": 2, "available": False}
    cleared = save(
        staff,
        "PATCH",
        f"/foods/{food['id']}",
        {"expected_version": 2, "description": "", "name": " Kaldereta "},
    )
    assert cleared.json() == {
        **food,
        "version": 3,
        "available": False,
        "description": "",
        "name": "Kaldereta",
    }
    assert read_food(staff, food["id"]) == cleared.json()


def test_an_edit_that_changes_nothing_still_counts_as_a_save(staff: TestClient) -> None:
    food = new_food(staff)

    response = save(staff, "PATCH", f"/foods/{food['id']}", {"expected_version": 1})

    assert response.json() == {**food, "version": 2}


@pytest.mark.parametrize(
    ("body", "path"),
    [
        ({"available": False}, "/expected_version"),
        ({"expected_version": None, "available": False}, "/expected_version"),
        ({"expected_version": 0}, "/expected_version"),
        ({"expected_version": "1"}, "/expected_version"),
        ({"expected_version": 1.0}, "/expected_version"),
        ({"expected_version": 1, "name": None}, "/name"),
        ({"expected_version": 1, "name": " "}, "/name"),
        ({"expected_version": 1, "available": None}, "/available"),
        ({"expected_version": 1, "category_id": "cat_nowhere"}, "/category_id"),
        ({"expected_version": 1, "variants": []}, "/variants"),
        ({"expected_version": 9, "name": ""}, "/name"),
    ],
)
def test_an_invalid_edit_is_refused_at_the_field_before_versions_are_compared(
    staff: TestClient, body: dict[str, Any], path: str
) -> None:
    food = new_food(staff)

    assert paths(save(staff, "PATCH", f"/foods/{food['id']}", body)) == {path}
    assert read_food(staff, food["id"]) == food


def test_a_stale_edit_gets_the_latest_food_and_changes_nothing(staff: TestClient) -> None:
    food = new_food(staff)
    variant = new_variant(staff, food["id"])
    current = read_food(staff, food["id"])
    assert current["version"] == 2

    stale = save(staff, "PATCH", f"/foods/{food['id']}", {"expected_version": 1, "name": "Mine"})

    error = error_of(stale, 409, "version_conflict")
    assert error["details"] == {
        "resource_type": "food",
        "resource_id": food["id"],
        "expected_version": 1,
        "current_version": 2,
        "latest_resource": current,
    }
    assert current["variants"] == [variant]
    assert read_food(staff, food["id"]) == current


def test_a_replay_returns_the_original_answer_even_after_later_edits(staff: TestClient) -> None:
    food = new_food(staff)
    key = str(uuid.uuid4())
    edit = {"expected_version": 1, "name": "First edit"}
    first = save(staff, "PATCH", f"/foods/{food['id']}", edit, key)
    save(staff, "PATCH", f"/foods/{food['id']}", {"expected_version": 2, "name": "Second edit"})

    replay = save(staff, "PATCH", f"/foods/{food['id']}", edit, key)

    assert (replay.status_code, replay.content) == (200, first.content)
    assert replay.headers["Idempotency-Replayed"] == "true"
    assert replay.json()["version"] == 2
    assert (read_food(staff, food["id"])["version"], names(staff)) == (3, ["Second edit"])


def test_an_edit_of_an_unknown_food_is_not_found_and_remembered(staff: TestClient) -> None:
    key = str(uuid.uuid4())

    missing = save(staff, "PATCH", "/foods/food_nowhere", {"expected_version": 1}, key)

    error_of(missing, 404, "not_found")
    error_of(staff.get(f"{API}/foods/food_nowhere"), 404, "not_found")
    assert staff.get(f"{API}/operations/{key}").json()["state"] == "rejected"


# --- Variants --------------------------------------------------------------------------------


def test_variants_of_every_selling_unit_join_the_food_in_the_order_added(
    staff: TestClient,
) -> None:
    food = new_food(staff)
    added = [
        new_variant(staff, food["id"], label=" Medium "),
        new_variant(staff, food["id"], label="Each", selling_unit="piece", price_minor=300),
        new_variant(staff, food["id"], label="Each stick", selling_unit="stick", price_minor=150),
        new_variant(
            staff,
            food["id"],
            label="100 pieces",
            selling_unit="package",
            price_minor=5500,
            package_contents={"quantity": 100, "unit": "piece"},
        ),
    ]

    assert added[0] == {
        "id": added[0]["id"],
        "version": 1,
        "food_id": food["id"],
        "label": "Medium",
        "selling_unit": "tray",
        "price_minor": 8000,
        "available": True,
        "confirmation_status": "provisional",
        "package_contents": None,
        "recipe_id": None,
        "permitted_actions": {"edit": ALLOWED},
    }
    assert added[0]["id"].startswith("var_")
    assert added[3]["package_contents"] == {"quantity": 100, "unit": "piece"}
    current = read_food(staff, food["id"])
    assert current["variants"] == added
    # One step for each variant added: the food is the aggregate staff edit against.
    assert current["version"] == 5


@pytest.mark.parametrize(
    ("changes", "path"),
    [
        ({"selling_unit": "package"}, "/package_contents/quantity"),
        (
            {"selling_unit": "package", "package_contents": {"quantity": 0, "unit": "piece"}},
            "/package_contents/quantity",
        ),
        (
            {"selling_unit": "package", "package_contents": {"quantity": 1.5, "unit": "piece"}},
            "/package_contents/quantity",
        ),
        (
            {"selling_unit": "package", "package_contents": {"quantity": 10, "unit": "tray"}},
            "/package_contents/unit",
        ),
        (
            {"selling_unit": "package", "package_contents": {"quantity": 10}},
            "/package_contents/unit",
        ),
        ({"package_contents": {"quantity": 10, "unit": "piece"}}, "/package_contents"),
        ({"selling_unit": "box"}, "/selling_unit"),
        ({"selling_unit": None}, "/selling_unit"),
        ({"label": " "}, "/label"),
        ({"label": "x" * 201}, "/label"),
        ({"price_minor": -1}, "/price_minor"),
        ({"price_minor": 80.5}, "/price_minor"),
        ({"price_minor": "8000"}, "/price_minor"),
        ({"price_minor": None}, "/price_minor"),
        ({"price_minor": MAX_SAFE_INTEGER + 1}, "/price_minor"),
        ({"available": "true"}, "/available"),
        ({"recipe_id": "rec_1"}, "/recipe_id"),
    ],
)
def test_an_invalid_variant_is_refused_at_the_field(
    staff: TestClient, changes: dict[str, Any], path: str
) -> None:
    food = new_food(staff)

    refused = save(staff, "POST", f"/foods/{food['id']}/variants", {**TRAY, **changes})

    assert paths(refused) == {path}
    assert read_food(staff, food["id"]) == food


def test_every_field_of_a_new_variant_is_required(staff: TestClient) -> None:
    food = new_food(staff)

    assert paths(save(staff, "POST", f"/foods/{food['id']}/variants", {})) == {
        "/label",
        "/selling_unit",
        "/price_minor",
        "/available",
        "/package_contents",
    }


@pytest.mark.parametrize("price", [0, MAX_SAFE_INTEGER])
def test_a_price_may_be_an_explicit_zero_or_the_largest_safe_amount(
    staff: TestClient, price: int
) -> None:
    food = new_food(staff)

    assert new_variant(staff, food["id"], price_minor=price)["price_minor"] == price


def test_editing_a_variant_advances_it_and_its_food_together(staff: TestClient) -> None:
    food = new_food(staff)
    variant = new_variant(staff, food["id"])

    response = save(
        staff,
        "PATCH",
        f"/variants/{variant['id']}",
        {"expected_version": 1, "price_minor": 8500, "available": False},
    )

    assert response.status_code == 200
    assert response.json() == {**variant, "version": 2, "price_minor": 8500, "available": False}
    current = read_food(staff, food["id"])
    assert (current["version"], current["variants"]) == (3, [response.json()])


def test_a_variant_can_become_a_package_and_stop_being_one(staff: TestClient) -> None:
    food = new_food(staff)
    variant = new_variant(staff, food["id"])
    path = f"/variants/{variant['id']}"

    packaged = save(
        staff,
        "PATCH",
        path,
        {
            "expected_version": 1,
            "selling_unit": "package",
            "package_contents": {"quantity": 12, "unit": "piece"},
        },
    )
    assert packaged.json()["package_contents"] == {"quantity": 12, "unit": "piece"}
    # Changing only the unit leaves the old contents behind, which a tray cannot have.
    assert paths(save(staff, "PATCH", path, {"expected_version": 2, "selling_unit": "tray"})) == {
        "/package_contents"
    }
    loose = save(
        staff,
        "PATCH",
        path,
        {"expected_version": 2, "selling_unit": "tray", "package_contents": None},
    )
    assert (loose.json()["selling_unit"], loose.json()["package_contents"]) == ("tray", None)


def test_a_stale_variant_edit_gets_the_latest_variant_and_changes_nothing(
    staff: TestClient,
) -> None:
    food = new_food(staff)
    variant = new_variant(staff, food["id"])
    save(staff, "PATCH", f"/variants/{variant['id']}", {"expected_version": 1, "price_minor": 1})
    current = read_food(staff, food["id"])

    stale = save(
        staff, "PATCH", f"/variants/{variant['id']}", {"expected_version": 1, "price_minor": 2}
    )

    error = error_of(stale, 409, "version_conflict")
    assert error["details"] == {
        "resource_type": "variant",
        "resource_id": variant["id"],
        "expected_version": 1,
        "current_version": 2,
        "latest_resource": current["variants"][0],
    }
    assert read_food(staff, food["id"]) == current


def test_variants_of_unknown_records_are_not_found(staff: TestClient) -> None:
    error_of(save(staff, "POST", "/foods/food_nowhere/variants", TRAY), 404, "not_found")
    error_of(
        save(staff, "PATCH", "/variants/var_nowhere", {"expected_version": 1}), 404, "not_found"
    )


def test_once_ordered_a_variant_keeps_its_unit_and_package_but_not_its_price(
    staff: TestClient, database: Database
) -> None:
    food = new_food(staff)
    tray = new_variant(staff, food["id"])
    package = new_variant(
        staff,
        food["id"],
        label="Dozen",
        selling_unit="package",
        package_contents={"quantity": 12, "unit": "piece"},
    )
    with database.write() as db:
        db.execute(update(Variant).values(used_on_order=True))

    unit = save(
        staff,
        "PATCH",
        f"/variants/{tray['id']}",
        {
            "expected_version": 1,
            "selling_unit": "package",
            "package_contents": {"quantity": 6, "unit": "piece"},
        },
    )
    contents = save(
        staff,
        "PATCH",
        f"/variants/{package['id']}",
        {"expected_version": 1, "package_contents": {"quantity": 10, "unit": "piece"}},
    )
    price = save(
        staff,
        "PATCH",
        f"/variants/{tray['id']}",
        {**TRAY, "expected_version": 1, "price_minor": 9000, "label": "Regular"},
    )

    assert paths(unit) == {"/selling_unit"}
    assert paths(contents) == {"/package_contents/quantity"}
    assert (price.status_code, price.json()["price_minor"], price.json()["label"]) == (
        200,
        9000,
        "Regular",
    )


# --- Finding foods ---------------------------------------------------------------------------


@pytest.fixture
def larder(staff: TestClient) -> TestClient:
    pork, beef = category(staff, "Pork"), category(staff, "beef")
    for name, category_id, available in [
        ("pork BBQ", pork, True),
        ("Beef Caldereta", beef, True),
        ("adobo", pork, False),
        ("Beef 100% Tapa", beef, True),
        ("Zesty_beef salad", beef, False),
        ("Adobo", beef, True),
    ]:
        new_food(staff, name=name, category_id=category_id, available=available)
    return staff


def test_foods_are_listed_by_name_without_regard_to_letter_case(larder: TestClient) -> None:
    body = larder.get(f"{API}/foods").json()

    listed = [item["name"] for item in body["items"]]
    assert listed[2:] == ["Beef 100% Tapa", "Beef Caldereta", "pork BBQ", "Zesty_beef salad"]
    # The two that differ only by case are told apart by ID, the same way every time.
    assert sorted(listed[:2]) == ["Adobo", "adobo"]
    assert [item["name"] for item in larder.get(f"{API}/foods").json()["items"]] == listed
    assert (body["total"], body["has_next"]) == (6, False)


def test_foods_page_without_repeating_or_dropping_any(larder: TestClient) -> None:
    seen: list[str] = []
    for page in range(1, 5):
        body = larder.get(f"{API}/foods?limit=2&page={page}").json()
        assert (body["total"], body["has_next"]) == (6, page < 3)
        seen += [item["id"] for item in body["items"]]

    assert len(seen) == len(set(seen)) == 6


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("?q=BEEF", ["Beef 100% Tapa", "Beef Caldereta", "Zesty_beef salad"]),
        ("?q=%20%20tapa%20", ["Beef 100% Tapa"]),
        ("?q=100%25", ["Beef 100% Tapa"]),
        ("?q=_beef", ["Zesty_beef salad"]),
        ("?q=%20%20", 6),
        ("?q=sinigang", []),
        ("?available=false", ["adobo", "Zesty_beef salad"]),
        ("?available=true&q=o", ["Adobo", "pork BBQ"]),
    ],
)
def test_foods_are_found_by_text_and_availability(
    larder: TestClient, query: str, expected: list[str] | int
) -> None:
    found = names(larder, query)

    assert len(found) == expected if isinstance(expected, int) else found == expected


def test_foods_are_found_by_category(larder: TestClient) -> None:
    pork = category(larder, "Pork")

    assert names(larder, f"?category_id={pork}") == ["adobo", "pork BBQ"]
    assert names(larder, f"?category_id={pork}&available=true&q=bbq") == ["pork BBQ"]
    assert names(larder, f"?category_id={category(larder, 'Fish, Lumpia & More')}") == []


@pytest.mark.parametrize(
    ("query", "path"),
    [
        ("?available=yes", "/query/available"),
        ("?available=1", "/query/available"),
        ("?category_id=cat_nowhere", "/query/category_id"),
        (f"?q={'x' * 201}", "/query/q"),
        ("?sort=price", "/query/sort"),
        ("?page=0", "/query/page"),
        ("?limit=101", "/query/limit"),
    ],
)
def test_an_unknown_or_invalid_filter_is_refused_not_ignored(
    larder: TestClient, query: str, path: str
) -> None:
    assert paths(larder.get(f"{API}/foods{query}")) == {path}


def test_the_availability_filter_looks_at_foods_not_their_variants(staff: TestClient) -> None:
    food = new_food(staff)
    hidden = new_variant(staff, food["id"], available=False)

    listed = staff.get(f"{API}/foods?available=true").json()["items"]

    assert [item["variants"] for item in listed] == [[hidden]]


# --- Confirmation by the operator ------------------------------------------------------------


def audit(database: Database) -> list[tuple[str, str, str]]:
    with database.read() as db:
        events = db.scalars(select(AuditEvent).order_by(AuditEvent.id)).all()
    return [(event.action, event.resource_type, event.resource_id) for event in events]


def test_the_operator_confirms_the_version_of_a_variant_that_was_reviewed(
    staff: TestClient, cli: Cli, database: Database, capsys: pytest.CaptureFixture[str]
) -> None:
    food = new_food(staff)
    variant = new_variant(staff, food["id"])

    assert cli("menu", "confirm", "variant", variant["id"], "--version", "2") == 1
    assert "version 1" in capsys.readouterr().err
    assert cli("menu", "confirm", "variant", "var_nowhere", "--version", "1") == 1
    assert cli("menu", "confirm", "variant", variant["id"], "--version", "1") == 0

    current = read_food(staff, food["id"])
    assert current["variants"] == [{**variant, "version": 2, "confirmation_status": "confirmed"}]
    assert (current["version"], current["confirmation_status"]) == (3, "provisional")
    assert audit(database) == [("menu.confirmed", "variant", variant["id"])]
    assert cli("menu", "confirm", "variant", variant["id"], "--version", "2") == 1


def test_the_operator_confirms_a_food(staff: TestClient, cli: Cli, database: Database) -> None:
    food = new_food(staff)

    assert cli("menu", "confirm", "food", food["id"], "--version", "1") == 0

    assert read_food(staff, food["id"]) == {
        **food,
        "version": 2,
        "confirmation_status": "confirmed",
    }
    assert audit(database) == [("menu.confirmed", "food", food["id"])]


@pytest.mark.parametrize(
    ("change", "status"),
    [
        ({"label": "Regular"}, "provisional"),
        ({"price_minor": 8001}, "provisional"),
        (
            {"selling_unit": "package", "package_contents": {"quantity": 6, "unit": "piece"}},
            "provisional",
        ),
        ({"available": False}, "confirmed"),
        ({**TRAY}, "confirmed"),
    ],
)
def test_a_material_change_to_a_confirmed_variant_makes_it_provisional_again(
    staff: TestClient, cli: Cli, database: Database, change: dict[str, Any], status: str
) -> None:
    food = new_food(staff)
    variant = new_variant(staff, food["id"])
    cli("menu", "confirm", "variant", variant["id"], "--version", "1")

    edited = save(staff, "PATCH", f"/variants/{variant['id']}", {"expected_version": 2, **change})

    assert edited.json()["confirmation_status"] == status
    reset = [("menu.confirmation_reset", "variant", variant["id"])]
    assert audit(database)[1:] == (reset if status == "provisional" else [])


@pytest.mark.parametrize(
    ("change", "status"),
    [
        ({"name": "Kaldereta"}, "provisional"),
        ({"name": " Beef Caldereta "}, "confirmed"),
        ({"description": "Now with olives", "available": False}, "confirmed"),
    ],
)
def test_renaming_a_confirmed_food_makes_it_provisional_again(
    staff: TestClient, cli: Cli, change: dict[str, Any], status: str
) -> None:
    food = new_food(staff)
    cli("menu", "confirm", "food", food["id"], "--version", "1")

    edited = save(staff, "PATCH", f"/foods/{food['id']}", {"expected_version": 2, **change})

    assert edited.json()["confirmation_status"] == status


def test_the_operator_can_see_ids_versions_and_statuses(
    staff: TestClient, cli: Cli, capsys: pytest.CaptureFixture[str]
) -> None:
    food = new_food(staff)
    variant = new_variant(staff, food["id"])
    capsys.readouterr()

    assert cli("menu", "show") == 0

    shown = capsys.readouterr().out
    for expected in [food["id"], variant["id"], "Beef Caldereta", "Medium", "provisional"]:
        assert expected in shown


# --- The development seed --------------------------------------------------------------------


def test_the_seed_loads_only_the_rows_the_decision_register_knows(
    client: TestClient, admin: StaffUser, cli: Cli
) -> None:
    cli(*SETTINGS, "--enable=menu")
    client.headers["X-CSRF-Token"] = sign_in(client).json()["csrf_token"]

    assert cli("menu", "seed") == 0

    foods = client.get(f"{API}/foods").json()["items"]
    assert {
        food["name"]: [
            (
                variant["label"],
                variant["selling_unit"],
                variant["price_minor"],
                (variant["package_contents"] or {}).get("quantity"),
            )
            for variant in food["variants"]
        ]
        for food in foods
    } == {
        "Beef Caldereta": [
            ("Small", "tray", 6000, None),
            ("Medium", "tray", 8000, None),
            ("Large", "tray", 10500, None),
        ],
        "Fresh Lumpia": [("Each", "piece", 300, None)],
        "Shanghai Spring Rolls": [("100 pieces", "package", 5500, 100)],
    }
    # The two Pork BBQ options are unknown, so nothing is invented for them.
    assert all(
        record["confirmation_status"] == "provisional"
        for food in foods
        for record in [food, *food["variants"]]
    )
    categories = client.get(f"{API}/categories").json()["items"]
    assert [item["name"] for item in categories] == [
        "Beef",
        "Chicken",
        "Fish, Lumpia & More",
        "Pork",
    ]


def test_the_seed_never_adds_to_an_existing_menu_or_a_live_system(
    staff: TestClient, cli: Cli, capsys: pytest.CaptureFixture[str]
) -> None:
    cli("settings", "set", "--environment=live")
    assert cli("menu", "seed") == 1
    assert "live" in capsys.readouterr().err
    cli("settings", "set", "--environment=development")
    new_food(staff)

    assert cli("menu", "seed") == 1

    assert names(staff) == ["Beef Caldereta"]
