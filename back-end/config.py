import os
import secrets
from dotenv import load_dotenv

load_dotenv()


def _resolve_secret_key() -> str:
    """SECRET_KEY policy:
      - Production (FLASK_ENV=production): must be set via env, otherwise raise.
      - Development: prefer env, fall back to a per-process random key.
    """
    env_key = os.getenv("SECRET_KEY", "").strip()
    if env_key:
        return env_key
    if os.getenv("FLASK_ENV", "development").lower() == "production":
        raise RuntimeError(
            "SECRET_KEY must be set via environment when FLASK_ENV=production"
        )
    return secrets.token_hex(32)


class Config:
    """Base configuration"""
    SECRET_KEY = _resolve_secret_key()

    # When set (e.g. by Electron desktop app), DB and uploads use this base path
    _user_data_path = os.getenv("USER_DATA_PATH", "").strip()
    _base_dir = os.path.dirname(os.path.abspath(__file__))
    _data_dir = _user_data_path if _user_data_path else _base_dir

    # SQLite database (relative to project root or USER_DATA_PATH when desktop)
    SQLALCHEMY_DATABASE_URI = os.getenv(
        "DATABASE_URL",
        f"sqlite:///{os.path.join(_data_dir, 'instance', 'web_quizz.db')}"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False

    # Upload settings
    UPLOAD_FOLDER = os.path.join(_data_dir, "uploads")
    MAX_CONTENT_LENGTH = 50 * 1024 * 1024  # 50MB max upload

    # ChromaDB vector store
    CHROMADB_PATH = os.path.join(_data_dir, "instance", "chromadb")

    # Allowed file extensions
    ALLOWED_EXTENSIONS = {"pdf", "png", "jpg", "jpeg", "bmp", "webp", "tiff", "docx", "doc"}

    # Gemini model fallback chain — tried in order on 429 quota errors.
    # API keys are managed via the UI (Settings > API Keys), stored in the DB.
    GEMINI_FALLBACK_CHAIN = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"]

    # CORS (when USER_DATA_PATH is set, allow file:// / null for Electron loadFile)
    _cors_default = "http://localhost:5123,http://localhost:5173,http://localhost:3000,http://localhost:4173"
    _cors_env = os.getenv("CORS_ORIGINS", _cors_default)
    CORS_ORIGINS = _cors_env.split(",") if _cors_env else _cors_default.split(",")
    if _user_data_path:
        CORS_ORIGINS = list(CORS_ORIGINS) + ["null", "file://"]


class DevelopmentConfig(Config):
    DEBUG = True


class ProductionConfig(Config):
    DEBUG = False


config_map = {
    "development": DevelopmentConfig,
    "production": ProductionConfig,
}


def get_config():
    env = os.getenv("FLASK_ENV", "development")
    return config_map.get(env, DevelopmentConfig)
