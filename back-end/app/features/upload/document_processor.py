"""
Document Processor — Extracts text from uploaded files, chunks it, stores in vector DB.

Processing pipeline (runs after upload):
  1. Detect file type
  2. Extract text:
       - PDF with text layer → pdfplumber
       - PDF scanned (no text) → Gemini OCR
       - DOCX → python-docx
       - Images → Gemini OCR
       - YouTube → transcript API
       - Text → read stored file
  3. Clean & chunk text (1000 chars, 200 overlap)
  4. Store chunks + embeddings in ChromaDB
"""

import os
import logging

from app.db import db
from app.features.upload.models import UploadedFileRecord

logger = logging.getLogger(__name__)

# Chunk config for RAG retrieval (smaller than LLM context chunks)
RAG_CHUNK_SIZE = 1000
RAG_CHUNK_OVERLAP = 200


def _noop(event_type: str, data: dict) -> None:
    pass


def process_record(record_id: str, emit=_noop) -> None:
    """
    Main processing pipeline for an uploaded file record.
    Updates the record's processing_status in the database.

    emit(event_type, data): optional progress callback. Every event carries the
    recordId so one folder-wide stream can multiplex several records.
    """
    record = UploadedFileRecord.query.get(record_id)
    if not record:
        logger.error("Record not found: %s", record_id)
        return

    def _emit(event_type: str, data: dict) -> None:
        emit(event_type, {"recordId": record_id, **data})

    try:
        record.processing_status = "processing"
        db.session.commit()

        # Step 1: Extract text
        _emit("stage", {"stage": "extracting"})
        text = _extract_text(record, _emit)

        if not text or not text.strip():
            record.processing_status = "failed"
            record.processing_error = "Không trích xuất được văn bản nào"
            db.session.commit()
            _emit("error", {"message": record.processing_error})
            return

        # Step 2: Filter boilerplate, clean, and chunk
        from app.features.quizz.text_processing import filter_boilerplate, clean_text, chunk_text

        _emit("stage", {"stage": "chunking"})
        filtered = filter_boilerplate(text)
        cleaned = clean_text(filtered)
        chunks = chunk_text(cleaned, max_chunk_size=RAG_CHUNK_SIZE, overlap=RAG_CHUNK_OVERLAP)

        # Step 3: Store in vector DB
        from app.features.upload.vector_store import store_chunks

        _emit("stage", {"stage": "embedding", "total": len(chunks)})
        count = store_chunks(
            record_id=record.id,
            folder_id=record.folder_id,
            source_name=record.original_name,
            chunks=chunks,
        )

        record.processing_status = "completed"
        record.chunk_count = count
        record.processing_error = None
        db.session.commit()

        logger.info(
            "Processed record %s: %d chunks from '%s'",
            record_id, count, record.original_name,
        )
        _emit("done", {"chunkCount": count})

    except Exception as e:
        logger.error("Processing failed for record %s: %s", record_id, e, exc_info=True)
        try:
            record.processing_status = "failed"
            record.processing_error = str(e)[:500]
            db.session.commit()
        except Exception:
            pass
        _emit("error", {"message": str(e)[:500]})


# ── Text extraction by file type ──────────────────────────────────────────────


def _extract_text(record: UploadedFileRecord, emit=_noop) -> str:
    """Route to the appropriate extractor based on input mode / file type."""
    if record.input_mode == "text":
        return _extract_text_mode(record)
    elif record.input_mode == "youtube":
        return _extract_youtube(record)
    elif record.input_mode == "web":
        return _extract_web(record)
    elif record.input_mode == "notion":
        return _extract_notion(record)
    elif record.input_mode in ("files", "gdrive"):
        # Drive files are downloaded to disk with a real extension, so the
        # file-type dispatch below applies to them unchanged.
        return _extract_file(record, emit)
    else:
        raise ValueError(f"Unknown input mode: {record.input_mode}")


def _extract_text_mode(record: UploadedFileRecord) -> str:
    if not record.stored_path or not os.path.isfile(record.stored_path):
        return ""
    with open(record.stored_path, "r", encoding="utf-8") as f:
        return f.read()


def _extract_youtube(record: UploadedFileRecord) -> str:
    url = record.source_label
    if not url:
        return ""
    from app.features.quizz.youtube_service import extract_transcript
    return extract_transcript(url)


def _extract_web(record: UploadedFileRecord) -> str:
    url = record.source_label
    if not url:
        return ""
    from app.features.quizz.web_service import extract_text_from_url
    return extract_text_from_url(url)


def _extract_notion(record: UploadedFileRecord) -> str:
    url = record.source_label
    if not url:
        return ""
    from app.features.integrations import notion_service
    page_id = notion_service.extract_page_id(url)
    if not page_id:
        raise ValueError(f"Không nhận ra ID trang Notion trong: {url}")
    return notion_service.extract_page_text(page_id)


def _extract_file(record: UploadedFileRecord, emit=_noop) -> str:
    if not record.stored_path or not os.path.isfile(record.stored_path):
        raise FileNotFoundError(f"File not found: {record.stored_path}")

    ext = (record.file_type or "").lower().strip(".")

    if ext == "pdf":
        return _extract_pdf(record.stored_path, emit)
    elif ext in ("docx", "doc"):
        from app.features.quizz.docx_service import extract_text_from_docx
        return extract_text_from_docx(record.stored_path)
    elif ext in ("png", "jpg", "jpeg", "webp", "bmp", "tiff"):
        from app.features.quizz.ocr_service import extract_text_from_image
        return extract_text_from_image(record.stored_path)
    elif ext in ("xlsx", "xls", "csv"):
        from app.features.quizz.spreadsheet_service import extract_text_from_spreadsheet
        return extract_text_from_spreadsheet(record.stored_path, ext)
    else:
        raise ValueError(f"Unsupported file type: {ext}")


def _extract_pdf(file_path: str, emit=_noop) -> str:
    """
    Smart PDF extraction:
      - Has text layer (pdfplumber yields >50 chars): direct text extraction
      - Scanned / image PDF: Gemini OCR via vision API

    A scanned PDF runs the whole pdfplumber pass first, so progress reports
    "extracting 1..N" and only then "ocr 1..N" — two sequential stages, not one
    bar going backwards.
    """
    import pdfplumber

    text_parts: list[str] = []
    total_chars = 0

    try:
        with pdfplumber.open(file_path) as pdf:
            total_pages = len(pdf.pages)
            for index, page in enumerate(pdf.pages):
                page_text = page.extract_text() or ""
                text_parts.append(page_text.strip())
                total_chars += len(page_text.strip())
                emit("stage", {
                    "stage": "extracting",
                    "current": index + 1,
                    "total": total_pages,
                })
    except Exception as e:
        logger.warning("pdfplumber failed for %s: %s", file_path, e)
        total_chars = 0

    if total_chars > 50:
        # Has text layer → pdfplumber
        logger.info("PDF has text layer (%d chars), using pdfplumber", total_chars)
        return "\n\n".join(p for p in text_parts if p)

    # Scanned PDF → Gemini OCR page by page
    logger.info("PDF appears scanned (%d chars), using Gemini OCR", total_chars)
    return _ocr_pdf(file_path, emit)


def _ocr_pdf(file_path: str, emit=_noop) -> str:
    """Convert PDF pages to images and run vision OCR on each."""
    import tempfile
    from app.features.quizz.ocr_service import extract_text_from_image
    from app.features.quizz.pdf_service import render_pdf_pages

    all_texts: list[str] = []

    with tempfile.TemporaryDirectory() as tmpdir:
        image_paths = render_pdf_pages(file_path, tmpdir)
        total = len(image_paths)
        emit("stage", {"stage": "ocr", "current": 0, "total": total})
        for i, img_path in enumerate(image_paths):
            text = extract_text_from_image(img_path)
            if text.strip():
                all_texts.append(text.strip())
            emit("stage", {"stage": "ocr", "current": i + 1, "total": total})

    return "\n\n".join(all_texts)
