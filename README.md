# Team AI Coding Token Monitor

团队 AI Coding 代理网关 + Token 用量监控面板。

透明代理请求到多个上游 AI API，记录每个成员的 token 消耗量，提供可视化监控页面和热加载配置管理。

## 功能

- **透明代理**：请求/响应原样透传，零影响 LLM 上下文和输出质量
- **多方案切换**：GLM、阿里云 Token Plan、DeepSeek 等多上游配置，一键热切换
- **虚拟 Key 映射**：多人共享同一上游账号，各自使用独立虚拟 Key，用量分人统计
- **模型准入**：按方案限制可用模型，防止误用不支持模型
- **Token 统计**：按人、按日、按模型、按小时记录 token 消耗
- **Dashboard**：Chart.js 可视化图表（趋势、分布、24小时热力），自动刷新
- **错误记录**：上报错误实时记录，分页查看
- **熔断保护**：连续失败自动熔断，上游恢复后半开探测，无需重启
- **限流控制**：每用户最大并发 + 每分钟速率限制
- **登录鉴权**：Dashboard 和设置页面密码保护
- **热加载**：Web 页面修改全部设置，即时生效，无需重启服务

## 快速开始

### 1. 配置

```bash
cp config.example.json config.json
```

编辑 `config.json`：

```json
{
  "port": 6789,
  "dashboardPassword": "your-password",
  "activeProfile": "glm",
  "profiles": {
    "glm": {
      "upstream": "https://open.bigmodel.cn/api/anthropic",
      "allowedModels": null,
      "users": {
        "user-api-key-1": {
          "username": "张三",
          "key": "user-api-key-1"
        }
      }
    }
  },
  "proxy": {
    "timeout": 180000,
    "streamTimeout": 600000,
    "maxRetries": 3,
    "retryDelay": 1000,
    "retryableStatusCodes": [429, 502, 503, 504],
    "maxConcurrentPerUser": 5,
    "rateLimitPerMinute": 60,
    "circuitBreakerFailures": 5,
    "circuitBreakerCooldown": 30000
  }
}
```

### 2. 启动

```bash
node server.mjs
```

### 3. 访问

- Dashboard: `http://localhost:6789/dashboard`
- 设置页面: `http://localhost:6789/settings`
- 健康检查: `http://localhost:6789/health`

### 4. 配置 Claude Code

```bash
export ANTHROPIC_BASE_URL="http://localhost:6789/v1"
export ANTHROPIC_API_KEY="your-virtual-key"
```

Claude Code 的所有请求会经过代理，按人统计用量。

## 方案说明

### GLM 模式（一人一Key）

每人拥有独立的智谱 API Key，虚拟 Key = 真实 Key。

```json
"glm": {
  "upstream": "https://open.bigmodel.cn/api/anthropic",
  "users": {
    "each-user-real-key": { "username": "张三", "key": "each-user-real-key" }
  }
}
```

### 共享模式（多虚拟Key → 同一真实Key）

多人共享同一上游账号，各自使用虚拟 Key，代理自动映射到真实 Key。

```json
"aliyun": {
  "upstream": "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
  "users": {
    "user-vk-1": { "username": "张三", "key": "sk-shared-real-key" },
    "user-vk-2": { "username": "李四", "key": "sk-shared-real-key" }
  }
}
```

### 模型准入

`allowedModels` 限制上游可用模型。列表内的模型才放行，不在的一律 403。

```json
"allowedModels": ["deepseek-v4-pro", "deepseek-v4-flash"]
```

`null` 或 `["*"]` 表示不限制。

## API 端点

| 端点 | 说明 |
|------|------|
| `/v1/*` | 代理转发至上游 |
| `/dashboard` | 监控面板（需登录） |
| `/settings` | 设置页面（需登录） |
| `/health` | 健康检查（无需登录） |
| `/api/stats` | JSON 统计数据 |
| `/api/settings` | JSON 当前设置 |
| `/api/profile/switch` | 切换方案 |
| `/api/profile/save` | 另存为新方案 |
| `/api/profile/delete` | 删除方案 |
| `/api/clear-errors` | 清除错误记录 |
| `/api/circuit-breaker-reset` | 重置熔断器 |

## 数据存储

- `config.json` — 方案和设置，通过 Web 页面修改
- `data.json` — token 用量统计数据，30 秒自动落盘，关机时写入

## 代理透明度

代理对请求/响应不做任何内容修改：

- 请求 body（messages、system prompt、参数）原样透传
- 响应 body（JSON / SSE 流）逐字节转发
- 只替换 `Authorization` header 实现 Key 映射
- 本地处理延迟 < 1ms

LLM 收到的内容和原生直连完全一致，不影响回复质量和上下文。

## 技术栈

- Node.js 内置模块（http、https、fs），零外部依赖
- Chart.js 4.4（CDN 引入，仅 Dashboard 页面）

## License

MIT