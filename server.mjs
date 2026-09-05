import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

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

// Shared editorial light theme for all server-rendered pages.
const UI_THEME = `
:root{
  color-scheme:light;
  --canvas:#f7f7f3;--surface:#ffffff;--surface-subtle:#f1f1ec;--surface-hover:#ecece7;
  --bg:var(--canvas);--bg2:var(--surface-subtle);--card:var(--surface);--card2:var(--surface);
  --text:#181816;--dim:#686863;--dim2:#92928c;--border:#deded8;--border-strong:#c7c7c0;
  --accent:#2f6e50;--accent-soft:#e7efe9;--blue:#456b5a;--green:#2f6e50;
  --yellow:#956400;--orange:#9a6700;--red:#b42318;
  --font-body:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei","Segoe UI",sans-serif;
  --font-mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace;
}
*{margin:0;padding:0;box-sizing:border-box}
html{background:var(--canvas);scroll-behavior:smooth}
body{font-family:var(--font-body);font-weight:400;font-size:14px;background:var(--canvas);color:var(--text);min-height:100vh;line-height:1.5;letter-spacing:0}
button,input,select,textarea{font:inherit;letter-spacing:0}
button,a,input,select,textarea{transition:border-color .18s ease,background-color .18s ease,color .18s ease,opacity .18s ease,transform .18s ease}
button:active,.btn:active{transform:translateY(1px)}
:focus-visible{outline:3px solid rgba(47,110,80,.2);outline-offset:2px}
::selection{background:#dbe8df;color:var(--text)}
.led{display:inline-block;width:7px;height:7px;border-radius:50%;vertical-align:middle;background:var(--dim2);margin-right:7px}
.led.on{background:var(--green)}.led.warn{background:var(--orange)}.led.err{background:var(--red)}
.quota-progress{display:inline-block;width:92px;height:6px;vertical-align:middle;overflow:hidden;border-radius:2px;background:var(--surface-subtle);margin-left:7px}
.quota-progress>i{display:block;height:100%;background:var(--green)}
.quota-progress.warn>i{background:var(--orange)}.quota-progress.crit>i{background:var(--red)}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important}}
`;

const UI_HELPERS = `
function formatCompact(n){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'k';return Number(n).toLocaleString('zh-CN')}
function totalTokens(row){row=row||{};return(row.inputTokens??row.totalInputTokens??row.input??0)+(row.outputTokens??row.totalOutputTokens??row.output??0)+(row.cacheCreationTokens??row.cacheWrite??0)+(row.cacheReadTokens??row.cacheRead??0)}
function ioTokens(row){row=row||{};return(row.inputTokens??row.totalInputTokens??row.input??0)+(row.outputTokens??row.totalOutputTokens??row.output??0)}
function quotaBar(pct){var value=Math.max(0,Math.min(100,Number(pct)||0));var cls=value>90?'crit':value>70?'warn':'';return '<span class="quota-progress '+cls+'" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+value+'"><i style="width:'+value+'%"></i></span>'}
function runCountUps(root){(root||document).querySelectorAll('[data-cu]').forEach(function(el){var raw=Number(el.dataset.cu)||0;el.textContent=el.hasAttribute('data-cu-k')?formatCompact(raw):raw.toLocaleString('zh-CN');el.dataset.cur=String(raw)})}
function hpBar(pct){return quotaBar(pct)}
`;

// ─── Toast (auto-dismissing success notifications) ─────────────────────────
const TOAST_CSS = `
#toastWrap{position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none}
.toast{background:var(--green);color:#fff;padding:9px 18px;border-radius:6px;font-size:13px;font-weight:550;box-shadow:0 6px 18px rgba(0,0,0,.16);opacity:0;transform:translateY(-8px);transition:opacity .25s ease,transform .25s ease;max-width:80vw}
.toast.show{opacity:1;transform:translateY(0)}
@media (prefers-reduced-motion:reduce){.toast{transition:none}}
`;

const TOAST_JS = `
function toast(msg){
  let wrap=document.getElementById('toastWrap');
  if(!wrap){wrap=document.createElement('div');wrap.id='toastWrap';document.body.appendChild(wrap)}
  const t=document.createElement('div');t.className='toast';t.textContent=msg;wrap.appendChild(t);
  requestAnimationFrame(function(){requestAnimationFrame(function(){t.classList.add('show')})});
  setTimeout(function(){t.classList.remove('show');setTimeout(function(){t.remove()},300)},2200);
}
function toastThen(msg,fn){try{sessionStorage.setItem('tm_toast',msg)}catch(e){}if(fn)fn()}
(function(){
  try{
    const pending=sessionStorage.getItem('tm_toast');
    if(pending){sessionStorage.removeItem('tm_toast');toast(pending)}
  }catch(e){}
  if(/[?&]saved=1/.test(location.search)){
    toast('设置已保存');
    try{history.replaceState(null,'',location.pathname)}catch(e){}
  }
})();
`;

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
const { port } = config;
const dashboardPassword = config.dashboardPassword || "";
const dataPath = path.join(__dirname, "data.json");
const dbPath = path.join(__dirname, "data.db");
const backupDir = path.join(__dirname, "backups");
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
const QUOTA_POOL_NAME_MAX = 40;

function normalizeQuotaPoolName(value) {
  return String(value || "").trim().slice(0, QUOTA_POOL_NAME_MAX);
}

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

// Peak hours: per-profile recurring daily time ranges. Format: [{start:"HH:mm",
// end:"HH:mm"}]; end < start means the range crosses midnight (e.g. 22:00-02:00).
// Drives two things: the peak model aliases, and the peak/off-peak quota rate.
const PEAK_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parsePeakTimeMinutes(t) {
  if (typeof t !== "string") return null;
  const m = PEAK_TIME_RE.exec(t.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function normalizePeakHours(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const start = parsePeakTimeMinutes(item.start);
    const end = parsePeakTimeMinutes(item.end);
    if (start === null || end === null || start === end) continue;
    const norm = { start: item.start.trim(), end: item.end.trim() };
    if (!out.some(r => r.start === norm.start && r.end === norm.end)) out.push(norm);
  }
  return out;
}

// Peak ranges are interpreted in Beijing time (UTC+8) regardless of host/container
// timezone, matching the daily-quota reset convention (cnNow). `date` is an instant;
// `new Date()` also works — the +8h shift below does the conversion.
function isInPeakHours(ranges, date = new Date()) {
  if (!Array.isArray(ranges) || ranges.length === 0) return false;
  const minutes = ((date.getTime() + 8 * 3600000) % 86400000) / 60000;
  for (const r of ranges) {
    const start = parsePeakTimeMinutes(r.start);
    const end = parsePeakTimeMinutes(r.end);
    if (start === null || end === null || start === end) continue;
    if (start < end) {
      if (minutes >= start && minutes < end) return true;
    } else if (minutes >= start || minutes < end) { // crosses midnight
      return true;
    }
  }
  return false;
}

function formatPeakHoursSummary(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return "";
  return ranges.map(r => `${r.start}-${r.end}`).join(", ");
}

// ─── Quota Rate (peak / off-peak weighting) ──────────────────────────────────
// A request's quota cost is (input+output) × the rate of the slot it lands in.
// Rates are per-profile so a Coding-Plan upstream and a pay-per-token upstream
// can price the same tokens differently, and optionally per-model on top of that
// (a "flash" tier costs a fraction of a flagship on the same upstream).
// Anchor convention: 1.0 = "one peak-hour token at the profile's default rate" —
// keeping one slot at 1.0 is what gives the nominal dailyTokenLimit a meaning.
const QUOTA_RATE_MAX = 10;

function normalizeQuotaRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(QUOTA_RATE_MAX, Math.max(0, n)) * 100) / 100;
}

// Per-model overrides, keyed by the REAL upstream model name (not the alias):
// { "glm-5.3-flash": { peak: 0.3, offPeak: 0.15 } }
// Real model names are what recordUsage receives from the upstream response and
// what the usage_*_model tables store, so this key survives peak-alias overrides
// that make two aliases resolve to the same model.
function normalizeModelQuotaRates(raw) {
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
function lookupModelQuotaRate(rates, model) {
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
function currentQuotaRate(runtime, date = new Date(), model = null) {
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
function nextRateChangeHint(runtime, date = new Date(), model = null) {
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

// Pool that a profile suffix draws from, plus its name — the pair every quota
// lookup needs.
function getPoolForSuffix(suffix) {
  const sfx = normalizeProfileSuffix(suffix);
  const profileName = getProfileNameBySuffix(sfx);
  if (!profileName) return { name: "", pool: null };
  const name = resolvePoolName(profileName);
  return { name, pool: getPoolByName(name) };
}

// Every profile suffix drawing from a pool. This is what turns a per-profile
// usage table into a pooled total.
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
    // Every user who has a real key on ANY member profile — the editable pool
    // view lists these (including ones with no limit yet), not just the ones who
    // already have a limit.
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
    configured: !!config.profiles[name].upstream,
    inDefaultGroup: group.includes(name),
    groupOrder: group.indexOf(name),
    inResponsesGroup: responsesGroup.includes(name),
    responsesGroupOrder: responsesGroup.indexOf(name),
  }));
}

// ─── Circuit Breaker ─────────────────────────────────────────────────────────
// Each failed half-open probe doubles the cooldown (capped) so a long outage does
// not cost one user-visible error every base-cooldown seconds, while a transient
// blip still recovers after one base cooldown.
const CB_MAX_BACKOFF_FACTOR = 8;
const CB_MAX_COOLDOWN_MS = 5 * 60 * 1000;

class CircuitBreaker {
  constructor(opts = {}) {
    this.profileName = opts.profileName || "";
    this.failureThreshold = opts.failureThreshold || 5;
    this.cooldownMs = opts.cooldownMs || 30000;
    this.halfOpenMaxRequests = opts.halfOpenMaxRequests || 2;
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.state = "CLOSED"; // CLOSED | OPEN | HALF_OPEN
    this.halfOpenRequests = 0;
    this.consecutiveProbeFailures = 0;
    this.totalFailures = 0;
    this.totalSuccesses = 0;
  }

  currentCooldownMs() {
    const factor = Math.min(2 ** this.consecutiveProbeFailures, CB_MAX_BACKOFF_FACTOR);
    return Math.min(this.cooldownMs * factor, CB_MAX_COOLDOWN_MS);
  }

  // Non-mutating "is this profile worth routing to right now?". The candidate
  // filter needs this WITHOUT performing the OPEN → HALF_OPEN transition, which
  // stays the exclusive job of allowRequest(). Reading state directly here is
  // what used to strand a recovered group head OPEN forever: the filter excluded
  // it, so allowRequest() never ran and the transition never happened — traffic
  // stayed on the fallback and the head's plan quota went unused.
  isAvailable() {
    if (this.state === "CLOSED") return true;
    if (this.state === "HALF_OPEN") return this.halfOpenRequests < this.halfOpenMaxRequests;
    return Date.now() - this.lastFailureTime >= this.currentCooldownMs();
  }

  allowRequest() {
    switch (this.state) {
      case "CLOSED":
        return true;
      case "OPEN": {
        const elapsed = Date.now() - this.lastFailureTime;
        if (elapsed >= this.currentCooldownMs()) {
          this.state = "HALF_OPEN";
          this.halfOpenRequests = 0;
          console.log("[CB] Circuit OPEN → HALF_OPEN, probing upstream");
          recordAudit("system", "breaker.halfopen", this.profileName, `方案 "${this.profileName}" 熔断冷却结束，进入半开探测状态`);
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
      this.consecutiveProbeFailures = 0;   // upstream answered — drop the backoff
      this.halfOpenRequests++;
      if (this.halfOpenRequests >= this.halfOpenMaxRequests) {
        this.state = "CLOSED";
        this.failureCount = 0;
        console.log("[CB] Circuit HALF_OPEN → CLOSED, upstream recovered");
        recordAudit("system", "breaker.closed", this.profileName, `方案 "${this.profileName}" 半开探测成功，熔断关闭，上游已恢复`);
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
      this.consecutiveProbeFailures++;
      const wait = Math.round(this.currentCooldownMs() / 1000);
      console.log(`[CB] Circuit HALF_OPEN → OPEN, probe failed (next probe in ${wait}s)`);
      recordAudit("system", "breaker.open", this.profileName, `方案 "${this.profileName}" 半开探测失败，重新熔断 ${wait}s（连续探测失败 ${this.consecutiveProbeFailures} 次，冷却已退避延长）`);
    } else if (this.state === "CLOSED" && this.failureCount >= this.failureThreshold) {
      this.state = "OPEN";
      console.log(`[CB] Circuit CLOSED → OPEN, ${this.failureCount} consecutive failures`);
      recordAudit("system", "breaker.open", this.profileName, `方案 "${this.profileName}" 连续 ${this.failureCount} 次失败，熔断开启 ${Math.round(this.currentCooldownMs() / 1000)}s，期间请求自动切换到备选方案`);
    }
  }

  reset() {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.halfOpenRequests = 0;
    this.consecutiveProbeFailures = 0;
  }

  status() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      probeFailures: this.consecutiveProbeFailures,
      cooldownMs: this.currentCooldownMs(),
      cooldownRemaining: this.state === "OPEN"
        ? Math.max(0, this.currentCooldownMs() - (Date.now() - this.lastFailureTime))
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
    suffix: normalizeProfileSuffix(profile.suffix),
    protocol: normalizeProfileProtocol(profile.protocol),
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
    peakModelAliases: normalizeModelAliases(profile.peakModelAliases || {}),
    globalUsers: { ...(config.users || {}) },
    breaker: new CircuitBreaker({
      profileName,
      failureThreshold: (config.proxy || {}).circuitBreakerFailures || 5,
      cooldownMs: (config.proxy || {}).circuitBreakerCooldown || 30000,
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
      PRIMARY KEY (profile, date, user_key, hour, model)
    );
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

  // ── Write statements (UPSERT / INSERT) ──
  stmts.upsertUser = db.prepare(`INSERT INTO users (profile,user_key,name,total_input,total_output,total_requests,cache_creation,cache_read,last_active)
    VALUES (@profile,@key,@name,@inp,@out,1,@cacheC,@cacheR,@now)
    ON CONFLICT(profile,user_key) DO UPDATE SET
      total_input=total_input+@inp, total_output=total_output+@out, total_requests=total_requests+1,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR, name=@name, last_active=@now`);
  // usage_daily / usage_daily_hourly / usage_daily_model also carry
  // weighted_tokens — the quota currency ((input+output) × the effective rate for
  // that slot and model). The other four tables stay raw-token only: statistics
  // and charts must never show discounted figures.
  stmts.upsertDaily = db.prepare(`INSERT INTO usage_daily (profile,date,user_key,input_tokens,output_tokens,requests,cache_creation,cache_read,weighted_tokens)
    VALUES (@profile,@today,@key,@inp,@out,1,@cacheC,@cacheR,@weighted)
    ON CONFLICT(profile,date,user_key) DO UPDATE SET
      input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out, requests=requests+1,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR,
      weighted_tokens=weighted_tokens+@weighted`);
  stmts.upsertModel = db.prepare(`INSERT INTO usage_model (profile,model,tokens,requests)
    VALUES (@profile,@m,@tokenTotal,1)
    ON CONFLICT(profile,model) DO UPDATE SET tokens=tokens+@tokenTotal, requests=requests+1`);
  stmts.upsertHourly = db.prepare(`INSERT INTO usage_hourly (profile,date,hour,requests,input_tokens,output_tokens,cache_creation,cache_read)
    VALUES (@profile,@today,@hour,1,@inp,@out,@cacheC,@cacheR)
    ON CONFLICT(profile,date,hour) DO UPDATE SET
      requests=requests+1, input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR`);
  stmts.upsertDailyModel = db.prepare(`INSERT INTO usage_daily_model (profile,date,user_key,model,input_tokens,output_tokens,requests,weighted_tokens)
    VALUES (@profile,@today,@key,@m,@inp,@out,1,@weighted)
    ON CONFLICT(profile,date,user_key,model) DO UPDATE SET
      input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out, requests=requests+1,
      weighted_tokens=weighted_tokens+@weighted`);
  stmts.upsertDailyHourly = db.prepare(`INSERT INTO usage_daily_hourly (profile,date,user_key,hour,requests,input_tokens,output_tokens,cache_creation,cache_read,weighted_tokens)
    VALUES (@profile,@today,@key,@hour,1,@inp,@out,@cacheC,@cacheR,@weighted)
    ON CONFLICT(profile,date,user_key,hour) DO UPDATE SET
      requests=requests+1, input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR,
      weighted_tokens=weighted_tokens+@weighted`);
  stmts.upsertHourlyModel = db.prepare(`INSERT INTO usage_hourly_model (profile,date,user_key,hour,model,requests,input_tokens,output_tokens)
    VALUES (@profile,@today,@key,@hour,@m,1,@inp,@out)
    ON CONFLICT(profile,date,user_key,hour,model) DO UPDATE SET
    requests=requests+1, input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out`);
  stmts.insertError = db.prepare(`INSERT INTO errors (profile,time,user_name,user_key,status_code,error,path,model)
    VALUES (@profile,@time,@userName,@key,@statusCode,@error,@path,@model)`);
  stmts.pruneErrors = db.prepare(`DELETE FROM errors WHERE time < ?`);
  stmts.trimErrors = db.prepare(`DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY id DESC LIMIT 200)`);
  stmts.pruneDailyModel = db.prepare(`DELETE FROM usage_daily_model WHERE date < ?`);
  stmts.pruneDailyHourly = db.prepare(`DELETE FROM usage_daily_hourly WHERE date < ?`);
  stmts.pruneHourlyModel = db.prepare(`DELETE FROM usage_hourly_model WHERE date < ?`);
  stmts.insertQuotaAdjust = db.prepare(`INSERT INTO quota_adjust_history (user_key,user_name,date,old_quota,new_quota,hit_rate,avg_daily_usage,auto,time)
    VALUES (@user,@username,@date,@oldQuota,@newQuota,@hitRate,@avgDailyUsage,1,@time)`);
  stmts.insertQuotaAdjustManual = db.prepare(`INSERT INTO quota_adjust_history (user_key,user_name,date,old_quota,new_quota,hit_rate,avg_daily_usage,auto,time)
    VALUES (@user,@username,@date,@oldQuota,@newQuota,NULL,NULL,0,@time)`);
  stmts.trimQuotaAdjust = db.prepare(`DELETE FROM quota_adjust_history WHERE id NOT IN (SELECT id FROM quota_adjust_history ORDER BY id DESC LIMIT 100)`);
  stmts.upsertQuotaDailyOp = db.prepare(`INSERT INTO quota_daily_ops (pool,user_key,date,bonus,reset_baseline,reset_time,updated_at)
    VALUES (@pool,@key,@date,@bonus,@baseline,@resetTime,@updatedAt)
    ON CONFLICT(pool,user_key,date) DO UPDATE SET
      bonus=@bonus, reset_baseline=@baseline, reset_time=@resetTime, updated_at=@updatedAt`);
  stmts.deleteQuotaDailyOp = db.prepare(`DELETE FROM quota_daily_ops WHERE pool=? AND user_key=? AND date=?`);
  stmts.pruneQuotaDailyOps = db.prepare(`DELETE FROM quota_daily_ops WHERE date < ?`);
  stmts.upsertMeta = db.prepare(`INSERT INTO kv_meta (key,value) VALUES (@k,@v) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  stmts.insertAudit = db.prepare(`INSERT INTO audit_log (time,actor,action,target,detail,ip,category)
    VALUES (@time,@actor,@action,@target,@detail,@ip,@category)`);
  // Check-ins land once per user per day, so the audit trail grows faster now;
  // raise the cap so admin/system entries don't age out too quickly. (check_ins
  // itself keeps the complete, untrimmed check-in history.)
  stmts.trimAudit = db.prepare(`DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT 3000)`);
  stmts.insertCheckIn = db.prepare(`INSERT INTO check_ins (user_key,date,amount,pools,created_at)
    VALUES (@key,@date,@amount,@pools,@createdAt)`);
  stmts.insertQuotaRequest = db.prepare(`INSERT INTO quota_requests (user_key,username,reason,pool,status,created_at)
    VALUES (@key,@username,@reason,@pool,'pending',@createdAt)`);

  // ── Read statements ──
  // Single-profile variant of the pooled usage query above; still used where the
  // scope is genuinely one profile (per-profile stats, not quota enforcement).
  stmts.todayWeightedForQuota = db.prepare(`SELECT COALESCE(SUM(weighted_tokens),0) AS used, COALESCE(SUM(input_tokens+output_tokens),0) AS raw FROM usage_daily WHERE profile=? AND date=? AND user_key=?`);
  stmts.profileDailyRow = db.prepare(`SELECT * FROM usage_daily WHERE profile=? AND date=? AND user_key=?`);
  stmts.profileDailyModelRows = db.prepare(`SELECT model,input_tokens,output_tokens,requests,weighted_tokens FROM usage_daily_model WHERE profile=? AND date=? AND user_key=?`);
  stmts.profileDailyHourlyRows = db.prepare(`SELECT hour,requests,input_tokens,output_tokens,cache_creation,cache_read FROM usage_daily_hourly WHERE profile=? AND date=? AND user_key=?`);
  stmts.profileDailyTrend = db.prepare(`SELECT date,input_tokens,output_tokens,requests,cache_creation,cache_read FROM usage_daily WHERE profile=? AND user_key=? AND date>=? ORDER BY date`);
  stmts.profileSummaryToday = db.prepare(`SELECT COALESCE(SUM(input_tokens+output_tokens+cache_creation+cache_read),0) AS tokens, COALESCE(SUM(requests),0) AS requests FROM usage_daily WHERE profile=? AND date=?`);
  stmts.lastQuotaAdjust = db.prepare(`SELECT * FROM quota_adjust_history WHERE user_key=? AND auto=1 ORDER BY id DESC LIMIT 1`);
  stmts.quotaAdjustRecent = db.prepare(`SELECT * FROM quota_adjust_history ORDER BY id DESC LIMIT 20`);
  stmts.getQuotaDailyOp = db.prepare(`SELECT * FROM quota_daily_ops WHERE pool=? AND user_key=? AND date=?`);
  stmts.todayQuotaOps = db.prepare(`SELECT * FROM quota_daily_ops WHERE date=?`);
  stmts.auditPage = db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`);
  stmts.auditPageForActor = db.prepare(`SELECT * FROM audit_log WHERE actor=? ORDER BY id DESC LIMIT ? OFFSET ?`);
  stmts.auditTotal = db.prepare(`SELECT COUNT(*) AS c FROM audit_log`);
  stmts.auditTotalForActor = db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE actor=?`);
  stmts.auditPageAdmin = db.prepare(`SELECT * FROM audit_log WHERE actor='admin' AND action NOT LIKE 'auth.%' ORDER BY id DESC LIMIT ? OFFSET ?`);
  stmts.auditPageSystem = db.prepare(`SELECT * FROM audit_log WHERE actor='system' ORDER BY id DESC LIMIT ? OFFSET ?`);
  stmts.auditPageAuth = db.prepare(`SELECT * FROM audit_log WHERE action LIKE 'auth.%' ORDER BY id DESC LIMIT ? OFFSET ?`);
  stmts.auditTotalAdmin = db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE actor='admin' AND action NOT LIKE 'auth.%'`);
  stmts.auditTotalSystem = db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE actor='system'`);
  stmts.auditTotalAuth = db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action LIKE 'auth.%'`);
  stmts.auditPageForCategory = db.prepare(`SELECT * FROM audit_log WHERE category=? ORDER BY id DESC LIMIT ? OFFSET ?`);
  stmts.auditTotalForCategory = db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE category=?`);
  // ── Check-in & quota-request reads ──
  stmts.getCheckIn = db.prepare(`SELECT * FROM check_ins WHERE user_key=? AND date=?`);
  stmts.checkInDatesSince = db.prepare(`SELECT date FROM check_ins WHERE user_key=? AND date>=? ORDER BY date DESC`);
  stmts.checkInTotals = db.prepare(`SELECT COUNT(*) AS days, COALESCE(SUM(amount),0) AS tokens FROM check_ins WHERE user_key=?`);
  stmts.getQuotaRequest = db.prepare(`SELECT * FROM quota_requests WHERE id=?`);
  stmts.listQuotaRequests = db.prepare(`SELECT * FROM quota_requests ORDER BY id DESC LIMIT ?`);
  stmts.listQuotaRequestsByStatus = db.prepare(`SELECT * FROM quota_requests WHERE status=? ORDER BY id DESC LIMIT ?`);
  stmts.countQuotaRequestsSince = db.prepare(`SELECT COUNT(*) AS c FROM quota_requests WHERE user_key=? AND created_at>=?`);
  // The weekly cap counts requests the admin has HANDLED, not submissions.
  stmts.countHandledQuotaRequestsSince = db.prepare(`SELECT COUNT(*) AS c FROM quota_requests WHERE user_key=? AND status='handled' AND handled_at>=?`);
  stmts.myQuotaRequests = db.prepare(`SELECT id,reason,pool,status,admin_note,created_at,handled_at FROM quota_requests WHERE user_key=? ORDER BY id DESC LIMIT 5`);
  stmts.updateQuotaRequest = db.prepare(`UPDATE quota_requests SET status=@status, admin_note=@note, handled_at=@handledAt WHERE id=@id`);
  stmts.countPendingQuotaRequests = db.prepare(`SELECT COUNT(*) AS c FROM quota_requests WHERE status='pending'`);
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
    super(message || `rate limited until ${new Date(resumeAt).toISOString()}`);
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
      `方案 "${profileName}" 被上游限流（来源: ${source || "unknown"}），暂停至 ${new Date(resumeAtMs).toISOString()}，后续请求自动切换到备选方案`);
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

// Deterministic JSON regardless of the client's key ordering.
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalJson(value[k]);
    return out;
  }
  return value;
}
function shortDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex").slice(0, 16);
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

// Move a live binding to the front of the ordered candidate list. Pure reorder:
// the list was already availability-filtered by the caller.
function applyStickyReorder(candidates, boundProfile) {
  if (!boundProfile || candidates.length < 2) return candidates;
  const idx = candidates.findIndex(c => c.name === boundProfile);
  if (idx <= 0) return candidates;
  const [bound] = candidates.splice(idx, 1);
  return [bound, ...candidates];
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

// Aggregate all profiles for "all profiles" view, assembled via SQL GROUP BY.
// Returns the same nested shape as loadProfileSnapshot so sanitizeStore and the
// frontend work unchanged. `suffixFilter` (optional array) restricts every query
// to those profile suffixes — used for protocol-scoped views. An empty array
// yields an empty store (sentinel matches nothing), NOT the full aggregation.
function getAggregatedStore(suffixFilter) {
  const agg = { users: {}, daily: {}, dailyModels: {}, dailyHourly: {}, models: {}, hourly: {}, errors: [] };
  const hasFilter = Array.isArray(suffixFilter);
  const binds = hasFilter ? (suffixFilter.length ? suffixFilter : ["\u0000none"]) : [];
  const where = hasFilter ? `WHERE profile IN (${binds.map(() => "?").join(",")})` : "";
  const q = (sql) => hasFilter
    ? db.prepare(sql.replace("__WHERE__", where)).all(...binds)
    : db.prepare(sql.replace("__WHERE__", "")).all();

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
  // hourly: GROUP BY date, hour
  for (const r of q(`SELECT date, hour, SUM(requests) AS r, SUM(input_tokens) AS ti, SUM(output_tokens) AS tout, SUM(cache_creation) AS cc, SUM(cache_read) AS cr FROM usage_hourly __WHERE__ GROUP BY date, hour`)) {
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
  let where = "";
  let binds = [];
  if (suffix) {
    where = "WHERE profile=?";
    binds = [suffix];
  } else if (Array.isArray(suffixFilter)) {
    binds = suffixFilter.length ? suffixFilter : ["\u0000none"];
    where = `WHERE profile IN (${binds.map(() => "?").join(",")})`;
  }
  const sql = `SELECT date, hour, model, SUM(requests) AS r, SUM(input_tokens) AS ti, SUM(output_tokens) AS tout
    FROM usage_hourly_model ${where} GROUP BY date, hour, model`;
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

function canUseProfile(apiKey, _rt) {
  const runtime = _rt || rt;
  if (!runtime) return { allowed: false, reason: "Profile not found" };
  const key = resolveUserKey(apiKey, runtime);
  const gu = getGlobalUser(key, runtime);
  if (!gu) return { allowed: false, reason: "Unknown API key" };
  if (!hasProfileRealKey(key, runtime)) return { allowed: false, reason: `User is not allowed to use profile "${runtime.profileName}"` };
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
  const strippedUrl = "/v1/responses" + query;
  if (inbound.suffix) {
    const runtime = runtimes[inbound.suffix];
    if (!runtime) return { error: `Unknown profile suffix "${inbound.suffix}"` };
    if (runtime.protocol !== "responses") {
      return {
        error: `方案 "${runtime.profileName}" 是 Anthropic Messages 方案，不能通过 /v1/responses 访问。请为 Codex 创建 protocol 为 responses 的方案。`,
      };
    }
    return { suffix: inbound.suffix, runtime, strippedUrl, isDefaultEntry: false };
  }
  const runtime = getResponsesDefaultRuntime();
  if (!runtime) return { noResponsesProfile: true };
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
function cnNow(now = Date.now()) { return new Date(now + 8 * 3600000); }
function cnDate() { return cnNow().toISOString().slice(0, 10); }
function cnHour() { return cnNow().toISOString().slice(11, 13); }
function secondsUntilNextCnMidnight(now = Date.now()) {
  const shifted = new Date(now + 8 * 3600000);
  const nextShiftedMidnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1);
  return Math.max(1, Math.ceil((nextShiftedMidnight - 8 * 3600000 - now) / 1000));
}

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
  const weighted = Math.round((inp + out) * rate);

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
const pooledUsageStmts = new Map();
function pooledUsageForQuota(suffixes, date, key) {
  if (!suffixes.length) return { used: 0, raw: 0 };
  let stmt = pooledUsageStmts.get(suffixes.length);
  if (!stmt) {
    const holes = suffixes.map(() => "?").join(",");
    stmt = db.prepare(`SELECT COALESCE(SUM(weighted_tokens),0) AS used, COALESCE(SUM(input_tokens+output_tokens),0) AS raw
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

  // Per-user pool quota overrides the pool-wide quota
  const userQuota = getUserPoolQuota(poolName, key);
  const poolQuota = getPoolQuota(poolName);
  const baseLimit = userQuota > 0 ? userQuota : poolQuota;
  const bonus = op.bonus > 0 ? op.bonus : 0;
  const shared = suffixes.length > 1;
  const meta = { rawUsed, discounted, rate, rateIsDefault, inPeak, model, pool: poolName, poolLabel, poolProfiles: suffixes, poolShared: shared };

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

// Quota-exceeded text shared by both protocol branches. With no weighting in play
// (rate 1.0, weighted == raw) it degrades to the original one-liner; otherwise it
// also reports the real token count, the delta written off (or added), and — most
// usefully — when the rate next changes, so the user knows when relief arrives
// instead of only that they are blocked.
function quotaExceededMessage(quota, runtime, usageUrl) {
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

function quotaErrorDetail(quota) {
  const skew = quota.rawUsed != null ? quota.rawUsed - quota.used : 0;
  const poolNote = quota.poolShared ? ` pool=${quota.pool}(${quota.poolProfiles.join("+")})` : "";
  const extra = skew !== 0 ? `, raw ${quota.rawUsed} (${skew > 0 ? "-" : "+"}${Math.abs(skew)} @×${quota.rate})` : "";
  return `quota_exceeded: ${quota.used}/${quota.limit}${extra}${poolNote}`;
}

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
function cnWeekStartIso(nowMs = Date.now()) {
  const shifted = cnNow(nowMs);
  const dow = (shifted.getUTCDay() + 6) % 7; // Monday = 0
  const mondayShiftedMidnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - dow);
  return new Date(mondayShiftedMidnight - 8 * 3600000).toISOString();
}

// Today 00:00 Beijing as ISO — anchors the fixed "one submission per day" rule.
function cnDayStartIso(nowMs = Date.now()) {
  const shifted = cnNow(nowMs);
  const dayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(dayStart - 8 * 3600000).toISOString();
}

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
const notifyCooldown = new Map(); // action → last sent timestamp

function beijingTimeString() {
  return new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
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

// Fire-and-forget dispatch with a per-action cooldown. Synchronous entry, async
// fan-out; all channel failures are logged, never surfaced.
function notifyAuditEvent(row) {
  const cfg = config.notifier || {};
  if (!cfg.enabled) return;
  const action = row.action;
  const isFailure = NOTIFY_FAILURE_ACTIONS.has(action);
  const isRecovery = NOTIFY_RECOVERY_ACTIONS.has(action);
  if (!isFailure && !(isRecovery && cfg.notifyRecovery !== false)) return;

  const rawInterval = Number(cfg.minIntervalSeconds);
  const intervalMs = Math.max(0, (Number.isFinite(rawInterval) ? rawInterval : 300) * 1000);
  const last = notifyCooldown.get(action) || 0;
  if (Date.now() - last < intervalMs) return;
  notifyCooldown.set(action, Date.now());

  const prefix = isFailure ? "【网关告警】" : "【网关恢复】";
  const msg = `${prefix} ${row.target || action}\n${row.detail || ""}\n—— ${beijingTimeString()}（token-monitor）`;
  const channels = NOTIFY_SENDERS.filter((s) => s.enabled(cfg));
  if (!channels.length) return;
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

// ─── Personal Usage ───────────────────────────────────────────────────────────
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
    quota: { type: quota.source, limit: quota.limit, used: quota.used, remaining: quota.remaining, autoAdjusted: quotaAutoAdjusted, bonus: quota.bonus || 0, resetApplied: !!quota.resetApplied, rawUsed: quota.rawUsed, discounted: quota.discounted, rate: quota.rate, rateIsDefault: true, inPeak: quota.inPeak, nextRateChange: nextRateChangeHint(runtime), pool: quota.pool, poolLabel: quota.poolLabel, poolProfiles: quota.poolProfiles || [], poolShared: !!quota.poolShared },
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
    upstreamRequest: null,
    listeners: new Set(),
  };
}

function markClientAborted(state, reason) {
  if (!state || state.aborted) return;
  state.aborted = true;
  state.reason = reason || "unknown";
  if (state.upstreamRequest && !state.upstreamRequest.destroyed) {
    state.upstreamRequest.destroy(makeClientAbortError(state.reason));
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
  state.upstreamRequest = upReq;
  if (state.aborted && !upReq.destroyed) {
    upReq.destroy(makeClientAbortError(state.reason));
  }
  return () => {
    if (state.upstreamRequest === upReq) state.upstreamRequest = null;
  };
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
// 请求里的图片块交给原模型——Codex 端对所有别名放行贴图（见 models.json 的
// modalities 联动），纯文本模型实际收到的是图片的文字转述。
// 转述按图片内容 sha256 缓存（对话每轮重发历史，同图重放零额外成本）。
const imageBridgeCache = new Map();   // sha256 -> { text, ts }
const IMAGE_BRIDGE_CACHE_MAX = 500;
const IMAGE_BRIDGE_MAX_IMAGES = 8;
const IMAGE_BRIDGE_MAX_B64 = 12 * 1024 * 1024;

function bridgeCacheGet(hash) {
  const hit = imageBridgeCache.get(hash);
  if (!hit) return null;
  return hit.text;
}
function bridgeCacheSet(hash, text) {
  imageBridgeCache.set(hash, { text, ts: Date.now() });
  if (imageBridgeCache.size > IMAGE_BRIDGE_CACHE_MAX) {
    let oldest = null, oldestKey = null;
    for (const [k, v] of imageBridgeCache) {
      if (!oldest || v.ts < oldest) { oldest = v.ts; oldestKey = k; }
    }
    if (oldestKey) imageBridgeCache.delete(oldestKey);
  }
}

// Extract data:URL images from a parsed Responses request body (input items).
// Returns the parsed input array (same ref) plus { index, hash } markers.
function extractImagesFromResponsesBody(parsed) {
  const images = [];
  const items = Array.isArray(parsed?.input) ? parsed.input : [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object" || item.type !== "message") continue;
    const content = Array.isArray(item.content) ? item.content : [];
    for (let j = 0; j < content.length; j++) {
      const block = content[j];
      if (!block || block.type !== "input_image") continue;
      const raw = String(block.image_url || "");
      const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/.exec(raw);
      if (!m) continue;
      const b64 = m[1];
      if (b64.length > IMAGE_BRIDGE_MAX_B64) continue;
      images.push({ i, j, b64 });
    }
  }
  return images;
}

// Extract base64 image blocks from a parsed Anthropic Messages body. Image
// blocks live in message content arrays — including nested inside tool_result
// content (Claude Code puts screenshots there). Returns reference-based
// markers { arr, idx, b64, mediaType } so the caller can replace in place.
function extractImageBlocksAnthropic(parsed) {
  const images = [];
  const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
  for (const msg of msgs) {
    const content = msg && msg.content;
    if (!Array.isArray(content)) continue;   // string content carries no images
    for (let idx = 0; idx < content.length; idx++) {
      const block = content[idx];
      if (!block || typeof block !== "object") continue;
      if (block.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string") {
        if (block.source.data.length <= IMAGE_BRIDGE_MAX_B64) {
          images.push({ arr: content, idx, b64: block.source.data, mediaType: block.source.media_type || "image/png" });
        }
        continue;
      }
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        const inner = block.content;
        for (let t = 0; t < inner.length; t++) {
          const tb = inner[t];
          if (tb && tb.type === "image" && tb.source?.type === "base64" && typeof tb.source.data === "string") {
            if (tb.source.data.length <= IMAGE_BRIDGE_MAX_B64) {
              images.push({ arr: inner, idx: t, b64: tb.source.data, mediaType: tb.source.media_type || "image/png" });
            }
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
// are rewritten via the helper. Returns the rewritten Buffer, or null to
// passthrough (no images, or the alias natively supports images).
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
  // Cache key includes the helper model: changing the helper (e.g. fixing a
  // misconfigured blind model) invalidates stale garbage transcriptions
  // instead of serving them forever.
  const keyed = images.map(img => ({ img, hash: `${helperModel}:${crypto.createHash("sha256").update(img.b64).digest("hex")}` }));
  // The per-request cap counts only NEW (uncached) transcriptions. Both client
  // protocols replay the FULL conversation every turn — old images are cache
  // hits and cost nothing, so counting them (an earlier bug) made any
  // conversation that had accumulated more than the cap fail entirely.
  const misses = keyed.filter(k => bridgeCacheGet(k.hash) === null);
  if (misses.length > IMAGE_BRIDGE_MAX_IMAGES) {
    const err = new Error(`单次请求需新识别的图片超过上限（${IMAGE_BRIDGE_MAX_IMAGES} 张），请分批发送`);
    err.statusCode = 400;
    throw err;
  }
  for (const { img, hash } of keyed) {
    let desc = bridgeCacheGet(hash);
    if (desc === null) {
      desc = await describeImageViaHelper(img.b64, helperModel, runtime, clientState, profileCfg, protocol, img.mediaType);
      if (desc === null) {
        const err = new Error("图片识别失败：辅助模型未能生成图片描述，请稍后重试或改用原生支持视觉的别名");
        err.statusCode = 502;
        throw err;
      }
      bridgeCacheSet(hash, desc);
    }
    // Replace the image block with a text description (keep surrounding context).
    if (protocol === "anthropic") {
      img.arr[img.idx] = { type: "text", text: `[图片内容] ${desc}` };
    } else {
      parsed.input[img.i].content[img.j] = { type: "input_text", text: `[图片内容] ${desc}` };
    }
  }
  return { body: Buffer.from(JSON.stringify(parsed)), helperModel };
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

// Ask the helper model to describe a base64 image. Returns the description text
// or null on any failure. Uses the profile's real upstream + key (same auth).
// The helper call speaks the SAME protocol as the profile it serves: Responses
// profiles ask /v1/responses with input_image, Anthropic profiles ask
// /v1/messages with an image content block.
async function describeImageViaHelper(b64, helperModel, runtime, clientState, profileCfg, protocol, mediaType) {
  const instruction = "你是图片描述助手。请用简体中文详细描述这张图片的内容，包括主体、布局、文字、颜色等，供另一个语言模型理解。只输出描述本身。";
  const mt = mediaType || "image/png";
  const isAnthropic = protocol === "anthropic";
  const body = isAnthropic
    ? JSON.stringify({
        model: helperModel,
        max_tokens: 1024,
        stream: false,
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
  const headers = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    host: runtime.upstreamUrl.host,
    authorization: `Bearer ${getRealKeyFromProfile(profileCfg)}`,
  };
  try {
    const upRes = await sendUpstream(Buffer.from(body), isAnthropic ? "/v1/messages" : "/v1/responses", "POST", headers, 60000, runtime, clientState);
    if (upRes.statusCode !== 200) return null;
    const json = JSON.parse(upRes.body.toString());
    const text = isAnthropic
      ? (Array.isArray(json?.content) ? json.content : [])
          .filter(c => c && c.type === "text")
          .map(c => c.text || "")
          .join("\n")
          .trim()
      : (json?.output || [])
          .filter(o => o && o.type === "message")
          .flatMap(o => (Array.isArray(o.content) ? o.content : []))
          .filter(c => c && c.type === "output_text")
          .map(c => c.text || "")
          .join("\n")
          .trim();
    return text || null;
  } catch {
    return null;
  }
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
    console.log(`[拦截] ${getUserName(apiKey, runtime)} 跨协议访问被拒 /${suffix} 是 Responses 方案`);
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
  const dpg = protocol === "responses"
    ? (Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup : [])
    : (Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : []);
  const groupEntryPath = protocol === "responses" ? "/v1/responses" : "/v1/messages";
  if (config.restrictGroupSuffix !== false && !resolvedProfile.isDefaultEntry && dpg.length >= 2 && dpg.includes(runtime.profileName)) {
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
    console.log(`[拦截] ${getUserName(apiKey, runtime)} 直连组内方案 /${suffix} 被拒 → 引导 ${groupEntryPath}`);
    return;
  }

  const proxyStartTime = Date.now();
  let proxyPhase = "init";
  const clientState = createClientAbortState();
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
    console.error(`[Socket] 客户端请求错误 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)} err=${err.message}`);
  });
  res.on("error", (err) => {
    console.error(`[Socket] 客户端响应错误 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)} err=${err.message}`);
    markClientAborted(clientState, "response-error");
  });
  req.on("aborted", () => {
    if (!res.writableEnded) {
      markClientAborted(clientState, "request-aborted");
      console.log(`[Socket] 客户端提前断开 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)} reason=request-aborted`);
    }
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      markClientAborted(clientState, "response-closed");
      console.log(`[Socket] 客户端提前断开 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)} reason=response-closed`);
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
          const realKey = getRealKey(apiKey, cruntime);
          const reqHeaders = { ...req.headers, host: cruntime.upstreamUrl.host, "content-length": cbody.length };
          console.log(`── 请求开始 ── ${getUserName(apiKey, cruntime)} [${reqSource}] 模型=${originalModel}${originalModel !== creqModel ? "→" + creqModel : ""}${csuffix ? ` [${csuffix}]` : ""} ──`);
          if (realKey !== apiKey) {
            reqHeaders["authorization"] = `Bearer ${realKey}`;
            console.log(`[映射] ${getUserName(apiKey, cruntime)} 虚拟key=${apiKey.slice(0,8)}**** 请求模型=${originalModel}${originalModel !== creqModel ? " → 实际=" + creqModel : ""}`);
          }
          delete reqHeaders["connection"];
          delete reqHeaders["transfer-encoding"];
          delete reqHeaders["accept-encoding"];

          const isStreamRequest = (req.headers["accept"] || "").includes("text/event-stream") ||
            (function() { try { return JSON.parse(cbody.toString()).stream; } catch { return false; } })();

          // Image-recognition bridge (both protocols): non-multimodal aliases
          // with images are rewritten into helper-model descriptions before the
          // request goes upstream. Runs for both streaming and JSON requests
          // (only the request body is touched; the response mode is unaffected).
          {
            const bridged = await bridgeImagesInRequest(cbody, cruntime, clientState, originalModel, protocol);
            if (bridged) {
              cbody = bridged.body;
              reqHeaders["content-length"] = cbody.length;
              console.log(`[图片桥接] ${getUserName(apiKey, cruntime)} 辅助模型=${bridged.helperModel} 已把图片转述后发往 ${creqModel}`);
            }
          }

          proxyPhase = isStreamRequest ? "streaming-proxy" : "json-proxy";
          const timeout = isStreamRequest ? gProxy.streamTimeout : gProxy.timeout;

          if (isStreamRequest) {
            await handleStreamingProxy(req, res, cbody, reqHeaders, apiKey, creqModel, timeout, reqSource, cruntime, csuffix, strippedUrl, clientState);
          } else {
            await handleJsonProxy(req, res, cbody, reqHeaders, apiKey, creqModel, timeout, reqSource, cruntime, csuffix, strippedUrl, clientState);
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
            console.log(`[取消] ${getUserName(apiKey, cruntime)} 客户端已断开，停止代理 model=${creqModel} phase=${proxyPhase}`);
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
            console.log(`[拦截] ${apiKey.slice(0, 8)}**** profile=${lastFailure.runtime.profileName} model 拒绝 请求模型=${lastFailure.originalModel} 解析后=${lastFailure.model} 允许=${(lastFailure.runtime.allowedModels || []).join(",")}`);
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
              `所有可用方案均已限额，最早 ${new Date(lastFailure.err.resumeAt).toISOString()} 恢复。`,
              { "Retry-After": String(retryAfter) });
            recordError(apiKey, 429, `all profiles rate-limited until ${new Date(lastFailure.err.resumeAt).toISOString()}`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
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
          console.log(`[拦截] ${apiKey.slice(0, 8)}**** profile=${lastFailure.runtime.profileName} model 拒绝 请求模型=${lastFailure.originalModel} 解析后=${lastFailure.model} 允许=${(lastFailure.runtime.allowedModels || []).join(",")}`);
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
          res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: `所有可用方案均已限额，最早 ${new Date(lastFailure.err.resumeAt).toISOString()} 恢复。` } }));
          recordError(apiKey, 429, `all profiles rate-limited until ${new Date(lastFailure.err.resumeAt).toISOString()}`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
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
      console.log(`── 请求结束 ── ${getUserName(apiKey, runtime)} ──`);
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
            console.log(`[Token] ${getUserName(apiKey, runtime)} [${reqSource}] model=${modelName} 输入=${usage.input_tokens || usage.prompt_tokens || 0} 输出=${usage.output_tokens || usage.completion_tokens || 0} 缓存写=${usage.cache_creation_input_tokens || 0} 缓存读=${usage.cache_read_input_tokens || 0}`);
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
      res.writeHead(upRes.statusCode, respHeaders);
      res.end(text);
      return;
    } catch (err) {
      if (err?.isRateLimited) throw err;   // propagate to outer failover loop — no breaker/retry
      if (isClientAbortError(err)) {
        console.log(`[取消] ${getUserName(apiKey, runtime)} JSON 客户端断开 model=${reqModel}`);
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
        console.log(`[超时] ${getUserName(apiKey, runtime)} 流式空闲超过 ${idleMs}ms，中断上游 model=${reqModel}`);
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
          console.log(`[Token] ${getUserName(apiKey, runtime)} [${reqSource}] model=${model} 输入=${usage.input_tokens} 输出=${usage.output_tokens} 缓存写=${usage.cache_creation_input_tokens || 0} 缓存读=${usage.cache_read_input_tokens || 0}`);
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
        console.log(`[取消] ${getUserName(apiKey, runtime)} 流式客户端断开 model=${reqModel}`);
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
function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escJs(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/</g, "\\x3c").replace(/>/g, "\\x3e").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

function getPublicSettings() {
  const globalUsers = {};
  for (const [k, v] of Object.entries(config.users || {})) {
    globalUsers[k] = {
      username: v.username || "",
      expiresAt: v.expiresAt || "",
      disabled: !!v.disabled,
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

// ─── Settings Page HTML ──────────────────────────────────────────────────────
function settingsHtml(errorMsg) {
  const s = getPublicSettings();
  const errDiv = errorMsg ? `<div style="background:#fff2f0;color:var(--red);border:1px solid #f1c8c2;padding:10px 14px;border-radius:6px;margin-bottom:16px;font-size:13px">${errorMsg}</div>` : "";

  // Global users table rows
  const initialSuffix = s.selectedProfileSuffix || getDefaultProfileSuffix();
  const initialAssignments = s.profileAssignments[initialSuffix] || {};
  const initialProfile = s.profiles.find(p => p.suffix === initialSuffix) || s.profiles[0] || {};

  // Default profile group (failover chain for /v1) rendering
  const dpg = (Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : []).filter(n => config.profiles[n]);
  const groupItemsHtml = dpg.map((name, i) => {
    const p = config.profiles[name];
    const bt = p.billingType === "coding_plan" ? "Coding Plan" : p.billingType === "token_plan" ? "Token Plan" : "按量计费";
    return `<div class="group-item" data-name="${escHtml(name)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px"><span style="color:var(--blue);font-weight:600;min-width:20px">${i + 1}</span><span style="flex:1">${escHtml(name)} <span style="color:var(--dim);font-size:11px">${bt}</span></span><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();moveDefaultGroup('${escJs(name)}',-1)" ${i === 0 ? "disabled" : ""}>↑</button><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();moveDefaultGroup('${escJs(name)}',1)" ${i === dpg.length - 1 ? "disabled" : ""}>↓</button><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();removeFromDefaultGroup('${escJs(name)}')">移出</button></div>`;
  }).join("");
  const nonMembersHtml = Object.keys(config.profiles).filter(n => !dpg.includes(n) && config.profiles[n].upstream && normalizeProfileProtocol(config.profiles[n].protocol) === "anthropic").map(name => `<button type="button" class="preset" onclick="event.stopPropagation();addToDefaultGroup('${escJs(name)}')">+ ${escHtml(name)}</button>`).join("");

  // Responses group (failover chain for /v1/responses) — protocol-pure by construction.
  const rpg = (Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup : [])
    .filter(n => config.profiles[n] && normalizeProfileProtocol(config.profiles[n].protocol) === "responses");
  const responsesGroupItemsHtml = rpg.map((name, i) => {
    const p = config.profiles[name];
    const bt = p.billingType === "coding_plan" ? "Coding Plan" : p.billingType === "token_plan" ? "Token Plan" : "按量计费";
    return `<div class="group-item" data-name="${escHtml(name)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px"><span style="color:var(--blue);font-weight:600;min-width:20px">${i + 1}</span><span style="flex:1">${escHtml(name)} <span style="color:var(--dim);font-size:11px">${bt}</span></span><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();moveResponsesGroup('${escJs(name)}',-1)" ${i === 0 ? "disabled" : ""}>↑</button><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();moveResponsesGroup('${escJs(name)}',1)" ${i === rpg.length - 1 ? "disabled" : ""}>↓</button><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();removeFromResponsesGroup('${escJs(name)}')">移出</button></div>`;
  }).join("");
  const responsesNonMembersHtml = Object.keys(config.profiles).filter(n => !rpg.includes(n) && config.profiles[n].upstream && normalizeProfileProtocol(config.profiles[n].protocol) === "responses").map(name => `<button type="button" class="preset" onclick="event.stopPropagation();addToResponsesGroup('${escJs(name)}')">+ ${escHtml(name)}</button>`).join("");

  // Sidebar profile card, protocol-aware: the group HEAD of each protocol gets
  // the 默认入口 badge (anthropic head via isDefault, responses head via group
  // order), and the activate button targets that protocol's default entry.
  const profileCard = (p) => {
    const host = p.upstream.replace(/^https?:\/\//, "").replace(/\/.*/, "");
    const isResponses = p.protocol === "responses";
    const isRespDefault = p.inResponsesGroup && p.responsesGroupOrder === 0;
    const isHead = p.isDefault || isRespDefault;
    const suffixLabel = '<span style="color:var(--accent);font-size:10px">/'+ escHtml(p.suffix)+'</span>' + (isHead ? ' <span style="color:var(--green);font-size:10px">默认入口</span>' : '') + (isResponses ? ' <span style="color:var(--blue);font-size:10px">Responses</span>' : '');
    const peakList = normalizePeakHours(p.peakHours);
    const inPeakNow = isInPeakHours(peakList);
    const peakLabel = peakList.length > 0
      ? `<div class="pl-users" style="${inPeakNow ? "color:var(--orange);font-weight:600" : ""}">${escHtml(formatPeakHoursSummary(peakList))}${inPeakNow ? " · 高峰中" : ""}</div>`
      : "";
    // Only surface the rate when weighting is actually in effect for this profile.
    const effRate = inPeakNow ? p.peakQuotaRate : p.offPeakQuotaRate;
    const customCount = Object.keys(p.modelQuotaRates || {}).length;
    const rateLabel = (p.peakQuotaRate !== 1 || p.offPeakQuotaRate !== 1 || customCount > 0)
      ? `<div class="pl-users" style="color:var(--accent)">配额 ×${effRate}<span style="color:var(--dim)"> （峰 ×${p.peakQuotaRate} / 谷 ×${p.offPeakQuotaRate}${customCount > 0 ? ` · ${customCount} 个模型单独定价` : ""}）</span></div>`
      : "";
    return `<div class="pl-item${p.suffix === initialSuffix ? " active" : ""}" id="pl-${escHtml(p.name)}" onclick="editProfile('${escJs(p.name)}')">
<div class="pl-name">${escHtml(p.name)} ${suffixLabel}</div>
<div class="pl-host">${escHtml(host)}</div>
<div class="pl-users">${p.userCount}位用户</div>
${peakLabel}
${rateLabel}
<div class="pl-actions">
  ${!isHead ? '<button class="pl-activate" onclick="event.stopPropagation();setDefaultProfile(\'' + escJs(p.name) + '\',\'' + (isResponses ? "responses" : "anthropic") + '\')">设为默认入口</button>' : ''}
  ${!p.isDefault ? '<button class="pl-delete" onclick="event.stopPropagation();deleteProfile(\'' + escJs(p.name) + '\')">删除</button>' : ''}
</div></div>`;
  };
  const anthProfiles = s.profiles.filter(p => p.protocol !== "responses");
  const respProfiles = s.profiles.filter(p => p.protocol === "responses");

  // Today's manual quota ops (bonus / reset), now keyed by POOL. The badge needs
  // to appear under every member profile of the pool (the op affects them all),
  // so the map is suffix → set of user keys.
  const quotaOpsByPool = {};
  for (const r of stmts.todayQuotaOps.all(cnDate())) {
    quotaOpsByPool[r.pool] = quotaOpsByPool[r.pool] || {};
    quotaOpsByPool[r.pool][r.user_key] = { bonus: r.bonus || 0, reset_baseline: r.reset_baseline || 0 };
  }
  const quotaOpsJson = JSON.stringify(quotaOpsByPool).replace(/</g, "\\x3c");
  const quotaPoolCount = (s.quotaPools || []).length;

  const globalUserRows = Object.entries(s.globalUsers).map(([k, v]) => {
    const isObj = typeof v === "object" && v !== null;
    const username = isObj ? (v.username || "") : (typeof v === "string" ? v : "");
    const expiresAt = isObj ? (v.expiresAt || "") : "";
    const disabled = isObj ? !!v.disabled : false;
    return `<tr>
<td><code style="font-size:11px;color:var(--accent);user-select:all;cursor:pointer" title="点击复制" onclick="navigator.clipboard.writeText('${escJs(k)}')">${escHtml(k)}</code></td>
<td><input type="text" name="gu_un_${escHtml(k)}" value="${escHtml(username)}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px" placeholder="用户名"></td>
<td><input type="datetime-local" name="gu_ex_${escHtml(k)}" value="${escHtml(expiresAt)}" onclick="openDateTimePicker(this)" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:3px 6px;border-radius:4px;font-size:11px;font-family:monospace" title="留空=永不过期"></td>
<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer"><input type="checkbox" name="gu_dis_${escHtml(k)}" ${disabled ? "checked" : ""} style="width:auto;accent-color:var(--red)"><span style="font-size:11px;color:${disabled ? "var(--red)" : "var(--dim)"}">${disabled ? "已禁用" : "正常"}</span></label></td>
<td><button type="button" onclick="deleteGlobalUser('${escJs(k)}')" style="background:#fff2f0;color:var(--red);border:1px solid #f1c8c2;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px">删除</button></td></tr>`;
  }).join("");

  // Profile user rows (key assignment): real key + disable only. Quota lives in
  // the pool and is edited on the 额度池 page — keeping it here would present the
  // same allowance under every member profile, reading as "one user, many limits".
  const profileUserRows = Object.entries(s.globalUsers).map(([k, v]) => {
    const isObj = typeof v === "object" && v !== null;
    const username = isObj ? (v.username || "") : (typeof v === "string" ? v : "");
    const globalDisabled = isObj ? !!v.disabled : false;
    const pu = initialAssignments[k];
    const realKey = pu ? (typeof pu === "string" ? pu : (pu.key || "")) : "";
    const profileDisabled = pu ? (typeof pu === "object" ? !!pu.disabled : false) : false;
    const rowStyle = globalDisabled ? "opacity:0.4" : "";
    return `<tr style="${rowStyle}">
<td><code style="font-size:11px;color:var(--accent)">${escHtml(k)}</code></td>
<td>${escHtml(username)}</td>
<td><input type="text" name="pu_rk_${escHtml(k)}" value="${escHtml(realKey)}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px;font-family:monospace" placeholder="真实Key (必填)"></td>
<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer"><input type="checkbox" name="pu_dis_${escHtml(k)}" ${profileDisabled ? "checked" : ""} style="width:auto;accent-color:var(--orange)"><span style="font-size:11px;color:${profileDisabled ? "var(--orange)" : "var(--dim)"}">${profileDisabled ? "已禁用" : "正常"}</span></label></td></tr>`;
  }).join("");

  const peakAliasesText = formatModelAliasesInput(s.peakModelAliases || {});
  const settingsJson = JSON.stringify(s).replace(/</g, "\\x3c");

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2096%2096%22%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2222%22%20fill%3D%22%232f6e50%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fbfbf8%22%20stroke-width%3D%2213%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate(48%2048)%20scale(0.88)%20translate(-48%20-48)%22%3E%3Cpath%20d%3D%22M37%2026.5H31.5Q20.5%2026.5%2020.5%2037.5V58.5Q20.5%2069.5%2031.5%2069.5H37%22%2F%3E%3Cpath%20d%3D%22M59%2026.5H64.5Q75.5%2026.5%2075.5%2037.5V58.5Q75.5%2069.5%2064.5%2069.5H59%22%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2248%22%20r%3D%226.2%22%20fill%3D%22%23fbfbf8%22%2F%3E%3C%2Fsvg%3E">
<title>设置 - CC Team</title>
<style>
${UI_THEME}
${TOAST_CSS}
body{padding:0;overflow:hidden;height:100vh}
.layout{display:flex;height:100vh}
.sidebar{width:360px;min-width:360px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.sidebar-hd{min-height:64px;padding:16px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px}
.sidebar-hd h1{font-size:17px;font-weight:650;white-space:nowrap}
.sidebar-hd a{color:var(--dim);font-size:12px;text-decoration:none;white-space:nowrap}
.sidebar-hd a:hover{color:var(--text)}.sidebar-brand{display:flex;align-items:center;gap:10px}
.sidebar-list{flex:1;overflow-y:auto;padding:12px}
.sidebar-global{padding:10px 12px;border-top:1px solid var(--border);background:var(--surface)}
.sidebar-nav{display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;padding:8px 12px;border-top:1px solid var(--border);background:var(--surface)}
.sidebar-nav .nav-btn{font-size:11px;font-weight:600;padding:7px 4px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--dim);cursor:pointer;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.seg{display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--bg)}
.seg button{font-size:11.5px;font-weight:600;padding:5px 12px;border:none;background:transparent;color:var(--dim);cursor:pointer}
.seg button+button{border-left:1px solid var(--border)}
.seg button.on{background:var(--accent-soft);color:var(--accent)}
.sidebar-nav .nav-btn:hover{border-color:var(--border-strong);background:var(--surface-subtle);color:var(--text)}
.sidebar-nav .nav-btn.active{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
/* Popover listing not-yet-grouped profiles, anchored right of a failover group.
   position:fixed is deliberate: the group dock is a scrollable (overflow) box,
   an absolutely-positioned child would be clipped. A fixed child of a
   display:none tab pane still doesn't render, so switching protocol tabs
   closes it for free. */
.group-add-pop{position:fixed;z-index:60;display:none;flex-direction:column;gap:6px;background:var(--surface);border:1px solid var(--border-strong);border-radius:8px;box-shadow:0 12px 32px rgba(24,24,22,.14);padding:10px 12px;min-width:200px;max-width:280px}
.group-add-pop .preset{text-align:left}
.gap-hd{font-size:10px;font-weight:650;color:var(--dim)}
.gap-empty{font-size:11px;color:var(--dim);padding:4px 2px}
.sidebar-ft{padding:12px;border-top:1px solid var(--border);background:var(--surface)}
.pl-item{background:transparent;border:1px solid transparent;border-radius:6px;padding:9px 11px;margin-bottom:3px;position:relative;cursor:pointer}
.pl-item:hover{background:var(--surface-subtle)}
.pl-item.active{border-color:var(--border);background:var(--accent-soft)}
.pl-name{font-size:13px;font-weight:600;margin-bottom:3px;padding-right:74px}
.pl-host{font-size:11px;color:var(--dim);font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px}
.pl-users{font-size:11px;color:var(--dim)}
.pl-actions{display:none;position:absolute;top:8px;right:8px;gap:3px}
.pl-item:hover .pl-actions,.pl-item.active .pl-actions{display:flex}
.pl-activate,.pl-delete{font-size:10px;padding:3px 7px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--dim);cursor:pointer;white-space:nowrap}
.pl-activate:hover{border-color:var(--accent);color:var(--accent)}
.pl-delete:hover{border-color:#e5b8b2;color:var(--red);background:#fff5f3}
.pl-badge{font-size:10px;padding:2px 7px;border-radius:4px;background:var(--accent-soft);color:var(--accent);white-space:nowrap}
.main{flex:1;overflow-y:auto;padding:28px clamp(24px,4vw,56px);scrollbar-gutter:stable}
.main form,#dataManagementView,#auditLogView{max-width:1180px;margin:0 auto}
#settingsForm{padding-bottom:72px}
.view-intro{margin-bottom:24px}.view-intro h2{margin-bottom:7px}.view-intro p{color:var(--dim);font-size:12px;line-height:1.65}
.main h2{font-size:16px;font-weight:650;margin:30px 0 10px;padding-bottom:10px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.main h2:first-of-type{margin-top:0}
.section{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:18px;margin-bottom:14px}
label{display:block;font-size:12px;font-weight:550;color:#4f4f4a;margin-bottom:5px;margin-top:12px}
label:first-child{margin-top:0}
input,select,textarea{width:100%;padding:9px 11px;background:var(--surface);border:1px solid var(--border-strong);border-radius:5px;color:var(--text);font-size:13px;font-family:var(--font-mono);outline:none}
input:hover,select:hover,textarea:hover{border-color:#aaa9a2}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
input[type=checkbox]{accent-color:var(--accent)}
input[type=datetime-local]{color-scheme:light;cursor:pointer}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.row3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
.btn{padding:8px 15px;border:1px solid transparent;border-radius:5px;font-size:12px;cursor:pointer;font-weight:600}
.btn-primary{background:var(--text);color:#fff}.btn-primary:hover{background:#33332f}
.btn-danger{background:#fff2f0;color:var(--red);border-color:#f1c8c2}.btn-danger:hover{background:#ffe8e5}
.btn-outline{background:var(--surface);border-color:var(--border);color:var(--text)}.btn-outline:hover{background:var(--surface-subtle);border-color:var(--border-strong)}
.btn-sm{padding:5px 10px;font-size:11px}
.cleanup-tab.on{background:var(--text);color:#fff;border-color:var(--text)}.cleanup-tab.on span{color:#cfcfcf}
.n{text-align:right;font-variant-numeric:tabular-nums}
.actions{position:fixed;left:360px;right:0;bottom:0;margin:0;padding:12px clamp(24px,4vw,56px) calc(12px + env(safe-area-inset-bottom));display:flex;gap:8px;justify-content:flex-end;background:rgba(255,255,255,.96);border-top:1px solid var(--border);backdrop-filter:blur(8px);z-index:40}
table{width:100%;border-collapse:collapse;margin-top:8px}
th{text-align:left;padding:8px;font-size:11px;font-weight:600;color:var(--dim);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:8px;border-bottom:1px solid #ecece8;font-size:12px}
.status{display:inline-flex;align-items:center;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:550}
.status-ok{background:var(--accent-soft);color:var(--green)}.status-warn{background:#fbf3db;color:var(--orange)}.status-err{background:#fdebec;color:var(--red)}
.note{font-size:11px;color:var(--dim);margin-top:7px;line-height:1.55}
.import-tools{display:flex;align-items:end;gap:10px;flex-wrap:wrap}.import-tools>div{flex:1;min-width:220px}.import-tools .btn{margin-bottom:1px}
.import-preview{display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)}.import-preview.open{display:block}
.import-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:12px}.import-stat{padding:10px;background:var(--surface-subtle);border-radius:5px}.import-stat b{display:block;font-size:16px;font-variant-numeric:tabular-nums}.import-stat span{font-size:10px;color:var(--dim)}
.mapping-row{display:grid;grid-template-columns:minmax(120px,1fr) 28px minmax(180px,1fr);align-items:center;gap:8px;margin-top:7px}.mapping-arrow{text-align:center;color:var(--dim)}
.danger-section{border-color:#efc9c4;background:#fffdfc}.danger-copy{display:flex;align-items:center;justify-content:space-between;gap:18px}.danger-copy strong{display:block;font-size:13px;color:var(--red);margin-bottom:3px}
.inline-status{min-height:18px;margin-top:9px;font-size:11px;color:var(--dim)}.inline-status.error{color:var(--red)}.inline-status.ok{color:var(--green)}
.presets{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.preset{font-size:11px;padding:5px 9px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--dim);cursor:pointer;font-family:var(--font-body)}
.preset:hover{border-color:var(--border-strong);background:var(--surface-subtle);color:var(--text)}
.req{color:var(--red);font-size:10px;margin-left:4px}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(24,24,22,.35);z-index:100;justify-content:center;align-items:center;padding:20px}
.modal-overlay.open{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:8px;width:90%;max-width:1100px;max-height:82vh;display:flex;flex-direction:column;box-shadow:0 18px 48px rgba(24,24,22,.12)}
.modal-hd{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.modal-hd h3{font-size:15px;font-weight:650}.modal-close{background:none;border:none;color:var(--dim);font-size:12px;cursor:pointer;padding:5px 7px}.modal-close:hover{color:var(--text);background:var(--surface-subtle)}
.modal-body{padding:18px 20px;overflow-y:auto;flex:1}
@media(max-width:900px){.row3{grid-template-columns:1fr 1fr}.main{padding:24px}}
.proto-tabs{display:flex;gap:6px;padding:0 12px;margin-bottom:8px;justify-content:center}
.proto-tab{font-size:12px;font-weight:650;padding:8px 14px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--dim);cursor:pointer;display:flex;flex-direction:column;gap:2px;align-items:center}
.proto-tab small{font-size:9px;font-weight:400;white-space:nowrap}
.proto-tab.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.proto-pane{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.sidebar-dock{flex-shrink:0}
.sidebar-dock .sidebar-global{max-height:32vh;overflow-y:auto}
.proto-pane-hd{font-size:11px;font-weight:650;padding:2px 12px 4px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.proto-pane-hd .proto-entry{font-size:10px;font-weight:400;color:var(--accent)}
.proto-pane-hint{font-size:10px;color:var(--dim);padding:0 12px 5px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.alias-toolbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:8px}
.alias-head{display:grid;grid-template-columns:1fr 1.25fr 118px 56px 30px;gap:8px;font-size:10px;font-weight:600;color:var(--dim);margin-bottom:4px}
.alias-head.peak{grid-template-columns:1fr 1.4fr 30px}
.alias-head.rate{grid-template-columns:1.6fr 100px 100px 1fr 30px}
.alias-row.rate{grid-template-columns:1.6fr 100px 100px 1fr 30px}
.alias-row.rate .rate-eff{font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.alias-row{display:grid;grid-template-columns:1fr 1.25fr 118px 56px 30px;gap:8px;margin-bottom:8px;align-items:center}
.alias-row.peak{grid-template-columns:1fr 1.4fr 30px}
.alias-row .mm-cell{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--dim);cursor:pointer;white-space:nowrap}
.alias-row .mm-cell input{width:auto;accent-color:var(--accent);margin:0;cursor:pointer}
.alias-row input,.alias-row select{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:7px 10px;border-radius:5px;font-size:12px}
.alias-row input:focus,.alias-row select:focus{border-color:var(--accent)}
.alias-row .row-del{height:32px;background:transparent;border:1px solid var(--border);border-radius:5px;color:var(--dim);cursor:pointer;font-size:13px;line-height:1}
.alias-row .row-del:hover{border-color:#f1c8c2;color:var(--red)}
.tag-row{display:flex;flex-wrap:wrap;gap:6px;min-height:30px;align-items:center;background:var(--bg);border:1px dashed var(--border);border-radius:6px;padding:8px 10px}
.tag-row .m-tag{font-size:11px;font-family:var(--font-mono);background:var(--accent-soft);color:var(--accent);padding:3px 10px;border-radius:10px}
.tag-row .m-empty{font-size:11px;color:var(--dim)}
@media(max-width:680px){body{overflow:auto;height:auto}.layout{flex-direction:column;height:auto;min-height:100vh}.sidebar{width:100%;min-width:0;max-height:none;border-right:0;border-bottom:1px solid var(--border)}.sidebar-list{display:flex;gap:6px;overflow-x:auto}.sidebar-dock .sidebar-global{max-height:none;overflow-y:visible}.sidebar-global{padding:8px 12px}.pl-item{min-width:210px;margin:0}.main{overflow:visible;padding:22px 16px}.actions{left:0;padding-left:16px;padding-right:16px}.row,.row3{grid-template-columns:1fr}.modal{width:100%;max-height:90vh}.section{padding:15px;overflow-x:auto}.import-summary{grid-template-columns:1fr 1fr}.mapping-row{grid-template-columns:1fr}.mapping-arrow{display:none}.danger-copy{align-items:flex-start;flex-direction:column}}
</style></head><body data-theme="editorial-light">
<div class="layout">
<div class="sidebar">
<div class="sidebar-hd"><div class="sidebar-brand"><svg class="brand-logo" width="24" height="24" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="#2f6e50"/><g fill="none" stroke="#fbfbf8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" transform="translate(48 48) scale(0.9) translate(-48 -48)"><path d="M37 26.5H31.5Q20.5 26.5 20.5 37.5V58.5Q20.5 69.5 31.5 69.5H37"/><path d="M59 26.5H64.5Q75.5 26.5 75.5 37.5V58.5Q75.5 69.5 64.5 69.5H59"/></g><circle cx="48" cy="48" r="4.95" fill="#fbfbf8"/></svg><h1>配置方案</h1></div><a href="/dashboard">返回面板</a></div>
<div class="proto-tabs" id="protoTabs">
  <button type="button" class="proto-tab on" data-tab="anthropic" onclick="switchProtoTab('anthropic')">Anthropic<small>Claude Code · /v1</small></button>
  <button type="button" class="proto-tab" data-tab="responses" onclick="switchProtoTab('responses')">OpenAI<small>Codex · /v1/responses</small></button>
</div>
<div class="proto-pane" data-proto="anthropic">
  <div class="proto-pane-hd"><span>Anthropic 方案 <span class="proto-entry">入口 /v1</span></span><button type="button" class="btn btn-outline btn-sm" onclick="openProfileModal('anthropic')">+ 新建</button></div>
  <div class="proto-pane-hint">Claude Code 走这里；默认入口与 failover 仅影响 /v1</div>
  <div class="sidebar-list">${anthProfiles.map(profileCard).join("") || '<div style="padding:0 12px 8px;font-size:11px;color:var(--dim)">暂无 Anthropic 方案</div>'}</div>
</div>
<div class="proto-pane" data-proto="responses" style="display:none">
  <div class="proto-pane-hd"><span>OpenAI 方案 <span class="proto-entry">入口 /v1/responses</span></span><button type="button" class="btn btn-outline btn-sm" onclick="openProfileModal('responses')">+ 新建</button></div>
  <div class="proto-pane-hint">Codex 走 /v1/responses；与 Claude Code 完全隔离</div>
  <div class="sidebar-list">${respProfiles.map(profileCard).join("") || '<div style="padding:0 12px 8px;font-size:11px;color:var(--dim)">暂无 OpenAI 方案 — Codex 请求将返回 503</div>'}</div>
</div>
<div class="sidebar-dock">
  <div class="sidebar-global" data-proto="anthropic" style="padding:8px 12px">
    <div style="font-size:11px;font-weight:650;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
      <span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">默认方案组</span>
      <div style="display:flex;align-items:center;gap:6px;flex:none">
        <button type="button" class="btn btn-outline btn-sm" data-grouppop-btn onclick="toggleGroupAddPop('defaultGroupAddPop',this)" style="font-size:10px;padding:3px 8px">＋ 加入</button>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:10px;font-weight:400;white-space:nowrap" title="全局设置：同时作用于两个协议的方案组"><input type="checkbox" id="restrictGroupSuffixCb" ${config.restrictGroupSuffix !== false ? "checked" : ""} onchange="setRestrictGroupSuffix(this.checked)" style="width:auto;accent-color:var(--accent)"> 限制直连</label>
      </div>
    </div>
    <div id="defaultGroupList" style="margin-bottom:6px">${groupItemsHtml || '<span style="font-size:11px;color:var(--dim)">组为空 — 至少加入 2 个方案以启用 failover</span>'}</div>
    <div class="group-add-pop" id="defaultGroupAddPop">
      <div class="gap-hd">未加入的 Anthropic 方案</div>
      ${nonMembersHtml || '<div class="gap-empty">没有可加入的方案</div>'}
    </div>
  </div>
  <div class="sidebar-global" data-proto="responses" style="padding:8px 12px;display:none">
    <div style="font-size:11px;font-weight:650;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
      <span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">OpenAI 方案组</span>
      <div style="display:flex;align-items:center;gap:6px;flex:none">
        <button type="button" class="btn btn-outline btn-sm" data-grouppop-btn onclick="toggleGroupAddPop('responsesGroupAddPop',this)" style="font-size:10px;padding:3px 8px">＋ 加入</button>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:10px;font-weight:400;white-space:nowrap" title="全局设置：同时作用于两个协议的方案组"><input type="checkbox" id="restrictGroupSuffixCb2" ${config.restrictGroupSuffix !== false ? "checked" : ""} onchange="setRestrictGroupSuffix(this.checked)" style="width:auto;accent-color:var(--accent)"> 限制直连</label>
      </div>
    </div>
    <div id="responsesGroupList" style="margin-bottom:6px">${responsesGroupItemsHtml || '<span style="font-size:11px;color:var(--dim)">组为空 — Codex 请求将返回 503</span>'}</div>
    <div class="group-add-pop" id="responsesGroupAddPop">
      <div class="gap-hd">未加入的 OpenAI 方案</div>
      ${responsesNonMembersHtml || '<div class="gap-empty">没有可加入的方案</div>'}
    </div>
  </div>
<div class="sidebar-nav">
  <button type="button" class="nav-btn" id="quotaPoolNav" onclick="openQuotaPoolView()" title="额度池（${quotaPoolCount} 个池）——共享额度与定价">额度池</button>
  <button type="button" class="nav-btn" id="dataManagementNav" onclick="openDataManagementView()" title="全局数据管理——导入、备份与清空">数据管理</button>
  <button type="button" class="nav-btn" id="auditLogNav" onclick="openAuditLogView()" title="操作日志——谁在何时改了什么">操作日志</button>
  <button type="button" class="nav-btn" id="quotaRequestNav" onclick="openQuotaRequestView()" title="加量申请——成员发起的用量增加申请">加量申请<span id="qrPendingBadge" style="display:none;margin-left:6px;background:var(--orange);color:#fff;border-radius:8px;font-size:10px;padding:1px 6px;vertical-align:1px"></span></button>
</div>
<div class="sidebar-ft" style="display:flex;gap:6px"><button class="btn btn-outline btn-sm" onclick="openUserModal()" style="flex:1">用户管理</button><button class="btn btn-outline btn-sm" onclick="openProfileModal()" style="flex:1">新增方案</button></div>
</div>
</div>
<div class="main">
${errDiv}
<form method="post" action="/api/settings-save" id="settingsForm">
<input type="hidden" name="_csrf" id="csrfToken" value="${CSRF_TOKEN}">
<input type="hidden" name="restrictGroupSuffix" id="restrictGroupSuffixHidden" value="${config.restrictGroupSuffix !== false ? "on" : "off"}">
<input type="hidden" name="profileName" id="profileNameInput" value="${escHtml(initialProfile.name || "")}">
<input type="hidden" name="profileSuffix" id="profileSuffixInput" value="${escHtml(initialSuffix)}">

<h2>上游代理 <span class="status ${s.circuitBreaker.state === 'CLOSED' ? 'status-ok' : s.circuitBreaker.state === 'OPEN' ? 'status-err' : 'status-warn'}">${s.circuitBreaker.state === 'CLOSED' ? '正常' : s.circuitBreaker.state === 'HALF_OPEN' ? '探测中' : s.circuitBreaker.state === 'OPEN' ? '熔断中' : '未配置'}</span></h2>
<div class="section">
<div class="row">
<div><label>上游 API 地址<span class="req">*</span></label><input type="text" name="upstream" value="${s.upstream}" placeholder="https://open.bigmodel.cn/api/anthropic"></div>
<div><label>URL 后缀 <span style="font-size:11px;color:var(--dim);font-weight:400">(所有方案必填)</span></label><input type="text" name="suffix" id="suffixInput" value="${escHtml(initialSuffix)}" placeholder="如: glm" oninput="updateAccessUrl()"></div>
</div>
<div class="note" id="accessUrlPreview" style="margin-top:8px;color:var(--green)">接入地址: http://&lt;host&gt;:6789/v1</div>
<div class="presets">
  <span style="font-size:11px;color:var(--dim);line-height:24px">快速填充：</span>
  <button type="button" class="preset" onclick="fillUpstream('https://open.bigmodel.cn/api/anthropic')">智谱 GLM</button>
  <button type="button" class="preset" onclick="fillUpstream('https://api.anthropic.com')">Anthropic</button>
  <button type="button" class="preset" onclick="fillUpstream('https://api.deepseek.com/anthropic')">DeepSeek</button>
  <button type="button" class="preset" onclick="fillUpstream('https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic')">阿里 Token Plan</button>
</div>
<div class="note" style="margin-top:8px">状态：${s.circuitBreaker.state === 'CLOSED' ? '正常运行' : s.circuitBreaker.state === 'HALF_OPEN' ? '探测恢复中' : s.circuitBreaker.state === 'OPEN' ? '熔断中(' + Math.ceil(s.circuitBreaker.cooldownRemaining / 1000) + 's 后自动探测' + (s.circuitBreaker.probeFailures > 0 ? '，已连续探测失败 ' + s.circuitBreaker.probeFailures + ' 次，冷却退避至 ' + Math.round((s.circuitBreaker.cooldownMs || 0) / 1000) + 's' : '') + ')' : '等待配置上游'} | 失败 ${s.circuitBreaker.failureCount} | 成功 ${s.circuitBreaker.totalSuccesses} | 失败 ${s.circuitBreaker.totalFailures}</div>
<div class="note">熔断期间请求自动切换到默认组的下一个方案；冷却结束后会自动放行探测请求，上游恢复即切回本方案，无需手工干预。</div>
</div>

<h2>模型别名<span class="req">*必填</span></h2>
<div class="section">
<label>通用模型别名 — 一行一个别名，别名与实际模型一一对应<span class="req">*必填</span></label>
<div class="alias-toolbar">
  <span style="font-size:11px;color:var(--dim);line-height:24px">快捷添加：</span>
  <button type="button" class="preset" onclick="addAliasRow('jx-fable')">jx-fable</button>
  <button type="button" class="preset" onclick="addAliasRow('jx-opus')">jx-opus</button>
  <button type="button" class="preset" onclick="addAliasRow('jx-haiku')">jx-haiku</button>
  <button type="button" class="preset" onclick="addAliasRow('jx-sonnet')">jx-sonnet</button>
  <button type="button" class="preset" onclick="addAliasRow('')">＋自定义别名</button>
</div>
<div class="alias-head"><span>别名</span><span>实际模型</span><span>上下文长度</span><span>多模态</span><span></span></div>
<div id="aliasRows"></div>
<datalist id="stdAliasList"><option value="jx-fable"></option><option value="jx-opus"></option><option value="jx-haiku"></option><option value="jx-sonnet"></option></datalist>
<div class="note">至少配置 1 行完整别名。「多模态」勾选表示该别名原生支持图片（直通，不转述）；不勾选的别名贴图时网关会自动转述（见下方辅助模型设置）。上下文长度写入成员 Codex 接入配置的 models.json。删除行后行号自动重排。</div>
<label style="margin-top:14px">高峰期别名覆盖（可选，仅覆盖上方同名别名）</label>
<div class="alias-toolbar">
  <button type="button" class="preset" onclick="addPeakRow()">＋添加覆盖</button>
</div>
<div class="alias-head"><span>别名</span><span>实际模型</span><span></span></div>
<div id="peakRows"></div>
<div class="note">仅在下方「高峰时段」命中时生效（按北京时间判断）：被覆盖的别名在高峰期改用这里的实际模型，未覆盖的沿用默认映射。可用来在高峰期把昂贵模型换成便宜的。</div>
</div>

<h2>允许模型<span style="font-size:11px;color:var(--dim);font-weight:400">由别名自动生成，不可手动编辑</span></h2>
<div class="section">
<div id="allowedTags" class="tag-row"></div>
<div class="note" id="allowedModelsNote">自动汇总上方所有别名（含高峰期覆盖）的实际模型并去重。不在列表中的模型请求将被拦截返回 403。</div>
</div>

<h2>图片识别辅助模型<span style="font-size:11px;color:var(--dim);font-weight:400">Claude Code 与 Codex 方案通用</span></h2>
<div class="section">
<div class="row">
<div><label>辅助模型（用于识别图片，可选）</label>
<select name="imgBridgeModel" id="imgBridgeModel">
<option value="">自动（勾选多模态的别名中取第一个）</option>
${(() => { const mm = initialProfile.modelMultimodal || {}; const aliases = initialProfile.modelAliases || {}; return Object.keys(aliases).filter(a => mm[a] !== false).map(a => `<option value="${escHtml(aliases[a])}" ${initialProfile.imageBridge?.model === aliases[a] ? "selected" : ""}>${escHtml(a)} → ${escHtml(aliases[a])}</option>`).join("") })()}
</select>
</div>
<div style="align-self:flex-end"><span class="note">勾选了「多模态」的别名收到图片会原样直通；未勾选的别名收到图片时（Claude Code 与 Codex 均生效），会自动用此辅助模型转述后再交给原模型。同图自动缓存，多轮对话不重复识别。辅助模型的每次新图片识别会产生少量额外 token。</span></div>
</div>
</div>

<h2>计费类型</h2>
<div class="section">
<label>该方案的计费模式（仅用于展示；默认方案组里通常把 Coding Plan 排在按量计费之前）</label>
<select name="billingType">
  <option value="coding_plan" ${initialProfile.billingType === "coding_plan" ? "selected" : ""}>Coding Plan（套餐限额，触发 429 自动切换）</option>
  <option value="token_plan" ${initialProfile.billingType === "token_plan" ? "selected" : ""}>Token Plan（包年/包月）</option>
  <option value="on_demand" ${(!initialProfile.billingType || initialProfile.billingType === "on_demand") ? "selected" : ""}>按量计费（无限额，通常作 failover 兜底）</option>
</select>
</div>

<h2>额度池 <span style="font-size:11px;color:var(--dim);font-weight:400">同一上游套餐的方案应放进同一个池，共享额度判定；配额只计输入+输出，北京时间每日0点重置</span></h2>
<div class="section">
<label>所属额度池 — 该方案及同池所有方案的用量合并计入同一份每日额度</label>
${(() => {
  const pools = s.quotaPools || [];
  const current = initialProfile.quotaPool || "";
  const pool = pools.find(p => p.name === current);
  const memberNames = pool ? pool.profiles.map(m => m.name).join("、") : "";
  const limitSummary = pool
    ? (pool.dailyTokenLimit ? `池级上限 ${(pool.dailyTokenLimit).toLocaleString("zh-CN")}` : "池级不限制")
      + ` · ${Object.keys(pool.userLimits).length} 人有个人配额`
    : "";
  return `<select name="quotaPool" id="quotaPoolSelect" onchange="updatePoolSummary()">
    ${pools.map(p => `<option value="${escHtml(p.name)}" ${p.name === current ? "selected" : ""}>${escHtml(p.label)}（${p.profiles.length} 个方案）</option>`).join("")}
    <option value="__new__" ${!current ? "selected" : ""}>＋ 新建额度池（与方案同名）</option>
  </select>
  <div class="note" id="poolSummary">${pool ? `本池成员：${escHtml(memberNames)} · ${escHtml(limitSummary)}${pool.profiles.length > 1 ? '<br><b style="color:var(--orange)">注意：改入此池后，该方案的用量与额度立即与上述方案合并计算</b>' : ""}` : "未关联额度池"}</div>
  <div class="note">同一上游套餐的 Anthropic 与 Responses 两个方案放进同一个池后，成员在两端的消耗从同一份额度中扣减，不会再翻倍。每人配额在用户管理弹窗中设置（写入所属池，同池方案共享）。倍率仍按方案独立配置。</div>`;
})()}
</div>

<h2>配额倍率 <span style="font-size:11px;color:var(--dim);font-weight:400">按时段折算配额消耗，只影响配额计算，统计报表始终显示真实 token</span></h2>
<div class="section">
<label>方案默认倍率 — 未单独定价的模型都走这一档</label>
<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end">
<div><label>高峰时段倍率</label>
<input type="number" name="peakQuotaRate" id="peakQuotaRateInput" value="${initialProfile.peakQuotaRate ?? 1}" min="0" max="${QUOTA_RATE_MAX}" step="0.05" style="width:120px"></div>
<div><label>低谷时段倍率</label>
<input type="number" name="offPeakQuotaRate" id="offPeakQuotaRateInput" value="${initialProfile.offPeakQuotaRate ?? 1}" min="0" max="${QUOTA_RATE_MAX}" step="0.05" style="width:120px"></div>
</div>
<div class="note" id="quotaRateHint" style="margin-top:8px"></div>
<div class="note" style="margin-top:6px">1.0 = 按实际 token 计入配额；0.5 = 该时段消耗只扣一半额度。建议以「高峰期 Coding Plan 方案 = 1.0」为基准：套餐方案低谷可设 0.5，按量计费方案设 1.5~2.0 反映真实成本。<b>修改只影响之后的请求，已产生的消耗不会重算。</b></div>

<label style="margin-top:16px">按模型单独定价（可选，覆盖上方默认倍率）</label>
<div class="alias-toolbar">
  <button type="button" class="preset" onclick="addRateRow()">＋添加模型倍率</button>
  <button type="button" class="preset" onclick="fillAllRateRows()">按全部模型铺开</button>
</div>
<div class="alias-head rate"><span>实际模型</span><span>高峰倍率</span><span>低谷倍率</span><span>当前生效</span><span></span></div>
<input type="hidden" name="mrPresent" value="1">
<div id="rateRows"></div>
<div class="note" id="rateRowsHint"></div>
<div class="note">模型下拉来自上方别名的实际模型（含高峰期覆盖），避免手打错名字导致静默回落默认倍率。同一实际模型被多个别名指向时只需配一次。适合给便宜的 flash / mini 档位设更低倍率，或给昂贵模型设更高倍率。</div>
</div>

<h2>高峰时段 <span style="font-size:11px;color:var(--dim);font-weight:400">每日重复的时间段（按北京时间判断，与部署服务器时区无关），命中时启用上方的「高峰期模型别名」与「高峰时段倍率」</span></h2>
<div class="section">
<input type="hidden" name="peakStart" value="">
<input type="hidden" name="peakEnd" value="">
<div id="peakHoursList"></div>
<div style="display:flex;align-items:center;gap:10px;margin-top:8px">
<button type="button" class="btn btn-outline btn-sm" onclick="addPeakHoursRow()">添加时段</button>
<span class="note" id="peakHoursStatus"></span>
</div>
<div class="note" style="margin-top:6px">结束时间早于开始时间表示跨天时段（如 22:00-02:00）。可添加多个时段，均按北京时间计算。</div>
</div>

<h2 style="border-top:2px solid var(--border);padding-top:18px;margin-top:30px">全局配置 <span style="color:var(--dim);font-size:12px;font-weight:400">所有方案共享，不随方案切换</span></h2>
<div class="section" style="background:var(--surface-subtle);border-color:var(--border-strong)">
<div class="note" style="margin:0">以下设置作用于整个系统（所有方案共用同一份代理参数与自动配额策略），切换左侧方案不会改变这里的值。</div>
</div>

<div class="actions">
<button type="button" class="btn btn-outline" onclick="location.href='/dashboard'">取消</button>
<button type="submit" class="btn btn-primary">保存设置</button>
</div>
</form>

<div id="dataManagementView" hidden aria-hidden="true">
<div class="view-intro">
  <h2>全局数据管理</h2>
  <p>此处操作作用于整个系统，不属于任何单一配置方案。导入前请确认来源方案映射，危险操作执行前会自动创建本地备份。</p>
</div>
<div class="section" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
  <button type="button" class="btn btn-outline" onclick="clearRateLimitState()">清除限流状态（所有方案立即恢复参与 failover）</button>
  <button type="button" class="btn btn-outline" onclick="clearStickyBindings()">清除粘性绑定（下次请求回到各组默认方案）</button>
  <span class="note">限流状态在数据库持久化，重启不会自动清除。若确认某个方案额度实际已恢复（如 Coding Plan 重置），可点「清除限流状态」让它立即回到组头接管；若额度确已用尽，下一请求会再次触发限流并自动切到备用方案。清除粘性绑定则让所有会话的下一轮请求从各组组头重新开始。</span>
</div>
<h2>超时 &amp; 重试 <span style="font-size:11px;color:var(--dim);font-weight:400">全局代理配置，对所有方案生效</span></h2>
<form method="post" action="/api/settings-save" id="globalForm">
<input type="hidden" name="_csrf" value="${CSRF_TOKEN}">
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

<h2>流量控制 <span style="font-size:11px;color:var(--dim);font-weight:400">全局代理配置，对所有方案生效</span></h2>
<div class="section">
<div class="row">
<div><label>每用户最大并发数</label><input type="number" name="maxConcurrentPerUser" value="${s.proxy.maxConcurrentPerUser}" min="1" max="100"></div>
<div><label>每用户每分钟最大请求数</label><input type="number" name="rateLimitPerMinute" value="${s.proxy.rateLimitPerMinute}" min="1" max="600"></div>
</div>
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
${((() => { const qa = stmts.quotaAdjustRecent.all(); return qa.length > 0 ? `<h4 style="font-size:13px;color:var(--accent);margin:16px 0 8px">调整历史</h4><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">时间</th><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">用户</th><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">方式</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">旧配额</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">新配额</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">命中率</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">日均用量</th></tr></thead><tbody>${qa.map(h => `<tr><td style="padding:4px 8px">${h.date}</td><td style="padding:4px 8px">${h.user_name || h.user_key.slice(0, 8)}</td><td style="padding:4px 8px">${h.auto === 0 ? '<span style="color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:0 4px;font-size:11px" title="管理员当日临时加量，次日自动失效">手动·当日</span>' : '<span style="color:var(--dim)">自动</span>'}</td><td style="text-align:right;padding:4px 8px">${(h.old_quota || 0).toLocaleString()}</td><td style="text-align:right;padding:4px 8px;color:var(--green)">${(h.new_quota || 0).toLocaleString()}</td><td style="text-align:right;padding:4px 8px">${h.auto === 0 ? "-" : Math.round((h.hit_rate || 0) * 100) + "%"}</td><td style="text-align:right;padding:4px 8px">${h.auto === 0 ? "-" : (h.avg_daily_usage || 0).toLocaleString()}</td></tr>`).join("")}</tbody></table>` : '<div class="note" style="margin-top:8px">暂无调整记录</div>'; })())}
</div>
<h2>签到与加量申请 <span style="font-size:11px;color:var(--dim);font-weight:400">成员在「我的用量」页可用的趣味功能</span></h2>
<div class="section">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
<div style="border-right:1px solid var(--border);padding-right:18px">
<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" name="checkInEnabled" ${s.checkIn?.enabled !== false ? "checked" : ""} style="width:auto"> 启用每日签到</label>
<div class="note" style="margin:8px 0 12px">成员每天可签到一次，随机奖励一定量 token，自动加入其所有额度池的当日临时加量（明日自动失效，与手工加量累加）。</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
<div><label>随机奖励最小（token）</label><input type="number" name="checkInMin" value="${s.checkIn?.minTokens ?? 10000}" min="0" step="1000"></div>
<div><label>随机奖励最大（token）</label><input type="number" name="checkInMax" value="${s.checkIn?.maxTokens ?? 100000}" min="0" step="1000"></div>
</div>
</div>
<div>
<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" name="quotaRequestEnabled" ${s.quotaRequest?.enabled !== false ? "checked" : ""} style="width:auto"> 启用加量申请</label>
<div class="note" style="margin:8px 0 12px">成员可在「我的用量」页选择额度池申请加量（每人每天限提交 1 次，提交不占次数）；新申请通过通知渠道推送给你，并在侧栏「加量申请」里处理。</div>
<div><label>每人每周处理上限（次）</label><input type="number" name="quotaRequestWeeklyLimit" value="${s.quotaRequest?.weeklyLimit ?? 3}" min="0" max="1000"><span class="note">次 / 周 · 管理员处理后计入，周一刷新（设为 0 相当于关闭）</span></div>
</div>
</div>
</div>
<div class="actions" style="position:static;padding:12px 0;background:transparent;border-top:0">
<button type="submit" class="btn btn-primary">保存全局配置</button>
</div>
</form>

<h2>旧数据导入</h2>
<div class="section">
<div class="import-tools">
  <div><label for="dataImportFile">data.json 文件</label><input type="file" id="dataImportFile" accept="application/json,.json"></div>
  <button type="button" class="btn btn-outline" onclick="previewDataImport()">预览文件</button>
</div>
<div class="note">仅导入统计、错误和配额历史，不会覆盖当前配置。执行前必须确认每个来源方案的去向。</div>
<div class="import-preview" id="dataImportPreview">
  <div class="import-summary" id="dataImportSummary"></div>
  <div id="dataImportMappings"></div>
  <div class="row" style="margin-top:14px">
    <div><label for="dataImportMode">导入方式</label><select id="dataImportMode" onchange="toggleImportPassword()"><option value="merge">合并现有数据</option><option value="replace">替换全部请求数据</option></select></div>
    <div id="dataImportPasswordWrap" style="display:none"><label for="dataImportPassword">后台密码</label><input type="password" id="dataImportPassword" autocomplete="current-password" placeholder="替换模式需要验证密码"></div>
  </div>
  <div style="display:flex;justify-content:flex-end;margin-top:12px"><button type="button" class="btn btn-primary" onclick="applyDataImport()">执行导入</button></div>
  <div class="inline-status" id="dataImportStatus" role="status"></div>
</div>
</div>

<h2>统计数据清理</h2>
<div class="section">
  <div class="note" style="margin-top:0;margin-bottom:12px">清理数据库中已删除用户或模型的残留统计数据，不影响 config.json 配置。孤儿数据（已不在配置中的 Key 或模型）以淡红色高亮，可优先清理。每次删除前自动创建本地备份。</div>
  <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap">
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button type="button" class="btn btn-outline btn-sm cleanup-tab on" data-t="users" onclick="switchCleanupTab('users')">用户统计残留 <span id="cleanupUserCount" style="color:var(--dim);font-weight:400">0</span></button>
      <button type="button" class="btn btn-outline btn-sm cleanup-tab" data-t="models" onclick="switchCleanupTab('models')">模型统计残留 <span id="cleanupModelCount" style="color:var(--dim);font-weight:400">0</span></button>
    </div>
    <button type="button" class="btn btn-outline btn-sm" onclick="loadCleanupList()">刷新列表</button>
  </div>
  <div id="cleanupUsersView">
    <table>
      <thead><tr><th>虚拟 Key（脱敏）</th><th>名称</th><th class="n">请求数</th><th>最后活跃</th><th style="width:80px">配置</th><th style="width:70px">操作</th></tr></thead>
      <tbody id="cleanupUsersBody"><tr><td colspan="6" style="color:var(--dim);text-align:center;padding:18px">点击「刷新列表」加载数据</td></tr></tbody>
    </table>
  </div>
  <div id="cleanupModelsView" hidden>
    <table>
      <thead><tr><th>模型</th><th class="n">请求数</th><th class="n">Token 数</th><th style="width:70px">操作</th></tr></thead>
      <tbody id="cleanupModelsBody"><tr><td colspan="4" style="color:var(--dim);text-align:center;padding:18px">点击「刷新列表」加载数据</td></tr></tbody>
    </table>
  </div>
  <div class="inline-status" id="cleanupStatus" role="status"></div>
</div>

<h2>通知设置</h2>
<div class="section">
  <div class="note" style="margin-bottom:10px">系统自动事件推送到你的群或手机。覆盖事件——故障：方案被限流、failover 自动切换、熔断开启；恢复：限流到期、组头恢复接管、熔断关闭。同一事件类型在冷却时间内只推送一次，防止抖动刷屏。</div>
  <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;cursor:pointer"><input type="checkbox" id="notifEnabled" style="width:auto;accent-color:var(--accent)"><span style="font-size:12.5px">启用通知推送</span></label>
  <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px;cursor:pointer"><input type="checkbox" id="notifRecovery" style="width:auto;accent-color:var(--accent)"><span style="font-size:12.5px">同时推送恢复事件（关闭则只收故障告警）</span></label>
  <div class="row" style="grid-template-columns:1fr 1fr;gap:10px">
    <div><label>飞书机器人 Webhook</label><input type="text" id="notifFeishu" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." style="font-family:var(--font-mono);font-size:11px"></div>
    <div><label>钉钉机器人 Webhook</label><input type="text" id="notifDingtalk" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." style="font-family:var(--font-mono);font-size:11px"></div>
    <div><label>企业微信机器人 Webhook</label><input type="text" id="notifWecom" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." style="font-family:var(--font-mono);font-size:11px"></div>
    <div><label>Server酱 SendKey</label><input type="text" id="notifServerchan" placeholder="SCT..." style="font-family:var(--font-mono);font-size:11px"></div>
    <div><label>Bark Device Key</label><input type="text" id="notifBarkKey" placeholder="iOS 装 Bark 后复制的 Key" style="font-family:var(--font-mono);font-size:11px"></div>
    <div><label> Bark 自建服务器（可选）</label><input type="text" id="notifBarkServer" placeholder="https://api.day.app" style="font-family:var(--font-mono);font-size:11px"></div>
  </div>
  <div style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <label style="font-size:12px;color:var(--dim)">同类事件冷却</label>
    <input type="number" id="notifInterval" min="0" max="86400" step="30" style="width:90px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:4px;font-size:12px">
    <span style="font-size:12px;color:var(--dim)">秒</span>
    <span style="flex:1"></span>
    <button type="button" class="btn btn-outline btn-sm" onclick="testNotifier()">发送测试通知</button>
    <button type="button" class="btn btn-primary btn-sm" onclick="saveNotifier()">保存通知设置</button>
  </div>
  <div class="inline-status" id="notifStatus" role="status"></div>
</div>

<h2 style="color:var(--red)">危险操作</h2>
<div class="section danger-section">
  <div class="danger-copy"><div><strong>清空全部数据</strong><div class="note" style="margin:0">清除方案、用户、密钥、配额、统计、错误和导入记录。系统端口、后台密码与代理参数会保留，执行前自动创建备份。</div></div><button type="button" class="btn btn-danger" id="dataClearButton" onclick="openDataClearModal()">清空全部数据</button></div>
</div>
</div>

<div id="quotaPoolView" hidden aria-hidden="true">
<h2>额度池 <span style="font-size:12px;color:var(--dim);font-weight:400">同一上游套餐的多个方案放进同一个池，用量从同一份额度扣；在此处维护池级限额与每人配额</span></h2>
<div class="section" id="quotaPoolSection">
<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
  <button type="button" class="btn btn-outline btn-sm" onclick="togglePoolCreate()">＋ 新建额度池</button>
  <span id="poolCreateRow" style="display:none;gap:6px;align-items:center">
    <input type="text" id="newPoolName" placeholder="池名称，如：GLM 套餐池" style="width:220px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:5px;font-size:12px">
    <button type="button" class="btn btn-primary btn-sm" onclick="createPool()">创建</button>
  </span>
  <span class="note" style="margin:0">先建空池，再到各方案编辑页把方案并入。同一上游套餐的方案应放进同一个池。</span>
</div>
${(() => {
  const pools = s.quotaPools || [];
  if (!pools.length) return '<div class="note">暂无额度池。</div>';
  return pools.map(p => {
    const shared = p.profiles.length > 1;
    const empty = p.profiles.length === 0;
    const memberChips = p.profiles.map(m => `<span class="tag" style="background:rgba(0,0,0,.04);color:${m.protocol === "responses" ? "var(--blue)" : "var(--accent)"}">${escHtml(m.name)}${m.protocol === "responses" ? " · Codex" : " · Claude Code"}</span>`).join(" ");
    const memberKeys = Object.keys(p.memberUsers || {});
    const repSuffix = p.profiles[0]?.suffix || "";
    const rows = memberKeys.map(k => {
      const mu = p.memberUsers[k];
      const lim = mu.dailyTokenLimit ?? null;
      return `<tr>
<td><code style="font-size:11px;color:var(--accent)">${escHtml(k)}</code></td>
<td>${escHtml(mu.username)}</td>
<td style="width:160px"><input type="number" data-pool="${escHtml(p.name)}" data-user="${escHtml(k)}" value="${lim ?? ""}" min="0" step="100000" placeholder="跟随池级" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:4px;font-size:12px" title="留空=跟随池级限额"></td>
<td><button type="button" class="btn btn-outline btn-sm" onclick="openQuotaOpFromPool('${escJs(repSuffix)}','${escJs(k)}')" style="font-size:11px;padding:2px 8px;white-space:nowrap">临时额度</button></td>
</tr>`;
    }).join("");
    return `<div data-poolcard="${escHtml(p.name)}" style="border:1px solid ${shared ? "#e5b8b2" : empty ? "#eadfc3" : "var(--border)"};border-radius:6px;padding:14px 16px;margin-bottom:12px;background:${shared ? "#fffdfc" : "var(--surface)"}${empty ? ";opacity:.85" : ""}">
  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px">
    <div><b style="font-size:14px">${escHtml(p.label)}</b> <span style="color:var(--dim);font-size:11px">（池 key: ${escHtml(p.name)}）</span>
    ${shared ? `<span class="tag" style="background:rgba(180,35,24,.08);color:var(--red)">${p.profiles.length} 个方案共用</span>` : ''}
    ${empty ? `<span class="tag" style="background:#faf5e6;color:var(--orange)">无成员方案</span>` : ''}</div>
    <div style="display:flex;align-items:center;gap:8px">
      <label style="font-size:12px;color:var(--dim);margin:0">池级每日限额</label>
      <input type="number" data-poollimit="${escHtml(p.name)}" value="${p.dailyTokenLimit ?? ""}" min="0" step="100000" placeholder="不限制" style="width:150px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:4px;font-size:12px">
      ${empty ? `<button type="button" class="btn btn-danger btn-sm" onclick="deletePool('${escJs(p.name)}')" title="删除此空池及其配额配置">删除</button>` : `<button type="button" class="btn btn-outline btn-sm" disabled title="先在方案编辑页把成员移到其他池，空池才能删除">删除</button>`}
    </div>
  </div>
  ${empty
    ? '<div class="note" style="margin-bottom:0">尚无成员方案 —— 到各方案的编辑页，在「额度池」下拉中选择本池即可将其并入。</div>'
    : `<div style="margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap">${memberChips}</div>
  ${rows ? `<table style="min-width:auto;margin:0"><thead><tr><th>虚拟 Key</th><th>成员</th><th>每日配额（留空=跟随池级）</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="note">本池还没有成员用户——成员用户是在各方案里分配了真实 Key 的用户。</div>'}`}
  <div style="margin-top:10px;display:flex;justify-content:flex-end"><button type="button" class="btn btn-primary btn-sm" onclick="savePoolQuota('${escJs(p.name)}')">保存「${escHtml(p.label)}」</button></div>
</div>`;
  }).join("");
})()}
<div class="note">池级限额对所有未单独设限的成员生效；每人配额优先于池级限额。留空 = 跟随池级（或池级也不限则不限）。池的归属在方案编辑页「额度池」下拉中调整，方案移出后若池变空会自动清理；倍率仍在方案里配置。</div>
</div>
</div>

<div id="auditLogView" hidden aria-hidden="true">
<div class="note" style="margin-bottom:12px">记录全部管理操作、系统自动事件（failover 切换/恢复、熔断、限流、自动配额调整）与成员动作（每日签到、加量申请），按类型筛选互不混杂。最多保留最近 3000 条；「清空全部数据」不会删除审计记录。</div>
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
  <div class="seg" id="auditFilter" role="group" aria-label="日志类型筛选">
    <button type="button" class="on" data-cat="" onclick="switchAuditFilter('')">全部</button>
    <button type="button" data-cat="admin" onclick="switchAuditFilter('admin')">管理操作</button>
    <button type="button" data-cat="system" onclick="switchAuditFilter('system')">系统事件</button>
    <button type="button" data-cat="auth" onclick="switchAuditFilter('auth')">认证事件</button>
    <button type="button" data-cat="checkin" onclick="switchAuditFilter('checkin')">签到记录</button>
    <button type="button" data-cat="request" onclick="switchAuditFilter('request')">加量申请</button>
  </div>
  <button type="button" class="btn btn-outline btn-sm" onclick="loadAuditLog(true)">刷新</button>
  <span class="inline-status" id="auditStatus" role="status"></span>
</div>
<div class="section" style="padding:0;overflow-x:auto">
  <table>
    <thead><tr><th style="width:150px">时间</th><th style="width:70px">角色</th><th style="width:140px">操作</th><th style="width:170px">对象</th><th>详情</th><th style="width:110px">IP</th></tr></thead>
    <tbody id="auditBody"><tr><td colspan="6" style="color:var(--dim);text-align:center;padding:18px">打开本页时自动加载</td></tr></tbody>
  </table>
</div>
<div style="display:flex;justify-content:center;margin-top:12px">
  <button type="button" class="btn btn-outline btn-sm" id="auditMoreBtn" onclick="loadMoreAudit()" hidden>加载更多</button>
</div>
</div>

<div id="quotaRequestView" hidden aria-hidden="true">
<div class="note" style="margin-bottom:12px">成员从「我的用量」页发起的加量申请（每人每天限提交 1 次，提交不占用次数；每周处理上限在「签到与加量申请」设置中配置）。「发放加量」将奖励以当日临时加量发到其指定的额度池（明日自动失效），并自动标记该申请为已处理；驳回时可留一句备注，成员在其页面可见。</div>
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
  <div class="seg" id="qrFilter" role="group" aria-label="申请状态筛选">
    <button type="button" class="on" data-st="pending" onclick="qrSwitchFilter('pending')">待处理</button>
    <button type="button" data-st="" onclick="qrSwitchFilter('')">全部</button>
    <button type="button" data-st="handled" onclick="qrSwitchFilter('handled')">已加量</button>
    <button type="button" data-st="rejected" onclick="qrSwitchFilter('rejected')">已驳回</button>
  </div>
  <button type="button" class="btn btn-outline btn-sm" onclick="loadQuotaRequests(true)">刷新</button>
  <span class="inline-status" id="qrStatus" role="status"></span>
</div>
<div class="section" style="padding:0;overflow-x:auto">
  <table>
    <thead><tr><th style="width:150px">时间</th><th style="width:110px">成员</th><th style="width:130px">额度池</th><th>理由</th><th style="width:80px">状态</th><th style="width:230px">操作 / 处理备注</th></tr></thead>
    <tbody id="qrBody"><tr><td colspan="6" style="color:var(--dim);text-align:center;padding:18px">打开本页时自动加载</td></tr></tbody>
  </table>
</div>
</div>

<div class="modal-overlay" id="qrGrantModal">
<div class="modal" style="max-width:470px">
<div class="modal-hd"><h3>发放加量 · <span id="qrGrantUser"></span></h3><button class="modal-close" onclick="closeQrGrant()">关闭</button></div>
<div class="modal-body">
<div class="note" id="qrGrantReason" style="margin-bottom:12px"></div>
<input type="hidden" id="qrGrantId">
<div style="margin-bottom:12px"><label>发放到额度池</label><select id="qrGrantPool" style="width:100%"></select></div>
<div><label>加量数量（token）</label><input type="number" id="qrGrantAmount" min="1" step="1000" placeholder="如 500000" style="width:100%;box-sizing:border-box"><span class="note">以当日临时加量发放，明日自动失效，与签到奖励累加</span></div>
<div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">
<button type="button" class="btn btn-outline btn-sm" onclick="closeQrGrant()">取消</button>
<button type="button" class="btn btn-primary btn-sm" id="qrGrantSubmit" onclick="submitQrGrant()">发放并标记已处理</button>
</div>
</div>
</div>
</div>
</div>
</div>
<div class="modal-overlay" id="userModal">
<div class="modal">
<div class="modal-hd"><h3>用户管理</h3><button class="modal-close" onclick="closeUserModal()">关闭</button></div>
<div class="modal-body">
<h4 style="font-size:13px;color:var(--accent);margin:0 0 8px">全局用户信息</h4>
<table id="globalUsersTable">
<thead><tr><th>虚拟 Key</th><th>用户名称</th><th style="width:160px">失效时间</th><th style="width:80px">全局禁用</th><th style="width:60px">操作</th></tr></thead>
<tbody>${globalUserRows}</tbody>
</table>
<div style="margin:12px 0 4px;display:flex;gap:8px;align-items:center">
<button type="button" class="btn btn-outline btn-sm" onclick="addGlobalUser()">添加用户</button>
<span class="note">虚拟Key自动生成（jx-开头24位随机码），点击可复制。失效时间留空=永不过期。</span>
</div>
<h4 style="font-size:13px;color:var(--accent);margin:16px 0 8px;display:flex;align-items:center;justify-content:space-between;gap:12px">
<span>方案真实Key分配 <span style="font-size:11px;color:var(--dim);font-weight:400">（按方案独立授权）</span></span>
<select id="userProfileSel" onchange="switchUserProfile(this.value)" style="width:220px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:4px;font-size:12px">
${s.profiles.map(p => `<option value="${escHtml(p.suffix)}" ${p.suffix === initialSuffix ? "selected" : ""}>${escHtml(p.name)} /${escHtml(p.suffix)}${p.isDefault ? " · 默认入口" : ""}</option>`).join("")}
</select>
</h4>
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
<div class="modal-overlay" id="quotaOpModal">
<div class="modal" style="max-width:540px">
<div class="modal-hd"><h3 id="qoTitle">临时额度</h3><button class="modal-close" onclick="closeQuotaOpModal()">关闭</button></div>
<div class="modal-body">
<div id="qoInfo" style="font-size:12px;color:var(--dim);margin-bottom:10px"></div>
<div id="qoStatus" style="margin-bottom:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap"></div>
<label style="font-size:12px">今日临时加量（token 数，0 = 清除；只今天生效，明日自动失效，不改动永久每日配额）</label>
<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0 2px">
<input type="number" id="qoBonusInput" min="0" step="10000" placeholder="0" style="width:150px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:4px;font-size:12px">
<button type="button" class="btn btn-outline btn-sm" onclick="qoQuickAdd(100000)" style="font-size:11px">+10万</button>
<button type="button" class="btn btn-outline btn-sm" onclick="qoQuickAdd(500000)" style="font-size:11px">+50万</button>
<button type="button" class="btn btn-outline btn-sm" onclick="qoQuickAdd(1000000)" style="font-size:11px">+100万</button>
</div>
<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;flex-wrap:wrap">
<button type="button" class="btn btn-outline btn-sm" id="qoClearBtn" onclick="qoClear()">撤销今日手工操作</button>
<button type="button" class="btn btn-outline btn-sm" id="qoResetBtn" onclick="qoReset()">重置今日用量</button>
<button type="button" class="btn btn-primary btn-sm" id="qoSetBtn" onclick="qoSetBonus()">设置临时加量</button>
</div>
<div class="note" style="margin-top:8px">重置后该用户配额立即恢复满额，可继续使用；用量统计与报表数据保留不动。以上操作均只对当日（北京时间）生效。</div>
</div>
</div>
</div>
<div class="modal-overlay" id="profileModal">
<div class="modal" style="max-width:640px">
<div class="modal-hd"><h3>新增方案</h3><button class="modal-close" onclick="closeProfileModal()">关闭</button></div>
<div class="modal-body">
<div class="row">
<div><label>方案名称<span class="req">*</span></label><input type="text" id="newProfileName" placeholder="如: GLM 项目组"></div>
<div><label>URL 后缀<span class="req">*</span></label><input type="text" id="newProfileSuffix" placeholder="如: glm"></div>
</div>
<label>接口协议<span class="req">*</span></label>
<select id="newProfileProtocol" onchange="updateNewProfileProtocolHint()" style="font-family:var(--font-body)">
<option value="anthropic">Anthropic Messages — Claude Code</option>
<option value="responses">OpenAI Responses — Codex</option>
</select>
<div class="note" id="newProfileProtocolNote">Claude Code 走 /v1/messages；Codex 走 /v1/responses。两种协议的方案完全隔离。</div>
<label>上游 API 地址<span class="req">*</span></label><input type="text" id="newProfileUpstream" value="${escHtml(initialProfile.upstream || s.upstream || "")}" placeholder="https://open.bigmodel.cn/api/anthropic">
<label>所属额度池</label>
<select id="newProfilePool">
  <option value="">＋ 新建额度池（与方案同名，独立额度）</option>
  ${(s.quotaPools || []).map(p => `<option value="${escHtml(p.name)}">${escHtml(p.label)}（${p.profiles.length} 个方案共用额度）</option>`).join("")}
</select>
<div class="note">同一上游套餐的多个方案（如 Claude Code 与 Codex 各一个）应选同一个池，用量合并计入同一份额度。</div>
<div class="note">模型别名在创建后进入方案编辑页配置（允许模型由别名目标自动生成，无需手填）。未配置别名的方案会拒绝所有请求。</div>
<div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
<button type="button" class="btn btn-outline btn-sm" onclick="closeProfileModal()">取消</button>
<button type="button" class="btn btn-primary btn-sm" onclick="createProfile()">创建方案</button>
</div>
</div>
</div>
</div>
<div class="modal-overlay" id="dataClearModal">
<div class="modal" style="max-width:480px">
<div class="modal-hd"><h3>确认清空全部数据</h3><button class="modal-close" onclick="closeDataClearModal()">关闭</button></div>
<div class="modal-body">
  <div style="font-size:13px;line-height:1.65">此操作会删除所有方案、用户、密钥、配额和请求历史。系统会先创建本地备份，但当前配置将立即进入未配置状态。</div>
  <label for="dataClearPassword">后台密码</label>
  <input type="password" id="dataClearPassword" autocomplete="current-password" placeholder="输入后台密码以确认">
  <div class="inline-status" id="dataClearStatus" role="status"></div>
  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button type="button" class="btn btn-outline" onclick="closeDataClearModal()">取消</button><button type="button" class="btn btn-danger" onclick="clearAllData()">确认清空</button></div>
</div>
</div>
</div>
<script>
${TOAST_JS}
const SETTINGS=${settingsJson};
// Manual ops keyed by pool → user key (an op on the pool affects every member
// profile, so the badge lookup must follow the pool, not the profile).
const QUOTA_OPS_BY_POOL=${quotaOpsJson};
function qoKey(suffix,key){const p=(SETTINGS.quotaPools||[]).find(x=>x.profiles.some(m=>m.suffix===suffix));return p?p.name:suffix}
const NOTIFIER_CFG=${JSON.stringify(config.notifier || {}).replace(/</g, "\\x3c")};
const PAGE_CSRF="${CSRF_TOKEN}";
function getCsrf(){return PAGE_CSRF||(document.cookie.match(/tm_csrf=([^;]+)/)||[])[1]||''}
function csrfHeaders(h){h=h||{};h['x-csrf-token']=getCsrf();return h}
async function clearStickyBindings(){
  if(!confirm('确定清除所有粘性会话绑定？\\n清除后，所有会话的下一轮请求将从各自协议组头（默认方案）重新开始。'))return;
  const r=await fetch('/api/sticky/clear',{method:'POST',headers:csrfHeaders({})});
  if(r.ok){toast('粘性绑定已清除，请求将从各组默认方案重新开始')}
  else{alert('清除失败')}
}
async function clearRateLimitState(){
  if(!confirm('确定清除所有方案的限流状态？\\n清除后，所有方案立即恢复参与 failover，组头（如 Coding Plan）将在下一请求重新接管。'))return;
  const r=await fetch('/api/rate-limit/clear',{method:'POST',headers:csrfHeaders({})});
  if(r.ok){toast('限流状态已清除，各方案恢复参与 failover')}
  else{alert('清除失败')}
}
function h(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function openDateTimePicker(input){if(typeof input.showPicker==='function'){try{input.showPicker()}catch{}}}
let pendingImportData=null;
let pendingImportPreview=null;
function setImportStatus(message,type){const el=document.getElementById('dataImportStatus');el.textContent=message||'';el.className='inline-status '+(type||'')}
async function previewDataImport(){
  const file=document.getElementById('dataImportFile').files[0];
  if(!file){setImportStatus('请选择 data.json 文件','error');return}
  setImportStatus('正在解析文件','');
  try{
    pendingImportData=JSON.parse(await file.text());
    const r=await fetch('/api/data-import/preview',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({data:pendingImportData})});
    const result=await r.json();
    if(!r.ok)throw new Error(result.error||'预览失败');
    pendingImportPreview=result;
    const summary=result.summary||{};
    document.getElementById('dataImportSummary').innerHTML=[['用户',summary.users||0],['请求',summary.requests||0],['记录',summary.records||0],['日期',summary.minDate&&summary.maxDate?summary.minDate+' 至 '+summary.maxDate:'无日期']].map(function(item){return '<div class="import-stat"><b>'+h(item[1])+'</b><span>'+h(item[0])+'</span></div>'}).join('');
    document.getElementById('dataImportMappings').innerHTML=(result.sourceProfiles||[]).map(function(source){
      const options=['<option value="">请选择目标方案</option>'].concat(SETTINGS.profiles.map(function(profile){return '<option value="'+h(profile.suffix)+'" '+(source.matchedTarget===profile.suffix?'selected':'')+'>'+h(profile.name)+' /'+h(profile.suffix)+'</option>'})).concat(['<option value="skip">跳过此来源</option>']);
      return '<div class="mapping-row"><code>'+h(source.suffix)+'</code><span class="mapping-arrow">到</span><select class="data-import-map" data-source="'+h(source.suffix)+'">'+options.join('')+'</select></div>';
    }).join('');
    document.getElementById('dataImportPreview').classList.add('open');
    setImportStatus((result.warnings||[]).join('；')||'预览完成，请确认方案映射','ok');
  }catch(error){pendingImportData=null;pendingImportPreview=null;document.getElementById('dataImportPreview').classList.remove('open');setImportStatus(error.message||'文件格式无效','error')}
}
function toggleImportPassword(){document.getElementById('dataImportPasswordWrap').style.display=document.getElementById('dataImportMode').value==='replace'?'block':'none'}
async function applyDataImport(){
  if(!pendingImportData||!pendingImportPreview){setImportStatus('请先预览文件','error');return}
  const profileMap={};
  document.querySelectorAll('.data-import-map').forEach(function(select){profileMap[select.dataset.source]=select.value});
  if(Object.values(profileMap).some(function(value){return !value})){setImportStatus('请完成所有方案映射，或明确选择跳过','error');return}
  const mode=document.getElementById('dataImportMode').value;
  const password=document.getElementById('dataImportPassword').value;
  if(mode==='replace'&&!password){setImportStatus('替换模式需要输入后台密码','error');return}
  setImportStatus('正在导入，请勿关闭页面','');
  try{
    const r=await fetch('/api/data-import/apply',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({data:pendingImportData,sourceHash:pendingImportPreview.sourceHash,mode:mode,profileMap:profileMap,password:password})});
    const result=await r.json();
    if(!r.ok)throw new Error(result.error||'导入失败');
    setImportStatus('导入完成','ok');
    toast('数据导入完成');
  }catch(error){setImportStatus(error.message||'导入失败','error')}
}
function openDataClearModal(){const modal=document.getElementById('dataClearModal');modal.classList.add('open');document.getElementById('dataClearPassword').value='';document.getElementById('dataClearStatus').textContent='';document.getElementById('dataClearPassword').focus()}
function closeDataClearModal(){document.getElementById('dataClearModal').classList.remove('open')}
document.getElementById('dataClearModal').addEventListener('click',function(event){if(event.target===this)closeDataClearModal()});
async function clearAllData(){
  const password=document.getElementById('dataClearPassword').value;
  const status=document.getElementById('dataClearStatus');
  if(!password){status.textContent='请输入后台密码';status.className='inline-status error';return}
  status.textContent='正在创建备份并清空数据';status.className='inline-status';
  try{
    const r=await fetch('/api/data-clear',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({password:password})});
    const result=await r.json();
    if(!r.ok)throw new Error(result.error||'清空失败');
    toastThen('数据已清空，已自动备份',()=>location.reload());
  }catch(error){status.textContent=error.message||'清空失败';status.className='inline-status error'}
}
function openUserModal(){const sfx=document.getElementById('profileSuffixInput').value||SETTINGS.selectedProfileSuffix;document.getElementById('userProfileSel').value=sfx;renderProfileUsers(sfx);document.getElementById('userModal').classList.add('open')}
function closeUserModal(){document.getElementById('userModal').classList.remove('open')}
document.getElementById('userModal').addEventListener('click',function(e){if(e.target===this)closeUserModal()});
function openProfileModal(protocol){document.getElementById('profileModal').classList.add('open');if(protocol){var sel=document.getElementById('newProfileProtocol');sel.value=protocol;updateNewProfileProtocolHint()}document.getElementById('newProfileName').focus()}
// 限制直连 is ONE shared setting rendered in both protocol panes — keep the
// two checkboxes and the hidden form field in sync whichever one is toggled.
function setRestrictGroupSuffix(checked){
  document.getElementById('restrictGroupSuffixHidden').value=checked?'on':'off';
  var a=document.getElementById('restrictGroupSuffixCb'),b=document.getElementById('restrictGroupSuffixCb2');
  if(a)a.checked=checked;if(b)b.checked=checked;
}
// Protocol tabs: each pane owns its protocol's profiles; the failover group
// editors live in the bottom dock and swap with the same toggle. Switching tabs
// auto-selects the first profile of that protocol so the edit form and the
// highlighted card always match the visible tab. Persists across reloads.
function switchProtoTab(tab){
  document.querySelectorAll('#protoTabs .proto-tab').forEach(function(b){b.classList.toggle('on',b.dataset.tab===tab)});
  document.querySelectorAll('[data-proto]').forEach(function(p){p.style.display=(p.dataset.proto===tab)?'':'none'});
  try{localStorage.setItem('tm_settings_proto_tab',tab)}catch(e){}
  var first=(SETTINGS.profiles||[]).find(function(p){return (p.protocol==='responses')===(tab==='responses')});
  if(first&&first.name)editProfile(first.name);
}
function closeProfileModal(){document.getElementById('profileModal').classList.remove('open')}
document.getElementById('profileModal').addEventListener('click',function(e){if(e.target===this)closeProfileModal()});
async function switchToProfile(n){
  // No longer exclusive switch — just reload the profile into the form
  editProfile(n);
}
let editingProfileName="${escJs(initialProfile.name || '')}";
function updateAccessUrl(){
  const sfx=document.getElementById('suffixInput').value.trim();
  const p=SETTINGS.profiles.find(x=>x.name===editingProfileName);
  const defaultNote=p&&p.isDefault?' <span style="color:var(--green)">默认入口也可用 http://&lt;host&gt;:6789/v1</span>':'';
  document.getElementById('accessUrlPreview').innerHTML='接入地址: http://&lt;host&gt;:6789/'+h(sfx)+'/v1/messages'+defaultNote;
}
updateAccessUrl();
// ─── Peak hours editor (recurring daily ranges driving peak model aliases) ───
// Uses native <select> dropdowns (hours 00-23, minutes 00-59): fixed lists, no
// wheel-wrap like <input type="time">. Hidden peakStart/peakEnd inputs stay the
// form contract consumed by applySettings.
function addPeakHoursRow(start,end){
  const list=document.getElementById('peakHoursList');
  const row=document.createElement('div');
  row.style.cssText='display:flex;align-items:center;gap:6px;margin-bottom:6px';
  const sVal=/^\\d{2}:\\d{2}$/.test(start||'')?start:'09:00';
  const eVal=/^\\d{2}:\\d{2}$/.test(end||'')?end:'12:00';
  const selStyle='width:auto;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:3px 6px;border-radius:4px;font-size:12px';
  const opts=function(n,sel){var out='';for(var i=0;i<n;i++){var v=String(i).padStart(2,'0');out+='<option value="'+v+'"'+(v===sel?' selected':'')+'>'+v+'</option>'}return out};
  const [sh,sm]=sVal.split(':'),[eh,em]=eVal.split(':');
  row.innerHTML='<input type="hidden" name="peakStart" value="'+sVal+'"><input type="hidden" name="peakEnd" value="'+eVal+'">'
    +'<select data-peak="sh" style="'+selStyle+'">'+opts(24,sh)+'</select>:<select data-peak="sm" style="'+selStyle+'">'+opts(60,sm)+'</select>'
    +' <span style="color:var(--dim)">至</span> '
    +'<select data-peak="eh" style="'+selStyle+'">'+opts(24,eh)+'</select>:<select data-peak="em" style="'+selStyle+'">'+opts(60,em)+'</select>'
    +' <button type="button" class="btn btn-outline btn-sm" onclick="this.parentElement.remove();updatePeakHoursStatus()">删除</button>';
  row.querySelectorAll('select[data-peak]').forEach(function(sel){
    sel.addEventListener('change',syncPeakRow);
  });
  list.appendChild(row);
  updatePeakHoursStatus();
}
function syncPeakRow(e){
  const row=e.target.closest('div');
  if(!row)return;
  const q=k=>{const s=row.querySelector('select[data-peak="'+k+'"]');return s?s.value:'00'};
  const sh=row.querySelector('input[name="peakStart"]'),eh2=row.querySelector('input[name="peakEnd"]');
  if(sh)sh.value=q('sh')+':'+q('sm');
  if(eh2)eh2.value=q('eh')+':'+q('em');
  updatePeakHoursStatus();
}
function renderPeakHoursRows(ranges){
  const list=document.getElementById('peakHoursList');
  if(!list)return;
  list.innerHTML='';
  (ranges||[]).forEach(r=>addPeakHoursRow(r.start,r.end));
  updatePeakHoursStatus();
}
function collectPeakHours(){
  const rows=document.querySelectorAll('#peakHoursList > div');
  return Array.prototype.map.call(rows,function(row){
    const s=row.querySelector('input[name="peakStart"]'),e=row.querySelector('input[name="peakEnd"]');
    return {start:s?s.value:'',end:e?e.value:''};
  }).filter(r=>r.start&&r.end);
}
function nowInPeakHours(ranges){
  // Beijing time (UTC+8), so the hint matches the server-side peak judgment
  // regardless of the viewer's local timezone.
  const now=new Date(),cur=((now.getTime()+8*3600000)%86400000)/60000;
  const toMin=function(t){if(!t||!/^\\d{2}:\\d{2}$/.test(t))return null;const p=t.split(':');return parseInt(p[0],10)*60+parseInt(p[1],10)};
  return (ranges||[]).some(function(r){
    const s=toMin(r.start),e=toMin(r.end);
    if(s===null||e===null||s===e)return false;
    return s<e?(cur>=s&&cur<e):(cur>=s||cur<e);
  });
}
function updatePeakHoursStatus(){
  const el=document.getElementById('peakHoursStatus');
  if(!el)return;
  const ranges=collectPeakHours();
  if(!ranges.length){el.textContent='未设置时段';el.style.color='var(--dim)';}
  else if(nowInPeakHours(ranges)){el.textContent='当前处于高峰';el.style.color='var(--orange)'}
  else{el.textContent='当前不在高峰';el.style.color='var(--green)'}
  updateQuotaRateHint();
  // Peak/off-peak flip changes which column of every model rate is "current".
  try{updateRateRowsHint()}catch(e){}
}
// Quota-rate hint: the traps here matter more than the inputs themselves —
// an off-peak rate with no peak hours defined discounts the whole day, and
// every-slot-below-1.0 quietly inflates the nominal limit for everyone.
function updateQuotaRateHint(){
  const el=document.getElementById('quotaRateHint');
  if(!el)return;
  const peakEl=document.getElementById('peakQuotaRateInput'),offEl=document.getElementById('offPeakQuotaRateInput');
  if(!peakEl||!offEl){el.textContent='';return}
  const peak=Number(peakEl.value),off=Number(offEl.value);
  const ranges=collectPeakHours();
  const warn=function(t){el.innerHTML='<b style="color:var(--orange)">注意：'+t+'</b>';el.style.color='var(--orange)'};
  if(!Number.isFinite(peak)||!Number.isFinite(off)){warn('倍率必须是数字，非法值保存时会归一为 1.0');return}
  if(!ranges.length&&off!==1){warn('未设置高峰时段 — 低谷倍率 ×'+off+' 将全天生效');return}
  if(peak===0||off===0){warn('倍率为 0 的时段消耗完全不计入配额');return}
  if(peak<1&&off<1){warn('所有时段倍率均小于 1，名义限额将失去参照意义，建议保留一档为 1.0');return}
  const inPeak=ranges.length?nowInPeakHours(ranges):false;
  const cur=inPeak?peak:off;
  const limit=Number((document.forms.settingsForm&&document.forms.settingsForm.profileQuota||{}).value)||0;
  const equiv=(cur>0&&limit>0)?' · '+fmtRateTk(limit)+' 额度 ≈ '+fmtRateTk(Math.round(limit/cur))+' 实际 token':'';
  el.innerHTML='当前处于'+(inPeak?'高峰':'低谷')+' <b>×'+cur+'</b>（高峰 ×'+peak+' / 低谷 ×'+off+'）'+equiv;
  el.style.color='var(--dim)';
}
function fmtRateTk(n){n=Number(n)||0;if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'k';return String(n)}
['peakQuotaRateInput','offPeakQuotaRateInput'].forEach(function(id){
  var el=document.getElementById(id);
  if(el)el.addEventListener('input',function(){updateQuotaRateHint();try{updateRateRowsHint()}catch(e){}});
});
(function(){var q=document.forms.settingsForm&&document.forms.settingsForm.profileQuota;if(q)q.addEventListener('input',updateQuotaRateHint)})();
setInterval(updatePeakHoursStatus,30000);
// Initial render: fill rows for the profile the page was opened with.
(function(){
  var sfx=document.getElementById('profileSuffixInput')?document.getElementById('profileSuffixInput').value:'';
  var ps=SETTINGS.profiles||[];
  var p=ps.find(function(x){return x.suffix===sfx})||ps[0];
  renderPeakHoursRows((p&&p.peakHours)||[]);
})();
function openDataManagementView(){
  const form=document.getElementById('settingsForm');
  hideAllSecondaryViews();
  const view=document.getElementById('dataManagementView');
  form.hidden=true;
  view.hidden=false;
  view.setAttribute('aria-hidden','false');
  document.getElementById('dataManagementNav').classList.add('active');
}
function showProfileSettings(){
  const form=document.getElementById('settingsForm');
  const view=document.getElementById('dataManagementView');
  const audit=document.getElementById('auditLogView');
  const pool=document.getElementById('quotaPoolView');
  form.hidden=false;
  view.hidden=true;
  view.setAttribute('aria-hidden','true');
  audit.hidden=true;
  audit.setAttribute('aria-hidden','true');
  if(pool){pool.hidden=true;pool.setAttribute('aria-hidden','true')}
  document.getElementById('dataManagementNav').classList.remove('active');
  document.getElementById('auditLogNav').classList.remove('active');
  const pn=document.getElementById('quotaPoolNav');if(pn)pn.classList.remove('active');
}
function hideAllSecondaryViews(){
  const dm=document.getElementById('dataManagementView'),audit=document.getElementById('auditLogView'),pool=document.getElementById('quotaPoolView'),qr=document.getElementById('quotaRequestView');
  dm.hidden=true;dm.setAttribute('aria-hidden','true');
  audit.hidden=true;audit.setAttribute('aria-hidden','true');
  if(pool){pool.hidden=true;pool.setAttribute('aria-hidden','true')}
  if(qr){qr.hidden=true;qr.setAttribute('aria-hidden','true')}
  document.querySelectorAll('.pl-item').forEach(function(el){el.classList.remove('active')});
  // Nav buttons live outside .pl-item now, so clear their highlight explicitly.
  ['quotaPoolNav','dataManagementNav','auditLogNav','quotaRequestNav'].forEach(function(id){
    const el=document.getElementById(id);
    if(el)el.classList.remove('active');
  });
}
function openQuotaPoolView(){
  const form=document.getElementById('settingsForm');
  hideAllSecondaryViews();
  form.hidden=true;
  const view=document.getElementById('quotaPoolView');
  view.hidden=false;view.setAttribute('aria-hidden','false');
  document.getElementById('quotaPoolNav').classList.add('active');
}
// Reload should land back HERE, not on the profile form — admins adjusting
// several pools in a row shouldn't be kicked out of the view each save.
function rememberPoolViewForReload(){
  try{sessionStorage.setItem('tm_return_pool_view','1')}catch(e){}
}
// Collect a pool card's pool-level limit + per-user limits and POST to the single
// write path. The temporary-quota modal (bonus/reset) is separate and reaches the
// same pool via its representative profile suffix.
async function savePoolQuota(poolName){
  const card=document.querySelector('[data-poolcard="'+poolName+'"]');
  if(!card)return;
  const limitInput=card.querySelector('[data-poollimit="'+poolName+'"]');
  const users={};
  card.querySelectorAll('input[data-user]').forEach(inp=>{
    users[inp.dataset.user]=inp.value.trim()?parseInt(inp.value,10):null;
  });
  let r,data;
  try{
    r=await fetch('/api/quota-pool/save',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),
      body:JSON.stringify({pool:poolName,dailyTokenLimit:limitInput?limitInput.value.trim()||null:null,users})});
    data=await r.json();
  }catch(err){alert('保存失败: '+err.message);return}
  if(!r.ok){alert('保存失败: '+(data&&data.error?data.error:r.status));return}
  rememberPoolViewForReload();
  toastThen('额度池「'+(data.pool?data.pool.label:poolName)+'」已保存',()=>location.reload());
}
// Open the temporary-quota modal for a user from the pool view, using the pool's
// representative profile suffix so /api/quota/daily-op resolves the same pool.
function openQuotaOpFromPool(suffix,key){
  const sel=document.getElementById('userProfileSel');
  if(sel)sel.value=suffix;
  openQuotaOp(key);
}
function togglePoolCreate(){
  const row=document.getElementById('poolCreateRow');
  if(!row)return;
  row.style.display=row.style.display==='none'?'inline-flex':'none';
  if(row.style.display!=='none'){const inp=document.getElementById('newPoolName');if(inp)inp.focus()}
}
async function createPool(){
  const inp=document.getElementById('newPoolName');
  const name=inp?inp.value.trim():'';
  if(!name){alert('请填写额度池名称');return}
  let r,data;
  try{
    r=await fetch('/api/quota-pool/create',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({label:name})});
    data=await r.json().catch(()=>({}));
  }catch(err){alert('创建失败: '+err.message);return}
  if(!r.ok){alert('创建失败: '+(data.error||r.status));return}
  rememberPoolViewForReload();
  toastThen('额度池「'+name+'」已创建',()=>location.reload());
}
async function deletePool(name){
  if(!confirm('确定删除额度池「'+name+'」？该池当前没有成员方案，其池级限额与每人配额配置将一并删除。'))return;
  let r,data;
  try{
    r=await fetch('/api/quota-pool/delete',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({pool:name})});
    data=await r.json().catch(()=>({}));
  }catch(err){alert('删除失败: '+err.message);return}
  if(!r.ok){alert('删除失败: '+(data.error||r.status));return}
  rememberPoolViewForReload();
  toastThen('额度池已删除',()=>location.reload());
}
// ─── 操作日志（audit_log）───
let auditRows=[],auditOffset=0,auditCategory='',auditLoaded=false,auditTotal=0;
const AUDIT_PAGE=100;
function openAuditLogView(){
  const form=document.getElementById('settingsForm');
  hideAllSecondaryViews();
  form.hidden=true;
  const view=document.getElementById('auditLogView');
  view.hidden=false;view.setAttribute('aria-hidden','false');
  document.getElementById('auditLogNav').classList.add('active');
  if(!auditLoaded)loadAuditLog(true);
}
function auditActorBadge(a){
  if(a==='admin')return '<span style="color:var(--accent);font-weight:600">管理员</span>';
  if(a==='system')return '<span style="color:var(--blue);font-weight:600">系统</span>';
  if(a==='user')return '<span style="color:var(--green);font-weight:600">成员</span>';
  return '<span style="color:var(--orange);font-weight:600">'+h(a||'?')+'</span>';
}
// Coloured type tag next to the action code — makes check-in / request entries
// visually distinct even inside the "全部记录" view.
function auditCatTag(c){
  if(c==='checkin')return ' <span style="font-size:10px;background:var(--accent-soft);color:var(--green);padding:1px 6px;border-radius:4px;white-space:nowrap">签到</span>';
  if(c==='request')return ' <span style="font-size:10px;background:rgba(74,111,165,.14);color:#456b8a;padding:1px 6px;border-radius:4px;white-space:nowrap">申请</span>';
  return '';
}
function auditTime(iso){
  const d=new Date(iso);function p(n){return String(n).padStart(2,'0')}
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
}
async function loadAuditLog(reset){
  const status=document.getElementById('auditStatus');
  if(reset){auditOffset=0;auditRows=[]}
  status.textContent='加载中...';status.className='inline-status';
  try{
    const qs=['limit='+AUDIT_PAGE,'offset='+auditOffset];
    if(auditCategory)qs.push('category='+auditCategory);
    const r=await fetch('/api/audit-log?'+qs.join('&'));
    if(!r.ok)throw new Error('加载失败');
    const data=await r.json();
    auditRows=auditRows.concat(data.rows||[]);auditTotal=data.total||0;auditLoaded=true;
    renderAuditLog();
    status.textContent='共 '+auditTotal+' 条';status.className='inline-status';
  }catch(e){status.textContent=e.message||'加载失败';status.className='inline-status error'}
}
function loadMoreAudit(){auditOffset+=AUDIT_PAGE;loadAuditLog(false)}
// ─── 加量申请（quota_requests）───
let qrRows=[],qrFilterVal='pending';
function qrSwitchFilter(v){
  qrFilterVal=['pending','handled','rejected'].indexOf(v)>=0?v:'';
  document.querySelectorAll('#qrFilter button').forEach(function(b){b.classList.toggle('on',b.dataset.st===qrFilterVal)});
  loadQuotaRequests(true);
}
function updateQrPendingBadge(pending){
  const b=document.getElementById('qrPendingBadge');
  if(!b)return;
  if(pending>0){b.style.display='';b.textContent=pending}else{b.style.display='none'}
}
async function loadQrPendingBadge(){
  try{
    const r=await fetch('/api/quota-requests?limit=1');
    if(!r.ok)return;
    const j=await r.json();
    updateQrPendingBadge(j.pending||0);
  }catch(e){}
}
loadQrPendingBadge();
async function loadQuotaRequests(reset){
  const status=document.getElementById('qrStatus');
  status.textContent='加载中...';status.className='inline-status';
  try{
    const f=qrFilterVal;
    const r=await fetch('/api/quota-requests?limit=200'+(f?'&status='+f:''));
    if(!r.ok)throw new Error('加载失败');
    const data=await r.json();
    qrRows=data.rows||[];
    renderQuotaRequests(data.pending);
    status.textContent=qrRows.length+' 条'+(data.pending!=null?' · 待处理 '+data.pending+' 条':'');
    status.className='inline-status';
  }catch(e){status.textContent=e.message||'加载失败';status.className='inline-status error'}
}
function openQuotaRequestView(){
  const form=document.getElementById('settingsForm');
  hideAllSecondaryViews();
  form.hidden=true;
  const view=document.getElementById('quotaRequestView');
  view.hidden=false;view.setAttribute('aria-hidden','false');
  document.getElementById('quotaRequestNav').classList.add('active');
  loadQuotaRequests(true);
}
function qrRowBadge(s){
  if(s==='pending')return '<span style="color:var(--orange);font-weight:600">待处理</span>';
  if(s==='handled')return '<span style="color:var(--green);font-weight:600">已加量</span>';
  if(s==='rejected')return '<span style="color:var(--red);font-weight:600">已驳回</span>';
  return h(s||'?');
}
function renderQuotaRequests(pending){
  updateQrPendingBadge(pending);
  const tb=document.getElementById('qrBody');
  if(!qrRows.length){tb.innerHTML='<tr><td colspan="6" style="color:var(--dim);text-align:center;padding:18px">暂无申请</td></tr>';return}
  tb.innerHTML=qrRows.map(function(r){
    const ops=r.status==='pending'
      ?'<button type="button" class="btn btn-primary btn-sm" onclick="openQrGrant('+r.id+')">发放加量</button> <button type="button" class="btn btn-outline btn-sm" onclick="rejectQuotaRequest('+r.id+')">驳回</button>'
      :'<span style="font-size:11px;color:var(--dim)">'+h(r.admin_note||'-')+'</span>';
    return '<tr><td style="font-size:11px;color:var(--dim);white-space:nowrap">'+auditTime(r.created_at)+'</td>'
      +'<td style="font-weight:600">'+h(r.username||'-')+'</td>'
      +'<td style="font-weight:600">'+(r.poolLabel?h(r.poolLabel):'<span style="color:var(--dim)">-</span>')+'</td>'
      +'<td style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+h(r.reason||'')+'">'+h(r.reason||'-')+'</td>'
      +'<td>'+qrRowBadge(r.status)+'</td>'
      +'<td style="white-space:nowrap">'+ops+'</td></tr>';
  }).join('');
}
function openQrGrant(id){
  const r=qrRows.find(function(x){return x.id===id});
  if(!r||r.status!=='pending')return;
  document.getElementById('qrGrantUser').textContent=r.username||'-';
  document.getElementById('qrGrantReason').textContent='申请理由「'+(r.reason||'')+'」'+(r.poolLabel?' · 申请额度池：'+r.poolLabel:'');
  document.getElementById('qrGrantId').value=id;
  const sel=document.getElementById('qrGrantPool');
  sel.innerHTML=(r.pools&&r.pools.length?r.pools:[]).map(function(p){return '<option value="'+h(p.name)+'">'+h(p.label)+'</option>'}).join('');
  if(r.pool)sel.value=r.pool;
  document.getElementById('qrGrantAmount').value='';
  document.getElementById('qrGrantModal').classList.add('open');
}
function closeQrGrant(){document.getElementById('qrGrantModal').classList.remove('open')}
async function submitQrGrant(){
  const btn=document.getElementById('qrGrantSubmit');
  btn.disabled=true;
  try{
    const body={id:Number(document.getElementById('qrGrantId').value),pool:document.getElementById('qrGrantPool').value,amount:Number(document.getElementById('qrGrantAmount').value)};
    const r=await fetch('/api/quota-request/grant',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},csrfHeaders()),body:JSON.stringify(body)});
    const j=await r.json().catch(function(){return{}});
    if(!r.ok)throw new Error(j.error||'发放失败');
    toast('已发放加量并标记该申请为已处理');
    closeQrGrant();
    loadQuotaRequests(true);
  }catch(e){alert(e.message||'发放失败')}
  btn.disabled=false;
}
async function rejectQuotaRequest(id){
  const note=prompt('驳回备注（成员在其页面可见，可留空）：','');
  if(note===null)return;
  try{
    const r=await fetch('/api/quota-request/update',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},csrfHeaders()),body:JSON.stringify({id:id,status:'rejected',note:note})});
    const j=await r.json().catch(function(){return{}});
    if(!r.ok)throw new Error(j.error||'操作失败');
    toast('已驳回该申请');
    loadQuotaRequests(true);
  }catch(e){alert(e.message||'操作失败')}
}
function switchAuditFilter(v){
  auditCategory=['admin','system','auth','checkin','request'].indexOf(v)>=0?v:'';
  document.querySelectorAll('#auditFilter button').forEach(function(b){b.classList.toggle('on',b.dataset.cat===auditCategory)});
  loadAuditLog(true);
}
function renderAuditLog(){
  const tb=document.getElementById('auditBody');
  if(!auditRows.length){tb.innerHTML='<tr><td colspan="6" style="color:var(--dim);text-align:center;padding:18px">暂无记录</td></tr>'}
  else{
    tb.innerHTML=auditRows.map(function(r){
      return '<tr><td style="font-size:11px;color:var(--dim);white-space:nowrap">'+auditTime(r.time)+'</td>'
        +'<td>'+auditActorBadge(r.actor)+'</td>'
        +'<td><code style="font-size:11px;color:var(--accent)">'+h(r.action)+'</code>'+auditCatTag(r.category)+'</td>'
        +'<td style="font-size:11px">'+h(r.target||'-')+'</td>'
        +'<td style="font-size:12px;min-width:260px">'+h(r.detail||'')+'</td>'
        +'<td style="font-size:11px;color:var(--dim)">'+h(r.ip||'-')+'</td></tr>';
    }).join('');
  }
  document.getElementById('auditMoreBtn').hidden=auditRows.length>=auditTotal;
}
// ─── 通知设置（notifier）───
function initNotifierForm(){
  const n=NOTIFIER_CFG||{};
  document.getElementById('notifEnabled').checked=!!n.enabled;
  document.getElementById('notifRecovery').checked=n.notifyRecovery!==false;
  document.getElementById('notifFeishu').value=n.feishuWebhook||'';
  document.getElementById('notifDingtalk').value=n.dingtalkWebhook||'';
  document.getElementById('notifWecom').value=n.wecomWebhook||'';
  document.getElementById('notifServerchan').value=n.serverchanSendKey||'';
  document.getElementById('notifBarkKey').value=n.barkDeviceKey||'';
  document.getElementById('notifBarkServer').value=n.barkServer||'';
  document.getElementById('notifInterval').value=(n.minIntervalSeconds!==undefined?n.minIntervalSeconds:300);
}
function collectNotifier(){
  return {
    enabled:document.getElementById('notifEnabled').checked,
    notifyRecovery:document.getElementById('notifRecovery').checked,
    feishuWebhook:document.getElementById('notifFeishu').value.trim(),
    dingtalkWebhook:document.getElementById('notifDingtalk').value.trim(),
    wecomWebhook:document.getElementById('notifWecom').value.trim(),
    serverchanSendKey:document.getElementById('notifServerchan').value.trim(),
    barkDeviceKey:document.getElementById('notifBarkKey').value.trim(),
    barkServer:document.getElementById('notifBarkServer').value.trim(),
    minIntervalSeconds:parseInt(document.getElementById('notifInterval').value,10)||0
  };
}
function setNotifierStatus(text,cls){const el=document.getElementById('notifStatus');el.textContent=text||'';el.className='inline-status '+(cls||'')}
async function saveNotifier(){
  setNotifierStatus('保存中...');
  try{
    const r=await fetch('/api/notifier/save',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(collectNotifier())});
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||'保存失败');
    setNotifierStatus('已保存','ok');
    toast('通知设置已保存');
  }catch(e){setNotifierStatus(e.message||'保存失败','error')}
}
async function testNotifier(){
  setNotifierStatus('测试消息发送中，最长约 5 秒...');
  try{
    const r=await fetch('/api/notifier/test',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify(collectNotifier())});
    const data=await r.json();
    if(!r.ok)throw new Error(data.error||'测试失败');
    const parts=(data.results||[]).map(function(x){return x.channel+(x.ok?' ✓':' ✗ '+(x.error||'失败'))});
    const allOk=(data.results||[]).length>0&&(data.results||[]).every(function(x){return x.ok});
    setNotifierStatus(parts.join('；'),allOk?'ok':'error');
  }catch(e){setNotifierStatus(e.message||'测试失败','error')}
}
initNotifierForm();
// ─── Stats cleanup (residual user/model stats) ───
let cleanupData={users:[],models:[]},cleanupTab='users',cleanupLoaded=false;
function fmtCleanupNum(n){return Number(n||0).toLocaleString('zh-CN')}
function fmtCleanupTk(n){n=Number(n||0);if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'k';return String(n)}
function cleanupAgo(iso){if(!iso)return'-';const d=Date.now()-new Date(iso).getTime();const m=Math.floor(d/6e4);if(m<1)return'刚刚';if(m<60)return m+'分钟前';const hr=Math.floor(m/60);if(hr<24)return hr+'小时前';return Math.floor(hr/24)+'天前'}
function maskCleanupKey(k){const v=String(k||'');return v.length<=12?v:v.slice(0,8)+'****'+v.slice(-4)}
async function loadCleanupList(){
  const status=document.getElementById('cleanupStatus');
  status.textContent='正在加载...';status.className='inline-status';
  try{
    const r=await fetch('/api/stats-cleanup/list');if(!r.ok)throw new Error('加载失败');
    cleanupData=await r.json();cleanupLoaded=true;renderCleanup();
    status.textContent='';status.className='inline-status';
  }catch(e){status.textContent=e.message||'加载失败';status.className='inline-status error'}
}
function switchCleanupTab(t){
  cleanupTab=t;
  document.querySelectorAll('.cleanup-tab').forEach(b=>b.classList.toggle('on',b.dataset.t===t));
  document.getElementById('cleanupUsersView').hidden=(t!=='users');
  document.getElementById('cleanupModelsView').hidden=(t!=='models');
  if(!cleanupLoaded)loadCleanupList();else renderCleanup();
}
function renderCleanup(){
  document.getElementById('cleanupUserCount').textContent=cleanupData.users.length;
  document.getElementById('cleanupModelCount').textContent=cleanupData.models.length;
  const ub=document.getElementById('cleanupUsersBody');
  if(!cleanupData.users.length){ub.innerHTML='<tr><td colspan="6" style="color:var(--dim);text-align:center;padding:18px">暂无用户统计数据</td></tr>'}
  else{ub.innerHTML=cleanupData.users.map(u=>{
    const orphan=!u.existsInConfig;const bg='style="background:'+(orphan?'#fff5f3':'transparent')+'"';
    const nameCell=orphan?'<span style="color:var(--red)">'+h(u.name)+'</span> <span style="color:var(--red);font-size:10px">(未配置)</span>':h(u.name);
    const cfgCell=orphan?'<span style="color:var(--red);font-size:11px">无</span>':'<span style="color:var(--green);font-size:11px">有</span>';
    return '<tr '+bg+'><td><code style="font-size:11px">'+h(maskCleanupKey(u.key))+'</code></td><td>'+nameCell+'</td><td class="n">'+fmtCleanupNum(u.requests)+'</td><td style="font-size:11px;color:var(--dim)">'+cleanupAgo(u.lastActive)+'</td><td>'+cfgCell+'</td><td><button type="button" class="btn btn-outline btn-sm cleanup-del-user" data-key="'+h(u.key)+'">删除</button></td></tr>';
  }).join('')}
  const mb=document.getElementById('cleanupModelsBody');
  if(!cleanupData.models.length){mb.innerHTML='<tr><td colspan="4" style="color:var(--dim);text-align:center;padding:18px">暂无模型统计数据</td></tr>'}
  else{mb.innerHTML=cleanupData.models.map(m=>{
    return '<tr><td><code style="font-size:11px">'+h(m.model)+'</code></td><td class="n">'+fmtCleanupNum(m.requests)+'</td><td class="n">'+fmtCleanupTk(m.tokens)+'</td><td><button type="button" class="btn btn-outline btn-sm cleanup-del-model" data-model="'+h(m.model)+'">删除</button></td></tr>';
  }).join('')}
  ub.querySelectorAll('.cleanup-del-user').forEach(b=>b.addEventListener('click',()=>deleteCleanupUser(b.dataset.key)));
  mb.querySelectorAll('.cleanup-del-model').forEach(b=>b.addEventListener('click',()=>deleteCleanupModel(b.dataset.model)));
}
async function deleteCleanupUser(key){
  if(!confirm('确定删除该用户的所有统计数据？\\nKey: '+maskCleanupKey(key)+'\\n此操作只清理统计数据，不影响 config.json 配置，执行前自动备份。'))return;
  const status=document.getElementById('cleanupStatus');
  status.textContent='正在删除并备份...';status.className='inline-status';
  try{
    const r=await fetch('/api/stats-user/delete',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({key:key})});
    const result=await r.json();if(!r.ok)throw new Error(result.error||'删除失败');
    status.textContent='已删除用户残留统计';status.className='inline-status ok';
    toast('已删除用户残留统计');
    cleanupData.users=cleanupData.users.filter(u=>u.key!==key);renderCleanup();
  }catch(e){status.textContent=e.message||'删除失败';status.className='inline-status error'}
}
async function deleteCleanupModel(model){
  if(!confirm('确定删除该模型的所有统计数据？\\n模型: '+model+'\\n此操作只清理统计数据，不影响 config.json 配置，执行前自动备份。'))return;
  const status=document.getElementById('cleanupStatus');
  status.textContent='正在删除并备份...';status.className='inline-status';
  try{
    const r=await fetch('/api/stats-model/delete',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({model:model})});
    const result=await r.json();if(!r.ok)throw new Error(result.error||'删除失败');
    status.textContent='已删除模型残留统计';status.className='inline-status ok';
    toast('已删除模型残留统计');
    cleanupData.models=cleanupData.models.filter(m=>m.model!==model);renderCleanup();
  }catch(e){status.textContent=e.message||'删除失败';status.className='inline-status error'}
}
async function editProfile(n){
  const p=SETTINGS.profiles.find(x=>x.name===n);
  if(!p)return;
  showProfileSettings();
  editingProfileName=n;
  // Pool summary follows the select; declared before use inside the fn body.
  ;
  window.updatePoolSummary=function(){
    const sel=document.getElementById('quotaPoolSelect'),el=document.getElementById('poolSummary');
    if(!sel||!el)return;
    const name=sel.value;
    if(name==='__new__'){el.innerHTML='将在保存时新建一个与方案同名的额度池';return}
    const pool=(SETTINGS.quotaPools||[]).find(x=>x.name===name);
    if(!pool){el.innerHTML='未关联额度池';return}
    const memberNames=pool.profiles.map(m=>m.name).join('、');
    const limit=pool.dailyTokenLimit?('池级上限 '+pool.dailyTokenLimit.toLocaleString('zh-CN')):'池级不限制';
    const nUsers=Object.keys(pool.userLimits||{}).length;
    el.innerHTML='本池成员：'+h(memberNames)+' · '+h(limit)+' · '+nUsers+' 人有个人配额'
      +(pool.profiles.length>1?'<br><b style="color:var(--orange)">注意：此方案保存后，其用量与额度立即与上述方案合并计算</b>':'');
  };
  const fm=document.forms.settingsForm;
  fm.upstream.value=p.upstream||'';
  document.getElementById('suffixInput').value=p.suffix||'';
  document.getElementById('profileNameInput').value=p.name||'';
  renderAliasRows(p);
  const poolSel=document.getElementById('quotaPoolSelect');if(poolSel)poolSel.value=p.quotaPool||'__new__';
  updatePoolSummary();
  const pqr=document.getElementById('peakQuotaRateInput');if(pqr)pqr.value=(p.peakQuotaRate??1);
  const oqr=document.getElementById('offPeakQuotaRateInput');if(oqr)oqr.value=(p.offPeakQuotaRate??1);
  const bt=fm.querySelector('select[name="billingType"]');if(bt)bt.value=p.billingType||'on_demand';
  renderPeakHoursRows(p.peakHours||[]);
  refreshBridgeSelect(p);
  document.querySelectorAll('.pl-item').forEach(el=>el.classList.remove('active'));
  const el=document.getElementById('pl-'+n);
  if(el)el.classList.add('active');
  document.getElementById('profileSuffixInput').value=p.suffix||'';
  const userSel=document.getElementById('userProfileSel');
  if(userSel){userSel.value=p.suffix||'';renderProfileUsers(p.suffix||'')}
  updateAccessUrl();
}
function updateNewProfileProtocolHint(){
  var isResp=document.getElementById('newProfileProtocol').value==='responses';
  document.getElementById('newProfileUpstream').placeholder=isResp?'https://open.bigmodel.cn/api/v1':'https://open.bigmodel.cn/api/anthropic';
  document.getElementById('newProfileProtocolNote').textContent=isResp?'Codex 走 /v1/responses，上游必须是原生 Responses 端点（如智谱 /api/v1）。':'Claude Code 走 /v1/messages；Codex 走 /v1/responses。两种协议的方案完全隔离。';
}
async function createProfile(){
  const name=document.getElementById('newProfileName').value.trim();
  const suffix=document.getElementById('newProfileSuffix').value.trim();
  const upstream=document.getElementById('newProfileUpstream').value.trim();
  const protocol=document.getElementById('newProfileProtocol').value;
  if(!name||!suffix||!upstream){alert('方案名称、URL 后缀和上游 API 地址必填');return}
  const r=await fetch('/api/profile/save',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({
    profile:name,suffix:suffix,upstream:upstream,
    protocol:protocol,quotaPool:document.getElementById('newProfilePool')?.value||''
  })});
  if(r.ok)toastThen('方案已创建 — 点击左侧方案配置模型别名',()=>location.reload());else{const e=await r.json();alert('创建失败: '+e.error)}
}
async function setDefaultProfile(n,protocol){
  const r=await fetch('/api/profile/default',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({profile:n,protocol:protocol||'anthropic'})});
  if(r.ok)toastThen('已设为默认方案',()=>location.reload());else{const e=await r.json();alert('设置失败: '+e.error)}
}
async function deleteProfile(n){
  if(!confirm('确定删除方案 "'+n+'"？'))return;
  const r=await fetch('/api/profile/delete',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({profile:n})});
  if(r.ok)toastThen('方案已删除',()=>location.reload());else{const e=await r.json();alert('删除失败: '+e.error)}
}
async function saveDefaultGroup(group){
  const r=await fetch('/api/profile/default-group',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({group:group,protocol:'anthropic'})});
  if(r.ok)toastThen('默认方案组已保存',()=>location.reload());else{const e=await r.json().catch(()=>({}));alert('保存失败: '+(e.error||''))}
}
function currentDefaultGroupFromDom(){return Array.prototype.map.call(document.querySelectorAll('#defaultGroupList .group-item'),function(el){return el.dataset.name})}
async function addToDefaultGroup(n){const g=currentDefaultGroupFromDom();if(!g.includes(n))g.push(n);saveDefaultGroup(g)}
async function removeFromDefaultGroup(n){saveDefaultGroup(currentDefaultGroupFromDom().filter(function(x){return x!==n}))}
async function moveDefaultGroup(n,d){const g=currentDefaultGroupFromDom();const i=g.indexOf(n);if(i<0)return;const j=i+d;if(j<0||j>=g.length)return;g.splice(i,1);g.splice(j,0,n);saveDefaultGroup(g)}
async function saveResponsesGroup(group){
  const r=await fetch('/api/profile/default-group',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({group:group,protocol:'responses'})});
  if(r.ok)toastThen('OpenAI 方案组已保存',()=>location.reload());else{const e=await r.json().catch(()=>({}));alert('保存失败: '+(e.error||''))}
}
function currentResponsesGroupFromDom(){return Array.prototype.map.call(document.querySelectorAll('#responsesGroupList .group-item'),function(el){return el.dataset.name})}
async function addToResponsesGroup(n){const g=currentResponsesGroupFromDom();if(!g.includes(n))g.push(n);saveResponsesGroup(g)}
async function removeFromResponsesGroup(n){saveResponsesGroup(currentResponsesGroupFromDom().filter(function(x){return x!==n}))}
async function moveResponsesGroup(n,d){const g=currentResponsesGroupFromDom();const i=g.indexOf(n);if(i<0)return;const j=i+d;if(j<0||j>=g.length)return;g.splice(i,1);g.splice(j,0,n);saveResponsesGroup(g)}
// ── 方案组「加入」弹卡：贴组区右侧，点选即加（reload 后自然关闭）──
let _groupPopId=null;
function toggleGroupAddPop(id,btn){
  const pop=document.getElementById(id);
  if(!pop)return;
  if(_groupPopId===id){closeGroupAddPop();return}
  closeGroupAddPop();
  pop.style.display='flex';
  const r=btn.getBoundingClientRect(),w=pop.offsetWidth;
  let left=r.right+8;
  if(left+w>innerWidth-8)left=Math.max(8,r.right-w);
  pop.style.left=left+'px';
  pop.style.top=Math.min(r.top,innerHeight-pop.offsetHeight-8)+'px';
  _groupPopId=id;
}
function closeGroupAddPop(){document.querySelectorAll('.group-add-pop').forEach(function(p){p.style.display='none'});_groupPopId=null}
document.addEventListener('click',function(e){
  if(!_groupPopId)return;
  if(e.target.closest('.group-add-pop')||e.target.closest('[data-grouppop-btn]'))return;
  closeGroupAddPop();
},true);
async function deleteGlobalUser(k){
  if(!confirm('确定删除用户？该用户将从所有方案中移除。'))return;
  const r=await fetch('/api/global-user/delete',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({key:k})});
  if(r.ok)toastThen('用户已删除',()=>location.reload());else{const e=await r.json();alert('删除失败: '+e.error)}
}
function renderProfileUsers(suffix){
  const assignments=SETTINGS.profileAssignments[suffix]||{};
  const tbody=document.querySelector("#profileUsersTable tbody");
  tbody.innerHTML=Object.entries(SETTINGS.globalUsers).map(([k,v])=>{
    const username=v.username||'';
    const globalDisabled=!!v.disabled;
    const pu=assignments[k]||null;
    const realKey=(pu&&pu.key)||'';
    const profileDisabled=!!(pu&&pu.disabled);
    const rowStyle=globalDisabled?'opacity:0.4':'';
    return '<tr style="'+rowStyle+'">'
      +'<td><code style="font-size:11px;color:var(--accent)">'+h(k)+'</code></td>'
      +'<td>'+h(username)+'</td>'
      +'<td><input type="text" name="pu_rk_'+h(k)+'" value="'+h(realKey)+'" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px;font-family:monospace" placeholder="真实Key (留空=不可用此方案)"></td>'
      +'<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer"><input type="checkbox" name="pu_dis_'+h(k)+'" '+(profileDisabled?'checked':'')+' style="width:auto;accent-color:var(--orange)"><span style="font-size:11px;color:'+(profileDisabled?'var(--orange)':'var(--dim)')+'">'+(profileDisabled?'已禁用':'正常')+'</span></label></td></tr>';
  }).join('');
}
function switchUserProfile(suffix){renderProfileUsers(suffix)}
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
  const profileSuffix=document.getElementById('userProfileSel').value;
  const r=await fetch('/api/global-user/save',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({users,profileUsers,profileSuffix})});
  if(r.ok){toastThen('用户配置已保存',()=>location.reload())}else{const e=await r.json();alert('保存失败: '+e.error)}
}
// ── 今日临时额度（bonus / reset）弹窗 ──────────────────────────────────────
function qFmt(n){n=Number(n)||0;if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'k';return String(n)}
const QUOTA_OP_CTX={suffix:'',key:''};
function qoOp(){const pool=QUOTA_OPS_BY_POOL[qoKey(QUOTA_OP_CTX.suffix,'')];return pool?pool[QUOTA_OP_CTX.key]:undefined}
function openQuotaOp(key){
  const suffix=document.getElementById('userProfileSel').value;
  QUOTA_OP_CTX.suffix=suffix;QUOTA_OP_CTX.key=key;
  const username=((SETTINGS.globalUsers||{})[key]||{}).username||key.slice(0,8);
  const profile=(SETTINGS.profiles||[]).find(p=>p.suffix===suffix)||{};
  const pool=(SETTINGS.quotaPools||[]).find(p=>p.profiles.some(m=>m.suffix===suffix));
  const userLimit=pool?((pool.userLimits||{})[key]||0):0;
  const poolLimit=pool?(pool.dailyTokenLimit||0):0;
  const base=userLimit>0?userLimit:poolLimit;
  // Note the unit when weighting is on: bonus/reset amounts are weighted tokens,
  // not raw ones, so an admin typing "1,000,000" is granting 1M of quota currency.
  const weighted=(profile.peakQuotaRate!==undefined&&(profile.peakQuotaRate!==1||profile.offPeakQuotaRate!==1));
  const poolNote=pool&&pool.profiles.length>1?' · 额度池「'+h(pool.label)+'」'+pool.profiles.length+' 个方案共用':'';
  document.getElementById('qoTitle').textContent='临时额度 · '+username;
  document.getElementById('qoInfo').innerHTML='额度池：'+h(pool?pool.label:'')+' · 基础每日配额：'+(base>0?(base.toLocaleString('zh-CN')+(userLimit>0?'（个人）':'（池级）')+(poolNote)+(weighted?' <span style="color:var(--accent)">· 计权口径（峰 ×'+profile.peakQuotaRate+' / 谷 ×'+profile.offPeakQuotaRate+'）</span>':'')):'<span style="color:var(--orange)">未设置（当前无限制）</span>');
  document.getElementById('qoBonusInput').value='';
  const noBase=!(base>0);
  document.getElementById('qoSetBtn').disabled=noBase;
  document.getElementById('qoResetBtn').disabled=noBase;
  document.getElementById('qoResetBtn').title=noBase?'该用户与额度池均未设置每日配额，无限制状态下无需重置':'';
  qoRenderStatus();
  document.getElementById('quotaOpModal').classList.add('open');
}
function closeQuotaOpModal(){document.getElementById('quotaOpModal').classList.remove('open')}
document.getElementById('quotaOpModal').addEventListener('click',function(e){if(e.target===this)closeQuotaOpModal()});
function qoRenderStatus(q){
  const op=qoOp();
  const parts=[];
  if(op&&op.bonus>0)parts.push('<span style="font-size:11px;color:var(--green);border:1px solid var(--green);border-radius:3px;padding:1px 5px">今日临时 +'+qFmt(op.bonus)+'</span>');
  if(op&&op.reset_baseline>0)parts.push('<span style="font-size:11px;color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:1px 5px">今日已重置</span>');
  if(q&&q.limit>0)parts.push('<span style="font-size:11px;color:var(--dim)">生效额度 '+q.limit.toLocaleString('zh-CN')+' · 已用 '+q.used.toLocaleString('zh-CN')+' · 剩余 '+q.remaining.toLocaleString('zh-CN')+'</span>');
  if(q&&q.rawUsed!=null&&q.rawUsed!==q.used){const d=q.rawUsed-q.used;parts.push('<span style="font-size:11px;color:var(--accent)">实际 '+q.rawUsed.toLocaleString('zh-CN')+'（'+(q.inPeak?'高峰':'低谷')+' ×'+q.rate+(d>0?' 已抵扣 '+qFmt(d):' 已加收 '+qFmt(-d))+'）</span>')}
  if(!op&&!q)parts.push('<span style="font-size:12px;color:var(--dim)">今日暂无手工操作</span>');
  document.getElementById('qoStatus').innerHTML=parts.join(' ');
  document.getElementById('qoClearBtn').style.display=op?'':'none';
}
function qoQuickAdd(n){const el=document.getElementById('qoBonusInput');el.value=((parseInt(el.value,10)||0)+n)}
async function qoPost(action,amount){
  let r,data;
  try{
    r=await fetch('/api/quota/daily-op',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({profileSuffix:QUOTA_OP_CTX.suffix,key:QUOTA_OP_CTX.key,action:action,amount:amount})});
    data=await r.json();
  }catch(err){alert('操作失败: '+err.message);return null}
  if(!r.ok){alert('操作失败: '+(data&&data.error?data.error:r.status));return null}
  const poolName=qoKey(QUOTA_OP_CTX.suffix,'');
  if(data.quota&&(data.quota.bonus>0||data.quota.resetApplied)){
    (QUOTA_OPS_BY_POOL[poolName]=QUOTA_OPS_BY_POOL[poolName]||{})[QUOTA_OP_CTX.key]={bonus:data.quota.bonus||0,reset_baseline:data.quota.resetApplied?1:0};
  } else if(QUOTA_OPS_BY_POOL[poolName]) {
    delete QUOTA_OPS_BY_POOL[poolName][QUOTA_OP_CTX.key];
  }
  renderProfileUsers(QUOTA_OP_CTX.suffix);
  return data.quota;
}
async function qoSetBonus(){
  const raw=document.getElementById('qoBonusInput').value.trim();
  const n=parseInt(raw===''?'0':raw,10);
  if(isNaN(n)||n<0){alert('请输入 ≥0 的整数 token 数');return}
  const q=await qoPost('bonus',n);
  if(q){toast(n>0?('已设置今日临时加量 +'+qFmt(n)+'，明日自动失效'):'已清除今日临时加量');qoRenderStatus(q)}
}
async function qoReset(){
  if(!confirm('确定重置该用户今日用量？\\n配额将立即恢复满额，可继续使用；用量统计与报表数据保留不动。'))return;
  const q=await qoPost('reset');
  if(q){toast('今日用量已重置');qoRenderStatus(q)}
}
async function qoClear(){
  if(!confirm('确定撤销该用户今日全部手工额度操作（临时加量与重置）？'))return;
  const q=await qoPost('clear');
  if(q){toast('已撤销今日手工额度操作');qoRenderStatus(q)}
}
function genVK(){const c="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";const a=new Uint8Array(24);crypto.getRandomValues(a);let k="jx-";for(let i=0;i<24;i++)k+=c[a[i]%c.length];return k}
function addGlobalUser(){
  const tbody=document.querySelector("#globalUsersTable tbody");
  const tr=document.createElement("tr");
  const vk=genVK();
  tr.innerHTML='<td><code style="font-size:11px;color:var(--accent);user-select:all">'+vk+'</code><input type="hidden" name="gu_new_'+vk+'" value="'+vk+'"></td>'
    +'<td><input type="text" name="gu_un_new_'+vk+'" placeholder="用户名" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px"></td>'
    +'<td><input type="datetime-local" name="gu_ex_new_'+vk+'" onclick="openDateTimePicker(this)" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:3px 6px;border-radius:4px;font-size:11px"></td>'
    +'<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer"><input type="checkbox" name="gu_dis_new_'+vk+'" style="width:auto;accent-color:var(--red)"><span style="font-size:11px;color:var(--dim)">正常</span></label></td>'
    +'<td><button type="button" onclick="this.closest(\\'tr\\').remove()" style="background:#fff2f0;color:var(--red);border:1px solid #f1c8c2;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px">删除</button></td>';
  tbody.appendChild(tr);
  SETTINGS.globalUsers[vk]={username:'',expiresAt:'',disabled:false};
  for(const p of SETTINGS.profiles){if(!SETTINGS.profileAssignments[p.suffix])SETTINGS.profileAssignments[p.suffix]={}}
  renderProfileUsers(document.getElementById('userProfileSel').value);
}
function fillUpstream(url){
  document.querySelector('[name=upstream]').value=url;
}
// ── 模型别名的结构化行编辑器 ─────────────────────────────────────────────
// 通用别名行 ma_alias_N/ma_model_N/ma_ctx_N；高峰覆盖行 pa_alias_N/pa_model_N。
// 行增删后统一重排索引；允许模型标签实时汇总所有实际模型。
const CW_OPTIONS=[[32768,'32K（32,768）'],[65536,'64K（65,536）'],[128000,'128K（128,000）'],[200000,'200K（200,000）'],[262144,'256K（262,144）'],[400000,'400K（400,000）'],[1048576,'1M（1,048,576）']];
function cwSelectHtml(name,val){return '<select name="'+name+'">'+CW_OPTIONS.map(o=>'<option value="'+o[0]+'"'+(String(o[0])===String(val||128000)?' selected':'')+'>'+o[1]+'</option>').join('')+'</select>'}
function renumberRows(prefix){
  const wrap=prefix==='ma'?document.getElementById('aliasRows'):prefix==='mr'?document.getElementById('rateRows'):document.getElementById('peakRows');
  const rows=[...wrap.querySelectorAll('.alias-row')];
  rows.forEach((row,i)=>{row.querySelectorAll('[name^="'+prefix+'_"]').forEach(el=>{
    const parts=el.name.split('_');el.name=prefix+'_'+parts[1]+'_'+i;});});
}
function collectAliasRows(){
  return [...document.querySelectorAll('#aliasRows .alias-row')].map(row=>({
    alias:row.querySelector('[name^="ma_alias_"]').value.trim(),
    model:row.querySelector('[name^="ma_model_"]').value.trim(),
  }));
}
function refreshPeakSelects(){
  const names=collectAliasRows().filter(r=>r.alias).map(r=>r.alias);
  document.querySelectorAll('#peakRows .alias-row select[name^="pa_alias_"]').forEach(sel=>{
    const keep=sel.value;sel.innerHTML='<option value="">选择别名…</option>'+names.map(n=>'<option value="'+n+'"'+(n===keep?' selected':'')+'>'+n+'</option>').join('');
    if(keep&&!names.includes(keep))sel.value='';
  });
}
function updateAllowedTags(){
  const models=[...new Set([...document.querySelectorAll('#aliasRows [name^="ma_model_"], #peakRows [name^="pa_model_"]')].map(el=>el.value.trim()).filter(Boolean))];
  const box=document.getElementById('allowedTags');
  box.innerHTML=models.length?models.map(m=>'<span class="m-tag">'+m.replace(/</g,'&lt;')+'</span>').join(''):'<span class="m-empty">暂无——填入别名实际模型后自动生成</span>';
}
function aliasRowEl(alias,model,cw,mm){
  const div=document.createElement('div');div.className='alias-row';
  div.innerHTML='<input type="text" name="ma_alias_0" value="'+String(alias||'').replace(/"/g,'&quot;')+'" placeholder="别名，如 jx-opus" list="stdAliasList">'
    +'<input type="text" name="ma_model_0" value="'+String(model||'').replace(/"/g,'&quot;')+'" placeholder="实际模型，如 glm-5.3">'
    +cwSelectHtml('ma_ctx_0',cw||128000)
    +'<label class="mm-cell" title="勾选=该别名原生支持视觉（图片直通，且可作为图片识别辅助模型）；不勾选=该别名贴图时由网关自动转述">'
    +'<input type="checkbox" name="ma_mm_0"'+(mm!==false?' checked':'')+'>图</label>'
    +'<button type="button" class="row-del" title="删除该行">×</button>';
  div.querySelector('.row-del').onclick=()=>{div.remove();renumberRows('ma');refreshPeakSelects();updateAllowedTags()};
  return div;
}
function peakRowEl(alias,model){
  const div=document.createElement('div');div.className='alias-row peak';
  div.innerHTML='<select name="pa_alias_0"></select>'
    +'<input type="text" name="pa_model_0" value="'+String(model||'').replace(/"/g,'&quot;')+'" placeholder="高峰期实际模型">'
    +'<button type="button" class="row-del" title="删除该行">×</button>';
  div.querySelector('.row-del').onclick=()=>{div.remove();renumberRows('pa');updateAllowedTags()};
  return div;
}
function addAliasRow(presetName){
  const row=aliasRowEl(presetName||'','',128000,true);
  document.getElementById('aliasRows').appendChild(row);
  renumberRows('ma');refreshPeakSelects();updateAllowedTags();
  (presetName?row.querySelector('[name^="ma_model_"]'):row.querySelector('[name^="ma_alias_"]')).focus();
}
function addPeakRow(){document.getElementById('peakRows').appendChild(peakRowEl('',''));renumberRows('pa');refreshPeakSelects();updateAllowedTags()}
// ── Per-model quota rates ────────────────────────────────────────────────────
// Keyed on the REAL model name (what the upstream echoes and what the usage
// tables store), picked from a dropdown of the profile's alias targets so a typo
// cannot silently fall back to the default rate.
function allRateModels(){
  return [...new Set([...document.querySelectorAll('#aliasRows [name^="ma_model_"], #peakRows [name^="pa_model_"]')]
    .map(el=>el.value.trim()).filter(Boolean))].sort();
}
function rateRowEl(model,peak,off){
  const div=document.createElement('div');div.className='alias-row rate';
  div.innerHTML='<select name="mr_model_0"></select>'
    +'<input type="number" name="mr_peak_0" min="0" max="${QUOTA_RATE_MAX}" step="0.05" value="'+(peak==null?'':peak)+'" placeholder="高峰">'
    +'<input type="number" name="mr_off_0" min="0" max="${QUOTA_RATE_MAX}" step="0.05" value="'+(off==null?'':off)+'" placeholder="低谷">'
    +'<span class="rate-eff"></span>'
    +'<button type="button" class="row-del" title="删除该行">×</button>';
  div.querySelector('.row-del').onclick=()=>{div.remove();renumberRows('mr');updateRateRowsHint()};
  div.addEventListener('input',updateRateRowsHint);
  refreshRateSelect(div.querySelector('select[name^="mr_model_"]'),model);
  return div;
}
function refreshRateSelect(sel,want){
  if(!sel)return;
  const keep=want!==undefined?want:sel.value;
  const models=allRateModels();
  sel.innerHTML='<option value="">选择模型…</option>'+models.map(m=>'<option value="'+m.replace(/"/g,'&quot;')+'"'+(m===keep?' selected':'')+'>'+m.replace(/</g,'&lt;')+'</option>').join('');
  // A rate configured for a model no longer referenced by any alias would vanish
  // silently on save; keep it visible and explicitly flagged instead.
  if(keep&&!models.includes(keep)){
    sel.insertAdjacentHTML('beforeend','<option value="'+keep.replace(/"/g,'&quot;')+'">'+keep.replace(/</g,'&lt;')+'（未在别名中引用）</option>');
  }
  sel.value=keep||'';
}
function refreshAllRateSelects(){
  document.querySelectorAll('#rateRows select[name^="mr_model_"]').forEach(sel=>refreshRateSelect(sel));
  updateRateRowsHint();
}
function addRateRow(model,peak,off){
  document.getElementById('rateRows').appendChild(rateRowEl(model||'',peak,off));
  renumberRows('mr');updateRateRowsHint();
}
// Convenience: one row per model still lacking an explicit rate, prefilled with
// the profile default so the admin edits numbers instead of hunting model names.
function fillAllRateRows(){
  const have=new Set([...document.querySelectorAll('#rateRows select[name^="mr_model_"]')].map(s=>s.value).filter(Boolean));
  const dp=Number(document.getElementById('peakQuotaRateInput').value),
        dof=Number(document.getElementById('offPeakQuotaRateInput').value);
  allRateModels().filter(m=>!have.has(m)).forEach(m=>addRateRow(m,Number.isFinite(dp)?dp:1,Number.isFinite(dof)?dof:1));
}
function renderRateRows(profile){
  const wrap=document.getElementById('rateRows');
  if(!wrap)return;
  wrap.innerHTML='';
  Object.entries(profile.modelQuotaRates||{}).forEach(([m,r])=>wrap.appendChild(rateRowEl(m,r.peak,r.offPeak)));
  renumberRows('mr');updateRateRowsHint();
}
function updateRateRowsHint(){
  const el=document.getElementById('rateRowsHint');
  if(!el)return;
  const rows=[...document.querySelectorAll('#rateRows .alias-row')];
  const peakEl=document.getElementById('peakQuotaRateInput'),offEl=document.getElementById('offPeakQuotaRateInput');
  const dp=peakEl?Number(peakEl.value):1,dof=offEl?Number(offEl.value):1;
  const inPeak=nowInPeakHours(collectPeakHours());
  // Per-row "current" cell: what a request for that model would cost right now.
  const priced=new Set();
  rows.forEach(row=>{
    const m=row.querySelector('select[name^="mr_model_"]').value;
    const p=Number(row.querySelector('[name^="mr_peak_"]').value),o=Number(row.querySelector('[name^="mr_off_"]').value);
    const cell=row.querySelector('.rate-eff');
    if(m)priced.add(m);
    if(!m){cell.textContent='未选择模型';cell.style.color='var(--orange)';return}
    const eff=inPeak?p:o;
    if(!Number.isFinite(eff)){cell.textContent='倍率无效 → 归一为 1.0';cell.style.color='var(--orange)';return}
    cell.textContent='×'+eff+(inPeak?'（高峰）':'（低谷）');
    cell.style.color='var(--dim)';
  });
  const dupes=rows.map(r=>r.querySelector('select[name^="mr_model_"]').value).filter(Boolean)
    .filter((m,i,arr)=>arr.indexOf(m)!==i);
  if(dupes.length){el.innerHTML='<b style="color:var(--orange)">注意：模型 "'+h(dupes[0])+'" 配置了多行，保存时以最后一行为准</b>';el.style.color='var(--orange)';return}
  const uncovered=allRateModels().filter(m=>!priced.has(m));
  el.innerHTML=(rows.length?'已单独定价 '+priced.size+' 个模型。':'')
    +(uncovered.length?'其余 '+uncovered.length+' 个模型走默认倍率（'+(inPeak?'高峰 ×'+dp:'低谷 ×'+dof)+'）：'+uncovered.map(m=>h(m)).join('、'):'全部模型均已单独定价。');
  el.style.color='var(--dim)';
}
function renderAliasRows(profile){
  const wrap=document.getElementById('aliasRows');wrap.innerHTML='';
  const aliases=profile.modelAliases||{},ctxs=profile.modelContextWindows||{},mms=profile.modelMultimodal||{};
  const names=Object.keys(aliases);
  if(names.length){names.forEach(n=>wrap.appendChild(aliasRowEl(n,aliases[n],ctxs[n]||profile.contextWindow||128000,mms[n]!==false)))}
  else{['jx-fable','jx-opus','jx-haiku','jx-sonnet'].forEach(n=>wrap.appendChild(aliasRowEl(n,'',ctxs[n]||128000,true)))}
  renumberRows('ma');
  const pwrap=document.getElementById('peakRows');pwrap.innerHTML='';
  const peakEntries=Object.entries(profile.peakModelAliases||{});
  peakEntries.forEach(([n,m])=>pwrap.appendChild(peakRowEl(n,m)));
  renumberRows('pa');refreshPeakSelects();
  // refreshPeakSelects rebuilds each select's options; now restore the saved
  // alias choice per row (row order matches peakEntries order). A stale name
  // not among the defined aliases gets an explicitly marked option so it is
  // visible rather than silently dropped.
  pwrap.querySelectorAll('.alias-row').forEach((row,i)=>{
    const sel=row.querySelector('select[name^="pa_alias_"]');
    if(sel&&peakEntries[i]){
      const want=peakEntries[i][0];
      if(want&&![...sel.options].some(o=>o.value===want)){
        sel.insertAdjacentHTML('beforeend','<option value="'+want.replace(/"/g,'&quot;')+'">'+want.replace(/</g,'&lt;')+'（未在通用别名中定义）</option>');
      }
      sel.value=want;
    }
  });
  refreshBridgeSelect(profile);
  renderRateRows(profile);
  updateAllowedTags();
}
// Rebuild the image-bridge helper-model dropdown from the profile's multimodal
// aliases, keeping the current selection when still valid.
function refreshBridgeSelect(profile){
  const sel=document.getElementById('imgBridgeModel');
  if(!sel)return;
  const aliases=profile.modelAliases||{},mms=profile.modelMultimodal||{};
  const keep=sel.value;
  const options=Object.keys(aliases).filter(a=>mms[a]!==false).map(a=>'<option value="'+String(aliases[a]).replace(/"/g,'&quot;')+'"'+(String(aliases[a])===keep?' selected':'')+'>'+a+' → '+String(aliases[a]).replace(/</g,'&lt;')+'</option>').join('');
  sel.innerHTML='<option value="">未选择</option>'+options;
  if(keep&&![...sel.options].some(o=>o.value===keep))sel.value='';
  else sel.value=keep;
}
// Editing an alias's target model changes the set of models the rate rows can
// point at, so keep those dropdowns in sync with every keystroke.
document.getElementById('aliasRows').addEventListener('input',()=>{refreshPeakSelects();updateAllowedTags();refreshAllRateSelects()});
document.getElementById('peakRows').addEventListener('input',()=>{updateAllowedTags();refreshAllRateSelects()});
// Init LAST: editProfile/switchProtoTab assign let-declared module state
// (editingProfileName), so running this any earlier throws a TDZ ReferenceError
// and leaves the alias rows unrendered.
(function(){var saved=null;try{saved=localStorage.getItem('tm_settings_proto_tab')}catch(e){}
if(saved==='responses'){try{switchProtoTab('responses')}catch(e){}}
else{renderAliasRows(SETTINGS.profiles.find(p=>p.suffix===SETTINGS.selectedProfileSuffix)||SETTINGS.profiles[0]||{})}
// Pool ops (save/create/delete) set a one-shot flag so the reload lands back on
// the 额度池 view instead of the profile form. sessionStorage = once only, this
// session; a fresh open of the settings page starts on profiles as usual.
try{if(sessionStorage.getItem('tm_return_pool_view')==='1'){sessionStorage.removeItem('tm_return_pool_view');openQuotaPoolView()}}catch(e){}
})();
document.addEventListener("keydown",e=>{if(e.key==="Enter"&&e.target.tagName!=="TEXTAREA"&&e.target.tagName!=="INPUT")e.preventDefault()});
</script>
</body></html>`;
}

// ─── Dashboard HTML ──────────────────────────────────────────────────────────
function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2096%2096%22%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2222%22%20fill%3D%22%232f6e50%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fbfbf8%22%20stroke-width%3D%2213%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate(48%2048)%20scale(0.88)%20translate(-48%20-48)%22%3E%3Cpath%20d%3D%22M37%2026.5H31.5Q20.5%2026.5%2020.5%2037.5V58.5Q20.5%2069.5%2031.5%2069.5H37%22%2F%3E%3Cpath%20d%3D%22M59%2026.5H64.5Q75.5%2026.5%2075.5%2037.5V58.5Q75.5%2069.5%2064.5%2069.5H59%22%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2248%22%20r%3D%226.2%22%20fill%3D%22%23fbfbf8%22%2F%3E%3C%2Fsvg%3E">
<title>团队AI Coding监控</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
${UI_THEME}
${TOAST_CSS}
body{padding:16px clamp(14px,2vw,28px) 28px}
.dashboard-shell{width:100%;max-width:1560px;margin:0 auto;display:grid;gap:10px;min-width:0}
.command-bar{min-height:46px;display:flex;align-items:center;justify-content:space-between;gap:18px;padding-bottom:9px;border-bottom:1px solid var(--border);min-width:0;position:sticky;top:0;z-index:20;background:var(--canvas);padding-top:4px}
.command-brand{display:flex;align-items:center;gap:14px;min-width:0;white-space:nowrap}
.brand-mark{font-size:13px;font-weight:700;color:var(--accent)}.brand-logo{width:26px;height:26px;flex:none;display:block}
.command-title{font-size:16px;font-weight:650;line-height:1.2;padding-right:14px;border-right:1px solid var(--border)}
.command-status{font-size:11px;color:var(--dim);display:flex;align-items:center;flex-shrink:0}
.meta{font-size:11px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.meta b{color:var(--text);font-weight:550}
.controls{display:flex;gap:7px;align-items:center;flex-wrap:nowrap;min-width:0;flex-shrink:0}
.controls select{max-width:180px;min-width:0;overflow:hidden;text-overflow:ellipsis}
.controls a,.controls button{flex-shrink:0;white-space:nowrap}
.controls select,.controls a,.controls button{font-size:12px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:7px 10px;cursor:pointer;text-decoration:none;line-height:1.3}
.controls select:hover,.controls a:hover,.controls button:hover{border-color:var(--border-strong);background:var(--surface-subtle)}
.controls .ar-on{border-color:#bdd0c3;color:var(--green);background:var(--accent-soft)}.controls .ar-off{color:var(--dim)}
.metric-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;min-height:68px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px 13px;min-height:68px;display:flex;flex-direction:column;justify-content:center}
.card:first-child{border-top:2px solid var(--accent)}
.card .l{font-size:10px;font-weight:600;color:var(--dim);margin-bottom:5px}
.card .v{font-size:21px;line-height:1;font-weight:650;font-variant-numeric:tabular-nums;color:var(--text)!important}
.chart-filters{display:flex;flex-wrap:wrap;gap:9px;align-items:end;min-height:34px}
.chart-filters .detail-field{width:150px}
.chart-filters .chart-date{width:140px}
.chart-filter-hint{font-size:10px;color:var(--dim);font-weight:400;align-self:center}
.proto-seg{display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--surface);height:30px;align-self:end}
.proto-seg button{font-size:11px;font-weight:600;padding:0 14px;border:none;background:transparent;color:var(--dim);cursor:pointer}
.proto-seg button+button{border-left:1px solid var(--border)}
.proto-seg button.on{background:var(--accent-soft);color:var(--accent)}
#profileSummaryBody .proto-row td{background:var(--surface-subtle);font-size:10px;font-weight:650;color:var(--dim);letter-spacing:.04em;padding:6px 12px}
.chart-note{font-size:10px;color:var(--dim);font-weight:400;white-space:nowrap}
.chart-workspace{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr));gap:8px;min-height:660px}
.chart-panel{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px 12px;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.chart-trend{grid-column:1;grid-row:1}.chart-profile{grid-column:2;grid-row:1}
.chart-models{grid-column:1;grid-row:2}.chart-users{grid-column:2;grid-row:2}
.chart-hmodel{grid-column:1;grid-row:3}.chart-hourly{grid-column:2;grid-row:3}
.chart-head{min-height:24px;display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:4px}.chart-head h2{font-size:12px;font-weight:650;color:var(--text);white-space:nowrap}
.chart-canvas{position:relative;flex:1;min-height:0}.chart-canvas canvas{position:absolute!important;inset:0;width:100%!important;height:100%!important}
.tabs{display:flex;gap:1px;background:var(--surface-subtle);border:1px solid var(--border);border-radius:5px;padding:2px;width:fit-content;flex-shrink:0}
.tab{padding:3px 9px;font-size:10px;border:0;border-radius:3px;background:transparent;color:var(--dim);cursor:pointer}.tab:hover{color:var(--text)}.tab.on{background:var(--surface);color:var(--text);font-weight:600}
.data-workspace{background:var(--surface);border:1px solid var(--border);border-radius:6px;display:flex;flex-direction:column;min-height:300px;min-width:0;overflow:hidden}
.workspace-tabs{display:flex;align-items:stretch;gap:0;min-height:38px;border-bottom:1px solid var(--border);overflow-x:auto;scrollbar-width:thin}
.workspace-tab{border:0;border-right:1px solid var(--border);background:transparent;color:var(--dim);padding:0 15px;font-size:12px;font-weight:550;white-space:nowrap;cursor:pointer}.workspace-tab:hover{background:var(--surface-subtle);color:var(--text)}.workspace-tab[aria-selected="true"]{background:var(--surface);color:var(--accent);box-shadow:inset 0 -2px var(--accent)}
.workspace-tab-count{display:inline-block;margin-left:6px;color:var(--dim);font-size:10px;font-variant-numeric:tabular-nums}.workspace-tab[aria-selected="true"] .workspace-tab-count{color:var(--accent)}
.workspace-content{position:relative;flex:1;min-height:0;min-width:0}.workspace-panel{display:none;height:100%;min-height:0;min-width:0}.workspace-panel.active{display:flex;flex-direction:column}.workspace-panel[hidden]{display:none}
.workspace-panel-inner{height:100%;min-height:0;display:flex;flex-direction:column}
.workspace-panel-head{min-height:36px;padding:7px 12px;display:flex;align-items:center;gap:9px;border-bottom:1px solid var(--border);font-size:12px}.workspace-panel-head strong{font-weight:650}.workspace-panel-summary{font-size:10px;color:var(--dim);margin-left:auto}.workspace-panel-scroll{flex:1;min-height:0;overflow:auto}
.workspace-panel table{margin:0}.workspace-panel table thead th{position:sticky;top:0;z-index:3;background:#fafaf7}.workspace-panel table th:first-child,.workspace-panel table td:first-child{position:sticky;left:0;z-index:2;background:var(--surface)}.workspace-panel table thead th:first-child{z-index:4;background:#fafaf7}.workspace-panel table tbody tr:hover td:first-child{background:#fafaf7}
.profile-current td{background:var(--accent-soft)!important}.profile-current td:first-child{background:var(--accent-soft)!important}.current-mark{color:var(--accent);font-size:10px;font-weight:650;margin-left:6px}
/* Per-profile quota columns in the all-profiles user table. Each profile is a
   column so its name is written once in the header instead of repeating under
   every user; the cell is a compact pct + bar so N profiles stay scannable. */
.q-col{min-width:104px}
.q-cell{display:flex;flex-direction:column;gap:3px;align-items:flex-end}
.q-cell .q-pct{font-size:11px;font-variant-numeric:tabular-nums;font-weight:600}
.q-cell .quota-progress{margin-left:0;width:76px}
.q-none{color:var(--dim2);font-size:11px}
.q-head-sub{display:block;font-size:9px;font-weight:400;color:var(--dim2);margin-top:1px}
/* 只看配额: hide the token statistics columns so N profile columns fit without
   horizontal scrolling. Marked by class rather than nth-child because the column
   count is dynamic. */
#uTable.q-focus .stat-col{display:none}
.q-focus-btn{font-size:10px;background:var(--surface);color:var(--dim);border:1px solid var(--border);border-radius:4px;padding:3px 8px;cursor:pointer;margin-left:8px}
.q-focus-btn:hover{border-color:var(--border-strong);background:var(--surface-subtle)}
.q-focus-btn.on{border-color:#bdd0c3;color:var(--green);background:var(--accent-soft)}
.sec-toggle{display:none}.sec-hint{font-size:10px;color:var(--dim);font-weight:400}.sec-body{display:block;min-height:0}.sec-body.open{display:block}
#detailSec,#detailSecBody,#errorSec{height:100%;min-height:0;display:flex;flex-direction:column}#errorSecBody{flex:1;min-height:0;overflow:auto}
.clear-btn{font-size:11px;background:#fff5f3;color:var(--red);border:1px solid #f1c8c2;border-radius:4px;padding:4px 9px;cursor:pointer;margin-left:8px}
.detail-tools{display:grid;grid-template-columns:minmax(220px,1.4fr) minmax(130px,.55fr) minmax(160px,.65fr) auto;gap:9px;align-items:end;padding:8px 12px}
.detail-field label{display:block;font-size:10px;font-weight:600;color:var(--dim);margin-bottom:4px}
.detail-field input,.detail-field select,.detail-reset{width:100%;height:30px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:11px;padding:0 9px;outline:none}
.detail-field input:hover,.detail-field select:hover,.detail-reset:hover{border-color:var(--border-strong);background:var(--surface-subtle)}.detail-field input:focus,.detail-field select:focus{border-color:var(--accent)}
.detail-reset{width:auto;min-width:68px;cursor:pointer;font-weight:600}
.detail-table-wrap{flex:1;min-height:0;overflow:auto;border-top:1px solid var(--border)}
#dTable{min-width:860px}#dTable thead th{position:sticky;top:0;z-index:3;background:#fafaf7}
#dTable .detail-sticky{position:sticky;left:0;z-index:2;background:var(--surface);min-width:220px}#dTable thead .detail-sticky{z-index:4;background:#fafaf7}
#dTable .detail-group{cursor:pointer;outline:none}#dTable .detail-group td{background:var(--surface-subtle);font-weight:600;border-top:1px solid var(--border)}#dTable .detail-group .detail-sticky{background:var(--surface-subtle)}#dTable .detail-group:hover td,#dTable .detail-group:focus-visible td{background:#ecece7}
#dTable tbody tr:not(.detail-group):hover .detail-sticky{background:#fafaf7}
.detail-period{display:flex;align-items:center;gap:9px}.detail-period-toggle{display:inline-block;width:8px;height:8px;border-right:1.5px solid var(--dim);border-bottom:1.5px solid var(--dim);transform:rotate(-45deg);transition:transform .18s;flex-shrink:0}.detail-period-toggle.open{transform:rotate(45deg)}
.detail-period-meta{font-size:10px;color:var(--dim);font-weight:400}.detail-user{display:flex;align-items:baseline;gap:8px;padding-left:17px}.detail-user-name{font-weight:550}.detail-key{font-family:var(--font-mono);font-size:10px;color:var(--dim)}.detail-share{display:block;font-size:10px;color:var(--dim);font-weight:400;margin-top:1px}
.detail-pages{display:flex;align-items:center;justify-content:flex-end;gap:7px;padding:6px 12px;min-height:36px;border-top:1px solid var(--border)}.detail-pages span{font-size:11px;color:var(--dim);margin-right:3px}.detail-pages button{font-size:11px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 9px;cursor:pointer}.detail-pages button:hover:not(:disabled){border-color:var(--border-strong);background:var(--surface-subtle)}.detail-pages button:disabled{opacity:.4;cursor:default}
table{width:100%;border-collapse:collapse;min-width:720px}
th{text-align:left;padding:8px 12px;font-weight:550;font-size:10px;color:var(--dim);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:8px 12px;font-size:11px;border-bottom:1px solid #ecece8;white-space:nowrap}tr:last-child td{border-bottom:0}tbody tr:hover td{background:#fafaf7}
.n{font-variant-numeric:tabular-nums;text-align:right}.hl{color:var(--accent);font-weight:600}
.rank{display:inline-block;width:20px;color:var(--dim);font-variant-numeric:tabular-nums}code{font-family:var(--font-mono);color:var(--accent);font-size:11px}.empty{color:var(--dim);padding:24px;text-align:center;font-size:12px}
@media(min-width:1280px) and (min-height:800px){.dashboard-shell{padding:12px 18px;grid-template-rows:46px 68px auto minmax(440px,1fr);gap:8px}.command-bar{height:46px}.controls{flex-wrap:nowrap}.data-workspace{min-height:0}}
@media(max-width:1279px), (max-height:799px){.dashboard-shell{height:auto}.chart-workspace{grid-template-rows:repeat(3,280px);max-height:none}.data-workspace{height:auto;min-height:440px}.workspace-panel{min-height:400px}.workspace-panel.active{display:flex}}
@media(max-width:820px){.command-bar{align-items:flex-start;flex-direction:column;position:static;background:transparent;padding-top:0}.command-brand{width:100%;flex-wrap:wrap}.meta{order:3;width:100%;white-space:normal}.controls{width:100%}.metric-strip{grid-template-columns:repeat(3,1fr)}.chart-workspace{grid-template-columns:1fr;grid-template-rows:repeat(6,240px)}.chart-trend,.chart-users,.chart-models,.chart-hourly,.chart-hmodel,.chart-profile{grid-column:1;grid-row:auto}.detail-tools{grid-template-columns:1fr 1fr}.detail-search{grid-column:1/-1}.detail-reset{width:100%}}
@media(max-width:560px){body{padding:12px 10px 24px}.command-title{border-right:0;padding-right:0}.command-status{width:100%}.controls select{flex:1;min-width:150px}.metric-strip{grid-template-columns:1fr 1fr}.card{min-height:64px;padding:10px}.card .v{font-size:19px}.chart-head{align-items:flex-start}.chart-trend .chart-head{flex-direction:column}.workspace-tab{padding:0 12px}.detail-tools{padding:8px}.detail-table-wrap{max-height:500px}#dTable .detail-sticky{min-width:190px}.detail-pages{justify-content:space-between}}
</style></head><body data-theme="editorial-light">
<main class="dashboard-shell">
<header class="command-bar">
  <div class="command-brand"><svg class="brand-logo" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="#2f6e50"/><g fill="none" stroke="#fbfbf8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" transform="translate(48 48) scale(0.9) translate(-48 -48)"><path d="M37 26.5H31.5Q20.5 26.5 20.5 37.5V58.5Q20.5 69.5 31.5 69.5H37"/><path d="M59 26.5H64.5Q75.5 26.5 75.5 37.5V58.5Q75.5 69.5 64.5 69.5H59"/></g><circle cx="48" cy="48" r="4.95" fill="#fbfbf8"/></svg><span class="brand-mark">CC Team</span><h1 class="command-title">团队用量</h1><span class="command-status"><span class="led on"></span>监控服务运行中</span><span class="meta" id="meta">正在加载数据</span></div>
  <div class="controls"><select id="profileSel" aria-label="查看方案" onchange="switchProfileView(this.value)"><option value="">全部方案</option></select><a href="/settings">设置</a><button id="autoRefreshBtn" class="ar-on">自动刷新：开</button><button onclick="fetch('/api/logout',{method:'POST',headers:{'x-csrf-token':(document.cookie.match(/tm_csrf=([^;]+)/)||[])[1]||''}}).then(()=>toastThen('已退出登录',()=>location.reload()))">退出</button></div>
</header>
<section class="metric-strip" id="cards" aria-label="用量摘要"></section>
<section class="chart-filters" aria-label="图表筛选">
  <div class="proto-seg" id="protoSeg" role="group" aria-label="协议分类">
    <button type="button" class="on" data-proto="">全部</button><button type="button" data-proto="anthropic">Anthropic</button><button type="button" data-proto="responses">OpenAI</button>
  </div>
  <div class="tabs" id="globalTabs" aria-label="统计周期">
    <button class="tab on" data-p="day">按日</button><button class="tab" data-p="week">按周</button><button class="tab" data-p="month">按月</button><button class="tab" data-p="year">按年</button>
  </div>
  <div class="detail-field"><label for="metricSel">指标</label><select id="metricSel"><option value="tokens">Token</option><option value="requests">请求数</option></select></div>
  <div class="detail-field"><label for="modelSel">模型</label><select id="modelSel"><option value="all">全部模型</option></select></div>
  <div class="detail-field"><label for="userSel">用户</label><select id="userSel"><option value="all">全部用户</option></select></div>
  <div class="detail-field chart-date"><label for="dateStart">开始日期</label><input type="date" id="dateStart" onchange="onDateRangeChange()"></div>
  <div class="detail-field chart-date"><label for="dateEnd">结束日期</label><input type="date" id="dateEnd" onchange="onDateRangeChange()"></div>
  <button type="button" class="detail-reset" onclick="resetChartFilters()">重置</button>
  <span class="chart-filter-hint" id="chartFilterHint">日期范围对 24 小时图不生效；模型/用户筛选对部分图表不适用；按模型筛选时不含缓存 Token</span>
</section>
<section class="chart-workspace" aria-label="用量图表">
  <div class="chart-panel chart-trend"><div class="chart-head"><h2>Token 用量趋势</h2><span class="chart-note" id="trendNote"></span></div><div class="chart-canvas"><canvas id="trend"></canvas></div></div>
  <div class="chart-panel chart-users"><div class="chart-head"><h2>用户分布</h2></div><div class="chart-canvas"><canvas id="pie"></canvas></div></div>
  <div class="chart-panel chart-models"><div class="chart-head"><h2>模型请求分布</h2></div><div class="chart-canvas"><canvas id="modelChart"></canvas></div></div>
  <div class="chart-panel chart-hourly"><div class="chart-head"><h2>24 小时趋势</h2></div><div class="chart-canvas"><canvas id="hourChart"></canvas></div></div>
  <div class="chart-panel chart-hmodel"><div class="chart-head"><h2>24 小时模型使用趋势</h2></div><div class="chart-canvas"><canvas id="hourModelChart"></canvas></div></div>
  <div class="chart-panel chart-profile"><div class="chart-head"><h2>方案请求情况</h2><span class="chart-note" id="profileNote"></span></div><div class="chart-canvas"><canvas id="profileChart"></canvas></div></div>
</section>
<section class="data-workspace" aria-label="数据工作区">
  <div class="workspace-tabs" role="tablist" aria-label="数据视图">
    <button id="workspace-tab-users" role="tab" aria-controls="workspace-panel-users" aria-selected="true" tabindex="0" class="workspace-tab">用户用量<span class="workspace-tab-count" id="workspaceCountUsers">0</span></button>
    <button id="workspace-tab-detail" role="tab" aria-controls="workspace-panel-detail" aria-selected="false" tabindex="-1" class="workspace-tab">明细记录<span class="workspace-tab-count" id="workspaceCountDetail">0</span></button>
    <button id="workspace-tab-profiles" role="tab" aria-controls="workspace-panel-profiles" aria-selected="false" tabindex="-1" class="workspace-tab">方案中心<span class="workspace-tab-count" id="workspaceCountProfiles">0</span></button>
    <button id="workspace-tab-rates" role="tab" aria-controls="workspace-panel-rates" aria-selected="false" tabindex="-1" class="workspace-tab">配额倍率<span class="workspace-tab-count" id="workspaceCountRates">0</span></button>
    <button id="workspace-tab-errors" role="tab" aria-controls="workspace-panel-errors" aria-selected="false" tabindex="-1" class="workspace-tab">错误记录<span class="workspace-tab-count" id="workspaceCountErrors">0</span></button>
  </div>
  <div class="workspace-content">
    <section id="workspace-panel-users" role="tabpanel" aria-labelledby="workspace-tab-users" class="workspace-panel active"><div class="workspace-panel-inner">
      <div class="workspace-panel-head" id="userQuotaHead" hidden><strong>用户用量</strong><button type="button" class="q-focus-btn" id="qFocusBtn" onclick="toggleQuotaFocus()" title="隐藏 Token 统计列，只看各方案配额占用">只看配额</button><span class="workspace-panel-summary" id="userQuotaContext"></span></div>
      <div class="workspace-panel-scroll"><table id="uTable"><thead>
      <tr id="uTableHead"><th>用户</th><th>状态</th><th class="n">请求数</th><th class="n">输入</th><th class="n">输出</th><th class="n">缓存写入</th><th class="n">缓存命中</th><th class="n">合计</th><th class="n">今日</th><th class="n">配额</th><th>最后活跃</th></tr>
    </thead><tbody></tbody></table></div></div></section>
    <section id="workspace-panel-detail" role="tabpanel" aria-labelledby="workspace-tab-detail" class="workspace-panel" hidden><div id="detailSec">
      <div class="workspace-panel-head"><span class="sec-toggle open" id="detailSecIcon"></span><strong>明细记录</strong><span class="sec-hint" id="detailHint"></span></div><div class="sec-body open" id="detailSecBody">
      <div class="detail-tools">
        <div class="detail-field detail-search"><label for="detailQuery">用户</label><input type="search" id="detailQuery" placeholder="搜索用户名或虚拟 Key" oninput="updateDetailFilters()"></div>
        <div class="detail-field"><label for="detailRange">时间范围</label><select id="detailRange" onchange="updateDetailFilters()"><option value="all">全部</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option></select></div>
        <div class="detail-field"><label for="detailSort">周期排序</label><select id="detailSort" onchange="updateDetailFilters()"><option value="time">最新优先</option><option value="tokens">Token 高到低</option><option value="requests">请求数高到低</option></select></div>
        <button type="button" class="detail-reset" id="detailReset" onclick="resetDetailFilters()">重置</button>
      </div>
      <div class="detail-table-wrap"><table id="dTable"><thead><tr><th class="detail-sticky">周期 / 用户</th><th class="n">请求数</th><th class="n">输入</th><th class="n">输出</th><th class="n">缓存写入</th><th class="n">缓存命中</th><th class="n">合计</th></tr></thead><tbody></tbody></table></div><div class="detail-pages" id="detailPages"></div>
      </div></div>
    </section>
    <section id="workspace-panel-profiles" role="tabpanel" aria-labelledby="workspace-tab-profiles" class="workspace-panel" hidden><div id="profileSummarySec" class="workspace-panel-inner">
      <div class="workspace-panel-head"><strong>方案中心</strong><span class="workspace-panel-summary" id="profileContext">当前查看：全部方案</span></div><div class="workspace-panel-scroll"><table><thead><tr><th>方案</th><th>入口</th><th>上游</th><th class="n">今日请求</th><th class="n">今日用量</th><th>状态</th></tr></thead><tbody id="profileSummaryBody"></tbody></table></div>
    </div></section>
    <section id="workspace-panel-rates" role="tabpanel" aria-labelledby="workspace-tab-rates" class="workspace-panel" hidden><div class="workspace-panel-inner">
      <div class="workspace-panel-head"><strong>配额倍率</strong><span class="workspace-panel-summary" id="rateBoardContext"></span></div>
      <div class="workspace-panel-scroll"><table id="rateBoardTable"><thead><tr><th>模型</th><th>方案</th><th>别名</th><th class="n">当前倍率</th><th class="n">高峰</th><th class="n">低谷</th><th class="n">今日实际</th><th class="n">今日计入</th><th class="n">今日请求</th></tr></thead><tbody id="rateBoardBody"></tbody></table></div>
    </div></section>
    <section id="workspace-panel-errors" role="tabpanel" aria-labelledby="workspace-tab-errors" class="workspace-panel" hidden><div id="errorSec">
      <div class="workspace-panel-head"><span class="sec-toggle" id="errorSecIcon"></span><strong>错误记录</strong><span id="errorCount" style="font-size:10px;color:var(--red)"></span><span class="workspace-panel-summary" id="errorHint">暂无错误</span><button id="clearErrors" class="clear-btn">清除</button></div>
      <div class="sec-body" id="errorSecBody"><table id="eTable"><thead><tr><th>时间</th><th>用户</th><th class="n">状态码</th><th>模型</th><th>路径</th><th>错误信息</th></tr></thead><tbody></tbody></table><div id="errPages" style="padding:8px 12px;text-align:right"></div></div>
    </div></section>
  </div>
</section>
</main>
<script>
${UI_HELPERS}
${TOAST_JS}
Chart.defaults.color='#686863';Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei","Segoe UI",sans-serif';Chart.defaults.font.size=11;
let D=null,P="day",C={t:null,p:null,m:null,h:null,hm:null,pr:null},errPage=1,autoRefresh=true,refreshTimer=null,currentProfile="all",PROTO="";
let MDL="all",USR="all",MT="tokens";
let DS="",DE="";
let activeWorkspaceTab="users";
let quotaFocus=(function(){try{return localStorage.getItem('tm_quota_focus')==='1'}catch(e){return false}})();
const ERR_PAGE_SIZE=20;
const DETAIL_PAGE_SIZE=10;
let detailPage=1,detailQuery="",detailRange="all",detailSort="time",detailInitialized=false;
const expandedDetailPeriods=new Set();
const COL=["#2f6e50","#4a6fa5","#c2604f","#c4a23a","#7a6bb0","#d4824a","#4a9ba8","#c47a99","#6ba368","#5a6bc4","#8a6db5","#5a9b8e"];
const escH=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtT=n=>n.toLocaleString("zh-CN");
const fmtTk=n=>{if(n>=1e6)return(n/1e6).toFixed(1)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return n.toString()};
function fmtBJ(iso){if(!iso)return"-";const d=new Date(iso);const utc=d.getTime()+d.getTimezoneOffset()*60000;return new Date(utc+8*3600000).toLocaleString("zh-CN")};
function ago(iso){if(!iso)return"-";const d=Date.now()-new Date(iso).getTime();const m=Math.floor(d/6e4);if(m<1)return"刚刚";if(m<60)return m+"分钟前";const h=Math.floor(m/60);if(h<24)return h+"小时前";return Math.floor(h/24)+"天前"}
function wk(s){const d=new Date(s),day=d.getDay()||7,mon=new Date(d);mon.setDate(d.getDate()-day+1);return mon.toISOString().slice(0,10)}
function grp(daily,p){const g={};for(const[day,ud]of Object.entries(daily)){const k=p==="week"?wk(day):p==="month"?day.slice(0,7):p==="year"?day.slice(0,4):day;if(!g[k])g[k]={};for(const[u,s]of Object.entries(ud)){if(!g[k][u])g[k][u]={inputTokens:0,outputTokens:0,requests:0,cacheCreationTokens:0,cacheReadTokens:0};g[k][u].inputTokens+=s.inputTokens;g[k][u].outputTokens+=s.outputTokens;g[k][u].requests+=s.requests;g[k][u].cacheCreationTokens+=(s.cacheCreationTokens||0);g[k][u].cacheReadTokens+=(s.cacheReadTokens||0)}}return g}
function lbl(p,k){if(p==="day")return k.slice(5);if(p==="week")return k.slice(5)+" 周";if(p==="month")return k;return k+"年"}
// 当前周期窗口（北京时间）：日=今天、周=本周一、月=本月 1 日、年=本年 1 月 1 日。
function winBounds(){const t=new Date(Date.now()+8*36e5).toISOString().slice(0,10);return{wStart:P==="day"?t:P==="week"?wk(t):P==="month"?t.slice(0,7)+"-01":t.slice(0,4)+"-01-01",td:t}}
// 四张非 24h 图的有效窗口:日期范围(开始/结束)生效时用它,否则退回周期窗口。
// 日期范围只做窗口过滤,分桶粒度仍由周期 tabs 控制(两者正交)。
function effBounds(){
  if(DS||DE){const t=winBounds().td;return{start:DS||"0000-01-01",end:DE||t,ranged:true}}
  const{wStart,td}=winBounds();return{start:wStart,end:td,ranged:false};
}
function onDateRangeChange(){
  DS=document.getElementById("dateStart").value||"";
  DE=document.getElementById("dateEnd").value||"";
  if(DS&&DE&&DS>DE){[DS,DE]=[DE,DS];document.getElementById("dateStart").value=DS;document.getElementById("dateEnd").value=DE}
  render();
}
// 图表数据源：模型筛选生效时由 dailyModels（已按掩码 key 对齐）重建不含缓存的日粒度数据；
// 仅用户筛选时过滤 daily；无筛选直接用 daily。与 grp()/totalTokens() 的字段约定兼容。
function filteredDaily(){
  if(MDL!=="all"){
    const out={};
    for(const[date,users]of Object.entries(D.dailyModels||{})){
      for(const[u,models]of Object.entries(users)){
        const v=models[MDL];if(!v)continue;
        if(!out[date])out[date]={};
        out[date][u]={inputTokens:v.inputTokens||0,outputTokens:v.outputTokens||0,requests:v.requests||0,cacheCreationTokens:0,cacheReadTokens:0};
      }
    }
    if(USR==="all")return out;
    const f={};for(const[date,ud]of Object.entries(out)){if(ud[USR])f[date]={[USR]:ud[USR]}}return f;
  }
  if(USR==="all")return D.daily||{};
  const f={};for(const[date,ud]of Object.entries(D.daily||{})){if(ud[USR])f[date]={[USR]:ud[USR]}}return f;
}
function c(l,v,cl,k){return'<div class="card"><div class="l">'+l+'</div><div class="v" data-cu="'+v+'"'+(k?' data-cu-k':'')+'>0</div></div>'}
let chartResizeFrame=0;
function doughnutLegend(){const compact=innerWidth<1280;return{position:"bottom",labels:{color:"#686863",font:{size:compact?10:11},padding:compact?6:10,boxWidth:compact?16:24}}}
function trendLegend(){const compact=innerWidth<=820;return{labels:{color:"#686863",font:{size:compact?9:11},padding:compact?6:10,boxWidth:compact?16:40}}}
function scheduleChartResize(){cancelAnimationFrame(chartResizeFrame);chartResizeFrame=requestAnimationFrame(()=>{for(const chart of[C.p,C.m]){if(chart){chart.options.plugins.legend={display:false};chart.update("none")}}for(const chart of[C.t,C.hm,C.pr]){if(chart){chart.options.plugins.legend=trendLegend();chart.update("none")}}Object.values(C).forEach(chart=>chart&&chart.resize())})}
function setWorkspaceTab(tab,focus){
  const next=document.getElementById("workspace-tab-"+tab),panel=document.getElementById("workspace-panel-"+tab);
  if(!next||!panel)return;
  activeWorkspaceTab=tab;
  document.querySelectorAll(".workspace-tab").forEach(button=>{const selected=button===next;button.setAttribute("aria-selected",String(selected));button.tabIndex=selected?0:-1});
  document.querySelectorAll(".workspace-content>[role=tabpanel]").forEach(item=>{const selected=item===panel;item.hidden=!selected;item.classList.toggle("active",selected)});
  if(focus)next.focus();
  scheduleChartResize();
}
function handleWorkspaceTabKeydown(event){
  const tabs=[...document.querySelectorAll(".workspace-tab")],index=tabs.indexOf(event.currentTarget);let next=index;
  if(event.key==="ArrowRight")next=(index+1)%tabs.length;else if(event.key==="ArrowLeft")next=(index-1+tabs.length)%tabs.length;else if(event.key==="Home")next=0;else if(event.key==="End")next=tabs.length-1;else return;
  event.preventDefault();setWorkspaceTab(tabs[next].id.replace("workspace-tab-",""),true);
}
function renderWorkspaceSummaries(){
  if(!D)return;
  document.getElementById("workspaceCountUsers").textContent=Object.keys(D.users||{}).length;
  document.getElementById("workspaceCountProfiles").textContent=Array.isArray(D.profileSummaries)?D.profileSummaries.length:0;
  document.getElementById("workspaceCountErrors").textContent=Array.isArray(D.errors)?D.errors.length:0;
  // Tab count = models priced individually, not total rows: that is the number an
  // admin is checking ("did my overrides take effect?").
  const board=Array.isArray(D.modelRateBoard)?D.modelRateBoard:[];
  document.getElementById("workspaceCountRates").textContent=board.filter(r=>r.custom).length;
}
// Model rate board. The chart above can only plot one number per model, so the
// answer to "which model is draining quota" lives here: configured peak/off-peak
// side by side with what today actually cost.
function renderRateBoard(){
  const body=document.getElementById("rateBoardBody"),ctx=document.getElementById("rateBoardContext");
  if(!body)return;
  const rows=Array.isArray(D.modelRateBoard)?D.modelRateBoard:[];
  if(!rows.length){body.innerHTML='<tr><td colspan="9" class="empty">暂无模型 — 先在设置页配置模型别名</td></tr>';if(ctx)ctx.textContent="";return}
  const inPeak=rows[0].inPeak;
  const customCount=rows.filter(r=>r.custom).length;
  const totalRaw=rows.reduce((s,r)=>s+r.todayRaw,0),totalW=rows.reduce((s,r)=>s+r.todayWeighted,0);
  if(ctx){
    const blended=totalRaw>0?Math.round(totalW/totalRaw*100)/100:null;
    ctx.innerHTML='当前 <b style="color:'+(inPeak?'var(--orange)':'var(--green)')+'">'+(inPeak?'高峰时段':'低谷时段')+'</b>'
      +' · '+customCount+'/'+rows.length+' 个模型单独定价'
      +(blended!=null?' · 今日综合 ×'+blended+'（实际 '+fmtTk(totalRaw)+' → 计入 '+fmtTk(totalW)+'）':'');
  }
  body.innerHTML=rows.map(r=>{
    // Realised ratio can differ from the configured rate: the day may straddle a
    // peak boundary, or a rate may have been changed mid-day. Flag it rather than
    // hiding it — a mismatch is information, not an error.
    const realised=r.todayRaw>0?Math.round(r.todayWeighted/r.todayRaw*100)/100:null;
    const drift=realised!=null&&realised!==r.rate;
    const rateCol=r.rate>1?'var(--orange)':r.rate<1?'var(--green)':'var(--text)';
    const aliasText=[...r.aliases,...r.peakAliases.map(a=>a+'(峰)')].join(', ')||'<span style="color:var(--dim)">未被别名引用</span>';
    return '<tr'+(r.custom?' style="background:rgba(47,110,80,.035)"':'')+'>'
      +'<td><b>'+escH(r.model)+'</b>'+(r.custom?' <span style="font-size:9px;color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:0 3px">单独定价</span>':' <span style="font-size:9px;color:var(--dim)">默认</span>')+'</td>'
      +'<td style="font-size:11px;color:var(--dim)">'+escH(r.profile)+'</td>'
      +'<td style="font-size:11px;color:var(--blue)">'+aliasText+'</td>'
      +'<td class="n"><b style="color:'+rateCol+'">×'+r.rate+'</b>'
        +(drift?' <span style="font-size:10px;color:var(--dim)" title="今日实际计权比例与当前倍率不同：跨了高峰边界或期间调整过倍率">实收 ×'+realised+'</span>':'')+'</td>'
      +'<td class="n"'+(inPeak?' style="font-weight:600"':' style="color:var(--dim)"')+'>×'+r.peak+'</td>'
      +'<td class="n"'+(!inPeak?' style="font-weight:600"':' style="color:var(--dim)"')+'>×'+r.offPeak+'</td>'
      +'<td class="n">'+(r.todayRaw?fmtTk(r.todayRaw):'-')+'</td>'
      +'<td class="n hl">'+(r.todayWeighted?fmtTk(r.todayWeighted):'-')+'</td>'
      +'<td class="n">'+(r.todayRequests||'-')+'</td>'
      +'</tr>';
  }).join("");
}
function maskDetailKey(key){const value=String(key||"");return value.length<=12?value:value.slice(0,8)+"****"+value.slice(-4)}
// ── All-profiles quota columns ───────────────────────────────────────────────
// Swap the single 配额 header for one column per quota-bearing profile (or back).
// Rebuilt on every render because the profile set changes with the protocol
// filter and with config edits.
function renderUserTableHead(profiles){
  const head=document.getElementById("uTableHead");
  if(!head)return;
  const base='<th>用户</th><th>状态</th><th class="n stat-col">请求数</th><th class="n stat-col">输入</th><th class="n stat-col">输出</th><th class="n stat-col">缓存写入</th><th class="n stat-col">缓存命中</th><th class="n stat-col">合计</th><th class="n">今日</th>';
  const tail='<th>最后活跃</th>';
  if(!profiles){head.innerHTML=base+'<th class="n">配额</th>'+tail;return}
  const cols=profiles.map(p=>{
    const badge=p.billingType==='coding_plan'?'套餐':p.billingType==='token_plan'?'包月':'按量';
    const sub=p.memberCount>1?p.memberCount+' 个方案 · '+badge:badge;
    return '<th class="n q-col" title="'+escH(p.label)+'：'+escH(p.memberNames.join('、'))+'">'+escH(p.label)
      +'<span class="q-head-sub">'+escH(sub)+'</span></th>';
  }).join("");
  head.innerHTML=base+cols+tail;
}
// Many profiles + 6 token columns overflows horizontally; this collapses the
// statistics so the quota columns alone fill the width. Preference is remembered
// because an admin watching quotas wants it to stay on across refreshes.
function toggleQuotaFocus(){
  quotaFocus=!quotaFocus;
  try{localStorage.setItem('tm_quota_focus',quotaFocus?'1':'0')}catch(e){}
  applyQuotaFocus();
}
function applyQuotaFocus(){
  const table=document.getElementById("uTable"),btn=document.getElementById("qFocusBtn");
  if(table)table.classList.toggle("q-focus",quotaFocus);
  if(btn)btn.classList.toggle("on",quotaFocus);
}
// Header summary: how many members are near their limit, and where. This is the
// line that makes the table actionable without reading every row.
function renderUserQuotaContext(qm,userList){
  const head=document.getElementById("userQuotaHead"),ctx=document.getElementById("userQuotaContext");
  if(!head||!ctx)return;
  if(!qm){head.hidden=true;return}
  head.hidden=false;
  const matrix=qm.matrix||{};
  let full=0,warn=0,total=0;
  const hot=[];
  for(const [uk,byProfile] of Object.entries(matrix)){
    for(const [sfx,q] of Object.entries(byProfile)){
      total++;
      if(q.pct>=100){full++;hot.push({uk,sfx,pct:q.pct})}
      else if(q.pct>=80){warn++;hot.push({uk,sfx,pct:q.pct})}
    }
  }
  const nameOf=uk=>{const hit=(userList||[]).find(([k])=>k===uk);return hit?hit[1].name:uk};
  const nameFor=key=>{const p=(qm.pools||[]).find(x=>x.key===key);return p?p.label:key};
  hot.sort((a,b)=>b.pct-a.pct);
  const parts=['共 '+total+' 项配额'];
  if(full)parts.push('<b style="color:var(--red)">'+full+' 项已用尽</b>');
  if(warn)parts.push('<b style="color:var(--orange)">'+warn+' 项超过 80%</b>');
  if(!full&&!warn)parts.push('<span style="color:var(--green)">全部低于 80%</span>');
  const top=hot.slice(0,3).map(h=>escH(nameOf(h.uk))+' @ '+escH(nameFor(h.sfx))+' '+h.pct+'%').join('、');
  ctx.innerHTML=parts.join(' · ')+(top?' — '+top:'');
}
// One quota cell: percentage + bar, or a dash when this member has no quota on
// this profile (not authorized, or the profile is unlimited). The tooltip carries
// the exact numbers so the cell itself can stay narrow.
function quotaMatrixCell(q,userName,pool){
  const NL='&#10;';   // tooltip line break (title attribute) — must be declared
                      // before first use: it's referenced in memberNote below,
                      // and a const used before its declaration is a TDZ crash
                      // that only fires for shared pools (memberCount > 1).
  const poolLabel=pool?(pool.label||pool.name):'';
  const memberNote=pool&&pool.memberCount>1?NL+'含 '+pool.memberCount+' 个方案（'+pool.memberNames.join('、')+'）':'';
  if(!q)return '<td class="n"><span class="q-none" title="'+escH(userName)+' 在额度池 '+escH(poolLabel)+' 无配额限制或无访问权限">-</span></td>';
  const col=q.pct>=100?'var(--red)':q.pct>90?'var(--red)':q.pct>70?'var(--orange)':'var(--green)';
  const tags=(q.bonus>0?' +'+fmtTk(q.bonus):'')+(q.resetApplied?' 已重置':'');
  const rateNote=(q.rate!=null&&q.rate!==1)?NL+'倍率 ×'+q.rate+'（实际 '+fmtT(q.rawUsed||0)+'）':'';
  const title=escH(userName)+' @ '+escH(poolLabel)+NL+'已用 '+fmtT(q.used)+' / '+fmtT(q.limit)
    +'（'+q.source+'）'+NL+'剩余 '+fmtT(q.remaining)+rateNote+memberNote
    +(q.bonus>0?NL+'含今日临时加量 '+fmtT(q.bonus):'')+(q.resetApplied?NL+'今日已重置':'');
  return '<td class="n q-col"><div class="q-cell" title="'+title+'">'
    +'<span class="q-pct" style="color:'+col+'">'+q.pct+'%'+(tags?'<span style="color:var(--dim);font-weight:400;font-size:9px">'+tags+'</span>':'')+'</span>'
    +quotaBar(q.pct)+'</div></td>';
}
function detailTokens(row){return ioTokens(row)}
function detailPeriodLabel(key){if(P==="day")return key;if(P==="week")return key+" 周";if(P==="month")return key;return key+" 年"}
function detailRangeDaily(daily){if(detailRange==="all")return daily;const days=Number(detailRange)||0;const cutoff=new Date(Date.now()+8*3600000-Math.max(0,days-1)*86400000).toISOString().slice(0,10);return Object.fromEntries(Object.entries(daily).filter(([date])=>date>=cutoff))}
function detailTotals(members){const total={requests:0,inputTokens:0,outputTokens:0,cacheCreationTokens:0,cacheReadTokens:0};for(const member of members){const row=member.data;total.requests+=row.requests||0;total.inputTokens+=row.inputTokens||0;total.outputTokens+=row.outputTokens||0;total.cacheCreationTokens+=row.cacheCreationTokens||0;total.cacheReadTokens+=row.cacheReadTokens||0}return total}
function resetDetailGrouping(){detailPage=1;expandedDetailPeriods.clear();detailInitialized=false}
function updateDetailFilters(){const nextQuery=document.getElementById("detailQuery").value.trim().toLowerCase(),nextRange=document.getElementById("detailRange").value,nextSort=document.getElementById("detailSort").value;const groupingChanged=nextQuery!==detailQuery||nextRange!==detailRange;detailQuery=nextQuery;detailRange=nextRange;detailSort=nextSort;detailPage=1;if(groupingChanged){expandedDetailPeriods.clear();detailInitialized=false}renderDetail()}
function resetDetailFilters(){detailQuery="";detailRange="all";detailSort="time";document.getElementById("detailQuery").value="";document.getElementById("detailRange").value="all";document.getElementById("detailSort").value="time";resetDetailGrouping();renderDetail()}
function setDetailPage(page){detailPage=page;renderDetail()}
function setErrorPage(page){errPage=page;render();requestAnimationFrame(()=>{document.getElementById("errorSecBody").scrollTop=0})}
function toggleDetailPeriod(period){if(expandedDetailPeriods.has(period))expandedDetailPeriods.delete(period);else expandedDetailPeriods.add(period);detailInitialized=true;renderDetail()}
function renderDetail(){
  if(!D)return;
  const grouped=grp(detailRangeDaily(D.daily||{}),P);
  let periods=Object.entries(grouped).map(([key,userRows])=>{
    const members=Object.entries(userRows).map(([userKey,data])=>{const info=D.users[userKey]||{};return{key:userKey,name:info.name||userKey.slice(0,8),data}}).filter(member=>!detailQuery||member.name.toLowerCase().includes(detailQuery)||member.key.toLowerCase().includes(detailQuery));
    if(!members.length)return null;
    members.sort((a,b)=>detailTokens(b.data)-detailTokens(a.data)||b.data.requests-a.data.requests||a.name.localeCompare(b.name,"zh-CN"));
    return{key,members,total:detailTotals(members)};
  }).filter(Boolean);
  const latestKey=periods.reduce((latest,period)=>!latest||period.key>latest?period.key:latest,"");
  if(!detailInitialized&&latestKey){expandedDetailPeriods.add(latestKey);detailInitialized=true}
  periods.sort((a,b)=>detailSort==="tokens"?detailTokens(b.total)-detailTokens(a.total)||b.key.localeCompare(a.key):detailSort==="requests"?b.total.requests-a.total.requests||b.key.localeCompare(a.key):b.key.localeCompare(a.key));
  const memberCount=periods.reduce((sum,period)=>sum+period.members.length,0);
  const totalPages=Math.max(1,Math.ceil(periods.length/DETAIL_PAGE_SIZE));
  detailPage=Math.max(1,Math.min(detailPage,totalPages));
  const pagePeriods=periods.slice((detailPage-1)*DETAIL_PAGE_SIZE,detailPage*DETAIL_PAGE_SIZE);
  const rows=[];
  for(const period of pagePeriods){
    const open=expandedDetailPeriods.has(period.key),total=period.total;
    rows.push('<tr class="detail-group" data-period="'+escH(period.key)+'" tabindex="0" aria-expanded="'+open+'" onclick="toggleDetailPeriod(this.dataset.period)" onkeydown="if(event.keyCode===13||event.keyCode===32){event.preventDefault();toggleDetailPeriod(this.dataset.period)}"><td class="detail-sticky"><span class="detail-period"><span class="detail-period-toggle '+(open?'open':'')+'"></span><span>'+escH(detailPeriodLabel(period.key))+'</span><span class="detail-period-meta">'+period.members.length+' 位用户</span></span></td><td class="n">'+fmtT(total.requests)+'</td><td class="n">'+fmtT(total.inputTokens)+'</td><td class="n">'+fmtT(total.outputTokens)+'</td><td class="n">'+fmtT(total.cacheCreationTokens)+'</td><td class="n">'+fmtT(total.cacheReadTokens)+'</td><td class="n hl">'+fmtT(detailTokens(total))+'</td></tr>');
    if(open){for(const member of period.members){const data=member.data,totalTokens=detailTokens(data),share=detailTokens(total)>0?Math.round(totalTokens/detailTokens(total)*100):0;rows.push('<tr class="detail-member"><td class="detail-sticky"><span class="detail-user"><span class="detail-user-name">'+escH(member.name)+'</span><span class="detail-key">'+escH(maskDetailKey(member.key))+'</span></span></td><td class="n">'+fmtT(data.requests||0)+'</td><td class="n">'+fmtT(data.inputTokens||0)+'</td><td class="n">'+fmtT(data.outputTokens||0)+'</td><td class="n">'+fmtT(data.cacheCreationTokens||0)+'</td><td class="n">'+fmtT(data.cacheReadTokens||0)+'</td><td class="n hl">'+fmtT(totalTokens)+'<span class="detail-share">'+share+'%</span></td></tr>')}}
  }
  document.querySelector("#dTable tbody").innerHTML=rows.length?rows.join(""):'<tr><td colspan="7" class="empty">'+(detailQuery?'没有匹配的用户记录':'暂无数据')+'</td></tr>';
  document.getElementById("detailHint").textContent=periods.length+' 个周期 · '+memberCount+' 条用户记录';
  document.getElementById("workspaceCountDetail").textContent=periods.length;
  document.getElementById("detailPages").innerHTML=periods.length?'<span>第 '+detailPage+' / '+totalPages+' 页</span><button type="button" onclick="setDetailPage('+(detailPage-1)+')" '+(detailPage<=1?'disabled':'')+'>上一页</button><button type="button" onclick="setDetailPage('+(detailPage+1)+')" '+(detailPage>=totalPages?'disabled':'')+'>下一页</button>':'';
}
function switchProfileView(v){currentProfile=v||"all";resetDetailGrouping();load()}
// Protocol segmented control: switches the "all profiles" aggregation between
// Anthropic (Claude Code) and Responses (Codex) views. Selecting a specific
// profile overrides it — the segment then mirrors that profile's protocol.
function setProtoSeg(proto){document.querySelectorAll("#protoSeg button").forEach(b=>b.classList.toggle("on",b.dataset.proto===(proto||"")))}
function switchProtocolView(proto){PROTO=proto||"";if(currentProfile!=="all"){currentProfile="all";const sel=document.getElementById("profileSel");if(sel)sel.value="all"}setProtoSeg(PROTO);resetDetailGrouping();load()}
document.querySelectorAll("#protoSeg button").forEach(b=>b.addEventListener("click",()=>switchProtocolView(b.dataset.proto)));
const protoLabel=proto=>proto==="anthropic"?"Anthropic":proto==="responses"?"OpenAI":"";
function render(){
  if(!D)return;
  // Populate profile dropdown
  const sel=document.getElementById("profileSel");
  if(sel.options.length<=1 && D.profiles){
    sel.innerHTML='<option value="all">全部方案</option>';
    for(const p of D.profiles){
      const sfx="/"+p.suffix+(p.isDefault?" · 默认入口":"")+(p.protocol==="responses"?" · Codex":" · Claude Code");
      sel.innerHTML+='<option value="'+escH(p.suffix)+'">'+escH(p.name)+' '+escH(sfx)+'</option>';
    }
    sel.value=currentProfile==="all"?"all":currentProfile;
  }
  // Rebuild chart filter dropdowns on every render (30s refresh), keeping the
  // current selection; fall back to "all" if the value disappeared from the data.
  const rebuildFilterSel=(id,entries,allLabel)=>{
    const el=document.getElementById(id);
    const keep=el.value||"all";
    const avail=new Set(entries.map(e=>e[0]));
    const next=avail.has(keep)?keep:"all";
    el.innerHTML='<option value="all">'+allLabel+'</option>'+entries.map(e=>'<option value="'+escH(e[0])+'">'+escH(e[1])+'</option>').join("");
    el.value=next;
    return next;
  };
  const modelEntries=Object.entries(D.models||{}).map(([m,v])=>[m,m+" ("+fmtTk(v.requests||0)+"次)"]).sort((a,b)=>(D.models[b[0]].requests||0)-(D.models[a[0]].requests||0));
  for(const dh of Object.values(D.hourlyModels||{}))for(const hm of Object.values(dh))for(const m of Object.keys(hm))if(!D.models||!D.models[m])modelEntries.push([m,m]);
  MDL=rebuildFilterSel("modelSel",modelEntries,"全部模型");
  USR=rebuildFilterSel("userSel",Object.keys(D.users||{}).map(k=>[k,D.users[k].name]),"全部用户");
  const us=Object.values(D.users),allTokens=us.reduce((s,u)=>s+totalTokens(u),0),tr=us.reduce((s,u)=>s+u.totalRequests,0);
  const td=new Date(Date.now()+8*36e5).toISOString().slice(0,10),tdd=(D.daily||{})[td]||{};
  const todayTokens=Object.values(tdd).reduce((s,d)=>s+totalTokens(d),0),tR=Object.values(tdd).reduce((s,d)=>s+d.requests,0);
  document.getElementById("cards").innerHTML=c("今日用量",todayTokens,"var(--accent)",1)+c("今日请求",tR,"var(--blue)",1)+c("总用量",allTokens,"var(--green)",1)+c("总请求",tr,"var(--orange)",1)+c("今日错误",(Array.isArray(D.errors)?D.errors:[]).filter(e=>e.time&&e.time.startsWith(td)).length,"var(--red)",1);
  runCountUps(document.getElementById("cards"));
  const psb=document.getElementById("profileSummaryBody"),profiles=Array.isArray(D.profileSummaries)?D.profileSummaries:[];
  const rowOf=p=>{const st=p.breakerState||"UNKNOWN";const rl=p.rateLimit;let col,led,stateLabel;if(rl){col='var(--red)';led='err';const rm=new Date(rl.resumeAt);stateLabel='限额中 '+String(rm.getHours()).padStart(2,'0')+':'+String(rm.getMinutes()).padStart(2,'0')+'恢复';}else{col=st==="CLOSED"?"var(--green)":st==="HALF_OPEN"?"var(--orange)":"var(--red)";led=st==="CLOSED"?"on":st==="HALF_OPEN"?"warn":"err";stateLabel=st==="CLOSED"?"正常":st==="HALF_OPEN"?"探测中":"熔断"+(p.breakerCooldownRemaining>0?' '+Math.ceil(p.breakerCooldownRemaining/1000)+'s后探测':'');}const current=currentProfile!=="all"&&p.suffix===currentProfile;const gBadge=p.inDefaultGroup?' <span style="color:var(--blue);font-size:10px;font-weight:600">默认组·'+(p.groupOrder+1)+'</span>':'';const rBadge=p.inResponsesGroup?' <span style="color:var(--blue);font-size:10px;font-weight:600">Resp组·'+(p.responsesGroupOrder+1)+'</span>':'';const protoBadge=p.protocol==='responses'?' <span style="color:var(--blue);font-size:10px">Codex</span>':'';const bLabel=p.billingType==='coding_plan'?' <span style="color:var(--dim);font-size:10px">CP</span>':p.billingType==='token_plan'?' <span style="color:var(--dim);font-size:10px">TP</span>':'';const pk=(p.peakHours&&p.peakHours.length)?(function(rs){const now=new Date(),cur=((now.getTime()+8*3600000)%86400000)/60000;const tm=function(t){if(!t)return null;const a=t.split(':');return (+a[0])*60+(+a[1])};const inPk=rs.some(function(r){const s=tm(r.start),e=tm(r.end);return s!==null&&e!==null&&s!==e&&(s<e?(cur>=s&&cur<e):(cur>=s||cur<e))});return ' <span style="color:'+(inPk?'var(--orange)':'var(--dim)')+';font-size:10px" title="高峰时段(北京时间) '+rs.map(function(r){return r.start+'-'+r.end}).join(', ')+'">'+(inPk?'高峰中':rs.map(function(r){return r.start+'-'+r.end}).join(','))+'</span>'})(p.peakHours):'';const rt2=(function(){if(p.peakQuotaRate==null&&p.offPeakQuotaRate==null)return'';const pr=p.peakQuotaRate==null?1:p.peakQuotaRate,orr=p.offPeakQuotaRate==null?1:p.offPeakQuotaRate;const nCustom=Object.keys(p.modelQuotaRates||{}).length;if(pr===1&&orr===1&&nCustom===0)return'';var now=new Date(),cur=((now.getTime()+8*3600000)%86400000)/60000;var tm=function(t){if(!t)return null;var a=t.split(':');return (+a[0])*60+(+a[1])};var ip=(p.peakHours||[]).some(function(r){var s=tm(r.start),e=tm(r.end);return s!==null&&e!==null&&s!==e&&(s<e?(cur>=s&&cur<e):(cur>=s||cur<e))});return ' <span style="color:var(--accent);font-size:10px" title="默认配额倍率：高峰 ×'+pr+' / 低谷 ×'+orr+'（当前'+(ip?'高峰':'低谷')+'）'+(nCustom?'；另有 '+nCustom+' 个模型单独定价':'')+'">×'+(ip?pr:orr)+(nCustom?'+'+nCustom:'')+'</span>'})();const restricted=(p.inDefaultGroup&&profiles.filter(x=>x.inDefaultGroup).length>=2)||(p.inResponsesGroup&&profiles.filter(x=>x.inResponsesGroup).length>=2);const entryCode=p.protocol==='responses'?'/v1/responses':'/v1';const defBadge=(p.isDefault||p.isResponsesDefault)?' <span style="color:var(--green);font-size:11px;font-weight:600;vertical-align:middle">默认</span>':'';return'<tr'+(current?' class="profile-current" aria-current="true"':'')+'><td>'+escH(p.name)+defBadge+gBadge+rBadge+protoBadge+bLabel+pk+rt2+(current?' <span class="current-mark">当前</span>':'')+'</td><td>'+(restricted?'<code>'+entryCode+'</code> <span style="color:var(--dim);font-size:10px">仅 '+entryCode+'</span>':'<code>/'+escH(p.suffix)+'</code>'+((p.isDefault||p.isResponsesDefault)?' <span style="color:var(--dim)">/ <code>'+entryCode+'</code></span>':''))+'</td><td style="font-size:12px;color:var(--dim);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escH((p.upstream||'').replace('https://','').replace('http://',''))+'</td><td class="n">'+fmtT(p.todayRequests||0)+'</td><td class="n hl">'+fmtT(p.todayTokens||0)+'</td><td><span class="led '+led+'"></span><span style="color:'+col+';font-size:12px">'+stateLabel+'</span></td></tr>'};
  const anthProfiles=profiles.filter(p=>p.protocol!=="responses"),respProfiles=profiles.filter(p=>p.protocol==="responses");
  const protoRow=(label,entry,count)=>'<tr class="proto-row"><td colspan="6">'+label+' · 入口 '+entry+' · '+count+' 个方案</td></tr>';
  let psbHtml="";
  if(anthProfiles.length)psbHtml+=protoRow("Anthropic","/v1",anthProfiles.length)+anthProfiles.map(rowOf).join("");
  if(respProfiles.length)psbHtml+=protoRow("OpenAI","/v1/responses",respProfiles.length)+respProfiles.map(rowOf).join("");
  psb.innerHTML=profiles.length?psbHtml:'<tr><td colspan="6" class="empty">暂无方案</td></tr>';
  const profileLabel=D.profileView||(currentProfile==="all"?"全部方案":"默认方案");
  const curProtoProf=(D.profiles||[]).find(p=>p.suffix===currentProfile);
  setProtoSeg(currentProfile!=="all"?((curProtoProf&&curProtoProf.protocol)||""):PROTO);
  const protoSuffix=protoLabel(currentProfile!=="all"?((curProtoProf&&curProtoProf.protocol)||""):PROTO);
  document.getElementById("profileContext").textContent="当前查看："+profileLabel+(protoSuffix?" · "+protoSuffix:"");
  const upstreamInfo=D.upstream?(" | 上游: "+D.upstream.replace("https://","").replace("http://","")):"";
  document.getElementById("meta").innerHTML='<span style="color:var(--accent);font-weight:600">方案: '+profileLabel+(protoSuffix?' · '+protoSuffix:'')+'</span>'+upstreamInfo+' &nbsp;|&nbsp; 更新于 '+(function(){const d=new Date();const utc=d.getTime()+d.getTimezoneOffset()*60000;return new Date(utc+8*3600000).toLocaleTimeString("zh-CN")})()+" (北京时间) | 每30秒刷新";

  // Charts —— 六图共用全局筛选：P 周期 / MT 指标 / MDL 模型 / USR 用户 / DS+DE 日期范围。
  // 四张非 24h 图的窗口用 effBounds()(日期范围生效时优先,否则周期窗口);两张 24h 图恒用 winBounds()。
  const wb=winBounds();
  const fd0=filteredDaily();
  const eb=effBounds();
  let fd=fd0;
  if(eb.ranged){const rf={};for(const[date,ud]of Object.entries(fd0)){if(date<eb.start||date>eb.end)continue;rf[date]=ud}fd=rf}
  const g=grp(fd,P),keys=Object.keys(g).sort(),uks=Object.keys(D.users);
  const val=s=>MT==="requests"?(s.requests||0):totalTokens(s);
  document.getElementById("trendNote").textContent=MDL!=="all"?"模型筛选：不含缓存 Token":"";
  if(C.t)C.t.destroy();if(C.p)C.p.destroy();if(C.m)C.m.destroy();if(C.h)C.h.destroy();if(C.hm)C.hm.destroy();if(C.pr)C.pr.destroy();
  C.t=new Chart(document.getElementById("trend"),{type:"bar",data:{labels:keys.map(k=>lbl(P,k)),datasets:uks.map((u,i)=>({label:D.users[u].name,data:keys.map(k=>val(g[k][u]||{})),backgroundColor:COL[i%COL.length]+"cc",borderRadius:3,borderSkipped:false}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:trendLegend(),tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{stacked:true,ticks:{color:"#686863",font:{size:10}},grid:{color:"rgba(24,24,22,.08)"}},y:{stacked:true,ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});
  // 用户分布：按有效窗口累加(默认按日=今天;日期范围生效时按范围),横向柱状图,Y 轴显示用户名完整可读。
  const tot=uks.map(u=>{let t=0;for(const[date,ud]of Object.entries(fd)){const s=ud[u];if(s)t+=val(s)}return t});
  // 用户分布：横向柱状图，Y 轴显示用户名完整可读。
  const uIdx=tot.map((_,i)=>i).sort((a,b)=>tot[b]-tot[a]);
  C.p=new Chart(document.getElementById("pie"),{type:"bar",data:{labels:uIdx.map(i=>D.users[uks[i]].name),datasets:[{label:MT==="requests"?"请求数":"总 Token",data:uIdx.map(i=>tot[i]),backgroundColor:uIdx.map((_,i)=>COL[i%COL.length]+"cc"),borderWidth:0,borderRadius:3,borderSkipped:false}]},options:{indexAxis:"y",responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>MT==="requests"?fmtT(ctx.raw)+" 次请求":fmtT(ctx.raw)+" tokens"}}},scales:{x:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}},y:{ticks:{color:"#686863",font:{size:11},autoSkip:false},grid:{display:false}}}}});

  // 模型请求分布：按有效窗口(日期范围优先,否则周期窗口,北京时间)基于 usage_daily_model
  // 保留约 400 天的按日模型数据求和，可按用户与指标筛选。横向柱状图便于读取模型名。
  const dm=D.dailyModels||{};
  const mAgg={};
  for(const [date,users] of Object.entries(dm)){
    if(date<eb.start||date>eb.end)continue;
    for(const [u,models] of Object.entries(users)){
      if(USR!=="all"&&u!==USR)continue;
      for(const [m,v] of Object.entries(models)){
        if(!mAgg[m])mAgg[m]={requests:0,tokens:0};
        mAgg[m].requests+=(v.requests||0);mAgg[m].tokens+=((v.inputTokens||0)+(v.outputTokens||0));
      }
    }
  }
  const mNames=Object.keys(mAgg);
  const mVal=mNames.map(m=>MT==="requests"?mAgg[m].requests:mAgg[m].tokens);
  const mIdx=mVal.map((_,i)=>i).sort((a,b)=>mVal[b]-mVal[a]);
  C.m=new Chart(document.getElementById("modelChart"),{type:"bar",data:{labels:mIdx.map(i=>mNames[i]),datasets:[{label:MT==="requests"?"请求数":"Token",data:mIdx.map(i=>mVal[i]),backgroundColor:mIdx.map((_,i)=>COL[i%COL.length]+"cc"),borderWidth:0,borderRadius:3,borderSkipped:false}]},options:{indexAxis:"y",responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>MT==="requests"?fmtT(ctx.raw)+" 次请求":fmtT(ctx.raw)+" tokens"}}},scales:{x:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}},y:{ticks:{color:"#686863",font:{size:11},autoSkip:false},grid:{display:false}}}}});

  // 24小时趋势图：周期窗口内逐日同小时累加（按日=当天真实曲线；周/月/年=各小时累计分布）。
  // 不受日期范围筛选影响（date input 只作用于其余四图）。
  const hrs=[];for(let i=0;i<24;i++)hrs.push(i.toString().padStart(2,"0")+":00");
  const hAgg=Array.from({length:24},()=>({requests:0,tokens:0}));
  for(const [date,hours] of Object.entries(D.hourly||{})){
    if(date<wb.wStart||date>wb.td)continue;
    for(const [h,v] of Object.entries(hours)){
      const i=Number(h);if(!(i>=0&&i<24)||typeof v!=="object")continue;
      hAgg[i].requests+=(v.requests||0);hAgg[i].tokens+=totalTokens(v);
    }
  }
  const hReq=hAgg.map(a=>a.requests),hTokens=hAgg.map(a=>a.tokens);
  C.h=new Chart(document.getElementById("hourChart"),{type:"line",data:{labels:hrs,datasets:[{label:"请求数",data:hReq,borderColor:"#2f6e50",backgroundColor:"rgba(47,110,80,.12)",fill:true,tension:.28,pointRadius:2,pointBackgroundColor:"#2f6e50",pointHoverRadius:4,borderWidth:2,yAxisID:"y"},{label:"总 Token",data:hTokens,borderColor:"#181816",backgroundColor:"rgba(24,24,22,.08)",fill:true,tension:.28,pointRadius:2,pointBackgroundColor:"#181816",pointHoverRadius:4,borderWidth:2,yAxisID:"y1"}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:{labels:{color:"#686863",font:{size:11},usePointStyle:true,pointStyle:"circle"}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{ticks:{color:"#686863",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{type:"linear",position:"left",ticks:{color:"#2f6e50"},grid:{color:"rgba(24,24,22,.08)"},title:{display:true,text:"请求数",color:"#2f6e50",font:{size:10}}},y1:{type:"linear",position:"right",ticks:{color:"#181816",callback:v=>fmtTk(v)},grid:{drawOnChartArea:false},title:{display:true,text:"Tokens",color:"#181816",font:{size:10}}}}}});

  // 24小时模型使用趋势：窗口内同小时累加，按模型分 series 的折线，Y 轴跟随指标筛选。
  // 模型取窗口总量 Top6，其余合并为「其他」，避免 legend 过长。数据自 usage_hourly_model 表启用日起累积。
  const hmAgg=Array.from({length:24},()=>({}));
  for(const [date,hours] of Object.entries(D.hourlyModels||{})){
    if(date<wb.wStart||date>wb.td)continue;
    for(const [h,models] of Object.entries(hours)){
      const i=Number(h);if(!(i>=0&&i<24)||typeof models!=="object")continue;
      for(const [m,v] of Object.entries(models)){
        if(!hmAgg[i][m])hmAgg[i][m]={requests:0,tokens:0};
        hmAgg[i][m].requests+=(v.requests||0);hmAgg[i][m].tokens+=((v.inputTokens||0)+(v.outputTokens||0));
      }
    }
  }
  const hmTot={};for(const hourAgg of hmAgg)for(const [m,v] of Object.entries(hourAgg))hmTot[m]=(hmTot[m]||0)+(MT==="requests"?v.requests:v.tokens);
  const topModels=Object.keys(hmTot).sort((a,b)=>hmTot[b]-hmTot[a]).slice(0,6);
  const hasOther=Object.keys(hmTot).length>topModels.length;
  const hmSeries=topModels.map(m=>({label:m,data:hmAgg.map(a=>MT==="requests"?((a[m]||{}).requests||0):((a[m]||{}).tokens||0))}));
  if(hasOther)hmSeries.push({label:"其他",data:hmAgg.map(a=>{let t=0;for(const [m,v] of Object.entries(a))if(!topModels.includes(m))t+=MT==="requests"?v.requests:v.tokens;return t})});
  C.hm=new Chart(document.getElementById("hourModelChart"),{type:"line",data:{labels:hrs,datasets:hmSeries.map((s,i)=>({label:s.label,data:s.data,borderColor:COL[i%COL.length],backgroundColor:COL[i%COL.length]+"22",fill:i===0,tension:.28,pointRadius:2,pointBackgroundColor:COL[i%COL.length],pointHoverRadius:4,borderWidth:2}))},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:trendLegend(),tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)+(MT==="requests"?" 次请求":" tokens")}}},scales:{x:{ticks:{color:"#686863",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});

  // 方案请求情况：跨方案维度（恒为全部方案，不随方案下拉收窄），按周期分桶的堆叠柱。
  // 统计逻辑与 Token 用量趋势一致:默认全史按周期分桶,日期范围生效时才收窄窗口。
  // 模型筛选生效时切换到 profileDailyModels 数据源（不含缓存 Token）。
  document.getElementById("profileNote").textContent=MDL!=="all"?"模型筛选：不含缓存 Token":"";
  const pdBase=MDL==="all"?(D.profileDaily||{}):(D.profileDailyModels||{});
  const suffixName={};for(const p of (Array.isArray(D.profiles)?D.profiles:[]))suffixName[p.suffix]=p.name;
  const pBuckets={};
  for(const [sfx,days] of Object.entries(pdBase)){
    for(const [date,entry] of Object.entries(days)){
      if(eb.ranged&&(date<eb.start||date>eb.end))continue;
      const k=P==="week"?wk(date):P==="month"?date.slice(0,7):P==="year"?date.slice(0,4):date;
      if(!pBuckets[k])pBuckets[k]={};
      if(!pBuckets[k][sfx])pBuckets[k][sfx]={requests:0,tokens:0};
      if(MDL==="all"){
        pBuckets[k][sfx].requests+=(entry.requests||0);pBuckets[k][sfx].tokens+=totalTokens(entry);
      }else{
        const v=entry[MDL]||{};
        pBuckets[k][sfx].requests+=(v.requests||0);pBuckets[k][sfx].tokens+=((v.inputTokens||0)+(v.outputTokens||0));
      }
    }
  }
  const pSorted=Object.keys(pBuckets).sort();
  const pSfx=Object.keys(pdBase).sort();
  C.pr=new Chart(document.getElementById("profileChart"),{type:"bar",data:{labels:pSorted.map(k=>lbl(P,k)),datasets:pSfx.map((sfx,i)=>({label:suffixName[sfx]||sfx,data:pSorted.map(k=>{const s=(pBuckets[k]||{})[sfx];return s?(MT==="requests"?s.requests:s.tokens):0}),backgroundColor:COL[i%COL.length]+"cc",borderRadius:3,borderSkipped:false}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:trendLegend(),tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)+(MT==="requests"?" 次请求":" tokens")}}},scales:{x:{stacked:true,ticks:{color:"#686863",font:{size:10}},grid:{color:"rgba(24,24,22,.08)"}},y:{stacked:true,ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});

  // User table. In the all-profiles view the single 配额 column cannot say
  // anything useful (a user has one quota PER profile), so it is replaced by one
  // column per quota-bearing profile — the profile name is written once in the
  // header instead of repeated under every user, which keeps N profiles readable.
  const ut=document.querySelector("#uTable tbody");
  const ul=Object.entries(D.users).sort((a,b)=>totalTokens(b[1])-totalTokens(a[1]));
  const qm=D.userQuotaMatrix||null;
  const qPools=qm&&Array.isArray(qm.pools)?qm.pools:[];
  const multiQuota=!!qm&&qPools.length>0;
  renderUserTableHead(multiQuota?qPools:null);
  renderUserQuotaContext(multiQuota?qm:null,ul);
  applyQuotaFocus();
  const colSpan=multiQuota?10+qPools.length:11;
  if(!ul.length){ut.innerHTML='<tr><td colspan="'+colSpan+'" class="empty">暂无数据</td></tr>'}else{ut.innerHTML=ul.map(([uk,u],idx)=>{const on=u.lastActive&&Date.now()-new Date(u.lastActive).getTime()<36e5;const effQ=(D.userQuotaEff||{})[uk];const uq=effQ?effQ.limit:((D.userQuotas||{})[uk]||D.profileQuota||0);const td2=(D.daily||{})[td]||{};const tdu=td2[uk]||{};const used=effQ?effQ.used:ioTokens(tdu);const qPct=uq>0?Math.min(100,Math.round(used/uq*100)):0;const rank='<span class="rank">'+(idx+1)+'.</span>';const qTag=effQ&&effQ.bonus>0?' <span style="font-size:10px;color:var(--green);border:1px solid var(--green);border-radius:3px;padding:0 3px;white-space:nowrap" title="今日临时加量，明日自动失效">+'+fmtTk(effQ.bonus)+'</span>':(effQ&&effQ.resetApplied?' <span style="font-size:10px;color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:0 3px;white-space:nowrap" title="今日用量已重置（统计保留）">已重置</span>':'');const rTag=(effQ&&effQ.rate!=null&&effQ.rate!==1)?' <span style="font-size:10px;color:var(--dim);border:1px solid var(--border);border-radius:3px;padding:0 3px;white-space:nowrap" title="配额倍率 ×'+effQ.rate+'（当前时段）· 实际 '+fmtT(effQ.rawUsed||0)+'，计入配额 '+fmtT(effQ.used||0)+'">×'+effQ.rate+'</span>':'';const qCell=uq>0?'<span style="color:var(--accent);font-size:12px">'+qPct+'%</span> '+quotaBar(qPct)+qTag+rTag:'<span style="color:var(--dim)">-</span>';const quotaCells=multiQuota?qPools.map(p=>quotaMatrixCell(((qm.matrix||{})[uk]||{})[p.key],u.name,p)).join(""):'<td class="n" style="white-space:nowrap">'+qCell+'</td>';return'<tr><td>'+rank+escH(u.name)+'</td><td><span class="led '+(on?'on':'')+'"></span><span style="color:'+(on?'var(--green)':'var(--dim)')+';font-size:12px">'+(on?'在线':'离线')+'</span></td><td class="n stat-col">'+fmtT(u.totalRequests)+'</td><td class="n stat-col">'+fmtT(u.totalInputTokens)+'</td><td class="n stat-col">'+fmtT(u.totalOutputTokens)+'</td><td class="n stat-col">'+fmtT(u.cacheCreationTokens || 0)+'</td><td class="n stat-col">'+fmtT(u.cacheReadTokens || 0)+'</td><td class="n hl stat-col">'+fmtT(ioTokens(u))+'</td><td class="n">'+fmtT(ioTokens(tdu))+'</td>'+quotaCells+'<td style="font-size:12px;color:var(--dim)">'+ago(u.lastActive)+'</td></tr>'}).join("")}

  renderDetail();

  // Error table with pagination
  const allErrs=Array.isArray(D.errors)?D.errors:[];
  const totalErrPages=Math.max(1,Math.ceil(allErrs.length/ERR_PAGE_SIZE));
  if(errPage>totalErrPages)errPage=totalErrPages;
  const errs=allErrs.slice((errPage-1)*ERR_PAGE_SIZE,errPage*ERR_PAGE_SIZE);
  const et=document.querySelector("#eTable tbody");
  if(!errs.length){et.innerHTML='<tr><td colspan="6" class="empty">暂无错误记录</td></tr>'}else{et.innerHTML=errs.map(e=>{const sc=e.statusCode||"-";const col=sc>=500?"var(--red)":sc>=400?"var(--orange)":"var(--dim)";return'<tr><td style="font-size:12px;white-space:nowrap">'+(e.time?fmtBJ(e.time):"-")+'</td><td>'+(e.user||"-")+'</td><td class="n" style="color:'+col+';font-weight:600">'+sc+'</td><td style="font-size:12px;color:var(--blue)">'+(e.model||"-")+'</td><td style="font-size:12px;color:var(--dim);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(e.path||"-")+'</td><td style="font-size:12px;color:var(--red);max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+(e.error||"").replace(/"/g,'&quot;')+'">'+(e.error||"-")+'</td></tr>'}).join("")}
  const pg=document.getElementById("errPages");
  pg.innerHTML='<span style="font-size:12px;color:var(--dim)">第 '+errPage+"/"+totalErrPages+' 页 (共 '+allErrs.length+' 条)</span> '+(errPage>1?'<button onclick="setErrorPage('+(errPage-1)+')" style="font-size:11px;background:var(--card);color:var(--text);border:1px solid var(--border);padding:2px 10px;border-radius:4px;cursor:pointer">上一页</button> ':'')+(errPage<totalErrPages?'<button onclick="setErrorPage('+(errPage+1)+')" style="font-size:11px;background:var(--card);color:var(--text);border:1px solid var(--border);padding:2px 10px;border-radius:4px;cursor:pointer">下一页</button>':'');
  document.getElementById("errorCount").textContent=allErrs.length>0?'('+allErrs.length+')':'';
  document.getElementById("errorHint").textContent=allErrs.length>0?(allErrs.length+'条错误'):'暂无错误';
  renderWorkspaceSummaries();
  renderRateBoard();
}
async function load(){try{const profile=currentProfile==="all"?"all":currentProfile;const qs=[];if(profile!=="all")qs.push("profile="+encodeURIComponent(profile));else if(PROTO)qs.push("protocol="+PROTO);const r=await fetch("/api/stats"+(qs.length?"?"+qs.join("&"):""));D=await r.json();render()}catch(e){document.getElementById("meta").textContent="Error: "+e.message}}
function toggleSec(id){const body=document.getElementById(id+"Body");const icon=document.getElementById(id+"Icon");const open=body.classList.toggle("open");icon.classList.toggle("open",open)}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("on"));b.classList.add("on");P=b.dataset.p;resetDetailGrouping();render()}));
document.getElementById("metricSel").addEventListener("change",e=>{MT=e.target.value;render()});
document.getElementById("modelSel").addEventListener("change",e=>{MDL=e.target.value;resetDetailGrouping();render()});
document.getElementById("userSel").addEventListener("change",e=>{USR=e.target.value;render()});
function resetChartFilters(){P="day";MT="tokens";MDL="all";USR="all";DS="";DE="";PROTO="";setProtoSeg("");document.querySelectorAll("#globalTabs .tab").forEach(x=>x.classList.toggle("on",x.dataset.p==="day"));document.getElementById("metricSel").value="tokens";document.getElementById("modelSel").value="all";document.getElementById("userSel").value="all";document.getElementById("dateStart").value="";document.getElementById("dateEnd").value="";if(currentProfile!=="all"){currentProfile="all";document.getElementById("profileSel").value="all"}resetDetailGrouping();load()}
document.querySelectorAll(".workspace-tab").forEach(button=>{button.addEventListener("click",()=>setWorkspaceTab(button.id.replace("workspace-tab-","")));button.addEventListener("keydown",handleWorkspaceTabKeydown)});
document.getElementById("clearErrors").addEventListener("click",async()=>{if(confirm("确定清除所有错误记录？")){const csrf=(document.cookie.match(/tm_csrf=([^;]+)/)||[])[1]||'';await fetch("/api/clear-errors",{method:"POST",headers:{"x-csrf-token":csrf}});toast('错误记录已清除');errPage=1;load()}});
function startAutoRefresh(){if(refreshTimer)clearInterval(refreshTimer);refreshTimer=setInterval(()=>{if(autoRefresh)load()},30000)}
document.getElementById("autoRefreshBtn").addEventListener("click",()=>{autoRefresh=!autoRefresh;const btn=document.getElementById("autoRefreshBtn");btn.textContent="自动刷新: "+(autoRefresh?"开":"关");btn.className=autoRefresh?"ar-on":"ar-off"});
window.addEventListener("resize",scheduleChartResize);
load();startAutoRefresh();
<\/script></body></html>`;
}

// ─── Login Page HTML ─────────────────────────────────────────────────────────
function loginHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2096%2096%22%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2222%22%20fill%3D%22%232f6e50%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fbfbf8%22%20stroke-width%3D%2213%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate(48%2048)%20scale(0.88)%20translate(-48%20-48)%22%3E%3Cpath%20d%3D%22M37%2026.5H31.5Q20.5%2026.5%2020.5%2037.5V58.5Q20.5%2069.5%2031.5%2069.5H37%22%2F%3E%3Cpath%20d%3D%22M59%2026.5H64.5Q75.5%2026.5%2075.5%2037.5V58.5Q75.5%2069.5%2064.5%2069.5H59%22%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2248%22%20r%3D%226.2%22%20fill%3D%22%23fbfbf8%22%2F%3E%3C%2Fsvg%3E">
<title>登录 - CC Team</title>
<style>
${UI_THEME}
${TOAST_CSS}
body{display:flex;justify-content:center;align-items:center;min-height:100vh;padding:24px}
.wrap{width:100%;max-width:390px}
.brand{margin-bottom:22px}.brand .t{font-size:24px;font-weight:650;margin-bottom:7px}.brand .s{font-size:13px;color:var(--dim)}.brand-row{display:flex;align-items:center;gap:12px}.brand-logo{width:38px;height:38px;flex:none}
.term{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:26px}
.term .hd{font-size:13px;font-weight:600;margin-bottom:18px;color:var(--text)}
.term label{display:block;font-size:12px;font-weight:550;color:var(--dim);margin-bottom:6px}
.term input{width:100%;padding:11px 12px;background:var(--surface);border:1px solid var(--border-strong);border-radius:5px;color:var(--text);font-size:15px;outline:none;margin-bottom:18px}
.term input:focus{border-color:var(--accent)}
.term button{width:100%;padding:11px 12px;background:var(--text);color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer}
.term button:hover{background:#33332f}
.err{color:var(--red);background:#fff2f0;border:1px solid #f1c8c2;border-radius:5px;padding:9px 10px;font-size:12px;margin-bottom:14px;display:none}
</style></head><body data-theme="editorial-light">
<div class="wrap">
<div class="brand brand-row"><svg class="brand-logo" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="#2f6e50"/><g fill="none" stroke="#fbfbf8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" transform="translate(48 48) scale(0.9) translate(-48 -48)"><path d="M37 26.5H31.5Q20.5 26.5 20.5 37.5V58.5Q20.5 69.5 31.5 69.5H37"/><path d="M59 26.5H64.5Q75.5 26.5 75.5 37.5V58.5Q75.5 69.5 64.5 69.5H59"/></g><circle cx="48" cy="48" r="4.95" fill="#fbfbf8"/></svg><div><div class="t">CC Team</div><div class="s">团队 AI 编码用量网关</div></div></div>
<div class="term">
<div class="hd">登录管理后台</div>
<div class="err" id="err">密码错误，请重试。</div>
<label>访问密码</label>
<input type="password" id="pw" placeholder="••••••••" autofocus>
<button onclick="doLogin()">登录</button>
</div></div>
<script>
${TOAST_JS}
document.getElementById("pw").addEventListener("keydown",e=>{if(e.key==="Enter")doLogin()});
async function doLogin(){const pw=document.getElementById("pw").value;const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})});if(r.ok){window.location.reload()}else{document.getElementById("err").style.display="block"}}
<\/script></body></html>`;
}

// ─── Personal Usage Page HTML ─────────────────────────────────────────────────
function personalUsageLandingHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2096%2096%22%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2222%22%20fill%3D%22%232f6e50%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fbfbf8%22%20stroke-width%3D%2213%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate(48%2048)%20scale(0.88)%20translate(-48%20-48)%22%3E%3Cpath%20d%3D%22M37%2026.5H31.5Q20.5%2026.5%2020.5%2037.5V58.5Q20.5%2069.5%2031.5%2069.5H37%22%2F%3E%3Cpath%20d%3D%22M59%2026.5H64.5Q75.5%2026.5%2075.5%2037.5V58.5Q75.5%2069.5%2064.5%2069.5H59%22%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2248%22%20r%3D%226.2%22%20fill%3D%22%23fbfbf8%22%2F%3E%3C%2Fsvg%3E">
<title>我的用量</title>
<style>
${UI_THEME}
${TOAST_CSS}
body{display:flex;justify-content:center;align-items:center;min-height:100vh;padding:24px;margin:0}
.wrap{width:100%;max-width:440px}.brand{margin-bottom:22px}.brand .t{font-size:24px;font-weight:650;margin-bottom:7px}.brand .s{font-size:13px;color:var(--dim)}.brand-row{display:flex;align-items:center;gap:12px}.brand-logo{width:38px;height:38px;flex:none}
.term{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:26px}.term .hd{font-size:13px;font-weight:600;margin-bottom:18px;color:var(--text)}
.term label{display:block;font-size:12px;font-weight:550;color:var(--dim);margin-bottom:6px}.term input{width:100%;padding:11px 12px;background:var(--surface);border:1px solid var(--border-strong);border-radius:5px;color:var(--text);font-size:14px;font-family:var(--font-mono);outline:none;margin-bottom:18px}.term input:focus{border-color:var(--accent)}
.term button{width:100%;padding:11px 12px;background:var(--text);color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer}.term button:hover{background:#33332f}
.note{font-size:12px;color:var(--dim);text-align:center;margin-top:14px}.note code{color:var(--accent);font-family:var(--font-mono)}
</style></head><body data-theme="editorial-light">
<div class="wrap">
<div class="brand brand-row"><svg class="brand-logo" width="38" height="38" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="#2f6e50"/><g fill="none" stroke="#fbfbf8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" transform="translate(48 48) scale(0.9) translate(-48 -48)"><path d="M37 26.5H31.5Q20.5 26.5 20.5 37.5V58.5Q20.5 69.5 31.5 69.5H37"/><path d="M59 26.5H64.5Q75.5 26.5 75.5 37.5V58.5Q75.5 69.5 64.5 69.5H59"/></g><circle cx="48" cy="48" r="4.95" fill="#fbfbf8"/></svg><div><div class="t">我的用量</div><div class="s">输入虚拟 Key 查看个人配额与消耗。</div></div></div>
<div class="term">
<div class="hd">查询个人用量</div>
<label>虚拟 Key</label>
<input type="text" id="key" placeholder="jx-xxxxxxxx" autofocus>
<button onclick="go()">查看用量</button>
<div class="note">或直接访问 <code>/usage/你的虚拟Key</code></div>
</div></div>
<script>
document.getElementById('key').addEventListener('keydown',e=>{if(e.key==='Enter')go()});
function go(){const k=document.getElementById('key').value.trim();if(k)location.href='/my-usage?key='+encodeURIComponent(k)}
</script></body></html>`;
}

// ─── Codex 一键接入（成员自助配置）───────────────────────────────────────────
// Codex 模型目录完全由方案配置生成：成员可访问的 Responses 方案的
// modelAliases + peakModelAliases 别名键（配置顺序）；只有当方案完全没配别名时
// 才回退到 allowedModels。不额外添加任何真实模型名。
// context_window 与多模态按别名取方案设置（modelContextWindows/modelMultimodal，
// 未配置时默认 128000、支持图片输入）。
function codexCatalogEntryJson(slug, target, priority, contextWindow, multimodal) {
  const cw = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128000;
  const modalities = multimodal === false ? ["text"] : ["text", "image"];
  return `    {
      "slug": ${JSON.stringify(slug)},
      "display_name": ${JSON.stringify(slug)},
      "description": "CC-Team alias -> ${target}",
      "default_reasoning_level": "high",
      "supported_reasoning_levels": [
        { "effort": "low", "description": "Light reasoning" },
        { "effort": "medium", "description": "Balanced reasoning" },
        { "effort": "high", "description": "Enhanced reasoning" }
      ],
      "shell_type": "shell_command",
      "visibility": "list",
      "supported_in_api": true,
      "priority": ${priority},
      "base_instructions": "",
      "supports_reasoning_summaries": true,
      "default_reasoning_summary": "none",
      "support_verbosity": false,
      "apply_patch_tool_type": "freeform",
      "truncation_policy": { "mode": "bytes", "limit": 10000 },
      "context_window": ${cw},
      "max_context_window": ${cw},
      "effective_context_window_percent": 95,
      "supports_parallel_tool_calls": true,
      "experimental_supported_tools": [],
      "input_modalities": ${JSON.stringify(modalities)}
    }`;
}

// Returns { entries: [{slug,target,contextWindow,multimodal}], json, defaultModel } for one member key.
function buildCodexModelCatalog(apiKey) {
  const entries = [];
  const seen = new Set();
  const add = (slug, target, contextWindow, multimodal) => {
    slug = String(slug || "").trim();
    if (!slug || slug === "*" || seen.has(slug)) return;
    seen.add(slug);
    entries.push({ slug, target: String(target || "").trim(), contextWindow: contextWindow || 128000, multimodal: multimodal !== false });
  };
  let fallbackRuntime = null;
  for (const runtime of Object.values(runtimes)) {
    if (runtime.protocol !== "responses") continue;
    if (!canUseProfile(apiKey, runtime).allowed) continue;
    const profileCfg = config.profiles[runtime.profileName] || {};
    const aliases = { ...(runtime.modelAliases || {}), ...(runtime.peakModelAliases || {}) };
    const aliasKeys = Object.keys(aliases);
    for (const alias of aliasKeys) {
      // 准入恒开：所有别名在 Codex 里都允许上传图片（input_modalities 含
      // image）。多模态勾选只决定网关侧是「直通」还是「自动转述」，见
      // bridgeImagesInRequest，不影响目录。
      add(alias, aliases[alias],
        profileCfg.modelContextWindows?.[alias] || profileCfg.contextWindow || 128000,
        true);
    }
    if (aliasKeys.length === 0 && !fallbackRuntime) fallbackRuntime = runtime;
  }
  if (entries.length === 0 && fallbackRuntime) {
    const profile = config.profiles[fallbackRuntime.profileName] || {};
    const cw = profile.contextWindow || 128000;
    for (const m of profile.allowedModels || []) add(m, m, cw);
  }
  const json = entries.length
    ? "{\n  \"models\": [\n" + entries.map((e, i) => codexCatalogEntryJson(e.slug, e.target, i, e.contextWindow, e.multimodal)).join(",\n") + "\n  ]\n}"
    : "{\n  \"models\": []\n}";
  return { entries, json, defaultModel: entries.length ? entries[0].slug : "" };
}

// The ccteam provider block Codex needs, with the member's key and the gateway
// address baked in. Shared by the install script and the manual/cc-switch tabs.
function codexProviderToml(host, key, proto) {
  return `[model_providers.ccteam]
name = "CC Team Gateway"
base_url = "${proto || "http"}://${host}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
experimental_bearer_token = "${key}"`;
}

function codexTopKeysToml(defaultModel) {
  return `model_provider = "ccteam"
${defaultModel ? `model = "${defaultModel}"
` : ""}model_catalog_json = "~/.codex/models.json"`;
}

// POSIX sh installer for `curl … | sh`. Idempotent: only manages the ccteam
// provider block and its top-level keys; every other section (projects, plugins,
// other providers) passes through untouched. Backs up config.toml first.
function buildCodexSetupScript(key, host, username, catalogJson, defaultModel, proto) {
  const scheme = proto || "http";
  const provBlock = codexProviderToml(host, key, scheme);
  const topKeys = codexTopKeysToml(defaultModel);
  return `#!/bin/sh
# CC-Team Codex 一键接入 — 成员: ${username}
# 幂等脚本：可重复执行；只管理 ccteam 相关配置，不影响其他 provider
set -e
CODEX_DIR="\${CODEX_HOME:-\$HOME/.codex}"
mkdir -p "\$CODEX_DIR"
CONFIG="\$CODEX_DIR/config.toml"
MODELS="\$CODEX_DIR/models.json"
TS="\$(date +%Y%m%d%H%M%S)"
CONFIG_BAK=""
MODELS_BAK=""
if [ -f "\$CONFIG" ]; then
  CONFIG_BAK="\$CONFIG.backup-ccteam-\$TS"
  cp "\$CONFIG" "\$CONFIG_BAK"
  echo "已备份原配置 → config.toml.backup-ccteam-\$TS"
fi

echo "[1/3] 写入模型目录 \$CODEX_DIR/models.json ..."
if [ -f "\$MODELS" ]; then
  MODELS_BAK="\$MODELS.backup-ccteam-\$TS"
  cp "\$MODELS" "\$MODELS_BAK"
  echo "已备份原模型目录 → models.json.backup-ccteam-\$TS"
fi
cat > "\$MODELS" <<'CC_MODELS_EOF'
${catalogJson}
CC_MODELS_EOF

echo "[2/3] 更新 \$CODEX_DIR/config.toml ..."
TOP_BLOCK='${topKeys}'
PROV_BLOCK='${provBlock}'
rollback() {
  echo "[提示] 配置更新失败，正在恢复原始文件 ..."
  if [ -n "\$CONFIG_BAK" ] && [ -f "\$CONFIG_BAK" ]; then cp "\$CONFIG_BAK" "\$CONFIG"; fi
  if [ -n "\$MODELS_BAK" ] && [ -f "\$MODELS_BAK" ]; then cp "\$MODELS_BAK" "\$MODELS"; fi
  echo "[提示] 已恢复原始内容，你的数据未受影响。请把以下输出发给管理员排查。"
  exit 1
}
if [ -f "\$CONFIG" ]; then
  # BSD awk (macOS) rejects literal newlines in -v values, so the blocks are
  # passed through the environment instead.
  TOP_BLOCK="\$TOP_BLOCK" PROV_BLOCK="\$PROV_BLOCK" awk '
    BEGIN { top_block = ENVIRON["TOP_BLOCK"]; prov_block = ENVIRON["PROV_BLOCK"]; in_top=1; printed=0; skip=0 }
    /^\\[model_providers\\.ccteam\\]$/ { skip=1; next }
    skip && /^\\[/ { skip=0 }
    skip { next }
    !printed && /^\\[/ { print top_block; print ""; printed=1 }
    /^\\[/ { in_top=0 }
    in_top && /^(model_provider|model|model_catalog_json)[[:space:]]*=/ { next }
    { print }
    END {
      if (!printed) { print top_block; print "" }
      print ""
      print prov_block
    }
  ' "\$CONFIG" > "\$CONFIG.tmp" || rollback
  # Sanity-check the rewritten file before replacing the original: non-empty
  # and carrying the new provider block. Otherwise restore from this run's backup.
  if [ -s "\$CONFIG.tmp" ] && grep -q "model_providers\\.ccteam" "\$CONFIG.tmp"; then
    mv "\$CONFIG.tmp" "\$CONFIG"
  else
    rm -f "\$CONFIG.tmp"
    rollback
  fi
else
  printf '%s\\\\n\\\\n%s\\\\n' "\$TOP_BLOCK" "\$PROV_BLOCK" > "\$CONFIG" || rollback
fi

echo "[3/3] 检查网关连通性 ..."
if command -v curl > /dev/null 2>&1 && curl -fsS -m 8 -H "Authorization: Bearer ${key}" "${scheme}://${host}/v1/models" > /dev/null 2>&1; then
  echo "[OK] 网关连通正常"
else
  echo "[提示] 连通检查未通过——请确认本机可以访问 ${scheme}://${host}（配置本身已完成）"
fi

echo ""
echo "========== 本次操作摘要 =========="
echo "1. 备份："
if [ -n "\$CONFIG_BAK" ]; then echo "   原配置   → \$CONFIG_BAK"; fi
if [ -n "\$MODELS_BAK" ]; then echo "   原模型目录 → \$MODELS_BAK"; fi
if [ -z "\$CONFIG_BAK" ] && [ -z "\$MODELS_BAK" ]; then echo "   （首次安装，无需备份）"; fi
echo "2. 写入 \$MODELS"
echo "   内容：方案配置的模型别名目录${defaultModel ? `（默认模型 ${defaultModel}）` : ""}"
echo "3. 更新 \$CONFIG"
echo "   只改了 model_provider / model / model_catalog_json 三行顶层键，"
echo "   并在末尾追加 [model_providers.ccteam] 一段；你的其他配置未动。"
echo "----------------------------------"
echo "下一步：完全退出 Codex（macOS: Cmd+Q）后重新打开即可使用。"
echo "如需恢复原配置：把对应 .backup-ccteam-$TS 文件复制回原名即可"
echo "（例如 cp \"\$CONFIG.backup-ccteam-$TS\" \"\$CONFIG\"）。"
${defaultModel ? `echo "默认模型 ${defaultModel}；模型选择器中可切换方案配置的其他别名。"\n` : ""}`;
}

// Windows (PowerShell 5.1+) twin of the sh installer: same backup / rewrite /
// validate-rollback / summary behavior. Differences: %USERPROFILE%\.codex home,
// model_catalog_json written as an absolute forward-slash path (tilde is not
// reliably expanded by Codex on Windows), and BOM-less UTF-8 writes via .NET so
// models.json stays parseable.
function buildCodexSetupScriptWin(key, host, username, catalogJson, defaultModel, proto) {
  const scheme = proto || "http";
  const provBlock = codexProviderToml(host, key, scheme);
  return `$ErrorActionPreference = "Stop"
# CC-Team Codex 一键接入 (Windows) — 成员: ${username}
# 幂等脚本：可重复执行；只管理 ccteam 相关配置，不影响其他 provider
$codex = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
New-Item -ItemType Directory -Force -Path $codex | Out-Null
$configPath = Join-Path $codex "config.toml"
$modelsPath = Join-Path $codex "models.json"
$ts = Get-Date -Format "yyyyMMddHHmmss"
$configBak = $null
$modelsBak = $null
if (Test-Path $configPath) {
  $configBak = "$configPath.backup-ccteam-$ts"
  Copy-Item $configPath $configBak
  Write-Host "已备份原配置 → config.toml.backup-ccteam-$ts"
}

Write-Host "[1/3] 写入模型目录 $modelsPath ..."
if (Test-Path $modelsPath) {
  $modelsBak = "$modelsPath.backup-ccteam-$ts"
  Copy-Item $modelsPath $modelsBak
  Write-Host "已备份原模型目录 → models.json.backup-ccteam-$ts"
}
$catalog = @'
${catalogJson}
'@
[System.IO.File]::WriteAllText($modelsPath, $catalog)

Write-Host "[2/3] 更新 $configPath ..."
$topBlock = @'
${codexTopKeysToml(defaultModel)}
'@
$provBlock = @'
${provBlock}
'@
$modelsRef = $modelsPath -replace '\\\\', '/'
$topBlock = $topBlock -replace '~/.codex/models.json', $modelsRef
function Rollback {
  Write-Host "[提示] 配置更新失败，正在恢复原始文件 ..."
  if ($configBak -and (Test-Path $configBak)) { Copy-Item $configBak $configPath -Force }
  if ($modelsBak -and (Test-Path $modelsBak)) { Copy-Item $modelsBak $modelsPath -Force }
  Write-Host "[提示] 已恢复原始内容，你的数据未受影响。请把以上输出发给管理员排查。"
  exit 1
}
if (Test-Path $configPath) {
  $lines = [System.IO.File]::ReadAllLines($configPath)
  $out = New-Object System.Collections.Generic.List[string]
  $inTop = $true; $printed = $false; $skip = $false
  foreach ($line in $lines) {
    if ($line -match '^\\[model_providers\\.ccteam\\]\\s*$') { $skip = $true; continue }
    if ($skip -and $line -match '^\\[') { $skip = $false }
    if ($skip) { continue }
    if (-not $printed -and $line -match '^\\[') { $out.Add($topBlock); $out.Add(""); $printed = $true }
    if ($line -match '^\\[') { $inTop = $false }
    if ($inTop -and $line -match '^(model_provider|model|model_catalog_json)\\s*=') { continue }
    $out.Add($line)
  }
  if (-not $printed) { $out.Add($topBlock); $out.Add("") }
  $out.Add(""); $out.Add($provBlock)
  $nl = [string][char]13 + [char]10
  $new = ($out -join $nl) + $nl
  if ($new.Length -gt 0 -and $new.Contains("[model_providers.ccteam]")) {
    [System.IO.File]::WriteAllText($configPath, $new)
  } else { Rollback }
} else {
  $nl = [string][char]13 + [char]10
  [System.IO.File]::WriteAllText($configPath, $topBlock + $nl + $nl + $provBlock + $nl)
}

Write-Host "[3/3] 检查网关连通性 ..."
try {
  $null = Invoke-WebRequest -UseBasicParsing -Uri "${scheme}://${host}/v1/models" -Headers @{ Authorization = "Bearer ${key}" } -TimeoutSec 8
  Write-Host "[OK] 网关连通正常"
} catch {
  Write-Host "[提示] 连通检查未通过——请确认本机可以访问 ${scheme}://${host}（配置本身已完成）"
}

Write-Host ""
Write-Host "========== 本次操作摘要 =========="
Write-Host "1. 备份："
if ($configBak) { Write-Host "   原配置   → $configBak" }
if ($modelsBak) { Write-Host "   原模型目录 → $modelsBak" }
if (-not $configBak -and -not $modelsBak) { Write-Host "   （首次安装，无需备份）" }
Write-Host "2. 写入 $modelsPath"
Write-Host "   内容：方案配置的模型别名目录${defaultModel ? `（默认模型 ${defaultModel}）` : ""}"
Write-Host "3. 更新 $configPath"
Write-Host "   只改了 model_provider / model / model_catalog_json 三行顶层键，"
Write-Host "   并在末尾追加 [model_providers.ccteam] 一段；你的其他配置未动。"
Write-Host "----------------------------------"
Write-Host "下一步：完全退出 Codex 后重新打开即可使用。"
Write-Host "如需恢复原配置：把对应 .backup-ccteam-$ts 文件复制回原名即可。"
${defaultModel ? `Write-Host "默认模型 ${defaultModel}；模型选择器中可切换方案配置的其他别名。"\n` : ""}`;
}

function codexSetupHtml(virtualKey, state, catalog) {
  const key = virtualKey || "";
  const cat = catalog || { entries: [], json: '{\n  "models": []\n}', defaultModel: "" };
  const banner = state === "invalid"
    ? `<div style="background:#fff2f0;border:1px solid #f1c8c2;color:var(--red);padding:10px 14px;border-radius:6px;margin-bottom:16px;font-size:13px">该 Key 不存在——请检查链接里的虚拟 Key 是否完整。</div>`
    : state === "no-profile"
    ? `<div style="background:#fff7e6;border:1px solid #ffe1a6;color:#a1662f;padding:10px 14px;border-radius:6px;margin-bottom:16px;font-size:13px">该 Key 尚未分配到任何 Responses(Codex) 方案——请联系管理员在设置页为其分配后再来配置。</div>`
    : "";
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2096%2096%22%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2222%22%20fill%3D%22%232f6e50%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fbfbf8%22%20stroke-width%3D%2213%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate(48%2048)%20scale(0.88)%20translate(-48%20-48)%22%3E%3Cpath%20d%3D%22M37%2026.5H31.5Q20.5%2026.5%2020.5%2037.5V58.5Q20.5%2069.5%2031.5%2069.5H37%22%2F%3E%3Cpath%20d%3D%22M59%2026.5H64.5Q75.5%2026.5%2075.5%2037.5V58.5Q75.5%2069.5%2064.5%2069.5H59%22%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2248%22%20r%3D%226.2%22%20fill%3D%22%23fbfbf8%22%2F%3E%3C%2Fsvg%3E">
<title>Codex 接入配置 - 团队AI Coding监控</title>
<style>
${UI_THEME}
body{padding:28px clamp(18px,3vw,44px) 48px}
body>div{max-width:880px;margin-left:auto;margin-right:auto}
.top{margin-bottom:14px;padding-bottom:18px;border-bottom:1px solid var(--border)}.top-brand{display:flex;align-items:center;gap:14px}
.top h1{font-size:26px;font-weight:650;margin-bottom:6px}.top .sub{font-size:12px;color:var(--dim)}
.host-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px;font-size:13px}
.host-row code{font-size:11px;color:var(--dim)}
#hostInput{font-size:13px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:7px 10px;width:240px;font-family:var(--font-mono)}
.tabs{display:flex;gap:6px;margin-bottom:14px}
.tabs button{font-size:13px;font-weight:600;padding:8px 16px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--dim);cursor:pointer}
.tabs button.on{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}
.panel{display:none}.panel.on{display:block}
.box{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:16px;margin-bottom:14px}
.box h3{font-size:13px;font-weight:650;margin-bottom:10px}
.box ol{padding-left:20px;margin:0}.box li{font-size:13px;line-height:2}
pre{position:relative;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:14px;font-size:11.5px;line-height:1.6;overflow-x:auto;white-space:pre;font-family:var(--font-mono);margin:0 0 12px}
.copy-btn{position:absolute;top:8px;right:8px;font-size:11px;border:1px solid var(--border);background:var(--surface);color:var(--text);padding:3px 10px;border-radius:4px;cursor:pointer}
.copy-btn:hover{border-color:var(--accent);color:var(--accent)}
.note{font-size:11px;color:var(--dim);line-height:1.7}
.warn{background:#fff7e6;border:1px solid #ffe1a6;color:#a1662f;padding:8px 12px;border-radius:5px;font-size:12px;margin-top:10px}
</style></head><body data-theme="editorial-light">
<div class="top"><div class="top-brand"><svg class="brand-logo" width="40" height="40" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="#2f6e50"/><g fill="none" stroke="#fbfbf8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" transform="translate(48 48) scale(0.9) translate(-48 -48)"><path d="M37 26.5H31.5Q20.5 26.5 20.5 37.5V58.5Q20.5 69.5 31.5 69.5H37"/><path d="M59 26.5H64.5Q75.5 26.5 75.5 37.5V58.5Q75.5 69.5 64.5 69.5H59"/></g><circle cx="48" cy="48" r="4.95" fill="#fbfbf8"/></svg><div><h1>Codex 接入配置</h1><div class="sub">把你的 Codex 指向团队网关 — 三种方式任选其一</div></div></div></div>
${banner}
<div class="host-row"><span>服务器地址：</span><span style="color:var(--dim)" id="schemeLabel">http://</span><input id="hostInput" value="" oninput="renderAll()" spellcheck="false"><code>自动取自当前访问地址（含 https），可修改</code>${cat.entries.length ? ` <code>可用模型：${cat.entries.map(e => e.slug).join(" / ")}（来自方案配置的别名）</code>` : ""}</div>
<div class="tabs">
  <button class="on" data-tab="script" onclick="setTab('script')">一键脚本</button>
  <button data-tab="manual" onclick="setTab('manual')">手动配置</button>
  <button data-tab="ccswitch" onclick="setTab('ccswitch')">cc-switch 用户</button>
</div>
<div class="panel on" id="panel-script">
  <div class="box"><h3>macOS / Linux — 在「终端」执行</h3>
    <pre><button class="copy-btn" onclick="copyPre(this)">复制</button><code id="curlCmd"></code></pre>
  </div>
  <div class="box"><h3>Windows — 在 PowerShell 执行</h3>
    <pre><button class="copy-btn" onclick="copyPre(this)">复制</button><code id="psCmd"></code></pre>
  </div>
  <div class="box"><h3>执行后</h3>
    <ol>
      <li>脚本会自动备份并更新 <code>~/.codex/config.toml</code>、写入 <code>~/.codex/models.json</code>（Windows 为 <code>%USERPROFILE%\.codex</code>）</li>
      <li><strong>完全退出 Codex（macOS: Cmd+Q）再重新打开</strong>，即可使用</li>
    </ol>
    <div class="note">脚本只管理 ccteam 相关配置，你已有的其他 provider / 项目配置全部保留；重复执行安全；结束时打印本次操作摘要与回滚方法。</div>
  </div>
</div>
<div class="panel" id="panel-manual">
  <div class="box"><h3>① 追加到 ~/.codex/config.toml 顶部（若已有同名键则替换）</h3>
    <pre style="max-height:300px;overflow:auto"><button class="copy-btn" onclick="copyPre(this)">复制</button><code id="tomlBlock"></code></pre>
  </div>
  <div class="box"><h3>② 另存为 ~/.codex/models.json</h3>
    <pre style="max-height:300px;overflow:auto"><button class="copy-btn" onclick="copyPre(this)">复制</button><code id="modelsJson"></code></pre>
    <div class="note">保存后完全退出 Codex（Cmd+Q）重新打开。</div>
  </div>
</div>
<div class="panel" id="panel-ccswitch">
  <div class="box"><h3>在 cc-switch 中添加自定义供应商</h3>
    <ol>
      <li>cc-switch → Codex → Add Provider → 自定义</li>
      <li>把下面的 TOML 粘贴进供应商配置（name 可自定，字段保留）：</li>
    </ol>
    <pre style="max-height:260px;overflow:auto"><button class="copy-btn" onclick="copyPre(this)">复制</button><code id="tomlBlock2"></code></pre>
    <div class="warn">注意：cc-switch 切换供应商时会重写 config.toml。请把 <code>model_catalog_json = "~/.codex/models.json"</code>${cat.defaultModel ? ` 与 <code>model = "${cat.defaultModel}"</code>` : ""} 放进它的「Shared Config Snippet / 公共配置」；且切换到 ccteam 后需确认这几个顶层键仍然存在，models.json 也要按「手动配置」页准备一次。</div>
  </div>
</div>
<script>
const KEY=${JSON.stringify(key)};
const MODELS=${JSON.stringify(cat.json)};
const DEFAULT_MODEL=${JSON.stringify(cat.defaultModel)};
const TOP_KEYS='model_provider = "ccteam"\\n'+(DEFAULT_MODEL?'model = "'+DEFAULT_MODEL+'"\\n':'')+'model_catalog_json = "~/.codex/models.json"\\n';
function host(){return (document.getElementById('hostInput').value||'').trim().replace(/^https?:\\/\\//,'').replace(/\\/$/,'')}
function scheme(){return location.protocol==='https:'?'https':'http'}
function providerToml(h){return '[model_providers.ccteam]\\nname = "CC Team Gateway"\\nbase_url = "'+scheme()+'://'+h+'/v1"\\nwire_api = "responses"\\nrequires_openai_auth = false\\nsupports_websockets = false\\nexperimental_bearer_token = "'+KEY+'"' }
function renderAll(){
  const h=host();if(!h)return;
  document.getElementById('schemeLabel').textContent=scheme()+'://';
  document.getElementById('curlCmd').textContent='curl -fsSL "'+scheme()+'://'+h+'/api/codex-setup/'+KEY+'" | sh';
  document.getElementById('psCmd').textContent='[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; irm "'+scheme()+'://'+h+'/api/codex-setup-win/'+KEY+'" | iex';
  document.getElementById('tomlBlock').textContent=TOP_KEYS+'\\n'+providerToml(h);
  document.getElementById('tomlBlock2').textContent=providerToml(h);
  document.getElementById('modelsJson').textContent=JSON.stringify(JSON.parse(MODELS),null,2);
}
function setTab(t){document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('on',b.dataset.tab===t));document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('on',p.id==='panel-'+t))}
function copyPre(btn){const code=btn.parentElement.querySelector('code');navigator.clipboard.writeText(code.textContent).then(()=>{btn.textContent='已复制';setTimeout(()=>btn.textContent='复制',1500)})}
document.getElementById('hostInput').value=location.host;
renderAll();
</script></body></html>`;
}

function personalUsageHtml(virtualKey) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2096%2096%22%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2222%22%20fill%3D%22%232f6e50%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fbfbf8%22%20stroke-width%3D%2213%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate(48%2048)%20scale(0.88)%20translate(-48%20-48)%22%3E%3Cpath%20d%3D%22M37%2026.5H31.5Q20.5%2026.5%2020.5%2037.5V58.5Q20.5%2069.5%2031.5%2069.5H37%22%2F%3E%3Cpath%20d%3D%22M59%2026.5H64.5Q75.5%2026.5%2075.5%2037.5V58.5Q75.5%2069.5%2064.5%2069.5H59%22%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2248%22%20r%3D%226.2%22%20fill%3D%22%23fbfbf8%22%2F%3E%3C%2Fsvg%3E">
<title>我的用量 - 团队AI Coding监控</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
${UI_THEME}
${TOAST_CSS}
body{padding:28px clamp(18px,3vw,44px) 48px}
/* Wider than the old 1120px: with 5+ profiles the quota cards were squeezed to
   their 215px floor, wrapping every number onto two lines. */
body>div{max-width:1400px;margin-left:auto;margin-right:auto}
.proto-seg{display:inline-flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--surface)}
.proto-seg button{font-size:11px;font-weight:600;padding:6px 12px;border:none;background:transparent;color:var(--dim);cursor:pointer}
.proto-seg button+button{border-left:1px solid var(--border)}
.proto-seg button.on{background:var(--accent-soft);color:var(--accent)}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-bottom:14px;padding-bottom:20px;border-bottom:1px solid var(--border)}.top-brand{display:flex;align-items:center;gap:14px}
.top h1{font-size:28px;font-weight:650;line-height:1.15;margin-bottom:7px}.top .sub{font-size:12px;color:var(--dim)}
select{font-size:12px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:7px 10px;cursor:pointer}select:hover{background:var(--surface-subtle)}select:focus{border-color:var(--accent)}
.meta{font-size:12px;color:var(--dim);margin-bottom:18px}
.qnotice{display:none;gap:12px;align-items:flex-start;border-radius:6px;padding:13px 16px;margin-bottom:12px;font-size:12.5px;line-height:1.7}
.qnotice.show{display:flex}
.qnotice .qi{flex:none;width:24px;height:24px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;margin-top:1px}
.qnotice b{font-weight:650}
.qnotice.bonus{border:1px solid #cfe0d5;border-left:3px solid var(--green);background:var(--accent-soft)}
.qnotice.bonus .qi{background:var(--green)}
.qnotice.bonus .hl{color:var(--green);font-weight:700;font-size:14px}
.qnotice.reset{border:1px solid #eadfc3;border-left:3px solid var(--orange);background:#faf5e6}
.qnotice.reset b{color:var(--orange)}
.qnotice.reset .qi{background:var(--orange)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:20px}
/* Per-profile quota cards for the "all profiles" view. One card per profile
   beats one summed bar: the aggregate limit collapses to "unlimited" the moment
   any single profile is unlimited, and even when it sums it cannot say WHICH
   profile is about to run out. */
.pq-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(255px,1fr));gap:11px;margin-bottom:20px}
.pq{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--border-strong);border-radius:6px;padding:13px 15px}
.pq.warn{border-left-color:var(--orange)}.pq.crit{border-left-color:var(--red)}.pq.ok{border-left-color:var(--green)}.pq.free{border-left-color:var(--dim2)}
.pq-hd{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:9px}
.pq-name{font-size:12.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pq-sfx{font-size:10px;color:var(--dim);font-family:var(--font-mono)}
.pq-pct{font-size:17px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1}
.pq-nums{font-size:11px;color:var(--dim);margin-top:7px;font-variant-numeric:tabular-nums;line-height:1.6}
.pq-nums b{color:var(--text);font-weight:600}
/* Keep "已用 X / Y（个人配额）" on one line — wrapping mid-figure was what made
   the cards look cramped. Each fragment breaks as a unit instead. */
.pq-nums span{white-space:nowrap}
.pq .quota-progress{width:100%;margin-left:0;height:7px}
.pq-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:7px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:15px 16px;min-height:88px}.card:first-child{border-top:2px solid var(--accent)}
.card .l{font-size:11px;font-weight:550;color:var(--dim);margin-bottom:12px}.card .v{font-size:22px;line-height:1;font-weight:650;font-variant-numeric:tabular-nums;color:var(--text)!important}
.box{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:17px;margin-bottom:14px;overflow-x:auto}.box h3{font-size:13px;font-weight:650;color:var(--text);margin-bottom:12px}.box canvas{max-height:220px}
.chart-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;align-items:start}
.chart-row .box{margin-bottom:0;min-width:0}
.chart-row .box canvas{max-height:190px}
@media(max-width:900px){.chart-row{grid-template-columns:1fr}.chart-row .box canvas{max-height:220px}}
table{width:100%;border-collapse:collapse;min-width:560px}th{text-align:left;padding:9px 12px;font-size:11px;font-weight:550;color:var(--dim);border-bottom:1px solid var(--border);white-space:nowrap}td{padding:9px 12px;font-size:12px;border-bottom:1px solid #ecece8;white-space:nowrap}.n{text-align:right;font-variant-numeric:tabular-nums}tbody tr:hover td{background:#fafaf7}.tag{font-size:10px;background:var(--accent-soft);color:var(--accent);padding:2px 6px;border-radius:4px}
/* ── Daily check-in bar ── */
.checkin-bar{display:none;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;background:linear-gradient(135deg,#f2f7f3,#fbfbf8);border:1px solid #cfe0d5;border-left:3px solid var(--green);border-radius:6px;padding:14px 18px;margin-bottom:12px}
.checkin-bar.show{display:flex}
.ci-title{font-size:13.5px;font-weight:700;color:var(--text)}
.ci-check{display:inline-flex;width:18px;height:18px;border-radius:50%;background:var(--green);color:#fff;font-size:11px;align-items:center;justify-content:center;margin-right:7px;vertical-align:-3px}
.ci-sub{font-size:11.5px;color:var(--dim);margin-top:4px;line-height:1.6}
.ci-sub b{color:var(--green);font-weight:700}
.ci-stats{display:flex;gap:22px;flex-wrap:wrap}
.ci-stats>div{text-align:center;min-width:52px}
.ci-stats b{display:block;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--text)}
.ci-stats span{font-size:10px;color:var(--dim)}
.btn-checkin{font-size:12.5px;font-weight:650;padding:10px 22px;border-radius:5px;border:none;background:#181816;color:#fff;cursor:pointer;transition:background .15s}
.btn-checkin:hover:not(:disabled){background:#33332f}
.btn-checkin:active:not(:disabled){transform:translateY(1px)}
.btn-checkin:disabled{background:#deded8;color:#686863;cursor:default}
/* ── Quota-request entry button + modal ── */
.qr-open-btn{font-size:11.5px;font-weight:600;padding:8px 14px;border-radius:5px;border:1px solid var(--border-strong);background:var(--surface);color:var(--text);cursor:pointer}
.qr-open-btn:hover{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
.modal-overlay{display:none;position:fixed;inset:0;max-width:none;margin:0;background:rgba(24,24,22,.35);z-index:50;align-items:center;justify-content:center;padding:20px}
.modal-overlay.open{display:flex}
.qr-modal{background:var(--surface);border-radius:8px;width:100%;max-width:500px;max-height:86vh;overflow:auto;box-shadow:0 18px 50px rgba(24,24,22,.18)}
.qr-mhd{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border);font-size:14px}
.qr-close{border:none;background:transparent;font-size:13px;color:var(--dim);cursor:pointer;padding:4px 8px;border-radius:4px}
.qr-close:hover{background:rgba(0,0,0,.05);color:var(--text)}
.qr-mbody{padding:16px 18px}
.qr-info{font-size:12px;color:var(--dim);background:var(--accent-soft);border-radius:5px;padding:9px 12px;margin-bottom:12px;line-height:1.6}
.qr-info b{color:var(--accent)}
.qr-hd{font-size:11px;font-weight:600;color:var(--dim);margin:2px 0 7px}
.qr-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #f0f0ec;font-size:12px;flex-wrap:wrap}
.qr-row:last-child{border-bottom:none}
.qr-reason{flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qr-amt{color:var(--accent);font-weight:600;font-variant-numeric:tabular-nums}
.qr-time{color:var(--dim);font-size:10.5px}
.qr-note{width:100%;font-size:10.5px;color:var(--orange)}
.qr-badge{font-size:10px;padding:2px 7px;border-radius:4px;font-weight:600;flex:none}
.qr-badge.pending{background:#faf5e6;color:var(--orange)}
.qr-badge.handled{background:var(--accent-soft);color:var(--green)}
.qr-badge.rejected{background:#fbeae8;color:var(--red)}
.qr-empty{font-size:11.5px;color:var(--dim);padding:2px 0 10px}
.qr-form{margin-top:14px;border-top:1px solid var(--border);padding-top:14px}
.qr-form label{display:block;font-size:11px;font-weight:600;color:var(--dim);margin-bottom:6px}
.qr-form label i{color:var(--red);font-style:normal}
.qr-form select{width:100%;box-sizing:border-box;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:8px 11px;margin-bottom:12px;cursor:pointer}
.qr-form select:focus{outline:none;border-color:var(--accent)}
.qr-form input,.qr-form textarea{width:100%;box-sizing:border-box;font-size:12.5px;font-family:inherit;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:8px 11px}
.qr-form input:focus,.qr-form textarea:focus{outline:none;border-color:var(--accent)}
.qr-form textarea{resize:vertical}
.qr-actions{margin-top:14px;display:flex;justify-content:flex-end}
/* ── Usage calendar (GitHub-style heatmap) ── */
.cal-summary{font-size:11.5px;color:var(--dim);margin-bottom:12px;line-height:1.7}
.cal-summary b{color:var(--text);font-weight:650;font-variant-numeric:tabular-nums}
.cal-scroll{overflow-x:auto;padding:3px 3px 4px;scrollbar-width:none}
.cal-scroll::-webkit-scrollbar{display:none}
.cal-inner{min-width:100%}
.cal-months{position:relative;height:15px;margin-bottom:8px;font-size:10px;color:var(--dim)}
.cal-months span{position:absolute;top:0;white-space:nowrap}
.cal-row{display:flex;gap:8px;align-items:flex-start}
.cal-main{flex:1;min-width:0;overflow:hidden}
.cal-daylabels{flex:none;width:27px;display:grid;gap:3px;font-size:9px;color:var(--dim);padding-top:23px}
.cal-daylabels i{display:flex;align-items:center;font-style:normal;min-height:1px}
.cal-grid{display:grid;grid-auto-flow:column;gap:3px}
.cal-cell{display:block;border-radius:var(--cal-r,2.5px)}
.cal-cell.ghost{background:transparent}
.cal-cell.today{outline:1.5px solid var(--accent);outline-offset:1.5px}
.cal-legend{display:flex;align-items:center;gap:4px;justify-content:flex-end;font-size:10px;color:var(--dim);margin-top:8px}
.cal-legend .cal-cell{display:inline-block;width:11px;height:11px}
.cal-tip{display:none;position:fixed;z-index:60;background:#181816;color:#fbfbf8;font-size:11px;padding:6px 10px;border-radius:5px;pointer-events:none;white-space:nowrap;box-shadow:0 6px 18px rgba(24,24,22,.3)}
.cal-tip b{color:#a8ccb7}
@media(max-width:560px){body{padding:20px 14px 36px}.top h1{font-size:24px}.cards{grid-template-columns:1fr 1fr}.card .v{font-size:20px}.box{padding:14px}.pq-grid{grid-template-columns:1fr}}
</style></head><body data-theme="editorial-light">
<div class="top"><div class="top-brand"><svg class="brand-logo" width="40" height="40" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="#2f6e50"/><g fill="none" stroke="#fbfbf8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" transform="translate(48 48) scale(0.9) translate(-48 -48)"><path d="M37 26.5H31.5Q20.5 26.5 20.5 37.5V58.5Q20.5 69.5 31.5 69.5H37"/><path d="M59 26.5H64.5Q75.5 26.5 75.5 37.5V58.5Q75.5 69.5 64.5 69.5H59"/></g><circle cx="48" cy="48" r="4.95" fill="#fbfbf8"/></svg><div><h1>我的用量</h1><div class="sub">查看个人配额、趋势和模型明细 · <a href="/setup/${escJs(virtualKey)}" style="color:var(--accent)">配置 Codex 接入 →</a></div></div></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><div class="proto-seg" id="protoSeg" role="group" aria-label="协议分类"><button type="button" class="on" data-proto="">全部</button><button type="button" data-proto="anthropic">Anthropic</button><button type="button" data-proto="responses">OpenAI</button></div><select id="profileSel" onchange="switchProfile(this.value)"><option value="all">全部可用方案</option></select><button type="button" id="qrBtn" class="qr-open-btn" style="display:none" onclick="openQrModal()">申请加量</button></div></div>
<div class="meta" id="meta">加载中...</div>
<div id="qNotice"></div>
<div class="checkin-bar" id="checkinBar"></div>
<div class="cards" id="cards"></div>
<div id="pqSection" style="display:none"><h3 style="font-size:13px;font-weight:650;margin:0 0 10px">各方案配额 <span style="font-size:11px;color:var(--dim);font-weight:400" id="pqHint"></span></h3><div class="pq-grid" id="pqGrid"></div></div>
<div class="box" id="calendarBox" style="display:none"><h3>使用日历 <span style="font-size:11px;color:var(--dim);font-weight:400">过去一年 · 颜色代表每日输入+输出总量，悬浮查看明细</span></h3><div class="cal-summary" id="calSummary"></div><div class="cal-row"><div class="cal-daylabels"><i>一</i><i></i><i>三</i><i></i><i>五</i><i></i><i></i></div><div class="cal-main"><div class="cal-scroll"><div class="cal-inner"><div class="cal-months" id="calMonths"></div><div class="cal-grid" id="calGrid"></div></div></div></div></div><div class="cal-legend">少 <span class="cal-cell" style="background:#e9e9e3"></span><span class="cal-cell" style="background:#cfe3d7"></span><span class="cal-cell" style="background:#9dc4ab"></span><span class="cal-cell" style="background:#5f9a7a"></span><span class="cal-cell" style="background:#2f6e50"></span> 多</div></div>
<div class="chart-row">
<div class="box"><h3>今日24小时趋势</h3><canvas id="hourChart"></canvas></div>
<div class="box"><h3>近7天趋势</h3><canvas id="trendChart"></canvas></div>
</div>
<div class="cal-tip" id="calTip"></div>
<div class="modal-overlay" id="qrModal" onclick="if(event.target===this)closeQrModal()"><div class="qr-modal" role="dialog" aria-label="申请加量"><div class="qr-mhd"><b>申请加量</b><button type="button" class="qr-close" onclick="closeQrModal()" aria-label="关闭">✕</button></div><div class="qr-mbody"><div class="qr-info" id="qrQuotaInfo"></div><div id="qrHistory"></div><div class="qr-form"><label>申请额度池 <i>*</i></label><select id="qrPool"></select><label>申请理由 <i>*</i></label><textarea id="qrReason" maxlength="200" rows="3" placeholder="说明一下用途和期望，管理员处理时会看到"></textarea></div><div class="qr-actions"><button type="button" class="btn-checkin" id="qrSubmit" onclick="submitQuotaRequest()">提交申请</button></div></div></div></div>
<div class="box"><h3>今日模型请求</h3><table id="modelTable"><thead><tr><th>模型</th><th class="n">请求数</th><th class="n">实际 Token</th><th class="n">倍率</th><th class="n">计入配额</th></tr></thead><tbody></tbody></table><div class="note" id="modelTableNote" style="font-size:11px;color:var(--dim);margin-top:8px"></div></div>
<div class="box" id="rateCardBox" style="display:none"><h3>配额价目表 <span style="font-size:11px;color:var(--dim);font-weight:400">当前时段每个模型消耗 1 token 扣多少额度</span></h3><div id="rateCardBody"></div></div>
<script>
${UI_HELPERS}
${TOAST_JS}
Chart.defaults.color='#686863';Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei","Segoe UI",sans-serif';Chart.defaults.font.size=11;
const VK='${escJs(virtualKey)}';
let D=null,C={h:null,t:null},currentProfile='all',PROTO='';
const fmtT=n=>n.toLocaleString("zh-CN");
// Profile names come from admin-authored config; this page renders them into
// markup, so escape here rather than trusting them.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTk=n=>{if(n>=1e6)return(n/1e6).toFixed(1)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return n.toString()};
const COL=["#2f6e50","#4a6fa5","#c2604f","#c4a23a","#7a6bb0","#d4824a","#4a9ba8","#c47a99","#6ba368","#5a6bc4","#8a6db5","#5a9b8e"];
// ── Daily check-in ──
function fmtWan(n){if(n>=1e8)return(Math.round(n/1e8*10)/10)+'亿';if(n>=1e4)return(Math.round(n/1e4*10)/10)+'万';return String(n)}
// Bonus attribution: when today's check-in reward is part of the bonus, the
// copy must not credit it all to the admin.
function bonusTip(){const c=D&&D.checkin;return (c&&c.checkedInToday)?'今日临时加量（含签到奖励），明日自动失效':'管理员今日临时加量，明日自动失效'}
function renderCheckin(){
  const bar=document.getElementById('checkinBar'),c=D.checkin;
  if(!bar)return;
  if(!c||!c.available||c.enabled===false){bar.classList.remove('show');return}
  bar.classList.add('show');
  const stats='<div class="ci-stats"><div><b>'+c.streak+'</b><span>连续签到</span></div><div><b>'+c.totalCheckIns+'</b><span>累计签到</span></div><div><b>'+fmtTk(c.totalTokens)+'</b><span>累计获得</span></div></div>';
  if(c.checkedInToday){
    const pools=(c.todayPools||[]).length;
    bar.innerHTML='<div><div class="ci-title"><span class="ci-check">✓</span>今日已签到</div><div class="ci-sub">获得 <b>+'+fmtT(c.todayAmount)+'</b> token'+(pools>1?' · 已加入 '+pools+' 个额度池':' · 已加入额度池')+'（今日有效，明日自动失效）</div></div>'+stats+'<button type="button" class="btn-checkin" disabled>已签到</button>';
  }else{
    bar.innerHTML='<div><div class="ci-title">每日签到</div><div class="ci-sub">今日随机 <b>+'+fmtWan(c.minTokens)+' ~ '+fmtWan(c.maxTokens)+'</b> token，加到你可用的每个额度池（今日有效）</div></div>'+stats+'<button type="button" class="btn-checkin" id="ciBtn" onclick="doCheckIn()">签到领 token</button>';
  }
}
async function doCheckIn(){
  const btn=document.getElementById('ciBtn');
  if(!btn||btn.disabled)return;
  btn.disabled=true;btn.textContent='签到中…';
  try{
    const r=await fetch('/api/checkin',{method:'POST',headers:{'Authorization':'Bearer '+VK}});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'签到失败');
    toast('签到成功！获得 '+fmtTk(j.amount)+' token，已加入 '+j.pools.length+' 个额度池');
    await load();
  }catch(e){
    toast(e.message||'签到失败');
    btn.disabled=false;btn.textContent='签到领 token';
  }
}
// ── Quota request ──
function qrBadge(s){
  if(s==='pending')return '<span class="qr-badge pending">待处理</span>';
  if(s==='handled')return '<span class="qr-badge handled">已加量</span>';
  if(s==='rejected')return '<span class="qr-badge rejected">已驳回</span>';
  return '';
}
function fmtQrTime(iso){const d=new Date(iso);const p=n=>String(n).padStart(2,'0');return (d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())}
function renderQuotaRequest(){
  const btn=document.getElementById('qrBtn'),qr=D.quotaRequest;
  if(!btn)return;
  if(!qr||!qr.available||qr.enabled===false){btn.style.display='none';return}
  btn.style.display='';
  btn.textContent=qr.todaySubmitted?'今日已申请':(qr.remaining>0?'申请加量':'申请 · 本周已满');
  if(document.getElementById('qrModal').classList.contains('open'))renderQrBody();
}
function renderQrBody(){
  const qr=D.quotaRequest;
  if(!qr)return;
  document.getElementById('qrQuotaInfo').innerHTML='提交后管理员会收到通知，处理结果会显示在这里。提交不占用次数，管理员<b>处理后</b>才计入每周 '+qr.weeklyLimit+' 次上限（本周已处理 '+qr.handledThisWeek+' 次，周一刷新）；每天限提交 1 次。';
  const rows=qr.myRecent||[];
  document.getElementById('qrHistory').innerHTML='<div class="qr-hd">我的近期申请</div>'
    +(rows.length?rows.map(r=>'<div class="qr-row">'+qrBadge(r.status)+'<span class="qr-reason" title="'+esc(r.reason)+'">'+esc(r.reason)+'</span>'+(r.poolLabel?'<span class="qr-amt">'+esc(r.poolLabel)+'</span>':'')+'<span class="qr-time">'+fmtQrTime(r.createdAt)+'</span>'+(r.adminNote?'<span class="qr-note">管理员备注：'+esc(r.adminNote)+'</span>':'')+'</div>').join(''):'<div class="qr-empty">还没有申请记录</div>');
  const sel=document.getElementById('qrPool');
  sel.innerHTML=(qr.pools||[]).map(p=>'<option value="'+esc(p.name)+'"'+(p.limited?'':' disabled')+'>'+esc(p.label)+(p.limited?'':'（不限量，无需申请）')+'</option>').join('');
  const blocked=qr.todaySubmitted||qr.remaining<=0;
  document.getElementById('qrSubmit').disabled=blocked;
  document.getElementById('qrSubmit').textContent=qr.todaySubmitted?'今天已申请过':(qr.remaining<=0?'本周处理次数已用完':'提交申请');
}
function openQrModal(){renderQrBody();document.getElementById('qrReason').value='';document.getElementById('qrModal').classList.add('open')}
function closeQrModal(){document.getElementById('qrModal').classList.remove('open')}
async function submitQuotaRequest(){
  const pool=document.getElementById('qrPool').value;
  const reason=document.getElementById('qrReason').value.trim();
  const btn=document.getElementById('qrSubmit');
  if(!pool){toast('请选择申请的额度池');return}
  if(!reason){toast('请填写申请理由');return}
  btn.disabled=true;btn.textContent='提交中…';
  try{
    const r=await fetch('/api/quota-request',{method:'POST',headers:{'Authorization':'Bearer '+VK,'Content-Type':'application/json'},body:JSON.stringify({reason:reason,pool:pool})});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'提交失败');
    toast('申请已提交，等待管理员处理');
    closeQrModal();
    await load();
  }catch(e){
    toast(e.message||'提交失败');
    btn.disabled=false;btn.textContent='提交申请';
  }
}
// ── Usage calendar (GitHub-style heatmap) ──
const CAL_COLORS=['#e9e9e3','#cfe3d7','#9dc4ab','#5f9a7a','#2f6e50'];
function calWeekday(dateStr){return (new Date(dateStr+'T12:00:00Z').getUTCDay()+6)%7}
function calMonthDay(dateStr){return parseInt(dateStr.slice(5,7),10)+'月'+parseInt(dateStr.slice(8,10),10)+'日'}
function renderCalendar(){
  const box=document.getElementById('calendarBox'),hm=D.heatmap;
  if(!box||!hm||!Array.isArray(hm.days)){box.style.display='none';return}
  box.style.display='';
  const s=hm.summary;
  document.getElementById('calSummary').innerHTML=(s&&s.activeDays>0)
    ?'过去一年共 <b>'+fmtTk(s.totalTokens)+'</b> token（输入+输出） · 活跃 <b>'+s.activeDays+'</b> 天 · 最长连续使用 <b>'+s.longestStreak+'</b> 天'+(s.maxDay?' · 最高单日 <b>'+calMonthDay(s.maxDay.date)+' · '+fmtTk(s.maxDay.total)+'</b>':'')
    :'过去一年暂无使用记录——开始使用后，这里会像 GitHub 一样点亮你的每一天';
  const byDate={};hm.days.forEach(d=>{byDate[d.date]=d});
  const cells=[];
  for(let i=0;i<calWeekday(hm.startDate);i++)cells.push(null);
  const start=new Date(hm.startDate+'T12:00:00Z'),end=new Date(hm.endDate+'T12:00:00Z');
  const todayStr=hm.endDate;
  for(let cur=new Date(start);cur<=end;cur=new Date(cur.getTime()+86400000)){
    const ds=cur.toISOString().slice(0,10),v=byDate[ds];
    cells.push({date:ds,total:v?v.total:0,weighted:v?v.weighted:0,requests:v?v.requests:0});
  }
  // Colour thresholds are relative quartiles of ACTIVE days — GitHub-style: the
  // scale adapts to the user's own range instead of a fixed absolute cutoff.
  const active=cells.filter(c=>c&&c.total>0).map(c=>c.total).sort((a,b)=>a-b);
  const q=p=>active.length?active[Math.min(active.length-1,Math.floor(active.length*p))]:Infinity;
  const t1=q(.25),t2=q(.5),t3=q(.75);
  const lvOf=v=>v<=0?0:v<=t1?1:v<=t2?2:v<=t3?3:4;
  const grid=document.getElementById('calGrid'),days=document.querySelector('#calendarBox .cal-daylabels');
  // Size cells from the card width so the 53-week grid spans the full row:
  // fixed-size cells would float small inside a wide box. Square cells keep a
  // GitHub-like pitch ratio; below 9px the card scrolls instead of shrinking.
  // The grid spans ceil(cells/7) columns — 54 when the 371-day window starts
  // mid-week, 53 when it doesn't. Sizing against a hardcoded 53 left the grid
  // one column wider than the card, clipping "today" on every load.
  const cols=Math.ceil(cells.length/7)||53;
  const avail=Math.max(300,(box.clientWidth||1200)-34-35-6);
  let gap=3,cell=Math.floor((avail-(cols-1)*gap)/cols);
  if(cell>22){cell=22;gap=Math.min(6,Math.max(3,Math.floor((avail-cols*cell)/(cols-1))))}
  if(cell<9)cell=9;
  grid.style.gridTemplateRows='repeat(7,'+cell+'px)';
  grid.style.gridAutoColumns=cell+'px';
  grid.style.gap=gap+'px';
  grid.style.setProperty('--cal-r',Math.max(2,Math.round(cell*0.2))+'px');
  if(days){days.style.gridTemplateRows='repeat(7,'+cell+'px)';days.style.gap=gap+'px'}
  grid.innerHTML=cells.map(c=>{
    if(!c)return '<span class="cal-cell ghost"></span>';
    const lv=lvOf(c.total);
    return '<span class="cal-cell'+(c.date===todayStr?' today':'')+'" style="background:'+CAL_COLORS[lv]+'" data-date="'+c.date+'" data-total="'+c.total+'" data-weighted="'+c.weighted+'" data-req="'+c.requests+'"></span>';
  }).join('');
  const STEP=cell+gap,labs=[];let lastLeft=-999;const seen={};
  cells.forEach((c,i)=>{
    if(!c)return;
    const ym=c.date.slice(0,7);
    if(seen[ym])return;
    seen[ym]=true;
    const left=Math.floor(i/7)*STEP;
    if(lastLeft<0||left-lastLeft>=STEP+18){labs.push('<span style="left:'+left+'px">'+parseInt(c.date.slice(5,7),10)+'月</span>');lastLeft=left}
  });
  document.getElementById('calMonths').innerHTML=labs.join('');
  // Newest weeks live at the right edge — start there so the current month is
  // visible first. Only act when the last (today) cell is actually cut off:
  // the grid box always fits (fixed tracks overflow it) and month labels may
  // overhang a few px, so pixel arithmetic is unreliable — let the browser
  // bring the today cell into view instead.
  const scroller=box.querySelector('.cal-scroll');
  if(scroller&&grid.lastElementChild){
    const lastR=grid.lastElementChild.getBoundingClientRect().right;
    if(lastR>scroller.getBoundingClientRect().right){
      try{grid.lastElementChild.scrollIntoView({inline:'end',block:'nearest'});}
      catch(e){scroller.scrollLeft=scroller.scrollWidth;}
    }else{
      scroller.scrollLeft=0;
    }
  }
  const tip=document.getElementById('calTip');
  grid.onmousemove=e=>{
    const el=e.target.closest('.cal-cell');
    if(!el||!el.dataset.date){tip.style.display='none';return}
    const used=+el.dataset.total>0;
    tip.innerHTML='<b>'+calMonthDay(el.dataset.date)+'</b> · '+(used?fmtTk(+el.dataset.total)+' token'+(+el.dataset.weighted&&+el.dataset.weighted!==+el.dataset.total?' · 计权 '+fmtTk(+el.dataset.weighted):'')+' · '+(+el.dataset.req||0)+' 次请求':'无使用');
    tip.style.display='block';
    const x=Math.min(e.clientX+14,window.innerWidth-tip.offsetWidth-10);
    tip.style.left=Math.max(8,x)+'px';tip.style.top=Math.max(8,e.clientY-36)+'px';
  };
  grid.onmouseleave=()=>{tip.style.display='none'};
}
async function load(){
  try{
    const qs=['profile='+encodeURIComponent(currentProfile)];
    if(currentProfile==='all'&&PROTO)qs.push('protocol='+PROTO);
    const r=await fetch('/api/my-usage?'+qs.join('&'),{headers:{'Authorization':'Bearer '+VK}});
    if(!r.ok){document.getElementById('meta').textContent='认证失败';return}
    D=await r.json();render();
  }catch(e){document.getElementById('meta').textContent='Error: '+e.message}
}
function switchProfile(v){currentProfile=v||'all';load()}
function renderProtoSeg(){document.querySelectorAll('#protoSeg button').forEach(b=>b.classList.toggle('on',b.dataset.proto===(currentProfile==='all'?PROTO:'')))}
function rebuildProfileOptions(){
  const sel=document.getElementById('profileSel');
  sel.innerHTML='<option value="all">'+(PROTO==='anthropic'?'全部 Anthropic 方案':PROTO==='responses'?'全部 OpenAI 方案':'全部可用方案')+'</option>'
    +(D&&(D.availableProfiles||[]).filter(p=>!PROTO||p.protocol===PROTO)||[]).map(p=>'<option value="'+p.suffix+'">'+p.name+' /'+p.suffix+(p.isDefault?' · 默认入口':'')+(p.protocol==='responses'?' · Codex':' · Claude Code')+'</option>').join('');
}
function switchProtocolView(proto){
  PROTO=proto||'';
  if(currentProfile!=='all'){currentProfile='all'}
  rebuildProfileOptions();
  const sel=document.getElementById('profileSel');sel.value='all';
  renderProtoSeg();
  if(D)load();
}
document.querySelectorAll('#protoSeg button').forEach(b=>b.addEventListener('click',()=>switchProtocolView(b.dataset.proto)));
// Quota-rate helpers. rate===null means the aggregate view (rates differ per
// profile), so only the combined discount is shown, never a single multiplier.
// The profile-level rate is explicitly labelled 默认 because per-model overrides
// mean a mixed day has no single "the" rate — the model table carries the detail.
function rateTag(q){
  if(q.rate===null||q.rate===undefined||q.rate===1)return'';
  const col=q.inPeak?'var(--orange)':'var(--green)';
  const t=(q.inPeak?'高峰':'低谷')+'时段默认倍率 ×'+q.rate+'；单独定价的模型见下方价目表';
  return ' <span class="tag" style="background:rgba(0,0,0,.04);color:'+col+'" title="'+t+'">'+(q.inPeak?'高峰':'低谷')+'默认 ×'+q.rate+'</span>';
}
function rateFootnote(q){
  if(q.rawUsed==null||q.rawUsed===q.used)return'';
  const delta=q.rawUsed-q.used;
  return '<div style="margin-top:6px;font-size:10px;color:var(--dim)">实际 '+fmtTk(q.rawUsed)+' · '+(delta>0?'已抵扣 '+fmtTk(delta):'已加收 '+fmtTk(-delta))+'</div>';
}
function renderQNotice(q){
  const el=document.getElementById('qNotice');
  let html='';
  if(q.limit>0&&q.bonus>0){
    const base=q.limit-q.bonus;
    {const c=D.checkin,ciPart=(c&&c.checkedInToday&&q.bonus>=c.todayAmount)?'（含今日签到 <span class="hl">+'+fmtTk(c.todayAmount)+'</span>）':'';html+='<div class="qnotice bonus show"><span class="qi">加</span><div><b>今日临时加量已生效</b> — 为你追加 <span class="hl">+'+fmtTk(q.bonus)+'</span> 临时额度'+ciPart+'（'+fmtT(q.bonus)+' tokens）。今日总额度 <b>'+fmtT(q.limit)+'</b>（基础 '+fmtT(base)+' + 临时 '+fmtTk(q.bonus)+'），将于<b>明日零点自动恢复</b>为基础额度，无需任何操作。</div></div>';}
  }
  if(q.rawUsed!=null&&q.rawUsed!==q.used){
    const slot=q.rate===null?'':(q.inPeak?'高峰':'低谷');
    const delta=q.rawUsed-q.used;
    const nx=q.nextRateChange;
    // Lead with the realised effect (how much was written off), not the nominal
    // rate: with per-model rates the day is a blend and the single default rate
    // would not reconcile with the numbers below it.
    const realised=q.rawUsed>0?Math.round(q.used/q.rawUsed*100)/100:null;
    html+='<div class="qnotice bonus show"><span class="qi">率</span><div><b>配额倍率生效中</b> — '
      +'今日实际使用 <b>'+fmtT(q.rawUsed)+'</b> tokens，'
      +(delta>0?'已为你抵扣 <span class="hl">'+fmtTk(delta)+'</span> 额度':'额外加收 <span class="hl">'+fmtTk(-delta)+'</span> 额度')
      +'（计入配额 '+fmtT(q.used)+(realised!=null?'，综合 ×'+realised:'')+'）。'
      +(q.rate!==null&&q.rate!==undefined?'当前'+slot+'时段默认 ×'+q.rate+'，各模型倍率见下方价目表。':'当前各方案倍率不同，上列为合计值。')
      +(nx?'<b>'+nx.at+'</b> 后转入'+(nx.toPeak?'高峰':'低谷')+'。':'')
      +'</div></div>';
  }
  if(q.resetApplied){
    html+='<div class="qnotice reset show"><span class="qi">重</span><div><b>今日用量已被管理员重置</b> — 配额已恢复满额，可立即继续使用。下方「今日用量」等统计数字仍为今日实际消耗（统计报表保留），配额判定已从重置时刻重新计算。</div></div>';
  }
  el.innerHTML=html;
}
// Per-profile quota cards, shown only in the aggregate view. The aggregate bar
// above cannot answer "how much do I have left" — it reads 无配额限制 as soon as
// any one profile is unlimited, and even a summed limit cannot say WHICH profile
// is nearly exhausted. These cards can.
function renderProfileQuotas(){
  const box=document.getElementById('pqSection'),grid=document.getElementById('pqGrid'),hint=document.getElementById('pqHint');
  if(!box||!grid)return;
  const rows=Array.isArray(D.profileQuotas)?D.profileQuotas:[];
  if(!rows.length){box.style.display='none';return}
  box.style.display='';
  const limited=rows.filter(r=>r.limit>0);
  const tight=limited.filter(r=>r.pct>=80);
  if(hint){
    hint.innerHTML='共 '+rows.length+' 个额度池'
      +(limited.length?'，'+limited.length+' 个有配额':'，均无配额限制')
      +(tight.length?' · <b style="color:'+(tight.some(r=>r.pct>=100)?'var(--red)':'var(--orange)')+'">'+tight.length+' 个已超 80%</b>':'');
  }
  grid.innerHTML=rows.map(r=>{
    const free=!(r.limit>0);
    const cls=free?'free':r.pct>=90?'crit':r.pct>=80?'warn':'ok';
    const col=free?'var(--dim)':r.pct>=90?'var(--red)':r.pct>=80?'var(--orange)':'var(--green)';
    const tags=[];
    if(r.isDefault)tags.push('<span class="tag" style="background:rgba(47,110,80,.1);color:var(--green)">默认入口</span>');
    if(r.isPool&&r.poolProfiles&&r.poolProfiles.length>1)tags.push('<span class="tag" style="background:rgba(0,0,0,.04);color:var(--dim)" title="此额度池包含：'+esc((r.poolProfiles||[]).join('、'))+'">'+r.poolProfiles.length+' 个方案</span>');
    else tags.push('<span class="tag" style="background:rgba(0,0,0,.04);color:var(--dim)">'+(r.protocol==='responses'?'Codex':'Claude Code')+'</span>');
    if(r.rate!=null&&r.rate!==1)tags.push('<span class="tag" style="background:rgba(0,0,0,.04);color:'+(r.inPeak?'var(--orange)':'var(--green)')+'" title="'+(r.inPeak?'高峰':'低谷')+'时段默认倍率 ×'+r.rate+'">'+(r.inPeak?'高峰':'低谷')+' ×'+r.rate+'</span>');
    if(r.bonus>0)tags.push('<span class="tag" style="background:rgba(46,164,79,.12);color:var(--green)" title="'+bonusTip()+'">临时+'+fmtTk(r.bonus)+'</span>');
    if(r.resetApplied)tags.push('<span class="tag" title="管理员已重置今日用量，统计数据保留">已重置</span>');
    const nums=free
      ? '<div class="pq-nums"><span>今日已用 <b>'+fmtT(r.used)+'</b> tokens</span> · <span>该方案无每日上限</span></div>'
      : '<div class="pq-nums"><span>已用 <b>'+fmtT(r.used)+'</b> / '+fmtT(r.limit)+'</span> <span>（'+r.type+'）</span><br><span>剩余 <b>'+fmtT(r.remaining)+'</b></span>'
        +((r.rawUsed!=null&&r.rawUsed!==r.used)?' · <span>实际 '+fmtTk(r.rawUsed)+'</span> <span>'+(r.rawUsed>r.used?'已抵扣 '+fmtTk(r.rawUsed-r.used):'已加收 '+fmtTk(r.used-r.rawUsed))+'</span>':'')
        +(r.nextRateChange?'<br><span>'+r.nextRateChange.at+' 后转入'+(r.nextRateChange.toPeak?'高峰':'低谷')+' ×'+r.nextRateChange.rate+'</span>':'')
        +'</div>';
    return '<div class="pq '+cls+'">'
      +'<div class="pq-hd"><div style="min-width:0"><div class="pq-name">'+esc(r.profile)+'</div><div class="pq-sfx">/'+esc(r.suffix)+'</div></div>'
      +'<div class="pq-pct" style="color:'+col+'">'+(free?'不限':r.pct+'%')+'</div></div>'
      +(free?'':hpBar(r.pct,16))
      +nums
      +'<div class="pq-tags">'+tags.join('')+'</div>'
      +'</div>';
  }).join('');
}
function render(){
  if(!D)return;
  const sel=document.getElementById('profileSel');
  // Always rebuild from the freshest D.availableProfiles (the backend narrows
  // the list when a protocol filter is active); keep the current selection.
  rebuildProfileOptions();
  sel.value=currentProfile;
  const curProto=(D.availableProfiles||[]).find(p=>p.suffix===currentProfile)?.protocol;
  const linkTag=currentProfile==='all'?(PROTO?' · 链路: '+(PROTO==='responses'?'OpenAI (Codex)':'Anthropic (Claude Code)'):''):' · 链路: '+(curProto==='responses'?'Codex (Responses)':'Claude Code (Anthropic)');
  const q=D.quota,t=D.today;
  const pct=q.limit>0?Math.min(100,Math.round(q.used/q.limit*100)):0;
  const color=pct>90?'var(--red)':pct>70?'var(--orange)':'var(--green)';
  document.getElementById('meta').innerHTML=D.username+' · 方案: '+D.profile+linkTag+(q.limit>0?' · <span style="color:'+color+'">'+pct+'% 已用</span> '+hpBar(pct,16)+rateTag(q)+(q.autoAdjusted?' <span class="tag">AUTO</span>':'')+(q.bonus>0?' <span class="tag" style="background:rgba(46,164,79,.12);color:var(--green)" title="'+bonusTip()+'">临时+'+fmtTk(q.bonus)+'</span>':'')+(q.resetApplied?' <span class="tag" title="管理员已重置今日用量，统计数据保留">已重置</span>':''):' · 无配额限制'+rateTag(q));
  renderQNotice(q);
  document.getElementById('cards').innerHTML=
    '<div class="card"><div class="l">今日用量 <span style="font-size:9px;color:var(--dim);font-weight:400">输入+输出</span></div><div class="v" data-cu="'+ioTokens(t)+'" data-cu-k style="color:var(--accent)">0</div></div>'+
    '<div class="card"><div class="l">今日请求</div><div class="v" data-cu="'+t.requests+'" data-cu-k style="color:var(--blue)">0</div></div>'+
    // Weighted card only appears when weighting is live — otherwise it would just
    // duplicate 今日用量 and add noise.
    (((q.rawUsed!=null&&q.rawUsed!==q.used)||(q.rate!==null&&q.rate!==undefined&&q.rate!==1))?'<div class="card" style="border-top:2px solid var(--accent)"><div class="l">计权用量 <span style="font-size:9px;color:var(--dim);font-weight:400">计入配额</span></div><div class="v" data-cu="'+q.used+'" data-cu-k style="color:var(--accent)">0</div>'+rateFootnote(q)+'</div>':'')+
    (q.limit>0?'<div class="card"'+(q.bonus>0?' style="border-top:2px solid var(--green)"':'')+'><div class="l">剩余额度'+(q.bonus>0?' <span class="tag" style="background:rgba(47,110,80,.1);color:var(--green)">含临时加量</span>':'')+'</div><div class="v" data-cu="'+q.remaining+'" data-cu-k style="color:'+color+'">0</div><div style="margin-top:8px">'+hpBar(pct,16)+'</div>'+rateFootnote(q)+'</div>'+
    '<div class="card"><div class="l">每日限额'+((q.rate!==null&&q.rate!==undefined&&q.rate!==1)?' <span style="font-size:9px;color:var(--dim);font-weight:400">计权口径</span>':'')+'</div><div class="v" data-cu="'+q.limit+'" data-cu-k style="color:var(--dim)">0</div>'+(q.bonus>0?'<div style="margin-top:6px;font-size:10px;color:var(--green);font-weight:550">基础 '+fmtTk(q.limit-q.bonus)+' + 临时 '+fmtTk(q.bonus)+'</div>':'')+'</div>':'')+
    // 输入/输出 merged into one card so all nine stats stay on a single row.
    '<div class="card"><div class="l">今日输入 / 输出</div><div class="v" style="font-size:19px"><span style="color:var(--green)">'+fmtTk(t.input)+'</span><span style="color:var(--dim2);font-weight:400"> / </span><span style="color:var(--orange)">'+fmtTk(t.output)+'</span></div><div style="margin-top:6px;font-size:10px;color:var(--dim);font-variant-numeric:tabular-nums">'+fmtT(t.input)+' / '+fmtT(t.output)+'</div></div>'+
    '<div class="card"><div class="l">今日缓存写入</div><div class="v" data-cu="'+t.cacheWrite+'" data-cu-k>0</div></div>'+
    '<div class="card"><div class="l">今日缓存命中</div><div class="v" data-cu="'+t.cacheRead+'" data-cu-k>0</div></div>';
  runCountUps(document.getElementById('cards'));
  renderProfileQuotas();
  // Hourly chart
  const hrs=[];for(let i=0;i<24;i++)hrs.push(i.toString().padStart(2,"0")+":00");
  const hData=hrs.map((_,i)=>{const h=D.hourly[i.toString().padStart(2,"0")]||{};return{req:h.requests||0,tokens:ioTokens(h)}});
  if(C.h)C.h.destroy();
  C.h=new Chart(document.getElementById("hourChart"),{type:"bar",data:{labels:hrs,datasets:[{label:"Token(输入+输出)",data:hData.map(d=>d.tokens),backgroundColor:COL[0]+"cc",borderRadius:3},{label:"请求数",data:hData.map(d=>d.req),backgroundColor:COL[1]+"cc",borderRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:"#686863",font:{size:10}}}},scales:{x:{ticks:{color:"#686863",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});
  // Trend chart
  if(C.t)C.t.destroy();
  C.t=new Chart(document.getElementById("trendChart"),{type:"line",data:{labels:D.trend.map(d=>d.date.slice(5)),datasets:[{label:"总Token(含缓存)",data:D.trend.map(d=>d.total),borderColor:COL[0],backgroundColor:"rgba(47,110,80,.12)",fill:true,tension:.28,pointRadius:2,borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:"#686863",font:{size:10}}}},scales:{x:{ticks:{color:"#686863"},grid:{display:false}},y:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});
  // Model table. Two token columns side by side is the whole point: "实际" is what
  // the user spent, "计入配额" is what it cost them. The per-row multiplier is the
  // realised ratio (weighted/raw) — for a row that straddled a peak boundary or a
  // rate change that lands between the two configured values, which is correct.
  const mt=document.querySelector("#modelTable tbody");
  const models=Object.entries(D.models||{}).sort((a,b)=>b[1].requests-a[1].requests);
  const anyWeighted=models.some(([,d])=>d.weighted!=null&&d.weighted!==d.total);
  if(!models.length){mt.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--dim)">暂无数据</td></tr>'}else{
    mt.innerHTML=models.map(([m,d])=>{
      const raw=d.total||0,w=d.weighted!=null?d.weighted:raw;
      const realised=raw>0?Math.round(w/raw*100)/100:null;
      const now=d.rate;
      // Show the realised ratio, and flag when the live rate differs from it (rate
      // changed today, or the day spanned a peak boundary).
      const rateCell=realised==null?'<span style="color:var(--dim)">-</span>'
        :'<span'+(realised!==1?' style="color:var(--accent)"':'')+' title="今日实际计权比例'+(now!=null&&now!==realised?'；当前时段该模型为 ×'+now:'')+'">×'+realised+(now!=null&&now!==realised?' <span style="color:var(--dim);font-size:10px">(现 ×'+now+')</span>':'')+'</span>';
      return '<tr><td style="color:var(--blue)">'+m+(d.rateIsDefault===false?' <span class="tag" style="font-size:9px">单独定价</span>':'')+'</td>'
        +'<td class="n">'+fmtT(d.requests)+'</td>'
        +'<td class="n" title="输入 '+fmtT(d.inputTokens||0)+' / 输出 '+fmtT(d.outputTokens||0)+'">'+fmtTk(raw)+'</td>'
        +'<td class="n">'+rateCell+'</td>'
        +'<td class="n hl">'+fmtTk(w)+'</td></tr>';
    }).join("");
  }
  const note=document.getElementById('modelTableNote');
  note.innerHTML=anyWeighted
    ?'「实际 Token」是真实消耗，「计入配额」是按倍率折算后从每日额度里扣掉的数额。倍率列为今日实际计权比例，跨高峰边界或期间调整过倍率时会落在两档之间。'
    :'当前所有模型倍率均为 1.0，实际消耗与计入配额相同。';
  renderRateCard();
  renderCheckin();
  renderQuotaRequest();
  renderCalendar();
}
// Price list: what each alias costs right now. Answers "为什么额度掉这么快" before
// the user spends, not after. Cheapest first — the cheap option should be the one
// that catches the eye.
function renderRateCard(){
  const box=document.getElementById('rateCardBox'),body=document.getElementById('rateCardBody');
  if(!box||!body)return;
  const cards=D.rateCard?[D.rateCard]:(D.rateCards||[]);
  const meaningful=cards.filter(c=>c&&c.rows.length&&(c.rows.some(r=>r.custom)||c.defaultPeak!==1||c.defaultOffPeak!==1));
  if(!meaningful.length){box.style.display='none';return}
  box.style.display='';
  body.innerHTML=meaningful.map(c=>{
    const rows=c.rows.map(r=>'<tr><td style="color:var(--blue)">'+r.alias+'</td>'
      +'<td style="color:var(--dim);font-size:11px;overflow:hidden;text-overflow:ellipsis">'+r.model+'</td>'
      +'<td class="n"'+(r.rate<1?' style="color:var(--green);font-weight:600"':r.rate>1?' style="color:var(--orange);font-weight:600"':'')+'>×'+r.rate+'</td>'
      +'<td class="n" style="color:var(--dim);font-size:11px">'+(r.custom?'峰 ×'+r.peak+' / 谷 ×'+r.offPeak:'跟随默认')+'</td></tr>').join('');
    return '<div style="margin-bottom:14px">'
      +'<div style="font-size:12px;font-weight:600;margin-bottom:6px">'+c.profile
      +' <span class="tag" style="background:rgba(0,0,0,.04);color:'+(c.inPeak?'var(--orange)':'var(--green)')+'">'+(c.inPeak?'高峰时段':'低谷时段')+'</span>'
      +' <span style="font-size:10px;color:var(--dim);font-weight:400">默认 ×'+(c.inPeak?c.defaultPeak:c.defaultOffPeak)+'</span></div>'
      +'<table style="min-width:auto;table-layout:fixed;width:100%"><thead><tr><th style="width:20%">别名</th><th style="width:42%">实际模型</th><th class="n" style="width:16%">当前倍率</th><th class="n" style="width:22%">峰/谷</th></tr></thead><tbody>'+rows+'</tbody></table>'
      +'</div>';
  }).join('')
    +'<div class="note" style="font-size:11px;color:var(--dim)">倍率越低越省额度：×0.5 表示消耗 1000 token 只扣 500 额度。倍率随时段自动切换，调整只影响之后的请求。</div>';
}
let calRz;window.addEventListener('resize',function(){clearTimeout(calRz);calRz=setTimeout(function(){if(D)renderCalendar()},150)});
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

// ── Settings audit: snapshot before applySettings, diff after ────────────────
function settingsAuditSnapshot() {
  return {
    proxy: JSON.stringify(config.proxy || {}),
    autoQuotaAdjust: JSON.stringify(config.autoQuotaAdjust || {}),
    checkIn: JSON.stringify(config.checkIn || {}),
    quotaRequest: JSON.stringify(config.quotaRequest || {}),
    users: JSON.stringify(Object.fromEntries(Object.entries(config.users || {}).map(([k, v]) => [maskAuditKey(k), v]))),
    profiles: Object.fromEntries(Object.entries(config.profiles || {}).map(([n, p]) => [n, JSON.stringify(p)])),
  };
}

function jsonChangedKeys(beforeJson, afterJson) {
  const before = JSON.parse(beforeJson || "{}");
  const after = JSON.parse(afterJson || "{}");
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed.push(k);
  }
  return changed;
}

function settingsAuditDiff(snap, now) {
  const parts = [];
  let target = "";
  const profileNames = new Set([...Object.keys(snap.profiles), ...Object.keys(now.profiles)]);
  for (const name of profileNames) {
    const a = snap.profiles[name], b = now.profiles[name];
    if (a === b) continue;
    const changed = jsonChangedKeys(a, b);
    parts.push(`方案 "${name}"${changed.length ? `(${changed.join(", ")})` : ""}`);
    // Quota rates silently re-price everyone's effective allowance, so spell the
    // old→new values out instead of leaving just a field name in the log.
    const rateText = quotaRateChangeText(a, b);
    if (rateText) parts.push(`方案 "${name}" 配额倍率：${rateText}`);
    if (!target) target = name;
  }
  const proxyChanged = jsonChangedKeys(snap.proxy, now.proxy);
  if (proxyChanged.length) parts.push(`全局代理(${proxyChanged.join(", ")})`);
  const quotaChanged = jsonChangedKeys(snap.autoQuotaAdjust, now.autoQuotaAdjust);
  if (quotaChanged.length) parts.push(`自动配额(${quotaChanged.join(", ")})`);
  if (snap.users !== now.users) parts.push("全局用户配置");
  return { target, text: parts.join("；") };
}

function quotaRateChangeText(beforeJson, afterJson) {
  let before, after;
  try { before = JSON.parse(beforeJson || "{}"); after = JSON.parse(afterJson || "{}"); }
  catch { return ""; }
  const bits = [];
  for (const [field, label] of [["peakQuotaRate", "峰"], ["offPeakQuotaRate", "谷"]]) {
    const b = normalizeQuotaRate(before[field]), a = normalizeQuotaRate(after[field]);
    if (b !== a) bits.push(`${label} ${b}→${a}`);
  }
  // Per-model overrides: report added / removed / changed models by name, since a
  // bare "modelQuotaRates" field name tells the reader nothing about the impact.
  const mb = normalizeModelQuotaRates(before.modelQuotaRates), ma = normalizeModelQuotaRates(after.modelQuotaRates);
  for (const model of new Set([...Object.keys(mb), ...Object.keys(ma)])) {
    const x = mb[model], y = ma[model];
    if (!x && y) bits.push(`${model} 新增 峰 ${y.peak}/谷 ${y.offPeak}`);
    else if (x && !y) bits.push(`${model} 取消单独定价（回落默认）`);
    else if (x && y && (x.peak !== y.peak || x.offPeak !== y.offPeak)) {
      bits.push(`${model} 峰 ${x.peak}→${y.peak}/谷 ${x.offPeak}→${y.offPeak}`);
    }
  }
  return bits.join(" / ");
}

function applySettings(formData) {
  const isGlobalOnlySave = !formData.profileName && !formData.profileSuffix && formData.upstream === undefined;
  const editingProfileName = formData.profileName || getProfileNameBySuffix(formData.profileSuffix) || getDefaultProfileName();
  const editingProfile = config.profiles[editingProfileName];
  if (!editingProfile) throw new Error(`Profile "${editingProfileName}" not found`);

  if (formData.upstream && formData.upstream !== editingProfile.upstream) {
    if (!/^https?:\/\/[^\s]+/.test(formData.upstream)) throw new Error("Invalid upstream URL");
    editingProfile.upstream = formData.upstream.trim();
    console.log(`[CONFIG] Upstream updated: ${editingProfile.upstream}`);
  }

  if (formData.suffix !== undefined) {
    const nextSuffix = validateProfileSuffix(formData.suffix, editingProfileName);
    const oldSuffix = editingProfile.suffix;
    if (nextSuffix !== oldSuffix) {
      editingProfile.suffix = nextSuffix;
      // Rename the profile column across all usage tables.
      for (const table of ["users", "usage_daily", "usage_daily_model", "usage_daily_hourly", "usage_hourly_model", "usage_model", "usage_hourly", "errors"]) {
        db.prepare(`UPDATE ${table} SET profile = ? WHERE profile = ?`).run(nextSuffix, oldSuffix);
      }
    }
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

  // Pool assignment (profile form only). "__new__" creates a same-named pool so a
  // profile can always be given an independent allowance by splitting it off.
  if (!isGlobalOnlySave && formData.quotaPool !== undefined) {
    const chosen = String(formData.quotaPool);
    const prevPool = normalizeQuotaPoolName(editingProfile.quotaPool);
    if (chosen === "__new__") {
      let name = normalizeQuotaPoolName(editingProfileName) || "pool";
      for (let i = 2; config.quotaPools[name]; i++) name = `${normalizeQuotaPoolName(editingProfileName)}-${i}`.slice(0, QUOTA_POOL_NAME_MAX);
      config.quotaPools[name] = { label: editingProfileName, dailyTokenLimit: null, users: {} };
      editingProfile.quotaPool = name;
    } else if (config.quotaPools[chosen]) {
      editingProfile.quotaPool = chosen;
    }
    // Auto-clean the vacated pool: once no profile draws from it, its limits are
    // dead config — exactly the leftover a merge leaves behind (GLM-CodeX moved
    // into the GLM pool, the old same-named pool would linger forever otherwise).
    const newPool = normalizeQuotaPoolName(editingProfile.quotaPool);
    if (prevPool && prevPool !== newPool && config.quotaPools[prevPool]) {
      const stillUsed = Object.keys(config.profiles).some(p => resolvePoolName(p) === prevPool);
      if (!stillUsed) {
        delete config.quotaPools[prevPool];
        console.log(`[QuotaPool] 方案 "${editingProfileName}" 移出后池 "${prevPool}" 已无成员，自动删除`);
      }
    }
  }

  // Update billing type (display label, drives no logic)
  if (!isGlobalOnlySave && formData.billingType && ["coding_plan", "token_plan", "on_demand"].includes(formData.billingType)) {
    editingProfile.billingType = formData.billingType;
  }

  // Update peak hours (recurring daily ranges; drive peak aliases + quota rates)
  if (!isGlobalOnlySave && formData.peakStart !== undefined) {
    const starts = [].concat(formData.peakStart);
    const ends = [].concat(formData.peakEnd);
    editingProfile.peakHours = normalizePeakHours(starts.map((s, i) => ({ start: s, end: ends[i] })));
  }

  // Update quota rates (weighting applied to future requests only)
  if (!isGlobalOnlySave && formData.peakQuotaRate !== undefined) {
    editingProfile.peakQuotaRate = normalizeQuotaRate(formData.peakQuotaRate);
  }
  if (!isGlobalOnlySave && formData.offPeakQuotaRate !== undefined) {
    editingProfile.offPeakQuotaRate = normalizeQuotaRate(formData.offPeakQuotaRate);
  }
  // Per-model rate rows: mr_model_N / mr_peak_N / mr_off_N, gated on the hidden
  // mrPresent marker so a submit that deleted every row still clears the overrides
  // (row keys alone would be absent and the old map would survive).
  if (!isGlobalOnlySave && formData.mrPresent !== undefined) {
    const rates = {};
    for (let i = 0; formData["mr_model_" + i] !== undefined; i++) {
      const model = String(formData["mr_model_" + i] || "").trim();
      if (!model) continue;   // unselected row — silently skipped
      rates[model] = {
        peak: normalizeQuotaRate(formData["mr_peak_" + i]),
        offPeak: normalizeQuotaRate(formData["mr_off_" + i]),
      };
    }
    editingProfile.modelQuotaRates = rates;
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
  setMeta("lastQuotaEval", ""); // Reset eval date so new config takes effect immediately

  // Check-in reward range & quota-request weekly cap (member gamification).
  // Unchecked boxes submit nothing, so absence means OFF for both toggles.
  if (!config.checkIn) config.checkIn = {};
  config.checkIn.enabled = formData.checkInEnabled === "on";
  const ciMin = parseInt(formData.checkInMin, 10);
  const ciMax = parseInt(formData.checkInMax, 10);
  if (Number.isFinite(ciMin) && ciMin >= 0) config.checkIn.minTokens = ciMin;
  if (Number.isFinite(ciMax) && ciMax >= 0) config.checkIn.maxTokens = Math.max(ciMax, config.checkIn.minTokens || 0);
  if (!config.quotaRequest) config.quotaRequest = {};
  config.quotaRequest.enabled = formData.quotaRequestEnabled === "on";
  const qrWk = parseInt(formData.quotaRequestWeeklyLimit, 10);
  if (Number.isFinite(qrWk) && qrWk >= 0 && qrWk <= 1000) config.quotaRequest.weeklyLimit = qrWk;

  // Restrict default-group members to /v1 only (block direct /<suffix>/... access).
  // Default ON (undefined → enabled) to prevent bypassing failover to on-demand profiles.
  config.restrictGroupSuffix = formData.restrictGroupSuffix === "on";

  // Update retryable status codes
  if (formData.retryableStatusCodes) {
    gProxy.retryableStatusCodes = formData.retryableStatusCodes
      .split(",")
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
  }

  // ── 模型别名（结构化行编辑器）────────────────────────────────────────────
  // 通用别名必填：行字段 ma_alias_N / ma_model_N / ma_ctx_N；至少 1 行完整、别名唯一。
  // 高峰覆盖行 pa_alias_N / pa_model_N（可选，别名来自通用别名集合）。
  // allowedModels 不再接受手填，完全由别名目标派生。
  const hasAliasRows = Object.keys(formData).some(k => /^ma_alias_\d+$/.test(k));
  if (hasAliasRows) {
    const aliases = {};
    const contextWindows = {};
    const multimodal = {};
    for (let i = 0; formData["ma_alias_" + i] !== undefined || formData["ma_model_" + i] !== undefined; i++) {
      const alias = String(formData["ma_alias_" + i] || "").trim();
      const model = String(formData["ma_model_" + i] || "").trim();
      if (!alias && !model) continue;   // blank row
      if (!alias || !model) throw new Error(`第 ${i + 1} 行别名配置不完整：别名与实际模型都必须填写`);
      if (aliases[alias]) throw new Error(`别名 "${alias}" 重复，每行别名必须唯一`);
      aliases[alias] = model;
      const cw = parseInt(formData["ma_ctx_" + i], 10);
      contextWindows[alias] = Number.isFinite(cw) && cw > 0 ? cw : 128000;
      multimodal[alias] = formData["ma_mm_" + i] === "on";
    }
    if (Object.keys(aliases).length === 0) throw new Error("至少需要配置 1 个通用模型别名（可用快捷按钮添加 jx-fable / jx-opus / jx-haiku / jx-sonnet）");
    editingProfile.modelAliases = aliases;
    editingProfile.modelContextWindows = contextWindows;
    editingProfile.modelMultimodal = multimodal;
  } else if (formData.modelAliases !== undefined) {
    // Legacy textarea path (older clients / API posts)
    const parsedAliases = parseModelAliasesInput(formData.modelAliases);
    if (Object.keys(parsedAliases).length === 0) throw new Error("至少需要配置 1 个通用模型别名");
    editingProfile.modelAliases = parsedAliases;
  }

  // Image-recognition helper model (both protocols). Access is always on —
  // non-multimodal aliases are transcribed automatically; the legacy
  // imgBridgeEnabled checkbox is ignored (kept for config compatibility).
  if (formData.imgBridgeModel !== undefined) {
    if (!editingProfile.imageBridge) editingProfile.imageBridge = { model: "" };
    editingProfile.imageBridge.model = String(formData.imgBridgeModel).trim();
    if (!editingProfile.imageBridge.model) delete editingProfile.imageBridge.model;
  }

  if (Object.keys(formData).some(k => /^pa_alias_\d+$/.test(k))) {
    const peakAliases = {};
    for (let i = 0; formData["pa_alias_" + i] !== undefined || formData["pa_model_" + i] !== undefined; i++) {
      const alias = String(formData["pa_alias_" + i] || "").trim();
      const model = String(formData["pa_model_" + i] || "").trim();
      if (!alias && !model) continue;
      if (!alias || !model) throw new Error(`高峰期第 ${i + 1} 行不完整：别名与实际模型都必须填写`);
      if (peakAliases[alias]) throw new Error(`高峰期别名 "${alias}" 重复`);
      peakAliases[alias] = model;
    }
    editingProfile.peakModelAliases = peakAliases;
  } else if (formData.peakModelAliases !== undefined) {
    editingProfile.peakModelAliases = formData.peakModelAliases.trim()
      ? parseModelAliasesInput(formData.peakModelAliases)
      : {};
  }

  // allowedModels = 去重后的全部别名目标（唯一来源，不可手填）。
  // Only recomputed on profile-form saves; a global-only save carries no alias
  // fields and must not touch the profile's allowedModels.
  // NOTE: the two alias maps are merged by VALUES, not by spread — spreading
  // would let a peak alias with the same key silently drop the default target
  // from the allowed list (jx-opus=glm-5.3 + peak jx-opus=flash used to yield
  // an allowed list of just [flash], 403-ing every off-peak jx-opus request).
  if (!isGlobalOnlySave) {
    const aliasTargets = [
      ...Object.values(normalizeModelAliases(editingProfile.modelAliases || {})),
      ...Object.values(normalizeModelAliases(editingProfile.peakModelAliases || {})),
    ].filter(Boolean);
    editingProfile.allowedModels = [...new Set(aliasTargets)];
    if (editingProfile.allowedModels.length === 0) {
      throw new Error("允许模型列表为空——请先在上方配置模型别名");
    }
  }

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
    config.users = newGlobalUsers;
  }

  // Update profile users (key assignment + profile disable). Quota is NOT written
  // here — it belongs to the pool and is edited on the 额度池 page.
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
    editingProfile.users = newProfileUsers;
  }

  // Persist to config.json
  config.proxy = { ...gProxy };
  saveConfig(config);
  reloadAllRuntimes();

  console.log(`[CONFIG] Settings saved to profile "${editingProfileName}"`);
}

function getImportPreview(raw) {
  const normalized = normalizeLegacyImportData(raw);
  const availableSuffixes = new Set(listProfiles().map((profile) => profile.suffix));
  const sourceProfiles = Object.keys(normalized.profiles).map((suffix) => ({
    suffix,
    matchedTarget: availableSuffixes.has(normalizeProfileSuffix(suffix)) ? normalizeProfileSuffix(suffix) : null,
  }));
  const warnings = sourceProfiles
    .filter((profile) => !profile.matchedTarget)
    .map((profile) => `来源方案 ${profile.suffix} 未自动匹配，请选择目标方案或跳过`);
  return { summary: summarizeLegacyImport(normalized), sourceProfiles, warnings, sourceHash: legacyImportHash(raw) };
}

function resolveImportProfileMap(normalized, requestedMap = {}) {
  const availableSuffixes = new Set(listProfiles().map((profile) => profile.suffix));
  const resolved = {};
  for (const source of Object.keys(normalized.profiles)) {
    const requested = requestedMap[source];
    if (requested === "skip" || requested === null) {
      resolved[source] = "";
      continue;
    }
    const target = normalizeProfileSuffix(requested || (availableSuffixes.has(normalizeProfileSuffix(source)) ? source : ""));
    if (!target) throw new Error(`来源方案 ${source} 尚未映射`);
    if (!availableSuffixes.has(target)) throw new Error(`目标方案 ${target} 不存在`);
    resolved[source] = target;
  }
  if (!Object.values(resolved).some(Boolean)) throw new Error("至少需要导入一个来源方案");
  return resolved;
}

function clearInMemoryRequestState() {
  for (const state of [userConcurrent, userRateBucket, ipRateBucket]) {
    for (const key of Object.keys(state)) delete state[key];
  }
}

function resetConfigToUnconfiguredState() {
  const preserved = {
    port: config.port,
    dashboardPassword: config.dashboardPassword,
    proxy: { ...(config.proxy || {}) },
  };
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, preserved, {
    users: {},
    quotaPools: {
      "默认方案": { label: "默认方案", dailyTokenLimit: null, users: {} },
    },
    profiles: {
      "默认方案": {
        suffix: "default",
        isDefault: true,
        upstream: "",
        allowedModels: [],
        modelAliases: {},
        peakModelAliases: {},
        quotaPool: "默认方案",
        users: {},
      },
    },
  });
}

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

  if (req.method === "POST" && req.url === "/api/data-import/preview") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req, 50_000_000).then((buf) => {
      try {
        const { data } = JSON.parse(buf.toString());
        const preview = getImportPreview(data);
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
        const profileMap = resolveImportProfileMap(normalized, payload.profileMap || {});
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
          resetConfigToUnconfiguredState();
          try {
            saveConfig(config);
          } catch (err) {
            for (const key of Object.keys(config)) delete config[key];
            Object.assign(config, previousConfig);
            throw err;
          }
        });
        tx();
        clearInMemoryRequestState();
        reloadAllRuntimes();
        console.log("[DATA] All configuration and request data cleared");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        recordAdminAudit(req, "data.clear", "全局", "清空全部数据（方案、用户、密钥、配额、统计、错误），已自动备份；审计日志保留");
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
          res.end(settingsHtml("保存失败: 安全校验未通过，本次修改未保存，请刷新页面后重新填写并保存"));
          return;
        }
        const formData = parseFormBody(body);
        const auditSnap = settingsAuditSnapshot();
        applySettings(formData);
        const auditDiff = settingsAuditDiff(auditSnap, settingsAuditSnapshot());
        recordAdminAudit(req, "settings.save", auditDiff.target, `保存设置（设置页表单）${auditDiff.text ? "，变更: " + auditDiff.text : "（无实际变化）"}`);
        res.writeHead(302, { "Location": "/settings?saved=1" });
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
        const { profile, upstream, allowedModels, suffix, modelAliases, billingType, protocol, quotaPool } = JSON.parse(buf.toString());
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
        const apiAuditSnap = settingsAuditSnapshot();
        applySettings(formData);
        const apiAuditDiff = settingsAuditDiff(apiAuditSnap, settingsAuditSnapshot());
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
      res.end(loginHtml());
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(dashboardHtml());
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
      protoFilter = protocolSuffixes(protocolParam);
    }
    let data;
    if (profileSuffix === "all") {
      // Aggregate all profiles (optionally narrowed to one protocol)
      const agg = getAggregatedStore(protoFilter);
      data = sanitizeStore(agg);
      data.profileView = "all";
      data.protocolView = protocolView;
      // Quota per user across every profile they can use, so the aggregate view
      // answers "who is near their limit" without drilling into each profile.
      data.userQuotaMatrix = getUserQuotaMatrix(protoFilter);
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
    data.profileSummaries = getProfileSummaries();
    // Chart feeds: hourly×model trend (scoped to current profile view) and
    // cross-profile daily aggregates (always all profiles — the profile chart
    // is a cross-profile dimension and must not shrink with the profile filter).
    const scopedSuffix = profileSuffix === "all" ? null : normalizeProfileSuffix(profileSuffix);
    data.hourlyModels = loadHourlyModels(scopedSuffix, protoFilter);
    data.profileDaily = loadProfileDaily(protoFilter);
    data.profileDailyModels = loadProfileDailyModels(protoFilter);
    // Model rate board: config rates + today's realised cost per profile×model.
    data.modelRateBoard = getModelRateBoard(
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

  // Quota pool editing: the single write path for pool-level and per-user limits.
  // Kept separate from /api/global-user/save so "who can use a profile" (real key
  // + disable, per profile) and "how much a pool allows" (limits, per pool) each
  // have exactly one home.
  if (req.method === "POST" && req.url === "/api/quota-pool/save") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { pool: poolNameRaw, dailyTokenLimit, users } = JSON.parse(buf.toString());
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
        const nextPoolLimit = normLimit(dailyTokenLimit);
        pool.dailyTokenLimit = nextPoolLimit;

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
          newGlobalUsers[u.key] = { username: u.username || u.key.slice(0, 8), expiresAt: u.expiresAt || null, disabled: !!u.disabled };
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
        const parts = [];
        if (added) parts.push(`新增用户 ${added} 名`);
        if (removed) parts.push(`删除用户 ${removed} 名`);
        if (disabledGlobal) parts.push(`全局禁用 ${disabledGlobal} 名`);
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
      else catalog = buildCodexModelCatalog(vk);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(codexSetupHtml(vk, state, catalog));
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
    const catalog = buildCodexModelCatalog(vk);
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
    res.end(personalUsageHtml(vk));
    return;
  }
  if (req.method === "GET" && req.url.startsWith("/my-usage")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const vk = url.searchParams.get("key");
    if (!rt || !vk || (!rt.users[vk] && !rt.globalUsers[vk])) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(personalUsageLandingHtml());
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(personalUsageHtml(vk));
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
      const payload = getPersonalUsageData(apiKey, profileSuffix, protocolParam);
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
