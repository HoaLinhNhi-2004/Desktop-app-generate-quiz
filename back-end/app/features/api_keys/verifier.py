"""
Liveness check for a Gemini API key.

Why this exists: `POST /api/keys/` used to accept any non-empty string, so a
typo'd or revoked key was stored with status `active`. Because
`get_optimal_key()` orders by `last_used_at ASC NULLS FIRST`, the freshly added
bad key was handed to the very next generate call — the failure surfaced far
from its cause, as a generic "quiz generation failed".

Verification uses `models.list` rather than a generate call: it authenticates
the key against the Generative Language API without consuming generate quota.

A verdict never hard-blocks on our own inability to reach Google. Only an
explicit rejection *from* Google (4xx) marks a key unusable; transport failures
and Google-side 5xx store the key and report `reachedGoogle: false` so the UI
can say "saved but not verified" instead of guessing.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# AI Studio keys are "AIza" followed by 35 URL-safe characters.
_KEY_PATTERN = re.compile(r"^AIza[A-Za-z0-9_\-]{30,}$")

VERIFY_TIMEOUT_MS = 10_000


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    """Whether the key may be stored / kept active."""

    code: str
    """Stable machine code — the UI maps it to a localized message."""

    message: str
    """English fallback, used when the UI has no string for `code`."""

    reached_google: bool = True
    """False when the verdict is 'unknown' rather than 'Google said no'."""

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "code": self.code,
            "message": self.message,
            "reachedGoogle": self.reached_google,
        }


def check_format(raw_key: str) -> VerifyResult | None:
    """Catch paste errors without a network round-trip. None means 'looks fine'.

    These verdicts carry reached_google=False: the rejection is ours, not Google's.
    """
    if not raw_key:
        return VerifyResult(False, "empty", "API key is required", reached_google=False)
    if any(ch.isspace() for ch in raw_key):
        return VerifyResult(
            False, "invalid_format",
            "API key must not contain spaces or line breaks",
            reached_google=False,
        )
    if not _KEY_PATTERN.match(raw_key):
        return VerifyResult(
            False, "invalid_format",
            "Not a Google AI Studio API key — expected it to start with 'AIza'",
            reached_google=False,
        )
    return None


def verify_key(raw_key: str) -> VerifyResult:
    fmt = check_format(raw_key)
    if fmt is not None:
        return fmt

    try:
        from google import genai
        from google.genai import types
    except ImportError:
        return VerifyResult(
            True, "sdk_missing",
            "google-genai is not installed — key stored without verification",
            reached_google=False,
        )

    try:
        client = genai.Client(
            api_key=raw_key,
            http_options=types.HttpOptions(timeout=VERIFY_TIMEOUT_MS),
        )
        next(iter(client.models.list(config={"page_size": 1})), None)
        return VerifyResult(True, "valid", "Key verified against Google")
    except Exception as exc:  # noqa: BLE001 — every failure mode is classified below
        return _classify(exc)


def _classify(exc: Exception) -> VerifyResult:
    from google.genai import errors as genai_errors

    text = str(exc)
    lowered = text.lower()

    if isinstance(exc, genai_errors.ServerError):
        return VerifyResult(
            True, "service_unavailable",
            "Google's API is temporarily unavailable — key stored without verification",
            reached_google=False,
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
        return VerifyResult(False, "rejected", _google_message(text))

    logger.info("Could not reach Google to verify key: %s", text[:200])
    return VerifyResult(
        True, "network_error",
        "Could not reach Google to verify the key — stored without verification",
        reached_google=False,
    )


def _google_message(text: str) -> str:
    """Pull the human-readable part out of a Google error string, if present."""
    match = re.search(r"'message':\s*'([^']+)'", text)
    return match.group(1) if match else text[:200]
