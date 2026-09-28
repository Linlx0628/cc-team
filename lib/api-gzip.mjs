// lib/api-gzip.mjs —— /api/* JSON 响应的统一 gzip 出口。
// 背景:server.mjs 里有 150+ 处 `res.end(JSON.stringify(...))` 裸发 JSON,只有 /api/stats
// 走 sendJson() 压缩。逐点替换是巨型机械 diff,这里在 createServer 入口对 /api/* 请求
// 包装一次 res:writeHead 惰性化(记账不落盘),end 时若满足压缩条件则整包 gzip 后发出。
//
// 实现要点(v3,前两版的坑都写在下面,改动前必读):
//   1. **必须覆写 _implicitHeader**(v1 的坑):路由不调 writeHead 直接 end(body) 时,
//      Node 内部经 _implicitHeader() 虚调用 this.writeHead(200) —— 会打到包装器上;
//      若包装器只记账不落盘,状态行永远发不出去,keep-alive 连接上后续响应全部
//      解析失败(schedule-cascade 测试抓到过)。覆写为直接调原生 writeHead,绕开记账。
//   2. **writeHead 必须惰性化**(v2 的坑):Node 25 的 writeHead 是即时落盘的,路由
//      writeHead 之后再用 setHeader 注入压缩头已经来不及 —— 想在 end 时压缩,只有
//      把 writeHead 的参数扣下来延迟到 end 前一刻。
//   3. headersSent 用 getter 保持真语义:writeHead 被调用即 true(与原生一致),
//      路由里 `if (!res.headersSent)` 的二次写头防御行为不变。
//   4. res.write(流式)不压缩:刷出挂起的头再透传字节。
//   5. 压缩条件:content-type 含 application/json(writeHead 参数 ∪ setHeader 两处查,
//      大小写归一)&& body ≥ 1024 && 客户端 accept-encoding 含 gzip && 未自设
//      content-encoding(sendJson 已压缩的 /api/stats 天然防双重压缩)。阈值与 sendJson 一致。
import zlib from "node:zlib";

const MIN_BYTES = 1024;

export function installApiGzip(req, res) {
  // 沿原型链找原生的 headersSent getter,覆写后仍要如实反映 Node 内部状态。
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

  const headerGet = (headers, name) => {
    if (headers) {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === name) return headers[k];
      }
    }
    try { return res.getHeader(name); } catch { return undefined; }
  };

  // 把挂起的 writeHead 落到原生(gz 非空 = 本次要压缩:注入压缩头、删过期的 content-length)。
  const commit = (gz) => {
    if (pendingStatus === null) return;
    const status = pendingStatus;
    const h = { ...(pendingHeaders || {}) };
    pendingStatus = null;
    pendingHeaders = null;
    if (gz) {
      h["content-encoding"] = "gzip";
      if (headerGet(h, "vary") === undefined) h["vary"] = "Accept-Encoding";
      for (const k of Object.keys(h)) if (k.toLowerCase() === "content-length") delete h[k];
    }
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

  // Node 隐式头路径直落原生,绕开上面的记账器(见要点 1)。
  res._implicitHeader = () => { realWriteHead(200); };

  res.write = (chunk, ...rest) => {
    commit(null);
    return realWrite(chunk, ...rest);
  };

  res.end = (chunk, ...rest) => {
    const body = typeof chunk === "string" ? Buffer.from(chunk) : (Buffer.isBuffer(chunk) ? chunk : null);
    let gz = null;
    if (
      body && body.length >= MIN_BYTES &&
      String(headerGet(pendingHeaders, "content-type") || "").includes("application/json") &&
      headerGet(pendingHeaders, "content-encoding") === undefined &&
      (req.headers["accept-encoding"] || "").includes("gzip")
    ) {
      const compressed = zlib.gzipSync(body, { level: 6 });
      if (compressed.length < body.length) gz = compressed;
    }
    if (gz !== null && pendingStatus === null) {
      // 路由没调过 writeHead(隐式 200 头):压缩头走 setHeader,原生隐式头会带上。
      res.setHeader("Content-Encoding", "gzip");
      if (!res.getHeader("vary")) res.setHeader("Vary", "Accept-Encoding");
      res.removeHeader("Content-Length");
    } else {
      commit(gz);
    }
    return realEnd(gz !== null ? gz : chunk, ...rest);
  };
}
