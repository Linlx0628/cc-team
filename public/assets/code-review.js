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
    + `<select id="crRunRepo" onchange="crOnRepoChange()">${repoOpts || '<option value="">(尚未配置仓库)</option>'}</select></div>`
    + '<div class="cr-field cr-field-branch"><label for="crRunBranch">分支 <span class="cr-hint-inline">(按次,不改仓库配置)</span></label>'
    + `<select id="crRunBranch" disabled><option value="">（选仓库后加载）</option></select></div>`
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
    const files = crParseFiles(r.files_json);
    // 被评文件:列表里给前几个名字(比冷冰冰一个「文件 1」有用得多),更多用 +N 收口
    const fileHint = files.length
      ? `<div class="cr-run-files">${files.slice(0, 3).map((f) => `<span class="cr-file-chip" title="${escH(f)}">${escH(crBase(f))}</span>`).join("")}${files.length > 3 ? `<span class="cr-file-more">+${files.length - 3}</span>` : ""}</div>`
      : "";
    return `<div class="cr-run is-${cls}"><span class="cr-run-num">#${r.id}</span>`
      + '<div class="cr-run-main"><div class="cr-run-title">'
      + `<span class="cr-run-repo">${escH(r.repo_name)}</span>`
      + `<span class="pill pill-${cls}">${escH(CR_STATUS_LABEL[r.status] || r.status)}</span>` + trig + '</div>'
      + '<div class="cr-run-meta">' + escH(new Date(r.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }))
      + " · " + escH(r.range_mode === "single" ? "单提交 " + crShort(r.to_commit) : `${crShort(r.from_commit)}→${crShort(r.to_commit)}`)
      + ` · 文件 ${r.files_reviewed} · 意见 ${r.comments_count} · ${fmtT(r.input_tokens + r.output_tokens)} token · ${crDur(r.elapsed_ms)}`
      + '</div>'
      // 一句话结论(note):「已跳过」到底是没新提交还是别的原因,靠它说清楚
      + (r.note ? `<div class="cr-run-note">${escH(r.note)}</div>` : "")
      + (r.error ? `<div class="cr-run-note is-err">${escH(String(r.error).slice(0, 200))}</div>` : "")
      + fileHint
      + '</div>'
      + '<div class="cr-run-actions">'
      + `<button type="button" class="btn btn-outline btn-sm" onclick="openReviewRun(${r.id})">详情</button>`
      + (active ? `<button type="button" class="btn btn-outline btn-sm" onclick="cancelReviewRun(${r.id})">取消</button>` : "")
      + '</div></div>';
  }).join("") + "</div>";
  html += '<div id="crRunDetail"></div></div>';
  body.innerHTML = html;
  // 渲染完就把当前选中仓库的分支列表拉出来(默认分支会被自动选中)
  crLoadBranches();
}

// files_json / tool_calls_json 是 TEXT 列,解析失败一律当无数据(别让一条脏 JSON 把整页打挂)
function crParseFiles(json) { try { const a = JSON.parse(json || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } }
function crParseTools(json) { try { const o = JSON.parse(json || "null"); return o && typeof o === "object" ? o : null; } catch { return null; } }
function crBase(p) { const s = String(p); const i = s.lastIndexOf("/"); return i >= 0 ? s.slice(i + 1) : s; }
// 「事实表」:一行一个 标签/值,把「这次到底干了什么」摊开
function crFact(label, valueHtml) { return `<div class="cr-fact"><span class="cr-fact-k">${escH(label)}</span><span class="cr-fact-v">${valueHtml}</span></div>`; }
// 工具调用「说人话」:code_search→检索、file_read→读文件,其余原样
const CR_TOOL_ZH = { code_search: "代码检索", file_read: "读文件", file_write: "写文件", shell: "执行命令", grep: "检索", glob: "匹配文件" };
function crToolText(t) {
  const parts = Object.entries(t.byTool || {}).map(([k, v]) => `${CR_TOOL_ZH[k] || k} ${v}`);
  if (!parts.length) return t.total ? `共 ${t.total} 次` : "—";
  return `共 ${t.total} 次（${parts.join(" · ")}）` + (t.failure ? ` · 失败 ${t.failure}` : "");
}

async function openReviewRun(id) {
  const box = document.getElementById("crRunDetail");
  box.innerHTML = '<div class="lb-msg">加载中…</div>';
  try {
    const d = await crApi("/api/code-review/run?id=" + encodeURIComponent(id));
    const run = d.run, comments = d.comments || [];
    const files = crParseFiles(run.files_json);
    const tools = crParseTools(run.tool_calls_json);
    let html = '<div class="cr-detail"><div class="cr-detail-head">'
      + `<strong>运行 #${run.id} · ${escH(run.repo_name)}</strong>`
      + `<span class="pill pill-${crStatusClass(run.status)}">${escH(CR_STATUS_LABEL[run.status] || run.status)}</span>`
      + `<a class="btn btn-outline btn-sm" style="margin-left:auto" href="/api/code-review/report?id=${run.id}">导出报告</a></div>`;
    // 结论 + 引擎实际干了多少活:这条是回答「有没有真干活」的关键
    html += '<div class="cr-facts">'
      + crFact("结论", run.note || "—")
      + crFact("评审范围", (run.range_mode === "single" ? "单提交 " : "增量 ") + escH(crShort(run.from_commit) || "—") + " → " + escH(crShort(run.to_commit) || "—"))
      + (run.author_name || run.author_email ? crFact("提交人", escH(run.author_name || "—") + (run.author_email ? ` &lt;${escH(run.author_email)}&gt;` : "")) : "")
      + crFact("模型", escH(run.ocr_model || "—") + (run.ocr_provider ? `（${escH(run.ocr_provider)}）` : ""))
      + (tools ? crFact("引擎动作", escH(crToolText(tools))) : "")
      + crFact("token", `网关计 ${fmtT(run.attributed_input + run.attributed_output)} · 引擎自报 ${fmtT(run.input_tokens + run.output_tokens)}（${fmtT(run.input_tokens)} 入 / ${fmtT(run.output_tokens)} 出）`)
      + crFact("耗时", crDur(run.elapsed_ms))
      + '</div>';
    if (run.error) html += `<div class="cr-notice is-error" style="margin:0 0 12px">${escH(run.error)}</div>`;
    // 被评文件清单:即使 0 意见也把评过的文件列出来 —— 证明它确实读了这些文件
    html += '<div class="cr-files-block"><div class="cr-files-title">'
      + (files.length ? `本次评审选取的 ${files.length} 个文件` : "本次没有选取任何文件")
      + '</div>'
      + (files.length ? '<div class="cr-files-list">' + files.map((f) => `<div class="cr-files-item" title="${escH(f)}">${escH(f)}</div>`).join("") + '</div>'
        : '<div class="cr-empty-d" style="text-align:left;margin:0">范围里没有可评审的改动。若是「已跳过」,通常表示自上次评审以来没有新提交。</div>')
      + '</div>';
    if (!comments.length) {
      html += '<div class="cr-empty" style="padding:22px"><div class="cr-empty-ico">✓</div><div class="cr-empty-t">无意见</div><div class="cr-empty-d">本次范围(上面列出的文件)未发现需要修改的问题。</div></div></div>';
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

// 拉某个仓库的分支列表填进下拉。默认分支(仓库配置里的)放首位并自动选中。
async function crLoadBranches() {
  const sel = document.getElementById("crRunBranch");
  const repoId = document.getElementById("crRunRepo")?.value;
  if (!sel) return;
  if (!repoId) { sel.innerHTML = '<option value="">（选仓库后加载）</option>'; sel.disabled = true; return; }
  const def = ((crData && crData.repoList) || []).find((r) => r.id === repoId)?.branch || "";
  sel.disabled = true;
  sel.innerHTML = '<option value="">加载中…</option>';
  try {
    const r = await crApi("/api/code-review/repos/branches", { method: "POST", headers: crCsrfHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ id: repoId }) });
    if (!r.ok || !(r.branches || []).length) {
      // 拿不到分支(私有仓库凭据不通/网络失败)时给「默认分支」一个兜底,别把触发卡死
      sel.innerHTML = `<option value="${escH(def)}">${escH(def || "（默认）")}（未取到分支列表）</option>`;
      sel.disabled = false;
      crSetStatus("取分支失败:" + (r.detail || "未知原因"), "error");
      return;
    }
    sel.innerHTML = r.branches.map((b) => `<option value="${escH(b)}">${escH(b)}</option>`).join("");
    if (def && r.branches.includes(def)) sel.value = def;
    sel.disabled = false;
  } catch (err) {
    sel.innerHTML = `<option value="${escH(def)}">${escH(def || "（默认）")}</option>`;
    sel.disabled = false;
    crSetStatus("取分支失败:" + (err.message || ""), "error");
  }
}
function crOnRepoChange() {
  crSetStatus("");
  crLoadBranches();
}

async function startReviewRun() {
  const repo = document.getElementById("crRunRepo")?.value;
  if (!repo) { crSetStatus("请先在设置页添加仓库", "error"); return; }
  // 面板上选的分支只对本次生效(服务端不会写回仓库配置)
  const branch = document.getElementById("crRunBranch")?.value || "";
  crSetStatus("已提交,排队中…");
  try {
    const r = await crApi("/api/code-review/runs/start", { method: "POST", headers: crCsrfHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ repo, branch }) });
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
