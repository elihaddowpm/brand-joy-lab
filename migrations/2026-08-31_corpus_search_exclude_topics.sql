-- =====================================================================
-- bjl_corpus_search -- add exclude_topics, so the cross-domain arm cannot
-- hand back the one topic the cross-domain surface is forbidden to contain.
--
-- THE PROBLEM
--
-- cross_domain_items exists to show a connection AWAY from the topic the
-- question was about, and the provenance guard enforces that: an entry whose
-- primary_topic equals the home topic fails cross_domain_home_topic_bleed.
--
-- But bjl_corpus_search only ever had a POSITIVE topic filter. There was no
-- way to ask it for "anything except food_beverage". So a food question
-- searched the corpus, the corpus handed back food -- food_beverage is the
-- largest topic in bjl_items by a wide margin, 1160 items against 655 for
-- travel and 255 for retail -- and the synthesizer filed what it was given.
-- The guard then refused it, the whole synthesis was regenerated at a median
-- 80s, and often the surface was lost anyway.
--
-- The contamination rate predicts the damage almost exactly. Replaying the
-- real bjl_corpus_search calls from the four jobs that lost their entire
-- cross-domain surface on 2026-08-26/27:
--
--   job c6061f5f    118 rows returned, 67% food_beverage   ->  3 bled
--   job ad5a42e6     94 rows returned, 38% food_beverage   -> 22 bled
--   job b6514d6a    124 rows returned, 34% food_beverage   ->  2 bled
--   job 561a9e6e     59 rows returned,  8% food_beverage   ->  1 bled
--
-- ad5a42e6 did not bleed 22 rows out of carelessness. The arm gave it 36
-- food rows out of 94 and it had little else to file.
--
-- WHY A FILTER RATHER THAN A PROMPT RULE
--
-- Same reasoning as the thin band: make the wrong answer impossible to
-- produce rather than ask the model not to produce it. A prompt rule spends
-- a turn asking the synthesizer to discard rows the query could simply not
-- return, and it fails silently and expensively when ignored. With this
-- argument passed, a home-topic row never reaches the model, so the guard
-- check becomes a backstop instead of the thing doing the work.
--
-- The guard check STAYS. It is cheap, it is the only thing that would catch
-- a caller that forgets to pass exclude_topics, and nothing here is a reason
-- to stop verifying output against scratch.
--
-- NULL item_topic IS EXPLICITLY KEPT -- DEFENSIVELY, NOT TO FIX A REGRESSION
--
-- `item_topic <> ALL(...)` evaluates to NULL when item_topic is NULL, which
-- SQL treats as not-true, so a bare <> ALL would drop every untopiced row.
-- The IS NULL branch prevents that. But be honest about what it is worth
-- TODAY: nothing measurable. Those rows are already unreachable.
--
--   138 bjl_scores rows have a NULL item_topic
--    30 of those have a non-null joy_index, so only 30 could clear min_score
--     0 of those 30 have any of joy_modes / functional_jobs / tensions
--
-- The function requires at least one of the four filters to be non-null
-- before it returns anything, and each filter rejects a row that is NULL in
-- the column it tests. So no filter shape reaches a NULL-topic row now, with
-- or without this branch. Verified: 0 rows returned by any filter shape.
--
-- It stays because it is free and it is correct. A row with no topic cannot
-- equal the home topic, so it cannot bleed, so excluding it would be wrong
-- the day one of those rows gets tagged. Costing nothing to be right early
-- is a better trade than a silent drop later.
--
-- Topics are compared raw, not lowercased. All 17 distinct values in
-- bjl_scores are already lowercase (verified: 0 rows where item_topic <>
-- lower(item_topic)), and callers pass values drawn from this same column.
-- A lower() here would only cost the comparison its index.
--
-- COMPATIBILITY
--
-- exclude_topics is appended last and defaults to NULL, which reproduces the
-- old behaviour exactly. All 249 bjl_corpus_search calls in the last 60 days
-- use named `:=` arguments, so none of them are affected by a new trailing
-- parameter.
--
-- DROP before CREATE, not CREATE OR REPLACE. Replacing a function with a
-- changed argument list creates a SECOND overload rather than replacing the
-- first, which leaves every existing caller ambiguous and erroring with
-- "function bjl_corpus_search(...) is not unique". This bit us on
-- bjl_audience_affinity_v2 on 2026-08-27.
--
-- IT BACKFILLS, IT DOES NOT JUST SUBTRACT
--
-- The filter runs BEFORE the LIMIT, so excluding the home topic does not
-- leave a shorter list -- it promotes cross-domain rows that were ranked out
-- of the top 20 by home-topic rows the arm was never allowed to use anyway.
-- Measured on joy_mode_filter := ARRAY['sentimental'], min_score 50, min_n
-- 50, limit 100:
--
--   without exclude   100 rows, 53 of them food_beverage
--   with exclude       78 rows,  0 of them food_beverage
--                      29 of those 78 were NOT in the unfiltered top 100
--
-- So the arm loses 53 rows it could not have filed and gains 29 it had never
-- been shown. That is the real mechanism, and it is why this should help the
-- heavily-contaminated jobs most -- the ones where the arm had little else
-- to file. It does not rescue every case: ad5a42e6 filed 22 home-topic rows
-- from a 94-row result and may still come back thin.
--
-- Ordering, floors and the resolution CASE are untouched: the excluded call
-- returns exactly the non-home-topic subset of the full hit set, still in
-- joy_index DESC order, still respecting min_score and min_n.
--
-- RISK
--
-- Reversible by re-running the previous definition, which is preserved in
-- git history. No row is changed, no constraint added. With exclude_topics
-- left NULL the returned rows are byte-identical to before -- verified in a
-- rolled-back transaction across four control shapes (topic-filtered,
-- relaxed floors, joy-mode-filtered, and question_type_filter := NULL),
-- both definitions called in the same session. All four matched exactly.
-- exclude_topics := ARRAY[]::text[] is also a no-op, verified.
-- =====================================================================

DROP FUNCTION IF EXISTS public.bjl_corpus_search(
  text, text[], text[], text[], text[], numeric, integer, integer);

CREATE FUNCTION public.bjl_corpus_search(
  target_topic          text     DEFAULT NULL::text,
  joy_mode_filter       text[]   DEFAULT NULL::text[],
  functional_job_filter text[]   DEFAULT NULL::text[],
  tension_filter        text[]   DEFAULT NULL::text[],
  question_type_filter  text[]   DEFAULT ARRAY['joy_scale'::text],
  min_score             numeric  DEFAULT 60,
  min_n                 integer  DEFAULT 100,
  limit_n               integer  DEFAULT 20,
  exclude_topics        text[]   DEFAULT NULL::text[]
)
RETURNS TABLE(
  item_name text, primary_topic text, question_type text,
  score numeric, n integer, item_id integer, resolution text)
LANGUAGE sql
STABLE
AS $function$
  WITH hits AS (
    SELECT
      s.item_name,
      s.item_topic    AS primary_topic,
      s.question_type AS question_type,
      ROUND(s.joy_index, 1)::numeric AS score,
      s.n,
      s.joy_index
    FROM bjl_scores s
    WHERE
      (
        target_topic IS NOT NULL
        OR joy_mode_filter IS NOT NULL
        OR functional_job_filter IS NOT NULL
        OR tension_filter IS NOT NULL
      )
      AND (target_topic IS NULL OR s.item_topic = target_topic)
      AND (joy_mode_filter IS NULL OR s.joy_modes @> joy_mode_filter)
      AND (functional_job_filter IS NULL OR s.functional_jobs @> functional_job_filter)
      AND (tension_filter IS NULL OR s.tensions @> tension_filter)
      AND (question_type_filter IS NULL OR s.question_type = ANY(question_type_filter))
      -- The one new clause. A NULL topic is KEPT: it cannot equal the home
      -- topic, so it cannot bleed. That branch is defensive, not a fix -- all
      -- 138 untopiced rows are unreachable through this function today. See
      -- the NULL item_topic note in the header for why it stays anyway.
      AND (
        exclude_topics IS NULL
        OR s.item_topic IS NULL
        OR s.item_topic <> ALL(exclude_topics)
      )
      AND s.joy_index IS NOT NULL
      AND s.joy_index >= min_score
      AND s.n >= min_n
  ),
  candidates AS (
    SELECT
      h.*,
      (SELECT array_agg(i.item_id ORDER BY i.item_id)
         FROM bjl_items i
        WHERE i.item_name = h.item_name) AS cand_ids
    FROM hits h
  )
  SELECT
    c.item_name,
    c.primary_topic,
    c.question_type,
    c.score,
    c.n,
    CASE
      WHEN array_length(c.cand_ids, 1) = 1 THEN c.cand_ids[1]
      ELSE r.resolved_item_id
    END AS item_id,
    CASE
      WHEN array_length(c.cand_ids, 1) = 1        THEN 'unique'
      WHEN r.resolved_item_id IS NOT NULL         THEN 'adjudicated'
      WHEN c.cand_ids IS NULL                     THEN 'unmatched'
      ELSE                                             'ambiguous'
    END AS resolution
  FROM candidates c
  LEFT JOIN bjl_item_resolutions r
         ON r.item_name = c.item_name
        AND r.status = 'resolved'
  ORDER BY c.joy_index DESC, c.n DESC
  LIMIT GREATEST(1, LEAST(limit_n, 100));
$function$;
