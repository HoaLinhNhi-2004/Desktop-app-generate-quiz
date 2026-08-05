import os
from flask import Flask, jsonify, request
from flask_cors import CORS
from config import get_config
from app.db import db
from app.migrations import run_migrations


def _encrypt_existing_api_keys(app):
    """Encrypt any plaintext API keys left over from before at-rest encryption,
    and backfill key_hash for rows that lack it.
    """
    from app.features.api_keys.crypto import encrypt, is_encrypted
    from app.features.api_keys.models import GeminiApiKey, hash_key

    try:
        rows = GeminiApiKey.query.all()
    except Exception as e:
        app.logger.warning("Could not load API keys for encryption migration: %s", e)
        return

    changed = 0
    for row in rows:
        try:
            if not row._key:
                continue
            if not is_encrypted(row._key):
                plaintext = row._key
                row._key = encrypt(plaintext)
                row.key_hash = hash_key(plaintext)
                changed += 1
            elif not row.key_hash:
                plaintext = row.key  # via property → decrypt
                if plaintext:
                    row.key_hash = hash_key(plaintext)
                    changed += 1
        except Exception as e:
            app.logger.warning("Skipping API key migration for id=%s: %s", row.id, e)

    if changed:
        try:
            db.session.commit()
            app.logger.info("Encrypted/backfilled %d API key row(s)", changed)
        except Exception as e:
            app.logger.warning("API key encryption commit failed: %s", e)
            db.session.rollback()


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
        from app.features.api_keys.models import GeminiApiKey, GeminiApiKeyDailyUsage  # noqa: F401
        from app.features.integrations.models import (  # noqa: F401
            IntegrationConnection,
            IntegrationCredential,
        )
        db.create_all()
        run_migrations(app.config.get("SQLALCHEMY_DATABASE_URI", ""), app.logger)
        _encrypt_existing_api_keys(app)
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

    from app.features.integrations.routes import integrations_bp
    app.register_blueprint(integrations_bp, url_prefix="/api/integrations")

    _register_api_error_handlers(app)

    # Health check route
    @app.route("/api/health")
    def health():
        return {"status": "ok", "message": "Quiz API is running"}

    return app


def _register_api_error_handlers(app):
    """Make every /api/ failure a JSON body carrying a real message.

    Flask's default error pages are HTML, so a 415 (missing Content-Type), a 400
    (empty body) or an unhandled 500 all reached the client as markup. The
    frontend's `res.json()` then threw and every one of them collapsed into the
    same generic "Failed to ..." string, hiding what actually went wrong.
    """
    from werkzeug.exceptions import HTTPException

    def _wants_json() -> bool:
        return request.path.startswith("/api/")

    @app.errorhandler(HTTPException)
    def _handle_http_exception(e: HTTPException):
        if not _wants_json():
            return e
        return jsonify({
            "error": e.description or e.name,
            "code": f"http_{e.code}",
        }), e.code or 500

    @app.errorhandler(Exception)
    def _handle_unexpected(e: Exception):
        if not _wants_json():
            raise e
        app.logger.exception("Unhandled error on %s %s", request.method, request.path)
        return jsonify({
            "error": f"{type(e).__name__}: {e}"[:500],
            "code": "internal_error",
        }), 500
