@echo off
setlocal
cd /d "%~dp0"
node collector.cjs --platform bilibili --max-jobs 20
set "QR_EXIT=%ERRORLEVEL%"
echo.
echo Bilibili synchronization stopped. This does not mean all subscribed authors were checked.
pause
exit /b %QR_EXIT%
