@echo off
rem Downloads the current roadsurfer rallies and Imoova relocations into web\data (takes about 4-5 minutes).
rem Pass /nopause when running it from Task Scheduler.
cd /d "%~dp0"
python scraper\fetch_rallies.py
if errorlevel 1 (
  echo.
  echo Update failed for at least one source. Its previous data is still in place.
)
if /i not "%~1"=="/nopause" pause
