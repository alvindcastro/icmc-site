import argparse
import json
import re
import secrets
import sqlite3
import sys
from collections.abc import Callable, Sequence
from getpass import getpass
from pathlib import Path

from sqlalchemy import func, select

from app.clock import Clock, utc_now
from app.config import Settings
from app.errors import OperatorError
from app.persistence import migrate
from app.persistence.database import Database
from app.persistence.models import Category, Food
from app.schemas.settings import settings_out
from app.services import accounts, business_settings, menu, operations, orders, preparations
from app.services.credentials import hash_token
from app.values import format_instant

_MINIMUM_TOKEN_LENGTH = 12


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="food-admin", description="Operator commands for the food reservations server."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("migrate", help="create the database or bring its schema up to date")
    commands.add_parser(
        "setup-local",
        help="prepare a development machine: database, token, provisional settings and menu",
    )
    token = commands.add_parser("token", help="set or replace the admin sign-in token")
    actions = token.add_subparsers(dest="action", required=True)
    for action, text in [
        ("set", "set the first token, creating the admin account"),
        ("rotate", "replace the token and end every open session"),
    ]:
        actions.add_parser(action, help=text).add_argument(
            "--generate", action="store_true", help="create a random token and show it once"
        )
    _settings_parser(commands.add_parser("settings", help="show, change or confirm settings"))
    category = commands.add_parser("category", help="add or list menu categories")
    actions = category.add_subparsers(dest="action", required=True)
    actions.add_parser("add", help="add a category").add_argument("name")
    actions.add_parser("list", help="list categories with their IDs")
    menu_parser = commands.add_parser("menu", help="show, confirm or seed the menu")
    actions = menu_parser.add_subparsers(dest="action", required=True)
    actions.add_parser("show", help="list foods and variants with IDs, versions and status")
    confirm = actions.add_parser(
        "confirm", help="record that a food or variant was reviewed and is correct"
    )
    confirm.add_argument("kind", choices=["food", "variant"])
    confirm.add_argument("id")
    confirm.add_argument("--version", type=int, required=True, help="the version you reviewed")
    actions.add_parser("seed", help="fill an empty development menu with the provisional rows")
    preparation = commands.add_parser(
        "preparation", help="bring open orders into preparation recording"
    )
    actions = preparation.add_subparsers(dest="action", required=True)
    actions.add_parser("status", help="list the open orders still tracked by hand")
    baseline = actions.add_parser(
        "baseline", help="record what an open order already had prepared; moves no stock"
    )
    baseline.add_argument("reference", help="the order reference, such as DEV-0001")
    baseline.add_argument(
        "--prepared",
        action="append",
        default=[],
        metavar="LINE=QUANTITY",
        help="how many of a line are already prepared; lines not named start at nothing",
    )
    baseline.add_argument("--all", action="store_true", help="every line is fully prepared")
    baseline.add_argument("--reason", required=True, help="where the counts came from")
    backup = commands.add_parser(
        "backup", help="copy the whole database into one new file; safe while the server runs"
    )
    backup.add_argument("file", type=Path, help="the file to write; it must not exist yet")
    operation = commands.add_parser("operations", help="inspect or close keyed saves")
    actions = operation.add_subparsers(dest="action", required=True)
    actions.add_parser("unresolved", help="list saves that were admitted and never finished")
    close = actions.add_parser(
        "close", help="record a key the server never saw as rejected, to unblock a browser"
    )
    close.add_argument("key", help="the operation identifier the frontend is holding")
    close.add_argument("--reason", required=True, help="shown to staff")
    return parser


def _settings_parser(settings: argparse.ArgumentParser) -> None:
    actions = settings.add_subparsers(dest="action", required=True)
    actions.add_parser("show", help="print the settings as the API returns them")

    change = actions.add_parser(
        "set", help="change settings; the first use needs currency, timezone and fulfillment"
    )
    change.add_argument("--environment", choices=business_settings.ENVIRONMENTS)
    change.add_argument("--currency", help="three-letter ISO code, such as USD")
    change.add_argument("--minor-digits", type=int, help="decimal places of the currency")
    change.add_argument("--timezone", help="IANA timezone, such as Asia/Manila")
    change.add_argument(
        "--fulfillment", dest="fulfillment_methods", help="pickup, delivery or pickup,delivery"
    )
    location = change.add_mutually_exclusive_group()
    location.add_argument("--pickup-location")
    location.add_argument("--no-pickup-location", action="store_true")
    change.add_argument("--delivery-mode", choices=business_settings.DELIVERY_MODES)
    change.add_argument("--fixed-charge-minor", type=int, help="in minor units, with fixed_amount")
    change.add_argument("--tax-mode", choices=business_settings.TAX_MODES)
    change.add_argument(
        "--payment-methods", help="one or more of cash, bank_transfer and other, comma-separated"
    )
    for flag in ("--enable", "--disable"):
        change.add_argument(
            flag, action="append", default=[], choices=business_settings.CAPABILITIES
        )

    confirm = actions.add_parser("confirm", help="record that settings were confirmed")
    confirm.add_argument(
        "groups", nargs="*", help=f"any of: {', '.join(business_settings.CONFIRMABLE)}"
    )
    confirm.add_argument("--all", action="store_true", help="confirm every group")


_SETTABLE = (
    "environment",
    "currency",
    "minor_digits",
    "timezone",
    "fulfillment_methods",
    "pickup_location",
    "delivery_mode",
    "fixed_charge_minor",
    "tax_mode",
    "payment_methods",
)


def _settings(args: argparse.Namespace, database: Database, clock: Clock) -> None:
    if args.action == "show":
        with database.read() as db:
            settings = business_settings.load(db)
            if settings is None:
                raise OperatorError("No settings exist yet. Use `food-admin settings set` first.")
            print(json.dumps(settings_out(settings).model_dump(mode="json"), indent=2))
    elif args.action == "set":
        changes = {
            name: getattr(args, name) for name in _SETTABLE if getattr(args, name) is not None
        }
        if args.no_pickup_location:
            changes["pickup_location"] = None
        with database.write() as db:
            changed = business_settings.change(
                db, clock(), changes, enable=args.enable, disable=args.disable
            )
        print("Settings saved." if changed else "No change: the settings already had these values.")
    else:
        if bool(args.groups) == args.all:
            raise OperatorError("Name the groups to confirm, or use --all.")
        groups = list(business_settings.CONFIRMABLE) if args.all else args.groups
        with database.write() as db:
            changed = business_settings.confirm(db, clock(), groups)
        print("Confirmation recorded." if changed else "No change: already confirmed.")


def _setup_local(database: Database, clock: Clock) -> None:
    """Everything a development machine needs, in one step. Whatever already exists is kept."""
    migrate.upgrade(database)
    with database.read() as db:
        if business_settings.is_live(db):
            raise OperatorError("These settings are live. Local setup is for development only.")
        needs_token = not accounts.has_token(db)
    token = secrets.token_urlsafe(32) if needs_token else None
    token_hash = hash_token(token) if token else None
    now = clock()
    with database.write() as db:
        if token_hash:
            accounts.set_token(db, token_hash, now)
        if business_settings.load(db) is None:
            business_settings.change(
                db,
                now,
                business_settings.PROVISIONAL_DEVELOPMENT,
                enable=sorted(business_settings.RELEASED - business_settings.OPT_IN),
            )
            print("Provisional development settings created. Nothing in them is confirmed.")
        else:
            print("Settings already exist and were left as they are.")
        if db.scalar(select(func.count()).select_from(Food)):
            print("The menu already has foods and was left as it is.")
        else:
            print(f"Seeded {menu.seed(db, now)} provisional foods.")
    if token:
        print("Sign in as admin with this token. It is shown once. Store it now:")
        print(token)
    else:
        print("The admin token was already set and is unchanged.")


def _category(args: argparse.Namespace, database: Database, clock: Clock) -> None:
    if args.action == "add":
        with database.write() as db:
            added = menu.add_category(db, args.name, clock())
            print(f"Category added: {added.id}  {added.name}")
    else:
        with database.read() as db:
            for category in db.scalars(select(Category).order_by(Category.name_key, Category.id)):
                print(f"{category.id}  {category.name}")


def _menu(args: argparse.Namespace, database: Database, clock: Clock) -> None:
    if args.action == "show":
        with database.read() as db:
            for food in db.scalars(select(Food).order_by(Food.name_key, Food.id)):
                print(f"{food.id}  v{food.version}  {food.confirmation_status}  {food.name}")
                for variant in food.variants:
                    print(
                        f"  {variant.id}  v{variant.version}  {variant.confirmation_status}  "
                        f"{variant.label}  {variant.selling_unit}  {variant.price_minor}"
                    )
    elif args.action == "confirm":
        with database.write() as db:
            menu.confirm(db, args.kind, args.id, args.version, clock())
        print(f"Confirmed. The {args.kind} is now at version {args.version + 1}.")
    else:
        with database.write() as db:
            added = menu.seed(db, clock())
        print(f"Seeded {added} provisional foods. Nothing in the seed is confirmed.")


def _preparation(args: argparse.Namespace, database: Database, clock: Clock) -> None:
    if args.action == "status":
        with database.read() as db:
            recording = business_settings.enabled(db, "preparation_recording")
            waiting = preparations.tracked_by_hand(db)
            print(f"Preparation recording is {'on' if recording else 'off'}.")
            print(f"Open orders still tracked by hand: {len(waiting)}")
            for order in waiting:
                print(f"  {order.reference}  {order.status}  {order.local_date.isoformat()}")
                for number, line in enumerate(orders.active_lines(order), start=1):
                    print(f"    {number}. {line.food_name}, {line.variant_label}: {line.quantity}")
        return
    if args.all and args.prepared:
        raise OperatorError("Use --all or --prepared, not both.")
    reason = args.reason.strip()
    if not reason:
        raise OperatorError("Give a reason that says where the counts came from.")
    prepared: dict[int, int] = {}
    for entry in args.prepared:
        found = re.fullmatch("([0-9]+)=([0-9]+)", entry)
        if found is None:
            raise OperatorError("Give each --prepared as LINE=QUANTITY, such as 1=2.")
        number = int(found.group(1))
        if number in prepared:
            raise OperatorError(f"--prepared names line {number} twice.")
        prepared[number] = int(found.group(2))
    with database.write() as db:
        order = preparations.baseline(db, args.reference, prepared, args.all, reason, clock())
        print(f"{order.reference} is now recorded. No stock was moved.")
        for number, line in enumerate(orders.active_lines(order), start=1):
            print(
                f"  {number}. {line.food_name}, {line.variant_label}: "
                f"{line.prepared_quantity} of {line.quantity} prepared"
            )
        if order.status == "ready" and orders.remaining(order):
            print(
                "This order is ready with food still to cook. "
                "It cannot be completed until the rest is recorded."
            )


def _backup(target: Path, database: Database) -> None:
    """Write everything, committed up to this moment, into one new file.

    SQLite's own backup is used rather than a copy of the file: recent changes can still be in
    the write-ahead file beside the database, and a plain copy of the main file would miss them.
    """
    if target.exists():
        raise OperatorError(f"{target} already exists. A backup never overwrites; pick a new name.")
    if not target.parent.is_dir():
        raise OperatorError(f"The directory {target.parent} does not exist.")
    destination = sqlite3.connect(target)
    try:
        with database.engine.connect() as connection:
            source = connection.connection.driver_connection
            assert isinstance(source, sqlite3.Connection)
            source.backup(destination)
    except BaseException:
        # Half a backup is worse than none: it would look like one.
        destination.close()
        target.unlink(missing_ok=True)
        raise
    destination.close()
    print(f"Backed up to {target}. It is one complete file. Keep a copy off this machine.")


def _operations(args: argparse.Namespace, database: Database, clock: Clock) -> None:
    if args.action == "unresolved":
        with database.read() as db:
            stuck = operations.unresolved(db)
        for operation in stuck:
            started = format_instant(operation.started_at)
            print(f"{operation.key}  {operation.method} {operation.path}  started {started}")
        if not stuck:
            print("No unresolved operations.")
    else:
        with database.write() as db:
            operations.close(db, args.key, args.reason, clock())
        print("Operation recorded as rejected.")


def _new_token(generate: bool, secret: Callable[[str], str]) -> str:
    if generate:
        return secrets.token_urlsafe(32)
    token = secret("New admin token: ")
    if not token.strip() or len(token) < _MINIMUM_TOKEN_LENGTH:
        raise OperatorError(
            f"Use a token of at least {_MINIMUM_TOKEN_LENGTH} characters that is not blank."
        )
    if secret("Repeat the token: ") != token:
        raise OperatorError("The two entries differ. Nothing was changed.")
    return token


def _token(
    args: argparse.Namespace, database: Database, clock: Clock, secret: Callable[[str], str]
) -> None:
    token = _new_token(args.generate, secret)
    # Hashing is slow on purpose, so it happens before the write lock is taken.
    token_hash = hash_token(token)
    with database.write() as db:
        if args.action == "set":
            accounts.set_token(db, token_hash, clock())
            print("Admin token set.")
        else:
            ended = accounts.rotate_token(db, token_hash, clock())
            print(f"Admin token replaced. Open sessions ended: {ended}.")
    if args.generate:
        print("This token is shown once. Store it now:")
        print(token)


def main(
    argv: Sequence[str] | None = None,
    *,
    config: Settings | None = None,
    clock: Clock = utc_now,
    secret: Callable[[str], str] = getpass,
) -> int:
    args = _parser().parse_args(argv)
    database = Database((config or Settings()).database_url)
    try:
        if args.command == "migrate":
            migrate.upgrade(database)
            print("The database schema is up to date.")
            return 0
        if args.command == "setup-local":
            _setup_local(database, clock)
            return 0
        if not migrate.is_current(database):
            raise OperatorError(
                "The database is missing or out of date. Run `uv run food-admin migrate` first."
            )
        if args.command == "token":
            _token(args, database, clock, secret)
        elif args.command == "settings":
            _settings(args, database, clock)
        elif args.command == "category":
            _category(args, database, clock)
        elif args.command == "menu":
            _menu(args, database, clock)
        elif args.command == "preparation":
            _preparation(args, database, clock)
        elif args.command == "backup":
            _backup(args.file, database)
        else:
            _operations(args, database, clock)
        return 0
    except OperatorError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    finally:
        database.dispose()


if __name__ == "__main__":
    raise SystemExit(main())
