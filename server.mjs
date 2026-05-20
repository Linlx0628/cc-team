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

function getActiveProfile() {
  const p = config.profiles[config.activeProfile];
  if (!p) {
    // Fallback: use first profile
    config.activeProfile = Object.keys(config.profiles)[0] || "default";
    if (!config.profiles[config.activeProfile]) {
      config.profiles[config.activeProfile] = { upstream: "https://open.bigmodel.cn/api/anthropic", allowedModels: null, users: {} };
    }
    return config.profiles[config.activeProfile];
  }
  return p;
}

function listProfiles() {
  return Object.keys(config.profiles).map(name => ({
    name,
    upstream: config.profiles[name].upstream,
    userCount: Object.keys(config.profiles[name].users || {}).length,
    isActive: name === config.activeProfile,
  }));
}

// Runtime mutable settings (hot-reloadable without restart)
const activeProfile = getActiveProfile();
const runtime = {
  upstream: activeProfile.upstream,
  upstreamUrl: new URL(activeProfile.upstream),
  proxy: { ...(config.proxy || {}) },
  users: { ...(activeProfile.users || {}) },
  globalUsers: { ...(config.users || {}) },
};
const rt = runtime;

// Default proxy settings
rt.proxy.timeout = rt.proxy.timeout || 180000;
rt.proxy.streamTimeout = rt.proxy.streamTimeout || 600000;
rt.proxy.maxRetries = rt.proxy.maxRetries || 3;
rt.proxy.retryDelay = rt.proxy.retryDelay || 1000;
rt.proxy.retryableStatusCodes = rt.proxy.retryableStatusCodes || [429, 502, 503, 504];
rt.proxy.maxConcurrentPerUser = rt.proxy.maxConcurrentPerUser || 5;
rt.proxy.rateLimitPerMinute = rt.proxy.rateLimitPerMinute || 60;
rt.allowedModels = activeProfile.allowedModels || [];
rt.defaultModels = activeProfile.defaultModels || { sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-5", haiku: "claude-haiku-4-5" };

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

const upstreamBreaker = new CircuitBreaker({
  failureThreshold: rt.proxy.circuitBreakerFailures || 5,
  cooldownMs: rt.proxy.circuitBreakerCooldown || 30000,
});

// ─── Keep-Alive Agent ─────────────────────────────────────────────────────────
function createAgent() {
  return rt.upstreamUrl.protocol === "https:"
    ? new https.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 30000, scheduling: "fifo" })
    : new http.Agent({ keepAlive: true, maxSockets: 50, maxFreeSockets: 10, timeout: 30000, scheduling: "fifo" });
}
let keepAliveAgent = createAgent();

function reloadAgent() {
  rt.upstreamUrl = new URL(rt.upstream);
  keepAliveAgent.destroy();
  keepAliveAgent = createAgent();
  upstreamBreaker.reset();
  console.log(`[CONFIG] Upstream reloaded: ${rt.upstream}`);
}

function switchProfile(profileName) {
  const profile = config.profiles[profileName];
  if (!profile) throw new Error(`Profile "${profileName}" not found`);
  config.activeProfile = profileName;
  rt.upstream = profile.upstream;
  rt.users = { ...(profile.users || {}) };
  rt.allowedModels = profile.allowedModels || [];
  rt.defaultModels = profile.defaultModels || { sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-5", haiku: "claude-haiku-4-5" };
  rt.globalUsers = { ...(config.users || {}) };
  reloadAgent();
  saveConfig(config);
  console.log(`[PROFILE] Switched to "${profileName}" — upstream: ${profile.upstream}, users: ${Object.keys(rt.users).length}`);
}

// ─── Concurrency & Rate Limit ────────────────────────────────────────────────
const userConcurrent = {};
const userRateBucket = {};

function checkConcurrency(key) {
  userConcurrent[key] = userConcurrent[key] || 0;
  return userConcurrent[key] < rt.proxy.maxConcurrentPerUser;
}

function checkRateLimit(key) {
  const now = Date.now();
  userRateBucket[key] = userRateBucket[key] || [];
  const windowMs = 60000;
  userRateBucket[key] = userRateBucket[key].filter(t => now - t < windowMs);
  return userRateBucket[key].length < rt.proxy.rateLimitPerMinute;
}

function recordRate(key) {
  userRateBucket[key] = userRateBucket[key] || [];
  userRateBucket[key].push(Date.now());
}

// ─── Auth & Sanitize ────────────────────────────────────────────────────────
const AUTH_COOKIE = "tm_token";
function hashPassword(pw) {
  return crypto.createHash("sha256").update(pw + "token-monitor-salt").digest("hex");
}
const AUTH_TOKEN = dashboardPassword ? hashPassword(dashboardPassword) : "";

function checkAuth(req) {
  if (!dashboardPassword) return true;
  const cookies = (req.headers.cookie || "").split(";").map(s => s.trim());
  return cookies.some(c => c === `${AUTH_COOKIE}=${AUTH_TOKEN}`);
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
let store = { users: {}, daily: {}, models: {}, hourly: {}, errors: [] };

function loadStore() {
  try {
    if (fs.existsSync(dataPath)) {
      const raw = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
      store = {
        users: raw.users || {},
        daily: raw.daily || {},
        models: raw.models || {},
        hourly: raw.hourly || {},
        errors: Array.isArray(raw.errors) ? raw.errors : [],
      };
    }
  } catch { store = { users: {}, daily: {}, models: {}, hourly: {}, errors: [] }; }
}

function saveStore() {
  try {
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
function getGlobalUser(apiKey) {
  const gu = rt.globalUsers[apiKey];
  if (gu) return gu;
  for (const ck of Object.keys(rt.globalUsers)) {
    if (apiKey.startsWith(ck) || ck.startsWith(apiKey)) return rt.globalUsers[ck];
  }
  return null;
}

function getUserConfig(apiKey) {
  const key = resolveUserKey(apiKey);
  const pu = rt.users[key]; // profile user: { key, disabled }
  const gu = getGlobalUser(apiKey); // global user: { username, expiresAt, disabled }
  const realKey = pu ? (typeof pu === "string" ? pu : (pu.key || key)) : key;
  const username = gu ? (gu.username || `未知`) : `未知(${key.slice(0, 8)})`;
  const expiresAt = gu ? (gu.expiresAt || null) : null;
  return { username, key: realKey, expiresAt };
}

function resolveUserKey(apiKey) {
  if (rt.users[apiKey]) return apiKey;
  for (const ck of Object.keys(rt.users)) {
    if (apiKey.startsWith(ck) || ck.startsWith(apiKey)) return ck;
  }
  return apiKey.slice(0, 12);
}

function getUserName(apiKey) {
  const gu = getGlobalUser(apiKey);
  return gu ? (gu.username || `未知`) : `未知(${apiKey.slice(0, 8)})`;
}

function getRealKey(apiKey) {
  const key = resolveUserKey(apiKey);
  const pu = rt.users[key];
  if (!pu) return apiKey;
  if (typeof pu === "string") return pu;
  return pu.key || apiKey;
}

function checkModelAllowed(model) {
  if (!model || model === "unknown") return true;
  const allowed = rt.allowedModels;
  if (!allowed || allowed.length === 0) return true;
  if (allowed.includes("*")) return true;
  return allowed.includes(model);
}

function generateVirtualKey() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let code;
  do {
    code = "jx-";
    for (let i = 0; i < 24; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rt.globalUsers[code] || rt.users[code]);
  return code;
}

function checkKeyExpired(apiKey) {
  const gu = getGlobalUser(apiKey);
  if (!gu || !gu.expiresAt) return false;
  return new Date(gu.expiresAt).getTime() < Date.now();
}

function checkUserDisabled(apiKey) {
  const key = resolveUserKey(apiKey);
  // Global disable
  const gu = getGlobalUser(apiKey);
  if (gu && gu.disabled) return true;
  // Profile disable
  const pu = rt.users[key];
  if (pu && typeof pu === "object" && pu.disabled) return true;
  return false;
}

function resolveModel(model) {
  if (!model) return model;
  const alias = model.toLowerCase();
  const dm = rt.defaultModels || {};
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

function recordUsage(apiKey, usage, model) {
  const key = resolveUserKey(apiKey);
  const today = cnDate();
  const hour = cnHour();
  const inp = usage.input_tokens || usage.prompt_tokens || 0;
  const out = usage.output_tokens || usage.completion_tokens || 0;
  const cacheC = usage.cache_creation_input_tokens || 0;
  const cacheR = usage.cache_read_input_tokens || 0;
  const m = model || "unknown";

  if (!store.users[key]) store.users[key] = { name: getUserName(apiKey), totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, lastActive: null, cacheCreationTokens: 0, cacheReadTokens: 0 };
  const u = store.users[key];
  u.totalInputTokens += inp;
  u.totalOutputTokens += out;
  u.totalRequests += 1;
  u.cacheCreationTokens = (u.cacheCreationTokens || 0) + cacheC;
  u.cacheReadTokens = (u.cacheReadTokens || 0) + cacheR;
  u.lastActive = new Date().toISOString();

  if (!store.daily[today]) store.daily[today] = {};
  if (!store.daily[today][key]) store.daily[today][key] = { inputTokens: 0, outputTokens: 0, requests: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  store.daily[today][key].inputTokens += inp;
  store.daily[today][key].outputTokens += out;
  store.daily[today][key].requests += 1;
  store.daily[today][key].cacheCreationTokens = (store.daily[today][key].cacheCreationTokens || 0) + cacheC;
  store.daily[today][key].cacheReadTokens = (store.daily[today][key].cacheReadTokens || 0) + cacheR;

  if (!store.models[m]) store.models[m] = { tokens: 0, requests: 0 };
  store.models[m].tokens += inp + out;
  store.models[m].requests += 1;

  if (!store.hourly[today]) store.hourly[today] = {};
  if (!store.hourly[today][hour]) store.hourly[today][hour] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  store.hourly[today][hour].requests += 1;
  store.hourly[today][hour].inputTokens += inp;
  store.hourly[today][hour].outputTokens += out;
  store.hourly[today][hour].cacheCreationTokens = (store.hourly[today][hour].cacheCreationTokens || 0) + cacheC;
  store.hourly[today][hour].cacheReadTokens = (store.hourly[today][hour].cacheReadTokens || 0) + cacheR;
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

function sendUpstream(body, reqUrl, reqMethod, reqHeaders, timeout) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: rt.upstreamUrl.hostname,
      port: rt.upstreamUrl.port || (rt.upstreamUrl.protocol === "https:" ? 443 : 80),
      path: rt.upstreamUrl.pathname.replace(/\/$/, "") + reqUrl,
      method: reqMethod,
      headers: reqHeaders,
      agent: keepAliveAgent,
    };

    const transport = rt.upstreamUrl.protocol === "https:" ? https : http;
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
  const apiKey = getApiKey(req);

  // Reject non-API requests (browser favicon, Chrome DevTools, etc.)
  if (apiKey === "unknown") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const userKey = resolveUserKey(apiKey);
  const chunks = [];

  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    let body = Buffer.concat(chunks);
    let reqModel = "unknown";
    try {
      const parsed = JSON.parse(body.toString());
      reqModel = parsed.model || "unknown";
      const resolved = resolveModel(reqModel);
      if (resolved !== reqModel) {
        parsed.model = resolved;
        body = Buffer.from(JSON.stringify(parsed));
        console.log(`[别名] ${getUserName(apiKey)} ${reqModel} → ${resolved}`);
        reqModel = resolved;
      }
    } catch {}

    // Model access restriction
    if (!checkModelAllowed(reqModel)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Model "${reqModel}" is not allowed. Use jx-sonnet/jx-opus/jx-haiku or a model from the allowed list.` }));
      console.log(`[拦截] ${getUserName(apiKey)} model=${reqModel} 被拒绝`);
      return;
    }

    // Reject unknown API keys (not in configured user list)
    if (!rt.users[userKey] && !rt.globalUsers[userKey]) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown API key. Please use your assigned virtual key (jx-*)." }));
      console.log(`[拦截] 未知key=${apiKey.slice(0, 12)} model=${reqModel} 拒绝访问`);
      return;
    }

    // Circuit breaker check
    if (!upstreamBreaker.allowRequest()) {
      const remaining = Math.ceil(upstreamBreaker.status().cooldownRemaining / 1000);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Upstream temporarily unavailable. Circuit open, retry in ${remaining}s.` }));
      recordError(apiKey, 503, "Circuit breaker open", req.url, reqModel);
      return;
    }

    // Concurrency check
    if (!checkConcurrency(userKey)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many concurrent requests. Please try again later." }));
      return;
    }
    // Rate limit check
    if (!checkRateLimit(userKey)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Rate limit exceeded. Please slow down." }));
      return;
    }

    userConcurrent[userKey] = (userConcurrent[userKey] || 0) + 1;
    recordRate(userKey);

    // User disabled check (global or profile-level)
    if (checkUserDisabled(apiKey)) {
      userConcurrent[userKey] = Math.max(0, (userConcurrent[userKey] || 1) - 1);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "User is disabled." }));
      console.log(`[禁用] ${getUserName(apiKey)} 用户已禁用`);
      return;
    }

    // Key expiration check
    if (checkKeyExpired(apiKey)) {
      userConcurrent[userKey] = Math.max(0, (userConcurrent[userKey] || 1) - 1);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "API key has expired. Please contact your administrator." }));
      console.log(`[过期] ${getUserName(apiKey)} key已过期`);
      return;
    }

    try {
      const realKey = getRealKey(apiKey);
      const reqHeaders = { ...req.headers, host: rt.upstreamUrl.host, "content-length": body.length };
      // Replace virtual key with real upstream key
      if (realKey !== apiKey) {
        reqHeaders["authorization"] = `Bearer ${realKey}`;
        console.log(`[映射] ${getUserName(apiKey)} 虚拟key=${apiKey.slice(0,12)}... → 真实key=${realKey.slice(0,12)}... model=${reqModel}`);
      }
      delete reqHeaders["connection"];
      delete reqHeaders["transfer-encoding"];
      delete reqHeaders["accept-encoding"];

      const isStreamRequest = (req.headers["accept"] || "").includes("text/event-stream") ||
        (function() { try { return JSON.parse(body.toString()).stream; } catch { return false; } })();

      const timeout = isStreamRequest ? rt.proxy.streamTimeout : rt.proxy.timeout;

      if (isStreamRequest) {
        await handleStreamingProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout);
      } else {
        await handleJsonProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout);
      }
    } catch (err) {
      const status = err.isTimeout ? 504 : 502;
      const label = err.isTimeout ? "Gateway Timeout" : "Bad Gateway";
      recordError(apiKey, status, `${label}: ${err.message}`, req.url, reqModel);
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Proxy ${label}: ${err.message}` }));
      }
    } finally {
      userConcurrent[userKey] = Math.max(0, (userConcurrent[userKey] || 1) - 1);
    }
  });
}

async function handleJsonProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout) {
  let lastError = null;

  for (let attempt = 0; attempt <= rt.proxy.maxRetries; attempt++) {
    try {
      const upRes = await sendUpstream(body, req.url, req.method, reqHeaders, timeout);
      const text = upRes.body.toString();

      // Record success to circuit breaker for non-5xx responses
      if (upRes.statusCode < 500) {
        upstreamBreaker.recordSuccess();
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
      if (rt.proxy.retryableStatusCodes.includes(upRes.statusCode) && attempt < rt.proxy.maxRetries) {
        const baseDelay = Math.min(rt.proxy.retryDelay * Math.pow(2, attempt), 10000);
        const delay = Math.round(jitter(baseDelay));
        console.log(`[重试] ${getUserName(apiKey)} ${upRes.statusCode} model=${reqModel} 第${attempt + 1}/${rt.proxy.maxRetries}次 ${delay}ms后重试`);
        recordError(apiKey, upRes.statusCode, `Retryable error (attempt ${attempt + 1}/${rt.proxy.maxRetries})`, req.url, reqModel);
        await sleep(delay);
        continue;
      }

      // Parse and record
      try {
        const json = JSON.parse(text);
        if (upRes.statusCode >= 400) {
          recordError(apiKey, upRes.statusCode, json.error?.message || json.message || text.slice(0, 200), req.url, reqModel);
          if (upRes.statusCode >= 500) upstreamBreaker.recordFailure();
        } else {
          // Try multiple possible usage field names
          const usage = json.usage || json.token_usage || json.usage_info;
          if (usage) {
            recordUsage(apiKey, usage, json.model);
            const modelName = json.model || reqModel;
            console.log(`[Token] ${getUserName(apiKey)} model=${modelName} 输入=${usage.input_tokens || usage.prompt_tokens || 0} 输出=${usage.output_tokens || usage.completion_tokens || 0} 缓存写=${usage.cache_creation_input_tokens || 0} 缓存读=${usage.cache_read_input_tokens || 0}`);
          } else {
            console.log(`[响应] ${getUserName(apiKey)} 200 OK 但无usage字段 model=${reqModel} body[0:300]=${text.slice(0, 300).replace(/\n/g, "\\n")}`);
          }
        }
      } catch {
        if (upRes.statusCode >= 400) {
          recordError(apiKey, upRes.statusCode, text.slice(0, 200), req.url, reqModel);
          if (upRes.statusCode >= 500) upstreamBreaker.recordFailure();
        } else {
          console.log(`[响应] ${getUserName(apiKey)} ${upRes.statusCode} 非JSON响应 body[0:300]=${text.slice(0, 300).replace(/\n/g, "\\n")}`);
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
      upstreamBreaker.recordFailure();
      if (attempt < rt.proxy.maxRetries) {
        const baseDelay = Math.min(rt.proxy.retryDelay * Math.pow(2, attempt), 10000);
        const delay = Math.round(jitter(baseDelay));
        console.log(`[重试] ${getUserName(apiKey)} 网络错误 model=${reqModel} 第${attempt + 1}/${rt.proxy.maxRetries}次 ${delay}ms后重试`);
        await sleep(delay);
      }
    }
  }

  // All retries exhausted
  const finalStatus = lastError?.isTimeout ? 504 : 502;
  const finalLabel = lastError?.isTimeout ? "Gateway Timeout" : "Bad Gateway";
  recordError(apiKey, finalStatus, `${finalLabel} after ${rt.proxy.maxRetries} retries: ${lastError?.message}`, req.url, reqModel);
  if (!res.headersSent) {
    res.writeHead(finalStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Proxy ${finalLabel} after ${rt.proxy.maxRetries} retries: ${lastError?.message}` }));
  }
}

async function handleStreamingProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout) {
  const opts = {
    hostname: rt.upstreamUrl.hostname,
    port: rt.upstreamUrl.port || (rt.upstreamUrl.protocol === "https:" ? 443 : 80),
    path: rt.upstreamUrl.pathname.replace(/\/$/, "") + req.url,
    method: req.method,
    headers: reqHeaders,
    agent: keepAliveAgent,
  };

  const transport = rt.upstreamUrl.protocol === "https:" ? https : http;

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
          if (upRes.statusCode >= 500) upstreamBreaker.recordFailure();
          else if (upRes.statusCode < 500) upstreamBreaker.recordSuccess();
          if (!clientGone) res.end();
          safeResolve();
        });
        return;
      }

      upstreamBreaker.recordSuccess();

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
          // Try data: prefix first, then event: line, then raw JSON
          // Handle both "data: " and "data:" (Kimi etc. omit the space)
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
            if (sseDataLines <= 3) console.log(`[SSE] ${getUserName(apiKey)} 第${sseDataLines}条 类型=${d.type} 字段=${Object.keys(d).join(",")}`);
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
          recordUsage(apiKey, usage, model);
          console.log(`[Token] ${getUserName(apiKey)} model=${model} 输入=${usage.input_tokens} 输出=${usage.output_tokens} 缓存写=${usage.cache_creation_input_tokens || 0} 缓存读=${usage.cache_read_input_tokens || 0}`);
        } else {
          console.log(`[响应] ${getUserName(apiKey)} 流结束 无usage数据 model=${model} sse行数=${sseDataLines} 原始数据[0:200]=${rawSample.slice(0, 200).replace(/\n/g, "\\n")}`);
        }
        if (!clientGone) res.end();
        safeResolve();
      });
    });

    upReq.setTimeout(timeout, () => {
      upReq.destroy(new Error(`Upstream stream timeout (${timeout}ms)`));
    });

    upReq.on("error", (err) => {
      upstreamBreaker.recordFailure();
      const isTimeout = err.message.includes("timeout");
      const status = isTimeout ? 504 : 502;
      const label = isTimeout ? "Gateway Timeout" : "Bad Gateway";
      recordError(apiKey, status, `${label}: ${err.message}`, req.url, reqModel);
      if (!res.headersSent && !clientGone) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Proxy ${label}: ${err.message}` }));
      }
      safeResolve();
    });

    upReq.write(body);
    upReq.end();
  });
}

// ─── Settings API Helpers ─────────────────────────────────────────────────────
function getPublicSettings() {
  const safeProfileUsers = {};
  for (const [k, v] of Object.entries(rt.users)) {
    const isObj = typeof v === "object" && v !== null;
    safeProfileUsers[k] = {
      key: isObj ? ((v.key || "").slice(0, 12) + "****") : (typeof v === "string" ? v.slice(0, 12) + "****" : ""),
      disabled: isObj ? !!v.disabled : false,
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
    proxy: { ...rt.proxy },
    allowedModels: rt.allowedModels,
    defaultModels: { ...rt.defaultModels },
    profileUsers: safeProfileUsers,
    globalUsers: safeGlobalUsers,
    activeProfile: config.activeProfile,
    profiles: listProfiles(),
    circuitBreaker: upstreamBreaker.status(),
    port: port,
    hasPassword: !!dashboardPassword,
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
<td><code style="font-size:11px;color:var(--accent);user-select:all;cursor:pointer" title="点击复制" onclick="navigator.clipboard.writeText('${k}')">${k}</code></td>
<td><input type="text" name="gu_un_${k}" value="${username}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px" placeholder="用户名"></td>
<td><input type="datetime-local" name="gu_ex_${k}" value="${expiresAt}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:3px 6px;border-radius:4px;font-size:11px;font-family:monospace;color-scheme:dark" title="留空=永不过期"></td>
<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer"><input type="checkbox" name="gu_dis_${k}" ${disabled ? "checked" : ""} style="width:auto;accent-color:var(--red)"><span style="font-size:11px;color:${disabled ? "var(--red)" : "var(--dim)"}">${disabled ? "已禁用" : "正常"}</span></label></td>
<td><button type="button" onclick="deleteGlobalUser('${k}')" style="background:rgba(248,113,113,.15);color:var(--red);border:none;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px">删除</button></td></tr>`;
  }).join("");

  // Profile user rows (key assignment)
  const profileUserRows = Object.entries(rt.globalUsers).map(([k, v]) => {
    const isObj = typeof v === "object" && v !== null;
    const username = isObj ? (v.username || "") : (typeof v === "string" ? v : "");
    const globalDisabled = isObj ? !!v.disabled : false;
    const pu = rt.users[k];
    const realKey = pu ? (typeof pu === "string" ? pu : (pu.key || "")) : "";
    const profileDisabled = pu ? (typeof pu === "object" ? !!pu.disabled : false) : false;
    const rowStyle = globalDisabled ? "opacity:0.4" : "";
    return `<tr style="${rowStyle}">
<td><code style="font-size:11px;color:var(--accent)">${k}</code></td>
<td>${username}</td>
<td><input type="text" name="pu_rk_${k}" value="${realKey}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px;font-family:monospace" placeholder="真实Key (必填)"></td>
<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer"><input type="checkbox" name="pu_dis_${k}" ${profileDisabled ? "checked" : ""} style="width:auto;accent-color:var(--orange)"><span style="font-size:11px;color:${profileDisabled ? "var(--orange)" : "var(--dim)"}">${profileDisabled ? "已禁用" : "正常"}</span></label></td></tr>`;
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
    const isActive = p.isActive;
    const host = p.upstream.replace(/^https?:\/\//, "").replace(/\/.*/, "");
    return `<div class="pl-item${isActive ? " active" : ""}" id="pl-${p.name}">
<div class="pl-name">${p.name}</div>
<div class="pl-host">${host}</div>
<div class="pl-users">${p.userCount}位用户</div>
<div class="pl-actions">
  ${!isActive ? '<button class="pl-activate" onclick="switchToProfile(\'' + p.name + '\')">✓ 启用</button>' : '<span class="pl-badge">当前</span>'}
  ${!isActive ? '<button class="pl-delete" onclick="deleteProfile(\'' + p.name + '\')">×</button>' : ''}
</div></div>`;
  }).join("")}</div>
<div class="sidebar-ft" style="display:flex;gap:6px"><button class="btn btn-outline btn-sm" onclick="openUserModal()" style="flex:1">用户管理</button><button class="btn btn-outline btn-sm" onclick="addProfile()" style="flex:1">+ 新增方案</button></div>
</div>
<div class="main">
${errDiv}
<form method="post" action="/api/settings-save" id="settingsForm">

<h2>上游代理 <span class="status ${s.circuitBreaker.state === 'CLOSED' ? 'status-ok' : s.circuitBreaker.state === 'HALF_OPEN' ? 'status-warn' : 'status-err'}">${s.circuitBreaker.state === 'CLOSED' ? '正常' : s.circuitBreaker.state === 'HALF_OPEN' ? '探测中' : '熔断中'}</span></h2>
<div class="section">
<label>上游 API 地址</label>
<input type="text" name="upstream" value="${s.upstream}" placeholder="https://open.bigmodel.cn/api/anthropic">
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
<thead><tr><th>虚拟 Key</th><th>用户名称</th><th>真实 Key</th><th style="width:80px">方案禁用</th></tr></thead>
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
function openUserModal(){document.getElementById('userModal').classList.add('open')}
function closeUserModal(){document.getElementById('userModal').classList.remove('open')}
document.getElementById('userModal').addEventListener('click',function(e){if(e.target===this)closeUserModal()});
async function switchToProfile(n){
  if(!confirm('切换到方案 "'+n+'"？未保存的修改将丢失。'))return;
  const r=await fetch('/api/profile/switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:n})});
  if(r.ok)location.reload();else{const e=await r.json();alert('切换失败: '+e.error)}
}
async function addProfile(){
  const name=prompt('请输入新方案名称');
  if(!name)return;
  const fm=document.forms.settingsForm;
  const r=await fetch('/api/profile/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    profile:name,upstream:fm.upstream.value,allowedModels:fm.allowedModels.value,
    defaultModels:{sonnet:fm.defaultModels_sonnet.value,opus:fm.defaultModels_opus.value,haiku:fm.defaultModels_haiku.value}
  })});
  if(r.ok)location.reload();else{const e=await r.json();alert('创建失败: '+e.error)}
}
async function deleteProfile(n){
  if(!confirm('确定删除方案 "'+n+'"？'))return;
  const r=await fetch('/api/profile/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:n})});
  if(r.ok)location.reload();else{const e=await r.json();alert('删除失败: '+e.error)}
}
async function deleteGlobalUser(k){
  if(!confirm('确定删除用户？该用户将从所有方案中移除。'))return;
  const r=await fetch('/api/global-user/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:k})});
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
    profileUsers.push({key:vk,realKey:rkInput?rkInput.value.trim():'',disabled:disInput?disInput.checked:false});
  });
  const r=await fetch('/api/global-user/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({users,profileUsers})});
  if(r.ok){alert('保存成功');location.reload()}else{const e=await r.json();alert('保存失败: '+e.error)}
}
function genVK(){const c="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";let k="jx-";for(let i=0;i<24;i++)k+=c[Math.floor(Math.random()*c.length)];return k}
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
<h1>团队AI Coding监控 <span style="float:right;font-size:12px;display:flex;gap:8px;align-items:center"><a href="/settings" style="color:var(--dim);text-decoration:none;font-size:12px;padding:4px 10px;border:1px solid var(--border);border-radius:4px">设置</a><button id="autoRefreshBtn" style="font-size:12px;background:rgba(52,211,153,.15);color:var(--green);border:none;padding:4px 12px;border-radius:4px;cursor:pointer">自动刷新: 开</button><button onclick="fetch('/api/logout',{method:'POST'}).then(()=>location.reload())" style="font-size:12px;background:rgba(255,255,255,.06);color:var(--dim);border:none;padding:4px 12px;border-radius:4px;cursor:pointer">退出</button></span></h1>
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
<tr><th>用户</th><th>状态</th><th class="n">请求数</th><th class="n">输入</th><th class="n">输出</th><th class="n">缓存写入</th><th class="n">缓存命中</th><th class="n">合计</th><th>最后活跃</th></tr>
</thead><tbody></tbody></table></div>
<div class="sec sec-collapsible" id="detailSec"><h3 onclick="toggleSec('detailSec')"><span class="sec-toggle" id="detailSecIcon">▶</span>明细记录<span class="sec-hint" id="detailHint"></span></h3><div class="sec-body" id="detailSecBody"><table id="dTable"><thead>
<tr><th>时间</th><th>用户</th><th class="n">请求数</th><th class="n">输入</th><th class="n">输出</th><th class="n">缓存写入</th><th class="n">缓存命中</th><th class="n">合计</th></tr>
</thead><tbody></tbody></table></div></div>
<div class="sec sec-collapsible" id="errorSec"><h3 onclick="toggleSec('errorSec')"><span class="sec-toggle" id="errorSecIcon">▶</span>错误记录<span id="errorCount" style="font-size:11px;color:var(--red);font-weight:400;margin-left:4px"></span><span class="sec-hint" id="errorHint" style="margin-left:auto"></span><button id="clearErrors" onclick="event.stopPropagation()" style="font-size:11px;background:rgba(248,113,113,.15);color:var(--red);border:none;padding:2px 10px;border-radius:4px;cursor:pointer;margin-left:8px">清除</button></h3><div class="sec-body" id="errorSecBody"><table id="eTable"><thead>
<tr><th>时间</th><th>用户</th><th class="n">状态码</th><th>模型</th><th>路径</th><th>错误信息</th></tr>
</thead><tbody></tbody></table>
<div id="errPages" style="padding:8px 0;text-align:right"></div></div></div>
<script>
let D=null,P="day",C={t:null,p:null,m:null,h:null},errPage=1,autoRefresh=true,refreshTimer=null;
const ERR_PAGE_SIZE=20;
const COL=["#7c6ef0","#5ba3f5","#34d399","#fbbf24","#f87171","#f472b6","#a78bfa","#38bdf8"];
const fmtT=n=>n.toLocaleString("zh-CN");
const fmtTk=n=>{if(n>=1e6)return(n/1e6).toFixed(1)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return n.toString()};
function fmtBJ(iso){if(!iso)return"-";const d=new Date(iso);const utc=d.getTime()+d.getTimezoneOffset()*60000;return new Date(utc+8*3600000).toLocaleString("zh-CN")};
function ago(iso){if(!iso)return"-";const d=Date.now()-new Date(iso).getTime();const m=Math.floor(d/6e4);if(m<1)return"刚刚";if(m<60)return m+"分钟前";const h=Math.floor(m/60);if(h<24)return h+"小时前";return Math.floor(h/24)+"天前"}
function wk(s){const d=new Date(s),day=d.getDay()||7,mon=new Date(d);mon.setDate(d.getDate()-day+1);return mon.toISOString().slice(0,10)}
function grp(daily,p){const g={};for(const[day,ud]of Object.entries(daily)){const k=p==="week"?wk(day):p==="month"?day.slice(0,7):p==="year"?day.slice(0,4):day;if(!g[k])g[k]={};for(const[u,s]of Object.entries(ud)){if(!g[k][u])g[k][u]={inputTokens:0,outputTokens:0,requests:0};g[k][u].inputTokens+=s.inputTokens;g[k][u].outputTokens+=s.outputTokens;g[k][u].requests+=s.requests}}return g}
function lbl(p,k){if(p==="day")return k.slice(5);if(p==="week")return k.slice(5)+" 周";if(p==="month")return k;return k+"年"}
function c(l,v,c){return'<div class="card"><div class="l">'+l+'</div><div class="v" style="color:'+c+'">'+v+'</div></div>'}
function render(){
  if(!D)return;
  const us=Object.values(D.users),ti=us.reduce((s,u)=>s+u.totalInputTokens,0),to=us.reduce((s,u)=>s+u.totalOutputTokens,0),tr=us.reduce((s,u)=>s+u.totalRequests,0);
  const td=new Date(Date.now()+8*36e5).toISOString().slice(0,10),tdd=(D.daily||{})[td]||{};
  const tIn=Object.values(tdd).reduce((s,d)=>s+d.inputTokens,0),tOut=Object.values(tdd).reduce((s,d)=>s+d.outputTokens,0),tR=Object.values(tdd).reduce((s,d)=>s+d.requests,0);
  document.getElementById("cards").innerHTML=c("今日用量",fmtT(tIn+tOut),"var(--accent)")+c("今日请求",fmtT(tR),"var(--blue)")+c("总用量",fmtT(ti+to),"var(--green)")+c("总请求",fmtT(tr),"var(--orange)")+c("今日错误",fmtT((Array.isArray(D.errors)?D.errors:[]).filter(e=>e.time&&e.time.startsWith(td)).length),"var(--red)");
  document.getElementById("meta").innerHTML='<span style="color:var(--accent);font-weight:600">方案: '+(D.activeProfile||"-")+'</span> &nbsp;|&nbsp; 上游: '+(D.upstream||"-").replace("https://","").replace("http://","")+' &nbsp;|&nbsp; 更新于 '+(function(){const d=new Date();const utc=d.getTime()+d.getTimezoneOffset()*60000;return new Date(utc+8*3600000).toLocaleTimeString("zh-CN")})()+" (北京时间) | 每30秒刷新";

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
  if(!ul.length){ut.innerHTML='<tr><td colspan="9" class="empty">暂无数据</td></tr>'}else{ut.innerHTML=ul.map(([,u])=>{const on=u.lastActive&&Date.now()-new Date(u.lastActive).getTime()<36e5;return'<tr><td>'+u.name+'</td><td><span style="padding:2px 8px;border-radius:4px;font-size:11px;background:'+(on?'rgba(52,211,153,.15)':'rgba(255,255,255,.05)')+';color:'+(on?'var(--green)':'var(--dim)')+'">'+(on?'在线':'离线')+'</span></td><td class="n">'+fmtT(u.totalRequests)+'</td><td class="n">'+fmtT(u.totalInputTokens)+'</td><td class="n">'+fmtT(u.totalOutputTokens)+'</td><td class="n">'+fmtT(u.cacheCreationTokens || 0)+'</td><td class="n">'+fmtT(u.cacheReadTokens || 0)+'</td><td class="n hl">'+fmtT(u.totalInputTokens+u.totalOutputTokens)+'</td><td>'+ago(u.lastActive)+'</td></tr>'}).join("")}

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
async function load(){try{const r=await fetch("/api/stats");D=await r.json();render()}catch(e){document.getElementById("meta").textContent="Error: "+e.message}}
function toggleSec(id){const body=document.getElementById(id+"Body");const icon=document.getElementById(id+"Icon");const open=body.classList.toggle("open");icon.classList.toggle("open",open)}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("on"));b.classList.add("on");P=b.dataset.p;render()}));
document.getElementById("clearErrors").addEventListener("click",async()=>{if(confirm("确定清除所有错误记录？")){await fetch("/api/clear-errors",{method:"POST"});errPage=1;load()}});
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
  // Update upstream
  if (formData.upstream && formData.upstream !== rt.upstream) {
    rt.upstream = formData.upstream;
    reloadAgent();
  }

  // Update proxy settings
  if (formData.timeout) rt.proxy.timeout = parseInt(formData.timeout, 10) || 180000;
  if (formData.streamTimeout) rt.proxy.streamTimeout = parseInt(formData.streamTimeout, 10) || 600000;
  if (formData.maxRetries !== undefined) rt.proxy.maxRetries = parseInt(formData.maxRetries, 10) || 3;
  if (formData.retryDelay) rt.proxy.retryDelay = parseInt(formData.retryDelay, 10) || 1000;
  if (formData.maxConcurrentPerUser) rt.proxy.maxConcurrentPerUser = parseInt(formData.maxConcurrentPerUser, 10) || 5;
  if (formData.rateLimitPerMinute) rt.proxy.rateLimitPerMinute = parseInt(formData.rateLimitPerMinute, 10) || 60;
  if (formData.circuitBreakerFailures) rt.proxy.circuitBreakerFailures = parseInt(formData.circuitBreakerFailures, 10) || 5;
  if (formData.circuitBreakerCooldown) rt.proxy.circuitBreakerCooldown = parseInt(formData.circuitBreakerCooldown, 10) || 30000;

  // Update retryable status codes
  if (formData.retryableStatusCodes) {
    rt.proxy.retryableStatusCodes = formData.retryableStatusCodes
      .split(",")
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
  }

  // Update allowed models (mandatory — at least 1 model required)
  if (formData.allowedModels !== undefined) {
    const raw = formData.allowedModels.trim();
    if (!raw) throw new Error("至少需要设置 1 个允许模型");
    rt.allowedModels = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (rt.allowedModels.length === 0) throw new Error("至少需要设置 1 个允许模型");
  }

  // Update default model mappings (jx-* aliases)
  if (formData.defaultModels_sonnet) rt.defaultModels.sonnet = formData.defaultModels_sonnet.trim();
  if (formData.defaultModels_opus)   rt.defaultModels.opus   = formData.defaultModels_opus.trim();
  if (formData.defaultModels_haiku)  rt.defaultModels.haiku  = formData.defaultModels_haiku.trim();

  // Ensure defaultModels values are always in allowedModels
  for (const m of Object.values(rt.defaultModels)) {
    if (m && !rt.allowedModels.includes(m)) {
      rt.allowedModels.push(m);
    }
  }

  // Update circuit breaker thresholds
  upstreamBreaker.failureThreshold = rt.proxy.circuitBreakerFailures || 5;
  upstreamBreaker.cooldownMs = rt.proxy.circuitBreakerCooldown || 30000;

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
    rt.globalUsers = newGlobalUsers;
  }

  // Update profile users (key assignment + profile disable)
  const newProfileUsers = {};
  for (const [k, v] of Object.entries(formData)) {
    if (k.startsWith("pu_rk_")) {
      const vk = k.slice(6);
      const realKey = v.trim();
      if (!realKey) continue; // skip users without real key
      newProfileUsers[vk] = {
        key: realKey,
        disabled: formData["pu_dis_" + vk] === "on",
      };
    }
  }
  if (Object.keys(newProfileUsers).length > 0) {
    rt.users = newProfileUsers;
  }

  // Persist to config.json
  const cfg = loadConfig();
  cfg.proxy = { ...rt.proxy };
  cfg.users = { ...rt.globalUsers };
  // Update active profile
  const ap = cfg.profiles[cfg.activeProfile];
  if (ap) {
    ap.upstream = rt.upstream;
    ap.allowedModels = rt.allowedModels;
    ap.defaultModels = { ...rt.defaultModels };
    ap.users = { ...rt.users };
  }
  saveConfig(cfg);

  console.log(`[CONFIG] Settings saved to profile "${cfg.activeProfile}"`);
}

const server = http.createServer((req, res) => {
  // Login (no auth required)
  if (req.method === "POST" && req.url === "/api/login") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const { password } = JSON.parse(Buffer.concat(chunks).toString());
        if (dashboardPassword && password === dashboardPassword) {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": `${AUTH_COOKIE}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "wrong password" }));
        }
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "bad request" }));
      }
    });
    return;
  }

  // Logout
  if (req.method === "POST" && req.url === "/api/logout") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": `${AUTH_COOKIE}=; Path=/; HttpOnly; Max-Age=0`,
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
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString();
        const formData = parseFormBody(body);
        applySettings(formData);
        res.writeHead(302, { "Location": "/settings" });
        res.end();
      } catch (err) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(settingsHtml("保存失败: " + err.message));
      }
    });
    return;
  }

  // Profile: switch
  if (req.method === "POST" && req.url === "/api/profile/switch") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const { profile } = JSON.parse(Buffer.concat(chunks).toString());
        switchProfile(profile);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, activeProfile: config.activeProfile }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Profile: save as new
  if (req.method === "POST" && req.url === "/api/profile/save") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const { profile, upstream, allowedModels, defaultModels } = JSON.parse(Buffer.concat(chunks).toString());
        const name = (profile || "").trim();
        if (!name) throw new Error("Profile name required");
        // Save current runtime state to new profile
        config.profiles[name] = {
          upstream: upstream || rt.upstream,
          allowedModels: allowedModels ? allowedModels.split(",").map(s => s.trim()).filter(Boolean) : rt.allowedModels,
          defaultModels: defaultModels || { ...rt.defaultModels },
          users: { ...rt.users },
        };
        config.activeProfile = name;
        saveConfig(config);
        console.log(`[PROFILE] Created new profile "${name}"`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, profile: name }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Profile: delete
  if (req.method === "POST" && req.url === "/api/profile/delete") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const { profile } = JSON.parse(Buffer.concat(chunks).toString());
        if (Object.keys(config.profiles).length <= 1) throw new Error("Cannot delete last profile");
        if (profile === config.activeProfile) throw new Error("Cannot delete active profile. Switch first.");
        delete config.profiles[profile];
        saveConfig(config);
        console.log(`[PROFILE] Deleted profile "${profile}"`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Settings JSON API for programmatic updates
  if (req.method === "POST" && req.url === "/api/settings") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
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
    });
    return;
  }

  // Reset circuit breaker
  if (req.method === "POST" && req.url === "/api/circuit-breaker-reset") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    upstreamBreaker.reset();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: upstreamBreaker.status() }));
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

  // Protected API: stats
  if (req.method === "GET" && req.url === "/api/stats") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const data = sanitizeStore(store);
    data.activeProfile = config.activeProfile;
    data.upstream = rt.upstream;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }

  // Clear errors
  if (req.method === "POST" && req.url === "/api/clear-errors") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    store.errors = [];
    saveStore();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Delete global user
  if (req.method === "POST" && req.url === "/api/global-user/delete") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const { key } = JSON.parse(Buffer.concat(chunks).toString());
        if (!key) throw new Error("Key required");
        delete rt.globalUsers[key];
        // Remove from all profiles
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
    });
    return;
  }

  // Save all global users
  if (req.method === "POST" && req.url === "/api/global-user/save") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const { users, profileUsers } = JSON.parse(Buffer.concat(chunks).toString());
        if (!Array.isArray(users) || users.length === 0) throw new Error("No users provided");
        const newGlobalUsers = {};
        for (const u of users) {
          if (!u.key) continue;
          newGlobalUsers[u.key] = { username: u.username || u.key.slice(0, 8), expiresAt: u.expiresAt || null, disabled: !!u.disabled };
        }
        rt.globalUsers = newGlobalUsers;
        config.users = { ...rt.globalUsers };
        // Update profile users (real keys + profile disable)
        if (Array.isArray(profileUsers)) {
          const newPU = {};
          for (const pu of profileUsers) {
            if (!pu.key) continue;
            newPU[pu.key] = { key: pu.realKey || "", disabled: !!pu.disabled };
          }
          const ap = config.profiles[config.activeProfile];
          if (ap) {
            ap.users = newPU;
            rt.users = { ...newPU };
          }
        } else {
          // Ensure profile users entries exist for new keys
          const ap = config.profiles[config.activeProfile];
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
    });
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
      circuitBreaker: upstreamBreaker.status(),
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
  console.log(`[团队AI Coding监控] Profile: "${config.activeProfile}" → ${rt.upstream}`);
  console.log(`[团队AI Coding监控] Settings: http://localhost:${port}/settings`);
  console.log(`[团队AI Coding监控] Users: ${Object.values(rt.globalUsers).map(u => u.username || "").join(", ")}`);
});

// Server timeouts
const serverTimeout = Math.max(rt.proxy.streamTimeout, rt.proxy.timeout) + 60000;
server.timeout = serverTimeout;
server.requestTimeout = serverTimeout;
server.headersTimeout = 65000;
server.keepAliveTimeout = 30000;

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
