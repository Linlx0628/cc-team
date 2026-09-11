// lib/notifier.mjs —— 系统事件通知(webhook 推送): 限流/熔断/failover 告警与恢复,
// 多渠道(飞书/钉钉/企业微信/Server酱/Bark)扇出、单头 incident 生命周期去重、全局冷却。
// 从 server.mjs 抽出(零缩进逐字搬移)。依赖经 createNotifier 工厂注入(按值捕获)。

export function createNotifier(d) {
  const {
    http,
    https,
    config
  } = d;

// ─── System-Event Notifier (webhook push) ─────────────────────────────────────
// Pushes failure/recovery audit events to IM bots and phone-push channels.
// Best-effort and fully async: never blocks the proxy, never throws, and never
// records audits of its own (a notify failure must not spawn another notify).
const NOTIFY_FAILURE_ACTIONS = new Set(["ratelimit.mark", "failover.switch", "breaker.open"]);
const NOTIFY_RECOVERY_ACTIONS = new Set(["ratelimit.expire", "failover.recover", "breaker.closed"]);
const NOTIFY_TIMEOUT_MS = 5000;

// Per-head failure incidents. All alert/recovery events of one failover-group
// head collapse into a single open→close lifecycle, so a stuck scheme cannot
// push an alert+recovery pair every cycle. A head is identified by its profile
// name (see normalizeIncidentKey). Process restart clears the map — same as the
// old cooldown — and a still-failing head simply opens a fresh incident after
// restart (one extra alert, acceptable).
const notifyIncidents = new Map(); // head → { openedAt }
let notifyLastPushAt = 0;          // global "time since any push" floor for minIntervalSeconds

function beijingTimeString(d = new Date()) {
  return new Date(d).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function postHttpRequest(url, { body, contentType, timeoutMs = NOTIFY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (err) { reject(new Error("URL 无效")); return; }
    const mod = target.protocol === "https:" ? https : http;
    const payload = body == null ? null : Buffer.from(body);
    const req = mod.request(target, {
      method: "POST",
      headers: {
        ...(contentType ? { "content-type": contentType } : {}),
        ...(payload ? { "content-length": payload.length } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(text);
        else reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 120)}`));
      });
    });
    req.on("timeout", () => { req.destroy(new Error("请求超时")); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Each sender returns a Promise resolving on channel acceptance.
const NOTIFY_SENDERS = [
  { channel: "飞书", enabled: (n) => !!String(n.feishuWebhook || "").trim(), send: (n, msg) =>
    postHttpRequest(n.feishuWebhook, { body: JSON.stringify({ msg_type: "text", content: { text: msg } }), contentType: "application/json" }) },
  { channel: "钉钉", enabled: (n) => !!String(n.dingtalkWebhook || "").trim(), send: (n, msg) =>
    postHttpRequest(n.dingtalkWebhook, { body: JSON.stringify({ msgtype: "text", text: { content: msg } }), contentType: "application/json" }) },
  { channel: "企业微信", enabled: (n) => !!String(n.wecomWebhook || "").trim(), send: (n, msg) =>
    postHttpRequest(n.wecomWebhook, { body: JSON.stringify({ msgtype: "text", text: { content: msg } }), contentType: "application/json" }) },
  { channel: "Server酱", enabled: (n) => !!String(n.serverchanSendKey || "").trim(), send: (n, msg) => {
    const key = String(n.serverchanSendKey).trim();
    const form = `title=${encodeURIComponent(msg.split("\n")[0])}&desp=${encodeURIComponent(msg)}`;
    return postHttpRequest(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, { body: form, contentType: "application/x-www-form-urlencoded" });
  } },
  { channel: "Bark", enabled: (n) => !!String(n.barkDeviceKey || "").trim(), send: (n, msg) => {
    const base = String(n.barkServer || "").trim().replace(/\/+$/, "") || "https://api.day.app";
    const key = encodeURIComponent(String(n.barkDeviceKey).trim());
    return postHttpRequest(`${base}/${key}`, { body: JSON.stringify({ body: msg, group: "token-monitor" }), contentType: "application/json" });
  } },
];

// Map an audit event to the failover-group head it belongs to.
//   ratelimit.mark/expire, breaker.open/closed → target is already the head name
//   failover.switch/recover → target may be "Head → Member"; the head is the left
//                             side (failover.recover already passes a bare head).
// Returns null when no head can be derived; such an event falls back to the old
// always-push path (no incident bookkeeping) so a parse miss never drops a real
// notification.
function normalizeIncidentKey(action, target) {
  const t = String(target || "").trim();
  if (!t) return null;
  const failoverAction = action === "failover.switch" || action === "failover.recover";
  const head = (failoverAction && t.includes("→")) ? t.slice(0, t.indexOf("→")).trim() : t;
  return head || null;
}

// Fire-and-forget dispatch. Synchronous entry, async fan-out; all channel
// failures are logged, never surfaced.
//
// Incident semantics (per failover-group head):
//   failure  → no open incident for the head: open one and push an alert.
//              already open: silent (no push, no refresh) — the dedupe that stops
//              the alert+recover pair spam.
//   expire   → NEVER pushes and never closes an incident: ratelimit.expire is only
//              the 120s fallback window elapsing, not a real recovery. A genuine
//              recovery is the head serving traffic again (failover.recover) or the
//              breaker closing (breaker.closed).
//   recover  → closes the head's open incident (if any) and pushes a recovery when
//              cfg.notifyRecovery !== false. A recovery with no open incident is an
//              orphan (e.g. after a restart) and is not pushed.
// minIntervalSeconds is ONE global floor between any two pushes (not a per-action
// lock): incidents already dedupe per head, so the floor only stops a simultaneous
// multi-head burst. The registry is still updated when the floor suppresses the
// push, so a burst does not leave silent incidents stuck open.
function notifyAuditEvent(row) {
  const cfg = config.notifier || {};
  if (!cfg.enabled) return;
  const action = row.action;
  const isFailure = NOTIFY_FAILURE_ACTIONS.has(action);
  const isRecovery = NOTIFY_RECOVERY_ACTIONS.has(action);
  if (!isFailure && !isRecovery) return;

  let incidentKey = normalizeIncidentKey(action, row.target);
  if (isFailure) {
    if (incidentKey) {
      if (notifyIncidents.has(incidentKey)) return; // already open → silent
      notifyIncidents.set(incidentKey, { openedAt: Date.now() });
    }
  } else {
    // Recovery action. ratelimit.expire is a FALSE recovery (fallback window
    // elapsing, not the head serving again) — never notify, never close.
    if (action === "ratelimit.expire") return;
    if (incidentKey) {
      if (!notifyIncidents.delete(incidentKey)) return; // orphan recovery → silent
    }
    if (cfg.notifyRecovery === false) return;           // close incident but keep quiet
  }

  const prefix = isFailure ? "【网关告警】" : "【网关恢复】";
  const msg = `${prefix} ${row.target || action}\n${row.detail || ""}\n—— ${beijingTimeString()}（token-monitor）`;
  const channels = NOTIFY_SENDERS.filter((s) => s.enabled(cfg));
  if (!channels.length) return;

  const rawInterval = Number(cfg.minIntervalSeconds);
  const intervalMs = Math.max(0, (Number.isFinite(rawInterval) ? rawInterval : 300) * 1000);
  const now = Date.now();
  if (now - notifyLastPushAt < intervalMs) return;      // global floor (not per-action)
  notifyLastPushAt = now;

  for (const s of channels) {
    s.send(cfg, msg)
      .then(() => console.log(`[通知] 已推送 ${s.channel}: ${action} ${row.target}`))
      .catch((err) => console.error(`[通知] ${s.channel} 推送失败: ${err.message}`));
  }
}

// Send a test message to every configured channel of the given (possibly
// unsaved) config; resolves with per-channel results for the UI.
async function sendNotifierTest(cfg) {
  const msg = `[token-monitor] 通知测试成功\n渠道连通性验证通过。系统故障/恢复事件（限流、failover 切换、熔断）将推送到此处。\n—— ${beijingTimeString()}`;
  const channels = NOTIFY_SENDERS.filter((s) => s.enabled(cfg));
  const results = await Promise.all(channels.map(async (s) => {
    try { await s.send(cfg, msg); return { channel: s.channel, ok: true }; }
    catch (err) { return { channel: s.channel, ok: false, error: err.message }; }
  }));
  return results;
}

function sanitizeNotifierConfig(input) {
  const src = input && typeof input === "object" ? input : {};
  const url = (v) => {
    const s = String(v || "").trim();
    if (!s) return "";
    if (!/^https?:\/\/[^\s]+$/.test(s)) throw new Error(`无效的 Webhook 地址: "${s.slice(0, 80)}"`);
    return s;
  };
  const parsedInterval = parseInt(src.minIntervalSeconds, 10);
  return {
    enabled: !!src.enabled,
    minIntervalSeconds: Math.min(86400, Math.max(0, Number.isFinite(parsedInterval) ? parsedInterval : 300)),
    notifyRecovery: src.notifyRecovery !== false,
    feishuWebhook: url(src.feishuWebhook),
    dingtalkWebhook: url(src.dingtalkWebhook),
    wecomWebhook: url(src.wecomWebhook),
    serverchanSendKey: String(src.serverchanSendKey || "").trim().slice(0, 120),
    barkServer: src.barkServer ? url(src.barkServer) : "",
    barkDeviceKey: String(src.barkDeviceKey || "").trim().slice(0, 200),
  };
}

  return {
    beijingTimeString,
    notifyAuditEvent,
    sendNotifierTest,
    sanitizeNotifierConfig,
    NOTIFY_SENDERS,
  };
}
