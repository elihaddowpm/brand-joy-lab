-- =====================================================================
-- bjl_corpus_search -- add occasion_filter, the fourth tag dimension that
-- was always in the data and never wired to the search.
--
-- THE PROBLEM
--
-- bjl_scores carries four parallel tag arrays: joy_modes, functional_jobs,
-- tensions, and occasions. The search function filtered on three of them.
-- occasions was never exposed.
--
-- The investigator worked this out on its own and kept trying to use it. In
-- 60 days of logs, 21 calls passed occasion_filter := ARRAY[...] and every
-- one errored with "function bjl_corpus_search(occasion_filter => text[]...)
-- does not exist". One job's scratch literally records the model writing
-- "occasion_filter not recognized" and then trying again. That is not a
-- hallucinated concept -- it is correct inference from the data model
-- against a function that was wired up short.
--
-- The calls it was trying to make were good ones:
--
--   occasion_filter := ARRAY['live_event']   ->  52 rows across 4 topics
--   occasion_filter := ARRAY['gathering']    ->  28 rows across 5 topics
--   occasion_filter := ARRAY['alone_time']   ->   7 rows across 4 topics
--
-- Coverage justifies exposing it. Of the 1000 rows this function can reach
-- (scored, n >= 100), occasions is populated on 949 -- 95%, level with
-- functional_jobs at 95%, ahead of joy_modes at 94%, and well ahead of
-- tensions at 66%, which has been a supported filter all along.
--
-- NOT EVERY OCCASION IS A CROSS-CUTTING AXIS
--
-- This matters and is documented in the prompt rather than enforced here,
-- because it is a question of what to ask for, not what is legal to ask.
-- Measured over the reachable rows, several occasions are near-synonyms for
-- a single topic and cannot carry a cross-domain finding on their own:
--
--   occasion         rows  topics  dominant topic
--   hosting             5     1    home_life           100%
--   memory              2     1    travel              100%
--   post_purchase       8     1    home_life           100%
--   mealtime          127     3    food_beverage        98%
--   vacation          323     3    travel               95%
--   anticipation       40     3    travel               82%
--   morning            50     4    food_beverage        78%
--   transition          9     3    occasions_seasonal   78%
--
-- Against these, which genuinely spread:
--
--   everyday          331    14    food_beverage        41%
--   purchase_moment    19     8    financial_services   37%
--   evening            60     8    food_beverage        47%
--   weekend           221     8    travel               57%
--   shopping           47     7    retail               57%
--   gathering          77     7    food_beverage        51%
--   alone_time         25     6    health_wellness      40%
--
-- The proxy occasions are NOT dangerous, because exclude_topics (shipped in
-- 2026-08-31_corpus_search_exclude_topics.sql, commit 22f73cf) already
-- removes the home topic before the limit applies. A cross-domain call for
-- mealtime that excludes food_beverage returns the ~3 non-food mealtime rows
-- rather than 127 unusable food rows. The failure mode is a thin result, not
-- a wrong one -- which is the trade the thin band already established.
--
-- THE INERT-CALL GUARD MUST LEARN THE NEW FILTER
--
-- The function refuses to run unless at least one filter is non-null, so it
-- can never become a whole-corpus scan. That guard listed four filters. If
-- occasion_filter were added to the signature but not to the guard, a call
-- passing ONLY occasion_filter would fall through and return zero rows --
-- not an error, just silence, which is the most expensive possible outcome:
-- the model cannot tell "no data" from "you asked wrong". occasion_filter is
-- added to that OR-list. This is the load-bearing line in this migration.
--
-- COMPATIBILITY
--
-- occasion_filter is appended last and defaults to NULL, so every existing
-- call is unaffected. All 264 logged call sites use named := arguments, so
-- argument position cannot matter to any caller.
--
-- The function is DROPPED and recreated, not CREATE OR REPLACE'd. A changed
-- argument list on REPLACE creates a SECOND overload rather than replacing
-- the first, leaving both live and letting the resolver choose. That bit us
-- on bjl_audience_affinity_v2 on 2026-08-27 and again would have here: the
-- DROP names the exact 9-argument signature installed by 22f73cf.
--
-- RISK
--
-- Reversible by re-running the previous definition, preserved in git. No row
-- is changed, no constraint added. With occasion_filter left NULL the
-- returned rows are byte-identical to the current definition.
-- =====================================================================

DROP FUNCTION IF EXISTS public.bjl_corpus_search(
  text, text[], text[], text[], text[], numeric, integer, integer, text[]);

CREATE FUNCTION public.bjl_corpus_search(
  target_topic          text     DEFAULT NULL::text,
  joy_mode_filter       text[]   DEFAULT NULL::text[],
  functional_job_filter text[]   DEFAULT NULL::text[],
  tension_filter        text[]   DEFAULT NULL::text[],
  question_type_filter  text[]   DEFAULT ARRAY['joy_scale'::text],
  min_score             numeric  DEFAULT 60,
  min_n                 integer  DEFAULT 100,
  limit_n               integer  DEFAULT 20,
  exclude_topics        text[]   DEFAULT NULL::text[],
  occasion_filter       text[]   DEFAULT NULL::text[]
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
      -- occasion_filter belongs in this list. Omitting it would make an
      -- occasion-only call silently inert rather than an error.
      (
        target_topic IS NOT NULL
        OR joy_mode_filter IS NOT NULL
        OR functional_job_filter IS NOT NULL
        OR tension_filter IS NOT NULL
        OR occasion_filter IS NOT NULL
      )
      AND (target_topic IS NULL OR s.item_topic = target_topic)
      AND (joy_mode_filter IS NULL OR s.joy_modes @> joy_mode_filter)
      AND (functional_job_filter IS NULL OR s.functional_jobs @> functional_job_filter)
      AND (tension_filter IS NULL OR s.tensions @> tension_filter)
      AND (occasion_filter IS NULL OR s.occasions @> occasion_filter)
      AND (question_type_filter IS NULL OR s.question_type = ANY(question_type_filter))
      -- A NULL topic is KEPT: it cannot equal the home topic, so it cannot
      -- bleed. That branch is defensive, not a fix -- all 138 untopiced rows
      -- are unreachable through this function today. See the NULL item_topic
      -- note in 2026-08-31_corpus_search_exclude_topics.sql for why it stays.
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
