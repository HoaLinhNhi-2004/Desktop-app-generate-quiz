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
import threading
from flask import Blueprint, request, jsonify, current_app

from app.db import db
from app.features.quizz.models import QuizSet, Question
from app.features.upload.models import UploadedFileRecord
from app.features.quizz.generation_service import (
    GenerationContentError,
    GenerationInputError,
    build_payload,
    extract_combined_text,
    parse_config,
    run_generation,
    save_request_files,
)
from app.utils import event_jobs
from app.utils.errors import internal_error

logger = logging.getLogger(__name__)

quiz_bp = Blueprint("quiz", __name__)


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


def _split_into_sections(raw: str, section_size: int = 2000) -> list[dict]:
    """Split text on paragraph boundaries into ~section_size pseudo-pages."""
    pages: list[dict] = []
    current = ""
    for para in re.split(r"\n{2,}", raw.strip()):
        if len(current) + len(para) + 2 > section_size and current:
            pages.append({"page": len(pages) + 1, "text": current.strip(), "charCount": len(current.strip())})
            current = para
        else:
            current = (current + "\n\n" + para).strip() if current else para
    if current.strip():
        pages.append({"page": len(pages) + 1, "text": current.strip(), "charCount": len(current.strip())})
    return pages


@quiz_bp.route("/sets/<quiz_set_id>/source-text", methods=["GET"])
def get_quiz_set_source_text(quiz_set_id):
    """
    Return source text split into per-page sections for heatmap rendering.

    Response:
      {
        "pages": [{"page": 1, "text": "...", "charCount": N}, ...],
        "inputType": "files" | "youtube" | "web" | "text" | "unknown",
        "totalPages": N,
        "youtubeUrl": "...",  # only for youtube
        "sourceUrl": "..."    # only for web
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
                pages = _split_into_sections(raw)
                return jsonify({"pages": pages, "inputType": "text", "totalPages": len(pages)}), 200
            except Exception as e:
                logger.warning("source-text: could not read text file: %s", e)
        return jsonify({"pages": [], "inputType": "text", "totalPages": 0}), 200

    # Web page / Notion — nothing on disk; replay the chunks that were actually
    # indexed rather than re-fetching, which may have changed since.
    if input_mode in ("web", "notion"):
        from app.features.upload.vector_store import get_records_chunks
        try:
            chunks = get_records_chunks([u.id for u in uploads])
        except Exception as e:
            logger.warning("source-text: could not read %s chunks: %s", input_mode, e)
            chunks = []
        pages = _split_into_sections("\n\n".join(chunks)) if chunks else []
        return jsonify({
            "pages": pages,
            "inputType": input_mode,
            "totalPages": len(pages),
            "sourceUrl": uploads[0].source_label or "",
        }), 200

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


@quiz_bp.route("/generate", methods=["POST"])
def generate_quiz():
    """
    Generate quiz questions from files, youtube URL, or plain text (blocking).

    Expects multipart/form-data with:
      - inputType: 'files' (default) | 'youtube' | 'text'
      - action: 'generate' (default) | 'import'
      For inputType=files:
        - files: one or more files (PDF / DOCX / images)
        - reusedFileIds: JSON array of existing upload record ids
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

    See POST /generate/stream for the same pipeline with live progress.
    """
    try:
        payload = _prepare_generation(request)
    except (GenerationInputError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500

    try:
        return jsonify(run_generation(payload))
    except GenerationInputError as e:
        return jsonify({"error": str(e)}), 400
    except GenerationContentError as e:
        return jsonify({"error": str(e)}), 422
    except RuntimeError as e:
        # The generator raises RuntimeError with intentionally user-facing
        # messages (quota exceeded, no API key, ...) — safe to forward.
        logger.error("Quiz generation failed: %s", e)
        return jsonify({"error": str(e)}), 500
    except Exception as e:
        return internal_error(e, log_label="quiz.generate")


def _prepare_generation(req) -> dict:
    """
    Validate the request and freeze it into a payload dict.

    Runs in the request thread: it saves uploads to disk and copies every form
    field, because `request` is unusable once a background job takes over.
    """
    input_type = (req.form.get("inputType") or "files").strip().lower()
    action = (req.form.get("action") or "generate").strip().lower()
    if input_type not in {"files", "youtube", "text"}:
        raise GenerationInputError(f"Invalid inputType: {input_type}")
    if action not in {"generate", "import"}:
        raise GenerationInputError(f"Invalid action: {action}")

    files = req.files.getlist("files") if input_type == "files" else []
    reused_file_ids: list[str] = []
    if input_type == "files":
        raw_reused = req.form.get("reusedFileIds", "").strip()
        if raw_reused:
            try:
                parsed = json.loads(raw_reused)
                reused_file_ids = parsed if isinstance(parsed, list) else []
            except (json.JSONDecodeError, TypeError):
                reused_file_ids = []

        has_new_files = any(f.filename for f in files if f)
        if not has_new_files and not reused_file_ids:
            raise GenerationInputError("No files selected")

    config = parse_config(req.form)

    from app.features.api_keys.key_manager import get_optimal_key
    if not get_optimal_key():
        raise RuntimeError("Chưa có Gemini API key. Vào trang API Keys (Settings) để thêm key.")

    saved_paths, file_meta = save_request_files(files)
    return build_payload(
        req.form, saved_paths, file_meta, reused_file_ids, config, str(uuid.uuid4())
    )


@quiz_bp.route("/generate/stream", methods=["POST"])
def start_generate_stream():
    """
    Start a streaming generation job. Same multipart payload as /generate.

    Returns 202 { jobId, quizSetId }. The quiz set id is minted now but the row
    is only inserted when generation succeeds, so a failed run leaves nothing
    behind — the client must drive the UI from the stream until `done` rather
    than fetching /sets/<id>.
    """
    try:
        payload = _prepare_generation(request)
    except (GenerationInputError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500

    app = current_app._get_current_object()
    job_id = event_jobs.create_job(
        kind="quizImport" if payload["action"] == "import" else "quizGenerate",
        quizSetId=payload["quizSetId"],
        folderId=payload["folderId"],
    )
    emit = event_jobs.emitter(job_id)

    def _run():
        with app.app_context():
            status = "done"
            try:
                emit("done", run_generation(payload, emit))
            except (GenerationInputError, GenerationContentError) as e:
                status = "error"
                emit("error", {"message": str(e), "fatal": True, "status": e.status})
            except RuntimeError as e:
                status = "error"
                logger.error("Quiz generation stream failed: %s", e)
                emit("error", {"message": str(e), "fatal": True, "status": 500})
            except Exception as e:
                status = "error"
                error_id = uuid.uuid4().hex[:12]
                logger.error("quiz.generate.stream failed [eid=%s]", error_id, exc_info=e)
                emit("error", {
                    "message": "Internal server error",
                    "fatal": True,
                    "status": 500,
                    "errorId": error_id,
                })
            finally:
                event_jobs.finish_job(job_id, status)

    threading.Thread(target=_run, daemon=True).start()
    return jsonify({"jobId": job_id, "quizSetId": payload["quizSetId"]}), 202


@quiz_bp.route("/generate/stream/<job_id>", methods=["GET"])
def generate_stream(job_id):
    """SSE progress for a generation job. Resume with ?from=<lastEventId>."""
    if not event_jobs.job_exists(job_id):
        return jsonify({"error": "Job not found"}), 404
    return event_jobs.sse_response(job_id, event_jobs.cursor_from_request())


@quiz_bp.route("/generate/stream/<job_id>/status", methods=["GET"])
def generate_stream_status(job_id):
    """JSON snapshot of a generation job — polling fallback when SSE drops."""
    snapshot = event_jobs.get_snapshot(job_id, event_jobs.cursor_from_request())
    if snapshot is None:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(snapshot), 200


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
            saved_paths, _ = save_request_files(files)
            combined = extract_combined_text(
                input_type, request.form, saved_paths, config_for_extract
            )
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
        return internal_error(e, log_label="quiz.extract_text")
    finally:
        for path in saved_paths:
            try:
                if os.path.exists(path):
                    os.remove(path)
            except Exception:
                pass
