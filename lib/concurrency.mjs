// lib/concurrency.mjs —— 并发观测(纯旁路,不参与代理主路径)。
//
// 口径:
//   active_ms / 窗口时长 = 平均在途并发
//   peak                 = 同一时刻最大在途请求数
//
// 为什么不在每个请求上写一条 DB:
//   · 进程内只维护「当前分钟累加器 + 最近几小时的事件环」,每个请求开始/结束各一次 O(1) 操作;
//   · 定时器每 30 秒把**有变化的分钟**批量 UPSERT 一次,通常只有 1 行;
//   · 秒级视图直接用内存事件环算,不落库;分钟级历史读表。
// 这样即使每天几万请求,也不会在代理热路径上增加一次 SQLite 写。
//
// 历史分钟数据由请求日志在启动后后台回填(见 backfillConcurrencyFromRequestLogs):
// 日志里已有 t 与 ms,反推 start=t-ms 即可精确还原 interval。
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const MINUTE = 60_000;
const SECOND = 1_000;
const DEFAULT_EVENT_RETENTION_MS = 6 * 3600_000;
const DEFAULT_MINUTE_RETENTION_DAYS = 30;
const DEFAULT_FLUSH_MS = 30_000;
const MAX_SECOND_POINTS = 1_800;
const MAX_MINUTE_POINTS = 1_500;

export function initConcurrencyDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS concurrency_minute (
      minute INTEGER PRIMARY KEY,
      active_ms INTEGER NOT NULL DEFAULT 0,
      peak INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0
    );
  `);
}

const minuteStart = (ms) => Math.floor(ms / MINUTE) * MINUTE;
const secondStart = (ms) => Math.floor(ms / SECOND) * SECOND;
const overlap = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));

export function createConcurrencyTracker({
  db,
  now = () => Date.now(),
  log = console.log,
  eventRetentionMs = DEFAULT_EVENT_RETENTION_MS,
  minuteRetentionDays = DEFAULT_MINUTE_RETENTION_DAYS,
  flushMs = DEFAULT_FLUSH_MS,
  autoTimer = true,
} = {}) {
  if (!db) throw new Error("concurrency tracker requires db");

  const createdAt = now();
  const upsertMinute = db.prepare(`
    INSERT INTO concurrency_minute (minute, active_ms, peak, requests)
    VALUES (?,?,?,?)
    ON CONFLICT(minute) DO UPDATE SET
      active_ms=excluded.active_ms,
      peak=MAX(concurrency_minute.peak, excluded.peak),
      requests=excluded.requests`);
  const deleteBefore = db.prepare(`DELETE FROM concurrency_minute WHERE minute < ?`);
  const storedRange = db.prepare(`
    SELECT minute, active_ms, peak, requests FROM concurrency_minute
    WHERE minute>=? AND minute<=? ORDER BY minute`);

  let active = 0;
  let lastTick = now();
  let lastPrune = 0;
  let events = [];                       // { t, d }, d=+1 开始 / -1 结束;查询时排序
  const minutes = new Map();             // minuteStart → { activeMs, peak, requests, dirty }
  const flushed = new Set();             // 本进程已落库的分钟;snapshot 合并时避免重复累加

  function bucket(m, create = true) {
    let b = minutes.get(m);
    if (!b && create) {
      b = { activeMs: 0, peak: 0, requests: 0, dirty: false };
      minutes.set(m, b);
    }
    return b || null;
  }

  // 把 [lastTick, ts) 按分钟切开,当前 active 持续计入 activeMs。O(跨过的分钟数),
  // 正常请求生命周期里通常只跨 0~1 个边界。
  function tick(ts = now()) {
    if (!Number.isFinite(ts) || ts <= lastTick) return;
    let cursor = lastTick;
    while (cursor < ts) {
      const m = minuteStart(cursor);
      const end = Math.min(ts, m + MINUTE);
      if (active > 0) {
        const b = bucket(m, true);
        b.activeMs += (end - cursor) * active;
        if (active > b.peak) b.peak = active;
        b.dirty = true;
      }
      cursor = end;
    }
    lastTick = ts;
  }

  function pruneEvents(cutoff = now() - eventRetentionMs) {
    if (!events.length) return;
    // 事件不是严格按 t 排列(开始事件可能晚于上一个结束事件被 push),整段过滤最稳妥。
    events = events.filter(e => e.t >= cutoff);
  }

  function noteStart(ts = now()) {
    const wall = now();
    const t = Number.isFinite(ts) ? ts : wall;
    tick(wall);
    active++;
    const b = bucket(minuteStart(t), true);
    b.requests++;
    b.dirty = true;
    if (active > b.peak) b.peak = active;
    events.push({ t, d: 1 });
  }

  function noteEnd(ts = now()) {
    const t = Number.isFinite(ts) ? ts : now();
    tick(t);
    active = Math.max(0, active - 1);
    const b = bucket(minuteStart(t), active > 0);
    if (b) {
      if (active > b.peak) b.peak = active;
      b.dirty = true;
    }
    events.push({ t, d: -1 });
  }

  // 启动回填时把已结束请求塞进事件环,让秒级视图重启后也有最近窗口可看。
  // 不改 active/requests(这些由日志分钟回填负责),只提供 interval 供秒级 sweep。
  function seedInterval(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    events.push({ t: start, d: 1 }, { t: end, d: -1 });
  }

  function flush() {
    const wall = now();
    tick(wall);
    const rows = [];
    for (const [m, b] of minutes) if (b.dirty) rows.push([m, b.activeMs, b.peak, b.requests]);
    if (rows.length) {
      db.transaction(() => {
        for (const r of rows) upsertMinute.run(...r);
      })();
      for (const [m, b] of minutes) {
        if (!b.dirty) continue;
        b.dirty = false;
        flushed.add(m);
      }
    }
    // 已落库的旧分钟从内存清掉;保留最近 5 分钟供 snapshot 合并未落库部分。
    const keepFrom = minuteStart(wall) - 5 * MINUTE;
    for (const m of minutes.keys()) if (m < keepFrom) { minutes.delete(m); flushed.delete(m); }
    pruneEvents(wall - eventRetentionMs);
    // 旧分钟行一天清一次就够;放在 flush 里,避免再开一个定时器。
    if (wall - lastPrune > 6 * 3600_000) {
      lastPrune = wall;
      pruneMinutes();
    }
  }

  function importMinutes(map, { before = minuteStart(now()), days = minuteRetentionDays } = {}) {
    const rows = [...map.entries()].filter(([m]) => m < before).sort((a, b) => a[0] - b[0]);
    if (!rows.length) return 0;
    // 分批事务:30 天分钟数约 4 万行,一次事务太大;500 行一批既快又不长时间占写锁。
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const part = rows.slice(i, i + BATCH);
      db.transaction(() => {
        for (const [m, b] of part) upsertMinute.run(m, Math.max(0, Math.round(b.activeMs)), Math.max(0, Math.round(b.peak)), Math.max(0, Math.round(b.requests)));
      })();
      // 回填值来自完整请求日志,已覆盖这些分钟;丢掉同分钟的内存桶,避免 snapshot 再累加一次。
      for (const [m] of part) { minutes.delete(m); flushed.delete(m); }
    }
    pruneMinutes(days);
    return rows.length;
  }

  function pruneMinutes(days = minuteRetentionDays) {
    const cutoff = minuteStart(now() - Math.max(1, days) * 86400_000);
    deleteBefore.run(cutoff);
  }

  function eventList(from, to) {
    // 重叠加减:在 from 之前开始、to 之前结束的事件要算进初始 active。
    const evs = events.filter(e => e.t <= to && e.t >= from - eventRetentionMs);
    evs.sort((a, b) => (a.t - b.t) || (a.d - b.d));   // 同一时刻先 -1 再 +1
    return evs;
  }

  function addSegment(start, end, count, buckets) {
    if (count <= 0 || end <= start) return;
    let cursor = secondStart(start);
    while (cursor < end) {
      const segStart = Math.max(start, cursor);
      const segEnd = Math.min(end, cursor + SECOND);
      if (segEnd > segStart) {
        let b = buckets.get(cursor);
        if (!b) { b = { activeMs: 0, peak: 0, requests: 0 }; buckets.set(cursor, b); }
        b.activeMs += (segEnd - segStart) * count;
        if (count > b.peak) b.peak = count;
      }
      cursor += SECOND;
    }
  }

  function snapshotSecond(from, to, wall = now()) {
    tick(wall);
    const rangeFrom = Math.max(from, wall - eventRetentionMs);
    const rangeTo = Math.min(to, wall);
    const evs = eventList(rangeFrom, rangeTo);
    const buckets = new Map();
    let count = 0;
    let idx = 0;
    while (idx < evs.length && evs[idx].t < rangeFrom) {
      count += evs[idx].d;
      if (count < 0) count = 0;
      idx++;
    }
    let cursor = rangeFrom;
    for (; idx < evs.length; idx++) {
      const e = evs[idx];
      if (e.t > rangeTo) break;
      if (e.t > cursor) addSegment(cursor, e.t, count, buckets);
      count = Math.max(0, count + e.d);
      if (e.d > 0) {
        const key = secondStart(e.t);
        let b = buckets.get(key);
        if (!b) { b = { activeMs: 0, peak: 0, requests: 0 }; buckets.set(key, b); }
        b.requests++;
      }
      cursor = Math.max(cursor, e.t);
    }
    if (rangeTo > cursor) addSegment(cursor, rangeTo, count, buckets);

    const first = secondStart(rangeFrom);
    const last = secondStart(rangeTo);
    const step = Math.max(SECOND, Math.ceil((last - first + SECOND) / MAX_SECOND_POINTS) * SECOND);
    const points = [];
    let totalActiveMs = 0, peak = 0, requests = 0;
    for (let t = first; t <= last; t += step) {
      let activeMs = 0, pointPeak = 0, pointRequests = 0;
      for (let s = t; s < t + step && s <= last; s += SECOND) {
        const b = buckets.get(s);
        if (b) {
          activeMs += b.activeMs;
          pointPeak = Math.max(pointPeak, b.peak);
          pointRequests += b.requests;
        }
      }
      const denomMs = overlap(t, t + step, rangeFrom, rangeTo);
      if (denomMs > 0) {
        points.push({ t, activeMs, denomMs, avg: activeMs / denomMs, peak: pointPeak, requests: pointRequests });
        totalActiveMs += activeMs;
        peak = Math.max(peak, pointPeak);
        requests += pointRequests;
      }
    }
    return {
      granularity: "second",
      bucketMs: step,
      from: rangeFrom,
      to: rangeTo,
      current: active,
      summary: {
        avg: rangeTo > rangeFrom ? totalActiveMs / (rangeTo - rangeFrom) : 0,
        peak,
        requests,
      },
      points,
    };
  }

  function snapshotMinute(from, to, wall = now()) {
    tick(wall);
    const rangeFrom = Math.max(from, wall - minuteRetentionDays * 86400_000);
    const rangeTo = Math.min(to, wall);
    const first = minuteStart(rangeFrom);
    const last = minuteStart(rangeTo);
    const stored = storedRange.all(first, last);
    const byMinute = new Map();
    for (const r of stored) byMinute.set(r.minute, { activeMs: r.active_ms, peak: r.peak, requests: r.requests });
    for (const [m, b] of minutes) {
      if (m < first || m > last) continue;
      const prev = byMinute.get(m) || { activeMs: 0, peak: 0, requests: 0 };
      if (flushed.has(m)) {
        // 本进程已把该分钟完整落库:内存桶是权威值,不叠加。
        byMinute.set(m, { activeMs: b.activeMs, peak: Math.max(b.peak, prev.peak), requests: b.requests });
      } else {
        // 进程重启后同一分钟可能已有上一进程的行:两边都保留。
        byMinute.set(m, { activeMs: prev.activeMs + b.activeMs, peak: Math.max(prev.peak, b.peak), requests: prev.requests + b.requests });
      }
    }
    const raw = [];
    let totalActiveMs = 0, peak = 0, requests = 0;
    for (let m = first; m <= last; m += MINUTE) {
      const b = byMinute.get(m) || { activeMs: 0, peak: 0, requests: 0 };
      const denomMs = overlap(m, m + MINUTE, rangeFrom, rangeTo);
      if (denomMs <= 0) continue;
      raw.push({ t: m, activeMs: b.activeMs, denomMs, avg: b.activeMs / denomMs, peak: b.peak, requests: b.requests });
      totalActiveMs += b.activeMs;
      peak = Math.max(peak, b.peak);
      requests += b.requests;
    }
    const step = Math.max(1, Math.ceil(raw.length / MAX_MINUTE_POINTS));
    const points = [];
    for (let i = 0; i < raw.length; i += step) {
      const part = raw.slice(i, i + step);
      const activeMs = part.reduce((s, p) => s + p.activeMs, 0);
      const denomMs = part.reduce((s, p) => s + p.denomMs, 0);
      points.push({
        t: part[0].t,
        activeMs,
        denomMs,
        avg: denomMs > 0 ? activeMs / denomMs : 0,
        peak: Math.max(...part.map(p => p.peak)),
        requests: part.reduce((s, p) => s + p.requests, 0),
      });
    }
    return {
      granularity: "minute",
      bucketMs: step * MINUTE,
      from: rangeFrom,
      to: rangeTo,
      current: active,
      summary: {
        avg: rangeTo > rangeFrom ? totalActiveMs / (rangeTo - rangeFrom) : 0,
        peak,
        requests,
      },
      points,
    };
  }

  let timer = null;
  if (autoTimer) {
    timer = setInterval(() => { try { flush(); } catch (err) { log(`[concurrency] flush 失败: ${err.message}`); } }, flushMs);
    timer.unref?.();
  }

  return {
    noteStart, noteEnd, seedInterval, flush, importMinutes, pruneMinutes,
    snapshotSecond, snapshotMinute,
    get current() { return active; },
    get startedAt() { return createdAt; },
    dispose() { if (timer) clearInterval(timer); timer = null; },
  };
}

// ─── 请求日志回填 ────────────────────────────────────────────────────────────
// 只走后台(启动后延迟),不阻塞服务启动;逐文件 readline,单文件结束让出一次事件循环。
// 日志行形状见 server.mjs appendRequestLine: t=ISO 完成时刻, ms=请求总耗时。
// start = Date.parse(t) - ms, 与代理里的 reqLog.start / finish 完全一致。
export async function backfillConcurrencyFromRequestLogs(tracker, {
  dir,
  days = 7,
  now = () => Date.now(),
  log = console.log,
  seedSeconds = true,
} = {}) {
  if (!tracker || !dir) return { files: 0, intervals: 0, minutes: 0 };
  const today = new Date(now() + 8 * 3600_000).toISOString().slice(0, 10);
  const files = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.parse(today + "T00:00:00Z") - i * 86400_000).toISOString().slice(0, 10);
    const file = path.join(dir, `requests-${d}.log`);
    if (fs.existsSync(file)) files.push(file);
  }
  if (!files.length) return { files: 0, intervals: 0, minutes: 0 };

  const minuteMap = new Map();   // minuteStart → { activeMs, peak, requests }
  const eventRetentionMs = 6 * 3600_000;
  let intervals = 0;
  const startedAt = now();
  const liveSince = Number(tracker.startedAt) || startedAt;

  for (const file of files) {
    const list = [];
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      const text = line.trim();
      if (!text) continue;
      let obj;
      try { obj = JSON.parse(text); } catch { continue; }
      const end = Date.parse(obj.t);
      const ms = Number(obj.ms);
      if (!Number.isFinite(end) || !Number.isFinite(ms) || ms < 0) continue;
      const start = end - ms;
      if (start > end) continue;
      list.push({ start, end });
    }
    if (!list.length) continue;
    intervals += list.length;

    // 1) 分钟 activeMs / requests:跨分钟的请求按重叠时长拆开,请求数记在开始分钟。
    for (const { start, end } of list) {
      const first = minuteStart(start);
      const last = minuteStart(end);
      for (let m = first; m <= last; m += MINUTE) {
        const ov = overlap(m, m + MINUTE, start, end);
        if (ov <= 0) continue;
        let b = minuteMap.get(m);
        if (!b) { b = { activeMs: 0, peak: 0, requests: 0 }; minuteMap.set(m, b); }
        b.activeMs += ov;
        if (m === first) b.requests++;
      }
    }

    // 2) 峰值:按开始/结束事件 sweep;active 跨过的整分钟也要补峰值。
    //    同一文件内先 -1 再 +1,避免「一个结束一个开始」被瞬时算成 2。
    const evs = [];
    for (const { start, end } of list) evs.push({ t: start, d: 1 }, { t: end, d: -1 });
    evs.sort((a, b) => (a.t - b.t) || (a.d - b.d));
    let live = 0, lastMin = null, idx = 0;
    const bump = (m, n) => {
      if (n <= 0) return;
      let b = minuteMap.get(m);
      if (!b) { b = { activeMs: 0, peak: 0, requests: 0 }; minuteMap.set(m, b); }
      if (n > b.peak) b.peak = n;
    };
    while (idx < evs.length) {
      const t = evs[idx].t;
      const m = minuteStart(t);
      if (lastMin !== null && live > 0) {
        for (let x = lastMin; x < m; x += MINUTE) bump(x, live);
      }
      while (idx < evs.length && evs[idx].t === t) {
        live = Math.max(0, live + evs[idx].d);
        idx++;
      }
      bump(m, live);
      lastMin = m;
    }

    // 3) 最近窗口塞回内存事件环:服务重启后秒级图仍有历史,不必等新请求重新积累。
    for (const { start, end } of list) {
      // 只补「本进程启动前就已经结束」的请求:启动后结束的请求已经由 noteStart/noteEnd
      // 实时记进事件环,再 seed 一次会让秒级峰值翻倍。
      if (seedSeconds && end < liveSince && end >= startedAt - eventRetentionMs) tracker.seedInterval(start, end);
    }
    log(`[concurrency] 回填 ${path.basename(file)}: ${list.length} 条请求`);
    await new Promise(r => setImmediate(r));
  }

  const before = minuteStart(now());
  const written = tracker.importMinutes(minuteMap, { before });
  return { files: files.length, intervals, minutes: written };
}
