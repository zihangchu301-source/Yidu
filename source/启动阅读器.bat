@echo off
rem ============================================================
rem  Deprecated launcher: kept only for old shortcuts.
rem  It now starts the same app as the launcher in the parent
rem  folder (venv + source\app.py). Keep this file ASCII-only.
rem ============================================================
cd /d "%~dp0.."
if not exist ".venv\Scripts\pythonw.exe" (
    echo [ERROR] .venv not found in %CD%
    pause
    exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" "source\app.py"
exit /b 0
