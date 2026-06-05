import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────
const configPath = path.join(__dirname, "config.json");
function loadConfig() {
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}
function saveConfig(cfg) {
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
}

const config = loadConfig();
const { port } = config;
const dashboardPassword = config.dashboardPassword || "";
const dataPath = path.join(__dirname, "data.json");

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

// Auto-migrate: ensure every profile has defaultModels and non-empty allowedModels
(function migrateDefaultModels() {
  let migrated = false;
  for (const pname of Object.keys(config.profiles)) {
    const p = config.profiles[pname];
    if (!p.defaultModels) {
      const firstModel = (Array.isArray(p.allowedModels) && p.allowedModels.length > 0)
        ? p.allowedModels[0] : null;
      p.defaultModels = {
        sonnet: firstModel || "claude-sonnet-4-6",
        opus: firstModel || "claude-opus-4-5",
        haiku: firstModel || "claude-haiku-4-5",
      };
      migrated = true;
    }
    if (!Array.isArray(p.allowedModels) || p.allowedModels.length === 0) {
      p.allowedModels = [
        p.defaultModels.sonnet,
        p.defaultModels.opus,
        p.defaultModels.haiku,
      ];
      migrated = true;
    }
  }
  if (migrated) { saveConfig(config); console.log("[MIGRATE] Added defaultModels to existing profiles"); }
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

// Auto-migrate: ensure quota fields exist
(function migrateQuotaConfig() {
  let migrated = false;
  for (const pname of Object.keys(config.profiles)) {
    const p = config.profiles[pname];
    if (p.dailyTokenLimit === undefined) { p.dailyTokenLimit = null; migrated = true; }
    if (p.users) {
      for (const [vk, u] of Object.entries(p.users)) {
        if (typeof u === "object" && u.dailyTokenLimit === undefined) { u.dailyTokenLimit = null; migrated = true; }
      }
    }
  }
  if (migrated) { saveConfig(config); console.log("[MIGRATE] Added dailyTokenLimit fields"); }
})();

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

// Auto-migrate: add suffix and isDefault to profiles for multi-profile concurrent
(function migrateProfileSuffix() {
  let migrated = false;
  const suffixes = new Set();
  for (const [pname, p] of Object.entries(config.profiles)) {
    if (p.suffix === undefined) {
      // Active profile becomes default (empty suffix)
      if (pname === config.activeProfile) {
        p.suffix = "";
        p.isDefault = true;
      } else {
        // Auto-generate suffix from profile name (lowercase, alphanumeric only)
        let s = pname.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20);
        if (!s || s.length < 2) s = "p" + (Object.keys(config.profiles).indexOf(pname) + 1);
        let base = s, i = 2;
        while (suffixes.has(s)) { s = base + i; i++; }
        p.suffix = s;
        p.isDefault = false;
      }
      suffixes.add(p.suffix);
      migrated = true;
    } else {
      suffixes.add(p.suffix);
    }
  }
  // Ensure exactly one default
  const defaults = Object.entries(config.profiles).filter(([, p]) => p.isDefault);
  if (defaults.length === 0) {
    const first = Object.keys(config.profiles)[0];
    config.profiles[first].isDefault = true;
    config.profiles[first].suffix = "";
    migrated = true;
  } else if (defaults.length > 1) {
    for (let i = 1; i < defaults.length; i++) defaults[i][1].isDefault = false;
    migrated = true;
  }
  if (migrated) {
    saveConfig(config);
    console.log("[MIGRATE] Added suffix/isDefault:", Object.entries(config.profiles).map(([n, p]) => `${n}(${JSON.stringify(p.suffix)})`).join(", "));
  }
})();

function getDefaultProfileName() {
  for (const [name, p] of Object.entries(config.profiles)) {
    if (p.isDefault) return name;
  }
  return Object.keys(config.profiles)[0];
}

function listProfiles() {
  return Object.keys(config.profiles).map(name => ({
    name,
    suffix: config.profiles[name].suffix || "",
    isDefault: !!config.profiles[name].isDefault,
    upstream: config.profiles[name].upstream,
    userCount: Object.keys(config.profiles[name].users || {}).length,
  }));
}

// ─── Circuit Breaker ─────────────────────────────────────────────────────────
class CircuitBreaker {
  constructor(opts = {}) {
    this.failureThreshold = opts.failureThreshold || 5;
    this.cooldownMs = opts.cooldownMs || 30000;
    this.halfOpenMaxRequests = opts.halfOpenMaxRequests || 2;
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.state = "CLOSED"; // CLOSED | OPEN | HALF_OPEN
    this.halfOpenRequests = 0;
    this.totalFailures = 0;
    this.totalSuccesses = 0;
  }

  allowRequest() {
    switch (this.state) {
      case "CLOSED":
        return true;
      case "OPEN": {
        const elapsed = Date.now() - this.lastFailureTime;
        if (elapsed >= this.cooldownMs) {
          this.state = "HALF_OPEN";
          this.halfOpenRequests = 0;
          console.log("[CB] Circuit OPEN → HALF_OPEN, probing upstream");
          return true;
        }
        return false;
      }
      case "HALF_OPEN":
        return this.halfOpenRequests < this.halfOpenMaxRequests;
      default:
        return true;
    }
  }

  recordSuccess() {
    this.totalSuccesses++;
    if (this.state === "HALF_OPEN") {
      this.halfOpenRequests++;
      if (this.halfOpenRequests >= this.halfOpenMaxRequests) {
        this.state = "CLOSED";
        this.failureCount = 0;
        console.log("[CB] Circuit HALF_OPEN → CLOSED, upstream recovered");
      }
    } else if (this.state === "CLOSED") {
      this.failureCount = 0;
    }
  }

  recordFailure() {
    this.totalFailures++;
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state === "HALF_OPEN") {
      this.state = "OPEN";
      console.log("[CB] Circuit HALF_OPEN → OPEN, probe failed");
    } else if (this.state === "CLOSED" && this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
      console.log(`[CB] Circuit CLOSED → OPEN, ${this.failureCount} consecutive failures`);
    }
  }

  reset() {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.halfOpenRequests = 0;
  }

  status() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      cooldownRemaining: this.state === "OPEN"
        ? Math.max(0, this.cooldownMs - (Date.now() - this.lastFailureTime))
        : 0,
    };
  }
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
    suffix: profile.suffix || "",
    isDefault: !!profile.isDefault,
    upstream: profile.upstream,
    upstreamUrl,
    users: { ...(profile.users || {}) },
    allowedModels: profile.allowedModels || [],
    defaultModels: profile.defaultModels || { sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-5", haiku: "claude-haiku-4-5" },
    globalUsers: { ...(config.users || {}) },
    breaker: new CircuitBreaker({
      failureThreshold: (config.proxy || {}).circuitBreakerFailures || 5,
      cooldownMs: (config.proxy || {}).circuitBreakerCooldown || 30000,
    }),
    agent: createUpstreamAgent(upstreamUrl),
  };
}

function initAllRuntimes() {
  for (const key of Object.keys(runtimes)) delete runtimes[key];
  for (const [name, profile] of Object.entries(config.profiles)) {
    const suffix = profile.suffix || "";
    runtimes[suffix] = createProfileRuntime(name, profile);
  }
  console.log(`[RUNTIME] Initialized ${Object.keys(runtimes).length} profile(s): ${Object.values(runtimes).map(r => `"${r.profileName}"(${JSON.stringify(r.suffix)})`).join(", ")}`);
}

function reloadProfileRuntime(profileName) {
  const profile = config.profiles[profileName];
  if (!profile) return;
  const suffix = profile.suffix || "";
  const old = runtimes[suffix];
  if (old) old.agent.destroy();
  runtimes[suffix] = createProfileRuntime(profileName, profile);
  console.log(`[RUNTIME] Reloaded "${profileName}" (suffix: ${JSON.stringify(suffix)})`);
}

function reloadAllRuntimes() {
  for (const rt of Object.values(runtimes)) rt.agent.destroy();
  initAllRuntimes();
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

// Initialize all runtimes
initAllRuntimes();
// Backward-compat: rt → default profile runtime (used by non-request-path code)
const rt = runtimes[""];

// ─── Profile Route Resolver ─────────────────────────────────────────────────
const RESERVED_SUFFIXES = new Set(["dashboard", "settings", "api", "health", "usage", "my-usage", "v1", "login", "logout", "favicon", "robots", "js", "css"]);

function resolveProfile(url) {
  // Try to match /<suffix>/... pattern
  const seg = url.match(/^\/([a-zA-Z0-9_-]{2,20})(\/.*)/);
  if (seg) {
    const candidate = seg[1].toLowerCase();
    if (!RESERVED_SUFFIXES.has(candidate) && runtimes[candidate]) {
      return { suffix: candidate, runtime: runtimes[candidate], strippedUrl: seg[2] };
    }
  }
  // Default profile (no suffix)
  return { suffix: "", runtime: runtimes[""] || { upstreamUrl: new URL("http://localhost"), breaker: new CircuitBreaker(), agent: new http.Agent(), users: {}, allowedModels: [], defaultModels: {}, globalUsers: {} }, strippedUrl: url };
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
  const cookies = (req.headers.cookie || "").split(";").map(s => s.trim());
  const csrfCookie = cookies.find(c => c.startsWith(`${CSRF_COOKIE}=`));
  if (!csrfCookie) return false;
  const cookieVal = csrfCookie.slice(CSRF_COOKIE.length + 1);
  // Check header first (for fetch requests), then form field (for form submissions)
  const headerVal = req.headers["x-csrf-token"] || "";
  if (headerVal && timingSafeEqual(cookieVal, headerVal)) return true;
  if (body && typeof body === "string" && body.includes("_csrf=")) {
    const match = body.match(/(?:^|&)_csrf=([^&]+)/);
    if (match && timingSafeEqual(cookieVal, decodeURIComponent(match[1]))) return true;
  }
  return false;
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
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function sanitizeJson(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeJson);
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    clean[k] = typeof v === "object" && v !== null ? sanitizeJson(v) : v;
  }
  return clean;
}

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
  if (Array.isArray(s.errors)) {
    s.errors = s.errors.map(e => { const { userKey, ...rest } = e; return rest; });
  }
  return s;
}

// ─── Data Store ──────────────────────────────────────────────────────────────
let store = { users: {}, daily: {}, dailyModels: {}, dailyHourly: {}, models: {}, hourly: {}, errors: [], quotaAdjustHistory: [], _lastQuotaEval: null };

// Per-profile store: non-default profiles store data under store._profiles[suffix]
function getProfileStore(suffix) {
  if (!suffix) return store; // default profile uses top-level store (backward compat)
  if (!store._profiles) store._profiles = {};
  if (!store._profiles[suffix]) {
    store._profiles[suffix] = { users: {}, daily: {}, dailyModels: {}, dailyHourly: {}, models: {}, hourly: {}, errors: [] };
  }
  return store._profiles[suffix];
}

// Aggregate all profile stores for "all profiles" view
function getAggregatedStore() {
  const agg = { users: {}, daily: {}, dailyModels: {}, dailyHourly: {}, models: {}, hourly: {}, errors: [] };
  // Default profile (top-level)
  for (const k of ["users", "daily", "dailyModels", "dailyHourly", "models", "hourly"]) {
    agg[k] = JSON.parse(JSON.stringify(store[k] || {}));
  }
  agg.errors = [...(store.errors || [])];
  // Non-default profiles
  for (const [suffix, ps] of Object.entries(store._profiles || {})) {
    for (const [k, v] of Object.entries(ps.users || {})) {
      if (!agg.users[k]) agg.users[k] = { ...v, totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
      agg.users[k].totalInputTokens += (v.totalInputTokens || 0);
      agg.users[k].totalOutputTokens += (v.totalOutputTokens || 0);
      agg.users[k].totalRequests += (v.totalRequests || 0);
      agg.users[k].cacheCreationTokens += (v.cacheCreationTokens || 0);
      agg.users[k].cacheReadTokens += (v.cacheReadTokens || 0);
      agg.users[k].lastActive = agg.users[k].lastActive > (v.lastActive || "") ? agg.users[k].lastActive : (v.lastActive || agg.users[k].lastActive);
    }
    for (const [day, ud] of Object.entries(ps.daily || {})) {
      if (!agg.daily[day]) agg.daily[day] = {};
      for (const [k, v] of Object.entries(ud)) {
        if (!agg.daily[day][k]) agg.daily[day][k] = { inputTokens: 0, outputTokens: 0, requests: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
        agg.daily[day][k].inputTokens += (v.inputTokens || 0);
        agg.daily[day][k].outputTokens += (v.outputTokens || 0);
        agg.daily[day][k].requests += (v.requests || 0);
        agg.daily[day][k].cacheCreationTokens += (v.cacheCreationTokens || 0);
        agg.daily[day][k].cacheReadTokens += (v.cacheReadTokens || 0);
      }
    }
    for (const [m, v] of Object.entries(ps.models || {})) {
      if (!agg.models[m]) agg.models[m] = { tokens: 0, requests: 0 };
      agg.models[m].tokens += (v.tokens || 0);
      agg.models[m].requests += (v.requests || 0);
    }
    for (const [day, hd] of Object.entries(ps.hourly || {})) {
      if (!agg.hourly[day]) agg.hourly[day] = {};
      for (const [h, v] of Object.entries(hd)) {
        if (!agg.hourly[day][h]) agg.hourly[day][h] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
        agg.hourly[day][h].requests += (v.requests || 0);
        agg.hourly[day][h].inputTokens += (v.inputTokens || 0);
        agg.hourly[day][h].outputTokens += (v.outputTokens || 0);
        agg.hourly[day][h].cacheCreationTokens += (v.cacheCreationTokens || 0);
        agg.hourly[day][h].cacheReadTokens += (v.cacheReadTokens || 0);
      }
    }
    for (const [day, dm] of Object.entries(ps.dailyModels || {})) {
      if (!agg.dailyModels[day]) agg.dailyModels[day] = {};
      for (const [k, models] of Object.entries(dm)) {
        if (!agg.dailyModels[day][k]) agg.dailyModels[day][k] = {};
        for (const [m, v] of Object.entries(models)) {
          if (!agg.dailyModels[day][k][m]) agg.dailyModels[day][k][m] = { inputTokens: 0, outputTokens: 0, requests: 0 };
          agg.dailyModels[day][k][m].inputTokens += (v.inputTokens || 0);
          agg.dailyModels[day][k][m].outputTokens += (v.outputTokens || 0);
          agg.dailyModels[day][k][m].requests += (v.requests || 0);
        }
      }
    }
    for (const [day, dh] of Object.entries(ps.dailyHourly || {})) {
      if (!agg.dailyHourly[day]) agg.dailyHourly[day] = {};
      for (const [k, hours] of Object.entries(dh)) {
        if (!agg.dailyHourly[day][k]) agg.dailyHourly[day][k] = {};
        for (const [h, v] of Object.entries(hours)) {
          if (!agg.dailyHourly[day][k][h]) agg.dailyHourly[day][k][h] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
          agg.dailyHourly[day][k][h].requests += (v.requests || 0);
          agg.dailyHourly[day][k][h].inputTokens += (v.inputTokens || 0);
          agg.dailyHourly[day][k][h].outputTokens += (v.outputTokens || 0);
          agg.dailyHourly[day][k][h].cacheCreationTokens += (v.cacheCreationTokens || 0);
          agg.dailyHourly[day][k][h].cacheReadTokens += (v.cacheReadTokens || 0);
        }
      }
    }
    agg.errors = agg.errors.concat(ps.errors || []);
  }
  return agg;
}

function loadStore() {
  try {
    if (fs.existsSync(dataPath)) {
      const raw = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
      store = {
        users: raw.users || {},
        daily: raw.daily || {},
        dailyModels: raw.dailyModels || {},
        dailyHourly: raw.dailyHourly || {},
        models: raw.models || {},
        hourly: raw.hourly || {},
        errors: Array.isArray(raw.errors) ? raw.errors : [],
        quotaAdjustHistory: Array.isArray(raw.quotaAdjustHistory) ? raw.quotaAdjustHistory : [],
        _lastQuotaEval: raw._lastQuotaEval || null,
        _profiles: raw._profiles || {},
      };
    }
  } catch { store = { users: {}, daily: {}, dailyModels: {}, dailyHourly: {}, models: {}, hourly: {}, errors: [], _profiles: {} }; }
}

function saveStore() {
  try {
    // Prune old dailyModels/dailyHourly (>7 days)
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
    for (const d of Object.keys(store.dailyModels)) { if (d < cutoff) delete store.dailyModels[d]; }
    for (const d of Object.keys(store.dailyHourly)) { if (d < cutoff) delete store.dailyHourly[d]; }
    fs.writeFileSync(dataPath, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error("[STORE] Save failed:", err.message);
  }
}

loadStore();
setInterval(saveStore, 30_000);

// ─── User Helpers ─────────────────────────────────────────────────────────────
// Normalize user config to { username, key, allowedModels }
// Supports backward compat: old format "username" → new format object
// Get global user info (username, expiresAt, disabled) from config.users
function getGlobalUser(apiKey, _rt) {
  return (_rt || rt).globalUsers[apiKey] || null;
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
  if ((_rt || rt).users[apiKey]) return apiKey;
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

function generateVirtualKey(_rt) {
  const runtime = _rt || rt;
  let code;
  do {
    code = "jx-" + crypto.randomBytes(18).toString("base64url");
  } while (runtime.globalUsers[code] || runtime.users[code]);
  return code;
}

function checkKeyExpired(apiKey) {
  const gu = getGlobalUser(apiKey);
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

function resolveModel(model, _rt) {
  if (!model) return model;
  const alias = model.toLowerCase();
  const dm = (_rt || rt).defaultModels || {};
  if (alias === "jx-sonnet") return dm.sonnet || model;
  if (alias === "jx-opus")   return dm.opus   || model;
  if (alias === "jx-haiku")  return dm.haiku  || model;
  return model;
}

// ─── Timezone Helpers (UTC+8 北京时间) ────────────────────────────────────────
function cnNow() {
  const d = new Date();
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}
function cnDate() { return cnNow().toISOString().slice(0, 10); }
function cnHour() { return cnNow().getHours().toString().padStart(2, "0"); }

function recordUsage(apiKey, usage, model, suffix) {
  const s = getProfileStore(suffix || "");
  const key = resolveUserKey(apiKey);
  const today = cnDate();
  const hour = cnHour();
  const inp = usage.input_tokens || usage.prompt_tokens || 0;
  const out = usage.output_tokens || usage.completion_tokens || 0;
  const cacheC = usage.cache_creation_input_tokens || 0;
  const cacheR = usage.cache_read_input_tokens || 0;
  const m = model || "unknown";

  if (!s.users[key]) s.users[key] = { name: getUserName(apiKey), totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, lastActive: null, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const u = s.users[key];
  u.totalInputTokens += inp;
  u.totalOutputTokens += out;
  u.totalRequests += 1;
  u.cacheCreationTokens = (u.cacheCreationTokens || 0) + cacheC;
  u.cacheReadTokens = (u.cacheReadTokens || 0) + cacheR;
  u.lastActive = new Date().toISOString();

  if (!s.daily[today]) s.daily[today] = {};
  if (!s.daily[today][key]) s.daily[today][key] = { inputTokens: 0, outputTokens: 0, requests: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  s.daily[today][key].inputTokens += inp;
  s.daily[today][key].outputTokens += out;
  s.daily[today][key].requests += 1;
  s.daily[today][key].cacheCreationTokens = (s.daily[today][key].cacheCreationTokens || 0) + cacheC;
  s.daily[today][key].cacheReadTokens = (s.daily[today][key].cacheReadTokens || 0) + cacheR;

  if (!s.models[m]) s.models[m] = { tokens: 0, requests: 0 };
  s.models[m].tokens += inp + out;
  s.models[m].requests += 1;

  if (!s.hourly[today]) s.hourly[today] = {};
  if (!s.hourly[today][hour]) s.hourly[today][hour] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  s.hourly[today][hour].requests += 1;
  s.hourly[today][hour].inputTokens += inp;
  s.hourly[today][hour].outputTokens += out;
  s.hourly[today][hour].cacheCreationTokens = (s.hourly[today][hour].cacheCreationTokens || 0) + cacheC;
  s.hourly[today][hour].cacheReadTokens = (s.hourly[today][hour].cacheReadTokens || 0) + cacheR;

  // Per-user-per-model-daily tracking
  if (!s.dailyModels[today]) s.dailyModels[today] = {};
  if (!s.dailyModels[today][key]) s.dailyModels[today][key] = {};
  if (!s.dailyModels[today][key][m]) s.dailyModels[today][key][m] = { inputTokens: 0, outputTokens: 0, requests: 0 };
  s.dailyModels[today][key][m].inputTokens += inp;
  s.dailyModels[today][key][m].outputTokens += out;
  s.dailyModels[today][key][m].requests += 1;

  // Per-user-hourly tracking
  if (!s.dailyHourly[today]) s.dailyHourly[today] = {};
  if (!s.dailyHourly[today][key]) s.dailyHourly[today][key] = {};
  if (!s.dailyHourly[today][key][hour]) s.dailyHourly[today][key][hour] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  s.dailyHourly[today][key][hour].requests += 1;
  s.dailyHourly[today][key][hour].inputTokens += inp;
  s.dailyHourly[today][key][hour].outputTokens += out;
  s.dailyHourly[today][key][hour].cacheCreationTokens = (s.dailyHourly[today][key][hour].cacheCreationTokens || 0) + cacheC;
  s.dailyHourly[today][key][hour].cacheReadTokens = (s.dailyHourly[today][key][hour].cacheReadTokens || 0) + cacheR;
}

// ─── Token Quota ──────────────────────────────────────────────────────────────
function getProfileQuota(suffix) {
  const rt0 = runtimes[suffix || ""] || rt;
  const profile = config.profiles[rt0.profileName];
  if (!profile || !profile.dailyTokenLimit) return 0;
  return profile.dailyTokenLimit;
}

function getUserQuota(apiKey, _rt) {
  const runtime = _rt || rt;
  const key = resolveUserKey(apiKey, runtime);
  const pu = runtime.users[key];
  if (!pu || typeof pu !== "object" || !pu.dailyTokenLimit) return 0;
  return pu.dailyTokenLimit;
}

function checkTokenQuota(apiKey, suffix, _rt) {
  const runtime = _rt || rt;
  const key = resolveUserKey(apiKey, runtime);
  const s = getProfileStore(suffix || "");
  const today = cnDate();
  const todayUsage = (s.daily[today] || {})[key] || { inputTokens: 0, outputTokens: 0 };
  const used = todayUsage.inputTokens + todayUsage.outputTokens;

  // User quota overrides profile quota
  const userQuota = getUserQuota(apiKey, runtime);
  const profileQuota = getProfileQuota(suffix);
  const limit = userQuota > 0 ? userQuota : profileQuota;

  if (limit <= 0) return { allowed: true, limit: 0, used, remaining: Infinity, source: "无限制" };

  return {
    allowed: used < limit,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    source: userQuota > 0 ? "个人配额" : "方案配额",
  };
}

// ─── Auto Quota Adjustment ─────────────────────────────────────────────────
function evaluateAutoQuotaAdjustments() {
  const cfg = config.autoQuotaAdjust;
  if (!cfg || !cfg.enabled) return;

  const today = cnDate();
  if (store._lastQuotaEval === today) return;
  store._lastQuotaEval = today;

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
    const d = new Date(cnNow().getTime() - i * 86400000);
    const utc = d.getTime() + d.getTimezoneOffset() * 60000;
    dates.push(new Date(utc + 8 * 3600000).toISOString().slice(0, 10));
  }

  const profile = config.profiles[getDefaultProfileName()];
  if (!profile || !profile.users) return;

  for (const [vk, pu] of Object.entries(profile.users)) {
    if (typeof pu !== "object") continue;
    const userQuota = pu.dailyTokenLimit;
    if (!userQuota || userQuota <= 0) continue; // skip users without quota

    // Check cooldown
    const lastAdjust = (store.quotaAdjustHistory || []).findLast(h => h.user === vk);
    if (lastAdjust) {
      const lastDate = new Date(lastAdjust.date);
      const nowDate = new Date(today);
      const diffDays = Math.floor((nowDate - lastDate) / 86400000);
      if (diffDays < cooldownDays) continue;
    }

    // Count hit days and calculate average usage
    let hitCount = 0;
    let totalUsage = 0;
    let usageDays = 0;
    for (const date of dates) {
      const dayData = (store.daily[date] || {})[vk];
      if (!dayData) continue;
      const dayUsage = (dayData.inputTokens || 0) + (dayData.outputTokens || 0);
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

    // Execute adjustment
    pu.dailyTokenLimit = newQuota;

    const record = {
      user: vk,
      username: getUserName(vk),
      date: today,
      oldQuota: userQuota,
      newQuota,
      hitRate: Math.round(actualHitRate * 100) / 100,
      avgDailyUsage: Math.round(avgDaily),
      auto: true,
    };
    if (!store.quotaAdjustHistory) store.quotaAdjustHistory = [];
    store.quotaAdjustHistory.push(record);
    // Keep only last 100 records
    if (store.quotaAdjustHistory.length > 100) store.quotaAdjustHistory = store.quotaAdjustHistory.slice(-100);

    saveConfig(config);
    saveStore();
    console.log(`[配额调整] ${getUserName(vk)} ${userQuota.toLocaleString()} → ${newQuota.toLocaleString()} (命中率${Math.round(actualHitRate * 100)}%, 均值${Math.round(avgDaily).toLocaleString()})`);
  }
}

// ─── Error Recording ──────────────────────────────────────────────────────────
function recordError(apiKey, statusCode, errorMessage, path, model) {
  const key = resolveUserKey(apiKey);
  if (!Array.isArray(store.errors)) store.errors = [];
  store.errors.unshift({
    time: new Date().toISOString(),
    user: getUserName(apiKey),
    userKey: key,
    statusCode,
    error: errorMessage,
    path,
    model: model || "unknown",
  });
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  store.errors = store.errors.filter(e => e.time >= cutoff);
  if (store.errors.length > 200) store.errors.length = 200;
  console.log(`[错误] ${getUserName(apiKey)} ${statusCode} ${errorMessage} ${path} model=${model || "unknown"}`);
}

// ─── Personal Usage ───────────────────────────────────────────────────────────
function getPersonalUsageData(apiKey, suffix) {
  const s = getProfileStore(suffix || "");
  const runtime = runtimes[suffix || ""] || rt;
  const key = resolveUserKey(apiKey, runtime);
  const today = cnDate();
  const username = getUserName(apiKey, runtime);
  const quota = checkTokenQuota(apiKey, suffix, runtime);

  const todayUsage = (s.daily[today] || {})[key] || { inputTokens: 0, outputTokens: 0, requests: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };

  // Per-model breakdown for today
  const todayModels = {};
  const dm = (s.dailyModels[today] || {})[key] || {};
  for (const [model, data] of Object.entries(dm)) {
    todayModels[model] = { ...data };
  }

  // Per-hour breakdown for today
  const todayHourly = {};
  const dh = (s.dailyHourly[today] || {})[key] || {};
  for (const [h, data] of Object.entries(dh)) {
    todayHourly[h] = { ...data };
  }

  // 7-day trend
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const dayUsage = (s.daily[dateStr] || {})[key] || { inputTokens: 0, outputTokens: 0, requests: 0 };
    trend.push({ date: dateStr, input: dayUsage.inputTokens, output: dayUsage.outputTokens, requests: dayUsage.requests, total: dayUsage.inputTokens + dayUsage.outputTokens });
  }

  // Check if quota was auto-adjusted
  const lastAdjust = (store.quotaAdjustHistory || []).findLast(h => h.user === key);
  const quotaAutoAdjusted = lastAdjust ? lastAdjust.auto : false;

  // Determine which profiles this user has access to
  const availableProfiles = [];
  for (const [sfx, rt2] of Object.entries(runtimes)) {
    const userKey = resolveUserKey(apiKey, rt2);
    if (rt2.users[userKey] && !rt2.users[userKey].disabled) {
      availableProfiles.push({ suffix: sfx, name: rt2.profileName, isDefault: rt2.isDefault });
    }
  }

  return {
    username,
    profile: runtime.profileName,
    profileSuffix: suffix || "",
    availableProfiles,
    quota: { type: quota.source, limit: quota.limit, used: quota.used, remaining: quota.remaining, autoAdjusted: quotaAutoAdjusted },
    today: { input: todayUsage.inputTokens, output: todayUsage.outputTokens, requests: todayUsage.requests, cacheWrite: todayUsage.cacheCreationTokens || 0, cacheRead: todayUsage.cacheReadTokens || 0, total: todayUsage.inputTokens + todayUsage.outputTokens },
    models: todayModels,
    hourly: todayHourly,
    trend,
  };
}

// ─── API Proxy ───────────────────────────────────────────────────────────────
function getApiKey(req) {
  const a = req.headers["authorization"];
  if (a && a.startsWith("Bearer ")) return a.slice(7);
  return req.headers["x-api-key"] || "unknown";
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Jitter: ±25% random variation
function jitter(ms) {
  const half = ms * 0.25;
  return ms + (Math.random() * half * 2 - half);
}

function sendUpstream(body, reqUrl, reqMethod, reqHeaders, timeout, _rt) {
  return new Promise((resolve, reject) => {
    const runtime = _rt || rt;
    const upstreamPath = runtime.upstreamUrl.pathname.replace(/\/$/, "");
    // Smart path concatenation: avoid double /v1 when upstream already contains it
    let finalPath;
    if (upstreamPath && reqUrl.startsWith("/v1/")) {
      // Upstream has its own base path (e.g., /apps/anthropic or /compatible-mode/v1)
      // Strip /v1 prefix from reqUrl to avoid duplication
      if (upstreamPath.endsWith("/v1")) {
        finalPath = upstreamPath + reqUrl.slice(3); // /v1 + /messages → /v1/messages
      } else {
        finalPath = upstreamPath + reqUrl; // different base path, keep as-is
      }
    } else {
      finalPath = upstreamPath + reqUrl;
    }
    const opts = {
      hostname: runtime.upstreamUrl.hostname,
      port: runtime.upstreamUrl.port || (runtime.upstreamUrl.protocol === "https:" ? 443 : 80),
      path: finalPath,
      method: reqMethod,
      headers: reqHeaders,
      agent: runtime.agent,
    };

    const transport = runtime.upstreamUrl.protocol === "https:" ? https : http;
    const upReq = transport.request(opts, (upRes) => {
      const chunks = [];
      upRes.on("data", (c) => chunks.push(c));
      upRes.on("end", () => {
        resolve({
          statusCode: upRes.statusCode,
          headers: upRes.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    upReq.setTimeout(timeout, () => {
      upReq.destroy(new Error(`Upstream timeout (${timeout}ms)`));
    });

    upReq.on("error", (err) => {
      err.isTimeout = err.message.includes("timeout");
      reject(err);
    });
    upReq.write(body);
    upReq.end();
  });
}

function proxyRequest(req, res) {
  // Resolve which profile this request targets
  const { suffix, runtime, strippedUrl } = resolveProfile(req.url);
  const apiKey = getApiKey(req);
  const proxyStartTime = Date.now();
  let proxyPhase = "init";

  // Global IP rate limit
  const clientIp = getClientIp(req);
  if (!checkIpRateLimit(clientIp)) {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "IP rate limit exceeded. Please slow down." }));
    console.log(`[限流] IP ${clientIp} 超过全局速率限制`);
    return;
  }

  req.on("error", (err) => {
    console.error(`[Socket] 客户端请求错误 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)} err=${err.message}`);
  });
  res.on("error", (err) => {
    console.error(`[Socket] 客户端响应错误 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)} err=${err.message}`);
  });
  req.on("close", () => {
    if (!res.writableEnded) {
      console.log(`[Socket] 客户端提前断开 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)}`);
    }
  });

  // Reject non-API requests (browser favicon, Chrome DevTools, etc.)
  if (apiKey === "unknown") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const userKey = resolveUserKey(apiKey, runtime);

  readBody(req, 50_000_000).then(async (body) => {
    proxyPhase = "body-read";
    let reqModel = "unknown";
    let reqSource = "用户请求";
    let originalModel = "unknown";
    try {
      const parsed = sanitizeJson(JSON.parse(body.toString()));
      reqModel = parsed.model || "unknown";
      originalModel = reqModel;
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
      const resolved = resolveModel(reqModel, runtime);
      if (resolved !== reqModel) {
        parsed.model = resolved;
        body = Buffer.from(JSON.stringify(parsed));
        reqModel = resolved;
      }
    } catch {}

    // Model access restriction
    if (!checkModelAllowed(reqModel, runtime)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Model "${reqModel}" is not allowed. Use jx-sonnet/jx-opus/jx-haiku or a model from the allowed list.` }));
      console.log(`[拦截] ${getUserName(apiKey, runtime)} model=${reqModel} 被拒绝`);
      return;
    }

    // Reject unknown API keys (not in configured user list)
    if (!runtime.users[userKey] && !runtime.globalUsers[userKey]) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown API key. Please use your assigned virtual key (jx-*)." }));
      console.log(`[拦截] 未知key=${apiKey.slice(0, 8)}**** model=${reqModel} 拒绝访问`);
      return;
    }

    // Circuit breaker check
    if (!runtime.breaker.allowRequest()) {
      const remaining = Math.ceil(runtime.breaker.status().cooldownRemaining / 1000);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Upstream temporarily unavailable. Circuit open, retry in ${remaining}s.` }));
      recordError(apiKey, 503, "Circuit breaker open", req.url, reqModel);
      return;
    }

    // Concurrency check
    if (!tryAcquireConcurrency(userKey)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many concurrent requests. Please try again later." }));
      return;
    }
    // Rate limit check
    if (!checkAndRecordRate(userKey)) {
      releaseConcurrency(userKey);
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Rate limit exceeded. Please slow down." }));
      return;
    }

    // Token quota check
    const quota = checkTokenQuota(apiKey, suffix, runtime);
    if (!quota.allowed) {
      const reqHost = req.headers.host || `localhost:${port}`;
      const usageUrl = `http://${reqHost}/usage/${apiKey}`;
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "86400" });
      res.end(JSON.stringify({
        error: `今日Token额度已用完。已用: ${quota.used.toLocaleString()}, 限额: ${quota.limit.toLocaleString()}。额度将于北京时间次日凌晨重置。查看用量详情: ${usageUrl}`,
        type: "quota_exceeded",
        quota: { used: quota.used, limit: quota.limit, remaining: quota.remaining, source: quota.source },
        usageUrl,
      }));
      console.log(`[配额] ${getUserName(apiKey, runtime)} 今日额度已用完 [${quota.source}] (已用: ${quota.used.toLocaleString()} / 限额: ${quota.limit.toLocaleString()})`);
      return;
    }

    // User disabled check (global or profile-level)
    if (checkUserDisabled(apiKey, runtime)) {
      releaseConcurrency(userKey);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "User is disabled." }));
      console.log(`[禁用] ${getUserName(apiKey, runtime)} 用户已禁用`);
      return;
    }

    // Key expiration check
    if (checkKeyExpired(apiKey)) {
      releaseConcurrency(userKey);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "API key has expired. Please contact your administrator." }));
      console.log(`[过期] ${getUserName(apiKey, runtime)} key已过期`);
      return;
    }

    try {
      proxyPhase = "upstream-connect";
      const realKey = getRealKey(apiKey, runtime);
      const reqHeaders = { ...req.headers, host: runtime.upstreamUrl.host, "content-length": body.length };
      console.log(`── 请求开始 ── ${getUserName(apiKey, runtime)} [${reqSource}] 模型=${originalModel}${originalModel !== reqModel ? "→" + reqModel : ""}${suffix ? ` [${suffix}]` : ""} ──`);
      // Replace virtual key with real upstream key
      if (realKey !== apiKey) {
        reqHeaders["authorization"] = `Bearer ${realKey}`;
        console.log(`[映射] ${getUserName(apiKey, runtime)} 虚拟key=${apiKey.slice(0,8)}**** 请求模型=${originalModel}${originalModel !== reqModel ? " → 实际=" + reqModel : ""}`);
      }
      delete reqHeaders["connection"];
      delete reqHeaders["transfer-encoding"];
      delete reqHeaders["accept-encoding"];

      const isStreamRequest = (req.headers["accept"] || "").includes("text/event-stream") ||
        (function() { try { return JSON.parse(body.toString()).stream; } catch { return false; } })();

      proxyPhase = isStreamRequest ? "streaming-proxy" : "json-proxy";
      const timeout = isStreamRequest ? gProxy.streamTimeout : gProxy.timeout;

      if (isStreamRequest) {
        await handleStreamingProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, runtime, suffix, strippedUrl);
      } else {
        await handleJsonProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, runtime, suffix, strippedUrl);
      }
    } catch (err) {
      const status = err.isTimeout ? 504 : 502;
      const label = err.isTimeout ? "Gateway Timeout" : "Bad Gateway";
      recordError(apiKey, status, `${label}: ${err.message}`, req.url, reqModel);
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Proxy ${label}. Please try again later.` }));
      }
    } finally {
      releaseConcurrency(userKey);
      console.log(`── 请求结束 ── ${getUserName(apiKey, runtime)} ──`);
    }
  }).catch(() => {
    if (!res.headersSent) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request body too large" }));
    }
  });
}

async function handleJsonProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, _rt, suffix, strippedUrl) {
  const runtime = _rt || rt;
  let lastError = null;

  for (let attempt = 0; attempt <= gProxy.maxRetries; attempt++) {
    try {
      const upRes = await sendUpstream(body, strippedUrl || req.url, req.method, reqHeaders, timeout, runtime);
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

      // Retryable status codes
      if (gProxy.retryableStatusCodes.includes(upRes.statusCode) && attempt < gProxy.maxRetries) {
        const baseDelay = Math.min(gProxy.retryDelay * Math.pow(2, attempt), 10000);
        const delay = Math.round(jitter(baseDelay));
        console.log(`[重试] ${getUserName(apiKey, runtime)} ${upRes.statusCode} model=${reqModel} 第${attempt + 1}/${gProxy.maxRetries}次 ${delay}ms后重试`);
        recordError(apiKey, upRes.statusCode, `Retryable error (attempt ${attempt + 1}/${gProxy.maxRetries})`, req.url, reqModel);
        await sleep(delay);
        continue;
      }

      // Parse and record
      try {
        const json = JSON.parse(text);
        if (upRes.statusCode >= 400) {
          recordError(apiKey, upRes.statusCode, json.error?.message || json.message || text.slice(0, 200), req.url, reqModel);
          if (upRes.statusCode >= 500) runtime.breaker.recordFailure();
        } else {
          // Try multiple possible usage field names
          const usage = json.usage || json.token_usage || json.usage_info;
          if (usage) {
            recordUsage(apiKey, usage, json.model, suffix);
            const modelName = json.model || reqModel;
            console.log(`[Token] ${getUserName(apiKey, runtime)} [${reqSource}] model=${modelName} 输入=${usage.input_tokens || usage.prompt_tokens || 0} 输出=${usage.output_tokens || usage.completion_tokens || 0} 缓存写=${usage.cache_creation_input_tokens || 0} 缓存读=${usage.cache_read_input_tokens || 0}`);
          } else {
            console.log(`[响应] ${getUserName(apiKey, runtime)} 200 OK 但无usage字段 model=${reqModel} body[0:300]=${text.slice(0, 300).replace(/\n/g, "\\n")}`);
          }
        }
      } catch {
        if (upRes.statusCode >= 400) {
          recordError(apiKey, upRes.statusCode, text.slice(0, 200), req.url, reqModel);
          if (upRes.statusCode >= 500) runtime.breaker.recordFailure();
        } else {
          console.log(`[响应] ${getUserName(apiKey, runtime)} ${upRes.statusCode} 非JSON响应 body[0:300]=${text.slice(0, 300).replace(/\n/g, "\\n")}`);
        }
      }

      const respHeaders = { ...upRes.headers };
      delete respHeaders["content-encoding"];
      delete respHeaders["content-length"];
      if (attempt > 0) respHeaders["x-proxy-retry"] = String(attempt);
      res.writeHead(upRes.statusCode, respHeaders);
      res.end(text);
      return;
    } catch (err) {
      lastError = err;
      runtime.breaker.recordFailure();
      if (attempt < gProxy.maxRetries) {
        const baseDelay = Math.min(gProxy.retryDelay * Math.pow(2, attempt), 10000);
        const delay = Math.round(jitter(baseDelay));
        console.log(`[重试] ${getUserName(apiKey, runtime)} 网络错误 model=${reqModel} 第${attempt + 1}/${gProxy.maxRetries}次 ${delay}ms后重试`);
        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  const finalStatus = lastError?.isTimeout ? 504 : 502;
  const finalLabel = lastError?.isTimeout ? "Gateway Timeout" : "Bad Gateway";
  recordError(apiKey, finalStatus, `${finalLabel} after ${gProxy.maxRetries} retries: ${lastError?.message}`, req.url, reqModel);
  if (!res.headersSent) {
    res.writeHead(finalStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Proxy ${finalLabel} after ${gProxy.maxRetries} retries. Please try again later.` }));
  }
}

async function handleStreamingProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, _rt, suffix, strippedUrl) {
  const runtime = _rt || rt;
  const upstreamPath = runtime.upstreamUrl.pathname.replace(/\/$/, "");
  let finalPath;
  if (upstreamPath && (strippedUrl || req.url).startsWith("/v1/")) {
    if (upstreamPath.endsWith("/v1")) {
      finalPath = upstreamPath + (strippedUrl || req.url).slice(3);
    } else {
      finalPath = upstreamPath + (strippedUrl || req.url);
    }
  } else {
    finalPath = upstreamPath + (strippedUrl || req.url);
  }
  const opts = {
    hostname: runtime.upstreamUrl.hostname,
    port: runtime.upstreamUrl.port || (runtime.upstreamUrl.protocol === "https:" ? 443 : 80),
    path: finalPath,
    method: req.method,
    headers: reqHeaders,
    agent: runtime.agent,
  };

  const transport = runtime.upstreamUrl.protocol === "https:" ? https : http;

  await new Promise((resolve, reject) => {
    const upReq = transport.request(opts, (upRes) => {
      const h = { ...upRes.headers };
      delete h["transfer-encoding"];
      delete h["content-encoding"];
      delete h["content-length"];
      h["content-type"] = "text/event-stream";
      h["cache-control"] = "no-cache";
      h["connection"] = "keep-alive";
      res.writeHead(upRes.statusCode, h);

      let clientGone = false;
      let resolved = false;
      function safeResolve() { if (!resolved) { resolved = true; resolve(); } }
      res.on("error", () => { clientGone = true; upReq.destroy(); safeResolve(); });

      let buf = "", usage = { input_tokens: 0, output_tokens: 0 }, model = reqModel;
      let sseDataLines = 0;
      let rawSample = "";

      if (upRes.statusCode >= 400) {
        let errBuf = "";
        upRes.on("data", (c) => { if (clientGone) return; errBuf += c.toString(); res.write(c); });
        upRes.on("end", () => {
          recordError(apiKey, upRes.statusCode, errBuf.slice(0, 200), req.url, reqModel);
          if (upRes.statusCode >= 500) runtime.breaker.recordFailure();
          else if (upRes.statusCode < 500) runtime.breaker.recordSuccess();
          if (!clientGone) res.end();
          safeResolve();
        });
        return;
      }

      runtime.breaker.recordSuccess();

      upRes.on("data", (chunk) => {
        if (clientGone) return;
        res.write(chunk);
        const text = chunk.toString();
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
          sseDataLines++;
          try {
            const d = JSON.parse(jsonStr);
            if (sseDataLines <= 3) console.log(`[SSE] ${getUserName(apiKey, runtime)} 第${sseDataLines}条 类型=${d.type} 字段=${Object.keys(d).join(",")}`);
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
            }
            if (d.usage) {
              if (d.usage.input_tokens) usage.input_tokens = d.usage.input_tokens;
              if (d.usage.output_tokens) usage.output_tokens = d.usage.output_tokens;
              if (d.usage.cache_creation_input_tokens) usage.cache_creation_input_tokens = d.usage.cache_creation_input_tokens;
              if (d.usage.cache_read_input_tokens) usage.cache_read_input_tokens = d.usage.cache_read_input_tokens;
            }
            if (d.model && model === "unknown") model = d.model;
          } catch {}
        }
      });

      upRes.on("end", () => {
        if (buf.startsWith("data: ")) {
          try { const d = JSON.parse(buf.slice(6)); if (d.usage) { usage.output_tokens = d.usage.output_tokens || usage.output_tokens || 0; usage.cache_creation_input_tokens = d.usage.cache_creation_input_tokens || usage.cache_creation_input_tokens || 0; usage.cache_read_input_tokens = d.usage.cache_read_input_tokens || usage.cache_read_input_tokens || 0; } } catch {}
        }
        if (usage.input_tokens > 0 || usage.output_tokens > 0) {
          recordUsage(apiKey, usage, model, suffix);
          console.log(`[Token] ${getUserName(apiKey, runtime)} [${reqSource}] model=${model} 输入=${usage.input_tokens} 输出=${usage.output_tokens} 缓存写=${usage.cache_creation_input_tokens || 0} 缓存读=${usage.cache_read_input_tokens || 0}`);
        } else {
          console.log(`[响应] ${getUserName(apiKey, runtime)} 流结束 无usage数据 model=${model} sse行数=${sseDataLines} 原始数据[0:200]=${rawSample.slice(0, 200).replace(/\n/g, "\\n")}`);
        }
        if (!clientGone) res.end();
        safeResolve();
      });
    });

    upReq.setTimeout(timeout, () => {
      upReq.destroy(new Error(`Upstream stream timeout (${timeout}ms)`));
    });

    upReq.on("error", (err) => {
      runtime.breaker.recordFailure();
      const isTimeout = err.message.includes("timeout");
      const status = isTimeout ? 504 : 502;
      const label = isTimeout ? "Gateway Timeout" : "Bad Gateway";
      recordError(apiKey, status, `${label}: ${err.message}`, req.url, reqModel);
      if (!res.headersSent && !clientGone) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Proxy ${label}. Please try again later.` }));
      }
      safeResolve();
    });

    upReq.write(body);
    upReq.end();
  });
}

// ─── Settings API Helpers ─────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escJs(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, "\\x3c").replace(/>/g, "\\x3e").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function getPublicSettings() {
  const safeProfileUsers = {};
  for (const [k, v] of Object.entries(rt.users)) {
    const isObj = typeof v === "object" && v !== null;
    safeProfileUsers[k] = {
      key: isObj ? ((v.key || "").slice(0, 12) + "****") : (typeof v === "string" ? v.slice(0, 12) + "****" : ""),
      disabled: isObj ? !!v.disabled : false,
      dailyTokenLimit: isObj ? (v.dailyTokenLimit || 0) : 0,
    };
  }
  const safeGlobalUsers = {};
  for (const [k, v] of Object.entries(rt.globalUsers)) {
    safeGlobalUsers[k] = {
      username: v.username || "",
      expiresAt: v.expiresAt || "",
      disabled: !!v.disabled,
    };
  }
  return {
    upstream: rt.upstream,
    proxy: { ...gProxy },
    allowedModels: rt.allowedModels,
    defaultModels: { ...rt.defaultModels },
    profileUsers: safeProfileUsers,
    globalUsers: safeGlobalUsers,
    activeProfile: getDefaultProfileName(),
    profiles: listProfiles(),
    circuitBreaker: rt.breaker.status(),
    port: port,
    hasPassword: !!dashboardPassword,
    profileQuota: getProfileQuota(""),
    autoQuotaAdjust: config.autoQuotaAdjust || {},
  };
}

// ─── Settings Page HTML ──────────────────────────────────────────────────────
function settingsHtml(errorMsg) {
  const s = getPublicSettings();
  const errDiv = errorMsg ? `<div style="background:rgba(248,113,113,.12);color:var(--red);padding:10px 14px;border-radius:6px;margin-bottom:16px;font-size:13px">${errorMsg}</div>` : "";

  // Global users table rows
  const globalUserRows = Object.entries(rt.globalUsers).map(([k, v]) => {
    const isObj = typeof v === "object" && v !== null;
    const username = isObj ? (v.username || "") : (typeof v === "string" ? v : "");
    const expiresAt = isObj ? (v.expiresAt || "") : "";
    const disabled = isObj ? !!v.disabled : false;
    return `<tr>
<td><code style="font-size:11px;color:var(--accent);user-select:all;cursor:pointer" title="点击复制" onclick="navigator.clipboard.writeText('${escJs(k)}')">${escHtml(k)}</code></td>
<td><input type="text" name="gu_un_${escHtml(k)}" value="${escHtml(username)}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px" placeholder="用户名"></td>
<td><input type="datetime-local" name="gu_ex_${escHtml(k)}" value="${escHtml(expiresAt)}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:3px 6px;border-radius:4px;font-size:11px;font-family:monospace;color-scheme:dark" title="留空=永不过期"></td>
<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer"><input type="checkbox" name="gu_dis_${escHtml(k)}" ${disabled ? "checked" : ""} style="width:auto;accent-color:var(--red)"><span style="font-size:11px;color:${disabled ? "var(--red)" : "var(--dim)"}">${disabled ? "已禁用" : "正常"}</span></label></td>
<td><button type="button" onclick="deleteGlobalUser('${escJs(k)}')" style="background:rgba(248,113,113,.15);color:var(--red);border:none;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px">删除</button></td></tr>`;
  }).join("");

  // Profile user rows (key assignment)
  const profileUserRows = Object.entries(rt.globalUsers).map(([k, v]) => {
    const isObj = typeof v === "object" && v !== null;
    const username = isObj ? (v.username || "") : (typeof v === "string" ? v : "");
    const globalDisabled = isObj ? !!v.disabled : false;
    const pu = rt.users[k];
    const realKey = pu ? (typeof pu === "string" ? pu : (pu.key || "")) : "";
    const profileDisabled = pu ? (typeof pu === "object" ? !!pu.disabled : false) : false;
    const userQuota = (pu && typeof pu === "object") ? (pu.dailyTokenLimit || 0) : 0;
    const rowStyle = globalDisabled ? "opacity:0.4" : "";
    return `<tr style="${rowStyle}">
<td><code style="font-size:11px;color:var(--accent)">${escHtml(k)}</code></td>
<td>${escHtml(username)}</td>
<td><input type="text" name="pu_rk_${escHtml(k)}" value="${escHtml(realKey)}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px;font-family:monospace" placeholder="真实Key (必填)"></td>
<td><input type="number" name="pu_quota_${escHtml(k)}" value="${userQuota}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px" min="0" step="100000" placeholder="0=不限"></td>
<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer"><input type="checkbox" name="pu_dis_${escHtml(k)}" ${profileDisabled ? "checked" : ""} style="width:auto;accent-color:var(--orange)"><span style="font-size:11px;color:${profileDisabled ? "var(--orange)" : "var(--dim)"}">${profileDisabled ? "已禁用" : "正常"}</span></label></td></tr>`;
  }).join("");

  const dm = s.defaultModels || {};

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>代理设置 - 团队AI Coding监控</title>
<style>
:root{--bg:#0a0a0a;--card:#141414;--border:#2a2a2a;--text:#e5e5e5;--dim:#999;--accent:#7c6ef0;--blue:#5ba3f5;--green:#34d399;--orange:#fbbf24;--red:#f87171}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);padding:0;overflow:hidden;height:100vh}
.layout{display:flex;height:100vh}
.sidebar{width:240px;min-width:240px;background:var(--card);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.sidebar-hd{padding:16px 14px 10px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.sidebar-hd h1{font-size:16px;margin:0;white-space:nowrap}
.sidebar-hd a{color:var(--dim);font-size:11px;text-decoration:none}
.sidebar-hd a:hover{color:var(--accent)}
.sidebar-list{flex:1;overflow-y:auto;padding:8px}
.sidebar-list::-webkit-scrollbar{width:4px}
.sidebar-list::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.sidebar-ft{padding:10px;border-top:1px solid var(--border)}
.pl-item{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 12px;margin-bottom:8px;position:relative;transition:border-color .15s}
.pl-item:hover{border-color:var(--dim)}
.pl-item.active{border-color:var(--accent);background:rgba(124,110,240,.08)}
.pl-name{font-size:14px;font-weight:600;margin-bottom:2px}
.pl-host{font-size:11px;color:var(--dim);font-family:monospace;word-break:break-all;margin-bottom:2px}
.pl-users{font-size:11px;color:var(--dim)}
.pl-actions{display:none;position:absolute;top:8px;right:8px;gap:4px}
.pl-item:hover .pl-actions{display:flex}
.pl-item.active .pl-actions{display:flex}
.pl-activate{font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid var(--accent);background:rgba(124,110,240,.15);color:var(--accent);cursor:pointer;white-space:nowrap}
.pl-activate:hover{background:var(--accent);color:#fff}
.pl-delete{font-size:12px;padding:1px 6px;border:none;background:none;color:var(--dim);cursor:pointer;border-radius:3px}
.pl-delete:hover{background:rgba(248,113,113,.15);color:var(--red)}
.pl-badge{font-size:10px;padding:2px 8px;border-radius:4px;background:rgba(124,110,240,.2);color:var(--accent);white-space:nowrap}
.main{flex:1;overflow-y:auto;padding:20px 28px}
.main::-webkit-scrollbar{width:6px}
.main::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.main h2{font-size:14px;margin:20px 0 10px;padding-bottom:8px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.main h2:first-of-type{margin-top:0}
.section{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:12px}
label{display:block;font-size:12px;color:var(--dim);margin-bottom:4px;margin-top:10px}
label:first-child{margin-top:0}
input,select,textarea{width:100%;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;font-family:monospace;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.btn{padding:8px 20px;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-weight:600}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{opacity:.9}
.btn-danger{background:rgba(248,113,113,.15);color:var(--red)}
.btn-danger:hover{background:rgba(248,113,113,.25)}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-outline:hover{background:rgba(255,255,255,.04)}
.btn-sm{padding:4px 12px;font-size:11px}
.actions{margin-top:16px;display:flex;gap:8px;justify-content:flex-end;padding-bottom:40px}
table{width:100%;border-collapse:collapse;margin-top:8px}
th{text-align:left;padding:6px 8px;font-size:11px;color:var(--dim);border-bottom:1px solid var(--border)}
td{padding:6px 8px;border-bottom:1px solid var(--border);font-size:12px}
.status{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px}
.status-ok{background:rgba(52,211,153,.15);color:var(--green)}
.status-warn{background:rgba(251,191,36,.15);color:var(--orange)}
.status-err{background:rgba(248,113,113,.15);color:var(--red)}
.note{font-size:11px;color:var(--dim);margin-top:6px}
.presets{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.preset{font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border);background:var(--bg);color:var(--dim);cursor:pointer;font-family:monospace}
.preset:hover{border-color:var(--accent);color:var(--text)}
.req{color:var(--red);font-size:10px;margin-left:4px}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;justify-content:center;align-items:center}
.modal-overlay.open{display:flex}
.modal{background:var(--card);border:1px solid var(--border);border-radius:12px;width:90%;max-width:1100px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.modal-hd{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.modal-hd h3{font-size:15px;margin:0}
.modal-close{background:none;border:none;color:var(--dim);font-size:20px;cursor:pointer;padding:0 4px;line-height:1}
.modal-close:hover{color:var(--text)}
.modal-body{padding:16px 20px;overflow-y:auto;flex:1}
.modal-body::-webkit-scrollbar{width:4px}
.modal-body::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
@media(max-width:768px){.layout{flex-direction:column}.sidebar{width:100%;min-width:0;max-height:200px}.row3{grid-template-columns:1fr 1fr}}
</style></head><body>
<div class="layout">
<div class="sidebar">
<div class="sidebar-hd"><h1>配置方案</h1><a href="/dashboard">← 面板</a></div>
<div class="sidebar-list">${s.profiles.map(p => {
    const host = p.upstream.replace(/^https?:\/\//, "").replace(/\/.*/, "");
    const suffixLabel = p.isDefault ? '<span style="color:var(--green);font-size:10px">默认</span>' : '<span style="color:var(--accent);font-size:10px">/'+ escHtml(p.suffix)+'</span>';
    return `<div class="pl-item${p.isDefault ? " active" : ""}" id="pl-${escHtml(p.name)}" onclick="editProfile('${escJs(p.name)}')">
<div class="pl-name">${escHtml(p.name)} ${suffixLabel}</div>
<div class="pl-host">${escHtml(host)}</div>
<div class="pl-users">${p.userCount}位用户</div>
<div class="pl-actions">
  ${!p.isDefault ? '<button class="pl-delete" onclick="event.stopPropagation();deleteProfile(\'' + escJs(p.name) + '\')">×</button>' : ''}
</div></div>`;
  }).join("")}</div>
<div class="sidebar-ft" style="display:flex;gap:6px"><button class="btn btn-outline btn-sm" onclick="openUserModal()" style="flex:1">用户管理</button><button class="btn btn-outline btn-sm" onclick="addProfile()" style="flex:1">+ 新增方案</button></div>
</div>
<div class="main">
${errDiv}
<form method="post" action="/api/settings-save" id="settingsForm">
<input type="hidden" name="_csrf" id="csrfToken">
<input type="hidden" name="profileSuffix" id="profileSuffixInput" value="">

<h2>上游代理 <span class="status ${s.circuitBreaker.state === 'CLOSED' ? 'status-ok' : s.circuitBreaker.state === 'HALF_OPEN' ? 'status-warn' : 'status-err'}">${s.circuitBreaker.state === 'CLOSED' ? '正常' : s.circuitBreaker.state === 'HALF_OPEN' ? '探测中' : '熔断中'}</span></h2>
<div class="section">
<div class="row">
<div><label>上游 API 地址<span class="req">*</span></label><input type="text" name="upstream" value="${s.upstream}" placeholder="https://open.bigmodel.cn/api/anthropic"></div>
<div><label>URL 后缀 <span style="font-size:11px;color:var(--dim);font-weight:400">(默认方案留空)</span></label><input type="text" name="suffix" id="suffixInput" value="${escHtml(s.profiles.find(p => p.isDefault)?.suffix || s.profiles[0]?.suffix || '')}" placeholder="如: glm" oninput="updateAccessUrl()"></div>
</div>
<div class="note" id="accessUrlPreview" style="margin-top:8px;color:var(--green)">接入地址: http://&lt;host&gt;:6789/v1</div>
<div class="presets">
  <span style="font-size:11px;color:var(--dim);line-height:24px">快速填充：</span>
  <button type="button" class="preset" onclick="document.querySelector('[name=upstream]').value='https://open.bigmodel.cn/api/anthropic'">智谱 GLM</button>
  <button type="button" class="preset" onclick="document.querySelector('[name=upstream]').value='https://api.anthropic.com'">Anthropic</button>
  <button type="button" class="preset" onclick="document.querySelector('[name=upstream]').value='https://api.openai.com/v1'">OpenAI</button>
  <button type="button" class="preset" onclick="document.querySelector('[name=upstream]').value='https://api.deepseek.com/anthropic'">DeepSeek</button>
  <button type="button" class="preset" onclick="document.querySelector('[name=upstream]').value='https://api.moonshot.cn/v1'">Moonshot</button>
  <button type="button" class="preset" onclick="document.querySelector('[name=upstream]').value='https://dashscope.aliyuncs.com/compatible-mode/v1'">阿里百炼</button>
  <button type="button" class="preset" onclick="document.querySelector('[name=upstream]').value='https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic'">阿里Token Plan</button>
</div>
<div class="note" style="margin-top:8px">状态：${s.circuitBreaker.state === 'CLOSED' ? '正常运行' : s.circuitBreaker.state === 'HALF_OPEN' ? '探测恢复中...' : '熔断中(' + Math.ceil(s.circuitBreaker.cooldownRemaining / 1000) + 's)'} | 失败 ${s.circuitBreaker.failureCount} | 成功 ${s.circuitBreaker.totalSuccesses} | 失败 ${s.circuitBreaker.totalFailures}</div>
</div>

<h2>默认模型映射 <span style="font-size:11px;color:var(--dim);font-weight:400">jx-sonnet / jx-opus / jx-haiku 别名映射</span></h2>
<div class="section">
<div class="row3">
<div><label>jx-sonnet → 实际模型<span class="req">*</span></label><input type="text" name="defaultModels_sonnet" value="${dm.sonnet || ''}" placeholder="如: deepseek-v4-pro"></div>
<div><label>jx-opus → 实际模型<span class="req">*</span></label><input type="text" name="defaultModels_opus" value="${dm.opus || ''}" placeholder="如: deepseek-v4-pro"></div>
<div><label>jx-haiku → 实际模型<span class="req">*</span></label><input type="text" name="defaultModels_haiku" value="${dm.haiku || ''}" placeholder="如: deepseek-v4-flash"></div>
</div>
<div class="presets">
  <span style="font-size:11px;color:var(--dim);line-height:24px">快速填充：</span>
  <button type="button" class="preset" onclick="fillDefaults('deepseek-v4-pro','deepseek-v4-pro','deepseek-v4-flash')">DeepSeek</button>
  <button type="button" class="preset" onclick="fillDefaults('claude-sonnet-4-6','claude-opus-4-5','claude-haiku-4-5')">Anthropic Claude</button>
  <button type="button" class="preset" onclick="fillDefaults('glm-5.1','glm-5.1','glm-5.1')">智谱 GLM</button>
  <button type="button" class="preset" onclick="fillDefaults('qwen-max','qwen-max','qwen-plus')">通义千问</button>
</div>
</div>

<h2>允许模型<span class="req">*必填</span></h2>
<div class="section">
<label>可用模型列表 (逗号分隔，至少1个)<span class="req">*必填</span></label>
<input type="text" name="allowedModels" value="${(s.allowedModels || []).join(",")}" placeholder="必填，如: deepseek-v4-pro, deepseek-v4-flash" required>
<div class="note">不在列表中的模型请求将被拦截返回403。默认模型映射的值会自动添加到此列表。</div>
</div>

<h2>超时 & 重试</h2>
<div class="section">
<div class="row">
<div><label>JSON 请求超时 (ms)</label><input type="number" name="timeout" value="${s.proxy.timeout}" min="10000" max="600000"></div>
<div><label>流式请求超时 (ms)</label><input type="number" name="streamTimeout" value="${s.proxy.streamTimeout}" min="30000" max="1200000"></div>
</div>
<div class="row">
<div><label>最大重试次数</label><input type="number" name="maxRetries" value="${s.proxy.maxRetries}" min="0" max="10"></div>
<div><label>重试基础延迟 (ms)</label><input type="number" name="retryDelay" value="${s.proxy.retryDelay}" min="100" max="30000"></div>
</div>
<div class="row">
<div><label>可重试状态码</label><input type="text" name="retryableStatusCodes" value="${(s.proxy.retryableStatusCodes || []).join(",")}"></div>
<div><label>熔断失败阈值</label><input type="number" name="circuitBreakerFailures" value="${s.proxy.circuitBreakerFailures || 5}" min="1" max="50"></div>
</div>
<div class="row">
<div><label>熔断冷却时间 (ms)</label><input type="number" name="circuitBreakerCooldown" value="${s.proxy.circuitBreakerCooldown || 30000}" min="5000" max="300000"></div>
<div></div>
</div>
</div>

<h2>流量控制</h2>
<div class="section">
<div class="row">
<div><label>每用户最大并发数</label><input type="number" name="maxConcurrentPerUser" value="${s.proxy.maxConcurrentPerUser}" min="1" max="100"></div>
<div><label>每用户每分钟最大请求数</label><input type="number" name="rateLimitPerMinute" value="${s.proxy.rateLimitPerMinute}" min="1" max="600"></div>
</div>
</div>

<h2>每日Token配额 <span style="font-size:11px;color:var(--dim);font-weight:400">总Token=输入+输出，0=不限制，北京时间每日0点重置</span></h2>
<div class="section">
<label>方案每日总Token上限 (0=不限制)</label>
<input type="number" name="profileQuota" value="${s.profileQuota || 0}" min="0" step="100000" placeholder="0 = 不限制">
<div class="note">方案配额适用于该方案下所有用户。每个用户可以在用户管理弹窗中单独设置。</div>
</div>

<h2>自动配额调整 <span style="font-size:11px;color:var(--dim);font-weight:400">用户持续用满配额时自动上调限额</span></h2>
<div class="section">
<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" name="autoQuotaEnabled" ${s.autoQuotaAdjust?.enabled ? "checked" : ""} style="width:auto"> 启用自动调整</label>
<span class="note">启用后，系统每日评估一次，符合条件自动上调配额</span>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
<div><label>评估周期（天）</label><input type="number" name="aqPeriod" value="${s.autoQuotaAdjust?.evaluationPeriodDays ?? 5}" min="3" max="30"></div>
<div><label>命中阈值</label><input type="number" name="aqHitThreshold" value="${Math.round((s.autoQuotaAdjust?.hitThreshold ?? 0.9) * 100)}" min="50" max="100" step="5"><span class="note">% · 用量达到配额多少算命中</span></div>
<div><label>触发命中率</label><input type="number" name="aqTriggerRate" value="${Math.round((s.autoQuotaAdjust?.triggerRate ?? 0.9) * 100)}" min="30" max="100" step="10"><span class="note">% · 命中天数占周期多少才触发</span></div>
<div><label>增长率</label><input type="number" name="aqIncreaseFactor" value="${Math.round(((s.autoQuotaAdjust?.increaseFactor ?? 1.15) - 1) * 100)}" min="5" max="100" step="5"><span class="note">% · 每次上调比例</span></div>
<div><label>安全系数</label><input type="number" name="aqSafetyFactor" value="${Math.round((s.autoQuotaAdjust?.safetyFactor ?? 1.3) * 100)}" min="100" max="200" step="5"><span class="note">% · 按均值计算时的余量</span></div>
<div><label>单次最大增幅</label><input type="number" name="aqMaxIncrease" value="${(s.autoQuotaAdjust?.maxIncreaseFactor ?? 2.0)}" min="1.1" max="5" step="0.1"><span class="note">x · 单次调整不超过几倍</span></div>
<div><label>配额上限</label><input type="number" name="aqMaxQuota" value="${s.autoQuotaAdjust?.maxAutoQuota ?? 10000000}" min="0" step="100000"><span class="note">自动调整不超过此值</span></div>
<div><label>冷却天数</label><input type="number" name="aqCooldown" value="${s.autoQuotaAdjust?.cooldownDays ?? 3}" min="1" max="30"><span class="note">两次调整最小间隔</span></div>
</div>
${(store.quotaAdjustHistory && store.quotaAdjustHistory.length > 0) ? `<h4 style="font-size:13px;color:var(--accent);margin:16px 0 8px">调整历史</h4><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">时间</th><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">用户</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">旧配额</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">新配额</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">命中率</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">日均用量</th></tr></thead><tbody>${store.quotaAdjustHistory.slice(-20).reverse().map(h => `<tr><td style="padding:4px 8px">${h.date}</td><td style="padding:4px 8px">${h.username || h.user.slice(0, 8)}</td><td style="text-align:right;padding:4px 8px">${(h.oldQuota || 0).toLocaleString()}</td><td style="text-align:right;padding:4px 8px;color:var(--green)">${(h.newQuota || 0).toLocaleString()}</td><td style="text-align:right;padding:4px 8px">${Math.round((h.hitRate || 0) * 100)}%</td><td style="text-align:right;padding:4px 8px">${(h.avgDailyUsage || 0).toLocaleString()}</td></tr>`).join("")}</tbody></table>` : '<div class="note" style="margin-top:8px">暂无自动调整记录</div>'}
</div>

<div class="actions">
<button type="button" class="btn btn-outline" onclick="location.href='/dashboard'">取消</button>
<button type="submit" class="btn btn-primary">保存设置</button>
</div>
</form>
</div>
</div>
<div class="modal-overlay" id="userModal">
<div class="modal">
<div class="modal-hd"><h3>用户管理</h3><button class="modal-close" onclick="closeUserModal()">&times;</button></div>
<div class="modal-body">
<h4 style="font-size:13px;color:var(--accent);margin:0 0 8px">全局用户信息</h4>
<table id="globalUsersTable">
<thead><tr><th>虚拟 Key</th><th>用户名称</th><th style="width:160px">失效时间</th><th style="width:80px">全局禁用</th><th style="width:60px">操作</th></tr></thead>
<tbody>${globalUserRows}</tbody>
</table>
<div style="margin:12px 0 4px;display:flex;gap:8px;align-items:center">
<button type="button" class="btn btn-outline btn-sm" onclick="addGlobalUser()">+ 添加用户</button>
<span class="note">虚拟Key自动生成（jx-开头24位随机码），点击可复制。失效时间留空=永不过期。</span>
</div>
<h4 style="font-size:13px;color:var(--accent);margin:16px 0 8px">方案真实Key分配 <span style="font-size:11px;color:var(--dim);font-weight:400">（当前方案：${config.activeProfile}）</span></h4>
<table id="profileUsersTable">
<thead><tr><th>虚拟 Key</th><th>用户名称</th><th>真实 Key</th><th style="width:120px">每日配额</th><th style="width:80px">方案禁用</th></tr></thead>
<tbody>${profileUserRows}</tbody>
</table>
<div class="note" style="margin-top:6px">全局禁用的用户灰色显示。真实Key必填才能使用此方案。</div>
<div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px;padding-bottom:8px">
<button type="button" class="btn btn-outline btn-sm" onclick="closeUserModal()">取消</button>
<button type="button" class="btn btn-primary btn-sm" onclick="saveUsers()">保存全部</button>
</div>
</div>
</div>
</div>
<script>
function getCsrf(){const m=document.cookie.match(/tm_csrf=([^;]+)/);return m?m[1]:''}
document.getElementById('csrfToken').value=getCsrf();
function csrfHeaders(h){h=h||{};h['x-csrf-token']=getCsrf();return h}
function openUserModal(){document.getElementById('userModal').classList.add('open')}
function closeUserModal(){document.getElementById('userModal').classList.remove('open')}
document.getElementById('userModal').addEventListener('click',function(e){if(e.target===this)closeUserModal()});
async function switchToProfile(n){
  // No longer exclusive switch — just reload the profile into the form
  editProfile(n);
}
let editingProfileName="${escJs(s.profiles.find(p=>p.isDefault)?.name||s.profiles[0]?.name||'')}";
function updateAccessUrl(){
  const sfx=document.getElementById('suffixInput').value.trim();
  const preview=sfx?'http://&lt;host&gt;:6789/'+(sfx)+'/v1':'http://&lt;host&gt;:6789/v1';
  document.getElementById('accessUrlPreview').innerHTML='接入地址: '+preview+(sfx?'':' <span style="color:var(--dim)">(默认方案，无后缀)</span>');
}
updateAccessUrl();
async function editProfile(n){
  const profiles=${JSON.stringify(s.profiles)};
  const p=profiles.find(x=>x.name===n);
  if(!p)return;
  editingProfileName=n;
  const fm=document.forms.settingsForm;
  fm.upstream.value=p.upstream||'';
  document.getElementById('suffixInput').value=p.suffix||'';
  if(p.allowedModels)fm.allowedModels.value=p.allowedModels.join(', ');
  if(p.defaultModels){
    fm.defaultModels_sonnet.value=p.defaultModels.sonnet||'';
    fm.defaultModels_opus.value=p.defaultModels.opus||'';
    fm.defaultModels_haiku.value=p.defaultModels.haiku||'';
  }
  document.querySelectorAll('.pl-item').forEach(el=>el.classList.remove('active'));
  const el=document.getElementById('pl-'+n);
  if(el)el.classList.add('active');
  document.getElementById('profileSuffixInput').value=p.suffix||'';
  updateAccessUrl();
}
async function addProfile(){
  const name=prompt('请输入新方案名称');
  if(!name)return;
  const suffix=prompt('请输入URL后缀（英文/数字/下划线，如: glm）\\n用户将通过 http://host:6789/<后缀>/v1 访问此方案');
  if(suffix===null)return;
  const fm=document.forms.settingsForm;
  const r=await fetch('/api/profile/save',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({
    profile:name,suffix:suffix||'',upstream:fm.upstream.value,allowedModels:fm.allowedModels.value,
    defaultModels:{sonnet:fm.defaultModels_sonnet.value,opus:fm.defaultModels_opus.value,haiku:fm.defaultModels_haiku.value}
  })});
  if(r.ok)location.reload();else{const e=await r.json();alert('创建失败: '+e.error)}
}
async function deleteProfile(n){
  if(!confirm('确定删除方案 "'+n+'"？'))return;
  const r=await fetch('/api/profile/delete',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({profile:n})});
  if(r.ok)location.reload();else{const e=await r.json();alert('删除失败: '+e.error)}
}
async function deleteGlobalUser(k){
  if(!confirm('确定删除用户？该用户将从所有方案中移除。'))return;
  const r=await fetch('/api/global-user/delete',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({key:k})});
  if(r.ok)location.reload();else{const e=await r.json();alert('删除失败: '+e.error)}
}
async function saveUsers(){
  const tbody=document.querySelector("#globalUsersTable tbody");
  const rows=tbody.querySelectorAll("tr");
  const users=[];
  rows.forEach(tr=>{
    const hidden=tr.querySelector('input[type=hidden]');
    const vk=hidden?hidden.value:tr.querySelector('code')?.textContent?.trim()||'';
    const unInput=tr.querySelector('input[name^="gu_un_"]');
    const exInput=tr.querySelector('input[name^="gu_ex_"]');
    const disInput=tr.querySelector('input[name^="gu_dis_"]');
    if(!vk||!unInput)return;
    users.push({key:vk,username:unInput.value||vk.slice(0,8),expiresAt:exInput?exInput.value:'',disabled:disInput?disInput.checked:false});
  });
  const ptbody=document.querySelector("#profileUsersTable tbody");
  const prows=ptbody.querySelectorAll("tr");
  const profileUsers=[];
  prows.forEach(tr=>{
    const vk=tr.querySelector('code')?.textContent?.trim()||'';
    const rkInput=tr.querySelector('input[name^="pu_rk_"]');
    const disInput=tr.querySelector('input[name^="pu_dis_"]');
    if(!vk)return;
    const qInput=tr.querySelector('input[name^="pu_quota_"]');
    const qv=parseInt(qInput?qInput.value:'0',10)||0;
    profileUsers.push({key:vk,realKey:rkInput?rkInput.value.trim():'',disabled:disInput?disInput.checked:false,dailyTokenLimit:qv>0?qv:null});
  });
  const r=await fetch('/api/global-user/save',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({users,profileUsers})});
  if(r.ok){alert('保存成功');location.reload()}else{const e=await r.json();alert('保存失败: '+e.error)}
}
function genVK(){const c="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";const a=new Uint8Array(24);crypto.getRandomValues(a);let k="jx-";for(let i=0;i<24;i++)k+=c[a[i]%c.length];return k}
function addGlobalUser(){
  const tbody=document.querySelector("#globalUsersTable tbody");
  const tr=document.createElement("tr");
  const vk=genVK();
  tr.innerHTML='<td><code style="font-size:11px;color:var(--accent);user-select:all">'+vk+'</code><input type="hidden" name="gu_new_'+vk+'" value="'+vk+'"></td>'
    +'<td><input type="text" name="gu_un_new_'+vk+'" placeholder="用户名" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px"></td>'
    +'<td><input type="datetime-local" name="gu_ex_new_'+vk+'" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:3px 6px;border-radius:4px;font-size:11px;color-scheme:dark"></td>'
    +'<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer"><input type="checkbox" name="gu_dis_new_'+vk+'" style="width:auto;accent-color:var(--red)"><span style="font-size:11px;color:var(--dim)">正常</span></label></td>'
    +'<td><button type="button" onclick="this.closest(\\'tr\\').remove()" style="background:rgba(248,113,113,.15);color:var(--red);border:none;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px">删除</button></td>';
  tbody.appendChild(tr);
}
function fillDefaults(s,o,h){
  document.querySelector('[name=defaultModels_sonnet]').value=s;
  document.querySelector('[name=defaultModels_opus]').value=o;
  document.querySelector('[name=defaultModels_haiku]').value=h;
}
document.addEventListener("keydown",e=>{if(e.key==="Enter"&&e.target.tagName!=="TEXTAREA"&&e.target.tagName!=="INPUT")e.preventDefault()});
</script>
</body></html>`;
}

// ─── Dashboard HTML ──────────────────────────────────────────────────────────
function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>团队AI Coding监控</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
:root{--bg:#0a0a0a;--card:#141414;--border:#2a2a2a;--text:#e5e5e5;--dim:#999;--accent:#7c6ef0;--blue:#5ba3f5;--green:#34d399;--orange:#fbbf24;--red:#f87171}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);padding:20px 24px}
h1{font-size:20px;margin-bottom:4px}.meta{font-size:12px;color:var(--dim);margin-bottom:20px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 16px}
.card .l{font-size:12px;color:var(--dim);margin-bottom:4px}.card .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.tabs{display:flex;gap:4px;margin-bottom:16px;background:var(--card);border-radius:6px;padding:3px;width:fit-content}
.tab{padding:6px 16px;font-size:13px;border:none;background:transparent;color:var(--dim);cursor:pointer;border-radius:5px}
.tab.on{background:var(--accent);color:#fff}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px}
.box{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px}
.box h3{font-size:12px;color:var(--dim);margin-bottom:10px}
.box canvas{max-height:260px}
.sec{background:var(--card);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:20px}
.sec h3{font-size:12px;color:var(--dim);padding:12px 16px 0;margin:0}
.sec-collapsible h3{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;padding:12px 16px}
.sec-collapsible h3:hover{color:var(--text)}
.sec-toggle{display:inline-block;width:16px;font-size:10px;transition:transform .2s;flex-shrink:0;color:var(--dim)}
.sec-toggle.open{transform:rotate(90deg)}
.sec-hint{font-size:11px;color:var(--dim);font-weight:400;margin-left:auto}
.sec-body{display:none;padding:0 16px 12px}
.sec-body.open{display:block}
.sec-body table{margin-top:0}
.sec-body .empty{padding:16px 0}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:8px 16px;font-size:11px;color:var(--dim);border-bottom:1px solid var(--border)}
td{padding:8px 16px;font-size:13px;border-bottom:1px solid var(--border)}
tr:last-child td{border-bottom:none}tr:hover td{background:rgba(255,255,255,.02)}
.n{font-variant-numeric:tabular-nums;text-align:right}
.hl{color:var(--accent);font-weight:600}
.empty{color:var(--dim);padding:24px;text-align:center;font-size:13px}
@media(max-width:768px){.grid{grid-template-columns:1fr}.cards{grid-template-columns:1fr 1fr}}
</style></head><body>
<h1>团队AI Coding监控 <span style="float:right;font-size:12px;display:flex;gap:8px;align-items:center"><select id="profileSel" style="font-size:12px;background:var(--card);color:var(--text);border:1px solid var(--border);padding:4px 8px;border-radius:4px;cursor:pointer;max-width:160px" onchange="switchProfileView(this.value)"><option value="">全部方案</option></select><a href="/settings" style="color:var(--dim);text-decoration:none;font-size:12px;padding:4px 10px;border:1px solid var(--border);border-radius:4px">设置</a><button id="autoRefreshBtn" style="font-size:12px;background:rgba(52,211,153,.15);color:var(--green);border:none;padding:4px 12px;border-radius:4px;cursor:pointer">自动刷新: 开</button><button onclick="fetch('/api/logout',{method:'POST',headers:{'x-csrf-token':(document.cookie.match(/tm_csrf=([^;]+)/)||[])[1]||''}}).then(()=>location.reload())" style="font-size:12px;background:rgba(255,255,255,.06);color:var(--dim);border:none;padding:4px 12px;border-radius:4px;cursor:pointer">退出</button></span></h1>
<div class="meta" id="meta">Loading...</div>
<div class="cards" id="cards"></div>
<div class="tabs" id="tabs">
  <button class="tab on" data-p="day">按日</button>
  <button class="tab" data-p="week">按周</button>
  <button class="tab" data-p="month">按月</button>
  <button class="tab" data-p="year">按年</button>
</div>
<div class="grid">
  <div class="box"><h3>Token 用量趋势</h3><canvas id="trend"></canvas></div>
  <div class="box"><h3>用户用量分布</h3><canvas id="pie"></canvas></div>
  <div class="box"><h3>模型使用分布</h3><canvas id="modelChart"></canvas></div>
  <div class="box"><h3>24 小时使用趋势 (今日)</h3><canvas id="hourChart"></canvas></div>
</div>
<div class="sec"><h3>用户用量明细</h3><table id="uTable"><thead>
<tr><th>用户</th><th>状态</th><th class="n">请求数</th><th class="n">输入</th><th class="n">输出</th><th class="n">缓存写入</th><th class="n">缓存命中</th><th class="n">合计</th><th class="n">配额</th><th>最后活跃</th></tr>
</thead><tbody></tbody></table></div>
<div class="sec sec-collapsible" id="detailSec"><h3 onclick="toggleSec('detailSec')"><span class="sec-toggle" id="detailSecIcon">▶</span>明细记录<span class="sec-hint" id="detailHint"></span></h3><div class="sec-body" id="detailSecBody"><table id="dTable"><thead>
<tr><th>时间</th><th>用户</th><th class="n">请求数</th><th class="n">输入</th><th class="n">输出</th><th class="n">缓存写入</th><th class="n">缓存命中</th><th class="n">合计</th></tr>
</thead><tbody></tbody></table></div></div>
<div class="sec sec-collapsible" id="errorSec"><h3 onclick="toggleSec('errorSec')"><span class="sec-toggle" id="errorSecIcon">▶</span>错误记录<span id="errorCount" style="font-size:11px;color:var(--red);font-weight:400;margin-left:4px"></span><span class="sec-hint" id="errorHint" style="margin-left:auto"></span><button id="clearErrors" onclick="event.stopPropagation()" style="font-size:11px;background:rgba(248,113,113,.15);color:var(--red);border:none;padding:2px 10px;border-radius:4px;cursor:pointer;margin-left:8px">清除</button></h3><div class="sec-body" id="errorSecBody"><table id="eTable"><thead>
<tr><th>时间</th><th>用户</th><th class="n">状态码</th><th>模型</th><th>路径</th><th>错误信息</th></tr>
</thead><tbody></tbody></table>
<div id="errPages" style="padding:8px 0;text-align:right"></div></div></div>
<script>
let D=null,P="day",C={t:null,p:null,m:null,h:null},errPage=1,autoRefresh=true,refreshTimer=null,currentProfile="all";
const ERR_PAGE_SIZE=20;
const COL=["#7c6ef0","#5ba3f5","#34d399","#fbbf24","#f87171","#f472b6","#a78bfa","#38bdf8"];
const fmtT=n=>n.toLocaleString("zh-CN");
const fmtTk=n=>{if(n>=1e6)return(n/1e6).toFixed(1)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return n.toString()};
function fmtBJ(iso){if(!iso)return"-";const d=new Date(iso);const utc=d.getTime()+d.getTimezoneOffset()*60000;return new Date(utc+8*3600000).toLocaleString("zh-CN")};
function ago(iso){if(!iso)return"-";const d=Date.now()-new Date(iso).getTime();const m=Math.floor(d/6e4);if(m<1)return"刚刚";if(m<60)return m+"分钟前";const h=Math.floor(m/60);if(h<24)return h+"小时前";return Math.floor(h/24)+"天前"}
function wk(s){const d=new Date(s),day=d.getDay()||7,mon=new Date(d);mon.setDate(d.getDate()-day+1);return mon.toISOString().slice(0,10)}
function grp(daily,p){const g={};for(const[day,ud]of Object.entries(daily)){const k=p==="week"?wk(day):p==="month"?day.slice(0,7):p==="year"?day.slice(0,4):day;if(!g[k])g[k]={};for(const[u,s]of Object.entries(ud)){if(!g[k][u])g[k][u]={inputTokens:0,outputTokens:0,requests:0,cacheCreationTokens:0,cacheReadTokens:0};g[k][u].inputTokens+=s.inputTokens;g[k][u].outputTokens+=s.outputTokens;g[k][u].requests+=s.requests;g[k][u].cacheCreationTokens+=(s.cacheCreationTokens||0);g[k][u].cacheReadTokens+=(s.cacheReadTokens||0)}}return g}
function lbl(p,k){if(p==="day")return k.slice(5);if(p==="week")return k.slice(5)+" 周";if(p==="month")return k;return k+"年"}
function c(l,v,cl){return'<div class="card"><div class="l">'+l+'</div><div class="v" style="color:'+cl+'">'+v+'</div></div>'}
function switchProfileView(v){currentProfile=v||"all";load()}
function render(){
  if(!D)return;
  // Populate profile dropdown
  const sel=document.getElementById("profileSel");
  if(sel.options.length<=1 && D.profiles){
    sel.innerHTML='<option value="all">📊 全部方案</option>';
    for(const p of D.profiles){
      const sfx=p.suffix?"("+p.suffix+")":"(默认)";
      sel.innerHTML+='<option value="'+escH(p.suffix)+'">'+escH(p.name)+' '+sfx+'</option>';
    }
    sel.value=currentProfile==="all"?"all":currentProfile;
  }
  const us=Object.values(D.users),ti=us.reduce((s,u)=>s+u.totalInputTokens,0),to=us.reduce((s,u)=>s+u.totalOutputTokens,0),tr=us.reduce((s,u)=>s+u.totalRequests,0);
  const td=new Date(Date.now()+8*36e5).toISOString().slice(0,10),tdd=(D.daily||{})[td]||{};
  const tIn=Object.values(tdd).reduce((s,d)=>s+d.inputTokens,0),tOut=Object.values(tdd).reduce((s,d)=>s+d.outputTokens,0),tR=Object.values(tdd).reduce((s,d)=>s+d.requests,0);
  document.getElementById("cards").innerHTML=c("今日用量",fmtT(tIn+tOut),"var(--accent)")+c("今日请求",fmtT(tR),"var(--blue)")+c("总用量",fmtT(ti+to),"var(--green)")+c("总请求",fmtT(tr),"var(--orange)")+c("今日错误",fmtT((Array.isArray(D.errors)?D.errors:[]).filter(e=>e.time&&e.time.startsWith(td)).length),"var(--red)");
  const profileLabel=D.profileView||(currentProfile==="all"?"全部方案":"默认方案");
  const upstreamInfo=D.upstream?(" | 上游: "+D.upstream.replace("https://","").replace("http://","")):"";
  document.getElementById("meta").innerHTML='<span style="color:var(--accent);font-weight:600">方案: '+profileLabel+'</span>'+upstreamInfo+' &nbsp;|&nbsp; 更新于 '+(function(){const d=new Date();const utc=d.getTime()+d.getTimezoneOffset()*60000;return new Date(utc+8*3600000).toLocaleTimeString("zh-CN")})()+" (北京时间) | 每30秒刷新";

  // Charts
  const g=grp(D.daily||{},P),keys=Object.keys(g).sort(),uks=Object.keys(D.users);
  if(C.t)C.t.destroy();if(C.p)C.p.destroy();if(C.m)C.m.destroy();if(C.h)C.h.destroy();
  C.t=new Chart(document.getElementById("trend"),{type:"bar",data:{labels:keys.map(k=>lbl(P,k)),datasets:uks.map((u,i)=>({label:D.users[u].name,data:keys.map(k=>(g[k][u]||{}).inputTokens+(g[k][u]||{}).outputTokens||0),backgroundColor:COL[i%COL.length]+"cc",borderRadius:3,borderSkipped:false}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:"#999",font:{size:11}}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{stacked:true,ticks:{color:"#666",font:{size:10}},grid:{color:"#1a1a1a"}},y:{stacked:true,ticks:{color:"#666",callback:v=>fmtTk(v)},grid:{color:"#1a1a1a"}}}}});
  const tot=uks.map(u=>{let t=0;for(const k of keys)t+=(g[k][u]||{}).inputTokens+(g[k][u]||{}).outputTokens||0;return t});
  C.p=new Chart(document.getElementById("pie"),{type:"doughnut",data:{labels:uks.map(k=>D.users[k].name),datasets:[{data:tot,backgroundColor:uks.map((_,i)=>COL[i%COL.length]+"cc"),borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"right",labels:{color:"#999",font:{size:11},padding:12}},tooltip:{callbacks:{label:ctx=>ctx.label+": "+fmtT(ctx.raw)+" tokens"}}},cutout:"55%"}});

  // 模型分布
  const mods=D.models||{};const mNames=Object.keys(mods);
  C.m=new Chart(document.getElementById("modelChart"),{type:"doughnut",data:{labels:mNames,datasets:[{data:mNames.map(m=>mods[m].tokens),backgroundColor:mNames.map((_,i)=>COL[i%COL.length]+"cc"),borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"right",labels:{color:"#999",font:{size:11},padding:12}},tooltip:{callbacks:{label:ctx=>ctx.label+": "+fmtT(ctx.raw)+" tokens"}}},cutout:"55%"}});

  // 24小时趋势图
  const hrs=[];for(let i=0;i<24;i++)hrs.push(i.toString().padStart(2,"0")+":00");
  const todayHourly=(D.hourly||{})[td]||{};
  const hReq=hrs.map((_,i)=>{const h=todayHourly[i.toString().padStart(2,"0")];return typeof h==="object"?(h.requests||0):0});
  const hIn=hrs.map((_,i)=>{const h=todayHourly[i.toString().padStart(2,"0")];return typeof h==="object"?(h.inputTokens||0):0});
  const hOut=hrs.map((_,i)=>{const h=todayHourly[i.toString().padStart(2,"0")];return typeof h==="object"?(h.outputTokens||0):0});
  C.h=new Chart(document.getElementById("hourChart"),{type:"line",data:{labels:hrs,datasets:[{label:"请求数",data:hReq,borderColor:"#5ba3f5",backgroundColor:"rgba(91,163,245,.12)",fill:true,tension:.4,pointRadius:3,pointBackgroundColor:"#5ba3f5",pointHoverRadius:6,borderWidth:2.5,yAxisID:"y"},{label:"输入",data:hIn,borderColor:"#a78bfa",backgroundColor:"rgba(167,139,250,.12)",fill:true,tension:.4,pointRadius:3,pointBackgroundColor:"#a78bfa",pointHoverRadius:6,borderWidth:2.5,yAxisID:"y1"},{label:"输出",data:hOut,borderColor:"#f87171",backgroundColor:"rgba(248,113,113,.12)",fill:true,tension:.4,pointRadius:3,pointBackgroundColor:"#f87171",pointHoverRadius:6,borderWidth:2.5,yAxisID:"y1"}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:{labels:{color:"#999",font:{size:11},usePointStyle:true,pointStyle:"circle"}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{ticks:{color:"#666",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{type:"linear",position:"left",ticks:{color:"#5ba3f5"},grid:{color:"#1a1a1a"},title:{display:true,text:"请求数",color:"#5ba3f5",font:{size:10}}},y1:{type:"linear",position:"right",ticks:{color:"#a78bfa",callback:v=>fmtTk(v)},grid:{drawOnChartArea:false},title:{display:true,text:"Tokens",color:"#a78bfa",font:{size:10}}}}}});

  // User table
  const ut=document.querySelector("#uTable tbody");
  const ul=Object.entries(D.users).sort((a,b)=>(b[1].totalInputTokens+b[1].totalOutputTokens)-(a[1].totalInputTokens+a[1].totalOutputTokens));
  if(!ul.length){ut.innerHTML='<tr><td colspan="10" class="empty">暂无数据</td></tr>'}else{ut.innerHTML=ul.map(([uk,u])=>{const on=u.lastActive&&Date.now()-new Date(u.lastActive).getTime()<36e5;const uq=(D.userQuotas||{})[uk]||D.profileQuota||0;const td2=(D.daily||{})[td]||{};const tdu=td2[uk]||{inputTokens:0,outputTokens:0};const used=tdu.inputTokens+tdu.outputTokens;const qPct=uq>0?Math.min(100,Math.round(used/uq*100)):0;const qCol=qPct>90?'var(--red)':qPct>70?'var(--orange)':'var(--green)';const qLabel=uq>0?'<span style="color:'+qCol+'">'+qPct+'%</span>':'<span style="color:var(--dim)">-</span>';return'<tr><td>'+u.name+'</td><td><span style="padding:2px 8px;border-radius:4px;font-size:11px;background:'+(on?'rgba(52,211,153,.15)':'rgba(255,255,255,.05)')+';color:'+(on?'var(--green)':'var(--dim)')+'">'+(on?'在线':'离线')+'</span></td><td class="n">'+fmtT(u.totalRequests)+'</td><td class="n">'+fmtT(u.totalInputTokens)+'</td><td class="n">'+fmtT(u.totalOutputTokens)+'</td><td class="n">'+fmtT(u.cacheCreationTokens || 0)+'</td><td class="n">'+fmtT(u.cacheReadTokens || 0)+'</td><td class="n hl">'+fmtT(u.totalInputTokens+u.totalOutputTokens)+'</td><td class="n">'+qLabel+'</td><td>'+ago(u.lastActive)+'</td></tr>'}).join("")}

  // Detail table
  const dt=document.querySelector("#dTable tbody");
  if(!keys.length){dt.innerHTML='<tr><td colspan="8" class="empty">暂无数据</td></tr>'}else{let rows=[];for(const k of keys.sort().reverse()){const us2=Object.entries(g[k]).sort((a,b)=>(b[1].inputTokens+b[1].outputTokens)-(a[1].inputTokens+a[1].outputTokens));for(const[u,d]of us2){const n=(D.users[u]||{}).name||u.slice(0,8);rows.push('<tr><td>'+lbl(P,k)+'</td><td>'+n+'</td><td class="n">'+fmtT(d.requests)+'</td><td class="n">'+fmtT(d.inputTokens)+'</td><td class="n">'+fmtT(d.outputTokens)+'</td><td class="n">'+fmtT(d.cacheCreationTokens || 0)+'</td><td class="n">'+fmtT(d.cacheReadTokens || 0)+'</td><td class="n hl">'+fmtT(d.inputTokens+d.outputTokens)+'</td></tr>')}}dt.innerHTML=rows.join("");document.getElementById("detailHint").textContent=rows.length+"条记录"}

  // Error table with pagination
  const allErrs=Array.isArray(D.errors)?D.errors:[];
  const totalErrPages=Math.max(1,Math.ceil(allErrs.length/ERR_PAGE_SIZE));
  if(errPage>totalErrPages)errPage=totalErrPages;
  const errs=allErrs.slice((errPage-1)*ERR_PAGE_SIZE,errPage*ERR_PAGE_SIZE);
  const et=document.querySelector("#eTable tbody");
  if(!errs.length){et.innerHTML='<tr><td colspan="6" class="empty">暂无错误记录</td></tr>'}else{et.innerHTML=errs.map(e=>{const sc=e.statusCode||"-";const col=sc>=500?"var(--red)":sc>=400?"var(--orange)":"var(--dim)";return'<tr><td style="font-size:12px;white-space:nowrap">'+(e.time?fmtBJ(e.time):"-")+'</td><td>'+(e.user||"-")+'</td><td class="n" style="color:'+col+';font-weight:600">'+sc+'</td><td style="font-size:12px;color:var(--blue)">'+(e.model||"-")+'</td><td style="font-size:12px;color:var(--dim);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(e.path||"-")+'</td><td style="font-size:12px;color:var(--red);max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+(e.error||"").replace(/"/g,'&quot;')+'">'+(e.error||"-")+'</td></tr>'}).join("")}
  const pg=document.getElementById("errPages");
  pg.innerHTML='<span style="font-size:12px;color:var(--dim)">第 '+errPage+"/"+totalErrPages+' 页 (共 '+allErrs.length+' 条)</span> '+(errPage>1?'<button onclick="errPage--;render()" style="font-size:11px;background:var(--card);color:var(--text);border:1px solid var(--border);padding:2px 10px;border-radius:4px;cursor:pointer">上一页</button> ':'')+(errPage<totalErrPages?'<button onclick="errPage++;render()" style="font-size:11px;background:var(--card);color:var(--text);border:1px solid var(--border);padding:2px 10px;border-radius:4px;cursor:pointer">下一页</button>':'');
  document.getElementById("errorCount").textContent=allErrs.length>0?'('+allErrs.length+')':'';
  document.getElementById("errorHint").textContent=allErrs.length>0?(allErrs.length+'条错误'):'暂无错误';
}
async function load(){try{const profile=currentProfile==="all"?"all":currentProfile;const r=await fetch("/api/stats"+(profile?"?profile="+encodeURIComponent(profile):""));D=await r.json();render()}catch(e){document.getElementById("meta").textContent="Error: "+e.message}}
function toggleSec(id){const body=document.getElementById(id+"Body");const icon=document.getElementById(id+"Icon");const open=body.classList.toggle("open");icon.classList.toggle("open",open)}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("on"));b.classList.add("on");P=b.dataset.p;render()}));
document.getElementById("clearErrors").addEventListener("click",async()=>{if(confirm("确定清除所有错误记录？")){const csrf=(document.cookie.match(/tm_csrf=([^;]+)/)||[])[1]||'';await fetch("/api/clear-errors",{method:"POST",headers:{"x-csrf-token":csrf}});errPage=1;load()}});
function startAutoRefresh(){if(refreshTimer)clearInterval(refreshTimer);refreshTimer=setInterval(()=>{if(autoRefresh)load()},30000)}
document.getElementById("autoRefreshBtn").addEventListener("click",()=>{autoRefresh=!autoRefresh;const btn=document.getElementById("autoRefreshBtn");btn.textContent="自动刷新: "+(autoRefresh?"开":"关");btn.style.background=autoRefresh?"rgba(52,211,153,.15)":"rgba(255,255,255,.06)";btn.style.color=autoRefresh?"var(--green)":"var(--dim)"});
load();startAutoRefresh();
<\/script></body></html>`;
}

// ─── Login Page HTML ─────────────────────────────────────────────────────────
function loginHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>团队AI Coding监控 - 登录</title>
<style>
:root{--bg:#0a0a0a;--card:#141414;--border:#2a2a2a;--text:#e5e5e5;--dim:#999;--accent:#7c6ef0;--red:#f87171}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);display:flex;justify-content:center;align-items:center;height:100vh}
.login{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:32px;width:320px}
.login h2{font-size:18px;margin-bottom:20px;text-align:center}
.login input{width:100%;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:14px;margin-bottom:12px;outline:none}
.login input:focus{border-color:var(--accent)}
.login button{width:100%;padding:10px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer}
.login button:hover{opacity:.9}
.login .err{color:var(--red);font-size:12px;margin-bottom:10px;display:none}
</style></head><body>
<div class="login">
<h2>团队AI Coding监控</h2>
<div class="err" id="err">密码错误</div>
<input type="password" id="pw" placeholder="请输入密码" autofocus>
<button onclick="doLogin()">登录</button>
</div>
<script>
document.getElementById("pw").addEventListener("keydown",e=>{if(e.key==="Enter")doLogin()});
async function doLogin(){const pw=document.getElementById("pw").value;const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})});if(r.ok){window.location.reload()}else{document.getElementById("err").style.display="block"}}
<\/script></body></html>`;
}

// ─── Personal Usage Page HTML ─────────────────────────────────────────────────
function personalUsageLandingHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>我的用量</title><style>
:root{--bg:#0a0a0a;--card:#141414;--border:#2a2a2a;--text:#e5e5e5;--dim:#999;--accent:#7c6ef0}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
.box{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:32px;width:400px}
h2{font-size:18px;margin-bottom:16px;text-align:center}
input{width:100%;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;font-family:monospace;outline:none;margin-bottom:12px}
input:focus{border-color:var(--accent)}
button{width:100%;padding:10px;background:var(--accent);color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer}
button:hover{opacity:.9}
.note{font-size:11px;color:var(--dim);text-align:center;margin-top:12px}
</style></head><body>
<div class="box"><h2>我的用量</h2>
<input type="text" id="key" placeholder="输入你的虚拟Key (jx-...)" autofocus>
<button onclick="go()">查看</button>
<div class="note">也可以直接访问 /usage/你的虚拟Key</div>
</div>
<script>
document.getElementById('key').addEventListener('keydown',e=>{if(e.key==='Enter')go()});
function go(){const k=document.getElementById('key').value.trim();if(k)location.href='/my-usage?key='+encodeURIComponent(k)}
</script></body></html>`;
}

function personalUsageHtml(virtualKey) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>我的用量 - 团队AI Coding监控</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
:root{--bg:#0a0a0a;--card:#141414;--border:#2a2a2a;--text:#e5e5e5;--dim:#999;--accent:#7c6ef0;--blue:#5ba3f5;--green:#34d399;--orange:#fbbf24;--red:#f87171}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);padding:20px 24px}
h1{font-size:18px;margin-bottom:4px}.meta{font-size:12px;color:var(--dim);margin-bottom:20px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 16px}
.card .l{font-size:12px;color:var(--dim);margin-bottom:4px}.card .v{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.box{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:14px}
.box h3{font-size:12px;color:var(--dim);margin-bottom:10px}
.box canvas{max-height:220px}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:6px 12px;font-size:11px;color:var(--dim);border-bottom:1px solid var(--border)}
td{padding:6px 12px;font-size:13px;border-bottom:1px solid var(--border)}.n{text-align:right;font-variant-numeric:tabular-nums}
.progress{width:100%;height:8px;background:var(--border);border-radius:4px;overflow:hidden;margin-top:6px}
.progress-bar{height:100%;border-radius:4px;transition:width .3s}
</style></head><body>
<h1>我的用量统计</h1>
<div class="meta" id="meta">加载中...</div>
<div class="cards" id="cards"></div>
<div class="box"><h3>今日24小时趋势</h3><canvas id="hourChart"></canvas></div>
<div class="box"><h3>近7天趋势</h3><canvas id="trendChart"></canvas></div>
<div class="box"><h3>今日模型用量</h3><table id="modelTable"><thead><tr><th>模型</th><th class="n">请求数</th><th class="n">输入</th><th class="n">输出</th><th class="n">合计</th></tr></thead><tbody></tbody></table></div>
<script>
const VK='${escJs(virtualKey)}';
let D=null,C={h:null,t:null};
const fmtT=n=>n.toLocaleString("zh-CN");
const fmtTk=n=>{if(n>=1e6)return(n/1e6).toFixed(1)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return n.toString()};
async function load(){
  try{
    const r=await fetch('/api/my-usage',{headers:{'Authorization':'Bearer '+VK}});
    if(!r.ok){document.getElementById('meta').textContent='认证失败';return}
    D=await r.json();render();
  }catch(e){document.getElementById('meta').textContent='Error: '+e.message}
}
function render(){
  if(!D)return;
  const q=D.quota,t=D.today;
  const pct=q.limit>0?Math.min(100,Math.round(q.used/q.limit*100)):0;
  const color=pct>90?'var(--red)':pct>70?'var(--orange)':'var(--green)';
  document.getElementById('meta').innerHTML=D.username+' | 方案: '+D.profile+(q.limit>0?' | <span style="color:'+color+';font-weight:600">'+pct+'% 已用</span>'+(q.autoAdjusted?' <span style="font-size:10px;background:rgba(124,110,240,.15);color:var(--accent);padding:1px 6px;border-radius:3px">自动调整</span>':''):' | 无配额限制');
  document.getElementById('cards').innerHTML=
    '<div class="card"><div class="l">今日用量</div><div class="v" style="color:var(--accent)">'+fmtT(t.total)+'</div></div>'+
    '<div class="card"><div class="l">今日请求</div><div class="v" style="color:var(--blue)">'+fmtT(t.requests)+'</div></div>'+
    '<div class="card"><div class="l">今日输入</div><div class="v" style="color:var(--green)">'+fmtT(t.input)+'</div></div>'+
    '<div class="card"><div class="l">今日输出</div><div class="v" style="color:var(--orange)">'+fmtT(t.output)+'</div></div>'+
    (q.limit>0?'<div class="card"><div class="l">剩余额度</div><div class="v" style="color:'+color+'">'+fmtT(q.remaining)+'</div><div class="progress"><div class="progress-bar" style="width:'+pct+'%;background:'+color+'"></div></div></div>'+
    '<div class="card"><div class="l">每日限额</div><div class="v" style="color:var(--dim)">'+fmtT(q.limit)+'</div></div>':'');
  // Hourly chart
  const hrs=[];for(let i=0;i<24;i++)hrs.push(i.toString().padStart(2,"0")+":00");
  const hData=hrs.map((_,i)=>{const h=D.hourly[i.toString().padStart(2,"0")]||{};return{req:h.requests||0,tokens:(h.inputTokens||0)+(h.outputTokens||0)}});
  if(C.h)C.h.destroy();
  C.h=new Chart(document.getElementById("hourChart"),{type:"bar",data:{labels:hrs,datasets:[{label:"Token",data:hData.map(d=>d.tokens),backgroundColor:"#7c6ef0cc",borderRadius:3},{label:"请求数",data:hData.map(d=>d.req),backgroundColor:"#5ba3f5cc",borderRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:"#999",font:{size:10}}}},scales:{x:{ticks:{color:"#666",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{ticks:{color:"#666",callback:v=>fmtTk(v)},grid:{color:"#1a1a1a"}}}}});
  // Trend chart
  if(C.t)C.t.destroy();
  C.t=new Chart(document.getElementById("trendChart"),{type:"line",data:{labels:D.trend.map(d=>d.date.slice(5)),datasets:[{label:"输入",data:D.trend.map(d=>d.input),borderColor:"#34d399",backgroundColor:"rgba(52,211,153,.12)",fill:true,tension:.4,pointRadius:3,borderWidth:2},{label:"输出",data:D.trend.map(d=>d.output),borderColor:"#f87171",backgroundColor:"rgba(248,113,113,.12)",fill:true,tension:.4,pointRadius:3,borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:"#999",font:{size:10}}}},scales:{x:{ticks:{color:"#666"},grid:{display:false}},y:{ticks:{color:"#666",callback:v=>fmtTk(v)},grid:{color:"#1a1a1a"}}}}});
  // Model table
  const mt=document.querySelector("#modelTable tbody");
  const models=Object.entries(D.models||{}).sort((a,b)=>(b[1].inputTokens+b[1].outputTokens)-(a[1].inputTokens+a[1].outputTokens));
  if(!models.length){mt.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--dim)">暂无数据</td></tr>'}else{
    mt.innerHTML=models.map(([m,d])=>'<tr><td style="color:var(--blue)">'+m+'</td><td class="n">'+fmtT(d.requests)+'</td><td class="n">'+fmtT(d.inputTokens)+'</td><td class="n">'+fmtT(d.outputTokens)+'</td><td class="n" style="color:var(--accent);font-weight:600">'+fmtT(d.inputTokens+d.outputTokens)+'</td></tr>').join("");
  }
}
load();setInterval(load,30000);
<\/script></body></html>`;
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
function parseFormBody(body) {
  const params = new URLSearchParams(body);
  const data = {};
  for (const [k, v] of params) {
    // Support repeated keys as array (not needed for settings, but safe)
    if (k in data) {
      if (!Array.isArray(data[k])) data[k] = [data[k]];
      data[k].push(v);
    } else {
      data[k] = v;
    }
  }
  return data;
}

function applySettings(formData) {
  // Determine which profile is being edited (default to default profile)
  const editingSuffix = formData.profileSuffix || "";
  const editingRt = runtimes[editingSuffix] || rt;
  const editingProfileName = editingRt.profileName;

  // Validate upstream URL
  if (formData.upstream && formData.upstream !== editingRt.upstream) {
    if (!/^https?:\/\/[^\s]+/.test(formData.upstream)) throw new Error("Invalid upstream URL");
    editingRt.upstream = formData.upstream;
    editingRt.upstreamUrl = new URL(formData.upstream);
    editingRt.agent.destroy();
    editingRt.agent = createUpstreamAgent(editingRt.upstreamUrl);
    editingRt.breaker.reset();
    console.log(`[CONFIG] Upstream reloaded: ${editingRt.upstream}`);
  }

  // Update proxy settings with range validation (global)
  if (formData.timeout) gProxy.timeout = Math.max(10000, Math.min(600000, parseInt(formData.timeout, 10) || 180000));
  if (formData.streamTimeout) gProxy.streamTimeout = Math.max(60000, Math.min(1800000, parseInt(formData.streamTimeout, 10) || 600000));
  if (formData.maxRetries !== undefined) gProxy.maxRetries = Math.max(0, Math.min(10, parseInt(formData.maxRetries, 10) || 3));
  if (formData.retryDelay) gProxy.retryDelay = Math.max(100, Math.min(30000, parseInt(formData.retryDelay, 10) || 1000));
  if (formData.maxConcurrentPerUser) gProxy.maxConcurrentPerUser = Math.max(1, Math.min(50, parseInt(formData.maxConcurrentPerUser, 10) || 5));
  if (formData.rateLimitPerMinute) gProxy.rateLimitPerMinute = Math.max(1, Math.min(600, parseInt(formData.rateLimitPerMinute, 10) || 60));
  if (formData.circuitBreakerFailures) gProxy.circuitBreakerFailures = Math.max(1, Math.min(50, parseInt(formData.circuitBreakerFailures, 10) || 5));
  if (formData.circuitBreakerCooldown) gProxy.circuitBreakerCooldown = Math.max(1000, Math.min(300000, parseInt(formData.circuitBreakerCooldown, 10) || 30000));

  // Update profile quota
  if (formData.profileQuota !== undefined) {
    const ap = config.profiles[editingProfileName];
    if (ap) {
      const q = parseInt(formData.profileQuota, 10) || 0;
      ap.dailyTokenLimit = q > 0 ? q : null;
    }
  }

  // Update auto quota adjustment settings
  if (!config.autoQuotaAdjust) config.autoQuotaAdjust = {};
  config.autoQuotaAdjust.enabled = formData.autoQuotaEnabled === "on";
  if (formData.aqPeriod) config.autoQuotaAdjust.evaluationPeriodDays = Math.max(3, parseInt(formData.aqPeriod, 10) || 5);
  if (formData.aqHitThreshold) config.autoQuotaAdjust.hitThreshold = Math.min(1, Math.max(0.5, (parseInt(formData.aqHitThreshold, 10) || 90) / 100));
  if (formData.aqTriggerRate) config.autoQuotaAdjust.triggerRate = Math.min(1, Math.max(0.3, (parseInt(formData.aqTriggerRate, 10) || 90) / 100));
  if (formData.aqIncreaseFactor) config.autoQuotaAdjust.increaseFactor = 1 + (parseInt(formData.aqIncreaseFactor, 10) || 15) / 100;
  if (formData.aqSafetyFactor) config.autoQuotaAdjust.safetyFactor = (parseInt(formData.aqSafetyFactor, 10) || 130) / 100;
  if (formData.aqMaxIncrease) config.autoQuotaAdjust.maxIncreaseFactor = Math.max(1.1, parseFloat(formData.aqMaxIncrease) || 2.0);
  if (formData.aqMaxQuota) config.autoQuotaAdjust.maxAutoQuota = parseInt(formData.aqMaxQuota, 10) || 10000000;
  if (formData.aqCooldown) config.autoQuotaAdjust.cooldownDays = Math.max(1, parseInt(formData.aqCooldown, 10) || 3);
  store._lastQuotaEval = null; // Reset eval date so new config takes effect immediately

  // Update retryable status codes
  if (formData.retryableStatusCodes) {
    gProxy.retryableStatusCodes = formData.retryableStatusCodes
      .split(",")
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
  }

  // Update allowed models (mandatory — at least 1 model required)
  if (formData.allowedModels !== undefined) {
    const raw = formData.allowedModels.trim();
    if (!raw) throw new Error("至少需要设置 1 个允许模型");
    editingRt.allowedModels = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (editingRt.allowedModels.length === 0) throw new Error("至少需要设置 1 个允许模型");
  }

  // Update default model mappings (jx-* aliases)
  if (formData.defaultModels_sonnet) editingRt.defaultModels.sonnet = formData.defaultModels_sonnet.trim();
  if (formData.defaultModels_opus)   editingRt.defaultModels.opus   = formData.defaultModels_opus.trim();
  if (formData.defaultModels_haiku)  editingRt.defaultModels.haiku  = formData.defaultModels_haiku.trim();

  // Ensure defaultModels values are always in allowedModels
  for (const m of Object.values(editingRt.defaultModels)) {
    if (m && !editingRt.allowedModels.includes(m)) {
      editingRt.allowedModels.push(m);
    }
  }

  // Update circuit breaker thresholds for this profile
  editingRt.breaker.failureThreshold = gProxy.circuitBreakerFailures || 5;
  editingRt.breaker.cooldownMs = gProxy.circuitBreakerCooldown || 30000;

  // Update global users
  const newGlobalUsers = {};
  for (const [k, v] of Object.entries(formData)) {
    // Existing global users: gu_un_<vk>, gu_ex_<vk>, gu_dis_<vk>
    if (k.startsWith("gu_un_") && !k.startsWith("gu_un_new_")) {
      const vk = k.slice(6);
      newGlobalUsers[vk] = {
        username: v || vk.slice(0, 8),
        expiresAt: formData["gu_ex_" + vk] || null,
        disabled: formData["gu_dis_" + vk] === "on",
      };
    }
    // New global users: gu_new_<vk> (hidden input with vk value)
    if (k.startsWith("gu_new_") && v.trim()) {
      const vk = v.trim();
      newGlobalUsers[vk] = {
        username: formData["gu_un_new_" + vk] || vk.slice(0, 8),
        expiresAt: formData["gu_ex_new_" + vk] || null,
        disabled: formData["gu_dis_new_" + vk] === "on",
      };
    }
  }
  if (Object.keys(newGlobalUsers).length > 0) {
    editingRt.globalUsers = newGlobalUsers;
  }

  // Update profile users (key assignment + profile disable)
  const newProfileUsers = {};
  for (const [k, v] of Object.entries(formData)) {
    if (k.startsWith("pu_rk_")) {
      const vk = k.slice(6);
      const realKey = v.trim();
      if (!realKey) continue; // skip users without real key
      const quotaVal = parseInt(formData["pu_quota_" + vk], 10) || 0;
      newProfileUsers[vk] = {
        key: realKey,
        disabled: formData["pu_dis_" + vk] === "on",
        dailyTokenLimit: quotaVal > 0 ? quotaVal : null,
      };
    }
  }
  if (Object.keys(newProfileUsers).length > 0) {
    editingRt.users = newProfileUsers;
  }

  // Persist to config.json
  config.proxy = { ...gProxy };
  config.users = { ...editingRt.globalUsers };
  const ap = config.profiles[editingProfileName];
  if (ap) {
    ap.upstream = editingRt.upstream;
    ap.allowedModels = editingRt.allowedModels;
    ap.defaultModels = { ...editingRt.defaultModels };
    ap.users = { ...editingRt.users };
  }
  saveConfig(config);

  console.log(`[CONFIG] Settings saved to profile "${editingProfileName}"`);
}

const server = http.createServer((req, res) => {
  // Security headers for all responses
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
  if (isSecureRequest(req)) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
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
        } else {
          recordLoginFailure(ip);
          const remaining = checkLoginRate(ip).remaining;
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "wrong password", attemptsRemaining: remaining }));
          console.log(`[安全] IP ${ip} 登录失败，剩余尝试次数: ${remaining}`);
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
    return;
  }

  // Settings page (auth required)
  if (req.method === "GET" && req.url === "/settings") {
    if (!checkAuth(req)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(loginHtml());
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(settingsHtml());
    return;
  }

  // Settings API - get current settings
  if (req.method === "GET" && req.url === "/api/settings") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getPublicSettings()));
    return;
  }

  // Settings save (form POST from settings page)
  if (req.method === "POST" && req.url === "/api/settings-save") {
    if (!checkAuth(req)) {
      res.writeHead(401); res.end("Unauthorized");
      return;
    }
    readBody(req).then(buf => {
      try {
        const body = buf.toString();
        if (!checkCsrf(req, body)) {
          res.writeHead(403); res.end("CSRF validation failed");
          return;
        }
        const formData = parseFormBody(body);
        applySettings(formData);
        res.writeHead(302, { "Location": "/settings" });
        res.end();
      } catch (err) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(settingsHtml("保存失败: " + err.message));
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

  // Profile: save as new
  if (req.method === "POST" && req.url === "/api/profile/save") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { profile, upstream, allowedModels, defaultModels, suffix } = JSON.parse(buf.toString());
        const name = (profile || "").trim();
        if (!name) throw new Error("Profile name required");
        // Validate suffix
        const sfx = (suffix || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
        // Check for reserved suffixes
        if (sfx && RESERVED_SUFFIXES.has(sfx)) throw new Error(`后缀 "${sfx}" 是系统保留的，请使用其他名称`);
        // Check for suffix uniqueness
        for (const [pn, p] of Object.entries(config.profiles)) {
          if (pn !== name && (p.suffix || "") === sfx) throw new Error(`后缀 "${sfx}" 已被方案 "${pn}" 使用`);
        }
        config.profiles[name] = {
          upstream: upstream || rt.upstream,
          allowedModels: allowedModels ? allowedModels.split(",").map(s => s.trim()).filter(Boolean) : [...rt.allowedModels],
          defaultModels: defaultModels || { ...rt.defaultModels },
          users: {},
          suffix: sfx,
          isDefault: false,
        };
        reloadProfileRuntime(name);
        saveConfig(config);
        console.log(`[PROFILE] Created new profile "${name}" (suffix: ${JSON.stringify(sfx)})`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, profile: name, suffix: sfx }));
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
        delete config.profiles[profile];
        saveConfig(config);
        console.log(`[PROFILE] Deleted profile "${profile}"`);
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

  // Settings JSON API for programmatic updates
  if (req.method === "POST" && req.url === "/api/settings") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const updates = JSON.parse(Buffer.concat(chunks).toString());
        const formData = {};
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
        if (updates.defaultModels) {
          if (updates.defaultModels.sonnet) formData.defaultModels_sonnet = updates.defaultModels.sonnet;
          if (updates.defaultModels.opus)   formData.defaultModels_opus   = updates.defaultModels.opus;
          if (updates.defaultModels.haiku)  formData.defaultModels_haiku  = updates.defaultModels.haiku;
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
        applySettings(formData);
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
    } else {
      // Reset all
      for (const r of Object.values(runtimes)) r.breaker.reset();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }
    return;
  }

  // Dashboard page (auth required)
  if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard")) {
    if (!checkAuth(req)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(loginHtml());
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHtml());
    return;
  }

  // Protected API: stats (supports ?profile=<suffix> and ?profile=all)
  if (req.method === "GET" && req.url.startsWith("/api/stats")) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const url = new URL(req.url, `http://localhost`);
    const profileSuffix = url.searchParams.get("profile");
    let data;
    if (profileSuffix === "all") {
      // Aggregate all profiles
      const agg = getAggregatedStore();
      data = sanitizeStore(agg);
      data.profileView = "all";
    } else {
      const targetRt = runtimes[profileSuffix || ""];
      if (targetRt) {
        const s = getProfileStore(profileSuffix || "");
        data = sanitizeStore(s);
        data.profileView = targetRt.profileName;
        data.profileSuffix = profileSuffix || "";
        data.upstream = targetRt.upstream;
        data.profileQuota = getProfileQuota(profileSuffix);
        data.userQuotas = {};
        for (const k of Object.keys(targetRt.users)) {
          const q = getUserQuota(k, targetRt);
          if (q > 0) data.userQuotas[k.slice(0, 8) + "****"] = q;
        }
      } else {
        // Default: use default profile store
        data = sanitizeStore(store);
        data.profileView = runtimes[""] ? runtimes[""].profileName : "default";
        data.profileSuffix = "";
        data.upstream = rt.upstream;
        data.profileQuota = getProfileQuota("");
        data.userQuotas = {};
        for (const k of Object.keys(rt.users)) {
          const q = getUserQuota(k, rt);
          if (q > 0) data.userQuotas[k.slice(0, 8) + "****"] = q;
        }
      }
    }
    // Add profile list for dropdown
    data.profiles = listProfiles();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }

  // Clear errors
  if (req.method === "POST" && req.url === "/api/clear-errors") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    store.errors = [];
    saveStore();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
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
        delete rt.globalUsers[key];
        for (const pname of Object.keys(config.profiles)) {
          delete config.profiles[pname].users[key];
        }
        delete rt.users[key];
        config.users = { ...rt.globalUsers };
        saveConfig(config);
        console.log(`[USER] Deleted global user: ${key}`);
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

  // Save all global users
  if (req.method === "POST" && req.url === "/api/global-user/save") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { users, profileUsers, profileSuffix } = JSON.parse(buf.toString());
        if (!Array.isArray(users) || users.length === 0) throw new Error("No users provided");
        const newGlobalUsers = {};
        for (const u of users) {
          if (!u.key) continue;
          newGlobalUsers[u.key] = { username: u.username || u.key.slice(0, 8), expiresAt: u.expiresAt || null, disabled: !!u.disabled };
        }
        // Update global users in all runtimes
        for (const r of Object.values(runtimes)) {
          r.globalUsers = { ...newGlobalUsers };
        }
        config.users = { ...newGlobalUsers };
        // Determine which profile to update users for
        const targetSuffix = profileSuffix || "";
        const targetRt = runtimes[targetSuffix] || rt;
        const targetProfileName = targetRt.profileName;
        // Update profile users (real keys + profile disable)
        if (Array.isArray(profileUsers)) {
          const newPU = {};
          for (const pu of profileUsers) {
            if (!pu.key) continue;
            newPU[pu.key] = { key: pu.realKey || "", disabled: !!pu.disabled, dailyTokenLimit: pu.dailyTokenLimit || null };
          }
          const ap = config.profiles[targetProfileName];
          if (ap) {
            ap.users = newPU;
            targetRt.users = { ...newPU };
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
        console.log(`[USER] Saved ${Object.keys(newGlobalUsers).length} global users`);
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

  // Personal usage page
  if (req.method === "GET" && req.url.startsWith("/usage/")) {
    const vk = decodeURIComponent(req.url.slice(7).split("?")[0]);
    if (!vk || (!rt.users[vk] && !rt.globalUsers[vk])) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Key不存在</h1><p>请检查你的虚拟Key是否正确。</p>");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(personalUsageHtml(vk));
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/my-usage")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const vk = url.searchParams.get("key");
    if (!vk || (!rt.users[vk] && !rt.globalUsers[vk])) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(personalUsageLandingHtml());
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(personalUsageHtml(vk));
    return;
  }

  // Personal usage API (authenticated by API key, supports ?profile=<suffix>)
  if (req.method === "GET" && req.url.startsWith("/api/my-usage")) {
    const apiKey = getApiKey(req);
    const url = new URL(req.url, `http://localhost`);
    const profileSuffix = url.searchParams.get("profile") || "";
    // Check if user exists in ANY profile
    let found = false;
    for (const rt2 of Object.values(runtimes)) {
      const uk = resolveUserKey(apiKey, rt2);
      if (rt2.users[uk] || rt2.globalUsers[uk]) { found = true; break; }
    }
    if (!found) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "认证失败：请提供有效的虚拟Key (Authorization: Bearer jx-...)" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(getPersonalUsageData(apiKey, profileSuffix), null, 2));
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
      upstream: rt.upstream,
      circuitBreaker: rt.breaker.status(),
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
  console.log(`[团队AI Coding监控] Users: ${Object.values(rt.globalUsers).map(u => u.username || "").join(", ")}`);
});

// Server timeouts
const serverTimeout = Math.max(gProxy.streamTimeout, gProxy.timeout) + 60000;
server.timeout = serverTimeout;
server.requestTimeout = serverTimeout;
server.headersTimeout = 120000;
server.keepAliveTimeout = 65000;

process.on("SIGINT", () => { saveStore(); process.exit(0); });
process.on("SIGTERM", () => { saveStore(); process.exit(0); });
process.on("uncaughtException", (err) => {
  if (err.code === "EPIPE" || err.code === "ECONNRESET") {
    console.error(`[WARN] ${err.code} ignored, client disconnected`);
    return;
  }
  console.error("[FATAL] Uncaught exception:", err);
  saveStore();
  process.exit(1);
});
