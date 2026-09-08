@echo off
chcp 65001 >nul 2>&1
setlocal
title 淦！加密 - 本地解锁服务

rem 切到脚本所在目录，路径含空格或中文也能正常工作
cd /d "%~dp0."

set "PORTBASE=8787"
set "PORT=8787"
set "PORTMAX=8796"
set "PORTFAIL=0"
set "PORTCHANGED=0"
set "CHOICE_RC="
set "NOBROWSER=0"
if /I "%~1"=="/nobrowser" set "NOBROWSER=1"
if /I "%~1"=="--no-browser" set "NOBROWSER=1"

echo.
echo   ==========================================================
echo     淦！加密   本地音乐解锁服务
echo   ==========================================================
echo.
echo   [1/4] 检查运行环境

if not exist "server.js" (
  echo   [错误] 当前目录下找不到 server.js
  echo   当前目录：%CD%
  echo   请把 start.bat 放在项目根目录后再运行。
  echo.
  pause
  exit /b 1
)

rem 依次在 PATH、常见安装目录、托管目录中定位 node.exe
set "NODE_EXE="
where /q node
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Program Files\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE (
  for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if not defined NODE_EXE if exist "%%d\node.exe" set "NODE_EXE=%%d\node.exe"
  )
)
if not defined NODE_EXE goto :nonode

set "NODE_VER=unknown"
for /f "delims=" %%v in ('"%NODE_EXE%" -v 2^>nul') do set "NODE_VER=%%v"
echo   Node.js  %NODE_VER%
echo   目录    %CD%

echo.
echo   [2/4] 选择端口
call :pickport
if "%PORTFAIL%"=="1" goto :noport

if "%PORTCHANGED%"=="1" (
  echo.
  echo   提示：%PORTBASE% 已在监听，可能上一次启动的服务还没关闭。
  choice /c YN /n /t 15 /d Y /m "  仍要再启动一个实例吗？[Y 继续 / N 打开已有页面并退出] "
  set "CHOICE_RC=%ERRORLEVEL%"
)
rem CHOICE_RC 必须在括号外读取，块内 set 的值在块内取不到
if "%CHOICE_RC%"=="2" goto :openexisting
echo   端口    %PORT%

echo.
echo   [3/4] 启动服务
if "%NOBROWSER%"=="1" (
  echo   已按参数跳过自动打开浏览器
) else (
  start "" /MIN powershell -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:%PORT%/'"
  echo   3 秒后自动打开浏览器
)

echo.
echo   [4/4] 服务运行中
echo   地址    http://localhost:%PORT%
echo   停止    按 Ctrl+C，或直接关闭本窗口
echo.
echo   ----------------------------------------------------------
"%NODE_EXE%" server.js
set "RC=%ERRORLEVEL%"
echo   ----------------------------------------------------------
echo.
echo   服务已停止（退出码 %RC%）。
if not "%RC%"=="0" (
  echo   常见原因：端口被占用、server.js 有语法错误、Node 版本低于 16。
)
echo.
pause
exit /b 0

rem 从 %PORTBASE% 起找一个未被监听的端口
:pickport
netstat -ano | findstr /C:":%PORT% " | findstr /I "LISTENING" >nul 2>&1
if errorlevel 1 goto :eof
set "PORTCHANGED=1"
set /A PORT+=1
if %PORT% GTR %PORTMAX% set "PORTFAIL=1"
if "%PORTFAIL%"=="1" goto :eof
goto :pickport

:nonode
echo   [错误] 未找到 Node.js
echo   请到 https://nodejs.org 下载安装 LTS 版本后重试。
echo   若已安装仍报此错，请把 node.exe 所在目录加进 PATH 环境变量。
echo.
pause
exit /b 1

:noport
echo   [错误] %PORTBASE% 到 %PORTMAX% 端口全部被占用，无法启动。
echo   可先关闭占用端口的程序，或编辑 start.bat 顶部的 PORTBASE 换成别的端口。
echo.
pause
exit /b 1

:openexisting
start "" "http://localhost:%PORTBASE%/"
echo   已在浏览器打开 http://localhost:%PORTBASE%/
echo.
pause
exit /b 0
