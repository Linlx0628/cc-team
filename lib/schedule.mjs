// lib/schedule.mjs —— 高峰时段（北京时间）解析与判定。纯函数，零外部依赖。
// 格式 [{start:"HH:mm", end:"HH:mm"}]；end < start 表示跨午夜（如 22:00-02:00）。
// 驱动两件事：高峰模型别名、峰/谷配额倍率。

export const PEAK_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parsePeakTimeMinutes(t) {
  if (typeof t !== "string") return null;
  const m = PEAK_TIME_RE.exec(t.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export function normalizePeakHours(raw) {
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

// 高峰区间按北京时间（UTC+8）判定，与每日配额重置（cnNow）口径一致。`date` 为瞬时，`new Date()` 亦可用。
export function isInPeakHours(ranges, date = new Date()) {
  if (!Array.isArray(ranges) || ranges.length === 0) return false;
  const minutes = ((date.getTime() + 8 * 3600000) % 86400000) / 60000;
  for (const r of ranges) {
    const start = parsePeakTimeMinutes(r.start);
    const end = parsePeakTimeMinutes(r.end);
    if (start === null || end === null || start === end) continue;
    if (start < end) {
      if (minutes >= start && minutes < end) return true;
    } else if (minutes >= start || minutes < end) { // crosses midnight
      return true;
    }
  }
  return false;
}

export function formatPeakHoursSummary(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return "";
  return ranges.map(r => `${r.start}-${r.end}`).join(", ");
}