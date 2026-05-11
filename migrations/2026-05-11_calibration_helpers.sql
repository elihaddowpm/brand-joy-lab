-- Calibration infrastructure: precision-lookup helper + coverage report
--
-- Both functions are design-agnostic. They read bjl_tag_calibration and
-- expose it cleanly so any downstream consumer (joy_map, audience profile,
-- ad-hoc query) can scale their voice to per-tag empirical accuracy
-- without re-implementing the lookup logic.

-- ---------------------------------------------------------------------------
-- bjl_tag_precision(framework, tag_key) -> numeric
--
-- Returns the precision weight to apply to a tag's count. Encapsulates the
-- "what do we do for untested or missing tags" defaults so callers don't
-- have to reinvent them.
--
-- Defaults (matching the calibration-band semantics):
--   - high / medium / low band with non-null precision → return that precision
--   - high / medium / low band with NULL precision (no calibration data
--     yet but band manually assigned) → return 1.0 (trust the band)
--   - untested band → return 0.65 (apply medium-low penalty by default)
--   - tag missing from calibration table entirely → return NULL
--     (caller decides; usually means a new tag that hasn't been registered
--     and should NOT be silently weighted)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bjl_tag_precision(
  p_framework text,
  p_tag_key   text
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN c.precision IS NOT NULL THEN c.precision
    WHEN c.confidence_band = 'untested' THEN 0.65
    WHEN c.confidence_band IN ('high','medium','low') THEN 1.0
    ELSE NULL
  END
  FROM bjl_tag_calibration c
  WHERE c.framework = p_framework AND c.tag_key = p_tag_key
  LIMIT 1;
$function$;

COMMENT ON FUNCTION bjl_tag_precision(text, text) IS
  'Returns the precision weight for a single (framework, tag_key). Encapsulates default-fallback rules. Returns NULL if the tag is not registered in bjl_tag_calibration — caller decides how to handle missing tags.';


-- ---------------------------------------------------------------------------
-- bjl_tag_calibration_coverage()
--
-- Returns a row per drift detected between bjl_tag_calibration and the four
-- framework reference tables (bjl_joy_modes, bjl_tensions,
-- bjl_functional_jobs, bjl_occasions). If everything is aligned, returns no
-- rows.
--
-- Drift types reported:
--   missing_in_calibration  — tag exists in reference table but not in calibration
--   orphan_in_calibration   — tag exists in calibration but not in reference table
--   invalid_precision       — precision outside [0, 1]
--   invalid_band            — confidence_band not in (high, medium, low, untested)
--
-- Surface this in CI or run ad-hoc whenever a framework table is changed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bjl_tag_calibration_coverage()
RETURNS TABLE (
  drift_type      text,
  framework       text,
  tag_key         text,
  details         text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
  -- Tags in the reference tables that aren't in calibration
  SELECT 'missing_in_calibration'::text, 'joy_modes'::text, mode_key::text,
         'Tag exists in bjl_joy_modes but no row in bjl_tag_calibration'::text
  FROM bjl_joy_modes
  WHERE NOT EXISTS (
    SELECT 1 FROM bjl_tag_calibration c
    WHERE c.framework = 'joy_modes' AND c.tag_key = bjl_joy_modes.mode_key
  )
  UNION ALL
  SELECT 'missing_in_calibration', 'tensions', tension_key, 'Tag exists in bjl_tensions but no row in bjl_tag_calibration'
  FROM bjl_tensions
  WHERE NOT EXISTS (
    SELECT 1 FROM bjl_tag_calibration c
    WHERE c.framework = 'tensions' AND c.tag_key = bjl_tensions.tension_key
  )
  UNION ALL
  SELECT 'missing_in_calibration', 'functional_jobs', job_key, 'Tag exists in bjl_functional_jobs but no row in bjl_tag_calibration'
  FROM bjl_functional_jobs
  WHERE NOT EXISTS (
    SELECT 1 FROM bjl_tag_calibration c
    WHERE c.framework = 'functional_jobs' AND c.tag_key = bjl_functional_jobs.job_key
  )
  UNION ALL
  SELECT 'missing_in_calibration', 'occasions', occasion_key, 'Tag exists in bjl_occasions but no row in bjl_tag_calibration'
  FROM bjl_occasions
  WHERE NOT EXISTS (
    SELECT 1 FROM bjl_tag_calibration c
    WHERE c.framework = 'occasions' AND c.tag_key = bjl_occasions.occasion_key
  )
  -- Orphan calibration rows (no matching tag in reference tables)
  UNION ALL
  SELECT 'orphan_in_calibration', c.framework, c.tag_key,
         'Calibration row exists but no matching tag in the corresponding reference table'
  FROM bjl_tag_calibration c
  WHERE NOT EXISTS (
    SELECT 1 FROM bjl_joy_modes m
    WHERE c.framework = 'joy_modes' AND c.tag_key = m.mode_key
  )
    AND NOT EXISTS (
      SELECT 1 FROM bjl_tensions t
      WHERE c.framework = 'tensions' AND c.tag_key = t.tension_key
    )
    AND NOT EXISTS (
      SELECT 1 FROM bjl_functional_jobs j
      WHERE c.framework = 'functional_jobs' AND c.tag_key = j.job_key
    )
    AND NOT EXISTS (
      SELECT 1 FROM bjl_occasions o
      WHERE c.framework = 'occasions' AND c.tag_key = o.occasion_key
    )
  -- Invalid precision values
  UNION ALL
  SELECT 'invalid_precision', framework, tag_key,
         'precision = ' || precision::text || ' (must be in [0, 1] or NULL)'
  FROM bjl_tag_calibration
  WHERE precision IS NOT NULL AND (precision < 0 OR precision > 1)
  -- Invalid band (CHECK constraint should prevent this; included for completeness)
  UNION ALL
  SELECT 'invalid_band', framework, tag_key,
         'confidence_band = ' || COALESCE(confidence_band, '<null>')
  FROM bjl_tag_calibration
  WHERE confidence_band IS NULL OR confidence_band NOT IN ('high','medium','low','untested')
  ORDER BY drift_type, framework, tag_key;
$function$;

COMMENT ON FUNCTION bjl_tag_calibration_coverage() IS
  'Returns one row per drift between bjl_tag_calibration and the four framework reference tables, or empty result if everything is aligned. Run ad-hoc or in CI before deploying tagger / joy_map changes.';
