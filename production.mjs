// production.mjs —— 文件头 + 本任务增量;后续任务在同文件追加
const SCAN_LIMIT = 5000;
const CURSOR_LIMIT = 500;
export const FILE_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch"];

export function initProductionDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL, user_key TEXT NOT NULL, user_name TEXT, profile TEXT, session TEXT,
      tool_id TEXT NOT NULL, tool TEXT NOT NULL, file_path TEXT, ext TEXT,
      lines_add INTEGER DEFAULT 0, lines_del INTEGER DEFAULT 0,
      outcome TEXT DEFAULT 'pending', error_kind TEXT, cmd_class TEXT, model TEXT,
      UNIQUE(tool_id) ON CONFLICT IGNORE
    );
    CREATE INDEX IF NOT EXISTS idx_tool_events_user_time ON tool_events(user_key, time);
    CREATE INDEX IF NOT EXISTS idx_tool_events_time ON tool_events(time);
    CREATE TABLE IF NOT EXISTS production_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL, user_key TEXT NOT NULL, user_name TEXT, kind TEXT NOT NULL,
      detail TEXT, seen INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_prod_alerts_time ON production_alerts(time);
  `);
}

export function createProductionTracker({ db, getConfig, log = console.log, now = () => new Date().toISOString() }) {
  const cursors = new Map();
  function observe(info) {
    try {
      const cfg = (getConfig && getConfig()) || {};
      if (cfg.enabled === false || !info || !info.parsed) return;
      const t0 = process.hrtime.bigint();
      parseAndStore(info, cfg);            // Task 2-4 实现;本任务先留空函数
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (ms > 5) log(`[production] 慢解析 ${ms.toFixed(1)}ms session=${info.session} user=${info.userKey}`);
    } catch (err) {
      log(`[production] 解析异常已忽略: ${err?.message}`);
    }
  }
  function parseAndStore(_info, _cfg) {}   // 占位,Task 4 替换
  function scanAlerts(_thresholds, _now) { return []; }   // Task 7 替换
  function maybePrune() {}                                 // Task 7 替换
  return { observe, scanAlerts, maybePrune, cursors };
}
