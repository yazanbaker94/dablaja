@echo off
title Kimi K3 CLI Chat
cd /d "%~dp0"
if not exist ".venv-kimi\Scripts\python.exe" (
    echo Error: .venv-kimi environment not found.
    pause
    exit /b 1
)
.venv-kimi\Scripts\python.exe chat_kimi.py
pause
