@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ═══════════════════════════════════
echo   CC-TEAM  团队 AI 编码用量网关
echo ═══════════════════════════════════
echo.

:: ── Step 1: Check / Install Node.js ──
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] 未检测到 Node.js，正在自动安装...
    echo.

    :: Try winget first
    where winget >nul 2>&1
    if %errorlevel% equ 0 (
        echo   使用 winget 安装 Node.js 20...
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    ) else (
        :: Fallback: download with PowerShell
        echo   下载 Node.js 安装包...
        powershell -Command "& {Invoke-WebRequest -Uri 'https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi' -OutFile '%TEMP%\node-install.msi'}"
        if exist "%TEMP%\node-install.msi" (
            echo   正在安装 Node.js...
            msiexec /i "%TEMP%\node-install.msi" /qn
            del "%TEMP%\node-install.msi" >nul 2>&1
        ) else (
            echo [X] 自动安装失败，请手动安装:
            echo     https://nodejs.org/
            pause
            exit /b 1
        )
    )

    :: Refresh PATH after install
    set "PATH=%ProgramFiles%\nodejs;%PATH%"

    where node >nul 2>&1
    if %errorlevel% neq 0 (
        echo [X] Node.js 安装失败，请手动安装后重试
        echo     https://nodejs.org/
        pause
        exit /b 1
    )
    echo [OK] Node.js 安装成功
    echo.
)

for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do (
    set "v=%%v"
    set "v=!v:v=!"
)
if !v! lss 18 (
    echo [X] Node.js 版本过低 (当前版本不满足)，需要 ^>= 18
    pause
    exit /b 1
)
for /f "delims=" %%i in ('node -v') do echo [OK] Node.js %%i

:: ── Step 2: Config ──
if not exist config.json (
    copy config.example.json config.json >nul
    echo [OK] 已创建 config.json
    echo.
    echo ───────────────────────────────────
    echo   首次运行，需要配置以下内容：
    echo ───────────────────────────────────
    echo.
    echo   1. 打开配置文件：
    echo      notepad config.json
    echo.
    echo   2. 必填项：
    echo      port              - 服务端口（默认 6789）
    echo      dashboardPassword - 管理面板密码
    echo      activeProfile     - 当前使用的方案名
    echo.
    echo   3. 配置上游（profiles 下面添加）：
    echo      upstream    - AI 厂商 API 地址
    echo      allowedModels - 允许的模型列表
    echo      defaultModels - 模型别名映射
    echo.
    echo   4. 添加用户（启动后在 Web 管理页面添加更方便）
    echo.
    echo   也可以启动后在 http://localhost:6789/settings 页面配置
    echo.
    echo ───────────────────────────────────
    echo.
    set /p "edit=现在编辑配置文件？(y/n): "
    if /i "!edit!"=="y" (
        start notepad config.json
        echo.
        echo [!] 编辑完成后保存，然后重新运行此脚本
        pause
        exit /b 0
    ) else (
        echo [!] 请稍后编辑 config.json 后重新运行此脚本
        pause
        exit /b 0
    )
)

:: ── Step 3: Start ──
echo [OK] 配置就绪
echo.
echo   [OK] 启动 CC-TEAM
echo   面板: http://localhost:6789/dashboard
echo   设置: http://localhost:6789/settings
echo.
echo ─────────────────────────────────────
echo.

node server.mjs
