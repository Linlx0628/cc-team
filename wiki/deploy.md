# 部署与运维

## 部署方式（三选一）

### 1. 脚本启动

`start.sh`（macOS / Linux）或 `start.bat`（Windows）：自动安装 Node 20、`npm install` 并启动。适合最快跑起来。

### 2. Docker

```bash
docker compose -f docker/docker-compose.yml up -d
```

- 镜像基于 `node:20-alpine`（含编译工具，用于 better-sqlite3 原生模块）
- **挂载契约**（`docker/docker-compose.yml`）：
  - `../config.json:/app/config.json` — 配置
  - `../data.db:/app/data.db` — 数据库
  - `../wiki:/app/wiki:ro` — 使用手册（改 wiki 文档重启容器即生效，无需重建镜像）
  - **不要挂载整个 `/app`**；`data.json` 挂载已刻意移除（详见 compose 内注释）
- 首次启动没有 `config.json` 时，entrypoint 会从 `config.example.json` 模板自动生成
- 破坏性操作（如清空数据）前系统会自动备份到 `backups/`，把宿主机的 `backups/` 目录也照顾好

### 3. 直接运行

```bash
cp config.example.json config.json   # 改好 dashboardPassword 等配置
npm install
node server.mjs
```

默认端口 **6789**。

## 代码评审功能的系统依赖（可选功能）

「代码评审」功能需要宿主机/容器里有：

| 依赖 | 版本要求 | 安装 | 说明 |
|---|---|---|---|
| `git` | ≥ 2.41 | `apk add git` / `apt install git` | 系统用它 clone/fetch 仓库 |
| `@alibaba-group/open-code-review`（`ocr`） | 见 `ocr version` | `npm i -g @alibaba-group/open-code-review` | 评审引擎；**网关不会自动安装**，未装时功能显示「未安装」与安装指引 |
| `openssh-client` | — | `apk add openssh-client` | 仅当用 SSH 方式拉私有仓库时需要 |

容器化部署（`docker/docker-compose.yml`）已经把工作区挂成**命名卷** `code-review-workspaces`（对应容器内 `/app/code-review-workspaces`）——不挂也能跑，只是每次重建容器都要重新 clone 仓库：

```bash
docker volume rm token-monitor_code-review-workspaces   # 想彻底清空工作区时
```

⚠️ 用 `local` 来源的仓库时，**填的是容器内的路径**，需要你另外把该目录挂进容器；跨容器用 `remote` 来源更省事。

**实测结论（2026-09-19，macOS + open-code-review v1.12.3）**——这些直接决定网关怎么调用它：

- **HOME 隔离成立**：以 `HOME=<工作区>/ocr-home` 运行时，`ocr config set` 与运行都只读写 `<HOME>/.opencodereview/`，宿主机 `~/.opencodereview/config.json` 的 hash 与 mtime 分毫未变 → 网关可以把自己的 provider 配置写进隔离目录，不碰管理员在宿主机上的全局配置
- **自定义 provider 的 `url` 是 API base**：配 `url = http://127.0.0.1:<port>/v1` + `protocol = anthropic` 时，OCR 实际 POST 到 **`<url>/messages`**（即 `/v1/messages`），鉴权头为 `Authorization: Bearer <api_key>`，请求体为标准 Anthropic 形状（`max_tokens/messages/model/system/tools`）→ 直接指向本网关即可，评审消耗自然计入配额与用量
- **`--exclude` 是逗号分隔的单值**（`--exclude "a,b"`），不是重复传参
- **`--timeout` 是「每子任务」分钟数**（默认 15），不是总时长 → 网关侧另有独立的进程级硬超时
- **`--max-tokens-budget`**：`0` = 不限；超预算时已完成的局部结果仍会发布且**退出码 0**，只有全部子任务失败才非零
- **失败也会产出 JSON**：`status: "failed"` 且照常带 `summary` token 统计，退出码 1 → 以 JSON 里的 `status` 为准，退出码只作参考

## Webhook 自动评审的网络要求

代码评审支持 GitLab / GitHub / Gitee 的 push 回调自动触发(见[代码评审](code-review.md#webhook-自动评审push-即评审))。前提是**托管平台那台机器能访问到网关的回调地址**:

- 裸机部署:填网关的局域网地址,如 `http://192.168.x.x:6789/api/code-review/webhook`
- 容器部署:端口映射过就填宿主机地址;**别填 127.0.0.1**(那是容器自己)
- 走 nginx 反代的 https:回调地址用反代域名;自签证书时在平台侧关闭该 webhook 的 SSL 校验
- 平台的「测试/Test」按钮返回 2xx 即通(非 push 事件也会返回 2xx 忽略,不会标红)

## config.json 字段参考

| 字段 | 说明 |
|---|---|
| `port` | 监听端口，默认 6789 |
| `dashboardPassword` | 管理面板登录密码 |
| `profiles` | 方案列表（建议在设置页里图形化维护，不手改） |
| `users` | 用户列表（同上） |
| `defaultProfileGroup` / `responsesProfileGroup` | Anthropic / OpenAI 的基础方案组（有序名单） |
| `scheduleGroups` / `scheduleRules` / `scheduleOverride` | 方案组调度的组、时间规则、手动指定 |
| `checkIn` | 签到开关与奖励参数 |
| `quotaRequest` | 加量申请开关与参数 |
| `autoQuotaAdjust` | 自动配额调整（周期 / 命中率阈值 / 冷却） |
| `productionTracking` | 产出质量追踪（含文件路径记录开关） |
| `codeReview` | 代码评审（仓库白名单 / 方案 / 账号 / 定时 / 预算；建议在设置页里维护，凭据在这个字段里明文存放） |
| `notifier` | 通知渠道（飞书 / 钉钉 / 企微 / Server酱 / Bark） |
| `proxy` | 超时 / 重试 / 并发 / 限速 / 熔断 / 粘性会话 TTL 等 |

> 大部分配置在 `/settings` 页面里改即可，服务会写回 `config.json`；手改文件后重启生效。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CODE_REVIEW_TICK_MS` | `60000` | 代码评审调度扫描周期（毫秒，下限 50）；调小只影响到期判定的灵敏度，不改变「同一仓库串行」与「一天只跑一次」的语义 |

监听端口来自 `config.json` 的 `port`（默认 6789），没有环境变量覆盖。

## 数据文件

| 文件/目录 | 内容 |
|---|---|
| `config.json` | 全部配置（设置页写回） |
| `data.db`（+shm/wal） | SQLite：统计、错误记录、审计日志、配额历史 |
| `backups/` | 破坏性操作与数据迁移前的自动备份 |
| `code-review-workspaces/` | 代码评审的工作区：拉下来的仓库副本 + OCR 隔离 HOME（派生数据，可随时删，已在 `.gitignore`） |
| `logs/` | 请求日志 `requests-YYYY-MM-DD.jsonl`（保留 30 天，不记对话内容） |

## 健康检查

`GET /health` 返回服务状态与各方案熔断状态的 JSON，适合接监控探针。

## 反向代理注意（WebSocket 透传）

Codex 的 remote compact 走 WebSocket（`wss://…/v1/responses`）。若网关前面有 nginx 等反向代理，必须为该路径透传 upgrade 头，否则 compact 会报 404：

```nginx
location /v1/responses {
    proxy_pass http://127.0.0.1:6789;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;   # 压缩是长连接,给足读超时
}
```

## 升级与维护

- **升级**：拉新代码后按原部署方式重启；启动时自动做数据库结构迁移（迁移前备份）
- **备份**：重点照顾 `config.json`、`data.db`、`backups/` 三个位置
- **统计数据膨胀**：系统自动修剪 400 天前的统计与 30 天前的请求日志（见[后台自动化](automation.md)），也可在设置页「统计数据清理」手动处理
