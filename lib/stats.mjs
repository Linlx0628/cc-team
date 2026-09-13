// lib/stats.mjs —— /api/stats 读模型聚合: SQLite 聚合行 → 面板数据结构。
// 从 server.mjs 抽出(零缩进逐字搬移)。依赖经 createStatsReader 工厂注入,
// 其中 db/stmts 由 server 侧 getter 延迟提供(initDb 阶段才就绪)。

import { currentQuotaRate, lookupModelQuotaRate, normalizeQuotaRate } from "./quota.mjs";
import { normalizePeakHours, isInPeakHours } from "./schedule.mjs";
import { cnDate, cnNow } from "./time.mjs";

// 两张 24 小时图(usage_hourly / usage_hourly_model)的**取数下界**,北京时间日期串。
//
// 为什么要有它:这两张表的查询原本不带任何日期条件,于是每 30 秒一次的 /api/stats 会把
// usage_hourly 的**全部历史**发给浏览器(2026-09 实测 925 行 / 138KB 原始),而前端只用得到
// 当前周期窗口内的日期,窗口外的部分发过去就被丢掉。这张表又只增不减,幅度随时间线性变大。
//
// 下界的依据就是前端 winBounds() 的那四个周期窗口(日=今天 / 周=本周一 / 月=本月 1 日 /
// 年=本年 1 月 1 日),最宽的是「按年」。本来取本年 1 月 1 日就够,但「按周」在年初会跨年:
// 1 月 1 日不在周一时,那一周的起点落在上一年 12 月(最多回溯 6 天);而前端 wk() 用的是
// 浏览器**本地**时区,偏西的时区还会把周一再算早一天。所以往前留 14 天,把两件事一起吸收。
//
// 这是**下界不是过滤**:它必须 ≤ 前端任何窗口的起点。收紧到年内会让年初那一周的 24 小时图
// 静默缺几天(不报错);放宽只是多传十几行。同理**不能**给 daily / dailyModels 那四张周期图
// 加 —— 它们支持自定义日期范围(起点可到 0000-01-01),加下界会把那个功能砍掉。
export function hourlyChartFloor(nowMs = Date.now()) {
  const year = cnNow(nowMs).getUTCFullYear();
  return new Date(Date.UTC(year, 0, 1) - 14 * 24 * 3600000).toISOString().slice(0, 10);
}

export function createStatsReader(d) {
  const {
    config, runtimes, db, stmts,
    normalizeProfileSuffix, normalizeProfileProtocol, normalizeModelAliases,
    getProfileModelAliases, sanitizeStore, getRateLimitInfo, canUseProfile,
    checkTokenQuota, listProfiles, listQuotaPools,
  } = d;

// Aggregate all profiles for "all profiles" view, assembled via SQL GROUP BY.
// Returns the same nested shape as loadProfileSnapshot so sanitizeStore and the
// frontend work unchanged. `suffixFilter` (optional array) restricts every query
// to those profile suffixes — used for protocol-scoped views. An empty array
// yields an empty store (sentinel matches nothing), NOT the full aggregation.
function getAggregatedStore(suffixFilter) {
  const agg = { users: {}, daily: {}, dailyModels: {}, dailyHourly: {}, models: {}, hourly: {}, errors: [] };
  const hasFilter = Array.isArray(suffixFilter);
  const binds = hasFilter ? (suffixFilter.length ? suffixFilter : ["\u0000none"]) : [];
  const profilePred = hasFilter ? `profile IN (${binds.map(() => "?").join(",")})` : "";
  // extra 是该查询自己的额外谓词(如 "date >= ?"),与 profile 过滤一起拼成合法的 WHERE。
  // 不能写成「__WHERE__ AND date >= ?」—— 不带 profile 过滤时那一格是空串,会拼出
  // 「FROM t  AND date >= ?」这种非法 SQL。绑定值顺序与谓词顺序一致(profile 在前)。
  const q = (sql, extra = "", ...extraBinds) => {
    const preds = [profilePred, extra].filter(Boolean).join(" AND ");
    return db.prepare(sql.replace("__WHERE__", preds ? `WHERE ${preds}` : "")).all(...binds, ...extraBinds);
  };

  // users: GROUP BY user_key across all profiles
  for (const r of q(`SELECT user_key, MAX(name) AS name, SUM(total_input) AS ti, SUM(total_output) AS tout, SUM(total_requests) AS tr, SUM(cache_creation) AS cc, SUM(cache_read) AS cr, MAX(last_active) AS la FROM users __WHERE__ GROUP BY user_key`)) {
    agg.users[r.user_key] = { name: r.name, totalInputTokens: r.ti||0, totalOutputTokens: r.tout||0, totalRequests: r.tr||0, cacheCreationTokens: r.cc||0, cacheReadTokens: r.cr||0, lastActive: r.la };
  }
  // daily: GROUP BY date, user_key
  for (const r of q(`SELECT date, user_key, SUM(input_tokens) AS ti, SUM(output_tokens) AS tout, SUM(requests) AS tr, SUM(cache_creation) AS cc, SUM(cache_read) AS cr FROM usage_daily __WHERE__ GROUP BY date, user_key`)) {
    if (!agg.daily[r.date]) agg.daily[r.date] = {};
    agg.daily[r.date][r.user_key] = { inputTokens: r.ti||0, outputTokens: r.tout||0, requests: r.tr||0, cacheCreationTokens: r.cc||0, cacheReadTokens: r.cr||0 };
  }
  // models: GROUP BY model
  for (const r of q(`SELECT model, SUM(tokens) AS t, SUM(requests) AS r FROM usage_model __WHERE__ GROUP BY model`)) {
    agg.models[r.model] = { tokens: r.t||0, requests: r.r||0 };
  }
  // hourly: GROUP BY date, hour。只有这一张按小时的表需要日期下界(理由见 hourlyChartFloor):
  // usage_daily / usage_daily_model / usage_daily_hourly 都不加 —— 前两张喂可自定义日期范围的
  // 周期图,第三张已被 7 天清理砍到很小。
  for (const r of q(`SELECT date, hour, SUM(requests) AS r, SUM(input_tokens) AS ti, SUM(output_tokens) AS tout, SUM(cache_creation) AS cc, SUM(cache_read) AS cr FROM usage_hourly __WHERE__ GROUP BY date, hour`, "date >= ?", hourlyChartFloor())) {
    if (!agg.hourly[r.date]) agg.hourly[r.date] = {};
    agg.hourly[r.date][r.hour] = { requests: r.r||0, inputTokens: r.ti||0, outputTokens: r.tout||0, cacheCreationTokens: r.cc||0, cacheReadTokens: r.cr||0 };
  }
  // dailyModels: GROUP BY date, user_key, model
  for (const r of q(`SELECT date, user_key, model, SUM(input_tokens) AS ti, SUM(output_tokens) AS tout, SUM(requests) AS tr FROM usage_daily_model __WHERE__ GROUP BY date, user_key, model`)) {
    if (!agg.dailyModels[r.date]) agg.dailyModels[r.date] = {};
    if (!agg.dailyModels[r.date][r.user_key]) agg.dailyModels[r.date][r.user_key] = {};
    agg.dailyModels[r.date][r.user_key][r.model] = { inputTokens: r.ti||0, outputTokens: r.tout||0, requests: r.tr||0 };
  }
  // dailyHourly: GROUP BY date, user_key, hour
  for (const r of q(`SELECT date, user_key, hour, SUM(requests) AS r, SUM(input_tokens) AS ti, SUM(output_tokens) AS tout, SUM(cache_creation) AS cc, SUM(cache_read) AS cr FROM usage_daily_hourly __WHERE__ GROUP BY date, user_key, hour`)) {
    if (!agg.dailyHourly[r.date]) agg.dailyHourly[r.date] = {};
    if (!agg.dailyHourly[r.date][r.user_key]) agg.dailyHourly[r.date][r.user_key] = {};
    agg.dailyHourly[r.date][r.user_key][r.hour] = { requests: r.r||0, inputTokens: r.ti||0, outputTokens: r.tout||0, cacheCreationTokens: r.cc||0, cacheReadTokens: r.cr||0 };
  }
  // errors: merge all profiles (most recent 200)
  agg.errors = q(`SELECT time, user_name AS user, user_key AS userKey, status_code AS statusCode, error, path, model FROM errors __WHERE__ ORDER BY id DESC LIMIT 200`);
  return agg;
}

// Per-user × per-profile quota state for the "all profiles" dashboard view.
// Without this the quota column is empty unless you drill into one profile, so
// the one question an admin opens the dashboard to answer — "who is close to
// their limit?" — costs N clicks across N profiles.
//
// Returns { profiles, matrix }: `profiles` is the ordered list of profiles that
// have a quota at all (so the table can render them as COLUMNS, naming each
// profile once instead of repeating it under every user), and `matrix` is keyed
// by MASKED user key to line up with sanitizeStore's users map.
function getUserQuotaMatrix(suffixFilter) {
  // Columns are now POOLS, not profiles — a pool is the billing boundary, and two
  // profiles in one pool would otherwise produce two columns that always read
  // identically. One column per pool also solves the crowding from profile sprawl.
  const matrix = {};
  const pools = [];
  const hasFilter = Array.isArray(suffixFilter);
  for (const pool of listQuotaPools()) {
    // Filter by protocol: a pool is shown if ANY member passes the filter.
    if (hasFilter && !pool.profiles.some(m => suffixFilter.includes(m.suffix))) continue;
    // Use the first member profile as the representative runtime for quota math;
    // checkTokenQuota already aggregates across the whole pool.
    const rep = pool.profiles.find(m => runtimes[m.suffix]) || pool.profiles[0];
    const runtime = runtimes[rep.suffix];
    if (!runtime) continue;
    let anyQuota = false;
    for (const key of Object.keys(runtime.users || {})) {
      if (!canUseProfile(key, runtime).allowed) continue;
      const eff = checkTokenQuota(key, rep.suffix, runtime);
      if (!(eff.limit > 0)) continue;   // unlimited: nothing to show
      anyQuota = true;
      const masked = key.slice(0, 8) + "****";
      if (!matrix[masked]) matrix[masked] = {};
      matrix[masked][pool.name] = {
        limit: eff.limit,
        used: eff.used,
        remaining: eff.remaining,
        pct: Math.min(100, Math.round((eff.used / eff.limit) * 100)),
        bonus: eff.bonus || 0,
        resetApplied: !!eff.resetApplied,
        rawUsed: eff.rawUsed,
        rate: eff.rate,
        source: eff.source,
        poolLabel: eff.poolLabel,
        poolProfiles: (eff.poolProfiles || []).length,
      };
    }
    if (anyQuota) {
      pools.push({
        key: pool.name,
        name: pool.name,
        label: pool.label,
        billingType: pool.profiles[0]?.billingType || "on_demand",
        protocol: pool.profiles[0]?.protocol,
        memberNames: pool.profiles.map(m => m.name),
        memberCount: pool.profiles.length,
      });
    }
  }
  return { pools, matrix };
}

// One row per profile×model, pairing the configured rates with today's realised
// cost. The dashboard's model chart can only plot one number per model, so the
// rate story needs a table: without it an admin cannot answer "which model is
// draining quota fastest" — the expensive model is not necessarily the busiest.
function getModelRateBoard(suffixFilter) {
  const today = cnDate();
  const usage = {};   // suffix → model → { raw, weighted, requests }
  const hasFilter = Array.isArray(suffixFilter);
  const binds = hasFilter ? (suffixFilter.length ? suffixFilter : ["\u0000none"]) : [];
  const where = hasFilter ? `AND profile IN (${binds.map(() => "?").join(",")})` : "";
  const rows = db.prepare(
    `SELECT profile, model, SUM(requests) AS r, SUM(input_tokens+output_tokens) AS raw, SUM(weighted_tokens) AS w
     FROM usage_daily_model WHERE date=? ${where} GROUP BY profile, model`
  ).all(today, ...binds);
  for (const r of rows) {
    if (!usage[r.profile]) usage[r.profile] = {};
    usage[r.profile][r.model] = { raw: r.raw || 0, weighted: r.w || 0, requests: r.r || 0 };
  }

  const out = [];
  for (const [name, profile] of Object.entries(config.profiles || {})) {
    const suffix = normalizeProfileSuffix(profile.suffix);
    const runtime = runtimes[suffix];
    if (!runtime) continue;
    if (hasFilter && !suffixFilter.includes(suffix)) continue;
    const inPeak = isInPeakHours(runtime.peakHours);
    const rates = runtime.modelQuotaRates || {};
    const aliases = getProfileModelAliases(profile);
    const peakAliases = normalizeModelAliases(profile.peakModelAliases || {});
    // Union of: models any alias points at (default or peak), models with an
    // explicit rate, and models that actually served traffic today. The last one
    // matters — a model retired from the alias list can still be in today's rows.
    const byModel = new Map();
    const note = (model, alias, isPeakAlias) => {
      if (!model) return;
      if (!byModel.has(model)) byModel.set(model, { aliases: [], peakOnly: [] });
      const entry = byModel.get(model);
      if (alias) (isPeakAlias ? entry.peakOnly : entry.aliases).push(alias);
    };
    for (const [alias, model] of Object.entries(aliases)) note(model, alias, false);
    for (const [alias, model] of Object.entries(peakAliases)) note(model, alias, true);
    for (const model of Object.keys(rates)) note(model, null, false);
    for (const model of Object.keys(usage[suffix] || {})) note(model, null, false);

    for (const [model, meta] of byModel) {
      const override = lookupModelQuotaRate(rates, model);
      const used = (usage[suffix] || {})[model] || { raw: 0, weighted: 0, requests: 0 };
      out.push({
        profile: name,
        suffix,
        model,
        aliases: meta.aliases,
        peakAliases: meta.peakOnly,
        custom: !!override,
        peak: override ? override.peak : normalizeQuotaRate(runtime.peakQuotaRate),
        offPeak: override ? override.offPeak : normalizeQuotaRate(runtime.offPeakQuotaRate),
        rate: currentQuotaRate(runtime, new Date(), model),
        inPeak,
        todayRaw: used.raw,
        todayWeighted: used.weighted,
        todayRequests: used.requests,
      });
    }
  }
  // Costliest-right-now first: that is the row an admin needs to see.
  out.sort((a, b) => b.rate - a.rate || b.todayWeighted - a.todayWeighted || a.model.localeCompare(b.model));
  return out;
}

// Load hourly-per-model usage for the 24h model trend chart. `suffix` null =
// all profiles; `suffixFilter` (array) narrows to a protocol when no single
// suffix is given. Shape: { date: { hour: { model: { requests, inputTokens, outputTokens } } } }
// (already aggregated across users; no cache columns — same scope as usage_daily_model).
function loadHourlyModels(suffix, suffixFilter) {
  const out = {};
  // 谓词用数组攒、再拼 WHERE。这张表**总是**带日期下界(见 hourlyChartFloor)——
  // 它同样只喂 24 小时模型图,窗口外的历史日期发过去就被前端丢掉。
  const preds = [];
  const binds = [];
  if (suffix) {
    preds.push("profile=?");
    binds.push(suffix);
  } else if (Array.isArray(suffixFilter)) {
    const list = suffixFilter.length ? suffixFilter : ["\u0000none"];
    preds.push(`profile IN (${list.map(() => "?").join(",")})`);
    binds.push(...list);
  }
  preds.push("date >= ?");
  binds.push(hourlyChartFloor());
  const sql = `SELECT date, hour, model, SUM(requests) AS r, SUM(input_tokens) AS ti, SUM(output_tokens) AS tout
    FROM usage_hourly_model WHERE ${preds.join(" AND ")} GROUP BY date, hour, model`;
  const rows = db.prepare(sql).all(...binds);
  for (const row of rows) {
    if (!out[row.date]) out[row.date] = {};
    if (!out[row.date][row.hour]) out[row.date][row.hour] = {};
    out[row.date][row.hour][row.model] = { requests: row.r || 0, inputTokens: row.ti || 0, outputTokens: row.tout || 0 };
  }
  return out;
}

// Load per-profile daily usage (with cache) for the profile request chart.
// Covers ALL profiles by default — the chart is a cross-profile dimension;
// `suffixFilter` narrows it to one protocol's profiles.
// Shape: { [suffix]: { [date]: { requests, inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } } }
function loadProfileDaily(suffixFilter) {
  const out = {};
  const hasFilter = Array.isArray(suffixFilter);
  const binds = hasFilter ? (suffixFilter.length ? suffixFilter : ["\u0000none"]) : [];
  const where = hasFilter ? `WHERE profile IN (${binds.map(() => "?").join(",")})` : "";
  const sql = `SELECT profile, date, SUM(requests) AS r, SUM(input_tokens) AS ti, SUM(output_tokens) AS tout, SUM(cache_creation) AS cc, SUM(cache_read) AS cr FROM usage_daily ${where} GROUP BY profile, date`;
  for (const r of db.prepare(sql).all(...binds)) {
    if (!out[r.profile]) out[r.profile] = {};
    out[r.profile][r.date] = { requests: r.r || 0, inputTokens: r.ti || 0, outputTokens: r.tout || 0, cacheCreationTokens: r.cc || 0, cacheReadTokens: r.cr || 0 };
  }
  return out;
}

// Load per-profile daily per-model usage (no cache) — used by the profile
// request chart when a model filter is active. Same filtering as loadProfileDaily.
// Shape: { [suffix]: { [date]: { [model]: { requests, inputTokens, outputTokens } } } }
function loadProfileDailyModels(suffixFilter) {
  const out = {};
  const hasFilter = Array.isArray(suffixFilter);
  const binds = hasFilter ? (suffixFilter.length ? suffixFilter : ["\u0000none"]) : [];
  const where = hasFilter ? `WHERE profile IN (${binds.map(() => "?").join(",")})` : "";
  const sql = `SELECT profile, date, model, SUM(requests) AS r, SUM(input_tokens) AS ti, SUM(output_tokens) AS tout FROM usage_daily_model ${where} GROUP BY profile, date, model`;
  for (const r of db.prepare(sql).all(...binds)) {
    if (!out[r.profile]) out[r.profile] = {};
    if (!out[r.profile][r.date]) out[r.profile][r.date] = {};
    out[r.profile][r.date][r.model] = { requests: r.r || 0, inputTokens: r.ti || 0, outputTokens: r.tout || 0 };
  }
  return out;
}

// Suffixes of every profile running one protocol. Feeds /api/stats?protocol=
// so the dashboard can split Anthropic vs Responses views without any schema
// change — the stats tables only know the profile suffix.
function protocolSuffixes(proto) {
  const out = [];
  for (const profile of Object.values(config.profiles || {})) {
    if (normalizeProfileProtocol(profile.protocol) !== proto) continue;
    const suffix = normalizeProfileSuffix(profile.suffix);
    if (suffix && runtimes[suffix]) out.push(suffix);
  }
  return out;
}

function getProfileSummaries() {
  const today = cnDate();
  return listProfiles().map(profile => {
    const runtime = runtimes[profile.suffix];
    const row = stmts.profileSummaryToday.get(profile.suffix, today);
    return {
      name: profile.name,
      suffix: profile.suffix,
      protocol: profile.protocol,
      isDefault: profile.isDefault,
      isResponsesDefault: !!profile.inResponsesGroup && profile.responsesGroupOrder === 0,
      billingType: profile.billingType,
      peakHours: normalizePeakHours(profile.peakHours),
      peakQuotaRate: profile.peakQuotaRate,
      offPeakQuotaRate: profile.offPeakQuotaRate,
      modelQuotaRates: profile.modelQuotaRates || {},
      upstream: profile.upstream,
      userCount: profile.userCount,
      todayTokens: row.tokens || 0,
      todayRequests: row.requests || 0,
      breakerState: runtime?.breaker?.status().state || "UNKNOWN",
      // Seconds until the next automatic probe, so the dashboard can say "熔断中
      // (12s 后探测)" rather than implying a dead end.
      breakerCooldownRemaining: runtime?.breaker?.status().cooldownRemaining || 0,
      rateLimit: getRateLimitInfo(profile.name),
      inDefaultGroup: profile.inDefaultGroup,
      groupOrder: profile.groupOrder,
      inResponsesGroup: profile.inResponsesGroup,
      responsesGroupOrder: profile.responsesGroupOrder,
    };
  });
}

  return {
    getAggregatedStore,
    getUserQuotaMatrix,
    getModelRateBoard,
    loadHourlyModels,
    loadProfileDaily,
    loadProfileDailyModels,
    protocolSuffixes,
    getProfileSummaries,
  };
}
