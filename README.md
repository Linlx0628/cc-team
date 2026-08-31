# CC Team

面向 Claude Code 与 Codex 团队的 AI 编码网关。CC Team 将请求透明转发到多个兼容上游，通过虚拟 Key 管理成员访问，并提供 Token 统计、每日配额、错误记录和明亮极简的可视化工作台。

Claude Code 走 Anthropic Messages 协议（`/v1/messages`），Codex 走 OpenAI Responses 协议（`/v1/responses`）。两种协议的方案完全隔离：各自路由、各自默认组 failover，互不接管。不提供 OpenAI Chat Completions 兼容接口。

![CC Team Dashboard](docs/Introduction.png)

## 功能

- 多个 Anthropic Messages 上游同时在线，通过 URL 后缀区分方案
- Codex 透传接入：OpenAI Responses 协议（`/v1/responses`），上游需为原生 Responses 端点（如智谱 `https://open.bigmodel.cn/api/v1`）
- Responses 方案组独立 failover，与 Anthropic 方案严格隔离
- 每位成员使用独立的 `jx-` 虚拟 Key，真实上游 Key 不暴露
- 按成员、方案、模型、日期和小时统计 Token 用量（含缓存 token）
- 方案级与成员级每日配额，北京时间零点重置
- 统一的 `alias=实际模型` 模型别名配置，对 Claude Code 与 Codex 同样生效
- 模型准入、并发限制、速率限制、重试和熔断保护
- 桌面单屏 Dashboard、设置页与成员个人用量页
- Dashboard 内置用户用量、周期明细、方案中心和错误记录工作区
- 从旧版 `data.json` 预览并导入历史数据
- 创建本地备份后清空配置与请求数据

## 快速开始

### 脚本启动

```bash
git clone https://github.com/Linlx0628/cc-team.git
cd cc-team

# macOS / Linux
./start.sh

# Windows
start.bat
```

### Docker

```bash
docker pull linlx/cc-team:latest

mkdir -p cc-team-data/backups
curl -fsSL https://raw.githubusercontent.com/Linlx0628/cc-team/master/config.example.json \
  -o cc-team-data/config.json
touch cc-team-data/data.db

docker run -d \
  -p 6789:6789 \
  -v "$PWD/cc-team-data/config.json:/app/config.json" \
  -v "$PWD/cc-team-data/data.db:/app/data.db" \
  -v "$PWD/cc-team-data/backups:/app/backups" \
  --name cc-team \
  linlx/cc-team:latest
```

不要把卷直接挂载到整个 `/app`，否则会覆盖镜像内的服务程序。升级容器时保留 `cc-team-data/` 即可。

### 直接运行

```bash
cp config.example.json config.json
npm install
node server.mjs
```

打开 `http://localhost:6789/settings` 完成上游、模型和成员配置。

## 配置

```json
{
  "port": 6789,
  "dashboardPassword": "your-password",
  "profiles": {
    "glm": {
      "suffix": "glm",
      "protocol": "anthropic",
      "isDefault": true,
      "upstream": "https://open.bigmodel.cn/api/anthropic",
      "dailyTokenLimit": 2000000,
      "allowedModels": ["glm-5.1"],
      "modelAliases": {
        "jx-sonnet": "glm-5.1",
        "jx-opus": "glm-5.1",
        "jx-haiku": "glm-5.1"
      },
      "users": {
        "jx-example-user": {
          "key": "real-upstream-key",
          "disabled": false,
          "dailyTokenLimit": null
        }
      }
    },
    "glm-codex": {
      "suffix": "glmcodex",
      "protocol": "responses",
      "upstream": "https://open.bigmodel.cn/api/v1",
      "allowedModels": ["glm-5.3"],
      "modelAliases": { "gpt-5.3": "glm-5.3" },
      "users": {
        "jx-example-user": {
          "key": "real-upstream-key",
          "disabled": false,
          "dailyTokenLimit": null
        }
      }
    }
  },
  "users": {
    "jx-example-user": {
      "username": "示例成员",
      "expiresAt": null,
      "disabled": false
    }
  },
  "responsesProfileGroup": ["glm-codex"],
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

`modelAliases` 是唯一的模型映射入口。别名目标会自动加入 `allowedModels`；不需要别名时可直接使用真实模型名。

`jx-sonnet`、`jx-opus` 和 `jx-haiku` 没有特殊的独立配置入口，它们与其他别名一样统一写入 `modelAliases`。

## 接入 Claude Code

默认方案使用无后缀地址：

```bash
export ANTHROPIC_BASE_URL="http://localhost:6789"
export ANTHROPIC_API_KEY="jx-your-virtual-key"
```

指定方案时在地址中加入方案后缀：

```bash
export ANTHROPIC_BASE_URL="http://localhost:6789/glm"
export ANTHROPIC_API_KEY="jx-your-virtual-key"
```

所有方案同时在线。管理员可在设置页选择默认入口，默认方案的后缀入口仍然可用。

## 接入 Codex

Codex 使用 OpenAI Responses 协议。先在设置页创建一个接口协议为 **OpenAI Responses** 的方案，上游填原生 Responses 端点（例如智谱 GLM Coding Plan 的 `https://open.bigmodel.cn/api/v1`），并把该方案加入「Responses 方案组」。

默认入口（Responses 方案组按序 failover）：

```toml
# ~/.codex/config.toml
model_provider = "cc_team"
model = "glm-5.3"

[model_providers.cc_team]
name = "CC Team"
base_url = "http://localhost:6789/v1"
experimental_bearer_token = "jx-your-virtual-key"
wire_api = "responses"
```

指定方案时把 base_url 改为带后缀地址（`http://localhost:6789/<suffix>/v1`，如 `http://localhost:6789/glmcodex/v1`）。

说明：

- Codex 的 `Authorization: Bearer jx-...` 与 Claude Code 共用同一套虚拟 Key 与成员体系
- `/v1/models` 由网关本地合成（来自方案的允许模型与别名），不会打到上游
- 模型别名（如 `gpt-5.3=glm-5.3`）与高峰时段切换对 Codex 同样生效
- Responses 方案与 Anthropic 方案完全隔离：`/v1/messages` 永远不会落到 Responses 方案，反之亦然；交叉访问会返回明确的错误提示
- 网关对 Responses 流量做字节级透传，只在旁路解析用量（含 `cached_tokens` 缓存统计），协议正确性由上游保证

## 用户与配额

用户管理分为两层：

1. 全局用户保存虚拟 Key、名称、失效时间和禁用状态。
2. 每个方案为该虚拟 Key 分配真实上游 Key、方案禁用状态和可选个人配额。

配额优先级为：

```text
用户配额 > 方案配额 > 不限制
```

达到限额时返回 429、`type: "quota_exceeded"` 和距北京时间下一个零点的 `Retry-After`。配额、并发和速率限制产生的 429 都会进入错误记录。

删除用户会同时删除该虚拟 Key 的成员汇总、每日数据、模型与小时明细、错误和配额调整记录。

## 数据管理

数据管理是设置页中的独立全局功能，不属于当前选中的单个方案。导入时可以将旧数据来源分别映射到现有方案；清空操作作用于整个系统。

### 导入旧版 data.json

设置页的“旧数据导入”支持旧版顶层结构和 `_profiles` 多方案结构：

1. 选择文件并预览日期范围、成员数、请求数和来源方案。
2. 为每个来源方案选择目标方案或明确跳过。
3. 选择“合并现有数据”或“替换全部请求数据”。
4. 替换模式需要再次输入后台密码。

合并模式使用文件 SHA-256 指纹防止重复导入。所有写入都在 SQLite 事务中完成；替换模式会先备份数据库。

### 清空全部数据

危险操作区要求输入后台密码。执行前会将 `config.json` 和 SQLite 复制到 Git 忽略的 `backups/`，然后清除全系统的方案、成员、密钥、配额、统计、错误和导入记录。端口、后台密码和代理参数保留，服务进入可继续访问设置页的未配置状态。

## 从旧版本升级

- 旧 `defaultModels` 会迁移为普通 `modelAliases`；已经存在的同名 `modelAliases` 优先。
- `apiProtocol`、`openaiStreamUsage` 和 `responsesAdapter` 等旧协议字段会被移除。
- 旧 OpenAI 协议方案（`apiProtocol: "openai"`，Chat Completions 时代）不再受支持，升级时会先在 `backups/` 中备份 `config.json` 和 SQLite，再删除这些方案及其关联统计数据。新的 Responses 支持使用独立的 `protocol` 字段，与旧字段无关。
- 所有既有方案会自动补上 `protocol: "anthropic"` 字段；`responsesProfileGroup` 初始化为空。
- 如果仍需保留旧 OpenAI 方案，请在升级前备份整个数据目录，并继续使用支持该协议的旧版本。

## 页面

| 页面 | 地址 | 说明 |
| --- | --- | --- |
| 管理面板 | `http://localhost:6789/dashboard` | 单屏查看指标、图表、用户、周期明细、方案和错误 |
| 设置 | `http://localhost:6789/settings` | 方案、成员、配额与独立的全局数据管理 |
| 个人用量 | `http://localhost:6789/usage/虚拟Key` | 指定成员的用量页面 |
| Key 查询 | `http://localhost:6789/my-usage` | 输入虚拟 Key 查询 |
| 健康检查 | `http://localhost:6789/health` | 服务与熔断状态 |

## 主要接口

Anthropic Messages 代理使用虚拟 Key 鉴权。管理类写入接口除登录外，均要求管理员会话和 CSRF 校验。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/v1/messages` | POST | 默认方案的 Anthropic Messages 代理 |
| `/:suffix/v1/messages` | POST | 指定方案的 Anthropic Messages 代理 |
| `/v1/responses` | POST | Responses 方案组的 OpenAI Responses 代理（Codex 入口，组内 failover） |
| `/:suffix/v1/responses` | POST | 指定 Responses 方案的代理 |
| `/v1/models`、`/:suffix/v1/models` | GET | 本地合成的模型列表（Responses 池，需虚拟 Key） |
| `/api/stats` | GET | 团队统计 |
| `/api/my-usage` | GET | Bearer Key 对应的个人统计 |
| `/api/settings` | GET / POST | 读取或更新设置 |
| `/api/settings-save` | POST | 保存设置页表单 |
| `/api/profile/save` | POST | 创建方案 |
| `/api/profile/default` | POST | 设置方案组默认入口 |
| `/api/profile/delete` | POST | 删除方案 |
| `/api/global-user/save` | POST | 保存用户与方案分配 |
| `/api/global-user/delete` | POST | 删除用户及其可识别历史 |
| `/api/data-import/preview` | POST | 预览旧数据与方案映射 |
| `/api/data-import/apply` | POST | 合并或替换导入 |
| `/api/data-clear` | POST | 验证密码并清空全部数据 |

`/v1/chat/completions` 和 `GET /v1/responses/{id}` 会明确返回不支持，不会转发到上游。

## 数据文件

- `config.json`：方案、成员、Key、配额和代理配置
- `data.db`：SQLite 统计、错误、配额历史和导入指纹
- `backups/`：破坏性迁移、替换导入和数据清空前的本地备份

运行中的旧版 `data.json` 可通过设置页导入。首次启动且 SQLite 为空时，服务也会自动迁移同目录下的旧文件并将其重命名为 `data.json.migrated`。

## 技术栈

- Node.js HTTP/HTTPS 服务
- better-sqlite3
- Chart.js 4.4

## License

MIT
