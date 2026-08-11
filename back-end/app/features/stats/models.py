"""
Stats feature - SQLAlchemy model for tracking quiz attempts.
"""
import json
from datetime import datetime, timezone
from app.db import db
from app.utils.times import iso_utc


class QuizAttempt(db.Model):
    """Records a single quiz attempt (user completing/submitting a quiz)."""
    __tablename__ = "quiz_attempts"

    id = db.Column(db.String(36), primary_key=True)
    quiz_set_id = db.Column(
        db.String(36),
        db.ForeignKey("quiz_sets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    folder_id = db.Column(
        db.String(36),
        db.ForeignKey("folders.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    score = db.Column(db.Float, nullable=False, default=0.0)         # percentage 0-100
    correct_count = db.Column(db.Integer, nullable=False, default=0)
    wrong_count = db.Column(db.Integer, nullable=False, default=0)
    skipped_count = db.Column(db.Integer, nullable=False, default=0)
    total_questions = db.Column(db.Integer, nullable=False, default=0)
    time_taken = db.Column(db.Integer, nullable=False, default=0)     # seconds
    answers_detail = db.Column(db.Text, default="[]")                 # JSON list of per-question results
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    quiz_set = db.relationship("QuizSet", backref=db.backref("attempts", cascade="all, delete-orphan"))
    folder = db.relationship("Folder", backref=db.backref("attempts", cascade="all, delete-orphan"))

    def get_answers_detail(self):
        try:
            return json.loads(self.answers_detail) if self.answers_detail else []
        except (json.JSONDecodeError, TypeError):
            return []

    def set_answers_detail(self, value):
        self.answers_detail = json.dumps(value) if value is not None else "[]"

    def to_dict(self):
        return {
            "id": self.id,
            "quizSetId": self.quiz_set_id,
            "folderId": self.folder_id,
            "score": self.score,
            "correctCount": self.correct_count,
            "wrongCount": self.wrong_count,
            "skippedCount": self.skipped_count,
            "totalQuestions": self.total_questions,
            "timeTaken": self.time_taken,
            "createdAt": (
                iso_utc(self.created_at)
                if self.created_at
                else None
            ),
        }
