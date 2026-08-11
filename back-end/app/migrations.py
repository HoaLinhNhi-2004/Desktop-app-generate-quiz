"""
Lightweight SQLite migration runner.

Why this exists: the project does not use Alembic. Schema changes are applied
in-place on user DBs. Without a version table, every migration step had to be
defensive (`PRAGMA table_info` + conditional ALTER), and there was no audit
trail of what had been applied to a given install.

This module:
  - Records applied migrations in a `schema_versions` table.
  - Skips migrations already recorded.
  - Keeps each migration idempotent anyway (defense in depth — useful when the
    table is reset or when the user's DB pre-dates this runner).
  - Runs AFTER `db.create_all()` so base tables always exist.

Adding a new migration:
  1. Write a function `_m_NNN_short_label(cursor)` that issues the SQL.
  2. Append `("NNN_short_label", "human description", _m_NNN_short_label)` to
     `MIGRATIONS`. Never reorder or rename existing entries.
"""
import logging
import sqlite3
from datetime import datetime, timezone
from typing import Callable, List, Tuple

logger = logging.getLogger(__name__)

Migration = Tuple[str, str, Callable[[sqlite3.Cursor], None]]


def _ensure_schema_versions_table(cursor: sqlite3.Cursor) -> None:
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_versions (
            version VARCHAR(64) PRIMARY KEY,
            applied_at VARCHAR(32) NOT NULL
        )
        """
    )


def _column_exists(cursor: sqlite3.Cursor, table: str, column: str) -> bool:
    cursor.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cursor.fetchall())


def _add_column_if_missing(
    cursor: sqlite3.Cursor, table: str, column: str, ddl: str
) -> None:
    if not _column_exists(cursor, table, column):
        cursor.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


# ─── Migrations (declaration order is apply order — never reorder) ─────────

def _m_002_api_keys_extras(cursor: sqlite3.Cursor) -> None:
    _add_column_if_missing(cursor, "gemini_api_keys", "model_usage", "model_usage TEXT DEFAULT '{}'")
    _add_column_if_missing(cursor, "gemini_api_keys", "key_hash", "key_hash VARCHAR(64)")
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_gemini_api_keys_key_hash "
        "ON gemini_api_keys(key_hash)"
    )


def _m_003_folder_extras(cursor: sqlite3.Cursor) -> None:
    _add_column_if_missing(cursor, "folders", "is_favorite", "is_favorite INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(cursor, "folders", "last_accessed_at", "last_accessed_at DATETIME")


def _m_004_quizset_extras(cursor: sqlite3.Cursor) -> None:
    _add_column_if_missing(cursor, "quiz_sets", "page_distribution", "page_distribution TEXT")
    _add_column_if_missing(cursor, "quiz_sets", "source_upload_ids", "source_upload_ids TEXT")


def _m_005_question_extras(cursor: sqlite3.Cursor) -> None:
    _add_column_if_missing(cursor, "questions", "source_pages", "source_pages TEXT")
    _add_column_if_missing(cursor, "questions", "source_keyword", "source_keyword TEXT")
    _add_column_if_missing(cursor, "questions", "correct_answer_ids", "correct_answer_ids TEXT")


def _m_006_uploaded_files_extras(cursor: sqlite3.Cursor) -> None:
    _add_column_if_missing(
        cursor, "uploaded_files", "processing_status",
        "processing_status VARCHAR(16) DEFAULT 'pending'",
    )
    _add_column_if_missing(cursor, "uploaded_files", "processing_error", "processing_error TEXT")
    _add_column_if_missing(cursor, "uploaded_files", "chunk_count", "chunk_count INTEGER DEFAULT 0")


def _m_007_api_key_daily_usage(cursor: sqlite3.Cursor) -> None:
    """Per-(key, model, day) usage table. db.create_all() also creates this if
    SQLAlchemy metadata sees the model — we keep this migration as a belt-and-
    suspenders for legacy installs and to ensure the unique index exists.
    """
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS gemini_api_key_daily_usage (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key_id VARCHAR(36) NOT NULL,
            model VARCHAR(64) NOT NULL,
            date_pst DATE NOT NULL,
            requests INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (key_id) REFERENCES gemini_api_keys(id) ON DELETE CASCADE
        )
        """
    )
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_usage_key_model_date "
        "ON gemini_api_key_daily_usage(key_id, model, date_pst)"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS ix_daily_usage_key_id "
        "ON gemini_api_key_daily_usage(key_id)"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS ix_daily_usage_date_pst "
        "ON gemini_api_key_daily_usage(date_pst)"
    )


def _m_008_integration_connections(cursor: sqlite3.Cursor) -> None:
    """OAuth connections to Google Drive / Notion. Tokens are stored encrypted."""
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS integration_connections (
            id VARCHAR(36) PRIMARY KEY,
            provider VARCHAR(32) NOT NULL,
            account_label VARCHAR(255) DEFAULT '',
            access_token TEXT NOT NULL DEFAULT '',
            refresh_token TEXT DEFAULT '',
            expires_at DATETIME,
            scopes TEXT DEFAULT '',
            created_at DATETIME,
            updated_at DATETIME
        )
        """
    )
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_integration_connections_provider "
        "ON integration_connections(provider)"
    )


def _m_009_integration_credentials(cursor: sqlite3.Cursor) -> None:
    """User-supplied OAuth apps for Google Drive / Notion. Secrets are encrypted."""
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS integration_credentials (
            id VARCHAR(36) PRIMARY KEY,
            provider VARCHAR(32) NOT NULL,
            client_id VARCHAR(512) NOT NULL DEFAULT '',
            client_secret TEXT NOT NULL DEFAULT '',
            picker_api_key TEXT DEFAULT '',
            created_at DATETIME,
            updated_at DATETIME
        )
        """
    )
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS ix_integration_credentials_provider "
        "ON integration_credentials(provider)"
    )


def _m_010_multi_provider_llm(cursor: sqlite3.Cursor) -> None:
    """Multi-provider LLM support: tag every key with its vendor, cache the
    per-provider model catalogue, and add a key/value store for preferences.

    Existing rows are Gemini keys by definition — the DEFAULT backfills them.
    """
    _add_column_if_missing(
        cursor, "gemini_api_keys", "provider",
        "provider VARCHAR(32) NOT NULL DEFAULT 'gemini'",
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS ix_gemini_api_keys_provider "
        "ON gemini_api_keys(provider)"
    )
    _add_column_if_missing(
        cursor, "gemini_api_key_daily_usage", "provider",
        "provider VARCHAR(32) NOT NULL DEFAULT 'gemini'",
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS ix_daily_usage_provider "
        "ON gemini_api_key_daily_usage(provider)"
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS llm_provider_models (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider VARCHAR(32) NOT NULL,
            model VARCHAR(160) NOT NULL,
            display_name VARCHAR(255) DEFAULT '',
            rank INTEGER NOT NULL DEFAULT 0,
            rpd INTEGER NOT NULL DEFAULT 0,
            rpm INTEGER NOT NULL DEFAULT 0,
            tpm INTEGER NOT NULL DEFAULT 0,
            tier VARCHAR(16) DEFAULT 'unknown',
            fetched_at DATETIME
        )
        """
    )
    cursor.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_model "
        "ON llm_provider_models(provider, model)"
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS ix_llm_provider_models_provider "
        "ON llm_provider_models(provider)"
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS app_settings (
            key VARCHAR(64) PRIMARY KEY,
            value TEXT DEFAULT '',
            updated_at DATETIME
        )
        """
    )


def _m_011_question_bank_import(cursor: sqlite3.Cursor) -> None:
    """Import of documents that already contain questions.

    `question_bank_score` is the ingest-time heuristic that drives the "this looks
    like an exam" nudge; `origin` records whether a question was copied out of the
    document or written by the model, which is what makes a hybrid quiz readable.
    """
    _add_column_if_missing(
        cursor, "uploaded_files", "question_bank_score",
        "question_bank_score REAL DEFAULT 0",
    )
    _add_column_if_missing(
        cursor, "questions", "origin",
        "origin VARCHAR(16) DEFAULT 'generated'",
    )


MIGRATIONS: List[Migration] = [
    ("002_api_keys_extras", "API keys: model_usage + key_hash + unique index", _m_002_api_keys_extras),
    ("003_folder_extras", "Folders: is_favorite + last_accessed_at", _m_003_folder_extras),
    ("004_quizset_extras", "Quiz sets: page_distribution + source_upload_ids", _m_004_quizset_extras),
    ("005_question_extras", "Questions: source_pages + source_keyword + correct_answer_ids", _m_005_question_extras),
    ("006_uploaded_files_extras", "Uploaded files: processing_status + processing_error + chunk_count", _m_006_uploaded_files_extras),
    ("007_api_key_daily_usage", "API keys: per-day usage table for history & RPD tracking", _m_007_api_key_daily_usage),
    ("008_integration_connections", "Integrations: OAuth connections for Google Drive / Notion", _m_008_integration_connections),
    ("009_integration_credentials", "Integrations: user-supplied OAuth app credentials", _m_009_integration_credentials),
    ("010_multi_provider_llm", "LLM: provider column, model catalogue cache, app settings", _m_010_multi_provider_llm),
    ("011_question_bank_import", "Import: uploaded_files.question_bank_score + questions.origin", _m_011_question_bank_import),
]


def run_migrations(db_uri: str, logger_obj: logging.Logger | None = None) -> None:
    """Apply any pending migrations to the SQLite DB at db_uri.

    db_uri must start with `sqlite:///`. Other DB backends are ignored.
    """
    log = logger_obj or logger
    if not db_uri.startswith("sqlite:///"):
        log.warning("Migration runner only supports sqlite:/// URIs (got %r)", db_uri[:32])
        return

    db_path = db_uri.replace("sqlite:///", "")
    try:
        conn = sqlite3.connect(db_path)
    except sqlite3.Error as e:
        log.error("Could not open DB for migrations: %s", e)
        return

    try:
        cursor = conn.cursor()
        _ensure_schema_versions_table(cursor)
        conn.commit()

        cursor.execute("SELECT version FROM schema_versions")
        applied = {row[0] for row in cursor.fetchall()}

        for version, description, fn in MIGRATIONS:
            if version in applied:
                continue
            try:
                fn(cursor)
            except sqlite3.OperationalError as e:
                if "no such table" in str(e).lower():
                    cursor.execute(
                        "INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)",
                        (version, datetime.now(timezone.utc).isoformat()),
                    )
                    conn.commit()
                    log.info("Skipped migration %s (target table not yet created)", version)
                    continue
                log.error("Migration %s failed: %s", version, e)
                conn.rollback()
                continue
            except Exception as e:
                log.error("Migration %s failed: %s", version, e)
                conn.rollback()
                continue

            cursor.execute(
                "INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)",
                (version, datetime.now(timezone.utc).isoformat()),
            )
            conn.commit()
            log.info("Applied migration %s — %s", version, description)
    finally:
        conn.close()


def get_applied_versions(db_uri: str) -> List[str]:
    """Return list of migration versions already applied to the DB."""
    if not db_uri.startswith("sqlite:///"):
        return []
    db_path = db_uri.replace("sqlite:///", "")
    try:
        conn = sqlite3.connect(db_path)
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT version FROM schema_versions ORDER BY version")
            return [row[0] for row in cursor.fetchall()]
        finally:
            conn.close()
    except sqlite3.Error:
        return []
