// public/assets/code-review.js —— 管理面板「代码评审」工作区。
//
// 懒加载:首次点开该 tab 才拉数据(与 costs / sessions 同款)。所有来自评审结果的
// 文本都是**任意仓库的内容**,必须经 escH() 转义后再拼进 HTML —— 恶意仓库可以在
// 代码里写 <img onerror>。这是本文件唯一的安全红线。
let crLoaded = false, crData = null, crRuns = [], crOpenRun = null;

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
  return "bad";
}
const CR_STATUS_LABEL = {
  queued: "排队中", syncing: "同步代码", running: "评审中", parsing: "解析结果",
  success: "完成", completed_with_warnings: "完成(有警告)", completed_with_errors: "完成(有错误)",
  skipped: "已跳过", failed: "失败", timeout: "超时", canceled: "已取消",
};
function crShort(sha) { return sha ? String(sha).slice(0, 8) : ""; }
function crDur(ms) { if (!ms) return "-"; const s = Math.round(ms / 1000); return s < 60 ? s + "s" : Math.floor(s / 60) + "m" + (s % 60) + "s"; }

async function loadCodeReview() {
  const body = document.getElementById("crPanelBody");
  const note = document.getElementById("crPanelNote");
  const line = document.getElementById("crStatusLine");
  try {
    const st = await crApi("/api/code-review/status");
    crData = st;
    const ocr = st.ocr || {};
    line.textContent = `仓库 ${st.repos} 个 · 队列 ${st.queue} · 运行中 ${st.running}`;
    if (!st.enabled) {
      note.innerHTML = '代码评审未启用 —— 到 <a href="/settings">设置页</a> 打开并配置仓库与评审专用 Key。';
      body.innerHTML = "";
      return;
    }
    if (!ocr.installed || !ocr.gitOk) {
      note.innerHTML = escH(`未检测到可用的评审引擎:${!ocr.installed ? "ocr 未安装" : ""}${!ocr.gitOk ? " git 版本过低(需 ≥2.41)" : ""}。`
        + '安装命令:npm i -g @alibaba-group/open-code-review(网关不会自动安装)');
      body.innerHTML = "";
      return;
    }
    note.innerHTML = escH(`${ocr.version} · ${ocr.git} · 工作区 ${(st.workspaceBytes / 1048576).toFixed(1)}MB`);
    const runs = await crApi("/api/code-review/runs?limit=50");
    crRuns = runs.rows || [];
    renderCodeReview();
  } catch (err) {
    note.textContent = "";
    body.innerHTML = '<div class="lb-msg">加载失败：' + escH(err.message) + "</div>";
  }
}

function renderCodeReview() {
  const body = document.getElementById("crPanelBody");
  const repos = (crData && crData.repos) ? crData.repos : [];
  const repoOpts = repos.map((r) => `<option value="${escH(r.id)}">${escH(r.name)}</option>`).join("");
  let html = '<div class="lb-ctl" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
    + `<select id="crRunRepo" style="min-width:180px">${repoOpts || '<option value="">（未配置仓库）</option>'}</select>`
    + '<button type="button" class="btn btn-primary btn-sm" onclick="startReviewRun()">开始评审</button>'
    + '<span class="note" style="margin:0">首个提交只评最新 commit;之后按上次评审到的提交增量评审</span></div>'
    + '<div class="inline-status" id="crRunStatus" role="status"></div>';
  if (!crRuns.length) {
    html += '<div class="lb-msg">还没有评审记录</div>';
    body.innerHTML = html;
    return;
  }
  html += '<div class="lb-list">' + crRuns.map((r) => {
    const active = ["queued", "syncing", "running", "parsing"].includes(r.status);
    return `<div class="lb-row"><span class="lb-rank">#${r.id}</span>`
      + '<div class="lb-who"><div class="lb-name">' + escH(r.repo_name)
      + ` <span class="pill pill-${crStatusClass(r.status)}">${escH(CR_STATUS_LABEL[r.status] || r.status)}</span>`
      + (r.trigger !== "manual" ? ` <span class="note">${escH(r.trigger)}</span>` : "") + "</div>"
      + '<div class="lb-det">' + escH(new Date(r.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }))
      + " · " + escH(r.range_mode === "single" ? "单提交 " + crShort(r.to_commit) : `${crShort(r.from_commit)}→${crShort(r.to_commit)}`)
      + ` · 文件 ${r.files_reviewed} · 意见 ${r.comments_count} · ${fmtT(r.input_tokens + r.output_tokens)} token · ${crDur(r.elapsed_ms)}`
      + (r.error ? ` · <span style="color:var(--red)">${escH(String(r.error).slice(0, 120))}</span>` : "")
      + "</div></div>"
      + '<div style="display:flex;gap:6px;flex-shrink:0">'
      + `<button type="button" class="btn btn-outline btn-sm" onclick="openReviewRun(${r.id})">详情</button>`
      + (active ? `<button type="button" class="btn btn-outline btn-sm" onclick="cancelReviewRun(${r.id})">取消</button>` : "")
      + "</div></div>";
  }).join("") + "</div>";
  html += '<div id="crRunDetail"></div>';
  body.innerHTML = html;
}

async function openReviewRun(id) {
  const box = document.getElementById("crRunDetail");
  box.innerHTML = '<div class="lb-msg">加载中…</div>';
  try {
    const d = await crApi("/api/code-review/run?id=" + encodeURIComponent(id));
    const run = d.run, comments = d.comments || [];
    let html = '<div class="workspace-panel-head" style="border-top:1px solid var(--border)">'
      + `<strong>运行 #${run.id} · ${escH(run.repo_name)}</strong>`
      + `<span class="workspace-panel-summary">归因: 评审 Key 计 ${run.attributed_requests} 次请求 / ${fmtT(run.attributed_input + run.attributed_output)} token`
      + `（OCR 上报 ${fmtT(run.input_tokens + run.output_tokens)}）</span>`
      // 独立 HTML 报告:自包含单文件,下载后可直接发群(与「导出报告」同款)
      + `<a class="btn btn-outline btn-sm" style="margin-left:8px" href="/api/code-review/report?id=${run.id}">导出报告</a></div>`;
    if (!comments.length) {
      html += '<div class="lb-msg" style="color:var(--green)">无意见</div>';
      box.innerHTML = html;
      return;
    }
    const groups = {};
    for (const c of comments) (groups[c.path] = groups[c.path] || []).push(c);
    html += Object.entries(groups).map(([p, list]) => {
      return `<div class="lb-cohort">${escH(p)} · ${list.length} 条</div>` + list.map((c) => {
        const lines = c.start_line ? `:${c.start_line}${c.end_line && c.end_line !== c.start_line ? "-" + c.end_line : ""}` : "";
        return '<div class="lb-row" style="display:block"><div class="lb-name">' + escH(p) + escH(lines) + "</div>"
          + '<div style="font-size:12px;margin:4px 0;white-space:pre-wrap">' + escH(c.content || "") + "</div>"
          + (c.existing_code ? `<details><summary class="note">原代码</summary><pre style="white-space:pre-wrap;background:var(--surface-subtle);padding:6px;border-radius:4px;font-size:11px">${escH(c.existing_code)}</pre></details>` : "")
          + (c.suggestion_code ? `<details open><summary class="note">建议改法</summary><pre style="white-space:pre-wrap;background:var(--surface-subtle);padding:6px;border-radius:4px;font-size:11px">${escH(c.suggestion_code)}</pre></details>` : "")
          + (c.thinking ? `<details><summary class="note">推理</summary><div class="note" style="white-space:pre-wrap">${escH(c.thinking)}</div></details>` : "")
          + "</div>";
      }).join("");
    }).join("");
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
    const r = await crApi("/api/code-review/runs/start", { method: "POST", headers: csrfHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ repo }) });
    crSetStatus(r.deduped ? "该仓库已有进行中的评审,已合并" : `已入队 #${r.runId}`, "ok");
    setTimeout(loadCodeReview, 1500);
  } catch (err) { crSetStatus(err.message, "error"); }
}
async function cancelReviewRun(id) {
  try {
    const r = await crApi("/api/code-review/runs/cancel", { method: "POST", headers: csrfHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ id }) });
    crSetStatus(r.canceled ? "已取消" : (r.note || "未取消"), r.canceled ? "ok" : "error");
    setTimeout(loadCodeReview, 800);
  } catch (err) { crSetStatus(err.message, "error"); }
}
document.getElementById("workspace-tab-review")?.addEventListener("click", () => {
  if (!crLoaded) { crLoaded = true; loadCodeReview(); }
});
