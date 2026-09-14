// lib/schedule.mjs —— 北京时间的时间窗规则。纯函数，零外部依赖。两块内容：
//
// 1. 高峰时段：格式 [{start:"HH:mm", end:"HH:mm"}]；end < start 表示跨午夜（如 22:00-02:00）。
//    驱动两件事：高峰模型别名、峰/谷配额倍率。
//
// 2. 方案组调度（下半部分）：命名方案组 + 「星期几 + 时间段」规则，决定每个请求用哪套
//    方案优先级。规则首条命中胜；跨午夜规则的 days 归于**窗口起始日**；start/end 同为
//    null 表示全天。config 一律当参数传入，本模块不 import 任何东西。

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

// ── 方案组调度 ───────────────────────────────────────────────────────────────
// 三个 config 顶层键参与本块，全部由调用方以参数传入（本模块不读 config）：
//   scheduleGroups   { 组名: { protocol, members: [方案名...] } }  有序，下标即优先级
//   scheduleRules    { anthropic: [规则...], responses: [规则...] } 有序，首条命中胜
//   scheduleOverride { 协议: { group, expiresAt, at, by } }        手动指定，绝对 UTC 到期
//
// 两个旧的顶层数组（defaultProfileGroup / responsesProfileGroup）保持原样，作为「基础组」，
// 规则用 "@base" 引用它。这样 isDefault 派生、组编辑器、既有测试全部零改动，而规则表为空时
// 生效组恒等于基础组 —— 功能完全惰性，行为与升级前逐字节一致。

export const BASE_GROUP_TOKEN = "@base";
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];  // getUTCDay() 口径：0=周日
export const DAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];  // 下标 = getUTCDay()
export const GROUP_NAME_MAX = 24;

// 北京星期与「当天第几分钟」，与 isInPeakHours / nextRateChangeHint 同一表达式。
export function beijingDayOfWeek(date = new Date()) {
  return new Date(date.getTime() + 8 * 3600000).getUTCDay();
}

export function beijingMinutesOfDay(date = new Date()) {
  return ((date.getTime() + 8 * 3600000) % 86400000) / 60000;
}

// 手动指定到期时刻的兜底：规则表里没有任何会翻转的边界时，用到下一个北京 00:00 为止。
// （星期几只在日界变化，所以日界是唯一可能改变生效组而没有任何 start/end 的时刻。）
export function msUntilNextBeijingMidnight(date = new Date()) {
  const bj = date.getTime() + 8 * 3600000;
  return (Math.floor(bj / 86400000) + 1) * 86400000 - bj;
}

// 星期数组归一：返回升序去重的合法值数组；返回 null 表示该规则应被丢弃。
// `null`/缺省 = 每天（JSON 作者省略即表示不做星期限制）；**空数组与非数组都判为非法** ——
// 「一个都没选」按「每天」理解是静默放宽，正是本功能最该避免的失败方式。保存通道同样拒绝。
export function normalizeScheduleDays(raw) {
  if (raw === null || raw === undefined) return ALL_DAYS.slice();
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return null;
  const set = new Set();
  for (const v of raw) {
    const n = typeof v === "number" ? v : (typeof v === "string" && /^\d+$/.test(v.trim()) ? parseInt(v.trim(), 10) : NaN);
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
  }
  if (set.size === 0) return null;  // 全非法 → 丢弃整条规则，不扩成每天
  return [...set].sort((a, b) => a - b);
}

// 组名严格校验（保存通道用，抛中文错）。迁移通道用内部宽松版，见 normalizeScheduleGroups。
export function normalizeScheduleGroupName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new Error("方案组名称不能为空");
  if (name.length > GROUP_NAME_MAX) throw new Error(`方案组名称过长（最多 ${GROUP_NAME_MAX} 字）`);
  if (name.startsWith("@")) throw new Error("方案组名称不能以 @ 开头");
  return name;
}

// 单条规则归一。返回 null 表示丢弃该条。groupExists(name) 判断命名组是否存在于该协议下。
export function normalizeScheduleRule(raw, groupExists) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const group = typeof raw.group === "string" ? raw.group.trim() : "";
  if (!group) return null;
  if (group !== BASE_GROUP_TOKEN && !(typeof groupExists === "function" && groupExists(group))) return null;
  const days = normalizeScheduleDays(raw.days);
  if (days === null) return null;
  const hasStart = raw.start !== null && raw.start !== undefined && raw.start !== "";
  const hasEnd = raw.end !== null && raw.end !== undefined && raw.end !== "";
  let start = null, end = null;
  if (hasStart || hasEnd) {
    if (!hasStart || !hasEnd) return null;  // 只给一端 → 丢弃，宁可报错也不猜
    start = parsePeakTimeMinutes(raw.start);
    end = parsePeakTimeMinutes(raw.end);
    if (start === null || end === null || start === end) return null;
    start = String(raw.start).trim();
    end = String(raw.end).trim();
  }
  const rule = { days, start, end, group };
  if (raw.enabled === false) rule.enabled = false;
  if (typeof raw.note === "string" && raw.note.trim()) rule.note = raw.note.trim().slice(0, 40);
  return rule;
}

export function normalizeScheduleRules(raw, groupExists) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const rule = normalizeScheduleRule(item, groupExists);
    if (rule) out.push(rule);
  }
  return out;
}

// 命名组归一：{ 组名: { protocol, members } }。成员必须存在且与本组协议一致，否则剪掉；
// **成员被剪空的组保留**（通常来自「组里的方案被删了」）—— 连组带规则一起静默丢掉会让用户
// 配置凭空消失，留着并由设置页标红才是诚实的失败方式。
// protocolOfProfile(name) 返回该方案的归一协议（"anthropic"/"responses"），方案不存在返回 null。
export function normalizeScheduleGroups(raw, protocolOfProfile) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  const protoOf = (name) => (typeof protocolOfProfile === "function" ? protocolOfProfile(name) : null);
  for (const [key, value] of Object.entries(raw)) {
    const name = typeof key === "string" ? key.trim() : "";
    if (!name || name.length > GROUP_NAME_MAX || name.startsWith("@")) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const declared = value.protocol === "responses" ? "responses" : "anthropic";
    const members = [];
    for (const m of Array.isArray(value.members) ? value.members : []) {
      if (typeof m !== "string") continue;
      const member = m.trim();
      if (!member || members.includes(member)) continue;
      const mp = protoOf(member);
      if (mp === null || mp !== declared) continue;
      members.push(member);
    }
    out[name] = { protocol: declared, members };
  }
  return out;
}

// 规则是否命中该时刻。days 指**窗口起始日**：跨午夜窗口 周六 22:00–周日 02:00 在周日 01:00
// 命中（它属于周六那条规则），在周五 01:00 不命中。朴素实现（拿当前星期直接过滤）会让
// 「周六 22:00 到凌晨 2 点」在周日凌晨那段凭空失效 —— 那正是用户最需要它的时候。
export function matchesScheduleRule(rule, date = new Date()) {
  if (!rule || typeof rule !== "object") return false;
  if (rule.enabled === false) return false;
  const days = Array.isArray(rule.days) ? rule.days : ALL_DAYS;
  if (days.length === 0) return false;
  const day = beijingDayOfWeek(date);
  // 先判 null（= 全天）再解析时间：parsePeakTimeMinutes 对 null 与非法字符串**都**返回 null，
  // 若把「返回 null」一律当全天，一条手写坏的 "9:00" 就会静默变成全天规则。
  if (rule.start === null || rule.end === null || rule.start === undefined || rule.end === undefined) {
    return days.includes(day);
  }
  const start = parsePeakTimeMinutes(rule.start);
  const end = parsePeakTimeMinutes(rule.end);
  if (start === null || end === null || start === end) return false;
  const minutes = beijingMinutesOfDay(date);
  if (start < end) return days.includes(day) && minutes >= start && minutes < end;
  const prevDay = (day + 6) % 7;  // 午夜后那段属于窗口起始日 = 昨天
  return (days.includes(day) && minutes >= start) || (days.includes(prevDay) && minutes < end);
}

// 首条命中胜：数组顺序即优先级，永不排序。
export function matchScheduleRule(rules, date = new Date()) {
  if (!Array.isArray(rules)) return null;
  for (let i = 0; i < rules.length; i++) {
    if (matchesScheduleRule(rules[i], date)) return { rule: rules[i], index: i };
  }
  return null;
}

// 某个命名组在指定协议下的成员副本；组不存在、协议不符、或名称为 @base 之外的未知名字 → []。
function membersOfGroup(groups, name) {
  if (!groups || typeof groups !== "object") return [];
  const g = groups[name];
  if (!g || !Array.isArray(g.members)) return [];
  return g.members.filter(m => typeof m === "string" && m);
}

// 生效组解析：整个请求路径唯一入口。优先级 手动指定 > 首条命中的规则 > 基础组。
// 整体 try/catch —— 调度配置损坏绝不能让请求 500，任何异常都退化成「这个功能没开」。
// 注意形参默认值只兜 undefined：显式传 null 会在**解构时**抛，而那时还没进 try，兜底是假的。
// 所以先落成局部变量再判类型。
export function resolveEffectiveGroup(opts, protocol, date = new Date()) {
  const { baseGroup, groups, rules, override } = (opts && typeof opts === "object") ? opts : {};
  const base = Array.isArray(baseGroup) ? baseGroup.filter(n => typeof n === "string" && n) : [];
  const fallback = { members: base.slice(), source: "base", groupName: BASE_GROUP_TOKEN, ruleIndex: -1, rule: null };
  try {
    const proto = protocol === "responses" ? "responses" : "anthropic";
    // 1) 手动指定（未到期的绝对时刻）
    if (override && typeof override === "object") {
      const until = Date.parse(override.expiresAt);
      if (Number.isFinite(until) && until > date.getTime()) {
        const g = override.group;
        let members = null;
        if (g === BASE_GROUP_TOKEN) members = base;
        else if (groups && groups[g] && groups[g].protocol === proto) members = membersOfGroup(groups, g);
        if (members && members.length > 0) {
          return { members: members.slice(), source: "manual", groupName: g, ruleIndex: -1, rule: null, overrideUntil: override.expiresAt };
        }
      }
    }
    // 2) 首条命中且组非空的规则。组为空时**继续往下找**：用户本意几乎肯定是想用那条组，
    //    退到下一条同样在规则表里的规则比直接跳回基础组更接近意图，两者都不会让请求失败。
    const list = Array.isArray(rules) ? rules : [];
    for (let i = 0; i < list.length; i++) {
      const rule = list[i];
      if (!matchesScheduleRule(rule, date)) continue;
      let members;
      if (rule.group === BASE_GROUP_TOKEN) members = base;
      else if (groups && groups[rule.group] && groups[rule.group].protocol === proto) members = membersOfGroup(groups, rule.group);
      else continue;
      if (members.length === 0) continue;
      return { members: members.slice(), source: "rule", groupName: rule.group, ruleIndex: i, rule };
    }
    return fallback;
  } catch {
    return fallback;
  }
}

// 下一个**会改变生效组**的时刻。用途：手动指定的 expiresAt、设置页「下次切换」。
// 算法照 lib/quota.mjs nextRateChangeHint 的 delta 技巧，但因为规则带星期，边界可能落在几天
// 之后（周五 13:00 之后的下一次翻转是周一 09:00），所以候选集合取未来 8 天的全部 start/end
// 加上每天的北京 00:00（星期只在日界变化），取最近一个真正改变生效组的。没有任何改变 → null。
// 「改变」比较的是**生效组名**而不是规则下标：两条规则指向同一个组时，那个时刻什么都不会变，
// 报出「下次切换 13:00」会是一句假话。
export function nextScheduleBoundary(rules, date = new Date()) {
  const list = Array.isArray(rules) ? rules.filter(r => r && typeof r === "object") : [];
  if (list.length === 0) return null;
  const groupNameAt = (instant) => {
    const hit = matchScheduleRule(list, instant);
    return hit ? hit.rule.group : BASE_GROUP_TOKEN;
  };
  const nowMs = date.getTime();
  const nowGroup = groupNameAt(date);
  const bjDayStart = Math.floor((nowMs + 8 * 3600000) / 86400000) * 86400000;
  // 一天的候选时刻：所有 start/end，加上 00:00（星期只在日界变化，所以日界本身也是候选）。
  const offsets = new Set([0]);
  for (const r of list) {
    const s = parsePeakTimeMinutes(r.start);
    const e = parsePeakTimeMinutes(r.end);
    if (s !== null) offsets.add(s);
    if (e !== null) offsets.add(e);
  }
  let best = null;
  // 8 天足够覆盖任何「按星期」的周期：最坏情况是每周只在一个星期的窄窗口里生效的规则，
  // 两次翻转相隔 7 天。
  for (let d = 0; d <= 8; d++) {
    for (const off of offsets) {
      const instant = new Date(bjDayStart + d * 86400000 + off * 60000 - 8 * 3600000);
      const deltaMs = instant.getTime() - nowMs;
      if (deltaMs <= 0) continue;
      if (best && deltaMs >= best.deltaMs) continue;
      const group = groupNameAt(instant);
      if (group === nowGroup) continue;
      best = {
        at: `${String(Math.floor(off / 60)).padStart(2, "0")}:${String(off % 60).padStart(2, "0")}`,
        deltaMs,
        ruleIndex: matchScheduleRule(list, instant)?.index ?? -1,
        group,
      };
    }
  }
  return best;
}

// 规则摘要，审计与设置页共用（前端不重复实现，避免两份实现漂移）。
export function formatScheduleRuleSummary(rule) {
  if (!rule || typeof rule !== "object") return "";
  const group = rule.group === BASE_GROUP_TOKEN ? "基础组" : String(rule.group || "");
  return `${formatScheduleDays(rule.days)} ${formatScheduleWindow(rule)} → ${group}`;
}

// 星期标签按中文习惯 周一…周日 渲染。用「位置」口径（0=周一 … 6=周日）再做区间合并，
// 这样「周五、周六、周日」是一段真连续的区间，能渲染成「周五~周日」，而存储里是升序的
// getUTCDay()（0=周日），所以两者之间要做一次 (d+6)%7 的映射。
export function formatScheduleDays(days) {
  const list = Array.isArray(days) && days.length ? days : ALL_DAYS;
  const valid = list.filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
  const pos = [...new Set(valid.map(d => (d + 6) % 7))].sort((a, b) => a - b);
  if (pos.length === 0 || pos.length === 7) return "每天";
  const label = (p) => DAY_LABELS[(p + 1) % 7];
  const parts = [];
  let s = pos[0], e = pos[0];
  // 只有 +1 步进才会延长区间，所以 e-s>=2 必然是三段以上真连续，可以用「~」。
  const flush = () => {
    if (e - s >= 2) parts.push(`${label(s)}~${label(e)}`);
    else if (e === s) parts.push(label(s));
    else parts.push(`${label(s)}、${label(e)}`);
  };
  for (const p of pos.slice(1)) {
    if (p === e + 1) { e = p; continue; }
    flush();
    s = e = p;
  }
  flush();
  return parts.join("、");
}

export function formatScheduleWindow(rule) {
  if (!rule || rule.start === null || rule.end === null || rule.start === undefined || rule.end === undefined) return "全天";
  return `${rule.start}-${rule.end}`;
}

// 配置健康度，供设置页「不静默」地标红：哪些规则永远不可能生效、哪些组已经空了。
export function describeScheduleHealth({ groups, rules, override } = {}, protocol) {
  const proto = protocol === "responses" ? "responses" : "anthropic";
  const emptyGroups = [];
  for (const [name, g] of Object.entries(groups && typeof groups === "object" ? groups : {})) {
    if (!g || g.protocol !== proto) continue;
    if (!Array.isArray(g.members) || g.members.length === 0) emptyGroups.push(name);
  }
  const inertRules = [];
  const list = Array.isArray(rules) ? rules : [];
  for (let i = 0; i < list.length; i++) {
    const rule = list[i];
    if (!rule || rule.enabled === false) continue;
    if (rule.group === BASE_GROUP_TOKEN) continue;
    const g = groups && groups[rule.group];
    if (!g || g.protocol !== proto) inertRules.push({ index: i, group: rule.group, reason: "unknown_group" });
    else if (!Array.isArray(g.members) || g.members.length === 0) inertRules.push({ index: i, group: rule.group, reason: "empty_group" });
  }
  const until = override && typeof override === "object" ? Date.parse(override.expiresAt) : NaN;
  return { inertRules, emptyGroups, overrideAlive: Number.isFinite(until) && until > Date.now() };
}