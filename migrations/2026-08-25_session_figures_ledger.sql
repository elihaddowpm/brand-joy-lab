-- =====================================================================
-- bjl_session_figures — the authored figures ledger
--
-- WHY THIS EXISTS
--
-- On 2026-08-21 the intelligence pane shipped three relabeled statistics
-- into a client whitepaper: "58% of hostel guests expect community"
-- (community expectation is 17.6%; 58.0% is the SAFETY BARRIER), "71% of
-- vacation rental guests expect togetherness" (70.4% is Q495 purchase
-- INTENT), and "62% of hotel guests expect reliability" (62.0 and 62.4 are
-- hotel JOY INDEX scores, not percentages of anything).
--
-- Every one of those numbers is real. Every one is attached to the wrong
-- item, and two of the three change construct on the way -- an index
-- reported as a share. That is the failure class this table exists to make
-- checkable, and it is the one class that CANNOT be caught by asking
-- "does this value appear somewhere in context". Measured 2026-08-25
-- against the full session history: a value-existence check passes 58% and
-- 62%, and only fails 71% by the accident that 70.4 rounds to 70. A guard
-- built that way reports clean on the incident that motivated it.
--
-- Answering "is 58% bound to community?" needs the binding stored. It is
-- not stored today.
--
-- WHY NOT JUST READ scratch
--
-- bjl_query_jobs.scratch already holds rows with perfect bindings, e.g.
--   {"item_name":"A sense of community","pct_selected":17.6,
--    "question_id":491,"accommodation":"HOSTEL expectations",
--    "total_respondents":482}
-- but scratch is a WORK LOG, not a record of findings, and it keeps the
-- investigator's mistakes alongside its corrections with nothing marking
-- which won. In job 494aeeb4 question 491 appears twice: scratch[2] returns
-- all sixteen items at pct_selected=100 (the denominator counted only the
-- respondents who selected each item, so n_selected = n_respondents = 85),
-- and scratch[4] returns the correct rates (community 17.6, denominator
-- total_respondents = 482) under a query commented "Get total respondents
-- per question first, then compute correct selection rates".
--
-- A ledger scraped from scratch would record "A sense of community = 100%"
-- beside "= 17.6%", each with an equally well-formed item_name and
-- question_id. A wrong number in a structured ledger is worse than a wrong
-- number in prose, because the structure vouches for it. So rows are
-- AUTHORED at synthesis -- where the model has already decided which query
-- answered the question -- and never harvested from the work log.
--
-- Shape is deliberately the stat_item contract the synthesizer already
-- emits and the provenance guard already verifies (item_name, score, n,
-- source, construct; see synthesizer_prompt_v3.md:509 and the card
-- provenance rule at :605). This table persists what was previously
-- computed, checked, and then thrown away.
--
-- Idempotent: safe to run more than once.
-- =====================================================================

CREATE TABLE IF NOT EXISTS bjl_session_figures (
  figure_id    bigserial PRIMARY KEY,

  -- Scope. Figures are recalled per conversation and reset with it, so the
  -- session is the unit. Jobs without a session (bypass / unauthenticated)
  -- simply do not write -- there is nothing to recall them into.
  session_id   uuid        NOT NULL REFERENCES bjl_sessions(id),
  job_id       uuid        NOT NULL REFERENCES bjl_query_jobs(job_id),

  -- The binding. item_name + score is the pair whose separation caused the
  -- incident; neither is meaningful here without the other.
  item_name    text        NOT NULL,
  score        numeric     NOT NULL,
  n            integer,

  -- What KIND of number this is. 58.0 as a barrier percentage and 62.0 as a
  -- joy index are both real and neither is an expectation share. Without
  -- construct, a ledger can confirm a number exists on an item and still
  -- let it be reported as something it is not.
  construct    text        NOT NULL,
  source       text        NOT NULL,
  question_id  integer,

  -- The cohort the figure is true OF, when it is not the whole sample.
  -- Same argument as construct: a figure that belongs to one subpopulation
  -- must not be recalled as a general one. Mirrors the axis work in
  -- bjl-cross-domain-provenance-guard.js -- a subpopulation read must name
  -- its subpopulation.
  cohort       jsonb,

  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Recall path: "the figures for this conversation, in order".
CREATE INDEX IF NOT EXISTS bjl_session_figures_session_idx
  ON bjl_session_figures (session_id, created_at);

-- Check path: "what is this value bound to, on this item, in this session".
CREATE INDEX IF NOT EXISTS bjl_session_figures_binding_idx
  ON bjl_session_figures (session_id, item_name);

COMMENT ON TABLE bjl_session_figures IS
  'Authored figures ledger: item/score/construct bindings persisted at '
  'synthesis so later turns can recall and verify them instead of '
  'reconstructing numbers from truncated prose. Written by the synthesis '
  'path only; never scraped from bjl_query_jobs.scratch, which retains '
  'superseded and incorrect query results.';

-- =====================================================================
-- VERIFICATION
--
--   -- Table and both indexes exist:
--   --   SELECT indexname FROM pg_indexes
--   --    WHERE tablename='bjl_session_figures' ORDER BY 1;
--   --   expect: bjl_session_figures_binding_idx,
--   --           bjl_session_figures_pkey,
--   --           bjl_session_figures_session_idx
--
--   -- NOT NULL is enforced on the binding (all four must fail):
--   --   INSERT INTO bjl_session_figures (session_id,job_id,item_name,score,construct,source)
--   --     VALUES (NULL, NULL, 'x', 1, 'joy_scale', 'bjl_scores');
--   --   INSERT INTO bjl_session_figures (session_id,job_id,score,construct,source)
--   --     SELECT s.id, j.job_id, 1, 'joy_scale', 'bjl_scores'
--   --       FROM bjl_sessions s, bjl_query_jobs j LIMIT 1;
--   --   INSERT INTO bjl_session_figures (session_id,job_id,item_name,construct,source)
--   --     SELECT s.id, j.job_id, 'x', 'joy_scale', 'bjl_scores'
--   --       FROM bjl_sessions s, bjl_query_jobs j LIMIT 1;
--   --   INSERT INTO bjl_session_figures (session_id,job_id,item_name,score,source)
--   --     SELECT s.id, j.job_id, 'x', 1, 'bjl_scores'
--   --       FROM bjl_sessions s, bjl_query_jobs j LIMIT 1;
--
--   -- A well-formed row succeeds (then roll back):
--   --   BEGIN;
--   --   INSERT INTO bjl_session_figures
--   --     (session_id, job_id, item_name, score, n, construct, source, question_id)
--   --     SELECT s.id, j.job_id, 'A sense of community', 17.6, 85,
--   --            'pct_selected', 'bjl_responses', 491
--   --       FROM bjl_sessions s, bjl_query_jobs j LIMIT 1;
--   --   ROLLBACK;
--
--   -- And the whole file must run a second time without error.
-- =====================================================================
