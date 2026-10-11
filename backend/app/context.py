from dataclasses import dataclass

from app.clock import Clock
from app.config import Settings
from app.persistence.database import Database


@dataclass(frozen=True)
class Context:
    """What the application was built with: its database, its clock and its configuration."""

    database: Database
    clock: Clock
    config: Settings
