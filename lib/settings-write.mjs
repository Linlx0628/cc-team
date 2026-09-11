// lib/settings-write.mjs —— 设置写路径: 表单解析、审计快照/差异、applySettings,
// 旧版导入预览/映射、内存状态清理、重置为未配置态。
// 从 server.mjs 抽出(零缩进逐字搬移)。依赖经 createSettingsWriter 工厂注入,
// 其中 initDb 阶段后才就绪的(let 声明)用 getter 延迟读取。

export function createSettingsWriter(d) {
  const {
    normalizePeakHours,
    normalizeQuotaRate,
    normalizeCacheReadQuotaRate,
    normalizeModelQuotaRates,
    QUOTA_POOL_NAME_MAX,
    normalizeQuotaPoolName,
    saveConfig,
    normalizeProfileProtocol,
    normalizeProfileSuffix,
    validateProfileSuffix,
    normalizeModelAliases,
    parseModelAliasesInput,
    getDefaultProfileName,
    getProfileNameBySuffix,
    listProfiles,
    reloadAllRuntimes,
    normalizeLegacyImportData,
    legacyImportHash,
    summarizeLegacyImport,
    setMeta,
    maskAuditKey,
    config,
    dashboardPassword,
    gProxy,
    userConcurrent,
    userRateBucket,
    ipRateBucket,
    db,
    port,
    resolvePoolName
  } = d;

function parseFormBody(body) {
  const params = new URLSearchParams(body);
  const data = {};
  for (const [k, v] of params) {
    // Support repeated keys as array (not needed for settings, but safe)
    if (k in data) {
      if (!Array.isArray(data[k])) data[k] = [data[k]];
      data[k].push(v);
    } else {
      data[k] = v;
    }
  }
  return data;
}

// ── Settings audit: snapshot before applySettings, diff after ────────────────
function settingsAuditSnapshot() {
  return {
    proxy: JSON.stringify(config.proxy || {}),
    autoQuotaAdjust: JSON.stringify(config.autoQuotaAdjust || {}),
    checkIn: JSON.stringify(config.checkIn || {}),
    quotaRequest: JSON.stringify(config.quotaRequest || {}),
    users: JSON.stringify(Object.fromEntries(Object.entries(config.users || {}).map(([k, v]) => [maskAuditKey(k), v]))),
    profiles: Object.fromEntries(Object.entries(config.profiles || {}).map(([n, p]) => [n, JSON.stringify(p)])),
  };
}

function jsonChangedKeys(beforeJson, afterJson) {
  const before = JSON.parse(beforeJson || "{}");
  const after = JSON.parse(afterJson || "{}");
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changed.push(k);
  }
  return changed;
}

function settingsAuditDiff(snap, now) {
  const parts = [];
  let target = "";
  const profileNames = new Set([...Object.keys(snap.profiles), ...Object.keys(now.profiles)]);
  for (const name of profileNames) {
    const a = snap.profiles[name], b = now.profiles[name];
    if (a === b) continue;
    const changed = jsonChangedKeys(a, b);
    parts.push(`方案 "${name}"${changed.length ? `(${changed.join(", ")})` : ""}`);
    // Quota rates silently re-price everyone's effective allowance, so spell the
    // old→new values out instead of leaving just a field name in the log.
    const rateText = quotaRateChangeText(a, b);
    if (rateText) parts.push(`方案 "${name}" 配额倍率：${rateText}`);
    if (!target) target = name;
  }
  const proxyChanged = jsonChangedKeys(snap.proxy, now.proxy);
  if (proxyChanged.length) parts.push(`全局代理(${proxyChanged.join(", ")})`);
  const quotaChanged = jsonChangedKeys(snap.autoQuotaAdjust, now.autoQuotaAdjust);
  if (quotaChanged.length) parts.push(`自动配额(${quotaChanged.join(", ")})`);
  if (snap.users !== now.users) parts.push("全局用户配置");
  return { target, text: parts.join("；") };
}

function quotaRateChangeText(beforeJson, afterJson) {
  let before, after;
  try { before = JSON.parse(beforeJson || "{}"); after = JSON.parse(afterJson || "{}"); }
  catch { return ""; }
  const bits = [];
  for (const [field, label] of [["peakQuotaRate", "峰"], ["offPeakQuotaRate", "谷"]]) {
    const b = normalizeQuotaRate(before[field]), a = normalizeQuotaRate(after[field]);
    if (b !== a) bits.push(`${label} ${b}→${a}`);
  }
  const cb = normalizeCacheReadQuotaRate(before.cacheReadQuotaRate), ca = normalizeCacheReadQuotaRate(after.cacheReadQuotaRate);
  if (cb !== ca) bits.push(`缓存命中计入 ${cb}→${ca}`);
  // Per-model overrides: report added / removed / changed models by name, since a
  // bare "modelQuotaRates" field name tells the reader nothing about the impact.
  const mb = normalizeModelQuotaRates(before.modelQuotaRates), ma = normalizeModelQuotaRates(after.modelQuotaRates);
  for (const model of new Set([...Object.keys(mb), ...Object.keys(ma)])) {
    const x = mb[model], y = ma[model];
    if (!x && y) bits.push(`${model} 新增 峰 ${y.peak}/谷 ${y.offPeak}`);
    else if (x && !y) bits.push(`${model} 取消单独定价（回落默认）`);
    else if (x && y && (x.peak !== y.peak || x.offPeak !== y.offPeak)) {
      bits.push(`${model} 峰 ${x.peak}→${y.peak}/谷 ${x.offPeak}→${y.offPeak}`);
    }
  }
  return bits.join(" / ");
}

function applySettings(formData) {
  const isGlobalOnlySave = !formData.profileName && !formData.profileSuffix && formData.upstream === undefined;
  const editingProfileName = formData.profileName || getProfileNameBySuffix(formData.profileSuffix) || getDefaultProfileName();
  const editingProfile = config.profiles[editingProfileName];
  if (!editingProfile) throw new Error(`Profile "${editingProfileName}" not found`);

  if (formData.upstream && formData.upstream !== editingProfile.upstream) {
    if (!/^https?:\/\/[^\s]+/.test(formData.upstream)) throw new Error("Invalid upstream URL");
    editingProfile.upstream = formData.upstream.trim();
    console.log(`[CONFIG] Upstream updated: ${editingProfile.upstream}`);
  }

  // Responses outbound endpoint segment (default "/v1/responses"). Only
  // meaningful for responses-protocol profiles; the form hides the field for
  // anthropic profiles, so absence here means "don't touch".
  if (formData.responsesPath !== undefined && normalizeProfileProtocol(editingProfile.protocol) === "responses") {
    const v = String(formData.responsesPath).trim().replace(/\/+$/, "");
    editingProfile.responsesPath = v ? (v.startsWith("/") ? v : `/${v}`) : undefined;
  }

  if (formData.suffix !== undefined) {
    const nextSuffix = validateProfileSuffix(formData.suffix, editingProfileName);
    const oldSuffix = editingProfile.suffix;
    if (nextSuffix !== oldSuffix) {
      editingProfile.suffix = nextSuffix;
      // Rename the profile column across all usage tables.
      for (const table of ["users", "usage_daily", "usage_daily_model", "usage_daily_hourly", "usage_hourly_model", "usage_model", "usage_hourly", "errors"]) {
        db.prepare(`UPDATE ${table} SET profile = ? WHERE profile = ?`).run(nextSuffix, oldSuffix);
      }
    }
  }

  // Update proxy settings with range validation (global)
  if (formData.timeout) gProxy.timeout = Math.max(10000, Math.min(600000, parseInt(formData.timeout, 10) || 180000));
  if (formData.streamTimeout) gProxy.streamTimeout = Math.max(60000, Math.min(1800000, parseInt(formData.streamTimeout, 10) || 600000));
  if (formData.maxRetries !== undefined) gProxy.maxRetries = Math.max(0, Math.min(10, parseInt(formData.maxRetries, 10) || 3));
  if (formData.retryDelay) gProxy.retryDelay = Math.max(100, Math.min(30000, parseInt(formData.retryDelay, 10) || 1000));
  if (formData.maxConcurrentPerUser) gProxy.maxConcurrentPerUser = Math.max(1, Math.min(50, parseInt(formData.maxConcurrentPerUser, 10) || 5));
  if (formData.rateLimitPerMinute) gProxy.rateLimitPerMinute = Math.max(1, Math.min(600, parseInt(formData.rateLimitPerMinute, 10) || 60));
  if (formData.circuitBreakerFailures) gProxy.circuitBreakerFailures = Math.max(1, Math.min(50, parseInt(formData.circuitBreakerFailures, 10) || 5));
  if (formData.circuitBreakerCooldown) gProxy.circuitBreakerCooldown = Math.max(1000, Math.min(300000, parseInt(formData.circuitBreakerCooldown, 10) || 30000));

  // Pool assignment (profile form only). "__new__" creates a same-named pool so a
  // profile can always be given an independent allowance by splitting it off.
  if (!isGlobalOnlySave && formData.quotaPool !== undefined) {
    const chosen = String(formData.quotaPool);
    const prevPool = normalizeQuotaPoolName(editingProfile.quotaPool);
    if (chosen === "__new__") {
      let name = normalizeQuotaPoolName(editingProfileName) || "pool";
      for (let i = 2; config.quotaPools[name]; i++) name = `${normalizeQuotaPoolName(editingProfileName)}-${i}`.slice(0, QUOTA_POOL_NAME_MAX);
      config.quotaPools[name] = { label: editingProfileName, dailyTokenLimit: null, users: {} };
      editingProfile.quotaPool = name;
    } else if (config.quotaPools[chosen]) {
      editingProfile.quotaPool = chosen;
    }
    // Auto-clean the vacated pool: once no profile draws from it, its limits are
    // dead config — exactly the leftover a merge leaves behind (GLM-CodeX moved
    // into the GLM pool, the old same-named pool would linger forever otherwise).
    const newPool = normalizeQuotaPoolName(editingProfile.quotaPool);
    if (prevPool && prevPool !== newPool && config.quotaPools[prevPool]) {
      const stillUsed = Object.keys(config.profiles).some(p => resolvePoolName(p) === prevPool);
      if (!stillUsed) {
        delete config.quotaPools[prevPool];
        console.log(`[QuotaPool] 方案 "${editingProfileName}" 移出后池 "${prevPool}" 已无成员，自动删除`);
      }
    }
  }

  // Update billing type (display label, drives no logic)
  if (!isGlobalOnlySave && formData.billingType && ["coding_plan", "token_plan", "on_demand"].includes(formData.billingType)) {
    editingProfile.billingType = formData.billingType;
  }

  // Update peak hours (recurring daily ranges; drive peak aliases + quota rates)
  if (!isGlobalOnlySave && formData.peakStart !== undefined) {
    const starts = [].concat(formData.peakStart);
    const ends = [].concat(formData.peakEnd);
    editingProfile.peakHours = normalizePeakHours(starts.map((s, i) => ({ start: s, end: ends[i] })));
  }

  // Update quota rates (weighting applied to future requests only)
  if (!isGlobalOnlySave && formData.peakQuotaRate !== undefined) {
    editingProfile.peakQuotaRate = normalizeQuotaRate(formData.peakQuotaRate);
  }
  if (!isGlobalOnlySave && formData.offPeakQuotaRate !== undefined) {
    editingProfile.offPeakQuotaRate = normalizeQuotaRate(formData.offPeakQuotaRate);
  }
  // Cache-hit quota share (Responses/Codex profiles only): 0 = cache hits free
  // (mirror Anthropic — default), 1 = legacy full billing. Absent from the form
  // submit → leave the profile's setting untouched.
  if (!isGlobalOnlySave && formData.cacheReadQuotaRate !== undefined) {
    editingProfile.cacheReadQuotaRate = normalizeCacheReadQuotaRate(formData.cacheReadQuotaRate);
  }
  // Per-model rate rows: mr_model_N / mr_peak_N / mr_off_N, gated on the hidden
  // mrPresent marker so a submit that deleted every row still clears the overrides
  // (row keys alone would be absent and the old map would survive).
  if (!isGlobalOnlySave && formData.mrPresent !== undefined) {
    const rates = {};
    for (let i = 0; formData["mr_model_" + i] !== undefined; i++) {
      const model = String(formData["mr_model_" + i] || "").trim();
      if (!model) continue;   // unselected row — silently skipped
      rates[model] = {
        peak: normalizeQuotaRate(formData["mr_peak_" + i]),
        offPeak: normalizeQuotaRate(formData["mr_off_" + i]),
      };
    }
    editingProfile.modelQuotaRates = rates;
  }

  // Update auto quota adjustment settings
  if (!config.autoQuotaAdjust) config.autoQuotaAdjust = {};
  config.autoQuotaAdjust.enabled = formData.autoQuotaEnabled === "on";
  if (formData.aqPeriod) config.autoQuotaAdjust.evaluationPeriodDays = Math.max(3, parseInt(formData.aqPeriod, 10) || 5);
  if (formData.aqHitThreshold) config.autoQuotaAdjust.hitThreshold = Math.min(1, Math.max(0.5, (parseInt(formData.aqHitThreshold, 10) || 90) / 100));
  if (formData.aqTriggerRate) config.autoQuotaAdjust.triggerRate = Math.min(1, Math.max(0.3, (parseInt(formData.aqTriggerRate, 10) || 90) / 100));
  if (formData.aqIncreaseFactor) config.autoQuotaAdjust.increaseFactor = 1 + (parseInt(formData.aqIncreaseFactor, 10) || 15) / 100;
  if (formData.aqSafetyFactor) config.autoQuotaAdjust.safetyFactor = (parseInt(formData.aqSafetyFactor, 10) || 130) / 100;
  if (formData.aqMaxIncrease) config.autoQuotaAdjust.maxIncreaseFactor = Math.max(1.1, parseFloat(formData.aqMaxIncrease) || 2.0);
  if (formData.aqMaxQuota) config.autoQuotaAdjust.maxAutoQuota = parseInt(formData.aqMaxQuota, 10) || 10000000;
  if (formData.aqCooldown) config.autoQuotaAdjust.cooldownDays = Math.max(1, parseInt(formData.aqCooldown, 10) || 3);
  setMeta("lastQuotaEval", ""); // Reset eval date so new config takes effect immediately

  // Check-in reward range & quota-request weekly cap (member gamification).
  // These live ONLY on the 全局数据管理 (global) form. Unchecked boxes submit
  // nothing, so absence means OFF — but only for a global save. isGlobalOnlySave
  // separates the two settings forms: the profile form (#settingsForm) carries
  // profileName and must never clobber these toggles, otherwise saving any
  // profile setting silently disables 每日签到 and 加量申请.
  if (isGlobalOnlySave) {
    if (!config.checkIn) config.checkIn = {};
    config.checkIn.enabled = formData.checkInEnabled === "on";
    const ciMin = parseInt(formData.checkInMin, 10);
    const ciMax = parseInt(formData.checkInMax, 10);
    if (Number.isFinite(ciMin) && ciMin >= 0) config.checkIn.minTokens = ciMin;
    if (Number.isFinite(ciMax) && ciMax >= 0) config.checkIn.maxTokens = Math.max(ciMax, config.checkIn.minTokens || 0);
    if (!config.quotaRequest) config.quotaRequest = {};
    config.quotaRequest.enabled = formData.quotaRequestEnabled === "on";
    const qrWk = parseInt(formData.quotaRequestWeeklyLimit, 10);
    if (Number.isFinite(qrWk) && qrWk >= 0 && qrWk <= 1000) config.quotaRequest.weeklyLimit = qrWk;
  }

  // Restrict default-group members to /v1 only (block direct /<suffix>/... access).
  // Default ON (undefined → enabled) to prevent bypassing failover to on-demand profiles.
  // The toggle persists itself instantly via /api/restrict-group-suffix; neither
  // settings form carries it anymore, so only apply it when a form actually
  // submitted the field (otherwise a global save would silently flip it off).
  if (formData.restrictGroupSuffix !== undefined) config.restrictGroupSuffix = formData.restrictGroupSuffix === "on";

  // Update retryable status codes
  if (formData.retryableStatusCodes) {
    gProxy.retryableStatusCodes = formData.retryableStatusCodes
      .split(",")
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n));
  }

  // ── 模型别名（结构化行编辑器）────────────────────────────────────────────
  // 通用别名必填：行字段 ma_alias_N / ma_model_N / ma_ctx_N；至少 1 行完整、别名唯一。
  // 高峰覆盖行 pa_alias_N / pa_model_N（可选，别名来自通用别名集合）。
  // allowedModels 不再接受手填，完全由别名目标派生。
  const hasAliasRows = Object.keys(formData).some(k => /^ma_alias_\d+$/.test(k));
  if (hasAliasRows) {
    const aliases = {};
    const contextWindows = {};
    const multimodal = {};
    for (let i = 0; formData["ma_alias_" + i] !== undefined || formData["ma_model_" + i] !== undefined; i++) {
      const alias = String(formData["ma_alias_" + i] || "").trim();
      const model = String(formData["ma_model_" + i] || "").trim();
      if (!alias && !model) continue;   // blank row
      if (!alias || !model) throw new Error(`第 ${i + 1} 行别名配置不完整：别名与实际模型都必须填写`);
      if (aliases[alias]) throw new Error(`别名 "${alias}" 重复，每行别名必须唯一`);
      aliases[alias] = model;
      const cw = parseInt(formData["ma_ctx_" + i], 10);
      contextWindows[alias] = Number.isFinite(cw) && cw > 0 ? cw : 128000;
      multimodal[alias] = formData["ma_mm_" + i] === "on";
    }
    if (Object.keys(aliases).length === 0) throw new Error("至少需要配置 1 个通用模型别名（可用快捷按钮添加 jx-fable / jx-opus / jx-haiku / jx-sonnet）");
    editingProfile.modelAliases = aliases;
    editingProfile.modelContextWindows = contextWindows;
    editingProfile.modelMultimodal = multimodal;
  } else if (formData.modelAliases !== undefined) {
    // Legacy textarea path (older clients / API posts)
    const parsedAliases = parseModelAliasesInput(formData.modelAliases);
    if (Object.keys(parsedAliases).length === 0) throw new Error("至少需要配置 1 个通用模型别名");
    editingProfile.modelAliases = parsedAliases;
  }

  // Image-recognition helper model (both protocols). Access is always on —
  // non-multimodal aliases are transcribed automatically; the legacy
  // imgBridgeEnabled checkbox is ignored (kept for config compatibility).
  if (formData.imgBridgeModel !== undefined) {
    if (!editingProfile.imageBridge) editingProfile.imageBridge = { model: "" };
    editingProfile.imageBridge.model = String(formData.imgBridgeModel).trim();
    if (!editingProfile.imageBridge.model) delete editingProfile.imageBridge.model;
  }

  if (Object.keys(formData).some(k => /^pa_alias_\d+$/.test(k))) {
    const peakAliases = {};
    for (let i = 0; formData["pa_alias_" + i] !== undefined || formData["pa_model_" + i] !== undefined; i++) {
      const alias = String(formData["pa_alias_" + i] || "").trim();
      const model = String(formData["pa_model_" + i] || "").trim();
      if (!alias && !model) continue;
      if (!alias || !model) throw new Error(`高峰期第 ${i + 1} 行不完整：别名与实际模型都必须填写`);
      if (peakAliases[alias]) throw new Error(`高峰期别名 "${alias}" 重复`);
      peakAliases[alias] = model;
    }
    editingProfile.peakModelAliases = peakAliases;
  } else if (formData.peakModelAliases !== undefined) {
    editingProfile.peakModelAliases = formData.peakModelAliases.trim()
      ? parseModelAliasesInput(formData.peakModelAliases)
      : {};
  }

  // allowedModels = 去重后的全部别名目标（唯一来源，不可手填）。
  // Only recomputed on profile-form saves; a global-only save carries no alias
  // fields and must not touch the profile's allowedModels.
  // NOTE: the two alias maps are merged by VALUES, not by spread — spreading
  // would let a peak alias with the same key silently drop the default target
  // from the allowed list (jx-opus=glm-5.3 + peak jx-opus=flash used to yield
  // an allowed list of just [flash], 403-ing every off-peak jx-opus request).
  if (!isGlobalOnlySave) {
    const aliasTargets = [
      ...Object.values(normalizeModelAliases(editingProfile.modelAliases || {})),
      ...Object.values(normalizeModelAliases(editingProfile.peakModelAliases || {})),
    ].filter(Boolean);
    editingProfile.allowedModels = [...new Set(aliasTargets)];
    if (editingProfile.allowedModels.length === 0) {
      throw new Error("允许模型列表为空——请先在上方配置模型别名");
    }
  }

  // Update global users
  const newGlobalUsers = {};
  for (const [k, v] of Object.entries(formData)) {
    // Existing global users: gu_un_<vk>, gu_ex_<vk>, gu_dis_<vk>, gu_su_<vk>
    if (k.startsWith("gu_un_") && !k.startsWith("gu_un_new_")) {
      const vk = k.slice(6);
      newGlobalUsers[vk] = {
        username: v || vk.slice(0, 8),
        expiresAt: formData["gu_ex_" + vk] || null,
        disabled: formData["gu_dis_" + vk] === "on",
        superUser: formData["gu_su_" + vk] === "on",
      };
    }
    // New global users: gu_new_<vk> (hidden input with vk value)
    if (k.startsWith("gu_new_") && v.trim()) {
      const vk = v.trim();
      newGlobalUsers[vk] = {
        username: formData["gu_un_new_" + vk] || vk.slice(0, 8),
        expiresAt: formData["gu_ex_new_" + vk] || null,
        disabled: formData["gu_dis_new_" + vk] === "on",
        superUser: formData["gu_su_new_" + vk] === "on",
      };
    }
  }
  if (Object.keys(newGlobalUsers).length > 0) {
    config.users = newGlobalUsers;
  }

  // Update profile users (key assignment + profile disable). Quota is NOT written
  // here — it belongs to the pool and is edited on the 额度池 page.
  const newProfileUsers = {};
  for (const [k, v] of Object.entries(formData)) {
    if (k.startsWith("pu_rk_")) {
      const vk = k.slice(6);
      const realKey = v.trim();
      if (!realKey) continue; // skip users without real key
      newProfileUsers[vk] = {
        key: realKey,
        disabled: formData["pu_dis_" + vk] === "on",
      };
    }
  }
  if (Object.keys(newProfileUsers).length > 0) {
    editingProfile.users = newProfileUsers;
  }

  // Persist to config.json
  config.proxy = { ...gProxy };
  saveConfig(config);
  reloadAllRuntimes();

  console.log(`[CONFIG] Settings saved to profile "${editingProfileName}"`);
}

function getImportPreview(raw) {
  const normalized = normalizeLegacyImportData(raw);
  const availableSuffixes = new Set(listProfiles().map((profile) => profile.suffix));
  const sourceProfiles = Object.keys(normalized.profiles).map((suffix) => ({
    suffix,
    matchedTarget: availableSuffixes.has(normalizeProfileSuffix(suffix)) ? normalizeProfileSuffix(suffix) : null,
  }));
  const warnings = sourceProfiles
    .filter((profile) => !profile.matchedTarget)
    .map((profile) => `来源方案 ${profile.suffix} 未自动匹配，请选择目标方案或跳过`);
  return { summary: summarizeLegacyImport(normalized), sourceProfiles, warnings, sourceHash: legacyImportHash(raw) };
}

function resolveImportProfileMap(normalized, requestedMap = {}) {
  const availableSuffixes = new Set(listProfiles().map((profile) => profile.suffix));
  const resolved = {};
  for (const source of Object.keys(normalized.profiles)) {
    const requested = requestedMap[source];
    if (requested === "skip" || requested === null) {
      resolved[source] = "";
      continue;
    }
    const target = normalizeProfileSuffix(requested || (availableSuffixes.has(normalizeProfileSuffix(source)) ? source : ""));
    if (!target) throw new Error(`来源方案 ${source} 尚未映射`);
    if (!availableSuffixes.has(target)) throw new Error(`目标方案 ${target} 不存在`);
    resolved[source] = target;
  }
  if (!Object.values(resolved).some(Boolean)) throw new Error("至少需要导入一个来源方案");
  return resolved;
}

function clearInMemoryRequestState() {
  for (const state of [userConcurrent, userRateBucket, ipRateBucket]) {
    for (const key of Object.keys(state)) delete state[key];
  }
}

function resetConfigToUnconfiguredState() {
  const preserved = {
    port: config.port,
    dashboardPassword: config.dashboardPassword,
    proxy: { ...(config.proxy || {}) },
  };
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, preserved, {
    users: {},
    quotaPools: {
      "默认方案": { label: "默认方案", dailyTokenLimit: null, users: {} },
    },
    profiles: {
      "默认方案": {
        suffix: "default",
        isDefault: true,
        upstream: "",
        allowedModels: [],
        modelAliases: {},
        peakModelAliases: {},
        quotaPool: "默认方案",
        users: {},
      },
    },
  });
}

  return {
    parseFormBody,
    settingsAuditSnapshot,
    settingsAuditDiff,
    applySettings,
    getImportPreview,
    resolveImportProfileMap,
    clearInMemoryRequestState,
    resetConfigToUnconfiguredState,
  };
}
