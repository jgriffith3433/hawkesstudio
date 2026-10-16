@echo off
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8791 ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1
echo Hawkes Studio stopped.
