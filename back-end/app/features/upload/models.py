"""
Upload feature - SQLAlchemy model for tracking uploaded files per folder.
"""
from datetime import datetime, timezone
from app.db import db
from app.features.quizz.question_patterns import QUESTION_BANK_THRESHOLD
from app.utils.times import iso_utc


class UploadedFileRecord(db.Model):
    """Tracks files uploaded for a folder. Files in 'files' mode are persisted on disk for reuse."""
    __tablename__ = "uploaded_files"

    id = db.Column(db.String(36), primary_key=True)
    folder_id = db.Column(
        db.String(36),
        db.ForeignKey("folders.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    original_name = db.Column(db.String(512), nullable=False)
    file_size = db.Column(db.Integer, default=0)          # bytes
    file_type = db.Column(db.String(64), default="")      # mime or extension
    input_mode = db.Column(db.String(16), default="files") # files | youtube | web | notion | gdrive | text
    source_label = db.Column(db.String(1024), default="")  # source URL, or a preview of the raw text
    stored_path = db.Column(db.String(1024), default="")   # on-disk path for reuse (files mode)
    quiz_set_id = db.Column(
        db.String(36),
        db.ForeignKey("quiz_sets.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    # RAG processing status
    processing_status = db.Column(db.String(16), default="pending")  # pending | processing | completed | failed
    processing_error = db.Column(db.Text, nullable=True)
    chunk_count = db.Column(db.Integer, default=0)
    # 0..1 heuristic that this material already contains quiz questions.
    question_bank_score = db.Column(db.Float, default=0.0)

    folder = db.relationship("Folder", backref=db.backref("uploaded_files", cascade="all, delete-orphan"))

    @property
    def has_stored_file(self):
        """Check if the stored file still exists on disk."""
        import os
        return bool(self.stored_path) and os.path.isfile(self.stored_path)

    def to_dict(self):
        return {
            "id": self.id,
            "folderId": self.folder_id,
            "originalName": self.original_name,
            "fileSize": self.file_size,
            "fileType": self.file_type,
            "inputMode": self.input_mode,
            "sourceLabel": self.source_label or "",
            "storedPath": bool(self.stored_path),
            "hasFile": self.has_stored_file,
            "quizSetId": self.quiz_set_id,
            "createdAt": (
                iso_utc(self.created_at)
                if self.created_at
                else None
            ),
            "processingStatus": self.processing_status or "pending",
            "processingError": self.processing_error,
            "chunkCount": self.chunk_count or 0,
            "questionBankScore": float(self.question_bank_score or 0.0),
            # Derived here so the threshold lives in one place instead of being
            # duplicated as a magic number in the UI.
            "isQuestionBank": float(self.question_bank_score or 0.0) >= QUESTION_BANK_THRESHOLD,
        }
