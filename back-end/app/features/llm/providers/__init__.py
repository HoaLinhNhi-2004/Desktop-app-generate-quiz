"""Dispatch from a provider id to the module that speaks its wire format."""
from __future__ import annotations

from app.features.llm.registry import get_spec
from app.features.llm.providers import anthropic_provider, gemini, openai_compat

_ADAPTERS = {
    "gemini": gemini,
    "anthropic": anthropic_provider,
    "openai": openai_compat,
}


def adapter_for(provider: str):
    """Return the adapter module handling `provider`.

    Raises KeyError for an unknown provider — callers treat that as a config
    error, not a runtime failure to swallow.
    """
    return _ADAPTERS[get_spec(provider).dialect]


__all__ = ["adapter_for", "gemini", "anthropic_provider", "openai_compat"]
