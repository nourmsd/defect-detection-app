@echo off
echo Starting Smart Quality Control System...

:: ── Terminal 1: Node Backend (auto-starts niryo_stream.py on port 5001) ─────
start "Node Backend" cmd /k "cd /d "C:\Users\nourm\OneDrive\Desktop\P\Stage_PFE\smart-quality-control-frontend\backend" && node server.js"

:: Wait 3 seconds for backend + stream server to initialize
timeout /t 3 /nobreak > nul

:: ── Terminal 2: Angular Frontend ─────────────────────────────────────────────
start "Angular Frontend" cmd /k "cd /d "C:\Users\nourm\OneDrive\Desktop\P\Stage_PFE\smart-quality-control-frontend" && ng serve"

:: Wait for Angular to compile before opening browser
echo.
echo Waiting for Angular to compile...
timeout /t 10 /nobreak > nul

:: Open the app in the default browser
start "" http://localhost:4200

echo.
echo All services started!
echo  - Niryo Stream  : http://localhost:5001/stream
echo  - Node Backend  : http://localhost:5000
echo  - Angular App   : http://localhost:4200
echo.
echo Close Niryo Studio before connecting to the robot.
pause
