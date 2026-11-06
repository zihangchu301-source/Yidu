@echo off
rem ============================================================
rem  译读 · 桌面版启动器
rem  跑 source\ 里的源码（和手机端同一套代码，带账号与云端同步）
rem  数据：config.ini / state\ / static\books 都在本目录
rem ============================================================
cd /d "%~dp0"

if not exist ".venv\Scripts\pythonw.exe" (
    echo [错误] 找不到运行环境 .venv
    echo 在本目录执行：
    echo     python -m venv .venv
    echo     .venv\Scripts\python.exe -m pip install flask ebooklib beautifulsoup4 tenacity openai pywebview
    pause
    exit /b 1
)

start "" ".venv\Scripts\pythonw.exe" "source\app.py"
exit /b 0
