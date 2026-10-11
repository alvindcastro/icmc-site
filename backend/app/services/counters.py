from sqlalchemy.orm import Session

from app.persistence.models import Counter


def next_number(db: Session, name: str) -> int:
    """The next value of a named running number. It advances inside the caller's transaction,
    so a save that is refused does not use one up."""
    counter = db.get(Counter, name)
    if counter is None:
        counter = Counter(name=name, value=0)
        db.add(counter)
    counter.value += 1
    return counter.value
