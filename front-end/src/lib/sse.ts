/**
 * Thin EventSource wrapper shared by the streaming feature APIs.
 *
 * Every backend frame is a default `message` event whose JSON payload carries a
 * `type` field, so callers get one handler and discriminate on `type`.
 *
 * Two EventSource sharp edges are handled here so callers never see them:
 *  - the browser reconnects after the server closes a finished stream, so the
 *    caller closes the connection on its own terminal event (see `close()`).
 *  - a 404 (backend restarted, job evicted) is indistinguishable from a network
 *    blip and would retry forever, so consecutive failed connects and a
 *    no-traffic watchdog both give up and report an error.
 *
 * Feature `api.ts` modules own URL construction; this only owns the transport.
 */

const MAX_CONSECUTIVE_FAILURES = 5;
const IDLE_TIMEOUT_MS = 45_000; // backend pings every 15s

export interface EventStreamHandlers<T> {
  onMessage: (payload: T) => void;
  /** Transport gave up. Terminal — no further callbacks fire. */
  onGiveUp: (message: string) => void;
}

export interface EventStreamHandle {
  close: () => void;
}

export function openEventStream<T>(
  url: string,
  handlers: EventStreamHandlers<T>,
): EventStreamHandle {
  let source: EventSource | null = new EventSource(url);
  let failures = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    source?.close();
    source = null;
  };

  const giveUp = (message: string) => {
    if (closed) return;
    close();
    handlers.onGiveUp(message);
  };

  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => giveUp("Stream idle for too long"),
      IDLE_TIMEOUT_MS,
    );
  };

  armIdleTimer();

  source.onmessage = (event) => {
    failures = 0;
    armIdleTimer();
    try {
      handlers.onMessage(JSON.parse(event.data) as T);
    } catch {
      // A malformed frame is skipped, never fatal.
    }
  };

  source.onerror = () => {
    if (closed) return;
    // readyState CLOSED means the browser will not retry on its own.
    if (source?.readyState === EventSource.CLOSED) {
      giveUp("Stream closed by the server");
      return;
    }
    failures += 1;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      giveUp("Could not reconnect to the stream");
    }
  };

  return { close };
}
