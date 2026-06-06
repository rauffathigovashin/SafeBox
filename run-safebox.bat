@echo off
chcp 65001 >nul
title SafeBox — Secure P2P Connection
echo.
echo   ╔═══════════════════════════════════════════╗
echo   ║       SafeBox — Starting up...            ║
echo   ╚═══════════════════════════════════════════╝
echo.


where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Please install Node.js from https://nodejs.org
    pause
    exit /b 1
)


if not exist "node_modules" (
    echo [SafeBox] Installing dependencies...
    npm install
    echo.
)


echo [SafeBox] Launching desktop app...
echo.
npx electron .

pause
