-- bjl_items_longitudinal_wide view (Audience Map v5.4 Fix 3 — cross-category
-- discovery).
--
-- Pass 2 and Pass 4 need a wider Layer 1 substrate than the strict
-- 10-fieldings universal core (bjl_items_longitudinal, ~45 items) so that
-- reverse-engineering can find distinctive signal in categories the user
-- never named. A 5-fielding threshold yields ~182 items spanning food,
-- grocery, finance, tech, retail, travel, social — broad enough to be the
-- cross-category substrate for resonance scoring, narrow enough to exclude
-- one-wave novelty items that would only fragment the cohort.
--
-- Both views coexist:
--   bjl_items_longitudinal       (10+ fieldings, ~45 items) — the strictest
--                                  universal core; used where comparability
--                                  is paramount.
--   bjl_items_longitudinal_wide  (5+ fieldings, ~182 items) — the wider
--                                  cross-category substrate; used for Pass 2
--                                  wide profiling and Pass 4 resonance
--                                  parameter eligibility.

CREATE OR REPLACE VIEW bjl_items_longitudinal_wide AS
SELECT
  i.item_id,
  i.item_name,
  i.question_id,
  q.question_text,
  q.question_type,
  q.scale_type,
  q.short_label,
  COUNT(DISTINCT r.respondent_id) AS n_responses,
  COUNT(DISTINCT r.fielding_id)   AS n_fieldings,
  ARRAY_AGG(DISTINCT r.fielding_id ORDER BY r.fielding_id)
    FILTER (WHERE r.fielding_id IS NOT NULL) AS fielding_ids
FROM bjl_items i
LEFT JOIN bjl_questions_v2 q ON q.question_id = i.question_id
LEFT JOIN bjl_responses r    ON r.item_id     = i.item_id
WHERE q.question_type = 'joy_scale'
  AND (q.scale_type = 'ordinal_-3_to_5' OR q.scale_type IS NULL)
GROUP BY i.item_id, i.item_name, i.question_id,
         q.question_text, q.question_type, q.scale_type, q.short_label
HAVING COUNT(DISTINCT r.fielding_id) >= 5;

COMMENT ON VIEW bjl_items_longitudinal_wide IS
  'Layer 1 wide cross-category substrate for the Audience Map. 9-point joy_scale items asked in 5+ fieldings (~182 items). Used by Pass 2 wide profiling and Pass 4 resonance parameter eligibility (v5.4 Fix 3).';
