# 上游额度 / 账户余额

本页讲的是**服务商账上还剩多少**——各平台的套餐用量窗口（5 小时 / 每周 / 每月）与账户余额。它是**只读的对账工具**，与本站自己的额度池（[配额与计费机制](mechanism-quota.md)）是两套互不影响的账：上游余额查不到、查失败或已经归零，都**不会**让本站放行或拦截任何请求，本站仍然按额度池判定配额。

## 在哪里看

| 位置 | 看什么 |
|---|---|
| 管理面板 → 左栏第 2 项「**上游额度**」 | 顶部四格概览（需要关注 / 正常 / 未配置 / 已关闭 + 更新时间），下面每个平台一张卡片：**大号数字**（余额金额或窗口已用百分比）+ 进度条 + 重置时间 |
| 设置页 → 左栏**最底部**「**上游额度**」按钮 | 二级视图：总开关与全局参数、逐平台的凭据与开关，**每一行右侧直接显示最近读到的数字** |

两处都需要后台密码登录（同管理面板）。凭据只在设置页能看/改，`/api/upstream-quota` 快照接口**不回传任何密钥**。

## 能查到什么（支持矩阵）

「官方」= 服务商文档化接口；「私有」= 控制台内部接口，社区逆向，**随时可能变**。

| 分区 | 平台 | 能查到 | 凭据 | 接口性质 |
|---|---|---|---|---|
| Plan | 智谱 GLM / GLM Coding Plan | 5 小时窗口、周窗口、MCP 每月额度、账户余额 | API Key（国内站裸 Key / 国际站 Bearer，可选组织、项目 ID） | 私有（experimental） |
| Plan | MiniMax | Token Plan 用量 | API Key | 私有（experimental） |
| Plan | Claude 订阅（Claude Code） | 5 小时 / 7 天窗口用量 | OAuth Token（`sk-ant-oat…`，不是普通 API Key） | 私有（experimental） |
| Plan | 阿里云百炼 Token Plan | **个人版**：套餐月额度已用 %、重置时间、Harness 权益用量；**席位制团队版**：席位数量、每类席位的 Credits 总量 / 剩余、逐席位（成员）剩余 | 控制台令牌（个人版，卡片页脚「一键获取令牌」；留空时自动读本机 `~/.bailian/config.json`，或给 AccessKey 加 `modelstudio:GenerateCLIAccessToken` 权限由平台自动换取 / 自动续期）+ AccessKey ID / Secret（团队版席位，可复用「阿里云账户余额」那份） | 个人版走控制台网关；团队版走官方 OpenAPI（Model Studio 2026-02-10，ACS3-HMAC-SHA256） |
| Plan | 阶跃星辰 Step Plan | **Coding Plan**：5 小时 / 每周窗口；**Token Plan（Credit）**：月度 Credit 剩余 / 总量、加油包、Credits 到期日；套餐名（Plus / Mini） | 控制台令牌（Oasis-Token，从浏览器 Cookie 复制一次） | 私有（控制台内部接口，experimental，默认关闭） |
| Plan | OpenCode Go / Go Plus | 5 小时（rolling）/ 每周 / 每月三个窗口的已用百分比与重置时间 | Go 套餐 API Key；**留空则自动读本机** `~/.local/share/opencode/auth.json` 的登录态 | 官方 `GET /zen/go/v1/usage`（2026-08-11 起） |
| 余额 | DeepSeek | 总余额（赠金 + 充值） | API Key | 官方 `GET /user/balance` |
| 余额 | 阶跃星辰 StepFun | 预付费账户可用余额 | API Key | 官方 `GET /v1/accounts`（Step Plan 套餐额度只在控制台，见上表「阶跃星辰 Step Plan」） |
| 余额 | 月之暗面 Kimi | 可用 / 代金券 / 现金余额 | API Key | 官方 `GET /v1/users/me/balance` |
| 余额 | OpenRouter | 总额度与累计消耗，差额 = 剩余 | API Key | 官方 `GET /api/v1/credits` |
| 余额 | OpenAI（组织用量） | 组织维度用量/成本（**不是剩余额度**） | Admin Key（`sk-admin-…`） | 官方 usage 接口（experimental） |
| Plan | 火山引擎方舟 | Coding Plan / Agent Plan 的 5 小时、每周、每月窗口 + 账户余额 | AK / SK（Signature V4） | 官方 OpenAPI |
| 余额 | 阿里云账户余额 | 现金/可用余额（含信控额度） | AK / SK（RPC HMAC-SHA1） | 官方 `QueryAccountBalance` |
| 余额 | 腾讯云账户余额 | 账户余额（已换算成元） | SecretId / SecretKey（TC3-HMAC-SHA256） | 官方 `DescribeAccountBalance` |
| 余额 | Sub2API（**可加多个站点**） | 钱包/订阅剩余额度；或 5 小时 / 1 天 / 7 天三个 Key 级窗口 | 站点发的 API Key（**必须选方案**，地址与密钥都由方案带出） | 站点自带 `GET /v1/usage`（开源网关） |
| 余额 | NewAPI（**可加多个站点**） | 剩余额度（`quota ÷ quota_per_unit`）、累计请求 | 控制台生成的**系统访问令牌** + 数字用户 ID | 站点管理面 `GET /api/user/self`（开源网关，one-api 衍生） |
| 余额 | 硅基流动 SiliconFlow | **可用余额**（现金 + 代金券合计）+ 每张代金券的剩余 / 面额 / 有效期（CNY） | 控制台会话令牌（`__SF_auth.session-token`）+ 账号 ID（`x-subject-id`） | 控制台 walletd 接口（`/api/v1/subject/profile` + `/api/v1/subject/wallets?stage=3`，私有 experimental）。官方 `GET /v1/user/info` **已于 2026 年初下线**（410 + code 20092），见下节 |
| Plan | 腾讯云 TokenHub Coding Plan | 5 小时 / 每周 / 每订阅月用量 | — | 官方只在控制台展示，无 API |
| Plan | 阿里云百炼 Coding Plan | 套餐用量 | — | 官方只在控制台展示；`bl` CLI 需控制台登录态（**Token Plan 走的是同一套控制台网关**，见上表） |
| Plan | 腾讯 CodeBuddy | 套餐与用量 | — | 官方只在网页展示 |

- 面板上只有两个分区：**Plan**（订阅套餐 / 套餐窗口 / 只能在控制台看的套餐）与**余额**（充值余额 / 账户余额 / 中转站钱包）。分区归属是一张显式的表（代码里的 `BUCKET_OF`），**每个平台都必须写明**——漏写会默认落到「余额」，所以测试里有一条「每个平台都要显式归属」的断言。
- **只能去控制台看的三个平台**（腾讯云 TokenHub Coding Plan、阿里云百炼 Coding Plan、腾讯 CodeBuddy）**不发任何请求**，只给一个「控制台」入口（点开在新标签里打开对方官网）。套餐额度只能人工看，或者等上游自己回 429（腾讯 TokenHub 的 `20097 hour|week|month allocated quota exceeded`、百炼的 `usage allocated quota exceeded`——这类报错会进管理面板的「错误记录」）。
- ⚠️ 「账户余额」和「套餐额度」是两笔账：腾讯/阿里的 Token Plan 扣的是套餐额度，账户余额可能在很长一段时间里都是 0；反过来账户有余额也不代表套餐没到期。

## 一张卡片怎么读

打开面板先看到**四格概览**：`需要关注`（额度告警 + 查询失败）、`查询正常`、`未配置`、`已关闭`（后两格为 0 时不留空位），最后一格是这份快照的更新时间（北京时间）。

下面是两个分区（**Plan** / **余额**）：宽屏时**左右并排**、尽量一屏看完（实测 1440px 宽的窗口下两个分区并排后不再出现滚动条）；窗口窄了自动退回上下堆叠，手机上单列。

每个平台按「有没有数字」分两种呈现：

- **有数字的平台 → 一张卡片，数字是主角**
  - 余额类：大号金额（`¥1,234.56`），下面一行是口径（如「账户余额（含赠金）」）与赠金 / 充值明细
  - 套餐类：一个窗口一行 —— 左边窗口名，右边**大号已用百分比**，下面是进度条与 `剩 6.00M / 300.00M tokens · 3 天后重置（10-17 11:45）`
  - 卡片右上角：状态徽章 + `↻`（只重查这一个平台）+ `ⓘ`（悬停显示该平台的官方口径说明，正文里不复述长文）
- **没有数字的平台 → 压成一行小字**
  - 还能查的（仅控制台那四个）直接摆出来，带「控制台」入口
  - 已关闭 / 未配置的收进分区末尾的折叠块「**其余 N 个（未配置 / 已关闭）**」，点开才占位置；展开状态记在浏览器本地，面板每 30 秒重绘也不会被弹回去

细节：

- **徽章**（优先级从上到下）：`仅控制台` > `已关闭`（平台开关关掉）> `未配置` / `查询失败` > `额度告警` > `正常`；另外失败但有缓存时**额外**挂一个 `旧数据` 黄标（此时徽章是「查询失败」，不是「正常」）
- **进度条**一律表示**已用比例**：套餐用上游给的百分比；余额用 `1 − 剩余 ÷ 总额` 反推。两者都拿不到就**不画**进度条——不会拿一条 0% 冒充正常
- **排在上面的都是要紧的**：同一分区内按「额度告警 → 查询失败 → 正常」排序，需要处理的排前面
- **同名窗口自动区分**：智谱的周窗口有 tokens 与额度两条，会显示成「每周窗口（tokens）」与「每周窗口（额度）」，不会出现两个同名标题配两个不同百分比
- **页脚**：`更新于 / 缓存于 N 分钟前`（缓存时说明数字来自上次的好数据）、凭据来源（如「自动 · DeepSeek / 张三」，只说方式**不显示密钥**）、控制台与文档链接
- 面板标题栏右侧摘要：`1 个需要关注 · 共 19 个平台 · 更新于 11:45`（有需要关注的平台时，文字前面会点一颗红点）。这里的「平台数」= 19 个内置平台 + 你自己加的中转站点（每个站点算一个，Sub2API / NewAPI 类型的空站点不算）
- 单张卡片的 `↻` 只重查这一个平台并就地替换那张卡（整面板不重排、滚动位置不跳）；标题栏「**刷新全部**」强制重查所有已开平台

## 控制台入口

卡片页脚、小字行里的「控制台」、设置页那一行的「打开控制台」，点下去都是**在新标签页打开对方官网**（浏览器原生行为，中键 / ⌘+点击同样走浏览器）。

- ⚠️ **为什么不做内嵌抽屉**：2026-10-14 逐个看过 16 个入口的安全响应头，**8 个明确拒绝被嵌**（`X-Frame-Options: DENY / SAMEORIGIN` 或 CSP `frame-ancestors`）：DeepSeek、OpenRouter、智谱 BigModel、Claude、OpenCode、OpenAI Platform、硅基流动、阿里云百炼控制台。剩下 8 个（腾讯云 TokenHub / 费用中心、腾讯 CodeBuddy、火山引擎、阿里云用户中心、阶跃星辰、月之暗面、MiniMax）技术上能嵌，但浏览器**不把第三方 Cookie 交给 iframe**，进去多半还要重新登录一次——比直接开新标签更麻烦，所以本工具不做内嵌。
- 「控制台」只对**有官方控制台地址**的平台出现；没有地址的平台（例如中转站站点）这一格会省略。

## 参数（设置页 → 上游额度 → 顶部「高级」折叠）

| UI 名称 | 字段 | 默认 | 范围 | 行为 |
|---|---|---|---|---|
| 总开关 | `upstreamQuota.enabled` | **开启** | 开 / 关 | 关掉后面板显示「已关闭」，**不再向上游发任何请求** |
| 缓存秒数 | `cacheSeconds` | **300** | 0–86400 | 同一平台在这个窗口内不重复请求（0 = 每次都真查） |
| 自动刷新 | `autoRefreshMinutes` | **0** | 0–1440 | 0 = 只在打开面板时查；>0 时后台每 60 秒检查一次、到期才真查 |
| 请求超时 | `timeoutMs` | **10000** | 1000–60000 | 单次查询的毫秒上限，超时按失败处理 |
| 告警阈值 | `alertPercent` | **90** | 1–100 | 套餐用量到该比例标黄/红 |

查询逻辑：

```text
打开面板 / 点刷新:
  if (!enabled) → 所有卡片显示「已关闭」，不请求上游
  for 每个平台 (最多 4 个并发):
    if (平台关闭)         → 「已关闭」，不发请求
    if (manualOnly)       → 「仅控制台」，不发请求
    hit = 缓存[平台]
    if (!强制刷新 且 now − hit.fetchedAt < cacheSeconds × 1000) → 直接用缓存（页脚「缓存于」）
    else 真查上游:
      成功 → 覆盖缓存，页脚「更新于」；只要有额度项进了告警就挂「额度告警」
      失败 → 有旧数据：显示旧数据 + 「旧数据」黄标 + 失败原因（徽章变「查询失败」）
             无旧数据：只显示失败原因
```

告警判定：

```text
余额类: alarm = (剩余 ≤ 0)
套餐类: alarm = (percent ≥ alertPercent)
黄色预警: percent ≥ max(0, alertPercent − 15)

套餐内使用（余额 0 不算告警）:
  平台既有套餐窗口、又有余额时，若「所有套餐窗口都没到 alertPercent」
    → 余额 ≤ 0 只算说明：卡片上余额数字转灰，并注明「套餐内使用，余额不参与告警」，不进「需要关注」
  若套餐窗口自己就打满了（或平台压根没有套餐窗口，纯余额型）
    → 余额 ≤ 0 照旧告警
```

**数字示例**（默认 `alertPercent = 90`）：

- 火山 Coding Plan 周窗口 92% → 红（「额度告警」）；88% → 黄；60% → 正常
- DeepSeek 余额 `¥12.34` → 正常；`¥0` → 红
- 智谱 Coding Plan：5 小时窗口 0% + 每周窗口 2% + 账户余额 `¥0.00` → **正常**（订阅制平台的余额天然是 0，用量走套餐窗口）；把周窗口跑到 91% 才会挂「额度告警」
- OpenAI 中转站：纯余额平台，余额 `-0.06` → 红（「额度告警」）
- 「失败但有缓存」：先查到 GLM 周窗口 40%，5 分钟后上游抽风 → 卡片仍显示 40%，挂「旧数据」黄标并写明失败原因，徽章是「查询失败」而不是「正常」

⚠️ 注意三点：

1. **面板每 30 秒刷新的是本站快照，不是上游**——`cacheSeconds` 内点多少次刷新都只有一个真请求；要看最新值就点「刷新全部」（强制）或把「缓存秒数」调小。
2. 后台 tick 每 **60 秒**跑一次，只有 `autoRefreshMinutes > 0` 才会真查上游。所以默认配置下**本站不会主动轮询上游**，只在有人打开面板（或点刷新）时查。
3. 时间一律按**北京时间（UTC+8）**显示（`重置 MM-DD HH:mm`、页脚的「N 分钟前」）。

## 设置页怎么用（配「去问谁要数字」）

设置页左栏最底部「**上游额度**」进去后，是一个二级视图，从上到下：

1. **顶部固定操作条**：`总开关`（开 / 关）+ `保存全部` + `刷新全部` + `去面板看 →`。改动不会自动保存，点「保存全部」才落盘。
2. **每个平台一行，按 Plan / 余额 两个分区排**（和面板同一套分区，从哪里看都一致）：左边是勾选框（启用）、平台名、`实验` 标（接口未文档化时）、**这一行右侧直接显示最近读到的数字**（纯余额平台如 `¥1,234.56`；既有套餐窗口又有余额的平台如 `每周 98% · ¥380.00`——最紧的窗口排前面，需要关注时标红/标黄）和状态徽章（`正常 / 额度告警 / 查询失败 / 未配置 / 已关闭 / 仅控制台`）。**不用展开就能看出哪些平台已经通了。**
3. **点一行展开**才看到凭据设置：`凭据来源`、方案 / 成员下拉（或 API Key / AccessKey 字段），底下是「**查询一次**」——当场向上游发一次请求，结果（读到几项、具体数字）直接显示在这张行里，用来验证凭据与权限。
4. **`高级：缓存 / 自动刷新 / 超时 / 告警阈值`**（顶部）与每个平台行里的 **`高级：接入点覆盖 / 显示名`** 都是默认折叠的，不占版面。
5. 页面顶部会先渲染配置、再补上「最近读数」；读数拿不到不影响改配置，只会在状态处提示一句。**读取失败时会显示具体原因与「重试」按钮**，不会留一片空白。

## 凭据从哪来

每张平台卡片的「凭据来源」三选一：

| 来源 | 含义 | 适用 |
|---|---|---|
| **自动：复用方案里已有的密钥** | 按该平台的域名（如 `api.deepseek.com`）去匹配方案的上游地址，取这个方案里任一配了真实 Key 的成员 | 该平台已经作为方案接进本站（最省事） |
| **指定方案 / 成员** | 明确指定用哪个方案的哪个成员的 Key（下拉只列**真的配了密钥且没停用**的成员） | 一个方案里多个成员 Key 指向不同账号 |
| **手动填写 API Key** | 单独填一把 Key，与方案无关 | 平台还没接进本站，或想用一把单独的只读 Key |

云平台（火山 / 阿里云 / 腾讯云）的凭据不是 API Key，而是 **AccessKey ID / Secret**（腾讯云叫 SecretId / SecretKey）；火山还可选区域，默认 `cn-beijing`。

同一个云账号下的多个平台**共用同一组 AK/SK**（例如「阿里云账户余额」与「阿里云百炼 Token Plan」）：只要有一处填过，另一处**留空即自动复用**，卡片页脚会显示「复用「阿里云账户余额」的 AccessKey」。想用不同的子账号，把那行自己的 AK/SK 填上就会覆盖。

**中转网关（Sub2API / NewAPI）是「站点型」平台**，凭据规则与上面不同；而且这**两种类型都是「一个站点一张卡」**——同时用好几家（例如「Lemon 中转」+「可乐中转」两个 Sub2API 站），就加几条站点记录，各自用自己的地址、Key、成员：

- 设置页里这两种类型不是一行，而是**一段**：段头写着类型名，右上角有「**＋ 添加站点**」。点它插一张空卡。
- 段里每张卡右下角有「**删除这个站点**」；删除与新增都要点顶部「**保存全部**」才落盘。
- 每个站点在内部有一个稳定 id（`类型:站点key`，如 `sub2api:relay`）：缓存、单个卡片刷新、「查询一次」、告警都按站点各算各的，互不影响。
- 展开后第一格是「**方案**」下拉（Sub2API 上标签写「方案（必选）」，鼠标悬停有说明）：选中你已接进本站的中转站方案，站点地址就从它的上游地址推出来（`https://gw.example/v1` → 站点根 `https://gw.example`；`/v1`、`/anthropic`、`/apps/anthropic`、`/api/coding/v3` 这类协议尾段会被剥掉，域名后面的子路径保留）。
- **Sub2API**：**方案是必选项**，没有「凭据来源」这一项，也没有单独的「显示名」——地址与 Key（该方案的**成员**站点 Key）都从方案来，**一个方案 = 一个站点**，卡片标题就沿用**方案名**（换方案时标题跟着变，站点内部 id 也按方案后缀重算）。请求打到 `GET {站点}/v1/usage`，Key 就是方案里那把 Key，不用另外抄。
- **NewAPI**：它**没有「凭据来源」三态**，要自己填「**系统访问令牌**」（控制台「个人设置 → 生成系统访问令牌」），另外填数字**用户 ID**（会作为 `New-Api-User` 头发过去）；「显示名」留空 = 用类型名。`sk-` 开头的中转 Key 在这里**不管用**，那是模型调用用的。
- **Sub2API 必须选方案**（地址与 Key 都从方案来，想换地址就换方案或改方案的接入点）；NewAPI 可以只填「接入点覆盖」手写站点地址、不必选方案。

**OpenCode Go** 是唯一会读本机文件的平台：没填 Key 时自动读 `$XDG_DATA_HOME/opencode/auth.json`（默认 `~/.local/share/opencode/auth.json`）里 `opencode-go` 段的 key —— 机器上已经在用 opencode，就不用再手抄一遍；读到就用，读不到才算「未配置」。

每行平台卡片展开后的「**高级：接入点覆盖 / 显示名**」里还有一格「**接入点覆盖**」，默认**留空 = 官方地址**。它替换的是**域名部分**，路径仍按官方接口拼（`你填的地址` + 官方路径，自动去掉结尾多余的 `/`）。「显示名」用来把卡片标题改成你自己认得的名字（留空 = 平台原名）：

| 场景 | 怎么填 |
|---|---|
| GLM 国际站（`z.ai`）等与国内站不同域名的账号 | 填 `https://api.z.ai` |
| 自建反向代理 / 内网网关 | 填网关地址，例如 `https://gw.internal/deepseek` |
| 站点型平台（Sub2API / NewAPI） | 留空 = 用所选方案的地址；也可以在这里直接填站点根地址，例如 `https://gw.example` |

⚠️ 地址写错（多一层路径、少 `/v1`）会直接体现成卡片上的失败原因；改回留空即恢复官方地址。

### 阿里云百炼 Token Plan：两张脸（个人版 / 席位制团队版）

百炼的 Token Plan 用量分在**两套完全不同的接口**里，本平台两套都会试，按你账号是哪一种自动选：

| 你的套餐 | 数据在哪 | 要什么凭据 | 卡片上看到 |
|---|---|---|---|
| **个人版**（控制台「Token Plan → 我的订阅」显示的 Lite / Essential / Standard / Pro，一个月限额） | 百炼**控制台网关**（控制台页面自己调的接口，`zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage`；套餐本身走 `…/personal/api/v2/subscription`） | **控制台令牌** —— 卡片页脚「一键获取令牌」，见下面的获取办法 | 「套餐月额度 0.27%」+「重置 11-15」；如果套餐带 Harness 权益，还会多出几行权益用量（剩 x / 共 y）；另有一行套餐信息 `Standard · 生效中 · 到期 2027-01-15（剩 92 天）` |
| **席位制团队版**（控制台「组织与成员 → 席位管理」里给成员分配席位） | 官方 OpenAPI（`GetSubscriptionStats` / `GetSubscriptionSeatDetails`） | **AccessKey ID / Secret**（可复用「阿里云账户余额」那份） | 「标准席位 Credits」等：总量 / 剩余 / 席位占用 / 订阅到期 |

个人版各档的月限额（官方表，单位 Credits）：Lite `11,500` / Essential `25,500` / **Standard `45,000`** / Pro `180,000`。**控制台接口只给百分比**，所以我们照原样显示百分比：

```text
percent = round(per1MonthPercentage × 10000) / 100      # per1MonthPercentage 是 0–1 的比例
例：per1MonthPercentage = 0.0027 → 0.27%（= 已用 121 / 45,000 Credits，Standard 档）
重置时间 = per1MonthResetTime（毫秒时间戳）→ 按北京时间显示成「重置 11-15」
```

⚠️ 重置不是每月 1 日：额度按**订阅月**滚动（你 10-14 订阅，就每月 14 号刷新），所以看百分比旁边的重置日期，不要按自然月理解。

⚠️ 反过来不成立：**个人版用 AccessKey 查席位接口只会拿到空数据**（接口返回 `{"Success":true}`，连 `Data` 都没有）——那不是「没订阅」，而是这条路看不到个人月额度。所以个人版在设置页看到红字提示时，按下面拿一个控制台令牌就好。

**套餐到期时间**（顺带拿到，只有阿里云百炼给得出）：个人版的订阅信息走控制台另一条接口，返回的就是控制台「Standard 套餐 / 剩余 92 天 / 开始 2026-10-14 17:22:21 / 结束 2027-01-15 00:00:00」那一排数字：

```text
GET/POST 控制台网关  api = zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription
→ {"instanceCode":"sfm_tokenplansolo_public_cn-…","specCode":"standard","remainingDays":92,
   "startTime":1791969741000,"endTime":1799942400000,"autoRenewFlag":false,"status":"VALID"}
```

卡片标题下方因此会多一行小字 `Standard · 生效中 · 到期 2027-01-15（剩 92 天）`：`specCode` 首字母大写当规格名，`status` 只在不是 `VALID` 时按原值显示（`VALID` → 生效中），`autoRenewFlag` 为 `true` 时才出现「自动续费」。**这条接口拿不到数据时这一行直接不渲染**，不影响上面的额度数字；其它套餐平台（智谱 GLM、火山方舟…）的接口只给窗口重置时间、没有套餐到期字段，所以那几张卡上不会出现这一行 —— 不是漏显示。（席位制团队版走 `GetSubscriptionStats`，它的 `SubscriptionStartTime/EndTime` 也会填进这一行。）

**怎么拿控制台令牌**（只需一次，浏览器里点一下）：

1. **面板里点一下就行**（推荐）：设置页 → 上游额度 → **阿里云百炼 Token Plan** 卡片页脚点「**一键获取令牌**」→ 浏览器弹出百炼控制台的授权页（已登录就点一下授权）→ 令牌自动回填到「控制台令牌」格里，卡片随即开始读数。

   原理与官方 CLI 一样：面板生成一次性随机 `state`，把回调地址写成**你浏览器正在访问的这个面板地址**（`http://<你看到的地址>/?state=<state>`），然后打开控制台的 `/console-login` 授权页；页面把 `access_token` POST 回这个地址，面板校验 `state` 后直接写进自己的配置（**不依赖 `~/.bailian`，也不读你的浏览器数据**）。回调只认本次的 `state`（不对一律 400），会话只在内存里、10 分钟自动清掉。

   ⚠️ **这个按钮只在「浏览器地址栏是回环地址」时管用**：`http://127.0.0.1:6789` 或 `http://localhost:6789`（面板就在本机，或 `ssh -L 6789:127.0.0.1:6789` 隧道转发过来）。

   原因是控制台授权页的回调地址是**硬编码 http 的**——它的前端 bundle 里写死了 `fetch("http://".concat(notice), …)`（`https://g.alicdn.com/bailian-fe/bailian-cli-login/0.0.6/main.js`），而浏览器只对**回环地址**（`127.0.0.1` / `localhost` / `[::1]`）豁免 https 页面的混合内容拦截。所以拿 `http://<局域网IP>:6789` 甚至 `https://<域名>` 打开面板时，浏览器会**直接把这个 POST 拦在本地**：控制台那侧看起来「授权成功」，面板这侧永远停在「等待授权」→ 改用第 2 / 3 条。
   （面板现在会在按钮下方提前标红说明这一点；如果你就是想用域名访问，可以配 SSH 隧道并把「**令牌回调地址**」填成 `127.0.0.1:6789`。）
2. **面板在服务器上、又没给 RAM 权限**：在**你自己的电脑**上跑仓库里的自取脚本，它把令牌打印出来，你粘到「控制台令牌」格：

   ```bash
   node tools/bailian-console-login.mjs            # 国内站；国际站加 --intl，不想自动开浏览器加 --no-open
   ```

   它在你本机 `127.0.0.1` 开一次性回调端口（15 分钟），拿到令牌直接打印，不依赖面板、不依赖 CLI。
3. **用完就忘的自动路线**：给这把 AccessKey 对应的 RAM 用户加 `modelstudio:GenerateCLIAccessToken` 权限后，平台会用官方那条 OpenAPI **自动换一条新令牌**；令牌过期时（网关回 `NotLogined`）也会自动换一条再查一次，你基本不用再管。缺这个权限点时卡片红字会直接写明缺哪个权限点（实测默认那把子账号就是 403 `AccessDenied`）。

   ```text
   POST https://modelstudio.cn-beijing.aliyuncs.com/modelstudio/cli/generateAccessToken
        # 国际站换 modelstudio.ap-southeast-1.aliyuncs.com；ACS3-HMAC-SHA256 签名，无请求体
   → { "cliAccessToken": "<36 位左右的令牌>" }
   ```
4. **CLI 路线**：本机跑 `npx -y bailian-cli auth login --console`，令牌落到 `~/.bailian/config.json` 的 `access_token`。平台的「控制台令牌」留空时会自动读这个文件。
5. **纯手工路线**：把拿到的 `access_token`（36 位左右）粘进「**控制台令牌**」格（密码型输入框，只存在本机 `config.json`，快照接口不回传）。
6. 想换账号 / 换区域：`BAILIAN_CONFIG_DIR` 可以指定另一个配置目录；设置页的「控制台区域」默认 `cn-beijing`，海外站填 `ap-southeast-1`。
7. **「令牌回调地址」（可选）**：只在你「用域名/IP 访问面板、同时又在本地开了 SSH 隧道」时才需要 —— 填 `127.0.0.1:6789`，授权页就会把令牌送回你本机的隧道入口，而不是送回那个收不到回调的域名。留空＝用浏览器地址栏里的那个地址。

**部署在 Linux 服务器上，能用「一键获取令牌」吗？** 取决于你从哪访问面板：

| 你怎么访问面板 | 一键获取令牌 | 走哪条 |
|---|---|---|
| 浏览器开 `http://127.0.0.1:6789`（面板就在本机） | ✅ 能 | 第 1 条 |
| `ssh -L 6789:127.0.0.1:6789 user@服务器` 后浏览器开 `http://127.0.0.1:6789` | ✅ 能（回调经隧道回到你本机） | 第 1 条 |
| 浏览器开 `http://<服务器IP>:6789`（局域网 IP / 裸 HTTP） | ❌ 不行（混合内容：https 授权页 → 非回环的 http 地址被拦） | 第 2 条（自己电脑上跑脚本）或第 3 条（加 RAM 权限，最省事） |
| 浏览器开 `https://<域名>`（反向代理 + 证书） | ❌ 也不行（原因同上：授权页固定发 http，浏览器只豁免回环地址） | 同上；或配隧道 + 「令牌回调地址」= `127.0.0.1:6789` |
| 服务器上没浏览器 / 无人值守 | — | 第 3 条（配一次权限点，之后全自动） |

实测：浏览器里点一下授权就拿到令牌，接口随即返回真实数字（`per1MonthPercentage` 驱动「套餐月额度」）。

**令牌能活多久？** 官方不公开、也不落盘（CLI 源码里没有任何过期字段，只有被 `NotLogined` 打回来才知道），实测有效窗口是**小时级**：

| 时间点 | 令牌状态 |
|---|---|
| 授权后 ~40 分钟内 | ✅ 正常读数（`per1MonthPercentage` / Harness 权益都返回） |
| 约 2 小时后 | ❌ 两个接口都回 `NotLogined`（本地面板与服务器面板同时失效，说明是令牌本身过期，不是某台机器的问题） |

所以**服务器上的长期方案是第 3 条**（`modelstudio:GenerateCLIAccessToken` 权限点 → 平台自动换取/续期）；只靠手工粘贴令牌的话，一天要补好几次。

> ⚠️ 自己看这个数字的位置：控制台 → **Token Plan → 我的订阅**（国内站 `bailian.console.aliyun.com/cn-beijing/subscription/token-plan`，国际站 `modelstudio.console.alibabacloud.com/ap-southeast-1/subscription/token-plan`）。
> ⚠️ 控制台令牌按**个人账号**签发，看到的月额度就是这个账号的；它是控制台登录态，**权限比 AccessKey 大**，别再填到别处或分享出去。
> ⚠️ 令牌**是控制台登录态，会过期**（不是永久凭据，官方 CLI 也不存过期时间）：失效后网关回 `NotLogined`，界面提示「控制台令牌已失效或被拒绝」，按上面第 1 / 2 / 3 条任意一条重取即可。想彻底免手工就配第 3 条（`modelstudio:GenerateCLIAccessToken` 权限点），之后过期会自动换新。

> ⚠️ 凭据以**明文**存在 `config.json` 的 `upstreamQuota` 里（与 SMTP 密码、webhook 密钥同一套处理方式），靠设置页的密码门保护；查询结果的快照接口不回传密钥，页脚只显示**末 4 位**。给云平台配 Key 时，建议单开一个只带下述只读权限的 RAM/子账号：
> - 阿里云账户余额：`QueryAccountBalance`，RAM 权限点写作 `bss:DescribeAcccount`（注意是**双 c**）
> - 阿里云百炼 Token Plan：席位制团队版需要 `modelstudio:GetSubscriptionStats`（席位与 Credits）与 `modelstudio:GetSubscriptionSeatDetails`（逐席位明细）；**个人版不需要 RAM 权限**，只要控制台令牌（见上面「两张脸」）
> - 腾讯云：`DescribeAccountBalance`（费用中心只读）
> - 火山引擎：方舟的 `GetCodingPlanUsage` / `GetAgentPlanAFPUsage` / `GetSeatInfoUsage` 与费用中心 `QueryBalanceAcct`

⚠️ 火山官方 CLI（ark-cli 0.1.16 起）暂停了 AK/SK 登录通道，那是 **CLI 自己**的限制；本页是直连公网 OpenAPI 签名，不受影响，但仍建议先点「查询一次」确认权限点够用。

### 阶跃星辰 Step Plan：官方 API 看不到套餐，只能抄一份控制台令牌

阶跃星辰的**官方 API Key 侧没有套餐接口** —— 只有 [`GET /v1/accounts`](https://platform.stepfun.com/docs/zh/api-reference/accounts/get)（现金 / 赠金余额，就是「阶跃星辰 StepFun」那张卡的 ¥15）。实测把 Step Key 打到 `/v1/usage`、`/v1/credits`、`/v1/subscription`、`/v1/dashboard/billing/{subscription,usage}`、`/step_plan/v1/{accounts,usage,credits,subscription}` 等 10 条候选路径**全是 404**。

Step Plan 的套餐额度只在控制台，卡片读的是**网页版自己调的内部接口**（无令牌访问回 `401 auth failed: token is missing`，说明路径是活的）：

```text
POST https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit   body {}
POST https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus         body {}

header: oasis-appid: 10300 / oasis-platform: web / oasis-webid: <device_id> / content-type: application/json
cookie: Oasis-Token=<令牌>; Oasis-Webid=<device_id>
```

**为什么需要 `Oasis-Webid`**：它必须等于令牌里 `device_id` 声明（`access` 段 `...` `refresh` 段，取 refresh 段的 JWT 载荷），否则服务端回 `auth failed: oasis-token is embezzled`。粘贴整段令牌后面板会自己解出来，不用手填；「Oasis-Webid」那格只在特殊情况下（令牌里没有 `device_id`）才需要手动覆盖。

**怎么拿令牌**（浏览器里一次，30 秒）：

1. 浏览器登录 [platform.stepfun.com](https://platform.stepfun.com) → `F12` → **Application → Cookies → `https://platform.stepfun.com`**；
2. 找到 **`Oasis-Token`**，复制它的值（形如 `eyJhbGci…...eyJhbGci…`，中间是 `...`，**整段复制**，不要只复制前半段）；
3. 设置页 → 上游额度 → **阶跃星辰 Step Plan** → 「控制台令牌（Oasis-Token）」粘进去 → 顶部「保存全部」→ 点卡片上的刷新。

两种计费模型（2026-06-18 升级后并存）都会自动识别，**按响应载荷的形状判断**，不只看 `plan_family`：

| 你的套餐 | 响应特征 | 卡片上看到 |
|---|---|---|
| **Coding Plan**（滚动窗口） | `five_hour_usage_left_rate` / `weekly_usage_left_rate` 有值、`*_reset_time` 是真实时间戳 | 「5 小时窗口 0.2%」「每周窗口 38%」，各自带重置时间 |
| **Token Plan**（月度 Credit 池） | 窗口字段恒为 `0` + `plan_credit_rate_limit`（`plan_family: 2`） | 「套餐 Credit 3.6%」，说明行里带 `剩 385,643,853 / 400,000,000 Credits · 订阅 Credit 剩 96.4% · Credit 至 YYYY-MM-DD`；加油包非 0 时追加「加油包剩 x%」 |

```text
窗口套餐：percent = (1 - five_hour_usage_left_rate) × 100      # 接口给的是「剩余比例」
例：left_rate = 0.998 → 0.2%（剩 99.8%），重置看 *_reset_time（秒级时间戳，按北京时间显示）

Credit 套餐：优先按桶的绝对值加权 —— percent = (1 - Σcredit_residual / Σcredit_total) × 100
例：385,643,853 / 400,000,000 → 3.59%（剩 96.4%）
没有可用桶时退回 subscription_credit_left_rate，最后才用 topup_credit_left_rate
```

套餐名（`Plus` / `Mini` 之类）来自 `GetStepPlanStatus` 的 `subscription.name`，会出现在卡片标题下方那一行；**这条接口失败只是少一行字，不影响额度数字**。

⚠️ **令牌会过期**：服务端回 `401` 时平台会自动用令牌里的 refresh 段续期一次并重试（续期走 `POST /passport/proto.api.passport.v1.PassportService/RefreshToken`，body `{}`）；续期也失败就重新从浏览器复制一份。浏览器 Cookie 里的 refresh 段有效期很长，所以正常用很少需要再粘。

⚠️ 这两个接口是**控制台内部接口**（社区逆向，官方随时可能改），所以这个平台在设置页里默认**关闭**、归类为 experimental：接口变了就先把开关关掉。

⚠️ 令牌是**控制台登录态，权限比 API Key 大**（能操作你账号下的东西），只填在本机设置页里，别分享给别人。它和 API Key 一样以**明文**存在 `config.json` 的 `upstreamQuota` 里。

### 硅基流动：官方余额接口下线了，改读控制台 walletd（现金 + 代金券）

硅基流动的**官方 API Key 侧已经没有余额接口**：`GET /v1/user/info` 于 2026 年初下线（实测 HTTP 410 + code 20092），替代接口官方没公布。但控制台网页版自己走的是 `walletd` 服务（控制台的 Next.js 把 `walletd-server/*` 反代到 `https://walletd.siliconflow.cn/*`），两个接口都是活的：

```text
GET https://walletd.siliconflow.cn/api/v1/subject/profile                       → 现金余额
GET https://walletd.siliconflow.cn/api/v1/subject/wallets?pageSize=50&stage=3   → 代金券（stage 3 = COUPON）

cookie: __SF_auth.session-token=<控制台登录态>
header: x-subject-id: <账号 ID>        # 缺了服务端回 400 validate error: invalid parameter: SubjectId
```

**为什么代金券也算余额**：硅基流动的赠送额度（认证奖励、邀请奖励、充值赠金）全部落在代金券里，而代金券能直接抵扣消费 —— 站内「可用余额」= 现金 + 代金券。所以卡片第一条是合计的「可用余额」，下面每张券一条：

| 卡片上看到 | 来自 | 例 |
|---|---|---|
| **可用余额** | `financialInfo.balance` + 所有未过期代金券的 `balance` | 说明行「现金 ¥0.00 · 代金券 ¥35.85（2 张）」 |
| 认证奖励券 / 赠金等额代金券 … | `wallets[].name`（多语言 JSON，取 `zh-cn`） | 每条带「有效期至 2027-01-31 · 面额 ¥16.00 · 已用 ¥5.91」 |

**金额口径（易错）**：`profile` 里的金额**已经是元**（十进制字符串）；代金券的 `cap` / `used` / `balance` 是**12 位小数的定点整数** —— `16000000000000` 就是 ¥16（官方文案「16 元「认证奖励券」」可交叉验证）。面板换算时代金券除以 `1e12`：

```text
可用余额 = financialInfo.balance + Σ(未过期代金券.balance)
代金券金额（元）= wallet.balance ÷ 1e12        例：10090655520000 ÷ 1e12 = 10.09065552
已用完或已过期的券不计入（说明行写「N 张代金券已用完或过期，未计入」）
余额告警只看第一条「可用余额」，所以「现金 0 + 只有代金券」不会被误判成余额耗尽
```

**怎么拿凭据**（浏览器里一次，30 秒）：

1. 登录 [cloud.siliconflow.cn](https://cloud.siliconflow.cn/me/expensebill) → `F12` → **Application → Cookies → `https://cloud.siliconflow.cn`** → 复制 **`__SF_auth.session-token`** 的值；
2. 同一个 `F12` 切到 **Network**，点任意一个请求，复制请求头 **`x-subject-id`**（形如 `rch2fz3g09`）；
3. 设置页 → 上游额度 → **硅基流动 SiliconFlow** → 两格都填上 → 顶部「保存全部」→ 点卡片上的刷新。

⚠️ **会话会过期**：`__SF_auth.session-token` 是控制台登录态，过期后服务端回 401，卡片提示「控制台令牌可能已过期：重新登录控制台，复制一份新的」。硅基流动**没有**阶跃星辰那种自动续期（它没有暴露 RefreshToken 接口给网页版）。

⚠️ 控制台会话**权限比 API Key 大**（能操作账号下的东西），只填在本机设置页里即可；和 API Key 一样以**明文**存在 `config.json` 的 `upstreamQuota` 里。

⚠️ 这两个接口是**控制台内部接口**（社区逆向，官方随时可能改），所以归为 experimental；接口一变就把这个平台的开关关掉。

## 数字示例：平台差异导致的显示差异

| 平台返回 | 面板显示 |
|---|---|
| DeepSeek `total_balance: 12.34`（CNY） | 卡片大号金额 `¥12.34`，下面一行「账户余额（含赠金）」 |
| 火山 `QuotaUsage: [{Level:"session", Percent:1.6193, Cap:100}]` | 窗口行大号 `1.62%` + 进度条；**没有**「剩 X / 共 Y」（官方只给百分比） |
| 火山 `Level` 为 `session / weekly / monthly` | 显示成「5 小时窗口 / 每周窗口 / 每月窗口」，重置时间由 `ResetTimestamp`（秒）换算 |
| 火山 Agent Plan 未订阅（`AFP*` 里 `Quota: 0`） | **不出条目**，只留一条说明，不会显示成「0% / 已用尽」 |
| 腾讯云 `RealBalance: 12345`（单位分） | 大号金额 `¥123.45`（已换算成元） |
| OpenRouter `total_credits − total_usage` | 大号金额 `$X`（差额即剩余） |
| 智谱同时返回 tokens 周窗口与额度周窗口 | 两行分别标成「每周窗口（tokens）」「每周窗口（额度）」 |
| 智谱 `TIME_LIMIT`（`unit: 5`，带 `usageDetails.modelCode`） | 显示成「**MCP 每月额度**」——这个窗口是 MCP 工具的月度额度，**不是** Coding Plan 的 token 额度；`unit: 3` 才是 5 小时窗口、`unit: 6` 是周窗口 |
| 一个平台既有余额又有窗口（智谱、火山） | 窗口逐行列在大号百分比，余额在卡片下半部显示大号金额；设置页那一行则显示 `每周 98% · ¥380.00`（**最紧的窗口在前、余额在后**——窗口才是会卡住你的数字） |
| Sub2API `mode: "unrestricted", remaining: 12.5, unit: "USD"` | 大号金额 `$12.50`，下面一行「剩余额度」 |
| Sub2API `rate_limits: [{window:"5h", limit:100, used:25, remaining:75}]` | 每个窗口**各占一行**：「5 小时窗口 25% · 剩 75 / 共 100」；1 天 / 7 天窗口同理，**不会合并成一个余额** |
| NewAPI `quota: 250000`（`quota_per_unit: 500000`） | 大号金额 `$0.50`（额度 ÷ 每单位额度）；note 里给用户、用户组、累计请求与折算基准 |
| NewAPI `/api/status` 读不到 | 按配置里的「每单位额度」折算，仍没有就按上游默认 `500000 = 1 美元`，并挂一条提示 |
| OpenCode Go `usage.rolling.percent: 12.5` | 窗口行大号 `12.5%` + 进度条；`status: "rate-limited"` 的那一行标注「已达本窗口上限」 |
| 百炼 Token Plan 个人版 `per1MonthPercentage: 0.0027` | 窗口行大号 **`0.27%`**（上游给的是 **0–1 的比例**，换算成百分数；控制台页面同一个数字）+「重置 11-15 00:00」 |
| 百炼 Token Plan 个人版 `{per1MonthPercentage: null}`（不限量） | **不出百分比行**，只留一条「控制台没有给出月额度上限（可能不限量）」，不会显示成 0% |
| 百炼 Harness 权益 `totalQuota: 1000, availableQuota: 250` | 一行「权益名（如「网页解析 MCP」）75% · 剩 250 / 共 1000 次」+「权益至 <日期>」；**标签只显示用户看得懂的名字**，接口里的权益 code（`tokenplan_harness…`）不摆到卡片上；权益还在发放（没配对到）时只出标题与一条「发放中」说明 |

> ⚠️ **百分比一律按上游的刻度读**：智谱的 `percentage`、火山的 `Percent` 都是 **0–100 的百分数**（火山另有 `Cap` 表示刻度上限），`1` 就是 **1%**，不是 100%。（早期版本把 `1` 当小数 ×100，显示过假的 100%。）

## 查询失败时的排查

卡片/设置页行里会直接显示上游原文（密钥已脱敏），对着下表看：

| 现象 | 原因与处理 |
|---|---|
| 智谱只有账户余额、没有 5 小时/周窗口 | 该 Key 不属于套餐账号（本工具会自动依次尝试个人版与团队版两种查询参数），或需要填组织 / 项目 ID |
| 火山三个接口都 `HTTP 401` + `SignatureDoesNotMatch` | AK/SK 抄错或不成对（AK 应是 `AKLT` 开头，SK 一长串以 `=` 结尾），换成火山控制台「访问密钥」里的值 |
| 阿里云 `Code: NotAuthorized / This API is not authorized for caller` | AK/SK 本身有效，但该 RAM 用户**没有 BSS 权限**：给它加 `AliyunBSSReadOnlyAccess` 或权限点 `bss:DescribeAcccount`（注意双 c） |
| 百炼 Token Plan `HTTP 403` + `AccessDeniedDetail.AuthAction: modelstudio:GetSubscriptionStats` | 签名没问题，是 RAM 子账号缺这个权限点。官方口径（[Token Plan 个人版常见问题](https://help.aliyun.com/zh/model-studio/token-plan-personal-faq)）是给 RAM 用户挂 `AliyunTokenPlanReadOnlyAccess`（只读）或 `AliyunTokenPlanFullAccess`，**再挂 `AliyunBSSReadOnlyAccess`**，然后到控制台「账号管理」里给它分配管理员 / 订阅套餐权限。**但个人版套餐本来就没有席位**，加了权限也只会拿到空数据 —— 个人版请按下面一行配控制台令牌 |
| 百炼 Token Plan 红字「读不到数据：…只能靠控制台令牌读取…」 | 这是**个人版套餐**（控制台「订阅」页有「套餐额度 / 月额度已用 x%」那种）。三条路任选：①卡片页脚「一键获取令牌」（浏览器能访问面板地址时）；②在自己电脑上跑 `node tools/bailian-console-login.mjs` 拿令牌粘进来（面板在服务器上、浏览器开的是 IP 时用这条）；③给 AccessKey 加 `modelstudio:GenerateCLIAccessToken` 权限，平台自动换取 |
| 百炼 Token Plan 提示 `NotLogined` / 「控制台令牌已失效或被拒绝」 | 控制台令牌过期或被撤销：再点一次「一键获取令牌」（或按上面三条路的任意一条重取）。配了第 3 条权限点的话，平台会自动换新令牌重试一次，仍失败才会提示 |
| 百炼 Token Plan 点「一键获取令牌」后一直「等待授权」 | 回调回不到面板：浏览器必须能访问**面板这个地址**（本机 `127.0.0.1` 或 SSH 隧道都行）。面板开在服务器上、浏览器用 `http://<服务器IP>:6789` 访问时，https 授权页发的回调会被浏览器按混合内容拦掉 —— 改用 `ssh -L 6789:127.0.0.1:6789` 隧道访问，或在自己电脑上跑 `node tools/bailian-console-login.mjs` 拿令牌 |
| 百炼 Token Plan 只有 Harness 权益、没有「套餐月额度」 | 该账号没有月额度上限（或额度还没发放，官方说发放比购买晚几分钟）：卡片会给一条说明而不是显示成 0% |
| 腾讯云 `未配置 AccessKey ID / Secret` | 云平台必须手填 SecretId / SecretKey，不能靠「自动复用方案密钥」（方案里的 Key 是推理 Key） |
| 硅基流动提示「未配置「控制台会话令牌」/「账号 ID」」 | 两格都要填：Cookie 里的 `__SF_auth.session-token` + 请求头 `x-subject-id`（见上节「怎么拿凭据」） |
| 硅基流动 `HTTP 401` / 「控制台令牌可能已过期」 | 控制台会话过期了：重新登录控制台，复制一份新的 `__SF_auth.session-token` 粘回去 |
| 硅基流动 `HTTP 400` + `invalid parameter: SubjectId` | `x-subject-id` 填错或没填（不是用户名，是控制台请求头里那串短 ID） |
| Sub2API 报 `HTTP 404` / `HTTP 401` | 站点地址或 Key 不对：确认「方案」选的是这个中转站，或直接在「接入点覆盖」里填站点根地址（**不要带 `/v1`**） |
| NewAPI 报 `无权进行此操作，未登录且未提供 access token` | 填的不是控制台生成的**系统访问令牌**（`sk-` 中转 Key 不行），或该站要求带 `New-Api-User` 数字用户 ID |
| NewAPI 报 `没有 quota / used_quota` | 令牌有效但用户 ID 不对（读到的是空用户对象），核对控制台个人信息里的数字 ID |
| OpenCode Go 报 `HTTP 401` | Key 不是 Go 套餐的，或本机没有 `~/.local/share/opencode/auth.json` 且没手填 Key（先用 opencode 登录一次即可） |
| 任何平台 `请求超时` | 上游慢或被墙；把设置页「高级」里的请求超时调大，或填「接入点覆盖」 |
| 卡片挂着「旧数据」黄标 | 这次查询失败，显示的是上一次成功的数据；点卡片右上角刷新重试 |

## 加一个新平台

- 上表里的 20 个内置平台**开箱即用**，选中就能查；中转站（Sub2API / NewAPI）可以按上面的办法加任意多个站点。
- 上表之外、又只有 HTTP 接口的平台：目前面板里**没有**「自己填字段」的通用接口了（该功能已按需求下线）。要接只能改代码 —— 在 `lib/upstream-quota.mjs` 的 provider 定义里加一条（写请求、解析、字段、文档链接），重启后就会出现在设置页里。

## 相关页面

- [配额与计费机制](mechanism-quota.md) — 本站自己的额度池怎么算、怎么扣（与上游额度无关）
- [管理面板：工作区](dashboard-workspaces.md) — 「上游额度」面板在菜单里的位置与其它工作区
- [设置页：方案与全局配置](settings.md) — 左栏底部入口与二级视图
- [错误记录](dashboard-workspaces.md) — 上游 429 / 套餐超限的报错都进这里
