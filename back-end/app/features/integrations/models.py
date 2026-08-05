"""
Integrations feature - OAuth connections to third-party document sources.

One row per provider: the app connects a single Google account / Notion
workspace at a time, matching the single-user desktop model.
"""
import logging
import uuid
from datetime import datetime, timezone

from app.db import db
from app.features.api_keys.crypto import encrypt, decrypt

logger = logging.getLogger(__name__)


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
