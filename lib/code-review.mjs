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
    if (cfg().dailyTokenBudget > 0 && todayTokens(repo.id) >= cfg().dailyTokenBudget) {
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
    }
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
  function todayTokens(repoId) {
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const row = db().prepare(`SELECT COALESCE(SUM(input_tokens+output_tokens),0) t FROM code_review_runs
      WHERE repo_id=? AND substr(created_at,1,10)<=?`).get(repoId, today);
    return Number(row?.t) || 0;
  }

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
    };
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
  };
}
