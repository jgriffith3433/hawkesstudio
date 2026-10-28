@echo off
rem Hawkes now runs in the cloud (hawkesgen.ai). "auto-start.bat local" runs a copy on this PC instead.
if /I not "%~1"=="local" if exist "%USERPROFILE%\.hawkes\client.json" (
  echo Hawkes runs at https://studio.hawkesgen.ai/
  start "" "https://studio.hawkesgen.ai/"
  exit /b 0
)
cd /d "%~dp0"
if not exist node_modules call npm install
powershell -NoProfile -ExecutionPolicy Bypass -File bin
estart.ps1
start "" "http://127.0.0.1:8791/"
