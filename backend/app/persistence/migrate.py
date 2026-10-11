from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory

from app.persistence.database import Database

MIGRATIONS = Path(__file__).parent / "migrations"


def _config() -> Config:
    config = Config()
    config.set_main_option("script_location", MIGRATIONS.as_posix())
    return config


def is_current(database: Database) -> bool:
    """Whether the database has exactly the schema this version of the code expects."""
    with database.read() as session:
        applied = MigrationContext.configure(session.connection()).get_current_revision()
    return applied == ScriptDirectory.from_config(_config()).get_current_head()


def upgrade(database: Database) -> None:
    """Bring the database to the newest schema. All pending revisions apply together or not at
    all, and repeating the call changes nothing."""
    config = _config()
    with database.write() as session:
        config.attributes["connection"] = session.connection()
        command.upgrade(config, "head")
