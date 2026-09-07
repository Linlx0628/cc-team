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
  const stmts = {
    insertEvent: db.prepare(`INSERT INTO tool_events
      (time,user_key,user_name,profile,session,tool_id,tool,file_path,ext,lines_add,lines_del,outcome,cmd_class,model)
      VALUES (@time,@user_key,@user_name,@profile,@session,@tool_id,@tool,@file_path,@ext,@lines_add,@lines_del,'pending',@cmd_class,@model)
      ON CONFLICT(tool_id) DO NOTHING`),
    setResult: db.prepare(`UPDATE tool_events SET outcome=@outcome, error_kind=@error_kind WHERE tool_id=@tool_id AND outcome='pending'`),
    setResultPrefix: db.prepare(`UPDATE tool_events SET outcome=@outcome, error_kind=@error_kind WHERE tool_id LIKE @prefix AND outcome='pending'`),
  };
  function parseAndStore(info, cfg) {
    const extract = info.protocol === "responses" ? extractResponsesEvents : extractAnthropicEvents;
    const prev = cursors.has(info.session) ? cursors.get(info.session) : 0;
    const { calls, results, cursor } = extract(info.parsed, prev);
    cursors.delete(info.session); cursors.set(info.session, cursor);   // LRU touch
    if (cursors.size > CURSOR_LIMIT) cursors.delete(cursors.keys().next().value);
    const storePaths = cfg.storeFilePaths !== false;
    db.transaction(() => {
      for (const c of calls) {
        stmts.insertEvent.run({
          time: now(), user_key: info.userKey, user_name: info.userName || null,
          profile: info.profile || null, session: info.session || null,
          tool_id: c.tool_id, tool: c.tool,
          file_path: storePaths ? (c.file_path || null) : null,
          ext: c.ext || null, lines_add: c.tool === "apply_patch" || FILE_TOOLS.includes(c.tool) ? (c.lines_add | 0) : 0,
          lines_del: c.tool === "apply_patch" || FILE_TOOLS.includes(c.tool) ? (c.lines_del | 0) : 0,
          cmd_class: c.cmd_class || null, model: info.model || null,
        });
      }
      for (const r of results) {
        if (!r) continue;
        stmts.setResult.run(r);
        if (r.tool_id && !r.tool_id.includes("#")) stmts.setResultPrefix.run({ prefix: r.tool_id + "#%", outcome: r.outcome, error_kind: r.error_kind });
      }
    })();
  }
  const DEFAULT_ALERTS = { idleHourTokens: 100000, loopWindowMinutes: 10, loopCount: 3,
    burstWindowMinutes: 30, burstMinEdits: 10, burstFailRate: 0.5, cooldownMinutes: 30 };
  let lastPruneDate = null;
  function alertCooldownKey(kind, user) { return kind + ":" + user; }
  function scanAlerts(thresholds = {}, now = Date.now()) {
    const cfg = { ...DEFAULT_ALERTS, ...thresholds };
    const fired = [];
    const insert = db.prepare(`INSERT INTO production_alerts (time,user_key,user_name,kind,detail) VALUES (?,?,?,?,?)`);
    const recentAlert = db.prepare(`SELECT COUNT(*) n FROM production_alerts WHERE kind=? AND user_key=? AND time>=?`);
    const cn = new Date(now + 8 * 3600000);
    const dateKey = cn.toISOString().slice(0, 10), hourKey = cn.toISOString().slice(11, 13);
    // 1) idle_burn:当前小时 output ≥ 阈值 且 60 分钟内无文件类事件(usage 表无 user_name,经 users 表解析显示名)
    const hot = db.prepare(`SELECT h.user_key, MAX(COALESCE(NULLIF(u.name,''), h.user_key)) user_name, h.o
      FROM (SELECT user_key, SUM(output_tokens) o FROM usage_daily_hourly WHERE date=? AND hour=? GROUP BY user_key HAVING o >= ?) h
      LEFT JOIN users u ON u.user_key = h.user_key GROUP BY h.user_key`).all(dateKey, hourKey, cfg.idleHourTokens);
    const cutoffHour = new Date(now - 3600_000).toISOString();
    for (const u of hot) {
      const hasFiles = db.prepare(`SELECT COUNT(*) n FROM tool_events WHERE user_key=? AND ${FILE_SQL} AND time>=?`).get(u.user_key, cutoffHour).n;
      if (hasFiles) continue;
      if (recentAlert.get("idle_burn", u.user_key, new Date(now - cfg.cooldownMinutes * 60_000).toISOString()).n) continue;
      insert.run(new Date(now).toISOString(), u.user_key, u.user_name, "idle_burn", JSON.stringify({ hour: hourKey, output_tokens: u.o }));
      fired.push({ kind: "idle_burn", user_key: u.user_key, user_name: u.user_name, detail: `近一小时消耗 ${u.o.toLocaleString("zh-CN")} output tokens,无任何文件产出` });
    }
    // 2) error_loop:窗口内同 error_kind 次数 ≥ loopCount
    const cutoffLoop = new Date(now - cfg.loopWindowMinutes * 60_000).toISOString();
    const loops = db.prepare(`SELECT user_key, MAX(COALESCE(NULLIF(user_name,''),user_key)) user_name, error_kind, COUNT(*) c
      FROM tool_events WHERE outcome='error' AND error_kind IS NOT NULL AND time>=?
      GROUP BY user_key, error_kind HAVING c >= ?`).all(cutoffLoop, cfg.loopCount);
    for (const l of loops) {
      if (recentAlert.get("error_loop", l.user_key, new Date(now - cfg.cooldownMinutes * 60_000).toISOString()).n) continue;
      insert.run(new Date(now).toISOString(), l.user_key, l.user_name, "error_loop", JSON.stringify({ error_kind: l.error_kind, count: l.c }));
      fired.push({ kind: "error_loop", user_key: l.user_key, user_name: l.user_name, detail: `${cfg.loopWindowMinutes} 分钟内同类错误「${l.error_kind}」×${l.c},疑似循环` });
    }
    // 3) edit_failure_burst
    const cutoffBurst = new Date(now - cfg.burstWindowMinutes * 60_000).toISOString();
    const bursts = db.prepare(`SELECT user_key, MAX(COALESCE(NULLIF(user_name,''),user_key)) user_name,
        COUNT(*) n, SUM(CASE WHEN outcome='error' THEN 1 ELSE 0 END) e
      FROM tool_events WHERE ${FILE_SQL} AND time>=? GROUP BY user_key
      HAVING n >= ? AND e * 1.0 / n > ?`).all(cutoffBurst, cfg.burstMinEdits, cfg.burstFailRate);
    for (const b of bursts) {
      if (recentAlert.get("edit_failure_burst", b.user_key, new Date(now - cfg.cooldownMinutes * 60_000).toISOString()).n) continue;
      insert.run(new Date(now).toISOString(), b.user_key, b.user_name, "edit_failure_burst", JSON.stringify({ edits: b.n, errors: b.e }));
      fired.push({ kind: "edit_failure_burst", user_key: b.user_key, user_name: b.user_name, detail: `${cfg.burstWindowMinutes} 分钟内 ${b.n} 次编辑失败 ${b.e} 次(>${Math.round(cfg.burstFailRate*100)}%)` });
    }
    return fired;
  }
  function maybePrune() {
    const today = cnDateStr();
    if (lastPruneDate === today) return;
    lastPruneDate = today;
    db.prepare(`DELETE FROM tool_events WHERE date(time,'+8 hours') < date(?, '-90 days')`).run(today);
    db.prepare(`DELETE FROM production_alerts WHERE date(time,'+8 hours') < date(?, '-90 days')`).run(today);
  }
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
  if (/AssertionError|✗|\btests?\b[^\n]*\bfail/i.test(t)) return "test_fail";
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

// —— Task 3: Codex Responses 协议解析(纯函数,无 db 访问)——
export function parseApplyPatch(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || "").split("\n")) {
    const m = raw.match(/^\*\*\* (Update|Add|Delete) File: (.+?)\s*$/);
    if (m) { cur = { file_path: m[2], op: m[1], lines_add: 0, lines_del: 0 }; out.push(cur); continue; }
    if (raw.startsWith("*** End Patch")) { cur = null; continue; }
    if (!cur) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) cur.lines_add++;
    else if (raw.startsWith("-") && !raw.startsWith("---")) cur.lines_del++;
  }
  return out;
}

function commandText(cmd) {
  if (typeof cmd === "string") return cmd;
  if (Array.isArray(cmd)) return cmd.map(p => (typeof p === "string" ? p.trim() : (p && typeof p.text === "string" ? p.text : ""))).filter(Boolean).join(" ");
  return "";
}

export function extractResponsesEvents(parsed, cursor = 0) {
  const items = Array.isArray(parsed?.input) ? parsed.input : [];
  const start = scanStart(items, cursor);
  const calls = [], results = [];
  for (let i = start; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== "object") continue;
    if (it.type === "function_call") {
      const callId = String(it.call_id || it.id || "");
      if (!callId) continue;
      const name = String(it.name || "unknown");
      let args = {};
      try { args = JSON.parse(it.arguments || "{}"); } catch {}
      const cmd = commandText(args.command ?? args.cmd);
      if (cmd.includes("*** Begin Patch")) {
        const files = parseApplyPatch(cmd);
        files.forEach((f, idx) => calls.push({
          tool_id: `${callId}#${idx}`, tool: "apply_patch",
          file_path: f.file_path, ext: extOf(f.file_path),
          lines_add: f.lines_add, lines_del: f.lines_del, cmd_class: null,
        }));
      } else {
        calls.push({ tool_id: callId, tool: name, file_path: null, ext: null, lines_add: 0, lines_del: 0,
          cmd_class: cmd ? classifyCommand(cmd) : null });
      }
    } else if (it.type === "function_call_output") {
      const id = String(it.call_id || "");
      if (!id) continue;
      let exitCode = 0, outText = "";
      try {
        const o = JSON.parse(it.output || "{}");
        const rawExit = o.exit_code ?? o.exitCode ?? o.metadata?.exit_code ?? o.metadata?.exitCode;
        exitCode = Number.isFinite(Number(rawExit)) ? Number(rawExit) : 0;
        outText = String(o.output || "");
      } catch { outText = String(it.output || ""); }
      if (exitCode !== 0) results.push({ tool_id: id, outcome: "error", error_kind: classifyError(`Exit code ${exitCode}\n${outText}`) });
      else results.push({ tool_id: id, outcome: "ok", error_kind: null });
    }
  }
  return { calls, results, cursor: items.length };
}

// —— Task 6: 指标聚合查询(summary/user/projects,纯读路径)——
function cnDateStr(now = Date.now()) { return new Date(now + 8 * 3600000).toISOString().slice(0, 10); }

export function rangeFromTo(range) {
  const days = range === "today" ? 1 : range === "30d" ? 30 : 7;
  return { from: cnDateStr(Date.now() - (days - 1) * 86400000), to: cnDateStr() };
}

// 文件工具谓词从 FILE_TOOLS 派生——与落库侧单一口径,防漂移
const FILE_SQL = "tool IN (" + FILE_TOOLS.map(t => `'${t}'`).join(",") + ")";

export function productionSummary(db, { from, to }) {
  const rows = db.prepare(`
    SELECT user_key, MAX(COALESCE(NULLIF(user_name,''), user_key)) AS user_name,
      COUNT(*) AS tool_calls,
      SUM(CASE WHEN ${FILE_SQL} THEN 1 ELSE 0 END) AS edit_count,
      SUM(CASE WHEN ${FILE_SQL} THEN lines_add ELSE 0 END) AS lines_add,
      SUM(CASE WHEN ${FILE_SQL} THEN lines_del ELSE 0 END) AS lines_del,
      COUNT(DISTINCT CASE WHEN ${FILE_SQL} THEN file_path END) AS files,
      SUM(CASE WHEN ${FILE_SQL} AND outcome='error' THEN 1 ELSE 0 END) AS edit_errors,
      SUM(CASE WHEN cmd_class IN ('test','lint') THEN 1 ELSE 0 END) AS verify_runs
    FROM tool_events WHERE date(time,'+8 hours') BETWEEN ? AND ?
    GROUP BY user_key ORDER BY lines_add DESC`).all(from, to);
  const usage = Object.fromEntries(db.prepare(`
    SELECT user_key, SUM(output_tokens) o FROM usage_daily WHERE date BETWEEN ? AND ? GROUP BY user_key`).all(from, to).map(r => [r.user_key, r.o]));
  for (const r of rows) {
    r.net_lines = (r.lines_add || 0) - (r.lines_del || 0);
    r.fail_rate = r.edit_count ? (r.edit_errors || 0) / r.edit_count : 0;
    r.rewrite_rate = r.lines_add ? (r.lines_del || 0) / r.lines_add : 0;
    r.verify_density = r.edit_count ? (r.verify_runs || 0) / r.edit_count : 0;
    const out = usage[r.user_key] || 0;
    r.token_per_line = r.net_lines > 0 ? out / r.net_lines : null;
  }
  const active = new Set(rows.map(r => r.user_key));
  const zeroOutput = db.prepare(`
    SELECT DISTINCT ud.user_key, MAX(COALESCE(u.name, ud.user_key)) AS user_name, SUM(ud.output_tokens) AS output_tokens
    FROM usage_daily ud LEFT JOIN users u ON u.user_key = ud.user_key
    WHERE ud.date BETWEEN ? AND ? GROUP BY ud.user_key`).all(from, to)
    .filter(r => !active.has(r.user_key));
  return { rows, zeroOutput };
}

// —— 项目识别精准化:路径清洗 + 会话主导子树推导(纯函数,无 db 访问)——
// 噪声目录:路径含任一段(大小写不敏感)即整条弃置,不参与项目推导(配置/依赖/系统目录)
const NOISE_SEGMENTS = new Set([".claude", ".git", "node_modules", "appdata"]);
const HOME_MARKERS = new Set(["users", "home"]);   // /Users/<name>、/home/<name>;root 家目录即 /root 本身
const LOCAL_LABEL = "(本地配置)";
const DESCEND_RATIO = 0.6;   // 最重孩子 ≥60% 节点权重 → 下沉
const SPLIT_RATIO = 0.2;     // 根级无主导时,≥20% 孩子各自成簇(多仓库会话各得标签)
const MAX_DEPTH = 8;         // 下沉深度上限

// 返回清洗后的段数组;含噪声段返回 null(调用方按弃置处理,权重仍随会话主导标签并入)
export function cleanFilePath(p) {
  const segs = String(p ?? "").replace(/\\/g, "/").split("/").filter(s => s && s !== ".");
  for (const s of segs) if (NOISE_SEGMENTS.has(s.toLowerCase())) return null;
  const out = segs.filter(s => !/^[a-zA-Z]:$/.test(s));              // 剥盘符段
  if (out.length) {
    const h = out[0].toLowerCase();
    if (HOME_MARKERS.has(h) && out.length > 1) out.splice(0, 2);     // 家目录标记 + 紧随用户名段
    else if (h === "root") out.splice(0, 1);
  }
  return out;
}

// 带权目录 trie:文件权重记入其全部祖先目录节点(文件本身不成节点——标签是项目不是文件);
// 条目挂最深目录节点(无目录段挂根,随 (本地配置)/主导标签处置)
function buildProjectTrie(groups) {
  const root = { children: new Map(), weight: 0, items: [] };
  for (const g of groups) {
    root.weight += g.weight;
    let node = root;
    for (const d of g.dirs) {
      let c = node.children.get(d);
      if (!c) { c = { children: new Map(), weight: 0, items: [], seg: d }; node.children.set(d, c); }
      c.weight += g.weight;
      node = c;
    }
    node.items.push(g);
  }
  return root;
}
const lastTwoLabel = (path) => path.length ? path.slice(-2).join("/") : LOCAL_LABEL;

// 自 node 沿 ≥60% 主链下沉(深度 ≤MAX_DEPTH),返回路径段
function descendChain(node, path) {
  while (path.length < MAX_DEPTH) {
    let top = null;
    for (const c of node.children.values()) if (!top || c.weight > top.weight) top = c;
    if (!top || node.weight <= 0 || top.weight / node.weight < DESCEND_RATIO) break;
    node = top; path.push(top.seg);
  }
  return path;
}
function subtreeItems(node, out = []) {
  for (const g of node.items) out.push(g);
  for (const c of node.children.values()) subtreeItems(c, out);
  return out;
}

// fileGroups=[{segments,weight,...}] → 簇 [{label, groups}]:
// 根级最重孩子 ≥60% → 单主导,全量并入主链末端标签;否则 ≥20% 孩子各自成簇(多仓库会话各得标签),
// <20% 与无目录项挂 (本地配置)。标签 = 主导子树路径末两段(不足取全部)。
function deriveClusters(fileGroups) {
  const groups = (Array.isArray(fileGroups) ? fileGroups : []).map(g => {
    const segments = Array.isArray(g?.segments) ? g.segments : [];
    return { ...g, segments, dirs: segments.slice(0, -1), weight: Number(g?.weight) || 0 };
  });
  const root = buildProjectTrie(groups);
  const kids = [...root.children.values()].sort((a, b) => b.weight - a.weight);
  const rootRatio = kids.length && root.weight > 0 ? kids[0].weight / root.weight : 0;
  if (!kids.length || rootRatio >= DESCEND_RATIO) {
    return [{ label: lastTwoLabel(descendChain(root, [])), groups }];
  }
  const clusters = [], local = [];
  local.push(...root.items);   // 挂根条目(噪声空段/裸文件名)必须落桶,不得随分簇丢失
  for (const kid of kids) {
    const ratio = root.weight > 0 ? kid.weight / root.weight : 0;
    if (ratio >= SPLIT_RATIO) clusters.push({ label: lastTwoLabel(descendChain(kid, [kid.seg])), groups: subtreeItems(kid) });
    else local.push(...subtreeItems(kid));
  }
  if (local.length || !clusters.length) clusters.push({ label: LOCAL_LABEL, groups: local });
  return clusters;
}

export function deriveProjectLabel(fileGroups) {
  return deriveClusters(fileGroups).map(c => c.label);
}

// 绝对路径:以 / 或盘符(含 UNC \\)开头
const ABS_PATH_RE = /^(\/|[a-zA-Z]:[\\/]|\\\\)/;
// 单文件会话:绝对路径取清洗后目录前两段(不足取全部);相对路径首段即项目根
function singleFileLabel(fp) {
  const segs = cleanFilePath(fp) || [];
  if (!segs.length) return LOCAL_LABEL;
  if (!ABS_PATH_RE.test(String(fp))) return segs[0];
  const dir = segs.slice(0, -1);
  return dir.length ? dir.slice(0, 2).join("/") : LOCAL_LABEL;
}

// 别名先套用(正则 test 标签,首个命中生效)再按名聚合:users 并集去重,files/lines/edits 求和;非法正则静默跳过
export function applyProjectAliases(rows, aliases) {
  const rules = [];
  for (const a of Array.isArray(aliases) ? aliases : []) {
    if (!a || typeof a.pattern !== "string" || !a.pattern) continue;
    try { rules.push({ re: new RegExp(a.pattern), name: typeof a.name === "string" && a.name ? a.name : a.pattern }); } catch { /* 非法正则跳过 */ }
  }
  const merged = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== "object") continue;
    let name = String(r.project ?? "");
    for (const rule of rules) if (rule.re.test(name)) { name = rule.name; break; }
    let m = merged.get(name);
    if (!m) merged.set(name, m = { project: name, user_keys: [], users: 0, files: 0, lines_add: 0, lines_del: 0, edits: 0 });
    if (Array.isArray(r.user_keys)) { const seen = new Set(m.user_keys); for (const u of r.user_keys) seen.add(u); m.user_keys = [...seen]; }
    else m.users += Number(r.users) || 0;
    m.files += Number(r.files) || 0;
    m.lines_add += Number(r.lines_add) || 0;
    m.lines_del += Number(r.lines_del) || 0;
    m.edits += Number(r.edits) || 0;
  }
  return [...merged.values()].map(m => ({ ...m, users: m.user_keys.length || m.users }));
}

export function productionProjects(db, { from, to, aliases } = {}) {
  // 会话为归组单位:同会话文件集合共同推导项目;session NULL 归 '' 桶。权重 = Σ(lines_add+lines_del)
  const rows = db.prepare(`
    SELECT session, file_path, user_key,
      SUM(lines_add) AS la, SUM(lines_del) AS ld, COUNT(*) AS edits
    FROM tool_events WHERE date(time,'+8 hours') BETWEEN ? AND ? AND file_path IS NOT NULL
    GROUP BY session, file_path, user_key`).all(from, to);
  const sessions = new Map();
  for (const r of rows) {
    const key = r.session || "";
    let byFile = sessions.get(key);
    if (!byFile) sessions.set(key, byFile = new Map());
    let f = byFile.get(r.file_path);
    if (!f) byFile.set(r.file_path, f = { users: new Set(), la: 0, ld: 0, edits: 0 });
    f.users.add(r.user_key); f.la += r.la || 0; f.ld += r.ld || 0; f.edits += r.edits || 0;
  }
  const acc = new Map();   // 标签 → 聚合(users/files 按集合去重,与旧 COUNT DISTINCT 口径一致)
  for (const byFile of sessions.values()) {
    let clusters;
    if (byFile.size === 1) {
      const [fp, stat] = [...byFile.entries()][0];
      clusters = [{ label: singleFileLabel(fp), groups: [{ stat, path: fp }] }];
    } else {
      const groups = [];
      for (const [fp, stat] of byFile) {
        const segments = cleanFilePath(fp);
        groups.push({ segments: segments || [], weight: stat.la + stat.ld, stat, path: fp });   // 噪声 → 空段挂根,随主导标签并入
      }
      clusters = deriveClusters(groups);
    }
    for (const { label, groups } of clusters) {
      let a = acc.get(label);
      if (!a) acc.set(label, a = { users: new Set(), paths: new Set(), lines_add: 0, lines_del: 0, edits: 0 });
      for (const g of groups) {
        for (const u of g.stat.users) a.users.add(u);
        a.paths.add(g.path);
        a.lines_add += g.stat.la; a.lines_del += g.stat.ld; a.edits += g.stat.edits;
      }
    }
  }
  // 无别名 = 按标签聚合透传;有别名 = 改名后再按名合并(users 并集、files/lines/edits 求和)
  const out = applyProjectAliases([...acc.entries()].map(([label, a]) => ({
    project: label, user_keys: [...a.users], files: a.paths.size,
    lines_add: a.lines_add, lines_del: a.lines_del, edits: a.edits,
  })), aliases || []);
  return out.map(r => ({
    project: r.project,
    users: Array.isArray(r.user_keys) ? r.user_keys.length : (Number(r.users) || 0),
    files: r.files, lines_add: r.lines_add, lines_del: r.lines_del, edits: r.edits,
  })).sort((a, b) => b.lines_add - a.lines_add).slice(0, 50);
}

export function productionUserDetail(db, userKey, { from, to }) {
  const days = db.prepare(`
    SELECT date(time,'+8 hours') AS date, SUM(lines_add) la, SUM(lines_del) ld, COUNT(*) edits,
      SUM(CASE WHEN outcome='error' THEN 1 ELSE 0 END) errs
    FROM tool_events WHERE user_key=? AND date(time,'+8 hours') BETWEEN ? AND ?
    GROUP BY date ORDER BY date`).all(userKey, from, to);
  const files = db.prepare(`
    SELECT file_path, SUM(lines_add) la, SUM(lines_del) ld, COUNT(*) edits,
      SUM(CASE WHEN outcome='error' THEN 1 ELSE 0 END) errs
    FROM tool_events WHERE user_key=? AND date(time,'+8 hours') BETWEEN ? AND ? AND file_path IS NOT NULL
    GROUP BY file_path ORDER BY edits DESC, la DESC LIMIT 10`).all(userKey, from, to);
  const languages = db.prepare(`
    SELECT ext, COUNT(*) edits, SUM(lines_add) la FROM tool_events
    WHERE user_key=? AND date(time,'+8 hours') BETWEEN ? AND ? AND ext IS NOT NULL
    GROUP BY ext ORDER BY la DESC LIMIT 10`).all(userKey, from, to);
  return { days, files, languages };
}

// —— Task 7: 告警查询/已读/90 天清理(API 任务消费)——
export function productionAlerts(db, { from, to }) {
  return db.prepare(`SELECT id, time, user_key, COALESCE(NULLIF(user_name,''),user_key) AS user_name, kind, detail, seen
    FROM production_alerts WHERE date(time,'+8 hours') BETWEEN ? AND ? ORDER BY time DESC LIMIT 200`).all(from, to);
}

export function markAlertSeen(db, id) { return db.prepare(`UPDATE production_alerts SET seen=1 WHERE id=?`).run(id).changes; }

export function pruneProductionData(db, days) {
  db.prepare(`DELETE FROM tool_events WHERE date(time,'+8 hours') < date('now','+8 hours', ?)`).run(`-${Math.max(1, days|0)} days`);
}

// —— Task 8: 等值成本引擎 + 上下文健康度(纯读路径)——
// 参考价:USD / 1M tokens(Claude 家族官方牌价;其余模型在设置页补充;未配置的模型计 0 并列入 unpriced)
export const DEFAULT_COST_RATES = {
  "claude-opus":   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-sonnet": { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.3 },
  "claude-haiku":  { input: 1,  output: 5,  cacheWrite: 1.25,  cacheRead: 0.1 },
};
export function resolveRate(rates, model) {
  const m = String(model || "");
  if (rates[m]) return rates[m];
  const keys = Object.keys(rates).filter(k => k !== "*" && m.startsWith(k)).sort((a, b) => b.length - a.length);
  if (keys.length) return rates[keys[0]];
  return rates["*"] || null;
}

// —— 峰谷时段:与 server.mjs normalizePeakHours/isInPeakHours 互为拷贝(production 不得 import server,防循环),fixture 同步防漂移 ——
const PEAK_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
function parsePeakTimeMinutes(t) {
  if (typeof t !== "string") return null;
  const m = PEAK_TIME_RE.exec(t.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
export function normalizeCostPeakHours(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const start = parsePeakTimeMinutes(item.start);
    const end = parsePeakTimeMinutes(item.end);
    if (start === null || end === null || start === end) continue;
    const norm = { start: item.start.trim(), end: item.end.trim() };
    if (!out.some(r => r.start === norm.start && r.end === norm.end)) out.push(norm);
  }
  return out;
}
// hour 为 '00'-'23' 字符串,按 h×60 起始分钟判定;start 含、end 不含,end < start 为跨午夜
export function hourIsPeak(hour, peakHours) {
  if (!Array.isArray(peakHours) || peakHours.length === 0) return false;
  if (typeof hour !== "string" || !/^\d{1,2}$/.test(hour)) return false;
  const h = Number(hour);
  if (h > 23) return false;
  const minutes = h * 60;
  for (const r of peakHours) {
    const start = parsePeakTimeMinutes(r?.start);
    const end = parsePeakTimeMinutes(r?.end);
    if (start === null || end === null || start === end) continue;
    if (start < end) {
      if (minutes >= start && minutes < end) return true;
    } else if (minutes >= start || minutes < end) {   // 跨午夜
      return true;
    }
  }
  return false;
}

export function computeCosts(db, rates, { from, to, peakHours } = {}) {
  const peak = normalizeCostPeakHours(peakHours);
  const caches = db.prepare(`SELECT profile, user_key, SUM(cache_creation) cc, SUM(cache_read) cr
    FROM usage_daily WHERE date BETWEEN ? AND ? GROUP BY profile, user_key`).all(from, to);
  const byUser = new Map(), unpricedSet = new Set();
  const bucket = (profile, user) => {
    const k = profile + "|" + user;
    if (!byUser.has(k)) byUser.set(k, { profile, user_key: user, user_name: null, model_cost: 0, cache_cost: 0, models: [], in_weighted_rate: 0, in_total: 0, cc: 0, cr: 0 });
    return byUser.get(k);
  };
  if (peak.length === 0) {
    // —— 基础路径:未配峰谷时与既有实现逐字一致(回归锚)——
    const models = db.prepare(`SELECT profile, user_key, model, SUM(input_tokens) i, SUM(output_tokens) o
      FROM usage_daily_model WHERE date BETWEEN ? AND ? GROUP BY profile, user_key, model`).all(from, to);
    for (const m of models) {
      const b = bucket(m.profile, m.user_key);
      const r = resolveRate(rates, m.model);
      const c = r ? (m.i * r.input + m.o * r.output) / 1e6 : 0;
      if (!r) unpricedSet.add(m.model);
      b.model_cost += c;
      b.models.push({ model: m.model, input_tokens: m.i, output_tokens: m.o, cost: +c.toFixed(4), priced: !!r });
      b.in_total += m.i;
      if (r) b.in_weighted_rate += m.i * (r.cacheWrite ?? 0);   // 以 input 为权重累积,稍后求 blended
    }
  } else {
    // —— 峰谷路径:小时表按 hourIsPeak 分档计价(峰价 r.peakInput ?? r.input / r.peakOutput ?? r.output,
    //    未设或 null 回落基础价,显式 0 生效);同时读日表,按 (profile,date,user_key,model) 对齐,
    //    缺口 max(0, 日Σ−时Σ) 按基础价回填,in/out 总量与日表守恒 ——
    const hourlyRows = db.prepare(`SELECT profile, date, user_key, hour, model, SUM(input_tokens) i, SUM(output_tokens) o
      FROM usage_hourly_model WHERE date BETWEEN ? AND ? GROUP BY profile, date, user_key, hour, model`).all(from, to);
    const dailyRows = db.prepare(`SELECT profile, date, user_key, model, SUM(input_tokens) i, SUM(output_tokens) o
      FROM usage_daily_model WHERE date BETWEEN ? AND ? GROUP BY profile, date, user_key, model`).all(from, to);
    const modelAggs = new Map();    // profile|user_key|model → 聚合条目(小时分档 + 缺口回填合并)
    const hourlyByDay = new Map();  // profile|date|user_key|model → 当日小时表合计(算缺口用)
    const addCost = (b, model, i, o, peakSlot) => {
      const r = resolveRate(rates, model);
      if (!r) unpricedSet.add(model);
      const c = r ? (i * (peakSlot ? (r.peakInput ?? r.input) : r.input)
                  + o * (peakSlot ? (r.peakOutput ?? r.output) : r.output)) / 1e6 : 0;
      b.model_cost += c;
      const mk = b.profile + "|" + b.user_key + "|" + model;
      let agg = modelAggs.get(mk);
      if (!agg) modelAggs.set(mk, agg = { b, model, input_tokens: 0, output_tokens: 0, cost: 0, priced: true });
      agg.input_tokens += i; agg.output_tokens += o; agg.cost += c;
      if (!r) agg.priced = false;
      b.in_total += i;
      if (r) b.in_weighted_rate += i * (r.cacheWrite ?? 0);
    };
    for (const m of hourlyRows) {
      const dk = m.profile + "|" + m.date + "|" + m.user_key + "|" + m.model;
      const cur = hourlyByDay.get(dk) || { i: 0, o: 0 };
      cur.i += m.i; cur.o += m.o; hourlyByDay.set(dk, cur);
      addCost(bucket(m.profile, m.user_key), m.model, m.i, m.o, hourIsPeak(m.hour, peak));
    }
    for (const d of dailyRows) {
      const h = hourlyByDay.get(d.profile + "|" + d.date + "|" + d.user_key + "|" + d.model) || { i: 0, o: 0 };
      const gapIn = Math.max(0, d.i - h.i), gapOut = Math.max(0, d.o - h.o);
      if (gapIn || gapOut) addCost(bucket(d.profile, d.user_key), d.model, gapIn, gapOut, false);   // 缺口按基础价
    }
    for (const agg of modelAggs.values()) {
      agg.b.models.push({ model: agg.model, input_tokens: agg.input_tokens, output_tokens: agg.output_tokens, cost: +agg.cost.toFixed(4), priced: agg.priced });
    }
  }
  for (const c of caches) {
    const b = bucket(c.profile, c.user_key);
    b.cc += c.cc || 0; b.cr += c.cr || 0;
  }
  const nameOf = db.prepare(`SELECT name FROM users WHERE user_key=? AND name IS NOT NULL LIMIT 1`);
  const rows = [...byUser.values()].map(b => {
    const names = nameOf.all(b.user_key);
    b.user_name = names.length ? names[0].name : b.user_key;
    const bw = b.in_total ? b.in_weighted_rate / b.in_total : 0;          // blended cacheWrite
    const br = bw / 12.5;                                                  // Claude 家族 cacheRead=cacheWrite×0.08 的近似;统一用 write/12.5
    b.cache_cost = (b.cc * bw + b.cr * br) / 1e6;
    b.total_cost = +(b.model_cost + b.cache_cost).toFixed(4);
    b.model_cost = +b.model_cost.toFixed(4); b.cache_cost = +b.cache_cost.toFixed(4);
    return b;
  }).sort((a, b) => b.total_cost - a.total_cost);
  return { rows, unpriced: [...unpricedSet] };
}
export function contextHealth(db, { from, to }) {
  const rows = db.prepare(`SELECT ud.user_key, MAX(COALESCE(u.name, ud.user_key)) user_name,
      SUM(ud.cache_read) cr, SUM(ud.input_tokens) i
    FROM usage_daily ud LEFT JOIN users u ON u.user_key=ud.user_key
    WHERE ud.date BETWEEN ? AND ? GROUP BY ud.user_key`).all(from, to);
  for (const r of rows) {
    const denom = (r.cr || 0) + (r.i || 0);
    r.ratio = denom ? (r.cr || 0) / denom : 0;
    r.advice = r.ratio >= 0.8 ? "缓存命中率优秀,会话结构良好"
      : r.ratio >= 0.5 ? "缓存命中率良好;减少频繁切换会话可进一步提升"
      : "缓存命中率偏低:长会话尽量连续使用、避免反复粘贴大段上下文";
  }
  return rows;
}

// —— Task 9: 报告导出(自包含单文件 HTML,零外部依赖)——
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const pct = (x) => x == null ? "—" : (x * 100).toFixed(0) + "%";
const num = (x) => x == null ? "—" : Number(x).toLocaleString("zh-CN");

export const ALERT_KIND_LABEL = { idle_burn: "空转消耗", error_loop: "错误循环", edit_failure_burst: "失败爆发" };
// 库里 detail 存的是 JSON 串;报告里翻译成人类话,解析失败退回原文(调用侧统一 esc)
export function alertDetailText(kind, detail) {
  let d = {};
  try { d = JSON.parse(detail || "{}") || {}; } catch {}
  if (kind === "idle_burn") return `近一小时消耗 ${num(d.output_tokens ?? 0)} output tokens,无任何文件产出`;
  if (kind === "error_loop") return `同类错误「${d.error_kind ?? "?"}」×${num(d.count ?? 0)},疑似循环`;
  if (kind === "edit_failure_burst") return `编辑 ${num(d.edits ?? 0)} 次失败 ${num(d.errors ?? 0)} 次`;
  return String(detail ?? "");
}

// 统一空态:无数据时渲染单行占位,不留空区块
function renderRows(rows, fn, colSpan) {
  return rows && rows.length ? rows.map(fn).join("") : `<tr><td colspan="${colSpan}" class="empty">该周期无数据</td></tr>`;
}

export function buildReportHTML({ summary, projects, costs, health, alerts, from, to }) {
  const s = summary || { rows: [], zeroOutput: [] };
  const rowsHtml = renderRows(s.rows, r => `<tr><td>${esc(r.user_name)}</td><td class="n">${num(r.net_lines)}</td>
    <td class="n">${r.files ?? 0}</td><td class="n">${pct(r.fail_rate)}</td><td class="n">${pct(r.rewrite_rate)}</td>
    <td class="n">${(r.verify_density ?? 0).toFixed(1)}</td><td class="n">${r.token_per_line == null ? "—" : Math.round(r.token_per_line).toLocaleString("zh-CN")}</td></tr>`, 7);
  const zeroNote = (s.zeroOutput || []).length
    ? `<p class="note">周期内零产出成员（有 token 消耗、无文件编辑事件）：${s.zeroOutput.map(u => esc(u.user_name)).join("、")}</p>`
    : "";
  const projHtml = renderRows(projects, r => `<tr><td>${esc(r.project)}</td><td class="n">${r.users}</td><td class="n">${r.files}</td>
    <td class="n">${num(r.lines_add)}</td><td class="n">${num(r.lines_del)}</td><td class="n">${r.edits}</td></tr>`, 6);
  const unpriced = (costs && costs.unpriced) || [];
  const unpricedNote = unpriced.length
    ? `<p class="note">未配置单价的模型（按 0 计）：${unpriced.map(esc).join("、")} —— 可在设置页补充牌价</p>`
    : "";
  const costHtml = renderRows(costs && costs.rows, r => `<tr><td>${esc(r.user_name)}<span class="note">（${esc(r.profile)}）</span></td>
    <td class="n">$${Number(r.model_cost).toFixed(4)}</td><td class="n">$${Number(r.cache_cost).toFixed(4)}</td><td class="n"><b>$${Number(r.total_cost).toFixed(4)}</b></td></tr>`, 4);
  const alertHtml = renderRows(alerts, a => `<tr><td>${esc(a.time)}</td><td>${esc(a.user_name)}</td>
    <td>${esc(ALERT_KIND_LABEL[a.kind] || a.kind)}</td><td>${esc(alertDetailText(a.kind, a.detail))}</td>
    <td>${a.seen ? "已读" : "未读"}</td></tr>`, 5);
  const healthHtml = renderRows(health, r => `<tr><td>${esc(r.user_name)}</td>
    <td class="n">${num(r.cr)}</td><td class="n">${num(r.i)}</td><td class="n">${pct(r.ratio)}</td><td>${esc(r.advice)}</td></tr>`, 5);

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>产出质量报告 ${esc(from)} ~ ${esc(to)}</title>
<style>body{font:14px/1.6 -apple-system,"PingFang SC",sans-serif;background:#fbfbf8;color:#1f2937;max-width:960px;margin:24px auto;padding:0 16px}
h1{font-size:20px}h2{font-size:16px;margin-top:28px;border-left:3px solid #2f6e50;padding-left:8px}
table{border-collapse:collapse;width:100%;margin:8px 0}th,td{border:1px solid #e5e7eb;padding:6px 10px;text-align:left}th{background:#f3f4f1}
.n{text-align:right;font-variant-numeric:tabular-nums}.note{color:#6b7280;font-size:12px}.empty{color:#6b7280;text-align:center}</style></head><body>
<h1>CC Team 产出质量报告</h1><p class="note">${esc(from)} ~ ${esc(to)} · 自动生成 · 全部指标口径见附录</p>
<h2>成员产出对比</h2><table><thead><tr><th>成员</th><th>净产出</th><th>文件数</th><th>失败率</th><th>重写率</th><th>验证密度</th><th>token/行</th></tr></thead><tbody>${rowsHtml}</tbody></table>${zeroNote}
<h2>项目分布</h2><table><thead><tr><th>项目</th><th>成员数</th><th>文件数</th><th>新增行</th><th>删除行</th><th>编辑次数</th></tr></thead><tbody>${projHtml}</tbody></table>
<h2>等值成本（参考牌价）</h2><table><thead><tr><th>成员</th><th>模型成本</th><th>缓存成本</th><th>合计成本</th></tr></thead><tbody>${costHtml}</tbody></table>${unpricedNote}<p class="note">USD/1M tokens，参考牌价折算，非实际账单</p>
<h2>告警</h2><table><thead><tr><th>时间</th><th>成员</th><th>类型</th><th>详情</th><th>状态</th></tr></thead><tbody>${alertHtml}</tbody></table>
<h2>上下文缓存健康度</h2><table><thead><tr><th>成员</th><th>缓存读取 tokens</th><th>输入 tokens</th><th>命中率</th><th>建议</th></tr></thead><tbody>${healthHtml}</tbody></table>
<h2>附录：指标口径</h2><ul class="note">
<li>净产出 = Σ新增行 − Σ删除行（Write 记全量，Edit 记新旧串行数，apply_patch 记补丁行）</li>
<li>失败率 = 文件类编辑 outcome=error 占比；重写率 = Σdel ÷ Σadd；验证密度 = (test+lint 命令) ÷ 编辑次数</li>
<li>token/行 = output_tokens ÷ 净产出（联 usage_daily）</li>
<li>成本 = Σ(tokens × 单价/1M)，缓存按用户模型权重混合折算，cacheRead≈cacheWrite÷12.5（Claude 牌价比例）</li>
<li>仅统计结构化指标，不存储任何代码内容；Codex 协议为指标子集（shell/apply_patch）</li></ul>
</body></html>`;
}
