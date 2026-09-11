// lib/proxy-core.mjs —— API 代理核心: 入站请求分类与前置校验(鉴权限额/并发/限流)、候选方案
// 排序与故障转移、上游转发(非流式与流式两条路径)、上游用量与请求日志记账、工具 pattern 被
// 上游拒绝时的即时自愈、图片桥接接入点。从 server.mjs 抽出(零缩进逐字搬移)。
// 依赖经 createProxyCore 工厂注入; 客户端断开/退避/上游路径等助手与 node 内置直接 import。
// 正文唯一改动: 两处 `_rt || rt` 改为 `_rt || d.rt` —— rt 是 server 侧会被重新赋值的模块级
// let, 工厂解构会在创建时快照住旧值, 走 d.rt(getter)才与搬移前「调用时取当前值」一致。

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { addClientAbortListener, buildUpstreamPath, createClientAbortState, getApiKey, isClientAbortError, jitter, makeClientAbortError, markClientAborted, setActiveUpstreamRequest, sleepWithClientAbort, throwIfClientAborted } from "./proxy-helpers.mjs";

export function createProxyCore(d) {
  const {
    RateLimitedError,
    applyStickyReorder,
    attachRequestLogger,
    borrowProfileRealKey,
    canUseProfile,
    checkAndRecordRate,
    checkIpRateLimit,
    checkModelAllowed,
    checkTokenQuota,
    classifyInboundPath,
    classifyRateLimit,
    config,
    deleteStickyProfile,
    extractSessionSignal,
    gProxy,
    getAvailableDefaultProfiles,
    getAvailableResponsesProfiles,
    getClientIp,
    getRealKey,
    getStickyProfile,
    getUserName,
    handleLocalModelsRequest,
    isSuperUser,
    markRateLimited,
    maskAuditKey,
    mergeUsageCounters,
    modelNotAllowedMessage,
    noteFailoverServed,
    notifierApi,
    port,
    productionEnabled,
    productionTracker,
    quotaErrorDetail,
    quotaExceededMessage,
    readBody,
    recordError,
    recordUsage,
    releaseConcurrency,
    resolveModel,
    resolveProfile,
    resolveResponsesProfile,
    resolveUserKey,
    sanitizeJson,
    secondsUntilNextCnMidnight,
    sendOpenAiError,
    sendUpstream,
    setStickyProfile,
    toolPatternApi,
    tryAcquireConcurrency,
    unsupportedInboundMessage,
    usageHasTokens,
    visionApi,
  } = d;

function proxyRequest(req, res) {
  // Correlation tag: concurrent clients (Claude Code + Codex) interleave their log
  // lines in one console; every line of a request carries the same tag so the
  // interleaving can be undone by eye. Short on purpose — 2 bytes of hex.
  const reqTag = "#" + crypto.randomBytes(2).toString("hex");
  const inbound = classifyInboundPath(req.url, req.method);
  if (inbound.kind === "unsupported") {
    sendOpenAiError(res, 404, "unsupported_endpoint", unsupportedInboundMessage(inbound.reason));
    return;
  }
  if (inbound.kind === "models") {
    handleLocalModelsRequest(req, res, inbound);
    return;
  }

  // Resolve which profile this request targets, scoped to the inbound protocol.
  const protocol = inbound.kind;
  const resolvedProfile = protocol === "responses"
    ? resolveResponsesProfile(inbound, req.url)
    : resolveProfile(req.url);
  if (resolvedProfile.noResponsesProfile) {
    sendOpenAiError(res, 503, "no_responses_profile", "No responses profile configured yet. Create one in Settings to use Codex.");
    return;
  }
  if (resolvedProfile.error) {
    if (protocol === "responses") {
      sendOpenAiError(res, 404, "invalid_request", resolvedProfile.error);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: resolvedProfile.error }));
    }
    return;
  }
  const { suffix, runtime, strippedUrl } = resolvedProfile;
  if (!runtime) {
    if (protocol === "responses") {
      sendOpenAiError(res, 503, "no_responses_profile", "No responses profile configured yet. Create one in Settings to use Codex.");
    } else {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No configured proxy profile. Open Settings to configure an Anthropic upstream." }));
    }
    return;
  }
  const apiKey = getApiKey(req);

  // Request log: attach as soon as the user context exists so every
  // user-visible outcome below (403/429/5xx/proxied traffic) is captured.
  // The readBody callback enriches the holder with model / source / profile.
  const reqLog = {
    start: Date.now(),
    user: getUserName(apiKey, runtime),
    key: maskAuditKey(apiKey),
    ip: getClientIp(req),
    proto: protocol,
    src: "",
    model: "",
    profile: "",
  };

  // Cross-protocol guard: an Anthropic-protocol request must never be served by
  // a responses profile, even via direct suffix access (and vice versa above).
  if (protocol === "anthropic" && runtime.protocol !== "anthropic") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `方案 "${runtime.profileName}" 是 Responses(Codex) 方案，不能通过 /v1/messages 访问。请通过 /v1/responses 或 /${suffix}/v1/responses 使用。` }));
    recordError(apiKey, 400, `cross_protocol: /${suffix} Responses 方案收到 /v1/messages 请求`, req.url, "unknown", suffix, runtime);
    console.log(`${reqTag} [拦截] ${getUserName(apiKey, runtime)} 跨协议访问被拒 /${suffix} 是 Responses 方案`);
    return;
  }

  // Reject non-API requests (browser favicon, Chrome DevTools, etc.) before any group check.
  // These requests carry no auth header (apiKey === "unknown") and would otherwise be mis-logged
  // as "直连被拒" when the path falls through to a default-runtime group member.
  if (apiKey === "unknown") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  // Group members (default-profile-group with ≥2 entries) are reachable only via the
  // protocol's /v1 entry, which fails over across the group. Reject direct /<suffix>/...
  // access so users can't bypass failover to pin an expensive on-demand profile.
  // Super users (global user superUser=true) are exempt and may direct-connect any profile.
  const dpg = protocol === "responses"
    ? (Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup : [])
    : (Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup : []);
  const groupEntryPath = protocol === "responses" ? "/v1/responses" : "/v1/messages";
  if (config.restrictGroupSuffix !== false && !isSuperUser(apiKey, runtime) && !resolvedProfile.isDefaultEntry && dpg.length >= 2 && dpg.includes(runtime.profileName)) {
    if (protocol === "responses") {
      sendOpenAiError(res, 403, "group_member_restricted", `方案 "${runtime.profileName}" 是 Responses 方案组成员，请通过 /v1/responses 入口使用（系统按 failover 顺序自动调度）。`);
    } else {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: {
          type: "group_member_restricted",
          message: `方案 "${runtime.profileName}" 是默认方案组成员，请通过 /v1 入口使用（系统按 failover 顺序自动调度）。`
        },
        hint: "Use /v1/messages instead."
      }));
    }
    recordError(apiKey, 403, `group_member_restricted: /${suffix} 直连被拒，引导走 ${groupEntryPath}`, req.url, "unknown", suffix, runtime);
    console.log(`${reqTag} [拦截] ${getUserName(apiKey, runtime)} 直连组内方案 /${suffix} 被拒 → 引导 ${groupEntryPath}`);
    return;
  }

  const proxyStartTime = Date.now();
  let proxyPhase = "init";
  const clientState = createClientAbortState();
  clientState.tag = reqTag;
  clientState.reqLog = reqLog;
  attachRequestLogger(res, clientState, reqLog);

  // Global IP rate limit
  const clientIp = getClientIp(req);
  if (!checkIpRateLimit(clientIp)) {
    if (protocol === "responses") sendOpenAiError(res, 429, "ip_rate_limit_exceeded", "IP rate limit exceeded. Please slow down.", { "Retry-After": "60" });
    else {
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      res.end(JSON.stringify({ error: "IP rate limit exceeded. Please slow down.", type: "ip_rate_limit_exceeded" }));
    }
    recordError(apiKey, 429, `ip_rate_limit_exceeded: ${clientIp}`, req.url, "unknown", suffix, runtime);
    return;
  }

  req.on("error", (err) => {
    console.error(`${reqTag} [Socket] 客户端请求错误 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)} err=${err.message}`);
  });
  res.on("error", (err) => {
    console.error(`${reqTag} [Socket] 客户端响应错误 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)} err=${err.message}`);
    markClientAborted(clientState, "response-error");
  });
  req.on("aborted", () => {
    if (!res.writableEnded) {
      markClientAborted(clientState, "request-aborted");
      console.log(`${reqTag} [Socket] 客户端提前断开 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)} reason=request-aborted`);
    }
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      markClientAborted(clientState, "response-closed");
      console.log(`${reqTag} [Socket] 客户端提前断开 phase=${proxyPhase} elapsed=${Date.now() - proxyStartTime}ms user=${getUserName(apiKey, runtime)} reason=response-closed`);
    }
  });


  const userKey = resolveUserKey(apiKey, runtime);
  const targetUrl = strippedUrl || req.url;

  // Reject unknown API keys and users not assigned to this profile before any upstream work.
  const earlyAccess = canUseProfile(apiKey, runtime);
  if (!earlyAccess.allowed) {
    if (protocol === "responses") sendOpenAiError(res, 403, "forbidden", earlyAccess.reason);
    else {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: earlyAccess.reason }));
    }
    console.log(`[拦截] ${apiKey.slice(0, 8)}**** profile=${runtime.profileName} ${req.method} ${targetUrl} ${earlyAccess.reason}`);
    return;
  }

  readBody(req, 50_000_000).then(async (body) => {
    proxyPhase = "body-read";
    let reqModel = "unknown";
    let reqSource = "用户请求";
    let originalModel = "unknown";
    let parsedBody = null;
    try {
      const parsed = parsedBody = sanitizeJson(JSON.parse(body.toString()));
      reqModel = parsed.model || "unknown";
      originalModel = reqModel;
      if (protocol === "responses") {
        // Responses input: a trailing tool-output item marks a tool-result turn.
        const items = Array.isArray(parsed.input) ? parsed.input : [];
        const lastItem = items[items.length - 1];
        if (lastItem && typeof lastItem === "object" &&
          (lastItem.type === "function_call_output" || lastItem.type === "custom_tool_call_output" || lastItem.type === "local_shell_call_output")) {
          reqSource = "工具调用";
        }
      } else {
        // Detect request source: user input vs tool result vs subagent
        const msgs = parsed.messages || [];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === "user") {
          const content = lastMsg.content;
          if (Array.isArray(content)) {
            const hasToolResult = content.some(b => b.type === "tool_result");
            const hasText = content.some(b => b.type === "text");
            if (hasToolResult && !hasText) reqSource = "工具调用";
            else if (hasToolResult && hasText) reqSource = "用户+工具";
          }
          const sys = typeof parsed.system === "string" ? parsed.system :
            Array.isArray(parsed.system) ? parsed.system.map(b => b.text || "").join(" ") : "";
          if (sys.includes("SUBAGENT_STOP")) {
            reqSource = "子代理";
          }
        }
      }
    } catch {}

    // Enrich the request log with what only the parsed body reveals.
    reqLog.model = originalModel;
    reqLog.src = reqSource;

    // Sticky-session signal for cache-affinity routing (group entries only).
    const sessionSignal = extractSessionSignal(protocol, req.headers, parsedBody);

    // 产出质量观测:纯观察旁路,setImmediate 不阻塞代理主路径,不改请求/响应字节。
    if (parsedBody && productionEnabled()) {
      const prodUser = resolveUserKey(apiKey, runtime);
      setImmediate(() => productionTracker.observe({
        protocol, userKey: prodUser, userName: getUserName(prodUser, runtime),
        profile: runtime?.profileName || "", model: originalModel,
        session: sessionSignal || "nosession", parsed: parsedBody,
      }));
    }

    // Save the pre-resolve body so each failover candidate can re-resolve the model
    // against its own modelAliases.
    const originalBody = body;

    // Build the ordered candidate list. Default-group entries fail over across
    // the whole protocol-matched group; explicit /<suffix>/... requests stay pinned.
    let candidateList = resolvedProfile.isDefaultEntry
      ? (protocol === "responses" ? getAvailableResponsesProfiles(apiKey) : getAvailableDefaultProfiles(apiKey))
      : [{ name: runtime.profileName, suffix, runtime }];
    if (resolvedProfile.isDefaultEntry) {
      candidateList = applyStickyReorder(candidateList, getStickyProfile(protocol, userKey, sessionSignal));
    }
    // If every default-group member is currently unavailable (all rate-limited / breaker
    // open / unauthorized), fall back to the resolved default so the normal error path runs.
    if (candidateList.length === 0) {
      candidateList.push({ name: runtime.profileName, suffix, runtime });
    }

    // Rate + concurrency are per-user, independent of which profile serves the request.
    if (!checkAndRecordRate(userKey)) {
      if (protocol === "responses") sendOpenAiError(res, 429, "rate_limit_exceeded", "Rate limit exceeded. Please slow down.", { "Retry-After": "60" });
      else {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
        res.end(JSON.stringify({ error: "Rate limit exceeded. Please slow down.", type: "rate_limit_exceeded" }));
      }
      recordError(apiKey, 429, "rate_limit_exceeded", req.url, reqModel, suffix, runtime);
      return;
    }
    if (!tryAcquireConcurrency(userKey)) {
      if (protocol === "responses") sendOpenAiError(res, 429, "concurrency_exceeded", "Too many concurrent requests. Please try again later.", { "Retry-After": "1" });
      else {
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
        res.end(JSON.stringify({ error: "Too many concurrent requests. Please try again later.", type: "concurrency_exceeded" }));
      }
      recordError(apiKey, 429, "concurrency_exceeded", req.url, reqModel, suffix, runtime);
      return;
    }

    let lastFailure = null;   // { kind, status?, message?, runtime, suffix, quota?, err? }
    let served = false;
    let servedBy = null;      // profile that actually served (for sticky binding)
    try {
      for (let ci = 0; ci < candidateList.length; ci++) {
        const cand = candidateList[ci];
        const cruntime = cand.runtime;
        const csuffix = cand.suffix;
        const isLastCandidate = ci === candidateList.length - 1;

        // Per-candidate model resolution (each profile may map aliases differently).
        let cbody = originalBody;
        let creqModel = reqModel;
        try {
          const resolved = resolveModel(reqModel, cruntime);
          if (resolved !== reqModel) {
            const parsed = JSON.parse(originalBody.toString());
            parsed.model = resolved;
            cbody = Buffer.from(JSON.stringify(parsed));
            creqModel = resolved;
          }
        } catch {}

        if (!checkModelAllowed(creqModel, cruntime)) {
          lastFailure = { kind: "model", status: 403, model: creqModel, originalModel, message: modelNotAllowedMessage(creqModel, cruntime), runtime: cruntime, suffix: csuffix };
          if (!isLastCandidate) continue;
          break;
        }

        // Circuit breaker: skip an open upstream and try the next candidate (default
        // group entries are pre-filtered, so this mainly guards explicit /suffix/ use).
        if (!cruntime.breaker.allowRequest()) {
          lastFailure = { kind: "breaker", status: 503, runtime: cruntime, suffix: csuffix };
          if (!isLastCandidate) continue;
          break;
        }

        // creqModel is already resolved through this candidate's aliases, so the
        // quota figures (and any 429 copy) reflect the model that would actually
        // be billed — not the profile default.
        const quota = checkTokenQuota(apiKey, csuffix, cruntime, creqModel);
        if (!quota.allowed) {
          lastFailure = { kind: "quota", status: 429, quota, runtime: cruntime, suffix: csuffix };
          if (!isLastCandidate) continue;
          break;
        }

        try {
          proxyPhase = "upstream-connect";
          let realKey = getRealKey(apiKey, cruntime);
          if (realKey === apiKey && isSuperUser(apiKey, cruntime)) {
            // 超级用户未在该方案分配真实Key：借用方案上已有的key转发。
            // 借不到（方案一个真实Key都没有）时明确拒绝，绝不把虚拟Key发往上游。
            const borrowed = borrowProfileRealKey(cruntime);
            if (!borrowed) {
              lastFailure = { kind: "no_real_key", status: 403,
                err: new Error(`方案 "${cruntime.profileName}" 未配置任何可用真实Key，无法为超级用户转发请求。请先在设置中为该方案分配真实Key。`),
                runtime: cruntime, suffix: csuffix };
              if (!isLastCandidate) continue;
              break;
            }
            realKey = borrowed;
          }
          const reqHeaders = { ...req.headers, host: cruntime.upstreamUrl.host, "content-length": cbody.length };
          console.log(`── 请求开始 ── ${reqTag} ${getUserName(apiKey, cruntime)} [${reqSource}] 模型=${originalModel}${originalModel !== creqModel ? "→" + creqModel : ""}${csuffix ? ` [${csuffix}]` : ""} ──`);
          if (realKey !== apiKey) {
            // Rewrite BOTH auth conventions so a tool that also sends the virtual
            // key in x-api-key (e.g. ZCode sends VK in both authorization and
            // x-api-key) doesn't leak the jx- virtual key upstream. Anthropic-style
            // upstreams read x-api-key first and would 401 on the malformed key.
            reqHeaders["authorization"] = `Bearer ${realKey}`;
            reqHeaders["x-api-key"] = realKey;
            console.log(`${reqTag} [映射] ${getUserName(apiKey, cruntime)} 虚拟key=${apiKey.slice(0,8)}**** 请求模型=${originalModel}${originalModel !== creqModel ? " → 实际=" + creqModel : ""}`);
          }
          delete reqHeaders["connection"];
          delete reqHeaders["transfer-encoding"];
          delete reqHeaders["accept-encoding"];

          const isStreamRequest = (req.headers["accept"] || "").includes("text/event-stream") ||
            (function() { try { return JSON.parse(cbody.toString()).stream; } catch { return false; } })();

          // Tool-schema compat: some upstream validators (GLM 1210) reject the
          // whole request when a tool schema carries lookaround regex. Runs
          // before the image bridge so the bridge re-serializes the stripped
          // body, never resurrecting a removed pattern.
          if (cruntime.toolPatternsActive && cbody.includes('"tools"')) {
            try {
              const strippedBody = JSON.parse(cbody.toString());
              toolPatternApi.rememberToolPatterns(cruntime, strippedBody);   // 供探针复考(必须在剔除前)
              const removedPatterns = toolPatternApi.stripUnsupportedToolPatterns(strippedBody);
              if (removedPatterns > 0) {
                cbody = Buffer.from(JSON.stringify(strippedBody));
                reqHeaders["content-length"] = cbody.length;
                console.log(`${reqTag} [工具兼容] ${getUserName(apiKey, cruntime)} 剔除 ${removedPatterns} 处上游不支持的 pattern model=${creqModel}`);
              }
            } catch {}
          }

          // Image-recognition bridge (both protocols): non-multimodal aliases
          // with images are rewritten into helper-model descriptions before the
          // request goes upstream. Runs for both streaming and JSON requests
          // (only the request body is touched; the response mode is unaffected).
          {
            const bridged = await visionApi.bridgeImagesInRequest(cbody, cruntime, clientState, originalModel, protocol);
            if (bridged) {
              cbody = bridged.body;
              reqHeaders["content-length"] = cbody.length;
              const bs = bridged.stats;
              clientState.bridgeMs = (clientState.bridgeMs || 0) + bs.ms;
              clientState.bridgeRan = true;
              console.log(`${reqTag} [图片桥接] ${getUserName(apiKey, cruntime)} 图 ${bs.total} 张（命中 ${bs.hit} / 新识 ${bs.got} / 占位 ${bs.ph} / 失败 ${bs.failed}）耗时 ${(bs.ms / 1000).toFixed(1)}s 辅助=${bridged.helperModel} → ${creqModel}`);
            }
          }

          proxyPhase = isStreamRequest ? "streaming-proxy" : "json-proxy";
          const timeout = isStreamRequest ? gProxy.streamTimeout : gProxy.timeout;

          // responsesPath can differ per profile (e.g. Volcano uses base+/responses
          // while most others use base+/v1/responses). The default entry's strippedUrl
          // is built from the group HEAD's responsesPath, so it must NOT be reused for
          // a failover member — rebuild it from this candidate's own responsesPath.
          const candStrippedUrl = protocol === "responses"
            ? (cruntime.responsesPath || "/v1/responses") + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "")
            : strippedUrl;

          // 归属必须在派发前写入: 两个 handler 内部都会 res.end(), 而请求日志挂在
          // res 的 finish 事件上。若等 handler 返回后再赋值, finish 可能已经跑完
          // (非流式路径实测会丢 profile), 事后再补也补不回来 —— write() 那时已落盘。
          reqLog.profile = cand.name;
          if (isStreamRequest) {
            await handleStreamingProxy(req, res, cbody, reqHeaders, apiKey, creqModel, timeout, reqSource, cruntime, csuffix, candStrippedUrl, clientState);
          } else {
            await handleJsonProxy(req, res, cbody, reqHeaders, apiKey, creqModel, timeout, reqSource, cruntime, csuffix, candStrippedUrl, clientState);
          }
          served = true;
          servedBy = cand.name;
          break;
        } catch (err) {
          if (err?.isRateLimited) {
            markRateLimited(cand.name, err.resumeAt, err.source);
            lastFailure = { kind: "rate-limit", status: 429, err, runtime: cruntime, suffix: csuffix };
            if (!isLastCandidate) continue;
            break;
          }
          if (isClientAbortError(err)) {
            console.log(`${reqTag} [取消] ${getUserName(apiKey, cruntime)} 客户端已断开，停止代理 model=${creqModel} phase=${proxyPhase}`);
            served = true;   // client disconnect is not a failure to surface
            break;
          }
          lastFailure = { kind: "proxy", status: err.statusCode || (err.isTimeout ? 504 : 502), err, runtime: cruntime, suffix: csuffix };
          if (!isLastCandidate) continue;
          break;
        }
      }

      // Every candidate failed: surface the last failure to the client.
      if (!served && lastFailure && !res.headersSent) {
        // 没有任何方案真正接管, 撤掉派发前写入的归属(否则会留下最后一个试过的方案名)。
        // 失败候选之间用 continue 切换时无需清理: 下一轮派发前会用新候选名直接覆盖。
        reqLog.profile = "";
        if (protocol === "responses") {
          // Responses-protocol clients (Codex) get OpenAI-style error bodies.
          if (lastFailure.kind === "model") {
            sendOpenAiError(res, 403, "model_not_allowed", lastFailure.message);
            console.log(`${reqTag} [拦截] ${apiKey.slice(0, 8)}**** profile=${lastFailure.runtime.profileName} model 拒绝 请求模型=${lastFailure.originalModel} 解析后=${lastFailure.model} 允许=${(lastFailure.runtime.allowedModels || []).join(",")}`);
          } else if (lastFailure.kind === "breaker") {
            const remaining = Math.ceil(lastFailure.runtime.breaker.status().cooldownRemaining / 1000);
            sendOpenAiError(res, 503, "upstream_unavailable", `Upstream temporarily unavailable. Circuit open, retry in ${remaining}s.`);
            recordError(apiKey, 503, "Circuit breaker open", req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
          } else if (lastFailure.kind === "quota") {
            const q = lastFailure.quota;
            const reqHost = req.headers.host || `localhost:${port}`;
            const usageUrl = `http://${reqHost}/usage/${apiKey}`;
            const retryAfter = secondsUntilNextCnMidnight();
            sendOpenAiError(res, 429, "quota_exceeded",
              quotaExceededMessage(q, lastFailure.runtime, usageUrl),
              { "Retry-After": String(retryAfter) });
            recordError(apiKey, 429, `${quotaErrorDetail(q)}, retry in ${retryAfter}s`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
          } else if (lastFailure.kind === "rate-limit") {
            const retryAfter = Math.max(1, Math.ceil((lastFailure.err.resumeAt - Date.now()) / 1000));
            sendOpenAiError(res, 429, "rate_limit_exceeded",
              `所有可用方案均已限额，最早 ${notifierApi.beijingTimeString(new Date(lastFailure.err.resumeAt))} 恢复。`,
              { "Retry-After": String(retryAfter) });
            recordError(apiKey, 429, `all profiles rate-limited until ${notifierApi.beijingTimeString(new Date(lastFailure.err.resumeAt))}`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
          } else {
            const status = lastFailure.status;
            const label = status === 504 ? "Gateway Timeout" : status === 502 ? "Bad Gateway" : "Request Error";
            // 4xx from gateway-internal validation (e.g. bridge limits): surface
            // the actual status + message instead of masking it as Bad Gateway.
            const clientMsg = status < 500 ? lastFailure.err.message : `Proxy ${label}. Please try again later.`;
            sendOpenAiError(res, status, "proxy_error", clientMsg);
            recordError(apiKey, status, `${label}: ${lastFailure.err.message}`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
          }
        } else if (lastFailure.kind === "model") {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: lastFailure.message }));
          console.log(`${reqTag} [拦截] ${apiKey.slice(0, 8)}**** profile=${lastFailure.runtime.profileName} model 拒绝 请求模型=${lastFailure.originalModel} 解析后=${lastFailure.model} 允许=${(lastFailure.runtime.allowedModels || []).join(",")}`);
        } else if (lastFailure.kind === "breaker") {
          const remaining = Math.ceil(lastFailure.runtime.breaker.status().cooldownRemaining / 1000);
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Upstream temporarily unavailable. Circuit open, retry in ${remaining}s.` }));
          recordError(apiKey, 503, "Circuit breaker open", req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
        } else if (lastFailure.kind === "quota") {
          const q = lastFailure.quota;
          const reqHost = req.headers.host || `localhost:${port}`;
          const usageUrl = `http://${reqHost}/usage/${apiKey}`;
          const retryAfter = secondsUntilNextCnMidnight();
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfter) });
          res.end(JSON.stringify({
            error: quotaExceededMessage(q, lastFailure.runtime, usageUrl),
            type: "quota_exceeded",
            quota: { used: q.used, limit: q.limit, remaining: q.remaining, source: q.source, rawUsed: q.rawUsed, discounted: q.discounted, rate: q.rate },
            usageUrl,
          }));
          recordError(apiKey, 429, `${quotaErrorDetail(q)}, retry in ${retryAfter}s`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
        } else if (lastFailure.kind === "rate-limit") {
          const retryAfter = Math.max(1, Math.ceil((lastFailure.err.resumeAt - Date.now()) / 1000));
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": String(retryAfter) });
          res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: `所有可用方案均已限额，最早 ${notifierApi.beijingTimeString(new Date(lastFailure.err.resumeAt))} 恢复。` } }));
          recordError(apiKey, 429, `all profiles rate-limited until ${notifierApi.beijingTimeString(new Date(lastFailure.err.resumeAt))}`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
        } else {
          const status = lastFailure.status;
          const label = status === 504 ? "Gateway Timeout" : status === 502 ? "Bad Gateway" : "Request Error";
          const clientMsg = status < 500 ? lastFailure.err.message : `Proxy ${label}. Please try again later.`;
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: clientMsg }));
          recordError(apiKey, status, `${label}: ${lastFailure.err.message}`, req.url, reqModel, lastFailure.suffix, lastFailure.runtime);
        }
      }

      // Cache-affinity binding: the binding may only ever point at the protocol's
      // group head. A normal turn served by the head refreshes it (cache affinity
      // across turns); a turn served by a failover member clears it — so once the
      // head recovers from a limit/breaker it naturally returns to the front
      // instead of the conversation staying pinned to the fallback profile.
      if (servedBy && resolvedProfile.isDefaultEntry && sessionSignal) {
        const headName = protocol === "responses"
          ? (Array.isArray(config.responsesProfileGroup) ? config.responsesProfileGroup[0] : null)
          : (Array.isArray(config.defaultProfileGroup) ? config.defaultProfileGroup[0] : null);
        if (headName && servedBy === headName) {
          setStickyProfile(protocol, userKey, sessionSignal, servedBy);
        } else {
          deleteStickyProfile(protocol, userKey, sessionSignal);
        }
      }

      // Failover audit: one "switch"/"recover" per state change, not per request.
      if (servedBy && resolvedProfile.isDefaultEntry) {
        noteFailoverServed(protocol, servedBy, getUserName(apiKey, runtime));
      }
    } finally {
      releaseConcurrency(userKey);
      // Timings on the closing line: total, time-to-first-byte and how much of it
      // the image bridge spent, so "why was that turn slow" is answerable from the log.
      const secs = (ms) => (ms / 1000).toFixed(1) + "s";
      const totalMs = Date.now() - proxyStartTime;
      const parts = [`总耗时 ${secs(totalMs)}`];
      if (clientState.firstByteAt) {
        parts.push(`首字节 ${secs(clientState.firstByteAt - proxyStartTime)}`);
        // Split what is left into generation time + rate: prefill-bound turns (huge
        // context, cold prompt cache) and generation-bound turns (slow upstream)
        // look identical from the total alone.
        const genMs = Date.now() - clientState.firstByteAt;
        const outTok = clientState.lastUsage?.usage?.output_tokens || 0;
        if (genMs > 500) {
          parts.push(outTok > 0
            ? `生成 ${secs(genMs)}(${outTok}tok ${(outTok / (genMs / 1000)).toFixed(1)}tok/s)`
            : `生成 ${secs(genMs)}`);
        }
      }
      // bridgeRan, not bridgeMs: a 0ms bridge is exactly the "cost zero helper
      // calls" proof worth seeing, and 0 is falsy.
      if (clientState.bridgeRan) parts.push(`图片桥接 ${secs(clientState.bridgeMs || 0)}`);
      console.log(`── 请求结束 ── ${reqTag} ${getUserName(apiKey, runtime)} ${parts.join(" ")} ──`);
    }
  }).catch(() => {
    if (!res.headersSent) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Request body too large" }));
    }
  });
}

async function handleJsonProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, _rt, suffix, strippedUrl, clientState) {
  const runtime = _rt || d.rt;
  let lastError = null;
  // A tool-schema self-heal resend is not a retry of the same request (the body
  // changed), so it gets one extra pass beyond maxRetries rather than competing
  // with them. At most one heal per request.
  let healUsed = false;

  for (let attempt = 0; attempt <= gProxy.maxRetries + (healUsed ? 1 : 0); attempt++) {
    try {
      throwIfClientAborted(clientState);
      const upRes = await sendUpstream(body, strippedUrl || req.url, req.method, reqHeaders, timeout, runtime, clientState);
      const text = upRes.body.toString();

      // Live self-heal: the probe said this upstream accepts tool patterns but a
      // real request just got rejected over one — strip and resend instead of
      // handing the user a 400 they cannot act on.
      if (!healUsed) {
        const healed = toolPatternApi.tryToolPatternSelfHeal(body, reqHeaders, upRes.statusCode, text, runtime);
        if (healed) { body = healed; healUsed = true; continue; }
      }

      // Record success to circuit breaker for non-5xx responses
      if (upRes.statusCode < 500) {
        runtime.breaker.recordSuccess();
      }

      // Check for plan-exhausted / payment required
      if (upRes.statusCode === 402 || upRes.statusCode === 403) {
        const isPaymentIssue = text.includes("quota") || text.includes("balance") ||
          text.includes("insufficient") || text.includes("exhausted") || text.includes("billing");
        if (isPaymentIssue) {
          console.log(`[套餐] 上游套餐已耗尽或需要付款 状态码: ${upRes.statusCode}`);
        }
      }

      // Plan-exhaustion 429: hand off to the failover layer (do not retry same upstream).
      const rateLimitHit = classifyRateLimit(upRes.statusCode, text, upRes.headers);
      if (rateLimitHit) throw new RateLimitedError(rateLimitHit.resumeAt, rateLimitHit.source);

      // Retryable status codes
      if (gProxy.retryableStatusCodes.includes(upRes.statusCode) && attempt < gProxy.maxRetries) {
        const baseDelay = Math.min(gProxy.retryDelay * Math.pow(2, attempt), 10000);
        const delay = Math.round(jitter(baseDelay));
        console.log(`[重试] ${getUserName(apiKey, runtime)} ${upRes.statusCode} model=${reqModel} 第${attempt + 1}/${gProxy.maxRetries}次 ${delay}ms后重试`);
        recordError(apiKey, upRes.statusCode, `Retryable error (attempt ${attempt + 1}/${gProxy.maxRetries})`, req.url, reqModel, suffix, runtime);
        await sleepWithClientAbort(delay, clientState);
        continue;
      }

      // Parse and record
      try {
        const json = JSON.parse(text);
        if (upRes.statusCode >= 400) {
          recordError(apiKey, upRes.statusCode, json.error?.message || json.message || text.slice(0, 200), req.url, reqModel, suffix, runtime);
          if (upRes.statusCode >= 500) runtime.breaker.recordFailure();
        } else {
          // Try multiple possible usage field names
          const usage = json.usage || json.token_usage || json.usage_info;
          if (usage) {
            recordUsage(apiKey, usage, json.model, suffix, runtime);
            clientState.lastUsage = { usage, model: json.model || reqModel };
            const modelName = json.model || reqModel;
            console.log(`${clientState.tag || ""} [Token] ${getUserName(apiKey, runtime)} [${reqSource}] model=${modelName} 输入=${usage.input_tokens || usage.prompt_tokens || 0} 输出=${usage.output_tokens || usage.completion_tokens || 0} 缓存写=${usage.cache_creation_input_tokens || 0} 缓存读=${usage.cache_read_input_tokens || 0}`);
          } else {
            console.log(`[响应] ${getUserName(apiKey, runtime)} 200 OK 但无usage字段 model=${reqModel} body[0:300]=${text.slice(0, 300).replace(/\n/g, "\\n")}`);
          }
        }
      } catch {
        if (upRes.statusCode >= 400) {
          recordError(apiKey, upRes.statusCode, text.slice(0, 200), req.url, reqModel, suffix, runtime);
          if (upRes.statusCode >= 500) runtime.breaker.recordFailure();
        } else {
          console.log(`[响应] ${getUserName(apiKey, runtime)} ${upRes.statusCode} 非JSON响应 body[0:300]=${text.slice(0, 300).replace(/\n/g, "\\n")}`);
        }
      }

      const respHeaders = { ...upRes.headers };
      delete respHeaders["content-encoding"];
      delete respHeaders["content-length"];
      if (attempt > 0) respHeaders["x-proxy-retry"] = String(attempt);
      if (clientState && !clientState.firstByteAt) clientState.firstByteAt = Date.now();
      res.writeHead(upRes.statusCode, respHeaders);
      res.end(text);
      return;
    } catch (err) {
      if (err?.isRateLimited) throw err;   // propagate to outer failover loop — no breaker/retry
      if (isClientAbortError(err)) {
        console.log(`${clientState.tag || ""} [取消] ${getUserName(apiKey, runtime)} JSON 客户端断开 model=${reqModel}`);
        return;
      }
      lastError = err;
      runtime.breaker.recordFailure();
      if (attempt < gProxy.maxRetries) {
        const baseDelay = Math.min(gProxy.retryDelay * Math.pow(2, attempt), 10000);
        const delay = Math.round(jitter(baseDelay));
        console.log(`[重试] ${getUserName(apiKey, runtime)} 网络错误 model=${reqModel} 第${attempt + 1}/${gProxy.maxRetries}次 ${delay}ms后重试`);
        await sleepWithClientAbort(delay, clientState);
      }
    }
  }

  // All retries exhausted
  const finalStatus = lastError?.isTimeout ? 504 : 502;
  const finalLabel = lastError?.isTimeout ? "Gateway Timeout" : "Bad Gateway";
  recordError(apiKey, finalStatus, `${finalLabel} after ${gProxy.maxRetries} retries: ${lastError?.message}`, req.url, reqModel, suffix, runtime);
  if (!res.headersSent) {
    res.writeHead(finalStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Proxy ${finalLabel} after ${gProxy.maxRetries} retries. Please try again later.` }));
  }
}

async function streamUpstreamOnce(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, _rt, suffix, strippedUrl, clientState) {
  const runtime = _rt || d.rt;
  throwIfClientAborted(clientState);
  const opts = {
    hostname: runtime.upstreamUrl.hostname,
    port: runtime.upstreamUrl.port || (runtime.upstreamUrl.protocol === "https:" ? 443 : 80),
    path: buildUpstreamPath(strippedUrl || req.url, runtime),
    method: req.method,
    headers: reqHeaders,
    agent: runtime.agent,
  };

  const transport = runtime.upstreamUrl.protocol === "https:" ? https : http;

  await new Promise((resolve, reject) => {
    let clientGone = !!clientState?.aborted;
    let resolved = false;
    let cleanupUpstream = () => {};
    let cleanupClientAbort = () => {};
    // Idle watchdog: SSE streams rarely pause for long — a long silent gap means
    // the upstream hung. Cut it at streamIdleTimeout instead of waiting out the
    // socket-level streamTimeout backstop. Timer re-arms on every chunk.
    let idleTimer = null;
    function clearIdleTimer() {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    }
    function armIdleTimer() {
      const idleMs = Number(gProxy.streamIdleTimeout);
      if (!Number.isFinite(idleMs) || idleMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        console.log(`${clientState.tag || ""} [超时] ${getUserName(apiKey, runtime)} 流式空闲超过 ${idleMs}ms，中断上游 model=${reqModel}`);
        upReq.destroy(new Error(`Upstream stream idle timeout (${idleMs}ms)`));
      }, idleMs);
      idleTimer.unref?.();
    }
    function safeResolve() {
      if (!resolved) {
        resolved = true;
        clearIdleTimer();
        cleanupClientAbort();
        cleanupUpstream();
        resolve();
      }
    }
    function safeReject(err) {
      if (!resolved) {
        resolved = true;
        clearIdleTimer();
        cleanupClientAbort();
        cleanupUpstream();
        reject(err);
      }
    }
    const upReq = transport.request(opts, (upRes) => {
      const h = { ...upRes.headers };
      delete h["transfer-encoding"];
      delete h["content-encoding"];
      delete h["content-length"];
      h["content-type"] = "text/event-stream";
      h["cache-control"] = "no-cache";
      h["connection"] = "keep-alive";
      res.on("error", () => {
        clientGone = true;
        upReq.destroy(makeClientAbortError("response-error"));
        safeResolve();
      });

      let buf = "", usage = { input_tokens: 0, output_tokens: 0 }, model = reqModel;
      let sseDataLines = 0;
      let rawSample = "";
      let streamFailure = null;

      // Plan-exhaustion 429: buffer the full body, then hand off to the failover
      // layer WITHOUT writing anything to the client — so the next profile can own
      // the response. A burst 429 (no plan-limit signal) is passed through instead.
      if (upRes.statusCode === 429) {
        let errBuf = "";
        upRes.on("data", (c) => { if (!clientGone) errBuf += c.toString(); });
        upRes.on("end", () => {
          const rl = classifyRateLimit(upRes.statusCode, errBuf, upRes.headers);
          if (rl) {
            recordError(apiKey, upRes.statusCode, errBuf.slice(0, 200), req.url, reqModel, suffix, runtime);
            safeReject(new RateLimitedError(rl.resumeAt, rl.source));
            return;
          }
          recordError(apiKey, upRes.statusCode, errBuf.slice(0, 200), req.url, reqModel, suffix, runtime);
          runtime.breaker.recordSuccess();
          if (!clientGone) {
            res.writeHead(upRes.statusCode, h);
            if (errBuf) res.write(errBuf);
            res.end();
          }
          safeResolve();
        });
        return;
      }

      if (upRes.statusCode >= 400) {
        // Buffer the error body whole and write nothing yet: a 400 that is really
        // a tool-pattern rejection must be rewound and resent (see
        // tryToolPatternSelfHeal) instead of reaching the client as a failure.
        let errBuf = "";
        upRes.on("data", (c) => { errBuf += c.toString(); });
        upRes.on("end", () => {
          const healed = !clientGone && toolPatternApi.tryToolPatternSelfHeal(body, reqHeaders, upRes.statusCode, errBuf, runtime);
          if (healed) {
            const retry = new Error("tool-pattern resend");
            retry.toolPatternRetry = true;
            retry.body = healed;
            safeReject(retry);
            upReq.destroy();
            return;
          }
          recordError(apiKey, upRes.statusCode, errBuf.slice(0, 200), req.url, reqModel, suffix, runtime);
          if (upRes.statusCode >= 500) runtime.breaker.recordFailure();
          else if (upRes.statusCode < 500) runtime.breaker.recordSuccess();
          if (!clientGone) {
            res.writeHead(upRes.statusCode, h);
            if (errBuf) res.write(errBuf);
            res.end();
          }
          safeResolve();
        });
        return;
      }

      // Streamed 200 responses: the upstream may signal a plan-limit *in-band*
      // (HTTP 200 + SSE `response.failed`/`error`) before any business data. To
      // fail over cleanly to the next group candidate we must not send headers
      // or bytes to the client until we've confirmed it's a real stream — so we
      // buffer a short prelude, and only writeHead once a content event arrives.
      let prelude = "";
      let started = false;
      const PRELUDE_LIMIT = 64 * 1024;
      const flushPrelude = () => {
        if (started) return;
        started = true;
        if (clientState && !clientState.firstByteAt) clientState.firstByteAt = Date.now();
        res.writeHead(upRes.statusCode, h);
        runtime.breaker.recordSuccess();
        armIdleTimer();
        if (prelude) res.write(prelude);
        prelude = "";
      };

      upRes.on("data", (chunk) => {
        armIdleTimer();
        if (clientGone) return;
        const text = chunk.toString();
        if (started) {
          res.write(chunk);
        } else {
          prelude += text;
          if (prelude.length > PRELUDE_LIMIT) flushPrelude();
        }
        buf += text;
        // Save sample of raw response for debug
        if (rawSample.length < 500) rawSample += text;

        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let jsonStr = "";
          if (line.startsWith("data:")) {
            jsonStr = line.slice(5).trim();
          } else if (line.startsWith("event:")) {
            continue;
          } else if (line.startsWith("{")) {
            jsonStr = line;
          } else {
            continue;
          }
          if (jsonStr === "[DONE]") continue;
          sseDataLines++;
          try {
            const d = JSON.parse(jsonStr);
            if (sseDataLines <= 3) console.log(`${clientState.tag || ""} [SSE] ${getUserName(apiKey, runtime)} 第${sseDataLines}条 类型=${d.type} 字段=${Object.keys(d).join(",")}`);
            if (d.type === "message_start") {
              if (d.message) {
                model = d.message.model || model;
                if (d.message.usage) {
                  usage.input_tokens = d.message.usage.input_tokens || 0;
                  usage.cache_creation_input_tokens = d.message.usage.cache_creation_input_tokens || 0;
                  usage.cache_read_input_tokens = d.message.usage.cache_read_input_tokens || 0;
                }
              }
              model = d.model || model;
            } else if (d.type === "message_delta") {
              usage.output_tokens = d.usage?.output_tokens || 0;
            } else if (d.response) {
              model = d.response.model || model;
              mergeUsageCounters(usage, d.response.usage);
            }
            if (d.usage) {
              mergeUsageCounters(usage, d.usage);
            }
            if (d.model) model = d.model;
            // Responses API signals failures in-stream (HTTP stays 200): capture
            // for the error log; usage stays absent on failed streams.
            if (d.type === "response.failed" || d.type === "response.incomplete" || d.type === "error") {
              streamFailure = `${d.type}: ${d.error?.message || d.response?.error?.message || "no detail"}`;
              if (!started) {
                const msg = d.error?.message || d.response?.error?.message || "";
                const rl = classifyRateLimit(429, msg, upRes.headers);
                if (rl) {
                  // Plan-limit signalled in the first frame, before any bytes
                  // reached the client: hand off to the failover layer (next
                  // group candidate) without sending headers or data.
                  recordError(apiKey, 429, msg.slice(0, 200) || streamFailure, req.url, reqModel, suffix, runtime);
                  clientGone = true;
                  safeReject(new RateLimitedError(rl.resumeAt, rl.source));
                  upReq.destroy();
                  return;
                }
              }
            } else if (!started && d.type !== "response.created") {
              // A real content event (output_item.added / .delta / .completed / …):
              // only now do we commit to forwarding this stream to the client.
              flushPrelude();
            }
          } catch {}
        }
      });

      upRes.on("end", () => {
        if (resolved) return;
        clearIdleTimer();
        // Stream ended before any content event arrived (e.g. a non-limit error
        // stream or an empty stream): still commit headers + buffered prelude so
        // the client sees the upstream text (matches pre-fix passthrough).
        if (!started) flushPrelude();
        if (buf.startsWith("data: ")) {
          try {
            const tail = buf.slice(6).trim();
            if (tail !== "[DONE]") {
              const d = JSON.parse(tail);
              if (d.model) model = d.model;
              if (d.response?.model) model = d.response.model;
              mergeUsageCounters(usage, d.usage);
              mergeUsageCounters(usage, d.response?.usage);
            }
          } catch {}
        }
        if (usageHasTokens(usage)) {
          recordUsage(apiKey, usage, model, suffix, runtime);
          clientState.lastUsage = { usage, model };
          console.log(`${clientState.tag || ""} [Token] ${getUserName(apiKey, runtime)} [${reqSource}] model=${model} 输入=${usage.input_tokens} 输出=${usage.output_tokens} 缓存写=${usage.cache_creation_input_tokens || 0} 缓存读=${usage.cache_read_input_tokens || 0}`);
        } else {
          console.log(`[响应] ${getUserName(apiKey, runtime)} 流结束 无usage数据 model=${model} sse行数=${sseDataLines} 原始数据[0:200]=${rawSample.slice(0, 200).replace(/\n/g, "\\n")}`);
        }
        if (streamFailure) {
          recordError(apiKey, 502, `Responses stream failed: ${streamFailure}`, req.url, model, suffix, runtime);
        }
        if (!clientGone) res.end();
        safeResolve();
      });
    });
    cleanupUpstream = setActiveUpstreamRequest(clientState, upReq);
    cleanupClientAbort = addClientAbortListener(clientState, (reason) => {
      clientGone = true;
      upReq.destroy(makeClientAbortError(reason));
      safeResolve();
    });

    upReq.setTimeout(timeout, () => {
      upReq.destroy(new Error(`Upstream stream timeout (${timeout}ms)`));
    });

    upReq.on("error", (err) => {
      if (resolved) return;   // already failover'd or resolved — don't write a 502
      if (isClientAbortError(err) || clientState?.aborted) {
        console.log(`${clientState.tag || ""} [取消] ${getUserName(apiKey, runtime)} 流式客户端断开 model=${reqModel}`);
        safeResolve();
        return;
      }
      clearIdleTimer();
      runtime.breaker.recordFailure();
      const isTimeout = err.message.includes("timeout");
      const status = isTimeout ? 504 : 502;
      const label = isTimeout ? "Gateway Timeout" : "Bad Gateway";
      recordError(apiKey, status, `${label}: ${err.message}`, req.url, reqModel, suffix, runtime);
      if (!res.headersSent && !clientGone) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Proxy ${label}. Please try again later.` }));
      } else if (!clientGone && !res.writableEnded) {
        // Mid-stream upstream death (idle watchdog, network reset, ...): close the
        // SSE response so the client sees the cut instead of hanging until its own
        // timeout. Closing without a terminal SSE event is the standard abnormal end.
        res.end();
      }
      safeResolve();
    });

    upReq.write(body);
    upReq.end();
  });
}

// Stream proxy entry point. Owns the tool-schema self-heal: when the single
// upstream attempt rewinds because the upstream rejected a tool pattern the
// probe thought it accepted, that attempt left nothing written to the client, so
// the SAME request can be resent once with the patterns stripped.
async function handleStreamingProxy(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, _rt, suffix, strippedUrl, clientState) {
  let healUsed = false;
  for (;;) {
    try {
      await streamUpstreamOnce(req, res, body, reqHeaders, apiKey, reqModel, timeout, reqSource, _rt, suffix, strippedUrl, clientState);
      return;
    } catch (err) {
      if (!err?.toolPatternRetry || healUsed) throw err;
      healUsed = true;
      body = err.body;
    }
  }
}

  return { proxyRequest };
}
