"""
API Keys feature - SQLAlchemy models for the multi-provider key pool.

The raw key is encrypted at rest (see crypto.py). A SHA-256 hash of the
plaintext is stored separately to support duplicate detection without
needing to decrypt every row.

The table is still named `gemini_api_keys` because it predates multi-provider
support and renaming a table SQLite-side would mean rebuilding it on every
existing install; the `provider` column is what actually distinguishes rows.
"""
import hashlib
import json
import logging
import uuid
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from app.db import db
from app.features.api_keys.crypto import decrypt, encrypt

logger = logging.getLogger(__name__)

# Gemini free-tier RPD resets at midnight Pacific Time.
PACIFIC_TZ = ZoneInfo("America/Los_Angeles")


def today_pst() -> date:
    """Return current date in Pacific Time — the boundary Gemini uses for RPD reset."""
    return datetime.now(PACIFIC_TZ).date()


def hash_key(raw_key: str) -> str:
    return hashlib.sha256((raw_key or "").encode("utf-8")).hexdigest()


# Gemini free-tier rate limits per model (as of 2026)
MODEL_LIMITS = {
    "gemini-2.5-flash": {
        "displayName": "Gemini 2.5 Flash",
        "rpd": 500,
        "rpm": 15,
        "tpm": 1_000_000,
        "tier": "free",
    },
    "gemini-2.5-flash-lite": {
        "displayName": "Gemini 2.5 Flash Lite",
        "rpd": 500,
        "rpm": 30,
        "tpm": 1_000_000,
        "tier": "free",
    },
    "gemini-2.0-flash": {
        "displayName": "Gemini 2.0 Flash",
        "rpd": 1500,
        "rpm": 15,
        "tpm": 4_000_000,
        "tier": "free",
    },
}


class ApiKey(db.Model):
    __tablename__ = "gemini_api_keys"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    provider = db.Column(db.String(32), nullable=False, default="gemini", index=True)
    label = db.Column(db.String(255), default="")
    # Ciphertext column (mapped to "key" for backward compatibility with the
    # existing schema). Access plaintext via the `key` property.
    _key = db.Column("key", db.String(1024), nullable=False)
    # SHA-256 of the plaintext key — used for duplicate lookup without decrypt.
    key_hash = db.Column(db.String(64), nullable=True, unique=True, index=True)

    status = db.Column(db.String(20), default="active")  # active | cooldown | disabled
    usage_count = db.Column(db.Integer, default=0)
    error_count = db.Column(db.Integer, default=0)
    total_input_tokens = db.Column(db.Integer, default=0)
    total_output_tokens = db.Column(db.Integer, default=0)

    # Per-model usage: JSON dict {model_name: {requests, input_tokens, output_tokens}}
    _model_usage = db.Column("model_usage", db.Text, default="{}")

    last_used_at = db.Column(db.DateTime, nullable=True)
    last_error = db.Column(db.Text, default="")
    cooldown_until = db.Column(db.DateTime, nullable=True)

    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    @property
    def key(self) -> str:
        if not self._key:
            return ""
        try:
            return decrypt(self._key)
        except Exception:
            logger.exception("Failed to decrypt API key id=%s", self.id)
            return ""

    @key.setter
    def key(self, value: str) -> None:
        plain = (value or "").strip()
        if plain:
            self._key = encrypt(plain)
            self.key_hash = hash_key(plain)
        else:
            self._key = ""
            self.key_hash = None

    def get_model_usage(self) -> dict:
        try:
            return json.loads(self._model_usage or "{}")
        except (json.JSONDecodeError, TypeError):
            return {}

    def set_model_usage(self, data: dict) -> None:
        self._model_usage = json.dumps(data, ensure_ascii=False)

    def add_model_usage(self, model_name: str, input_tokens: int, output_tokens: int) -> None:
        usage = self.get_model_usage()
        if model_name not in usage:
            usage[model_name] = {"requests": 0, "input_tokens": 0, "output_tokens": 0}
        usage[model_name]["requests"] += 1
        usage[model_name]["input_tokens"] += input_tokens
        usage[model_name]["output_tokens"] += output_tokens
        self.set_model_usage(usage)

    def masked_key(self) -> str:
        k = self.key or ""
        if len(k) <= 8:
            return "***"
        return k[:4] + "•" * (len(k) - 8) + k[-4:]

    def to_dict(self, include_full_key: bool = False) -> dict:
        model_usage = self.get_model_usage()
        today = today_pst()
        today_rows = GeminiApiKeyDailyUsage.query.filter_by(
            key_id=self.id, date_pst=today
        ).all()
        today_by_model = {
            row.model: {
                "requests": row.requests,
                "inputTokens": row.input_tokens,
                "outputTokens": row.output_tokens,
            }
            for row in today_rows
        }
        input_tokens_today = sum(row.input_tokens for row in today_rows)
        output_tokens_today = sum(row.output_tokens for row in today_rows)
        return {
            "id": self.id,
            "provider": self.provider or "gemini",
            "label": self.label or "",
            "key": self.key if include_full_key else self.masked_key(),
            "status": self.status,
            "usageCount": self.usage_count,
            "errorCount": self.error_count,
            "totalInputTokens": self.total_input_tokens,
            "totalOutputTokens": self.total_output_tokens,
            "totalTokens": self.total_input_tokens + self.total_output_tokens,
            "modelUsage": {
                name: {
                    "requests": stats.get("requests", 0),
                    "inputTokens": stats.get("input_tokens", 0),
                    "outputTokens": stats.get("output_tokens", 0),
                    "totalTokens": stats.get("input_tokens", 0) + stats.get("output_tokens", 0),
                    "requestsToday": today_by_model.get(name, {}).get("requests", 0),
                    "inputTokensToday": today_by_model.get(name, {}).get("inputTokens", 0),
                    "outputTokensToday": today_by_model.get(name, {}).get("outputTokens", 0),
                }
                for name, stats in model_usage.items()
            },
            "requestsToday": sum(row.requests for row in today_rows),
            "inputTokensToday": input_tokens_today,
            "outputTokensToday": output_tokens_today,
            "tokensToday": input_tokens_today + output_tokens_today,
            "datePst": today.isoformat(),
            "lastUsedAt": self.last_used_at.isoformat().replace("+00:00", "Z") if self.last_used_at else None,
            "lastError": self.last_error or "",
            "createdAt": self.created_at.isoformat().replace("+00:00", "Z") if self.created_at else None,
        }


#: Historical alias — the class was Gemini-only before multi-provider support.
GeminiApiKey = ApiKey


class GeminiApiKeyDailyUsage(db.Model):
    """Per-(key, model, day) usage counter — provides historical view + 'today vs RPD'.

    Reset boundary is midnight Pacific Time, matching how Gemini resets RPD quotas.
    """
    __tablename__ = "gemini_api_key_daily_usage"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    key_id = db.Column(
        db.String(36),
        db.ForeignKey("gemini_api_keys.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    provider = db.Column(db.String(32), nullable=False, default="gemini", index=True)
    model = db.Column(db.String(160), nullable=False)
    date_pst = db.Column(db.Date, nullable=False, index=True)
    requests = db.Column(db.Integer, nullable=False, default=0)
    input_tokens = db.Column(db.Integer, nullable=False, default=0)
    output_tokens = db.Column(db.Integer, nullable=False, default=0)

    __table_args__ = (
        db.UniqueConstraint("key_id", "model", "date_pst", name="uq_daily_usage_key_model_date"),
    )

    def to_dict(self) -> dict:
        return {
            "keyId": self.key_id,
            "provider": self.provider or "gemini",
            "model": self.model,
            "datePst": self.date_pst.isoformat() if self.date_pst else None,
            "requests": self.requests,
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "totalTokens": self.input_tokens + self.output_tokens,
        }


def bump_daily_usage(
    key_id: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    provider: str = "gemini",
) -> None:
    """Increment today's counter (Pacific Time) for (key, model). Creates row if missing."""
    today = today_pst()
    row = GeminiApiKeyDailyUsage.query.filter_by(
        key_id=key_id, model=model, date_pst=today
    ).first()
    if row is None:
        row = GeminiApiKeyDailyUsage(
            key_id=key_id, provider=provider, model=model, date_pst=today,
            requests=0, input_tokens=0, output_tokens=0,
        )
        db.session.add(row)
    row.requests += 1
    row.input_tokens += int(input_tokens or 0)
    row.output_tokens += int(output_tokens or 0)
