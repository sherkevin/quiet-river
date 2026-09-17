@echo off
chcp 65001 >nul
cd /d "%~dp0"
node "%~dp0collector.cjs" --doctor
set "RESULT=%ERRORLEVEL%"
echo.
pause
exit /b %RESULT%
