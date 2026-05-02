"""
At-rest encryption for sensitive secrets (Gemini API keys).

Uses AES-256-GCM with a master key derived via PBKDF2-HMAC-SHA256 from:
  - USER_DATA_PATH (or the resolved instance dir) — binds to the install location
  - A per-install random salt stored in `instance/.crypto_salt`

A DB dump alone (without the salt file) cannot be decrypted on another machine.
This is at-rest defense; it does not protect against an attacker with full local
filesystem access. For that, an OS keychain (DPAPI/Keychain) would be required.
"""
import base64
import logging
import os
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from flask import current_app, has_app_context

logger = logging.getLogger(__name__)

ENC_PREFIX = "enc.v1:"
SALT_FILE = ".crypto_salt"
PBKDF2_ITERATIONS = 200_000
KEY_SIZE = 32  # AES-256
NONCE_SIZE = 12  # GCM standard
SALT_SIZE = 16

_cipher_cache: AESGCM | None = None


def _resolve_instance_dir() -> Path:
    if has_app_context():
        db_uri = current_app.config.get("SQLALCHEMY_DATABASE_URI", "")
        if db_uri.startswith("sqlite:///"):
            return Path(db_uri.replace("sqlite:///", "")).parent
    user_data = os.getenv("USER_DATA_PATH", "").strip()
    if user_data:
        return Path(user_data) / "instance"
    base = Path(__file__).resolve().parents[3]
    return base / "instance"


def _load_or_create_salt(instance_dir: Path) -> bytes:
    salt_path = instance_dir / SALT_FILE
    if salt_path.is_file():
        try:
            data = salt_path.read_bytes()
            if len(data) == SALT_SIZE:
                return data
            logger.warning("Crypto salt file has wrong size; regenerating")
        except OSError as e:
            logger.warning("Could not read crypto salt (%s); regenerating", e)
    salt = os.urandom(SALT_SIZE)
    instance_dir.mkdir(parents=True, exist_ok=True)
    salt_path.write_bytes(salt)
    try:
        os.chmod(salt_path, 0o600)
    except OSError:
        pass
    return salt


def _derive_master_key(instance_dir: Path) -> bytes:
    salt = _load_or_create_salt(instance_dir)
    user_data = os.getenv("USER_DATA_PATH", "").strip() or str(instance_dir)
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=KEY_SIZE,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    return kdf.derive(user_data.encode("utf-8"))


def _get_cipher() -> AESGCM:
    global _cipher_cache
    if _cipher_cache is None:
        _cipher_cache = AESGCM(_derive_master_key(_resolve_instance_dir()))
    return _cipher_cache


def is_encrypted(value: str | None) -> bool:
    return isinstance(value, str) and value.startswith(ENC_PREFIX)


def encrypt(plaintext: str) -> str:
    if not plaintext:
        return ""
    nonce = os.urandom(NONCE_SIZE)
    ct = _get_cipher().encrypt(nonce, plaintext.encode("utf-8"), None)
    return ENC_PREFIX + base64.urlsafe_b64encode(nonce + ct).decode("ascii")


def decrypt(ciphertext: str | None) -> str:
    if not ciphertext:
        return ""
    if not is_encrypted(ciphertext):
        return ciphertext
    blob = base64.urlsafe_b64decode(ciphertext[len(ENC_PREFIX):])
    nonce, ct = blob[:NONCE_SIZE], blob[NONCE_SIZE:]
    return _get_cipher().decrypt(nonce, ct, None).decode("utf-8")
