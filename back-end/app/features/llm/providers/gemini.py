"""
Google Gemini adapter (google-generativeai for calls, google-genai for listing).

Behaviour here matches what the Gemini-only version of this app did — the
streaming quirks in particular (`chunk.text` raising on usage-only chunks,
cumulative `usage_metadata`) are load-bearing, not defensive noise.
"""
from __future__ import annotations

import logging

from app.features.llm.types import ContentBlockedError, LlmResult, ModelInfo, VerifyResult

logger = logging.getLogger(__name__)

VERIFY_TIMEOUT_MS = 10_000


def _configure(api_key: str):
    import google.generativeai as genai

    genai.configure(api_key=api_key)
    return genai


_FINISH_REASON_HINTS = {
    "SAFETY": "the safety filters blocked the answer",
    "RECITATION": "the answer was blocked as a recitation of copyrighted material",
    "PROHIBITED_CONTENT": "the request was blocked as prohibited content",
    "BLOCKLIST": "the answer contained blocklisted terms",
    "SPII": "the answer was blocked as sensitive personal information",
    "MAX_TOKENS": "the answer hit the output token limit before producing text",
}


def _text_of(response) -> str:
    """Concatenate the response's text parts.

    Never use `response.text`: it raises a ValueError whenever the candidate has
    no parts (a safety/recitation block, or a truncated answer), which surfaces
    as an unreadable SDK message instead of the actual reason.
    """
    candidates = getattr(response, "candidates", None) or []
    if not candidates:
        return ""

    parts = getattr(candidates[0].content, "parts", None) or []
    text = "".join(getattr(p, "text", "") or "" for p in parts)
    if text:
        return text

    # `str()` on the proto enum yields its numeric value ("4"), so read `.name`.
    raw_reason = getattr(candidates[0], "finish_reason", None)
    reason = getattr(raw_reason, "name", None) or str(raw_reason or "")
    hint = _FINISH_REASON_HINTS.get(reason)
    if hint:
        raise ContentBlockedError(f"Gemini returned no text — {hint} ({reason})")
    return ""


def _usage_of(response) -> tuple[int, int]:
    try:
        usage = response.usage_metadata
        if not usage:
            return 0, 0
        return (
            getattr(usage, "prompt_token_count", 0) or 0,
            getattr(usage, "candidates_token_count", 0) or 0,
        )
    except Exception:
        return 0, 0


def _chunk_delta_text(chunk) -> str:
    """Text carried by one streaming chunk, or "" when it carries none.

    Never use `chunk.text` here — it raises ValueError for chunks that hold only
    finish_reason / usage_metadata and no parts, which would abort the stream.
    """
    try:
        candidates = getattr(chunk, "candidates", None) or []
        if not candidates:
            return ""
        parts = getattr(candidates[0].content, "parts", None) or []
        return "".join(getattr(p, "text", "") or "" for p in parts)
    except Exception:
        return ""


def _fold_usage(source, usage: dict) -> None:
    """Fold usage_metadata into `usage`. Gemini reports cumulative totals per chunk."""
    try:
        meta = getattr(source, "usage_metadata", None)
        if not meta:
            return
        prompt_tokens = getattr(meta, "prompt_token_count", 0) or 0
        output_tokens = getattr(meta, "candidates_token_count", 0) or 0
        if prompt_tokens:
            usage["input_tokens"] = prompt_tokens
        if output_tokens:
            usage["output_tokens"] = max(usage["output_tokens"], output_tokens)
    except Exception:
        pass


def complete(
    api_key: str,
    base_url: str | None,
    model: str,
    prompt: str,
    *,
    max_output_tokens: int = 16_384,
    temperature: float = 0.3,
) -> LlmResult:
    genai = _configure(api_key)
    response = genai.GenerativeModel(model).generate_content(
        prompt,
        generation_config=genai.types.GenerationConfig(
            temperature=temperature,
            max_output_tokens=max_output_tokens,
        ),
    )
    in_tok, out_tok = _usage_of(response)
    return LlmResult(
        text=_text_of(response).strip(),
        provider="gemini",
        model=model,
        input_tokens=in_tok,
        output_tokens=out_tok,
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
    genai = _configure(api_key)
    parts: list[str] = []
    usage = {"input_tokens": 0, "output_tokens": 0}

    try:
        chunks = genai.GenerativeModel(model).generate_content(
            prompt,
            generation_config=genai.types.GenerationConfig(
                temperature=temperature,
                max_output_tokens=max_output_tokens,
            ),
            stream=True,
        )
        stopped_early = False
        for chunk in chunks:
            _fold_usage(chunk, usage)
            delta = _chunk_delta_text(chunk)
            if delta:
                parts.append(delta)
                on_text(delta)
            if stop_event is not None and stop_event.is_set():
                stopped_early = True
                break
        if not stopped_early:
            _fold_usage(chunks, usage)
    except Exception:
        if parts:
            # Text already reached the caller. Retrying would resend the same
            # prompt and duplicate questions, so keep the partial result.
            logger.warning("Gemini %s stream failed after %d chars — keeping partial",
                           model, sum(len(p) for p in parts))
            return LlmResult("".join(parts).strip(), "gemini", model,
                             usage["input_tokens"], usage["output_tokens"])
        raise

    return LlmResult(
        text="".join(parts).strip(),
        provider="gemini",
        model=model,
        input_tokens=usage["input_tokens"],
        output_tokens=usage["output_tokens"],
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
    genai = _configure(api_key)
    response = genai.GenerativeModel(model).generate_content(
        [
            {"inline_data": {"mime_type": mime_type, "data": image_b64}},
            prompt,
        ],
        generation_config=genai.types.GenerationConfig(
            temperature=0.2,
            max_output_tokens=max_output_tokens,
        ),
    )
    in_tok, out_tok = _usage_of(response)
    return LlmResult(
        text=_text_of(response).strip(),
        provider="gemini",
        model=model,
        input_tokens=in_tok,
        output_tokens=out_tok,
    )


def is_rate_limit(exc: Exception) -> bool:
    text = str(exc).lower()
    return "429" in text or "resource_exhausted" in text or "resourceexhausted" in text


def list_models(api_key: str, base_url: str | None = None) -> list[ModelInfo]:
    from google import genai as google_genai
    from google.genai import types as genai_types
    from app.features.llm.registry import is_chat_model, score_model

    client = google_genai.Client(
        api_key=api_key,
        http_options=genai_types.HttpOptions(timeout=VERIFY_TIMEOUT_MS),
    )
    found: list[ModelInfo] = []
    for entry in client.models.list():
        raw_name = getattr(entry, "name", "") or ""
        model_id = raw_name.split("/")[-1]
        actions = getattr(entry, "supported_actions", None) or []
        if actions and "generateContent" not in actions:
            continue
        if not is_chat_model(model_id):
            continue
        found.append(ModelInfo(
            model=model_id,
            display_name=getattr(entry, "display_name", "") or model_id,
            rank=score_model("gemini", model_id),
            tier="free",
        ))
    return found


def verify(api_key: str, base_url: str | None = None) -> VerifyResult:
    """Authenticate the key via `models.list` — no generate quota is consumed."""
    try:
        from google import genai as google_genai  # noqa: F401
    except ImportError:
        return VerifyResult(
            True, "sdk_missing",
            "google-genai is not installed — key stored without verification",
            reached_provider=False,
        )

    try:
        models = list_models(api_key)
        return VerifyResult(True, "valid", "Key verified against Google", models=models)
    except Exception as exc:  # noqa: BLE001 — every failure mode is classified below
        return _classify(exc)


def _classify(exc: Exception) -> VerifyResult:
    import re

    from google.genai import errors as genai_errors

    text = str(exc)
    lowered = text.lower()

    if isinstance(exc, genai_errors.ServerError):
        return VerifyResult(
            True, "service_unavailable",
            "Google's API is temporarily unavailable — key stored without verification",
            reached_provider=False,
        )

    if isinstance(exc, genai_errors.ClientError):
        status = getattr(exc, "code", None)

        # 429 means Google authenticated the key and then throttled it. The key
        # itself is good; refusing it here would be wrong.
        if status == 429 or "resource_exhausted" in lowered:
            return VerifyResult(True, "quota_exceeded", "Key is valid but has no quota left right now")

        if status in (401, 403):
            if "service_disabled" in lowered or "has not been used" in lowered or "is disabled" in lowered:
                return VerifyResult(
                    False, "api_disabled",
                    "The Generative Language API is not enabled for this key's Google Cloud project",
                )
            return VerifyResult(
                False, "permission_denied",
                "This key is not allowed to call the Generative Language API",
            )

        if status == 400 or "api_key_invalid" in lowered:
            return VerifyResult(False, "invalid_key", "Google rejected this API key")

        logger.warning("Unclassified Gemini client error during key verify: %s", text[:300])
        match = re.search(r"'message':\s*'([^']+)'", text)
        return VerifyResult(False, "rejected", match.group(1) if match else text[:200])

    logger.info("Could not reach Google to verify key: %s", text[:200])
    return VerifyResult(
        True, "network_error",
        "Could not reach Google to verify the key — stored without verification",
        reached_provider=False,
    )
