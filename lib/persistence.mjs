// lib/persistence.mjs —— SQLite 持久化:建表 / 列迁移 / 旧版 data.json 迁移 / 日常剪枝。
//
// db 与 stmts 是 server.mjs 的模块级共享句柄(那边有上百处直接引用),不随本模块搬走:
// 本模块通过注入的 getter 读同一个绑定,initDb() 把新建的句柄 return 回去,由 server.mjs
// 赋给它的 let。因此 initDb 内部用局部 const,其余函数走 d.db / d.stmts。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { cnDate } from "./time.mjs";
import { buildStatements } from "./db.mjs";

export function createPersistence(d) {
  const { config, dbPath, dataPath, backupDatabaseSync, normalizeProfileSuffix,
    resolvePoolName, getDefaultProfileSuffix } = d;

  // 存储口径对齐(2026-09-18,与 server.mjs recordUsage 同一套守卫):旧导出
  // (data.json / legacy JSON)的 usage 行是 raw 语义 —— responses 方案的
  // input_tokens 含缓存 slice。导入时剥掉,使历史数据与新写入的行同口径。
  const responsesSuffixes = new Set(Object.values(config.profiles || {})
    .filter(p => p.protocol === "responses" && p.suffix)
    .map(p => p.suffix));
  const alignedImportInput = (suffix, input, cacheRead) =>
    (responsesSuffixes.has(suffix) && cacheRead > 0 && cacheRead <= input) ? input - cacheRead : (input || 0);

function initDb() {
  const db = new Database(dbPath);
  d.db = db;   // 回填共享句柄: 迁移期的 backupDatabaseSync() 读的就是它
  db.pragma("journal_mode = WAL");      // crash-safe + concurrent reads don't block writes
  db.pragma("synchronous = NORMAL");    // WAL mode: safe against app crashes, fast
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      profile TEXT NOT NULL, user_key TEXT NOT NULL, name TEXT NOT NULL,
      total_input INTEGER DEFAULT 0, total_output INTEGER DEFAULT 0,
      total_requests INTEGER DEFAULT 0, cache_creation INTEGER DEFAULT 0,
      cache_read INTEGER DEFAULT 0, last_active TEXT,
      PRIMARY KEY (profile, user_key)
    );
    CREATE TABLE IF NOT EXISTS usage_daily (
      profile TEXT NOT NULL, date TEXT NOT NULL, user_key TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      requests INTEGER DEFAULT 0, cache_creation INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0,
      weighted_tokens INTEGER DEFAULT 0,
      PRIMARY KEY (profile, date, user_key)
    );
    CREATE TABLE IF NOT EXISTS usage_daily_model (
      profile TEXT NOT NULL, date TEXT NOT NULL, user_key TEXT NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, requests INTEGER DEFAULT 0,
      weighted_tokens INTEGER DEFAULT 0,
      PRIMARY KEY (profile, date, user_key, model)
    );
    CREATE TABLE IF NOT EXISTS usage_daily_hourly (
      profile TEXT NOT NULL, date TEXT NOT NULL, user_key TEXT NOT NULL, hour TEXT NOT NULL,
      requests INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_creation INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0,
      weighted_tokens INTEGER DEFAULT 0,
      PRIMARY KEY (profile, date, user_key, hour)
    );
    CREATE TABLE IF NOT EXISTS usage_model (
      profile TEXT NOT NULL, model TEXT NOT NULL,
      tokens INTEGER DEFAULT 0, requests INTEGER DEFAULT 0,
      PRIMARY KEY (profile, model)
    );
    CREATE TABLE IF NOT EXISTS usage_hourly (
      profile TEXT NOT NULL, date TEXT NOT NULL, hour TEXT NOT NULL,
      requests INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_creation INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0,
      PRIMARY KEY (profile, date, hour)
    );
    CREATE TABLE IF NOT EXISTS usage_hourly_model (
      profile TEXT NOT NULL, date TEXT NOT NULL, user_key TEXT NOT NULL,
      hour TEXT NOT NULL, model TEXT NOT NULL,
      requests INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_creation INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0,
      PRIMARY KEY (profile, date, user_key, hour, model)
    );
    -- 峰谷成本走小时表按 date 范围扫描,主键前缀 (profile,date,...) 不带 profile 前导时用不上
    CREATE INDEX IF NOT EXISTS idx_usage_hourly_model_date ON usage_hourly_model(date);
    CREATE INDEX IF NOT EXISTS idx_usage_daily_model_date ON usage_daily_model(date);
    -- 会话维度。上面七张 usage_* 表都没有会话标识,「某个会话烧了多少 token、缓存命中
    -- 多少」无法从它们推出,只能单开一张。
    -- 主键带 date 而不是只按 session:会话可能跨午夜,带 date 后按窗口求和是精确的,
    -- 不会把窗口外的轮次算进来;界面上再按 session 折叠一次即可。
    -- 只记有真实会话标识的请求 —— extractSessionSignal 回落到 "nosession" 时不落表,
    -- 否则所有人的无标识请求会挤进同一个假会话。缺的那部分由接口的 unattributed 如实披露。
    -- profile 进主键:缓存率的协议修正要逐方案判断(responses 协议把缓存读折进了
    -- input_tokens),折叠时必须还能按方案分开算,照 contextHealth 的做法。
    -- cache_creation 只有 Anthropic 一个来源(见 server.mjs recordUsage),OpenAI 系
    -- 协议恒为 0;缓存类比值一律用 cache_read 与 input 算,不要用这一列做分子。
    -- client 存原始信号(claude-cli / codex_cli_rs / unknown),展示层才映射可读名,
    -- 与 usage_daily_client.client 同约定。first-wins:冲突更新不碰这一列。
    -- 旧库经下方迁移补列,历史行为 NULL → 界面显示「—」。
    CREATE TABLE IF NOT EXISTS usage_session (
      profile TEXT NOT NULL, user_key TEXT NOT NULL, session TEXT NOT NULL, date TEXT NOT NULL,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      requests INTEGER DEFAULT 0, cache_creation INTEGER DEFAULT 0, cache_read INTEGER DEFAULT 0,
      client TEXT,
      PRIMARY KEY (profile, user_key, session, date)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_session_user_date ON usage_session(user_key, date);
    CREATE INDEX IF NOT EXISTS idx_usage_session_date ON usage_session(date);
    -- 客户端维度。协议(usage_* 的 profile 列)与客户端是两回事:Claude Code 和 zcode
    -- 都走 Anthropic 协议,zcode 还能走 OpenAI 协议,所以客户端推不出协议、协议也推不出
    -- 客户端,只能单开一轴。
    -- client 存解析出的原文 product token(claude-cli / codex_cli_rs / ...),不做枚举校验:
    -- 以后还会有没见过的客户端,写死白名单会把它们全归成「其他」。友好名只在展示层映射。
    -- 「未识别」存成 client='unknown' 的一行(与会话维度的 nosession 刻意相反):未识别本身
    -- 就是客户端这个问题的真实答案,不是凭空造出的假实体,所以表内合计 = 总量。
    -- 不带 cache 列 —— 与 usage_daily_model 一样,cache_creation 只有 Anthropic 一个来源。
    CREATE TABLE IF NOT EXISTS usage_daily_client (
      profile TEXT NOT NULL, date TEXT NOT NULL, user_key TEXT NOT NULL, client TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, requests INTEGER DEFAULT 0,
      weighted_tokens INTEGER DEFAULT 0,
      PRIMARY KEY (profile, date, user_key, client)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_daily_client_date ON usage_daily_client(date);
    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile TEXT NOT NULL, time TEXT NOT NULL,
      user_name TEXT, user_key TEXT, status_code INTEGER,
      error TEXT, path TEXT, model TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_errors_profile_time ON errors(profile, time);
    CREATE TABLE IF NOT EXISTS quota_adjust_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_key TEXT NOT NULL, user_name TEXT, date TEXT NOT NULL,
      old_quota INTEGER, new_quota INTEGER, hit_rate REAL,
      avg_daily_usage INTEGER, auto INTEGER DEFAULT 1, time TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS image_bridge_cache (
      hash TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quota_daily_ops (
      pool TEXT NOT NULL, user_key TEXT NOT NULL, date TEXT NOT NULL,
      bonus INTEGER NOT NULL DEFAULT 0,
      reset_baseline INTEGER NOT NULL DEFAULT 0,
      reset_time TEXT,
      updated_at TEXT,
      PRIMARY KEY (pool, user_key, date)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      detail TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(time);
    CREATE TABLE IF NOT EXISTS check_ins (
      user_key TEXT NOT NULL, date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      pools TEXT NOT NULL DEFAULT '[]',
      created_at TEXT,
      PRIMARY KEY (user_key, date)
    );
    CREATE TABLE IF NOT EXISTS quota_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_key TEXT NOT NULL,
      username TEXT,
      reason TEXT,
      amount INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT,
      created_at TEXT NOT NULL,
      handled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_quota_requests_user ON quota_requests(user_key, id);
    CREATE INDEX IF NOT EXISTS idx_quota_requests_status ON quota_requests(status, id);
  `);

  // ── Column migration: weighted_tokens (peak/off-peak quota weighting) ──
  // SQLite has no "ADD COLUMN IF NOT EXISTS", and this project has no versioned
  // migration framework — so probe table_info and add idempotently. MUST run
  // before db.prepare() below, since those statements reference the new column.
  //
  // Backfilling is not optional: an un-backfilled column reads as 0, which would
  // wipe every user's "used" figure the moment this ships and make quotas
  // unenforceable. rate 1.0 is the correct historical value — past usage was
  // never discounted.
  const weightedTargets = ["usage_daily", "usage_daily_hourly", "usage_daily_model"].filter(table => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.length > 0 && !cols.some(c => c.name === "weighted_tokens");
  });
  if (weightedTargets.length > 0) {
    // One-way schema change on live data: keep a pre-migration copy around.
    const backup = backupDatabaseSync("weighted-tokens-migration");
    if (backup) console.log(`[MIGRATE] Pre-migration backup: ${path.basename(backup)}`);
    const tx = db.transaction(() => {
      for (const table of weightedTargets) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN weighted_tokens INTEGER DEFAULT 0`);
        db.exec(`UPDATE ${table} SET weighted_tokens = input_tokens + output_tokens`);
      }
    });
    tx();
    console.log(`[MIGRATE] weighted_tokens added + backfilled: ${weightedTargets.join(", ")}`);
  }

  // ── Column migration: audit_log.category (explicit log-type separation) ──
  // Entries used to be classified by deriving actor/action prefixes at query
  // time — fine while every entry was admin or system. Member-facing actions
  // (check-in, quota requests) add log types that don't fit that dichotomy, so
  // the type becomes an explicit column. Legacy rows are backfilled with the
  // exact derivation the old queries used, so old filters stay equivalent.
  const auditCols = db.prepare("PRAGMA table_info(audit_log)").all().map(c => c.name);
  if (auditCols.length > 0 && !auditCols.includes("category")) {
    const backup = backupDatabaseSync("audit-category-migration");
    if (backup) console.log(`[MIGRATE] Pre-migration backup: ${path.basename(backup)}`);
    const tx = db.transaction(() => {
      db.exec("ALTER TABLE audit_log ADD COLUMN category TEXT NOT NULL DEFAULT 'admin'");
      db.exec("UPDATE audit_log SET category = 'auth' WHERE action LIKE 'auth.%'");
      db.exec("UPDATE audit_log SET category = 'system' WHERE actor = 'system' AND action NOT LIKE 'auth.%'");
    });
    tx();
    console.log("[MIGRATE] audit_log.category added + backfilled (admin/system/auth)");
  }

  // ── Column migration: quota_requests.pool (the member picks the pool) ──
  const qrCols = db.prepare("PRAGMA table_info(quota_requests)").all().map(c => c.name);
  if (qrCols.length > 0 && !qrCols.includes("pool")) {
    const backup = backupDatabaseSync("quota-request-pool-migration");
    if (backup) console.log(`[MIGRATE] Pre-migration backup: ${path.basename(backup)}`);
    const tx = db.transaction(() => {
      db.exec("ALTER TABLE quota_requests ADD COLUMN pool TEXT");
    });
    tx();
    console.log("[MIGRATE] quota_requests.pool added");
  }

  // ── Column migration: usage_hourly_model cache tokens (per-model cache peak pricing) ──
  // Peak-cost pricing needs cache_creation/cache_read at (hour, model) grain so the
  // hourly path can price cache writes/reads at peak vs base rates. Historical rows
  // are NOT backfilled — no hourly cache data was ever recorded. Cache columns read
  // as 0 for old rows, which falls into computeCosts' gap formula and prices that
  // cache at the daily blended base rate, exactly matching the pre-migration behavior.
  const hmCols = db.prepare("PRAGMA table_info(usage_hourly_model)").all().map(c => c.name);
  if (hmCols.length > 0 && (!hmCols.includes("cache_creation") || !hmCols.includes("cache_read"))) {
    const backup = backupDatabaseSync("hourly-model-cache-migration");
    if (backup) console.log(`[MIGRATE] Pre-migration backup: ${path.basename(backup)}`);
    const tx = db.transaction(() => {
      if (!hmCols.includes("cache_creation")) {
        db.exec("ALTER TABLE usage_hourly_model ADD COLUMN cache_creation INTEGER DEFAULT 0");
      }
      if (!hmCols.includes("cache_read")) {
        db.exec("ALTER TABLE usage_hourly_model ADD COLUMN cache_read INTEGER DEFAULT 0");
      }
    });
    tx();
    console.log("[MIGRATE] usage_hourly_model cache_creation/cache_read added (no backfill)");
  }

  // ── Column migration: usage_session.client (which client the session came from) ──
  // Client signal was only aggregated per day (usage_daily_client); the session flow
  // table needs it per session. NULL = recorded before this change (renders as —);
  // rows written after carry the raw signal (claude-cli / codex_cli_rs / unknown).
  const usCols = db.prepare("PRAGMA table_info(usage_session)").all().map(c => c.name);
  if (usCols.length > 0 && !usCols.includes("client")) {
    const backup = backupDatabaseSync("session-client-migration");
    if (backup) console.log(`[MIGRATE] Pre-migration backup: ${path.basename(backup)}`);
    const tx = db.transaction(() => {
      db.exec("ALTER TABLE usage_session ADD COLUMN client TEXT");
    });
    tx();
    console.log("[MIGRATE] usage_session.client added (no backfill)");
  }

  // ── Table migration: quota_daily_ops keyed by pool instead of profile ──
  // Manual daily ops (bonus / reset baseline) have to follow the allowance, which
  // now belongs to the pool: a bonus granted on one profile would otherwise leave
  // the user blocked on every other profile drawing from the same plan. SQLite
  // cannot change a primary key, so rebuild the table. Rows are folded by pool
  // with SUM on both counters — bonus is "extra allowance granted today" and
  // reset_baseline is "usage to ignore", and both are additive across the members
  // whose usage the pool now sums.
  const opCols = db.prepare("PRAGMA table_info(quota_daily_ops)").all().map(c => c.name);
  if (opCols.length > 0 && !opCols.includes("pool")) {
    const backup = backupDatabaseSync("quota-pool-migration");
    if (backup) console.log(`[MIGRATE] Pre-migration backup: ${path.basename(backup)}`);
    // profile suffix → pool name, from the config that was already migrated above.
    const suffixToPool = {};
    for (const [pname, p] of Object.entries(config.profiles || {})) {
      const sfx = normalizeProfileSuffix(p.suffix);
      if (sfx) suffixToPool[sfx] = resolvePoolName(pname);
    }
    const legacy = db.prepare("SELECT * FROM quota_daily_ops").all();
    const tx = db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS quota_daily_ops_legacy");
      db.exec("ALTER TABLE quota_daily_ops RENAME TO quota_daily_ops_legacy");
      db.exec(`CREATE TABLE quota_daily_ops (
        pool TEXT NOT NULL, user_key TEXT NOT NULL, date TEXT NOT NULL,
        bonus INTEGER NOT NULL DEFAULT 0,
        reset_baseline INTEGER NOT NULL DEFAULT 0,
        reset_time TEXT,
        updated_at TEXT,
        PRIMARY KEY (pool, user_key, date)
      )`);
      const ins = db.prepare(`INSERT INTO quota_daily_ops (pool,user_key,date,bonus,reset_baseline,reset_time,updated_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(pool,user_key,date) DO UPDATE SET
          bonus=bonus+excluded.bonus, reset_baseline=reset_baseline+excluded.reset_baseline,
          reset_time=COALESCE(excluded.reset_time,reset_time), updated_at=excluded.updated_at`);
      for (const r of legacy) {
        // A row whose profile no longer exists keeps its old key as the pool name
        // rather than being dropped — it expires by date on its own.
        const pool = suffixToPool[r.profile] || r.profile;
        ins.run(pool, r.user_key, r.date, r.bonus || 0, r.reset_baseline || 0, r.reset_time || null, r.updated_at || null);
      }
      db.exec("DROP TABLE quota_daily_ops_legacy");
    });
    tx();
    console.log(`[MIGRATE] quota_daily_ops rekeyed to pool (${legacy.length} row(s) folded)`);
  }


  const stmts = buildStatements(db);   // prepared statements (SQL moved to lib/db.mjs)
  d.stmts = stmts;
  migrateAlignUsageInput();
  return { db, stmts };
}

  // ── Data migration: usage input_tokens 口径对齐 (2026-09-18) ──
  // 旧行是 raw 语义:responses 方案的 input_tokens 含缓存 slice(cache_read 是其子集)。
  // recordUsage 已改为落库前剥掉该 slice(与 Anthropic 语义一致),contextHealth/sessions
  // 的读侧协议修正同步移除 —— 三者必须同批生效,所以历史行要在这里一次性对齐:
  //   · 有 cache_read 列的表:精确减,守卫与写侧一致(0 < cache_read <= input_tokens)
  //   · usage_daily_model:优先按 usage_hourly_model 的 (profile,date,user_key,model)
  //     精确扣;hourly 缓存列启用前的老行用天级比例回退(近似)
  //   · usage_daily_client:天级比例(无小时表对应物)
  //   · usage_model(profile,model 累计值,无日期):profile 级总比例
  // weighted_tokens / requests / cache 列一律不动 —— weighted 本来就是剥缓存后的计费值。
  // 幂等靠 kv_meta 标记;迁移前整库备份。抽成工厂级函数并导出:迁移测试需要
  // 「先 initDb 建表、再播种 raw 行、再触发迁移」,inline 在 initDb 里做不到。
  function migrateAlignUsageInput() {
    const db = d.db;
    const marker = db.prepare("SELECT value FROM kv_meta WHERE key='migrate:usage-input-align'").get();
    if (marker) return;
    const respSuffixes = Object.values(config.profiles || {})
      .filter(p => p.protocol === "responses" && p.suffix)
      .map(p => normalizeProfileSuffix(p.suffix))
      .filter(Boolean);
    if (respSuffixes.length === 0) {
      // 没有 responses 方案也要写标记:否则将来加了 Codex 方案,老库会被再次对齐
      db.prepare("INSERT INTO kv_meta (key, value) VALUES ('migrate:usage-input-align', ?)")
        .run(new Date().toISOString());
      return;
    }
    const ph = respSuffixes.map(() => "?").join(",");
    const run = (sql) => db.prepare(sql).run(...respSuffixes);
    // 迁移前快照 usage_daily 的 raw 值:天级比例回退要用原始 input/cache_read。
    // 快照表不带 WHERE 全量建(TEMP TABLE 不能绑定参数 —— db.exec 的 ? 是静默 NULL,
    // 会让所有 UPDATE 匹配 0 行,这是实测踩过的坑),比例子查询里按行内关联过滤即可。
    const backup = backupDatabaseSync("usage-input-align-migration");
    if (backup) console.log(`[MIGRATE] Pre-migration backup: ${path.basename(backup)}`);
    const tx = db.transaction(() => {
      db.exec(`CREATE TEMP TABLE _mig_daily AS
        SELECT profile, date, user_key, input_tokens, cache_read FROM usage_daily`);
      // 1) 有 cache 列的表:精确减
      for (const table of ["usage_daily", "usage_hourly", "usage_daily_hourly", "usage_hourly_model", "usage_session"]) {
        run(`UPDATE ${table} SET input_tokens = input_tokens - cache_read
          WHERE profile IN (${ph}) AND cache_read > 0 AND cache_read <= input_tokens`);
      }
      // 2) usage_daily_model:先按小时表精确扣(小时表在上一步已对齐,cache_read
      //    列本身可信,不再对 h.input_tokens 设守卫 —— 那会把已对齐行误判成异常),
      //    再对小时表完全没覆盖到的老行(小时缓存列启用前)用天级比例回退(近似)。
      //    两趟用 NOT EXISTS 互斥,防止同行被扣两次。
      run(`UPDATE usage_daily_model SET input_tokens = MAX(0, input_tokens - COALESCE((
          SELECT SUM(h.cache_read) FROM usage_hourly_model h
          WHERE h.profile = usage_daily_model.profile AND h.date = usage_daily_model.date
            AND h.user_key = usage_daily_model.user_key AND h.model = usage_daily_model.model
            AND h.cache_read > 0), 0))
        WHERE profile IN (${ph}) AND input_tokens > 0`);
      run(`UPDATE usage_daily_model SET input_tokens = MAX(0, input_tokens - CAST(ROUND(
          input_tokens * 1.0 * COALESCE((SELECT d.cache_read FROM _mig_daily d
            WHERE d.profile = usage_daily_model.profile AND d.date = usage_daily_model.date AND d.user_key = usage_daily_model.user_key
              AND d.input_tokens > 0), 0)
          / (1.0 * COALESCE((SELECT d.input_tokens FROM _mig_daily d
            WHERE d.profile = usage_daily_model.profile AND d.date = usage_daily_model.date AND d.user_key = usage_daily_model.user_key), 1))) AS INTEGER))
        WHERE profile IN (${ph}) AND input_tokens > 0
          AND NOT EXISTS (SELECT 1 FROM usage_hourly_model h
            WHERE h.profile = usage_daily_model.profile AND h.date = usage_daily_model.date
              AND h.user_key = usage_daily_model.user_key AND h.model = usage_daily_model.model
              AND h.cache_read > 0)`);
      // 3) usage_daily_client:天级比例(与 2 的回退同式)
      run(`UPDATE usage_daily_client SET input_tokens = MAX(0, input_tokens - CAST(ROUND(
          input_tokens * 1.0 * COALESCE((SELECT d.cache_read FROM _mig_daily d
            WHERE d.profile = usage_daily_client.profile AND d.date = usage_daily_client.date AND d.user_key = usage_daily_client.user_key
              AND d.input_tokens > 0), 0)
          / (1.0 * COALESCE((SELECT d.input_tokens FROM _mig_daily d
            WHERE d.profile = usage_daily_client.profile AND d.date = usage_daily_client.date AND d.user_key = usage_daily_client.user_key), 1))) AS INTEGER))
        WHERE profile IN (${ph}) AND input_tokens > 0`);
      // 4) usage_model:profile 级总比例(只统计通过守卫的行 —— cr>inp 的行本就不含折叠缓存)
      run(`UPDATE usage_model SET tokens = MAX(0, tokens - CAST(ROUND(
          tokens * 1.0 * COALESCE((SELECT SUM(d.cache_read) FROM _mig_daily d WHERE d.profile = usage_model.profile
              AND d.cache_read > 0 AND d.cache_read <= d.input_tokens), 0)
          / (1.0 * COALESCE((SELECT SUM(d.input_tokens) FROM _mig_daily d WHERE d.profile = usage_model.profile
              AND d.cache_read > 0 AND d.cache_read <= d.input_tokens), 1))) AS INTEGER))
        WHERE profile IN (${ph}) AND tokens > 0`);
      db.exec("DROP TABLE _mig_daily");
      db.prepare("INSERT INTO kv_meta (key, value) VALUES ('migrate:usage-input-align', ?)")
        .run(new Date().toISOString());
    });
    tx();
    console.log(`[MIGRATE] usage input_tokens aligned for responses profiles (${respSuffixes.join(", ")})`);
  }

// ── Pruning (called once a day via a lazy check) ──
let lastPruneDate = null;
function pruneOldDataIfNewDay() {
  const today = cnDate();
  if (lastPruneDate === today) return;
  lastPruneDate = today;
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const cutoff7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  // usage_daily_model feeds the period-switchable model distribution chart
  // (today/week/month/year in Beijing time); keep ~400 days so a full calendar
  // year plus cross-year weeks stays queryable. usage_hourly_model feeds the
  // 24h model trend chart with the same period windows, so it shares the cutoff.
  // usage_hourly 同样按 400 天清理(同期限);usage_daily_client 喂的是同一批可切周期的
  // 分布图,也跟 400 天。保留期不能低于约 380 天:读取端的
  // 下界 hourlyChartFloor 最远会指到「本年 1 月 1 日往前 14 天」,而 12 月 31 日那天
  // 距它正好 378 天 —— 缩短保留期会让「按年」窗口的最早几天先被删掉。
  const cutoffDailyModel = new Date(Date.now() - 400 * 24 * 3600 * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
  // 会话表是唯一按「会话 × 天」增长的表(量级远大于 usage_daily),跟 tool_events 一样
  // 保 90 天。两边必须同期限:项目分布要把 session 当连接键去 tool_events 找项目标签,
  // 一边先过期就会留下连不上项目的孤儿会话。
  const cutoff90d = new Date(Date.now() - 90 * 24 * 3600 * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const tx = d.db.transaction(() => {
    d.stmts.pruneDailyModel.run(cutoffDailyModel);
    d.stmts.pruneDailyClient.run(cutoffDailyModel);
    d.stmts.pruneHourlyModel.run(cutoffDailyModel);
    d.stmts.pruneHourly.run(cutoffDailyModel);
    d.stmts.pruneDailyHourly.run(cutoff);
    d.stmts.pruneErrors.run(cutoff7d);
    d.stmts.pruneQuotaDailyOps.run(cutoff);
    d.stmts.pruneUsageSession.run(cutoff90d);
  });
  tx();
}

// ── Migration: data.json → SQLite tables (one-time, idempotent) ──
function migrateFromJsonIfNeeded() {
  const { c } = d.db.prepare("SELECT COUNT(*) AS c FROM users").get();
  if (c > 0) return;  // already has data
  if (!fs.existsSync(dataPath)) return;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(dataPath, "utf-8")); }
  catch (err) { console.error("[MIGRATE] data.json 读取失败:", err.message); return; }

  console.log("[MIGRATE] 从 data.json 迁移到 SQLite 多表...");
  const profiles = raw._profiles || {};
  // Legacy top-level data maps to the default profile suffix.
  const defaultSuffix = getDefaultProfileSuffix();
  const hasTopLevel = ["users","daily","dailyModels","dailyHourly","models","hourly","errors"]
    .some(k => Array.isArray(raw[k]) ? raw[k].length > 0 : Object.keys(raw[k] || {}).length > 0);
  if (hasTopLevel && defaultSuffix && !profiles[defaultSuffix]) {
    profiles[defaultSuffix] = { users: raw.users||{}, daily: raw.daily||{}, dailyModels: raw.dailyModels||{}, dailyHourly: raw.dailyHourly||{}, models: raw.models||{}, hourly: raw.hourly||{}, errors: raw.errors||[] };
  }

  const tx = d.db.transaction(() => {
    for (const [suffix, ps] of Object.entries(profiles)) {
      for (const [k, u] of Object.entries(ps.users || {})) {
        d.db.prepare(`INSERT INTO users (profile,user_key,name,total_input,total_output,total_requests,cache_creation,cache_read,last_active)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(profile,user_key) DO UPDATE SET
            total_input=total_input+excluded.total_input, total_output=total_output+excluded.total_output,
            total_requests=total_requests+excluded.total_requests, cache_creation=cache_creation+excluded.cache_creation,
            cache_read=cache_read+excluded.cache_read, last_active=excluded.last_active`)
          .run(suffix, k, u.name||k.slice(0,8), alignedImportInput(suffix, u.totalInputTokens, u.cacheReadTokens||0), u.totalOutputTokens||0, u.totalRequests||0, u.cacheCreationTokens||0, u.cacheReadTokens||0, u.lastActive||null);
      }
      for (const [date, ud] of Object.entries(ps.daily || {})) {
        for (const [k, v] of Object.entries(ud)) {
          // Imported history predates weighting → rate 1.0 (weighted = raw,已按新口径对齐).
          const inAligned = alignedImportInput(suffix, v.inputTokens, v.cacheReadTokens||0);
          d.db.prepare(`INSERT INTO usage_daily (profile,date,user_key,input_tokens,output_tokens,requests,cache_creation,cache_read,weighted_tokens) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(profile,date,user_key) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, requests=requests+excluded.requests, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read, weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
            .run(suffix, date, k, inAligned, v.outputTokens||0, v.requests||0, v.cacheCreationTokens||0, v.cacheReadTokens||0, inAligned+(v.outputTokens||0));
        }
      }
      for (const [m, v] of Object.entries(ps.models || {})) {
        d.db.prepare(`INSERT INTO usage_model (profile,model,tokens,requests) VALUES (?,?,?,?)
          ON CONFLICT(profile,model) DO UPDATE SET tokens=tokens+excluded.tokens, requests=requests+excluded.requests`)
          .run(suffix, m, v.tokens||0, v.requests||0);
      }
      for (const [date, hd] of Object.entries(ps.hourly || {})) {
        for (const [h, v] of Object.entries(hd)) {
          d.db.prepare(`INSERT INTO usage_hourly (profile,date,hour,requests,input_tokens,output_tokens,cache_creation,cache_read) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(profile,date,hour) DO UPDATE SET requests=requests+excluded.requests, input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read`)
            .run(suffix, date, h, v.requests||0, alignedImportInput(suffix, v.inputTokens, v.cacheReadTokens||0), v.outputTokens||0, v.cacheCreationTokens||0, v.cacheReadTokens||0);
        }
      }
      for (const [date, dm] of Object.entries(ps.dailyModels || {})) {
        for (const [k, models] of Object.entries(dm)) {
          for (const [m, v] of Object.entries(models)) {
            d.db.prepare(`INSERT INTO usage_daily_model (profile,date,user_key,model,input_tokens,output_tokens,requests,weighted_tokens) VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT(profile,date,user_key,model) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, requests=requests+excluded.requests, weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
              .run(suffix, date, k, m, v.inputTokens||0, v.outputTokens||0, v.requests||0, (v.inputTokens||0)+(v.outputTokens||0));
          }
        }
      }
      for (const [date, dh] of Object.entries(ps.dailyHourly || {})) {
        for (const [k, hours] of Object.entries(dh)) {
          for (const [h, v] of Object.entries(hours)) {
            const dhAligned = alignedImportInput(suffix, v.inputTokens, v.cacheReadTokens||0);
            d.db.prepare(`INSERT INTO usage_daily_hourly (profile,date,user_key,hour,requests,input_tokens,output_tokens,cache_creation,cache_read,weighted_tokens) VALUES (?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(profile,date,user_key,hour) DO UPDATE SET requests=requests+excluded.requests, input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read, weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
              .run(suffix, date, k, h, v.requests||0, dhAligned, v.outputTokens||0, v.cacheCreationTokens||0, v.cacheReadTokens||0, dhAligned+(v.outputTokens||0));
          }
        }
      }
      for (const e of (ps.errors || [])) {
        d.stmts.insertError.run({ profile: suffix, time: e.time, userName: e.user, key: e.userKey, statusCode: e.statusCode, error: e.error, path: e.path, model: e.model });
      }
    }
    // Global: quotaAdjustHistory
    for (const h of (raw.quotaAdjustHistory || [])) {
      d.stmts.insertQuotaAdjust.run({ user: h.user, username: h.username, date: h.date, oldQuota: h.oldQuota, newQuota: h.newQuota, hitRate: h.hitRate, avgDailyUsage: h.avgDailyUsage, time: (h.date||new Date().toISOString())+"T00:00:00.000Z" });
    }
    // Global: _lastQuotaEval
    if (raw._lastQuotaEval) d.stmts.upsertMeta.run({ k: "lastQuotaEval", v: raw._lastQuotaEval });
  });
  tx();

  try {
    fs.renameSync(dataPath, dataPath + ".migrated");
    console.log("[MIGRATE] data.json 已重命名为 data.json.migrated（SQLite 多表已接管持久化）");
  } catch (err) {
    console.warn("[MIGRATE] data.json 重命名失败（不影响已迁移的数据）:", err.message);
  }
}

const REQUEST_DATA_TABLES = ["users", "usage_daily", "usage_daily_model", "usage_daily_client", "usage_daily_hourly", "usage_model", "usage_hourly", "usage_session", "errors", "quota_adjust_history", "quota_daily_ops"];

function legacyProfileData(raw = {}) {
  return {
    users: raw.users || {},
    daily: raw.daily || {},
    dailyModels: raw.dailyModels || {},
    dailyHourly: raw.dailyHourly || {},
    models: raw.models || {},
    hourly: raw.hourly || {},
    errors: Array.isArray(raw.errors) ? raw.errors : [],
  };
}

function normalizeLegacyImportData(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("data.json 顶层必须是对象");
  if (raw._profiles !== undefined && (!raw._profiles || typeof raw._profiles !== "object" || Array.isArray(raw._profiles))) {
    throw new Error("_profiles 必须是对象");
  }
  const profiles = {};
  for (const [suffix, value] of Object.entries(raw._profiles || {})) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`方案 ${suffix} 的数据格式无效`);
    profiles[String(suffix)] = legacyProfileData(value);
  }
  const topLevelFields = ["users", "daily", "dailyModels", "dailyHourly", "models", "hourly", "errors"];
  const hasTopLevel = topLevelFields.some((key) => Array.isArray(raw[key]) ? raw[key].length > 0 : Object.keys(raw[key] || {}).length > 0);
  if (hasTopLevel) {
    let source = getDefaultProfileSuffix() || "default";
    if (profiles[source]) source = "top-level";
    profiles[source] = legacyProfileData(raw);
  }
  if (Object.keys(profiles).length === 0) throw new Error("文件中没有可导入的统计数据");
  return {
    profiles,
    quotaAdjustHistory: Array.isArray(raw.quotaAdjustHistory) ? raw.quotaAdjustHistory : [],
    lastQuotaEval: raw._lastQuotaEval || null,
  };
}

function legacyImportHash(raw) {
  return crypto.createHash("sha256").update(JSON.stringify(raw)).digest("hex");
}

function summarizeLegacyImport(normalized) {
  const userKeys = new Set();
  const dates = new Set();
  let requests = 0;
  let records = 0;
  for (const ps of Object.values(normalized.profiles)) {
    let profileRequests = 0;
    let dailyRequests = 0;
    for (const [key, user] of Object.entries(ps.users || {})) {
      userKeys.add(key);
      profileRequests += Number(user.totalRequests) || 0;
      records++;
    }
    for (const [date, rows] of Object.entries(ps.daily || {})) {
      dates.add(date);
      for (const [key, row] of Object.entries(rows || {})) {
        userKeys.add(key);
        dailyRequests += Number(row.requests) || 0;
        records++;
      }
    }
    requests += profileRequests || dailyRequests;
    for (const date of Object.keys(ps.dailyModels || {})) dates.add(date);
    for (const date of Object.keys(ps.dailyHourly || {})) dates.add(date);
    for (const date of Object.keys(ps.hourly || {})) dates.add(date);
    records += Object.keys(ps.models || {}).length + (ps.errors || []).length;
  }
  const orderedDates = [...dates].filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort();
  return {
    users: userKeys.size,
    requests,
    records,
    minDate: orderedDates[0] || null,
    maxDate: orderedDates.at(-1) || null,
  };
}

function writeLegacyData(normalized, profileMap) {
  for (const [sourceSuffix, ps] of Object.entries(normalized.profiles)) {
    const suffix = normalizeProfileSuffix(profileMap[sourceSuffix]);
    if (!suffix) continue;
    for (const [key, user] of Object.entries(ps.users || {})) {
      d.db.prepare(`INSERT INTO users (profile,user_key,name,total_input,total_output,total_requests,cache_creation,cache_read,last_active)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(profile,user_key) DO UPDATE SET
          name=excluded.name, total_input=total_input+excluded.total_input, total_output=total_output+excluded.total_output,
          total_requests=total_requests+excluded.total_requests, cache_creation=cache_creation+excluded.cache_creation,
          cache_read=cache_read+excluded.cache_read, last_active=excluded.last_active`)
        .run(suffix, key, user.name || key.slice(0, 8), alignedImportInput(suffix, user.totalInputTokens, user.cacheReadTokens || 0), user.totalOutputTokens || 0, user.totalRequests || 0, user.cacheCreationTokens || 0, user.cacheReadTokens || 0, user.lastActive || null);
    }
    for (const [date, rows] of Object.entries(ps.daily || {})) {
      for (const [key, row] of Object.entries(rows || {})) {
        // Imported history predates weighting → rate 1.0 (weighted = raw,已按新口径对齐).
        const dailyIn = alignedImportInput(suffix, row.inputTokens, row.cacheReadTokens || 0);
        d.db.prepare(`INSERT INTO usage_daily (profile,date,user_key,input_tokens,output_tokens,requests,cache_creation,cache_read,weighted_tokens) VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(profile,date,user_key) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
          requests=requests+excluded.requests, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read,
          weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
          .run(suffix, date, key, dailyIn, row.outputTokens || 0, row.requests || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0, dailyIn + (row.outputTokens || 0));
      }
    }
    for (const [model, row] of Object.entries(ps.models || {})) {
      d.db.prepare(`INSERT INTO usage_model (profile,model,tokens,requests) VALUES (?,?,?,?)
        ON CONFLICT(profile,model) DO UPDATE SET tokens=tokens+excluded.tokens, requests=requests+excluded.requests`)
        .run(suffix, model, row.tokens || 0, row.requests || 0);
    }
    for (const [date, hours] of Object.entries(ps.hourly || {})) {
      for (const [hour, row] of Object.entries(hours || {})) {
        d.db.prepare(`INSERT INTO usage_hourly (profile,date,hour,requests,input_tokens,output_tokens,cache_creation,cache_read) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(profile,date,hour) DO UPDATE SET requests=requests+excluded.requests, input_tokens=input_tokens+excluded.input_tokens,
          output_tokens=output_tokens+excluded.output_tokens, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read`)
          .run(suffix, date, hour, row.requests || 0, alignedImportInput(suffix, row.inputTokens, row.cacheReadTokens || 0), row.outputTokens || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0);
      }
    }
    for (const [date, users] of Object.entries(ps.dailyModels || {})) {
      for (const [key, models] of Object.entries(users || {})) {
        for (const [model, row] of Object.entries(models || {})) {
          d.db.prepare(`INSERT INTO usage_daily_model (profile,date,user_key,model,input_tokens,output_tokens,requests,weighted_tokens) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(profile,date,user_key,model) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens,
            output_tokens=output_tokens+excluded.output_tokens, requests=requests+excluded.requests,
            weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
            .run(suffix, date, key, model, row.inputTokens || 0, row.outputTokens || 0, row.requests || 0, (row.inputTokens || 0) + (row.outputTokens || 0));
        }
      }
    }
    for (const [date, users] of Object.entries(ps.dailyHourly || {})) {
      for (const [key, hours] of Object.entries(users || {})) {
        for (const [hour, row] of Object.entries(hours || {})) {
          const dhIn = alignedImportInput(suffix, row.inputTokens, row.cacheReadTokens || 0);
          d.db.prepare(`INSERT INTO usage_daily_hourly (profile,date,user_key,hour,requests,input_tokens,output_tokens,cache_creation,cache_read,weighted_tokens) VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(profile,date,user_key,hour) DO UPDATE SET requests=requests+excluded.requests, input_tokens=input_tokens+excluded.input_tokens,
            output_tokens=output_tokens+excluded.output_tokens, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read,
            weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
            .run(suffix, date, key, hour, row.requests || 0, dhIn, row.outputTokens || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0, dhIn + (row.outputTokens || 0));
        }
      }
    }
    for (const error of ps.errors || []) {
      d.stmts.insertError.run({
        profile: suffix,
        time: error.time || new Date().toISOString(),
        userName: error.user || error.userName || "",
        key: error.userKey || "unknown",
        statusCode: error.statusCode || 0,
        error: error.error || "",
        path: error.path || "",
        model: error.model || "unknown",
      });
    }
  }
  for (const row of normalized.quotaAdjustHistory || []) {
    const date = row.date || cnDate();
    d.stmts.insertQuotaAdjust.run({
      user: row.user || row.userKey || "unknown",
      username: row.username || row.userName || "",
      date,
      oldQuota: row.oldQuota || 0,
      newQuota: row.newQuota || 0,
      hitRate: row.hitRate || 0,
      avgDailyUsage: row.avgDailyUsage || 0,
      time: row.time || `${date}T00:00:00.000Z`,
    });
  }
  if (normalized.lastQuotaEval) d.stmts.upsertMeta.run({ k: "lastQuotaEval", v: normalized.lastQuotaEval });
}

function clearRequestData() {
  for (const table of REQUEST_DATA_TABLES) d.db.prepare(`DELETE FROM ${table}`).run();
  d.db.prepare("DELETE FROM kv_meta").run();
}

  return {
    initDb,
    migrateAlignUsageInput,   // 导出供迁移测试单独触发(生产路径由 initDb 末尾调用)
    pruneOldDataIfNewDay,
    migrateFromJsonIfNeeded,
    clearRequestData,
    writeLegacyData,
    normalizeLegacyImportData,
    legacyImportHash,
    summarizeLegacyImport,
  };
}
