// lib/upstream-quota.mjs —— 上游额度/余额查询（平台适配器框架 + 官方 API-key 适配器）。
//
// 背景：本地配额（quota.mjs）数的是**经过本代理的用量**；但套餐里还剩多少、账户里还
// 有多少钱，只有上游自己知道。本模块负责用**用户已有的凭据**去问上游：
//   · 推理 API Key（Bearer / 裸 key）—— DeepSeek、阶跃星辰、Kimi、OpenRouter、硅基流动、
//     智谱（未文档化接口）、MiniMax 等
//   · 云账号 AK/SK 签名 —— 火山方舟、阿里云、腾讯云（见 upstream-quota-cloud.mjs）
//   · 自定义 HTTP —— 任意平台，按 JSON 路径映射（自定义抓取）
//   · manualOnly —— 官方只给控制台的平台，这里只提供跳转入口 + 说明（腾讯 TokenHub、百炼套餐）
//
// 设计约束（与仓库其余部分一致）：
//   1. 零外部依赖：只用 node 内建 + 全局 fetch（Node 18+）。
//   2. 纯解析器与网络分离：parseXxx(json) 全部导出，测试不必起网络。
//   3. 失败必须「局部化」：一个平台报错绝不影响其它平台，快照里逐项带 error。
//   4. 不把密钥写进日志，快照里只出现掩码。
//   5. 缓存 + 去重：同一平台并发刷新只发一次请求（inflight 复用），TTL 内直接读缓存。
//
// 时间口径：所有 resetAt 都是 **epoch 毫秒**，展示层统一按北京时间（UTC+8）格式化。

import { CLOUD_PROVIDER_DEFS } from "./upstream-quota-cloud.mjs";

// ─── 通用小工具 ──────────────────────────────────────────────────────────────

// 上游返回的数字可能是字符串（"110.00"）或数字，统一转成 Number；非法值给 null。
export function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

// 百分比：优先用上游给的 percentage/percent；没有就用 used/total 算。
export function pctOf(used, total, given) {
  const g = num(given);
  if (g !== null) return g > 1.0001 ? Math.min(g, 100) : Math.round(g * 10000) / 100;
  const u = num(used), t = num(total);
  if (u === null || t === null || t <= 0) return null;
  return Math.round((u / t) * 10000) / 100;
}

export function maskKey(k) {
  const s = String(k || "");
  if (!s) return "";
  if (s.length <= 8) return s.slice(0, 2) + "***";
  return s.slice(0, 4) + "***" + s.slice(-4);
}

// 秒 / 毫秒混用的重置时间统一成毫秒 epoch。上游常见三种：epoch 秒、epoch 毫秒、ISO 串。
export function toEpochMs(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string" && /[T:-]/.test(v) && !/^\d+$/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

// 相对秒数（「还有 3600 秒重置」这类字段）→ epoch 毫秒。
function relToMs(v, now) {
  const n = num(v);
  return n === null || n <= 0 ? null : now + n * 1000;
}

// ─── 凭据解析 ────────────────────────────────────────────────────────────────
//
// keySource 三态：
//   "auto"    从「方案」里自动找：按 provider.matchHosts 匹配方案的 upstream 主机名，
//             再取该方案里任一**已配置真实 Key** 的成员 —— 用户接好的 plan 零配置可用。
//   "profile" 指定 方案 + 成员（管理员显式选择，用于一个平台接了多套 plan 的场景）。
//   "inline"  手动填写（云账号 AK/SK、没有经过本代理的账号都走这里）。
export function resolveApiKey(cfg, profiles, users) {
  const c = cfg || {};
  if (c.keySource === "profile") {
    const p = (profiles || []).find((x) => x.suffix === c.profileSuffix);
    if (!p) return { key: "", source: "", error: `方案「${c.profileSuffix || ""}」不存在` };
    const entry = (p.users || {})[c.memberKey];
    const key = typeof entry === "string" ? entry : (entry && entry.key) || "";
    if (!key) return { key: "", source: "", error: `方案「${p.name}」的成员 ${c.memberKey || "（未选）"} 没有配置 Key` };
    const uname = (users && users[c.memberKey] && users[c.memberKey].username) || c.memberKey;
    return { key, source: `${p.name} / ${uname}`, profileSuffix: p.suffix, memberKey: c.memberKey };
  }
  if (c.keySource === "auto") {
    const hosts = (cfg && cfg.matchHosts) || [];
    for (const host of hosts) {
      for (const p of profiles || []) {
        let h = "";
        try { h = new URL(p.upstream || "").host; } catch { h = ""; }
        if (!h || (h !== host && !h.endsWith("." + host))) continue;
        for (const [memberKey, entry] of Object.entries(p.users || {})) {
          const key = typeof entry === "string" ? entry : (entry && entry.key) || "";
          if (!key || (entry && entry.disabled)) continue;
          const uname = (users && users[memberKey] && users[memberKey].username) || memberKey;
          return { key, source: `${p.name} / ${uname}`, profileSuffix: p.suffix, memberKey, auto: true };
        }
      }
    }
    return { key: "", source: "", error: "没有找到可用的方案密钥（可在下方改为手动填写）" };
  }
  const inline = String(c.apiKey || "").trim();
  if (inline) return { key: inline, source: "手动填写" };
  return { key: "", source: "", error: "未配置凭据" };
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

// 返回 { status, ok, json, text }；非 2xx 不抛（适配器要读错误报文里的平台错误码）。
export async function httpJson(url, { method = "GET", headers = {}, body, timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1000, timeoutMs));
  try {
    const res = await fetchImpl(url, { method, headers, body, signal: ac.signal, redirect: "follow" });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, ok: res.ok, json, text, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

// 上游把错误塞在 200 的 body 里（智谱、硅基流动都这么干），所以适配器要自己看业务码。
function apiError(r, extra = "") {
  const snippet = (r.text || "").slice(0, 200).replace(/\s+/g, " ");
  return new Error(`HTTP ${r.status}${extra ? " " + extra : ""}: ${snippet || "(空响应)"}`);
}

// ─── 平台定义（API Key 类） ───────────────────────────────────────────────────

// 每个适配器的形状：
//   { id, name, group, kind, credential:"apiKey"|"accessKey"|"none", matchHosts:[], fields:[],
//     consoleUrl, docsUrl, note, experimental?, manualOnly?, run(ctx) -> { items:[...] } }
// item 形状：{ id, label, kind:"balance"|"quota", used, total, remaining, unit, percent, resetAt, note }
// 接入点覆盖：设置页每张平台卡片都有「接入点覆盖（留空=官方默认）」输入框，
// 所以每个 def 都必须真的读它 —— 否则管理员填了没反应（只有 glm/minimax/custom 用过它）。
function baseOf(cfg, fallback) {
  const b = cfg && typeof cfg.baseUrl === "string" ? cfg.baseUrl.trim() : "";
  return (b || fallback).replace(/\/+$/, "");
}

export const LOCAL_PROVIDER_DEFS = [
  // ── DeepSeek：官方文档化的余额接口 ─────────────────────────────────────────
  {
    id: "deepseek",
    name: "DeepSeek",
    group: "官方余额",
    credential: "apiKey",
    matchHosts: ["api.deepseek.com"],
    consoleUrl: "https://platform.deepseek.com/usage",
    docsUrl: "https://api-docs.deepseek.com/zh-cn/api/get-user-balance/",
    note: "官方接口 GET /user/balance：总余额 = 赠金 + 充值。Anthropic 兼容端点用的是同一把平台 Key。",
    async run({ cred, cfg, timeoutMs, fetchImpl }) {
      const r = await httpJson(`${baseOf(cfg, "https://api.deepseek.com")}/user/balance`, {
        headers: { Authorization: `Bearer ${cred.key}` }, timeoutMs, fetchImpl,
      });
      if (!r.ok) throw apiError(r);
      return { items: parseDeepSeekBalance(r.json) };
    },
  },

  // ── 阶跃星辰：官方文档化的账户接口（Step Plan 的 Credit 也在这个账户下） ──
  {
    id: "stepfun",
    name: "阶跃星辰 StepFun",
    group: "官方余额",
    credential: "apiKey",
    matchHosts: ["api.stepfun.com"],
    consoleUrl: "https://platform.stepfun.com/step-plan",
    docsUrl: "https://platform.stepfun.com/docs/zh/api-reference/accounts/get",
    note: "官方接口 GET /v1/accounts：prepaid 预付费账户的可用余额。Step Plan 套餐额度官方只在控制台展示。",
    async run({ cred, cfg, timeoutMs, fetchImpl }) {
      const r = await httpJson(`${baseOf(cfg, "https://api.stepfun.com")}/v1/accounts`, {
        headers: { Authorization: `Bearer ${cred.key}` }, timeoutMs, fetchImpl,
      });
      if (!r.ok) throw apiError(r);
      return { items: parseStepFunAccount(r.json) };
    },
  },

  // ── 月之暗面 Kimi ──────────────────────────────────────────────────────────
  {
    id: "moonshot",
    name: "月之暗面 Kimi",
    group: "官方余额",
    credential: "apiKey",
    matchHosts: ["api.moonshot.cn", "api.moonshot.ai"],
    consoleUrl: "https://platform.moonshot.cn/console/info",
    docsUrl: "https://platform.moonshot.cn/docs/api/balance",
    note: "官方接口 GET /v1/users/me/balance：可用余额 / 代金券余额 / 现金余额。Kimi Code 订阅额度官方无接口。",
    async run({ cred, cfg, timeoutMs, fetchImpl }) {
      const r = await httpJson(`${baseOf(cfg, "https://api.moonshot.cn")}/v1/users/me/balance`, {
        headers: { Authorization: `Bearer ${cred.key}` }, timeoutMs, fetchImpl,
      });
      if (!r.ok) throw apiError(r);
      return { items: parseMoonshotBalance(r.json) };
    },
  },

  // ── OpenRouter：官方 credits 接口 ─────────────────────────────────────────
  {
    id: "openrouter",
    name: "OpenRouter",
    group: "官方余额",
    credential: "apiKey",
    matchHosts: ["openrouter.ai"],
    consoleUrl: "https://openrouter.ai/settings/credits",
    docsUrl: "https://openrouter.ai/docs/api-reference/limits",
    note: "官方接口 GET /api/v1/credits：总额度与累计消耗，差额即剩余额度（USD）。",
    async run({ cred, cfg, timeoutMs, fetchImpl }) {
      const r = await httpJson(`${baseOf(cfg, "https://openrouter.ai")}/api/v1/credits`, {
        headers: { Authorization: `Bearer ${cred.key}` }, timeoutMs, fetchImpl,
      });
      if (!r.ok) throw apiError(r);
      return { items: parseOpenRouterCredits(r.json) };
    },
  },

  // 硅基流动已挪到下面「仅控制台」组：官方 /v1/user/info 于 2026 年初下线（实测 410）。

  // ── 智谱 GLM（含 GLM Coding Plan）：接口未官方文档化，靠社区逆向 ──────────
  {
    id: "glm",
    name: "智谱 GLM / GLM Coding Plan",
    group: "套餐额度",
    credential: "apiKey",
    matchHosts: ["open.bigmodel.cn", "api.z.ai"],
    consoleUrl: "https://www.bigmodel.cn/coding-plan/personal/usage",
    docsUrl: "https://github.com/focksor/pi-glm-quota",
    experimental: true,
    note: "套餐窗口(5 小时/周)与账户余额走控制台私有接口，官方未文档化：国内站 Authorization 用「裸 Key」（不加 Bearer），"
      + "国际站 api.z.ai 用 Bearer。接口结构可能随时变化，失败时请以控制台为准。",
    extraFields: [
      { key: "org", label: "组织 ID（可选）", placeholder: "bigmodel-organization 头，可留空" },
      { key: "project", label: "项目 ID（可选）", placeholder: "bigmodel-project 头，可留空" },
    ],
    async run({ cred, cfg, timeoutMs, fetchImpl }) {
      // 国内站裸 Key、国际站 Bearer；baseUrl 留空时按国内站走，接 z.ai 的用户在设置里填基础地址。
      const base = String((cfg && cfg.baseUrl) || "https://open.bigmodel.cn").replace(/\/+$/, "");
      const isIntl = /api\.z\.ai/.test(base);
      const headers = { Authorization: isIntl ? `Bearer ${cred.key}` : cred.key, "Content-Type": "application/json" };
      const extra = (cfg && cfg.extra) || {};
      if (extra.org) headers["bigmodel-organization"] = String(extra.org);
      if (extra.project) headers["bigmodel-project"] = String(extra.project);
      const items = [];
      // 套餐窗口：官方未文档化的控制台接口。⚠️ 这里的 type 参数很坑 —— 个人版套餐用
      // 「不带 type」的默认查询才有数据，传 ?type=2（团队版）会返回 data:{}（0 个窗口、
      // HTTP 200、无任何错误），于是卡片上只剩账户余额、看不到 5 小时/周窗口。
      // 实测：个人 Key 默认查询可用；为兼容团队版，按「默认 → type=1 → type=2」依次试，
      // 取第一个真的返回窗口的响应（个人账号正常只发 1 个请求）。
      let windows = [];
      let quotaErr = null;
      for (const qs of ["", "?type=1", "?type=2"]) {
        const q = await httpJson(`${base}/api/monitor/usage/quota/limit${qs}`, { headers, timeoutMs, fetchImpl });
        if (!q.ok) { quotaErr = `套餐窗口接口 HTTP ${q.status}`; continue; }
        windows = parseGlmQuotaLimit(q.json);
        if (windows.length) { quotaErr = null; break; }
        quotaErr = "套餐窗口接口返回 0 个窗口（该 Key 可能没订阅 Coding Plan，或需要填组织 / 项目 ID）";
      }
      items.push(...windows);
      let accErr = null;
      const acc = await httpJson(`${base}/api/biz/account/query-customer-account-report`, { headers, timeoutMs, fetchImpl });
      if (acc.ok) items.push(...parseGlmAccountReport(acc.json));
      else accErr = `账户余额接口 HTTP ${acc.status}`;
      const warnings = [quotaErr, accErr].filter(Boolean);
      if (!items.length) throw new Error("智谱额度接口不可用（" + (warnings.join("；") || "没有任何返回") + "）—— 控制台私有接口可能已变更");
      return { items, warnings };
    },
  },

  // ── MiniMax Token Plan：接口未文档化 ──────────────────────────────────────
  {
    id: "minimax",
    name: "MiniMax",
    group: "套餐额度",
    credential: "apiKey",
    matchHosts: ["api.minimaxi.com", "api.minimax.chat"],
    consoleUrl: "https://platform.minimaxi.com/user-center/basic-information",
    experimental: true,
    note: "Token Plan 用量走控制台私有接口（社区逆向），字段结构随版本变动；失败时以控制台为准。",
    async run({ cred, cfg, timeoutMs, fetchImpl }) {
      const base = (cfg && cfg.baseUrl) || "https://api.minimaxi.com";
      const r = await httpJson(`${base}/v1/query/token_plan`, {
        headers: { Authorization: `Bearer ${cred.key}`, "Content-Type": "application/json" }, timeoutMs, fetchImpl,
      });
      if (!r.ok) throw apiError(r);
      return { items: parseMiniMaxTokenPlan(r.json) };
    },
  },

  // ── Claude Code 订阅窗口（OAuth token）：接口未文档化 ─────────────────────
  {
    id: "claude-sub",
    name: "Claude 订阅窗口（Claude Code）",
    group: "套餐额度",
    credential: "apiKey",
    matchHosts: ["api.anthropic.com"],
    defaultEnabled: false,   // 需要 OAuth token，普通 API Key 会 401 —— 默认不开，免得面板一片红
    consoleUrl: "https://claude.ai/settings/usage",
    experimental: true,
    note: "读取 Claude 订阅的 5 小时 / 7 天窗口用量。需要 OAuth access token（claude setup-token 或本机凭据文件里的 token），"
      + "不是 sk-ant- 开头的普通 API Key；接口未文档化。",
    extraFields: [{ key: "oauth", label: "OAuth Token（sk-ant-oat…）", type: "password", placeholder: "留空则用 apiKey 栏的值" }],
    async run({ cred, cfg, timeoutMs, fetchImpl }) {
      const token = ((cfg && cfg.extra && cfg.extra.oauth) || cred.key || "").trim();
      const r = await httpJson(`${baseOf(cfg, "https://api.anthropic.com")}/api/oauth/usage`, {
        headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, timeoutMs, fetchImpl,
      });
      if (!r.ok) throw apiError(r);
      return { items: parseClaudeOauthUsage(r.json) };
    },
  },

  // ── OpenAI 组织用量（Admin Key） ─────────────────────────────────────────
  {
    id: "openai-admin",
    name: "OpenAI（组织用量）",
    group: "官方余额",
    credential: "apiKey",
    matchHosts: ["api.openai.com"],
    defaultEnabled: false,   // 需要 Admin Key，普通 Key 读不到组织用量
    consoleUrl: "https://platform.openai.com/usage",
    docsUrl: "https://platform.openai.com/docs/api-reference/usage",
    experimental: true,
    note: "需要「Admin Key」（sk-admin-…），返回的是组织维度的用量/成本，不是「剩余额度」（OpenAI 无余额接口）。",
    async run({ cred, cfg, timeoutMs, fetchImpl }) {
      const start = Math.floor((Date.now() - 30 * 24 * 3600e3) / 1000);
      const r = await httpJson(`${baseOf(cfg, "https://api.openai.com")}/v1/organizations/costs?start_time=${start}&limit=31`, {
        headers: { Authorization: `Bearer ${cred.key}` }, timeoutMs, fetchImpl,
      });
      if (!r.ok) throw apiError(r);
      return { items: parseOpenAiCosts(r.json) };
    },
  },

  // ── 自定义 HTTP：任何平台都能接（按 JSON 路径映射） ────────────────────────
  {
    id: "custom",
    name: "自定义 HTTP 接口",
    group: "自定义",
    credential: "apiKey",
    matchHosts: [],
    defaultEnabled: false,   // 要手填 URL，没配之前开着只会报「未配置」
    fields: [
      { key: "url", label: "请求地址（必填）", type: "url", required: true, placeholder: "https://example.com/api/quota" },
    ],
    extraFields: [
      { key: "headerName", label: "鉴权头", placeholder: "默认 Authorization" },
      { key: "headerPrefix", label: "鉴权前缀", placeholder: "默认 Bearer " },
      { key: "method", label: "方法", placeholder: "GET / POST" },
      { key: "body", label: "请求体（POST，JSON 字符串）", placeholder: "{}" },
      { key: "jsonPath", label: "JSON 路径", placeholder: "data（留空=响应根）" },
      { key: "usedPath", label: "已用字段", placeholder: "used" },
      { key: "totalPath", label: "总额度字段", placeholder: "total" },
      { key: "remainingPath", label: "剩余字段", placeholder: "remaining" },
      { key: "percentPath", label: "百分比字段", placeholder: "percent" },
      { key: "resetPath", label: "重置时间字段", placeholder: "reset_at" },
      { key: "label", label: "显示名", placeholder: "自定义额度" },
      { key: "unit", label: "单位", placeholder: "CNY / USD / tokens / %" },
    ],
    note: "给没有官方额度接口的平台用：填请求地址 + 鉴权头，再把返回 JSON 里「已用/总额/剩余/重置时间」的字段名填上。"
      + "字段名支持 a.b.c 形式的嵌套路径。",
    async run({ cred, cfg, timeoutMs, fetchImpl }) {
      const extra = (cfg && cfg.extra) || {};
      const url = String(extra.url || cfg.baseUrl || "").trim();
      if (!url) throw new Error("未填写请求地址");
      const headerName = String(extra.headerName || "Authorization").trim();
      const headerPrefix = extra.headerPrefix === undefined ? "Bearer " : String(extra.headerPrefix);
      const headers = { "Content-Type": "application/json" };
      if (cred.key) headers[headerName] = headerPrefix ? headerPrefix.replace(/^(\S+)$/, "$1 ") + cred.key : cred.key;
      const method = String(extra.method || "GET").toUpperCase();
      const r = await httpJson(url, { method, headers, body: method === "POST" ? (extra.body || "{}") : undefined, timeoutMs, fetchImpl });
      if (!r.ok) throw apiError(r);
      return { items: parseCustom(r.json, extra) };
    },
  },

  // ── 仅控制台：官方没有可编程接口的平台（提供入口与说明，不做抓取） ────────
  {
    id: "tencent-codingplan",
    name: "腾讯云 TokenHub Coding Plan",
    group: "仅控制台",
    credential: "none",
    manualOnly: true,
    consoleUrl: "https://console.cloud.tencent.com/tokenhub/codingplan",
    docsUrl: "https://cloud.tencent.com/document/product/1823/130103",
    note: "官方只在控制台展示 5 小时 / 每周 / 每订阅月用量，无 API。"
      + "账户充值余额可在「腾讯云（账户余额）」里用 SecretId/SecretKey 查；套餐额度只能在控制台看，"
      + "或等上游回报 20097 hour/week/month allocated quota exceeded。",
  },
  {
    id: "aliyun-bailian-plan",
    name: "阿里云百炼 Coding Plan",
    group: "仅控制台",
    credential: "none",
    manualOnly: true,
    consoleUrl: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/overview",
    docsUrl: "https://help.aliyun.com/zh/model-studio/cli/usage-quota",
    note: "百炼 **Coding Plan** 的用量官方只在控制台 / bl CLI 里看（bl usage coding-plan 需要控制台登录态）。"
      + "Token Plan 已有官方 OpenAPI，见「阿里云百炼 Token Plan」；账户现金余额见「阿里云账户余额」。",
  },
  {
    id: "codebuddy",
    name: "腾讯 CodeBuddy",
    group: "仅控制台",
    credential: "none",
    manualOnly: true,
    consoleUrl: "https://www.codebuddy.cn/home/",
    docsUrl: "https://www.codebuddy.cn/docs/ide/Account/usage",
    note: "官方只在网页「个人主页 - 套餐与用量」展示，无 API。",
  },
  {
    id: "siliconflow",
    name: "硅基流动 SiliconFlow",
    group: "仅控制台",
    credential: "none",
    manualOnly: true,
    matchHosts: ["api.siliconflow.cn", "api.siliconflow.com"],
    consoleUrl: "https://cloud.siliconflow.cn/account/charge",
    docsUrl: "https://docs.siliconflow.cn/cn/api-reference/userinfo/get-user-info",
    note: "官方 GET /v1/user/info 已于 2026 年初下线（实测 HTTP 410 + code 20092），替代接口未公布：余额只能到控制台看。"
      + "（官方 2025-12 公告称字段先清零、接口随后下线；官网文档与 openapi.yaml 仍是旧的。将来公布新接口后，"
      + "把本项挪回「官方余额」组并接上 run 即可；解析器 parseSiliconFlowUserInfo 仍保留，自定义接口可直接复用。）",
  },
];

// ─── 纯解析器（导出供测试；对上游字段缺失必须容错） ──────────────────────────

export function parseDeepSeekBalance(json) {
  const infos = (json && json.balance_infos) || [];
  if (!Array.isArray(infos) || !infos.length) throw new Error("响应里没有 balance_infos");
  return infos.map((b) => {
    const total = num(b.total_balance);
    return {
      id: `balance-${b.currency || "CNY"}`,
      label: "账户余额（含赠金）",
      kind: "balance",
      total, remaining: total, used: null, unit: b.currency || "CNY",
      note: `赠金 ${num(b.granted_balance) ?? "—"} / 充值 ${num(b.topped_up_balance) ?? "—"}`,
      available: json.is_available !== false,
    };
  });
}

export function parseStepFunAccount(json) {
  const j = json || {};
  const balance = num(j.balance);
  return [{
    id: "balance",
    label: j.type === "postpaid" ? "后付费账户余额" : "预付费账户余额",
    kind: "balance",
    total: balance, remaining: balance, used: null, unit: "CNY",
    note: `累计充值 ${num(j.total_cash_balance) ?? "—"} / 累计赠送 ${num(j.total_voucher_balance) ?? "—"}`,
  }];
}

export function parseMoonshotBalance(json) {
  const j = (json && json.data) || json || {};
  const avail = num(j.available_balance);
  return [{
    id: "balance",
    label: "可用余额",
    kind: "balance",
    total: avail, remaining: avail, used: null, unit: "CNY",
    note: `代金券 ${num(j.voucher_balance) ?? "—"} / 现金 ${num(j.cash_balance) ?? "—"}`,
  }];
}

export function parseOpenRouterCredits(json) {
  const j = (json && json.data) || json || {};
  const total = num(j.total_credits);
  const used = num(j.total_usage);
  const remaining = total === null ? null : Math.round((total - (used || 0)) * 1e6) / 1e6;
  return [{
    id: "credits",
    label: "剩余额度",
    kind: "balance",
    total, used, remaining, unit: "USD",
    percent: pctOf(used, total),
    note: `已用 ${used ?? "—"} USD`,
  }];
}

// 硅基流动的解析器：官方 /v1/user/info 已于 2026 年初下线，内置平台里不再有 run 调它。
// 保留是因为字段口径（totalBalance / chargeBalance / balance）仍然成立——将来官方公布
// 替代接口，或用户用「自定义 HTTP 接口」接自建网关时，可以直接复用。
export function parseSiliconFlowUserInfo(json) {
  const j = (json && json.data) || json || {};
  const total = num(j.totalBalance);
  return [{
    id: "balance",
    label: "账户总余额",
    kind: "balance",
    total, remaining: total, used: null, unit: "CNY",
    note: `赠费 ${num(j.chargeBalance) ?? "—"} / 充值 ${num(j.balance) ?? "—"}`,
  }];
}

// 智谱：data.limits[] 里 unit=3 是 5 小时窗口、unit=6 是周窗口。
// usage=窗口总额度、currentValue=已用、remaining=剩余、percentage=已用百分比(%)。
// 智谱专用：percentage 是 0–100 的百分数（不是 0–1 小数）；缺 percentage 时用 currentValue/usage 反推。
function glmPercent(given, used, total) {
  const g = num(given);
  if (g !== null) return Math.max(0, Math.min(100, Math.round(g * 100) / 100));
  const u = num(used), t = num(total);
  if (u === null || t === null || t <= 0) return null;
  return Math.round((u / t) * 10000) / 100;
}

export function parseGlmQuotaLimit(json) {
  const data = (json && json.data) || {};
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const items = [];
  for (const l of limits) {
    const isTokens = String(l.type || "").toUpperCase() === "TOKENS_LIMIT";
    const total = num(l.usage);
    const used = num(l.currentValue);
    let label = null;
    if (num(l.unit) === 3) label = "5 小时窗口";
    else if (num(l.unit) === 6) label = "每周窗口";
    else if (num(l.unit) === 5 || num(l.unit) === 4) label = "每月窗口";
    else if (!isTokens) label = String(l.type || "额度");
    if (!label) label = `窗口(unit=${l.unit})`;
    // ⚠️ 智谱的 percentage 是 0–100 的百分数（线上：TOKENS_LIMIT 给 35 / 90，TIME_LIMIT 给 1），
    // 不能套 pctOf —— pctOf 为兼容「0–1 小数」的平台会把 1 当成 100%，卡片上就会出现假的 100%。
    const percent = glmPercent(l.percentage, used, total);
    items.push({
      id: `glm-${l.unit || l.type}-${items.length}`,
      label,
      kind: "quota",
      total, used, remaining: num(l.remaining), unit: isTokens ? "tokens" : "%",
      percent,
      resetAt: toEpochMs(l.nextResetTime),
      note: percent === null ? "" : `已用 ${percent}%`,
    });
  }
  return items;
}

export function parseGlmAccountReport(json) {
  const d = (json && json.data) || {};
  const avail = num(d.availableBalance);
  const balance = num(d.balance);
  const items = [];
  if (avail !== null || balance !== null) {
    items.push({
      id: "glm-balance",
      label: "账户余额",
      kind: "balance",
      total: avail !== null ? avail : balance, remaining: avail !== null ? avail : balance, used: null, unit: "CNY",
      note: `充值 ${num(d.rechargeAmount) ?? "—"} / 赠送 ${num(d.giveAmount) ?? "—"} / 累计消费 ${num(d.totalSpendAmount) ?? "—"}`,
    });
  }
  return items;
}

// MiniMax：社区逆向的 token_plan 响应。兼容 model_remains / token_plan 两种形状。
export function parseMiniMaxTokenPlan(json) {
  const j = json || {};
  const items = [];
  const push = (label, used, total, resetAt, unit) => {
    const percent = pctOf(used, total);
    items.push({
      id: `minimax-${items.length}`, label, kind: "quota",
      used, total, remaining: (used !== null && total !== null) ? total - used : null,
      unit: unit || "tokens", percent, resetAt: toEpochMs(resetAt),
    });
  };
  const remains = j.model_remains || j.token_plan || (j.data && (j.data.model_remains || j.data.token_plan));
  if (Array.isArray(remains)) {
    for (const m of remains) {
      const total = num(m.total_count ?? m.total ?? m.quota);
      const left = num(m.remaining_count ?? m.remain ?? m.remaining);
      const used = num(m.used_count ?? m.used) ?? (total !== null && left !== null ? total - left : null);
      push(String(m.model_name || m.model || "Token Plan"), used, total, m.end_time ?? m.reset_time ?? m.expire_time, m.unit);
    }
  }
  const buckets = [["5 小时窗口", j.hour_used ?? j.hourUsed, j.hour_total ?? j.hourTotal, j.hour_reset],
    ["每周窗口", j.week_used ?? j.weekUsed, j.week_total ?? j.weekTotal, j.week_reset]];
  for (const [label, used, total, reset] of buckets) {
    if (used !== undefined || total !== undefined) push(label, num(used), num(total), reset);
  }
  if (!items.length) throw new Error("响应里没有可识别的 Token Plan 字段（接口可能已变更）");
  return items;
}

// Claude 订阅：5 小时 / 7 天窗口，字段名随版本变动，按组递归找 utilization/resets_at。
export function parseClaudeOauthUsage(json) {
  const j = json || {};
  const items = [];
  const visit = (node, label, depth) => {
    if (!node || typeof node !== "object" || depth > 3) return;
    const util = num(node.utilization ?? node.used_percent ?? node.percentage);
    if (util !== null && (node.resets_at || node.reset_at || node.resetsAt)) {
      items.push({
        id: `claude-${items.length}`, label, kind: "quota",
        used: util, total: 100, remaining: Math.round((100 - util) * 100) / 100, unit: "%",
        percent: util, resetAt: toEpochMs(node.resets_at ?? node.reset_at ?? node.resetsAt),
      });
      return;
    }
    for (const [k, v] of Object.entries(node)) visit(v, prettyWindowLabel(k), depth + 1);
  };
  visit(j, "订阅额度", 0);
  if (!items.length) throw new Error("响应里没有可识别的窗口字段（接口可能已变更）");
  return items;
}

function prettyWindowLabel(k) {
  const s = String(k).toLowerCase();
  if (s.includes("five") || s.includes("5h") || s.includes("5_hour") || s.includes("session")) return "5 小时窗口";
  if (s.includes("seven") || s.includes("7d") || s.includes("week")) return "7 天窗口";
  return String(k);
}

export function parseOpenAiCosts(json) {
  const arr = (json && (json.data || json.buckets)) || [];
  let total = 0;
  let currency = "USD";
  for (const b of Array.isArray(arr) ? arr : []) {
    const results = b.results || [b];
    for (const r of results) {
      total += num(r.amount && (r.amount.value ?? r.amount)) || 0;
      if (r.amount && r.amount.currency) currency = r.amount.currency;
    }
  }
  return [{
    id: "openai-cost", label: "近 30 天组织消耗", kind: "balance",
    used: Math.round(total * 100) / 100, total: null, remaining: null, unit: currency,
    note: "OpenAI 无余额接口，这里只能给出组织维度的已消费金额",
  }];
}

// 自定义：按调用方给的字段名取值（支持 a.b.c 嵌套），全部缺失就报错，避免「静默的 0」。
export function parseCustom(json, mapping = {}) {
  const pick2 = (obj, path) => {
    if (!path) return undefined;
    let cur = obj;
    for (const seg of String(path).split(".")) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[seg];
    }
    return cur;
  };
  const root = mapping.jsonPath ? pick2(json, mapping.jsonPath) : json;
  if (!root || typeof root !== "object") throw new Error(`JSON 路径 ${mapping.jsonPath || "(根)"} 上没有对象`);
  const used = num(pick2(root, mapping.usedPath));
  const total = num(pick2(root, mapping.totalPath));
  const remaining = num(pick2(root, mapping.remainingPath));
  const percent = num(pick2(root, mapping.percentPath));
  const resetRaw = pick2(root, mapping.resetPath);
  if (used === null && total === null && remaining === null && percent === null) {
    throw new Error("按给定字段名一个都没取到值，请检查字段名/JSON 路径");
  }
  return [{
    id: "custom",
    label: String(mapping.label || "自定义额度"),
    kind: (total !== null || used !== null) ? "quota" : "balance",
    used, total,
    remaining: remaining !== null ? remaining : (total !== null && used !== null ? Math.round((total - used) * 1e6) / 1e6 : null),
    unit: String(mapping.unit || ""),
    percent: pctOf(used, total, percent),
    resetAt: toEpochMs(resetRaw),
  }];
}

// ─── 配置归一化 ─────────────────────────────────────────────────────────────

export const UPSTREAM_QUOTA_DEFAULTS = {
  enabled: true,
  autoRefreshMinutes: 0,   // 0 = 只在打开面板/设置页时刷新
  cacheSeconds: 300,
  timeoutMs: 10000,
  alertPercent: 90,        // 剩余/已用比例达到该值就在面板上标红
};

export function normalizeUpstreamQuotaConfig(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = { ...UPSTREAM_QUOTA_DEFAULTS };
  out.enabled = r.enabled !== false;
  const int = (v, dflt, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : dflt;
  };
  out.autoRefreshMinutes = int(r.autoRefreshMinutes, 0, 0, 24 * 60);
  out.cacheSeconds = int(r.cacheSeconds, 300, 0, 24 * 3600);
  out.timeoutMs = int(r.timeoutMs, 10000, 1000, 60000);
  out.alertPercent = int(r.alertPercent, 90, 1, 100);
  out.providers = {};
  for (const def of ALL_PROVIDER_DEFS) {
    const p = (r.providers && r.providers[def.id]) || {};
    out.providers[def.id] = {
      // 默认开启 = 用现成 API Key 就能读到额度的官方接口；需要 Admin Key / OAuth token /
      // 手填 URL 的平台默认关闭（def.defaultEnabled === false），否则升级后面板立刻一片报错。
      enabled: p.enabled !== undefined ? p.enabled !== false : def.defaultEnabled !== false,
      keySource: ["auto", "profile", "inline"].includes(p.keySource) ? p.keySource : (def.credential === "none" ? "inline" : "auto"),
      apiKey: typeof p.apiKey === "string" ? p.apiKey : "",
      profileSuffix: typeof p.profileSuffix === "string" ? p.profileSuffix : "",
      memberKey: typeof p.memberKey === "string" ? p.memberKey : "",
      baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
      label: typeof p.label === "string" ? p.label : "",
      extra: (p.extra && typeof p.extra === "object") ? { ...p.extra } : {},
    };
  }
  return out;
}

// ─── 平台总表 ───────────────────────────────────────────────────────────────

const ALL_PROVIDER_DEFS = [...LOCAL_PROVIDER_DEFS, ...CLOUD_PROVIDER_DEFS];
const DEF_BY_ID = new Map(ALL_PROVIDER_DEFS.map((d) => [d.id, d]));

export function providerDef(id) {
  return DEF_BY_ID.get(id) || null;
}
export function allProviderDefs() {
  return ALL_PROVIDER_DEFS.slice();
}

// 分组展示顺序（面板/设置页都按这个顺序渲染）
export const GROUP_ORDER = ["套餐额度", "官方余额", "云平台账户", "自定义", "仅控制台"];
export function defsSorted() {
  return ALL_PROVIDER_DEFS.slice().sort((a, b) => {
    const ga = GROUP_ORDER.indexOf(a.group), gb = GROUP_ORDER.indexOf(b.group);
    const sa = ga < 0 ? 99 : ga, sb = gb < 0 ? 99 : gb;
    return sa - sb || 0;
  });
}

// ─── 服务（缓存 / 并发 / 快照） ──────────────────────────────────────────────

export function createUpstreamQuotaService(d) {
  const {
    getConfig, saveConfig, listProfiles, getUsers = () => ({}),
    fetchImpl = fetch, now = () => Date.now(), log = console,
    loadCache = null, saveCache = null,
  } = d;

  const cache = new Map();     // id -> { fetchedAt, result }
  const inflight = new Map();  // id -> Promise

  // 启动时回填上次快照（进程重启后面板不至于一片空白，也避免立刻打上游）。
  try {
    const persisted = loadCache && loadCache();
    if (persisted && typeof persisted === "object") {
      for (const [id, v] of Object.entries(persisted)) {
        if (v && typeof v === "object" && v.result) cache.set(id, { fetchedAt: Number(v.fetchedAt) || 0, result: v.result });
      }
    }
  } catch (e) {
    log.warn(`[UpstreamQuota] 读取缓存失败: ${e.message}`);
  }

  function cfg() {
    return normalizeUpstreamQuotaConfig(getConfig().upstreamQuota);
  }

  // 方案列表 + **各自的成员密钥表**。listProfiles() 给的是脱敏视图（没有 users），
  // 而按成员取 Key 正是这里要的东西，所以从 config.profiles 里把 users 合并回来。
  function profilesWithKeys() {
    const raw = (getConfig() || {}).profiles || {};
    return (listProfiles() || []).map((p) => ({
      ...p,
      upstream: p.upstream || (raw[p.name] && raw[p.name].upstream) || "",
      users: (raw[p.name] && raw[p.name].users) || {},
    }));
  }

  function persistCache() {
    if (!saveCache) return;
    try {
      const obj = {};
      for (const [id, v] of cache) obj[id] = { fetchedAt: v.fetchedAt, result: v.result };
      saveCache(obj);
    } catch (e) {
      log.warn(`[UpstreamQuota] 写入缓存失败: ${e.message}`);
    }
  }

  // 单个平台：凭据 → 请求 → 解析；任何异常都收敛成 { ok:false, error }。
  async function queryOne(def, c, { timeoutMs }) {
    const cred = { key: "", source: "", accessKeyId: "", accessKeySecret: "", extra: {} };
    const pc = c.providers[def.id] || {};
    if (def.credential === "apiKey") {
      // matchHosts 在**平台定义**上，不在用户配置里 —— 少了这一层，「自动」模式
      // 永远匹配不到方案主机名，表现成所有平台都报「没有找到可用的方案密钥」。
      const resolved = resolveApiKey({ ...pc, matchHosts: def.matchHosts || [] }, profilesWithKeys(), getUsers());
      if (resolved.error) return { ok: false, error: resolved.error, configured: false };
      cred.key = resolved.key;
      cred.source = resolved.source;
    } else if (def.credential === "accessKey") {
      let ak = String((pc.extra && pc.extra.accessKeyId) || "").trim();
      let sk = String((pc.extra && pc.extra.accessKeySecret) || "").trim();
      let extra = pc.extra || {};
      let source = "AccessKey";
      if (!ak || !sk) {
        // 同一个云账号下经常有好几个平台（阿里云的「账户余额」与「百炼 Token Plan」用的是同一组
        // AK/SK）。本平台没填就复用同厂商已填好的那一份，省得让用户把同一串密钥抄两遍。
        const vendor = String(def.id).split("-")[0];
        const extraOf = (d) => (c.providers[d.id] && c.providers[d.id].extra) || {};
        const filled = (d) => {
          const ex = extraOf(d);
          return !!String(ex.accessKeyId || "").trim() && !!String(ex.accessKeySecret || "").trim();
        };
        const others = ALL_PROVIDER_DEFS.filter((d) => d.credential === "accessKey" && d.id !== def.id);
        const donor = others.find((d) => d.id.split("-")[0] === vendor && filled(d)) || others.find(filled);
        if (donor) {
          const ex = extraOf(donor);
          ak = String(ex.accessKeyId || "").trim();
          sk = String(ex.accessKeySecret || "").trim();
          // 本平台自己填过的 extra 优先（例如 region、接入点）。
          extra = { ...ex, ...(pc.extra || {}) };
          source = `复用「${donor.name}」的 AccessKey`;
        }
      }
      if (!ak || !sk) return { ok: false, error: "未配置 AccessKey ID / Secret", configured: false };
      cred.accessKeyId = ak;
      cred.accessKeySecret = sk;
      cred.extra = extra;
      cred.source = source;
    }
    const startedAt = now();
    try {
      const res = await def.run({ cred, cfg: pc, timeoutMs, fetchImpl, now: now(), profiles: listProfiles() });
      const items = (res && res.items) || [];
      return {
        ok: true, configured: true, items, warnings: (res && res.warnings) || [], credSource: cred.source,
        latencyMs: now() - startedAt,
      };
    } catch (e) {
      return {
        ok: false,
        // 凭据是齐的，只是这次请求失败 —— 卡片要标成「查询失败」而不是「未配置」。
        configured: true,
        error: e && e.name === "AbortError" ? `请求超时（${timeoutMs}ms）` : (e && e.message) || String(e),
        credSource: cred.source, latencyMs: now() - startedAt,
      };
    }
  }

  async function refreshOne(def, c, { force }) {
    const ttl = c.cacheSeconds * 1000;
    const hit = cache.get(def.id);
    if (!force && hit && ttl > 0 && now() - hit.fetchedAt < ttl) {
      return { ...hit.result, fromCache: true };
    }
    if (inflight.has(def.id)) return inflight.get(def.id);
    const p = (async () => {
      const r = await queryOne(def, c, { timeoutMs: c.timeoutMs });
      const result = { ...r, fetchedAt: now() };
      if (r.ok) cache.set(def.id, { fetchedAt: result.fetchedAt, result });
      else if (hit) { // 失败不清空上一次的好数据：面板继续显示旧值并标注是旧的。
        // ok 必须显式翻成 false —— 否则卡片会顶着「正常」的绿标、下面却挂一条错误，
        // 管理员看到的第一眼是绿的（这里踩过：旧 result 的 ok:true 被 ...hit.result 带过来了）。
        return { ...hit.result, ok: false, fromCache: true, stale: true, error: r.error, fetchedAt: hit.fetchedAt };
      }
      return result;
    })().finally(() => inflight.delete(def.id));
    inflight.set(def.id, p);
    return p;
  }

  // 并发度限制：平台多起来后一口气打十几个上游容易被风控，也会拖慢首屏。
  async function mapLimit(list, limit, fn) {
    const out = new Array(list.length);
    let i = 0;
    const workers = new Array(Math.min(limit, list.length)).fill(0).map(async () => {
      while (true) {
        const idx = i++;
        if (idx >= list.length) return;
        out[idx] = await fn(list[idx], idx);
      }
    });
    await Promise.all(workers);
    return out;
  }

  async function snapshot({ force = false, ids = null } = {}) {
    const c = cfg();
    if (!c.enabled) return { enabled: false, generatedAt: now(), providers: [], summary: emptySummary() };
    const defs = defsSorted().filter((def) => (ids ? ids.includes(def.id) : true));
    const results = await mapLimit(defs, 4, async (def) => {
      const pc = c.providers[def.id] || {};
      if (pc.enabled === false) return { def, skipped: true };
      if (def.manualOnly) return { def, manualOnly: true };
      const r = await refreshOne(def, c, { force });
      return { def, ...r };
    });
    if (results.some((r) => r.def && !r.skipped && !r.manualOnly)) persistCache();

    const providers = results.map((r) => shapeProvider(r.def, c, r));
    return {
      enabled: true,
      generatedAt: now(),
      alertPercent: c.alertPercent,
      groups: GROUP_ORDER.filter((g) => providers.some((p) => p.group === g)),
      providers,
      summary: summarize(providers, c.alertPercent),
    };
  }

  function shapeProvider(def, c, r) {
    const pc = c.providers[def.id] || {};
    const items = (r.items || []).map((it) => ({ ...it }));
    const alerts = items.filter((it) => {
      const depleted = it.kind === "balance" ? (num(it.remaining) !== null && num(it.remaining) <= 0)
        : (num(it.percent) !== null && num(it.percent) >= c.alertPercent);
      return depleted;
    });
    return {
      id: def.id,
      name: def.name,
      group: def.group,
      credential: def.credential,
      manualOnly: !!def.manualOnly,
      experimental: !!def.experimental,
      enabled: pc.enabled !== false,
      // configured 是查询层显式给的判定（凭据齐不齐），不在展示层靠错误文案猜 ——
      // 之前用 /未配置/ 正则猜，把「自动模式找不到匹配的方案密钥」误判成已配置，
      // 卡片于是显示成「查询失败」而不是「未配置 + 怎么配」。
      configured: r.configured !== undefined ? !!r.configured : !!r.ok,
      keySource: pc.keySource,
      credLabel: r.credSource || (def.credential === "accessKey" ? "AccessKey" : ""),
      ok: !!r.ok,
      skipped: !!r.skipped,
      items,
      error: r.error || "",
      warnings: r.warnings || [],
      stale: !!r.stale,
      fromCache: !!r.fromCache,
      fetchedAt: r.fetchedAt || 0,
      latencyMs: r.latencyMs || 0,
      alert: alerts.length > 0,
      consoleUrl: def.consoleUrl || "",
      docsUrl: def.docsUrl || "",
      note: def.note || "",
      fields: def.fields || [],
      extraFields: def.extraFields || [],
    };
  }

  function summarize(providers, alertPercent) {
    const active = providers.filter((p) => !p.manualOnly);
    return {
      total: providers.length,
      configured: active.filter((p) => p.configured).length,
      ok: active.filter((p) => p.ok).length,
      failed: active.filter((p) => !p.ok && p.configured).length,
      alerts: active.filter((p) => p.alert).length,
      unconfigured: active.filter((p) => !p.configured).length,
      alertPercent,
    };
  }
  function emptySummary() {
    return { total: 0, configured: 0, ok: 0, failed: 0, alerts: 0, unconfigured: 0, alertPercent: 0 };
  }

  // 单个平台详情（设置页展开时用，可强制刷新）
  async function providerSnapshot(id, { force = true } = {}) {
    const def = providerDef(id);
    if (!def) throw new Error(`未知平台: ${id}`);
    const c = cfg();
    if (def.manualOnly) {
      return shapeProvider(def, c, { manualOnly: true });
    }
    const r = await refreshOne(def, c, { force });
    return shapeProvider(def, c, r);
  }

  // 保存：整体替换（归一化后写回 config.upstreamQuota），并清掉被改动平台的缓存。
  function save(raw) {
    const next = normalizeUpstreamQuotaConfig(raw);
    const prev = normalizeUpstreamQuotaConfig(getConfig().upstreamQuota);
    for (const [id, p] of Object.entries(next.providers)) {
      const before = prev.providers[id];
      if (JSON.stringify(before) !== JSON.stringify(p)) cache.delete(id);
    }
    const cfgObj = getConfig();
    // 保留未识别的历史字段（前向兼容：别的版本写入的未知键不因本页保存而丢失）
    const merged = { ...(cfgObj.upstreamQuota || {}), ...next };
    cfgObj.upstreamQuota = merged;
    if (saveConfig) saveConfig(cfgObj);
    return next;
  }

  // 自动刷新：由 server 每分钟 tick 一次，到点才真正发请求。
  let lastAutoAt = 0;
  async function tick() {
    const c = cfg();
    if (!c.enabled || !c.autoRefreshMinutes) return null;
    const interval = c.autoRefreshMinutes * 60e3;
    if (now() - lastAutoAt < interval) return null;
    lastAutoAt = now();
    try {
      return await snapshot({ force: true });
    } catch (e) {
      log.warn(`[UpstreamQuota] 自动刷新失败: ${e.message}`);
      return null;
    }
  }

  function clearCache(id = null) {
    if (id) cache.delete(id);
    else cache.clear();
    persistCache();
  }

  // 设置页要用「平台目录」（名称 / 分组 / 输入框 / 说明），与平台是否配置无关；
  // 只给元数据 + 归一化后的配置 —— 凭据字段照旧明文交给设置页（该页本身有后台密码门，
  // 与 SMTP 密码 / webhook 密钥同一套逻辑，管理员要能核对粘贴进去的值）。
  function catalog() {
    return defsSorted().map((def) => ({
      id: def.id, name: def.name, group: def.group, credential: def.credential,
      manualOnly: !!def.manualOnly, experimental: !!def.experimental,
      matchHosts: def.matchHosts || [], fields: def.fields || [], extraFields: def.extraFields || [],
      consoleUrl: def.consoleUrl || "", docsUrl: def.docsUrl || "", note: def.note || "",
    }));
  }

  return { cfg, catalog, snapshot, providerSnapshot, save, tick, clearCache, defs: allProviderDefs };
}
