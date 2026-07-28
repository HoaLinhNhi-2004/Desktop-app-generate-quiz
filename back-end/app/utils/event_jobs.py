"""
Shared in-memory job registry for Server-Sent Events progress streams.

Used by long-running work that needs to report progress to the client in real
time (quiz generation, document processing).  Follows the same convention as
``app/features/folder/smart_import_service.py``: a module-level dict guarded by
a lock, with no persistence — a backend restart drops every job and clients
fall back to polling.

Two properties are load-bearing and must not be "optimised" away:

  1. ``events`` is append-only and never consumed.  Every subscriber keeps its
     own cursor, so two tabs watching the same job both receive everything.
  2. The producer never blocks on a consumer.  ``emit()`` appends under the
     lock and returns; there is no bounded queue.  Generation completes even if
     nobody is listening.

SSE framing note: every frame is a default ``message`` event (no ``event:``
field) so the browser delivers it to a single ``onmessage`` handler.  Clients
discriminate on the ``type`` field inside the JSON payload.  Keep-alive frames
carry ``{"type": "ping"}`` and deliberately have no ``id:``, so they never
advance a subscriber's cursor.
"""

import json
import logging
import threading
import uuid
from datetime import datetime, timezone

from flask import Response, request

logger = logging.getLogger(__name__)

_jobs: dict[str, dict] = {}
_cv = threading.Condition()

_DONE_TTL_SECONDS = 600      # keep finished jobs around this long for late subscribers
_MAX_AGE_SECONDS = 7200      # hard age cap, running or not
_MAX_JOBS = 50
_MAX_EVENTS_PER_JOB = 2000   # head-trim beyond this; subscribers get a resync frame
_HEARTBEAT_SECONDS = 15

_PING_FRAME = 'data: {"type":"ping"}\n\n'
_RESYNC_FRAME = 'data: {"type":"resync"}\n\n'


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _now_ts() -> float:
    return datetime.now(timezone.utc).timestamp()


# ── Registry ──────────────────────────────────────────────────────────────────


def _evict_locked() -> None:
    """Drop stale jobs. Called from create_job() only — no timer thread needed."""
    now = _now_ts()
    for job_id in list(_jobs.keys()):
        job = _jobs[job_id]
        if now - job["_createdTs"] > _MAX_AGE_SECONDS:
            del _jobs[job_id]
            continue
        if job["status"] != "running" and now - job["_finishedTs"] > _DONE_TTL_SECONDS:
            del _jobs[job_id]

    if len(_jobs) <= _MAX_JOBS:
        return
    # Still over budget — drop finished jobs oldest-first, then oldest overall.
    ordered = sorted(
        _jobs.items(),
        key=lambda kv: (kv[1]["status"] == "running", kv[1]["_createdTs"]),
    )
    for job_id, _ in ordered[: len(_jobs) - _MAX_JOBS]:
        _jobs.pop(job_id, None)


def create_job(job_id: str | None = None, *, reuse_running: bool = False, **initial) -> str:
    """
    Register a new job and return its id.

    reuse_running: when a job with this id already exists and is still running,
    return it untouched instead of reopening it.  Used by document processing,
    where the job id is the folder id and a second upload should append to the
    stream a subscriber is already reading.

    Reopening an existing id keeps its event log and index: the run continues
    numbering where the last one stopped, so a subscriber holding a stale cursor
    neither stalls nor gets a spurious resync.
    """
    with _cv:
        _evict_locked()
        job_id = job_id or str(uuid.uuid4())

        existing = _jobs.get(job_id)
        if existing is not None:
            if reuse_running and existing["status"] == "running":
                return job_id
            existing.update(initial)
            existing["status"] = "running"
            existing["finishedAt"] = None
            existing["_finishedTs"] = _now_ts()
            _cv.notify_all()
            return job_id

        now = _now_ts()
        _jobs[job_id] = {
            "jobId": job_id,
            "status": "running",
            "startedAt": _now_iso(),
            "finishedAt": None,
            "lastEventIndex": -1,
            "droppedBefore": 0,
            "nextIndex": 0,
            "events": [],
            "_createdTs": now,
            "_finishedTs": now,
            **initial,
        }
        _cv.notify_all()
        return job_id


def emit(job_id: str, event_type: str, data: dict | None = None) -> None:
    """Append one event to a job and wake every subscriber. Never blocks."""
    with _cv:
        job = _jobs.get(job_id)
        if job is None:
            return
        index = job["nextIndex"]
        job["nextIndex"] = index + 1
        job["lastEventIndex"] = index
        job["events"].append(
            {"index": index, "type": event_type, "ts": _now_iso(), "data": data or {}}
        )
        if len(job["events"]) > _MAX_EVENTS_PER_JOB:
            overflow = len(job["events"]) - _MAX_EVENTS_PER_JOB
            job["events"] = job["events"][overflow:]
            job["droppedBefore"] = job["events"][0]["index"]
        _cv.notify_all()


def emitter(job_id: str):
    """Return an ``emit(type, data)`` closure bound to this job."""

    def _emit(event_type: str, data: dict | None = None) -> None:
        emit(job_id, event_type, data)

    return _emit


def finish_job(job_id: str, status: str = "done") -> None:
    with _cv:
        job = _jobs.get(job_id)
        if job is None:
            return
        job["status"] = status
        job["finishedAt"] = _now_iso()
        job["_finishedTs"] = _now_ts()
        _cv.notify_all()


def job_exists(job_id: str) -> bool:
    with _cv:
        return job_id in _jobs


def get_snapshot(job_id: str, from_index: int = 0) -> dict | None:
    """JSON-serialisable view of a job plus its events from `from_index` on."""
    with _cv:
        job = _jobs.get(job_id)
        if job is None:
            return None
        snapshot = {k: v for k, v in job.items() if not k.startswith("_") and k != "events"}
        snapshot["events"] = [
            {"type": e["type"], **e["data"]}
            for e in job["events"]
            if e["index"] >= from_index
        ]
        return snapshot


# ── SSE ───────────────────────────────────────────────────────────────────────


def cursor_from_request() -> int:
    """Resume position: ``?from=`` first, then the Last-Event-ID header, else 0."""
    raw = request.args.get("from") or request.headers.get("Last-Event-ID") or "0"
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return 0


def _format_frame(event: dict) -> str:
    payload = {"type": event["type"], **event["data"]}
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"id: {event['index']}\ndata: {body}\n\n"


def _stream(job_id: str, from_index: int):
    """
    Generator for the SSE body.

    Runs *outside* any request/app context — Flask pops the request context
    before the WSGI server iterates the response body.  That is deliberate: it
    means no SQLAlchemy session is held open for the life of the stream.  This
    generator must therefore only ever touch the in-memory registry, never
    ``request``, ``current_app``, ``db`` or any model.

    Never yield while holding ``_cv`` — one dead client would stall every other
    subscriber's thread.
    """
    yield "retry: 3000\n\n"
    cursor = from_index
    resync = False

    while True:
        pending: list[dict] = []
        finished = False

        with _cv:
            job = _jobs.get(job_id)
            if job is None:
                break

            if cursor < job["droppedBefore"]:
                cursor = job["droppedBefore"]
                resync = True

            pending = [e for e in job["events"] if e["index"] >= cursor]
            if not pending:
                if job["status"] != "running":
                    finished = True
                else:
                    _cv.wait(timeout=_HEARTBEAT_SECONDS)
                    job = _jobs.get(job_id)
                    if job is None:
                        break
                    if cursor < job["droppedBefore"]:
                        cursor = job["droppedBefore"]
                        resync = True
                    pending = [e for e in job["events"] if e["index"] >= cursor]
                    finished = not pending and job["status"] != "running"

        if resync:
            resync = False
            yield _RESYNC_FRAME

        if pending:
            for event in pending:
                cursor = event["index"] + 1
                yield _format_frame(event)
            continue

        if finished:
            break

        yield _PING_FRAME


def sse_response(job_id: str, from_index: int = 0) -> Response:
    """
    Build the streaming Response. Capture args before returning — see _stream().

    Do not set ``direct_passthrough``: it skips Flask's str→bytes encoding, and
    the WSGI server then rejects the text frames with "applications must write
    bytes". The default path already streams the generator lazily.
    """
    response = Response(_stream(job_id, from_index), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-cache, no-transform"
    response.headers["X-Accel-Buffering"] = "no"
    response.headers["Connection"] = "keep-alive"
    return response
