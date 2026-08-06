-- verify_anon_read_lockdown.sql
--
-- The control for migrations/2026-08-06_read_lockdown_allowlist_sweep.sql.
-- Run it before the sweep and after it, and after anything that touches
-- grants in schema public.
--
--
-- IT PROBES. IT DOES NOT READ THE GRANT TABLE.
--
-- That is the whole design and it is not a preference. On
-- bjl_front_door_log the catalog said anon was denied while anon read 22
-- rows out of it through a SECURITY DEFINER view. has_table_privilege
-- answers "is there a grant on this object", which is a different
-- question from "can anon get these rows", and the gap between the two
-- questions is exactly where the hole lived. So this script sets the
-- role and issues the SELECT.
--
--
-- HOW TO RUN
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f bin/verify_anon_read_lockdown.sql
--
-- Or paste it whole into the Supabase SQL editor. No psql meta-commands
-- are used, deliberately, so both paths work and a second reviewer can
-- run it independently without this repo checked out.
--
-- READ-ONLY AND SELF-REVERTING. Everything happens inside one
-- transaction that always ends in ROLLBACK. SET LOCAL ROLE dies with the
-- transaction. A failure raises before the ROLLBACK, which also discards
-- everything. There is no path through this file that writes.
--
-- Requires a role that can SET ROLE anon — postgres or the migration
-- role. It cannot be run from the anon key itself, which is the point:
-- it asks what anon could do, from somewhere anon cannot reach.
--
--
-- THE THREE STATES, AND WHY TWO OF THEM ARE NOT "PASS"
--
--   DENIED     SELECT raised 42501. anon cannot reach the object.
--   EMPTY      SELECT succeeded and returned no rows.
--   ROWS       SELECT succeeded and returned at least one row.
--
-- EMPTY IS A FAILURE HERE, not a pass. It means the grant is open and
-- something downstream — RLS, or an empty table — is what stopped the
-- data. RLS being load-bearing is fine when it is the intended control,
-- but an object that is EMPTY today is one policy edit or one INSERT
-- from being ROWS, and nothing would announce that. DENIED is a
-- property of the grant; EMPTY is a property of the current contents.
-- Only the first is a lock. Both are reported separately so the
-- distinction is visible rather than collapsed into "not readable".
--
--
-- WHAT IT CANNOT SEE, STATED SO THE GREEN IS NOT OVERREAD
--
--   1. It tests anon reachability. It does NOT test that the app works.
--      The app runs as service_role and will pass this file's silence
--      no matter what breaks. The browser smoke is not redundant with
--      this probe — it is the only thing that catches a revoke that hit
--      service_role.
--
--   2. EXECUTE is checked from the catalog, not by calling. See STEP 2.
--
--   3. Schema public only, matching the sweep. storage, realtime,
--      extensions, auth, graphql and graphql_public are out of scope in
--      both files, for the same reason: platform-managed.
--
--
-- WHAT WAS RUN BEFORE THIS FILE WAS CHECKED IN — AND WHAT WAS NOT
--
-- A check that has only ever been seen to pass is not a check. Both
-- failure arms were made to fire against live, on purpose:
--
--   BASELINE, pre-sweep, both DO blocks verbatim:
--     step 1 raised   96 probed / 26 denied / 22 rows / 48 empty,
--                     70 objects named as reachable-and-not-allowlisted
--     step 2 raised   4 SECURITY DEFINER functions executable by anon
--
--   THE DARKENED ARM, forced: allowlist temporarily set to
--     ['bjl_front_door_log','bjl_front_door_health'] — both known
--     denied — and it fired and named both. That arm is unreachable
--     with a genuinely empty allowlist, so it was tested the only way
--     it can be. It re-confirms in passing that the front_door_health
--     bypass closed on Aug 6 is still closed.
--
--   THE WRAPPER: BEGIN / SET LOCAL ROLE anon / RESET ROLE / ROLLBACK
--     executed end to end; current_user was postgres afterwards.
--
--   AND THEN IT EARNED ITS PLACE MID-SWEEP. Run between step 2a and
--     step 2b of the migration, STEP 2 below caught a SECURITY DEFINER
--     function still executable by anon after the revoke that was
--     supposed to close it: bjl_public_segment_read held EXECUTE via a
--     grant to PUBLIC, which REVOKE ... FROM anon, authenticated does
--     not remove. Three siblings with explicit anon grants had gone.
--     The migration was corrected and re-probed clean.
--
--     Note what that depended on: has_function_privilege reports TRUE
--     for a privilege inherited from PUBLIC, so this check sees the
--     effective right rather than the written grant. Enumerating
--     pg_proc.proacl for the literal strings 'anon=X' / 'authenticated=X'
--     would have returned nothing and passed. Cheap to get wrong,
--     silent when wrong.
--
--   AFTER, final: probed 96 | denied 96 | rows 0 | empty 0 |
--     definer functions executable by anon 0. service_role reads 96 of
--     96 and executes 81 of 81 app-defined functions.
--
-- NOT RUN, AND STATED SO THE GREEN IS NOT OVERREAD: this file has not
-- been executed through psql. psql is not installed on the machine
-- this was written on, and neither is brew, docker or the supabase
-- CLI, so it could not be installed to find out. The two DO blocks and
-- the transaction wrapper ran through the Supabase SQL path — that is
-- where every number above came from. The exit code is the one claim
-- here that is inherited rather than observed, and it is flagged
-- rather than quietly carried.
--
-- IF YOU GATE ON THIS FILE, TEST FOR NON-ZERO. NOT FOR 1.
--
-- psql's documented contract is: 0 normal, 1 a fatal error of psql's
-- own (out of memory, file not found), 2 a bad connection, and 3 an
-- error in a script when ON_ERROR_STOP is set. A RAISE EXCEPTION from
-- the blocks below is a script error, so it should exit 3.
--
--     if ! psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--          -f bin/verify_anon_read_lockdown.sql; then ...      # correct
--
--     psql ... ; [ $? -eq 1 ] && fail                          # WRONG
--
-- The second form passes silently on the exact failure this file
-- exists to raise, because the code is 3 and not 1. That is the same
-- shape as everything else in this arc — a check that looks like it
-- tests the thing and tests something adjacent — so it is written down
-- here rather than left to whoever wires up the gate.
--
-- Still confirm it. Documented behaviour is a better prior than a
-- guess and is not a substitute for having watched it. Run the file
-- once against live with a deliberately non-empty allowlist so it
-- raises, and check the code is non-zero before trusting the file as
-- a gate.


BEGIN;


-- -------------------------------------------------------------------
-- STEP 1 — probe every table, view and matview in public AS anon.
--
-- The allowlist must be kept identical to the one in the migration.
-- Two copies, and that is a real cost, but the alternative is the check
-- importing its expectations from the thing it is checking, which is
-- not a check. Empty in both files today.
-- -------------------------------------------------------------------
DO $$
DECLARE
  allowlist  text[] := ARRAY[]::text[];
  r          record;
  n_probed   int := 0;
  n_denied   int := 0;
  n_empty    int := 0;
  n_rows     int := 0;
  n_error    int := 0;
  reachable  text[] := ARRAY[]::text[];
  findings   text[] := ARRAY[]::text[];
  darkened   text[];
  unexpected text[];
  hit        int;
  line       text;
BEGIN
  SET LOCAL ROLE anon;

  FOR r IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p','v','m')
    ORDER BY c.relname
  LOOP
    n_probed := n_probed + 1;

    -- Each iteration is its own subtransaction, so a permission denial
    -- rolls back to here rather than aborting the whole probe. LIMIT 1
    -- keeps it cheap: reachability, not a count.
    BEGIN
      EXECUTE format(
        'SELECT count(*) FROM (SELECT 1 FROM public.%I LIMIT 1) probe', r.relname
      ) INTO hit;

      reachable := reachable || r.relname;
      IF hit > 0 THEN
        n_rows := n_rows + 1;
        findings := findings || format('  ROWS    %-6s %s', r.relkind, r.relname);
      ELSE
        n_empty := n_empty + 1;
        findings := findings || format('  EMPTY   %-6s %s  (granted; RLS or no data)', r.relkind, r.relname);
      END IF;

    EXCEPTION
      WHEN insufficient_privilege THEN
        n_denied := n_denied + 1;

      WHEN OTHERS THEN
        -- Not a reachability result. A broken view or a missing
        -- dependency lands here, and it must be shown rather than
        -- counted as denied — "it errored" reading as "it is locked" is
        -- the false green this file exists to prevent.
        n_error := n_error + 1;
        findings := findings || format('  ERROR   %-6s %s  (%s: %s)', r.relkind, r.relname, SQLSTATE, SQLERRM);
    END;
  END LOOP;

  RESET ROLE;

  -- Reachable but not allowlisted: the lock has a hole.
  SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::text[]) INTO unexpected
  FROM unnest(reachable) AS x
  WHERE NOT (x = ANY (allowlist));

  -- Allowlisted but not reachable: the public surface went dark. Vacuous
  -- while the allowlist is empty, and here for the day it is not — this
  -- half is what would catch a revoke that went too far.
  SELECT coalesce(array_agg(x ORDER BY x), ARRAY[]::text[]) INTO darkened
  FROM unnest(allowlist) AS x
  WHERE NOT (x = ANY (reachable));

  RAISE NOTICE '';
  RAISE NOTICE 'ANON READ PROBE — schema public';
  RAISE NOTICE '  probed  %', n_probed;
  RAISE NOTICE '  denied  %   <- the locked state', n_denied;
  RAISE NOTICE '  rows    %', n_rows;
  RAISE NOTICE '  empty   %   <- granted, not locked', n_empty;
  RAISE NOTICE '  error   %', n_error;
  RAISE NOTICE '  allowlist: %', CASE WHEN cardinality(allowlist) = 0
                                      THEN '(empty)' ELSE array_to_string(allowlist, ', ') END;

  IF cardinality(findings) > 0 THEN
    RAISE NOTICE '';
    RAISE NOTICE 'REACHABLE AS ANON:';
    FOREACH line IN ARRAY findings LOOP
      RAISE NOTICE '%', line;
    END LOOP;
  END IF;

  IF cardinality(darkened) > 0 THEN
    RAISE EXCEPTION E'ALLOWLISTED OBJECTS ARE NOT REACHABLE AS ANON — the public surface is dark:\n  %',
      array_to_string(darkened, E'\n  ');
  END IF;

  IF cardinality(unexpected) > 0 THEN
    RAISE EXCEPTION E'% OBJECT(S) READABLE BY ANON AND NOT ON THE ALLOWLIST:\n  %',
      cardinality(unexpected), array_to_string(unexpected, E'\n  ');
  END IF;

  IF n_error > 0 THEN
    RAISE EXCEPTION '% object(s) raised an error that was not a permission denial — see REACHABLE list above. Not treating that as locked.', n_error;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE 'PASS — probed % objects as anon: 0 reachable, % denied.', n_probed, n_denied;
END $$;


-- -------------------------------------------------------------------
-- STEP 2 — enumerate SECURITY DEFINER functions anon or authenticated
--          can EXECUTE.
--
-- HONEST DIFFERENCE FROM STEP 1: this reads the catalog. It is the same
-- kind of query that produced the false green on the read side, so it
-- needs a reason rather than an exemption.
--
-- The reason is that the two cases are not analogous. On the table side
-- the grant and the reachability came apart, because a definer view can
-- sit in front of a table and serve rows the grant denies. There is no
-- equivalent layer in front of a function: EXECUTE on the function IS
-- the ability to call it, and has_function_privilege answers exactly
-- that. Nothing stands between the grant and the call.
--
-- The alternative — actually invoking each function as anon — is worse
-- and not more truthful. It needs synthesised arguments for every
-- signature, it cannot distinguish "denied" from "denied-shaped
-- argument error", and a VOLATILE function would write. A probe that
-- has to mutate the database to report on it is not a probe.
--
-- Extension-owned functions are excluded, matching the sweep: they are
-- SECURITY INVOKER, execute as the caller, and are not a privilege
-- boundary.
-- -------------------------------------------------------------------
DO $$
DECLARE
  r     record;
  found text[] := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig,
           array_to_string(ARRAY(
             SELECT g FROM unnest(ARRAY['anon','authenticated']) g
             WHERE has_function_privilege(g, p.oid, 'EXECUTE')
           ), ', ') AS roles
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public'
      AND d.objid IS NULL
      AND p.prosecdef
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ORDER BY 1
  LOOP
    found := found || format('  %s  [%s]', r.sig, r.roles);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'SECURITY DEFINER functions executable by anon/authenticated: %', cardinality(found);

  IF cardinality(found) > 0 THEN
    RAISE EXCEPTION E'% SECURITY DEFINER FUNCTION(S) EXECUTABLE BY ANON OR AUTHENTICATED:\n%',
      cardinality(found), array_to_string(found, E'\n');
  END IF;

  RAISE NOTICE 'PASS — the definer RPC vector is closed.';
END $$;


-- Always. Nothing above this line writes, and this is the second reason
-- it cannot.
ROLLBACK;
