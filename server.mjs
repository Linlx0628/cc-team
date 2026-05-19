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
rt.allowedModels = activeProfile.allowedModels || null;

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
  rt.allowedModels = profile.allowedModels || null;
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
function getUserConfig(apiKey) {
  const raw = rt.users[apiKey];
  if (raw) {
    if (typeof raw === "string") return { username: raw, key: apiKey };
    return { username: raw.username || raw.name || `未知`, key: raw.key || apiKey };
  }
  for (const ck of Object.keys(rt.users)) {
    if (apiKey.startsWith(ck) || ck.startsWith(apiKey)) {
      const r = rt.users[ck];
      if (typeof r === "string") return { username: r, key: ck };
      return { username: r.username || r.name || `未知`, key: r.key || ck };
    }
  }
  return { username: `未知(${apiKey.slice(0, 8)})`, key: apiKey };
}

function resolveUserKey(apiKey) {
  if (rt.users[apiKey]) return apiKey;
  for (const ck of Object.keys(rt.users)) {
    if (apiKey.startsWith(ck) || ck.startsWith(apiKey)) return ck;
  }
  return apiKey.slice(0, 12);
}

function getUserName(apiKey) {
  const cfg = getUserConfig(apiKey);
  return cfg.username;
}

function getRealKey(apiKey) {
  const cfg = getUserConfig(apiKey);
  return cfg.key;
}

function checkModelAllowed(model) {
  // Skip check when model can't be determined (body parse failed or not JSON)
  if (!model || model === "unknown") return true;
  const allowed = rt.allowedModels;
  if (!allowed || allowed.length === 0) return true;
  if (allowed.includes("*")) return true;
  return allowed.includes(model);
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
  const inp = usage.input_tokens || 0;
  const out = usage.output_tokens || 0;
  const m = model || "unknown";

  if (!store.users[key]) store.users[key] = { name: getUserName(apiKey), totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, lastActive: null };
  const u = store.users[key];
  u.totalInputTokens += inp;
  u.totalOutputTokens += out;
  u.totalRequests += 1;
  u.lastActive = new Date().toISOString();

  if (!store.daily[today]) store.daily[today] = {};
  if (!store.daily[today][key]) store.daily[today][key] = { inputTokens: 0, outputTokens: 0, requests: 0 };
  store.daily[today][key].inputTokens += inp;
  store.daily[today][key].outputTokens += out;
  store.daily[today][key].requests += 1;

  if (!store.models[m]) store.models[m] = { tokens: 0, requests: 0 };
  store.models[m].tokens += inp + out;
  store.models[m].requests += 1;

  if (!store.hourly[today]) store.hourly[today] = {};
  if (!store.hourly[today][hour]) store.hourly[today][hour] = { requests: 0, inputTokens: 0, outputTokens: 0 };
  store.hourly[today][hour].requests += 1;
  store.hourly[today][hour].inputTokens += inp;
  store.hourly[today][hour].outputTokens += out;
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
  console.log(`[ERROR] ${getUserName(apiKey)} ${statusCode} ${errorMessage} ${path} model=${model || "unknown"}`);
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
    const body = Buffer.concat(chunks);
    let reqModel = "unknown";
    try { reqModel = JSON.parse(body.toString()).model || "unknown"; } catch {}

    // Model access restriction
    if (!checkModelAllowed(reqModel)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Model "${reqModel}" is not allowed for this user.` }));
      console.log(`[BLOCK] ${getUserName(apiKey)} model=${reqModel} denied`);
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

    try {
      const realKey = getRealKey(apiKey);
      const reqHeaders = { ...req.headers, host: rt.upstreamUrl.host, "content-length": body.length };
      // Replace virtual key with real upstream key
      if (realKey !== apiKey) {
        reqHeaders["authorization"] = `Bearer ${realKey}`;
        console.log(`[KEY] ${getUserName(apiKey)} virtual → real key mapping`);
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
          console.log(`[PLAN] Upstream plan exhausted or payment required. Status: ${upRes.statusCode}`);
        }
      }

      // Retryable status codes
      if (rt.proxy.retryableStatusCodes.includes(upRes.statusCode) && attempt < rt.proxy.maxRetries) {
        const baseDelay = Math.min(rt.proxy.retryDelay * Math.pow(2, attempt), 10000);
        const delay = Math.round(jitter(baseDelay));
        console.log(`[RETRY] ${getUserName(apiKey)} ${upRes.statusCode} attempt ${attempt + 1}/${rt.proxy.maxRetries} retrying in ${delay}ms`);
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
            console.log(`[TOKEN] ${getUserName(apiKey)} in=${usage.input_tokens || usage.prompt_tokens || 0} out=${usage.output_tokens || usage.completion_tokens || 0}`);
          } else {
            console.log(`[RESP] ${getUserName(apiKey)} 200 OK but no usage field. body[0:300]=${text.slice(0, 300).replace(/\n/g, "\\n")}`);
          }
        }
      } catch {
        if (upRes.statusCode >= 400) {
          recordError(apiKey, upRes.statusCode, text.slice(0, 200), req.url, reqModel);
          if (upRes.statusCode >= 500) upstreamBreaker.recordFailure();
        } else {
          console.log(`[RESP] ${getUserName(apiKey)} ${upRes.statusCode} non-JSON body[0:300]=${text.slice(0, 300).replace(/\n/g, "\\n")}`);
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
        console.log(`[RETRY] ${getUserName(apiKey)} network error attempt ${attempt + 1}/${rt.proxy.maxRetries} retrying in ${delay}ms`);
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

      let buf = "", usage = { input_tokens: 0, output_tokens: 0 }, model = reqModel;
      let sseDataLines = 0;
      let rawSample = "";

      if (upRes.statusCode >= 400) {
        let errBuf = "";
        upRes.on("data", (c) => { errBuf += c.toString(); res.write(c); });
        upRes.on("end", () => {
          recordError(apiKey, upRes.statusCode, errBuf.slice(0, 200), req.url, reqModel);
          if (upRes.statusCode >= 500) upstreamBreaker.recordFailure();
          else if (upRes.statusCode < 500) upstreamBreaker.recordSuccess();
          res.end();
          resolve();
        });
        return;
      }

      upstreamBreaker.recordSuccess();

      upRes.on("data", (chunk) => {
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
            if (sseDataLines <= 3) console.log(`[SSE] ${getUserName(apiKey)} #${sseDataLines} type=${d.type} keys=${Object.keys(d).join(",")}`);
            if (d.type === "message_start") {
              if (d.message) {
                model = d.message.model || model;
                if (d.message.usage) usage.input_tokens = d.message.usage.input_tokens || 0;
              }
              model = d.model || model;
            } else if (d.type === "message_delta") {
              usage.output_tokens = d.usage?.output_tokens || 0;
            }
            if (d.usage) {
              if (d.usage.input_tokens) usage.input_tokens = d.usage.input_tokens;
              if (d.usage.output_tokens) usage.output_tokens = d.usage.output_tokens;
            }
            if (d.model && model === "unknown") model = d.model;
          } catch {}
        }
      });

      upRes.on("end", () => {
        if (buf.startsWith("data: ")) {
          try { const d = JSON.parse(buf.slice(6)); if (d.usage) usage.output_tokens = d.usage.output_tokens || 0; } catch {}
        }
        if (usage.input_tokens > 0 || usage.output_tokens > 0) {
          recordUsage(apiKey, usage, model);
          console.log(`[TOKEN] ${getUserName(apiKey)} in=${usage.input_tokens} out=${usage.output_tokens}`);
        } else {
          console.log(`[RESP] ${getUserName(apiKey)} stream ended, no usage. model=${model} sseLines=${sseDataLines} raw[0:200]=${rawSample.slice(0, 200).replace(/\n/g, "\\n")}`);
        }
        res.end();
        resolve();
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
      if (!res.headersSent) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Proxy ${label}: ${err.message}` }));
      }
      resolve();
    });

    upReq.write(body);
    upReq.end();
  });
}

// ─── Settings API Helpers ─────────────────────────────────────────────────────
function getPublicSettings() {
  const safeUsers = {};
  for (const [k, v] of Object.entries(rt.users)) {
    const maskedK = k.slice(0, 12) + "****";
    if (typeof v === "string") {
      safeUsers[maskedK] = { username: v, key: k.slice(0, 12) + "****" };
    } else {
      safeUsers[maskedK] = {
        username: v.username || v.name || "",
        key: (v.key || "").slice(0, 12) + "****",
      };
    }
  }
  return {
    upstream: rt.upstream,
    proxy: { ...rt.proxy },
    allowedModels: rt.allowedModels,
    users: safeUsers,
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
  const userRows = Object.entries(rt.users).map(([k, v]) => {
    const username = typeof v === "string" ? v : (v.username || "");
    const realKey = typeof v === "string" ? k : (v.key || "");
    return `<tr>
<td><input type="text" name="uk_${k}" value="${k}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px;font-family:monospace" placeholder="虚拟Key"></td>
<td><input type="text" name="un_${k}" value="${username}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px" placeholder="用户名"></td>
<td><input type="text" name="rk_${k}" value="${realKey}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px;font-family:monospace" placeholder="真实Key"></td>
<td><button type="button" onclick="this.closest('tr').remove()" style="background:rgba(248,113,113,.15);color:var(--red);border:none;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px">删除</button></td></tr>`;
  }).join("");

  const profileBtns = s.profiles.map(p => {
    let html = '<button type="button" class="profile-btn' + (p.isActive ? ' active' : '') + '" onclick="switchToProfile(\'' + p.name + '\')" title="' + p.upstream + ' — ' + p.userCount + '个用户">' + p.name + (p.isActive ? ' ✓' : '') + '</button>';
    if (!p.isActive) {
      html += '<button type="button" onclick="deleteProfile(\'' + p.name + '\')" style="background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px;padding:0 2px" title="删除 ' + p.name + '">×</button>';
    }
    return html;
  }).join("\n  ");

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>代理设置 - 团队AI Coding监控</title>
<style>
:root{--bg:#0a0a0a;--card:#141414;--border:#2a2a2a;--text:#e5e5e5;--dim:#999;--accent:#7c6ef0;--blue:#5ba3f5;--green:#34d399;--orange:#fbbf24;--red:#f87171}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);padding:20px 24px;max-width:900px;margin:0 auto}
h1{font-size:20px;margin-bottom:4px}
h1 a{color:var(--dim);font-size:13px;text-decoration:none;margin-left:12px}
h1 a:hover{color:var(--accent)}
h2{font-size:15px;margin:24px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.section{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:12px}
label{display:block;font-size:12px;color:var(--dim);margin-bottom:4px;margin-top:10px}
label:first-child{margin-top:0}
input,select,textarea{width:100%;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;font-family:monospace;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.btn{padding:8px 20px;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-weight:600}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{opacity:.9}
.btn-danger{background:rgba(248,113,113,.15);color:var(--red)}
.btn-danger:hover{background:rgba(248,113,113,.25)}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-outline:hover{background:rgba(255,255,255,.04)}
.btn-sm{padding:4px 12px;font-size:11px}
.actions{margin-top:16px;display:flex;gap:8px;justify-content:flex-end}
table{width:100%;border-collapse:collapse;margin-top:8px}
th{text-align:left;padding:6px 8px;font-size:11px;color:var(--dim);border-bottom:1px solid var(--border)}
td{padding:6px 8px;border-bottom:1px solid var(--border);font-size:12px}
.status{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px}
.status-ok{background:rgba(52,211,153,.15);color:var(--green)}
.status-warn{background:rgba(251,191,36,.15);color:var(--orange)}
.status-err{background:rgba(248,113,113,.15);color:var(--red)}
.note{font-size:11px;color:var(--dim);margin-top:6px}
.provider-presets{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.provider-preset{font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border);background:var(--bg);color:var(--dim);cursor:pointer;font-family:monospace}
.provider-preset:hover{border-color:var(--accent);color:var(--text)}
.profile-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
.profile-btn{padding:6px 14px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);cursor:pointer;font-size:12px}
.profile-btn.active{border-color:var(--accent);background:rgba(124,110,240,.12);color:var(--accent)}
.profile-btn:hover{border-color:var(--accent)}
.profile-actions{display:flex;gap:6px;margin-left:auto}
</style></head><body>
<h1>代理设置 <a href="/dashboard">← 返回监控面板</a></h1>
${errDiv}
<div class="profile-bar">
  <span style="font-size:12px;color:var(--dim);margin-right:4px">配置方案:</span>
	  ${profileBtns}
	  <span class="profile-actions">
	    <button type="button" class="btn btn-outline btn-sm" onclick="saveAsProfile()">另存为新方案</button>
	  </span>
</div>
<form method="post" action="/api/settings-save" id="settingsForm">
<div class="section">
<h2>上游代理 <span class="status ${s.circuitBreaker.state === 'CLOSED' ? 'status-ok' : s.circuitBreaker.state === 'HALF_OPEN' ? 'status-warn' : 'status-err'}">${s.circuitBreaker.state === 'CLOSED' ? '正常' : s.circuitBreaker.state === 'HALF_OPEN' ? '探测中' : '熔断中'}</span></h2>
<label>上游 API 地址</label>
<input type="text" name="upstream" value="${s.upstream}" placeholder="https://open.bigmodel.cn/api/anthropic">
<label>允许模型 (逗号分隔，留空=不限制)</label>
<input type="text" name="allowedModels" value="${(s.allowedModels || []).join(",")}" placeholder="留空表示不限制，填写则只允许指定模型" style="font-family:monospace">
<div class="provider-presets">
  <span style="font-size:11px;color:var(--dim);line-height:24px">快速切换：</span>
  <button type="button" class="provider-preset" onclick="document.querySelector('[name=upstream]').value='https://open.bigmodel.cn/api/anthropic'">智谱 GLM</button>
  <button type="button" class="provider-preset" onclick="document.querySelector('[name=upstream]').value='https://api.anthropic.com'">Anthropic</button>
  <button type="button" class="provider-preset" onclick="document.querySelector('[name=upstream]').value='https://api.openai.com/v1'">OpenAI</button>
  <button type="button" class="provider-preset" onclick="document.querySelector('[name=upstream]').value='https://api.deepseek.com/v1'">DeepSeek</button>
  <button type="button" class="provider-preset" onclick="document.querySelector('[name=upstream]').value='https://api.moonshot.cn/v1'">Moonshot</button>
	  <button type="button" class="provider-preset" onclick="document.querySelector('[name=upstream]').value='https://dashscope.aliyuncs.com/compatible-mode/v1'">阿里百炼</button>
</div>
<label>当前状态：${s.circuitBreaker.state === 'CLOSED' ? '正常运行' : s.circuitBreaker.state === 'HALF_OPEN' ? '正在探测上游恢复情况...' : `熔断中 (${Math.ceil(s.circuitBreaker.cooldownRemaining / 1000)}秒后恢复)`}</label>
<div class="note">失败次数: ${s.circuitBreaker.failureCount} | 总成功: ${s.circuitBreaker.totalSuccesses} | 总失败: ${s.circuitBreaker.totalFailures}</div>
</div>

<div class="section">
<h2>超时 & 重试设置</h2>
<div class="row">
<div><label>JSON 请求超时 (ms)</label><input type="number" name="timeout" value="${s.proxy.timeout}" min="10000" max="600000"></div>
<div><label>流式请求超时 (ms)</label><input type="number" name="streamTimeout" value="${s.proxy.streamTimeout}" min="30000" max="1200000"></div>
</div>
<div class="row">
<div><label>最大重试次数</label><input type="number" name="maxRetries" value="${s.proxy.maxRetries}" min="0" max="10"></div>
<div><label>重试基础延迟 (ms)</label><input type="number" name="retryDelay" value="${s.proxy.retryDelay}" min="100" max="30000"></div>
</div>
<div class="row">
<div><label>可重试状态码 (逗号分隔)</label><input type="text" name="retryableStatusCodes" value="${(s.proxy.retryableStatusCodes || []).join(",")}"></div>
<div><label>熔断失败阈值</label><input type="number" name="circuitBreakerFailures" value="${s.proxy.circuitBreakerFailures || 5}" min="1" max="50"></div>
</div>
<div class="row">
<div><label>熔断冷却时间 (ms)</label><input type="number" name="circuitBreakerCooldown" value="${s.proxy.circuitBreakerCooldown || 30000}" min="5000" max="300000"></div>
</div>
</div>

<div class="section">
<h2>流量控制</h2>
<div class="row">
<div><label>每用户最大并发数</label><input type="number" name="maxConcurrentPerUser" value="${s.proxy.maxConcurrentPerUser}" min="1" max="100"></div>
<div><label>每用户每分钟最大请求数</label><input type="number" name="rateLimitPerMinute" value="${s.proxy.rateLimitPerMinute}" min="1" max="600"></div>
</div>
</div>

<div class="section">
<h2>用户 API Key 管理 <button type="button" class="btn btn-outline btn-sm" onclick="addUserRow()" style="float:right">+ 添加用户</button></h2>
<table id="usersTable">
<thead><tr><th>虚拟 Key</th><th>用户名称</th><th>真实 Key</th><th style="width:60px">操作</th></tr></thead>
<tbody>${userRows}</tbody>
</table>
<div class="note">GLM模式：虚拟Key=真实Key。阿里共享模式：多人同一真实Key，各自虚拟Key。</div>
</div>

<div class="actions">
<button type="button" class="btn btn-outline" onclick="location.href='/dashboard'">取消</button>
<button type="submit" class="btn btn-primary">保存设置</button>
</div>
</form>
<script>
async function switchToProfile(name){
  if(!confirm('切换到配置方案 "'+name+'"？当前未保存的修改将丢失。'))return;
  const r=await fetch('/api/profile/switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:name})});
  if(r.ok)location.reload();
  else{const e=await r.json();alert('切换失败: '+e.error)}
}
async function saveAsProfile(){
  const name=prompt('请输入新方案名称（例如：阿里百炼、GLM）');
  if(!name)return;
  const r=await fetch('/api/profile/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:name,upstream:document.querySelector('[name=upstream]').value,allowedModels:document.querySelector('[name=allowedModels]').value})});
  if(r.ok)location.reload();
  else{const e=await r.json();alert('保存失败: '+e.error)}
}
async function deleteProfile(name){
  if(!confirm('确定删除配置方案 "'+name+'"？此操作不可恢复。'))return;
  const r=await fetch('/api/profile/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:name})});
  if(r.ok)location.reload();
  else{const e=await r.json();alert('删除失败: '+e.error)}
}
function addUserRow(){
  const tbody=document.querySelector("#usersTable tbody");
  const tr=document.createElement("tr");
  tr.innerHTML='<td><input type="text" name="uk_new_'+Date.now()+'" placeholder="虚拟 Key" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px;font-family:monospace"></td><td><input type="text" name="un_new_'+Date.now()+'" placeholder="用户名称" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px"></td><td><input type="text" name="rk_new_'+Date.now()+'" placeholder="真实 Key" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px;font-family:monospace"></td><td><button type="button" onclick="this.closest(\\'tr\\').remove()" style="background:rgba(248,113,113,.15);color:var(--red);border:none;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px">删除</button></td>';
  tbody.appendChild(tr);
}
document.addEventListener("keydown",e=>{if(e.key==="Enter"&&e.target.tagName!=="TEXTAREA")e.preventDefault()});
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
<tr><th>用户</th><th>状态</th><th class="n">请求数</th><th class="n">输入</th><th class="n">输出</th><th class="n">合计</th><th>最后活跃</th></tr>
</thead><tbody></tbody></table></div>
<div class="sec sec-collapsible" id="detailSec"><h3 onclick="toggleSec('detailSec')"><span class="sec-toggle" id="detailSecIcon">▶</span>明细记录<span class="sec-hint" id="detailHint"></span></h3><div class="sec-body" id="detailSecBody"><table id="dTable"><thead>
<tr><th>时间</th><th>用户</th><th class="n">请求数</th><th class="n">输入</th><th class="n">输出</th><th class="n">合计</th></tr>
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
  if(!ul.length){ut.innerHTML='<tr><td colspan="7" class="empty">暂无数据</td></tr>'}else{ut.innerHTML=ul.map(([,u])=>{const on=u.lastActive&&Date.now()-new Date(u.lastActive).getTime()<36e5;return'<tr><td>'+u.name+'</td><td><span style="padding:2px 8px;border-radius:4px;font-size:11px;background:'+(on?'rgba(52,211,153,.15)':'rgba(255,255,255,.05)')+';color:'+(on?'var(--green)':'var(--dim)')+'">'+(on?'在线':'离线')+'</span></td><td class="n">'+fmtT(u.totalRequests)+'</td><td class="n">'+fmtT(u.totalInputTokens)+'</td><td class="n">'+fmtT(u.totalOutputTokens)+'</td><td class="n hl">'+fmtT(u.totalInputTokens+u.totalOutputTokens)+'</td><td>'+ago(u.lastActive)+'</td></tr>'}).join("")}

  // Detail table
  const dt=document.querySelector("#dTable tbody");
  if(!keys.length){dt.innerHTML='<tr><td colspan="6" class="empty">暂无数据</td></tr>'}else{let rows=[];for(const k of keys.sort().reverse()){const us2=Object.entries(g[k]).sort((a,b)=>(b[1].inputTokens+b[1].outputTokens)-(a[1].inputTokens+a[1].outputTokens));for(const[u,d]of us2){const n=(D.users[u]||{}).name||u.slice(0,8);rows.push('<tr><td>'+lbl(P,k)+'</td><td>'+n+'</td><td class="n">'+fmtT(d.requests)+'</td><td class="n">'+fmtT(d.inputTokens)+'</td><td class="n">'+fmtT(d.outputTokens)+'</td><td class="n hl">'+fmtT(d.inputTokens+d.outputTokens)+'</td></tr>')}}dt.innerHTML=rows.join("");document.getElementById("detailHint").textContent=rows.length+"条记录"}

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

  // Update allowed models (global)
  if (formData.allowedModels !== undefined) {
    const raw = formData.allowedModels.trim();
    rt.allowedModels = raw ? raw.split(",").map(s => s.trim()).filter(Boolean) : null;
  }

  // Update circuit breaker thresholds
  upstreamBreaker.failureThreshold = rt.proxy.circuitBreakerFailures || 5;
  upstreamBreaker.cooldownMs = rt.proxy.circuitBreakerCooldown || 30000;

  // Update users
  const newUsers = {};
  function collectUser(virtualKey, suffix, prefix) {
    if (!virtualKey || !virtualKey.trim()) return;
    const vk = virtualKey.trim();
    const username = formData[prefix + "un_" + suffix] || vk.slice(0, 8);
    const realKey = formData[prefix + "rk_" + suffix] || vk;
    newUsers[vk] = { username, key: realKey.trim() };
  }
  for (const [k, v] of Object.entries(formData)) {
    if (k.startsWith("uk_") && !k.startsWith("uk_new_")) {
      collectUser(v, k.slice(3), "");
    }
    if (k.startsWith("uk_new_") && v.trim()) {
      collectUser(v, k.slice(7), "new_");
    }
  }
  if (Object.keys(newUsers).length > 0) {
    rt.users = newUsers;
  }

  // Persist to config.json — save to active profile
  const cfg = loadConfig();
  cfg.proxy = { ...rt.proxy };
  // Update active profile
  const ap = cfg.profiles[cfg.activeProfile];
  if (ap) {
    ap.upstream = rt.upstream;
    ap.allowedModels = rt.allowedModels;
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
        const { profile, upstream, allowedModels } = JSON.parse(Buffer.concat(chunks).toString());
        const name = (profile || "").trim();
        if (!name) throw new Error("Profile name required");
        // Save current runtime state to new profile
        config.profiles[name] = {
          upstream: upstream || rt.upstream,
          allowedModels: allowedModels ? allowedModels.split(",").map(s => s.trim()).filter(Boolean) : rt.allowedModels,
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
        if (updates.users) {
          for (const [k, v] of Object.entries(updates.users)) {
            formData["uk_" + k] = k;
            if (typeof v === "string") {
              formData["un_" + k] = v;
              formData["rk_" + k] = k;
            } else {
              formData["un_" + k] = v.username || v.name || "";
              formData["rk_" + k] = v.key || k;
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
  console.log(`[团队AI Coding监控] Users: ${Object.values(rt.users).map(u => typeof u === "string" ? u : u.username).join(", ")}`);
});

// Server timeouts
const serverTimeout = Math.max(rt.proxy.streamTimeout, rt.proxy.timeout) + 60000;
server.timeout = serverTimeout;
server.requestTimeout = serverTimeout;
server.headersTimeout = 65000;
server.keepAliveTimeout = 30000;

process.on("SIGINT", () => { saveStore(); process.exit(0); });
process.on("SIGTERM", () => { saveStore(); process.exit(0); });
