@echo off
rem Opens every version side by side: this folder on port 8765, each branch worktree on 8775, 8776, ...
rem Each version runs in its own window; close a window to stop that version.
rem "compare.bat /list" only shows what would be started.
setlocal enabledelayedexpansion
cd /d "%~dp0"
set "HERE=%CD%"
set "LIST=0"
if /i "%~1"=="/list" set "LIST=1"

call :launch "%HERE%" 8765
set "PORT=8775"
for /f "tokens=1,*" %%a in ('git worktree list --porcelain') do (
  if "%%a"=="worktree" (
    set "WT=%%~fb"
    if /i not "!WT!"=="%HERE%" (
      call :launch "!WT!" !PORT!
      set /a PORT+=1
    )
  )
)
exit /b 0

:launch
for /f "delims=" %%b in ('git -C "%~1" branch --show-current') do set "BRANCH=%%b"
if "%LIST%"=="1" (
  echo !BRANCH!  http://localhost:%2/  %~1
) else (
  start "RoadRalley !BRANCH! (port %2)" "%~1\open-site.bat" %2
)
exit /b 0
