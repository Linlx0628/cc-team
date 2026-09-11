// lib/vision-bridge.mjs —— 图片识别桥接: 别名不支持视觉时, 先用方案指定的辅助模型把
// 图片转成文字描述, 再把请求里的图片块换成描述交给原模型(Claude Code/ZCode/Codex 端
// 贴图即可用)。转述按 sha256(图片) 持久化到 SQLite(跨重启复用), 每次客户端请求共享
// 一份识别预算, 辅助模型连续失败进冷却, 本轮新图失败则整体 400 并给出可操作原因。
// 从 server.mjs 抽出(零缩进逐字搬移)。依赖经 createVisionBridge 工厂注入:
// config/取真实密钥/发送上游 为稳定绑定按值捕获, stmts 在函数内实时读取。

import crypto from "node:crypto";
import { isClientAbortError, throwIfClientAborted } from "./proxy-helpers.mjs";

export function createVisionBridge(d) {
  const { config, getRealKeyFromProfile, sendUpstream, stmts } = d;

// 目标别名不支持视觉时，先用方案指定的辅助模型把图片转成文字描述，再替换
// 请求里的图片块交给原模型——Claude Code/ZCode/Codex 端贴图即可用。
// 转述按 helperModel:sha256(b64) 持久化到 SQLite：重放协议每轮重发全部历史
// 图片，缓存跨重启存活才不会在网关重启后批量重转或撞上限。
const IMAGE_BRIDGE_CACHE_MAX_ROWS = 5000;
const IMAGE_BRIDGE_MAX_IMAGES = 8;
const IMAGE_BRIDGE_MAX_B64 = 12 * 1024 * 1024;
// Helper calls run before the first byte reaches the client, so their total cost
// IS the client's wait. Serial calls at a 60s timeout each used to reach ~90s and
// the client hung up mid-bridge; these three numbers bound it instead.
const IMAGE_BRIDGE_CONCURRENCY = 4;            // parallel helper calls
const IMAGE_BRIDGE_CALL_TIMEOUT_MS = 25000;    // per-image helper timeout
const IMAGE_BRIDGE_TOTAL_BUDGET_MS = 35000;    // whole-request budget, shared across failover candidates
const IMAGE_BRIDGE_MIN_CALL_MS = 8000;         // never start a call the budget would clip
const IMAGE_BRIDGE_DESC_MAX_CHARS = 1000;      // a transcription is replayed every turn, forever
// A helper that is genuinely broken should cost one second, not a full budget on
// every turn: park it after a few consecutive failures.
const IMAGE_BRIDGE_HELPER_FAIL_LIMIT = 3;
const IMAGE_BRIDGE_HELPER_COOLDOWN_MS = 30000;
const bridgeHelperHealth = new Map();          // "host|model" -> { fails, until }
const bridgeThinkingUnsupported = new Set();   // upstreams that reject the `thinking` field

// Rendered into the settings page: the cache is keyed by image and shared by all
// profiles, so the count is global.
function ibCacheRows() {
  let n = 0;
  try { n = stmts.bridgeCacheCount.get().n; } catch {}
  return `已缓存 ${n} 张图片转述（全局共享，清空后这些图下一轮会重新识别）`;
}

function bridgeCacheGet(hash) {
  try {
    const row = stmts.bridgeCacheGet.get(hash);
    if (!row) return null;
    // Pruning keeps the newest IMAGE_BRIDGE_CACHE_MAX_ROWS by ts, so ts has to track
    // USE and not just insertion: otherwise a long conversation's images get evicted
    // while they are still replayed every turn, flip back to placeholders, and take
    // the upstream's prompt cache with them. Hour granularity keeps writes cheap.
    if (Date.now() - row.ts > 3600_000) {
      try { stmts.bridgeCacheTouch.run(Date.now(), hash); } catch {}
    }
    return row.text;
  } catch { return null; }
}
// A transcription replaces its image for good: it is cached and replayed on every
// later turn, so its length is a permanent per-turn tax. A chatty helper writing
// 2000 chars about each of 27 screenshots would quietly add tens of thousands of
// tokens to every single request, which is why this is capped rather than trusted.
function clampDescription(text) {
  const s = String(text || "").trim();
  if (s.length <= IMAGE_BRIDGE_DESC_MAX_CHARS) return s;
  const cut = s.slice(0, IMAGE_BRIDGE_DESC_MAX_CHARS);
  let stop = -1;
  for (const mark of ["。", "；", "\n", ". "]) stop = Math.max(stop, cut.lastIndexOf(mark));
  const body = stop > IMAGE_BRIDGE_DESC_MAX_CHARS * 0.6 ? cut.slice(0, stop + 1) : cut;
  return body + "…（描述过长，已截断）";
}

function bridgeCacheSet(hash, text) {
  try {
    stmts.bridgeCacheSet.run(hash, text, Date.now());
    if (stmts.bridgeCacheCount.get().n > IMAGE_BRIDGE_CACHE_MAX_ROWS) {
      stmts.bridgeCachePrune.run(IMAGE_BRIDGE_CACHE_MAX_ROWS);
    }
  } catch (err) { console.warn("[图片桥接] 缓存写入失败:", err.message); }
}

// Replay protocols resend the whole conversation every turn, so "new" has to be
// decided structurally: the trailing run of client-authored items is this turn,
// everything before it is history that was already transcribed (or already
// degraded) in an earlier turn.
function responsesFreshStart(items) {
  let i = items.length - 1;
  while (i >= 0) {
    const it = items[i];
    if (!it || typeof it !== "object") break;
    const isUserMsg = it.type === "message" && it.role === "user";
    const isToolOut = typeof it.type === "string" && it.type.endsWith("_call_output");
    if (!isUserMsg && !isToolOut) break;
    i--;
  }
  return i + 1;
}

function anthropicFreshStart(msgs) {
  let i = msgs.length - 1;
  while (i >= 0 && msgs[i] && msgs[i].role === "user") i--;
  return i + 1;
}

// A user message names its text parts `input_text`; some servers use `output_text`
// inside a tool result. Mirror whatever the sibling parts already use so the
// rewritten block stays valid for that container.
function responsesTextType(arr, field) {
  if (field === "content") return "input_text";
  const sibling = arr.find(b => b && typeof b.type === "string" && b.type.endsWith("_text"));
  return sibling ? sibling.type : "input_text";
}

// Extract data:URL images from a parsed Responses request body (input items).
// Returns markers { i, j, field, textType, b64, fresh, tooLarge } into
// parsed.input[i][field][j].
function extractImagesFromResponsesBody(parsed) {
  const images = [];
  const items = Array.isArray(parsed?.input) ? parsed.input : [];
  const freshStart = responsesFreshStart(items);
  const scan = (arr, i, field) => {
    for (let j = 0; j < arr.length; j++) {
      const block = arr[j];
      if (!block || block.type !== "input_image") continue;
      const raw = String(block.image_url || "");
      const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(raw);
      if (!m) continue;
      const b64 = m[1].replace(/\s+/g, "");
      if (!b64) continue;
      // Oversized images are collected too, just flagged: skipping them left a raw
      // image block in a request bound for a blind model — a guaranteed 400.
      images.push({ i, j, field, textType: responsesTextType(arr, field), b64,
        fresh: i >= freshStart, tooLarge: b64.length > IMAGE_BRIDGE_MAX_B64 });
    }
  };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      if (Array.isArray(item.content)) scan(item.content, i, "content");
      continue;
    }
    // Tool results can carry screenshots as well, in the array form of `output` on a
    // *_call_output item. Left unextracted, that raw image block would travel to a
    // model with no vision and take the whole request down with it.
    if (typeof item.type === "string" && item.type.endsWith("_call_output") && Array.isArray(item.output)) {
      scan(item.output, i, "output");
    }
  }
  return images;
}

// Extract base64 image blocks from a parsed Anthropic Messages body. Image
// blocks live in message content arrays — including nested inside tool_result
// content (Claude Code puts screenshots there). Returns reference-based
// markers { arr, idx, b64, mediaType, fresh, tooLarge } for in-place replacement.
function extractImageBlocksAnthropic(parsed) {
  const images = [];
  const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const freshStart = anthropicFreshStart(msgs);
  for (let mi = 0; mi < msgs.length; mi++) {
    const msg = msgs[mi];
    const fresh = mi >= freshStart;
    const content = msg && msg.content;
    if (!Array.isArray(content)) continue;   // string content carries no images
    for (let idx = 0; idx < content.length; idx++) {
      const block = content[idx];
      if (!block || typeof block !== "object") continue;
      if (block.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string") {
        images.push({ arr: content, idx, b64: block.source.data, mediaType: block.source.media_type || "image/png", fresh, tooLarge: block.source.data.length > IMAGE_BRIDGE_MAX_B64 });
        continue;
      }
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        const inner = block.content;
        for (let t = 0; t < inner.length; t++) {
          const tb = inner[t];
          if (tb && tb.type === "image" && tb.source?.type === "base64" && typeof tb.source.data === "string") {
            images.push({ arr: inner, idx: t, b64: tb.source.data, mediaType: tb.source.media_type || "image/png", fresh, tooLarge: tb.source.data.length > IMAGE_BRIDGE_MAX_B64 });
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
// are rewritten via the helper. Returns { body, helperModel, stats }, or null to
// passthrough (no images, or the alias natively supports images).
//
// Failure policy: a single image must never be able to kill a turn. Images the
// client just sent ("fresh") are the ones the user is waiting on — if those cannot
// be transcribed we fail loudly with an actionable 400. Replayed history images
// degrade to a text placeholder, because a replay protocol resends every image
// every turn and a cold cache would otherwise fail the session forever.
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
  const startedAt = Date.now();
  // Cache key is the image itself — no helper prefix. A description is a
  // description whichever vision model wrote it, so a failover to another profile
  // reuses the work instead of re-transcribing the whole history under a second
  // key (which is why the "new images" count never converged).
  const keyed = images.map(img => ({ img, hash: crypto.createHash("sha256").update(img.b64).digest("hex") }));
  const results = new Array(keyed.length).fill(null);
  const pending = [];
  for (let i = 0; i < keyed.length; i++) {
    const img = keyed[i].img;
    if (img.tooLarge) {
      results[i] = { text: `（图片过大 ${(img.b64.length / 1024 / 1024).toFixed(1)}MB，超过网关识别上限，未识别）`, placeholder: true };
      continue;
    }
    const cached = bridgeCacheGet(keyed[i].hash);
    if (cached !== null) { results[i] = { text: cached, hit: true }; continue; }
    pending.push(i);
  }
  // Only THIS turn's images earn a helper call. An uncached history image is one
  // that was never transcribed while it was fresh (bridge was off, cache cleared,
  // an earlier failure) — transcribing it now spends the client's wait on context
  // the user stopped asking about, and it rewrites the middle of the prompt every
  // turn, which throws away the upstream's prompt cache. So: placeholder, instantly.
  // A turn that adds no image therefore costs zero helper calls no matter how many
  // images the replayed history carries.
  const queue = [];
  for (const i of pending) {
    if (keyed[i].img.fresh) queue.push(i);
    else results[i] = { text: "（历史图片本轮未识别；如需分析请重新发送该图）", placeholder: true };
  }
  queue.sort((a, b) => b - a);   // newest first gets the budget
  for (const i of queue.splice(IMAGE_BRIDGE_MAX_IMAGES)) {
    results[i] = { text: `（本轮图片过多，超过网关单次识别上限 ${IMAGE_BRIDGE_MAX_IMAGES} 张，此张本轮未识别；请分批发送）`, placeholder: true };
  }
  // One budget per client request, not per failover candidate: the second
  // candidate re-bridges straight from cache and must not add another full wait.
  if (clientState && !clientState.bridgeDeadline) clientState.bridgeDeadline = Date.now() + IMAGE_BRIDGE_TOTAL_BUDGET_MS;
  const deadline = (clientState && clientState.bridgeDeadline) || (Date.now() + IMAGE_BRIDGE_TOTAL_BUDGET_MS);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const at = cursor++;
      if (at >= queue.length) return;
      const i = queue[at];
      throwIfClientAborted(clientState);
      const left = deadline - Date.now();
      if (left < IMAGE_BRIDGE_MIN_CALL_MS) {
        // Starting a call the deadline will cut short only burns tokens and reports
        // a misleading "timeout" — stop instead.
        results[i] = { failed: true, reason: `网关图片识别预算 ${Math.round(IMAGE_BRIDGE_TOTAL_BUDGET_MS / 1000)}s 已用尽，剩余时间不足以再识别一张` };
        continue;
      }
      const r = await describeImageViaHelper(keyed[i].img.b64, helperModel, runtime, clientState, profileCfg, protocol, keyed[i].img.mediaType, Math.min(IMAGE_BRIDGE_CALL_TIMEOUT_MS, left));
      if (r.ok) {
        results[i] = { text: r.text, fetched: true };
        bridgeCacheSet(keyed[i].hash, r.text);
      } else {
        results[i] = { failed: true, reason: r.reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(IMAGE_BRIDGE_CONCURRENCY, queue.length)) }, () => worker()));

  const freshFails = [];
  for (let i = 0; i < keyed.length; i++) {
    const r = results[i] || { failed: true, reason: "未处理" };
    if (r.failed && keyed[i].img.fresh) freshFails.push(r.reason);
    // Only this turn's images are ever attempted, so a failure here always throws
    // below; the text is a belt-and-braces fallback.
    const text = r.failed ? `（图片识别失败：${r.reason}）` : r.text;
    // Replace the image block with a text description (keep surrounding context).
    const img = keyed[i].img;
    if (protocol === "anthropic") {
      img.arr[img.idx] = { type: "text", text: `[图片内容] ${text}` };
    } else {
      parsed.input[img.i][img.field][img.j] = { type: img.textType, text: `[图片内容] ${text}` };
    }
  }
  if (freshFails.length) {
    // 400, not 502: the gateway only surfaces its own message to the client for
    // sub-500 statuses (a 502 reads as "Proxy Bad Gateway. Please try again
    // later." and the real cause never reaches the user), and Claude Code retries
    // 5xx — which would mean paying the whole bridge budget again per retry.
    const nativeAlias = Object.keys(profileCfg.modelAliases || {}).find(a => mm[a] === true);
    const err = new Error(`图片识别失败：方案「${runtime.profileName}」的辅助模型 ${helperModel} 没能转述本轮新贴的 ${freshFails.length} 张图片（原因：${freshFails[0]}）。可在设置页把辅助模型换成真正支持视觉的模型${nativeAlias ? `，或直接用已勾选多模态的别名 ${nativeAlias} 发图` : ""}。`);
    err.statusCode = 400;
    throw err;
  }
  const stats = {
    total: keyed.length,
    hit: results.filter(r => r && r.hit).length,
    got: results.filter(r => r && r.fetched).length,
    ph: results.filter(r => r && r.placeholder).length,
    failed: results.filter(r => r && r.failed).length,
    ms: Date.now() - startedAt,
  };
  return { body: Buffer.from(JSON.stringify(parsed)), helperModel, stats };
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

function bridgeHelperCooldown(key) {
  const h = bridgeHelperHealth.get(key);
  return h && h.until > Date.now() ? h.until - Date.now() : 0;
}
function bridgeHelperNoteFailure(key, reason) {
  const h = bridgeHelperHealth.get(key) || { fails: 0, until: 0 };
  h.fails++;
  if (h.fails >= IMAGE_BRIDGE_HELPER_FAIL_LIMIT) {
    h.until = Date.now() + IMAGE_BRIDGE_HELPER_COOLDOWN_MS;
    h.fails = 0;
    console.log(`[图片桥接] 辅助模型连续失败，冷却 ${IMAGE_BRIDGE_HELPER_COOLDOWN_MS / 1000}s ${key} 最后原因=${reason}`);
  }
  bridgeHelperHealth.set(key, h);
}
function bridgeHelperNoteSuccess(key) {
  if (bridgeHelperHealth.has(key)) bridgeHelperHealth.set(key, { fails: 0, until: 0 });
}

// Pull the description out of a helper reply. Helper models are usually reasoning
// models: they emit a thinking/reasoning block first and can run out of tokens
// before writing any prose (with the old max_tokens=1024 they always did, which is
// what "辅助返回空描述" really was). Fall back to that block's text rather than
// failing the image, and report block kinds + stop_reason so the log is diagnosable.
function pickHelperDescription(json, isAnthropic) {
  if (isAnthropic) {
    const blocks = Array.isArray(json?.content) ? json.content : [];
    const kinds = [...new Set(blocks.map(b => b?.type).filter(Boolean))].join("+") || "无内容";
    const stop = json?.stop_reason || "?";
    const text = blocks.filter(b => b?.type === "text").map(b => b.text || "").join("\n").trim();
    if (text) return { text: clampDescription(text), kinds, stop };
    const thinking = blocks.filter(b => b?.type === "thinking").map(b => b.thinking || "").join("\n").trim();
    if (thinking) return { text: clampDescription(thinking), kinds, stop, fromThinking: true };
    return { text: "", kinds, stop };
  }
  const out = Array.isArray(json?.output) ? json.output : [];
  const kinds = [...new Set(out.map(o => o?.type).filter(Boolean))].join("+") || "无内容";
  const stop = json?.status || json?.incomplete_details?.reason || "?";
  // Responses implementations disagree on where the prose ends up, and the Anthropic
  // side's thinking-block rescue has no direct equivalent here — so walk every place
  // a description can legitimately live before giving up on the image.
  let text = out.filter(o => o?.type === "message")
    .flatMap(o => (Array.isArray(o.content) ? o.content : []))
    .filter(c => c?.type === "output_text")
    .map(c => c.text || "").join("\n").trim();
  if (!text) {
    // The convenience field: some servers fill only this and leave `output` empty.
    const ot = json?.output_text;
    text = (Array.isArray(ot) ? ot.join("\n") : String(ot || "")).trim();
  }
  if (!text) {
    // Any non-reasoning part carrying text, whatever the server chose to call it.
    text = out.filter(o => o?.type !== "reasoning")
      .flatMap(o => (Array.isArray(o.content) ? o.content : []))
      .map(c => (typeof c?.text === "string" ? c.text : "")).join("\n").trim();
  }
  if (text) return { text: clampDescription(text), kinds, stop };
  const reasoning = out.filter(o => o?.type === "reasoning")
    .flatMap(o => [...(Array.isArray(o.summary) ? o.summary : []), ...(Array.isArray(o.content) ? o.content : [])])
    .map(s => (typeof s === "string" ? s : s?.text || "")).join("\n").trim();
  if (reasoning) return { text: clampDescription(reasoning), kinds, stop, fromThinking: true };
  return { text: "", kinds, stop };
}

// Ask the helper model to describe a base64 image. Returns { ok: true, text } or
// { ok: false, reason } with a human-readable Chinese reason the caller can put in
// front of the user. Client disconnects are RETHROWN, never turned into a failure:
// a hang-up used to become a synthetic 502 that fooled the failover layer into
// re-running the whole bridge against the next profile.
// Uses the profile's real upstream + key (same auth). The helper call speaks the
// SAME protocol as the profile it serves: Responses profiles ask /v1/responses
// with input_image, Anthropic profiles ask /v1/messages with an image block.
async function describeImageViaHelper(b64, helperModel, runtime, clientState, profileCfg, protocol, mediaType, timeoutMs) {
  const timeout = timeoutMs || IMAGE_BRIDGE_CALL_TIMEOUT_MS;
  const healthKey = `${runtime.upstreamUrl.host}|${helperModel}`;
  const cooldown = bridgeHelperCooldown(healthKey);
  if (cooldown > 0) return { ok: false, reason: `辅助模型 ${helperModel} 连续失败，冷却中（还剩 ${Math.ceil(cooldown / 1000)}s）` };
  // The helper never sees the user's question and gets exactly one shot: its text
  // replaces the image permanently and is cached, so anything left out is lost for
  // good. Hence the explicit priority order, the verbatim-text rule, and the length
  // ceiling. "不要解释你在做什么" also steers reasoning helpers away from spending
  // their whole budget narrating the task instead of describing the image.
  const instruction = "你是图片转述助手。你写的描述会替换掉这张图片本身，交给一个看不到图的语言模型，并且会被缓存复用——这是唯一一次机会，写漏的信息将永久丢失。请用简体中文按以下优先级转述：①图片类型与主体（截图／照片／图表／代码等）；②图中所有可见文字，原样抄录，不要改写或翻译；③布局、元素位置与控件状态（选中／报错／高亮等）；④配色与其他视觉特征。要求完整但紧凑，普通图片控制在 400 字以内，文字密集的截图最多 800 字。只输出描述本身，不要任何前后缀，不要解释你在做什么。";
  const mt = mediaType || "image/png";
  const isAnthropic = protocol === "anthropic";
  const buildBody = (askNoThinking) => isAnthropic
    ? JSON.stringify({
        model: helperModel,
        // 4096, not 1024: a reasoning helper spends its budget on thinking first
        // and truncates before any prose — leave room for both.
        max_tokens: 4096,
        stream: false,
        ...(askNoThinking ? { thinking: { type: "disabled" } } : {}),
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

  for (let attempt = 0; ; attempt++) {
    const askNoThinking = isAnthropic && attempt === 0 && !bridgeThinkingUnsupported.has(healthKey);
    const body = buildBody(askNoThinking);
    const headers = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      host: runtime.upstreamUrl.host,
      authorization: `Bearer ${getRealKeyFromProfile(profileCfg)}`,
    };
    let upRes;
    try {
      upRes = await sendUpstream(Buffer.from(body), isAnthropic ? "/v1/messages" : "/v1/responses", "POST", headers, timeout, runtime, clientState);
    } catch (e) {
      if (isClientAbortError(e)) throw e;
      const reason = e.isTimeout ? `辅助模型超时（${Math.round(timeout / 1000)}s 未返回）` : `辅助模型连接失败：${e.message}`;
      console.log(`${clientState.tag || ""} [图片桥接] 辅助调用异常 模型=${helperModel} err=${e.message}`);
      bridgeHelperNoteFailure(healthKey, reason);
      return { ok: false, reason };
    }
    const snippet = () => upRes.body.toString().slice(0, 200).replace(/\s+/g, " ");
    if (upRes.statusCode !== 200) {
      // Some Anthropic-compatible upstreams reject an unknown `thinking` field:
      // drop it once, remember that host+model, and retry instead of failing.
      if (askNoThinking && upRes.statusCode < 500 && /thinking/i.test(snippet())) {
        bridgeThinkingUnsupported.add(healthKey);
        console.log(`${clientState.tag || ""} [图片桥接] 上游不接受 thinking 字段，去掉后重试 模型=${helperModel}`);
        continue;
      }
      console.log(`${clientState.tag || ""} [图片桥接] 辅助调用失败 模型=${helperModel} status=${upRes.statusCode} body=${snippet()}`);
      const reason = `辅助模型返回 ${upRes.statusCode}：${snippet().slice(0, 80)}`;
      bridgeHelperNoteFailure(healthKey, reason);
      return { ok: false, reason };
    }
    let json;
    try { json = JSON.parse(upRes.body.toString()); } catch {
      console.log(`${clientState.tag || ""} [图片桥接] 辅助响应不是 JSON 模型=${helperModel} body=${snippet()}`);
      const reason = "辅助模型响应不是合法 JSON";
      bridgeHelperNoteFailure(healthKey, reason);
      return { ok: false, reason };
    }
    const picked = pickHelperDescription(json, isAnthropic);
    if (picked.text) {
      if (picked.fromThinking) console.log(`${clientState.tag || ""} [图片桥接] 辅助只给了思考过程，降级取思考文本 模型=${helperModel} stop_reason=${picked.stop}`);
      bridgeHelperNoteSuccess(healthKey);
      return { ok: true, text: picked.text };
    }
    console.log(`${clientState.tag || ""} [图片桥接] 辅助返回空描述 模型=${helperModel} blocks=${picked.kinds} stop_reason=${picked.stop} body=${snippet()}`);
    const reason = `辅助模型只返回 ${picked.kinds}、无描述正文（stop_reason=${picked.stop}）`;
    bridgeHelperNoteFailure(healthKey, reason);
    return { ok: false, reason };
  }
}

  return { bridgeImagesInRequest, ibCacheRows };
}
