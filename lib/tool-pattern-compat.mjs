// lib/tool-pattern-compat.mjs —— 工具 pattern 兼容: 上游(智谱 GLM 报 1210、DeepSeek 报
// "is not a regex")无法编译工具 input_schema 里的某些 pattern 时, 按模式决定是否在
// 转发前剔除这些 pattern; 真实请求被上游以 pattern 拒绝时即时启用剔除并透明重发同一
// 请求; 定时探针复考上游(并回放真实流量携带过的 pattern), 上游支持后自动恢复完整定义。
// 从 server.mjs 抽出(零缩进逐字搬移)。依赖经 createToolPatternCompat 工厂注入:
// config/runtimes 为稳定绑定按值捕获(探针在触发时才遍历 runtimes), 取真实密钥与协议
// 归一化由 server 侧按值传入; http/https 为 node 内置, 模块内直接 import。

import http from "node:http";
import https from "node:https";

export function createToolPatternCompat(d) {
  const { config, runtimes, normalizeProfileProtocol, getRealKeyFromProfile } = d;

// Zhipu GLM's tool-schema validator rejects requests whose tool `pattern`
// fields use regex it cannot compile, with error 1210 "API 调用参数有误" for
// the WHOLE request. Empirically (2026-09) the toxic constructs are Unicode
// property classes (`\p{Cc}`…) — lookarounds compile fine there, but RE2-based
// validators reject those, so both classes are stripped conservatively.
// Claude Code ≥2.1.266 ships an "Artifact" tool whose schema carries such
// patterns, so every interactive request would fail against such upstreams.
// Patterns are optional validation hints; a background probe re-enables
// pass-through once the upstream learns to accept them.
const UNSUPPORTED_PATTERN_RE = /\\[pP]\{|\(\?[=!]/;   // \p{ \P{ (?= (?! (?<= (?<!

// Recursively drop `pattern` fields using constructs the upstream can't
// compile. Returns count removed.
function stripUnsupportedPatternsNode(node) {
  let removed = 0;
  if (Array.isArray(node)) {
    for (const item of node) removed += stripUnsupportedPatternsNode(item);
  } else if (node && typeof node === "object") {
    if (typeof node.pattern === "string" && UNSUPPORTED_PATTERN_RE.test(node.pattern)) {
      delete node.pattern;
      removed++;
    }
    for (const key of Object.keys(node)) {
      if (key !== "pattern") removed += stripUnsupportedPatternsNode(node[key]);
    }
  }
  return removed;
}

// Rewrite a parsed request body in place, stripping lookaround patterns from
// every tool schema (Anthropic `input_schema` and OpenAI `parameters` shapes).
// Returns the number of patterns removed (0 → nothing worth re-serializing).
function stripUnsupportedToolPatterns(parsed) {
  if (!Array.isArray(parsed?.tools)) return 0;
  let removed = 0;
  for (const tool of parsed.tools) {
    if (!tool || typeof tool !== "object") continue;
    const schema = tool.input_schema ?? tool.parameters;
    if (schema && typeof schema === "object") removed += stripUnsupportedPatternsNode(schema);
  }
  return removed;
}

// How upstreams word a tool-schema `pattern` rejection. Zhipu GLM answers error
// code 1210 ("API 调用参数有误") for the whole request; DeepSeek/OpenAI-style
// validators say the value "is not a \"regex\"" / "Invalid schema for function".
const TOOL_PATTERN_REJECTION_RE = /1210|is not a .{0,16}regex|invalid schema for function/i;

function isToolPatternRejection(statusCode, text) {
  return statusCode === 400 && TOOL_PATTERN_REJECTION_RE.test(text || "");
}

// Visit every `pattern` string in a schema tree.
function eachPatternNode(node, fn) {
  if (Array.isArray(node)) {
    for (const item of node) eachPatternNode(item, fn);
    return;
  }
  if (!node || typeof node !== "object") return;
  if (typeof node.pattern === "string") fn(node.pattern);
  for (const key of Object.keys(node)) {
    if (key !== "pattern") eachPatternNode(node[key], fn);
  }
}

// The `pattern` strings a request's tool schemas carry (Anthropic `input_schema`
// and OpenAI `parameters` shapes).
function collectToolPatterns(parsed) {
  const patterns = [];
  if (!Array.isArray(parsed?.tools)) return patterns;
  for (const tool of parsed.tools) {
    if (!tool || typeof tool !== "object") continue;
    eachPatternNode(tool.input_schema ?? tool.parameters, (p) => patterns.push(p));
  }
  return patterns;
}

const TOOL_PATTERN_SAMPLE_MAX = 5;

// Remember the real patterns live traffic carries so the probe can ask the
// upstream about *evidence* instead of one hard-coded guess — a construct our
// own UNSUPPORTED_PATTERN_RE does not recognise is exactly what a fixed probe
// cannot anticipate. Only strippable patterns are worth remembering (stripping
// is the only remedy we have), and only the first few, so the probe payload
// stays small.
function rememberToolPatterns(runtime, parsed) {
  const samples = runtime.toolPatternSamples;
  if (!samples || samples.size >= TOOL_PATTERN_SAMPLE_MAX) return;
  for (const p of collectToolPatterns(parsed)) {
    if (samples.size >= TOOL_PATTERN_SAMPLE_MAX) break;
    if (UNSUPPORTED_PATTERN_RE.test(p)) samples.add(p);
  }
}

// Live self-heal: a 400 that names a tool-schema regex problem while the probe
// currently believes this upstream accepts patterns means the probe was wrong
// (it cannot foresee every construct real traffic carries). Rather than hand
// that 400 to the user, turn stripping on and resend the SAME request with the
// patterns removed. Returns the replacement body, or null when no heal applies.
function tryToolPatternSelfHeal(body, reqHeaders, statusCode, text, runtime) {
  if (!runtime || runtime.toolPatternsActive) return null;
  if (runtime.toolPatternCompat !== "auto") return null;   // explicit modes are the user's call
  if (!isToolPatternRejection(statusCode, text)) return null;
  let parsed;
  try { parsed = JSON.parse(body.toString()); } catch { return null; }
  rememberToolPatterns(runtime, parsed);
  const removed = stripUnsupportedToolPatterns(parsed);
  if (removed === 0) return null;   // nothing we could have stripped — not our failure
  const next = Buffer.from(JSON.stringify(parsed));
  reqHeaders["content-length"] = next.length;
  runtime.toolPatternsActive = true;
  console.log(`[工具兼容] 方案「${runtime.profileName}」: 上游以 pattern 拒绝真实请求(状态 ${statusCode})，已即时启用剔除并重发同一请求，剔除 ${removed} 处`);
  return next;
}

function normalizeToolPatternCompat(v) {
  return v === "always" || v === "off" ? v : "auto";
}

// Initial stripping decision for a profile: "always"/"off" follow the config
// verbatim; "auto" (default) strips only for third-party Anthropic-compatible
// upstreams — Anthropic's own API compiles lookarounds fine — and the probe
// below refines that over time.
function computeToolPatternsActive(profile, upstreamUrl) {
  const mode = normalizeToolPatternCompat(profile.toolPatternCompat);
  if (mode === "always") return true;
  if (mode === "off") return false;
  if (normalizeProfileProtocol(profile.protocol) !== "anthropic") return false;
  const host = upstreamUrl.hostname;
  return !(host === "api.anthropic.com" || host.endsWith(".anthropic.com"));
}

const TOOL_PATTERN_PROBE_DELAY_MS = Math.max(0, Number(process.env.TOOL_PATTERN_PROBE_DELAY_MS) || 30000);
// Floored at 1s so an explicit override is honoured (tests observe the
// learn-then-replay cycle at that cadence) while a typo still cannot make a
// profile hammer its upstream once per request.
const TOOL_PATTERN_PROBE_INTERVAL_MS = Math.max(1000, Number(process.env.TOOL_PATTERN_PROBE_INTERVAL_MS) || 6 * 3600 * 1000);

// Ask the upstream whether it accepts the patterns. The built-in `path` pattern
// is byte-identical to the harshest pattern real traffic carries (Claude Code's
// Artifact title regex): it covers the `\p{…}` classes Zhipu rejects with 1210 AND
// the in-class escapes (`"` `\\` `.` `/` `[` `]`) that DeepSeek-style validators
// reject as "is not a \"regex\"". The `sample*` properties replay patterns this
// profile's live traffic actually carried, so an upstream that accepts the guess
// but rejects a real pattern is still reported as rejecting.
function toolPatternProbeBody(model, samples = []) {
  // The built-in pattern stands in for the harshest construct real traffic carries.
  const builtin = "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\"\\\\./[\\]]{1,200}$";
  const properties = { path: { type: "string", pattern: builtin } };
  const extra = [...(samples || [])].filter((pat) => pat && pat !== builtin).slice(0, TOOL_PATTERN_SAMPLE_MAX);
  extra.forEach((pat, i) => { properties["sample" + i] = { type: "string", pattern: pat }; });
  return {
    model, max_tokens: 64, stream: false,
    messages: [{ role: "user", content: "ping" }],
    tools: [{
      name: "gateway_compat_probe",
      description: "Gateway reachability probe; never meaningful to call.",
      input_schema: { type: "object", properties, required: [] },
    }],
  };
}

function probeToolPatternSupport(rt) {
  return new Promise((resolve) => {
    const realKey = getRealKeyFromProfile(config.profiles[rt.profileName] || {});
    const model = (rt.allowedModels && rt.allowedModels[0]) || Object.values(rt.modelAliases || {})[0];
    if (!realKey || !model) { resolve(null); return; }
    const body = Buffer.from(JSON.stringify(toolPatternProbeBody(model, [...(rt.toolPatternSamples || [])])));
    const transport = rt.upstreamUrl.protocol === "https:" ? https : http;
    const req = transport.request({
      hostname: rt.upstreamUrl.hostname,
      port: rt.upstreamUrl.port || (rt.upstreamUrl.protocol === "https:" ? 443 : 80),
      path: rt.upstreamUrl.pathname.replace(/\/$/, "") + "/v1/messages",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": body.length,
        authorization: `Bearer ${realKey}`,
        "x-api-key": realKey,
        "anthropic-version": "2023-06-01",
      },
      agent: rt.agent,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode === 200) resolve(true);
        else if (isToolPatternRejection(res.statusCode, text)) resolve(false);
        else resolve(null);
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error("probe timeout")));
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function runToolPatternProbe(rt) {
  if (rt.protocol !== "anthropic" || rt.toolPatternCompat !== "auto") return;
  const supported = await probeToolPatternSupport(rt);
  if (supported === null) return;
  if (supported && rt.toolPatternsActive) {
    rt.toolPatternsActive = false;
    console.log(`[工具兼容] 方案「${rt.profileName}」: 探测到上游已支持这些 pattern 特性，恢复完整工具定义`);
  } else if (!supported && !rt.toolPatternsActive) {
    rt.toolPatternsActive = true;
    console.log(`[工具兼容] 方案「${rt.profileName}」: 探测到上游拒绝此类 pattern(1210)，重新启用剔除`);
  } else {
    console.log(`[工具兼容] 方案「${rt.profileName}」: 探测完成，上游${supported ? "已支持" : "仍不支持此类 pattern"}，剔除保持${rt.toolPatternsActive ? "开启" : "关闭"}`);
  }
}

function scheduleToolPatternProbes() {
  const first = setTimeout(() => { for (const rt of Object.values(runtimes)) runToolPatternProbe(rt); }, TOOL_PATTERN_PROBE_DELAY_MS);
  const timer = setInterval(() => { for (const rt of Object.values(runtimes)) runToolPatternProbe(rt); }, TOOL_PATTERN_PROBE_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
}

  return {
    normalizeToolPatternCompat,
    computeToolPatternsActive,
    stripUnsupportedToolPatterns,
    rememberToolPatterns,
    tryToolPatternSelfHeal,
    scheduleToolPatternProbes,
  };
}
