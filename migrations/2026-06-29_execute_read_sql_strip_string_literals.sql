-- v8.5 — Fix false-positive in execute_read_sql's keyword guard.
-- See full description in this migration's apply_migration call. Source
-- of truth for the function definition lives in the live database.

CREATE OR REPLACE FUNCTION public.execute_read_sql(query_text text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout TO '90s'
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result text;
  cleaned text;
  no_escaped_quotes text;
  stripped text;
  upper_stripped text;
  result_json json;
BEGIN
  cleaned := regexp_replace(btrim(query_text), ';+\s*$', '');
  no_escaped_quotes := replace(cleaned, '''''', chr(7));
  stripped := regexp_replace(no_escaped_quotes, '''[^'']*''', '', 'g');
  upper_stripped := upper(stripped);
  IF upper_stripped ~ '\m(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|MERGE|COPY|REINDEX|VACUUM)\M' THEN
    RAISE EXCEPTION 'Read-only queries only. Operation rejected: %', cleaned;
  END IF;
  IF upper_stripped ~ '\m(PG_READ_FILE|PG_LS_DIR|DBLINK|LO_IMPORT|LO_EXPORT|CURRENT_SETTING|SET_CONFIG)\M' THEN
    RAISE EXCEPTION 'Restricted function call rejected';
  END IF;
  EXECUTE 'SELECT json_agg(t) FROM (' || cleaned || ') t' INTO result_json;
  RETURN COALESCE(result_json, '[]'::json);
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$function$;
