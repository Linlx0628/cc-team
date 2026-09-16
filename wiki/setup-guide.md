# 接入配置（Claude Code / Codex）

成员把客户端指向 CC Team 网关的三种方式。入口在「我的用量」页的「配置 Claude Code」/「配置 Codex」分区，或管理员直接发 `/setup/<虚拟Key>` 页面（Codex 接入配置页）。

接入需要两个信息：

- **服务地址**：CC Team 服务器地址，配置页会自动取当前页面的 host，可手改
- **虚拟 Key**：管理员发的 `jx-xxxx`

## 方式一：一键脚本（推荐）

配置页提供两个平台的脚本：

- **macOS / Linux**：`curl` 脚本
- **Windows**：PowerShell 脚本

复制到终端执行即可。脚本行为（两个协议的脚本一致）：

- **幂等**：可重复执行，重复跑不会叠加配置
- **自动备份**：改动前备份原配置文件
- **只动 ccteam 相关配置**：不碰你原有的其他配置项
- **写前校验失败自动回滚**：写坏即还原，不会留下半残配置

脚本也可通过接口直接获取：`/api/claude-setup/:虚拟Key`、`/api/claude-setup-win/:虚拟Key`（Claude Code），`/api/codex-setup/:虚拟Key`（Codex）。

## 方式二：手动配置

配置页展示完整的配置片段，复制粘贴：

- **Claude Code**：`~/.claude/settings.json` 的 `env` 片段（`ANTHROPIC_BASE_URL` 指向网关、`ANTHROPIC_AUTH_TOKEN` 填虚拟 Key、模型名用网关别名），配置页同时列出该方案可用的模型别名
- **Codex**：`config.toml` + `models.json`，同样以虚拟 Key 鉴权、模型名用别名

> 提示：Claude Code 对 `settings.json` 里 `env` 的 `ANTHROPIC_BASE_URL` 是认的；如果发现不生效，检查是否有其他配置层（如 `--settings` 参数）覆盖了它。

## 方式三：cc-switch 一键导入

装了 [cc-switch](https://github.com/farion1231/cc-switch) 的话，配置页提供**一键导入深链**：点击后 cc-switch 自动把 CC Team 的配置作为一个供应商导入，之后在 cc-switch 里切换即可。Claude Code 与 Codex 都支持。

## 接入之后

- 用 `claude` 或 `codex` 正常干活，用量自动进统计
- 打开 `/usage/<你的虚拟Key>` 看配额与用量，**每日签到**领额度
- 选模型时看「[配额价目表](my-usage.md#配额价目表)」，便宜排前面
- 遇到 429 看 [FAQ](faq.md)
