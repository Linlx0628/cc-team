// lib/sessions.mjs —— 会话使用情况。
//
// 两套数据源,按 (user_key, session) 连接(两者都出自 extractSessionSignal,键天然一致):
//   · usage_session —— token / 缓存(date 列是北京日期串)
//   · tool_events   —— 工具调用 / 编辑 / 净产出(经 sessionToolStats)
// 项目标签经 sessionProjectLabels 取,复用 production.mjs 唯一那份路径解析。
//
// 缓存率口径与 contextHealth 一致:**必须逐方案判断协议**。Responses/Codex 协议把
// 缓存命中折进了 input_tokens(cached_tokens 是其子集),照搬公式会把缓存读在分母里
// 算两遍,命中率被系统性压到 50% 上限。所以 usage_session 的分组键带 profile,
// 折叠时先按 profile 修正、再合并。
//
// 所有比值一律从**原始累加量**重算,不从已算好的比值反推。反推会在 cache_rate 为 0
// 时除零(0 × (1-0) / 0 = NaN),也会在四舍五入后累积误差 —— 这里把中间量
// (denomI = 协议修正后的新增输入、errors)一路带着走。
//
// 时间窗一律按**北京日期**,与 usage_session.date、tool_events 的 date(time,'+8 hours')
// 同口径,同一个 {from,to} 能同时喂给两套查询。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { maskKey } from "./leaderboard.mjs";

// ── 会话名 ──
// 上游请求里从来没有会话名:extractSessionSignal 只拿得到请求头 / prompt_cache_key /
// 首条消息哈希,三者都不含标题。人可读的标题是客户端**存在本机**的 ——
//   ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl 里的一行
//   {"type":"ai-title","aiTitle":"...","sessionId":"<uuid>"}
// sessionId 恰好就是请求头带过来的那个 uuid(hdr: 后面那一段;已核对 36 个文件,
// 文件名与记录里的 sessionId 逐一无差),所以两边能对上。
//
// 取**最后一条**:一个会话的标题会随对话焦点演化(实测某个会话有 685 条 ai-title,
// 从「my-usage 缓存命中率算法」一路变到「half-hour-chart-granularity」),/resume 显示的
// 也是最后那条。所以这里不落库、每次现读 —— 固化进库只会一直显示一个过期的标题。
//
// 读不到就返回空,不抛:服务器可能跑在没有 ~/.claude 的机器或容器里,老会话与非
// Claude Code 的客户端也天然没有对应文件。会话名是**增强**,标识串始终是兜底。
const TAIL_CHUNK = 64 * 1024;   // 最后一条 ai-title 恒在尾部附近:实测 41MB 的文件也只距尾 27.9KB
const SESSION_FILE_RE = /^[A-Za-z0-9_-]{1,64}$/;

// "hdr:<uuid>" → "<uuid>";dig: / pck: / nosession 没有对应的本地文件,给 null。
// 只取 hdr: 是有意的:pck:<prompt_cache_key> 与 dig:<内容哈希> 都是**内容派生**的键,
// 与客户端的会话文件没有命名关系,拿它们去查盘只会白扫一遍目录。
function sessionUuidOf(session) {
  const raw = String(session || "");
  if (!raw.startsWith("hdr:")) return null;
  const id = raw.slice(4);
  return SESSION_FILE_RE.test(id) ? id : null;
}

// 文件名即 sessionId,所以建索引只要列目录、不必读内容。同一个 uuid 出现在两个目录时
// 取 mtime 最新的那个(换 cwd 之后 --resume 可能留下两份)。
function indexSessionFiles(root) {
  const out = new Map();
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let files;
    try { files = fs.readdirSync(path.join(root, d.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const id = f.slice(0, -6);
      if (!SESSION_FILE_RE.test(id)) continue;
      const full = path.join(root, d.name, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const prev = out.get(id);
      if (!prev || prev.mtime < st.mtimeMs) out.set(id, { file: full, size: st.size, mtime: st.mtimeMs });
    }
  }
  return out;
}

// 一段文本里**最后**一条 ai-title。从后往前逐行看,所以文件越长也只是多看几行;
// 解析不了的行(被并发写入截断的半行)跳过继续往前,不让它吞掉前一条完整标题。
function lastAiTitle(text) {
  let end = text.length;
  while (end > 0) {
    const nl = text.lastIndexOf("\n", end - 1);
    const line = text.slice(nl + 1, end).trim();
    end = nl;
    if (!line.includes('"ai-title"')) continue;
    try {
      const o = JSON.parse(line);
      if (o && o.type === "ai-title" && typeof o.aiTitle === "string" && o.aiTitle.trim()) return o.aiTitle.trim();
    } catch { /* 半行或非 JSON:跳过 */ }
  }
  return null;
}

// 从文件尾倒读:先读尾块,没有就把范围翻倍再来,直到覆盖整个文件。
// 翻倍而不是一次读全文,是因为尾块几乎总能命中(见 TAIL_CHUNK 的实测),而会话文件
// 动辄几十 MB —— 每次请求全量读一遍是纯浪费。范围起点可能落在行中间,那只会让
// **该块的第一行**解析失败;翻倍后切点前移,最终 span===size 时从头读,不会漏。
function lastTitleFromFile(file, size) {
  if (!(size > 0)) return null;
  const fd = fs.openSync(file, "r");
  try {
    let span = Math.min(TAIL_CHUNK, size);
    for (;;) {
      const start = size - span;
      const buf = Buffer.allocUnsafe(span);
      fs.readSync(fd, buf, 0, span, start);
      const found = lastAiTitle(buf.toString("utf8"));
      if (found || span >= size) return found;
      span = Math.min(span * 2, size);
    }
  } finally { fs.closeSync(fd); }
}

// 入参是要查的会话标识集合,返回 Map(原标识 → 标题),查不到的**不入表** ——
// 用键在不在来区分「没有标题」与「标题是空串」,调用方一次 get 就够。
export function readSessionTitles(sessions, { root } = {}) {
  const out = new Map();
  const byUuid = new Map();
  for (const s of sessions || []) {
    const id = sessionUuidOf(s);
    if (id && !byUuid.has(id)) byUuid.set(id, s);
  }
  // 一个 hdr: 都没有时**不碰文件系统** —— 纯 pck:/dig: 的部署连目录都不必列。
  if (!byUuid.size) return out;
  const index = indexSessionFiles(root || path.join(os.homedir(), ".claude", "projects"));
  for (const [id, sess] of byUuid) {
    const hit = index.get(id);
    if (!hit) continue;
    try {
      const title = lastTitleFromFile(hit.file, hit.size);
      if (title) out.set(sess, title);
    } catch { /* 单个文件读失败不该拖垮整页 */ }
  }
  return out;
}

// ── 分档阈值。全部按线上实测定的,没有统计支撑(与排行榜的质量分权重 0.5/0.3/0.2
// 同一性质),写成具名常量便于调整。 ──
const CACHE_RATE_GOOD = 0.9;    // ≥90% 绿 —— 复用页面既有配色与阈值
const CACHE_RATE_WARN = 0.8;    // 80–90% 黄,<80% 红
const FAIL_RATE_GOOD = 0.10;    // <10% 绿 —— 复用 loadProdMe 既有阈值
const FAIL_RATE_BAD = 0.30;     // ≥30% 橙
const NEW_INPUT_GOOD = 3000;    // ≤3000 token/轮 —— 线上实测三个量级:1303.6 / 7115.1 / 7682.7
const NEW_INPUT_BAD = 8000;     // >8000 需注意

const GRADE_ORDER = { bad: 0, warn: 1, good: 2 };
const GRADE_LABEL = { good: "优", warn: "良", bad: "需注意" };
const FRAGMENT_MAX_REQUESTS = 2;   // ≤2 轮算碎片会话:开完就弃,缓存还没热就结束
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// 方向与建议都留在服务端(照 lib/leaderboard.mjs:13-14 的规矩):前端只做展示,
// 不硬编码「高好还是低好」,否则调阈值要改两处。
const gradeCacheRate = (r) => (r == null ? null : r >= CACHE_RATE_GOOD ? "good" : r >= CACHE_RATE_WARN ? "warn" : "bad");
const gradeFailRate = (r) => (r == null ? null : r < FAIL_RATE_GOOD ? "good" : r < FAIL_RATE_BAD ? "warn" : "bad");
const gradeNewInput = (r) => (r == null ? null : r <= NEW_INPUT_GOOD ? "good" : r <= NEW_INPUT_BAD ? "warn" : "bad");

const METRIC_ADVICE = {
  cache_rate: {
    warn: "缓存命中率一般:同一个任务尽量在一个会话里做完,少开新会话",
    bad: "缓存命中率偏低:这个会话在反复重建上下文,长会话连续用能显著省 token",
  },
  fail_rate: {
    warn: "有一些工具失败,留意是否在绕同一个坑",
    bad: "工具失败率偏高:会话里有较多重试或报错,建议换一种做法再继续",
  },
  new_input: {
    warn: "单轮新增上下文偏大:注意别反复粘贴大段文件,让模型自己读",
    bad: "单轮新增上下文过大:每轮都在重发大量内容,缓存基本没起作用",
  },
};

// 缓存率分母为 0 说明这一格没有任何缓存/输入可算 —— 给 null 而不是 0。
// 「没有缓存记录」与「0% 命中」是两件事,后者是假数据(照 lib/leaderboard.mjs:151-154)。
const rate = (num, den) => (den ? num / den : null);
const perTurn = (denomI, inp, requests) => (requests > 0 && (denomI > 0 || inp > 0) ? denomI / requests : null);

// 总档位取三项中**最低**的一档(短板决定),不发明权重。全为 null(采集上线前的
// 老会话没有 token 数据)时给 null —— 「没有数据」不等于「差」。
function totalGrade(grades) {
  const present = grades.filter(Boolean);
  if (!present.length) return null;
  return present.reduce((worst, g) => (GRADE_ORDER[g] < GRADE_ORDER[worst] ? g : worst), present[0]);
}

// hasToken=false 时**只给单项档位,不给总档位**。缓存率与单轮新增是会话健康的主体,
// 两项都无从测量、只凭「这轮工具调用没报错」就盖一个「优」,是拿最弱的证据下最强的
// 结论 —— 那看起来像个测量结果,其实不是(照 lib/leaderboard.mjs:64-68「宁可留空并
// 写明原因」的先例)。单项档位不连坐:fail_rate 是真实测得的,照给。
function gradeSet(cacheRate, failRate, newInput, hasToken) {
  const grades = { cache_rate: gradeCacheRate(cacheRate), fail_rate: gradeFailRate(failRate), new_input: gradeNewInput(newInput) };
  const grade = hasToken ? totalGrade([grades.cache_rate, grades.fail_rate, grades.new_input]) : null;
  return { grades, grade, gradeLabel: grade ? GRADE_LABEL[grade] : null };
}

// 只在确实偏差的指标上给建议;全优时为空数组(界面据此显示「无异常」)。
function advise(grades) {
  const out = [];
  for (const key of ["cache_rate", "fail_rate", "new_input"]) {
    const g = grades[key];
    if (g === "warn" || g === "bad") {
      const text = METRIC_ADVICE[key][g];
      if (text) out.push(text);
    }
  }
  return out;
}

function thresholds() {
  return {
    cache_rate_good: CACHE_RATE_GOOD, cache_rate_warn: CACHE_RATE_WARN,
    fail_rate_good: FAIL_RATE_GOOD, fail_rate_bad: FAIL_RATE_BAD,
    new_input_good: NEW_INPUT_GOOD, new_input_bad: NEW_INPUT_BAD,
    fragment_max_requests: FRAGMENT_MAX_REQUESTS,
  };
}

// 依赖全部注入(而不是 import production.mjs):production.mjs 在仓库根、lib/ 是子目录,
// 反向引用会绕成环。这也是 db/stmts 之外其余工具一律走形参的原因。
export function createSessionsReader(d) {
  const { responsesProfileSet, sessionProjectLabels, sessionToolStats, productionProjects, sessionKey, knownUserKeys, nameOf } = d;
  const sid = (userKey, session) => sessionKey(userKey, session);

  // resolveUserKey(server.mjs) 对**未知** key 只留前 12 字符,同一个人可能在库里留下
  // 完整 key 与 12 字符桩两条记录。会话数据与排行榜同源,带同一处瑕疵,所以照排行榜
  // 的做法把桩并回本人:桩能且仅能靠「前缀命中某个已知 key」认领。key 是 jx- + 24 位
  // 随机串,两个 key 共享前 12 位的概率可忽略,前缀匹配是确定的。
  // 在**折叠之前**归一化,所以按会话、按人、按总量三处都已经是合并后的结果。
  let stubToFull = null;
  function normalizeKey(key) {
    if (stubToFull === null) {
      stubToFull = new Map();
      for (const k of (knownUserKeys ? knownUserKeys() : [])) {
        const stub = String(k).slice(0, 12);
        if (stub !== k) stubToFull.set(stub, k);
      }
    }
    return stubToFull.get(key) || key;
  }

  const displayName = (key) => (nameOf && nameOf(key)) || `未知(${String(key).slice(0, 8)})`;

  // ── 第 1 层:按 (user_key, session) 折叠 usage_session,逐方案做协议修正后合并 ──
  // 产出的每条记录都带齐中间量,后面三级视图(会话 / 人 / 汇总 / 项目)全部从这些
  // 原始量重算比值,谁都不去反推别人的结果。
  function foldSessions(rows, toolStats) {
    const bySession = new Map();
    for (const r of rows) {
      const key = normalizeKey(r.user_key);
      const id = sid(key, r.session);
      let s = bySession.get(id);
      if (!s) {
        s = { user_key: key, session: r.session, requests: 0, inp: 0, out: 0, cr: 0, denomI: 0,
          cache_creation: 0, first_seen: r.first_seen, last_seen: r.last_seen, token_data: true };
        bySession.set(id, s);
      }
      const i = r.inp || 0, cr = r.cache_read || 0;
      s.requests += r.requests || 0;
      s.inp += i;
      s.out += r.out || 0;
      s.cache_creation += r.cache_creation || 0;
      s.cr += cr;
      // 协议修正:Responses 系的方案把缓存读折进了 input_tokens,分母要减掉,
      // 否则缓存读被算两遍(判断照 contextHealth,production.mjs)。
      s.denomI += responsesProfileSet().has(r.profile) ? Math.max(0, i - cr) : i;
      if (r.first_seen < s.first_seen) s.first_seen = r.first_seen;
      if (r.last_seen > s.last_seen) s.last_seen = r.last_seen;
    }
    // 并上「只有工具数据、没有 token 记录」的会话。采集上线**之前**的历史会话永远
    // 不会有 usage_session 行(token 从未按会话记过,也回填不了),但它们有真实的
    // 工具/编辑/项目数据。不并进来,这些会话就在界面上凭空消失 —— 用户会以为是丢数据。
    // 这类记录 token_data=false:token 与缓存率一律 null,由界面显示「—」,不显示 0。
    // toolStats 是 Map(键就是本模块的 sid),取 .values() 才是记录本身。
    for (const t of toolStats.values()) {
      const key = normalizeKey(t.user_key);
      const id = sid(key, t.session);
      if (bySession.has(id)) continue;
      bySession.set(id, {
        user_key: key, session: t.session || "", requests: 0, inp: 0, out: 0, cr: 0, denomI: 0,
        cache_creation: 0,
        // 没有轮次就借工具事件的首末时刻当会话跨度,总比整格空白有用
        first_seen: t.first_time || null, last_seen: t.last_time || null,
        token_data: false,
      });
    }
    return [...bySession.values()];
  }

  // ── 第 2 层:附上工具行为与项目归属,得到「会话行」 ──
  // tools 的键是 (user_key, session):admin 视图跨用户,session 单独做键不够 ——
  // dig: 回落(首条消息的哈希)理论上会让两个人撞进同一个会话标识。
  function decorate(s, tools, projects) {
    const t = tools.get(sid(s.user_key, s.session)) || null;
    const p = projects ? projects.get(sid(s.user_key, s.session)) : null;
    const cacheRate = rate(s.cr, s.cr + s.denomI);
    const newInput = perTurn(s.denomI, s.inp, s.requests);
    const failRate = t ? t.fail_rate : null;
    const first = s.first_seen ? Date.parse(s.first_seen) : null;
    const last = s.last_seen ? Date.parse(s.last_seen) : null;
    const durationMs = first != null && last != null ? Math.max(0, last - first) : null;
    // 只有工具数据、没有 token 记录的老会话(见 foldSessions 末尾的并集)
    const hasToken = s.token_data !== false;
    const g = gradeSet(cacheRate, failRate, newInput, hasToken);
    return {
      session: s.session,
      user_key: maskKey(s.user_key),
      user_name: displayName(s.user_key),
      // 界面据此把 token / 缓存率 / 单轮新增显示为「—」而不是 0
      token_data: hasToken,
      project: p ? p.label : null,
      // 一个会话横跨多个项目时只按权重最大的那个归属一次,被让出的条数如实带出
      // (token 是按会话记的,平摊给两个项目只会制造假精度)。
      cross_projects: p ? p.cross : 0,
      first_seen: s.first_seen, last_seen: s.last_seen,
      duration_ms: durationMs,
      // 平均轮间隔:会话里「一轮」的节奏。单轮会话给 null(除数为 0 无意义)。
      avg_gap_ms: s.requests > 1 && durationMs != null ? durationMs / (s.requests - 1) : null,
      requests: s.requests,
      tokens: s.inp + s.out,
      input_tokens: s.inp, output_tokens: s.out,
      cache_read: s.cr, cache_creation: s.cache_creation,
      // 协议修正后的新增输入(= 缓存率的分子对照量)。带出去是为了让上层的按项目/按人
      // 折叠能直接相加,而不必从 cache_rate 反解分母 —— 反解在 cache_rate 为 0 时除零。
      new_input_tokens: s.denomI,
      cache_rate: cacheRate, new_input_per_turn: newInput,
      tool_calls: t ? t.tool_calls : null,
      edits: t ? t.edits : null,
      files: t ? t.files : null,
      net_lines: t ? t.net_lines : null,
      errors: t ? t.errors : null,
      fail_rate: failRate,
      // requests=0 的会话(只有工具数据)轮数未知,不能算碎片 —— 「不知道」不是「很短」
      fragment: s.requests > 0 && s.requests <= FRAGMENT_MAX_REQUESTS,
      grades: g.grades, grade: g.grade, gradeLabel: g.gradeLabel,
      advice: advise(g.grades),
    };
  }

  // ── 第 3 层:按人折叠。绝对值相加,比值与档位从加总后的原始量**重算** ──
  // 不能对每人的会话比值取平均:一个 2 轮会话与一个 200 轮会话等权平均,等于让
  // 碎片会话主导结论。
  function foldUsers(folded, tools) {
    const acc = new Map();
    for (const s of folded) {
      const t = tools.get(sid(s.user_key, s.session)) || null;
      let a = acc.get(s.user_key);
      if (!a) {
        a = { user_key: s.user_key, sessions: 0, requests: 0, inp: 0, out: 0, cr: 0, denomI: 0,
          tool_calls: 0, errors: 0, edits: 0, files: 0, net_lines: 0, fragments: 0,
          first_seen: s.first_seen, last_seen: s.last_seen };
        acc.set(s.user_key, a);
      }
      a.sessions += 1;
      a.requests += s.requests;
      a.inp += s.inp; a.out += s.out; a.cr += s.cr; a.denomI += s.denomI;
      if (t) {
        a.tool_calls += t.tool_calls || 0;
        a.errors += t.errors || 0;
        a.edits += t.edits || 0;
        a.files += t.files || 0;
        a.net_lines += t.net_lines || 0;
      }
      if (s.requests > 0 && s.requests <= FRAGMENT_MAX_REQUESTS) a.fragments += 1;
      if (s.first_seen < a.first_seen) a.first_seen = s.first_seen;
      if (s.last_seen > a.last_seen) a.last_seen = s.last_seen;
    }
    return [...acc.values()].map((a) => {
      const cacheRate = rate(a.cr, a.cr + a.denomI);
      const newInput = perTurn(a.denomI, a.inp, a.requests);
      const failRate = rate(a.errors, a.tool_calls);
      // 这一层的「有 token 数据」判据是加总后的原始量,而不是逐会话标记:一个人只要
      // 有一个会话记过 token,他的缓存率与单轮新增就是真实测得的,不该因掺了几个
      // 采集上线前的老会话就整行失去档位。
      const g = gradeSet(cacheRate, failRate, newInput, a.cr > 0 || a.denomI > 0);
      return {
        // 这一层只喂 admin 的 /api/sessions(成员侧走 getMyActivity,不下发 users)。
        // key 是**原始**标识,只用于下钻筛选 —— 掩码后的串拼不回真实的 (profile,user_key),
        // 拿它当筛选键会查不到任何行。界面上显示的是 user_name;raw 键与 dashboard 既有
        // 的用户表(productionSummary 的 user_key)同口径,不是新的暴露面。
        key: a.user_key,
        user_key: maskKey(a.user_key), user_name: displayName(a.user_key),
        sessions: a.sessions, requests: a.requests,
        tokens: a.inp + a.out, cache_read: a.cr,
        cache_rate: cacheRate, new_input_per_turn: newInput, fail_rate: failRate,
        tool_calls: a.tool_calls, edits: a.edits, files: a.files, net_lines: a.net_lines,
        fragments: a.fragments,
        fragment_share: a.sessions ? a.fragments / a.sessions : null,
        first_seen: a.first_seen, last_seen: a.last_seen,
        grades: g.grades, grade: g.grade, gradeLabel: g.gradeLabel,
      };
    }).sort((x, y) => y.requests - x.requests || String(y.last_seen).localeCompare(String(x.last_seen)));
  }

  function summarize(folded, tools) {
    const a = { requests: 0, inp: 0, out: 0, cr: 0, denomI: 0, tool_calls: 0, errors: 0, edits: 0, files: 0, net_lines: 0, fragments: 0 };
    for (const s of folded) {
      const t = tools.get(sid(s.user_key, s.session)) || null;
      a.requests += s.requests; a.inp += s.inp; a.out += s.out; a.cr += s.cr; a.denomI += s.denomI;
      if (s.requests > 0 && s.requests <= FRAGMENT_MAX_REQUESTS) a.fragments += 1;
      if (t) {
        a.tool_calls += t.tool_calls || 0; a.errors += t.errors || 0; a.edits += t.edits || 0;
        a.files += t.files || 0; a.net_lines += t.net_lines || 0;
      }
    }
    const cacheRate = rate(a.cr, a.cr + a.denomI);
    const newInput = perTurn(a.denomI, a.inp, a.requests);
    const failRate = rate(a.errors, a.tool_calls);
    const g = gradeSet(cacheRate, failRate, newInput, a.cr > 0 || a.denomI > 0);
    return {
      sessions: folded.length,
      requests: a.requests,
      tokens: a.inp + a.out,
      cache_read: a.cr,
      cache_rate: cacheRate,
      new_input_per_turn: newInput,
      tool_calls: a.tool_calls, edits: a.edits, files: a.files, net_lines: a.net_lines,
      fail_rate: failRate,
      fragments: a.fragments,
      fragment_share: folded.length ? a.fragments / folded.length : null,
      grades: g.grades, grade: g.grade, gradeLabel: g.gradeLabel,
    };
  }

  // rows 由调用方给(全量或单用户),这里只负责折叠与装饰。
  function build({ from, to, userKey, limit, withProjects } = {}) {
    const db = d.db;
    const rows = userKey ? d.stmts.sessionRowsForUser.all(userKey, from, to) : d.stmts.sessionRows.all(from, to);
    const tools = sessionToolStats(db, { from, to, userKey: userKey || undefined });
    // 项目标签只在需要时算:它是全量路径解析,比前两者贵得多。
    const projects = withProjects === false ? null : sessionProjectLabels(db, { from, to, userKey: userKey || undefined });

    const folded = foldSessions(rows, tools);
    const sessions = folded.map((s) => decorate(s, tools, projects));
    sessions.sort((x, y) => String(y.last_seen).localeCompare(String(x.last_seen)));

    const lim = Math.min(Math.max(1, Number(limit) || DEFAULT_LIMIT), MAX_LIMIT);

    // 会话名现读(理由见 readSessionTitles 顶部)。只读会被返回的那 lim 条 —— limit 之外的
    // 会话界面上不出现,去读它们的文件纯属浪费。排序已定,这里 slice 的头一段与下面
    // sessions.slice(0, lim) 是同一批。字段一律补上(查不到为 null),让前端只判真假。
    const titles = readSessionTitles(sessions.slice(0, lim).map((s) => s.session));
    for (const s of sessions) s.title = titles.get(s.session) || null;

    // 归属率的分母:窗口内 usage_daily 的原始总量(input+output,与页面卡片同口径)。
    // 差额就是 extractSessionSignal 回落到 "nosession" 而刻意没落表的那部分 ——
    // 必须如实披露(照排行榜 cohort 的先例),不能藏。
    const totals = d.stmts.usageTotalsByUser.all(from, to)
      .filter((r) => !userKey || normalizeKey(r.user_key) === userKey)
      .reduce((acc, r) => ({ requests: acc.requests + (r.requests || 0), tokens: acc.tokens + (r.tokens || 0) }), { requests: 0, tokens: 0 });
    const attributed = sessions.reduce((acc, s) => ({ requests: acc.requests + s.requests, tokens: acc.tokens + s.tokens }), { requests: 0, tokens: 0 });
    // usage_daily 从不清理,而 usage_session 只保 90 天,所以窗口拉得足够长时已归属量
    // 只会更小;但清空数据、迁移等边缘路径仍可能让差值变负 —— 夹到 0,不显示负数。
    const unattributed = {
      requests: Math.max(0, totals.requests - attributed.requests),
      tokens: Math.max(0, totals.tokens - attributed.tokens),
    };
    // projects 一并带出:成员视图的项目分布要按 (user_key, session) 取主导项目与它的
    // 文件路径集合,拿不到这张表就只剩展示行(已掩码的 key 拼不出这个键)。
    return { folded, tools, projects, sessions, users: foldUsers(folded, tools), totals, attributed, unattributed, lim };
  }

  // 全量(admin)。userKey 给出时下钻到单人。
  function getSessions({ from, to, userKey, limit, withProjects } = {}) {
    const b = build({ from, to, userKey, limit, withProjects });
    return {
      from, to,
      summary: summarize(b.folded, b.tools),
      users: b.users,
      sessions: b.sessions.slice(0, b.lim),
      truncated: b.sessions.length > b.lim,
      totals: b.totals,
      attributed: b.attributed,
      unattributed: b.unattributed,
      thresholds: thresholds(),
      generatedAt: new Date().toISOString(),
    };
  }

  // 单人的项目分布 + 会话使用情况。成员侧一次取两个视图:它们共用同一个会话维度,
  // 拆两个端点只是多一次往返。
  //
  // 两列数字来源不同,必须说清楚,否则会被读成一个口径:
  //   · 文件 / 编辑 / 净产出 —— 取 productionProjects,与 admin 侧项目表**同一个函数、
  //     同一份路径解析、同一套路径去重**,同一个人同一段时间在两处必然同数。自己按会话
  //     求和会把「一个文件在 N 个会话里改过」数成 N 个文件。
  //   · token / 缓存率 —— 只能按会话归属。一个会话横跨多个项目时整段 token 记在主项目
  //     名下(token 是按会话记的,拆给次项目只是制造假精度),所以某个项目有文件与行数、
  //     却没有 token,说明它的编辑发生在以别的项目为主的会话里,不是没数据。
  function getMyActivity({ from, to, userKey, limit } = {}) {
    const b = build({ from, to, userKey, limit });
    const acc = new Map();
    for (const p of productionProjects(d.db, { from, to, userKey })) {
      acc.set(p.project, {
        project: p.project,
        files: p.files, edits: p.edits,
        net_lines: (p.lines_add || 0) - (p.lines_del || 0),
        sessions: 0, tokens: 0, cache_read: 0, cr: 0, denomI: 0,
      });
    }
    // 走 b.folded(内部记录)而不是 b.sessions(已掩码的展示行):项目标签按
    // (user_key, session) 取,掩码后的 key 拼不出这个键。
    for (const s of b.folded) {
      const meta = b.projects ? b.projects.get(sid(s.user_key, s.session)) : null;
      if (!meta) continue;   // 纯问答会话没有文件路径 → 不进项目分布
      // 主导项目理论上必在 productionProjects 的行里;它的 50 行上限把长尾截掉时补一行
      // 空的,免得这段 token 凭空消失(文件与行数给 null,界面显示「—」而不是 0)。
      let p = acc.get(meta.label);
      if (!p) acc.set(meta.label, p = { project: meta.label, files: null, edits: null,
        net_lines: null, sessions: 0, tokens: 0, cache_read: 0, cr: 0, denomI: 0 });
      p.sessions += 1;
      p.tokens += s.inp + s.out;
      p.cache_read += s.cr;
      // 缓存率按会话各自修正好之后再相加,用的是原始量(缓存读 + 协议修正后的新增输入),
      // 不去反解任何已算好的比值 —— 反解会在命中率为 0 时除零。
      p.cr += s.cr;
      p.denomI += s.denomI;
    }
    const projects = [...acc.values()].map((p) => {
      const { cr, denomI, ...row } = p;
      return {
        ...row,
        cache_rate: rate(cr, cr + denomI),
        // 这个项目名下一条 token 记录都没有(采集上线前的老会话,或编辑全发生在别人的
        // 主项目会话里):界面显示「—」,而不是看起来像测得「花了 0 token、命中 0%」。
        token_data: p.tokens > 0 || cr + denomI > 0,
      };
    }).sort((x, y) => (y.tokens - x.tokens) || ((y.net_lines || 0) - (x.net_lines || 0)));

    return {
      from, to,
      projects,
      // 有会话横跨多个项目的条数:它们只归属给了主项目,次项目被低估。如实标注。
      crossSessions: b.sessions.filter((s) => s.cross_projects > 0).length,
      sessionSummary: summarize(b.folded, b.tools),
      sessions: b.sessions.slice(0, b.lim),
      truncated: b.sessions.length > b.lim,
      totals: b.totals,
      attributed: b.attributed,
      unattributed: b.unattributed,
      thresholds: thresholds(),
      generatedAt: new Date().toISOString(),
    };
  }

  return { getSessions, getMyActivity };
}
