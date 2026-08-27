import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
const RESERVED_SUFFIXES = new Set(["dashboard", "settings", "api", "health", "usage", "my-usage", "v1", "login", "logout", "favicon", "robots", "js", "css"]);
const PROFILE_SUFFIX_RE = /^[a-z0-9_-]{2,20}$/;

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
    for (const target of Object.values({ ...aliases, ...profile.peakModelAliases })) {
      if (target && !profile.allowedModels.includes(target)) profile.allowedModels.push(target);
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

// Auto-migrate: ensure quota fields exist
(function migrateQuotaConfig() {
  let migrated = false;
  for (const pname of Object.keys(config.profiles)) {
    const p = config.profiles[pname];
    if (p.dailyTokenLimit === undefined) { p.dailyTokenLimit = null; migrated = true; }
    if (p.peakHours === undefined) { p.peakHours = []; migrated = true; }
    if (p.users) {
      for (const [vk, u] of Object.entries(p.users)) {
        if (typeof u === "object" && u.dailyTokenLimit === undefined) { u.dailyTokenLimit = null; migrated = true; }
      }
    }
  }
  if (migrated) { saveConfig(config); console.log("[MIGRATE] Added dailyTokenLimit fields"); }
})();

// Peak hours: per-profile recurring daily time ranges, display-only (does not
// affect proxying/quota). Format: [{start:"HH:mm", end:"HH:mm"}]; end < start
// means the range crosses midnight (e.g. 22:00-02:00).
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

function listProfiles() {
  const group = Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : [];
  return Object.keys(config.profiles).map(name => ({
    name,
    suffix: normalizeProfileSuffix(config.profiles[name].suffix),
    isDefault: !!config.profiles[name].isDefault,
    billingType: config.profiles[name].billingType || "on_demand",
    upstream: config.profiles[name].upstream,
    userCount: Object.keys(config.profiles[name].users || {}).length,
    allowedModels: config.profiles[name].allowedModels || [],
    modelAliases: getConfigurableModelAliases(config.profiles[name]),
    peakModelAliases: normalizeModelAliases(config.profiles[name].peakModelAliases || {}),
    dailyTokenLimit: config.profiles[name].dailyTokenLimit || 0,
    peakHours: normalizePeakHours(config.profiles[name].peakHours),
    configured: !!config.profiles[name].upstream,
    inDefaultGroup: group.includes(name),
    groupOrder: group.indexOf(name),
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
    suffix: normalizeProfileSuffix(profile.suffix),
    isDefault: !!profile.isDefault,
    billingType: profile.billingType || "on_demand",
    upstream: profile.upstream,
    upstreamUrl,
    users: { ...(profile.users || {}) },
    allowedModels: profile.allowedModels || [],
    modelAliases: getProfileModelAliases(profile),
    peakHours: normalizePeakHours(profile.peakHours),
    peakModelAliases: normalizeModelAliases(profile.peakModelAliases || {}),
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

// Backward-compat: rt → default profile runtime (used by non-request-path code)
let rt;

function getDefaultRuntime() {
  return runtimes[getDefaultProfileSuffix()] || Object.values(runtimes)[0];
}

function syncDefaultRuntime() {
  rt = getDefaultRuntime();
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
      PRIMARY KEY (profile, date, user_key)
    );
    CREATE TABLE IF NOT EXISTS usage_daily_model (
      profile TEXT NOT NULL, date TEXT NOT NULL, user_key TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, requests INTEGER DEFAULT 0,
      PRIMARY KEY (profile, date, user_key, model)
    );
    CREATE TABLE IF NOT EXISTS usage_daily_hourly (
      profile TEXT NOT NULL, date TEXT NOT NULL, user_key TEXT NOT NULL, hour TEXT NOT NULL,
      requests INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_creation INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0,
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
  `);

  // ── Write statements (UPSERT / INSERT) ──
  stmts.upsertUser = db.prepare(`INSERT INTO users (profile,user_key,name,total_input,total_output,total_requests,cache_creation,cache_read,last_active)
    VALUES (@profile,@key,@name,@inp,@out,1,@cacheC,@cacheR,@now)
    ON CONFLICT(profile,user_key) DO UPDATE SET
      total_input=total_input+@inp, total_output=total_output+@out, total_requests=total_requests+1,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR, name=@name, last_active=@now`);
  stmts.upsertDaily = db.prepare(`INSERT INTO usage_daily (profile,date,user_key,input_tokens,output_tokens,requests,cache_creation,cache_read)
    VALUES (@profile,@today,@key,@inp,@out,1,@cacheC,@cacheR)
    ON CONFLICT(profile,date,user_key) DO UPDATE SET
      input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out, requests=requests+1,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR`);
  stmts.upsertModel = db.prepare(`INSERT INTO usage_model (profile,model,tokens,requests)
    VALUES (@profile,@m,@tokenTotal,1)
    ON CONFLICT(profile,model) DO UPDATE SET tokens=tokens+@tokenTotal, requests=requests+1`);
  stmts.upsertHourly = db.prepare(`INSERT INTO usage_hourly (profile,date,hour,requests,input_tokens,output_tokens,cache_creation,cache_read)
    VALUES (@profile,@today,@hour,1,@inp,@out,@cacheC,@cacheR)
    ON CONFLICT(profile,date,hour) DO UPDATE SET
      requests=requests+1, input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR`);
  stmts.upsertDailyModel = db.prepare(`INSERT INTO usage_daily_model (profile,date,user_key,model,input_tokens,output_tokens,requests)
    VALUES (@profile,@today,@key,@m,@inp,@out,1)
    ON CONFLICT(profile,date,user_key,model) DO UPDATE SET
      input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out, requests=requests+1`);
  stmts.upsertDailyHourly = db.prepare(`INSERT INTO usage_daily_hourly (profile,date,user_key,hour,requests,input_tokens,output_tokens,cache_creation,cache_read)
    VALUES (@profile,@today,@key,@hour,1,@inp,@out,@cacheC,@cacheR)
    ON CONFLICT(profile,date,user_key,hour) DO UPDATE SET
      requests=requests+1, input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR`);
  stmts.insertError = db.prepare(`INSERT INTO errors (profile,time,user_name,user_key,status_code,error,path,model)
    VALUES (@profile,@time,@userName,@key,@statusCode,@error,@path,@model)`);
  stmts.pruneErrors = db.prepare(`DELETE FROM errors WHERE time < ?`);
  stmts.trimErrors = db.prepare(`DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY id DESC LIMIT 200)`);
  stmts.pruneDailyModel = db.prepare(`DELETE FROM usage_daily_model WHERE date < ?`);
  stmts.pruneDailyHourly = db.prepare(`DELETE FROM usage_daily_hourly WHERE date < ?`);
  stmts.insertQuotaAdjust = db.prepare(`INSERT INTO quota_adjust_history (user_key,user_name,date,old_quota,new_quota,hit_rate,avg_daily_usage,auto,time)
    VALUES (@user,@username,@date,@oldQuota,@newQuota,@hitRate,@avgDailyUsage,1,@time)`);
  stmts.trimQuotaAdjust = db.prepare(`DELETE FROM quota_adjust_history WHERE id NOT IN (SELECT id FROM quota_adjust_history ORDER BY id DESC LIMIT 100)`);
  stmts.upsertMeta = db.prepare(`INSERT INTO kv_meta (key,value) VALUES (@k,@v) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);

  // ── Read statements ──
  stmts.todayUsageForQuota = db.prepare(`SELECT COALESCE(SUM(input_tokens+output_tokens),0) AS used FROM usage_daily WHERE profile=? AND date=? AND user_key=?`);
  stmts.profileDailyRow = db.prepare(`SELECT * FROM usage_daily WHERE profile=? AND date=? AND user_key=?`);
  stmts.profileDailyModelRows = db.prepare(`SELECT model,input_tokens,output_tokens,requests FROM usage_daily_model WHERE profile=? AND date=? AND user_key=?`);
  stmts.profileDailyHourlyRows = db.prepare(`SELECT hour,requests,input_tokens,output_tokens,cache_creation,cache_read FROM usage_daily_hourly WHERE profile=? AND date=? AND user_key=?`);
  stmts.profileDailyTrend = db.prepare(`SELECT date,input_tokens,output_tokens,requests,cache_creation,cache_read FROM usage_daily WHERE profile=? AND user_key=? AND date>=? ORDER BY date`);
  stmts.profileSummaryToday = db.prepare(`SELECT COALESCE(SUM(input_tokens+output_tokens+cache_creation+cache_read),0) AS tokens, COALESCE(SUM(requests),0) AS requests FROM usage_daily WHERE profile=? AND date=?`);
  stmts.lastQuotaAdjust = db.prepare(`SELECT * FROM quota_adjust_history WHERE user_key=? ORDER BY id DESC LIMIT 1`);
  stmts.quotaAdjustRecent = db.prepare(`SELECT * FROM quota_adjust_history ORDER BY id DESC LIMIT 20`);
  stmts.defaultDailyForUser = db.prepare(`SELECT date,input_tokens,output_tokens,cache_creation,cache_read FROM usage_daily WHERE profile=? AND user_key=? AND date>=?`);
}

// ── Pruning (called once a day via a lazy check) ──
let lastPruneDate = null;
function pruneOldDataIfNewDay() {
  const today = cnDate();
  if (lastPruneDate === today) return;
  lastPruneDate = today;
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const cutoff7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const tx = db.transaction(() => {
    stmts.pruneDailyModel.run(cutoff);
    stmts.pruneDailyHourly.run(cutoff);
    stmts.pruneErrors.run(cutoff7d);
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
          db.prepare(`INSERT INTO usage_daily (profile,date,user_key,input_tokens,output_tokens,requests,cache_creation,cache_read) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(profile,date,user_key) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, requests=requests+excluded.requests, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read`)
            .run(suffix, date, k, v.inputTokens||0, v.outputTokens||0, v.requests||0, v.cacheCreationTokens||0, v.cacheReadTokens||0);
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
            db.prepare(`INSERT INTO usage_daily_model (profile,date,user_key,model,input_tokens,output_tokens,requests) VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(profile,date,user_key,model) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, requests=requests+excluded.requests`)
              .run(suffix, date, k, m, v.inputTokens||0, v.outputTokens||0, v.requests||0);
          }
        }
      }
      for (const [date, dh] of Object.entries(ps.dailyHourly || {})) {
        for (const [k, hours] of Object.entries(dh)) {
          for (const [h, v] of Object.entries(hours)) {
            db.prepare(`INSERT INTO usage_daily_hourly (profile,date,user_key,hour,requests,input_tokens,output_tokens,cache_creation,cache_read) VALUES (?,?,?,?,?,?,?,?,?)
              ON CONFLICT(profile,date,user_key,hour) DO UPDATE SET requests=requests+excluded.requests, input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read`)
              .run(suffix, date, k, h, v.requests||0, v.inputTokens||0, v.outputTokens||0, v.cacheCreationTokens||0, v.cacheReadTokens||0);
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

const REQUEST_DATA_TABLES = ["users", "usage_daily", "usage_daily_model", "usage_daily_hourly", "usage_model", "usage_hourly", "errors", "quota_adjust_history"];

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
        db.prepare(`INSERT INTO usage_daily (profile,date,user_key,input_tokens,output_tokens,requests,cache_creation,cache_read) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(profile,date,user_key) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
          requests=requests+excluded.requests, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read`)
          .run(suffix, date, key, row.inputTokens || 0, row.outputTokens || 0, row.requests || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0);
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
          db.prepare(`INSERT INTO usage_daily_model (profile,date,user_key,model,input_tokens,output_tokens,requests) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(profile,date,user_key,model) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens,
            output_tokens=output_tokens+excluded.output_tokens, requests=requests+excluded.requests`)
            .run(suffix, date, key, model, row.inputTokens || 0, row.outputTokens || 0, row.requests || 0);
        }
      }
    }
    for (const [date, users] of Object.entries(ps.dailyHourly || {})) {
      for (const [key, hours] of Object.entries(users || {})) {
        for (const [hour, row] of Object.entries(hours || {})) {
          db.prepare(`INSERT INTO usage_daily_hourly (profile,date,user_key,hour,requests,input_tokens,output_tokens,cache_creation,cache_read) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(profile,date,user_key,hour) DO UPDATE SET requests=requests+excluded.requests, input_tokens=input_tokens+excluded.input_tokens,
            output_tokens=output_tokens+excluded.output_tokens, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read`)
            .run(suffix, date, key, hour, row.requests || 0, row.inputTokens || 0, row.outputTokens || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0);
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
  rateLimitState[profileName] = { resumeAt: resumeAtMs, source: source || "unknown", updatedAt: Date.now() };
  persistRateLimitState();
  console.log(`[RateLimit] "${profileName}" marked limited until ${new Date(resumeAtMs).toISOString()} (source: ${source || "unknown"})`);
}

function clearRateLimited(profileName) {
  if (profileName && rateLimitState[profileName]) {
    delete rateLimitState[profileName];
    persistRateLimitState();
  }
}

// Lazily self-heals: once resumeAt has passed, clear and report "not limited".
function isRateLimited(profileName) {
  const st = rateLimitState[profileName];
  if (!st) return false;
  if (Date.now() >= st.resumeAt) { clearRateLimited(profileName); return false; }
  return true;
}

function getRateLimitInfo(profileName) {
  const st = rateLimitState[profileName];
  if (!st) return null;
  if (Date.now() >= st.resumeAt) { clearRateLimited(profileName); return null; }
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

// Classify an upstream response as a plan limit we should fail over from.
// Returns { resumeAt, source } when it is, or null for a plain burst 429
// (which should follow the normal same-upstream retry path).
function classifyRateLimit(statusCode, text) {
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
  return looksLikePlanLimit ? { resumeAt: fallbackResumeAtMs(), source: "fallback" } : null;
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
    if (isRateLimited(name)) continue;
    if (runtime.breaker.status().state === "OPEN") continue;
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
loadRateLimitState();

function removeLegacyOpenAIData() {
  const suffixes = removedOpenAIProfileSuffixes.filter(Boolean);
  if (suffixes.length === 0) return;
  db.pragma("wal_checkpoint(FULL)");
  backupFileSync(dbPath, "data.db", "remove-openai");
  const placeholders = suffixes.map(() => "?").join(",");
  const removedKeys = db.prepare(`SELECT DISTINCT user_key FROM users WHERE profile IN (${placeholders})`).all(...suffixes).map((row) => row.user_key);
  const tx = db.transaction(() => {
    for (const table of ["users", "usage_daily", "usage_daily_model", "usage_daily_hourly", "usage_model", "usage_hourly", "errors"]) {
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
// frontend work unchanged.
function getAggregatedStore() {
  const agg = { users: {}, daily: {}, dailyModels: {}, dailyHourly: {}, models: {}, hourly: {}, errors: [] };

  // users: GROUP BY user_key across all profiles
  for (const r of db.prepare(`SELECT user_key, MAX(name) AS name, SUM(total_input) AS ti, SUM(total_output) AS tout, SUM(total_requests) AS tr, SUM(cache_creation) AS cc, SUM(cache_read) AS cr, MAX(last_active) AS la FROM users GROUP BY user_key`).all()) {
    agg.users[r.user_key] = { name: r.name, totalInputTokens: r.ti||0, totalOutputTokens: r.tout||0, totalRequests: r.tr||0, cacheCreationTokens: r.cc||0, cacheReadTokens: r.cr||0, lastActive: r.la };
  }
  // daily: GROUP BY date, user_key
  for (const r of db.prepare(`SELECT date, user_key, SUM(input_tokens) AS ti, SUM(output_tokens) AS tout, SUM(requests) AS tr, SUM(cache_creation) AS cc, SUM(cache_read) AS cr FROM usage_daily GROUP BY date, user_key`).all()) {
    if (!agg.daily[r.date]) agg.daily[r.date] = {};
    agg.daily[r.date][r.user_key] = { inputTokens: r.ti||0, outputTokens: r.tout||0, requests: r.tr||0, cacheCreationTokens: r.cc||0, cacheReadTokens: r.cr||0 };
  }
  // models: GROUP BY model
  for (const r of db.prepare(`SELECT model, SUM(tokens) AS t, SUM(requests) AS r FROM usage_model GROUP BY model`).all()) {
    agg.models[r.model] = { tokens: r.t||0, requests: r.r||0 };
  }
  // hourly: GROUP BY date, hour
  for (const r of db.prepare(`SELECT date, hour, SUM(requests) AS r, SUM(input_tokens) AS ti, SUM(output_tokens) AS tout, SUM(cache_creation) AS cc, SUM(cache_read) AS cr FROM usage_hourly GROUP BY date, hour`).all()) {
    if (!agg.hourly[r.date]) agg.hourly[r.date] = {};
    agg.hourly[r.date][r.hour] = { requests: r.r||0, inputTokens: r.ti||0, outputTokens: r.tout||0, cacheCreationTokens: r.cc||0, cacheReadTokens: r.cr||0 };
  }
  // dailyModels: GROUP BY date, user_key, model
  for (const r of db.prepare(`SELECT date, user_key, model, SUM(input_tokens) AS ti, SUM(output_tokens) AS tout, SUM(requests) AS tr FROM usage_daily_model GROUP BY date, user_key, model`).all()) {
    if (!agg.dailyModels[r.date]) agg.dailyModels[r.date] = {};
    if (!agg.dailyModels[r.date][r.user_key]) agg.dailyModels[r.date][r.user_key] = {};
    agg.dailyModels[r.date][r.user_key][r.model] = { inputTokens: r.ti||0, outputTokens: r.tout||0, requests: r.tr||0 };
  }
  // dailyHourly: GROUP BY date, user_key, hour
  for (const r of db.prepare(`SELECT date, user_key, hour, SUM(requests) AS r, SUM(input_tokens) AS ti, SUM(output_tokens) AS tout, SUM(cache_creation) AS cc, SUM(cache_read) AS cr FROM usage_daily_hourly GROUP BY date, user_key, hour`).all()) {
    if (!agg.dailyHourly[r.date]) agg.dailyHourly[r.date] = {};
    if (!agg.dailyHourly[r.date][r.user_key]) agg.dailyHourly[r.date][r.user_key] = {};
    agg.dailyHourly[r.date][r.user_key][r.hour] = { requests: r.r||0, inputTokens: r.ti||0, outputTokens: r.tout||0, cacheCreationTokens: r.cc||0, cacheReadTokens: r.cr||0 };
  }
  // errors: merge all profiles (most recent 200)
  agg.errors = db.prepare("SELECT time, user_name AS user, user_key AS userKey, status_code AS statusCode, error, path, model FROM errors ORDER BY id DESC LIMIT 200").all();
  return agg;
}

function getProfileSummaries() {
  const today = cnDate();
  return listProfiles().map(profile => {
    const runtime = runtimes[profile.suffix];
    const row = stmts.profileSummaryToday.get(profile.suffix, today);
    return {
      name: profile.name,
      suffix: profile.suffix,
      isDefault: profile.isDefault,
      billingType: profile.billingType,
      peakHours: normalizePeakHours(profile.peakHours),
      upstream: profile.upstream,
      userCount: profile.userCount,
      todayTokens: row.tokens || 0,
      todayRequests: row.requests || 0,
      breakerState: runtime?.breaker?.status().state || "UNKNOWN",
      rateLimit: getRateLimitInfo(profile.name),
      inDefaultGroup: profile.inDefaultGroup,
      groupOrder: profile.groupOrder,
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
  return `Model "${model}" is not allowed. Use jx-sonnet/jx-opus/jx-haiku or a model from the allowed list.`;
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
      out.push({ suffix: profile.suffix, name: profile.name, isDefault: profile.isDefault });
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

function isUnsupportedOpenAIPath(reqUrl) {
  const pathname = new URL(reqUrl || "/", "http://localhost").pathname;
  return pathname === "/v1/responses" || pathname.endsWith("/responses") ||
    pathname === "/v1/chat/completions" || pathname.endsWith("/chat/completions") ||
    pathname === "/v1/models" || pathname.endsWith("/models");
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
  const cacheRead = toTokenNumber(source.cache_read_input_tokens);
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
  const cacheR = toTokenNumber(usage.cache_read_input_tokens);
  const m = model || "unknown";

  pruneOldDataIfNewDay();

  const p = { profile: sfx, key, name: getUserName(key, runtime), inp, out, cacheC, cacheR, m, tokenTotal: inp + out, today, hour, now: new Date().toISOString() };
  const tx = db.transaction(() => {
    stmts.upsertUser.run(p);
    stmts.upsertDaily.run(p);
    stmts.upsertModel.run(p);
    stmts.upsertHourly.run(p);
    stmts.upsertDailyModel.run(p);
    stmts.upsertDailyHourly.run(p);
  });
  tx();
}

// ─── Token Quota ──────────────────────────────────────────────────────────────
function getProfileQuota(suffix) {
  const sfx = normalizeProfileSuffix(suffix) || getDefaultProfileSuffix();
  const rt0 = runtimes[sfx] || rt;
  if (!rt0) return 0;
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
  const sfx = normalizeProfileSuffix(suffix) || runtime?.suffix || "";
  const today = cnDate();
  const used = stmts.todayUsageForQuota.get(sfx, today, key).used;

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
  const defaultSuffix = profile.suffix;

  for (const [vk, pu] of Object.entries(profile.users)) {
    if (typeof pu !== "object") continue;
    const userQuota = pu.dailyTokenLimit;
    if (!userQuota || userQuota <= 0) continue; // skip users without quota

    // Check cooldown
    const lastAdjust = stmts.lastQuotaAdjust.get(vk);
    if (lastAdjust) {
      const lastDate = new Date(lastAdjust.date);
      const nowDate = new Date(today);
      const diffDays = Math.floor((nowDate - lastDate) / 86400000);
      if (diffDays < cooldownDays) continue;
    }

    // Count hit days and calculate average usage (one SQL query per user)
    const earliest = dates[dates.length - 1];
    const dayRows = stmts.defaultDailyForUser.all(defaultSuffix, vk, earliest).filter(r => dates.includes(r.date));
    let hitCount = 0;
    let totalUsage = 0;
    let usageDays = 0;
    for (const r of dayRows) {
      const dayUsage = (r.input_tokens||0)+(r.output_tokens||0);
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

    stmts.insertQuotaAdjust.run({
      user: vk, username: getUserName(vk), date: today, oldQuota: userQuota, newQuota,
      hitRate: Math.round(actualHitRate * 100) / 100, avgDailyUsage: Math.round(avgDaily),
      time: new Date().toISOString(),
    });
    stmts.trimQuotaAdjust.run();

    saveConfig(config);
    console.log(`[配额调整] ${getUserName(vk)} ${userQuota.toLocaleString()} → ${newQuota.toLocaleString()} (命中率${Math.round(actualHitRate * 100)}%, 均值${Math.round(avgDaily).toLocaleString()})`);
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

  // Per-model breakdown for today
  const todayModels = {};
  for (const r of stmts.profileDailyModelRows.all(suffix, today, key)) {
    todayModels[r.model] = { inputTokens: r.input_tokens, outputTokens: r.output_tokens, requests: r.requests, total: r.input_tokens + r.output_tokens };
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
    quota: { type: quota.source, limit: quota.limit, used: quota.used, remaining: quota.remaining, autoAdjusted: quotaAutoAdjusted },
    today: { input: todayUsage.inputTokens||0, output: todayUsage.outputTokens||0, requests: todayUsage.requests||0, cacheWrite: todayUsage.cacheCreationTokens||0, cacheRead: todayUsage.cacheReadTokens||0, total: totalUsageTokens(todayUsage) },
    models: todayModels,
    hourly: todayHourly,
    trend,
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
      if (!todayModels[r.model]) todayModels[r.model] = { inputTokens: 0, outputTokens: 0, requests: 0, total: 0 };
      todayModels[r.model].inputTokens += r.input_tokens || 0;
      todayModels[r.model].outputTokens += r.output_tokens || 0;
      todayModels[r.model].requests += r.requests || 0;
      todayModels[r.model].total += (r.input_tokens||0) + (r.output_tokens||0);
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
    totalQuotaUsed += quota.used || 0;
    if (quota.limit > 0) totalQuotaLimit += quota.limit;
    else hasUnlimitedQuota = true;
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
    },
    today: { input: todayUsage.inputTokens, output: todayUsage.outputTokens, requests: todayUsage.requests, cacheWrite: todayUsage.cacheCreationTokens || 0, cacheRead: todayUsage.cacheReadTokens || 0, total: totalUsageTokens(todayUsage) },
    models: todayModels,
    hourly: todayHourly,
    trend: Object.values(trendByDate).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function getPersonalUsageData(apiKey, requestedProfile = "all") {
  const availableProfiles = getAccessibleProfiles(apiKey);
  const username = getUserName(apiKey, rt) || apiKey.slice(0, 8);
  const profile = requestedProfile || "all";

  if (profile === "all") {
    return { username, availableProfiles, ...getAggregatedPersonalUsage(apiKey, availableProfiles) };
  }

  const suffix = normalizeProfileSuffix(profile);
  const runtime = runtimes[suffix];
  if (!runtime || !availableProfiles.some(p => p.suffix === suffix)) {
    const err = new Error(`User is not allowed to view profile "${profile}"`);
    err.statusCode = 403;
    throw err;
  }
  return { username, availableProfiles, ...getProfilePersonalUsage(apiKey, suffix, runtime) };
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
  if (isUnsupportedOpenAIPath(req.url)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "OpenAI endpoints are not supported. Use the Anthropic Messages API with Claude Code." }));
    return;
  }
  // Resolve which profile this request targets
  const resolvedProfile = resolveProfile(req.url);
  if (resolvedProfile.error) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: resolvedProfile.error }));
    return;
  }
  const { suffix, runtime, strippedUrl } = resolvedProfile;
  if (!runtime) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No configured proxy profile. Open Settings to configure an Anthropic upstream." }));
    return;
  }
  const apiKey = getApiKey(req);

  // Reject non-API requests (browser favicon, Chrome DevTools, etc.) before any group check.
  // These requests carry no auth header (apiKey === "unknown") and would otherwise be mis-logged
  // as "直连被拒" when the path falls through to a default-runtime group member.
  if (apiKey === "unknown") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  // Group members (default-profile-group with ≥2 entries) are reachable only via /v1,
  // which fails over across the group. Reject direct /<suffix>/... access so users can't
  // bypass failover to pin an expensive on-demand profile.
  const dpg = Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : [];
  if (config.restrictGroupSuffix !== false && !resolvedProfile.isDefaultEntry && dpg.length >= 2 && dpg.includes(runtime.profileName)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: {
        type: "group_member_restricted",
        message: `方案 "${runtime.profileName}" 是默认方案组成员，请通过 /v1 入口使用（系统按 failover 顺序自动调度）。`
      },
      hint: "Use /v1/messages instead."
    }));
    recordError(apiKey, 403, `group_member_restricted: /${suffix} 直连被拒，引导走 /v1`, req.url, "unknown", suffix, runtime);
    console.log(`[拦截] ${getUserName(apiKey, runtime)} 直连组内方案 /${suffix} 被拒 → 引导 /v1`);
    return;
  }

  const proxyStartTime = Date.now();
  let proxyPhase = "init";
  const clientState = createClientAbortState();

  // Global IP rate limit
  const clientIp = getClientIp(req);
  if (!checkIpRateLimit(clientIp)) {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
    res.end(JSON.stringify({ error: "IP rate limit exceeded. Please slow down.", type: "ip_rate_limit_exceeded" }));
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
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: earlyAccess.reason }));
    console.log(`[拦截] ${apiKey.slice(0, 8)}**** profile=${runtime.profileName} ${req.method} ${targetUrl} ${earlyAccess.reason}`);
    return;
  }

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
    } catch {}

    // Save the pre-resolve body so each failover candidate can re-resolve the model
    // against its own modelAliases.
    const originalBody = body;

    // Build the ordered candidate list. Default-group (/v1) entries fail over across
    // the whole group; explicit /<suffix>/... requests stay pinned to one profile.
    const candidateList = resolvedProfile.isDefaultEntry
      ? getAvailableDefaultProfiles(apiKey)
      : [{ name: runtime.profileName, suffix, runtime }];
    // If every default-group member is currently unavailable (all rate-limited / breaker
    // open / unauthorized), fall back to the resolved default so the normal error path runs.
    if (candidateList.length === 0) {
      candidateList.push({ name: runtime.profileName, suffix, runtime });
    }

    // Rate + concurrency are per-user, independent of which profile serves the request.
    if (!checkAndRecordRate(userKey)) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      res.end(JSON.stringify({ error: "Rate limit exceeded. Please slow down.", type: "rate_limit_exceeded" }));
      recordError(apiKey, 429, "rate_limit_exceeded", req.url, reqModel, suffix, runtime);
      return;
    }
    if (!tryAcquireConcurrency(userKey)) {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
      res.end(JSON.stringify({ error: "Too many concurrent requests. Please try again later.", type: "concurrency_exceeded" }));
      recordError(apiKey, 429, "concurrency_exceeded", req.url, reqModel, suffix, runtime);
      return;
    }

    let lastFailure = null;   // { kind, status?, message?, runtime, suffix, quota?, err? }
    let served = false;
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
          lastFailure = { kind: "model", status: 403, message: modelNotAllowedMessage(creqModel, cruntime), runtime: cruntime, suffix: csuffix };
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

        const quota = checkTokenQuota(apiKey, csuffix, cruntime);
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

          proxyPhase = isStreamRequest ? "streaming-proxy" : "json-proxy";
          const timeout = isStreamRequest ? gProxy.streamTimeout : gProxy.timeout;

          if (isStreamRequest) {
            await handleStreamingProxy(req, res, cbody, reqHeaders, apiKey, creqModel, timeout, reqSource, cruntime, csuffix, strippedUrl, clientState);
          } else {
            await handleJsonProxy(req, res, cbody, reqHeaders, apiKey, creqModel, timeout, reqSource, cruntime, csuffix, strippedUrl, clientState);
          }
          served = true;
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
          lastFailure = { kind: "proxy", status: err.isTimeout ? 504 : 502, err, runtime: cruntime, suffix: csuffix };
          if (!isLastCandidate) continue;
          break;
        }
      }

      // Every candidate failed: surface the last failure to the client.
      if (!served && lastFailure && !res.headersSent) {
        if (lastFailure.kind === "model") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: lastFailure.message }));
          console.log(`[拦截] ${apiKey.slice(0, 8)}**** profile=${lastFailure.runtime.profileName} model 拒绝`);
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
            error: `今日Token额度已用完。已用: ${q.used.toLocaleString()}, 限额: ${q.limit.toLocaleString()}。额度将于北京时间次日凌晨重置。查看用量详情: ${usageUrl}`,
            type: "quota_exceeded",
            quota: { used: q.used, limit: q.limit, remaining: q.remaining, source: q.source },
            usageUrl,
          }));
          recordError(apiKey, 429, `quota_exceeded: ${q.used}/${q.limit}, retry in ${retryAfter}s`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
        } else if (lastFailure.kind === "rate-limit") {
          const retryAfter = Math.max(1, Math.ceil((lastFailure.err.resumeAt - Date.now()) / 1000));
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfter) });
          res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: `所有可用方案均已限额，最早 ${new Date(lastFailure.err.resumeAt).toISOString()} 恢复。` } }));
          recordError(apiKey, 429, `all profiles rate-limited until ${new Date(lastFailure.err.resumeAt).toISOString()}`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
        } else {
          const status = lastFailure.status;
          const label = status === 504 ? "Gateway Timeout" : "Bad Gateway";
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Proxy ${label}. Please try again later.` }));
          recordError(apiKey, status, `${label}: ${lastFailure.err.message}`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
        }
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
      const rateLimitHit = classifyRateLimit(upRes.statusCode, text);
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
    function safeResolve() {
      if (!resolved) {
        resolved = true;
        cleanupClientAbort();
        cleanupUpstream();
        resolve();
      }
    }
    function safeReject(err) {
      if (!resolved) {
        resolved = true;
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

      // Plan-exhaustion 429: buffer the full body, then hand off to the failover
      // layer WITHOUT writing anything to the client — so the next profile can own
      // the response. A burst 429 (no plan-limit signal) is passed through instead.
      if (upRes.statusCode === 429) {
        let errBuf = "";
        upRes.on("data", (c) => { if (!clientGone) errBuf += c.toString(); });
        upRes.on("end", () => {
          const rl = classifyRateLimit(upRes.statusCode, errBuf);
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

      res.writeHead(upRes.statusCode, h);
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
          } catch {}
        }
      });

      upRes.on("end", () => {
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
          console.log(`[Token] ${getUserName(apiKey, runtime)} [${reqSource}] model=${model} 输入=${usage.input_tokens} 输出=${usage.output_tokens} 缓存写=${usage.cache_creation_input_tokens || 0} 缓存读=${usage.cache_read_input_tokens || 0}`);
        } else {
          console.log(`[响应] ${getUserName(apiKey, runtime)} 流结束 无usage数据 model=${model} sse行数=${sseDataLines} 原始数据[0:200]=${rawSample.slice(0, 200).replace(/\n/g, "\\n")}`);
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
      if (isClientAbortError(err) || clientState?.aborted) {
        console.log(`[取消] ${getUserName(apiKey, runtime)} 流式客户端断开 model=${reqModel}`);
        safeResolve();
        return;
      }
      runtime.breaker.recordFailure();
      const isTimeout = err.message.includes("timeout");
      const status = isTimeout ? 504 : 502;
      const label = isTimeout ? "Gateway Timeout" : "Bad Gateway";
      recordError(apiKey, status, `${label}: ${err.message}`, req.url, reqModel, suffix, runtime);
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
        dailyTokenLimit: isObj ? (v.dailyTokenLimit || 0) : 0,
      };
    }
  }
  const defaultSuffix = getDefaultProfileSuffix();
  const defaultProfile = config.profiles[getDefaultProfileName()];
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
    selectedProfileSuffix: defaultSuffix,
    circuitBreaker: rt?.breaker?.status() || { state: "UNKNOWN", failureCount: 0, totalSuccesses: 0, totalFailures: 0, cooldownRemaining: 0 },
    port: port,
    hasPassword: !!dashboardPassword,
    profileQuota: getProfileQuota(defaultSuffix),
    autoQuotaAdjust: config.autoQuotaAdjust || {},
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
  const nonMembersHtml = Object.keys(config.profiles).filter(n => !dpg.includes(n) && config.profiles[n].upstream).map(name => `<button type="button" class="preset" onclick="event.stopPropagation();addToDefaultGroup('${escJs(name)}')">+ ${escHtml(name)}</button>`).join("");

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

  // Profile user rows (key assignment)
  const profileUserRows = Object.entries(s.globalUsers).map(([k, v]) => {
    const isObj = typeof v === "object" && v !== null;
    const username = isObj ? (v.username || "") : (typeof v === "string" ? v : "");
    const globalDisabled = isObj ? !!v.disabled : false;
    const pu = initialAssignments[k];
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

  const aliasesText = formatModelAliasesInput(s.modelAliases || {});
  const peakAliasesText = formatModelAliasesInput(s.peakModelAliases || {});
  const settingsJson = JSON.stringify(s).replace(/</g, "\\x3c");

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>设置 - CC Team</title>
<style>
${UI_THEME}
${TOAST_CSS}
body{padding:0;overflow:hidden;height:100vh}
.layout{display:flex;height:100vh}
.sidebar{width:260px;min-width:260px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.sidebar-hd{min-height:64px;padding:16px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px}
.sidebar-hd h1{font-size:17px;font-weight:650;white-space:nowrap}
.sidebar-hd a{color:var(--dim);font-size:12px;text-decoration:none;white-space:nowrap}
.sidebar-hd a:hover{color:var(--text)}
.sidebar-list{flex:1;overflow-y:auto;padding:12px}
.sidebar-global{padding:10px 12px;border-top:1px solid var(--border);background:var(--surface)}
.sidebar-tool{display:block;width:100%;margin:0;text-align:left;font-family:var(--font-body)}
.sidebar-tool .pl-name,.sidebar-tool .pl-users{display:block}.sidebar-tool .pl-name{padding-right:0}
.sidebar-ft{padding:12px;border-top:1px solid var(--border);background:var(--surface)}
.pl-item{background:transparent;border:1px solid transparent;border-radius:6px;padding:11px 12px;margin-bottom:4px;position:relative;cursor:pointer}
.pl-item:hover{background:var(--surface-subtle)}
.pl-item.active{border-color:var(--border);background:var(--accent-soft)}
.pl-name{font-size:13px;font-weight:600;margin-bottom:3px;padding-right:74px}
.pl-host{font-size:11px;color:var(--dim);font-family:var(--font-mono);word-break:break-all;margin-bottom:3px}
.pl-users{font-size:11px;color:var(--dim)}
.pl-actions{display:none;position:absolute;top:8px;right:8px;gap:3px}
.pl-item:hover .pl-actions,.pl-item.active .pl-actions{display:flex}
.pl-activate,.pl-delete{font-size:10px;padding:3px 7px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--dim);cursor:pointer;white-space:nowrap}
.pl-activate:hover{border-color:var(--accent);color:var(--accent)}
.pl-delete:hover{border-color:#e5b8b2;color:var(--red);background:#fff5f3}
.pl-badge{font-size:10px;padding:2px 7px;border-radius:4px;background:var(--accent-soft);color:var(--accent);white-space:nowrap}
.main{flex:1;overflow-y:auto;padding:28px clamp(24px,4vw,56px);scrollbar-gutter:stable}
.main form,#dataManagementView{max-width:1180px;margin:0 auto}
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
.actions{position:fixed;left:260px;right:0;bottom:0;margin:0;padding:12px clamp(24px,4vw,56px) calc(12px + env(safe-area-inset-bottom));display:flex;gap:8px;justify-content:flex-end;background:rgba(255,255,255,.96);border-top:1px solid var(--border);backdrop-filter:blur(8px);z-index:40}
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
@media(max-width:680px){body{overflow:auto;height:auto}.layout{flex-direction:column;height:auto;min-height:100vh}.sidebar{width:100%;min-width:0;max-height:none;border-right:0;border-bottom:1px solid var(--border)}.sidebar-list{display:flex;gap:6px;overflow-x:auto}.sidebar-global{padding:8px 12px}.sidebar-tool{min-width:0}.pl-item{min-width:210px;margin:0}.main{overflow:visible;padding:22px 16px}.actions{left:0;padding-left:16px;padding-right:16px}.row,.row3{grid-template-columns:1fr}.modal{width:100%;max-height:90vh}.section{padding:15px;overflow-x:auto}.import-summary{grid-template-columns:1fr 1fr}.mapping-row{grid-template-columns:1fr}.mapping-arrow{display:none}.danger-copy{align-items:flex-start;flex-direction:column}}
</style></head><body data-theme="editorial-light">
<div class="layout">
<div class="sidebar">
<div class="sidebar-hd"><h1>配置方案</h1><a href="/dashboard">返回面板</a></div>
<div class="sidebar-list">${s.profiles.map(p => {
    const host = p.upstream.replace(/^https?:\/\//, "").replace(/\/.*/, "");
    const suffixLabel = '<span style="color:var(--accent);font-size:10px">/'+ escHtml(p.suffix)+'</span>' + (p.isDefault ? ' <span style="color:var(--green);font-size:10px">默认入口</span>' : '');
    const peakList = normalizePeakHours(p.peakHours);
    const peakLabel = peakList.length > 0
      ? `<div class="pl-users" style="${isInPeakHours(peakList) ? "color:var(--orange);font-weight:600" : ""}">${escHtml(formatPeakHoursSummary(peakList))}${isInPeakHours(peakList) ? " · 高峰中" : ""}</div>`
      : "";
    return `<div class="pl-item${p.suffix === initialSuffix ? " active" : ""}" id="pl-${escHtml(p.name)}" onclick="editProfile('${escJs(p.name)}')">
<div class="pl-name">${escHtml(p.name)} ${suffixLabel}</div>
<div class="pl-host">${escHtml(host)}</div>
<div class="pl-users">${p.userCount}位用户</div>
${peakLabel}
<div class="pl-actions">
  ${!p.isDefault ? '<button class="pl-activate" onclick="event.stopPropagation();setDefaultProfile(\'' + escJs(p.name) + '\')">设为默认</button>' : ''}
  ${!p.isDefault ? '<button class="pl-delete" onclick="event.stopPropagation();deleteProfile(\'' + escJs(p.name) + '\')">删除</button>' : ''}
</div></div>`;
  }).join("")}</div>
<div class="sidebar-global"><button type="button" class="pl-item sidebar-tool" id="dataManagementNav" onclick="openDataManagementView()"><span class="pl-name">全局数据管理</span><span class="pl-users">导入、备份与清空</span></button></div>
<div class="sidebar-global" style="padding:10px 12px">
  <div style="font-size:11px;font-weight:650;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
    <span>默认方案组 <span style="color:var(--dim);font-weight:400;font-size:10px">/v1 failover</span></span>
    <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:10px;font-weight:400;white-space:nowrap"><input type="checkbox" id="restrictGroupSuffixCb" ${config.restrictGroupSuffix !== false ? "checked" : ""} onchange="document.getElementById('restrictGroupSuffixHidden').value=this.checked?'on':'off'" style="width:auto;accent-color:var(--accent)"> 限制直连</label>
  </div>
  <div id="defaultGroupList" style="margin-bottom:6px">${groupItemsHtml || '<span style="font-size:11px;color:var(--dim)">组为空 — 至少加入 2 个方案以启用 failover</span>'}</div>
  ${nonMembersHtml ? `<div style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap"><span style="color:var(--dim);font-size:10px">加入：</span>${nonMembersHtml}</div>` : ''}
</div>
<div class="sidebar-ft" style="display:flex;gap:6px"><button class="btn btn-outline btn-sm" onclick="openUserModal()" style="flex:1">用户管理</button><button class="btn btn-outline btn-sm" onclick="openProfileModal()" style="flex:1">新增方案</button></div>
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
<div class="note" style="margin-top:8px">状态：${s.circuitBreaker.state === 'CLOSED' ? '正常运行' : s.circuitBreaker.state === 'HALF_OPEN' ? '探测恢复中' : s.circuitBreaker.state === 'OPEN' ? '熔断中(' + Math.ceil(s.circuitBreaker.cooldownRemaining / 1000) + 's)' : '等待配置上游'} | 失败 ${s.circuitBreaker.failureCount} | 成功 ${s.circuitBreaker.totalSuccesses} | 失败 ${s.circuitBreaker.totalFailures}</div>
</div>

<h2>模型别名</h2>
<div class="section">
<label>通用模型别名 (每行 alias=实际模型，可选)</label>
<textarea name="modelAliases" id="modelAliasesInput" rows="5" placeholder="jx-sonnet=glm-5.1&#10;jx-opus=glm-5.1&#10;jx-haiku=glm-5.1">${escHtml(aliasesText)}</textarea>
<div class="note">Claude Code 使用的 jx-sonnet、jx-opus、jx-haiku 与其他自定义别名都在此统一配置。留空表示直接使用请求中的模型名。</div>
<div class="presets">
  <span style="font-size:11px;color:var(--dim);line-height:24px">快速填充：</span>
  <button type="button" class="preset" onclick="fillAliases('deepseek-v4-pro','deepseek-v4-pro','deepseek-v4-flash')">DeepSeek</button>
  <button type="button" class="preset" onclick="fillAliases('claude-sonnet-4-6','claude-opus-4-5','claude-haiku-4-5')">Anthropic Claude</button>
  <button type="button" class="preset" onclick="fillAliases('glm-5.1','glm-5.1','glm-5.1')">智谱 GLM</button>
  <button type="button" class="preset" onclick="fillAliases('qwen-max','qwen-max','qwen-plus')">通义千问</button>
</div>
<label style="margin-top:14px">高峰期模型别名 (每行 alias=实际模型，可选)</label>
<textarea name="peakModelAliases" id="peakModelAliasesInput" rows="3" placeholder="jx-opus=glm-5.3-flash">${escHtml(peakAliasesText)}</textarea>
<div class="note">仅在下方「高峰时段」命中时生效（按北京时间判断）：这里配置的别名会覆盖上面的默认映射，未填写的别名沿用默认映射。可用来在高峰期把昂贵模型换成便宜的（如 jx-opus=glm-5.3-flash）。</div>
</div>

<h2>允许模型<span class="req">*必填</span></h2>
<div class="section">
<label>可用模型列表 (逗号分隔，至少1个)<span class="req">*必填</span></label>
<input type="text" name="allowedModels" id="allowedModelsInput" value="${(s.allowedModels || []).join(",")}" placeholder="必填，如: deepseek-v4-pro, deepseek-v4-flash" required>
<div class="note" id="allowedModelsNote">不在列表中的模型请求将被拦截返回403。所有别名目标模型会自动添加到此列表。</div>
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

<h2>每日Token配额 <span style="font-size:11px;color:var(--dim);font-weight:400">配额只计输入+输出（不含缓存），0=不限制，北京时间每日0点重置</span></h2>
<div class="section">
<label>方案每日总Token上限 (0=不限制)</label>
<input type="number" name="profileQuota" value="${s.profileQuota || 0}" min="0" step="100000" placeholder="0 = 不限制">
<div class="note">方案配额适用于该方案下所有用户。每个用户可以在用户管理弹窗中单独设置。</div>
</div>

<h2>高峰时段 <span style="font-size:11px;color:var(--dim);font-weight:400">每日重复的时间段（按北京时间判断，与部署服务器时区无关），命中时启用上方的「高峰期模型别名」</span></h2>
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
${((() => { const qa = stmts.quotaAdjustRecent.all(); return qa.length > 0 ? `<h4 style="font-size:13px;color:var(--accent);margin:16px 0 8px">调整历史</h4><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">时间</th><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">用户</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">旧配额</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">新配额</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">命中率</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">日均用量</th></tr></thead><tbody>${qa.map(h => `<tr><td style="padding:4px 8px">${h.date}</td><td style="padding:4px 8px">${h.user_name || h.user_key.slice(0, 8)}</td><td style="text-align:right;padding:4px 8px">${(h.old_quota || 0).toLocaleString()}</td><td style="text-align:right;padding:4px 8px;color:var(--green)">${(h.new_quota || 0).toLocaleString()}</td><td style="text-align:right;padding:4px 8px">${Math.round((h.hit_rate || 0) * 100)}%</td><td style="text-align:right;padding:4px 8px">${(h.avg_daily_usage || 0).toLocaleString()}</td></tr>`).join("")}</tbody></table>` : '<div class="note" style="margin-top:8px">暂无自动调整记录</div>'; })())}
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

<h2 style="color:var(--red)">危险操作</h2>
<div class="section danger-section">
  <div class="danger-copy"><div><strong>清空全部数据</strong><div class="note" style="margin:0">清除方案、用户、密钥、配额、统计、错误和导入记录。系统端口、后台密码与代理参数会保留，执行前自动创建备份。</div></div><button type="button" class="btn btn-danger" id="dataClearButton" onclick="openDataClearModal()">清空全部数据</button></div>
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
<div class="modal-overlay" id="profileModal">
<div class="modal" style="max-width:640px">
<div class="modal-hd"><h3>新增方案</h3><button class="modal-close" onclick="closeProfileModal()">关闭</button></div>
<div class="modal-body">
<div class="row">
<div><label>方案名称<span class="req">*</span></label><input type="text" id="newProfileName" placeholder="如: GLM 项目组"></div>
<div><label>URL 后缀<span class="req">*</span></label><input type="text" id="newProfileSuffix" placeholder="如: glm"></div>
</div>
<label>上游 API 地址<span class="req">*</span></label><input type="text" id="newProfileUpstream" value="${escHtml(initialProfile.upstream || s.upstream || "")}" placeholder="https://open.bigmodel.cn/api/anthropic">
<label>允许模型</label><input type="text" id="newProfileModels" value="${escHtml((initialProfile.allowedModels || s.allowedModels || []).join(","))}" placeholder="glm-5.1,qwen-max">
<label>模型别名（每行 alias=实际模型，可选）</label><textarea id="newProfileAliases" rows="3" placeholder="jx-sonnet=glm-5.1&#10;jx-opus=glm-5.1&#10;jx-haiku=glm-5.1"></textarea>
<div class="note">创建后会出现在左侧方案列表。默认入口可在左侧点击“设为默认”。</div>
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
const PAGE_CSRF="${CSRF_TOKEN}";
function getCsrf(){return PAGE_CSRF||(document.cookie.match(/tm_csrf=([^;]+)/)||[])[1]||''}
function csrfHeaders(h){h=h||{};h['x-csrf-token']=getCsrf();return h}
function h(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function aliasText(aliases){return Object.entries(aliases||{}).map(([a,m])=>a+'='+m).join('\\n')}
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
function openProfileModal(){document.getElementById('profileModal').classList.add('open');document.getElementById('newProfileName').focus()}
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
  if(!ranges.length){el.textContent='未设置时段';el.style.color='var(--dim)';return}
  if(nowInPeakHours(ranges)){el.textContent='当前处于高峰';el.style.color='var(--orange)'}
  else{el.textContent='当前不在高峰';el.style.color='var(--green)'}
}
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
  const view=document.getElementById('dataManagementView');
  form.hidden=true;
  view.hidden=false;
  view.setAttribute('aria-hidden','false');
  document.querySelectorAll('.pl-item').forEach(function(el){el.classList.remove('active')});
  document.getElementById('dataManagementNav').classList.add('active');
}
function showProfileSettings(){
  const form=document.getElementById('settingsForm');
  const view=document.getElementById('dataManagementView');
  form.hidden=false;
  view.hidden=true;
  view.setAttribute('aria-hidden','true');
  document.getElementById('dataManagementNav').classList.remove('active');
}
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
  const fm=document.forms.settingsForm;
  fm.upstream.value=p.upstream||'';
  document.getElementById('suffixInput').value=p.suffix||'';
  document.getElementById('profileNameInput').value=p.name||'';
  if(p.allowedModels)fm.allowedModels.value=p.allowedModels.join(', ');
  if(fm.modelAliases)fm.modelAliases.value=aliasText(p.modelAliases||{});
  if(fm.peakModelAliases)fm.peakModelAliases.value=aliasText(p.peakModelAliases||{});
  if(fm.profileQuota)fm.profileQuota.value=p.dailyTokenLimit||0;
  const bt=fm.querySelector('select[name="billingType"]');if(bt)bt.value=p.billingType||'on_demand';
  renderPeakHoursRows(p.peakHours||[]);
  document.querySelectorAll('.pl-item').forEach(el=>el.classList.remove('active'));
  const el=document.getElementById('pl-'+n);
  if(el)el.classList.add('active');
  document.getElementById('profileSuffixInput').value=p.suffix||'';
  const userSel=document.getElementById('userProfileSel');
  if(userSel){userSel.value=p.suffix||'';renderProfileUsers(p.suffix||'')}
  updateAccessUrl();
}
async function createProfile(){
  const name=document.getElementById('newProfileName').value.trim();
  const suffix=document.getElementById('newProfileSuffix').value.trim();
  const upstream=document.getElementById('newProfileUpstream').value.trim();
  const models=document.getElementById('newProfileModels').value.trim();
  const modelAliases=document.getElementById('newProfileAliases').value.trim();
  if(!name||!suffix||!upstream){alert('方案名称、URL 后缀和上游 API 地址必填');return}
  const fm=document.forms.settingsForm;
  const r=await fetch('/api/profile/save',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({
    profile:name,suffix:suffix,upstream:upstream,allowedModels:models||fm.allowedModels.value,
    modelAliases:modelAliases
  })});
  if(r.ok)toastThen('方案已创建',()=>location.reload());else{const e=await r.json();alert('创建失败: '+e.error)}
}
async function setDefaultProfile(n){
  const r=await fetch('/api/profile/default',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({profile:n})});
  if(r.ok)toastThen('已设为默认方案',()=>location.reload());else{const e=await r.json();alert('设置失败: '+e.error)}
}
async function deleteProfile(n){
  if(!confirm('确定删除方案 "'+n+'"？'))return;
  const r=await fetch('/api/profile/delete',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({profile:n})});
  if(r.ok)toastThen('方案已删除',()=>location.reload());else{const e=await r.json();alert('删除失败: '+e.error)}
}
async function saveDefaultGroup(group){
  const r=await fetch('/api/profile/default-group',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({group:group})});
  if(r.ok)toastThen('默认方案组已保存',()=>location.reload());else{const e=await r.json().catch(()=>({}));alert('保存失败: '+(e.error||''))}
}
function currentDefaultGroupFromDom(){return Array.prototype.map.call(document.querySelectorAll('#defaultGroupList .group-item'),function(el){return el.dataset.name})}
async function addToDefaultGroup(n){const g=currentDefaultGroupFromDom();if(!g.includes(n))g.push(n);saveDefaultGroup(g)}
async function removeFromDefaultGroup(n){saveDefaultGroup(currentDefaultGroupFromDom().filter(function(x){return x!==n}))}
async function moveDefaultGroup(n,d){const g=currentDefaultGroupFromDom();const i=g.indexOf(n);if(i<0)return;const j=i+d;if(j<0||j>=g.length)return;g.splice(i,1);g.splice(j,0,n);saveDefaultGroup(g)}
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
    const pu=assignments[k]||{};
    const realKey=pu.key||'';
    const profileDisabled=!!pu.disabled;
    const userQuota=pu.dailyTokenLimit||0;
    const rowStyle=globalDisabled?'opacity:0.4':'';
    return '<tr style="'+rowStyle+'">'
      +'<td><code style="font-size:11px;color:var(--accent)">'+h(k)+'</code></td>'
      +'<td>'+h(username)+'</td>'
      +'<td><input type="text" name="pu_rk_'+h(k)+'" value="'+h(realKey)+'" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px;font-family:monospace" placeholder="真实Key (留空=不可用此方案)"></td>'
      +'<td><input type="number" name="pu_quota_'+h(k)+'" value="'+h(userQuota)+'" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px" min="0" step="100000" placeholder="0=不限"></td>'
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
    const qInput=tr.querySelector('input[name^="pu_quota_"]');
    const qv=parseInt(qInput?qInput.value:'0',10)||0;
    profileUsers.push({key:vk,realKey:rkInput?rkInput.value.trim():'',disabled:disInput?disInput.checked:false,dailyTokenLimit:qv>0?qv:null});
  });
  const profileSuffix=document.getElementById('userProfileSel').value;
  const r=await fetch('/api/global-user/save',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({users,profileUsers,profileSuffix})});
  if(r.ok){toastThen('用户配置已保存',()=>location.reload())}else{const e=await r.json();alert('保存失败: '+e.error)}
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
function fillAliases(s,o,h){
  document.forms.settingsForm.modelAliases.value='jx-sonnet='+s+'\\njx-opus='+o+'\\njx-haiku='+h;
}
function fillUpstream(url){
  document.querySelector('[name=upstream]').value=url;
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
${UI_THEME}
${TOAST_CSS}
body{padding:16px clamp(14px,2vw,28px) 28px}
.dashboard-shell{width:100%;max-width:1560px;margin:0 auto;display:grid;gap:10px;min-width:0}
.command-bar{min-height:46px;display:flex;align-items:center;justify-content:space-between;gap:18px;padding-bottom:9px;border-bottom:1px solid var(--border);min-width:0;position:sticky;top:0;z-index:20;background:var(--canvas);padding-top:4px}
.command-brand{display:flex;align-items:center;gap:14px;min-width:0;white-space:nowrap}
.brand-mark{font-size:13px;font-weight:700;color:var(--accent)}
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
.chart-workspace{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(2,minmax(0,1fr));gap:8px;min-height:480px}
.chart-panel{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px 12px;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.chart-trend{grid-column:1;grid-row:1}.chart-users{grid-column:2;grid-row:1}.chart-models{grid-column:1;grid-row:2}.chart-hourly{grid-column:2;grid-row:2}
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
@media(max-width:1279px), (max-height:799px){.dashboard-shell{height:auto}.chart-workspace{grid-template-rows:repeat(2,280px);max-height:none}.data-workspace{height:auto;min-height:440px}.workspace-panel{min-height:400px}.workspace-panel.active{display:flex}}
@media(max-width:820px){.command-bar{align-items:flex-start;flex-direction:column;position:static;background:transparent;padding-top:0}.command-brand{width:100%;flex-wrap:wrap}.meta{order:3;width:100%;white-space:normal}.controls{width:100%}.metric-strip{grid-template-columns:repeat(3,1fr)}.chart-workspace{grid-template-columns:1fr;grid-template-rows:repeat(4,240px)}.chart-trend,.chart-users,.chart-models,.chart-hourly{grid-column:1;grid-row:auto}.detail-tools{grid-template-columns:1fr 1fr}.detail-search{grid-column:1/-1}.detail-reset{width:100%}}
@media(max-width:560px){body{padding:12px 10px 24px}.command-title{border-right:0;padding-right:0}.command-status{width:100%}.controls select{flex:1;min-width:150px}.metric-strip{grid-template-columns:1fr 1fr}.card{min-height:64px;padding:10px}.card .v{font-size:19px}.chart-head{align-items:flex-start}.chart-trend .chart-head{flex-direction:column}.workspace-tab{padding:0 12px}.detail-tools{padding:8px}.detail-table-wrap{max-height:500px}#dTable .detail-sticky{min-width:190px}.detail-pages{justify-content:space-between}}
</style></head><body data-theme="editorial-light">
<main class="dashboard-shell">
<header class="command-bar">
  <div class="command-brand"><span class="brand-mark">CC Team</span><h1 class="command-title">团队用量</h1><span class="command-status"><span class="led on"></span>监控服务运行中</span><span class="meta" id="meta">正在加载数据</span></div>
  <div class="controls"><select id="profileSel" aria-label="查看方案" onchange="switchProfileView(this.value)"><option value="">全部方案</option></select><a href="/settings">设置</a><button id="autoRefreshBtn" class="ar-on">自动刷新：开</button><button onclick="fetch('/api/logout',{method:'POST',headers:{'x-csrf-token':(document.cookie.match(/tm_csrf=([^;]+)/)||[])[1]||''}}).then(()=>toastThen('已退出登录',()=>location.reload()))">退出</button></div>
</header>
<section class="metric-strip" id="cards" aria-label="用量摘要"></section>
<section class="chart-workspace" aria-label="用量图表">
  <div class="chart-panel chart-trend"><div class="chart-head"><h2>Token 用量趋势</h2><div class="tabs" id="tabs" aria-label="统计周期">
    <button class="tab on" data-p="day">按日</button><button class="tab" data-p="week">按周</button><button class="tab" data-p="month">按月</button><button class="tab" data-p="year">按年</button>
  </div></div><div class="chart-canvas"><canvas id="trend"></canvas></div></div>
  <div class="chart-panel chart-users"><div class="chart-head"><h2>用户分布</h2></div><div class="chart-canvas"><canvas id="pie"></canvas></div></div>
  <div class="chart-panel chart-models"><div class="chart-head"><h2>模型请求分布</h2></div><div class="chart-canvas"><canvas id="modelChart"></canvas></div></div>
  <div class="chart-panel chart-hourly"><div class="chart-head"><h2>24 小时趋势</h2></div><div class="chart-canvas"><canvas id="hourChart"></canvas></div></div>
</section>
<section class="data-workspace" aria-label="数据工作区">
  <div class="workspace-tabs" role="tablist" aria-label="数据视图">
    <button id="workspace-tab-users" role="tab" aria-controls="workspace-panel-users" aria-selected="true" tabindex="0" class="workspace-tab">用户用量<span class="workspace-tab-count" id="workspaceCountUsers">0</span></button>
    <button id="workspace-tab-detail" role="tab" aria-controls="workspace-panel-detail" aria-selected="false" tabindex="-1" class="workspace-tab">明细记录<span class="workspace-tab-count" id="workspaceCountDetail">0</span></button>
    <button id="workspace-tab-profiles" role="tab" aria-controls="workspace-panel-profiles" aria-selected="false" tabindex="-1" class="workspace-tab">方案中心<span class="workspace-tab-count" id="workspaceCountProfiles">0</span></button>
    <button id="workspace-tab-errors" role="tab" aria-controls="workspace-panel-errors" aria-selected="false" tabindex="-1" class="workspace-tab">错误记录<span class="workspace-tab-count" id="workspaceCountErrors">0</span></button>
  </div>
  <div class="workspace-content">
    <section id="workspace-panel-users" role="tabpanel" aria-labelledby="workspace-tab-users" class="workspace-panel active"><div class="workspace-panel-scroll"><table id="uTable"><thead>
      <tr><th>用户</th><th>状态</th><th class="n">请求数</th><th class="n">输入</th><th class="n">输出</th><th class="n">缓存写入</th><th class="n">缓存命中</th><th class="n">合计</th><th class="n">今日</th><th class="n">配额</th><th>最后活跃</th></tr>
    </thead><tbody></tbody></table></div></section>
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
let D=null,P="day",C={t:null,p:null,m:null,h:null},errPage=1,autoRefresh=true,refreshTimer=null,currentProfile="all";
let activeWorkspaceTab="users";
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
function c(l,v,cl,k){return'<div class="card"><div class="l">'+l+'</div><div class="v" data-cu="'+v+'"'+(k?' data-cu-k':'')+'>0</div></div>'}
let chartResizeFrame=0;
function doughnutLegend(){const compact=innerWidth<1280;return{position:"bottom",labels:{color:"#686863",font:{size:compact?10:11},padding:compact?6:10,boxWidth:compact?16:24}}}
function trendLegend(){const compact=innerWidth<=820;return{labels:{color:"#686863",font:{size:compact?9:11},padding:compact?6:10,boxWidth:compact?16:40}}}
function scheduleChartResize(){cancelAnimationFrame(chartResizeFrame);chartResizeFrame=requestAnimationFrame(()=>{for(const chart of[C.p,C.m]){if(chart){chart.options.plugins.legend={display:false};chart.update("none")}}if(C.t){C.t.options.plugins.legend=trendLegend();C.t.update("none")}Object.values(C).forEach(chart=>chart&&chart.resize())})}
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
}
function maskDetailKey(key){const value=String(key||"");return value.length<=12?value:value.slice(0,8)+"****"+value.slice(-4)}
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
function render(){
  if(!D)return;
  // Populate profile dropdown
  const sel=document.getElementById("profileSel");
  if(sel.options.length<=1 && D.profiles){
    sel.innerHTML='<option value="all">全部方案</option>';
    for(const p of D.profiles){
      const sfx="/"+p.suffix+(p.isDefault?" · 默认入口":"");
      sel.innerHTML+='<option value="'+escH(p.suffix)+'">'+escH(p.name)+' '+sfx+'</option>';
    }
    sel.value=currentProfile==="all"?"all":currentProfile;
  }
  const us=Object.values(D.users),allTokens=us.reduce((s,u)=>s+totalTokens(u),0),tr=us.reduce((s,u)=>s+u.totalRequests,0);
  const td=new Date(Date.now()+8*36e5).toISOString().slice(0,10),tdd=(D.daily||{})[td]||{};
  const todayTokens=Object.values(tdd).reduce((s,d)=>s+totalTokens(d),0),tR=Object.values(tdd).reduce((s,d)=>s+d.requests,0);
  document.getElementById("cards").innerHTML=c("今日用量",todayTokens,"var(--accent)",1)+c("今日请求",tR,"var(--blue)",1)+c("总用量",allTokens,"var(--green)",1)+c("总请求",tr,"var(--orange)",1)+c("今日错误",(Array.isArray(D.errors)?D.errors:[]).filter(e=>e.time&&e.time.startsWith(td)).length,"var(--red)",1);
  runCountUps(document.getElementById("cards"));
  const psb=document.getElementById("profileSummaryBody"),profiles=Array.isArray(D.profileSummaries)?D.profileSummaries:[];
  psb.innerHTML=profiles.length?profiles.map(p=>{const st=p.breakerState||"UNKNOWN";const rl=p.rateLimit;let col,led,stateLabel;if(rl){col='var(--red)';led='err';const rm=new Date(rl.resumeAt);stateLabel='限额中 '+String(rm.getHours()).padStart(2,'0')+':'+String(rm.getMinutes()).padStart(2,'0')+'恢复';}else{col=st==="CLOSED"?"var(--green)":st==="HALF_OPEN"?"var(--orange)":"var(--red)";led=st==="CLOSED"?"on":st==="HALF_OPEN"?"warn":"err";stateLabel=st==="CLOSED"?"正常":st==="HALF_OPEN"?"探测中":"熔断";}const current=currentProfile!=="all"&&p.suffix===currentProfile;const gBadge=p.inDefaultGroup?' <span style="color:var(--blue);font-size:10px;font-weight:600">默认组·'+(p.groupOrder+1)+'</span>':'';const bLabel=p.billingType==='coding_plan'?' <span style="color:var(--dim);font-size:10px">CP</span>':p.billingType==='token_plan'?' <span style="color:var(--dim);font-size:10px">TP</span>':'';const pk=(p.peakHours&&p.peakHours.length)?(function(rs){const now=new Date(),cur=((now.getTime()+8*3600000)%86400000)/60000;const tm=function(t){if(!t)return null;const a=t.split(':');return (+a[0])*60+(+a[1])};const inPk=rs.some(function(r){const s=tm(r.start),e=tm(r.end);return s!==null&&e!==null&&s!==e&&(s<e?(cur>=s&&cur<e):(cur>=s||cur<e))});return ' <span style="color:'+(inPk?'var(--orange)':'var(--dim)')+';font-size:10px" title="高峰时段(北京时间) '+rs.map(function(r){return r.start+'-'+r.end}).join(', ')+'">'+(inPk?'高峰中':rs.map(function(r){return r.start+'-'+r.end}).join(','))+'</span>'})(p.peakHours):'';const restricted=p.inDefaultGroup&&profiles.filter(x=>x.inDefaultGroup).length>=2;return'<tr'+(current?' class="profile-current" aria-current="true"':'')+'><td>'+escH(p.name)+(p.isDefault?' <span style="color:var(--green);font-size:11px;font-weight:600;vertical-align:middle">默认</span>':'')+gBadge+bLabel+pk+(current?' <span class="current-mark">当前</span>':'')+'</td><td>'+(restricted?'<code>/v1</code> <span style="color:var(--dim);font-size:10px">仅 /v1</span>':'<code>/'+escH(p.suffix)+'</code>'+(p.isDefault?' <span style="color:var(--dim)"> / <code>/v1</code></span>':''))+'</td><td style="font-size:12px;color:var(--dim);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escH((p.upstream||'').replace('https://','').replace('http://',''))+'</td><td class="n">'+fmtT(p.todayRequests||0)+'</td><td class="n hl">'+fmtT(p.todayTokens||0)+'</td><td><span class="led '+led+'"></span><span style="color:'+col+';font-size:12px">'+stateLabel+'</span></td></tr>'}).join(''):'<tr><td colspan="6" class="empty">暂无方案</td></tr>';
  const profileLabel=D.profileView||(currentProfile==="all"?"全部方案":"默认方案");
  document.getElementById("profileContext").textContent="当前查看："+profileLabel;
  const upstreamInfo=D.upstream?(" | 上游: "+D.upstream.replace("https://","").replace("http://","")):"";
  document.getElementById("meta").innerHTML='<span style="color:var(--accent);font-weight:600">方案: '+profileLabel+'</span>'+upstreamInfo+' &nbsp;|&nbsp; 更新于 '+(function(){const d=new Date();const utc=d.getTime()+d.getTimezoneOffset()*60000;return new Date(utc+8*3600000).toLocaleTimeString("zh-CN")})()+" (北京时间) | 每30秒刷新";

  // Charts
  const g=grp(D.daily||{},P),keys=Object.keys(g).sort(),uks=Object.keys(D.users);
  if(C.t)C.t.destroy();if(C.p)C.p.destroy();if(C.m)C.m.destroy();if(C.h)C.h.destroy();
  C.t=new Chart(document.getElementById("trend"),{type:"bar",data:{labels:keys.map(k=>lbl(P,k)),datasets:uks.map((u,i)=>({label:D.users[u].name,data:keys.map(k=>totalTokens(g[k][u])),backgroundColor:COL[i%COL.length]+"cc",borderRadius:3,borderSkipped:false}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:trendLegend(),tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{stacked:true,ticks:{color:"#686863",font:{size:10}},grid:{color:"rgba(24,24,22,.08)"}},y:{stacked:true,ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});
  const tot=uks.map(u=>{let t=0;for(const k of keys)t+=totalTokens(g[k][u]);return t});
  // 用户分布：横向柱状图，Y 轴显示用户名完整可读。
  const uIdx=tot.map((_,i)=>i).sort((a,b)=>tot[b]-tot[a]);
  C.p=new Chart(document.getElementById("pie"),{type:"bar",data:{labels:uIdx.map(i=>D.users[uks[i]].name),datasets:[{label:"总 Token",data:uIdx.map(i=>tot[i]),backgroundColor:uIdx.map((_,i)=>COL[i%COL.length]+"cc"),borderWidth:0,borderRadius:3,borderSkipped:false}]},options:{indexAxis:"y",responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>fmtT(ctx.raw)+" tokens"}}},scales:{x:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}},y:{ticks:{color:"#686863",font:{size:11},autoSkip:false},grid:{display:false}}}}});

  // 历史缓存没有模型维度，模型分布使用准确的请求数。横向柱状图便于读取模型名。
  const mods=D.models||{};const mNames=Object.keys(mods);
  const mReq=mNames.map(m=>mods[m].requests||0);
  const mIdx=mReq.map((_,i)=>i).sort((a,b)=>mReq[b]-mReq[a]);
  C.m=new Chart(document.getElementById("modelChart"),{type:"bar",data:{labels:mIdx.map(i=>mNames[i]),datasets:[{label:"请求数",data:mIdx.map(i=>mReq[i]),backgroundColor:mIdx.map((_,i)=>COL[i%COL.length]+"cc"),borderWidth:0,borderRadius:3,borderSkipped:false}]},options:{indexAxis:"y",responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>fmtT(ctx.raw)+" 次请求"}}},scales:{x:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}},y:{ticks:{color:"#686863",font:{size:11},autoSkip:false},grid:{display:false}}}}});

  // 24小时趋势图
  const hrs=[];for(let i=0;i<24;i++)hrs.push(i.toString().padStart(2,"0")+":00");
  const todayHourly=(D.hourly||{})[td]||{};
  const hReq=hrs.map((_,i)=>{const h=todayHourly[i.toString().padStart(2,"0")];return typeof h==="object"?(h.requests||0):0});
  const hTokens=hrs.map((_,i)=>{const h=todayHourly[i.toString().padStart(2,"0")];return typeof h==="object"?totalTokens(h):0});
  C.h=new Chart(document.getElementById("hourChart"),{type:"line",data:{labels:hrs,datasets:[{label:"请求数",data:hReq,borderColor:"#2f6e50",backgroundColor:"rgba(47,110,80,.12)",fill:true,tension:.28,pointRadius:2,pointBackgroundColor:"#2f6e50",pointHoverRadius:4,borderWidth:2,yAxisID:"y"},{label:"总 Token",data:hTokens,borderColor:"#181816",backgroundColor:"rgba(24,24,22,.08)",fill:true,tension:.28,pointRadius:2,pointBackgroundColor:"#181816",pointHoverRadius:4,borderWidth:2,yAxisID:"y1"}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:{labels:{color:"#686863",font:{size:11},usePointStyle:true,pointStyle:"circle"}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{ticks:{color:"#686863",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{type:"linear",position:"left",ticks:{color:"#2f6e50"},grid:{color:"rgba(24,24,22,.08)"},title:{display:true,text:"请求数",color:"#2f6e50",font:{size:10}}},y1:{type:"linear",position:"right",ticks:{color:"#181816",callback:v=>fmtTk(v)},grid:{drawOnChartArea:false},title:{display:true,text:"Tokens",color:"#181816",font:{size:10}}}}}});

  // User table
  const ut=document.querySelector("#uTable tbody");
  const ul=Object.entries(D.users).sort((a,b)=>totalTokens(b[1])-totalTokens(a[1]));
  if(!ul.length){ut.innerHTML='<tr><td colspan="11" class="empty">暂无数据</td></tr>'}else{ut.innerHTML=ul.map(([uk,u],idx)=>{const on=u.lastActive&&Date.now()-new Date(u.lastActive).getTime()<36e5;const uq=(D.userQuotas||{})[uk]||D.profileQuota||0;const td2=(D.daily||{})[td]||{};const tdu=td2[uk]||{};const used=ioTokens(tdu);const qPct=uq>0?Math.min(100,Math.round(used/uq*100)):0;const rank='<span class="rank">'+(idx+1)+'.</span>';const qCell=uq>0?'<span style="color:var(--accent);font-size:12px">'+qPct+'%</span> '+quotaBar(qPct):'<span style="color:var(--dim)">-</span>';return'<tr><td>'+rank+escH(u.name)+'</td><td><span class="led '+(on?'on':'')+'"></span><span style="color:'+(on?'var(--green)':'var(--dim)')+';font-size:12px">'+(on?'在线':'离线')+'</span></td><td class="n">'+fmtT(u.totalRequests)+'</td><td class="n">'+fmtT(u.totalInputTokens)+'</td><td class="n">'+fmtT(u.totalOutputTokens)+'</td><td class="n">'+fmtT(u.cacheCreationTokens || 0)+'</td><td class="n">'+fmtT(u.cacheReadTokens || 0)+'</td><td class="n hl">'+fmtT(ioTokens(u))+'</td><td class="n">'+fmtT(ioTokens(tdu))+'</td><td class="n" style="white-space:nowrap">'+qCell+'</td><td style="font-size:12px;color:var(--dim)">'+ago(u.lastActive)+'</td></tr>'}).join("")}

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
}
async function load(){try{const profile=currentProfile==="all"?"all":currentProfile;const r=await fetch("/api/stats"+(profile?"?profile="+encodeURIComponent(profile):""));D=await r.json();render()}catch(e){document.getElementById("meta").textContent="Error: "+e.message}}
function toggleSec(id){const body=document.getElementById(id+"Body");const icon=document.getElementById(id+"Icon");const open=body.classList.toggle("open");icon.classList.toggle("open",open)}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("on"));b.classList.add("on");P=b.dataset.p;resetDetailGrouping();render()}));
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
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>登录 - CC Team</title>
<style>
${UI_THEME}
${TOAST_CSS}
body{display:flex;justify-content:center;align-items:center;min-height:100vh;padding:24px}
.wrap{width:100%;max-width:390px}
.brand{margin-bottom:22px}.brand .t{font-size:24px;font-weight:650;margin-bottom:7px}.brand .s{font-size:13px;color:var(--dim)}
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
<div class="brand"><div class="t">CC Team</div><div class="s">团队 AI 编码用量网关</div></div>
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
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>我的用量</title>
<style>
${UI_THEME}
${TOAST_CSS}
body{display:flex;justify-content:center;align-items:center;min-height:100vh;padding:24px;margin:0}
.wrap{width:100%;max-width:440px}.brand{margin-bottom:22px}.brand .t{font-size:24px;font-weight:650;margin-bottom:7px}.brand .s{font-size:13px;color:var(--dim)}
.term{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:26px}.term .hd{font-size:13px;font-weight:600;margin-bottom:18px;color:var(--text)}
.term label{display:block;font-size:12px;font-weight:550;color:var(--dim);margin-bottom:6px}.term input{width:100%;padding:11px 12px;background:var(--surface);border:1px solid var(--border-strong);border-radius:5px;color:var(--text);font-size:14px;font-family:var(--font-mono);outline:none;margin-bottom:18px}.term input:focus{border-color:var(--accent)}
.term button{width:100%;padding:11px 12px;background:var(--text);color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer}.term button:hover{background:#33332f}
.note{font-size:12px;color:var(--dim);text-align:center;margin-top:14px}.note code{color:var(--accent);font-family:var(--font-mono)}
</style></head><body data-theme="editorial-light">
<div class="wrap">
<div class="brand"><div class="t">我的用量</div><div class="s">输入虚拟 Key 查看个人配额与消耗。</div></div>
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

function personalUsageHtml(virtualKey) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>我的用量 - 团队AI Coding监控</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
${UI_THEME}
${TOAST_CSS}
body{padding:28px clamp(18px,3vw,44px) 48px}
body>div{max-width:1120px;margin-left:auto;margin-right:auto}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-bottom:14px;padding-bottom:20px;border-bottom:1px solid var(--border)}
.top h1{font-size:28px;font-weight:650;line-height:1.15;margin-bottom:7px}.top .sub{font-size:12px;color:var(--dim)}
select{font-size:12px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:5px;padding:7px 10px;cursor:pointer}select:hover{background:var(--surface-subtle)}select:focus{border-color:var(--accent)}
.meta{font-size:12px;color:var(--dim);margin-bottom:18px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:20px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:15px 16px;min-height:88px}.card:first-child{border-top:2px solid var(--accent)}
.card .l{font-size:11px;font-weight:550;color:var(--dim);margin-bottom:12px}.card .v{font-size:22px;line-height:1;font-weight:650;font-variant-numeric:tabular-nums;color:var(--text)!important}
.box{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:17px;margin-bottom:14px;overflow-x:auto}.box h3{font-size:13px;font-weight:650;color:var(--text);margin-bottom:12px}.box canvas{max-height:220px}
table{width:100%;border-collapse:collapse;min-width:560px}th{text-align:left;padding:9px 12px;font-size:11px;font-weight:550;color:var(--dim);border-bottom:1px solid var(--border);white-space:nowrap}td{padding:9px 12px;font-size:12px;border-bottom:1px solid #ecece8;white-space:nowrap}.n{text-align:right;font-variant-numeric:tabular-nums}tbody tr:hover td{background:#fafaf7}.tag{font-size:10px;background:var(--accent-soft);color:var(--accent);padding:2px 6px;border-radius:4px}
@media(max-width:560px){body{padding:20px 14px 36px}.top h1{font-size:24px}.cards{grid-template-columns:1fr 1fr}.card .v{font-size:20px}.box{padding:14px}}
</style></head><body data-theme="editorial-light">
<div class="top"><div><h1>我的用量</h1><div class="sub">查看个人配额、趋势和模型明细</div></div><select id="profileSel" onchange="switchProfile(this.value)"><option value="all">全部可用方案</option></select></div>
<div class="meta" id="meta">加载中...</div>
<div class="cards" id="cards"></div>
<div class="box"><h3>今日24小时趋势</h3><canvas id="hourChart"></canvas></div>
<div class="box"><h3>近7天趋势</h3><canvas id="trendChart"></canvas></div>
<div class="box"><h3>今日模型请求</h3><table id="modelTable"><thead><tr><th>模型</th><th class="n">请求数</th></tr></thead><tbody></tbody></table></div>
<script>
${UI_HELPERS}
${TOAST_JS}
Chart.defaults.color='#686863';Chart.defaults.font.family='-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Microsoft YaHei","Segoe UI",sans-serif';Chart.defaults.font.size=11;
const VK='${escJs(virtualKey)}';
let D=null,C={h:null,t:null},currentProfile='all';
const fmtT=n=>n.toLocaleString("zh-CN");
const fmtTk=n=>{if(n>=1e6)return(n/1e6).toFixed(1)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return n.toString()};
const COL=["#2f6e50","#4a6fa5","#c2604f","#c4a23a","#7a6bb0","#d4824a","#4a9ba8","#c47a99","#6ba368","#5a6bc4","#8a6db5","#5a9b8e"];
async function load(){
  try{
    const r=await fetch('/api/my-usage?profile='+encodeURIComponent(currentProfile),{headers:{'Authorization':'Bearer '+VK}});
    if(!r.ok){document.getElementById('meta').textContent='认证失败';return}
    D=await r.json();render();
  }catch(e){document.getElementById('meta').textContent='Error: '+e.message}
}
function switchProfile(v){currentProfile=v||'all';load()}
function render(){
  if(!D)return;
  const sel=document.getElementById('profileSel');
  if(sel.options.length<=1){
    sel.innerHTML='<option value="all">全部可用方案</option>'+(D.availableProfiles||[]).map(p=>'<option value="'+p.suffix+'">'+p.name+' /'+p.suffix+(p.isDefault?' · 默认入口':'')+'</option>').join('');
  }
  sel.value=currentProfile;
  const q=D.quota,t=D.today;
  const pct=q.limit>0?Math.min(100,Math.round(q.used/q.limit*100)):0;
  const color=pct>90?'var(--red)':pct>70?'var(--orange)':'var(--green)';
  document.getElementById('meta').innerHTML=D.username+' · 方案: '+D.profile+(q.limit>0?' · <span style="color:'+color+'">'+pct+'% 已用</span> '+hpBar(pct,16)+(q.autoAdjusted?' <span class="tag">AUTO</span>':''):' · 无配额限制');
  document.getElementById('cards').innerHTML=
    '<div class="card"><div class="l">今日用量 <span style="font-size:9px;color:var(--dim);font-weight:400">输入+输出</span></div><div class="v" data-cu="'+ioTokens(t)+'" data-cu-k style="color:var(--accent)">0</div></div>'+
    '<div class="card"><div class="l">今日请求</div><div class="v" data-cu="'+t.requests+'" data-cu-k style="color:var(--blue)">0</div></div>'+
    (q.limit>0?'<div class="card"><div class="l">剩余额度</div><div class="v" data-cu="'+q.remaining+'" data-cu-k style="color:'+color+'">0</div><div style="margin-top:8px">'+hpBar(pct,16)+'</div></div>'+
    '<div class="card"><div class="l">每日限额</div><div class="v" data-cu="'+q.limit+'" data-cu-k style="color:var(--dim)">0</div></div>':'')+
    '<div class="card"><div class="l">今日输入</div><div class="v" data-cu="'+t.input+'" data-cu-k style="color:var(--green)">0</div></div>'+
    '<div class="card"><div class="l">今日输出</div><div class="v" data-cu="'+t.output+'" data-cu-k style="color:var(--orange)">0</div></div>'+
    '<div class="card"><div class="l">今日缓存写入</div><div class="v" data-cu="'+t.cacheWrite+'" data-cu-k>0</div></div>'+
    '<div class="card"><div class="l">今日缓存命中</div><div class="v" data-cu="'+t.cacheRead+'" data-cu-k>0</div></div>';
  runCountUps(document.getElementById('cards'));
  // Hourly chart
  const hrs=[];for(let i=0;i<24;i++)hrs.push(i.toString().padStart(2,"0")+":00");
  const hData=hrs.map((_,i)=>{const h=D.hourly[i.toString().padStart(2,"0")]||{};return{req:h.requests||0,tokens:ioTokens(h)}});
  if(C.h)C.h.destroy();
  C.h=new Chart(document.getElementById("hourChart"),{type:"bar",data:{labels:hrs,datasets:[{label:"Token(输入+输出)",data:hData.map(d=>d.tokens),backgroundColor:COL[0]+"cc",borderRadius:3},{label:"请求数",data:hData.map(d=>d.req),backgroundColor:COL[1]+"cc",borderRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:"#686863",font:{size:10}}}},scales:{x:{ticks:{color:"#686863",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});
  // Trend chart
  if(C.t)C.t.destroy();
  C.t=new Chart(document.getElementById("trendChart"),{type:"line",data:{labels:D.trend.map(d=>d.date.slice(5)),datasets:[{label:"总Token(含缓存)",data:D.trend.map(d=>d.total),borderColor:COL[0],backgroundColor:"rgba(47,110,80,.12)",fill:true,tension:.28,pointRadius:2,borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:"#686863",font:{size:10}}}},scales:{x:{ticks:{color:"#686863"},grid:{display:false}},y:{ticks:{color:"#686863",callback:v=>fmtTk(v)},grid:{color:"rgba(24,24,22,.08)"}}}}});
  // Model table
  const mt=document.querySelector("#modelTable tbody");
  const models=Object.entries(D.models||{}).sort((a,b)=>b[1].requests-a[1].requests);
  if(!models.length){mt.innerHTML='<tr><td colspan="2" style="text-align:center;color:var(--dim)">暂无数据</td></tr>'}else{
    mt.innerHTML=models.map(([m,d])=>'<tr><td style="color:var(--blue)">'+m+'</td><td class="n">'+fmtT(d.requests)+'</td></tr>').join("");
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
      for (const table of ["users", "usage_daily", "usage_daily_model", "usage_daily_hourly", "usage_model", "usage_hourly", "errors"]) {
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

  // Update profile quota
  if (formData.profileQuota !== undefined) {
    const q = parseInt(formData.profileQuota, 10) || 0;
    editingProfile.dailyTokenLimit = q > 0 ? q : null;
  }

  // Update billing type (display label, drives no logic)
  if (formData.billingType && ["coding_plan", "token_plan", "on_demand"].includes(formData.billingType)) {
    editingProfile.billingType = formData.billingType;
  }

  // Update peak hours (display-only recurring daily time ranges)
  if (formData.peakStart !== undefined) {
    const starts = [].concat(formData.peakStart);
    const ends = [].concat(formData.peakEnd);
    editingProfile.peakHours = normalizePeakHours(starts.map((s, i) => ({ start: s, end: ends[i] })));
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

  // Update allowed models (mandatory — at least 1 model required)
  if (formData.allowedModels !== undefined) {
    const raw = formData.allowedModels.trim();
    if (!raw) throw new Error("至少需要设置 1 个允许模型");
    editingProfile.allowedModels = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (editingProfile.allowedModels.length === 0) throw new Error("至少需要设置 1 个允许模型");
  }

  if (formData.modelAliases !== undefined) {
    const parsedAliases = parseModelAliasesInput(formData.modelAliases);
    editingProfile.modelAliases = parsedAliases;
  } else {
    editingProfile.modelAliases = getConfigurableModelAliases(editingProfile);
  }

  if (formData.peakModelAliases !== undefined) {
    editingProfile.peakModelAliases = formData.peakModelAliases.trim()
      ? parseModelAliasesInput(formData.peakModelAliases)
      : {};
  }

  // Ensure alias targets are always in allowedModels
  if (!Array.isArray(editingProfile.allowedModels)) editingProfile.allowedModels = [];
  for (const m of Object.values({ ...getProfileModelAliases(editingProfile), ...normalizeModelAliases(editingProfile.peakModelAliases || {}) })) {
    if (m && !editingProfile.allowedModels.includes(m)) {
      editingProfile.allowedModels.push(m);
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
    profiles: {
      "默认方案": {
        suffix: "default",
        isDefault: true,
        upstream: "",
        allowedModels: [],
        modelAliases: {},
        peakModelAliases: {},
        dailyTokenLimit: null,
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, summary: summarizeLegacyImport(normalized) }));
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
        applySettings(formData);
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

  // Profile: set default entry alias — make this profile the head of the default
  // group (other members kept after it). /v1 traffic fails over across the group.
  if (req.method === "POST" && req.url === "/api/profile/default") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { profile, suffix } = JSON.parse(buf.toString());
        const name = profile || getProfileNameBySuffix(suffix);
        if (!name || !config.profiles[name]) throw new Error(`Profile "${profile || suffix}" not found`);
        if (!Array.isArray(config.defaultProfileGroup)) config.defaultProfileGroup = [];
        config.defaultProfileGroup = [name, ...config.defaultProfileGroup.filter(n => n !== name)];
        for (const [pname, p] of Object.entries(config.profiles)) {
          p.isDefault = pname === config.defaultProfileGroup[0];
        }
        saveConfig(config);
        reloadAllRuntimes();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, defaultProfile: name, defaultProfileGroup: config.defaultProfileGroup, profiles: listProfiles() }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    }).catch(() => {
      res.writeHead(413); res.end("Request too large");
    });
    return;
  }

  // Profile: set the ordered default group (failover chain for /v1).
  if (req.method === "POST" && req.url === "/api/profile/default-group") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { group } = JSON.parse(buf.toString());
        if (!Array.isArray(group)) throw new Error("group must be an array of profile names");
        const valid = [];
        for (const name of group) {
          if (config.profiles[name] && !valid.includes(name)) valid.push(name);
        }
        if (valid.length === 0) throw new Error("默认方案组至少需要 1 个方案");
        config.defaultProfileGroup = valid;
        for (const [pname, p] of Object.entries(config.profiles)) {
          p.isDefault = pname === valid[0];
        }
        saveConfig(config);
        reloadAllRuntimes();
        console.log(`[PROFILE] Default group set: ${JSON.stringify(valid)}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, defaultProfileGroup: valid, profiles: listProfiles() }));
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
        const { profile, upstream, allowedModels, suffix, modelAliases, billingType } = JSON.parse(buf.toString());
        const name = (profile || "").trim();
        if (!name) throw new Error("Profile name required");
        if (config.profiles[name]) throw new Error(`方案 "${name}" 已存在`);
        const sfx = validateProfileSuffix(suffix, name);
        const aliases = parseModelAliasesInput(modelAliases);
        const models = allowedModels ? allowedModels.split(",").map(s => s.trim()).filter(Boolean) : [...(rt?.allowedModels || [])];
        for (const m of Object.values(aliases)) {
          if (m && !models.includes(m)) models.push(m);
        }
        const validBilling = ["coding_plan", "token_plan", "on_demand"].includes(billingType) ? billingType : "on_demand";
        config.profiles[name] = {
          upstream: upstream || rt?.upstream || "",
          allowedModels: models,
          modelAliases: aliases,
          peakModelAliases: {},
          users: {},
          suffix: sfx,
          isDefault: false,
          billingType: validBilling,
          peakHours: [],
        };
        saveConfig(config);
        reloadAllRuntimes();
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
    } else {
      for (const name of Object.keys(rateLimitState)) clearRateLimited(name);
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
  if (req.method === "GET" && (req.url === "/api/stats" || req.url.startsWith("/api/stats?"))) {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    const url = new URL(req.url, `http://localhost`);
    const profileSuffix = url.searchParams.get("profile") || "all";
    let data;
    if (profileSuffix === "all") {
      // Aggregate all profiles
      const agg = getAggregatedStore();
      data = sanitizeStore(agg);
      data.profileView = "all";
    } else {
      const targetSuffix = normalizeProfileSuffix(profileSuffix);
      const targetRt = runtimes[targetSuffix];
      if (targetRt) {
        const s = loadProfileSnapshot(targetSuffix);
        data = sanitizeStore(s);
        data.profileView = targetRt.profileName;
        data.profileSuffix = targetSuffix;
        data.upstream = targetRt.upstream;
        data.profileQuota = getProfileQuota(targetSuffix);
        data.userQuotas = {};
        for (const k of Object.keys(targetRt.users)) {
          const q = getUserQuota(k, targetRt);
          if (q > 0) data.userQuotas[k.slice(0, 8) + "****"] = q;
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }

    // Clear errors
  if (req.method === "POST" && req.url === "/api/clear-errors") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    db.prepare("DELETE FROM errors").run();
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
        delete config.users[key];
        for (const pname of Object.keys(config.profiles)) {
          delete config.profiles[pname].users[key];
        }
        const tx = db.transaction(() => {
          for (const table of ["users", "usage_daily", "usage_daily_model", "usage_daily_hourly", "errors", "quota_adjust_history"]) {
            db.prepare(`DELETE FROM ${table} WHERE user_key=?`).run(key);
          }
          saveConfig(config);
        });
        tx();
        delete userConcurrent[key];
        delete userRateBucket[key];
        reloadAllRuntimes();
        console.log(`[USER] Deleted global user and history: ${key.slice(0, 8)}****`);
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
          for (const table of ["users", "usage_daily", "usage_daily_model", "usage_daily_hourly", "errors", "quota_adjust_history"]) {
            db.prepare(`DELETE FROM ${table} WHERE user_key=?`).run(key);
          }
        });
        tx();
        console.log(`[STATS] Deleted residual stats for user: ${key.slice(0, 8)}****`);
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
        });
        tx();
        console.log(`[STATS] Deleted residual stats for model: ${model}`);
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
    if (!rt || !vk || (!rt.users[vk] && !rt.globalUsers[vk])) {
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
  if (req.method === "GET" && req.url.startsWith("/api/my-usage")) {
    const apiKey = getApiKey(req);
    const url = new URL(req.url, `http://localhost`);
    const profileSuffix = url.searchParams.get("profile") || "all";
    if (!getAccessibleProfiles(apiKey).length) {
      const knownUser = hasGlobalUser(apiKey);
      res.writeHead(knownUser ? 403 : 401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: knownUser ? "User is not allowed to view any profile." : "认证失败：请提供有效的虚拟Key (Authorization: Bearer jx-...)" }));
      return;
    }
    try {
      const payload = getPersonalUsageData(apiKey, profileSuffix);
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
