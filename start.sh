#!/bin/bash
set -e

cd "$(dirname "$0")"

if ! command -v node &> /dev/null; then
    echo "⚠  未检测到 Node.js，请先安装 Node.js >= 18"
    echo ""
    echo "  macOS:  brew install node"
    echo "  Ubuntu: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
    echo "  Windows: 请访问 https://nodejs.org/ 下载安装"
    echo ""
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "⚠  Node.js 版本过低 (当前 v$NODE_VERSION)，需要 >= 18"
    exit 1
fi

if [ ! -f config.json ]; then
    cp config.example.json config.json
    echo "✓ 已从模板创建 config.json"
    echo "  请编辑 config.json 填入真实配置后重新运行"
    echo ""
    exit 0
fi

echo "▶ 启动 cc-team (端口 6789)..."
echo ""
exec node server.mjs
