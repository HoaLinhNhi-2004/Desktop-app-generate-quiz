"""
Liveness check for a user-supplied OAuth app (Google Drive / Notion).

Why this exists: the OAuth app is registered by the user in someone else's
console, so every field is a chance to paste the wrong thing — and without a
check the first sign of trouble is a consent screen that dies with a raw
provider error, in a browser tab, away from the app.

How a client id/secret is checked without a real authorization code: ask the
token endpoint to redeem a deliberately bogus code. The provider authenticates
the *client* before it looks at the code, so the two failures are distinct:

    bad client id/secret  -> 401 invalid_client
    good client, bad code -> 400 invalid_grant   <- what we want to see

Both endpoints were probed to confirm this; see the classifiers below.

As in api_keys.verifier, a verdict never hard-blocks on our own inability to
reach the provider. Only an explicit rejection *from* the provider marks a
credential unusable; transport failures and provider-side 5xx report
reached_provider=False so the UI can say "saved but not verified".
"""
from __future__ import annotations

import base64
import logging
import re
from dataclasses import dataclass, field

import requests

logger = logging.getLogger(__name__)

VERIFY_TIMEOUT = 15

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token"
# Metadata endpoint: always available and needs no per-project API enablement,
# so a 400 here really means "this is not a Google API key".
GOOGLE_KEY_PROBE_URL = "https://www.googleapis.com/discovery/v1/apis"

_GOOGLE_CLIENT_ID_RE = re.compile(r"^\d+-[A-Za-z0-9_\-]+\.apps\.googleusercontent\.com$")
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_GOOGLE_API_KEY_RE = re.compile(r"^AIza[A-Za-z0-9_\-]{30,}$")


@dataclass(frozen=True)
class Check:
    """One named assertion, so the UI can show a per-field result list."""

    name: str          # "client" | "picker_key"
    ok: bool
    code: str          # stable machine code; the UI maps it to a localized string
    message: str       # English fallback
    reached_provider: bool = True

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "ok": self.ok,
            "code": self.code,
            "message": self.message,
            "reachedProvider": self.reached_provider,
        }


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    """Whether the credential may be stored."""

    code: str
    message: str
    reached_provider: bool = True
    checks: list[Check] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "code": self.code,
            "message": self.message,
            "reachedProvider": self.reached_provider,
            "checks": [c.to_dict() for c in self.checks],
        }


def _combine(checks: list[Check]) -> VerifyResult:
    """Worst check wins; a soft 'could not check' never blocks a save."""
    failed = next((c for c in checks if not c.ok), None)
    if failed is not None:
        return VerifyResult(False, failed.code, failed.message, failed.reached_provider, checks)

    unverified = next((c for c in checks if not c.reached_provider), None)
    if unverified is not None:
        return VerifyResult(True, unverified.code, unverified.message, False, checks)

    return VerifyResult(True, "valid", "Credentials verified with the provider", True, checks)


# ── Format ───────────────────────────────────────────────────────────────────


def _check_format(provider: str, client_id: str, client_secret: str) -> Check | None:
    """Catch paste errors without a network round-trip. None means 'looks fine'.

    These verdicts carry reached_provider=False: the rejection is ours.
    """
    if not client_id:
        return Check("client", False, "empty_client_id", "Client ID is required", False)
    if not client_secret:
        return Check("client", False, "empty_client_secret", "Client secret is required", False)
    if any(ch.isspace() for ch in client_id + client_secret):
        return Check(
            "client", False, "invalid_format",
            "Client ID and secret must not contain spaces or line breaks", False,
        )

    if provider == "google" and not _GOOGLE_CLIENT_ID_RE.match(client_id):
        return Check(
            "client", False, "invalid_format",
            "Not a Google client ID — expected it to end with .apps.googleusercontent.com",
            False,
        )
    if provider == "notion" and not _UUID_RE.match(client_id):
        return Check(
            "client", False, "invalid_format",
            "Not a Notion client ID — expected a UUID like 1a2b3c4d-....",
            False,
        )
    return None


# ── Network probes ───────────────────────────────────────────────────────────


def _classify_token_response(status: int, body: dict, raw: str) -> Check:
    """Read the token endpoint's refusal of our bogus code.

    Order matters: client authentication happens before the code is examined,
    so `invalid_client` is checked first and any *other* 4xx means the client
    itself was accepted.
    """
    error = (body.get("error") or "").lower()

    if error == "invalid_client" or status == 401:
        return Check(
            "client", False, "invalid_client",
            "The provider does not recognise this client ID / secret pair",
        )

    if error == "redirect_uri_mismatch":
        return Check(
            "client", False, "redirect_uri_mismatch",
            "The redirect URI below is not registered on this OAuth app",
        )

    if error == "unauthorized_client":
        return Check(
            "client", False, "unauthorized_client",
            "This OAuth client may not use the authorization code flow",
        )

    if status >= 500:
        return Check(
            "client", True, "service_unavailable",
            "The provider is temporarily unavailable — stored without verification",
            False,
        )

    # RFC 6749 gives the token endpoint exactly two shapes: 401 for a bad client
    # (handled above) and 400 for a bad grant. A 400 here therefore means the
    # client authenticated and only the deliberately bogus code was rejected.
    # Anything else is not a response we understand, so it must not read as OK.
    if status in (200, 400):
        return Check("client", True, "valid", "Client ID and secret accepted by the provider")

    logger.warning("Unclassified token-endpoint response %s: %s", status, raw[:300])
    description = body.get("error_description") or body.get("message") or raw[:200]
    return Check("client", False, "rejected", str(description))


def _probe_google_client(client_id: str, client_secret: str, redirect_uri: str) -> Check:
    try:
        response = requests.post(
            GOOGLE_TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": "quizgen-credential-probe",
                "redirect_uri": redirect_uri,
                "client_id": client_id,
                "client_secret": client_secret,
            },
            timeout=VERIFY_TIMEOUT,
        )
    except requests.RequestException as e:
        logger.info("Could not reach Google to verify OAuth client: %s", e)
        return Check(
            "client", True, "network_error",
            "Could not reach Google to verify the client — stored without verification",
            False,
        )
    return _classify_token_response(response.status_code, _json_of(response), response.text)


def _probe_notion_client(client_id: str, client_secret: str, redirect_uri: str) -> Check:
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
    try:
        response = requests.post(
            NOTION_TOKEN_URL,
            json={
                "grant_type": "authorization_code",
                "code": "quizgen-credential-probe",
                "redirect_uri": redirect_uri,
            },
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/json",
                "Notion-Version": "2022-06-28",
            },
            timeout=VERIFY_TIMEOUT,
        )
    except requests.RequestException as e:
        logger.info("Could not reach Notion to verify OAuth client: %s", e)
        return Check(
            "client", True, "network_error",
            "Could not reach Notion to verify the client — stored without verification",
            False,
        )
    return _classify_token_response(response.status_code, _json_of(response), response.text)


def _probe_picker_key(api_key: str) -> Check:
    if not api_key:
        return Check(
            "picker_key", False, "empty_picker_key",
            "The Picker API key is required to browse Google Drive", False,
        )
    if not _GOOGLE_API_KEY_RE.match(api_key):
        return Check(
            "picker_key", False, "invalid_format",
            "Not a Google API key — expected it to start with 'AIza'", False,
        )

    try:
        response = requests.get(
            GOOGLE_KEY_PROBE_URL, params={"name": "drive", "key": api_key}, timeout=VERIFY_TIMEOUT
        )
    except requests.RequestException as e:
        logger.info("Could not reach Google to verify the Picker key: %s", e)
        return Check(
            "picker_key", True, "network_error",
            "Could not reach Google to verify the API key — stored without verification",
            False,
        )

    if response.ok:
        return Check("picker_key", True, "valid", "API key accepted by Google")

    body = _json_of(response)
    message = ((body.get("error") or {}).get("message") or "").lower()

    if response.status_code == 400 and "api key not valid" in message:
        return Check("picker_key", False, "invalid_key", "Google rejected this API key")

    # A key restricted to the Picker API only is exactly what a careful user
    # sets up; the probe endpoint is then blocked for it, which is not an error.
    if response.status_code == 403:
        return Check(
            "picker_key", True, "key_restricted",
            "The key exists but is restricted — could not confirm it covers the Picker API",
            False,
        )

    if response.status_code >= 500:
        return Check(
            "picker_key", True, "service_unavailable",
            "Google is temporarily unavailable — stored without verification", False,
        )

    logger.warning(
        "Unclassified API-key probe response %s: %s", response.status_code, response.text[:300]
    )
    return Check("picker_key", False, "rejected", message[:200] or "Google rejected this API key")


def _json_of(response: requests.Response) -> dict:
    try:
        data = response.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


# ── Public API ───────────────────────────────────────────────────────────────


def verify_credentials(
    provider: str,
    client_id: str,
    client_secret: str,
    redirect_uri: str,
    picker_api_key: str = "",
) -> VerifyResult:
    """Check an OAuth app before it is stored. Never raises."""
    client_id = (client_id or "").strip()
    client_secret = (client_secret or "").strip()
    picker_api_key = (picker_api_key or "").strip()

    fmt = _check_format(provider, client_id, client_secret)
    if fmt is not None:
        # Skip the network probes: they would only echo the same problem.
        return _combine([fmt])

    if provider == "google":
        checks = [
            _probe_google_client(client_id, client_secret, redirect_uri),
            _probe_picker_key(picker_api_key),
        ]
    elif provider == "notion":
        checks = [_probe_notion_client(client_id, client_secret, redirect_uri)]
    else:
        return VerifyResult(False, "unknown_provider", f"Unsupported provider: {provider}", False)

    return _combine(checks)
