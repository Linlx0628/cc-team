// lib/report-export.mjs —— 方案用量报告导出(HTML + XLSX)+ 后台导出任务管理。
//
// 需求:方案中心每行「导出」按钮 → 弹窗选 月度/周度 → 后台生成该方案该时间段的
// 用量报告(token 汇总/请求次数/模型分布/用户分布/每日趋势/每日×用户),
// 产出一份排版工整的 HTML + 一份信息详细的 Excel,存 <项目根>/exportFile/,
// dashboard 顶部「文件管理」可查看进度并下载。导出全程不阻塞页面。
//
// 数据口径(与 dashboard 各面板一致,均为 usage_daily 系列表的北京日期聚合):
//   总Token = 输入 + 输出 + 缓存写入 + 缓存读取
//   计权Token = weighted_tokens(配额口径,含计价倍率折算)
// ⚠️ usage_daily_model/client/hourly 只保留 400 天(persistence.pruneOldDataIfNewDay),
//    更早周期的「模型使用」sheet 会是空的;usage_daily 主表全史保留,其余内容不受影响。

import fs from "node:fs";
import path from "node:path";
import { buildXlsx, num, numBold, bold } from "./xlsx.mjs";
import { cnDate, cnNow } from "./time.mjs";

// ── 日期工具(全部基于北京日期串 YYYY-MM-DD) ─────────────────────────────────
// 一天 86400000ms;北京日期串即 UTC+8 的日历日,直接用 Date.UTC 做日期算术。

function parseIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function isoOf(d) {
  return d.toISOString().slice(0, 10);
}

// 北京日期串所在周的周一(周一~周日为一周,与 dashboard「周使用」口径一致)
export function weekStartOf(dateStr) {
  const d = parseIsoDate(dateStr);
  if (!d) return null;
  const dow = d.getUTCDay(); // 0=周日 … 6=周六
  const shift = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return isoOf(d);
}

function addDays(dateStr, n) {
  const d = parseIsoDate(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return isoOf(d);
}

// 月末最后一天(2026-02 → 2026-02-28/29;2026-04 → 2026-04-30)
export function monthEndOf(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || "");
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  if (mo < 1 || mo > 12) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, "0")}`;
}

// 周期解析:month:"2026-09" → {from,to};week:"2026-10-12"(周一) → from=周一 to=周日
export function resolvePeriod(period, value) {
  if (period === "month") {
    const m = /^(\d{4})-(\d{2})$/.exec(value || "");
    if (!m || +m[2] < 1 || +m[2] > 12) return null;
    return { from: `${value}-01`, to: monthEndOf(value) };
  }
  if (period === "week") {
    const start = weekStartOf(value);
    if (!start) return null;
    return { from: start, to: addDays(start, 6) };
  }
  return null;
}

function fmtCn(n) {
  return (Number(n) || 0).toLocaleString("zh-CN");
}

// ── 数据采集 ────────────────────────────────────────────────────────────────
// 4 条 SQL 覆盖报告全部内容;usage_daily 主表(user 维度)LEFT JOIN users 拿姓名。

export function collectPlanReport(db, { suffix, from, to, profileName, protocol, upstream }) {
  const range = { suffix, from, to, profileName: profileName || suffix, protocol: protocol || "", upstream: upstream || "" };
  range.generatedAt = cnDate() + " " + cnNow().toISOString().slice(11, 16) + " (UTC+8)";

  const sumRow = (r) => ({
    input: r?.ti || 0,
    output: r?.to_ || 0,
    cacheWrite: r?.cc || 0,
    cacheRead: r?.cr || 0,
    weighted: r?.w || 0,
    requests: r?.rq || 0,
    total: (r?.ti || 0) + (r?.to_ || 0) + (r?.cc || 0) + (r?.cr || 0),
  });

  // 1) 每日汇总(usage_daily 按天)
  const dailyRows = db
    .prepare(
      `SELECT date, SUM(input_tokens) ti, SUM(output_tokens) to_, SUM(cache_creation) cc, SUM(cache_read) cr, SUM(weighted_tokens) w, SUM(requests) rq
       FROM usage_daily WHERE profile=? AND date>=? AND date<=? GROUP BY date ORDER BY date`,
    )
    .all(suffix, from, to);
  range.daily = dailyRows.map((r) => ({ date: r.date, ...sumRow(r) }));

  // 2) 用户汇总(姓名取 users 表,关联不上的留 user_key 兜底)
  const userRows = db
    .prepare(
      `SELECT d.user_key k, MAX(COALESCE(u.name,'')) name, SUM(d.input_tokens) ti, SUM(d.output_tokens) to_,
              SUM(d.cache_creation) cc, SUM(d.cache_read) cr, SUM(d.weighted_tokens) w, SUM(d.requests) rq,
              MAX(d.date) last_day, COUNT(DISTINCT d.date) active_days
       FROM usage_daily d LEFT JOIN users u ON u.profile=d.profile AND u.user_key=d.user_key
       WHERE d.profile=? AND d.date>=? AND d.date<=? GROUP BY d.user_key ORDER BY w DESC`,
    )
    .all(suffix, from, to);
  range.users = userRows.map((r) => ({
    key: r.k,
    name: r.name || r.k,
    lastDay: r.last_day,
    activeDays: r.active_days,
    ...sumRow(r),
  }));

  // 3) 模型汇总(⚠️ 400 天保留期,老周期可能为空)
  const modelRows = db
    .prepare(
      `SELECT model, SUM(input_tokens) ti, SUM(output_tokens) to_, 0 AS cc, 0 AS cr,
              SUM(weighted_tokens) w, SUM(requests) rq
       FROM usage_daily_model WHERE profile=? AND date>=? AND date<=? GROUP BY model ORDER BY w DESC`,
    )
    .all(suffix, from, to);
  range.models = modelRows.map((r) => ({ model: r.model || "(unknown)", ...sumRow(r) }));

  // 4) 每日×用户矩阵(HTML 矩阵 + Excel 明细 sheet 用)
  const matrixRows = db
    .prepare(
      `SELECT date, user_key k, SUM(input_tokens) ti, SUM(output_tokens) to_, SUM(cache_creation) cc,
              SUM(cache_read) cr, SUM(weighted_tokens) w, SUM(requests) rq
       FROM usage_daily WHERE profile=? AND date>=? AND date<=? GROUP BY date, user_key ORDER BY date, w DESC`,
    )
    .all(suffix, from, to);
  const byUser = new Map();
  for (const u of range.users) byUser.set(u.key, u);
  const matrix = new Map(); // userKey -> Map(date -> row)
  for (const r of matrixRows) {
    if (!byUser.has(r.k)) {
      // 防御:users 汇总里没出现过的 user(理论不可能,聚合源相同)也收进来
      const u = { key: r.k, name: r.k, lastDay: r.date, activeDays: 0, ...sumRow(null) };
      byUser.set(r.k, u);
      range.users.push(u);
    }
    if (!matrix.has(r.k)) matrix.set(r.k, new Map());
    matrix.get(r.k).set(r.date, sumRow(r));
  }
  range.matrix = matrix;
  range.days = range.daily.map((d) => d.date);

  // 汇总卡片
  const total = sumRow(
    dailyRows.reduce((a, r) => ({ ti: (a.ti || 0) + r.ti, to_: (a.to_ || 0) + r.to_, cc: (a.cc || 0) + r.cc, cr: (a.cr || 0) + r.cr, w: (a.w || 0) + r.w, rq: (a.rq || 0) + r.rq }), {}),
  );
  range.summary = {
    ...total,
    activeUsers: range.users.length,
    daysWithData: range.daily.length,
  };
  return range;
}

// ── HTML 报告(自包含、零外链、可直接发群/打印;风格对齐 production.mjs 报告) ────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function maskKey(k) {
  const s = String(k || "");
  return s.length > 12 ? s.slice(0, 12) + "****" : s;
}

export function buildReportHTML(report) {
  const { summary, daily, users, models, matrix, days } = report;
  const periodLabel = `${report.from} ~ ${report.to}`;
  const kindLabel = report.period === "month" ? "月度" : "周度";
  const maxDaily = Math.max(1, ...daily.map((d) => d.total));

  const userDayCell = (uKey, date) => {
    const cell = matrix.get(uKey)?.get(date);
    if (!cell) return "";
    return `<td class="n cell-has" title="${esc(`请求 ${fmtCn(cell.requests)}`)}">${esc(fmtCn(cell.total))}</td>`;
  };

  const dailyRowsHtml =
    daily
      .map(
        (d) => `<tr>
  <td>${esc(d.date)}</td>
  <td class="n">${esc(fmtCn(d.requests))}</td>
  <td class="n">${esc(fmtCn(d.input))}</td>
  <td class="n">${esc(fmtCn(d.output))}</td>
  <td class="n">${esc(fmtCn(d.cacheWrite))}</td>
  <td class="n">${esc(fmtCn(d.cacheRead))}</td>
  <td class="n hl">${esc(fmtCn(d.total))}</td>
  <td class="n">${esc(fmtCn(d.weighted))}</td>
  <td class="bar-cell"><div class="bar"><i style="width:${Math.max(d.total > 0 ? 1.5 : 0, (d.total / maxDaily) * 100).toFixed(1)}%"></i></div></td>
</tr>`,
      )
      .join("") || `<tr><td class="empty" colspan="9">该周期无数据</td></tr>`;

  const userRowsHtml =
    users
      .map(
        (u) => `<tr>
  <td>${esc(u.name)}</td>
  <td class="mono">${esc(maskKey(u.key))}</td>
  <td class="n">${esc(fmtCn(u.requests))}</td>
  <td class="n">${esc(fmtCn(u.input))}</td>
  <td class="n">${esc(fmtCn(u.output))}</td>
  <td class="n">${esc(fmtCn(u.cacheWrite))}</td>
  <td class="n">${esc(fmtCn(u.cacheRead))}</td>
  <td class="n hl">${esc(fmtCn(u.total))}</td>
  <td class="n">${esc(fmtCn(u.weighted))}</td>
  <td class="n">${esc(fmtCn(u.activeDays))}</td>
  <td>${esc(u.lastDay || "-")}</td>
</tr>`,
      )
      .join("") || `<tr><td class="empty" colspan="11">该周期无数据</td></tr>`;

  const modelRowsHtml =
    models
      .map(
        (m) => `<tr>
  <td>${esc(m.model)}</td>
  <td class="n">${esc(fmtCn(m.requests))}</td>
  <td class="n">${esc(fmtCn(m.input))}</td>
  <td class="n">${esc(fmtCn(m.output))}</td>
  <td class="n">${esc(fmtCn(m.cacheWrite))}</td>
  <td class="n">${esc(fmtCn(m.cacheRead))}</td>
  <td class="n hl">${esc(fmtCn(m.total))}</td>
  <td class="n">${esc(fmtCn(m.weighted))}</td>
</tr>`,
      )
      .join("") || `<tr><td class="empty" colspan="8">该周期无数据(模型明细仅保留 400 天)</td></tr>`;

  // 每日×用户矩阵:行=用户,列=日期(周期最长 31 天,横向可滚)
  const matrixHead = days.map((d) => `<th class="n">${esc(d.slice(5))}</th>`).join("");
  const matrixBody =
    users
      .map((u) => {
        const cells = days.map((d) => userDayCell(u.key, d)).join("");
        const rowTotal = days.reduce((a, d) => a + (matrix.get(u.key)?.get(d)?.total || 0), 0);
        return `<tr><th class="rowh">${esc(u.name)}</th>${cells}<td class="n hl">${esc(fmtCn(rowTotal))}</td></tr>`;
      })
      .join("") || `<tr><td class="empty" colspan="${days.length + 2}">该周期无数据</td></tr>`;
  const matrixFoot = days
    .map((d) => `<td class="n">${esc(fmtCn(daily.find((x) => x.date === d)?.total || 0))}</td>`)
    .join("");
  const matrixTable = days.length
    ? `<div class="tbl-scroll"><table class="matrix"><thead><tr><th>用户 \\ 日期</th>${matrixHead}<th class="n">合计</th></tr></thead><tbody>${matrixBody}</tbody><tfoot><tr><th class="rowh">当日合计</th>${matrixFoot}<td class="n hl">${esc(fmtCn(summary.total))}</td></tr></tfoot></table></div>`
    : `<div class="empty-block">该周期无数据</div>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(report.profileName)} ${esc(kindLabel)}用量报告 ${esc(periodLabel)}</title>
<style>
:root{--accent:#2f6e50;--line:#e5e7eb;--dim:#6b7280}
*{box-sizing:border-box}
body{font:14px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937;background:#fbfbf8;margin:0;padding:28px 20px 40px}
.wrap{max-width:1080px;margin:0 auto}
h1{font-size:21px;margin:0 0 4px;letter-spacing:.2px}
.sub{color:var(--dim);font-size:12.5px;margin-bottom:20px}
.sub b{color:#1f2937}
.badge{display:inline-block;background:#eef4f0;color:var(--accent);border:1px solid #d6e4dc;border-radius:4px;padding:1px 8px;font-size:11px;margin-left:8px;vertical-align:2px}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:18px 0 8px}
.tile{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.tile .k{font-size:11px;color:var(--dim)}
.tile .v{font-size:19px;font-weight:650;margin-top:3px;font-variant-numeric:tabular-nums;letter-spacing:-.2px}
h2{font-size:15.5px;margin:30px 0 10px;padding-left:10px;border-left:3px solid var(--accent)}
.note{font-size:11.5px;color:var(--dim);margin:-4px 0 10px}
.tbl-scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:#fff}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{border-bottom:1px solid #eef0ee;padding:7px 10px;text-align:left;white-space:nowrap}
thead th{background:#f3f4f1;font-weight:600;font-size:11.5px;color:#374151;position:sticky;top:0}
tbody tr:last-child td,tfoot th,tfoot td{border-bottom:none}
tfoot tr{border-top:2px solid var(--line);background:#fafaf7;font-weight:600}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
td.hl{color:var(--accent);font-weight:650}
td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dim)}
td.empty{text-align:center;color:var(--dim);padding:22px 0}
.empty-block{background:#fff;border:1px dashed var(--line);border-radius:8px;color:var(--dim);text-align:center;padding:26px 0;font-size:12.5px}
td.bar-cell{min-width:120px}
.bar{background:#eef2ee;border-radius:3px;height:8px;overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#4d8a6d,#2f6e50);border-radius:3px}
table.matrix td,table.matrix th{white-space:nowrap}
table.matrix thead th{z-index:2}
table.matrix .rowh{position:sticky;left:0;background:#f3f4f1;text-align:left;font-weight:600}
table.matrix td.cell-has{background:#f2f7f3}
.foot{margin-top:26px;color:var(--dim);font-size:11.5px;line-height:1.8;border-top:1px solid var(--line);padding-top:12px}
@media print{body{background:#fff;padding:0}.tbl-scroll{overflow:visible;border-radius:0}}
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(report.profileName)} · ${esc(kindLabel)}用量报告<span class="badge">${esc(report.protocol || "—")}</span></h1>
  <div class="sub">周期 <b>${esc(periodLabel)}</b>${report.upstream ? ` · 上游 <b>${esc(report.upstream)}</b>` : ""} · 生成于 ${esc(report.generatedAt)}</div>

  <div class="tiles">
    <div class="tile"><div class="k">请求次数</div><div class="v">${esc(fmtCn(summary.requests))}</div></div>
    <div class="tile"><div class="k">输入 Token</div><div class="v">${esc(fmtCn(summary.input))}</div></div>
    <div class="tile"><div class="k">输出 Token</div><div class="v">${esc(fmtCn(summary.output))}</div></div>
    <div class="tile"><div class="k">缓存写入</div><div class="v">${esc(fmtCn(summary.cacheWrite))}</div></div>
    <div class="tile"><div class="k">缓存读取</div><div class="v">${esc(fmtCn(summary.cacheRead))}</div></div>
    <div class="tile"><div class="k">总 Token(含缓存)</div><div class="v">${esc(fmtCn(summary.total))}</div></div>
    <div class="tile"><div class="k">计权 Token(配额口径)</div><div class="v">${esc(fmtCn(summary.weighted))}</div></div>
    <div class="tile"><div class="k">活跃用户</div><div class="v">${esc(fmtCn(summary.activeUsers))}</div></div>
    <div class="tile"><div class="k">有数据天数</div><div class="v">${esc(fmtCn(summary.daysWithData))}</div></div>
  </div>

  <h2>每日用量</h2>
  <div class="tbl-scroll"><table>
    <thead><tr><th>日期</th><th class="n">请求</th><th class="n">输入</th><th class="n">输出</th><th class="n">缓存写入</th><th class="n">缓存读取</th><th class="n">总Token</th><th class="n">计权Token</th><th>占比</th></tr></thead>
    <tbody>${dailyRowsHtml}</tbody>
    <tfoot><tr><th>合计</th><td class="n">${esc(fmtCn(summary.requests))}</td><td class="n">${esc(fmtCn(summary.input))}</td><td class="n">${esc(fmtCn(summary.output))}</td><td class="n">${esc(fmtCn(summary.cacheWrite))}</td><td class="n">${esc(fmtCn(summary.cacheRead))}</td><td class="n">${esc(fmtCn(summary.total))}</td><td class="n">${esc(fmtCn(summary.weighted))}</td><td></td></tr></tfoot>
  </table></div>

  <h2>用户使用情况</h2>
  <div class="tbl-scroll"><table>
    <thead><tr><th>用户</th><th>Key</th><th class="n">请求</th><th class="n">输入</th><th class="n">输出</th><th class="n">缓存写入</th><th class="n">缓存读取</th><th class="n">总Token</th><th class="n">计权Token</th><th class="n">活跃天数</th><th>最近活跃</th></tr></thead>
    <tbody>${userRowsHtml}</tbody>
    <tfoot><tr><th>合计</th><th></th><td class="n">${esc(fmtCn(summary.requests))}</td><td class="n">${esc(fmtCn(summary.input))}</td><td class="n">${esc(fmtCn(summary.output))}</td><td class="n">${esc(fmtCn(summary.cacheWrite))}</td><td class="n">${esc(fmtCn(summary.cacheRead))}</td><td class="n">${esc(fmtCn(summary.total))}</td><td class="n">${esc(fmtCn(summary.weighted))}</td><td colspan="2"></td></tr></tfoot>
  </table></div>

  <h2>模型请求情况</h2>
  <div class="note">⚠️ 模型明细仅保留最近 400 天,更早的周期此表可能为空。</div>
  <div class="tbl-scroll"><table>
    <thead><tr><th>模型</th><th class="n">请求</th><th class="n">输入</th><th class="n">输出</th><th class="n">缓存写入</th><th class="n">缓存读取</th><th class="n">总Token</th><th class="n">计权Token</th></tr></thead>
    <tbody>${modelRowsHtml}</tbody>
  </table></div>

  <h2>每日 × 用户明细(总 Token)</h2>
  ${matrixTable}

  <div class="foot">
    口径说明:总 Token = 输入 + 输出 + 缓存写入 + 缓存读取;计权 Token 为配额口径(含模型/时段计价倍率折算)。<br>
    时间口径为北京时间(UTC+8);周报为周一 ~ 周日。数据来源:token-monitor usage_daily 聚合表。
  </div>
</div>
</body>
</html>`;
}

// ── XLSX 报告(信息详细;sheet 顺序:汇总/每日用量/每日×用户/用户汇总/模型使用) ──
export function buildReportXlsx(report) {
  const { summary, daily, users, models, matrix, days } = report;
  const meta = [
    ["方案用量报告", null],
    ["方案", report.profileName],
    ["协议", report.protocol || "—"],
    ["上游", report.upstream || "—"],
    ["周期类型", report.period === "month" ? "月度" : "周度"],
    ["周期", `${report.from} ~ ${report.to}`],
    ["生成时间", report.generatedAt],
    [null, null],
    ["指标", "数值"],
    [bold("请求数"), numBold(summary.requests)],
    [bold("输入 Token"), numBold(summary.input)],
    [bold("输出 Token"), numBold(summary.output)],
    [bold("缓存写入 Token"), numBold(summary.cacheWrite)],
    [bold("缓存读取 Token"), numBold(summary.cacheRead)],
    [bold("总 Token(含缓存)"), numBold(summary.total)],
    [bold("计权 Token(配额口径)"), numBold(summary.weighted)],
    [bold("活跃用户数"), numBold(summary.activeUsers)],
    [bold("有数据天数"), numBold(summary.daysWithData)],
    [null, null],
    ["口径说明", "总 Token = 输入 + 输出 + 缓存写入 + 缓存读取;计权 Token 为配额口径(含模型/时段计价倍率);时间口径北京时间(UTC+8);周报为周一~周日"],
    ["⚠️ 注意", "模型明细仅保留最近 400 天(usage_daily_model 清理策略),更早周期「模型使用」sheet 可能为空"],
  ];

  const dailyRows = [["日期", "请求", "输入", "输出", "缓存写入", "缓存读取", "总Token", "计权Token"].map((h) => ({ v: h, style: 3 }))];
  for (const d of daily) dailyRows.push([d.date, num(d.requests), num(d.input), num(d.output), num(d.cacheWrite), num(d.cacheRead), num(d.total), num(d.weighted)]);
  dailyRows.push([{ v: "合计", style: 1 }, numBold(summary.requests), numBold(summary.input), numBold(summary.output), numBold(summary.cacheWrite), numBold(summary.cacheRead), numBold(summary.total), numBold(summary.weighted)]);

  const matrixRows = [];
  const head = ["用户", ...days, "合计"];
  matrixRows.push(head.map((h) => ({ v: h, style: 3 })));
  for (const u of users) {
    const cells = days.map((d) => {
      const c = matrix.get(u.key)?.get(d);
      return c ? num(c.total) : "";
    });
    const rowTotal = days.reduce((a, d) => a + (matrix.get(u.key)?.get(d)?.total || 0), 0);
    matrixRows.push([bold(u.name), ...cells, numBold(rowTotal)]);
  }
  matrixRows.push([{ v: "当日合计", style: 1 }, ...days.map((d) => numBold(daily.find((x) => x.date === d)?.total || 0)), numBold(summary.total)]);

  const userRows = [["用户", "Key", "请求", "输入", "输出", "缓存写入", "缓存读取", "总Token", "计权Token", "活跃天数", "最近活跃"].map((h) => ({ v: h, style: 3 }))];
  for (const u of users) userRows.push([u.name, maskKey(u.key), num(u.requests), num(u.input), num(u.output), num(u.cacheWrite), num(u.cacheRead), num(u.total), num(u.weighted), num(u.activeDays), u.lastDay || "-"]);
  userRows.push([{ v: "合计", style: 1 }, "", numBold(summary.requests), numBold(summary.input), numBold(summary.output), numBold(summary.cacheWrite), numBold(summary.cacheRead), numBold(summary.total), numBold(summary.weighted), "", ""]);

  const modelRows = [["模型", "请求", "输入", "输出", "缓存写入", "缓存读取", "总Token", "计权Token"].map((h) => ({ v: h, style: 3 }))];
  for (const m of models) modelRows.push([m.model, num(m.requests), num(m.input), num(m.output), num(m.cacheWrite), num(m.cacheRead), num(m.total), num(m.weighted)]);
  if (!models.length) modelRows.push(["该周期无数据(模型明细仅保留 400 天)"]);

  return buildXlsx(
    [
      { name: "汇总", rows: meta },
      { name: "每日用量", rows: dailyRows },
      { name: "每日×用户", rows: matrixRows },
      { name: "用户汇总", rows: userRows },
      { name: "模型使用", rows: modelRows },
    ],
    { when: new Date() },
  );
}

// ── 后台导出任务管理器 ────────────────────────────────────────────────────────
// 内存 Map + exportFile/index.json 落盘(临时文件+rename 原子写);重启时恢复列表,
// 未完成任务标记失败。任务串行执行(setImmediate 让出事件循环,HTTP 先回包)。

export function createPlanExportManager({ db, dir, listProfiles, getProfileNameBySuffix, onDone } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const jobs = new Map();
  const indexPath = path.join(dir, "index.json");

  const saveIndex = () => {
    const payload = JSON.stringify({ version: 1, jobs: [...jobs.values()].map(serializeJob) }, null, 2);
    const tmp = indexPath + ".tmp";
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, indexPath);
  };

  function serializeJob(j) {
    return { ...j, files: j.files.map((f) => ({ ...f })) };
  }

  // 启动恢复:读 index.json;queued/running → failed(服务重启中断);文件缺失照实记录
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    for (const j of raw.jobs || []) {
      if (j.status === "queued" || j.status === "running") {
        j.status = "failed";
        j.error = "服务重启,任务中断,请重新导出";
        j.finishedAt = Date.now();
      }
      jobs.set(j.id, j);
    }
    saveIndex(); // 中断标记落盘
  } catch {
    /* 首次运行没有 index.json,正常 */
  }

  const running = [];
  let active = false;

  function jobId() {
    return "exp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);
  }

  function runNext() {
    if (active || !running.length) return;
    active = true;
    const job = running.shift();
    job.status = "running";
    job.startedAt = Date.now();
    saveIndex();
    setImmediate(() => {
      try {
        const report = collectPlanReport(db, {
          suffix: job.suffix,
          from: job.from,
          to: job.to,
          profileName: job.profileName,
          protocol: job.protocol,
          upstream: job.upstream,
        });
        const base = `plan-${job.suffix}-${job.period}-${job.from}_${job.to}`;
        const files = [];
        const html = buildReportHTML(report);
        const htmlPath = path.join(dir, base + ".html");
        fs.writeFileSync(htmlPath, html);
        files.push({ kind: "html", name: base + ".html", size: Buffer.byteLength(html) });
        const xlsx = buildReportXlsx(report);
        const xlsxPath = path.join(dir, base + ".xlsx");
        fs.writeFileSync(xlsxPath, xlsx);
        files.push({ kind: "xlsx", name: base + ".xlsx", size: xlsx.length });
        job.files = files;
        job.status = "done";
        job.finishedAt = Date.now();
      } catch (err) {
        job.status = "failed";
        job.error = err && err.message ? err.message : String(err);
        job.finishedAt = Date.now();
      }
      saveIndex();
      active = false;
      if (onDone) try { onDone(job); } catch {}
      runNext();
    });
  }

  function startJob({ profile, period, value }) {
    const suffix = String(profile || "");
    const p = resolvePeriod(period, value);
    if (!p) throw new Error("周期格式不合法:month 传 YYYY-MM,week 传周一日期 YYYY-MM-DD");
    if (!["month", "week"].includes(period)) throw new Error("period 只支持 month / week");
    const prof = listProfiles().find((x) => x.suffix === suffix);
    if (!prof) throw new Error(`未知方案:${suffix}`);
    const job = {
      id: jobId(),
      suffix,
      profileName: getProfileNameBySuffix ? getProfileNameBySuffix(suffix) : prof.name,
      protocol: prof.protocol || "",
      upstream: prof.upstream || "",
      period,
      value,
      from: p.from,
      to: p.to,
      status: "queued",
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      files: [],
    };
    jobs.set(job.id, job);
    running.push(job);
    saveIndex();
    runNext();
    return job;
  }

  // 任务列表:筛选(方案/状态/周期类型) + 分页。返回值除当前页 jobs 外,
  // 还带全量任务的状态表 statuses(id → {status,name})与去重方案清单 plans ——
  // 两者与筛选分页无关:小圆点/toast 提醒和筛选下拉必须看到全部任务,不受当前页限制。
  function listJobs(opts = {}) {
    const all = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
    const statuses = {};
    const seen = new Map();
    for (const j of all) {
      statuses[j.id] = { status: j.status, name: j.profileName };
      // 失败任务把原因捎给 toast,不用为看原因再翻任务卡
      if (j.status === "failed") statuses[j.id].err = j.error || "";
      if (!seen.has(j.suffix)) seen.set(j.suffix, j.profileName);
    }
    const plans = [...seen.entries()].map(([suffix, name]) => ({ suffix, name }));
    let list = all;
    const suffix = String(opts.suffix || "");
    if (suffix) list = list.filter((j) => j.suffix === suffix);
    const status = String(opts.status || "");
    if (status) list = list.filter((j) => j.status === status);
    const period = String(opts.period || "");
    if (period) list = list.filter((j) => j.period === period);
    const total = list.length;
    // pageSize 默认 10,夹在 1..100;page 越界时夹回最后一页(前端翻过头不报错)
    const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(opts.pageSize)) || 10));
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(pages, Math.max(1, Math.trunc(Number(opts.page)) || 1));
    return {
      jobs: list.slice((page - 1) * pageSize, page * pageSize),
      total,
      page,
      pageSize,
      pages,
      statuses,
      plans,
    };
  }

  function getJob(id) {
    return jobs.get(id) || null;
  }

  function filePath(job, kind) {
    const f = job.files.find((x) => x.kind === kind);
    if (!f) return null;
    const p = path.join(dir, f.name);
    // 防目录穿越:name 由服务端生成,但这里仍按白名单再校验一次
    if (path.dirname(p) !== dir || f.name.includes("/") || f.name.includes("\\") || f.name.includes("..")) return null;
    return fs.existsSync(p) ? p : null;
  }

  // 可导出周期:从该方案最早数据日到今天,连续的月/周列表(新→旧),并给当前周期
  function listPeriods(suffix) {
    const today = cnDate();
    const row = db.prepare("SELECT MIN(date) mn, MAX(date) mx FROM usage_daily WHERE profile=?").get(suffix);
    const min = row?.mn || today;
    const months = [];
    const weeks = [];
    const curMonth = today.slice(0, 7);
    const curWeek = weekStartOf(today);
    const firstMonth = (min || today).slice(0, 7);
    // 月列表:从最早数据月到当月,倒序,封顶 60 个月
    let ym = curMonth;
    for (let i = 0; i < 60; i++) {
      months.push(ym);
      if (ym <= firstMonth) break;
      const [y, m] = ym.split("-").map(Number);
      const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
      ym = prev;
    }
    // 周列表:从本周一回溯到最早数据周的周一,倒序,封顶 104 周
    let ws = curWeek;
    for (let i = 0; i < 104; i++) {
      const we = addDays(ws, 6);
      weeks.push({ start: ws, end: we, label: `${ws} ~ ${we.slice(5)}` });
      if (ws <= weekStartOf(min)) break;
      ws = addDays(ws, -7);
    }
    return { months, weeks, current: { month: curMonth, week: curWeek } };
  }

  return { startJob, listJobs, getJob, filePath, listPeriods, saveIndex };
}
