// lib/upstream-gzip.mjs —— 上游请求体 gzip(P4,出网优化最大杠杆)。
// 「整段对话重放」协议下每轮把全量上下文(几百 KB~几 MB)明文发上游,是这台网关出网的
// 大头(2026-09 实测 ≈650MB/天)。JSON 文本 gzip 比率 4~6x;level 1 与 level 6 比率只差
// 3~8% 而耗时差 5~10 倍,所以默认 level 1、异步走 libuv 线程池,不阻塞事件循环。
//
// 压缩发生在两个发送咽喉的最后一刻(非流式 sendUpstream / 流式 streamUpstreamOnce):
// 模型重解析、compaction 翻译、tool-pattern 剔除、图片桥接改写、三种自愈重发,全部
// 操作未压缩 body,改写后重新压缩,天然兼容。**绝不 mutate 调用方的 reqHeaders** ——
// 自愈路径会自己重写共享头的 content-length,提前把 content-encoding 塞进去会出现
// 「gzip 头 + 明文长度」的致命错配;这里只返回浅拷贝头。
//
// 探测门控(不赌文档):上游对 gzip 请求体的支持没有契约(Anthropic 官方 API 支持;
// OpenAI 兼容端点多数支持但不保证)。auto(默认)先探后压:发一个 max_tokens=1 的压缩
// ping,200 → ok;400/415/422 且错误文命中编码指纹 → no;429/5xx/网络错 → unknown,
// 冷却 10 分钟后重探。状态(runtime.gzState)纯内存,重启重探,成本一次几百字节请求。
//
// 三层降级:
//   1. 请求级:响应命中编码指纹 → 同一请求透明重发一次明文(不占自愈名额,用户无感);
//   2. 方案级:指纹累计 ≥2 次 → gzState=no 粘性禁用,6 小时后自动重探;
//   3. 全局:config.proxy.upstreamRequestGzip="off"(或 per-profile requestGzip="off")
//      一键全体明文。
import zlib from "node:zlib";
import http from "node:http";
import https from "node:https";
import { buildUpstreamPath } from "./proxy-helpers.mjs";

const UNKNOWN_RETRY_MS = 10 * 60 * 1000;        // unknown → 10 分钟后重探
const STICKY_REPROBE_MS = 6 * 3600 * 1000;      // ok/no  → 6 小时后复考(上游行为会变)

export function normalizeUpstreamGzipMode(v) {
  return v === "on" || v === "off" ? v : "auto";
}

// 该方案此刻是否压缩:per-profile requestGzip 优先于全局 upstreamRequestGzip
// (per-profile 缺省 null 时回落全局);on/off 显式生效,auto 只在探测结论为 ok 时压缩。
export function upstreamGzipEnabled(runtime, gProxy) {
  const mode = normalizeUpstreamGzipMode((runtime && runtime.requestGzip) || (gProxy && gProxy.upstreamRequestGzip));
  if (mode === "on") return true;
  if (mode === "off") return false;
  return !!(runtime && runtime.gzState === "ok");
}

// 编码拒绝指纹:4xx + 错误文点名编码/解压/JSON 解析失败。真 malformed-JSON(客户端的
// 错)撞上压缩开启时也会命中 —— 明文重发一次仍 400 照常回给客户端,无害;两次指纹才
// 粘性关闭,且 6 小时后自动重探,单次假阳性不会永久关死一个方案。
export function looksLikeEncodingRejection(status, text) {
  if (status !== 400 && status !== 415 && status !== 422) return false;
  return /content-encoding|gzip|gunzip|decompress|invalid[_ ]?json|malformed|无法解析|编码|解压/i.test(String(text || "").slice(0, 500));
}

function gzipAsync(buf, level) {
  return new Promise((resolve) => {
    zlib.gzip(buf, { level }, (err, out) => resolve(err ? null : out));
  });
}

// 压缩决策(发送咽喉调用,异步)。返回 null = 保持明文,否则
// { body: gzBuffer, headers: 浅拷贝头(content-length 已改为压缩后长度) }。
// opts.skip:该请求已因编码拒绝回退明文(clientState.gzSkip);
// opts.gzCache:{src,gz} 单槽缓存 —— 重试重发同一 Buffer 免重压,自愈改写后的
// 新 Buffer 自然 miss。压不动(gz ≥ 原长,base64 图片的常态)直接放弃。
export async function prepareUpstreamBody(body, reqHeaders, runtime, gProxy, opts = {}) {
  if (!upstreamGzipEnabled(runtime, gProxy)) return null;
  if (opts.skip) return null;
  if (reqHeaders && reqHeaders["content-encoding"]) return null;   // 入站已压缩:透传
  const minBytes = Number(gProxy && gProxy.upstreamGzipMinBytes) || 4096;
  if (!body || body.length < minBytes) return null;
  const level = Math.min(9, Math.max(1, Number(gProxy && gProxy.upstreamGzipLevel) || 1));
  let gz = null;
  const cache = opts.gzCache;
  if (cache && cache.src === body && cache.gz) {
    gz = cache.gz;
  } else {
    gz = await gzipAsync(body, level);
    if (cache) { cache.src = body; cache.gz = gz; }
  }
  if (!gz || gz.length >= body.length) return null;
  return {
    body: gz,
    headers: { ...reqHeaders, "content-length": gz.length, "content-encoding": "gzip" },
  };
}

// 编码拒绝记账:两次即粘性禁用该方案(防单次假阳性),6 小时后自动重探。
export function noteEncodingRejection(runtime) {
  if (!runtime) return;
  runtime.gzRejects = (runtime.gzRejects || 0) + 1;
  if (runtime.gzRejects >= 2 && runtime.gzState !== "no") {
    runtime.gzState = "no";
    runtime.gzRetryAt = Date.now() + STICKY_REPROBE_MS;
    console.log(`[上游压缩] 方案「${runtime.profileName}」: 编码拒绝累计 ${runtime.gzRejects} 次,粘性禁用压缩(6 小时后自动重探)`);
  }
}

// 压缩请求拿到 <400 响应:指纹计数清零。
export function noteEncodingSuccess(runtime) {
  if (runtime && runtime.gzRejects) runtime.gzRejects = 0;
}

function probeBodyFor(protocol, model) {
  if (protocol === "responses") {
    return { model, input: "ping", max_output_tokens: 1, stream: false };
  }
  return { model, max_tokens: 1, stream: false, messages: [{ role: "user", content: "ping" }] };
}

// 响应体是不是「用 200 包着的错误」。有些网关（实测 GLM 的 responses 入口）对
// 不认识的请求体回 200 + {"error":…},只按状态码判定会误判成「接受 gzip」→ 真实
// 请求随后被拒 → 白折腾一轮粘性禁用。非 JSON 无从判断,按成功处理。
function looksLikeErrorPayload(text) {
  let j;
  try { j = JSON.parse(text); } catch { return false; }
  if (!j || typeof j !== "object") return false;
  if (j.error) return true;
  if (j.type === "error") return true;
  if (j.status === "failed" || j.status === "error") return true;
  return false;
}

// 探测响应 → 结论。纯函数,单测直接覆盖(见 tests/upstream-gzip.test.mjs)。
//   ok      上游接受了 gzip 请求体(200 且不像错误体)
//   no      4xx 且命中编码指纹 —— 明确拒绝压缩
//   unknown 其余(200 但仍像错误 / 429 / 5xx / 看不懂的 4xx) —— 不改变既有状态
export function classifyProbeResponse(status, text) {
  const body = String(text || "");
  const snippet = body.slice(0, 140).replace(/\s+/g, " ");
  if (status === 200) {
    return looksLikeErrorPayload(body)
      ? { result: "unknown", detail: `200 但响应体是错误 JSON: ${snippet}` }
      : { result: "ok", detail: "" };
  }
  if (looksLikeEncodingRejection(status, body)) return { result: "no", detail: `状态 ${status}: ${snippet}` };
  return { result: "unknown", detail: `状态 ${status}: ${snippet}` };
}

// 发一个压缩 ping 问上游「收不收 gzip 请求体」。getRealKey(runtime) → 真实上游密钥。
// 返回 { result: "ok"|"no"|"unknown", detail } —— unknown 不改状态,但会打日志说明原因
// (此前是静默的,方案为什么压不了完全看不出来)。
async function probeUpstreamGzip(rt, getRealKey) {
  const realKey = getRealKey(rt);
  const model = (rt.allowedModels && rt.allowedModels[0]) || Object.values(rt.modelAliases || {})[0];
  if (!realKey || !model) return { result: "unknown", detail: "方案未配置可用密钥或模型" };
  const raw = Buffer.from(JSON.stringify(probeBodyFor(rt.protocol, model)));
  const gz = await gzipAsync(raw, 1);
  if (!gz) return { result: "unknown", detail: "探测体压缩失败" };
  const transport = rt.upstreamUrl.protocol === "https:" ? https : http;
  // 路径必须与真实请求**同源**:走 buildUpstreamPath + 方案自己的 responsesPath,
  // 而不是拼死的 "/v1/responses"。否则 responsesPath 自定义的方案(如火山引擎
  // base=/api/coding/v3 + responsesPath=/responses)探测永远打到不存在的地址,
  // 结论恒为 unknown、永远压不了 —— 这个 bug 让 Codex 流量白跑了很久。
  const probePath = buildUpstreamPath(rt.protocol === "responses" ? (rt.responsesPath || "/v1/responses") : "/v1/messages", rt);
  return await new Promise((resolve) => {
    const req = transport.request({
      hostname: rt.upstreamUrl.hostname,
      port: rt.upstreamUrl.port || (rt.upstreamUrl.protocol === "https:" ? 443 : 80),
      path: probePath,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": gz.length,
        "content-encoding": "gzip",
        authorization: `Bearer ${realKey}`,
        "x-api-key": realKey,
        "anthropic-version": "2023-06-01",
      },
      agent: rt.agent,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(classifyProbeResponse(res.statusCode, Buffer.concat(chunks).toString())));
    });
    req.setTimeout(15000, () => req.destroy(new Error("probe timeout")));
    req.on("error", (err) => resolve({ result: "unknown", detail: `网络错误: ${err.message}` }));
    req.write(gz);
    req.end();
  });
}

// 单次探测 + 状态落位。仅 auto 模式有意义;冷却期(gzRetryAt)未到直接跳过。
// 三种结论都打日志(unknown 以前是静默的,看不到为什么压不了)。
export async function runUpstreamGzipProbe(rt, getRealKey) {
  if (!rt || Date.now() < (rt.gzRetryAt || 0)) return;
  const { result, detail } = await probeUpstreamGzip(rt, getRealKey);
  if (result === "ok") {
    rt.gzState = "ok";
    rt.gzRejects = 0;
    rt.gzRetryAt = Date.now() + STICKY_REPROBE_MS;
    console.log(`[上游压缩] 方案「${rt.profileName}」: 探测通过,上游接受 gzip 请求体,已启用压缩`);
  } else if (result === "no") {
    rt.gzState = "no";
    rt.gzRejects = 0;
    rt.gzRetryAt = Date.now() + STICKY_REPROBE_MS;
    console.log(`[上游压缩] 方案「${rt.profileName}」: 探测到上游拒绝 gzip 请求体,保持明文(6 小时后重探)${detail ? " | " + detail : ""}`);
  } else {
    rt.gzState = "unknown";
    rt.gzRetryAt = Date.now() + UNKNOWN_RETRY_MS;
    console.log(`[上游压缩] 方案「${rt.profileName}」: 探测未出结论,保持明文(${UNKNOWN_RETRY_MS / 60000} 分钟后重试)${detail ? " | " + detail : ""}`);
  }
}

// 探测节奏:起步延迟 45s(避开启动高峰,tool-pattern 探针 30s 之后),之后每 5 分钟
// 扫一遍 —— 每个方案自己按 gzRetryAt 决定这次要不要真发(unknown 10 分钟/结论 6 小时)。
// Math.max 下限与 tool-pattern 探针同款:延迟不设下限、周期下限 1s,测试可用环境变量
// 缩短节奏观察「探测→学习→生效」闭环。
export const UPSTREAM_GZIP_PROBE_DELAY_MS = Math.max(0, Number(process.env.UPSTREAM_GZIP_PROBE_DELAY_MS) || 45000);
export const UPSTREAM_GZIP_PROBE_INTERVAL_MS = Math.max(1000, Number(process.env.UPSTREAM_GZIP_PROBE_INTERVAL_MS) || 5 * 60 * 1000);
