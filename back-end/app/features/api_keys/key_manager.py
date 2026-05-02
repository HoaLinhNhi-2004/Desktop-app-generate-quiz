"""
Key Manager - Rotation logic & usage tracking for multiple Gemini API keys.

Inspired by KeyStream-Gemini's approach:
 - Round-robin rotation: pick the key with the oldest lastUsedAt
 - Automatic cooldown on 429 errors, auto-recovery after cooldown period
 - Per-key token tracking
"""
import logging
from datetime import datetime, timezone, timedelta

from app.db import db
from app.features.api_keys.models import (
    GeminiApiKey,
    GeminiApiKeyDailyUsage,
    bump_daily_usage,
    today_pst,
)

logger = logging.getLogger(__name__)

COOLDOWN_SECONDS = 65


def get_optimal_key(exclude_ids: list[str] | None = None) -> GeminiApiKey | None:
    """
    Pick the best available key using round-robin (least-recently-used first).
    Automatically recovers keys whose cooldown has expired.
    Falls back to env key if no DB keys exist.
    """
    now = datetime.now(timezone.utc)
    exclude_ids = exclude_ids or []

    _recover_cooldown_keys(now)

    query = GeminiApiKey.query.filter(
        GeminiApiKey.status == "active",
        ~GeminiApiKey.id.in_(exclude_ids),
    ).order_by(
        GeminiApiKey.last_used_at.asc().nullsfirst()
    )

    return query.first()


def get_all_active_keys() -> list[GeminiApiKey]:
    now = datetime.now(timezone.utc)
    _recover_cooldown_keys(now)
    return GeminiApiKey.query.filter(GeminiApiKey.status != "disabled").all()


def _recover_cooldown_keys(now: datetime) -> None:
    """Recover keys that have been in cooldown long enough."""
    expired = GeminiApiKey.query.filter(
        GeminiApiKey.status == "cooldown",
        GeminiApiKey.cooldown_until <= now,
    ).all()
    for k in expired:
        k.status = "active"
        k.cooldown_until = None
        logger.info("Key %s recovered from cooldown", k.masked_key())
    if expired:
        db.session.commit()


def record_success(
    key_id: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    model_stats: dict | None = None,
) -> None:
    """Record a successful API call with per-model breakdown.

    model_stats: {model_name: {requests, input_tokens, output_tokens}, ...}

    Also bumps the per-day counter (Pacific Time) so we can show 'today vs RPD'
    and historical usage charts.
    """
    key = GeminiApiKey.query.get(key_id)
    if not key:
        return
    key.usage_count += 1
    key.total_input_tokens += input_tokens
    key.total_output_tokens += output_tokens
    key.last_used_at = datetime.now(timezone.utc)
    key.last_error = ""
    if model_stats:
        for model_name, stats in model_stats.items():
            in_tok = int(stats.get("input_tokens", 0) or 0)
            out_tok = int(stats.get("output_tokens", 0) or 0)
            key.add_model_usage(model_name, in_tok, out_tok)
            bump_daily_usage(key_id, model_name, in_tok, out_tok)
    db.session.commit()


def record_error(key_id: str, error_msg: str, is_rate_limit: bool = False) -> None:
    """Record a failed API call. Cooldown on rate-limit errors."""
    key = GeminiApiKey.query.get(key_id)
    if not key:
        return
    key.error_count += 1
    key.last_error = error_msg[:500]
    key.last_used_at = datetime.now(timezone.utc)
    if is_rate_limit:
        key.status = "cooldown"
        key.cooldown_until = datetime.now(timezone.utc) + timedelta(seconds=COOLDOWN_SECONDS)
        logger.warning("Key %s moved to cooldown for %ds", key.masked_key(), COOLDOWN_SECONDS)
    db.session.commit()


def get_pool_summary() -> dict:
    """Return aggregate stats across all keys, including per-model breakdown.

    Per-model breakdown also includes 'requestsToday' (sum across all keys for
    the current Pacific Time day) so the UI can show 'X/RPD today'.
    """
    from app.features.api_keys.models import MODEL_LIMITS

    keys = GeminiApiKey.query.all()
    active = sum(1 for k in keys if k.status == "active")
    cooldown = sum(1 for k in keys if k.status == "cooldown")
    disabled = sum(1 for k in keys if k.status == "disabled")
    total_input = sum(k.total_input_tokens for k in keys)
    total_output = sum(k.total_output_tokens for k in keys)
    total_usage = sum(k.usage_count for k in keys)
    total_errors = sum(k.error_count for k in keys)

    # Aggregate per-model usage across all keys (lifetime)
    model_totals: dict[str, dict] = {}
    for k in keys:
        for model_name, stats in k.get_model_usage().items():
            if model_name not in model_totals:
                model_totals[model_name] = {"requests": 0, "input_tokens": 0, "output_tokens": 0}
            model_totals[model_name]["requests"] += stats.get("requests", 0)
            model_totals[model_name]["input_tokens"] += stats.get("input_tokens", 0)
            model_totals[model_name]["output_tokens"] += stats.get("output_tokens", 0)

    # Today's usage (Pacific Time) per model, summed across all keys
    today = today_pst()
    today_rows = GeminiApiKeyDailyUsage.query.filter_by(date_pst=today).all()
    today_totals: dict[str, dict] = {}
    for row in today_rows:
        bucket = today_totals.setdefault(
            row.model, {"requests": 0, "input_tokens": 0, "output_tokens": 0}
        )
        bucket["requests"] += row.requests
        bucket["input_tokens"] += row.input_tokens
        bucket["output_tokens"] += row.output_tokens

    model_usage_list = []
    all_models = set(model_totals.keys()) | set(MODEL_LIMITS.keys())
    for name in sorted(all_models):
        stats = model_totals.get(name, {"requests": 0, "input_tokens": 0, "output_tokens": 0})
        today_stats = today_totals.get(name, {"requests": 0, "input_tokens": 0, "output_tokens": 0})
        limits = MODEL_LIMITS.get(name, {})
        in_tok = stats["input_tokens"]
        out_tok = stats["output_tokens"]
        model_usage_list.append({
            "model": name,
            "displayName": limits.get("displayName", name),
            "requests": stats["requests"],
            "inputTokens": in_tok,
            "outputTokens": out_tok,
            "totalTokens": in_tok + out_tok,
            "requestsToday": today_stats["requests"],
            "inputTokensToday": today_stats["input_tokens"],
            "outputTokensToday": today_stats["output_tokens"],
            "limits": {
                "rpd": limits.get("rpd", 0),
                "rpm": limits.get("rpm", 0),
                "tpm": limits.get("tpm", 0),
                "tier": limits.get("tier", "unknown"),
            } if limits else None,
        })

    return {
        "totalKeys": len(keys),
        "activeKeys": active,
        "cooldownKeys": cooldown,
        "disabledKeys": disabled,
        "totalInputTokens": total_input,
        "totalOutputTokens": total_output,
        "totalTokens": total_input + total_output,
        "totalUsage": total_usage,
        "totalErrors": total_errors,
        "modelUsage": model_usage_list,
        "datePst": today.isoformat(),
    }
