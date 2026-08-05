"""Provider-agnostic LLM access for the whole backend.

Import from here rather than from a provider module — the point of this package
is that no feature knows which vendor is answering.
"""
from app.features.llm.client import (
    generate_with_fallback,
    record_failure,
    record_usage,
    require_credential,
    select_credential,
    stream_with_fallback,
    vision_with_fallback,
)
from app.features.llm.types import (
    AllModelsExhaustedError,
    LlmCredential,
    LlmResult,
    ModelInfo,
    NoCredentialError,
    VerifyResult,
)

__all__ = [
    "AllModelsExhaustedError",
    "LlmCredential",
    "LlmResult",
    "ModelInfo",
    "NoCredentialError",
    "VerifyResult",
    "generate_with_fallback",
    "record_failure",
    "record_usage",
    "require_credential",
    "select_credential",
    "stream_with_fallback",
    "vision_with_fallback",
]
