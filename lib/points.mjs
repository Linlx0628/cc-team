// lib/points.mjs —— 「点数」预算：计权 token 与点数的换算、周期预算判超、429 文案。
// 纯函数，零外部依赖（只引用 ./time.mjs 的周期锚点）。
//
// 为什么点数 = 计权 token / 10000：倍率在记账那一刻就已经乘进 weighted_tokens
// （见 server.mjs recordUsage「Weight the request at the rate in force right now」），
// 所以 1 点天然等于「10000 个计权 token」，「模型倍率 × token」的语义不需要本模块
// 再算一遍 —— 它只做单位换算与判超，绝不重算历史（改倍率只影响之后的请求）。
//
// 判定口径一律用计权 token（limitWeighted / usedWeighted），点数只是展示与配置单位；
// 舍入只影响显示，不影响 allowed/exhausted —— 否则「界面上还差 0.4 点」与「已经 429」
// 会不一致，用户无从判断。

import {
  normalizePeriod,
  periodStartDate,
  periodEndDate,
  nextPeriodStartDate,
} from "./time.mjs";

export const POINTS_UNIT = 10000;              // 1 点 = 10000 计权 token
export const MAX_BUDGET_POINTS = 10_000_000;   // 单周期预算上限（1000 亿计权 token）
export const POINT_PERIODS = ["day", "week", "month"];
// 运营计费系数：只作用于点数，不改变额度池倍率。单级 0.10~10.00，
// 用户 × 方案 的乘积封顶 100，避免误配把一个人瞬间烧穿。
export const BILLING_FACTOR_MIN = 0.1;
export const BILLING_FACTOR_MAX = 10;
export const BILLING_FACTOR_PRODUCT_MAX = 100;
// 点数口径下缓存 token 的相对权重：缓存读 = 新鲜输入的 10%，缓存写 = 1%。
// 统一口径，不再按方案单独配置。倍率 2 时读=0.2、写=0.02。
// 只影响点数，不影响额度池 weighted_tokens。
export const POINT_CACHE_READ_FACTOR = 0.1;
export const POINT_CACHE_WRITE_FACTOR = 0.01;

// 点数计费输入：新鲜输入 + 缓存读×0.1 + 缓存写×0.01（未乘点数倍率/系数）。
// 保持浮点返回，最终由调用方 Math.round 一次，避免在缓存很小的时候先舍入成 0。
export function pointBillableInput(freshInput, cacheRead = 0, cacheWrite = 0, readFactor, writeFactor) {
  const fresh = Math.max(0, Number(freshInput) || 0);
  const read = Math.max(0, Number(cacheRead) || 0);
  const write = Math.max(0, Number(cacheWrite) || 0);
  const rf = readFactor != null && Number.isFinite(Number(readFactor)) && Number(readFactor) >= 0 ? Number(readFactor) : POINT_CACHE_READ_FACTOR;
  const wf = writeFactor != null && Number.isFinite(Number(writeFactor)) && Number(writeFactor) >= 0 ? Number(writeFactor) : POINT_CACHE_WRITE_FACTOR;
  return fresh + read * rf + write * wf;
}

const NOTE_MAX = 200;
const PERIOD_LABEL = { day: "日", week: "周", month: "月" };
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 预算配置归一。坏值降级而不是抛错（配置读入路径与 lib/quota.mjs 的归一函数同风格）：
//   · 整个 budget 缺失（null/undefined）→ enabled:false，等于「未开启点数模式」
//   · 对象存在但没写 enabled → enabled:true（写了配置就是要用，只有显式 false 才关）
//   · budgetPoints 取整并夹到 [0, MAX_BUDGET_POINTS]
//   · period 非法回落 day；startsAt 非法回落 ""（从周期首日起算）
//   · note 是管理员备注（原样展示），去首尾空白、截断 200 字
export function normalizePointBudget(raw) {
  const src = raw && typeof raw === "object" ? raw : null;
  const enabled = src ? src.enabled !== false : false;
  const points = Number(src ? src.budgetPoints : 0);
  const budgetPoints = Number.isFinite(points)
    ? Math.min(MAX_BUDGET_POINTS, Math.max(0, Math.round(points)))
    : 0;
  const period = normalizePeriod(src ? src.period : "");
  const startsAt = normalizeStartDate(src ? src.startsAt : "");
  const note = String((src && src.note) ?? "").trim().slice(0, NOTE_MAX);
  const billingFactor = normalizeBillingFactor(src ? src.billingFactor : 1);
  return { enabled, budgetPoints, period, startsAt, note, billingFactor };
}

// 方案级点数上限（profilePointLimits[profile].users[userKey] / .total）。
// 与用户总预算分开归一：默认关闭，必须显式启用且点数 > 0；周期缺省月。
// startsAt 用于“月中新加的上限从今天起算”，避免拿当月历史用量立刻把成员拦住。
export function normalizeProfilePointLimit(raw) {
  const src = raw && typeof raw === "object" ? raw : null;
  const pointsRaw = Number(src ? src.points : 0);
  const points = Number.isFinite(pointsRaw)
    ? Math.min(MAX_BUDGET_POINTS, Math.max(0, Math.round(pointsRaw)))
    : 0;
  const period = src && POINT_PERIODS.includes(String(src.period)) ? String(src.period) : "month";
  const startsAtRaw = normalizeStartDate(src ? src.startsAt : "");
  const startsAtDate = startsAtRaw ? new Date(startsAtRaw + "T00:00:00Z") : null;
  const startsAt = startsAtDate && !Number.isNaN(startsAtDate.getTime()) && startsAtDate.toISOString().slice(0, 10) === startsAtRaw
    ? startsAtRaw : "";
  return { enabled: !!src && src.enabled !== false && points > 0, points, period, startsAt };
}

// 单级计费系数：坏值/缺省一律 1（默认不改变任何人的点数）；
// 保留两位小数，夹在 [0.1, 10]。0 不允许——那等于免费，容易误配。
export function normalizeBillingFactor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  const rounded = Math.round(n * 100) / 100;
  return Math.min(BILLING_FACTOR_MAX, Math.max(BILLING_FACTOR_MIN, rounded));
}

// 用户系数 × 方案系数。两级都归一后相乘，再封顶 100；
// 结果保留 4 位，避免浮点尾巴进入计费。
export function effectiveBillingFactor(userFactor, planFactor) {
  const product = normalizeBillingFactor(userFactor) * normalizeBillingFactor(planFactor);
  return Math.round(Math.min(BILLING_FACTOR_PRODUCT_MAX, product) * 10000) / 10000;
}

function normalizeStartDate(value) {
  const s = String(value ?? "").trim();
  if (!ISO_DATE_RE.test(s)) return "";
  // 正则挡不住 2026-13-01 这种「格式对、日历错」的值；Date.parse 会回 NaN。
  return Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? "" : s;
}

// 点 → 计权 token。非有限值/负数一律 0（预算不能是负数）。
export function pointsToWeighted(points) {
  const n = Number(points);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * POINTS_UNIT);
}

// 计权 token → 点（展示口径，四舍五入）。判定从不使用它的结果。
export function weightedToPoints(weighted) {
  const n = Number(weighted);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / POINTS_UNIT);
}

// 周期预算的完整视图。budget 传归一前后都可以（进来先 normalizePointBudget）。
// usedWeighted 由调用方用 stmts.sumPointUsageRange 查出来（只含点数模式请求），窗口下界是 windowStart：
//   windowStart = max(periodStart, startsAt)   —— startsAt 可中途启用
// periodStart 保留「日历周期首日」（页面要显示「本月从 10-01 起」），窗口起点单列
// windowStart，避免调用方把两者混用导致中期启用的预算多算前半段用量。
export function computePointsUsage({ budget, usedWeighted, today, nowMs } = {}) {
  const b = normalizePointBudget(budget);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  // today 显式传入时用它锚定整个周期(测试与「按已算好的北京日期判定」的调用方),
  // 否则用 nowMs 推出北京当日。两者必须同源,否则 periodStart 与判定日会错位。
  const hasToday = ISO_DATE_RE.test(String(today || ""));
  const day = hasToday ? String(today) : periodStartDate("day", now);
  const anchorMs = hasToday ? Date.parse(`${day}T00:00:00+08:00`) : now;
  const periodStart = periodStartDate(b.period, anchorMs);
  const periodEnd = periodEndDate(b.period, anchorMs);
  const nextStart = nextPeriodStartDate(b.period, anchorMs);
  const windowStart = b.startsAt && b.startsAt > periodStart ? b.startsAt : periodStart;

  // 关闭时不生效的预算按 0 计(与 lib/quota.mjs 里「无限制」返回 limit:0 同口径):
  // 预算点数额在 budgetPoints 里照常给出,别用 limitWeighted 当展示值。
  const limitWeighted = b.enabled ? pointsToWeighted(b.budgetPoints) : 0;
  // 窗口还没开始（startsAt 在未来）时，本周期用量必然为 0 —— 防御性归零，不让
  // 调用方传进来的历史用量在预算生效前就把人拦住。
  const used = day < windowStart ? 0 : Math.max(0, Number(usedWeighted) || 0);

  const usedPoints = weightedToPoints(used);
  const exhausted = b.enabled ? used >= limitWeighted : false;
  const allowed = b.enabled ? used < limitWeighted : true;
  const remainingWeighted = b.enabled ? Math.max(0, limitWeighted - used) : Infinity;
  // 剩余点数按「预算 − 已用（点）」算，保证页面「已用 + 剩余 = 预算」自洽；
  // 与 remainingWeighted（精确计权差）可能因舍入差 1 点，判定以 weighted 为准。
  const remainingPoints = b.enabled ? Math.max(0, b.budgetPoints - usedPoints) : Infinity;
  // 精确展示值：预算按整数点配置，但一次请求通常远小于 1 点；如果 UI 只显示
  // usedPoints 的整数，连续少量请求看起来会「一直不动」。判定仍只用 weighted。
  const usedPointsExact = b.enabled ? Math.round((used / POINTS_UNIT) * 100) / 100 : 0;
  const remainingPointsExact = b.enabled
    ? Math.max(0, Math.round((b.budgetPoints - used / POINTS_UNIT) * 100) / 100)
    : Infinity;
  const overPoints = b.enabled ? weightedToPoints(Math.max(0, used - limitWeighted)) : 0;
  const overPointsExact = b.enabled ? Math.max(0, Math.round(((used - limitWeighted) / POINTS_UNIT) * 100) / 100) : 0;
  const pct = !b.enabled
    ? null
    : (limitWeighted > 0 ? Math.round((used / limitWeighted) * 1000) / 10 : (used > 0 ? 100 : 0));

  return {
    enabled: b.enabled,
    period: b.period,
    periodStart,
    periodEnd,
    nextPeriodStart: nextStart,
    startsAt: b.startsAt,
    windowStart,
    budgetPoints: b.budgetPoints,
    limitWeighted,
    usedWeighted: used,
    usedPoints,
    usedPointsExact,
    remainingWeighted,
    remainingPoints,
    remainingPointsExact,
    overPoints,
    overPointsExact,
    pct,
    exhausted,
    allowed,
    source: "points",
  };
}

const fmt = (n) => (Number.isFinite(n) ? Number(n).toLocaleString("en-US") : "∞");

// 429 文案。风格对齐 lib/quota.mjs 的 quotaExceededMessage：先说结论，再给折算，
// 再给周期窗口与恢复时间，最后给用量页地址。points 传 computePointsUsage() 的结果。
export function pointsExceededMessage(points, usageUrl) {
  const p = points || {};
  const label = PERIOD_LABEL[p.period] || "日";
  const lines = [
    `本${label}点数预算已用尽：已用 ${fmt(p.usedPoints)} 点 / 预算 ${fmt(p.budgetPoints)} 点` +
      `（计权 token ${fmt(p.usedWeighted)} / ${fmt(p.limitWeighted)}，1 点 = ${POINTS_UNIT} 计权 token）`,
  ];
  if (p.overPoints > 0) lines.push(`已超出 ${fmt(p.overPoints)} 点。`);
  lines.push(`本周期 ${p.periodStart} ~ ${p.periodEnd}${p.startsAt ? `（预算自 ${p.startsAt} 起算）` : ""}`);
  lines.push(`点数将于北京时间 ${p.nextPeriodStart || p.periodEnd} 00:00 恢复（下一周期）。`);
  if (usageUrl) lines.push(`查看我的用量与点数明细: ${usageUrl}`);
  return lines.join("\n");
}

// 写进 errors 表 / 审计详情的一行技术口径（对齐 quotaErrorDetail 的风格）。
export function pointsErrorDetail(points) {
  const p = points || {};
  return `points_exceeded: ${p.usedPoints}/${p.budgetPoints}pt` +
    ` (weighted ${p.usedWeighted}/${p.limitWeighted}, period=${p.period} ${p.periodStart}~${p.periodEnd}` +
    `${p.startsAt ? `, from ${p.startsAt}` : ""})`;
}

// 方案级上限的 429 文案。profilePoints 由 server 的 checkProfilePointLimit 返回。
export function profilePointsExceededMessage(profilePoints, usageUrl) {
  const p = profilePoints || {};
  const hit = p.blocking === "total" ? p.total : p.user;
  const label = hit && hit.period === "week" ? "周" : hit && hit.period === "month" ? "月" : "日";
  const scope = p.blocking === "total" ? "本方案总点数上限" : "你在这个方案的点数上限";
  const lines = [
    `方案「${p.profile || "当前方案"}」的${scope}已用尽（本${label}）：` +
      `${fmt(hit && hit.usedPoints)} / ${fmt(hit && hit.budgetPoints)} 点。`,
    `本周期 ${hit ? hit.periodStart : ""} ~ ${hit ? hit.periodEnd : ""}，` +
      `将于北京时间 ${hit ? (hit.nextPeriodStart || hit.periodEnd) : ""} 00:00 恢复。`,
  ];
  if (p.blocking !== "total" && p.total && p.total.enabled && p.total.exhausted) {
    lines.push(`（本方案总上限也已用尽：${fmt(p.total.usedPoints)} / ${fmt(p.total.budgetPoints)} 点）`);
  }
  if (usageUrl) lines.push(`查看我的用量: ${usageUrl}`);
  return lines.join("\n");
}

export function profilePointsErrorDetail(profilePoints) {
  const p = profilePoints || {};
  const hit = p.blocking === "total" ? p.total : p.user;
  return `profile_points_exceeded: profile=${p.profile || ""} scope=${p.blocking || "user"} ` +
    `${hit ? `${hit.usedPoints}/${hit.budgetPoints}pt (${hit.period} ${hit.periodStart}~${hit.periodEnd})` : ""}`;
}
