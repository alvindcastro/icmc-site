from alembic import context
from sqlalchemy import Connection

from app.config import Settings
from app.persistence.database import Database
from app.persistence.models import Base


def run(connection: Connection) -> None:
    # Batch mode lets later revisions alter SQLite tables, which SQLite cannot do in place.
    context.configure(connection=connection, target_metadata=Base.metadata, render_as_batch=True)
    context.run_migrations()


supplied: Connection | None = context.config.attributes.get("connection")
if supplied is not None:
    # The application migrates inside its own write transaction.
    run(supplied)
else:
    # The alembic command line, used to write new revisions against the configured database.
    database = Database(Settings().database_url)
    with database.write() as session:
        run(session.connection())
    database.dispose()
