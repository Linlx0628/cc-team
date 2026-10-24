// lib/db.mjs —— SQLite 预编译语句工厂。纯函数，零外部依赖。
// 所有 usage/error/audit 数据的读写都经由此处返回的预编译语句，server.mjs 不再
// 内联任何 db.prepare(…)。签名只依赖 db 句柄，便于复用与测试。

export function buildStatements(db) {
  return {
    // ── Write statements (UPSERT / INSERT) ──
    upsertUser: db.prepare(`INSERT INTO users (profile,user_key,name,total_input,total_output,total_requests,cache_creation,cache_read,last_active)
    VALUES (@profile,@key,@name,@inp,@out,1,@cacheC,@cacheR,@now)
    ON CONFLICT(profile,user_key) DO UPDATE SET
      total_input=total_input+@inp, total_output=total_output+@out, total_requests=total_requests+1,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR, name=@name, last_active=@now`),
    // usage_daily / usage_daily_hourly / usage_daily_model also carry
    // weighted_tokens — the quota currency ((input+output) × the effective rate for
    // that slot and model). The other four tables stay raw-token only: statistics
    // and charts must never show discounted figures.
    upsertDaily: db.prepare(`INSERT INTO usage_daily (profile,date,user_key,input_tokens,output_tokens,requests,cache_creation,cache_read,weighted_tokens,billing_weighted_tokens)
    VALUES (@profile,@today,@key,@inp,@out,1,@cacheC,@cacheR,@weighted,@billingWeighted)
    ON CONFLICT(profile,date,user_key) DO UPDATE SET
      input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out, requests=requests+1,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR,
      weighted_tokens=weighted_tokens+@weighted,
      billing_weighted_tokens=COALESCE(billing_weighted_tokens,weighted_tokens)+@billingWeighted`),
    upsertModel: db.prepare(`INSERT INTO usage_model (profile,model,tokens,requests)
    VALUES (@profile,@m,@tokenTotal,1)
    ON CONFLICT(profile,model) DO UPDATE SET tokens=tokens+@tokenTotal, requests=requests+1`),
    upsertHourly: db.prepare(`INSERT INTO usage_hourly (profile,date,hour,requests,input_tokens,output_tokens,cache_creation,cache_read)
    VALUES (@profile,@today,@hour,1,@inp,@out,@cacheC,@cacheR)
    ON CONFLICT(profile,date,hour) DO UPDATE SET
      requests=requests+1, input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR`),
    upsertDailyModel: db.prepare(`INSERT INTO usage_daily_model (profile,date,user_key,model,input_tokens,output_tokens,requests,weighted_tokens,billing_weighted_tokens)
    VALUES (@profile,@today,@key,@m,@inp,@out,1,@weighted,@billingWeighted)
    ON CONFLICT(profile,date,user_key,model) DO UPDATE SET
      input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out, requests=requests+1,
      weighted_tokens=weighted_tokens+@weighted,
      billing_weighted_tokens=COALESCE(billing_weighted_tokens,weighted_tokens)+@billingWeighted`),
    // 客户端维度。与会话维度相反,caller 不做过滤 —— 解析不出客户端时传 "unknown",
    // 也照常落一行,所以表内合计恒等于总量,不存在需要披露的缺口。
    // client 是原文 product token(claude-cli / codex_cli_rs / ...),不做枚举校验。
    upsertDailyClient: db.prepare(`INSERT INTO usage_daily_client (profile,date,user_key,client,input_tokens,output_tokens,requests,weighted_tokens)
    VALUES (@profile,@today,@key,@client,@inp,@out,1,@weighted)
    ON CONFLICT(profile,date,user_key,client) DO UPDATE SET
      input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out, requests=requests+1,
      weighted_tokens=weighted_tokens+@weighted`),
    upsertDailyHourly: db.prepare(`INSERT INTO usage_daily_hourly (profile,date,user_key,hour,requests,input_tokens,output_tokens,cache_creation,cache_read,weighted_tokens)
    VALUES (@profile,@today,@key,@hour,1,@inp,@out,@cacheC,@cacheR,@weighted)
    ON CONFLICT(profile,date,user_key,hour) DO UPDATE SET
      requests=requests+1, input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR,
      weighted_tokens=weighted_tokens+@weighted`),
    upsertHourlyModel: db.prepare(`INSERT INTO usage_hourly_model (profile,date,user_key,hour,model,requests,input_tokens,output_tokens,cache_creation,cache_read)
    VALUES (@profile,@today,@key,@hour,@m,1,@inp,@out,@cacheC,@cacheR)
    ON CONFLICT(profile,date,user_key,hour,model) DO UPDATE SET
    requests=requests+1, input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out,
    cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR`),
    // 会话维度。只在 extractSessionSignal 给出真实标识(hdr:/pck:/dig:)时调用,
    // 回落到 "nosession" 的请求不落这张表,所以这里不需要再过滤。
    // first_seen/last_seen 用 MIN/MAX 而不是覆盖:同一会话同一天会有很多轮,
    // 要留住最早与最晚,否则「会话时长」会退化成「最后一轮的瞬间」。
    // 两个时间戳都是同格式的 UTC ISO,字符串比较即时间比较。
    // client 存原始信号(claude-cli / codex_cli_rs / unknown),展示时才映射可读名 —— 与
    // usage_daily_client 同约定。DO UPDATE 不碰 client 列:冲突即沿用首次落库的值
    // (first-wins),会话中途换客户端的罕见情况不改写历史。
    upsertSession: db.prepare(`INSERT INTO usage_session (profile,user_key,session,date,first_seen,last_seen,input_tokens,output_tokens,requests,cache_creation,cache_read,client)
    VALUES (@profile,@key,@session,@today,@now,@now,@inp,@out,1,@cacheC,@cacheR,@client)
    ON CONFLICT(profile,user_key,session,date) DO UPDATE SET
      input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out, requests=requests+1,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR,
      first_seen=MIN(first_seen,@now), last_seen=MAX(last_seen,@now)`),
    insertError: db.prepare(`INSERT INTO errors (profile,time,user_name,user_key,status_code,error,path,model)
    VALUES (@profile,@time,@userName,@key,@statusCode,@error,@path,@model)`),
    pruneErrors: db.prepare(`DELETE FROM errors WHERE time < ?`),
    trimErrors: db.prepare(`DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY id DESC LIMIT 200)`),
    pruneDailyModel: db.prepare(`DELETE FROM usage_daily_model WHERE date < ?`),
    // 与 usage_daily_model 同期限:两张表喂同一批「可切周期」的分布图,期限不一致会让
    // 客户端分布比模型分布多出一段历史。
    pruneDailyClient: db.prepare(`DELETE FROM usage_daily_client WHERE date < ?`),
    pruneDailyHourly: db.prepare(`DELETE FROM usage_daily_hourly WHERE date < ?`),
    pruneHourlyModel: db.prepare(`DELETE FROM usage_hourly_model WHERE date < ?`),
    // usage_hourly 原本从不清理,只增不减(读取端已加日期下界,但盘上仍会一直长)。
    // 与 usage_hourly_model 同期限 —— 两张表喂同一批 24 小时图,期限不一致会让模型图
    // 比总量图多出一段历史。
    pruneHourly: db.prepare(`DELETE FROM usage_hourly WHERE date < ?`),
    // 90 天,与 tool_events 同期限(production.mjs 的 maybePrune)。两边必须同期限:
    // 会话使用情况与项目分布要把 session 当连接键跨这两张表取数,一边先过期就会留下
    // 连不上另一边的孤儿行,表现为「有会话无工具数据」或「有项目无 token」。
    pruneUsageSession: db.prepare(`DELETE FROM usage_session WHERE date < ?`),
    insertQuotaAdjust: db.prepare(`INSERT INTO quota_adjust_history (user_key,user_name,date,old_quota,new_quota,hit_rate,avg_daily_usage,auto,time)
    VALUES (@user,@username,@date,@oldQuota,@newQuota,@hitRate,@avgDailyUsage,1,@time)`),
    insertQuotaAdjustManual: db.prepare(`INSERT INTO quota_adjust_history (user_key,user_name,date,old_quota,new_quota,hit_rate,avg_daily_usage,auto,time)
    VALUES (@user,@username,@date,@oldQuota,@newQuota,NULL,NULL,0,@time)`),
    trimQuotaAdjust: db.prepare(`DELETE FROM quota_adjust_history WHERE id NOT IN (SELECT id FROM quota_adjust_history ORDER BY id DESC LIMIT 100)`),
    upsertQuotaDailyOp: db.prepare(`INSERT INTO quota_daily_ops (pool,user_key,date,bonus,reset_baseline,reset_time,updated_at)
    VALUES (@pool,@key,@date,@bonus,@baseline,@resetTime,@updatedAt)
    ON CONFLICT(pool,user_key,date) DO UPDATE SET
      bonus=@bonus, reset_baseline=@baseline, reset_time=@resetTime, updated_at=@updatedAt`),
    deleteQuotaDailyOp: db.prepare(`DELETE FROM quota_daily_ops WHERE pool=? AND user_key=? AND date=?`),
    pruneQuotaDailyOps: db.prepare(`DELETE FROM quota_daily_ops WHERE date < ?`),
    upsertMeta: db.prepare(`INSERT INTO kv_meta (key,value) VALUES (@k,@v) ON CONFLICT(key) DO UPDATE SET value=excluded.value`),
    // Image-bridge transcription cache (persisted so a gateway restart never
    // re-transcribes replayed history images).
    bridgeCacheGet: db.prepare(`SELECT text, ts FROM image_bridge_cache WHERE hash=?`),
    bridgeCacheTouch: db.prepare(`UPDATE image_bridge_cache SET ts=? WHERE hash=?`),
    bridgeCacheSet: db.prepare(`INSERT INTO image_bridge_cache (hash,text,ts) VALUES (?,?,?)
    ON CONFLICT(hash) DO UPDATE SET text=excluded.text, ts=excluded.ts`),
    bridgeCacheCount: db.prepare(`SELECT COUNT(*) AS n FROM image_bridge_cache`),
    bridgeCachePrune: db.prepare(`DELETE FROM image_bridge_cache WHERE hash IN (
    SELECT hash FROM image_bridge_cache ORDER BY ts DESC LIMIT -1 OFFSET ?)`),
    insertAudit: db.prepare(`INSERT INTO audit_log (time,actor,action,target,detail,ip,category)
    VALUES (@time,@actor,@action,@target,@detail,@ip,@category)`),
    // Check-ins land once per user per day, so the audit trail grows faster now;
    // raise the cap so admin/system entries don't age out too quickly. (check_ins
    // itself keeps the complete, untrimmed check-in history.)
    trimAudit: db.prepare(`DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT 3000)`),
    insertCheckIn: db.prepare(`INSERT INTO check_ins (user_key,date,amount,pools,created_at)
    VALUES (@key,@date,@amount,@pools,@createdAt)`),
    insertPointCheckIn: db.prepare(`INSERT INTO point_check_ins (user_key,date,points,billing_weighted_tokens,created_at)
    VALUES (@key,@date,@points,@billingWeighted,@createdAt)`),
    insertQuotaRequest: db.prepare(`INSERT INTO quota_requests (user_key,username,reason,pool,status,created_at)
    VALUES (@key,@username,@reason,@pool,'pending',@createdAt)`),
    // ── 点数预算:成员自选方案偏好 ──
    // 按协议各一列:同一个成员在 Anthropic 入口(Claude Code)与 Responses 入口(Codex)
    // 可以各选一套方案,两列互不覆盖;NULL 表示没选过,走该协议的基础组排序。
    upsertMemberProfilePreference: db.prepare(`INSERT INTO member_profile_preference (user_key,preferred_anthropic,preferred_responses,updated_at)
    VALUES (@key,@anth,@resp,@updatedAt)
    ON CONFLICT(user_key) DO UPDATE SET
      preferred_anthropic=@anth, preferred_responses=@resp, updated_at=@updatedAt`),

    // 点数用量三层桶：一次请求同时累加 day/week/month。billing_weighted_tokens
    // 在 recordUsage 里按点数额率×用户系数×方案系数算好，写入后冻结，不随配置回溯。
    upsertPointUsage: db.prepare(`INSERT INTO point_usage (user_key,granularity,bucket_start,billing_weighted_tokens,requests,updated_at)
    VALUES (@key,@g,@bucket,@billing,1,@updatedAt)
    ON CONFLICT(user_key,granularity,bucket_start) DO UPDATE SET
      billing_weighted_tokens=billing_weighted_tokens+@billing,
      requests=requests+1, updated_at=@updatedAt`),
    pointUsageByUser: db.prepare(`SELECT user_key,granularity,bucket_start,billing_weighted_tokens,requests,updated_at
    FROM point_usage WHERE user_key=? AND granularity=? AND bucket_start>=? AND bucket_start<=?
    ORDER BY bucket_start DESC LIMIT ?`),
    pointUsageAll: db.prepare(`SELECT user_key,granularity,bucket_start,billing_weighted_tokens,requests,updated_at
    FROM point_usage WHERE granularity=? AND bucket_start>=? AND bucket_start<=?
    ORDER BY bucket_start DESC, user_key LIMIT ?`),
    // 每次成功请求的点数凭证：与 point_usage 同一时刻写入，但保留逐条明细供成员核对。
    // 只记录点数用户；不存 prompt/响应正文。created_at 是毫秒时间戳，id 自增用于游标。
    insertPointRequest: db.prepare(`INSERT INTO point_requests
      (user_key,day,created_at,profile,model,protocol,client,input_tokens,output_tokens,
       cache_read_tokens,cache_creation_tokens,weighted_tokens,billing_weighted_tokens,point_rate)
      VALUES (@key,@day,@createdAt,@profile,@model,@protocol,@client,@inp,@out,@cacheC,@cacheR,@weighted,@billing,@pointRate)`),
    listPointRequests: db.prepare(`SELECT id,day,created_at,profile,model,protocol,client,
      input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,weighted_tokens,
      billing_weighted_tokens,point_rate
      FROM point_requests
      WHERE user_key=@key AND day>=@start AND day<=@end AND id<@before
      ORDER BY id DESC LIMIT @limit`),
    sumPointUsageRange: db.prepare(`SELECT COALESCE(SUM(billing_weighted_tokens),0) AS weighted,
      COALESCE(SUM(requests),0) AS requests FROM point_usage
      WHERE user_key=? AND granularity='day' AND bucket_start>=? AND bucket_start<=?`),
    countPointRequests: db.prepare(`SELECT COUNT(*) AS n FROM point_requests
      WHERE user_key=? AND day>=? AND day<=?`),
    prunePointRequests: db.prepare(`DELETE FROM point_requests WHERE day < ?`),

    // ── Read statements ──
    // Single-profile variant of the pooled usage query above; still used where the
    // scope is genuinely one profile (per-profile stats, not quota enforcement).
    todayWeightedForQuota: db.prepare(`SELECT COALESCE(SUM(weighted_tokens),0) AS used, COALESCE(SUM(input_tokens+output_tokens),0) AS raw FROM usage_daily WHERE profile=? AND date=? AND user_key=?`),
    profileDailyRow: db.prepare(`SELECT * FROM usage_daily WHERE profile=? AND date=? AND user_key=?`),
    profileDailyModelRows: db.prepare(`SELECT model,input_tokens,output_tokens,requests,weighted_tokens,COALESCE(billing_weighted_tokens,weighted_tokens) AS billing_weighted_tokens FROM usage_daily_model WHERE profile=? AND date=? AND user_key=?`),
    // 区间聚合变体(我的用量页自定义日期范围):与单日版同列名,跨日 SUM 后每模型/客户端一行。
    profileDailyModelRowsRange: db.prepare(`SELECT model,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(requests) AS requests,SUM(weighted_tokens) AS weighted_tokens,SUM(COALESCE(billing_weighted_tokens,weighted_tokens)) AS billing_weighted_tokens FROM usage_daily_model WHERE profile=? AND user_key=? AND date BETWEEN ? AND ? GROUP BY model`),
    profileDailyClientRows: db.prepare(`SELECT client,input_tokens,output_tokens,requests,weighted_tokens FROM usage_daily_client WHERE profile=? AND date=? AND user_key=?`),
    profileDailyClientRowsRange: db.prepare(`SELECT client,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(requests) AS requests,SUM(weighted_tokens) AS weighted_tokens FROM usage_daily_client WHERE profile=? AND user_key=? AND date BETWEEN ? AND ? GROUP BY client`),
    profileDailyHourlyRows: db.prepare(`SELECT hour,requests,input_tokens,output_tokens,cache_creation,cache_read FROM usage_daily_hourly WHERE profile=? AND date=? AND user_key=?`),
    profileDailyTrend: db.prepare(`SELECT date,input_tokens,output_tokens,requests,cache_creation,cache_read FROM usage_daily WHERE profile=? AND user_key=? AND date>=? AND date<=? ORDER BY date`),
    profileSummaryToday: db.prepare(`SELECT COALESCE(SUM(input_tokens+output_tokens+cache_creation+cache_read),0) AS tokens, COALESCE(SUM(requests),0) AS requests FROM usage_daily WHERE profile=? AND date=?`),
    // 方案中心「使用状态」:每方案最近一次请求时间。users.profile 存 suffix(与 profileSummaryToday 同口径),
    // last_active 由 recordUsage 的 upsertUser 在请求完成记账时以 ISO 串更新 —— 失败未记账的请求不推进它。
    profileLastActive: db.prepare(`SELECT profile, MAX(last_active) AS la FROM users GROUP BY profile`),
    // 排行榜:跨用户按日期区间聚合。date 是北京日期串,与 tool_events 的 date(time,'+8 hours') 同口径,
    // 所以同一个 {from,to} 能同时喂给两套查询。
    // token 用原始 input+output(与页面卡片一致),不用 weighted_tokens —— 统计口径从不显示折扣后数字。
    // active_days 必须 COUNT(DISTINCT date):主键是 (profile,date,user_key),一个人同一天跑 N 个方案
    // 就是 N 行,COUNT(*) 会把 6 天报成 9 天。SUM 类指标(sum 跨方案)不受影响,只有计数类会。
    // 刻意不取 cache_creation:它只有 Anthropic 一个来源(server.mjs:1769),OpenAI 系协议恒为 0,
    // 拿它做分子会得到一张对多数人恒为 0 的假表。缓存类的比值一律走 contextHealth。
    // 注:usage_daily 的 PK 前置列是 profile,按 (user_key,date) 过滤原本会全表扫;点数预算
    // 上线时补了 idx_usage_daily_user_date(user_key,date),本语句仍按日期区间扫全表。
    leaderboardUsageByUser: db.prepare(`SELECT user_key,
      COALESCE(SUM(input_tokens+output_tokens),0) AS tokens,
      COALESCE(SUM(requests),0) AS requests,
      COUNT(DISTINCT date) AS active_days,
      COALESCE(SUM(cache_read),0) AS cache_read
      FROM usage_daily WHERE date BETWEEN ? AND ? GROUP BY user_key`),
    // 会话聚合。按 (user_key, session, profile) 分组而不是只按 session:缓存率必须逐方案
    // 判断协议(responses 协议把缓存读折进了 input_tokens,见 production.mjs 的 contextHealth),
    // 折叠时要能分开算,否则 Codex 用户的命中率会被系统性压到 50% 上限。
    // 窗口内跨天的会话会因 date 不在分组键里并成一行:SUM 只累加窗口内的日期(精确,不会
    // 把窗口外的轮次算进来),MIN/MAX 给出真实首末。这正是 usage_session 主键带 date 的原因。
    // cache_creation 照旧不参与比值(只有 Anthropic 一个来源),此处取出来仅供展示。
    // client 用 MIN 取值:会话基本单客户端,MIN 忽略 NULL(迁移前的旧行),跨 profile
    // 折叠时给出确定值。
    sessionRows: db.prepare(`SELECT user_key, session, profile,
      COALESCE(SUM(input_tokens),0) AS inp, COALESCE(SUM(output_tokens),0) AS out,
      COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(cache_creation),0) AS cache_creation,
      COALESCE(SUM(cache_read),0) AS cache_read,
      MIN(client) AS client,
      MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen
      FROM usage_session WHERE date BETWEEN ? AND ? GROUP BY user_key, session, profile`),
    sessionRowsForUser: db.prepare(`SELECT user_key, session, profile,
      COALESCE(SUM(input_tokens),0) AS inp, COALESCE(SUM(output_tokens),0) AS out,
      COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(cache_creation),0) AS cache_creation,
      COALESCE(SUM(cache_read),0) AS cache_read,
      MIN(client) AS client,
      MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen
      FROM usage_session WHERE user_key=? AND date BETWEEN ? AND ? GROUP BY user_key, session, profile`),
    // 归属率的分母:窗口内 usage_daily 的原始总量(input+output,与页面卡片同口径)。
    // unattributed = 这里 − usage_session 的已归属量,即 extractSessionSignal 回落到
    // "nosession" 而刻意没落表的那部分。必须如实披露(照排行榜 cohort 的先例),不能藏。
    usageTotalsByUser: db.prepare(`SELECT user_key,
      COALESCE(SUM(input_tokens+output_tokens),0) AS tokens,
      COALESCE(SUM(requests),0) AS requests
      FROM usage_daily WHERE date BETWEEN ? AND ? GROUP BY user_key`),
    lastQuotaAdjust: db.prepare(`SELECT * FROM quota_adjust_history WHERE user_key=? AND auto=1 ORDER BY id DESC LIMIT 1`),
    quotaAdjustRecent: db.prepare(`SELECT * FROM quota_adjust_history ORDER BY id DESC LIMIT 20`),
    getQuotaDailyOp: db.prepare(`SELECT * FROM quota_daily_ops WHERE pool=? AND user_key=? AND date=?`),
    todayQuotaOps: db.prepare(`SELECT * FROM quota_daily_ops WHERE date=?`),
    auditPage: db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?`),
    auditPageForActor: db.prepare(`SELECT * FROM audit_log WHERE actor=? ORDER BY id DESC LIMIT ? OFFSET ?`),
    auditTotal: db.prepare(`SELECT COUNT(*) AS c FROM audit_log`),
    auditTotalForActor: db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE actor=?`),
    auditPageAdmin: db.prepare(`SELECT * FROM audit_log WHERE actor='admin' AND action NOT LIKE 'auth.%' ORDER BY id DESC LIMIT ? OFFSET ?`),
    auditPageSystem: db.prepare(`SELECT * FROM audit_log WHERE actor='system' ORDER BY id DESC LIMIT ? OFFSET ?`),
    auditPageAuth: db.prepare(`SELECT * FROM audit_log WHERE action LIKE 'auth.%' ORDER BY id DESC LIMIT ? OFFSET ?`),
    auditTotalAdmin: db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE actor='admin' AND action NOT LIKE 'auth.%'`),
    auditTotalSystem: db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE actor='system'`),
    auditTotalAuth: db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE action LIKE 'auth.%'`),
    auditPageForCategory: db.prepare(`SELECT * FROM audit_log WHERE category=? ORDER BY id DESC LIMIT ? OFFSET ?`),
    auditTotalForCategory: db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE category=?`),
    // ── Check-in & quota-request reads ──
    getCheckIn: db.prepare(`SELECT * FROM check_ins WHERE user_key=? AND date=?`),
    checkInDatesSince: db.prepare(`SELECT date FROM check_ins WHERE user_key=? AND date>=? ORDER BY date DESC`),
    checkInTotals: db.prepare(`SELECT COUNT(*) AS days, COALESCE(SUM(amount),0) AS tokens FROM check_ins WHERE user_key=?`),
    getPointCheckIn: db.prepare(`SELECT * FROM point_check_ins WHERE user_key=? AND date=?`),
    pointCheckInDatesSince: db.prepare(`SELECT date FROM point_check_ins WHERE user_key=? AND date>=? ORDER BY date DESC`),
    pointCheckInTotals: db.prepare(`SELECT COUNT(*) AS days, COALESCE(SUM(points),0) AS points FROM point_check_ins WHERE user_key=?`),
    sumPointCheckInPoints: db.prepare(`SELECT COALESCE(SUM(points),0) AS points, COALESCE(SUM(billing_weighted_tokens),0) AS weighted
      FROM point_check_ins WHERE user_key=? AND date>=? AND date<=?`),
    getQuotaRequest: db.prepare(`SELECT * FROM quota_requests WHERE id=?`),
    listQuotaRequests: db.prepare(`SELECT * FROM quota_requests ORDER BY id DESC LIMIT ?`),
    listQuotaRequestsByStatus: db.prepare(`SELECT * FROM quota_requests WHERE status=? ORDER BY id DESC LIMIT ?`),
    countQuotaRequestsSince: db.prepare(`SELECT COUNT(*) AS c FROM quota_requests WHERE user_key=? AND created_at>=?`),
    // The weekly cap counts requests the admin has HANDLED, not submissions.
    countHandledQuotaRequestsSince: db.prepare(`SELECT COUNT(*) AS c FROM quota_requests WHERE user_key=? AND status='handled' AND handled_at>=?`),
    myQuotaRequests: db.prepare(`SELECT id,reason,pool,status,admin_note,created_at,handled_at FROM quota_requests WHERE user_key=? ORDER BY id DESC LIMIT 5`),
    updateQuotaRequest: db.prepare(`UPDATE quota_requests SET status=@status, admin_note=@note, handled_at=@handledAt WHERE id=@id`),
    countPendingQuotaRequests: db.prepare(`SELECT COUNT(*) AS c FROM quota_requests WHERE status='pending'`),
    // ── 点数预算的周期用量 ──
    // 预算是「人 × 周期」的:跨方案汇总,与 pool / profile 无关(池配额那套才是按池)。
    // date 是北京日期串,区间为闭区间;weighted_tokens 是记账时冻结的计权值,SUM 即
    // 精确计权成本 —— 绝不能用 input+output 现算,否则改倍率会让历史点数漂移。
    // 命中 idx_usage_daily_user_date(user_key,date);PK 首列是 profile,旧版这条查询全表扫。
    sumUserWeightedRange: db.prepare(`SELECT COALESCE(SUM(COALESCE(billing_weighted_tokens,weighted_tokens)),0) AS used, COALESCE(SUM(input_tokens+output_tokens),0) AS raw, COALESCE(SUM(requests),0) AS requests FROM usage_daily WHERE user_key=? AND date>=? AND date<=?`),
    // 管理端批量视图:某日之后每个成员一行(缺省不传 user_key),避免按人循环 N 次查询。
    sumUserWeightedSince: db.prepare(`SELECT user_key, COALESCE(SUM(COALESCE(billing_weighted_tokens,weighted_tokens)),0) AS used, COALESCE(SUM(input_tokens+output_tokens),0) AS raw, COALESCE(SUM(requests),0) AS requests FROM usage_daily WHERE date>=? GROUP BY user_key`),
    getMemberProfilePreference: db.prepare(`SELECT * FROM member_profile_preference WHERE user_key=?`),
  };
}