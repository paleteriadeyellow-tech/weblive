@echo off
chcp 65001 >nul 2>nul
title Livecoins - Panel TikTok
cd /d "%~dp0"

echo.
echo  ========================================
echo    Livecoins  -  Panel estilo TikFinity
echo  ========================================
echo.

REM --- Buscar Node.js (el doble clic a veces no tiene Node en el PATH) ---
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE=%ProgramFiles%\nodejs\node.exe"
  ) else if exist "%LocalAppData%\Programs\node\node.exe" (
    set "NODE=%LocalAppData%\Programs\node\node.exe"
  )
)

"%NODE%" --version >nul 2>nul
if errorlevel 1 (
  echo  [ERROR] No se encontro Node.js.
  echo  Instalalo desde https://nodejs.org  ^(version LTS^)
  echo.
  pause
  exit /b 1
)

echo  Node.js OK:
"%NODE%" --version
echo.

REM --- Dependencias (solo la primera vez) ---
if not exist "node_modules\" (
  echo  Primera vez: instalando dependencias...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  [ERROR] Fallo la instalacion.
    pause
    exit /b 1
  )
  echo.
)

set PORT=3000

REM --- Liberar puerto 3000 si quedo colgado (PowerShell, sin errores en espanol) ---
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }" >nul 2>nul

echo  Iniciando servidor en puerto %PORT%...
echo  Panel:   http://localhost:%PORT%
echo  Overlay: http://localhost:%PORT%/overlay.html
echo.
echo  (Deja esta ventana abierta. Para cerrar el servidor: Ctrl+C o cierra la ventana)
echo.

REM Abrir navegador a los 3 segundos
start "" /min cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:%PORT%"

"%NODE%" server.js

echo.
echo  El servidor se detuvo.
pause
