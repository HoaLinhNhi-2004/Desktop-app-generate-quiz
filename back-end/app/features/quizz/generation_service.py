"""
Quiz generation pipeline, shared by the blocking route and the SSE stream job.

`run_generation(payload, emit)` is the whole flow: extract text → validate →
condense → call Gemini → persist → return the response body.  It takes an
`emit(event_type, data)` callback so the streaming job can publish progress and
individual questions as they arrive; the blocking route passes the no-op default
and gets exactly the response it always returned.

Threading contract: `run_generation` may run on a background thread, so it must
never touch `request`.  Everything request-bound (saving uploads, reading form
fields) happens in `save_request_files()` / `build_payload()`, which the route
calls while the request context is still alive.
"""

import os
import re
import uuid
import logging
from collections import Counter
from datetime import datetime, timezone

from flask import current_app
from werkzeug.utils import secure_filename

from app.db import db
from app.features.quizz.models import QuizSet, Question
from app.features.upload.models import UploadedFileRecord

logger = logging.getLogger(__name__)

# Input quality guard
_MIN_CHARS = 80          # absolute minimum meaningful characters
_MIN_UNIQUE_WORDS = 10   # minimum distinct words
_CHARS_PER_QUESTION = 60 # at least this many chars per requested question


class GenerationInputError(ValueError):
    """Bad request — maps to HTTP 400."""
    status = 400


class GenerationContentError(ValueError):
    """Usable request but unusable content — maps to HTTP 422."""
    status = 422


def _noop(event_type: str, data: dict) -> None:
    pass


# ── File helpers (request thread only where noted) ────────────────────────────


def allowed_file(filename: str) -> bool:
    allowed = current_app.config.get("ALLOWED_EXTENSIONS", set())
    return "." in filename and filename.rsplit(".", 1)[1].lower() in allowed


def save_uploaded_file(file) -> str:
    """Save one upload and return its path. Must run in the request thread."""
    upload_folder = current_app.config["UPLOAD_FOLDER"]
    original_name = secure_filename(file.filename)
    unique_name = f"{uuid.uuid4().hex[:8]}_{original_name}"
    filepath = os.path.join(upload_folder, unique_name)
    file.save(filepath)
    return filepath


def save_request_files(files_list) -> tuple[list[str], list[dict]]:
    """
    Persist every uploaded file and capture its metadata.

    Must run in the request thread — `request.files` handles are invalid once the
    request context is gone, so the background job only ever sees plain dicts.

    Returns (saved_paths, file_meta) where file_meta mirrors what the upload
    records need: originalName, fileSize, ext, storedPath.
    """
    saved_paths: list[str] = []
    file_meta: list[dict] = []
    for file in files_list:
        if not file or not file.filename:
            continue
        if not allowed_file(file.filename):
            raise GenerationInputError(f"File type not allowed: {file.filename}")
        file.seek(0, 2)
        size = file.tell()
        file.seek(0)
        path = save_uploaded_file(file)
        name = secure_filename(file.filename)
        saved_paths.append(path)
        file_meta.append({
            "originalName": name,
            "fileSize": size,
            "ext": name.rsplit(".", 1)[-1].lower() if "." in name else "",
            "storedPath": path,
        })
    return saved_paths, file_meta


def extract_text_from_file(filepath: str, lang: str = "vi") -> str:
    """Extract text from a single file (PDF / DOCX / spreadsheet / image)."""
    ext = filepath.rsplit(".", 1)[-1].lower()

    if ext == "pdf":
        from app.features.quizz.pdf_service import extract_text_from_pdf_with_ocr
        return extract_text_from_pdf_with_ocr(filepath, lang=lang)
    elif ext in ["docx", "doc"]:
        from app.features.quizz.docx_service import extract_text_from_docx
        return extract_text_from_docx(filepath)
    elif ext in ["xlsx", "xls", "csv"]:
        from app.features.quizz.spreadsheet_service import extract_text_from_spreadsheet
        return extract_text_from_spreadsheet(filepath, ext)
    else:
        from app.features.quizz.ocr_service import extract_text_from_image
        return extract_text_from_image(filepath, lang=lang)


# ── Config + quality validation ───────────────────────────────────────────────


def parse_config(form) -> dict:
    """Parse and validate quiz config from form data (or an equivalent mapping)."""
    config = {
        "numberOfQuestions": int(form.get("numberOfQuestions", 10)),
        "questionType": form.get("questionType", "multiple-choice"),
        "difficulty": form.get("difficulty", "medium"),
        "language": form.get("language", "vi"),
        "timePerQuestion": int(form.get("timePerQuestion", 30)),
    }
    valid_types = {"multiple-choice", "multiple-answer", "true-false", "fill-blank", "mixed"}
    valid_difficulties = {"easy", "medium", "hard", "mixed"}
    valid_languages = {"vi", "en"}

    if config["questionType"] not in valid_types:
        raise ValueError(f"Invalid questionType: {config['questionType']}")
    if config["difficulty"] not in valid_difficulties:
        raise ValueError(f"Invalid difficulty: {config['difficulty']}")
    if config["language"] not in valid_languages:
        raise ValueError(f"Invalid language: {config['language']}")
    return config


def validate_text_quality(text: str, num_questions: int) -> tuple:
    """
    Validate extracted/cleaned text before sending it to the LLM.

    Returns (error_str_or_None, capped_num_questions).

    Checks:
    1. Absolute minimum character threshold.
    2. Minimum unique-word count (catches "aaaa aaaa aaaa ...").
    3. Repetition ratio: if the 3 most common words make up > 65 % of all words,
       the text is considered garbage / low-quality.
    4. Per-question text budget: cap num_questions so one question has at least
       _CHARS_PER_QUESTION characters of source material.
    """
    stripped = text.strip()

    if len(stripped) < _MIN_CHARS:
        return (
            f"Nội dung quá ngắn ({len(stripped)} ký tự). "
            f"Vui lòng cung cấp ít nhất {_MIN_CHARS} ký tự có nội dung thực sự.",
            num_questions,
        )

    words = re.findall(r"\b\w{2,}\b", stripped.lower())
    unique_words = set(words)
    if len(unique_words) < _MIN_UNIQUE_WORDS:
        return (
            f"Nội dung quá lặp lại hoặc vô nghĩa ({len(unique_words)} từ duy nhất). "
            "Vui lòng cung cấp nội dung có đủ kiến thức để tạo câu hỏi.",
            num_questions,
        )

    if words:
        top3_count = sum(c for _, c in Counter(words).most_common(3))
        if top3_count / len(words) > 0.65:
            return (
                "Nội dung có tính lặp lại quá cao và không đủ đa dạng để tạo quiz. "
                "Vui lòng cung cấp tài liệu có nội dung phong phú hơn.",
                num_questions,
            )

    max_allowed = max(1, len(stripped) // _CHARS_PER_QUESTION)
    capped = min(num_questions, max_allowed)
    if capped < num_questions:
        logger.warning(
            "Capping num_questions from %d → %d (text only has %d chars)",
            num_questions, capped, len(stripped),
        )

    return None, capped


# ── Text extraction ───────────────────────────────────────────────────────────


def extract_combined_text(
    input_type: str,
    form,
    saved_paths: list,
    config: dict,
    reused_file_ids: list | None = None,
    emit=_noop,
) -> str:
    """
    Combined source text for the requested input type.

    `form` is any mapping with .get() — a Werkzeug MultiDict from the blocking
    route, or the plain payload dict from the streaming job.  Uploaded files must
    already be on disk (see save_request_files) and listed in `saved_paths`.
    """
    if input_type == "youtube":
        youtube_url = (form.get("youtubeUrl") or "").strip()
        if not youtube_url:
            raise GenerationInputError("youtubeUrl is required for inputType=youtube")
        caption_lang = (form.get("captionLang") or "vi").strip() or "vi"
        emit("stage", {"stage": "extracting", "detail": "youtubeTranscript"})
        from app.features.quizz.youtube_service import extract_transcript
        return extract_transcript(youtube_url, lang=caption_lang)

    if input_type == "text":
        raw_text = (form.get("rawText") or "").strip()
        if not raw_text:
            raise GenerationInputError("rawText is required for inputType=text")
        if len(raw_text) > 50000:
            raise GenerationInputError("rawText exceeds maximum length of 50,000 characters")
        return raw_text

    # files — new uploads (already saved) + reused records
    reused_paths = []
    if reused_file_ids:
        for record_id in reused_file_ids:
            record = UploadedFileRecord.query.get(record_id)
            if record and record.stored_path and os.path.isfile(record.stored_path):
                reused_paths.append(record.stored_path)
                logger.info("Reusing stored file: %s (%s)", record.original_name, record.stored_path)
            else:
                logger.warning("Reused file record %s not found or file missing on disk", record_id)

    all_paths = saved_paths + reused_paths
    if not all_paths:
        raise GenerationInputError("No valid files to process")

    ocr_lang = config["language"]
    all_texts = []
    page_offset = 0
    for index, path in enumerate(all_paths):
        emit("stage", {
            "stage": "extracting",
            "detail": os.path.basename(path),
            "current": index + 1,
            "total": len(all_paths),
        })
        ext = path.rsplit(".", 1)[-1].lower()
        if ext == "pdf":
            from app.features.quizz.pdf_service import extract_text_from_pdf_paged
            paged_text, n_pages = extract_text_from_pdf_paged(path, lang=ocr_lang)
            if paged_text.strip():
                # Offset page numbers so multi-PDF uploads have globally unique pages
                if page_offset > 0:
                    for p in range(n_pages, 0, -1):
                        paged_text = paged_text.replace(
                            f"--- TRANG {p} ---",
                            f"--- TRANG {p + page_offset} ---",
                        )
                page_offset += n_pages
                all_texts.append(paged_text)
        else:
            text = extract_text_from_file(path, lang=ocr_lang)
            if text.strip():
                all_texts.append(text)

    return "\n\n".join(all_texts)


# ── Payload ───────────────────────────────────────────────────────────────────


def build_payload(
    form,
    saved_paths: list[str],
    file_meta: list[dict],
    reused_file_ids: list[str],
    config: dict,
    quiz_set_id: str,
) -> dict:
    """
    Freeze everything request-bound into a plain dict the pipeline can use from
    any thread.  Must be called while the request context is alive.
    """
    folder_id = (form.get("folderId") or "").strip() or None
    return {
        "inputType": (form.get("inputType") or "files").strip().lower(),
        "action": (form.get("action") or "generate").strip().lower(),
        "config": config,
        "folderId": folder_id,
        "title": (form.get("title") or "").strip(),
        "rawText": form.get("rawText", ""),
        "youtubeUrl": form.get("youtubeUrl", ""),
        "captionLang": form.get("captionLang", "vi"),
        "reusedFileIds": reused_file_ids,
        "savedPaths": saved_paths,
        "fileMeta": file_meta,
        "quizSetId": quiz_set_id,
    }


# ── The pipeline ──────────────────────────────────────────────────────────────


def _compute_page_distribution(payload: dict, question_count: int) -> dict | None:
    """Proportional question-per-page map across every PDF involved (new + reused)."""
    from app.features.quizz.pdf_service import get_pdf_page_stats

    reused_paths = []
    for record_id in payload["reusedFileIds"]:
        record = UploadedFileRecord.query.get(record_id)
        if record and record.stored_path and os.path.isfile(record.stored_path):
            reused_paths.append(record.stored_path)

    pdf_paths = [
        p for p in payload["savedPaths"] + reused_paths
        if p.rsplit(".", 1)[-1].lower() == "pdf"
    ]
    if not pdf_paths:
        return None

    page_offset = 0
    all_pages: list[dict] = []
    for path in pdf_paths:
        stats = get_pdf_page_stats(path)
        for stat in stats:
            all_pages.append({"page": stat["page"] + page_offset, "char_count": stat["char_count"]})
        page_offset += len(stats)

    if not all_pages:
        return None
    total_chars = sum(p["char_count"] for p in all_pages)
    if total_chars <= 0 or question_count <= 0:
        return None

    float_q = [p["char_count"] / total_chars * question_count for p in all_pages]
    int_q = [int(x) for x in float_q]
    remainder = question_count - sum(int_q)
    fractions = sorted(range(len(all_pages)), key=lambda i: -(float_q[i] - int_q[i]))
    for i in range(remainder):
        int_q[fractions[i]] += 1
    return {
        "distribution": {str(all_pages[i]["page"]): int_q[i] for i in range(len(all_pages))},
        "totalPages": len(all_pages),
    }


def _persist(payload: dict, questions: list[dict], streaming: bool) -> tuple[str, dict | None, set[str]]:
    """Write the quiz set, its questions and the upload records. Returns
    (quiz_set_id, page_distribution, paths_kept_on_disk)."""
    config = payload["config"]
    folder_id = payload["folderId"]
    quiz_set_id = payload["quizSetId"]
    input_type = payload["inputType"]
    title = payload["title"] or f"Quiz {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')}"

    page_distribution = None
    if input_type == "files":
        page_distribution = _compute_page_distribution(payload, len(questions))

    quiz_set = QuizSet(id=quiz_set_id, folder_id=folder_id, title=title)
    quiz_set.set_config(config)
    if page_distribution:
        quiz_set.set_page_distribution(page_distribution)
    if payload["reusedFileIds"]:
        quiz_set.set_source_upload_ids(payload["reusedFileIds"])
    db.session.add(quiz_set)

    for q in questions:
        q_type = q.get("type", "multiple-choice")
        correct_ids = q.get("correctAnswerIds", [])
        correct_id = q.get("correctAnswerId", "")
        if q_type == "multiple-answer" and correct_ids:
            correct_id = correct_ids[0] if correct_ids else correct_id
        # While streaming, the id the client already received becomes the primary
        # key so its answers stay keyed to the right question. The sink mints a
        # fresh id on every run (including cache hits), so it is never a stale one.
        question_id = q["id"] if streaming and q.get("id") else f"q{q.get('questionNumber', 0)}_{uuid.uuid4().hex[:8]}"
        question = Question(
            id=question_id,
            quiz_set_id=quiz_set_id,
            question_number=q.get("questionNumber", 0),
            type=q_type,
            question_text=q.get("questionText", ""),
            correct_answer_id=correct_id,
            explanation=q.get("explanation", ""),
        )
        question.set_options(q.get("options", []))
        question.set_source_pages(q.get("sourcePages", []))
        raw_kw = q.get("sourceKeyword", [])
        question.set_source_keyword(raw_kw if isinstance(raw_kw, list) else ([raw_kw] if raw_kw else []))
        if q_type == "multiple-answer" and correct_ids:
            question.set_correct_answer_ids(correct_ids)
        db.session.add(question)
        q["id"] = question.id

    # Upload records let the user see (and reuse) what the quiz was built from.
    persisted_paths: set[str] = set()
    if folder_id:
        if input_type == "files":
            for meta in payload["fileMeta"]:
                if meta["storedPath"]:
                    persisted_paths.add(meta["storedPath"])
                db.session.add(UploadedFileRecord(
                    id=str(uuid.uuid4()),
                    folder_id=folder_id,
                    original_name=meta["originalName"],
                    file_size=meta["fileSize"],
                    file_type=meta["ext"],
                    input_mode="files",
                    stored_path=meta["storedPath"],
                    quiz_set_id=quiz_set_id,
                ))
        elif input_type == "youtube":
            db.session.add(UploadedFileRecord(
                id=str(uuid.uuid4()),
                folder_id=folder_id,
                original_name="YouTube Video",
                file_size=0,
                file_type="youtube",
                input_mode="youtube",
                source_label=payload["youtubeUrl"],
                quiz_set_id=quiz_set_id,
            ))
        elif input_type == "text":
            raw = payload["rawText"]
            text_stored_path = ""
            if raw.strip():
                text_filename = f"{uuid.uuid4().hex[:8]}_rawtext.txt"
                text_stored_path = os.path.join(current_app.config["UPLOAD_FOLDER"], text_filename)
                with open(text_stored_path, "w", encoding="utf-8") as tf:
                    tf.write(raw)
            preview = raw[:200].replace("\n", " ").strip()
            if len(raw) > 200:
                preview += "…"
            db.session.add(UploadedFileRecord(
                id=str(uuid.uuid4()),
                folder_id=folder_id,
                original_name="Văn bản nhập trực tiếp",
                file_size=len(raw.encode("utf-8")),
                file_type="text",
                input_mode="text",
                source_label=preview,
                stored_path=text_stored_path,
                quiz_set_id=quiz_set_id,
            ))

    db.session.commit()
    return quiz_set_id, page_distribution, persisted_paths


def run_generation(payload: dict, emit=_noop) -> dict:
    """
    Full generate/import pipeline. Returns the same body the blocking endpoint
    has always returned.

    Raises GenerationInputError (400), GenerationContentError (422) or
    RuntimeError (500, message is user-facing).
    """
    input_type = payload["inputType"]
    action = payload["action"]
    config = payload["config"]
    reused_file_ids = payload["reusedFileIds"]
    saved_paths = payload["savedPaths"]
    streaming = emit is not _noop

    from app.features.api_keys.key_manager import get_optimal_key
    key_obj = get_optimal_key()
    if not key_obj:
        raise RuntimeError("Chưa có Gemini API key. Vào trang API Keys (Settings) để thêm key.")
    gemini_key, active_key_id = key_obj.key, key_obj.id

    fallback_chain = current_app.config.get(
        "GEMINI_FALLBACK_CHAIN",
        ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"],
    )

    persisted_paths: set[str] = set()
    try:
        emit("stage", {"stage": "extracting"})

        # Fast path — every reused file is already processed, so use the chunks
        # already in the vector store instead of re-extracting from disk.
        use_vector_chunks = False
        combined_text = ""
        if input_type == "files" and reused_file_ids and not saved_paths:
            processed_ids = [
                rid for rid in reused_file_ids
                if (rec := UploadedFileRecord.query.get(rid)) and rec.processing_status == "completed"
            ]
            if len(processed_ids) == len(reused_file_ids):
                from app.features.upload.vector_store import get_records_chunks
                chunks = get_records_chunks(reused_file_ids)
                if chunks:
                    combined_text = "\n\n".join(chunks)
                    use_vector_chunks = True
                    logger.info(
                        "Using %d pre-processed chunks from vector store for %d record(s)",
                        len(chunks), len(reused_file_ids),
                    )
                    emit("stage", {"stage": "analyzing", "detail": "vectorFastPath", "total": len(chunks)})

        if not use_vector_chunks:
            combined_text = extract_combined_text(
                input_type, payload, saved_paths, config,
                reused_file_ids=reused_file_ids, emit=emit,
            )

        if not combined_text.strip():
            raise GenerationContentError({
                "files": "Could not extract any text from uploaded files",
                "youtube": "No transcript content found in the YouTube video",
                "text": "rawText is empty",
            }.get(input_type, "No text content found"))

        def _on_question(question: dict, number: int) -> None:
            emit("question", {
                "index": number - 1,
                "total": config["numberOfQuestions"] if action == "generate" else 0,
                "question": question,
            })

        def _on_notice(code: str, data: dict) -> None:
            emit("notice", {"code": code, **data})

        on_question = _on_question if streaming else None
        on_notice = _on_notice if streaming else None

        if action == "import":
            from app.features.quizz.text_processing import clean_text
            from app.features.quizz.quiz_generator import import_quiz_from_text
            cleaned = clean_text(combined_text)
            emit("meta", {
                "totalTextLength": len(cleaned),
                "filesProcessed": len(saved_paths) + len(reused_file_ids),
                "inputType": input_type,
                "numberOfQuestions": 0,
                "config": config,
            })
            emit("stage", {"stage": "generating"})
            # Import sends the FULL text (not filtered/chunked) so question
            # numbering and answer markers survive.
            questions, token_usage = import_quiz_from_text(
                text=combined_text,
                language=config.get("language", "vi"),
                gemini_api_key=gemini_key,
                model_chain=fallback_chain,
                on_question=on_question,
                on_notice=on_notice,
            )
        else:
            quality_error, config["numberOfQuestions"] = validate_text_quality(
                combined_text, config["numberOfQuestions"]
            )
            if quality_error:
                raise GenerationContentError(quality_error)

            from app.features.quizz.text_processing import (
                filter_boilerplate, clean_text, chunk_text, select_important_chunks,
            )

            if input_type == "youtube":
                from app.features.quizz.youtube_service import summarize_transcript
                logger.info(
                    "Summarizing YouTube transcript (%d chars) before quiz generation",
                    len(combined_text),
                )
                emit("stage", {"stage": "analyzing", "detail": "summarizing"})
                quiz_text = summarize_transcript(
                    combined_text, api_key=gemini_key, model_chain=fallback_chain,
                )
                cleaned = quiz_text
            else:
                emit("stage", {"stage": "analyzing"})
                cleaned = clean_text(filter_boilerplate(combined_text))
                selected = select_important_chunks(chunk_text(cleaned, max_chunk_size=8000), n=6)
                quiz_text = "\n\n".join(selected)
                if len(quiz_text) > 40_000:
                    quiz_text = quiz_text[:40_000]

            emit("meta", {
                "totalTextLength": len(cleaned),
                "filesProcessed": len(saved_paths) + len(reused_file_ids),
                "inputType": input_type,
                "numberOfQuestions": config["numberOfQuestions"],
                "config": config,
            })
            emit("stage", {"stage": "generating", "total": config["numberOfQuestions"]})

            from app.features.quizz.quiz_generator import generate_quiz as gen_quiz
            questions, token_usage = gen_quiz(
                text=quiz_text,
                num_questions=config["numberOfQuestions"],
                question_type=config["questionType"],
                difficulty=config["difficulty"],
                language=config["language"],
                gemini_api_key=gemini_key,
                model_chain=fallback_chain,
                on_question=on_question,
                on_notice=on_notice,
            )

        if active_key_id and token_usage:
            try:
                from app.features.api_keys.key_manager import record_success
                record_success(
                    active_key_id,
                    token_usage.get("input_tokens", 0),
                    token_usage.get("output_tokens", 0),
                    model_stats=token_usage.get("models"),
                )
            except Exception as track_err:
                logger.warning("Could not track key usage: %s", track_err)

        emit("stage", {"stage": "saving"})
        quiz_set_id, page_distribution, persisted_paths = _persist(payload, questions, streaming)

        text_preview = cleaned[:500] + "..." if len(cleaned) > 500 else cleaned
        total_files = len(saved_paths) + len(reused_file_ids)
        return {
            "quizSetId": quiz_set_id,
            "questions": questions,
            "extractedText": text_preview,
            "totalTextLength": len(cleaned),
            "filesProcessed": total_files if input_type == "files" else (1 if input_type in {"youtube", "text"} else 0),
            "config": config,
            "inputType": input_type,
            "tokenUsage": token_usage,
            "pageDistribution": page_distribution,
        }

    finally:
        # Only delete files that were not persisted for reuse.
        for path in saved_paths:
            if path in persisted_paths:
                continue
            try:
                if os.path.exists(path):
                    os.remove(path)
            except Exception:
                pass
