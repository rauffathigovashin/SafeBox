@echo off
chcp 65001 >nul
title SafeBox — Second Instance
echo.
echo   ╔═══════════════════════════════════════════╗
echo   ║       SafeBox — Second Instance           ║
echo   ╚═══════════════════════════════════════════╝
echo.

set SAFEBOX_MULTI_INSTANCE=true
set WEB_PORT=4847
set P2P_PORT=4848
echo [SafeBox] Launching second instance...
echo Web UI Port: %WEB_PORT%
echo P2P Port: %P2P_PORT%
echo.

npx electron .

pause
