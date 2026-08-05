"""
YouTube Service - Extract transcript/subtitles from YouTube videos.

Primary:  youtube-transcript-api  (fast, no extra deps)
Fallback: yt-dlp                  (more robust, bypasses IP bans)
"""

import re
import json
import logging
import os
import tempfile
import urllib.request
import urllib.parse
import functools
from typing import Optional, List

from app.features.llm import LlmCredential, generate_with_fallback

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# yt-dlp fallback helpers
# ---------------------------------------------------------------------------

def _ytdlp_fetch_timed(video_id: str, lang: str = "vi") -> List[dict]:
    """
    Use yt-dlp to download auto-generated / manual subtitles and return
    a list of {start, duration, text} dicts — same shape as youtube-transcript-api.

    yt-dlp writes a .vtt or .srv1/.json3 file; we read and parse it.
    Raises ValueError if subtitles cannot be fetched.
    """
    try:
        import yt_dlp  # noqa: F401 — just confirm it's installed
    except ImportError:
        raise RuntimeError("yt-dlp is not installed. Run: pip install yt-dlp")

    url = f"https://www.youtube.com/watch?v={video_id}"
    with tempfile.TemporaryDirectory() as tmpdir:
        output_tmpl = os.path.join(tmpdir, "sub")
        langs = [lang, "en"] if lang != "en" else ["en"]
        ydl_opts = {
            "skip_download": True,
            "writeautomaticsub": True,
            "writesubtitles": True,
            "subtitleslangs": langs,
            "subtitlesformat": "json3",
            "outtmpl": output_tmpl,
            "quiet": True,
            "no_warnings": True,
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if not info:
                raise ValueError("yt-dlp could not extract video info")

        # Find the downloaded subtitle file
        sub_file = None
        for candidate_lang in langs + ["en-US", "en-GB", "vi-VN"]:
            p = f"{output_tmpl}.{candidate_lang}.json3"
            if os.path.exists(p):
                sub_file = p
                break
        # Fallback: any json3
        if sub_file is None:
            for fname in os.listdir(tmpdir):
                if fname.endswith(".json3"):
                    sub_file = os.path.join(tmpdir, fname)
                    break
        if sub_file is None:
            raise ValueError(
                f"yt-dlp downloaded no subtitle file for video_id={video_id!r}"
            )

        with open(sub_file, encoding="utf-8") as f:
            data = json.load(f)

    result = []
    # json3 format: {"events": [{"tStartMs", "dDurationMs", "segs": [{"utf8"}]}]}
    events = data.get("events", [])
    for event in events:
        start_ms = event.get("tStartMs", 0)
        dur_ms = event.get("dDurationMs", 0)
        segs = event.get("segs", [])
        text = "".join(s.get("utf8", "") for s in segs).replace("\n", " ").strip()
        if text:
            result.append({
                "start": start_ms / 1000.0,
                "duration": dur_ms / 1000.0,
                "text": text,
            })
    if not result:
        raise ValueError("yt-dlp subtitle file was empty")
    logger.info(
        "yt-dlp fetched %d subtitle segments for video_id=%s", len(result), video_id
    )
    return result


def _ytdlp_fetch_text(video_id: str, lang: str = "vi") -> str:
    """Convenience wrapper — returns plain text from _ytdlp_fetch_timed."""
    entries = _ytdlp_fetch_timed(video_id, lang)
    return " ".join(e["text"] for e in entries)


def fetch_video_title(url: str) -> Optional[str]:
    """Fetch YouTube video title via the oEmbed endpoint (no API key needed)."""
    try:
        oembed_url = "https://www.youtube.com/oembed?" + urllib.parse.urlencode(
            {"url": url, "format": "json"}
        )
        req = urllib.request.Request(oembed_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("title")
    except Exception as e:
        logger.warning("Failed to fetch YouTube title for %s: %s", url, e)
        return None


def extract_video_id(url: str) -> Optional[str]:
    """
    Extract YouTube video ID from various URL formats:
    - https://www.youtube.com/watch?v=VIDEO_ID
    - https://youtu.be/VIDEO_ID
    - https://www.youtube.com/shorts/VIDEO_ID
    - https://www.youtube.com/embed/VIDEO_ID
    """
    patterns = [
        r"(?:youtube\.com/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})",
        r"(?:youtu\.be/)([A-Za-z0-9_-]{11})",
        r"(?:youtube\.com/(?:shorts|embed)/)([A-Za-z0-9_-]{11})",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


@functools.lru_cache(maxsize=128)
def extract_transcript(url: str, lang: str = "vi") -> str:
    """
    Extract transcript text from a YouTube video.

    Primary: youtube-transcript-api → Fallback: yt-dlp (bypasses IP bans)
    """
    video_id = extract_video_id(url)
    if not video_id:
        raise ValueError(f"Invalid YouTube URL: {url!r}")

    logger.info(f"Fetching transcript for video_id={video_id}, lang={lang}")

    # ── Primary: youtube-transcript-api ────────────────────────────────────
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        try:
            from youtube_transcript_api import NoTranscriptFound, TranscriptsDisabled
        except ImportError:
            try:
                from youtube_transcript_api._errors import (
                    NoTranscriptFound,
                    TranscriptsDisabled,
                )
            except ImportError:
                NoTranscriptFound = Exception
                TranscriptsDisabled = Exception

        _use_new_api = not hasattr(YouTubeTranscriptApi, "list_transcripts")
        if _use_new_api:
            api = YouTubeTranscriptApi()
            transcript_list = api.list(video_id)
        else:
            transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)

        transcript = None
        try:
            transcript = transcript_list.find_transcript([lang])
        except NoTranscriptFound:
            pass
        if transcript is None and lang != "en":
            try:
                transcript = transcript_list.find_transcript(["en"])
                logger.info("Falling back to English transcript")
            except NoTranscriptFound:
                pass
        if transcript is None:
            for t in transcript_list:
                transcript = t
                break

        if transcript is not None:
            entries = transcript.fetch()
            lines = []
            for entry in entries:
                if hasattr(entry, "text"):
                    text_val = str(entry.text).strip()
                else:
                    text_val = str(entry.get("text", "")).strip()
                if text_val:
                    lines.append(text_val)
            text = " ".join(lines)
            logger.info(
                "Extracted %d segments (%d chars) from video_id=%s",
                len(lines), len(text), video_id,
            )
            return text

    except Exception as e:
        logger.warning(
            "youtube-transcript-api failed for %s: %s — trying yt-dlp fallback",
            video_id, e,
        )

    # ── Fallback: yt-dlp ───────────────────────────────────────────────────
    try:
        text = _ytdlp_fetch_text(video_id, lang)
        logger.info("yt-dlp fallback succeeded for video_id=%s (%d chars)", video_id, len(text))
        return text
    except Exception as e2:
        raise ValueError(
            f"Could not fetch transcript for video {video_id!r}. "
            f"youtube-transcript-api and yt-dlp both failed. Last error: {e2}"
        ) from e2


@functools.lru_cache(maxsize=128)
def extract_transcript_timed(url: str, lang: str = "vi") -> List[dict]:
    """
    Extract transcript with timestamps from a YouTube video.

    Returns:
        List of {"start": float, "duration": float, "text": str}

    Primary: youtube-transcript-api → Fallback: yt-dlp (bypasses IP bans)
    """
    video_id = extract_video_id(url)
    if not video_id:
        raise ValueError(f"Invalid YouTube URL: {url!r}")

    # ── Primary: youtube-transcript-api ────────────────────────────────────
    try:
        from youtube_transcript_api import (
            YouTubeTranscriptApi,
            TranscriptsDisabled,
            NoTranscriptFound,
        )

        _use_new_api = not hasattr(YouTubeTranscriptApi, "list_transcripts")
        if _use_new_api:
            api = YouTubeTranscriptApi()
            transcript_list = api.list(video_id)
        else:
            transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)

        transcript = None
        try:
            transcript = transcript_list.find_transcript([lang])
        except NoTranscriptFound:
            pass
        if transcript is None and lang != "en":
            try:
                transcript = transcript_list.find_transcript(["en"])
            except NoTranscriptFound:
                pass
        if transcript is None:
            for t in transcript_list:
                transcript = t
                break

        if transcript is not None:
            entries = transcript.fetch()
            result = []
            for entry in entries:
                if hasattr(entry, "text"):
                    text_val = str(entry.text).strip()
                    start = float(getattr(entry, "start", 0))
                    duration = float(getattr(entry, "duration", 0))
                else:
                    text_val = str(entry.get("text", "")).strip()
                    start = float(entry.get("start", 0))
                    duration = float(entry.get("duration", 0))
                if text_val:
                    result.append({"start": start, "duration": duration, "text": text_val})
            return result

    except Exception as e:
        logger.warning(
            "youtube-transcript-api failed (timed) for %s: %s — trying yt-dlp fallback",
            video_id, e,
        )

    # ── Fallback: yt-dlp ───────────────────────────────────────────────────
    try:
        result = _ytdlp_fetch_timed(video_id, lang)
        logger.info("yt-dlp timed fallback succeeded for video_id=%s", video_id)
        return result
    except Exception as e2:
        raise ValueError(
            f"Could not fetch timed transcript for video {video_id!r}. "
            f"youtube-transcript-api and yt-dlp both failed. Last error: {e2}"
        ) from e2


# ---------------------------------------------------------------------------
# Transcript summarization — condense long transcripts into a rich outline
# ---------------------------------------------------------------------------

_SUMMARIZE_PROMPT = """\
Bạn là chuyên gia tóm tắt nội dung kỹ thuật và giáo dục. \
Dưới đây là transcript đầy đủ của một video (có thể rất dài). \
Hãy tóm tắt thành outline chi tiết bằng ngôn ngữ giống ngôn ngữ của transcript, theo yêu cầu sau:

1. Chia theo các phần/chủ đề chính được giảng dạy.
2. Liệt kê đầy đủ: khái niệm kỹ thuật, ví dụ code nổi bật, best practices, lỗi thường gặp, so sánh phương pháp.
3. Giữ nguyên các từ chuyên môn tiếng Anh (arrow function, async/await, React Hooks, v.v.).
4. Sửa các lỗi ASR phổ biến trong tiếng Việt (ví dụ: "rau fashion" → "arrow function").
5. KHÔNG bịa thêm thông tin ngoài transcript.
6. Độ dài tóm tắt: 6.000–10.000 ký tự.
7. Trả về ONLY văn bản outline thuần túy, KHÔNG markdown heading đặc biệt, KHÔNG chú thích thêm.

Transcript:
"""


def summarize_transcript(text: str, cred: LlmCredential) -> str:
    """
    Condense a long transcript into a dense outline (~8 000 chars) with one LLM call.

    - Reduces 200k–500k char transcripts to ~8 000 chars (80-90% token saving).
    - Covers the whole video (not just the intro).
    - Fixes ASR errors as a side effect (combines normalize + summarize).
    - Falls back silently to smart-sampled raw text if the call fails, because a
      worse quiz beats no quiz.
    """
    if not text.strip() or not cred:
        return text

    # A 1M-token context window comfortably fits this much text for summarization.
    MAX_INPUT_CHARS = 800_000
    truncated = text[:MAX_INPUT_CHARS] if len(text) > MAX_INPUT_CHARS else text

    try:
        result = generate_with_fallback(
            cred,
            _SUMMARIZE_PROMPT + truncated,
            max_output_tokens=8192,
            temperature=0.2,
        )
        summary = result.text.strip()
        if summary and len(summary) >= 500:
            logger.info(
                "Transcript summarized via %s/%s: %d → %d chars (%.1f%% reduction)",
                cred.provider, result.model, len(text), len(summary),
                (1 - len(summary) / len(text)) * 100,
            )
            return summary
        logger.warning("Summarization returned only %d chars — falling back to raw excerpt",
                       len(summary))
    except Exception as e:
        logger.warning("Transcript summarization skipped: %s — falling back to raw excerpt", e)

    # Fallback: return a smart-sampled slice of the raw text ≤ 40 000 chars
    if len(text) <= 40_000:
        return text
    # Sample beginning + middle + end
    chunk = 12_000
    separator = "\n\n[...]\n\n"
    return (
        text[:chunk]
        + separator
        + text[len(text) // 2 - chunk // 2: len(text) // 2 + chunk // 2]
        + separator
        + text[-chunk:]
    )


# ---------------------------------------------------------------------------
# Transcript normalization — fix ASR phonetic errors for tech/edu content
# ---------------------------------------------------------------------------

_NORMALIZE_PROMPT = """\
The following text is a Vietnamese automatic transcript (ASR) of a video about \
technology, programming, or education. ASR often mishears technical English loan-words \
in Vietnamese speech (e.g. "rau fashion" → "arrow function", "hàm a rô" → "arrow function", \
"ri-phắc-tơ" → "refactor", "a-sync" → "async", "e lờ" → "elif", etc.).

Your task:
1. Correct ONLY ASR/spelling mistakes for technical, programming, and educational terms.
2. Preserve the original Vietnamese sentence structures and all factual content EXACTLY.
3. Do NOT add information, do NOT summarize, do NOT rephrase normal sentences.
4. Do NOT remove any content.
5. Return ONLY the corrected plain text with NO commentary, NO markdown.

Transcript:
"""


def normalize_transcript(text: str, cred: LlmCredential) -> str:
    """
    Fix ASR phonetic errors in a Vietnamese technical transcript.

    Only spelling / term corrections are applied — factual content is unchanged.
    Falls back silently to the original text if the call fails.
    """
    if not text.strip() or not cred:
        return text

    # Keep the prompt+text within a safe input budget (~12 000 chars)
    budget = 12_000 - len(_NORMALIZE_PROMPT)
    truncated = text[:budget] if len(text) > budget else text

    try:
        result = generate_with_fallback(
            cred,
            _NORMALIZE_PROMPT + truncated,
            max_output_tokens=8192,
            temperature=0.1,        # low — we want faithful corrections only
        )
    except Exception as e:
        logger.warning("Transcript normalization skipped: %s", e)
        return text

    normalized = result.text.strip()
    if not normalized:
        return text
    # A result under 80% of the input length means the model summarized instead.
    if len(normalized) < len(truncated) * 0.8:
        logger.warning(
            "Transcript normalization result suspiciously short (%d vs %d chars) — using original",
            len(normalized), len(truncated),
        )
        return text

    tail = text[budget:] if len(text) > budget else ""
    combined = normalized + (" " + tail if tail else "")
    logger.info("Transcript normalized via %s/%s: %d → %d chars",
                cred.provider, result.model, len(text), len(combined))
    return combined
