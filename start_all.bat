@echo off
title Smart Quality Control — Startup
echo.
echo  ╔══════════════════════════════════════════════════╗
echo  ║     SMART QUALITY CONTROL — STARTING ALL        ║
echo  ╚══════════════════════════════════════════════════╝
echo.

set ROOT=C:\Users\nourm\OneDrive\Desktop\P\Stage_PFE\smart-quality-control-frontend
set BACKEND=%ROOT%\backend

if not exist "%BACKEND%\app.py" (
    echo  ERROR: Cannot find backend\app.py at:
    echo    %BACKEND%\app.py
    echo  You may be running the wrong start_all.bat. Use the one at:
    echo    %ROOT%\start_all.bat
    pause
    exit /b 1
)

set PYTHON=python

:: ── 1. AI + Robot pipeline (app.py)  — owns the SINGLE NiryoRobot connection ──
::    Serves :5001 (raw camera /stream), :5002 (robot HTTP API), :5003 (AI MJPEG).
::    Node detects this process via /status and won't spawn a duplicate.
echo [1/4] Starting AI + Robot pipeline (app.py) ...
echo        using interpreter: %PYTHON%
start "AI+Robot  :5002 :5003 :5001" /d "%BACKEND%" cmd /k %PYTHON% -u app.py
timeout /t 6 /nobreak > nul

:: ── 2. Node Backend (:5000) ──────────────────────────────────────────────────
::    Reads SOCKET_EVENT lines from app.py stdout → MongoDB + Socket.IO broadcast.
echo [2/4] Starting Node.js backend ...
start "Backend  :5000" /d "%BACKEND%" cmd /k node server.js
timeout /t 4 /nobreak > nul

:: ── 3. Angular Frontend ──────────────────────────────────────────────────────
echo [3/4] Starting Angular dev server ...
start "Frontend  :4200" /d "%ROOT%" cmd /k ng serve

:: ── 4. Open browser after Angular compiles ───────────────────────────────────
echo [4/4] Waiting for Angular to compile (15 s)...
timeout /t 15 /nobreak > nul
start "" http://localhost:4200

echo.
echo  ╔══════════════════════════════════════════════════╗
echo  ║  All services started!                           ║
echo  ║  Raw camera     :  http://localhost:5001/stream  ║
echo  ║  AI + diag      :  http://localhost:5003/ai_stream      ║
echo  ║  Barcode (phone):  http://localhost:5003/barcode_stream ║
echo  ║  Backend        :  http://localhost:5000         ║
echo  ║  Robot ctrl     :  http://localhost:5002/status  ║
echo  ║  Frontend       :  http://localhost:4200         ║
echo  ╚══════════════════════════════════════════════════╝
echo.
echo  Close Niryo Studio before connecting to the robot.
echo  Robot arm will retry connection automatically.
echo.
pause
