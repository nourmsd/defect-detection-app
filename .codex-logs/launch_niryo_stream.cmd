@echo off
setlocal
set ROOT=C:\Users\nourm\OneDrive\Desktop\P\Stage_PFE\smart-quality-control-frontend
set BACKEND=%ROOT%\backend
set PYTHON=%BACKEND%\niryo_env\Scripts\python.exe
set LOG=%ROOT%\.codex-logs\niryo_stream.log
cd /d "%BACKEND%"
"%PYTHON%" -u "%BACKEND%\niryo_stream.py" >> "%LOG%" 2>&1
