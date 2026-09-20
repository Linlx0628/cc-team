// lib/member-notify.mjs —— 成员**自助**的通知渠道配置(存在库里,不在 config.json)。
//
// 为什么不塞 config.users[key]:管理员保存用户时是按固定 4 字段白名单**整体重建**
// config.users 的(lib/settings-write.mjs),成员自己加的任何字段都会被下一次保存静默丢掉。
// 而「成员自助数据落库」是本项目既有范式(check_ins / quota_requests 都是 user_key 键控的小表)。
//
// 存的是**凭据**(webhook 地址、SendKey、邮箱),与其它密钥同级别:
//   · 对外只回掩码(hasXxx + hint),永不回原文
//   · 写入时空串 = 不修改(与代码评审凭据同款约定)
import { maskCredential } from "./code-review.mjs";

// 成员可配的字段(与管理员那套渠道同名,便于复用发送实现)
const CHANNEL_FIELDS = [
  "feishuWebhook", "dingtalkWebhook", "wecomWebhook",
  "serverchanSendKey", "barkDeviceKey", "barkServer",
  "email",
];
const FIELD_MAX = { feishuWebhook: 500, dingtalkWebhook: 500, wecomWebhook: 500, serverchanSendKey: 200, barkDeviceKey: 200, barkServer: 300, email: 200 };

export function initMemberNotifyDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS member_notify (
      user_key TEXT PRIMARY KEY,
      enabled INTEGER DEFAULT 1,
      feishu_webhook TEXT, dingtalk_webhook TEXT, wecom_webhook TEXT,
      serverchan_send_key TEXT, bark_device_key TEXT, bark_server TEXT,
      email TEXT,
      last_seen_review_at TEXT,
      updated_at TEXT
    );
  `);
}

// DB 列名 ↔ JS 字段名(snake ↔ camel)。手写映射而不是自动转换,免得哪天加个字段
// 因为命名不一致而静默读不到。
const COLS = {
  feishuWebhook: "feishu_webhook",
  dingtalkWebhook: "dingtalk_webhook",
  wecomWebhook: "wecom_webhook",
  serverchanSendKey: "serverchan_send_key",
  barkDeviceKey: "bark_device_key",
  barkServer: "bark_server",
  email: "email",
};

export function createMemberNotify(d) {
  const db = () => d.db;

  // 读一条(内部用:含明文,只交给发送逻辑)
  function get(userKey) {
    const key = String(userKey || "");
    if (!key) return null;
    const row = db().prepare("SELECT * FROM member_notify WHERE user_key=?").get(key);
    if (!row) return null;
    const out = { enabled: row.enabled !== 0, lastSeenReviewAt: row.last_seen_review_at || null };
    for (const [js, col] of Object.entries(COLS)) out[js] = row[col] || "";
    return out;
  }

  // 给界面的**脱敏**视图:只告诉「配没配」和末 4 位,原文不出库
  function masked(userKey) {
    const cur = get(userKey) || { enabled: true };
    const out = { enabled: cur.enabled !== false, lastSeenReviewAt: cur.lastSeenReviewAt || null };
    for (const f of CHANNEL_FIELDS) {
      const v = String(cur[f] || "");
      out[f] = { has: !!v, hint: v ? maskCredential(v).hint : "" };
    }
    return out;
  }

  // 写入。patch 里**空串/undefined = 不修改**(界面回显的是掩码,不回传就不该被清空);
  // 想真正清掉某个字段传 null。
  function save(userKey, patch = {}) {
    const key = String(userKey || "");
    if (!key) throw new Error("缺少 user_key");
    const cur = get(key) || { enabled: true };
    const next = { enabled: patch.enabled === undefined ? cur.enabled !== false : !!patch.enabled };
    for (const f of CHANNEL_FIELDS) {
      const v = patch[f];
      const old = String(cur[f] || "");
      if (v === null) next[f] = "";
      else if (v === undefined || String(v).trim() === "") next[f] = old;   // 空 = 保留
      else next[f] = String(v).trim().slice(0, FIELD_MAX[f] || 200);
    }
    db().prepare(`INSERT INTO member_notify (user_key, enabled, feishu_webhook, dingtalk_webhook, wecom_webhook,
        serverchan_send_key, bark_device_key, bark_server, email, updated_at)
      VALUES (@user_key, @enabled, @feishu_webhook, @dingtalk_webhook, @wecom_webhook,
        @serverchan_send_key, @bark_device_key, @bark_server, @email, @updated_at)
      ON CONFLICT(user_key) DO UPDATE SET
        enabled=excluded.enabled, feishu_webhook=excluded.feishu_webhook, dingtalk_webhook=excluded.dingtalk_webhook,
        wecom_webhook=excluded.wecom_webhook, serverchan_send_key=excluded.serverchan_send_key,
        bark_device_key=excluded.bark_device_key, bark_server=excluded.bark_server, email=excluded.email,
        updated_at=excluded.updated_at`)
      .run({
        user_key: key,
        enabled: next.enabled ? 1 : 0,
        feishu_webhook: next.feishuWebhook || "", dingtalk_webhook: next.dingtalkWebhook || "",
        wecom_webhook: next.wecomWebhook || "", serverchan_send_key: next.serverchanSendKey || "",
        bark_device_key: next.barkDeviceKey || "", bark_server: next.barkServer || "",
        email: next.email || "",
        updated_at: new Date().toISOString(),
      });
    return masked(key);
  }

  // 小红点用的「已读」时刻:成员打开评审分区时调用
  function markSeen(userKey, at = new Date().toISOString()) {
    const key = String(userKey || "");
    if (!key) return;
    db().prepare(`INSERT INTO member_notify (user_key, last_seen_review_at, updated_at)
      VALUES (?,?,?) ON CONFLICT(user_key) DO UPDATE SET last_seen_review_at=excluded.last_seen_review_at, updated_at=excluded.updated_at`)
      .run(key, at, at);
  }

  function lastSeen(userKey) {
    const row = db().prepare("SELECT last_seen_review_at FROM member_notify WHERE user_key=?").get(String(userKey || ""));
    return row?.last_seen_review_at || null;
  }

  return { get, masked, save, markSeen, lastSeen };
}
