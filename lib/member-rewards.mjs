// lib/member-rewards.mjs —— 会员激励机制: 每日签到 / 加量申请 / 用量日历热力图。
// 从 server.mjs 抽出(零缩进逐字搬移)。依赖经 createMemberRewards 工厂注入,
// initDb 阶段才就绪的(let 声明, 如 stmts/db)用 getter 延迟读取。
// 时间助手直接取自 lib/time.mjs(共享 API), 不经工厂注入。

import { cnDate, cnNow, cnWeekStartIso, cnDayStartIso } from "./time.mjs";

export function createMemberRewards(d) {
  const {
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
    stmts,
    db
  } = d;

// ─── Daily Check-in & Quota Requests (member gamification) ───────────────────
// Both features share one shape: the member acts from the personal usage page
// with their virtual key, the effect lands in quota_daily_ops / quota_requests,
// and every action is audited under its own log type (checkin / request) so it
// never mixes into the admin/system trail.

// Resolve a member key against the shared global-users map. check_ins /
// quota_requests store the FULL virtual key (not the 12-char truncated form),
// so every read path goes through this first.
function resolveGlobalUserKey(apiKey) {
  const full = String(apiKey || "");
  const short = full.slice(0, 12);
  for (const runtime of Object.values(runtimes)) {
    if (runtime.globalUsers[full]) return full;
    if (runtime.globalUsers[short]) return short;
  }
  return null;
}

// Distinct pools behind the profiles this user can actually use. The check-in
// reward is ONE random draw applied to every pool ("为 N 个池各 +X"), not an
// independent draw per pool, so the reward reads as a single number.
function getUserPoolNames(apiKey) {
  const out = [];
  const seen = new Set();
  for (const p of getAccessibleProfiles(apiKey)) {
    const poolName = getPoolForSuffix(p.suffix)?.name;
    if (poolName && !seen.has(poolName)) { seen.add(poolName); out.push(poolName); }
  }
  return out;
}

function poolLabelOf(name) {
  return config.quotaPools?.[name]?.label || name;
}

// Check-in streak counted in Beijing days. If today isn't checked in yet, the
// count still anchors on yesterday — the flame shows what's at stake today,
// not an instant reset at midnight.
function getCheckInStatus(apiKey) {
  const key = resolveGlobalUserKey(apiKey);
  if (!key) return { available: false };
  const today = cnDate();
  const row = stmts.getCheckIn.get(key, today);
  const totals = stmts.checkInTotals.get(key);
  const since = cnNow(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const dates = new Set(stmts.checkInDatesSince.all(key, since).map(r => r.date));
  let cursor = row ? today : cnNow(Date.now() - 86400000).toISOString().slice(0, 10);
  let streak = 0;
  while (dates.has(cursor)) {
    streak++;
    cursor = cnNow(new Date(`${cursor}T12:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
  }
  const ci = config.checkIn || {};
  return {
    available: true,
    enabled: ci.enabled !== false,
    checkedInToday: !!row,
    todayAmount: row ? (row.amount || 0) : 0,
    todayPools: (() => { try { return JSON.parse(row?.pools || "[]"); } catch { return []; } })(),
    streak,
    totalCheckIns: totals.days || 0,
    totalTokens: totals.tokens || 0,
    minTokens: Number.isInteger(ci.minTokens) ? ci.minTokens : 0,
    maxTokens: Number.isInteger(ci.maxTokens) ? ci.maxTokens : 0,
  };
}

// One check-in per user per Beijing day, enforced by the (user_key, date)
// primary key — the INSERT inside the transaction is the second line of
// defence if two requests race past the pre-check.
function performCheckIn(apiKey, ip) {
  if (config.checkIn?.enabled === false) throw new Error("签到功能未开启");
  const key = resolveGlobalUserKey(apiKey);
  if (!key) throw new Error("无效的用户 Key");
  const gu = getGlobalUser(key);
  if (!gu) throw new Error("无效的用户 Key");
  if (gu.disabled) throw new Error("账号已被禁用，无法签到");
  if (checkKeyExpired(key)) throw new Error("账号已过期，无法签到");
  const today = cnDate();
  if (stmts.getCheckIn.get(key, today)) throw new Error("今日已签到，明天再来吧");

  const min = Math.max(0, Number.isInteger(config.checkIn?.minTokens) ? config.checkIn.minTokens : 0);
  const max = Math.max(min, Number.isInteger(config.checkIn?.maxTokens) ? config.checkIn.maxTokens : min);
  const amount = min + Math.floor(Math.random() * (max - min + 1));

  const poolNames = getUserPoolNames(apiKey);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    stmts.insertCheckIn.run({ key, date: today, amount, pools: JSON.stringify(poolNames), createdAt: now });
    for (const poolName of poolNames) {
      const op = stmts.getQuotaDailyOp.get(poolName, key, today) || {};
      // ACCUMULATE, never overwrite: an admin's manual bonus and the check-in
      // reward must coexist — both are "extra allowance for today".
      stmts.upsertQuotaDailyOp.run({
        pool: poolName, key, date: today,
        bonus: (op.bonus || 0) + amount,
        baseline: op.reset_baseline || 0,
        resetTime: op.reset_time || null,
        updatedAt: now,
      });
    }
  });
  tx();

  const labels = poolNames.map(poolLabelOf);
  const username = gu.username || maskAuditKey(key);
  recordAudit("user", "checkin.success", username,
    `每日签到：获得 ${amount.toLocaleString()} token，已加入 ${poolNames.length} 个额度池的今日临时加量${labels.length ? `（${labels.join("、")}）` : ""}，明日自动失效`,
    ip, "checkin");
  console.log(`[签到] ${username} +${amount.toLocaleString()} token × ${poolNames.length} 个池`);
  return { ...getCheckInStatus(apiKey), amount, pools: labels };
}

// Week window starts Monday 00:00 Beijing time — the same clock the quota
// system counts days in. Returns an ISO timestamp usable in >= comparisons.
// cnWeekStartIso / cnDayStartIso 已迁至 ./lib/time.mjs。

function quotaRequestWeeklyLimit() {
  return Math.max(0, Number.isInteger(config.quotaRequest?.weeklyLimit) ? config.quotaRequest.weeklyLimit : 3);
}

function getQuotaRequestStatus(apiKey) {
  const key = resolveGlobalUserKey(apiKey);
  if (!key) return { available: false };
  const weeklyLimit = quotaRequestWeeklyLimit();
  const handled = stmts.countHandledQuotaRequestsSince.get(key, cnWeekStartIso()).c;
  const todaySubmitted = stmts.countQuotaRequestsSince.get(key, cnDayStartIso()).c > 0;
  return {
    available: true,
    enabled: config.quotaRequest?.enabled !== false,
    weeklyLimit,
    handledThisWeek: handled,
    remaining: Math.max(0, weeklyLimit - handled),
    todaySubmitted,
    pools: getUserPoolNames(apiKey).map(n => ({ name: n, label: poolLabelOf(n), limited: (getUserPoolQuota(n, key) || getPoolQuota(n)) > 0 })),
    myRecent: stmts.myQuotaRequests.all(key).map(r => ({
      id: r.id, reason: r.reason, pool: r.pool, poolLabel: r.pool ? poolLabelOf(r.pool) : "",
      status: r.status, adminNote: r.admin_note, createdAt: r.created_at, handledAt: r.handled_at,
    })),
  };
}

// A request is a notification, not an entitlement: it lands in the admin's
// queue (webhook + 设置页「加量申请」), the admin grants quota with the
// existing tools, then marks the request handled/rejected.
// Submission rules: the member picks WHICH pool (the admin decides how much),
// at most one submission per Beijing day (fixed rule), and submitting is free —
// only requests the admin has handled count against the weekly cap.
function createQuotaRequest(apiKey, reason, pool, ip) {
  if (config.quotaRequest?.enabled === false) throw new Error("加量申请功能未开启");
  const key = resolveGlobalUserKey(apiKey);
  if (!key) throw new Error("无效的用户 Key");
  const gu = getGlobalUser(key);
  if (!gu) throw new Error("无效的用户 Key");
  if (gu.disabled) throw new Error("账号已被禁用");
  if (checkKeyExpired(key)) throw new Error("账号已过期");
  const reasonText = String(reason || "").trim().slice(0, 200);
  if (!reasonText) throw new Error("请填写申请理由");
  if (stmts.countQuotaRequestsSince.get(key, cnDayStartIso()).c > 0) {
    throw new Error("今天已经提交过申请了，每天限 1 次，明天再来");
  }
  const poolName = String(pool || "").trim();
  if (!getUserPoolNames(apiKey).includes(poolName)) throw new Error("请选择你要申请加量的额度池");
  // An unlimited pool has nothing to grant — reject up front instead of letting
  // the request reach the admin queue just to be bounced there.
  const poolBase = getUserPoolQuota(poolName, key) || getPoolQuota(poolName);
  if (poolBase <= 0) throw new Error(`额度池「${poolLabelOf(poolName)}」当前不限量，无需申请加量`);
  const weeklyLimit = quotaRequestWeeklyLimit();
  const handled = stmts.countHandledQuotaRequestsSince.get(key, cnWeekStartIso()).c;
  if (handled >= weeklyLimit) throw new Error(`本周已有 ${handled} 次申请被处理，达到每周上限 ${weeklyLimit} 次，下周一刷新`);

  const now = new Date().toISOString();
  const username = gu.username || maskAuditKey(key);
  stmts.insertQuotaRequest.run({ key, username, reason: reasonText, pool: poolName, createdAt: now });
  recordAudit("user", "request.create", username,
    `申请额度池「${poolLabelOf(poolName)}」加量，理由「${reasonText}」（本周已处理 ${handled}/${weeklyLimit} 次）`,
    ip, "request");
  try { notifyQuotaRequest({ username, reason: reasonText, pool: poolLabelOf(poolName), handledThisWeek: handled, weeklyLimit }); }
  catch (err) { console.error("[通知] 加量申请推送失败:", err.message); }
  console.log(`[加量申请] ${username}：「${reasonText}」@${poolLabelOf(poolName)}`);
  const status = getQuotaRequestStatus(apiKey);
  return { ...status, justCreated: true };
}

// Admin-side status transition. `handled` means quota was granted (the admin
// does that with the regular pool tools), `rejected` means refused with a note.
function updateQuotaRequest(id, status, note) {
  const row = stmts.getQuotaRequest.get(id);
  if (!row) throw new Error(`申请 #${id} 不存在`);
  if (row.status !== "pending") throw new Error(`申请 #${id} 已处理过（当前状态 ${row.status}）`);
  if (!["handled", "rejected"].includes(status)) throw new Error("status 必须为 handled | rejected");
  const noteText = String(note || "").trim().slice(0, 200);
  stmts.updateQuotaRequest.run({ id, status, note: noteText, handledAt: new Date().toISOString() });
  return row;
}

// Push a new quota request through the configured notifier channels. Unlike
// system failure events this is business traffic the admin asked for, so no
// cooldown — the weekly per-user cap already bounds the volume.
function notifyQuotaRequest(info) {
  const cfg = config.notifier || {};
  if (!cfg.enabled) return;
  const channels = notifierApi.NOTIFY_SENDERS.filter(s => s.enabled(cfg));
  if (!channels.length) return;
  const msg = `【加量申请】${info.username}\n申请额度池：${info.pool}\n理由：${info.reason}\n请到 设置 → 加量申请 处理（该成员本周已处理 ${info.handledThisWeek}/${info.weeklyLimit} 次）\n—— ${notifierApi.beijingTimeString()}（token-monitor）`;
  for (const s of channels) {
    s.send(cfg, msg)
      .then(() => console.log(`[通知] 已推送 ${s.channel}: 加量申请 ${info.username}`))
      .catch(err => console.error(`[通知] ${s.channel} 推送失败: ${err.message}`));
  }
}

// ── Usage calendar (GitHub-style heatmap) ──
// usage_daily keeps one row per (profile, date, user_key) forever, so the
// calendar is a plain GROUP BY over the last 53 weeks. Rows are sparse (only
// days with traffic); the frontend fills the gaps so every calendar cell exists.
const heatmapStmts = new Map();
function usageHeatmapRows(key, suffixes, startDate) {
  if (!suffixes.length) return [];
  let stmt = heatmapStmts.get(suffixes.length);
  if (!stmt) {
    const holes = suffixes.map(() => "?").join(",");
    stmt = db.prepare(`SELECT date, SUM(input_tokens+output_tokens) AS total, SUM(weighted_tokens) AS weighted, SUM(requests) AS requests
      FROM usage_daily WHERE user_key=? AND date>=? AND profile IN (${holes}) GROUP BY date ORDER BY date`);
    heatmapStmts.set(suffixes.length, stmt);
  }
  return stmt.all(key, startDate, ...suffixes);
}

function buildUsageHeatmap(apiKey, suffixes) {
  const key = resolveGlobalUserKey(apiKey);
  if (!key) return { days: [], summary: null };
  const startDate = cnNow(Date.now() - 370 * 86400000).toISOString().slice(0, 10);
  const days = usageHeatmapRows(key, suffixes, startDate).map(r => ({
    date: r.date, total: r.total || 0, weighted: r.weighted || 0, requests: r.requests || 0,
  }));
  let totalTokens = 0, activeDays = 0, maxDay = null, longestStreak = 0, run = 0;
  for (const d of days) {
    totalTokens += d.total;
    activeDays++;
    if (!maxDay || d.total > maxDay.total) maxDay = d;
    if (d.total > 0) { run++; if (run > longestStreak) longestStreak = run; } else run = 0;
  }
  return {
    startDate,
    endDate: cnDate(),
    days,
    summary: { totalTokens, activeDays, maxDay, longestStreak },
  };
}

  return {
    resolveGlobalUserKey,
    getUserPoolNames,
    poolLabelOf,
    getCheckInStatus,
    performCheckIn,
    quotaRequestWeeklyLimit,
    getQuotaRequestStatus,
    createQuotaRequest,
    updateQuotaRequest,
    notifyQuotaRequest,
    usageHeatmapRows,
    buildUsageHeatmap,
  };
}
