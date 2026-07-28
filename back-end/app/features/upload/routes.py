"""
Upload feature - API routes for listing / uploading / deleting uploaded file records.

Endpoints:
  GET    /api/uploads?folder_id=<id>  - List uploaded file records for a folder
  POST   /api/uploads/upload          - Upload files / YouTube / text as materials
  POST   /api/uploads/<id>/reprocess  - Re-trigger document processing
  DELETE /api/uploads/<id>            - Delete a single record
"""
import os
import uuid
import logging
import threading
from flask import Blueprint, request, jsonify, current_app
from werkzeug.utils import secure_filename
from app.db import db
from app.features.upload.models import UploadedFileRecord
from app.utils import event_jobs

logger = logging.getLogger(__name__)

upload_bp = Blueprint("upload", __name__)

ALLOWED_EXTENSIONS = {"pdf", "doc", "docx", "png", "jpg", "jpeg", "webp", "bmp", "xlsx", "xls", "csv"}


def _upload_allowed(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# One worker thread per folder, draining a FIFO queue.
#
# Records are processed one at a time — the same reason smart_import_service
# does it: concurrent ChromaDB init is fragile, parallel Gemini Vision OCR calls
# burn the shared key pool's RPM with no coordination, and serialising keeps the
# progress stream deterministic. Uploading again while a batch is running
# appends to the queue instead of racing it.
_queues: dict[str, list[str]] = {}
_workers: set[str] = set()
_queue_lock = threading.Lock()


def _drain_queue(app, folder_id: str):
    with app.app_context():
        emit = event_jobs.emitter(folder_id)
        from app.features.upload.document_processor import process_record

        while True:
            with _queue_lock:
                queue = _queues.get(folder_id) or []
                if not queue:
                    # Finish inside the lock so a concurrent _start_processing
                    # either enqueues before this (and we keep going) or after
                    # (and it creates a fresh job plus a new worker).
                    _workers.discard(folder_id)
                    _queues.pop(folder_id, None)
                    event_jobs.finish_job(folder_id, "done")
                    return
                record_id = queue.pop(0)

            try:
                process_record(record_id, emit)
            except Exception as e:
                logger.error("Background processing failed for %s: %s", record_id, e)
                emit("error", {"recordId": record_id, "message": str(e)[:500]})


def _start_processing(folder_id: str, record_ids: list[str]) -> None:
    """Queue records for processing, starting the folder's worker if idle."""
    if not folder_id or not record_ids:
        return
    app = current_app._get_current_object()

    with _queue_lock:
        # (Re)opening the job inside the lock keeps it from being closed by a
        # worker that is finishing at this exact moment.
        event_jobs.create_job(
            folder_id, reuse_running=True, kind="documentProcess", folderId=folder_id
        )
        queue = _queues.setdefault(folder_id, [])
        first_position = len(queue) + (1 if folder_id in _workers else 0)
        queue.extend(record_ids)
        needs_worker = folder_id not in _workers
        if needs_worker:
            _workers.add(folder_id)

    emit = event_jobs.emitter(folder_id)
    for offset, record_id in enumerate(record_ids):
        position = first_position + offset
        if position > 0:
            emit("stage", {"recordId": record_id, "stage": "queued", "current": position})

    if needs_worker:
        threading.Thread(target=_drain_queue, args=(app, folder_id), daemon=True).start()


@upload_bp.route("/upload", methods=["POST"])
def upload_materials():
    """
    Upload materials (files / YouTube URL / text) to a folder independently of quiz generation.

    Expects multipart/form-data:
      - folderId: required
      - inputType: 'files' | 'youtube' | 'text'
      For files: one or more files
      For youtube: youtubeUrl
      For text: rawText
    Returns: { records: [...] } with the created upload record(s).
    """
    folder_id = (request.form.get("folderId") or "").strip()
    if not folder_id:
        return jsonify({"error": "folderId is required"}), 400

    input_type = (request.form.get("inputType") or "files").strip().lower()
    if input_type not in ("files", "youtube", "text"):
        return jsonify({"error": f"Invalid inputType: {input_type}"}), 400

    upload_folder = current_app.config.get("UPLOAD_FOLDER", "uploads")
    os.makedirs(upload_folder, exist_ok=True)

    created_records: list[dict] = []

    if input_type == "files":
        files = request.files.getlist("files")
        valid_files = [f for f in files if f and f.filename and _upload_allowed(f.filename)]
        if not valid_files:
            return jsonify({"error": "No valid files uploaded"}), 400

        for f in valid_files:
            fname = secure_filename(f.filename)
            ext = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
            unique_name = f"{uuid.uuid4().hex[:8]}_{fname}"
            stored_path = os.path.join(upload_folder, unique_name)
            f.save(stored_path)
            fsize = os.path.getsize(stored_path)

            record = UploadedFileRecord(
                id=str(uuid.uuid4()),
                folder_id=folder_id,
                original_name=fname,
                file_size=fsize,
                file_type=ext,
                input_mode="files",
                stored_path=stored_path,
            )
            db.session.add(record)
            created_records.append(record.to_dict())

    elif input_type == "youtube":
        yt_url = (request.form.get("youtubeUrl") or "").strip()
        if not yt_url:
            return jsonify({"error": "youtubeUrl is required"}), 400
        from app.features.quizz.youtube_service import extract_video_id, fetch_video_title
        video_title = fetch_video_title(yt_url)
        if video_title:
            yt_name = video_title
        else:
            vid = extract_video_id(yt_url)
            yt_name = f"YouTube - {vid}" if vid else "YouTube Video"
        record = UploadedFileRecord(
            id=str(uuid.uuid4()),
            folder_id=folder_id,
            original_name=yt_name,
            file_size=0,
            file_type="youtube",
            input_mode="youtube",
            source_label=yt_url,
        )
        db.session.add(record)
        created_records.append(record.to_dict())

    elif input_type == "text":
        raw = request.form.get("rawText", "")
        if not raw.strip():
            return jsonify({"error": "rawText is empty"}), 400
        text_filename = f"{uuid.uuid4().hex[:8]}_rawtext.txt"
        text_stored_path = os.path.join(upload_folder, text_filename)
        with open(text_stored_path, "w", encoding="utf-8") as tf:
            tf.write(raw)
        preview = raw[:200].replace("\n", " ").strip()
        if len(raw) > 200:
            preview += "…"
        text_name = raw[:60].replace("\n", " ").strip()
        if len(raw) > 60:
            text_name += "…"
        record = UploadedFileRecord(
            id=str(uuid.uuid4()),
            folder_id=folder_id,
            original_name=text_name or "Văn bản nhập trực tiếp",
            file_size=len(raw.encode("utf-8")),
            file_type="text",
            input_mode="text",
            source_label=preview,
            stored_path=text_stored_path,
        )
        db.session.add(record)
        created_records.append(record.to_dict())

    db.session.commit()
    logger.info("Uploaded %d material(s) to folder %s", len(created_records), folder_id)

    # Job is created here, in the request thread, so a client subscribing right
    # after the 201 always finds it.
    _start_processing(folder_id, [rec["id"] for rec in created_records])

    return jsonify({"records": created_records}), 201


@upload_bp.route("/", methods=["GET"])
def list_uploads():
    """List uploaded file records, optionally filtered by folder_id, quiz_set_id, or ids."""
    folder_id = request.args.get("folder_id")
    quiz_set_id = request.args.get("quiz_set_id")
    ids_raw = request.args.get("ids")  # comma-separated record IDs
    query = UploadedFileRecord.query.order_by(UploadedFileRecord.created_at.desc())
    if folder_id:
        query = query.filter_by(folder_id=folder_id)
    if quiz_set_id:
        query = query.filter_by(quiz_set_id=quiz_set_id)
    if ids_raw:
        id_list = [i.strip() for i in ids_raw.split(",") if i.strip()]
        if id_list:
            query = query.filter(UploadedFileRecord.id.in_(id_list))
    records = query.all()
    return jsonify([r.to_dict() for r in records])


@upload_bp.route("/<record_id>/reprocess", methods=["POST"])
def reprocess_upload(record_id):
    """Re-trigger document processing for a record (e.g. after a failure)."""
    record = UploadedFileRecord.query.get(record_id)
    if not record:
        return jsonify({"error": "Record not found"}), 404

    # Clean existing chunks before reprocessing
    from app.features.upload.vector_store import delete_record_chunks
    delete_record_chunks(record_id)

    record.processing_status = "pending"
    record.processing_error = None
    record.chunk_count = 0
    db.session.commit()

    _start_processing(record.folder_id, [record_id])

    return jsonify(record.to_dict()), 200


@upload_bp.route("/stream/<folder_id>", methods=["GET"])
def folder_processing_stream(folder_id):
    """
    SSE progress for every record processing in this folder. Resume with
    ?from=<lastEventId>.

    One multiplexed stream per folder rather than one per record: browsers cap
    concurrent connections per origin at 6, and per-record streams would starve
    the polling that acts as this feature's fallback.

    404 when no job exists (e.g. after a backend restart) — clients fall back to
    polling processingStatus.
    """
    if not event_jobs.job_exists(folder_id):
        return jsonify({"error": "No processing job for this folder"}), 404
    return event_jobs.sse_response(folder_id, event_jobs.cursor_from_request())


@upload_bp.route("/<record_id>/file", methods=["GET"])
def serve_upload_file(record_id):
    """Stream the stored file (PDF, image, etc.) for inline viewing."""
    record = UploadedFileRecord.query.get(record_id)
    if not record:
        return jsonify({"error": "Record not found"}), 404
    if not record.stored_path or not os.path.isfile(record.stored_path):
        return jsonify({"error": "File not found on disk"}), 404
    ext = (record.file_type or "").lower().lstrip(".")
    mime_map = {
        "pdf": "application/pdf",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    }
    mimetype = mime_map.get(ext, "application/octet-stream")
    from flask import send_file
    return send_file(
        record.stored_path,
        mimetype=mimetype,
        as_attachment=False,
        download_name=record.original_name,
    )


@upload_bp.route("/<record_id>/content", methods=["GET"])
def get_upload_content(record_id):
    """Return the stored text content for a text-mode upload record."""
    record = UploadedFileRecord.query.get(record_id)
    if not record:
        return jsonify({"error": "Record not found"}), 404
    if record.input_mode != "text":
        return jsonify({"error": "Content only available for text records"}), 400
    if not record.stored_path or not os.path.isfile(record.stored_path):
        return jsonify({"error": "Stored file not found on disk"}), 404
    try:
        with open(record.stored_path, "r", encoding="utf-8") as f:
            content = f.read()
        return jsonify({"content": content})
    except Exception as e:
        logger.warning("Could not read stored text %s: %s", record.stored_path, e)
        return jsonify({"error": "Could not read stored text"}), 500


@upload_bp.route("/<record_id>", methods=["DELETE"])
def delete_upload(record_id):
    """Delete a single upload record, its stored file, and its vector chunks."""
    record = UploadedFileRecord.query.get(record_id)
    if not record:
        return jsonify({"error": "Record not found"}), 404
    # Clean up vector store chunks
    try:
        from app.features.upload.vector_store import delete_record_chunks
        delete_record_chunks(record_id)
    except Exception as e:
        logger.warning("Could not delete vector chunks for %s: %s", record_id, e)
    # Clean up the stored file from disk
    if record.stored_path:
        try:
            if os.path.isfile(record.stored_path):
                os.remove(record.stored_path)
                logger.info("Deleted stored file: %s", record.stored_path)
        except Exception as e:
            logger.warning("Could not delete stored file %s: %s", record.stored_path, e)
    db.session.delete(record)
    db.session.commit()
    return jsonify({"message": "Deleted"}), 200
