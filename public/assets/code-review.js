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
  // 「部分完成」单独一档(深橙):它读起来像小毛病,实际是「选了 39 个只评了 10 个」,
  // 与「完成(有警告)」用同一个橙档会让它在列表里完全看不出来。
  if (s === "partial") return "degraded";
  if (s === "completed_with_warnings" || s === "completed_with_errors") return "warn";
  if (s === "skipped") return "dim";
  if (["queued", "syncing", "running", "parsing"].includes(s)) return "run";   // 进行中:用强调色,别跟失败混
  return "bad";
}
const CR_STATUS_LABEL = {
  queued: "排队中", syncing: "同步代码", running: "评审中", parsing: "解析结果",
  success: "完成", completed_with_warnings: "完成(有警告)", completed_with_errors: "完成(有错误)",
  partial: "部分完成",
  skipped: "已跳过", failed: "失败", timeout: "超时", canceled: "已取消",
};
function crShort(sha) { return sha ? String(sha).slice(0, 8) : ""; }
// 未评原因的机器词 → 人话。注意:认不出的分类**原样透出**,别吞:引擎将来加新分类,
// 界面上一眼看得见比「什么都没说」强。
const CR_CLASS_ZH = { budget: "超出单次 token 预算" };
function crCoverWhy(cov) {
  const by = cov && cov.byClass && typeof cov.byClass === "object" ? cov.byClass : {};
  const es = Object.entries(by).filter(([, n]) => Number(n) > 0);
  return es.length ? es.map(([k, n]) => `${n} 个${CR_CLASS_ZH[k] || k}`).join(" / ") : "";
}
// 撞预算后网关自动续评的停止原因(与服务端 RESUME_STOP_ZH 同一套说法,别各写各的)
const CR_RESUME_STOP_ZH = {
  cap: "已达续评轮数上限", dailybudget: "当日 token 预算已用尽", noprogress: "续评没有带来新增进展",
  nosession: "引擎未提供会话标识", unreadable: "续评输出不可用,已保留上一轮结果", regressed: "续评结果反而更少,已保留上一轮结果",
};
// 「部分完成」时最该回答的问题:网关到底有没有自己补?补了几轮?为什么停?
// 注意:老记录没有这份轨迹(run.autoResume 为 null)时**整行不显示**,不编造「没续评」。
function crResumeText(ar) {
  const plan = Number(ar.configured) || 0;
  if (plan <= 0) return "已关闭（轮数 0），未评项不会自动补";
  const rounds = Number(ar.rounds) || 0;
  if (!rounds) return `未触发（已配置上限 ${plan} 轮）`;
  const why = ar.stopped ? (CR_RESUME_STOP_ZH[ar.stopped] || String(ar.stopped)) : "";
  return `已续评 ${rounds} 轮（复用 ${Number(ar.reused) || 0} 项已评结果）${why ? `，${why}` : ""}`;
}
// 覆盖率:新记录由服务端落库后透出(run.coverage),老记录由详情接口按需读原始报告补上。
// 拿不到就是 null —— **不编造**「评全了」。
function crCoverage(run) {
  if (run && run.coverage && typeof run.coverage === "object") return run.coverage;
  try { const o = JSON.parse((run && run.coverage_json) || "null"); return o && typeof o === "object" ? o : null; } catch { return null; }
}
// 引擎警告是**对象数组**({file, message, type?}),type 还可能缺失,file 可能是一长串
// 逗号拼接的路径 —— 糊成一坨 JSON 等于没写。
function crWarnText(w) {
  if (typeof w === "string") return w;
  const msg = String((w && w.message) || "").trim();
  const f = String((w && w.file) || "").trim();
  return (msg || "（引擎未给出说明）") + (f ? ` [${f.length > 200 ? f.slice(0, 200) + "…" : f}]` : "");
}// 「这一段是怎么定出来的」。注意:与 lib/code-review.mjs 的 resolveRange / manualRange 保持同步:
//   cursor    按上次评到的提交做增量(常态)
//   cold      这条分支首次评审 —— 回溯最近 N 个提交
//   rewritten 上次评到的提交已被改写(force push / rebase)—— 同样回溯最近 N 个提交
//   manual    手动按范围补评(不推进游标)
// 老记录没有 range_source(列是后加的),按 range_mode 兜底成单提交/增量。
const CR_RANGE_LABEL = { cold: "冷启动回溯", rewritten: "游标失效回溯", manual: "手动补评", cursor: "增量" };
function crRangeText(r) {
  if (!r) return "";
  const src = r.range_source || (r.range_mode === "single" ? "single" : "cursor");
  const tag = CR_RANGE_LABEL[src] || (r.range_mode === "single" ? "单提交" : "增量");
  const ends = (r.range_mode === "single" || !r.from_commit) ? crShort(r.to_commit) : `${crShort(r.from_commit)}→${crShort(r.to_commit)}`;
  return tag + " " + ends;
}
// 「已解决」是谁、什么时候点的(展示用)。存储层记的是当时的名字快照(成员改名后不回改),
// 管理员代为标记时记「管理员」——管理端是共享口令,没有逐人身份,要追到 IP 看审计日志。
function crWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function crResolvedNote(r) {
  if (!r || !r.resolved) return "";
  const who = r.resolved_by ? escH(r.resolved_by) : "管理员";
  const when = crWhen(r.resolved_at);
  return " · 已解决 " + who + (when ? " " + escH(when) : "");
}
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

// 「按范围补评」折叠块。用于「某一段历史当时漏评了」——显式范围覆盖游标判定,且不推进游标
// (补历史不该把高水位线往回拉)。默认收起,不干扰常态触发。
function crManualBox() {
  return '<details class="cr-manual" style="margin-top:11px">'
    + '<summary style="cursor:pointer;font-size:11.5px;font-weight:650;color:var(--dim)">按范围补评(可选 · 不推进游标)</summary>'
    + '<div class="cr-toolbar-main" style="margin-top:10px">'
    + '<div class="cr-field"><label for="crManualFrom">起始提交 <span class="cr-hint-inline">(不含)</span></label>'
    + '<input type="text" id="crManualFrom" placeholder="7~40 位十六进制提交号" autocomplete="off" spellcheck="false"></div>'
    + '<div class="cr-field"><label for="crManualTo">结束提交 <span class="cr-hint-inline">(含)</span></label>'
    + '<input type="text" id="crManualTo" placeholder="7~40 位十六进制提交号" autocomplete="off" spellcheck="false"></div>'
    + '<button type="button" class="btn btn-outline cr-go" onclick="startReviewRange()">补评这一段</button>'
    + '</div>'
    + '<div class="cr-toolbar-hint">两个提交号必须同时填,且都要在所选分支的克隆里(工作区只拉取所选分支那一条线,跨分支的提交补不了)。'
    + '只能填提交号,不能写 <code>HEAD~1</code> 这类表达式。<b>补评不推进游标</b>,也不影响定时计划;仓库正在跑时会排队而不是被合并掉。</div>'
    + '</details>';
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
    + '<div class="cr-toolbar-hint">每条分支各记一份游标:首次评这条分支会<b>回溯最近 N 个提交</b>(默认 10,设置页可调),'
    + '之后按「上次评到 → 现在 HEAD」的<b>增量</b>评审,不会整个仓库重跑。合并带进来的多个提交属于同一段增量,会一起评。评审的是<b>已推送</b>的提交。</div>'
    + '<div class="inline-status cr-run-status" id="crRunStatus" role="status"></div>'
    + crManualBox()
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
  // 运行列表:搜索 + 状态过滤 + 分页(复用 ui.js 的 dlgPager,只渲染当前页)
  html += crRunsToolbar()
    + '<div class="cr-runs" id="crRunsBody"></div>'
    + '<div class="dlg-foot" style="padding:8px 2px 0"><span id="crRunsInfo"></span>'
    + '<button type="button" class="pager-btn" id="crRunsPrev">← 上一页</button>'
    + '<button type="button" class="pager-btn" id="crRunsNext">下一页 →</button></div>';
  html += '</div>';
  body.innerHTML = html;
  crBindRunsToolbar();
  // 渲染完就把当前选中仓库的分支列表拉出来(默认分支会被自动选中)
  crLoadBranches();
}

// 运行列表的筛选条:记录一多,一眼找不到目标就是常态 —— 搜索(仓库/结论/错误) + 状态过滤
function crRunsToolbar() {
  return '<div class="dlg-tools" style="background:transparent;padding:9px 2px;border:0;border-bottom:1px solid var(--border)">'
    + '<input type="search" class="dlg-search" id="crRunsSearch" placeholder="搜索仓库名 / 结论 / 错误…" aria-label="搜索评审记录">'
    + `<select id="crRunsStatus" class="dlg-search" style="flex:none;width:130px" aria-label="按状态过滤"><option value="">全部状态</option>`
    + Object.entries(CR_STATUS_LABEL).map(([k, v]) => `<option value="${escH(k)}">${escH(v)}</option>`).join("")
    + '</select></div>';
}
// 行渲染拆出来给 dlgPager 用(它每页只 render 一页的行)
function crRunRow(r) {
  // 覆盖率不全(新记录看 unreviewed_count,老记录由服务端从 warnings_json 派生)。
  // 注意:老记录(#8/#9)库里的 status 当年经兜底写成了 completed_with_errors、note 还写着
  // 「未发现问题」—— 列表这一行是它**唯一**能被看出来的地方,不标就是继续骗人。
  const unreviewed = Number(r.unreviewed_count) || 0;
  const covIncomplete = !!r.coverageIncomplete;
  const legacyPartial = covIncomplete && r.status !== "partial";
  const cls = crStatusClass(legacyPartial ? "partial" : r.status);
  const active = ["queued", "syncing", "running", "parsing"].includes(r.status);
  const trig = r.trigger && r.trigger !== "manual" ? `<span class="cr-run-trig">${escH(r.trigger)}</span>` : "";
  const files = crParseFiles(r.files_json);
  // 被评文件:列表里给前几个名字(比冷冰冰一个「文件 1」有用得多),更多用 +N 收口
  const fileHint = files.length
    ? `<div class="cr-run-files">${files.slice(0, 3).map((f) => `<span class="cr-file-chip" title="${escH(f)}">${escH(crBase(f))}</span>`).join("")}${files.length > 3 ? `<span class="cr-file-more">+${files.length - 3}</span>` : ""}</div>`
    : "";
  // 「文件 10/39」= 已评/选取。老记录只有派生布尔、没有具体数,就给个「覆盖不全」标记让它去详情看。
  const sel = Number(r.files_reviewed) || 0;
  const filesText = unreviewed > 0 ? `文件 ${Math.max(0, sel - unreviewed)}/${sel}` : `文件 ${sel}`;
  const covTag = covIncomplete
    ? ` <span class="cr-cov-warn" title="${unreviewed > 0 ? `本次只评了 ${Math.max(0, sel - unreviewed)}/${sel} 个文件` : "本次评审覆盖不全"}">覆盖不全,详见详情</span>`
    : "";
  return `<div class="cr-run is-${cls}"><span class="cr-run-num">#${r.id}</span>`
    + '<div class="cr-run-main"><div class="cr-run-title">'
    + `<span class="cr-run-repo">${escH(r.repo_name)}</span>`
    + `<span class="pill pill-${cls}">${escH(CR_STATUS_LABEL[legacyPartial ? "partial" : r.status] || r.status)}</span>`
    // 评出过意见的记录带「已解决/未解决」:和成员页同一状态,管理员也能代为标记
    + (r.comments_count > 0 ? (r.resolved ? '<span class="pill pill-dim">已解决</span>' : '<span class="pill pill-warn">未解决</span>') : "")
    + trig + '</div>'
    + '<div class="cr-run-meta">' + escH(new Date(r.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }))
    + (Number(r.dismissed_count) > 0 ? ` · ${r.dismissed_count} 条不处理` : "")
    // 「意见被丢了几条」必须在列表上就看得见:否则「这版标准更严了」和「评审没跑完」
    // 在列表里长得一模一样(都是意见变少)。
    + (Number(r.dropped_comments) > 0 ? ` · 丢弃 ${r.dropped_comments} 条(缺取证推理)` : "")
    + crResolvedNote(r)
    + " · " + escH(crRangeText(r))
    + (Number(r.commits_count) > 0 ? ` · 提交 ${r.commits_count}` : "")
    + ` · ${filesText}${covTag} · 意见 ${r.comments_count} · ${fmtT(r.input_tokens + r.output_tokens)} token · ${crDur(r.elapsed_ms)}`
    + '</div>'
    // 一句话结论(note):「已跳过」到底是没新提交还是别的原因,靠它说清楚
    + (r.note ? `<div class="cr-run-note">${escH(r.note)}</div>` : "")
    + (r.error ? `<div class="cr-run-note is-err">${escH(String(r.error).slice(0, 200))}</div>` : "")
    + fileHint
    + '</div>'
    + '<div class="cr-run-actions">'
    + `<button type="button" class="btn btn-outline btn-sm" onclick="openReviewRun(${r.id})">详情</button>`
    // 进行中只给「取消」:运行中删 run 行会留下孤儿意见(persistReport 结束后还要往
    // code_review_comments 插行,表间没有外键,不报错)—— 后端也会拦,但按钮就不该出现
    + (active
      ? `<button type="button" class="btn btn-outline btn-sm" onclick="cancelReviewRun(${r.id})">取消</button>`
      : `<button type="button" class="btn btn-outline btn-sm" onclick="deleteReviewRun(${r.id})">删除</button>`)
    + '</div></div>';
}
let crRunsPager = null;
function crBindRunsToolbar() {
  const search = document.getElementById("crRunsSearch");
  const status = document.getElementById("crRunsStatus");
  const repaint = () => {
    const kw = (search ? search.value : "").trim().toLowerCase();
    const st = status ? status.value : "";
    const rows = crRuns.filter((r) => (!st || r.status === st)
      && (!kw || `${r.repo_name} ${r.note || ""} ${r.error || ""}`.toLowerCase().includes(kw)));
    if (!crRunsPager) {
      // searchable:false:过滤条件(搜索 + 状态)在这里,不在 dlgPager 里 —— 避免它反复重置输入框
      crRunsPager = dlgPager({ prefix: "crRuns", perPage: 15, searchable: false, render: crRunRow });
    }
    crRunsPager.set(rows, true);
  };
  if (search && !search.dataset.crBound) { search.dataset.crBound = "1"; search.addEventListener("input", repaint); }
  if (status && !status.dataset.crBound) { status.dataset.crBound = "1"; status.addEventListener("change", repaint); }
  repaint();
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

// 详情弹层(不再堆在列表下面):弹层内带搜索 + 分页,意见再多也只渲染当前页。
// 分页/搜索的公共实现在 ui.js 的 dlgPager —— 两页共用,别各写一套。
let crDetailPager = null;
// 单条意见的「不用处理」:理由必填,输入框原地展开(与成员端同一套交互)。
let CR_DETAIL_RUN_ID = null;
function crDismissAsk(id) { const f = document.getElementById("crCmtForm" + id); if (!f) return; f.hidden = false; const t = document.getElementById("crCmtReason" + id); if (t) t.focus(); }
function crDismissCancel(id) { const f = document.getElementById("crCmtForm" + id); if (f) f.hidden = true; }
async function crDismissPost(id, dismissed, reason, okMsg) {
  try {
    await crApi("/api/code-review/comment/dismiss", { method: "POST", body: JSON.stringify({ id, dismissed: !!dismissed, reason: reason || "" }) });
    crSetStatus(okMsg, "ok");
    if (CR_DETAIL_RUN_ID != null) openReviewRun(CR_DETAIL_RUN_ID);
  } catch (err) { crSetStatus("操作失败：" + err.message, "err"); }
}
function crDismissSubmit(id) {
  const t = document.getElementById("crCmtReason" + id);
  const reason = t ? t.value.trim() : "";
  if (!reason) { crSetStatus("请填写不处理的理由", "err"); if (t) t.focus(); return; }
  crDismissPost(id, true, reason, "已标记不处理");
}
function crDismissUndo(id) { crDismissPost(id, false, "", "已撤销不处理"); }
function crDetailRender(c) {
  const lines = c.start_line ? `:${c.start_line}${c.end_line && c.end_line !== c.start_line ? "–" + c.end_line : ""}` : "";
  const dismissed = Number(c.dismissed) === 1;
  const act = dismissed
    ? '<div class="cr-comment-act"><span class="pill pill-dim">不处理</span>'
      + '<span class="cr-run-meta" style="white-space:normal">' + escH(c.dismiss_reason || "") + (c.dismissed_by ? " · " + escH(c.dismissed_by) : "") + (c.dismissed_at ? " " + escH(crWhen(c.dismissed_at)) : "") + '</span>'
      + `<button type="button" class="pager-btn" onclick="crDismissUndo(${Number(c.id)})">撤销</button></div>`
    : `<div class="cr-comment-act"><button type="button" class="pager-btn" onclick="crDismissAsk(${Number(c.id)})">不用处理</button></div>`
      + `<div class="cr-comment-form" id="crCmtForm${Number(c.id)}" hidden>`
      + `<textarea class="cr-comment-reason" id="crCmtReason${Number(c.id)}" maxlength="500" placeholder="请说明不处理的理由（必填，≤500 字）"></textarea>`
      + `<div class="cr-comment-form-act"><button type="button" class="pager-btn is-primary" onclick="crDismissSubmit(${Number(c.id)})">提交</button>`
      + `<button type="button" class="pager-btn" onclick="crDismissCancel(${Number(c.id)})">取消</button></div></div>`;
  return '<div class="cr-comment' + (dismissed ? ' is-dismissed' : '') + '"><div class="cr-comment-loc">' + escH(c.path) + escH(lines) + '</div>'
    + '<div class="cr-comment-body">' + escH(c.content || "") + '</div>'
    + (c.existing_code ? `<details><summary>原代码</summary><pre>${escH(c.existing_code)}</pre></details>` : "")
    + (c.suggestion_code ? `<details open><summary>建议改法</summary><pre>${escH(c.suggestion_code)}</pre></details>` : "")
    + (c.thinking ? `<details><summary>推理</summary><div class="cr-run-note" style="white-space:pre-wrap">${escH(c.thinking)}</div></details>` : "")
    + act
    + '</div>';
}
// 详情弹层里「静态事实块」与「意见列表」必须是两个容器:分页器 set() 会整块重写自己的
// 列表容器,写进同一个元素的话,事实块(结论/覆盖率/警告/提交清单)一渲染就被冲掉 ——
// 0 条意见的运行只剩一句「没有内容」,看起来就是「详情没有数据」。
function crDetailStaticBox() {
  const body = document.getElementById("crDetailDlgBody");
  if (!body) return null;
  const st = document.getElementById("crDetailDlgStatic");
  if (st) return st;
  // 兜底:页面骨架里没有这两个容器(旧缓存页面)就地补,别退回会被覆盖的那个元素
  const box = document.createElement("div"); box.id = "crDetailDlgStatic";
  const li = document.createElement("div"); li.id = "crDetailDlgList";
  body.innerHTML = "";
  body.appendChild(box); body.appendChild(li);
  return box;
}
// 0 条意见时事实块自己给出结论,再挂个空列表和搜索框是噪声
function crDetailTools(show) {
  const li = document.getElementById("crDetailDlgList");
  if (li) li.style.display = show ? "" : "none";
  const s = document.getElementById("crDetailDlgSearch");
  const tools = s ? s.closest(".dlg-tools") : null;
  if (tools) tools.style.display = show ? "" : "none";
}
async function openReviewRun(id) {
  CR_DETAIL_RUN_ID = id;
  dlgInit("crDetailDlg");
  dlgOpen("crDetailDlg");
  const title = document.getElementById("crDetailDlgTitle");
  const sub = document.getElementById("crDetailDlgSub");
  const body = crDetailStaticBox();
  const exp = document.getElementById("crDetailExport");
  if (sub) sub.textContent = "加载中…";
  if (body) body.innerHTML = '<div class="lb-msg">加载中…</div>';
  crDetailTools(false);
  if (!crDetailPager) {
    crDetailPager = dlgPager({
      prefix: "crDetailDlg", listId: "crDetailDlgList", perPage: 20,
      match: (c) => `${c.path} ${c.start_line || ""} ${c.content || ""} ${c.suggestion_code || ""}`,
      render: crDetailRender,
    });
  }
  try {
    const d = await crApi("/api/code-review/run?id=" + encodeURIComponent(id));
    const run = d.run, comments = d.comments || [];
    const files = crParseFiles(run.files_json);
    const tools = crParseTools(run.tool_calls_json);
    if (title) title.textContent = `运行 #${run.id} · ${run.repo_name} ${CR_STATUS_LABEL[run.status] || run.status}`;
    if (sub) sub.textContent = [
      crRangeText(run),
      run.author_name ? `提交人 ${run.author_name}` : "",
      `${run.comments_count} 条意见${Number(run.dismissed_count) > 0 ? `（${run.dismissed_count} 条已标记不处理）` : ""} · ${run.files_reviewed} 个文件 · ${fmtT(run.input_tokens + run.output_tokens)} token · ${crDur(run.elapsed_ms)}`,
      // 已解决时把「谁、什么时候」放进详情副标题(列表里也有一份,格式一致)
      run.resolved ? (`已解决 ${run.resolved_by || "管理员"}${crWhen(run.resolved_at) ? " " + crWhen(run.resolved_at) : ""}`) : "",
    ].filter(Boolean).join(" · ");
    if (exp) { exp.href = "/api/code-review/report?id=" + run.id; exp.style.display = ""; }
    // 「已解决」按钮:有意见的终结态运行才显示,点了与成员页共享同一个状态
    const rb = document.getElementById("crDetailResolve");
    if (rb) {
      const hasComments = Number(run.comments_count) > 0;
      rb.style.display = hasComments ? "" : "none";
      if (hasComments) {
        rb.dataset.runId = String(run.id);
        rb.dataset.resolved = run.resolved ? "1" : "0";
        rb.textContent = run.resolved ? "撤销已解决" : "标记已解决";
        // 实心只给「可推进的那一步」:未解决时是主操作,已解决后点下去是撤销 —— 撤销不该继续抢眼
        rb.classList.toggle("is-primary", !run.resolved);
      }
    }
    // 「发送给负责人」:评出过意见的运行才可手动补发报告邮件(自动通知只发一次)
    const nb = document.getElementById("crDetailNotify");
    if (nb) {
      nb.style.display = Number(run.comments_count) > 0 ? "" : "none";
      nb.dataset.runId = String(run.id);
    }
    // 结论 + 引擎实际干了多少活:这条是回答「有没有真干活」的关键
    const commits = crParseFiles(run.commits_json);
    const commitsTotal = Number(run.commits_count) || commits.length;
    // ── 覆盖率:选了 N 个 ≠ 评了 M 个 ─────────────────────────────────────────
    // 注意:files_json(下面那份「选取的文件」)是**选中**集,不是已评集;未评的文件列在
    // coverage.sample 里。这一段就是把「没评完」从引擎的 manifest 里搬到人眼前。
    const cov = crCoverage(run);
    const covFailed = cov ? Math.max(0, Number(cov.failed) || 0) : 0;
    const covDone = cov ? Math.max(0, Number(cov.completed) || 0) : 0;
    const covSel = cov ? Math.max(0, Number(cov.selected) || 0) : 0;
    const covWhy = crCoverWhy(cov);
    const incomplete = cov ? covFailed > 0 : !!run.coverageIncomplete;
    const notReviewed = cov && Array.isArray(cov.sample) ? cov.sample : [];
    // 续评计划/轨迹:撞预算后网关自己用 --resume 补了几轮、为什么停下(老记录没有这份轨迹)
    const ar = run.autoResume && typeof run.autoResume === "object" ? run.autoResume : null;
    let html = '<div class="cr-detail"><div class="cr-facts">'
      + crFact("结论", run.note || "—")
      + crFact("评审范围", escH(crRangeText(run)))
      // 覆盖率只对「没评全」才值得占一行;评全了不显示,免得每屏都是废话
      + (incomplete
        ? crFact("覆盖率", cov
          ? `${covDone}/${covSel || Number(run.files_reviewed) || 0} 个文件${covWhy ? `（${escH(covWhy)}）` : ""}`
          : "覆盖不全（详情缺失，原始报告可能已被清理）")
        : "")
      // 与覆盖率同一段:没评全时紧接着回答「网关自己补过没有、为什么停下」
      + (incomplete && ar ? crFact("自动续评", escH(crResumeText(ar))) : "")
      // 为什么是这一段 —— 与结论(note)分开显示:「回退为最近 N 个提交」这类原因不该被结论盖掉
      + (run.range_note ? crFact("范围来源", escH(run.range_note)) : "")
      + (commitsTotal > 0 ? crFact("覆盖提交", `${commitsTotal} 个`) : "")
      + (run.author_name || run.author_email ? crFact("提交人", escH(run.author_name || "—") + (run.author_email ? ` &lt;${escH(run.author_email)}&gt;` : "")) : "")
      + crFact("模型", escH(run.ocr_model || "—") + (run.ocr_provider ? `（${escH(run.ocr_provider)}）` : ""))
      // 用的是哪版标准:两次评审意见条数不同时,先看这一行 —— 换过标准前后的意见数不可直接比
      + crFact("评审标准", run.standard_version ? `v${escH(run.standard_version)}` : "—（此记录早于统一标准）")
      + (Number(run.dropped_comments) > 0 ? crFact("丢弃意见", `${Number(run.dropped_comments)} 条（缺少取证推理，未入库）`) : "")
      + (tools ? crFact("引擎动作", escH(crToolText(tools))) : "")
      + crFact("token", `网关计 ${fmtT(run.attributed_input + run.attributed_output)} · 引擎自报 ${fmtT(run.input_tokens + run.output_tokens)}`)
      + crFact("耗时", crDur(run.elapsed_ms))
      + '</div>';
    if (run.error) html += `<div class="cr-notice is-error" style="margin:0 0 12px">${escH(run.error)}</div>`;
    // 覆盖不全的醒目提示 + 引擎原话(自带算式:已用 + 预估 − 预算)。放在意见列表之前 ——
    // 否则读完 17 条意见就关掉了,根本不知道它们只覆盖了 39 个文件里的 10 个。
    if (incomplete) {
      html += '<div class="cr-notice is-degraded" style="margin:0 0 12px">'
        + `本次没有评完:${cov ? `选取 ${covSel || Number(run.files_reviewed) || 0} 个文件,评了 ${covDone} 个,${covFailed} 个未评审` : "覆盖不全"}`
        + (covWhy ? `（${escH(covWhy)}）` : "") + '。<br>'
        + "下面的结论与意见**只覆盖已评部分**;未评审的文件没有被检查过,不能说它们没问题。"
        + (cov && cov.budgetNotice ? `<br><span class="cr-hint-inline">${escH(String(cov.budgetNotice).slice(0, 400))}</span>` : "")
        + (cov && cov.ocrVersion ? `<br><span class="cr-hint-inline">引擎 ${escH(cov.ocrVersion)}${cov.terminalState ? ` · terminal_state=${escH(cov.terminalState)}` : ""}</span>` : "")
        + (notReviewed.length ? '<div class="cr-files-list" style="margin-top:8px">'
            + notReviewed.map((s) => `<div class="cr-files-item" title="${escH(String(s.path || ""))}">${escH(String(s.path || ""))}${s.reason ? ` <span class="cr-hint-inline">— ${escH(String(s.reason).slice(0, 120))}</span>` : ""}</div>`).join("")
            + (covFailed > notReviewed.length ? `<div class="cr-files-item cr-hint-inline">… 另有 ${covFailed - notReviewed.length} 个未列出</div>` : "")
            + '</div>' : "")
        + '</div>';
    }
    // 引擎警告(warnings):从前只在邮件模版里被读,面板上完全看不到 —— 而「撞预算」
    // 往往就写在这里。语义化渲染,不糊 JSON。
    const warnList = (() => { try { const a = JSON.parse(run.warnings_json || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } })();
    if (warnList.length) {
      html += '<div class="cr-files-block"><div class="cr-files-title">引擎警告（' + warnList.length + ' 条）</div>'
        + '<div class="cr-warn-list">' + warnList.map((w) => `<div class="cr-warn-item">${escH(crWarnText(w))}</div>`).join("") + '</div></div>';
    }
    // 覆盖了哪些提交:范围对了也得能核对「那 5 个提交到底评没评」——这是本次修的核心诉求
    html += '<div class="cr-files-block"><div class="cr-files-title">'
      + (commits.length ? `本次覆盖的 ${commitsTotal} 个提交${commits.length < commitsTotal ? `（清单只留最近 ${commits.length} 条）` : ""}` : "本次没有覆盖任何提交")
      + '</div>'
      + (commits.length
        ? '<details' + (commits.length <= 12 ? ' open' : '') + '><summary style="cursor:pointer;font-size:12px;font-weight:650;color:var(--dim)">提交清单</summary>'
          + '<div class="cr-files-list" style="margin-top:8px">' + commits.map((c) => '<div class="cr-files-item">'
            + `<span class="cr-hint-inline">${escH(crShort(c.sha))}</span> ${escH(c.subject || "(无标题)")}`
            + `<span class="cr-hint-inline"> · ${escH(c.author || "?")}${crWhen(c.at) ? " " + escH(crWhen(c.at)) : ""}</span></div>`).join("") + '</div></details>'
        : '<div class="cr-empty-d" style="text-align:left;margin:0">这条记录没留提交清单(旧版本产生的运行,或范围为空)。</div>')
      + '</div>';
    // 被评文件清单:即使 0 意见也把评过的文件列出来 —— 证明它确实读了这些文件
    html += '<div class="cr-files-block"><div class="cr-files-title">'
      + (files.length ? `本次评审选取的 ${files.length} 个文件` : "本次没有选取任何文件")
      + '</div>'
      + (files.length ? '<div class="cr-files-list">' + files.map((f) => `<div class="cr-files-item" title="${escH(f)}">${escH(f)}</div>`).join("") + '</div>'
        : '<div class="cr-empty-d" style="text-align:left;margin:0">范围里没有可评审的改动。若是「已跳过」,通常表示自上次评审以来没有新提交。</div>')
      + '</div>';
    if (!comments.length) {
      // 注意:这里曾经**无条件**渲染绿勾「本次范围(上面列出的文件)未发现需要修改的问题」——
      // 而上面那份清单来自 files_json,是**选中**集(#9 是 39 个),等于替 29 个从没被读过的
      // 文件打包票。判定必须按 **coverage**,不能按 status:库里 #8/#9 的 status 至今还是
      // completed_with_errors,只看 status 会原样漏掉它们。
      html += incomplete
        ? '<div class="cr-empty is-degraded" style="padding:22px"><div class="cr-empty-ico" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.4 21.6 20.2H2.4z"/><path d="M12 9.7v5.1"/><path d="M12 17.9h.01"/></svg></div><div class="cr-empty-t">未评完，结论不完整</div>'
          + `<div class="cr-empty-d">本次只评审了 ${cov ? `${covDone}/${covSel || Number(run.files_reviewed) || 0}` : "一部分"} 个文件,`
          + `已评部分没有提出意见 —— 这<strong>不等于</strong>「没有问题」,未评审的文件没有被检查过。</div></div>`
        : '<div class="cr-empty" style="padding:22px"><div class="cr-empty-ico">✓</div><div class="cr-empty-t">无意见</div><div class="cr-empty-d">本次范围(上面列出的文件)未发现需要修改的问题。</div></div>';
      html += '</div>';
      body.innerHTML = html;
      crDetailPager.set([]);
      crDetailTools(false);
      return;
    }
    html += `<div class="cr-files-title">评审意见（${comments.length} 条，可搜索、分页）</div></div>`;
    body.innerHTML = html;
    crDetailTools(true);
    crDetailPager.set(comments);
  } catch (err) {
    if (sub) sub.textContent = "";
    if (body) body.innerHTML = '<div class="lb-msg">加载失败：' + escH(err.message) + "</div>";
    crDetailPager.set([]);
    crDetailTools(false);
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
// 按范围补评。与上面共用同一个接口,只多了 from/to;服务端会拒绝「只给一头」的请求。
async function startReviewRange() {
  const repo = document.getElementById("crRunRepo")?.value;
  if (!repo) { crSetStatus("请先在设置页添加仓库", "error"); return; }
  // 与服务端 isValidCommitRef 同一口径:只收 7~40 位十六进制。表达式(HEAD~1 / 分支名)一律不收,
  // 因为它们进的是 git argv —— 这里拦住比让服务端报错体验好
  const hex = /^[0-9a-f]{7,40}$/;
  const from = (document.getElementById("crManualFrom")?.value || "").trim().toLowerCase();
  const to = (document.getElementById("crManualTo")?.value || "").trim().toLowerCase();
  if (!hex.test(from) || !hex.test(to)) {
    crSetStatus("起始与结束都要填 7~40 位十六进制提交号(不能写 HEAD~1 这类表达式)", "error");
    return;
  }
  const branch = document.getElementById("crRunBranch")?.value || "";
  crSetStatus("已提交补评,排队中…");
  try {
    const r = await crApi("/api/code-review/runs/start", { method: "POST", headers: crCsrfHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ repo, branch, from, to }) });
    crSetStatus(`补评已入队 #${r.runId}(不推进游标)`, "ok");
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
// 删除单条评审记录(不可撤销)。confirm 里必须点名三件事,尤其第三件:当日 token 用量是
// 对 code_review_runs 的**实时 SUM**,删掉这条今天就少算这些 token —— 不是「删个日志」那么无害。
async function deleteReviewRun(id) {
  if (!confirm(`删除评审记录 #${id}?\n\n`
    + "· 不可撤销:这条记录连同它的全部意见一起删除\n"
    + "· 已生成的报告文件一并删除\n"
    + "· 这次消耗的 token 会从「今日用量」中退还(预算是实时统计的)\n"
    + "· 仓库状态退回上一条记录(游标不动,已评审过的代码不会因此重跑)")) return;
  try {
    const r = await crApi("/api/code-review/runs/delete", { method: "POST", headers: crCsrfHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ id }) });
    crSetStatus(`已删除运行 #${r.id}${r.files ? "(含报告文件)" : ""}`, "ok");
    // 详情弹层正开着这条 → 先关掉,否则它继续显示一条已经不存在的记录
    if (CR_DETAIL_RUN_ID != null && Number(CR_DETAIL_RUN_ID) === Number(id)) {
      CR_DETAIL_RUN_ID = null;
      dlgClose("crDetailDlg");
    }
    loadCodeReview();
  } catch (err) { crSetStatus(err.message, "error"); }
}
// 详情弹层里的「已解决」切换(管理端):与成员端同一个后端状态,谁点都生效
document.getElementById("crDetailResolve")?.addEventListener("click", async function () {
  const rb = this;
  const id = rb.dataset.runId;
  if (!id) return;
  const want = rb.dataset.resolved !== "1";
  rb.disabled = true;
  try {
    await crApi("/api/code-review/runs/resolve", { method: "POST", headers: crCsrfHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ id: Number(id), resolved: want }) });
    rb.dataset.resolved = want ? "1" : "0";
    rb.textContent = want ? "撤销已解决" : "标记已解决";
    rb.classList.toggle("is-primary", !want);
    crSetStatus(want ? "已标记为已解决" : "已恢复为未解决", "ok");
    loadCodeReview();   // 列表行的 pill 同步
  } catch (err) { crSetStatus(err.message, "error"); }
  rb.disabled = false;
});
// 详情弹层里的「发送给负责人」:手动把这条评审的报告邮件再发一次(负责人判定与
// 自动通知同一套邮箱定向规则);响应里的 message 说明实际发给了谁。
document.getElementById("crDetailNotify")?.addEventListener("click", async function () {
  const nb = this;
  const id = nb.dataset.runId;
  if (!id) return;
  nb.disabled = true;
  const old = nb.textContent;
  nb.textContent = "发送中…";
  try {
    const r = await crApi("/api/code-review/runs/notify", { method: "POST", headers: crCsrfHeaders({ "Content-Type": "application/json" }), body: JSON.stringify({ id: Number(id) }) });
    crSetStatus(r.message || "已发送", "ok");
  } catch (err) { crSetStatus(err.message, "error"); }
  nb.disabled = false;
  nb.textContent = old;
});
document.getElementById("workspace-tab-review")?.addEventListener("click", () => {
  if (!crLoaded) { crLoaded = true; loadCodeReview(); }
});
// 暴露给 dashboard.js 的按菜单懒加载/自动刷新:切到代码评审(含键盘)时确保已加载;
// 自动刷新当前菜单时重拉一次。放在这里是因为加载逻辑与状态都在本文件。
window.crEnsureLoaded = () => { if (!crLoaded) { crLoaded = true; loadCodeReview(); } };
window.crReload = () => loadCodeReview();
