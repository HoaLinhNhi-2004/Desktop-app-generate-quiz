"""
Text Processing - Clean and chunk extracted text for LLM consumption
"""

import re
import logging
from collections import Counter

from app.features.quizz.question_patterns import (
    OPTION_LINE_RE,
    QUESTION_BANK_THRESHOLD,
    score_question_bank,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Boilerplate / non-knowledge content filtering
# ---------------------------------------------------------------------------

# Section headings that mark non-knowledge content (case-insensitive).
# When one of these is detected as a section heading, everything from that
# heading until the next heading of equal or higher importance is removed.
_BOILERPLATE_SECTION_PATTERNS: list[re.Pattern] = [
    re.compile(p, re.IGNORECASE) for p in [
        # English
        r"^(?:table\s+of\s+contents|contents)$",
        r"^(?:list\s+of\s+(?:figures|tables|abbreviations|symbols))$",
        r"^(?:acknowledgements?|acknowledgments?)$",
        r"^(?:references?|bibliography|works?\s+cited)$",
        r"^(?:index)$",
        r"^(?:appendi(?:x|ces)\s*[A-Z]?)$",
        r"^(?:foreword|preface)$",
        r"^(?:about\s+the\s+authors?|author\s+biograph(?:y|ies))$",
        r"^(?:glossary)$",
        r"^(?:copyright|colophon|disclaimer)$",
        # Vietnamese
        r"^(?:mục\s+lục|bảng\s+mục\s+lục)$",
        r"^(?:danh\s+mục\s+(?:bảng|hình|từ\s+viết\s+tắt|ký\s+hiệu|tài\s+liệu))$",
        r"^(?:lời\s+(?:nói\s+đầu|cảm\s+ơn|cam\s+đoan|mở\s+đầu))$",
        r"^(?:tài\s+liệu\s+tham\s+khảo)$",
        r"^(?:phụ\s+lục\s*[A-Z0-9]?)$",
        r"^(?:chú\s+thích|chú\s+giải)$",
    ]
]

# Lines that look like TOC entries: "Chapter 1 ......... 12" or "1.2 Something ... 45"
_TOC_LINE_RE = re.compile(
    r"^.{3,80}\s*[.·…]{3,}\s*\d{1,4}\s*$"  # text followed by dots and page number
)

# Standalone page numbers
_PAGE_NUMBER_RE = re.compile(
    r"^\s*(?:"
    r"\d{1,4}"                           # plain "42"
    r"|page\s+\d{1,4}(?:\s+of\s+\d+)?"  # "Page 42" or "Page 42 of 100"
    r"|trang\s+\d{1,4}"                  # "Trang 42"
    r"|[-–—]\s*\d{1,4}\s*[-–—]"          # "– 42 –"
    r")\s*$",
    re.IGNORECASE,
)

# Lines that look like index entries: "term, 105" or "term  105, 190"
_INDEX_ENTRY_RE = re.compile(
    r"^[A-Za-zÀ-ỹ*].{1,60},?\s+\d{1,4}(?:[,\s]+\d{1,4})*\s*$"
)

# Very short lines that are likely headers/footers when they repeat
_SHORT_LINE_MAX = 80

# Marks that mean nothing when they stand alone between two spaces — typically
# scanner speckle or a mis-read diacritic. Deliberately narrow: anything not
# listed here survives, because operators (`+ - = < > ± → ∈ ⇒ / * ^ | %`) and
# ordinary punctuation are load-bearing in the subjects this app is used for.
_OCR_SPECKLE_RE = re.compile(r"(?<=\s)[`´¨¦¤§¶·¬]+(?=\s)")


def _is_heading_line(line: str) -> bool:
    """Heuristic: line looks like a section heading (short, no trailing period)."""
    stripped = line.strip()
    if not stripped or len(stripped) > 120:
        return False
    # Skip lines that look like index entries
    if _INDEX_ENTRY_RE.match(stripped):
        return False
    # All-caps line or numbered heading like "Chapter 1", "1.2 Something"
    if stripped.isupper() and len(stripped) > 3:
        return True
    if re.match(r"^(?:chapter|chương|phần|bài|section)\s+\d", stripped, re.IGNORECASE):
        return True
    if re.match(r"^\d{1,2}(?:\.\d{1,2}){0,3}\s+\S", stripped):
        return True
    # Title-case short line without trailing punctuation — require multiple words
    # and at least one capitalized word to avoid matching arbitrary short lines
    if len(stripped) < 80 and not stripped.endswith(('.', ',', ';', '!', '?')):
        words = stripped.split()
        if 2 <= len(words) <= 10:
            has_cap = any(w[0].isupper() for w in words if w and w[0].isalpha())
            if has_cap:
                return True
    return False


def _is_boilerplate_heading(line: str) -> bool:
    """Check if a heading line matches a known boilerplate section title."""
    stripped = line.strip()
    # Remove leading numbering: "1.2" or "Chapter 3:" etc.
    cleaned = re.sub(r"^[\d.]+\s*", "", stripped)
    cleaned = re.sub(r"^(?:chapter|chương|phần|bài|section)\s+\d+[.:)]*\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.strip(" .:;-–—")
    if not cleaned:
        return False
    for pat in _BOILERPLATE_SECTION_PATTERNS:
        if pat.match(cleaned):
            return True
    return False


def filter_boilerplate(text: str) -> str:
    """
    Remove non-knowledge content from extracted document text:
      1. Page numbers (standalone lines)
      2. TOC-style lines (text followed by dots and page number)
      3. Repeated short lines (headers/footers that appear on every page)
      4. Entire boilerplate sections (TOC, References, Index, etc.)

    Answer options are exempt from rule 3. In a multiple-choice paper "A. Đúng"
    and "B. Sai" repeat once per question, which is precisely the signature this
    filter used to read as a page footer — so every true/false paper arrived at
    the model with its options deleted. Import mode was given a bypass in
    900e340; generate and RAG ingest still run through here, so the exemption
    belongs in the filter itself.

    Returns the filtered text.
    """
    if not text:
        return text

    # A bare "12" on its own line is a page number in a textbook and a question
    # number in an exam paper. Only strip them when the document does not look
    # like a question bank.
    looks_like_exam = score_question_bank(text) >= QUESTION_BANK_THRESHOLD

    lines = text.split("\n")

    # --- Pass 1: Remove standalone page numbers & TOC dot-lines ---
    filtered_lines: list[str] = []
    for line in lines:
        if not looks_like_exam and _PAGE_NUMBER_RE.match(line):
            continue
        if _TOC_LINE_RE.match(line):
            continue
        filtered_lines.append(line)

    # --- Pass 2: Detect & remove repeated headers/footers ---
    # Short lines that appear 3+ times are likely page headers/footers
    short_lines = [l.strip() for l in filtered_lines if 0 < len(l.strip()) <= _SHORT_LINE_MAX]
    counts = Counter(short_lines)
    repeated = {
        line for line, cnt in counts.items()
        if cnt >= 3 and not OPTION_LINE_RE.match(line)
    }
    if repeated:
        filtered_lines = [
            l for l in filtered_lines
            if l.strip() not in repeated or len(l.strip()) == 0
        ]

    # --- Pass 3: Remove boilerplate sections ---
    # Walk through lines; when a boilerplate heading is found, skip until the
    # next non-boilerplate heading.
    result_lines: list[str] = []
    skipping = False
    for line in filtered_lines:
        stripped = line.strip()

        if _is_heading_line(stripped):
            if _is_boilerplate_heading(stripped):
                skipping = True
                logger.debug("Filtering boilerplate section: %s", stripped)
                continue
            else:
                skipping = False

        if not skipping:
            result_lines.append(line)

    removed_chars = len(text) - len("\n".join(result_lines))
    if removed_chars > 0:
        logger.info(
            "Boilerplate filter removed ~%d chars (%.1f%% of %d)",
            removed_chars, removed_chars / len(text) * 100, len(text),
        )

    return "\n".join(result_lines)


def clean_text(text: str) -> str:
    """
    Clean OCR/PDF extracted text:
    - Remove excessive whitespace
    - Fix common OCR artifacts
    - Normalize line breaks
    """
    if not text:
        return ""

    # Normalize whitespace
    text = re.sub(r'\r\n', '\n', text)
    text = re.sub(r'\t', ' ', text)

    # Remove excessive blank lines (more than 2 consecutive)
    text = re.sub(r'\n{3,}', '\n\n', text)

    # Remove excessive spaces
    text = re.sub(r' {3,}', ' ', text)

    # Remove isolated speckle the OCR invented between words.
    #
    # This used to be `(?<=\s)[^\w\s](?=\s)` — every isolated non-word character.
    # That deletes the operators in "x + 2 = 5" (→ "x  2  5"), and takes `-`, `<`,
    # `>`, `±`, `→`, `∈`, `⇒` with them, so maths, physics and chemistry papers
    # lost their meaning on both the generate path and RAG ingest. An explicit
    # deny-list of marks that carry no meaning standing alone is the safe
    # direction to be wrong in: leaving a stray glyph costs nothing.
    text = _OCR_SPECKLE_RE.sub('', text)

    return text.strip()


def chunk_text(text: str, max_chunk_size: int = 4000, overlap: int = 200) -> list[str]:
    """
    Split text into chunks suitable for LLM processing.
    Tries to split at paragraph boundaries.

    Args:
        text: The full text to chunk
        max_chunk_size: Maximum characters per chunk
        overlap: Number of overlapping characters between chunks
    
    Returns:
        List of text chunks
    """
    if len(text) <= max_chunk_size:
        return [text]

    # Split by paragraphs first
    paragraphs = text.split('\n\n')
    chunks = []
    current_chunk = ""

    for para in paragraphs:
        # If single paragraph exceeds max size, split by sentences
        if len(para) > max_chunk_size:
            if current_chunk:
                chunks.append(current_chunk.strip())
                current_chunk = ""
            sentence_chunks = _split_by_sentences(para, max_chunk_size, overlap)
            chunks.extend(sentence_chunks)
            continue

        # If adding this paragraph exceeds limit, start new chunk
        if len(current_chunk) + len(para) + 2 > max_chunk_size:
            chunks.append(current_chunk.strip())
            # Keep some overlap
            if overlap > 0 and len(current_chunk) > overlap:
                current_chunk = current_chunk[-overlap:] + "\n\n" + para
            else:
                current_chunk = para
        else:
            if current_chunk:
                current_chunk += "\n\n" + para
            else:
                current_chunk = para

    if current_chunk.strip():
        chunks.append(current_chunk.strip())

    logger.info(f"Split text ({len(text)} chars) into {len(chunks)} chunks")
    return chunks


def _split_by_sentences(text: str, max_size: int, overlap: int) -> list[str]:
    """Split a large paragraph by sentence boundaries"""
    # Simple sentence splitting for Vietnamese/English
    sentences = re.split(r'(?<=[.!?。])\s+', text)
    chunks = []
    current = ""

    for sentence in sentences:
        if len(current) + len(sentence) + 1 > max_size:
            if current:
                chunks.append(current.strip())
            current = sentence
        else:
            current = (current + " " + sentence).strip() if current else sentence

    if current.strip():
        chunks.append(current.strip())

    return chunks


def chunk_importance(chunk: str) -> float:
    """
    Score a chunk by its density of technical content.
    Higher score = more likely to contain teachable knowledge.

    Heuristics:
    - English technical words (camelCase, PascalCase, snake_case, abbreviations)
    - Code-like punctuation (., (), [], {}, =, ->, =>)
    - Short all-caps tokens (API, SQL, HTTP, etc.)
    """
    words = chunk.split()
    if not words:
        return 0.0

    technical = 0
    for word in words:
        # CamelCase / PascalCase (e.g. useState, MyClass)
        if re.match(r'[a-z][a-zA-Z0-9]*[A-Z]|[A-Z][a-z]+[A-Z]', word):
            technical += 2
        # snake_case (e.g. get_user, my_func)
        elif re.match(r'[a-z_]+_[a-z_]+', word):
            technical += 2
        # ALL_CAPS abbreviation ≥ 2 chars (API, SQL, HTTP)
        elif re.match(r'^[A-Z]{2,}$', word.strip('.,;:()[]{}')):
            technical += 2
        # English-like technical word starting with upper (useState, React, async)
        elif re.match(r'^[A-Za-z][a-zA-Z0-9]+$', word) and any(c.isupper() for c in word[1:]):
            technical += 1
        # Code punctuation patterns
        elif re.search(r'[()\[\]{}=<>\->/]', word):
            technical += 1

    return technical / len(words)


# Below this spread between the best and worst chunk, the ranking carries no
# information and "most important" is just "first".
_SCORE_SPREAD_MIN = 0.02

# How much source text one question is allowed to draw on, and the bounds on the
# total. The old rule was a flat 40 000 characters no matter what: a 5-question
# quiz got the same budget as a 60-question one, and a 400-page textbook had
# ~95 % of it thrown away *after* being fully extracted and OCR'd.
_CHARS_PER_QUESTION = 2_500
_MIN_SOURCE_CHARS = 40_000
_MAX_SOURCE_CHARS = 120_000
_SELECT_CHUNK_SIZE = 8_000


def select_source_text(cleaned: str, num_questions: int) -> str:
    """Pick the slice of a document that will be sent to the model.

    Short documents pass through untouched. Longer ones are chunked and sampled,
    with a budget that grows with the number of questions requested, because
    asking for 50 questions out of the same 40 000 characters is what produces
    near-duplicate items.

    Downstream cost stays bounded: `quiz_generator` merges anything beyond
    `_MAX_PARALLEL_CHUNKS` into that many calls, so a larger budget buys wider
    coverage per call rather than more calls.
    """
    if not cleaned:
        return cleaned

    budget = min(
        _MAX_SOURCE_CHARS,
        max(_MIN_SOURCE_CHARS, max(1, num_questions) * _CHARS_PER_QUESTION),
    )
    if len(cleaned) <= budget:
        return cleaned

    chunks = chunk_text(cleaned, max_chunk_size=_SELECT_CHUNK_SIZE)
    keep = max(1, budget // _SELECT_CHUNK_SIZE)
    selected = select_important_chunks(chunks, n=keep)
    source = "\n\n".join(selected)

    if len(source) > budget:
        source = source[:budget]
    logger.info(
        "Source selection: %d chars → %d chars (%d of %d chunks, %d questions)",
        len(cleaned), len(source), len(selected), len(chunks), num_questions,
    )
    return source


def _evenly_spaced(count: int, n: int) -> list[int]:
    """`n` indices spread across `range(count)`, always including first and last."""
    if n <= 1:
        return [0]
    step = (count - 1) / (n - 1)
    return sorted({min(count - 1, round(i * step)) for i in range(n)})


def select_important_chunks(chunks: list[str], n: int = 5) -> list[str]:
    """
    Select N chunks that represent the document.

    `chunk_importance` scores English technical writing — camelCase, snake_case,
    ALL_CAPS abbreviations, code punctuation. Vietnamese prose (Văn, Sử, Địa)
    scores at or near zero on every chunk, and `sorted` is stable, so "the six
    most important chunks" silently degenerated into chunks 0-4 plus the last —
    the cover, the table of contents and the back page of a 400-page book.

    When the scores actually separate the chunks, use them. When they do not,
    sample evenly across the document instead, so questions come from the whole
    of it rather than the front matter.

    Returns chunks in their original order.
    """
    if len(chunks) <= n:
        return chunks

    scores = [chunk_importance(c) for c in chunks]
    if max(scores) - min(scores) < _SCORE_SPREAD_MIN:
        logger.info(
            "Chunk importance is flat (spread %.4f over %d chunks) — sampling evenly",
            max(scores) - min(scores), len(chunks),
        )
        return [chunks[i] for i in _evenly_spaced(len(chunks), n)]

    scored = sorted(enumerate(chunks), key=lambda x: scores[x[0]], reverse=True)

    # Collect top-N indices, always include first and last
    selected_indices = {0, len(chunks) - 1}
    for idx, _ in scored:
        if len(selected_indices) >= n:
            break
        selected_indices.add(idx)

    # Return in original order
    return [chunks[i] for i in sorted(selected_indices)]
