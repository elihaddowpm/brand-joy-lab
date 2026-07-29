-- Migration: a readable answer preview on bjl_query_jobs
--
-- Diagnosing "that answer wasn't great" currently means pulling the row,
-- parsing the `finding` JSON blob, and reading the answer out of it. This
-- is a scannable 300-char copy of the answer prose, written by the public
-- chat worker after the completion update.
--
-- This is NOT dispatch_response_preview and must not be conflated with it.
-- That column carries the body of a FAILED background dispatch and is
-- null on every healthy job by design; the watchdog reads a non-null value
-- as "the worker never ran". Overloading it would have cost us that.
--
-- The worker's write is best-effort and logs rather than throws, so the
-- code is safe to deploy before this migration is applied.

ALTER TABLE bjl_query_jobs
  ADD COLUMN IF NOT EXISTS response_preview text;

COMMENT ON COLUMN bjl_query_jobs.response_preview IS
  'First 300 chars of the answer prose shown to the user, whitespace-collapsed. Scannable copy of finding->>answer for log reads. Distinct from dispatch_response_preview, which is a failed-dispatch diagnostic.';
