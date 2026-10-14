// public/assets/upstream-quota.js —— 「上游额度」面板：dashboard 菜单 + 设置页二级视图。
//
// 同一份文件被两个页面加载，按页面里存在的容器自动分派：
//   /dashboard → #workspace-panel-upstream  只读面板（GET /api/upstream-quota）
//   /settings  → #upstreamQuotaView         配置表单（GET /api/upstream-quota/config + POST …/save）
//
// 展示原则（这一版是照着「一眼看到数字」重做的）：
//   1. 数字优先：余额用大号金额，套餐窗口用大号百分比 + 进度条，说明文字一律收进 title/折叠区。
//   2. 有数据的平台排前面并占满卡片；未配置 / 已关闭 / 仅控制台压成一排小字行，不抢视线。
//   3. 平台自带的官方口径长文（def.note）只作 tooltip，正文里不再复述。
// 显示的是**上游官方**的数字（账户余额、套餐 5 小时/每周窗口、云账号余额），与本工具统计的
// 成员配额是两套口径：上游额度只用于展示与告警，不参与本地配额计算，也不影响路由。
(function () {
  "use strict";

  // 「上游额度」只分两桶：Plan（订阅套餐 / 套餐窗口）与 余额（充值余额 / 账户余额 / 中转站钱包）。
  // 桶归属由服务端 def 给出（lib/upstream-quota.mjs 的 BUCKET_OF），这里只负责分段与文案。
  const BUCKET_ORDER = ["plan", "balance"];
  const BUCKET_LABEL = { plan: "Plan", balance: "余额" };
  const BUCKET_HINT = {
    plan: "订阅套餐的 5 小时 / 每周 / 每月窗口；只能在控制台看的也归这里",
    balance: "充值余额 / 账户余额 / 中转站钱包",
  };
  const CURRENCY_SIGN = { CNY: "¥", USD: "$", EUR: "€", JPY: "¥", HKD: "HK$" };
  const ALERT_FALLBACK = 90;

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const attr = (v) => esc(v).replace(/\n/g, " ");

  // ── 样式：本文件自带 ──────────────────────────────────────────────────────
  // 两个页面共用一份 <style>，比同时改 dashboard.css 与 settings.css 更不容易漏。
  // 布局类一律 uq- 前缀；进度条与状态点直接用 theme.css 既有的 .quota-progress / .led。
  function ensureStyle() {
    if ($("uqStyle")) return;
    const st = document.createElement("style");
    st.id = "uqStyle";
    st.textContent = [
      // 概览指标
      ".uq-sum-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--red);margin-right:5px;vertical-align:1px}",
      ".uq-kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:8px;margin:0 0 14px}",
      ".uq-kpi-t{border:1px solid var(--border);border-radius:10px;padding:7px 11px;background:var(--surface)}",
      ".uq-kpi-t b{display:block;font-size:19px;font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums}",
      ".uq-kpi-t span{font-size:11px;color:var(--dim)}",
      ".uq-kpi-t.alarm b,.uq-kpi-t.err b{color:var(--red)}",
      ".uq-kpi-t.ok b{color:var(--green)}",
      ".uq-kpi-t.off b{color:var(--dim2)}",
      ".uq-kpi-t.time{grid-column:span 2}",
      ".uq-kpi-t.time b{font-size:15px;font-weight:600}",
      // 分段（面板只分 Plan / 余额两段；设置页沿用同一套）
      // 两桶并排：宽屏时 Plan 与余额 各占一列（一屏能看完），窄屏自动退回上下堆叠。
      // 两列等高（stretch）+ 段内把「仅控制台行 / 其余 N 个」这块用 margin-top:auto 钉到段底：
      // 两段的尾部就都落在同一条水平线上，不会一个高一个低（用户反馈的「没有对齐」就是这个）。
      // 注意两段的 margin-bottom 必须一致，否则 stretch 出来的高度会差一个 margin。
      ".uq-buckets{display:grid;gap:0 18px;grid-template-columns:repeat(auto-fit,minmax(430px,1fr));align-items:stretch}",
      ".uq-sec{margin:0 0 16px}",
      ".uq-buckets .uq-sec{display:flex;flex-direction:column}",
      ".uq-buckets .uq-tail{margin-top:auto}",
      ".uq-sec-hd{display:flex;align-items:baseline;gap:8px;font-size:11.5px;font-weight:650;color:var(--dim);letter-spacing:.06em;margin:0 0 8px;padding-bottom:5px;border-bottom:1px solid var(--border)}",
      ".uq-sec-hd em{font-style:normal;font-weight:400;font-size:11px;color:var(--dim2);letter-spacing:0}",
      // 卡片瀑布：各平台条目数不同、卡片高度差很大，grid 会按一行里最高的那张定行高（矮卡下面空
      // 一块），CSS 多列（columns）的自动平衡在「一张很高的卡 + 一堆矮卡」时也很差（实测余额段
      // 两列 756 / 431px）。所以列由 JS 分（layoutGrid：贪心放最矮的列 + 一轮局部改进），
      // 这里只给骨架样式（用户 2026-10-14 反馈「卡片长短不同、有空白、排列不整齐」）。
      ".uq-grid{display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px}",
      ".uq-grid>.uq-col{flex:1 1 236px;min-width:0;display:flex;flex-direction:column;gap:10px}",
      ".uq-grid>.uq-card{flex:1 1 100%}",
      // 条目多的卡（>=5 项）整行独占，内部再按列自动分栏：一张长卡不会把整段撑歪。
      ".uq-card.wide{width:100%}",
      ".uq-card.wide .uq-body{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:0 18px;align-content:start}",
      // 套餐信息行（规格 · 生效中 · 到期 …）
      ".uq-plan{margin:4px 0 0;font-size:10.5px;color:var(--dim2);font-variant-numeric:tabular-nums}",
      // 卡片
      ".uq-card{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:10px 12px}",
      ".uq-card.alarm{border-color:#e7b4ae;background:linear-gradient(180deg,#fff7f6,var(--surface) 58%)}",
      ".uq-card.warn{border-color:#e6d7ac}",
      ".uq-card.off{background:var(--surface-subtle)}",
      ".uq-card-hd{display:flex;align-items:center;gap:7px;min-width:0}",
      ".uq-name{font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".uq-state{margin-left:auto;font-size:10.5px;padding:1px 7px;border-radius:9px;border:1px solid var(--border);color:var(--dim);white-space:nowrap}",
      ".uq-state.ok{color:var(--green);border-color:#bcd6c6;background:var(--accent-soft)}",
      ".uq-state.alarm{color:var(--red);border-color:#e7b4ae;background:#fdf0ee}",
      ".uq-state.warn{color:var(--orange);border-color:#e6d7ac;background:#fdf8ec}",
      ".uq-icon{background:transparent;border:0;color:var(--dim2);cursor:pointer;font-size:12px;line-height:1;padding:2px 4px;border-radius:4px}",
      ".uq-icon:hover{color:var(--accent);background:var(--surface-subtle)}",
      ".uq-icon[disabled]{opacity:.5;cursor:default}",
      // 余额
      ".uq-bal{margin:6px 0 0}",
      ".uq-bal-v{font-size:25px;font-weight:700;line-height:1.1;letter-spacing:-.02em;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".uq-bal-v small{font-size:12.5px;font-weight:600;color:var(--dim);margin-left:3px}",
      ".uq-bal-v.alarm{color:var(--red)}",
      ".uq-bal-v.muted{color:var(--dim2)}",
      ".uq-bal-l{font-size:11.5px;color:var(--dim);margin-top:2px}",
      ".uq-bal-m{font-size:11px;color:var(--dim2);margin-top:5px;font-variant-numeric:tabular-nums}",
      // 代金券：和「余额」明显区分 —— 单独的虚线小卡片 + 「代金券」标签 + 琥珀色底（用户 2026-10-14 要求）。
      ".uq-vch-wrap{margin-top:10px;padding-top:8px;border-top:1px dashed var(--border)}",
      ".uq-vch-hd{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dim2);margin-bottom:6px}",
      ".uq-vch-tag{display:inline-block;padding:1px 7px;border-radius:999px;border:1px solid #ecd9a8;background:#fdf6e3;color:#8a6a1f;font-weight:650;letter-spacing:.04em}",
      ".uq-vchs{display:grid;gap:7px;grid-template-columns:repeat(auto-fill,minmax(148px,1fr))}",
      ".uq-vch{border:1px dashed #e2cfa0;border-radius:9px;background:linear-gradient(180deg,#fffdf5,var(--surface) 72%);padding:7px 9px;min-width:0}",
      ".uq-vch-name{font-size:11px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".uq-vch-v{font-size:15.5px;font-weight:700;color:var(--text);margin-top:2px;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".uq-vch-meta{font-size:10px;color:var(--dim2);margin-top:3px;line-height:1.45}",
      // 套餐窗口
      ".uq-q{margin:9px 0 0}",
      ".uq-q:first-of-type{margin-top:7px}",
      ".uq-q-hd{display:flex;align-items:baseline;gap:8px;font-size:11.5px;color:var(--dim)}",
      ".uq-q-hd b{margin-left:auto;font-size:17px;font-weight:700;line-height:1.15;color:var(--text);font-variant-numeric:tabular-nums}",
      ".uq-q-hd b.warn{color:var(--orange)}",
      ".uq-q-hd b.alarm{color:var(--red)}",
      ".uq-q .quota-progress{display:block;width:100%;height:5px;margin:4px 0 3px;border-radius:3px}",
      ".uq-q .quota-progress>i{transition:width .3s}",
      ".uq-q-sub{font-size:11px;color:var(--dim2);font-variant-numeric:tabular-nums}",
      // 窗口额度的一句话说明（例：滚动窗口没有可用的重置时间；上游只给百分比之类）
      ".uq-q-note{margin-top:2px;font-size:11px;line-height:1.6;color:var(--dim2)}",
      // 卡片内的异常/提示
      ".uq-alert{margin:8px 0 0;font-size:11.5px;line-height:1.5;color:var(--red);word-break:break-word}",
      ".uq-warnline{margin:6px 0 0;font-size:11px;line-height:1.5;color:var(--orange)}",
      ".uq-card-ft{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:7px;font-size:10px;color:var(--dim2)}",
      ".uq-card-ft a{color:var(--dim2)}",
      ".uq-card-ft a:hover{color:var(--accent)}",
      ".uq-src{margin-left:auto}",
      // 无数据的平台：压成一排小字行；已关闭 / 未配置的一大批默认折进 <details>，把版面留给有数字的卡
      ".uq-rows{display:flex;flex-wrap:wrap;gap:6px 14px;padding:8px 11px;margin-top:9px;border:1px dashed var(--border);border-radius:9px;background:var(--surface-subtle)}",
      ".uq-more{margin-top:9px}",
      ".uq-more>summary{cursor:pointer;font-size:11px;color:var(--dim);padding:6px 10px;border:1px dashed var(--border);border-radius:9px;background:var(--surface-subtle);list-style:none}",
      ".uq-more>summary::-webkit-details-marker{display:none}",
      ".uq-more>summary:before{content:'▸ ';color:var(--dim2)}",
      ".uq-more[open]>summary{border-bottom-left-radius:0;border-bottom-right-radius:0;border-bottom-color:transparent}",
      ".uq-more[open]>summary:before{content:'▾ '}",
      ".uq-more>.uq-rows{margin-top:0;border-top-left-radius:0;border-top-right-radius:0}",
      ".uq-row{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dim)}",
      ".uq-row b{font-weight:600;color:var(--text)}",
      ".uq-row em{font-style:normal;color:var(--dim2)}",
      ".uq-row a{color:var(--accent);text-decoration:none}",
      ".uq-row a:hover{text-decoration:underline}",
      // 空态 / 错误
      ".uq-empty{margin:6px 0;padding:22px 18px;border:1px dashed var(--border);border-radius:10px;text-align:center;color:var(--dim);font-size:12.5px;line-height:1.7}",
      ".uq-empty b{display:block;font-size:15px;color:var(--text);margin-bottom:4px}",
      ".uq-empty a{color:var(--accent)}",
      ".uq-fail{margin:6px 0;padding:16px;border:1px solid #e7b4ae;border-radius:10px;background:#fdf7f6}",
      ".uq-fail b{display:block;font-size:13px;color:var(--red);margin-bottom:5px}",
      ".uq-fail p{font-size:11.5px;color:var(--dim);line-height:1.6;word-break:break-word}",
      ".uq-fail code{font-family:var(--font-mono);font-size:11px;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:1px 5px}",
      // ── 设置页 ────────────────────────────────────────────────────────────
      ".uq-bar{position:sticky;top:0;z-index:6;display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:9px 13px;margin-bottom:14px;border:1px solid var(--border);border-radius:10px;background:var(--surface)}",
      ".uq-bar-t{font-size:13px;font-weight:650}",
      ".uq-bar .uq-status{margin-left:auto;font-size:11.5px;color:var(--dim)}",
      ".uq-bar .uq-status.ok{color:var(--green)}",
      ".uq-bar .uq-status.err{color:var(--red)}",
      ".uq-lead{margin:0 0 14px;font-size:11.5px;color:var(--dim);line-height:1.7}",
      ".uq-lead b{color:var(--text)}",
      ".uq-p{display:block;border:1px solid var(--border);border-radius:9px;background:var(--surface);margin-bottom:8px}",
      ".uq-p[open]{border-color:var(--border-strong)}",
      ".uq-p>summary{display:flex;align-items:center;gap:9px;padding:10px 13px;cursor:pointer;list-style:none;min-width:0}",
      ".uq-p>summary::-webkit-details-marker{display:none}",
      ".uq-p>summary::after{content:'▾';color:var(--dim2);font-size:11px;margin-left:2px;transition:transform .18s}",
      ".uq-p[open]>summary::after{transform:rotate(180deg)}",
      ".uq-p>summary:hover{background:var(--surface-subtle);border-radius:9px}",
      ".uq-p-name{font-size:12.5px;font-weight:600;white-space:nowrap}",
      ".uq-p-tag{font-size:10px;color:var(--dim2);border:1px solid var(--border);border-radius:8px;padding:0 6px;white-space:nowrap}",
      ".uq-p-tag.exp{color:var(--orange);border-color:#e6d7ac}",
      ".uq-p-live{margin-left:auto;font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".uq-p-live.warn{color:var(--orange)}",
      ".uq-p-live.alarm{color:var(--red)}",
      ".uq-p-live.dim{font-size:11.5px;font-weight:500;color:var(--dim2)}",
      ".uq-p-state{font-size:10.5px;color:var(--dim);border:1px solid var(--border);border-radius:9px;padding:1px 7px;white-space:nowrap}",
      ".uq-p-state.ok{color:var(--green);border-color:#bcd6c6;background:var(--accent-soft)}",
      ".uq-p-state.alarm{color:var(--red);border-color:#e7b4ae;background:#fdf0ee}",
      ".uq-p-state.warn{color:var(--orange);border-color:#e6d7ac;background:#fdf8ec}",
      ".uq-p-body{padding:4px 13px 13px;border-top:1px solid var(--border)}",
      // 中转站：一个类型一段，段里每个站点一张卡（左边缩进，视觉上从属于这个类型）
      ".uq-sites{margin:2px 0 14px;padding-left:11px;border-left:2px solid var(--border)}",
      ".uq-sites-hd{display:flex;align-items:center;gap:8px;padding:2px 0 7px}",
      ".uq-sites-name{font-size:12.5px;font-weight:650}",
      ".uq-sites-hd em{font-style:normal;font-size:11px;color:var(--dim2)}",
      ".uq-sites-hd .btn{margin-left:auto}",
      ".uq-sites .uq-p{margin-bottom:7px}",
      ".uq-del{margin-left:auto}",
      ".uq-p-note{margin:10px 0 0;font-size:11px;color:var(--dim2);line-height:1.65}",
      ".uq-p-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:11px}",
      ".uq-probe{font-size:11.5px;line-height:1.6;min-width:0}",
      ".uq-probe .uq-p-live{font-size:14px;margin-left:0}",
      ".uq-cfg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(212px,1fr));gap:10px;margin-top:11px}",
      // 每格是「标签在上、控件在下」的竖排，并整体贴底：某格标签折成两行时，控件仍然和
      // 同行其它格的控件站在同一条线上（否则就会出现「方案」和「成员」两个下拉框错位）。
      ".uq-cfg-grid>div{display:flex;flex-direction:column;justify-content:flex-end;min-width:0}",
      // margin 归零是必须的：全局 label 样式带 12px 上边距，会让格子里的标签和控件整体下移。
      ".uq-cfg-grid label{display:block;font-size:11px;color:var(--dim);margin:0 0 3px}",
      ".uq-cfg-grid input,.uq-cfg-grid select{width:100%}",
      ".uq-adv{margin-top:11px;font-size:11.5px}",
      ".uq-adv>summary{cursor:pointer;color:var(--dim2);list-style:none;display:inline-block}",
      ".uq-adv>summary::-webkit-details-marker{display:none}",
      ".uq-adv>summary:hover{color:var(--accent)}",
      // 总开关这格要和右边那排按钮同高、同中线：全局 label 的 12px/5px 上下边距会把整格压下去
      // （实测比按钮低 3.5px），下拉框本身也比 .btn-sm 高，所以这里把边距归零、高度对齐 33px。
      ".uq-sw{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dim);margin:0}",
      ".uq-sw select{width:auto;height:33px;padding:0 8px}",
      ".uq-en{width:auto;margin:0}",
    ].join("");
    document.head.appendChild(st);
  }

  // ── 请求 ──────────────────────────────────────────────────────────────────
  // 设置页有内联 PAGE_CSRF，dashboard 只在 cookie 里有 tm_csrf，两处都兜住。
  function csrfHeaders(extra) {
    const h = extra || {};
    let tok = "";
    try { if (typeof PAGE_CSRF === "string") tok = PAGE_CSRF; } catch (e) { tok = ""; }
    if (!tok) { const m = document.cookie.match(/tm_csrf=([^;]+)/); tok = m ? m[1] : ""; }
    if (tok) h["x-csrf-token"] = tok;
    return h;
  }
  // 超时 + 「返回了网页而不是 JSON」都翻译成人话：这两种情况原先会静静地什么都不显示。
  async function api(path, opts) {
    const o = opts || {};
    const init = { method: o.method || "GET", headers: csrfHeaders({}), credentials: "same-origin" };
    if (o.body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(o.body); }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30000);
    init.signal = ac.signal;
    let r;
    try {
      r = await fetch(path, init);
    } catch (err) {
      clearTimeout(timer);
      throw new Error(err && err.name === "AbortError" ? "请求超时（30 秒）" : "请求失败：" + (err && err.message ? err.message : err));
    }
    clearTimeout(timer);
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (data === null) {
      if (/^\s*</.test(text)) throw new Error("服务返回的是网页而不是数据（登录可能已过期），请刷新页面重新登录");
      throw new Error("HTTP " + r.status + " 返回了非 JSON 内容");
    }
    if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
    return data;
  }

  // ── 格式化 ────────────────────────────────────────────────────────────────
  function fmtNum(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (abs >= 1e4) return (n / 1e3).toFixed(2) + "K";
    return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  }
  // 金额单独走一套：余额要看得清到分，但整数不要拖着 .00。
  function fmtMoney(v, unit) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    // 上游直接给货币符号（NewAPI 的 custom_currency_symbol 就是 "$"）时紧贴数字，不要空格。
    const sym = String(unit || "");
    const sign = CURRENCY_SIGN[unit] || (sym && !/[A-Za-z0-9]/.test(sym) ? sym : (unit ? unit + " " : ""));
    const s = Math.abs(n) >= 1000
      ? n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : n.toFixed(2);
    return sign + s;
  }
  function fmtValue(v, unit) {
    if (v === null || v === undefined || v === "") return "—";
    if (unit === "%") return fmtNum(v) + "%";
    if (CURRENCY_SIGN[unit]) return fmtMoney(v, unit);
    // 上游直接给货币符号（$ / ¥ / €）时按金额渲染；中文量纲（张 / 次 / 字符 / 秒）是计数单位，
    // 不是货币符号 —— 否则会渲染成「剩 张20.00」这种既像钱又拖小数的样子。
    if (unit && !/[A-Za-z0-9]/.test(String(unit)) && !/[\u4e00-\u9fff]/.test(String(unit))) return fmtMoney(v, unit);
    if (unit === "tokens") return fmtNum(v) + " tokens";
    return fmtNum(v) + (unit ? " " + unit : "");
  }
  const bjTime = (ms) => {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "";
    return new Date(n + 8 * 3600e3).toISOString().slice(5, 16).replace("T", " ");
  };
  const bjClock = (ms) => {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "";
    return new Date(n + 8 * 3600e3).toISOString().slice(11, 16);
  };
  // 订阅到期只写日期（2027-01-15）；带年份，跨年时不会看错。
  const bjDate = (ms) => {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "";
    return new Date(n + 8 * 3600e3).toISOString().slice(0, 10);
  };
  function ago(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "";
    const s = Math.max(0, Math.round((Date.now() - n) / 1000));
    if (s < 45) return "刚刚";
    if (s < 3600) return Math.round(s / 60) + " 分钟前";
    if (s < 86400) return Math.round(s / 3600) + " 小时前";
    return Math.round(s / 86400) + " 天前";
  }
  // 重置倒计时：面板上「还剩多久重置」比一个绝对时间点更有用，两者都给。
  function untilText(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n <= 0) return "";
    const d = n - Date.now();
    if (d <= 0) return "即将重置";
    const h = d / 3600e3;
    if (h < 1) return Math.max(1, Math.round(d / 60e3)) + " 分钟后重置";
    if (h < 48) return (h < 10 ? h.toFixed(1) : Math.round(h)) + " 小时后重置";
    return Math.round(h / 24) + " 天后重置";
  }

  // ── 语义：状态 / 进度 ─────────────────────────────────────────────────────
  // 进度条语义是「已用掉多少」：套餐直接用上游 percent，余额用 剩余/总额 反推。
  // 拿不到就返回 null —— 宁可不画条，也不画一条凭空捏造的 0%。
  function usedPercent(it) {
    const pct = Number(it.percent);
    if (Number.isFinite(pct)) return Math.max(0, Math.min(100, pct));
    const used = Number(it.used), total = Number(it.total);
    if (Number.isFinite(used) && Number.isFinite(total) && total > 0) return Math.max(0, Math.min(100, (used / total) * 100));
    return null;
  }
  // 百分比的显示：整数就照原样（65%），小数保留有效位（12.5% / 1.62%）——不要 12.5 变成 13。
  function pctStr(p) {
    const n = Number(p);
    if (!Number.isFinite(n)) return "—";
    if (Number.isInteger(n)) return String(n);
    return n < 1 ? n.toFixed(2) : n.toFixed(1);
  }
  function severity(pct, alertPercent) {
    if (pct === null) return "";
    if (pct >= alertPercent) return "alarm";
    if (pct >= Math.max(0, alertPercent - 15)) return "warn";
    return "";
  }
  function providerState(p, alertPercent) {
    if (p.manualOnly) return { key: "manual", text: "仅控制台", cls: "" };
    if (!p.enabled) return { key: "off", text: "已关闭", cls: "" };
    if (!p.ok) return p.configured ? { key: "failed", text: "查询失败", cls: "alarm" } : { key: "unset", text: "未配置", cls: "" };
    if (p.alert) return { key: "alert", text: "额度告警", cls: "alarm" };
    return { key: "ok", text: "正常", cls: "ok" };
  }
  // 卡片左侧的状态点：和卡片底色一起表达严重度。
  function ledCls(p, alertPercent) {
    const st = providerState(p, alertPercent);
    if (st.key === "alert") return "led err";
    if (st.key === "failed") return "led err";
    if (st.key === "manual" || st.key === "unset" || st.key === "off") return "led";
    const worst = Math.max.apply(null, (p.items || []).map((it) => {
      const pct = usedPercent(it);
      return pct === null ? -1 : pct;
    }).concat([-1]));
    if (worst >= alertPercent) return "led warn";
    return "led on";
  }

  // ── 卡片（dashboard） ─────────────────────────────────────────────────────
  // 余额：金额是主角（大号），标签与明细往下压。
  function balanceHTML(it) {
    const depleted = it.remaining !== null && it.remaining !== undefined && Number(it.remaining) <= 0;
    // 套餐内使用：套餐窗口还有余量时的 0 余额只是「这平台不按余额计费」，不标红也不参与告警。
    // 判定在服务端（shapeProvider 给 item 打 coveredByPlan），这里只负责别把它画成红字。
    const alarm = depleted && !it.coveredByPlan;
    const note = [it.note, it.coveredByPlan ? "套餐内使用，余额不参与告警" : ""].filter(Boolean).join(" · ");
    return '<div class="uq-bal">'
      + '<div class="uq-bal-v' + (alarm ? " alarm" : (it.coveredByPlan ? " muted" : "")) + '">' + esc(fmtMoney(it.remaining, it.unit)) + '</div>'
      + '<div class="uq-bal-l">' + esc(it.label || "可用余额") + '</div>'
      + (note ? '<div class="uq-bal-m">' + esc(note) + '</div>' : "")
      + '</div>';
  }
  // 代金券：它不是余额，单独画成虚线小卡片，一眼能区分（用户 2026-10-14 要求）。
  // 服务端在代金券条目上打 voucher:true 并带上 expiresAt；余额合计仍是卡片主数字（第一条 balance）。
  function voucherHTML(it) {
    const meta = [];
    if (it.total !== null && it.total !== undefined && Number.isFinite(Number(it.total))) meta.push("面额 " + fmtMoney(it.total, it.unit));
    if (it.used !== null && it.used !== undefined && Number.isFinite(Number(it.used))) meta.push("已用 " + fmtMoney(it.used, it.unit));
    if (it.expiresAt) meta.push("有效期至 " + bjDate(it.expiresAt));
    return '<div class="uq-vch">'
      + '<div class="uq-vch-name" title="' + attr(it.label || "代金券") + '">' + esc(it.label || "代金券") + '</div>'
      + '<div class="uq-vch-v">' + esc(fmtMoney(it.remaining, it.unit)) + '</div>'
      + (meta.length ? '<div class="uq-vch-meta">' + esc(meta.join(" · ")) + '</div>' : "")
      + '</div>';
  }
  function voucherWrapHTML(list) {
    return '<div class="uq-vch-wrap">'
      + '<div class="uq-vch-hd"><span class="uq-vch-tag">代金券</span>'
      + '<span>' + list.length + ' 张 · 可直接抵扣消费</span></div>'
      + '<div class="uq-vchs">' + list.map(voucherHTML).join("") + '</div>'
      + '</div>';
  }

  // 套餐窗口：百分比是主角，进度条给相对感，剩多少/何时重置压在下面一行。
  function quotaHTML(it, alertPercent) {
    const pct = usedPercent(it);
    const sev = severity(pct, alertPercent);
    const sub = [];
    const hasTotal = it.total !== null && it.total !== undefined && Number.isFinite(Number(it.total));
    if (it.remaining !== null && it.remaining !== undefined && Number.isFinite(Number(it.remaining)) && hasTotal) {
      sub.push("剩 " + fmtValue(it.remaining, it.unit === "%" ? "" : it.unit) + " / " + fmtValue(it.total, it.unit === "%" ? "" : it.unit));
    } else if (hasTotal && it.used !== null && it.used !== undefined) {
      sub.push("已用 " + fmtValue(it.used, it.unit) + " / " + fmtValue(it.total, it.unit));
    }
    if (it.resetAt) sub.push(untilText(it.resetAt) + "（" + bjTime(it.resetAt) + "）");
    return '<div class="uq-q">'
      + '<div class="uq-q-hd"><span>' + esc(it.label || "额度窗口") + '</span>'
      + '<b class="' + sev + '">' + (pct === null ? esc(fmtValue(it.used, it.unit)) : pctStr(pct) + "%") + '</b></div>'
      + (pct === null ? "" : '<div class="quota-progress' + (sev === "alarm" ? " crit" : sev === "warn" ? " warn" : "") + '"><i style="width:' + pct.toFixed(1) + '%"></i></div>')
      + (sub.length ? '<div class="uq-q-sub">' + esc(sub.join(" · ")) + '</div>' : "")
      + (it.note ? '<div class="uq-q-note">' + esc(it.note) + '</div>' : "")
      + '</div>';
  }

  // 套餐本身的信息：规格 / 是否生效中 / 到期时间（+ 剩余天数）。
  // 只有上游接口真的给了才渲染这一行（阿里云百炼个人版的控制台订阅接口给得出；多数平台
  // 只给窗口重置时间，没给套餐到期 —— 那就什么都不显示，不猜、不占版面）。
  const PLAN_STATUS_TEXT = { VALID: "生效中", RELEASE: "已释放", REFUNDED: "已退款", STOP: "已停用", LIMIT: "已受限" };
  function planHTML(plan) {
    if (!plan || typeof plan !== "object") return "";
    const bits = [];
    const spec = String(plan.name || "").trim();
    if (spec) bits.push(spec.charAt(0).toUpperCase() + spec.slice(1));
    const status = String(plan.status || "").trim();
    if (status) bits.push(PLAN_STATUS_TEXT[status] || status);
    // 注意：remainingDays 可能是 null（例如阶跃星辰的套餐名接口只给名字）——
    // 不能直接 Number(null)（= 0，会画成「剩 0 天」这个假的到期提示）。
    const rawDays = plan.remainingDays;
    const days = (rawDays === null || rawDays === undefined || rawDays === "") ? NaN : Number(rawDays);
    const hasDays = Number.isFinite(days);
    if (Number(plan.endAt) > 0) {
      bits.push("到期 " + bjDate(plan.endAt) + (hasDays ? "（剩 " + Math.round(days) + " 天）" : ""));
    } else if (hasDays) {
      bits.push("剩 " + Math.round(days) + " 天");
    }
    if (plan.autoRenew === true) bits.push("自动续费");
    if (!bits.length) return "";
    return '<div class="uq-plan" title="套餐信息来自上游订阅接口">' + esc(bits.join(" · ")) + '</div>';
  }

  function cardHTML(p, alertPercent) {
    const st = providerState(p, alertPercent);
    // 同一平台可能有多个同名窗口（智谱就有「每周窗口」的 tokens 与额度两条），
    // 同名时补一个量纲后缀，免得两张一样的标题配两个不同百分比。
    const items = p.items || [];
    const counts = {};
    items.forEach((it) => { const l = String(it.label || ""); counts[l] = (counts[l] || 0) + 1; });
    const labelOf = (it) => {
      const l = String(it.label || "");
      if (counts[l] < 2) return it.label;
      if (it.unit === "tokens") return l + "（tokens）";
      if (!it.unit || it.unit === "%") return l + "（额度）";
      return l + "（" + it.unit + "）";
    };
    const labelIt = (raw) => Object.assign({}, raw, { label: labelOf(raw) });
    const vouchers = items.filter((it) => it.voucher === true).map(labelIt);
    const body = items.filter((it) => it.voucher !== true).map((raw) => {
      const it = labelIt(raw);
      return it.kind === "balance" ? balanceHTML(it) : quotaHTML(it, alertPercent);
    }).join("");
    // 代金券单独一块（跟在余额/窗口下面），不混在 .uq-body 里
    const voucherBlock = vouchers.length ? voucherWrapHTML(vouchers) : "";
    // 条目多的卡（比如阿里云百炼：月额度 + 7 项 Harness 权益）横着铺开占满一整行，
    // 内部再按列自动分栏 —— 否则一张卡会拉得特别长，把整段的行高都撑歪。
    const wide = items.length >= 5;
    const alarming = st.key === "alert" || st.key === "failed" || !!p.alert;
    const cls = "uq-card" + (wide ? " wide" : "")
      + (st.key === "alert" || st.key === "failed" ? " alarm" : (p.alert ? " warn" : ""));
    return '<div class="' + cls + '" data-id="' + attr(p.id) + '">'
      + '<div class="uq-card-hd">'
      + '<span class="' + ledCls(p, alertPercent) + '"></span>'
      + '<span class="uq-name" title="' + attr(p.name) + '">' + esc(p.name) + '</span>'
      + (p.stale ? '<span class="uq-state warn" title="上游这次没查成功，显示的是上一次的好数据">旧数据</span>' : "")
      + '<span class="uq-state ' + st.cls + '">' + st.text + '</span>'
      + '<button type="button" class="uq-icon" title="只刷新这个平台" onclick="UQ.refreshOne(\'' + attr(p.id) + '\')">↻</button>'
      + (p.note ? '<span class="uq-icon" title="' + attr(p.note) + '" style="cursor:help">ⓘ</span>' : "")
      + '</div>'
      + planHTML(p.plan)
      // 查询失败时不要再说「没有可识别的额度字段」—— 下一行的错误原文才是原因。
      + (body ? '<div class="uq-body">' + body + '</div>'
        : (p.error ? "" : '<div class="uq-q-sub" style="margin-top:8px">上游没有返回可识别的额度字段</div>'))
      + voucherBlock
      + (p.error ? '<div class="uq-alert" title="' + attr(p.error) + '">' + esc(clip(p.error, 180)) + '</div>' : "")
      + ((p.warnings && p.warnings.length) ? '<div class="uq-warnline" title="' + attr(p.warnings.join("；")) + '">' + esc(clip(p.warnings.join("；"), 140)) + '</div>' : "")
      + '<div class="uq-card-ft">'
      + '<span>' + (p.fromCache ? "缓存于 " : "更新于 ") + esc(ago(p.fetchedAt) || "—") + '</span>'
      + (p.credLabel ? '<span class="uq-src" title="这个数字用的是哪份凭据">' + esc(p.credLabel) + '</span>' : "")
      + (p.consoleUrl ? '<a href="' + attr(p.consoleUrl) + '" target="_blank" rel="noopener">控制台</a>' : "")
      + (p.docsUrl ? '<a href="' + attr(p.docsUrl) + '" target="_blank" rel="noopener">文档</a>' : "")
      + '</div>'
      + '</div>';
  }
  function clip(s, n) {
    const t = String(s == null ? "" : s);
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }
  // 没数字可看的平台压成一排小字行：把版面留给真有数据的那几张卡。
  function rowItem(p, kind) {
    const name = '<b>' + esc(p.name) + '</b>';
    if (kind === "manual") return '<span class="uq-row">' + name + '<a href="' + attr(p.consoleUrl || "#") + '" target="_blank" rel="noopener">控制台</a></span>';
    if (kind === "off") return '<span class="uq-row"><span class="led"></span>' + name + '<em>已关闭</em><a href="/settings">启用</a></span>';
    if (kind === "unset") return '<span class="uq-row"><span class="led"></span>' + name + '<em>未配置凭据</em><a href="/settings">配置</a></span>';
    return '<span class="uq-row">' + name + (p.error ? '<em title="' + attr(p.error) + '">' + esc(clip(p.error, 60)) + '</em>' : "") + '</span>';
  }

  function kpiHTML(providers, snap) {
    const alertPercent = Number(snap.alertPercent) || ALERT_FALLBACK;
    const real = providers.filter((p) => !p.manualOnly);
    const attention = real.filter((p) => providerState(p, alertPercent).key === "alert" || providerState(p, alertPercent).key === "failed").length;
    const ok = real.filter((p) => providerState(p, alertPercent).key === "ok").length;
    const unset = real.filter((p) => providerState(p, alertPercent).key === "unset").length;
    const off = real.filter((p) => !p.enabled).length;
    const tile = (cls, n, label) => '<div class="uq-kpi-t ' + cls + '"><b>' + n + '</b><span>' + label + '</span></div>';
    // 0 值的「未配置 / 已关闭」是噪声，只在真有时才占一格；「需要关注」永远在，给一个明确的 0。
    return '<div class="uq-kpi">'
      + tile(attention ? "alarm" : "off", attention, "需要关注")
      + tile("ok", ok, "查询正常")
      + (unset ? tile("err", unset, "未配置") : "")
      + (off ? tile("off", off, "已关闭") : "")
      + '<div class="uq-kpi-t time"><b>' + esc(bjClock(snap.generatedAt) || "—") + '</b><span>更新于（北京时间）· 共 ' + providers.length + ' 个平台</span></div>'
      + '</div>';
  }

  function panelHTML(snap) {
    if (!snap.enabled) {
      return '<div class="uq-empty"><b>「上游额度」已关闭</b>打开后会在这里显示各平台的官方余额与套餐窗口。<br><a href="/settings">去设置页打开 →</a></div>';
    }
    const providers = snap.providers || [];
    if (!providers.length) {
      return '<div class="uq-empty"><b>还没有要查的平台</b>到设置页挑平台、填凭据，这里的卡片才会出现。<br><a href="/settings">去设置 →</a></div>';
    }
    const alertPercent = Number(snap.alertPercent) || ALERT_FALLBACK;
    const buckets = (snap.buckets && snap.buckets.length) ? snap.buckets : BUCKET_ORDER;
    let body = "";
    for (const b of buckets) {
      const list = providers.filter((p) => (p.bucket || "balance") === b);
      if (!list.length) continue;
      const rank = (p) => {
        const k = providerState(p, alertPercent).key;
        return k === "alert" ? 0 : k === "failed" ? 1 : k === "ok" ? 2 : k === "unset" ? 3 : k === "off" ? 4 : 5;
      };
      const withData = list.filter((p) => rank(p) <= 2).sort((a, b2) => rank(a) - rank(b2));
      const rest = list.filter((p) => rank(p) > 2).sort((a, b2) => rank(a) - rank(b2));
      // 只在控制台看的平台：控制台入口就是它们的全部价值，直接摆出来（但压成小字行）。
      const manualRows = rest.filter((p) => p.manualOnly);
      // 已关闭 / 未配置：一批人，默认折起来——展开状态记在 localStorage，30 秒自动刷新不会把它弹回去。
      const idleRows = rest.filter((p) => !p.manualOnly);
      body += '<div class="uq-sec"><div class="uq-sec-hd">' + esc(BUCKET_LABEL[b] || b) + '<em>' + esc(BUCKET_HINT[b] || "") + '</em><em style="margin-left:auto">' + list.length + ' 个</em></div>';
      // 宽卡（条目 >=5）由 layoutGrid 独占整行放在列后面（告警的放最上面），这里不用排序。
      if (withData.length) body += '<div class="uq-grid">' + withData.map((p) => cardHTML(p, alertPercent)).join("") + '</div>';
      // 尾部（仅控制台行 + 其余 N 个）用 .uq-tail 包起来钉在段底：两列并排时两段的尾部对齐。
      let tail = "";
      if (manualRows.length) tail += '<div class="uq-rows">' + manualRows.map((p) => rowItem(p, "manual")).join("") + '</div>';
      if (idleRows.length) {
        tail += '<details class="uq-more"' + (moreOpen(b) ? " open" : "") + ' ontoggle="UQ.moreToggle(event,\'' + attr(b) + '\')">'
          + '<summary>其余 ' + idleRows.length + ' 个（未配置 / 已关闭）</summary>'
          + '<div class="uq-rows">' + idleRows.map((p) => {
            const k = providerState(p, alertPercent).key;
            return rowItem(p, k === "off" ? "off" : "unset");
          }).join("") + '</div></details>';
      }
      if (tail) body += '<div class="uq-tail">' + tail + '</div>';
      body += '</div>';
    }
    return kpiHTML(providers, snap) + '<div class="uq-buckets">' + body + '</div>';
  }

  // 折叠状态：面板 30 秒重绘一次，open 必须活在 localStorage 里，否则每次刷新都被折回去。
  function moreOpen(bucket) {
    try { return localStorage.getItem("uq.more." + bucket) === "1"; } catch (e) { return false; }
  }
  function moreToggle(ev, bucket) {
    try { localStorage.setItem("uq.more." + bucket, ev.target.open ? "1" : "0"); } catch (e) { /* 隐私模式：记不住也不影响用 */ }
  }

  // 摘要行：有需要关注的平台时前面点一颗红点（用 CSS 画，不用表情符号——项目约定
  // 源码与资产里不出现 emoji，tests/multi-profile-default-ux.test.mjs 会扫）。
  function summaryText(snap) {
    const providers = snap.providers || [];
    const alertPercent = Number(snap.alertPercent) || ALERT_FALLBACK;
    const attention = providers.filter((p) => { const k = providerState(p, alertPercent).key; return k === "alert" || k === "failed"; }).length;
    return { attention: attention, text: (attention ? attention + " 个需要关注 · " : "")
      + "共 " + providers.length + " 个平台 · 更新于 " + (bjClock(snap.generatedAt) || "—") + (snap.enabled ? "" : " · 已关闭") };
  }
  function summaryHTML(snap) {
    const s = summaryText(snap);
    return (s.attention ? '<span class="uq-sum-dot"></span>' : "") + esc(s.text);
  }

  // ── dashboard 面板 ───────────────────────────────────────────────────────
  let lastSnap = null;
  let dashSig = "";

  function scrollParentOf(body) {
    let n = body.parentElement;
    while (n && n !== document.body) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 4) return n;
      n = n.parentElement;
    }
    return null;
  }
  // ── 卡片瀑布分列 ─────────────────────────────────────────────────────────
  // 目标：卡片按各自自然高度往下排，列与列之间尽量齐平 —— 不出现「矮卡下面一大块空白」。
  // 做法：贪心（下一张卡进当前最矮的列，保持优先级顺序在列内自上而下）+ 一轮局部改进
  // （把某张卡挪到别的列，只要最高的列能变矮就保留）。宽度不够时自动退回单列。
  const CARD_MIN_W = 236;
  const CARD_GAP = 10;
  // 纯函数：按每张卡的高度把它们分到 n 列。贪心（下一张进当前最矮的列，保持原顺序），
  // 再补一轮「把某张卡挪到别的列、只要最高的列能变矮就保留」的局部改进。
  // 返回 picks[i] = 第 i 张卡该进第几列。
  function packColumns(heights, n) {
    const cols = [];
    for (let i = 0; i < n; i += 1) cols.push([]);
    const colH = (k) => cols[k].reduce((s, i) => s + heights[i] + CARD_GAP, 0);
    const tallest = () => { let m = 0; for (let k = 0; k < n; k += 1) m = Math.max(m, colH(k)); return m; };
    heights.forEach((h, i) => {
      let t = 0;
      for (let k = 1; k < n; k += 1) if (colH(k) < colH(t)) t = k;
      cols[t].push(i);
    });
    for (let from = 0; from < n; from += 1) {
      for (const i of cols[from].slice()) {
        const before = tallest();
        let to = -1;
        for (let k = 0; k < n; k += 1) if (k !== from && (to < 0 || colH(k) < colH(to))) to = k;
        if (to < 0) continue;
        cols[from].splice(cols[from].indexOf(i), 1);
        cols[to].push(i);
        if (tallest() < before) continue;        // 最高列变矮了 → 保留这次搬动
        cols[to].splice(cols[to].indexOf(i), 1); // 没改善 → 放回原列
        cols[from].push(i);
      }
    }
    const picks = new Array(heights.length).fill(0);
    cols.forEach((list, k) => list.forEach((i) => { picks[i] = k; }));
    return picks;
  }
  function layoutGrid(grid) {
    if (!grid) return;
    const cards = [].slice.call(grid.querySelectorAll(".uq-card"));
    if (!cards.length) return;
    // 先拆掉上一次的列容器（卡片放回 grid 平铺），窗口缩放时会重新走一遍
    [].slice.call(grid.querySelectorAll(":scope > .uq-col")).forEach((col) => {
      while (col.firstChild) grid.appendChild(col.firstChild);
      col.remove();
    });
    const wide = cards.filter((c) => c.classList.contains("wide"));
    const narrow = cards.filter((c) => !c.classList.contains("wide"));
    const width = grid.clientWidth || 0;
    // 面板还藏在别的 tab 里（宽度 0）：先保持平铺，等 ResizeObserver 报出真宽度再分列。
    if (!width && gridObserver) return;
    const n = Math.max(1, Math.min(narrow.length || 1, Math.floor((width + CARD_GAP) / (CARD_MIN_W + CARD_GAP))));
    const cols = [];
    for (let i = 0; i < n; i += 1) {
      const col = document.createElement("div");
      col.className = "uq-col";
      // 先挂到文档上：脱离文档的节点 offsetHeight 恒为 0，量不出高度就没法分列。
      grid.appendChild(col);
      cols.push(col);
    }
    // 先全塞第一列量高度：卡片进入列里宽度才是最终宽度（分列后的高度不随列高变化）。
    narrow.forEach((card) => cols[0].appendChild(card));
    const picks = packColumns(narrow.map((card) => card.offsetHeight), n);
    narrow.forEach((card, i) => { if (picks[i] !== 0) cols[picks[i]].appendChild(card); });
    // 宽卡（>=5 项）独占整行：告警/警告的钉在最上面（最要紧），其它排在所有列之后。
    const alarmWide = wide.filter((c) => c.classList.contains("alarm") || c.classList.contains("warn"));
    alarmWide.forEach((c) => grid.insertBefore(c, cols[0]));
    wide.filter((c) => alarmWide.indexOf(c) < 0).forEach((c) => grid.appendChild(c));
  }
  function layoutGrids(root) {
    const scope = (root && root.querySelectorAll) ? root : document;
    [].slice.call(scope.querySelectorAll(".uq-grid")).forEach(layoutGrid);
  }
  // 页面藏在别的 tab 里时量不到宽度（clientWidth=0，只能排成一列）；用 ResizeObserver
  // 在它真正有宽度那一刻补一次重排，切回来就是分好列的。
  const gridObserver = (typeof ResizeObserver === "function") ? new ResizeObserver((entries) => {
    entries.forEach((entry) => {
      const grid = entry.target;
      const w = Math.round(entry.contentRect.width);
      if (!w || grid.dataset.uqW === String(w)) return;
      grid.dataset.uqW = String(w);
      layoutGrid(grid);
    });
  }) : null;
  function watchGrids(root) {
    if (!gridObserver) return;
    const scope = (root && root.querySelectorAll) ? root : document;
    [].slice.call(scope.querySelectorAll(".uq-grid")).forEach((g) => gridObserver.observe(g));
  }
  let layoutTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(() => layoutGrids(document), 150);
  });

  // 内容变了才重排 DOM；重排时把滚动位置按原样放回去（否则每次后台刷新都跳回顶部）。
  function renderInto(body, html) {
    const sc = scrollParentOf(body);
    const top = sc ? sc.scrollTop : 0;
    body.innerHTML = html;
    layoutGrids(body);          // 卡片瀑布要按真实高度分列，插完 DOM 立刻分
    watchGrids(body);
    if (sc) sc.scrollTop = top;
  }
  function snapSig(snap) {
    return JSON.stringify([
      snap.enabled, snap.alertPercent,
      (snap.providers || []).map((p) => [p.id, p.ok, p.error, p.alert, p.stale, p.fromCache, p.credLabel,
        (p.items || []).map((it) => [it.id, it.used, it.total, it.remaining, it.percent, it.resetAt, it.note])]),
    ]);
  }

  async function loadDashboard(opts) {
    ensureStyle();
    const body = $("uqPanelBody");
    if (!body) return;
    const force = !!(opts && opts.force);
    const btn = $("uqRefreshBtn");
    if (btn) { btn.disabled = true; if (force) btn.textContent = "刷新中…"; }
    if (!body.dataset.rendered) body.innerHTML = '<div class="uq-empty"><b>正在读取各平台官方额度…</b>第一次会真的去问上游，通常几秒内出结果。</div>';
    try {
      const snap = force
        ? await api("/api/upstream-quota/refresh", { method: "POST", body: {} })
        : await api("/api/upstream-quota");
      lastSnap = snap;
      const sum = $("uqSummary");
      if (sum) sum.innerHTML = summaryHTML(snap);
      const sig = snapSig(snap);
      if (sig !== dashSig || body.dataset.rendered !== "1") {
        dashSig = sig;
        body.dataset.rendered = "1";
        renderInto(body, panelHTML(snap));
      }
    } catch (err) {
      body.dataset.rendered = "0";
      dashSig = "";
      renderInto(body, '<div class="uq-fail"><b>读取失败</b><p>' + esc(err.message) + '</p><p><code>GET /api/upstream-quota</code></p>'
        + '<p><button type="button" class="btn btn-outline btn-sm" onclick="UQ.load()">重试</button></p></div>');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "刷新全部"; }
    }
  }

  // 单个平台刷新：只换它那张卡并重算概览，不动整面板。
  async function refreshOne(id) {
    const card = document.querySelector('#uqPanelBody .uq-card[data-id="' + id + '"]');
    const btn = card && card.querySelector(".uq-icon");
    if (btn) btn.disabled = true;
    try {
      const r = await api("/api/upstream-quota/refresh", { method: "POST", body: { id: id } });
      const p = r.provider;
      if (p && lastSnap && Array.isArray(lastSnap.providers)) {
        const i = lastSnap.providers.findIndex((x) => x.id === p.id);
        if (i >= 0) lastSnap.providers[i] = p;
        lastSnap.generatedAt = Date.now();
      }
      if (card && p) {
        const wrap = document.createElement("div");
        wrap.innerHTML = cardHTML(p, (lastSnap && Number(lastSnap.alertPercent)) || ALERT_FALLBACK);
        card.replaceWith(wrap.firstElementChild);
      }
      if (lastSnap) {
        const body = $("uqPanelBody");
        const kpi = body && body.querySelector(".uq-kpi");
        if (kpi) kpi.outerHTML = kpiHTML(lastSnap.providers || [], lastSnap);
        const sum = $("uqSummary");
        if (sum) sum.innerHTML = summaryHTML(lastSnap);
        dashSig = "";   // 下一次自动刷新时允许按新数据重排
      }
    } catch (err) {
      if (card) card.insertAdjacentHTML("beforeend", '<div class="uq-alert">' + esc(err.message) + '</div>');
      if (btn) btn.disabled = false;
    }
  }

  // ── 设置页 ───────────────────────────────────────────────────────────────
  let CFG = null;
  let CATALOG = [];
  let CARRY = {};        // 本版本不认识的平台，保存时原样带回
  let LIVE = {};         // id → 最近一次快照里的读数（用于行内展示）

  function metaList() {
    const list = (typeof SETTINGS !== "undefined" && SETTINGS && SETTINGS.profiles) || [];
    return list.map((p) => ({ name: p.name, suffix: p.suffix }));
  }
  function profileOptions(selected) {
    const opts = ['<option value="">（选择方案）</option>'];
    for (const p of metaList()) {
      opts.push('<option value="' + attr(p.suffix) + '"' + (p.suffix === selected ? " selected" : "") + '>' + esc(p.name) + '（' + esc(p.suffix) + '）</option>');
    }
    return opts.join("");
  }
  function profileNameOf(suffix) {
    const p = metaList().find((x) => x.suffix === suffix);
    return (p && p.name) || "";
  }
  // 只列「配了密钥且没停用」的成员：选了一个没 Key 的成员，查的时候必然报「没有配置 Key」。
  function memberOptions(suffix, selected) {
    if (typeof SETTINGS === "undefined" || !SETTINGS || !SETTINGS.profileAssignments) return '<option value="">（无）</option>';
    const assign = SETTINGS.profileAssignments[suffix] || {};
    const users = SETTINGS.globalUsers || {};
    const rows = Object.entries(assign).filter((kv) => kv[1] && kv[1].key && !kv[1].disabled);
    if (!rows.length) return '<option value="">该方案还没有配置密钥的成员</option>';
    return rows.map((kv) => {
      const label = (users[kv[0]] && users[kv[0]].username) || kv[0].slice(0, 10);
      return '<option value="' + attr(kv[0]) + '"' + (kv[0] === selected ? " selected" : "") + '>' + esc(label) + '</option>';
    }).join("");
  }
  function keySourceOptions(cur) {
    return '<option value="auto"' + (cur === "auto" ? " selected" : "") + '>自动：复用方案里已有的密钥</option>'
      + '<option value="profile"' + (cur === "profile" ? " selected" : "") + '>指定方案 / 成员</option>'
      + '<option value="inline"' + (cur === "inline" ? " selected" : "") + '>手动填写 API Key</option>';
  }
  function fieldsOf(def) {
    return [].concat(def.fields || [], def.extraFields || []);
  }
  function inputHTML(f, extra) {
    const v = extra && extra[f.key] != null ? extra[f.key] : "";
    return '<div><label>' + esc(f.label || f.key) + '</label>'
      + '<input type="' + (f.type === "password" ? "password" : "text") + '" data-extra="' + attr(f.key) + '" autocomplete="off"'
      + ' value="' + attr(v) + '" placeholder="' + attr(f.placeholder || "") + '"></div>';
  }
  // 设置页每一行：左边平台名 + 状态，右边「最近读到什么」——数字放在这一行，
  // 不用展开就能看出哪些平台已经通了。
  function liveHTML(id) {
    const l = LIVE[id];
    if (!l) return '<span class="uq-p-live dim" data-live>未查询</span>';
    const cls = l.severity ? ' ' + l.severity : (l.dim ? " dim" : "");
    return '<span class="uq-p-live' + cls + '" data-live title="' + attr(l.title || l.text) + '">' + esc(l.text) + '</span>';
  }
  function stateChipHTML(p) {
    if (!p) return '<span class="uq-p-state" data-state>未查询</span>';
    if (p.manualOnly) return '<span class="uq-p-state" data-state>仅控制台</span>';
    if (p.enabled === false) return '<span class="uq-p-state" data-state>已关闭</span>';
    if (!p.ok) return p.configured
      ? '<span class="uq-p-state alarm" data-state title="' + attr(p.error || "") + '">查询失败</span>'
      : '<span class="uq-p-state" data-state title="' + attr(p.error || "") + '">未配置</span>';
    if (p.alert) return '<span class="uq-p-state alarm" data-state>额度告警</span>';
    return '<span class="uq-p-state ok" data-state>正常</span>';
  }

  // 设置页一卡：
  //   · 普通平台 —— 一个平台一卡（def + config.providers[id]）
  //   · 中转站型平台（multiInstance）—— 一个**站点**一卡（def + config.sites[] 里的一条），
  //     卡片 id 是「类型:站点key」（如 sub2api:lemon），多带一个「显示名」与「删除」。
  function cfgCardHTML(def, pc, opt) {
    const site = (opt && opt.site) || null;
    const id = site ? def.id + ":" + site.key : def.id;
    const manual = !!def.manualOnly;
    const credential = def.credential || "apiKey";
    const profOnly = !!def.profileOnly;   // Sub2API：地址 + Key 都只能从方案来
    const keySource = pc.keySource || "auto";
    const extra = pc.extra || {};
    // 支持「一键获取控制台令牌」的字段（def 上用 consoleLogin 标记；目前只有阿里云百炼）。
    const loginField = fieldsOf(def).find((f) => f && f.consoleLogin && f.consoleLogin.kind === "bailian") || null;
    const live = (lastSnap && (lastSnap.providers || []).find((p) => p.id === id)) || null;
    // 站点在自己这一行上就能改名（多个中转站要分得清哪个是哪个），普通平台的显示名在「高级」里。
    // profileOnly 型没有显示名：卡片名就跟着所选方案走。
    const nameField = site && !profOnly
      ? '<div><label>显示名<span style="color:var(--dim2)">（例如「XX 中转」）</span></label>'
        + '<input type="text" data-f="label" autocomplete="off" value="' + attr(pc.label || "") + '" placeholder="' + attr(def.name) + '"></div>'
      : "";

    let body = "";
    if (manual) {
      body = '<div class="uq-p-foot">'
        + (def.consoleUrl ? '<a class="btn btn-outline btn-sm" href="' + attr(def.consoleUrl) + '" target="_blank" rel="noopener">打开控制台</a>' : "")
        + (def.docsUrl ? '<a class="btn btn-outline btn-sm" href="' + attr(def.docsUrl) + '" target="_blank" rel="noopener">文档</a>' : "")
        + '</div>'
        + (def.note ? '<p class="uq-p-note">' + esc(def.note) + '</p>' : "");
    } else {
      const fromProfile = !!def.siteFromProfile;
      const token = !!def.tokenCredential;
      // 「方案」下拉：站点型平台（Sub2API / NewAPI）用它带出站点地址与成员 Key。
      // 管理面令牌型（NewAPI 的系统访问令牌）没有 keySource 下拉，所以这一格不挂 data-when。
      // 第二个参数 = 必选（Sub2API profileOnly：地址与 Key 都只能从方案来，不选就查不了）。
      const profileField = (when, required) => '<div' + (when
        ? ' data-when="profile"' + (keySource === "profile" ? "" : ' style="display:none"') : "") + '>'
        // 标签保持一行：写全「带出站点地址与成员 Key」会在窄列里折成两行，把下面的下拉框
        // 顶下去、和「成员」那一格对不齐（详见 uq-cfg-grid 的底部对齐）。说明挂在 title 上。
        + '<label' + (required ? ' title="一个方案 = 一个站点：站点地址与成员 Key 都从方案带出"' : "") + '>方案'
        + (required ? '<span style="color:var(--dim2)">（必选）</span>' : (fromProfile ? '<span style="color:var(--dim2)">（带出站点地址）</span>' : "")) + '</label>'
        + '<select data-f="profileSuffix" onchange="UQ.syncRow(this)">' + profileOptions(pc.profileSuffix || "") + '</select></div>';
      let cred;
      if (credential === "accessKey") {
        // 云平台凭据就是 AK/SK，没有「从方案里自动取」这条路，所以不给 keySource 下拉。
        cred = nameField + fieldsOf(def).map((f) => inputHTML(f, extra)).join("");
      } else if (token) {
        // 管理面令牌（NewAPI 的系统访问令牌）不是 sk- 中继 Key，方案只用来带出站点地址。
        cred = nameField + (fromProfile ? profileField(false) : "")
          + '<div><label>系统访问令牌</label><input type="text" data-f="apiKey" autocomplete="off" value="' + attr(pc.apiKey || "") + '" placeholder="控制台「个人设置 → 生成系统访问令牌」"></div>'
          + fieldsOf(def).map((f) => inputHTML(f, extra)).join("");
      } else if (credential === "none") {
        // 不需要「凭据来源」的平台（阶跃星辰 Step Plan）：凭据只有 extraFields 里那几格
        // （控制台令牌 / Oasis-Webid），没有 API Key、也不从方案里带 Key，所以只渲染额外字段。
        cred = nameField + fieldsOf(def).map((f) => inputHTML(f, extra)).join("");
      } else if (profOnly) {
        // Sub2API：一个方案 = 一个站点，地址与 Key 都从方案里来（方案是必选项），
        // 所以不给「凭据来源」也不给「显示名」——卡片名就是方案名。
        cred = profileField(false, true)
          + '<div><label>成员</label><select data-f="memberKey">' + memberOptions(pc.profileSuffix || "", pc.memberKey || "") + '</select></div>';
      } else {
        cred = nameField
          + '<div><label>凭据来源</label><select data-f="keySource" onchange="UQ.syncRow(this)">' + keySourceOptions(keySource) + '</select></div>'
          + profileField(true)
          + '<div data-when="profile"' + (keySource === "profile" ? "" : ' style="display:none"') + '><label>成员</label>'
          + '<select data-f="memberKey">' + memberOptions(pc.profileSuffix || "", pc.memberKey || "") + '</select></div>'
          + '<div data-when="inline"' + (keySource === "inline" ? "" : ' style="display:none"') + '><label>API Key</label>'
          + '<input type="text" data-f="apiKey" autocomplete="off" value="' + attr(pc.apiKey || "") + '" placeholder="sk-…"></div>';
      }
      body = '<div class="uq-cfg-grid">' + cred + '</div>'
        + '<details class="uq-adv"><summary>高级：接入点覆盖' + (site ? "" : " / 显示名") + '</summary>'
        + '<div class="uq-cfg-grid">'
        + '<div><label>接入点覆盖<span style="color:var(--dim2)">（留空=' + (fromProfile ? "方案地址" : "官方地址") + '）</span></label><input type="text" data-f="baseUrl" autocomplete="off" value="' + attr(pc.baseUrl || "") + '" placeholder="' + attr(fromProfile ? "站点根地址，例如 https://api.example.com" : "仅换域名，例如 https://api.z.ai") + '"></div>'
        + (site ? "" : '<div><label>显示名<span style="color:var(--dim2)">（留空=平台名）</span></label><input type="text" data-f="label" autocomplete="off" value="' + attr(pc.label || "") + '"></div>')
        + '</div></details>'
        + (def.localKey ? '<p class="uq-p-note">没填 Key 时会自动读本机 <b>' + esc(def.localKey.label || "登录凭据") + '</b>（只读；读不到才算未配置）。</p>' : "")
        + (def.note ? '<p class="uq-p-note">官方口径：' + esc(def.note) + '</p>' : "")
        + '<div class="uq-p-foot"><button type="button" class="btn btn-outline btn-sm" onclick="UQ.testProvider(\'' + attr(id) + '\',this)">查询一次</button>'
        + (loginField
          // 控制台令牌型（阿里云百炼）：不用装 CLI，点一下就在浏览器里完成授权回调。
          ? '<button type="button" class="btn btn-outline btn-sm" onclick="UQ.consoleLogin(\'' + attr(id) + '\',\'' + attr(loginField.key) + '\',this)">一键获取令牌</button>'
          : "")
        + '<span class="uq-probe" data-console-msg></span>'
        + '<span class="uq-probe" data-probe>' + (live && live.credLabel ? '<span style="color:var(--dim2)">凭据：' + esc(live.credLabel) + '</span>' : "") + '</span>'
        + (site ? '<button type="button" class="btn btn-outline btn-sm uq-del" onclick="UQ.delSite(this)">删除这个站点</button>' : "")
        + '</div>'
        + (loginField && !consoleLoginReachable()
          // 百炼控制台授权页的回调是硬编码 http 的，浏览器只对回环地址豁免 mixed-content：
          // 用域名 / 局域网 IP 打开面板时，那个 POST 会被拦在本地，面板永远等不到令牌。
          ? '<p class="uq-p-note uq-alarm">当前面板地址（' + esc(location.hostname) + '）不在回环地址上，浏览器会拦下授权回调'
            + '（控制台授权页固定向 <b>http://' + esc(location.hostname) + '</b> 发令牌，https 页面发这种请求会被按混合内容拦掉）。'
            + '可改用 <b>ssh -L 6789:127.0.0.1:6789</b> 隧道后访问 <b>http://127.0.0.1:6789</b> 再点这个按钮；'
            + '或在你自己电脑上跑 <b>node tools/bailian-console-login.mjs</b>，把打印出来的令牌粘到上面的「控制台令牌」里；'
            + '最省事的是给这把 AccessKey 加 <b>modelstudio:GenerateCLIAccessToken</b> 权限，面板会自动换取 / 自动续期。</p>'
          : "");
    }

    // data-ksdef：这张卡没有「凭据来源」下拉时，collect() 用它当默认来源
    // （NewAPI 是手动令牌 = inline；Sub2API 走方案 = profile）。
    // data-site-type / data-site-key：站点卡，collect() 按这两个属性收进 config.sites[]。
    const ksDef = def.defaultKeySource || (credential === "none" ? "inline" : "auto");
    return '<details class="uq-cfg uq-p" data-id="' + attr(id) + '" data-credential="' + attr(credential) + '" data-ksdef="' + attr(ksDef) + '"'
      + (profOnly ? ' data-prof-only="1"' : "")
      + (site ? ' data-site-type="' + attr(def.id) + '" data-site-key="' + attr(site.key) + '"' : "") + '>'
      + '<summary>'
      + (manual ? "" : '<input type="checkbox" class="uq-en" data-f="enabled"' + (pc.enabled === false ? "" : " checked") + ' onclick="event.stopPropagation()" title="启用 / 停用这个平台">')
      + (manual ? '<span class="led"></span>' : '<span class="led' + (live && live.ok && live.enabled !== false ? " on" : "") + '"></span>')
      + '<span class="uq-p-name">' + esc(site ? (profOnly ? (profileNameOf(pc.profileSuffix) || def.name) : (pc.label || def.name)) : def.name) + '</span>'
      + (site ? '<span class="uq-p-tag" title="' + attr(def.name) + '">' + esc(def.name) + '</span>' : "")
      + (def.experimental ? '<span class="uq-p-tag exp" title="接口未文档化，上游随时可能改">实验</span>' : "")
      + liveHTML(id)
      + stateChipHTML(live)
      + '</summary>'
      + '<div class="uq-p-body">' + body + '</div>'
      + '</details>';
  }

  function globalsHTML(cfg) {
    const g = (k, label, hint, min, max, val) => '<div><label>' + label + (hint ? '<span style="color:var(--dim2)">' + hint + '</span>' : '') + '</label>'
      + '<input type="number" data-g="' + k + '" min="' + min + '" max="' + max + '" value="' + attr(val) + '"></div>';
    return '<div class="uq-bar">'
      + '<span class="uq-bar-t">上游额度</span>'
      + '<label class="uq-sw">总开关 <select data-g="enabled"><option value="1"' + (cfg.enabled ? " selected" : "") + '>开</option><option value="0"' + (cfg.enabled ? "" : " selected") + '>关</option></select></label>'
      + '<span class="uq-status" id="uqCfgStatus"></span>'
      + '<button type="button" class="btn btn-primary btn-sm" onclick="UQ.saveSettings()">保存全部</button>'
      + '<button type="button" class="btn btn-outline btn-sm" onclick="UQ.refresh()">刷新全部</button>'
      + '<a class="btn btn-outline btn-sm" href="/dashboard">去面板看 →</a>'
      + '</div>'
      + '<details class="uq-adv" style="margin:-6px 0 16px"><summary>高级：缓存 / 自动刷新 / 超时 / 告警阈值</summary>'
      + '<div class="uq-cfg-grid">'
      + g("cacheSeconds", "缓存秒数", "（同一平台多久内不重复请求）", 0, 86400, cfg.cacheSeconds)
      + g("autoRefreshMinutes", "自动刷新", "（分钟，0=只在你打开面板时查）", 0, 1440, cfg.autoRefreshMinutes)
      + g("timeoutMs", "请求超时", "（毫秒）", 1000, 60000, cfg.timeoutMs)
      + g("alertPercent", "告警阈值", "（套餐用量到该比例标红）", 1, 100, cfg.alertPercent)
      + '</div></details>';
  }

  // 中转站型平台：一段标题 + 「＋ 添加站点」按钮 + 每个站点一张卡（各自的名字 / 方案 / 令牌）。
  function sitesBlockHTML(def, list) {
    const hint = def.profileOnly
      ? "一个方案一个站点：选好方案就够了，地址与 Key 都从方案来（可以加多个）"
      : (def.tokenCredential ? "一个站点一张卡：站点地址 + 系统访问令牌（可以加多个）"
        : "一个站点一张卡：选方案带出地址与成员 Key（可以加多个）");
    const empty = def.profileOnly
      ? '还没有站点：点右上角「＋ 添加站点」，再选一个建好的中转方案（地址与 Key 都从方案来）。'
      : '还没有站点：点右上角「＋ 添加站点」，填个显示名（例如「XX 中转」）；地址可以选一个中转方案带出来，也可以在「高级：接入点覆盖」里直接填站点根地址。';
    return '<div class="uq-sites" data-sites="' + attr(def.id) + '">'
      + '<div class="uq-sites-hd"><span class="uq-sites-name">' + esc(def.name) + '</span>'
      + '<em>' + esc(hint) + '</em>'
      + '<button type="button" class="btn btn-outline btn-sm" onclick="UQ.addSite(\'' + attr(def.id) + '\')">＋ 添加站点</button></div>'
      + list.map((s) => cfgCardHTML(def, s, { site: s })).join("")
      + '<p class="uq-p-note uq-sites-empty"' + (list.length ? ' style="display:none"' : "") + '>' + esc(empty) + '</p>'
      + '</div>';
  }

  function settingsFormHTML(cfg, catalog) {
    const known = new Set(catalog.map((d) => d.id));
    let html = globalsHTML(cfg);
    html += '<p class="uq-lead">点平台行展开改凭据，<b>「查询一次」当场验证</b>；凭据默认<b>自动</b>＝复用方案里已有的成员密钥。数字来自上游官方接口，与本地配额是两套口径。中转站可以加多个站点。</p>';
    const sites = Array.isArray(cfg.sites) ? cfg.sites : [];
    // 与面板同一套分桶：Plan / 余额两段。设置页也照这个走，免得两个页面对不上。
    for (const b of BUCKET_ORDER) {
      const list = catalog.filter((d) => (d.bucket || "balance") === b);
      if (!list.length) continue;
      const singles = list.filter((d) => !d.multiInstance);
      const multis = list.filter((d) => d.multiInstance);
      const count = singles.length + multis.reduce((n, d) => n + sites.filter((s) => s.type === d.id).length, 0);
      html += '<div class="uq-sec"><div class="uq-sec-hd">' + esc(BUCKET_LABEL[b] || b) + '<em>' + esc(BUCKET_HINT[b] || "") + '</em><em style="margin-left:auto">' + count + ' 个</em></div>';
      html += singles.map((def) => cfgCardHTML(def, cfg.providers[def.id] || {})).join("");
      for (const def of multis) html += sitesBlockHTML(def, sites.filter((s) => s.type === def.id));
      html += '</div>';
    }
    const unknown = Object.keys(cfg.providers || {}).filter((id) => !known.has(id));
    if (unknown.length) {
      html += '<p class="uq-p-note">配置里有 ' + unknown.length + ' 个本版本不认识的平台（' + esc(unknown.join("、")) + '），保存时原样保留。</p>';
    }
    return html;
  }

  // 快照里的读数 → 设置页行内大字。挑最该看的那一项：
  // 有余额就用余额；只要有窗口进了告警/临界区，就把最紧的那个窗口一并挂在后面
  // （否则一行明明标着「额度告警」，大字却是另一个平台的余额，看着自相矛盾）。
  function buildLive(snap) {
    const out = {};
    const alertPercent = Number(snap && snap.alertPercent) || ALERT_FALLBACK;
    const compact = (s) => String(s == null ? "" : s).replace(/窗口/g, "").replace(/\s+/g, " ").trim();
    for (const p of (snap && snap.providers) || []) {
      if (p.manualOnly) continue;
      if (!p.enabled) { out[p.id] = { text: "未查询", dim: true }; continue; }
      if (!p.ok) { out[p.id] = { text: "—", dim: true, title: p.error || "" }; continue; }
      const items = p.items || [];
      const bal = items.find((it) => it.kind === "balance");
      const quotas = items.filter((it) => it.kind === "quota");
      let worst = null, worstPct = -1;
      for (const q of quotas) { const pct = usedPercent(q); if (pct !== null && pct > worstPct) { worstPct = pct; worst = q; } }
      const worstSev = worstPct < 0 ? "" : severity(worstPct, alertPercent);
      const pctText = (q, pct) => compact(q.label) + " " + (pct === null ? "已用 " + fmtValue(q.used, q.unit) : pctStr(pct) + "%");
      const windowsTitle = quotas.map((q) => (q.label || "窗口") + "：" + (usedPercent(q) === null ? fmtValue(q.used, q.unit) : pctStr(usedPercent(q)) + "%")).join("；");
      if (bal) {
        const money = fmtMoney(bal.remaining, bal.unit);
        const zero = Number(bal.remaining) <= 0;
        // 同时有窗口与余额的平台（智谱、火山），把**最紧的窗口**摆在前面——那才是会卡住
        // 你的数字，余额放后面；纯余额平台只显示金额。窗口不设阈值门槛，低百分比也显示：
        // 否则火山这种 session/weekly/monthly 全在预警线以下的平台，这一行会只剩 ¥0.00，
        // 看不出它到底有没有套餐窗口。
        const winText = (worst && worstPct >= 0) ? pctText(worst, worstPct) : "";
        out[p.id] = {
          text: winText ? winText + " · " + money : money,
          severity: zero ? "alarm" : worstSev,
          title: (bal.label || "可用余额") + "：" + money + (windowsTitle ? "；" + windowsTitle : ""),
        };
      } else if (quotas.length) {
        out[p.id] = {
          text: pctText(worst, worstPct) + (quotas.length > 1 ? " · 共 " + quotas.length + " 个窗口" : ""),
          severity: worstSev,
          title: windowsTitle,
        };
      } else {
        out[p.id] = { text: "无额度字段", dim: true, title: "上游返回成功，但没有可识别的额度字段" };
      }
    }
    return out;
  }

  async function loadSettings() {
    ensureStyle();
    const body = $("uqCfgBody");
    if (!body) return;
    if (!CFG) body.innerHTML = '<div class="uq-empty"><b>正在读取平台配置…</b></div>';
    // 配置先渲染（本地读，秒回），最近读数随后补进来，不让面板空等上游。
    try {
      const r = await api("/api/upstream-quota/config");
      CATALOG = r.catalog || [];
      CFG = r.config || {};
      body.innerHTML = settingsFormHTML(CFG, CATALOG);
      renderUnknownCarryOver();
    } catch (err) {
      body.innerHTML = '<div class="uq-fail"><b>读取配置失败</b><p>' + esc(err.message) + '</p>'
        + '<p><code>GET /api/upstream-quota/config</code> · 若提示登录过期，请刷新页面重新登录</p>'
        + '<p><button type="button" class="btn btn-outline btn-sm" onclick="UQ.loadSettings()">重试</button></p></div>';
      return;
    }
    try {
      const snap = await api("/api/upstream-quota");
      lastSnap = snap;
      LIVE = buildLive(snap);
      fillLive();
    } catch (err) {
      // 读数补不上不影响改配置：在顶部状态里说明即可。
      setStatus("最近读数拿不到：" + clip(err.message, 60), "err");
    }
  }

  function fillLive() {
    document.querySelectorAll("#uqCfgBody .uq-p[data-id]").forEach((row) => {
      const id = row.getAttribute("data-id");
      const holder = row.querySelector("[data-live]");
      if (holder) holder.outerHTML = liveHTML(id);
      const chip = row.querySelector("[data-state]");
      const p = (lastSnap && (lastSnap.providers || []).find((x) => x.id === id)) || null;
      if (chip) chip.outerHTML = stateChipHTML(p);
      const led = row.querySelector("summary .led");
      if (led) led.className = "led" + (p && p.ok && p.enabled !== false ? " on" : "");
    });
  }

  function renderUnknownCarryOver() {
    CARRY = {};
    if (!CFG || !CFG.providers) return;
    const known = new Set(CATALOG.map((d) => d.id));
    for (const [id, v] of Object.entries(CFG.providers)) if (!known.has(id)) CARRY[id] = v;
  }

  function setStatus(msg, cls) {
    const el = $("uqCfgStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "uq-status" + (cls ? " " + cls : "");
  }

  // 表单 → 保存体。数字字段 Number() 后交给服务端归一化（那边还会夹紧）。
  // 普通平台收进 providers{}；中转站站点收进 sites[]（同一类型可以有多条）。
  function collect() {
    const providers = Object.assign({}, CARRY);
    const sites = [];
    document.querySelectorAll("#uqCfgBody .uq-cfg[data-id]").forEach((card) => {
      const id = card.getAttribute("data-id");
      const pick = (f) => card.querySelector('[data-f="' + f + '"]');
      const val = (f) => { const el = pick(f); return el ? String(el.value == null ? "" : el.value) : ""; };
      const extra = {};
      card.querySelectorAll("[data-extra]").forEach((el) => { extra[el.getAttribute("data-extra")] = el.value; });
      const en = pick("enabled");
      const credential = card.getAttribute("data-credential") || "apiKey";
      const entry = {
        enabled: en ? !!en.checked : true,
        // 没有「凭据来源」下拉的卡（NewAPI 的系统访问令牌）用它自带的默认来源，别回落成 auto。
        keySource: val("keySource") || card.getAttribute("data-ksdef") || "auto",
        apiKey: val("apiKey"),
        profileSuffix: val("profileSuffix"),
        memberKey: val("memberKey"),
        baseUrl: val("baseUrl").trim(),
        label: val("label").trim(),
        extra: extra,
      };
      const siteType = card.getAttribute("data-site-type");
      if (siteType) {
        sites.push(Object.assign({ type: siteType, key: card.getAttribute("data-site-key") || "" }, entry));
      } else {
        providers[id] = entry;
      }
    });
    const g = (k, dflt) => { const el = document.querySelector('#uqCfgBody [data-g="' + k + '"]'); return el ? el.value : dflt; };
    return {
      enabled: g("enabled", "1") === "1",
      cacheSeconds: Number(g("cacheSeconds", 300)),
      autoRefreshMinutes: Number(g("autoRefreshMinutes", 0)),
      timeoutMs: Number(g("timeoutMs", 10000)),
      alertPercent: Number(g("alertPercent", 90)),
      providers: providers,
      sites: sites,
    };
  }

  // 分组标题右边的「N 个」：加/删站点后要跟着变，否则会出现「删掉一张卡，标题还写着 4 个」。
  function refreshSecCount(sec) {
    if (!sec) return;
    const em = sec.querySelector(".uq-sec-hd em:last-of-type");
    if (em) em.textContent = sec.querySelectorAll(".uq-cfg[data-id]").length + " 个";
  }

  // 「＋ 添加站点」：先在页面上插一张空卡（key 由前端生成，只做内部标识），
  // 填完点「保存全部」才落盘 —— 与其它改动一致，不点保存就什么都不改。
  function addSite(type) {
    const def = (CATALOG || []).find((d) => d.id === type);
    const block = document.querySelector('#uqCfgBody [data-sites="' + type + '"]');
    if (!def || !block) return;
    const used = new Set([].map.call(block.querySelectorAll(".uq-cfg[data-site-key]"), (el) => el.getAttribute("data-site-key")));
    let key = "s1", n = 1;
    while (used.has(key)) key = "s" + (++n);
    const tmp = document.createElement("div");
    tmp.innerHTML = cfgCardHTML(def, { key: key, type: type, label: "", enabled: true, keySource: def.defaultKeySource || "auto", extra: {} }, { site: { key: key, type: type } });
    const card = tmp.firstChild;
    const empty = block.querySelector(".uq-sites-empty");
    if (empty) block.insertBefore(card, empty); else block.appendChild(card);
    card.open = true;
    if (empty) empty.style.display = "none";
    refreshSecCount(card.closest(".uq-sec"));
    // Sub2API（profileOnly）没有「显示名」，第一个要填的是方案；NewAPI 先填显示名。
    const focusTarget = card.querySelector('[data-f="label"]') || card.querySelector('[data-f="profileSuffix"]');
    if (focusTarget) focusTarget.focus();
  }

  // 删除站点：只从页面上拿掉，点「保存全部」后服务端配置里那条才会消失。
  function delSite(btn) {
    const card = btn && btn.closest ? btn.closest(".uq-cfg") : null;
    if (!card) return;
    const block = card.closest("[data-sites]");
    const name = card.querySelector(".uq-p-name");
    card.remove();
    const left = block ? block.querySelectorAll(".uq-cfg[data-site-key]").length : 0;
    const empty = block && block.querySelector(".uq-sites-empty");
    if (empty) empty.style.display = left ? "none" : "";
    refreshSecCount(block && block.closest(".uq-sec"));
    setStatus("已移除「" + clip((name && name.textContent) || "站点", 20) + "」——点「保存全部」后生效");
  }

  async function saveSettings() {
    setStatus("保存中…");
    try {
      const r = await api("/api/upstream-quota/save", { method: "POST", body: collect() });
      CFG = r.config || CFG;
      CATALOG = r.catalog || CATALOG;
      const body = $("uqCfgBody");
      if (body) body.innerHTML = settingsFormHTML(CFG, CATALOG);
      renderUnknownCarryOver();
      setStatus("已保存", "ok");
      // 保存后把读数刷新一遍，立刻能看到新配置的效果（单平台失败只影响那一行）。
      try {
        const snap = await api("/api/upstream-quota");   // 改动过的平台缓存已在服务端失效，这里拿到的就是新数字
        lastSnap = snap;
        LIVE = buildLive(snap);
        fillLive();
      } catch (e) { /* 读数拿不到就保持「已保存」，不覆盖成功提示 */ }
    } catch (err) {
      setStatus("保存失败：" + clip(err.message, 80), "err");
    }
  }

  // 单平台试查：结果直接写在那张行里（大号数字 + 状态）。
  async function testProvider(id, btn) {
    const row = document.querySelector('#uqCfgBody .uq-p[data-id="' + id + '"]');
    const probe = row && row.querySelector("[data-probe]");
    if (btn) { btn.disabled = true; btn.textContent = "查询中…"; }
    if (probe) probe.innerHTML = '<span style="color:var(--dim2)">正在请求上游…</span>';
    try {
      const r = await api("/api/upstream-quota/refresh", { method: "POST", body: { id: id } });
      const p = r.provider || {};
      if (probe) probe.innerHTML = probeHTML(p);
      if (lastSnap && Array.isArray(lastSnap.providers)) {
        const i = lastSnap.providers.findIndex((x) => x.id === (p.id || id));
        if (i >= 0) lastSnap.providers[i] = p; else lastSnap.providers.push(p);
      } else {
        lastSnap = { providers: [p], alertPercent: 90 };
      }
      LIVE = Object.assign(LIVE, buildLive({ providers: [p], alertPercent: (lastSnap && lastSnap.alertPercent) || ALERT_FALLBACK }));
      fillLive();
    } catch (err) {
      // 新加的站点还没保存时后端不认识它的 id，报「未知平台」——这是操作顺序问题，不是配置坏了。
      const unsavedSite = row && row.getAttribute("data-site-type") && /未知平台/.test(err.message || "");
      const msg = unsavedSite ? "这个站点还没保存：先点右上角「保存全部」，再查询" : err.message;
      if (probe) probe.innerHTML = '<span class="uq-p-state alarm">查询失败</span> ' + esc(msg);
      setStatus("查询失败：" + clip(msg, 60), "err");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "查询一次"; }
    }
  }
  // 「查询一次」的结果：把关键数字摊开，不写成长句。
  function probeHTML(p) {
    if (p.error) return '<span class="uq-p-state alarm">失败</span> <span style="color:var(--red)">' + esc(clip(p.error, 140)) + '</span>';
    const items = (p.items || []);
    const nums = items.map((it) => {
      const label = esc(it.label || "额度");
      if (it.kind === "balance") return label + ' <b>' + esc(fmtMoney(it.remaining, it.unit)) + '</b>';
      const pct = usedPercent(it);
      return label + ' <b>' + (pct === null ? esc(fmtValue(it.used, it.unit)) : pctStr(pct) + "%") + '</b>';
    }).join('<span style="color:var(--dim2)"> · </span>');
    return '<span class="uq-p-state ok">读到 ' + items.length + ' 项</span> <span class="uq-probe">' + (nums || "上游返回成功，但没有可识别的额度字段")
      + (p.credLabel ? '<span style="color:var(--dim2)"> · 凭据：' + esc(p.credLabel) + '</span>' : "") + '</span>';
  }

  // 浏览器只对回环地址豁免 mixed-content，而百炼控制台授权页的回调是硬编码 http 的
  // （其 bundle 里就是 fetch("http://".concat(notice))），所以只有从 127.0.0.1 / localhost
  // 打开面板时「一键获取令牌」才可能成功。
  function consoleLoginReachable() {
    const h = String(location.hostname || "").toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  }

  // 一键获取控制台令牌（阿里云百炼）：
  //   服务端生成一次性 state，把「授权回调地址」写成浏览器正在访问的这个地址（Host 头）→
  //   打开百炼控制台的授权页 → 控制台把 access_token POST 回本面板 → 服务端写进
  //   本平台的「控制台令牌」→ 这里轮询到 saved 后把输入框填上并立刻查一次。
  //   等价于官方 CLI 的 auth login --console，但不用装 CLI；本机访问、SSH 隧道都直接可用
  //   （面板是 http 的局域网 IP 时，浏览器会拦下 https 控制台页面发来的回调，改用 AK/SK 自动换取或手动粘贴）。
  async function consoleLogin(id, fieldKey, btn) {
    const card = document.querySelector('#uqCfgBody .uq-cfg[data-id="' + id + '"]');
    const msg = card && card.querySelector("[data-console-msg]");
    const say = (text, cls) => {
      if (!msg) return;
      msg.innerHTML = text ? '<span class="' + (cls || "") + '">' + esc(text) + '</span>' : "";
    };
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "等待授权…"; }
    try {
      say("正在打开百炼控制台授权页…", "dim");
      const start = await api("/api/upstream-quota/console-login/start", { method: "POST", body: { id: id } });
      if (!start || !start.ok || !start.url) throw new Error((start && start.error) || "启动授权失败");
      const win = window.open(start.url, "_blank", "noopener");
      const blocked = start.loopback === false;
      if (blocked) {
        // 回调地址不是回环地址：浏览器的混合内容拦截一定会把授权页发来的 POST 挡在本地。
        say("当前面板地址不在回环地址上，浏览器会拦下授权回调（控制台授权页固定向 http://"
          + (start.notice || location.hostname) + " 发令牌）。请改用 SSH 隧道后访问 http://127.0.0.1:6789 再点，"
          + "或在电脑上跑 node tools/bailian-console-login.mjs 拿令牌粘进来；加 modelstudio:GenerateCLIAccessToken 权限可自动续期。", "alarm");
      } else {
        say("已打开授权页：在浏览器里登录并点「授权」，完成后这里会自动填好（最多等 5 分钟）", "dim");
      }
      if (!win) say("浏览器可能拦截了弹窗：请允许弹窗，或手动打开 " + start.url, "alarm");
      // 回调一定收不到时别让用户干等 5 分钟，45 秒就给结论。
      const waitMs = blocked ? 45 * 1000 : 5 * 60 * 1000;
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 1500));
        const p = await api("/api/upstream-quota/console-login/poll", { method: "POST", body: { state: start.state } });
        if (!p) throw new Error("查询授权状态失败");
        if (p.status === "saved") {
          await fillConsoleToken(id, p.field || fieldKey);
          say("令牌已保存，正在查询上游…", "dim");
          if (typeof toast === "function") toast("控制台令牌已获取并保存");
          try { await testProvider(id); } catch (e) { /* 查询失败只影响读数，令牌已存好 */ }
          say("令牌已保存");
          return;
        }
        if (p.status === "error") throw new Error(p.error || "授权失败");
        if (p.status === "expired") throw new Error(p.error || "授权会话已过期，请重新点「一键获取令牌」");
      }
      throw new Error("等待授权超时。请确认浏览器能打开本面板这个地址（本机 127.0.0.1，或 SSH 隧道转发到 127.0.0.1）；"
        + "服务器上没有浏览器时，可给 AccessKey 加 modelstudio:GenerateCLIAccessToken 权限让平台自动换取，或手动粘贴令牌");
    } catch (err) {
      say(err.message || String(err), "alarm");
      setStatus("获取令牌失败：" + clip(err.message || String(err), 60), "err");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old || "一键获取令牌"; }
    }
  }

  // 令牌由服务端写进配置后，把它读回来填进输入框（顺带同步本地 CFG，避免下次保存把它覆盖掉）。
  async function fillConsoleToken(id, fieldKey) {
    const r = await api("/api/upstream-quota/config");
    const cfg = (r && r.config) || null;
    if (!cfg) return;
    CFG = cfg;
    const p = (cfg.providers || {})[id] || {};
    const ex = p.extra || {};
    const card = document.querySelector('#uqCfgBody .uq-cfg[data-id="' + id + '"]');
    if (!card) return;
    const inp = card.querySelector('input[data-extra="' + fieldKey + '"]');
    if (inp) inp.value = ex[fieldKey] || "";
    const region = card.querySelector('input[data-extra="consoleRegion"]');
    if (region && ex.consoleRegion) region.value = ex.consoleRegion;
  }

  // 凭据来源 / 方案切换：显隐相关输入框并刷新成员下拉。
  function syncRow(el) {
    const card = el && el.closest ? el.closest(".uq-cfg") : null;
    if (!card) return;
    const ks = card.querySelector('[data-f="keySource"]');
    const cur = ks ? ks.value : "auto";
    card.querySelectorAll("[data-when]").forEach((box) => { box.style.display = box.getAttribute("data-when") === cur ? "" : "none"; });
    if (el.getAttribute && el.getAttribute("data-f") === "profileSuffix") {
      const member = card.querySelector('[data-f="memberKey"]');
      if (member) member.innerHTML = memberOptions(el.value, "");
      // profileOnly 型（Sub2API）：卡片名就是方案名，换方案时立刻跟着变。
      if (card.getAttribute("data-prof-only") === "1") {
        const nm = card.querySelector(".uq-p-name");
        const tag = card.querySelector(".uq-p-tag");
        if (nm) nm.textContent = profileNameOf(el.value) || (tag ? tag.textContent : "");
      }
    }
  }

  // ── 入口 ──────────────────────────────────────────────────────────────────
  // 设置页左下角的「上游额度」按钮（lib/pages.mjs 的 .sidebar-ft）走这里。
  window.openUpstreamQuotaView = function () {
    const form = $("settingsForm");
    if (typeof window.hideAllSecondaryViews === "function") window.hideAllSecondaryViews();
    if (form) form.hidden = true;
    const view = $("upstreamQuotaView");
    if (!view) return;
    view.hidden = false;
    view.setAttribute("aria-hidden", "false");
    const nav = $("upstreamQuotaNav");
    if (nav) nav.classList.add("active");
    const main = view.closest(".main");
    if (main) main.scrollTop = 0;       // 视图切换后停在原滚动位置会看到一片空白
    else window.scrollTo(0, 0);
    loadSettings();
  };

  window.UQ = {
    load: () => loadDashboard(),
    refresh: () => loadDashboard({ force: true }),
    refreshOne: refreshOne,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    testProvider: testProvider,
    consoleLogin: consoleLogin,
    syncRow: syncRow,
    collect: collect,
    addSite: addSite,
    delSite: delSite,
    moreToggle: moreToggle,
  };

  ensureStyle();
})();
