-- v8.4 — Public chat analytics views
--
-- Two views give the team a clean read on public chat usage without
-- needing custom SQL each time:
--
--   bjl_public_chat_analytics_daily    : one row per calendar day, with
--                                        unique visitors, total queries,
--                                        leads (submitted + declined),
--                                        and conversion rate.
--   bjl_public_chat_analytics_summary  : single-row rollup of all-time +
--                                        last-7-day + last-30-day totals
--                                        plus per-visitor question
--                                        distribution (mean/median).
--
-- Both views read from bjl_public_sessions (the canonical visitor
-- identity store) joined to bjl_public_questions (the lead capture
-- table). bjl_query_jobs is intentionally not consulted: the session
-- table's query_count is incremented atomically on each chat POST and
-- is the authoritative per-visitor question count.
--
-- Anyone with workbench access can run these directly:
--   SELECT * FROM bjl_public_chat_analytics_summary;
--   SELECT * FROM bjl_public_chat_analytics_daily ORDER BY day DESC LIMIT 30;


CREATE OR REPLACE VIEW bjl_public_chat_analytics_daily AS
WITH session_days AS (
  SELECT
    DATE(started_at AT TIME ZONE 'UTC') AS day,
    id,
    query_count,
    converted
  FROM bjl_public_sessions
),
lead_days AS (
  SELECT
    DATE(created_at AT TIME ZONE 'UTC') AS day,
    status,
    trigger_source,
    id
  FROM bjl_public_questions
)
SELECT
  COALESCE(s.day, l.day)                                         AS day,
  COUNT(DISTINCT s.id)                                           AS unique_visitors,
  COALESCE(SUM(s.query_count), 0)                                AS total_queries,
  COUNT(DISTINCT s.id) FILTER (WHERE s.converted)                AS converted_visitors,
  COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'submitted')     AS leads_submitted,
  COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'declined')      AS leads_declined,
  ROUND(
    100.0 *
    NULLIF(COUNT(DISTINCT s.id) FILTER (WHERE s.converted), 0) /
    NULLIF(COUNT(DISTINCT s.id), 0),
    1
  )                                                              AS conversion_rate_pct
FROM session_days s
FULL OUTER JOIN lead_days l ON l.day = s.day
GROUP BY COALESCE(s.day, l.day)
ORDER BY day DESC;

COMMENT ON VIEW bjl_public_chat_analytics_daily IS
  'v8.4 — One row per UTC day. Unique visitors, total queries, conversions, leads submitted/declined, conversion %.';


CREATE OR REPLACE VIEW bjl_public_chat_analytics_summary AS
WITH session_stats AS (
  SELECT
    COUNT(*)                                                     AS lifetime_visitors,
    COUNT(*) FILTER (WHERE last_active_at > NOW() - INTERVAL '7 days')  AS visitors_7d,
    COUNT(*) FILTER (WHERE last_active_at > NOW() - INTERVAL '30 days') AS visitors_30d,
    COALESCE(SUM(query_count), 0)                                AS lifetime_queries,
    COALESCE(SUM(query_count) FILTER (WHERE last_active_at > NOW() - INTERVAL '7 days'), 0)  AS queries_7d,
    COALESCE(SUM(query_count) FILTER (WHERE last_active_at > NOW() - INTERVAL '30 days'), 0) AS queries_30d,
    COUNT(*) FILTER (WHERE converted)                            AS lifetime_converted,
    COUNT(*) FILTER (WHERE converted AND last_active_at > NOW() - INTERVAL '7 days')   AS converted_7d,
    COUNT(*) FILTER (WHERE converted AND last_active_at > NOW() - INTERVAL '30 days')  AS converted_30d,
    ROUND(AVG(query_count)::numeric, 1)                          AS mean_queries_per_visitor,
    ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY query_count))::numeric, 1) AS median_queries_per_visitor,
    MAX(query_count)                                             AS max_queries_one_visitor
  FROM bjl_public_sessions
),
lead_stats AS (
  SELECT
    COUNT(*) FILTER (WHERE status = 'submitted')                 AS lifetime_leads_submitted,
    COUNT(*) FILTER (WHERE status = 'declined')                  AS lifetime_leads_declined,
    COUNT(*) FILTER (WHERE status = 'submitted'
                       AND created_at > NOW() - INTERVAL '7 days')  AS leads_submitted_7d,
    COUNT(*) FILTER (WHERE status = 'submitted'
                       AND created_at > NOW() - INTERVAL '30 days') AS leads_submitted_30d
  FROM bjl_public_questions
)
SELECT
  -- Lifetime
  s.lifetime_visitors, s.lifetime_queries, s.lifetime_converted,
  l.lifetime_leads_submitted, l.lifetime_leads_declined,
  ROUND(100.0 * NULLIF(s.lifetime_converted, 0)::numeric / NULLIF(s.lifetime_visitors, 0), 1) AS lifetime_conversion_rate_pct,
  -- Last 7 days
  s.visitors_7d, s.queries_7d, s.converted_7d, l.leads_submitted_7d,
  ROUND(100.0 * NULLIF(s.converted_7d, 0)::numeric / NULLIF(s.visitors_7d, 0), 1) AS conversion_rate_7d_pct,
  -- Last 30 days
  s.visitors_30d, s.queries_30d, s.converted_30d, l.leads_submitted_30d,
  ROUND(100.0 * NULLIF(s.converted_30d, 0)::numeric / NULLIF(s.visitors_30d, 0), 1) AS conversion_rate_30d_pct,
  -- Engagement distribution
  s.mean_queries_per_visitor, s.median_queries_per_visitor, s.max_queries_one_visitor
FROM session_stats s
CROSS JOIN lead_stats l;

COMMENT ON VIEW bjl_public_chat_analytics_summary IS
  'v8.4 — Single-row dashboard summary. Lifetime + 7d + 30d visitor counts, queries, leads, conversion %.';
