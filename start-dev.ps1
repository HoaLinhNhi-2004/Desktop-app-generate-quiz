<#
.SYNOPSIS
    Launch Quiz Generator in development mode (backend + frontend).

.DESCRIPTION
    Dev mode needs BOTH processes running. Electron does NOT spawn the backend
    in dev -- see front-end/src/electron/backendManager.ts ("child is null in
    dev, where the developer runs the backend themselves"). The packaged .exe
    is the only build that starts its own backend.

    This script opens the backend in its own window, waits until it answers
    /api/health, then starts the frontend. It also clears leftover dev servers
    from a previous session, which otherwise cause "Port 5123 is already in use".

.PARAMETER Web
    Browser-only mode: runs Vite without Electron. Open http://localhost:5123.

.EXAMPLE
    .\start-dev.ps1
    Desktop app (Electron + Vite).

.EXAMPLE
    .\start-dev.ps1 -Web
    Browser only.
#>
[CmdletBinding()]
param(
    [switch]$Web
)

$ErrorActionPreference = 'Stop'

$Root        = $PSScriptRoot
$BackendDir  = Join-Path $Root 'back-end'
$FrontendDir = Join-Path $Root 'front-end'
$Python      = Join-Path $BackendDir 'venv\Scripts\python.exe'
$BackendPort = 5000
$VitePort    = 5123
$HealthUrl   = "http://127.0.0.1:$BackendPort/api/health"

function Get-PortOwner {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if (-not $conn) { return $null }
    $procId = $conn.OwningProcess
    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    return [PSCustomObject]@{
        Id          = $procId
        Name        = $(if ($cim) { $cim.Name } else { 'unknown' })
        CommandLine = $(if ($cim) { $cim.CommandLine } else { '' })
    }
}

function Test-BackendHealthy {
    try {
        $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

# --- Prerequisites -----------------------------------------------------------

if (-not (Test-Path $Python)) {
    Write-Host "[X] Backend venv not found: $Python" -ForegroundColor Red
    Write-Host "    Create it first:" -ForegroundColor Yellow
    Write-Host "      cd '$BackendDir'; python -m venv venv; .\venv\Scripts\python.exe -m pip install -r requirements.txt"
    exit 1
}

if (-not (Test-Path (Join-Path $FrontendDir 'node_modules'))) {
    Write-Host "[X] Frontend dependencies not installed." -ForegroundColor Red
    Write-Host "    Run:  cd '$FrontendDir'; npm install" -ForegroundColor Yellow
    exit 1
}

# --- Backend -----------------------------------------------------------------

if (Test-BackendHealthy) {
    Write-Host "[=] Backend already running on port $BackendPort - reusing it." -ForegroundColor Cyan
} else {
    $owner = Get-PortOwner -Port $BackendPort
    if ($owner) {
        # Something holds :5000 but does not answer /api/health. Not ours to kill
        # blindly -- the port is a common one (other apps, other installs).
        Write-Host "[X] Port $BackendPort is busy but not responding to /api/health." -ForegroundColor Red
        Write-Host "    PID $($owner.Id)  $($owner.Name)" -ForegroundColor Yellow
        Write-Host "    $($owner.CommandLine)" -ForegroundColor DarkGray
        Write-Host "    Stop it yourself, then re-run:  Stop-Process -Id $($owner.Id) -Force" -ForegroundColor Yellow
        exit 1
    }

    Write-Host "[>] Starting backend..." -ForegroundColor Green
    Start-Process powershell -ArgumentList @(
        '-NoExit', '-Command',
        "Set-Location '$BackendDir'; & '$Python' app.py"
    ) | Out-Null

    Write-Host "    Waiting for $HealthUrl " -NoNewline
    $ready = $false
    for ($i = 0; $i -lt 120; $i++) {      # up to 60s
        Start-Sleep -Milliseconds 500
        if (Test-BackendHealthy) { $ready = $true; break }
        if ($i % 4 -eq 0) { Write-Host '.' -NoNewline }
    }
    Write-Host ''

    if (-not $ready) {
        Write-Host "[X] Backend did not come up in 60s. Check its window for the error." -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Backend healthy on port $BackendPort." -ForegroundColor Green
}

# --- Clear leftover dev servers from a previous session ----------------------

$viteOwner = Get-PortOwner -Port $VitePort
if ($viteOwner) {
    $belongsToProject = $viteOwner.CommandLine -and
                        $viteOwner.CommandLine.ToLower().Contains($Root.ToLower())

    if (-not $belongsToProject) {
        # Something unrelated holds the port; not ours to kill.
        Write-Host "[X] Port $VitePort is used by a process outside this project." -ForegroundColor Red
        Write-Host "    PID $($viteOwner.Id)  $($viteOwner.Name)" -ForegroundColor Yellow
        Write-Host "    $($viteOwner.CommandLine)" -ForegroundColor DarkGray
        exit 1
    }

    # Kill the whole `npm run dev` tree, not just Vite: npm-run-all and the
    # Electron window are siblings of it and would otherwise linger.
    Write-Host "[!] Stale dev server on port $VitePort - cleaning up." -ForegroundColor Yellow
    $stale = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
             Where-Object {
                 ($_.Name -eq 'node.exe' -or $_.Name -eq 'electron.exe') -and
                 $_.CommandLine -and
                 $_.CommandLine.ToLower().Contains($Root.ToLower())
             }
    foreach ($p in $stale) {
        try {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            Write-Host "    stopped PID $($p.ProcessId) ($($p.Name))" -ForegroundColor DarkGray
        } catch {
            # Already gone: killing a parent takes its children with it.
        }
    }

    # Wait for the port to be released rather than guessing at a sleep.
    $freed = $false
    for ($i = 0; $i -lt 20; $i++) {      # up to 10s
        Start-Sleep -Milliseconds 500
        if (-not (Get-PortOwner -Port $VitePort)) { $freed = $true; break }
    }
    if (-not $freed) {
        Write-Host "[X] Port $VitePort is still in use. Stop it manually and re-run." -ForegroundColor Red
        exit 1
    }
}

# --- Frontend ----------------------------------------------------------------

if ($Web) {
    $script = 'dev:react'
    $what   = 'Vite (browser only)'
} else {
    $script = 'dev'
    $what   = 'Vite + Electron (desktop)'
}

Write-Host "[>] Starting frontend: $what" -ForegroundColor Green
Start-Process powershell -ArgumentList @(
    '-NoExit', '-Command',
    "Set-Location '$FrontendDir'; npm run $script"
) | Out-Null

Write-Host ''
Write-Host "  Backend : $HealthUrl" -ForegroundColor Cyan
Write-Host "  Web UI  : http://localhost:$VitePort" -ForegroundColor Cyan
if (-not $Web) {
    Write-Host "  Desktop : the 'Generate Quiz' window opens shortly" -ForegroundColor Cyan
}
Write-Host ''
Write-Host "  To stop: press Ctrl+C in BOTH windows (and close the app window)." -ForegroundColor DarkGray
