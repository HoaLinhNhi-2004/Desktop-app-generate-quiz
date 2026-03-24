"""
Folder feature - SQLAlchemy models.
"""
from datetime import datetime, timezone
from app.db import db


class Folder(db.Model):
    """Folder (category) for organizing quiz sets."""
    __tablename__ = "folders"

    id = db.Column(db.String(36), primary_key=True)
    name = db.Column(db.String(255), nullable=False, index=True)
    description = db.Column(db.Text, default="")
    color = db.Column(db.String(64), default="hsl(262 83% 58%)")
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    is_favorite = db.Column(db.Boolean, default=False, nullable=False)
    last_accessed_at = db.Column(db.DateTime, nullable=True)

    quiz_sets = db.relationship("QuizSet", back_populates="folder", cascade="all, delete-orphan")

    def to_dict(self):
        quiz_count = len(self.quiz_sets) if self.quiz_sets else 0
        processing_count = 0
        if self.uploaded_files:
            processing_count = sum(
                1 for f in self.uploaded_files
                if f.processing_status in ("pending", "processing")
            )
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description or "",
            "color": self.color or "hsl(262 83% 58%)",
            "createdAt": self.created_at.isoformat().replace("+00:00", "Z") if self.created_at else None,
            "quizCount": quiz_count,
            "isFavorite": bool(self.is_favorite),
            "lastAccessedAt": self.last_accessed_at.isoformat().replace("+00:00", "Z") if self.last_accessed_at else None,
            "processingCount": processing_count,
        }

