@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found. Install Node.js and make sure node is on PATH.
    pause
    exit /b 1
)

where adb >nul 2>nul
if errorlevel 1 (
    echo ADB was not found. Install Android platform-tools and make sure adb is on PATH.
    pause
    exit /b 1
)

if not exist "%~dp0server.js" (
    echo server.js was not found beside this batch file.
    pause
    exit /b 1
)

echo Starting the ADB live-log helper...
node "%~dp0server.js"

if errorlevel 1 (
    echo The ADB helper stopped with an error.
    pause
)

endlocal
