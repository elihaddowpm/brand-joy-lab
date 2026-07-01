-- v9.8 — Rewrite bjl_public_chat_analytics_daily to bucket by actual
-- query timestamp (bjl_query_jobs.created_at) instead of session
-- started_at. Fixes the "all questions rolling into first-visit day"
-- bug: because sessions are lifetime per-visitor rows, their
-- started_at never advances, so the previous view showed every
-- future question stacked on the visitor's first-ever visit date.
--
-- The new view derives daily activity from the query event stream:
--   unique_visitors    = distinct visitor_id among jobs that day
--   total_queries      = distinct job_id count that day
--   converted_visitors = distinct session_id of leads submitted that day
--   leads_submitted    = distinct lead ids with status='submitted' that day
--   leads_declined     = distinct lead ids with status='declined' that day
--   conversion_rate    = converted_visitors / unique_visitors * 100
--
-- Sessions retain their lifetime-aggregate semantics for the summary
-- view (avg / median / max queries per visitor over the visitor's
-- entire history). No schema change; view swap only.

CREATE OR REPLACE VIEW bjl_public_chat_analytics_daily AS
WITH job_days AS (
  SELECT
    date(created_at AT TIME ZONE 'UTC') AS day,
    extra_context->>'visitor_id'         AS visitor_id,
    job_id
  FROM bjl_query_jobs
  WHERE query_type = 'public_chat'
    AND extra_context->>'visitor_id' IS NOT NULL
),
lead_days AS (
  SELECT
    date(created_at AT TIME ZONE 'UTC') AS day,
    status,
    id,
    session_id
  FROM bjl_public_questions
)
SELECT
  COALESCE(j.day, l.day)                                                    AS day,
  count(DISTINCT j.visitor_id)                                              AS unique_visitors,
  count(DISTINCT j.job_id)                                                  AS total_queries,
  count(DISTINCT l.session_id) FILTER (WHERE l.status = 'submitted')        AS converted_visitors,
  count(DISTINCT l.id)         FILTER (WHERE l.status = 'submitted')        AS leads_submitted,
  count(DISTINCT l.id)         FILTER (WHERE l.status = 'declined')         AS leads_declined,
  round(
    (100.0 * NULLIF(count(DISTINCT l.session_id) FILTER (WHERE l.status = 'submitted'), 0)::numeric)
      / NULLIF(count(DISTINCT j.visitor_id), 0)::numeric,
    1
  )                                                                         AS conversion_rate_pct
FROM job_days j
FULL JOIN lead_days l ON l.day = j.day
GROUP BY COALESCE(j.day, l.day);
