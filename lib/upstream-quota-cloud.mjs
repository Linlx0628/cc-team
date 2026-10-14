// lib/upstream-quota-cloud.mjs —— 云平台额度/余额适配器（AK/SK 签名类）。
//
// 本文件只导出 CLOUD_PROVIDER_DEFS，形状与 lib/upstream-quota.mjs 里的
// LOCAL_PROVIDER_DEFS **完全一致**，由那边合并进平台总表：
//
//   {
//     id: "volcengine",
//     name: "火山引擎方舟",
//     group: "云平台账户",          // 账户余额类用这个；厂商自带的套餐 / 席位类额度用 "套餐额度"
//     credential: "accessKey",      // 云账号类一律 accessKey：凭据从 extraFields 收集
//     matchHosts: [],               // 云平台无法从方案自动取密钥
//     extraFields: [                // 设置页据此渲染输入框；key 即 cfg.extra[key]
//       { key: "accessKeyId", label: "AccessKey ID", type: "password" },
//     ],
//     consoleUrl, docsUrl, note, experimental?,
//     async run({ cred, cfg, timeoutMs, fetchImpl, now }) { return { items: [...] } },
//   }
//
// ctx 说明（与核心模块一致）：
//   cred.accessKeyId / cred.accessKeySecret  —— 已从 cfg.extra 取出的 AK/SK（缺失时核心模块
//                                               直接返回「未配置」，run 不会被调用）
//   cred.extra / cfg.extra                   —— 同一份 extra 对象（region 等）
//   cfg.baseUrl                              —— 用户可选覆盖的接入点
//   timeoutMs                                 —— 本次请求的超时（核心模块已设好 AbortController 上限）
//   fetchImpl                                 —— 注入的 fetch（测试用假实现）
//   run 抛错即视为该平台失败，错误信息会原样显示在面板上。
//
// item 形状（与核心模块 parseXxx 一致）：
//   { id, label, kind: "balance"|"quota", used, total, remaining, unit, percent, resetAt, note }
//   resetAt 是 **epoch 毫秒**；unit 用 "CNY"/"USD"/"tokens"/"%"。数字取不到的字段给 null，
//   千万别给 0 —— 0 会被面板当成"额度已用尽"直接标红。
//
// 依赖：只允许 node 内建（node:crypto / node:http...）与全局 fetch，禁止新增 npm 依赖。

import crypto from "node:crypto";

// ─── 小工具 ─────────────────────────────────────────────────────────────────
//
// 这些工具**刻意不 import 核心模块**：核心模块顶层 `import { CLOUD_PROVIDER_DEFS }`
// 会先执行本文件，若本文件再回头 import 核心模块，就形成循环依赖，CLOUD_PROVIDER_DEFS
// 的求值时机将不可控。宁可各留一份十行的小函数。

// 上游数字可能是字符串（"1234.56"）；非法值一律 null —— 面板把 0 当"额度用尽"，
// 所以绝不能用 0 顶替"取不到"。
function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

// 上游可能给 0~1 的比例，也可能给 0~100 的百分数（火山两种都出现过）。
function pctOf(used, total, given) {
  const g = num(given);
  if (g !== null) return g > 1.0001 ? Math.min(g, 100) : Math.round(g * 10000) / 100;
  const u = num(used), t = num(total);
  if (u === null || t === null || t <= 0) return null;
  return Math.round((u / t) * 10000) / 100;
}

// RFC3339 串（火山带 +08:00）/ epoch 秒 / epoch 毫秒 → epoch 毫秒。
function toEpochMs(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && /[T:-]/.test(v) && !/^\d+$/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

// AK/SK 掩码。上游偶尔把请求原样回显在错误报文里（Authorization 头里就带 AK），
// 所以凡是拼接上游文本的地方都要先过一遍 redactor。
function maskSecret(s) {
  const t = String(s || "");
  if (!t) return "";
  if (t.length <= 8) return t.slice(0, 2) + "***";
  return t.slice(0, 4) + "***" + t.slice(-4);
}

function makeRedactor(cred) {
  const secrets = [];
  for (const raw of [cred && cred.accessKeyId, cred && cred.accessKeySecret]) {
    const s = String(raw || "").trim();
    if (s.length < 6) continue;
    secrets.push(s);
    const encoded = encodeURIComponent(s);
    if (encoded !== s) secrets.push(encoded);
  }
  return (msg) => {
    let out = String(msg === null || msg === undefined ? "" : msg);
    for (const s of secrets) out = out.split(s).join(maskSecret(s));
    return out;
  };
}

// 错误报文只留一小段，别把整页 HTML/HTML 错误页塞进面板。
function snippet(text) {
  return String(text === null || text === undefined ? "" : text).replace(/\s+/g, " ").trim().slice(0, 200);
}

// ctx.now 核心模块传的是**毫秒数**（`now: now()`）；兼容函数形式，便于测试注入固定时间。
function resolveNow(now) {
  if (typeof now === "function") {
    const v = now();
    if (Number.isFinite(v)) return v;
  }
  if (typeof now === "number" && Number.isFinite(now)) return now;
  return Date.now();
}

// 本地超时兜底：核心模块只把 timeoutMs 作为**数值**传进 run（run 的 ctx 里没有 AbortSignal），
// 若这里不自己挂 AbortController，上游挂起时请求会一直悬着、该平台永远停在"加载中"。
// 超时后抛出的 AbortError 会被核心模块统一翻译成「请求超时（Nms）」。
async function fetchJson(url, { method = "GET", headers = {}, body, timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetchImpl(url, { method, headers, body, signal: ac.signal, redirect: "follow" });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 密码学原语 ─────────────────────────────────────────────────────────────

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

// key 是 string 或 Buffer（派生密钥链上会传 Buffer），返回 Buffer。
function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function hmacHex(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

// RFC3986 编码（火山 V4 用）：encodeURIComponent 不转义 !'()*，而签名规范要求转义。
function rfc3986(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// 阿里云 RPC 签名用的 percentEncode：等价于 Java URLEncoder.encode(UTF-8) 的三个补丁，
// 外加 !'() 这四个 encodeURIComponent 会放过的字符（Java 会编码它们）。
function aliyunEncode(s) {
  return encodeURIComponent(String(s))
    .replace(/\+/g, "%20")
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~")
    .replace(/!/g, "%21")
    .replace(/'/g, "%27")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
}

// 接入点统一去掉尾部斜杠，再各自拼路径；非法 URL 抛中文错误（面板直接展示）。
function normalizeBase(base, fallback) {
  const raw = String(base || fallback).trim().replace(/\/+$/, "");
  try { return { base: raw, host: new URL(raw).host }; }
  catch { throw new Error(`接入点不是合法的 URL：${raw}`); }
}

// ─── 火山引擎方舟（Signature V4 / HMAC-SHA256） ─────────────────────────────

const VOLC_DEFAULT_BASE = "https://open.volcengineapi.com";
const VOLC_DEFAULT_REGION = "cn-beijing";

// 套餐窗口的两种 Action：Coding Plan 与 Agent Plan（AFP），都用 ark 服务、2024-01-01 版本。
const VOLC_PLAN_ACTIONS = [
  { key: "coding", action: "GetCodingPlanUsage", title: "Coding Plan" },
  { key: "agent", action: "GetAgentPlanAFPUsage", title: "Agent Plan" },
];

// 窗口 label → 中文。CodingPlan 用 session，AgentPlan 用 5h，两者都对应用户看到的「5 小时窗口」。
function volcWindowLabel(raw) {
  const s = String(raw || "").toLowerCase();
  if (s.includes("session") || s.includes("5h") || s.includes("5_h") || s === "5 h") return "5 小时窗口";
  if (s.includes("week")) return "每周窗口";
  if (s.includes("month")) return "每月窗口";
  if (s.includes("day")) return "每日窗口";
  return raw ? `窗口（${raw}）` : "额度窗口";
}

// 火山可能把业务数据包在 Result 里，也可能直接放顶层。
function unwrapResult(json) {
  if (json && typeof json === "object" && json.Result && typeof json.Result === "object") return json.Result;
  return json || {};
}

// 火山网关的业务错误藏在 ResponseMetadata.Error（HTTP 往往还是 200）。
function volcApiError(json) {
  const err = json && json.ResponseMetadata && json.ResponseMetadata.Error;
  if (!err) return null;
  return `${err.Code || ""}${err.Message ? "：" + err.Message : ""}`.trim() || "未知错误";
}

// 纯签名计算（导出供测试钉死向量；不发请求）。输入固定则输出固定，便于回归：
// 任何改动一旦让签名变了，tests/upstream-quota-volc-sign.test.mjs 立刻失败。
export function volcSigning(o) {
  const host = o.host || "open.volcengineapi.com";
  const contentType = o.contentType || "application/json";
  const body = o.body === undefined ? "{}" : o.body;
  const xDate = new Date(o.nowMs).toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";
  const shortDate = xDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const params = { Action: o.action, Version: o.version };
  const canonicalQuery = Object.keys(params).sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`).join("&");
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-content-sha256:${payloadHash}\nx-date:${xDate}\n`;
  const canonicalRequest = `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${shortDate}/${o.region}/${o.service}/request`;
  const stringToSign = `HMAC-SHA256\n${xDate}\n${scope}\n${sha256Hex(canonicalRequest)}`;
  // ⚠️ 派生密钥第一层是 HMAC(SecretAccessKey, YYYYMMDD)，**不给 SK 加任何前缀**。
  // 曾误写成 `VOLC${SK}`（别的云 SDK 的习惯），后果是三个 Action 全部 401、
  // CodeN 100010 SignatureDoesNotMatch —— 已用真实 AK/SK 对线上 API 逐一实测定位。
  const kDate = hmac(o.accessKeySecret, shortDate);
  const kRegion = hmac(kDate, o.region);
  const kService = hmac(kRegion, o.service);
  const kSigning = hmac(kService, "request");
  const signature = hmacHex(kSigning, stringToSign);
  return {
    xDate, shortDate, payloadHash, canonicalQuery, signedHeaders, canonicalRequest, scope, stringToSign, signature,
    authorization: `HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// 发一个 V4 签名请求。body 固定 "{}"（Action/Version 走 query，其余参数本适配器用不到）。
async function volcSignedRequest(base, host, o) {
  const s = volcSigning({ ...o, host });
  return fetchJson(`${base}/?${s.canonicalQuery}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Node 的 fetch 会按 URL 自动写 Host，这里显式带上是为了让签名口径一目了然；
      // 值必须与 URL 的 host 完全一致，否则签名不匹配。
      Host: host,
      "X-Date": s.xDate,
      "X-Content-Sha256": s.payloadHash,
      Authorization: s.authorization,
    },
    body: "{}",
    timeoutMs: o.timeoutMs,
    fetchImpl: o.fetchImpl,
  });
}

// 套餐窗口。CodingPlan 后端常常只给 percent，缺 used/total —— 那三个字段就给 null，
// 只把 percent 和 unit:"%" 报上去，别用 0 伪造。
// 火山线上真实响应（GetCodingPlanUsage，已用真实 AK/SK 实测）：
//   Result = { Status, UpdateTimestamp, HasReward,
//              QuotaUsage: [{ Level:"session"|"weekly"|"monthly", Percent, ResetTimestamp, Cap, RewardTotalPercent }] }
// ⚠️ Percent 是 **0–100 的百分数**（Cap 是刻度上限，通常 100），不是 0–1 的小数：
//    线上 session 返回 1.6193079999999997 = 1.62%；若按小数 ×100 会变成 162%。
// Agent Plan（GetAgentPlanAFPUsage）是另一套结构：
//   Result.AFP{FiveHour,Weekly,Monthly,Daily} = { Quota, Used, SubscribeTime, ResetTime }，Quota 为 0 = 没订阅。
// 早期版本/CLI 还输出过 items[].periods[] 形态，这里保留兼容分支。
function parseVolcPlanWindows(root, sourceKey) {
  const items = [];
  const warnings = [];

  // ① 真实 OpenAPI：Result.QuotaUsage[]
  const usage = Array.isArray(root && root.QuotaUsage) ? root.QuotaUsage : [];
  usage.forEach((u, i) => {
    if (!u || typeof u !== "object") return;
    const level = String(u.Level || u.level || "").toLowerCase();
    const cap = num(u.Cap);
    let percent = num(u.Percent !== undefined ? u.Percent : u.percent);
    if (percent !== null && cap !== null && cap > 0 && cap !== 100) percent = (percent / cap) * 100;
    if (percent !== null) percent = Math.max(0, Math.min(100, Math.round(percent * 100) / 100));
    items.push({
      id: `volc-${sourceKey}-${level || i}`,
      label: volcWindowLabel(level),
      kind: "quota",
      used: null,
      total: null,
      remaining: null,
      unit: "%",
      percent,
      resetAt: toEpochMs(u.ResetTimestamp !== undefined ? u.ResetTimestamp : u.ResetTime),
      note: root && root.Status ? `套餐状态 ${root.Status}` : null,
    });
  });

  // ② Agent Plan：Quota/Used 成对；Quota 为 0（未订阅）时不出条目
  const AFP_LABELS = { AFPFiveHour: "5 小时窗口", AFPWeekly: "每周窗口", AFPMonthly: "每月窗口", AFPDaily: "每日窗口" };
  Object.keys(AFP_LABELS).forEach((key) => {
    const v = root && root[key];
    if (!v || typeof v !== "object") return;
    const quota = num(v.Quota);
    const used = num(v.Used);
    if (!quota) return;
    items.push({
      id: `volc-${sourceKey}-${key.toLowerCase()}`,
      label: AFP_LABELS[key],
      kind: "quota",
      used,
      total: quota,
      remaining: used === null ? null : Math.round((quota - used) * 1e6) / 1e6,
      unit: "%",
      percent: pctOf(used, quota, null),
      resetAt: toEpochMs(v.ResetTime !== undefined ? v.ResetTime : v.ResetTimestamp),
      note: null,
    });
  });

  // ③ 兼容形态：items[].periods[]
  const list = Array.isArray(root && root.items) ? root.items : [];
  list.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") return;
    if (entry.error) {
      warnings.push(`套餐条目 ${entry.product || entry.edition || i} 返回错误：${snippet(entry.error)}`);
      return;
    }
    const periods = Array.isArray(entry.periods) ? entry.periods : [];
    const edition = String(entry.edition || entry.product || "").trim();
    periods.forEach((p, j) => {
      if (!p || typeof p !== "object") return;
      const rawLabel = String(p.label || "");
      const used = num(p.used);
      const total = num(p.total);
      const percent = pctOf(used, total, p.percent);
      items.push({
        id: `volc-${sourceKey}-${rawLabel.toLowerCase() || j}`,
        label: volcWindowLabel(rawLabel),
        kind: "quota",
        used,
        total,
        remaining: (used !== null && total !== null) ? Math.round((total - used) * 1e6) / 1e6 : null,
        unit: "%",
        percent,
        resetAt: toEpochMs(p.reset_at !== undefined ? p.reset_at : p.resetAt),
        note: [edition, percent === null ? "" : `已用 ${percent}%`].filter(Boolean).join(" · "),
      });
    });
  });
  return { items, warnings };
}

function parseVolcBalance(root) {
  const avail = num(root && root.AvailableBalance);
  if (avail === null) return null;
  const cash = num(root && root.CashBalance);
  const credit = num(root && (root.CreditLimit !== undefined ? root.CreditLimit : root.CreditAmount));
  return {
    id: "volc-balance",
    label: "账户可用余额",
    kind: "balance",
    used: null,
    total: avail,
    remaining: avail,
    unit: "CNY",
    percent: null,
    resetAt: null,
    note: `现金 ${cash ?? "—"} / 信控 ${credit ?? "—"}`,
  };
}

// ─── 阿里云（RPC 风格 HMAC-SHA1） ───────────────────────────────────────────

const ALIYUN_DEFAULT_BASE = "https://business.aliyuncs.com";
const ALIYUN_VERSION = "2017-12-14";

function aliyunSignedUrl(base, { action, version, accessKeyId, accessKeySecret, nowMs }) {
  const params = {
    Format: "JSON",
    Version: version,
    AccessKeyId: accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: "1.0",
    // 阿里云要求 UTC ISO8601 且不带毫秒，例如 2026-10-14T03:06:27Z。
    Timestamp: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    Action: action,
  };
  // 规范化查询串：按参数名（区分大小写）字典序排序，k/v 都 percentEncode。
  const canonical = Object.keys(params).sort()
    .map((k) => `${aliyunEncode(k)}=${aliyunEncode(params[k])}`).join("&");
  const stringToSign = `GET&%2F&${aliyunEncode(canonical)}`;
  const signature = crypto.createHmac("sha1", `${accessKeySecret}&`).update(stringToSign).digest("base64");
  return `${base}/?${canonical}&Signature=${aliyunEncode(signature)}`;
}

function parseAliyunBalance(json) {
  const d = json && json.Data;
  if (!d || typeof d !== "object") return null;
  const avail = num(d.AvailableAmount);
  const cash = num(d.AvailableCashAmount);
  const credit = num(d.CreditAmount);
  if (avail === null && cash === null && credit === null) return null;
  // AvailableAmount 含信控额度，是"还能花多少"的官方口径；缺失时退回现金余额。
  const value = avail !== null ? avail : cash;
  return {
    id: "aliyun-balance",
    label: "账户可用余额",
    kind: "balance",
    used: null,
    total: value,
    remaining: value,
    unit: String(d.Currency || "CNY").trim() || "CNY",
    percent: null,
    resetAt: null,
    note: `现金余额 ${cash ?? "—"} / 信控额度 ${credit ?? "—"}`,
  };
}

// ─── 腾讯云（TC3-HMAC-SHA256） ──────────────────────────────────────────────

const TENCENT_DEFAULT_BASE = "https://billing.tencentcloudapi.com";
const TENCENT_VERSION = "2018-07-09";

// 腾讯账单接口返回的金额单位是**分**，展示层统一用元。
function tencentYuan(v) {
  const n = num(v);
  return n === null ? null : Math.round(n) / 100;
}

async function tencentSignedRequest(base, host, o) {
  const ts = Math.floor(o.nowMs / 1000);            // X-TC-Timestamp 是 epoch 秒
  const date = new Date(ts * 1000).toISOString().slice(0, 10);  // 派生密钥用 UTC YYYY-MM-DD
  const payload = JSON.stringify({ TempCredit: false });
  const contentType = "application/json; charset=utf-8";

  const signedHeaders = "content-type;host";
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${sha256Hex(payload)}`;

  const scope = `${date}/billing/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${ts}\n${scope}\n${sha256Hex(canonicalRequest)}`;

  const kDate = hmac(`TC3${o.accessKeySecret}`, date);
  const kService = hmac(kDate, "billing");
  const kSigning = hmac(kService, "tc3_request");
  const signature = hmacHex(kSigning, stringToSign);

  return fetchJson(`${base}/`, {
    method: "POST",
    headers: {
      Authorization: `TC3-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "Content-Type": contentType,
      Host: host,
      "X-TC-Action": "DescribeAccountBalance",
      "X-TC-Version": o.version,
      "X-TC-Timestamp": String(ts),
    },
    body: payload,
    timeoutMs: o.timeoutMs,
    fetchImpl: o.fetchImpl,
  });
}

function parseTencentBalance(resp) {
  const real = tencentYuan(resp.RealBalance);
  const balance = tencentYuan(resp.Balance);
  const cash = tencentYuan(resp.CashAccountBalance);
  const present = tencentYuan(resp.PresentAccountBalance);
  const credit = tencentYuan(resp.CreditAmount);
  const value = real !== null ? real : balance;
  if (value === null && cash === null && present === null && credit === null) return null;
  return {
    id: "tencent-balance",
    label: "账户可用余额",
    kind: "balance",
    used: null,
    total: value,
    remaining: value,
    unit: "CNY",
    percent: null,
    resetAt: null,
    note: `现金 ${cash ?? "—"} / 赠送 ${present ?? "—"} / 信用 ${credit ?? "—"}`,
  };
}

// ─── 平台定义 ───────────────────────────────────────────────────────────────

// ─── 阿里云百炼 Model Studio：Token Plan 席位与额度（ACS3-HMAC-SHA256） ───────
//
// 与百炼的 Coding Plan 不同，**Token Plan 有官方 OpenAPI**（不需要控制台登录态）：
//   GET /tokenplan/subscription/stats        席位数量 + 剩余 Credits（主数据，取不到即整体失败）
//   GET /tokenplan/subscription/seat-detail  逐席位明细（加分项，失败只加一条提示）
// 网关 modelstudio.cn-beijing.aliyuncs.com，版本 2026-02-10，签名 ACS3-HMAC-SHA256。
//
// 注意与火山 V4 的关键差异：阿里云 V3 的派生密钥**不加前缀**，
//   Signature = hex(HMAC-SHA256(AccessKeySecret, StringToSign))
// （火山是 HMAC("VOLC" + SK, date) 一路派生的密钥链，两者不可混用。）

const MODELSTUDIO_DEFAULT_BASE = "https://modelstudio.cn-beijing.aliyuncs.com";
const MODELSTUDIO_VERSION = "2026-02-10";

const ALIYUN_SEAT_LABELS = { standard: "标准席位", pro: "高级席位", max: "尊享席位" };

function aliyunSeatLabel(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "席位";
  return ALIYUN_SEAT_LABELS[s] || `${raw} 席位`;
}

// epoch 毫秒 → 北京时间的 MM-DD（只用于订阅期 / 周期末这类短说明）。
function bjDay(ms) {
  const n = toEpochMs(ms);
  if (n === null) return "";
  return new Date(n + 8 * 3600 * 1000).toISOString().slice(5, 10);
}

// ACS3-HMAC-SHA256 的签名材料（纯函数，测试直接钉向量）。
//   CanonicalRequest = Method \n CanonicalURI \n CanonicalQuery \n CanonicalHeaders \n SignedHeaders \n hex(sha256(body))
//   StringToSign     = "ACS3-HMAC-SHA256" \n hex(sha256(CanonicalRequest))
export function aliyunAcs3Signing(o) {
  const method = String(o.method || "GET").toUpperCase();
  const payloadHash = sha256Hex(o.body === undefined || o.body === null ? "" : String(o.body));
  const xDate = new Date(resolveNow(o.nowMs)).toISOString().replace(/\.\d{3}Z$/, "Z");
  const nonce = String(o.nonce || crypto.randomUUID());
  const headers = {
    host: o.host,
    "x-acs-action": o.action,
    "x-acs-content-sha256": payloadHash,
    "x-acs-date": xDate,
    "x-acs-signature-nonce": nonce,
    "x-acs-version": o.version,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const src = (o.query && typeof o.query === "object") ? o.query : {};
  const canonicalQuery = Object.keys(src)
    .filter((k) => src[k] !== undefined && src[k] !== null && String(src[k]) !== "")
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(src[k])}`)
    .join("&");
  // URI 按段编码：'/' 保留，其余按 RFC3986。
  const canonicalUri = String(o.path || "/").split("/").map((seg) => rfc3986(seg)).join("/") || "/";
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
  const signature = hmacHex(o.accessKeySecret, stringToSign);
  const authorization = `ACS3-HMAC-SHA256 Credential=${o.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return {
    xDate, nonce, payloadHash, canonicalUri, canonicalQuery, canonicalHeaders,
    signedHeaders, canonicalRequest, stringToSign, signature, authorization, headers,
  };
}

async function modelStudioRequest({ base, host, action, path, query, timeoutMs, fetchImpl, accessKeyId, accessKeySecret, nowMs }) {
  const signed = aliyunAcs3Signing({
    method: "GET", action, version: MODELSTUDIO_VERSION, path, query, host, accessKeyId, accessKeySecret, nowMs,
  });
  const url = base + path + (signed.canonicalQuery ? `?${signed.canonicalQuery}` : "");
  const r = await fetchJson(url, {
    method: "GET",
    headers: { ...signed.headers, Authorization: signed.authorization },
    timeoutMs,
    fetchImpl,
  });
  return { ...r, signed };
}

// 席位聚合：每个席位类型一条 Credits 额度（总量 / 剩余 / 刷新时间 / 订阅期）。
function parseAliyunTokenPlanStats(json) {
  const data = (json && json.Data) || {};
  const list = Array.isArray(data.Items) ? data.Items : [];
  const until = bjDay(data.SubscriptionEndTime);
  const items = list.map((it) => {
    const total = num(it.SeatCredits);
    const remaining = num(it.SeatRemainingCredits);
    const used = (total !== null && remaining !== null) ? Math.max(0, total - remaining) : null;
    const totalSeats = num(it.TotalSeats);
    const assigned = num(it.AssignedSeats);
    const seats = (totalSeats !== null || assigned !== null)
      ? `席位 ${assigned === null ? "?" : assigned}/${totalSeats === null ? "?" : totalSeats}`
      : "";
    const note = [seats, until ? `订阅至 ${until}` : ""].filter(Boolean).join(" · ");
    return {
      id: `aliyun-tokenplan-${String(it.SeatType || "seat").toLowerCase()}`,
      label: `${aliyunSeatLabel(it.SeatType)} Credits`,
      kind: "quota",
      used, total, remaining, unit: "Credits",
      percent: pctOf(used, total, null),
      resetAt: toEpochMs(it.SeatRefreshTime),
      note: note || null,
    };
  });
  return { items, until };
}

// 逐席位明细：EquityList 里每个权益周期给 CycleTotalValue / CycleSurplusValue。
function parseAliyunSeatDetails(json, limit = 8) {
  const data = (json && json.Data) || {};
  const list = Array.isArray(data.Items) ? data.Items : [];
  const items = [];
  for (const it of list) {
    const eq = Array.isArray(it.EquityList) ? it.EquityList : [];
    let total = null, remaining = null, resetAt = null;
    for (const e of eq) {
      const t = num(e.CycleTotalValue);
      const s = num(e.CycleSurplusValue);
      if (t !== null) total = (total === null ? 0 : total) + t;
      if (s !== null) remaining = (remaining === null ? 0 : remaining) + s;
      const r = toEpochMs(e.CycleEndTime);
      if (r !== null && (resetAt === null || r < resetAt)) resetAt = r;
    }
    if (total === null && remaining === null) continue;
    const who = String(it.AccountName || it.AccountEmail || it.AccountId || "").trim();
    const spec = it.SpecType ? `（${aliyunSeatLabel(it.SpecType)}）` : "";
    const used = (total !== null && remaining !== null) ? Math.max(0, total - remaining) : null;
    const state = String(it.AssignedStatus || it.Status || "").trim();
    items.push({
      id: `aliyun-seat-${String(it.SeatId || who || items.length)}`,
      label: `${who || "席位"}${spec}`,
      kind: "quota",
      used, total, remaining, unit: "Credits",
      percent: pctOf(used, total, null),
      resetAt,
      note: resetAt ? `周期至 ${bjDay(resetAt)}` : (state || null),
    });
  }
  const warnings = [];
  const total = num(data.Total);
  if (items.length > limit) {
    warnings.push(`逐席位明细共 ${total === null ? items.length : total} 条，只展示前 ${limit} 条`);
  }
  return { items: items.slice(0, limit), warnings };
}

export const CLOUD_PROVIDER_DEFS = [
  // ── 火山引擎方舟：套餐窗口 + 账户余额 ──────────────────────────────────────
  {
    id: "volcengine",
    name: "火山引擎方舟",
    group: "云平台账户",
    credential: "accessKey",
    matchHosts: [],
    extraFields: [
      { key: "accessKeyId", label: "AccessKey ID", type: "password", placeholder: "方舟账号的 AK" },
      { key: "accessKeySecret", label: "AccessKey Secret", type: "password", placeholder: "方舟账号的 SK" },
      { key: "region", label: "区域（可选）", placeholder: "默认 cn-beijing" },
    ],
    consoleUrl: "https://console.volcengine.com/ark",
    docsUrl: "https://www.volcengine.com/docs/6369/67269",
    note: "套餐用量需要方舟的 AK/SK 走公网 OpenAPI（Signature V4 签名，AK/SK 在火山控制台「访问密钥」里取）："
      + "GetCodingPlanUsage / GetAgentPlanAFPUsage 取「5 小时 / 每周 / 每月」窗口，QueryBalanceAcct 取账户余额（CNY）。"
      + "官方只给百分比（Percent 是 0–100 的数，Cap 是刻度上限），不给已用 / 总额，所以套餐条目上只有百分比与重置时间；"
      + "Agent Plan 未订阅时不出条目。",
    async run({ cred, cfg, timeoutMs, fetchImpl, now }) {
      const c = cfg || {};
      const extra = (c.extra && typeof c.extra === "object") ? c.extra : {};
      const { base, host } = normalizeBase(c.baseUrl, VOLC_DEFAULT_BASE);
      const region = String(extra.region || VOLC_DEFAULT_REGION).trim() || VOLC_DEFAULT_REGION;
      const nowMs = resolveNow(now);
      const redact = makeRedactor(cred);

      const common = {
        region, nowMs, timeoutMs, fetchImpl,
        accessKeyId: cred.accessKeyId, accessKeySecret: cred.accessKeySecret,
      };
      const items = [];
      const warnings = [];

      // 两个套餐 Action 各自独立：某个套餐没订阅/接口报错，不该拖垮另一个，更不该拖垮余额。
      for (const plan of VOLC_PLAN_ACTIONS) {
        const r = await volcSignedRequest(base, host, { ...common, action: plan.action, version: "2024-01-01", service: "ark" });
        if (!r.ok) {
          warnings.push(redact(`${plan.title} 用量接口 HTTP ${r.status}：${snippet(r.text) || "(空响应)"}`));
          continue;
        }
        const bizErr = volcApiError(r.json);
        if (bizErr) {
          warnings.push(redact(`${plan.title} 用量接口返回错误 ${bizErr}`));
          continue;
        }
        const parsed = parseVolcPlanWindows(unwrapResult(r.json), plan.key);
        if (!parsed.items.length) {
          warnings.push(`${plan.title} 用量接口没有返回任何窗口（可能未订阅该套餐）`);
        }
        items.push(...parsed.items);
        warnings.push(...parsed.warnings.map(redact));
      }

      const br = await volcSignedRequest(base, host, { ...common, action: "QueryBalanceAcct", version: "2022-01-01", service: "billing" });
      if (!br.ok) {
        warnings.push(redact(`账户余额接口 HTTP ${br.status}：${snippet(br.text) || "(空响应)"}`));
      } else {
        const bizErr = volcApiError(br.json);
        if (bizErr) {
          warnings.push(redact(`账户余额接口返回错误 ${bizErr}`));
        } else {
          const bal = parseVolcBalance(unwrapResult(br.json));
          if (bal) items.push(bal);
          else warnings.push("账户余额接口没有返回 AvailableBalance 字段");
        }
      }

      // 一条都没拿到就是彻底失败：抛中文原因，别让面板显示一个空白的"成功"。
      if (!items.length) {
        throw new Error(`火山引擎方舟额度查询失败：${warnings.join("；") || "没有拿到任何数据"}`);
      }
      return { items, warnings };
    },
  },

  // ── 阿里云：只查账户余额（套餐额度无 API） ────────────────────────────────
  {
    id: "aliyun",
    name: "阿里云账户余额",
    group: "云平台账户",
    credential: "accessKey",
    matchHosts: [],
    extraFields: [
      { key: "accessKeyId", label: "AccessKey ID", type: "password", placeholder: "阿里云账号的 AK" },
      { key: "accessKeySecret", label: "AccessKey Secret", type: "password", placeholder: "阿里云账号的 SK" },
    ],
    consoleUrl: "https://usercenter2.aliyun.com/finance/fund-management/account-balance",
    docsUrl: "https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-queryaccountbalance",
    note: "百炼 / 阿里云的**套餐额度**（Coding Plan / Token Plan）官方没有 API-Key 接口，只能看控制台或 `bl` CLI"
      + "（需要控制台登录态），本适配器只查账户余额：QueryAccountBalance（RPC 风格 HMAC-SHA1 签名）。"
      + "可用额度 AvailableAmount 含信控额度。",
    async run({ cred, cfg, timeoutMs, fetchImpl, now }) {
      const c = cfg || {};
      const { base } = normalizeBase(c.baseUrl, ALIYUN_DEFAULT_BASE);
      const redact = makeRedactor(cred);
      const url = aliyunSignedUrl(base, {
        action: "QueryAccountBalance",
        version: ALIYUN_VERSION,
        accessKeyId: cred.accessKeyId,
        accessKeySecret: cred.accessKeySecret,
        nowMs: resolveNow(now),
      });
      const r = await fetchJson(url, { method: "GET", timeoutMs, fetchImpl });
      if (!r.ok) {
        throw new Error(`阿里云账户余额接口 HTTP ${r.status}：${redact(snippet(r.text)) || "(空响应)"}`);
      }
      const j = r.json || {};
      const code = j.Code === undefined || j.Code === null ? null : String(j.Code);
      if (code !== null && code !== "200") {
        throw new Error(`阿里云账户余额接口返回 Code=${code}${j.Message ? "：" + redact(j.Message) : ""}`);
      }
      if (j.Success === false) {
        throw new Error(`阿里云账户余额接口返回失败${j.Message ? "：" + redact(j.Message) : ""}`);
      }
      const item = parseAliyunBalance(j);
      if (!item) throw new Error("阿里云账户余额响应里没有可识别的金额字段（接口可能已变更）");
      return { items: [item] };
    },
  },

  // ── 腾讯云：只查账户余额（套餐额度无 API） ────────────────────────────────
  {
    id: "tencent",
    name: "腾讯云账户余额",
    group: "云平台账户",
    credential: "accessKey",
    matchHosts: [],
    extraFields: [
      // 注意：key 必须叫 accessKeyId / accessKeySecret，核心模块只按这两个名字取凭据；
      // label 保持腾讯云自己的叫法（SecretId / SecretKey）。
      { key: "accessKeyId", label: "SecretId", type: "password", placeholder: "腾讯云访问密钥 SecretId" },
      { key: "accessKeySecret", label: "SecretKey", type: "password", placeholder: "腾讯云访问密钥 SecretKey" },
    ],
    consoleUrl: "https://console.cloud.tencent.com/expense/overview",
    docsUrl: "https://cloud.tencent.com/document/api/555/20253",
    note: "TokenHub Coding Plan 的套餐额度官方只在控制台展示（无 API），本适配器只查账户余额："
      + "DescribeAccountBalance（TC3-HMAC-SHA256 签名）。接口返回的金额单位是**分**，这里已换算成元。"
      + "套餐额度只能在控制台看，或等上游回报 20097 hour/week/month allocated quota exceeded。",
    async run({ cred, cfg, timeoutMs, fetchImpl, now }) {
      const c = cfg || {};
      const { base, host } = normalizeBase(c.baseUrl, TENCENT_DEFAULT_BASE);
      const redact = makeRedactor(cred);
      const r = await tencentSignedRequest(base, host, {
        version: TENCENT_VERSION,
        accessKeyId: cred.accessKeyId,
        accessKeySecret: cred.accessKeySecret,
        nowMs: resolveNow(now),
        timeoutMs,
        fetchImpl,
      });
      if (!r.ok) {
        throw new Error(`腾讯云账户余额接口 HTTP ${r.status}：${redact(snippet(r.text)) || "(空响应)"}`);
      }
      const j = r.json || {};
      const resp = j.Response;
      if (resp && resp.Error) {
        throw new Error(`腾讯云账户余额接口返回错误 ${resp.Error.Code || ""}${resp.Error.Message ? "：" + redact(resp.Error.Message) : ""}`.trim());
      }
      if (!resp || typeof resp !== "object") {
        throw new Error("腾讯云账户余额响应里没有 Response 字段（接口可能已变更）");
      }
      const item = parseTencentBalance(resp);
      if (!item) throw new Error("腾讯云账户余额响应里没有可识别的余额字段（接口可能已变更）");
      return { items: [item] };
    },
  },

  // ── 阿里云百炼 Token Plan：席位 + 剩余 Credits（官方 OpenAPI） ──────────────
  {
    id: "aliyun-tokenplan",
    name: "阿里云百炼 Token Plan",
    group: "套餐额度",
    credential: "accessKey",
    matchHosts: [],
    experimental: true,
    extraFields: [
      { key: "accessKeyId", label: "AccessKey ID", type: "password", placeholder: "可复用「阿里云账户余额」那份" },
      { key: "accessKeySecret", label: "AccessKey Secret", type: "password", placeholder: "留空即复用已填好的阿里云 AK/SK" },
    ],
    consoleUrl: "https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan",
    docsUrl: "https://help.aliyun.com/zh/model-studio/get-subscription-stats",
    note: "官方 OpenAPI（Model Studio 2026-02-10，ACS3-HMAC-SHA256 签名）："
      + "GetSubscriptionStats 读席位数量与每类席位的 Credits 总量 / 剩余，GetSubscriptionSeatDetails 再补齐逐席位（成员）剩余。"
      + "百炼的 **Coding Plan** 仍只有控制台 / bl CLI 能看，本平台只管 Token Plan。"
      + "AK/SK 留空时会自动复用同一账号下「阿里云账户余额」已填好的那一份。",
    async run({ cred, cfg, timeoutMs, fetchImpl, now }) {
      const c = cfg || {};
      const { base, host } = normalizeBase(c.baseUrl, MODELSTUDIO_DEFAULT_BASE);
      const redact = makeRedactor(cred);
      const common = {
        base, host, timeoutMs, fetchImpl, nowMs: resolveNow(now),
        accessKeyId: cred.accessKeyId, accessKeySecret: cred.accessKeySecret,
      };

      // 主数据：席位与 Credits。取不到就是整体失败（凭据 / 权限 / 订阅问题都要用户看见）。
      const stats = await modelStudioRequest({ ...common, action: "GetSubscriptionStats", path: "/tokenplan/subscription/stats" });
      if (!stats.ok) {
        throw new Error(`百炼 Token Plan 订阅接口 HTTP ${stats.status}：${redact(snippet(stats.text)) || "(空响应)"}`);
      }
      const sj = stats.json || {};
      if (sj.Success === false) {
        throw new Error(`百炼 Token Plan 订阅接口返回 ${sj.Code || "错误"}${sj.Message ? "：" + redact(sj.Message) : ""}`);
      }
      const parsed = parseAliyunTokenPlanStats(sj);
      if (!parsed.items.length) {
        throw new Error("百炼 Token Plan 订阅接口没有返回任何席位（该 AccessKey 的账号可能没有订阅 Token Plan）");
      }
      const items = parsed.items.slice();
      const warnings = [];

      // 加分项：逐席位明细（谁用了多少）。读不到只提示，不影响上面的席位数。
      const det = await modelStudioRequest({
        ...common, action: "GetSubscriptionSeatDetails",
        path: "/tokenplan/subscription/seat-detail", query: { PageNo: 1, PageSize: 50 },
      });
      if (!det.ok) {
        warnings.push(redact(`逐席位明细接口 HTTP ${det.status}：${snippet(det.text) || "(空响应)"}`));
      } else if (det.json && det.json.Success === false) {
        warnings.push(redact(`逐席位明细接口返回 ${det.json.Code || "错误"}${det.json.Message ? "：" + det.json.Message : ""}`));
      } else {
        const sd = parseAliyunSeatDetails(det.json || {});
        items.push(...sd.items);
        warnings.push(...sd.warnings);
      }
      return { items, warnings };
    },
  },
];
