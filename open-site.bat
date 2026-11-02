@echo off
rem Serves the website on http://localhost:8765 and opens it. Close this window to stop it.
cd /d "%~dp0"
start "" http://localhost:8765/
python serve.py 8765
