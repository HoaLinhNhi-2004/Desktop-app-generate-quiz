"""Plain-text file reading.

Smart Import accepted `.txt` but no extractor handled it, so those records went
straight to `failed`.

Encoding is guessed rather than assumed: Vietnamese notes exported from older
Windows tools arrive as UTF-16 or CP1258, and decoding those as UTF-8 yields
either an exception or mojibake that reaches the model as gibberish.
"""

import os
import logging

logger = logging.getLogger(__name__)

# Ordered by likelihood for this app's users. `utf-8-sig` first so a BOM is
# consumed rather than turning into a leading ZERO WIDTH NO-BREAK SPACE.
_ENCODINGS = ("utf-8-sig", "utf-16", "cp1258", "cp1252", "latin-1")

MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024


def extract_text_from_txt(path: str) -> str:
    if not os.path.exists(path):
        raise FileNotFoundError(f"Text file not found: {path}")

    size = os.path.getsize(path)
    if size > MAX_TEXT_FILE_BYTES:
        raise ValueError(
            f"File văn bản quá lớn ({size // (1024 * 1024)} MB). "
            f"Giới hạn là {MAX_TEXT_FILE_BYTES // (1024 * 1024)} MB."
        )

    raw = open(path, "rb").read()
    for encoding in _ENCODINGS:
        try:
            text = raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
        logger.info(
            "Read %s (%d chars) as %s", os.path.basename(path), len(text), encoding,
        )
        return text

    # latin-1 never raises, so reaching here means the file is not text at all.
    raise ValueError("Không giải mã được nội dung file văn bản.")
