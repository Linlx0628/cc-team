// lib/smtp.mjs —— 极简 SMTP 客户端(发信),手写实现,不引第三方依赖。
//
// 为什么手写:本项目至今只有 better-sqlite3 一个依赖,连 WebSocket 都是自己写的
// (lib/ws-server.mjs)。为了一个「把评审结果发到邮箱」的功能引入 nodemailer 不划算,
// 而 SMTP 的子集足够小:EHELO → (STARTTLS) → AUTH → MAIL/RCPT/DATA → QUIT。
//
// 支持面(够用即可,不做全协议):
//   · 465 隐式 TLS(tls.connect)  与  587 STARTTLS(先明文,再升级)
//   · AUTH PLAIN(优先,若 EHLO 声明)与 AUTH LOGIN(企业邮箱最常见)
//   · 正文 base64 + UTF-8(中文最稳),主题按 RFC2047 编码
//
// ⚠️ 注入防护:邮箱地址与主题都会被拼进 SMTP 命令行 / 邮件头,任何 CRLF 都会造成
// **SMTP 命令注入或邮件头注入** —— 所以入口处一律拒绝含换行的取值,不做「过滤后放行」。
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

const CRLF = "\r\n";
const b64 = (s) => Buffer.from(String(s), "utf8").toString("base64");

// 单行取值:去掉首尾空白后不得含换行(否则可注入命令/头)
function safeToken(v, what) {
  const s = String(v == null ? "" : v).trim();
  if (!s) throw new Error(`${what}为空`);
  if (/[\r\n]/.test(s)) throw new Error(`${what}含非法换行`);
  return s;
}
// 宽松但明确的邮箱形状:有 @、无空白/尖括号/逗号(逗号用于多收件人分隔,这里刻意不支持列表写法)
export function isValidEmail(v) {
  const s = String(v == null ? "" : v).trim();
  return /^[^\s@<>,"]+@[^\s@<>,"]+\.[^\s@<>,"]+$/.test(s);
}
function safeEmail(v, what) {
  const s = safeToken(v, what);
  if (!isValidEmail(s)) throw new Error(`${what}不是合法邮箱: ${s.slice(0, 60)}`);
  return s;
}

// 把 base64 正文按 76 列折行(RFC 2045),并做点转义(DATA 里行首的 "." 必须写成 "..")
function wrap76(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 76) out.push(s.slice(i, i + 76));
  return out.join(CRLF).replace(/^\./gm, "..");
}

// 头部取值:非 ASCII(中文)按 RFC2047 编码,纯 ASCII 原样
function headerValue(v) {
  const s = String(v == null ? "" : v).replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
}

// 组装报文。From 只放裸地址(带中文显示名还要再编码,收益低、出错面大)。
export function buildMessage({ from, to, subject, text }) {
  return [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${headerValue(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@token-monitor>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(text)),
  ].join(CRLF);
}

// 一行响应形如 "250 xxx";"250-xxx" 表示还有后续行,读到 "250 " 才算这一轮结束
const isFinalLine = (line) => /^\d{3} /.test(line);
const lineCode = (line) => Number(line.slice(0, 3));

// 一次 SMTP 会话:把 socket 包成「写一行/一段 + 等一轮响应」的同步观感
class Session {
  constructor(socket) {
    this.sock = socket;
    this.buf = "";
    this.pending = [];      // 已收到但未归入某轮响应的行
    this.waiter = null;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { this.buf += chunk; this._drain(); });
    socket.on("error", (err) => this._fail(err));
    socket.on("close", () => this._fail(new Error("SMTP 连接被关闭")));
  }
  _fail(err) {
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(err); }
  }
  _drain() {
    const parts = this.buf.split(CRLF);
    this.buf = parts.pop();        // 末段可能不完整,留到下一块
    for (const line of parts) {
      if (!line) continue;
      this.pending.push(line);
      if (isFinalLine(line) && this.waiter) {
        const w = this.waiter; this.waiter = null;
        const lines = this.pending; this.pending = [];
        w.resolve({ code: lineCode(line), lines });
        return;
      }
    }
  }
  read() {
    if (this.waiter) return Promise.reject(new Error("SMTP 会话状态错乱:并发读取"));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this._drain();               // 数据可能已经先到了
    });
  }
  async write(payload) { this.sock.write(payload + CRLF); return this.read(); }
  // 发一条命令:非 2xx/3xx 一律当失败(把服务器那句话带出来,便于排查)
  async cmd(text, { okCodes = null } = {}) {
    const r = await this.write(text);
    const ok = okCodes ? okCodes.includes(r.code) : (r.code >= 200 && r.code < 400);
    if (!ok) throw new Error(`SMTP ${r.code}: ${(r.lines[r.lines.length - 1] || "").slice(0, 160)}`);
    return r;
  }
  // DATA 之后整段发送,不逐行等响应
  async payload(text) {
    const r = await this.write(text);
    if (!(r.code >= 200 && r.code < 300)) throw new Error(`SMTP ${r.code}: ${(r.lines[r.lines.length - 1] || "").slice(0, 160)}`);
    return r;
  }
  // STARTTLS:在同一 socket 上升级,旧 socket 的事件解绑
  upgrade(tlsOptions) {
    return new Promise((resolve, reject) => {
      this.sock.removeAllListeners("data");
      this.sock.removeAllListeners("error");
      this.sock.removeAllListeners("close");
      const t = tls.connect({ socket: this.sock, ...tlsOptions }, () => resolve(t));
      t.once("error", reject);
    });
  }
  close() { try { this.sock.destroy(); } catch { /* 已关 */ } }
}

// 发一封信。cfg: { host, port, secure, user, pass, from, to(单个或数组), subject, text, insecure }
//   insecure=true 跳过证书校验(自签名证书的内网 SMTP 很常见)——**默认关**,由管理员显式打开。
export function sendMail(cfg, { timeoutMs = 12000, clientName = "token-monitor" } = {}) {
  return new Promise((resolve, reject) => {
    let host, port, from, tos, subject, text, user, pass, secure, insecure;
    try {
      host = safeToken(cfg.host, "SMTP 服务器");
      port = Math.min(65535, Math.max(1, Number(cfg.port) || (cfg.secure ? 465 : 587)));
      secure = !!cfg.secure;
      insecure = !!cfg.insecure;
      user = String(cfg.user == null ? "" : cfg.user).trim();
      pass = String(cfg.pass == null ? "" : cfg.pass);
      from = safeEmail(cfg.from, "发件人");
      tos = (Array.isArray(cfg.to) ? cfg.to : [cfg.to]).map((x) => safeEmail(x, "收件人"));
      if (!tos.length) throw new Error("没有收件人");
      subject = safeToken(cfg.subject || "(无主题)", "主题");
      text = String(cfg.text == null ? "" : cfg.text);
    } catch (err) { reject(err); return; }
    // servername 只对**主机名**有意义:传 IP 时 Node 直接抛
    // "Setting the TLS ServerName to an IP address is not permitted" ——
    // 按 IP 配内网 SMTP 很常见,所以这里判一下,是 IP 就不带 SNI。
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
    const tlsOptions = { ...(isIp ? {} : { servername: host }), ...(insecure ? { rejectUnauthorized: false } : {}) };

    let session = null;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (session) session.close();
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("SMTP 超时")), timeoutMs);

    (async () => {
      const sock = secure
        ? tls.connect({ host, port, ...tlsOptions })
        : net.connect({ host, port });
      sock.setTimeout(timeoutMs, () => finish(new Error("SMTP 超时")));
      sock.once("error", (err) => finish(err));
      if (secure) await new Promise((res, rej) => { sock.once("secureConnect", res); sock.once("error", rej); });
      session = new Session(sock);

      const greet = await session.read();
      if (greet.code !== 220) throw new Error(`SMTP 问候异常 ${greet.code}`);

      let caps = await session.cmd(`EHLO ${clientName}`);
      if (!secure) {
        if (!caps.lines.some((l) => /STARTTLS/i.test(l))) throw new Error("服务器不支持 STARTTLS(请改用 465 端口)");
        await session.cmd("STARTTLS");
        const upgraded = await session.upgrade(tlsOptions);
        session = new Session(upgraded);
        caps = await session.cmd(`EHLO ${clientName}`);
      }

      if (user) {
        const declared = caps.lines.join(" ").toUpperCase();
        if (/AUTH[^\n]*PLAIN/.test(declared)) {
          await session.cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`);
        } else {
          await session.cmd("AUTH LOGIN");
          await session.cmd(b64(user));
          await session.cmd(b64(pass));
        }
      }

      await session.cmd(`MAIL FROM:<${from}>`);
      for (const rcpt of tos) await session.cmd(`RCPT TO:<${rcpt}>`);
      const data = await session.cmd("DATA", { okCodes: [354] });
      if (data.code !== 354) throw new Error(`SMTP ${data.code}: 服务器拒绝 DATA`);
      await session.payload(buildMessage({ from, to: tos, subject, text }) + CRLF + ".");
      try { await session.cmd("QUIT"); } catch { /* 服务器不等 QUIT 也无所谓 */ }
      finish(null);
    })().catch(finish);
  });
}
