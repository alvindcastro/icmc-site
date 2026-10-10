from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Process configuration from FOOD_API_* environment variables or a local .env file."""

    model_config = SettingsConfigDict(env_prefix="FOOD_API_", env_file=".env", extra="ignore")

    docs_enabled: bool = True
