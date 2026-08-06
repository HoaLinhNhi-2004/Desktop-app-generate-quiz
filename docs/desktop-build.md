# Desktop Application Packaging (Windows .exe)

The desktop app runs as a single .exe: Electron starts the backend (Flask packaged with PyInstaller) and opens the React UI. Data (DB, uploads) is stored in the app's user data directory.

## Build Order

1. **Build backend** (creates `WebQuizBackend.exe` and copies it to `front-end/backend/`):

   ```powershell
   cd ..\back-end
   .\build_backend.ps1
   ```

   Requires: Python, `pip install -r requirements.txt`, `pip install pyinstaller`.

2. **Build Electron** (creates installer/portable in `dist/`):

   ```powershell
   cd front-end
   npm run dist:win
   ```

   Or **a single command** (from the `front-end` directory):

   ```powershell
   npm run build:desktop:win
   ```

   This script runs `build_backend.ps1` then executes `dist:win`.

## Output

- `dist/` contains the portable file (.exe) or MSI.
- Users install/run a single .exe; the backend runs automatically with `USER_DATA_PATH` = user data directory (e.g., `%AppData%/com.n-ziermann.front-end`).

## Verifying a bundle before shipping

**Always build against a clean environment** — `pip install -r requirements.txt` and nothing else. PyInstaller can only bundle what it finds installed, so a package that happens to sit in your everyday interpreter (but is missing from `requirements.txt`) silently drops out of the release. That is how v1.5.0–v1.7.0 shipped without `tzdata`: the backend crashed at import time on every user's machine, and the app looked like it needed a manually started backend.

Two gates run automatically — in `build_backend.ps1` / `.sh`, and again in `ci.yml` / `release.yml`:

```powershell
# 1. Every package the app imports lazily really is inside the bundle
..\front-end\backend\WebQuizBackend.exe --selfcheck

# 2. The bundle actually boots and answers /api/health
python smoke_test_bundle.py ..\front-end\backend\WebQuizBackend.exe
```

When you add a third-party import to the backend:

1. Add it to `requirements.txt`.
2. If it is imported **inside a function** (which PyInstaller's static analysis cannot see), add `--hidden-import` to both build scripts.
3. Add it to `REQUIRED_MODULES` in [`back-end/selfcheck.py`](../back-end/selfcheck.py) so a future build cannot lose it quietly.

## Runtime behaviour

- **Port:** the backend prefers `5000` (the port OAuth redirect URIs are registered against) and falls back to an OS-assigned free port when something else holds it — another install, a dev server, or AirPlay Receiver on macOS. Electron passes the chosen port through `PORT`, pins `OAUTH_REDIRECT_BASE` to it, and hands the URL to the renderer, which reads it in `APP_CONFIG.API_URL`.
- **Startup:** a splash page appears immediately; the UI loads once `/api/health` answers. A backend that dies is reported at once rather than after the timeout.
- **Logs:** the backend's stdout/stderr go to `<userData>/logs/backend.log`, rewritten per launch and offered in the failure dialog.
- **Single instance:** a second launch focuses the running window instead of starting a second backend against the same SQLite file.

## Notes

- The `front-end/backend/` directory must exist (containing `WebQuizBackend.exe`) when running `dist:win`; if the backend hasn't been built yet, run `build_backend.ps1` first.
- Dev mode (`npm run dev`): does not spawn the backend; you need to run `python app.py` in `back-end` separately.
- Scanned-PDF OCR rasterises pages with PyMuPDF (`render_pdf_pages()` in `pdf_service.py`). Do not reach for `pdf2image` here: it shells out to poppler, a native toolchain that cannot ship inside the PyInstaller bundle, and its absence is what made scanned PDFs extract to nothing on every installed copy.
