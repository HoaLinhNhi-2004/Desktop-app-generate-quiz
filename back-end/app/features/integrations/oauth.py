"""
OAuth authorization-code flow for the third-party material sources.

Both providers redirect back to the local Flask backend
(`OAUTH_REDIRECT_BASE/api/integrations/<provider>/callback`), so the consent
screen must be opened in the *system browser*: Google rejects embedded
webviews with `disallowed_useragent`, and the Electron renderer's CSP would
block the provider's scripts anyway.

Pending authorization state lives in a module-level dict, same as
smart_import_service — restarting the backend mid-flow simply invalidates the
attempt, which is the correct outcome for a 10-minute window.
"""
import base64
import hashlib
import logging
import secrets
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone

import requests
from flask import current_app

from app.db import db
from app.features.integrations.models import IntegrationConnection, IntegrationCredential

logger = logging.getLogger(__name__)

STATE_TTL_SECONDS = 600
HTTP_TIMEOUT = 20

PROVIDERS: dict[str, dict] = {
    "google": {
        "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        # drive.file is non-sensitive: the app only ever sees files the user
        # picked through the Google Picker. Widening this to drive.readonly
        # would make the OAuth app subject to a paid annual security assessment.
        "scopes": [
            "https://www.googleapis.com/auth/drive.file",
            "openid",
            "email",
        ],
        "extra_auth_params": {"access_type": "offline", "prompt": "consent"},
        "uses_pkce": True,
        "client_id_config": "GOOGLE_OAUTH_CLIENT_ID",
        "client_secret_config": "GOOGLE_OAUTH_CLIENT_SECRET",
    },
    "notion": {
        "authorize_url": "https://api.notion.com/v1/oauth/authorize",
        "token_url": "https://api.notion.com/v1/oauth/token",
        # Notion has no scope parameter — the user picks which pages to share
        # on the consent screen itself.
        "scopes": [],
        "extra_auth_params": {"owner": "user"},
        "uses_pkce": False,
        "client_id_config": "NOTION_OAUTH_CLIENT_ID",
        "client_secret_config": "NOTION_OAUTH_CLIENT_SECRET",
    },
}

_pending_states: dict[str, dict] = {}
_states_lock = threading.Lock()


class OAuthError(Exception):
    """Raised for any refusal that should surface to the user as a message."""


# ── Provider config ───────────────────────────────────────────────────────────


def get_provider(provider: str) -> dict:
    spec = PROVIDERS.get(provider)
    if not spec:
        raise OAuthError(f"Nhà cung cấp không được hỗ trợ: {provider}")
    return spec


def get_stored_credential(provider: str) -> IntegrationCredential | None:
    get_provider(provider)
    return IntegrationCredential.query.filter_by(provider=provider).first()


def get_credentials(provider: str) -> tuple[str, str]:
    """Client id/secret for a provider.

    The DB comes first: this project is open source, so the OAuth app is
    registered by the user and entered in Settings. Env vars stay as a fallback
    for a self-hosted or CI setup that would rather inject them at boot.
    """
    spec = get_provider(provider)

    stored = get_stored_credential(provider)
    if stored and stored.client_id and stored.client_secret:
        return stored.client_id, stored.client_secret

    client_id = current_app.config.get(spec["client_id_config"], "")
    client_secret = current_app.config.get(spec["client_secret_config"], "")
    if not client_id or not client_secret:
        raise OAuthError(
            f"Chưa cấu hình OAuth cho {provider}. "
            f"Vào Cài đặt → Nguồn tài liệu bên ngoài để nhập Client ID và Client Secret."
        )
    return client_id, client_secret


def get_picker_api_key() -> str:
    """Google Picker browser API key, stored credential first."""
    stored = get_stored_credential("google")
    if stored and stored.picker_api_key:
        return stored.picker_api_key
    return current_app.config.get("GOOGLE_PICKER_API_KEY", "")


def get_app_id() -> str:
    """Picker appId — the project number, which prefixes the OAuth client ID."""
    configured = current_app.config.get("GOOGLE_APP_ID", "")
    if configured:
        return configured
    try:
        client_id, _ = get_credentials("google")
    except OAuthError:
        return ""
    return client_id.split("-", 1)[0] if "-" in client_id else ""


def is_configured(provider: str) -> bool:
    try:
        get_credentials(provider)
    except OAuthError:
        return False
    # Drive is unusable without the Picker key even with a valid OAuth app.
    if provider == "google":
        return bool(get_picker_api_key())
    return True


def redirect_uri(provider: str) -> str:
    base = current_app.config.get("OAUTH_REDIRECT_BASE", "http://127.0.0.1:5000")
    return f"{base}/api/integrations/{provider}/callback"


# ── Pending state ─────────────────────────────────────────────────────────────


def _purge_expired_locked() -> None:
    cutoff = time.time() - STATE_TTL_SECONDS
    for state in [s for s, v in _pending_states.items() if v["created_at"] < cutoff]:
        _pending_states.pop(state, None)


def _remember_state(provider: str, code_verifier: str) -> str:
    state = secrets.token_urlsafe(32)
    with _states_lock:
        _purge_expired_locked()
        _pending_states[state] = {
            "provider": provider,
            "code_verifier": code_verifier,
            "created_at": time.time(),
        }
    return state


def _consume_state(provider: str, state: str) -> str:
    """Return the code_verifier for a valid, unexpired state; single use."""
    with _states_lock:
        _purge_expired_locked()
        entry = _pending_states.pop(state, None)
    if not entry:
        raise OAuthError("Phiên đăng nhập đã hết hạn hoặc không hợp lệ. Vui lòng thử lại.")
    if entry["provider"] != provider:
        raise OAuthError("Phiên đăng nhập không khớp nhà cung cấp.")
    return entry["code_verifier"]


# ── Authorization ─────────────────────────────────────────────────────────────


def build_authorize_url(provider: str) -> str:
    spec = get_provider(provider)
    client_id, _ = get_credentials(provider)

    code_verifier = ""
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri(provider),
        "response_type": "code",
        **spec["extra_auth_params"],
    }
    if spec["scopes"]:
        params["scope"] = " ".join(spec["scopes"])
    if spec["uses_pkce"]:
        code_verifier = secrets.token_urlsafe(64)
        digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
        params["code_challenge"] = base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")
        params["code_challenge_method"] = "S256"

    params["state"] = _remember_state(provider, code_verifier)
    return f"{spec['authorize_url']}?{urllib.parse.urlencode(params)}"


def _post_token(provider: str, payload: dict) -> dict:
    """Token endpoint call. Notion authenticates with Basic + JSON, Google with a form."""
    spec = get_provider(provider)
    client_id, client_secret = get_credentials(provider)

    if provider == "notion":
        basic = base64.b64encode(f"{client_id}:{client_secret}".encode("utf-8")).decode("ascii")
        response = requests.post(
            spec["token_url"],
            json=payload,
            headers={
                "Authorization": f"Basic {basic}",
                "Content-Type": "application/json",
                "Notion-Version": "2022-06-28",
            },
            timeout=HTTP_TIMEOUT,
        )
    else:
        response = requests.post(
            spec["token_url"],
            data={**payload, "client_id": client_id, "client_secret": client_secret},
            timeout=HTTP_TIMEOUT,
        )

    if not response.ok:
        logger.error(
            "Token endpoint for %s returned %s: %s", provider, response.status_code, response.text[:500]
        )
        raise OAuthError(f"Nhà cung cấp từ chối yêu cầu (HTTP {response.status_code}).")
    return response.json()


def exchange_code(provider: str, code: str, state: str) -> IntegrationConnection:
    """Complete the flow and persist the connection (upsert, one row per provider)."""
    spec = get_provider(provider)
    code_verifier = _consume_state(provider, state)

    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri(provider),
    }
    if spec["uses_pkce"]:
        payload["code_verifier"] = code_verifier

    tokens = _post_token(provider, payload)
    access_token = tokens.get("access_token") or ""
    if not access_token:
        raise OAuthError("Nhà cung cấp không trả về access token.")

    connection = IntegrationConnection.query.filter_by(provider=provider).first()
    if connection is None:
        connection = IntegrationConnection(provider=provider)
        db.session.add(connection)

    connection.access_token = access_token
    # Google only returns a refresh token on the first consent; keep the stored
    # one when a re-consent omits it, otherwise the connection silently expires.
    if tokens.get("refresh_token"):
        connection.refresh_token = tokens["refresh_token"]
    connection.scopes = tokens.get("scope") or " ".join(spec["scopes"])
    connection.expires_at = _expiry_from(tokens.get("expires_in"))
    connection.account_label = _account_label(provider, tokens, access_token)
    connection.updated_at = datetime.now(timezone.utc)

    db.session.commit()
    logger.info("Connected %s integration as %s", provider, connection.account_label)
    return connection


def _expiry_from(expires_in) -> datetime | None:
    try:
        seconds = int(expires_in)
    except (TypeError, ValueError):
        return None
    return datetime.now(timezone.utc) + timedelta(seconds=seconds)


def _account_label(provider: str, tokens: dict, access_token: str) -> str:
    """Best-effort display name; a failure here must not fail the connection."""
    if provider == "notion":
        owner = (tokens.get("owner") or {}).get("user") or {}
        return tokens.get("workspace_name") or owner.get("name") or "Notion"
    try:
        response = requests.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=HTTP_TIMEOUT,
        )
        if response.ok:
            return response.json().get("email") or "Google"
    except requests.RequestException as e:
        logger.warning("Could not read Google user info: %s", e)
    return "Google"


# ── Token use ─────────────────────────────────────────────────────────────────


def get_connection(provider: str) -> IntegrationConnection | None:
    get_provider(provider)
    return IntegrationConnection.query.filter_by(provider=provider).first()


def get_valid_access_token(provider: str) -> str:
    """Access token for API calls, refreshing first when it is about to expire."""
    connection = get_connection(provider)
    if not connection:
        raise OAuthError(f"Chưa kết nối {provider}. Vào Cài đặt để kết nối.")

    if not connection.is_expired():
        return connection.access_token

    if not connection.refresh_token:
        raise OAuthError(
            f"Kết nối {provider} đã hết hạn và không có refresh token. Vui lòng kết nối lại."
        )

    tokens = _post_token(
        provider,
        {"grant_type": "refresh_token", "refresh_token": connection.refresh_token},
    )
    access_token = tokens.get("access_token") or ""
    if not access_token:
        raise OAuthError(f"Làm mới token {provider} thất bại. Vui lòng kết nối lại.")

    connection.access_token = access_token
    if tokens.get("refresh_token"):
        connection.refresh_token = tokens["refresh_token"]
    connection.expires_at = _expiry_from(tokens.get("expires_in"))
    connection.updated_at = datetime.now(timezone.utc)
    db.session.commit()
    return access_token
