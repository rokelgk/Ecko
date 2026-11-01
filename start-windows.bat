@echo off
rem Double-click to run Ecko on Windows. First run installs everything (a few minutes).
cd /d "%~dp0"
where py >nul 2>nul || (
  echo Python isn't installed. Get it from https://www.python.org/downloads/ and run this again.
  pause
  exit /b 1
)
if not exist .venv py -m venv .venv
.venv\Scripts\pip install -q -r requirements.txt || (echo Install failed. & pause & exit /b 1)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:8000/tone.html"
echo Ecko is running at http://localhost:8000 . Close this window to stop it.
.venv\Scripts\uvicorn ecko.app:app --port 8000
