import os
from flask import Flask
from flask_cors import CORS
from config import get_config
from app.db import db


def _add_missing_columns(app):
    """Add columns that create_all() won't add to existing tables."""
    import sqlite3
    db_uri = app.config.get("SQLALCHEMY_DATABASE_URI", "")
    if not db_uri.startswith("sqlite:///"):
        return
    db_path = db_uri.replace("sqlite:///", "")
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(gemini_api_keys)")
        existing = {row[1] for row in cursor.fetchall()}
        if "model_usage" not in existing:
            cursor.execute("ALTER TABLE gemini_api_keys ADD COLUMN model_usage TEXT DEFAULT '{}'")
            conn.commit()
            app.logger.info("Added model_usage column to gemini_api_keys")

        cursor.execute("PRAGMA table_info(folders)")
        folder_cols = {row[1] for row in cursor.fetchall()}
        if "is_favorite" not in folder_cols:
            cursor.execute("ALTER TABLE folders ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0")
            conn.commit()
            app.logger.info("Added is_favorite column to folders")
        if "last_accessed_at" not in folder_cols:
            cursor.execute("ALTER TABLE folders ADD COLUMN last_accessed_at DATETIME")
            conn.commit()
            app.logger.info("Added last_accessed_at column to folders")

        cursor.execute("PRAGMA table_info(quiz_sets)")
        quiz_set_cols = {row[1] for row in cursor.fetchall()}
        if "page_distribution" not in quiz_set_cols:
            cursor.execute("ALTER TABLE quiz_sets ADD COLUMN page_distribution TEXT")
            conn.commit()
            app.logger.info("Added page_distribution column to quiz_sets")
        if "source_upload_ids" not in quiz_set_cols:
            cursor.execute("ALTER TABLE quiz_sets ADD COLUMN source_upload_ids TEXT")
            conn.commit()
            app.logger.info("Added source_upload_ids column to quiz_sets")

        cursor.execute("PRAGMA table_info(questions)")
        question_cols = {row[1] for row in cursor.fetchall()}
        if "source_pages" not in question_cols:
            cursor.execute("ALTER TABLE questions ADD COLUMN source_pages TEXT")
            conn.commit()
            app.logger.info("Added source_pages column to questions")
        if "source_keyword" not in question_cols:
            cursor.execute("ALTER TABLE questions ADD COLUMN source_keyword TEXT")
            conn.commit()
            app.logger.info("Added source_keyword column to questions")
        if "correct_answer_ids" not in question_cols:
            cursor.execute("ALTER TABLE questions ADD COLUMN correct_answer_ids TEXT")
            conn.commit()
            app.logger.info("Added correct_answer_ids column to questions")

        # uploaded_files: RAG processing columns
        cursor.execute("PRAGMA table_info(uploaded_files)")
        upload_cols = {row[1] for row in cursor.fetchall()}
        for col, sql in [
            ("processing_status", "ALTER TABLE uploaded_files ADD COLUMN processing_status VARCHAR(16) DEFAULT 'pending'"),
            ("processing_error", "ALTER TABLE uploaded_files ADD COLUMN processing_error TEXT"),
            ("chunk_count", "ALTER TABLE uploaded_files ADD COLUMN chunk_count INTEGER DEFAULT 0"),
        ]:
            if col not in upload_cols:
                cursor.execute(sql)
                conn.commit()
                app.logger.info("Added %s column to uploaded_files", col)

        conn.close()
    except Exception as e:
        app.logger.warning("Column migration check failed: %s", e)


def _migrate_folders_json_if_needed(app):
    """If Folder table is empty and app/data/folders.json exists, import it into SQLite."""
    import json
    from app.features.folder.models import Folder
    if Folder.query.first() is not None:
        return
    data_dir = os.path.join(os.path.dirname(__file__), "data")
    folders_file = os.path.join(data_dir, "folders.json")
    if not os.path.isfile(folders_file):
        return
    try:
        with open(folders_file, "r", encoding="utf-8") as f:
            folders = json.load(f)
        if not isinstance(folders, list):
            return
        for item in folders:
            folder = Folder(
                id=item.get("id") or __import__("uuid").uuid4(),
                name=item.get("name", ""),
                description=item.get("description", ""),
                color=item.get("color", "hsl(262 83% 58%)"),
            )
            if item.get("createdAt"):
                try:
                    s = item["createdAt"].replace("Z", "+00:00")
                    folder.created_at = __import__("datetime").datetime.fromisoformat(s)
                except Exception:
                    pass
            db.session.add(folder)
        db.session.commit()
        app.logger.info(f"Migrated {len(folders)} folders from folders.json to SQLite")
    except Exception as e:
        app.logger.warning(f"Could not migrate folders.json: {e}")
        db.session.rollback()


def create_app(config_class=None):
    """Flask application factory"""
    app = Flask(__name__)

    # Load config
    if config_class is None:
        config_class = get_config()
    app.config.from_object(config_class)

    # Ensure upload folder and DB directory exist
    os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
    db_uri = app.config.get("SQLALCHEMY_DATABASE_URI", "")
    if db_uri.startswith("sqlite:///"):
        db_path = db_uri.replace("sqlite:///", "")
        db_dir = os.path.dirname(db_path)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)

    # Init SQLAlchemy (import models so tables are registered)
    db.init_app(app)
    with app.app_context():
        from app.features.folder.models import Folder  # noqa: F401
        from app.features.quizz.models import QuizSet, Question  # noqa: F401
        from app.features.upload.models import UploadedFileRecord  # noqa: F401
        from app.features.stats.models import QuizAttempt  # noqa: F401
        from app.features.api_keys.models import GeminiApiKey  # noqa: F401
        db.create_all()
        _add_missing_columns(app)
        _migrate_folders_json_if_needed(app)

    # Enable CORS
    CORS(app, origins=app.config.get("CORS_ORIGINS", ["*"]))

    # Register blueprints
    from app.features.quizz.routes import quiz_bp
    app.register_blueprint(quiz_bp, url_prefix="/api/quiz")

    from app.features.folder.routes import folder_bp
    app.register_blueprint(folder_bp, url_prefix="/api/folders")

    from app.features.upload.routes import upload_bp
    app.register_blueprint(upload_bp, url_prefix="/api/uploads")

    from app.features.stats.routes import stats_bp
    app.register_blueprint(stats_bp, url_prefix="/api/stats")

    from app.features.api_keys.routes import api_keys_bp
    app.register_blueprint(api_keys_bp, url_prefix="/api/keys")

    from app.features.folder.smart_import_routes import smart_import_bp
    app.register_blueprint(smart_import_bp, url_prefix="/api/folders")

    # Health check route
    @app.route("/api/health")
    def health():
        return {"status": "ok", "message": "Quiz API is running"}

    return app
