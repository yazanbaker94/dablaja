$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir
$pythonExe = Join-Path $scriptDir ".venv-kimi\Scripts\python.exe"
if (-not (Test-Path $pythonExe)) {
    Write-Error "Virtual environment not found at $pythonExe."
    exit 1
}
# Prevent Python from generating __pycache__ (underscore-prefixed dirs break Chrome extension loading)
$env:PYTHONDONTWRITEBYTECODE = "1"
& $pythonExe chat_kimi.py