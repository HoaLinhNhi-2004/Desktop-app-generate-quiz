<#
.SYNOPSIS
  Build the Flask backend into a standalone WebQuizBackend.exe using PyInstaller.
  Output is placed in ../front-end/backend/ so electron-builder can bundle it
  as an extraResource.

.NOTES
  Prerequisites:
    - Python 3.12+ installed and on PATH (numpy, pinned in requirements.txt, needs 3.12)
    - pip install -r requirements.txt
    - pip install pyinstaller
#>

$ErrorActionPreference = "Stop"

$BackendDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$FrontendBackendDir = Join-Path (Join-Path (Split-Path -Parent $BackendDir) "front-end") "backend"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Building Flask backend (PyInstaller)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. Ensure PyInstaller is installed
Write-Host "`n[1/5] Checking PyInstaller..." -ForegroundColor Yellow
python -m pip install pyinstaller --quiet
if ($LASTEXITCODE -ne 0) { throw "Failed to install PyInstaller" }

# 2. Run PyInstaller in one-dir mode
Write-Host "[2/5] Running PyInstaller..." -ForegroundColor Yellow
Push-Location $BackendDir
try {
    # Invoked through `python -m` (as build_backend.sh does) so the build always
    # uses the interpreter whose site-packages PyInstaller will scan — a stray
    # pyinstaller.exe earlier on PATH would bundle a different environment.
    python -m PyInstaller `
        --noconfirm `
        --clean `
        --name WebQuizBackend `
        --distpath "$BackendDir\dist" `
        --workpath "$BackendDir\build" `
        --specpath "$BackendDir" `
        --hidden-import "flask" `
        --hidden-import "flask_cors" `
        --hidden-import "flask_sqlalchemy" `
        --hidden-import "sqlalchemy" `
        --hidden-import "dotenv" `
        --hidden-import "pdfplumber" `
        --hidden-import "fitz" `
        --hidden-import "google.generativeai" `
        --hidden-import "google.genai" `
        --hidden-import "anthropic" `
        --hidden-import "openai" `
        --hidden-import "docx" `
        --hidden-import "pptx" `
        --hidden-import "pandas" `
        --hidden-import "openpyxl" `
        --hidden-import "xlrd" `
        --hidden-import "youtube_transcript_api" `
        --hidden-import "yt_dlp" `
        --hidden-import "chromadb" `
        --hidden-import "onnxruntime" `
        --hidden-import "tokenizers" `
        --hidden-import "tqdm" `
        --hidden-import "PIL" `
        --hidden-import "numpy" `
        --collect-all "google.generativeai" `
        --collect-all "google.genai" `
        --collect-all "anthropic" `
        --collect-all "openai" `
        --collect-all "tzdata" `
        --collect-all "tokenizers" `
        --collect-data "chromadb" `
        --collect-submodules "chromadb" `
        --collect-binaries "chromadb" `
        --exclude-module "tkinter" `
        --exclude-module "IPython" `
        --exclude-module "pytest" `
        --exclude-module "notebook" `
        --exclude-module "jupyter" `
        --exclude-module "matplotlib" `
        --add-data "app;app" `
        --add-data "config.py;." `
        app.py

    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed" }
} finally {
    Pop-Location
}

# 3. Copy output to front-end/backend/
Write-Host "[3/5] Copying to front-end/backend/ ..." -ForegroundColor Yellow
if (Test-Path $FrontendBackendDir) {
    Remove-Item -Recurse -Force $FrontendBackendDir
}
Copy-Item -Recurse -Force "$BackendDir\dist\WebQuizBackend" $FrontendBackendDir

# 3b. Strip dead bundle: googleapiclient discovery_cache (~96MB JSON metadata for
#     ~600 Google APIs we don't call — google-generativeai transitively pulls
#     google-api-python-client but Gemini SDK does not use discovery.)
$discoveryCache = Join-Path $FrontendBackendDir "_internal\googleapiclient\discovery_cache\documents"
if (Test-Path $discoveryCache) {
    Remove-Item -Recurse -Force $discoveryCache
    Write-Host "Removed googleapiclient discovery_cache documents (~96MB)" -ForegroundColor Green
}

# 4. Verify the executable exists
$exePath = Join-Path $FrontendBackendDir "WebQuizBackend.exe"
if (-not (Test-Path $exePath)) {
    throw "WebQuizBackend.exe not found at $exePath"
}
$size = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
Write-Host "[4/5] Built: $exePath ($size MB)" -ForegroundColor Green

# 5. Prove the bundle can import everything the app loads lazily. Without this,
#    a missing package only surfaces on a user's machine — which is exactly how
#    three releases shipped a backend that could not start.
Write-Host "[5/5] Running bundle self-check..." -ForegroundColor Yellow
& $exePath --selfcheck
if ($LASTEXITCODE -ne 0) { throw "Bundle self-check failed - do not ship this build" }

Write-Host "`nBackend build complete!" -ForegroundColor Cyan
