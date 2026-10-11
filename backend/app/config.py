from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Process configuration from FOOD_API_* environment variables or a local .env file."""

    model_config = SettingsConfigDict(env_prefix="FOOD_API_", env_file=".env", extra="ignore")

    docs_enabled: bool = True
    database_url: str = "sqlite:///food-reservations.db"
    # How long a request waits for another write to finish before giving up.
    database_busy_timeout_ms: int = 5000
    # Comma-separated origins the browser may send mutations from. The defaults are the
    # frontend's development server.
    allowed_origins: str = "http://127.0.0.1:5173,http://localhost:5173"
    # Turning this off lets the session cookie travel over plain HTTP. It is honoured only
    # while the business settings are in the development environment.
    cookie_secure: bool = True
    session_idle_seconds: int = 1800
    session_absolute_seconds: int = 43200
    pre_auth_seconds: int = 900
    sign_in_max_failures: int = 5
    sign_in_window_seconds: int = 900

    @property
    def origins(self) -> frozenset[str]:
        return frozenset(
            origin.strip().rstrip("/")
            for origin in self.allowed_origins.split(",")
            if origin.strip()
        )
