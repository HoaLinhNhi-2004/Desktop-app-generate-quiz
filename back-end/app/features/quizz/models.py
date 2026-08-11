"""
Quizz feature - SQLAlchemy models (QuizSet, Question).
"""
import json
from datetime import datetime, timezone
from app.db import db
from app.utils.times import iso_utc


class QuizSet(db.Model):
    """A generated quiz set (one generation = one QuizSet)."""
    __tablename__ = "quiz_sets"

    id = db.Column(db.String(36), primary_key=True)
    folder_id = db.Column(db.String(36), db.ForeignKey("folders.id", ondelete="SET NULL"), nullable=True)
    title = db.Column(db.String(255), nullable=True)
    config = db.Column(db.Text, nullable=True)  # JSON: numberOfQuestions, questionType, difficulty, language, timePerQuestion
    page_distribution = db.Column(db.Text, nullable=True)  # JSON: {distribution: {"1":3,...}, totalPages: N}
    source_upload_ids = db.Column(db.Text, nullable=True)  # JSON array of upload record IDs used
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    folder = db.relationship("Folder", back_populates="quiz_sets")
    questions = db.relationship("Question", back_populates="quiz_set", order_by="Question.question_number", cascade="all, delete-orphan")

    def get_config(self):
        if not self.config:
            return {}
        try:
            return json.loads(self.config)
        except (json.JSONDecodeError, TypeError):
            return {}

    def set_config(self, value):
        self.config = json.dumps(value) if value is not None else None

    def get_page_distribution(self):
        try:
            return json.loads(self.page_distribution) if self.page_distribution else None
        except (json.JSONDecodeError, TypeError):
            return None

    def set_page_distribution(self, value):
        self.page_distribution = json.dumps(value) if value is not None else None

    def get_source_upload_ids(self) -> list:
        try:
            return json.loads(self.source_upload_ids) if self.source_upload_ids else []
        except (json.JSONDecodeError, TypeError):
            return []

    def set_source_upload_ids(self, value: list):
        self.source_upload_ids = json.dumps(value) if value else None

    def to_dict(self, include_questions=True):
        data = {
            "id": self.id,
            "folderId": self.folder_id,
            "title": self.title or "",
            "config": self.get_config(),
            "createdAt": iso_utc(self.created_at),
            "pageDistribution": self.get_page_distribution(),
            "sourceUploadIds": self.get_source_upload_ids(),
        }
        if include_questions:
            data["questions"] = [q.to_dict() for q in self.questions]
        else:
            data["questionCount"] = len(self.questions)
        return data


class Question(db.Model):
    """A single question in a quiz set."""
    __tablename__ = "questions"

    id = db.Column(db.String(64), primary_key=True)
    quiz_set_id = db.Column(db.String(36), db.ForeignKey("quiz_sets.id", ondelete="CASCADE"), nullable=False)
    question_number = db.Column(db.Integer, nullable=False)
    type = db.Column(db.String(32), nullable=False)  # multiple-choice, multiple-answer, true-false, fill-blank
    question_text = db.Column(db.Text, nullable=False)
    options = db.Column(db.Text, nullable=False)  # JSON list of {id, text}
    correct_answer_id = db.Column(db.String(16), nullable=False)  # single correct answer id (or first for multiple-answer)
    correct_answer_ids = db.Column(db.Text, nullable=True)  # JSON array of correct ids for multiple-answer type
    explanation = db.Column(db.Text, default="")
    source_pages = db.Column(db.Text, nullable=True)  # JSON: [1, 2, 3]
    source_keyword = db.Column(db.Text, nullable=True)  # JSON array of verbatim phrases from source text
    origin = db.Column(db.String(16), default="generated")  # extracted (copied from the document) | generated

    quiz_set = db.relationship("QuizSet", back_populates="questions")

    def get_options(self):
        try:
            return json.loads(self.options) if self.options else []
        except (json.JSONDecodeError, TypeError):
            return []

    def set_options(self, value):
        self.options = json.dumps(value) if value is not None else "[]"

    def get_source_pages(self) -> list:
        try:
            return json.loads(self.source_pages) if self.source_pages else []
        except (json.JSONDecodeError, TypeError):
            return []

    def set_source_pages(self, value):
        self.source_pages = json.dumps(value) if value else None

    def get_source_keyword(self) -> list:
        if not self.source_keyword:
            return []
        try:
            val = json.loads(self.source_keyword)
            if isinstance(val, list):
                return val
            return [val] if val else []
        except (json.JSONDecodeError, TypeError):
            return [self.source_keyword] if self.source_keyword else []

    def set_source_keyword(self, value: list):
        self.source_keyword = json.dumps(value) if value else None

    def get_correct_answer_ids(self) -> list:
        if not self.correct_answer_ids:
            return []
        try:
            val = json.loads(self.correct_answer_ids)
            return val if isinstance(val, list) else []
        except (json.JSONDecodeError, TypeError):
            return []

    def set_correct_answer_ids(self, value: list):
        self.correct_answer_ids = json.dumps(value) if value else None

    def to_dict(self):
        d = {
            "id": self.id,
            "questionNumber": self.question_number,
            "type": self.type,
            "questionText": self.question_text,
            "options": self.get_options(),
            "correctAnswerId": self.correct_answer_id,
            "explanation": self.explanation or "",
            "sourcePages": self.get_source_pages(),
            "sourceKeyword": self.get_source_keyword(),
            "origin": self.origin or "generated",
        }
        if self.type == "multiple-answer":
            d["correctAnswerIds"] = self.get_correct_answer_ids()
        return d
