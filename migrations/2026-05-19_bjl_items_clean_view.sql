-- bjl_items_clean view (Joy Map Phase 1.5 v3, Delta 1 prerequisite).
--
-- bjl_items contains ~5,590 entries. Roughly 2,140 of those are write-in
-- survey responses that were incorrectly fielded as catalog items
-- (e.g. "4 th july", "4 th of july", "Forth of July", "Fourth Of July",
-- "July 4" all exist alongside the canonical "Fourth of July").
--
-- The audience-mapping LLM and the manual edit/picker UI both need a
-- clean view that drops the write-in noise. The convention: items with
-- fewer than 100 distinct respondents are write-ins, not survey items.
-- (Pre-listed survey items always reach n >= 100 quickly; write-ins do not.)
--
-- The aggregation layer of the existing Joy Map keeps querying bjl_items
-- directly — its n >= 30 / n >= 100 filters already handle write-in
-- noise during aggregation.

CREATE OR REPLACE VIEW bjl_items_clean AS
SELECT
  i.item_id,
  i.item_name,
  i.question_id,
  q.question_text,
  q.question_type,
  q.scale_type,
  q.short_label,
  COUNT(DISTINCT r.respondent_id) AS n_responses,
  ARRAY_AGG(DISTINCT r.fielding_id ORDER BY r.fielding_id)
    FILTER (WHERE r.fielding_id IS NOT NULL) AS fielding_ids
FROM bjl_items i
LEFT JOIN bjl_questions_v2 q ON q.question_id = i.question_id
LEFT JOIN bjl_responses r ON r.item_id = i.item_id
GROUP BY i.item_id, i.item_name, i.question_id,
         q.question_text, q.question_type, q.scale_type, q.short_label
HAVING COUNT(DISTINCT r.respondent_id) >= 100;

COMMENT ON VIEW bjl_items_clean IS
  'Pre-listed survey items (n_responses >= 100). Excludes the ~2,140 write-in entries currently fielded as bjl_items rows. fielding_ids column added in v4 to support fielding-aware cohort construction.';
