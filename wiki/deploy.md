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
| `notifier` | 通知渠道（飞书 / 钉钉 / 企微 / Server酱 / Bark） |
| `proxy` | 超时 / 重试 / 并发 / 限速 / 熔断 / 粘性会话 TTL 等 |

> 大部分配置在 `/settings` 页面里改即可，服务会写回 `config.json`；手改文件后重启生效。

## 数据文件

| 文件/目录 | 内容 |
|---|---|
| `config.json` | 全部配置（设置页写回） |
| `data.db`（+shm/wal） | SQLite：统计、错误记录、审计日志、配额历史 |
| `backups/` | 破坏性操作与数据迁移前的自动备份 |
| `logs/` | 请求日志 `requests-YYYY-MM-DD.jsonl`（保留 30 天，不记对话内容） |

## 健康检查

`GET /health` 返回服务状态与各方案熔断状态的 JSON，适合接监控探针。

## 升级与维护

- **升级**：拉新代码后按原部署方式重启；启动时自动做数据库结构迁移（迁移前备份）
- **备份**：重点照顾 `config.json`、`data.db`、`backups/` 三个位置
- **统计数据膨胀**：系统自动修剪 400 天前的统计与 30 天前的请求日志（见[后台自动化](automation.md)），也可在设置页「统计数据清理」手动处理
