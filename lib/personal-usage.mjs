// lib/personal-usage.mjs —— 个人用量聚合: 单方案快照/费率卡/多方案混合视图/热力图数据。
// 从 server.mjs 抽出(零缩进逐字搬移)。依赖经 createUsageReader 工厂注入,
// initDb 阶段才就绪的(let 声明, 如 stmts/db)用 getter 延迟读取。

export function createUsageReader(d) {
  const {
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
    getCheckInStatus,
    getQuotaRequestStatus,
    buildUsageHeatmap,
    runtimes,
    rt,
    stmts,
    getPoolForSuffix
  } = d;

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

function getProfilePersonalUsage(apiKey, suffix, runtime) {
  const key = resolveUserKey(apiKey, runtime);
  const today = cnDate();
  const quota = checkTokenQuota(apiKey, suffix, runtime);
  const todayRow = stmts.profileDailyRow.get(suffix, today, key) || emptyUsageBucket();
  const todayUsage = todayRow.inputTokens != null ? todayRow : { inputTokens: todayRow.input_tokens||0, outputTokens: todayRow.output_tokens||0, requests: todayRow.requests||0, cacheCreationTokens: todayRow.cache_creation||0, cacheReadTokens: todayRow.cache_read||0 };

  // Per-model breakdown for today. `weighted` is what each model actually cost
  // against the quota, and `rate` the price it would pay right now — together they
  // let the page explain a mixed day without inventing a single blended figure.
  const todayModels = {};
  for (const r of stmts.profileDailyModelRows.all(suffix, today, key)) {
    todayModels[r.model] = {
      inputTokens: r.input_tokens, outputTokens: r.output_tokens, requests: r.requests,
      total: r.input_tokens + r.output_tokens,
      weighted: r.weighted_tokens || 0,
      rate: currentQuotaRate(runtime, new Date(), r.model),
      rateIsDefault: !lookupModelQuotaRate(runtime?.modelQuotaRates, r.model),
    };
  }

  // Per-hour breakdown for today
  const todayHourly = {};
  for (const r of stmts.profileDailyHourlyRows.all(suffix, today, key)) {
    todayHourly[r.hour] = { requests: r.requests, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheCreationTokens: r.cache_creation, cacheReadTokens: r.cache_read };
  }

  // 7-day trend
  const trendStart = new Date(Date.now() + 8 * 3600 * 1000);
  trendStart.setDate(trendStart.getDate() - 6);
  const trendStartDate = trendStart.toISOString().slice(0, 10);
  const trendMap = {};
  for (const r of stmts.profileDailyTrend.all(suffix, key, trendStartDate)) {
    const row = { date: r.date, input: r.input_tokens||0, output: r.output_tokens||0, cacheWrite: r.cache_creation||0, cacheRead: r.cache_read||0, requests: r.requests||0 };
    row.total = totalUsageTokens(row);
    trendMap[r.date] = row;
  }
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    trend.push(trendMap[dateStr] || { date: dateStr, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: 0, total: 0 });
  }

  // Check if quota was auto-adjusted
  const lastAdjust = stmts.lastQuotaAdjust.get(key);
  const quotaAutoAdjusted = lastAdjust ? !!lastAdjust.auto : false;

  return {
    profile: runtime.profileName,
    profileSuffix: suffix,
    quota: { type: quota.source, limit: quota.limit, used: quota.used, remaining: quota.remaining, autoAdjusted: quotaAutoAdjusted, bonus: quota.bonus || 0, resetApplied: !!quota.resetApplied, rawUsed: quota.rawUsed, discounted: quota.discounted, rate: quota.rate, rateIsDefault: true, inPeak: quota.inPeak, nextRateChange: nextRateChangeHint(runtime), cacheRead: quota.cacheRead, cacheInInput: !!quota.cacheInInput, cacheReadQuotaRate: quota.cacheReadQuotaRate, pool: quota.pool, poolLabel: quota.poolLabel, poolProfiles: quota.poolProfiles || [], poolShared: !!quota.poolShared },
    // Price list for the current slot: every alias the user can call, with the
    // rate it costs right now. This is the answer to "为什么我的额度掉得这么快" —
    // the user can see which model is expensive BEFORE spending on it.
    rateCard: buildRateCard(runtime),
    today: { input: todayUsage.inputTokens||0, output: todayUsage.outputTokens||0, requests: todayUsage.requests||0, cacheWrite: todayUsage.cacheCreationTokens||0, cacheRead: todayUsage.cacheReadTokens||0, total: totalUsageTokens(todayUsage) },
    models: todayModels,
    hourly: todayHourly,
    trend,
  };
}

// One row per alias→model pair the profile exposes, priced for the current slot.
// Aliases are what users type, so the card is keyed on them; several aliases may
// share a model (and therefore a rate), which is fine and worth showing.
function buildRateCard(runtime) {
  if (!runtime) return null;
  const now = new Date();
  const inPeak = isInPeakHours(runtime.peakHours, now);
  const aliases = effectiveModelAliases(runtime);
  const rows = [];
  for (const [alias, model] of Object.entries(aliases)) {
    const override = lookupModelQuotaRate(runtime.modelQuotaRates, model);
    rows.push({
      alias, model,
      rate: currentQuotaRate(runtime, now, model),
      custom: !!override,
      peak: override ? override.peak : normalizeQuotaRate(runtime.peakQuotaRate),
      offPeak: override ? override.offPeak : normalizeQuotaRate(runtime.offPeakQuotaRate),
    });
  }
  rows.sort((a, b) => a.rate - b.rate || a.alias.localeCompare(b.alias));
  return {
    profile: runtime.profileName,
    inPeak,
    defaultPeak: normalizeQuotaRate(runtime.peakQuotaRate),
    defaultOffPeak: normalizeQuotaRate(runtime.offPeakQuotaRate),
    rows,
  };
}

function getAggregatedPersonalUsage(apiKey, availableProfiles) {
  const today = cnDate();
  const todayUsage = emptyUsageBucket();
  const todayModels = {};
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
  const trendStartDate = trendStart.toISOString().slice(0, 10);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
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

    for (const r of stmts.profileDailyModelRows.all(suffix, today, key)) {
      // Same model name can appear under several profiles with different rates, so
      // the aggregate view sums weighted/raw but leaves `rate` null — a single
      // multiplier would be a fiction. The implied ratio (weighted/total) is still
      // meaningful and is what the UI shows here.
      if (!todayModels[r.model]) todayModels[r.model] = { inputTokens: 0, outputTokens: 0, requests: 0, total: 0, weighted: 0, rate: null, rateIsDefault: true };
      todayModels[r.model].inputTokens += r.input_tokens || 0;
      todayModels[r.model].outputTokens += r.output_tokens || 0;
      todayModels[r.model].requests += r.requests || 0;
      todayModels[r.model].total += (r.input_tokens||0) + (r.output_tokens||0);
      todayModels[r.model].weighted += r.weighted_tokens || 0;
    }

    for (const r of stmts.profileDailyHourlyRows.all(suffix, today, key)) {
      if (!todayHourly[r.hour]) todayHourly[r.hour] = emptyUsageBucket();
      addUsageBucket(todayHourly[r.hour], { inputTokens: r.input_tokens, outputTokens: r.output_tokens, requests: r.requests, cacheCreationTokens: r.cache_creation, cacheReadTokens: r.cache_read });
    }

    for (const r of stmts.profileDailyTrend.all(suffix, key, trendStartDate)) {
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
    },
    // Per-profile price lists, so the aggregate view can still answer "which model
    // is cheap where" without pretending the profiles share one rate.
    rateCards: availableProfiles
      .map(p => buildRateCard(runtimes[p.suffix]))
      .filter(card => card && card.rows.length > 0),
    // Per-profile quota rows: the honest answer to "how much do I have left",
    // which a single aggregate bar cannot give. Tightest first — the limit about
    // to bite is the one worth seeing.
    profileQuotas: profileQuotas.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || a.profile.localeCompare(b.profile)),
    today: { input: todayUsage.inputTokens, output: todayUsage.outputTokens, requests: todayUsage.requests, cacheWrite: todayUsage.cacheCreationTokens || 0, cacheRead: todayUsage.cacheReadTokens || 0, total: totalUsageTokens(todayUsage) },
    models: todayModels,
    hourly: todayHourly,
    trend: Object.values(trendByDate).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function getPersonalUsageData(apiKey, requestedProfile = "all", protocol = "") {
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

  if (profile === "all") {
    return { username, availableProfiles, protocolView: protocol || null, ...memberExtras,
      ...getAggregatedPersonalUsage(apiKey, availableProfiles),
      heatmap: buildUsageHeatmap(apiKey, availableProfiles.map(p => p.suffix)) };
  }

  const suffix = normalizeProfileSuffix(profile);
  const runtime = runtimes[suffix];
  if (!runtime || !availableProfiles.some(p => p.suffix === suffix)) {
    const err = new Error(`User is not allowed to view profile "${profile}"`);
    err.statusCode = 403;
    throw err;
  }
  return { username, availableProfiles, ...memberExtras,
    ...getProfilePersonalUsage(apiKey, suffix, runtime),
    heatmap: buildUsageHeatmap(apiKey, [suffix]) };
}

  return { getPersonalUsageData };
}
