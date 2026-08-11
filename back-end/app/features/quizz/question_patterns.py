"""
Recognising questions that are *already written* in a document.

Two consumers, deliberately kept dependency-free so both can import it:
  • `quiz_generator` — chunk an exam paper on question boundaries and reconcile
    the answer key at the end of the file.
  • `upload.document_processor` — score, at ingest time, how likely a material is
    to be a question bank, so the UI can nudge the user towards Import.

Everything here is regex and offsets.  No LLM call, no Flask app context: the
detector runs on every upload, including before any API key is configured.
"""

import re

# "Câu 1:", "Câu hỏi 12.", "Question 3)", "Bài 7 -", optionally wrapped in **bold**
Q_MARKER_STRICT_RE = re.compile(
    r"^[ \t]*(?:\*\*)?[ \t]*"
    r"(?:C[âa]u[ \t]*(?:h[oỏ]i[ \t]*)?|Question[ \t]*|Q[ \t]*|B[àa]i[ \t]*)"
    r"(\d{1,3})[ \t]*[.:)\-–\]]",
    re.IGNORECASE | re.MULTILINE,
)

# Bare "12." / "12)" at the start of a line.  Matches ordinary numbered prose too,
# so it is only ever used with the option-count guard in _collect_items().
Q_MARKER_LOOSE_RE = re.compile(r"^[ \t]*(\d{1,3})[ \t]*[.)][ \t]+(?=\S)", re.MULTILINE)

# "A. foo", "b) bar", "(C) baz", "* D. qux" — one answer option on its own line
OPTION_LINE_RE = re.compile(
    r"^[ \t]*(?:[*>•\-][ \t]*)?\(?([A-Da-dĐđ])\)?[ \t]*[.)\]:][ \t]*(\S.*)$",
    re.MULTILINE,
)

# A heading that introduces the answer key, usually on its own line near the end.
# Vietnamese is spelled with and without diacritics because OCR of a scanned exam
# routinely drops them, and this heading is the whole reason the key can be found.
ANSWER_KEY_HEADING_RE = re.compile(
    r"^[\s\W]{0,4}(?:(?:B[ẢA]NG[ \t]*)?[ĐD][ÁA]P[ \t]*[ÁA]N"
    r"(?:[ \t]*(?:THAM[ \t]*KH[ẢA]O|CHI[ \t]*TI[ẾE]T|[ĐD][ỀE][ \t]*\d+))?"
    r"|ANSWER[ \t]*KEYS?|ANSWERS?|KEY"
    r"|H[ƯU][ỚO]NG[ \t]*D[ẪA]N[ \t]*(?:GI[ẢA]I|CH[ẤA]M))[\s\W]{0,10}$",
    re.IGNORECASE | re.MULTILINE,
)

# "1.A", "Câu 12: C", "7 - B" — only ever applied *inside* an accepted key section,
# because on body text it would match half the prose in the document.
ANSWER_PAIR_RE = re.compile(r"(?:C[âa]u[ \t]*)?(\d{1,3})[ \t]*[.:\-–—)]?[ \t]*([A-Da-dĐđSs])(?![\w])")

# "Đáp án: B", "ĐA: A, C", "Answer - D" sitting directly under a question
INLINE_ANSWER_RE = re.compile(
    r"^[ \t]*\*{0,2}(?:[ĐD][áa]p[ \t]*[áa]n|[ĐD]A|Answer|Ans|Key)[ \t]*(?:đúng|dung)?[ \t]*[:.\-–][ \t]*"
    r"\**[ \t]*([A-Da-d](?:[ \t]*[,/][ \t]*[A-Da-d])*)\b",
    re.IGNORECASE | re.MULTILINE,
)

PAGE_MARKER_RE = re.compile(r"^---[ \t]*TRANG[ \t]+(\d+)[ \t]*---[ \t]*$", re.MULTILINE)

# Fewer items than this and the document is prose that happens to be numbered.
MIN_ITEMS = 3

# A material scoring at or above this is presented to the user as a question bank.
QUESTION_BANK_THRESHOLD = 0.45

_WS_RE = re.compile(r"\s+")
_LEADING_NUMBER_RE = re.compile(
    r"^[\s\W]*(?:c[âa]u|question|q|b[àa]i)?[\s.:)\-]*\d{1,3}[\s.:)\-]*",
    re.IGNORECASE,
)


def normalize_question_key(text: str) -> str:
    """Collapse a question stem to a comparable key: no numbering, no whitespace noise."""
    return _WS_RE.sub(" ", _LEADING_NUMBER_RE.sub("", text or "")).strip().lower()


def _collect_items(text: str) -> list[dict]:
    """
    Locate every question in `text` as a half-open span.

    Tries the strict "Câu N" family first.  Falls back to bare "N." numbering only
    when each candidate carries at least two option lines, which is what separates
    an exam paper from a numbered list in a textbook.
    """
    matches = list(Q_MARKER_STRICT_RE.finditer(text))

    if len(matches) < MIN_ITEMS:
        loose = list(Q_MARKER_LOOSE_RE.finditer(text))
        kept = []
        for i, m in enumerate(loose):
            end = loose[i + 1].start() if i + 1 < len(loose) else len(text)
            if len(OPTION_LINE_RE.findall(text[m.start():end])) >= 2:
                kept.append(m)
        matches = kept

    if len(matches) < MIN_ITEMS:
        return []

    items = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        items.append({
            "number": int(m.group(1)),
            "start": m.start(),
            "end": end,
            "text": text[m.start():end].strip(),
        })
    return items


def split_on_question_boundaries(
    text: str, max_chunk_size: int,
) -> tuple[list[dict], str]:
    """
    Pack whole questions into chunks of at most `max_chunk_size` chars.

    Returns `(chunks, prelude)`.  Each chunk is `{"text", "items"}` where `items`
    carries the original question numbers and offsets; `prelude` is whatever came
    before the first question (a cover page, a lecture section) and is not part of
    any chunk.

    Deliberately no overlap.  Overlap exists to carry prose context across a cut,
    but a question is self-contained by construction — and overlap is exactly what
    makes the same question arrive twice from two workers.

    Returns `([], text)` when the text has no recognisable question structure, so
    the caller can fall back to paragraph chunking.
    """
    items = _collect_items(text)
    if not items:
        return [], text

    prelude = text[: items[0]["start"]].strip()

    chunks: list[dict] = []
    current: list[dict] = []
    current_len = 0

    for item in items:
        size = len(item["text"])
        if current and current_len + size > max_chunk_size:
            chunks.append({
                "text": "\n\n".join(i["text"] for i in current),
                "items": current,
            })
            current, current_len = [], 0
        current.append(item)
        current_len += size + 2

    if current:
        chunks.append({
            "text": "\n\n".join(i["text"] for i in current),
            "items": current,
        })

    return chunks, prelude


def find_answer_key(text: str) -> tuple[str, str, dict[int, str]]:
    """
    Split a trailing answer key off the document.

    Returns `(body, key_text, key_map)`.  `key_map` maps a question number to the
    lowercase letter of its correct option; both `key_text` and `key_map` are empty
    when no key is found.

    Acceptance is deliberately strict — the heading must sit in the last 40 % of
    the document, the tail must yield at least `MIN_ITEMS` number→letter pairs, and
    those numbers must be mostly ascending.  A prose section containing "1. A" must
    not be mistaken for a key, because a false positive silently rewrites answers.
    """
    if not text:
        return text, "", {}

    cutoff = int(len(text) * 0.6)
    heading = None
    for m in ANSWER_KEY_HEADING_RE.finditer(text):
        if m.start() >= cutoff:
            heading = m

    if heading is None:
        return text, "", {}

    tail = text[heading.end():]
    pairs = ANSWER_PAIR_RE.findall(tail)
    if len(pairs) < MIN_ITEMS:
        return text, "", {}

    numbers = [int(n) for n, _ in pairs]
    steps = len(numbers) - 1
    ascending = sum(1 for a, b in zip(numbers, numbers[1:]) if b >= a)
    if ascending < steps * 0.7:
        return text, "", {}

    key_map = {int(n): letter.lower() for n, letter in pairs}
    return text[: heading.start()], text[heading.start():].strip(), key_map


def score_question_bank(text: str) -> float:
    """
    How strongly a document looks like it already contains quiz questions, 0..1.

    Heuristic on purpose: this runs on every upload, including 200-page PDFs and
    before any API key exists, and it only drives a UI nudge.  An LLM call here
    would block the per-folder processing queue and burn the shared key pool for
    a hint.
    """
    if not text or len(text) < 200:
        return 0.0

    markers = Q_MARKER_STRICT_RE.findall(text)
    if len(markers) < MIN_ITEMS:
        return 0.0

    option_runs = _count_option_runs(text)
    has_key = 1.0 if find_answer_key(text)[2] else 0.0

    # A Vietnamese MCQ item (stem + 4 options) runs 250-500 chars; 1 200 is
    # conservative on purpose so a document that is only ~30 % questions still
    # scores well above the threshold.
    expected = max(1.0, len(text) / 1200.0)

    return round(
        0.55 * min(1.0, len(markers) / expected)
        + 0.35 * min(1.0, option_runs / expected)
        + 0.10 * has_key,
        4,
    )


def _count_option_runs(text: str) -> int:
    """Number of places where at least 3 distinct option letters appear in a row."""
    letters = [m.group(1).lower() for m in OPTION_LINE_RE.finditer(text)]
    runs = 0
    seen: list[str] = []
    for letter in letters:
        if seen and letter in seen:
            if len(seen) >= 3:
                runs += 1
            seen = [letter]
        else:
            seen.append(letter)
    if len(seen) >= 3:
        runs += 1
    return runs
