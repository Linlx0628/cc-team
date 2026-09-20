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

const REPO_URL_RE = /^(https:\/\/|ssh:\/\/|git@)[^\s"'`\\$]{3,500}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const FIELD_MAX = 8192;          // 单条意见字段截断上限
const WARNINGS_MAX = 32768;

export const TRIGGERS = new Set(["manual", "schedule", "api", "mcp"]);
export const TERMINAL_OK = new Set(["success", "completed_with_warnings", "completed_with_errors", "skipped"]);
export const TERMINAL = new Set([...TERMINAL_OK, "failed", "timeout", "canceled"]);
const ACTIVE = ["queued", "syncing", "running", "parsing"];

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
    defaultMaxTokensBudget: num(r.defaultMaxTokensBudget, 2_000_000, 0, 200_000_000),
    dailyTokenBudget: num(r.dailyTokenBudget, 0, 0, 2_000_000_000),
    runRetentionDays: num(r.runRetentionDays, 90, 1, 3650),
    keepRunsPerRepo: num(r.keepRunsPerRepo, 50, 1, 1000),
    storeComments: r.storeComments !== false,
    notifyOn: ["always", "failure", "never"].includes(r.notifyOn) ? r.notifyOn : "always",
    providerKey: typeof r.providerKey === "string" ? r.providerKey.trim() : "",
    providerProfile: typeof r.providerProfile === "string" ? r.providerProfile.trim() : "",
    providerName: (typeof r.providerName === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(r.providerName)) ? r.providerName : "cc-team",
    providerUrl: (typeof r.providerUrl === "string" && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/\S*)?$/.test(r.providerUrl))
      ? r.providerUrl
      : `http://127.0.0.1:${serverPort}/v1`,
    providerProtocol: r.providerProtocol === "openai-responses" ? "openai-responses" : "anthropic",
    providerModel: typeof r.providerModel === "string" ? r.providerModel.trim().slice(0, 128) : "",
    background: typeof r.background === "string" ? r.background.slice(0, 2000) : "",
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
  const sch = raw.schedule && typeof raw.schedule === "object" ? raw.schedule : {};
  const weekdays = Array.isArray(sch.weekdays) ? sch.weekdays.map(Number).filter((d) => d >= 1 && d <= 7) : [];
  return {
    id, name, source, url, localPath, branch,
    authType,
    username: typeof raw.username === "string" ? raw.username.slice(0, 128) : "",
    credential: typeof raw.credential === "string" ? raw.credential : "",
    enabled: raw.enabled !== false,
    apiTrigger: !!raw.apiTrigger,
    schedule: {
      mode: ["off", "interval", "daily"].includes(sch.mode) ? sch.mode : "off",
      intervalHours: Math.min(168, Math.max(1, Number(sch.intervalHours) || 6)),
      at: /^([01]\d|2[0-3]):[0-5]\d$/.test(sch.at) ? sch.at : "03:00",
      weekdays,
    },
    overrides: {
      exclude: Array.isArray(raw.overrides?.exclude) ? raw.overrides.exclude.filter((x) => typeof x === "string") : null,
      background: typeof raw.overrides?.background === "string" ? raw.overrides.background.slice(0, 2000) : null,
      timeoutMinutes: raw.overrides?.timeoutMinutes ? Math.min(240, Math.max(2, Number(raw.overrides.timeoutMinutes))) : null,
    },
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// —— 三张表(照 production.mjs 的 initProductionDb 先例:本功能自带建表,不污染 persistence)——
export function initCodeReviewDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_review_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id TEXT NOT NULL, repo_name TEXT NOT NULL,
      trigger TEXT NOT NULL, actor TEXT,
      branch TEXT, from_commit TEXT, to_commit TEXT, range_mode TEXT,
      status TEXT NOT NULL, exit_code INTEGER, error TEXT, note TEXT,
      files_reviewed INTEGER DEFAULT 0, comments_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
      elapsed_ms INTEGER,
      attributed_requests INTEGER DEFAULT 0, attributed_input INTEGER DEFAULT 0, attributed_output INTEGER DEFAULT 0,
      ocr_model TEXT, ocr_provider TEXT, session_id TEXT,
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
      repo_id TEXT PRIMARY KEY,
      last_commit TEXT, last_run_id INTEGER, last_run_at TEXT, last_status TEXT,
      consecutive_failures INTEGER DEFAULT 0,
      queued_at TEXT, updated_at TEXT
    );
  `);
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
  failed: "失败", timeout: "超时", canceled: "已取消", skipped: "已跳过",
  queued: "排队中", syncing: "同步中", running: "评审中", parsing: "解析中",
};
const TRIGGER_LABEL = { manual: "手动", schedule: "定时", api: "API", mcp: "MCP" };

const bjTime = (iso) => (iso ? new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ") : "—");

export function buildReviewReportHTML({ run, comments = [], repo = {} }) {
  const r = run || {};
  const files = new Map();
  for (const c of comments) {
    const p = String(c.path || "?");
    if (!files.has(p)) files.set(p, []);
    files.get(p).push(c);
  }
  const range = r.range_mode === "single"
    ? `单提交 ${escH(String(r.to_commit || "").slice(0, 10))}`
    : `${escH(String(r.from_commit || "").slice(0, 10))} → ${escH(String(r.to_commit || "").slice(0, 10))}`;
  const filesHtml = [...files.entries()].map(([p, list]) => `
<h3>${escH(p)} <span class="note">${list.length} 条</span></h3>
${list.map((c) => `<div class="cmt">
  <div class="loc">${c.start_line ? "L" + escH(c.start_line) + (c.end_line && c.end_line !== c.start_line ? "-" + escH(c.end_line) : "") : ""}</div>
  <div class="body">${escH(c.content)}</div>
  ${c.existing_code ? `<pre class="old">${escH(c.existing_code)}</pre>` : ""}
  ${c.suggestion_code ? `<pre class="new">${escH(c.suggestion_code)}</pre>` : ""}
  ${c.thinking ? `<details><summary>推理过程</summary><div class="note" style="white-space:pre-wrap">${escH(c.thinking)}</div></details>` : ""}
</div>`).join("")}`).join("") || `<p class="empty">本次评审没有提出意见。</p>`;
  const warnings = (() => { try { return JSON.parse(r.warnings_json || "[]"); } catch { return []; } })();
  const warnHtml = warnings.length
    ? `<h2>警告</h2><ul class="note">${warnings.map((w) => `<li>${escH(typeof w === "string" ? w : JSON.stringify(w))}</li>`).join("")}</ul>` : "";
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>代码评审报告 · ${escH(repo.name || r.repo_name)} #${escH(r.id)}</title>
<style>body{font:14px/1.65 -apple-system,"PingFang SC",sans-serif;background:#fbfbf8;color:#1f2937;max-width:900px;margin:24px auto;padding:0 16px}
h1{font-size:20px}h2{font-size:16px;margin-top:28px;border-left:3px solid #2f6e50;padding-left:8px}
h3{font-size:14px;margin:20px 0 6px;font-family:ui-monospace,Menlo,monospace}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #e5e7eb;padding:6px 10px;text-align:left}th{background:#f3f4f1}
.note{color:#6b7280;font-size:12px}.empty{color:#6b7280;text-align:center;padding:16px}
.cmt{border-left:2px solid #e5e7eb;padding:2px 0 2px 10px;margin:8px 0}
.loc{font:11px ui-monospace,Menlo,monospace;color:#6b7280}
.body{margin:2px 0 6px;white-space:pre-wrap}
pre{font:12px/1.5 ui-monospace,Menlo,monospace;padding:8px 10px;border-radius:4px;overflow-x:auto;margin:4px 0;white-space:pre-wrap}
pre.old{background:#fdf2f2;border:1px solid #f3d6d6}pre.new{background:#f1f8f3;border:1px solid #d3e6da}
details summary{cursor:pointer;color:#2f6e50;font-size:12px}</style></head><body>
<h1>代码评审报告</h1>
<p class="note">仓库「${escH(repo.name || r.repo_name)}」 · 运行 #${escH(r.id)} · ${escH(bjTime(r.created_at))}（北京时间） · 触发方式 ${escH(TRIGGER_LABEL[r.trigger] || r.trigger || "—")} · 状态 ${escH(STATUS_LABEL[r.status] || r.status)}</p>
<h2>概要</h2>
<table><tbody>
<tr><th>评审范围</th><td>${range}</td></tr>
<tr><th>分支 / 提交</th><td>${escH(r.branch || "—")} · <code>${escH(String(r.to_commit || "").slice(0, 10))}</code>${r.cursor_advanced ? "" : "（游标未推进，下次会重评同一区间）"}</td></tr>
<tr><th>文件数 / 意见数</th><td>${escH(r.files_reviewed || 0)} / ${escH(r.comments_count || 0)}</td></tr>
<tr><th>模型</th><td>${escH(r.ocr_model || "—")}${r.ocr_provider ? "（" + escH(r.ocr_provider) + "）" : ""}</td></tr>
<tr><th>token（OCR 自报）</th><td>输入 ${escH(r.input_tokens || 0)} · 输出 ${escH(r.output_tokens || 0)}</td></tr>
<tr><th>token（网关侧实证）</th><td>请求 ${escH(r.attributed_requests || 0)} · 输入 ${escH(r.attributed_input || 0)} · 输出 ${escH(r.attributed_output || 0)}</td></tr>
${r.error ? `<tr><th>错误</th><td>${escH(r.error)}</td></tr>` : ""}
${r.note ? `<tr><th>备注</th><td>${escH(r.note)}</td></tr>` : ""}
</tbody></table>
<p class="note">净耗时（数据库侧）${r.elapsed_ms ? Math.round(r.elapsed_ms / 1000) + " 秒" : "—"}；两个 token 口径不一致属正常：OCR 自报来自上游返回，网关侧是评审账号在网关的记账差值（含重试）。</p>
${warnHtml}
<h2>评审意见（按文件）</h2>
${filesHtml}
<p class="note" style="margin-top:24px">由 token-monitor 代码评审生成 · 意见为模型产出，需人工判断后采纳</p>
</body></html>`;
}

export function createCodeReview(d) {
  const { config, saveConfig, ocr, log = console.log, appRoot, port, notifyReview } = d;
  const getDb = () => d.db;

  // config.codeReview 缺失(全新安装且迁移还没跑)时按默认初始化,保证任何入口都不炸
  const cfg = () => (config.codeReview || (config.codeReview = sanitizeCodeReviewConfig({}, port)));
  const workspaceDir = () => cfg().workspaceDir || path.join(appRoot, "code-review-workspaces");
  const reposDir = () => path.join(workspaceDir(), "repos");
  const runsDir = () => path.join(workspaceDir(), "runs");
  const ocrHomeDir = () => path.join(workspaceDir(), "ocr-home");
  const findRepo = (idOrName) => (cfg().repos || []).find((r) => r.id === idOrName || r.name === idOrName) || null;

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

  function insertRun({ repoId, repoName, trigger, actor, branch, from, to }) {
    const info = db().prepare(`INSERT INTO code_review_runs (repo_id, repo_name, trigger, actor, branch, from_commit, status, created_at)
      VALUES (?,?,?,?,?,?,'queued',?)`).run(repoId, repoName, trigger, actor || null, branch || null, from || null, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }
  const setRun = (id, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    db().prepare(`UPDATE code_review_runs SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`).run(...keys.map((k) => fields[k]), id);
  };
  const getRunRow = (id) => db().prepare("SELECT * FROM code_review_runs WHERE id=?").get(id);

  function setState(repoId, fields) {
    const keys = Object.keys(fields);
    db().prepare(`INSERT INTO code_review_repo_state (repo_id, ${keys.join(",")}, updated_at) VALUES (?${",?" .repeat(keys.length)}, ?)
      ON CONFLICT(repo_id) DO UPDATE SET ${keys.map((k) => `${k}=excluded.${k}`).join(",")}, updated_at=excluded.updated_at`)
      .run(repoId, ...keys.map((k) => fields[k]), new Date().toISOString());
  }
  const getState = (repoId) => db().prepare("SELECT * FROM code_review_repo_state WHERE repo_id=?").get(repoId) || {};

  // ── 入队 ──
  function enqueue(repoIdOrName, { trigger = "manual", actor = "admin", from = null, to = null, dedupe = true } = {}) {
    if (!cfg().enabled) { const e = new Error("代码评审功能未启用"); e.statusCode = 409; throw e; }
    const repo = findRepo(repoIdOrName);
    if (!repo || !repo.enabled) { const e = new Error("仓库不存在或已停用"); e.statusCode = 404; throw e; }
    if (dedupe && hasActiveRun(repo.id)) return { runId: activeRunId(repo.id), deduped: true };
    const limitBytes = cfg().perRepoDiskLimitMB * 1024 * 1024;
    if (dirSizeBytes(repoDir(repo.id)) > limitBytes) {
      notifyReview?.({ kind: "disk_full", repo });
      const e = new Error(`工作区磁盘超限(${cfg().perRepoDiskLimitMB}MB)`); e.statusCode = 413; throw e;
    }
    if (budgetExhausted()) {
      const runId = insertRun({ repoId: repo.id, repoName: repo.name, trigger, actor, branch: repo.branch, from, to });
      setRun(runId, { status: "skipped", note: "超出当日 token 预算", finished_at: new Date().toISOString() });
      return { runId, skipped: true };
    }
    const runId = insertRun({ repoId: repo.id, repoName: repo.name, trigger, actor, branch: repo.branch, from, to });
    setState(repo.id, { queued_at: new Date().toISOString() });
    queue.push({ runId, repoId: repo.id });
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
  async function startJob({ runId, repoId }) {
    const repo = findRepo(repoId);
    if (!repo) { setRun(runId, { status: "failed", error: "仓库已删除", finished_at: new Date().toISOString() }); return; }
    const dir = repoDir(repo.id);
    setRun(runId, { status: "syncing", started_at: new Date().toISOString() });
    try {
      await ensureRepo(repo, dir);
      const to = await revParse(repo, dir);
      if (!to) throw new Error("无法解析目标提交");
      const st = getState(repo.id);
      let from = st.last_commit || null;
      let mode = "range";
      let note = null;
      if (!from) { mode = "single"; note = "首次评审:只评最新提交"; }
      else if (!(await isAncestor(dir, from, to))) { mode = "single"; note = "历史被改写,回退为单提交评审"; }
      setRun(runId, { status: "running", from_commit: mode === "range" ? from : null, to_commit: to, range_mode: mode, note });
      const outPath = path.join(runsDir(), `${runId}.json`);
      fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
      const args = ocr.buildReviewArgs({ dir, mode, from, to, outPath, repo });
      const before = counterSnapshot(cfg().providerKey);
      const hardCapMs = ((repo.overrides.timeoutMinutes || cfg().defaultTimeoutMinutes) * 60_000 + 300_000);
      const res = await ocr.runReview({
        dir, args, repo,
        token: repo.authType === "token" ? repo.credential : null,
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
      persistReport(runId, repo, report, { outPath, before, after, res });
      advanceCursor(repo.id, { commit: to, runId, status: report.status });
    } catch (err) {
      const status = err && err.message === "timeout" ? "timeout" : "failed";
      setRun(runId, { status, error: String(err.message || err).slice(0, 500), finished_at: new Date().toISOString() });
      const prev = getState(repo.id);
      setState(repo.id, { consecutive_failures: (prev.consecutive_failures || 0) + 1, last_status: status, last_run_at: new Date().toISOString() });
      // 「跑都没跑起来」(clone/fetch 失败、超时、引擎缺失)最需要推给管理员 ——
      // 这条路径原先只有日志,通知设置成「仅失败时」反而一声不响。
      notifyFailure(repo, runId, status);
    }
  }

  // 运行未走到解析阶段的失败:合成一个只带状态的 report,交给通知层统一判断
  function notifyFailure(repo, runId, status) {
    notifyReview?.({ kind: "run", repo, runId, report: { status, comments: [] } });
  }

  function persistReport(runId, repo, report, { outPath, before, after, res }) {
    const s = report.summary || {};
    const now = new Date().toISOString();
    const tokens = (k) => Number(s[k]) || 0;
    setRun(runId, {
      status: report.status,
      files_reviewed: tokens("files_reviewed"),
      comments_count: tokens("comments"),
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
      warnings_json: report.warnings.length ? JSON.stringify(report.warnings).slice(0, WARNINGS_MAX) : null,
      raw_path: outPath,
      error: report.status === "failed" ? String(report.message || res.stderr || "评审失败").slice(0, 500) : null,
      note: report.message ? String(report.message).slice(0, 500) : null,
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
    log(`[代码评审] run#${runId} ${repo.name}: ${report.status}, ${report.comments.length} 条意见, ${tokens("total_tokens")} token`);
    notifyReview?.({ kind: "run", repo, runId, report });
  }

  function advanceCursor(repoId, { commit, runId, status }) {
    const advance = TERMINAL_OK.has(status);
    setState(repoId, {
      last_commit: advance ? commit : getState(repoId).last_commit || null,
      last_run_id: runId, last_run_at: new Date().toISOString(), last_status: status,
      consecutive_failures: advance ? 0 : (getState(repoId).consecutive_failures || 0),
    });
    if (advance) setRun(runId, { cursor_advanced: 1 });
  }

  // ── git ──
  async function ensureRepo(repo, dir) {
    const auth = { token: repo.authType === "token" ? repo.credential : null, sshKeyPath: repo.authType === "sshKey" ? repo.credential : null };
    const ws = workspaceDir();
    fs.mkdirSync(path.join(ws, "tmp"), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(dir, ".git"))) {
      fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
      const src = repo.source === "local" ? repo.localPath : repo.url;
      if (repo.source === "local" && !fs.existsSync(src)) throw new Error("本地仓库路径不存在");
      const r = await ocr.git(["clone", "--no-tags", "--single-branch", "--branch", repo.branch, "--", src, dir], { cwd: workspaceDir(), timeoutMs: 300000, ...auth });
      if (r.code !== 0) throw new Error(`clone 失败: ${(r.stderr || r.error || "").slice(0, 300)}`);
    }
    // 每次评审前同步到目标分支最新:remote 从线上 fetch;local 从本地路径 fetch
    // (clone 时 origin 就指向那个本地路径,fetch 能拿到它的新提交 —— 只 checkout
    // 不 fetch 的话,本地仓库后续提交永远进不了评审,这是 P1 踩过的坑)。
    // ⚠️ 工作区里只看得到**已提交**的内容:本地未 commit 的改动不会被评审。
    const f = await ocr.git(["-C", dir, "fetch", "--no-tags", "--prune", "origin", repo.branch], { cwd: dir, timeoutMs: 180000, ...auth });
    if (f.code !== 0) throw new Error(`fetch 失败: ${(f.stderr || f.error || "").slice(0, 300)}`);
    const rs = await ocr.git(["-C", dir, "reset", "--hard", "FETCH_HEAD"], { cwd: dir, timeoutMs: 60000 });
    if (rs.code !== 0) throw new Error(`reset 失败: ${(rs.stderr || "").slice(0, 300)}`);
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
  async function testRepo(repo) {
    const auth = { token: repo.authType === "token" ? repo.credential : null, sshKeyPath: repo.authType === "sshKey" ? repo.credential : null };
    if (repo.source === "local") return { ok: fs.existsSync(repo.localPath), detail: repo.localPath };
    const r = await ocr.git(["ls-remote", "--heads", "--", repo.url, repo.branch], { cwd: workspaceDir(), timeoutMs: 20000, ...auth });
    if (r.code !== 0) return { ok: false, detail: (r.stderr || r.error || "连接失败").slice(0, 300) };
    return { ok: true, detail: r.stdout.split("\n")[0].slice(0, 120) || "已连接" };
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

  // 启动收割:上一次进程留下的 queued/syncing/running/parsing 永远不会再推进
  function reapStale() {
    const n = db().prepare(`UPDATE code_review_runs SET status='failed', error='服务重启中断', finished_at=?
      WHERE status IN ('queued','syncing','running','parsing')`).run(new Date().toISOString()).changes;
    if (n) log(`[代码评审] 启动收割 ${n} 条中断的运行`);
    return n;
  }

  const listRuns = ({ repoId = null, status = null, limit = 50, offset = 0 } = {}) => {
    const where = [];
    const args = [];
    if (repoId) { where.push("repo_id=?"); args.push(repoId); }
    if (status) { where.push("status=?"); args.push(status); }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = db().prepare(`SELECT * FROM code_review_runs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, Math.min(200, limit), Math.max(0, offset));
    const total = db().prepare(`SELECT COUNT(*) n FROM code_review_runs ${w}`).get(...args).n;
    return { rows, total };
  };
  const getRun = (id) => getRunRow(Number(id));
  const listComments = (runId, { limit = 200, offset = 0 } = {}) => db()
    .prepare("SELECT * FROM code_review_comments WHERE run_id=? ORDER BY idx LIMIT ? OFFSET ?")
    .all(Number(runId), Math.min(500, limit), Math.max(0, offset));
  const repoStates = () => Object.fromEntries(db().prepare("SELECT * FROM code_review_repo_state").all().map((r) => [r.repo_id, r]));

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
    for (const repo of repos) {
      const dir = repoDir(repo.id);
      const cloned = fs.existsSync(path.join(dir, ".git"));
      const st = getState(repo.id);
      const sch = repo.schedule || {};
      const schText = sch.mode === "off" ? "不定时" : sch.mode === "interval" ? `每 ${sch.intervalHours} 小时` : `每天 ${sch.at}(北京${sch.weekdays?.length ? " 周" + sch.weekdays.join("/") : "每天"})`;
      add(`仓库「${repo.name}」`, repo.enabled, `上次 ${st.last_run_at ? new Date(Date.parse(st.last_run_at) + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ") : "从未"} · ${st.last_status || "无记录"} · ${schText} · ${cloned ? "已 clone" : "待首次拉取"} · 在线触发${repo.apiTrigger ? "开" : "关"}`,
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
      try { due = isScheduleDue(repo, getState(repo.id).last_run_at || null, nowMs); } catch { due = null; }
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
  function canTrigger(apiKey) {
    const c = cfg();
    if (!c.enabled) return false;
    if ((config.users || {})[apiKey]?.superUser) return true;
    return Array.isArray(c.apiKeys) && c.apiKeys.includes(apiKey);
  }

  return {
    // 校验与配置
    sanitize: sanitizeCodeReviewConfig, findRepo, workspaceDir, repoDir, ocrHomeDir, runsDir,
    // 队列
    enqueue, pump, cancel, reapStale, hasActiveRun,
    // 查询
    status, listRuns, getRun, listComments, repoStates, getState, counterSnapshot,
    // 仓库运维
    testRepo, dirSizeBytes,
    // 自动化与守卫
    tick, prune, pruneIfNewDay, clearData, selfCheck, todayTokens, budgetExhausted,
    checkTriggerRate, canTrigger,
  };
}
