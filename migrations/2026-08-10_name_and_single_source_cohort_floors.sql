-- =====================================================================
-- Name the thin-cohort floors, and single-source the two that were
-- literals in more than one place.
--
-- 2026-08-10. Blocker #3 for the cohort-spine build.
--
--
-- ====================================================================
-- THE THING THAT LOOKED TRUE AND WASN'T
-- ====================================================================
--
-- This was filed as "COHORT_FLOOR = 50 in the JS is a bare second copy
-- of the SQL literal 50 — single-source it." That description is wrong
-- in a way that matters, and acting on it as written would have removed
-- a gate.
--
-- They are not one constant written twice. They are two different gates
-- that happen to agree on a number:
--
--   SQL 50, in bjl_joy_map_modeled
--     WHEN l.hot_n < 50 OR l.cool_n < 50 THEN 'model_abstains_cohort'
--     Withholds THE MODELED COLUMN ONLY. Measured territory rows still
--     render. It is a statement about the modeled estimate.
--
--   JS 50, in bjl-joy-map-connections.js
--     Withholds ALL SIXTEEN TERRITORIES and returns territories: []
--     with a halt object. It is a statement about the measured read.
--
-- So the tempting simplification — delete the JS copy, let
-- model_abstains_cohort be the only gate — would start rendering
-- measured territory rows for sub-50 cohorts. That is exactly the
-- "sixteen confident rows off twelve respondents" failure the halt
-- exists to prevent. The duplication story would have licensed deleting
-- a gate on the grounds that it was redundant. It was not.
--
-- They are therefore given SEPARATE names, both returning 50 today,
-- each free to move without dragging the other. A plausible future is
-- rendering measured down to 30 while refusing to model under 50. One
-- welded constant shuts that door and recreates the desync one level up.
--
-- The names say what they gate, deliberately, so nobody reads them
-- later as the same policy wearing two hats.
--
--
-- ====================================================================
-- AND THE MODELED FLOOR WAS THREE LITERALS, NOT ONE
-- ====================================================================
--
-- Inside bjl_joy_map_modeled the number 50 appears twice, in two CASE
-- expressions that must agree:
--
--   verdict CASE:  WHEN l.hot_n < 50 OR l.cool_n < 50
--                    THEN 'model_abstains_cohort'
--   value CASE:    WHEN ... AND l.hot_n >= 50 AND l.cool_n >= 50 ...
--                    THEN round(...) ELSE NULL END
--
-- If those two ever drift apart the function contradicts itself: a
-- territory labelled model_abstains_cohort that still emits a lift
-- number, or a modeled verdict with a NULL value. Both are replaced by
-- the function call below, so the verdict and the value cannot disagree
-- about where the floor is.
--
-- Counting honestly, the original "one duplicated 50" was three
-- literals across two layers.
--
--
-- ====================================================================
-- WHY A SEPARATE FUNCTION AND NOT A NEW RETURN COLUMN
-- ====================================================================
--
-- The obvious shape is to add cohort_floor to bjl_joy_map_modeled's
-- returned TABLE and let the JS read it off the row it already gets.
-- That shape is a trap in this schema.
--
-- Postgres cannot change a function's return type with CREATE OR
-- REPLACE. Adding a column to the RETURNS TABLE requires DROP FUNCTION
-- followed by CREATE FUNCTION — and in this database that sequence
-- discards the function's ACL and re-grants EXECUTE to PUBLIC. It would
-- silently reopen the anon read surface that the read-side lockdown
-- (commit 604c19a) closed, as a side effect of a tidy-up whose stated
-- purpose was removing a duplicate constant.
--
-- This is the second time that rule has bitten on this schema; the
-- first was the connectivity v3 promotion. It is now written into the
-- lockdown doc as a standing rule rather than rediscovered a third
-- time.
--
-- MEASURED, not assumed. I doubted this before writing it, because the
-- lockdown's step 4 already sets ALTER DEFAULT PRIVILEGES ... REVOKE
-- EXECUTE ON FUNCTIONS FROM PUBLIC, which ought to make DROP + CREATE
-- harmless. A scratch function created as postgres in public, with no
-- REVOKE, came back:
--
--   proacl = {=X/postgres,postgres=X/postgres,service_role=X/postgres}
--   anon EXECUTE -> TRUE
--
-- So the default does not protect functions at all, and the finding is
-- broader than "DROP + CREATE loses the ACL": every CREATE FUNCTION in
-- public is born anon-executable, and only the explicit per-function
-- REVOKE keeps the surface shut. Full evidence and the mechanism (the
-- hardwired PUBLIC grant is merged over, not replaced) are in
-- migrations/2026-08-06_read_lockdown_allowlist_sweep.sql.
--
-- Routing the floors through their own functions avoids it entirely:
-- bjl_joy_map_modeled keeps its exact return type, so CREATE OR REPLACE
-- is legal and its ACL survives untouched.
--
--
-- ====================================================================
-- WHAT THIS COSTS AT RUNTIME: NOTHING
-- ====================================================================
--
-- The JS does not gain a round trip. bjl-joy-map-connections.js already
-- builds its sweep query as SQL text and sends it through
-- execute_read_sql, so both floors are added to that SELECT and arrive
-- on rows already in flight.
--
-- Worth recording because the original framing assumed the JS literal
-- bought a fast client-side pre-screen that refused thin cohorts before
-- touching the DB. It never did. cohort_hot / cohort_cool are read off
-- firstModeled — a row returned BY the sweep — so the check runs after
-- the round trip, on data that round trip produced. All sixteen
-- territories are computed and paid for before the halt fires. There
-- was no early exit to preserve.
--
--
-- ====================================================================
-- THE FIVE FLOORS, NAMED
-- ====================================================================
--
--   cohort_n >= 10   bjl-audience-map-background.js   audience L1
--                                                     admission
--   30               audience refuse                  audience read
--                                                     withheld
--   30               bulletin                         bulletin item
--                                                     withheld
--   50 / side        bjl_modeled_abstain_floor()      modeled column
--                                                     only
--   50 / side        bjl_measured_halt_floor()        all territory
--                                                     rows withheld
--
-- Only the bottom two are single-sourced here. The three above are
-- named but left in place: they are each used once, so there is nothing
-- to desync, and moving them is a policy change rather than a
-- refactor.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. The measured-side halt floor.
-- ---------------------------------------------------------------------
-- Below this many respondents on EITHER side of the warm/cool split,
-- the joy map renders no territory rows at all. Sixteen rows computed
-- off twelve people look identical to sixteen rows computed off twelve
-- thousand, so they are withheld rather than shown with a caveat.
--
-- Read by bjl-joy-map-connections.js as a column on the sweep query.
-- This is the MEASURED side. It is not the same policy as
-- bjl_modeled_abstain_floor() and is free to diverge from it.
CREATE OR REPLACE FUNCTION public.bjl_measured_halt_floor()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $function$ SELECT 50 $function$;

REVOKE EXECUTE ON FUNCTION public.bjl_measured_halt_floor() FROM PUBLIC;


-- ---------------------------------------------------------------------
-- 2. The modeled-side abstain floor.
-- ---------------------------------------------------------------------
-- Below this many respondents on either side, bjl_joy_map_modeled
-- returns 'model_abstains_cohort' and a NULL lift. The MEASURED rows
-- still render — this withholds only the modeled column.
--
-- A modelled estimate is a higher-confidence claim than a measured
-- difference, so it may reasonably want a higher bar than the halt
-- floor. Separate function so it can take one without silently moving
-- the measured side too.
CREATE OR REPLACE FUNCTION public.bjl_modeled_abstain_floor()
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $function$ SELECT 50 $function$;

REVOKE EXECUTE ON FUNCTION public.bjl_modeled_abstain_floor() FROM PUBLIC;


-- ---------------------------------------------------------------------
-- 3. Repoint bjl_joy_map_modeled at the named floor.
-- ---------------------------------------------------------------------
-- CREATE OR REPLACE, return type byte-identical to the live definition,
-- so the ACL survives. Only change: both 50 literals become
-- bjl_modeled_abstain_floor().
CREATE OR REPLACE FUNCTION public.bjl_joy_map_modeled(
  p_focal integer[],
  p_model text DEFAULT 'mf_v1_k24'::text,
  p_mode text DEFAULT 'leaners'::text,
  p_gate_field text DEFAULT NULL::text,
  p_gate_value text DEFAULT NULL::text)
RETURNS TABLE(ord integer, territory text, modeled_verdict text,
              modeled_lift_points numeric, measured_territory_mean_lift numeric,
              model_holdout_r numeric, centroid_items integer, coherence numeric,
              cohort_hot bigint, cohort_cool bigint)
LANGUAGE sql
STABLE
AS $function$
  WITH cohort AS (
    SELECT * FROM bjl_map_cohort(p_focal, p_mode, p_gate_field, p_gate_value)
  ),
  curated AS (
    SELECT it.item_id, it.territory_key
    FROM bjl_item_territory it
    JOIN bjl_items i ON i.item_id = it.item_id
    JOIN (SELECT DISTINCT item_id FROM bjl_conn_centered_v3 WHERE scale_family='joy') j ON j.item_id = it.item_id
    WHERE it.territory_key <> 'unassigned'
      AND coalesce(i.is_location, false) = false
      AND coalesce(i.is_brand, false) = false
      AND NOT (it.item_id = ANY(p_focal))
  ),
  measured_mean AS (
    SELECT cu.territory_key,
      avg(c.cz) FILTER (WHERE co.is_hot) - avg(c.cz) FILTER (WHERE NOT co.is_hot) AS mean_lift
    FROM bjl_conn_centered_v3 c
    JOIN curated cu USING (item_id)
    JOIN cohort co USING (respondent_id)
    WHERE c.scale_family = 'joy'
    GROUP BY 1
  ),
  item_vecs AS (
    SELECT cu.territory_key, l.item_id, e.o AS k, e.v::float AS qv
    FROM bjl_item_latent l JOIN curated cu USING (item_id),
    LATERAL jsonb_array_elements_text(l.factors) WITH ORDINALITY e(v, o)
    WHERE l.model_version = p_model
  ),
  item_norms AS (
    SELECT territory_key, item_id, sqrt(sum(qv*qv)) AS nrm FROM item_vecs GROUP BY 1, 2
  ),
  terr_centroid AS (
    SELECT territory_key, k, avg(qv) AS qv FROM item_vecs GROUP BY 1, 2
  ),
  terr_stats AS (
    SELECT tc.territory_key,
      (SELECT count(*) FROM item_norms nn WHERE nn.territory_key = tc.territory_key) AS n_items,
      sqrt(sum(tc.qv * tc.qv)) /
        nullif((SELECT avg(nrm) FROM item_norms nn WHERE nn.territory_key = tc.territory_key), 0) AS coherence
    FROM terr_centroid tc GROUP BY tc.territory_key
  ),
  rl AS (
    SELECT l.respondent_id, c.is_hot, e.o AS k, e.v::float AS pv
    FROM bjl_respondent_latent l JOIN cohort c USING (respondent_id),
    LATERAL jsonb_array_elements_text(l.factors) WITH ORDINALITY e(v, o)
    WHERE l.model_version = p_model
  ),
  pred AS (
    SELECT tc.territory_key, rl.respondent_id, rl.is_hot, sum(rl.pv * tc.qv) AS yhat
    FROM rl JOIN terr_centroid tc USING (k) GROUP BY 1, 2, 3
  ),
  lifts AS (
    SELECT territory_key,
      count(*) FILTER (WHERE is_hot) AS hot_n,
      count(*) FILTER (WHERE NOT is_hot) AS cool_n,
      -- fam_scale multiply REMOVED. The model predicts in standardised
      -- units and bjl_conn_centered_v3 is standardised, so this is already
      -- on the same footing as measured_territory_mean_lift below.
      (avg(yhat) FILTER (WHERE is_hot) - avg(yhat) FILTER (WHERE NOT is_hot))
      AS lift
    FROM pred GROUP BY 1
  )
  SELECT t.ord, t.territory_name,
    CASE
      WHEN ts.n_items IS NULL OR ts.n_items < 10 THEN 'model_abstains_items'
      WHEN ts.coherence < 0.35 THEN 'model_abstains_coherence'
      -- Was the literal 50, here and in the value CASE below. The two
      -- had to agree or the function contradicts itself: a
      -- model_abstains_cohort verdict carrying a lift number, or a
      -- 'modeled' verdict with a NULL value. One source now.
      WHEN l.hot_n < bjl_modeled_abstain_floor()
        OR l.cool_n < bjl_modeled_abstain_floor() THEN 'model_abstains_cohort'
      WHEN NOT coalesce(a.eligible, false) THEN 'model_abstains'
      ELSE 'modeled' END,
    CASE WHEN ts.n_items >= 10 AND ts.coherence >= 0.35
          AND l.hot_n >= bjl_modeled_abstain_floor()
          AND l.cool_n >= bjl_modeled_abstain_floor()
          AND coalesce(a.eligible, false)
         THEN round((l.lift * coalesce(a.calibration_slope, 1))::numeric, 2) ELSE NULL END,
    round(m.mean_lift::numeric, 2),
    a.holdout_r, ts.n_items::int, round(ts.coherence::numeric, 2),
    l.hot_n, l.cool_n
  FROM bjl_territories t
  LEFT JOIN lifts l ON l.territory_key = t.territory_key
  LEFT JOIN terr_stats ts ON ts.territory_key = t.territory_key
  LEFT JOIN measured_mean m ON m.territory_key = t.territory_key
  LEFT JOIN bjl_model_accuracy a ON a.model_version = p_model
    AND a.scope_type = 'territory' AND a.scope_key = t.territory_key
  ORDER BY t.ord
$function$;


-- =====================================================================
-- CHECKS
-- =====================================================================
--
-- 1. Both floors exist, are IMMUTABLE, and return 50.
--
--      SELECT bjl_measured_halt_floor(), bjl_modeled_abstain_floor();
--
--    PASS: 50, 50.
--
-- 2. Neither floor is executable by anon. This is the Track B rule and
--    applies to every new function, including two-line ones.
--
--      SELECT p.proname,
--             has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public'
--        AND p.proname IN ('bjl_measured_halt_floor',
--                          'bjl_modeled_abstain_floor');
--
--    PASS: both false.
--
-- 3. bjl_joy_map_modeled kept its ACL through the replace. This is the
--    check that would have caught the DROP/CREATE mistake, so it is
--    here even though CREATE OR REPLACE should make it a formality.
--
--      SELECT has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public' AND p.proname = 'bjl_joy_map_modeled';
--
--    PASS: false.
--
-- 4. NO LITERAL 50 SURVIVES IN THE FUNCTION BODY. Assert the complete
--    expected state, not the absence of a bad pattern — the point of
--    the exercise is that a second copy can't hide.
--
--      SELECT (regexp_count(pg_get_functiondef(p.oid), '\m50\M')) AS bare_50s,
--             (regexp_count(pg_get_functiondef(p.oid),
--                'bjl_modeled_abstain_floor')) AS floor_calls
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public' AND p.proname = 'bjl_joy_map_modeled';
--
--    PASS: bare_50s = 0, floor_calls = 4 (two CASEs, two operands each).
--
-- 5. Verdicts did not move. The floor value is unchanged, so this is a
--    pure refactor and every territory must return exactly what it
--    returned before. Run against a known focal set and compare.
--
--      SELECT modeled_verdict, count(*)
--      FROM bjl_joy_map_modeled(ARRAY[2149]::int[]) GROUP BY 1;
--
--    PASS: identical to the pre-migration distribution — as of the v3
--    promotion that is model_abstains x16 and nothing else.
--
-- 6. The JS literal is gone.
--
--      rg -n 'COHORT_FLOOR' netlify/functions
--
--    PASS: no hits. The JS reads measured_halt_floor off the sweep row.
-- =====================================================================
