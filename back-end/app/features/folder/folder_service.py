import os
import uuid
import logging
from datetime import datetime, timezone
from typing import List, Dict, Optional

from app.db import db
from app.features.folder.models import Folder

logger = logging.getLogger(__name__)


def get_all_folders() -> List[Dict]:
    """Retrieve all folders from SQLite."""
    folders = Folder.query.order_by(Folder.created_at).all()
    return [f.to_dict() for f in folders]


def create_folder(name: str, description: str = "", color: str = "") -> Dict:
    """Create a new folder in SQLite."""
    folder = Folder(
        id=str(uuid.uuid4()),
        name=name.strip(),
        description=description.strip() if description else "",
        color=color if color else "hsl(262 83% 58%)",
    )
    db.session.add(folder)
    db.session.commit()
    return folder.to_dict()


def update_folder(folder_id: str, data: Dict) -> Optional[Dict]:
    """Update an existing folder."""
    folder = Folder.query.get(folder_id)
    if not folder:
        return None
    if "name" in data:
        folder.name = data["name"].strip()
    if "description" in data:
        folder.description = data["description"].strip()
    if "color" in data:
        folder.color = data["color"]
    db.session.commit()
    return folder.to_dict()


def delete_folder(folder_id: str) -> bool:
    """Delete a folder, its materials on disk, and its vector chunks.

    The ORM cascades to quiz_sets, questions, uploaded_files and attempts, so the
    rows holding `stored_path` disappear with the folder. Anything not cleaned up
    *before* the delete is therefore unreachable forever: the files stayed in
    UPLOAD_FOLDER and the embeddings stayed in ChromaDB with nothing left to
    point at them. Deleting one material at a time always did both (see
    upload/routes.py:delete_upload); this path did neither.
    """
    folder = Folder.query.get(folder_id)
    if not folder:
        return False

    records = list(folder.uploaded_files or [])

    # Vector chunks first — one bulk delete on the folder_id metadata rather than
    # one call per record.
    try:
        from app.features.upload.vector_store import delete_folder_chunks
        delete_folder_chunks(folder_id)
    except Exception as e:
        logger.warning("Could not delete vector chunks for folder %s: %s", folder_id, e)

    for record in records:
        if not record.stored_path:
            continue
        try:
            if os.path.isfile(record.stored_path):
                os.remove(record.stored_path)
        except OSError as e:
            logger.warning("Could not delete stored file %s: %s", record.stored_path, e)

    db.session.delete(folder)
    db.session.commit()
    logger.info("Deleted folder %s along with %d material(s)", folder_id, len(records))
    return True


def toggle_favorite(folder_id: str) -> Optional[Dict]:
    """Toggle the is_favorite flag on a folder."""
    folder = Folder.query.get(folder_id)
    if not folder:
        return None
    folder.is_favorite = not folder.is_favorite
    db.session.commit()
    return folder.to_dict()


def record_access(folder_id: str) -> Optional[Dict]:
    """Update last_accessed_at to now."""
    folder = Folder.query.get(folder_id)
    if not folder:
        return None
    folder.last_accessed_at = datetime.now(timezone.utc)
    db.session.commit()
    return folder.to_dict()
