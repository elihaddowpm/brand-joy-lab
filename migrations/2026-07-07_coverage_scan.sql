-- v9.17 — Mandatory coverage scan infrastructure
--
-- Adds:
--   1. bjl_query_jobs.query_embedding — persist the query's OpenAI
--      embedding once per job so downstream functions can read it.
--   2. bjl_query_jobs.deep_coverage_scan — flag set by enqueue; when
--      true, the investigator runs the mandatory coverage scan.
--   3. bjl_coverage_scan(query_embedding, threshold, mean) — for each
--      of the 16 primary_topic centers, returns whether a semantically
--      relevant item exists, the highest-joy relevant item, that
--      item's delta from the corpus mean, and the topic's overall
--      signal strength (min distance across any item in that topic).
--   4. bjl_coverage_scan_by_job(job_id) — convenience wrapper that
--      reads the persisted embedding for a job and calls the
--      underlying scan. Investigator uses this so it never has to
--      inline the 1536-float vector literal.

-- --------------------------------------------------------------------
-- 1. Column additions on bjl_query_jobs
-- --------------------------------------------------------------------
ALTER TABLE bjl_query_jobs
  ADD COLUMN IF NOT EXISTS query_embedding vector(1536);

ALTER TABLE bjl_query_jobs
  ADD COLUMN IF NOT EXISTS deep_coverage_scan boolean NOT NULL DEFAULT false;

-- --------------------------------------------------------------------
-- 2. The scan function
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bjl_coverage_scan(
  query_embedding vector(1536),
  relevance_threshold numeric DEFAULT 0.45,
  mean_score numeric DEFAULT 46.78
)
RETURNS TABLE(
  primary_topic       text,
  has_relevant        boolean,
  top_item_label      text,
  top_joy_score       numeric,
  delta_from_mean     numeric,
  topic_min_distance  numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH topics AS (
    SELECT unnest(ARRAY[
      'travel', 'food_beverage', 'entertainment', 'personal_state',
      'financial_services', 'civic_political', 'retail', 'brand_dynamics',
      'home_life', 'telecommunications', 'occasions_seasonal', 'health_wellness',
      'ad_testing', 'work_career', 'kids_family', 'general_joy'
    ]) AS primary_topic
  ),
  scored AS (
    SELECT
      q.primary_topic,
      s.item_name,
      s.joy_index,
      (s.embedding <=> query_embedding)::numeric AS distance
    FROM bjl_scores s
    JOIN bjl_questions_v2 q ON s.question_id = q.question_id
    WHERE s.embedding IS NOT NULL
      AND s.joy_index IS NOT NULL
  ),
  relevant AS (
    SELECT * FROM scored WHERE distance <= relevance_threshold
  ),
  top_relevant AS (
    SELECT DISTINCT ON (primary_topic)
      primary_topic, item_name, joy_index, distance
    FROM relevant
    ORDER BY primary_topic, joy_index DESC, distance ASC
  ),
  topic_min AS (
    SELECT primary_topic, MIN(distance) AS topic_min_distance
    FROM scored
    GROUP BY primary_topic
  )
  SELECT
    t.primary_topic,
    (tr.item_name IS NOT NULL) AS has_relevant,
    tr.item_name AS top_item_label,
    tr.joy_index AS top_joy_score,
    CASE WHEN tr.joy_index IS NOT NULL
      THEN (tr.joy_index - mean_score)
      ELSE NULL
    END AS delta_from_mean,
    tm.topic_min_distance
  FROM topics t
  LEFT JOIN top_relevant tr ON tr.primary_topic = t.primary_topic
  LEFT JOIN topic_min tm    ON tm.primary_topic = t.primary_topic
  ORDER BY has_relevant DESC, top_joy_score DESC NULLS LAST, tm.topic_min_distance ASC NULLS LAST;
$$;

-- --------------------------------------------------------------------
-- 3. Job-keyed wrapper
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bjl_coverage_scan_by_job(
  job_id uuid,
  relevance_threshold numeric DEFAULT 0.45,
  mean_score numeric DEFAULT 46.78
)
RETURNS TABLE(
  primary_topic       text,
  has_relevant        boolean,
  top_item_label      text,
  top_joy_score       numeric,
  delta_from_mean     numeric,
  topic_min_distance  numeric
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  emb vector(1536);
BEGIN
  SELECT query_embedding INTO emb
  FROM bjl_query_jobs
  WHERE bjl_query_jobs.job_id = bjl_coverage_scan_by_job.job_id;

  IF emb IS NULL THEN
    RAISE EXCEPTION 'No query_embedding stored for job %', job_id;
  END IF;

  RETURN QUERY
    SELECT * FROM bjl_coverage_scan(emb, relevance_threshold, mean_score);
END;
$$;

-- --------------------------------------------------------------------
-- 4. Grants — same pattern as other RPC-callable functions
-- --------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION bjl_coverage_scan(vector, numeric, numeric)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION bjl_coverage_scan_by_job(uuid, numeric, numeric)
  TO anon, authenticated, service_role;
