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