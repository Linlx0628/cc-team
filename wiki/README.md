# CC Team 使用手册

CC Team 是一套**团队 AI 编码网关**：一个服务同时代理 Claude Code（Anthropic 协议）与 Codex（OpenAI 协议），用「虚拟 Key」管理团队成员，提供 Token 统计、峰谷配额、方案组调度、产出质量分析与可视化工作台。

成员通过虚拟 Key 接入，真实上游 Key 永不暴露；管理员在面板上看到所有人的用量、配额与产出质量。

## 手册导航

| 你的身份 | 建议阅读路径 |
|---|---|
| 团队成员（只想用起来） | [快速上手](quick-start.md) → [接入配置](setup-guide.md) → [我的用量页](my-usage.md) |
| 管理员（部署与日常管理） | [快速上手](quick-start.md) → [核心概念](concepts.md) → [设置页](settings.md) → [用户与配额管理](users.md) |
| 想搞懂某个术语 | [核心概念与术语](concepts.md) |
| 遇到问题了 | [常见问题 FAQ](faq.md) |
| 部署 / 运维 | [部署与运维](deploy.md) |

## 全站页面索引

- [快速上手](quick-start.md) — 管理员与成员各自的第一步
- [核心概念与术语](concepts.md) — 方案、虚拟 Key、额度池、倍率……所有名词的解释
- [管理面板：顶栏与图表](dashboard.md) — `/dashboard` 的指标卡与六张图表
- [管理面板：九个工作区](dashboard-workspaces.md) — 用户用量、明细记录、产出质量等九个标签页
- [设置页：方案与全局配置](settings.md) — 方案卡片、模型别名、峰谷倍率、通知等
- [方案组调度](schedule.md) — 按星期 × 时段自动切换方案组
- [用户与配额管理](users.md) — 虚拟 Key、临时额度、加量申请审批
- [我的用量页](my-usage.md) — 成员侧的签到、日历、用量分析、排行榜
- [接入配置（Claude Code / Codex）](setup-guide.md) — 一键脚本、手动配置、cc-switch 导入
- [MCP 接入](mcp.md) — 把配额查询/签到/价目表/手册接入 Claude 的 MCP 端点
- [配额与计费机制](mechanism-quota.md) — weighted_tokens 公式、额度池判定、AUTO 调整算法、429 结构
- [代理与调度机制](mechanism-proxy.md) — 超时重试、熔断状态机、限流、failover、粘性会话、调度求值
- [指标口径参考](metrics-reference.md) — 每个数字怎么算出来的：图表口径、指标公式、告警阈值、保留期
- [后台自动化](automation.md) — 告警扫描、数据修剪、熔断回切等自动行为
- [部署与运维](deploy.md) — 脚本 / Docker 部署、config.json、数据文件
- [常见问题 FAQ](faq.md) — 429 的几种含义、倍率口径、隐私边界等

## 入口地址速查

| 页面 | 地址 |
|---|---|
| 本手册 | `/wiki/` |
| 管理面板（需登录） | `/dashboard` |
| 设置页（需登录） | `/settings` |
| 我的用量（成员） | `/my-usage` 输入虚拟 Key，或直接 `/usage/<虚拟Key>` |
| Codex 接入配置页（成员） | `/setup/<虚拟Key>` |
| 健康检查 | `/health` |
