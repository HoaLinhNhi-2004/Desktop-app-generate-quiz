"""
Catalogue of supported LLM providers.

Three wire dialects cover everything here:
  - `gemini`    — google-generativeai
  - `anthropic` — the Anthropic SDK
  - `openai`    — the OpenAI SDK, pointed at a different `base_url` per vendor

`default_models` is only a last-resort fallback. The real chain comes from the
provider's own `/models` listing, fetched when a key is verified and cached in
`llm_provider_models` — hard-coding model IDs is what made the Gemini-only
version go stale (see MODEL_LIMITS "as of 2026").
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class ProviderSpec:
    id: str
    display_name: str
    dialect: str
    """Which adapter module handles it: gemini | anthropic | openai."""

    base_url: str | None = None
    key_pattern: re.Pattern | None = None
    key_hint: str = ""
    console_url: str = ""
    supports_vision: bool = True
    default_models: list[str] = field(default_factory=list)
    model_keywords: list[str] = field(default_factory=list)
    """Substrings that score a model higher when auto-building a chain."""

    free_tier: bool = False


# Model IDs that are never chat completions, whatever the provider calls them.
_NON_CHAT = (
    "embed", "embedding", "whisper", "tts", "audio", "speech", "dall-e", "image",
    "moderation", "rerank", "guard", "vision-encoder", "clip", "stable-diffusion",
    "video", "veo", "imagen", "aqa", "codestral-embed",
)


PROVIDERS: dict[str, ProviderSpec] = {
    "gemini": ProviderSpec(
        id="gemini",
        display_name="Google Gemini",
        dialect="gemini",
        # Two live formats: the legacy `AIza…` and the `AQ.…` keys AI Studio has
        # been handing out since 2026. Both authenticate the same endpoint.
        key_pattern=re.compile(r"^(AIza[A-Za-z0-9_\-]{30,}|AQ\.[A-Za-z0-9_\-]{20,})$"),
        key_hint="AIza… / AQ.…",
        console_url="https://aistudio.google.com/app/apikey",
        # Prefer the `*-latest` aliases: Google closes dated models to new
        # accounts ("no longer available to new users"), so ranking by version
        # number hands a fresh key a chain it cannot call at all.
        default_models=["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash"],
        model_keywords=["flash", "latest", "pro"],
        free_tier=True,
    ),
    "anthropic": ProviderSpec(
        id="anthropic",
        display_name="Anthropic Claude",
        dialect="anthropic",
        key_pattern=re.compile(r"^sk-ant-[A-Za-z0-9_\-]{20,}$"),
        key_hint="sk-ant-…",
        console_url="https://console.anthropic.com/settings/keys",
        default_models=["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
        model_keywords=["opus", "sonnet", "haiku"],
    ),
    "openai": ProviderSpec(
        id="openai",
        display_name="OpenAI",
        dialect="openai",
        base_url="https://api.openai.com/v1",
        key_pattern=re.compile(r"^sk-[A-Za-z0-9_\-]{20,}$"),
        key_hint="sk-…",
        console_url="https://platform.openai.com/api-keys",
        default_models=["gpt-4.1-mini", "gpt-4o-mini"],
        model_keywords=["mini", "gpt", "nano"],
    ),
    "deepseek": ProviderSpec(
        id="deepseek",
        display_name="DeepSeek",
        dialect="openai",
        base_url="https://api.deepseek.com/v1",
        key_pattern=re.compile(r"^sk-[A-Za-z0-9_\-]{20,}$"),
        key_hint="sk-…",
        console_url="https://platform.deepseek.com/api_keys",
        supports_vision=False,
        default_models=["deepseek-chat"],
        model_keywords=["chat", "reasoner"],
    ),
    "groq": ProviderSpec(
        id="groq",
        display_name="Groq",
        dialect="openai",
        base_url="https://api.groq.com/openai/v1",
        key_pattern=re.compile(r"^gsk_[A-Za-z0-9_\-]{20,}$"),
        key_hint="gsk_…",
        console_url="https://console.groq.com/keys",
        supports_vision=False,
        default_models=["llama-3.3-70b-versatile"],
        model_keywords=["versatile", "llama", "instant"],
        free_tier=True,
    ),
    "xai": ProviderSpec(
        id="xai",
        display_name="xAI Grok",
        dialect="openai",
        base_url="https://api.x.ai/v1",
        key_pattern=re.compile(r"^xai-[A-Za-z0-9_\-]{20,}$"),
        key_hint="xai-…",
        console_url="https://console.x.ai",
        default_models=["grok-4-fast", "grok-3-mini"],
        model_keywords=["fast", "mini", "grok"],
    ),
    "mistral": ProviderSpec(
        id="mistral",
        display_name="Mistral AI",
        dialect="openai",
        base_url="https://api.mistral.ai/v1",
        key_pattern=None,
        key_hint="",
        console_url="https://console.mistral.ai/api-keys",
        default_models=["mistral-large-latest", "mistral-small-latest"],
        model_keywords=["latest", "large", "small", "pixtral"],
        free_tier=True,
    ),
    "openrouter": ProviderSpec(
        id="openrouter",
        display_name="OpenRouter",
        dialect="openai",
        base_url="https://openrouter.ai/api/v1",
        key_pattern=re.compile(r"^sk-or-[A-Za-z0-9_\-]{20,}$"),
        key_hint="sk-or-…",
        console_url="https://openrouter.ai/keys",
        default_models=["anthropic/claude-sonnet-5", "google/gemini-2.5-flash"],
        model_keywords=["flash", "mini", "sonnet", "free"],
    ),
}

DEFAULT_PROVIDER = "gemini"

#: Order tried when the preferred provider has no usable key left.
FALLBACK_ORDER = ["gemini", "anthropic", "openai", "deepseek", "groq", "xai", "mistral", "openrouter"]


def get_spec(provider: str) -> ProviderSpec:
    spec = PROVIDERS.get((provider or "").strip().lower())
    if spec is None:
        raise KeyError(f"Unknown LLM provider: {provider!r}")
    return spec


def is_known(provider: str) -> bool:
    return (provider or "").strip().lower() in PROVIDERS


def is_chat_model(model_id: str) -> bool:
    lowered = (model_id or "").lower()
    if not lowered:
        return False
    return not any(token in lowered for token in _NON_CHAT)


def score_model(provider: str, model_id: str) -> int:
    """Heuristic rank used to auto-build a fallback chain from a fetched list.

    Cheap-and-fast models win: this app fires many parallel calls per quiz, so a
    flagship model at the head of the chain burns quota (and money) for no gain
    on what is ultimately a JSON extraction task.
    """
    spec = get_spec(provider)
    lowered = model_id.lower()
    score = 0
    for index, keyword in enumerate(spec.model_keywords):
        if keyword in lowered:
            score += (len(spec.model_keywords) - index) * 10
    # Dated snapshots duplicate an alias that is already scored — prefer the alias.
    if re.search(r"\d{8}$|-\d{4}$|:free$", lowered):
        score -= 5
    if "preview" in lowered or "exp" in lowered or "beta" in lowered:
        score -= 15
    return score
