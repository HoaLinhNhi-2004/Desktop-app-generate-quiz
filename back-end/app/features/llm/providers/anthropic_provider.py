"""
Anthropic Claude adapter (official `anthropic` SDK).

Two things drive the shape of this module:

  - **Everything streams**, including `complete()`. Claude models allow very
    large `max_tokens`, and a non-streaming request at that size hits the SDK's
    HTTP timeout; `messages.stream(...).get_final_message()` gives the same
    return value without that risk.
  - **No sampling parameters are sent.** `temperature` / `top_p` / `top_k` are
    rejected outright by Claude Opus 5, Opus 4.8/4.7 and Fable 5, and a
    non-default value is rejected by Sonnet 5. The caller's temperature is
    therefore ignored here rather than turned into a 400 at runtime.
"""
from __future__ import annotations

import logging

from app.features.llm.types import LlmResult, ModelInfo, VerifyResult

logger = logging.getLogger(__name__)

# Haiku 4.5 caps output at 64K; every other current Claude model allows 128K.
# Clamping to the lowest ceiling keeps any user-chosen model from 400-ing.
MAX_OUTPUT_TOKENS = 64_000
VERIFY_TIMEOUT_SECONDS = 15.0


class RefusalError(RuntimeError):
    """Claude's safety classifiers declined the request (HTTP 200, not an error).

    Surfaced as an exception so the model-chain loop can move on to the next
    model instead of returning an empty string that parses as "no questions".
    """


def _client(api_key: str, timeout: float | None = None):
    import anthropic

    kwargs = {"api_key": api_key}
    if timeout is not None:
        kwargs["timeout"] = timeout
    return anthropic.Anthropic(**kwargs)


def _text_of(message) -> str:
    return "".join(
        block.text for block in message.content
        if getattr(block, "type", "") == "text"
    ).strip()


def _result(message, model: str) -> LlmResult:
    if getattr(message, "stop_reason", None) == "refusal":
        details = getattr(message, "stop_details", None)
        category = getattr(details, "category", None) if details else None
        raise RefusalError(f"Claude declined this request (category: {category or 'unknown'})")
    usage = getattr(message, "usage", None)
    return LlmResult(
        text=_text_of(message),
        provider="anthropic",
        model=getattr(message, "model", model) or model,
        input_tokens=getattr(usage, "input_tokens", 0) or 0,
        output_tokens=getattr(usage, "output_tokens", 0) or 0,
    )


def complete(
    api_key: str,
    base_url: str | None,
    model: str,
    prompt: str,
    *,
    max_output_tokens: int = 16_384,
    temperature: float = 0.3,
) -> LlmResult:
    client = _client(api_key)
    with client.messages.stream(
        model=model,
        max_tokens=min(max_output_tokens, MAX_OUTPUT_TOKENS),
        messages=[{"role": "user", "content": prompt}],
    ) as stream_handle:
        message = stream_handle.get_final_message()
    return _result(message, model)


def stream(
    api_key: str,
    base_url: str | None,
    model: str,
    prompt: str,
    *,
    on_text,
    max_output_tokens: int = 16_384,
    temperature: float = 0.3,
    stop_event=None,
) -> LlmResult:
    client = _client(api_key)
    parts: list[str] = []
    try:
        with client.messages.stream(
            model=model,
            max_tokens=min(max_output_tokens, MAX_OUTPUT_TOKENS),
            messages=[{"role": "user", "content": prompt}],
        ) as stream_handle:
            stopped_early = False
            for delta in stream_handle.text_stream:
                if delta:
                    parts.append(delta)
                    on_text(delta)
                if stop_event is not None and stop_event.is_set():
                    stopped_early = True
                    break
            if not stopped_early:
                return _result(stream_handle.get_final_message(), model)
    except RefusalError:
        raise
    except Exception:
        if parts:
            logger.warning("Claude %s stream failed after %d chars — keeping partial",
                           model, sum(len(p) for p in parts))
            return LlmResult("".join(parts).strip(), "anthropic", model)
        raise

    # Aborted by stop_event — the final message (and its usage totals) never arrived.
    return LlmResult("".join(parts).strip(), "anthropic", model)


def vision(
    api_key: str,
    base_url: str | None,
    model: str,
    prompt: str,
    image_b64: str,
    mime_type: str,
    *,
    max_output_tokens: int = 8_192,
) -> LlmResult:
    client = _client(api_key)
    message = client.messages.create(
        model=model,
        max_tokens=min(max_output_tokens, MAX_OUTPUT_TOKENS),
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": mime_type, "data": image_b64},
                },
                {"type": "text", "text": prompt},
            ],
        }],
    )
    return _result(message, model)


def is_rate_limit(exc: Exception) -> bool:
    try:
        import anthropic

        if isinstance(exc, anthropic.RateLimitError):
            return True
        if isinstance(exc, anthropic.APIStatusError):
            return exc.status_code == 429
    except ImportError:
        pass
    text = str(exc).lower()
    return "429" in text or "rate_limit" in text or "overloaded" in text


def list_models(api_key: str, base_url: str | None = None) -> list[ModelInfo]:
    from app.features.llm.registry import is_chat_model, score_model

    client = _client(api_key, timeout=VERIFY_TIMEOUT_SECONDS)
    found: list[ModelInfo] = []
    for entry in client.models.list():
        model_id = getattr(entry, "id", "") or ""
        if not is_chat_model(model_id):
            continue
        found.append(ModelInfo(
            model=model_id,
            display_name=getattr(entry, "display_name", "") or model_id,
            rank=score_model("anthropic", model_id),
            tier="paid",
        ))
    return found


def verify(api_key: str, base_url: str | None = None) -> VerifyResult:
    try:
        import anthropic
    except ImportError:
        return VerifyResult(
            True, "sdk_missing",
            "The `anthropic` package is not installed — key stored without verification",
            reached_provider=False,
        )

    try:
        models = list_models(api_key)
        return VerifyResult(True, "valid", "Key verified against Anthropic", models=models)
    except anthropic.AuthenticationError:
        return VerifyResult(False, "invalid_key", "Anthropic rejected this API key")
    except anthropic.PermissionDeniedError:
        return VerifyResult(False, "permission_denied", "This key is not allowed to call the Claude API")
    except anthropic.RateLimitError:
        return VerifyResult(True, "quota_exceeded", "Key is valid but has no quota left right now")
    except anthropic.BadRequestError as exc:
        return VerifyResult(False, "rejected", str(exc)[:200])
    except anthropic.APIStatusError as exc:
        if exc.status_code and exc.status_code >= 500:
            return VerifyResult(
                True, "service_unavailable",
                "Anthropic's API is temporarily unavailable — key stored without verification",
                reached_provider=False,
            )
        return VerifyResult(False, "rejected", str(exc)[:200])
    except anthropic.APIConnectionError as exc:
        logger.info("Could not reach Anthropic to verify key: %s", str(exc)[:200])
        return VerifyResult(
            True, "network_error",
            "Could not reach Anthropic to verify the key — stored without verification",
            reached_provider=False,
        )
