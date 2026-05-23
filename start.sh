#!/bin/bash
set -e
cd "$(dirname "$0")"

# Colors
R='\033[0;31m' G='\033[0;32m' C='\033[0;36m' Y='\033[1;33m' D='\033[0m'

echo ""
echo -e "${C}═══════════════════════════════════${D}"
echo -e "${C}  CC-TEAM  团队 AI 编码用量网关${D}"
echo -e "${C}═══════════════════════════════════${D}"
echo ""

# ── Step 1: Check / Install Node.js ──
if ! command -v node &> /dev/null; then
    echo -e "${Y}⚠  未检测到 Node.js，正在自动安装...${D}"
    echo ""

    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v brew &> /dev/null; then
            echo -e "  使用 Homebrew 安装 Node.js 20..."
            brew install node@20
        else
            echo -e "  安装 Homebrew 后安装 Node.js..."
            /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
            brew install node@20
        fi
    elif [[ "$OSTYPE" == "linux"* ]]; then
        echo -e "  使用 NodeSource 安装 Node.js 20..."
        if command -v apt-get &> /dev/null; then
            curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
            sudo apt-get install -y nodejs
        elif command -v yum &> /dev/null; then
            curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
            sudo yum install -y nodejs
        else
            echo -e "${R}✘ 不支持的包管理器，请手动安装 Node.js >= 18${D}"
            echo -e "  访问 https://nodejs.org/ 下载安装"
            exit 1
        fi
    else
        echo -e "${R}✘ 不支持的系统，请手动安装 Node.js >= 18${D}"
        exit 1
    fi

    if ! command -v node &> /dev/null; then
        echo -e "${R}✘ Node.js 安装失败，请手动安装后重试${D}"
        exit 1
    fi
    echo -e "${G}✔ Node.js 安装成功 $(node -v)${D}"
    echo ""
fi

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "${R}✘ Node.js 版本过低 (当前 $(node -v))，需要 >= 18${D}"
    exit 1
fi
echo -e "${G}✔ Node.js $(node -v)${D}"

# ── Step 2: Config ──
if [ ! -f config.json ]; then
    cp config.example.json config.json
    echo -e "${G}✔ 已创建 config.json${D}"
    echo ""
    echo -e "${Y}───────────────────────────────────${D}"
    echo -e "${Y}  首次运行，需要配置以下内容：${D}"
    echo -e "${Y}───────────────────────────────────${D}"
    echo ""
    echo -e "  ${C}1.${D} 打开配置文件："
    echo -e "     ${D}vi config.json${D}"
    echo ""
    echo -e "  ${C}2.${D} 必填项："
    echo -e "     ${D}port${D}              → 服务端口（默认 6789）"
    echo -e "     ${D}dashboardPassword${D} → 管理面板密码"
    echo -e "     ${D}activeProfile${D}     → 当前使用的方案名"
    echo ""
    echo -e "  ${C}3.${D} 配置上游（profiles 下面添加）："
    echo -e "     ${D}upstream${D}    → AI 厂商 API 地址"
    echo -e "     ${D}allowedModels${D} → 允许的模型列表"
    echo -e "     ${D}defaultModels${D} → 模型别名映射"
    echo ""
    echo -e "  ${C}4.${D} 添加用户（启动后在 Web 管理页面添加更方便）"
    echo ""
    echo -e "  ${D}也可以启动后在 http://localhost:6789/settings 页面配置${D}"
    echo ""
    echo -e "${Y}───────────────────────────────────${D}"
    echo ""
    read -p "现在编辑配置文件？(y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        ${EDITOR:-vi} config.json
    else
        echo -e "${Y}请稍后编辑 config.json 后重新运行此脚本${D}"
        exit 0
    fi
    echo ""
fi

# ── Step 3: Start ──
PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('config.json','utf8')).port||6789)}catch(e){console.log(6789)}")

echo -e "${G}✔ 配置就绪${D}"
echo ""
echo -e "  ${C}▶ 启动 CC-TEAM${D}"
echo -e "  端口: ${D}$PORT${D}"
echo -e "  面板: ${D}http://localhost:$PORT/dashboard${D}"
echo -e "  设置: ${D}http://localhost:$PORT/settings${D}"
echo ""
echo "─────────────────────────────────────"
echo ""

exec node server.mjs
