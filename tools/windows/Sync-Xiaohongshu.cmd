@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node collector.cjs --platform xiaohongshu --max-jobs 20
set "QR_EXIT=%ERRORLEVEL%"
echo.
echo Xiaohongshu synchronization stopped. This does not prove history outside the current list window is complete.
pause
exit /b %QR_EXIT%
