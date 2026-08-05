"""
The single entry point every feature uses to talk to an LLM.

Two layers, split by what they are allowed to touch:

  - `select_credential()` reads the DB (key pool, default provider, cached model
    catalogue) and must run inside a Flask app context.
  - `generate_with_fallback()` / `stream_with_fallback()` / `vision_with_fallback()`
    take that credential and are pure network calls, safe to run from the
    `ThreadPoolExecutor` workers the quiz pipeline spawns.

That split is deliberate: quiz generation fans chunks out across threads that
have no app context, so anything reaching for `db` in the hot path would fail
there and only there.
"""
from __future__ import annotations

import logging
import time

from app.features.llm.providers import adapter_for
from app.features.llm.registry import FALLBACK_ORDER, get_spec, is_known
from app.features.llm.types import (
    AllModelsExhaustedError,
    ContentBlockedError,
    LlmCredential,
    LlmResult,
    NoCredentialError,
)

logger = logging.getLogger(__name__)

#: Gemini's free tier resets per-minute quota after 60s; one wait covers all providers.
RPM_WAIT_SECONDS = 65


# ---------------------------------------------------------------------------
# Credential selection (needs an app context)
# ---------------------------------------------------------------------------

def candidate_providers(preferred: str | None = None, require_vision: bool = False) -> list[str]:
    """Providers to try, best first.

    The user's default comes first; the rest follow only when cross-provider
    fallback is on, so a paid provider is never charged silently because the
    free one ran out of quota.
    """
    from app.features.llm.models import get_default_provider, is_cross_provider_fallback_enabled

    head = preferred if (preferred and is_known(preferred)) else get_default_provider()
    order = [head]
    if preferred is None and is_cross_provider_fallback_enabled():
        order += [p for p in FALLBACK_ORDER if p != head]
    return [p for p in order if not require_vision or get_spec(p).supports_vision]


def select_credential(
    provider: str | None = None,
    exclude_key_ids: list[str] | None = None,
    require_vision: bool = False,
) -> LlmCredential | None:
    """Pick the least-recently-used active key, walking providers in preference order."""
    from app.features.api_keys.key_manager import get_optimal_key
    from app.features.llm.models import resolve_model_chain

    skip = list(exclude_key_ids or [])

    for candidate in candidate_providers(provider, require_vision):
        chain = resolve_model_chain(candidate)
        if not chain:
            logger.warning("Provider %s has no usable model — skipping", candidate)
            continue

        while True:
            key = get_optimal_key(provider=candidate, exclude_ids=skip)
            if key is None:
                break
            plaintext = key.key
            if not plaintext:
                # Decryption failed — the key was stored under a different
                # SECRET_KEY (another machine, or a rotated secret). Handing back
                # an empty string here would surface as a baffling "no API key"
                # from the provider SDK, far from the real cause.
                logger.warning(
                    "Skipping key %s (%s): stored value could not be decrypted on this machine",
                    key.id, candidate,
                )
                skip.append(key.id)
                continue
            return LlmCredential(
                provider=candidate,
                api_key=plaintext,
                key_id=key.id,
                model_chain=chain,
                base_url=get_spec(candidate).base_url,
            )
    return None


def require_credential(provider: str | None = None, require_vision: bool = False) -> LlmCredential:
    cred = select_credential(provider=provider, require_vision=require_vision)
    if cred is None:
        raise NoCredentialError(
            "Chưa có API key khả dụng. Vào Settings > API Keys để thêm key "
            "(Gemini, Claude, OpenAI, DeepSeek, Groq, xAI, Mistral hoặc OpenRouter)."
        )
    return cred


def record_usage(cred: LlmCredential, input_tokens: int, output_tokens: int,
                 model_stats: dict | None = None) -> None:
    """Attribute a successful call back to its key. Needs an app context."""
    from app.features.api_keys.key_manager import record_success

    try:
        record_success(cred.key_id, input_tokens, output_tokens, model_stats=model_stats)
    except Exception as exc:  # usage tracking must never fail a generation
        logger.warning("Could not track key usage: %s", exc)


def record_failure(cred: LlmCredential, message: str, is_rate_limit: bool = False) -> None:
    from app.features.api_keys.key_manager import record_error

    try:
        record_error(cred.key_id, message[:500], is_rate_limit=is_rate_limit)
    except Exception as exc:
        logger.warning("Could not record key error: %s", exc)


# ---------------------------------------------------------------------------
# Calls with model-chain fallback (no app context required)
# ---------------------------------------------------------------------------

def _classify(cred: LlmCredential, exc: Exception) -> tuple[bool, bool, bool]:
    """(is_quota_error, is_per_minute, is_per_day) for one provider exception."""
    adapter = adapter_for(cred.provider)
    is_429 = bool(adapter.is_rate_limit(exc))
    text = str(exc).lower()
    is_rpm = any(kw in text for kw in ("per minute", "rpm", "rate limit", "minute"))
    is_rpd = any(kw in text for kw in ("per day", "rpd", "daily", "quota"))
    return is_429, is_rpm, is_rpd


def _is_content_block(exc: Exception) -> bool:
    """A safety/recitation refusal — worth retrying on the next model, not fatal."""
    from app.features.llm.providers.anthropic_provider import RefusalError

    return isinstance(exc, (RefusalError, ContentBlockedError))


#: A listed model is not always a callable one — Gemini still advertises models
#: it has closed to new accounts, and OpenRouter lists models a given key cannot
#: reach. Treat that as a reason to try the next model, not as a hard failure.
_UNAVAILABLE_MARKERS = (
    "no longer available",
    "model_not_found",
    "does not exist",
    "is not found",
    "was not found",
    "unknown model",
    "invalid model",
)


def _is_model_unavailable(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(marker in text for marker in _UNAVAILABLE_MARKERS)


def _should_try_next_model(exc: Exception) -> bool:
    return _is_content_block(exc) or _is_model_unavailable(exc)


def _notify(on_notice, code: str, data: dict) -> None:
    if on_notice is None:
        return
    try:
        on_notice(code, data)
    except Exception:
        pass


def generate_with_fallback(
    cred: LlmCredential,
    prompt: str,
    *,
    max_output_tokens: int = 16_384,
    temperature: float = 0.3,
    on_notice=None,
) -> LlmResult:
    """Blocking call, walking `cred.model_chain` until one model answers.

    Quota errors move to the next model (after a single per-minute retry); any
    other error is raised straight away, because retrying a bad prompt or a
    revoked key on three models just triples the latency of the failure.
    """
    adapter = adapter_for(cred.provider)
    last_err: Exception | None = None

    for index, model in enumerate(cred.model_chain):
        rpm_retried = False
        while True:
            try:
                logger.info("Calling %s model: %s", cred.provider, model)
                result = adapter.complete(
                    cred.api_key, cred.base_url, model, prompt,
                    max_output_tokens=max_output_tokens, temperature=temperature,
                )
                logger.info("%s %s response: %d chars", cred.provider, model, len(result.text))
                return result
            except Exception as exc:  # noqa: BLE001 — classified immediately below
                if _should_try_next_model(exc):
                    logger.warning("%s produced no usable answer (%s) — trying next model",
                                   model, str(exc)[:140])
                    last_err = exc
                    break

                is_429, is_rpm, is_rpd = _classify(cred, exc)
                if not is_429:
                    raise
                last_err = exc

                if is_rpm and not rpm_retried:
                    logger.warning("Model %s hit a per-minute limit. Waiting %ds…",
                                   model, RPM_WAIT_SECONDS)
                    _notify(on_notice, "rpmWait",
                            {"model": model, "retryInSeconds": RPM_WAIT_SECONDS})
                    time.sleep(RPM_WAIT_SECONDS)
                    rpm_retried = True
                    continue

                logger.warning("Model %s %s limit hit — trying next model (%s)",
                               model, "daily" if is_rpd else "quota", str(exc)[:120])
                if index + 1 < len(cred.model_chain):
                    _notify(on_notice, "modelFallback",
                            {"from": model, "to": cred.model_chain[index + 1]})
                break

    raise AllModelsExhaustedError(
        f"All {cred.provider} models exhausted (tried: {', '.join(cred.model_chain)}). "
        f"Last error: {last_err}"
    )


def stream_with_fallback(
    cred: LlmCredential,
    prompt: str,
    *,
    on_text,
    max_output_tokens: int = 16_384,
    temperature: float = 0.3,
    on_notice=None,
    stop_event=None,
) -> LlmResult:
    """Streaming twin of `generate_with_fallback`, same fallback semantics.

    `stop_event` lets a caller abandon a stream (and any pending per-minute
    wait) the moment another chunk has already filled the question quota.
    """
    adapter = adapter_for(cred.provider)
    last_err: Exception | None = None

    for index, model in enumerate(cred.model_chain):
        rpm_retried = False
        while True:
            try:
                logger.info("Streaming from %s model: %s", cred.provider, model)
                result = adapter.stream(
                    cred.api_key, cred.base_url, model, prompt,
                    on_text=on_text,
                    max_output_tokens=max_output_tokens,
                    temperature=temperature,
                    stop_event=stop_event,
                )
                logger.info("%s %s stream: %d chars", cred.provider, model, len(result.text))
                return result
            except Exception as exc:  # noqa: BLE001 — classified immediately below
                if _should_try_next_model(exc):
                    logger.warning("%s produced no usable answer (%s) — trying next model",
                                   model, str(exc)[:140])
                    last_err = exc
                    break

                is_429, is_rpm, is_rpd = _classify(cred, exc)
                if not is_429:
                    raise
                last_err = exc

                if is_rpm and not rpm_retried:
                    if stop_event is not None and stop_event.is_set():
                        return LlmResult("", cred.provider, model)
                    logger.warning("Model %s hit a per-minute limit. Waiting %ds…",
                                   model, RPM_WAIT_SECONDS)
                    _notify(on_notice, "rpmWait",
                            {"model": model, "retryInSeconds": RPM_WAIT_SECONDS})
                    # Interruptible: when another chunk fills the quota mid-wait the
                    # job has to end now, not 65s later — the client keeps the run
                    # marked in-progress until this call returns.
                    if stop_event is not None:
                        if stop_event.wait(RPM_WAIT_SECONDS):
                            return LlmResult("", cred.provider, model)
                    else:
                        time.sleep(RPM_WAIT_SECONDS)
                    rpm_retried = True
                    continue

                logger.warning("Model %s %s limit hit — trying next model (%s)",
                               model, "daily" if is_rpd else "quota", str(exc)[:120])
                if index + 1 < len(cred.model_chain):
                    _notify(on_notice, "modelFallback",
                            {"from": model, "to": cred.model_chain[index + 1]})
                break

    raise AllModelsExhaustedError(
        f"All {cred.provider} models exhausted (tried: {', '.join(cred.model_chain)}). "
        f"Last error: {last_err}"
    )


def vision_with_fallback(
    cred: LlmCredential,
    prompt: str,
    image_b64: str,
    mime_type: str,
    *,
    max_output_tokens: int = 8_192,
) -> LlmResult:
    adapter = adapter_for(cred.provider)
    last_err: Exception | None = None

    for model in cred.model_chain:
        try:
            return adapter.vision(
                cred.api_key, cred.base_url, model, prompt, image_b64, mime_type,
                max_output_tokens=max_output_tokens,
            )
        except Exception as exc:  # noqa: BLE001 — classified immediately below
            is_429, _, _ = _classify(cred, exc)
            if not is_429 and not _should_try_next_model(exc):
                raise
            last_err = exc
            logger.warning("%s vision on %s failed (%s) — trying next model",
                           cred.provider, model, str(exc)[:120])

    raise AllModelsExhaustedError(
        f"All {cred.provider} models exhausted for vision "
        f"(tried: {', '.join(cred.model_chain)}). Last error: {last_err}"
    )
