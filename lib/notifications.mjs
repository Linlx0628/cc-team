// lib/notifications.mjs —— 管理员系统通知（站内信）。
//
// 范式与 member_notify / quota_requests 一致：user_key 键控的小表，存库不进 config.json
// （管理员保存用户时按白名单整体重建 config.users，塞进去的自定义字段会被静默丢掉）。
//
// 生命周期：草稿(draft) --发布--> 已发布(published) --撤回--> 草稿。只有 published 的
// 通知对成员可见；撤回后从成员铃铛里消失，已读记录保留（重新发布后不重置已读 ——
// 想让所有人重新看到未读，复制一条新通知更符合直觉）。
//
// 定向投递在读取端用 JS 过滤而不是 SQL json_each：一是目标名单本来就是几十行的小表，
// 全量取出无压力（findByEmail 同款先例）；二是免赌 better-sqlite3 编译时是否带 JSON1。

export function initNotificationsDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'all',
      target_keys TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      published_at TEXT,
      created_by TEXT
    );
    CREATE TABLE IF NOT EXISTS notification_reads (
      notification_id INTEGER NOT NULL,
      user_key TEXT NOT NULL,
      read_at TEXT NOT NULL,
      PRIMARY KEY (notification_id, user_key)
    );
  `);
}

const TITLE_MAX = 100;
const CONTENT_MAX = 20000;

// 管理端输入清洗。title/content 只裁长度不做别的（markdown 渲染在客户端，先 escape 再
// 变换，安全性不依赖这里的清洗）；targetKeys 过滤空串并去重。
function normalizeInput({ title, content, targetType, targetKeys }) {
  const t = String(title || "").trim();
  if (!t) throw new Error("标题不能为空");
  if (t.length > TITLE_MAX) throw new Error(`标题过长（最多 ${TITLE_MAX} 字）`);
  const c = String(content || "").trim();
  if (!c) throw new Error("正文不能为空");
  if (c.length > CONTENT_MAX) throw new Error(`正文过长（最多 ${CONTENT_MAX} 字）`);
  const type = targetType === "user" ? "user" : "all";
  let keys = [];
  if (type === "user") {
    keys = [...new Set((Array.isArray(targetKeys) ? targetKeys : [])
      .map(k => String(k || "").trim()).filter(Boolean))];
    if (keys.length === 0) throw new Error("定向通知至少选择一位用户");
  }
  return { title: t, content: c, targetType: type, targetKeys: keys };
}

function rowToNotification(row) {
  let keys = [];
  try { keys = JSON.parse(row.target_keys || "[]"); } catch { keys = []; }
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    targetType: row.target_type,
    targetKeys: keys,
    status: row.status,
    createdAt: row.created_at,
    publishedAt: row.published_at || null,
    createdBy: row.created_by || "",
  };
}

// 是否投递给某个成员：全员通知恒命中；定向通知按名单精确匹配 user_key。
function targetsUser(n, userKey) {
  return n.targetType === "all" || n.targetKeys.includes(userKey);
}

export function createNotifications(d) {
  const db = () => d.db;

  // ── 管理端 ──
  function listAll() {
    return db().prepare("SELECT * FROM notifications ORDER BY id DESC").all().map(rowToNotification);
  }

  function get(id) {
    const row = db().prepare("SELECT * FROM notifications WHERE id=?").get(Number(id));
    return row ? rowToNotification(row) : null;
  }

  function create({ title, content, targetType, targetKeys }, createdBy = "") {
    const n = normalizeInput({ title, content, targetType, targetKeys });
    db().prepare(`INSERT INTO notifications (title, content, target_type, target_keys, status, created_at, created_by)
      VALUES (@title, @content, @type, @keys, 'draft', @now, @by)`)
      .run({ title: n.title, content: n.content, type: n.targetType, keys: JSON.stringify(n.targetKeys), now: new Date().toISOString(), by: String(createdBy || "") });
    return db().prepare("SELECT last_insert_rowid() AS id").get().id;
  }

  // 只允许改草稿：已发布的通知有人读过，就地改文案会让「已读」失去含义。
  // 想改已发布的 → 先撤回。
  function update(id, { title, content, targetType, targetKeys }) {
    const cur = get(id);
    if (!cur) throw new Error("通知不存在");
    if (cur.status !== "draft") throw new Error("只能编辑草稿（已发布的请先撤回）");
    const n = normalizeInput({ title, content, targetType, targetKeys });
    db().prepare(`UPDATE notifications SET title=@title, content=@content, target_type=@type, target_keys=@keys WHERE id=@id`)
      .run({ title: n.title, content: n.content, type: n.targetType, keys: JSON.stringify(n.targetKeys), id: Number(id) });
    return get(id);
  }

  function publish(id) {
    const cur = get(id);
    if (!cur) throw new Error("通知不存在");
    if (cur.status === "published") throw new Error("该通知已是发布状态");
    db().prepare("UPDATE notifications SET status='published', published_at=? WHERE id=?")
      .run(new Date().toISOString(), Number(id));
    return get(id);
  }

  function unpublish(id) {
    const cur = get(id);
    if (!cur) throw new Error("通知不存在");
    if (cur.status !== "published") throw new Error("该通知不是发布状态");
    db().prepare("UPDATE notifications SET status='draft' WHERE id=?").run(Number(id));
    return get(id);
  }

  function remove(id) {
    const cur = get(id);
    if (!cur) throw new Error("通知不存在");
    const tx = db().transaction(() => {
      db().prepare("DELETE FROM notifications WHERE id=?").run(Number(id));
      db().prepare("DELETE FROM notification_reads WHERE notification_id=?").run(Number(id));
    });
    tx();
    return cur;
  }

  // ── 成员端 ──
  // 已发布且投给我的通知，带 readAt。全员+定向合并后按发布时间倒序。
  function forUser(userKey) {
    const key = String(userKey || "");
    if (!key) return [];
    const reads = new Map(
      db().prepare("SELECT notification_id, read_at FROM notification_reads WHERE user_key=?").all(key)
        .map(r => [r.notification_id, r.read_at]));
    return listAll()
      .filter(n => n.status === "published" && targetsUser(n, key))
      .map(n => ({ id: n.id, title: n.title, content: n.content, publishedAt: n.publishedAt, readAt: reads.get(n.id) || null }))
      .sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")));
  }

  function unreadCount(userKey) {
    return forUser(userKey).filter(n => !n.readAt).length;
  }

  function markRead(userKey, ids) {
    const key = String(userKey || "");
    if (!key) return 0;
    const mine = new Set(forUser(key).map(n => n.id));   // 只允许标自己的
    const want = (Array.isArray(ids) ? ids : []).map(Number).filter(id => mine.has(id));
    if (want.length === 0) return 0;
    const now = new Date().toISOString();
    const ins = db().prepare(`INSERT INTO notification_reads (notification_id, user_key, read_at) VALUES (?,?,?)
      ON CONFLICT(notification_id, user_key) DO NOTHING`);
    const tx = db().transaction(() => { for (const id of want) ins.run(id, key, now); });
    tx();
    return want.length;
  }

  function markAllRead(userKey) {
    const key = String(userKey || "");
    if (!key) return 0;
    return markRead(key, forUser(key).filter(n => !n.readAt).map(n => n.id));
  }

  return { listAll, get, create, update, publish, unpublish, remove, forUser, unreadCount, markRead, markAllRead };
}
