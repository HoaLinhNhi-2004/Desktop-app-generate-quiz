"""
Persistence for the multi-provider LLM layer: the cached model catalogue and a
small key/value store for user preferences.

Model lists are cached rather than hard-coded so a provider shipping a new model
does not require a code change — the cache is refreshed whenever a key for that
provider is verified, and on demand from Settings.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from app.db import db
from app.features.llm.types import ModelInfo

logger = logging.getLogger(__name__)

SETTING_DEFAULT_PROVIDER = "llm_default_provider"
SETTING_MODEL_CHAIN_PREFIX = "llm_model_chain:"
SETTING_CROSS_PROVIDER_FALLBACK = "llm_cross_provider_fallback"


class ProviderModel(db.Model):
    """One model advertised by a provider, as of `fetched_at`."""

    __tablename__ = "llm_provider_models"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    provider = db.Column(db.String(32), nullable=False, index=True)
    model = db.Column(db.String(160), nullable=False)
    display_name = db.Column(db.String(255), default="")
    rank = db.Column(db.Integer, nullable=False, default=0)
    rpd = db.Column(db.Integer, nullable=False, default=0)
    rpm = db.Column(db.Integer, nullable=False, default=0)
    tpm = db.Column(db.Integer, nullable=False, default=0)
    tier = db.Column(db.String(16), default="unknown")
    fetched_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        db.UniqueConstraint("provider", "model", name="uq_provider_model"),
    )

    def to_dict(self) -> dict:
        return {
            "provider": self.provider,
            "model": self.model,
            "displayName": self.display_name or self.model,
            "rank": self.rank,
            "rpd": self.rpd,
            "rpm": self.rpm,
            "tpm": self.tpm,
            "tier": self.tier,
            "fetchedAt": self.fetched_at.isoformat().replace("+00:00", "Z") if self.fetched_at else None,
        }


class AppSetting(db.Model):
    """Tiny key/value store — avoids a migration per new preference."""

    __tablename__ = "app_settings"

    key = db.Column(db.String(64), primary_key=True)
    value = db.Column(db.Text, default="")
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))


def get_setting(key: str, default: str = "") -> str:
    row = db.session.get(AppSetting, key)
    return row.value if row and row.value is not None else default


def set_setting(key: str, value: str) -> None:
    row = db.session.get(AppSetting, key)
    if row is None:
        row = AppSetting(key=key)
        db.session.add(row)
    row.value = value
    row.updated_at = datetime.now(timezone.utc)
    db.session.commit()


def get_default_provider() -> str:
    from app.features.llm.registry import DEFAULT_PROVIDER, is_known

    stored = get_setting(SETTING_DEFAULT_PROVIDER, "").strip()
    return stored if is_known(stored) else DEFAULT_PROVIDER


def set_default_provider(provider: str) -> None:
    from app.features.llm.registry import get_spec

    set_setting(SETTING_DEFAULT_PROVIDER, get_spec(provider).id)


def is_cross_provider_fallback_enabled() -> bool:
    return get_setting(SETTING_CROSS_PROVIDER_FALLBACK, "1") != "0"


def set_cross_provider_fallback(enabled: bool) -> None:
    set_setting(SETTING_CROSS_PROVIDER_FALLBACK, "1" if enabled else "0")


def get_model_chain_override(provider: str) -> list[str]:
    raw = get_setting(f"{SETTING_MODEL_CHAIN_PREFIX}{provider}", "")
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    return [str(m) for m in parsed if str(m).strip()] if isinstance(parsed, list) else []


def set_model_chain_override(provider: str, models: list[str]) -> None:
    cleaned = [m.strip() for m in models if isinstance(m, str) and m.strip()]
    set_setting(
        f"{SETTING_MODEL_CHAIN_PREFIX}{provider}",
        json.dumps(cleaned, ensure_ascii=False) if cleaned else "",
    )


def cached_models(provider: str) -> list[ProviderModel]:
    return (
        ProviderModel.query
        .filter_by(provider=provider)
        .order_by(ProviderModel.rank.desc(), ProviderModel.model.asc())
        .all()
    )


def replace_cached_models(provider: str, models: list[ModelInfo]) -> int:
    """Swap the cached catalogue for `provider`. Returns how many rows were kept."""
    if not models:
        return 0
    ProviderModel.query.filter_by(provider=provider).delete()
    now = datetime.now(timezone.utc)
    for info in models:
        db.session.add(ProviderModel(
            provider=provider,
            model=info.model,
            display_name=info.display_name,
            rank=info.rank,
            rpd=info.rpd,
            rpm=info.rpm,
            tpm=info.tpm,
            tier=info.tier,
            fetched_at=now,
        ))
    db.session.commit()
    return len(models)


#: How many models a provider's auto-built fallback chain may contain.
CHAIN_LENGTH = 3


def resolve_model_chain(provider: str) -> list[str]:
    """The models to try, in order, for `provider`.

    Precedence: an explicit user choice, then the highest-ranked models from the
    provider's own catalogue, then the registry's hard-coded fallback.
    """
    from app.features.llm.registry import get_spec

    spec = get_spec(provider)

    override = get_model_chain_override(spec.id)
    if override:
        return override

    try:
        ranked = [row.model for row in cached_models(spec.id)[:CHAIN_LENGTH]]
    except Exception as exc:  # table missing on a very old DB
        logger.warning("Could not read cached models for %s: %s", spec.id, exc)
        ranked = []

    return ranked or list(spec.default_models)
