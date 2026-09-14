// lib/proxy-helpers.mjs —— API Proxy 助手: API key 提取、客户端断开(abort)状态管理、
// 退避抖动、上游路径拼接。零依赖零模块状态, 故为纯具名导出(同 lib/time.mjs 风格)。
// 从 server.mjs 抽出(零缩进逐字搬移, 仅公开函数加 export 前缀); sleep 仅本模块内部使用。

// ─── API Proxy ───────────────────────────────────────────────────────────────
export function getApiKey(req) {
  const a = req.headers["authorization"];
  if (a && a.startsWith("Bearer ")) return a.slice(7);
  return req.headers["x-api-key"] || "unknown";
}

// ─── Client identification ───────────────────────────────────────────────────
// 客户端 ≠ 协议。Claude Code 和 zcode 都走 Anthropic 协议,zcode 还能走 OpenAI 协议,
// 所以 protoSeg(协议)推不出客户端,这是独立的一轴。
//
// 优先级 originator → UA 首个 product token → x-app,顺序是**实测定的,不是猜的**。
// 本机起 echo 服务器把真实客户端打过来的头抓下来:
//   Claude Code 2.1.266 → user-agent: claude-cli/2.1.266 (external, sdk-cli)
//                         x-app: cli
//   Codex 0.145.0       → user-agent: codex_exec/0.145.0 (Mac OS 26.5.2; arm64)
//                                      WarpTerminal/v0.2026.09.02.08.27.stable_01 (codex_exec; 0.145.0)
//                         originator: codex_exec        ← 不发 x-app
//
// 两条实测结论决定了这个顺序:
// 1. originator 排最前 —— 只有 Codex 发它,且它区分界面(codex-tui / codex_vscode /
//    codex_sdk_ts / codex-app-server / codex_cli_rs / codex_exec,六个值都能在 0.145.0
//    的二进制里找到原文),比 UA 里的环境信息更细。
// 2. x-app 排在 UA **后面**,因为 Claude Code 的 x-app 就是 `cli` 三个字母 —— 通用到
//    什么都说明不了,而它的 UA 首个 token `claude-cli` 才点名了客户端。若按 x-app 优先,
//    主客户端会被记成一堆叫 `cli` 的请求,展示层的 `claude-cli → Claude Code` 映射
//    也永远命中不了。Codex 不发 x-app,所以这一条不影响它。
//    代价:x-app 更具体、UA 是通用 HTTP 库名的客户端(如 x-app: zcode + UA: axios)
//    会退化成库名。UA 原文照进 JSONL 请求日志,真遇到可以回溯。
//
// 刻意不做枚举校验:以后还会有没见过的客户端,写死白名单会把它们全归成「其他」。
// 这里只负责取出一个稳定的原文标识,友好名映射留给展示层。
// 取不到就回 "unknown" —— 调用方照常落库(与会话维度的 nosession 刻意相反),
// 因为「未识别」本身就是客户端这个问题的真实答案。
export function extractClientSignal(reqHeaders) {
  const h = reqHeaders || {};
  const pick = (raw) => {
    if (typeof raw !== "string") return "";
    const v = raw.trim();
    return v ? v.slice(0, 128) : "";
  };

  const originator = pick(h["originator"]);
  if (originator) return originator;

  // UA 只取首个 product token,并丢掉版本号 —— "claude-cli/2.1.266" 每次升级都是新值,
  // 留着会把基数打爆(每个版本一行)。注释段 "(external, sdk-cli)" 也不参与。
  const ua = pick(h["user-agent"]);
  if (ua) {
    const product = ua.split(/[\s(]/)[0].split("/")[0].trim();
    if (product) return product.slice(0, 64);
  }

  const xApp = pick(h["x-app"]);
  if (xApp) return xApp;

  return "unknown";
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function makeClientAbortError(reason = "client disconnected") {
  const err = new Error(`Client disconnected: ${reason}`);
  err.code = "CLIENT_ABORT";
  err.isClientAbort = true;
  return err;
}

export function isClientAbortError(err) {
  return !!(err?.isClientAbort || err?.code === "CLIENT_ABORT");
}

export function createClientAbortState() {
  return {
    aborted: false,
    reason: "",
    // A set, not one slot: the image bridge fires several helper calls in
    // parallel and every in-flight one must die when the client hangs up.
    upstreamRequests: new Set(),
    listeners: new Set(),
  };
}

export function markClientAborted(state, reason) {
  if (!state || state.aborted) return;
  state.aborted = true;
  state.reason = reason || "unknown";
  for (const upReq of [...state.upstreamRequests]) {
    if (!upReq.destroyed) upReq.destroy(makeClientAbortError(state.reason));
  }
  for (const listener of [...state.listeners]) {
    try { listener(state.reason); } catch {}
  }
}

export function addClientAbortListener(state, listener) {
  if (!state) return () => {};
  if (state.aborted) {
    listener(state.reason);
    return () => {};
  }
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

export function setActiveUpstreamRequest(state, upReq) {
  if (!state) return () => {};
  state.upstreamRequests.add(upReq);
  if (state.aborted && !upReq.destroyed) {
    upReq.destroy(makeClientAbortError(state.reason));
  }
  return () => { state.upstreamRequests.delete(upReq); };
}

export function throwIfClientAborted(state) {
  if (state?.aborted) throw makeClientAbortError(state.reason);
}

export function sleepWithClientAbort(ms, state) {
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
export function jitter(ms) {
  const half = ms * 0.25;
  return ms + (Math.random() * half * 2 - half);
}

export function buildUpstreamPath(reqUrl, runtime) {
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
