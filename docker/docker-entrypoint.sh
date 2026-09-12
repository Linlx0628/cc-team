#!/bin/sh
set -e

# Auto-generate config.json from template if mounted volume is empty
if [ ! -f /app/config.json ]; then
    echo "⚠  未检测到 config.json，从模板自动生成..."
    echo "   请编辑 config.json 后重启容器"
    echo ""
    cp /app/config.example.json /app/config.json
fi

if [ ! -f /app/data.json ]; then
    echo '{}' > /app/data.json
fi

exec "$@"
