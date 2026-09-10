// lib/quota.mjs —— 配额倍率 / 额度池命名 / 粘性会话 的纯计算核心。零外部依赖。
// 服务端可复用逻辑，仅由入参（或 runtime 对象 / config 片段）驱动，不含任何
// SQLite、网络或模块级可变状态；需要 db.stmts 的配额校验留在 server.mjs。
import crypto from "node:crypto";
import { isInPeakHours, normalizePeakHours, parsePeakTimeMinutes } from "./schedule.mjs";

// Anchor convention: 1.0 = "one peak-hour token at the profile's default rate" —
// keeping one slot at 1.0 is what gives the nominal dailyTokenLimit a meaning.
export const QUOTA_RATE_MAX = 10;

export function normalizeQuotaRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(QUOTA_RATE_MAX, Math.max(0, n)) * 100) / 100;
}

// Cache-hit quota share (per profile). Responses/OpenAI upstreams report cached
// reads INSIDE input_tokens (cached_tokens is the subset); this is the fraction
// of that cache-read slice that still counts toward quota. 0 = mirror Anthropic
// (cache hits free — the default), 1 = legacy (cache billed in full), 0..1 =
// partial. A no-op on anthropic-protocol profiles, whose input_tokens never
// contain cache reads in the first place.
export function normalizeCacheReadQuotaRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
}

// Per-model overrides, keyed by the REAL upstream model name (not the alias):
// { "glm-5.3-flash": { peak: 0.3, offPeak: 0.15 } }
// Real model names are what recordUsage receives from the upstream response and
// what the usage_*_model tables store, so this key survives peak-alias overrides
// that make two aliases resolve to the same model.
export function normalizeModelQuotaRates(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [model, entry] of Object.entries(raw)) {
    const name = String(model || "").trim();
    if (!name || !entry || typeof entry !== "object") continue;
    out[name] = {
      peak: normalizeQuotaRate(entry.peak),
      offPeak: normalizeQuotaRate(entry.offPeak),
    };
  }
  return out;
}

// Model lookup mirrors resolveModel's tolerance: exact match first, then a
// case-insensitive sweep, so a rate configured as "GLM-5.3" still applies when
// the upstream echoes "glm-5.3".
export function lookupModelQuotaRate(rates, model) {
  if (!rates || !model) return null;
  if (rates[model]) return rates[model];
  const lower = String(model).toLowerCase();
  for (const [name, entry] of Object.entries(rates)) {
    if (name.toLowerCase() === lower) return entry;
  }
  return null;
}

// `peakHours` empty ⇒ isInPeakHours is always false ⇒ the off-peak rate applies
// all day. Deliberate ("no peak defined = everything is off-peak"), and the
// settings page warns when that combination would silently discount 24h.
// `model` is optional: pass the real upstream model to honour its per-model
// override, omit it to get the profile's default rate for the current slot.
export function currentQuotaRate(runtime, date = new Date(), model = null) {
  if (!runtime) return 1;
  const inPeak = isInPeakHours(runtime.peakHours, date);
  const override = lookupModelQuotaRate(runtime.modelQuotaRates, model);
  if (override) return inPeak ? override.peak : override.offPeak;
  return inPeak
    ? normalizeQuotaRate(runtime.peakQuotaRate)
    : normalizeQuotaRate(runtime.offPeakQuotaRate);
}

// Next moment the rate changes, so a quota-exceeded message can tell the user
// when relief arrives ("20:00 后转入低谷 ×0.5"). Returns null when there is no
// boundary worth mentioning (no peak hours, or both rates identical for the
// model in question).
export function nextRateChangeHint(runtime, date = new Date(), model = null) {
  if (!runtime) return null;
  const override = lookupModelQuotaRate(runtime.modelQuotaRates, model);
  const peakRate = override ? override.peak : normalizeQuotaRate(runtime.peakQuotaRate);
  const offRate = override ? override.offPeak : normalizeQuotaRate(runtime.offPeakQuotaRate);
  if (peakRate === offRate) return null;
  const ranges = normalizePeakHours(runtime.peakHours);
  if (ranges.length === 0) return null;

  const nowMin = Math.floor(((date.getTime() + 8 * 3600000) % 86400000) / 60000);
  const inPeak = isInPeakHours(ranges, date);
  // Every range start/end is a potential switch point; the next one in Beijing
  // minutes-of-day (wrapping past midnight) that flips the current state wins.
  let bestDelta = Infinity, bestMin = null;
  for (const r of ranges) {
    for (const t of [parsePeakTimeMinutes(r.start), parsePeakTimeMinutes(r.end)]) {
      if (t === null) continue;
      const delta = (t - nowMin + 1440) % 1440;
      if (delta === 0) continue;
      const stateAfter = isInPeakHours(ranges, new Date(date.getTime() + delta * 60000));
      if (stateAfter === inPeak) continue;
      if (delta < bestDelta) { bestDelta = delta; bestMin = t; }
    }
  }
  if (bestMin === null) return null;
  const at = `${String(Math.floor(bestMin / 60)).padStart(2, "0")}:${String(bestMin % 60).padStart(2, "0")}`;
  return { at, rate: inPeak ? offRate : peakRate, toPeak: !inPeak };
}

// 额度池名称规范化：去首尾空白、截断到上限。上限与配额倍率一样是全局约定，
// 池命名必须全库一致，故随本核心一起导出（UI 模板也引用该上限）。
export const QUOTA_POOL_NAME_MAX = 40;

export function normalizeQuotaPoolName(value) {
  return String(value || "").trim().slice(0, QUOTA_POOL_NAME_MAX);
}

// ── 粘性会话：确定性摘要 + 纯重排 ────────────────────────────────────────────
// Deterministic JSON regardless of the client's key ordering.
export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalJson(value[k]);
    return out;
  }
  return value;
}

export function shortDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex").slice(0, 16);
}

// Move a live binding to the front of the ordered candidate list. Pure reorder:
// the list was already availability-filtered by the caller.
export function applyStickyReorder(candidates, boundProfile) {
  if (!boundProfile || candidates.length < 2) return candidates;
  const idx = candidates.findIndex(c => c.name === boundProfile);
  if (idx <= 0) return candidates;
  const [bound] = candidates.splice(idx, 1);
  return [bound, ...candidates];
}

// ── 额度池解析器（工厂注入 config）─────────────────────────────────────────────
// server.mjs 里的配额函数靠这些解析把"方案 → 池"对应关系查出来。config 是运行时可变的
// 对象（管理员在设置页增删额度池），故以工厂注入、闭包内始终读同一对象引用，保证实时。
// 依赖 normalizeProfileSuffix / normalizeProfileProtocol / getProfileNameBySuffix（留在
// server.mjs，因路由与建方案等其他路径也需要）由调用方传入。
export function buildPoolResolver({ config, getProfileNameBySuffix, normalizeProfileSuffix, normalizeProfileProtocol }) {
  // Profile that a profile suffix maps back to — shared by pool resolution.
  function resolvePoolName(profileName) {
    const profile = config.profiles?.[profileName];
    if (!profile) return "";
    const name = normalizeQuotaPoolName(profile.quotaPool);
    if (name && config.quotaPools?.[name]) return name;
    const fallback = normalizeQuotaPoolName(profileName) || "pool";
    if (!config.quotaPools) config.quotaPools = {};
    if (!config.quotaPools[fallback]) {
      config.quotaPools[fallback] = { label: profileName, dailyTokenLimit: null, users: {} };
      console.warn(`[QuotaPool] 方案 "${profileName}" 指向不存在的额度池 "${name}"，已自动重建空池 "${fallback}"（不限额）`);
    }
    profile.quotaPool = fallback;
    return fallback;
  }

  function getPoolByName(name) {
    const pool = config.quotaPools?.[normalizeQuotaPoolName(name)];
    if (!pool) return null;
    if (!pool.users || typeof pool.users !== "object") pool.users = {};
    return pool;
  }

  function getPoolForSuffix(suffix) {
    const sfx = normalizeProfileSuffix(suffix);
    const profileName = getProfileNameBySuffix(sfx);
    if (!profileName) return { name: "", pool: null };
    const name = resolvePoolName(profileName);
    return { name, pool: getPoolByName(name) };
  }

  function getPoolSuffixes(poolName) {
    const name = normalizeQuotaPoolName(poolName);
    const out = [];
    for (const profileName of Object.keys(config.profiles || {})) {
      if (resolvePoolName(profileName) !== name) continue;
      const sfx = normalizeProfileSuffix(config.profiles[profileName].suffix);
      if (sfx) out.push(sfx);
    }
    return out;
  }

  function listQuotaPools() {
    return Object.entries(config.quotaPools || {}).map(([name, pool]) => {
      const members = Object.keys(config.profiles || {}).filter(p => resolvePoolName(p) === name);
      const memberUsers = {};
      for (const memberName of members) {
        for (const [uk, u] of Object.entries(config.profiles[memberName]?.users || {})) {
          const hasKey = typeof u === "string" ? !!u : !!(u && u.key);
          if (!hasKey) continue;
          if (!memberUsers[uk]) memberUsers[uk] = {
            username: (config.users?.[uk]?.username) || uk.slice(0, 8),
            dailyTokenLimit: (pool.users?.[uk]?.dailyTokenLimit) ?? null,
          };
        }
      }
      return {
        name,
        label: pool.label || name,
        dailyTokenLimit: pool.dailyTokenLimit ?? null,
        userLimits: Object.fromEntries(Object.entries(pool.users || {})
          .filter(([, v]) => v && v.dailyTokenLimit != null)
          .map(([k, v]) => [k, v.dailyTokenLimit])),
        memberUsers,
        profiles: members.map(name2 => ({
          name: name2,
          suffix: normalizeProfileSuffix(config.profiles[name2].suffix),
          protocol: normalizeProfileProtocol(config.profiles[name2].protocol),
          billingType: config.profiles[name2].billingType || "on_demand",
        })),
      };
    });
  }

  return { resolvePoolName, getPoolByName, getPoolForSuffix, getPoolSuffixes, listQuotaPools };
}

// ── 配额判超文案 ───────────────────────────────────────────────────────────────
// 纯字符串构造：只依赖传入的 quota 载荷 / runtime / usageUrl。与 nextRateChangeHint
// 同在本模块，可直接引用。
export function quotaExceededMessage(quota, runtime, usageUrl) {
  const skew = quota.rawUsed != null ? quota.rawUsed - quota.used : 0;
  const weighted = skew !== 0 || (quota.rate !== undefined && quota.rate !== 1);
  // Naming the pool matters when it is shared: a user blocked in Codex needs to
  // learn that Claude Code traffic is drawing from the same allowance.
  const poolNote = quota.poolShared && quota.poolLabel
    ? `（额度池「${quota.poolLabel}」，${quota.poolProfiles.length} 个方案共用）` : "";
  const lines = [weighted
    ? `今日配额已用尽：${quota.used.toLocaleString()} / ${quota.limit.toLocaleString()}（计权）${poolNote}`
    : `今日Token额度已用完。已用: ${quota.used.toLocaleString()}, 限额: ${quota.limit.toLocaleString()}。${poolNote}`];
  if (skew !== 0) {
    lines.push(`实际 token ${quota.rawUsed.toLocaleString()}，` +
      (skew > 0 ? `已抵扣 ${skew.toLocaleString()}` : `已加收 ${(-skew).toLocaleString()}`));
  }
  if (quota.cacheInInput && (quota.cacheRead || 0) > 0 && (quota.cacheReadQuotaRate ?? 0) < 1) {
    lines.push((quota.cacheReadQuotaRate > 0
      ? `缓存命中 ${quota.cacheRead.toLocaleString()} 按 ×${quota.cacheReadQuotaRate} 计入`
      : `缓存命中 ${quota.cacheRead.toLocaleString()} 不计入配额（Responses 已对齐 Anthropic 口径）`));
  }
  if (weighted) {
    const slot = quota.inPeak ? "高峰" : "低谷";
    const hint = nextRateChangeHint(runtime, new Date(), quota.model);
    lines.push(`当前${runtime?.profileName ? ` ${runtime.profileName}` : ""} ${slot} ×${quota.rate}` +
      (quota.model && !quota.rateIsDefault ? `（${quota.model} 单独定价）` : "") +
      (hint ? ` · ${hint.at} 后转入${hint.toPeak ? "高峰" : "低谷"} ×${hint.rate}` : ""));
  }
  lines.push(`额度将于北京时间次日凌晨重置。查看用量详情: ${usageUrl}`);
  return lines.join("\n");
}

export function quotaErrorDetail(quota) {
  const skew = quota.rawUsed != null ? quota.rawUsed - quota.used : 0;
  const poolNote = quota.poolShared ? ` pool=${quota.pool}(${quota.poolProfiles.join("+")})` : "";
  const extra = skew !== 0 ? `, raw ${quota.rawUsed} (${skew > 0 ? "-" : "+"}${Math.abs(skew)} @×${quota.rate})` : "";
  return `quota_exceeded: ${quota.used}/${quota.limit}${extra}${poolNote}`;
}

// ── 配额数据读取（工厂注入 db / 池解析器）──────────────────────────────────────
// 三个只读叶子查询：pooledUsageForQuota 按池聚合当日计权用量，getPoolQuota /
// getUserPoolQuota 读池与个人的配额上限。预编译语句按成员数缓存在工厂闭包内，
// 便于 reloadAllRuntimes 通过 clearPooledUsageCache() 失效重建。
export function buildQuotaCore({ db, getPoolByName }) {
  const pooledUsageStmts = new Map();

  function pooledUsageForQuota(suffixes, date, key) {
    if (!suffixes.length) return { used: 0, raw: 0, cr: 0 };
    let stmt = pooledUsageStmts.get(suffixes.length);
    if (!stmt) {
      const holes = suffixes.map(() => "?").join(",");
      stmt = db.prepare(`SELECT COALESCE(SUM(weighted_tokens),0) AS used, COALESCE(SUM(input_tokens+output_tokens),0) AS raw,
        COALESCE(SUM(cache_read),0) AS cr
        FROM usage_daily WHERE date=? AND user_key=? AND profile IN (${holes})`);
      pooledUsageStmts.set(suffixes.length, stmt);
    }
    return stmt.get(date, key, ...suffixes);
  }

  function getPoolQuota(poolName) {
    const pool = getPoolByName(poolName);
    if (!pool || !pool.dailyTokenLimit) return 0;
    return pool.dailyTokenLimit;
  }

  function getUserPoolQuota(poolName, userKey) {
    const pool = getPoolByName(poolName);
    const pu = pool?.users?.[userKey];
    if (!pu || typeof pu !== "object" || !pu.dailyTokenLimit) return 0;
    return pu.dailyTokenLimit;
  }

  function clearPooledUsageCache() { pooledUsageStmts.clear(); }

  return { pooledUsageForQuota, getPoolQuota, getUserPoolQuota, clearPooledUsageCache };
}