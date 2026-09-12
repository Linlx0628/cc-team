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
  return { db, stmts };
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
  const cutoffDailyModel = new Date(Date.now() - 400 * 24 * 3600 * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const tx = d.db.transaction(() => {
    d.stmts.pruneDailyModel.run(cutoffDailyModel);
    d.stmts.pruneHourlyModel.run(cutoffDailyModel);
    d.stmts.pruneDailyHourly.run(cutoff);
    d.stmts.pruneErrors.run(cutoff7d);
    d.stmts.pruneQuotaDailyOps.run(cutoff);
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
          .run(suffix, k, u.name||k.slice(0,8), u.totalInputTokens||0, u.totalOutputTokens||0, u.totalRequests||0, u.cacheCreationTokens||0, u.cacheReadTokens||0, u.lastActive||null);
      }
      for (const [date, ud] of Object.entries(ps.daily || {})) {
        for (const [k, v] of Object.entries(ud)) {
          // Imported history predates weighting → rate 1.0 (weighted = raw).
          d.db.prepare(`INSERT INTO usage_daily (profile,date,user_key,input_tokens,output_tokens,requests,cache_creation,cache_read,weighted_tokens) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(profile,date,user_key) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, requests=requests+excluded.requests, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read, weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
            .run(suffix, date, k, v.inputTokens||0, v.outputTokens||0, v.requests||0, v.cacheCreationTokens||0, v.cacheReadTokens||0, (v.inputTokens||0)+(v.outputTokens||0));
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
            .run(suffix, date, h, v.requests||0, v.inputTokens||0, v.outputTokens||0, v.cacheCreationTokens||0, v.cacheReadTokens||0);
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
            d.db.prepare(`INSERT INTO usage_daily_hourly (profile,date,user_key,hour,requests,input_tokens,output_tokens,cache_creation,cache_read,weighted_tokens) VALUES (?,?,?,?,?,?,?,?,?,?)
              ON CONFLICT(profile,date,user_key,hour) DO UPDATE SET requests=requests+excluded.requests, input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read, weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
              .run(suffix, date, k, h, v.requests||0, v.inputTokens||0, v.outputTokens||0, v.cacheCreationTokens||0, v.cacheReadTokens||0, (v.inputTokens||0)+(v.outputTokens||0));
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

const REQUEST_DATA_TABLES = ["users", "usage_daily", "usage_daily_model", "usage_daily_hourly", "usage_model", "usage_hourly", "errors", "quota_adjust_history", "quota_daily_ops"];

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
        .run(suffix, key, user.name || key.slice(0, 8), user.totalInputTokens || 0, user.totalOutputTokens || 0, user.totalRequests || 0, user.cacheCreationTokens || 0, user.cacheReadTokens || 0, user.lastActive || null);
    }
    for (const [date, rows] of Object.entries(ps.daily || {})) {
      for (const [key, row] of Object.entries(rows || {})) {
        // Imported history predates weighting → rate 1.0 (weighted = raw).
        d.db.prepare(`INSERT INTO usage_daily (profile,date,user_key,input_tokens,output_tokens,requests,cache_creation,cache_read,weighted_tokens) VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(profile,date,user_key) DO UPDATE SET input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
          requests=requests+excluded.requests, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read,
          weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
          .run(suffix, date, key, row.inputTokens || 0, row.outputTokens || 0, row.requests || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0, (row.inputTokens || 0) + (row.outputTokens || 0));
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
          .run(suffix, date, hour, row.requests || 0, row.inputTokens || 0, row.outputTokens || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0);
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
          d.db.prepare(`INSERT INTO usage_daily_hourly (profile,date,user_key,hour,requests,input_tokens,output_tokens,cache_creation,cache_read,weighted_tokens) VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(profile,date,user_key,hour) DO UPDATE SET requests=requests+excluded.requests, input_tokens=input_tokens+excluded.input_tokens,
            output_tokens=output_tokens+excluded.output_tokens, cache_creation=cache_creation+excluded.cache_creation, cache_read=cache_read+excluded.cache_read,
            weighted_tokens=weighted_tokens+excluded.weighted_tokens`)
            .run(suffix, date, key, hour, row.requests || 0, row.inputTokens || 0, row.outputTokens || 0, row.cacheCreationTokens || 0, row.cacheReadTokens || 0, (row.inputTokens || 0) + (row.outputTokens || 0));
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
    pruneOldDataIfNewDay,
    migrateFromJsonIfNeeded,
    clearRequestData,
    writeLegacyData,
    normalizeLegacyImportData,
    legacyImportHash,
    summarizeLegacyImport,
  };
}
