-- 2026-08-05 — Put the warm/cool split under version control.
--
-- ALREADY APPLIED. This file changes nothing. Both functions below were
-- already live when this was written; the text is their own current
-- definition, pulled out of the database with pg_get_functiondef and
-- checked in verbatim. Running it replaces each function with itself.
--
-- WHY THIS EXISTS. bjl-joy-map-connections.js:491 calls
-- bjl_joy_map_modeled(...), and every cohort_hot / cohort_cool number the
-- Joy Map renders comes out of it. Neither that function nor the one it
-- delegates the actual split to was in migrations/. The load-bearing
-- mechanic of the product could only be read by someone with a database
-- console — which is the same class of problem as a rule that lives only
-- in prose, and we have spent this week converting those into gates.
--
-- A CORRECTION TO THE FINDING THAT PROMPTED THIS. My handoff said the
-- warm/cool rule lives in bjl_joy_map_modeled. It does not.
-- bjl_joy_map_modeled consumes is_hot; the rule that assigns it is in
-- bjl_map_cohort, which the handoff never named because nothing in the
-- JavaScript calls it directly. Versioning only the function the JS calls
-- would have checked in the consumer and left the rule exactly as
-- unreadable as before. Both are below.
--
--
-- THE RULE, IN PROSE — bjl_map_cohort
--
-- Every respondent gets focal_cz: the average of their person-mean-centered
-- scores (bjl_conn_centered_v2.cz) across the focal items. So the split
-- sits on centered scores, and a respondent's own overall positivity is
-- already netted out before anyone is called warm or cool.
--
-- Three modes, and they do NOT mean the same thing by "hot":
--
--   leaners  (default)  is_hot := focal_cz > 0
--                       Everyone is placed. The cut is the respondent's own
--                       instrument mean. Exactly-zero lands cool.
--
--   devotees            ntile(3) over focal_cz; tertile 3 is hot, tertile 1
--                       is cool, and THE MIDDLE TERTILE IS DROPPED — it
--                       appears in neither side and in no denominator.
--
--   gate                is_hot := (gate_val = p_gate_value), over the
--                       thirteen whitelisted bjl_respondents columns.
--                       Respondents with a NULL on the gate field are
--                       excluded entirely.
--
-- Read that third one carefully before using it. Under leaners and
-- devotees, cool means "low on the focal items." Under gate, cool means
-- "some other value on a demographic field," which is not a joy statement
-- at all. Same column name, different claim.
--
--
-- THE FLOORS, NAMED — bjl_joy_map_modeled
--
-- Four abstain conditions, each returning a distinct verdict rather than a
-- silent null, and each also nulling modeled_lift_points:
--
--   n_items  < 10       'model_abstains_items'      territory too thin
--   coherence < 0.35    'model_abstains_coherence'  centroid too diffuse
--   hot_n or cool_n
--            < 50       'model_abstains_cohort'     per SIDE of the split
--   no eligible row in
--   bjl_model_accuracy  'model_abstains'
--
-- TWO THINGS TO NOT CONFUSE:
--
-- (1) The 50 is duplicated. COHORT_FLOOR = 50 in
--     bjl-joy-map-connections.js:141 is a second copy of the literal on
--     line 70 of the function below, with nothing tying them together. If
--     one moves and the other does not, the JS will pre-screen against a
--     floor the database no longer enforces, or vice versa. Not fixed here
--     — this file is a record, not a change — but it should be one number.
--
-- (2) The 0.35 here is a COHERENCE floor. It is unrelated to the -0.35
--     correlation threshold carried over from the v2 world that is still
--     open elsewhere. Two different 0.35s on two different axes.
--
-- RE-RUNNABLE, per the house standard: CREATE OR REPLACE throughout, no
-- DROP, no data touched. Running this file twice leaves the same schema
-- and raises no error.
--
-- IF YOU CHANGE EITHER FUNCTION, CHANGE IT HERE AND REPLAY THE FILE. An
-- edit made in a SQL console puts the database back ahead of the repo and
-- silently un-does the only thing this file was written to accomplish.
--
-- VERIFIED, AND HOW TO RE-VERIFY. The two blocks below were not trusted
-- from the dump that produced them. Each was hashed after being written to
-- this file and compared against live:
--
--   bjl_map_cohort       1f179feff3fa57c9a011da1c878e6c9d   1865 bytes
--   bjl_joy_map_modeled  ce7ca2b47e8afb1e55d4ab5a5433de5d   4014 bytes
--
-- Both matched byte-for-byte on 2026-08-05, one overload each. The hash is
-- of pg_get_functiondef(oid) exactly as Postgres emits it — the text
-- between the VERBATIM markers, minus the trailing ';' this file adds to
-- make the statements executable. To check whether the database has since
-- moved ahead of this file:
--
--   SELECT proname, md5(pg_get_functiondef(oid))
--   FROM pg_proc WHERE proname IN ('bjl_map_cohort','bjl_joy_map_modeled');
--
-- A changed hash means someone edited in a console. There is no automated
-- gate on this yet, so the hashes above are the record: they are worth
-- exactly as much as the next person's willingness to run two lines of SQL,
-- which is less than a latch and more than a comment saying "keep in sync."


-- ===================================================================
-- BEGIN VERBATIM: bjl_map_cohort
-- ===================================================================
CREATE OR REPLACE FUNCTION public.bjl_map_cohort(p_focal integer[], p_mode text DEFAULT 'leaners'::text, p_gate_field text DEFAULT NULL::text, p_gate_value text DEFAULT NULL::text)
 RETURNS TABLE(respondent_id text, is_hot boolean)
 LANGUAGE sql
 STABLE
AS $function$
  WITH base AS (
    SELECT c.respondent_id, avg(c.cz) AS focal_cz
    FROM bjl_conn_centered_v2 c
    WHERE c.item_id = ANY(p_focal) GROUP BY 1
  ),
  gated AS (
    SELECT b.respondent_id, b.focal_cz,
      CASE p_gate_field
        WHEN 'occupation' THEN r.occupation
        WHEN 'generation' THEN r.generation
        WHEN 'gender' THEN r.gender
        WHEN 'region' THEN r.region
        WHEN 'income_bracket' THEN r.income_bracket
        WHEN 'decisionmaker_vacation' THEN r.decisionmaker_vacation
        WHEN 'decisionmaker_groceries' THEN r.decisionmaker_groceries
        WHEN 'decisionmaker_internet' THEN r.decisionmaker_internet
        WHEN 'decisionmaker_car' THEN r.decisionmaker_car
        WHEN 'decisionmaker_bank' THEN r.decisionmaker_bank
        WHEN 'decisionmaker_vacation_activities' THEN r.decisionmaker_vacation_activities
        WHEN 'decisionmaker_car_insurance' THEN r.decisionmaker_car_insurance
        WHEN 'decisionmaker_home_furnishing' THEN r.decisionmaker_home_furnishing
        ELSE NULL END AS gate_val
    FROM base b JOIN bjl_respondents r USING (respondent_id)
  ),
  tiles AS (
    SELECT respondent_id, focal_cz, ntile(3) OVER (ORDER BY focal_cz) AS tertile FROM base
  )
  SELECT respondent_id,
    CASE WHEN focal_cz > 0 THEN true ELSE false END
  FROM base WHERE coalesce(p_mode,'leaners') = 'leaners'
  UNION ALL
  SELECT respondent_id, (tertile = 3)
  FROM tiles WHERE p_mode = 'devotees' AND tertile IN (1,3)
  UNION ALL
  SELECT respondent_id, (gate_val = p_gate_value)
  FROM gated WHERE p_mode = 'gate' AND gate_val IS NOT NULL
$function$
;
-- ===================================================================
-- END VERBATIM: bjl_map_cohort
-- ===================================================================


-- ===================================================================
-- BEGIN VERBATIM: bjl_joy_map_modeled
-- ===================================================================
CREATE OR REPLACE FUNCTION public.bjl_joy_map_modeled(p_focal integer[], p_model text DEFAULT 'mf_v1_k24'::text, p_mode text DEFAULT 'leaners'::text, p_gate_field text DEFAULT NULL::text, p_gate_value text DEFAULT NULL::text)
 RETURNS TABLE(ord integer, territory text, modeled_verdict text, modeled_lift_points numeric, measured_territory_mean_lift numeric, model_holdout_r numeric, centroid_items integer, coherence numeric, cohort_hot bigint, cohort_cool bigint)
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
    JOIN (SELECT DISTINCT item_id FROM bjl_conn_centered_v2 WHERE scale_family='joy') j ON j.item_id = it.item_id
    WHERE it.territory_key <> 'unassigned'
      AND coalesce(i.is_location, false) = false
      AND coalesce(i.is_brand, false) = false
      AND NOT (it.item_id = ANY(p_focal))
  ),
  measured_mean AS (
    SELECT cu.territory_key,
      avg(c.cz) FILTER (WHERE co.is_hot) - avg(c.cz) FILTER (WHERE NOT co.is_hot) AS mean_lift
    FROM bjl_conn_centered_v2 c
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
      (avg(yhat) FILTER (WHERE is_hot) - avg(yhat) FILTER (WHERE NOT is_hot))
        * (SELECT (params->'fam_scale'->>'joy')::numeric FROM bjl_model_registry WHERE model_version = p_model)
      AS lift
    FROM pred GROUP BY 1
  )
  SELECT t.ord, t.territory_name,
    CASE
      WHEN ts.n_items IS NULL OR ts.n_items < 10 THEN 'model_abstains_items'
      WHEN ts.coherence < 0.35 THEN 'model_abstains_coherence'
      WHEN l.hot_n < 50 OR l.cool_n < 50 THEN 'model_abstains_cohort'
      WHEN NOT coalesce(a.eligible, false) THEN 'model_abstains'
      ELSE 'modeled' END,
    CASE WHEN ts.n_items >= 10 AND ts.coherence >= 0.35
          AND l.hot_n >= 50 AND l.cool_n >= 50 AND coalesce(a.eligible, false)
         THEN round((l.lift * coalesce(a.calibration_slope, 1))::numeric, 1) ELSE NULL END,
    round(m.mean_lift::numeric, 1),
    a.holdout_r, ts.n_items::int, round(ts.coherence::numeric, 2),
    l.hot_n, l.cool_n
  FROM bjl_territories t
  LEFT JOIN lifts l ON l.territory_key = t.territory_key
  LEFT JOIN terr_stats ts ON ts.territory_key = t.territory_key
  LEFT JOIN measured_mean m ON m.territory_key = t.territory_key
  LEFT JOIN bjl_model_accuracy a ON a.model_version = p_model
    AND a.scope_type = 'territory' AND a.scope_key = t.territory_key
  ORDER BY t.ord
$function$
;
-- ===================================================================
-- END VERBATIM: bjl_joy_map_modeled
-- ===================================================================
