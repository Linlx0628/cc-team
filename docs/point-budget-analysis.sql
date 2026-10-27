-- 点数预算分析（SQLite / 生产环境只读）
--
-- 目的：用最近 90 天的点数消耗，给每个成员估算一个不易被日常波动打穿的周期预算。
-- 口径：1 点 = 10,000 计费计权 token；billing_weighted_tokens 已含点数倍率、用户系数、方案系数。
-- 时间：SQLite 用 UTC 存日期，这里统一 +8 小时取北京时间；范围取“昨天往前 90 天”，避免当天半天数据拉低均值。
--
-- 建议用法：
--   1. 先跑「查询 1」，拿到 avg_daily_points / p90_daily_points / max_daily_points；
--   2. suggested_* 是“日均 × 1.2 缓冲”和“P90 日消耗 × 周期”取较大值，可直接作为初始预算；
--   3. 新成员、刚启用点数或数据不足 90 天的，先给建议值的一半，观察一周再调。
--   4. 生产上先 EXPLAIN QUERY PLAN 确认走 idx_point_usage_bucket；只读账号执行。

-- ─────────────────────────────────────────────────────────────────────────────
-- 查询 1：按 point_usage 的实际点数消耗（推荐；要求已部署点数用量落桶）
-- ─────────────────────────────────────────────────────────────────────────────
WITH bounds AS (
  SELECT date('now', '+8 hours', '-1 day')       AS end_day,
         date('now', '+8 hours', '-90 day')      AS start_day
),
daily AS (
  SELECT pu.user_key,
         pu.bucket_start                     AS day,
         SUM(pu.billing_weighted_tokens) / 10000.0 AS points
  FROM point_usage pu
  JOIN bounds b
    ON pu.bucket_start BETWEEN b.start_day AND b.end_day
  WHERE pu.granularity = 'day'
  GROUP BY pu.user_key, pu.bucket_start
),
stats AS (
  SELECT user_key,
         COUNT(*)                    AS active_days,
         SUM(points)                 AS total_points_90d,
         AVG(points)                 AS avg_active_day,
         MAX(points)                 AS max_daily_points,
         SUM(points) / 90.0          AS avg_calendar_day
  FROM daily
  GROUP BY user_key
),
ranked AS (
  SELECT d.user_key, d.points,
         ROW_NUMBER() OVER (PARTITION BY d.user_key ORDER BY d.points) AS rn,
         COUNT(*)     OVER (PARTITION BY d.user_key)                   AS cnt
  FROM daily d
),
p90 AS (
  SELECT user_key,
         MAX(CASE WHEN rn >= cnt * 0.9 THEN points END) AS p90_daily_points
  FROM ranked
  GROUP BY user_key
),
recent30 AS (
  SELECT d.user_key, SUM(d.points) AS points_30d
  FROM daily d, bounds b
  WHERE d.day > date(b.end_day, '-30 day')
  GROUP BY d.user_key
)
SELECT
  s.user_key,
  COALESCE(
    (SELECT u.name FROM users u
      WHERE u.user_key = s.user_key
      ORDER BY u.last_active DESC LIMIT 1),
    substr(s.user_key, 1, 12)
  ) AS user_name,
  s.active_days,
  ROUND(s.total_points_90d, 1)     AS total_points_90d,
  ROUND(s.avg_calendar_day, 2)     AS avg_daily_points,
  ROUND(s.avg_active_day, 2)       AS avg_active_day_points,
  ROUND(p.p90_daily_points, 2)     AS p90_daily_points,
  ROUND(s.max_daily_points, 2)     AS max_daily_points,
  ROUND(COALESCE(r.points_30d, 0), 1) AS last_30d_points,
  -- 建议值用“日历日均 × 1.2”，P90 仅作诊断列，不直接乘 30（活跃天数少时会严重高估）
  MAX(1, CAST(ROUND(s.avg_calendar_day * 1.2) AS INTEGER)) AS suggested_daily_points,
  MAX(1, CAST(ROUND(s.avg_calendar_day * 7 * 1.2) AS INTEGER)) AS suggested_weekly_points,
  MAX(20, CAST(ROUND(s.avg_calendar_day * 30 * 1.2) AS INTEGER)) AS suggested_monthly_points
FROM stats s
LEFT JOIN p90 p      ON p.user_key = s.user_key
LEFT JOIN recent30 r ON r.user_key = s.user_key
ORDER BY s.total_points_90d DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 查询 2a：生产库还没有 point_usage / billing_weighted_tokens 时，先用旧表估算
-- 只读 usage_daily.weighted_tokens，不会因缺列报错。
-- 注意：这里没有点数倍率、用户系数、方案系数，也没有过滤“是否点数模式”，
--       得到的是“额度池计权 / 10000”的近似点数，只适合启用点数前做初始预算。
-- ─────────────────────────────────────────────────────────────────────────────
WITH bounds AS (
  SELECT date('now', '+8 hours', '-1 day')  AS end_day,
         date('now', '+8 hours', '-90 day') AS start_day
),
daily AS (
  SELECT user_key, date AS day,
         SUM(COALESCE(weighted_tokens,0)) / 10000.0 AS points
  FROM usage_daily
  WHERE date BETWEEN (SELECT start_day FROM bounds) AND (SELECT end_day FROM bounds)
  GROUP BY user_key, date
),
stats AS (
  SELECT user_key, COUNT(*) AS active_days, SUM(points) AS total_points_90d,
         AVG(points) AS avg_active_day, MAX(points) AS max_daily_points,
         SUM(points) / 90.0 AS avg_calendar_day
  FROM daily GROUP BY user_key
),
ranked AS (
  SELECT user_key, points,
         ROW_NUMBER() OVER (PARTITION BY user_key ORDER BY points) AS rn,
         COUNT(*)     OVER (PARTITION BY user_key)                   AS cnt
  FROM daily
),
p90 AS (
  SELECT user_key,
         MAX(CASE WHEN rn >= cnt * 0.9 THEN points END) AS p90_daily_points
  FROM ranked GROUP BY user_key
)
SELECT s.user_key,
       COALESCE((SELECT u.name FROM users u WHERE u.user_key=s.user_key
                 ORDER BY u.last_active DESC LIMIT 1), substr(s.user_key,1,12)) AS user_name,
       s.active_days,
       ROUND(s.total_points_90d,1) AS total_points_90d,
       ROUND(s.avg_calendar_day,2) AS avg_daily_points,
       ROUND(p.p90_daily_points,2) AS p90_daily_points,
       ROUND(s.max_daily_points,2) AS max_daily_points,
       MAX(1, CAST(ROUND(s.avg_calendar_day*1.2) AS INTEGER)) AS suggested_daily_points,
       MAX(1, CAST(ROUND(s.avg_calendar_day*7*1.2) AS INTEGER)) AS suggested_weekly_points,
       MAX(20, CAST(ROUND(s.avg_calendar_day*30*1.2) AS INTEGER)) AS suggested_monthly_points
FROM stats s
LEFT JOIN p90 p ON p.user_key = s.user_key
ORDER BY s.total_points_90d DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 查询 2b：点数量表已存在、且想看“全部流量”的回退口径
-- 注意：会把非点数模式的额度池用量也折算成点数；billing_weighted_tokens 可能为 NULL。
-- 旧生产库没有 billing_weighted_tokens 列时不要跑这条，会报 no such column。
-- ─────────────────────────────────────────────────────────────────────────────
-- WITH bounds AS (
--   SELECT date('now', '+8 hours', '-1 day')  AS end_day,
--          date('now', '+8 hours', '-90 day') AS start_day
-- ),
-- daily AS (
--   SELECT ud.user_key, ud.date AS day,
--          SUM(COALESCE(ud.billing_weighted_tokens, ud.weighted_tokens)) / 10000.0 AS points
--   FROM usage_daily ud, bounds b
--   WHERE ud.date BETWEEN b.start_day AND b.end_day
--   GROUP BY ud.user_key, ud.date
-- ),
-- stats AS (
--   SELECT user_key, COUNT(*) AS active_days, SUM(points) AS total_points_90d,
--          AVG(points) AS avg_active_day, MAX(points) AS max_daily_points,
--          SUM(points) / 90.0 AS avg_calendar_day
--   FROM daily GROUP BY user_key
-- )
-- SELECT user_key,
--        active_days,
--        ROUND(total_points_90d, 1) AS total_points_90d,
--        ROUND(avg_calendar_day, 2) AS avg_daily_points,
--        ROUND(max_daily_points, 2) AS max_daily_points,
--        MAX(1, CAST(ROUND(avg_calendar_day * 1.2) AS INTEGER)) AS suggested_daily_points,
--        MAX(1, CAST(ROUND(avg_calendar_day * 7 * 1.2) AS INTEGER)) AS suggested_weekly_points,
--        MAX(20, CAST(ROUND(avg_calendar_day * 30 * 1.2) AS INTEGER)) AS suggested_monthly_points
-- FROM stats
-- ORDER BY total_points_90d DESC;

-- ─────────────────────────────────────────────────────────────────────────────
-- 查询 3：当前配置的基础预算 / 用户系数（config.json 不在 SQLite，需在应用侧对照）
-- 如果生产环境把 config.json 也同步进库，可改成自己的配置表；否则把 user_key 和下面
-- 查询结果人工对照。临时点数 / 重置基线在库里，可以直接查：
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT user_key, SUM(points) AS active_temp_points, MIN(expires_at) AS earliest_expiry
-- FROM point_grants
-- WHERE revoked_at IS NULL
--   AND starts_at <= date('now', '+8 hours')
--   AND expires_at >= date('now', '+8 hours')
-- GROUP BY user_key;
--
-- SELECT user_key, period_start, reset_baseline_weighted, datetime(reset_at / 1000, 'unixepoch', '+8 hours') AS reset_at
-- FROM point_period_ops
-- ORDER BY reset_at DESC
-- LIMIT 50;
