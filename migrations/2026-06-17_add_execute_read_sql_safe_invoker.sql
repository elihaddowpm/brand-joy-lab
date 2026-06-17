-- v7.2 — anon-safe twin of execute_read_sql.
--
-- The original execute_read_sql is SECURITY DEFINER (owned by postgres),
-- so calling it from an anon client bypasses anon's role-based grants.
-- That defeats the lockdown that grants anon SELECT only on the seven
-- _safe views and zero privileges on the base tables.
--
-- This new function carries the same defenses (read-only enforcement,
-- restricted-function blocklist, 90s statement timeout, locked
-- search_path) but is SECURITY INVOKER so the calling role's grants
-- apply. When the public chat calls this via the anon key, anon's
-- grants enforce the lockdown: a SQL string that targets a base table
-- gets "permission denied" before any row is read, and a SQL string
-- that forgets a public_safe filter still cannot reach a gated row
-- because the row never appears in the _safe views.
--
-- The original execute_read_sql is untouched and continues to serve
-- workbench backend calls that run as service-role.

CREATE OR REPLACE FUNCTION public.execute_read_sql_safe(query_text text)
RETURNS json
LANGUAGE plpgsql
SECURITY INVOKER
SET statement_timeout TO '90s'
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  result json;
  upper_query text;
  cleaned text;
BEGIN
  cleaned := regexp_replace(btrim(query_text), ';+\s*$', '');
  upper_query := upper(cleaned);
  IF upper_query ~ '\m(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|MERGE|COPY|REINDEX|VACUUM)\M' THEN
    RAISE EXCEPTION 'Read-only queries only. Operation rejected: %', cleaned;
  END IF;
  IF upper_query ~ '\m(PG_READ_FILE|PG_LS_DIR|DBLINK|LO_IMPORT|LO_EXPORT|CURRENT_SETTING|SET_CONFIG)\M' THEN
    RAISE EXCEPTION 'Restricted function call rejected';
  END IF;

  EXECUTE 'SELECT json_agg(t) FROM (' || cleaned || ') t' INTO result;
  RETURN COALESCE(result, '[]'::json);
EXCEPTION
  WHEN OTHERS THEN
    RETURN json_build_object('error', SQLERRM, 'sqlstate', SQLSTATE);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.execute_read_sql_safe(text) TO anon;
GRANT EXECUTE ON FUNCTION public.execute_read_sql_safe(text) TO authenticated;
