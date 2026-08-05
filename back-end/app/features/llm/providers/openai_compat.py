"""
Adapter for OpenAI and every vendor that speaks the same wire format
(DeepSeek, Groq, xAI, Mistral, OpenRouter) — only `base_url` differs.

"OpenAI-compatible" is compatible in outline, not in detail: OpenAI's newer
models reject `max_tokens` and demand `max_completion_tokens`, several reject a
non-default `temperature`, and a number of third parties have never heard of
`max_completion_tokens` or `stream_options`. Rather than maintain a per-model
capability table that goes stale the week it is written, the first call for a
given (endpoint, model) negotiates: it sends the broadly-supported shape, reads
which parameter the 400 complained about, drops or swaps it, and memoises the
answer for the rest of the process.
"""
from __future__ import annotations

import logging
import threading

from app.features.llm.types import LlmResult, ModelInfo, VerifyResult

logger = logging.getLogger(__name__)

VERIFY_TIMEOUT_SECONDS = 20.0
_REQUEST_TIMEOUT_SECONDS = 300.0

# (base_url, model) -> {"token_param": str, "temperature": bool, "stream_usage": bool}
_PARAM_STYLE: dict[tuple[str, str], dict] = {}
_STYLE_LOCK = threading.Lock()


def _style(base_url: str | None, model: str) -> dict:
    key = (base_url or "", model)
    with _STYLE_LOCK:
        return dict(_PARAM_STYLE.setdefault(
            key, {"token_param": "max_tokens", "temperature": True, "stream_usage": True}
        ))


def _remember(base_url: str | None, model: str, **changes) -> None:
    key = (base_url or "", model)
    with _STYLE_LOCK:
        current = _PARAM_STYLE.setdefault(
            key, {"token_param": "max_tokens", "temperature": True, "stream_usage": True}
        )
        current.update(changes)


def _client(api_key: str, base_url: str | None, timeout: float = _REQUEST_TIMEOUT_SECONDS):
    import openai

    return openai.OpenAI(api_key=api_key, base_url=base_url, timeout=timeout, max_retries=1)


def _adapt(base_url: str | None, model: str, exc: Exception) -> bool:
    """Record what the endpoint rejected. Returns True when a retry is worthwhile."""
    text = str(exc).lower()
    if "max_completion_tokens" in text and "max_tokens" in text:
        # "Use `max_completion_tokens` instead of `max_tokens`"
        _remember(base_url, model, token_param="max_completion_tokens")
        return True
    if "unsupported parameter" in text and "max_completion_tokens" in text:
        _remember(base_url, model, token_param="max_tokens")
        return True
    if "temperature" in text:
        _remember(base_url, model, temperature=False)
        return True
    if "stream_options" in text:
        _remember(base_url, model, stream_usage=False)
        return True
    return False


def _payload(base_url: str | None, model: str, messages: list, max_output_tokens: int,
             temperature: float) -> dict:
    style = _style(base_url, model)
    payload: dict = {
        "model": model,
        "messages": messages,
        style["token_param"]: max_output_tokens,
    }
    if style["temperature"]:
        payload["temperature"] = temperature
    return payload


def _usage_of(response) -> tuple[int, int]:
    usage = getattr(response, "usage", None)
    if not usage:
        return 0, 0
    return (
        getattr(usage, "prompt_tokens", 0) or 0,
        getattr(usage, "completion_tokens", 0) or 0,
    )


def _provider_of(base_url: str | None) -> str:
    from app.features.llm.registry import PROVIDERS

    for spec in PROVIDERS.values():
        if spec.dialect == "openai" and spec.base_url == base_url:
            return spec.id
    return "openai"


def _call(api_key: str, base_url: str | None, model: str, messages: list,
          max_output_tokens: int, temperature: float) -> LlmResult:
    import openai

    client = _client(api_key, base_url)
    for _ in range(4):
        try:
            response = client.chat.completions.create(
                **_payload(base_url, model, messages, max_output_tokens, temperature)
            )
            break
        except openai.BadRequestError as exc:
            if not _adapt(base_url, model, exc):
                raise
    else:
        raise RuntimeError(f"{model} rejected every supported request shape")

    choice = response.choices[0] if response.choices else None
    text = (getattr(choice.message, "content", "") or "").strip() if choice else ""
    in_tok, out_tok = _usage_of(response)
    return LlmResult(
        text=text,
        provider=_provider_of(base_url),
        model=getattr(response, "model", model) or model,
        input_tokens=in_tok,
        output_tokens=out_tok,
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
    return _call(
        api_key, base_url, model,
        [{"role": "user", "content": prompt}],
        max_output_tokens, temperature,
    )


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
    import openai

    client = _client(api_key, base_url)
    messages = [{"role": "user", "content": prompt}]
    parts: list[str] = []
    in_tok = out_tok = 0

    for _ in range(4):
        parts = []
        payload = _payload(base_url, model, messages, max_output_tokens, temperature)
        payload["stream"] = True
        if _style(base_url, model)["stream_usage"]:
            payload["stream_options"] = {"include_usage": True}
        try:
            for chunk in client.chat.completions.create(**payload):
                usage = getattr(chunk, "usage", None)
                if usage:
                    in_tok = getattr(usage, "prompt_tokens", 0) or in_tok
                    out_tok = getattr(usage, "completion_tokens", 0) or out_tok
                choices = getattr(chunk, "choices", None) or []
                if choices:
                    delta = getattr(choices[0].delta, "content", None) or ""
                    if delta:
                        parts.append(delta)
                        on_text(delta)
                if stop_event is not None and stop_event.is_set():
                    break
            break
        except openai.BadRequestError as exc:
            if parts or not _adapt(base_url, model, exc):
                raise
        except Exception:
            if parts:
                # Text already reached the caller — resending would duplicate it.
                logger.warning("%s stream failed after %d chars — keeping partial",
                               model, sum(len(p) for p in parts))
                break
            raise
    else:
        raise RuntimeError(f"{model} rejected every supported request shape")

    return LlmResult(
        text="".join(parts).strip(),
        provider=_provider_of(base_url),
        model=model,
        input_tokens=in_tok,
        output_tokens=out_tok,
    )


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
    return _call(
        api_key, base_url, model,
        [{
            "role": "user",
            "content": [
                {"type": "image_url",
                 "image_url": {"url": f"data:{mime_type};base64,{image_b64}"}},
                {"type": "text", "text": prompt},
            ],
        }],
        max_output_tokens, 0.2,
    )


def is_rate_limit(exc: Exception) -> bool:
    try:
        import openai

        if isinstance(exc, openai.RateLimitError):
            return True
        if isinstance(exc, openai.APIStatusError):
            return exc.status_code in (429, 529)
    except ImportError:
        pass
    text = str(exc).lower()
    return "429" in text or "rate limit" in text or "quota" in text or "insufficient_quota" in text


def list_models(api_key: str, base_url: str | None = None) -> list[ModelInfo]:
    from app.features.llm.registry import is_chat_model, score_model

    provider = _provider_of(base_url)
    client = _client(api_key, base_url, timeout=VERIFY_TIMEOUT_SECONDS)
    found: list[ModelInfo] = []
    for entry in client.models.list():
        model_id = getattr(entry, "id", "") or ""
        if not model_id or not is_chat_model(model_id):
            continue
        found.append(ModelInfo(
            model=model_id,
            display_name=getattr(entry, "name", None) or model_id,
            rank=score_model(provider, model_id),
            tier="paid",
        ))
    return found


def verify(api_key: str, base_url: str | None = None) -> VerifyResult:
    try:
        import openai
    except ImportError:
        return VerifyResult(
            True, "sdk_missing",
            "The `openai` package is not installed — key stored without verification",
            reached_provider=False,
        )

    try:
        models = list_models(api_key, base_url)
    except openai.AuthenticationError:
        return VerifyResult(False, "invalid_key", "The provider rejected this API key")
    except openai.PermissionDeniedError:
        return VerifyResult(False, "permission_denied", "This key is not allowed to call the chat API")
    except openai.RateLimitError:
        return VerifyResult(True, "quota_exceeded", "Key is valid but has no quota left right now")
    except openai.NotFoundError:
        return VerifyResult(
            True, "models_unavailable",
            "Key accepted, but this provider does not expose a model list",
            reached_provider=False,
        )
    except openai.APIStatusError as exc:
        if exc.status_code and exc.status_code >= 500:
            return VerifyResult(
                True, "service_unavailable",
                "The provider's API is temporarily unavailable — key stored without verification",
                reached_provider=False,
            )
        return VerifyResult(False, "rejected", str(exc)[:200])
    except openai.APIConnectionError as exc:
        logger.info("Could not reach provider to verify key: %s", str(exc)[:200])
        return VerifyResult(
            True, "network_error",
            "Could not reach the provider to verify the key — stored without verification",
            reached_provider=False,
        )

    if not models:
        return VerifyResult(
            True, "models_unavailable",
            "Key accepted, but the provider returned no usable chat model",
        )
    return VerifyResult(True, "valid", "Key verified against the provider", models=models)
