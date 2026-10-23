// lib/time.mjs —— UTC+8（北京时间）时间工具。纯函数，零外部依赖。
// 全项目用户可见时钟一律走这里换算；存储层时刻是 UTC ISO，展示再 +8（见仓库约定）。

export function cnNow(now = Date.now()) { return new Date(now + 8 * 3600000); }

export function cnDate() { return cnNow().toISOString().slice(0, 10); }

export function cnHour() { return cnNow().toISOString().slice(11, 13); }

// 半时存储键 "HH:MM"(MM 恒为 00/30),北京时间。键面即图表 x 轴标签,前端不需要再做格式转换。
// 定宽补零且第 2 位恒为 ":",所以 TEXT 字典序恰好等于时间序;也正好让 substr(hour,1,2) 成为
// 合法的小时提取器(空转告警靠它同时命中新旧两种键)。
// 必须对分钟向下取整 —— 把上面那行机械推广成 slice(11,16) 会给出 "13:47":那种行照样落库、
// 照样匹配 substr(hour,1,2) 与 hourIsPeak,唯独任何一张图都查不到它,是个全静默的坑。
export function cnHalfHour() {
  const d = cnNow();
  return d.toISOString().slice(11, 13) + (d.getUTCMinutes() < 30 ? ":00" : ":30");
}

export function secondsUntilNextCnMidnight(now = Date.now()) {
  const shifted = new Date(now + 8 * 3600000);
  const nextShiftedMidnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1);
  return Math.max(1, Math.ceil((nextShiftedMidnight - 8 * 3600000 - now) / 1000));
}

// 本周一 00:00 北京时间 ISO —— 配额申请「每周上限」的锚点。
export function cnWeekStartIso(nowMs = Date.now()) {
  const shifted = cnNow(nowMs);
  const dow = (shifted.getUTCDay() + 6) % 7; // Monday = 0
  const mondayShiftedMidnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - dow);
  return new Date(mondayShiftedMidnight - 8 * 3600000).toISOString();
}

// 本周一的北京日期串（YYYY-MM-DD）—— 统计按「日期」而非「时刻」比对时用这个。
// 注意：不能写 cnWeekStartIso().slice(0, 10)。那个 ISO 是「周一 00:00 +08」那一刻，
// 其 UTC 日期部分落在**前一天**（周一 00:00 +08 == 周日 16:00Z），直接截取会少算一天。
export function cnWeekStartDate(nowMs = Date.now()) {
  return new Date(new Date(cnWeekStartIso(nowMs)).getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

// 今日 00:00 北京时间 ISO —— 固定「每人每日一次」规则。
// 任意北京日期串 → 所在周的周一 / 所在月 1 日。点数用量按日/周/月三层落桶，
// 记录时刻只拿得到「今天」，但补历史时也需要按任意日期算桶，所以不接受 nowMs。
export function weekStartDateOf(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  const dow = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}
export function monthStartDateOf(dateStr) {
  return String(dateStr).slice(0, 7) + "-01";
}
export function cnDayStartIso(nowMs = Date.now()) {
  const shifted = cnNow(nowMs);
  const dayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(dayStart - 8 * 3600000).toISOString();
}

// ── 点数预算的周期锚点（日 / 周 / 月，北京时间）──────────────────────────────
// 周期一律用「北京日期串」表达：periodStartDate 返回周期首日、periodEndDate 返回周期
// 末日（含）、nextPeriodStartDate 返回下一周期首日。周从周一开始（与 cnWeekStartDate
// 同口径），月是自然月。日期串是纯日历语义，加减天数/月数走 Date.UTC，不受时区偏移
// 影响；只有把边界换算成「还剩多少秒」时才需要 +08:00。
//
// 为什么单独有 periodEndDate：usage_daily.date 是北京日期串，周期查询是
// `date >= 首日 AND date <= 末日` 的闭区间；把「末日」写成 nextPeriodStartDate 会让
// 调用方各自减一天，减错一次就静默少统计一整天（月初/年初最容易踩）。
const PERIOD_NAMES = ["day", "week", "month"];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 宽松归一（配置读入用）：未知 / 空值回落到 day，不抛错 —— 与 lib/quota.mjs 的
// 归一函数同一风格：坏的配置值降级成默认值，而不是让整台网关起不来。
export function normalizePeriod(period) {
  const p = String(period ?? "").trim().toLowerCase();
  return PERIOD_NAMES.includes(p) ? p : "day";
}

function requirePeriod(period) {
  const p = String(period ?? "").trim().toLowerCase();
  if (!PERIOD_NAMES.includes(p)) throw new Error(`未知周期 "${period}"（只支持 day/week/month）`);
  return p;
}

// 纯日历加法：date 必须是 YYYY-MM-DD，days 可负。Date.UTC 的月份/日期溢出会
// 自动进位，所以跨月、跨年、闰年都不需要特判。
export function addDaysToDate(date, days) {
  if (!ISO_DATE_RE.test(String(date))) throw new Error(`非法日期 "${date}"（应为 YYYY-MM-DD）`);
  const [y, m, d] = String(date).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + (Number(days) || 0))).toISOString().slice(0, 10);
}

export function periodStartDate(period, nowMs = Date.now()) {
  const p = requirePeriod(period);
  const shifted = cnNow(nowMs);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();       // 0-based
  const d = shifted.getUTCDate();
  if (p === "day") return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  if (p === "week") {
    const dow = (shifted.getUTCDay() + 6) % 7;  // Monday = 0
    return new Date(Date.UTC(y, m, d - dow)).toISOString().slice(0, 10);
  }
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

export function nextPeriodStartDate(period, nowMs = Date.now()) {
  const p = requirePeriod(period);
  const start = periodStartDate(p, nowMs);
  if (p === "day") return addDaysToDate(start, 1);
  if (p === "week") return addDaysToDate(start, 7);
  const [y, m] = start.split("-").map(Number);   // m 是 1-based，正好等于 Date.UTC 的下一月
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

export function periodEndDate(period, nowMs = Date.now()) {
  return addDaysToDate(nextPeriodStartDate(period, nowMs), -1);
}

// 距当前周期结束还有多少秒 —— 即到下一周期首日 00:00（北京）的秒数。
// 与 secondsUntilNextCnMidnight 同口径：向上取整、至少 1，可直接写进 Retry-After。
export function secondsUntilNextPeriodEnd(period, nowMs = Date.now()) {
  const p = requirePeriod(period);
  const next = nextPeriodStartDate(p, nowMs);
  const boundaryMs = Date.parse(`${next}T00:00:00+08:00`);
  return Math.max(1, Math.ceil((boundaryMs - nowMs) / 1000));
}

// 日期范围查询参数解析（/api/my-activity、/api/my-usage 的可选 start/end）。
// 返回 null 表示「两个参数都没给」，调用方走各自的默认窗口；给了就校验并归一。
// 规则与 dashboard 前端一致：只给其一另一头自动补齐（end 缺省今天、start 缺省从
// 结束日往前 400 天），start>end 对调；跨度上限 400 天 —— 对齐 usage_daily 系列的
// 保留期，再远的窗口查出来也是空的，不如直接拒绝。
const DAY_MS = 86400000;
export function parseDateRange(start, end) {
  if ((start == null || start === "") && (end == null || end === "")) return null;
  const fail = (msg) => { const e = new Error(msg); e.statusCode = 400; throw e; };
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (start && !re.test(start)) fail("开始日期格式应为 YYYY-MM-DD");
  if (end && !re.test(end)) fail("结束日期格式应为 YYYY-MM-DD");
  let s = start || "";
  let e = end || "";
  if (!e) e = cnDate();
  if (!s) s = new Date(Date.parse(e + "T00:00:00Z") - 399 * DAY_MS).toISOString().slice(0, 10);
  if (Number.isNaN(Date.parse(s + "T00:00:00Z")) || Number.isNaN(Date.parse(e + "T00:00:00Z"))) {
    fail("日期无效");
  }
  if (s > e) { const t = s; s = e; e = t; }
  if ((Date.parse(e + "T00:00:00Z") - Date.parse(s + "T00:00:00Z")) / DAY_MS > 399) {
    fail("日期跨度最多 400 天");
  }
  return { start: s, end: e };
}