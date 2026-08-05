"""
Quiz Generator Service - Generate quiz questions with whichever LLM provider
the user configured (see `app.features.llm`).

Optimization strategy (Lost-in-the-Middle fix):
  ┌──────────────────────────────────────────────────────────┐
  │  text ≤ 8 000 chars  → single LLM call  (fast)           │
  │  text > 8 000 chars  → multi-chunk parallel calls        │
  │    • split into ≤4 chunks of ≤7 000 chars each           │
  │    • generate questions from each chunk in parallel       │
  │    • deduplicate + merge to exactly num_questions         │
  │    • coverage map injected into each chunk prompt         │
  └──────────────────────────────────────────────────────────┘

Chunks run on a ThreadPoolExecutor with no Flask app context, so everything
below takes an already-selected `LlmCredential` and never touches the DB.
"""

import copy
import hashlib
import json
import re
import threading
import uuid
import logging
import os
import datetime
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed

from app.features.llm import LlmCredential, generate_with_fallback, stream_with_fallback

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tuning constants
# ---------------------------------------------------------------------------
# Below this size → single call; above → multi-chunk parallel generation
_SINGLE_CALL_THRESHOLD = 8_000   # chars

# Each chunk sent to the model will be at most this many chars
_MAX_CHUNK_SIZE = 7_000           # chars

# Overlap between adjacent chunks (context continuity at boundaries)
_CHUNK_OVERLAP = 500              # chars

# Maximum parallel LLM calls (avoids hammering quota)
_MAX_PARALLEL_CHUNKS = 6

# Maximum questions per single API call — Vietnamese JSON is ~400 tokens/question;
# exceeding this with 8 192 output-token cap causes truncation.
_MAX_QUESTIONS_PER_CALL = 15

# Import mode has no target count — this is only a runaway guard for the sink.
_IMPORT_QUESTION_CAP = 500

# ---------------------------------------------------------------------------
# Quiz Difficulty Engine Constants
# ---------------------------------------------------------------------------

DIFFICULTY_RULES = {
    "easy": {
        "types": ["definition", "fact"],
        "description": "Simple recall, direct from text"
    },
    "medium": {
        "types": ["explanation", "workflow"],
        "description": "Requires understanding relationships"
    },
    "hard": {
        "types": ["scenario", "reasoning"],
        "description": "Requires multi-step thinking or real-world application"
    },
    "mixed": {
        "types": ["definition", "fact", "explanation", "workflow", "scenario", "reasoning"],
        "description": "A balanced mix of easy recall, medium relationship-understanding, and hard multi-step reasoning"
    }
}

QUESTION_TYPE_PROMPTS = {
    "definition": "Ask about definitions or basic facts",
    "fact": "Ask about specific details directly from the text",
    "explanation": "Ask why or how something works",
    "workflow": "Ask about process, steps, or pipeline",
    "scenario": "Create a real-world situation and ask for best solution",
    "reasoning": "Ask a question that requires multi-step thinking"
}

# ---------------------------------------------------------------------------
# Simple in-memory LRU cache (avoids redundant Gemini calls during testing)
# ---------------------------------------------------------------------------
_CACHE_MAX = 30
_quiz_cache: OrderedDict[str, list[dict]] = OrderedDict()


def _cache_key(text: str, num_questions: int, question_type: str, difficulty: str, language: str) -> str:
    raw = f"{text}|{num_questions}|{question_type}|{difficulty}|{language}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _cache_get(key: str) -> list[dict] | None:
    if key in _quiz_cache:
        _quiz_cache.move_to_end(key)
        return _quiz_cache[key]
    return None


def _cache_put(key: str, value: list[dict]) -> None:
    if key in _quiz_cache:
        _quiz_cache.move_to_end(key)
    _quiz_cache[key] = value
    if len(_quiz_cache) > _CACHE_MAX:
        _quiz_cache.popitem(last=False)


def _calc_max_output_tokens(num_questions: int, question_type: str) -> int:
    """Calculate output token budget based on expected response size.

    Vietnamese JSON is ~400 tokens per question. Gemini 2.5 models support
    up to 65 536 output tokens, so we can be generous to prevent truncation.
    """
    estimated = num_questions * 500  # generous per-question estimate
    return min(65_536, max(8_192, estimated))


# ---------------------------------------------------------------------------
# Debug helpers
# ---------------------------------------------------------------------------

def _save_debug_file(suffix: str, content: str, meta: str = "") -> None:
    """Write content to back-end/app/features/quizz/debug/<suffix>_<ts>.txt"""
    try:
        debug_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "debug")
        os.makedirs(debug_dir, exist_ok=True)
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        path = os.path.join(debug_dir, f"{suffix}_{ts}.txt")
        with open(path, "w", encoding="utf-8") as f:
            if meta:
                f.write(meta + "\n" + "=" * 80 + "\n\n")
            f.write(content)
        logger.info("Debug file: %s", path)
    except Exception as e:
        logger.warning("Could not write debug file: %s", e)


# ---------------------------------------------------------------------------
# Text splitting helpers
# ---------------------------------------------------------------------------

def _split_into_chunks(text: str, max_chunk_size: int = _MAX_CHUNK_SIZE, overlap: int = _CHUNK_OVERLAP) -> list[str]:
    """
    Split text into chunks of at most max_chunk_size chars, honouring
    paragraph (double-newline) boundaries wherever possible.

    Adjacent chunks share `overlap` characters so that context at boundaries
    is not lost when each chunk is processed independently by the LLM.

    Example with max_chunk_size=7000, overlap=500:
      chunk1: chars   0 – 7000
      chunk2: chars 6500 – 13500
      chunk3: chars 13000 – 20000
    """
    if len(text) <= max_chunk_size:
        return [text]

    paragraphs = text.split("\n\n")
    chunks: list[str] = []
    current = ""

    for para in paragraphs:
        # If a single paragraph is already bigger than the limit, force-split it
        if len(para) > max_chunk_size:
            if current.strip():
                chunks.append(current.strip())
                current = ""
            # Hard-split on sentence boundary
            sentences = re.split(r"(?<=[.!?。])\s+", para)
            sub = ""
            for sent in sentences:
                if len(sub) + len(sent) + 1 > max_chunk_size and sub:
                    chunks.append(sub.strip())
                    sub = sent
                else:
                    sub = (sub + " " + sent).strip() if sub else sent
            if sub.strip():
                chunks.append(sub.strip())
            continue

        if len(current) + len(para) + 2 > max_chunk_size and current:
            chunks.append(current.strip())
            current = para
        else:
            current = (current + "\n\n" + para).strip() if current else para

    if current.strip():
        chunks.append(current.strip())

    # Apply overlap: prepend tail of previous chunk to each subsequent chunk
    if overlap > 0 and len(chunks) > 1:
        overlapped = [chunks[0]]
        for i in range(1, len(chunks)):
            prev = chunks[i - 1]
            tail = prev[-overlap:] if len(prev) > overlap else prev
            # Try to start the overlap at a word boundary to avoid mid-word cuts
            space_idx = tail.find(" ")
            if space_idx > 0:
                tail = tail[space_idx + 1:]
            overlapped.append(tail + "\n\n" + chunks[i])
        chunks = overlapped

    return chunks


def _extract_section_titles(text: str) -> list[str]:
    """
    Try to find section/chapter headings in the text (Roman numerals, markdown ##,
    numbered lists, ALL-CAPS lines, etc.) and return up to 12 titles.
    Used to build the coverage map injected into each chunk prompt.
    """
    patterns = [
        r"^((?:[IVXLCDM]+|[0-9]+)\.\s+.{3,60})$",   # I. Title or 1. Title
        r"^(#{1,3}\s+.{3,60})$",                      # ## Markdown heading
        r"^([A-Z][A-Z\s]{4,50})$",                    # ALL CAPS HEADING
        r"^(\*\*[^*]{3,60}\*\*)$",                    # **Bold heading**
    ]
    titles: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        for pat in patterns:
            if re.match(pat, line):
                title = re.sub(r"[#*]", "", line).strip()
                if title and title not in titles:
                    titles.append(title)
                break
    return titles[:12]


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------

def _deduplicate_questions(questions: list[dict]) -> list[dict]:
    """
    Remove near-duplicate questions (similarity > 0.70).
    Preserves insertion order.
    """
    import difflib
    seen: list[str] = []
    result: list[dict] = []
    for q in questions:
        qt = q.get("questionText", "").lower().strip()
        is_dup = any(
            difflib.SequenceMatcher(None, qt, s).ratio() > 0.70
            for s in seen
        )
        if not is_dup:
            seen.append(qt)
            result.append(q)
    return result


# ---------------------------------------------------------------------------
# Incremental streaming: parse + emit questions as they arrive
# ---------------------------------------------------------------------------


class _StreamingArrayParser:
    """
    Resumable scanner over a growing JSON buffer.

    `feed(delta)` returns the array elements that became complete since the last
    call, so questions can be emitted while Gemini is still writing.  Handles the
    three shapes the model actually produces: a raw array, a fenced array
    (```json ... ```), and a wrapper object ({"questions": [...]}).

    A stack — not a brace counter — is what makes the wrapper case work: there
    the elements sit at depth 2, and a plain counter would emit nothing until the
    wrapper closed at the very end.
    """

    def __init__(self) -> None:
        self._buf = ""
        self._pos = 0
        self._stack: list[str] = []
        self._in_string = False
        self._escaped = False
        self._target_depth: int | None = None
        self._obj_start = -1
        self._emitted = 0

    @property
    def buffer(self) -> str:
        return self._buf

    @property
    def emitted_count(self) -> int:
        return self._emitted

    def feed(self, delta: str) -> list[dict]:
        self._buf += delta
        found: list[dict] = []

        while self._pos < len(self._buf):
            ch = self._buf[self._pos]
            i = self._pos
            self._pos += 1

            if self._in_string:
                if self._escaped:
                    self._escaped = False
                elif ch == "\\":
                    self._escaped = True
                elif ch == '"':
                    self._in_string = False
                continue

            if ch == '"':
                self._in_string = True
            elif ch == "[":
                self._stack.append("[")
                if self._target_depth is None:
                    self._target_depth = len(self._stack)
            elif ch == "{":
                if self._target_depth is not None and len(self._stack) == self._target_depth:
                    self._obj_start = i
                self._stack.append("{")
            elif ch == "}":
                if self._stack:
                    self._stack.pop()
                if (
                    self._target_depth is not None
                    and len(self._stack) == self._target_depth
                    and self._obj_start >= 0
                ):
                    raw = self._buf[self._obj_start : i + 1]
                    self._obj_start = -1
                    try:
                        obj = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(obj, dict):
                        self._emitted += 1
                        found.append(obj)
            elif ch == "]":
                if self._stack:
                    self._stack.pop()

        return found


class _QuestionSink:
    """
    Thread-safe collector shared by the parallel chunk workers.

    Owns deduplication, numbering and the question quota so that questions can be
    published one at a time instead of only after every chunk has finished.

    `on_question` is invoked while the lock is held.  That is deliberate: the
    callback is a dict append plus a condition notify, and holding the lock is
    what guarantees subscribers observe questionNumber 1, 2, 3, … in order.
    """

    def __init__(self, limit: int, on_question, dedupe: bool = True) -> None:
        self._lock = threading.Lock()
        self._seen: list[str] = []
        self._accepted: list[dict] = []
        self._limit = limit
        self._on_question = on_question
        # Mirror the non-streaming path: a single Gemini call was never deduped,
        # only the multi-chunk and import merges were.
        self._dedupe = dedupe
        self.quota_reached = threading.Event()

    @property
    def count(self) -> int:
        with self._lock:
            return len(self._accepted)

    def snapshot(self) -> list[dict]:
        with self._lock:
            return list(self._accepted)

    def offer(self, question: dict) -> bool:
        import difflib

        with self._lock:
            if len(self._accepted) >= self._limit:
                self.quota_reached.set()
                return False

            text = question.get("questionText", "").lower().strip()
            if self._dedupe and any(
                difflib.SequenceMatcher(None, text, seen).ratio() > 0.70
                for seen in self._seen
            ):
                return False

            number = len(self._accepted) + 1
            question["questionNumber"] = number
            question["id"] = f"q{number}_{uuid.uuid4().hex[:6]}"
            self._seen.append(text)
            self._accepted.append(question)
            if len(self._accepted) >= self._limit:
                self.quota_reached.set()

            if self._on_question:
                try:
                    self._on_question(question, number)
                except Exception as e:
                    logger.warning("on_question callback failed: %s", e)
            return True


def _unpack(result) -> tuple[str, str, dict]:
    """LlmResult → the (raw, model, token_info) triple this module passes around."""
    return result.text, result.model, {
        "input_tokens": result.input_tokens,
        "output_tokens": result.output_tokens,
    }


def _run_chunk_call(
    prompt: str,
    cred: LlmCredential,
    max_out: int,
    question_type: str,
    sink: "_QuestionSink | None",
    on_notice=None,
    validate=None,
    parse_all=None,
) -> tuple[list[dict], str, dict, str, ValueError | None]:
    """
    One LLM call for one chunk, streaming when a sink is present.

    validate / parse_all default to the generate-mode pair; import mode passes
    its own lenient equivalents.

    Returns (questions, model_used, token_info, raw_text, parse_error).  A parse
    error is returned rather than raised so the caller can still record token
    usage and dump the raw response before deciding to retry.  Without a sink the
    behaviour is exactly the previous blocking path.
    """
    if validate is None:
        def validate(q):
            return _validate_question(q, question_type)
    if parse_all is None:
        def parse_all(raw_text):
            return _parse_response(raw_text, question_type)

    if sink is None:
        result = generate_with_fallback(
            cred, prompt, max_output_tokens=max_out, on_notice=on_notice,
        )
        raw, model_used, tok = _unpack(result)
        try:
            return parse_all(raw), model_used, tok, raw, None
        except ValueError as e:
            return [], model_used, tok, raw, e

    parser = _StreamingArrayParser()
    collected: list[dict] = []

    def _on_text(delta: str) -> None:
        for obj in parser.feed(delta):
            try:
                validated = validate(obj)
            except Exception as e:
                logger.warning("Skipping invalid streamed question: %s", e)
                continue
            collected.append(validated)
            sink.offer(validated)

    raw, model_used, tok = _unpack(stream_with_fallback(
        cred,
        prompt,
        on_text=_on_text,
        on_notice=on_notice,
        stop_event=sink.quota_reached,
        max_output_tokens=max_out,
    ))

    if not collected:
        # Nothing parsed incrementally — fall back to the batch parser over the
        # full buffer so streaming can never be worse than the blocking path.
        try:
            for validated in parse_all(raw):
                collected.append(validated)
                sink.offer(validated)
        except ValueError as e:
            return [], model_used, tok, raw, e

    return collected, model_used, tok, raw, None


# ---------------------------------------------------------------------------
# Multi-chunk parallel generation
# ---------------------------------------------------------------------------

def _generate_multi_chunk(
    text: str,
    num_questions: int,
    question_type: str,
    difficulty: str,
    language: str,
    cred: LlmCredential,
    sink: "_QuestionSink | None" = None,
    on_notice=None,
) -> tuple[list[dict], dict]:
    """
    Split text into ≤ _MAX_PARALLEL_CHUNKS chunks and call Gemini in parallel,
    each call generating a proportional slice of the requested questions.

    This solves 'lost in the middle' by ensuring every chunk of the source
    text receives equal LLM attention as the primary (and only) content.

    Returns a deduplicated list of at least min(num_questions, total_generated) items.
    When `sink` is given, questions are published one at a time as they stream in
    and the sink owns dedup + numbering, so the returned list is its snapshot.
    """
    chunks = _split_into_chunks(text, _MAX_CHUNK_SIZE)

    # Cap at _MAX_PARALLEL_CHUNKS by merging tail chunks
    if len(chunks) > _MAX_PARALLEL_CHUNKS:
        merged: list[str] = []
        per = len(chunks) // _MAX_PARALLEL_CHUNKS
        for i in range(_MAX_PARALLEL_CHUNKS):
            start = i * per
            end = start + per if i < _MAX_PARALLEL_CHUNKS - 1 else len(chunks)
            merged.append("\n\n".join(chunks[start:end]))
        chunks = merged

    n = len(chunks)
    # Distribute questions across chunks (at least 1 per chunk).
    # Over-request by ~50 % per chunk to compensate for Gemini under-generation
    # and deduplication losses.  Cap at _MAX_QUESTIONS_PER_CALL to prevent
    # output-token overflow (Vietnamese JSON ≈ 400 tok/question).
    import math
    base_quota = max(1, num_questions // n)
    remainder = num_questions - base_quota * n
    quotas_exact = [base_quota + (1 if i < remainder else 0) for i in range(n)]
    overshoot = 1.5  # ask 50 % more to compensate for under-generation + dedup
    quotas = [min(math.ceil(quota * overshoot), _MAX_QUESTIONS_PER_CALL) for quota in quotas_exact]

    # If per-chunk caps reduce total ask below num_questions, add extra chunks
    # by re-splitting the largest chunks so every chunk stays within the cap.
    total_ask = sum(quotas)
    if total_ask < num_questions and len(chunks) < _MAX_PARALLEL_CHUNKS * 2:
        # Re-distribute: we might need more chunks
        needed_calls = math.ceil(num_questions * overshoot / _MAX_QUESTIONS_PER_CALL)
        if needed_calls > n:
            smaller_size = max(2000, len(text) // needed_calls)
            chunks = _split_into_chunks(text, max_chunk_size=smaller_size, overlap=_CHUNK_OVERLAP)
            if len(chunks) > _MAX_PARALLEL_CHUNKS * 2:
                # merge back down
                merged: list[str] = []
                per = len(chunks) // (_MAX_PARALLEL_CHUNKS * 2)
                for ii in range(_MAX_PARALLEL_CHUNKS * 2):
                    s = ii * per
                    e = s + per if ii < _MAX_PARALLEL_CHUNKS * 2 - 1 else len(chunks)
                    merged.append("\n\n".join(chunks[s:e]))
                chunks = merged
            n = len(chunks)
            base_quota = max(1, num_questions // n)
            remainder = num_questions - base_quota * n
            quotas_exact = [base_quota + (1 if i < remainder else 0) for i in range(n)]
            quotas = [min(math.ceil(q * overshoot), _MAX_QUESTIONS_PER_CALL) for q in quotas_exact]

    # Build a global coverage map once (from the full text) and share it
    section_titles = _extract_section_titles(text)
    coverage_hint = (
        "COVERAGE MAP – these are all sections in the source. "
        "Your questions MUST be spread across different sections:\n"
        + "\n".join(f"  • {t}" for t in section_titles)
        if section_titles else ""
    )

    logger.info(
        "Multi-chunk generation: %d chunks × ~%d q/chunk  (total requested=%d, text=%d chars)",
        n, base_quota, num_questions, len(text),
    )

    all_questions: list[dict] = []
    accumulated_tokens = {"input_tokens": 0, "output_tokens": 0, "models": {}}
    _tok_lock = threading.Lock()

    def _worker(idx: int, chunk: str, quota: int) -> list[dict]:
        if sink is not None and sink.quota_reached.is_set():
            logger.info("  Chunk %d/%d: skipped — quota already reached", idx + 1, n)
            return []
        logger.info("  Chunk %d/%d: %d chars → %d questions", idx + 1, n, len(chunk), quota)
        max_tok = _calc_max_output_tokens(quota, question_type)
        prompt = _build_prompt(
            chunk, quota, question_type, difficulty, language,
            coverage_hint=coverage_hint,
            chunk_label=f"[Part {idx + 1}/{n}]" if n > 1 else "",
        )
        _save_debug_file(
            f"prompt_chunk{idx+1}of{n}",
            prompt,
            meta=(
                f"# Chunk {idx+1}/{n} | num_questions={quota} | "
                f"type={question_type} | difficulty={difficulty} | lang={language} | "
                f"chars={len(chunk)} | max_output_tokens={max_tok}"
            ),
        )
        # Retry up to 3 times: once on parse error, once more if response looks truncated
        cur_quota = quota
        for attempt in range(3):
            if attempt > 0:
                logger.warning(
                    "  Chunk %d/%d: retry attempt %d/3 (quota=%d)...",
                    idx + 1, n, attempt + 1, cur_quota,
                )
            qs, model_used, tok, raw, parse_err = _run_chunk_call(
                prompt, cred, max_tok, question_type,
                sink, on_notice,
            )
            in_tok = tok.get("input_tokens", 0)
            out_tok = tok.get("output_tokens", 0)
            with _tok_lock:
                accumulated_tokens["input_tokens"] += in_tok
                accumulated_tokens["output_tokens"] += out_tok
                if model_used not in accumulated_tokens["models"]:
                    accumulated_tokens["models"][model_used] = {"requests": 0, "input_tokens": 0, "output_tokens": 0}
                accumulated_tokens["models"][model_used]["requests"] += 1
                accumulated_tokens["models"][model_used]["input_tokens"] += in_tok
                accumulated_tokens["models"][model_used]["output_tokens"] += out_tok
            _save_debug_file(
                f"response_chunk{idx+1}of{n}",
                raw,
                meta=f"# Chunk {idx+1}/{n} | model={model_used} | attempt={attempt + 1}",
            )
            def _shrink_and_rebuild() -> None:
                """Halve the ask so the model produces shorter, parseable output."""
                nonlocal cur_quota, max_tok, prompt
                cur_quota = max(3, cur_quota * 2 // 3)
                max_tok = _calc_max_output_tokens(cur_quota, question_type)
                prompt = _build_prompt(
                    chunk, cur_quota, question_type, difficulty, language,
                    coverage_hint=coverage_hint,
                    chunk_label=f"[Part {idx + 1}/{n}]" if n > 1 else "",
                )

            stop_early = sink is not None and sink.quota_reached.is_set()

            if parse_err is not None:
                if attempt < 2 and not stop_early:
                    logger.warning(
                        "  Chunk %d/%d: JSON parse error (attempt %d/3): %s",
                        idx + 1, n, attempt + 1, parse_err,
                    )
                    _shrink_and_rebuild()
                    continue
                if stop_early:
                    logger.info(
                        "  Chunk %d/%d: dropped unparsed — quota already reached", idx + 1, n
                    )
                else:
                    logger.error(
                        "  Chunk %d/%d: JSON parse failed after 3 attempts, returning []: %s",
                        idx + 1, n, parse_err,
                    )
                return []

            logger.info(
                "  Chunk %d/%d: got %d/%d questions via %s",
                idx + 1, n, len(qs), cur_quota, model_used,
            )
            # Detect truncated response: got very few questions vs requested.
            # Retrying is safe while streaming too — re-emitted duplicates are
            # rejected by the sink's dedup.
            if len(qs) < cur_quota * 0.4 and attempt < 2 and not stop_early:
                logger.warning(
                    "  Chunk %d/%d: only %d/%d questions — likely truncated, retrying with fewer",
                    idx + 1, n, len(qs), cur_quota,
                )
                _shrink_and_rebuild()
                continue
            return qs
        return []

    with ThreadPoolExecutor(max_workers=min(n, _MAX_PARALLEL_CHUNKS)) as pool:
        futures = {pool.submit(_worker, i, chunk, quota): i for i, (chunk, quota) in enumerate(zip(chunks, quotas))}
        chunk_results: dict[int, list[dict]] = {}
        for future in as_completed(futures):
            idx = futures[future]
            try:
                chunk_results[idx] = future.result()
            except Exception as e:
                logger.warning("Chunk %d failed: %s", idx + 1, e)
                chunk_results[idx] = []

    if sink is not None:
        # The sink already deduped, numbered and capped as questions streamed in.
        streamed = sink.snapshot()
        logger.info("Multi-chunk (streaming): published %d questions", len(streamed))
        return streamed, accumulated_tokens

    for i in range(n):
        all_questions.extend(chunk_results.get(i, []))

    deduped = _deduplicate_questions(all_questions)
    logger.info(
        "Multi-chunk: collected %d questions, after dedup=%d, returning top %d",
        len(all_questions), len(deduped), min(num_questions, len(deduped)),
    )
    return deduped, accumulated_tokens


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def generate_quiz(
    text: str,
    num_questions: int = 10,
    question_type: str = "multiple-choice",
    difficulty: str = "medium",
    language: str = "vi",
    *,
    cred: LlmCredential,
    on_question=None,
    on_notice=None,
) -> tuple[list[dict], dict]:
    """
    Generate quiz questions from text using the configured LLM provider.

    on_question(question, number): when given, questions are streamed to this
        callback one at a time as the model writes them, instead of only being
        returned at the end.  Numbering, dedup and the question cap then belong
        to the sink, so callers see the same list either way.
    on_notice(code, data): non-fatal progress notices ("rpmWait", "modelFallback",
        "cacheHit").

    Returns:
        (questions, token_usage)
        token_usage: {"input_tokens": int, "output_tokens": int, "total_tokens": int}
    """

    sink = (
        _QuestionSink(num_questions, on_question, dedupe=len(text) > _SINGLE_CALL_THRESHOLD)
        if on_question else None
    )

    key = _cache_key(text, num_questions, question_type, difficulty, language)
    cached = _cache_get(key)
    if cached is not None:
        logger.info("Cache hit — returning %s cached questions", len(cached))
        if sink is not None:
            if on_notice:
                on_notice("cacheHit", {"count": len(cached)})
            # deepcopy: the sink rewrites id/questionNumber, and these dicts are
            # the ones still held by the LRU cache.
            for cached_q in copy.deepcopy(cached):
                sink.offer(cached_q)
            return sink.snapshot(), {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
        return cached, {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}

    logger.info(
        "generate_quiz: %d chars | %d %s q | diff=%s lang=%s",
        len(text), num_questions, question_type, difficulty, language,
    )

    token_usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "models": {}}

    try:
        if len(text) > _SINGLE_CALL_THRESHOLD:
            logger.info(
                "Text (%d chars) > threshold (%d) → multi-chunk parallel generation",
                len(text), _SINGLE_CALL_THRESHOLD,
            )
            questions, chunk_tokens = _generate_multi_chunk(
                text, num_questions, question_type, difficulty, language,
                cred, sink=sink, on_notice=on_notice,
            )
            token_usage["input_tokens"] = chunk_tokens.get("input_tokens", 0)
            token_usage["output_tokens"] = chunk_tokens.get("output_tokens", 0)
            token_usage["models"] = chunk_tokens.get("models", {})

            # Top-up: if multi-chunk returned fewer questions than requested, request more
            # Use different text segments per round for diversity
            topup_chunks = _split_into_chunks(text, _MAX_CHUNK_SIZE)
            for _topup_round in range(3):
                have = sink.count if sink is not None else len(questions)
                deficit = num_questions - have
                if deficit <= 0:
                    break
                logger.info(
                    "Top-up round %d/3: have %d/%d questions, requesting %d more",
                    _topup_round + 1, have, num_questions, deficit,
                )
                if on_notice:
                    on_notice("topUp", {"round": _topup_round + 1, "deficit": deficit})
                try:
                    already_asked = "\n".join(
                        f"- {q.get('questionText', '')[:80]}"
                        for q in (sink.snapshot() if sink is not None else questions)
                    )
                    # Rotate through text chunks for different source material each round
                    chunk_idx = _topup_round % len(topup_chunks)
                    topup_text = topup_chunks[chunk_idx]
                    topup_count = min(deficit + 3, _MAX_QUESTIONS_PER_CALL)  # +3 buffer for dedup losses
                    topup_max_tok = _calc_max_output_tokens(topup_count, question_type)
                    topup_prompt = (
                        _build_prompt(topup_text, topup_count, question_type, difficulty, language)
                        + "\n\nIMPORTANT: Do NOT repeat questions on these topics (already generated):\n"
                        + already_asked
                    )
                    topup_qs, model_topup, tok_topup, _raw_topup, topup_parse_err = _run_chunk_call(
                        topup_prompt, cred, topup_max_tok,
                        question_type, sink, on_notice,
                    )
                    if topup_parse_err is not None:
                        raise topup_parse_err
                    in_tok = tok_topup.get("input_tokens", 0)
                    out_tok = tok_topup.get("output_tokens", 0)
                    token_usage["input_tokens"] += in_tok
                    token_usage["output_tokens"] += out_tok
                    tu_model = token_usage["models"]
                    if model_topup not in tu_model:
                        tu_model[model_topup] = {"requests": 0, "input_tokens": 0, "output_tokens": 0}
                    tu_model[model_topup]["requests"] += 1
                    tu_model[model_topup]["input_tokens"] += in_tok
                    tu_model[model_topup]["output_tokens"] += out_tok
                    # With a sink, dedup/numbering already happened as each question
                    # streamed in, so its snapshot is the authoritative list.
                    questions = (
                        sink.snapshot() if sink is not None
                        else _deduplicate_questions(questions + topup_qs)
                    )
                    logger.info(
                        "Top-up round %d/3: +%d new → total %d questions",
                        _topup_round + 1, len(topup_qs), len(questions),
                    )
                except Exception as topup_err:
                    logger.warning("Top-up round %d/3 failed: %s", _topup_round + 1, topup_err)
                    break
        else:
            prompt = _build_prompt(text, num_questions, question_type, difficulty, language)
            _save_debug_file(
                "prompt",
                prompt,
                meta=(
                    f"# num_questions={num_questions} | type={question_type} | "
                    f"difficulty={difficulty} | lang={language} | chars={len(prompt)}"
                ),
            )
            questions, model_used, tok, raw_text, parse_err = _run_chunk_call(
                prompt, cred, 16_384,
                question_type, sink, on_notice,
            )
            _save_debug_file("response", raw_text, meta=f"# model={model_used}")
            if parse_err is not None:
                raise parse_err
            in_tok = tok.get("input_tokens", 0)
            out_tok = tok.get("output_tokens", 0)
            token_usage["input_tokens"] = in_tok
            token_usage["output_tokens"] = out_tok
            token_usage["models"] = {
                model_used: {"requests": 1, "input_tokens": in_tok, "output_tokens": out_tok}
            }
            logger.info("Single-call: got %d questions via %s", len(questions), model_used)

        token_usage["total_tokens"] = token_usage["input_tokens"] + token_usage["output_tokens"]

        if sink is not None:
            # Ids and numbers were assigned as each question was published; keeping
            # them is what lets the client's answers stay keyed to the right question.
            questions = sink.snapshot()
        else:
            for i, q in enumerate(questions):
                q["id"] = f"q{i+1}_{uuid.uuid4().hex[:6]}"
                q["questionNumber"] = i + 1
            questions = questions[:num_questions]

        _cache_put(key, questions)
        logger.info(
            "Returning %d questions | tokens: in=%d out=%d total=%d",
            len(questions), token_usage["input_tokens"],
            token_usage["output_tokens"], token_usage["total_tokens"],
        )
        return questions, token_usage

    except Exception as e:
        logger.error("Quiz generation error: %s", e)
        raise RuntimeError(f"Failed to generate quiz: {str(e)}") from e


def _build_import_prompt(text: str, language: str = "vi") -> str:
    """
    Build a specialized extraction prompt for Smart Quiz Import.
    
    Unlike _build_prompt(), this does NOT ask Gemini to create new questions.
    Instead, it instructs Gemini to recognize and extract ALL existing Q&A
    from the provided text, preserving them verbatim.
    """
    lang = "Vietnamese" if language == "vi" else "English"
    
    prompt = f"""Bạn là một chuyên gia nhận diện và trích xuất dữ liệu.
Nhiệm vụ của bạn là đọc nội dung văn bản dưới đây, nhận diện TẤT CẢ các câu hỏi kèm theo câu trả lời (nếu có) và xuất chúng ra định dạng JSON.

HƯỚNG DẪN QUAN TRỌNG:
1. KHÔNG sáng tác hay tóm tắt nội dung. Hãy GIỮ NGUYÊN văn bản của câu hỏi và các đáp án.
2. NHẬN DIỆN số lượng câu hỏi tùy ý. Bạn phải bóc tách TẤT CẢ câu hỏi có trong văn bản (không giới hạn 10 câu).
3. SUY LUẬN đáp án đúng: Nếu trong văn bản đáp án đúng được làm nổi bật (bôi đậm, gạch dưới, có dấu *, hoặc nằm ở phần "Đáp án" cuối file), hãy tự động gán đáp án đúng vào id tương ứng. Nếu không thể suy luận được đáp án, hãy đánh dấu phần "correctAnswerId" là chuỗi rỗng "".
4. Phân loại câu hỏi: Dựa vào cấu trúc, nếu câu có nhiều lựa chọn (A,B,C,D) hãy gán type = "multiple-choice". Nếu câu hỏi có 2 đáp án đúng trở lên, gán type = "multiple-answer" và dùng correctAnswerIds thay vì correctAnswerId.
5. Output language: {lang}

ĐẦU RA:
Trả về duy nhất một mảng JSON tuân theo cấu trúc sau, không kèm giải thích hay markdown:
[
  {{
    "type": "multiple-choice",
    "questionText": "Nội dung câu hỏi",
    "options": [
      {{"id": "a", "text": "Nội dung đáp án A"}},
      {{"id": "b", "text": "Nội dung đáp án B"}},
      {{"id": "c", "text": "Nội dung đáp án C"}},
      {{"id": "d", "text": "Nội dung đáp án D"}}
    ],
    "correctAnswerId": "a",
    "explanation": "Câu giải thích nếu có trong bài"
  }}
]

Nội dung văn bản gốc:
---------
{text}
---------"""
    return prompt


def import_quiz_from_text(
    text: str,
    language: str = "vi",
    *,
    cred: LlmCredential,
    on_question=None,
    on_notice=None,
) -> tuple[list[dict], dict]:
    """
    Extract existing quiz questions from text using the configured LLM provider.

    Unlike generate_quiz(), this function does NOT create new questions.
    It extracts and parses existing Q&A content from the source text.

    on_question(question, number) streams each extracted question as it arrives.
    There is no target count in import mode, so the sink is effectively uncapped.

    Returns:
        (questions, token_usage)
    """

    sink = _QuestionSink(_IMPORT_QUESTION_CAP, on_question) if on_question else None

    logger.info(
        "import_quiz_from_text: %d chars | lang=%s",
        len(text), language,
    )

    token_usage = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "models": {}}
    
    try:
        # Split text into chunks if too long
        chunks = _split_into_chunks(text, _MAX_CHUNK_SIZE)
        
        if len(chunks) > _MAX_PARALLEL_CHUNKS:
            # Merge tail chunks
            merged: list[str] = []
            per = len(chunks) // _MAX_PARALLEL_CHUNKS
            for i in range(_MAX_PARALLEL_CHUNKS):
                start = i * per
                end = start + per if i < _MAX_PARALLEL_CHUNKS - 1 else len(chunks)
                merged.append("\n\n".join(chunks[start:end]))
            chunks = merged

        n = len(chunks)
        all_questions: list[dict] = []

        logger.info("Import extraction: %d chunks, text=%d chars", n, len(text))

        _tok_lock = threading.Lock()

        def _import_worker(idx: int, chunk: str) -> list[dict]:
            logger.info("  Import chunk %d/%d: %d chars", idx + 1, n, len(chunk))
            prompt = _build_import_prompt(chunk, language)
            max_tok = 65_536  # generous for extraction
            
            _save_debug_file(
                f"import_prompt_chunk{idx+1}of{n}",
                prompt,
                meta=f"# Import chunk {idx+1}/{n} | lang={language} | chars={len(chunk)}",
            )
            
            for attempt in range(3):
                try:
                    qs, model_used, tok, raw, parse_err = _run_chunk_call(
                        prompt, cred, max_tok, "multiple-choice",
                        sink, on_notice,
                        validate=_validate_import_question,
                        parse_all=_parse_import_response,
                    )
                    in_tok = tok.get("input_tokens", 0)
                    out_tok = tok.get("output_tokens", 0)
                    with _tok_lock:
                        token_usage["input_tokens"] += in_tok
                        token_usage["output_tokens"] += out_tok
                        if model_used not in token_usage["models"]:
                            token_usage["models"][model_used] = {"requests": 0, "input_tokens": 0, "output_tokens": 0}
                        token_usage["models"][model_used]["requests"] += 1
                        token_usage["models"][model_used]["input_tokens"] += in_tok
                        token_usage["models"][model_used]["output_tokens"] += out_tok

                    _save_debug_file(
                        f"import_response_chunk{idx+1}of{n}",
                        raw,
                        meta=f"# Import chunk {idx+1}/{n} | model={model_used} | attempt={attempt + 1}",
                    )

                    if parse_err is not None:
                        raise parse_err
                    logger.info(
                        "  Import chunk %d/%d: got %d questions via %s",
                        idx + 1, n, len(qs), model_used,
                    )
                    return qs
                except (ValueError, Exception) as e:
                    if attempt < 2:
                        logger.warning(
                            "  Import chunk %d/%d: parse error (attempt %d/3): %s",
                            idx + 1, n, attempt + 1, e,
                        )
                    else:
                        logger.error(
                            "  Import chunk %d/%d: failed after 3 attempts: %s",
                            idx + 1, n, e,
                        )
            return []

        if n == 1:
            all_questions = _import_worker(0, chunks[0])
        else:
            from concurrent.futures import ThreadPoolExecutor, as_completed
            with ThreadPoolExecutor(max_workers=min(n, _MAX_PARALLEL_CHUNKS)) as pool:
                futures = {pool.submit(_import_worker, i, chunk): i for i, chunk in enumerate(chunks)}
                chunk_results: dict[int, list[dict]] = {}
                for future in as_completed(futures):
                    idx = futures[future]
                    try:
                        chunk_results[idx] = future.result()
                    except Exception as e:
                        logger.warning("Import chunk %d failed: %s", idx + 1, e)
                        chunk_results[idx] = []
                for i in range(n):
                    all_questions.extend(chunk_results.get(i, []))

        if sink is not None:
            # Streaming already deduped and numbered each question on arrival.
            deduped = sink.snapshot()
        else:
            deduped = _deduplicate_questions(all_questions)
            for i, q in enumerate(deduped):
                q["id"] = f"q{i+1}_{uuid.uuid4().hex[:6]}"
                q["questionNumber"] = i + 1

        token_usage["total_tokens"] = token_usage["input_tokens"] + token_usage["output_tokens"]
        
        logger.info(
            "Import: extracted %d questions (after dedup=%d) | tokens: in=%d out=%d",
            len(all_questions), len(deduped),
            token_usage["input_tokens"], token_usage["output_tokens"],
        )
        return deduped, token_usage

    except Exception as e:
        logger.error("Quiz import error: %s", e)
        raise RuntimeError(f"Failed to import quiz: {str(e)}") from e


def _parse_import_response(raw_text: str) -> list[dict]:
    """
    Parse Gemini response for import mode.
    More lenient than _parse_response — accepts questions without correctAnswerId
    (sets it to empty string if missing).
    """
    # Strip markdown code fences
    cleaned = re.sub(r"```(?:json)?\s*", "", raw_text).strip()
    cleaned = re.sub(r"```\s*$", "", cleaned).strip()

    questions = None

    # Try direct JSON parse
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, list):
            questions = parsed
        elif isinstance(parsed, dict):
            for key in ("questions", "quiz", "items", "data", "results"):
                if key in parsed and isinstance(parsed[key], list):
                    questions = parsed[key]
                    break
            if questions is None:
                for v in parsed.values():
                    if isinstance(v, list):
                        questions = v
                        break
    except json.JSONDecodeError:
        pass

    # Regex fallback: find outermost JSON array
    if questions is None:
        match = re.search(r"(\[[\s\S]*\])", cleaned)
        if match:
            try:
                questions = json.loads(match.group(1))
            except json.JSONDecodeError:
                pass

    if questions is None:
        logger.error("Could not extract JSON from import response. First 500 chars:\n%s", raw_text[:500])
        raise ValueError("No JSON array found in import response")

    if not isinstance(questions, list):
        raise ValueError("Import response is not a list of questions")

    # Validate with lenient rules
    validated = []
    for q in questions:
        try:
            vq = _validate_import_question(q)
            validated.append(vq)
        except Exception as e:
            logger.warning("Skipping invalid imported question: %s", e)
            continue

    return validated


def _validate_import_question(q: dict) -> dict:
    """
    Validate a single imported question. More lenient than _validate_question:
    - correctAnswerId can be empty (unknown answer)
    - Does not check for ambiguous options
    """
    if "questionText" not in q or not q["questionText"]:
        raise ValueError("Missing questionText")
    
    options = q.get("options", [])
    if not isinstance(options, list) or len(options) < 2:
        raise ValueError("Options must have at least 2 items")

    # Normalize option IDs
    for opt in options:
        if "id" not in opt or "text" not in opt:
            raise ValueError("Each option must have 'id' and 'text'")
        opt["id"] = str(opt["id"]).lower()

    option_ids = [opt["id"] for opt in options]

    q_type = q.get("type", "multiple-choice")
    if q_type not in ("multiple-choice", "multiple-answer", "true-false", "fill-blank"):
        q_type = "multiple-choice"

    # Handle correctAnswerId — can be empty for import mode
    correct_id = str(q.get("correctAnswerId", "")).lower().strip()
    correct_ids = []
    
    if q_type == "multiple-answer":
        raw_ids = q.get("correctAnswerIds", [])
        if isinstance(raw_ids, str):
            raw_ids = [raw_ids]
        correct_ids = [str(cid).lower() for cid in raw_ids if cid]
        correct_id = correct_ids[0] if correct_ids else ""
    else:
        # Validate correctAnswerId if present
        if correct_id and correct_id not in option_ids:
            correct_id = ""  # Reset if invalid

    result = {
        "type": q_type,
        "questionText": q["questionText"],
        "options": options,
        "correctAnswerId": correct_id,
        "explanation": q.get("explanation", ""),
        "sourcePages": [],
        "sourceKeyword": [],
    }
    if q_type == "multiple-answer" and correct_ids:
        result["correctAnswerIds"] = correct_ids
    
    return result


def _build_prompt(
    text: str,
    num_questions: int,
    question_type: str,
    difficulty: str,
    language: str,
    coverage_hint: str = "",
    chunk_label: str = "",
) -> str:
    """
    Build a compact prompt for Gemini.

    coverage_hint: optional section coverage map (injected for multi-chunk calls)
    chunk_label:   e.g. "[Part 2/4]" — helps the model understand context
    """
    lang = "Vietnamese" if language == "vi" else "English"

    type_map = {
        "multiple-choice": "multiple-choice (4 options: a/b/c/d, EXACTLY ONE correct answer)",
        "multiple-answer": "multiple-answer (4 options: a/b/c/d, 2 or more correct answers — user selects all that apply)",
        "true-false": "true-false (2 options: a=True, b=False)",
        "fill-blank": "fill-in-the-blank with ___ (4 options: a/b/c/d)",
        "mixed": "mixed (multiple-choice, true-false, fill-blank)",
    }
    type_desc = type_map.get(question_type, type_map["multiple-choice"])

    if difficulty in DIFFICULTY_RULES:
        rule = DIFFICULTY_RULES[difficulty]
        diff_desc = rule["description"]
        hints = [f"  * {qt}: {QUESTION_TYPE_PROMPTS.get(qt, '')}" for qt in rule["types"]]
        cognitive_guidance = (
            f"DIFFICULTY ENGINE ({difficulty.upper()}):\n"
            f"- Target cognitive level: {diff_desc}\n"
            "- Use these question archetypes:\n" + "\n".join(hints) + "\n"
        )
    else:
        diff_desc = f"{difficulty} difficulty"
        cognitive_guidance = (
            f"DIFFICULTY ENGINE ({difficulty.upper()}):\n"
            f"- Target cognitive level: {diff_desc}\n"
        )

    if question_type == "mixed":
        type_field = '"type": "multiple-choice"|"true-false"|"fill-blank"'
    else:
        type_field = f'"type": "{question_type}"'

    # Schema for correct answer field depends on question type
    if question_type == "multiple-answer":
        answer_schema = '"correctAnswerIds": ["id1", "id2", ...] (2 or more correct option ids)'
    elif question_type == "mixed":
        answer_schema = ('"correctAnswerId": "string" for single-answer types'
                        ' (use "correctAnswerIds" array only if type is multiple-answer)')
    else:
        answer_schema = '"correctAnswerId": "string"'

    label_line = f"{chunk_label} " if chunk_label else ""
    coverage_block = f"\n{coverage_hint}\n" if coverage_hint else ""

    prompt = (
        f"{label_line}Generate exactly {num_questions} {type_desc} quiz questions in {lang}, "
        f"based solely on the text below.\n"
        f"Output ONLY a raw JSON array (no markdown, no code fences). "
        f"Each element: {{{type_field}, "
        '"questionText": "string", "options": [{"id": "string", "text": "string"}], '
        f'{answer_schema}, "explanation": "at most 8 words", '
        '"sourcePages": [page_numbers], "sourceKeyword": ["phrase1", "phrase2"]}.\n'
        "Note: the text may contain \"--- TRANG N ---\" page markers. "
        "Set sourcePages to the list of page number(s) N where the source content appears. "
        "Use [] if there are no page markers or the source page is unclear.\n"
        "Set sourceKeyword to a JSON array of 1-3 short phrases (each 3-8 words) copied VERBATIM "
        "from the source text that are the core evidence answering this question. "
        "Do NOT paraphrase — copy the exact original wording.\n"
        f"{coverage_block}"
        f"{cognitive_guidance}\n"
        "QUALITY RULES (strictly enforced):\n"
        "1. Prioritize questions that test TECHNICAL knowledge, code understanding, core concepts, "
        "algorithms, APIs, error handling, or comparisons between approaches.\n"
        "2. AVOID trivial metadata questions such as 'what is the name of the course', "
        "'how many videos does it have', 'what form is the content provided in' — "
        "UNLESS the entire text is solely about that topic.\n"
        "3. Each question must be grounded in DETAILED teaching content: specific code examples, "
        "common mistakes, method comparisons, syntax rules, or concept definitions.\n"
        "4. Cover diverse topics spread across the WHOLE text, not just the introduction.\n"
        "5. Do NOT invent information not present in the text.\n"
        "6. Each question must have EXACTLY ONE unambiguously correct answer. "
        "Distractors must be clearly wrong. NEVER create options that are "
        "aliases, shortcuts, or equivalent forms of the same answer "
        "(e.g. do NOT put both 'node --version' AND 'node -v' as separate options; "
        "do NOT put both 'npm install' AND 'npm i'; "
        "do NOT put both 'git status' AND 'git -s').\n"
        f"Text:\n{text}"
    )
    return prompt


def _parse_response(raw_text: str, question_type: str) -> list[dict]:
    """Parse and validate the Gemini response"""

    # Strip markdown code fences (```json ... ``` or ``` ... ```)
    cleaned = re.sub(r"```(?:json)?\s*", "", raw_text).strip()
    # Remove trailing fence if present
    cleaned = re.sub(r"```\s*$", "", cleaned).strip()

    logger.debug("Raw Gemini response (first 500 chars): %s", cleaned[:500])

    questions = None

    # 1. Try direct JSON parse on cleaned text
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, list):
            questions = parsed
        elif isinstance(parsed, dict):
            # Model wrapped array: {"questions": [...]} or {"quiz": [...]} etc.
            for key in ("questions", "quiz", "items", "data", "results"):
                if key in parsed and isinstance(parsed[key], list):
                    questions = parsed[key]
                    break
            if questions is None:
                # Try any list value in the dict
                for v in parsed.values():
                    if isinstance(v, list):
                        questions = v
                        break
    except json.JSONDecodeError:
        pass

    # 2. Regex extraction: find the outermost JSON array
    if questions is None:
        match = re.search(r"(\[[\s\S]*\])", cleaned)
        if match:
            try:
                questions = json.loads(match.group(1))
            except json.JSONDecodeError:
                pass

    # 3. Regex extraction: find the outermost JSON object then unwrap
    if questions is None:
        match = re.search(r"(\{[\s\S]*\})", cleaned)
        if match:
            try:
                parsed = json.loads(match.group(1))
                if isinstance(parsed, dict):
                    for key in ("questions", "quiz", "items", "data", "results"):
                        if key in parsed and isinstance(parsed[key], list):
                            questions = parsed[key]
                            break
                    if questions is None:
                        for v in parsed.values():
                            if isinstance(v, list):
                                questions = v
                                break
            except json.JSONDecodeError:
                pass

    if questions is None:
        logger.error("Could not extract JSON from Gemini response. Full response:\n%s", raw_text[:1000])
        raise ValueError("No JSON array found in response")

    if not isinstance(questions, list):
        raise ValueError("Response is not a list of questions")

    # Validate and normalize each question
    validated = []
    for q in questions:
        try:
            validated_q = _validate_question(q, question_type)
            validated.append(validated_q)
        except Exception as e:
            logger.warning(f"Skipping invalid question: {e}")
            continue

    return validated


def _validate_question(q: dict, default_type: str) -> dict:
    """Validate a single question dict"""
    # Normalize type first so we can do type-specific field checks
    q_type = q.get("type", default_type)
    if q_type not in ("multiple-choice", "multiple-answer", "true-false", "fill-blank"):
        q_type = default_type

    # Required fields vary by type
    required_fields = ["questionText", "options"]
    if q_type == "multiple-answer":
        # Accept either correctAnswerIds (preferred) or fall back to correctAnswerId
        if "correctAnswerIds" not in q and "correctAnswerId" not in q:
            raise ValueError("Missing field: correctAnswerIds (or correctAnswerId) for multiple-answer")
    else:
        if "correctAnswerId" not in q:
            raise ValueError("Missing field: correctAnswerId")
    for field in required_fields:
        if field not in q:
            raise ValueError(f"Missing field: {field}")

    # Validate options
    options = q["options"]
    if not isinstance(options, list) or len(options) < 2:
        raise ValueError("Options must be a list with at least 2 items")

    # Ensure each option has id and text, normalize IDs to lowercase
    for opt in options:
        if "id" not in opt or "text" not in opt:
            raise ValueError("Each option must have 'id' and 'text'")
        opt["id"] = str(opt["id"]).lower()

    option_ids = [opt["id"] for opt in options]

    # Handle multiple-answer type
    is_multi = q_type == "multiple-answer"
    if is_multi:
        # Require correctAnswerIds (list with >= 2 entries)
        raw_ids = q.get("correctAnswerIds", [])
        if isinstance(raw_ids, str):
            raw_ids = [raw_ids]
        correct_ids = [str(cid).lower() for cid in raw_ids if cid]
        if len(correct_ids) < 2:
            raise ValueError(
                f"multiple-answer question must have at least 2 correctAnswerIds, got: {correct_ids}"
            )
        for cid in correct_ids:
            if cid not in option_ids:
                raise ValueError(f"correctAnswerIds entry '{cid}' not in options")
        correct_id = correct_ids[0]
    else:
        # Normalize correctAnswerId to lowercase
        correct_id = str(q.get("correctAnswerId", "")).lower()
        correct_ids = []

        # Validate correctAnswerId exists in options
        if correct_id not in option_ids:
            raise ValueError(f"correctAnswerId '{correct_id}' not in options")

        # Reject questions where two or more options are semantically equivalent
        # (e.g. 'node --version' and 'node -v' are both correct → invalid question)
        if _options_have_duplicates(options):
            raise ValueError(
                f"Question has ambiguous/equivalent options and was rejected: "
                f"{q['questionText'][:80]!r}"
            )

    # Preserve and sanitize sourcePages
    raw_pages = q.get("sourcePages", [])
    source_pages: list[int] = []
    if isinstance(raw_pages, list):
        for p in raw_pages:
            try:
                source_pages.append(int(p))
            except (ValueError, TypeError):
                pass

    # Preserve sourceKeyword as a list of verbatim phrases
    raw_kw = q.get("sourceKeyword", [])
    if isinstance(raw_kw, str):
        raw_kw = [raw_kw] if raw_kw.strip() else []
    # Split any comma-separated phrases inside individual elements
    expanded = []
    for k in raw_kw:
        for part in str(k).split(","):
            part = part.strip()[:200]
            if part:
                expanded.append(part)
    source_keyword = expanded[:5]

    result = {
        "type": q_type,
        "questionText": q["questionText"],
        "options": options,
        "correctAnswerId": correct_id,
        "explanation": q.get("explanation", ""),
        "sourcePages": source_pages,
        "sourceKeyword": source_keyword,
    }
    if is_multi:
        result["correctAnswerIds"] = correct_ids
    return result


# ---------------------------------------------------------------------------
# Ambiguous-option detection helpers
# ---------------------------------------------------------------------------

def _opt_similarity(a: str, b: str) -> float:
    """Character-level similarity ratio between two option texts."""
    import difflib
    return difflib.SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def _opt_tokens(text: str) -> set:
    """Extract meaningful word-tokens from an option, ignoring CLI flag dashes."""
    # Strip leading '-' / '--' from flags but keep the word part
    # e.g. '--version' → 'version', '-v' → 'v'
    clean = re.sub(r'-{1,2}(\w)', r'\1', text)  # strip flag prefixes
    words = re.findall(r'\b\w+\b', clean.lower())
    stopwords = {'the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'for', 'and', 'or', 'with'}
    return {w for w in words if w not in stopwords and len(w) > 1}


def _options_have_duplicates(options: list[dict]) -> bool:
    """
    Return True if any two option texts are suspiciously semantically equivalent,
    which would make the question ambiguous (two correct answers).

    Three complementary checks:
    1. String similarity ≥ 0.72  (e.g. 'git status' vs 'git -status')
    2. Same base command + all-flag arguments  (e.g. 'node --version' vs 'node -v')
    3. Token Jaccard ≥ 0.80 after stripping flag prefixes
       (e.g. 'npm install' vs 'npm i' → both have token 'npm' → not enough,
        but 'node --version' vs 'node -version' → tokens {'node','version'} == {'node','version'})
    """
    texts = [opt["text"] for opt in options]
    n = len(texts)

    for i in range(n):
        for j in range(i + 1, n):
            a, b = texts[i], texts[j]

            # --- Check 1: character similarity ---
            if _opt_similarity(a, b) >= 0.72:
                logger.warning(
                    "Ambiguous options (char sim=%.2f): %r vs %r",
                    _opt_similarity(a, b), a, b,
                )
                return True

            # --- Check 2: same base command, all remaining parts are flags ---
            a_parts = a.strip().split()
            b_parts = b.strip().split()
            if (
                len(a_parts) >= 2
                and len(b_parts) >= 2
                and a_parts[0].lower() == b_parts[0].lower()  # same command
                and all(p.startswith("-") for p in a_parts[1:])  # only flags after cmd
                and all(p.startswith("-") for p in b_parts[1:])  # only flags after cmd
            ):
                logger.warning(
                    "Ambiguous CLI alias options (same cmd + aliased flags): %r vs %r", a, b
                )
                return True

            # --- Check 3: high token-set Jaccard after normalizing flag prefixes ---
            tok_a = _opt_tokens(a)
            tok_b = _opt_tokens(b)
            if tok_a and tok_b:
                jaccard = len(tok_a & tok_b) / len(tok_a | tok_b)
                if jaccard >= 0.80:
                    logger.warning(
                        "Ambiguous options (token Jaccard=%.2f): %r vs %r", jaccard, a, b
                    )
                    return True

    return False
