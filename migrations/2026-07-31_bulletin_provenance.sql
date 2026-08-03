-- Migration: the Bulletin's two tables, under version control at last,
-- plus the provenance a machine-generated draft has to carry.
--
-- bjl_opportunities and bjl_marketplace_signals have been live for some
-- time with no DDL anywhere in this repo and no mention in schema_doc.
-- Their shape existed only in the database and in whatever
-- bjl-opportunities.js assumed about it. The CREATE TABLE blocks below
-- are that shape, reconstructed from the live schema on 2026-07-31 and
-- verified column by column, so a fresh environment can be stood up and
-- so the next change has a file to land in.
--
-- READ THIS BEFORE EDITING: the CREATE TABLE statements are no-ops on the
-- live database. Both tables already exist, so IF NOT EXISTS skips them
-- entirely — including any column added inside them. That is why every
-- new column has its own ALTER further down. Adding a column to the
-- CREATE block alone would appear to work, pass review, and change
-- nothing on the only database that matters.
--
-- Both tables were empty when this was written (0 opportunities, 0
-- signals), so the CHECK constraints cannot fail on existing data and no
-- backfill is needed. If that stops being true, validate before running.

-- ---------------------------------------------------------------------
-- bjl_marketplace_signals — marketplace observations.
--
-- Signals never join respondent tables. They are what the market said,
-- kept structurally separate from what respondents were measured saying,
-- so a card can cite both without the two ever being averaged together.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bjl_marketplace_signals (
  signal_id      serial PRIMARY KEY,
  engagement     text NOT NULL,
  source         text NOT NULL DEFAULT 'waldo',
  theme          text NOT NULL,
  external_id    text,
  signal_type    text,
  headline       text NOT NULL,
  detail         text,
  exact_quote    text,
  urgency        text,
  source_url     text,
  owned_source   boolean DEFAULT false,
  captured_at    date NOT NULL,
  superseded_by  integer REFERENCES bjl_marketplace_signals(signal_id),
  raw            jsonb
);

-- Re-pasting the same Waldo payload supersedes rather than duplicates.
-- Partial on superseded_by IS NULL so the superseded history stays
-- addressable: only one LIVE row per (engagement, external_id).
CREATE UNIQUE INDEX IF NOT EXISTS bjl_signals_ext_engagement
  ON bjl_marketplace_signals (engagement, external_id)
  WHERE superseded_by IS NULL AND external_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- bjl_opportunities — the register. One card, one claim, one action.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bjl_opportunities (
  opportunity_id   serial PRIMARY KEY,
  engagement       text NOT NULL,
  register_number  integer,
  title            text NOT NULL,
  claim_summary    text NOT NULL,
  claim_population text NOT NULL,
  claim_items      integer[],
  evidence_tier    text NOT NULL,
  signal_ids       integer[],
  action           text NOT NULL,
  window_label     text,
  window_date      daterange,
  owner            text,
  status           text NOT NULL DEFAULT 'candidate',
  prediction_id    integer,
  notes            text,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

-- The provenance columns. See the note at the top: these are ALTERs and
-- not part of the CREATE above precisely because the CREATE never runs
-- against the live table.
--
-- source_run_id is bjl_query_jobs.job_id. Every run this tool performs —
-- data_pull, joy_map_*, audience_map — is a job row with a uuid, so one
-- column covers every generating surface. No foreign key: jobs are
-- prunable and a card must outlive the run that suggested it, keeping its
-- provenance readable as a fact about where it came from rather than a
-- live pointer that can fail.
ALTER TABLE bjl_opportunities
  ADD COLUMN IF NOT EXISTS source_run_id uuid,
  ADD COLUMN IF NOT EXISTS origin        text NOT NULL DEFAULT 'analyst',
  ADD COLUMN IF NOT EXISTS generated_by  jsonb,
  ADD COLUMN IF NOT EXISTS claim_hash    text,
  ADD COLUMN IF NOT EXISTS promoted_by   text,
  ADD COLUMN IF NOT EXISTS promoted_at   timestamptz;

COMMENT ON COLUMN bjl_opportunities.source_run_id IS
  'bjl_query_jobs.job_id of the run this card was generated from. Null on analyst-authored cards. No FK by design: the card outlives the job.';
COMMENT ON COLUMN bjl_opportunities.origin IS
  'How the card came to exist: ''analyst'' (composed by a person from a map or a finding) or ''harvest'' (drafted by the run-level generator).';
COMMENT ON COLUMN bjl_opportunities.generated_by IS
  'For harvested drafts: { model, prompt_version, generated_at }. Which model wrote this, under which rails.';
COMMENT ON COLUMN bjl_opportunities.claim_hash IS
  'Idempotency key for harvest. Stable over the claim''s content, so re-running a harvest supersedes its own prior drafts instead of duplicating them.';
COMMENT ON COLUMN bjl_opportunities.promoted_by IS
  'Who moved this from machine_draft to candidate. A machine draft becomes a candidate only by a human act, and this is the record of it.';

-- The status lifecycle, which until now lived only in a JS array in
-- bjl-opportunities.js. machine_draft goes at the front: it is upstream
-- of candidate, not a branch off it.
--
-- machine_draft is the structural half of the guarantee that an
-- ungroomed draft never sits in the register looking authored. The other
-- half is in the handler, where the default list excludes it. A
-- render-time flag check would have been the third-best version of this.
DO $$ BEGIN
  ALTER TABLE bjl_opportunities
    ADD CONSTRAINT bjl_opportunities_status_chk
    CHECK (status IN ('machine_draft','candidate','reviewed','selected','shipped','retired'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE bjl_opportunities
    ADD CONSTRAINT bjl_opportunities_tier_chk
    CHECK (evidence_tier IN ('measured','modeled','unmeasured','signal-only'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE bjl_opportunities
    ADD CONSTRAINT bjl_opportunities_origin_chk
    CHECK (origin IN ('analyst','harvest'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Harvest idempotency. Partial on origin='harvest' so analyst cards,
-- which carry neither column, are untouched by it.
CREATE UNIQUE INDEX IF NOT EXISTS bjl_opp_harvest_idem
  ON bjl_opportunities (source_run_id, claim_hash)
  WHERE origin = 'harvest';
