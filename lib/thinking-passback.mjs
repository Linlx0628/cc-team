// lib/thinking-passback.mjs —— 上游 400「thinking 必须回传」的自愈修复。
//
// 症状:Claude Code 报 `API Error: 400 The content[].thinking in the thinking mode
// must be passed back to the API.` 后直接停下。第三方 Anthropic 兼容端点(GLM/
// DeepSeek 等)在 thinking 模式下要求:assistant 的工具调用轮必须把上一轮的
// thinking 块原样回传,缺了就整单拒绝。
//
// 触发源两类(社区已归因):
//   ① Claude Code 2.1.152+ 的回归跨轮丢 thinking 块(anthropics/claude-code#62963)
//   ② 会话中途换厂商 —— 本网关的 failover / 分时段组切换会自动造成(A 厂商签名
//      的 thinking 块发给 B 厂商,B 不认识)
//
// 修法:把请求顶层的 thinking 字段去掉(禁用该次请求的 thinking 模式,「必须回传」
// 的前提随之消失),同时清掉历史里的 thinking 块保持自洽,然后由调用方重发一次。
// 这与社区「modelParams 里 thinking:false 即不再报错」的结论同源;模型侧的实际
// 推理不受影响,只是这一轮不再要求回传 thinking 块。
//
// 与 tool-pattern-compat 的自愈同型:只在确凿命中该 400 文案时触发,重发一次为止
// (由调用方的重试上限保证,不在本模块内做状态)。

const PASSBACK_RE = /content\[\]\.thinking|thinking.{0,40}passed back|thinking mode must/i;

// body: 原始请求体(Buffer 或字符串);statusCode/errText: 上游响应。
// 命中并成功改写 → 返回新的 **Buffer**(与 tryToolPatternSelfHeal 同型:调用方按
// byteLength 设 Content-Length,返回字符串会把中文体算成字符数而挂死上游);否则 null。
export function tryThinkingPassbackSelfHeal(body, statusCode, errText) {
  if (statusCode !== 400) return null;
  if (!PASSBACK_RE.test(String(errText || ""))) return null;

  let parsed;
  try { parsed = JSON.parse(body.toString()); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  // 没有 thinking 字段、历史里也没有 thinking 块:不是我们能修的形态,别瞎改
  const hasTopLevel = "thinking" in parsed;
  const strippedBlocks = stripThinkingBlocks(parsed);
  if (!hasTopLevel && !strippedBlocks) return null;

  if (hasTopLevel) delete parsed.thinking;
  return Buffer.from(JSON.stringify(parsed));
}

// 移除 messages[].content[] 里的 thinking 块(disable 后它们只会让上游困惑)。
// 返回是否真的移除了东西。content 为字符串或非数组时不动。
function stripThinkingBlocks(parsed) {
  const messages = Array.isArray(parsed.messages) ? parsed.messages : null;
  if (!messages) return false;
  let changed = false;
  for (const m of messages) {
    if (!m || typeof m !== "object" || !Array.isArray(m.content)) continue;
    const kept = m.content.filter((blk) => blk && typeof blk === "object" && blk.type !== "thinking");
    if (kept.length !== m.content.length) {
      m.content = kept;
      changed = true;
    }
  }
  return changed;
}
