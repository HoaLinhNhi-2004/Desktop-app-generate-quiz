"""
API Keys feature - Routes for managing Gemini API keys.

Endpoints:
  GET    /api/keys              - List all keys (masked) + pool summary
  POST   /api/keys              - Add a new key (verified against Google first)
  POST   /api/keys/<id>/verify  - Re-check an existing key against Google
  PUT    /api/keys/<id>         - Update key label or toggle status
  DELETE /api/keys/<id>         - Remove a key
"""
import uuid
import logging
from datetime import timedelta
from flask import Blueprint, request, jsonify

from app.db import db
from app.features.api_keys.models import (
    GeminiApiKey,
    GeminiApiKeyDailyUsage,
    hash_key,
    today_pst,
)
from app.features.api_keys.key_manager import get_pool_summary
from app.features.api_keys.verifier import verify_key

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


@api_keys_bp.route("/", methods=["GET"])
def list_keys():
    keys = GeminiApiKey.query.order_by(GeminiApiKey.created_at.asc()).all()
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

    existing = GeminiApiKey.query.filter_by(key_hash=hash_key(raw_key)).first()
    if existing:
        return jsonify({
            "error": "This key already exists",
            "code": "duplicate",
            "existingLabel": existing.label or "",
        }), 409

    # Verified before insert: an unusable key would otherwise be stored as
    # `active` and — being the least-recently-used — picked first by the very
    # next generate call.
    verdict = verify_key(raw_key)
    if not verdict.ok:
        logger.info("Rejected new Gemini API key (%s): %s", verdict.code, verdict.message)
        return jsonify({
            "error": verdict.message,
            "code": verdict.code,
            "verification": verdict.to_dict(),
        }), 400

    new_key = GeminiApiKey(
        id=str(uuid.uuid4()),
        key=raw_key,
        label=_clean_str(data.get("label")),
        status="active",
    )
    db.session.add(new_key)
    db.session.commit()
    logger.info(
        "Added new Gemini API key: %s (verification: %s)",
        new_key.masked_key(), verdict.code,
    )
    return jsonify({**new_key.to_dict(), "verification": verdict.to_dict()}), 201


@api_keys_bp.route("/<key_id>/verify", methods=["POST"])
def verify_existing_key(key_id: str):
    """Re-check a stored key against Google.

    A key revoked in the Google console still looks `active` here until a
    generate call fails, so this gives the user a way to find dead keys without
    burning a quiz generation on them. A confirmed rejection disables the key so
    it leaves the rotation pool immediately.
    """
    key = GeminiApiKey.query.get(key_id)
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
                "reachedGoogle": False,
            },
        }), 200

    verdict = verify_key(raw_key)
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
    key = GeminiApiKey.query.get(key_id)
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
    """Return available Gemini models with their free-tier rate limits."""
    from app.features.api_keys.models import MODEL_LIMITS
    models = []
    for name, info in MODEL_LIMITS.items():
        models.append({
            "model": name,
            "displayName": info["displayName"],
            "rpd": info["rpd"],
            "rpm": info["rpm"],
            "tpm": info["tpm"],
            "tier": info["tier"],
        })
    return jsonify(models)


@api_keys_bp.route("/<key_id>", methods=["DELETE"])
def delete_key(key_id: str):
    key = GeminiApiKey.query.get(key_id)
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
    key = GeminiApiKey.query.get(key_id)
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
