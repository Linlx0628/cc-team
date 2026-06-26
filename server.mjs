import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { URL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Cyberpunk Pixel Theme (shared by all pages) ─────────────────────────────
// ponytail: :root tokens were copy-pasted into all 5 pages; centralized here so the
// pixel theme lives in one place. Page-specific layout CSS still stays inline per page.
const PIXEL_FONT = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=Pixelify+Sans:wght@400;500;600;700&family=VT323&display=swap" rel="stylesheet">`;

const PIXEL_THEME = `
:root{
  --bg:#080812;--bg2:#0e0e1c;--card:#11111e;--card2:#171730;--border:#2c2658;
  --text:#eaeefc;--dim:#9aa3cc;--dim2:#7681a8;--grid:rgba(0,229,255,.07);
  --accent:#22e9ff;--blue:#46c6ff;--green:#27ffae;--yellow:#ffd23f;--orange:#ff9f1c;--red:#ff5470;
  --magenta:#ff3d9a;--purple:#b14eff;
  --font-pixel:'Press Start 2P',monospace;
  --font-body:'Pixelify Sans','VT323',monospace,system-ui;
  --glow:0 0 16px rgba(34,233,255,.45);
}
*{margin:0;padding:0;box-sizing:border-box}
::selection{background:var(--accent);color:var(--bg)}
body{font-family:var(--font-body);font-weight:500;font-size:16px;background:var(--bg);color:var(--text);min-height:100vh;letter-spacing:.2px;position:relative;isolation:isolate}
/* drifting neon aurora blobs (behind content, so text stays crisp) */
body::before{content:"";position:fixed;inset:-15%;z-index:-1;pointer-events:none;filter:blur(70px);
  background:radial-gradient(40% 38% at 18% 26%,rgba(34,233,255,.20),transparent 70%),radial-gradient(42% 42% at 82% 18%,rgba(255,61,154,.16),transparent 70%),radial-gradient(48% 48% at 60% 86%,rgba(177,78,255,.16),transparent 70%);
  animation:blob 24s ease-in-out infinite alternate}
/* synthwave perspective floor receding at the bottom edge */
html::after{content:"";position:fixed;left:-25%;right:-25%;bottom:0;height:40vh;z-index:1;pointer-events:none;opacity:.4;
  background-image:linear-gradient(rgba(34,233,255,.5) 1px,transparent 1px),linear-gradient(90deg,rgba(34,233,255,.5) 1px,transparent 1px);
  background-size:46px 46px;transform:perspective(320px) rotateX(62deg);transform-origin:bottom center;
  -webkit-mask-image:linear-gradient(transparent 45%,#000 90%);mask-image:linear-gradient(transparent 45%,#000 90%);
  animation:floor 5s linear infinite}
/* mouse HUD spotlight (position updated by PIXEL_JS) */
.fx-spot{position:fixed;inset:0;z-index:3;pointer-events:none;mix-blend-mode:screen}
/* breathing neon edge on chart panels */
.box{animation:pulse-glow 3.6s ease-in-out infinite}
/* faint scanlines + soft vignette — kept light so text stays readable */
body::after{content:"";position:fixed;inset:0;z-index:2;pointer-events:none;
  background:repeating-linear-gradient(0deg,rgba(0,0,0,0) 0 3px,rgba(0,0,0,.05) 3px 4px),radial-gradient(ellipse at center,transparent 62%,rgba(0,0,0,.34) 100%)}
/* moving CRT scan band sweeping the viewport */
html::before{content:"";position:fixed;left:0;right:0;top:0;height:150px;z-index:3;pointer-events:none;
  background:linear-gradient(180deg,transparent,rgba(34,233,255,.04) 55%,rgba(34,233,255,.11) 90%,transparent);
  animation:scanbar 7s linear infinite}
/* stat numbers: chunky pixel, glowing in their own color */
.card .v{font-family:var(--font-pixel);font-variant-numeric:tabular-nums;line-height:1.5;letter-spacing:0;text-shadow:0 0 10px currentColor,0 0 2px currentColor}
.display,.title-pixel{font-family:var(--font-pixel);letter-spacing:.5px;line-height:1.4}
/* segmented HP/MP bar */
.hp{display:inline-flex;gap:2px;height:13px;vertical-align:middle}
.hp>i{width:7px;height:100%;background:#1c1735;display:block}
.hp>i.on{background:var(--green);box-shadow:0 0 6px var(--green)}
.hp.warn>i.on{background:var(--yellow);box-shadow:0 0 6px var(--yellow)}
.hp.crit>i.on{background:var(--red);box-shadow:0 0 6px var(--red)}
/* pixel status LED */
.led{display:inline-block;width:10px;height:10px;vertical-align:middle;background:var(--dim2);margin-right:5px}
.led.on{background:var(--green);box-shadow:0 0 8px var(--green);animation:blink 2.4s steps(1) infinite}
.led.warn{background:var(--orange);box-shadow:0 0 8px var(--orange);animation:pulse-led 1.8s ease-in-out infinite}
.led.err{background:var(--red);box-shadow:0 0 8px var(--red);animation:pulse-led 1.1s ease-in-out infinite}
/* glitch title on hover */
.glitch{cursor:default}
.glitch:hover{animation:glitch .32s steps(2) 2}
/* HUD corner brackets */
.hud{position:relative}
.hud::before,.hud::after{content:"";position:absolute;width:11px;height:11px;border:2px solid var(--accent);pointer-events:none;opacity:.65;z-index:1}
.hud::before{top:-2px;left:-2px;border-right:0;border-bottom:0}
.hud::after{bottom:-2px;right:-2px;border-left:0;border-top:0}
/* animated equalizer — "system active" pulse */
.eq{display:inline-flex;gap:2px;align-items:flex-end;height:14px;vertical-align:-2px}
.eq>i{width:3px;height:4px;background:var(--accent);box-shadow:0 0 5px var(--accent);animation:eq 1s ease-in-out infinite}
.eq>i:nth-child(2){animation-delay:.15s}.eq>i:nth-child(3){animation-delay:.3s}.eq>i:nth-child(4){animation-delay:.45s}
/* terminal panel */
.term{background:var(--card);border:2px solid var(--accent);box-shadow:6px 6px 0 0 var(--accent),var(--glow);padding:34px;position:relative}
.term .cursor{display:inline-block;width:.6em;height:1.05em;background:var(--accent);vertical-align:-3px;margin-left:3px;animation:blink 1.05s steps(1) infinite}
.boot{animation:boot-in .5s ease-out both}
@keyframes grid-drift{from{background-position:0 0,0 0}to{background-position:44px 44px,44px 44px}}
@keyframes scanbar{0%{transform:translateY(-150px)}100%{transform:translateY(100vh)}}
@keyframes eq{0%,100%{height:4px}50%{height:14px}}
@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
@keyframes pulse-led{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes glitch{0%{text-shadow:0 0 transparent}20%{text-shadow:-2px 0 var(--magenta),2px 0 var(--accent)}40%{text-shadow:2px 0 var(--magenta),-2px 0 var(--accent);transform:translateX(1px)}60%{text-shadow:0 0 var(--accent)}100%{text-shadow:0 0 transparent;transform:translateX(0)}}
@keyframes boot-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
@keyframes blob{from{transform:translate3d(-3%,-2%,0) scale(1)}to{transform:translate3d(4%,3%,0) scale(1.1)}}
@keyframes floor{from{background-position:0 0}to{background-position:0 46px}}
@keyframes pulse-glow{0%,100%{box-shadow:0 0 0 0 rgba(34,233,255,0)}50%{box-shadow:0 0 16px 1px rgba(34,233,255,.16)}}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
`;

// ponytail: shared JS helpers for the fun data-viz (count-up, segmented HP bar).
// Kept free of template-literal interpolation so it can sit inside any page's <script>.
const PIXEL_JS = `
function _cuFmt(n,k){if(k){if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'k';return ''+n}return n.toLocaleString('zh-CN')}
function countUp(el,to,k){if(!el)return;var from=Number(el.dataset.cur||0),st=performance.now();
  function step(t){var p=Math.min(1,(t-st)/600);var e=1-Math.pow(1-p,3);el.textContent=_cuFmt(Math.round(from+(to-from)*e),k);if(p<1)requestAnimationFrame(step);else el.dataset.cur=to;}
  requestAnimationFrame(step);}
function runCountUps(root){(root||document).querySelectorAll('[data-cu]').forEach(function(el){countUp(el,Number(el.dataset.cu),el.hasAttribute('data-cu-k'))})}
function hpBar(pct,segs){segs=segs||20;var on=Math.round(pct/100*segs);var cls=pct>90?'crit':pct>70?'warn':'';
  var s='<span class="hp '+cls+'">';for(var i=0;i<segs;i++){s+='<i class="'+(i<on?'on':'')+'"></i>';}return s+'</span>';}
// mouse HUD spotlight — creates .fx-spot once and tracks the cursor (rAF-throttled)
(function(){var d=document,b=d.body;if(!b)return;var s=d.createElement('div');s.className='fx-spot';b.appendChild(s);
  var pend=false,x=0,y=0;d.addEventListener('mousemove',function(e){x=e.clientX;y=e.clientY;if(!pend){pend=true;requestAnimationFrame(function(){s.style.background='radial-gradient(260px circle at '+x+'px '+y+'px,rgba(34,233,255,.10),transparent 70%)';pend=false})}},{passive:true})})();
`;

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
const dbPath = path.join(__dirname, "data.db");
const RESERVED_SUFFIXES = new Set(["dashboard", "settings", "api", "health", "usage", "my-usage", "v1", "login", "logout", "favicon", "robots", "js", "css"]);
const PROFILE_SUFFIX_RE = /^[a-z0-9_-]{2,20}$/;
const API_PROTOCOLS = new Set(["anthropic", "openai"]);
const OPENAI_STREAM_USAGE_DEFAULT = true;
const RESPONSES_ADAPTERS = new Set(["none", "chat_completions"]);

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

function normalizeApiProtocol(value) {
  const protocol = String(value || "anthropic").trim().toLowerCase();
  return API_PROTOCOLS.has(protocol) ? protocol : "anthropic";
}

function validateApiProtocol(value) {
  const protocol = String(value || "anthropic").trim().toLowerCase();
  if (!API_PROTOCOLS.has(protocol)) throw new Error("接口协议只能是 anthropic 或 openai");
  return protocol;
}

function normalizeResponsesAdapter(value) {
  const adapter = String(value || "none").trim().toLowerCase();
  return RESPONSES_ADAPTERS.has(adapter) ? adapter : "none";
}

function validateResponsesAdapter(value) {
  const adapter = String(value || "none").trim().toLowerCase();
  if (!RESPONSES_ADAPTERS.has(adapter)) throw new Error("Responses 兼容模式只能是 none 或 chat_completions");
  return adapter;
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
  const explicitAliases = normalizeModelAliases(profile?.modelAliases || {});
  if (normalizeApiProtocol(profile?.apiProtocol) === "openai") return explicitAliases;
  return {
    ...legacyDefaultModelAliases(profile?.defaultModels || {}),
    ...explicitAliases,
  };
}

function getConfigurableModelAliases(profile) {
  const aliases = normalizeModelAliases(profile?.modelAliases || {});
  if (normalizeApiProtocol(profile?.apiProtocol) !== "openai") return aliases;
  return Object.fromEntries(Object.entries(aliases).filter(([alias]) => !/^jx-(sonnet|opus|haiku)$/i.test(alias)));
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

// Auto-migrate: add API protocol and generic model aliases.
(function migrateProfileProtocolsAndAliases() {
  let migrated = false;
  for (const pname of Object.keys(config.profiles)) {
    const p = config.profiles[pname];
    const protocol = normalizeApiProtocol(p.apiProtocol);
    if (p.apiProtocol !== protocol) {
      p.apiProtocol = protocol;
      migrated = true;
    }
    if (p.openaiStreamUsage === undefined) {
      p.openaiStreamUsage = OPENAI_STREAM_USAGE_DEFAULT;
      migrated = true;
    }
    const adapter = protocol === "openai" ? normalizeResponsesAdapter(p.responsesAdapter) : "none";
    if (p.responsesAdapter !== adapter) {
      p.responsesAdapter = adapter;
      migrated = true;
    }
    const mergedAliases = protocol === "openai" ? getConfigurableModelAliases(p) : getProfileModelAliases(p);
    const currentAliases = normalizeModelAliases(p.modelAliases || {});
    const mergedJson = JSON.stringify(mergedAliases);
    if (JSON.stringify(currentAliases) !== mergedJson) {
      p.modelAliases = mergedAliases;
      migrated = true;
    }
  }
  if (migrated) { saveConfig(config); console.log("[MIGRATE] Added apiProtocol/modelAliases to profiles"); }
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

// Auto-migrate: ensure every profile has a stable suffix and exactly one default entry
(function migrateProfileSuffix() {
  let migrated = false;
  const names = Object.keys(config.profiles);
  const explicitDefaults = names.filter(name => config.profiles[name].isDefault);
  // Determine the default profile. We trust the explicit isDefault flag over the
  // legacy activeProfile hint — activeProfile is a leftover from the old single-profile
  // switch model and can point at a non-default profile, silently misrouting /v1/* traffic.
  const defaultName = explicitDefaults[0] || names[0];
  const used = new Set();

  names.forEach((pname, index) => {
    const profile = config.profiles[pname];
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

    const shouldBeDefault = pname === defaultName;
    if (!!profile.isDefault !== shouldBeDefault) {
      profile.isDefault = shouldBeDefault;
      migrated = true;
    }
  });

  if (migrated) {
    saveConfig(config);
    console.log("[MIGRATE] Normalized profile suffix/default:", Object.entries(config.profiles).map(([n, p]) => `${n}(${JSON.stringify(p.suffix)}${p.isDefault ? ",default" : ""})`).join(", "));
  }
})();

function getDefaultProfileName() {
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
  return Object.keys(config.profiles).map(name => ({
    name,
    suffix: normalizeProfileSuffix(config.profiles[name].suffix),
    isDefault: !!config.profiles[name].isDefault,
    apiProtocol: normalizeApiProtocol(config.profiles[name].apiProtocol),
    upstream: config.profiles[name].upstream,
    userCount: Object.keys(config.profiles[name].users || {}).length,
    allowedModels: config.profiles[name].allowedModels || [],
    defaultModels: config.profiles[name].defaultModels || {},
    modelAliases: getConfigurableModelAliases(config.profiles[name]),
    openaiStreamUsage: config.profiles[name].openaiStreamUsage !== false,
    responsesAdapter: normalizeApiProtocol(config.profiles[name].apiProtocol) === "openai"
      ? normalizeResponsesAdapter(config.profiles[name].responsesAdapter)
      : "none",
    dailyTokenLimit: config.profiles[name].dailyTokenLimit || 0,
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
    apiProtocol: normalizeApiProtocol(profile.apiProtocol),
    upstream: profile.upstream,
    upstreamUrl,
    users: { ...(profile.users || {}) },
    allowedModels: profile.allowedModels || [],
    defaultModels: profile.defaultModels || { sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-5", haiku: "claude-haiku-4-5" },
    modelAliases: getProfileModelAliases(profile),
    openaiStreamUsage: profile.openaiStreamUsage !== false,
    responsesAdapter: normalizeApiProtocol(profile.apiProtocol) === "openai"
      ? normalizeResponsesAdapter(profile.responsesAdapter)
      : "none",
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
    const suffix = normalizeProfileSuffix(profile.suffix);
    runtimes[suffix] = createProfileRuntime(name, profile);
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
    return { suffix: defaultRuntime?.suffix || "", runtime: defaultRuntime, strippedUrl: url };
  }

  // Try to match /<suffix>/... pattern.
  const seg = pathname.match(/^\/([a-zA-Z0-9_-]{2,20})(\/.*)?$/);
  if (seg) {
    const candidate = seg[1].toLowerCase();
    if (!RESERVED_SUFFIXES.has(candidate) && runtimes[candidate]) {
      const strippedPath = seg[2] || "/";
      const query = url.includes("?") ? url.slice(url.indexOf("?")) : "";
      return { suffix: candidate, runtime: runtimes[candidate], strippedUrl: strippedPath + query };
    }
    if (!RESERVED_SUFFIXES.has(candidate)) {
      return { error: `Unknown profile suffix "${candidate}"` };
    }
  }

  return { suffix: defaultRuntime?.suffix || "", runtime: defaultRuntime, strippedUrl: url };
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
  stmts.profileSummaryToday = db.prepare(`SELECT COALESCE(SUM(input_tokens+output_tokens),0) AS tokens, COALESCE(SUM(requests),0) AS requests FROM usage_daily WHERE profile=? AND date=?`);
  stmts.lastQuotaAdjust = db.prepare(`SELECT * FROM quota_adjust_history WHERE user_key=? ORDER BY id DESC LIMIT 1`);
  stmts.quotaAdjustRecent = db.prepare(`SELECT * FROM quota_adjust_history ORDER BY id DESC LIMIT 20`);
  stmts.defaultDailyForUser = db.prepare(`SELECT date,input_tokens,output_tokens FROM usage_daily WHERE profile=? AND user_key=? AND date>=?`);
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

// ── Meta helpers (kv_meta: _lastQuotaEval) ──
function getMeta(key, fallback = null) {
  const row = db.prepare("SELECT value FROM kv_meta WHERE key=?").get(key);
  return row ? row.value : fallback;
}
function setMeta(key, value) { stmts.upsertMeta.run({ k: key, v: String(value) }); }

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
      upstream: profile.upstream,
      userCount: profile.userCount,
      todayTokens: row.tokens || 0,
      todayRequests: row.requests || 0,
      breakerState: runtime?.breaker?.status().state || "UNKNOWN",
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
  if (runtime?.apiProtocol === "openai") {
    const aliases = Object.keys(runtime.modelAliases || {});
    const aliasHint = aliases.length > 0 ? ` Configured aliases: ${previewList(aliases)}.` : "";
    return `Model "${model}" is not allowed for OpenAI/Codex profile "${runtime.profileName}". Allowed models: ${previewList(runtime.allowedModels)}.${aliasHint} Configure Codex to use an allowed model, or add a model alias such as gpt-5.5=<real model>.`;
  }
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

function resolveModel(model, _rt) {
  if (!model) return model;
  const runtime = _rt || rt;
  const aliases = runtime.modelAliases || {};
  if (aliases[model]) return aliases[model];
  const alias = model.toLowerCase();
  for (const [name, target] of Object.entries(aliases)) {
    if (name.toLowerCase() === alias) return target;
  }
  const dm = runtime.defaultModels || {};
  if (alias === "jx-sonnet") return dm.sonnet || model;
  if (alias === "jx-opus")   return dm.opus   || model;
  if (alias === "jx-haiku")  return dm.haiku  || model;
  return model;
}

function isOpenAIChatCompletionsPath(reqUrl) {
  const pathname = new URL(reqUrl || "/", "http://localhost").pathname;
  return pathname === "/v1/chat/completions" || pathname.endsWith("/chat/completions");
}

function isOpenAIResponsesPath(reqUrl) {
  const pathname = new URL(reqUrl || "/", "http://localhost").pathname;
  return pathname === "/v1/responses" || pathname.endsWith("/responses");
}

function isOpenAIModelsPath(reqUrl) {
  const pathname = new URL(reqUrl || "/", "http://localhost").pathname;
  return pathname === "/v1/models" || pathname.endsWith("/models");
}

function isAllowedOpenAIProxyPath(reqUrl, method) {
  const upperMethod = String(method || "GET").toUpperCase();
  if (isOpenAIModelsPath(reqUrl)) return upperMethod === "GET" || upperMethod === "HEAD";
  if (upperMethod !== "POST") return false;
  return isOpenAIResponsesPath(reqUrl) || isOpenAIChatCompletionsPath(reqUrl);
}

function validateProxyTarget(runtime, reqUrl, method) {
  if (runtime?.apiProtocol !== "openai") return { allowed: true };
  if (isAllowedOpenAIProxyPath(reqUrl, method)) return { allowed: true };
  const pathname = new URL(reqUrl || "/", "http://localhost").pathname;
  return {
    allowed: false,
    statusCode: 404,
    message: `Unsupported OpenAI/Codex proxy endpoint ${String(method || "GET").toUpperCase()} ${pathname}. Allowed endpoints: POST /v1/responses, POST /v1/chat/completions, and local GET /v1/models.`,
  };
}

function shouldAdaptOpenAIResponses(runtime, reqUrl) {
  return runtime?.apiProtocol === "openai" &&
    runtime.responsesAdapter === "chat_completions" &&
    isOpenAIResponsesPath(reqUrl);
}

function shouldServeLocalOpenAIModels(runtime, reqUrl) {
  return runtime?.apiProtocol === "openai" &&
    isOpenAIModelsPath(reqUrl);
}

function ensureOpenAIStreamUsage(body, runtime, reqUrl) {
  if (runtime.apiProtocol !== "openai" || runtime.openaiStreamUsage === false || !isOpenAIChatCompletionsPath(reqUrl)) {
    return body;
  }
  try {
    const parsed = sanitizeJson(JSON.parse(body.toString()));
    if (!parsed.stream) return body;
    const opts = parsed.stream_options && typeof parsed.stream_options === "object" && !Array.isArray(parsed.stream_options)
      ? parsed.stream_options
      : {};
    parsed.stream_options = { ...opts, include_usage: true };
    return Buffer.from(JSON.stringify(parsed));
  } catch {
    return body;
  }
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
  return !!((usage.input_tokens || 0) > 0 || (usage.output_tokens || 0) > 0 || (usage.prompt_tokens || 0) > 0 || (usage.completion_tokens || 0) > 0 || (usage.total_tokens || 0) > 0);
}

function usageToResponsesUsage(usage = {}) {
  const toTokenNumber = (value) => {
    if (value === undefined || value === null || value === "") return 0;
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  const input = toTokenNumber(usage.input_tokens ?? usage.prompt_tokens);
  let output = toTokenNumber(usage.output_tokens ?? usage.completion_tokens);
  const explicitTotal = toTokenNumber(usage.total_tokens);
  if (!input && !output && explicitTotal) output = explicitTotal;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: explicitTotal || input + output,
  };
}

function extractTextContent(content) {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part === undefined || part === null) return "";
      if (typeof part === "string") return part;
      if (typeof part !== "object") return String(part);
      if (typeof part.text === "string") return part.text;
      if (typeof part.input_text === "string") return part.input_text;
      if (typeof part.output_text === "string") return part.output_text;
      if (typeof part.refusal === "string") return part.refusal;
      if (typeof part.content === "string") return part.content;
      return "";
    }).join("");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.input_text === "string") return content.input_text;
    if (typeof content.output_text === "string") return content.output_text;
    if (typeof content.content === "string") return content.content;
  }
  return String(content);
}

function normalizeChatRole(role) {
  const r = String(role || "user").toLowerCase();
  if (r === "developer") return "system";
  if (["system", "user", "assistant", "tool"].includes(r)) return r;
  return "user";
}

function responsesInputToChatMessages(input, instructions) {
  const messages = [];
  const systemText = extractTextContent(instructions).trim();
  if (systemText) messages.push({ role: "system", content: systemText });

  const addMessage = (role, content, extra = {}) => {
    const text = extractTextContent(content);
    messages.push({ role: normalizeChatRole(role), content: text, ...extra });
  };

  if (typeof input === "string") {
    addMessage("user", input);
  } else if (Array.isArray(input)) {
    const looseText = [];
    for (const item of input) {
      if (typeof item === "string") {
        looseText.push(item);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      if (item.type === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id || item.id || "call_0",
          content: extractTextContent(item.output),
        });
        continue;
      }
      if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: "",
          tool_calls: [{
            id: item.call_id || item.id || "call_0",
            type: "function",
            function: {
              name: item.name || "unknown",
              arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
            },
          }],
        });
        continue;
      }
      if (item.role || item.type === "message") {
        addMessage(item.role || "user", item.content ?? item.text ?? item.input_text ?? item.output_text ?? "");
        continue;
      }
      looseText.push(extractTextContent(item.content ?? item.text ?? item.input_text ?? item.output_text ?? item));
    }
    if (looseText.length > 0) addMessage("user", looseText.filter(Boolean).join("\n"));
  } else if (input && typeof input === "object") {
    if (input.role || input.type === "message") addMessage(input.role || "user", input.content ?? input.text ?? "");
    else addMessage("user", input.content ?? input.text ?? input.input_text ?? "");
  }

  if (messages.length === 0) messages.push({ role: "user", content: "" });
  return messages;
}

function convertResponsesToolsToChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type !== "function") continue;
    if (tool.function && typeof tool.function === "object") {
      converted.push({ type: "function", function: tool.function });
      continue;
    }
    if (!tool.name) continue;
    const fn = { name: tool.name };
    if (tool.description) fn.description = tool.description;
    if (tool.parameters) fn.parameters = tool.parameters;
    if (tool.strict !== undefined) fn.strict = tool.strict;
    converted.push({ type: "function", function: fn });
  }
  return converted.length > 0 ? converted : undefined;
}

function convertResponsesToolChoiceToChat(toolChoice) {
  if (!toolChoice || typeof toolChoice === "string") return toolChoice;
  if (toolChoice.type === "function" && toolChoice.name) {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return toolChoice;
}

function responsesRequestToChatCompletions(parsed, forceStream = false) {
  const chat = {
    model: parsed.model,
    messages: Array.isArray(parsed.messages)
      ? parsed.messages.map((m) => ({ ...m, role: normalizeChatRole(m.role) }))
      : responsesInputToChatMessages(parsed.input, parsed.instructions),
  };
  const passthrough = [
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "stop",
    "user",
    "metadata",
    "parallel_tool_calls",
  ];
  for (const key of passthrough) {
    if (parsed[key] !== undefined) chat[key] = parsed[key];
  }
  const maxTokens = parsed.max_tokens ?? parsed.max_completion_tokens ?? parsed.max_output_tokens;
  if (maxTokens !== undefined) chat.max_tokens = maxTokens;
  const tools = convertResponsesToolsToChatTools(parsed.tools);
  if (tools) chat.tools = tools;
  const toolChoice = convertResponsesToolChoiceToChat(parsed.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  chat.stream = forceStream || !!parsed.stream;
  if (chat.stream) {
    const opts = parsed.stream_options && typeof parsed.stream_options === "object" && !Array.isArray(parsed.stream_options)
      ? parsed.stream_options
      : {};
    chat.stream_options = { ...opts, include_usage: true };
  }
  return chat;
}

function convertChatToolCallsToResponsesOutput(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call, index) => ({
    type: "function_call",
    id: call.id || `fc_${index}`,
    call_id: call.id || `call_${index}`,
    name: call.function?.name || call.name || "unknown",
    arguments: call.function?.arguments || call.arguments || "{}",
    status: "completed",
  }));
}

function chatCompletionToResponse(chat, fallbackModel) {
  const choice = Array.isArray(chat.choices) ? chat.choices[0] : null;
  const message = choice?.message || {};
  const text = extractTextContent(message.content);
  const output = [];
  if (text || !message.tool_calls) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    });
  }
  output.push(...convertChatToolCallsToResponsesOutput(message.tool_calls));
  const usage = usageToResponsesUsage(chat.usage || {});
  return {
    id: chat.id || `resp_${crypto.randomBytes(12).toString("hex")}`,
    object: "response",
    created_at: chat.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: chat.model || fallbackModel,
    output,
    output_text: text,
    usage,
  };
}

function localOpenAIModels(runtime) {
  const ids = Array.from(new Set((runtime.allowedModels || []).filter((m) => m && m !== "*")));
  if (ids.length === 0) {
    for (const target of Object.values(runtime.modelAliases || {})) {
      if (target && !ids.includes(target)) ids.push(target);
    }
  }
  return {
    object: "list",
    data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "cc-team" })),
  };
}


// ─── Timezone Helpers (UTC+8 北京时间) ────────────────────────────────────────
function cnNow() {
  const d = new Date();
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}
function cnDate() { return cnNow().toISOString().slice(0, 10); }
function cnHour() { return cnNow().getHours().toString().padStart(2, "0"); }

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
    const d = new Date(cnNow().getTime() - i * 86400000);
    const utc = d.getTime() + d.getTimezoneOffset() * 60000;
    dates.push(new Date(utc + 8 * 3600000).toISOString().slice(0, 10));
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
      const dayUsage = (r.input_tokens || 0) + (r.output_tokens || 0);
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
    trendMap[r.date] = { date: r.date, input: r.input_tokens||0, output: r.output_tokens||0, requests: r.requests||0, total: (r.input_tokens||0)+(r.output_tokens||0) };
  }
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    trend.push(trendMap[dateStr] || { date: dateStr, input: 0, output: 0, requests: 0, total: 0 });
  }

  // Check if quota was auto-adjusted
  const lastAdjust = stmts.lastQuotaAdjust.get(key);
  const quotaAutoAdjusted = lastAdjust ? !!lastAdjust.auto : false;

  return {
    profile: runtime.profileName,
    profileSuffix: suffix,
    quota: { type: quota.source, limit: quota.limit, used: quota.used, remaining: quota.remaining, autoAdjusted: quotaAutoAdjusted },
    today: { input: todayUsage.inputTokens||0, output: todayUsage.outputTokens||0, requests: todayUsage.requests||0, cacheWrite: todayUsage.cacheCreationTokens||0, cacheRead: todayUsage.cacheReadTokens||0, total: (todayUsage.inputTokens||0)+(todayUsage.outputTokens||0) },
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
    trendByDate[dateStr] = { date: dateStr, input: 0, output: 0, requests: 0, total: 0 };
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
        trendByDate[r.date].requests += r.requests || 0;
        trendByDate[r.date].total += (r.input_tokens||0) + (r.output_tokens||0);
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
    today: { input: todayUsage.inputTokens, output: todayUsage.outputTokens, requests: todayUsage.requests, cacheWrite: todayUsage.cacheCreationTokens || 0, cacheRead: todayUsage.cacheReadTokens || 0, total: todayUsage.inputTokens + todayUsage.outputTokens },
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
  // Resolve which profile this request targets
  const resolvedProfile = resolveProfile(req.url);
  if (resolvedProfile.error) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: resolvedProfile.error }));
    return;
  }
  const { suffix, runtime, strippedUrl } = resolvedProfile;
  const apiKey = getApiKey(req);
  const proxyStartTime = Date.now();
  let proxyPhase = "init";
  const clientState = createClientAbortState();

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

  // Reject non-API requests (browser favicon, Chrome DevTools, etc.)
  if (apiKey === "unknown") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

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

  // OpenAI/Codex model discovery is served locally to prevent client probes from touching upstream billing endpoints.
  if (shouldServeLocalOpenAIModels(runtime, targetUrl) && ["GET", "HEAD"].includes(String(req.method || "GET").toUpperCase())) {
    res.writeHead(200, { "Content-Type": "application/json", "X-Proxy-Local": "models" });
    if (req.method === "HEAD") res.end();
    else res.end(JSON.stringify(localOpenAIModels(runtime)));
    console.log(`[本地] ${getUserName(apiKey, runtime)} profile=${runtime.profileName} ${req.method} ${targetUrl} 返回模型列表，不转发上游`);
    return;
  }

  const targetValidation = validateProxyTarget(runtime, targetUrl, req.method);
  if (!targetValidation.allowed) {
    const status = targetValidation.statusCode || 404;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: targetValidation.message }));
    recordError(apiKey, status, targetValidation.message, targetUrl, "unknown", suffix, runtime);
    console.log(`[拦截] ${getUserName(apiKey, runtime)} profile=${runtime.profileName} ${req.method} ${targetUrl} 不转发上游`);
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
      res.end(JSON.stringify({ error: modelNotAllowedMessage(reqModel, runtime) }));
      console.log(`[拦截] ${getUserName(apiKey, runtime)} model=${reqModel} 被拒绝`);
      return;
    }

    // Circuit breaker check
    if (!runtime.breaker.allowRequest()) {
      const remaining = Math.ceil(runtime.breaker.status().cooldownRemaining / 1000);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Upstream temporarily unavailable. Circuit open, retry in ${remaining}s.` }));
      recordError(apiKey, 503, "Circuit breaker open", req.url, reqModel, suffix, runtime);
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

      const useResponsesAdapter = shouldAdaptOpenAIResponses(runtime, targetUrl);

      if (isStreamRequest && !useResponsesAdapter) {
        body = ensureOpenAIStreamUsage(body, runtime, strippedUrl || req.url);
        reqHeaders["content-length"] = body.length;
      }

      proxyPhase = isStreamRequest ? "streaming-proxy" : "json-proxy";
      const timeout = isStreamRequest ? gProxy.streamTimeout : gProxy.timeout;

      if (isStreamRequest) {
        if (useResponsesAdapter) {
          await handleOpenAIResponsesAdapterStreamingProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, runtime, suffix, clientState);
        } else {
          await handleStreamingProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, runtime, suffix, strippedUrl, clientState);
        }
      } else {
        if (useResponsesAdapter) {
          await handleOpenAIResponsesAdapterJsonProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, runtime, suffix, clientState);
        } else {
          await handleJsonProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, runtime, suffix, strippedUrl, clientState);
        }
      }
    } catch (err) {
      if (isClientAbortError(err)) {
        console.log(`[取消] ${getUserName(apiKey, runtime)} 客户端已断开，停止代理 model=${reqModel} phase=${proxyPhase}`);
        return;
      }
      const status = err.isTimeout ? 504 : 502;
      const label = err.isTimeout ? "Gateway Timeout" : "Bad Gateway";
      recordError(apiKey, status, `${label}: ${err.message}`, req.url, reqModel, suffix, runtime);
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

function writeSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function handleOpenAIResponsesAdapterJsonProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, _rt, suffix, clientState) {
  const runtime = _rt || rt;
  let parsed;
  try {
    parsed = sanitizeJson(JSON.parse(body.toString()));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON request body" }));
    return;
  }

  const chatPayload = responsesRequestToChatCompletions(parsed, false);
  const chatBody = Buffer.from(JSON.stringify(chatPayload));
  const chatHeaders = { ...reqHeaders, "content-type": "application/json", "content-length": chatBody.length };
  let lastError = null;

  for (let attempt = 0; attempt <= gProxy.maxRetries; attempt++) {
    try {
      throwIfClientAborted(clientState);
      const upRes = await sendUpstream(chatBody, "/v1/chat/completions", "POST", chatHeaders, timeout, runtime, clientState);
      const text = upRes.body.toString();

      if (upRes.statusCode < 500) {
        runtime.breaker.recordSuccess();
      }

      if (gProxy.retryableStatusCodes.includes(upRes.statusCode) && attempt < gProxy.maxRetries) {
        const baseDelay = Math.min(gProxy.retryDelay * Math.pow(2, attempt), 10000);
        const delay = Math.round(jitter(baseDelay));
        console.log(`[重试] ${getUserName(apiKey, runtime)} ${upRes.statusCode} model=${reqModel} responses→chat 第${attempt + 1}/${gProxy.maxRetries}次 ${delay}ms后重试`);
        recordError(apiKey, upRes.statusCode, `Retryable adapter error (attempt ${attempt + 1}/${gProxy.maxRetries})`, req.url, reqModel, suffix, runtime);
        await sleepWithClientAbort(delay, clientState);
        continue;
      }

      if (upRes.statusCode >= 400) {
        let errMsg = text.slice(0, 200);
        try {
          const json = JSON.parse(text);
          errMsg = json.error?.message || json.message || errMsg;
        } catch {}
        recordError(apiKey, upRes.statusCode, errMsg, req.url, reqModel, suffix, runtime);
        if (upRes.statusCode >= 500) runtime.breaker.recordFailure();
        const respHeaders = { ...upRes.headers };
        delete respHeaders["content-encoding"];
        delete respHeaders["content-length"];
        res.writeHead(upRes.statusCode, respHeaders);
        res.end(text);
        return;
      }

      let chatJson;
      try {
        chatJson = JSON.parse(text);
      } catch {
        console.log(`[响应] ${getUserName(apiKey, runtime)} adapter 上游返回非JSON body[0:300]=${text.slice(0, 300).replace(/\n/g, "\\n")}`);
        res.writeHead(upRes.statusCode, { "Content-Type": "text/plain" });
        res.end(text);
        return;
      }

      const responseJson = chatCompletionToResponse(chatJson, reqModel);
      if (usageHasTokens(responseJson.usage)) {
        recordUsage(apiKey, responseJson.usage, responseJson.model || reqModel, suffix, runtime);
        console.log(`[Token] ${getUserName(apiKey, runtime)} [${reqSource}] model=${responseJson.model || reqModel} 输入=${responseJson.usage.input_tokens || 0} 输出=${responseJson.usage.output_tokens || 0} responses→chat`);
      } else {
        console.log(`[响应] ${getUserName(apiKey, runtime)} adapter 200 OK 但无usage字段 model=${responseJson.model || reqModel}`);
      }

      const respHeaders = { ...upRes.headers, "content-type": "application/json" };
      delete respHeaders["content-encoding"];
      delete respHeaders["content-length"];
      if (attempt > 0) respHeaders["x-proxy-retry"] = String(attempt);
      res.writeHead(upRes.statusCode, respHeaders);
      res.end(JSON.stringify(responseJson));
      return;
    } catch (err) {
      if (isClientAbortError(err)) {
        console.log(`[取消] ${getUserName(apiKey, runtime)} adapter JSON 客户端断开 model=${reqModel}`);
        return;
      }
      lastError = err;
      runtime.breaker.recordFailure();
      if (attempt < gProxy.maxRetries) {
        const baseDelay = Math.min(gProxy.retryDelay * Math.pow(2, attempt), 10000);
        const delay = Math.round(jitter(baseDelay));
        console.log(`[重试] ${getUserName(apiKey, runtime)} adapter 网络错误 model=${reqModel} 第${attempt + 1}/${gProxy.maxRetries}次 ${delay}ms后重试`);
        await sleepWithClientAbort(delay, clientState);
      }
    }
  }

  const finalStatus = lastError?.isTimeout ? 504 : 502;
  const finalLabel = lastError?.isTimeout ? "Gateway Timeout" : "Bad Gateway";
  recordError(apiKey, finalStatus, `${finalLabel} adapter after ${gProxy.maxRetries} retries: ${lastError?.message}`, req.url, reqModel, suffix, runtime);
  if (!res.headersSent) {
    res.writeHead(finalStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Proxy ${finalLabel} after ${gProxy.maxRetries} retries. Please try again later.` }));
  }
}

async function handleOpenAIResponsesAdapterStreamingProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, _rt, suffix, clientState) {
  const runtime = _rt || rt;
  throwIfClientAborted(clientState);
  let parsed;
  try {
    parsed = sanitizeJson(JSON.parse(body.toString()));
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid JSON request body" }));
    return;
  }

  const chatPayload = responsesRequestToChatCompletions(parsed, true);
  const chatBody = Buffer.from(JSON.stringify(chatPayload));
  const chatHeaders = {
    ...reqHeaders,
    accept: "text/event-stream",
    "content-type": "application/json",
    "content-length": chatBody.length,
  };
  const opts = {
    hostname: runtime.upstreamUrl.hostname,
    port: runtime.upstreamUrl.port || (runtime.upstreamUrl.protocol === "https:" ? 443 : 80),
    path: buildUpstreamPath("/v1/chat/completions", runtime),
    method: "POST",
    headers: chatHeaders,
    agent: runtime.agent,
  };
  const transport = runtime.upstreamUrl.protocol === "https:" ? https : http;

  await new Promise((resolve) => {
    let clientGone = !!clientState?.aborted;
    let resolved = false;
    let cleanupUpstream = () => {};
    let cleanupClientAbort = () => {};
    const responseId = `resp_${crypto.randomBytes(12).toString("hex")}`;
    const createdAt = Math.floor(Date.now() / 1000);
    let model = reqModel;
    let buf = "";
    let rawSample = "";
    let sseDataLines = 0;
	    let completed = false;
	    const usage = { input_tokens: 0, output_tokens: 0 };
	    const textParts = [];
	    const outputItems = [];
	    const toolCalls = new Map();
	    let nextOutputIndex = 0;
	    const messageItemId = "msg_0";
	    let messageOutputIndex = null;
	    let messageStarted = false;
	    let messageDone = false;

	    const buildMessageItem = (text, status = "in_progress") => ({
	      id: messageItemId,
	      type: "message",
	      status,
	      role: "assistant",
	      content: [{ type: "output_text", text }],
	    });
	    const buildToolCallItem = (tool, status = "in_progress") => ({
	      id: tool.itemId,
	      type: "function_call",
	      status,
	      call_id: tool.callId,
	      name: tool.name || "unknown",
	      arguments: tool.arguments,
	    });
	    const ensureMessageItem = () => {
	      if (messageStarted) return;
	      messageStarted = true;
	      messageOutputIndex = nextOutputIndex++;
	      if (!clientGone) {
	        writeSseEvent(res, "response.output_item.added", {
	          type: "response.output_item.added",
	          output_index: messageOutputIndex,
	          item: buildMessageItem(""),
	        });
	        writeSseEvent(res, "response.content_part.added", {
	          type: "response.content_part.added",
	          item_id: messageItemId,
	          output_index: messageOutputIndex,
	          content_index: 0,
	          part: { type: "output_text", text: "" },
	        });
	      }
	    };
	    const finishMessageItem = () => {
	      if (!messageStarted || messageDone) return;
	      messageDone = true;
	      const outputText = textParts.join("");
	      const messageItem = buildMessageItem(outputText, "completed");
	      outputItems[messageOutputIndex] = messageItem;
	      if (!clientGone) {
	        writeSseEvent(res, "response.output_text.done", {
	          type: "response.output_text.done",
	          item_id: messageItemId,
	          output_index: messageOutputIndex,
	          content_index: 0,
	          text: outputText,
	        });
	        writeSseEvent(res, "response.content_part.done", {
	          type: "response.content_part.done",
	          item_id: messageItemId,
	          output_index: messageOutputIndex,
	          content_index: 0,
	          part: { type: "output_text", text: outputText },
	        });
	        writeSseEvent(res, "response.output_item.done", {
	          type: "response.output_item.done",
	          output_index: messageOutputIndex,
	          item: messageItem,
	        });
	      }
	    };
	    const ensureToolCall = (call) => {
	      const chatIndex = Number.isInteger(call?.index) ? call.index : toolCalls.size;
	      const key = String(chatIndex);
	      let tool = toolCalls.get(key);
	      if (!tool) {
	        const callId = call?.id || `call_${chatIndex}`;
	        tool = {
	          chatIndex,
	          outputIndex: nextOutputIndex++,
	          itemId: callId,
	          callId,
	          name: "",
	          arguments: "",
	          started: false,
	          done: false,
	        };
	        toolCalls.set(key, tool);
	      }
	      if (call?.id && !tool.started) {
	        tool.itemId = call.id;
	        tool.callId = call.id;
	      }
	      if (call?.function?.name) tool.name = call.function.name;
	      if (!tool.started) {
	        tool.started = true;
	        if (!clientGone) {
	          writeSseEvent(res, "response.output_item.added", {
	            type: "response.output_item.added",
	            output_index: tool.outputIndex,
	            item: buildToolCallItem(tool),
	          });
	        }
	      }
	      return tool;
	    };
	    const handleToolCallDelta = (call) => {
	      if (!call || typeof call !== "object") return;
	      const tool = ensureToolCall(call);
	      const argDelta = typeof call.function?.arguments === "string" ? call.function.arguments : "";
	      if (!argDelta) return;
	      tool.arguments += argDelta;
	      if (!clientGone) {
	        writeSseEvent(res, "response.function_call_arguments.delta", {
	          type: "response.function_call_arguments.delta",
	          item_id: tool.itemId,
	          output_index: tool.outputIndex,
	          delta: argDelta,
	        });
	      }
	    };
	    const finishToolCalls = () => {
	      for (const tool of [...toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
	        if (tool.done) continue;
	        tool.done = true;
	        const item = buildToolCallItem(tool, "completed");
	        outputItems[tool.outputIndex] = item;
	        if (!clientGone) {
	          writeSseEvent(res, "response.function_call_arguments.done", {
	            type: "response.function_call_arguments.done",
	            item_id: tool.itemId,
	            output_index: tool.outputIndex,
	            arguments: tool.arguments,
	          });
	          writeSseEvent(res, "response.output_item.done", {
	            type: "response.output_item.done",
	            output_index: tool.outputIndex,
	            item,
	          });
	        }
	      }
	    };

	    const safeResolve = () => {
	      if (!resolved) {
	        resolved = true;
        cleanupClientAbort();
        cleanupUpstream();
        resolve();
      }
    };
	    const finishStream = () => {
	      if (completed) return;
	      completed = true;
	      const outputText = textParts.join("");
	      const responseUsage = usageToResponsesUsage(usage);
	      if (!messageStarted && toolCalls.size === 0) ensureMessageItem();
	      finishMessageItem();
	      finishToolCalls();
	      const finalOutput = outputItems.filter(Boolean);
	      if (!clientGone) {
	        writeSseEvent(res, "response.completed", {
	          type: "response.completed",
	          response: {
	            id: responseId,
            object: "response",
	            created_at: createdAt,
	            status: "completed",
	            model,
	            output: finalOutput,
	            output_text: outputText,
	            usage: responseUsage,
	          },
	        });
      }
      if (usageHasTokens(responseUsage)) {
        recordUsage(apiKey, responseUsage, model, suffix, runtime);
        console.log(`[Token] ${getUserName(apiKey, runtime)} [${reqSource}] model=${model} 输入=${responseUsage.input_tokens || 0} 输出=${responseUsage.output_tokens || 0} responses→chat`);
      } else {
        console.log(`[响应] ${getUserName(apiKey, runtime)} adapter 流结束 无usage数据 model=${model} sse行数=${sseDataLines} 原始数据[0:200]=${rawSample.slice(0, 200).replace(/\n/g, "\\n")}`);
      }
      if (!clientGone) res.end();
      safeResolve();
    };

    const upReq = transport.request(opts, (upRes) => {
      if (upRes.statusCode >= 400) {
        const h = { ...upRes.headers };
        delete h["transfer-encoding"];
        delete h["content-encoding"];
        delete h["content-length"];
        res.writeHead(upRes.statusCode, h);
        let errBuf = "";
        upRes.on("data", (c) => {
          if (clientGone) return;
          errBuf += c.toString();
          res.write(c);
        });
        upRes.on("end", () => {
          recordError(apiKey, upRes.statusCode, errBuf.slice(0, 200), req.url, reqModel, suffix, runtime);
          if (upRes.statusCode >= 500) runtime.breaker.recordFailure();
          else runtime.breaker.recordSuccess();
          if (!clientGone) res.end();
          safeResolve();
        });
        return;
      }

      runtime.breaker.recordSuccess();
      res.writeHead(upRes.statusCode, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      });
	      writeSseEvent(res, "response.created", {
	        type: "response.created",
	        response: {
	          id: responseId,
          object: "response",
          created_at: createdAt,
          status: "in_progress",
          model,
	          output: [],
	        },
	      });

	      res.on("error", () => {
	        clientGone = true;
        upReq.destroy(makeClientAbortError("response-error"));
        safeResolve();
      });

      const handleDataLine = (jsonStr) => {
        if (jsonStr === "[DONE]") {
          finishStream();
          return;
        }
        sseDataLines++;
        let d;
        try {
          d = JSON.parse(jsonStr);
        } catch {
          return;
        }
        if (sseDataLines <= 3) console.log(`[SSE] ${getUserName(apiKey, runtime)} adapter 第${sseDataLines}条 类型=${d.object || d.type || "chunk"} 字段=${Object.keys(d).join(",")}`);
        if (d.model) model = d.model;
	        if (d.usage) mergeUsageCounters(usage, d.usage);
	        for (const choice of d.choices || []) {
	          const delta = choice.delta || {};
	          if (typeof delta.content === "string" && delta.content) {
	            ensureMessageItem();
	            textParts.push(delta.content);
	            if (!clientGone) {
	              writeSseEvent(res, "response.output_text.delta", {
	                type: "response.output_text.delta",
	                item_id: messageItemId,
	                output_index: messageOutputIndex,
	                content_index: 0,
	                delta: delta.content,
	              });
	            }
	          }
	          for (const call of delta.tool_calls || []) {
	            handleToolCallDelta(call);
	          }
	          if (choice.message?.content) {
	            const text = extractTextContent(choice.message.content);
	            if (text) {
	              ensureMessageItem();
	              textParts.push(text);
	            }
	          }
	        }
	      };

      upRes.on("data", (chunk) => {
        if (clientGone || completed) return;
        const text = chunk.toString();
        if (rawSample.length < 500) rawSample += text;
        buf += text;
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          if (!line.startsWith("data:")) continue;
          handleDataLine(line.slice(5).trim());
        }
      });

      upRes.on("end", () => {
        if (completed) return;
        if (buf.trim().startsWith("data:")) {
          handleDataLine(buf.trim().slice(5).trim());
        }
        finishStream();
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
        console.log(`[取消] ${getUserName(apiKey, runtime)} adapter 流式客户端断开 model=${reqModel}`);
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
      } else if (!clientGone && !completed) {
        finishStream();
      }
      safeResolve();
    });

    upReq.write(chatBody);
    upReq.end();
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
    const upReq = transport.request(opts, (upRes) => {
      const h = { ...upRes.headers };
      delete h["transfer-encoding"];
      delete h["content-encoding"];
      delete h["content-length"];
      h["content-type"] = "text/event-stream";
      h["cache-control"] = "no-cache";
      h["connection"] = "keep-alive";
      res.writeHead(upRes.statusCode, h);

      res.on("error", () => {
        clientGone = true;
        upReq.destroy(makeClientAbortError("response-error"));
        safeResolve();
      });

      let buf = "", usage = { input_tokens: 0, output_tokens: 0 }, model = reqModel;
      let sseDataLines = 0;
      let rawSample = "";

      if (upRes.statusCode >= 400) {
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
        if (usage.input_tokens > 0 || usage.output_tokens > 0) {
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
    apiProtocol: normalizeApiProtocol(defaultProfile?.apiProtocol),
    proxy: { ...gProxy },
    allowedModels: defaultProfile?.allowedModels || [],
    defaultModels: { ...(defaultProfile?.defaultModels || {}) },
    modelAliases: getConfigurableModelAliases(defaultProfile || {}),
    openaiStreamUsage: defaultProfile?.openaiStreamUsage !== false,
    responsesAdapter: normalizeApiProtocol(defaultProfile?.apiProtocol) === "openai"
      ? normalizeResponsesAdapter(defaultProfile?.responsesAdapter)
      : "none",
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
  const errDiv = errorMsg ? `<div style="background:rgba(255,56,96,.12);color:var(--red);padding:10px 14px;border-radius:6px;margin-bottom:16px;font-size:13px">${errorMsg}</div>` : "";

  // Global users table rows
  const initialSuffix = s.selectedProfileSuffix || getDefaultProfileSuffix();
  const initialAssignments = s.profileAssignments[initialSuffix] || {};
  const initialProfile = s.profiles.find(p => p.suffix === initialSuffix) || s.profiles[0] || {};

  const globalUserRows = Object.entries(s.globalUsers).map(([k, v]) => {
    const isObj = typeof v === "object" && v !== null;
    const username = isObj ? (v.username || "") : (typeof v === "string" ? v : "");
    const expiresAt = isObj ? (v.expiresAt || "") : "";
    const disabled = isObj ? !!v.disabled : false;
    return `<tr>
<td><code style="font-size:11px;color:var(--accent);user-select:all;cursor:pointer" title="点击复制" onclick="navigator.clipboard.writeText('${escJs(k)}')">${escHtml(k)}</code></td>
<td><input type="text" name="gu_un_${escHtml(k)}" value="${escHtml(username)}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px" placeholder="用户名"></td>
<td><input type="datetime-local" name="gu_ex_${escHtml(k)}" value="${escHtml(expiresAt)}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:3px 6px;border-radius:4px;font-size:11px;font-family:monospace;color-scheme:dark" title="留空=永不过期"></td>
<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer"><input type="checkbox" name="gu_dis_${escHtml(k)}" ${disabled ? "checked" : ""} style="width:auto;accent-color:var(--red)"><span style="font-size:11px;color:${disabled ? "var(--red)" : "var(--dim)"}">${disabled ? "已禁用" : "正常"}</span></label></td>
<td><button type="button" onclick="deleteGlobalUser('${escJs(k)}')" style="background:rgba(255,56,96,.15);color:var(--red);border:none;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px">删除</button></td></tr>`;
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

  const dm = s.defaultModels || {};
  const aliasesText = formatModelAliasesInput(s.modelAliases || {});
  const settingsJson = JSON.stringify(s).replace(/</g, "\\x3c");

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>代理设置 - 团队AI Coding监控</title>
${PIXEL_FONT}
<style>
${PIXEL_THEME}
body{padding:0;overflow:hidden;height:100vh}
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
.pl-item.active{border-color:var(--accent);background:rgba(0,229,255,.08)}
.pl-name{font-size:14px;font-weight:600;margin-bottom:2px}
.pl-host{font-size:11px;color:var(--dim);font-family:monospace;word-break:break-all;margin-bottom:2px}
.pl-users{font-size:11px;color:var(--dim)}
.pl-actions{display:none;position:absolute;top:8px;right:8px;gap:4px}
.pl-item:hover .pl-actions{display:flex}
.pl-item.active .pl-actions{display:flex}
.pl-activate{font-size:10px;padding:2px 8px;border-radius:4px;border:1px solid var(--accent);background:rgba(0,229,255,.15);color:var(--accent);cursor:pointer;white-space:nowrap}
.pl-activate:hover{background:var(--accent);color:#fff}
.pl-delete{font-size:12px;padding:1px 6px;border:none;background:none;color:var(--dim);cursor:pointer;border-radius:3px}
.pl-delete:hover{background:rgba(255,56,96,.15);color:var(--red)}
.pl-badge{font-size:10px;padding:2px 8px;border-radius:4px;background:rgba(0,229,255,.2);color:var(--accent);white-space:nowrap}
.main{flex:1;overflow-y:auto;padding:20px 28px}
.main::-webkit-scrollbar{width:6px}
.main::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.main h2{font-size:14px;margin:20px 0 10px;padding-bottom:8px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between}
.main h2:first-of-type{margin-top:0}
.section{position:relative;background:var(--card);border:2px solid var(--border);padding:16px;margin-bottom:12px}
.section::before{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--accent),var(--magenta),transparent)}
label{display:block;font-size:12px;color:var(--dim);margin-bottom:4px;margin-top:10px}
label:first-child{margin-top:0}
input,select,textarea{width:100%;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;font-family:monospace;outline:none}
input:focus,select:focus,textarea:focus{border-color:var(--accent)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.btn{padding:8px 20px;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-weight:600}
.btn-primary{background:var(--accent);color:#fff}
.btn-primary:hover{opacity:.9}
.btn-danger{background:rgba(255,56,96,.15);color:var(--red)}
.btn-danger:hover{background:rgba(255,56,96,.25)}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--text)}
.btn-outline:hover{background:rgba(255,255,255,.04)}
.btn-sm{padding:4px 12px;font-size:11px}
.actions{margin-top:16px;display:flex;gap:8px;justify-content:flex-end;padding-bottom:40px}
table{width:100%;border-collapse:collapse;margin-top:8px}
th{text-align:left;padding:6px 8px;font-size:11px;color:var(--dim);border-bottom:1px solid var(--border)}
td{padding:6px 8px;border-bottom:1px solid var(--border);font-size:12px}
.status{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px}
.status-ok{background:rgba(0,255,136,.15);color:var(--green)}
.status-warn{background:rgba(255,159,28,.15);color:var(--orange)}
.status-err{background:rgba(255,56,96,.15);color:var(--red)}
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
.pl-item,.section,.modal,.preset,.btn,input,select,textarea{border-radius:0!important}/*pixel: force sharp corners over inline modal styles*/
.sidebar{border-right:2px solid var(--accent);box-shadow:var(--glow)}
.sidebar-hd h1{font-family:var(--font-pixel);font-size:11px;color:var(--accent);letter-spacing:1px}
.sidebar-hd a{font-family:'VT323',monospace;font-size:14px}
.main h2{font-family:var(--font-pixel);font-size:11px;border-bottom:2px solid var(--accent);color:var(--text);letter-spacing:1px}
.modal{border:2px solid var(--accent);box-shadow:8px 8px 0 0 var(--accent),var(--glow)}
.modal-hd h3{font-family:var(--font-pixel);font-size:12px;color:var(--accent);letter-spacing:1px}
.btn-primary{color:var(--bg);box-shadow:4px 4px 0 0 var(--magenta);transition:transform .08s,box-shadow .08s}
.btn-primary:hover{transform:translate(-2px,-2px);box-shadow:6px 6px 0 0 var(--magenta);opacity:1}
.btn-primary:active{transform:translate(2px,2px);box-shadow:1px 1px 0 0 var(--magenta)}
input,select,textarea{font-family:'VT323',monospace;font-size:14px;letter-spacing:1px}
input:focus,select:focus,textarea:focus{box-shadow:var(--glow)}
label,.note,.pl-host,.pl-users,.preset,.status{font-family:'VT323',monospace}
.pl-host,.preset{letter-spacing:.5px}
</style></head><body>
<div class="layout">
<div class="sidebar">
<div class="sidebar-hd"><h1>配置方案</h1><a href="/dashboard">← 面板</a></div>
<div class="sidebar-list">${s.profiles.map(p => {
    const host = p.upstream.replace(/^https?:\/\//, "").replace(/\/.*/, "");
    const suffixLabel = '<span style="color:var(--accent);font-size:10px">/'+ escHtml(p.suffix)+'</span>' + (p.isDefault ? ' <span style="color:var(--green);font-size:10px">默认入口</span>' : '');
    return `<div class="pl-item${p.suffix === initialSuffix ? " active" : ""}" id="pl-${escHtml(p.name)}" onclick="editProfile('${escJs(p.name)}')">
<div class="pl-name">${escHtml(p.name)} ${suffixLabel}</div>
<div class="pl-host">${escHtml(host)}</div>
<div class="pl-users">${p.userCount}位用户</div>
<div class="pl-actions">
  ${!p.isDefault ? '<button class="pl-activate" onclick="event.stopPropagation();setDefaultProfile(\'' + escJs(p.name) + '\')">设为默认</button>' : ''}
  ${!p.isDefault ? '<button class="pl-delete" onclick="event.stopPropagation();deleteProfile(\'' + escJs(p.name) + '\')">×</button>' : ''}
</div></div>`;
  }).join("")}</div>
<div class="sidebar-ft" style="display:flex;gap:6px"><button class="btn btn-outline btn-sm" onclick="openUserModal()" style="flex:1">用户管理</button><button class="btn btn-outline btn-sm" onclick="openProfileModal()" style="flex:1">+ 新增方案</button></div>
</div>
<div class="main">
${errDiv}
<form method="post" action="/api/settings-save" id="settingsForm">
<input type="hidden" name="_csrf" id="csrfToken">
<input type="hidden" name="profileName" id="profileNameInput" value="${escHtml(initialProfile.name || "")}">
<input type="hidden" name="profileSuffix" id="profileSuffixInput" value="${escHtml(initialSuffix)}">

<h2>上游代理 <span class="status ${s.circuitBreaker.state === 'CLOSED' ? 'status-ok' : s.circuitBreaker.state === 'HALF_OPEN' ? 'status-warn' : 'status-err'}">${s.circuitBreaker.state === 'CLOSED' ? '正常' : s.circuitBreaker.state === 'HALF_OPEN' ? '探测中' : '熔断中'}</span></h2>
<div class="section">
<div class="row3">
<div><label>接口协议<span class="req">*</span></label><select name="apiProtocol" id="apiProtocolSelect" onchange="updateProtocolFields()"><option value="anthropic" ${s.apiProtocol === "anthropic" ? "selected" : ""}>Anthropic / Claude Code</option><option value="openai" ${s.apiProtocol === "openai" ? "selected" : ""}>OpenAI-compatible / Codex</option></select></div>
<div><label>上游 API 地址<span class="req">*</span></label><input type="text" name="upstream" value="${s.upstream}" placeholder="https://open.bigmodel.cn/api/anthropic"></div>
<div><label>URL 后缀 <span style="font-size:11px;color:var(--dim);font-weight:400">(所有方案必填)</span></label><input type="text" name="suffix" id="suffixInput" value="${escHtml(initialSuffix)}" placeholder="如: glm" oninput="updateAccessUrl()"></div>
</div>
<label style="display:flex;align-items:center;gap:6px;margin-top:12px"><input type="checkbox" name="openaiStreamUsage" id="openaiStreamUsageInput" ${s.openaiStreamUsage ? "checked" : ""} style="width:auto"> OpenAI 流式请求自动请求 usage 统计</label>
<div id="responsesAdapterRow" style="margin-top:12px">
<label>Responses 兼容模式</label>
<select name="responsesAdapter" id="responsesAdapterSelect" onchange="updateAccessUrl()">
  <option value="none" ${s.responsesAdapter === "none" ? "selected" : ""}>透明转发 /v1/responses</option>
  <option value="chat_completions" ${s.responsesAdapter === "chat_completions" ? "selected" : ""}>将 /v1/responses 转为 /v1/chat/completions</option>
</select>
<div class="note">所有 OpenAI 方案的 /v1/models 都由本平台按允许模型列表本地返回，避免客户端探测打到上游。上游只有 Chat Completions、没有 Responses 端点时启用此兼容模式。</div>
</div>
<div class="note" id="accessUrlPreview" style="margin-top:8px;color:var(--green)">接入地址: http://&lt;host&gt;:6789/v1</div>
<div class="presets">
  <span style="font-size:11px;color:var(--dim);line-height:24px">快速填充：</span>
  <button type="button" class="preset" onclick="fillUpstream('anthropic','https://open.bigmodel.cn/api/anthropic')">智谱 GLM Anthropic</button>
  <button type="button" class="preset" onclick="fillUpstream('anthropic','https://api.anthropic.com')">Anthropic</button>
  <button type="button" class="preset" onclick="fillUpstream('openai','https://api.openai.com/v1')">OpenAI</button>
  <button type="button" class="preset" onclick="fillUpstream('anthropic','https://api.deepseek.com/anthropic')">DeepSeek Anthropic</button>
  <button type="button" class="preset" onclick="fillUpstream('openai','https://api.deepseek.com/v1')">DeepSeek OpenAI</button>
  <button type="button" class="preset" onclick="fillUpstream('openai','https://dashscope.aliyuncs.com/compatible-mode/v1')">阿里百炼 OpenAI</button>
  <button type="button" class="preset" onclick="fillUpstream('openai','https://coding.dashscope.aliyuncs.com/v1','chat_completions')">阿里 Coding OpenAI</button>
  <button type="button" class="preset" onclick="fillUpstream('anthropic','https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic')">阿里Token Plan</button>
</div>
<div class="note" style="margin-top:8px">状态：${s.circuitBreaker.state === 'CLOSED' ? '正常运行' : s.circuitBreaker.state === 'HALF_OPEN' ? '探测恢复中...' : '熔断中(' + Math.ceil(s.circuitBreaker.cooldownRemaining / 1000) + 's)'} | 失败 ${s.circuitBreaker.failureCount} | 成功 ${s.circuitBreaker.totalSuccesses} | 失败 ${s.circuitBreaker.totalFailures}</div>
</div>

<h2><span id="modelConfigTitle">模型配置</span> <span id="modelConfigHint" style="font-size:11px;color:var(--dim);font-weight:400"></span></h2>
<div class="section">
<div id="anthropicAliasFields">
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
<div id="openaiModelFields" style="display:none">
<div class="note" style="margin-top:0;color:var(--green)">Codex/OpenAI 请求会携带真实 model，网关不需要配置 sonnet/opus/haiku 三档模型。下方只需要放行真实模型；模型别名是可选项。</div>
</div>
<label id="modelAliasesLabel">可选模型别名（每行 alias=实际模型）</label>
<textarea name="modelAliases" id="modelAliasesInput" rows="4" placeholder="codex-main=gpt-5&#10;codex-fast=gpt-5-mini">${escHtml(aliasesText)}</textarea>
<div class="note" id="modelAliasesNote">用于自定义别名映射到真实模型；留空表示客户端直接使用真实模型名。</div>
<div class="presets" id="openaiAliasPresets">
  <span style="font-size:11px;color:var(--dim);line-height:24px">快速填充：</span>
  <button type="button" class="preset" onclick="fillOpenAIAliases()">Codex OpenAI</button>
</div>
</div>

<h2>允许模型<span class="req">*必填</span></h2>
<div class="section">
<label>可用模型列表 (逗号分隔，至少1个)<span class="req">*必填</span></label>
<input type="text" name="allowedModels" id="allowedModelsInput" value="${(s.allowedModels || []).join(",")}" placeholder="必填，如: deepseek-v4-pro, deepseek-v4-flash" required>
<div class="note" id="allowedModelsNote">不在列表中的模型请求将被拦截返回403。Anthropic 三档别名映射的目标模型会自动添加到此列表。</div>
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
${((() => { const qa = stmts.quotaAdjustRecent.all(); return qa.length > 0 ? `<h4 style="font-size:13px;color:var(--accent);margin:16px 0 8px">调整历史</h4><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">时间</th><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">用户</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">旧配额</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">新配额</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">命中率</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">日均用量</th></tr></thead><tbody>${qa.map(h => `<tr><td style="padding:4px 8px">${h.date}</td><td style="padding:4px 8px">${h.user_name || h.user_key.slice(0, 8)}</td><td style="text-align:right;padding:4px 8px">${(h.old_quota || 0).toLocaleString()}</td><td style="text-align:right;padding:4px 8px;color:var(--green)">${(h.new_quota || 0).toLocaleString()}</td><td style="text-align:right;padding:4px 8px">${Math.round((h.hit_rate || 0) * 100)}%</td><td style="text-align:right;padding:4px 8px">${(h.avg_daily_usage || 0).toLocaleString()}</td></tr>`).join("")}</tbody></table>` : '<div class="note" style="margin-top:8px">暂无自动调整记录</div>'; })())}
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
<div class="modal-hd"><h3>新增方案</h3><button class="modal-close" onclick="closeProfileModal()">&times;</button></div>
<div class="modal-body">
<div class="row3">
<div><label>方案名称<span class="req">*</span></label><input type="text" id="newProfileName" placeholder="如: GLM 项目组"></div>
<div><label>URL 后缀<span class="req">*</span></label><input type="text" id="newProfileSuffix" placeholder="如: glm"></div>
<div><label>接口协议<span class="req">*</span></label><select id="newProfileProtocol" onchange="updateNewProfileFields()"><option value="anthropic">Anthropic / Claude Code</option><option value="openai">OpenAI-compatible / Codex</option></select></div>
</div>
<div id="newProfileResponsesAdapterRow" style="display:none">
<label>Responses 兼容模式</label>
<select id="newProfileResponsesAdapter">
  <option value="none">透明转发 /v1/responses</option>
  <option value="chat_completions">将 /v1/responses 转为 /v1/chat/completions</option>
</select>
</div>
<label>上游 API 地址<span class="req">*</span></label><input type="text" id="newProfileUpstream" value="${escHtml(initialProfile.upstream || s.upstream || "")}" placeholder="https://open.bigmodel.cn/api/anthropic">
<label>允许模型</label><input type="text" id="newProfileModels" value="${escHtml((initialProfile.allowedModels || s.allowedModels || []).join(","))}" placeholder="glm-5.1,qwen-max">
<label>模型别名（每行 alias=实际模型，可选）</label><textarea id="newProfileAliases" rows="3" placeholder="codex-main=gpt-5&#10;codex-fast=gpt-5-mini"></textarea>
<div class="note">创建后会出现在左侧方案列表。默认入口可在左侧点击“设为默认”。</div>
<div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
<button type="button" class="btn btn-outline btn-sm" onclick="closeProfileModal()">取消</button>
<button type="button" class="btn btn-primary btn-sm" onclick="createProfile()">创建方案</button>
</div>
</div>
</div>
</div>
<script>
const SETTINGS=${settingsJson};
function getCsrf(){const m=document.cookie.match(/tm_csrf=([^;]+)/);return m?m[1]:''}
document.getElementById('csrfToken').value=getCsrf();
function csrfHeaders(h){h=h||{};h['x-csrf-token']=getCsrf();return h}
function h(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function aliasText(aliases){return Object.entries(aliases||{}).map(([a,m])=>a+'='+m).join('\\n')}
function currentProtocol(){return document.getElementById('apiProtocolSelect').value||'anthropic'}
function updateProtocolFields(){
  const protocol=currentProtocol();
  const streamRow=document.getElementById('openaiStreamUsageInput')?.closest('label');
  if(streamRow)streamRow.style.display=protocol==='openai'?'flex':'none';
  const adapterRow=document.getElementById('responsesAdapterRow');
  if(adapterRow)adapterRow.style.display=protocol==='openai'?'block':'none';
  const anthropicFields=document.getElementById('anthropicAliasFields');
  const openaiFields=document.getElementById('openaiModelFields');
  const openaiPresets=document.getElementById('openaiAliasPresets');
  if(anthropicFields)anthropicFields.style.display=protocol==='openai'?'none':'block';
  if(openaiFields)openaiFields.style.display=protocol==='openai'?'block':'none';
  if(openaiPresets)openaiPresets.style.display=protocol==='openai'?'flex':'none';
  const title=document.getElementById('modelConfigTitle');
  const hint=document.getElementById('modelConfigHint');
  if(title)title.textContent=protocol==='openai'?'OpenAI / Codex 模型':'Claude 模型别名';
  if(hint)hint.textContent=protocol==='openai'?'真实模型直传，可选 alias':'jx-sonnet / jx-opus / jx-haiku';
  const aliasLabel=document.getElementById('modelAliasesLabel');
  if(aliasLabel)aliasLabel.textContent=protocol==='openai'?'可选模型别名（每行 alias=实际模型）':'通用模型别名（每行 alias=实际模型，可选）';
  const aliasNote=document.getElementById('modelAliasesNote');
  if(aliasNote)aliasNote.textContent=protocol==='openai'?'Codex 可直接使用真实模型名；只有需要自定义短名称时才填写这里。':'jx-* 三个别名由上方字段生成；这里可额外增加自定义别名。';
  const allowed=document.getElementById('allowedModelsInput');
  if(allowed)allowed.placeholder=protocol==='openai'?'必填，如: gpt-5, qwen3-coder-plus, glm-5':'必填，如: deepseek-v4-pro, deepseek-v4-flash';
  const allowedNote=document.getElementById('allowedModelsNote');
  if(allowedNote)allowedNote.textContent=protocol==='openai'?'Codex/OpenAI 请求中的 model 必须在此列表中；留空不会放行。':'不在列表中的模型请求将被拦截返回403。Anthropic 三档别名映射的目标模型会自动添加到此列表。';
  const up=document.querySelector('[name=upstream]');
  if(up)up.placeholder=protocol==='openai'?'https://api.openai.com/v1 或 compatible-mode/v1':'https://open.bigmodel.cn/api/anthropic';
  updateAccessUrl();
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
  const protocol=currentProtocol();
  const endpoint=protocol==='openai'?'/v1/responses 或 /v1/chat/completions':'/v1/messages';
  const adapter=document.getElementById('responsesAdapterSelect')?.value||'none';
  const adapterNote=protocol==='openai'&&adapter==='chat_completions'?' <span style="color:var(--orange)">已启用 Responses→Chat 适配</span>':'';
  document.getElementById('accessUrlPreview').innerHTML='接入地址: http://&lt;host&gt;:6789/'+h(sfx)+endpoint+defaultNote+adapterNote;
}
updateProtocolFields();
async function editProfile(n){
  const p=SETTINGS.profiles.find(x=>x.name===n);
  if(!p)return;
  editingProfileName=n;
  const fm=document.forms.settingsForm;
  fm.apiProtocol.value=p.apiProtocol||'anthropic';
  fm.upstream.value=p.upstream||'';
  document.getElementById('suffixInput').value=p.suffix||'';
  document.getElementById('profileNameInput').value=p.name||'';
  if(p.allowedModels)fm.allowedModels.value=p.allowedModels.join(', ');
  fm.defaultModels_sonnet.value=p.defaultModels?.sonnet||'';
  fm.defaultModels_opus.value=p.defaultModels?.opus||'';
  fm.defaultModels_haiku.value=p.defaultModels?.haiku||'';
  if(fm.modelAliases)fm.modelAliases.value=aliasText(p.modelAliases||{});
  const osu=document.getElementById('openaiStreamUsageInput');
  if(osu)osu.checked=p.openaiStreamUsage!==false;
  if(fm.responsesAdapter)fm.responsesAdapter.value=p.responsesAdapter||'none';
  if(fm.profileQuota)fm.profileQuota.value=p.dailyTokenLimit||0;
  document.querySelectorAll('.pl-item').forEach(el=>el.classList.remove('active'));
  const el=document.getElementById('pl-'+n);
  if(el)el.classList.add('active');
  document.getElementById('profileSuffixInput').value=p.suffix||'';
  const userSel=document.getElementById('userProfileSel');
  if(userSel){userSel.value=p.suffix||'';renderProfileUsers(p.suffix||'')}
  updateProtocolFields();
}
async function createProfile(){
  const name=document.getElementById('newProfileName').value.trim();
  const suffix=document.getElementById('newProfileSuffix').value.trim();
  const apiProtocol=document.getElementById('newProfileProtocol').value;
  const upstream=document.getElementById('newProfileUpstream').value.trim();
  const models=document.getElementById('newProfileModels').value.trim();
  const modelAliases=document.getElementById('newProfileAliases').value.trim();
  const responsesAdapter=document.getElementById('newProfileResponsesAdapter').value||'none';
  if(!name||!suffix||!upstream){alert('方案名称、URL 后缀和上游 API 地址必填');return}
  const fm=document.forms.settingsForm;
  const r=await fetch('/api/profile/save',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({
    profile:name,suffix:suffix,apiProtocol:apiProtocol,upstream:upstream,allowedModels:models||fm.allowedModels.value,
    defaultModels:apiProtocol==='anthropic'?{sonnet:fm.defaultModels_sonnet.value,opus:fm.defaultModels_opus.value,haiku:fm.defaultModels_haiku.value}:undefined,
    modelAliases:modelAliases,
    openaiStreamUsage:true,
    responsesAdapter:apiProtocol==='openai'?responsesAdapter:'none'
  })});
  if(r.ok)location.reload();else{const e=await r.json();alert('创建失败: '+e.error)}
}
async function setDefaultProfile(n){
  const r=await fetch('/api/profile/default',{method:'POST',headers:csrfHeaders({'Content-Type':'application/json'}),body:JSON.stringify({profile:n})});
  if(r.ok)location.reload();else{const e=await r.json();alert('设置失败: '+e.error)}
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
    +'<td><button type="button" onclick="this.closest(\\'tr\\').remove()" style="background:rgba(255,56,96,.15);color:var(--red);border:none;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px">删除</button></td>';
  tbody.appendChild(tr);
  SETTINGS.globalUsers[vk]={username:'',expiresAt:'',disabled:false};
  for(const p of SETTINGS.profiles){if(!SETTINGS.profileAssignments[p.suffix])SETTINGS.profileAssignments[p.suffix]={}}
  renderProfileUsers(document.getElementById('userProfileSel').value);
}
function fillDefaults(s,o,h){
  document.querySelector('[name=defaultModels_sonnet]').value=s;
  document.querySelector('[name=defaultModels_opus]').value=o;
  document.querySelector('[name=defaultModels_haiku]').value=h;
}
function fillOpenAIAliases(){
  const fm=document.forms.settingsForm;
  fm.apiProtocol.value='openai';
  fm.modelAliases.value='codex-main=gpt-5\\ncodex-fast=gpt-5-mini';
  if(fm.responsesAdapter)fm.responsesAdapter.value='none';
  updateProtocolFields();
}
function fillUpstream(protocol,url,responsesAdapter){
  document.forms.settingsForm.apiProtocol.value=protocol;
  document.querySelector('[name=upstream]').value=url;
  const adapter=document.getElementById('responsesAdapterSelect');
  if(adapter)adapter.value=protocol==='openai'?(responsesAdapter||'none'):'none';
  updateProtocolFields();
}
function updateNewProfileFields(){
  const protocol=document.getElementById('newProfileProtocol').value;
  const row=document.getElementById('newProfileResponsesAdapterRow');
  if(row)row.style.display=protocol==='openai'?'block':'none';
  if(protocol!=='openai')document.getElementById('newProfileResponsesAdapter').value='none';
}
updateNewProfileFields();
document.addEventListener("keydown",e=>{if(e.key==="Enter"&&e.target.tagName!=="TEXTAREA"&&e.target.tagName!=="INPUT")e.preventDefault()});
</script>
</body></html>`;
}

// ─── Dashboard HTML ──────────────────────────────────────────────────────────
function dashboardHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>团队AI Coding监控</title>
${PIXEL_FONT}
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
${PIXEL_THEME}
body{padding:22px 26px}
.top,.meta,.tabs,.grid,.box,.sec{animation:boot-in .45s ease-out both}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px}
.top h1{font-family:var(--font-pixel);font-size:18px;color:var(--accent);text-shadow:0 0 14px rgba(34,233,255,.7),0 0 4px rgba(34,233,255,.9);letter-spacing:1px;line-height:1.6}
.top h1::after{content:"";display:block;width:130px;height:3px;margin-top:8px;background:linear-gradient(90deg,var(--accent),var(--magenta),transparent);box-shadow:0 0 8px var(--accent)}
.top .sub{font-family:'Pixelify Sans',monospace;font-weight:500;font-size:15px;color:var(--dim);letter-spacing:1px;margin-top:8px;display:flex;align-items:center;gap:7px}
.top .sub b{color:var(--green);font-weight:600;letter-spacing:2px}
.controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.controls select,.controls a,.controls button{font-family:'VT323',monospace;font-size:15px;background:var(--card);color:var(--text);border:2px solid var(--border);padding:5px 11px;cursor:pointer;letter-spacing:1px;text-decoration:none;line-height:1.4}
.controls select:focus,.controls a:hover,.controls button:hover{border-color:var(--accent);color:var(--accent)}
.controls .ar-on{border-color:var(--green);color:var(--green);box-shadow:0 0 8px rgba(0,255,136,.35)}
.controls .ar-off{color:var(--dim)}
.meta{font-family:'VT323',monospace;font-size:15px;color:var(--dim);margin-bottom:18px;letter-spacing:1px;border-left:3px solid var(--accent);padding:2px 0 2px 10px}
.meta b{color:var(--accent);font-weight:400}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:22px}
.card{background:linear-gradient(180deg,var(--card2),var(--card));border:2px solid var(--border);padding:16px 16px 14px;position:relative;overflow:hidden;transition:transform .12s,border-color .12s,box-shadow .12s}
.card::after{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--accent),var(--magenta));opacity:.9}
.card:hover{transform:translate(-3px,-3px);border-color:var(--accent);box-shadow:5px 5px 0 0 var(--accent),-3px -3px 0 0 var(--magenta),var(--glow)}
.card .l{font-family:'Pixelify Sans',monospace;font-weight:600;font-size:14px;color:var(--dim);margin-bottom:8px;letter-spacing:1px;text-transform:uppercase}
.card .v{font-size:15px}
.tabs{display:flex;gap:4px;margin-bottom:16px;background:var(--card);border:2px solid var(--border);padding:3px;width:fit-content}
.tab{padding:6px 16px;font-family:'VT323',monospace;font-size:15px;border:none;background:transparent;color:var(--dim);cursor:pointer;letter-spacing:1px}
.tab:hover{color:var(--text)}
.tab.on{background:var(--accent);color:var(--bg);font-weight:700}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:20px}
.box{position:relative;background:var(--card);border:2px solid var(--border);padding:16px}
.box::before,.box::after{content:"";position:absolute;width:12px;height:12px;border:2px solid var(--accent);pointer-events:none;opacity:.6}
.box::before{top:-2px;left:-2px;border-right:0;border-bottom:0}.box::after{bottom:-2px;right:-2px;border-left:0;border-top:0}
.box h3{font-family:'Pixelify Sans',monospace;font-weight:600;font-size:15px;color:var(--accent);margin-bottom:10px;letter-spacing:1px;text-transform:uppercase;text-shadow:0 0 8px rgba(34,233,255,.5)}
.box h3::before{content:"// ";color:var(--magenta)}
.box canvas{max-height:260px}
.sec{background:var(--card);border:2px solid var(--border);overflow:hidden;margin-bottom:20px}
.sec>h3{font-family:'Pixelify Sans',monospace;font-weight:600;font-size:15px;color:var(--accent);padding:12px 16px 0;margin:0;letter-spacing:1px;text-transform:uppercase;text-shadow:0 0 8px rgba(34,233,255,.5)}
.sec-collapsible h3{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;padding:12px 16px}
.sec-collapsible h3:hover{color:var(--text)}
.sec-toggle{display:inline-block;width:16px;font-size:10px;transition:transform .2s;flex-shrink:0;color:var(--accent)}
.sec-toggle.open{transform:rotate(90deg)}
.sec-hint{font-family:'VT323',monospace;font-size:13px;color:var(--dim);font-weight:400;margin-left:auto}
.sec-body{display:none;padding:0 16px 12px}
.sec-body.open{display:block}
.sec-body table{margin-top:0}
.sec-body .empty{padding:16px 0}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:8px 16px;font-family:'Pixelify Sans',monospace;font-weight:600;font-size:13px;color:#b4bcd9;border-bottom:2px solid var(--accent);letter-spacing:1px;text-transform:uppercase}
td{padding:8px 16px;font-size:14px;border-bottom:1px solid var(--border)}
tr:last-child td{border-bottom:none}tbody tr{transition:background .1s}tbody tr:hover td{background:rgba(0,229,255,.05)}
.n{font-variant-numeric:tabular-nums;text-align:right}
.hl{color:var(--accent);font-weight:600}
code{font-family:'VT323',monospace;color:var(--accent);font-size:14px}
.empty{font-family:'VT323',monospace;color:var(--dim);padding:24px;text-align:center;font-size:15px;letter-spacing:1px}
@media(max-width:768px){.grid{grid-template-columns:1fr}.cards{grid-template-columns:1fr 1fr}}
</style></head><body>
<div class="top"><div><h1 class="glitch">CODING MONITOR</h1><div class="sub"><span class="eq"><i></i><i></i><i></i><i></i></span>团队 AI 用量监控 <b>// LIVE</b></div></div><div class="controls"><select id="profileSel" onchange="switchProfileView(this.value)"><option value="">全部方案</option></select><a href="/settings">设置</a><button id="autoRefreshBtn" class="ar-on">自动刷新: 开</button><button onclick="fetch('/api/logout',{method:'POST',headers:{'x-csrf-token':(document.cookie.match(/tm_csrf=([^;]+)/)||[])[1]||''}}).then(()=>location.reload())">退出</button></div></div>
<div class="meta" id="meta">Loading...</div>
<div class="cards" id="cards"></div>
<div class="sec" id="profileSummarySec" style="display:none"><h3>方案中心</h3><table><thead><tr><th>方案</th><th>入口</th><th>上游</th><th class="n">今日请求</th><th class="n">今日用量</th><th>状态</th></tr></thead><tbody id="profileSummaryBody"></tbody></table></div>
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
<div class="sec sec-collapsible" id="errorSec"><h3 onclick="toggleSec('errorSec')"><span class="sec-toggle" id="errorSecIcon">▶</span>错误记录<span id="errorCount" style="font-size:11px;color:var(--red);font-weight:400;margin-left:4px"></span><span class="sec-hint" id="errorHint" style="margin-left:auto"></span><button id="clearErrors" onclick="event.stopPropagation()" style="font-family:'VT323',monospace;font-size:14px;background:rgba(255,56,96,.15);color:var(--red);border:1px solid var(--red);padding:2px 10px;cursor:pointer;margin-left:8px;letter-spacing:1px">清除</button></h3><div class="sec-body" id="errorSecBody"><table id="eTable"><thead>
<tr><th>时间</th><th>用户</th><th class="n">状态码</th><th>模型</th><th>路径</th><th>错误信息</th></tr>
</thead><tbody></tbody></table>
<div id="errPages" style="padding:8px 0;text-align:right"></div></div></div>
<script>
${PIXEL_JS}
Chart.defaults.color='#9aa0c8';Chart.defaults.font.family="'Pixelify Sans',monospace";Chart.defaults.font.size=11;
let D=null,P="day",C={t:null,p:null,m:null,h:null},errPage=1,autoRefresh=true,refreshTimer=null,currentProfile="all";
const ERR_PAGE_SIZE=20;
const COL=["#00e5ff","#ff2d95","#00ff88","#ffd23f","#b14eff","#ff3860","#29e7ff","#ff9f1c"];
const escH=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtT=n=>n.toLocaleString("zh-CN");
const fmtTk=n=>{if(n>=1e6)return(n/1e6).toFixed(1)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return n.toString()};
function fmtBJ(iso){if(!iso)return"-";const d=new Date(iso);const utc=d.getTime()+d.getTimezoneOffset()*60000;return new Date(utc+8*3600000).toLocaleString("zh-CN")};
function ago(iso){if(!iso)return"-";const d=Date.now()-new Date(iso).getTime();const m=Math.floor(d/6e4);if(m<1)return"刚刚";if(m<60)return m+"分钟前";const h=Math.floor(m/60);if(h<24)return h+"小时前";return Math.floor(h/24)+"天前"}
function wk(s){const d=new Date(s),day=d.getDay()||7,mon=new Date(d);mon.setDate(d.getDate()-day+1);return mon.toISOString().slice(0,10)}
function grp(daily,p){const g={};for(const[day,ud]of Object.entries(daily)){const k=p==="week"?wk(day):p==="month"?day.slice(0,7):p==="year"?day.slice(0,4):day;if(!g[k])g[k]={};for(const[u,s]of Object.entries(ud)){if(!g[k][u])g[k][u]={inputTokens:0,outputTokens:0,requests:0,cacheCreationTokens:0,cacheReadTokens:0};g[k][u].inputTokens+=s.inputTokens;g[k][u].outputTokens+=s.outputTokens;g[k][u].requests+=s.requests;g[k][u].cacheCreationTokens+=(s.cacheCreationTokens||0);g[k][u].cacheReadTokens+=(s.cacheReadTokens||0)}}return g}
function lbl(p,k){if(p==="day")return k.slice(5);if(p==="week")return k.slice(5)+" 周";if(p==="month")return k;return k+"年"}
function c(l,v,cl,k){return'<div class="card"><div class="l">'+l+'</div><div class="v" data-cu="'+v+'"'+(k?' data-cu-k':'')+' style="color:'+cl+'">0</div></div>'}
function switchProfileView(v){currentProfile=v||"all";load()}
function render(){
  if(!D)return;
  // Populate profile dropdown
  const sel=document.getElementById("profileSel");
  if(sel.options.length<=1 && D.profiles){
    sel.innerHTML='<option value="all">📊 全部方案</option>';
    for(const p of D.profiles){
      const sfx="/"+p.suffix+(p.isDefault?" · 默认入口":"");
      sel.innerHTML+='<option value="'+escH(p.suffix)+'">'+escH(p.name)+' '+sfx+'</option>';
    }
    sel.value=currentProfile==="all"?"all":currentProfile;
  }
  const us=Object.values(D.users),ti=us.reduce((s,u)=>s+u.totalInputTokens,0),to=us.reduce((s,u)=>s+u.totalOutputTokens,0),tr=us.reduce((s,u)=>s+u.totalRequests,0);
  const td=new Date(Date.now()+8*36e5).toISOString().slice(0,10),tdd=(D.daily||{})[td]||{};
  const tIn=Object.values(tdd).reduce((s,d)=>s+d.inputTokens,0),tOut=Object.values(tdd).reduce((s,d)=>s+d.outputTokens,0),tR=Object.values(tdd).reduce((s,d)=>s+d.requests,0);
  document.getElementById("cards").innerHTML=c("今日用量",tIn+tOut,"var(--accent)",1)+c("今日请求",tR,"var(--blue)",1)+c("总用量",ti+to,"var(--green)",1)+c("总请求",tr,"var(--orange)",1)+c("今日错误",(Array.isArray(D.errors)?D.errors:[]).filter(e=>e.time&&e.time.startsWith(td)).length,"var(--red)",1);
  runCountUps(document.getElementById("cards"));
  const ps=document.getElementById("profileSummarySec"),psb=document.getElementById("profileSummaryBody");
  if(currentProfile==="all"&&Array.isArray(D.profileSummaries)){ps.style.display="block";psb.innerHTML=D.profileSummaries.map(p=>{const st=p.breakerState||"UNKNOWN";const col=st==="CLOSED"?"var(--green)":st==="HALF_OPEN"?"var(--orange)":"var(--red)";const led=st==="CLOSED"?"on":st==="HALF_OPEN"?"warn":"err";const lbl=st==="CLOSED"?"正常":st==="HALF_OPEN"?"探测中":"熔断";return'<tr><td>'+escH(p.name)+(p.isDefault?' <span style="color:var(--green);font-family:var(--font-pixel);font-size:9px;vertical-align:middle">DEF</span>':'')+'</td><td><code>/'+escH(p.suffix)+'</code>'+(p.isDefault?' <span style="color:var(--dim)">/ <code>/v1</code></span>':'')+'</td><td style="font-size:13px;color:var(--dim);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escH((p.upstream||'').replace('https://','').replace('http://',''))+'</td><td class="n">'+fmtT(p.todayRequests||0)+'</td><td class="n hl">'+fmtT(p.todayTokens||0)+'</td><td><span class="led '+led+'"></span><span style="color:'+col+';font-size:13px">'+lbl+'</span></td></tr>'}).join('')}else{ps.style.display="none"}
  const profileLabel=D.profileView||(currentProfile==="all"?"全部方案":"默认方案");
  const upstreamInfo=D.upstream?(" | 上游: "+D.upstream.replace("https://","").replace("http://","")):"";
  document.getElementById("meta").innerHTML='<span style="color:var(--accent);font-weight:600">方案: '+profileLabel+'</span>'+upstreamInfo+' &nbsp;|&nbsp; 更新于 '+(function(){const d=new Date();const utc=d.getTime()+d.getTimezoneOffset()*60000;return new Date(utc+8*3600000).toLocaleTimeString("zh-CN")})()+" (北京时间) | 每30秒刷新";

  // Charts
  const g=grp(D.daily||{},P),keys=Object.keys(g).sort(),uks=Object.keys(D.users);
  if(C.t)C.t.destroy();if(C.p)C.p.destroy();if(C.m)C.m.destroy();if(C.h)C.h.destroy();
  C.t=new Chart(document.getElementById("trend"),{type:"bar",data:{labels:keys.map(k=>lbl(P,k)),datasets:uks.map((u,i)=>({label:D.users[u].name,data:keys.map(k=>(g[k][u]||{}).inputTokens+(g[k][u]||{}).outputTokens||0),backgroundColor:COL[i%COL.length]+"cc",borderRadius:3,borderSkipped:false}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:"#9aa0c8",font:{size:11}}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{stacked:true,ticks:{color:"#6f6f8f",font:{size:10}},grid:{color:"rgba(0,229,255,.08)"}},y:{stacked:true,ticks:{color:"#6f6f8f",callback:v=>fmtTk(v)},grid:{color:"rgba(0,229,255,.08)"}}}}});
  const tot=uks.map(u=>{let t=0;for(const k of keys)t+=(g[k][u]||{}).inputTokens+(g[k][u]||{}).outputTokens||0;return t});
  C.p=new Chart(document.getElementById("pie"),{type:"doughnut",data:{labels:uks.map(k=>D.users[k].name),datasets:[{data:tot,backgroundColor:uks.map((_,i)=>COL[i%COL.length]+"cc"),borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"right",labels:{color:"#9aa0c8",font:{size:11},padding:12}},tooltip:{callbacks:{label:ctx=>ctx.label+": "+fmtT(ctx.raw)+" tokens"}}},cutout:"55%"}});

  // 模型分布
  const mods=D.models||{};const mNames=Object.keys(mods);
  C.m=new Chart(document.getElementById("modelChart"),{type:"doughnut",data:{labels:mNames,datasets:[{data:mNames.map(m=>mods[m].tokens),backgroundColor:mNames.map((_,i)=>COL[i%COL.length]+"cc"),borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"right",labels:{color:"#9aa0c8",font:{size:11},padding:12}},tooltip:{callbacks:{label:ctx=>ctx.label+": "+fmtT(ctx.raw)+" tokens"}}},cutout:"55%"}});

  // 24小时趋势图
  const hrs=[];for(let i=0;i<24;i++)hrs.push(i.toString().padStart(2,"0")+":00");
  const todayHourly=(D.hourly||{})[td]||{};
  const hReq=hrs.map((_,i)=>{const h=todayHourly[i.toString().padStart(2,"0")];return typeof h==="object"?(h.requests||0):0});
  const hIn=hrs.map((_,i)=>{const h=todayHourly[i.toString().padStart(2,"0")];return typeof h==="object"?(h.inputTokens||0):0});
  const hOut=hrs.map((_,i)=>{const h=todayHourly[i.toString().padStart(2,"0")];return typeof h==="object"?(h.outputTokens||0):0});
  C.h=new Chart(document.getElementById("hourChart"),{type:"line",data:{labels:hrs,datasets:[{label:"请求数",data:hReq,borderColor:"#29e7ff",backgroundColor:"rgba(41,231,255,.12)",fill:true,tension:.4,pointRadius:3,pointBackgroundColor:"#29e7ff",pointHoverRadius:6,borderWidth:2.5,yAxisID:"y"},{label:"输入",data:hIn,borderColor:"#b14eff",backgroundColor:"rgba(177,78,255,.12)",fill:true,tension:.4,pointRadius:3,pointBackgroundColor:"#b14eff",pointHoverRadius:6,borderWidth:2.5,yAxisID:"y1"},{label:"输出",data:hOut,borderColor:"#ff3860",backgroundColor:"rgba(255,56,96,.12)",fill:true,tension:.4,pointRadius:3,pointBackgroundColor:"#ff3860",pointHoverRadius:6,borderWidth:2.5,yAxisID:"y1"}]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:{labels:{color:"#9aa0c8",font:{size:11},usePointStyle:true,pointStyle:"circle"}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+": "+fmtT(ctx.raw)}}},scales:{x:{ticks:{color:"#6f6f8f",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{type:"linear",position:"left",ticks:{color:"#29e7ff"},grid:{color:"rgba(0,229,255,.08)"},title:{display:true,text:"请求数",color:"#29e7ff",font:{size:10}}},y1:{type:"linear",position:"right",ticks:{color:"#b14eff",callback:v=>fmtTk(v)},grid:{drawOnChartArea:false},title:{display:true,text:"Tokens",color:"#b14eff",font:{size:10}}}}}});

  // User table
  const ut=document.querySelector("#uTable tbody");
  const ul=Object.entries(D.users).sort((a,b)=>(b[1].totalInputTokens+b[1].totalOutputTokens)-(a[1].totalInputTokens+a[1].totalOutputTokens));
  if(!ul.length){ut.innerHTML='<tr><td colspan="10" class="empty">暂无数据</td></tr>'}else{ut.innerHTML=ul.map(([uk,u],idx)=>{const on=u.lastActive&&Date.now()-new Date(u.lastActive).getTime()<36e5;const uq=(D.userQuotas||{})[uk]||D.profileQuota||0;const td2=(D.daily||{})[td]||{};const tdu=td2[uk]||{inputTokens:0,outputTokens:0};const used=tdu.inputTokens+tdu.outputTokens;const qPct=uq>0?Math.min(100,Math.round(used/uq*100)):0;const medal=idx<3?['🥇','🥈','🥉'][idx]+' ':'<span style="display:inline-block;width:1.2em"></span>';const qCell=uq>0?'<span style="color:var(--accent);font-size:12px">'+qPct+'%</span> '+hpBar(qPct,12):'<span style="color:var(--dim)">-</span>';return'<tr><td>'+medal+u.name+'</td><td><span class="led '+(on?'on':'')+'"></span><span style="color:'+(on?'var(--green)':'var(--dim)')+';font-size:12px">'+(on?'在线':'离线')+'</span></td><td class="n">'+fmtT(u.totalRequests)+'</td><td class="n">'+fmtT(u.totalInputTokens)+'</td><td class="n">'+fmtT(u.totalOutputTokens)+'</td><td class="n">'+fmtT(u.cacheCreationTokens || 0)+'</td><td class="n">'+fmtT(u.cacheReadTokens || 0)+'</td><td class="n hl">'+fmtT(u.totalInputTokens+u.totalOutputTokens)+'</td><td class="n" style="white-space:nowrap">'+qCell+'</td><td style="font-size:12px;color:var(--dim)">'+ago(u.lastActive)+'</td></tr>'}).join("")}

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
document.getElementById("autoRefreshBtn").addEventListener("click",()=>{autoRefresh=!autoRefresh;const btn=document.getElementById("autoRefreshBtn");btn.textContent="自动刷新: "+(autoRefresh?"开":"关");btn.className=autoRefresh?"ar-on":"ar-off"});
load();startAutoRefresh();
<\/script></body></html>`;
}

// ─── Login Page HTML ─────────────────────────────────────────────────────────
function loginHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>团队AI Coding监控 - ACCESS</title>
${PIXEL_FONT}
<style>
${PIXEL_THEME}
body{display:flex;justify-content:center;align-items:center;height:100vh;padding:20px}
.wrap{width:100%;max-width:380px}
.brand{text-align:center;margin-bottom:20px}
.brand .t{font-family:var(--font-pixel);font-size:15px;color:var(--accent);text-shadow:var(--glow);letter-spacing:1px}
.brand .s{font-family:'VT323',monospace;font-size:17px;color:var(--dim);margin-top:10px;letter-spacing:3px}
.term{padding:30px 28px}
.term .hd{font-family:'VT323',monospace;font-size:16px;color:var(--green);margin-bottom:18px;border-bottom:1px dashed var(--border);padding-bottom:12px;letter-spacing:1px}
.term label{display:block;font-family:'VT323',monospace;font-size:15px;color:var(--dim);margin-bottom:6px;letter-spacing:2px}
.term input{width:100%;padding:12px;background:var(--bg);border:2px solid var(--border);color:var(--accent);font-size:18px;font-family:'VT323',monospace;letter-spacing:3px;outline:none;margin-bottom:20px}
.term input:focus{border-color:var(--accent);box-shadow:var(--glow)}
.term button{width:100%;padding:13px;background:var(--accent);color:var(--bg);border:none;font-family:var(--font-pixel);font-size:11px;letter-spacing:1px;cursor:pointer;box-shadow:4px 4px 0 0 var(--magenta);transition:transform .08s,box-shadow .08s}
.term button:hover{transform:translate(-2px,-2px);box-shadow:6px 6px 0 0 var(--magenta)}
.term button:active{transform:translate(2px,2px);box-shadow:1px 1px 0 0 var(--magenta)}
.err{color:var(--red);font-family:'VT323',monospace;font-size:15px;margin-bottom:14px;display:none;border-left:3px solid var(--red);padding-left:10px;letter-spacing:1px}
</style></head><body>
<div class="wrap">
<div class="brand"><div class="t glitch">CODING MONITOR</div><div class="s">// ACCESS TERMINAL</div></div>
<div class="term">
<div class="hd">&gt; SYSTEM READY_</div>
<div class="err" id="err">&gt; ACCESS DENIED · 密码错误</div>
<label>PASSWORD</label>
<input type="password" id="pw" placeholder="••••••••" autofocus>
<button onclick="doLogin()">CONNECT<span class="cursor"></span></button>
</div></div>
<script>
document.getElementById("pw").addEventListener("keydown",e=>{if(e.key==="Enter")doLogin()});
async function doLogin(){const pw=document.getElementById("pw").value;const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})});if(r.ok){window.location.reload()}else{document.getElementById("err").style.display="block"}}
<\/script></body></html>`;
}

// ─── Personal Usage Page HTML ─────────────────────────────────────────────────
function personalUsageLandingHtml() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>我的用量</title>
${PIXEL_FONT}
<style>
${PIXEL_THEME}
body{display:flex;justify-content:center;align-items:center;height:100vh;padding:20px;margin:0}
.wrap{width:100%;max-width:440px}
.brand{text-align:center;margin-bottom:20px}
.brand .t{font-family:var(--font-pixel);font-size:14px;color:var(--accent);text-shadow:var(--glow);letter-spacing:1px}
.brand .s{font-family:'VT323',monospace;font-size:16px;color:var(--dim);margin-top:10px;letter-spacing:3px}
.term{padding:30px 28px}
.term .hd{font-family:'VT323',monospace;font-size:15px;color:var(--green);margin-bottom:16px;border-bottom:1px dashed var(--border);padding-bottom:10px;letter-spacing:1px}
.term label{display:block;font-family:'VT323',monospace;font-size:15px;color:var(--dim);margin-bottom:6px;letter-spacing:2px}
.term input{width:100%;padding:12px;background:var(--bg);border:2px solid var(--border);color:var(--accent);font-size:15px;font-family:'VT323',monospace;letter-spacing:2px;outline:none;margin-bottom:18px}
.term input:focus{border-color:var(--accent);box-shadow:var(--glow)}
.term button{width:100%;padding:12px;background:var(--accent);color:var(--bg);border:none;font-family:var(--font-pixel);font-size:11px;letter-spacing:1px;cursor:pointer;box-shadow:4px 4px 0 0 var(--magenta);transition:transform .08s,box-shadow .08s}
.term button:hover{transform:translate(-2px,-2px);box-shadow:6px 6px 0 0 var(--magenta)}
.term button:active{transform:translate(2px,2px);box-shadow:1px 1px 0 0 var(--magenta)}
.note{font-family:'VT323',monospace;font-size:14px;color:var(--dim);text-align:center;margin-top:16px;letter-spacing:1px}
.note code{color:var(--accent)}
</style></head><body>
<div class="wrap">
<div class="brand"><div class="t glitch">MY USAGE</div><div class="s">// QUERY TERMINAL</div></div>
<div class="term">
<div class="hd">&gt; INSERT VIRTUAL KEY_</div>
<label>KEY</label>
<input type="text" id="key" placeholder="jx-xxxxxxxx" autofocus>
<button onclick="go()">EXECUTE<span class="cursor"></span></button>
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
${PIXEL_FONT}
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
${PIXEL_THEME}
body{padding:22px 26px}
.top,.meta,.box{animation:boot-in .45s ease-out both}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:6px}
.top h1{font-family:var(--font-pixel);font-size:16px;color:var(--accent);text-shadow:0 0 14px rgba(34,233,255,.7),0 0 4px rgba(34,233,255,.9);letter-spacing:1px;line-height:1.6}
.top h1::after{content:"";display:block;width:110px;height:3px;margin-top:8px;background:linear-gradient(90deg,var(--accent),var(--magenta),transparent);box-shadow:0 0 8px var(--accent)}
.top .sub{font-family:'Pixelify Sans',monospace;font-weight:500;font-size:15px;color:var(--dim);letter-spacing:1px;margin-top:8px}
select{font-family:'VT323',monospace;font-size:15px;background:var(--card);color:var(--text);border:2px solid var(--border);padding:5px 10px;letter-spacing:1px;cursor:pointer}
select:focus{border-color:var(--accent)}
.meta{font-family:'VT323',monospace;font-size:15px;color:var(--dim);margin-bottom:18px;letter-spacing:1px;border-left:3px solid var(--accent);padding:2px 0 2px 10px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px}
.card{background:linear-gradient(180deg,var(--card2),var(--card));border:2px solid var(--border);padding:16px 16px 14px;position:relative;overflow:hidden;transition:transform .12s,border-color .12s,box-shadow .12s}
.card::after{content:"";position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--accent),var(--magenta));opacity:.9}
.card:hover{transform:translate(-3px,-3px);border-color:var(--accent);box-shadow:5px 5px 0 0 var(--accent),-3px -3px 0 0 var(--magenta),var(--glow)}
.card .l{font-family:'Pixelify Sans',monospace;font-weight:600;font-size:14px;color:var(--dim);margin-bottom:8px;letter-spacing:1px;text-transform:uppercase}
.card .v{font-size:15px}
.box{position:relative;background:var(--card);border:2px solid var(--border);padding:16px;margin-bottom:14px}
.box::before,.box::after{content:"";position:absolute;width:12px;height:12px;border:2px solid var(--accent);pointer-events:none;opacity:.6}
.box::before{top:-2px;left:-2px;border-right:0;border-bottom:0}.box::after{bottom:-2px;right:-2px;border-left:0;border-top:0}
.box h3{font-family:'Pixelify Sans',monospace;font-weight:600;font-size:15px;color:var(--accent);margin-bottom:10px;letter-spacing:1px;text-transform:uppercase;text-shadow:0 0 8px rgba(34,233,255,.5)}
.box h3::before{content:"// ";color:var(--magenta)}
.box canvas{max-height:220px}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:6px 12px;font-family:'Pixelify Sans',monospace;font-weight:600;font-size:13px;color:#b4bcd9;border-bottom:2px solid var(--accent);letter-spacing:1px;text-transform:uppercase}
td{padding:6px 12px;font-size:13px;border-bottom:1px solid var(--border)}.n{text-align:right;font-variant-numeric:tabular-nums}
tbody tr:hover td{background:rgba(0,229,255,.05)}
.tag{font-family:var(--font-pixel);font-size:9px;background:rgba(0,229,255,.15);color:var(--accent);padding:2px 6px}
</style></head><body>
<div class="top"><div><h1 class="glitch">MY USAGE</h1><div class="sub">我的用量统计</div></div><select id="profileSel" onchange="switchProfile(this.value)"><option value="all">全部可用方案</option></select></div>
<div class="meta" id="meta">加载中...</div>
<div class="cards" id="cards"></div>
<div class="box"><h3>今日24小时趋势</h3><canvas id="hourChart"></canvas></div>
<div class="box"><h3>近7天趋势</h3><canvas id="trendChart"></canvas></div>
<div class="box"><h3>今日模型用量</h3><table id="modelTable"><thead><tr><th>模型</th><th class="n">请求数</th><th class="n">输入</th><th class="n">输出</th><th class="n">合计</th></tr></thead><tbody></tbody></table></div>
<script>
${PIXEL_JS}
Chart.defaults.color='#9aa0c8';Chart.defaults.font.family="'Pixelify Sans',monospace";Chart.defaults.font.size=11;
const VK='${escJs(virtualKey)}';
let D=null,C={h:null,t:null},currentProfile='all';
const fmtT=n=>n.toLocaleString("zh-CN");
const fmtTk=n=>{if(n>=1e6)return(n/1e6).toFixed(1)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"k";return n.toString()};
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
    '<div class="card"><div class="l">今日用量</div><div class="v" data-cu="'+t.total+'" data-cu-k style="color:var(--accent)">0</div></div>'+
    '<div class="card"><div class="l">今日请求</div><div class="v" data-cu="'+t.requests+'" data-cu-k style="color:var(--blue)">0</div></div>'+
    '<div class="card"><div class="l">今日输入</div><div class="v" data-cu="'+t.input+'" data-cu-k style="color:var(--green)">0</div></div>'+
    '<div class="card"><div class="l">今日输出</div><div class="v" data-cu="'+t.output+'" data-cu-k style="color:var(--orange)">0</div></div>'+
    (q.limit>0?'<div class="card"><div class="l">剩余额度</div><div class="v" data-cu="'+q.remaining+'" data-cu-k style="color:'+color+'">0</div><div style="margin-top:8px">'+hpBar(pct,16)+'</div></div>'+
    '<div class="card"><div class="l">每日限额</div><div class="v" data-cu="'+q.limit+'" data-cu-k style="color:var(--dim)">0</div></div>':'');
  runCountUps(document.getElementById('cards'));
  // Hourly chart
  const hrs=[];for(let i=0;i<24;i++)hrs.push(i.toString().padStart(2,"0")+":00");
  const hData=hrs.map((_,i)=>{const h=D.hourly[i.toString().padStart(2,"0")]||{};return{req:h.requests||0,tokens:(h.inputTokens||0)+(h.outputTokens||0)}});
  if(C.h)C.h.destroy();
  C.h=new Chart(document.getElementById("hourChart"),{type:"bar",data:{labels:hrs,datasets:[{label:"Token",data:hData.map(d=>d.tokens),backgroundColor:"#00e5ffcc",borderRadius:3},{label:"请求数",data:hData.map(d=>d.req),backgroundColor:"#29e7ffcc",borderRadius:3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:"#9aa0c8",font:{size:10}}}},scales:{x:{ticks:{color:"#6f6f8f",font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:12},grid:{display:false}},y:{ticks:{color:"#6f6f8f",callback:v=>fmtTk(v)},grid:{color:"rgba(0,229,255,.08)"}}}}});
  // Trend chart
  if(C.t)C.t.destroy();
  C.t=new Chart(document.getElementById("trendChart"),{type:"line",data:{labels:D.trend.map(d=>d.date.slice(5)),datasets:[{label:"输入",data:D.trend.map(d=>d.input),borderColor:"#00ff88",backgroundColor:"rgba(0,255,136,.12)",fill:true,tension:.4,pointRadius:3,borderWidth:2},{label:"输出",data:D.trend.map(d=>d.output),borderColor:"#ff3860",backgroundColor:"rgba(255,56,96,.12)",fill:true,tension:.4,pointRadius:3,borderWidth:2}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:"#9aa0c8",font:{size:10}}}},scales:{x:{ticks:{color:"#6f6f8f"},grid:{display:false}},y:{ticks:{color:"#6f6f8f",callback:v=>fmtTk(v)},grid:{color:"rgba(0,229,255,.08)"}}}}});
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
  const editingProfileName = formData.profileName || getProfileNameBySuffix(formData.profileSuffix) || getDefaultProfileName();
  const editingProfile = config.profiles[editingProfileName];
  if (!editingProfile) throw new Error(`Profile "${editingProfileName}" not found`);

  if (formData.apiProtocol !== undefined) {
    editingProfile.apiProtocol = validateApiProtocol(formData.apiProtocol);
  }
  if (formData.openaiStreamUsage !== undefined || formData.apiProtocol !== undefined) {
    editingProfile.openaiStreamUsage = formData.openaiStreamUsage === "on" || formData.openaiStreamUsage === true;
  }
  if (formData.responsesAdapter !== undefined || formData.apiProtocol !== undefined) {
    const protocol = normalizeApiProtocol(editingProfile.apiProtocol);
    editingProfile.responsesAdapter = protocol === "openai"
      ? validateResponsesAdapter(formData.responsesAdapter || "none")
      : "none";
  }

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

  // Update default model mappings (jx-* aliases)
  if (!editingProfile.defaultModels) editingProfile.defaultModels = {};
  if (formData.defaultModels_sonnet) editingProfile.defaultModels.sonnet = formData.defaultModels_sonnet.trim();
  if (formData.defaultModels_opus)   editingProfile.defaultModels.opus   = formData.defaultModels_opus.trim();
  if (formData.defaultModels_haiku)  editingProfile.defaultModels.haiku  = formData.defaultModels_haiku.trim();
  if (formData.modelAliases !== undefined) {
    const parsedAliases = parseModelAliasesInput(formData.modelAliases);
    editingProfile.modelAliases = parsedAliases;
  } else {
    editingProfile.modelAliases = getConfigurableModelAliases(editingProfile);
  }

  // Ensure alias targets are always in allowedModels
  if (!Array.isArray(editingProfile.allowedModels)) editingProfile.allowedModels = [];
  for (const m of Object.values(getProfileModelAliases(editingProfile))) {
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

  // Profile: set default entry alias
  if (req.method === "POST" && req.url === "/api/profile/default") {
    if (!checkAuth(req)) { res.writeHead(401); res.end("Unauthorized"); return; }
    if (!checkCsrf(req)) { res.writeHead(403); res.end("CSRF validation failed"); return; }
    readBody(req).then(buf => {
      try {
        const { profile, suffix } = JSON.parse(buf.toString());
        const name = profile || getProfileNameBySuffix(suffix);
        if (!name || !config.profiles[name]) throw new Error(`Profile "${profile || suffix}" not found`);
        for (const [pname, p] of Object.entries(config.profiles)) {
          p.isDefault = pname === name;
        }
        saveConfig(config);
        reloadAllRuntimes();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, defaultProfile: name, profiles: listProfiles() }));
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
        const { profile, upstream, allowedModels, defaultModels, suffix, apiProtocol, modelAliases, openaiStreamUsage, responsesAdapter } = JSON.parse(buf.toString());
        const name = (profile || "").trim();
        if (!name) throw new Error("Profile name required");
        if (config.profiles[name]) throw new Error(`方案 "${name}" 已存在`);
        const sfx = validateProfileSuffix(suffix, name);
        const protocol = validateApiProtocol(apiProtocol || "anthropic");
        const nextDefaultModels = defaultModels || { ...rt.defaultModels };
        const aliases = parseModelAliasesInput(modelAliases);
        const runtimeAliases = protocol === "anthropic"
          ? { ...legacyDefaultModelAliases(nextDefaultModels), ...aliases }
          : aliases;
        const models = allowedModels ? allowedModels.split(",").map(s => s.trim()).filter(Boolean) : [...rt.allowedModels];
        for (const m of Object.values(runtimeAliases)) {
          if (m && !models.includes(m)) models.push(m);
        }
        config.profiles[name] = {
          upstream: upstream || rt.upstream,
          apiProtocol: protocol,
          allowedModels: models,
          defaultModels: nextDefaultModels,
          modelAliases: aliases,
          openaiStreamUsage: openaiStreamUsage !== false,
          responsesAdapter: protocol === "openai" ? validateResponsesAdapter(responsesAdapter || "none") : "none",
          users: {},
          suffix: sfx,
          isDefault: false,
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
        if (updates.apiProtocol) formData.apiProtocol = updates.apiProtocol;
        if (updates.openaiStreamUsage !== undefined) formData.openaiStreamUsage = updates.openaiStreamUsage;
        if (updates.responsesAdapter !== undefined) formData.responsesAdapter = updates.responsesAdapter;
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
        if (updates.modelAliases !== undefined) {
          formData.modelAliases = updates.modelAliases;
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
        saveConfig(config);
        reloadAllRuntimes();
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
