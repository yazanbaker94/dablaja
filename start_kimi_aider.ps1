# Launcher script for Aider against Kimi K3 Local Bridge
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$venvAider = Join-Path $scriptDir ".venv-kimi\Scripts\aider.exe"
$venvPython = Join-Path $scriptDir ".venv-kimi\Scripts\python.exe"

if (-not (Test-Path $venvAider)) {
    Write-Error "Aider executable not found at $venvAider."
    exit 1
}

# Prevent Python from generating __pycache__ (underscore-prefixed dirs break Chrome extension loading)
$env:PYTHONDONTWRITEBYTECODE = "1"

# 1. Verify Bridge Health
Write-Host "Checking Kimi Bridge at http://127.0.0.1:8765/health ..." -ForegroundColor Cyan
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8765/health" -TimeoutSec 5 -ErrorAction Stop
    Write-Host "Bridge is healthy (Model: $($health.model))" -ForegroundColor Green
} catch {
    Write-Warning "Kimi Bridge is NOT responding at http://127.0.0.1:8765!"
    Write-Warning "Please start the bridge first by running: .\start_kimi_bridge.ps1"
    exit 1
}

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host " Starting Aider with Kimi K3 Backend" -ForegroundColor Cyan
Write-Host " Base URL:  http://127.0.0.1:8765/v1" -ForegroundColor Green
Write-Host " Model:     openai/kimi-k3-hf" -ForegroundColor Green
Write-Host " Streaming: Disabled (--no-stream)" -ForegroundColor Green
Write-Host "====================================================" -ForegroundColor Cyan

& $venvAider --model openai/kimi-k3-hf --openai-api-base http://127.0.0.1:8765/v1 --openai-api-key dummy --no-stream @args
