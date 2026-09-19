// lib/compact-bridge.mjs —— Codex remote compact(上下文压缩)的网关侧双向翻译。
//
// 为什么需要这一层:codex 客户端的 remote compaction v2 要求响应里**恰好一个**
// output item 是 `type:"compaction"`(serde 见 codex-rs/protocol/src/models.rs,
// 字段 encrypted_content 必填、是不透明载荷)。OpenAI 官方后端会返回它,第三方
// Responses 兼容端点(火山/GLM/DeepSeek)不实现这个私有条目,只回普通 message
// —— 客户端随即报 "remote compaction v2 expected exactly one compaction output
// item, got 0 from 1 output items" 并中止压缩。官方后端自己也有同类报告
// (openai/codex#42393)。网关是透明转发,修法只能是双向翻译:
//
//   响应侧:压缩请求的响应里,把第一个带文本的 item 合成成 compaction 条目,
//           摘要正文放进 encrypted_content(我方自编码,见 encodeSummary)
//   请求侧:客户端把 compaction 条目存进历史、后续轮次原样回放(input 里的
//           compaction item),上游不认识它 —— 翻译回 message,摘要原文取出
//
// 触发标志来自客户端快照(官方测试快照 15:compaction_trigger):压缩请求 =
// 完整历史 + 末尾一个 {"type":"compaction_trigger"} 输入项。

const SUMMARY_PREFIX = "ccteam1:";   // 我方载荷前缀;解不出前缀的一律视为外部(真 OpenAI)载荷
const REPLAY_HEADER = "此前对话已压缩为以下摘要：\n";
const FOREIGN_PLACEHOLDER = "(更早的对话上下文已被压缩,内容不可用)";

// 压缩请求的识别标志:input 数组里出现 compaction_trigger 输入项。
// 只在 responses 协议上调用(由调用方保证)。
export function isCompactionRequest(body) {
  const input = body?.input;
  if (!Array.isArray(input)) return false;
  return input.some((it) => it && typeof it === "object" && it.type === "compaction_trigger");
}

export function encodeSummary(text) {
  return SUMMARY_PREFIX + Buffer.from(String(text ?? ""), "utf8").toString("base64");
}

// 解不出(非我方前缀 / base64 坏了)→ null,调用方按外部载荷处理
export function decodeSummary(encrypted) {
  const s = String(encrypted ?? "");
  if (!s.startsWith(SUMMARY_PREFIX)) return null;
  try {
    return Buffer.from(s.slice(SUMMARY_PREFIX.length), "base64").toString("utf8");
  } catch {
    return null;
  }
}

const COMPACTION_TYPES = new Set(["compaction", "compaction_summary"]);

// 从 item 里抽文本:message.item 的 content[] 可能是 string 或 [{type:"output_text"|"input_text"|"text",text}]
function itemText(item) {
  const content = item?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (typeof c === "string" ? c : (c && typeof c.text === "string" ? c.text : "")))
    .join("");
}

// 请求侧:把回放历史里的 compaction 条目翻译成上游能读的 message。
// 返回是否发生了改写(调用方据此决定要不要重新序列化请求体)。
export function translateCompactionInputItems(body) {
  const input = body?.input;
  if (!Array.isArray(input)) return false;
  let changed = false;
  for (let i = 0; i < input.length; i++) {
    const it = input[i];
    if (!it || typeof it !== "object" || !COMPACTION_TYPES.has(it.type)) continue;
    const summary = decodeSummary(it.encrypted_content);
    const text = summary != null ? REPLAY_HEADER + summary : FOREIGN_PLACEHOLDER;
    input[i] = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    };
    changed = true;
  }
  return changed;
}

// 响应侧:把一个非 compaction 的 item 合成成客户端要求的 compaction 条目。
// id 用确定性哈希(同一摘要 → 同一 id,重放幂等);encrypted_content 是摘要全文。
export function synthesizeCompactionItem(item, seq = 0) {
  const text = itemText(item);
  const id = "cmp_" + require$hash(text + "|" + seq);
  return { type: "compaction", id, encrypted_content: encodeSummary(text) };
}

// 简易稳定哈希(32 位 FNV-1a 十六进制):只为生成可复现的 item id,不作安全用途
function require$hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// 响应事件的转换。state = { count, item },由调用方为每个压缩请求新建一次。
//   · 上游已返回真 compaction 条目 → 原样透传(客户端只认恰好一个)
//   · 第一个带文本、且非 compaction 的 item(message/agent_message 等)→ 合成替换,
//     合成结果缓存进 state.item:done 事件与 completed.response.output[] 两处必须是
//     **同一个条目**(同 id / 同载荷),否则客户端按 id 对不上
//   · 其余事件(created / delta 等)原样
// 返回转换后的对象(可能是新对象;不改写入参)。
export function transformCompactSseEvent(json, state) {
  if (!json || typeof json !== "object") return json;

  // output_item.done 事件:item 在这里,客户端也是数这里的
  if (json.type === "response.output_item.done" && json.item && typeof json.item === "object") {
    const item = json.item;
    if (COMPACTION_TYPES.has(item.type)) {
      state.count += 1;
      state.upstreamCompaction = true;   // 上游自带真条目:此后绝不能再合成第二个
      return json;
    }
    if (!state.item && !state.upstreamCompaction && itemText(item).trim()) {
      state.item = synthesizeCompactionItem(item, 0);
      state.count += 1;
      return { ...json, item: state.item };
    }
    return json;
  }

  // response.completed 事件:response.output[] 里必须是同一条目,保持一致
  if (json.type === "response.completed" && json.response && Array.isArray(json.response.output)) {
    const out = json.response.output;
    if (out.some((it) => it && COMPACTION_TYPES.has(it.type))) {
      // 上游自带真 compaction(且没被我们替换过)→ 原样
      state.count = Math.max(state.count, 1);
      state.upstreamCompaction = true;
      return json;
    }
    if (state.upstreamCompaction) return json;   // 流里已有上游真条目,不再动 output
    // done 事件已合成过 → 用缓存的那条替换 output 里对应的原始 item;
    // done 事件缺失时(有上游只发 completed)在此处补合成
    const idx = out.findIndex((it) => it && typeof it === "object" && itemText(it).trim());
    if (idx < 0) return json;
    if (!state.item) { state.item = synthesizeCompactionItem(out[idx], 0); state.count += 1; }
    const next = out.slice();
    next[idx] = state.item;
    return { ...json, response: { ...json.response, output: next } };
  }

  return json;
}
