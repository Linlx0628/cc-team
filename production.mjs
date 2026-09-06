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

// —— Task 2: Anthropic 协议增量解析(纯函数,无 db 访问)——
function lineCount(s) { s = String(s ?? ""); return s.length ? s.split("\n").length : 0; }
function extOf(p) { const m = String(p || "").match(/(\.[A-Za-z0-9]+)$/); return m ? m[1].toLowerCase() : null; }

const CMD_CLASS = [
  ["test", /(^|[/\s])(pytest|vitest|jest|mocha|playwright|go test|cargo test)|(^|[\s&;|])(.*test[^&;|]*$)/i],
  ["lint", /eslint|biome|prettier|flake8|ruff|stylelint|lint/i],
  ["build", /(^|[\s&;|])(make|gradle)(\s|$)|webpack|rollup|vite build|cargo build|tsc(\s|$)|npm run build/i],
  ["git", /(^|\s)git(\s|$)/],
];
export function classifyCommand(cmd) {
  const c = String(cmd || "");
  for (const [k, re] of CMD_CLASS) if (re.test(c)) return k;
  return "other";
}

export function classifyError(text) {
  const t = String(text || "");
  if (/Exit code [1-9]/.test(t)) return "bash_fail";
  if (/not found|does not exist|String to replace/i.test(t)) return "not_found";
  if (/appears? \d+ times?|Found \d+ matches?|matches multiple/i.test(t)) return "ambiguous";
  if (/assert|test .*fail|FAILED|✗/i.test(t)) return "test_fail";
  return "tool_error";
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(b => (typeof b === "string" ? b : b?.text || "")).join("\n");
  return "";
}
function toolResultToBackfill(b) {
  const id = String(b?.tool_use_id || "");
  if (!id) return null;
  const text = resultText(b.content);
  if (b.is_error) return { tool_id: id, outcome: "error", error_kind: classifyError(text) || "tool_error" };
  const m = text.match(/Exit code (\d+)/);
  if (m && Number(m[1]) !== 0) return { tool_id: id, outcome: "error", error_kind: "bash_fail" };
  return { tool_id: id, outcome: "ok", error_kind: null };
}

function toolUseToEvent(b) {
  const input = (b.input && typeof b.input === "object") ? b.input : {};
  const tool = String(b.name || "unknown");
  const ev = { tool_id: String(b.id || ""), tool, file_path: null, ext: null, lines_add: 0, lines_del: 0, cmd_class: null };
  if (tool === "Edit") {
    ev.file_path = input.file_path; ev.lines_add = lineCount(input.new_string); ev.lines_del = lineCount(input.old_string);
  } else if (tool === "MultiEdit") {
    ev.file_path = input.file_path;
    for (const e of Array.isArray(input.edits) ? input.edits : []) { ev.lines_add += lineCount(e.new_string); ev.lines_del += lineCount(e.old_string); }
  } else if (tool === "Write") {
    ev.file_path = input.file_path; ev.lines_add = lineCount(input.content);
  } else if (tool === "NotebookEdit") {
    ev.file_path = input.notebook_path;
  } else if (tool === "Bash") {
    ev.cmd_class = classifyCommand(input.command);
  }
  if (ev.file_path) ev.ext = extOf(ev.file_path);
  return ev;
}

function scanStart(msgs, cursor) {
  let start = cursor > 0 ? Math.min(cursor, msgs.length) : 0;
  if (msgs.length - start > SCAN_LIMIT) start = msgs.length - SCAN_LIMIT;
  return start;
}

export function extractAnthropicEvents(parsed, cursor = 0) {
  const msgs = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const start = scanStart(msgs, cursor);
  const calls = [], results = [];
  for (let i = start; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || typeof m !== "object" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "tool_use") { const ev = toolUseToEvent(b); if (ev.tool_id) calls.push(ev); }
      else if (b.type === "tool_result") { const r = toolResultToBackfill(b); if (r) results.push(r); }
    }
  }
  return { calls, results, cursor: msgs.length };
}
