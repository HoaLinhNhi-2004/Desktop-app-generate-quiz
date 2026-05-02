from flask import Blueprint, request, jsonify
from app.features.folder.folder_service import (
    get_all_folders,
    create_folder,
    update_folder,
    delete_folder,
    toggle_favorite,
    record_access,
)
from app.utils.errors import internal_error

folder_bp = Blueprint("folder", __name__)


@folder_bp.route("/", methods=["GET"])
def get_folders():
    """Get all folders."""
    try:
        folders = get_all_folders()
        return jsonify(folders), 200
    except Exception as e:
        return internal_error(e, log_label="get_folders")


@folder_bp.route("/", methods=["POST"])
def add_folder():
    """Create a new folder."""
    data = request.json
    if not data or not data.get("name"):
        return jsonify({"error": "Folder name is required"}), 400
    try:
        folder = create_folder(
            data.get("name"),
            data.get("description", ""),
            data.get("color", ""),
        )
        return jsonify(folder), 201
    except Exception as e:
        return internal_error(e, log_label="add_folder")


@folder_bp.route("/<folder_id>", methods=["PUT"])
def edit_folder(folder_id):
    """Update an existing folder."""
    data = request.json
    if not data:
        return jsonify({"error": "No update data provided"}), 400
    try:
        updated_folder = update_folder(folder_id, data)
        if not updated_folder:
            return jsonify({"error": "Folder not found"}), 404
        return jsonify(updated_folder), 200
    except Exception as e:
        return internal_error(e, log_label="edit_folder")


@folder_bp.route("/<folder_id>", methods=["DELETE"])
def remove_folder(folder_id):
    """Delete a folder."""
    try:
        success = delete_folder(folder_id)
        if not success:
            return jsonify({"error": "Folder not found"}), 404
        return jsonify({"message": "Folder deleted successfully"}), 200
    except Exception as e:
        return internal_error(e, log_label="remove_folder")


@folder_bp.route("/<folder_id>/favorite", methods=["PATCH"])
def patch_favorite(folder_id):
    """Toggle favorite status of a folder."""
    try:
        folder = toggle_favorite(folder_id)
        if not folder:
            return jsonify({"error": "Folder not found"}), 404
        return jsonify(folder), 200
    except Exception as e:
        return internal_error(e, log_label="patch_favorite")


@folder_bp.route("/<folder_id>/access", methods=["POST"])
def post_access(folder_id):
    """Record that a folder was accessed."""
    try:
        folder = record_access(folder_id)
        if not folder:
            return jsonify({"error": "Folder not found"}), 404
        return jsonify(folder), 200
    except Exception as e:
        return internal_error(e, log_label="post_access")
