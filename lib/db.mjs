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
    upsertDaily: db.prepare(`INSERT INTO usage_daily (profile,date,user_key,input_tokens,output_tokens,requests,cache_creation,cache_read,weighted_tokens)
    VALUES (@profile,@today,@key,@inp,@out,1,@cacheC,@cacheR,@weighted)
    ON CONFLICT(profile,date,user_key) DO UPDATE SET
      input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out, requests=requests+1,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR,
      weighted_tokens=weighted_tokens+@weighted`),
    upsertModel: db.prepare(`INSERT INTO usage_model (profile,model,tokens,requests)
    VALUES (@profile,@m,@tokenTotal,1)
    ON CONFLICT(profile,model) DO UPDATE SET tokens=tokens+@tokenTotal, requests=requests+1`),
    upsertHourly: db.prepare(`INSERT INTO usage_hourly (profile,date,hour,requests,input_tokens,output_tokens,cache_creation,cache_read)
    VALUES (@profile,@today,@hour,1,@inp,@out,@cacheC,@cacheR)
    ON CONFLICT(profile,date,hour) DO UPDATE SET
      requests=requests+1, input_tokens=input_tokens+@inp, output_tokens=output_tokens+@out,
      cache_creation=cache_creation+@cacheC, cache_read=cache_read+@cacheR`),
    upsertDailyModel: db.prepare(`INSERT INTO usage_daily_model (profile,date,user_key,model,input_tokens,output_tokens,requests,weighted_tokens)
    VALUES (@profile,@today,@key,@m,@inp,@out,1,@weighted)
    ON CONFLICT(profile,date,user_key,model) DO UPDATE SET
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
    insertError: db.prepare(`INSERT INTO errors (profile,time,user_name,user_key,status_code,error,path,model)
    VALUES (@profile,@time,@userName,@key,@statusCode,@error,@path,@model)`),
    pruneErrors: db.prepare(`DELETE FROM errors WHERE time < ?`),
    trimErrors: db.prepare(`DELETE FROM errors WHERE id NOT IN (SELECT id FROM errors ORDER BY id DESC LIMIT 200)`),
    pruneDailyModel: db.prepare(`DELETE FROM usage_daily_model WHERE date < ?`),
    pruneDailyHourly: db.prepare(`DELETE FROM usage_daily_hourly WHERE date < ?`),
    pruneHourlyModel: db.prepare(`DELETE FROM usage_hourly_model WHERE date < ?`),
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
    insertQuotaRequest: db.prepare(`INSERT INTO quota_requests (user_key,username,reason,pool,status,created_at)
    VALUES (@key,@username,@reason,@pool,'pending',@createdAt)`),

    // ── Read statements ──
    // Single-profile variant of the pooled usage query above; still used where the
    // scope is genuinely one profile (per-profile stats, not quota enforcement).
    todayWeightedForQuota: db.prepare(`SELECT COALESCE(SUM(weighted_tokens),0) AS used, COALESCE(SUM(input_tokens+output_tokens),0) AS raw FROM usage_daily WHERE profile=? AND date=? AND user_key=?`),
    profileDailyRow: db.prepare(`SELECT * FROM usage_daily WHERE profile=? AND date=? AND user_key=?`),
    profileDailyModelRows: db.prepare(`SELECT model,input_tokens,output_tokens,requests,weighted_tokens FROM usage_daily_model WHERE profile=? AND date=? AND user_key=?`),
    profileDailyHourlyRows: db.prepare(`SELECT hour,requests,input_tokens,output_tokens,cache_creation,cache_read FROM usage_daily_hourly WHERE profile=? AND date=? AND user_key=?`),
    profileDailyTrend: db.prepare(`SELECT date,input_tokens,output_tokens,requests,cache_creation,cache_read FROM usage_daily WHERE profile=? AND user_key=? AND date>=? ORDER BY date`),
    profileSummaryToday: db.prepare(`SELECT COALESCE(SUM(input_tokens+output_tokens+cache_creation+cache_read),0) AS tokens, COALESCE(SUM(requests),0) AS requests FROM usage_daily WHERE profile=? AND date=?`),
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
    getQuotaRequest: db.prepare(`SELECT * FROM quota_requests WHERE id=?`),
    listQuotaRequests: db.prepare(`SELECT * FROM quota_requests ORDER BY id DESC LIMIT ?`),
    listQuotaRequestsByStatus: db.prepare(`SELECT * FROM quota_requests WHERE status=? ORDER BY id DESC LIMIT ?`),
    countQuotaRequestsSince: db.prepare(`SELECT COUNT(*) AS c FROM quota_requests WHERE user_key=? AND created_at>=?`),
    // The weekly cap counts requests the admin has HANDLED, not submissions.
    countHandledQuotaRequestsSince: db.prepare(`SELECT COUNT(*) AS c FROM quota_requests WHERE user_key=? AND status='handled' AND handled_at>=?`),
    myQuotaRequests: db.prepare(`SELECT id,reason,pool,status,admin_note,created_at,handled_at FROM quota_requests WHERE user_key=? ORDER BY id DESC LIMIT 5`),
    updateQuotaRequest: db.prepare(`UPDATE quota_requests SET status=@status, admin_note=@note, handled_at=@handledAt WHERE id=@id`),
    countPendingQuotaRequests: db.prepare(`SELECT COUNT(*) AS c FROM quota_requests WHERE status='pending'`),
  };
}