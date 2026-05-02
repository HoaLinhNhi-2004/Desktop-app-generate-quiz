<#
.SYNOPSIS
  Build the Flask backend into a standalone WebQuizBackend.exe using PyInstaller.
  Output is placed in ../front-end/backend/ so electron-builder can bundle it
  as an extraResource.

.NOTES
  Prerequisites:
    - Python 3.11+ installed and on PATH
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
Write-Host "`n[1/4] Checking PyInstaller..." -ForegroundColor Yellow
python -m pip install pyinstaller --quiet
if ($LASTEXITCODE -ne 0) { throw "Failed to install PyInstaller" }

# 2. Run PyInstaller in one-dir mode
Write-Host "[2/4] Running PyInstaller..." -ForegroundColor Yellow
Push-Location $BackendDir
try {
    pyinstaller `
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
        --hidden-import "youtube_transcript_api" `
        --hidden-import "yt_dlp" `
        --hidden-import "chromadb" `
        --hidden-import "onnxruntime" `
        --hidden-import "PIL" `
        --hidden-import "numpy" `
        --hidden-import "pdf2image" `
        --collect-all "google.generativeai" `
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
Write-Host "[3/4] Copying to front-end/backend/ ..." -ForegroundColor Yellow
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

# 4. Verify
$exePath = Join-Path $FrontendBackendDir "WebQuizBackend.exe"
if (Test-Path $exePath) {
    $size = [math]::Round((Get-Item $exePath).Length / 1MB, 1)
    Write-Host "`n[4/4] SUCCESS: $exePath ($size MB)" -ForegroundColor Green
} else {
    throw "WebQuizBackend.exe not found at $exePath"
}

Write-Host "`nBackend build complete!" -ForegroundColor Cyan
