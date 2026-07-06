-- v9.14 — Progress streaming for the public chat loading state.
--
-- Adds two columns to bjl_query_jobs that the background function
-- writes at each pipeline stage and the frontend polls to render a
-- progress-aware loading bubble ("Reading through what people said…"
-- → "Weighing 47 findings for the sharpest angle…").
--
-- progress_stage : one of 'queued' | 'classifying' | 'retrieving' |
--                  'composing' | 'grounding' | 'complete'. Text (not
--                  an enum) so future stages don't require a schema
--                  change.
-- progress_hint  : optional metadata for the current stage. Today
--                  it carries { total_rows: <int> } written after
--                  retrieve() completes so the composing state can
--                  render the row count. jsonb keeps it extensible.

ALTER TABLE bjl_query_jobs
  ADD COLUMN IF NOT EXISTS progress_stage text,
  ADD COLUMN IF NOT EXISTS progress_hint  jsonb;
