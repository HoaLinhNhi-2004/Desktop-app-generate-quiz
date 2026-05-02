#!/usr/bin/env bash
#
# Build the Flask backend into a standalone executable using PyInstaller.
# Output is placed in ../front-end/backend/ so electron-builder can bundle it
# as an extraResource.
#
# Prerequisites:
#   - Python 3.11+ installed
#   - pip install -r requirements.txt
#   - pip install pyinstaller

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/front-end/backend"

echo "========================================"
echo "  Building Flask backend (PyInstaller)"
echo "========================================"

# 1. Ensure PyInstaller is installed
echo ""
echo "[1/4] Checking PyInstaller..."
python3 -m pip install pyinstaller --quiet 2>/dev/null || python -m pip install pyinstaller --quiet

# 2. Run PyInstaller in one-dir mode
echo "[2/4] Running PyInstaller..."
cd "$SCRIPT_DIR"

PYTHON_CMD="python3"
command -v python3 &>/dev/null || PYTHON_CMD="python"

$PYTHON_CMD -m PyInstaller \
    --noconfirm \
    --clean \
    --name WebQuizBackend \
    --distpath "$SCRIPT_DIR/dist" \
    --workpath "$SCRIPT_DIR/build" \
    --specpath "$SCRIPT_DIR" \
    --hidden-import "flask" \
    --hidden-import "flask_cors" \
    --hidden-import "flask_sqlalchemy" \
    --hidden-import "sqlalchemy" \
    --hidden-import "dotenv" \
    --hidden-import "pdfplumber" \
    --hidden-import "fitz" \
    --hidden-import "google.generativeai" \
    --hidden-import "youtube_transcript_api" \
    --hidden-import "yt_dlp" \
    --hidden-import "chromadb" \
    --hidden-import "onnxruntime" \
    --hidden-import "PIL" \
    --hidden-import "numpy" \
    --hidden-import "pdf2image" \
    --collect-all "google.generativeai" \
    --collect-data "chromadb" \
    --collect-submodules "chromadb" \
    --collect-binaries "chromadb" \
    --exclude-module "tkinter" \
    --exclude-module "IPython" \
    --exclude-module "pytest" \
    --exclude-module "notebook" \
    --exclude-module "jupyter" \
    --exclude-module "matplotlib" \
    --add-data "app:app" \
    --add-data "config.py:." \
    app.py

# 3. Copy output to front-end/backend/
echo "[3/4] Copying to front-end/backend/ ..."
rm -rf "$FRONTEND_BACKEND_DIR"
cp -R "$SCRIPT_DIR/dist/WebQuizBackend" "$FRONTEND_BACKEND_DIR"

# 3b. Strip dead bundle: googleapiclient discovery_cache (~96MB JSON metadata for
#     ~600 Google APIs we don't call — google-generativeai transitively pulls
#     google-api-python-client but Gemini SDK does not use discovery.)
DISCOVERY_CACHE="$FRONTEND_BACKEND_DIR/_internal/googleapiclient/discovery_cache/documents"
if [ -d "$DISCOVERY_CACHE" ]; then
    rm -rf "$DISCOVERY_CACHE"
    echo "Removed googleapiclient discovery_cache documents (~96MB)"
fi

# 4. Verify
if [ -f "$FRONTEND_BACKEND_DIR/WebQuizBackend" ]; then
    SIZE=$(du -sh "$FRONTEND_BACKEND_DIR/WebQuizBackend" | cut -f1)
    echo ""
    echo "[4/4] SUCCESS: $FRONTEND_BACKEND_DIR/WebQuizBackend ($SIZE)"
else
    echo "ERROR: WebQuizBackend executable not found!" >&2
    exit 1
fi

echo ""
echo "Backend build complete!"
