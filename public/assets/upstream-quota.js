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

  const GROUP_ORDER = ["套餐额度", "官方余额", "云平台账户", "自定义", "仅控制台"];
  const GROUP_HINT = {
    "套餐额度": "订阅制套餐的 5 小时 / 每周 / 每月窗口",
    "官方余额": "充值余额或开发者账户余额",
    "云平台账户": "云账号余额，需要 AccessKey / SecretKey",
    "自定义": "中转网关（Sub2API / NewAPI）与任何能返回 JSON 的额度接口",
    "仅控制台": "官方没有可编程接口，只能点进控制台看",
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
      ".uq-kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:10px;margin:0 0 18px}",
      ".uq-kpi-t{border:1px solid var(--border);border-radius:10px;padding:9px 13px;background:var(--surface)}",
      ".uq-kpi-t b{display:block;font-size:22px;font-weight:700;line-height:1.15;font-variant-numeric:tabular-nums}",
      ".uq-kpi-t span{font-size:11px;color:var(--dim)}",
      ".uq-kpi-t.alarm b,.uq-kpi-t.err b{color:var(--red)}",
      ".uq-kpi-t.ok b{color:var(--green)}",
      ".uq-kpi-t.off b{color:var(--dim2)}",
      ".uq-kpi-t.time{grid-column:span 2}",
      ".uq-kpi-t.time b{font-size:15px;font-weight:600}",
      // 分组
      ".uq-sec{margin:0 0 22px}",
      ".uq-sec:last-child{margin-bottom:4px}",
      ".uq-sec-hd{display:flex;align-items:baseline;gap:8px;font-size:11.5px;font-weight:650;color:var(--dim);letter-spacing:.06em;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid var(--border)}",
      ".uq-sec-hd em{font-style:normal;font-weight:400;font-size:11px;color:var(--dim2);letter-spacing:0}",
      ".uq-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:12px;align-items:start}",
      // 卡片
      ".uq-card{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:12px 14px}",
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
      ".uq-bal{margin:7px 0 0}",
      ".uq-bal-v{font-size:29px;font-weight:700;line-height:1.1;letter-spacing:-.02em;font-variant-numeric:tabular-nums;white-space:nowrap}",
      ".uq-bal-v small{font-size:14px;font-weight:600;color:var(--dim);margin-left:3px}",
      ".uq-bal-v.alarm{color:var(--red)}",
      ".uq-bal-l{font-size:11.5px;color:var(--dim);margin-top:2px}",
      ".uq-bal-m{font-size:11px;color:var(--dim2);margin-top:5px;font-variant-numeric:tabular-nums}",
      // 套餐窗口
      ".uq-q{margin:11px 0 0}",
      ".uq-q:first-of-type{margin-top:8px}",
      ".uq-q-hd{display:flex;align-items:baseline;gap:8px;font-size:11.5px;color:var(--dim)}",
      ".uq-q-hd b{margin-left:auto;font-size:19px;font-weight:700;line-height:1.15;color:var(--text);font-variant-numeric:tabular-nums}",
      ".uq-q-hd b.warn{color:var(--orange)}",
      ".uq-q-hd b.alarm{color:var(--red)}",
      ".uq-q .quota-progress{display:block;width:100%;height:6px;margin:5px 0 4px;border-radius:3px}",
      ".uq-q .quota-progress>i{transition:width .3s}",
      ".uq-q-sub{font-size:11px;color:var(--dim2);font-variant-numeric:tabular-nums}",
      // 卡片内的异常/提示
      ".uq-alert{margin:8px 0 0;font-size:11.5px;line-height:1.5;color:var(--red);word-break:break-word}",
      ".uq-warnline{margin:6px 0 0;font-size:11px;line-height:1.5;color:var(--orange)}",
      ".uq-card-ft{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:auto;padding-top:9px;font-size:10.5px;color:var(--dim2)}",
      ".uq-card-ft a{color:var(--dim2)}",
      ".uq-card-ft a:hover{color:var(--accent)}",
      ".uq-src{margin-left:auto}",
      // 无数据的平台：压成一排小字行
      ".uq-rows{display:flex;flex-wrap:wrap;gap:7px 16px;padding:9px 12px;margin-top:11px;border:1px dashed var(--border);border-radius:9px;background:var(--surface-subtle)}",
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
      ".uq-p-note{margin:10px 0 0;font-size:11px;color:var(--dim2);line-height:1.65}",
      ".uq-p-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:11px}",
      ".uq-probe{font-size:11.5px;line-height:1.6;min-width:0}",
      ".uq-probe .uq-p-live{font-size:14px;margin-left:0}",
      ".uq-cfg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(212px,1fr));gap:10px;margin-top:11px}",
      ".uq-cfg-grid label{display:block;font-size:11px;color:var(--dim);margin-bottom:3px}",
      ".uq-cfg-grid input,.uq-cfg-grid select{width:100%}",
      ".uq-adv{margin-top:11px;font-size:11.5px}",
      ".uq-adv>summary{cursor:pointer;color:var(--dim2);list-style:none;display:inline-block}",
      ".uq-adv>summary::-webkit-details-marker{display:none}",
      ".uq-adv>summary:hover{color:var(--accent)}",
      ".uq-sw{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dim)}",
      ".uq-sw select{width:auto}",
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
    if (unit && !/[A-Za-z0-9]/.test(String(unit))) return fmtMoney(v, unit); // 上游给的就是符号
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
    const alarm = it.remaining !== null && it.remaining !== undefined && Number(it.remaining) <= 0;
    return '<div class="uq-bal">'
      + '<div class="uq-bal-v' + (alarm ? " alarm" : "") + '">' + esc(fmtMoney(it.remaining, it.unit)) + '</div>'
      + '<div class="uq-bal-l">' + esc(it.label || "可用余额") + '</div>'
      + (it.note ? '<div class="uq-bal-m">' + esc(it.note) + '</div>' : "")
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
      + '</div>';
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
    const body = items.map((raw) => {
      const it = Object.assign({}, raw, { label: labelOf(raw) });
      return it.kind === "balance" ? balanceHTML(it) : quotaHTML(it, alertPercent);
    }).join("");
    const cls = "uq-card" + (st.key === "alert" || st.key === "failed" ? " alarm" : (p.alert ? " warn" : ""));
    return '<div class="' + cls + '" data-id="' + attr(p.id) + '">'
      + '<div class="uq-card-hd">'
      + '<span class="' + ledCls(p, alertPercent) + '"></span>'
      + '<span class="uq-name" title="' + attr(p.name) + '">' + esc(p.name) + '</span>'
      + (p.stale ? '<span class="uq-state warn" title="上游这次没查成功，显示的是上一次的好数据">旧数据</span>' : "")
      + '<span class="uq-state ' + st.cls + '">' + st.text + '</span>'
      + '<button type="button" class="uq-icon" title="只刷新这个平台" onclick="UQ.refreshOne(\'' + attr(p.id) + '\')">↻</button>'
      + (p.note ? '<span class="uq-icon" title="' + attr(p.note) + '" style="cursor:help">ⓘ</span>' : "")
      + '</div>'
      // 查询失败时不要再说「没有可识别的额度字段」—— 下一行的错误原文才是原因。
      + (body || (p.error ? "" : '<div class="uq-q-sub" style="margin-top:8px">上游没有返回可识别的额度字段</div>'))
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
    const groups = (snap.groups && snap.groups.length) ? snap.groups : GROUP_ORDER.filter((g) => providers.some((p) => p.group === g));
    let html = kpiHTML(providers, snap);
    for (const g of groups) {
      const list = providers.filter((p) => p.group === g);
      if (!list.length) continue;
      const rank = (p) => {
        const k = providerState(p, alertPercent).key;
        return k === "alert" ? 0 : k === "failed" ? 1 : k === "ok" ? 2 : k === "unset" ? 3 : k === "off" ? 4 : 5;
      };
      const withData = list.filter((p) => rank(p) <= 2).sort((a, b) => rank(a) - rank(b));
      const rest = list.filter((p) => rank(p) > 2).sort((a, b) => rank(a) - rank(b));
      html += '<div class="uq-sec"><div class="uq-sec-hd">' + esc(g) + '<em>' + esc(GROUP_HINT[g] || "") + '</em><em style="margin-left:auto">' + list.length + ' 个</em></div>';
      if (withData.length) html += '<div class="uq-grid">' + withData.map((p) => cardHTML(p, alertPercent)).join("") + '</div>';
      if (rest.length) {
        html += '<div class="uq-rows">' + rest.map((p) => {
          const k = providerState(p, alertPercent).key;
          return rowItem(p, k === "manual" ? "manual" : k === "off" ? "off" : "unset");
        }).join("") + '</div>';
      }
      html += '</div>';
    }
    return html;
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
  // 内容变了才重排 DOM；重排时把滚动位置按原样放回去（否则每次后台刷新都跳回顶部）。
  function renderInto(body, html) {
    const sc = scrollParentOf(body);
    const top = sc ? sc.scrollTop : 0;
    body.innerHTML = html;
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

  function cfgCardHTML(def, pc) {
    const manual = !!def.manualOnly;
    const credential = def.credential || "apiKey";
    const keySource = pc.keySource || "auto";
    const extra = pc.extra || {};
    const live = (lastSnap && (lastSnap.providers || []).find((p) => p.id === def.id)) || null;

    let body = "";
    if (manual) {
      body = '<div class="uq-p-foot">'
        + (def.consoleUrl ? '<a class="btn btn-outline btn-sm" href="' + attr(def.consoleUrl) + '" target="_blank" rel="noopener">打开控制台</a>' : "")
        + (def.docsUrl ? '<a class="btn btn-outline btn-sm" href="' + attr(def.docsUrl) + '" target="_blank" rel="noopener">文档</a>' : "")
        + '</div>'
        + (def.note ? '<p class="uq-p-note">' + esc(def.note) + '</p>' : "");
    } else {
      const site = !!def.siteFromProfile;
      const token = !!def.tokenCredential;
      // 「方案」下拉：站点型平台（Sub2API / NewAPI / 自定义）用它带出站点地址与成员 Key。
      // 管理面令牌型（NewAPI 的系统访问令牌）没有 keySource 下拉，所以这一格不挂 data-when。
      const profileField = (when) => '<div' + (when
        ? ' data-when="profile"' + (keySource === "profile" ? "" : ' style="display:none"') : "") + '>'
        + '<label>方案' + (site ? '<span style="color:var(--dim2)">（带出站点地址）</span>' : "") + '</label>'
        + '<select data-f="profileSuffix" onchange="UQ.syncRow(this)">' + profileOptions(pc.profileSuffix || "") + '</select></div>';
      let cred;
      if (credential === "accessKey") {
        // 云平台凭据就是 AK/SK，没有「从方案里自动取」这条路，所以不给 keySource 下拉。
        cred = fieldsOf(def).map((f) => inputHTML(f, extra)).join("");
      } else if (token) {
        // 管理面令牌（NewAPI 的系统访问令牌）不是 sk- 中继 Key，方案只用来带出站点地址。
        cred = (site ? profileField(false) : "")
          + '<div><label>系统访问令牌</label><input type="text" data-f="apiKey" autocomplete="off" value="' + attr(pc.apiKey || "") + '" placeholder="控制台「个人设置 → 生成系统访问令牌」"></div>'
          + fieldsOf(def).map((f) => inputHTML(f, extra)).join("");
      } else {
        cred = '<div><label>凭据来源</label><select data-f="keySource" onchange="UQ.syncRow(this)">' + keySourceOptions(keySource) + '</select></div>'
          + profileField(true)
          + '<div data-when="profile"' + (keySource === "profile" ? "" : ' style="display:none"') + '><label>成员</label>'
          + '<select data-f="memberKey">' + memberOptions(pc.profileSuffix || "", pc.memberKey || "") + '</select></div>'
          + '<div data-when="inline"' + (keySource === "inline" ? "" : ' style="display:none"') + '><label>API Key</label>'
          + '<input type="text" data-f="apiKey" autocomplete="off" value="' + attr(pc.apiKey || "") + '" placeholder="sk-…"></div>';
      }
      body = '<div class="uq-cfg-grid">' + cred + '</div>'
        + '<details class="uq-adv"><summary>高级：接入点覆盖 / 显示名</summary>'
        + '<div class="uq-cfg-grid">'
        + '<div><label>接入点覆盖<span style="color:var(--dim2)">（留空=官方地址/方案地址）</span></label><input type="text" data-f="baseUrl" autocomplete="off" value="' + attr(pc.baseUrl || "") + '" placeholder="仅换域名，例如 https://api.z.ai"></div>'
        + '<div><label>显示名<span style="color:var(--dim2)">（留空=平台名）</span></label><input type="text" data-f="label" autocomplete="off" value="' + attr(pc.label || "") + '"></div>'
        + '</div></details>'
        + (def.localKey ? '<p class="uq-p-note">没填 Key 时会自动读本机 <b>' + esc(def.localKey.label || "登录凭据") + '</b>（只读；读不到才算未配置）。</p>' : "")
        + (def.note ? '<p class="uq-p-note">官方口径：' + esc(def.note) + '</p>' : "")
        + '<div class="uq-p-foot"><button type="button" class="btn btn-outline btn-sm" onclick="UQ.testProvider(\'' + attr(def.id) + '\',this)">查询一次</button>'
        + '<span class="uq-probe" data-probe>' + (live && live.credLabel ? '<span style="color:var(--dim2)">凭据：' + esc(live.credLabel) + '</span>' : "") + '</span></div>';
    }

    // data-ksdef：这张卡没有「凭据来源」下拉时，collect() 用它当默认来源
    // （NewAPI 是手动令牌 = inline；Sub2API 走方案 = profile）。
    const ksDef = def.defaultKeySource || (credential === "none" ? "inline" : "auto");
    return '<details class="uq-cfg uq-p" data-id="' + attr(def.id) + '" data-credential="' + attr(credential) + '" data-ksdef="' + attr(ksDef) + '">'
      + '<summary>'
      + (manual ? "" : '<input type="checkbox" class="uq-en" data-f="enabled"' + (pc.enabled === false ? "" : " checked") + ' onclick="event.stopPropagation()" title="启用 / 停用这个平台">')
      + (manual ? '<span class="led"></span>' : '<span class="led' + (live && live.ok && live.enabled !== false ? " on" : "") + '"></span>')
      + '<span class="uq-p-name">' + esc(def.name) + '</span>'
      + (def.experimental ? '<span class="uq-p-tag exp" title="接口未文档化，上游随时可能改">实验</span>' : "")
      + liveHTML(def.id)
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

  function settingsFormHTML(cfg, catalog) {
    const known = new Set(catalog.map((d) => d.id));
    let html = globalsHTML(cfg);
    html += '<p class="uq-lead">点平台行展开改凭据，<b>「查询一次」当场验证</b>；凭据默认<b>自动</b>＝复用方案里已有的成员密钥。数字来自上游官方接口，与本地配额是两套口径。</p>';
    for (const group of GROUP_ORDER) {
      const list = catalog.filter((d) => d.group === group);
      if (!list.length) continue;
      html += '<div class="uq-sec"><div class="uq-sec-hd">' + esc(group) + '<em>' + esc(GROUP_HINT[group] || "") + '</em><em style="margin-left:auto">' + list.length + ' 个</em></div>';
      html += list.map((def) => cfgCardHTML(def, cfg.providers[def.id] || {})).join("");
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
  function collect() {
    const providers = Object.assign({}, CARRY);
    document.querySelectorAll("#uqCfgBody .uq-cfg[data-id]").forEach((card) => {
      const id = card.getAttribute("data-id");
      const pick = (f) => card.querySelector('[data-f="' + f + '"]');
      const val = (f) => { const el = pick(f); return el ? String(el.value == null ? "" : el.value) : ""; };
      const extra = {};
      card.querySelectorAll("[data-extra]").forEach((el) => { extra[el.getAttribute("data-extra")] = el.value; });
      const en = pick("enabled");
      const credential = card.getAttribute("data-credential") || "apiKey";
      providers[id] = {
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
    });
    const g = (k, dflt) => { const el = document.querySelector('#uqCfgBody [data-g="' + k + '"]'); return el ? el.value : dflt; };
    return {
      enabled: g("enabled", "1") === "1",
      cacheSeconds: Number(g("cacheSeconds", 300)),
      autoRefreshMinutes: Number(g("autoRefreshMinutes", 0)),
      timeoutMs: Number(g("timeoutMs", 10000)),
      alertPercent: Number(g("alertPercent", 90)),
      providers: providers,
    };
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
      if (probe) probe.innerHTML = '<span class="uq-p-state alarm">查询失败</span> ' + esc(err.message);
      setStatus("查询失败：" + clip(err.message, 60), "err");
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
      return label + ' <b>' + (pct === null ? esc(fmtValue(it.used, it.unit)) : (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + "%") + '</b>';
    }).join('<span style="color:var(--dim2)"> · </span>');
    return '<span class="uq-p-state ok">读到 ' + items.length + ' 项</span> <span class="uq-probe">' + (nums || "上游返回成功，但没有可识别的额度字段")
      + (p.credLabel ? '<span style="color:var(--dim2)"> · 凭据：' + esc(p.credLabel) + '</span>' : "") + '</span>';
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
    syncRow: syncRow,
    collect: collect,
  };

  ensureStyle();
})();
