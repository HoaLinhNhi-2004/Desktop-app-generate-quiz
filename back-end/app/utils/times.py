"""Datetime serialisation for JSON responses.

Models store timestamps with `datetime.now(timezone.utc)`, but the columns are
declared `db.DateTime` without `timezone=True`. SQLite has no native timestamp
type, so SQLAlchemy drops the tzinfo on write and hands back a *naive* datetime
on read. `.isoformat()` then produces "2026-08-10T16:03:17" with no offset, and
`.replace("+00:00", "Z")` has nothing to replace.

The browser reads an offset-less ISO string as *local* time, so every timestamp
in the UI was showing 7 hours early in UTC+7.

Anything already read out of the database is UTC — that is what was written — so
attaching the offset here is a correction, not a guess.
"""

from datetime import datetime, timezone


def iso_utc(value: datetime | None) -> str | None:
    """Serialise a datetime as an unambiguous UTC ISO-8601 string ending in `Z`.

    Naive values are assumed UTC (what the models write); aware values are
    converted. Returns None for None so callers can pass optional columns straight
    through.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    else:
        value = value.astimezone(timezone.utc)
    return value.isoformat().replace("+00:00", "Z")
