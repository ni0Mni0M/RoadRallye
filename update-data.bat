@echo off
rem Downloads the current roadsurfer rallies into web\data (takes about 4-5 minutes).
rem Pass /nopause when running it from Task Scheduler.
cd /d "%~dp0"
python scraper\fetch_rallies.py
if errorlevel 1 (
  echo.
  echo Update failed. The previous data is still in place.
) else (
  rem Route scenery and weather for the ranking. Both only fetch what's new, so after the
  rem first run (about 20 minutes) they take seconds.
  python scraper\fetch_route_info.py
  python scraper\fetch_climate.py
)
if /i not "%~1"=="/nopause" pause
