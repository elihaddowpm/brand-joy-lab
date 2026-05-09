-- bjl_tag_calibration: per-tag empirical precision/recall/confidence-band
-- from the v6 framework tagger 50-sample calibration.
--
-- Used by the investigator (to surface confidence info in scratch) and by
-- the synthesizer (to choose hedging language). When the investigator
-- queries verbatim tag distributions, it can JOIN this table to know how
-- to characterize the finding for the synthesizer.
--
-- Confidence bands:
--   high   = P >= 0.80, R >= 0.50, gold >= 2 in calibration sample (safe to cite confidently)
--   medium = P 0.50-0.79 OR (high P with low recall) — present directionally
--   low    = P < 0.50 OR over-fires noted in calibration — hedge or move to "worth testing"
--   untested = tag did not appear in calibration sample (n=50); no empirical data
--
-- Source: bin/test_framework_regression.py / 50-sample run on 2026-05-09.
-- Methodology and full per-row diff is in PR #19 description.

CREATE TABLE IF NOT EXISTS bjl_tag_calibration (
  framework        text NOT NULL,
  tag_key          text NOT NULL,
  precision        numeric,
  recall           numeric,
  gold_sample_n    integer NOT NULL,
  pred_sample_n    integer NOT NULL,
  confidence_band  text NOT NULL,
  notes            text,
  calibrated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (framework, tag_key),
  CHECK (framework IN ('joy_modes','tensions','functional_jobs','occasions')),
  CHECK (confidence_band IN ('high','medium','low','untested'))
);

COMMENT ON TABLE bjl_tag_calibration IS
  'Per-tag empirical accuracy from the v6 framework tagger calibration. JOIN against this when reporting tag-derived counts so the synthesizer can scale its confidence language to the tag.';

-- joy_modes
INSERT INTO bjl_tag_calibration (framework, tag_key, precision, recall, gold_sample_n, pred_sample_n, confidence_band, notes) VALUES
('joy_modes','tranquil',           1.00, 1.00, 6, 6, 'high',   'Rock solid in calibration. Includes dependable/secure-feeling per v6 anchors.'),
('joy_modes','physical',           1.00, 1.00, 2, 2, 'high',   'Rock solid.'),
('joy_modes','sentimental',        1.00, 1.00, 1, 1, 'high',   'Single-sample but consistent.'),
('joy_modes','relational',         0.89, 0.80, 10, 9, 'high',  'Most-used joy mode; calibrated cleanly.'),
('joy_modes','awe',                1.00, 0.50, 4, 3, 'high',   'High precision, moderate recall — when applied, it is right.'),
('joy_modes','aesthetic',          0.75, 1.00, 3, 4, 'high',   'v6 dramatically tightened from legacy over-tagging.'),
('joy_modes','achievement',        0.75, 1.00, 3, 4, 'high',   'v6 fixed prior R=0 blind spot via career-milestone anchors.'),
('joy_modes','hedonic',            0.67, 0.67, 6, 6, 'medium', 'v6 dramatically tightened from legacy over-tagging. Use directional language.'),
('joy_modes','playful',            0.57, 1.00, 4, 7, 'medium', 'High recall, moderate precision; some over-fires on internet/movie habits.'),
('joy_modes','inspirational',      0.50, 0.44, 9, 8, 'low',    'Mixed precision and recall; over-fires on positive forward-looking statements.'),
('joy_modes','freedom',            NULL, 0.00, 2, 0, 'low',    'Both calibration cases were missed. Prefer hedging or pull verbatim text.'),
('joy_modes','self_actualization', NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('joy_modes','spiritual',          NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('joy_modes','triumph',            NULL, NULL, 0, 0, 'untested','No calibration sample.'),

-- tensions
('tensions','challenger_vs_legacy',     1.00, 1.00, 1, 1, 'high',   'Rock solid in calibration.'),
('tensions','dwelling_vs_advancing',    1.00, 1.00, 1, 1, 'high',   'New-in-v6 tension; calibrated cleanly.'),
('tensions','self_vs_others',           1.00, 1.00, 1, 1, 'high',   'Requires both poles named.'),
('tensions','served_vs_overlooked',     1.00, 1.00, 1, 1, 'high',   'v6 fixed prior R=0 blind spot. Captures positive-framing aspiration about underserved groups.'),
('tensions','luxury_vs_value',          0.67, 1.00, 2, 3, 'medium', 'Requires BOTH pulls present. Some over-fires when only one side is named.'),
('tensions','aspiration_vs_acceptance', 0.25, 1.00, 1, 4, 'low',    'v6 disambiguation rule overshot. Over-applies to mixed-feelings verbatims. Hedge or reverify.'),
('tensions','present_vs_future',        0.00, NULL, 0, 2, 'low',    'Over-fires on aspirational forward-looking statements without explicit financial trade-off.'),
('tensions','control_vs_surrender',     0.00, NULL, 0, 1, 'low',    'Over-fired in calibration sample. Use cautiously.'),
('tensions','discovery_vs_comfort',     NULL, 0.00, 1, 0, 'low',    'Single calibration case missed.'),
('tensions','digital_vs_physical',      NULL, NULL, 0, 0, 'untested','No calibration sample. Population n=17 across corpus — rare tag.'),
('tensions','individual_vs_communal',   NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('tensions','introvert_vs_extrovert',   NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('tensions','moderation_vs_indulgence', NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('tensions','performance_vs_pleasure',  NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('tensions','tradition_vs_modern',      NULL, NULL, 0, 0, 'untested','No calibration sample.'),

-- functional_jobs
('functional_jobs','signal_identity',   1.00, 1.00, 3, 3, 'high',   'v6 fixed prior R=0 blind spot via uniform/fan-merch anchors.'),
('functional_jobs','feel_proud',        1.00, 0.75, 4, 3, 'high',   'High precision; recall slightly under-applied.'),
('functional_jobs','build_belonging',   1.00, 0.50, 2, 1, 'high',   'High precision; recall moderate.'),
('functional_jobs','reward_self',       1.00, 1.00, 2, 2, 'high',   'Rock solid.'),
('functional_jobs','cheer_team',        1.00, 1.00, 1, 1, 'high',   'Single-sample but clean.'),
('functional_jobs','plan_future',       1.00, 1.00, 1, 1, 'high',   'Single-sample but clean.'),
('functional_jobs','provide_security',  1.00, 1.00, 1, 1, 'high',   'Single-sample but clean.'),
('functional_jobs','escape_routine',    1.00, 0.33, 3, 1, 'medium', 'High precision, low recall — under-tagged in calibration.'),
('functional_jobs','relax_recover',     0.80, 1.00, 4, 5, 'high',   'Calibrated cleanly.'),
('functional_jobs','immerse_in_story',  0.80, 0.80, 5, 5, 'high',   'Some over-fires on music/history without explicit narrative; mostly right.'),
('functional_jobs','demonstrate_care',  0.75, 0.75, 4, 4, 'high',   'Calibrated cleanly.'),
('functional_jobs','share_experience',  0.75, 1.00, 3, 4, 'high',   'High recall.'),
('functional_jobs','learn_grow',        0.60, 1.00, 3, 5, 'medium', 'Some over-fires on motivational/educational ad mentions.'),
('functional_jobs','create_memory',     0.50, 1.00, 1, 2, 'medium', 'Single calibration case; limited data.'),
('functional_jobs','nourish_others',    0.00, NULL, 0, 2, 'low',    'Over-fired in calibration sample.'),
('functional_jobs','mark_milestone',    NULL, 0.00, 1, 0, 'low',    'Single calibration case missed.'),
('functional_jobs','refuel',            NULL, 0.00, 1, 0, 'low',    'Single calibration case missed.'),
('functional_jobs','relieve_anxiety',   NULL, 0.00, 1, 0, 'low',    'Single calibration case missed.'),
('functional_jobs','compete',           NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('functional_jobs','connect_remotely',  NULL, NULL, 0, 0, 'untested','No calibration sample. v6 anti-pattern added against generic "connected" language.'),
('functional_jobs','display_taste',     NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('functional_jobs','express_creativity',NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('functional_jobs','preserve_tradition',NULL, NULL, 0, 0, 'untested','No calibration sample.'),

-- occasions
('occasions','vacation',         1.00, 0.83, 12, 10, 'high', 'High precision, large sample.'),
('occasions','live_event',       1.00, 0.75, 4, 3, 'high',  'High precision.'),
('occasions','mealtime',         1.00, 0.67, 3, 2, 'high',  'High precision.'),
('occasions','gift_giving',      1.00, 1.00, 1, 1, 'high',  'Single-sample but clean.'),
('occasions','purchase_moment',  1.00, 1.00, 1, 1, 'high',  'Single-sample but clean.'),
('occasions','sports_viewing',   1.00, 1.00, 1, 1, 'high',  'Single-sample but clean.'),
('occasions','work',             1.00, 1.00, 1, 1, 'high',  'Single-sample but clean.'),
('occasions','memory',           0.67, 1.00, 2, 3, 'medium','Some over-fires.'),
('occasions','shopping',         0.67, 1.00, 2, 3, 'medium','Some over-fires on ad-recall verbatims.'),
('occasions','everyday',         0.40, 1.00, 2, 5, 'low',   'Over-fires on internet/movie habit verbatims.'),
('occasions','gathering',        0.50, 1.00, 1, 2, 'medium','Single calibration case; limited data.'),
('occasions','post_purchase',    0.60, 1.00, 3, 5, 'medium','Some over-fires; v6 added guardrail but residual issues.'),
('occasions','anticipation',     0.50, 1.00, 4, 8, 'low',   'Over-fires on hypothetical/forward-looking framings despite v6 hard-gate.'),
('occasions','special_occasion', NULL, 0.00, 2, 0, 'low',   'Both calibration cases missed.'),
('occasions','celebration',      0.00, NULL, 0, 1, 'low',   'Over-fired in calibration.'),
('occasions','in_moment',        0.00, NULL, 0, 1, 'low',   'Over-fired in calibration.'),
('occasions','service',          NULL, NULL, 0, 0, 'untested','New-in-v6 occasion. No calibration sample.'),
('occasions','holiday',          NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('occasions','hosting',          NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('occasions','alone_time',       NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('occasions','birthday',         NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('occasions','evening',          NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('occasions','morning',          NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('occasions','transition',       NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('occasions','travel_journey',   NULL, NULL, 0, 0, 'untested','No calibration sample.'),
('occasions','weekend',          NULL, NULL, 0, 0, 'untested','No calibration sample.');

-- Allow read access for the anon/authenticated roles so the investigator
-- (which connects via the BJL-tool service role) and the public RPCs can
-- both read confidence-band info.
ALTER TABLE bjl_tag_calibration ENABLE ROW LEVEL SECURITY;

CREATE POLICY bjl_tag_calibration_read_all
  ON bjl_tag_calibration FOR SELECT
  USING (true);
