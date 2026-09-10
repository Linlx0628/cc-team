// lib/time.mjs —— UTC+8（北京时间）时间工具。纯函数，零外部依赖。
// 全项目用户可见时钟一律走这里换算；存储层时刻是 UTC ISO，展示再 +8（见仓库约定）。

export function cnNow(now = Date.now()) { return new Date(now + 8 * 3600000); }

export function cnDate() { return cnNow().toISOString().slice(0, 10); }

export function cnHour() { return cnNow().toISOString().slice(11, 13); }

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

// 今日 00:00 北京时间 ISO —— 固定「每人每日一次」规则。
export function cnDayStartIso(nowMs = Date.now()) {
  const shifted = cnNow(nowMs);
  const dayStart = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(dayStart - 8 * 3600000).toISOString();
}