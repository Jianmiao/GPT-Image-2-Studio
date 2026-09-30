@echo off
setlocal enableextensions
chcp 65001 >nul 2>nul
title GPT Image 2 Studio
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

echo.
echo   Starting GPT Image 2 Studio ...
echo   Keep this window open. Close it to stop the server.
echo.
node "%~dp0server\cli.js" %*

echo.
echo   [server stopped] exit code %ERRORLEVEL%
echo   If there is an error above, send a screenshot to the assistant.
echo.
pause
exit /b 0

:NONODE
echo.
echo   [ERROR] Node.js not found.
echo   Please install Node 18 or newer: https://nodejs.org/
echo   Then double-click this file again.
echo.
pause
exit /b 1
