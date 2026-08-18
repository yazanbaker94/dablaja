# Launcher script for Kimi K3 Local Bridge Server
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$venvPython = Join-Path $scriptDir ".venv-kimi\Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    Write-Error "Virtual environment not found at $venvPython. Please set up .venv-kimi first."
    exit 1
}

# Clean up proxy environment in current shell session if pointing to local ports
if ($env:HTTP_PROXY -like "*127.0.0.1*" -or $env:HTTP_PROXY -like "*localhost*") { $env:HTTP_PROXY = "" }
if ($env:HTTPS_PROXY -like "*127.0.0.1*" -or $env:HTTPS_PROXY -like "*localhost*") { $env:HTTPS_PROXY = "" }
if ($env:ALL_PROXY -like "*127.0.0.1*" -or $env:ALL_PROXY -like "*localhost*") { $env:ALL_PROXY = "" }
$env:NO_PROXY = "*"

# Check and kill stale bridge processes on port 8765 if present
try {
    $existing = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
    if ($existing) {
        $pids = $existing | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($p in $pids) {
            if ($p -gt 0) {
                Write-Host "Releasing port 8765 (stopping previous bridge PID $p)..." -ForegroundColor Yellow
                Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
            }
        }
        Start-Sleep -Seconds 1
    }
} catch {}

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " Starting Kimi K3 Local OpenAI Bridge Server" -ForegroundColor Cyan
Write-Host " Listening on: http://127.0.0.1:8765" -ForegroundColor Green
Write-Host " Model name:   kimi-k3-hf" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Cyan

& $venvPython -m uvicorn server:app --app-dir tools/kimi_bridge --host 127.0.0.1 --port 8765

