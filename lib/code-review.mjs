// lib/code-review.mjs —— 代码评审:仓库白名单、git 同步、进程内队列、运行与意见读写。
//
// 分工:本模块负责「编排与数据」,调用外部命令的**安全边界**全部在 lib/code-review-ocr.mjs
// (argv 数组、环境 allowlist、输出校验)。这里只做配置校验、状态机与落库。
//
// ⚠️ 会拒绝的用法(每条都有对应测试,见 tests/code-review-security.test.mjs):
//   · 仓库 URL 非 https/ssh/git@,或以 `-` 开头、含空白与控制字符 → 400
//   · 分支名不以字母数字开头、含空格或 `-` 前缀 → 400
//   · from/to 不是 7~40 位十六进制(拒 `main`/`HEAD~1`/`$(...)`) → 400
//   · repoId 查不到,或解析后的目录不在 工作区/repos/ 内 → 400
//   · 功能未启用时任何触发 → 409;成员 Key 未授权 → 403
//   · 同仓库并发 → 串行(第二次入队去重返回同一 runId)
//
// 运行时状态(游标、失败计数)一律落 SQLite,不进 config —— 否则每次跑完都要改 config,
// 与设置页表单互相覆盖,并把审计刷成噪声。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
// 统一评审标准(所有仓库、每次运行注入同一份)。加载/校验/编译都在那个模块里,
// 这里只负责把它落盘并把路径交给引擎(见 startJob 的 writeReviewInputs)。
import { writeReviewInputs, loadStandard } from "./code-review-standard.mjs";

const REPO_URL_RE = /^(https:\/\/|ssh:\/\/|git@)[^\s"'`\\$]{3,500}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const FIELD_MAX = 8192;          // 单条意见字段截断上限
const WARNINGS_MAX = 32768;
const FILES_MAX = 32768;         // 被评文件清单(路径)的落库上限
const COMMITS_MAX = 200;         // 提交清单条数上限(总数另有一列,不受此限)
const COMMITS_MAX_BYTES = 32768; // 提交清单 JSON 的落库上限

// 回溯步数钳位。N 是**步数**不是「评几个提交」:N=1 等价于只评最新那一个。
export const clampColdStart = (n) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 10;
  return Math.min(500, Math.max(1, v));
};

// 列表落库的通用截断:条数 + 字节数双保险。⚠️ 字节裁剪必须落在**条目边界**上 ——
// 直接对 JSON 字符串 slice 会切成非法 JSON,前端 JSON.parse 失败后就变成「没有数据」,
// 且**不报任何错**(实测踩过:警告与文件清单都静默消失)。所以宁可少几条,不可切坏。
// 提交清单、警告、被评文件清单共用这一份 —— 别再各写一份 .slice(0, N)。
export function capJsonList(list, { maxItems, maxBytes }) {
  const arr = Array.isArray(list) ? list : [];
  const out = arr.slice(0, maxItems);
  while (out.length && JSON.stringify(out).length > maxBytes) out.pop();
  return out.length ? JSON.stringify(out) : null;
}

export function capCommitsJson(list) {
  return capJsonList(list, { maxItems: COMMITS_MAX, maxBytes: COMMITS_MAX_BYTES });
}

export const TRIGGERS = new Set(["manual", "schedule", "api", "mcp", "webhook"]);
export const TERMINAL_OK = new Set(["success", "completed_with_warnings", "completed_with_errors", "partial", "skipped"]);
export const TERMINAL = new Set([...TERMINAL_OK, "failed", "timeout", "canceled"]);
// 「跑完了,但没跑全 / 有保留」的那一类。**给通知与界面用**,不要拿
// `TERMINAL && !TERMINAL_OK` 反推 —— partial 在 TERMINAL_OK 里(游标照常推进),
// 反推不出来,正是「完成(有错误)」既不通知也不提示的老病根。
export const DEGRADED_STATUSES = new Set(["completed_with_warnings", "completed_with_errors", "partial"]);
const ACTIVE = ["queued", "syncing", "running", "parsing"];

// 成员侧不展示的终态:这几种「压根没跑出评审结果」的运行只给管理员看(失败/超时/已取消)。
// ⚠️ 与 TERMINAL_OK **故意不共用**一个集合:TERMINAL_OK 决定**游标是否推进**,
// 这个只决定**成员看不看得见**。前者一动就是评审范围的事,后者只是展示口径。
// 「已跳过」有意留在可见侧 —— 它是「有意没跑」(超预算 / 无新提交),对成员是有用信息。
export const MEMBER_HIDDEN_STATUSES = new Set(["failed", "timeout", "canceled"]);
export const memberVisibleStatus = (s) => !MEMBER_HIDDEN_STATUSES.has(String(s || ""));

// 「这次到底评全了没有」的判定 —— 专指**覆盖率**不全(选了 N 个文件、只评了 M 个),
// 与 DEGRADED_STATUSES(状态降级)是**两件事**:completed_with_warnings 可能一个文件都没漏,
// 不该被打上「覆盖不全」。三个信号取或:
//   1. status === "partial"        —— 新记录由 STATUS_MAP 直接给出
//   2. unreviewed_count > 0        —— 落库时算好的标量
//   3. warnings 里有预算警告        —— 老记录专用:partial 当年走兜底写成了
//      completed_with_errors,状态列已经不可信(库里的 #8/#9 就是),只能从**列表本来
//      就带**的 warnings_json 反推。零额外 IO、不改库,与「不回填历史」的决定一致。
// ⚠️ 不要退回「按 status 判」:那样会给所有 completed_with_errors 打包票说「覆盖不全」。
const COVERAGE_WARN_RE = /token_budget_reached|budget/i;
export function coverageIncomplete(row) {
  if (!row) return false;
  if (String(row.status || "") === "partial") return true;
  if (Number(row.unreviewed_count) > 0) return true;
  const w = row.warnings_json;
  return typeof w === "string" && COVERAGE_WARN_RE.test(w);
}

export function isValidRepoUrl(u) {
  if (typeof u !== "string") return false;
  if (u.startsWith("-")) return false;
  if (/[\s\u0000-\u001f]/.test(u)) return false;         // 空白/控制字符 → 会被参数解析器或 shell 语义利用
  return REPO_URL_RE.test(u);
}
export const isValidBranch = (b) => typeof b === "string" && BRANCH_RE.test(b);
export const isValidCommitRef = (r) => typeof r === "string" && COMMIT_RE.test(r);

export function maskCredential(cred) {
  if (!cred) return { hasCredential: false, hint: "" };
  const s = String(cred);
  return { hasCredential: true, hint: s.length > 4 ? `****${s.slice(-4)}` : "****" };
}

// ── 北京时间口径(全项目统一:存储 UTC,判定与展示 +8) ──
// 定时调度、当日预算、清理的「新的一天」都按北京日界判定 —— 团队在国内,
// 用 UTC 日界会出现「早上 8 点才算新的一天」这种反直觉行为。
export function beijingParts(nowMs = Date.now()) {
  const bj = new Date(nowMs + 8 * 3600000);
  const dow = bj.getUTCDay();                      // 0=周日
  return {
    day: bj.toISOString().slice(0, 10),
    hhmm: bj.toISOString().slice(11, 16),
    weekday: dow === 0 ? 7 : dow,                  // 1=周一 … 7=周日(与设置页 weekdays 同口径)
  };
}
// 北京「今天 00:00」对应的 UTC ISO 时刻:用来跟 created_at(UTC)做区间比较
export function beijingDayStartUtc(nowMs = Date.now()) {
  const bj = new Date(nowMs + 8 * 3600000);
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate()) - 8 * 3600000).toISOString();
}

// 定时到期判定(纯函数,便于单测):
//   interval —— 距上次**任何**运行(含手动)满 intervalHours 即到期
//   daily    —— 北京时间到点、且今天还没评过(手动跑过也算今天评过)
// 用「上次运行时刻」而不是「上次定时运行时刻」是刻意的:游标是全局的,
// 手动评审已经把最新提交评完了,再定时评一次只会得到空区间。
export function isScheduleDue(repo, lastRunAt, nowMs = Date.now()) {
  const sch = (repo && repo.schedule) || { mode: "off" };
  if (sch.mode !== "interval" && sch.mode !== "daily") return null;
  const lastMs = lastRunAt ? Date.parse(lastRunAt) : NaN;
  const hasLast = Number.isFinite(lastMs);
  const { day, hhmm, weekday } = beijingParts(nowMs);
  if (sch.mode === "interval") {
    const everyMs = Math.max(1, Number(sch.intervalHours) || 6) * 3600000;
    if (hasLast && nowMs - lastMs < everyMs) return null;
    return "interval";
  }
  const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(sch.at || "") ? sch.at : "03:00";
  const wds = Array.isArray(sch.weekdays) ? sch.weekdays : [];
  if (wds.length && !wds.includes(weekday)) return null;            // 今天不在选定星期里
  if (hhmm < at) return null;                                       // 还没到点
  if (hasLast && beijingParts(lastMs).day === day) return null;     // 今天已经评过
  return "daily";
}

// 一次性迁移:旧的全局白名单 `codeReview.apiKeys` → 各仓库的成员名单。
// 语义等价 —— 那份名单当时能触发**所有**已开在线触发的仓库,所以原样灌进每个这样的仓库。
// 迁移后清空 apiKeys(此后授权只看仓库自己的 members)。返回被改动的仓库数;幂等。
// 留在库里而不是写在启动代码里,是为了能被单测直接覆盖。
export function migrateLegacyTriggerKeys(crCfg) {
  if (!crCfg || !Array.isArray(crCfg.apiKeys) || !crCfg.apiKeys.length) return 0;
  const legacy = [...crCfg.apiKeys];
  let touched = 0;
  for (const repo of Array.isArray(crCfg.repos) ? crCfg.repos : []) {
    if (!repo.apiTrigger || repo.enabled === false) continue;
    const before = Array.isArray(repo.members) ? repo.members : [];
    const merged = [...new Set([...before, ...legacy])].slice(0, 200);
    if (merged.length !== before.length) { repo.members = merged; touched++; }
  }
  crCfg.apiKeys = [];
  return touched;
}

// —— 配置归一化:默认值 + 钳位 + 校验。不合法就落到安全默认值,绝不带病运行。——
export function sanitizeCodeReviewConfig(raw, serverPort = 6789) {
  const r = (raw && typeof raw === "object") ? raw : {};
  const num = (v, def, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const out = {
    enabled: !!r.enabled,
    ocrPath: typeof r.ocrPath === "string" ? r.ocrPath.trim() : "",
    ocrConfigMode: r.ocrConfigMode === "host" ? "host" : "isolated",
    workspaceDir: typeof r.workspaceDir === "string" ? r.workspaceDir.trim() : "",
    perRepoDiskLimitMB: num(r.perRepoDiskLimitMB, 2048, 64, 102400),
    maxParallelJobs: num(r.maxParallelJobs, 2, 1, 4),
    defaultTimeoutMinutes: num(r.defaultTimeoutMinutes, 30, 2, 240),
    defaultConcurrency: num(r.defaultConcurrency, 4, 1, 32),
    // 探索深度:OCR 的 --effort。high = 允许更多工具轮次与更深的调用链取证 —— 这是
    // 「只出确证缺陷」的代价来源(更慢更贵),但也是统一标准能真正落地的前提:
    // 标准要求每条意见都写出上下游证据,工具轮次不够时模型只能凭直觉猜,那正是要消灭的。
    defaultEffort: ["low", "medium", "high"].includes(r.defaultEffort) ? r.defaultEffort : "high",
    // ⚠️ 升级注意:改的是**代码里的默认值**,已部署环境 config.json 里存着的旧值不会被改写
    // (见 wiki/deploy.md「升级提醒」)。8,000,000 的依据:high 档 + 沿调用链取证,
    // 单次实测峰值到过 1,876,001 token,2,000,000 会在取证途中被预算掐断。
    defaultMaxTokensBudget: num(r.defaultMaxTokensBudget, 8_000_000, 0, 200_000_000),
    // 冷启动/游标失效时回溯多少个提交(见 resolveRange)。N 是**步数**,不是「评几个提交」:
    // N=1 等价于只评最新那一个(to~1 就是它的父提交),N=2 才把 to~1 那个合并提交带入的
    // 内容算进来 —— 所以「合并进来 5 个提交要一起评」至少要 N≥2。默认 10。
    coldStartCommits: num(r.coldStartCommits, 10, 1, 500),
    // 当日 token 预算(0 = 不限)。**只闸自动/定时触发**:手动、CI、MCP 触发照常受理 ——
    // 预算的用途是「防无人值守时把额度烧光」,不是给人添堵。默认 50,000,000 = 安全网
    // (≈ 单次预算 8,000,000 × 一天真正会跑的仓库数),不是配额规划,按实际调小。
    dailyTokenBudget: num(r.dailyTokenBudget, 50_000_000, 0, 2_000_000_000),
    runRetentionDays: num(r.runRetentionDays, 90, 1, 3650),
    keepRunsPerRepo: num(r.keepRunsPerRepo, 50, 1, 1000),
    storeComments: r.storeComments !== false,
    notifyOn: ["always", "failure", "never"].includes(r.notifyOn) ? r.notifyOn : "always",
    // Webhook 自动评审:全局一个密钥(GitLab/Gitee 当 Token,GitHub 当 HMAC Secret);
    // 空 = 功能整体关闭(端点一律 403)。防抖管「同一仓库短时间连推只评一次」,0=不防抖。
    webhookSecret: String(r.webhookSecret || "").trim().slice(0, 128),
    webhookDebounceSeconds: num(r.webhookDebounceSeconds, 300, 0, 3600),
    // 「评出意见时通知负责人」的两个去向(与上面的 notifyOn 正交:notifyOn 管管理员渠道)
    notifyCommitAuthor: r.notifyCommitAuthor !== false,   // 发给被评提交的 git 作者邮箱
    notifyMembers: r.notifyMembers !== false,             // 发给该仓库成员各自配的渠道
    providerKey: typeof r.providerKey === "string" ? r.providerKey.trim() : "",
    providerProfile: typeof r.providerProfile === "string" ? r.providerProfile.trim() : "",
    providerName: (typeof r.providerName === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(r.providerName)) ? r.providerName : "cc-team",
    providerUrl: (typeof r.providerUrl === "string" && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/\S*)?$/.test(r.providerUrl))
      ? r.providerUrl
      : `http://127.0.0.1:${serverPort}/v1`,
    providerProtocol: r.providerProtocol === "openai-responses" ? "openai-responses" : "anthropic",
    providerModel: typeof r.providerModel === "string" ? r.providerModel.trim().slice(0, 128) : "",
    // 全局业务背景(团队级约定:资金/退款/权限这类「代码里看不出来」的规则)。
    // 上限 20000 字:这块是给人写业务规则的,2000 字经常不够描述一条完整链路。
    // 它不再走 argv,而是落成文件用 --background-file 传(见 code-review-ocr.mjs)。
    background: typeof r.background === "string" ? r.background.slice(0, 20000) : "",
    // 评审输出语言。OCR 的 language 配置会被拼成 "Always respond in <值>." 注入到全部
    // system 提示里(评审意见正文与推理过程都受它管);OCR 自身默认 English,团队读中文
    // 更快,所以这里默认中文。值原样进指令,写 "Simplified Chinese" 比 "zh" 更稳
    // (模型对语言名的跟随比语言代码可靠)。想改回英文:config.json 里
    // codeReview.language 填 "English"(或任何语言名)。
    language: (typeof r.language === "string" && r.language.trim()) ? r.language.trim().slice(0, 40) : "Simplified Chinese",
    exclude: Array.isArray(r.exclude) ? r.exclude.filter((x) => typeof x === "string" && x.trim()).slice(0, 50) : [],
    apiKeys: Array.isArray(r.apiKeys) ? r.apiKeys.filter((k) => typeof k === "string" && k).slice(0, 200) : [],
    repos: [],
  };
  const seen = new Set();
  for (const repo of Array.isArray(r.repos) ? r.repos : []) {
    const clean = sanitizeRepo(repo);
    if (!clean || seen.has(clean.id)) continue;
    seen.add(clean.id);
    out.repos.push(clean);
  }
  return out;
}

function sanitizeRepo(raw) {
  if (!raw || typeof raw !== "object") return null;
  const source = raw.source === "local" ? "local" : "remote";
  const id = /^[0-9a-f]{8}$/.test(raw.id || "") ? raw.id : crypto.randomBytes(4).toString("hex");
  const name = (typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : `仓库-${id}`).slice(0, 64);
  const url = source === "remote" ? String(raw.url || "").trim() : "";
  if (source === "remote" && !isValidRepoUrl(url)) return null;   // 非法 URL 的仓库直接丢弃,不入白名单
  const localPath = source === "local" ? String(raw.localPath || "").trim() : "";
  if (source === "local" && (!localPath.startsWith("/") || /[\u0000-\u001f]/.test(localPath))) return null;
  const branch = isValidBranch(raw.branch) ? raw.branch : "main";
  // 显式给了非法分支名(如 "--upload-pack=id")直接拒绝,而不是静默改成 main ——
  // 静默纠正会让管理员以为配置生效了,实际评的是另一条分支
  if (raw.branch !== undefined && raw.branch !== "" && !isValidBranch(raw.branch)) return null;
  const authType = ["none", "token", "sshKey"].includes(raw.authType) ? raw.authType : "none";
  // 成员名单:列在这里的人 = 能触发这个仓库 + 能在「我的用量」页看到它的结果。
  // 取代了早先的全局白名单(codeReview.apiKeys)—— 不是每个人负责同一个仓库。
  const members = Array.isArray(raw.members)
    ? [...new Set(raw.members.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim().slice(0, 128)))].slice(0, 200)
    : [];
  const sch = raw.schedule && typeof raw.schedule === "object" ? raw.schedule : {};
  const weekdays = Array.isArray(sch.weekdays) ? sch.weekdays.map(Number).filter((d) => d >= 1 && d <= 7) : [];
  return {
    id, name, source, url, localPath, branch,
    authType,
    username: typeof raw.username === "string" ? raw.username.slice(0, 128) : "",
    credential: typeof raw.credential === "string" ? raw.credential : "",
    enabled: raw.enabled !== false,
    apiTrigger: !!raw.apiTrigger,
    // push 自动评审:托管平台 webhook 回调到网关时,这个仓库是否自动入队(默认关)
    pushTrigger: !!raw.pushTrigger,
    members,
    schedule: {
      mode: ["off", "interval", "daily"].includes(sch.mode) ? sch.mode : "off",
      intervalHours: Math.min(168, Math.max(1, Number(sch.intervalHours) || 6)),
      at: /^([01]\d|2[0-3]):[0-5]\d$/.test(sch.at) ? sch.at : "03:00",
      weekdays,
    },
    overrides: {
      exclude: Array.isArray(raw.overrides?.exclude) ? raw.overrides.exclude.filter((x) => typeof x === "string") : null,
      // 本仓库的业务背景(与全局那段拼接后用 --background-file 注入;上限同全局 20000)
      background: typeof raw.overrides?.background === "string" ? raw.overrides.background.slice(0, 20000) : null,
      timeoutMinutes: raw.overrides?.timeoutMinutes ? Math.min(240, Math.max(2, Number(raw.overrides.timeoutMinutes))) : null,
      // null = 用全局 coldStartCommits(与上面两个同款:没配就是「跟随全局」)
      coldStartCommits: raw.overrides?.coldStartCommits ? Math.min(500, Math.max(1, Math.round(Number(raw.overrides.coldStartCommits)))) : null,
    },
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// —— 三张表(照 production.mjs 的 initProductionDb 先例:本功能自带建表,不污染 persistence)——
// backup:可选回调,只在**要做破坏性重建**时调用一次(返回备份文件路径或 null)。
// 建表与 ADD COLUMN 都是幂等的,不值得每次启动都拷一份库。
export function initCodeReviewDb(db, { backup = null } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_review_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL, repo_name TEXT NOT NULL,
      trigger TEXT NOT NULL, actor TEXT,
      branch TEXT, from_commit TEXT, to_commit TEXT, range_mode TEXT,
      status TEXT NOT NULL, exit_code INTEGER, error TEXT, note TEXT,
      files_reviewed INTEGER DEFAULT 0, comments_count INTEGER DEFAULT 0, dropped_comments INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
      elapsed_ms INTEGER,
      attributed_requests INTEGER DEFAULT 0, attributed_input INTEGER DEFAULT 0, attributed_output INTEGER DEFAULT 0,
      ocr_model TEXT, ocr_provider TEXT, session_id TEXT, standard_version TEXT,
      warnings_json TEXT, raw_path TEXT, cursor_advanced INTEGER DEFAULT 0, notified INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cr_runs_repo ON code_review_runs(repo_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_cr_runs_created ON code_review_runs(created_at);
    CREATE TABLE IF NOT EXISTS code_review_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL, repo_id TEXT NOT NULL, idx INTEGER NOT NULL,
      path TEXT NOT NULL, start_line INTEGER, end_line INTEGER,
      content TEXT, existing_code TEXT, suggestion_code TEXT, thinking TEXT,
      truncated INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_cr_comments_run ON code_review_comments(run_id, idx);
    CREATE INDEX IF NOT EXISTS idx_cr_comments_path ON code_review_comments(repo_id, path, id DESC);
    CREATE TABLE IF NOT EXISTS code_review_repo_state (
      repo_id TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      last_commit TEXT, last_run_id INTEGER, last_run_at TEXT, last_status TEXT,
      consecutive_failures INTEGER DEFAULT 0,
      queued_at TEXT, updated_at TEXT,
      PRIMARY KEY (repo_id, branch)
    );
  `);
  // 列迁移(CREATE TABLE IF NOT EXISTS 不会给已存在的表补列):
  // files_json = 本次实际评审的文件路径清单,tool_calls_json = OCR 工具调用统计。
  // 老库补成 NULL,前端按「无数据」处理。
  const runCols = db.prepare("PRAGMA table_info(code_review_runs)").all().map((c) => c.name);
  // author_* = 被评提交的 git 作者(用来把问题通知到「写这段代码的人」)。
  // 引擎的 manifest 里只有 SHA、没有作者,所以这两列由网关自己跑 git log 取。
  // resolved* = 成员/管理员标记的「已解决」状态:按整次运行一条,不点就一直是未解决。
  for (const col of ["files_json", "tool_calls_json", "author_name", "author_email", "pusher_email"]) {
    if (!runCols.includes(col)) db.exec(`ALTER TABLE code_review_runs ADD COLUMN ${col} TEXT`);
  }
  for (const col of ["resolved", "resolved_at", "resolved_by"]) {
    if (!runCols.includes(col)) db.exec(`ALTER TABLE code_review_runs ADD COLUMN ${col} ${col === "resolved" ? "INTEGER DEFAULT 0" : "TEXT"}`);
  }
  // 本次「覆盖了哪些提交」:光有 from→to 两个端点,管理员没法核对「中间那几个提交
  // 到底评没评」。commits_json 是清单([{sha,subject,author,at}]),commits_count 是
  // 真实总数(清单封顶 200 条,计数不跟着截断)。
  // range_source/range_note 说明「这一段是怎么来的」(游标/冷启动/游标失效/手动补评)——
  // 必须独立成列:note 那列装的是**结论**,每跑完一次就被 reviewNote 重写,把范围来源
  // 塞进去会被覆盖掉,界面上就再也看不出「这次为什么退化成只评一个提交」。
  for (const col of ["commits_json", "range_source", "range_note"]) {
    if (!runCols.includes(col)) db.exec(`ALTER TABLE code_review_runs ADD COLUMN ${col} TEXT`);
  }
  if (!runCols.includes("commits_count")) db.exec("ALTER TABLE code_review_runs ADD COLUMN commits_count INTEGER DEFAULT 0");
  // 这次用的是**哪一版统一评审标准**(lib/code-review-standard.mjs 编译产物的 12 位 hash)。
  // 标准一变,历史运行的意见口径就不可比 —— 没有这一列,「同一个提交两次结论不同」
  // 只能靠猜。失败运行也写(它是「本来打算用哪版标准」)。
  if (!runCols.includes("standard_version")) db.exec("ALTER TABLE code_review_runs ADD COLUMN standard_version TEXT");
  // 被机械兜底丢弃的「无推理依据」意见数(见 code-review-ocr.mjs 的 readReport)。
  // 单独成列而不是只写进 note:note 每次都整体重写,而且「丢弃了几条」要被列表和详情
  // 稳定读到 —— 不展示它,「意见变少」就会被当成「没问题」。
  if (!runCols.includes("dropped_comments")) db.exec("ALTER TABLE code_review_runs ADD COLUMN dropped_comments INTEGER DEFAULT 0");
  // 覆盖率(「这次到底评了多少、多少没评、为什么」)—— 见 code-review-ocr.mjs 的 parseCoverage。
  // ⚠️ 分成两列是有意的:
  //   · unreviewed_count 是**标量**,给列表/通知/结论用(它们只需要这一个数);
  //   · coverage_json 是**详情专用**(含 byClass/reasons/未评文件清单/引擎原话),
  //     与 commits_json 同待遇 —— **不进 RUN_LIST_COLS**。列表一次最多 200 条,
  //     把带清单的 JSON 塞进去就是重犯「commits_json 一条 32KB」那个错。
  // 老库补成 NULL:前端按「这条记录没有覆盖率信息」处理,不编造。
  if (!runCols.includes("unreviewed_count")) db.exec("ALTER TABLE code_review_runs ADD COLUMN unreviewed_count INTEGER DEFAULT 0");
  if (!runCols.includes("coverage_json")) db.exec("ALTER TABLE code_review_runs ADD COLUMN coverage_json TEXT");
  // 「不用处理」是**按单条意见**的处置(与运行级的 resolved 正交):开发认为某条意见
  // 不需要改动时,必须写明理由 —— 理由不是可选项,它是这条记录存在的意义(后来的人
  // 看到「为什么当时没改」比看到「有人点了忽略」有用得多)。
  const commentCols = db.prepare("PRAGMA table_info(code_review_comments)").all().map((c) => c.name);
  for (const col of ["dismissed", "dismissed_at", "dismissed_by", "dismiss_reason"]) {
    if (!commentCols.includes(col)) db.exec(`ALTER TABLE code_review_comments ADD COLUMN ${col} ${col === "dismissed" ? "INTEGER DEFAULT 0" : "TEXT"}`);
  }
  migrateRepoStatePerBranch(db, { backup });
}

// ── 表重建:游标由「每仓库一份」改为「每 (仓库, 分支) 一份」 ──────────────────
// 起因是一个真实事故:同一个仓库上依次评了 master / feature/xxx / ljh_test / yycGovernment
// 四条分支,共享的那一份游标每评一次就被推到**那条分支**的 HEAD 上;轮到第四条分支时,
// 游标指向的是第三条分支的提交(不是它的祖先),于是「增量」判定失败 → 静默退化成
// 「只评最新一个提交」。而那个提交正好是个合并提交,合并带进来的全部内容一条都没评。
//
// SQLite 不能 ALTER 主键,只能重建(照 lib/persistence.mjs 里 quota_daily_ops 换主键的先例:
// RENAME → CREATE → INSERT → DROP,整体一个事务)。
// ⚠️ 这是评审表第一次做**破坏性**重建,所以调用方可以传 backup 回调,迁移前先拷一份库。
function migrateRepoStatePerBranch(db, { backup = null } = {}) {
  const cols = db.prepare("PRAGMA table_info(code_review_repo_state)").all().map((c) => c.name);
  if (!cols.length || cols.includes("branch")) return false;   // 已是新结构(或表还不存在 → 建表语句已经是新的)
  try {
    const p = typeof backup === "function" ? backup() : null;
    if (p) console.log(`[MIGRATE] Pre-migration backup: ${path.basename(String(p))}`);
  } catch (err) {
    console.log(`[MIGRATE] 迁移前备份失败(继续迁移): ${err.message}`);
  }
  const legacy = db.prepare("SELECT * FROM code_review_repo_state").all();
  // 旧行没有分支信息,从该仓库的运行记录推:先认这条状态行对应的那次运行,
  // 再退到该仓库最近一次运行。都取不到就落到 '' —— 等价于该仓库冷启动(一次性重评
  // 最近 N 个提交),比硬塞一个错分支安全。
  const byRun = db.prepare("SELECT branch FROM code_review_runs WHERE id=?");
  const latest = db.prepare("SELECT branch FROM code_review_runs WHERE repo_id=? ORDER BY id DESC LIMIT 1");
  const branchOf = (row) => {
    let b = row.last_run_id ? byRun.get(row.last_run_id)?.branch : null;
    if (!b) b = latest.get(row.repo_id)?.branch;
    return String(b || "");
  };
  const tx = db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS code_review_repo_state_legacy");
    db.exec("ALTER TABLE code_review_repo_state RENAME TO code_review_repo_state_legacy");
    db.exec(`CREATE TABLE code_review_repo_state (
      repo_id TEXT NOT NULL,
      branch TEXT NOT NULL DEFAULT '',
      last_commit TEXT, last_run_id INTEGER, last_run_at TEXT, last_status TEXT,
      consecutive_failures INTEGER DEFAULT 0,
      queued_at TEXT, updated_at TEXT,
      PRIMARY KEY (repo_id, branch)
    )`);
    const ins = db.prepare(`INSERT INTO code_review_repo_state
      (repo_id, branch, last_commit, last_run_id, last_run_at, last_status, consecutive_failures, queued_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(repo_id, branch) DO UPDATE SET
        last_commit=excluded.last_commit, last_run_id=excluded.last_run_id, last_run_at=excluded.last_run_at,
        last_status=excluded.last_status, consecutive_failures=excluded.consecutive_failures,
        queued_at=excluded.queued_at, updated_at=excluded.updated_at`);
    for (const r of legacy) {
      ins.run(r.repo_id, branchOf(r), r.last_commit || null, r.last_run_id || null, r.last_run_at || null,
        r.last_status || null, r.consecutive_failures || 0, r.queued_at || null, r.updated_at || null);
    }
    db.exec("DROP TABLE code_review_repo_state_legacy");
  });
  tx();
  console.log(`[MIGRATE] code_review_repo_state rekeyed to (repo_id, branch) — ${legacy.length} row(s) kept`);
  return true;
}

const cut = (s, max = FIELD_MAX) => {
  const v = s == null ? null : String(s);
  return v != null && v.length > max ? { v: v.slice(0, max), t: true } : { v, t: false };
};

// OCR 的 summary.elapsed 是可读串(实测形如 "0s",也可能 "1m2s"),也兼容直接给秒数。
function parseElapsed(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 1000);
  const m = String(v || "").match(/^(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  return Math.round((Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 1000);
}

// ── 独立 HTML 报告(照 production.mjs 的 buildReportHTML:自包含、零外链、可直接发群) ──
// ⚠️ 报告内容全部来自被评审仓库(任意代码/注释),所以**每个字段都必须转义** ——
// 这份 HTML 会被管理员下载后在浏览器里打开,未转义的 <script> 就是一次存储型 XSS。
const escH = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const STATUS_LABEL = {
  success: "完成", completed_with_warnings: "完成(有警告)", completed_with_errors: "完成(有错误)",
  partial: "部分完成",
  failed: "失败", timeout: "超时", canceled: "已取消", skipped: "已跳过",
  queued: "排队中", syncing: "同步中", running: "评审中", parsing: "解析中",
};
export { STATUS_LABEL };
const TRIGGER_LABEL = { manual: "手动", schedule: "定时", api: "API", mcp: "MCP", webhook: "推送" };
// OCR 工具调用的中文名(报告与界面共用口径,避免各写一套)
const CR_TOOL_ZH = { code_search: "代码检索", file_read: "读文件", file_write: "写文件", shell: "执行命令", grep: "检索", glob: "匹配文件" };

const bjTime = (iso) => (iso ? new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ") : "—");

export function buildReviewReportHTML({ run, comments = [], repo = {}, coverage = null }) {  const r = run || {};
  // 覆盖率:只在**新记录**(有 coverage_json)或调用方按需补读(见 displayPatch)时才有。
  // ⚠️ 没有它 = 老记录 / 引擎没给 manifest,**不编造**「评全了」。
  const cov = (() => {
    if (coverage && typeof coverage === "object") return coverage;
    try { const o = JSON.parse(r.coverage_json || "null"); return o && typeof o === "object" ? o : null; } catch { return null; }
  })();
  const unreviewed = cov ? Math.max(0, Number(cov.failed) || 0) : 0;
  const covDone = cov ? Math.max(0, Number(cov.completed) || 0) : 0;
  const covSel = cov ? Math.max(0, Number(cov.selected) || 0) : 0;
  const covWhy = cov ? (() => {
    const by = cov.byClass && typeof cov.byClass === "object" ? cov.byClass : {};
    const CLASS_ZH_HTML = { budget: "超出单次 token 预算" };
    const es = Object.entries(by).filter(([, n]) => Number(n) > 0);
    // 「29 个超出单次 token 预算」比「超出单次 token 预算 29 个」像人话
    return es.length ? es.map(([k, n]) => `${n} 个${CLASS_ZH_HTML[k] || k}`).join(" / ") : "原因未标注";
  })() : "";
  // 未评清单:取 sample(已按条目截断),没有 sample 就退化成「只报个数」
  const notReviewed = cov && Array.isArray(cov.sample) ? cov.sample.map((s) => String(s.path || "")).filter(Boolean) : [];
  const files = new Map();
  for (const c of comments) {
    const p = String(c.path || "?");
    if (!files.has(p)) files.set(p, []);
    files.get(p).push(c);
  }
  // 这一段是怎么定出来的 —— range_source 由引擎写入(见 resolveRange / manualRange)。
  // ⚠️ 不能按 range_mode 判「单提交/增量」:冷启动与手动补评都可能落在 range 模式上,
  // 手填 from===to 时又落在 single 模式上。老记录没有 range_source,按 range_mode 兜底。
  const rangeSrc = r.range_source || (r.range_mode === "single" ? "single" : "cursor");
  const rangeTag = { cold: "冷启动回溯", rewritten: "游标失效回溯", manual: "手动补评", cursor: "增量" }[rangeSrc]
    || (r.range_mode === "single" ? "单提交" : "增量");
  const range = `${rangeTag} ` + (r.range_mode === "single" || !r.from_commit
    ? escH(String(r.to_commit || "").slice(0, 10))
    : `${escH(String(r.from_commit || "").slice(0, 10))} → ${escH(String(r.to_commit || "").slice(0, 10))}`);
  // 覆盖了哪些提交 —— 范围对了也得能核对「合并带进来的那 5 个到底评没评」。
  const commits = (() => { try { const a = JSON.parse(r.commits_json || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } })();
  const commitsTotal = Number(r.commits_count) || commits.length;
  // ── C 方案「终端代码风」渲染：深色抬头 + 等宽元信息 + @@ 行号 + −/+ diff 色块 ──
  // 邮件与网页报告共用；约束：table 布局、全内联样式、零外部资源（测试锁着）。
  const fileBlocks = [...files.entries()].map(([p, list]) => `
  <div style="margin:16px 0 0">
    <div style="font:600 12.5px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#111827;background:#f4f4f1;border:1px solid #e6e6e2;border-bottom:0;border-radius:5px 5px 0 0;padding:6px 12px">▌ ${escH(p)} <span style="color:#9ca3af;font-weight:400">(${list.length})</span></div>
    <div style="border:1px solid #e6e6e2;border-radius:0 0 5px 5px;background:#ffffff">
    ${list.map((c) => `
      <div style="padding:11px 12px;border-bottom:1px solid #f1f1ee">
        <div style="font:11px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#8a8a85">${c.start_line ? "@@ L" + escH(c.start_line) + (c.end_line && c.end_line !== c.start_line ? "-" + escH(c.end_line) : "") + " @@" : "@@ 文件级 @@"}</div>
        <div style="font:13.5px/1.6 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2937;margin-top:3px;white-space:pre-wrap">${escH(c.content)}</div>
        ${c.existing_code || c.suggestion_code ? `<div style="margin-top:7px;border:1px solid #e6e6e2;border-radius:5px;overflow:hidden;font:11.5px/1.65 ui-monospace,Menlo,Consolas,monospace">
          ${c.existing_code ? String(c.existing_code).split("\n").map((l) => `<div style="padding:0 10px;background:#fdf3f2;color:#9b3b30;white-space:pre-wrap">- ${escH(l)}</div>`).join("") : ""}
          ${c.suggestion_code ? String(c.suggestion_code).split("\n").map((l) => `<div style="padding:0 10px;background:#f1f8f3;color:#1f6b45;white-space:pre-wrap">+ ${escH(l)}</div>`).join("") : ""}
        </div>` : ""}
        ${c.thinking ? `<details style="margin-top:8px"><summary style="cursor:pointer;font:11.5px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#6b7280">推理过程</summary><div style="margin-top:4px;padding:8px 10px;background:#f8f8f5;border:1px dashed #e0e0da;border-radius:4px;font:12px/1.65 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#4b5563;white-space:pre-wrap">${escH(c.thinking)}</div></details>` : ""}
        ${Number(c.dismissed) === 1 ? `<div style="margin-top:8px;padding:7px 11px;background:#f6f7f4;border-left:3px solid #b9bfb6;border-radius:0 4px 4px 0;font:12px/1.6 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#5c6b62">已标记不处理：${escH(c.dismiss_reason || "")}${c.dismissed_by ? `　—　${escH(c.dismissed_by)}` : ""}${c.dismissed_at ? " " + escH(bjTime(c.dismissed_at)) : ""}</div>` : ""}
      </div>`).join("")}
    </div>
  </div>`).join("");
  const warnings = (() => { try { return JSON.parse(r.warnings_json || "[]"); } catch { return []; } })();
  // ⚠️ warnings 是**对象数组**({file, message, type?}),`type` 还可能缺失(#8 就没有);
  // 直接 JSON.stringify(w) 会糊成一坨机器 JSON —— 而这正是「收到了 17 条意见、却看不出来
  // 还有 29 个文件没评」的唯一提示位,必须是人话。file 可能是**一串逗号分隔的路径**,截断。
  const warnOne = (w) => {
    if (typeof w === "string") return w;
    const msg = String((w && w.message) || "").trim();
    const f = String((w && w.file) || "").trim();
    return (msg || "（引擎未给出说明）") + (f ? ` [${f.length > 200 ? f.slice(0, 200) + "…" : f}]` : "");
  };
  // 覆盖不全时的醒目提示 —— 放在意见列表**之前**,否则收件人读完 17 条意见就走,
  // 根本不知道这 17 条只覆盖了 39 个文件里的 10 个。
  const budgetMsg = cov && cov.budgetNotice ? String(cov.budgetNotice) : "";
  // ⚠️ 撞预算的那条 warning 与 budgetNotice 是**同一句话**(budgetNotice 就是从 warnings 里挑出来的),
  // 不去重会在邮件里连着出现两遍一模一样的算式。
  const warnHtml = warnings.length
    ? warnings
      .filter((w) => !(unreviewed > 0 && budgetMsg && w && typeof w === "object" && String(w.message || "").trim() === budgetMsg))
      .map((w) => `<div style="margin:8px 0 0;font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#8a6a2f;background:#fdf7ea;border-left:3px solid #e0b95c;padding:7px 11px;white-space:pre-wrap">warn: ${escH(warnOne(w))}</div>`).join("")
    : "";
  const covHtml = unreviewed > 0
    ? `<tr><td style="padding:12px 20px 0"><div style="font:12px/1.7 ui-monospace,Menlo,Consolas,monospace;color:#9a4a1c;background:#fdf0e6;border-left:3px solid #c8682f;padding:8px 11px;white-space:pre-wrap">⚠ 本次只评审了 ${covDone}/${covSel || Number(r.files_reviewed) || 0} 个文件,另有 ${unreviewed} 个未评审（${escH(covWhy)}）。<br>下面的意见<strong>只覆盖已评部分</strong>,未评审的文件没有被检查过。${budgetMsg ? `<br>${escH(budgetMsg)}` : ""}${notReviewed.length ? `<br>未评审（前 ${notReviewed.length} 个）: ${escH(notReviewed.join(", "))}` : ""}</div></td></tr>`
    : "";
  // 本次实际入选的文件(files_json)与引擎动作(tool_calls_json)——回答「到底评了什么、有没有干活」
  // ⚠️ files_json 是**选中**集(来自 groups),不是**已评**集 —— 覆盖不全时拿它当
  // 「reviewed files」就是在替 29 个从没读过的文件打包票。真评过的清单只有
  // coverage.completedPaths;拿不到就把标题退成「本次选取的文件」,不撒谎。
  const reviewed = (() => { try { const a = JSON.parse(r.files_json || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } })();
  const hasCompletedList = !!(cov && Array.isArray(cov.completedPaths) && cov.completedPaths.length);
  const footList = unreviewed > 0 && hasCompletedList ? cov.completedPaths : reviewed;
  const footTitle = unreviewed > 0
    ? (hasCompletedList ? `已评审文件 (${footList.length})` : `本次选取的文件 (${footList.length})（引擎未给出已评清单）`)
    : `reviewed files (${footList.length})`;
  const tools = (() => { try { const o = JSON.parse(r.tool_calls_json || "null"); return o && typeof o === "object" ? o : null; } catch { return null; } })();
  const toolsText = tools
    ? `共 ${tools.total} 次` + (Object.keys(tools.byTool || {}).length ? "（" + Object.entries(tools.byTool).map(([k, v]) => `${escH(CR_TOOL_ZH[k] || k)} ${v}`).join(" · ") + "）" : "") + (tools.failure ? ` · 失败 ${tools.failure}` : "")
    : "";
  const kv = (k, v) => `<span style="color:#9ca3af">${escH(k)}</span>${escH(v)}`;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>代码评审报告 · ${escH(repo.name || r.repo_name)} #${escH(r.id)}</title></head>
<body style="margin:0;padding:24px 12px;background:#e9e9e5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" width="720" cellpadding="0" cellspacing="0" border="0" style="width:720px;max-width:720px;background:#ffffff;border:1px solid #dcdcd6;border-radius:6px;overflow:hidden">
  <tr><td style="background:#1b1f1d;padding:16px 20px">
    <div style="font:600 13px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#e8f0ea">[代码评审] <span style="color:#8fd0a8">${escH(repo.name || r.repo_name)}</span> #${escH(r.id)} · ${escH(comments.length)} findings</div>
    <div style="font:11.5px/1.7 ui-monospace,Menlo,Consolas,monospace;color:#8b9a91;margin-top:2px">$ ${escH(r.branch || "—")} ${range} · ${escH(bjTime(r.created_at))} 北京时间</div>
  </td></tr>
  <tr><td style="padding:14px 20px 0">
    <div style="font:12px/1.95 ui-monospace,Menlo,Consolas,monospace;color:#4b5563">
      ${kv("status : ", TRIGGER_LABEL[r.trigger] || r.trigger || "—")} / ${escH(STATUS_LABEL[r.status] || r.status)}${r.cursor_advanced ? "" : (rangeSrc === "manual" ? "（手动补评，不推进游标）" : "（游标未推进，下次会重评同一区间）")}<br>
      ${rangeSrc === "cursor" ? "" : `${kv("range  : ", rangeTag)}<br>`}
      ${commitsTotal ? `${kv("commits: ", `${commitsTotal} 个` + (commits.length < commitsTotal ? `（清单列最近 ${commits.length} 条）` : ""))}<br>` : ""}
      ${kv("files  : ", unreviewed > 0
        ? `选取 ${r.files_reviewed || covSel || 0} 个 / 完成 ${covDone} 个 · ${unreviewed} 个未评审（${covWhy}） · ${r.comments_count || 0} comments${Number(r.dropped_comments) > 0 ? `（另有 ${r.dropped_comments} 条因缺少推理依据被丢弃）` : ""}`
        : `${r.files_reviewed || 0} reviewed / ${r.comments_count || 0} comments${Number(r.dropped_comments) > 0 ? `（另有 ${r.dropped_comments} 条因缺少推理依据被丢弃）` : ""}`)}${toolsText ? `<br>${kv("tools  : ", toolsText)}` : ""}<br>
      ${r.author_name || r.author_email ? `${kv("author : ", `${r.author_name || "—"}${r.author_email ? " <" + r.author_email + ">" : ""}`)}<br>` : ""}
      ${kv("model  : ", `${r.ocr_model || "—"}${r.ocr_provider ? " (" + r.ocr_provider + ")" : ""}`)}<br>
      ${kv("standard: ", r.standard_version ? `v${r.standard_version}（统一评审标准，改动走代码发版）` : "—（此记录早于统一标准）")}<br>
      ${kv("tokens : ", `${r.input_tokens || 0} in / ${r.output_tokens || 0} out（OCR 自报） · ${r.attributed_requests || 0} req / ${r.attributed_input || 0} in / ${r.attributed_output || 0} out（网关实证）`)}<br>
      ${kv("elapsed: ", r.elapsed_ms ? Math.round(r.elapsed_ms / 1000) + "s" : "—")}
    </div>
  </td></tr>
  ${r.error ? `<tr><td style="padding:10px 20px 0"><div style="font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#9b3b30;background:#fdf3f2;border-left:3px solid #e0a49c;padding:7px 11px;white-space:pre-wrap">error: ${escH(r.error)}</div></td></tr>` : ""}
  ${r.note ? `<tr><td style="padding:10px 20px 0"><div style="font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;color:#4b5563;background:#f8f8f5;border-left:3px solid #d8d8d2;padding:7px 11px;white-space:pre-wrap">note: ${escH(r.note)}</div></td></tr>` : ""}
  ${warnHtml ? `<tr><td style="padding:2px 20px 0">${warnHtml}</td></tr>` : ""}
  ${covHtml}
  <tr><td style="padding:16px 20px 0">
    <div style="font:600 13px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#16281f">评审意见（按文件）</div>
  </td></tr>
  <tr><td style="padding:0 20px">${fileBlocks || (unreviewed > 0
    ? `<div style="margin:12px 0;padding:16px;border:1px dashed #e0b07c;border-radius:5px;font:12.5px/1.7 ui-monospace,Menlo,Consolas,monospace;color:#9a4a1c;text-align:center">已评审的 ${covDone} 个文件没有提出意见。<br><span style="color:#b07a4a">⚠ 另有 ${unreviewed} 个文件未评审（${escH(covWhy)}），它们没有被检查过 —— 这不等于「没有问题」。</span></div>`
    : `<div style="margin:12px 0;padding:16px;border:1px dashed #dcdcd6;border-radius:5px;font:12.5px/1.7 ui-monospace,Menlo,Consolas,monospace;color:#6b7280;text-align:center">本次评审没有提出意见。</div>`)}</td></tr>
  <tr><td style="padding:16px 20px 0">
    <div style="font:11.5px/1.85 ui-monospace,Menlo,Consolas,monospace;color:#6b7280;border-top:1px dashed #dcdcd6;padding-top:10px">${escH(footTitle)}:<br>${footList.length ? footList.map((f) => "&nbsp;&nbsp;" + escH(f)).join("<br>") : "&nbsp;&nbsp;范围里没有可评审的改动" + (r.status === "skipped" ? "（通常是自上次评审以来没有新提交）" : "")}</div>
  </td></tr>
  ${commits.length ? `<tr><td style="padding:14px 20px 0">
    <div style="font:11.5px/1.85 ui-monospace,Menlo,Consolas,monospace;color:#6b7280;border-top:1px dashed #dcdcd6;padding-top:10px">covered commits (${commitsTotal}):<br>${commits.map((c) => "&nbsp;&nbsp;" + escH(String(c.sha || "").slice(0, 10)) + " " + escH(c.subject || "") + " <span style=\"color:#b0b0aa\">" + escH(c.author || "?") + (c.at ? " " + escH(bjTime(c.at)) : "") + "</span>").join("<br>")}</div>
  </td></tr>` : ""}
  <tr><td style="padding:14px 20px 20px;font:11px/1.7 ui-monospace,Menlo,Consolas,monospace;color:#9ca3af">-- generated by token-monitor · 意见为模型产出，需人工判断后采纳</td></tr>
</table>
</td></tr></table></body></html>`;
}

export function createCodeReview(d) {
  const { config, saveConfig, ocr, log = console.log, appRoot, port, notifyReview } = d;
  const getDb = () => d.db;

  // config.codeReview 缺失(全新安装且迁移还没跑)时按默认初始化,保证任何入口都不炸
  const cfg = () => (config.codeReview || (config.codeReview = sanitizeCodeReviewConfig({}, port)));
  const workspaceDir = () => cfg().workspaceDir || path.join(appRoot, "code-review-workspaces");
  const reposDir = () => path.join(workspaceDir(), "repos");
  const runsDir = () => path.join(workspaceDir(), "runs");
  // 交给引擎的两个输入文件(--rule 标准 / --background-file 业务背景)的落点。
  // ⚠️ 不能放 repos/ 下:那是 git 工作树,会被下一次评审当成新增文件评进去;
  //    也不能放 ocr-home/:ocrConfigMode:"host" 时那指向运维真实的 ~。
  const inputsDir = () => path.join(workspaceDir(), "inputs");
  const ocrHomeDir = () => path.join(workspaceDir(), "ocr-home");
  const findRepo = (idOrName) => (cfg().repos || []).find((r) => r.id === idOrName || r.name === idOrName) || null;

  // 业务背景 = 全局那段 + 本仓库那段(仓库在后:越具体的约定越该压过通用约定)。
  // 代码本身看不出「这笔钱该走哪个通道」「这个状态谁能改」,这些规则只能人写进来;
  // 它是评审「够谨慎」的前提 —— 不知道业务约束时,模型只能对通用坑位报告。
  function composeBackground(repo) {
    const g = String(cfg().background || "").trim();
    const r = String(repo?.overrides?.background || "").trim();
    return [g, r].filter(Boolean).join("\n\n");
  }

  function repoDir(id) {
    const dir = path.resolve(path.join(reposDir(), String(id)));
    if (!dir.startsWith(path.resolve(reposDir()) + path.sep)) throw new Error("仓库目录越出工作区");   // 穿越守卫(照 serveWiki)
    return dir;
  }

  // ── 队列(进程内;无新依赖) ──
  const queue = [];
  const running = new Map();     // runId -> { child, repoId }
  const repoBusy = new Set();

  function hasActiveRun(repoId) {
    return [...running.values()].some((r) => r.repoId === repoId) || queue.some((j) => j.repoId === repoId);
  }
  function activeRunId(repoId) {
    for (const [runId, r] of running) if (r.repoId === repoId) return runId;
    const q = queue.find((j) => j.repoId === repoId);
    return q ? q.runId : null;
  }

  const db = () => getDb();

  // from/to 只有「手动按范围补评」才会带值(正常增量评审的端点在跑起来时才解析得出来)。
  // 先把它们写进去:补评的队列可能在排到之前就被取消/重启收割,那条记录至少还能说明
  // 「本来要评哪一段」。
  function insertRun({ repoId, repoName, trigger, actor, branch, from, to, pusherEmail = null }) {
    const info = db().prepare(`INSERT INTO code_review_runs (repo_id, repo_name, trigger, actor, branch, from_commit, to_commit, status, created_at, pusher_email)
      VALUES (?,?,?,?,?,?,?,'queued',?,?)`).run(repoId, repoName, trigger, actor || null, branch || null, from || null, to || null, new Date().toISOString(), pusherEmail);
    return Number(info.lastInsertRowid);
  }
  const setRun = (id, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    db().prepare(`UPDATE code_review_runs SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`).run(...keys.map((k) => fields[k]), id);
  };
  const getRunRow = (id) => db().prepare("SELECT * FROM code_review_runs WHERE id=?").get(id);

  // 状态行按 (仓库, 分支) 定位 —— 见 initCodeReviewDb 里换主键的原委:一份共享游标
  // 会被「这次评 master、下次评 feature」来回推,推到别的分支的提交上时就再也不是
  // 目标提交的祖先,增量判定随之失效。所以游标必须一条分支一份。
  function setState(repoId, branch, fields) {
    const keys = Object.keys(fields);
    const b = String(branch || "");
    if (!keys.length) return;
    db().prepare(`INSERT INTO code_review_repo_state (repo_id, branch, ${keys.join(",")}, updated_at) VALUES (?,?${",?" .repeat(keys.length)}, ?)
      ON CONFLICT(repo_id, branch) DO UPDATE SET ${keys.map((k) => `${k}=excluded.${k}`).join(",")}, updated_at=excluded.updated_at`)
      .run(repoId, b, ...keys.map((k) => fields[k]), new Date().toISOString());
  }
  const getState = (repoId, branch = "") =>
    db().prepare("SELECT * FROM code_review_repo_state WHERE repo_id=? AND branch=?").get(repoId, String(branch || "")) || {};

  // ── 入队 ──
  function enqueue(repoIdOrName, { trigger = "manual", actor = "admin", from = null, to = null, dedupe = true, branch = null, pusherEmail = null } = {}) {
    if (!cfg().enabled) { const e = new Error("代码评审功能未启用"); e.statusCode = 409; throw e; }
    const repo = findRepo(repoIdOrName);
    if (!repo || !repo.enabled) { const e = new Error("仓库不存在或已停用"); e.statusCode = 404; throw e; }
    // 手动补评的范围:必须**同时**给 from 与 to,且都是十六进制提交号。只给一半、
    // 或者给 `HEAD~1` 这种表达式,一律拒绝 —— 半截范围会静默变成一次正常增量评审,
    // 而管理员以为补评已经发生了。
    const hasRangeInput = (from != null && from !== "") || (to != null && to !== "");
    const manualFrom = isValidCommitRef(from) ? from : null;
    const manualTo = isValidCommitRef(to) ? to : null;
    if (hasRangeInput && (!manualFrom || !manualTo)) {
      const e = new Error("补评范围需要同时给出合法的 from 与 to（7~40 位十六进制提交号）"); e.statusCode = 400; throw e;
    }
    const manual = !!(manualFrom && manualTo);
    // 补评**不参与去重**:同仓库正在跑时去重会直接返回那条正在跑的 runId,补评就静默
    // 没发生。范围补评本来就是显式的一次性操作,让它排队等即可。
    if (dedupe && !manual && hasActiveRun(repo.id)) return { runId: activeRunId(repo.id), deduped: true };
    // 按次指定分支(面板下拉):只对本次生效,不写回仓库配置。非法值一律拒绝,
    // 不静默回落 —— 否则管理员以为评的是那条分支,实际评的是另一条。
    if (branch != null && branch !== "" && !isValidBranch(branch)) {
      const e = new Error(`分支名不合法: ${String(branch).slice(0, 60)}`); e.statusCode = 400; throw e;
    }
    const useBranch = isValidBranch(branch) ? branch : repo.branch;
    const limitBytes = cfg().perRepoDiskLimitMB * 1024 * 1024;
    if (dirSizeBytes(repoDir(repo.id)) > limitBytes) {
      notifyReview?.({ kind: "disk_full", repo });
      const e = new Error(`工作区磁盘超限(${cfg().perRepoDiskLimitMB}MB)`); e.statusCode = 413; throw e;
    }
    if (budgetExhausted()) {
      const runId = insertRun({ repoId: repo.id, repoName: repo.name, trigger, actor, branch: useBranch, from: manualFrom, to: manualTo });
      setRun(runId, { status: "skipped", note: "超出当日 token 预算", finished_at: new Date().toISOString() });
      return { runId, skipped: true };
    }
    const runId = insertRun({ repoId: repo.id, repoName: repo.name, trigger, actor, branch: useBranch, from: manualFrom, to: manualTo, pusherEmail: pusherEmail || null });
    setState(repo.id, useBranch, { queued_at: new Date().toISOString() });
    queue.push({ runId, repoId: repo.id, branch: useBranch, from: manualFrom, to: manualTo });
    pump();
    return { runId };
  }

  function pump() {
    const cap = cfg().maxParallelJobs || 1;
    while (running.size < cap) {
      const i = queue.findIndex((j) => !repoBusy.has(j.repoId));
      if (i < 0) return;
      const job = queue.splice(i, 1)[0];
      repoBusy.add(job.repoId);
      running.set(job.runId, { repoId: job.repoId, child: null });   // 登记:hasActiveRun/取消都靠它
      startJob(job).catch((err) => {
        log(`[代码评审] 任务异常 run#${job.runId}: ${err.message}`);
      }).finally(() => {
        repoBusy.delete(job.repoId);
        running.delete(job.runId);
        pump();
      });
    }
  }

  // ── 单次运行:同步 → 评审 → 解析 → 落库 ──
  async function startJob({ runId, repoId, branch: jobBranch = null, from: jobFrom = null, to: jobTo = null }) {
    const repo = findRepo(repoId);
    if (!repo) { setRun(runId, { status: "failed", error: "仓库已删除", finished_at: new Date().toISOString() }); return; }
    const dir = repoDir(repo.id);
    // 本次要评的分支取自**这条运行记录**:面板可以按次换分支(不写回仓库配置),
    // 所以不能在这里读 repo.branch —— 否则选了分支也评的是仓库默认分支。
    const runBranch = getRunRow(runId)?.branch || jobBranch || repo.branch;
    setRun(runId, { status: "syncing", started_at: new Date().toISOString() });
    // 手动补评(面板里显式给了范围):目标是**指定的那个提交**,不是分支 HEAD。
    const manual = isValidCommitRef(jobFrom) && isValidCommitRef(jobTo);
    try {
      await ensureRepo(repo, dir, runBranch);
      const head = await revParse(repo, dir);
      if (!head) throw new Error("无法解析目标提交");
      const to = manual ? jobTo : head;
      if (manual) {
        // 先把「本来要评哪一段」落库再校验:提交不在克隆里时运行会失败,而失败记录如果
        // 连范围都没写,管理员就不知道当时填的是哪两个提交。后面解析出结果会整体覆盖。
        setRun(runId, {
          from_commit: jobFrom, to_commit: jobTo, range_mode: "range",
          range_source: "manual", range_note: "手动补评：管理员显式指定的范围（不推进游标）",
        });
        // 工作区只 clone 了配置分支那一条线(见 ensureRepo),补评的提交未必在里面。
        // 拿不到就明确失败 —— 静默评成别的区间等于骗人。
        for (const sha of [jobFrom, jobTo]) {
          const ok = await ocr.git(["-C", dir, "cat-file", "-e", `${sha}^{commit}`], { cwd: dir, timeoutMs: 30000 });
          if (ok.code !== 0) throw new Error(`提交 ${String(sha).slice(0, 8)} 不在当前克隆里（工作区只拉取分支「${runBranch}」）:请先把该仓库分支改成包含它的分支，再按范围补评`);
        }
      }
      // 提交作者:通知要发给「写这段代码的人」,而引擎的产出里没有作者信息 ——
      // 只能网关自己问 git。取不到(浅克隆/作者缺失)就留空,不影响评审本身。
      let author = null;
      try { author = await commitAuthor(dir, to); } catch { author = null; }
      if (author) setRun(runId, { author_name: author.name, author_email: author.email });
      const st = getState(repo.id, runBranch);
      const range = manual
        ? await manualRange(dir, jobFrom, jobTo)
        : await resolveRange({ dir, to, cursor: st.last_commit || null, coldStartCommits: repo.overrides.coldStartCommits ?? cfg().coldStartCommits });
      const from = range.from;
      const mode = range.mode;
      // 「这次覆盖了哪些提交」必须在起引擎**之前**落库:失败的运行也要能看出本来要评哪一段。
      const commits = await listCommits(dir, from, to).catch(() => null);
      setRun(runId, {
        status: "running", from_commit: from, to_commit: to, range_mode: mode,
        range_source: range.source, range_note: range.note || null,
        commits_json: commits ? capCommitsJson(commits.list) : null,
        commits_count: commits ? commits.total : 0,
      });
      const outPath = path.join(runsDir(), `${runId}.json`);
      fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
      // 统一评审标准 + 业务背景落盘(内容寻址:同内容同文件名,并发/重跑都不会写坏)。
      // **先落库版本号、再起引擎**:这次运行用的是哪一版标准,连失败的运行也要看得见。
      // 标准不可用(段文件缺失、没有 **/* 兜底)时这里抛错 → 本次运行 failed 并说明原因;
      // 绝不静默降级成「没有标准」—— 那正是这个功能要消灭的东西。
      const inputs = writeReviewInputs(inputsDir(), { background: composeBackground(repo) });
      setRun(runId, { standard_version: inputs.standardVersion });
      // 标准版本同时进服务日志:运行记录被清理(retention)之后,「那时候用的是哪版标准」
      // 仍然查得到 —— 意见条数的跨版本变化全靠它归因,只存库是会被删掉的。
      log(`[代码评审] run#${runId} 标准 v${inputs.standardVersion}${inputs.backgroundPath ? " + 业务背景" : "(无业务背景)"}`);
      const args = ocr.buildReviewArgs({ dir, mode, from, to, outPath, repo, inputs });
      const before = counterSnapshot(cfg().providerKey);
      const hardCapMs = ((repo.overrides.timeoutMinutes || cfg().defaultTimeoutMinutes) * 60_000 + 300_000);
      const res = await ocr.runReview({
        dir, args, repo,
        token: repo.authType === "token" ? repo.credential : null,
        username: repo.authType === "token" ? repo.username : null,
        sshKeyPath: repo.authType === "sshKey" ? repo.credential : null,
        timeoutMs: hardCapMs,
        onSpawn: (child) => { const r = running.get(runId); if (r) r.child = child; },
      });
      setRun(runId, { status: "parsing", exit_code: res.code });
      let report = null;
      try { report = ocr.readReport(outPath); } catch (err) {
        setRun(runId, { status: "failed", error: `评审输出不可用: ${err.message}`, finished_at: new Date().toISOString() });
        if (res.stderr) log(`[代码评审] run#${runId} stderr: ${res.stderr.slice(0, 300)}`);
        notifyFailure(repo, runId, "failed");
        return;
      }
      const after = counterSnapshot(cfg().providerKey);
      persistReport(runId, repo, report, { outPath, before, after, res, from, to, mode, author, branch: runBranch, manual });
      // 补评**不推进游标**:高水位线不能因为补了一段历史就往回拉(那会让下一次常规
      // 评审把已经评过的区间再评一遍)。状态行也一并跳过 —— 补评不该改写
      // 「上次运行时刻」,否则定时任务会被这次人工操作悄悄推到下一个周期。
      if (!manual) advanceCursor(repo.id, runBranch, { commit: to, runId, status: report.status });
    } catch (err) {
      const status = err && err.message === "timeout" ? "timeout" : "failed";
      setRun(runId, { status, error: String(err.message || err).slice(0, 500), finished_at: new Date().toISOString() });
      // 补评失败不写状态行:它不是这条分支的常规水位线,不该推高失败计数或改写
      // 「上次运行时刻」(运行记录自己会留下失败原因)。
      if (!manual) {
        const prev = getState(repo.id, runBranch);
        setState(repo.id, runBranch, { consecutive_failures: (prev.consecutive_failures || 0) + 1, last_status: status, last_run_at: new Date().toISOString() });
      }
      // 「跑都没跑起来」(clone/fetch 失败、超时、引擎缺失)最需要推给管理员 ——
      // 这条路径原先只有日志,通知设置成「仅失败时」反而一声不响。
      notifyFailure(repo, runId, status);
    }
  }

  // 运行未走到解析阶段的失败:合成一个只带状态的 report,交给通知层统一判断
  function notifyFailure(repo, runId, status) {
    notifyReview?.({ kind: "run", repo, runId, report: { status, comments: [] } });
  }

  // 未评原因的机器词 → 人话。⚠️ 认不出的分类**原样透出**,不吞:吞掉就等于又回到
  // 「说了等于没说」—— 引擎将来加一个新分类,我们要能一眼看见它。
  const CLASS_ZH = { budget: "超出单次 token 预算" };
  function coverWhyText(cov) {
    const by = cov && cov.byClass && typeof cov.byClass === "object" ? cov.byClass : null;
    if (!by) return "";
    const entries = Object.entries(by).filter(([, n]) => Number(n) > 0);
    if (!entries.length) return "";
    const multi = entries.length > 1;
    return `(${entries.map(([k, n]) => (multi ? `${n} 个${CLASS_ZH[k] || k}` : CLASS_ZH[k] || k)).join(" / ")})`;
  }

  // 给人看的一句话结论。OCR 原样回的是英文(message),直接展示等于没说 —— 这里按
  // 「网关已知的事实」(范围、状态、文件数、意见数)重写:尤其「已跳过」必须说清原因,
  // 否则管理员只看到一个「已跳过」,不知道是没新提交、还是被预算拦了、还是出了别的岔子。
  function reviewNote(report, { from, to, mode, manual = false }) {
    const s = report.summary || {};
    const files = Number(s.files_reviewed) || 0;
    // ⚠️ 用**实际入库条数**,不用引擎自报数(s.comments):机械兜底会丢弃缺少推理依据的
    // 意见,继续用自报数就会出现「结论说 3 条、列表里只有 1 条」这种对不上的账。
    const comments = Array.isArray(report.comments) ? report.comments.length : (Number(s.comments) || 0);
    const dropped = Number(report.droppedComments) || 0;
    const emptyRange = mode === "range" && from && to && from === to;
    if (report.status === "skipped") {
      return emptyRange ? "自上次评审以来没有新提交(范围为空),本次无需评审"
        : "没有可评审的改动(引擎未选中任何条目)";
    }
    if (report.status === "failed") return String(report.message || "评审失败").slice(0, 500);
    const scope = manual ? "补评" : mode === "single" ? "单提交" : "增量";
    const tail = comments ? `提出 ${comments} 条意见` : "未发现问题";
    // 丢弃条数必须写出来:否则「意见变少」会被读成「代码没问题」。
    const dropNote = dropped ? `(另有 ${dropped} 条因缺少取证推理被丢弃)` : "";
    // 安全阀(整轮意见都没有推理字段)时不过滤,但要说清这次没过滤。
    const valveNote = report.filterSkipped ? "(本轮意见均缺少推理字段,已跳过该过滤)" : "";
    // ── 没评全时绝不说「未发现问题」 ──────────────────────────────────────────
    // ⚠️ `summary.files_reviewed` 是**选中**数,不是**已评**数(实测 5 条历史运行恒等于
    // coverage.selected)。单拿它下结论,就会重演 run#9:39 个文件报「未发现问题」,
    // 而真相是 39 个里只评了 10 个。所以有没有评全,**只能**看 manifest 的 coverage。
    const cov = report.coverage || null;
    const unreviewed = cov ? Math.max(0, Number(cov.failed) || 0) : 0;
    if (unreviewed > 0) {
      const done = Number(cov.completed) || 0;
      return `${scope}评审只完成了一部分:选取 ${files} 个文件,评了 ${done} 个,${unreviewed} 个未评审`
        + `${coverWhyText(cov)};已评的 ${done} 个${tail}${dropNote}${valveNote}`;
    }
    return `${scope}评审完成:选取 ${files} 个文件,${tail}${dropNote}${valveNote}`;
  }

  function persistReport(runId, repo, report, { outPath, before, after, res, from, to, mode, author = null, branch = null, manual = false }) {
    const s = report.summary || {};
    const now = new Date().toISOString();
    const tokens = (k) => Number(s[k]) || 0;
    setRun(runId, {
      status: report.status,
      files_reviewed: tokens("files_reviewed"),
      // ⚠️ 入库条数 = 通过机械兜底的那些,不是引擎自报的 comments。两者不等时差额记在
      // dropped_comments 里(见下),界面上要一起展示,不能只显示一个更小的数。
      comments_count: Array.isArray(report.comments) ? report.comments.length : tokens("comments"),
      dropped_comments: Number(report.droppedComments) || 0,
      input_tokens: tokens("input_tokens"),
      output_tokens: tokens("output_tokens"),
      cache_read_tokens: tokens("cache_read_tokens"),
      cache_write_tokens: tokens("cache_write_tokens"),
      elapsed_ms: parseElapsed(s.elapsed),
      attributed_requests: after.req - before.req,
      attributed_input: after.inp - before.inp,
      attributed_output: after.out - before.out,
      ocr_model: report.llm.model || null,
      ocr_provider: report.llm.provider || null,
      session_id: report.sessionId,
      warnings_json: capJsonList(report.warnings, { maxItems: 200, maxBytes: WARNINGS_MAX }),
      // 到底评了哪些文件 / 引擎干了多少活 —— 列表和详情都靠它回答「有没有真干活」
      // ⚠️ 这份清单是**选中**集(来自 groups),不是**已评**集 —— 已评清单在 coverage_json 里。
      files_json: capJsonList(report.files, { maxItems: 500, maxBytes: FILES_MAX }),
      // 工具调用是**一个对象**(不是列表),不能按条目裁。超限时只保留最要紧的两个数,
      // 而不是切出半个 JSON 让前端静默拿不到任何东西。
      tool_calls_json: (() => {
        if (!report.toolCalls) return null;
        const full = JSON.stringify(report.toolCalls);
        if (full.length <= 2000) return full;
        return JSON.stringify({ total: report.toolCalls.total || 0, failure: report.toolCalls.failure || 0, truncated: 1 });
      })(),
      // 覆盖率:未评几个(标量,列表/通知/结论用)+ 完整明细(详情用,不进 RUN_LIST_COLS)
      unreviewed_count: report.coverage ? Math.max(0, Number(report.coverage.failed) || 0) : 0,
      coverage_json: report.coverage ? JSON.stringify(report.coverage) : null,
      raw_path: outPath,
      error: report.status === "failed" ? String(report.message || res.stderr || "评审失败").slice(0, 500) : null,
      // ⚠️ note 只放**结论**。范围来源(range_note)另有一列 —— 早先把「为什么退化成
      // 单提交」写在 note 里,跑完就被这里整个覆盖,界面上再也看不出退化原因。
      note: reviewNote(report, { from, to, mode, manual }),
      finished_at: now,
    });
    if (cfg().storeComments && report.comments.length) {
      const ins = db().prepare(`INSERT INTO code_review_comments (run_id, repo_id, idx, path, start_line, end_line, content, existing_code, suggestion_code, thinking, truncated)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      const tx = db().transaction(() => {
        report.comments.forEach((c, i) => {
          const content = cut(c?.content), existing = cut(c?.existing_code), suggestion = cut(c?.suggestion_code), thinking = cut(c?.thinking);
          ins.run(runId, repo.id, i, String(c?.path || "?").slice(0, 512),
            Number.isFinite(c?.start_line) ? c.start_line : null, Number.isFinite(c?.end_line) ? c.end_line : null,
            content.v, existing.v, suggestion.v, thinking.v,
            content.t || existing.t || suggestion.t || thinking.t ? 1 : 0);
        });
      });
      tx();
    }
    const cov = report.coverage;
    const covLog = cov
      ? `, 覆盖 ${Number(cov.completed) || 0}/${Number(cov.selected) || 0}`
        + (Number(cov.failed) > 0 ? `(${Number(cov.failed)} 未评审: ${Object.keys(cov.byClass || {}).join("/") || "未知原因"}) ⚠ 覆盖不全` : "")
        + (cov.ocrVersion ? `, ocr ${cov.ocrVersion}` : "")
      : "";
    log(`[代码评审] run#${runId} ${repo.name}: ${report.status}, ${report.comments.length} 条意见, ${tokens("total_tokens")} token${covLog}`);
    notifyReview?.({ kind: "run", repo, runId, report, author, branch, mode, to });
  }

  function advanceCursor(repoId, branch, { commit, runId, status }) {
    const advance = TERMINAL_OK.has(status);
    const prev = getState(repoId, branch);
    setState(repoId, branch, {
      last_commit: advance ? commit : prev.last_commit || null,
      last_run_id: runId, last_run_at: new Date().toISOString(), last_status: status,
      consecutive_failures: advance ? 0 : (prev.consecutive_failures || 0),
    });
    if (advance) setRun(runId, { cursor_advanced: 1 });
  }

  // ── git ──
  // repoAuth 见下方 git 段(branch 参数 = 本次要评的分支,缺省用仓库配置里的)
  async function ensureRepo(repo, dir, branch) {
    const auth = repoAuth(repo);
    // 本次生效的分支:调用方传入(按次选择)优先,否则用仓库配置
    const want = isValidBranch(branch) ? branch : repo.branch;
    const ws = workspaceDir();
    fs.mkdirSync(path.join(ws, "tmp"), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(dir, ".git"))) {
      fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
      const src = repo.source === "local" ? repo.localPath : repo.url;
      if (repo.source === "local" && !fs.existsSync(src)) throw new Error("本地仓库路径不存在");
      const r = await ocr.git(["clone", "--no-tags", "--single-branch", "--branch", want, "--", src, dir], { cwd: workspaceDir(), timeoutMs: 300000, ...auth });
      if (r.code !== 0) throw new Error(`clone 失败: ${(r.stderr || r.error || "").slice(0, 300)}`);
    }
    // 每次评审前同步到目标分支最新:remote 从线上 fetch;local 从本地路径 fetch
    // (clone 时 origin 就指向那个本地路径,fetch 能拿到它的新提交 —— 只 checkout
    // 不 fetch 的话,本地仓库后续提交永远进不了评审,这是 P1 踩过的坑)。
    // 注意:clone 带 --single-branch,工作区里可能只有别的一条分支 —— 所以换分支不能
    // 只 checkout,必须 fetch 目标分支再 reset 到 FETCH_HEAD(对两种情况都成立)。
    // 工作区里只看得到**已提交**的内容:本地未 commit 的改动不会被评审。
    const f = await ocr.git(["-C", dir, "fetch", "--no-tags", "--prune", "origin", want], { cwd: dir, timeoutMs: 180000, ...auth });
    if (f.code !== 0) throw new Error(`fetch 失败: ${(f.stderr || f.error || "").slice(0, 300)}`);
    const rs = await ocr.git(["-C", dir, "reset", "--hard", "FETCH_HEAD"], { cwd: dir, timeoutMs: 60000 });
    if (rs.code !== 0) throw new Error(`reset 失败: ${(rs.stderr || "").slice(0, 300)}`);
  }

  // 取某个提交的作者(名 + 邮箱)。取不到就返回 null —— 通知链路不能因为
  // 「这条提交没写作者」而整个失败。--format 用换行分隔,一次调用拿两个字段。
  async function commitAuthor(dir, sha) {
    if (!isValidCommitRef(sha)) return null;
    const r = await ocr.git(["-C", dir, "log", "-1", "--format=%an%n%ae", sha], { cwd: dir, timeoutMs: 30000 });
    if (r.code !== 0) return null;
    const [name, email] = String(r.stdout || "").split("\n").map((x) => x.trim());
    if (!email) return null;
    return { name: (name || "").slice(0, 200), email: email.slice(0, 200) };
  }

  async function revParse(repo, dir) {
    const r = await ocr.git(["-C", dir, "rev-parse", "HEAD"], { cwd: dir, timeoutMs: 30000 });
    return r.code === 0 ? r.stdout.trim() : null;
  }
  async function isAncestor(dir, a, b) {
    if (!isValidCommitRef(a) || !isValidCommitRef(b)) return false;
    const r = await ocr.git(["-C", dir, "merge-base", "--is-ancestor", a, b], { cwd: dir, timeoutMs: 30000 });
    return r.code === 0;
  }

  // ── 本次评审的起点怎么定 ────────────────────────────────────────────────
  // 抽成一处的原因:这条判定以前内联在 startJob 里,只有「有游标 / 没游标」两态,
  // 没游标时直接退化成「只评最新一个提交」—— 于是合并带进来的那 5 个提交全被跳过。
  //
  // 四种来源(range_source):
  //   manual    手动按范围补评:原样使用调用方给的两个端点(不推进游标)
  //   cursor    正常增量:游标是目标提交的祖先 → from=游标,覆盖区间内全部提交
  //   cold      冷启动:这条分支还没有游标 → 回溯 N 个提交
  //   rewritten 游标失效:历史被改写(force push / rebase),游标不再是祖先 → 回溯 N 个提交
  //   兜底 single:连 N 步都解析不出来(根提交附近) → 只评最新一个提交
  //
  // ⚠️ 为什么不是「游标失效就无脑用 range」:游标失效有两种——在目标**上游**(历史被
  // 改写,区间非空)和在目标**下游**(比如游标其实来自另一条分支,merge-base(from,to)
  // 恰是 to 本身,区间为空,diff 一条都取不到)。后者无脑用 range 会评出「零文件」,
  // 看起来像「没有改动」,比单提交评审更具欺骗性。所以失效时一律换一个**有意义的新起点**。
  async function resolveRange({ dir, to, cursor = null, coldStartCommits }) {
    const cur = isValidCommitRef(cursor) ? cursor : null;
    if (cur) {
      if (cur === to) return { mode: "range", from: cur, to, source: "cursor", note: null };
      if (await isAncestor(dir, cur, to)) return { mode: "range", from: cur, to, source: "cursor", note: null };
    }
    const n = clampColdStart(coldStartCommits);
    const base = await resolveBase(dir, to, n);
    if (base) {
      return {
        mode: "range", from: base, to, source: cur ? "rewritten" : "cold",
        note: cur
          ? `上次评到的提交(${cur.slice(0, 8)})已不在当前历史里（历史被改写）,回退为最近 ${n} 个提交`
          : `这条分支首次评审:回溯最近 ${n} 个提交`,
      };
    }
    return { mode: "single", from: null, to, source: "cold", note: "首次评审:只评最新提交" };
  }

  // 手动按范围补评:两个端点原样用,但有两种情况必须先说清楚 ——
  //   · from === to:长度为 0 的区间,引擎会得出一份空 diff 并报「已跳过」,看起来像
  //     「没有改动」。管理员的意思显然是「就评这一个提交」,所以改走单提交口径。
  //   · from 不是 to 的祖先:引擎内部按 merge-base(from,to)..to 取净差异,实际评的
  //     区间比填进去的那一对要宽/不同。argv 保持原样(不替调用方改口径),但把这个
  //     事实写进范围说明,免得事后对不上「为什么评了这些文件」。
  async function manualRange(dir, from, to) {
    if (from === to) {
      return { mode: "single", from: null, to, source: "manual", note: `手动补评指定提交 ${String(to).slice(0, 8)}（不推进游标）` };
    }
    let note = `手动按范围补评 ${String(from).slice(0, 8)}→${String(to).slice(0, 8)}（不推进游标）`;
    if (!(await isAncestor(dir, from, to))) {
      const mb = await ocr.git(["-C", dir, "merge-base", from, to], { cwd: dir, timeoutMs: 30000 });
      const base = mb.code === 0 ? String(mb.stdout || "").trim().split("\n")[0].trim() : "";
      note += isValidCommitRef(base)
        ? `（给定的 from 不是 to 的祖先,实际按共同祖先 ${base.slice(0, 8)}→${String(to).slice(0, 8)} 取净差异）`
        : "（给定的 from 不是 to 的祖先,实际区间由引擎按共同祖先确定）";
    }
    return { mode: "range", from, to, source: "manual", note };
  }

  // 回溯 N 步的起点。to~N 走的是**第一父链**:N=1 落在这个提交的父上(等价于只评它自己),
  // N=2 才落在 to~1 那个合并提交的第一父上 —— 也就是把合并**带进来**的内容算进去。
  // 实测(真实仓库,合并提交 a62a0900):~1 命中 1 个文件、~2 命中 12 个、~5 命中 38 个。
  async function resolveBase(dir, to, n) {
    if (!isValidCommitRef(to)) return null;
    const steps = clampColdStart(n);
    const r = await ocr.git(["-C", dir, "rev-parse", "--verify", "-q", `${to}~${steps}`], { cwd: dir, timeoutMs: 30000 });
    const sha = r.code === 0 ? String(r.stdout || "").trim().split("\n")[0].trim() : "";
    if (isValidCommitRef(sha)) return sha;
    // 第一父链不足 N 步(仓库历史还很短):夹到根提交。不能再往前了 ——
    // 根提交没有父,`<root>~1` 直接解析失败(实测),所以这里必须有这一层夹取。
    const root = await ocr.git(["-C", dir, "rev-list", "--max-parents=0", to], { cwd: dir, timeoutMs: 30000 });
    const first = root.code === 0 ? String(root.stdout || "").trim().split("\n")[0].trim() : "";
    if (!isValidCommitRef(first) || first === to) return null;   // to 本身就是根提交:没有可回溯的区间
    return first;
  }

  // 「这次覆盖了哪些提交」:from..to 会**同时列出合并第二父链上的提交**(它们不在 from
  // 的可达集里),这正是「本次 diff 里反映了的提交」的完整集合 —— 也正是拿着两个端点
  // 数字看不出、需要清单才能核对的东西。
  // 总条数用 rev-list --count(不受清单截断影响),清单本身封顶 COMMITS_MAX 条。
  async function listCommits(dir, from, to) {
    if (!isValidCommitRef(to)) return null;
    const range = isValidCommitRef(from) ? `${from}..${to}` : null;
    let total = 1;
    if (range) {
      const c = await ocr.git(["-C", dir, "rev-list", "--count", range], { cwd: dir, timeoutMs: 30000 });
      total = c.code === 0 ? (Number(String(c.stdout || "").trim()) || 0) : 0;
    }
    // %x1f / %x1e 做字段与记录分隔:subject 里出现奇怪字符也不会切错行
    const r = await ocr.git(["-C", dir, "log", "--date-order", "--max-count=" + COMMITS_MAX,
      "--format=%H%x1f%an%x1f%aI%x1f%s%x1e", ...(range ? [range] : ["-1", to])],
      { cwd: dir, timeoutMs: 60000 });
    const list = [];
    if (r.code === 0) {
      for (const rec of String(r.stdout || "").split("\x1e")) {
        const line = rec.replace(/^\n+/, "");
        if (!line.trim()) continue;
        const [sha, author, at, subject] = line.split("\x1f");
        const s = String(sha || "").trim();
        if (!isValidCommitRef(s)) continue;
        list.push({
          sha: s.slice(0, 40),
          subject: String(subject || "").trim().slice(0, 200),
          author: String(author || "").trim().slice(0, 120),
          at: String(at || "").trim().slice(0, 40),
        });
        if (list.length >= COMMITS_MAX) break;
      }
    }
    return { total: Math.max(total, list.length), list };
  }
  // git 凭据参数(唯一构造点):凭据只经子进程环境变量传给 askpass 脚本,不进 argv。
  function repoAuth(repo) {
    return {
      token: repo.authType === "token" ? repo.credential : null,
      username: repo.authType === "token" ? repo.username : null,
      sshKeyPath: repo.authType === "sshKey" ? repo.credential : null,
    };
  }

  async function testRepo(repo) {
    const auth = repoAuth(repo);
    if (repo.source === "local") {
      // 本地来源:路径要存在,且得是个 git 仓库(有 .git)——否则 clone 时才报错太晚
      if (!repo.localPath) return { ok: false, detail: "未填本地路径" };
      if (!fs.existsSync(repo.localPath)) return { ok: false, detail: `路径不存在（容器部署填的是容器内路径）：${repo.localPath}` };
      const isRepo = fs.existsSync(path.join(repo.localPath, ".git"));
      return { ok: isRepo, detail: isRepo ? `本地仓库就绪：${repo.localPath}` : `该目录不是 git 仓库（缺 .git）：${repo.localPath}` };
    }
    const r = await ocr.git(["ls-remote", "--heads", "--", repo.url, repo.branch], { cwd: workspaceDir(), timeoutMs: 20000, ...auth });
    if (r.code !== 0) return { ok: false, detail: (r.stderr || r.error || "连接失败").slice(0, 300) };
    return { ok: true, detail: r.stdout.split("\n")[0].slice(0, 120) || "已连接" };
  }

  // 列出仓库的分支(供面板按次选分支、设置页 datalist)。默认分支排首位,其余按字典序。
  // remote 走 ls-remote --heads(只列分支,不拉对象);local 走 for-each-ref(不依赖网络)。
  async function listBranches(repo) {
    const def = isValidBranch(repo.branch) ? repo.branch : "";
    const order = (names) => {
      const uniq = [...new Set(names.filter((n) => isValidBranch(n)))].sort();
      return def && uniq.includes(def) ? [def, ...uniq.filter((n) => n !== def)] : uniq;
    };
    if (repo.source === "local") {
      if (!repo.localPath || !fs.existsSync(path.join(repo.localPath, ".git"))) {
        return { ok: false, branches: [], detail: "本地路径不存在或不是 git 仓库" };
      }
      const r = await ocr.git(["-C", repo.localPath, "for-each-ref", "--format=%(refname:short)", "refs/heads/"], { cwd: workspaceDir(), timeoutMs: 20000 });
      if (r.code !== 0) return { ok: false, branches: [], detail: (r.stderr || r.error || "列分支失败").slice(0, 300) };
      const branches = order(r.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
      return { ok: true, branches, detail: `${branches.length} 条分支` };
    }
    // ls-remote 的 cwd 必须是已存在的目录;工作区可能还没建(首次评审前)
    fs.mkdirSync(workspaceDir(), { recursive: true, mode: 0o700 });
    const r = await ocr.git(["ls-remote", "--heads", "--", repo.url], { cwd: workspaceDir(), timeoutMs: 30000, ...repoAuth(repo) });
    if (r.code !== 0) return { ok: false, branches: [], detail: (r.stderr || r.error || "连接失败").slice(0, 300) };
    // 每行形如 "<sha>\trefs/heads/<name>"
    const branches = order(r.stdout.split("\n").map((line) => {
      const m = line.match(/refs\/heads\/(.+)$/);
      return m ? m[1].trim() : "";
    }).filter(Boolean));
    if (!branches.length) return { ok: false, branches: [], detail: "远端没有任何分支(或无权读取)" };
    return { ok: true, branches, detail: `${branches.length} 条分支` };
  }

  // ── 记账归因:评审 Key 在 users 表的计数器快照(run 前后取差值 = 网关侧实证) ──
  function counterSnapshot(key) {
    if (!key) return { req: 0, inp: 0, out: 0 };
    const row = db().prepare(`SELECT COALESCE(SUM(total_requests),0) r, COALESCE(SUM(total_input),0) i, COALESCE(SUM(total_output),0) o
      FROM users WHERE user_key=?`).get(key);
    return { req: Number(row?.r) || 0, inp: Number(row?.i) || 0, out: Number(row?.o) || 0 };
  }
  // 当日 token 消耗:**全局**(所有仓库合计),对应配置里的「当日 token 预算」。
  // ⚠️ created_at 存的是 UTC,所以用北京日界的 UTC 时刻做区间比较 —— 早先写成
  // `substr(created_at,1,10) <= 北京日期`,比的是日期字符串而不是「今天」,会把
  // 历史所有运行都算进来,预算一开就爆。
  function todayTokens() {
    const row = db().prepare(`SELECT COALESCE(SUM(input_tokens+output_tokens),0) t FROM code_review_runs
      WHERE created_at >= ?`).get(beijingDayStartUtc());
    return Number(row?.t) || 0;
  }
  const budgetExhausted = () => cfg().dailyTokenBudget > 0 && todayTokens() >= cfg().dailyTokenBudget;

  function dirSizeBytes(dir) {
    let total = 0;
    const walk = (p) => {
      let entries = [];
      try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(p, e.name);
        try {
          if (e.isDirectory()) walk(full);
          else if (e.isFile()) total += fs.statSync(full).size;
        } catch { /* 竞争删除忽略 */ }
      }
    };
    walk(dir);
    return total;
  }

  function cancel(runId) {
    const id = Number(runId);
    const r = running.get(id);
    if (r?.child) { try { r.child.kill("SIGTERM"); } catch { /* 已退出 */ } }
    const qi = queue.findIndex((j) => j.runId === id);
    if (qi >= 0) queue.splice(qi, 1);
    const row = getRunRow(id);
    if (!row) { const e = new Error("运行不存在"); e.statusCode = 404; throw e; }
    if (!TERMINAL.has(row.status)) {
      setRun(id, { status: "canceled", finished_at: new Date().toISOString() });
      return { canceled: true, wasRunning: !!r };
    }
    return { canceled: false, note: "已结束的运行不能取消" };
  }

  // 标记/撤销「已解决」:按整次运行一条,成员和管理员都可以点;不点就一直是未解决
  // (菜单角标因此常驻,直到处理完)。只允许终结态 —— 跑一半的 run 结果还会变,标了也是错的。
  // resolved 后同一仓库又来新 push 会产生新的未解决行,角标自然重新出现,无需特殊处理。
  function setRunResolved(runId, resolved, by) {
    const id = Number(runId);
    const row = getRunRow(id);
    if (!row) { const e = new Error("运行不存在"); e.statusCode = 404; throw e; }
    if (!TERMINAL.has(row.status)) { const e = new Error("运行尚未结束,不能标记已解决"); e.statusCode = 400; throw e; }
    const on = !!resolved;
    setRun(id, {
      resolved: on ? 1 : 0,
      resolved_at: on ? new Date().toISOString() : null,
      resolved_by: on ? String(by || "").slice(0, 128) : null,
    });
    return getRunRow(id);
  }

  // 启动收割:上一次进程留下的 queued/syncing/running/parsing 永远不会再推进
  function reapStale() {
    const n = db().prepare(`UPDATE code_review_runs SET status='failed', error='服务重启中断', finished_at=?
      WHERE status IN ('queued','syncing','running','parsing')`).run(new Date().toISOString()).changes;
    if (n) log(`[代码评审] 启动收割 ${n} 条中断的运行`);
    return n;
  }

  // 运行列表用到的列(见 listRuns 里的说明:刻意不含 commits_json)
  const RUN_LIST_COLS = `code_review_runs.id, repo_id, repo_name, trigger, actor, branch, from_commit, to_commit,
    range_mode, range_source, range_note, commits_count, status, exit_code, error, note, files_reviewed, comments_count,
    dropped_comments, standard_version,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, elapsed_ms,
    attributed_requests, attributed_input, attributed_output, ocr_model, ocr_provider, session_id,
    warnings_json, raw_path, cursor_advanced, notified, resolved, resolved_at, resolved_by,
    files_json, tool_calls_json, unreviewed_count, author_name, author_email, pusher_email, created_at, started_at, finished_at`;

  const listRuns = ({ repoId = null, status = null, limit = 50, offset = 0 } = {}) => {
    const where = [];
    const args = [];
    if (repoId) { where.push("repo_id=?"); args.push(repoId); }
    if (status) { where.push("status=?"); args.push(status); }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    // ⚠️ 列表**不带 commits_json**:一条最多 32KB,列表一次最多 200 条 = 好几 MB,
    // 而列表只需要计数(range_source/commits_count 是独立列)。完整清单由详情接口
    // (getRun / memberRun,都是 SELECT *)返回给弹层。
    // 显式列名是有意为之:以后给 runs 加列,若列表要用,必须在这里补上。
    const rows = db().prepare(`SELECT ${RUN_LIST_COLS}, (SELECT COUNT(*) FROM code_review_comments c WHERE c.run_id = code_review_runs.id AND c.dismissed = 1) AS dismissed_count FROM code_review_runs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, Math.min(200, limit), Math.max(0, offset));
    const total = db().prepare(`SELECT COUNT(*) n FROM code_review_runs ${w}`).get(...args).n;
    // 服务端算好「覆盖不全」再透出:前端各页面就不必各自去解析 warnings_json,
    // 老记录(#8/#9 那种 status 已经写错的)也才有一致的 ⚠ 口径。
    return { rows: rows.map((r) => ({ ...r, coverageIncomplete: coverageIncomplete(r) })), total };
  };
  const decorateRun = (row) => {
    if (!row) return row;
    // coverageIncomplete 与列表行口径一致(listRuns 也是这么算的):评全了的运行
    // 要显式给 false,否则详情弹层拿到 undefined、与列表行对不上。
    // displayPatch 若带回了真覆盖率,以它为准(权威度高于 warnings 派生)。
    const base = { ...row, coverageIncomplete: coverageIncomplete(row) };
    const patch = displayPatch(row);
    return patch ? { ...base, ...patch } : base;
  };
  // ⚠️ getRun 是**展示层**出口(详情弹层/报告 HTML/手动发送邮件都走它):
  // 老记录(#8/#9)的 status 与 note 在这里被纠正成真话,**不写回库、不碰游标**。
  // 写路径(setRunResolved / deleteRun / cancel)一律用 getRunRow 拿原始行。
  const getRun = (id) => {
    const row = getRunRow(Number(id));
    return row ? decorateRun(row) : null;
  };

  // ── 老记录的「覆盖率」按需补读(只读兜底,绝不改库) ────────────────────────────
  // 已定的决策:历史 #8/#9 不回填。它们库里的 status 当年经兜底写成了
  // completed_with_errors、note 还写着「未发现问题」,但**原始报告仍在盘上** ——
  // 详情弹层现场读一次就能拿回全部真相(选了 39、只评了 10、29 个为什么没评)。
  // ⚠️ 门控不能是「coverage_json 为空」:所有历史成功记录它都为空,那会给**全量历史**
  // 读文件。只有「状态像降级 + 没落过 coverage」才读。
  // ⚠️ 读是**同步**的(JSON.parse 阻塞事件循环),#8 已 282KB、大 monorepo 可到数十 MB,
  // 所以按 (raw_path, mtimeMs) 记忆化 —— 同一份文件只解析一次,报告被重写后自动失效。
  // ⚠️ 任何异常都吞掉返回 null:报告可能已被 prune / deleteRun / clearData 删掉,
  // 那时退化为「无覆盖率」,绝不能让详情页 500。
  const coverageCache = new Map();
  const COVERAGE_READ_STATUSES = new Set(["partial", "completed_with_errors"]);
  function coverageFromRaw(run) {
    try {
      if (!run || run.coverage_json) return null;
      if (!COVERAGE_READ_STATUSES.has(String(run.status || ""))) return null;
      const p = run.raw_path;
      if (!p) return null;
      let st = null;
      try { st = fs.statSync(p); } catch { return null; }   // 文件没了 → 无覆盖率
      const hit = coverageCache.get(p);
      if (hit && hit.mtimeMs === st.mtimeMs) return hit.coverage;
      // readReport 自带守卫:路径必须落在工作区内、拒绝符号链接、32MB 上限 ——
      // 不要再写第二份守卫(unlinkReport 那份是删除专用)。
      const cov = ocr.readReport(p).coverage || null;
      if (coverageCache.size > 200) coverageCache.clear();
      coverageCache.set(p, { mtimeMs: st.mtimeMs, coverage: cov });
      return cov;
    } catch { return null; }
  }

  // 详情接口的出参装饰:**只在展示层**把老记录纠正过来(不 UPDATE、不碰游标)。
  // 返回 { coverage, status, note, coverageIncomplete } 四个字段的补丁;
  // 报告读不到时全为 no-op,调用方原样返回库里的值。
  function displayPatch(run) {
    let cov = null;
    if (run.coverage_json) {
      try { cov = JSON.parse(run.coverage_json); } catch { cov = null; }
    }
    if (!cov) cov = coverageFromRaw(run);
    if (!cov) return null;
    const patch = { coverage: cov, coverageIncomplete: Number(cov.failed) > 0 };
    if (Number(cov.failed) > 0) {
      // 状态词表里「部分完成」才是真话:completed_with_errors 读起来像小毛病。
      patch.status = "partial";
      // 结论用 coverage 重算 —— 库里那句「未发现问题」是给 39 个文件打的包票,
      // 而其中 29 个从没被读过。其余字段(意见数/丢弃数)仍取库里已存的真值。
      patch.note = reviewNote({
        status: "partial",
        summary: { files_reviewed: Number(run.files_reviewed) || 0 },
        comments: new Array(Number(run.comments_count) || 0).fill(null),
        droppedComments: Number(run.dropped_comments) || 0,
        coverage: cov,
      }, { from: run.from_commit, to: run.to_commit, mode: run.range_mode, manual: run.range_source === "manual" });
    }
    return patch;
  }
  const listComments = (runId, { limit = 200, offset = 0 } = {}) => db()
    .prepare("SELECT * FROM code_review_comments WHERE run_id=? ORDER BY idx LIMIT ? OFFSET ?")
    .all(Number(runId), Math.min(500, limit), Math.max(0, offset));

  // 跨运行查意见(「我负责的仓库最近评出了哪些问题」)—— MCP 与成员页都用它。
  // 走 idx_cr_comments_path(repo_id 打头) + idx_cr_runs_repo,不需要新建索引。
  // repoIds 为空数组时返回空:调用方要给「允许看哪些仓库」,这里不做权限判断。
  function listFindings({ repoIds = [], since = null, limit = 20 } = {}) {
    const ids = Array.isArray(repoIds) ? repoIds.filter((x) => typeof x === "string" && x) : [];
    if (!ids.length) return [];
    const ph = ids.map(() => "?").join(",");
    const args = [...ids];
    let where = `c.repo_id IN (${ph})`;
    if (since) { where += " AND r.created_at >= ?"; args.push(since); }
    const rows = db().prepare(`
      SELECT c.path, c.start_line, c.end_line, c.content, c.suggestion_code, c.truncated, c.idx,
             r.id AS run_id, r.repo_id, r.repo_name, r.branch, r.from_commit, r.to_commit, r.range_mode,
             r.range_source, r.created_at, r.author_name, r.author_email
      FROM code_review_comments c JOIN code_review_runs r ON r.id = c.run_id
      WHERE ${where}
      ORDER BY r.id DESC, c.idx ASC
      LIMIT ?`).all(...args, Math.min(200, Math.max(1, limit)));
    return rows;
  }

  // 邮箱命中判定:run 的推送人/提交作者邮箱与该成员 email 相同(大小写不敏感)。
  // 用于「被定向通知到的非成员也能看到/解决自己的 run」这条可见性扩展;
  // pendingFindings / memberView / memberRun / canMemberSeeRun 四处共用同一份判定。
  const runEmailMatch = (row, email) => {
    const want = String(email || "").trim().toLowerCase();
    if (!want) return false;
    return String(row.pusher_email || "").trim().toLowerCase() === want
      || String(row.author_email || "").trim().toLowerCase() === want;
  };

  // 未解决计数(菜单角标):自己**看得到**的运行里「有意见、且未点已解决」的数量。
  // 可见性口径与 memberView 同源(仓库成员 OR 邮箱命中),在 JS 里过滤保证两处不漂移。
  // 拉最近 1000 条有意见的行 —— 团队规模足够,超限只是计数略保守,不崩。
  function pendingFindings(apiKey, { email = "", repoIds = null } = {}) {
    const allowed = new Set(repoIds || reposVisibleTo(apiKey).map((r) => r.id));
    const rows = db().prepare(`SELECT repo_id, pusher_email, author_email, resolved FROM code_review_runs
      WHERE comments_count > 0 ORDER BY id DESC LIMIT 1000`).all();
    let n = 0;
    for (const r of rows) {
      if (!allowed.has(r.repo_id) && !runEmailMatch(r, email)) continue;
      if (r.resolved) continue;   // 老行 resolved 为 NULL(列迁移补的),当未解决
      n++;
    }
    return n;
  }
  // 面板与接口按「仓库」看状态时取的是**配置分支**那一行(游标本身按分支各记一份)。
  // 消费方只有服务端两处(MCP code_review_list / 状态接口),都以 repo_id 为键取值,
  // 所以这里维持 { repo_id: stateRow } 的形状不变。
  function repoStates() {
    const byKey = new Map(db().prepare("SELECT * FROM code_review_repo_state").all()
      .map((r) => [`${r.repo_id} ${r.branch || ""}`, r]));
    const out = {};
    for (const repo of cfg().repos || []) out[repo.id] = byKey.get(`${repo.id} ${repo.branch || ""}`) || {};
    return out;
  }
  // 逐分支的原始状态行(每条 (仓库, 分支) 一行):面板要展示「这条分支评到哪了」时用它。
  const repoBranchStates = () => db().prepare("SELECT * FROM code_review_repo_state ORDER BY repo_id, branch").all();

  // 定时判定用的「这个仓库上次什么时候跑的」:取**所有分支里最近的那次**。
  // ⚠️ 不能只看配置分支那一行:面板可以按次指定分支(那一次会写进它自己那条分支的行),
  // 只看配置分支的话,「刚按次评完 master」之后定时器仍认为配置分支没评过 → 下一个 60s
  // 就再排一次,等于同一个仓库被连评两轮。改动前游标是每仓库一份、任何一次运行都会
  // 更新它,所以「所有分支取最大」正好等价于今天的行为。
  const lastRunAtAnyBranch = (repoId) => db()
    .prepare("SELECT MAX(last_run_at) t FROM code_review_repo_state WHERE repo_id=?").get(repoId)?.t || null;

  function status() {
    const c = cfg();
    const ws = workspaceDir();
    return {
      enabled: c.enabled,
      workspaceDir: ws,
      workspaceBytes: dirSizeBytes(ws),
      queue: queue.length,
      running: running.size,
      repos: (c.repos || []).length,
      // 面板下拉要的是仓库清单(id+名称+默认分支);repos 保持数量不变(状态行「仓库 N 个」在用)
      repoList: (c.repos || []).map((r) => ({ id: r.id, name: r.name, enabled: r.enabled !== false, branch: r.branch || "" })),
      providerKeySet: !!c.providerKey,
      todayTokens: todayTokens(),
      dailyTokenBudget: c.dailyTokenBudget,
      budgetExhausted: budgetExhausted(),
    };
  }

  // ── 清理:保留期 + 每仓库条数上限 ──
  // 游标(repo_state.last_commit)不受清理影响 —— 删历史运行不等于要重评历史。
  function prune({ nowMs = Date.now() } = {}) {
    const c = cfg();
    const cutoff = new Date(nowMs - c.runRetentionDays * 86400000).toISOString();
    const doomed = new Map();                                    // id -> raw_path
    for (const r of db().prepare("SELECT id, raw_path FROM code_review_runs WHERE created_at < ?").all(cutoff)) doomed.set(r.id, r.raw_path);
    for (const repo of c.repos || []) {
      const keep = db().prepare("SELECT id FROM code_review_runs WHERE repo_id=? ORDER BY id DESC LIMIT 1 OFFSET ?").get(repo.id, Math.max(0, c.keepRunsPerRepo - 1));
      if (!keep) continue;
      for (const r of db().prepare("SELECT id, raw_path FROM code_review_runs WHERE repo_id=? AND id < ?").all(repo.id, keep.id)) doomed.set(r.id, r.raw_path);
    }
    if (!doomed.size) return { runs: 0, files: 0 };
    const ids = [...doomed.keys()];
    const ph = ids.map(() => "?").join(",");
    db().transaction(() => {
      db().prepare(`DELETE FROM code_review_comments WHERE run_id IN (${ph})`).run(...ids);
      db().prepare(`DELETE FROM code_review_runs WHERE id IN (${ph})`).run(...ids);
    })();
    const rd = path.resolve(runsDir());
    let files = 0;
    for (const p of doomed.values()) {
      if (!p) continue;
      const abs = path.resolve(String(p));
      if (!abs.startsWith(rd + path.sep)) continue;               // 只删工作区内的报告文件(路径来自 DB,仍按不可信处理)
      try { fs.unlinkSync(abs); files++; } catch { /* 已不在 */ }
    }
    log(`[代码评审] 清理 ${ids.length} 条历史运行、${files} 个报告文件`);
    return { runs: ids.length, files };
  }

  // 每天一次(北京日界)。挂在 60s 定时器上,首次调用即触发 —— 与 persistence 的
  // pruneOldDataIfNewDay 同款 lazy-daily 范式。
  let lastPruneDay = null;
  function pruneIfNewDay(nowMs = Date.now()) {
    const day = beijingParts(nowMs).day;
    if (lastPruneDay === day) return null;
    lastPruneDay = day;
    try { return prune({ nowMs }); } catch (err) { log(`[代码评审] 清理失败: ${err.message}`); return null; }
  }

  // 清空评审数据(不动仓库定义与引擎配置):统计+意见+游标全清,报告文件一并删。
  // includeWorkspace 连 clone 下来的代码一起删 —— 那才是磁盘大头,重建代价只是下次
  // 评审时重新 clone。
  function clearData({ includeWorkspace = false } = {}) {
    const runs = db().prepare("SELECT COUNT(*) n FROM code_review_runs").get().n;
    db().exec("DELETE FROM code_review_comments; DELETE FROM code_review_runs; DELETE FROM code_review_repo_state;");
    let files = 0;
    try {
      for (const f of fs.readdirSync(runsDir())) {
        const abs = path.join(runsDir(), f);
        try { if (fs.statSync(abs).isFile()) { fs.unlinkSync(abs); files++; } } catch { /* 单个文件失败不影响整体 */ }
      }
    } catch { /* 目录不存在 */ }
    let workspace = false;
    if (includeWorkspace) {
      const repos = path.resolve(reposDir()), ws = path.resolve(workspaceDir());
      if (repos.startsWith(ws + path.sep)) { fs.rmSync(repos, { recursive: true, force: true }); workspace = true; }
    }
    log(`[代码评审] 已清空评审数据(${runs} 条运行、${files} 个报告文件${workspace ? "、工作区仓库" : ""})`);
    return { runs, files, workspace };
  }

  // ── 自检:把「为什么跑不起来」一次说清(设置页按钮) ──
  async function selfCheck() {
    const c = cfg();
    const items = [];
    const add = (name, ok, detail, hint = "") => items.push({ name, ok: !!ok, detail: String(detail || ""), hint });

    let probe = { installed: false, version: "", git: "", gitOk: false };
    try { probe = await ocr.probe(); } catch (err) { probe = { ...probe, error: err.message }; }
    add("OCR 引擎", probe.installed, probe.installed ? probe.version : (probe.error || "未找到可执行文件"),
      probe.installed ? "" : "npm i -g open-code-review,或在高级参数里填写绝对路径");
    add("git 版本", probe.gitOk, probe.git || "未找到 git", probe.gitOk ? "" : "增量评审需要 git ≥ 2.41");

    const prof = (config.profiles || {})[c.providerProfile];
    const realKeys = prof ? Object.values(prof.users || {}).filter((u) => (typeof u === "object" ? u.key : u)) : [];
    add("评审方案", !!prof, prof ? `方案「${c.providerProfile}」` : `方案「${c.providerProfile || "未选"}」不存在或已删除`,
      prof ? "" : "到代码评审设置里重新选择评审方案");
    add("方案真实 Key", realKeys.length > 0, realKeys.length ? `${realKeys.length} 把` : "该方案没有分配任何真实上游 Key",
      realKeys.length ? "" : "评审账号运行期要向方案借用真实 Key,没有就会 403");
    add("模型", !!c.providerModel, c.providerModel || "未选模型", c.providerModel ? "" : "到代码评审设置里选择模型");
    add("端点回环", /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(c.providerUrl || ""), c.providerUrl || "(空)",
      "评审流量必须经本网关才会计入用量,端点由所选方案推导,不可手填");
    // 钉住评审方案:端点必须带方案后缀(http://127.0.0.1:<port>/<suffix>/v1)。
    // 不带后缀 = 走方案组 failover,评审会跑在组里任意方案上,与你选的方案无关。
    const url = String(c.providerUrl || "");
    const pinned = /^https?:\/\/[^/]+\/[A-Za-z0-9_-]{2,20}\/v1(\/|$)/.test(url);
    add("方案已钉住", pinned,
      pinned ? url.replace(/^https?:\/\//, "") : (url || "(空)") + " —— 未带方案后缀,评审会走方案组",
      pinned ? "" : "该方案没有可用的独立后缀(为空/保留字),评审流量会按方案组 failover 落到别的方案上");
    // 钉住之后,模型必须在该方案的别名或允许模型里 —— 否则单候选会直接报错(这比静默换方案好,但要提前告知)
    const known = prof ? new Set([...Object.keys(prof.modelAliases || {}), ...(Array.isArray(prof.allowedModels) ? prof.allowedModels : [])]) : new Set();
    const modelOk = !!c.providerModel && known.has(c.providerModel);
    add("模型可用", modelOk, modelOk ? `${c.providerModel} ∈ 方案「${c.providerProfile}」` : `方案「${c.providerProfile || "未选"}」里没有模型「${c.providerModel || "未选"}」`,
      modelOk ? "" : "钉住方案后不会再自动换方案:请选一个属于该方案的别名或允许模型");

    // 统一评审标准:**零成本**自检(只读文件 + 算 hash,不调 LLM、不花 token)。
    // 标准坏了等于所有评审都会失败(startJob 会拒绝在无标准下评审),所以必须在自检里
    // 就能看见,而不是等第一次评审炸了才知道。
    try {
      const std = loadStandard();
      add("统一评审标准", true, `v${std.version} · ${std.segments.length} 段 / ${(std.bytes / 1024).toFixed(1)} KB · ${std.rules.length} 条命中规则`);
    } catch (err) {
      add("统一评审标准", false, err.message, "标准文件在 lib/review-standard/ 下，修正后重启服务");
    }

    const key = c.providerKey;
    const gu = key ? (config.users || {})[key] : null;
    add("评审账号", !!gu, gu ? `${key.slice(0, 12)}… · ${gu.username || ""}` : "尚未创建",
      gu && !gu.superUser ? "该账号不是超级用户,借不到方案真实 Key" : (gu ? "" : "点「一键创建评审账号」"));

    try {
      fs.mkdirSync(workspaceDir(), { recursive: true, mode: 0o700 });
      const probeFile = path.join(workspaceDir(), ".selfcheck");
      fs.writeFileSync(probeFile, "ok"); fs.unlinkSync(probeFile);
      const bytes = dirSizeBytes(workspaceDir());
      const pct = c.perRepoDiskLimitMB > 0 ? (bytes / 1024 / 1024 / c.perRepoDiskLimitMB * 100) : 0;
      add("工作区可写", true, `${(bytes / 1024 / 1024).toFixed(1)} MB · 单仓库上限 ${c.perRepoDiskLimitMB} MB · 满度约 ${pct.toFixed(1)}%`,
        pct >= 80 ? "接近单仓库上限,超限后该仓库不再入队" : "");
    } catch (err) {
      add("工作区可写", false, err.message, "检查目录权限或改「工作区目录」");
    }

    const repos = c.repos || [];
    if (!repos.length) add("仓库白名单", false, "没有登记任何仓库", "至少加一个仓库才能评审");
    // 游标按分支各记一份,这里显示的是**配置分支**那一行;另外报一下这个仓库一共
    // 攒了几条分支游标 —— 管理员换过分支的话,旧分支的行仍在库里(不参与判定)。
    const branchCursorCount = new Map();
    for (const row of repoBranchStates()) branchCursorCount.set(row.repo_id, (branchCursorCount.get(row.repo_id) || 0) + 1);
    for (const repo of repos) {
      const dir = repoDir(repo.id);
      const cloned = fs.existsSync(path.join(dir, ".git"));
      const st = getState(repo.id, repo.branch);
      const sch = repo.schedule || {};
      const schText = sch.mode === "off" ? "不定时" : sch.mode === "interval" ? `每 ${sch.intervalHours} 小时` : `每天 ${sch.at}(北京${sch.weekdays?.length ? " 周" + sch.weekdays.join("/") : "每天"})`;
      const n = branchCursorCount.get(repo.id) || 0;
      const cursorText = `分支「${repo.branch}」评到 ${st.last_commit ? String(st.last_commit).slice(0, 8) : "—"}${n > 1 ? ` · 另有 ${n - 1} 条分支游标` : ""}`;
      add(`仓库「${repo.name}」`, repo.enabled, `上次 ${st.last_run_at ? new Date(Date.parse(st.last_run_at) + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ") : "从未"} · ${st.last_status || "无记录"} · ${cursorText} · ${schText} · ${cloned ? "已 clone" : "待首次拉取"} · 在线触发${repo.apiTrigger ? "开" : "关"}`,
        (st.consecutive_failures || 0) >= 3 ? `连续失败 ${st.consecutive_failures} 次,建议先点「连接测试」` : "");
    }
    return { ok: items.every((i) => i.ok), items };
  }

  // ── 定时扫描(由 server 的 60s 定时器驱动) ──
  let budgetWarnDay = null;
  function tick(nowMs = Date.now()) {
    const c = cfg();
    if (!c.enabled) return { enqueued: [] };
    pruneIfNewDay(nowMs);
    // 预算用尽时**不再写 skipped 行**:定时器每 60s 扫一次,写行会把表刷爆;
    // 手动触发走 enqueue 自己的检查(那里留一行记录,便于解释「为什么没跑」)。
    if (budgetExhausted()) {
      const day = beijingParts(nowMs).day;
      if (budgetWarnDay !== day) { budgetWarnDay = day; log(`[代码评审] 当日 token 预算已用尽(${c.dailyTokenBudget}),今日不再自动触发`); }
      return { enqueued: [], budgetExhausted: true };
    }
    const enqueued = [];
    for (const repo of c.repos || []) {
      if (!repo.enabled) continue;
      if (hasActiveRun(repo.id)) continue;                       // 已排队/在跑:等它结束,下次扫描再判
      let due = null;
      try { due = isScheduleDue(repo, lastRunAtAnyBranch(repo.id), nowMs); } catch { due = null; }
      if (!due) continue;
      try {
        const r = enqueue(repo.id, { trigger: "schedule", actor: "scheduler" });
        enqueued.push({ repoId: repo.id, name: repo.name, runId: r.runId, mode: due });
        log(`[代码评审] 定时触发「${repo.name}」(${due}) run#${r.runId}`);
      } catch (err) {
        log(`[代码评审] 定时触发「${repo.name}」失败: ${err.message}`);
      }
    }
    return { enqueued };
  }

  // ── 成员级 API/MCP 触发的限频(进程内,单实例口径) ──
  const TRIGGER_MIN_INTERVAL_MS = 60_000;
  const lastTriggerAt = new Map();      // key -> ms
  function checkTriggerRate(identity, nowMs = Date.now()) {
    const id = String(identity || "");
    const last = lastTriggerAt.get(id) || 0;
    if (nowMs - last < TRIGGER_MIN_INTERVAL_MS) {
      return { allowed: false, retryAfter: Math.ceil((TRIGGER_MIN_INTERVAL_MS - (nowMs - last)) / 1000) };
    }
    lastTriggerAt.set(id, nowMs);
    return { allowed: true, retryAfter: 0 };
  }
  // 允许该成员 Key 触发评审吗:白名单命中,或超级用户(管理员)豁免
  // 该成员 Key 能碰评审功能吗(不限仓库):超级用户豁免,或至少是某一个仓库的成员。
  // 用于「这个人能不能用评审」这种粗判(如 MCP 工具可见性);具体某个仓库另见 canTriggerRepo。
  function canTrigger(apiKey) {
    const c = cfg();
    if (!c.enabled) return false;
    if ((config.users || {})[apiKey]?.superUser) return true;
    return (c.repos || []).some((r) => r.enabled !== false && Array.isArray(r.members) && r.members.includes(apiKey));
  }
  // 该成员**是否在这个仓库的名单里**(超级用户豁免)。与 canTriggerRepo 分开是为了能给
  // 出准确的原因:「你不在名单里」和「仓库没开在线触发」是两件不同的事,文案不能混。
  function isRepoMember(apiKey, repo) {
    if (!repo) return false;
    if ((config.users || {})[apiKey]?.superUser) return true;
    return Array.isArray(repo.members) && repo.members.includes(apiKey);
  }
  // 该成员能触发**这个**仓库吗:仓库启用 + 开了在线触发 + (超级用户或在该仓库成员名单里)。
  // 「谁能触发哪个仓库」由仓库自己的成员名单决定 —— 不是每个人负责同一个仓库。
  function canTriggerRepo(apiKey, repo) {
    const c = cfg();
    if (!c.enabled || !repo) return false;
    if (repo.enabled === false || !repo.apiTrigger) return false;
    return isRepoMember(apiKey, repo);
  }
  // ⚠️ 「看得到」与「能触发」是两件事,别揉成一个判断(踩过):
  //   visible      = 在仓库成员名单里 —— 决定能不能**看到这个仓库的评审结果**
  //   triggerable  = visible 且仓库启用 且开了「允许在线触发」—— 决定能不能**从外部发起评审**
  // 一个仓库完全可能「只让成员看结果、不开放外部触发」(apiTrigger 默认就是关的),
  // 那时它的成员**照样应该看得到** —— 早先把可见性也压上 apiTrigger,导致成员打开
  // 「我的用量」一片空白(成员明明配好了,只是没开在线触发)。
  function reposVisibleTo(apiKey) {
    return (cfg().repos || []).filter((r) => isRepoMember(apiKey, r));
  }
  function reposTriggerableBy(apiKey) {
    return (cfg().repos || []).filter((r) => canTriggerRepo(apiKey, r));
  }

  // 成员视角:自己是成员的仓库 + 这些仓库的运行记录;另加一类 —— 推送人/作者邮箱
  // 等于本人邮箱的运行(收到定向通知的人,哪怕不是该仓库成员)。
  // 越权边界在本函数内闭合 —— 调用方(接口)拿到的一定已经过滤过。
  function memberView(apiKey, { limit = 20, email = "" } = {}) {
    const repos = reposVisibleTo(apiKey);
    const allowed = new Set(repos.map((r) => r.id));
    const states = repoStates();   // 按仓库取「配置分支」那一行,与下面每个 r.branch 一致
    const { rows } = listRuns({ limit: 200 });
    const all = rows.filter((r) => allowed.has(r.repo_id) || runEmailMatch(r, email));
    const mine = all.slice(0, Math.min(50, Math.max(1, limit)));
    // pending = 未解决数(菜单角标),口径见 pendingFindings
    const pending = pendingFindings(apiKey, { email });
    return {
      enabled: !!cfg().enabled,
      pending,
      repos: repos.map((r) => {
        const st = states[r.id] || {};
        return {
          id: r.id, name: r.name, branch: r.branch, enabled: r.enabled !== false,
          // 能看 ≠ 能触发:这个布尔告诉前端该仓库是否也允许外部触发(仅影响显示与按钮可用性)
          canTrigger: canTriggerRepo(apiKey, r),
          lastStatus: st.last_status || null, lastRunAt: st.last_run_at || null,
          lastCommit: st.last_commit || null, consecutiveFailures: st.consecutive_failures || 0,
        };
      }),
      runs: mine.map((r) => ({
        id: r.id, repo: r.repo_name, repoId: r.repo_id, status: r.status, trigger: r.trigger,
        branch: r.branch, rangeMode: r.range_mode, fromCommit: r.from_commit, toCommit: r.to_commit,
        // 这次覆盖了多少个提交 / 这一段是怎么定出来的(游标、冷启动、历史改写还是手动补评)
        commitsCount: r.commits_count || 0, rangeSource: r.range_source || null, rangeNote: r.range_note || null,
        filesReviewed: r.files_reviewed, comments: r.comments_count, dismissed: r.dismissed_count || 0,
        // 本次「选了 N 个、只评了 M 个」时 M/N 才不等于 N/N。老记录没有 unreviewed_count,
        // 只有 coverageIncomplete 这个派生布尔 —— 前端据此把结论降级为「覆盖不全」。
        unreviewed: Number(r.unreviewed_count) || 0,
        coverageIncomplete: !!r.coverageIncomplete,
        tokens: (r.input_tokens || 0) + (r.output_tokens || 0),
        note: r.note || null, error: r.error || null, createdAt: r.created_at,
        resolved: !!r.resolved, resolvedAt: r.resolved_at || null, resolvedBy: r.resolved_by || null,
      })),
    };
  }
  // 成员读某次运行:是成员仓库,或这条 run 的邮箱命中本人 —— 否则一律当「不存在」(404),
  // 不泄露「这个 runId 存在但你没权限」这种事实。
  function memberRun(apiKey, runId, email = "") {
    const run = getRunRow(Number(runId));
    if (!run) return null;
    const repo = (cfg().repos || []).find((r) => r.id === run.repo_id);
    if ((!repo || !isRepoMember(apiKey, repo)) && !runEmailMatch(run, email)) return null;
    return { run, comments: listComments(run.id, { limit: 500 }) };
  }
  // resolve 端点的轻量可见性判定:memberRun 会把几百条意见全拉出来,这里只需要
  // 「看得到/看不到」。返回 run 行或 null,口径与 memberRun 完全一致。
  function canMemberSeeRun(apiKey, runId, email = "") {
    const run = getRunRow(Number(runId));
    if (!run) return null;
    const repo = (cfg().repos || []).find((r) => r.id === run.repo_id);
    if (repo && isRepoMember(apiKey, repo)) return run;
    return runEmailMatch(run, email) ? run : null;
  }

  // ── 单条意见的「不用处理」处置 ─────────────────────────────────────────────
  const DISMISS_REASON_MAX = 500;
  function getComment(commentId) {
    return db().prepare("SELECT * FROM code_review_comments WHERE id=?").get(Number(commentId)) || null;
  }
  // 成员可见性:通过意见找到它所属的运行,复用与运行级完全相同的口径 ——
  // 看得见这条运行 = 能处置这次运行里的意见(仓库成员,或被定向通知到的人)。
  function commentForMember(apiKey, commentId, email = "") {
    const c = getComment(commentId);
    if (!c) return null;
    return canMemberSeeRun(apiKey, c.run_id, email) ? c : null;
  }
  // 标记 / 撤销「不用处理」。标记必须给理由:理由为空直接 400,不留「无声忽略」的口子。
  function setCommentDismissed(commentId, { dismissed = true, reason = "", by = "" } = {}) {
    const c = getComment(commentId);
    if (!c) { const e = new Error("意见不存在"); e.statusCode = 404; throw e; }
    const on = dismissed !== false;
    let text = null;
    if (on) {
      text = String(reason || "").trim();
      if (!text) { const e = new Error("请填写不处理的理由"); e.statusCode = 400; throw e; }
      if (text.length > DISMISS_REASON_MAX) { const e = new Error(`理由过长（最多 ${DISMISS_REASON_MAX} 字）`); e.statusCode = 400; throw e; }
    }
    db().prepare("UPDATE code_review_comments SET dismissed=?, dismissed_at=?, dismissed_by=?, dismiss_reason=? WHERE id=?")
      .run(on ? 1 : 0, on ? new Date().toISOString() : null, on ? String(by || "").slice(0, 128) : null, text, Number(commentId));
    return getComment(commentId);
  }

  return {
    // 校验与配置
    sanitize: sanitizeCodeReviewConfig, findRepo, workspaceDir, repoDir, ocrHomeDir, runsDir,
    // 队列
    enqueue, pump, cancel, reapStale, hasActiveRun,
    // 查询
    status, listRuns, getRun, listComments, repoStates, repoBranchStates, getState, counterSnapshot,
    lastRunAtAnyBranch,
    // 覆盖率按需补读(老记录:库里没有 coverage_json 时现场读原始报告,只读不写)
    coverageFromRaw,
    // 已解决状态(成员与管理端共用)
    setRunResolved,
    setCommentDismissed,
    commentForMember,
    // 授权:canTrigger=能不能用评审(粗判),canTriggerRepo=能不能触发**这个**仓库
    canTrigger, canTriggerRepo, isRepoMember, reposVisibleTo, reposTriggerableBy,
    // 成员视角(已按成员过滤,越权边界在库内闭合)
    memberView, memberRun, canMemberSeeRun, listFindings, pendingFindings,
    // 仓库运维
    testRepo, listBranches, dirSizeBytes,
    // 自动化与守卫
    tick, prune, pruneIfNewDay, clearData, selfCheck, todayTokens, budgetExhausted,
    checkTriggerRate,
  };
}
