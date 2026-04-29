-- Migration: allow 'clarification_needed' as a valid status
--
-- The triage stage introduces a new bypass path: when the user's question is
-- ambiguous, triage flags needs_clarification=true and the bg fn writes
-- status='clarification_needed' instead of running an investigation. The
-- existing CHECK constraint on bjl_query_jobs.status didn't include this
-- value, so the UPDATE was silently rejected (Supabase returns the error
-- but the bg fn wasn't checking the return value), leaving jobs stuck in
-- 'running' state.
--
-- This drops and recreates the constraint to include 'clarification_needed'.
--
-- Companion code change: bg fn now captures and logs the supabase update
-- error so future constraint mismatches surface immediately rather than
-- hanging the job.

ALTER TABLE bjl_query_jobs DROP CONSTRAINT IF EXISTS bjl_query_jobs_status_check;
ALTER TABLE bjl_query_jobs ADD CONSTRAINT bjl_query_jobs_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text,
    'running'::text,
    'complete'::text,
    'error'::text,
    'clarification_needed'::text
  ]));
