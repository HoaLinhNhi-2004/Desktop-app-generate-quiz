"""
Quiz API Routes

Endpoints:
  POST /api/quiz/generate    - Generate quiz questions (files / youtube / text)
  POST /api/quiz/extract-text - Extract text preview (files / youtube / text)
  GET  /api/quiz/health      - Health check
  GET  /api/quiz/sets        - List all quiz sets (optional: ?folder_id=)
  GET  /api/quiz/sets/<id>   - Get one quiz set with questions
  DELETE /api/quiz/sets/<id> - Delete a quiz set

Input types (inputType form field):
  files   - multipart file upload (PDF / DOCX / images)
  youtube - youtubeUrl + captionLang form fields
  text    - rawText form field
"""

import os
import re
import json
import uuid
import logging
from collections import Counter
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, current_app
from werkzeug.utils import secure_filename

from app.db import db
from app.features.quizz.models import QuizSet, Question
from app.features.upload.models import UploadedFileRecord

logger = logging.getLogger(__name__)

quiz_bp = Blueprint("quiz", __name__)


def _allowed_file(filename: str) -> bool:
    """Check if file extension is allowed"""
    allowed = current_app.config.get("ALLOWED_EXTENSIONS", set())
    return "." in filename and filename.rsplit(".", 1)[1].lower() in allowed


def _save_uploaded_file(file) -> str:
    """Save uploaded file and return the saved path"""
    upload_folder = current_app.config["UPLOAD_FOLDER"]
    original_name = secure_filename(file.filename)
    # Add UUID prefix to avoid name collisions
    unique_name = f"{uuid.uuid4().hex[:8]}_{original_name}"
    filepath = os.path.join(upload_folder, unique_name)
    file.save(filepath)
    return filepath


def _extract_text_from_file(filepath: str, lang: str = "vi") -> str:
    """Extract text from a single file (image or PDF)"""
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
        # Image file
        from app.features.quizz.ocr_service import extract_text_from_image
        return extract_text_from_image(filepath, lang=lang)


@quiz_bp.route("/health", methods=["GET"])
def quiz_health():
    """Health check for quiz service"""
    return jsonify({"status": "ok", "service": "quiz"})


@quiz_bp.route("/sets", methods=["GET"])
def list_quiz_sets():
    """List all quiz sets. Query param: folder_id (optional) to filter by folder."""
    folder_id = request.args.get("folder_id")
    query = QuizSet.query.order_by(QuizSet.created_at.desc())
    if folder_id:
        query = query.filter_by(folder_id=folder_id)
    sets = query.all()
    return jsonify([s.to_dict(include_questions=False) for s in sets]), 200


@quiz_bp.route("/sets/<quiz_set_id>", methods=["GET"])
def get_quiz_set(quiz_set_id):
    """Get one quiz set with all questions."""
    quiz_set = QuizSet.query.get(quiz_set_id)
    if not quiz_set:
        return jsonify({"error": "Quiz set not found"}), 404
    return jsonify(quiz_set.to_dict(include_questions=True)), 200


@quiz_bp.route("/sets/<quiz_set_id>", methods=["PUT"])
def update_quiz_set(quiz_set_id):
    """Update a quiz set's metadata and questions."""
    quiz_set = QuizSet.query.get(quiz_set_id)
    if not quiz_set:
        return jsonify({"error": "Quiz set not found"}), 404

    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400

    if "title" in data:
        quiz_set.title = data["title"]
    if "config" in data:
        quiz_set.set_config(data["config"])

    if "questions" in data:
        incoming_qs = data["questions"]
        existing_qs = {q.id: q for q in quiz_set.questions}
        
        # Keep track of updated ids
        updated_ids = set()

        for idx, q_data in enumerate(incoming_qs):
            q_id = q_data.get("id")
            if not q_id:
                q_id = f"q{idx+1}_{uuid.uuid4().hex[:6]}"

            updated_ids.add(q_id)
            if q_id in existing_qs:
                q = existing_qs[q_id]
            else:
                q = Question(id=q_id, quiz_set_id=quiz_set.id)
                db.session.add(q)
            
            q.question_number = q_data.get("questionNumber", idx + 1)
            q.type = q_data.get("type", "multiple-choice")
            q.question_text = q_data.get("questionText", "")
            q.set_options(q_data.get("options", []))
            q.correct_answer_id = q_data.get("correctAnswerId", "")
            if q.type == "multiple-answer":
                q.set_correct_answer_ids(q_data.get("correctAnswerIds", []))
            q.explanation = q_data.get("explanation", "")
            q.set_source_pages(q_data.get("sourcePages", []))
            q.set_source_keyword(q_data.get("sourceKeyword", []))

        # Remove deleted questions
        for existing_id, q in existing_qs.items():
            if existing_id not in updated_ids:
                db.session.delete(q)

    db.session.commit()
    return jsonify(quiz_set.to_dict(include_questions=True)), 200


@quiz_bp.route("/sets/<quiz_set_id>", methods=["DELETE"])
def delete_quiz_set(quiz_set_id):
    """Delete a quiz set and its questions."""
    quiz_set = QuizSet.query.get(quiz_set_id)
    if not quiz_set:
        return jsonify({"error": "Quiz set not found"}), 404
    db.session.delete(quiz_set)
    db.session.commit()
    return jsonify({"message": "Quiz set deleted"}), 200


@quiz_bp.route("/sets/<quiz_set_id>/source-text", methods=["GET"])
def get_quiz_set_source_text(quiz_set_id):
    """
    Return source text split into per-page sections for heatmap rendering.

    Response:
      {
        "pages": [{"page": 1, "text": "...", "charCount": N}, ...],
        "inputType": "files" | "youtube" | "text" | "unknown",
        "totalPages": N,
        "youtubeUrl": "..."  # only for youtube
      }
    """
    quiz_set = QuizSet.query.get(quiz_set_id)
    if not quiz_set:
        return jsonify({"error": "Quiz set not found"}), 404

    # Look up uploads by source_upload_ids first (handles reused files),
    # fall back to quiz_set_id FK for older records.
    uploads = []
    source_ids = quiz_set.get_source_upload_ids()
    if source_ids:
        uploads = (
            UploadedFileRecord.query
            .filter(UploadedFileRecord.id.in_(source_ids))
            .order_by(UploadedFileRecord.created_at)
            .all()
        )
    if not uploads:
        uploads = (
            UploadedFileRecord.query
            .filter_by(quiz_set_id=quiz_set_id)
            .order_by(UploadedFileRecord.created_at)
            .all()
        )

    if not uploads:
        return jsonify({"pages": [], "inputType": "unknown", "totalPages": 0}), 200

    input_mode = uploads[0].input_mode

    # YouTube — transcript not stored, just return the URL
    if input_mode == "youtube":
        return jsonify({
            "pages": [],
            "inputType": "youtube",
            "totalPages": 0,
            "youtubeUrl": uploads[0].source_label or "",
        }), 200

    # Raw text — read stored .txt file and split into ~2 000-char sections
    if input_mode == "text":
        record = uploads[0]
        if record.stored_path and os.path.isfile(record.stored_path):
            try:
                with open(record.stored_path, "r", encoding="utf-8") as fh:
                    raw = fh.read()
                SECTION_SIZE = 2000
                paragraphs = re.split(r"\n{2,}", raw.strip())
                pages: list[dict] = []
                page_num = 1
                current = ""
                for para in paragraphs:
                    if len(current) + len(para) + 2 > SECTION_SIZE and current:
                        pages.append({"page": page_num, "text": current.strip(), "charCount": len(current.strip())})
                        page_num += 1
                        current = para
                    else:
                        current = (current + "\n\n" + para).strip() if current else para
                if current.strip():
                    pages.append({"page": page_num, "text": current.strip(), "charCount": len(current.strip())})
                return jsonify({"pages": pages, "inputType": "text", "totalPages": len(pages)}), 200
            except Exception as e:
                logger.warning("source-text: could not read text file: %s", e)
        return jsonify({"pages": [], "inputType": "text", "totalPages": 0}), 200

    # Files (PDF / DOCX / image)
    from app.features.quizz.pdf_service import extract_text_from_pdf_paged
    from app.features.quizz.docx_service import extract_text_from_docx

    all_pages: list[dict] = []
    page_offset = 0

    for record in uploads:
        path = record.stored_path or ""
        if not (path and os.path.isfile(path)):
            continue
        ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""

        if ext == "pdf":
            try:
                paged_text, total = extract_text_from_pdf_paged(path)
                if paged_text:
                    blocks = re.split(r"--- TRANG \d+ ---\n?", paged_text)
                    texts = [b.strip() for b in blocks if b.strip()]
                    for i, t in enumerate(texts, start=1):
                        all_pages.append({"page": i + page_offset, "text": t, "charCount": len(t)})
                    page_offset += total
            except Exception as e:
                logger.warning("source-text PDF failed %s: %s", path, e)

        elif ext in ("docx", "doc", "xlsx", "xls", "csv"):
            try:
                if ext in ("docx", "doc"):
                    text = extract_text_from_docx(path)
                else:
                    from app.features.quizz.spreadsheet_service import extract_text_from_spreadsheet
                    text = extract_text_from_spreadsheet(path, ext)

                if text.strip():
                    SECTION_SIZE = 2000
                    paragraphs = re.split(r"\n{2,}", text.strip())
                    current = ""
                    for para in paragraphs:
                        if len(current) + len(para) + 2 > SECTION_SIZE and current:
                            all_pages.append({"page": page_offset + 1, "text": current.strip(), "charCount": len(current.strip())})
                            page_offset += 1
                            current = para
                        else:
                            current = (current + "\n\n" + para).strip() if current else para
                    if current.strip():
                        all_pages.append({"page": page_offset + 1, "text": current.strip(), "charCount": len(current.strip())})
                        page_offset += 1
            except Exception as e:
                logger.warning("source-text DOCX failed %s: %s", path, e)

    return jsonify({"pages": all_pages, "inputType": "files", "totalPages": len(all_pages)}), 200


@quiz_bp.route("/sets/<quiz_set_id>/heatmap-blocks", methods=["GET"])
def get_quiz_set_heatmap_blocks(quiz_set_id):
    """
    Return block-level heatmap data: bounding boxes of text blocks in the source
    PDF, each annotated with how many quiz keywords matched that block.

    Response:
      {
        "blocks": [
          {
            "page": 1,
            "bbox": [x0, y0, x1, y1],
            "count": 3,
            "keywords": ["keyword1", ...],
            "pageWidth": 612.0,
            "pageHeight": 792.0
          },
          ...
        ],
        "maxCount": 5
      }
    """
    quiz_set = QuizSet.query.get(quiz_set_id)
    if not quiz_set:
        return jsonify({"error": "Quiz set not found"}), 404

    # Get questions
    questions = [q.to_dict() for q in quiz_set.questions]
    if not questions:
        logger.warning("[heatmap] quiz_set %s has no questions", quiz_set_id)
        return jsonify({"blocks": [], "maxCount": 0}), 200

    logger.info("[heatmap] quiz_set %s: %d questions", quiz_set_id, len(questions))

    # Debug: log sourceKeyword from first few questions
    for i, q in enumerate(questions[:3]):
        logger.info("[heatmap]   q%d sourceKeyword=%s, sourcePages=%s",
                     i, q.get("sourceKeyword"), q.get("sourcePages"))

    # Gather source PDF files
    uploads = (
        UploadedFileRecord.query
        .filter_by(quiz_set_id=quiz_set_id)
        .order_by(UploadedFileRecord.created_at)
        .all()
    )
    logger.info("[heatmap] uploads by quiz_set_id FK: %d records", len(uploads))

    # Also try sourceUploadIds
    if not uploads:
        source_ids = quiz_set.get_source_upload_ids()
        logger.info("[heatmap] source_upload_ids from quiz_set: %s", source_ids)
        if source_ids:
            uploads = UploadedFileRecord.query.filter(
                UploadedFileRecord.id.in_(source_ids)
            ).all()
            logger.info("[heatmap] uploads by source_upload_ids: %d records", len(uploads))

    if not uploads:
        logger.warning("[heatmap] no upload records found for quiz_set %s", quiz_set_id)
        return jsonify({"blocks": [], "maxCount": 0}), 200

    from app.features.quizz.heatmap_service import build_heatmap_blocks

    all_blocks: list[dict] = []
    page_offset = 0

    for record in uploads:
        path = record.stored_path or ""
        logger.info("[heatmap] record %s: stored_path=%s, file_type=%s, input_mode=%s",
                     record.id, path, record.file_type, record.input_mode)
        if not (path and os.path.isfile(path)):
            logger.warning("[heatmap]   file not found on disk: %s", path)
            continue
        ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
        if ext != "pdf":
            logger.info("[heatmap]   skipping non-pdf: ext=%s", ext)
            continue

        logger.info("[heatmap]   processing PDF: %s", path)
        blocks = build_heatmap_blocks(path, questions, page_offset=page_offset)
        logger.info("[heatmap]   got %d blocks from build_heatmap_blocks", len(blocks))
        all_blocks.extend(blocks)

        # Advance page_offset for multi-file support
        try:
            import fitz
            doc = fitz.open(path)
            page_offset += len(doc)
            doc.close()
        except Exception:
            pass

    max_count = max((b["count"] for b in all_blocks), default=0)
    return jsonify({"blocks": all_blocks, "maxCount": max_count}), 200


@quiz_bp.route("/sets/<quiz_set_id>/youtube-timeline", methods=["GET"])
def get_quiz_set_youtube_timeline(quiz_set_id):
    """
    Return a timeline heatmap for YouTube-sourced quizzes.

    Fetches the timed transcript from YouTube on demand, then maps
    question sourceKeywords to transcript segments grouped by minute.

    Response:
      {
        "segments": [
          {"minute": 0, "label": "0:00", "questionCount": 2, "keywords": [...]},
          ...
        ],
        "totalDuration": 600,
        "youtubeUrl": "https://..."
      }
    """
    quiz_set = QuizSet.query.get(quiz_set_id)
    if not quiz_set:
        return jsonify({"error": "Quiz set not found"}), 404

    uploads = (
        UploadedFileRecord.query
        .filter_by(quiz_set_id=quiz_set_id)
        .order_by(UploadedFileRecord.created_at)
        .all()
    )
    if not uploads:
        source_ids = quiz_set.get_source_upload_ids()
        if source_ids:
            uploads = UploadedFileRecord.query.filter(
                UploadedFileRecord.id.in_(source_ids)
            ).all()

    yt_record = next((r for r in uploads if r.input_mode == "youtube"), None)
    if not yt_record:
        return jsonify({"error": "This quiz was not created from YouTube"}), 400

    yt_url = yt_record.source_label or ""
    if not yt_url:
        return jsonify({"error": "YouTube URL not found"}), 400

    questions = [q.to_dict() for q in quiz_set.questions]

    # Determine transcript language from quiz config
    quiz_config = quiz_set.get_config() or {}
    transcript_lang = quiz_config.get("language", "vi")

    # Fetch timed transcript
    from app.features.quizz.youtube_service import extract_transcript_timed
    try:
        timed_entries = extract_transcript_timed(yt_url, lang=transcript_lang)
    except Exception as e:
        logger.warning("Failed to fetch timed transcript: %s", e)
        # Fallback: try English
        try:
            timed_entries = extract_transcript_timed(yt_url, lang="en")
        except Exception:
            return jsonify({"error": f"Could not fetch transcript: {e}"}), 422

    if not timed_entries:
        return jsonify({"segments": [], "totalDuration": 0, "youtubeUrl": yt_url}), 200

    # Determine total duration
    last_entry = timed_entries[-1]
    total_duration = last_entry["start"] + last_entry["duration"]
    total_minutes = int(total_duration // 60) + 1

    # Build minute buckets with text
    minute_texts: dict[int, str] = {}
    for entry in timed_entries:
        minute = int(entry["start"] // 60)
        if minute not in minute_texts:
            minute_texts[minute] = ""
        minute_texts[minute] += " " + entry["text"]

    # Build keyword list from questions
    def _normalize(text: str) -> str:
        return re.sub(r"\s+", " ", text.lower().strip())

    kw_list: list[str] = []
    for q in questions:
        for kw in (q.get("sourceKeyword") or []):
            k = _normalize(kw)
            if k and len(k) >= 2:
                kw_list.append(k)

    # Match keywords to minute buckets
    segments = []
    for minute in range(total_minutes):
        bucket_text = _normalize(minute_texts.get(minute, ""))
        matched_keywords = []
        for kw in kw_list:
            if kw in bucket_text:
                matched_keywords.append(kw)
        m = minute
        hours = m // 60
        mins = m % 60
        label = f"{hours}:{mins:02d}:00" if hours > 0 else f"{mins}:00"
        segments.append({
            "minute": minute,
            "label": label,
            "questionCount": len(matched_keywords),
            "keywords": list(set(matched_keywords)),
        })

    return jsonify({
        "segments": segments,
        "totalDuration": round(total_duration, 1),
        "youtubeUrl": yt_url,
    }), 200


# ---------------------------------------------------------------------------
# Input quality guard
# ---------------------------------------------------------------------------

_MIN_CHARS = 80          # absolute minimum meaningful characters
_MIN_UNIQUE_WORDS = 10   # minimum distinct words
_CHARS_PER_QUESTION = 60 # at least this many chars per requested question


def _validate_text_quality(text: str, num_questions: int) -> tuple:
    """
    Validate extracted/cleaned text before sending to the LLM.

    Returns:
        (error_str_or_None, capped_num_questions)

    Checks:
    1. Absolute minimum character threshold.
    2. Minimum unique-word count (catches "aaaa aaaa aaaa ...").
    3. Repetition ratio: if the 3 most common words make up > 65 %% of all
       words, the text is considered garbage / low-quality.
    4. Per-question text budget: cap num_questions so one question has
       at least _CHARS_PER_QUESTION characters of source material.
    """
    stripped = text.strip()

    # --- 1. Min length ---
    if len(stripped) < _MIN_CHARS:
        return (
            f"Nội dung quá ngắn ({len(stripped)} ký tự). "
            f"Vui lòng cung cấp ít nhất {_MIN_CHARS} ký tự có nội dung thực sự.",
            num_questions,
        )

    # --- 2. Min unique word count ---
    words = re.findall(r"\b\w{2,}\b", stripped.lower())
    unique_words = set(words)
    if len(unique_words) < _MIN_UNIQUE_WORDS:
        return (
            f"Nội dung quá lặp lại hoặc vô nghĩa ({len(unique_words)} từ duy nhất). "
            "Vui lòng cung cấp nội dung có đủ kiến thức để tạo câu hỏi.",
            num_questions,
        )

    # --- 3. Repetition ratio ---
    if words:
        top3_count = sum(c for _, c in Counter(words).most_common(3))
        repetition_ratio = top3_count / len(words)
        if repetition_ratio > 0.65:
            return (
                "Nội dung có tính lặp lại quá cao và không đủ đa dạng để tạo quiz. "
                "Vui lòng cung cấp tài liệu có nội dung phong phú hơn.",
                num_questions,
            )

    # --- 4. Cap questions based on text budget ---
    max_allowed = max(1, len(stripped) // _CHARS_PER_QUESTION)
    capped = min(num_questions, max_allowed)
    if capped < num_questions:
        logger.warning(
            "Capping num_questions from %d → %d (text only has %d chars)",
            num_questions, capped, len(stripped),
        )

    return None, capped


def _parse_config(form) -> dict:
    """Parse and validate quiz config from form data."""
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


def _extract_combined_text(input_type: str, form, files_list, saved_paths: list, config: dict, reused_file_ids: list = None) -> str:
    """
    Extract and return combined text based on inputType.
    For 'files': saves files to disk, extracts text, appends paths to saved_paths.
                 Also loads reused files from disk using their stored paths.
    For 'youtube': fetches transcript.
    For 'text': returns rawText directly.
    """
    if input_type == "youtube":
        youtube_url = (form.get("youtubeUrl") or "").strip()
        if not youtube_url:
            raise ValueError("youtubeUrl is required for inputType=youtube")
        caption_lang = (form.get("captionLang") or "vi").strip() or "vi"
        from app.features.quizz.youtube_service import extract_transcript
        return extract_transcript(youtube_url, lang=caption_lang)

    if input_type == "text":
        raw_text = (form.get("rawText") or "").strip()
        if not raw_text:
            raise ValueError("rawText is required for inputType=text")
        if len(raw_text) > 50000:
            raise ValueError("rawText exceeds maximum length of 50,000 characters")
        return raw_text

    # Default: files — new uploads + reused files
    for file in files_list:
        if file and file.filename and _allowed_file(file.filename):
            path = _save_uploaded_file(file)
            saved_paths.append(path)
        elif file and file.filename:
            raise ValueError(f"File type not allowed: {file.filename}")

    # Load reused files from existing upload records
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
        raise ValueError("No valid files to process")

    ocr_lang = config["language"]
    all_texts = []
    page_offset = 0
    for path in all_paths:
        ext = path.rsplit(".", 1)[-1].lower()
        if ext == "pdf":
            from app.features.quizz.pdf_service import extract_text_from_pdf_paged
            paged_text, n_pages = extract_text_from_pdf_paged(path, lang=ocr_lang)
            if paged_text.strip():
                # Offset page numbers so multi-PDF uploads have globally unique page numbers
                if page_offset > 0:
                    for p in range(n_pages, 0, -1):
                        paged_text = paged_text.replace(
                            f"--- TRANG {p} ---",
                            f"--- TRANG {p + page_offset} ---",
                        )
                page_offset += n_pages
                all_texts.append(paged_text)
        else:
            text = _extract_text_from_file(path, lang=ocr_lang)
            if text.strip():
                all_texts.append(text)

    return "\n\n".join(all_texts)


@quiz_bp.route("/generate", methods=["POST"])
def generate_quiz():
    """
    Generate quiz questions from files, youtube URL, or plain text.

    Expects multipart/form-data with:
      - inputType: 'files' (default) | 'youtube' | 'text'
      For inputType=files:
        - files: one or more files (PDF / DOCX / images)
      For inputType=youtube:
        - youtubeUrl: YouTube video URL
        - captionLang: subtitle language code (default 'vi')
      For inputType=text:
        - rawText: plain text (max 50,000 chars)
      Common fields:
        - numberOfQuestions, questionType, difficulty, language, timePerQuestion
        - folderId (optional), title (optional)

    Returns:
      { quizSetId, questions, extractedText, totalTextLength, filesProcessed, config, inputType }
    """
    input_type = (request.form.get("inputType") or "files").strip().lower()
    if input_type not in {"files", "youtube", "text"}:
        return jsonify({"error": f"Invalid inputType: {input_type}"}), 400

    # Validate file presence only for files mode
    files = request.files.getlist("files") if input_type == "files" else []
    reused_file_ids = []
    if input_type == "files":
        # Parse reusedFileIds (JSON array of upload record IDs)
        raw_reused = request.form.get("reusedFileIds", "").strip()
        if raw_reused:
            try:
                reused_file_ids = json.loads(raw_reused)
                if not isinstance(reused_file_ids, list):
                    reused_file_ids = []
            except (json.JSONDecodeError, TypeError):
                reused_file_ids = []

        has_new_files = files and any(f.filename != "" for f in files)
        has_reused = len(reused_file_ids) > 0
        if not has_new_files and not has_reused:
            return jsonify({"error": "No files selected"}), 400

    # Parse & validate quiz config
    try:
        config = _parse_config(request.form)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    # Resolve API key from the DB key pool (Settings > API Keys)
    gemini_key = ""
    active_key_id = None
    try:
        from app.features.api_keys.key_manager import get_optimal_key
        key_obj = get_optimal_key()
        if key_obj:
            gemini_key = key_obj.key
            active_key_id = key_obj.id
    except Exception:
        pass

    if not gemini_key:
        return jsonify({"error": "Chưa có Gemini API key. Vào trang API Keys (Settings) để thêm key."}), 500

    fallback_chain = current_app.config.get(
        "GEMINI_FALLBACK_CHAIN",
        ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"],
    )

    saved_paths = []
    persisted_paths = set()
    try:
        # Step 1: Extract text
        # Fast path — if all reused files have been processed, use pre-computed
        # chunks from the vector store instead of re-extracting from disk.
        use_vector_chunks = False
        combined_text = ""

        if input_type == "files" and reused_file_ids and not (files and any(f.filename != "" for f in files)):
            processed_ids = []
            for rid in reused_file_ids:
                rec = UploadedFileRecord.query.get(rid)
                if rec and rec.processing_status == "completed":
                    processed_ids.append(rid)

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

        if not use_vector_chunks:
            try:
                combined_text = _extract_combined_text(input_type, request.form, files, saved_paths, config, reused_file_ids=reused_file_ids)
            except ValueError as e:
                return jsonify({"error": str(e)}), 400

        if not combined_text.strip():
            msg = {
                "files": "Could not extract any text from uploaded files",
                "youtube": "No transcript content found in the YouTube video",
                "text": "rawText is empty",
            }.get(input_type, "No text content found")
            return jsonify({"error": msg}), 422

        # Step 1c: Validate text quality + cap question count
        quality_error, config["numberOfQuestions"] = _validate_text_quality(
            combined_text, config["numberOfQuestions"]
        )
        if quality_error:
            return jsonify({"error": quality_error}), 422

        # Step 1b: Condense the source text into a quiz-ready representation.
        #
        # YouTube (long transcripts):
        #   2-pass approach — summarize the full transcript into a ~8 000-char outline
        #   (Pass 1). This fixes ASR errors, covers the whole video, and reduces token
        #   usage by 80-90% versus sending the raw transcript to the quiz generator.
        #   Then generate quiz from the outline (Pass 2).
        #
        # Files / raw text:
        #   Smart chunk selection — score each chunk by technical density and pick
        #   the most content-rich chunks (up to 40 000 chars total).
        from app.features.quizz.text_processing import filter_boilerplate, clean_text, chunk_text, select_important_chunks

        if input_type == "youtube":
            # Pass 1: summarize full transcript → dense outline
            from app.features.quizz.youtube_service import summarize_transcript
            logger.info("Summarizing YouTube transcript (%d chars) before quiz generation", len(combined_text))
            quiz_text = summarize_transcript(
                combined_text,
                api_key=gemini_key,
                model_chain=fallback_chain,
            )
            cleaned = quiz_text  # summary is already clean
        else:
            # Files / text: filter boilerplate + smart-chunk selection
            filtered = filter_boilerplate(combined_text)
            cleaned = clean_text(filtered)
            chunks = chunk_text(cleaned, max_chunk_size=8000)
            selected_chunks = select_important_chunks(chunks, n=6)
            quiz_text = "\n\n".join(selected_chunks)
            if len(quiz_text) > 40_000:
                quiz_text = quiz_text[:40_000]

        # Step 3: Generate quiz with LLM (auto-fallback on 429)
        from app.features.quizz.quiz_generator import generate_quiz as gen_quiz
        questions, token_usage = gen_quiz(
            text=quiz_text,
            num_questions=config["numberOfQuestions"],
            question_type=config["questionType"],
            difficulty=config["difficulty"],
            language=config["language"],
            gemini_api_key=gemini_key,
            model_chain=fallback_chain,
        )

        # Record token usage to the key in DB (runs in main request thread)
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

        # Save to SQLite
        folder_id = request.form.get("folderId") or None
        if folder_id and folder_id.strip() == "":
            folder_id = None
        title = (request.form.get("title") or "").strip() or f"Quiz {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')}"
        quiz_set_id = str(uuid.uuid4())

        # Compute page distribution (PDF files only)
        page_distribution = None
        if input_type == "files":
            from app.features.quizz.pdf_service import get_pdf_page_stats
            # Collect all PDF file paths (new + reused)
            reused_paths_for_dist = []
            for rid in reused_file_ids:
                r = UploadedFileRecord.query.get(rid)
                if r and r.stored_path and os.path.isfile(r.stored_path):
                    reused_paths_for_dist.append(r.stored_path)
            all_file_paths = saved_paths + reused_paths_for_dist
            pdf_paths_for_dist = [p for p in all_file_paths if p.rsplit(".", 1)[-1].lower() == "pdf"]
            if pdf_paths_for_dist:
                page_offset = 0
                all_pages: list[dict] = []
                for pp in pdf_paths_for_dist:
                    page_stats = get_pdf_page_stats(pp)
                    for s in page_stats:
                        all_pages.append({"page": s["page"] + page_offset, "char_count": s["char_count"]})
                    page_offset += len(page_stats)
                if all_pages:
                    total_chars = sum(p["char_count"] for p in all_pages)
                    total_q = len(questions)
                    if total_chars > 0 and total_q > 0:
                        # Proportional distribution with integer correction
                        float_q = [p["char_count"] / total_chars * total_q for p in all_pages]
                        int_q = [int(x) for x in float_q]
                        remainder = total_q - sum(int_q)
                        fractions = sorted(range(len(all_pages)), key=lambda i: -(float_q[i] - int_q[i]))
                        for i in range(remainder):
                            int_q[fractions[i]] += 1
                        dist = {str(all_pages[i]["page"]): int_q[i] for i in range(len(all_pages))}
                        page_distribution = {"distribution": dist, "totalPages": len(all_pages)}

        quiz_set = QuizSet(id=quiz_set_id, folder_id=folder_id, title=title)
        quiz_set.set_config(config)
        if page_distribution:
            quiz_set.set_page_distribution(page_distribution)
        # Store which upload records were used (for PDF viewer lookup)
        if reused_file_ids:
            quiz_set.set_source_upload_ids(reused_file_ids)
        db.session.add(quiz_set)

        for q in questions:
            q_type = q.get("type", "multiple-choice")
            # For multiple-answer, correctAnswerIds is a list; correctAnswerId = first id
            correct_ids = q.get("correctAnswerIds", [])
            correct_id = q.get("correctAnswerId", "")
            if q_type == "multiple-answer" and correct_ids:
                correct_id = correct_ids[0] if correct_ids else correct_id
            question = Question(
                id=f"q{q.get('questionNumber', 0)}_{uuid.uuid4().hex[:8]}",  # always fresh — never reuse cached IDs
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

            # Write generated ID back so the API response includes it
            q["id"] = question.id

        # Save upload records so the user can see what files were used
        # Files with records are kept on disk for future reuse
        persisted_paths = set()
        if folder_id:
            if input_type == "files":
                # Build a mapping of valid files (that were actually saved) to their paths
                valid_files = [f for f in files if f and f.filename and _allowed_file(f.filename)]
                for idx, f in enumerate(valid_files):
                    fname = secure_filename(f.filename) if f.filename else "unknown"
                    ext = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
                    # Seek to end to get file size, then reset
                    f.seek(0, 2)
                    fsize = f.tell()
                    f.seek(0)
                    # Match this file to its saved path (by index in valid files)
                    file_stored_path = saved_paths[idx] if idx < len(saved_paths) else ""
                    if file_stored_path:
                        persisted_paths.add(file_stored_path)
                    record = UploadedFileRecord(
                        id=str(uuid.uuid4()),
                        folder_id=folder_id,
                        original_name=fname,
                        file_size=fsize,
                        file_type=ext,
                        input_mode="files",
                        stored_path=file_stored_path,
                        quiz_set_id=quiz_set_id,
                    )
                    db.session.add(record)
            elif input_type == "youtube":
                yt_url = request.form.get("youtubeUrl", "")
                record = UploadedFileRecord(
                    id=str(uuid.uuid4()),
                    folder_id=folder_id,
                    original_name="YouTube Video",
                    file_size=0,
                    file_type="youtube",
                    input_mode="youtube",
                    source_label=yt_url,
                    quiz_set_id=quiz_set_id,
                )
                db.session.add(record)
            elif input_type == "text":
                raw = request.form.get("rawText", "")
                text_stored_path = ""
                if raw.strip():
                    upload_folder = current_app.config["UPLOAD_FOLDER"]
                    text_filename = f"{uuid.uuid4().hex[:8]}_rawtext.txt"
                    text_stored_path = os.path.join(upload_folder, text_filename)
                    with open(text_stored_path, "w", encoding="utf-8") as tf:
                        tf.write(raw)
                preview = raw[:200].replace("\n", " ").strip()
                if len(raw) > 200:
                    preview += "…"
                record = UploadedFileRecord(
                    id=str(uuid.uuid4()),
                    folder_id=folder_id,
                    original_name="Văn bản nhập trực tiếp",
                    file_size=len(raw.encode("utf-8")),
                    file_type="text",
                    input_mode="text",
                    source_label=preview,
                    stored_path=text_stored_path,
                    quiz_set_id=quiz_set_id,
                )
                db.session.add(record)

        db.session.commit()

        text_preview = cleaned[:500] + "..." if len(cleaned) > 500 else cleaned
        total_files = len(saved_paths) + len(reused_file_ids)
        files_processed = total_files if input_type == "files" else (1 if input_type in {"youtube", "text"} else 0)

        return jsonify({
            "quizSetId": quiz_set_id,
            "questions": questions,
            "extractedText": text_preview,
            "totalTextLength": len(cleaned),
            "filesProcessed": files_processed,
            "config": config,
            "inputType": input_type,
            "tokenUsage": token_usage,
            "pageDistribution": page_distribution,
        })

    except RuntimeError as e:
        logger.error(f"Quiz generation failed: {e}")
        return jsonify({"error": str(e)}), 500
    except Exception as e:
        logger.error(f"Unexpected error: {e}", exc_info=True)
        return jsonify({"error": f"Internal server error: {str(e)}"}), 500
    finally:
        # Only delete files that were NOT persisted for reuse
        for path in saved_paths:
            if path in persisted_paths:
                continue  # keep for reuse
            try:
                if os.path.exists(path):
                    os.remove(path)
            except Exception:
                pass


@quiz_bp.route("/extract-text", methods=["POST"])
def extract_text():
    """
    Extract text only (preview), without generating a quiz.

    Expects multipart/form-data with:
      - inputType: 'files' (default) | 'youtube' | 'text'
      For inputType=files:
        - files: one or more files
        - language: 'vi' | 'en' (for OCR, default 'vi')
      For inputType=youtube:
        - youtubeUrl: YouTube video URL
        - captionLang: subtitle language code
      For inputType=text:
        - rawText: plain text

    Returns:
      { "text": "...", "totalLength": 1234, "filesProcessed": 2 }
    """
    input_type = (request.form.get("inputType") or "files").strip().lower()
    if input_type not in {"files", "youtube", "text"}:
        return jsonify({"error": f"Invalid inputType: {input_type}"}), 400

    files = request.files.getlist("files") if input_type == "files" else []
    language = request.form.get("language", "vi")
    config_for_extract = {"language": language}

    saved_paths = []
    try:
        try:
            combined = _extract_combined_text(input_type, request.form, files, saved_paths, config_for_extract)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

        from app.features.quizz.text_processing import clean_text
        cleaned = clean_text(combined)
        files_processed = len(saved_paths) if input_type == "files" else (1 if combined.strip() else 0)

        return jsonify({
            "text": cleaned,
            "totalLength": len(cleaned),
            "filesProcessed": files_processed,
        })
    except Exception as e:
        logger.error(f"Text extraction failed: {e}", exc_info=True)
        return jsonify({"error": str(e)}), 500
    finally:
        for path in saved_paths:
            try:
                if os.path.exists(path):
                    os.remove(path)
            except Exception:
                pass
