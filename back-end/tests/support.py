"""Shared fixtures for the backend tests.

`temp_app()` builds a real application through `create_app()` against a throwaway
SQLite file rather than stubbing the DB. That costs a few milliseconds per test
and buys coverage of the startup path itself: the migration runner, the API-key
encryption backfill and the per-connection `foreign_keys` pragma all run here,
and all three have been the source of user-visible bugs.
"""
import os
import shutil
import tempfile


class _TestConfig:
    """Mirrors the fields `create_app()` reads out of `config.Config`."""

    TESTING = True
    SECRET_KEY = "test-secret-key"
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    MAX_CONTENT_LENGTH = 50 * 1024 * 1024
    CORS_ORIGINS = ["http://localhost:5123"]


def temp_app():
    """Return `(app, cleanup)`. Call `cleanup()` when the test is done."""
    from app import create_app

    tmp_dir = tempfile.mkdtemp(prefix="quizgen-test-")

    class Config(_TestConfig):
        SQLALCHEMY_DATABASE_URI = "sqlite:///" + os.path.join(
            tmp_dir, "instance", "test.db"
        ).replace("\\", "/")
        UPLOAD_FOLDER = os.path.join(tmp_dir, "uploads")
        CHROMADB_PATH = os.path.join(tmp_dir, "instance", "chromadb")

    app = create_app(Config)

    def cleanup():
        from app.db import db

        with app.app_context():
            db.session.remove()
            db.engine.dispose()
        shutil.rmtree(tmp_dir, ignore_errors=True)

    return app, cleanup


class AppTestCase:
    """Mixin giving each test a fresh app, context and empty database.

    Combine with `unittest.TestCase`; it only supplies `setUp`/`tearDown`.
    """

    def setUp(self):
        self.app, self._cleanup = temp_app()
        self.ctx = self.app.app_context()
        self.ctx.push()

    def tearDown(self):
        self.ctx.pop()
        self._cleanup()
