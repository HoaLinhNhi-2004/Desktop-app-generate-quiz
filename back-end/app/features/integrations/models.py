"""
Integrations feature - OAuth apps and connections for third-party sources.

Two tables, two lifetimes:
  IntegrationCredential - the OAuth *app* the user registered with the provider.
                          Configured once, in Settings.
  IntegrationConnection - the account currently signed in through that app.
                          Comes and goes; meaningless if the credential changes.

One row per provider in each: the app connects a single Google account / Notion
workspace at a time, matching the single-user desktop model.
"""
import logging
import uuid
from datetime import datetime, timezone

from app.db import db
from app.features.api_keys.crypto import encrypt, decrypt

logger = logging.getLogger(__name__)


def mask_secret(value: str) -> str:
    """`GOCSPX-abcd…wxyz` — enough to recognise, not enough to reuse."""
    if not value:
        return ""
    if len(value) <= 8:
        return "•" * len(value)
    return f"{value[:4]}{'•' * 6}{value[-4:]}"


class IntegrationCredential(db.Model):
    """The OAuth client the user registered with a provider.

    This project is open source, so no credential can ship inside the build —
    anything committed would be public. Each user registers their own OAuth app
    and pastes it here, which also keeps every install on its own quota.
    """

    __tablename__ = "integration_credentials"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    provider = db.Column(db.String(32), nullable=False, unique=True, index=True)

    # Not a secret (it travels in the authorize URL), so it is stored readable
    # and shown in full — the user needs to see what they pasted.
    client_id = db.Column(db.String(512), nullable=False, default="")
    _client_secret = db.Column("client_secret", db.Text, nullable=False, default="")
    # Google only: the Picker JS API authenticates with a browser API key.
    _picker_api_key = db.Column("picker_api_key", db.Text, default="")

    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    @property
    def client_secret(self) -> str:
        if not self._client_secret:
            return ""
        try:
            return decrypt(self._client_secret)
        except Exception:
            logger.exception("Failed to decrypt client secret for provider=%s", self.provider)
            return ""

    @client_secret.setter
    def client_secret(self, value: str) -> None:
        self._client_secret = encrypt((value or "").strip())

    @property
    def picker_api_key(self) -> str:
        if not self._picker_api_key:
            return ""
        try:
            return decrypt(self._picker_api_key)
        except Exception:
            logger.exception("Failed to decrypt picker API key")
            return ""

    @picker_api_key.setter
    def picker_api_key(self, value: str) -> None:
        self._picker_api_key = encrypt((value or "").strip())

    def to_dict(self) -> dict:
        """Secrets are masked — this response reaches the renderer."""
        return {
            "provider": self.provider,
            "clientId": self.client_id or "",
            "clientSecretMasked": mask_secret(self.client_secret),
            "pickerApiKeyMasked": mask_secret(self.picker_api_key),
            "updatedAt": (
                self.updated_at.isoformat().replace("+00:00", "Z")
                if self.updated_at else None
            ),
        }


class IntegrationConnection(db.Model):
    __tablename__ = "integration_connections"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    provider = db.Column(db.String(32), nullable=False, unique=True, index=True)  # google | notion
    account_label = db.Column(db.String(255), default="")  # e-mail or workspace name

    # Ciphertext columns — read/write plaintext through the properties below.
    _access_token = db.Column("access_token", db.Text, nullable=False, default="")
    _refresh_token = db.Column("refresh_token", db.Text, default="")

    expires_at = db.Column(db.DateTime, nullable=True)  # None = never expires (Notion)
    scopes = db.Column(db.Text, default="")

    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    @property
    def access_token(self) -> str:
        if not self._access_token:
            return ""
        try:
            return decrypt(self._access_token)
        except Exception:
            logger.exception("Failed to decrypt access token for provider=%s", self.provider)
            return ""

    @access_token.setter
    def access_token(self, value: str) -> None:
        self._access_token = encrypt((value or "").strip())

    @property
    def refresh_token(self) -> str:
        if not self._refresh_token:
            return ""
        try:
            return decrypt(self._refresh_token)
        except Exception:
            logger.exception("Failed to decrypt refresh token for provider=%s", self.provider)
            return ""

    @refresh_token.setter
    def refresh_token(self, value: str) -> None:
        self._refresh_token = encrypt((value or "").strip())

    def is_expired(self, leeway_seconds: int = 120) -> bool:
        if self.expires_at is None:
            return False
        expires_at = self.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        return (expires_at - datetime.now(timezone.utc)).total_seconds() <= leeway_seconds

    def to_dict(self) -> dict:
        """Tokens are never serialised — this response reaches the renderer."""
        def _iso(value):
            if not value:
                return None
            return value.isoformat().replace("+00:00", "Z")

        return {
            "provider": self.provider,
            "accountLabel": self.account_label or "",
            "connectedAt": _iso(self.created_at),
            "expiresAt": _iso(self.expires_at),
        }
