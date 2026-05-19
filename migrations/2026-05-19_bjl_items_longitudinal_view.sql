-- bjl_items_longitudinal view (Joy Map Phase 2, Audience Map prerequisite).
--
-- Pass 2 of the Audience Map workflow profiles seed cohorts against the
-- Layer 1 universal core: the subset of joy_scale items that have been
-- fielded across enough survey waves that cross-fielding cohorts can be
-- meaningfully compared on them. The 10-fielding threshold reflects the
-- ~106-item universal core surfaced during Phase 2 design.

CREATE OR REPLACE VIEW bjl_items_longitudinal AS
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
HAVING COUNT(DISTINCT r.fielding_id) >= 10;

COMMENT ON VIEW bjl_items_longitudinal IS
  'Layer 1 universal core for the Audience Map. 9-point joy_scale items asked in 10+ fieldings. Used by Pass 2 (cohort profiling against a comparable corpus baseline) and Pass 3 (parameter selection).';
