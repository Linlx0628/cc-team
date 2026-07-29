# CC Team

面向 Claude Code 团队的 Anthropic Messages 用量网关。CC Team 将请求透明转发到多个兼容上游，通过虚拟 Key 管理成员访问，并提供 Token 统计、每日配额、错误记录和可视化面板。

![CC Team Dashboard](docs/Introduction.png)

## 功能

- 多个 Anthropic Messages 上游同时在线，通过 URL 后缀区分方案
- 每位成员使用独立的 `jx-` 虚拟 Key，真实上游 Key 不暴露
- 按成员、方案、模型、日期和小时统计 Token 用量
- 方案级与成员级每日配额，北京时间零点重置
- 统一的 `alias=实际模型` 模型别名配置
- 模型准入、并发限制、速率限制、重试和熔断保护
- 管理员 Dashboard、设置页与成员个人用量页
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

docker run -d \
  -p 6789:6789 \
  -v cc-team-config:/app \
  --name cc-team \
  linlx/cc-team:latest
```

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
    }
  },
  "users": {
    "jx-example-user": {
      "username": "示例成员",
      "expiresAt": null,
      "disabled": false
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

`modelAliases` 是唯一的模型映射入口。别名目标会自动加入 `allowedModels`；不需要别名时可直接使用真实模型名。

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

### 导入旧版 data.json

设置页的“旧数据导入”支持旧版顶层结构和 `_profiles` 多方案结构：

1. 选择文件并预览日期范围、成员数、请求数和来源方案。
2. 为每个来源方案选择目标方案或明确跳过。
3. 选择“合并现有数据”或“替换全部请求数据”。
4. 替换模式需要再次输入后台密码。

合并模式使用文件 SHA-256 指纹防止重复导入。所有写入都在 SQLite 事务中完成；替换模式会先备份数据库。

### 清空全部数据

危险操作区要求输入后台密码。执行前会将 `config.json` 和 SQLite 复制到 Git 忽略的 `backups/`，然后清除方案、成员、密钥、配额、统计、错误和导入记录。端口、后台密码和代理参数保留。

## 页面

| 页面 | 地址 | 说明 |
| --- | --- | --- |
| 管理面板 | `http://localhost:6789/dashboard` | 团队与方案用量统计 |
| 设置 | `http://localhost:6789/settings` | 方案、成员、配额和数据管理 |
| 个人用量 | `http://localhost:6789/usage/虚拟Key` | 指定成员的用量页面 |
| Key 查询 | `http://localhost:6789/my-usage` | 输入虚拟 Key 查询 |
| 健康检查 | `http://localhost:6789/health` | 服务与熔断状态 |

## 管理 API

所有写入接口都要求管理员登录和 CSRF 校验。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/v1/messages` | POST | 默认方案的 Anthropic Messages 代理 |
| `/:suffix/v1/messages` | POST | 指定方案的 Anthropic Messages 代理 |
| `/api/stats` | GET | 团队统计 |
| `/api/my-usage` | GET | Bearer Key 对应的个人统计 |
| `/api/settings` | GET / POST | 读取或更新设置 |
| `/api/profile/save` | POST | 创建方案 |
| `/api/profile/default` | POST | 设置默认方案 |
| `/api/profile/delete` | POST | 删除方案 |
| `/api/global-user/save` | POST | 保存用户与方案分配 |
| `/api/global-user/delete` | POST | 删除用户及其可识别历史 |
| `/api/data-import/preview` | POST | 预览旧数据与方案映射 |
| `/api/data-import/apply` | POST | 合并或替换导入 |
| `/api/data-clear` | POST | 验证密码并清空全部数据 |

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
