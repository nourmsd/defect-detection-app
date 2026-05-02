@echo off
title Smart Quality Control — Startup
echo.
echo  ╔══════════════════════════════════════════════════╗
echo  ║     SMART QUALITY CONTROL — STARTING ALL        ║
echo  ╚══════════════════════════════════════════════════╝
echo.

set ROOT=C:\Users\nourm\OneDrive\Desktop\P\Stage_PFE\smart-quality-control-frontend
set BACKEND=%ROOT%\backend
set PYTHON=%BACKEND%\niryo_env\Scripts\python.exe

:: ── 1. Node Backend  (auto-starts niryo_stream.py on :5001 + AI pipeline) ───
echo [1/4] Starting Node.js backend...
start "Backend  :5000" cmd /k "cd /d "%BACKEND%" && node server.js"
timeout /t 4 /nobreak > nul

:: ── 2. Niryo Pick-and-Place Controller (:5002) ───────────────────────────────
echo [2/4] Starting Niryo pick-and-place controller...
start "Robot  :5002" cmd /k "cd /d "%BACKEND%" && "%PYTHON%" niryo_pick_place.py"
timeout /t 2 /nobreak > nul

:: ── 3. Angular Frontend ──────────────────────────────────────────────────────
echo [3/4] Starting Angular dev server...
start "Frontend  :4200" cmd /k "cd /d "%ROOT%" && ng serve"

:: ── 4. Open browser after Angular compiles ───────────────────────────────────
echo [4/4] Waiting for Angular to compile (15 s)...
timeout /t 15 /nobreak > nul
start "" http://localhost:4200

echo.
echo  ╔══════════════════════════════════════════════════╗
echo  ║  All services started!                           ║
echo  ║  Stream      :  http://localhost:5001/stream     ║
echo  ║  Backend     :  http://localhost:5000            ║
echo  ║  Robot ctrl  :  http://localhost:5002/status     ║
echo  ║  Frontend    :  http://localhost:4200            ║
echo  ╚══════════════════════════════════════════════════╝
echo.
echo  Close Niryo Studio before connecting to the robot.
echo  Robot arm will retry connection automatically.
echo.
pause
