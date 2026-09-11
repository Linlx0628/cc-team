// lib/pages.mjs —— 管理台 / 落地页 HTML 壳函数（纯模板渲染）。
// 从 server.mjs 抽出：运行时依赖经首参 d 注入（server.mjs 持有 PAGE_DEPS）。
// 页面专属样式与脚本已外置 public/assets/，此处仅保留数据引导内联片段。

import { escHtml, escJs } from "./html.mjs";
import { cnDate } from "./time.mjs";
import { QUOTA_RATE_MAX } from "./quota.mjs";
import { normalizePeakHours, isInPeakHours, formatPeakHoursSummary } from "./schedule.mjs";
import { DEFAULT_COST_RATES } from "../production.mjs";

export function settingsHtml(d, errorMsg) {
  const { config, stmts, assets, CSRF_TOKEN, getPublicSettings, getDefaultProfileSuffix, normalizeProfileProtocol, formatModelAliasesInput, ibCacheRows } = d;
  const s = getPublicSettings();
  const errDiv = errorMsg ? `<div style="background:#fff2f0;color:var(--red);border:1px solid #f1c8c2;padding:10px 14px;border-radius:6px;margin-bottom:16px;font-size:13px">${errorMsg}</div>` : "";

  // Global users table rows
  const initialSuffix = s.selectedProfileSuffix || getDefaultProfileSuffix();
  const initialAssignments = s.profileAssignments[initialSuffix] || {};
  const initialProfile = s.profiles.find(p => p.suffix === initialSuffix) || s.profiles[0] || {};

  // Default profile group (failover chain for /v1) rendering
  const dpg = (Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : []).filter(n => config.profiles[n]);
  const groupItemsHtml = dpg.map((name, i) => {
    const p = config.profiles[name];
    const bt = p.billingType === "coding_plan" ? "Coding Plan" : p.billingType === "token_plan" ? "Token Plan" : "按量计费";
    return `<div class="group-item" data-name="${escHtml(name)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px"><span style="color:var(--blue);font-weight:600;min-width:20px">${i + 1}</span><span style="flex:1">${escHtml(name)} <span style="color:var(--dim);font-size:11px">${bt}</span></span><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();moveDefaultGroup('${escJs(name)}',-1)" ${i === 0 ? "disabled" : ""}>↑</button><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();moveDefaultGroup('${escJs(name)}',1)" ${i === dpg.length - 1 ? "disabled" : ""}>↓</button><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();removeFromDefaultGroup('${escJs(name)}')">移出</button></div>`;
  }).join("");
  const nonMembersHtml = Object.keys(config.profiles).filter(n => !dpg.includes(n) && config.profiles[n].upstream && normalizeProfileProtocol(config.profiles[n].protocol) === "anthropic").map(name => `<button type="button" class="preset" onclick="event.stopPropagation();addToDefaultGroup('${escJs(name)}')">+ ${escHtml(name)}</button>`).join("");

  // Responses group (failover chain for /v1/responses) — protocol-pure by construction.
  const rpg = (Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup : [])
    .filter(n => config.profiles[n] && normalizeProfileProtocol(config.profiles[n].protocol) === "responses");
  const responsesGroupItemsHtml = rpg.map((name, i) => {
    const p = config.profiles[name];
    const bt = p.billingType === "coding_plan" ? "Coding Plan" : p.billingType === "token_plan" ? "Token Plan" : "按量计费";
    return `<div class="group-item" data-name="${escHtml(name)}" style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px"><span style="color:var(--blue);font-weight:600;min-width:20px">${i + 1}</span><span style="flex:1">${escHtml(name)} <span style="color:var(--dim);font-size:11px">${bt}</span></span><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();moveResponsesGroup('${escJs(name)}',-1)" ${i === 0 ? "disabled" : ""}>↑</button><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();moveResponsesGroup('${escJs(name)}',1)" ${i === rpg.length - 1 ? "disabled" : ""}>↓</button><button type="button" class="btn btn-outline btn-sm" onclick="event.stopPropagation();removeFromResponsesGroup('${escJs(name)}')">移出</button></div>`;
  }).join("");
  const responsesNonMembersHtml = Object.keys(config.profiles).filter(n => !rpg.includes(n) && config.profiles[n].upstream && normalizeProfileProtocol(config.profiles[n].protocol) === "responses").map(name => `<button type="button" class="preset" onclick="event.stopPropagation();addToResponsesGroup('${escJs(name)}')">+ ${escHtml(name)}</button>`).join("");

  // Sidebar profile card, protocol-aware: the group HEAD of each protocol gets
  // the 默认入口 badge (anthropic head via isDefault, responses head via group
  // order), and the activate button targets that protocol's default entry.
  const profileCard = (p) => {
    const host = p.upstream.replace(/^https?:\/\//, "").replace(/\/.*/, "");
    const isResponses = p.protocol === "responses";
    const isRespDefault = p.inResponsesGroup && p.responsesGroupOrder === 0;
    const isHead = p.isDefault || isRespDefault;
    const suffixLabel = '<span style="color:var(--accent);font-size:10px">/'+ escHtml(p.suffix)+'</span>' + (isHead ? ' <span style="color:var(--green);font-size:10px">默认入口</span>' : '') + (isResponses ? ' <span style="color:var(--blue);font-size:10px">Responses</span>' : '');
    const peakList = normalizePeakHours(p.peakHours);
    const inPeakNow = isInPeakHours(peakList);
    const peakLabel = peakList.length > 0
      ? `<div class="pl-users" style="${inPeakNow ? "color:var(--orange);font-weight:600" : ""}">${escHtml(formatPeakHoursSummary(peakList))}${inPeakNow ? " · 高峰中" : ""}</div>`
      : "";
    // Only surface the rate when weighting is actually in effect for this profile.
    const effRate = inPeakNow ? p.peakQuotaRate : p.offPeakQuotaRate;
    const customCount = Object.keys(p.modelQuotaRates || {}).length;
    const rateLabel = (p.peakQuotaRate !== 1 || p.offPeakQuotaRate !== 1 || customCount > 0)
      ? `<div class="pl-users" style="color:var(--accent)">配额 ×${effRate}<span style="color:var(--dim)"> （峰 ×${p.peakQuotaRate} / 谷 ×${p.offPeakQuotaRate}${customCount > 0 ? ` · ${customCount} 个模型单独定价` : ""}）</span></div>`
      : "";
    return `<div class="pl-item${p.suffix === initialSuffix ? " active" : ""}" id="pl-${escHtml(p.name)}" onclick="editProfile('${escJs(p.name)}')">
<div class="pl-name">${escHtml(p.name)} ${suffixLabel}</div>
<div class="pl-host">${escHtml(host)}</div>
<div class="pl-users">${p.userCount}位用户</div>
${peakLabel}
${rateLabel}
<div class="pl-actions">
  ${!isHead ? '<button class="pl-activate" onclick="event.stopPropagation();setDefaultProfile(\'' + escJs(p.name) + '\',\'' + (isResponses ? "responses" : "anthropic") + '\')">设为默认入口</button>' : ''}
  ${'<button class="pl-activate" onclick="event.stopPropagation();cloneProfile(\'' + escJs(p.name) + '\')">复制</button>'}
  ${'<button class="pl-activate" onclick="event.stopPropagation();renameProfile(\'' + escJs(p.name) + '\')">重命名</button>'}
  ${!p.isDefault ? '<button class="pl-delete" onclick="event.stopPropagation();deleteProfile(\'' + escJs(p.name) + '\')">删除</button>' : ''}
</div></div>`;
  };
  const anthProfiles = s.profiles.filter(p => p.protocol !== "responses");
  const respProfiles = s.profiles.filter(p => p.protocol === "responses");

  // Today's manual quota ops (bonus / reset), now keyed by POOL. The badge needs
  // to appear under every member profile of the pool (the op affects them all),
  // so the map is suffix → set of user keys.
  const quotaOpsByPool = {};
  for (const r of stmts.todayQuotaOps.all(cnDate())) {
    quotaOpsByPool[r.pool] = quotaOpsByPool[r.pool] || {};
    quotaOpsByPool[r.pool][r.user_key] = { bonus: r.bonus || 0, reset_baseline: r.reset_baseline || 0 };
  }
  const quotaOpsJson = JSON.stringify(quotaOpsByPool).replace(/</g, "\\x3c");
  const quotaPoolCount = (s.quotaPools || []).length;

  const globalUserRows = Object.entries(s.globalUsers).map(([k, v]) => {
    const isObj = typeof v === "object" && v !== null;
    const username = isObj ? (v.username || "") : (typeof v === "string" ? v : "");
    const expiresAt = isObj ? (v.expiresAt || "") : "";
    const disabled = isObj ? !!v.disabled : false;
    const superUser = isObj ? !!(v.superUser || v.admin) : false;
    return `<tr>
<td><code style="font-size:11px;color:var(--accent);user-select:all;cursor:pointer" title="点击复制" onclick="navigator.clipboard.writeText('${escJs(k)}')">${escHtml(k)}</code></td>
<td><input type="text" name="gu_un_${escHtml(k)}" value="${escHtml(username)}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px" placeholder="用户名"></td>
<td><input type="datetime-local" name="gu_ex_${escHtml(k)}" value="${escHtml(expiresAt)}" onclick="openDateTimePicker(this)" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:3px 6px;border-radius:4px;font-size:11px;font-family:monospace" title="留空=永不过期"></td>
<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer;white-space:nowrap"><input type="checkbox" name="gu_dis_${escHtml(k)}" ${disabled ? "checked" : ""} style="width:auto;accent-color:var(--red)"><span style="font-size:11px;color:${disabled ? "var(--red)" : "var(--dim)"}">${disabled ? "已禁用" : "正常"}</span></label></td>
<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer;white-space:nowrap" title="超级用户：可直连任意方案并借用其真实Key，不受限制策略约束"><input type="checkbox" name="gu_su_${escHtml(k)}" ${superUser ? "checked" : ""} style="width:auto;accent-color:var(--accent)"><span style="font-size:11px;color:${superUser ? "var(--accent)" : "var(--dim)"}">${superUser ? "不限" : "常规"}</span></label></td>
<td><button type="button" onclick="deleteGlobalUser('${escJs(k)}')" style="background:#fff2f0;color:var(--red);border:1px solid #f1c8c2;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:11px;white-space:nowrap">删除</button></td></tr>`;
  }).join("");

  // Profile user rows (key assignment): real key + disable only. Quota lives in
  // the pool and is edited on the 额度池 page — keeping it here would present the
  // same allowance under every member profile, reading as "one user, many limits".
  const profileUserRows = Object.entries(s.globalUsers).map(([k, v]) => {
    const isObj = typeof v === "object" && v !== null;
    const username = isObj ? (v.username || "") : (typeof v === "string" ? v : "");
    const globalDisabled = isObj ? !!v.disabled : false;
    const pu = initialAssignments[k];
    const realKey = pu ? (typeof pu === "string" ? pu : (pu.key || "")) : "";
    const profileDisabled = pu ? (typeof pu === "object" ? !!pu.disabled : false) : false;
    const rowStyle = globalDisabled ? "opacity:0.4" : "";
    return `<tr style="${rowStyle}">
<td><code style="font-size:11px;color:var(--accent)">${escHtml(k)}</code></td>
<td>${escHtml(username)}</td>
<td><input type="text" name="pu_rk_${escHtml(k)}" value="${escHtml(realKey)}" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:4px;font-size:12px;font-family:monospace" placeholder="真实Key (必填)"></td>
<td><label style="display:inline-flex;align-items:center;gap:4px;margin:0;cursor:pointer;white-space:nowrap"><input type="checkbox" name="pu_dis_${escHtml(k)}" ${profileDisabled ? "checked" : ""} style="width:auto;accent-color:var(--orange)"><span style="font-size:11px;color:${profileDisabled ? "var(--orange)" : "var(--dim)"}">${profileDisabled ? "已禁用" : "正常"}</span></label></td></tr>`;
  }).join("");

  const peakAliasesText = formatModelAliasesInput(s.peakModelAliases || {});
  const settingsJson = JSON.stringify(s).replace(/</g, "\\x3c");

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2096%2096%22%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2222%22%20fill%3D%22%232f6e50%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fbfbf8%22%20stroke-width%3D%2213%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate(48%2048)%20scale(0.88)%20translate(-48%20-48)%22%3E%3Cpath%20d%3D%22M37%2026.5H31.5Q20.5%2026.5%2020.5%2037.5V58.5Q20.5%2069.5%2031.5%2069.5H37%22%2F%3E%3Cpath%20d%3D%22M59%2026.5H64.5Q75.5%2026.5%2075.5%2037.5V58.5Q75.5%2069.5%2064.5%2069.5H59%22%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2248%22%20r%3D%226.2%22%20fill%3D%22%23fbfbf8%22%2F%3E%3C%2Fsvg%3E">
<title>设置 - CC Team</title>
<link rel="stylesheet" href="${assets.url("theme.css")}">
<link rel="stylesheet" href="${assets.url("settings.css")}"></head><body data-theme="editorial-light">
<div class="layout">
<div class="sidebar">
<div class="sidebar-hd"><div class="sidebar-brand"><svg class="brand-logo" width="24" height="24" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="#2f6e50"/><g fill="none" stroke="#fbfbf8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" transform="translate(48 48) scale(0.9) translate(-48 -48)"><path d="M37 26.5H31.5Q20.5 26.5 20.5 37.5V58.5Q20.5 69.5 31.5 69.5H37"/><path d="M59 26.5H64.5Q75.5 26.5 75.5 37.5V58.5Q75.5 69.5 64.5 69.5H59"/></g><circle cx="48" cy="48" r="4.95" fill="#fbfbf8"/></svg><h1>配置方案</h1></div><a href="/dashboard">返回面板</a></div>
<div class="proto-tabs" id="protoTabs">
  <button type="button" class="proto-tab on" data-tab="anthropic" onclick="switchProtoTab('anthropic')">Anthropic<small>Claude Code · /v1</small></button>
  <button type="button" class="proto-tab" data-tab="responses" onclick="switchProtoTab('responses')">OpenAI<small>Codex · /v1/responses</small></button>
</div>
<div class="proto-pane" data-proto="anthropic">
  <div class="proto-pane-hd"><span>Anthropic 方案 <span class="proto-entry">入口 /v1</span></span><button type="button" class="btn btn-outline btn-sm" onclick="openProfileModal('anthropic')">+ 新建</button></div>
  <div class="proto-pane-hint">Claude Code 走这里；默认入口与 failover 仅影响 /v1</div>
  <div class="sidebar-list">${anthProfiles.map(profileCard).join("") || '<div style="padding:0 12px 8px;font-size:11px;color:var(--dim)">暂无 Anthropic 方案</div>'}</div>
</div>
<div class="proto-pane" data-proto="responses" style="display:none">
  <div class="proto-pane-hd"><span>OpenAI 方案 <span class="proto-entry">入口 /v1/responses</span></span><button type="button" class="btn btn-outline btn-sm" onclick="openProfileModal('responses')">+ 新建</button></div>
  <div class="proto-pane-hint">Codex 走 /v1/responses；与 Claude Code 完全隔离</div>
  <div class="sidebar-list">${respProfiles.map(profileCard).join("") || '<div style="padding:0 12px 8px;font-size:11px;color:var(--dim)">暂无 OpenAI 方案 — Codex 请求将返回 503</div>'}</div>
</div>
<div class="sidebar-dock">
  <div class="sidebar-global" data-proto="anthropic" style="padding:8px 12px">
    <div style="font-size:11px;font-weight:650;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
      <span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">默认方案组</span>
      <div style="display:flex;align-items:center;gap:6px;flex:none">
        <button type="button" class="btn btn-outline btn-sm" data-grouppop-btn onclick="toggleGroupAddPop('defaultGroupAddPop',this)" style="font-size:10px;padding:3px 8px">＋ 加入</button>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:10px;font-weight:400;white-space:nowrap" title="全局设置：同时作用于两个协议的方案组"><input type="checkbox" id="restrictGroupSuffixCb" ${config.restrictGroupSuffix !== false ? "checked" : ""} onchange="setRestrictGroupSuffix(this.checked)" style="width:auto;accent-color:var(--accent)"> 限制直连</label>
      </div>
    </div>
    <div id="defaultGroupList" style="margin-bottom:6px">${groupItemsHtml || '<span style="font-size:11px;color:var(--dim)">组为空 — 至少加入 2 个方案以启用 failover</span>'}</div>
    <div class="group-add-pop" id="defaultGroupAddPop">
      <div class="gap-hd">未加入的 Anthropic 方案</div>
      ${nonMembersHtml || '<div class="gap-empty">没有可加入的方案</div>'}
    </div>
  </div>
  <div class="sidebar-global" data-proto="responses" style="padding:8px 12px;display:none">
    <div style="font-size:11px;font-weight:650;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
      <span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">OpenAI 方案组</span>
      <div style="display:flex;align-items:center;gap:6px;flex:none">
        <button type="button" class="btn btn-outline btn-sm" data-grouppop-btn onclick="toggleGroupAddPop('responsesGroupAddPop',this)" style="font-size:10px;padding:3px 8px">＋ 加入</button>
        <label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:10px;font-weight:400;white-space:nowrap" title="全局设置：同时作用于两个协议的方案组"><input type="checkbox" id="restrictGroupSuffixCb2" ${config.restrictGroupSuffix !== false ? "checked" : ""} onchange="setRestrictGroupSuffix(this.checked)" style="width:auto;accent-color:var(--accent)"> 限制直连</label>
      </div>
    </div>
    <div id="responsesGroupList" style="margin-bottom:6px">${responsesGroupItemsHtml || '<span style="font-size:11px;color:var(--dim)">组为空 — Codex 请求将返回 503</span>'}</div>
    <div class="group-add-pop" id="responsesGroupAddPop">
      <div class="gap-hd">未加入的 OpenAI 方案</div>
      ${responsesNonMembersHtml || '<div class="gap-empty">没有可加入的方案</div>'}
    </div>
  </div>
<div class="sidebar-nav">
  <button type="button" class="nav-btn" id="quotaPoolNav" onclick="openQuotaPoolView()" title="额度池（${quotaPoolCount} 个池）——共享额度与定价">额度池</button>
  <button type="button" class="nav-btn" id="dataManagementNav" onclick="openDataManagementView()" title="全局数据管理——导入、备份与清空">数据管理</button>
  <button type="button" class="nav-btn" id="auditLogNav" onclick="openAuditLogView()" title="操作日志——谁在何时改了什么">操作日志</button>
  <button type="button" class="nav-btn" id="quotaRequestNav" onclick="openQuotaRequestView()" title="加量申请——成员发起的用量增加申请">加量申请<span id="qrPendingBadge" style="display:none;margin-left:6px;background:var(--orange);color:#fff;border-radius:8px;font-size:10px;padding:1px 6px;vertical-align:1px"></span></button>
</div>
<div class="sidebar-ft" style="display:flex;gap:6px"><button class="btn btn-outline btn-sm" onclick="openUserModal()" style="flex:1">用户管理</button><button class="btn btn-outline btn-sm" onclick="openProfileModal()" style="flex:1">新增方案</button></div>
</div>
</div>
<div class="main">
${errDiv}
<form method="post" action="/api/settings-save" id="settingsForm">
<input type="hidden" name="_csrf" id="csrfToken" value="${CSRF_TOKEN}">
<input type="hidden" name="profileName" id="profileNameInput" value="${escHtml(initialProfile.name || "")}">
<input type="hidden" name="profileSuffix" id="profileSuffixInput" value="${escHtml(initialSuffix)}">

<h2>上游代理 <span class="status ${s.circuitBreaker.state === 'CLOSED' ? 'status-ok' : s.circuitBreaker.state === 'OPEN' ? 'status-err' : 'status-warn'}">${s.circuitBreaker.state === 'CLOSED' ? '正常' : s.circuitBreaker.state === 'HALF_OPEN' ? '探测中' : s.circuitBreaker.state === 'OPEN' ? '熔断中' : '未配置'}</span></h2>
<div class="section">
<div class="row">
<div><label>上游 API 地址<span class="req">*</span></label><input type="text" name="upstream" value="${s.upstream}" placeholder="https://open.bigmodel.cn/api/anthropic"></div>
<div><label>URL 后缀 <span style="font-size:11px;color:var(--dim);font-weight:400">(所有方案必填)</span></label><input type="text" name="suffix" id="suffixInput" value="${escHtml(initialSuffix)}" placeholder="如: glm" oninput="updateAccessUrl()"></div>
</div>
<div class="row" id="responsesPathRow" style="${initialProfile.protocol === "responses" ? "" : "display:none"}">
<div><label>Responses 出站端点 <span style="font-size:11px;color:var(--dim);font-weight:400">仅 Responses(Codex) 方案</span></label><input type="text" name="responsesPath" id="responsesPathInput" value="${escHtml(initialProfile.responsesPath || "/v1/responses")}" placeholder="/v1/responses 或 /responses"><span class="note">网关会把这个端点拼到上游地址后（多数上游用 /v1/responses；火山 Coding Plan 用 /responses）。</span></div>
</div>
<div class="note" id="accessUrlPreview" style="margin-top:8px;color:var(--green)">接入地址: http://&lt;host&gt;:6789/v1</div>
<div class="presets">
  <span style="font-size:11px;color:var(--dim);line-height:24px">快速填充：</span>
  <button type="button" class="preset" onclick="fillUpstream('https://open.bigmodel.cn/api/anthropic')">智谱 GLM</button>
  <button type="button" class="preset" onclick="fillUpstream('https://api.anthropic.com')">Anthropic</button>
  <button type="button" class="preset" onclick="fillUpstream('https://api.deepseek.com/anthropic')">DeepSeek</button>
  <button type="button" class="preset" onclick="fillUpstream('https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic')">阿里 Token Plan</button>
</div>
<div class="note" style="margin-top:8px">状态：${s.circuitBreaker.state === 'CLOSED' ? '正常运行' : s.circuitBreaker.state === 'HALF_OPEN' ? '探测恢复中' : s.circuitBreaker.state === 'OPEN' ? '熔断中(' + Math.ceil(s.circuitBreaker.cooldownRemaining / 1000) + 's 后自动探测' + (s.circuitBreaker.probeFailures > 0 ? '，已连续探测失败 ' + s.circuitBreaker.probeFailures + ' 次，冷却退避至 ' + Math.round((s.circuitBreaker.cooldownMs || 0) / 1000) + 's' : '') + ')' : '等待配置上游'} | 失败 ${s.circuitBreaker.failureCount} | 成功 ${s.circuitBreaker.totalSuccesses} | 失败 ${s.circuitBreaker.totalFailures}</div>
<div class="note">熔断期间请求自动切换到默认组的下一个方案；冷却结束后会自动放行探测请求，上游恢复即切回本方案，无需手工干预。</div>
</div>

<h2>模型别名<span class="req">*必填</span></h2>
<div class="section">
<label>通用模型别名 — 一行一个别名，别名与实际模型一一对应<span class="req">*必填</span></label>
<div class="alias-toolbar">
  <span style="font-size:11px;color:var(--dim);line-height:24px">快捷添加：</span>
  <button type="button" class="preset" onclick="addAliasRow('jx-fable')">jx-fable</button>
  <button type="button" class="preset" onclick="addAliasRow('jx-opus')">jx-opus</button>
  <button type="button" class="preset" onclick="addAliasRow('jx-haiku')">jx-haiku</button>
  <button type="button" class="preset" onclick="addAliasRow('jx-sonnet')">jx-sonnet</button>
  <button type="button" class="preset" onclick="addAliasRow('')">＋自定义别名</button>
</div>
<div class="alias-head"><span>别名</span><span>实际模型</span><span>上下文长度</span><span>多模态</span><span></span></div>
<div id="aliasRows"></div>
<datalist id="stdAliasList"><option value="jx-fable"></option><option value="jx-opus"></option><option value="jx-haiku"></option><option value="jx-sonnet"></option></datalist>
<div class="note">至少配置 1 行完整别名。「多模态」勾选表示该别名原生支持图片（直通，不转述）；不勾选的别名贴图时网关会自动转述（见下方辅助模型设置）。上下文长度写入成员 Codex 接入配置的 models.json。删除行后行号自动重排。</div>
<label style="margin-top:14px">高峰期别名覆盖（可选，仅覆盖上方同名别名）</label>
<div class="alias-toolbar">
  <button type="button" class="preset" onclick="addPeakRow()">＋添加覆盖</button>
</div>
<div class="alias-head"><span>别名</span><span>实际模型</span><span></span></div>
<div id="peakRows"></div>
<div class="note">仅在下方「高峰时段」命中时生效（按北京时间判断）：被覆盖的别名在高峰期改用这里的实际模型，未覆盖的沿用默认映射。可用来在高峰期把昂贵模型换成便宜的。</div>
</div>

<h2>允许模型<span style="font-size:11px;color:var(--dim);font-weight:400">由别名自动生成，不可手动编辑</span></h2>
<div class="section">
<div id="allowedTags" class="tag-row"></div>
<div class="note" id="allowedModelsNote">自动汇总上方所有别名（含高峰期覆盖）的实际模型并去重。不在列表中的模型请求将被拦截返回 403。</div>
</div>

<h2>图片识别辅助模型<span style="font-size:11px;color:var(--dim);font-weight:400">Claude Code 与 Codex 方案通用</span></h2>
<div class="section">
<div class="row">
<div><label>辅助模型（用于识别图片，可选）</label>
<select name="imgBridgeModel" id="imgBridgeModel">
<option value="">自动（勾选多模态的别名中取第一个）</option>
${(() => { const mm = initialProfile.modelMultimodal || {}; const aliases = initialProfile.modelAliases || {}; return Object.keys(aliases).filter(a => mm[a] !== false).map(a => `<option value="${escHtml(aliases[a])}" ${initialProfile.imageBridge?.model === aliases[a] ? "selected" : ""}>${escHtml(a)} → ${escHtml(aliases[a])}</option>`).join("") })()}
</select>
</div>
<div style="align-self:flex-end"><span class="note">勾选了「多模态」的别名收到图片会原样直通；未勾选的别名收到图片时（Claude Code 与 Codex 均生效），会自动用此辅助模型转述后再交给原模型。同图自动缓存，多轮对话不重复识别。辅助模型的每次新图片识别会产生少量额外 token。</span></div>
</div>
<div class="row" style="align-items:center;gap:10px;margin-top:6px">
<button type="button" class="btn btn-outline btn-sm" onclick="clearImageBridgeCache()">清空转述缓存</button>
<span class="note" id="ibCacheCount">${ibCacheRows()}</span>
</div>
</div>

<h2>计费类型</h2>
<div class="section">
<label>该方案的计费模式（仅用于展示；默认方案组里通常把 Coding Plan 排在按量计费之前）</label>
<select name="billingType">
  <option value="coding_plan" ${initialProfile.billingType === "coding_plan" ? "selected" : ""}>Coding Plan（套餐限额，触发 429 自动切换）</option>
  <option value="token_plan" ${initialProfile.billingType === "token_plan" ? "selected" : ""}>Token Plan（包年/包月）</option>
  <option value="on_demand" ${(!initialProfile.billingType || initialProfile.billingType === "on_demand") ? "selected" : ""}>按量计费（无限额，通常作 failover 兜底）</option>
</select>
</div>

<h2>额度池 <span style="font-size:11px;color:var(--dim);font-weight:400">同一上游套餐的方案应放进同一个池，共享额度判定；配额只计输入+输出，北京时间每日0点重置</span></h2>
<div class="section">
<label>所属额度池 — 该方案及同池所有方案的用量合并计入同一份每日额度</label>
${(() => {
  const pools = s.quotaPools || [];
  const current = initialProfile.quotaPool || "";
  const pool = pools.find(p => p.name === current);
  const memberNames = pool ? pool.profiles.map(m => m.name).join("、") : "";
  const limitSummary = pool
    ? (pool.dailyTokenLimit ? `池级上限 ${(pool.dailyTokenLimit).toLocaleString("zh-CN")}` : "池级不限制")
      + ` · ${Object.keys(pool.userLimits).length} 人有个人配额`
    : "";
  return `<select name="quotaPool" id="quotaPoolSelect" onchange="updatePoolSummary()">
    ${pools.map(p => `<option value="${escHtml(p.name)}" ${p.name === current ? "selected" : ""}>${escHtml(p.label)}（${p.profiles.length} 个方案）</option>`).join("")}
    <option value="__new__" ${!current ? "selected" : ""}>＋ 新建额度池（与方案同名）</option>
  </select>
  <div class="note" id="poolSummary">${pool ? `本池成员：${escHtml(memberNames)} · ${escHtml(limitSummary)}${pool.profiles.length > 1 ? '<br><b style="color:var(--orange)">注意：改入此池后，该方案的用量与额度立即与上述方案合并计算</b>' : ""}` : "未关联额度池"}</div>
  <div class="note">同一上游套餐的 Anthropic 与 Responses 两个方案放进同一个池后，成员在两端的消耗从同一份额度中扣减，不会再翻倍。每人配额在用户管理弹窗中设置（写入所属池，同池方案共享）。倍率仍按方案独立配置。</div>`;
})()}
</div>

<h2>配额倍率 <span style="font-size:11px;color:var(--dim);font-weight:400">按时段折算配额消耗，只影响配额计算，统计报表始终显示真实 token</span></h2>
<div class="section">
<label>方案默认倍率 — 未单独定价的模型都走这一档</label>
<div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-end">
<div><label>高峰时段倍率</label>
<input type="number" name="peakQuotaRate" id="peakQuotaRateInput" value="${initialProfile.peakQuotaRate ?? 1}" min="0" max="${QUOTA_RATE_MAX}" step="0.05" style="width:120px"></div>
<div><label>低谷时段倍率</label>
<input type="number" name="offPeakQuotaRate" id="offPeakQuotaRateInput" value="${initialProfile.offPeakQuotaRate ?? 1}" min="0" max="${QUOTA_RATE_MAX}" step="0.05" style="width:120px"></div>
<div id="cacheReadQuotaField" style="${initialProfile.protocol === "responses" ? "" : "display:none"}"><label>缓存命中计入比例</label>
<input type="number" name="cacheReadQuotaRate" id="cacheReadQuotaRateInput" value="${initialProfile.cacheReadQuotaRate ?? 0}" min="0" max="1" step="0.05" style="width:120px"></div>
</div>
<div class="note" id="quotaRateHint" style="margin-top:8px"></div>
<div class="note" style="margin-top:6px">1.0 = 按实际 token 计入配额；0.5 = 该时段消耗只扣一半额度。建议以「高峰期 Coding Plan 方案 = 1.0」为基准：套餐方案低谷可设 0.5，按量计费方案设 1.5~2.0 反映真实成本。<b>修改只影响之后的请求，已产生的消耗不会重算。</b></div>
<div class="note" id="cacheReadQuotaNote" style="margin-top:4px;${initialProfile.protocol === "responses" ? "" : "display:none"}">「缓存命中计入比例」仅对 <b>Responses/Codex 方案</b>生效——这类上游把缓存命中折在 input_tokens 里；0 = 缓存命中不计入配额（默认，与 Anthropic 方案口径一致）；1 = 按旧行为全额计入；0.x = 按比例计入。Anthropic 方案的 input_tokens 本不含缓存读（缓存读单列、不进配额），无需此设置。</div>

<label style="margin-top:16px">按模型单独定价（可选，覆盖上方默认倍率）</label>
<div class="alias-toolbar">
  <button type="button" class="preset" onclick="addRateRow()">＋添加模型倍率</button>
  <button type="button" class="preset" onclick="fillAllRateRows()">按全部模型铺开</button>
</div>
<div class="alias-head rate"><span>实际模型</span><span>高峰倍率</span><span>低谷倍率</span><span>当前生效</span><span></span></div>
<input type="hidden" name="mrPresent" value="1">
<div id="rateRows"></div>
<div class="note" id="rateRowsHint"></div>
<div class="note">模型下拉来自上方别名的实际模型（含高峰期覆盖），避免手打错名字导致静默回落默认倍率。同一实际模型被多个别名指向时只需配一次。适合给便宜的 flash / mini 档位设更低倍率，或给昂贵模型设更高倍率。</div>
</div>

<h2>高峰时段 <span style="font-size:11px;color:var(--dim);font-weight:400">每日重复的时间段（按北京时间判断，与部署服务器时区无关），命中时启用上方的「高峰期模型别名」与「高峰时段倍率」</span></h2>
<div class="section">
<input type="hidden" name="peakStart" value="">
<input type="hidden" name="peakEnd" value="">
<div id="peakHoursList"></div>
<div style="display:flex;align-items:center;gap:10px;margin-top:8px">
<button type="button" class="btn btn-outline btn-sm" onclick="addPeakHoursRow()">添加时段</button>
<span class="note" id="peakHoursStatus"></span>
</div>
<div class="note" style="margin-top:6px">结束时间早于开始时间表示跨天时段（如 22:00-02:00）。可添加多个时段，均按北京时间计算。</div>
</div>

<h2 style="border-top:2px solid var(--border);padding-top:18px;margin-top:30px">全局配置 <span style="color:var(--dim);font-size:12px;font-weight:400">所有方案共享，不随方案切换</span></h2>
<div class="section" style="background:var(--surface-subtle);border-color:var(--border-strong)">
<div class="note" style="margin:0">以下设置作用于整个系统（所有方案共用同一份代理参数与自动配额策略），切换左侧方案不会改变这里的值。</div>
</div>

<div class="actions">
<button type="button" class="btn btn-outline" onclick="location.href='/dashboard'">取消</button>
<button type="submit" class="btn btn-primary">保存设置</button>
</div>
</form>

<div id="dataManagementView" hidden aria-hidden="true">
<div class="view-intro">
  <h2>全局数据管理</h2>
  <p>此处操作作用于整个系统，不属于任何单一配置方案。导入前请确认来源方案映射，危险操作执行前会自动创建本地备份。</p>
</div>
<div class="section" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
  <button type="button" class="btn btn-outline" onclick="clearRateLimitState()">清除限流状态（所有方案立即恢复参与 failover）</button>
  <button type="button" class="btn btn-outline" onclick="clearStickyBindings()">清除粘性绑定（下次请求回到各组默认方案）</button>
  <span class="note">限流状态在数据库持久化，重启不会自动清除。若确认某个方案额度实际已恢复（如 Coding Plan 重置），可点「清除限流状态」让它立即回到组头接管；若额度确已用尽，下一请求会再次触发限流并自动切到备用方案。清除粘性绑定则让所有会话的下一轮请求从各组组头重新开始。</span>
</div>
<h2>超时 &amp; 重试 <span style="font-size:11px;color:var(--dim);font-weight:400">全局代理配置，对所有方案生效</span></h2>
<form method="post" action="/api/settings-save" id="globalForm">
<input type="hidden" name="_csrf" value="${CSRF_TOKEN}">
<div class="section">
<div class="row">
<div><label>JSON 请求超时 (ms)</label><input type="number" name="timeout" value="${s.proxy.timeout}" min="10000" max="600000"></div>
<div><label>流式请求超时 (ms)</label><input type="number" name="streamTimeout" value="${s.proxy.streamTimeout}" min="30000" max="1200000"></div>
</div>
<div class="row">
<div><label>最大重试次数</label><input type="number" name="maxRetries" value="${s.proxy.maxRetries}" min="0" max="10"></div>
<div><label>重试基础延迟 (ms)</label><input type="number" name="retryDelay" value="${s.proxy.retryDelay}" min="100" max="30000"></div>
</div>
<div class="row">
<div><label>可重试状态码</label><input type="text" name="retryableStatusCodes" value="${(s.proxy.retryableStatusCodes || []).join(",")}"></div>
<div><label>熔断失败阈值</label><input type="number" name="circuitBreakerFailures" value="${s.proxy.circuitBreakerFailures || 5}" min="1" max="50"></div>
</div>
<div class="row">
<div><label>熔断冷却时间 (ms)</label><input type="number" name="circuitBreakerCooldown" value="${s.proxy.circuitBreakerCooldown || 30000}" min="5000" max="300000"></div>
<div></div>
</div>
</div>

<h2>流量控制 <span style="font-size:11px;color:var(--dim);font-weight:400">全局代理配置，对所有方案生效</span></h2>
<div class="section">
<div class="row">
<div><label>每用户最大并发数</label><input type="number" name="maxConcurrentPerUser" value="${s.proxy.maxConcurrentPerUser}" min="1" max="100"></div>
<div><label>每用户每分钟最大请求数</label><input type="number" name="rateLimitPerMinute" value="${s.proxy.rateLimitPerMinute}" min="1" max="600"></div>
</div>
</div>

<h2>自动配额调整 <span style="font-size:11px;color:var(--dim);font-weight:400">用户持续用满配额时自动上调限额</span></h2>
<div class="section">
<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" name="autoQuotaEnabled" ${s.autoQuotaAdjust?.enabled ? "checked" : ""} style="width:auto"> 启用自动调整</label>
<span class="note">启用后，系统每日评估一次，符合条件自动上调配额</span>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">
<div><label>评估周期（天）</label><input type="number" name="aqPeriod" value="${s.autoQuotaAdjust?.evaluationPeriodDays ?? 5}" min="3" max="30"></div>
<div><label>命中阈值</label><input type="number" name="aqHitThreshold" value="${Math.round((s.autoQuotaAdjust?.hitThreshold ?? 0.9) * 100)}" min="50" max="100" step="5"><span class="note">% · 用量达到配额多少算命中</span></div>
<div><label>触发命中率</label><input type="number" name="aqTriggerRate" value="${Math.round((s.autoQuotaAdjust?.triggerRate ?? 0.9) * 100)}" min="30" max="100" step="10"><span class="note">% · 命中天数占周期多少才触发</span></div>
<div><label>增长率</label><input type="number" name="aqIncreaseFactor" value="${Math.round(((s.autoQuotaAdjust?.increaseFactor ?? 1.15) - 1) * 100)}" min="5" max="100" step="5"><span class="note">% · 每次上调比例</span></div>
<div><label>安全系数</label><input type="number" name="aqSafetyFactor" value="${Math.round((s.autoQuotaAdjust?.safetyFactor ?? 1.3) * 100)}" min="100" max="200" step="5"><span class="note">% · 按均值计算时的余量</span></div>
<div><label>单次最大增幅</label><input type="number" name="aqMaxIncrease" value="${(s.autoQuotaAdjust?.maxIncreaseFactor ?? 2.0)}" min="1.1" max="5" step="0.1"><span class="note">x · 单次调整不超过几倍</span></div>
<div><label>配额上限</label><input type="number" name="aqMaxQuota" value="${s.autoQuotaAdjust?.maxAutoQuota ?? 10000000}" min="0" step="100000"><span class="note">自动调整不超过此值</span></div>
<div><label>冷却天数</label><input type="number" name="aqCooldown" value="${s.autoQuotaAdjust?.cooldownDays ?? 3}" min="1" max="30"><span class="note">两次调整最小间隔</span></div>
</div>
${((() => { const qa = stmts.quotaAdjustRecent.all(); return qa.length > 0 ? `<h4 style="font-size:13px;color:var(--accent);margin:16px 0 8px">调整历史</h4><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">时间</th><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">用户</th><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">方式</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">旧配额</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">新配额</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">命中率</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border)">日均用量</th></tr></thead><tbody>${qa.map(h => `<tr><td style="padding:4px 8px">${h.date}</td><td style="padding:4px 8px">${h.user_name || h.user_key.slice(0, 8)}</td><td style="padding:4px 8px">${h.auto === 0 ? '<span style="color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:0 4px;font-size:11px" title="管理员当日临时加量，次日自动失效">手动·当日</span>' : '<span style="color:var(--dim)">自动</span>'}</td><td style="text-align:right;padding:4px 8px">${(h.old_quota || 0).toLocaleString()}</td><td style="text-align:right;padding:4px 8px;color:var(--green)">${(h.new_quota || 0).toLocaleString()}</td><td style="text-align:right;padding:4px 8px">${h.auto === 0 ? "-" : Math.round((h.hit_rate || 0) * 100) + "%"}</td><td style="text-align:right;padding:4px 8px">${h.auto === 0 ? "-" : (h.avg_daily_usage || 0).toLocaleString()}</td></tr>`).join("")}</tbody></table>` : '<div class="note" style="margin-top:8px">暂无调整记录</div>'; })())}
</div>
<h2>签到与加量申请 <span style="font-size:11px;color:var(--dim);font-weight:400">成员在「我的用量」页可用的趣味功能</span></h2>
<div class="section">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px">
<div style="border-right:1px solid var(--border);padding-right:18px">
<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" name="checkInEnabled" ${s.checkIn?.enabled !== false ? "checked" : ""} style="width:auto"> 启用每日签到</label>
<div class="note" style="margin:8px 0 12px">成员每天可签到一次，随机奖励一定量 token，自动加入其所有额度池的当日临时加量（明日自动失效，与手工加量累加）。</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
<div><label>随机奖励最小（token）</label><input type="number" name="checkInMin" value="${s.checkIn?.minTokens ?? 10000}" min="0" step="1000"></div>
<div><label>随机奖励最大（token）</label><input type="number" name="checkInMax" value="${s.checkIn?.maxTokens ?? 100000}" min="0" step="1000"></div>
</div>
</div>
<div>
<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" name="quotaRequestEnabled" ${s.quotaRequest?.enabled !== false ? "checked" : ""} style="width:auto"> 启用加量申请</label>
<div class="note" style="margin:8px 0 12px">成员可在「我的用量」页选择额度池申请加量（每人每天限提交 1 次，提交不占次数）；新申请通过通知渠道推送给你，并在侧栏「加量申请」里处理。</div>
<div><label>每人每周处理上限（次）</label><input type="number" name="quotaRequestWeeklyLimit" value="${s.quotaRequest?.weeklyLimit ?? 3}" min="0" max="1000"><span class="note">次 / 周 · 管理员处理后计入，周一刷新（设为 0 相当于关闭）</span></div>
</div>
</div>
</div>
<div class="actions" style="position:static;padding:12px 0;background:transparent;border-top:0">
<button type="submit" class="btn btn-primary">保存全局配置</button>
</div>
</form>

<h2 id="costRatesCard">产出与成本设置 <span style="font-size:11px;color:var(--dim);font-weight:400">牌价全局生效,不随方案切换;价格表驱动「等值成本」工作区</span></h2>
<div class="section">
<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="prodTrackingToggle" style="width:auto"> 启用产出解析<span class="note" style="margin:0">仅统计结构化指标,不存储代码内容</span></label>
<label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-top:8px"><input type="checkbox" id="prodPathToggle" style="width:auto"> 记录文件路径<span class="note" style="margin:0">关闭则仅保留扩展名</span></label>
<label style="margin-top:14px">模型参考牌价(USD / 1M tokens) — 支持前缀匹配,如 claude-sonnet 覆盖所有 claude-sonnet-* 变体</label>
<div class="alias-head rate" style="grid-template-columns:2fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr auto"><span>模型名</span><span>输入</span><span>输出</span><span>缓存写</span><span>缓存读</span><span>高峰In</span><span>高峰Out</span><span>峰缓存写</span><span>峰缓存读</span><span></span></div>
<div id="costRateRows"></div>
<div style="display:flex;align-items:center;gap:10px;margin-top:8px">
<button type="button" class="btn btn-outline btn-sm" onclick="addCostRateRow('', {input:0,output:0,cacheWrite:0,cacheRead:0})">＋添加模型价格</button>
<button type="button" class="btn btn-primary btn-sm" onclick="saveProdSettings()">保存</button>
<span class="note" id="prodSettingsMsg" style="margin:0"></span>
</div>
<div class="note">牌价用于把 token 用量折算为等值美元成本(参考牌价,非实际账单)。未配置价格的模型计 0 并在「等值成本」工作区列出,可在此补充。价格为查询时现算,修改后全部历史立即按新价重算。高峰判档复用各方案设置里的「高峰时段」(按北京时间),方案未设高峰 = 该方案全天按基础价;各高峰价(高峰In/Out、峰缓存写/读)留空 = 同基础价,显式 0 = 峰时段免费。</div>
</div>

<h2>旧数据导入</h2>
<div class="section">
<div class="import-tools">
  <div><label for="dataImportFile">data.json 文件</label><input type="file" id="dataImportFile" accept="application/json,.json"></div>
  <button type="button" class="btn btn-outline" onclick="previewDataImport()">预览文件</button>
</div>
<div class="note">仅导入统计、错误和配额历史，不会覆盖当前配置。执行前必须确认每个来源方案的去向。</div>
<div class="import-preview" id="dataImportPreview">
  <div class="import-summary" id="dataImportSummary"></div>
  <div id="dataImportMappings"></div>
  <div class="row" style="margin-top:14px">
    <div><label for="dataImportMode">导入方式</label><select id="dataImportMode" onchange="toggleImportPassword()"><option value="merge">合并现有数据</option><option value="replace">替换全部请求数据</option></select></div>
    <div id="dataImportPasswordWrap" style="display:none"><label for="dataImportPassword">后台密码</label><input type="password" id="dataImportPassword" autocomplete="current-password" placeholder="替换模式需要验证密码"></div>
  </div>
  <div style="display:flex;justify-content:flex-end;margin-top:12px"><button type="button" class="btn btn-primary" onclick="applyDataImport()">执行导入</button></div>
  <div class="inline-status" id="dataImportStatus" role="status"></div>
</div>
</div>

<h2>统计数据清理</h2>
<div class="section">
  <div class="note" style="margin-top:0;margin-bottom:12px">清理数据库中已删除用户或模型的残留统计数据，不影响 config.json 配置。孤儿数据（已不在配置中的 Key 或模型）以淡红色高亮，可优先清理。每次删除前自动创建本地备份。</div>
  <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap">
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      <button type="button" class="btn btn-outline btn-sm cleanup-tab on" data-t="users" onclick="switchCleanupTab('users')">用户统计残留 <span id="cleanupUserCount" style="color:var(--dim);font-weight:400">0</span></button>
      <button type="button" class="btn btn-outline btn-sm cleanup-tab" data-t="models" onclick="switchCleanupTab('models')">模型统计残留 <span id="cleanupModelCount" style="color:var(--dim);font-weight:400">0</span></button>
    </div>
    <button type="button" class="btn btn-outline btn-sm" onclick="loadCleanupList()">刷新列表</button>
  </div>
  <div id="cleanupUsersView">
    <table>
      <thead><tr><th>虚拟 Key（脱敏）</th><th>名称</th><th class="n">请求数</th><th>最后活跃</th><th style="width:80px">配置</th><th style="width:70px">操作</th></tr></thead>
      <tbody id="cleanupUsersBody"><tr><td colspan="6" style="color:var(--dim);text-align:center;padding:18px">点击「刷新列表」加载数据</td></tr></tbody>
    </table>
  </div>
  <div id="cleanupModelsView" hidden>
    <table>
      <thead><tr><th>模型</th><th class="n">请求数</th><th class="n">Token 数</th><th style="width:70px">操作</th></tr></thead>
      <tbody id="cleanupModelsBody"><tr><td colspan="4" style="color:var(--dim);text-align:center;padding:18px">点击「刷新列表」加载数据</td></tr></tbody>
    </table>
  </div>
  <div class="inline-status" id="cleanupStatus" role="status"></div>
</div>

<h2>通知设置</h2>
<div class="section">
  <div class="note" style="margin-bottom:10px">系统自动事件推送到你的群或手机。覆盖事件——故障：方案被限流、failover 自动切换、熔断开启；恢复：组头恢复接管、熔断关闭。同一故障方案只推送一条告警，真正恢复才推送一条恢复，期间重复事件静默。</div>
  <label style="display:flex;align-items:center;gap:6px;margin-bottom:8px;cursor:pointer"><input type="checkbox" id="notifEnabled" style="width:auto;accent-color:var(--accent)"><span style="font-size:12.5px">启用通知推送</span></label>
  <label style="display:flex;align-items:center;gap:6px;margin-bottom:10px;cursor:pointer"><input type="checkbox" id="notifRecovery" style="width:auto;accent-color:var(--accent)"><span style="font-size:12.5px">同时推送恢复事件（关闭则只收故障告警）</span></label>
  <div class="row" style="grid-template-columns:1fr 1fr;gap:10px">
    <div><label>飞书机器人 Webhook</label><input type="text" id="notifFeishu" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..." style="font-family:var(--font-mono);font-size:11px"></div>
    <div><label>钉钉机器人 Webhook</label><input type="text" id="notifDingtalk" placeholder="https://oapi.dingtalk.com/robot/send?access_token=..." style="font-family:var(--font-mono);font-size:11px"></div>
    <div><label>企业微信机器人 Webhook</label><input type="text" id="notifWecom" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=..." style="font-family:var(--font-mono);font-size:11px"></div>
    <div><label>Server酱 SendKey</label><input type="text" id="notifServerchan" placeholder="SCT..." style="font-family:var(--font-mono);font-size:11px"></div>
    <div><label>Bark Device Key</label><input type="text" id="notifBarkKey" placeholder="iOS 装 Bark 后复制的 Key" style="font-family:var(--font-mono);font-size:11px"></div>
    <div><label> Bark 自建服务器（可选）</label><input type="text" id="notifBarkServer" placeholder="https://api.day.app" style="font-family:var(--font-mono);font-size:11px"></div>
  </div>
  <div style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <label style="font-size:12px;color:var(--dim)">同类事件冷却</label>
    <input type="number" id="notifInterval" min="0" max="86400" step="30" style="width:90px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:4px;font-size:12px">
    <span style="font-size:12px;color:var(--dim)">秒</span>
    <span style="flex:1"></span>
    <button type="button" class="btn btn-outline btn-sm" onclick="testNotifier()">发送测试通知</button>
    <button type="button" class="btn btn-primary btn-sm" onclick="saveNotifier()">保存通知设置</button>
  </div>
  <div class="inline-status" id="notifStatus" role="status"></div>
</div>

<h2 style="color:var(--red)">危险操作</h2>
<div class="section danger-section">
  <div class="danger-copy"><div><strong>清空全部数据</strong><div class="note" style="margin:0">清除方案、用户、密钥、配额、统计、错误和导入记录。系统端口、后台密码与代理参数会保留，执行前自动创建备份。</div></div><button type="button" class="btn btn-danger" id="dataClearButton" onclick="openDataClearModal()">清空全部数据</button></div>
</div>
</div>

<div id="quotaPoolView" hidden aria-hidden="true">
<h2>额度池 <span style="font-size:12px;color:var(--dim);font-weight:400">同一上游套餐的多个方案放进同一个池，用量从同一份额度扣；在此处维护池级限额与每人配额</span></h2>
<div class="section" id="quotaPoolSection">
<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
  <button type="button" class="btn btn-outline btn-sm" onclick="togglePoolCreate()">＋ 新建额度池</button>
  <span id="poolCreateRow" style="display:none;gap:6px;align-items:center">
    <input type="text" id="newPoolName" placeholder="池名称，如：GLM 套餐池" style="width:220px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:5px;font-size:12px">
    <button type="button" class="btn btn-primary btn-sm" onclick="createPool()">创建</button>
  </span>
  <span class="note" style="margin:0">先建空池，再到各方案编辑页把方案并入。同一上游套餐的方案应放进同一个池。</span>
</div>
${(() => {
  const pools = s.quotaPools || [];
  if (!pools.length) return '<div class="note">暂无额度池。</div>';
  return pools.map(p => {
    const shared = p.profiles.length > 1;
    const empty = p.profiles.length === 0;
    const memberChips = p.profiles.map(m => `<span class="tag" style="background:rgba(0,0,0,.04);color:${m.protocol === "responses" ? "var(--blue)" : "var(--accent)"}">${escHtml(m.name)}${m.protocol === "responses" ? " · Codex" : " · Claude Code"}</span>`).join(" ");
    const memberKeys = Object.keys(p.memberUsers || {});
    const repSuffix = p.profiles[0]?.suffix || "";
    const rows = memberKeys.map(k => {
      const mu = p.memberUsers[k];
      const lim = mu.dailyTokenLimit ?? null;
      return `<tr>
<td><code style="font-size:11px;color:var(--accent)">${escHtml(k)}</code></td>
<td>${escHtml(mu.username)}</td>
<td style="width:160px"><input type="number" data-pool="${escHtml(p.name)}" data-user="${escHtml(k)}" value="${lim ?? ""}" min="0" step="100000" placeholder="跟随池级" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:4px;font-size:12px" title="留空=跟随池级限额"></td>
<td><button type="button" class="btn btn-outline btn-sm" onclick="openQuotaOpFromPool('${escJs(repSuffix)}','${escJs(k)}')" style="font-size:11px;padding:2px 8px;white-space:nowrap">临时额度</button></td>
</tr>`;
    }).join("");
    return `<div data-poolcard="${escHtml(p.name)}" style="border:1px solid ${shared ? "#e5b8b2" : empty ? "#eadfc3" : "var(--border)"};border-radius:6px;padding:14px 16px;margin-bottom:12px;background:${shared ? "#fffdfc" : "var(--surface)"}${empty ? ";opacity:.85" : ""}">
  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px">
    <div><b style="font-size:14px">${escHtml(p.label)}</b> <span style="color:var(--dim);font-size:11px">（池 key: ${escHtml(p.name)}）</span>
    ${shared ? `<span class="tag" style="background:rgba(180,35,24,.08);color:var(--red)">${p.profiles.length} 个方案共用</span>` : ''}
    ${empty ? `<span class="tag" style="background:#faf5e6;color:var(--orange)">无成员方案</span>` : ''}</div>
    <div style="display:flex;align-items:center;gap:8px">
      <button type="button" class="btn btn-outline btn-sm" onclick="renamePoolLabel('${escJs(p.name)}','${escJs(p.label)}')" title="修改显示名（池 key 不变，方案绑定不受影响）">重命名</button>
      <label style="font-size:12px;color:var(--dim);margin:0">池级每日限额</label>
      <input type="number" data-poollimit="${escHtml(p.name)}" value="${p.dailyTokenLimit ?? ""}" min="0" step="100000" placeholder="不限制" style="width:150px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:4px;font-size:12px">
      ${empty ? `<button type="button" class="btn btn-danger btn-sm" onclick="deletePool('${escJs(p.name)}')" title="删除此空池及其配额配置">删除</button>` : `<button type="button" class="btn btn-outline btn-sm" disabled title="先在方案编辑页把成员移到其他池，空池才能删除">删除</button>`}
    </div>
  </div>
  ${empty
    ? '<div class="note" style="margin-bottom:0">尚无成员方案 —— 到各方案的编辑页，在「额度池」下拉中选择本池即可将其并入。</div>'
    : `<div style="margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap">${memberChips}</div>
  ${rows ? `<table style="min-width:auto;margin:0"><thead><tr><th>虚拟 Key</th><th>成员</th><th>每日配额（留空=跟随池级）</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="note">本池还没有成员用户——成员用户是在各方案里分配了真实 Key 的用户。</div>'}`}
  <div style="margin-top:10px;display:flex;justify-content:flex-end"><button type="button" class="btn btn-primary btn-sm" onclick="savePoolQuota('${escJs(p.name)}')">保存「${escHtml(p.label)}」</button></div>
</div>`;
  }).join("");
})()}
<div class="note">池级限额对所有未单独设限的成员生效；每人配额优先于池级限额。留空 = 跟随池级（或池级也不限则不限）。池的归属在方案编辑页「额度池」下拉中调整，方案移出后若池变空会自动清理；倍率仍在方案里配置。</div>
</div>
</div>

<div id="auditLogView" hidden aria-hidden="true">
<div class="note" style="margin-bottom:12px">记录全部管理操作、系统自动事件（failover 切换/恢复、熔断、限流、自动配额调整）与成员动作（每日签到、加量申请），按类型筛选互不混杂。最多保留最近 3000 条；「清空全部数据」不会删除审计记录。</div>
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
  <div class="seg" id="auditFilter" role="group" aria-label="日志类型筛选">
    <button type="button" class="on" data-cat="" onclick="switchAuditFilter('')">全部</button>
    <button type="button" data-cat="admin" onclick="switchAuditFilter('admin')">管理操作</button>
    <button type="button" data-cat="system" onclick="switchAuditFilter('system')">系统事件</button>
    <button type="button" data-cat="auth" onclick="switchAuditFilter('auth')">认证事件</button>
    <button type="button" data-cat="checkin" onclick="switchAuditFilter('checkin')">签到记录</button>
    <button type="button" data-cat="request" onclick="switchAuditFilter('request')">加量申请</button>
  </div>
  <button type="button" class="btn btn-outline btn-sm" onclick="loadAuditLog(true)">刷新</button>
  <span class="inline-status" id="auditStatus" role="status"></span>
</div>
<div class="section" style="padding:0;overflow-x:auto">
  <table>
    <thead><tr><th style="width:150px">时间</th><th style="width:70px">角色</th><th style="width:140px">操作</th><th style="width:170px">对象</th><th>详情</th><th style="width:110px">IP</th></tr></thead>
    <tbody id="auditBody"><tr><td colspan="6" style="color:var(--dim);text-align:center;padding:18px">打开本页时自动加载</td></tr></tbody>
  </table>
</div>
<div style="display:flex;justify-content:center;margin-top:12px">
  <button type="button" class="btn btn-outline btn-sm" id="auditMoreBtn" onclick="loadMoreAudit()" hidden>加载更多</button>
</div>
</div>

<div id="quotaRequestView" hidden aria-hidden="true">
<div class="note" style="margin-bottom:12px">成员从「我的用量」页发起的加量申请（每人每天限提交 1 次，提交不占用次数；每周处理上限在「签到与加量申请」设置中配置）。「发放加量」将奖励以当日临时加量发到其指定的额度池（明日自动失效），并自动标记该申请为已处理；驳回时可留一句备注，成员在其页面可见。</div>
<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
  <div class="seg" id="qrFilter" role="group" aria-label="申请状态筛选">
    <button type="button" class="on" data-st="pending" onclick="qrSwitchFilter('pending')">待处理</button>
    <button type="button" data-st="" onclick="qrSwitchFilter('')">全部</button>
    <button type="button" data-st="handled" onclick="qrSwitchFilter('handled')">已加量</button>
    <button type="button" data-st="rejected" onclick="qrSwitchFilter('rejected')">已驳回</button>
  </div>
  <button type="button" class="btn btn-outline btn-sm" onclick="loadQuotaRequests(true)">刷新</button>
  <span class="inline-status" id="qrStatus" role="status"></span>
</div>
<div class="section" style="padding:0;overflow-x:auto">
  <table>
    <thead><tr><th style="width:150px">时间</th><th style="width:110px">成员</th><th style="width:130px">额度池</th><th>理由</th><th style="width:80px">状态</th><th style="width:230px">操作 / 处理备注</th></tr></thead>
    <tbody id="qrBody"><tr><td colspan="6" style="color:var(--dim);text-align:center;padding:18px">打开本页时自动加载</td></tr></tbody>
  </table>
</div>
</div>

<div class="modal-overlay" id="qrGrantModal">
<div class="modal" style="max-width:470px">
<div class="modal-hd"><h3>发放加量 · <span id="qrGrantUser"></span></h3><button class="modal-close" onclick="closeQrGrant()">关闭</button></div>
<div class="modal-body">
<div class="note" id="qrGrantReason" style="margin-bottom:12px"></div>
<input type="hidden" id="qrGrantId">
<div style="margin-bottom:12px"><label>发放到额度池</label><select id="qrGrantPool" style="width:100%"></select></div>
<div><label>加量数量（token）</label><input type="number" id="qrGrantAmount" min="1" step="1000" placeholder="如 500000" style="width:100%;box-sizing:border-box"><span class="note">以当日临时加量发放，明日自动失效，与签到奖励累加</span></div>
<div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">
<button type="button" class="btn btn-outline btn-sm" onclick="closeQrGrant()">取消</button>
<button type="button" class="btn btn-primary btn-sm" id="qrGrantSubmit" onclick="submitQrGrant()">发放并标记已处理</button>
</div>
</div>
</div>
</div>
</div>
</div>
<div class="modal-overlay" id="userModal">
<div class="modal">
<div class="modal-hd"><h3>用户管理</h3><button class="modal-close" onclick="closeUserModal()">关闭</button></div>
<div class="modal-body">
<h4 style="font-size:13px;color:var(--accent);margin:0 0 8px">全局用户信息</h4>
<div style="overflow-x:auto">
<table id="globalUsersTable" style="min-width:780px">
<thead><tr><th>虚拟 Key</th><th>用户名称</th><th style="width:160px">失效时间</th><th style="width:80px">全局禁用</th><th style="width:80px">超级用户</th><th style="width:70px">操作</th></tr></thead>
<tbody>${globalUserRows}</tbody>
</table>
</div>
<div style="margin:12px 0 4px;display:flex;gap:8px;align-items:center">
<button type="button" class="btn btn-outline btn-sm" onclick="addGlobalUser()">添加用户</button>
<span class="note">虚拟Key自动生成（jx-开头24位随机码），点击可复制。失效时间留空=永不过期。</span>
</div>
<h4 style="font-size:13px;color:var(--accent);margin:16px 0 8px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
<span>方案真实Key分配 <span style="font-size:11px;color:var(--dim);font-weight:400">（按方案独立授权）</span></span>
<select id="userProfileSel" onchange="switchUserProfile(this.value)" style="width:auto;min-width:200px;max-width:100%;flex:0 1 auto;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:4px;font-size:12px">
${s.profiles.map(p => `<option value="${escHtml(p.suffix)}" ${p.suffix === initialSuffix ? "selected" : ""}>${escHtml(p.name)} /${escHtml(p.suffix)}${p.isDefault ? " · 默认入口" : ""}</option>`).join("")}
</select>
</h4>
<div style="overflow-x:auto">
<table id="profileUsersTable">
<thead><tr><th>虚拟 Key</th><th>用户名称</th><th>真实 Key</th><th style="width:80px">方案禁用</th></tr></thead>
<tbody>${profileUserRows}</tbody>
</table>
</div>
<div class="note" style="margin-top:6px">全局禁用的用户灰色显示。真实Key必填才能使用此方案。</div>
</div>
<div style="flex-shrink:0;display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--border);background:var(--surface);border-radius:0 0 8px 8px">
<button type="button" class="btn btn-outline btn-sm" onclick="closeUserModal()">取消</button>
<button type="button" class="btn btn-primary btn-sm" onclick="saveUsers()">保存全部</button>
</div>
</div>
</div>
<div class="modal-overlay" id="quotaOpModal">
<div class="modal" style="max-width:540px">
<div class="modal-hd"><h3 id="qoTitle">临时额度</h3><button class="modal-close" onclick="closeQuotaOpModal()">关闭</button></div>
<div class="modal-body">
<div id="qoInfo" style="font-size:12px;color:var(--dim);margin-bottom:10px"></div>
<div id="qoStatus" style="margin-bottom:10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap"></div>
<label style="font-size:12px">今日临时加量（token 数，0 = 清除；只今天生效，明日自动失效，不改动永久每日配额）</label>
<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0 2px">
<input type="number" id="qoBonusInput" min="0" step="10000" placeholder="0" style="width:150px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:4px;font-size:12px">
<button type="button" class="btn btn-outline btn-sm" onclick="qoQuickAdd(100000)" style="font-size:11px">+10万</button>
<button type="button" class="btn btn-outline btn-sm" onclick="qoQuickAdd(500000)" style="font-size:11px">+50万</button>
<button type="button" class="btn btn-outline btn-sm" onclick="qoQuickAdd(1000000)" style="font-size:11px">+100万</button>
</div>
<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;flex-wrap:wrap">
<button type="button" class="btn btn-outline btn-sm" id="qoClearBtn" onclick="qoClear()">撤销今日手工操作</button>
<button type="button" class="btn btn-outline btn-sm" id="qoResetBtn" onclick="qoReset()">重置今日用量</button>
<button type="button" class="btn btn-primary btn-sm" id="qoSetBtn" onclick="qoSetBonus()">设置临时加量</button>
</div>
<div class="note" style="margin-top:8px">重置后该用户配额立即恢复满额，可继续使用；用量统计与报表数据保留不动。以上操作均只对当日（北京时间）生效。</div>
</div>
</div>
</div>
<div class="modal-overlay" id="profileModal">
<div class="modal" style="max-width:640px">
<div class="modal-hd"><h3>新增方案</h3><button class="modal-close" onclick="closeProfileModal()">关闭</button></div>
<div class="modal-body">
<div class="row">
<div><label>方案名称<span class="req">*</span></label><input type="text" id="newProfileName" placeholder="如: GLM 项目组"></div>
<div><label>URL 后缀<span class="req">*</span></label><input type="text" id="newProfileSuffix" placeholder="如: glm"></div>
</div>
<label>接口协议<span class="req">*</span></label>
<select id="newProfileProtocol" onchange="updateNewProfileProtocolHint()" style="font-family:var(--font-body)">
<option value="anthropic">Anthropic Messages — Claude Code</option>
<option value="responses">OpenAI Responses — Codex</option>
</select>
<div class="note" id="newProfileProtocolNote">Claude Code 走 /v1/messages；Codex 走 /v1/responses。两种协议的方案完全隔离。</div>
<label>上游 API 地址<span class="req">*</span></label><input type="text" id="newProfileUpstream" value="${escHtml(initialProfile.upstream || s.upstream || "")}" placeholder="https://open.bigmodel.cn/api/anthropic">
<div id="newProfileResponsesPathBlock" style="display:none">
<label>Responses 出站端点</label><input type="text" id="newProfileResponsesPath" value="/v1/responses" placeholder="/v1/responses 或 /responses">
<div class="note">默认 /v1/responses；热点：火山 Coding Plan 是 /responses。</div>
</div>
<label>所属额度池</label>
<select id="newProfilePool">
  <option value="">＋ 新建额度池（与方案同名，独立额度）</option>
  ${(s.quotaPools || []).map(p => `<option value="${escHtml(p.name)}">${escHtml(p.label)}（${p.profiles.length} 个方案共用额度）</option>`).join("")}
</select>
<div class="note">同一上游套餐的多个方案（如 Claude Code 与 Codex 各一个）应选同一个池，用量合并计入同一份额度。</div>
<div class="note">模型别名在创建后进入方案编辑页配置（允许模型由别名目标自动生成，无需手填）。未配置别名的方案会拒绝所有请求。</div>
<div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
<button type="button" class="btn btn-outline btn-sm" onclick="closeProfileModal()">取消</button>
<button type="button" class="btn btn-primary btn-sm" onclick="createProfile()">创建方案</button>
</div>
</div>
</div>
</div>
<div class="modal-overlay" id="dataClearModal">
<div class="modal" style="max-width:480px">
<div class="modal-hd"><h3>确认清空全部数据</h3><button class="modal-close" onclick="closeDataClearModal()">关闭</button></div>
<div class="modal-body">
  <div style="font-size:13px;line-height:1.65">此操作会删除所有方案、用户、密钥、配额和请求历史。系统会先创建本地备份，但当前配置将立即进入未配置状态。</div>
  <label for="dataClearPassword">后台密码</label>
  <input type="password" id="dataClearPassword" autocomplete="current-password" placeholder="输入后台密码以确认">
  <div class="inline-status" id="dataClearStatus" role="status"></div>
  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button type="button" class="btn btn-outline" onclick="closeDataClearModal()">取消</button><button type="button" class="btn btn-danger" onclick="clearAllData()">确认清空</button></div>
</div>
</div>
</div>
<script src="${assets.url("ui.js")}"><\/script>
<script>
const SETTINGS=${settingsJson};
// Manual ops keyed by pool → user key (an op on the pool affects every member
// profile, so the badge lookup must follow the pool, not the profile).
const QUOTA_OPS_BY_POOL=${quotaOpsJson};
const NOTIFIER_CFG=${JSON.stringify(config.notifier || {}).replace(/</g, "\\x3c")};
const PAGE_CSRF="${CSRF_TOKEN}";
const QUOTA_RATE_MAX=${QUOTA_RATE_MAX};
let editingProfileName="${escJs(initialProfile.name || '')}";
const INITIAL_PROD=${JSON.stringify({ productionTracking: Object.assign({ enabled: true, storeFilePaths: true }, config.productionTracking || {}), costRates: config.costRates || DEFAULT_COST_RATES }).replace(/</g, "\\x3c")};
</script>
<script src="${assets.url("settings.js")}"><\/script>
</body></html>`;
}

export function dashboardHtml(d) {
  const { assets } = d;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2096%2096%22%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2222%22%20fill%3D%22%232f6e50%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fbfbf8%22%20stroke-width%3D%2213%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate(48%2048)%20scale(0.88)%20translate(-48%20-48)%22%3E%3Cpath%20d%3D%22M37%2026.5H31.5Q20.5%2026.5%2020.5%2037.5V58.5Q20.5%2069.5%2031.5%2069.5H37%22%2F%3E%3Cpath%20d%3D%22M59%2026.5H64.5Q75.5%2026.5%2075.5%2037.5V58.5Q75.5%2069.5%2064.5%2069.5H59%22%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2248%22%20r%3D%226.2%22%20fill%3D%22%23fbfbf8%22%2F%3E%3C%2Fsvg%3E">
<title>团队AI Coding监控</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<link rel="stylesheet" href="${assets.url("theme.css")}">
<link rel="stylesheet" href="${assets.url("dashboard.css")}"></head><body data-theme="editorial-light">
<main class="dashboard-shell">
<header class="command-bar">
  <div class="command-brand"><svg class="brand-logo" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="#2f6e50"/><g fill="none" stroke="#fbfbf8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" transform="translate(48 48) scale(0.9) translate(-48 -48)"><path d="M37 26.5H31.5Q20.5 26.5 20.5 37.5V58.5Q20.5 69.5 31.5 69.5H37"/><path d="M59 26.5H64.5Q75.5 26.5 75.5 37.5V58.5Q75.5 69.5 64.5 69.5H59"/></g><circle cx="48" cy="48" r="4.95" fill="#fbfbf8"/></svg><span class="brand-mark">CC Team</span><h1 class="command-title">团队用量</h1><span class="command-status"><span class="led on"></span>监控服务运行中</span><span class="meta" id="meta">正在加载数据</span></div>
  <div class="controls"><select id="profileSel" aria-label="查看方案" onchange="switchProfileView(this.value)"><option value="">全部方案</option></select><a href="/settings">设置</a><button id="autoRefreshBtn" class="ar-on">自动刷新：开</button><button onclick="fetch('/api/logout',{method:'POST',headers:{'x-csrf-token':(document.cookie.match(/tm_csrf=([^;]+)/)||[])[1]||''}}).then(()=>toastThen('已退出登录',()=>location.reload()))">退出</button></div>
</header>
<section class="metric-strip" id="cards" aria-label="用量摘要"></section>
<section class="chart-filters" aria-label="图表筛选">
  <div class="proto-seg" id="protoSeg" role="group" aria-label="协议分类">
    <button type="button" class="on" data-proto="">全部</button><button type="button" data-proto="anthropic">Anthropic</button><button type="button" data-proto="responses">OpenAI</button>
  </div>
  <div class="tabs" id="globalTabs" aria-label="统计周期">
    <button class="tab on" data-p="day">按日</button><button class="tab" data-p="week">按周</button><button class="tab" data-p="month">按月</button><button class="tab" data-p="year">按年</button>
  </div>
  <div class="detail-field"><label for="metricSel">指标</label><select id="metricSel"><option value="tokens">Token</option><option value="requests">请求数</option></select></div>
  <div class="detail-field"><label for="modelSel">模型</label><select id="modelSel"><option value="all">全部模型</option></select></div>
  <div class="detail-field"><label for="userSel">用户</label><select id="userSel"><option value="all">全部用户</option></select></div>
  <div class="detail-field chart-date"><label for="dateStart">开始日期</label><input type="date" id="dateStart" onchange="onDateRangeChange()"></div>
  <div class="detail-field chart-date"><label for="dateEnd">结束日期</label><input type="date" id="dateEnd" onchange="onDateRangeChange()"></div>
  <button type="button" class="detail-reset" onclick="resetChartFilters()">重置</button>
  <span class="chart-filter-hint" id="chartFilterHint">日期范围对 24 小时图不生效；模型/用户筛选对部分图表不适用；按模型筛选时不含缓存 Token</span>
</section>
<section class="chart-workspace" aria-label="用量图表">
  <div class="chart-panel chart-trend"><div class="chart-head"><h2>Token 用量趋势</h2><span class="chart-note" id="trendNote"></span></div><div class="chart-canvas"><canvas id="trend"></canvas></div></div>
  <div class="chart-panel chart-users"><div class="chart-head"><h2>用户分布</h2></div><div class="chart-canvas"><canvas id="pie"></canvas></div></div>
  <div class="chart-panel chart-models"><div class="chart-head"><h2>模型请求分布</h2></div><div class="chart-canvas"><canvas id="modelChart"></canvas></div></div>
  <div class="chart-panel chart-hourly"><div class="chart-head"><h2>24 小时趋势</h2></div><div class="chart-canvas"><canvas id="hourChart"></canvas></div></div>
  <div class="chart-panel chart-hmodel"><div class="chart-head"><h2>24 小时模型使用趋势</h2></div><div class="chart-canvas"><canvas id="hourModelChart"></canvas></div></div>
  <div class="chart-panel chart-profile"><div class="chart-head"><h2>方案请求情况</h2><span class="chart-note" id="profileNote"></span></div><div class="chart-canvas"><canvas id="profileChart"></canvas></div></div>
</section>
<section class="data-workspace" aria-label="数据工作区">
  <div class="workspace-tabs" role="tablist" aria-label="数据视图">
    <button id="workspace-tab-users" role="tab" aria-controls="workspace-panel-users" aria-selected="true" tabindex="0" class="workspace-tab">用户用量<span class="workspace-tab-count" id="workspaceCountUsers">0</span></button>
    <button id="workspace-tab-detail" role="tab" aria-controls="workspace-panel-detail" aria-selected="false" tabindex="-1" class="workspace-tab">明细记录<span class="workspace-tab-count" id="workspaceCountDetail">0</span></button>
    <button id="workspace-tab-profiles" role="tab" aria-controls="workspace-panel-profiles" aria-selected="false" tabindex="-1" class="workspace-tab">方案中心<span class="workspace-tab-count" id="workspaceCountProfiles">0</span></button>
    <button id="workspace-tab-rates" role="tab" aria-controls="workspace-panel-rates" aria-selected="false" tabindex="-1" class="workspace-tab">配额倍率<span class="workspace-tab-count" id="workspaceCountRates">0</span></button>
    <button id="workspace-tab-errors" role="tab" aria-controls="workspace-panel-errors" aria-selected="false" tabindex="-1" class="workspace-tab">错误记录<span class="workspace-tab-count" id="workspaceCountErrors">0</span></button>
    <button id="workspace-tab-production" role="tab" aria-controls="workspace-panel-production" aria-selected="false" tabindex="-1" class="workspace-tab">产出质量<span class="workspace-tab-count" id="workspaceCountProd">0</span></button>
    <button id="workspace-tab-costs" role="tab" aria-controls="workspace-panel-costs" aria-selected="false" tabindex="-1" class="workspace-tab">等值成本</button>
  </div>
  <div class="workspace-content">
    <section id="workspace-panel-users" role="tabpanel" aria-labelledby="workspace-tab-users" class="workspace-panel active"><div class="workspace-panel-inner">
      <div class="workspace-panel-head" id="userQuotaHead" hidden><strong>用户用量</strong><button type="button" class="q-focus-btn" id="qFocusBtn" onclick="toggleQuotaFocus()" title="隐藏 Token 统计列，只看各方案配额占用">只看配额</button><span class="workspace-panel-summary" id="userQuotaContext"></span></div>
      <div class="workspace-panel-scroll"><table id="uTable"><thead>
      <tr id="uTableHead"><th>用户</th><th>状态</th><th class="n">请求数</th><th class="n">输入</th><th class="n">输出</th><th class="n">缓存写入</th><th class="n">缓存命中</th><th class="n">合计</th><th class="n">今日</th><th class="n">配额</th><th>最后活跃</th></tr>
    </thead><tbody></tbody></table></div></div></section>
    <section id="workspace-panel-detail" role="tabpanel" aria-labelledby="workspace-tab-detail" class="workspace-panel" hidden><div id="detailSec">
      <div class="workspace-panel-head"><span class="sec-toggle open" id="detailSecIcon"></span><strong>明细记录</strong><span class="sec-hint" id="detailHint"></span></div><div class="sec-body open" id="detailSecBody">
      <div class="detail-tools">
        <div class="detail-field detail-search"><label for="detailQuery">用户</label><input type="search" id="detailQuery" placeholder="搜索用户名或虚拟 Key" oninput="updateDetailFilters()"></div>
        <div class="detail-field"><label for="detailRange">时间范围</label><select id="detailRange" onchange="updateDetailFilters()"><option value="all">全部</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option></select></div>
        <div class="detail-field"><label for="detailSort">周期排序</label><select id="detailSort" onchange="updateDetailFilters()"><option value="time">最新优先</option><option value="tokens">Token 高到低</option><option value="requests">请求数高到低</option></select></div>
        <button type="button" class="detail-reset" id="detailReset" onclick="resetDetailFilters()">重置</button>
      </div>
      <div class="detail-table-wrap"><table id="dTable"><thead><tr><th class="detail-sticky">周期 / 用户</th><th class="n">请求数</th><th class="n">输入</th><th class="n">输出</th><th class="n">缓存写入</th><th class="n">缓存命中</th><th class="n">合计</th></tr></thead><tbody></tbody></table></div><div class="detail-pages" id="detailPages"></div>
      </div></div>
    </section>
    <section id="workspace-panel-profiles" role="tabpanel" aria-labelledby="workspace-tab-profiles" class="workspace-panel" hidden><div id="profileSummarySec" class="workspace-panel-inner">
      <div class="workspace-panel-head"><strong>方案中心</strong><span class="workspace-panel-summary" id="profileContext">当前查看：全部方案</span></div><div class="workspace-panel-scroll"><table><thead><tr><th>方案</th><th>入口</th><th>上游</th><th class="n">今日请求</th><th class="n">今日用量</th><th>状态</th></tr></thead><tbody id="profileSummaryBody"></tbody></table></div>
    </div></section>
    <section id="workspace-panel-rates" role="tabpanel" aria-labelledby="workspace-tab-rates" class="workspace-panel" hidden><div class="workspace-panel-inner">
      <div class="workspace-panel-head"><strong>配额倍率</strong><span class="workspace-panel-summary" id="rateBoardContext"></span></div>
      <div class="workspace-panel-scroll">
        <div class="rate-cards" id="rateBoardCards"></div>
        <details class="rate-detail" id="rateBoardDetail">
          <summary>配置明细<span class="rate-detail-hint">每 方案×模型 的峰/谷倍率与今日实际、计入</span></summary>
          <div class="rate-detail-body">
            <table id="rateBoardTable"><thead><tr><th>模型</th><th>方案</th><th>别名</th><th>峰/谷</th><th class="n">今日实际</th><th class="n">今日计入</th><th class="n">今日请求</th></tr></thead><tbody id="rateBoardBody"></tbody></table>
          </div>
        </details>
      </div>
    </div></section>
    <section id="workspace-panel-errors" role="tabpanel" aria-labelledby="workspace-tab-errors" class="workspace-panel" hidden><div id="errorSec">
      <div class="workspace-panel-head"><span class="sec-toggle" id="errorSecIcon"></span><strong>错误记录</strong><span id="errorCount" style="font-size:10px;color:var(--red)"></span><span class="workspace-panel-summary" id="errorHint">暂无错误</span><button id="clearErrors" class="clear-btn">清除</button></div>
      <div class="sec-body" id="errorSecBody"><table id="eTable"><thead><tr><th>时间</th><th>用户</th><th class="n">状态码</th><th>模型</th><th>路径</th><th>错误信息</th></tr></thead><tbody></tbody></table><div id="errPages" style="padding:8px 12px;text-align:right"></div></div>
    </div></section>
    <section id="workspace-panel-production" role="tabpanel" aria-labelledby="workspace-tab-production" class="workspace-panel" hidden><div class="workspace-panel-inner">
      <div class="workspace-panel-head"><strong>产出质量</strong><select id="prodRangeSel" onchange="loadProduction()"><option value="today">今日</option><option value="7d" selected>近7天</option><option value="30d">近30天</option></select><a id="prodReportLink" href="/api/production/report?range=7d" target="_blank" style="font-size:11px;color:var(--accent)">导出报告</a><span class="workspace-panel-summary" id="prodSummary"></span><a id="prodMetricHelp" style="font-size:11px;color:var(--accent);cursor:pointer">指标口径</a></div>
      <div id="prodMetricHelpBody" style="display:none;padding:6px 12px;font-size:11px;color:var(--dim)">失败率:编辑失败占比 · 重写率:每写10行删几行 · 验证密度:每次编辑的验证命令数 · token/行:每行产出的输出token(仅对比用)</div>
      <div class="workspace-panel-scroll">
        <table id="prodTable"><thead><tr><th>成员</th><th class="n" title="新增行−删除行;衡量实际沉淀的代码量">净产出</th><th class="n" title="去重后的改动文件数">文件</th><th class="n" title="AI 编辑失败占比;持续偏高=上下文过时或库太大。参考区间:&lt;10% 正常,≥30% 关注">失败率</th><th class="n" title="每写10行删几行;高=反复推倒。参考区间:&lt;30% 健康,≥80% 大面积回滚">重写率</th><th class="n" title="每次编辑配套的 test/lint 命令数;0=从不验证。参考区间:0.1-0.8 健康">验证密度</th><th class="n" title="净产出每行的输出token;成本效率,仅做横向对比与自身趋势,无绝对好坏">token/行</th><th class="n" title="空转/错误循环/失败爆发三类(见下方告警面板)">告警</th></tr></thead><tbody></tbody></table>
        <div id="prodZero" style="padding:6px 12px;font-size:11px;color:var(--orange)"></div>
        <div id="prodDetail" style="padding:8px 12px;display:none"></div>
        <div class="workspace-panel-head" style="border-top:1px solid var(--border)"><strong title="按会话自动识别的项目(仓库根聚类)">项目分布</strong></div>
        <table id="projTable"><thead><tr><th>项目</th><th class="n">成员</th><th class="n">文件</th><th class="n">净产出</th></tr></thead><tbody></tbody></table>
        <div class="workspace-panel-head" style="border-top:1px solid var(--border)"><strong title="规则见设置;峰值 token/同类错误/失败率触发">空转 / 循环告警</strong><button type="button" class="detail-reset" onclick="markProdAlerts()" style="margin-left:auto">全部已读</button></div>
        <table id="prodAlertTable"><thead><tr><th>时间</th><th>成员</th><th>类型</th><th>说明</th></tr></thead><tbody></tbody></table>
      </div>
    </div></section>
    <section id="workspace-panel-costs" role="tabpanel" aria-labelledby="workspace-tab-costs" class="workspace-panel" hidden><div class="workspace-panel-inner">
      <div class="workspace-panel-head"><strong>等值成本</strong><span id="costPeakBadge"></span><select id="costRangeSel" onchange="loadCosts()"><option value="today">今日</option><option value="7d" selected>近7天</option><option value="30d">近30天</option></select><span class="workspace-panel-summary" id="costSummary"></span></div>
      <div class="workspace-panel-scroll">
        <div class="note" style="padding:6px 12px;margin-top:0;text-align:left;font-size:11px;color:var(--dim)">按参考牌价(USD/1M tokens)折算,非实际账单;高峰时段按高峰价、其余按基础价;缓存部分按日表混合折算。未配置价格的模型计 0 并列出。</div>
        <table id="costTable"><thead><tr><th>成员</th><th>方案</th><th class="n">模型成本</th><th class="n">缓存成本</th><th class="n">合计</th></tr></thead><tbody></tbody></table>
        <div id="unpricedNote" style="padding:4px 12px;font-size:11px;color:var(--orange)"></div>
      </div>
    </div></section>
  </div>
</section>
</main>
<script src="${assets.url("ui.js")}"><\/script>
<script src="${assets.url("dashboard.js")}"><\/script>
</body></html>`;
}

export function loginHtml(d) {
  const { assets } = d;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2096%2096%22%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2222%22%20fill%3D%22%232f6e50%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fbfbf8%22%20stroke-width%3D%2213%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate(48%2048)%20scale(0.88)%20translate(-48%20-48)%22%3E%3Cpath%20d%3D%22M37%2026.5H31.5Q20.5%2026.5%2020.5%2037.5V58.5Q20.5%2069.5%2031.5%2069.5H37%22%2F%3E%3Cpath%20d%3D%22M59%2026.5H64.5Q75.5%2026.5%2075.5%2037.5V58.5Q75.5%2069.5%2064.5%2069.5H59%22%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2248%22%20r%3D%226.2%22%20fill%3D%22%23fbfbf8%22%2F%3E%3C%2Fsvg%3E">
<title>登录 - CC Team</title>
<link rel="stylesheet" href="${assets.url("theme.css")}">
<link rel="stylesheet" href="${assets.url("login.css")}"></head><body data-theme="editorial-light">
<div class="wrap">
<div class="brand brand-row"><svg class="brand-logo" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="#2f6e50"/><g fill="none" stroke="#fbfbf8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" transform="translate(48 48) scale(0.9) translate(-48 -48)"><path d="M37 26.5H31.5Q20.5 26.5 20.5 37.5V58.5Q20.5 69.5 31.5 69.5H37"/><path d="M59 26.5H64.5Q75.5 26.5 75.5 37.5V58.5Q75.5 69.5 64.5 69.5H59"/></g><circle cx="48" cy="48" r="4.95" fill="#fbfbf8"/></svg><div><div class="t">CC Team</div><div class="s">团队 AI 编码用量网关</div></div></div>
<div class="term">
<div class="hd">登录管理后台</div>
<div class="err" id="err">密码错误，请重试。</div>
<label>访问密码</label>
<input type="password" id="pw" placeholder="••••••••" autofocus>
<button onclick="doLogin()">登录</button>
</div></div>
<script src="${assets.url("ui.js")}"><\/script>
<script>
document.getElementById("pw").addEventListener("keydown",e=>{if(e.key==="Enter")doLogin()});
async function doLogin(){const pw=document.getElementById("pw").value;const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw})});if(r.ok){window.location.reload()}else{document.getElementById("err").style.display="block"}}
<\/script></body></html>`;
}

export function personalUsageLandingHtml(d) {
  const { assets } = d;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2096%2096%22%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2222%22%20fill%3D%22%232f6e50%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fbfbf8%22%20stroke-width%3D%2213%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate(48%2048)%20scale(0.88)%20translate(-48%20-48)%22%3E%3Cpath%20d%3D%22M37%2026.5H31.5Q20.5%2026.5%2020.5%2037.5V58.5Q20.5%2069.5%2031.5%2069.5H37%22%2F%3E%3Cpath%20d%3D%22M59%2026.5H64.5Q75.5%2026.5%2075.5%2037.5V58.5Q75.5%2069.5%2064.5%2069.5H59%22%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2248%22%20r%3D%226.2%22%20fill%3D%22%23fbfbf8%22%2F%3E%3C%2Fsvg%3E">
<title>我的用量</title>
<link rel="stylesheet" href="${assets.url("theme.css")}">
<link rel="stylesheet" href="${assets.url("landing.css")}"></head><body data-theme="editorial-light">
<div class="wrap">
<div class="brand brand-row"><svg class="brand-logo" width="38" height="38" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="#2f6e50"/><g fill="none" stroke="#fbfbf8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" transform="translate(48 48) scale(0.9) translate(-48 -48)"><path d="M37 26.5H31.5Q20.5 26.5 20.5 37.5V58.5Q20.5 69.5 31.5 69.5H37"/><path d="M59 26.5H64.5Q75.5 26.5 75.5 37.5V58.5Q75.5 69.5 64.5 69.5H59"/></g><circle cx="48" cy="48" r="4.95" fill="#fbfbf8"/></svg><div><div class="t">我的用量</div><div class="s">输入虚拟 Key 查看个人配额与消耗。</div></div></div>
<div class="term">
<div class="hd">查询个人用量</div>
<label>虚拟 Key</label>
<input type="text" id="key" placeholder="jx-xxxxxxxx" autofocus>
<button onclick="go()">查看用量</button>
<div class="note">或直接访问 <code>/usage/你的虚拟Key</code></div>
</div></div>
<script>
document.getElementById('key').addEventListener('keydown',e=>{if(e.key==='Enter')go()});
function go(){const k=document.getElementById('key').value.trim();if(k)location.href='/my-usage?key='+encodeURIComponent(k)}
</script></body></html>`;
}

export function codexSetupHtml(d, virtualKey, state, catalog) {
  const { config, assets } = d;
  const key = virtualKey || "";
  const cat = catalog || { entries: [], json: '{\n  "models": []\n}', defaultModel: "" };
  const banner = state === "invalid"
    ? `<div style="background:#fff2f0;border:1px solid #f1c8c2;color:var(--red);padding:10px 14px;border-radius:6px;margin-bottom:16px;font-size:13px">该 Key 不存在——请检查链接里的虚拟 Key 是否完整。</div>`
    : state === "no-profile"
    ? `<div style="background:#fff7e6;border:1px solid #ffe1a6;color:#a1662f;padding:10px 14px;border-radius:6px;margin-bottom:16px;font-size:13px">该 Key 尚未分配到任何 Responses(Codex) 方案——请联系管理员在设置页为其分配后再来配置。</div>`
    : "";
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2096%2096%22%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2222%22%20fill%3D%22%232f6e50%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fbfbf8%22%20stroke-width%3D%2213%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate(48%2048)%20scale(0.88)%20translate(-48%20-48)%22%3E%3Cpath%20d%3D%22M37%2026.5H31.5Q20.5%2026.5%2020.5%2037.5V58.5Q20.5%2069.5%2031.5%2069.5H37%22%2F%3E%3Cpath%20d%3D%22M59%2026.5H64.5Q75.5%2026.5%2075.5%2037.5V58.5Q75.5%2069.5%2064.5%2069.5H59%22%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2248%22%20r%3D%226.2%22%20fill%3D%22%23fbfbf8%22%2F%3E%3C%2Fsvg%3E">
<title>Codex 接入配置 - 团队AI Coding监控</title>
<link rel="stylesheet" href="${assets.url("theme.css")}">
<link rel="stylesheet" href="${assets.url("codex-setup.css")}"></head><body data-theme="editorial-light">
<div class="top"><div class="top-brand"><svg class="brand-logo" width="40" height="40" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="#2f6e50"/><g fill="none" stroke="#fbfbf8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" transform="translate(48 48) scale(0.9) translate(-48 -48)"><path d="M37 26.5H31.5Q20.5 26.5 20.5 37.5V58.5Q20.5 69.5 31.5 69.5H37"/><path d="M59 26.5H64.5Q75.5 26.5 75.5 37.5V58.5Q75.5 69.5 64.5 69.5H59"/></g><circle cx="48" cy="48" r="4.95" fill="#fbfbf8"/></svg><div><h1>Codex 接入配置</h1><div class="sub">把你的 Codex 指向团队网关 — 三种方式任选其一</div></div></div></div>
${banner}
<div class="host-row"><span>服务器地址：</span><span style="color:var(--dim)" id="schemeLabel">http://</span><input id="hostInput" value="" oninput="renderAll()" spellcheck="false"><code>自动取自当前访问地址（含 https），可修改</code>${cat.entries.length ? ` <code>可用模型：${cat.entries.map(e => e.slug).join(" / ")}（来自方案配置的别名）</code>` : ""}</div>
<div class="tabs">
  <button class="on" data-tab="script" onclick="setTab('script')">一键脚本</button>
  <button data-tab="manual" onclick="setTab('manual')">手动配置</button>
  <button data-tab="ccswitch" onclick="setTab('ccswitch')">cc-switch 用户</button>
</div>
<div class="panel on" id="panel-script">
  <div class="box"><h3>macOS / Linux — 在「终端」执行</h3>
    <pre><button class="copy-btn" onclick="copyPre(this)">复制</button><code id="curlCmd"></code></pre>
  </div>
  <div class="box"><h3>Windows — 在 PowerShell 执行</h3>
    <pre><button class="copy-btn" onclick="copyPre(this)">复制</button><code id="psCmd"></code></pre>
  </div>
  <div class="box"><h3>执行后</h3>
    <ol>
      <li>脚本会自动备份并更新 <code>~/.codex/config.toml</code>、写入 <code>~/.codex/models.json</code>（Windows 为 <code>%USERPROFILE%\.codex</code>）</li>
      <li><strong>完全退出 Codex（macOS: Cmd+Q）再重新打开</strong>，即可使用</li>
    </ol>
    <div class="note">脚本只管理 ccteam 相关配置，你已有的其他 provider / 项目配置全部保留；重复执行安全；结束时打印本次操作摘要与回滚方法。</div>
  </div>
</div>
<div class="panel" id="panel-manual">
  <div class="box"><h3>① 追加到 ~/.codex/config.toml 顶部（若已有同名键则替换）</h3>
    <pre style="max-height:300px;overflow:auto"><button class="copy-btn" onclick="copyPre(this)">复制</button><code id="tomlBlock"></code></pre>
  </div>
  <div class="box"><h3>② 另存为 ~/.codex/models.json</h3>
    <pre style="max-height:300px;overflow:auto"><button class="copy-btn" onclick="copyPre(this)">复制</button><code id="modelsJson"></code></pre>
    <div class="note">保存后完全退出 Codex（Cmd+Q）重新打开。</div>
  </div>
</div>
<div class="panel" id="panel-ccswitch">
  <div class="box"><h3>在 cc-switch 中添加自定义供应商</h3>
    <ol>
      <li>cc-switch → Codex → Add Provider → 自定义</li>
      <li>把下面的 TOML 粘贴进供应商配置（name 可自定，字段保留）：</li>
    </ol>
    <pre style="max-height:260px;overflow:auto"><button class="copy-btn" onclick="copyPre(this)">复制</button><code id="tomlBlock2"></code></pre>
    <div class="warn">注意：cc-switch 切换供应商时会重写 config.toml。请把 <code>model_catalog_json = "~/.codex/models.json"</code>${cat.defaultModel ? ` 与 <code>model = "${cat.defaultModel}"</code>` : ""} 放进它的「Shared Config Snippet / 公共配置」；且切换到 ccteam 后需确认这几个顶层键仍然存在，models.json 也要按「手动配置」页准备一次。</div>
  </div>
</div>
<script>
const KEY=${JSON.stringify(key)};
const MODELS=${JSON.stringify(cat.json)};
const DEFAULT_MODEL=${JSON.stringify(cat.defaultModel)};
</script>
<script src="${assets.url("codex-setup.js")}"><\/script>
</body></html>`;
}

export function personalUsageHtml(d, virtualKey) {
  const { assets } = d;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2096%2096%22%3E%3Crect%20width%3D%2296%22%20height%3D%2296%22%20rx%3D%2222%22%20fill%3D%22%232f6e50%22%2F%3E%3Cg%20fill%3D%22none%22%20stroke%3D%22%23fbfbf8%22%20stroke-width%3D%2213%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%20transform%3D%22translate(48%2048)%20scale(0.88)%20translate(-48%20-48)%22%3E%3Cpath%20d%3D%22M37%2026.5H31.5Q20.5%2026.5%2020.5%2037.5V58.5Q20.5%2069.5%2031.5%2069.5H37%22%2F%3E%3Cpath%20d%3D%22M59%2026.5H64.5Q75.5%2026.5%2075.5%2037.5V58.5Q75.5%2069.5%2064.5%2069.5H59%22%2F%3E%3C%2Fg%3E%3Ccircle%20cx%3D%2248%22%20cy%3D%2248%22%20r%3D%226.2%22%20fill%3D%22%23fbfbf8%22%2F%3E%3C%2Fsvg%3E">
<title>我的用量 - 团队AI Coding监控</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<link rel="stylesheet" href="${assets.url("theme.css")}">
<link rel="stylesheet" href="${assets.url("my-usage.css")}"></head><body data-theme="editorial-light">
<div class="top"><div class="top-brand"><svg class="brand-logo" width="40" height="40" viewBox="0 0 96 96" aria-hidden="true"><rect width="96" height="96" rx="22" fill="#2f6e50"/><g fill="none" stroke="#fbfbf8" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" transform="translate(48 48) scale(0.9) translate(-48 -48)"><path d="M37 26.5H31.5Q20.5 26.5 20.5 37.5V58.5Q20.5 69.5 31.5 69.5H37"/><path d="M59 26.5H64.5Q75.5 26.5 75.5 37.5V58.5Q75.5 69.5 64.5 69.5H59"/></g><circle cx="48" cy="48" r="4.95" fill="#fbfbf8"/></svg><div><h1>我的用量</h1><div class="sub">查看个人配额、趋势和模型明细 · <a href="/setup/${escJs(virtualKey)}" style="color:var(--accent)">配置 Codex 接入 →</a></div></div></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><div class="proto-seg" id="protoSeg" role="group" aria-label="协议分类"><button type="button" class="on" data-proto="">全部</button><button type="button" data-proto="anthropic">Anthropic</button><button type="button" data-proto="responses">OpenAI</button></div><select id="profileSel" onchange="switchProfile(this.value)"><option value="all">全部可用方案</option></select><button type="button" id="qrBtn" class="qr-open-btn" style="display:none" onclick="openQrModal()">申请加量</button></div></div>
<div class="meta" id="meta">加载中...</div>
<div id="qNotice"></div>
<div class="checkin-bar" id="checkinBar"></div>
<div class="cards" id="cards"></div>
<div id="pqSection" style="display:none"><h3 style="font-size:13px;font-weight:650;margin:0 0 10px">各方案配额 <span style="font-size:11px;color:var(--dim);font-weight:400" id="pqHint"></span></h3><div class="pq-grid" id="pqGrid"></div></div>
<div class="box" id="calendarBox" style="display:none"><h3>使用日历 <span style="font-size:11px;color:var(--dim);font-weight:400">过去一年 · 颜色代表每日输入+输出总量，悬浮查看明细</span></h3><div class="cal-summary" id="calSummary"></div><div class="cal-row"><div class="cal-daylabels"><i>一</i><i></i><i>三</i><i></i><i>五</i><i></i><i></i></div><div class="cal-main"><div class="cal-scroll"><div class="cal-inner"><div class="cal-months" id="calMonths"></div><div class="cal-grid" id="calGrid"></div></div></div></div></div><div class="cal-legend">少 <span class="cal-cell" style="background:#e9e9e3"></span><span class="cal-cell" style="background:#cfe3d7"></span><span class="cal-cell" style="background:#9dc4ab"></span><span class="cal-cell" style="background:#5f9a7a"></span><span class="cal-cell" style="background:#2f6e50"></span> 多</div></div>
<div class="chart-row">
<div class="box"><h3>今日24小时趋势</h3><canvas id="hourChart"></canvas></div>
<div class="box"><h3>近7天趋势</h3><canvas id="trendChart"></canvas></div>
</div>
<div class="box" id="prodProfile"><h3>产出画像 <span style="font-size:11px;color:var(--dim);font-weight:400">仅自己可见 · 只统计指标,不存储代码</span></h3><div id="prodMeMetrics" class="cards" style="margin-bottom:8px"></div><div id="prodMeTrend" style="font-size:11px;color:var(--dim);margin-top:6px"></div><div id="prodMeLangs" style="font-size:11px;margin-top:4px"></div></div>
<div class="cal-tip" id="calTip"></div>
<div class="modal-overlay" id="qrModal" onclick="if(event.target===this)closeQrModal()"><div class="qr-modal" role="dialog" aria-label="申请加量"><div class="qr-mhd"><b>申请加量</b><button type="button" class="qr-close" onclick="closeQrModal()" aria-label="关闭">✕</button></div><div class="qr-mbody"><div class="qr-info" id="qrQuotaInfo"></div><div id="qrHistory"></div><div class="qr-form"><label>申请额度池 <i>*</i></label><select id="qrPool"></select><label>申请理由 <i>*</i></label><textarea id="qrReason" maxlength="200" rows="3" placeholder="说明一下用途和期望，管理员处理时会看到"></textarea></div><div class="qr-actions"><button type="button" class="btn-checkin" id="qrSubmit" onclick="submitQuotaRequest()">提交申请</button></div></div></div></div>
<div class="box"><h3>今日模型请求</h3><table id="modelTable"><thead><tr><th>模型</th><th class="n">请求数</th><th class="n">实际 Token</th><th class="n">倍率</th><th class="n">计入配额</th></tr></thead><tbody></tbody></table><div class="note" id="modelTableNote" style="font-size:11px;color:var(--dim);margin-top:8px"></div></div>
<div class="box" id="rateCardBox" style="display:none"><h3>配额价目表 <span style="font-size:11px;color:var(--dim);font-weight:400">当前时段每个模型消耗 1 token 扣多少额度</span></h3><div id="rateCardBody"></div></div>
<script src="${assets.url("ui.js")}"><\/script>
<script>
const VK='${escJs(virtualKey)}';
</script>
<script src="${assets.url("my-usage.js")}"><\/script>
</body></html>`;
}
