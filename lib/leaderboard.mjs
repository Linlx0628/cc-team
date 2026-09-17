// lib/leaderboard.mjs —— 团队排行榜:单维度、按时间窗、跨用户。
//
// 两套数据源,口径必须对齐:
//   · usage_daily  —— token 用量 / 缓存 / 活跃度(date 列是北京日期串)
//   · tool_events  —— 代码行数 / 代码质量(经 productionSummary,派生指标那边已算好)
//
// 缓存率直接复用 production.mjs 的 contextHealth:它带 responses 协议修正。
// 少了那层修正,Codex 用户的分母会把缓存读算两遍,命中率被系统性压到 50% 上限。
//
// 时间窗一律按**北京日期**取区间,与 usage_daily.date、tool_events 的
// date(time,'+8 hours') 同口径,所以同一个 {from,to} 能同时喂给两套查询。

// 维度表。direction 指的是「好的方向」,前端据此画 ↑/↓ 与排序说明 ——
// 不要在前端硬编码方向,否则加维度要改两处。
//
// minSample:参与排名的最小样本量(硬门槛)。纯比值维度(缓存率/上下文健康度/效率比)
// 在小样本下波动极大 —— 本周只发 7 次请求的人可以靠 99.6% 压过 5607 次 96.6% 的人,
// 「再发两次」就能卡排名,这是排行榜的博弈漏洞。不达标者照常显示真实数值但标
// 「样本不足」,排到所有达标者之后。field 指向归并行(acc)上的样本量字段,label
// 用于界面文案。绝对计数维度(行数/token/请求数)小数值本身就是诚实的,不设门槛。
// 阈值是产品约定不是统计推导,所以不进环境变量 —— 改这里 + 改 wiki 即可。
const DIMENSIONS = [
  {
    key: "cache_rate", label: "缓存率", unit: "%", direction: "desc",
    hint: "缓存读 / (缓存读 + 输入)。越高说明上下文复用越充分。本期请求 ≥50 次才参与排名,不足则标注「样本不足」。",
    minSample: { field: "requests", min: 50, label: "请求数" },
  },
  {
    key: "code_quality", label: "代码质量", unit: "分", direction: "desc",
    hint: "编辑失败率、验证密度、改写率在本次队列内归一化后加权。本期代码编辑 ≥10 次才参与评分,不足则不评分。",
    minSample: { field: "editCount", min: 10, label: "编辑次数" },
  },
  {
    key: "code_lines", label: "代码行数", unit: "行", direction: "desc",
    hint: "净增行数(增 - 删),只统计文件类工具(文档类文件不计)。反映产出体量。",
  },
  {
    key: "tokens", label: "token 用量", unit: "token", direction: "desc",
    hint: "输入 + 输出原始 token。这是消耗量,不等于效率 —— 与「效率比」对照看。",
  },
  {
    key: "efficiency", label: "效率比", unit: "token/行", direction: "asc",
    hint: "每净增一行代码消耗的输出 token。越低越省。本期净增 ≥50 行才参与排名,不足则标注「样本不足」。",
    minSample: { field: "netLines", min: 50, label: "净增行数" },
  },
  {
    key: "context_health", label: "上下文健康度", unit: "token/次", direction: "asc",
    hint: "平均单轮新增上下文 = 未命中缓存的输入 token / 请求数。越低说明缓存复用越充分、会话越连续。本期请求 ≥50 次才参与排名,不足则标注「样本不足」。",
    minSample: { field: "requests", min: 50, label: "请求数" },
  },
  {
    key: "activity", label: "活跃度", unit: "次", direction: "desc",
    hint: "请求数。反映参与频率,不反映产出质量。",
  },
];
const DIMENSION_MAP = new Map(DIMENSIONS.map((x) => [x.key, x]));
const DEFAULT_DIMENSION = "cache_rate";

const WINDOWS = new Set(["today", "week", "month"]);
const DEFAULT_WINDOW = "week";

// 综合质量分权重。三者会先归一化再按比例加权,所以不必凑满 1 —— 调比例即可。
const QUALITY_WEIGHTS = { fail: 0.5, verify: 0.3, rewrite: 0.2 };
// 质量分参与门槛:代码编辑 ≥10 次才进入归一化队列。与 code_quality 维度的
// minSample 同值 —— 两处注释互指,改一处必须同步另一处。
// 只编辑一两次的人 fail_rate/rewrite_rate 极易停在 0,min-max 归一化会把全队的
// min 拉到TA们身上,重度开发者反被压到劣势端 —— 「不写代码的人拿满分」就是这么来的。
const QUALITY_MIN_EDITS = 10;

function windowRange(win, cnDate, cnWeekStartDate) {
  const to = cnDate();
  if (win === "today") return { from: to, to };
  if (win === "week") return { from: cnWeekStartDate(), to };
  return { from: `${to.slice(0, 7)}-01`, to }; // month
}

// 综合质量分:在本次窗口的队列内做 min-max 归一化,再加权。返回 { scores, note }。
//
// 只有「窗口内代码编辑 ≥ QUALITY_MIN_EDITS 次」的人参与归一化(门槛理由见常量定义处)。
// 编辑 1~9 次的人分数给 null,但不是「无数据」—— 他们有观测,只是样本不足以评出
// 可信的相对分;榜单上标「样本不足」而非「无数据」(见 tierOf)。
//
// 少于 2 个达标者时直接全员 null:三个信号必然全部 max===min,norm 全给 0.5,
// 于是人人 50 分。那看起来像个测量结果,其实不是 —— 单人群里「50 分」没有任何含义,
// 却会被当成真分数读。宁可留空并写明原因,由 note 字段承担说明。
function computeQuality(prodRows) {
  const eligible = prodRows.filter((r) => (r.edit_count || 0) >= QUALITY_MIN_EDITS);
  if (eligible.length < 2) {
    return {
      scores: new Map(),
      note: eligible.length === 0
        ? `本期无人达到编辑门槛(≥${QUALITY_MIN_EDITS} 次代码编辑),质量分不评分`
        : `本期达编辑门槛(≥${QUALITY_MIN_EDITS} 次代码编辑)的仅 ${eligible.length} 人,质量分需要至少 2 人参与才有区分度`,
    };
  }
  const scores = new Map();

  const norm = (vals) => {
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    // 全队取值相同(含队列里只有一个人)时无法区分优劣,统一给中性 0.5,而不是除零
    if (max === min) return vals.map(() => 0.5);
    return vals.map((v) => (v - min) / (max - min));
  };

  // 失败率与改写率越低越好,所以归一化后取反(1 - x)再加权
  const fails = norm(eligible.map((r) => r.fail_rate || 0));
  const verifies = norm(eligible.map((r) => r.verify_density || 0));
  const rewrites = norm(eligible.map((r) => r.rewrite_rate || 0));

  const w = QUALITY_WEIGHTS;
  const total = w.fail + w.verify + w.rewrite;
  eligible.forEach((r, i) => {
    const score = 100 * (w.fail * (1 - fails[i]) + w.verify * verifies[i] + w.rewrite * (1 - rewrites[i])) / total;
    scores.set(r.user_key, Math.round(score * 10) / 10);
  });
  return { scores, note: null };
}

// 跨用户展示 user_key 的唯一掩码规则。导出给 lib/sessions.mjs 复用 ——
// 两个模块各自实现一份格式化,迟早有一处改成 6 位。
export function maskKey(key) {
  const s = String(key ?? "");
  return s.length > 8 ? `${s.slice(0, 8)}****` : `${s}****`;
}

export function createLeaderboardReader(d) {
  const { cnDate, cnWeekStartDate, responsesProfileSet, productionSummary, contextHealth, knownUserKeys } = d;

  function getLeaderboard({ dimension, window: win, meKey } = {}) {
    const dimKey = DIMENSION_MAP.has(dimension) ? dimension : DEFAULT_DIMENSION;
    const winKey = WINDOWS.has(win) ? win : DEFAULT_WINDOW;
    const dim = DIMENSION_MAP.get(dimKey);
    const { from, to } = windowRange(winKey, cnDate, cnWeekStartDate);

    const db = d.db;
    const teamKeys = knownUserKeys ? knownUserKeys() : [];   // 全队真实 key,供桩归并与 cohort 用
    const usageRows = d.stmts.leaderboardUsageByUser.all(from, to);
    const prod = productionSummary(db, { from, to }); // { rows, zeroOutput }
    const health = contextHealth(db, { from, to, responsesProfiles: responsesProfileSet() });
    const { scores: quality, note: qualityNote } = computeQuality(prod.rows);

    // ── 归并成「每人一行」 ──
    const acc = new Map();
    const ensure = (key) => {
      let a = acc.get(key);
      if (!a) {
        a = {
          user_key: key, user_name: null, hasEdit: false,
          tokens: 0, requests: 0, active_days: 0,
          cache_read: 0, cacheRatio: null,
          newInput: 0,          // 协议修正后的新增输入,来自 contextHealth 的 denomI
          netLines: 0, editCount: 0, tokenPerLine: null, quality: null,
        };
        acc.set(key, a);
      }
      return a;
    };

    for (const r of usageRows) {
      const a = ensure(r.user_key);
      a.tokens = r.tokens || 0;
      a.requests = r.requests || 0;
      a.active_days = r.active_days || 0;
      a.cache_read = r.cache_read || 0;
    }
    for (const r of health) {
      const a = ensure(r.user_key);
      if (r.user_name) a.user_name = r.user_name;
      // contextHealth 在完全无缓存数据(denom=0)时给的是 ratio=0 而非 null
      // (production.mjs:688 附近)。照搬会把「没数据」显示成「0% 命中率」,是假数据。
      // cr 与 i 同时为 0 就说明这一格没有任何缓存/输入可算,归 null。
      a.cacheRatio = (r.cr === 0 && r.i === 0) ? null : (typeof r.ratio === "number" ? r.ratio * 100 : null);
      // denomI 的绝对值可信:contextHealth 关联 users 时已带上 profile(1:1),不会再按
      // 方案数放大。(此前只按 user_key 关联,一个绑 7 个方案的人 denomI 会虚高 7 倍,
      // 而各人倍数不同 —— 跨人比较必然出错。已在 production.mjs 修掉。)
      a.newInput = r.denomI || 0;
    }
    for (const r of prod.rows) {
      const a = ensure(r.user_key);
      if (!a.user_name && r.user_name) a.user_name = r.user_name;
      a.netLines = r.net_lines || 0;
      a.editCount = r.edit_count || 0;
      a.tokenPerLine = typeof r.token_per_line === "number" ? r.token_per_line : null;
      a.hasEdit = (r.edit_count || 0) > 0;
      a.quality = quality.has(r.user_key) ? quality.get(r.user_key) : null;
    }
    // 有 token 消耗但没有代码产出的人:只在 usage_daily 有行,这里补上显示名
    for (const r of prod.zeroOutput) {
      const a = ensure(r.user_key);
      if (!a.user_name && r.user_name) a.user_name = r.user_name;
    }

    // ── 把 12 字符桩并回完整 key ──
    // resolveUserKey(server.mjs:1446) 对**未知** key 只留前 12 字符,于是同一个人可能
    // 在 usage_daily 留下两条记录:完整 key 与 12 字符桩。桩能且仅能靠「前缀命中某个
    // 已知 key」认领回本人 —— 不能按名字合并,桩落库时的名字是 未知(jx-abcdef),和真名对不上。
    // key 是 jx- + 24 位随机串,两个 key 共享前 12 位的概率可忽略,所以前缀匹配是确定的。
    const stubToFull = new Map();
    for (const k of teamKeys) {
      const stub = String(k).slice(0, 12);
      if (stub !== k) stubToFull.set(stub, k);
    }
    for (const [key, a] of [...acc]) {
      const full = stubToFull.get(key);
      if (!full || full === key) continue;
      const t = ensure(full);
      t.tokens += a.tokens;
      t.requests += a.requests;
      t.cache_read += a.cache_read;
      t.newInput += a.newInput;
      // active_days 是「不同日期数」,两侧各自计数后相加会把同一天重复计。桩那一侧通常
      // 只有零星几天,取大者作近似比相加更接近真值(真值需要回表按完整 key 重算)。
      t.active_days = Math.max(t.active_days, a.active_days);
      // 比值与派生量不能相加:cacheRatio 保持完整 key 那侧的值(contextHealth 已按人
      // 算好),quality/tokenPerLine 也只在 prod 循环里按 key 赋值 —— 桩那一侧的整体
      // 数值是残缺的,拿它去补只会污染真身。只在真身确实为空时才拿走。
      if (t.cacheRatio == null && a.cacheRatio != null) t.cacheRatio = a.cacheRatio;
      if (t.quality == null && a.quality != null) t.quality = a.quality;
      if (t.tokenPerLine == null && a.tokenPerLine != null) t.tokenPerLine = a.tokenPerLine;
      t.netLines += a.netLines;
      t.editCount += a.editCount;   // 样本门槛按编辑次数计,漏加会让桩用户的样本被低估
      if (!t.user_name && a.user_name) t.user_name = a.user_name;
      t.hasEdit = t.hasEdit || a.hasEdit;
      acc.delete(key);
    }

    const valueOf = (a) => {
      switch (dimKey) {
        case "cache_rate": return a.cacheRatio;
        case "code_quality": return a.quality;
        case "code_lines": return a.netLines;
        case "tokens": return a.tokens;
        case "efficiency": return a.tokenPerLine;
        // 平均单轮新增上下文 = 协议修正后的新增输入 ÷ 请求数。denomI 已逐方案做过协议
        // 处理(Responses 扣掉缓存读),所以跨协议可比 —— 这正是旧口径「缓存重建占比」
        // 做不到的:那个分子只有 Anthropic 会上报。
        case "context_health": return a.requests > 0 ? a.newInput / a.requests : null;
        case "activity": return a.requests;
        default: return null;
      }
    };

    const rows = [...acc.values()].map((a) => ({ ...a, value: valueOf(a) }));

    // 三档分档:达标(ok) → 样本不足(low) → 无数据(none)。
    // 档位优先于数值排序且不受 direction 反转 —— 这是门槛的全部意义:
    // 小样本的高比值再漂亮,也只能待在达标者后面。
    // low 与 none 的区别是「有观测但不可信」vs「该维度没有任何观测」,信息量递减,
    // 所以 low 排在 none 之前、且仍按真实数值排序展示。
    // quality 特例:编辑 1~9 次的人 value 为 null(不参与归一化)但 editCount>0,
    // 归 low 而非 none —— 他们「编辑过,只是不足以评分」。
    const ms = dim.minSample;
    const tierOf = (a) => {
      if (!ms) return a.value == null ? "none" : "ok";
      const sample = a[ms.field] || 0;
      if (a.value != null) return sample >= ms.min ? "ok" : "low";
      return sample > 0 ? "low" : "none";
    };
    for (const r of rows) r.tier = tierOf(r);
    const TIER_ORDER = { ok: 0, low: 1, none: 2 };

    rows.sort((x, y) => {
      const d = TIER_ORDER[x.tier] - TIER_ORDER[y.tier];
      if (d) return d;
      // 并列时用请求数兜底,保证同一份数据每次排序结果一致
      const diff = dim.direction === "asc" ? x.value - y.value : y.value - x.value;
      return diff || (y.requests - x.requests) || String(x.user_key).localeCompare(String(y.user_key));
    });
    rows.forEach((r, i) => {
      r.rank = i + 1;
      r.isMe = !!meKey && r.user_key === meKey;
    });

    const out = rows.map((r) => ({
      rank: r.rank,
      user_key: maskKey(r.user_key),
      user_name: r.user_name || `未知(${String(r.user_key).slice(0, 8)})`,
      value: r.value == null ? null : Math.round(r.value * 10) / 10,
      isMe: r.isMe,
      low_sample: r.tier === "low",
      detail: {
        active_days: r.active_days,
        requests: r.requests,
        tokens: r.tokens,
        cache_read: r.cache_read,
        has_edit: r.hasEdit,
        edit_count: r.editCount,   // quality 门槛(编辑 ≥10 次)对用户可见
        net_lines: r.netLines,     // efficiency 门槛(净增 ≥50 行)对用户可见
      },
    }));

    const qualified = rows.filter((r) => r.tier === "ok").length;
    const thresholdNote = dim.minSample && qualified === 0 && out.length > 0
      ? `本期无人达到样本门槛(${dim.minSample.label} ≥ ${dim.minSample.min}),以下按原始数值排序,仅供参考`
      : null;

    return {
      window: winKey,
      from,
      to,
      dimension: dimKey,
      dimensionLabel: dim.label,
      direction: dim.direction,
      unit: dim.unit,
      hint: dim.hint,
      // 维度清单随响应下发,前端据此建切换器与「样本不足」文案 —— 单一事实来源,
      // 加维度只改这边
      dimensions: DIMENSIONS.map((x) => ({
        key: x.key, label: x.label, unit: x.unit, direction: x.direction,
        minSample: x.minSample || null,
      })),
      // 榜单可能只有一行(窗口内只有一个人在跑),那不是故障而是实情。
      // 把「本期 N 人活跃 · 共 M 人」显式给出来,界面才能说清为什么榜单这么短,
      // 而不是看起来像坏了。qualified 是过了样本门槛、真正参与排名的人数。
      cohort: {
        active: out.filter((r) => r.value != null).length,
        qualified,
        total: teamKeys.length,
        listed: out.length,
      },
      // 只在当前维度确实退化时才有值,界面原样展示:
      //   · 质量分需要至少 2 个达标者 / 无人达编辑门槛
      //   · 整榜无人过样本门槛(今日窗口常见)——此时所有人按原始数值展示
      note: [qualityNote, thresholdNote].filter(Boolean).join("；") || null,
      rows: out,
      me: out.find((r) => r.isMe) || null,
      generatedAt: new Date().toISOString(),
    };
  }

  return { getLeaderboard };
}
