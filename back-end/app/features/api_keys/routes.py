"""
API Keys feature - Routes for managing the multi-provider LLM key pool.

Endpoints:
  GET    /api/keys                              - List all keys (masked) + pool summary
  POST   /api/keys                              - Add a key (verified with its provider first)
  POST   /api/keys/<id>/verify                  - Re-check a stored key with its provider
  PUT    /api/keys/<id>                         - Update key label or toggle status
  DELETE /api/keys/<id>                         - Remove a key
  GET    /api/keys/providers                    - Supported providers + how many keys each has
  POST   /api/keys/providers/<p>/models/refresh - Re-fetch that provider's model catalogue
  GET    /api/keys/models                       - Known models (optionally ?provider=)
  GET    /api/keys/settings                     - Default provider, fallback flag, model chains
  PUT    /api/keys/settings                     - Update the above
"""
import uuid
import logging
from datetime import timedelta
from flask import Blueprint, request, jsonify

from app.db import db
from app.features.api_keys.models import (
    ApiKey,
    GeminiApiKeyDailyUsage,
    hash_key,
    today_pst,
)
from app.features.api_keys.key_manager import get_pool_summary
from app.features.llm import models as llm_models
from app.features.llm.catalog import refresh_models, verify_key
from app.features.llm.registry import DEFAULT_PROVIDER, PROVIDERS, is_known

logger = logging.getLogger(__name__)

api_keys_bp = Blueprint("api_keys", __name__)


def _json_body() -> dict:
    """Request body as a dict, tolerating a missing/incorrect Content-Type.

    `request.json` raises (415/400 -> HTML error page) when the header is absent
    or the body is empty, which the client can only report as a generic failure.
    """
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _clean_str(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _resolve_provider(value: object) -> str | None:
    """Normalise a request's provider field. None means "unrecognised"."""
    provider = _clean_str(value).lower() or DEFAULT_PROVIDER
    return provider if is_known(provider) else None


@api_keys_bp.route("/", methods=["GET"])
def list_keys():
    query = ApiKey.query
    provider = request.args.get("provider")
    if provider:
        query = query.filter(ApiKey.provider == provider)
    keys = query.order_by(ApiKey.created_at.asc()).all()
    return jsonify({
        "keys": [k.to_dict() for k in keys],
        "summary": get_pool_summary(),
    })


@api_keys_bp.route("/", methods=["POST"])
def add_key():
    data = _json_body()
    raw_key = _clean_str(data.get("key"))
    if not raw_key:
        return jsonify({"error": "API key is required", "code": "empty"}), 400

    provider = _resolve_provider(data.get("provider"))
    if provider is None:
        return jsonify({
            "error": f"Unknown provider: {_clean_str(data.get('provider'))}",
            "code": "unknown_provider",
        }), 400

    existing = ApiKey.query.filter_by(key_hash=hash_key(raw_key)).first()
    if existing:
        return jsonify({
            "error": "This key already exists",
            "code": "duplicate",
            "existingLabel": existing.label or "",
            "existingProvider": existing.provider,
        }), 409

    # Verified before insert: an unusable key would otherwise be stored as
    # `active` and — being the least-recently-used — picked first by the very
    # next generate call.
    verdict = verify_key(provider, raw_key)
    if not verdict.ok:
        logger.info("Rejected new %s API key (%s): %s", provider, verdict.code, verdict.message)
        return jsonify({
            "error": verdict.message,
            "code": verdict.code,
            "verification": verdict.to_dict(),
        }), 400

    new_key = ApiKey(
        id=str(uuid.uuid4()),
        provider=provider,
        key=raw_key,
        label=_clean_str(data.get("label")),
        status="active",
    )
    db.session.add(new_key)
    db.session.commit()
    logger.info(
        "Added new %s API key: %s (verification: %s)",
        provider, new_key.masked_key(), verdict.code,
    )
    return jsonify({**new_key.to_dict(), "verification": verdict.to_dict()}), 201


@api_keys_bp.route("/<key_id>/verify", methods=["POST"])
def verify_existing_key(key_id: str):
    """Re-check a stored key with its provider.

    A key revoked in the provider's console still looks `active` here until a
    generate call fails, so this gives the user a way to find dead keys without
    burning a quiz generation on them. A confirmed rejection disables the key so
    it leaves the rotation pool immediately.
    """
    key = db.session.get(ApiKey, key_id)
    if not key:
        return jsonify({"error": "Key not found", "code": "not_found"}), 404

    raw_key = key.key
    if not raw_key:
        return jsonify({
            "error": "Stored key could not be decrypted on this machine",
            "code": "decrypt_failed",
            "verification": {
                "ok": False, "code": "decrypt_failed",
                "message": "Stored key could not be decrypted on this machine",
                "reachedProvider": False,
                "reachedGoogle": False,
            },
        }), 200

    verdict = verify_key(key.provider or DEFAULT_PROVIDER, raw_key)
    if not verdict.ok:
        key.status = "disabled"
        key.last_error = verdict.message[:500]
        db.session.commit()
        logger.info("Key %s disabled after failed verify (%s)", key.masked_key(), verdict.code)
    elif verdict.code == "valid" and key.status == "disabled":
        key.status = "active"
        key.last_error = ""
        db.session.commit()

    return jsonify({**key.to_dict(), "verification": verdict.to_dict()}), 200


@api_keys_bp.route("/<key_id>", methods=["PUT"])
def update_key(key_id: str):
    key = db.session.get(ApiKey, key_id)
    if not key:
        return jsonify({"error": "Key not found"}), 404

    data = _json_body()
    if "label" in data:
        key.label = _clean_str(data["label"])
    if "status" in data and data["status"] in ("active", "disabled"):
        key.status = data["status"]
        if data["status"] == "active":
            key.cooldown_until = None

    db.session.commit()
    return jsonify(key.to_dict())


@api_keys_bp.route("/models", methods=["GET"])
def list_models():
    """Models known for a provider (or every provider that has a key).

    Sourced from the cached catalogue fetched when a key was last verified, so
    a newly released model shows up without a code change.
    """
    requested = request.args.get("provider")
    if requested:
        if not is_known(requested):
            return jsonify({"error": f"Unknown provider: {requested}", "code": "unknown_provider"}), 400
        providers = [requested]
    else:
        providers = sorted({k.provider or DEFAULT_PROVIDER for k in ApiKey.query.all()}) or [DEFAULT_PROVIDER]

    models = []
    for provider in providers:
        rows = llm_models.cached_models(provider)
        if rows:
            models.extend(row.to_dict() for row in rows)
            continue
        # No catalogue yet (key never verified against this provider) — show the
        # registry defaults so the chain the app would actually use is visible.
        for name in PROVIDERS[provider].default_models:
            models.append({
                "provider": provider, "model": name, "displayName": name,
                "rank": 0, "rpd": 0, "rpm": 0, "tpm": 0, "tier": "unknown",
                "fetchedAt": None,
            })
    return jsonify(models)


@api_keys_bp.route("/providers", methods=["GET"])
def list_providers():
    """Every supported provider, with how many keys the user holds for each."""
    keys = ApiKey.query.all()
    counts: dict[str, dict] = {}
    for k in keys:
        bucket = counts.setdefault(k.provider or DEFAULT_PROVIDER, {"total": 0, "active": 0})
        bucket["total"] += 1
        bucket["active"] += 1 if k.status == "active" else 0

    default_provider = llm_models.get_default_provider()
    payload = []
    for spec in PROVIDERS.values():
        stats = counts.get(spec.id, {"total": 0, "active": 0})
        payload.append({
            "id": spec.id,
            "displayName": spec.display_name,
            "dialect": spec.dialect,
            "keyHint": spec.key_hint,
            "consoleUrl": spec.console_url,
            "supportsVision": spec.supports_vision,
            "freeTier": spec.free_tier,
            "defaultModels": list(spec.default_models),
            "modelChain": llm_models.resolve_model_chain(spec.id),
            "modelChainOverride": llm_models.get_model_chain_override(spec.id),
            "cachedModelCount": len(llm_models.cached_models(spec.id)),
            "totalKeys": stats["total"],
            "activeKeys": stats["active"],
            "isDefault": spec.id == default_provider,
        })
    return jsonify({
        "providers": payload,
        "defaultProvider": default_provider,
        "crossProviderFallback": llm_models.is_cross_provider_fallback_enabled(),
    })


@api_keys_bp.route("/providers/<provider>/models/refresh", methods=["POST"])
def refresh_provider_models(provider: str):
    """Re-fetch a provider's model catalogue using one of its stored keys."""
    if not is_known(provider):
        return jsonify({"error": f"Unknown provider: {provider}", "code": "unknown_provider"}), 400

    key = (
        ApiKey.query
        .filter(ApiKey.provider == provider, ApiKey.status != "disabled")
        .order_by(ApiKey.created_at.asc())
        .first()
    )
    if not key or not key.key:
        return jsonify({
            "error": "Add a key for this provider before refreshing its model list",
            "code": "no_key",
        }), 400

    try:
        models = refresh_models(provider, key.key)
    except Exception as exc:  # noqa: BLE001 — surfaced to the user verbatim
        logger.warning("Model refresh failed for %s: %s", provider, exc)
        return jsonify({"error": str(exc)[:300], "code": "refresh_failed"}), 502

    return jsonify({
        "provider": provider,
        "count": len(models),
        "models": [m.to_dict() for m in models],
        "modelChain": llm_models.resolve_model_chain(provider),
    })


@api_keys_bp.route("/settings", methods=["GET"])
def get_llm_settings():
    return jsonify({
        "defaultProvider": llm_models.get_default_provider(),
        "crossProviderFallback": llm_models.is_cross_provider_fallback_enabled(),
        "modelChains": {
            spec.id: llm_models.get_model_chain_override(spec.id)
            for spec in PROVIDERS.values()
        },
    })


@api_keys_bp.route("/settings", methods=["PUT"])
def update_llm_settings():
    data = _json_body()

    if "defaultProvider" in data:
        provider = _resolve_provider(data["defaultProvider"])
        if provider is None:
            return jsonify({
                "error": f"Unknown provider: {_clean_str(data['defaultProvider'])}",
                "code": "unknown_provider",
            }), 400
        llm_models.set_default_provider(provider)

    if "crossProviderFallback" in data:
        llm_models.set_cross_provider_fallback(bool(data["crossProviderFallback"]))

    chains = data.get("modelChains")
    if isinstance(chains, dict):
        for provider, models in chains.items():
            if not is_known(provider) or not isinstance(models, list):
                continue
            llm_models.set_model_chain_override(provider, models)

    return get_llm_settings()


@api_keys_bp.route("/<key_id>", methods=["DELETE"])
def delete_key(key_id: str):
    key = db.session.get(ApiKey, key_id)
    if not key:
        return jsonify({"error": "Key not found"}), 404

    db.session.delete(key)
    db.session.commit()
    logger.info("Deleted Gemini API key: %s", key.masked_key())
    return jsonify({"message": "Key deleted"}), 200


@api_keys_bp.route("/<key_id>/usage-history", methods=["GET"])
def key_usage_history(key_id: str):
    """Per-day usage for one key. Returns up to ?days=N (default 30, max 365) days
    going back from today (Pacific Time). Each entry covers one (model, datePst).
    Days with no activity are NOT included — UI can fill gaps if it wants a chart.
    """
    key = db.session.get(ApiKey, key_id)
    if not key:
        return jsonify({"error": "Key not found"}), 404

    try:
        days = int(request.args.get("days", "30"))
    except (TypeError, ValueError):
        days = 30
    days = max(1, min(days, 365))

    today = today_pst()
    start_date = today - timedelta(days=days - 1)

    rows = (
        GeminiApiKeyDailyUsage.query
        .filter(
            GeminiApiKeyDailyUsage.key_id == key_id,
            GeminiApiKeyDailyUsage.date_pst >= start_date,
        )
        .order_by(GeminiApiKeyDailyUsage.date_pst.asc())
        .all()
    )

    return jsonify({
        "keyId": key_id,
        "days": days,
        "startDatePst": start_date.isoformat(),
        "endDatePst": today.isoformat(),
        "entries": [r.to_dict() for r in rows],
    })


@api_keys_bp.route("/usage-history", methods=["GET"])
def pool_usage_history():
    """Per-day usage aggregated across ALL keys, grouped by (model, datePst)."""
    try:
        days = int(request.args.get("days", "30"))
    except (TypeError, ValueError):
        days = 30
    days = max(1, min(days, 365))

    today = today_pst()
    start_date = today - timedelta(days=days - 1)

    rows = (
        GeminiApiKeyDailyUsage.query
        .filter(GeminiApiKeyDailyUsage.date_pst >= start_date)
        .all()
    )

    aggregated: dict[tuple[str, str], dict] = {}
    for r in rows:
        bucket_key = (r.date_pst.isoformat(), r.model)
        bucket = aggregated.setdefault(
            bucket_key,
            {
                "datePst": r.date_pst.isoformat(),
                "provider": r.provider or DEFAULT_PROVIDER,
                "model": r.model,
                "requests": 0,
                "inputTokens": 0,
                "outputTokens": 0,
            },
        )
        bucket["requests"] += r.requests
        bucket["inputTokens"] += r.input_tokens
        bucket["outputTokens"] += r.output_tokens

    entries = sorted(
        aggregated.values(),
        key=lambda e: (e["datePst"], e["model"]),
    )
    for e in entries:
        e["totalTokens"] = e["inputTokens"] + e["outputTokens"]

    return jsonify({
        "days": days,
        "startDatePst": start_date.isoformat(),
        "endDatePst": today.isoformat(),
        "entries": entries,
    })
