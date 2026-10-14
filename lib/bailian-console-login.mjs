// 阿里云百炼「控制台令牌」的浏览器授权回路。
//
// 官方 bl CLI 的 `auth login --console` 做的事：
//   1. 本机 127.0.0.1 上随机端口开一个一次性 HTTP 服务；
//   2. 打开 `https://bailian.console.aliyun.com/console-login?notice=127.0.0.1:<port>?state=<state>`；
//   3. 控制台页面（用户已登录）把 access_token POST 回该端口；
//   4. CLI 落盘 ~/.bailian/config.json。
//
// 这里复刻第 1~3 步：令牌回到本进程后由 server.mjs 写进面板自己的配置
// （不依赖 ~/.bailian，也不需要用户安装 CLI）。回调契约与官方 CLI 一致：
// state 不匹配 → 400 "bad state\n"；成功 → 200 "OK\n"；跨域回
// `Access-Control-Allow-Origin: *`（浏览器从 console.aliyun.com 发过来，必须给）。
import http from "node:http";
import crypto from "node:crypto";

export const BAILIAN_CONSOLE_ORIGINS = {
  domestic: "https://bailian.console.aliyun.com",
  international: "https://modelstudio.console.alibabacloud.com",
};

export function bailianConsoleOrigin(site) {
  return String(site || "").trim() === "international"
    ? BAILIAN_CONSOLE_ORIGINS.international
    : BAILIAN_CONSOLE_ORIGINS.domestic;
}

// 官方 CLI 的登录 URL 形状（注意 `notice` 里还嵌了一个 `?state=`，照抄，别"修正"）。
// notice 默认 `127.0.0.1:<port>`（CLI 的本机回调）。面板自己收回调时传面板对外的
// host:port —— 本机访问或 SSH 隧道下就是浏览器地址栏里的那个 `127.0.0.1:6789`。
export function bailianConsoleLoginUrl({ origin, notice, port, state, needApiKey = false } = {}) {
  const base = String(origin || BAILIAN_CONSOLE_ORIGINS.domestic).replace(/\/+$/, "");
  const target = String(notice || "").trim() || `127.0.0.1:${Number(port)}`;
  let url = `${base}/console-login?notice=${target}?state=${encodeURIComponent(String(state || ""))}`;
  if (needApiKey) url += "&needapikey=true";
  return url;
}

// 百炼控制台授权页里的回调是**硬编码 http** 的：它的 bundle 里就是
// `fetch("http://".concat(notice), ...)`（https://g.alicdn.com/bailian-fe/bailian-cli-login/0.0.6/main.js）。
// 浏览器只对**回环地址**（127.0.0.1 / localhost / [::1]）豁免 mixed-content 拦截，
// 所以 notice 必须是回环地址才能真正收到令牌；写域名或局域网 IP 时那个 POST 会被
// 浏览器直接拦在本地，控制台那侧看起来"授权成功"、面板这侧永远等不到回调。
export function isLoopbackNotice(notice) {
  const raw = String(notice || "").trim().toLowerCase();
  if (!raw) return false;
  let host = raw;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end > 0 ? host.slice(1, end) : host.slice(1);
  } else if ((host.match(/:/g) || []).length === 1) {
    host = host.split(":")[0];
  }
  // 没有方括号、也没有端口的裸 IPv6（`::1`）走原样比较；多于一个冒号的都当 IPv6。
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

// 决定这次授权用哪个回调地址：显式覆盖（设置页「令牌回调地址」）> 请求 Host 头 > 本机回环。
// 返回 loopback 供界面提前给出人话提示（非回环时浏览器一定会拦下回调）。
export function resolveCallbackNotice({ override, hostHeader, localPort } = {}) {
  const explicit = String(override || "").trim();
  if (explicit) return { notice: explicit, loopback: isLoopbackNotice(explicit), source: "override" };
  const host = String(hostHeader || "").trim();
  if (host) return { notice: host, loopback: isLoopbackNotice(host), source: "host" };
  const fallback = `127.0.0.1:${Number(localPort) || 0}`;
  return { notice: fallback, loopback: true, source: "fallback" };
}

const KEY_ALIASES = {
  token: ["access_token", "accessToken"],
  apiKey: ["api_key", "apiKey"],
  baseUrl: ["base_url", "baseUrl"],
  site: ["console_site", "consoleSite"],
  region: ["console_region", "consoleRegion"],
  switchAgent: ["console_switch_agent", "consoleSwitchAgent"],
  workspaceId: ["workspace_id", "workspaceId"],
};

function fromRecord(rec, out) {
  if (!rec || typeof rec !== "object") return out;
  for (const [field, names] of Object.entries(KEY_ALIASES)) {
    for (const n of names) {
      const v = rec[n];
      if (v !== undefined && v !== null && String(v).trim() !== "") { out[field] = String(v).trim(); break; }
    }
  }
  return out;
}

function parseMultipart(raw, boundary) {
  const out = {};
  if (!boundary) return out;
  for (const part of String(raw).split(`--${boundary}`)) {
    const m = /name="([^"]+)"/.exec(part);
    if (!m) continue;
    const idx = part.indexOf("\r\n\r\n");
    if (idx < 0) continue;
    out[m[1]] = part.slice(idx + 4).replace(/\r?\n--?$/, "").trim();
  }
  return out;
}

// 从回调请求里抠出凭据：query 先，body 覆盖；body 依 content-type 解析
// （JSON / urlencoded / multipart），content-type 缺失或异常时按 JSON → 表单 → 裸串兜底。
export function extractBailianConsoleCredentials({ url, contentType = "", body = "" } = {}) {
  const out = {};
  try {
    const u = new URL(String(url || "/"), "http://127.0.0.1");
    u.searchParams.forEach((v, k) => { fromRecord({ [k]: v }, out); });
  } catch { /* 忽略坏 URL，继续看 body */ }

  const raw = typeof body === "string" ? body : String(body || "");
  // 类型判断用小写，但 multipart 的 boundary 大小写敏感，必须从原始头里取。
  const ct = String(contentType || "").toLowerCase();
  let parsed = null;
  if (ct.includes("json")) {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  } else if (ct.includes("x-www-form-urlencoded")) {
    parsed = Object.fromEntries(new URLSearchParams(raw));
  } else if (ct.includes("multipart/form-data")) {
    const boundary = (/boundary="?([^";]+)"?/i.exec(String(contentType || "")) || [])[1];
    parsed = parseMultipart(raw, boundary);
  } else if (raw.trim()) {
    try { parsed = JSON.parse(raw); } catch {
      const form = Object.fromEntries(new URLSearchParams(raw));
      parsed = Object.keys(form).some((k) => KEY_ALIASES.token.includes(k)) ? form : null;
    }
  }
  if (parsed && typeof parsed === "object") {
    fromRecord(parsed, out);
    fromRecord(parsed.data, out);
  } else if (raw.trim() && !out.token && !/\s/.test(raw.trim()) && raw.trim().length >= 16) {
    out.token = raw.trim(); // 裸串兜底：整段 body 就是一个令牌
  }
  return out;
}

// 控制台页面是 https，回调是跨域 POST，这几个头必须回（面板自己收回调时也用同一份）。
export const BAILIAN_CALLBACK_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  // Chrome 的私有网络访问预检（公网页面 → 127.0.0.1）需要这个头。
  "Access-Control-Allow-Private-Network": "true",
};
const CORS_HEADERS = BAILIAN_CALLBACK_CORS;

function readRequestBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (c) => { if (buf.length < limit) buf += c.toString("utf8"); });
    req.on("end", () => resolve(buf.slice(0, limit)));
    req.on("error", () => resolve(buf));
  });
}

// 起一个一次性回调会话。返回：
//   { state, port, url, done: Promise<creds>, close() }
// done 在拿到令牌时 resolve（creds 含 token/site/region/...），超时 reject（err.code = "timeout"）。
export async function startBailianConsoleLogin({
  site = "domestic",
  timeoutMs = 5 * 60 * 1000,
  host = "127.0.0.1",
  state = crypto.randomBytes(16).toString("hex"),
  serverFactory = () => http.createServer(),
} = {}) {
  const origin = bailianConsoleOrigin(site);
  let settle;
  const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  let finished = false;

  const server = serverFactory();
  const finish = (creds) => {
    if (finished) return;
    finished = true;
    settle.resolve(creds);
    // 先让响应写完再关监听（控制台页面偶发重试时会撞到已关闭的连接）。
    setTimeout(() => { try { server.close(); } catch { /* 已关闭 */ } }, 250).unref?.();
  };
  const fail = (err) => {
    if (finished) return;
    finished = true;
    settle.reject(err);
    try { server.close(); } catch { /* 已关闭 */ }
  };

  const timer = setTimeout(() => {
    const err = new Error("等待浏览器授权超时");
    err.code = "timeout";
    fail(err);
  }, Math.max(1000, Number(timeoutMs) || 60000));
  timer.unref?.();

  server.on("request", async (req, res) => {
    const send = (status, text) => {
      res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
      res.end(text);
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    let u;
    try { u = new URL(req.url || "/", `http://${host}`); } catch { return send(400, "bad request\n"); }
    if (u.searchParams.get("state") !== state) return send(400, "bad state\n");
    const body = await readRequestBody(req);
    const creds = extractBailianConsoleCredentials({
      url: req.url, contentType: req.headers["content-type"] || "", body,
    });
    if (!creds.token) return send(400, "missing access_token\n");
    send(200, "OK\n");
    finish({ ...creds, origin, site: creds.site || site });
  });
  server.on("error", (err) => fail(err));

  const port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address().port));
  });

  return {
    state,
    port,
    origin,
    url: bailianConsoleLoginUrl({ origin, port, state }),
    done,
    close() {
      clearTimeout(timer);
      if (!finished) {
        const err = new Error("授权会话已关闭");
        err.code = "closed";
        finished = true;
        settle.reject(err);
      }
      try { server.close(); } catch { /* 已关闭 */ }
    },
  };
}
