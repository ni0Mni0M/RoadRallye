@echo off
rem Serves the website and opens it. Close this window to stop it.
rem Optional: a port number, e.g. "open-site.bat 8775" (compare.bat uses this). Default 8765.
cd /d "%~dp0"
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8765"
start "" http://localhost:%PORT%/
python serve.py %PORT%
if errorlevel 1 pause
