@echo off
rem Downloads the current roadsurfer rallies into web\data (takes about 4-5 minutes).
rem Pass /nopause when running it from Task Scheduler.
cd /d "%~dp0"
python scraper\fetch_rallies.py
if errorlevel 1 (
  echo.
  echo Update failed. The previous data is still in place.
) else (
  rem Airports hardly change, so they are only downloaded once (delete web\data\airports.js to refresh).
  if not exist web\data\airports.js python scraper\fetch_airports.py
)
if /i not "%~1"=="/nopause" pause
