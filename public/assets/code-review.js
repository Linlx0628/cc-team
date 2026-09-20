// public/assets/code-review.js —— 管理面板「代码评审」工作区。
//
// 懒加载:首次点开该 tab 才拉数据(与 costs / sessions 同款)。所有来自评审结果的
// 文本都是**任意仓库的内容**,必须经 escH() 转义后再拼进 HTML —— 恶意仓库可以在
// 代码里写 <img onerror>。这是本文件唯一的安全红线。
//
// 本文件只在 dashboard 上运行(与 dashboard.js 同页),**不加载 settings.js** —— 所以
// csrfHeaders/getCsrf 在这里不存在,得自己读 tm_csrf cookie(与 dashboard.js 的写法一致)。
let crLoaded = false, crData = null, crRuns = [], crOpenRun = null;

function crCsrfHeaders(h) {
  h = h || {};
  const m = document.cookie.match(/(?:^|;\s*)tm_csrf=([^;]+)/);
  h["x-csrf-token"] = m ? decodeURIComponent(m[1]) : "";
  return h;
}


function crApi(path, opts) {
  return fetch(path, opts).then(async (r) => {
    const text = await r.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
    if (!r.ok) throw new Error((body && body.error) || ("HTTP " + r.status));
    return body;
  });
}
function crStatusClass(s) {
  if (s === "success") return "ok";
  if (s === "completed_with_warnings" || s === "completed_with_errors") return "warn";
  if (s === "skipped") return "dim";
  if (["queued", "syncing", "running", "parsing"].includes(s)) return "run";   // 进行中:用强调色,别跟失败混
  return "bad";
}
const CR_STATUS_LABEL = {
  queued: "排队中", syncing: "同步代码", running: "评审中", parsing: "解析结果",
  success: "完成", completed_with_warnings: "完成(有警告)", completed_with_errors: "完成(有错误)",
  skipped: "已跳过", failed: "失败", timeout: "超时", canceled: "已取消",
};
function crShort(sha) { return sha ? String(sha).slice(0, 8) : ""; }
function crDur(ms) { if (!ms) return "-"; const s = Math.round(ms / 1000); return s < 60 ? s + "s" : Math.floor(s / 60) + "m" + (s % 60) + "s"; }

function fmtMB(bytes) { return (bytes / 1048576).toFixed(1) + "MB"; }

async function loadCodeReview() {
  const body = document.getElementById("crPanelBody");
  const line = document.getElementById("crStatusLine");
  try {
    const st = await crApi("/api/code-review/status");
    crData = st;
    const ocr = st.ocr || {};
    line.textContent = `仓库 ${st.repos} · 队列 ${st.queue} · 运行中 ${st.running}`;
    // 关闭/缺引擎:给一个居中的引导卡,不再把长句糊在裸 div 里
    if (!st.enabled) {
      body.innerHTML = '<div class="cr-notice">代码评审<b>未启用</b> —— 到 <a href="/settings">设置页</a> 打开开关、选评审方案并添加仓库。</div>';
      return;
    }
    if (!ocr.installed || !ocr.gitOk) {
      body.innerHTML = '<div class="cr-notice is-error">未检测到可用的评审引擎:' + escH(`${!ocr.installed ? " ocr 未安装" : ""}${!ocr.gitOk ? " git 版本过低(需 ≥2.41)" : ""}`) + '<br><br>安装:<code>npm i -g @alibaba-group/open-code-review</code>(网关不会自动安装)</div>';
      return;
    }
    // 引擎状态条:绿色指示灯 + 版本/工作区,替代原来挤在一行的长字符串
    const runs = await crApi("/api/code-review/runs?limit=50");
    crRuns = runs.rows || [];
    renderCodeReview(ocr);
  } catch (err) {
    body.innerHTML = '<div class="cr-notice is-error">加载失败:' + escH(err.message) + '</div>';
  }
}

// 引擎信息条 + 触发卡片 + 运行列表的骨架
function crEngineStrip(ocr, st) {
  return '<div class="cr-scroll"><div class="cr-engine">'
    + '<span class="led on"></span><b>' + escH(ocr.version || "ocr") + '</b>'
    + '<span class="cr-engine-sep">·</span><span>' + escH(ocr.git || "git") + '</span>'
    + '<span class="cr-engine-sep">·</span><span>工作区 <b>' + fmtMB(st.workspaceBytes || 0) + '</b></span>'
    + '</div>';
}

function renderCodeReview(ocr) {
  const body = document.getElementById("crPanelBody");
  ocr = ocr || (crData && crData.ocr) || {};
  const st = crData || {};
  const repos = Array.isArray(crData.repoList) ? crData.repoList : [];
  const repoOpts = repos.map((r) => `<option value="${escH(r.id)}">${escH(r.name)}${r.enabled === false ? "(停用)" : ""}</option>`).join("");
  let html = crEngineStrip(ocr, st)
    + '<div class="cr-toolbar"><div class="cr-toolbar-main">'
    + '<div class="cr-field"><label for="crRunRepo">评审仓库</label>'
    + `<select id="crRunRepo">${repoOpts || '<option value="">(尚未配置仓库)</option>'}</select></div>`
    + '<button type="button" class="btn btn-primary cr-go" id="crGoBtn" onclick="startReviewRun()"><span class="cr-go-ico">▸</span>开始评审</button>'
    + '</div>'
    + '<div class="cr-toolbar-hint">首次只评最新一个 <code>commit</code>;之后按「上次评到 → 现在 HEAD」的<b>增量</b>评审,不会整个仓库重跑。评审的是<b>已推送</b>的提交。</div>'
    + '<div class="inline-status cr-run-status" id="crRunStatus" role="status"></div>'
    + '</div>';

  if (!repos.length) {
    html += '<div class="cr-empty"><div class="cr-empty-ico">◇</div><div class="cr-empty-t">还没有配置仓库</div>'
      + '<div class="cr-empty-d">到 <a href="/settings" style="color:var(--accent);font-weight:600">设置页 · 代码评审</a> 添加仓库白名单,「测试连接」通过后再回来触发。</div></div></div>';
    body.innerHTML = html;
    return;
  }
  if (!crRuns.length) {
    html += '<div class="cr-empty"><div class="cr-empty-ico">◇</div><div class="cr-empty-t">还没有评审记录</div>'
      + '<div class="cr-empty-d">选好上面的仓库,点「开始评审」——第一次会先把代码同步到本地工作区。</div></div></div>';
    body.innerHTML = html;
    return;
  }
  html += '<div class="cr-runs">' + crRuns.map((r) => {
    const cls = crStatusClass(r.status);
    const active = ["queued", "syncing", "running", "parsing"].includes(r.status);
    const trig = r.trigger && r.trigger !== "manual" ? `<span class="cr-run-trig">${escH(r.trigger)}</span>` : "";
    return `<div class="cr-run is-${cls}"><span class="cr-run-num">#${r.id}</span>`
      + '<div class="cr-run-main"><div class="cr-run-title">'
      + `<span class="cr-run-repo">${escH(r.repo_name)}</span>`
      + `<span class="pill pill-${cls}">${escH(CR_STATUS_LABEL[r.status] || r.status)}</span>` + trig + '</div>'
      + '<div class="cr-run-meta">' + escH(new Date(r.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }))
      + " · " + escH(r.range_mode === "single" ? "单提交 " + crShort(r.to_commit) : `${crShort(r.from_commit)}→${crShort(r.to_commit)}`)
      + ` · 文件 ${r.files_reviewed} · 意见 ${r.comments_count} · ${fmtT(r.input_tokens + r.output_tokens)} token · ${crDur(r.elapsed_ms)}`
      + (r.error ? ` · <span class="cr-err">${escH(String(r.error).slice(0, 120))}</span>` : "")
      + '</div></div>'
      + '<div class="cr-run-actions">'
      + `<button type="button" class="btn btn-outline btn-sm" onclick="openReviewRun(${r.id})">详情</button>`
      + (active ? `<button type="button" class="btn btn-outline btn-sm" onclick="cancelReviewRun(${r.id})">取消</button>` : "")
      + '</div></div>';
  }).join("") + "</div>";
  html += '<div id="crRunDetail"></div></div>';
  body.innerHTML = html;
}

async function openReviewRun(id) {
  const box = document.getElementById("crRunDetail");
  box.innerHTML = '<div class="lb-msg">加载中…</div>';
  try {
    const d = await crApi("/api/code-review/run?id=" + encodeURIComponent(id));
    const run = d.run, comments = d.comments || [];
    let html = '<div class="cr-detail"><div class="cr-detail-head">'
      + `<strong>运行 #${run.id} · ${escH(run.repo_name)}</strong>`
      + `<span class="pill pill-${crStatusClass(run.status)}">${escH(CR_STATUS_LABEL[run.status] || run.status)}</span>`
      + `<span class="cr-detail-attr">评审 Key 计 ${run.attributed_requests} 次请求 / ${fmtT(run.attributed_input + run.attributed_output)} token（OCR 上报 ${fmtT(run.input_tokens + run.output_tokens)}）</span>`
      // 独立 HTML 报告:自包含单文件,下载后可直接发群(与「导出报告」同款)
      + `<a class="btn btn-outline btn-sm" style="margin-left:auto" href="/api/code-review/report?id=${run.id}">导出报告</a></div>`;
    if (!comments.length) {
      html += '<div class="cr-empty" style="padding:26px"><div class="cr-empty-ico">✓</div><div class="cr-empty-t">无意见</div><div class="cr-empty-d">本次增量没发现需要修改的问题。</div></div></div>';
      box.innerHTML = html;
      return;
    }
    const groups = {};
    for (const c of comments) (groups[c.path] = groups[c.path || "(未标注路径)"] || []).push(c);
    html += Object.entries(groups).map(([p, list]) => {
      return `<div class="cr-file">▸ ${escH(p)}<span style="color:var(--dim2)">· ${list.length} 条</span></div>` + list.map((c) => {
        const lines = c.start_line ? `:${c.start_line}${c.end_line && c.end_line !== c.start_line ? "–" + c.end_line : ""}` : "";
        return '<div class="cr-comment"><div class="cr-comment-loc">' + escH(p) + escH(lines) + '</div>'
          + '<div class="cr-comment-body">' + escH(c.content || "") + '</div>'
          + (c.existing_code ? `<details><summary>原代码</summary><pre>${escH(c.existing_code)}</pre></details>` : "")
          + (c.suggestion_code ? `<details open><summary>建议改法</summary><pre>${escH(c.suggestion_code)}</pre></details>` : "")
          + (c.thinking ? `<details><summary>推理</summary><div class="note" style="white-space:pre-wrap;margin-top:6px">${escH(c.thinking)}</div></details>` : "")
          + '</div>';
      }).join("");
    }).join("") + '</div>';
    box.innerHTML = html;
  } catch (err) {
    box.innerHTML = '<div class="lb-msg">加载失败：' + escH(err.message) + "</div>";
  }
}

function crSetStatus(text, cls) {
  const el = document.getElementById("crRunStatus");
  if (el) { el.textContent = text || ""; el.className = "inline-status " + (cls || ""); }
}
async function startReviewRun() {
  const repo = document.getElementById("crRunRepo")?.value;
  if (!repo) { crSetStatus("请先在设置页添加仓库", "error"); return; }
  crSetStatus("已提交,排队中…");
  try {
    const r = await crApi("/api/code-review/runs/start", { method: "POST", headers: crCsrfHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ repo }) });
    crSetStatus(r.deduped ? "该仓库已有进行中的评审,已合并" : `已入队 #${r.runId}`, "ok");
    setTimeout(loadCodeReview, 1500);
  } catch (err) { crSetStatus(err.message, "error"); }
}
async function cancelReviewRun(id) {
  try {
    const r = await crApi("/api/code-review/runs/cancel", { method: "POST", headers: crCsrfHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ id }) });
    crSetStatus(r.canceled ? "已取消" : (r.note || "未取消"), r.canceled ? "ok" : "error");
    setTimeout(loadCodeReview, 800);
  } catch (err) { crSetStatus(err.message, "error"); }
}
document.getElementById("workspace-tab-review")?.addEventListener("click", () => {
  if (!crLoaded) { crLoaded = true; loadCodeReview(); }
});
