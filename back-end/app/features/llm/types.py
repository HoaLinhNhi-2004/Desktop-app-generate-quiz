"""
Shared value types for the multi-provider LLM layer.

Everything here is deliberately free of Flask / SQLAlchemy imports: the
generation pipeline calls provider adapters from `ThreadPoolExecutor` workers
that run without an app context, so anything touching `db` would explode there.
Credential selection and usage recording stay in `client.py`, which is only ever
called from a thread that owns an app context.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class LlmCredential:
    """One usable (provider, key) pair plus the model chain to try with it.

    Selected once per run by `client.select_credential()` and then passed down
    into worker threads — it carries no DB handle on purpose.
    """

    provider: str
    api_key: str
    key_id: str
    model_chain: list[str]
    base_url: str | None = None

    @property
    def primary_model(self) -> str:
        return self.model_chain[0] if self.model_chain else ""


@dataclass
class LlmResult:
    """Outcome of a single successful provider call."""

    text: str
    provider: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass(frozen=True)
class ModelInfo:
    """One model as advertised by a provider's own listing endpoint."""

    model: str
    display_name: str
    rank: int = 0
    """Higher is better. Used to auto-pick a fallback chain."""

    rpd: int = 0
    rpm: int = 0
    tpm: int = 0
    tier: str = "unknown"

    def to_dict(self) -> dict:
        return {
            "model": self.model,
            "displayName": self.display_name,
            "rank": self.rank,
            "rpd": self.rpd,
            "rpm": self.rpm,
            "tpm": self.tpm,
            "tier": self.tier,
        }


@dataclass(frozen=True)
class VerifyResult:
    """Verdict of checking a key against its provider.

    `reached_provider=False` means "we could not check", not "the provider said
    no" — those keys are stored anyway so a flaky network never blocks setup.
    """

    ok: bool
    code: str
    message: str
    reached_provider: bool = True
    models: list[ModelInfo] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "code": self.code,
            "message": self.message,
            "reachedProvider": self.reached_provider,
            # Kept for the existing Gemini-era UI, which reads `reachedGoogle`.
            "reachedGoogle": self.reached_provider,
        }


class ContentBlockedError(RuntimeError):
    """The provider answered, but a safety/recitation filter left no text.

    Distinct from a transport or quota error: another model in the chain may
    well answer the same prompt, so callers retry rather than give up.
    """


class NoCredentialError(RuntimeError):
    """Raised when no provider in the pool has a usable key."""


class AllModelsExhaustedError(RuntimeError):
    """Raised when every model in a credential's chain hit a quota wall."""
