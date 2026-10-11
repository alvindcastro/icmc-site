import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(Settings(_env_file=None)))


def test_health_reports_ok_without_a_session_or_business_data(client: TestClient) -> None:
    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_stays_outside_the_versioned_api(client: TestClient) -> None:
    assert client.get("/api/v1/healthz").status_code == 404


def test_contract_routes_not_built_yet_are_not_found(client: TestClient) -> None:
    assert client.get("/api/v1/orders").status_code == 404
    assert client.get("/api/v1/ingredients").status_code == 404


def test_api_description_is_served_by_default(client: TestClient) -> None:
    response = client.get("/openapi.json")

    assert response.status_code == 200
    assert response.json()["info"] == {"title": "Food Reservations API", "version": "0.1.0"}
    assert client.get("/docs").status_code == 200


def test_api_description_can_be_switched_off() -> None:
    client = TestClient(create_app(Settings(_env_file=None, docs_enabled=False)))

    assert client.get("/openapi.json").status_code == 404
    assert client.get("/docs").status_code == 404
    assert client.get("/healthz").status_code == 200


def test_settings_come_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FOOD_API_DOCS_ENABLED", raising=False)
    assert Settings(_env_file=None).docs_enabled is True

    monkeypatch.setenv("FOOD_API_DOCS_ENABLED", "false")
    assert Settings(_env_file=None).docs_enabled is False


def test_settings_come_from_a_local_env_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("FOOD_API_DOCS_ENABLED", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text("FOOD_API_DOCS_ENABLED=false\n")

    assert Settings(_env_file=env_file).docs_enabled is False


def test_the_server_refuses_to_start_on_a_database_that_was_never_migrated(
    tmp_path: Path,
) -> None:
    config = Settings(_env_file=None, database_url=f"sqlite:///{(tmp_path / 'new.db').as_posix()}")

    with pytest.raises(RuntimeError, match="food-admin migrate"), TestClient(create_app(config)):
        pass


def test_request_logs_are_shown_when_nothing_else_configured_logging(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    logger = logging.getLogger("app")
    monkeypatch.setattr(logging.getLogger(), "handlers", [])
    monkeypatch.setattr(logger, "handlers", [])
    monkeypatch.setattr(logger, "level", logging.NOTSET)

    create_app(Settings(_env_file=None))
    create_app(Settings(_env_file=None))

    assert len(logger.handlers) == 1
    assert logger.level == logging.INFO


def test_an_existing_logging_setup_is_left_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    logger = logging.getLogger("app")
    monkeypatch.setattr(logging.getLogger(), "handlers", [logging.NullHandler()])
    monkeypatch.setattr(logger, "handlers", [])

    create_app(Settings(_env_file=None))

    assert logger.handlers == []
