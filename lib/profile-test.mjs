// lib/profile-test.mjs —— 「方案测试」的纯逻辑。
//
// 需求：设置页左侧方案卡片上的「测试」按钮，直接拿该方案的真实 Key 向上游发一个
// 最小请求（body 就一个 "hi"），2xx 即认为该方案的配置可用。
//
// 为什么要单独成模块：server.mjs 一加载就会起监听，没法被单测 import。把「挑模型 /
// 拼路径 / 发请求 / 判成败」抽到这里，fetch、超时、模型解析、取 Key 都由调用方注入，
// 单测就能完全不联网地覆盖成功、401、超时、网络错误与各种上游路径拼接。
import { buildUpstreamPath } from "./proxy-helpers.mjs";

export const PROFILE_TEST_TIMEOUT_MS = 20000;

// 配置缺失的两种错误文案导出成常量：server.mjs 要在发请求前用它们给出 400，
// 模块内部也在同样的条件下兜底返回同一句话，两边共用一个字符串就不会说岔。
export const PROFILE_TEST_ERR_NO_UPSTREAM = "该方案还没填上游地址";
export const PROFILE_TEST_ERR_NO_KEY = "该方案还没有可用的成员密钥";

// 方案一点模型线索都没有时（刚建、还没配别名）用它兜底。空 model 会被上游直接 400，
// 用户会误判成「Key 或地址不对」；这两个名字在各家网关上长期存在，能转发就说明
// 地址 + Key + 协议这三件套是通的 —— 那正是「测试」要回答的问题。
export const PROFILE_TEST_FALLBACK_MODEL = {
  anthropic: "claude-3-5-haiku-20241022",
  responses: "gpt-4o-mini",
};

const REPLY_MAX = 200;
const ERROR_MAX = 300;

function normalizeProtocol(profileCfg) {
  return String((profileCfg && profileCfg.protocol) || "").trim().toLowerCase() === "responses"
    ? "responses"
    : "anthropic";
}

// 与 server.mjs 的 resolveModel 同规则（精确命中别名键 → 大小写不敏感匹配 → 原样返回）。
// 单测要在不加载 server 的情况下验模型选择，所以这里留一份镜像；线上由 server.mjs
// 注入它自己的 resolveModel（含高峰期别名覆盖），口径仍以 server 那份为准。
function defaultResolveModel(model, profileCfg) {
  if (!model) return model;
  const aliases = (profileCfg && profileCfg.modelAliases && typeof profileCfg.modelAliases === "object")
    ? profileCfg.modelAliases
    : {};
  if (aliases[model]) return aliases[model];
  const lower = String(model).toLowerCase();
  for (const [name, target] of Object.entries(aliases)) {
    if (name.toLowerCase() === lower) return target;
  }
  return model;
}

// 与 server.mjs 的 getRealKeyFromProfile 同规则：取第一个非空用户 Key
// （值可能是字符串，也可能是 { key } 对象）。
export function pickRealKey(profileCfg) {
  const users = (profileCfg && profileCfg.users) || {};
  for (const v of Object.values(users)) {
    const k = typeof v === "string" ? v : (v && v.key);
    if (k) return k;
  }
  return "";
}

// 挑一个尽量便宜的测试模型，优先级：
//   别名键含 haiku > 含 sonnet > 任意别名键 > allowedModels[0] > 空。
// 前四档都能推出一个「对外模型名」；最后一档拿不到任何线索，返回空串（调用方原样透传）。
// 返回 { clientModel, upstreamModel }：clientModel 是暴露给成员的名字，upstreamModel
// 是经 resolveModel 映射后真正发给上游的名字（没有别名命中时两者相同）。
export function pickTestModel(profileCfg, resolveModelImpl) {
  const cfg = profileCfg || {};
  const aliases = (cfg.modelAliases && typeof cfg.modelAliases === "object") ? cfg.modelAliases : {};
  const keys = Object.keys(aliases);
  const allowed = Array.isArray(cfg.allowedModels)
    ? cfg.allowedModels.filter(m => typeof m === "string" && m)
    : [];
  const pick = (needle) => keys.find(k => k.toLowerCase().includes(needle));
  const clientModel = pick("haiku") || pick("sonnet") || keys[0] || allowed[0] || "";
  const resolve = typeof resolveModelImpl === "function" ? resolveModelImpl : defaultResolveModel;
  return { clientModel, upstreamModel: resolve(clientModel, cfg) };
}

// 尽力抽取回复文本，仅供展示：抽不到不算失败（有些上游把正文放在更深的字段里）。
function extractReplyText(protocol, json) {
  if (!json || typeof json !== "object") return "";
  let out = "";
  if (protocol === "responses") {
    if (typeof json.output_text === "string") out = json.output_text;
    if (!out && Array.isArray(json.output)) {
      for (const item of json.output) {
        const content = item && Array.isArray(item.content) ? item.content : [];
        for (const c of content) {
          if (c && typeof c.text === "string") out += c.text;
        }
      }
    }
  } else {
    for (const c of Array.isArray(json.content) ? json.content : []) {
      if (c && typeof c.text === "string") out += c.text;
    }
  }
  out = String(out || "").replace(/\s+/g, " ").trim();
  return out.length > REPLY_MAX ? out.slice(0, REPLY_MAX) + "…" : out;
}

// 从上游错误体里挑一句人能看的话。上游格式五花八门（Anthropic 的
// {error:{type,message}}、OpenAI 的 {error:{message}}、有的直接 {error:"..."}、
// 还有纯文本/HTML），逐层降级，并统一压成单行 + 截断，避免把大段 HTML 灌进弹窗。
function extractErrorText(json, raw, status) {
  let msg = "";
  if (json && typeof json === "object") {
    const e = json.error;
    if (e && typeof e === "object") msg = e.message || e.type || "";
    else if (typeof e === "string") msg = e;
    if (!msg && typeof json.message === "string") msg = json.message;
  }
  if (!msg && typeof raw === "string") msg = raw;
  msg = String(msg || "").replace(/\s+/g, " ").trim();
  if (msg.length > ERROR_MAX) msg = msg.slice(0, ERROR_MAX) + "…";
  return msg || `上游返回 HTTP ${status}`;
}

// 真正发一次最小请求。返回 { ok, status, ms, model, url, text, error }：
//   ok      2xx 为 true
//   status  上游 HTTP 状态码（没发出去 / 网络失败 / 超时都是 0）
//   ms      整个往返耗时
//   model   实际发给上游的模型名
//   url     实际请求的上游地址（构造自 origin + path，天然不含 Key）
//   text    尽力抽取的回复文本，抽不到是空串
//   error   失败原因（配置缺失 / 超时 / 网络错误 / 上游错误正文）
// 本函数不写审计日志 —— 审计是 server 侧的事，纯逻辑保持无副作用。
export async function runProfileTest({
  profileCfg,
  profileName,
  fetchImpl,
  timeoutMs,
  resolveModel,
  getRealKey,
  realKey,
  now,
} = {}) {
  const cfg = profileCfg || {};
  const doFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  const clock = typeof now === "function" ? now : Date.now;
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : PROFILE_TEST_TIMEOUT_MS;
  const protocol = normalizeProtocol(cfg);
  // profileName 目前在请求本身用不到，保留在签名里是为了调用方（server 的日志/审计）
  // 与这里共用同一份入参对象，不额外拼装。
  void profileName;

  const base0 = { ok: false, status: 0, ms: 0, model: "", url: "", text: "", error: "" };

  const upstream = String(cfg.upstream || "").trim();
  if (!upstream) return { ...base0, error: PROFILE_TEST_ERR_NO_UPSTREAM };

  const key = typeof realKey === "string"
    ? realKey
    : (typeof getRealKey === "function" ? getRealKey(cfg) : pickRealKey(cfg));
  if (!key) return { ...base0, error: PROFILE_TEST_ERR_NO_KEY };

  let base;
  try {
    base = new URL(upstream);
  } catch {
    return { ...base0, error: "上游地址格式不正确" };
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    return { ...base0, error: "上游地址必须是 http 或 https" };
  }

  const { upstreamModel: pickedModel } = pickTestModel(cfg, resolveModel);
  // 挑不出模型就按协议兜底，绝不发一个空 model 出去（上游会 400，用户会误判）。
  const upstreamModel = pickedModel || PROFILE_TEST_FALLBACK_MODEL[protocol];
  // 出站路径与真实代理同一套规则（lib/proxy-helpers.mjs 的 buildUpstreamPath）：
  // 上游地址已带 /v1 结尾时只补 /messages，避免拼出 /v1/v1/messages。
  // responses 协议还要尊重方案自己的 responsesPath（火山 Coding Plan 用 /responses），
  // 否则测试打的是网关真实请求之外的端点，结论会骗人。
  const reqUrl = protocol === "responses"
    ? (String(cfg.responsesPath || "").trim() || "/v1/responses")
    : "/v1/messages";
  let url;
  try {
    url = base.origin + buildUpstreamPath(reqUrl, { upstreamUrl: base });
  } catch {
    url = base.origin + reqUrl;
  }

  const headers = protocol === "responses"
    ? { authorization: `Bearer ${key}`, "content-type": "application/json" }
    : { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  const payload = protocol === "responses"
    ? { model: upstreamModel, input: "hi", max_output_tokens: 16 }
    : { model: upstreamModel, max_tokens: 16, messages: [{ role: "user", content: "hi" }] };

  const ctrl = new AbortController();
  const started = clock();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, limit);
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    let raw = "";
    try { raw = await res.text(); } catch {}
    const ms = Math.max(0, clock() - started);
    const status = Number(res.status) || 0;
    const ok = typeof res.ok === "boolean" ? res.ok : (status >= 200 && status < 300);
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch {}
    if (!ok) {
      return { ok: false, status, ms, model: upstreamModel, url, text: "", error: extractErrorText(json, raw, status) };
    }
    return { ok: true, status, ms, model: upstreamModel, url, text: extractReplyText(protocol, json), error: "" };
  } catch (err) {
    const ms = Math.max(0, clock() - started);
    const error = timedOut
      ? `请求超时（${Math.round(limit / 1000)} 秒未返回）`
      : `请求失败：${(err && err.message) ? err.message : String(err)}`;
    return { ok: false, status: 0, ms, model: upstreamModel, url, text: "", error };
  } finally {
    clearTimeout(timer);
  }
}
