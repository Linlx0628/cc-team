@echo off
cd /d "%~dp0"

where node >nul 2>&1 || (
    echo [!] 未检测到 Node.js，请先安装 Node.js >= 18
    echo     下载地址: https://nodejs.org/
    echo.
    pause
    exit /b 1
)

if not exist config.json (
    copy config.example.json config.json >nul
    echo [OK] 已从模板创建 config.json
    echo       请编辑 config.json 填入真实配置后重新运行
    echo.
    pause
    exit /b 0
)

echo [OK] 启动 cc-team (端口 6789)...
echo.
node server.mjs
