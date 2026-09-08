# 设置工作目录为脚本所在目录
Set-Location $PSScriptRoot

Write-Host "正在检查 Node.js 环境..." -ForegroundColor Cyan

# 检查 npm 是否存在
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "[错误] 未找到 npm，请确保已安装 Node.js 并配置了环境变量" -ForegroundColor Red
    Read-Host "按回车键退出"
    exit
}

Write-Host "正在启动本地服务..." -ForegroundColor Green

# 开启一个新的 CMD 窗口运行 npm start，保持后台运行且日志可见
Start-Process cmd -ArgumentList "/k", "npm start"

# 等待服务启动
Write-Host "等待服务就绪 (3秒)..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

# 自动打开默认浏览器
Start-Process "http://localhost:8787"
Write-Host "[成功] 浏览器已自动打开：http://localhost:8787" -ForegroundColor Green
Write-Host "提示：请保留打开的 CMD 窗口以查看服务日志。" -ForegroundColor Gray

# 提示用户
Read-Host "按回车键可关闭此启动窗口（服务将保持运行）"