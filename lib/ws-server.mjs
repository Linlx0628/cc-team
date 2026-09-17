// lib/ws-server.mjs —— 最小 RFC6455 WebSocket 服务端(纯 text 帧、无压缩)。
// 只为 Codex remote compact 的 WS 通道服务:握手、帧编解码、ping/pong、close。
// 刻意不引入 ws 依赖:需求面窄(服务端、text、无 permessage-deflate),手写可控可测;
// 浏览器场景与压缩扩展明确不支持(握手时不协商任何扩展)。
// 协议语义(帧体=标准 Responses 请求 JSON、SSE 事件按 data: 行回帧)见 server.mjs
// 的 handleResponsesWsUpgrade 注释。

import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_CONT = 0x0, OP_TEXT = 0x1, OP_CLOSE = 0x8, OP_PING = 0x9, OP_PONG = 0xA;
// 单帧上限 64MB:请求体本身另有 readBody 的 50MB 限制,这里只防恶意超大帧撑爆内存。
const MAX_FRAME = 64 * 1024 * 1024;

// 完成 101 握手。要求 Sec-WebSocket-Key 存在且版本为 13;失败返回 false(调用方 destroy)。
export function wsAcceptUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const version = req.headers["sec-websocket-version"];
  if (!key || String(version) !== "13") return false;
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    "\r\n"
  );
  return true;
}

// 握手期拒绝:向 socket 写普通 HTTP 错误响应后断开(客户端在 open 前收到失败)。
export function wsRejectUpgrade(socket, status, message) {
  const reason = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found" }[status] || "Error";
  const body = message + "\n";
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\n` +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    "Connection: close\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    "\r\n" + body
  );
  socket.destroy();
}

export class WsConn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    this._buf = Buffer.alloc(0);
    this._fragOp = -1;      // 分片累积:首片的 opcode(text 才累积)
    this._fragBuf = [];
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this._feed(chunk));
    // error 之后 node 必触发 close;两个都挂,先到先清
    socket.on("close", () => this._teardown());
    socket.on("error", () => { try { socket.destroy(); } catch {} this._teardown(); });
  }

  _teardown() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  _feed(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    // 逐帧解析;数据不足/致命错误时停(致命路径已触发 close)
    while (!this.closed) {
      const frame = this._parseFrame();
      if (!frame) break;
      this._handleFrame(frame);
    }
  }

  // 返回 {fin, opcode, payload} 或 null(缓冲不足)。掩码是客户端→服务端必填(RFC 6455)。
  _parseFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;
    const b0 = buf[0], b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < off + 2) return null;
      len = buf.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (buf.length < off + 8) return null;
      const big = buf.readBigUInt64BE(off); off += 8;
      if (big > BigInt(MAX_FRAME)) { this.close(1009, "frame too large"); return null; }
      len = Number(big);
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + len) return null;
    let payload = buf.subarray(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = buf.subarray(off, off + 4);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    this._buf = buf.subarray(off + maskLen + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === OP_PING) { this._sendFrame(OP_PONG, payload); return; }
    if (opcode === OP_PONG) return;
    if (opcode === OP_CLOSE) {
      // 完成 close 握手:尽量回显 status code 后优雅断开
      if (!this.closed) {
        this._sendFrame(OP_CLOSE, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
        try { this.socket.end(); } catch {}
        this._teardown();
      }
      return;
    }
    if (opcode === OP_TEXT || opcode === OP_CONT) {
      if (opcode === OP_TEXT) { this._fragOp = OP_TEXT; this._fragBuf = [payload]; }
      else if (this._fragOp === OP_TEXT) this._fragBuf.push(payload);
      else return; // 无首片的 continuation:丢弃
      if (fin) {
        const text = Buffer.concat(this._fragBuf).toString("utf8");
        this._fragOp = -1; this._fragBuf = [];
        if (text) this.emit("text", text);
      }
    }
    // 二进制等其它 opcode 忽略 —— 本服务端只收 text
  }

  _sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(len ? Buffer.concat([header, payload]) : header);
  }

  send(text) { this._sendFrame(OP_TEXT, Buffer.from(text, "utf8")); }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const r = Buffer.from(reason, "utf8");
    const p = Buffer.allocUnsafe(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    this._sendFrame(OP_CLOSE, p);
    try { this.socket.end(); } catch {}
    this._teardown();
  }
}
