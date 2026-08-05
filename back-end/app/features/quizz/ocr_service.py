"""
OCR Service - Extract text from images with the configured LLM provider's
vision endpoint.

Key rotation is a loop rather than a single pick: when every model of one key is
rate-limited, the next key is tried, and `select_credential` walks on to the
next provider once a provider's keys are used up. Providers without vision
(DeepSeek, Groq) are skipped by the selector, so a text-only key never produces
a confusing "unsupported image" error here.
"""

import os
import base64
import logging
import mimetypes

from app.features.llm import (
    AllModelsExhaustedError,
    NoCredentialError,
    record_failure,
    record_usage,
    select_credential,
    vision_with_fallback,
)

logger = logging.getLogger(__name__)

_OCR_PROMPT = {
    "vi": (
        "Trích xuất toàn bộ văn bản có trong ảnh này. "
        "Chỉ trả về nội dung văn bản gốc, giữ nguyên xuống dòng và cấu trúc bố cục. "
        "Không thêm giải thích hay chú thích nào khác."
    ),
    "en": (
        "Extract all text from this image. "
        "Return only the raw text content, preserving line breaks and layout. "
        "Do not add any commentary or explanation."
    ),
}


def extract_text_from_image(image_path: str, lang: str = "vi") -> str:
    """
    Extract text from a single image using a vision-capable LLM.

    Args:
        image_path: Path to the image file
        lang: Language hint ('vi' or 'en')

    Returns:
        Extracted text as a string

    Raises:
        FileNotFoundError: if the file does not exist
        RuntimeError: if no vision-capable key is available or all models fail
    """
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"Image file not found: {image_path}")

    mime_type = mimetypes.guess_type(image_path)[0] or "image/png"
    with open(image_path, "rb") as fh:
        b64_data = base64.b64encode(fh.read()).decode()

    prompt = _OCR_PROMPT.get(lang, _OCR_PROMPT["en"])
    tried_key_ids: list[str] = []

    while True:
        cred = select_credential(exclude_key_ids=tried_key_ids, require_vision=True)
        if cred is None:
            suffix = f" (đã thử {len(tried_key_ids)} key)" if tried_key_ids else ""
            raise NoCredentialError(
                f"Không có API key hỗ trợ đọc ảnh{suffix}. "
                "Vào Settings > API Keys để thêm key Gemini, Claude hoặc OpenAI."
            )

        tried_key_ids.append(cred.key_id)
        try:
            result = vision_with_fallback(cred, prompt, b64_data, mime_type)
        except AllModelsExhaustedError as exc:
            record_failure(cred, str(exc), is_rate_limit=True)
            logger.warning("All %s models rate-limited for key …%s — trying another key",
                           cred.provider, cred.key_id[-6:])
            continue
        except Exception as exc:
            # Non-quota error (invalid key, content policy, …) — stop immediately.
            record_failure(cred, str(exc))
            raise

        record_usage(cred, result.input_tokens, result.output_tokens,
                     model_stats={result.model: {
                         "requests": 1,
                         "input_tokens": result.input_tokens,
                         "output_tokens": result.output_tokens,
                     }})
        logger.info("OCR via %s/%s: %d chars from %s",
                    cred.provider, result.model, len(result.text),
                    os.path.basename(image_path))
        return result.text


def extract_text_from_images(image_paths: list[str], lang: str = "vi") -> str:
    """
    Extract text from multiple image files.

    Args:
        image_paths: List of image file paths
        lang: Language hint

    Returns:
        Combined extracted text
    """
    all_texts = []
    for path in image_paths:
        try:
            text = extract_text_from_image(path, lang=lang)
            if text.strip():
                all_texts.append(text)
        except Exception as e:
            logger.error("Error processing image %s: %s", path, e)

    return "\n\n".join(all_texts)
