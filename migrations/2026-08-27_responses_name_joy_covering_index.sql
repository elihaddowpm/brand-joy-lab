-- =====================================================================
-- bjl_responses_name_joy_cover -- the covering index for the item_name
-- join path used by the audience arms.
--
-- WHY THIS EXISTS SEPARATELY FROM bjl_responses_joy_cover
--
-- Earlier the same day, bjl_responses_joy_cover shipped keyed on
-- (item_id, respondent_id) and took six heavy scoring queries from 124.1s
-- to 40.3s. One query did not move at all: bjl_audience_affinity_v2, at
-- ~26s for zero rows.
--
-- The reason is structural, not statistical. The audience arms join
--
--   FROM bjl_responses r JOIN bjl_item_construct f USING (item_name)
--
-- on item_name, not item_id. An index keyed on item_id cannot serve that
-- join no matter how good its payload is. Recording this because "the
-- index didn't help the audience arms" reads like a planner mystery and
-- is really just a different join key.
--
-- WHAT IT MEASURED
--
-- Built in a transaction and rolled back, both calls re-run in the same
-- session so the comparison is like-for-like:
--
--   affinity_v2, job c2acaf5d's call   54.6s -> 25.8s
--   affinity_v2, a working control     38.7s -> 22.1s
--
-- 64 MB, 6.6s build. Larger than bjl_responses_joy_cover (32 MB) because
-- item_name is a wide text key where item_id is a 4-byte int -- that is
-- the cost of the join path being keyed on the name.
--
-- The same WHERE joy_index IS NOT NULL predicate applies for the same
-- reason: joy_index is non-null on 1,072,190 of 2,293,889 rows, and the
-- 53% that are null cannot satisfy any query on this path.
--
-- RISK
--
-- Additive and droppable. No constraint, no row changed, no result
-- altered -- the control call returned the same 15 rows before and after.
-- DROP INDEX CONCURRENTLY bjl_responses_name_joy_cover; fully reverts it.
--
-- CONCURRENTLY so the build takes no write lock. Run with autocommit on;
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block.
-- =====================================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS bjl_responses_name_joy_cover
  ON bjl_responses (item_name)
  INCLUDE (respondent_id, joy_index)
  WHERE joy_index IS NOT NULL;
