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