-- April 2026 Phase 5 — promote *_haiku shadow columns to live framework arrays.
--
-- Workflow: scripts/april_framework_scan.py runs Haiku 4.5 over the 1,000
-- April 2026 verbatims and writes joy_modes / tensions / functional_jobs /
-- occasions tags into *_haiku SHADOW columns plus framework_scanned_at.
-- After operator review of a sample diff (Eli signed off May 2026), this
-- migration promotes the shadow values into the live array columns and
-- flips is_quotable=false on rows whose response_text is null/whitespace.
--
-- Idempotent: re-running is safe — UPDATE matches on year_month + the
-- framework_scanned_at sentinel and overwrites with the same shadow values.

WITH promoted AS (
  UPDATE bjl_verbatims
  SET joy_modes       = joy_modes_haiku,
      tensions        = tensions_haiku,
      functional_jobs = functional_jobs_haiku,
      occasions       = occasions_haiku
  WHERE year_month = '2026-04'
    AND framework_scanned_at IS NOT NULL
  RETURNING 1
),
unquotable AS (
  UPDATE bjl_verbatims
  SET is_quotable = false
  WHERE year_month = '2026-04'
    AND (response_text IS NULL OR LENGTH(TRIM(response_text)) < 5)
  RETURNING 1
)
SELECT (SELECT COUNT(*) FROM promoted)  AS rows_promoted,
       (SELECT COUNT(*) FROM unquotable) AS rows_marked_unquotable;
-- Expected on first apply: rows_promoted=886, rows_marked_unquotable=114.
