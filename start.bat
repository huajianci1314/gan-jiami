@echo off
REM VipSongs 本地音乐解锁 - Windows 一键启动
REM 前提：已安装 Node.js；QQ音乐已登录运行（用于自动获取 ekey）
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org
  pause
  exit /b 1
)

echo 正在启动 VipSongs 本地服务...
start "VipSongsUnlock" cmd /c "title VipSongs 本地音乐解锁 & node server.js & echo. & echo 服务已停止，按任意键关闭 & pause>nul"

REM 等待服务就绪后自动打开浏览器
timeout /t 2 /nobreak >nul
start "" http://localhost:8787
echo 浏览器已打开：http://localhost:8787
echo 首次使用请保持 QQ音乐 客户端登录运行，即可自动获取 ekey。
pause