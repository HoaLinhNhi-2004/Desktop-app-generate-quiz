"""
Google Drive Service - Download picked files into UPLOAD_FOLDER.

Files arrive as real files on disk with a real extension, so a `gdrive` record
reuses the whole existing `files` pipeline unchanged — PDF text layer, OCR
fallback, heatmap bounding boxes and the PDF viewer all keep working.

Google-native documents have no byte stream of their own and must be exported;
Docs and Slides become PDF specifically so the PDF viewer stays usable.
"""
import logging
import os
import re
import uuid

import requests
from werkzeug.utils import secure_filename

from app.features.integrations import oauth

logger = logging.getLogger(__name__)

API_BASE = "https://www.googleapis.com/drive/v3"
HTTP_TIMEOUT = 60
CHUNK_SIZE = 256 * 1024

_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# Google-native type -> (export mime, extension)
EXPORT_FORMATS = {
    "application/vnd.google-apps.document": ("application/pdf", "pdf"),
    "application/vnd.google-apps.presentation": ("application/pdf", "pdf"),
    "application/vnd.google-apps.drawing": ("application/pdf", "pdf"),
    "application/vnd.google-apps.spreadsheet": (_XLSX_MIME, "xlsx"),
}

# Fallback when a binary file's name carries no extension.
MIME_EXTENSIONS = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/msword": "doc",
    _XLSX_MIME: "xlsx",
    "application/vnd.ms-excel": "xls",
    "text/csv": "csv",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
}

# Must stay a subset of what document_processor._extract_file() can handle.
SUPPORTED_EXTENSIONS = {
    "pdf", "doc", "docx", "png", "jpg", "jpeg", "webp", "bmp", "tiff",
    "xlsx", "xls", "csv",
}


class DriveError(Exception):
    """A per-file failure; the caller reports it and moves on to the next file."""


def _auth_headers() -> dict:
    return {"Authorization": f"Bearer {oauth.get_valid_access_token('google')}"}


def get_file_metadata(file_id: str) -> dict:
    response = requests.get(
        f"{API_BASE}/files/{file_id}",
        params={"fields": "id,name,mimeType,size,webViewLink"},
        headers=_auth_headers(),
        timeout=HTTP_TIMEOUT,
    )
    if not response.ok:
        logger.error("Drive metadata %s -> %s: %s", file_id, response.status_code, response.text[:300])
        raise DriveError(f"Không đọc được thông tin tệp từ Drive (HTTP {response.status_code})")
    return response.json()


def _target_extension(name: str, mime_type: str) -> str:
    if mime_type in EXPORT_FORMATS:
        return EXPORT_FORMATS[mime_type][1]
    if "." in name:
        ext = name.rsplit(".", 1)[-1].lower()
        if ext in SUPPORTED_EXTENSIONS:
            return ext
    return MIME_EXTENSIONS.get(mime_type, "")


def download_file(file_id: str, upload_folder: str, max_bytes: int) -> dict:
    """
    Download (or export) one Drive file into upload_folder.

    Returns {storedPath, originalName, fileType, fileSize, webViewLink}.
    Raises DriveError for anything the local pipeline could not process anyway.
    """
    meta = get_file_metadata(file_id)
    name = meta.get("name") or "Drive file"
    mime_type = meta.get("mimeType") or ""

    ext = _target_extension(name, mime_type)
    if ext not in SUPPORTED_EXTENSIONS:
        raise DriveError(f"Định dạng không được hỗ trợ: {mime_type or 'không rõ'}")

    if mime_type in EXPORT_FORMATS:
        export_mime = EXPORT_FORMATS[mime_type][0]
        url = f"{API_BASE}/files/{file_id}/export"
        params = {"mimeType": export_mime}
        # Exported bytes are generated on the fly, so metadata carries no size.
        declared_size = 0
    else:
        url = f"{API_BASE}/files/{file_id}"
        params = {"alt": "media"}
        declared_size = int(meta.get("size") or 0)

    if declared_size and declared_size > max_bytes:
        raise DriveError(f"Tệp vượt quá giới hạn {max_bytes // (1024 * 1024)} MB")

    base_name = secure_filename(re.sub(r"\.[^.]+$", "", name)) or "drive_file"
    stored_path = os.path.join(upload_folder, f"{uuid.uuid4().hex[:8]}_{base_name}.{ext}")

    response = requests.get(
        url, params=params, headers=_auth_headers(), stream=True, timeout=HTTP_TIMEOUT
    )
    if not response.ok:
        logger.error("Drive download %s -> %s: %s", file_id, response.status_code, response.text[:300])
        raise DriveError(f"Tải tệp từ Drive thất bại (HTTP {response.status_code})")

    written = 0
    try:
        with open(stored_path, "wb") as fh:
            for chunk in response.iter_content(CHUNK_SIZE):
                if not chunk:
                    continue
                written += len(chunk)
                if written > max_bytes:
                    raise DriveError(f"Tệp vượt quá giới hạn {max_bytes // (1024 * 1024)} MB")
                fh.write(chunk)
    except Exception:
        # A partial file would later fail extraction with a confusing message.
        if os.path.isfile(stored_path):
            try:
                os.remove(stored_path)
            except OSError:
                pass
        raise
    finally:
        response.close()

    display_name = name if name.lower().endswith(f".{ext}") else f"{name}.{ext}"
    logger.info("Downloaded Drive file %s (%d bytes) to %s", file_id, written, stored_path)

    return {
        "storedPath": stored_path,
        "originalName": display_name[:512],
        "fileType": ext,
        "fileSize": written,
        "webViewLink": meta.get("webViewLink") or f"https://drive.google.com/file/d/{file_id}/view",
    }
