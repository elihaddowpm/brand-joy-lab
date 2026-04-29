-- Migration: add triage stage to bjl_query_jobs
--
-- The triage agent (Haiku 4.5) runs before the investigator. Its structured
-- brief gets written to triage_brief (jsonb) and read by both investigator
-- and synthesizer to scope behavior. Adds followup_chips for the frontend
-- to render below each response, clarifying_question for the case where
-- triage flags ambiguity, and prior_conversation_context for follow-up
-- recognition.
--
-- See triage_prompt.md for the brief schema. See bjl-query-background.js
-- for how the brief is consumed across the three-stage pipeline.

ALTER TABLE bjl_query_jobs
  ADD COLUMN IF NOT EXISTS triage_brief jsonb,
  ADD COLUMN IF NOT EXISTS triage_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS followup_chips text[],
  ADD COLUMN IF NOT EXISTS clarifying_question text,
  ADD COLUMN IF NOT EXISTS prior_conversation_context jsonb;

-- Index for status queries (frontend polls these every 2s)
CREATE INDEX IF NOT EXISTS idx_query_jobs_status_created
  ON bjl_query_jobs (status, created_at DESC);

COMMENT ON COLUMN bjl_query_jobs.triage_brief IS
  'Output of the Haiku 4.5 triage stage. Read by investigator and synthesizer to scope behavior. See triage_prompt.md for schema.';

COMMENT ON COLUMN bjl_query_jobs.followup_chips IS
  'Three suggested followup directions. Frontend renders as clickable chips below the response. Source: triage.followup_seeds.';

COMMENT ON COLUMN bjl_query_jobs.clarifying_question IS
  'Set only when triage.needs_clarification=true. Surface to user, wait for next turn, no investigation runs.';

COMMENT ON COLUMN bjl_query_jobs.prior_conversation_context IS
  'Last 3-5 turns of conversation passed to triage so it can recognize follow-ups. Array of {role, content, response_summary} objects.';
