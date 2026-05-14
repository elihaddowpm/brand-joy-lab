-- v7 framework retag — schema support
--
-- Adds framework_version column to bjl_verbatims so we can distinguish v6
-- and v7 prompt outputs, and creates a sibling RPC bjl_update_haiku_tags_v7
-- that the targeted retag script uses to write tags + version atomically.

ALTER TABLE bjl_verbatims
  ADD COLUMN IF NOT EXISTS framework_version text DEFAULT 'v6';

COMMENT ON COLUMN bjl_verbatims.framework_version IS
  'Which Haiku framework-tagger prompt version produced the *_haiku tags. v6 = May 2026 full backfill; v7 = May 2026 targeted over-firer retag (Rule 9 added).';

CREATE OR REPLACE FUNCTION public.bjl_update_haiku_tags_v7(rows jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  rows_updated INT := 0;
BEGIN
  WITH input AS (
    SELECT
      (r->>'id')::INT AS id,
      COALESCE(
        (SELECT array_agg(value::text) FROM jsonb_array_elements_text(r->'joy_modes_haiku')),
        ARRAY[]::text[]) AS jm,
      COALESCE(
        (SELECT array_agg(value::text) FROM jsonb_array_elements_text(r->'tensions_haiku')),
        ARRAY[]::text[]) AS tn,
      COALESCE(
        (SELECT array_agg(value::text) FROM jsonb_array_elements_text(r->'functional_jobs_haiku')),
        ARRAY[]::text[]) AS jb,
      COALESCE(
        (SELECT array_agg(value::text) FROM jsonb_array_elements_text(r->'occasions_haiku')),
        ARRAY[]::text[]) AS oc
    FROM jsonb_array_elements(rows) AS r
  )
  UPDATE bjl_verbatims AS v
  SET
    joy_modes_haiku       = input.jm,
    tensions_haiku        = input.tn,
    functional_jobs_haiku = input.jb,
    occasions_haiku       = input.oc,
    framework_scanned_at  = NOW(),
    framework_version     = 'v7'
  FROM input
  WHERE v.id = input.id;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated;
END;
$function$;

COMMENT ON FUNCTION bjl_update_haiku_tags_v7(jsonb) IS
  'Bulk-update staging columns AND set framework_version=''v7''. Used by the targeted v7 over-firer retag in May 2026.';
