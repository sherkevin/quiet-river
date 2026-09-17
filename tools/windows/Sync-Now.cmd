@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0collector.cjs" --max-jobs 20
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
