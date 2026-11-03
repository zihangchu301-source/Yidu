@echo off
title EPUB Reader
cd /d "%~dp0"

rem ============================================================
rem  IMPORTANT: keep this file PURE ASCII (do NOT put Chinese
rem  characters in it). cmd.exe mis-parses multi-byte text in .bat
rem  files and the script then fails. Tested on 2026-10-12.
rem  Chinese docs: see the Chinese-named .md file in this folder
rem
rem  Double click this file:
rem    1. if the server (port 5000) is already running, just open the page
rem    2. otherwise start python main.py (the page opens automatically)
rem    3. press Ctrl + C in this window to stop the server
rem
rem  If you change the port in config.ini, also change the two
rem  occurrences of 5000 below (findstr and the http address).
rem ============================================================

rem ---- 1. server already running? just open the page ----
netstat -ano | findstr "LISTENING" | findstr ":5000" >nul
if not errorlevel 1 (
    echo Server is already running. Opening the page...
    start "" http://127.0.0.1:5000
    ping -n 2 127.0.0.1 >nul
    exit /b
)

rem ---- 2. is python available? ----
where python >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python was not found.
    echo Please install Python and check "Add python.exe to PATH",
    echo or run python main.py manually in this folder.
    pause
    exit /b
)

rem ---- 3. start the server (the page opens automatically) ----
echo Starting EPUB Reader server...
echo The page will open automatically in a few seconds.
echo To stop the server: press Ctrl + C in this window.
python main.py

echo.
echo Server stopped.
pause