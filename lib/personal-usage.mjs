// lib/personal-usage.mjs —— 个人用量聚合: 单方案快照/费率卡/多方案混合视图/热力图数据。
// 从 server.mjs 抽出(零缩进逐字搬移)。依赖经 createUsageReader 工厂注入,
// initDb 阶段才就绪的(let 声明, 如 stmts/db)用 getter 延迟读取。
//
// 点数计费(可选注入, 未接线时整块降级为 enabled:false, 页面回到旧的 token 配额口径):
//   getUserPoints(apiKey)   -> server.mjs 的 checkPointBudget(): { enabled, period, periodStart,
//                              periodEnd, startsAt, budgetPoints, usedPoints, remainingPoints,
//                              overPoints, pct, exhausted, allowed, ... }   ← 首选, 一次调用
//   getPointBudget(apiKey) + computePointsUsage(apiKey, budget)
//                           -> 上面两段拆开的等价形态(测试/嵌入方用)
// 派生字段(remainingPoints/overPoints/pct/exhausted/平均点数/预计耗尽日)一律在本模块算,
// 提供方只报事实。
//
// 成员首选方案(可选注入, 按优先级):
//   getPreferredProfiles(apiKey) -> { anthropic, responses } 元素 {suffix,name,active} 或 suffix
//   getPreferredProfile(apiKey, protocol)
//   getPreferredProfileSuffix(userKey, protocol) -> suffix 字符串(server.mjs 的成员自选读取器)
// active=false 表示该方案当前时段不在调度组(前端据此提示); 需注入
//   isProfileInActiveGroup(protocol, suffix)
// 未注入时 active 保持 true。pointSelfSelectAllowed(apiKey) 供页面决定是否显示选择器。

export function createUsageReader(d) {
  const {
    cnDate,
    isInPeakHours,
    normalizeQuotaRate,
    lookupModelQuotaRate,
    currentQuotaRate,
    currentPointRate,
    nextRateChangeHint,
    totalUsageTokens,
    normalizeProfileSuffix,
    resolveUserKey,
    getUserName,
    getAccessibleProfiles,
    effectiveModelAliases,
    checkTokenQuota,
    getCheckInStatus,
    getQuotaRequestStatus,
    buildUsageHeatmap,
    runtimes,
    rt,
    stmts,
    getPoolForSuffix,
    getUserPoints,
    getPointBudget,
    computePointsUsage,
    getPreferredProfiles,
    getPreferredProfile,
    getPreferredProfileSuffix,
    isProfileInActiveGroup,
    pointSelfSelectAllowed
  } = d;

// 1 点 = 10,000 计权 token(与页面文案、价目表/模型表的换算一致)。
const POINT_UNIT_TOKENS = 10000;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const DAY_MS = 86400000;
const isIsoDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isoAddDays = (date, n) => new Date(Date.parse(date + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
const dayDiff = (from, to) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / DAY_MS);

// 点数关闭时的稳定形状:页面只要读到 enabled:false 就不渲染点数卡, 字段仍齐全,
// 免得调用方到处写可选链。
function zeroPoints() {
  return {
    enabled: false, period: null, periodStart: null, periodEnd: null, startsAt: null,
    budgetPoints: 0, baseBudgetPoints: 0, bonusPoints: 0,
    usedPoints: 0, usedPointsExact: 0, remainingPoints: 0, remainingPointsExact: 0, overPoints: 0, overPointsExact: 0, pct: null,
    exhausted: false, unitTokens: POINT_UNIT_TOKENS, projectedExhaustDate: null, avgDailyPoints: 0,
  };
}

function normalizePoints(raw, today = cnDate()) {
  if (!raw || !raw.enabled) return zeroPoints();
  const unitTokens = Number(raw.unitTokens) > 0 ? Number(raw.unitTokens) : POINT_UNIT_TOKENS;
  const budgetPoints = Math.max(0, round1(raw.budgetPoints));
  const baseBudgetPoints = Math.max(0, round1(raw.baseBudgetPoints != null ? raw.baseBudgetPoints : raw.budgetPoints));
  const bonusPoints = Math.max(0, round1(raw.bonusPoints));
  const usedPoints = Math.max(0, round1(raw.usedPoints));
  const usedPointsExact = Math.max(0, round2(raw.usedPointsExact != null ? raw.usedPointsExact : raw.usedPoints));
  const remainingPoints = Math.max(0, round1(budgetPoints - usedPoints));
  const remainingPointsExact = Math.max(0, round2(raw.remainingPointsExact != null ? raw.remainingPointsExact : budgetPoints - usedPointsExact));
  const overPoints = Math.max(0, round1(usedPoints - budgetPoints));
  const overPointsExact = Math.max(0, round2(raw.overPointsExact != null ? raw.overPointsExact : usedPointsExact - budgetPoints));
  // pct 不封顶到 100:超额本身就是页面要显示的信息;上限 1000 只防脏数据撑爆样式。
  // provider(服务端)已按计权口径算好 pct 时直接采用,避免「点数四舍五入后」与
  // 「判定用的加权值」在 99.5/100 这种边界上给出两张不同的脸。
  const pct = Number.isFinite(raw.pct)
    ? Math.min(1000, Math.max(0, Number(raw.pct)))
    : (budgetPoints > 0 ? Math.min(1000, Math.round((usedPoints / budgetPoints) * 1000) / 10) : null);
  // 平均点数/预计耗尽日:provider 算好就采用, 否则按「本期已过天数」粗估 ——
  // 只用作提示文案, 判定永远看 usedPoints/budgetPoints, 不依赖这两个值。
  let avgDailyPoints = Math.max(0, round1(raw.avgDailyPoints));
  let projectedExhaustDate = raw.projectedExhaustDate || null;
  if (!avgDailyPoints) {
    const start = raw.startsAt && raw.periodStart && raw.startsAt > raw.periodStart ? raw.startsAt : raw.periodStart;
    const elapsed = isIsoDate(start) && isIsoDate(today) ? dayDiff(start, today) + 1 : 0;
    if (elapsed > 0) avgDailyPoints = round1(usedPoints / elapsed);
  }
  if (!projectedExhaustDate && avgDailyPoints > 0 && remainingPoints > 0 && isIsoDate(today)) {
    const d = isoAddDays(today, Math.ceil(remainingPoints / avgDailyPoints));
    // 本期内用不完就不预测:报一个下个周期的日期只会误导用户。
    if (!isIsoDate(raw.periodEnd) || d <= raw.periodEnd) projectedExhaustDate = d;
  }
  return {
    enabled: true,
    period: raw.period || "day",
    periodStart: raw.periodStart || null,
    periodEnd: raw.periodEnd || null,
    startsAt: raw.startsAt || null,
    budgetPoints, baseBudgetPoints, bonusPoints,
    usedPoints, usedPointsExact, remainingPoints, remainingPointsExact, overPoints, overPointsExact, pct,
    // 预算为 0 视为「没有可用点数」, 与用满同等对待, 免得页面对 0/0 显示「剩余 0 点」却仍提示可用。
    // provider 给了 exhausted 就以判定口径(weighted)为准, 不能让显示用的整数点在
    // 99.6/100 时提前把页面标成「已用尽」。
    exhausted: typeof raw.exhausted === "boolean"
      ? raw.exhausted
      : (budgetPoints <= 0 || usedPoints >= budgetPoints),
    unitTokens,
    projectedExhaustDate,
    avgDailyPoints,
  };
}

// 点数预算与用量都是用户级的(跨方案同一份), 因此这里所有失败都降级为「未启用」:
// 一个取数故障不该让整页 500, 也不该把用户误判成有/没有预算。
function pointsForUser(apiKey) {
  if (typeof getUserPoints === "function") {
    try { return normalizePoints(getUserPoints(apiKey)); } catch { return zeroPoints(); }
  }
  if (typeof getPointBudget !== "function") return zeroPoints();
  let budget = null;
  try { budget = getPointBudget(apiKey); } catch { return zeroPoints(); }
  if (!budget || budget.enabled === false) return zeroPoints();
  let usage = null;
  if (typeof computePointsUsage === "function") {
    try { usage = computePointsUsage(apiKey, budget) || null; } catch { usage = null; }
  }
  return normalizePoints({ ...budget, ...(usage || {}) });
}

function normalizePreferred(raw) {
  if (raw && typeof raw === "object") {
    const suffix = raw.suffix || "";
    return { suffix, name: raw.name || suffix, active: raw.active !== false };
  }
  const suffix = typeof raw === "string" ? raw : "";
  return { suffix, name: suffix, active: true };
}

function preferredProfileFor(apiKey, protocol, userKey) {
  let raw = null;
  try {
    if (typeof getPreferredProfiles === "function") {
      raw = (getPreferredProfiles(apiKey) || {})[protocol];
    } else if (typeof getPreferredProfile === "function") {
      raw = getPreferredProfile(apiKey, protocol);
    } else if (typeof getPreferredProfileSuffix === "function") {
      raw = getPreferredProfileSuffix(userKey, protocol);
    }
  } catch { raw = null; }
  const pref = normalizePreferred(raw);
  if (!pref.suffix) return pref;
  // suffix 是内部标识, 页面要的是方案显示名; runtimes 以 suffix 为键。
  if (pref.name === pref.suffix) {
    const runtime = runtimes[pref.suffix];
    if (runtime && runtime.profileName) pref.name = runtime.profileName;
  }
  // 首选只在当前生效调度组的候选里才有意义(server 侧不可用时静默回退), UI 要如实提示。
  if (typeof isProfileInActiveGroup === "function") {
    try { pref.active = !!isProfileInActiveGroup(protocol, pref.suffix); } catch { /* 保持 provider 给的值 */ }
  }
  return pref;
}

function emptyUsageBucket() {
  return { inputTokens: 0, outputTokens: 0, requests: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

function addUsageBucket(target, source = {}) {
  target.inputTokens += source.inputTokens || 0;
  target.outputTokens += source.outputTokens || 0;
  target.requests += source.requests || 0;
  target.cacheCreationTokens += source.cacheCreationTokens || 0;
  target.cacheReadTokens += source.cacheReadTokens || 0;
}

// 逐日北京日期串序列(闭区间)。调用方传进来的 range 已经过 parseDateRange 校验
// (跨度 ≤ 400 天),这里不需要再设上限。
function trendDateList(start, end) {
  const out = [];
  for (let t = Date.parse(start + "T00:00:00Z"); t <= Date.parse(end + "T00:00:00Z"); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

// 自定义日期范围(range = {start,end} | null)下取模型/客户端明细:有 range 用区间
// 聚合语句(跨日 SUM,weighted_tokens 是落表时算好的历史值,求和即区间精确计权成本),
// 没有则保持原单日语句。返回的行同列名,后续累加代码两路共用。
function modelRowsForRange(stmts, suffix, key, today, range) {
  return range
    ? stmts.profileDailyModelRowsRange.all(suffix, key, range.start, range.end)
    : stmts.profileDailyModelRows.all(suffix, today, key);
}
function clientRowsForRange(stmts, suffix, key, today, range) {
  return range
    ? stmts.profileDailyClientRowsRange.all(suffix, key, range.start, range.end)
    : stmts.profileDailyClientRows.all(suffix, today, key);
}

function getProfilePersonalUsage(apiKey, suffix, runtime, range = null, pointsMode = false) {
  const key = resolveUserKey(apiKey, runtime);
  const today = cnDate();
  const quota = checkTokenQuota(apiKey, suffix, runtime);
  const todayRow = stmts.profileDailyRow.get(suffix, today, key) || emptyUsageBucket();
  const todayUsage = todayRow.inputTokens != null ? todayRow : { inputTokens: todayRow.input_tokens||0, outputTokens: todayRow.output_tokens||0, requests: todayRow.requests||0, cacheCreationTokens: todayRow.cache_creation||0, cacheReadTokens: todayRow.cache_read||0 };

  // Per-model breakdown for today. `weighted` is what each model actually cost
  // against the quota, and `rate` the price it would pay right now — together they
  // let the page explain a mixed day without inventing a single blended figure.
  const todayModels = {};
  for (const r of modelRowsForRange(stmts, suffix, key, today, range)) {
    todayModels[r.model] = {
      inputTokens: r.input_tokens, outputTokens: r.output_tokens, requests: r.requests,
      total: r.input_tokens + r.output_tokens,
      weighted: r.weighted_tokens || 0,
      billingWeighted: r.billing_weighted_tokens != null ? r.billing_weighted_tokens : (r.weighted_tokens || 0),
      rate: pointsMode && currentPointRate ? currentPointRate(runtime, new Date(), r.model) : currentQuotaRate(runtime, new Date(), r.model),
      rateIsDefault: !lookupModelQuotaRate(runtime?.modelQuotaRates, r.model),
    };
  }

  // 客户端维度(今天)。与模型不同,这里不报 rate —— 倍率是「模型 × 时段」的函数,
  // 与客户端无关;同一个客户端下的请求可能横跨多个模型,给它们合成一个倍率就是编造。
  // 所以这一轴只回答「谁在用哪个客户端、各自烧了多少原始 token」,额度口径仍看上面的模型表。
  const todayClients = {};
  for (const r of clientRowsForRange(stmts, suffix, key, today, range)) {
    todayClients[r.client] = {
      inputTokens: r.input_tokens || 0, outputTokens: r.output_tokens || 0, requests: r.requests || 0,
      total: (r.input_tokens || 0) + (r.output_tokens || 0),
    };
  }

  // Per-hour breakdown for today
  const todayHourly = {};
  for (const r of stmts.profileDailyHourlyRows.all(suffix, today, key)) {
    todayHourly[r.hour] = { requests: r.requests, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheCreationTokens: r.cache_creation, cacheReadTokens: r.cache_read };
  }

  // 趋势:默认近 7 天;自定义日期范围时按 [start,end] 逐日出(缺口补零)。
  const trendStart = new Date(Date.now() + 8 * 3600 * 1000);
  trendStart.setDate(trendStart.getDate() - 6);
  const trendStartDate = range ? range.start : trendStart.toISOString().slice(0, 10);
  const trendEndDate = range ? range.end : today;
  const trendMap = {};
  for (const r of stmts.profileDailyTrend.all(suffix, key, trendStartDate, trendEndDate)) {
    const row = { date: r.date, input: r.input_tokens||0, output: r.output_tokens||0, cacheWrite: r.cache_creation||0, cacheRead: r.cache_read||0, requests: r.requests||0 };
    row.total = totalUsageTokens(row);
    trendMap[r.date] = row;
  }
  const trend = trendDateList(trendStartDate, trendEndDate).map((dateStr) =>
    trendMap[dateStr] || { date: dateStr, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: 0, total: 0 });

  // Check if quota was auto-adjusted
  const lastAdjust = stmts.lastQuotaAdjust.get(key);
  const quotaAutoAdjusted = lastAdjust ? !!lastAdjust.auto : false;

  return {
    profile: runtime.profileName,
    profileSuffix: suffix,
    quota: { type: quota.source, limit: quota.limit, used: quota.used, remaining: quota.remaining, autoAdjusted: quotaAutoAdjusted, bonus: quota.bonus || 0, resetApplied: !!quota.resetApplied, rawUsed: quota.rawUsed, discounted: quota.discounted, rate: quota.rate, rateIsDefault: true, inPeak: quota.inPeak, nextRateChange: nextRateChangeHint(runtime), cacheRead: quota.cacheRead, cacheInInput: !!quota.cacheInInput, cacheReadQuotaRate: quota.cacheReadQuotaRate, pool: quota.pool, poolLabel: quota.poolLabel, poolProfiles: quota.poolProfiles || [], poolShared: !!quota.poolShared, pointsMode: !!pointsMode },
    // Price list for the current slot: every alias the user can call, with the
    // rate it costs right now. This is the answer to "为什么我的额度掉得这么快" —
    // the user can see which model is expensive BEFORE spending on it.
    rateCard: buildRateCard(runtime, pointsMode),
    today: { input: todayUsage.inputTokens||0, output: todayUsage.outputTokens||0, requests: todayUsage.requests||0, cacheWrite: todayUsage.cacheCreationTokens||0, cacheRead: todayUsage.cacheReadTokens||0, total: totalUsageTokens(todayUsage) },
    models: todayModels,
    clients: todayClients,
    hourly: todayHourly,
    trend,
  };
}

// One row per alias→model pair the profile exposes, priced for the current slot.
// Aliases are what users type, so the card is keyed on them; several aliases may
// share a model (and therefore a rate), which is fine and worth showing.
function buildRateCard(runtime, pointsMode = false) {
  if (!runtime) return null;
  const now = new Date();
  const inPeak = isInPeakHours(runtime.peakHours, now);
  const aliases = effectiveModelAliases(runtime);
  const rows = [];
  for (const [alias, model] of Object.entries(aliases)) {
    const override = lookupModelQuotaRate(pointsMode ? runtime.pointModelRates : runtime.modelQuotaRates, model);
    const peakRaw = pointsMode ? runtime.pointPeakRate : runtime.peakQuotaRate;
    const offRaw = pointsMode ? runtime.pointOffPeakRate : runtime.offPeakQuotaRate;
    rows.push({
      alias, model,
      rate: pointsMode ? currentPointRate(runtime, now, model) : currentQuotaRate(runtime, now, model),
      custom: !!override,
      peak: override ? (override.peak == null ? 1 : override.peak) : (pointsMode ? (peakRaw == null ? 1 : normalizeQuotaRate(peakRaw)) : normalizeQuotaRate(peakRaw)),
      offPeak: override ? (override.offPeak == null ? 1 : override.offPeak) : (pointsMode ? (offRaw == null ? 1 : normalizeQuotaRate(offRaw)) : normalizeQuotaRate(offRaw)),
    });
  }
  rows.sort((a, b) => a.rate - b.rate || a.alias.localeCompare(b.alias));
  return {
    profile: runtime.profileName,
    inPeak,
    defaultPeak: pointsMode ? (runtime.pointPeakRate == null ? 1 : normalizeQuotaRate(runtime.pointPeakRate)) : normalizeQuotaRate(runtime.peakQuotaRate),
    defaultOffPeak: pointsMode ? (runtime.pointOffPeakRate == null ? 1 : normalizeQuotaRate(runtime.pointOffPeakRate)) : normalizeQuotaRate(runtime.offPeakQuotaRate),
    rows,
  };
}

function getAggregatedPersonalUsage(apiKey, availableProfiles, range = null, pointsMode = false) {
  const today = cnDate();
  const todayUsage = emptyUsageBucket();
  const todayModels = {};
  const todayClients = {};
  const todayHourly = {};
  const trendByDate = {};
  let totalQuotaLimit = 0;
  let totalQuotaUsed = 0;
  let totalQuotaBonus = 0;
  let totalRawUsed = 0;
  let totalDiscounted = 0;
  const profileQuotas = [];
  const seenPools = new Set();
  let hasQuotaReset = false;
  let hasUnlimitedQuota = false;

  const trendStart = new Date(Date.now() + 8 * 3600 * 1000);
  trendStart.setDate(trendStart.getDate() - 6);
  const trendStartDate = range ? range.start : trendStart.toISOString().slice(0, 10);
  const trendEndDate = range ? range.end : today;
  for (const dateStr of trendDateList(trendStartDate, trendEndDate)) {
    trendByDate[dateStr] = { date: dateStr, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: 0, total: 0 };
  }

  for (const profile of availableProfiles) {
    const runtime = runtimes[profile.suffix];
    if (!runtime) continue;
    const key = resolveUserKey(apiKey, runtime);
    const suffix = profile.suffix;

    const todayRow = stmts.profileDailyRow.get(suffix, today, key);
    if (todayRow) {
      todayUsage.inputTokens += todayRow.input_tokens || 0;
      todayUsage.outputTokens += todayRow.output_tokens || 0;
      todayUsage.requests += todayRow.requests || 0;
      todayUsage.cacheCreationTokens += todayRow.cache_creation || 0;
      todayUsage.cacheReadTokens += todayRow.cache_read || 0;
    }

    for (const r of modelRowsForRange(stmts, suffix, key, today, range)) {
      // Same model name can appear under several profiles with different rates, so
      // the aggregate view sums weighted/raw but leaves `rate` null — a single
      // multiplier would be a fiction. The implied ratio (weighted/total) is still
      // meaningful and is what the UI shows here.
      if (!todayModels[r.model]) todayModels[r.model] = { inputTokens: 0, outputTokens: 0, requests: 0, total: 0, weighted: 0, billingWeighted: 0, rate: null, rateIsDefault: true };
      todayModels[r.model].inputTokens += r.input_tokens || 0;
      todayModels[r.model].outputTokens += r.output_tokens || 0;
      todayModels[r.model].requests += r.requests || 0;
      todayModels[r.model].total += (r.input_tokens||0) + (r.output_tokens||0);
      todayModels[r.model].weighted += r.weighted_tokens || 0;
      todayModels[r.model].billingWeighted += r.billing_weighted_tokens != null ? r.billing_weighted_tokens : (r.weighted_tokens || 0);
    }

    // 客户端维度也要跨方案累加:同一个客户端(如 Claude Code)可能同时走多个方案的入口,
    // 用户想知道的是「我这些请求分别来自哪个客户端」,而不是「哪个方案下用了哪个客户端」。
    for (const r of clientRowsForRange(stmts, suffix, key, today, range)) {
      if (!todayClients[r.client]) todayClients[r.client] = { inputTokens: 0, outputTokens: 0, requests: 0, total: 0 };
      todayClients[r.client].inputTokens += r.input_tokens || 0;
      todayClients[r.client].outputTokens += r.output_tokens || 0;
      todayClients[r.client].requests += r.requests || 0;
      todayClients[r.client].total += (r.input_tokens || 0) + (r.output_tokens || 0);
    }

    for (const r of stmts.profileDailyHourlyRows.all(suffix, today, key)) {
      if (!todayHourly[r.hour]) todayHourly[r.hour] = emptyUsageBucket();
      addUsageBucket(todayHourly[r.hour], { inputTokens: r.input_tokens, outputTokens: r.output_tokens, requests: r.requests, cacheCreationTokens: r.cache_creation, cacheReadTokens: r.cache_read });
    }

    for (const r of stmts.profileDailyTrend.all(suffix, key, trendStartDate, trendEndDate)) {
      if (trendByDate[r.date]) {
        trendByDate[r.date].input += r.input_tokens || 0;
        trendByDate[r.date].output += r.output_tokens || 0;
        trendByDate[r.date].cacheWrite += r.cache_creation || 0;
        trendByDate[r.date].cacheRead += r.cache_read || 0;
        trendByDate[r.date].requests += r.requests || 0;
        trendByDate[r.date].total += totalUsageTokens(r);
      }
    }

    const quota = checkTokenQuota(apiKey, profile.suffix, runtime);
    // The quota is pooled — two profiles in one pool report the SAME numbers, so
    // the per-pool card and the aggregate totals must be added exactly once per
    // pool, while the usage accumulations above legitimately loop every profile.
    const poolName = runtime.quotaPool || getPoolForSuffix(suffix).name;
    if (seenPools.has(poolName)) continue;
    seenPools.add(poolName);
    totalQuotaUsed += quota.used || 0;
    if (quota.limit > 0) totalQuotaLimit += quota.limit;
    else hasUnlimitedQuota = true;
    totalQuotaBonus += quota.bonus || 0;
    if (quota.resetApplied) hasQuotaReset = true;
    // Weighted/raw totals are additive across pools; the rate itself is not
    // (each profile has its own), so the aggregate view reports rate: null and
    // the UI shows only the combined discount.
    totalRawUsed += quota.rawUsed || 0;
    totalDiscounted += quota.discounted || 0;
    // Per-pool breakdown. The aggregate limit collapses to 0 (= "unlimited") as
    // soon as ANY pool is unlimited, which hides every other pool's very real
    // limit — and even when it does add up, one summed bar cannot say which pool
    // is about to run out. This list is what the page actually shows.
    profileQuotas.push({
      profile: quota.poolLabel || poolName,
      suffix: poolName,
      protocol: profile.protocol,
      billingType: runtime.billingType,
      isDefault: !!profile.isDefault,
      isPool: true,
      poolProfiles: (quota.poolProfiles || []).map(s => {
        const m = runtimes[s];
        return m ? m.profileName : s;
      }),
      type: quota.source,
      limit: quota.limit,
      used: quota.used,
      remaining: quota.limit > 0 ? quota.remaining : null,
      pct: quota.limit > 0 ? Math.min(100, Math.round((quota.used / quota.limit) * 100)) : null,
      bonus: quota.bonus || 0,
      resetApplied: !!quota.resetApplied,
      rawUsed: quota.rawUsed,
      discounted: quota.discounted,
      rate: quota.rate,
      inPeak: quota.inPeak,
      cacheRead: quota.cacheRead,
      cacheInInput: !!quota.cacheInInput,
      cacheReadQuotaRate: quota.cacheReadQuotaRate,
      nextRateChange: nextRateChangeHint(runtime),
      pointsMode: !!pointsMode,
    });
  }

  const limit = hasUnlimitedQuota ? 0 : totalQuotaLimit;
  return {
    profile: "全部可用方案",
    profileSuffix: "all",
    quota: {
      type: limit > 0 ? "聚合配额" : "无限制",
      limit,
      used: totalQuotaUsed,
      remaining: limit > 0 ? Math.max(0, limit - totalQuotaUsed) : Infinity,
      autoAdjusted: false,
      bonus: totalQuotaBonus,
      resetApplied: hasQuotaReset,
      rawUsed: totalRawUsed,
      discounted: totalDiscounted,
      rate: null,       // mixed across profiles — meaningless as a single number
      rateIsDefault: true,
      inPeak: null,
      nextRateChange: null,
      pointsMode: !!pointsMode,
    },
    // Per-profile price lists, so the aggregate view can still answer "which model
    // is cheap where" without pretending the profiles share one rate.
    rateCards: availableProfiles
      .map(p => buildRateCard(runtimes[p.suffix], pointsMode))
      .filter(card => card && card.rows.length > 0),
    // Per-profile quota rows: the honest answer to "how much do I have left",
    // which a single aggregate bar cannot give. Tightest first — the limit about
    // to bite is the one worth seeing.
    profileQuotas: profileQuotas.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.profile.localeCompare(b.profile)),
    today: { input: todayUsage.inputTokens, output: todayUsage.outputTokens, requests: todayUsage.requests, cacheWrite: todayUsage.cacheCreationTokens || 0, cacheRead: todayUsage.cacheReadTokens || 0, total: totalUsageTokens(todayUsage) },
    models: todayModels,
    clients: todayClients,
    hourly: todayHourly,
    trend: Object.values(trendByDate).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function getPersonalUsageData(apiKey, requestedProfile = "all", protocol = "", range = null) {
  let availableProfiles = getAccessibleProfiles(apiKey);
  const username = getUserName(apiKey, rt) || apiKey.slice(0, 8);
  const profile = requestedProfile || "all";

  // Optional protocol split for the "all" view (mirrors /api/stats?protocol=):
  // narrows both the aggregated numbers and the profile list handed to the page.
  if (profile === "all" && (protocol === "anthropic" || protocol === "responses")) {
    availableProfiles = availableProfiles.filter(p => p.protocol === protocol);
  }

  // Member-facing features ride along on every response: check-in state,
  // quota-request state, and the usage calendar scoped to the current view.
  const memberExtras = {
    checkin: getCheckInStatus(apiKey),
    quotaRequest: getQuotaRequestStatus(apiKey),
  };

  // 点数与首选方案都是用户级的(与当前看哪个方案无关), 两个分支返回同一份,
  // 页面切方案/协议时不用重算。provider 未接线时 points.enabled=false。
  const points = pointsForUser(apiKey);
  const pointsMode = points.enabled;
  const userKey = resolveUserKey(apiKey, rt);
  // 成员自选还受两个开关约束: 点数模式已开启 + 管理员放开了 allowSelfSelect。
  // 未注入判定函数时按「允许」处理(能否真正生效由 server 侧 getPreferredProfileSuffix 再判)。
  const selfSelect = typeof pointSelfSelectAllowed === "function"
    ? !!pointSelfSelectAllowed(apiKey)
    : pointSelfSelectAllowed !== false;
  // 优先方案 + 可选方案清单 + 「默认自动」的调度解释都由 server 的
  // buildPreferredProfiles 一次给出；这里再包一层归一化，方便页面直接渲染。
  let prefPayload = {};
  try {
    if (typeof getPreferredProfiles === "function") prefPayload = getPreferredProfiles(apiKey) || {};
  } catch { prefPayload = {}; }
  const preferredProfiles = {
    anthropic: preferredProfileFor(apiKey, "anthropic", userKey),
    responses: preferredProfileFor(apiKey, "responses", userKey),
    // 协议分组后的可切换方案，以及每个协议的「默认自动」当前落点/调度组。
    plans: prefPayload.plans || { anthropic: [], responses: [] },
    auto: prefPayload.auto || { anthropic: null, responses: null },
    // 前端只认这个总开关: false 时整块选择器隐藏, 避免用户点了保存却被 403/无效果。
    selfSelect: pointsMode && selfSelect,
  };
  const userExtras = { points, preferredProfiles };

  if (profile === "all") {
    return { username, availableProfiles, protocolView: protocol || null, usageRange: range, ...memberExtras, ...userExtras,
      ...getAggregatedPersonalUsage(apiKey, availableProfiles, range, pointsMode),
      heatmap: buildUsageHeatmap(apiKey, availableProfiles.map(p => p.suffix)) };
  }

  const suffix = normalizeProfileSuffix(profile);
  const runtime = runtimes[suffix];
  if (!runtime || !availableProfiles.some(p => p.suffix === suffix)) {
    const err = new Error(`User is not allowed to view profile "${profile}"`);
    err.statusCode = 403;
    throw err;
  }
  return { username, availableProfiles, usageRange: range, ...memberExtras, ...userExtras,
    ...getProfilePersonalUsage(apiKey, suffix, runtime, range, pointsMode),
    heatmap: buildUsageHeatmap(apiKey, [suffix]) };
}

  return { getPersonalUsageData };
}
