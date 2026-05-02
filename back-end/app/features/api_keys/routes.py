"""
API Keys feature - Routes for managing Gemini API keys.

Endpoints:
  GET    /api/keys           - List all keys (masked) + pool summary
  POST   /api/keys           - Add a new key
  PUT    /api/keys/<id>      - Update key label or toggle status
  DELETE /api/keys/<id>      - Remove a key
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

logger = logging.getLogger(__name__)

api_keys_bp = Blueprint("api_keys", __name__)


@api_keys_bp.route("/", methods=["GET"])
def list_keys():
    keys = GeminiApiKey.query.order_by(GeminiApiKey.created_at.asc()).all()
    return jsonify({
        "keys": [k.to_dict() for k in keys],
        "summary": get_pool_summary(),
    })


@api_keys_bp.route("/", methods=["POST"])
def add_key():
    data = request.json
    if not data or not data.get("key", "").strip():
        return jsonify({"error": "API key is required"}), 400

    raw_key = data["key"].strip()

    existing = GeminiApiKey.query.filter_by(key_hash=hash_key(raw_key)).first()
    if existing:
        return jsonify({"error": "This key already exists"}), 409

    new_key = GeminiApiKey(
        id=str(uuid.uuid4()),
        key=raw_key,
        label=(data.get("label") or "").strip(),
        status="active",
    )
    db.session.add(new_key)
    db.session.commit()
    logger.info("Added new Gemini API key: %s", new_key.masked_key())
    return jsonify(new_key.to_dict()), 201


@api_keys_bp.route("/<key_id>", methods=["PUT"])
def update_key(key_id: str):
    key = GeminiApiKey.query.get(key_id)
    if not key:
        return jsonify({"error": "Key not found"}), 404

    data = request.json or {}
    if "label" in data:
        key.label = data["label"].strip()
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
