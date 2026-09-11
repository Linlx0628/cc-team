import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { initProductionDb, createProductionTracker, rangeFromTo, productionSummary, productionUserDetail,
  productionProjects, productionAlerts, markAlertSeen, pruneProductionData, DEFAULT_COST_RATES,
  computeCosts, contextHealth, buildReportHTML, ALERT_KIND_LABEL, alertDetailText } from "./production.mjs";
import { cnNow, cnDate, cnHour, secondsUntilNextCnMidnight, cnWeekStartIso, cnDayStartIso } from "./lib/time.mjs";
import { parsePeakTimeMinutes, normalizePeakHours, isInPeakHours, formatPeakHoursSummary } from "./lib/schedule.mjs";
import { sanitizeJson } from "./lib/sanitize.mjs";
import { buildStatements } from "./lib/db.mjs";
import { QUOTA_RATE_MAX, normalizeQuotaRate, normalizeCacheReadQuotaRate, normalizeModelQuotaRates, lookupModelQuotaRate, currentQuotaRate, nextRateChangeHint, QUOTA_POOL_NAME_MAX, normalizeQuotaPoolName, canonicalJson, shortDigest, applyStickyReorder, buildPoolResolver, quotaExceededMessage, quotaErrorDetail, buildQuotaCore } from "./lib/quota.mjs";
import { CB_MAX_BACKOFF_FACTOR, CB_MAX_COOLDOWN_MS, CircuitBreaker } from "./lib/circuit.mjs";
import { loadAssets } from "./lib/assets.mjs";
import { escHtml, escJs } from "./lib/html.mjs";
import { settingsHtml, dashboardHtml, loginHtml, personalUsageLandingHtml, codexSetupHtml, personalUsageHtml } from "./lib/pages.mjs";
import { buildCodexModelCatalog, buildCodexSetupScript, buildCodexSetupScriptWin } from "./lib/codex-setup-script.mjs";
import { createStatsReader } from "./lib/stats.mjs";
import { createSettingsWriter } from "./lib/settings-write.mjs";
import { createUsageReader } from "./lib/personal-usage.mjs";

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
  const tempPath = `${configPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(cfg, null, 2), "utf-8");
  fs.renameSync(tempPath, configPath);
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
const RESERVED_SUFFIXES = new Set(["dashboard", "settings", "api", "health", "usage", "my-usage", "v1", "login", "logout", "favicon", "robots", "js", "css", "responses", "models"]);
const PROFILE_SUFFIX_RE = /^[a-z0-9_-]{2,20}$/;

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
    userCount: Object.keys(config.profiles[name].users || {}).length,
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
    toolPatternCompat: normalizeToolPatternCompat(profile.toolPatternCompat),
    toolPatternsActive: computeToolPatternsActive(profile, upstreamUrl),
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
// 命中率计算要区分协议:Responses/Codex 的 input_tokens 含缓存读,Anthropic 不含。
// 给 contextHealth 传「将其 input_tokens 视为含缓存的 profile 后缀集合」。
// runtimes 的 key 与 usage_daily.profile 同用 normalizeProfileSuffix 规约,可直接比对。
function responsesProfileSet() {
  const s = new Set();
  for (const [suffix, runtime] of Object.entries(runtimes)) if (runtime?.protocol === "responses") s.add(suffix);
  return s;
}

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
  // Mask user keys in dailyModels / dailyHourly the same way as s.daily so the
  // dashboard's user filter (keyed on masked keys) applies to model/hour dimensions too.
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
  s.dailyHourly = maskByUser(s.dailyHourly);
  if (Array.isArray(s.errors)) {
    s.errors = s.errors.map(e => { const { userKey, ...rest } = e; return rest; });
  }
  return s;
}

// ─── SQLite Persistence (multi-table, incremental) ──────────────────────────
// All usage/error data lives in normalized SQLite tables. Writes are incremental
// UPSERTs (ON CONFLICT ... DO UPDATE SET x = x + ?), reads use GROUP BY + SUM.
// There is no in-memory `store` object anymore — every read goes to the DB.
let db = null;
let stmts = {};   // prepared statements, populated by initDb()

function initDb() {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");      // crash-safe + concurrent reads don't block writes
  db.pragma("synchronous = NORMAL");    // WAL mode: safe against app crashes, fast
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      profile TEXT NOT NULL, user_key TEXT NOT NULL, name TEXT NOT NULL,
      total_input INTEGER DEFAULT 0, total_output INTEGER DEFAULT 0,
      total_requests INTEGER DEFAULT 0, cache_creation INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0, last_active TEXT,
      PRIMARY KEY (profile, user_key)
    );
    CREATE TABLE IF NOT EXISTS usage_daily (
      profile TEXT NOT NULL, date TEXT NOT NULL, user_key TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      requests INTEGER DEFAULT 0, cache_creation INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0,
      weighted_tokens INTEGER DEFAULT 0,
      PRIMARY KEY (profile, date, user_key)
    );
    CREATE TABLE IF NOT EXISTS usage_daily_model (
      profile TEXT NOT NULL, date TEXT NOT NULL, user_key TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, requests INTEGER DEFAULT 0,
      weighted_tokens INTEGER DEFAULT 0,
      PRIMARY KEY (profile, date, user_key, model)
    );
    CREATE TABLE IF NOT EXISTS usage_daily_hourly (
      profile TEXT NOT NULL, date TEXT NOT NULL, user_key TEXT NOT NULL, hour TEXT NOT NULL,
      requests INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_creation INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0,
      weighted_tokens INTEGER DEFAULT 0,
      PRIMARY KEY (profile, date, user_key, hour)
    );
    CREATE TABLE IF NOT EXISTS usage_model (
      profile TEXT NOT NULL, model TEXT NOT NULL,
      tokens INTEGER DEFAULT 0, requests INTEGER DEFAULT 0,
      PRIMARY KEY (profile, model)
    );
    CREATE TABLE IF NOT EXISTS usage_hourly (
      profile TEXT NOT NULL, date TEXT NOT NULL, hour TEXT NOT NULL,
      requests INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_creation INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0,
      PRIMARY KEY (profile, date, hour)
    );
    CREATE TABLE IF NOT EXISTS usage_hourly_model (
      profile TEXT NOT NULL, date TEXT NOT NULL, user_key TEXT NOT NULL,
      hour TEXT NOT NULL, model TEXT NOT NULL,
      requests INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_creation INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0,
      PRIMARY KEY (profile, date, user_key, hour, model)
    );
    -- 峰谷成本走小时表按 date 范围扫描,主键前缀 (profile,date,...) 不带 profile 前导时用不上
    CREATE INDEX IF NOT EXISTS idx_usage_hourly_model_date ON usage_hourly_model(date);
    CREATE INDEX IF NOT EXISTS idx_usage_daily_model_date ON usage_daily_model(date);
    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile TEXT NOT NULL, time TEXT NOT NULL,
      user_name TEXT, user_key TEXT, status_code INTEGER,
      error TEXT, path TEXT, model TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_errors_profile_time ON errors(profile, time);
    CREATE TABLE IF NOT EXISTS quota_adjust_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_key TEXT NOT NULL, user_name TEXT, date TEXT NOT NULL,
      old_quota INTEGER, new_quota INTEGER, hit_rate REAL,
      avg_daily_usage INTEGER, auto INTEGER DEFAULT 1, time TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS image_bridge_cache (
      hash TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quota_daily_ops (
      pool TEXT NOT NULL, user_key TEXT NOT NULL, date TEXT NOT NULL,
      bonus INTEGER NOT NULL DEFAULT 0,
      reset_baseline INTEGER NOT NULL DEFAULT 0,
      reset_time TEXT,
      updated_at TEXT,
      PRIMARY KEY (pool, user_key, date)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(time);
    CREATE TABLE IF NOT EXISTS check_ins (
      user_key TEXT NOT NULL, date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      pools TEXT NOT NULL DEFAULT '[]',
      created_at TEXT,
      PRIMARY KEY (user_key, date)
    );
    CREATE TABLE IF NOT EXISTS quota_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_key TEXT NOT NULL,
      username TEXT,
      reason TEXT,
      amount INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT,
      created_at TEXT NOT NULL,
      handled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_quota_requests_user ON quota_requests(user_key, id);
    CREATE INDEX IF NOT EXISTS idx_quota_requests_status ON quota_requests(status, id);
  `);

  // ── Column migration: weighted_tokens (peak/off-peak quota weighting) ──
  // SQLite has no "ADD COLUMN IF NOT EXISTS", and this project has no versioned
  // migration framework — so probe table_info and add idempotently. MUST run
  // before db.prepare() below, since those statements reference the new column.
  //
  // Backfilling is not optional: an un-backfilled column reads as 0, which would
  // wipe every user's "used" figure the moment this ships and make quotas
  // unenforceable. rate 1.0 is the correct historical value — past usage was
  // never discounted.
  const weightedTargets = ["usage_daily", "usage_daily_hourly", "usage_daily_model"].filter(table => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.length > 0 && !cols.some(c => c.name === "weighted_tokens");
  });
  if (weightedTargets.length > 0) {
    // One-way schema change on live data: keep a pre-migration copy around.
    const backup = backupDatabaseSync("weighted-tokens-migration");
    if (backup) console.log(`[MIGRATE] Pre-migration backup: ${path.basename(backup)}`);
    const tx = db.transaction(() => {
      for (const table of weightedTargets) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN weighted_tokens INTEGER DEFAULT 0`);
        db.exec(`UPDATE ${table} SET weighted_tokens = input_tokens + output_tokens`);
      }
    });
    tx();
    console.log(`[MIGRATE] weighted_tokens added + backfilled: ${weightedTargets.join(", ")}`);
  }

  // ── Column migration: audit_log.category (explicit log-type separation) ──
  // Entries used to be classified by deriving actor/action prefixes at query
  // time — fine while every entry was admin or system. Member-facing actions
  // (check-in, quota requests) add log types that don't fit that dichotomy, so
  // the type becomes an explicit column. Legacy rows are backfilled with the
  // exact derivation the old queries used, so old filters stay equivalent.
  const auditCols = db.prepare("PRAGMA table_info(audit_log)").all().map(c => c.name);
  if (auditCols.length > 0 && !auditCols.includes("category")) {
    const backup = backupDatabaseSync("audit-category-migration");
    if (backup) console.log(`[MIGRATE] Pre-migration backup: ${path.basename(backup)}`);
    const tx = db.transaction(() => {
      db.exec("ALTER TABLE audit_log ADD COLUMN category TEXT NOT NULL DEFAULT 'admin'");
      db.exec("UPDATE audit_log SET category = 'auth' WHERE action LIKE 'auth.%'");
      db.exec("UPDATE audit_log SET category = 'system' WHERE actor = 'system' AND action NOT LIKE 'auth.%'");
    });
    tx();
    console.log("[MIGRATE] audit_log.category added + backfilled (admin/system/auth)");
  }

  // ── Column migration: quota_requests.pool (the member picks the pool) ──
  const qrCols = db.prepare("PRAGMA table_info(quota_requests)").all().map(c => c.name);
  if (qrCols.length > 0 && !qrCols.includes("pool")) {
    const backup = backupDatabaseSync("quota-request-pool-migration");
    if (backup) console.log(`[MIGRATE] Pre-migration backup: ${path.basename(backup)}`);
    const tx = db.transaction(() => {
      db.exec("ALTER TABLE quota_requests ADD COLUMN pool TEXT");
    });
    tx();
    console.log("[MIGRATE] quota_requests.pool added");
  }

  // ── Column migration: usage_hourly_model cache tokens (per-model cache peak pricing) ──
  // Peak-cost pricing needs cache_creation/cache_read at (hour, model) grain so the
  // hourly path can price cache writes/reads at peak vs base rates. Historical rows
  // are NOT backfilled — no hourly cache data was ever recorded. Cache columns read
  // as 0 for old rows, which falls into computeCosts' gap formula and prices that
  // cache at the daily blended base rate, exactly matching the pre-migration behavior.
  const hmCols = db.prepare("PRAGMA table_info(usage_hourly_model)").all().map(c => c.name);
  if (hmCols.length > 0 && (!hmCols.includes("cache_creation") || !hmCols.includes("cache_read"))) {
    const backup = backupDatabaseSync("hourly-model-cache-migration");
    if (backup) console.log(`[MIGRATE] Pre-migration backup: ${path.basename(backup)}`);
    const tx = db.transaction(() => {
      if (!hmCols.includes("cache_creation")) {
        db.exec("ALTER TABLE usage_hourly_model ADD COLUMN cache_creation INTEGER DEFAULT 0");
      }
      if (!hmCols.includes("cache_read")) {
        db.exec("ALTER TABLE usage_hourly_model ADD COLUMN cache_read INTEGER DEFAULT 0");
      }
    });
    tx();
    console.log("[MIGRATE] usage_hourly_model cache_creation/cache_read added (no backfill)");
  }

  // ── Table migration: quota_daily_ops keyed by pool instead of profile ──
  // Manual daily ops (bonus / reset baseline) have to follow the allowance, which
  // now belongs to the pool: a bonus granted on one profile would otherwise leave
  // the user blocked on every other profile drawing from the same plan. SQLite
  // cannot change a primary key, so rebuild the table. Rows are folded by pool
  // with SUM on both counters — bonus is "extra allowance granted today" and
  // reset_baseline is "usage to ignore", and both are additive across the members
  // whose usage the pool now sums.
  const opCols = db.prepare("PRAGMA table_info(quota_daily_ops)").all().map(c => c.name);
  if (opCols.length > 0 && !opCols.includes("pool")) {
    const backup = backupDatabaseSync("quota-pool-migration");
    if (backup) console.log(`[MIGRATE] Pre-migration backup: ${path.basename(backup)}`);
    // profile suffix → pool name, from the config that was already migrated above.
    const suffixToPool = {};
    for (const [pname, p] of Object.entries(config.profiles || {})) {
      const sfx = normalizeProfileSuffix(p.suffix);
      if (sfx) suffixToPool[sfx] = resolvePoolName(pname);
    }
    const legacy = db.prepare("SELECT * FROM quota_daily_ops").all();
    const tx = db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS quota_daily_ops_legacy");
      db.exec("ALTER TABLE quota_daily_ops RENAME TO quota_daily_ops_legacy");
      db.exec(`CREATE TABLE quota_daily_ops (
        pool TEXT NOT NULL, user_key TEXT NOT NULL, date TEXT NOT NULL,
        bonus INTEGER NOT NULL DEFAULT 0,
        reset_baseline INTEGER NOT NULL DEFAULT 0,
        reset_time TEXT,
        updated_at TEXT,
        PRIMARY KEY (pool, user_key, date)
      )`);
      const ins = db.prepare(`INSERT INTO quota_daily_ops (pool,user_key,date,bonus,reset_baseline,reset_time,updated_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(pool,user_key,date) DO UPDATE SET
          bonus=bonus+excluded.bonus, reset_baseline=reset_baseline+excluded.reset_baseline,
          reset_time=COALESCE(excluded.reset_time,reset_time), updated_at=excluded.updated_at`);
      for (const r of legacy) {
        // A row whose profile no longer exists keeps its old key as the pool name
        // rather than being dropped — it expires by date on its own.
        const pool = suffixToPool[r.profile] || r.profile;
        ins.run(pool, r.user_key, r.date, r.bonus || 0, r.reset_baseline || 0, r.reset_time || null, r.updated_at || null);
      }
      db.exec("DROP TABLE quota_daily_ops_legacy");
    });
    tx();
    console.log(`[MIGRATE] quota_daily_ops rekeyed to pool (${legacy.length} row(s) folded)`);
  }

  stmts = buildStatements(db);   // prepared statements (SQL moved to lib/db.mjs)
}

// ── Pruning (called once a day via a lazy check) ──
let lastPruneDate = null;
function pruneOldDataIfNewDay() {
  const today = cnDate();
  if (lastPruneDate === today) return;
  lastPruneDate = today;
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const cutoff7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  // usage_daily_model feeds the period-switchable model distribution chart
  // (today/week/month/year in Beijing time); keep ~400 days so a full calendar
  // year plus cross-year weeks stays queryable. usage_hourly_model feeds the
  // 24h model trend chart with the same period windows, so it shares the cutoff.
  const cutoffDailyModel = new Date(Date.now() - 400 * 24 * 3600 * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const tx = db.transaction(() => {
    stmts.pruneDailyModel.run(cutoffDailyModel);
    stmts.pruneHourlyModel.run(cutoffDailyModel);
    stmts.pruneDailyHourly.run(cutoff);
    stmts.pruneErrors.run(cutoff7d);
    stmts.pruneQuotaDailyOps.run(cutoff);
  });
  tx();
}

// ── Migration: data.json → SQLite tables (one-time, idempotent) ──
function migrateFromJsonIfNeeded() {
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM users").get();
  if (c > 0) return;  // already has data
  if (!fs.existsSync(dataPath)) return;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(dataPath, "utf-8")); }
  catch (err) { console.error("[MIGRATE] data.json 读取失败:", err.message); return; }

  console.log("[MIGRATE] 从 data.json 迁移到 SQLite 多表...");
  const profiles = raw._profiles || {};
  // Legacy top-level data maps to the default profile suffix.
  const defaultSuffix = getDefaultProfileSuffix();
  const hasTopLevel = ["users","daily","dailyModels","dailyHourly","models","hourly","errors"]
    .some(k => Array.isArray(raw[k]) ? raw[k].length > 0 : Object.keys(raw[k] || {}).length > 0);
  if (hasTopLevel && defaultSuffix && !profiles[defaultSuffix]) {
    profiles[defaultSuffix] = { users: raw.users||{}, daily: raw.daily||{}, dailyModels: raw.dailyModels||{}, dailyHourly: raw.dailyHourly||{}, models: raw.models||{}, hourly: raw.hourly||{}, errors: raw.errors||[] };
  }

  const tx = db.transaction(() => {
    for (const [suffix, ps] of Object.entries(profiles)) {
      for (const [k, u] of Object.entries(ps.users || {})) {
        db.prepare(`INSERT INTO users (profile,user_key,name,total_input,total_output,total_requests,cache_creation,cache_read,last_active)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(profile,user_key) DO UPDATE SET
            total_input=total_input+excluded.total_input, total_output=total_output+excluded.total_output,
            total_requests=total_requests+excluded.total_requests, cache_creation=cache_creation+excluded.cache_creation,
            cache_read=cache_read+excluded.cache_read, last_active=excluded.last_active`)
          .run(suffix, k, u.name||k.slice(0,8), u.totalInputTokens||0, u.totalOutputTokens||0, u.totalRequests||0, u.cacheCreationTokens||0, u.cacheReadTokens||0, u.lastActive||null);
      }
      for (const [date, ud] of Object.entries(ps.daily || {})) {
        for (const [k, v] of Object.entries(ud)) {
          // Imported history predates weighting → rate 1.0 (weighted = raw).
          db.prepare(`INSERT INTO usage_daily (profile,date,user_key,input_tokens,output_tokens,requests,cache_creation,cache_read,weighted_tokens) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(profile,date,user_key) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, requests=requests+excluded.requests, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read, weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
            .run(suffix, date, k, v.inputTokens||0, v.outputTokens||0, v.requests||0, v.cacheCreationTokens||0, v.cacheReadTokens||0, (v.inputTokens||0)+(v.outputTokens||0));
        }
      }
      for (const [m, v] of Object.entries(ps.models || {})) {
        db.prepare(`INSERT INTO usage_model (profile,model,tokens,requests) VALUES (?,?,?,?)
          ON CONFLICT(profile,model) DO UPDATE SET tokens=tokens+excluded.tokens, requests=requests+excluded.requests`)
          .run(suffix, m, v.tokens||0, v.requests||0);
      }
      for (const [date, hd] of Object.entries(ps.hourly || {})) {
        for (const [h, v] of Object.entries(hd)) {
          db.prepare(`INSERT INTO usage_hourly (profile,date,hour,requests,input_tokens,output_tokens,cache_creation,cache_read) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(profile,date,hour) DO UPDATE SET requests=requests+excluded.requests, input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read`)
            .run(suffix, date, h, v.requests||0, v.inputTokens||0, v.outputTokens||0, v.cacheCreationTokens||0, v.cacheReadTokens||0);
        }
      }
      for (const [date, dm] of Object.entries(ps.dailyModels || {})) {
        for (const [k, models] of Object.entries(dm)) {
          for (const [m, v] of Object.entries(models)) {
            db.prepare(`INSERT INTO usage_daily_model (profile,date,user_key,model,input_tokens,output_tokens,requests,weighted_tokens) VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(profile,date,user_key,model) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, requests=requests+excluded.requests, weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
              .run(suffix, date, k, m, v.inputTokens||0, v.outputTokens||0, v.requests||0, (v.inputTokens||0)+(v.outputTokens||0));
          }
        }
      }
      for (const [date, dh] of Object.entries(ps.dailyHourly || {})) {
        for (const [k, hours] of Object.entries(dh)) {
          for (const [h, v] of Object.entries(hours)) {
            db.prepare(`INSERT INTO usage_daily_hourly (profile,date,user_key,hour,requests,input_tokens,output_tokens,cache_creation,cache_read,weighted_tokens) VALUES (?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(profile,date,user_key,hour) DO UPDATE SET requests=requests+excluded.requests, input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read, weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
              .run(suffix, date, k, h, v.requests||0, v.inputTokens||0, v.outputTokens||0, v.cacheCreationTokens||0, v.cacheReadTokens||0, (v.inputTokens||0)+(v.outputTokens||0));
          }
        }
      }
      for (const e of (ps.errors || [])) {
        stmts.insertError.run({ profile: suffix, time: e.time, userName: e.user, key: e.userKey, statusCode: e.statusCode, error: e.error, path: e.path, model: e.model });
      }
    }
    // Global: quotaAdjustHistory
    for (const h of (raw.quotaAdjustHistory || [])) {
      stmts.insertQuotaAdjust.run({ user: h.user, username: h.username, date: h.date, oldQuota: h.oldQuota, newQuota: h.newQuota, hitRate: h.hitRate, avgDailyUsage: h.avgDailyUsage, time: (h.date||new Date().toISOString())+"T00:00:00.000Z" });
    }
    // Global: _lastQuotaEval
    if (raw._lastQuotaEval) stmts.upsertMeta.run({ k: "lastQuotaEval", v: raw._lastQuotaEval });
  });
  tx();

  try {
    fs.renameSync(dataPath, dataPath + ".migrated");
    console.log("[MIGRATE] data.json 已重命名为 data.json.migrated（SQLite 多表已接管持久化）");
  } catch (err) {
    console.warn("[MIGRATE] data.json 重命名失败（不影响已迁移的数据）:", err.message);
  }
}

const REQUEST_DATA_TABLES = ["users", "usage_daily", "usage_daily_model", "usage_daily_hourly", "usage_model", "usage_hourly", "errors", "quota_adjust_history", "quota_daily_ops"];

function legacyProfileData(raw = {}) {
  return {
    users: raw.users || {},
    daily: raw.daily || {},
    dailyModels: raw.dailyModels || {},
    dailyHourly: raw.dailyHourly || {},
    models: raw.models || {},
    hourly: raw.hourly || {},
    errors: Array.isArray(raw.errors) ? raw.errors : [],
  };
}

function normalizeLegacyImportData(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("data.json 顶层必须是对象");
  if (raw._profiles !== undefined && (!raw._profiles || typeof raw._profiles !== "object" || Array.isArray(raw._profiles))) {
    throw new Error("_profiles 必须是对象");
  }
  const profiles = {};
  for (const [suffix, value] of Object.entries(raw._profiles || {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`方案 ${suffix} 的数据格式无效`);
    profiles[String(suffix)] = legacyProfileData(value);
  }
  const topLevelFields = ["users", "daily", "dailyModels", "dailyHourly", "models", "hourly", "errors"];
  const hasTopLevel = topLevelFields.some((key) => Array.isArray(raw[key]) ? raw[key].length > 0 : Object.keys(raw[key] || {}).length > 0);
  if (hasTopLevel) {
    let source = getDefaultProfileSuffix() || "default";
    if (profiles[source]) source = "top-level";
    profiles[source] = legacyProfileData(raw);
  }
  if (Object.keys(profiles).length === 0) throw new Error("文件中没有可导入的统计数据");
  return {
    profiles,
    quotaAdjustHistory: Array.isArray(raw.quotaAdjustHistory) ? raw.quotaAdjustHistory : [],
    lastQuotaEval: raw._lastQuotaEval || null,
  };
}

function legacyImportHash(raw) {
  return crypto.createHash("sha256").update(JSON.stringify(raw)).digest("hex");
}

function summarizeLegacyImport(normalized) {
  const userKeys = new Set();
  const dates = new Set();
  let requests = 0;
  let records = 0;
  for (const ps of Object.values(normalized.profiles)) {
    let profileRequests = 0;
    let dailyRequests = 0;
    for (const [key, user] of Object.entries(ps.users || {})) {
      userKeys.add(key);
      profileRequests += Number(user.totalRequests) || 0;
      records++;
    }
    for (const [date, rows] of Object.entries(ps.daily || {})) {
      dates.add(date);
      for (const [key, row] of Object.entries(rows || {})) {
        userKeys.add(key);
        dailyRequests += Number(row.requests) || 0;
        records++;
      }
    }
    requests += profileRequests || dailyRequests;
    for (const date of Object.keys(ps.dailyModels || {})) dates.add(date);
    for (const date of Object.keys(ps.dailyHourly || {})) dates.add(date);
    for (const date of Object.keys(ps.hourly || {})) dates.add(date);
    records += Object.keys(ps.models || {}).length + (ps.errors || []).length;
  }
  const orderedDates = [...dates].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  return {
    users: userKeys.size,
    requests,
    records,
    minDate: orderedDates[0] || null,
    maxDate: orderedDates.at(-1) || null,
  };
}

function writeLegacyData(normalized, profileMap) {
  for (const [sourceSuffix, ps] of Object.entries(normalized.profiles)) {
    const suffix = normalizeProfileSuffix(profileMap[sourceSuffix]);
    if (!suffix) continue;
    for (const [key, user] of Object.entries(ps.users || {})) {
      db.prepare(`INSERT INTO users (profile,user_key,name,total_input,total_output,total_requests,cache_creation,cache_read,last_active)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(profile,user_key) DO UPDATE SET
          name=excluded.name, total_input=total_input+excluded.total_input, total_output=total_output+excluded.total_output,
          total_requests=total_requests+excluded.total_requests, cache_creation=cache_creation+excluded.cache_creation,
          cache_read=cache_read+excluded.cache_read, last_active=excluded.last_active`)
        .run(suffix, key, user.name || key.slice(0, 8), user.totalInputTokens || 0, user.totalOutputTokens || 0, user.totalRequests || 0, user.cacheCreationTokens || 0, user.cacheReadTokens || 0, user.lastActive || null);
    }
    for (const [date, rows] of Object.entries(ps.daily || {})) {
      for (const [key, row] of Object.entries(rows || {})) {
        // Imported history predates weighting → rate 1.0 (weighted = raw).
        db.prepare(`INSERT INTO usage_daily (profile,date,user_key,input_tokens,output_tokens,requests,cache_creation,cache_read,weighted_tokens) VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(profile,date,user_key) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
          requests=requests+excluded.requests, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read,
          weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
          .run(suffix, date, key, row.inputTokens || 0, row.outputTokens || 0, row.requests || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0, (row.inputTokens || 0) + (row.outputTokens || 0));
      }
    }
    for (const [model, row] of Object.entries(ps.models || {})) {
      db.prepare(`INSERT INTO usage_model (profile,model,tokens,requests) VALUES (?,?,?,?)
        ON CONFLICT(profile,model) DO UPDATE SET tokens=tokens+excluded.tokens, requests=requests+excluded.requests`)
        .run(suffix, model, row.tokens || 0, row.requests || 0);
    }
    for (const [date, hours] of Object.entries(ps.hourly || {})) {
      for (const [hour, row] of Object.entries(hours || {})) {
        db.prepare(`INSERT INTO usage_hourly (profile,date,hour,requests,input_tokens,output_tokens,cache_creation,cache_read) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(profile,date,hour) DO UPDATE SET requests=requests+excluded.requests, input_tokens=input_tokens+excluded.input_tokens,
          output_tokens=output_tokens+excluded.output_tokens, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read`)
          .run(suffix, date, hour, row.requests || 0, row.inputTokens || 0, row.outputTokens || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0);
      }
    }
    for (const [date, users] of Object.entries(ps.dailyModels || {})) {
      for (const [key, models] of Object.entries(users || {})) {
        for (const [model, row] of Object.entries(models || {})) {
          db.prepare(`INSERT INTO usage_daily_model (profile,date,user_key,model,input_tokens,output_tokens,requests,weighted_tokens) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(profile,date,user_key,model) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens,
            output_tokens=output_tokens+excluded.output_tokens, requests=requests+excluded.requests,
            weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
            .run(suffix, date, key, model, row.inputTokens || 0, row.outputTokens || 0, row.requests || 0, (row.inputTokens || 0) + (row.outputTokens || 0));
        }
      }
    }
    for (const [date, users] of Object.entries(ps.dailyHourly || {})) {
      for (const [key, hours] of Object.entries(users || {})) {
        for (const [hour, row] of Object.entries(hours || {})) {
          db.prepare(`INSERT INTO usage_daily_hourly (profile,date,user_key,hour,requests,input_tokens,output_tokens,cache_creation,cache_read,weighted_tokens) VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(profile,date,user_key,hour) DO UPDATE SET requests=requests+excluded.requests, input_tokens=input_tokens+excluded.input_tokens,
            output_tokens=output_tokens+excluded.output_tokens, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read,
            weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
            .run(suffix, date, key, hour, row.requests || 0, row.inputTokens || 0, row.outputTokens || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0, (row.inputTokens || 0) + (row.outputTokens || 0));
        }
      }
    }
    for (const error of ps.errors || []) {
      stmts.insertError.run({
        profile: suffix,
        time: error.time || new Date().toISOString(),
        userName: error.user || error.userName || "",
        key: error.userKey || "unknown",
        statusCode: error.statusCode || 0,
        error: error.error || "",
        path: error.path || "",
        model: error.model || "unknown",
      });
    }
  }
  for (const row of normalized.quotaAdjustHistory || []) {
    const date = row.date || cnDate();
    stmts.insertQuotaAdjust.run({
      user: row.user || row.userKey || "unknown",
      username: row.username || row.userName || "",
      date,
      oldQuota: row.oldQuota || 0,
      newQuota: row.newQuota || 0,
      hitRate: row.hitRate || 0,
      avgDailyUsage: row.avgDailyUsage || 0,
      time: row.time || `${date}T00:00:00.000Z`,
    });
  }
  if (normalized.lastQuotaEval) stmts.upsertMeta.run({ k: "lastQuotaEval", v: normalized.lastQuotaEval });
}

function clearRequestData() {
  for (const table of REQUEST_DATA_TABLES) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("DELETE FROM kv_meta").run();
}

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
    super(message || `rate limited until ${beijingTimeString(new Date(resumeAt))}`);
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
      `方案 "${profileName}" 被上游限流（来源: ${source || "unknown"}），暂停至 ${beijingTimeString(new Date(resumeAtMs))}，后续请求自动切换到备选方案`);
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
  // Aliyun Throttling.AllocationQuota (free allocated quota exceeded), DeepSeek 429 quota.
  const looksLikePlanLimit = /"code"\s*:\s*1(310|311|113)|使用上限|usage limit|plan limit|额度已耗尽|quota exceeded|AllocationQuota|free allocated quota/i.test(body);
  if (!looksLikePlanLimit) return null;
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
// 1. explicit session headers (Codex sends `session_id` on /v1/responses),
// 2. the Responses API `prompt_cache_key` body field,
// 3. digest of the conversation's first turn — replay protocols append at the
//    tail, so item[0] (plus the constant system/instructions) is identical on
//    every turn of the same conversation. Collisions between conversations that
//    happen to share the first turn only cost cache locality, never correctness.
function extractSessionSignal(protocol, reqHeaders, parsed) {
  const hdr = reqHeaders["session_id"] || reqHeaders["x-session-id"] || reqHeaders["x-claude-code-session-id"];
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
const failoverActive = new Map(); // head profile name → { member, at }

function getRuntimeByProfileName(name) {
  for (const r of Object.values(runtimes)) {
    if (r.profileName === name) return r;
  }
  return null;
}

function noteFailoverServed(protocol, servedBy, userName) {
  const headName = protocol === "responses"
    ? (Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup[0] : null)
    : (Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup[0] : null);
  if (!headName || servedBy === headName) {
    if (headName && servedBy === headName && failoverActive.has(headName)) {
      const prev = failoverActive.get(headName);
      failoverActive.delete(headName);
      recordAudit("system", "failover.recover", headName,
        `组头 "${headName}" 恢复接管（此前由 "${prev.member}" 代答），流量切回`);
    }
    return;
  }
  const prev = failoverActive.get(headName);
  if (!prev || prev.member !== servedBy) {
    const headRt = getRuntimeByProfileName(headName);
    const why = isRateLimited(headName) ? "被限流" : (headRt && headRt.breaker.status().state === "OPEN" ? "熔断" : "");
    failoverActive.set(headName, { member: servedBy, at: Date.now() });
    recordAudit("system", "failover.switch", `${headName} → ${servedBy}`,
      `组头 "${headName}"${why ? `因${why}不可用` : "不可用"}，请求自动切换到备选方案 "${servedBy}"${userName ? `（触发用户: ${userName}）` : ""}`);
  }
}


// Ordered list of currently-usable default-group profiles for a given user key.
// Skips: rate-limited, breaker OPEN, user not authorized, or profiles with no runtime.
function getAvailableDefaultProfiles(apiKey) {
  const group = Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : [];
  const out = [];
  for (const name of group) {
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
function getAvailableResponsesProfiles(apiKey) {
  const group = Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup : [];
  const out = [];
  for (const name of group) {
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
  const hourly = {};
  for (const r of db.prepare("SELECT date,hour,requests,input_tokens,output_tokens,cache_creation,cache_read FROM usage_hourly WHERE profile=?").all(suffix)) {
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
  const errors = db.prepare("SELECT time,user_name AS user,user_key AS userKey,status_code AS statusCode,error,path,model FROM errors WHERE profile=? ORDER BY id DESC LIMIT 200").all(suffix);
  return { users, daily, dailyModels, dailyHourly, models, hourly, errors };
}

initDb();
initProductionDb(db);   // 产出质量表(tool_events / production_alerts),先于 tracker 建语句
function productionEnabled() { return (config.productionTracking || {}).enabled !== false; }
const productionTracker = createProductionTracker({ db, getConfig: () => config.productionTracking || {}, log: console.log });

// 产出质量:60s 告警扫描 + 过期清理(unref 不阻止进程退出);告警经既有通知渠道 webhook 推送。
const prodNotifyCooldown = new Map();
function pushProductionAlert(a) {
  const cfg = config.notifier || {};
  if (!cfg.enabled) return;
  const key = a.kind + ":" + a.user_key;
  if (Date.now() - (prodNotifyCooldown.get(key) || 0) < 60_000) return;
  prodNotifyCooldown.set(key, Date.now());
  const names = { idle_burn: "空转消耗", error_loop: "错误循环", edit_failure_burst: "编辑失败爆发" };
  const msg = `【产出告警】${names[a.kind] || a.kind} · ${a.user_name || a.user_key}\n${a.detail || ""}\n—— ${beijingTimeString()}（token-monitor）`;
  for (const s of NOTIFY_SENDERS.filter(s => s.enabled(cfg))) {
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
migrateFromJsonIfNeeded();
pruneOldDataIfNewDay(); // also run at startup so rows pruned under an old policy converge immediately
loadRateLimitState();

function removeLegacyOpenAIData() {
  const suffixes = removedOpenAIProfileSuffixes.filter(Boolean);
  if (suffixes.length === 0) return;
  db.pragma("wal_checkpoint(FULL)");
  backupFileSync(dbPath, "data.db", "remove-openai");
  const placeholders = suffixes.map(() => "?").join(",");
  const removedKeys = db.prepare(`SELECT DISTINCT user_key FROM users WHERE profile IN (${placeholders})`).all(...suffixes).map((row) => row.user_key);
  const tx = db.transaction(() => {
    for (const table of ["users", "usage_daily", "usage_daily_model", "usage_daily_hourly", "usage_hourly_model", "usage_model", "usage_hourly", "errors"]) {
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

function hasProfileRealKey(apiKey, _rt) {
  const pu = getProfileUser(apiKey, _rt);
  if (!pu) return false;
  if (typeof pu === "string") return !!pu.trim();
  return !!(pu.key && String(pu.key).trim());
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
// cnNow/cnDate/cnHour/secondsUntilNextCnMidnight 已迁至 ./lib/time.mjs。

function recordUsage(apiKey, usage, model, suffix, _rt) {
  const runtime = _rt || runtimes[normalizeProfileSuffix(suffix)] || rt;
  const sfx = normalizeProfileSuffix(suffix) || runtime?.suffix || getDefaultProfileSuffix();
  const key = resolveUserKey(apiKey, runtime);
  const today = cnDate();
  const hour = cnHour();
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

  pruneOldDataIfNewDay();

  // Weight the request at the rate in force right now, for THIS model. This is
  // settled at write time on purpose: the row's cost is frozen, so changing a rate
  // later only affects future requests and never silently re-prices history. Note
  // the rate comes from the completion instant (same convention as cnHour()
  // above), so a request spanning a peak boundary is priced by where it finished.
  const rate = currentQuotaRate(runtime, new Date(), m);
  // Cache-hit accounting, aligned to the Anthropic protocol. Anthropic upstreams
  // report cache reads SEPARATELY and never inside input_tokens, so their quota
  // basis is already cache-free. Responses/OpenAI upstreams fold the cache-hit
  // slice INTO input_tokens — before this, a Codex replay loop paid full price
  // for ~95% cache hits on every turn. Strip that slice from the quota basis
  // (mirroring Anthropic) unless the profile opts back in via cacheReadQuotaRate
  // (>0 keeps a fraction billable). inp/cacheC/cacheR/out are still stored raw,
  // so stats/trends show true tokens; only the quota currency (weighted) changes.
  // Guard: strip only when cacheR is a positive subset of inp — an upstream that
  // already returns cache-excluded input (cacheR > inp) is treated as aligned.
  const includedCache = (runtime?.protocol === "responses" && cacheR > 0 && cacheR <= inp) ? cacheR : 0;
  const cacheReadQuotaRate = runtime?.cacheReadQuotaRate ?? 0;
  const billableInp = inp - includedCache + Math.round(includedCache * cacheReadQuotaRate);
  const weighted = Math.round((billableInp + out) * rate);

  const p = { profile: sfx, key, name: getUserName(key, runtime), inp, out, cacheC, cacheR, m, tokenTotal: inp + out, weighted, today, hour, now: new Date().toISOString() };
  const tx = db.transaction(() => {
    stmts.upsertUser.run(p);
    stmts.upsertDaily.run(p);
    stmts.upsertModel.run(p);
    stmts.upsertHourly.run(p);
    stmts.upsertDailyModel.run(p);
    stmts.upsertDailyHourly.run(p);
    stmts.upsertHourlyModel.run(p);
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
    try { notifyAuditEvent({ time, actor, action: String(action || "unknown"), target: String(target || ""), detail: String(detail || "") }); }
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
  const channels = NOTIFY_SENDERS.filter(s => s.enabled(cfg));
  if (!channels.length) return;
  const msg = `【加量申请】${info.username}\n申请额度池：${info.pool}\n理由：${info.reason}\n请到 设置 → 加量申请 处理（该成员本周已处理 ${info.handledThisWeek}/${info.weeklyLimit} 次）\n—— ${beijingTimeString()}（token-monitor）`;
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


// ─── System-Event Notifier (webhook push) ─────────────────────────────────────
// Pushes failure/recovery audit events to IM bots and phone-push channels.
// Best-effort and fully async: never blocks the proxy, never throws, and never
// records audits of its own (a notify failure must not spawn another notify).
const NOTIFY_FAILURE_ACTIONS = new Set(["ratelimit.mark", "failover.switch", "breaker.open"]);
const NOTIFY_RECOVERY_ACTIONS = new Set(["ratelimit.expire", "failover.recover", "breaker.closed"]);
const NOTIFY_TIMEOUT_MS = 5000;

// Per-head failure incidents. All alert/recovery events of one failover-group
// head collapse into a single open→close lifecycle, so a stuck scheme cannot
// push an alert+recovery pair every cycle. A head is identified by its profile
// name (see normalizeIncidentKey). Process restart clears the map — same as the
// old cooldown — and a still-failing head simply opens a fresh incident after
// restart (one extra alert, acceptable).
const notifyIncidents = new Map(); // head → { openedAt }
let notifyLastPushAt = 0;          // global "time since any push" floor for minIntervalSeconds

function beijingTimeString(d = new Date()) {
  return new Date(d).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function postHttpRequest(url, { body, contentType, timeoutMs = NOTIFY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (err) { reject(new Error("URL 无效")); return; }
    const mod = target.protocol === "https:" ? https : http;
    const payload = body == null ? null : Buffer.from(body);
    const req = mod.request(target, {
      method: "POST",
      headers: {
        ...(contentType ? { "content-type": contentType } : {}),
        ...(payload ? { "content-length": payload.length } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(text);
        else reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 120)}`));
      });
    });
    req.on("timeout", () => { req.destroy(new Error("请求超时")); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Each sender returns a Promise resolving on channel acceptance.
const NOTIFY_SENDERS = [
  { channel: "飞书", enabled: (n) => !!String(n.feishuWebhook || "").trim(), send: (n, msg) =>
    postHttpRequest(n.feishuWebhook, { body: JSON.stringify({ msg_type: "text", content: { text: msg } }), contentType: "application/json" }) },
  { channel: "钉钉", enabled: (n) => !!String(n.dingtalkWebhook || "").trim(), send: (n, msg) =>
    postHttpRequest(n.dingtalkWebhook, { body: JSON.stringify({ msgtype: "text", text: { content: msg } }), contentType: "application/json" }) },
  { channel: "企业微信", enabled: (n) => !!String(n.wecomWebhook || "").trim(), send: (n, msg) =>
    postHttpRequest(n.wecomWebhook, { body: JSON.stringify({ msgtype: "text", text: { content: msg } }), contentType: "application/json" }) },
  { channel: "Server酱", enabled: (n) => !!String(n.serverchanSendKey || "").trim(), send: (n, msg) => {
    const key = String(n.serverchanSendKey).trim();
    const form = `title=${encodeURIComponent(msg.split("\n")[0])}&desp=${encodeURIComponent(msg)}`;
    return postHttpRequest(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, { body: form, contentType: "application/x-www-form-urlencoded" });
  } },
  { channel: "Bark", enabled: (n) => !!String(n.barkDeviceKey || "").trim(), send: (n, msg) => {
    const base = String(n.barkServer || "").trim().replace(/\/+$/, "") || "https://api.day.app";
    const key = encodeURIComponent(String(n.barkDeviceKey).trim());
    return postHttpRequest(`${base}/${key}`, { body: JSON.stringify({ body: msg, group: "token-monitor" }), contentType: "application/json" });
  } },
];

// Map an audit event to the failover-group head it belongs to.
//   ratelimit.mark/expire, breaker.open/closed → target is already the head name
//   failover.switch/recover → target may be "Head → Member"; the head is the left
//                             side (failover.recover already passes a bare head).
// Returns null when no head can be derived; such an event falls back to the old
// always-push path (no incident bookkeeping) so a parse miss never drops a real
// notification.
function normalizeIncidentKey(action, target) {
  const t = String(target || "").trim();
  if (!t) return null;
  const failoverAction = action === "failover.switch" || action === "failover.recover";
  const head = (failoverAction && t.includes("→")) ? t.slice(0, t.indexOf("→")).trim() : t;
  return head || null;
}

// Fire-and-forget dispatch. Synchronous entry, async fan-out; all channel
// failures are logged, never surfaced.
//
// Incident semantics (per failover-group head):
//   failure  → no open incident for the head: open one and push an alert.
//              already open: silent (no push, no refresh) — the dedupe that stops
//              the alert+recover pair spam.
//   expire   → NEVER pushes and never closes an incident: ratelimit.expire is only
//              the 120s fallback window elapsing, not a real recovery. A genuine
//              recovery is the head serving traffic again (failover.recover) or the
//              breaker closing (breaker.closed).
//   recover  → closes the head's open incident (if any) and pushes a recovery when
//              cfg.notifyRecovery !== false. A recovery with no open incident is an
//              orphan (e.g. after a restart) and is not pushed.
// minIntervalSeconds is ONE global floor between any two pushes (not a per-action
// lock): incidents already dedupe per head, so the floor only stops a simultaneous
// multi-head burst. The registry is still updated when the floor suppresses the
// push, so a burst does not leave silent incidents stuck open.
function notifyAuditEvent(row) {
  const cfg = config.notifier || {};
  if (!cfg.enabled) return;
  const action = row.action;
  const isFailure = NOTIFY_FAILURE_ACTIONS.has(action);
  const isRecovery = NOTIFY_RECOVERY_ACTIONS.has(action);
  if (!isFailure && !isRecovery) return;

  let incidentKey = normalizeIncidentKey(action, row.target);
  if (isFailure) {
    if (incidentKey) {
      if (notifyIncidents.has(incidentKey)) return; // already open → silent
      notifyIncidents.set(incidentKey, { openedAt: Date.now() });
    }
  } else {
    // Recovery action. ratelimit.expire is a FALSE recovery (fallback window
    // elapsing, not the head serving again) — never notify, never close.
    if (action === "ratelimit.expire") return;
    if (incidentKey) {
      if (!notifyIncidents.delete(incidentKey)) return; // orphan recovery → silent
    }
    if (cfg.notifyRecovery === false) return;           // close incident but keep quiet
  }

  const prefix = isFailure ? "【网关告警】" : "【网关恢复】";
  const msg = `${prefix} ${row.target || action}\n${row.detail || ""}\n—— ${beijingTimeString()}（token-monitor）`;
  const channels = NOTIFY_SENDERS.filter((s) => s.enabled(cfg));
  if (!channels.length) return;

  const rawInterval = Number(cfg.minIntervalSeconds);
  const intervalMs = Math.max(0, (Number.isFinite(rawInterval) ? rawInterval : 300) * 1000);
  const now = Date.now();
  if (now - notifyLastPushAt < intervalMs) return;      // global floor (not per-action)
  notifyLastPushAt = now;

  for (const s of channels) {
    s.send(cfg, msg)
      .then(() => console.log(`[通知] 已推送 ${s.channel}: ${action} ${row.target}`))
      .catch((err) => console.error(`[通知] ${s.channel} 推送失败: ${err.message}`));
  }
}

// Send a test message to every configured channel of the given (possibly
// unsaved) config; resolves with per-channel results for the UI.
async function sendNotifierTest(cfg) {
  const msg = `[token-monitor] 通知测试成功\n渠道连通性验证通过。系统故障/恢复事件（限流、failover 切换、熔断）将推送到此处。\n—— ${beijingTimeString()}`;
  const channels = NOTIFY_SENDERS.filter((s) => s.enabled(cfg));
  const results = await Promise.all(channels.map(async (s) => {
    try { await s.send(cfg, msg); return { channel: s.channel, ok: true }; }
    catch (err) { return { channel: s.channel, ok: false, error: err.message }; }
  }));
  return results;
}

function sanitizeNotifierConfig(input) {
  const src = input && typeof input === "object" ? input : {};
  const url = (v) => {
    const s = String(v || "").trim();
    if (!s) return "";
    if (!/^https?:\/\/[^\s]+$/.test(s)) throw new Error(`无效的 Webhook 地址: "${s.slice(0, 80)}"`);
    return s;
  };
  const parsedInterval = parseInt(src.minIntervalSeconds, 10);
  return {
    enabled: !!src.enabled,
    minIntervalSeconds: Math.min(86400, Math.max(0, Number.isFinite(parsedInterval) ? parsedInterval : 300)),
    notifyRecovery: src.notifyRecovery !== false,
    feishuWebhook: url(src.feishuWebhook),
    dingtalkWebhook: url(src.dingtalkWebhook),
    wecomWebhook: url(src.wecomWebhook),
    serverchanSendKey: String(src.serverchanSendKey || "").trim().slice(0, 120),
    barkServer: src.barkServer ? url(src.barkServer) : "",
    barkDeviceKey: String(src.barkDeviceKey || "").trim().slice(0, 200),
  };
}

// ─── API Proxy ───────────────────────────────────────────────────────────────
function getApiKey(req) {
  const a = req.headers["authorization"];
  if (a && a.startsWith("Bearer ")) return a.slice(7);
  return req.headers["x-api-key"] || "unknown";
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeClientAbortError(reason = "client disconnected") {
  const err = new Error(`Client disconnected: ${reason}`);
  err.code = "CLIENT_ABORT";
  err.isClientAbort = true;
  return err;
}

function isClientAbortError(err) {
  return !!(err?.isClientAbort || err?.code === "CLIENT_ABORT");
}

function createClientAbortState() {
  return {
    aborted: false,
    reason: "",
    // A set, not one slot: the image bridge fires several helper calls in
    // parallel and every in-flight one must die when the client hangs up.
    upstreamRequests: new Set(),
    listeners: new Set(),
  };
}

function markClientAborted(state, reason) {
  if (!state || state.aborted) return;
  state.aborted = true;
  state.reason = reason || "unknown";
  for (const upReq of [...state.upstreamRequests]) {
    if (!upReq.destroyed) upReq.destroy(makeClientAbortError(state.reason));
  }
  for (const listener of [...state.listeners]) {
    try { listener(state.reason); } catch {}
  }
}

function addClientAbortListener(state, listener) {
  if (!state) return () => {};
  if (state.aborted) {
    listener(state.reason);
    return () => {};
  }
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

function setActiveUpstreamRequest(state, upReq) {
  if (!state) return () => {};
  state.upstreamRequests.add(upReq);
  if (state.aborted && !upReq.destroyed) {
    upReq.destroy(makeClientAbortError(state.reason));
  }
  return () => { state.upstreamRequests.delete(upReq); };
}

function throwIfClientAborted(state) {
  if (state?.aborted) throw makeClientAbortError(state.reason);
}

function sleepWithClientAbort(ms, state) {
  if (!state) return sleep(ms);
  return new Promise((resolve, reject) => {
    if (state.aborted) {
      reject(makeClientAbortError(state.reason));
      return;
    }
    let done = false;
    let cleanup = () => {};
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    }, ms);
    cleanup = addClientAbortListener(state, (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanup();
      reject(makeClientAbortError(reason));
    });
  });
}

// Jitter: ±25% random variation
function jitter(ms) {
  const half = ms * 0.25;
  return ms + (Math.random() * half * 2 - half);
}

function buildUpstreamPath(reqUrl, runtime) {
  const upstreamPath = runtime.upstreamUrl.pathname.replace(/\/$/, "");
  // Smart path concatenation: avoid double /v1 when upstream already contains it
  if (upstreamPath && reqUrl.startsWith("/v1/")) {
    if (upstreamPath.endsWith("/v1")) {
      return upstreamPath + reqUrl.slice(3); // /v1 + /messages -> /v1/messages
    }
    return upstreamPath + reqUrl;
  }
  return upstreamPath + reqUrl;
}

// ─── 图片识别桥接（vision bridge）───────────────────────────────────────────
// 目标别名不支持视觉时，先用方案指定的辅助模型把图片转成文字描述，再替换
// 请求里的图片块交给原模型——Claude Code/ZCode/Codex 端贴图即可用。
// 转述按 helperModel:sha256(b64) 持久化到 SQLite：重放协议每轮重发全部历史
// 图片，缓存跨重启存活才不会在网关重启后批量重转或撞上限。
const IMAGE_BRIDGE_CACHE_MAX_ROWS = 5000;
const IMAGE_BRIDGE_MAX_IMAGES = 8;
const IMAGE_BRIDGE_MAX_B64 = 12 * 1024 * 1024;
// Helper calls run before the first byte reaches the client, so their total cost
// IS the client's wait. Serial calls at a 60s timeout each used to reach ~90s and
// the client hung up mid-bridge; these three numbers bound it instead.
const IMAGE_BRIDGE_CONCURRENCY = 4;            // parallel helper calls
const IMAGE_BRIDGE_CALL_TIMEOUT_MS = 25000;    // per-image helper timeout
const IMAGE_BRIDGE_TOTAL_BUDGET_MS = 35000;    // whole-request budget, shared across failover candidates
const IMAGE_BRIDGE_MIN_CALL_MS = 8000;         // never start a call the budget would clip
const IMAGE_BRIDGE_DESC_MAX_CHARS = 1000;      // a transcription is replayed every turn, forever
// A helper that is genuinely broken should cost one second, not a full budget on
// every turn: park it after a few consecutive failures.
const IMAGE_BRIDGE_HELPER_FAIL_LIMIT = 3;
const IMAGE_BRIDGE_HELPER_COOLDOWN_MS = 30000;
const bridgeHelperHealth = new Map();          // "host|model" -> { fails, until }
const bridgeThinkingUnsupported = new Set();   // upstreams that reject the `thinking` field

// Rendered into the settings page: the cache is keyed by image and shared by all
// profiles, so the count is global.
function ibCacheRows() {
  let n = 0;
  try { n = stmts.bridgeCacheCount.get().n; } catch {}
  return `已缓存 ${n} 张图片转述（全局共享，清空后这些图下一轮会重新识别）`;
}

function bridgeCacheGet(hash) {
  try {
    const row = stmts.bridgeCacheGet.get(hash);
    if (!row) return null;
    // Pruning keeps the newest IMAGE_BRIDGE_CACHE_MAX_ROWS by ts, so ts has to track
    // USE and not just insertion: otherwise a long conversation's images get evicted
    // while they are still replayed every turn, flip back to placeholders, and take
    // the upstream's prompt cache with them. Hour granularity keeps writes cheap.
    if (Date.now() - row.ts > 3600_000) {
      try { stmts.bridgeCacheTouch.run(Date.now(), hash); } catch {}
    }
    return row.text;
  } catch { return null; }
}
// A transcription replaces its image for good: it is cached and replayed on every
// later turn, so its length is a permanent per-turn tax. A chatty helper writing
// 2000 chars about each of 27 screenshots would quietly add tens of thousands of
// tokens to every single request, which is why this is capped rather than trusted.
function clampDescription(text) {
  const s = String(text || "").trim();
  if (s.length <= IMAGE_BRIDGE_DESC_MAX_CHARS) return s;
  const cut = s.slice(0, IMAGE_BRIDGE_DESC_MAX_CHARS);
  let stop = -1;
  for (const mark of ["。", "；", "\n", ". "]) stop = Math.max(stop, cut.lastIndexOf(mark));
  const body = stop > IMAGE_BRIDGE_DESC_MAX_CHARS * 0.6 ? cut.slice(0, stop + 1) : cut;
  return body + "…（描述过长，已截断）";
}

function bridgeCacheSet(hash, text) {
  try {
    stmts.bridgeCacheSet.run(hash, text, Date.now());
    if (stmts.bridgeCacheCount.get().n > IMAGE_BRIDGE_CACHE_MAX_ROWS) {
      stmts.bridgeCachePrune.run(IMAGE_BRIDGE_CACHE_MAX_ROWS);
    }
  } catch (err) { console.warn("[图片桥接] 缓存写入失败:", err.message); }
}

// Replay protocols resend the whole conversation every turn, so "new" has to be
// decided structurally: the trailing run of client-authored items is this turn,
// everything before it is history that was already transcribed (or already
// degraded) in an earlier turn.
function responsesFreshStart(items) {
  let i = items.length - 1;
  while (i >= 0) {
    const it = items[i];
    if (!it || typeof it !== "object") break;
    const isUserMsg = it.type === "message" && it.role === "user";
    const isToolOut = typeof it.type === "string" && it.type.endsWith("_call_output");
    if (!isUserMsg && !isToolOut) break;
    i--;
  }
  return i + 1;
}

function anthropicFreshStart(msgs) {
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i] && msgs[i].role === "user") i--;
  return i + 1;
}

// A user message names its text parts `input_text`; some servers use `output_text`
// inside a tool result. Mirror whatever the sibling parts already use so the
// rewritten block stays valid for that container.
function responsesTextType(arr, field) {
  if (field === "content") return "input_text";
  const sibling = arr.find(b => b && typeof b.type === "string" && b.type.endsWith("_text"));
  return sibling ? sibling.type : "input_text";
}

// Extract data:URL images from a parsed Responses request body (input items).
// Returns markers { i, j, field, textType, b64, fresh, tooLarge } into
// parsed.input[i][field][j].
function extractImagesFromResponsesBody(parsed) {
  const images = [];
  const items = Array.isArray(parsed?.input) ? parsed.input : [];
  const freshStart = responsesFreshStart(items);
  const scan = (arr, i, field) => {
    for (let j = 0; j < arr.length; j++) {
      const block = arr[j];
      if (!block || block.type !== "input_image") continue;
      const raw = String(block.image_url || "");
      const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(raw);
      if (!m) continue;
      const b64 = m[1].replace(/\s+/g, "");
      if (!b64) continue;
      // Oversized images are collected too, just flagged: skipping them left a raw
      // image block in a request bound for a blind model — a guaranteed 400.
      images.push({ i, j, field, textType: responsesTextType(arr, field), b64,
        fresh: i >= freshStart, tooLarge: b64.length > IMAGE_BRIDGE_MAX_B64 });
    }
  };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      if (Array.isArray(item.content)) scan(item.content, i, "content");
      continue;
    }
    // Tool results can carry screenshots as well, in the array form of `output` on a
    // *_call_output item. Left unextracted, that raw image block would travel to a
    // model with no vision and take the whole request down with it.
    if (typeof item.type === "string" && item.type.endsWith("_call_output") && Array.isArray(item.output)) {
      scan(item.output, i, "output");
    }
  }
  return images;
}

// Extract base64 image blocks from a parsed Anthropic Messages body. Image
// blocks live in message content arrays — including nested inside tool_result
// content (Claude Code puts screenshots there). Returns reference-based
// markers { arr, idx, b64, mediaType, fresh, tooLarge } for in-place replacement.
function extractImageBlocksAnthropic(parsed) {
  const images = [];
  const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const freshStart = anthropicFreshStart(msgs);
  for (let mi = 0; mi < msgs.length; mi++) {
    const msg = msgs[mi];
    const fresh = mi >= freshStart;
    const content = msg && msg.content;
    if (!Array.isArray(content)) continue;   // string content carries no images
    for (let idx = 0; idx < content.length; idx++) {
      const block = content[idx];
      if (!block || typeof block !== "object") continue;
      if (block.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string") {
        images.push({ arr: content, idx, b64: block.source.data, mediaType: block.source.media_type || "image/png", fresh, tooLarge: block.source.data.length > IMAGE_BRIDGE_MAX_B64 });
        continue;
      }
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        const inner = block.content;
        for (let t = 0; t < inner.length; t++) {
          const tb = inner[t];
          if (tb && tb.type === "image" && tb.source?.type === "base64" && typeof tb.source.data === "string") {
            images.push({ arr: inner, idx: t, b64: tb.source.data, mediaType: tb.source.media_type || "image/png", fresh, tooLarge: tb.source.data.length > IMAGE_BRIDGE_MAX_B64 });
          }
        }
      }
    }
  }
  return images;
}

// Bridge one request body (Buffer) through the profile's helper model.
// `alias` is the model alias the client asked for: aliases marked multimodal
// pass through untouched (native support); non-multimodal aliases with images
// are rewritten via the helper. Returns { body, helperModel, stats }, or null to
// passthrough (no images, or the alias natively supports images).
//
// Failure policy: a single image must never be able to kill a turn. Images the
// client just sent ("fresh") are the ones the user is waiting on — if those cannot
// be transcribed we fail loudly with an actionable 400. Replayed history images
// degrade to a text placeholder, because a replay protocol resends every image
// every turn and a cold cache would otherwise fail the session forever.
async function bridgeImagesInRequest(body, runtime, clientState, alias, protocol) {
  const profileCfg = config.profiles[runtime.profileName] || {};
  const mm = profileCfg.modelMultimodal || {};
  // Native support (or unknown alias) → passthrough, zero cost. Lookup is
  // case-insensitive: clients send aliases with arbitrary casing (Claude Code
  // was observed sending "Jx-Opus"), while resolveModel already matches
  // case-insensitively.
  const aliasKey = String(alias || "");
  const mmEntry = Object.keys(mm).find(k => k.toLowerCase() === aliasKey.toLowerCase());
  if (!mmEntry || mm[mmEntry] !== false) return null;
  let parsed;
  try { parsed = JSON.parse(body.toString()); } catch { return null; }
  const images = protocol === "anthropic"
    ? extractImageBlocksAnthropic(parsed)
    : extractImagesFromResponsesBody(parsed);
  if (images.length === 0) return null;
  // Helper model: manually configured one, else the first multimodal alias.
  const helperModel = resolveBridgeHelperModel(profileCfg, mm);
  if (!helperModel) {
    const err = new Error(`模型 "${alias}" 未标记为原生支持图片，且方案未配置任何可参与图片识别的辅助模型（请在别名中勾选至少一个支持多模态的模型）`);
    err.statusCode = 400;
    throw err;
  }
  const startedAt = Date.now();
  // Cache key is the image itself — no helper prefix. A description is a
  // description whichever vision model wrote it, so a failover to another profile
  // reuses the work instead of re-transcribing the whole history under a second
  // key (which is why the "new images" count never converged).
  const keyed = images.map(img => ({ img, hash: crypto.createHash("sha256").update(img.b64).digest("hex") }));
  const results = new Array(keyed.length).fill(null);
  const pending = [];
  for (let i = 0; i < keyed.length; i++) {
    const img = keyed[i].img;
    if (img.tooLarge) {
      results[i] = { text: `（图片过大 ${(img.b64.length / 1024 / 1024).toFixed(1)}MB，超过网关识别上限，未识别）`, placeholder: true };
      continue;
    }
    const cached = bridgeCacheGet(keyed[i].hash);
    if (cached !== null) { results[i] = { text: cached, hit: true }; continue; }
    pending.push(i);
  }
  // Only THIS turn's images earn a helper call. An uncached history image is one
  // that was never transcribed while it was fresh (bridge was off, cache cleared,
  // an earlier failure) — transcribing it now spends the client's wait on context
  // the user stopped asking about, and it rewrites the middle of the prompt every
  // turn, which throws away the upstream's prompt cache. So: placeholder, instantly.
  // A turn that adds no image therefore costs zero helper calls no matter how many
  // images the replayed history carries.
  const queue = [];
  for (const i of pending) {
    if (keyed[i].img.fresh) queue.push(i);
    else results[i] = { text: "（历史图片本轮未识别；如需分析请重新发送该图）", placeholder: true };
  }
  queue.sort((a, b) => b - a);   // newest first gets the budget
  for (const i of queue.splice(IMAGE_BRIDGE_MAX_IMAGES)) {
    results[i] = { text: `（本轮图片过多，超过网关单次识别上限 ${IMAGE_BRIDGE_MAX_IMAGES} 张，此张本轮未识别；请分批发送）`, placeholder: true };
  }
  // One budget per client request, not per failover candidate: the second
  // candidate re-bridges straight from cache and must not add another full wait.
  if (clientState && !clientState.bridgeDeadline) clientState.bridgeDeadline = Date.now() + IMAGE_BRIDGE_TOTAL_BUDGET_MS;
  const deadline = (clientState && clientState.bridgeDeadline) || (Date.now() + IMAGE_BRIDGE_TOTAL_BUDGET_MS);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const at = cursor++;
      if (at >= queue.length) return;
      const i = queue[at];
      throwIfClientAborted(clientState);
      const left = deadline - Date.now();
      if (left < IMAGE_BRIDGE_MIN_CALL_MS) {
        // Starting a call the deadline will cut short only burns tokens and reports
        // a misleading "timeout" — stop instead.
        results[i] = { failed: true, reason: `网关图片识别预算 ${Math.round(IMAGE_BRIDGE_TOTAL_BUDGET_MS / 1000)}s 已用尽，剩余时间不足以再识别一张` };
        continue;
      }
      const r = await describeImageViaHelper(keyed[i].img.b64, helperModel, runtime, clientState, profileCfg, protocol, keyed[i].img.mediaType, Math.min(IMAGE_BRIDGE_CALL_TIMEOUT_MS, left));
      if (r.ok) {
        results[i] = { text: r.text, fetched: true };
        bridgeCacheSet(keyed[i].hash, r.text);
      } else {
        results[i] = { failed: true, reason: r.reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(IMAGE_BRIDGE_CONCURRENCY, queue.length)) }, () => worker()));

  const freshFails = [];
  for (let i = 0; i < keyed.length; i++) {
    const r = results[i] || { failed: true, reason: "未处理" };
    if (r.failed && keyed[i].img.fresh) freshFails.push(r.reason);
    // Only this turn's images are ever attempted, so a failure here always throws
    // below; the text is a belt-and-braces fallback.
    const text = r.failed ? `（图片识别失败：${r.reason}）` : r.text;
    // Replace the image block with a text description (keep surrounding context).
    const img = keyed[i].img;
    if (protocol === "anthropic") {
      img.arr[img.idx] = { type: "text", text: `[图片内容] ${text}` };
    } else {
      parsed.input[img.i][img.field][img.j] = { type: img.textType, text: `[图片内容] ${text}` };
    }
  }
  if (freshFails.length) {
    // 400, not 502: the gateway only surfaces its own message to the client for
    // sub-500 statuses (a 502 reads as "Proxy Bad Gateway. Please try again
    // later." and the real cause never reaches the user), and Claude Code retries
    // 5xx — which would mean paying the whole bridge budget again per retry.
    const nativeAlias = Object.keys(profileCfg.modelAliases || {}).find(a => mm[a] === true);
    const err = new Error(`图片识别失败：方案「${runtime.profileName}」的辅助模型 ${helperModel} 没能转述本轮新贴的 ${freshFails.length} 张图片（原因：${freshFails[0]}）。可在设置页把辅助模型换成真正支持视觉的模型${nativeAlias ? `，或直接用已勾选多模态的别名 ${nativeAlias} 发图` : ""}。`);
    err.statusCode = 400;
    throw err;
  }
  const stats = {
    total: keyed.length,
    hit: results.filter(r => r && r.hit).length,
    got: results.filter(r => r && r.fetched).length,
    ph: results.filter(r => r && r.placeholder).length,
    failed: results.filter(r => r && r.failed).length,
    ms: Date.now() - startedAt,
  };
  return { body: Buffer.from(JSON.stringify(parsed)), helperModel, stats };
}

// Pick the helper model: imageBridge.model (manual override) → first alias
// marked multimodal. Returns "" when the pool is empty.
function resolveBridgeHelperModel(profileCfg, mm) {
  const manual = profileCfg.imageBridge && profileCfg.imageBridge.model;
  if (manual) return manual;
  const aliases = profileCfg.modelAliases || {};
  const first = Object.keys(aliases).find(a => mm[a] !== false);
  return first ? aliases[first] : "";
}

function bridgeHelperCooldown(key) {
  const h = bridgeHelperHealth.get(key);
  return h && h.until > Date.now() ? h.until - Date.now() : 0;
}
function bridgeHelperNoteFailure(key, reason) {
  const h = bridgeHelperHealth.get(key) || { fails: 0, until: 0 };
  h.fails++;
  if (h.fails >= IMAGE_BRIDGE_HELPER_FAIL_LIMIT) {
    h.until = Date.now() + IMAGE_BRIDGE_HELPER_COOLDOWN_MS;
    h.fails = 0;
    console.log(`[图片桥接] 辅助模型连续失败，冷却 ${IMAGE_BRIDGE_HELPER_COOLDOWN_MS / 1000}s ${key} 最后原因=${reason}`);
  }
  bridgeHelperHealth.set(key, h);
}
function bridgeHelperNoteSuccess(key) {
  if (bridgeHelperHealth.has(key)) bridgeHelperHealth.set(key, { fails: 0, until: 0 });
}

// Pull the description out of a helper reply. Helper models are usually reasoning
// models: they emit a thinking/reasoning block first and can run out of tokens
// before writing any prose (with the old max_tokens=1024 they always did, which is
// what "辅助返回空描述" really was). Fall back to that block's text rather than
// failing the image, and report block kinds + stop_reason so the log is diagnosable.
function pickHelperDescription(json, isAnthropic) {
  if (isAnthropic) {
    const blocks = Array.isArray(json?.content) ? json.content : [];
    const kinds = [...new Set(blocks.map(b => b?.type).filter(Boolean))].join("+") || "无内容";
    const stop = json?.stop_reason || "?";
    const text = blocks.filter(b => b?.type === "text").map(b => b.text || "").join("\n").trim();
    if (text) return { text: clampDescription(text), kinds, stop };
    const thinking = blocks.filter(b => b?.type === "thinking").map(b => b.thinking || "").join("\n").trim();
    if (thinking) return { text: clampDescription(thinking), kinds, stop, fromThinking: true };
    return { text: "", kinds, stop };
  }
  const out = Array.isArray(json?.output) ? json.output : [];
  const kinds = [...new Set(out.map(o => o?.type).filter(Boolean))].join("+") || "无内容";
  const stop = json?.status || json?.incomplete_details?.reason || "?";
  // Responses implementations disagree on where the prose ends up, and the Anthropic
  // side's thinking-block rescue has no direct equivalent here — so walk every place
  // a description can legitimately live before giving up on the image.
  let text = out.filter(o => o?.type === "message")
    .flatMap(o => (Array.isArray(o.content) ? o.content : []))
    .filter(c => c?.type === "output_text")
    .map(c => c.text || "").join("\n").trim();
  if (!text) {
    // The convenience field: some servers fill only this and leave `output` empty.
    const ot = json?.output_text;
    text = (Array.isArray(ot) ? ot.join("\n") : String(ot || "")).trim();
  }
  if (!text) {
    // Any non-reasoning part carrying text, whatever the server chose to call it.
    text = out.filter(o => o?.type !== "reasoning")
      .flatMap(o => (Array.isArray(o.content) ? o.content : []))
      .map(c => (typeof c?.text === "string" ? c.text : "")).join("\n").trim();
  }
  if (text) return { text: clampDescription(text), kinds, stop };
  const reasoning = out.filter(o => o?.type === "reasoning")
    .flatMap(o => [...(Array.isArray(o.summary) ? o.summary : []), ...(Array.isArray(o.content) ? o.content : [])])
    .map(s => (typeof s === "string" ? s : s?.text || "")).join("\n").trim();
  if (reasoning) return { text: clampDescription(reasoning), kinds, stop, fromThinking: true };
  return { text: "", kinds, stop };
}

// Ask the helper model to describe a base64 image. Returns { ok: true, text } or
// { ok: false, reason } with a human-readable Chinese reason the caller can put in
// front of the user. Client disconnects are RETHROWN, never turned into a failure:
// a hang-up used to become a synthetic 502 that fooled the failover layer into
// re-running the whole bridge against the next profile.
// Uses the profile's real upstream + key (same auth). The helper call speaks the
// SAME protocol as the profile it serves: Responses profiles ask /v1/responses
// with input_image, Anthropic profiles ask /v1/messages with an image block.
async function describeImageViaHelper(b64, helperModel, runtime, clientState, profileCfg, protocol, mediaType, timeoutMs) {
  const timeout = timeoutMs || IMAGE_BRIDGE_CALL_TIMEOUT_MS;
  const healthKey = `${runtime.upstreamUrl.host}|${helperModel}`;
  const cooldown = bridgeHelperCooldown(healthKey);
  if (cooldown > 0) return { ok: false, reason: `辅助模型 ${helperModel} 连续失败，冷却中（还剩 ${Math.ceil(cooldown / 1000)}s）` };
  // The helper never sees the user's question and gets exactly one shot: its text
  // replaces the image permanently and is cached, so anything left out is lost for
  // good. Hence the explicit priority order, the verbatim-text rule, and the length
  // ceiling. "不要解释你在做什么" also steers reasoning helpers away from spending
  // their whole budget narrating the task instead of describing the image.
  const instruction = "你是图片转述助手。你写的描述会替换掉这张图片本身，交给一个看不到图的语言模型，并且会被缓存复用——这是唯一一次机会，写漏的信息将永久丢失。请用简体中文按以下优先级转述：①图片类型与主体（截图／照片／图表／代码等）；②图中所有可见文字，原样抄录，不要改写或翻译；③布局、元素位置与控件状态（选中／报错／高亮等）；④配色与其他视觉特征。要求完整但紧凑，普通图片控制在 400 字以内，文字密集的截图最多 800 字。只输出描述本身，不要任何前后缀，不要解释你在做什么。";
  const mt = mediaType || "image/png";
  const isAnthropic = protocol === "anthropic";
  const buildBody = (askNoThinking) => isAnthropic
    ? JSON.stringify({
        model: helperModel,
        // 4096, not 1024: a reasoning helper spends its budget on thinking first
        // and truncates before any prose — leave room for both.
        max_tokens: 4096,
        stream: false,
        ...(askNoThinking ? { thinking: { type: "disabled" } } : {}),
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mt, data: b64 } },
          { type: "text", text: instruction },
        ] }],
      })
    : JSON.stringify({
        model: helperModel,
        instructions: instruction,
        input: [
          { type: "message", role: "user", content: [
            { type: "input_image", image_url: `data:${mt};base64,${b64}` },
          ] },
        ],
        store: false,
        stream: false,
      });

  for (let attempt = 0; ; attempt++) {
    const askNoThinking = isAnthropic && attempt === 0 && !bridgeThinkingUnsupported.has(healthKey);
    const body = buildBody(askNoThinking);
    const headers = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      host: runtime.upstreamUrl.host,
      authorization: `Bearer ${getRealKeyFromProfile(profileCfg)}`,
    };
    let upRes;
    try {
      upRes = await sendUpstream(Buffer.from(body), isAnthropic ? "/v1/messages" : "/v1/responses", "POST", headers, timeout, runtime, clientState);
    } catch (e) {
      if (isClientAbortError(e)) throw e;
      const reason = e.isTimeout ? `辅助模型超时（${Math.round(timeout / 1000)}s 未返回）` : `辅助模型连接失败：${e.message}`;
      console.log(`${clientState.tag || ""} [图片桥接] 辅助调用异常 模型=${helperModel} err=${e.message}`);
      bridgeHelperNoteFailure(healthKey, reason);
      return { ok: false, reason };
    }
    const snippet = () => upRes.body.toString().slice(0, 200).replace(/\s+/g, " ");
    if (upRes.statusCode !== 200) {
      // Some Anthropic-compatible upstreams reject an unknown `thinking` field:
      // drop it once, remember that host+model, and retry instead of failing.
      if (askNoThinking && upRes.statusCode < 500 && /thinking/i.test(snippet())) {
        bridgeThinkingUnsupported.add(healthKey);
        console.log(`${clientState.tag || ""} [图片桥接] 上游不接受 thinking 字段，去掉后重试 模型=${helperModel}`);
        continue;
      }
      console.log(`${clientState.tag || ""} [图片桥接] 辅助调用失败 模型=${helperModel} status=${upRes.statusCode} body=${snippet()}`);
      const reason = `辅助模型返回 ${upRes.statusCode}：${snippet().slice(0, 80)}`;
      bridgeHelperNoteFailure(healthKey, reason);
      return { ok: false, reason };
    }
    let json;
    try { json = JSON.parse(upRes.body.toString()); } catch {
      console.log(`${clientState.tag || ""} [图片桥接] 辅助响应不是 JSON 模型=${helperModel} body=${snippet()}`);
      const reason = "辅助模型响应不是合法 JSON";
      bridgeHelperNoteFailure(healthKey, reason);
      return { ok: false, reason };
    }
    const picked = pickHelperDescription(json, isAnthropic);
    if (picked.text) {
      if (picked.fromThinking) console.log(`${clientState.tag || ""} [图片桥接] 辅助只给了思考过程，降级取思考文本 模型=${helperModel} stop_reason=${picked.stop}`);
      bridgeHelperNoteSuccess(healthKey);
      return { ok: true, text: picked.text };
    }
    console.log(`${clientState.tag || ""} [图片桥接] 辅助返回空描述 模型=${helperModel} blocks=${picked.kinds} stop_reason=${picked.stop} body=${snippet()}`);
    const reason = `辅助模型只返回 ${picked.kinds}、无描述正文（stop_reason=${picked.stop}）`;
    bridgeHelperNoteFailure(healthKey, reason);
    return { ok: false, reason };
  }
}

// ─── Tool-schema compat: strip regex patterns the upstream can't compile ───
// Zhipu GLM's tool-schema validator rejects requests whose tool `pattern`
// fields use regex it cannot compile, with error 1210 "API 调用参数有误" for
// the WHOLE request. Empirically (2026-09) the toxic constructs are Unicode
// property classes (`\p{Cc}`…) — lookarounds compile fine there, but RE2-based
// validators reject those, so both classes are stripped conservatively.
// Claude Code ≥2.1.266 ships an "Artifact" tool whose schema carries such
// patterns, so every interactive request would fail against such upstreams.
// Patterns are optional validation hints; a background probe re-enables
// pass-through once the upstream learns to accept them.
const UNSUPPORTED_PATTERN_RE = /\\[pP]\{|\(\?[=!]/;   // \p{ \P{ (?= (?! (?<= (?<!

// Recursively drop `pattern` fields using constructs the upstream can't
// compile. Returns count removed.
function stripUnsupportedPatternsNode(node) {
  let removed = 0;
  if (Array.isArray(node)) {
    for (const item of node) removed += stripUnsupportedPatternsNode(item);
  } else if (node && typeof node === "object") {
    if (typeof node.pattern === "string" && UNSUPPORTED_PATTERN_RE.test(node.pattern)) {
      delete node.pattern;
      removed++;
    }
    for (const key of Object.keys(node)) {
      if (key !== "pattern") removed += stripUnsupportedPatternsNode(node[key]);
    }
  }
  return removed;
}

// Rewrite a parsed request body in place, stripping lookaround patterns from
// every tool schema (Anthropic `input_schema` and OpenAI `parameters` shapes).
// Returns the number of patterns removed (0 → nothing worth re-serializing).
function stripUnsupportedToolPatterns(parsed) {
  if (!Array.isArray(parsed?.tools)) return 0;
  let removed = 0;
  for (const tool of parsed.tools) {
    if (!tool || typeof tool !== "object") continue;
    const schema = tool.input_schema ?? tool.parameters;
    if (schema && typeof schema === "object") removed += stripUnsupportedPatternsNode(schema);
  }
  return removed;
}

function normalizeToolPatternCompat(v) {
  return v === "always" || v === "off" ? v : "auto";
}

// Initial stripping decision for a profile: "always"/"off" follow the config
// verbatim; "auto" (default) strips only for third-party Anthropic-compatible
// upstreams — Anthropic's own API compiles lookarounds fine — and the probe
// below refines that over time.
function computeToolPatternsActive(profile, upstreamUrl) {
  const mode = normalizeToolPatternCompat(profile.toolPatternCompat);
  if (mode === "always") return true;
  if (mode === "off") return false;
  if (normalizeProfileProtocol(profile.protocol) !== "anthropic") return false;
  const host = upstreamUrl.hostname;
  return !(host === "api.anthropic.com" || host.endsWith(".anthropic.com"));
}

const TOOL_PATTERN_PROBE_DELAY_MS = Math.max(0, Number(process.env.TOOL_PATTERN_PROBE_DELAY_MS) || 30000);
const TOOL_PATTERN_PROBE_INTERVAL_MS = Math.max(60000, Number(process.env.TOOL_PATTERN_PROBE_INTERVAL_MS) || 6 * 3600 * 1000);

function toolPatternProbeBody(model) {
  return {
    model, max_tokens: 64, stream: false,
    messages: [{ role: "user", content: "ping" }],
    tools: [{
      name: "gateway_compat_probe",
      description: "Gateway reachability probe; never meaningful to call.",
      // Same construct that breaks real traffic (Zhipu rejects `\p{…}` classes
      // with 1210) so the probe verdict matches live behaviour.
      input_schema: {
        type: "object",
        properties: { path: { type: "string", pattern: "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]{1,200}$" } },
        required: [],
      },
    }],
  };
}

// Ask the upstream whether it accepts a lookaround pattern: true = accepted,
// false = rejected with Zhipu-style 1210, null = inconclusive (network error,
// auth failure, other status) — inconclusive leaves current behaviour as is.
function probeToolPatternSupport(rt) {
  return new Promise((resolve) => {
    const realKey = getRealKeyFromProfile(config.profiles[rt.profileName] || {});
    const model = (rt.allowedModels && rt.allowedModels[0]) || Object.values(rt.modelAliases || {})[0];
    if (!realKey || !model) { resolve(null); return; }
    const body = Buffer.from(JSON.stringify(toolPatternProbeBody(model)));
    const transport = rt.upstreamUrl.protocol === "https:" ? https : http;
    const req = transport.request({
      hostname: rt.upstreamUrl.hostname,
      port: rt.upstreamUrl.port || (rt.upstreamUrl.protocol === "https:" ? 443 : 80),
      path: rt.upstreamUrl.pathname.replace(/\/$/, "") + "/v1/messages",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": body.length,
        authorization: `Bearer ${realKey}`,
        "x-api-key": realKey,
        "anthropic-version": "2023-06-01",
      },
      agent: rt.agent,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode === 200) resolve(true);
        else if (res.statusCode === 400 && text.includes("1210")) resolve(false);
        else resolve(null);
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error("probe timeout")));
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function runToolPatternProbe(rt) {
  if (rt.protocol !== "anthropic" || rt.toolPatternCompat !== "auto") return;
  const supported = await probeToolPatternSupport(rt);
  if (supported === null) return;
  if (supported && rt.toolPatternsActive) {
    rt.toolPatternsActive = false;
    console.log(`[工具兼容] 方案「${rt.profileName}」: 探测到上游已支持这些 pattern 特性，恢复完整工具定义`);
  } else if (!supported && !rt.toolPatternsActive) {
    rt.toolPatternsActive = true;
    console.log(`[工具兼容] 方案「${rt.profileName}」: 探测到上游拒绝此类 pattern(1210)，重新启用剔除`);
  } else {
    console.log(`[工具兼容] 方案「${rt.profileName}」: 探测完成，上游${supported ? "已支持" : "仍不支持此类 pattern"}，剔除保持${rt.toolPatternsActive ? "开启" : "关闭"}`);
  }
}

function scheduleToolPatternProbes() {
  const first = setTimeout(() => { for (const rt of Object.values(runtimes)) runToolPatternProbe(rt); }, TOOL_PATTERN_PROBE_DELAY_MS);
  const timer = setInterval(() => { for (const rt of Object.values(runtimes)) runToolPatternProbe(rt); }, TOOL_PATTERN_PROBE_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
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

function proxyRequest(req, res) {
  // Correlation tag: concurrent clients (Claude Code + Codex) interleave their log
  // lines in one console; every line of a request carries the same tag so the
  // interleaving can be undone by eye. Short on purpose — 2 bytes of hex.
  const reqTag = "#" + crypto.randomBytes(2).toString("hex");
  const inbound = classifyInboundPath(req.url, req.method);
  if (inbound.kind === "unsupported") {
    sendOpenAiError(res, 404, "unsupported_endpoint", unsupportedInboundMessage(inbound.reason));
    return;
  }
  if (inbound.kind === "models") {
    handleLocalModelsRequest(req, res, inbound);
    return;
  }

  // Resolve which profile this request targets, scoped to the inbound protocol.
  const protocol = inbound.kind;
  const resolvedProfile = protocol === "responses"
    ? resolveResponsesProfile(inbound, req.url)
    : resolveProfile(req.url);
  if (resolvedProfile.noResponsesProfile) {
    sendOpenAiError(res, 503, "no_responses_profile", "No responses profile configured yet. Create one in Settings to use Codex.");
    return;
  }
  if (resolvedProfile.error) {
    if (protocol === "responses") {
      sendOpenAiError(res, 404, "invalid_request", resolvedProfile.error);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: resolvedProfile.error }));
    }
    return;
  }
  const { suffix, runtime, strippedUrl } = resolvedProfile;
  if (!runtime) {
    if (protocol === "responses") {
      sendOpenAiError(res, 503, "no_responses_profile", "No responses profile configured yet. Create one in Settings to use Codex.");
    } else {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No configured proxy profile. Open Settings to configure an Anthropic upstream." }));
    }
    return;
  }
  const apiKey = getApiKey(req);

  // Request log: attach as soon as the user context exists so every
  // user-visible outcome below (403/429/5xx/proxied traffic) is captured.
  // The readBody callback enriches the holder with model / source / profile.
  const reqLog = {
    start: Date.now(),
    user: getUserName(apiKey, runtime),
    key: maskAuditKey(apiKey),
    ip: getClientIp(req),
    proto: protocol,
    src: "",
    model: "",
    profile: "",
  };

  // Cross-protocol guard: an Anthropic-protocol request must never be served by
  // a responses profile, even via direct suffix access (and vice versa above).
  if (protocol === "anthropic" && runtime.protocol !== "anthropic") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `方案 "${runtime.profileName}" 是 Responses(Codex) 方案，不能通过 /v1/messages 访问。请通过 /v1/responses 或 /${suffix}/v1/responses 使用。` }));
    recordError(apiKey, 400, `cross_protocol: /${suffix} Responses 方案收到 /v1/messages 请求`, req.url, "unknown", suffix, runtime);
    console.log(`${reqTag} [拦截] ${getUserName(apiKey, runtime)} 跨协议访问被拒 /${suffix} 是 Responses 方案`);
    return;
  }

  // Reject non-API requests (browser favicon, Chrome DevTools, etc.) before any group check.
  // These requests carry no auth header (apiKey === "unknown") and would otherwise be mis-logged
  // as "直连被拒" when the path falls through to a default-runtime group member.
  if (apiKey === "unknown") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  // Group members (default-profile-group with ≥2 entries) are reachable only via the
  // protocol's /v1 entry, which fails over across the group. Reject direct /<suffix>/...
  // access so users can't bypass failover to pin an expensive on-demand profile.
  // Super users (global user superUser=true) are exempt and may direct-connect any profile.
  const dpg = protocol === "responses"
    ? (Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup : [])
    : (Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : []);
  const groupEntryPath = protocol === "responses" ? "/v1/responses" : "/v1/messages";
  if (config.restrictGroupSuffix !== false && !isSuperUser(apiKey, runtime) && !resolvedProfile.isDefaultEntry && dpg.length >= 2 && dpg.includes(runtime.profileName)) {
    if (protocol === "responses") {
      sendOpenAiError(res, 403, "group_member_restricted", `方案 "${runtime.profileName}" 是 Responses 方案组成员，请通过 /v1/responses 入口使用（系统按 failover 顺序自动调度）。`);
    } else {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: {
          type: "group_member_restricted",
          message: `方案 "${runtime.profileName}" 是默认方案组成员，请通过 /v1 入口使用（系统按 failover 顺序自动调度）。`
        },
        hint: "Use /v1/messages instead."
      }));
    }
    recordError(apiKey, 403, `group_member_restricted: /${suffix} 直连被拒，引导走 ${groupEntryPath}`, req.url, "unknown", suffix, runtime);
    console.log(`${reqTag} [拦截] ${getUserName(apiKey, runtime)} 直连组内方案 /${suffix} 被拒 → 引导 ${groupEntryPath}`);
    return;
  }

  const proxyStartTime = Date.now();
  let proxyPhase = "init";
  const clientState = createClientAbortState();
  clientState.tag = reqTag;
  clientState.reqLog = reqLog;
  attachRequestLogger(res, clientState, reqLog);

  // Global IP rate limit
  const clientIp = getClientIp(req);
  if (!checkIpRateLimit(clientIp)) {
    if (protocol === "responses") sendOpenAiError(res, 429, "ip_rate_limit_exceeded", "IP rate limit exceeded. Please slow down.", { "Retry-After": "60" });
    else {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      res.end(JSON.stringify({ error: "IP rate limit exceeded. Please slow down.", type: "ip_rate_limit_exceeded" }));
    }
    recordError(apiKey, 429, `ip_rate_limit_exceeded: ${clientIp}`, req.url, "unknown", suffix, runtime);
    return;
  }

  req.on("error", (err) => {
    console.error(`${reqTag} [Socket] 客户端请求错误 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)} err=${err.message}`);
  });
  res.on("error", (err) => {
    console.error(`${reqTag} [Socket] 客户端响应错误 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)} err=${err.message}`);
    markClientAborted(clientState, "response-error");
  });
  req.on("aborted", () => {
    if (!res.writableEnded) {
      markClientAborted(clientState, "request-aborted");
      console.log(`${reqTag} [Socket] 客户端提前断开 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)} reason=request-aborted`);
    }
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      markClientAborted(clientState, "response-closed");
      console.log(`${reqTag} [Socket] 客户端提前断开 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)} reason=response-closed`);
    }
  });


  const userKey = resolveUserKey(apiKey, runtime);
  const targetUrl = strippedUrl || req.url;

  // Reject unknown API keys and users not assigned to this profile before any upstream work.
  const earlyAccess = canUseProfile(apiKey, runtime);
  if (!earlyAccess.allowed) {
    if (protocol === "responses") sendOpenAiError(res, 403, "forbidden", earlyAccess.reason);
    else {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: earlyAccess.reason }));
    }
    console.log(`[拦截] ${apiKey.slice(0, 8)}**** profile=${runtime.profileName} ${req.method} ${targetUrl} ${earlyAccess.reason}`);
    return;
  }

  readBody(req, 50_000_000).then(async (body) => {
    proxyPhase = "body-read";
    let reqModel = "unknown";
    let reqSource = "用户请求";
    let originalModel = "unknown";
    let parsedBody = null;
    try {
      const parsed = parsedBody = sanitizeJson(JSON.parse(body.toString()));
      reqModel = parsed.model || "unknown";
      originalModel = reqModel;
      if (protocol === "responses") {
        // Responses input: a trailing tool-output item marks a tool-result turn.
        const items = Array.isArray(parsed.input) ? parsed.input : [];
        const lastItem = items[items.length - 1];
        if (lastItem && typeof lastItem === "object" &&
          (lastItem.type === "function_call_output" || lastItem.type === "custom_tool_call_output" || lastItem.type === "local_shell_call_output")) {
          reqSource = "工具调用";
        }
      } else {
        // Detect request source: user input vs tool result vs subagent
        const msgs = parsed.messages || [];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === "user") {
          const content = lastMsg.content;
          if (Array.isArray(content)) {
            const hasToolResult = content.some(b => b.type === "tool_result");
            const hasText = content.some(b => b.type === "text");
            if (hasToolResult && !hasText) reqSource = "工具调用";
            else if (hasToolResult && hasText) reqSource = "用户+工具";
          }
          const sys = typeof parsed.system === "string" ? parsed.system :
            Array.isArray(parsed.system) ? parsed.system.map(b => b.text || "").join(" ") : "";
          if (sys.includes("SUBAGENT_STOP")) {
            reqSource = "子代理";
          }
        }
      }
    } catch {}

    // Enrich the request log with what only the parsed body reveals.
    reqLog.model = originalModel;
    reqLog.src = reqSource;

    // Sticky-session signal for cache-affinity routing (group entries only).
    const sessionSignal = extractSessionSignal(protocol, req.headers, parsedBody);

    // 产出质量观测:纯观察旁路,setImmediate 不阻塞代理主路径,不改请求/响应字节。
    if (parsedBody && productionEnabled()) {
      const prodUser = resolveUserKey(apiKey, runtime);
      setImmediate(() => productionTracker.observe({
        protocol, userKey: prodUser, userName: getUserName(prodUser, runtime),
        profile: runtime?.profileName || "", model: originalModel,
        session: sessionSignal || "nosession", parsed: parsedBody,
      }));
    }

    // Save the pre-resolve body so each failover candidate can re-resolve the model
    // against its own modelAliases.
    const originalBody = body;

    // Build the ordered candidate list. Default-group entries fail over across
    // the whole protocol-matched group; explicit /<suffix>/... requests stay pinned.
    let candidateList = resolvedProfile.isDefaultEntry
      ? (protocol === "responses" ? getAvailableResponsesProfiles(apiKey) : getAvailableDefaultProfiles(apiKey))
      : [{ name: runtime.profileName, suffix, runtime }];
    if (resolvedProfile.isDefaultEntry) {
      candidateList = applyStickyReorder(candidateList, getStickyProfile(protocol, userKey, sessionSignal));
    }
    // If every default-group member is currently unavailable (all rate-limited / breaker
    // open / unauthorized), fall back to the resolved default so the normal error path runs.
    if (candidateList.length === 0) {
      candidateList.push({ name: runtime.profileName, suffix, runtime });
    }

    // Rate + concurrency are per-user, independent of which profile serves the request.
    if (!checkAndRecordRate(userKey)) {
      if (protocol === "responses") sendOpenAiError(res, 429, "rate_limit_exceeded", "Rate limit exceeded. Please slow down.", { "Retry-After": "60" });
      else {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
        res.end(JSON.stringify({ error: "Rate limit exceeded. Please slow down.", type: "rate_limit_exceeded" }));
      }
      recordError(apiKey, 429, "rate_limit_exceeded", req.url, reqModel, suffix, runtime);
      return;
    }
    if (!tryAcquireConcurrency(userKey)) {
      if (protocol === "responses") sendOpenAiError(res, 429, "concurrency_exceeded", "Too many concurrent requests. Please try again later.", { "Retry-After": "1" });
      else {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
        res.end(JSON.stringify({ error: "Too many concurrent requests. Please try again later.", type: "concurrency_exceeded" }));
      }
      recordError(apiKey, 429, "concurrency_exceeded", req.url, reqModel, suffix, runtime);
      return;
    }

    let lastFailure = null;   // { kind, status?, message?, runtime, suffix, quota?, err? }
    let served = false;
    let servedBy = null;      // profile that actually served (for sticky binding)
    try {
      for (let ci = 0; ci < candidateList.length; ci++) {
        const cand = candidateList[ci];
        const cruntime = cand.runtime;
        const csuffix = cand.suffix;
        const isLastCandidate = ci === candidateList.length - 1;

        // Per-candidate model resolution (each profile may map aliases differently).
        let cbody = originalBody;
        let creqModel = reqModel;
        try {
          const resolved = resolveModel(reqModel, cruntime);
          if (resolved !== reqModel) {
            const parsed = JSON.parse(originalBody.toString());
            parsed.model = resolved;
            cbody = Buffer.from(JSON.stringify(parsed));
            creqModel = resolved;
          }
        } catch {}

        if (!checkModelAllowed(creqModel, cruntime)) {
          lastFailure = { kind: "model", status: 403, model: creqModel, originalModel, message: modelNotAllowedMessage(creqModel, cruntime), runtime: cruntime, suffix: csuffix };
          if (!isLastCandidate) continue;
          break;
        }

        // Circuit breaker: skip an open upstream and try the next candidate (default
        // group entries are pre-filtered, so this mainly guards explicit /suffix/ use).
        if (!cruntime.breaker.allowRequest()) {
          lastFailure = { kind: "breaker", status: 503, runtime: cruntime, suffix: csuffix };
          if (!isLastCandidate) continue;
          break;
        }

        // creqModel is already resolved through this candidate's aliases, so the
        // quota figures (and any 429 copy) reflect the model that would actually
        // be billed — not the profile default.
        const quota = checkTokenQuota(apiKey, csuffix, cruntime, creqModel);
        if (!quota.allowed) {
          lastFailure = { kind: "quota", status: 429, quota, runtime: cruntime, suffix: csuffix };
          if (!isLastCandidate) continue;
          break;
        }

        try {
          proxyPhase = "upstream-connect";
          let realKey = getRealKey(apiKey, cruntime);
          if (realKey === apiKey && isSuperUser(apiKey, cruntime)) {
            // 超级用户未在该方案分配真实Key：借用方案上已有的key转发。
            // 借不到（方案一个真实Key都没有）时明确拒绝，绝不把虚拟Key发往上游。
            const borrowed = borrowProfileRealKey(cruntime);
            if (!borrowed) {
              lastFailure = { kind: "no_real_key", status: 403,
                err: new Error(`方案 "${cruntime.profileName}" 未配置任何可用真实Key，无法为超级用户转发请求。请先在设置中为该方案分配真实Key。`),
                runtime: cruntime, suffix: csuffix };
              if (!isLastCandidate) continue;
              break;
            }
            realKey = borrowed;
          }
          const reqHeaders = { ...req.headers, host: cruntime.upstreamUrl.host, "content-length": cbody.length };
          console.log(`── 请求开始 ── ${reqTag} ${getUserName(apiKey, cruntime)} [${reqSource}] 模型=${originalModel}${originalModel !== creqModel ? "→" + creqModel : ""}${csuffix ? ` [${csuffix}]` : ""} ──`);
          if (realKey !== apiKey) {
            // Rewrite BOTH auth conventions so a tool that also sends the virtual
            // key in x-api-key (e.g. ZCode sends VK in both authorization and
            // x-api-key) doesn't leak the jx- virtual key upstream. Anthropic-style
            // upstreams read x-api-key first and would 401 on the malformed key.
            reqHeaders["authorization"] = `Bearer ${realKey}`;
            reqHeaders["x-api-key"] = realKey;
            console.log(`${reqTag} [映射] ${getUserName(apiKey, cruntime)} 虚拟key=${apiKey.slice(0,8)}**** 请求模型=${originalModel}${originalModel !== creqModel ? " → 实际=" + creqModel : ""}`);
          }
          delete reqHeaders["connection"];
          delete reqHeaders["transfer-encoding"];
          delete reqHeaders["accept-encoding"];

          const isStreamRequest = (req.headers["accept"] || "").includes("text/event-stream") ||
            (function() { try { return JSON.parse(cbody.toString()).stream; } catch { return false; } })();

          // Tool-schema compat: some upstream validators (GLM 1210) reject the
          // whole request when a tool schema carries lookaround regex. Runs
          // before the image bridge so the bridge re-serializes the stripped
          // body, never resurrecting a removed pattern.
          if (cruntime.toolPatternsActive && cbody.includes('"tools"')) {
            try {
              const strippedBody = JSON.parse(cbody.toString());
              const removedPatterns = stripUnsupportedToolPatterns(strippedBody);
              if (removedPatterns > 0) {
                cbody = Buffer.from(JSON.stringify(strippedBody));
                reqHeaders["content-length"] = cbody.length;
                console.log(`${reqTag} [工具兼容] ${getUserName(apiKey, cruntime)} 剔除 ${removedPatterns} 处上游不支持的 pattern model=${creqModel}`);
              }
            } catch {}
          }

          // Image-recognition bridge (both protocols): non-multimodal aliases
          // with images are rewritten into helper-model descriptions before the
          // request goes upstream. Runs for both streaming and JSON requests
          // (only the request body is touched; the response mode is unaffected).
          {
            const bridged = await bridgeImagesInRequest(cbody, cruntime, clientState, originalModel, protocol);
            if (bridged) {
              cbody = bridged.body;
              reqHeaders["content-length"] = cbody.length;
              const bs = bridged.stats;
              clientState.bridgeMs = (clientState.bridgeMs || 0) + bs.ms;
              clientState.bridgeRan = true;
              console.log(`${reqTag} [图片桥接] ${getUserName(apiKey, cruntime)} 图 ${bs.total} 张（命中 ${bs.hit} / 新识 ${bs.got} / 占位 ${bs.ph} / 失败 ${bs.failed}）耗时 ${(bs.ms / 1000).toFixed(1)}s 辅助=${bridged.helperModel} → ${creqModel}`);
            }
          }

          proxyPhase = isStreamRequest ? "streaming-proxy" : "json-proxy";
          const timeout = isStreamRequest ? gProxy.streamTimeout : gProxy.timeout;

          // responsesPath can differ per profile (e.g. Volcano uses base+/responses
          // while most others use base+/v1/responses). The default entry's strippedUrl
          // is built from the group HEAD's responsesPath, so it must NOT be reused for
          // a failover member — rebuild it from this candidate's own responsesPath.
          const candStrippedUrl = protocol === "responses"
            ? (cruntime.responsesPath || "/v1/responses") + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "")
            : strippedUrl;

          if (isStreamRequest) {
            await handleStreamingProxy(req, res, cbody, reqHeaders, apiKey, creqModel, timeout, reqSource, cruntime, csuffix, candStrippedUrl, clientState);
          } else {
            await handleJsonProxy(req, res, cbody, reqHeaders, apiKey, creqModel, timeout, reqSource, cruntime, csuffix, candStrippedUrl, clientState);
          }
          served = true;
          servedBy = cand.name;
          reqLog.profile = servedBy;
          break;
        } catch (err) {
          if (err?.isRateLimited) {
            markRateLimited(cand.name, err.resumeAt, err.source);
            lastFailure = { kind: "rate-limit", status: 429, err, runtime: cruntime, suffix: csuffix };
            if (!isLastCandidate) continue;
            break;
          }
          if (isClientAbortError(err)) {
            console.log(`${reqTag} [取消] ${getUserName(apiKey, cruntime)} 客户端已断开，停止代理 model=${creqModel} phase=${proxyPhase}`);
            served = true;   // client disconnect is not a failure to surface
            break;
          }
          lastFailure = { kind: "proxy", status: err.statusCode || (err.isTimeout ? 504 : 502), err, runtime: cruntime, suffix: csuffix };
          if (!isLastCandidate) continue;
          break;
        }
      }

      // Every candidate failed: surface the last failure to the client.
      if (!served && lastFailure && !res.headersSent) {
        if (protocol === "responses") {
          // Responses-protocol clients (Codex) get OpenAI-style error bodies.
          if (lastFailure.kind === "model") {
            sendOpenAiError(res, 403, "model_not_allowed", lastFailure.message);
            console.log(`${reqTag} [拦截] ${apiKey.slice(0, 8)}**** profile=${lastFailure.runtime.profileName} model 拒绝 请求模型=${lastFailure.originalModel} 解析后=${lastFailure.model} 允许=${(lastFailure.runtime.allowedModels || []).join(",")}`);
          } else if (lastFailure.kind === "breaker") {
            const remaining = Math.ceil(lastFailure.runtime.breaker.status().cooldownRemaining / 1000);
            sendOpenAiError(res, 503, "upstream_unavailable", `Upstream temporarily unavailable. Circuit open, retry in ${remaining}s.`);
            recordError(apiKey, 503, "Circuit breaker open", req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
          } else if (lastFailure.kind === "quota") {
            const q = lastFailure.quota;
            const reqHost = req.headers.host || `localhost:${port}`;
            const usageUrl = `http://${reqHost}/usage/${apiKey}`;
            const retryAfter = secondsUntilNextCnMidnight();
            sendOpenAiError(res, 429, "quota_exceeded",
              quotaExceededMessage(q, lastFailure.runtime, usageUrl),
              { "Retry-After": String(retryAfter) });
            recordError(apiKey, 429, `${quotaErrorDetail(q)}, retry in ${retryAfter}s`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
          } else if (lastFailure.kind === "rate-limit") {
            const retryAfter = Math.max(1, Math.ceil((lastFailure.err.resumeAt - Date.now()) / 1000));
            sendOpenAiError(res, 429, "rate_limit_exceeded",
              `所有可用方案均已限额，最早 ${beijingTimeString(new Date(lastFailure.err.resumeAt))} 恢复。`,
              { "Retry-After": String(retryAfter) });
            recordError(apiKey, 429, `all profiles rate-limited until ${beijingTimeString(new Date(lastFailure.err.resumeAt))}`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
          } else {
            const status = lastFailure.status;
            const label = status === 504 ? "Gateway Timeout" : status === 502 ? "Bad Gateway" : "Request Error";
            // 4xx from gateway-internal validation (e.g. bridge limits): surface
            // the actual status + message instead of masking it as Bad Gateway.
            const clientMsg = status < 500 ? lastFailure.err.message : `Proxy ${label}. Please try again later.`;
            sendOpenAiError(res, status, "proxy_error", clientMsg);
            recordError(apiKey, status, `${label}: ${lastFailure.err.message}`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
          }
        } else if (lastFailure.kind === "model") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: lastFailure.message }));
          console.log(`${reqTag} [拦截] ${apiKey.slice(0, 8)}**** profile=${lastFailure.runtime.profileName} model 拒绝 请求模型=${lastFailure.originalModel} 解析后=${lastFailure.model} 允许=${(lastFailure.runtime.allowedModels || []).join(",")}`);
        } else if (lastFailure.kind === "breaker") {
          const remaining = Math.ceil(lastFailure.runtime.breaker.status().cooldownRemaining / 1000);
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Upstream temporarily unavailable. Circuit open, retry in ${remaining}s.` }));
          recordError(apiKey, 503, "Circuit breaker open", req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
        } else if (lastFailure.kind === "quota") {
          const q = lastFailure.quota;
          const reqHost = req.headers.host || `localhost:${port}`;
          const usageUrl = `http://${reqHost}/usage/${apiKey}`;
          const retryAfter = secondsUntilNextCnMidnight();
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfter) });
          res.end(JSON.stringify({
            error: quotaExceededMessage(q, lastFailure.runtime, usageUrl),
            type: "quota_exceeded",
            quota: { used: q.used, limit: q.limit, remaining: q.remaining, source: q.source, rawUsed: q.rawUsed, discounted: q.discounted, rate: q.rate },
            usageUrl,
          }));
          recordError(apiKey, 429, `${quotaErrorDetail(q)}, retry in ${retryAfter}s`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
        } else if (lastFailure.kind === "rate-limit") {
          const retryAfter = Math.max(1, Math.ceil((lastFailure.err.resumeAt - Date.now()) / 1000));
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfter) });
          res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: `所有可用方案均已限额，最早 ${beijingTimeString(new Date(lastFailure.err.resumeAt))} 恢复。` } }));
          recordError(apiKey, 429, `all profiles rate-limited until ${beijingTimeString(new Date(lastFailure.err.resumeAt))}`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
        } else {
          const status = lastFailure.status;
          const label = status === 504 ? "Gateway Timeout" : status === 502 ? "Bad Gateway" : "Request Error";
          const clientMsg = status < 500 ? lastFailure.err.message : `Proxy ${label}. Please try again later.`;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: clientMsg }));
          recordError(apiKey, status, `${label}: ${lastFailure.err.message}`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
        }
      }

      // Cache-affinity binding: the binding may only ever point at the protocol's
      // group head. A normal turn served by the head refreshes it (cache affinity
      // across turns); a turn served by a failover member clears it — so once the
      // head recovers from a limit/breaker it naturally returns to the front
      // instead of the conversation staying pinned to the fallback profile.
      if (servedBy && resolvedProfile.isDefaultEntry && sessionSignal) {
        const headName = protocol === "responses"
          ? (Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup[0] : null)
          : (Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup[0] : null);
        if (headName && servedBy === headName) {
          setStickyProfile(protocol, userKey, sessionSignal, servedBy);
        } else {
          deleteStickyProfile(protocol, userKey, sessionSignal);
        }
      }

      // Failover audit: one "switch"/"recover" per state change, not per request.
      if (servedBy && resolvedProfile.isDefaultEntry) {
        noteFailoverServed(protocol, servedBy, getUserName(apiKey, runtime));
      }
    } finally {
      releaseConcurrency(userKey);
      // Timings on the closing line: total, time-to-first-byte and how much of it
      // the image bridge spent, so "why was that turn slow" is answerable from the log.
      const secs = (ms) => (ms / 1000).toFixed(1) + "s";
      const totalMs = Date.now() - proxyStartTime;
      const parts = [`总耗时 ${secs(totalMs)}`];
      if (clientState.firstByteAt) {
        parts.push(`首字节 ${secs(clientState.firstByteAt - proxyStartTime)}`);
        // Split what is left into generation time + rate: prefill-bound turns (huge
        // context, cold prompt cache) and generation-bound turns (slow upstream)
        // look identical from the total alone.
        const genMs = Date.now() - clientState.firstByteAt;
        const outTok = clientState.lastUsage?.usage?.output_tokens || 0;
        if (genMs > 500) {
          parts.push(outTok > 0
            ? `生成 ${secs(genMs)}(${outTok}tok ${(outTok / (genMs / 1000)).toFixed(1)}tok/s)`
            : `生成 ${secs(genMs)}`);
        }
      }
      // bridgeRan, not bridgeMs: a 0ms bridge is exactly the "cost zero helper
      // calls" proof worth seeing, and 0 is falsy.
      if (clientState.bridgeRan) parts.push(`图片桥接 ${secs(clientState.bridgeMs || 0)}`);
      console.log(`── 请求结束 ── ${reqTag} ${getUserName(apiKey, runtime)} ${parts.join(" ")} ──`);
    }
  }).catch(() => {
    if (!res.headersSent) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request body too large" }));
    }
  });
}

async function handleJsonProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, _rt, suffix, strippedUrl, clientState) {
  const runtime = _rt || rt;
  let lastError = null;

  for (let attempt = 0; attempt <= gProxy.maxRetries; attempt++) {
    try {
      throwIfClientAborted(clientState);
      const upRes = await sendUpstream(body, strippedUrl || req.url, req.method, reqHeaders, timeout, runtime, clientState);
      const text = upRes.body.toString();

      // Record success to circuit breaker for non-5xx responses
      if (upRes.statusCode < 500) {
        runtime.breaker.recordSuccess();
      }

      // Check for plan-exhausted / payment required
      if (upRes.statusCode === 402 || upRes.statusCode === 403) {
        const isPaymentIssue = text.includes("quota") || text.includes("balance") ||
          text.includes("insufficient") || text.includes("exhausted") || text.includes("billing");
        if (isPaymentIssue) {
          console.log(`[套餐] 上游套餐已耗尽或需要付款 状态码: ${upRes.statusCode}`);
        }
      }

      // Plan-exhaustion 429: hand off to the failover layer (do not retry same upstream).
      const rateLimitHit = classifyRateLimit(upRes.statusCode, text, upRes.headers);
      if (rateLimitHit) throw new RateLimitedError(rateLimitHit.resumeAt, rateLimitHit.source);

      // Retryable status codes
      if (gProxy.retryableStatusCodes.includes(upRes.statusCode) && attempt < gProxy.maxRetries) {
        const baseDelay = Math.min(gProxy.retryDelay * Math.pow(2, attempt), 10000);
        const delay = Math.round(jitter(baseDelay));
        console.log(`[重试] ${getUserName(apiKey, runtime)} ${upRes.statusCode} model=${reqModel} 第${attempt + 1}/${gProxy.maxRetries}次 ${delay}ms后重试`);
        recordError(apiKey, upRes.statusCode, `Retryable error (attempt ${attempt + 1}/${gProxy.maxRetries})`, req.url, reqModel, suffix, runtime);
        await sleepWithClientAbort(delay, clientState);
        continue;
      }

      // Parse and record
      try {
        const json = JSON.parse(text);
        if (upRes.statusCode >= 400) {
          recordError(apiKey, upRes.statusCode, json.error?.message || json.message || text.slice(0, 200), req.url, reqModel, suffix, runtime);
          if (upRes.statusCode >= 500) runtime.breaker.recordFailure();
        } else {
          // Try multiple possible usage field names
          const usage = json.usage || json.token_usage || json.usage_info;
          if (usage) {
            recordUsage(apiKey, usage, json.model, suffix, runtime);
            clientState.lastUsage = { usage, model: json.model || reqModel };
            const modelName = json.model || reqModel;
            console.log(`${clientState.tag || ""} [Token] ${getUserName(apiKey, runtime)} [${reqSource}] model=${modelName} 输入=${usage.input_tokens || usage.prompt_tokens || 0} 输出=${usage.output_tokens || usage.completion_tokens || 0} 缓存写=${usage.cache_creation_input_tokens || 0} 缓存读=${usage.cache_read_input_tokens || 0}`);
          } else {
            console.log(`[响应] ${getUserName(apiKey, runtime)} 200 OK 但无usage字段 model=${reqModel} body[0:300]=${text.slice(0, 300).replace(/\n/g, "\\n")}`);
          }
        }
      } catch {
        if (upRes.statusCode >= 400) {
          recordError(apiKey, upRes.statusCode, text.slice(0, 200), req.url, reqModel, suffix, runtime);
          if (upRes.statusCode >= 500) runtime.breaker.recordFailure();
        } else {
          console.log(`[响应] ${getUserName(apiKey, runtime)} ${upRes.statusCode} 非JSON响应 body[0:300]=${text.slice(0, 300).replace(/\n/g, "\\n")}`);
        }
      }

      const respHeaders = { ...upRes.headers };
      delete respHeaders["content-encoding"];
      delete respHeaders["content-length"];
      if (attempt > 0) respHeaders["x-proxy-retry"] = String(attempt);
      if (clientState && !clientState.firstByteAt) clientState.firstByteAt = Date.now();
      res.writeHead(upRes.statusCode, respHeaders);
      res.end(text);
      return;
    } catch (err) {
      if (err?.isRateLimited) throw err;   // propagate to outer failover loop — no breaker/retry
      if (isClientAbortError(err)) {
        console.log(`${clientState.tag || ""} [取消] ${getUserName(apiKey, runtime)} JSON 客户端断开 model=${reqModel}`);
        return;
      }
      lastError = err;
      runtime.breaker.recordFailure();
      if (attempt < gProxy.maxRetries) {
        const baseDelay = Math.min(gProxy.retryDelay * Math.pow(2, attempt), 10000);
        const delay = Math.round(jitter(baseDelay));
        console.log(`[重试] ${getUserName(apiKey, runtime)} 网络错误 model=${reqModel} 第${attempt + 1}/${gProxy.maxRetries}次 ${delay}ms后重试`);
        await sleepWithClientAbort(delay, clientState);
      }
    }
  }

  // All retries exhausted
  const finalStatus = lastError?.isTimeout ? 504 : 502;
  const finalLabel = lastError?.isTimeout ? "Gateway Timeout" : "Bad Gateway";
  recordError(apiKey, finalStatus, `${finalLabel} after ${gProxy.maxRetries} retries: ${lastError?.message}`, req.url, reqModel, suffix, runtime);
  if (!res.headersSent) {
    res.writeHead(finalStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Proxy ${finalLabel} after ${gProxy.maxRetries} retries. Please try again later.` }));
  }
}

async function handleStreamingProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, _rt, suffix, strippedUrl, clientState) {
  const runtime = _rt || rt;
  throwIfClientAborted(clientState);
  const opts = {
    hostname: runtime.upstreamUrl.hostname,
    port: runtime.upstreamUrl.port || (runtime.upstreamUrl.protocol === "https:" ? 443 : 80),
    path: buildUpstreamPath(strippedUrl || req.url, runtime),
    method: req.method,
    headers: reqHeaders,
    agent: runtime.agent,
  };

  const transport = runtime.upstreamUrl.protocol === "https:" ? https : http;

  await new Promise((resolve, reject) => {
    let clientGone = !!clientState?.aborted;
    let resolved = false;
    let cleanupUpstream = () => {};
    let cleanupClientAbort = () => {};
    // Idle watchdog: SSE streams rarely pause for long — a long silent gap means
    // the upstream hung. Cut it at streamIdleTimeout instead of waiting out the
    // socket-level streamTimeout backstop. Timer re-arms on every chunk.
    let idleTimer = null;
    function clearIdleTimer() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    }
    function armIdleTimer() {
      const idleMs = Number(gProxy.streamIdleTimeout);
      if (!Number.isFinite(idleMs) || idleMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        console.log(`${clientState.tag || ""} [超时] ${getUserName(apiKey, runtime)} 流式空闲超过 ${idleMs}ms，中断上游 model=${reqModel}`);
        upReq.destroy(new Error(`Upstream stream idle timeout (${idleMs}ms)`));
      }, idleMs);
      idleTimer.unref?.();
    }
    function safeResolve() {
      if (!resolved) {
        resolved = true;
        clearIdleTimer();
        cleanupClientAbort();
        cleanupUpstream();
        resolve();
      }
    }
    function safeReject(err) {
      if (!resolved) {
        resolved = true;
        clearIdleTimer();
        cleanupClientAbort();
        cleanupUpstream();
        reject(err);
      }
    }
    const upReq = transport.request(opts, (upRes) => {
      const h = { ...upRes.headers };
      delete h["transfer-encoding"];
      delete h["content-encoding"];
      delete h["content-length"];
      h["content-type"] = "text/event-stream";
      h["cache-control"] = "no-cache";
      h["connection"] = "keep-alive";
      res.on("error", () => {
        clientGone = true;
        upReq.destroy(makeClientAbortError("response-error"));
        safeResolve();
      });

      let buf = "", usage = { input_tokens: 0, output_tokens: 0 }, model = reqModel;
      let sseDataLines = 0;
      let rawSample = "";
      let streamFailure = null;

      // Plan-exhaustion 429: buffer the full body, then hand off to the failover
      // layer WITHOUT writing anything to the client — so the next profile can own
      // the response. A burst 429 (no plan-limit signal) is passed through instead.
      if (upRes.statusCode === 429) {
        let errBuf = "";
        upRes.on("data", (c) => { if (!clientGone) errBuf += c.toString(); });
        upRes.on("end", () => {
          const rl = classifyRateLimit(upRes.statusCode, errBuf, upRes.headers);
          if (rl) {
            recordError(apiKey, upRes.statusCode, errBuf.slice(0, 200), req.url, reqModel, suffix, runtime);
            safeReject(new RateLimitedError(rl.resumeAt, rl.source));
            return;
          }
          recordError(apiKey, upRes.statusCode, errBuf.slice(0, 200), req.url, reqModel, suffix, runtime);
          runtime.breaker.recordSuccess();
          if (!clientGone) {
            res.writeHead(upRes.statusCode, h);
            if (errBuf) res.write(errBuf);
            res.end();
          }
          safeResolve();
        });
        return;
      }

      if (upRes.statusCode >= 400) {
        res.writeHead(upRes.statusCode, h);
        let errBuf = "";
        upRes.on("data", (c) => { if (clientGone) return; errBuf += c.toString(); res.write(c); });
        upRes.on("end", () => {
          recordError(apiKey, upRes.statusCode, errBuf.slice(0, 200), req.url, reqModel, suffix, runtime);
          if (upRes.statusCode >= 500) runtime.breaker.recordFailure();
          else if (upRes.statusCode < 500) runtime.breaker.recordSuccess();
          if (!clientGone) res.end();
          safeResolve();
        });
        return;
      }

      // Streamed 200 responses: the upstream may signal a plan-limit *in-band*
      // (HTTP 200 + SSE `response.failed`/`error`) before any business data. To
      // fail over cleanly to the next group candidate we must not send headers
      // or bytes to the client until we've confirmed it's a real stream — so we
      // buffer a short prelude, and only writeHead once a content event arrives.
      let prelude = "";
      let started = false;
      const PRELUDE_LIMIT = 64 * 1024;
      const flushPrelude = () => {
        if (started) return;
        started = true;
        if (clientState && !clientState.firstByteAt) clientState.firstByteAt = Date.now();
        res.writeHead(upRes.statusCode, h);
        runtime.breaker.recordSuccess();
        armIdleTimer();
        if (prelude) res.write(prelude);
        prelude = "";
      };

      upRes.on("data", (chunk) => {
        armIdleTimer();
        if (clientGone) return;
        const text = chunk.toString();
        if (started) {
          res.write(chunk);
        } else {
          prelude += text;
          if (prelude.length > PRELUDE_LIMIT) flushPrelude();
        }
        buf += text;
        // Save sample of raw response for debug
        if (rawSample.length < 500) rawSample += text;

        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let jsonStr = "";
          if (line.startsWith("data:")) {
            jsonStr = line.slice(5).trim();
          } else if (line.startsWith("event:")) {
            continue;
          } else if (line.startsWith("{")) {
            jsonStr = line;
          } else {
            continue;
          }
          if (jsonStr === "[DONE]") continue;
          sseDataLines++;
          try {
            const d = JSON.parse(jsonStr);
            if (sseDataLines <= 3) console.log(`${clientState.tag || ""} [SSE] ${getUserName(apiKey, runtime)} 第${sseDataLines}条 类型=${d.type} 字段=${Object.keys(d).join(",")}`);
            if (d.type === "message_start") {
              if (d.message) {
                model = d.message.model || model;
                if (d.message.usage) {
                  usage.input_tokens = d.message.usage.input_tokens || 0;
                  usage.cache_creation_input_tokens = d.message.usage.cache_creation_input_tokens || 0;
                  usage.cache_read_input_tokens = d.message.usage.cache_read_input_tokens || 0;
                }
              }
              model = d.model || model;
            } else if (d.type === "message_delta") {
              usage.output_tokens = d.usage?.output_tokens || 0;
            } else if (d.response) {
              model = d.response.model || model;
              mergeUsageCounters(usage, d.response.usage);
            }
            if (d.usage) {
              mergeUsageCounters(usage, d.usage);
            }
            if (d.model) model = d.model;
            // Responses API signals failures in-stream (HTTP stays 200): capture
            // for the error log; usage stays absent on failed streams.
            if (d.type === "response.failed" || d.type === "response.incomplete" || d.type === "error") {
              streamFailure = `${d.type}: ${d.error?.message || d.response?.error?.message || "no detail"}`;
              if (!started) {
                const msg = d.error?.message || d.response?.error?.message || "";
                const rl = classifyRateLimit(429, msg, upRes.headers);
                if (rl) {
                  // Plan-limit signalled in the first frame, before any bytes
                  // reached the client: hand off to the failover layer (next
                  // group candidate) without sending headers or data.
                  recordError(apiKey, 429, msg.slice(0, 200) || streamFailure, req.url, reqModel, suffix, runtime);
                  clientGone = true;
                  safeReject(new RateLimitedError(rl.resumeAt, rl.source));
                  upReq.destroy();
                  return;
                }
              }
            } else if (!started && d.type !== "response.created") {
              // A real content event (output_item.added / .delta / .completed / …):
              // only now do we commit to forwarding this stream to the client.
              flushPrelude();
            }
          } catch {}
        }
      });

      upRes.on("end", () => {
        if (resolved) return;
        clearIdleTimer();
        // Stream ended before any content event arrived (e.g. a non-limit error
        // stream or an empty stream): still commit headers + buffered prelude so
        // the client sees the upstream text (matches pre-fix passthrough).
        if (!started) flushPrelude();
        if (buf.startsWith("data: ")) {
          try {
            const tail = buf.slice(6).trim();
            if (tail !== "[DONE]") {
              const d = JSON.parse(tail);
              if (d.model) model = d.model;
              if (d.response?.model) model = d.response.model;
              mergeUsageCounters(usage, d.usage);
              mergeUsageCounters(usage, d.response?.usage);
            }
          } catch {}
        }
        if (usageHasTokens(usage)) {
          recordUsage(apiKey, usage, model, suffix, runtime);
          clientState.lastUsage = { usage, model };
          console.log(`${clientState.tag || ""} [Token] ${getUserName(apiKey, runtime)} [${reqSource}] model=${model} 输入=${usage.input_tokens} 输出=${usage.output_tokens} 缓存写=${usage.cache_creation_input_tokens || 0} 缓存读=${usage.cache_read_input_tokens || 0}`);
        } else {
          console.log(`[响应] ${getUserName(apiKey, runtime)} 流结束 无usage数据 model=${model} sse行数=${sseDataLines} 原始数据[0:200]=${rawSample.slice(0, 200).replace(/\n/g, "\\n")}`);
        }
        if (streamFailure) {
          recordError(apiKey, 502, `Responses stream failed: ${streamFailure}`, req.url, model, suffix, runtime);
        }
        if (!clientGone) res.end();
        safeResolve();
      });
    });
    cleanupUpstream = setActiveUpstreamRequest(clientState, upReq);
    cleanupClientAbort = addClientAbortListener(clientState, (reason) => {
      clientGone = true;
      upReq.destroy(makeClientAbortError(reason));
      safeResolve();
    });

    upReq.setTimeout(timeout, () => {
      upReq.destroy(new Error(`Upstream stream timeout (${timeout}ms)`));
    });

    upReq.on("error", (err) => {
      if (resolved) return;   // already failover'd or resolved — don't write a 502
      if (isClientAbortError(err) || clientState?.aborted) {
        console.log(`${clientState.tag || ""} [取消] ${getUserName(apiKey, runtime)} 流式客户端断开 model=${reqModel}`);
        safeResolve();
        return;
      }
      clearIdleTimer();
      runtime.breaker.recordFailure();
      const isTimeout = err.message.includes("timeout");
      const status = isTimeout ? 504 : 502;
      const label = isTimeout ? "Gateway Timeout" : "Bad Gateway";
      recordError(apiKey, status, `${label}: ${err.message}`, req.url, reqModel, suffix, runtime);
      if (!res.headersSent && !clientGone) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Proxy ${label}. Please try again later.` }));
      } else if (!clientGone && !res.writableEnded) {
        // Mid-stream upstream death (idle watchdog, network reset, ...): close the
        // SSE response so the client sees the cut instead of hanging until its own
        // timeout. Closing without a terminal SSE event is the standard abnormal end.
        res.end();
      }
      safeResolve();
    });

    upReq.write(body);
    upReq.end();
  });
}

// ─── Settings API Helpers ─────────────────────────────────────────────────────

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
  };
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

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
  ibCacheRows,
};

// Codex 一键接入脚本构建器（lib/codex-setup-script.mjs）的依赖注入对象。
const CODEX_DEPS = { config, canUseProfile, runtimes };

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
  normalizeLegacyImportData,
  legacyImportHash,
  summarizeLegacyImport,
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
  getCheckInStatus,
  getQuotaRequestStatus,
  buildUsageHeatmap,
  runtimes,
  get rt() { return rt; },
  get stmts() { return stmts; },
  getPoolForSuffix,
};
const usageApi = createUsageReader(USAGE_DEPS);
const server = http.createServer((req, res) => {
  // Security headers for all responses
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'");
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
        const actualHash = legacyImportHash(payload.data);
        if (!payload.sourceHash || !timingSafeEqual(payload.sourceHash, actualHash)) throw new Error("文件指纹不匹配，请重新预览");
        if (getMeta(`dataImport:${actualHash}`)) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "该文件已经导入" }));
          return;
        }
        const normalized = normalizeLegacyImportData(payload.data);
        const profileMap = settingsApi.resolveImportProfileMap(normalized, payload.profileMap || {});
        if (payload.mode === "replace") backupDatabaseSync("data-import-replace");
        const tx = db.transaction(() => {
          if (payload.mode === "replace") clearRequestData();
          writeLegacyData(normalized, profileMap);
          stmts.upsertMeta.run({ k: `dataImport:${actualHash}`, v: new Date().toISOString() });
        });
        tx();
        const summary = summarizeLegacyImport(normalized);
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
          clearRequestData();
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
        // Every profile needs a pool; accept an existing one or create a same-named
        // one so quota enforcement never runs against nothing (= unlimited).
        const requestedPool = normalizeQuotaPoolName(quotaPool);
        let poolName = requestedPool && config.quotaPools[requestedPool] ? requestedPool : "";
        if (!poolName) {
          poolName = normalizeQuotaPoolName(name) || "pool";
          for (let i = 2; config.quotaPools[poolName]; i++) poolName = `${normalizeQuotaPoolName(name)}-${i}`.slice(0, QUOTA_POOL_NAME_MAX);
          config.quotaPools[poolName] = { label: name, dailyTokenLimit: null, users: {} };
        }
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
        // An orphaned pool has no members to draw on it and its limits are dead
        // weight — drop it. A pool still referenced elsewhere is left alone.
        const orphanPool = p && p.quotaPool ? normalizeQuotaPoolName(p.quotaPool) : "";
        if (orphanPool && config.quotaPools[orphanPool]) {
          const stillUsed = Object.values(config.profiles).some(x => x !== p && resolvePoolName(Object.keys(config.profiles).find(n => config.profiles[n] === x)) === orphanPool);
          if (!stillUsed) delete config.quotaPools[orphanPool];
        }
        delete config.profiles[profile];
        saveConfig(config);
        console.log(`[PROFILE] Deleted profile "${profile}"`);
        recordAdminAudit(req, "profile.delete", profile, `删除方案 "${profile}"（后缀 /${p ? p.suffix : "?"}）`);
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
        // Rewrite group memberships stored by name.
        for (const key of ["defaultProfileGroup", "responsesProfileGroup"]) {
          if (Array.isArray(config[key])) config[key] = config[key].map(n => (n === profile ? newName : n));
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
        data.userQuotas = {};
        // Effective quota per user (base + today's manual bonus, usage minus
        // reset baseline) so the dashboard quota bar matches what the proxy
        // actually enforces, while usage columns keep the real statistics.
        data.userQuotaEff = {};
        for (const k of Object.keys(targetRt.users)) {
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
    data.profiles = listProfiles();
    data.profileSummaries = statsApi.getProfileSummaries();
    // Chart feeds: hourly×model trend (scoped to current profile view) and
    // cross-profile daily aggregates (always all profiles — the profile chart
    // is a cross-profile dimension and must not shrink with the profile filter).
    const scopedSuffix = profileSuffix === "all" ? null : normalizeProfileSuffix(profileSuffix);
    data.hourlyModels = statsApi.loadHourlyModels(scopedSuffix, protoFilter);
    data.profileDaily = statsApi.loadProfileDaily(protoFilter);
    data.profileDailyModels = statsApi.loadProfileDailyModels(protoFilter);
    // Model rate board: config rates + today's realised cost per profile×model.
    data.modelRateBoard = statsApi.getModelRateBoard(
      profileSuffix === "all" ? protoFilter : [normalizeProfileSuffix(profileSuffix)]
    );
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
          for (const table of ["users", "usage_daily", "usage_daily_model", "usage_daily_hourly", "usage_hourly_model", "errors", "quota_adjust_history", "quota_daily_ops"]) {
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
      s.health = contextHealth(db, { from, to, responsesProfiles: responsesProfileSet() });
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
        health: contextHealth(db, { from, to, responsesProfiles: responsesProfileSet() }),
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
      poolLabel: r.pool ? poolLabelOf(r.pool) : "",
      ...(r.status === "pending" ? { pools: getUserPoolNames(r.user_key).map(n => ({ name: n, label: poolLabelOf(n) })) } : {}),
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
        const validPools = getUserPoolNames(row.user_key);
        if (!validPools.includes(pool)) throw new Error(`该成员不在额度池「${poolLabelOf(pool)}」中（可发放：${validPools.map(poolLabelOf).join("、") || "无"}）`);
        const baseLimit = getUserPoolQuota(pool, row.user_key) || getPoolQuota(pool);
        if (baseLimit <= 0) throw new Error(`额度池「${poolLabelOf(pool)}」与该成员均未设置每日配额（当前无限制），加量无意义；请先在额度池管理中设置限额`);
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
            note: `已发放 +${n.toLocaleString()} token 到额度池「${poolLabelOf(pool)}」（当日有效）`, handledAt: now });
        });
        tx();
        recordAdminAudit(req, "request.handle", `${row.username} · #${row.id}`,
          `通过 ${row.username} 的加量申请并发放 +${n.toLocaleString()} token 到额度池「${poolLabelOf(pool)}」（当日临时加量，明日自动失效；理由「${row.reason}」）`, "request");
        console.log(`[加量申请] 已发放：${row.username} +${n.toLocaleString()} @${poolLabelOf(pool)}`);
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
        const row = updateQuotaRequest(id, status, note);
        const granted = status === "handled";
        recordAdminAudit(req, granted ? "request.handle" : "request.reject",
          `${row.username} · #${row.id}`,
          `${granted ? "已处理" : "驳回"} ${row.username} 的加量申请（理由「${row.reason}」${row.pool ? `，额度池「${poolLabelOf(row.pool)}」` : ""}）${note ? `，备注：${note}` : ""}`,
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
        const next = sanitizeNotifierConfig(JSON.parse(buf.toString()));
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
          const cfg = sanitizeNotifierConfig(JSON.parse(buf.toString()));
          const anyChannel = NOTIFY_SENDERS.some((s) => s.enabled(cfg));
          if (!anyChannel) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "请至少填写一个通知渠道" }));
            return;
          }
          const results = await sendNotifierTest(cfg);
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
          for (const table of ["users", "usage_daily", "usage_daily_model", "usage_daily_hourly", "usage_hourly_model", "errors", "quota_adjust_history", "quota_daily_ops"]) {
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
    res.end(personalUsageHtml(PAGE_DEPS, vk));
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
    res.end(personalUsageHtml(PAGE_DEPS, vk));
    return;
  }

  // Personal usage API (authenticated by API key, supports ?profile=<suffix>)
  // Daily check-in (member, virtual-key auth — same scheme as /api/my-usage)
  if (req.method === "POST" && req.url.split("?")[0] === "/api/checkin") {
    const apiKey = getApiKey(req);
    try {
      if (!hasGlobalUser(apiKey)) throw new Error("认证失败：请提供有效的虚拟Key");
      const result = performCheckIn(apiKey, getClientIp(req));
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
        const result = createQuotaRequest(apiKey, reason, pool, getClientIp(req));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
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
      const health = contextHealth(db, { from, to, responsesProfiles: responsesProfileSet() }).find(h => h.user_key === key) || null;
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
      const payload = usageApi.getPersonalUsageData(apiKey, profileSuffix, protocolParam);
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
    proxyRequest(req, res);
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
  scheduleToolPatternProbes();
});

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
