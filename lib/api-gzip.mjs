// lib/api-gzip.mjs —— /api/* JSON 响应的统一 gzip 出口。
// 背景:server.mjs 里有 150+ 处 `res.end(JSON.stringify(...))` 裸发 JSON,只有 /api/stats
// 走 sendJson() 压缩。逐点替换是巨型机械 diff,这里改为在 createServer 入口对 /api/* 请求
// 包装一次 res:writeHead 惰性化(记账不刷出),end 时若满足压缩条件则整包 gzip 后发出。
//
// 语义要点(与 Node 原生行为的差异全部收敛在这几条):
//   1. writeHead 只记 status+headers,首次真正 write/end 才刷出 —— Node 自身也是惰性
//      刷头,这里只是把「刷出时机」推迟到了包装层,路由代码无感知。
//   2. headersSent 保持真语义:writeHead 被调用即返回 true(与原生一致),路由里
//      `if (!res.headersSent)` 的错误分支行为不变。
//   3. res.write(流式)路径不压缩:直接刷出挂起的头再透传字节。/api 下没有大流量流式
//      端点,该分支只是保底。
//   4. setHeader/getHeader 仍走 Node 原生 header map;刷出时 realWriteHead(status, h)
//      按 Node 原生优先级合并(writeHead 参数 > setHeader)。
//   5. 压缩条件:content-type 含 application/json && body ≥ 1024 字节 && 客户端
//      accept-encoding 含 gzip && 路由未自设 content-encoding。阈值与 sendJson 一致。
import zlib from "node:zlib";

const MIN_BYTES = 1024;

export function installApiGzip(req, res) {
  // 沿原型链找原生的 headersSent getter,包装后仍要如实反映 Node 内部状态。
  let proto = Object.getPrototypeOf(res);
  let desc = null;
  while (proto && !desc) {
    desc = Object.getOwnPropertyDescriptor(proto, "headersSent");
    proto = Object.getPrototypeOf(proto);
  }
  const nativeHeadersSent = desc ? desc.get.bind(res) : () => false;

  let pendingStatus = null;
  let pendingHeaders = null;

  const realWriteHead = res.writeHead.bind(res);
  const realWrite = res.write.bind(res);
  const realEnd = res.end.bind(res);

  // writeHead 参数里的 header 名大小写不定(路由里有 "Content-Type" 也有小写),
  // 查询与删除都要按小写归一。
  const pendingGet = (name) => {
    if (!pendingHeaders) return undefined;
    for (const k of Object.keys(pendingHeaders)) {
      if (k.toLowerCase() === name) return pendingHeaders[k];
    }
    return undefined;
  };
  const pendingDelete = (name) => {
    if (!pendingHeaders) return;
    for (const k of Object.keys(pendingHeaders)) {
      if (k.toLowerCase() === name) delete pendingHeaders[k];
    }
  };

  const effectiveContentType = () => {
    const fromPending = pendingGet("content-type");
    if (fromPending !== undefined) return String(fromPending);
    try { return String(res.getHeader("content-type") || ""); } catch { return ""; }
  };
  const hasEncoding = () => {
    if (pendingGet("content-encoding") !== undefined) return true;
    try { return !!res.getHeader("content-encoding"); } catch { return false; }
  };

  // 刷出挂起的头。gz 非空 = 本次响应要压缩:追加 Content-Encoding/Vary、丢弃路由可能
  // 预设的过期 content-length。路由没调过 writeHead(pendingStatus 为 null,隐式 200 头)
  // 时压缩头直接进 Node 的 header map。
  const flush = (gz) => {
    if (pendingStatus === null) {
      if (gz) {
        res.setHeader("Content-Encoding", "gzip");
        if (!res.getHeader("vary")) res.setHeader("Vary", "Accept-Encoding");
      }
      return;
    }
    const status = pendingStatus;
    const h = { ...(pendingHeaders || {}) };
    if (gz) {
      h["content-encoding"] = "gzip";
      if (!h["vary"]) h["vary"] = "Accept-Encoding";
      // 压缩后原 content-length 作废(大小写不定,扫一遍删),Node 会按实际发出体重算。
      for (const k of Object.keys(h)) if (k.toLowerCase() === "content-length") delete h[k];
    }
    pendingStatus = null;
    pendingHeaders = null;
    realWriteHead(status, h);
  };

  Object.defineProperty(res, "headersSent", {
    get() { return pendingStatus !== null || nativeHeadersSent(); },
    configurable: true,
  });

  res.writeHead = (status, headers) => {
    pendingStatus = status;
    pendingHeaders = { ...(headers || {}) };
    return res;
  };

  res.write = (chunk, ...rest) => {
    flush(null);
    return realWrite(chunk, ...rest);
  };

  res.end = (chunk, ...rest) => {
    const body = typeof chunk === "string" ? Buffer.from(chunk) : (Buffer.isBuffer(chunk) ? chunk : null);
    let gz = null;
    if (
      body && body.length >= MIN_BYTES &&
      effectiveContentType().includes("application/json") &&
      !hasEncoding() &&
      (req.headers["accept-encoding"] || "").includes("gzip")
    ) {
      const compressed = zlib.gzipSync(body, { level: 6 });
      if (compressed.length < body.length) gz = compressed;
    }
    flush(gz);
    return realEnd(gz !== null ? gz : chunk, ...rest);
  };
}
