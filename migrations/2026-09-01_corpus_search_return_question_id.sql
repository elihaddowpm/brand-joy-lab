-- =====================================================================
-- bjl_corpus_search -- return question_id, so a number can be bound to the
-- STEM it came from and not merely to the answer-label it was printed under.
--
-- THE PROBLEM: NAME COLLISION ACROSS STEMS
--
-- bjl_items contains 792 item names that appear more than once, and every
-- single one of them -- 792 of 792, 100% -- spans more than one question
-- stem. They are overwhelmingly grid answer-labels, which by construction
-- repeat under every stem in the grid:
--
--   "Other - Write In"           26x across 26 stems
--   "A Glass of WINE"            12x across 12 stems
--   "A BEER"                     12x across 12 stems
--   "Established/Legacy Brands"  11x across 11 stems
--   "Challenger/Underdog Brands" 11x across 11 stems
--
-- The provenance guard keys its joy_scale and cross_domain allowlist on the
-- item name alone (buildAllowlist, bjl-cross-domain-provenance-guard.js).
-- Two different stems' "A BEER" land in one bucket and a member matches if
-- ANY row in that bucket matches. The same is true of the figures ledger,
-- which writes item_name and never item_id.
--
-- Of the 218 duplicated names among the 1000 rows this function can reach,
-- 48 collide at an identical score -- harmless, since attaching to either
-- row yields the same number. The other 170 do not:
--
--   "Arlington, Texas"                        7 distinct scores, 26.5..43.9
--   "Visiting a ZOO"                          4 distinct scores, 54.1..70.0
--   "Visiting a THEME PARK or amusement park" 4 distinct scores, 50.9..73.3
--
-- A reader shown "Visiting a ZOO -- 70.0" cannot tell which stem produced
-- it, and neither can the ledger that is supposed to be able to re-check it
-- later. That is the relabel: not a fabricated number, a real number seated
-- on the wrong question.
--
-- WHY question_id AND NOT item_id
--
-- item_id is the better long-term key and is NOT usable yet. This function
-- resolves item_id only when a name maps to exactly one bjl_items row;
-- otherwise resolution is 'ambiguous' and item_id comes back NULL. Measured
-- on live calls, that is about half of everything returned:
--
--   joy_mode self_actualization   100 rows,  49 NULL item_id (49%)
--   occasion live_event            94 rows,  46 NULL item_id (49%)
--   target_topic food_beverage    100 rows,  51 NULL item_id (51%)
--
-- Keying the guard on item_id today would fail closed on half of all
-- legitimate rows -- mass refusal, which is the exact failure that 8fba327
-- and 22f73cf were spent reducing. item_id becomes the right key once the
-- ambiguous backlog is adjudicated in bjl_item_resolutions. That is a data
-- project, not a code change.
--
-- question_id is available now and it is sufficient:
--
--   question_id populated on reachable rows      1000 of 1000  (100%)
--   names duplicated by item_name alone                   218
--   names duplicated by (question_id, item_name)            0
--   pairs still carrying more than one score                0
--
-- The pair is a COMPLETE disambiguation of the reachable set, where item_id
-- would have been absent on half of it.
--
-- This is also the established pattern in this codebase rather than a new
-- idea. The same guard already keys select_all rows on (question, item_name)
-- "because option text recurs across questions", and distribution rows on
-- (item_name, set_name, answer). joy_scale and cross_domain were the two
-- constructs left keyed on the name by itself.
--
-- COMPATIBILITY -- THIS ONE IS NOT PURELY ADDITIVE
--
-- Adding a column to RETURNS TABLE is a wider change than the last two
-- migrations, which appended optional arguments that defaulted to NULL. A
-- caller doing `SELECT * FROM bjl_corpus_search(...)` now receives an eighth
-- column, and a caller doing `SELECT item_name, primary_topic, ... ` by name
-- is unaffected. The investigator prompt shows the explicit column list, and
-- all 264 logged call sites select named columns, so none of them changes
-- shape. Verified by replaying them.
--
-- The function must be DROPPED, not CREATE OR REPLACE'd: Postgres refuses to
-- change the return type of an existing function, and a changed argument
-- list would silently create a second overload instead. The DROP names the
-- exact 10-argument signature installed by f2132cd.
--
-- RISK
--
-- Reversible by re-running the previous definition, preserved in git. No row
-- is changed, no constraint added. Row CONTENT for the seven pre-existing
-- columns is unchanged -- verified byte-identical across replayed calls.
-- =====================================================================

DROP FUNCTION IF EXISTS public.bjl_corpus_search(
  text, text[], text[], text[], text[], numeric, integer, integer, text[], text[]);

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
  score numeric, n integer, item_id integer, resolution text,
  question_id integer)
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
      s.joy_index,
      -- The stem. Carried through so a figure can be bound to the question
      -- it was asked under, not just the label it was printed beside.
      s.question_id
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
    END AS resolution,
    c.question_id
  FROM candidates c
  LEFT JOIN bjl_item_resolutions r
         ON r.item_name = c.item_name
        AND r.status = 'resolved'
  ORDER BY c.joy_index DESC, c.n DESC
  LIMIT GREATEST(1, LEAST(limit_n, 100));
$function$;
