"""
Key verification and model-catalogue refresh.

Verification doubles as catalogue discovery: every provider authenticates a key
through its `/models` listing, so a successful check hands back the model list
for free. Caching it there is what keeps the fallback chain current without a
scheduled job.
"""
from __future__ import annotations

import logging

from app.features.llm.models import replace_cached_models
from app.features.llm.providers import adapter_for
from app.features.llm.registry import get_spec
from app.features.llm.types import ModelInfo, VerifyResult

logger = logging.getLogger(__name__)


def check_format(provider: str, raw_key: str) -> VerifyResult | None:
    """Catch paste errors without a network round-trip. None means "looks fine".

    These verdicts carry reached_provider=False: the rejection is ours, not the
    provider's.
    """
    spec = get_spec(provider)
    if not raw_key:
        return VerifyResult(False, "empty", "API key is required", reached_provider=False)
    if any(ch.isspace() for ch in raw_key):
        return VerifyResult(
            False, "invalid_format",
            "API key must not contain spaces or line breaks",
            reached_provider=False,
        )
    if spec.key_pattern is not None and not spec.key_pattern.match(raw_key):
        return VerifyResult(
            False, "invalid_format",
            f"This does not look like a {spec.display_name} API key"
            + (f" — expected it to start with '{spec.key_hint}'" if spec.key_hint else ""),
            reached_provider=False,
        )
    return None


def verify_key(provider: str, raw_key: str, cache_models: bool = True) -> VerifyResult:
    """Check a key against its provider and refresh that provider's model cache."""
    spec = get_spec(provider)

    fmt = check_format(spec.id, raw_key)
    if fmt is not None:
        return fmt

    verdict = adapter_for(spec.id).verify(raw_key, spec.base_url)

    if cache_models and verdict.ok and verdict.models:
        try:
            kept = replace_cached_models(spec.id, _enrich(spec.id, verdict.models))
            logger.info("Cached %d model(s) for %s", kept, spec.id)
        except Exception as exc:
            logger.warning("Could not cache %s models: %s", spec.id, exc)

    return verdict


def refresh_models(provider: str, raw_key: str) -> list[ModelInfo]:
    """Re-fetch a provider's catalogue with a known-good key."""
    spec = get_spec(provider)
    models = _enrich(spec.id, adapter_for(spec.id).list_models(raw_key, spec.base_url))
    replace_cached_models(spec.id, models)
    return models


def _enrich(provider: str, models: list[ModelInfo]) -> list[ModelInfo]:
    """Attach the published free-tier limits we know statically (Gemini only)."""
    from app.features.api_keys.models import MODEL_LIMITS

    if provider != "gemini":
        return models

    enriched: list[ModelInfo] = []
    for info in models:
        limits = MODEL_LIMITS.get(info.model)
        if not limits:
            enriched.append(info)
            continue
        enriched.append(ModelInfo(
            model=info.model,
            display_name=limits.get("displayName", info.display_name),
            rank=info.rank,
            rpd=limits.get("rpd", 0),
            rpm=limits.get("rpm", 0),
            tpm=limits.get("tpm", 0),
            tier=limits.get("tier", "free"),
        ))
    return enriched
