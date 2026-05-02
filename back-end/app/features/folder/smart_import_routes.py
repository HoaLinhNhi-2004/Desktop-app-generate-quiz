"""
Smart Folder Import — API routes for scanning, importing, and tracking progress.

Endpoints:
  POST   /api/folders/smart-import            - Start a smart import job
  GET    /api/folders/smart-import/<id>        - Get job progress (polling)
  POST   /api/folders/smart-import/scan        - Preview scan (list files without importing)
  POST   /api/folders/smart-import/<id>/pause  - Pause a running job
  POST   /api/folders/smart-import/<id>/resume - Resume a paused job
  POST   /api/folders/smart-import/<id>/cancel - Cancel a running job
"""

import os
from flask import Blueprint, request, jsonify, current_app

from app.features.folder.smart_import_service import (
    scan_directory,
    start_import_job,
    get_job,
    pause_job,
    resume_job,
    cancel_job,
)
from app.utils.errors import internal_error

smart_import_bp = Blueprint("smart_import", __name__)


@smart_import_bp.route("/smart-import/scan", methods=["POST"])
def scan_folder():
    """Preview-scan a directory and return file list (no import yet)."""
    data = request.json
    if not data or not data.get("dirPath"):
        return jsonify({"error": "dirPath is required"}), 400

    dir_path = data["dirPath"].strip()

    # Validate path
    dir_path = os.path.normpath(os.path.abspath(dir_path))
    if not os.path.isdir(dir_path):
        return jsonify({"error": f"Directory not found: {dir_path}"}), 404

    try:
        files = scan_directory(dir_path)
        return jsonify({
            "dirPath": dir_path,
            "totalFiles": len(files),
            "files": [
                {
                    "name": f["name"],
                    "ext": f["ext"],
                    "size": f["size"],
                    "relDir": f["rel_dir"],
                }
                for f in files
            ],
        }), 200
    except Exception as e:
        return internal_error(e, log_label="smart_import.scan")


@smart_import_bp.route("/smart-import", methods=["POST"])
def start_import():
    """Start a smart folder import job (runs in background)."""
    data = request.json
    if not data or not data.get("dirPath"):
        return jsonify({"error": "dirPath is required"}), 400

    dir_path = data["dirPath"].strip()

    # Validate path
    dir_path = os.path.normpath(os.path.abspath(dir_path))
    if not os.path.isdir(dir_path):
        return jsonify({"error": f"Directory not found: {dir_path}"}), 404

    try:
        app = current_app._get_current_object()
        job_id = start_import_job(dir_path, app)
        return jsonify({"jobId": job_id}), 202
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return internal_error(e, log_label="smart_import.start")


@smart_import_bp.route("/smart-import/<job_id>", methods=["GET"])
def get_import_progress(job_id):
    """Get progress of a smart import job."""
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    return jsonify(job), 200


@smart_import_bp.route("/smart-import/<job_id>/pause", methods=["POST"])
def pause_import(job_id):
    """Pause a running import job."""
    success = pause_job(job_id)
    if not success:
        return jsonify({"error": "Job not found or already finished"}), 404
    return jsonify({"status": "paused"}), 200


@smart_import_bp.route("/smart-import/<job_id>/resume", methods=["POST"])
def resume_import(job_id):
    """Resume a paused import job."""
    success = resume_job(job_id)
    if not success:
        return jsonify({"error": "Job not found"}), 404
    return jsonify({"status": "resumed"}), 200


@smart_import_bp.route("/smart-import/<job_id>/cancel", methods=["POST"])
def cancel_import(job_id):
    """Cancel a running import job."""
    success = cancel_job(job_id)
    if not success:
        return jsonify({"error": "Job not found"}), 404
    return jsonify({"status": "cancelled"}), 200
