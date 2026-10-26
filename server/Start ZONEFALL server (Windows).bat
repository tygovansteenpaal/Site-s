@echo off
rem Double-click on Windows: creates a private Python environment the first time, then starts the ZONEFALL server.
cd /d "%~dp0"
where py >nul 2>nul && (set PY=py -3) || (set PY=python)
%PY% --version >nul 2>nul || (echo Python 3 is not installed. Get it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^) and run this again. & pause & exit /b 1)
if not exist .venv (
  echo First start: installing the server ^(one time^)...
  %PY% -m venv .venv || (pause & exit /b 1)
  .venv\Scripts\python -m pip install --quiet --upgrade pip
  .venv\Scripts\python -m pip install --quiet -r requirements.txt || (echo Install failed. & pause & exit /b 1)
)
.venv\Scripts\python zonefall_server.py %*
pause
