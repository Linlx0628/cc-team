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
export function cnDayStartIso(nowMs = Date.now()) {
  const shifted = cnNow(nowMs);
  const dayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(dayStart - 8 * 3600000).toISOString();
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