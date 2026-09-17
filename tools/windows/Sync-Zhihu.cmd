@echo off
setlocal
cd /d "%~dp0"
node collector.cjs --platform zhihu --max-jobs 20
set "QR_EXIT=%ERRORLEVEL%"
echo.
echo Zhihu synchronization stopped. This does not mean all subscribed authors were checked.
pause
exit /b %QR_EXIT%
