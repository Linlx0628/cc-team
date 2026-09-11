// lib/proxy-helpers.mjs —— API Proxy 助手: API key 提取、客户端断开(abort)状态管理、
// 退避抖动、上游路径拼接。零依赖零模块状态, 故为纯具名导出(同 lib/time.mjs 风格)。
// 从 server.mjs 抽出(零缩进逐字搬移, 仅公开函数加 export 前缀); sleep 仅本模块内部使用。

// ─── API Proxy ───────────────────────────────────────────────────────────────
export function getApiKey(req) {
  const a = req.headers["authorization"];
  if (a && a.startsWith("Bearer ")) return a.slice(7);
  return req.headers["x-api-key"] || "unknown";
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
