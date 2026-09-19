// lib/empty-input-compat.mjs —— 空 input 的 Responses 上游兼容。
//
// 症状:Codex 走 DeepSeek 的 Responses 端点报
//   {"error":{"message":"Input items array must not be empty",...}}
//
// 三方责任:
//   · DeepSeek 的 Responses 端点无状态(previous_response_id/store 都不支持且静默忽略),
//     并**严格拒绝空 input 数组**;GLM/火山容忍,所以只有 DS 报错
//   · Codex 开场会先发一帧 input:[] 的 warmup 预热请求(对 OpenAI 有状态后端是合法用法)
//   · 网关此前零干预 → 该 400 原样透传给用户
//
// 修法(与 tool-pattern / thinking 两条自愈同型):被上游实际拒绝过一次后注入占位
// input 重发,并把「该上游要求非空 input」记成 runtime 上的 sticky 标志 —— 此后同类
// 请求直接带占位,不再吃一次 400 往返。
//
// ⚠️ 返回值必须是 Buffer(调用方按 byteLength 设 Content-Length):返回字符串会把
// 中文体算成字符数,上游一直等剩余字节 → 重发在途超时(thinking-passback 踩过同款坑)。

const EMPTY_INPUT_RE = /input items array must not be empty|empty input messages/i;

// 占位体:warmup 的输出客户端不看,内容只为满足上游的非空校验;照常记入用量与请求日志。
const PLACEHOLDER = [{ type: "message", role: "user", content: [{ type: "input_text", text: "(空请求占位)" }] }];

// input 是**空数组**才算(缺省/非数组不动:那多半是别的形态的问题,瞎补会把错误掩盖成怪响应)
function isEmptyInputArray(parsed) {
  return !!parsed && typeof parsed === "object" && Array.isArray(parsed.input) && parsed.input.length === 0;
}

export function isEmptyInputRejection(statusCode, errText) {
  return statusCode === 400 && EMPTY_INPUT_RE.test(String(errText || ""));
}

// 对已解析的请求体对象注入占位(就地改动),返回是否改过 —— 主动注入路径用这个,
// 与其它请求体改写合并成一次序列化。
export function injectEmptyInputPlaceholder(parsed) {
  if (!isEmptyInputArray(parsed)) return false;
  parsed.input = PLACEHOLDER.map((it) => JSON.parse(JSON.stringify(it)));   // 深拷贝:每请求独立对象
  return true;
}

// body: Buffer|字符串。空 input → 注入占位并返回新 Buffer;无需改则 null。
export function applyEmptyInputCompat(body) {
  let parsed;
  try { parsed = JSON.parse(body.toString()); } catch { return null; }
  if (!injectEmptyInputPlaceholder(parsed)) return null;
  return Buffer.from(JSON.stringify(parsed));
}

// 400 自愈入口:命中「空 input 被拒」→ 注入占位 + 置 sticky 标志。
// runtime 缺省时不置标志(仍可单次修复),便于纯函数测试。
export function tryEmptyInputSelfHeal(body, statusCode, errText, runtime) {
  if (!isEmptyInputRejection(statusCode, errText)) return null;
  const healed = applyEmptyInputCompat(body);
  if (!healed) return null;
  if (runtime) runtime.requiresInputItems = true;   // sticky:照 toolPatternsActive 的先例,配置重载即清零重学
  console.log(`[自愈] 上游拒绝空 input,注入占位后重试${runtime ? ` profile=${runtime.suffix}` : ""}`);
  return healed;
}
