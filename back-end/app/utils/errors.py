"""
Helpers for returning sanitized error responses.

Goal: never echo `str(exc)` from a generic `except Exception` back to the
client — ORM/Python error messages can leak schema, file paths, or internals.
Use `internal_error()` for unexpected failures (logged server-side, generic
message + correlation ID returned). Use `client_error()` for validation /
intentional 4xx messages that are safe to show.
"""
import logging
import uuid
from typing import Tuple

from flask import Response, jsonify

logger = logging.getLogger(__name__)


def internal_error(
    exc: BaseException,
    *,
    message: str = "Internal server error",
    status: int = 500,
    log_label: str = "request",
) -> Tuple[Response, int]:
    """Log full exception with traceback, return generic JSON to the client.

    The correlation ID makes it possible to grep server logs for a specific
    failure reported by a user without exposing the underlying cause.
    """
    correlation_id = uuid.uuid4().hex[:12]
    logger.error("%s failed [eid=%s]: %s", log_label, correlation_id, exc, exc_info=True)
    return jsonify({"error": message, "errorId": correlation_id}), status


def client_error(message: str, status: int = 400) -> Tuple[Response, int]:
    """Return a 4xx with a caller-controlled, user-safe message."""
    return jsonify({"error": message}), status
