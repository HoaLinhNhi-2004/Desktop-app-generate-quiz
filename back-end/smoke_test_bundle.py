"""
Boot smoke test for the packaged backend — run against the built executable.

`--selfcheck` proves the imports resolve; this proves the thing actually runs:
it starts the executable exactly the way Electron does (USER_DATA_PATH set, a
free PORT) and waits for /api/health. Releases v1.5.0-v1.7.0 would have failed
here, because the backend died before it ever bound a socket.

Usage:
  python smoke_test_bundle.py ../front-end/backend/WebQuizBackend.exe
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

BOOT_TIMEOUT_SECONDS = 180


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_health(proc: subprocess.Popen, url: str, log: Path) -> int:
    deadline = time.monotonic() + BOOT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            print(f"SMOKE FAILED — backend exited with code {proc.returncode}:")
            print(log.read_text(encoding="utf-8", errors="replace"))
            return 1
        try:
            with urllib.request.urlopen(url, timeout=3) as res:
                if res.status == 200:
                    print(f"SMOKE OK — {url} answered 200")
                    return 0
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            pass
        time.sleep(1)

    print(f"SMOKE FAILED — no response from {url} within {BOOT_TIMEOUT_SECONDS}s")
    print(log.read_text(encoding="utf-8", errors="replace"))
    return 1


def main(exe: Path) -> int:
    if not exe.is_file():
        print(f"SMOKE FAILED — executable not found: {exe}")
        return 1

    port = _free_port()
    with tempfile.TemporaryDirectory(prefix="webquiz-smoke-") as workdir:
        # A file rather than a pipe: nothing reads the stream while we poll, and a
        # full pipe buffer would wedge the backend we are trying to test.
        log = Path(workdir) / "backend.log"
        user_data = Path(workdir) / "userdata"
        user_data.mkdir()

        with log.open("w", encoding="utf-8") as sink:
            proc = subprocess.Popen(
                [str(exe)],
                cwd=str(exe.parent),
                env={**os.environ, "USER_DATA_PATH": str(user_data), "PORT": str(port)},
                stdout=sink,
                stderr=subprocess.STDOUT,
            )
            try:
                return _wait_for_health(proc, f"http://127.0.0.1:{port}/api/health", log)
            finally:
                proc.kill()
                proc.wait(timeout=30)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(Path(sys.argv[1]).resolve()))
