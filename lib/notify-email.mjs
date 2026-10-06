// lib/notify-email.mjs —— **普通通知**的邮件 HTML 模版(与代码评审报告模版区分开)。
//
// 为什么单独一套:评审邮件是"长文档"(按文件分组、含 diff 建议),需要能逐行读的排版;
// 而普通通知是"一句话 + 几行细节"(网关告警/恢复、产出告警、评审的 IM 文本版),
// 需要的是一眼看清级别与主体。两者共用同一个品牌色系,但不共用模版。
//
// 输入是我们已有的通知文案(各调用点格式统一):
//     【网关告警】<主体>
//     <细节行…>
//     —— 2026-10-06 14:32:10（token-monitor）
// 解析出徽标/标题/细节/时间,渲染成告警卡;没有【】前缀时整段当标题(不猜)。
//
// 邮件安全:table 布局 + 全内联样式 + 零外部资源(图片/字体/CSS 都不引),
// 与评审报告同一套约束(报告有测试锁着"不得出现 http(s)://",这里同理)。

export const NOTIFY_LEVELS = {
  alert: { stripe: "#b3261e", chipBg: "#fdeceb", chipText: "#8c1d18" },   // 故障类:网关告警
  warn: { stripe: "#b45309", chipBg: "#fdf3e3", chipText: "#8a4b08" },    // 提醒类:产出告警
  ok: { stripe: "#1f6b45", chipBg: "#eaf4ee", chipText: "#155437" },      // 恢复类
  info: { stripe: "#2f6e50", chipBg: "#eef4f0", chipText: "#245741" },    // 普通信息
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// 徽标 → 级别。前缀是我们自己写的固定词(见各调用点),不做模糊猜测。
const LEVEL_BY_BADGE = [
  [/^网关告警$/, "alert"],
  [/^产出告警$/, "warn"],
  [/^网关恢复$/, "ok"],
  [/^代码评审$/, "info"],
];

// 解析通知文案。返回 { badge, level, title, lines } —— 纯函数,单测直接覆盖。
export function classifyNotify(text) {
  const raw = String(text || "").replace(/\r\n?/g, "\n").trim();
  const all = raw ? raw.split("\n") : [];
  let badge = "";
  let title = all.length ? all[0].trim() : "";
  const m = title.match(/^【([^】]{1,12})】\s*(.*)$/);
  if (m) { badge = m[1].trim(); title = m[2].trim(); }
  // 尾部签名行「—— <时间>（token-monitor）」不进正文(时间单独渲染),其余行保留
  const lines = [];
  let ts = "";
  for (const line of all.slice(1)) {
    const t = line.trim();
    if (!t) continue;
    const fm = t.match(/^——\s*(.+?)\s*（token-monitor）$/);
    if (fm) { ts = fm[1]; continue; }
    lines.push(t);
  }
  let level = "info";
  for (const [re, lv] of LEVEL_BY_BADGE) if (re.test(badge)) { level = lv; break; }
  return { badge, level, title, lines, ts };
}

// 渲染通知邮件。level 可显式覆盖(调用点知道语义时优先),否则按徽标判定。
export function buildNotifyEmailHTML({ text, subject = "", level = "", ts = "", link = "", linkText = "打开管理面板" } = {}) {
  const parsed = classifyNotify(text);
  const lv = NOTIFY_LEVELS[level] ? level : parsed.level;
  const c = NOTIFY_LEVELS[lv] || NOTIFY_LEVELS.info;
  const when = ts || parsed.ts;
  const head = parsed.title || subject || "通知";
  const detail = parsed.lines.map((l) =>
    `<div style="margin:2px 0;font:13.5px/1.7 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#3d4740;word-break:break-word">${esc(l)}</div>`
  ).join("");
  const badge = parsed.badge
    ? `<span style="display:inline-block;padding:2px 9px;border-radius:999px;background:${c.chipBg};color:${c.chipText};font:600 11px/1.7 -apple-system,'PingFang SC',sans-serif;letter-spacing:.02em">${esc(parsed.badge)}</span>`
    : "";
  const btn = link
    ? `<div style="margin-top:14px"><a href="${esc(link)}" style="display:inline-block;padding:9px 16px;border-radius:7px;background:#1b1f1d;color:#ffffff;font:600 12.5px/1 -apple-system,'PingFang SC',sans-serif;text-decoration:none">${esc(linkText)}</a></div>`
    : "";
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:24px 12px;background:#f2f3ef">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #e0e3dc;border-radius:8px;overflow:hidden">
  <tr><td style="height:3px;background:${c.stripe};line-height:3px;font-size:0">&nbsp;</td></tr>
  <tr><td style="padding:20px 24px 18px">
    ${badge ? `<div style="margin-bottom:8px">${badge}</div>` : ""}
    <div style="font:600 16px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#151a16">${esc(head)}</div>
    ${detail ? `<div style="margin-top:8px">${detail}</div>` : ""}
    ${btn}
  </td></tr>
  <tr><td style="padding:0 24px"><div style="height:1px;background:#eef0ec"></div></td></tr>
  <tr><td style="padding:12px 24px 18px">
    <div style="font:11.5px/1.7 ui-monospace,Menlo,Consolas,monospace;color:#8f9a92">${when ? esc(when) + "（北京时间） · " : ""}token-monitor</div>
  </td></tr>
</table>
</td></tr></table></body></html>`;
}
