-- =====================================================================
-- Audience arms: make an impossible request legible, and report thin
-- audiences instead of pretending they are empty ones.
--
-- WHAT WAS WRONG
--
-- bjl_audience_affinity_v2 keeps items whose per-item audience count
-- (aud_n) clears min_aud_n, default 75. aud_n is drawn FROM the audience,
-- so when the audience itself is smaller than 75 no item can ever clear
-- the bar. The request is arithmetically impossible, and the function
-- answers it with zero rows.
--
-- Worse, audience_size is selected from the result set. Zero rows means
-- audience_size comes back NULL -- the one number that would explain the
-- failure is destroyed BY the failure.
--
-- So three unrelated outcomes were byte-identical to the caller:
--   * the home item names do not exist in the corpus at all
--   * the audience is real but smaller than the floor
--   * there is genuinely no distinctive affinity
--
-- Measured across 60 days of scratch history: 68 audience-arm calls, 10
-- returning zero rows (15%), 8 of them from affinity_v2. Every one of the
-- four that could be replayed was impossible-by-construction, not empty:
--
--   job c2acaf5d   3 of 5 names resolved   436 scored   audience  56
--   job c6061f5f   1 of 1 names resolved   425 scored   audience  73
--   job c635c8d9   0 of 6 names resolved     0 scored   audience   0
--   job 587f65ac   0 of 3 names resolved     0 scored   audience   0
--
-- c6061f5f missed the floor by two respondents and reported nothing.
--
-- WHAT CHANGES
--
-- 1. A thin band. When audience_size < min_aud_n the per-item floor drops
--    to thin_aud_floor (default 30) and every returned row is marked
--    audience_thin = true. The floor is NOT removed and min_aud_n is NOT
--    lowered -- 75 remains the bar for an unqualified finding. Below it
--    the finding is reportable only WITH its warning attached, which the
--    provenance guard enforces the same way it enforces `reportable`.
--
--    This fails closed with no extra clause: aud_n counts members of the
--    audience, so aud_n <= audience_size. If the audience is under 30,
--    nothing can reach a floor of 30 and the function returns nothing --
--    which is the correct answer for an audience that small.
--
-- 2. bjl_audience_size, a diagnostic the caller runs ONLY after a zero-row
--    result. It separates the three outcomes above by returning
--    names_given, names_resolved, respondents_scored and audience_size.
--
--    Deliberately not a pre-flight check. Measured at 8-15s, so calling it
--    before every arm would slow the 24-of-32 calls that already succeed
--    and raise expected cost from ~30s to ~34.5s. Run on failure it costs
--    the failing path only, and buys it an actual answer.
--
-- 3. A covering index for the item_name join path. The audience arms join
--    bjl_responses USING (item_name), so bjl_responses_joy_cover -- keyed
--    on (item_id, respondent_id) -- cannot serve them. That is why the
--    arms did not move when it shipped. Measured in a rolled-back
--    transaction: the c2acaf5d call 54.6s -> 25.8s, a working control call
--    38.7s -> 22.1s. 64 MB.
--
-- WHY NOT JUST LOWER min_aud_n
--
-- Because 73-vs-75 is exactly the case where lowering the floor is
-- tempting and wrong. The floor encodes when a centered gap is stable
-- enough to trust. Moving it would silently restate every past finding's
-- confidence. The thin band leaves the floor alone and makes the caller
-- say out loud that it did not clear it.
--
-- RISK
--
-- The affinity function now returns rows in cases where it previously
-- returned none. That is the point, but it means a thin row can reach the
-- synthesizer, so audience_thin is enforced end-to-end: the guard rejects
-- any audience_affinity entry that omits it or disagrees with the scratch
-- row. A thin finding stripped of its warning is the failure this band
-- would otherwise introduce, and it is checked, not trusted.
--
-- Index is additive and droppable. Both function changes are additive in
-- return shape (one new column, one new function); existing callers that
-- select named columns are unaffected.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The thin band.
--
-- Both overloads must be dropped and recreated, not CREATE OR REPLACE'd.
-- The return shape gains a column and the names overload gains a
-- parameter, and a differing argument list makes CREATE OR REPLACE add a
-- SECOND overload rather than replace the first -- which leaves
-- bjl_audience_affinity_v2(text[]) ambiguous and every existing caller
-- failing with "function is not unique". Drop the ids wrapper first; it
-- delegates to the names version.
-- ---------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.bjl_audience_affinity_v2(
  integer[], numeric, integer, numeric, integer, integer, integer, numeric);
DROP FUNCTION IF EXISTS public.bjl_audience_affinity_v2(
  text[], numeric, integer, numeric, integer, integer, integer, numeric);

CREATE FUNCTION public.bjl_audience_affinity_v2(
  home_item_names   text[],
  home_pref_floor   numeric DEFAULT 12,
  min_aud_n         integer DEFAULT 75,
  score_floor       numeric DEFAULT 45,
  per_topic_cap     integer DEFAULT 3,
  max_results       integer DEFAULT 15,
  min_resp_items    integer DEFAULT 5,
  materiality_floor numeric DEFAULT 3.0,
  thin_aud_floor    integer DEFAULT 30
)
RETURNS TABLE(
  construct text, primary_topic text, item_name text, rel_lift numeric,
  audience_score numeric, general_score numeric, aud_n integer,
  audience_size integer, reportable boolean, audience_thin boolean
)
LANGUAGE sql
STABLE
AS $function$
WITH home_pref AS (
  SELECT r.respondent_id, AVG(r.joy_index - rm.rmean) AS home_c
  FROM bjl_responses r
  JOIN bjl_item_construct f USING (item_name)
  JOIN bjl_resp_construct_mean rm
    ON rm.respondent_id = r.respondent_id AND rm.construct = f.construct
  WHERE rm.rn >= min_resp_items AND r.joy_index IS NOT NULL
    AND lower(btrim(r.item_name)) IN (SELECT lower(btrim(x)) FROM unnest(home_item_names) x)
  GROUP BY r.respondent_id
),
aud AS (SELECT respondent_id FROM home_pref WHERE home_c >= home_pref_floor),
asize AS (SELECT COUNT(*)::int AS n FROM aud),
home_topics AS (
  SELECT DISTINCT item_topic AS topic FROM bjl_scores
  WHERE lower(btrim(item_name)) IN (SELECT lower(btrim(x)) FROM unnest(home_item_names) x)
    AND item_topic IS NOT NULL
),
per_item AS (
  SELECT f.construct, r.item_name, f.item_topic,
    AVG(r.joy_index - rm.rmean) FILTER (WHERE a.respondent_id IS NOT NULL) AS aud_c,
    AVG(r.joy_index - rm.rmean) AS gen_c,
    AVG(r.joy_index) FILTER (WHERE a.respondent_id IS NOT NULL) AS aud_raw,
    AVG(r.joy_index) AS gen_raw,
    COUNT(DISTINCT r.respondent_id) FILTER (WHERE a.respondent_id IS NOT NULL) AS aud_n
  FROM bjl_responses r
  JOIN bjl_item_construct f USING (item_name)
  JOIN bjl_resp_construct_mean rm
    ON rm.respondent_id = r.respondent_id AND rm.construct = f.construct
  LEFT JOIN aud a ON a.respondent_id = r.respondent_id
  WHERE rm.rn >= min_resp_items AND r.joy_index IS NOT NULL
    AND f.construct IN ('joy','trust','likelihood','familiarity','perception')
  GROUP BY f.construct, r.item_name, f.item_topic
),
ranked AS (
  SELECT p.construct, p.item_topic, p.item_name,
         ROUND(p.aud_c - p.gen_c, 1) AS rel_lift,
         ROUND(p.aud_raw, 1) AS audience_score,
         ROUND(p.gen_raw, 1) AS general_score,
         p.aud_n,
         ROW_NUMBER() OVER (PARTITION BY p.item_topic ORDER BY (p.aud_c - p.gen_c) DESC) AS topic_rn
  FROM per_item p
  WHERE p.item_topic IS NOT NULL
    AND p.item_topic NOT IN (SELECT topic FROM home_topics)
    -- The floor relaxes only when the audience cannot possibly clear the
    -- full bar. It never disappears.
    AND p.aud_n >= CASE WHEN (SELECT n FROM asize) >= min_aud_n
                        THEN min_aud_n
                        ELSE thin_aud_floor END
    AND p.aud_raw >= score_floor
)
SELECT r.construct,
       r.item_topic AS primary_topic,
       r.item_name,
       r.rel_lift,
       r.audience_score,
       r.general_score,
       r.aud_n,
       (SELECT n FROM asize) AS audience_size,
       (r.rel_lift >= materiality_floor) AS reportable,
       ((SELECT n FROM asize) < min_aud_n) AS audience_thin
FROM ranked r
WHERE r.topic_rn <= per_topic_cap
ORDER BY r.rel_lift DESC
LIMIT max_results;
$function$;

-- The item_id overload is a thin delegator and stays one. It is in real
-- use (job 2f23505b called it by id), so it has to carry the new column
-- through or an id-keyed call would return the old shape and fail the
-- guard's audience_thin check for reasons the caller could not see.

CREATE FUNCTION public.bjl_audience_affinity_v2(
  home_item_ids     integer[],
  home_pref_floor   numeric DEFAULT 12,
  min_aud_n         integer DEFAULT 75,
  score_floor       numeric DEFAULT 45,
  per_topic_cap     integer DEFAULT 3,
  max_results       integer DEFAULT 15,
  min_resp_items    integer DEFAULT 5,
  materiality_floor numeric DEFAULT 3.0,
  thin_aud_floor    integer DEFAULT 30
)
RETURNS TABLE(
  construct text, primary_topic text, item_name text, rel_lift numeric,
  audience_score numeric, general_score numeric, aud_n integer,
  audience_size integer, reportable boolean, audience_thin boolean
)
LANGUAGE sql
STABLE
AS $function$
  SELECT * FROM public.bjl_audience_affinity_v2(
    ARRAY(SELECT DISTINCT item_name FROM bjl_responses WHERE item_id = ANY(home_item_ids)),
    home_pref_floor, min_aud_n, score_floor, per_topic_cap, max_results,
    min_resp_items, materiality_floor, thin_aud_floor
  );
$function$;

-- ---------------------------------------------------------------------
-- 2. The failure diagnostic. Run this ONLY when an arm returns zero rows.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bjl_audience_size(
  home_item_names text[],
  home_pref_floor numeric DEFAULT 12,
  min_resp_items  integer DEFAULT 5
)
RETURNS TABLE(
  names_given        integer,
  names_resolved     integer,
  respondents_scored integer,
  audience_size      integer
)
LANGUAGE sql
STABLE
AS $function$
WITH resolved AS (
  SELECT DISTINCT lower(btrim(s.item_name)) AS nm
  FROM bjl_scores s
  WHERE lower(btrim(s.item_name)) IN (SELECT lower(btrim(x)) FROM unnest(home_item_names) x)
),
home_pref AS (
  SELECT r.respondent_id, AVG(r.joy_index - rm.rmean) AS home_c
  FROM bjl_responses r
  JOIN bjl_item_construct f USING (item_name)
  JOIN bjl_resp_construct_mean rm
    ON rm.respondent_id = r.respondent_id AND rm.construct = f.construct
  WHERE rm.rn >= min_resp_items AND r.joy_index IS NOT NULL
    AND lower(btrim(r.item_name)) IN (SELECT lower(btrim(x)) FROM unnest(home_item_names) x)
  GROUP BY r.respondent_id
)
SELECT cardinality(home_item_names)::int,
       (SELECT count(*) FROM resolved)::int,
       (SELECT count(*) FROM home_pref)::int,
       (SELECT count(*) FROM home_pref WHERE home_c >= home_pref_floor)::int;
$function$;

-- The covering index for the item_name join path ships as its own
-- migration (2026-08-27_responses_name_joy_covering_index.sql) because
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block and the
-- two function definitions above must be applied as one.
