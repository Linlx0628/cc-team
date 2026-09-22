import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initProductionDb, createProductionTracker, rangeFromTo, productionSummary, productionUserDetail,
  productionProjects, productionAlerts, markAlertSeen, pruneProductionData, DEFAULT_COST_RATES,
  computeCosts, contextHealth, buildReportHTML, ALERT_KIND_LABEL, alertDetailText,
  sessionProjectLabels, sessionToolStats, sessionKey } from "./production.mjs";
import { cnNow, cnDate, cnHalfHour, secondsUntilNextCnMidnight, cnWeekStartIso, cnWeekStartDate, cnDayStartIso, parseDateRange } from "./lib/time.mjs";
import { parsePeakTimeMinutes, normalizePeakHours, isInPeakHours, formatPeakHoursSummary,
  BASE_GROUP_TOKEN, resolveEffectiveGroup, formatScheduleRuleSummary,
  normalizeScheduleGroups, normalizeScheduleRules, normalizeScheduleRule, normalizeScheduleGroupName,
  nextScheduleBoundary, msUntilNextBeijingMidnight, describeScheduleHealth, matchesScheduleRule,
  beijingDayOfWeek, GROUP_NAME_MAX, ALL_DAYS, DAY_LABELS } from "./lib/schedule.mjs";
import { sanitizeJson } from "./lib/sanitize.mjs";
import { QUOTA_RATE_MAX, normalizeQuotaRate, normalizeCacheReadQuotaRate, normalizeModelQuotaRates, lookupModelQuotaRate, currentQuotaRate, nextRateChangeHint, QUOTA_POOL_NAME_MAX, normalizeQuotaPoolName, canonicalJson, shortDigest, applyStickyReorder, buildPoolResolver, quotaExceededMessage, quotaErrorDetail, buildQuotaCore } from "./lib/quota.mjs";
import { CB_MAX_BACKOFF_FACTOR, CB_MAX_COOLDOWN_MS, CircuitBreaker } from "./lib/circuit.mjs";
import { loadAssets } from "./lib/assets.mjs";
import { wsAcceptUpgrade, wsRejectUpgrade, WsConn } from "./lib/ws-server.mjs";
import { isCompactionRequest, transformCompactSseEvent } from "./lib/compact-bridge.mjs";
import { tryThinkingPassbackSelfHeal } from "./lib/thinking-passback.mjs";
import { createCodeReviewOcr } from "./lib/code-review-ocr.mjs";
import { createCodeReview, initCodeReviewDb, sanitizeCodeReviewConfig, maskCredential, buildReviewReportHTML, migrateLegacyTriggerKeys, isValidBranch, TERMINAL, TERMINAL_OK } from "./lib/code-review.mjs";
import { createMemberNotify, initMemberNotifyDb, pickNotifyTarget } from "./lib/member-notify.mjs";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { escHtml, escJs } from "./lib/html.mjs";
import { settingsHtml, dashboardHtml, loginHtml, personalUsageLandingHtml, codexSetupHtml, personalUsageHtml } from "./lib/pages.mjs";
import { buildCodexModelCatalog, buildCodexSetupScript, buildCodexSetupScriptWin } from "./lib/codex-setup-script.mjs";
import { buildAnthropicSetupHints, buildClaudeSetupScript, buildClaudeSetupScriptWin } from "./lib/claude-setup-script.mjs";
import { createStatsReader, hourlyChartFloor } from "./lib/stats.mjs";
import { createSettingsWriter } from "./lib/settings-write.mjs";
import { createUsageReader } from "./lib/personal-usage.mjs";
import { createLeaderboardReader } from "./lib/leaderboard.mjs";
import { createSessionsReader } from "./lib/sessions.mjs";
import { createNotifier } from "./lib/notifier.mjs";
import { createPersistence } from "./lib/persistence.mjs";
import { createMemberRewards } from "./lib/member-rewards.mjs";
import { getApiKey, makeClientAbortError, isClientAbortError, createClientAbortState, markClientAborted, addClientAbortListener, setActiveUpstreamRequest, throwIfClientAborted, sleepWithClientAbort, jitter, buildUpstreamPath, extractClientSignal } from "./lib/proxy-helpers.mjs";
import { createVisionBridge } from "./lib/vision-bridge.mjs";
import { createToolPatternCompat } from "./lib/tool-pattern-compat.mjs";
import { createProxyCore } from "./lib/proxy-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Send a JSON response with gzip when the client accepts it (the stats payload
// is nested-dict heavy and compresses ~10x, which matters for 30s polling).
function sendJson(res, obj, req) {
  const body = Buffer.from(JSON.stringify(obj));
  const accept = (req && req.headers && req.headers["accept-encoding"]) || "";
  if (accept.includes("gzip") && body.length >= 1024) {
    const gz = zlib.gzipSync(body);
    res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Vary": "Accept-Encoding" });
    res.end(gz);
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────
const configPath = path.join(__dirname, "config.json");
function loadConfig() {
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}
function saveConfig(cfg) {
  const text = JSON.stringify(cfg, null, 2);
  const tempPath = `${configPath}.tmp`;
  fs.writeFileSync(tempPath, text, "utf-8");
  try {
    fs.renameSync(tempPath, configPath);
  } catch (err) {
    // 单文件 bind mount(docker -v config.json:/app/config.json)会让容器内目标变成挂载点,
    // 对它 rename 覆盖必然 EBUSY(Linux 的 vfs_rename 同样检查 is_local_mountpoint,非 macOS 独有)。
    // 此时原子性让位给可用性,退回原地写,否则设置页等 30+ 处保存全部失败。
    if (err.code !== "EBUSY" && err.code !== "EXDEV") throw err;
    fs.writeFileSync(configPath, text, "utf-8");
    fs.rmSync(tempPath, { force: true });
  }
}

const config = loadConfig();
// 废弃键提示:等值成本峰时段已改为复用各方案的 peakHours,旧全局配置静默失效。
// 只提示不自动迁移(峰时段语义随方案,无法机械换算);下次保存产出设置时遗留键会被物理清除。
if (((config.productionTracking || {}).costPeakHours || []).length > 0) {
  console.log("[CONFIG] productionTracking.costPeakHours 已废弃:等值成本峰时段现复用各方案设置里的高峰时段,请到方案设置中配置");
}
const { port } = config;
const dashboardPassword = config.dashboardPassword || "";
const dataPath = path.join(__dirname, "data.json");
const dbPath = path.join(__dirname, "data.db");
const backupDir = path.join(__dirname, "backups");
// 页面静态资源（public/assets/）在启动时读入内存并按内容生成 ?v= 版本号；
// 引用见各页面模板的 assets.url(...)，服务路由在 createServer 入口处。
const assets = loadAssets(path.join(__dirname, "public", "assets"));
const RESERVED_SUFFIXES = new Set(["dashboard", "settings", "api", "health", "usage", "my-usage", "v1", "login", "logout", "favicon", "robots", "js", "css", "responses", "models", "leaderboard", "sessions", "my-activity", "wiki", "mcp"]);
const PROFILE_SUFFIX_RE = /^[a-z0-9_-]{2,20}$/;

// ─── Docsify Wiki（静态使用手册）────────────────────────────────────────────
// wiki/ 目录是一套 docsify 静态站点（/wiki/ 访问），面向使用者的功能手册。
// 有意不鉴权：内容只有公开的功能说明，不含密钥或按请求数据（同 /assets 定位）。
// 每次请求直接读盘，编辑 wiki/ 下文档即时生效，无需重启进程。
const WIKI_DIR = path.join(__dirname, "wiki");
const WIKI_MIME = {
  ".md": "text/markdown; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function serveWiki(wikiPath, res) {
  let rel = wikiPath.replace(/^\/wiki\//, "");
  if (!rel) rel = "index.html";
  const filePath = path.resolve(WIKI_DIR, rel);
  const mime = WIKI_MIME[path.extname(filePath).toLowerCase()];
  // 只允许解析后仍落在 wiki/ 目录内、且扩展名在白名单里的文件（防穿越、防误读 config/data）。
  if (!mime || (filePath !== WIKI_DIR && !filePath.startsWith(WIKI_DIR + path.sep))) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  let body;
  try {
    body = fs.readFileSync(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache" });
  res.end(body);
}

// ─── MCP 端点（/mcp，成员级工具 + wiki 资源）────────────────────────────────
// 手写的无状态 streamable HTTP 实现（JSON-RPC 2.0）：每个 POST 独立处理、无会话，
// 不提供 SSE（GET → 405，规范允许）。成员接入方式见 wiki/mcp.md：
//   claude mcp add cc-team --transport http https://网关/mcp \
//     --header "Authorization: Bearer jx-虚拟Key"
// 鉴权与成员 API 同约定：未知 key → 401，已知但无可用方案 → 403。
const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_LATEST = "2025-06-18";
const MCP_WIKI_DESC = {
  "README.md": "手册首页与全站导航",
  "quick-start.md": "快速上手：管理员与成员各自的第一步",
  "concepts.md": "核心概念与术语表：方案/额度池/倍率/熔断/粘性会话…",
  "mechanism-quota.md": "配额与计费机制：weighted_tokens 公式、额度池判定、429 结构",
  "mechanism-proxy.md": "代理与调度机制：重试、熔断、failover、粘性会话、调度求值",
  "metrics-reference.md": "指标口径参考：每个数字怎么算出来的",
  "my-usage.md": "我的用量页：签到、日历、用量分析、排行榜",
  "setup-guide.md": "接入配置：Claude Code / Codex 三种接入方式",
  "faq.md": "常见问题：429 的几种含义、报表与扣额对不上等",
};
const MCP_TOOLS = [
  { name: "my_quota", description: "查询我的配额与状态：各额度池的余额（已用/上限/剩余/当前峰谷倍率/临时加量）、今日用量合计、签到状态、本周加量申请余额。开始大任务前或收到 429 之后调用，确认还剩多少额度。", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "price_list", description: "查询当前时段的模型倍率价目表：rate 越低越便宜（配额扣减 = 真实 token × rate）。挑选模型前调用，选便宜又够用的。", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "check_in", description: "每日签到：随机领取一笔 token 奖励（计入当日配额）。每天一次，已签到会如实提示。", inputSchema: { type: "object", properties: {}, required: [] } },
  { name: "request_quota", description: "向管理员提交加量申请（写操作）。每北京日限提交 1 次、每周被处理数有上限；不限量的池无需申请。", inputSchema: { type: "object", properties: { reason: { type: "string", description: "申请理由（必填，200 字以内）" }, pool: { type: "string", description: "额度池名（可选，缺省取第一个可申请的池）" } }, required: ["reason"] } },
  { name: "my_usage", description: "查询我的 token 用量明细：今日（或指定日期范围）合计、按模型统计（真实 token 与计入配额的计权值并排）、24 小时请求分布、按客户端统计。用户问「我今天用了多少/花在哪」时调用。", inputSchema: { type: "object", properties: { start: { type: "string", description: "起始日期 YYYY-MM-DD（北京时间，可选）" }, end: { type: "string", description: "结束日期 YYYY-MM-DD（可选，缺省=起始日）" }, protocol: { type: "string", enum: ["anthropic", "responses"], description: "可选协议过滤" } }, required: [] } },
  { name: "leaderboard", description: "团队排行榜：7 个维度（cache_rate 缓存率 / code_quality 代码质量 / code_lines 代码行数 / tokens 用量 / efficiency 效率比 / context_health 上下文健康度 / activity 活跃度）× 时间窗（today/week/month）。", inputSchema: { type: "object", properties: { dimension: { type: "string", enum: ["cache_rate", "code_quality", "code_lines", "tokens", "efficiency", "context_health", "activity"] }, window: { type: "string", enum: ["today", "week", "month"] } }, required: [] } },
  { name: "code_review_list", description: "查看代码评审：哪些仓库允许在线触发、各自上次评审状态、最近的评审运行（状态/意见数/token）。想知道「我的改动评过没有」时调用。仅对获授权的 Key 可见。", inputSchema: { type: "object", properties: { limit: { type: "number", description: "返回最近多少次运行（默认 10，最多 50）" } }, required: [] } },
  { name: "code_review_trigger", description: "触发一次代码评审（写操作，消耗 token）。评审的是仓库里**已提交**的最新代码，不是工作区未提交的改动。每 Key 60 秒只能触发一次；仓库需管理员开启「允许在线触发」。", inputSchema: { type: "object", properties: { repo: { type: "string", description: "仓库名称或 ID（可选，缺省=全部已开启在线触发的仓库）" } }, required: [] } },
  { name: "code_review_findings", description: "查询代码评审**发现的具体问题**（文件、行号、问题描述、建议改法）。用户问「最近有没有代码评审的问题」「我负责的仓库有哪些要改的」时调用这个（而不是 code_review_list —— 那个只有计数）。只返回自己是成员的仓库。", inputSchema: { type: "object", properties: {
    repo: { type: "string", description: "仓库名称或 ID（可选，缺省=自己负责的全部仓库）" },
    since: { type: "string", description: "只看这个时间之后的评审，如 7d / 24h / 2026-09-18（北京时间，可选）" },
    limit: { type: "number", description: "最多返回多少条意见（默认 20，最多 100）" },
    unseenOnly: { type: "boolean", description: "只返回自己在「我的用量」页还没看过的（配合菜单小红点）" },
  }, required: [] } },
];

// 触发类工具只在获授权的 Key 上可见(未授权者 tools/list 里根本看不到),
// 工具名清单放这里,避免在 schema 里塞标记位污染 tools/list 的输出。
const MCP_CR_TOOLS = new Set(["code_review_list", "code_review_trigger", "code_review_findings"]);
function mcpVisibleTools(apiKey) {
  try {
    if (codeReviewApi.canTrigger(apiKey)) return MCP_TOOLS;
  } catch { /* 功能未启用/未初始化 → 全部隐藏 */ }
  return MCP_TOOLS.filter((t) => !MCP_CR_TOOLS.has(t.name));
}

function mcpWikiResources() {
  let files = [];
  try {
    files = fs.readdirSync(WIKI_DIR).filter(f => f.endsWith(".md") && f !== "_sidebar.md").sort();
  } catch { /* wiki 目录缺失时资源为空,不影响工具 */ }
  return files.map(f => ({ uri: "wiki://" + f, name: f.replace(/\.md$/, ""), title: f, mimeType: "text/markdown", description: MCP_WIKI_DESC[f] || "使用手册页面" }));
}

function mcpRpcSend(res, id, key, value) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, [key]: value }));
}
function mcpRpcResult(res, id, result) { mcpRpcSend(res, id, "result", result); }
function mcpRpcError(res, id, code, message) { mcpRpcSend(res, id, "error", { code, message }); }
// 聚合视图的 remaining 无限时是 Infinity,JSON.stringify 会变 null —— 统一转 "unlimited"。
const mcpQuotaRow = p => ({
  pool: p.profile, type: p.type,
  limit: p.limit, used: p.used,
  remaining: Number.isFinite(p.remaining) ? p.remaining : "unlimited",
  pct: p.pct, rate: p.rate, inPeak: p.inPeak, nextRateChange: p.nextRateChange,
  bonus: p.bonus || 0, resetApplied: !!p.resetApplied,
});

function handleMcpPost(res, body, ctx) {
  let msg;
  try { msg = JSON.parse(body.toString() || ""); } catch { mcpRpcError(res, null, -32700, "Parse error"); return; }
  const { id, method, params } = msg || {};
  if (!method || typeof method !== "string") { mcpRpcError(res, id ?? null, -32600, "Invalid Request"); return; }
  // 通知(无 id):202 空响应,规范允许无-body 应答
  if (method.startsWith("notifications/")) { res.writeHead(202); res.end(); return; }
  if (method === "initialize") {
    const requested = params?.protocolVersion;
    mcpRpcResult(res, id, {
      protocolVersion: MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_LATEST,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "cc-team", version: "1.0.0" },
    });
    return;
  }
  if (method === "ping") { mcpRpcResult(res, id, {}); return; }
  if (method === "tools/list") { mcpRpcResult(res, id, { tools: mcpVisibleTools(ctx.apiKey) }); return; }
  if (method === "tools/call") {
    const name = params?.name, args = params?.arguments || {};
    try {
      let out;
      if (name === "my_quota") {
        const payload = usageApi.getPersonalUsageData(ctx.apiKey, "all", "", null);
        out = {
          username: payload.username,
          quotas: (payload.profileQuotas || []).map(mcpQuotaRow),
          today: payload.today,
          checkin: payload.checkin ? { checkedInToday: !!payload.checkin.checkedInToday, streak: payload.checkin.streak, todayAmount: payload.checkin.todayAmount } : undefined,
          quotaRequest: payload.quotaRequest ? { remainingThisWeek: payload.quotaRequest.remaining, pools: payload.quotaRequest.pools } : undefined,
        };
      } else if (name === "price_list") {
        const payload = usageApi.getPersonalUsageData(ctx.apiKey, "all", "", null);
        out = (payload.rateCards || []).map(rc => ({
          profile: rc.profile, inPeak: rc.inPeak, defaultPeak: rc.defaultPeak, defaultOffPeak: rc.defaultOffPeak,
          models: (rc.rows || []).map(r => ({ alias: r.alias, model: r.model, currentRate: r.rate, custom: !!r.custom, peak: r.peak, offPeak: r.offPeak })),
        }));
      } else if (name === "check_in") {
        const result = memberRewardsApi.performCheckIn(ctx.apiKey, ctx.ip);
        out = { success: true, amount: result.amount, pools: result.pools, streak: result.streak, totalCheckIns: result.totalCheckIns, totalTokens: result.totalTokens };
      } else if (name === "request_quota") {
        const reason = String(args.reason || "").trim();
        if (!reason) throw new Error("必须填写加量申请理由");
        let pool = String(args.pool || "").trim();
        if (!pool) {
          const st = memberRewardsApi.getQuotaRequestStatus(ctx.apiKey);
          const first = (st.pools || []).find(p => p.limited);
          if (!first) throw new Error("你的池均未设置配额上限，无需申请加量");
          pool = first.name;
        }
        const result = memberRewardsApi.createQuotaRequest(ctx.apiKey, reason, pool, ctx.ip);
        out = { success: true, justCreated: !!result.justCreated, remainingThisWeek: result.remaining, myRecent: (result.myRecent || []).slice(0, 5).map(r => ({ poolLabel: r.poolLabel, status: r.status, adminNote: r.adminNote || "", createdAt: r.createdAt })) };
      } else if (name === "my_usage") {
        const protocol = args.protocol === "anthropic" || args.protocol === "responses" ? args.protocol : "";
        const payload = usageApi.getPersonalUsageData(ctx.apiKey, "all", protocol, parseDateRange(args.start || null, args.end || null));
        out = {
          range: payload.usageRange || undefined,
          today: payload.today,
          models: Object.entries(payload.models || {}).map(([model, v]) => ({ model, requests: v.requests || 0, tokens: (v.inputTokens || 0) + (v.outputTokens || 0), weighted: v.weighted, rate: v.rate })).sort((a, b) => b.requests - a.requests),
          // 小时分布是半小时键("HH:00"/"HH:30",共 48 槽),压成 48 元素请求数数组省 token
          hourlyRequests: payload.hourly ? Array.from({ length: 48 }, (_, i) => payload.hourly[`${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`]?.requests || 0) : undefined,
          clients: payload.clients ? Object.entries(payload.clients).map(([client, v]) => ({ client, requests: v.requests || 0, tokens: (v.inputTokens || 0) + (v.outputTokens || 0) })) : undefined,
        };
      } else if (name === "leaderboard") {
        const payload = leaderboardApi.getLeaderboard({ dimension: String(args.dimension || ""), window: String(args.window || ""), meKey: resolveUserKey(ctx.apiKey) });
        out = {
          dimension: payload.dimensionLabel, direction: payload.direction, unit: payload.unit,
          hint: payload.hint, cohort: payload.cohort, note: payload.note || undefined,
          rows: (payload.rows || []).map(r => ({ rank: r.rank, name: r.user_name, value: r.value, isMe: !!r.isMe })),
        };
      } else if (name === "code_review_list") {
        const c = config.codeReview || {};
        // 只看得到**自己负责的**仓库(仓库成员名单),不是「所有开了在线触发的仓库」——
        // 否则一个仓库的成员能看到全部仓库的元数据与运行记录。
        // 用 visible 口径(不是 triggerable):能不能看结果与「是否开放外部触发」无关。
        const repos = codeReviewApi.reposVisibleTo(ctx.apiKey);
        const allowed = new Set(repos.map(r => r.id));
        const states = codeReviewApi.repoStates();
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
        const { rows } = codeReviewApi.listRuns({ limit: 200 });
        out = {
          enabled: !!c.enabled,
          repos: repos.map(r => {
            const st = states[r.id] || {};
            return {
              name: r.name, id: r.id, branch: r.branch,
              schedule: r.schedule?.mode === "off" ? "不定时" : r.schedule?.mode === "interval" ? `每 ${r.schedule.intervalHours} 小时` : `每天 ${r.schedule.at}`,
              lastStatus: st.last_status || null, lastRunAt: bjStamp(st.last_run_at), lastCommit: st.last_commit ? String(st.last_commit).slice(0, 8) : null,
              consecutiveFailures: st.consecutive_failures || 0,
            };
          }),
          recentRuns: rows.filter(r => allowed.has(r.repo_id)).slice(0, limit).map(r => ({
            id: r.id, repo: r.repo_name, status: r.status, trigger: r.trigger,
            range: r.range_mode === "single" ? `单提交 ${String(r.to_commit || "").slice(0, 8)}` : `${String(r.from_commit || "").slice(0, 8)}→${String(r.to_commit || "").slice(0, 8)}`,
            files: r.files_reviewed, comments: r.comments_count,
            tokens: (r.input_tokens || 0) + (r.output_tokens || 0),
            createdAt: bjStamp(r.created_at), note: r.note || undefined, error: r.error || undefined,
          })),
        };
      } else if (name === "code_review_findings") {
        // 「最近有没有代码评审的问题」—— 这才是 MCP 的价值:把**具体意见**交回给模型,
        // 用户看完再决定改不改、怎么改。code_review_list 只给计数,答不了这个问题。
        const repos = codeReviewApi.reposVisibleTo(ctx.apiKey);
        const wanted = String(args.repo || "").trim();
        let targets = repos;
        if (wanted) {
          targets = repos.filter((r) => r.id === wanted || r.name === wanted);
          if (!targets.length) { mcpRpcResult(res, id, { content: [{ type: "text", text: `仓库「${wanted}」不在你负责的范围内` }], isError: true }); return; }
        }
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
        const since = mcpSinceIso(args.since);
        // unseenOnly:只看「上次打开我的用量之后」的 —— 与菜单小红点同一口径
        const seenAt = args.unseenOnly ? memberNotifyApi.lastSeen(ctx.apiKey) : null;
        let rows = codeReviewApi.listFindings({ repoIds: targets.map((r) => r.id), since, limit: limit + 1 });
        if (seenAt) rows = rows.filter((c) => String(c.created_at) > String(seenAt));
        const truncated = rows.length > limit;
        rows = rows.slice(0, limit);
        const clip = (v, n) => {
          const t = String(v == null ? "" : v);
          return t.length > n ? t.slice(0, n) + "…" : t;
        };
        out = {
          repos: targets.map((r) => r.name),
          since: args.since || null,
          summary: {
            findings: rows.length,
            repos: new Set(rows.map((c) => c.repo_id)).size,
            runs: new Set(rows.map((c) => c.run_id)).size,
            truncated: truncated || undefined,
          },
          findings: rows.map((c) => ({
            repo: c.repo_name,
            runId: c.run_id,
            at: bjStamp(c.created_at),
            branch: c.branch || undefined,
            commit: String(c.to_commit || "").slice(0, 8) || undefined,
            author: c.author_name || undefined,
            path: c.path,
            line: c.start_line ? (c.end_line && c.end_line !== c.start_line ? `${c.start_line}-${c.end_line}` : String(c.start_line)) : undefined,
            // 单条字段可能到 8KB(落库上限),这里再截一次:交给模型的是摘要,全文让人去页面看
            content: clip(c.content, 1200),
            suggestion: c.suggestion_code ? clip(c.suggestion_code, 1500) : undefined,
            clipped: c.truncated ? true : undefined,
          })),
        };
        if (!out.findings.length) {
          out.note = repos.length ? "这段时间没有评审出问题（或还没有评审记录）" : "你还不是任何仓库的成员";
        }
      } else if (name === "code_review_trigger") {
        const r = triggerReviewForKey(ctx.apiKey, args.repo);
        if (r.status >= 400) { mcpRpcResult(res, id, { content: [{ type: "text", text: r.body.error }], isError: true }); return; }
        recordAdminAudit({ headers: { "x-forwarded-for": ctx.ip || "mcp" } }, "codereview.trigger.mcp", r.actor,
          `MCP 触发代码评审（${(r.results || []).map((x) => `${x.repo}#${x.runId ?? "-"}`).join("、")}）`);
        out = r.body;
      } else {
        mcpRpcResult(res, id, { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true });
        return;
      }
      mcpRpcResult(res, id, { content: [{ type: "text", text: JSON.stringify(out) }] });
    } catch (err) {
      // 业务规则失败(已签到/日限/周限/池不限量等)按规范回 isError 的工具结果,让人话文案进模型上下文。
      mcpRpcResult(res, id, { content: [{ type: "text", text: err.message }], isError: true });
    }
    return;
  }
  if (method === "resources/list") { mcpRpcResult(res, id, { resources: mcpWikiResources() }); return; }
  if (method === "resources/read") {
    const uri = String(params?.uri || "");
    const known = mcpWikiResources().find(r => r.uri === uri);
    if (!known) { mcpRpcError(res, id, -32602, `Unknown resource: ${uri}`); return; }
    let text;
    try { text = fs.readFileSync(path.join(WIKI_DIR, known.title), "utf8"); } catch { mcpRpcError(res, id, -32602, `Resource unavailable: ${uri}`); return; }
    mcpRpcResult(res, id, { contents: [{ uri, mimeType: "text/markdown", text }] });
    return;
  }
  mcpRpcError(res, id, -32601, `Method not found: ${method}`);
}

// ─── Codex remote compact 的 WebSocket 通道(/v1/responses upgrade)──────────────
// Codex 的 remote compact(会话压缩)走私有 WS 协议且只认内置通道(顶层 openai_base_url
// + auth.json):连接建立后客户端发一帧 response.create JSON(帧体=标准 Responses 请求),
// 服务端把它合成一次普通 POST /v1/responses 走 proxyRequest 全链路(鉴权/配额/failover/
// 记账全部复用),再把上游 SSE 的每个 data: 事件 JSON 作为 WS 文本帧回传;连接保持复用。
// 普通 Codex 客户端(自定义 provider)先探测 WS、404 则回落 HTTPS POST+SSE —— 所以这条
// 通道与 HTTP 完全并存,不接 upgrade 时旧行为不变(协议情报来自 codex-proxy 的实测实现)。
const WS_STRIP_HEADERS = new Set(["connection", "host", "upgrade", "sec-websocket-key",
  "sec-websocket-version", "sec-websocket-extensions", "sec-websocket-protocol",
  "content-length", "transfer-encoding"]);

function wsErrorFrame(conn, type, code, message) {
  try { conn.send(JSON.stringify({ type: "error", error: { type, code, message } })); } catch { /* 连接已死 */ }
}

// proxyRequest 的 res 替身:实现它用到的最小面(writeHead/write/end/headersSent/
// writableEnded/statusCode + error/close/finish 事件)。SSE 字节流在这里按空行分帧、
// 抽 data: 行转 WS 文本帧;非流式(错误 JSON / 理论上的整读整写)整体作单帧或 error 帧。
// 「finish」事件是 proxy-core 里 attachRequestLogger 的请求日志钩子;WS 客户端断开时
// emit "close"(writableEnded=false)触发 markClientAborted 销毁上游 —— 两条隐式链路都接上。
class WsResponder extends EventEmitter {
  constructor(conn, opts = {}) {
    super();
    this.conn = conn;
    this.statusCode = 0;
    this._headersSent = false;
    this._writableEnded = false;
    this._doneEmitted = false;
    this._mode = "unknown";
    this._sseBuf = "";
    this._jsonChunks = [];
    this._pendingRaw = [];
    // remote compact:压缩请求的响应要把普通 message 条目合成成客户端要求的
    // compaction 条目(第三方上游不实现该私有类型,见 lib/compact-bridge.mjs 头注释)。
    // 普通轮次保持零解析直通 —— 只有 compactMode 才解析每个 data 行。
    this._compactMode = !!opts.compactMode;
    this._compactState = { count: 0 };
  }
  get headersSent() { return this._headersSent; }
  get writableEnded() { return this._writableEnded; }
  writeHead(status, headers) {
    if (this._headersSent) return;
    this.statusCode = status;
    this._headersSent = true;
    // 注意:proxy 对 200 流式响应一律强制 content-type: text/event-stream(见
    // proxy-core 的 h 构造),上游回的单个 JSON 也会顶着 SSE 头 —— 所以真实路由
    // 不看头,看内容嗅探(_route 里首个非空白字符)。这里只记录状态码。
  }
  write(chunk) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this._route(text);
    return true;
  }
  // 内容嗅探路由:首段内容以 { 或 [ 开头 → 整包按 JSON 单帧;否则按 SSE 逐事件解析。
  // 未定型前缓冲在 _pendingRaw,首段到达即定型并回放。
  _route(text) {
    if (this._mode === "unknown") {
      this._pendingRaw.push(text);
      const head = this._pendingRaw.join("").trimStart();
      if (!head) return;
      this._mode = (head[0] === "{" || head[0] === "[") ? "json" : "sse";
      const pending = this._pendingRaw.splice(0).join("");
      this._mode === "json" ? this._jsonChunks.push(pending) : this._feedSse(pending);
      return;
    }
    if (this._mode === "json") this._jsonChunks.push(text);
    else this._feedSse(text);
  }
  _feedSse(text) {
    this._sseBuf += text;
    let idx;
    while ((idx = this._sseBuf.indexOf("\n\n")) >= 0) {
      const block = this._sseBuf.slice(0, idx);
      this._sseBuf = this._sseBuf.slice(idx + 2);
      this._emitSseBlock(block);
    }
  }
  _emitSseBlock(block) {
    for (const line of block.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;          // event:/注释/空行不回传
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      if (this.conn.closed) return;
      if (this._compactMode) {
        // 压缩请求:解析后按 compact-bridge 的规则转换(普通轮次不走这条,保零解析直通)
        let out = payload;
        try {
          const json = JSON.parse(payload);
          out = JSON.stringify(transformCompactSseEvent(json, this._compactState));
        } catch { /* 非 JSON 帧原样转发 */ }
        this.conn.send(out);
        continue;
      }
      this.conn.send(payload);
    }
  }
  end(body) {
    if (body !== undefined && body !== null) this.write(body);
    if (this._writableEnded) return;
    this._writableEnded = true;
    if (this._mode === "unknown") {
      // 整个响应没有任何内容:按空 JSON 处理(错误状态码仍回 error 帧)
      this._mode = "json";
      this._jsonChunks.push(...this._pendingRaw.splice(0));
    }
    if (this._mode === "sse") {
      // 上游流可能没有以空行收尾,残留块也要回传
      if (this._sseBuf.trim()) this._emitSseBlock(this._sseBuf);
      if (this.statusCode >= 400) wsErrorFrame(this.conn, "server_error", "upstream_error", `upstream error ${this.statusCode}`);
    } else {
      const text = this._jsonChunks.join("");
      this._sendJsonOutcome(text);
    }
    this.emit("finish");
    this._done();
  }
  _sendJsonOutcome(text) {
    if (this.conn.closed) return;
    const trimmed = text.trim();
    if (!trimmed) {
      if (this.statusCode >= 400) wsErrorFrame(this.conn, "server_error", "upstream_error", `upstream error ${this.statusCode}`);
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      const errObj = parsed && typeof parsed.error === "object" && parsed.error ? parsed.error : null;
      if (this.statusCode >= 400 || errObj) {
        wsErrorFrame(this.conn,
          (errObj && errObj.type) || "server_error",
          (errObj && errObj.code) || "upstream_error",
          (errObj && errObj.message) || trimmed.slice(0, 500));
      } else {
        this.conn.send(trimmed);
      }
    } catch {
      wsErrorFrame(this.conn, "server_error", "upstream_error", trimmed.slice(0, 500));
    }
  }
  // WS 客户端断开而请求未完成:emit close 让代理杀上游(abort 日志也由 logger 的 close 钩子落)
  clientGone() {
    if (!this._writableEnded) {
      this.emit("close");
      this._done();
    }
  }
  _done() { if (!this._doneEmitted) { this._doneEmitted = true; this.emit("done"); } }
}

// 一帧 response.create → 合成 POST 喂 proxyRequest。一条连接同时只跑一帧(协议约定)。
function dispatchWsFrame(conn, upReq, pathname, frameText) {
  if (conn._busy) {
    wsErrorFrame(conn, "server_error", "connection_busy", "A response.create is already in progress on this connection");
    return;
  }
  conn._busy = true;
  const release = () => { conn._busy = false; };
  let bodyObj;
  try {
    bodyObj = JSON.parse(frameText);
  } catch {
    release();
    wsErrorFrame(conn, "invalid_request_error", "invalid_json", "帧不是合法 JSON");
    return;
  }
  // 真实帧形状(经 codex 0.145 真机抓帧确认):顶层 {"type":"response.create","model":…,
  // "input":…,"tools":…} —— 平铺的 Responses 请求体加一个 type 标记;个别版本可能嵌套
  // 在 response:{…} 里。两种都剥掉协议包装(type 字段不能透传上游),拿到纯请求体。
  if (bodyObj && typeof bodyObj === "object" && !Array.isArray(bodyObj) && bodyObj.type === "response.create") {
    bodyObj = (bodyObj.response && typeof bodyObj.response === "object") ? bodyObj.response : { ...bodyObj };
    delete bodyObj.type;
  }
  if (bodyObj && typeof bodyObj === "object" && !Array.isArray(bodyObj)) bodyObj = { ...bodyObj, stream: true };
  const headers = { "content-type": "application/json", accept: "text/event-stream" };
  for (const [k, v] of Object.entries(upReq.headers)) {
    if (typeof v === "string" && !WS_STRIP_HEADERS.has(k)) headers[k] = v;
  }
  headers.authorization = "Bearer " + (conn._apiKey || "");
  const mockReq = new PassThrough();
  mockReq.method = "POST";
  mockReq.url = pathname;                    // ?key= 已剥,不会再透传给上游
  mockReq.headers = headers;
  mockReq.socket = { remoteAddress: upReq.socket.remoteAddress };   // getClientIp 的兜底读点
  const compactMode = isCompactionRequest(bodyObj);
  const responder = new WsResponder(conn, { compactMode });
  responder.once("done", release);
  conn.once("close", () => responder.clientGone());
  proxyCoreApi.proxyRequest(mockReq, responder);
  mockReq.end(Buffer.from(JSON.stringify(bodyObj), "utf8"));
}

function handleResponsesWsUpgrade(req, socket, head) {
  let pathname = "", queryKey = "";
  try {
    const u = new URL(req.url || "/", "http://localhost");
    pathname = u.pathname;
    queryKey = u.searchParams.get("key") || "";
  } catch { socket.destroy(); return; }
  // 只接 responses 入口(默认与带方案后缀两种);其余 upgrade 一律断开,不与未来可能的
  // 其他 WS 用途抢连接。方案合法性交给 proxyRequest 内部再校一遍。
  if (!/^\/(?:[a-zA-Z0-9_-]{2,20}\/)?v1\/responses\/?$/.test(pathname)) { socket.destroy(); return; }
  // 握手鉴权:Authorization/x-api-key 优先;?key= 兜底(浏览器式 WS 客户端设不了自定义头)。
  // 认证用哪个 key,合成请求就带哪个 —— 不透传 upgrade 头里可能过期的原值。
  const headerKey = getApiKey(req);
  const apiKey = (headerKey && headerKey !== "unknown") ? headerKey : queryKey;
  if (!getAccessibleProfiles(apiKey).length) {
    const known = hasGlobalUser(apiKey);
    wsRejectUpgrade(socket, known ? 403 : 401, known ? "User is not allowed to view any profile." : "认证失败：请提供有效的虚拟Key (Authorization: Bearer jx-... 或 ?key=jx-...)");
    return;
  }
  if (!wsAcceptUpgrade(req, socket)) { socket.destroy(); return; }
  const conn = new WsConn(socket);
  conn._apiKey = apiKey;
  if (head && head.length) conn._feed(head);
  conn.on("text", (frame) => { try { dispatchWsFrame(conn, req, pathname, frame); } catch (err) { wsErrorFrame(conn, "server_error", "internal_error", err.message); } });
}

// 「方案代码」——把一套方案的配置搬到别的环境时用的可粘贴 JSON。格式标记和版本
// 一起放在信封里（而不是混进 profile 对象），导入时先验它：粘错了东西能立刻得到
// 一句人话，而不是一个字段残缺的方案。信封结构：
//   { codeFormat, codeVersion, name, suffix, profile: {…除了 users/quotaPool/suffix…} }
const PROFILE_CODE_FORMAT = "token-monitor-profile";
const PROFILE_CODE_VERSION = 1;

// 这几个名字在 `obj[name] = v` 时不会变成普通属性：`__proto__` 会改写原型（此后所有
// 按名字查表都可能认错），另两个会让"这个键存在吗"之类的判断走岔。方案名与池名都是
// 配置对象上的键，而且可能来自粘贴进来的代码，所以一律拒收。
const UNSAFE_CONFIG_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function hasOwnKey(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

// A profile serves exactly one client protocol. The two pools are strictly
// isolated: routing, default groups and failover never cross protocols.
function normalizeProfileProtocol(value) {
  return String(value || "").trim().toLowerCase() === "responses" ? "responses" : "anthropic";
}

function totalUsageTokens(usage = {}) {
  return (usage.inputTokens ?? usage.input_tokens ?? usage.input ?? 0) +
    (usage.outputTokens ?? usage.output_tokens ?? usage.output ?? 0) +
    (usage.cacheCreationTokens ?? usage.cache_creation ?? usage.cacheWrite ?? 0) +
    (usage.cacheReadTokens ?? usage.cache_read ?? usage.cacheRead ?? 0);
}

function backupTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function backupFileSync(source, label, reason) {
  if (!fs.existsSync(source)) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `${backupTimestamp()}-${reason}-${label}`);
  fs.copyFileSync(source, target);
  return target;
}

function backupDatabaseSync(reason) {
  if (!db || !fs.existsSync(dbPath)) return null;
  db.pragma("wal_checkpoint(FULL)");
  return backupFileSync(dbPath, "data.db", reason);
}

function normalizeProfileSuffix(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 20);
}

function makeProfileSuffix(name, used, fallbackIndex = 1) {
  let base = normalizeProfileSuffix(name);
  if (!base || base.length < 2 || RESERVED_SUFFIXES.has(base)) base = `p${fallbackIndex}`;
  if (base.length < 2) base = `p${fallbackIndex}`;
  let suffix = base;
  let i = 2;
  while (used.has(suffix) || RESERVED_SUFFIXES.has(suffix) || !PROFILE_SUFFIX_RE.test(suffix)) {
    const tail = String(i++);
    suffix = `${base.slice(0, Math.max(2, 20 - tail.length))}${tail}`;
  }
  used.add(suffix);
  return suffix;
}

function validateProfileSuffix(suffix, currentProfileName = null) {
  const sfx = normalizeProfileSuffix(suffix);
  if (!sfx) throw new Error("URL 后缀不能为空");
  if (!PROFILE_SUFFIX_RE.test(sfx)) throw new Error("URL 后缀只能使用 2-20 位小写字母、数字、下划线或连字符");
  if (RESERVED_SUFFIXES.has(sfx)) throw new Error(`后缀 "${sfx}" 是系统保留的，请使用其他名称`);
  for (const [name, profile] of Object.entries(config.profiles || {})) {
    if (name !== currentProfileName && normalizeProfileSuffix(profile.suffix) === sfx) {
      throw new Error(`后缀 "${sfx}" 已被方案 "${name}" 使用`);
    }
  }
  return sfx;
}

// Every profile needs a pool; accept an existing one or create a same-named one so
// quota enforcement never runs against nothing (= unlimited). Returns which branch
// ran so the caller can tell the admin which pool the profile ended up sharing.
// 注意 requestedPool 只在"点名了一个已存在的池"时才算数：选择"新建"（空值）时
// 一定新建，重名就顺着 -2/-3 排下去，绝不悄悄并进一个同名池——新建弹窗里那个
// 选项承诺的是"独立额度"。
function resolveOrCreateQuotaPool(requestedPool, profileName) {
  const requested = normalizeQuotaPoolName(requestedPool);
  if (requested && hasOwnKey(config.quotaPools, requested)) return { poolName: requested, action: "reused" };
  const rawBase = normalizeQuotaPoolName(profileName) || "pool";
  const base = UNSAFE_CONFIG_KEYS.has(rawBase) ? "pool" : rawBase;
  let poolName = base;
  // 候选名要给序号留位置：先按整名截断再拼序号的话，40 字的方案名会切回原名，
  // 循环永远退不出去。
  for (let i = 2; hasOwnKey(config.quotaPools, poolName); i++) {
    const tail = `-${i}`;
    poolName = base.slice(0, Math.max(1, QUOTA_POOL_NAME_MAX - tail.length)) + tail;
  }
  config.quotaPools[poolName] = { label: profileName, dailyTokenLimit: null, users: {} };
  return { poolName, action: "created" };
}

function legacyDefaultModelAliases(defaultModels = {}) {
  const aliases = {};
  if (defaultModels.sonnet) aliases["jx-sonnet"] = String(defaultModels.sonnet).trim();
  if (defaultModels.opus) aliases["jx-opus"] = String(defaultModels.opus).trim();
  if (defaultModels.haiku) aliases["jx-haiku"] = String(defaultModels.haiku).trim();
  return aliases;
}

function normalizeModelAliases(value) {
  const aliases = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return aliases;
  for (const [alias, target] of Object.entries(value)) {
    const key = String(alias || "").trim();
    const mapped = String(target || "").trim();
    if (key && mapped) aliases[key] = mapped;
  }
  return aliases;
}

function parseModelAliasesInput(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return normalizeModelAliases(value);
  const aliases = {};
  const raw = String(value || "").trim();
  if (!raw) return aliases;
  for (const part of raw.split(/[\n,]+/)) {
    const item = part.trim();
    if (!item) continue;
    const sep = item.includes("=") ? "=" : item.includes(":") ? ":" : "";
    if (!sep) throw new Error(`模型别名格式错误: ${item}`);
    const [aliasRaw, ...targetParts] = item.split(sep);
    const alias = aliasRaw.trim();
    const target = targetParts.join(sep).trim();
    if (!alias || !target) throw new Error(`模型别名格式错误: ${item}`);
    aliases[alias] = target;
  }
  return aliases;
}

function getProfileModelAliases(profile) {
  return normalizeModelAliases(profile?.modelAliases || {});
}

function getConfigurableModelAliases(profile) {
  return normalizeModelAliases(profile?.modelAliases || {});
}

function formatModelAliasesInput(aliases = {}) {
  return Object.entries(normalizeModelAliases(aliases))
    .map(([alias, target]) => `${alias}=${target}`)
    .join("\n");
}

// 下面三个归一化器只为「导入方案代码」而存在：那三个字段的写入路径本来只有设置
// 表单（值是表单构造出来的，形状天然正确），而从剪贴板粘进来的 JSON 是手改过的，
// 形状不对会一路带到运行期。

// 别名 → 正整数（modelContextWindows）。非对象/非正数一律丢弃。
function normalizeNumberMap(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    const n = Math.floor(Number(v));
    if (k && Number.isFinite(n) && n > 0) out[k] = n;
  }
  return out;
}

// 别名 → 布尔（modelMultimodal）。字符串 "false"/"0"/"off"/"no" 也算假，因为手写
// JSON 里这几种写法都很常见。读取方按 `!== false` 判真，所以值必须真是布尔。
function normalizeBooleanMap(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    if (!k) continue;
    out[k] = typeof v === "string" ? !["", "0", "false", "off", "no"].includes(v.trim().toLowerCase()) : !!v;
  }
  return out;
}

// 图片桥配置：真正被读的只有 .model（lib/vision-bridge.mjs），enabled 之类别的键
// 原样留着；model 清空时删掉该键，与设置表单的写法一致。
function normalizeImageBridge(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = { ...value };
  const model = String(out.model || "").trim();
  if (model) out.model = model; else delete out.model;
  return out;
}

// Responses 出站端点：与设置表单同一套写法（去尾斜杠、补前导斜杠，空则无）。
function normalizeResponsesPath(value) {
  const v = String(value || "").trim().replace(/\/+$/, "");
  return v ? (v.startsWith("/") ? v : `/${v}`) : undefined;
}

// ─── Profile System ──────────────────────────────────────────────────────────
// Auto-migrate old config format to profile-based
if (!config.profiles) {
  config.profiles = {
    "default": {
      upstream: config.upstream,
      allowedModels: config.allowedModels || null,
      users: config.users || {},
    },
  };
  config.activeProfile = "default";
  delete config.upstream;
  delete config.allowedModels;
  delete config.users;
  saveConfig(config);
}

const removedOpenAIProfileSuffixes = [];
const removedOpenAIUserKeys = new Set();

// One-way migration: the project now supports Anthropic Messages only.
(function migrateProfilesToAnthropicOnly() {
  const openAIProfiles = Object.entries(config.profiles)
    .filter(([, profile]) => String(profile.apiProtocol || "anthropic").toLowerCase() === "openai");
  let migrated = openAIProfiles.length > 0;
  if (openAIProfiles.length > 0) {
    backupFileSync(configPath, "config.json", "remove-openai");
    for (const [name, profile] of openAIProfiles) {
      removedOpenAIProfileSuffixes.push(normalizeProfileSuffix(profile.suffix));
      for (const key of Object.keys(profile.users || {})) removedOpenAIUserKeys.add(key);
      delete config.profiles[name];
    }
  }

  if (Object.keys(config.profiles).length === 0) {
    config.profiles["默认方案"] = {
      suffix: "default",
      isDefault: true,
      upstream: "",
      allowedModels: [],
      modelAliases: {},
      peakModelAliases: {},
      dailyTokenLimit: null,
      users: {},
    };
    migrated = true;
  }

  for (const profile of Object.values(config.profiles)) {
    const explicitAliases = normalizeModelAliases(profile.modelAliases || {});
    const aliases = { ...legacyDefaultModelAliases(profile.defaultModels || {}), ...explicitAliases };
    if (JSON.stringify(profile.modelAliases || {}) !== JSON.stringify(aliases)) migrated = true;
    profile.modelAliases = aliases;
    if (profile.peakModelAliases === undefined) { profile.peakModelAliases = {}; migrated = true; }
    profile.peakModelAliases = normalizeModelAliases(profile.peakModelAliases || {});
    if (!Array.isArray(profile.allowedModels)) profile.allowedModels = [];
    // Union of BOTH maps' values — spreading them by key would let a peak alias
    // with the same key drop the default target from the allowed list.
    for (const target of [...Object.values(aliases), ...Object.values(profile.peakModelAliases)]) {
      if (target && !profile.allowedModels.includes(target)) {
        profile.allowedModels.push(target);
        migrated = true;
      }
    }
    for (const field of ["defaultModels", "apiProtocol", "openaiStreamUsage", "responsesAdapter"]) {
      if (field in profile) {
        delete profile[field];
        migrated = true;
      }
    }
  }

  const assignedKeys = new Set(Object.values(config.profiles).flatMap((profile) => Object.keys(profile.users || {})));
  for (const key of removedOpenAIUserKeys) {
    if (!assignedKeys.has(key) && config.users?.[key]) {
      delete config.users[key];
      migrated = true;
    }
  }

  if (migrated) {
    delete config.activeProfile;
    saveConfig(config);
    console.log(`[MIGRATE] Simplified Claude aliases and removed ${openAIProfiles.length} OpenAI profile(s)`);
  }
})();

// Auto-migrate: separate global users from profile-specific keys
(function migrateGlobalUsers() {
  if (config.users && Object.keys(config.users).length > 0) return; // already migrated
  const globalUsers = {};
  const seen = new Set();
  for (const pname of Object.keys(config.profiles)) {
    const p = config.profiles[pname];
    if (!p.users) continue;
    const newPU = {};
    for (const [vk, raw] of Object.entries(p.users)) {
      const isObj = typeof raw === "object" && raw !== null;
      const username = isObj ? (raw.username || raw.name || "") : (typeof raw === "string" ? raw : "");
      const realKey = isObj ? (raw.key || vk) : vk;
      const expiresAt = isObj ? (raw.expiresAt || null) : null;
      if (!seen.has(vk)) {
        seen.add(vk);
        globalUsers[vk] = { username, expiresAt, disabled: false };
      }
      newPU[vk] = { key: realKey, disabled: false };
    }
    p.users = newPU;
  }
  if (Object.keys(globalUsers).length > 0) {
    config.users = globalUsers;
    saveConfig(config);
    console.log("[MIGRATE] Extracted global users:", Object.keys(globalUsers).length);
  }
})();

// Auto-migrate: ensure per-profile config fields exist. NOTE: dailyTokenLimit is
// deliberately absent here — it now lives on the quota pool and is migrated (and
// removed from profiles) by migrateQuotaPools below. Re-adding it here would make
// the two migrations fight on every boot.
(function migrateQuotaConfig() {
  let migrated = false;
  for (const pname of Object.keys(config.profiles)) {
    const p = config.profiles[pname];
    if (p.peakHours === undefined) { p.peakHours = []; migrated = true; }
    // Quota rates default to 1.0/1.0 so an upgrade is byte-for-byte equivalent to
    // the previous behaviour; discounts are opted into per profile from the UI.
    if (p.peakQuotaRate === undefined) { p.peakQuotaRate = 1; migrated = true; }
    if (p.offPeakQuotaRate === undefined) { p.offPeakQuotaRate = 1; migrated = true; }
    if (p.modelQuotaRates === undefined) { p.modelQuotaRates = {}; migrated = true; }
  }
  if (migrated) { saveConfig(config); console.log("[MIGRATE] Added profile config fields"); }
})();

// Auto-migrate: member gamification defaults — the daily check-in reward range
// and the weekly cap on quota requests. Both stay admin-tunable in Settings;
// this only seeds first-boot values.
(function migrateCheckInAndRequestConfig() {
  let migrated = false;
  if (!config.checkIn || typeof config.checkIn !== "object") { config.checkIn = {}; migrated = true; }
  if (config.checkIn.enabled === undefined) { config.checkIn.enabled = true; migrated = true; }
  if (!Number.isInteger(config.checkIn.minTokens) || config.checkIn.minTokens < 0) { config.checkIn.minTokens = 10000; migrated = true; }
  if (!Number.isInteger(config.checkIn.maxTokens) || config.checkIn.maxTokens < config.checkIn.minTokens) { config.checkIn.maxTokens = 100000; migrated = true; }
  if (!config.quotaRequest || typeof config.quotaRequest !== "object") { config.quotaRequest = {}; migrated = true; }
  if (config.quotaRequest.enabled === undefined) { config.quotaRequest.enabled = true; migrated = true; }
  if (!Number.isInteger(config.quotaRequest.weeklyLimit) || config.quotaRequest.weeklyLimit < 0) { config.quotaRequest.weeklyLimit = 3; migrated = true; }
  if (migrated) { saveConfig(config); console.log("[MIGRATE] Added check-in / quota-request defaults"); }
})();

// ─── Quota Pools ─────────────────────────────────────────────────────────────
// A quota pool is the billing boundary: the profiles inside it draw from ONE
// allowance. This exists because several profiles routinely share a single
// upstream subscription (an Anthropic profile for Claude Code plus a Responses
// profile for Codex, same plan, same account) — with quota scoped per profile,
// one plan's allowance was silently multiplied by the number of profiles, and a
// single member could drain the team's plan while both meters read half full.
//
// Deliberately NOT in the pool: quota rates, peak hours and billingType stay on
// the profile. Keeping rates per profile is what lets two profiles share one
// allowance while still pricing their traffic differently (Codex can cost 1.5×
// while drawing from the same pool), and peakHours has to stay because it also
// drives peakModelAliases, which is routing, not billing.

// Migration is strictly 1:1 — every profile gets its own pool carrying exactly
// the limits it had. Behaviour after the upgrade is byte-for-byte identical;
// merging profiles into a shared pool is a deliberate admin action afterwards.
// Anything else (e.g. dropping every profile into one pool) would silently
// collapse unrelated allowances on upgrade.
(function migrateQuotaPools() {
  let migrated = false;
  if (!config.quotaPools || typeof config.quotaPools !== "object") { config.quotaPools = {}; migrated = true; }
  const used = new Set(Object.keys(config.quotaPools));
  for (const [pname, p] of Object.entries(config.profiles || {})) {
    const existing = normalizeQuotaPoolName(p.quotaPool);
    if (existing && config.quotaPools[existing]) continue;   // already assigned
    // Name the pool after the profile, de-duplicating if that name is taken.
    let name = normalizeQuotaPoolName(pname) || "pool";
    for (let i = 2; used.has(name); i++) name = `${normalizeQuotaPoolName(pname)}-${i}`.slice(0, QUOTA_POOL_NAME_MAX);
    used.add(name);
    const users = {};
    for (const [vk, u] of Object.entries(p.users || {})) {
      if (u && typeof u === "object" && u.dailyTokenLimit != null) users[vk] = { dailyTokenLimit: u.dailyTokenLimit };
    }
    config.quotaPools[name] = {
      label: pname,
      dailyTokenLimit: p.dailyTokenLimit ?? null,
      users,
    };
    p.quotaPool = name;
    migrated = true;
  }
  // The limits now live in the pool; leaving copies on the profile would give
  // two sources of truth and a stale one would eventually be believed.
  for (const p of Object.values(config.profiles || {})) {
    if ("dailyTokenLimit" in p) { delete p.dailyTokenLimit; migrated = true; }
    for (const u of Object.values(p.users || {})) {
      if (u && typeof u === "object" && "dailyTokenLimit" in u) { delete u.dailyTokenLimit; migrated = true; }
    }
  }
  if (migrated) {
    saveConfig(config);
    console.log(`[MIGRATE] Quota pools: ${Object.keys(config.quotaPools).length} pool(s) — ${Object.entries(config.profiles).map(([n, p]) => `${n}→${p.quotaPool}`).join(", ")}`);
  }
})();

// 等值成本的峰时段直接复用各方案已配的 peakHours（GLM 高峰在下午、DeepSeek 在上午+下午，
// 一份全局时段无法适配所有模型）。key 与用量表 profile 列一致（normalizeProfileSuffix 后缀），
// computeCosts 按用量行归属方案取峰段；已删除/改名方案的历史用量取不到 → 基础价（可接受降级）。
// 峰值解析/判定见 ./lib/schedule.mjs。
function profilePeakHoursMap() {
  const out = {};
  for (const p of Object.values(config.profiles || {})) {
    const sfx = normalizeProfileSuffix(p.suffix);
    if (sfx) out[sfx] = normalizePeakHours(p.peakHours);
  }
  return out;
}

// ─── Quota Rate (peak / off-peak weighting) ──────────────────────────────────
// A request's quota cost is (input+output) × the rate of the slot it lands in.
// Rates are per-profile so a Coding-Plan upstream and a pay-per-token upstream
// can price the same tokens differently, and optionally per-model on top of that
// (a "flash" tier costs a fraction of a flagship on the same upstream).
// Anchor convention: 1.0 = "one peak-hour token at the profile's default rate" —
// keeping one slot at 1.0 is what gives the nominal dailyTokenLimit a meaning.
// Auto-migrate: ensure autoQuotaAdjust config exists
(function migrateAutoQuotaConfig() {
  const defaults = { enabled: false, evaluationPeriodDays: 5, hitThreshold: 0.9, triggerRate: 0.9, increaseFactor: 1.15, safetyFactor: 1.3, maxIncreaseFactor: 2.0, maxAutoQuota: 10000000, cooldownDays: 3 };
  if (!config.autoQuotaAdjust) {
    config.autoQuotaAdjust = { ...defaults };
    saveConfig(config);
    console.log("[MIGRATE] Added autoQuotaAdjust config");
  } else {
    let patched = false;
    for (const [k, v] of Object.entries(defaults)) {
      if (config.autoQuotaAdjust[k] === undefined) { config.autoQuotaAdjust[k] = v; patched = true; }
    }
    if (patched) { saveConfig(config); console.log("[MIGRATE] Patched autoQuotaAdjust config"); }
  }
})();

// Auto-migrate: ensure notifier config exists (system-event push notifications)
(function migrateNotifierConfig() {
  const defaults = {
    enabled: false,
    minIntervalSeconds: 300,
    notifyRecovery: true,
    feishuWebhook: "",
    dingtalkWebhook: "",
    wecomWebhook: "",
    serverchanSendKey: "",
    barkServer: "",
    barkDeviceKey: "",
    // 邮件(SMTP)。465 隐式 TLS 是默认;587 记得把 smtpSecure 关掉走 STARTTLS。
    smtpHost: "", smtpPort: 465, smtpSecure: true,
    smtpUser: "", smtpPass: "", smtpFrom: "", smtpTo: "", smtpInsecure: false,
  };
  if (!config.notifier || typeof config.notifier !== "object") {
    config.notifier = { ...defaults };
    saveConfig(config);
    console.log("[MIGRATE] Added notifier config");
  } else {
    let patched = false;
    for (const [k, v] of Object.entries(defaults)) {
      if (config.notifier[k] === undefined) { config.notifier[k] = v; patched = true; }
    }
    if (patched) { saveConfig(config); console.log("[MIGRATE] Patched notifier config"); }
  }
})();

// Auto-migrate: ensure productionTracking config exists (产出质量观测)
(function migrateProductionTrackingConfig() {
  if (!config.productionTracking || typeof config.productionTracking !== "object") {
    config.productionTracking = { enabled: true, storeFilePaths: true };
    saveConfig(config);
    console.log("[MIGRATE] Added productionTracking config");
  }
})();

// Auto-migrate: 代码评审配置(默认关闭)。全新安装没有这一段;补上后设置页与各接口
// 都有稳定的字段形状(避免各处 `|| {}` 满天飞)。归一化走同一份 sanitize。
(function migrateCodeReviewConfig() {
  const next = sanitizeCodeReviewConfig(config.codeReview, config.port || 6789);
  if (!config.codeReview || JSON.stringify(config.codeReview) !== JSON.stringify(next)) {
    config.codeReview = next;
    saveConfig(config);
    console.log("[MIGRATE] Normalized codeReview config");
  }
})();

// Auto-migrate: ensure every profile has a stable suffix, a billing type, and a
// well-formed ordered default profile group (used for /v1 failover). isDefault is
// now derived from defaultProfileGroup[0] rather than stored authoritatively.
(function migrateProfileSuffix() {
  let migrated = false;
  const names = Object.keys(config.profiles);
  const VALID_BILLING = ["coding_plan", "token_plan", "on_demand"];
  const used = new Set();

  // 1) billingType default + suffix normalization
  names.forEach((pname, index) => {
    const profile = config.profiles[pname];
    if (!VALID_BILLING.includes(profile.billingType)) {
      profile.billingType = "on_demand";
      migrated = true;
    }
    const normalized = normalizeProfileSuffix(profile.suffix);
    if (!normalized || used.has(normalized) || RESERVED_SUFFIXES.has(normalized) || !PROFILE_SUFFIX_RE.test(normalized)) {
      profile.suffix = makeProfileSuffix(pname, used, index + 1);
      migrated = true;
    } else {
      if (profile.suffix !== normalized) {
        profile.suffix = normalized;
        migrated = true;
      }
      used.add(normalized);
    }
  });

  // 2) Derive / repair the ordered default profile group.
  if (!Array.isArray(config.defaultProfileGroup)) {
    // First run: build from the legacy explicit isDefault flag (trusted over the old
    // activeProfile hint, which could point at a non-default profile and misroute /v1).
    const explicitDefaults = names.filter(name => config.profiles[name].isDefault);
    const defaultName = explicitDefaults[0] || names[0];
    config.defaultProfileGroup = defaultName ? [defaultName] : [];
    migrated = true;
  } else {
    // Keep only existing, de-duped names; preserve declared order.
    const valid = [];
    for (const name of config.defaultProfileGroup) {
      if (config.profiles[name] && !valid.includes(name)) valid.push(name);
    }
    config.defaultProfileGroup = valid;
  }
  // Guarantee a non-empty group when configured profiles exist.
  if (config.defaultProfileGroup.length === 0 && names.length) {
    const fallback = names.find(n => config.profiles[n].upstream) || names[0];
    if (fallback) {
      config.defaultProfileGroup = [fallback];
      migrated = true;
    }
  }

  // 3) isDefault is now derived from the group head.
  const groupHead = config.defaultProfileGroup[0];
  names.forEach((pname) => {
    const shouldBeDefault = pname === groupHead;
    if (!!config.profiles[pname].isDefault !== shouldBeDefault) {
      config.profiles[pname].isDefault = shouldBeDefault;
      migrated = true;
    }
  });

  if (migrated) {
    saveConfig(config);
    console.log("[MIGRATE] Normalized profiles:", Object.entries(config.profiles).map(([n, p]) => `${n}(${JSON.stringify(p.suffix)},${p.billingType}${p.isDefault ? ",default" : ""})`).join(", "), "group:", JSON.stringify(config.defaultProfileGroup));
  }
})();

// Auto-migrate: per-profile protocol (anthropic | responses) + the responses
// failover group. Existing profiles stay anthropic; the responses group only
// ever holds responses profiles.
(function migrateProfileProtocol() {
  let migrated = false;
  for (const profile of Object.values(config.profiles)) {
    const protocol = normalizeProfileProtocol(profile.protocol);
    if (profile.protocol !== protocol) {
      profile.protocol = protocol;
      migrated = true;
    }
  }
  if (!Array.isArray(config.responsesProfileGroup)) {
    config.responsesProfileGroup = [];
    migrated = true;
  } else {
    const valid = [];
    for (const name of config.responsesProfileGroup) {
      if (config.profiles[name] && normalizeProfileProtocol(config.profiles[name].protocol) === "responses" && !valid.includes(name)) {
        valid.push(name);
      }
    }
    if (valid.length !== config.responsesProfileGroup.length) {
      config.responsesProfileGroup = valid;
      migrated = true;
    }
  }
  if (migrated) {
    saveConfig(config);
    console.log(`[MIGRATE] Added profile protocol field; responses group: ${JSON.stringify(config.responsesProfileGroup)}`);
  }
})();

// Auto-migrate: 方案组调度（命名方案组 + 时间规则 + 手动指定）。
// 必须排在 migrateProfileProtocol 之后 —— 它依赖 profiles 的 protocol 与两个组数组都已定型。
// **规则为空时行为与升级前完全一致**：生效组恒等于基础组，功能完全惰性。这是本功能最重要的
// 安全性质，所以迁移只在真的改了东西时才写盘与打日志。
(function migrateSchedule() {
  const protoOfProfile = (name) => {
    const p = config.profiles[name];
    return p ? normalizeProfileProtocol(p.protocol) : null;
  };
  const before = JSON.stringify([config.scheduleGroups, config.scheduleRules, config.scheduleOverride]);
  const notes = [];

  // 0) 旧扁平格式 → 按协议分桶。旧存储是全局一张表 { 组名: {protocol, members} }，组名
  //    全局唯一 —— 两协议建同名组时后者静默覆盖前者（「Anthropic 方案组消失」的根因）。
  //    新存储两协议各一桶，同名合法；组对象内的 protocol 字段保留（求值链路依赖它）。
  if (config.scheduleGroups && typeof config.scheduleGroups === "object" && !Array.isArray(config.scheduleGroups)
      && Object.values(config.scheduleGroups).some((v) => v && typeof v === "object" && !Array.isArray(v) && typeof v.protocol === "string")) {
    const flat = config.scheduleGroups;
    config.scheduleGroups = {};
    for (const proto of ["anthropic", "responses"]) {
      config.scheduleGroups[proto] = {};
      for (const [name, g] of Object.entries(flat)) {
        if (g && g.protocol === proto) config.scheduleGroups[proto][name] = g;
      }
    }
  }

  // 1) 命名组。成员被剪空的组**保留**（通常来自「组里的方案被删了」）—— 连组带规则一起
  //    静默丢掉会让用户配置凭空消失，留着并由设置页标红才是诚实的失败方式。
  //    分桶后逐协议归一：normalizeScheduleGroups 面向单协议的扁平表（读 value.protocol
  //    校验成员），收窄到各自桶内调用即可复用。
  const groups = {};
  for (const proto of ["anthropic", "responses"]) {
    const bucket = config.scheduleGroups && typeof config.scheduleGroups === "object" ? config.scheduleGroups[proto] : null;
    groups[proto] = normalizeScheduleGroups(bucket && typeof bucket === "object" && !Array.isArray(bucket) ? bucket : {}, protoOfProfile);
  }
  // 2) 规则：按协议分桶保序归一。@base 恒合法；其余必须指向**本协议**已存在的组。
  const rulesIn = (config.scheduleRules && typeof config.scheduleRules === "object" && !Array.isArray(config.scheduleRules)) ? config.scheduleRules : {};
  const rulesOut = {};
  for (const proto of ["anthropic", "responses"]) {
    rulesOut[proto] = normalizeScheduleRules(rulesIn[proto], (name) => {
      const g = groups[proto][name];
      return !!(g && g.protocol === proto);
    });
  }
  // 3) 手动指定。启动是唯一会**物理删除**过期条目的地方之一（另一处是覆盖写路由）；
  //    运行中过期的条目留在 config.json 里但完全 inert —— 请求内只做 expiresAt 比较，
  //    这里不清也不会让过期条目生效，只是会留下一条没人看的记录。
  const overrideOut = {};
  const overrideIn = (config.scheduleOverride && typeof config.scheduleOverride === "object" && !Array.isArray(config.scheduleOverride)) ? config.scheduleOverride : {};
  for (const proto of ["anthropic", "responses"]) {
    const o = overrideIn[proto];
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    const g = typeof o.group === "string" ? o.group : "";
    const until = Date.parse(o.expiresAt);
    // 组名不存在 / 协议不符 / 空组 / 到期时刻不可解析 / 已过期 → 删除。
    let members = null;
    if (g === BASE_GROUP_TOKEN) {
      members = proto === "responses"
        ? (Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup : [])
        : (Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : []);
    } else {
      const grp = groups[proto][g];
      if (grp && grp.protocol === proto) members = grp.members;
    }
    if (!g || !Number.isFinite(until) || until <= Date.now() || !members || members.length === 0) {
      notes.push(`清除无效/已过期的方案组手动指定: ${proto}`);
      continue;
    }
    overrideOut[proto] = o;
  }

  // 空桶不落盘：全新安装保持 scheduleGroups === {}（与升级前逐字一致），省得给手改配置的人
  // 多一层没必要的嵌套；消费端一律 `(config.scheduleGroups || {})[proto] || {}`，两种形状都安全。
  config.scheduleGroups = {};
  for (const proto of ["anthropic", "responses"]) {
    if (Object.keys(groups[proto]).length > 0) config.scheduleGroups[proto] = groups[proto];
  }
  config.scheduleRules = rulesOut;
  config.scheduleOverride = overrideOut;
  const after = JSON.stringify([config.scheduleGroups, config.scheduleRules, config.scheduleOverride]);
  if (before !== after || notes.length > 0) {
    saveConfig(config);
    const summary = Object.entries(rulesOut).map(([p, rs]) => `${p}=${rs.length}`).join(", ");
    const groupCount = Object.values(groups).reduce((n, m) => n + Object.keys(m).length, 0);
    console.log(`[MIGRATE] 方案组调度已归一：组 ${groupCount} 个，规则 ${summary}（规则为空时行为与升级前完全一致）`,
      notes.length ? `；${notes.join("；")}` : "");
  }
})();

function getDefaultProfileName() {
  const group = Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : [];
  for (const name of group) {
    if (config.profiles[name]) return name;
  }
  for (const [name, p] of Object.entries(config.profiles)) {
    if (p.isDefault) return name;
  }
  return Object.keys(config.profiles)[0];
}

function getDefaultProfileSuffix() {
  const profile = config.profiles[getDefaultProfileName()];
  return profile ? profile.suffix : "";
}

function getProfileNameBySuffix(suffix) {
  const sfx = normalizeProfileSuffix(suffix);
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (normalizeProfileSuffix(profile.suffix) === sfx) return name;
  }
  return null;
}

// ── Quota pool resolution ────────────────────────────────────────────────────
// A profile always belongs to exactly one pool. A dangling reference (hand-edited
// config, deleted pool) must not silently become "unlimited" — that would remove
// every limit without a word — so it is repaired into an empty pool and logged.
// 实现已在 lib/quota.mjs 的 buildPoolResolver 工厂；此处注入 config 与它依赖的
// 名/协议/后缀归一化函数，闭包实时读同一 config 引用。
const { resolvePoolName, getPoolByName, getPoolForSuffix, getPoolSuffixes, listQuotaPools } =
  buildPoolResolver({ config, getProfileNameBySuffix, normalizeProfileSuffix, normalizeProfileProtocol });

function listProfiles() {
  const group = Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : [];
  const responsesGroup = Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup : [];
  return Object.keys(config.profiles).map(name => ({
    name,
    suffix: normalizeProfileSuffix(config.profiles[name].suffix),
    protocol: normalizeProfileProtocol(config.profiles[name].protocol),
    isDefault: !!config.profiles[name].isDefault,
    billingType: config.profiles[name].billingType || "on_demand",
    upstream: config.profiles[name].upstream,
    responsesPath: config.profiles[name].responsesPath || "/v1/responses",
    // 用户管理表格给每个全局用户都渲染一行，保存时未填真实Key的行会落成
    // {key:""} 占位；数条目会让每个方案都显示同一个「全局用户数」。空占位在
    // 请求侧一律被 hasProfileRealKey 拒绝，所以这里只数真正分配了真实Key的。
    userCount: Object.values(config.profiles[name].users || {}).filter(hasRealKey).length,
    allowedModels: config.profiles[name].allowedModels || [],
    modelAliases: getConfigurableModelAliases(config.profiles[name]),
    peakModelAliases: normalizeModelAliases(config.profiles[name].peakModelAliases || {}),
    modelContextWindows: config.profiles[name].modelContextWindows || {},
    modelMultimodal: config.profiles[name].modelMultimodal || {},
    imageBridge: config.profiles[name].imageBridge || { enabled: false, model: "" },
    contextWindow: config.profiles[name].contextWindow || 128000,
    quotaPool: resolvePoolName(name),
    peakHours: normalizePeakHours(config.profiles[name].peakHours),
    peakQuotaRate: normalizeQuotaRate(config.profiles[name].peakQuotaRate),
    offPeakQuotaRate: normalizeQuotaRate(config.profiles[name].offPeakQuotaRate),
    modelQuotaRates: normalizeModelQuotaRates(config.profiles[name].modelQuotaRates),
    cacheReadQuotaRate: normalizeCacheReadQuotaRate(config.profiles[name].cacheReadQuotaRate),
    configured: !!config.profiles[name].upstream,
    inDefaultGroup: group.includes(name),
    groupOrder: group.indexOf(name),
    inResponsesGroup: responsesGroup.includes(name),
    responsesGroupOrder: responsesGroup.indexOf(name),
  }));
}

// ─── Per-Profile Runtime Manager ────────────────────────────────────────────
const runtimes = {}; // suffix → runtime object

// 工具 pattern 兼容(lib/tool-pattern-compat.mjs)依赖注入对象。位置是硬要求: 紧接着的
// initAllRuntimes() 在模块加载期就会构造运行期对象并读兼容开关, 工厂实例是 const(暂时性
// 死区), 若放到文件末尾的其它 DEPS 区会直接抛 ReferenceError。
const TOOL_PATTERN_DEPS = {
  config,
  runtimes,
  normalizeProfileProtocol,
  getRealKeyFromProfile,
};
const toolPatternApi = createToolPatternCompat(TOOL_PATTERN_DEPS);

function createUpstreamAgent(upstreamUrl) {
  return upstreamUrl.protocol === "https:"
    ? new https.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 120000, scheduling: "fifo", rejectUnauthorized: true })
    : new http.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 120000, scheduling: "fifo" });
}

function createProfileRuntime(profileName, profile) {
  const upstreamUrl = new URL(profile.upstream);
  return {
    profileName,
    suffix: normalizeProfileSuffix(profile.suffix),
    protocol: normalizeProfileProtocol(profile.protocol),
    toolPatternCompat: toolPatternApi.normalizeToolPatternCompat(profile.toolPatternCompat),
    toolPatternsActive: toolPatternApi.computeToolPatternsActive(profile, upstreamUrl),
    // 是否要求非空 input(Responses 协议)。默认 false;被上游以「Input items array
    // must not be empty」拒绝一次后由 lib/empty-input-compat.mjs 置位(sticky,重载即清零)。
    requiresInputItems: false,
    // Real `pattern` strings seen on this profile's live traffic, used by the
    // probe so it tests the upstream against evidence, not just a guess.
    toolPatternSamples: new Set(),
    responsesPath: profile.responsesPath || "/v1/responses",
    isDefault: !!profile.isDefault,
    billingType: profile.billingType || "on_demand",
    quotaPool: resolvePoolName(profileName),
    upstream: profile.upstream,
    upstreamUrl,
    users: { ...(profile.users || {}) },
    allowedModels: profile.allowedModels || [],
    modelAliases: getProfileModelAliases(profile),
    peakHours: normalizePeakHours(profile.peakHours),
    peakQuotaRate: normalizeQuotaRate(profile.peakQuotaRate),
    offPeakQuotaRate: normalizeQuotaRate(profile.offPeakQuotaRate),
    modelQuotaRates: normalizeModelQuotaRates(profile.modelQuotaRates),
    cacheReadQuotaRate: normalizeCacheReadQuotaRate(profile.cacheReadQuotaRate),
    peakModelAliases: normalizeModelAliases(profile.peakModelAliases || {}),
    globalUsers: { ...(config.users || {}) },
    breaker: new CircuitBreaker({
      profileName,
      failureThreshold: (config.proxy || {}).circuitBreakerFailures || 5,
      cooldownMs: (config.proxy || {}).circuitBreakerCooldown || 30000,
      recordAudit,
    }),
    agent: createUpstreamAgent(upstreamUrl),
  };
}

function initAllRuntimes() {
  for (const key of Object.keys(runtimes)) delete runtimes[key];
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!profile.upstream) continue;
    const suffix = normalizeProfileSuffix(profile.suffix);
    try {
      runtimes[suffix] = createProfileRuntime(name, profile);
    } catch (err) {
      console.warn(`[RUNTIME] Skipped unconfigured profile "${name}": ${err.message}`);
    }
  }
  console.log(`[RUNTIME] Initialized ${Object.keys(runtimes).length} profile(s): ${Object.values(runtimes).map(r => `"${r.profileName}"(${JSON.stringify(r.suffix)})`).join(", ")}`);
}
// usage 存储口径已对齐(2026-09-18):所有协议的 input_tokens 都不含缓存读,
// contextHealth / sessions 的缓存率公式不再需要按协议修正分母。
// (旧的 responsesProfileSet 注入已随协议修正一起移除。)

function reloadProfileRuntime(profileName) {
  const profile = config.profiles[profileName];
  if (!profile) return;
  const suffix = normalizeProfileSuffix(profile.suffix);
  const old = runtimes[suffix];
  if (old) old.agent.destroy();
  runtimes[suffix] = createProfileRuntime(profileName, profile);
  syncDefaultRuntime();
  console.log(`[RUNTIME] Reloaded "${profileName}" (suffix: ${JSON.stringify(suffix)})`);
}

function reloadAllRuntimes() {
  for (const rt of Object.values(runtimes)) rt.agent.destroy();
  initAllRuntimes();
  syncDefaultRuntime();
  // Pooled-usage prepared statements are cached per member count; drop them so a
  // code/config reload re-prepares with the current column set (e.g. cache_read).
  clearPooledUsageCache();
}

// Global proxy settings (shared across profiles)
const gProxy = { ...(config.proxy || {}) };
gProxy.timeout = gProxy.timeout || 180000;
gProxy.streamTimeout = gProxy.streamTimeout || 600000;
gProxy.maxRetries = gProxy.maxRetries || 3;
gProxy.retryDelay = gProxy.retryDelay || 1000;
gProxy.retryableStatusCodes = gProxy.retryableStatusCodes || [429, 502, 503, 504];
gProxy.maxConcurrentPerUser = gProxy.maxConcurrentPerUser || 5;
gProxy.rateLimitPerMinute = gProxy.rateLimitPerMinute || 60;
gProxy.rateLimitFallbackSeconds = gProxy.rateLimitFallbackSeconds || 120;
// Idle watchdog for SSE streams: abort when no bytes arrive for this long (0 = off).
// Much tighter than streamTimeout, which stays as the socket-level backstop.
gProxy.streamIdleTimeout = gProxy.streamIdleTimeout ?? 120000;
// Sticky-session TTL in seconds: same conversation keeps hitting the same group
// profile so the upstream prompt cache stays warm (0 = off).
gProxy.stickySessionTtlSeconds = gProxy.stickySessionTtlSeconds ?? 300;

// Backward-compat: rt → default profile runtime (used by non-request-path code)
let rt;

function getDefaultRuntime() {
  return runtimes[getDefaultProfileSuffix()] || Object.values(runtimes)[0];
}

function syncDefaultRuntime() {
  rt = getDefaultRuntime();
}

// Head of the responses failover group — the default entry for /v1/responses.
// Returns null when no responses profile is configured.
function getResponsesDefaultRuntime() {
  const group = Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup : [];
  for (const name of group) {
    const profile = config.profiles[name];
    if (!profile) continue;
    const runtime = runtimes[normalizeProfileSuffix(profile.suffix)];
    if (runtime && runtime.protocol === "responses") return runtime;
  }
  return null;
}

// ─── Profile Route Resolver ─────────────────────────────────────────────────
// Initialize all runtimes
initAllRuntimes();
syncDefaultRuntime();

function resolveProfile(url) {
  const pathname = new URL(url, "http://localhost").pathname;
  const defaultRuntime = getDefaultRuntime();
  if (pathname === "/v1" || pathname.startsWith("/v1/")) {
    return { suffix: defaultRuntime?.suffix || "", runtime: defaultRuntime, strippedUrl: url, isDefaultEntry: true };
  }

  // Try to match /<suffix>/... pattern.
  const seg = pathname.match(/^\/([a-zA-Z0-9_-]{2,20})(\/.*)?$/);
  if (seg) {
    const candidate = seg[1].toLowerCase();
    if (!RESERVED_SUFFIXES.has(candidate) && runtimes[candidate]) {
      const strippedPath = seg[2] || "/";
      const query = url.includes("?") ? url.slice(url.indexOf("?")) : "";
      return { suffix: candidate, runtime: runtimes[candidate], strippedUrl: strippedPath + query, isDefaultEntry: false };
    }
    if (!RESERVED_SUFFIXES.has(candidate)) {
      return { error: `Unknown profile suffix "${candidate}"` };
    }
  }

  return { suffix: defaultRuntime?.suffix || "", runtime: defaultRuntime, strippedUrl: url, isDefaultEntry: false };
}

// ─── Concurrency & Rate Limit ────────────────────────────────────────────────
const userConcurrent = {};
const userRateBucket = {};

function checkConcurrency(key) {
  userConcurrent[key] = userConcurrent[key] || 0;
  return userConcurrent[key] < gProxy.maxConcurrentPerUser;
}

function tryAcquireConcurrency(key) {
  userConcurrent[key] = (userConcurrent[key] || 0) + 1;
  if (userConcurrent[key] > gProxy.maxConcurrentPerUser) {
    userConcurrent[key]--;
    return false;
  }
  return true;
}

function releaseConcurrency(key) {
  userConcurrent[key] = Math.max(0, (userConcurrent[key] || 1) - 1);
}

function checkAndRecordRate(key) {
  const now = Date.now();
  const windowMs = 60000;
  userRateBucket[key] = userRateBucket[key] || [];
  userRateBucket[key] = userRateBucket[key].filter(t => now - t < windowMs);
  if (userRateBucket[key].length >= gProxy.rateLimitPerMinute) return false;
  userRateBucket[key].push(now);
  return true;
}

// ─── Per-profile in-flight counter(方案中心「使用状态」的数据源)────────────────
// key 是 profile suffix —— users.profile / runtimes / stats 表全按 suffix 口径,
// 方案改名也不受影响。计数在 proxy-core 的候选尝试作用域里 acquire/release。
// Node 单线程,普通对象即可;重启自然清零,由 users.last_active 的 5 分钟窗口兜底。
const profileInflight = {};
function acquireProfileInflight(sfx) { profileInflight[sfx] = (profileInflight[sfx] || 0) + 1; }
function releaseProfileInflight(sfx) {
  // 归零即 delete:已删除方案的残留键不会在计数快照里堆积
  if ((profileInflight[sfx] || 0) <= 1) delete profileInflight[sfx];
  else profileInflight[sfx]--;
}
function getProfileInflight() { return { ...profileInflight }; }   // 快照,防读期间被改

// ─── Global IP Rate Limiting ─────────────────────────────────────────────────
const ipRateBucket = {};
const IP_RATE_LIMIT = 120; // requests per minute per IP
const IP_RATE_WINDOW = 60000;

function checkIpRateLimit(ip) {
  const now = Date.now();
  ipRateBucket[ip] = ipRateBucket[ip] || [];
  ipRateBucket[ip] = ipRateBucket[ip].filter(t => now - t < IP_RATE_WINDOW);
  if (ipRateBucket[ip].length >= IP_RATE_LIMIT) return false;
  ipRateBucket[ip].push(now);
  return true;
}

// ─── Auth & Sanitize ────────────────────────────────────────────────────────
const AUTH_COOKIE = "tm_token";
const CSRF_COOKIE = "tm_csrf";
function hashPassword(pw) {
  return crypto.scryptSync(pw, "token-monitor-server-key", 32, { N: 16384, r: 8, p: 1 }).toString("hex");
}
const passwordVersion = config._pwVersion || 0;
const AUTH_TOKEN = dashboardPassword ? hashPassword(dashboardPassword) + "." + passwordVersion : "";
const CSRF_TOKEN = crypto.randomBytes(32).toString("hex");

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function checkAuth(req) {
  if (!dashboardPassword) return true;
  const cookies = (req.headers.cookie || "").split(";").map(s => s.trim());
  return cookies.some(c => timingSafeEqual(c, `${AUTH_COOKIE}=${AUTH_TOKEN}`));
}

function checkCsrf(req, body) {
  if (!dashboardPassword) return true;
  // Submitted token: x-csrf-token header (fetch requests) or _csrf form field.
  const headerVal = req.headers["x-csrf-token"] || "";
  let fieldVal = "";
  if (body && typeof body === "string" && body.includes("_csrf=")) {
    const match = body.match(/(?:^|&)_csrf=([^&]+)/);
    if (match) {
      try { fieldVal = decodeURIComponent(match[1]); } catch { fieldVal = match[1]; }
    }
  }
  const submitted = headerVal || fieldVal;
  if (!submitted) {
    console.log(`[安全] CSRF 校验失败 ${req.method} ${req.url}: 未携带令牌`);
    return false;
  }
  // Accept the server-known token (rendered into the auth-gated settings page,
  // so saving works even when the tm_csrf cookie is lost or page JS is dead),
  // or the legacy double-submit match against the request's tm_csrf cookie.
  const cookies = (req.headers.cookie || "").split(";").map(s => s.trim());
  const csrfCookie = cookies.find(c => c.startsWith(`${CSRF_COOKIE}=`));
  const ok = timingSafeEqual(submitted, CSRF_TOKEN)
    || (!!csrfCookie && timingSafeEqual(csrfCookie.slice(CSRF_COOKIE.length + 1), submitted));
  if (!ok) {
    console.log(`[安全] CSRF 校验失败 ${req.method} ${req.url}: tm_csrf cookie=${csrfCookie ? "有" : "无"}，提交令牌与服务器令牌及 cookie 均不匹配`);
  }
  return ok;
}

function isSecureRequest(req) {
  return !!(req.socket.encrypted || req.headers["x-forwarded-proto"] === "https");
}

// ─── Login Brute-Force Protection ───────────────────────────────────────────
const loginAttempts = {};
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

function getClientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

function checkLoginRate(ip) {
  const now = Date.now();
  const entry = loginAttempts[ip];
  if (!entry) return { allowed: true, remaining: LOGIN_MAX_ATTEMPTS };
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return { allowed: false, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  if (now - entry.lastAttempt > LOGIN_LOCKOUT_MS) {
    delete loginAttempts[ip];
    return { allowed: true, remaining: LOGIN_MAX_ATTEMPTS };
  }
  return { allowed: true, remaining: Math.max(0, LOGIN_MAX_ATTEMPTS - entry.count) };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  if (!loginAttempts[ip]) loginAttempts[ip] = { count: 0, lastAttempt: 0, lockedUntil: 0 };
  const entry = loginAttempts[ip];
  entry.count++;
  entry.lastAttempt = now;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOGIN_LOCKOUT_MS;
    console.log(`[安全] IP ${ip} 登录失败 ${entry.count} 次，锁定 15 分钟`);
  }
}

function recordLoginSuccess(ip) {
  delete loginAttempts[ip];
}

// ─── Input Sanitization ──────────────────────────────────────────────────────
// DANGEROUS_KEYS / sanitizeJson 已迁至 ./lib/sanitize.mjs。

function readBody(req, maxSize = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxSize) { req.destroy(); reject(new Error("Request body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sanitizeStore(raw) {
  const s = JSON.parse(JSON.stringify(raw));
  if (s.users) {
    const safe = {};
    for (const [k, v] of Object.entries(s.users)) {
      safe[k.slice(0, 8) + "****"] = v;
    }
    s.users = safe;
  }
  if (s.daily) {
    const safe = {};
    for (const [day, ud] of Object.entries(s.daily)) {
      safe[day] = {};
      for (const [k, v] of Object.entries(ud)) {
        safe[day][k.slice(0, 8) + "****"] = v;
      }
    }
    s.daily = safe;
  }
  // Mask user keys in dailyModels / dailyClients / dailyHourly the same way as s.daily so the
  // dashboard's user filter (keyed on masked keys) applies to those dimensions too.
  // 新维度必须一并加进来:漏掉一格就等于把明文 user_key 直接送进浏览器。
  const maskByUser = (obj) => {
    if (!obj) return obj;
    const safe = {};
    for (const [day, ud] of Object.entries(obj)) {
      safe[day] = {};
      for (const [k, v] of Object.entries(ud)) {
        safe[day][k.slice(0, 8) + "****"] = v;
      }
    }
    return safe;
  };
  s.dailyModels = maskByUser(s.dailyModels);
  s.dailyClients = maskByUser(s.dailyClients);
  s.dailyHourly = maskByUser(s.dailyHourly);
  if (Array.isArray(s.errors)) {
    s.errors = s.errors.map(e => { const { userKey, ...rest } = e; return rest; });
  }
  return s;
}

// ─── SQLite Persistence (multi-table, incremental) ──────────────────────────
// 建表 / 列迁移 / 旧版 data.json 迁移 / 日常剪枝已抽至 lib/persistence.mjs。
// db 与 stmts 仍是本模块的共享句柄(本文件里有上百处直接引用),由 initDb() 回填后
// 继续在此直接读写;persistenceApi 内部通过 getter 读同一个绑定。
let db = null;
let stmts = {};   // prepared statements, populated by initDb()

// lib/persistence.mjs 依赖注入对象。dbPath/dataPath 在 Config 段已就绪;db/stmts 必须
// getter/setter 成对: getter 让 lib 各函数读到同一个绑定(解构会快照住创建时的 null),
// setter 让 initDb() 打开库的瞬间就回填 —— 迁移期的 backupDatabaseSync() 读的正是这个
// 模块级 db, 晚一步回填它会静默 return null, 备份与测试都不报错。
const PERSISTENCE_DEPS = {
  config, dbPath, dataPath, backupDatabaseSync, normalizeProfileSuffix,
  resolvePoolName, getDefaultProfileSuffix,
  get db() { return db; },
  set db(v) { db = v; },   // initDb 打开库后立刻回填, 迁移期的 backupDatabaseSync() 才有句柄
  get stmts() { return stmts; },
  set stmts(v) { stmts = v; },
};
const persistenceApi = createPersistence(PERSISTENCE_DEPS);

// ── Meta helpers (kv_meta: _lastQuotaEval) ──
function getMeta(key, fallback = null) {
  const row = db.prepare("SELECT value FROM kv_meta WHERE key=?").get(key);
  return row ? row.value : fallback;
}
function setMeta(key, value) { stmts.upsertMeta.run({ k: key, v: String(value) }); }

// ── Rate-limit (429 plan-exhaustion) state for default-group failover ──
// Independent from CircuitBreaker: a 429 plan limit has a *known* resume time
// (parsed from the upstream error), whereas the breaker recovers by probing.
// Entries lazily self-clear once resumeAt has passed, so no timer is needed.
const rateLimitState = {};   // { [profileName]: { resumeAt: <ms>, source: <string>, updatedAt: <ms> } }
const RATE_LIMIT_META_KEY = "rateLimitState";

class RateLimitedError extends Error {
  constructor(resumeAt, source, message) {
    super(message || `rate limited until ${notifierApi.beijingTimeString(new Date(resumeAt))}`);
    this.name = "RateLimitedError";
    this.isRateLimited = true;
    this.resumeAt = resumeAt;
    this.source = source || "unknown";
  }
}

function persistRateLimitState() {
  try { setMeta(RATE_LIMIT_META_KEY, JSON.stringify(rateLimitState)); }
  catch (err) { console.warn("[RateLimit] persist failed:", err.message); }
}

function markRateLimited(profileName, resumeAtMs, source) {
  if (!profileName || !Number.isFinite(resumeAtMs)) return;
  const prev = rateLimitState[profileName];
  rateLimitState[profileName] = { resumeAt: resumeAtMs, source: source || "unknown", updatedAt: Date.now() };
  persistRateLimitState();
  console.log(`[RateLimit] "${profileName}" marked limited until ${new Date(resumeAtMs).toISOString()} (source: ${source || "unknown"})`);
  // Audit only the unlimited→limited transition: while the profile stays
  // limited, every subsequent 429 just refreshes the same state.
  if (!prev || Date.now() >= prev.resumeAt) {
    recordAudit("system", "ratelimit.mark", profileName,
      `方案 "${profileName}" 被上游限流（来源: ${source || "unknown"}），暂停至 ${notifierApi.beijingTimeString(new Date(resumeAtMs))}，后续请求自动切换到备选方案`);
  }
}

function clearRateLimited(profileName, reason) {
  if (profileName && rateLimitState[profileName]) {
    delete rateLimitState[profileName];
    persistRateLimitState();
    if (reason === "expire") {
      recordAudit("system", "ratelimit.expire", profileName, `方案 "${profileName}" 限流到期，自动恢复参与 failover`);
    }
  }
}

// Lazily self-heals: once resumeAt has passed, clear and report "not limited".
function isRateLimited(profileName) {
  const st = rateLimitState[profileName];
  if (!st) return false;
  if (Date.now() >= st.resumeAt) { clearRateLimited(profileName, "expire"); return false; }
  return true;
}

function getRateLimitInfo(profileName) {
  const st = rateLimitState[profileName];
  if (!st) return null;
  if (Date.now() >= st.resumeAt) { clearRateLimited(profileName, "expire"); return null; }
  return { resumeAt: st.resumeAt, source: st.source };
}

// Parse a reset time out of an upstream 429 body. GLM shape:
//   "...您的限额将在 2026-08-06 10:41:33 重置。..."
// The timestamp is Beijing time (+08:00); the server may run in another zone, so we
// pin the offset instead of treating it as local time.
const RATE_LIMIT_RESET_RE = /限额将在\s*(\d{4}-\d{2}-\d{2})[ T]+(\d{2}:\d{2}(?::\d{2})?)\s*重置/;
function parseRateLimitReset(text) {
  if (!text) return null;
  const m = String(text).match(RATE_LIMIT_RESET_RE);
  if (!m) return null;
  let hhmmss = m[2];
  if (/^\d{2}:\d{2}$/.test(hhmmss)) hhmmss += ":00";   // HH:mm → HH:mm:ss
  const ms = Date.parse(`${m[1]}T${hhmmss}+08:00`);
  return Number.isFinite(ms) ? ms : null;
}

// English-store 429 bodies put the same thing in prose:
//   "You have exceeded the 5-hour usage quota. It will reset at 2026-09-15 19:05:46 +0800 CST."
// 与中文那条分开:**不**并进 parseRateLimitReset —— 那个函数的调用点在频率判据之前,
// 通用的 "reset at" 放进去会把「每分钟限速、正文顺带写着重置时刻」的报文误判成套餐耗尽。
// 这条只在 looksLikePlanLimit 判定通过之后用(见 classifyRateLimit)。
const RATE_LIMIT_RESET_EN_RE = /reset(?:s|ting)?\s+at\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\s*(Z|[+-]\d{2}:?\d{2}))?/i;
function parseRateLimitResetEn(text) {
  if (!text) return null;
  const m = String(text).match(RATE_LIMIT_RESET_EN_RE);
  if (!m) return null;
  let hhmmss = m[2];
  if (/^\d{2}:\d{2}$/.test(hhmmss)) hhmmss += ":00";   // HH:mm → HH:mm:ss
  // 显式时区按原样用;缺时区才当北京时间(与中文那条同约定)。"+0800 CST" 里的 CST 由正则忽略。
  const off = m[3]
    ? (m[3].toUpperCase() === "Z" ? "+00:00" : m[3].replace(/^([+-]\d{2})(\d{2})$/, "$1:$2"))
    : "+08:00";
  const ms = Date.parse(`${m[1]}T${hhmmss}${off}`);
  return Number.isFinite(ms) ? ms : null;
}

function fallbackResumeAtMs() {
  const secs = Number(gProxy.rateLimitFallbackSeconds) || 120;
  return Date.now() + secs * 1000;
}

// Honor an upstream Retry-After header (delta-seconds or HTTP-date) when a 429
// was classified as a plan limit — more precise than the flat fallback window.
function parseRetryAfterMs(headerValue) {
  if (typeof headerValue !== "string") return null;
  const v = headerValue.trim();
  if (/^\d+$/.test(v)) return parseInt(v, 10) * 1000;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms - Date.now() : null;
}
function clampRetryAfterMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(600_000, Math.max(15_000, ms));
}

// Classify an upstream response as a plan limit we should fail over from.
// Returns { resumeAt, source } when it is, or null for a plain burst 429
// (which should follow the normal same-upstream retry path).
function classifyRateLimit(statusCode, text, headers) {
  if (statusCode !== 429) return null;
  const body = String(text || "");
  const parsed = parseRateLimitReset(body);
  if (parsed) return { resumeAt: parsed, source: "reset-time" };
  // Frequency throttling (e.g. GLM 1302 速率限制, GLM 1305 平台过载, Aliyun
  // Throttling.RateQuota) is per-request/user pacing or transient load, not plan
  // exhaustion — the account still has quota. Never fail over for these; return null so
  // the normal same-upstream retry path runs and the error stays with the requesting user.
  const isFrequencyLimit = /"code"\s*:\s*13(02|05)|速率限制|请求频率|too many requests|requests per|Requests rate limit exceeded|Throttling\.RateQuota/i.test(body);
  if (isFrequencyLimit) return null;
  // Plan exhaustion: GLM 1310 用量上限 / 1113 欠费 / 1311 套餐未开放模型权限,
  // Aliyun Throttling.AllocationQuota (free allocated quota exceeded), DeepSeek 429 quota,
  // 火山/英文站 AccountQuotaExceeded("You have exceeded the 5-hour usage quota." —— 错误码
  // 无空格、语序相反,所以 "quota exceeded" 与 "usage limit" 都盖不住)。频率类在上一步已排除,
  // 所以这里出现 "usage quota" 只可能是套餐级。
  const looksLikePlanLimit = /"code"\s*:\s*1(310|311|113)|使用上限|usage limit|usage quota|plan limit|额度已耗尽|quota exceeded|AccountQuotaExceeded|AllocationQuota|free allocated quota/i.test(body);
  if (!looksLikePlanLimit) return null;
  // 正文里的精确恢复时刻优先于 Retry-After(5 小时级的窗口,响应头那种分钟级估值差太远)。
  const resetAt = parseRateLimitResetEn(body);
  if (resetAt) return { resumeAt: resetAt, source: "reset-time" };
  const retryAfter = clampRetryAfterMs(parseRetryAfterMs(headers?.["retry-after"]));
  return retryAfter
    ? { resumeAt: Date.now() + retryAfter, source: "retry-after" }
    : { resumeAt: fallbackResumeAtMs(), source: "fallback" };
}

// ─── Sticky sessions (cache affinity) ────────────────────────────────────────
// Both supported protocols are stateless replays: every turn re-sends the whole
// conversation. If failover round-robins a conversation across group members,
// each switch re-pays the entire prompt at full price and cold cache. Binding a
// conversation to one profile keeps the upstream prompt cache warm (idea after
// sub2api's sticky sessions; their digest-chain trick is simplified to a
// first-turn digest). Availability always wins: candidates are filtered before
// the reorder runs, so an unavailable bound profile is simply not in the list.
const STICKY_BINDINGS_CAP = 1000;
const stickyBindings = new Map();   // "proto|userKey|signal" → { profile, expiresAt }

function stickyTtlMs() {
  const secs = Number(gProxy.stickySessionTtlSeconds);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0;
}

// Resolve a stable per-conversation signal, in priority order:
// 1. explicit session headers (Codex sends `session-id` on /v1/responses),
// 2. the Responses API `prompt_cache_key` body field,
// 3. digest of the conversation's first turn — replay protocols append at the
//    tail, so item[0] (plus the constant system/instructions) is identical on
//    every turn of the same conversation. Collisions between conversations that
//    happen to share the first turn only cost cache locality, never correctness.
//
// 连字符不能省。Codex 发的是 `session-id`(连字符),而这里原先只查 `session_id`
// (下划线)—— Node 把请求头名归一成小写但**保留连字符**,所以那一路对 Codex 从来
// 没命中过,一直是靠第 2 优先级的 prompt_cache_key 兜住的(实测 Codex 0.145 在
// /v1/responses 上同时发 session-id / thread-id / prompt_cache_key 三个同值 uuid,
// 只有 pck 那条被读到)。补上别名后走显式头,不再依赖一个可选字段是否被客户端填。
//
// 副作用(一次性):Codex 的会话键由 `pck:<uuid>` 变成 `hdr:<uuid>`,同一段对话在
// 切换前后各留一行。usage_session 与 tool_events 都只保 90 天,窗口内会重影,之后自愈。
function extractSessionSignal(protocol, reqHeaders, parsed) {
  const hdr = reqHeaders["session-id"] || reqHeaders["session_id"] || reqHeaders["x-session-id"] || reqHeaders["x-claude-code-session-id"];
  if (typeof hdr === "string" && hdr.trim()) return "hdr:" + hdr.trim().slice(0, 128);
  const pck = parsed?.prompt_cache_key;
  if (typeof pck === "string" && pck.trim()) return "pck:" + pck.trim().slice(0, 128);
  try {
    let prefix;
    if (protocol === "responses") {
      const items = Array.isArray(parsed?.input) ? parsed.input : [];
      if (items.length === 0) return null;
      prefix = { instructions: parsed?.instructions ?? null, first: items[0] };
    } else {
      const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
      if (msgs.length === 0) return null;
      prefix = { system: parsed?.system ?? null, first: msgs[0] };
    }
    return "dig:" + shortDigest(prefix);
  } catch {
    return null;
  }
}

function getStickyProfile(protocol, userKey, signal) {
  if (!stickyTtlMs() || !signal) return null;
  const key = `${protocol}|${userKey}|${signal}`;
  const binding = stickyBindings.get(key);
  if (!binding) return null;
  if (Date.now() >= binding.expiresAt) {
    stickyBindings.delete(key);
    return null;
  }
  return binding.profile;
}

function setStickyProfile(protocol, userKey, signal, profileName) {
  if (!stickyTtlMs() || !signal || !profileName) return;
  const key = `${protocol}|${userKey}|${signal}`;
  stickyBindings.delete(key);   // re-insert at the tail so recency drives eviction
  stickyBindings.set(key, { profile: profileName, expiresAt: Date.now() + stickyTtlMs() });
  if (stickyBindings.size > STICKY_BINDINGS_CAP) {
    stickyBindings.delete(stickyBindings.keys().next().value);
  }
}

function deleteStickyProfile(protocol, userKey, signal) {
  if (!signal) return;
  stickyBindings.delete(`${protocol}|${userKey}|${signal}`);
}

// ─── Group-level failover audit (deduped) ────────────────────────────────────
// A single Map entry per group head records which member is currently taking
// over its traffic, so a sustained outage logs one "switch" (and one
// "recover") instead of one line per request.
// key = `${protocol}|${组头名}`。协议前缀是必须的：两个协议可以各有一个同名组头，
// 不带前缀会让它们互相顶掉对方的记录。
const failoverActive = new Map(); // `${protocol}|${head}` → { member, at }

// 组定义变了（改名/改序/删方案）以后，任何「某组头正在被某成员代答」的记录都失去了参照
// —— 组头可能已经不是组头，也可能已经不存在。留着它会让下一次切换漏写一条 failover.switch
// （new head 的 entry 被旧 key 挡住），并且永远等到进程结束才消失。
function resetFailoverTracking() {
  if (failoverActive.size > 0) failoverActive.clear();
}

function getRuntimeByProfileName(name) {
  for (const r of Object.values(runtimes)) {
    if (r.profileName === name) return r;
  }
  return null;
}

// ─── 方案组调度：生效组解析 ───────────────────────────────────────────────────
// 本次请求的生效组。整个请求**只解析一次**：候选生成、粘性绑定判定、failover 审计三处必须看到
// 同一个答案 —— 若各自读一次，请求恰好跨过时间边界时三处会算出不同的组头，后果是粘性绑定被
// 每轮清掉（跨轮 prompt 缓存亲和不报错地失效）并且审计会谎称组头不可用。
// 照 effectiveModelAliases() 的既有范式：按请求求值，所以跨过时间边界不需要 reload config。
// ignoreOverride=true 用来问「**不考虑**手动指定时，规则会选哪个组」—— 手动指定路由需要它来
// 判断这次指定是不是一个空操作。
function resolveRequestGroup(protocol, date = new Date(), ignoreOverride = false) {
  const baseGroup = protocol === "responses"
    ? (Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup : [])
    : (Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : []);
  const fallback = { members: baseGroup.slice(), source: "base", groupName: BASE_GROUP_TOKEN, ruleIndex: -1, rule: null };
  try {
    return resolveEffectiveGroup({
      baseGroup,
      // 分桶存储：只把**本协议**的桶交给求值器（桶内组对象仍带 protocol 字段）。
      groups: ((config.scheduleGroups || {})[protocol]) || {},
      rules: ((config.scheduleRules || {})[protocol]) || [],
      override: ignoreOverride ? null : ((config.scheduleOverride || {})[protocol] || null),
    }, protocol, date);
  } catch (err) {
    // 调度配置损坏绝不能让请求 500 —— 退回基础组等价于「这个功能没开」。
    console.warn(`[SCHEDULE] ${protocol} 生效组解析失败，已回退基础组: ${err.message}`);
    return fallback;
  }
}

// 调度切换审计 + 僵尸条目清理。用「状态对比」而不是「定时器」：lastServedGroup 记住上一次真正
// 服务过请求的生效组，组名一变就写一条 —— 天然去重，不需要 cron。首次观测只记基线不写日志
// （否则每次重启都多一条假切换）。
const lastServedGroup = new Map(); // protocol → { key, head }

function noteGroupSwitch(protocol, group, userName) {
  try {
    const key = group.groupName || BASE_GROUP_TOKEN;
    const head = group.members[0] || null;
    const prev = lastServedGroup.get(protocol);
    if (prev && prev.key === key) return;
    lastServedGroup.set(protocol, { key, head });

    // 生效组换了头，旧组头的代答记录就永远等不到它的「恢复接管」了 —— 必须就地作废，
    // 否则 failoverActive 会留下一条指向已卸任组头的僵尸条目，并且下次回到那个组时
    // 会因为 prev.member 相同而漏掉一条本该写的 switch 日志。
    for (const k of [...failoverActive.keys()]) {
      if (k.startsWith(`${protocol}|`) && k !== `${protocol}|${head || ""}`) failoverActive.delete(k);
    }
    if (!prev) return;  // 首次观测：只记基线

    const label = group.source === "manual" ? "手动指定" : "方案组调度";
    const rule = group.rule ? `（规则: ${formatScheduleRuleSummary(group.rule)}）` : "";
    recordAudit("system", "schedule.group_switch", `${prev.key} → ${key}`,
      `${label}：生效方案组由 "${prev.key}" 切换为 "${key}"，组内优先级 ${group.members.join(" → ")}${rule}${userName ? `（触发用户: ${userName}）` : ""}`);
  } catch (err) {
    console.warn(`[SCHEDULE] 组切换审计失败: ${err.message}`);
  }
}

// headName 缺省时退回「基础组头」＝升级前的行为，所以非请求调用点不必传。
function noteFailoverServed(protocol, servedBy, userName, headName) {
  const head = headName !== undefined
    ? headName
    : (protocol === "responses"
      ? (Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup[0] : null)
      : (Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup[0] : null));
  const key = head ? `${protocol}|${head}` : null;
  if (!key || servedBy === head) {
    if (key && servedBy === head && failoverActive.has(key)) {
      const prev = failoverActive.get(key);
      failoverActive.delete(key);
      recordAudit("system", "failover.recover", head,
        `组头 "${head}" 恢复接管（此前由 "${prev.member}" 代答），流量切回`);
    }
    return;
  }
  const prev = failoverActive.get(key);
  if (!prev || prev.member !== servedBy) {
    const headRt = getRuntimeByProfileName(head);
    const why = isRateLimited(head) ? "被限流" : (headRt && headRt.breaker.status().state === "OPEN" ? "熔断" : "");
    failoverActive.set(key, { member: servedBy, at: Date.now() });
    recordAudit("system", "failover.switch", `${head} → ${servedBy}`,
      `组头 "${head}"${why ? `因${why}不可用` : "不可用"}，请求自动切换到备选方案 "${servedBy}"${userName ? `（触发用户: ${userName}）` : ""}`);
  }
}


// Ordered list of currently-usable default-group profiles for a given user key.
// Skips: rate-limited, breaker OPEN, user not authorized, or profiles with no runtime.
// `group` 是本次请求的**生效组**成员（调度规则可能给出另一套顺序/集合）。缺省即基础组，
// 所以未来任何非请求调用点不传这个参数时不可能被时间规则悄悄影响。
function getAvailableDefaultProfiles(apiKey, group) {
  const members = Array.isArray(group) ? group : (Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : []);
  const out = [];
  for (const name of members) {
    const profile = config.profiles[name];
    if (!profile) continue;
    const suffix = normalizeProfileSuffix(profile.suffix);
    const runtime = runtimes[suffix];
    if (!runtime) continue;
    if (runtime.protocol !== "anthropic") continue;
    if (isRateLimited(name)) continue;
    // isAvailable() (not status().state) so a profile whose cooldown has elapsed
    // is offered again — allowRequest() then performs the half-open transition.
    if (!runtime.breaker.isAvailable()) continue;
    if (!canUseProfile(apiKey, runtime)) continue;
    // 超级用户借 key 转发：组内一个真实Key都没有的方案不进候选，避免借不到 key
    // 时虚拟Key泄漏到上游（普通用户已被 canUseProfile 保证有 key）。
    if (isSuperUser(apiKey, runtime) && !hasProfileRealKey(apiKey, runtime) && !borrowProfileRealKey(runtime)) continue;
    out.push({ name, suffix, runtime });
  }
  return out;
}

// Ordered failover candidates for the /v1/responses entry. Mirrors
// getAvailableDefaultProfiles but reads the responses group and only ever
// yields responses-protocol profiles.
function getAvailableResponsesProfiles(apiKey, group) {
  const members = Array.isArray(group) ? group : (Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup : []);
  const out = [];
  for (const name of members) {
    const profile = config.profiles[name];
    if (!profile) continue;
    const suffix = normalizeProfileSuffix(profile.suffix);
    const runtime = runtimes[suffix];
    if (!runtime || runtime.protocol !== "responses") continue;
    if (isRateLimited(name)) continue;
    if (!runtime.breaker.isAvailable()) continue;
    if (!canUseProfile(apiKey, runtime)) continue;
    // 同上：超级用户借用路径下，无任何真实Key的方案不进候选。
    if (isSuperUser(apiKey, runtime) && !hasProfileRealKey(apiKey, runtime) && !borrowProfileRealKey(runtime)) continue;
    out.push({ name, suffix, runtime });
  }
  return out;
}

// Load persisted rate-limit state once the DB is ready.
function loadRateLimitState() {
  try {
    const raw = getMeta(RATE_LIMIT_META_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const now = Date.now();
      for (const [name, st] of Object.entries(parsed)) {
        if (st && Number.isFinite(st.resumeAt) && st.resumeAt > now) {
          rateLimitState[name] = { resumeAt: st.resumeAt, source: st.source || "unknown", updatedAt: st.updatedAt || now };
        }
      }
    }
  } catch (err) { console.warn("[RateLimit] load failed:", err.message); }
}

// ── Profile snapshot: assemble nested object for sanitizeStore (single profile) ──
function loadProfileSnapshot(suffix) {
  const users = {};
  for (const r of db.prepare("SELECT user_key,name,total_input,total_output,total_requests,cache_creation,cache_read,last_active FROM users WHERE profile=?").all(suffix)) {
    users[r.user_key] = { name: r.name, totalInputTokens: r.total_input, totalOutputTokens: r.total_output, totalRequests: r.total_requests, cacheCreationTokens: r.cache_creation, cacheReadTokens: r.cache_read, lastActive: r.last_active };
  }
  const daily = {};
  for (const r of db.prepare("SELECT date,user_key,input_tokens,output_tokens,requests,cache_creation,cache_read FROM usage_daily WHERE profile=?").all(suffix)) {
    if (!daily[r.date]) daily[r.date] = {};
    daily[r.date][r.user_key] = { inputTokens: r.input_tokens, outputTokens: r.output_tokens, requests: r.requests, cacheCreationTokens: r.cache_creation, cacheReadTokens: r.cache_read };
  }
  const models = {};
  for (const r of db.prepare("SELECT model,tokens,requests FROM usage_model WHERE profile=?").all(suffix)) {
    models[r.model] = { tokens: r.tokens, requests: r.requests };
  }
  // 日期下界与聚合视图(getAggregatedStore)同源同值 —— 两条路径喂的是同一张前端图,
  // 下界不一致会让「全部方案」与「单个方案」两个视图在同一天显示出不同的历史范围。
  const hourly = {};
  for (const r of db.prepare("SELECT date,hour,requests,input_tokens,output_tokens,cache_creation,cache_read FROM usage_hourly WHERE profile=? AND date>=?").all(suffix, hourlyChartFloor())) {
    if (!hourly[r.date]) hourly[r.date] = {};
    hourly[r.date][r.hour] = { requests: r.requests, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheCreationTokens: r.cache_creation, cacheReadTokens: r.cache_read };
  }
  const dailyModels = {};
  for (const r of db.prepare("SELECT date,user_key,model,input_tokens,output_tokens,requests FROM usage_daily_model WHERE profile=?").all(suffix)) {
    if (!dailyModels[r.date]) dailyModels[r.date] = {};
    if (!dailyModels[r.date][r.user_key]) dailyModels[r.date][r.user_key] = {};
    dailyModels[r.date][r.user_key][r.model] = { inputTokens: r.input_tokens, outputTokens: r.output_tokens, requests: r.requests };
  }
  const dailyHourly = {};
  for (const r of db.prepare("SELECT date,user_key,hour,requests,input_tokens,output_tokens,cache_creation,cache_read FROM usage_daily_hourly WHERE profile=?").all(suffix)) {
    if (!dailyHourly[r.date]) dailyHourly[r.date] = {};
    if (!dailyHourly[r.date][r.user_key]) dailyHourly[r.date][r.user_key] = {};
    dailyHourly[r.date][r.user_key][r.hour] = { requests: r.requests, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheCreationTokens: r.cache_creation, cacheReadTokens: r.cache_read };
  }
  // 客户端维度与 dailyModels 同形。单方案视图也必须带上 —— 否则切到具体方案时这一轴就空了,
  // 而「这个方案是谁在用哪个客户端」恰恰是单方案视图下最想问的。
  const dailyClients = {};
  for (const r of db.prepare("SELECT date,user_key,client,input_tokens,output_tokens,requests FROM usage_daily_client WHERE profile=?").all(suffix)) {
    if (!dailyClients[r.date]) dailyClients[r.date] = {};
    if (!dailyClients[r.date][r.user_key]) dailyClients[r.date][r.user_key] = {};
    dailyClients[r.date][r.user_key][r.client] = { inputTokens: r.input_tokens, outputTokens: r.output_tokens, requests: r.requests };
  }
  const errors = db.prepare("SELECT time,user_name AS user,user_key AS userKey,status_code AS statusCode,error,path,model FROM errors WHERE profile=? ORDER BY id DESC LIMIT 200").all(suffix);
  return { users, daily, dailyModels, dailyClients, dailyHourly, models, hourly, errors };
}

({ db, stmts } = persistenceApi.initDb());
initProductionDb(db);   // 产出质量表(tool_events / production_alerts),先于 tracker 建语句
initCodeReviewDb(db);   // 代码评审表(runs / comments / repo_state);功能默认关闭,建表无害
initMemberNotifyDb(db); // 成员自助的通知渠道(成员用量页里配)
const memberNotifyApi = createMemberNotify({ get db() { return db; } });
function productionEnabled() { return (config.productionTracking || {}).enabled !== false; }
const productionTracker = createProductionTracker({ db, getConfig: () => config.productionTracking || {}, log: console.log });

// 代码评审(可选功能):OCR 适配层 + 编排层。默认关闭;开启后由管理员在设置页配仓库。
// 依赖注入照既有规矩:db/stmts 用 getter(它们在 initDb 阶段才就位),其余按值传。
const reviewOcrApi = createCodeReviewOcr({
  config,
  appRoot: __dirname,
  workspaceDir: () => (config.codeReview || {}).workspaceDir || path.join(__dirname, "code-review-workspaces"),
  ocrHomeDir: () => path.join((config.codeReview || {}).workspaceDir || path.join(__dirname, "code-review-workspaces"), "ocr-home"),
  repoDir: (id) => path.join((config.codeReview || {}).workspaceDir || path.join(__dirname, "code-review-workspaces"), "repos", String(id)),
  log: console.log,
});
const codeReviewApi = createCodeReview({
  config, saveConfig, ocr: reviewOcrApi, appRoot: __dirname, port,
  notifyReview: (ev) => pushCodeReviewNotice(ev),
  log: console.log,
  get db() { return db; },
});
// 评审端点由**所选方案**推导,不允许管理员手填:系统本身是网关,评审必须经自己
// 才会计入用量与配额;协议不同入口不同(anthropic → /v1,responses → /v1/responses)。
//
// 注意:端点必须带**方案后缀**(/<suffix>/v1),否则评审跑的不是你选的方案:
// 不带后缀的 /v1 会被 resolveProfile 判成 isDefaultEntry → 交给方案组 failover,
// 于是「设置里选的是阶跃星辰,实际跑在火山引擎→DeepSeek」,真实 Key 也从胜出候选
// 借用 —— 用量记在别人头上,而自检查的是评审方案的 Key,查了也发现不了(实测踩过)。
// 带后缀的路径在 resolveProfile 里只会解析出**唯一一个**候选,不参与组调度。
function reviewProfileSuffix(profileName) {
  const prof = (config.profiles || {})[profileName];
  if (!prof) return "";
  const sfx = normalizeProfileSuffix(prof.suffix);
  if (!PROFILE_SUFFIX_RE.test(sfx) || RESERVED_SUFFIXES.has(sfx) || !runtimes[sfx]) return "";
  return sfx;
}
function applyReviewEndpoint(crCfg) {
  const prof = (config.profiles || {})[crCfg.providerProfile];
  const proto = normalizeProfileProtocol(prof?.protocol);
  crCfg.providerProtocol = proto === "responses" ? "openai-responses" : "anthropic";
  const suffix = reviewProfileSuffix(crCfg.providerProfile);
  const base = suffix ? `http://127.0.0.1:${port}/${suffix}` : `http://127.0.0.1:${port}`;
  crCfg.providerUrl = proto === "responses" ? `${base}/v1/responses` : `${base}/v1`;
  return crCfg;
}
// 启动时就地纠正一次:老配置里存的是不带后缀的 /v1(评审会走方案组),重算后落盘,
// 免得管理员必须回设置页点一次保存才生效。
if (config.codeReview && config.codeReview.providerProfile) {
  const before = config.codeReview.providerUrl;
  applyReviewEndpoint(config.codeReview);
  if (config.codeReview.providerUrl !== before) {
    saveConfig(config);
    console.log(`[代码评审] 评审端点已钉到所选方案: ${config.codeReview.providerUrl}`);
  }
}

// 一次性迁移:旧的全局白名单 codeReview.apiKeys → 各仓库的成员名单。
// 语义等价(那份名单当时能触发**所有**已开在线触发的仓库),迁完清空全局键并落盘,
// 之后「谁能碰哪个仓库」只看仓库自己的 members。幂等:apiKeys 空了就什么都不做。
const legacyTriggerKeys = Array.isArray(config.codeReview?.apiKeys) ? config.codeReview.apiKeys.length : 0;
const migratedRepos = migrateLegacyTriggerKeys(config.codeReview);
if (legacyTriggerKeys) {
  saveConfig(config);
  console.log(`[代码评审] 已把旧的全局触发白名单(${legacyTriggerKeys} 个 Key)迁移到 ${migratedRepos} 个仓库的成员名单`);
}

// 仓库入参解析(/repos/test 与 /repos/branches 共用):
//   ① body.repo(对象)= 编辑器里**还没保存**的表单值 —— 走仓库白名单同一套校验,填错当场能发现;
//   ② body.id = 已保存的仓库,表格行按钮用。
// 返回 { repo } 或 { status, error }。
function resolveReviewRepoInput(body) {
  if (body.repo && typeof body.repo === "object") {
    const repo = sanitizeCodeReviewConfig({ repos: [body.repo] }, port).repos[0];
    if (!repo) return { status: 400, error: "仓库信息不合法：地址需为 https/ssh/git@（或 local 绝对路径），分支名不能含特殊字符" };
    // 凭据留空 = 沿用已保存的(界面回显的是掩码);编辑已有仓库时才有原值可沿用
    if (!repo.credential && body.repo.id) {
      const old = codeReviewApi.findRepo(String(body.repo.id));
      if (old && old.credential) repo.credential = old.credential;
    }
    return { repo };
  }
  const repo = codeReviewApi.findRepo(String(body.id || ""));
  return repo ? { repo } : { status: 404, error: "仓库不存在" };
}

// 代码评审结果通知。两条**互相独立**的去向:
//   ① 管理员渠道(飞书/钉钉/…):按 codeReview.notifyOn 规则走,行为与以前一致
//   ② 写代码的人:评审**发现了意见**时,按推送人/提交作者的邮箱匹配系统成员 ——
//      匹配到就**只**通知这个人(走他自己的渠道);没匹配到才直发作者邮箱 + 仓库全员
//      (见 notifyReviewFindings / pushReviewToMembers)
// 用户明确要求「有意见才通知」,所以②只在 comments>0 时发,「未发现问题」不打扰人。
function pushCodeReviewNotice(ev) {
  const c = config.codeReview || {};
  const n = config.notifier || {};
  if (!c.enabled) return;
  const isRun = ev.kind === "run";
  const failed = ev.kind === "disk_full" || (isRun && TERMINAL.has(ev.report.status) && !TERMINAL_OK.has(ev.report.status));
  const findings = isRun ? (ev.report.comments || []) : [];

  // ① 管理员渠道
  if (n.enabled && c.notifyOn !== "never" && (failed || c.notifyOn === "always")) {
    const msg = ev.kind === "disk_full"
      ? `【代码评审】仓库「${ev.repo.name}」工作区磁盘超限,已拒绝入队\n—— ${notifierApi.beijingTimeString()}（token-monitor）`
      : `【代码评审】${ev.repo.name} #${ev.runId} ${ev.report.status} · ${findings.length} 条意见\n—— ${notifierApi.beijingTimeString()}（token-monitor）`;
    for (const s of notifierApi.NOTIFY_SENDERS.filter(x => x.enabled(n))) {
      s.send(n, msg).catch(err => console.error(`[通知] ${s.channel} 推送失败: ${err.message}`));
    }
  }

  // ② 写代码的人 + 该仓库成员:只在**评出意见**时发
  if (isRun && findings.length) {
    notifyReviewFindings(ev).catch(err => console.error(`[代码评审] 通知负责人失败: ${err.message}`));
  }
}

// 把「这次评审发现了什么」拼成一段人话。摘要只取前几条、每条截断 ——
// 通知是提醒,不是全文;详情让成员去「我的用量」页或 MCP 里看。
function reviewFindingsText(ev) {
  const findings = ev.report.comments || [];
  const head = `【代码评审】${ev.repo.name} 发现 ${findings.length} 处问题`;
  const at = (finding) => {
    const line = finding.start_line ? `:${finding.start_line}` : "";
    const text = String(finding.content || "").replace(/\s+/g, " ").slice(0, 160);
    return `· ${finding.path}${line}\n  ${text}`;
  };
  const shown = findings.slice(0, 5).map(at).join("\n");
  const more = findings.length > 5 ? `\n…另有 ${findings.length - 5} 条` : "";
  return [
    head,
    "",
    `仓库：${ev.repo.name}${ev.branch ? `（分支 ${ev.branch}）` : ""}`,
    `提交：${String(ev.to || "").slice(0, 8)}${ev.author && ev.author.name ? ` · ${ev.author.name}` : ""}`,
    "",
    shown + more,
    "",
    "完整结果（含建议改法）请在「我的用量 → 代码评审」查看，或直接问 MCP。",
    `—— ${notifierApi.beijingTimeString()}（token-monitor）`,
  ].filter((x) => x !== null).join("\n");
}

async function notifyReviewFindings(ev) {
  const c = config.codeReview || {};
  const n = config.notifier || {};
  const text = reviewFindingsText(ev);
  const subject = `【代码评审】${ev.repo.name} 发现 ${(ev.report.comments || []).length} 处问题`;
  const jobs = [];
  const mail = notifierApi.NOTIFY_SENDERS.find((s) => s.channel === "邮件");
  const authorEmail = ev.author && ev.author.email;
  let pusherEmail = null;
  try { pusherEmail = codeReviewApi.getRun(ev.runId)?.pusher_email || null; } catch { pusherEmail = null; }

  // 邮件正文 = 导出报告同款完整 HTML(buildReviewReportHTML 已做全字段转义)。
  // 体积护栏:最坏几百条 × 8KB 的意见能拼出十几 MB,任何 SMTP 都会拒 —— 超限降级纯文本。
  let html = "";
  try {
    const run = codeReviewApi.getRun(ev.runId);
    if (run) {
      html = buildReviewReportHTML({ run, comments: codeReviewApi.listComments(ev.runId, { limit: 100 }), repo: ev.repo });
      if (html.length > 1_500_000) {
        console.warn(`[代码评审] run#${ev.runId} 报告 ${(html.length / 1048576).toFixed(1)}MB 过大,邮件降级纯文本`);
        html = "";
      }
    }
  } catch (err) { console.error(`[代码评审] 组装报告 HTML 失败,邮件降级纯文本: ${err.message}`); }

  // a) 这条提交是谁写的:推送人(webhook 带来,比 git 作者更贴近「该负责的人」)优先、
  //    作者兜底,按邮箱匹配系统成员。匹配到 → **只**通知这个人,不打扰仓库全员。
  const target = pickNotifyTarget({
    authorEmail, pusherEmail,
    findByEmail: (e) => memberNotifyApi.findByEmail(e),
    isAccountActive: (key, prefs) => hasGlobalUser(key) && !(config.users || {})[key]?.disabled && prefs?.enabled !== false,
  });
  if (target.matched && (c.notifyCommitAuthor !== false || c.notifyMembers !== false)) {
    jobs.push(pushReviewToMembers(ev, text, subject, [target.userKey], html));
    await Promise.all(jobs);
    return;
  }

  // b) 没匹配到系统成员:维持原行为 —— 直发提交人/推送人邮箱(哪怕他不是网关成员)。
  //    同一邮箱只发一封 —— 作者=推送人是最常见的情形,别双发。
  const recipients = new Set();
  if (c.notifyCommitAuthor !== false && authorEmail && notifierApi.isValidEmail(authorEmail)) recipients.add(authorEmail.toLowerCase());
  if (c.notifyCommitAuthor !== false && pusherEmail && notifierApi.isValidEmail(pusherEmail)) recipients.add(String(pusherEmail).toLowerCase());
  if (mail && mail.enabled(n)) {
    for (const to of recipients) {
      mail.send(n, text, { to, subject, html })
        .catch((err) => console.error(`[通知] 邮件(评审结果 ${to}) 推送失败: ${err.message}`));
    }
  }

  // c) 该仓库的成员:按他们各自配置的渠道(我的用量页里填的)
  if (c.notifyMembers !== false) {
    jobs.push(pushReviewToMembers(ev, text, subject, undefined, html));
  }
  await Promise.all(jobs);
}
// 成员的渠道存在 member_notify 表里(成员自助维护)。这里只做扇出,失败逐个吞掉 ——
// 一个人配错了 webhook 不能让其他人都收不到。memberKeys 缺省 = 仓库全员;定向投递时
// 传单元素数组(只发给匹配到的那个人)。
async function pushReviewToMembers(ev, text, subject, memberKeys, html = "") {
  const keys = Array.isArray(memberKeys) ? memberKeys : (Array.isArray(ev.repo.members) ? ev.repo.members : []);
  if (!memberKeys.length) return;
  const cfg = config.notifier || {};
  const mailSender = notifierApi.NOTIFY_SENDERS.find((s) => s.channel === "邮件");
  for (const key of keys) {
    let prefs = null;
    try { prefs = memberNotifyApi.get(key); } catch { prefs = null; }
    if (!prefs || prefs.enabled === false) continue;
    // 全局 SMTP 凭据 + 该成员自己的收件邮箱
    if (prefs.email && mailSender && mailSender.enabled(cfg) && notifierApi.isValidEmail(prefs.email)) {
      mailSender.send(cfg, text, { to: prefs.email, subject, html })
        .catch((err) => console.error(`[通知] 邮件(成员 ${key.slice(0, 10)}…) 推送失败: ${err.message}`));
    }
    for (const ch of notifierApi.MEMBER_SENDERS) {
      if (!ch.enabled(prefs)) continue;
      ch.send(prefs, text, { subject })
        .catch((err) => console.error(`[通知] ${ch.channel}(成员 ${key.slice(0, 10)}…) 推送失败: ${err.message}`));
    }
  }
}
codeReviewApi.reapStale();   // 上一次进程留下的 queued/running 永远不会再推进

// 代码评审:60s 调度扫描 + 每日清理(unref 不阻止进程退出)。
// 一个定时器干三件事:①按仓库 schedule 判定到期并入队;②北京日界跑一次历史清理;
// ③当日 token 预算用尽时静默停触(见 tick 内部注释)。
// 周期可用 CODE_REVIEW_TICK_MS 覆盖(测试用),下限 50ms —— 不设「至少 1 秒」那种下限,
// 否则测试传的小周期会被静默抬回 1s,表现成「定时功能没生效」。
const CODE_REVIEW_TICK_MS = Math.max(50, Number(process.env.CODE_REVIEW_TICK_MS) || 60_000);
setInterval(() => {
  try { codeReviewApi.tick(); } catch (err) { console.log(`[代码评审] 调度扫描异常: ${err?.message}`); }
}, CODE_REVIEW_TICK_MS).unref();

// ISO(UTC) → 北京时间「YYYY-MM-DD HH:MM」,给接口/MCP 输出用(库内一律存 UTC)
const bjStamp = (iso) => (iso ? new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ") : null);

// MCP 的 since 参数解析成「UTC ISO 时刻」(库内 created_at 是 UTC)。
// 支持 7d / 24h / 30m 与 2026-09-18(按**北京时间当天 00:00** 起算,与全站口径一致)。
// 认不出的取值一律返回 null(不过滤),而不是报错 —— 查不到东西时「给全部」比「给空」有用。
function mcpSinceIso(v) {
  const s0 = String(v == null ? "" : v).trim();
  if (!s0) return null;
  const rel = s0.match(/^(\d+)\s*([dhm])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { d: 86400000, h: 3600000, m: 60000 }[rel[2].toLowerCase()];
    if (Number.isFinite(n) && n > 0) return new Date(Date.now() - n * unit).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s0)) {
    const ms = Date.parse(`${s0}T00:00:00+08:00`);   // 北京时间当天零点
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

// ── Webhook 辅助:密钥校验 / URL 归一化匹配 / 推送人提取 ────────────────────────
const webhookLastPushAt = new Map();   // repoId → ms(push 防抖,重启清空,与其它冷却一致)

// 三家密钥校验。GitHub 不发静态 token,发 HMAC-SHA256(密钥, 原始字节)的十六进制;
// GitLab/Gitee 是静态 token 头。比对走 timingSafeEqual(先比长度再比内容)。
function verifyWebhookSecret(provider, headers, secret, rawBody) {
  if (provider === "github") {
    const sig256 = String(headers["x-hub-signature-256"] || "");
    if (sig256) {
      const expect = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
      return timingSafeEqual(sig256, expect);
    }
    const sig1 = String(headers["x-hub-signature"] || "");   // 旧版 sha1(平台没配 sha256 时的回退)
    if (sig1) {
      const expect = "sha1=" + crypto.createHmac("sha1", secret).update(rawBody).digest("hex");
      return timingSafeEqual(sig1, expect);
    }
    return false;
  }
  const token = String(headers[provider === "gitlab" ? "x-gitlab-token" : "x-gitee-token"] || "");
  return !!token && timingSafeEqual(token, secret);
}

// 把仓库地址归一成「host + path」的比对键:https://host[:port]/a/b.git 与 git@host:a/b.git
// 要能互相关联(白名单常填 SSH 写法,而平台回调是 https)。host 小写、去端口 —— SSH 的
// scp 写法根本表达不了 https 的自定义端口(隐式 22),同 host 同 path 就是同一个逻辑仓库;
// 真正的安全门是密钥 + 白名单本身,端口放严只会让合法配置匹配不上。path 保留大小写
// (GitLab 路径区分大小写)并去掉 .git 与尾斜杠。
function normalizeRepoUrlKey(u) {
  const s0 = String(u || "").trim();
  if (!s0) return "";
  const scp = s0.match(/^git@([A-Za-z0-9.-]+?)(?::\d+)?:([^:]+)$/);   // git@host[:port]:path
  if (scp) return `${scp[1].toLowerCase()}/${scp[2].replace(/\/+$/, "").replace(/\.git$/, "")}`;
  try {
    const x = new URL(s0);
    const path = x.pathname.replace(/\.git$/, "").replace(/\/+$/, "");
    return `${x.hostname.toLowerCase()}${path}`;
  } catch { return ""; }
}

// 从三家载荷里收集仓库地址候选,归一化后与白名单(remote 来源)比对。
// 多候选是因为各家字段名不同,而且同一平台 http/ssh/web 地址都可能出现在不同字段里。
// 返回**所有**命中的条目:同一个仓库 URL 允许在白名单里配多条(每条一个分支,各自勾
// push 自动评审)—— 推 dev 只该触发配 dev 的那条,配 main 的条目由调用方的分支门禁忽略。
function matchWebhookRepos(body) {
  const candidates = [
    body.project?.git_http_url, body.project?.web_url, body.project?.url,
    body.repository?.clone_url, body.repository?.url, body.repository?.git_url, body.repository?.html_url,
    body.url,
  ].filter(Boolean);
  const keys = new Set(candidates.map(normalizeRepoUrlKey).filter(Boolean));
  if (!keys.size) return [];
  return (config.codeReview?.repos || []).filter((repo) =>
    repo.source === "remote" && repo.url && keys.has(normalizeRepoUrlKey(repo.url)));
}

// 推送人:GitHub 是 pusher 对象;GitLab 是顶层 user_name/user_email;Gitee 是 pusher 或 user 对象
function webhookPusher(body) {
  const name = body.pusher?.name || body.user?.name || body.user_name || "";
  const email = body.pusher?.email || body.user?.email || body.user_email || "";
  return { name: String(name).slice(0, 120), email: String(email).slice(0, 200) };
}

// 成员级触发(HTTP /api/code-review/trigger 与 MCP 的 code_review_trigger 共用)。
// 闸门:①Key 是有效成员 ②目标仓库在**该成员的仓库名单**里(超级用户豁免)
// ③该仓库自己开了「允许在线触发」;再加每 Key 60s 一次的限频,防止 CI 抖动把套餐刷穿。
// 注意顺序:先解析出要触发哪些仓库,再逐个判成员资格 —— 权限是**按仓库**给的,
// 不存在「一次授权、全仓库通行」的全局名单。
// 返回 { status, body, results?, actor? } —— 调用方按各自协议翻译(HTTP 写状态码,MCP 包工具结果)。
function triggerReviewForKey(apiKey, repoName) {
  if (!hasGlobalUser(apiKey)) {
    return { status: 401, body: { error: "认证失败：请提供有效的虚拟Key (Authorization: Bearer jx-...)" } };
  }
  const wanted = String(repoName || "").trim();
  const named = wanted ? codeReviewApi.findRepo(wanted) : null;
  if (wanted && !named) return { status: 404, body: { error: `仓库「${wanted}」不在白名单里` } };
  // 不带仓库名 = 触发「该成员名下的全部可触发仓库」
  // 不带仓库名 = 触发「该成员**可触发**的全部仓库」(要看可见性用 reposVisibleTo —— 二者不同)
  const candidates = named ? [named] : codeReviewApi.reposTriggerableBy(apiKey);
  if (!candidates.length) {
    return { status: 403, body: { error: "你没有负责任何仓库（在设置页·代码评审里把你的 Key 加到对应仓库的成员名单）" } };
  }
  // 逐个判:失败必点名是哪个仓库、以及**卡在哪一条** ——
  // 「你不在名单里」与「仓库没开在线触发」是两件不同的事,含糊其辞成员不知道该找谁。
  for (const repo of candidates) {
    if (!codeReviewApi.isRepoMember(apiKey, repo)) {
      return { status: 403, body: { error: `你不在仓库「${repo.name}」的成员名单里，无法触发它的评审` } };
    }
    if (!repo.enabled) return { status: 403, body: { error: `仓库「${repo.name}」已停用` } };
    if (!repo.apiTrigger) return { status: 403, body: { error: `仓库「${repo.name}」未开启在线触发（在设置页里打开）` } };
  }
  const rate = codeReviewApi.checkTriggerRate(apiKey);
  if (!rate.allowed) {
    return { status: 429, body: { error: `触发过于频繁，请 ${rate.retryAfter}s 后重试`, retryAfter: rate.retryAfter } };
  }
  const targets = candidates;
  const actor = getUserName(apiKey) || "api";
  const results = [];
  for (const repo of targets) {
    try {
      const r = codeReviewApi.enqueue(repo.id, { trigger: "api", actor });
      results.push({ repo: repo.name, repoId: repo.id, runId: r.runId, deduped: !!r.deduped, skipped: !!r.skipped });
    } catch (err) {
      results.push({ repo: repo.name, repoId: repo.id, error: err.message });
    }
  }
  // 单仓库:202 = 已受理,200 = 与进行中任务合并/被预算跳过/入队失败;多仓库:200 + 数组
  if (results.length === 1) {
    const one = results[0];
    return { status: one.deduped || one.skipped || one.error ? 200 : 202, body: { ...one, ok: !one.error }, results, actor };
  }
  return { status: 200, body: { ok: true, results }, results, actor };
}

// 产出质量:60s 告警扫描 + 过期清理(unref 不阻止进程退出);告警经既有通知渠道 webhook 推送。
const prodNotifyCooldown = new Map();
function pushProductionAlert(a) {
  const cfg = config.notifier || {};
  if (!cfg.enabled) return;
  const key = a.kind + ":" + a.user_key;
  if (Date.now() - (prodNotifyCooldown.get(key) || 0) < 60_000) return;
  prodNotifyCooldown.set(key, Date.now());
  const names = { idle_burn: "空转消耗", error_loop: "错误循环", edit_failure_burst: "编辑失败爆发" };
  const msg = `【产出告警】${names[a.kind] || a.kind} · ${a.user_name || a.user_key}\n${a.detail || ""}\n—— ${notifierApi.beijingTimeString()}（token-monitor）`;
  for (const s of notifierApi.NOTIFY_SENDERS.filter(s => s.enabled(cfg))) {
    s.send(cfg, msg).then(() => console.log(`[通知] 已推送 ${s.channel}: 产出告警 ${a.kind}`))
      .catch(err => console.error(`[通知] ${s.channel} 推送失败: ${err.message}`));
  }
}
setInterval(() => {
  try {
    const fired = productionTracker.scanAlerts((config.productionTracking || {}).alerts || {});
    for (const a of fired) pushProductionAlert(a);
    productionTracker.maybePrune();
  } catch (err) { console.log(`[production] 告警扫描异常: ${err?.message}`); }
}, 60_000).unref();
persistenceApi.migrateFromJsonIfNeeded();
persistenceApi.pruneOldDataIfNewDay(); // also run at startup so rows pruned under an old policy converge immediately
loadRateLimitState();

function removeLegacyOpenAIData() {
  const suffixes = removedOpenAIProfileSuffixes.filter(Boolean);
  if (suffixes.length === 0) return;
  db.pragma("wal_checkpoint(FULL)");
  backupFileSync(dbPath, "data.db", "remove-openai");
  const placeholders = suffixes.map(() => "?").join(",");
  const removedKeys = db.prepare(`SELECT DISTINCT user_key FROM users WHERE profile IN (${placeholders})`).all(...suffixes).map((row) => row.user_key);
  const tx = db.transaction(() => {
    for (const table of ["users", "usage_daily", "usage_daily_model", "usage_daily_client", "usage_daily_hourly", "usage_hourly_model", "usage_model", "usage_hourly", "errors"]) {
      db.prepare(`DELETE FROM ${table} WHERE profile IN (${placeholders})`).run(...suffixes);
    }
    for (const key of removedKeys) {
      if (!config.users?.[key]) db.prepare("DELETE FROM quota_adjust_history WHERE user_key=?").run(key);
    }
  });
  tx();
  console.log(`[MIGRATE] Removed persisted data for ${suffixes.length} OpenAI profile(s)`);
}

removeLegacyOpenAIData();

// ─── User Helpers ─────────────────────────────────────────────────────────────
// Normalize user config to { username, key, allowedModels }
// Supports backward compat: old format "username" → new format object
// Get global user info (username, expiresAt, disabled) from config.users
function getGlobalUser(apiKey, _rt) {
  const runtime = _rt || rt;
  if (!runtime) return null;
  return runtime.globalUsers[apiKey] || runtime.globalUsers[resolveUserKey(apiKey, runtime)] || null;
}

function getUserConfig(apiKey, _rt) {
  const runtime = _rt || rt;
  const key = resolveUserKey(apiKey, runtime);
  const pu = runtime.users[key]; // profile user: { key, disabled }
  const gu = getGlobalUser(apiKey, runtime); // global user: { username, expiresAt, disabled }
  const realKey = pu ? (typeof pu === "string" ? pu : (pu.key || key)) : key;
  const username = gu ? (gu.username || `未知`) : `未知(${key.slice(0, 8)})`;
  const expiresAt = gu ? (gu.expiresAt || null) : null;
  return { username, key: realKey, expiresAt };
}

function resolveUserKey(apiKey, _rt) {
  const runtime = _rt || rt;
  if (!runtime) return apiKey;
  if (runtime.users[apiKey] || runtime.globalUsers[apiKey]) return apiKey;
  return apiKey.slice(0, 12);
}

function getUserName(apiKey, _rt) {
  const gu = getGlobalUser(apiKey, _rt);
  return gu ? (gu.username || `未知`) : `未知(${apiKey.slice(0, 8)})`;
}

function getRealKey(apiKey, _rt) {
  const runtime = _rt || rt;
  const key = resolveUserKey(apiKey, runtime);
  const pu = runtime.users[key];
  if (!pu) return apiKey;
  if (typeof pu === "string") return pu;
  return pu.key || apiKey;
}

function checkModelAllowed(model, _rt) {
  if (!model || model === "unknown") return true;
  const allowed = (_rt || rt).allowedModels;
  if (!allowed || allowed.length === 0) return true;
  if (allowed.includes("*")) return true;
  return allowed.includes(model);
}

function previewList(values, fallback = "none") {
  const items = Array.from(new Set((values || []).filter(Boolean)));
  if (items.length === 0) return fallback;
  const shown = items.slice(0, 8).join(", ");
  return items.length > 8 ? `${shown}, ...` : shown;
}

function modelNotAllowedMessage(model, runtime) {
  const allowed = (runtime?.allowedModels || []).join(", ") || "(空)";
  const aliases = Object.keys(effectiveModelAliases(runtime || rt)).join(", ");
  const aliasHint = aliases ? `，或该方案的别名: ${aliases}` : "";
  return `Model "${model}" is not allowed on profile "${runtime?.profileName || "?"}". 允许的模型: ${allowed}${aliasHint}`;
}

function generateVirtualKey(_rt) {
  const runtime = _rt || rt;
  let code;
  do {
    code = "jx-" + crypto.randomBytes(18).toString("base64url");
  } while (runtime.globalUsers[code] || runtime.users[code]);
  return code;
}

function checkKeyExpired(apiKey, _rt) {
  const gu = getGlobalUser(apiKey, _rt);
  if (!gu || !gu.expiresAt) return false;
  return new Date(gu.expiresAt).getTime() < Date.now();
}

function checkUserDisabled(apiKey, _rt) {
  const runtime = _rt || rt;
  const key = resolveUserKey(apiKey, runtime);
  // Global disable
  const gu = getGlobalUser(apiKey, runtime);
  if (gu && gu.disabled) return true;
  // Profile disable
  const pu = runtime.users[key];
  if (pu && typeof pu === "object" && pu.disabled) return true;
  return false;
}

function getProfileUser(apiKey, _rt) {
  const runtime = _rt || rt;
  if (!runtime) return null;
  return runtime.users[resolveUserKey(apiKey, runtime)] || null;
}

// 一个方案用户条目是否携带真实Key（空/纯空白 = 占位，不可用此方案）。
// 这是「能不能用这个方案」的唯一判据：canUseProfile 靠它拒绝，额度池的
// memberUsers 也用它过滤。兼容 {key} 与史前的纯字符串两种格式。
function hasRealKey(u) {
  const k = typeof u === "string" ? u : (u && u.key);
  return !!(k && String(k).trim());
}

function hasProfileRealKey(apiKey, _rt) {
  const pu = getProfileUser(apiKey, _rt);
  if (!pu) return false;
  return hasRealKey(pu);
}

// 超级用户：全局用户表里 superUser=true 的虚拟Key，可绕过方案分配与限制直连。
// 兼容旧字段名 admin（首次上线版本的叫法）。
function isSuperUser(apiKey, _rt) {
  const gu = getGlobalUser(apiKey, _rt);
  return !!(gu && (gu.superUser || gu.admin));
}

// 从方案已分配的用户里借一个可用的真实Key（跳过禁用与空值，兼容双格式）。
// 仅超级用户借用路径会走到这里；找不到返回 null，调用方须拒绝转发。
function borrowProfileRealKey(_rt) {
  const runtime = _rt || rt;
  if (!runtime || !runtime.users) return null;
  for (const pu of Object.values(runtime.users)) {
    if (pu && typeof pu === "object" && pu.disabled) continue;
    const key = typeof pu === "string" ? pu : (pu.key || "");
    if (key && String(key).trim()) return key;
  }
  return null;
}

function canUseProfile(apiKey, _rt) {
  const runtime = _rt || rt;
  if (!runtime) return { allowed: false, reason: "Profile not found" };
  const key = resolveUserKey(apiKey, runtime);
  const gu = getGlobalUser(key, runtime);
  if (!gu) return { allowed: false, reason: "Unknown API key" };
  // 超级用户豁免方案分配限制（禁用/过期检查保持在其后，失效超级用户仍被拒）。
  if (!isSuperUser(apiKey, runtime) && !hasProfileRealKey(key, runtime)) return { allowed: false, reason: `User is not allowed to use profile "${runtime.profileName}"` };
  if (checkUserDisabled(key, runtime)) return { allowed: false, reason: "User is disabled." };
  if (checkKeyExpired(key, runtime)) return { allowed: false, reason: "API key has expired. Please contact your administrator." };
  return { allowed: true, userKey: key };
}

function getAccessibleProfiles(apiKey) {
  const out = [];
  for (const profile of listProfiles()) {
    const runtime = runtimes[profile.suffix];
    if (runtime && canUseProfile(apiKey, runtime).allowed) {
      out.push({ suffix: profile.suffix, name: profile.name, isDefault: profile.isDefault, protocol: profile.protocol });
    }
  }
  return out;
}

function hasGlobalUser(apiKey) {
  return Object.values(runtimes).some(runtime => !!getGlobalUser(apiKey, runtime));
}

// 全队真实 key 的并集(方案成员 + 全局用户),去重。
// 排行榜用它把「12 字符孤儿 key」认领回本人:resolveUserKey(:1450)对未知 key 只留
// 前 12 字符,于是同一个人可能在 usage_daily 留下完整 key 与桩两条记录。桩只能靠
// 前缀命中某个已知 key 认领 —— 不能按名字合并,桩落库时的名字是 未知(jx-abcdef)。
function knownUserKeys() {
  const out = new Set();
  for (const runtime of Object.values(runtimes)) {
    for (const k of Object.keys(runtime.users || {})) out.add(k);
    for (const k of Object.keys(runtime.globalUsers || {})) out.add(k);
  }
  return [...out];
}

// During peak hours, peak aliases override the defaults per key; keys absent from
// the peak set keep their default mapping. Evaluated per request, so crossing a
// peak boundary needs no config reload.
function effectiveModelAliases(runtime) {
  const defaults = runtime.modelAliases || {};
  const peak = runtime.peakModelAliases || {};
  if (Object.keys(peak).length === 0) return defaults;
  if (!isInPeakHours(runtime.peakHours)) return defaults;
  return { ...defaults, ...peak };
}

function resolveModel(model, _rt) {
  if (!model) return model;
  const runtime = _rt || rt;
  const aliases = effectiveModelAliases(runtime);
  if (aliases[model]) return aliases[model];
  const alias = model.toLowerCase();
  for (const [name, target] of Object.entries(aliases)) {
    if (name.toLowerCase() === alias) return target;
  }
  return model;
}

// ─── Inbound Protocol Dispatch ───────────────────────────────────────────────
// Codex speaks the OpenAI Responses API (POST /v1/responses) and probes
// GET /v1/models; Claude Code speaks Anthropic Messages (POST /v1/messages).
// The two profile pools are strictly isolated and never cross-route.
function classifyInboundPath(reqUrl, method) {
  const pathname = decodeURIComponent(new URL(reqUrl || "/", "http://localhost").pathname);
  const upperMethod = String(method || "GET").toUpperCase();
  const suffixSeg = pathname.match(/^\/([a-zA-Z0-9_-]{2,20})(\/.*)?$/);
  const suffix = suffixSeg && !RESERVED_SUFFIXES.has(suffixSeg[1].toLowerCase())
    ? suffixSeg[1].toLowerCase()
    : null;

  if (pathname.endsWith("/chat/completions")) {
    return { kind: "unsupported", reason: "chat_completions" };
  }
  if (/\/(v1\/)?responses\/[^/]+$/.test(pathname)) {
    // e.g. GET /v1/responses/{id} — Codex runs store:false and never retrieves.
    return { kind: "unsupported", reason: "responses_retrieval" };
  }

  const isModels = pathname === "/v1/models" || pathname === "/models" ||
    (!!suffix && (suffixSeg[2] === "/v1/models" || suffixSeg[2] === "/models"));
  if (isModels) {
    if (upperMethod !== "GET" && upperMethod !== "HEAD") return { kind: "unsupported", reason: "method" };
    return { kind: "models", suffix, isDefaultEntry: !suffix };
  }

  const isResponses = pathname === "/v1/responses" || pathname === "/responses" ||
    (!!suffix && (suffixSeg[2] === "/v1/responses" || suffixSeg[2] === "/responses"));
  if (isResponses) {
    if (upperMethod !== "POST") return { kind: "unsupported", reason: "method" };
    return { kind: "responses", suffix, isDefaultEntry: !suffix };
  }

  return { kind: "anthropic", suffix, isDefaultEntry: pathname === "/v1" || pathname.startsWith("/v1/") };
}

function unsupportedInboundMessage(reason) {
  if (reason === "chat_completions") return "Chat Completions is not supported. Codex must use the Responses API (POST /v1/responses) against a responses-protocol profile.";
  if (reason === "responses_retrieval") return "Response retrieval is not supported: Codex runs with store:false and replays the full conversation each turn.";
  if (reason === "method") return "Unsupported HTTP method for this endpoint.";
  return "Unsupported endpoint.";
}

function sendOpenAiError(res, status, code, message, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  res.end(JSON.stringify({ error: { code, message } }));
}

// Codex probes GET /v1/models to build its model picker. Serve it locally from
// the responses pool so client probes never touch upstream billing endpoints.
function handleLocalModelsRequest(req, res, inbound) {
  const apiKey = getApiKey(req);
  const runtime = inbound.suffix ? runtimes[inbound.suffix] : getResponsesDefaultRuntime();
  if (!runtime || runtime.protocol !== "responses") {
    if (inbound.suffix) {
      sendOpenAiError(res, 404, "profile_not_found", `No responses-protocol profile with suffix "${inbound.suffix}".`);
    } else {
      sendOpenAiError(res, 503, "no_responses_profile", "No responses profile configured yet. Create one in Settings to use Codex.");
    }
    return;
  }
  if (!canUseProfile(apiKey, runtime).allowed) {
    sendOpenAiError(res, 401, "invalid_api_key", "Invalid API key for this profile.");
    return;
  }
  const ids = new Set((runtime.allowedModels || []).filter((m) => m && m !== "*"));
  const aliases = effectiveModelAliases(runtime);
  for (const [alias, target] of Object.entries(aliases)) {
    if (alias) ids.add(alias);
    if (target) ids.add(target);
  }
  const body = JSON.stringify({
    object: "list",
    data: [...ids].map((id) => ({ id, object: "model", created: 0, owned_by: "cc-team" })),
  });
  res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(req.method === "HEAD" ? undefined : body);
}

// Resolve the serving runtime for an inbound Responses request. Default entry
// (/v1/responses) targets the responses group head; a suffix entry must hit a
// responses-protocol profile or fail with a clear cross-protocol error.
function resolveResponsesProfile(inbound, url) {
  const query = url.includes("?") ? url.slice(url.indexOf("?")) : "";
  if (inbound.suffix) {
    const runtime = runtimes[inbound.suffix];
    if (!runtime) return { error: `Unknown profile suffix "${inbound.suffix}"` };
    if (runtime.protocol !== "responses") {
      return {
        error: `方案 "${runtime.profileName}" 是 Anthropic Messages 方案，不能通过 /v1/responses 访问。请为 Codex 创建 protocol 为 responses 的方案。`,
      };
    }
    // responsesPath is the upstream-relative endpoint segment the gateway should
    // post the Responses body to. Almost every provider exposes base + "/v1/responses",
    // but some (e.g. Volcano Coding Plan) expose base + "/responses"; allowing it to
    // override per-profile lets those upstreams work without touching the client path.
    const strippedUrl = (runtime.responsesPath || "/v1/responses") + query;
    return { suffix: inbound.suffix, runtime, strippedUrl, isDefaultEntry: false };
  }
  const runtime = getResponsesDefaultRuntime();
  if (!runtime) return { noResponsesProfile: true };
  const strippedUrl = (runtime.responsesPath || "/v1/responses") + query;
  return { suffix: runtime.suffix, runtime, strippedUrl, isDefaultEntry: true };
}

function mergeUsageCounters(target, source) {
  if (!source || typeof source !== "object") return;
  const toTokenNumber = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const input = toTokenNumber(source.input_tokens ?? source.prompt_tokens);
  const output = toTokenNumber(source.output_tokens ?? source.completion_tokens);
  const total = toTokenNumber(source.total_tokens);
  if (input !== null) target.input_tokens = input;
  if (output !== null) target.output_tokens = output;
  if (input === null && output === null && total !== null) {
    target.output_tokens = total;
  }
  const cacheCreation = toTokenNumber(source.cache_creation_input_tokens);
  // Responses API nests cached tokens under input_tokens_details; chat-completions
  // upstreams use prompt_tokens_details. Both map onto the cache-read counter.
  const cacheRead = toTokenNumber(source.cache_read_input_tokens ??
    source.input_tokens_details?.cached_tokens ??
    source.prompt_tokens_details?.cached_tokens);
  if (cacheCreation !== null) target.cache_creation_input_tokens = cacheCreation;
  if (cacheRead !== null) target.cache_read_input_tokens = cacheRead;
}

function usageHasTokens(usage = {}) {
  return !!((usage.input_tokens || 0) > 0 || (usage.output_tokens || 0) > 0 ||
    (usage.prompt_tokens || 0) > 0 || (usage.completion_tokens || 0) > 0 ||
    (usage.cache_creation_input_tokens || 0) > 0 || (usage.cache_read_input_tokens || 0) > 0 ||
    (usage.total_tokens || 0) > 0);
}

// ─── Timezone Helpers (UTC+8 北京时间) ────────────────────────────────────────
// cnNow/cnDate/cnHour/cnHalfHour/secondsUntilNextCnMidnight 已迁至 ./lib/time.mjs。

// session 由代理主路径透传(proxy-core 的 extractSessionSignal),只用于会话维度的记账,
// 不参与任何路由或配额判断。省略时为 undefined,即不落 usage_session。
// client 同理(proxy-core 的 extractClientSignal),只用于客户端维度的记账。
function recordUsage(apiKey, usage, model, suffix, _rt, session, client) {
  const runtime = _rt || runtimes[normalizeProfileSuffix(suffix)] || rt;
  const sfx = normalizeProfileSuffix(suffix) || runtime?.suffix || getDefaultProfileSuffix();
  const key = resolveUserKey(apiKey, runtime);
  const today = cnDate();
  // 半小时槽位(如 "14:30"),三张按小时记账的表共用这一个键。旧行是 "14" 两字符,
  // 与本格式不匹配 —— 这是刻意的:不迁移历史,只在读取端做阶梯兜底。
  const hour = cnHalfHour();
  const toTokenNumber = (value) => {
    if (value === undefined || value === null || value === "") return 0;
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const inp = toTokenNumber(usage.input_tokens ?? usage.prompt_tokens);
  let out = toTokenNumber(usage.output_tokens ?? usage.completion_tokens);
  if (!inp && !out && usage.total_tokens) out = toTokenNumber(usage.total_tokens);
  const cacheC = toTokenNumber(usage.cache_creation_input_tokens);
  const cacheR = toTokenNumber(usage.cache_read_input_tokens ??
    usage.input_tokens_details?.cached_tokens ??
    usage.prompt_tokens_details?.cached_tokens);
  const m = model || "unknown";

  persistenceApi.pruneOldDataIfNewDay();

  // Weight the request at the rate in force right now, for THIS model. This is
  // settled at write time on purpose: the row's cost is frozen, so changing a rate
  // later only affects future requests and never silently re-prices history. Note
  // the rate comes from the completion instant (same convention as cnHalfHour()
  // above), so a request spanning a peak boundary is priced by where it finished.
  const rate = currentQuotaRate(runtime, new Date(), m);
  // 存储口径对齐(2026-09-18):Anthropic 上游单独上报缓存读,input_tokens 天然不含缓存;
  // Responses/OpenAI 上游把缓存 slice 折叠进 input_tokens。落库前把这一 slice 剥掉,
  // 两种协议的 input_tokens 从此同义(= 新鲜输入),缓存只进 cache_read 列 —— 所有
  // 展示汇总(卡片/图表/排行榜/等值成本)无需任何协议知识即可跨协议比较,也不再
  // 双重计数。历史数据由 initDb 的一次性迁移对齐(kv_meta: migrate:usage-input-align)。
  // 配额(weighted)语义不变:cacheReadQuotaRate 仍决定缓存 slice 计入配额的比例。
  // 守卫:cacheR > inp 视为上游已自行对齐,不动。
  const cacheInInput = (runtime?.protocol === "responses" && cacheR > 0 && cacheR <= inp) ? cacheR : 0;
  const storeInp = inp - cacheInInput;
  const cacheReadQuotaRate = runtime?.cacheReadQuotaRate ?? 0;
  const billableInp = storeInp + Math.round(cacheInInput * cacheReadQuotaRate);
  const weighted = Math.round((billableInp + out) * rate);

  const p = { profile: sfx, key, name: getUserName(key, runtime), inp: storeInp, out, cacheC, cacheR, m, tokenTotal: storeInp + out, weighted, today, hour, now: new Date().toISOString() };
  const tx = db.transaction(() => {
    stmts.upsertUser.run(p);
    stmts.upsertDaily.run(p);
    stmts.upsertModel.run(p);
    stmts.upsertHourly.run(p);
    stmts.upsertDailyModel.run(p);
    stmts.upsertDailyClient.run({ ...p, client: client || "unknown" });
    stmts.upsertDailyHourly.run(p);
    stmts.upsertHourlyModel.run(p);
    // 会话维度:extractSessionSignal 回落到 "nosession"(无会话头、无 prompt_cache_key、
    // 首条消息也推不出)时不落表 —— 否则所有人的无标识请求会挤进同一个假会话,比不记更糟。
    // 缺的这部分由接口的 unattributed 如实披露,不藏。
    if (session && session !== "nosession") stmts.upsertSession.run({ ...p, session, client: client || null });
  });
  tx();
}

// ─── Token Quota ──────────────────────────────────────────────────────────────
// Pooled usage. Membership changes at runtime (config edits), so the IN clause
// is built per member count and the prepared statement cached — one statement per
// distinct pool size, not one per call.
const { pooledUsageForQuota, getPoolQuota, getUserPoolQuota, clearPooledUsageCache } =
  buildQuotaCore({ db, getPoolByName });

function checkTokenQuota(apiKey, suffix, _rt, model = null) {
  const runtime = _rt || rt;
  const key = resolveUserKey(apiKey, runtime);
  const sfx = normalizeProfileSuffix(suffix) || runtime?.suffix || "";
  const today = cnDate();
  // Usage is summed over every profile in the pool: the allowance belongs to the
  // upstream subscription, not to one route into it. Each member contributed rows
  // already weighted at its own rate, so a pool can price Codex traffic higher
  // than Claude Code traffic while both draw from the same allowance.
  const poolName = runtime?.quotaPool || getPoolForSuffix(sfx).name;
  const members = getPoolSuffixes(poolName);
  const suffixes = members.length ? members : (sfx ? [sfx] : []);
  // `used` is the quota currency (weighted); `raw` is the real token count shown
  // alongside it so users can reconcile "扣了 1.2M 额度" with "实际用了 2.1M token".
  const row = pooledUsageForQuota(suffixes, today, key);
  const weightedUsed = row.used, rawTotal = row.raw;
  // Manual daily ops (bonus / reset baseline) are keyed by Beijing date, so
  // yesterday's row stops matching automatically — no cleanup job needed. They are
  // keyed by POOL: a bonus granted for the plan has to count in every profile that
  // draws from it, otherwise the user stays blocked on the other route.
  const op = stmts.getQuotaDailyOp.get(poolName, key, today) || {};
  const baseline = op.reset_baseline || 0;
  const used = Math.max(0, weightedUsed - baseline);
  // Scale the baseline into raw terms by the day's effective ratio so rawUsed and
  // used stay comparable after a reset (both measure "since the reset point").
  const dayRatio = weightedUsed > 0 ? rawTotal / weightedUsed : 1;
  const rawUsed = Math.max(0, Math.round(rawTotal - baseline * dayRatio));
  // `rate` is the price the NEXT request would pay ON THIS PROFILE — rates stay
  // per profile even though the allowance is shared. With a model given (the proxy
  // pre-flight path) it is that model's rate; without one it is the profile
  // default, labelled as such so a mixed day is never shown as one multiplier.
  const rate = currentQuotaRate(runtime, new Date(), model);
  const rateIsDefault = !lookupModelQuotaRate(runtime?.modelQuotaRates, model);
  const inPeak = isInPeakHours(runtime?.peakHours);
  const discounted = Math.max(0, rawUsed - used);
  const pool = getPoolByName(poolName);
  const poolLabel = pool?.label || poolName;

  // Cache-hit display context: whether EVERY pool member is a responses/OpenAI
  // profile — i.e. cache reads arrive INSIDE input_tokens and are excluded from
  // the quota basis by default (cacheReadQuotaRate). Only then may the UI state
  // "缓存命中不计入配额" truthfully instead of folding the gap into the generic
  // 倍率 wording. A mixed anthropic+responses pool stays conservative (false).
  const poolRts = suffixes.map((s) => runtimes[s]).filter(Boolean);
  const poolAllResponses = poolRts.length > 0 && poolRts.every((r) => r.protocol === "responses");
  const cacheRead = row.cr || 0;
  const cacheInInput = poolAllResponses;
  const cacheReadQuotaRate = poolAllResponses
    ? Math.min(...poolRts.map((r) => (r.cacheReadQuotaRate != null ? r.cacheReadQuotaRate : 0)))
    : 0;

  // Per-user pool quota overrides the pool-wide quota
  const userQuota = getUserPoolQuota(poolName, key);
  const poolQuota = getPoolQuota(poolName);
  const baseLimit = userQuota > 0 ? userQuota : poolQuota;
  const bonus = op.bonus > 0 ? op.bonus : 0;
  const shared = suffixes.length > 1;
  const meta = { rawUsed, discounted, rate, rateIsDefault, inPeak, model, cacheRead, cacheInInput, cacheReadQuotaRate, pool: poolName, poolLabel, poolProfiles: suffixes, poolShared: shared };

  if (baseLimit <= 0) {
    return { allowed: true, limit: 0, used, remaining: Infinity, source: "无限制", bonus: 0, resetApplied: !!baseline, ...meta };
  }

  const limit = baseLimit + bonus;
  return {
    allowed: used < limit,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    source: userQuota > 0 ? "个人配额" : "额度池配额",
    bonus,
    resetApplied: !!baseline,
    ...meta,
  };
}

// Quota-exceeded text shared by both protocol branches, and the audit/log detail
// line — both now in lib/quota.mjs (pure string builders over the quota payload).

// ─── Auto Quota Adjustment ─────────────────────────────────────────────────
function evaluateAutoQuotaAdjustments() {
  const cfg = config.autoQuotaAdjust;
  if (!cfg || !cfg.enabled) return;

  const today = cnDate();
  if (getMeta("lastQuotaEval") === today) return;
  setMeta("lastQuotaEval", today);

  const period = cfg.evaluationPeriodDays || 5;
  const hitThreshold = cfg.hitThreshold || 0.9;
  const triggerRate = cfg.triggerRate || 0.9;
  const increaseFactor = cfg.increaseFactor || 1.15;
  const safetyFactor = cfg.safetyFactor || 1.3;
  const maxIncreaseFactor = cfg.maxIncreaseFactor || 2.0;
  const maxAutoQuota = cfg.maxAutoQuota || 10000000;
  const cooldownDays = cfg.cooldownDays || 3;

  // Collect last P dates (excluding today)
  const dates = [];
  for (let i = 1; i <= period; i++) {
    dates.push(new Date(cnNow().getTime() - i * 86400000).toISOString().slice(0, 10));
  }

  const profile = config.profiles[getDefaultProfileName()];
  if (!profile || !profile.users) return;
  // Evaluation follows the ALLOWANCE, which lives in the default profile's pool:
  // usage is summed over every member profile and the raise is written to the
  // pool. Per-profile evaluation would compound with pooling the same way it
  // compounded with discounts — a user at exactly 100% of the pooled quota would
  // look over-limit through any single member's lens.
  const poolName = resolvePoolName(getDefaultProfileName());
  const pool = getPoolByName(poolName);
  if (!pool) return;
  const members = getPoolSuffixes(poolName);

  for (const vk of Object.keys(pool.users || {})) {
    const userQuota = getUserPoolQuota(poolName, vk);
    if (!userQuota || userQuota <= 0) continue; // skip users without quota
    if (!getGlobalUser(vk)) continue;   // key no longer exists globally

    // Check cooldown
    const lastAdjust = stmts.lastQuotaAdjust.get(vk);
    if (lastAdjust) {
      const lastDate = new Date(lastAdjust.date);
      const nowDate = new Date(today);
      const diffDays = Math.floor((nowDate - lastDate) / 86400000);
      if (diffDays < cooldownDays) continue;
    }

    // Count hit days and calculate average usage (one SQL query per user).
    // Uses the weighted column — the same currency the quota is expressed in —
    // summed across every profile in the pool. Reading raw tokens here would
    // double-count off-peak discounts: a user at exactly 100% of a ×0.5 quota
    // looks like 200% in raw terms, and the auto-raise would compound the
    // discount instead of respecting it.
    const earliest = dates[dates.length - 1];
    const holes = members.map(() => "?").join(",");
    const dayRows = db.prepare(`SELECT date, SUM(weighted_tokens) AS weighted_tokens FROM usage_daily
      WHERE user_key=? AND date>=? AND profile IN (${holes}) GROUP BY date`).all(vk, earliest, ...members)
      .filter(r => dates.includes(r.date));
    let hitCount = 0;
    let totalUsage = 0;
    let usageDays = 0;
    for (const r of dayRows) {
      const dayUsage = r.weighted_tokens || 0;
      if (dayUsage > 0) {
        usageDays++;
        totalUsage += dayUsage;
        if (dayUsage >= userQuota * hitThreshold) hitCount++;
      }
    }

    if (usageDays === 0) continue;
    const actualHitRate = hitCount / period;
    if (actualHitRate < triggerRate) continue;

    const avgDaily = totalUsage / usageDays;
    const methodA = userQuota * increaseFactor;
    const methodB = avgDaily * safetyFactor;
    let newQuota = Math.max(methodA, methodB);

    // Apply constraints
    newQuota = Math.min(newQuota, userQuota * maxIncreaseFactor);
    newQuota = Math.min(newQuota, maxAutoQuota);
    newQuota = Math.round(newQuota);

    if (newQuota <= userQuota) continue;

    // Execute adjustment — in the pool
    pool.users[vk].dailyTokenLimit = newQuota;

    stmts.insertQuotaAdjust.run({
      user: vk, username: getUserName(vk), date: today, oldQuota: userQuota, newQuota,
      hitRate: Math.round(actualHitRate * 100) / 100, avgDailyUsage: Math.round(avgDaily),
      time: new Date().toISOString(),
    });
    stmts.trimQuotaAdjust.run();

    saveConfig(config);
    console.log(`[配额调整] ${getUserName(vk)} ${userQuota.toLocaleString()} → ${newQuota.toLocaleString()} (命中率${Math.round(actualHitRate * 100)}%, 均值${Math.round(avgDaily).toLocaleString()})`);
    recordAudit("system", "quota.auto_adjust", `${pool.label || poolName} · ${maskAuditKey(vk)}`,
      `自动配额调整：${getUserName(vk)} 额度池「${pool.label || poolName}」每日配额 ${userQuota.toLocaleString()} → ${newQuota.toLocaleString()}（近${period}天命中率 ${Math.round(actualHitRate * 100)}%，日均 ${Math.round(avgDaily).toLocaleString()}）`);
  }
}

// ─── Error Recording ──────────────────────────────────────────────────────────
function recordError(apiKey, statusCode, errorMessage, path, model, suffix, _rt) {
  const runtime = _rt || runtimes[normalizeProfileSuffix(suffix)] || rt;
  const key = resolveUserKey(apiKey, runtime);
  const sfx = normalizeProfileSuffix(suffix) || runtime?.suffix || "";
  stmts.insertError.run({
    profile: sfx, time: new Date().toISOString(), userName: getUserName(key, runtime),
    key, statusCode, error: errorMessage, path, model: model || "unknown",
  });
  const cutoff7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const tx = db.transaction(() => {
    stmts.pruneErrors.run(cutoff7d);
    stmts.trimErrors.run();
  });
  tx();
  console.log(`[错误] ${getUserName(key, runtime)} ${statusCode} ${errorMessage} ${path} model=${model || "unknown"}`);
}

// ─── Audit Log ────────────────────────────────────────────────────────────────
// Every config mutation and runtime state transition (failover / breaker /
// rate-limit / auto quota) lands here. Never throws into the caller.
// Explicit log types. Legacy entries (and any caller that omits `category`)
// keep the historical derivation: auth.* prefix → auth, system actor → system,
// everything else → admin. checkin / request are always written explicitly by
// the check-in and quota-request flows.
function deriveAuditCategory(actor, action) {
  if (action && action.startsWith("auth.")) return "auth";
  if (actor === "system") return "system";
  if (actor === "user") {
    if (action && action.startsWith("checkin.")) return "checkin";
    if (action && action.startsWith("request.")) return "request";
  }
  return "admin";
}

function recordAudit(actor, action, target, detail, ip, category) {
  try {
    const time = new Date().toISOString();
    stmts.insertAudit.run({
      time,
      actor: String(actor || "system"),
      action: String(action || "unknown"),
      target: String(target || ""),
      detail: String(detail || ""),
      ip: String(ip || ""),
      category: category || deriveAuditCategory(actor, action),
    });
    stmts.trimAudit.run();
    // Best-effort push of system failure/recovery events; must never affect the
    // audit write or the caller, so it is fully guarded.
    try { notifierApi.notifyAuditEvent({ time, actor, action: String(action || "unknown"), target: String(target || ""), detail: String(detail || "") }); }
    catch (err) { console.error("[通知] 分发失败:", err.message); }
  } catch (err) {
    console.error("[审计] 写入失败:", err.message);
  }
}

function recordAdminAudit(req, action, target, detail, category) {
  recordAudit("admin", action, target, detail, getClientIp(req), category);
}

function maskAuditKey(key) {
  const s = String(key || "");
  return s.length > 8 ? s.slice(0, 8) + "****" : s;
}

// ─── Request Log (daily JSONL files under logs/) ──────────────────────────────
// One line of metadata per proxied request, for after-the-fact tracing. Never
// stores conversation content — same privacy boundary as the rest of the system.
const REQUEST_LOG_DIR = path.join(__dirname, "logs");
const REQUEST_LOG_RETENTION_DAYS = 30;
let requestLogStream = null;
let requestLogDate = null;
let requestLogBroken = false;

function pruneRequestLogs() {
  try {
    const cutoff = new Date(cnNow().getTime() - REQUEST_LOG_RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
    for (const name of fs.readdirSync(REQUEST_LOG_DIR)) {
      const m = name.match(/^requests-(\d{4}-\d{2}-\d{2})\.log$/);
      if (m && m[1] < cutoff) {
        try { fs.unlinkSync(path.join(REQUEST_LOG_DIR, name)); } catch {}
      }
    }
  } catch {}
}

function openRequestLog(dateStr) {
  try {
    fs.mkdirSync(REQUEST_LOG_DIR, { recursive: true });
    if (requestLogStream) { requestLogStream.end(); requestLogStream = null; }
    requestLogDate = dateStr;
    requestLogStream = fs.createWriteStream(path.join(REQUEST_LOG_DIR, `requests-${dateStr}.log`), { flags: "a" });
    requestLogStream.on("error", (err) => {
      console.error("[请求日志] 写入失败，已停用:", err.message);
      requestLogBroken = true;
      try { requestLogStream.destroy(); } catch {}
      requestLogStream = null;
    });
    pruneRequestLogs();
  } catch (err) {
    console.error("[请求日志] 打开失败:", err.message);
    requestLogBroken = true;
  }
}

function appendRequestLine(obj) {
  if (requestLogBroken) return;
  const date = cnDate();
  if (date !== requestLogDate || !requestLogStream) openRequestLog(date);
  if (!requestLogStream) return;
  try { requestLogStream.write(JSON.stringify(obj) + "\n"); } catch {}
}

// Attach the finish/close bookkeeping to a proxied response. The reqLog holder
// starts with the fields known at clientState creation and is enriched later by
// the readBody callback (model / source / serving profile / usage).
function attachRequestLogger(res, clientState, reqLog) {
  let logged = false;
  const write = (aborted) => {
    if (logged) return;
    logged = true;
    const usage = clientState.lastUsage;
    appendRequestLine({
      t: new Date().toISOString(),
      user: reqLog.user,
      key: reqLog.key,
      ip: reqLog.ip,
      proto: reqLog.proto,
      src: reqLog.src || "",
      model: reqLog.model || "",
      servedModel: (usage && usage.model) || "",
      profile: reqLog.profile || "",
      // 方案组调度：这次请求**按哪个组**选的路由，以及那个组是怎么定下来的
      // （rule=时间规则 / manual=手动指定 / base=基础组）。调度上线后同一用户相邻两次请求
      // 可能落到完全不同的组，只看 profile 无法解释「为什么这次用了火山」。
      // 即使候选全失败也不清空（profile 会被清成 ""），因为「哪个组生效」是有答案的。
      group: reqLog.group || "",
      groupSource: reqLog.groupSource || "",
      client: reqLog.client || "",
      userAgent: reqLog.userAgent || "",
      in: usage ? (usage.usage.input_tokens || 0) : 0,
      out: usage ? (usage.usage.output_tokens || 0) : 0,
      cacheC: usage ? (usage.usage.cache_creation_input_tokens || 0) : 0,
      cacheR: usage ? (usage.usage.cache_read_input_tokens || 0) : 0,
      status: res.statusCode || 0,
      ms: Date.now() - reqLog.start,
      aborted: aborted === true,
    });
  };
  res.on("finish", () => write(false));
  res.on("close", () => { if (!res.writableEnded) write(true); });
}

// Resolve the real upstream key for a profile config (used by the bridge helper
// call which bypasses the normal virtual-key mapping for a synthetic request).
function getRealKeyFromProfile(profileCfg) {
  // Take the first non-empty user key configured on this profile.
  const users = profileCfg.users || {};
  for (const v of Object.values(users)) {
    const k = typeof v === "string" ? v : (v && v.key);
    if (k) return k;
  }
  return "";
}

function sendUpstream(body, reqUrl, reqMethod, reqHeaders, timeout, _rt, clientState) {
  return new Promise((resolve, reject) => {
    try {
      throwIfClientAborted(clientState);
    } catch (err) {
      reject(err);
      return;
    }
    const runtime = _rt || rt;
    const opts = {
      hostname: runtime.upstreamUrl.hostname,
      port: runtime.upstreamUrl.port || (runtime.upstreamUrl.protocol === "https:" ? 443 : 80),
      path: buildUpstreamPath(reqUrl, runtime),
      method: reqMethod,
      headers: reqHeaders,
      agent: runtime.agent,
    };

    const transport = runtime.upstreamUrl.protocol === "https:" ? https : http;
    const upReq = transport.request(opts, (upRes) => {
      const chunks = [];
      upRes.on("data", (c) => chunks.push(c));
      upRes.on("end", () => {
        cleanupUpstream();
        resolve({
          statusCode: upRes.statusCode,
          headers: upRes.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    const cleanupUpstream = setActiveUpstreamRequest(clientState, upReq);

    upReq.setTimeout(timeout, () => {
      upReq.destroy(new Error(`Upstream timeout (${timeout}ms)`));
    });

    upReq.on("error", (err) => {
      cleanupUpstream();
      err.isTimeout = err.message.includes("timeout");
      reject(err);
    });
    upReq.write(body);
    upReq.end();
  });
}

// ─── Settings API Helpers ─────────────────────────────────────────────────────

// ─── 方案组调度：对外状态 ─────────────────────────────────────────────────────
// 北京时间的紧凑时刻标签（"09-15(周一) 09:00"），前端直接显示，不做任何时区换算。
// cnNow 返回的是已 +8 的「伪 UTC」，所以切片即可，与全项目「存储 UTC、展示 +8」同一手法。
function formatScheduleMoment(date) {
  const iso = cnNow(date.getTime()).toISOString();
  return `${iso.slice(5, 10)}(${DAY_LABELS[beijingDayOfWeek(date)]}) ${iso.slice(11, 16)}`;
}

// 设置页与首屏共用的调度状态。**服务端一个实现，前端不复刻匹配逻辑** ——
// 否则两份判定必然漂移（现成的教训：nowInPeakHours vs isInPeakHours）。
function buildScheduleState() {
  const now = new Date();
  const out = { protocols: {} };
  for (const proto of ["anthropic", "responses"]) {
    const baseGroup = proto === "responses"
      ? (Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup : [])
      : (Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : []);
    const groups = {};
    // 分桶存储：本协议的桶直接就是这张表，无需再按 protocol 过滤。
    for (const [name, g] of Object.entries((config.scheduleGroups || {})[proto] || {})) {
      if (!g || typeof g !== "object") continue;
      // protocol 必须留着：describeScheduleHealth 按它过滤，前端也按它分区段渲染。
      // 少了这个字段，health 会把每个组都当成「不存在」，于是每条规则都被报成
      // unknown_group —— 一个永久误报的警告，比不报还糟。
      groups[name] = { protocol: proto, members: Array.isArray(g.members) ? g.members.slice() : [] };
    }
    const rules = Array.isArray((config.scheduleRules || {})[proto]) ? config.scheduleRules[proto] : [];
    const override = (config.scheduleOverride || {})[proto] || null;
    const active = resolveRequestGroup(proto, now);
    const health = describeScheduleHealth({ groups, rules, override }, proto);
    let overrideAlive = false;
    let overrideUntilLabel = "";
    if (override && Number.isFinite(Date.parse(override.expiresAt)) && Date.parse(override.expiresAt) > now.getTime()) {
      overrideAlive = true;
      overrideUntilLabel = formatScheduleMoment(new Date(Date.parse(override.expiresAt)));
    }
    // 「下次切换」= 下一个会真正改变生效组的时刻。手动指定期间它的到期时刻就是按定义算出来的
    // 那个边界，所以直接报到期时刻更诚实（也解释了「为什么是那个点」）。
    let next = null;
    if (overrideAlive) {
      next = { at: overrideUntilLabel, group: BASE_GROUP_TOKEN, reason: "override_expire" };
    } else {
      const b = nextScheduleBoundary(rules, now);
      if (b) next = { at: formatScheduleMoment(new Date(now.getTime() + b.deltaMs)), group: b.group, reason: "rule" };
    }
    out.protocols[proto] = {
      baseGroup: baseGroup.slice(),
      groups,
      rules,
      ruleSummaries: rules.map(r => formatScheduleRuleSummary(r)),
      // 每条规则当前是否命中（同一份判定，前端只渲染不判断）
      ruleMatched: rules.map(r => !!matchesScheduleRule(r, now)),
      active: {
        group: active.groupName, source: active.source, ruleIndex: active.ruleIndex,
        members: active.members.slice(), head: active.members[0] || null,
        ruleSummary: active.rule ? formatScheduleRuleSummary(active.rule) : "",
      },
      next,
      override: overrideAlive ? { group: override.group, expiresAt: override.expiresAt, at: override.at || "", by: override.by || "", untilLabel: overrideUntilLabel } : null,
      health,
    };
  }
  return out;
}

function getPublicSettings() {
  const globalUsers = {};
  for (const [k, v] of Object.entries(config.users || {})) {
    globalUsers[k] = {
      username: v.username || "",
      expiresAt: v.expiresAt || "",
      disabled: !!v.disabled,
      superUser: !!(v.superUser || v.admin),
    };
  }
  const profileAssignments = {};
  for (const profile of listProfiles()) {
    const rawUsers = config.profiles[profile.name]?.users || {};
    profileAssignments[profile.suffix] = {};
    for (const [k, v] of Object.entries(rawUsers)) {
      const isObj = typeof v === "object" && v !== null;
      profileAssignments[profile.suffix][k] = {
        key: isObj ? (v.key || "") : (typeof v === "string" ? v : ""),
        disabled: isObj ? !!v.disabled : false,
      };
    }
  }
  const defaultSuffix = getDefaultProfileSuffix();
  const defaultProfile = config.profiles[getDefaultProfileName()];
  const defaultPool = getPoolForSuffix(defaultSuffix);
  return {
    upstream: defaultProfile?.upstream || "",
    proxy: { ...gProxy },
    allowedModels: defaultProfile?.allowedModels || [],
    modelAliases: getConfigurableModelAliases(defaultProfile || {}),
    peakModelAliases: normalizeModelAliases(defaultProfile?.peakModelAliases || {}),
    profileUsers: profileAssignments[defaultSuffix] || {},
    profileAssignments,
    globalUsers,
    activeProfile: getDefaultProfileName(),
    profiles: listProfiles(),
    quotaPools: listQuotaPools(),
    defaultProfileGroup: Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : [],
    responsesProfileGroup: Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup : [],
    selectedProfileSuffix: defaultSuffix,
    circuitBreaker: rt?.breaker?.status() || { state: "UNKNOWN", failureCount: 0, totalSuccesses: 0, totalFailures: 0, cooldownRemaining: 0 },
    port: port,
    hasPassword: !!dashboardPassword,
    profileQuota: getPoolQuota(defaultPool.name),
    autoQuotaAdjust: config.autoQuotaAdjust || {},
    checkIn: config.checkIn || {},
    quotaRequest: config.quotaRequest || {},
    // 首屏与 GET /api/schedule 同源：页面加载时不必再发一次请求就能画出「当前生效」。
    // 调度配置坏掉不该连带打不开设置页 —— 退化成「无调度」，而不是让 getPublicSettings 抛。
    schedule: (() => {
      try { return buildScheduleState(); }
      catch (err) {
        console.warn(`[SCHEDULE] 生成调度状态失败，设置页退化为空调度: ${err.message}`);
        return { protocols: {} };
      }
    })(),
    // 代码评审：只下发脱敏信息（凭据 → hasCredential + 尾部提示），明文永不离开服务端
    codeReview: (() => {
      const c = config.codeReview || sanitizeCodeReviewConfig({}, port);
      return {
        enabled: !!c.enabled,
        ocrPath: c.ocrPath || "",
        workspaceDir: c.workspaceDir || "",
        perRepoDiskLimitMB: c.perRepoDiskLimitMB,
        maxParallelJobs: c.maxParallelJobs,
        defaultTimeoutMinutes: c.defaultTimeoutMinutes,
        defaultConcurrency: c.defaultConcurrency,
        defaultMaxTokensBudget: c.defaultMaxTokensBudget,
        dailyTokenBudget: c.dailyTokenBudget,
        runRetentionDays: c.runRetentionDays,
        keepRunsPerRepo: c.keepRunsPerRepo,
        storeComments: c.storeComments !== false,
        notifyOn: c.notifyOn || "always",
        providerProfile: c.providerProfile || "",
        providerName: c.providerName,
        providerUrl: c.providerUrl,
        providerProtocol: c.providerProtocol,
        providerModel: c.providerModel || "",
        providerKeyMasked: c.providerKey ? `${String(c.providerKey).slice(0, 8)}****` : "",
        hasProviderKey: !!c.providerKey,
        // Webhook 密钥**明文**下发(破例于其它凭据):它是管理员必须复制去 GitLab/GitHub/Gitee
        // 平台的运维凭据 —— 只给掩码的话,生成保存后就再也无法从界面拿到,只能上服务器翻
        // config.json。端点本身 checkAuth 管理员专属,与 config.json 同一信任级别;
        // providerKey 仍只出掩码:那是网关内部用的,从不需要人来抄。
        webhookSecret: c.webhookSecret || "",
        hasWebhookSecret: !!c.webhookSecret,
        webhookDebounceSeconds: c.webhookDebounceSeconds ?? 300,
        background: c.background || "",
        exclude: Array.isArray(c.exclude) ? c.exclude : [],
        // members(每个仓库的成员名单)是「谁能触发/查看这个仓库」的唯一依据,随 repos 下发;
        // 与设置页其它成员 Key 同口径下发明文(该接口本来就要 checkAuth 管理员),界面自行掩码。
        // 评审可选方案:供「评审方案 / 评审模型」两个下拉使用。hasRealKey 用来提示
        // 「该方案还没分配真实 Key,评审会拿不到凭证」。
        profiles: listProfiles().map((p) => {
          const raw = config.profiles[p.name] || {};
          return {
            name: p.name, suffix: p.suffix, protocol: p.protocol,
            aliases: Object.keys(raw.modelAliases || {}),
            allowedModels: Array.isArray(raw.allowedModels) ? raw.allowedModels : [],
            hasRealKey: Object.values(raw.users || {}).some((u) => (typeof u === "object" ? u.key : u)),
          };
        }),
        repos: (c.repos || []).map((r) => ({
          id: r.id, name: r.name, source: r.source, url: r.url, localPath: r.localPath, branch: r.branch,
          authType: r.authType, username: r.username, enabled: r.enabled, apiTrigger: r.apiTrigger,
          pushTrigger: !!r.pushTrigger,
          members: Array.isArray(r.members) ? r.members : [],
          schedule: r.schedule, overrides: r.overrides, createdAt: r.createdAt,
          credential: maskCredential(r.credential),
        })),
      };
    })(),
  };
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

// 图片识别桥接(lib/vision-bridge.mjs)依赖注入对象。stmts 在 initDb 阶段重新赋值，
// 必须用 getter 延迟读取；config 与发送上游相关的函数为稳定绑定，按值捕获即可。
const VISION_DEPS = {
  config,
  getRealKeyFromProfile,
  sendUpstream,
  get stmts() { return stmts; },
};
const visionApi = createVisionBridge(VISION_DEPS);

// 页面 HTML 壳函数（lib/pages.mjs）的依赖注入对象。stmts 在 initDb 阶段重新赋值，
// 必须用 getter 延迟读取；其余为稳定绑定，按值捕获即可。
const PAGE_DEPS = {
  get config() { return config; },
  get stmts() { return stmts; },
  assets,
  CSRF_TOKEN,
  getPublicSettings,
  getDefaultProfileSuffix,
  normalizeProfileProtocol,
  formatModelAliasesInput,
  ibCacheRows: visionApi.ibCacheRows,
};

// Codex 一键接入脚本构建器（lib/codex-setup-script.mjs）的依赖注入对象。
const CODEX_DEPS = { config, canUseProfile, runtimes };

// 我的用量页内「配置 Codex」分区所需的服务端数据:是否分配了 Responses 方案 +
// 模型目录。口径与 /setup 路由一致;invalid 场景在该页不存在(渲染前 Key 已验证)。
function personalCodexExtras(vk) {
  const hasResp = getAccessibleProfiles(vk).some(p => p.protocol === "responses");
  return {
    noProfile: !hasResp,
    catalog: hasResp ? buildCodexModelCatalog(CODEX_DEPS, vk) : null,
  };
}

// Claude Code 一键接入脚本构建器（lib/claude-setup-script.mjs）的依赖注入对象。
// 与 CODEX_DEPS 同形但独立命名：两边将来各自加依赖是常态，共用一个对象会让
// 「给 codex 加依赖」静默变成「给 claude 也加」。
const CLAUDE_DEPS = { config, canUseProfile, runtimes };

// 我的用量页内「配置 Claude Code」分区所需的服务端数据：是否分配了 Anthropic 方案 +
// 该 Key 可用的别名/方案（推荐入口按成员算，见 lib/claude-setup-script.mjs）。
function personalClaudeExtras(vk) {
  const hasAnthropic = getAccessibleProfiles(vk).some(p => p.protocol === "anthropic");
  return {
    noProfile: !hasAnthropic,
    hints: hasAnthropic ? buildAnthropicSetupHints(CLAUDE_DEPS, vk) : null,
  };
}

// 「我的用量」页的代码评审分区:只告诉页面「这个人有没有负责的仓库」,
// 具体数据由 /api/my-review 现拉(与其它分区一致的做法:页面壳不做数据查询)。
function personalReviewExtras(vk) {
  let count = 0;
  try { count = codeReviewApi.reposVisibleTo(vk).length; } catch { count = 0; }
  // 评审通知的定向投递靠邮箱匹配成员 —— 功能启用后,还没填邮箱的成员进页要被
  // 不可关闭的弹窗拦下来补填(填过 member_notify.email 就不再拦)。
  let needEmail = false;
  try { needEmail = !!(config.codeReview || {}).enabled && !(memberNotifyApi.get(vk) || {}).email; } catch { needEmail = false; }
  return { repoCount: count, needEmail };
}

// /api/stats 读模型聚合（lib/stats.mjs）的依赖注入对象。db/stmts 在 initDb
// 阶段才就绪，必须用 getter 延迟读取；其余为稳定绑定，按值捕获即可。
const STATS_DEPS = {
  get db() { return db; },
  get stmts() { return stmts; },
  config,
  runtimes,
  normalizeProfileSuffix,
  normalizeProfileProtocol,
  normalizeModelAliases,
  getProfileModelAliases,
  sanitizeStore,
  getRateLimitInfo,
  getProfileInflight,
  canUseProfile,
  checkTokenQuota,
  listProfiles,
  listQuotaPools,
};
const statsApi = createStatsReader(STATS_DEPS);


// settings 写路径(lib/settings-write.mjs)依赖注入对象。须在工厂内区分按值与 getter:
// initDb 阶段才就绪的(let 声明)用 getter; db 在 resetConfig 重赋值后仍引用旧连接, 故走 getter。
const SETTINGS_DEPS = {
  normalizePeakHours,
  normalizeQuotaRate,
  normalizeCacheReadQuotaRate,
  normalizeModelQuotaRates,
  QUOTA_POOL_NAME_MAX,
  normalizeQuotaPoolName,
  saveConfig,
  normalizeProfileProtocol,
  normalizeProfileSuffix,
  validateProfileSuffix,
  normalizeModelAliases,
  parseModelAliasesInput,
  getDefaultProfileName,
  getProfileNameBySuffix,
  listProfiles,
  reloadAllRuntimes,
  normalizeLegacyImportData: persistenceApi.normalizeLegacyImportData,
  legacyImportHash: persistenceApi.legacyImportHash,
  summarizeLegacyImport: persistenceApi.summarizeLegacyImport,
  setMeta,
  maskAuditKey,
  config,
  dashboardPassword,
  gProxy,
  userConcurrent,
  userRateBucket,
  ipRateBucket,
  get db() { return db; },
  port,
  resolvePoolName,
};
const settingsApi = createSettingsWriter(SETTINGS_DEPS);

// 系统事件通知(lib/notifier.mjs)依赖注入对象。全部稳定绑定, 按值捕获。
const NOTIFIER_DEPS = {
  http,
  https,
  config,
};
const notifierApi = createNotifier(NOTIFIER_DEPS);

// 会员激励(lib/member-rewards.mjs)依赖注入对象。notifierApi 已在上方就绪;
// stmts/db 在 initDb 阶段重新赋值, 用 getter 延迟读取; 其余按值。
const MEMBER_REWARDS_DEPS = {
  config,
  getAccessibleProfiles,
  getPoolForSuffix,
  getGlobalUser,
  checkKeyExpired,
  getUserPoolQuota,
  getPoolQuota,
  recordAudit,
  maskAuditKey,
  notifierApi,
  runtimes,
  get stmts() { return stmts; },
  get db() { return db; },
};
const memberRewardsApi = createMemberRewards(MEMBER_REWARDS_DEPS);

// 个人用量聚合(lib/personal-usage.mjs)依赖注入对象。stmts 在 initDb 阶段重新赋值, 用 getter 延迟读取；其余按值。
const USAGE_DEPS = {
  cnDate,
  isInPeakHours,
  normalizeQuotaRate,
  lookupModelQuotaRate,
  currentQuotaRate,
  nextRateChangeHint,
  totalUsageTokens,
  normalizeProfileSuffix,
  resolveUserKey,
  getUserName,
  getAccessibleProfiles,
  effectiveModelAliases,
  checkTokenQuota,
  getCheckInStatus: memberRewardsApi.getCheckInStatus,
  getQuotaRequestStatus: memberRewardsApi.getQuotaRequestStatus,
  buildUsageHeatmap: memberRewardsApi.buildUsageHeatmap,
  runtimes,
  get rt() { return rt; },
  get stmts() { return stmts; },
  getPoolForSuffix,
};
const usageApi = createUsageReader(USAGE_DEPS);

// 团队排行榜(lib/leaderboard.mjs)依赖注入对象。与 USAGE_DEPS 同规矩:db 与 stmts 都是
// 在 initDb 阶段才被赋值的模块级变量,必须用 getter 让 lib 在调用时读取当前值,
// 而不是在模块加载期解构成 null 快照。
const LEADERBOARD_DEPS = {
  cnDate,
  cnWeekStartDate,
  knownUserKeys,
  productionSummary,
  contextHealth,
  get db() { return db; },
  get stmts() { return stmts; },
};
const leaderboardApi = createLeaderboardReader(LEADERBOARD_DEPS);

// 会话使用情况(lib/sessions.mjs)。同 LEADERBOARD_DEPS 的规矩:db/stmts 用 getter。
// 项目标签与工具聚合都注入 production.mjs 的导出函数 —— 路径解析各只应有一处实现。
const SESSIONS_DEPS = {
  sessionProjectLabels,
  sessionToolStats,
  productionProjects,
  sessionKey,
  knownUserKeys,
  nameOf: (key) => getUserName(key),
  get db() { return db; },
  get stmts() { return stmts; },
};
const sessionsApi = createSessionsReader(SESSIONS_DEPS);

// API 代理核心(lib/proxy-core.mjs)依赖注入对象。必须排在被它引用的工厂实例之后
// (toolPatternApi / visionApi / notifierApi); rt 是会被重新赋值的模块级 let, 用 getter
// 让 lib 在调用时读取当前值, 而非解构成快照。
const PROXY_CORE_DEPS = {
  RateLimitedError,
  acquireProfileInflight,
  applyStickyReorder,
  attachRequestLogger,
  borrowProfileRealKey,
  canUseProfile,
  checkAndRecordRate,
  checkIpRateLimit,
  checkModelAllowed,
  checkTokenQuota,
  classifyInboundPath,
  classifyRateLimit,
  config,
  deleteStickyProfile,
  extractClientSignal,
  extractSessionSignal,
  gProxy,
  getAvailableDefaultProfiles,
  getAvailableResponsesProfiles,
  getClientIp,
  getProfileInflight,
  getRealKey,
  getStickyProfile,
  getUserName,
  handleLocalModelsRequest,
  isSuperUser,
  markRateLimited,
  maskAuditKey,
  mergeUsageCounters,
  modelNotAllowedMessage,
  noteFailoverServed,
  noteGroupSwitch,
  resolveRequestGroup,
  notifierApi,
  port,
  productionEnabled,
  productionTracker,
  quotaErrorDetail,
  quotaExceededMessage,
  readBody,
  recordError,
  recordUsage,
  releaseConcurrency,
  releaseProfileInflight,
  resolveModel,
  resolveProfile,
  resolveResponsesProfile,
  resolveUserKey,
  sanitizeJson,
  secondsUntilNextCnMidnight,
  sendOpenAiError,
  sendUpstream,
  setStickyProfile,
  toolPatternApi,
  tryAcquireConcurrency,
  unsupportedInboundMessage,
  usageHasTokens,
  visionApi,
  get rt() { return rt; },
};
const proxyCoreApi = createProxyCore(PROXY_CORE_DEPS);
const server = http.createServer((req, res) => {
  // Security headers for all responses
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'");
  if (isSecureRequest(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  // 静态页面资源（settings.js 等纯浏览器代码，不含密钥或按请求数据，无需鉴权）。
  // CSP 的 script-src/style-src 'self' 已覆盖；?v= 是内容哈希，改文件后引用 URL 随
  // 重启变化，故可放心强缓存一周。
  if (req.method === "GET" && req.url.split("?")[0].startsWith("/assets/")) {
    const asset = assets.get(req.url.split("?")[0].slice(8));
    if (!asset) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": asset.contentType, "Cache-Control": "public, max-age=604800" });
    res.end(asset.body);
    return;
  }

  // Docsify wiki 使用手册（/wiki/，免登录，见 serveWiki 上方注释）。
  if (req.method === "GET") {
    const wikiPath = req.url.split("?")[0];
    if (wikiPath === "/wiki") { res.writeHead(301, { Location: "/wiki/" }); res.end(); return; }
    if (wikiPath.startsWith("/wiki/")) { serveWiki(wikiPath, res); return; }
  }

  // MCP 端点（/mcp，streamable HTTP，成员虚拟 Key 鉴权，见 handleMcpPost 上方注释）。
  if (req.url.split("?")[0] === "/mcp") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
      res.end(JSON.stringify({ error: "POST only (stateless streamable HTTP)" }));
      return;
    }
    const mcpKey = getApiKey(req);
    if (!getAccessibleProfiles(mcpKey).length) {
      const knownUser = hasGlobalUser(mcpKey);
      res.writeHead(knownUser ? 403 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: knownUser ? "User is not allowed to view any profile." : "认证失败：请提供有效的虚拟Key (Authorization: Bearer jx-...)" }));
      return;
    }
    readBody(req, 100_000).then(buf => {
      handleMcpPost(res, buf, { apiKey: mcpKey, ip: getClientIp(req) });
    }).catch(() => { res.writeHead(413); res.end("Request too large"); });
    return;
  }

  // Auto quota evaluation (once per day)
  try { evaluateAutoQuotaAdjustments(); } catch (e) { console.error("[配额评估] 错误:", e.message); }

  // Login (no auth required)
  if (req.method === "POST" && req.url === "/api/login") {
    const ip = getClientIp(req);
    const rateCheck = checkLoginRate(ip);
    if (!rateCheck.allowed) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(rateCheck.retryAfter) });
      res.end(JSON.stringify({ error: `Too many login attempts. Try again in ${rateCheck.retryAfter}s.`, retryAfter: rateCheck.retryAfter }));
      console.log(`[安全] IP ${ip} 登录被限流，剩余 ${rateCheck.retryAfter}s`);
      return;
    }
    readBody(req, 10_000).then(buf => {
      try {
        const { password } = JSON.parse(buf.toString());
        if (dashboardPassword && timingSafeEqual(password, dashboardPassword)) {
          recordLoginSuccess(ip);
          const secure = isSecureRequest(req) ? "; Secure" : "";
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": [
              `${AUTH_COOKIE}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secure}`,
              `${CSRF_COOKIE}=${CSRF_TOKEN}; Path=/; SameSite=Strict; Max-Age=86400${secure}`,
            ],
          });
          res.end(JSON.stringify({ ok: true }));
          recordAudit("admin", "auth.login", "", `管理员登录成功`, ip);
        } else {
          recordLoginFailure(ip);
          const remaining = checkLoginRate(ip).remaining;
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "wrong password", attemptsRemaining: remaining }));
          console.log(`[安全] IP ${ip} 登录失败，剩余尝试次数: ${remaining}`);
          recordAudit("guest", "auth.login_fail", "", `登录失败（密码错误，剩余尝试 ${remaining} 次）`, ip);
        }
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad request" }));
      }
    }).catch(() => {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "request too large" }));
    });
    return;
  }

  // Logout
  if (req.method === "POST" && req.url === "/api/logout") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": [
        `${AUTH_COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
        `${CSRF_COOKIE}=; Path=/; Max-Age=0`,
      ],
    });
    res.end(JSON.stringify({ ok: true }));
    recordAdminAudit(req, "auth.logout", "", "管理员退出登录");
    return;
  }

  // Settings page (auth required)
  if (req.method === "GET" && req.url.split("?")[0] === "/settings") {
    if (!checkAuth(req)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(loginHtml(PAGE_DEPS));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(settingsHtml(PAGE_DEPS));
    return;
  }

  // Settings API - get current settings
  if (req.method === "GET" && req.url === "/api/settings") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getPublicSettings()));
    return;
  }

  if (req.method === "POST" && req.url === "/api/data-import/preview") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 50_000_000).then((buf) => {
      try {
        const { data } = JSON.parse(buf.toString());
        const preview = settingsApi.getImportPreview(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(preview));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request too large" }));
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/data-import/apply") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 50_000_000).then((buf) => {
      try {
        const payload = JSON.parse(buf.toString());
        if (!['merge', 'replace'].includes(payload.mode)) throw new Error("导入模式必须是 merge 或 replace");
        if (payload.mode === "replace" && (!dashboardPassword || !timingSafeEqual(payload.password || "", dashboardPassword))) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "密码错误" }));
          return;
        }
        const actualHash = persistenceApi.legacyImportHash(payload.data);
        if (!payload.sourceHash || !timingSafeEqual(payload.sourceHash, actualHash)) throw new Error("文件指纹不匹配，请重新预览");
        if (getMeta(`dataImport:${actualHash}`)) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "该文件已经导入" }));
          return;
        }
        const normalized = persistenceApi.normalizeLegacyImportData(payload.data);
        const profileMap = settingsApi.resolveImportProfileMap(normalized, payload.profileMap || {});
        if (payload.mode === "replace") backupDatabaseSync("data-import-replace");
        const tx = db.transaction(() => {
          if (payload.mode === "replace") persistenceApi.clearRequestData();
          persistenceApi.writeLegacyData(normalized, profileMap);
          stmts.upsertMeta.run({ k: `dataImport:${actualHash}`, v: new Date().toISOString() });
        });
        tx();
        const summary = persistenceApi.summarizeLegacyImport(normalized);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, summary }));
        recordAdminAudit(req, "data.import", "", `导入旧版数据（${payload.mode === "replace" ? "替换模式" : "合并模式"}）：用户 ${summary.users || 0}、请求 ${summary.requests || 0}、记录 ${summary.records || 0}`);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request too large" }));
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/data-clear") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 10_000).then((buf) => {
      try {
        const { password } = JSON.parse(buf.toString());
        if (!dashboardPassword || !timingSafeEqual(password || "", dashboardPassword)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "密码错误" }));
          return;
        }
        backupFileSync(configPath, "config.json", "data-clear");
        backupDatabaseSync("data-clear");
        const previousConfig = JSON.parse(JSON.stringify(config));
        const tx = db.transaction(() => {
          persistenceApi.clearRequestData();
          settingsApi.resetConfigToUnconfiguredState();
          try {
            saveConfig(config);
          } catch (err) {
            for (const key of Object.keys(config)) delete config[key];
            Object.assign(config, previousConfig);
            throw err;
          }
        });
        tx();
        settingsApi.clearInMemoryRequestState();
        reloadAllRuntimes();
        console.log("[DATA] All configuration and request data cleared");
        // Audit before the ack: a destructive op must be on record by the time the
        // caller is told it succeeded (recordAudit is fully guarded and cannot throw).
        recordAdminAudit(req, "data.clear", "全局", "清空全部数据（方案、用户、密钥、配额、统计、错误），已自动备份；审计日志保留");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request too large" }));
    });
    return;
  }

  // Settings save (form POST from settings page)
  if (req.method === "POST" && req.url === "/api/settings-save") {
    if (!checkAuth(req)) {
      // Browser form navigation: land on /settings, which renders the login
      // page when unauthenticated, instead of a dead-end raw text response.
      res.writeHead(302, { "Location": "/settings" });
      res.end();
      return;
    }
    readBody(req).then(buf => {
      try {
        const body = buf.toString();
        if (!checkCsrf(req, body)) {
          // Token missing or mismatched. Re-render settings with a banner
          // rather than raw text so the browser doesn't strand the user here.
          res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
          res.end(settingsHtml(PAGE_DEPS, "保存失败: 安全校验未通过，本次修改未保存，请刷新页面后重新填写并保存"));
          return;
        }
        const formData = settingsApi.parseFormBody(body);
        const auditSnap = settingsApi.settingsAuditSnapshot();
        settingsApi.applySettings(formData);
        const auditDiff = settingsApi.settingsAuditDiff(auditSnap, settingsApi.settingsAuditSnapshot());
        recordAdminAudit(req, "settings.save", auditDiff.target, `保存设置（设置页表单）${auditDiff.text ? "，变更: " + auditDiff.text : "（无实际变化）"}`);
        res.writeHead(302, { "Location": "/settings?saved=1" });
        res.end();
      } catch (err) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(settingsHtml(PAGE_DEPS, "保存失败: " + err.message));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Restrict-direct-access toggle (限制直连): instant save from the settings
  // page checkboxes. They live outside both settings forms, so the form route
  // no longer carries the field — this endpoint is the only writer besides
  // applySettings (which now applies it only when a form actually submits it).
  if (req.method === "POST" && req.url === "/api/restrict-group-suffix") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 10_000).then((buf) => {
      try {
        const { on } = JSON.parse(buf.toString());
        config.restrictGroupSuffix = !!on;
        saveConfig(config);
        recordAdminAudit(req, "settings.restrict_suffix", "全局", on ? "开启限制直连（默认组仅允许 /v1、/v1/responses 入口）" : "关闭限制直连（默认组允许直连 /<suffix>/... 访问）");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request too large" }));
    });
    return;
  }

  // ─── 方案组调度 API ─────────────────────────────────────────────────────────
  // 全部照 /api/restrict-group-suffix 的先例：表单外 + JSON 即时保存 + 自己的审计。
  // 有意不走 applySettings 白名单 —— 否则「保存任意一个方案的设置」会顺带写一遍**全局**调度
  // 配置（lib/settings-write.mjs:250 的注释正是在警告这种跨域污染），而且规则引用 profile 名，
  // 表单快照式提交会把改名前的旧名字一起提交回来。
  // 生效时机是**落盘即生效，不 reload**：resolveRequestGroup 按请求求值（照 effectiveModelAliases
  // 的既有范式），所以跨过时间边界不需要重启，reloadAllRuntimes 的代价则真实而收益为零。

  if (req.method === "GET" && req.url === "/api/schedule") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    // 同样先算 body 再写头：buildScheduleState 抛错时必须是干净的 500，而不是
    // 「已发头 → 再写头 → 未捕获异常」把进程带走。
    let body;
    try { body = JSON.stringify({ ok: true, ...buildScheduleState() }); }
    catch (err) {
      console.warn(`[SCHEDULE] 生成调度状态失败: ${err.message}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "调度状态生成失败" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }

  // 组：整体替换。决策⑦ 的两个入口都必须拦 —— 显式删除与「整体替换时省掉某个组」是同一件
  // 事的两个入口，只拦前者会留一个静默删组的洞。
  if (req.method === "POST" && req.url === "/api/schedule/groups") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 100_000).then(buf => {
      try {
        const { protocol, groups } = JSON.parse(buf.toString());
        const proto = normalizeProfileProtocol(protocol);
        if (!groups || typeof groups !== "object" || Array.isArray(groups)) throw new Error("groups 必须是「组名 → 方案名数组」的对象");
        const next = {};
        for (const [rawName, rawMembers] of Object.entries(groups)) {
          const name = normalizeScheduleGroupName(rawName);   // 抛中文错：空/过长/以 @ 开头
          if (next[name]) throw new Error(`方案组 "${name}" 重复`);
          if (!Array.isArray(rawMembers)) throw new Error(`方案组 "${name}" 的成员必须是方案名数组`);
          const members = [];
          for (const m of rawMembers) {
            if (typeof m !== "string" || !m.trim()) continue;
            const member = m.trim();
            if (!config.profiles[member]) continue;   // 成员不存在 → 静默剪掉（照 /api/profile/default-group 的约定）
            if (normalizeProfileProtocol(config.profiles[member].protocol) !== proto) {
              throw new Error(`方案 "${member}" 不是 ${proto} 协议方案，不能加入调度组 "${name}"`);
            }
            if (!members.includes(member)) members.push(member);
          }
          if (members.length === 0) throw new Error(`方案组 "${name}" 至少需要 1 个方案`);
          next[name] = { protocol: proto, members };
        }
        // 决策⑦：这次替换会让某个「正被规则引用」的组消失 → 整体拒绝。
        const referenced = new Set();
        for (const r of (Array.isArray((config.scheduleRules || {})[proto]) ? config.scheduleRules[proto] : [])) {
          if (r && typeof r.group === "string" && r.group !== BASE_GROUP_TOKEN) referenced.add(r.group);
        }
        const gone = [...referenced].filter(n => !next[n]);
        if (gone.length) {
          const counts = gone.map(n => `"${n}"（${config.scheduleRules[proto].filter(r => r && r.group === n).length} 条）`);
          throw new Error(`方案组 ${counts.join("、")} 正被时间规则引用，请先修改或删除这些规则`);
        }
        // 其它协议的组在**各自的桶里**，与本协议保存天然互不干扰 —— 分桶前的扁平表在这里
        // 用「保留其它协议 + 展开本次提交」合并，同名组被 spread 顺序静默覆盖（根因）。
        if (!config.scheduleGroups || typeof config.scheduleGroups !== "object" || Array.isArray(config.scheduleGroups)) config.scheduleGroups = {};
        if (!config.scheduleGroups[proto] || typeof config.scheduleGroups[proto] !== "object") config.scheduleGroups[proto] = {};
        config.scheduleGroups[proto] = next;
        saveConfig(config);
        resetFailoverTracking();
        recordAdminAudit(req, "schedule.groups", `${proto} 组`, `设置${proto === "responses" ? "OpenAI (Responses)" : "Anthropic"}调度组：${Object.entries(next).map(([n, g]) => `${n}[${g.members.join(" → ")}]`).join("，") || "（空）"}`);
        const body = JSON.stringify({ ok: true, ...buildScheduleState() });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request too large" }));
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/schedule/groups/delete") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 10_000).then(buf => {
      try {
        const { protocol, name } = JSON.parse(buf.toString());
        // 分桶后组名只在本协议内唯一，必须带协议定位（两协议同名组并存是合法状态）。
        const proto = normalizeProfileProtocol(protocol);
        const bucket = (config.scheduleGroups || {})[proto] || {};
        const g = bucket[String(name || "")];
        if (!g) throw new Error(`方案组 "${name}" 不存在`);
        const refs = (Array.isArray((config.scheduleRules || {})[proto]) ? config.scheduleRules[proto] : [])
          .filter(r => r && r.group === name).length;
        if (refs > 0) throw new Error(`方案组 "${name}" 正被 ${refs} 条时间规则引用，请先修改或删除这些规则`);
        delete config.scheduleGroups[proto][name];
        saveConfig(config);
        resetFailoverTracking();
        recordAdminAudit(req, "schedule.groups", String(name), `删除调度组 "${name}"（${proto}）`);
        const body = JSON.stringify({ ok: true, ...buildScheduleState() });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/schedule/groups/rename") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 10_000).then(buf => {
      try {
        const { protocol, name, to } = JSON.parse(buf.toString());
        // 分桶后组名只在本协议内唯一，必须带协议定位（两协议同名组并存是合法状态）。
        const proto = normalizeProfileProtocol(protocol);
        if (!config.scheduleGroups || typeof config.scheduleGroups !== "object" || Array.isArray(config.scheduleGroups)) config.scheduleGroups = {};
        if (!config.scheduleGroups[proto] || typeof config.scheduleGroups[proto] !== "object") config.scheduleGroups[proto] = {};
        const g = config.scheduleGroups[proto][String(name || "")];
        if (!g) throw new Error(`方案组 "${name}" 不存在`);
        const newName = normalizeScheduleGroupName(to);
        if (newName === name) throw new Error("新名称与原名相同");
        if (config.scheduleGroups[proto][newName]) throw new Error(`方案组 "${newName}" 已存在`);
        // 同步重写规则里的引用（照 /api/profile/rename 重写组数组的手法）。漏了这一步，
        // 改名会让引用它的规则全部变成指向不存在的组，从而被静默跳过。
        const rules = (config.scheduleRules || {})[proto];
        let touched = 0;
        if (Array.isArray(rules)) {
          for (const r of rules) {
            if (r && r.group === name) { r.group = newName; touched++; }
          }
        }
        // 保序重建，让改名不改变组在对象里的位置（设置页按插入序渲染）。只在**本协议桶内**重建。
        const rebuilt = {};
        for (const [k, v] of Object.entries(config.scheduleGroups[proto])) rebuilt[k === name ? newName : k] = v;
        config.scheduleGroups[proto] = rebuilt;
        // 手动指定若指向该组，一并跟随改名。
        const o = (config.scheduleOverride || {})[proto];
        if (o && o.group === name) o.group = newName;
        saveConfig(config);
        recordAdminAudit(req, "schedule.groups", newName, `调度组 "${name}" 重命名为 "${newName}"${touched ? `，同步更新 ${touched} 条规则引用` : ""}`);
        const body = JSON.stringify({ ok: true, ...buildScheduleState() });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // 规则：整体替换（让设置页的 ↑/↓ 变成一次纯前端重排 + 一次提交）。
  // 逐条严格校验，第一条不合法的用 400 点名「第 N 条」—— 保存这一刻是唯一有人可问的时机。
  if (req.method === "POST" && req.url === "/api/schedule/rules") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 100_000).then(buf => {
      try {
        const { protocol, rules } = JSON.parse(buf.toString());
        const proto = normalizeProfileProtocol(protocol);
        if (!Array.isArray(rules)) throw new Error("rules 必须是数组");
        const groupExists = (name) => {
          const g = ((config.scheduleGroups || {})[proto] || {})[name];
          return !!(g && g.protocol === proto);
        };
        const next = [];
        for (let i = 0; i < rules.length; i++) {
          const n = i + 1;
          const raw = rules[i];
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`第 ${n} 条规则格式非法`);
          const group = typeof raw.group === "string" ? raw.group.trim() : "";
          if (!group) throw new Error(`第 ${n} 条规则缺少方案组`);
          if (group !== BASE_GROUP_TOKEN && !groupExists(group)) throw new Error(`第 ${n} 条规则引用的方案组 "${group}" 不存在`);
          if (raw.days !== null && raw.days !== undefined) {
            if (!Array.isArray(raw.days)) throw new Error(`第 ${n} 条规则的星期必须是数组`);
            if (raw.days.length === 0) throw new Error(`第 ${n} 条规则的星期不能为空`);
            const bad = raw.days.find(d => !(Number.isInteger(d) && d >= 0 && d <= 6) && !(typeof d === "string" && /^[0-6]$/.test(d.trim())));
            if (bad !== undefined) throw new Error(`第 ${n} 条规则的星期取值非法（应为 0-6，0=周日）`);
          }
          const hasStart = raw.start !== null && raw.start !== undefined && raw.start !== "";
          const hasEnd = raw.end !== null && raw.end !== undefined && raw.end !== "";
          if (hasStart !== hasEnd) throw new Error(`第 ${n} 条规则需要同时给出开始与结束时间`);
          if (hasStart) {
            const s = parsePeakTimeMinutes(raw.start), e = parsePeakTimeMinutes(raw.end);
            if (s === null || e === null) throw new Error(`第 ${n} 条规则的时段格式非法（应为 HH:mm）`);
            if (s === e) throw new Error(`第 ${n} 条规则的开始与结束时间相同`);
          }
          const rule = normalizeScheduleRule(raw, () => true);
          if (!rule) throw new Error(`第 ${n} 条规则格式非法`);
          next.push(rule);
        }
        if (!config.scheduleRules || typeof config.scheduleRules !== "object") config.scheduleRules = {};
        config.scheduleRules[proto] = next;
        saveConfig(config);
        recordAdminAudit(req, "schedule.rules", `${proto} 规则`,
          `设置${proto === "responses" ? "OpenAI (Responses)" : "Anthropic"}时间规则（${next.length} 条，首条命中胜）：${next.map(r => formatScheduleRuleSummary(r)).join("；") || "（空，行为与未启用调度一致）"}`);
        const body = JSON.stringify({ ok: true, ...buildScheduleState() });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request too large" }));
    });
    return;
  }

  // 手动指定（决策④）：允许临时覆盖，**到点自动收回**（决策⑥ = 下一个时间边界）。
  if (req.method === "POST" && req.url === "/api/schedule/override") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 10_000).then(buf => {
      try {
        const { protocol, group, action } = JSON.parse(buf.toString());
        const proto = normalizeProfileProtocol(protocol);
        if (!config.scheduleOverride || typeof config.scheduleOverride !== "object") config.scheduleOverride = {};
        if (action === "clear") {
          const prev = config.scheduleOverride[proto];
          delete config.scheduleOverride[proto];
          saveConfig(config);
          if (prev) recordAdminAudit(req, "schedule.override", `${proto} 手动指定`, `取消手动指定（原为 "${prev.group}"，本应在 ${prev.expiresAt} 自动收回）`);
          const body = JSON.stringify({ ok: true, ...buildScheduleState() });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
          return;
        }
        const name = typeof group === "string" ? group.trim() : "";
        if (!name) throw new Error("请选择要指定的方案组");
        if (name !== BASE_GROUP_TOKEN) {
          const g = ((config.scheduleGroups || {})[proto] || {})[name];
          if (!g || g.protocol !== proto) throw new Error(`方案组 "${name}" 不存在或不是 ${proto} 协议组`);
        }
        const rules = Array.isArray((config.scheduleRules || {})[proto]) ? config.scheduleRules[proto] : [];
        const now = new Date();
        // 与「不考虑手动指定时规则会选的组」相同 → 这次指定什么都不会改变，拒绝
        // （否则会给用户一个「我指定了但毫无效果」的假动作）。已存在的手动指定若指向同一个组，
        // 重设它就是**续期**（把到期时刻推到新的下一个边界），这是有意义的，所以不拦。
        const ruleOnly = resolveRequestGroup(proto, now, true);
        if (name === ruleOnly.groupName) {
          throw new Error(`方案组 "${name}" 已是当前生效组，无需手动指定`);
        }
        const boundary = nextScheduleBoundary(rules, now);
        // 规则表里没有任何会变化的边界时，退到下一个北京 00:00 —— **不让它永不过期**：
        // 「到点自动收回」是产品决策，永不回收等于这个机制不存在，只会在某天变成没人记得
        // 为什么生效的幽灵。这也是决策⑥（下一个边界）而非「固定时长」的直接后果。
        const deltaMs = boundary ? boundary.deltaMs : msUntilNextBeijingMidnight(now);
        const expiresAt = new Date(now.getTime() + deltaMs).toISOString();
        // by 只能是 "admin"：仪表盘是**单一共享口令**，没有逐用户身份可记。真正可追溯的
        // 是审计条目里的来源 IP（recordAdminAudit → getClientIp），不是这个字段。
        config.scheduleOverride[proto] = { group: name, expiresAt, at: now.toISOString(), by: "admin" };
        saveConfig(config);
        recordAdminAudit(req, "schedule.override", `${proto} 手动指定`,
          `手动指定生效方案组为 "${name}"（覆盖调度规则），将于 ${formatScheduleMoment(new Date(Date.parse(expiresAt)))} 自动收回${boundary ? `（下一个时间边界）` : "（下一个北京 00:00，当前规则表没有更早的边界）"}`);
        const body = JSON.stringify({ ok: true, ...buildScheduleState() });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Profile: switch (kept for backward compat — now just reloads the specified profile)
  if (req.method === "POST" && req.url === "/api/profile/switch") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { profile } = JSON.parse(buf.toString());
        if (!config.profiles[profile]) throw new Error(`Profile "${profile}" not found`);
        // No longer need exclusive switch — all profiles are always active
        // Just reload its runtime to apply any config changes
        reloadProfileRuntime(profile);
        recordAdminAudit(req, "profile.reload", profile, `重新加载方案 "${profile}" 运行时（兼容端点）`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, profiles: listProfiles() }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Profile: set default entry alias — make this profile the head of its
  // protocol's group (other members kept after it). /v1 and /v1/responses
  // traffic fails over across the matching group.
  if (req.method === "POST" && req.url === "/api/profile/default") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { profile, suffix, protocol } = JSON.parse(buf.toString());
        const name = profile || getProfileNameBySuffix(suffix);
        if (!name || !config.profiles[name]) throw new Error(`Profile "${profile || suffix}" not found`);
        const proto = normalizeProfileProtocol(protocol);
        if (normalizeProfileProtocol(config.profiles[name].protocol) !== proto) {
          throw new Error(`方案 "${name}" 的协议是 ${normalizeProfileProtocol(config.profiles[name].protocol)}，不能设为 ${proto} 组的默认方案`);
        }
        if (proto === "responses") {
          if (!Array.isArray(config.responsesProfileGroup)) config.responsesProfileGroup = [];
          config.responsesProfileGroup = [name, ...config.responsesProfileGroup.filter(n => n !== name)];
        } else {
          if (!Array.isArray(config.defaultProfileGroup)) config.defaultProfileGroup = [];
          config.defaultProfileGroup = [name, ...config.defaultProfileGroup.filter(n => n !== name)];
          for (const [pname, p] of Object.entries(config.profiles)) {
            p.isDefault = pname === config.defaultProfileGroup[0];
          }
        }
        saveConfig(config);
        reloadAllRuntimes();
        resetFailoverTracking();
        recordAdminAudit(req, "profile.default", name, `将方案 "${name}" 设为 ${proto === "responses" ? "OpenAI (Responses)" : "Anthropic"} 协议组的默认入口（组头）`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          defaultProfile: name,
          protocol: proto,
          defaultProfileGroup: config.defaultProfileGroup,
          responsesProfileGroup: config.responsesProfileGroup,
          profiles: listProfiles(),
        }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Profile: set an ordered protocol group (failover chain). The group must be
  // protocol-pure: anthropic profiles for /v1, responses profiles for /v1/responses.
  if (req.method === "POST" && req.url === "/api/profile/default-group") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { group, protocol } = JSON.parse(buf.toString());
        if (!Array.isArray(group)) throw new Error("group must be an array of profile names");
        const proto = normalizeProfileProtocol(protocol);
        const valid = [];
        for (const name of group) {
          if (!config.profiles[name]) continue;
          if (normalizeProfileProtocol(config.profiles[name].protocol) !== proto) {
            throw new Error(`方案 "${name}" 不是 ${proto} 协议方案，不能加入该组`);
          }
          if (!valid.includes(name)) valid.push(name);
        }
        if (proto === "anthropic") {
          if (valid.length === 0) throw new Error("默认方案组至少需要 1 个方案");
          config.defaultProfileGroup = valid;
          for (const [pname, p] of Object.entries(config.profiles)) {
            p.isDefault = pname === valid[0];
          }
        } else {
          // The responses group may stay empty (Codex access then returns 503).
          config.responsesProfileGroup = valid;
        }
        saveConfig(config);
        reloadAllRuntimes();
        resetFailoverTracking();
        console.log(`[PROFILE] ${proto} group set: ${JSON.stringify(valid)}`);
        recordAdminAudit(req, "profile.group_set", `${proto} 组`, `设置${proto === "responses" ? "OpenAI (Responses)" : "Anthropic"}协议 failover 链: ${valid.join(" → ") || "（空）"}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          protocol: proto,
          defaultProfileGroup: config.defaultProfileGroup,
          responsesProfileGroup: config.responsesProfileGroup,
          profiles: listProfiles(),
        }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Profile: save as new
  if (req.method === "POST" && req.url === "/api/profile/save") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { profile, upstream, allowedModels, suffix, modelAliases, billingType, protocol, quotaPool, responsesPath } = JSON.parse(buf.toString());
        const name = (profile || "").trim();
        if (!name) throw new Error("Profile name required");
        if (config.profiles[name]) throw new Error(`方案 "${name}" 已存在`);
        const sfx = validateProfileSuffix(suffix, name);
        const aliases = parseModelAliasesInput(modelAliases);
        const proto = normalizeProfileProtocol(protocol);
        // Models come ONLY from explicit input (API callers) or alias targets —
        // never inherited from the default profile: a new profile usually points
        // at a different upstream, and silently copying the default's model list
        // would 403-or-worse. A bare profile with no aliases serves nothing until
        // the admin configures them, which is the intended create-then-configure flow.
        const models = allowedModels ? allowedModels.split(",").map(s => s.trim()).filter(Boolean) : [];
        for (const m of Object.values(aliases)) {
          if (m && !models.includes(m)) models.push(m);
        }
        const validBilling = ["coding_plan", "token_plan", "on_demand"].includes(billingType) ? billingType : "on_demand";
        const { poolName } = resolveOrCreateQuotaPool(quotaPool, name);
        config.profiles[name] = {
          upstream: upstream || rt?.upstream || "",
          allowedModels: models,
          modelAliases: aliases,
          peakModelAliases: {},
          users: {},
          suffix: sfx,
          protocol: proto,
          isDefault: false,
          responsesPath: proto === "responses" && responsesPath ? String(responsesPath).trim() : undefined,
          billingType: validBilling,
          quotaPool: poolName,
          peakHours: [],
          peakQuotaRate: 1,
          offPeakQuotaRate: 1,
          modelQuotaRates: {},
        };
        saveConfig(config);
        reloadAllRuntimes();
        console.log(`[PROFILE] Created new profile "${name}" (suffix: ${JSON.stringify(sfx)}, protocol: ${proto})`);
        recordAdminAudit(req, "profile.create", name, `新建方案 "${name}"（后缀 /${sfx}，协议 ${proto === "responses" ? "OpenAI Responses" : "Anthropic"}，上游 ${upstream || "继承默认"}${Object.keys(aliases).length ? "" : "，待配置模型别名"}）`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, profile: name, suffix: sfx, protocol: proto }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Profile: delete
  if (req.method === "POST" && req.url === "/api/profile/delete") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { profile } = JSON.parse(buf.toString());
        if (Object.keys(config.profiles).length <= 1) throw new Error("Cannot delete last profile");
        const p = config.profiles[profile];
        if (p && p.isDefault) throw new Error("Cannot delete the default profile");
        // Clean up runtime
        if (p) {
          const suffix = p.suffix || "";
          const oldRt = runtimes[suffix];
          if (oldRt) oldRt.agent.destroy();
          delete runtimes[suffix];
        }
        // Drop the profile from the responses failover group as well.
        if (Array.isArray(config.responsesProfileGroup)) {
          config.responsesProfileGroup = config.responsesProfileGroup.filter(n => n !== profile);
        }
        // 也从全部调度组里剪掉。**组因此变空时保留该组**（由设置页标红「此组没有有效成员」）——
        // 连带把组和引用它的规则一起删掉，会让用户的配置在删一个方案时凭空消失一大块。
        // 规则留着，求值时会被跳过（见 lib/schedule.mjs 的空组继续往下找）。
        // 分桶后两协议各自一桶；两协议可能同名，变空提示要带协议标注。
        const emptiedGroups = [];
        for (const [proto, bucket] of Object.entries(config.scheduleGroups || {})) {
          if (!bucket || typeof bucket !== "object") continue;
          for (const [gname, g] of Object.entries(bucket)) {
            if (!g || !Array.isArray(g.members) || !g.members.includes(profile)) continue;
            g.members = g.members.filter(n => n !== profile);
            if (g.members.length === 0) emptiedGroups.push(`"${gname}"（${proto === "responses" ? "OpenAI" : "Anthropic"}）`);
          }
        }
        // An orphaned pool has no members to draw on it and its limits are dead
        // weight — drop it. A pool still referenced elsewhere is left alone.
        const orphanPool = p && p.quotaPool ? normalizeQuotaPoolName(p.quotaPool) : "";
        if (orphanPool && config.quotaPools[orphanPool]) {
          const stillUsed = Object.values(config.profiles).some(x => x !== p && resolvePoolName(Object.keys(config.profiles).find(n => config.profiles[n] === x)) === orphanPool);
          if (!stillUsed) delete config.quotaPools[orphanPool];
        }
        delete config.profiles[profile];
        saveConfig(config);
        resetFailoverTracking();
        console.log(`[PROFILE] Deleted profile "${profile}"`);
        recordAdminAudit(req, "profile.delete", profile, `删除方案 "${profile}"（后缀 /${p ? p.suffix : "?"}${emptiedGroups.length ? `；调度组 ${emptiedGroups.join("、")} 因此变空，组与引用它的规则保留` : ""}）`);
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Profile: rename. The name is the config key and both failover groups store
  // membership by name, so a rename moves the key and rewrites every reference
  // in one pass. SQLite usage/stats are keyed by suffix and stay untouched.
  if (req.method === "POST" && req.url === "/api/profile/rename") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { profile, name } = JSON.parse(buf.toString());
        const newName = String(name || "").trim();
        if (!config.profiles[profile]) throw new Error(`Profile "${profile}" not found`);
        if (!newName) throw new Error("新名称不能为空");
        if (newName.length > 40) throw new Error("名称过长（最多 40 字）");
        if (newName === profile) throw new Error("名称未变化");
        if (config.profiles[newName]) throw new Error(`方案 "${newName}" 已存在`);
        const p = config.profiles[profile];
        // Move the key in place, preserving the profiles' insertion order.
        const moved = {};
        for (const [k, v] of Object.entries(config.profiles)) moved[k === profile ? newName : k] = v;
        config.profiles = moved;
        // Rewrite group memberships stored by name. 调度组也要重写：漏了这一处，
        // 「重命名方案」会把该方案**静默地**踢出所有调度组（组还在、成员没了），
        // 而规则照旧引用那个组 —— 症状是「到了时间点却没切过去」，很难反查到改名上。
        for (const key of ["defaultProfileGroup", "responsesProfileGroup"]) {
          if (Array.isArray(config[key])) config[key] = config[key].map(n => (n === profile ? newName : n));
        }
        for (const bucket of Object.values(config.scheduleGroups || {})) {
          if (!bucket || typeof bucket !== "object") continue;
          for (const g of Object.values(bucket)) {
            if (g && Array.isArray(g.members)) g.members = g.members.map(n => (n === profile ? newName : n));
          }
        }
        // Auto-pool case: an empty quotaPool means the pool is named after the
        // profile — pin it to the existing pool key so the rename doesn't orphan
        // the old pool and silently create a fresh unlimited one. Pool names and
        // display labels are the pool's own identity and never follow the rename.
        const oldPoolKey = normalizeQuotaPoolName(profile);
        if (!normalizeQuotaPoolName(p.quotaPool)) {
          if (oldPoolKey && config.quotaPools?.[oldPoolKey]) p.quotaPool = oldPoolKey;
        }
        // Carry any in-flight rate-limit cooldown over to the new name.
        if (rateLimitState[profile]) {
          rateLimitState[newName] = rateLimitState[profile];
          delete rateLimitState[profile];
          persistRateLimitState();
        }
        saveConfig(config);
        reloadAllRuntimes();
        resetFailoverTracking();
        console.log(`[PROFILE] Renamed profile "${profile}" → "${newName}"`);
        recordAdminAudit(req, "profile.rename", newName, `方案 "${profile}" 重命名为 "${newName}"（后缀 /${p.suffix || "?"} 不变）`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, oldName: profile, newName }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Profile: clone. 1:1 copy of every config field except users/real keys
  // (always empty) and default/group placement (clone starts unassigned). The
  // clone shares the source's quota pool — the pool is part of the copied info.
  if (req.method === "POST" && req.url === "/api/profile/clone") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { profile } = JSON.parse(buf.toString());
        const src = config.profiles[profile];
        if (!src) throw new Error(`Profile "${profile}" not found`);
        // Name: "<原名>复制", de-duplicated with 复制2/复制3…; keep within the
        // same 40-char cap the rename endpoint enforces.
        let base = profile;
        if (base.length + 2 > 40) base = base.slice(0, 38);
        let newName = `${base}复制`;
        for (let i = 2; config.profiles[newName]; i++) newName = `${base}复制${i}`;
        // Suffix: "<原后缀>-copy", truncated to the 2-20 char rule, de-duplicated
        // with -copy2/-copy3…; fall through stricter truncation as needed.
        const srcSfx = normalizeProfileSuffix(src.suffix) || "copy";
        const srcBase = srcSfx.replace(/-copy\d*$/, "");
        let newSuffix = "";
        outer:
        for (const shorten of [0, 2, 4, 6]) {
          const stem = srcBase.slice(0, Math.max(2, srcBase.length - shorten));
          for (let i = 1; i < 100; i++) {
            const extra = i === 1 ? "-copy" : `-copy${i}`;
            const cand = `${stem}${extra}`.slice(-20);
            if (cand.length < 2) break outer;
            if (!PROFILE_SUFFIX_RE.test(cand) || RESERVED_SUFFIXES.has(cand)) continue;
            if (Object.values(config.profiles).some(p => normalizeProfileSuffix(p.suffix) === cand)) continue;
            newSuffix = cand;
            break outer;
          }
        }
        if (!newSuffix) throw new Error("无法为克隆方案生成可用的 URL 后缀，请手动新建");
        const clone = JSON.parse(JSON.stringify(src));
        clone.users = {};
        clone.isDefault = false;
        clone.suffix = newSuffix;
        config.profiles[newName] = clone;
        saveConfig(config);
        reloadAllRuntimes();
        console.log(`[PROFILE] Cloned profile "${profile}" → "${newName}" (suffix: ${newSuffix})`);
        recordAdminAudit(req, "profile.clone", newName, `复制方案 "${profile}" → "${newName}"（后缀 /${newSuffix}，共享额度池 ${clone.quotaPool || "无"}，不复制用户）`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, profile: newName, suffix: newSuffix }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Profile: export a portable 「方案代码」 for recreating this profile in another
  // environment. Two things are deliberately NOT exported: users (real upstream
  // keys must never leave this box) and quotaPool (the target environment picks
  // its own). Reads the RAW config — never listProfiles(), which injects
  // never-stored defaults, drops toolPatternCompat, and whose quotaPool
  // resolution can create a pool as a side effect of a read.
  if (req.method === "POST" && req.url === "/api/profile/export") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { profile } = JSON.parse(buf.toString());
        const src = config.profiles[profile];
        if (!hasOwnKey(config.profiles, profile)) throw new Error(`Profile "${profile}" not found`);
        const body = JSON.parse(JSON.stringify(src));
        delete body.users;
        delete body.quotaPool;
        // 名称与后缀走信封，不进 profile 体：粘贴回来的那份代码里每个字段只有
        // 一个来源，导入时不必猜哪个说了算。
        delete body.suffix;
        const warnings = [];
        if (/^https?:\/\/[^/?#@]*:[^/?#@]*@/.test(String(body.upstream || ""))) {
          warnings.push("该方案的上游地址里带账号密码（user:pass@host），代码会原样带出，分享前请留意");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          code: {
            codeFormat: PROFILE_CODE_FORMAT,
            codeVersion: PROFILE_CODE_VERSION,
            name: profile,
            suffix: normalizeProfileSuffix(src.suffix),
            profile: body,
          },
          warnings,
        }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Profile: import a 「方案代码」 pasted from another environment. Everything the
  // create endpoint cannot carry (peak windows, every quota rate, context
  // windows, the multimodal map, the image bridge, toolPatternCompat,
  // contextWindow) comes from the code; the visible form fields win where they
  // overlap. The quota pool is never part of the code — the caller picks one.
  if (req.method === "POST" && req.url === "/api/profile/import") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { code, name: rawName, suffix, protocol, upstream, quotaPool, responsesPath } = JSON.parse(buf.toString());
        if (!code || typeof code !== "object" || Array.isArray(code)) throw new Error("方案代码格式不正确：需要一段 JSON 对象");
        if (code.codeFormat !== PROFILE_CODE_FORMAT) throw new Error("不是有效的方案代码（缺少 codeFormat 标记），请粘贴「复制代码」导出的内容");
        if (code.codeVersion !== PROFILE_CODE_VERSION) throw new Error(`方案代码版本不支持（${code.codeVersion}），请用同一版本的「复制代码」重新导出`);
        const src = code.profile;
        if (!src || typeof src !== "object" || Array.isArray(src)) throw new Error("方案代码里没有 profile 内容");
        const name = String(rawName || code.name || "").trim();
        if (!name) throw new Error("方案名称不能为空");
        if (name.length > 40) throw new Error("方案名称过长（最多 40 字）");
        if (UNSAFE_CONFIG_KEYS.has(name)) throw new Error(`方案名称不能是 "${name}"`);
        if (hasOwnKey(config.profiles, name)) throw new Error(`方案 "${name}" 已存在`);
        const sfx = validateProfileSuffix(suffix || code.suffix || name, name);
        const proto = normalizeProfileProtocol(protocol || src.protocol);
        // 上游必填且必须真能解析：空/非法地址会让 createProfileRuntime 里的
        // new URL() 抛错，而 initAllRuntimes 把那个错吞了，结果是一个永不初始化
        // 的"死方案"——没有任何提示。宁可在导入这一步就拦下。也刻意不沿用新建
        // 路径的"留空则继承默认方案"回退：那会把方案悄悄指到另一个上游。
        const up = String(upstream || src.upstream || "").trim();
        if (!/^https?:\/\/[^\s]+/.test(up)) throw new Error("上游 API 地址无效，方案代码可能不完整");
        try { new URL(up); } catch { throw new Error(`上游 API 地址无法解析：${up}`); }
        const aliases = normalizeModelAliases(src.modelAliases || {});
        const peakAliases = normalizeModelAliases(src.peakModelAliases || {});
        // 允许模型列表原样搬（只做去重与剔除非字符串），绝不按别名目标重算：
        // 它是运行期真正读的那一份（checkModelAllowed），而按别名重算是设置表单
        // 的约定。两边都空更危险——空列表在 checkModelAllowed 里等于"放行一切"，
        // 与"复制一份受限方案"的意图正好相反，所以直接拒绝。
        const allowedModels = Array.isArray(src.allowedModels)
          ? [...new Set(src.allowedModels.filter(m => typeof m === "string" && m.trim()).map(m => m.trim()))]
          : [];
        if (allowedModels.length === 0 && Object.keys(aliases).length === 0 && Object.keys(peakAliases).length === 0) {
          throw new Error("方案代码里既没有模型别名也没有允许模型列表，导入后会放行所有模型；请先在源环境把别名配好再导出");
        }
        const warnings = [];
        if (Object.keys(aliases).length === 0) warnings.push("代码里没有模型别名，下次保存该方案设置时必须先配别名（否则保存会被拒绝）");
        const prof = JSON.parse(JSON.stringify(src));
        // 手改过的代码不该能把这几个键带进 config 对象。
        for (const k of ["__proto__", "constructor", "prototype"]) delete prof[k];
        prof.suffix = sfx;
        prof.protocol = proto;
        prof.users = {};
        prof.isDefault = false;
        prof.upstream = up;
        prof.allowedModels = allowedModels;
        prof.modelAliases = aliases;
        prof.peakModelAliases = peakAliases;
        prof.peakHours = normalizePeakHours(prof.peakHours);
        prof.peakQuotaRate = normalizeQuotaRate(prof.peakQuotaRate);
        prof.offPeakQuotaRate = normalizeQuotaRate(prof.offPeakQuotaRate);
        prof.modelQuotaRates = normalizeModelQuotaRates(prof.modelQuotaRates || {});
        prof.cacheReadQuotaRate = normalizeCacheReadQuotaRate(prof.cacheReadQuotaRate);
        prof.modelContextWindows = normalizeNumberMap(prof.modelContextWindows);
        prof.modelMultimodal = normalizeBooleanMap(prof.modelMultimodal);
        prof.imageBridge = normalizeImageBridge(prof.imageBridge);
        prof.billingType = ["coding_plan", "token_plan", "on_demand"].includes(prof.billingType) ? prof.billingType : "on_demand";
        // 垃圾值会让运行期静默失效（createProfileRuntime 里直接归一化它），所以也过一遍。
        prof.toolPatternCompat = toolPatternApi.normalizeToolPatternCompat(prof.toolPatternCompat);
        // 表单字段优先，空则回退代码里的值；anthropic 方案上直接清掉，免得留一个
        // 从 responses 方案带过来的陈旧端点。
        prof.responsesPath = proto === "responses"
          ? normalizeResponsesPath(responsesPath || prof.responsesPath)
          : undefined;
        const { poolName, action } = resolveOrCreateQuotaPool(quotaPool, name);
        prof.quotaPool = poolName;
        config.profiles[name] = prof;
        saveConfig(config);
        reloadAllRuntimes();
        console.log(`[PROFILE] Imported profile code "${name}" (suffix: ${sfx}, protocol: ${proto}, pool: ${poolName}/${action})`);
        recordAdminAudit(req, "profile.import", name, `导入方案代码创建 "${name}"（后缀 /${sfx}，协议 ${proto === "responses" ? "OpenAI Responses" : "Anthropic"}，额度池 ${poolName}（${action === "reused" ? "复用" : "新建"}），不含用户分配，未加入故障转移分组）`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, profile: name, suffix: sfx, protocol: proto, quotaPool: poolName, poolAction: action, warnings }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Settings JSON API for programmatic updates
  if (req.method === "POST" && req.url === "/api/settings") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const updates = JSON.parse(buf.toString());
        const formData = {};
        if (updates.profileName) formData.profileName = updates.profileName;
        if (updates.profileSuffix) formData.profileSuffix = updates.profileSuffix;
        if (updates.upstream) formData.upstream = updates.upstream;
        if (updates.proxy) {
          Object.assign(formData, {
            timeout: updates.proxy.timeout,
            streamTimeout: updates.proxy.streamTimeout,
            maxRetries: updates.proxy.maxRetries,
            retryDelay: updates.proxy.retryDelay,
            retryableStatusCodes: Array.isArray(updates.proxy.retryableStatusCodes) ? updates.proxy.retryableStatusCodes.join(",") : undefined,
            maxConcurrentPerUser: updates.proxy.maxConcurrentPerUser,
            rateLimitPerMinute: updates.proxy.rateLimitPerMinute,
            circuitBreakerFailures: updates.proxy.circuitBreakerFailures,
            circuitBreakerCooldown: updates.proxy.circuitBreakerCooldown,
          });
        }
        if (updates.allowedModels) {
          formData.allowedModels = Array.isArray(updates.allowedModels) ? updates.allowedModels.join(",") : updates.allowedModels;
        }
        if (updates.modelAliases !== undefined) {
          formData.modelAliases = updates.modelAliases;
        }
        if (updates.peakModelAliases !== undefined) {
          // Accept an object or the same "alias=target\n" text format as the form.
          formData.peakModelAliases = typeof updates.peakModelAliases === "object"
            ? formatModelAliasesInput(normalizeModelAliases(updates.peakModelAliases))
            : updates.peakModelAliases;
        }
        if (updates.users) {
          for (const [k, v] of Object.entries(updates.users)) {
            formData["uk_" + k] = k;
            if (typeof v === "string") {
              formData["un_" + k] = v;
              formData["rk_" + k] = k;
            } else {
              formData["un_" + k] = v.username || v.name || "";
              formData["rk_" + k] = v.key || k;
              if (v.expiresAt) formData["ex_" + k] = v.expiresAt;
            }
          }
        }
        const apiAuditSnap = settingsApi.settingsAuditSnapshot();
        settingsApi.applySettings(formData);
        const apiAuditDiff = settingsApi.settingsAuditDiff(apiAuditSnap, settingsApi.settingsAuditSnapshot());
        recordAdminAudit(req, "settings.api", apiAuditDiff.target, `程序化更新设置（POST /api/settings）${apiAuditDiff.text ? "，变更: " + apiAuditDiff.text : "（无实际变化）"}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, settings: getPublicSettings() }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Reset circuit breaker (for a specific profile or all)
  if (req.method === "POST" && req.url.startsWith("/api/circuit-breaker-reset")) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    const url = new URL(req.url, `http://localhost`);
    const profileSuffix = url.searchParams.get("profile") || "";
    const targetRt = runtimes[profileSuffix];
    if (targetRt) {
      targetRt.breaker.reset();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: targetRt.breaker.status(), profile: targetRt.profileName }));
      recordAdminAudit(req, "breaker.reset", targetRt.profileName, `手动重置方案 "${targetRt.profileName}" 的熔断器`);
    } else {
      // Reset all
      for (const r of Object.values(runtimes)) r.breaker.reset();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      recordAdminAudit(req, "breaker.reset", "全局", "手动重置全部方案的熔断器");
    }
    return;
  }

  // Reset rate-limit (quota-exhaustion) state for a profile or all
  if (req.method === "POST" && req.url.startsWith("/api/rate-limit-reset")) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    const url = new URL(req.url, `http://localhost`);
    const profileName = url.searchParams.get("profile") || "";
    if (profileName) {
      clearRateLimited(profileName);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, profile: profileName }));
      recordAdminAudit(req, "ratelimit.reset", profileName, `手动重置方案 "${profileName}" 的限流状态`);
    } else {
      for (const name of Object.keys(rateLimitState)) clearRateLimited(name);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      recordAdminAudit(req, "ratelimit.reset", "全局", "手动重置全部方案的限流状态");
    }
    return;
  }

  // Dashboard page (auth required)
  if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard")) {
    if (!checkAuth(req)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(loginHtml(PAGE_DEPS));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHtml(PAGE_DEPS));
    return;
  }

  // Protected API: stats (supports ?profile=<suffix> and ?profile=all)
  if (req.method === "GET" && (req.url === "/api/stats" || req.url.startsWith("/api/stats?"))) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const url = new URL(req.url, `http://localhost`);
    const profileSuffix = url.searchParams.get("profile") || "all";
    // section:按菜单只取需要的部分(dashboard 懒加载)。**不带 section 时行为与历史一致**
    // —— 多个测试断言完整形状,这条兼容性必须守住。
    //   overview            数据总览(卡片+六图;不含最贵的 profileDailyModels)
    //   profile-daily-models 图表切「按方案」维度时才单独拉
    //   users/clients/detail/profiles/rates/errors  各自菜单
    const SECTION_KEYS = {
      overview: ["users", "daily", "models", "hourly", "dailyModels", "dailyClients", "hourlyModels", "profileDaily", "profiles", "profileView", "protocolView", "upstream"],
      "profile-daily-models": ["profiles", "profileDailyModels"],
      users: ["users", "daily", "profiles", "userQuotaMatrix", "userQuotas", "userQuotaEff", "profileQuota", "profileView", "protocolView"],
      clients: ["users", "dailyClients", "profileView", "protocolView"],
      detail: ["users", "daily", "profileView", "protocolView"],
      profiles: ["profiles", "profileSummaries", "profileView", "protocolView"],
      rates: ["profiles", "modelRateBoard", "profileView", "protocolView"],
      errors: ["errors", "profileView", "protocolView"],
    };
    const sectionParam = url.searchParams.get("section");
    const section = sectionParam && SECTION_KEYS[sectionParam] ? sectionParam : null;
    const keys = section ? new Set(SECTION_KEYS[section]) : null;   // null = 全量
    const want = (k) => !keys || keys.has(k);
    // Optional protocol split for the "all" view: anthropic|responses. Ignored
    // when a specific profile is selected (a profile already belongs to one
    // protocol). Missing/invalid value = current unfiltered behavior.
    const protocolParam = url.searchParams.get("protocol");
    let protocolView = null;
    let protoFilter = null;
    if (profileSuffix === "all" && (protocolParam === "anthropic" || protocolParam === "responses")) {
      protocolView = protocolParam;
      protoFilter = statsApi.protocolSuffixes(protocolParam);
    }
    let data;
    if (profileSuffix === "all") {
      // Aggregate all profiles (optionally narrowed to one protocol)
      const agg = statsApi.getAggregatedStore(protoFilter);
      data = sanitizeStore(agg);
      data.profileView = "all";
      data.protocolView = protocolView;
      // Quota per user across every profile they can use, so the aggregate view
      // answers "who is near their limit" without drilling into each profile.
      data.userQuotaMatrix = statsApi.getUserQuotaMatrix(protoFilter);
    } else {
      const targetSuffix = normalizeProfileSuffix(profileSuffix);
      const targetRt = runtimes[targetSuffix];
      if (targetRt) {
        const s = loadProfileSnapshot(targetSuffix);
        data = sanitizeStore(s);
        data.profileView = targetRt.profileName;
        data.profileSuffix = targetSuffix;
        data.upstream = targetRt.upstream;
        const poolOf = getPoolForSuffix(targetSuffix);
        data.profileQuota = getPoolQuota(poolOf.name);
        data.quotaPool = poolOf.name;
        // 逐用户的配额(每人两条 SQL):只有「用户用量」菜单用得上 —— 其它 section 跳过整轮
        const needQuota = want("userQuotas") || want("userQuotaEff");
        data.userQuotas = {};
        // Effective quota per user (base + today's manual bonus, usage minus
        // reset baseline) so the dashboard quota bar matches what the proxy
        // actually enforces, while usage columns keep the real statistics.
        data.userQuotaEff = {};
        for (const k of needQuota ? Object.keys(targetRt.users) : []) {
          const q = getUserPoolQuota(poolOf.name, k);
          if (q > 0) data.userQuotas[k.slice(0, 8) + "****"] = q;
          const eff = checkTokenQuota(k, targetSuffix, targetRt);
          if (eff.limit > 0) data.userQuotaEff[k.slice(0, 8) + "****"] = { limit: eff.limit, used: eff.used, bonus: eff.bonus || 0, resetApplied: !!eff.resetApplied, rawUsed: eff.rawUsed, discounted: eff.discounted, rate: eff.rate };
        }
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Unknown profile suffix "${profileSuffix}"` }));
        return;
      }
    }
    // Add profile list for dropdown
    if (want("profiles")) data.profiles = listProfiles();
    if (want("profileSummaries")) data.profileSummaries = statsApi.getProfileSummaries();
    // Chart feeds: hourly×model trend (scoped to current profile view) and
    // cross-profile daily aggregates (always all profiles — the profile chart
    // is a cross-profile dimension and must not shrink with the profile filter).
    const scopedSuffix = profileSuffix === "all" ? null : normalizeProfileSuffix(profileSuffix);
    if (want("hourlyModels")) data.hourlyModels = statsApi.loadHourlyModels(scopedSuffix, protoFilter);
    if (want("profileDaily")) data.profileDaily = statsApi.loadProfileDaily(protoFilter);
    // 最贵的一张(最大表的第二次全表扫):只有图表切到「按方案」维度时才拉
    if (want("profileDailyModels")) data.profileDailyModels = statsApi.loadProfileDailyModels(protoFilter);
    // Model rate board: config rates + today's realised cost per profile×model.
    if (want("modelRateBoard")) {
      data.modelRateBoard = statsApi.getModelRateBoard(
        profileSuffix === "all" ? protoFilter : [normalizeProfileSuffix(profileSuffix)]
      );
    }
    // 带 section 时**只留白名单里的键**:构建器(聚合视图/单方案快照)会初始化一堆键,
    // 跳过查询的会留成空对象 —— 与其让前端拿到「存在但为空」的误导性字段,不如裁干净。
    // 不带 section 时 keys 为 null,一个键都不动(兼容护栏)。
    if (keys) for (const k of Object.keys(data)) if (!keys.has(k)) delete data[k];
    sendJson(res, data, req);
    return;
  }

    // Clear errors
  if (req.method === "POST" && req.url === "/api/clear-errors") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    db.prepare("DELETE FROM errors").run();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    recordAdminAudit(req, "errors.clear", "全局", "清空全部错误记录");
    return;
  }

  // Clear sticky-session bindings (admin). Clears all; the next request from any
  // conversation starts again at its protocol's group head.
  if (req.method === "POST" && req.url === "/api/sticky/clear") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    const cleared = stickyBindings.size;
    stickyBindings.clear();
    console.log(`[Sticky] 已手动清除 ${cleared} 条粘性会话绑定`);
    recordAdminAudit(req, "sticky.clear", "全局", `手动清除 ${cleared} 条粘性会话绑定，下一请求从各组头重新开始`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, cleared }));
    return;
  }

  // Clear rate-limit state (admin). Every profile becomes immediately eligible
  // for failover again — the group head can re-take the conversation right away.
  if (req.method === "POST" && req.url === "/api/rate-limit/clear") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    const cleared = Object.keys(rateLimitState).length;
    for (const k of Object.keys(rateLimitState)) delete rateLimitState[k];
    persistRateLimitState();
    console.log(`[RateLimit] 已手动清除 ${cleared} 个方案的限流状态`);
    recordAdminAudit(req, "ratelimit.clear", "全局", `手动清除 ${cleared} 个方案的限流状态，立即恢复参与 failover`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, cleared }));
    return;
  }

  // Clear the image-bridge transcription cache (admin). Global on purpose:
  // descriptions are keyed by the image itself and shared by every profile, so this
  // is the escape hatch when a misconfigured helper model cached garbage.
  if (req.method === "POST" && req.url === "/api/image-bridge/cache/clear") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    let cleared = 0;
    try {
      cleared = stmts.bridgeCacheCount.get().n;
      db.prepare("DELETE FROM image_bridge_cache").run();
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
    console.log(`[图片桥接] 已手动清空 ${cleared} 条图片转述缓存`);
    recordAdminAudit(req, "imagebridge.cache.clear", "全局", `手动清空 ${cleared} 条图片转述缓存，涉及图片下一轮重新识别`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, cleared }));
    return;
  }

  // Quota pool editing: the single write path for pool-level and per-user limits.
  // Kept separate from /api/global-user/save so "who can use a profile" (real key
  // + disable, per profile) and "how much a pool allows" (limits, per pool) each
  // have exactly one home.
  if (req.method === "POST" && req.url === "/api/quota-pool/save") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { pool: poolNameRaw, dailyTokenLimit, users, label } = JSON.parse(buf.toString());
        const poolName = normalizeQuotaPoolName(poolNameRaw);
        const pool = getPoolByName(poolName);
        if (!poolName || !pool) throw new Error(`额度池 "${poolNameRaw || ""}" 不存在`);
        const normLimit = (v) => {
          if (v === null || v === undefined || v === "") return null;
          const n = Number(v);
          return (Number.isFinite(n) && n > 0) ? Math.round(n) : null;
        };

        const prevPoolLimit = pool.dailyTokenLimit ?? null;
        const prevUsers = { ...(pool.users || {}) };
        // Limit only moves when the body carries it — a label-only rename must
        // not silently reset the pool limit (label is display-only; the pool
        // key `name` never changes, so member profiles keep their binding).
        const nextPoolLimit = dailyTokenLimit === undefined ? prevPoolLimit : normLimit(dailyTokenLimit);
        pool.dailyTokenLimit = nextPoolLimit;

        // Display label edit: optional, empty/whitespace keeps the current one.
        let prevLabel = pool.label || poolName;
        let nextLabel = prevLabel;
        if (typeof label === "string" && label.trim()) {
          nextLabel = label.trim().slice(0, QUOTA_POOL_NAME_MAX);
          pool.label = nextLabel;
        }

        const userChanges = [];
        if (users && typeof users === "object") {
          const nextUsers = {};
          for (const [k, v] of Object.entries(users)) {
            const lim = normLimit(v);
            nextUsers[k] = { dailyTokenLimit: lim };
            const prev = prevUsers[k]?.dailyTokenLimit ?? null;
            if (prev !== lim) {
              userChanges.push(`${(config.users?.[k]?.username) || k.slice(0, 8)} ${prev ? prev.toLocaleString() : "不限"} → ${lim ? lim.toLocaleString() : "不限"}`);
            }
          }
          pool.users = nextUsers;
        }

        saveConfig(config);
        reloadAllRuntimes();

        const parts = [];
        if (prevPoolLimit !== nextPoolLimit) parts.push(`池级 ${prevPoolLimit ? prevPoolLimit.toLocaleString() : "不限"} → ${nextPoolLimit ? nextPoolLimit.toLocaleString() : "不限"}`);
        if (prevLabel !== nextLabel) parts.push(`显示名「${prevLabel}」→「${nextLabel}」`);
        if (userChanges.length) parts.push(userChanges.slice(0, 12).join("；") + (userChanges.length > 12 ? ` 等 ${userChanges.length} 项` : ""));
        recordAdminAudit(req, "quotaPool.save", pool.label || poolName, `保存额度池「${pool.label || poolName}」${parts.length ? "：" + parts.join("；") : "（无变化）"}`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, pool: listQuotaPools().find(p => p.name === poolName) }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Create an empty pool — the independent creation entry the 额度池 page needs.
  // An empty pool is a TARGET: create "GLM 套餐池" here, then assign profiles to
  // it from each profile's edit page. Rejected duplicates keep name === label
  // unambiguous (the name doubles as the config key).
  if (req.method === "POST" && req.url === "/api/quota-pool/create") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { label } = JSON.parse(buf.toString());
        const name = normalizeQuotaPoolName(label);
        if (!name) throw new Error("请填写额度池名称");
        if (config.quotaPools[name]) throw new Error(`额度池 "${name}" 已存在`);
        config.quotaPools[name] = { label: name, dailyTokenLimit: null, users: {} };
        saveConfig(config);
        reloadAllRuntimes();
        recordAdminAudit(req, "quotaPool.create", name, `新建额度池「${name}」（空池，待在方案编辑页将方案并入）`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, pool: listQuotaPools().find(p => p.name === name) }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Delete a pool no profile draws from. Pools with members must be vacated
  // first — deleting under live members would silently drop every limit they
  // rely on (resolvePoolName would then also "repair" a dangling reference into
  // a fresh unlimited pool, which is the opposite of what the admin asked for).
  if (req.method === "POST" && req.url === "/api/quota-pool/delete") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { pool: poolNameRaw } = JSON.parse(buf.toString());
        const poolName = normalizeQuotaPoolName(poolNameRaw);
        const pool = getPoolByName(poolName);
        if (!poolName || !pool) throw new Error(`额度池 "${poolNameRaw || ""}" 不存在`);
        const stillUsed = Object.keys(config.profiles).some(p => resolvePoolName(p) === poolName);
        if (stillUsed) throw new Error("仍有方案使用该额度池，请先在方案编辑页将它们移到其他池");
        const limitNote = pool.dailyTokenLimit ? `（含池级上限 ${pool.dailyTokenLimit.toLocaleString()}）` : "";
        const userNote = Object.keys(pool.users || {}).length ? `、${Object.keys(pool.users).length} 人个人配额` : "";
        delete config.quotaPools[poolName];
        saveConfig(config);
        reloadAllRuntimes();
        recordAdminAudit(req, "quotaPool.delete", poolName, `删除空额度池「${pool.label || poolName}」${limitNote}${userNote}——其配置一并移除`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Manual daily quota ops (admin): same-day bonus / reset today's usage baseline.
  // Rows are keyed by Beijing date, so they stop matching at midnight and the
  // permanent dailyTokenLimit is never touched — no revert job needed.
  if (req.method === "POST" && req.url === "/api/quota/daily-op") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { profileSuffix, key, action, amount } = JSON.parse(buf.toString());
        const sfx = normalizeProfileSuffix(profileSuffix);
        const runtime = runtimes[sfx];
        if (!sfx || !runtime) throw new Error(`未知方案 "${profileSuffix}"`);
        if (!key || !runtime.users[key]) throw new Error("该方案下不存在此用户 Key");
        if (!["bonus", "reset", "clear"].includes(action)) throw new Error("action 必须为 bonus | reset | clear");

        // Manual ops act on the POOL the profile draws from — that is where the
        // allowance and the usage both live now. A per-profile bonus would leave
        // the user blocked on the other route into the same plan.
        const poolOf = getPoolForSuffix(sfx);
        const poolName = poolOf.name;
        if (!poolName) throw new Error("该方案未关联额度池");
        const baseLimit = getUserPoolQuota(poolName, key) || getPoolQuota(poolName);
        if (baseLimit <= 0) throw new Error("该用户与额度池均未设置每日配额（当前无限制），无需临时加量或重置");

        const today = cnDate();
        const op = stmts.getQuotaDailyOp.get(poolName, key, today) || { bonus: 0, reset_baseline: 0 };
        // The baseline must be stored in the weighted currency that
        // checkTokenQuota subtracts it from; `todayRaw` is only for the log/audit
        // text so the admin sees both figures. Both are POOLED totals.
        const members = getPoolSuffixes(poolName);
        const todayRow = pooledUsageForQuota(members.length ? members : [sfx], today, key);
        const weightedUsed = todayRow.used, todayRaw = todayRow.raw;
        const now = new Date().toISOString();
        let bonus = op.bonus || 0, baseline = op.reset_baseline || 0, resetTime = op.reset_time || null;
        const userName = getUserName(key, runtime);
        const poolLabel = poolOf.pool?.label || poolName;

        if (action === "bonus") {
          const n = Number(amount);
          if (!Number.isInteger(n) || n < 0 || n > 1e10) throw new Error("amount 必须为 0~100亿 的整数（token 数）");
          bonus = n;
          stmts.insertQuotaAdjustManual.run({
            user: key, username: userName, date: today,
            oldQuota: baseLimit + (op.bonus || 0), newQuota: baseLimit + bonus, time: now,
          });
          stmts.trimQuotaAdjust.run();
          console.log(`[临时额度] ${userName} @${poolLabel} 当日加量 ${(op.bonus || 0).toLocaleString()} → ${bonus.toLocaleString()}（明日自动失效）`);
        } else if (action === "reset") {
          baseline = weightedUsed;
          resetTime = now;
          console.log(`[临时额度] ${userName} @${poolLabel} 今日用量已重置（计权基线 ${weightedUsed.toLocaleString()} / 实际 ${todayRaw.toLocaleString()}，统计数据保留）`);
        } else {
          console.log(`[临时额度] ${userName} @${poolLabel} 已撤销今日全部手工额度操作`);
        }

        if (action === "clear" || (bonus === 0 && baseline === 0)) {
          stmts.deleteQuotaDailyOp.run(poolName, key, today);
        } else {
          stmts.upsertQuotaDailyOp.run({ pool: poolName, key, date: today, bonus, baseline, resetTime, updatedAt: now });
        }
        if (action === "bonus") {
          recordAdminAudit(req, "quota.bonus", `${poolLabel} · ${maskAuditKey(key)}`,
            `设置 ${userName} 当日临时加量：${(op.bonus || 0).toLocaleString()} → ${bonus.toLocaleString()}（基础 ${baseLimit.toLocaleString()}，额度池「${poolLabel}」，明日自动失效）`);
        } else if (action === "reset") {
          recordAdminAudit(req, "quota.reset", `${poolLabel} · ${maskAuditKey(key)}`,
            `重置 ${userName} 今日用量（计权基线 ${weightedUsed.toLocaleString()}${todayRaw !== weightedUsed ? ` / 实际 ${todayRaw.toLocaleString()}` : ""}，额度池「${poolLabel}」，配额恢复满额，统计保留）`);
        } else {
          recordAdminAudit(req, "quota.clear", `${poolLabel} · ${maskAuditKey(key)}`, `撤销 ${userName} 今日全部手工额度操作（额度池「${poolLabel}」）`);
        }

        const quota = checkTokenQuota(key, sfx, runtime);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, quota }));
      } catch (err) {
        console.error("[临时额度] 操作失败:", err.message);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Delete global user
  if (req.method === "POST" && req.url === "/api/global-user/delete") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { key } = JSON.parse(buf.toString());
        if (!key) throw new Error("Key required");
        const deletedUserName = getUserName(key);
        delete config.users[key];
        for (const pname of Object.keys(config.profiles)) {
          delete config.profiles[pname].users[key];
        }
        const tx = db.transaction(() => {
          for (const table of ["users", "usage_daily", "usage_daily_model", "usage_daily_client", "usage_daily_hourly", "usage_hourly_model", "errors", "quota_adjust_history", "quota_daily_ops"]) {
            db.prepare(`DELETE FROM ${table} WHERE user_key=?`).run(key);
          }
          saveConfig(config);
        });
        tx();
        delete userConcurrent[key];
        delete userRateBucket[key];
        reloadAllRuntimes();
        console.log(`[USER] Deleted global user and history: ${key.slice(0, 8)}****`);
        recordAdminAudit(req, "user.delete", maskAuditKey(key), `删除用户 ${deletedUserName}（${maskAuditKey(key)}）及其全部方案分配与历史数据`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // ── 产出质量与洞察(管理 API + 报告导出)──
  if (req.method === "GET" && req.url.startsWith("/api/production/summary")) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    try {
      const { from, to } = rangeFromTo(new URL(req.url, "http://localhost").searchParams.get("range") || "7d");
      const s = productionSummary(db, { from, to });
      s.health = contextHealth(db, { from, to });
      s.range = { from, to };
      // 未读告警按 user 计数(初始 0 再累计 seen=0),供工作区表格末列展示
      s.alertCounts = Object.fromEntries(s.rows.map(r => [r.user_key, 0]));
      for (const a of productionAlerts(db, { from, to })) s.alertCounts[a.user_key] = (s.alertCounts[a.user_key] || 0) + (a.seen ? 0 : 1);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(s));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        // Headers already sent — can't change status, just end the response.
        console.log(`[production-api] 响应已开始但出错: ${err.message}`);
        if (!res.writableEnded) res.end();
      }
    }
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/production/user/")) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    try {
      const u = new URL(req.url, "http://localhost");
      const key = decodeURIComponent(u.pathname.slice("/api/production/user/".length));
      const { from, to } = rangeFromTo(u.searchParams.get("range") || "7d");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ...productionUserDetail(db, key, { from, to }), range: { from, to } }));
    } catch {
      res.writeHead(400); res.end("Bad request");
    }
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/production/projects")) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    try {
      const { from, to } = rangeFromTo(new URL(req.url, "http://localhost").searchParams.get("range") || "7d");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ rows: productionProjects(db, { from, to }) }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        // Headers already sent — can't change status, just end the response.
        console.log(`[production-api] 响应已开始但出错: ${err.message}`);
        if (!res.writableEnded) res.end();
      }
    }
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/production/alerts")) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    try {
      const { from, to } = rangeFromTo(new URL(req.url, "http://localhost").searchParams.get("range") || "7d");
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      // 行附服务端翻译字段 kindLabel/detailText(与导出报告同一套文案),前端只渲染不再自行翻译
      res.end(JSON.stringify({ rows: productionAlerts(db, { from, to }).map(r => ({
        ...r, kindLabel: ALERT_KIND_LABEL[r.kind] || r.kind, detailText: alertDetailText(r.kind, r.detail) })) }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        // Headers already sent — can't change status, just end the response.
        console.log(`[production-api] 响应已开始但出错: ${err.message}`);
        if (!res.writableEnded) res.end();
      }
    }
    return;
  }
  if (req.method === "POST" && req.url === "/api/production/alerts/seen") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 10_000).then(buf => {
      const { id } = JSON.parse(buf.toString() || "{}");
      const n = Number(id);
      // id 为 0 或缺失视为「全部已读」;非 0 按 markAlertSeen 保持原 200/404 语义
      if (Number.isFinite(n) && n !== 0) {
        const changed = markAlertSeen(db, n);
        res.writeHead(changed ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: !!changed }));
      } else {
        db.prepare(`UPDATE production_alerts SET seen=1 WHERE seen=0`).run();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    }).catch(() => { if (!res.headersSent) { res.writeHead(400); res.end("Bad request"); } });
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/production/costs")) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    try {
      const { from, to } = rangeFromTo(new URL(req.url, "http://localhost").searchParams.get("range") || "7d");
      const peakMap = profilePeakHoursMap();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      // 峰时段复用各方案设置;前端徽标按方案展示当前是否在峰内
      const peakProfiles = Object.entries(config.profiles || {}).map(([name, p]) => {
        const hours = normalizePeakHours(p.peakHours);
        return { name, suffix: normalizeProfileSuffix(p.suffix), hours, inPeakNow: isInPeakHours(hours) };
      }).filter(x => x.suffix && x.hours.length);
      res.end(JSON.stringify({
        ...computeCosts(db, config.costRates || DEFAULT_COST_RATES, { from, to, profilePeakHours: peakMap }),
        peak: { enabled: peakProfiles.length > 0, profiles: peakProfiles },
        rateNote: "USD/1M tokens,参考牌价折算,非实际账单",
      }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        // Headers already sent — can't change status, just end the response.
        console.log(`[production-api] 响应已开始但出错: ${err.message}`);
        if (!res.writableEnded) res.end();
      }
    }
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/api/production/report")) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    try {
      const u = new URL(req.url, "http://localhost");
      const { from, to } = rangeFromTo(u.searchParams.get("range") || "7d");
      const html = buildReportHTML({
        summary: productionSummary(db, { from, to }),
        projects: productionProjects(db, { from, to }),
        costs: computeCosts(db, config.costRates || DEFAULT_COST_RATES, { from, to, profilePeakHours: profilePeakHoursMap() }),
        health: contextHealth(db, { from, to }),
        alerts: productionAlerts(db, { from, to }),
        from, to,
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `attachment; filename="production-report-${from}_${to}.html"` });
      res.end(html);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        // Headers already sent — can't change status, just end the response.
        console.log(`[production-api] 响应已开始但出错: ${err.message}`);
        if (!res.writableEnded) res.end();
      }
    }
    return;
  }
  if (req.method === "POST" && req.url === "/api/production/prune") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 10_000).then(buf => {
      const { days } = JSON.parse(buf.toString() || "{}");
      pruneProductionData(db, Number(days) || 90);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }).catch(() => { if (!res.headersSent) { res.writeHead(400); res.end("Bad request"); } });
    return;
  }
  if (req.method === "POST" && req.url === "/api/production/settings") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 200_000).then(buf => {
      const body = JSON.parse(buf.toString() || "{}");
      if (body.productionTracking && typeof body.productionTracking === "object") {
        const p = config.productionTracking || {};
        if (typeof body.productionTracking.enabled === "boolean") p.enabled = body.productionTracking.enabled;
        if (typeof body.productionTracking.storeFilePaths === "boolean") p.storeFilePaths = body.productionTracking.storeFilePaths;
        // 全局成本峰时段(costPeakHours)与项目名归并(projectAliases)已废弃:
        // 前者复用各方案的 peakHours,后者功能整体移除。旧 config 里的遗留键在此物理清除,
        // 读取侧无任何消费方,未保存前也天然被忽略。
        delete p.costPeakHours;
        delete p.projectAliases;
        config.productionTracking = p;
      }
      if (body.costRates && typeof body.costRates === "object") {
        const clean = {};
        // 峰价可留空(null = 回落基础价)或显式 0(峰时段免费);空串/null → null,其余钳到 ≥0
        const peakPrice = (x) => (("" + x === "" || x == null) ? null : Math.max(0, Number(x) || 0));
        for (const [m, r] of Object.entries(body.costRates)) {
          if (!r || typeof r !== "object") continue;
          clean[m] = {
            input: +r.input || 0, output: +r.output || 0, cacheWrite: +r.cacheWrite || 0, cacheRead: +r.cacheRead || 0,
            peakInput: peakPrice(r.peakInput), peakOutput: peakPrice(r.peakOutput),
            peakCacheWrite: peakPrice(r.peakCacheWrite), peakCacheRead: peakPrice(r.peakCacheRead),
          };
        }
        config.costRates = clean;
      }
      saveConfig(config);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }).catch(() => { if (!res.headersSent) { res.writeHead(400); res.end("Bad request"); } });
    return;
  }

  // Audit log query (admin): paginated, newest first, optional category/actor filter.
  if (req.method === "GET" && req.url.startsWith("/api/audit-log")) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const url = new URL(req.url, `http://localhost`);
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "100", 10) || 100));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    const actor = url.searchParams.get("actor") || "";
    const category = url.searchParams.get("category") || "";
    // Every row carries an explicit category since the audit-category
    // migration backfilled history, so one parameterised pair serves all five
    // types. The legacy actor/action-prefix statements stay defined above for
    // compatibility but are no longer the query path here.
    const CATEGORIES = new Set(["admin", "system", "auth", "checkin", "request"]);
    let rows, total;
    if (CATEGORIES.has(category)) {
      rows = stmts.auditPageForCategory.all(category, limit, offset);
      total = stmts.auditTotalForCategory.get(category).c;
    } else if (actor) {
      rows = stmts.auditPageForActor.all(actor, limit, offset);
      total = stmts.auditTotalForActor.get(actor).c;
    } else {
      rows = stmts.auditPage.all(limit, offset);
      total = stmts.auditTotal.get().c;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ rows, total }));
    return;
  }

  // Quota-request list (admin): newest first, optional status filter.
  if (req.method === "GET" && req.url.startsWith("/api/quota-requests")) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const url = new URL(req.url, `http://localhost`);
    const status = url.searchParams.get("status") || "";
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") || "200", 10) || 200));
    const rows = (status === "pending" || status === "handled" || status === "rejected")
      ? stmts.listQuotaRequestsByStatus.all(status, limit)
      : stmts.listQuotaRequests.all(limit);
    const pending = stmts.countPendingQuotaRequests.get().c;
    // Pending rows carry the member's grantable pools so the admin's 发放加量
    // dialog can offer exactly the pools the request can actually benefit.
    const enriched = rows.map(r => ({
      ...r,
      poolLabel: r.pool ? memberRewardsApi.poolLabelOf(r.pool) : "",
      ...(r.status === "pending" ? { pools: memberRewardsApi.getUserPoolNames(r.user_key).map(n => ({ name: n, label: memberRewardsApi.poolLabelOf(n) })) } : {}),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ rows: enriched, pending }));
    return;
  }

  // Quota-request grant (admin): adds a today bonus to the member's pool and
  // marks the request handled in one call, so the admin never has to hop between
  // the request queue and the pool tools for the common path.
  if (req.method === "POST" && req.url === "/api/quota-request/grant") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { id, pool, amount } = JSON.parse(buf.toString());
        const n = Number(amount);
        if (!Number.isInteger(n) || n <= 0 || n > 1e10) throw new Error("amount 必须为 1~100亿 的整数（token 数）");
        const row = stmts.getQuotaRequest.get(id);
        if (!row) throw new Error(`申请 #${id} 不存在`);
        if (row.status !== "pending") throw new Error(`申请 #${row.id} 已处理过`);
        const validPools = memberRewardsApi.getUserPoolNames(row.user_key);
        if (!validPools.includes(pool)) throw new Error(`该成员不在额度池「${memberRewardsApi.poolLabelOf(pool)}」中（可发放：${validPools.map(memberRewardsApi.poolLabelOf).join("、") || "无"}）`);
        const baseLimit = getUserPoolQuota(pool, row.user_key) || getPoolQuota(pool);
        if (baseLimit <= 0) throw new Error(`额度池「${memberRewardsApi.poolLabelOf(pool)}」与该成员均未设置每日配额（当前无限制），加量无意义；请先在额度池管理中设置限额`);
        const today = cnDate();
        const now = new Date().toISOString();
        const tx = db.transaction(() => {
          const op = stmts.getQuotaDailyOp.get(pool, row.user_key, today) || {};
          stmts.upsertQuotaDailyOp.run({ pool, key: row.user_key, date: today,
            bonus: (op.bonus || 0) + n, baseline: op.reset_baseline || 0, resetTime: op.reset_time || null, updatedAt: now });
          stmts.insertQuotaAdjustManual.run({ user: row.user_key, username: row.username, date: today,
            oldQuota: baseLimit + (op.bonus || 0), newQuota: baseLimit + (op.bonus || 0) + n, time: now });
          stmts.trimQuotaAdjust.run();
          stmts.updateQuotaRequest.run({ id: row.id, status: "handled",
            note: `已发放 +${n.toLocaleString()} token 到额度池「${memberRewardsApi.poolLabelOf(pool)}」（当日有效）`, handledAt: now });
        });
        tx();
        recordAdminAudit(req, "request.handle", `${row.username} · #${row.id}`,
          `通过 ${row.username} 的加量申请并发放 +${n.toLocaleString()} token 到额度池「${memberRewardsApi.poolLabelOf(pool)}」（当日临时加量，明日自动失效；理由「${row.reason}」）`, "request");
        console.log(`[加量申请] 已发放：${row.username} +${n.toLocaleString()} @${memberRewardsApi.poolLabelOf(pool)}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => { res.writeHead(413); res.end("Request too large"); });
    return;
  }

  // Quota-request status transition (admin)
  if (req.method === "POST" && req.url === "/api/quota-request/update") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { id, status, note } = JSON.parse(buf.toString());
        const row = memberRewardsApi.updateQuotaRequest(id, status, note);
        const granted = status === "handled";
        recordAdminAudit(req, granted ? "request.handle" : "request.reject",
          `${row.username} · #${row.id}`,
          `${granted ? "已处理" : "驳回"} ${row.username} 的加量申请（理由「${row.reason}」${row.pool ? `，额度池「${memberRewardsApi.poolLabelOf(row.pool)}」` : ""}）${note ? `，备注：${note}` : ""}`,
          "request");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => { res.writeHead(413); res.end("Request too large"); });
    return;
  }

  // Notifier config save (admin)
  if (req.method === "POST" && req.url === "/api/notifier/save") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 20_000).then(buf => {
      try {
        const next = notifierApi.sanitizeNotifierConfig(JSON.parse(buf.toString()));
        // SMTP 密码不回显给前端(表单里是空的),所以「空」= 保留原值,不是清空。
        // 想真正清掉密码就改 config.json —— 与代码评审凭据同款约定。
        if (!next.smtpPass && config.notifier && config.notifier.smtpPass) next.smtpPass = config.notifier.smtpPass;
        config.notifier = next;
        saveConfig(config);
        recordAdminAudit(req, "notifier.save", "全局", `保存通知设置（${next.enabled ? "已启用" : "已停用"}，冷却 ${next.minIntervalSeconds}s，恢复通知 ${next.notifyRecovery ? "开" : "关"}）`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, notifier: next }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request too large" }));
    });
    return;
  }

  // Notifier test (admin): sends a test message using the posted (possibly
  // unsaved) config so the admin can verify channels before saving.
  if (req.method === "POST" && req.url === "/api/notifier/test") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 20_000).then(buf => {
      (async () => {
        try {
          const cfg = notifierApi.sanitizeNotifierConfig(JSON.parse(buf.toString()));
          // 密码不回显的旧页面/旧脚本可能带空密码来测试 —— 认证模式下回填已保存的值,
          // 否则「发送测试」永远拿空密码打服务器(实测阿里企业邮回 524 username or passwd is NULL)。
          // 只在填了账号时回填:留空账号 = 刻意测试匿名发信,不掺已保存的凭据。
          if (!cfg.smtpPass && cfg.smtpUser && config.notifier && config.notifier.smtpPass) cfg.smtpPass = config.notifier.smtpPass;
          const anyChannel = notifierApi.NOTIFY_SENDERS.some((s) => s.enabled(cfg));
          if (!anyChannel) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "请至少填写一个通知渠道" }));
            return;
          }
          const results = await notifierApi.sendNotifierTest(cfg);
          recordAdminAudit(req, "notifier.test", "全局", `测试通知推送：${results.map(r => `${r.channel} ${r.ok ? "成功" : "失败"}`).join("、")}`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, results }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
    }).catch(() => {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request too large" }));
    });
    return;
  }

  // ─── 代码评审（管理员接口；成员级触发接口见 /api/code-review/trigger）────────
  // 约定与其它管理接口一致:checkAuth + 写操作 checkCsrf;凭据只出掩码。
  if (req.url.startsWith("/api/code-review/")) {
    const crUrl = new URL(req.url, "http://localhost");
    const crPath = crUrl.pathname;
    const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    const adminGate = () => {
      if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return false; }
      return true;
    };
    const adminWriteGate = () => {
      if (!adminGate()) return false;
      if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return false; }
      return true;
    };
    const readJsonBody = (limit = 100_000) => readBody(req, limit).then((buf) => JSON.parse(buf.toString() || "{}"));

    // 成员级触发(CI / MCP 用):**虚拟 Key 鉴权**,不是后台 cookie —— 所以排在本块最前,
    // 不能被下面的 adminGate 拦掉。闸门与文案都在 triggerReviewForKey 里,与 MCP 工具共用。
    if (req.method === "POST" && crPath === "/api/code-review/trigger") {
      readJsonBody(10_000).then((body) => {
        const r = triggerReviewForKey(getApiKey(req), body.repo);
        if (r.results) {
          recordAdminAudit(req, "codereview.trigger.api", r.actor,
            `在线触发代码评审（${r.results.map((x) => `${x.repo}#${x.runId ?? "-"}${x.error ? " 失败:" + x.error : ""}`).join("、")}）`);
        }
        if (r.status === 429) {
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(r.body.retryAfter) });
          res.end(JSON.stringify(r.body));
          return;
        }
        json(r.status, r.body);
      }).catch((err) => json(400, { error: err.message }));
      return;
    }

    // Webhook 自动评审(GitLab / GitHub / Gitee 的 push 回调)。**密钥鉴权**,不是管理员
    // cookie —— 回调方是代码托管平台,不可能登录,所以和上面一样排在 adminGate 之前、
    // 不做 CSRF。安全模型:全局密钥(验证「回调确实来自我配过的平台」)× URL 白名单
    // (决定「哪个仓库可以被触发」)。秒回:入队是同步的,评审在后台跑 —— 平台等 2xx,
    // 等久了会重试,重试就是重复触发。
    if (req.method === "POST" && crPath === "/api/code-review/webhook") {
      (async () => {
        const cfg = config.codeReview || {};
        // 1) 认平台:三家的事件头互不冲突。一个都没有 → 400(顺带挡住乱扫的 POST)。
        const h = req.headers;
        const provider = h["x-github-event"] ? "github" : h["x-gitlab-event"] ? "gitlab" : h["x-gitee-event"] ? "gitee" : null;
        if (!provider) { json(400, { error: "缺少平台事件头(x-github-event / x-gitlab-event / x-gitee-event)" }); return; }
        // 2) 原始字节:GitHub 的 HMAC 必须对收到的原始 body 算,JSON 转一道就会错签
        const buf = await readBody(req, 1_000_000);
        // 3) 验密钥(在解析 JSON 之前)。secret 未配置 = 功能整体关闭。
        const secret = String(cfg.webhookSecret || "");
        if (!secret) { console.log(`[代码评审] 收到 ${provider} 回调但 Webhook 密钥未配置,已拒绝`); json(403, { error: "Webhook 未配置" }); return; }
        const sigOk = verifyWebhookSecret(provider, h, secret, buf);
        if (!sigOk) {
          // 只打一行日志、不写审计:这个端点无鉴权可达,被乱打时不能刷爆审计表
          console.log(`[代码评审] ${provider} 回调密钥校验失败(${getClientIp(req)})`);
          json(403, { error: "密钥不匹配" });
          return;
        }
        let body = null;
        try { body = JSON.parse(buf.toString() || "{}"); } catch { json(400, { error: "payload 不是合法 JSON" }); return; }
        // 4) 只认 push;ping(GitHub 建 webhook 时的握手)、Merge Request、tag 等一律 200 忽略
        //    —— 返回非 2xx 会被平台当失败重试、连错多次甚至禁用 webhook。
        const eventName = String(h["x-github-event"] || h["x-gitlab-event"] || h["x-gitee-event"] || "").toLowerCase();
        if (!eventName.startsWith("push")) { json(200, { ignored: "event", event: eventName }); return; }
        const ref = String(body.ref || "");
        if (ref.startsWith("refs/tags/")) { json(200, { ignored: "tag" }); return; }
        const after = String(body.after || "");
        if (/^0+$/.test(after) || body.deleted === true) { json(200, { ignored: "branch-delete" }); return; }
        const branch = ref.replace(/^refs\/heads\//, "");
        if (!isValidBranch(branch)) { json(200, { ignored: "branch", branch: branch.slice(0, 60) }); return; }
        // 5) 仓库匹配:载荷里的 URL 候选归一化后与白名单比对(含 git@ 形态对 https 形态)。
        //    同一个 URL 可以配**多条**白名单(每条一个分支,实现多分支同时监控)——
        //    返回所有命中条目,门禁逐条独立判定:推 dev 只触发配 dev 的那条,
        //    配 main 的条目在分支门禁处被忽略。
        const matched = matchWebhookRepos(body);
        if (!matched.length) { json(200, { ignored: "repo" }); return; }
        // 6) 门禁:功能、仓库、开关、分支 —— 每条命中条目独立过,命中几条触发几条
        if (!cfg.enabled) { json(200, { ignored: "disabled" }); return; }
        const pusher = webhookPusher(body);
        const triggeredRuns = [];
        let lastIgnore = null;
        for (const repo of matched) {
          if (repo.enabled === false) { lastIgnore = { ignored: "disabled" }; continue; }
          if (!repo.pushTrigger) { lastIgnore = { ignored: "push-off" }; continue; }
          if (branch !== repo.branch) { lastIgnore = { ignored: "branch", branch, expect: repo.branch }; continue; }
          // 7) 防抖:同一仓库窗口内只评一次(固定窗口,忽略不续期)。「评审进行中来的 push」
          //    由入队的既有去重合并,这里管的是「刚评完又连推」。按 repo_id 计,多条分支条目互不干扰。
          const windowMs = (Number(cfg.webhookDebounceSeconds) || 0) * 1000;
          if (windowMs > 0) {
            const last = webhookLastPushAt.get(repo.id) || 0;
            if (Date.now() - last < windowMs) { lastIgnore = { ignored: "debounced", seconds: Math.ceil((windowMs - (Date.now() - last)) / 1000) }; continue; }
            webhookLastPushAt.set(repo.id, Date.now());
          }
          // 8) 入队:去重/串行/磁盘/当日预算全部沿用。推送人记进 actor 与 pusher_email。
          const r = codeReviewApi.enqueue(repo.id, {
            trigger: "webhook",
            actor: `推送:${pusher.name || "未知"}`,
            branch,
            pusherEmail: pusher.email || null,
          });
          recordAdminAudit(req, "codereview.webhook", repo.name,
            `Webhook 触发评审（run #${r.runId}，分支 ${branch}${pusher.name ? `，推送人 ${pusher.name}` : ""}${r.deduped ? "，与进行中任务合并" : ""}）`);
          triggeredRuns.push({ runId: r.runId, repo: repo.name, deduped: !!r.deduped, skipped: !!r.skipped });
        }
        if (!triggeredRuns.length) { json(200, lastIgnore || { ignored: "branch" }); return; }
        // 一律 202:对平台而言「这次 push 已被接受」,与进行中任务合并/被预算拦下都属于受理。
        // 单条命中保持原有响应形状(面板/脚本按 runId 取详情);多条命中(多分支白名单)给 runs 数组。
        json(202, triggeredRuns.length === 1
          ? { triggered: true, ...triggeredRuns[0] }
          : { triggered: true, runs: triggeredRuns });
      })().catch((err) => { json(400, { error: err.message }); });
      return;
    }

    if (req.method === "GET" && crPath === "/api/code-review/status") {
      if (!adminGate()) return;
      (async () => {
        // 始终探测:设置页要靠它显示「ocr 是否已安装 / git 版本」来指引配置,
        // 功能没开时同样需要这两条信息(探测只是两个 --version 子进程,管理员接口)
        const probe = await reviewOcrApi.probe();
        json(200, { ...codeReviewApi.status(), ocr: probe, repoStates: codeReviewApi.repoStates() });
      })().catch((err) => json(500, { error: err.message }));
      return;
    }

    if (req.method === "GET" && crPath === "/api/code-review/runs") {
      if (!adminGate()) return;
      const { rows, total } = codeReviewApi.listRuns({
        repoId: crUrl.searchParams.get("repo") || null,
        status: crUrl.searchParams.get("status") || null,
        limit: Number(crUrl.searchParams.get("limit")) || 50,
        offset: Number(crUrl.searchParams.get("offset")) || 0,
      });
      json(200, { rows, total });
      return;
    }

    if (req.method === "GET" && crPath === "/api/code-review/run") {
      if (!adminGate()) return;
      const run = codeReviewApi.getRun(crUrl.searchParams.get("id"));
      if (!run) { json(404, { error: "运行不存在" }); return; }
      json(200, { run, comments: codeReviewApi.listComments(run.id, { limit: Number(crUrl.searchParams.get("limit")) || 200 }) });
      return;
    }

    if (req.method === "POST" && crPath === "/api/code-review/settings") {
      if (!adminWriteGate()) return;
      readJsonBody().then((body) => {
        const next = sanitizeCodeReviewConfig(body, port);
        // 凭据字段为空字符串时保留原值:界面回显的是掩码,不回传就不该被清空
        const prev = config.codeReview || {};
        next.repos = next.repos.map((r, i) => {
          const old = (prev.repos || []).find((x) => x.id === r.id);
          if (old && !r.credential) r.credential = old.credential || "";
          // 成员名单:整表保存的载荷可能不带 members(引擎表单的仓库映射就不带),
          // 缺省时回填原值 —— 否则每点一次「保存代码评审设置」就把所有仓库的成员清空了
          // (实测踩过:成员配好了,保存一次引擎参数,成员全没了)。
          const bodyRepo = Array.isArray(body.repos) ? body.repos[i] : null;
          if (old && bodyRepo && bodyRepo.members === undefined) r.members = old.members || [];
          return r;
        });
        if (!next.providerKey && prev.providerKey) next.providerKey = prev.providerKey;
        // Webhook 密钥同理:界面回显的是掩码,空串 = 不修改
        if (!next.webhookSecret && prev.webhookSecret) next.webhookSecret = prev.webhookSecret;
        // 这几个字段界面没有对应控件(只在 config.json 里手改):载荷里**缺省**时保留原值,
        // 否则管理员每在界面点一次保存,工作区目录就被换回默认、OCR 隔离模式被改回 isolated、
        // 评审背景说明被清空 —— 全是静默的。显式传值(含空串)仍然生效,所以想清回默认做得到。
        for (const k of ["ocrConfigMode", "workspaceDir", "providerName", "background"]) {
          if (body[k] === undefined && prev[k] !== undefined) next[k] = prev[k];
        }
        // 引擎参数与仓库是两块独立的表单:payload 没带 repos 时保留现有仓库,
        // 「只保存引擎设置」不能顺手清空仓库白名单
        if (!Array.isArray(body.repos) && Array.isArray(prev.repos)) next.repos = prev.repos;
        // 端点与协议不由管理员填写:按所选方案推导,且强制回环 —— 避免配出一个
        // 打不到自己(或指向外部)的端点。评审请求必须经本网关才会计入用量。
        applyReviewEndpoint(next);
        config.codeReview = next;
        saveConfig(config);
        recordAdminAudit(req, "codereview.settings", "全局",
          `保存代码评审设置（${next.enabled ? "已启用" : "已停用"}，方案 ${next.providerProfile || "未选"}，仓库 ${next.repos.length} 个，并发 ${next.maxParallelJobs}）`);
        json(200, { ok: true });
      }).catch((err) => json(400, { error: err.message }));
      return;
    }

    if (req.method === "POST" && crPath === "/api/code-review/repos/save") {
      if (!adminWriteGate()) return;
      readJsonBody().then((body) => {
        const next = sanitizeCodeReviewConfig(config.codeReview, port);
        const repo = (sanitizeCodeReviewConfig({ repos: [body.repo || body] }, port).repos || [])[0];
        if (!repo) { json(400, { error: "仓库配置不合法(检查地址协议/分支名)" }); return; }
        const idx = next.repos.findIndex((r) => r.id === repo.id);
        if (idx >= 0) {
          if (!repo.credential) repo.credential = next.repos[idx].credential || "";   // 掩码回显不清空凭据
          repo.createdAt = next.repos[idx].createdAt;
          next.repos[idx] = repo;
        } else {
          next.repos.push(repo);
        }
        config.codeReview = next;
        saveConfig(config);
        recordAdminAudit(req, "codereview.repo.save", repo.name, `保存评审仓库（${repo.source === "remote" ? repo.url : repo.localPath}，分支 ${repo.branch}）`);
        json(200, { ok: true, repo: { ...repo, credential: maskCredential(repo.credential) } });
      }).catch((err) => json(400, { error: err.message }));
      return;
    }

    if (req.method === "POST" && crPath === "/api/code-review/repos/delete") {
      if (!adminWriteGate()) return;
      readJsonBody().then((body) => {
        const id = String(body.id || "");
        const prev = config.codeReview || {};
        const repo = (prev.repos || []).find((r) => r.id === id);
        if (!repo) { json(404, { error: "仓库不存在" }); return; }
        config.codeReview = { ...prev, repos: (prev.repos || []).filter((r) => r.id !== id) };
        saveConfig(config);
        recordAdminAudit(req, "codereview.repo.delete", repo.name, "删除评审仓库定义（工作区目录保留,可在设置页清理磁盘）");
        json(200, { ok: true });
      }).catch((err) => json(400, { error: err.message }));
      return;
    }

    if (req.method === "POST" && crPath === "/api/code-review/repos/test") {
      if (!adminWriteGate()) return;
      readJsonBody().then(async (body) => {
        // 两种入口:①带 id → 测已保存的仓库(表格里的「测试」按钮);②带 repo 对象 →
        // 测「编辑器里当前填的、还没保存」的值,这样填错能当场发现,不用先存再改。
        const in0 = resolveReviewRepoInput(body);
        if (!in0.repo) { json(in0.status, { error: in0.error }); return; }
        const r = await codeReviewApi.testRepo(in0.repo);
        json(200, r);
      }).catch((err) => json(400, { error: err.message }));
      return;
    }

    // 列出仓库分支(供面板「按次选分支」与设置页分支 datalist)。入参同 /repos/test:
    // 支持未保存的表单值,这样刚填完地址就能先看看有哪些分支。
    if (req.method === "POST" && crPath === "/api/code-review/repos/branches") {
      if (!adminWriteGate()) return;
      readJsonBody().then(async (body) => {
        const in0 = resolveReviewRepoInput(body);
        if (!in0.repo) { json(in0.status, { error: in0.error }); return; }
        const r = await codeReviewApi.listBranches(in0.repo);
        json(200, r);
      }).catch((err) => json(400, { error: err.message }));
      return;
    }

    if (req.method === "POST" && crPath === "/api/code-review/runs/start") {
      if (!adminWriteGate()) return;
      readJsonBody().then((body) => {
        try {
          // branch 是**可选的按次覆盖**(面板上的分支下拉):只对本次生效,不写回仓库配置。
          // 它只对单个仓库有意义 —— 「不带仓库 = 触发全部授权仓库」时给不出统一分支。
          const branch = body.branch == null || body.branch === "" ? null : String(body.branch);
          if (branch && !body.repo) { json(400, { error: "指定分支时必须同时指定仓库(不能一次给多个仓库设同一分支)" }); return; }
          const r = codeReviewApi.enqueue(String(body.repo || ""), { trigger: "manual", actor: "admin", branch });
          recordAdminAudit(req, "codereview.run", String(body.repo || ""),
            `手动触发代码评审（run #${r.runId}${r.deduped ? "，与进行中的任务合并" : ""}${branch ? `，分支 ${branch}` : ""}）`);
          json(r.deduped ? 200 : 202, r);
        } catch (err) {
          json(err.statusCode || 400, { error: err.message });
        }
      }).catch((err) => json(400, { error: err.message }));
      return;
    }

    if (req.method === "POST" && crPath === "/api/code-review/runs/cancel") {
      if (!adminWriteGate()) return;
      readJsonBody().then((body) => {
        try {
          const r = codeReviewApi.cancel(Number(body.id));
          recordAdminAudit(req, "codereview.cancel", `run #${body.id}`, `取消代码评审（${r.canceled ? "已取消" : "未取消:" + r.note}）`);
          json(200, r);
        } catch (err) {
          json(err.statusCode || 400, { error: err.message });
        }
      }).catch((err) => json(400, { error: err.message }));
      return;
    }

    // 管理端标记/撤销「已解决」:与成员端同一个状态,谁点都生效。
    if (req.method === "POST" && crPath === "/api/code-review/runs/resolve") {
      if (!adminWriteGate()) return;
      readJsonBody().then((body) => {
        try {
          const run = codeReviewApi.setRunResolved(Number(body.id), body.resolved !== false, "管理员");
          recordAdminAudit(req, "codereview.resolve", `run #${body.id}`, `${run.resolved ? "标记已解决" : "撤销已解决"}`);
          json(200, { ok: true, run: { id: run.id, resolved: !!run.resolved, resolvedAt: run.resolved_at || null } });
        } catch (err) {
          json(err.statusCode || 400, { error: err.message });
        }
      }).catch((err) => json(400, { error: err.message }));
      return;
    }

    // 一键创建评审专用虚拟 Key:明文只在本次响应返回一次;真实上游 Key 由管理员提供
    // (从某方案现有分配里选),因为 canUseProfile 要求该 Key 在某方案下有真实 Key。
    if (req.method === "POST" && crPath === "/api/code-review/key/create") {
      if (!adminWriteGate()) return;
      readJsonBody().then((body) => {
        const profileName = String(body.profile || "");
        if (!profileName || !config.profiles?.[profileName]) { json(400, { error: "请选择评审用哪个方案" }); return; }
        const prof = config.profiles[profileName];
        const realKeys = Object.values(prof.users || {}).filter((u) => (typeof u === "object" ? u.key : u));
        if (!realKeys.length) { json(400, { error: `方案「${profileName}」还没有分配任何真实上游 Key，评审会拿不到凭证` }); return; }
        // 生成专用账号:设为**超级用户**并**不分配真实 Key** —— 运行期由既有的
        // borrowProfileRealKey 向所选方案借用一把真实 Key(超级用户的既有语义),
        // 管理员因此不必在这里再填一遍 API 信息。
        const key = "jx-review-" + crypto.randomBytes(6).toString("hex");
        config.users = config.users || {};
        config.users[key] = { username: body.username || "代码评审", expiresAt: null, disabled: false, superUser: true };
        const next = sanitizeCodeReviewConfig(config.codeReview, port);
        next.providerKey = key;
        next.providerProfile = profileName;
        applyReviewEndpoint(next);
        config.codeReview = next;
        saveConfig(config);
        // runtime.globalUsers 是创建时的快照({..config.users}),新账号必须重载方案
        // 才对代理层可见 —— 否下一次评审报 "Unknown API key"
        reloadAllRuntimes();
        recordAdminAudit(req, "codereview.account.create", profileName, "创建代码评审专用账号（超级用户,借用方案 " + profileName + " 的真实 Key）");
        json(200, { ok: true, key, masked: key.slice(0, 8) + "****" });
      }).catch((err) => json(400, { error: err.message }));
      return;
    }

    // 独立 HTML 报告:自包含单文件,下载后可直接发群/存档(照 /api/production/report 先例)
    if (req.method === "GET" && crPath === "/api/code-review/report") {
      if (!adminGate()) return;
      const run = codeReviewApi.getRun(crUrl.searchParams.get("id"));
      if (!run) { json(404, { error: "运行不存在" }); return; }
      const repo = codeReviewApi.findRepo(run.repo_id) || { name: run.repo_name };
      const html = buildReviewReportHTML({ run, comments: codeReviewApi.listComments(run.id, { limit: 500 }), repo });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Disposition": `attachment; filename="code-review-run-${run.id}.html"` });
      res.end(html);
      return;
    }

    // 自检:一次把「为什么跑不起来」列清(引擎/方案/账号/工作区/每个仓库)。
    // 只探测不修改配置;会起两个 --version 子进程并往工作区写一个探针文件。
    if (req.method === "POST" && crPath === "/api/code-review/selfcheck") {
      if (!adminWriteGate()) return;
      codeReviewApi.selfCheck()
        .then((r) => json(200, r))
        .catch((err) => json(500, { error: err.message }));
      return;
    }

    // 立即清理历史(保留期 + 每仓库条数上限)。默认每天自动跑一次,这里是手动版。
    if (req.method === "POST" && crPath === "/api/code-review/maintenance") {
      if (!adminWriteGate()) return;
      try {
        const r = codeReviewApi.prune();
        recordAdminAudit(req, "codereview.prune", "全局", `清理代码评审历史(删除 ${r.runs} 条运行、${r.files} 个报告文件)`);
        json(200, { ok: true, ...r });
      } catch (err) { json(500, { error: err.message }); }
      return;
    }

    // 清空评审数据(统计+意见+游标,可选连工作区代码一起删)。破坏性操作:照
    // /api/data-clear 的先例 —— 二次密码 + 先备份 + 出口前落审计。
    if (req.method === "POST" && crPath === "/api/code-review/data-clear") {
      if (!adminWriteGate()) return;
      readJsonBody().then((body) => {
        if (!dashboardPassword || !timingSafeEqual(String(body.password || ""), dashboardPassword)) {
          json(401, { error: "密码错误" }); return;
        }
        backupFileSync(configPath, "config.json", "review-clear");
        backupDatabaseSync("review-clear");
        const r = codeReviewApi.clearData({ includeWorkspace: !!body.includeWorkspace });
        recordAdminAudit(req, "codereview.clear", "全局",
          `清空代码评审数据（${r.runs} 条运行、${r.files} 个报告文件${r.workspace ? "、工作区仓库" : ""}），已自动备份`);
        json(200, { ok: true, ...r });
      }).catch((err) => json(400, { error: err.message }));
      return;
    }

    json(404, { error: "unknown code-review endpoint" });
    return;
  }

  // ─── Stats cleanup (remove residual user/model stats only, keep config) ────
  // List all user/model stats rows present in DB, marking orphans (not in config).
  if (req.method === "GET" && req.url.startsWith("/api/stats-cleanup/list")) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const globalKeys = new Set(Object.keys(config.users || {}));
    for (const pname of Object.keys(config.profiles || {})) {
      for (const k of Object.keys((config.profiles[pname] || {}).users || {})) globalKeys.add(k);
    }
    const users = db.prepare(
      `SELECT user_key, MAX(name) AS name, SUM(total_requests) AS requests, MAX(last_active) AS last_active
       FROM users GROUP BY user_key ORDER BY requests DESC`
    ).all().map(r => ({
      key: r.user_key, name: r.name || r.user_key.slice(0, 8),
      requests: r.requests || 0, lastActive: r.last_active || null,
      existsInConfig: globalKeys.has(r.user_key),
    }));
    const models = db.prepare(
      `SELECT model, SUM(tokens) AS tokens, SUM(requests) AS requests
       FROM usage_model GROUP BY model ORDER BY requests DESC`
    ).all().map(r => ({ model: r.model, tokens: r.tokens || 0, requests: r.requests || 0 }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ users, models }));
    return;
  }

  // Delete residual stats for a single user_key (keeps config.json untouched).
  if (req.method === "POST" && req.url === "/api/stats-user/delete") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { key } = JSON.parse(buf.toString());
        if (!key) throw new Error("Key required");
        backupDatabaseSync("stats-user-delete");
        const tx = db.transaction(() => {
          for (const table of ["users", "usage_daily", "usage_daily_model", "usage_daily_client", "usage_daily_hourly", "usage_hourly_model", "errors", "quota_adjust_history", "quota_daily_ops"]) {
            db.prepare(`DELETE FROM ${table} WHERE user_key=?`).run(key);
          }
        });
        tx();
        console.log(`[STATS] Deleted residual stats for user: ${key.slice(0, 8)}****`);
        recordAdminAudit(req, "stats.user_delete", maskAuditKey(key), `删除用户 ${maskAuditKey(key)} 的残留统计数据（已自动备份，配置不动）`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Delete residual stats for a single model (keeps config.json untouched).
  if (req.method === "POST" && req.url === "/api/stats-model/delete") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { model } = JSON.parse(buf.toString());
        if (!model) throw new Error("Model required");
        backupDatabaseSync("stats-model-delete");
        const tx = db.transaction(() => {
          db.prepare("DELETE FROM usage_model WHERE model=?").run(model);
          db.prepare("DELETE FROM usage_daily_model WHERE model=?").run(model);
          db.prepare("DELETE FROM usage_hourly_model WHERE model=?").run(model);
        });
        tx();
        console.log(`[STATS] Deleted residual stats for model: ${model}`);
        recordAdminAudit(req, "stats.model_delete", model, `删除模型 "${model}" 的残留统计数据（已自动备份）`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/global-user/save") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { users, profileUsers, profileSuffix } = JSON.parse(buf.toString());
        if (!Array.isArray(users) || users.length === 0) throw new Error("No users provided");
        const targetSuffix = normalizeProfileSuffix(profileSuffix);
        if (!targetSuffix) throw new Error("profileSuffix is required");
        const prevGlobalUsers = { ...(config.users || {}) };
        const newGlobalUsers = {};
        for (const u of users) {
          if (!u.key) continue;
          newGlobalUsers[u.key] = { username: u.username || u.key.slice(0, 8), expiresAt: u.expiresAt || null, disabled: !!u.disabled, superUser: !!u.superUser };
        }
        config.users = { ...newGlobalUsers };
        // Determine which profile to update users for
        const targetRt = runtimes[targetSuffix];
        if (!targetRt) throw new Error(`Profile suffix "${targetSuffix}" not found`);
        const targetProfileName = targetRt.profileName;
        const prevProfileUsers = { ...((config.profiles[targetProfileName] || {}).users || {}) };
        // Update profile users: real key + disable only. Quota is NOT written here
        // — it belongs to the pool and has its own write path (/api/quota-pool/save).
        let newProfileUsers = null;
        if (Array.isArray(profileUsers)) {
          newProfileUsers = {};
          for (const pu of profileUsers) {
            if (!pu.key) continue;
            newProfileUsers[pu.key] = { key: pu.realKey || "", disabled: !!pu.disabled };
          }
          const ap = config.profiles[targetProfileName];
          if (ap) {
            ap.users = newProfileUsers;
          }
        } else {
          const ap = config.profiles[targetProfileName];
          if (ap) {
            for (const k of Object.keys(newGlobalUsers)) {
              if (!ap.users[k]) ap.users[k] = { key: "", disabled: false };
            }
          }
        }
        saveConfig(config);
        reloadAllRuntimes();
        console.log(`[USER] Saved ${Object.keys(newGlobalUsers).length} global users`);
        // Per-user diff: membership moves and disables — the "who changed whose
        // access" question the audit log exists to answer. Quota changes are logged
        // by /api/quota-pool/save, not here.
        const changes = [];
        if (newProfileUsers) {
          const nameOf = k => (newGlobalUsers[k] || prevGlobalUsers[k] || {}).username || k.slice(0, 8);
          for (const k of new Set([...Object.keys(prevProfileUsers), ...Object.keys(newProfileUsers)])) {
            const a = prevProfileUsers[k] || null, b = newProfileUsers[k] || null;
            if (!a && b) { changes.push(`新增分配 ${nameOf(k)}`); continue; }
            if (a && !b) { changes.push(`移除分配 ${nameOf(k)}`); continue; }
            if (!!a.disabled !== !!b.disabled) changes.push(`${nameOf(k)} 方案内${b.disabled ? "禁用" : "启用"}`);
          }
        }
        const added = Object.keys(newGlobalUsers).filter(k => !prevGlobalUsers[k]).length;
        const removed = Object.keys(prevGlobalUsers).filter(k => !newGlobalUsers[k]).length;
        const disabledGlobal = Object.entries(newGlobalUsers).filter(([k, v]) => v.disabled && !(prevGlobalUsers[k] || {}).disabled).length;
        const suOn = Object.entries(newGlobalUsers).filter(([k, v]) => v.superUser && !((prevGlobalUsers[k] || {}).superUser)).length;
        const suOff = Object.entries(newGlobalUsers).filter(([k, v]) => !v.superUser && ((prevGlobalUsers[k] || {}).superUser)).length;
        const parts = [];
        if (added) parts.push(`新增用户 ${added} 名`);
        if (removed) parts.push(`删除用户 ${removed} 名`);
        if (disabledGlobal) parts.push(`全局禁用 ${disabledGlobal} 名`);
        if (suOn) parts.push(`设为超级用户 ${suOn} 名`);
        if (suOff) parts.push(`取消超级用户 ${suOff} 名`);
        if (changes.length) parts.push(changes.slice(0, 12).join("；") + (changes.length > 12 ? ` 等 ${changes.length} 项变更` : ""));
        recordAdminAudit(req, "user.save", `/${targetSuffix}`, `保存用户管理（方案 /${targetSuffix}）：${parts.length ? parts.join("；") : "无实质变化"}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Codex one-click setup pages (member self-service)
  if (req.method === "GET" && (req.url === "/setup" || req.url.startsWith("/setup/"))) {
    const vk = req.url === "/setup" ? "" : decodeURIComponent(req.url.slice(7).split("?")[0]);
    let state = "ok";
    let catalog = null;
    if (vk) {
      const exists = Object.values(runtimes).some(r => r.users[vk]);
      if (!exists) state = "invalid";
      else if (!getAccessibleProfiles(vk).some(p => p.protocol === "responses")) state = "no-profile";
      else catalog = buildCodexModelCatalog(CODEX_DEPS, vk);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(codexSetupHtml(PAGE_DEPS, vk, state, catalog));
    return;
  }
  // Codex installer scripts, personalized per member key. The Host header tells
  // us which address the member's machine already reaches the gateway on, and
  // x-forwarded-proto (reverse proxy) / socket encryption tells us the scheme.
  if (req.method === "GET" && (req.url.startsWith("/api/codex-setup/") || req.url.startsWith("/api/codex-setup-win/"))) {
    const isWin = req.url.startsWith("/api/codex-setup-win/");
    const vk = decodeURIComponent(req.url.slice((isWin ? "/api/codex-setup-win/" : "/api/codex-setup/").length).split("?")[0]);
    const assignedRuntime = Object.values(runtimes).find(r => r.protocol === "responses" && r.users[vk]);
    const profileUser = assignedRuntime ? assignedRuntime.users[vk] : null;
    const profileUserDisabled = profileUser && typeof profileUser === "object" ? !!profileUser.disabled : false;
    const username = config.users?.[vk]?.username || vk;
    const globallyDisabled = !config.users?.[vk] || !!config.users[vk].disabled;
    if (!assignedRuntime || globallyDisabled || profileUserDisabled) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("# 无效的虚拟 Key 或该 Key 未分配到 Responses(Codex) 方案");
      return;
    }
    const rawHost = String(req.headers.host || "");
    const host = /^[A-Za-z0-9._:\-\[\]]+$/.test(rawHost) ? rawHost : `localhost:${port}`;
    const xfProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const proto = xfProto === "https" || req.socket.encrypted ? "https" : "http";
    const catalog = buildCodexModelCatalog(CODEX_DEPS, vk);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    if (isWin) res.end(buildCodexSetupScriptWin(vk, host, username, catalog.json, catalog.defaultModel, proto));
    else res.end(buildCodexSetupScript(vk, host, username, catalog.json, catalog.defaultModel, proto));
    return;
  }
  // Claude Code installer scripts, personalized per member key. 与 codex 那两条同一套
  // host/scheme 推导与鉴权口径，差别只在「必须有 Anthropic 方案」与脚本内容。
  // 注意这里**只有 404、没有 401**：`curl … | sh` 会把 401 的正文当脚本执行，
  // 所以错误正文用 # 前缀的中文 —— 它在 shell 里天然是注释，只打印不执行。
  if (req.method === "GET" && (req.url.startsWith("/api/claude-setup/") || req.url.startsWith("/api/claude-setup-win/"))) {
    const isWin = req.url.startsWith("/api/claude-setup-win/");
    const vk = decodeURIComponent(req.url.slice((isWin ? "/api/claude-setup-win/" : "/api/claude-setup/").length).split("?")[0]);
    const assignedRuntime = Object.values(runtimes).find(r => r.protocol === "anthropic" && r.users[vk]);
    const profileUser = assignedRuntime ? assignedRuntime.users[vk] : null;
    const profileUserDisabled = profileUser && typeof profileUser === "object" ? !!profileUser.disabled : false;
    const username = config.users?.[vk]?.username || vk;
    const globallyDisabled = !config.users?.[vk] || !!config.users[vk].disabled;
    if (!assignedRuntime || globallyDisabled || profileUserDisabled) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("# 无效的虚拟 Key 或该 Key 未分配到 Anthropic(Claude Code) 方案");
      return;
    }
    const rawHost = String(req.headers.host || "");
    const host = /^[A-Za-z0-9._:\-\[\]]+$/.test(rawHost) ? rawHost : `localhost:${port}`;
    const xfProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const proto = xfProto === "https" || req.socket.encrypted ? "https" : "http";
    // 推荐入口按成员算（在默认/调度方案组里就用无后缀入口，否则用自己方案的后缀）——
    // 与页面上给的地址必须是同一个判定，否则成员照脚本装完却和页面写的不一样。
    const { basePath } = buildAnthropicSetupHints(CLAUDE_DEPS, vk);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    if (isWin) res.end(buildClaudeSetupScriptWin(vk, host, username, proto, basePath));
    else res.end(buildClaudeSetupScript(vk, host, username, proto, basePath));
    return;
  }

  const keyNotFoundHtml = "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1.0\"><title>Key 不存在 - CC Team</title><link rel=\"icon\" type=\"image/svg+xml\" href=\"data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2096%2096%22%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2222%22%20fill%3D%22%232f6e50%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fbfbf8%22%20stroke-width%3D%2213%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate(48%2048)%20scale(0.88)%20translate(-48%20-48)%22%3E%3Cpath%20d%3D%22M37%2026.5H31.5Q20.5%2026.5%2020.5%2037.5V58.5Q20.5%2069.5%2031.5%2069.5H37%22%2F%3E%3Cpath%20d%3D%22M59%2026.5H64.5Q75.5%2026.5%2075.5%2037.5V58.5Q75.5%2069.5%2064.5%2069.5H59%22%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2248%22%20r%3D%226.2%22%20fill%3D%22%23fbfbf8%22%2F%3E%3C%2Fsvg%3E\"><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f7f7f3;color:#181816;font-family:-apple-system,BlinkMacSystemFont,\"SF Pro Text\",\"PingFang SC\",\"Microsoft YaHei\",\"Segoe UI\",sans-serif}.card{text-align:center;padding:42px 52px;background:#fff;border:1px solid #deded8;border-radius:14px}.card svg{display:block;margin:0 auto 16px}h1{font-size:19px;font-weight:650;margin-bottom:7px}p{font-size:13px;color:#686863}</style></head><body><div class=\"card\"><svg class=\"brand-logo\" width=\"44\" height=\"44\" viewBox=\"0 0 96 96\" aria-hidden=\"true\"><rect width=\"96\" height=\"96\" rx=\"22\" fill=\"#2f6e50\"/><g fill=\"none\" stroke=\"#fbfbf8\" stroke-width=\"11\" stroke-linecap=\"round\" stroke-linejoin=\"round\" transform=\"translate(48 48) scale(0.9) translate(-48 -48)\"><path d=\"M37 26.5H31.5Q20.5 26.5 20.5 37.5V58.5Q20.5 69.5 31.5 69.5H37\"/><path d=\"M59 26.5H64.5Q75.5 26.5 75.5 37.5V58.5Q75.5 69.5 64.5 69.5H59\"/></g><circle cx=\"48\" cy=\"48\" r=\"4.95\" fill=\"#fbfbf8\"/></svg><h1>Key 不存在</h1><p>请检查你的虚拟 Key 是否正确。</p></div></body></html>";

  // Personal usage page
  if (req.method === "GET" && req.url.startsWith("/usage/")) {
    const vk = decodeURIComponent(req.url.slice(7).split("?")[0]);
    if (!rt || !vk || (!rt.users[vk] && !rt.globalUsers[vk])) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(keyNotFoundHtml);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(personalUsageHtml(PAGE_DEPS, vk, personalCodexExtras(vk), personalClaudeExtras(vk), personalReviewExtras(vk)));
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/my-usage")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const vk = url.searchParams.get("key");
    if (!rt || !vk || (!rt.users[vk] && !rt.globalUsers[vk])) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(personalUsageLandingHtml(PAGE_DEPS));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(personalUsageHtml(PAGE_DEPS, vk, personalCodexExtras(vk), personalClaudeExtras(vk), personalReviewExtras(vk)));
    return;
  }

  // Personal usage API (authenticated by API key, supports ?profile=<suffix>)
  // Daily check-in (member, virtual-key auth — same scheme as /api/my-usage)
  if (req.method === "POST" && req.url.split("?")[0] === "/api/checkin") {
    const apiKey = getApiKey(req);
    try {
      if (!hasGlobalUser(apiKey)) throw new Error("认证失败：请提供有效的虚拟Key");
      const result = memberRewardsApi.performCheckIn(apiKey, getClientIp(req));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Quota increase request (member, virtual-key auth)
  if (req.method === "POST" && req.url.split("?")[0] === "/api/quota-request") {
    const apiKey = getApiKey(req);
    readBody(req, 10_000).then(buf => {
      try {
        if (!hasGlobalUser(apiKey)) throw new Error("认证失败：请提供有效的虚拟Key");
        const { reason, pool } = JSON.parse(buf.toString() || "{}");
        const result = memberRewardsApi.createQuotaRequest(apiKey, reason, pool, getClientIp(req));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => { res.writeHead(413); res.end("Request too large"); });
    return;
  }

  // 成员评审视图(成员,虚拟Key 鉴权 — 同 /api/my-usage 口径)。
  // 只返回**自己是成员的仓库**与它们的评审结果;越权过滤在 codeReviewApi.memberView 里。
  if (req.method === "GET" && req.url.split("?")[0] === "/api/my-review") {
    const apiKey = getApiKey(req);
    if (!hasGlobalUser(apiKey)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "认证失败：请提供有效的虚拟Key (Authorization: Bearer jx-...)" }));
      return;
    }
    const limit = Number(new URL(req.url, "http://localhost").searchParams.get("limit")) || 20;
    // 邮箱一起给:运行可见性与未解决数都含「pusher/作者邮箱=本人邮箱」的定向命中
    // (被定向通知到的非成员也要能在自己的页面看到/处理这条 run)。
    const email = (memberNotifyApi.get(apiKey) || {}).email || "";
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(codeReviewApi.memberView(apiKey, { limit, email })));
    return;
  }

  // 成员读单次运行的明细(含意见)。不归属自己的仓库一律 404 —— 不泄露「存在但无权限」。
  if (req.method === "GET" && req.url.split("?")[0] === "/api/my-review/run") {
    const apiKey = getApiKey(req);
    if (!hasGlobalUser(apiKey)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "认证失败：请提供有效的虚拟Key (Authorization: Bearer jx-...)" }));
      return;
    }
    const id = new URL(req.url, "http://localhost").searchParams.get("id");
    const email = (memberNotifyApi.get(apiKey) || {}).email || "";
    let d = null;
    try { d = codeReviewApi.memberRun(apiKey, id, email); } catch { d = null; }
    if (!d) { res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "运行不存在" })); return; }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ run: d.run, comments: d.comments }));
    return;
  }

  // 成员标记/撤销「已解决」:可见性与 memberRun 同口径(成员仓库 OR 邮箱命中),
  // 点完角标减一;同仓库下一次 push 是新 run,会重新计入未解决。
  if (req.method === "POST" && req.url.split("?")[0] === "/api/my-review/resolve") {
    const apiKey = getApiKey(req);
    readBody(req, 20_000).then((buf) => {
      try {
        if (!hasGlobalUser(apiKey)) {
          res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "认证失败：请提供有效的虚拟Key (Authorization: Bearer jx-...)" }));
          return;
        }
        const body = JSON.parse(buf.toString() || "{}");
        const email = (memberNotifyApi.get(apiKey) || {}).email || "";
        const seen = codeReviewApi.canMemberSeeRun(apiKey, String(body.id || ""), email);
        if (!seen) { res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "运行不存在" })); return; }
        const run = codeReviewApi.setRunResolved(seen.id, body.resolved !== false, getUserName(apiKey) || apiKey);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, run: { id: run.id, resolved: !!run.resolved, resolvedAt: run.resolved_at || null } }));
      } catch (err) {
        res.writeHead(err.statusCode || 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => { res.writeHead(413); res.end("Request too large"); });
    return;
  }

  // 成员产出画像(成员,虚拟Key 鉴权 — 同 /api/my-usage 口径;只返回本人明细与健康度)
  if (req.method === "GET" && req.url.startsWith("/api/production/me")) {
    const apiKey = getApiKey(req);
    if (!getAccessibleProfiles(apiKey).length) {
      const knownUser = hasGlobalUser(apiKey);
      res.writeHead(knownUser ? 403 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: knownUser ? "User is not allowed to view any profile." : "认证失败：请提供有效的虚拟Key (Authorization: Bearer jx-...)" }));
      return;
    }
    try {
      const { from, to } = rangeFromTo(new URL(req.url, "http://localhost").searchParams.get("range") || "7d");
      const key = resolveUserKey(apiKey, rt);
      const detail = productionUserDetail(db, key, { from, to });
      const health = contextHealth(db, { from, to }).find(h => h.user_key === key) || null;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ...detail, health }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        // Headers already sent — can't change status, just end the response.
        console.log(`[production-me] 响应已开始但出错: ${err.message}`);
        if (!res.writableEnded) res.end();
      }
    }
    return;
  }

  // 团队排行榜。刻意排在 /api/my-usage 之前 —— 后者是 startsWith 匹配,若将来有人把
  // 排行榜误命名成 /api/my-usage/leaderboard(它确实是「我的用量」页里的一个菜单项,
  // 很容易这么起名),会被整个吞掉并返回 200 的个人用量载荷,错误还查不出来。
  // 排前面让这个失败模式不可能出现。
  if (req.method === "GET" && req.url.startsWith("/api/leaderboard")) {
    const apiKey = getApiKey(req);
    if (!getAccessibleProfiles(apiKey).length) {
      const knownUser = hasGlobalUser(apiKey);
      res.writeHead(knownUser ? 403 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: knownUser ? "User is not allowed to view any profile." : "认证失败：请提供有效的虚拟Key (Authorization: Bearer jx-...)" }));
      return;
    }
    try {
      const url = new URL(req.url, `http://localhost`);
      // dimension/window 在 reader 内部按白名单查表,非法值回落默认档,不拼进 SQL。
      // 生效值随响应回传,调用方永远能看到自己实际拿到的是哪一档。
      const payload = leaderboardApi.getLeaderboard({
        dimension: url.searchParams.get("dimension") || "",
        window: url.searchParams.get("window") || "",
        meKey: resolveUserKey(apiKey, rt),
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));   // 紧凑输出:按需拉取的表格,缩进纯属浪费
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        console.log(`[leaderboard] 响应已开始但出错: ${err.message}`);
        if (!res.writableEnded) res.end();
      }
    }
    return;
  }

  // 会话使用情况。两条路由都刻意排在 /api/my-usage 之前:后者是 startsWith 匹配,
  // 而「会话使用情况」正是「我的用量」页里的一个区块,很容易被命名成
  // /api/my-usage/sessions —— 那样会被整个吞掉并返回个人用量载荷,错误还查不出来。
  // 排前面让这个失败模式不可能出现(与 /api/leaderboard 同一处坑)。
  if (req.method === "GET" && req.url.startsWith("/api/sessions")) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    try {
      const url = new URL(req.url, "http://localhost");
      const { from, to } = rangeFromTo(url.searchParams.get("range") || "7d");
      // user 是下钻筛选,取的是聚合表下发的**原始** key(不是掩码串)。
      // 空串按「不筛选」处理,不然 ?user= 会筛出一个空表而不是全量。
      const userKey = url.searchParams.get("user") || "";
      const payload = sessionsApi.getSessions({
        from, to,
        userKey: userKey || undefined,
        limit: url.searchParams.get("limit") || undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        console.log(`[sessions-api] 响应已开始但出错: ${err.message}`);
        if (!res.writableEnded) res.end();
      }
    }
    return;
  }

  // 明细记录下钻:某用户在某时段的 24 小时(半小时粒度)请求分布。刻意做成点击时才拉取
  // 的独立接口 —— 每用户×每日期的小时明细若随 /api/stats 预下发,载荷会大得毫无必要。
  if (req.method === "GET" && req.url.startsWith("/api/user-hours")) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    try {
      const url = new URL(req.url, "http://localhost");
      const masked = (url.searchParams.get("user") || "").trim();
      const start = (url.searchParams.get("start") || "").trim();
      const end = (url.searchParams.get("end") || start).trim();
      // 口径与 /api/stats 一致:profile 单选优先,protocol 只在 all 视图生效。
      const profileSuffix = url.searchParams.get("profile") || "all";
      const protocolParam = url.searchParams.get("protocol");
      let profileFilter = null;
      if (profileSuffix !== "all") {
        const sfx = normalizeProfileSuffix(profileSuffix);
        if (runtimes[sfx]) profileFilter = [sfx];
      } else if (protocolParam === "anthropic" || protocolParam === "responses") {
        profileFilter = statsApi.protocolSuffixes(protocolParam);
      }
      // 掩码还原:前端只拿得到 sanitizeStore 的掩码串(前 8 位 + "****")。运行时把所有
      // 方案的用户 key 重新掩码一遍建映射;命中后同时查完整 key 与 12 字符桩 ——
      // 未知 key 落库时存的是桩(resolveUserKey),两处都可能有真实用量。
      const candidates = new Set();
      if (masked.endsWith("****")) {
        for (const rt2 of Object.values(runtimes)) {
          for (const k of [...Object.keys(rt2.users || {}), ...Object.keys(rt2.globalUsers || {})]) {
            if (k.slice(0, 8) + "****" === masked) { candidates.add(k); candidates.add(k.slice(0, 12)); }
          }
        }
      } else if (masked) {
        candidates.add(masked);
      }
      const hours = {};
      if (candidates.size && start) {
        const keys = [...candidates];
        const conds = [`date BETWEEN ? AND ?`, `user_key IN (${keys.map(() => "?").join(",")})`];
        const params = [start, end, ...keys];
        if (profileFilter && profileFilter.length) {
          conds.push(`profile IN (${profileFilter.map(() => "?").join(",")})`);
          params.push(...profileFilter);
        }
        const rows = db.prepare(`SELECT hour, SUM(requests) AS requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_creation) AS cache_creation, SUM(cache_read) AS cache_read FROM usage_daily_hourly WHERE ${conds.join(" AND ")} GROUP BY hour`).all(...params);
        for (const r of rows) {
          hours[r.hour] = { requests: r.requests, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheCreationTokens: r.cache_creation, cacheReadTokens: r.cache_read };
        }
      }
      // usage_daily_hourly 只保留 7 天(pruneDailyHourly),retentionStart 供前端提示「更早无明细」。
      const retentionStart = new Date(Date.now() - 7 * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ start, end, hours, retentionStart }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        console.log(`[user-hours-api] 响应已开始但出错: ${err.message}`);
        if (!res.writableEnded) res.end();
      }
    }
    return;
  }

  // 成员的活动视图:项目分布 + 会话使用情况。鉴权与 /api/leaderboard 同款。
  if (req.method === "GET" && req.url.startsWith("/api/my-activity")) {
    const apiKey = getApiKey(req);
    if (!getAccessibleProfiles(apiKey).length) {
      const knownUser = hasGlobalUser(apiKey);
      res.writeHead(knownUser ? 403 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: knownUser ? "User is not allowed to view any profile." : "认证失败：请提供有效的虚拟Key (Authorization: Bearer jx-...)" }));
      return;
    }
    try {
      const url = new URL(req.url, "http://localhost");
      // start/end 显式给了就覆盖 range 预设(前者优先);parseDateRange 返回 null 表示都没给。
      const dr = parseDateRange(url.searchParams.get("start"), url.searchParams.get("end"));
      const fb = dr || rangeFromTo(url.searchParams.get("range") || "7d");
      const payload = sessionsApi.getMyActivity({
        from: dr ? dr.start : fb.from, to: dr ? dr.end : fb.to,
        userKey: resolveUserKey(apiKey, rt),
        limit: url.searchParams.get("limit") || undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        console.log(`[sessions-api] 响应已开始但出错: ${err.message}`);
        if (!res.writableEnded) res.end();
      }
    }
    return;
  }

  // 成员自助通知渠道(虚拟 Key 鉴权,同 /api/checkin 口径)。
  // 注意:必须注册在下面 startsWith("/api/my-usage") 那个前缀处理器**之前**,否则会被它吞掉。
  if (req.url.split("?")[0] === "/api/my-notify" && req.method === "GET") {
    const apiKey = getApiKey(req);
    if (!hasGlobalUser(apiKey)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "认证失败：请提供有效的虚拟Key (Authorization: Bearer jx-...)" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ prefs: memberNotifyApi.masked(apiKey), hasSmtp: !!String((config.notifier || {}).smtpHost || "").trim() }));
    return;
  }
  if (req.url.split("?")[0] === "/api/my-notify" && req.method === "POST") {
    const apiKey = getApiKey(req);
    readBody(req, 20_000).then((buf) => {
      try {
        if (!hasGlobalUser(apiKey)) throw new Error("认证失败：请提供有效的虚拟Key");
        const prefs = memberNotifyApi.save(apiKey, JSON.parse(buf.toString() || "{}"));
        recordAdminAudit(req, "member.notify.save", getUserName(apiKey) || apiKey, "成员更新自己的通知渠道");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, prefs }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => { res.writeHead(413); res.end("Request too large"); });
    return;
  }
  // 给自己发一条测试:让成员填完就能验证渠道通不通,不用等下一次评审
  if (req.url.split("?")[0] === "/api/my-notify/test" && req.method === "POST") {
    const apiKey = getApiKey(req);
    readBody(req, 20_000).then(async (buf) => {
      let results = [];
      try {
        if (!hasGlobalUser(apiKey)) throw new Error("认证失败：请提供有效的虚拟Key");
        // 先保存再发,这样「填完直接点测试」也能用(否则还要先点保存)
        const prefs = memberNotifyApi.save(apiKey, JSON.parse(buf.toString() || "{}"));
        const full = memberNotifyApi.get(apiKey) || {};
        const msg = `[token-monitor] 通知测试成功\n你的代码评审结果会推送到这里。\n—— ${notifierApi.beijingTimeString()}`;
        const n = config.notifier || {};
        if (full.email) {
          const mail = notifierApi.NOTIFY_SENDERS.find((x) => x.channel === "邮件");
          if (mail && mail.enabled(n)) {
            try { await mail.send(n, msg, { to: full.email, subject: "[token-monitor] 通知测试" }); results.push({ channel: "邮件", ok: true }); }
            catch (err) { results.push({ channel: "邮件", ok: false, error: err.message }); }
          } else {
            results.push({ channel: "邮件", ok: false, error: "管理员尚未配置 SMTP,邮件发不出去" });
          }
        }
        for (const ch of notifierApi.MEMBER_SENDERS) {
          if (!ch.enabled(full)) continue;
          try { await ch.send(full, msg); results.push({ channel: ch.channel, ok: true }); }
          catch (err) { results.push({ channel: ch.channel, ok: false, error: err.message }); }
        }
        if (!results.length) results = [{ channel: "—", ok: false, error: "还没有配置任何渠道" }];
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: results.every((r) => r.ok), results, prefs }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => { res.writeHead(413); res.end("Request too large"); });
    return;
  }
  // 标记「评审结果已看过」—— 菜单小红点靠它归零
  if (req.url.split("?")[0] === "/api/my-review/seen" && req.method === "POST") {
    const apiKey = getApiKey(req);
    if (!hasGlobalUser(apiKey)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "认证失败" }));
      return;
    }
    memberNotifyApi.markSeen(apiKey);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/my-usage")) {
    const apiKey = getApiKey(req);
    const url = new URL(req.url, `http://localhost`);
    const profileSuffix = url.searchParams.get("profile") || "all";
    const protocolParam = url.searchParams.get("protocol") || "";
    if (!getAccessibleProfiles(apiKey).length) {
      const knownUser = hasGlobalUser(apiKey);
      res.writeHead(knownUser ? 403 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: knownUser ? "User is not allowed to view any profile." : "认证失败：请提供有效的虚拟Key (Authorization: Bearer jx-...)" }));
      return;
    }
    try {
      // 可选自定义日期范围(用量分析面板的趋势/模型/客户端表);null = 都没给,走默认窗口。
      const usageRange = parseDateRange(url.searchParams.get("start"), url.searchParams.get("end"));
      const payload = usageApi.getPersonalUsageData(apiKey, profileSuffix, protocolParam, usageRange);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload, null, 2));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err.statusCode || 400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        // Headers already sent — can't change status, just end the response.
        console.error(`[my-usage] 响应已开始但出错: ${err.message}`);
        if (!res.writableEnded) res.end();
      }
    }
    return;
  }

  // Health check (no auth required)
  if (req.method === "GET" && req.url === "/health") {
    const activeConns = Object.values(userConcurrent).reduce((s, v) => s + v, 0);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime: Math.floor(process.uptime()),
      activeConnections: activeConns,
      upstream: rt?.upstream || "",
      circuitBreaker: rt?.breaker?.status() || { state: "UNCONFIGURED" },
    }));
    return;
  }

  // Proxy all other requests
  if (["POST", "GET", "PUT", "DELETE"].includes(req.method)) {
    proxyCoreApi.proxyRequest(req, res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[团队AI Coding监控] http://0.0.0.0:${port}  Dashboard: http://localhost:${port}/dashboard`);
  console.log(`[团队AI Coding监控] Profiles: ${Object.values(runtimes).map(r => `"${r.profileName}"(${JSON.stringify(r.suffix)})→${r.upstream.replace("https://","").replace("http://","").split("/")[0]}`).join(", ")}`);
  console.log(`[团队AI Coding监控] Settings: http://localhost:${port}/settings`);
  console.log(`[团队AI Coding监控] Users: ${Object.values(rt?.globalUsers || {}).map(u => u.username || "").join(", ")}`);
  toolPatternApi.scheduleToolPatternProbes();
});

// Codex remote compact 的 WebSocket 通道:只接 /v1/responses(含方案后缀)的 upgrade,
// 其余路径一律断开。协议与实现见 handleResponsesWsUpgrade 上方注释。
server.on("upgrade", handleResponsesWsUpgrade);

// Server timeouts
const serverTimeout = Math.max(gProxy.streamTimeout, gProxy.timeout) + 60000;
server.timeout = serverTimeout;
server.requestTimeout = serverTimeout;
server.headersTimeout = 120000;
server.keepAliveTimeout = 65000;

process.on("SIGINT", () => { try { db?.close(); } catch {} process.exit(0); });
process.on("SIGTERM", () => { try { db?.close(); } catch {} process.exit(0); });
process.on("uncaughtException", (err) => {
  if (err.code === "EPIPE" || err.code === "ECONNRESET") {
    console.error(`[WARN] ${err.code} ignored, client disconnected`);
    return;
  }
  console.error("[FATAL] Uncaught exception:", err);
  try { db?.close(); } catch {}
  process.exit(1);
});
