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
import { createNotifier } from "./lib/notifier.mjs";
import { createMemberRewards } from "./lib/member-rewards.mjs";
import { getApiKey, makeClientAbortError, isClientAbortError, createClientAbortState, markClientAborted, addClientAbortListener, setActiveUpstreamRequest, throwIfClientAborted, sleepWithClientAbort, jitter, buildUpstreamPath } from "./lib/proxy-helpers.mjs";
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

// API 代理核心(lib/proxy-core.mjs)依赖注入对象。必须排在被它引用的工厂实例之后
// (toolPatternApi / visionApi / notifierApi); rt 是会被重新赋值的模块级 let, 用 getter
// 让 lib 在调用时读取当前值, 而非解构成快照。
const PROXY_CORE_DEPS = {
  RateLimitedError,
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
  extractSessionSignal,
  gProxy,
  getAvailableDefaultProfiles,
  getAvailableResponsesProfiles,
  getClientIp,
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
