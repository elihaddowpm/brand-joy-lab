-- 2026-08-06 — Close the read side, and write down the public API that
--               was never in this repo.
--
-- Two jobs in one file, and the second is the more valuable one.
--
--
-- APPLIED 2026-08-06, stepwise, probing after each step so a darkening
-- attributes to one step rather than to the sweep. Recorded in the
-- database as:
--
--     read_lockdown_step1_revoke_select
--     read_lockdown_step2a_revoke_execute_definer
--     read_lockdown_step2a_fix_revoke_public_definer   <-- see step 2a
--     read_lockdown_step2b_revoke_execute_invoker
--     read_lockdown_step3_security_invoker_live_bypass_views
--     read_lockdown_step4_default_privileges_born_closed
--
-- The extra record is not noise; it is the between-step probe doing its
-- job. Step 2a ran, reported success, and left a SECURITY DEFINER
-- function executable by anon through a grant to PUBLIC. The file as
-- checked in is the CORRECTED form and is re-runnable: replaying it
-- reaches the same end state in one pass.
--
--   BEFORE   probed 96 | denied 26 | rows 22 | empty 48 | definer RPC 4
--   AFTER    probed 96 | denied 96 | rows  0 | empty  0 | definer RPC 0
--
--   service_role after:  reads 96 of 96 objects,
--                        executes 81 of 81 app-defined functions.
--
-- That last line is the one that matters most and the one this file
-- cannot prove on its own. The anon probe passes whether or not the app
-- works, because the app runs as service_role. The browser smoke is not
-- redundant with the probe.
--
--
-- ===================================================================
-- PART ONE: THE PUBLIC API, DOCUMENTED FOR THE FIRST TIME
-- ===================================================================
--
-- The public read surface works correctly by a mechanism that existed
-- NOWHERE in this repository — not in migrations/, not in docs/, not
-- referenced by any function, page or script. Eleven SECURITY DEFINER
-- views and four SECURITY DEFINER functions, six of the views carrying
-- an explicit security_invoker=false. Someone built it deliberately and
-- correctly, and never wrote it down.
--
-- Every wrong turn on this task came out of that absence. A first plan
-- revoked base tables because tables were what could be seen from the
-- repo, and would have verified itself green while definer views kept
-- serving. A second plan proposed flipping every view to
-- security_invoker=true, which would have taken the public surface down,
-- because nothing in the repo said those views bypass ON PURPOSE.
--
-- So this section is not documentation hygiene. It is the control that
-- would have prevented both errors.
--
--
-- THE PUBLIC READ API — SEVEN VIEWS
--
--     bjl_public_scores_safe            bjl_public_insights_safe
--     bjl_public_distributions_safe     bjl_public_ordinal_safe
--     bjl_public_agreement_safe         bjl_public_verbatim_truths_safe
--     bjl_laws_safe
--
-- Each is owned by postgres and runs in DEFINER mode (security_invoker
-- is false, set explicitly on six of them). Their base tables
-- (bjl_public_scores, bjl_laws, and siblings) deny anon and
-- authenticated. The definer bypass IS the serving mechanism: the base
-- table is closed and the view is the door, exposing a filtered shape.
--
--     DO NOT SET security_invoker=true ON THESE SEVEN.
--
-- That is not a style preference. An invoker-mode view executes as its
-- caller, so it would run against a base table the caller is denied on
-- and return "permission denied". Flipping them darkens the public
-- surface. This paragraph exists because that change was proposed, in
-- good faith, by someone reading a repo that did not contain this file.
--
--
-- THE PUBLIC SEARCH API — FOUR FUNCTIONS
--
--     bjl_public_segment_read(integer, text, text)
--     public_search_scores_fts(text, integer)
--     public_search_scores_semantic(vector, integer)
--     retrieve_thematic_batteries(vector, integer, integer)
--
-- All SECURITY DEFINER, all STABLE, all owned by postgres. They run as
-- owner and therefore survive any table-level revoke, which is why the
-- public chat kept working after bjl_public_scores was closed to anon.
--
-- Called from netlify/functions/bjl-public-chat-background.js and
-- bin/smoke_public_segments.js.
--
--
-- ===================================================================
-- PART TWO: THE SWEEP, AND WHY THE ALLOWLIST IS EMPTY
-- ===================================================================
--
-- Those fifteen objects are the public API going forward. They are NOT
-- on the allowlist below, and that is not a contradiction — it is the
-- finding.
--
-- Nothing reaches them as anon. Verified against live rather than
-- reasoned:
--
--   - The only browser Supabase client (index.html:8588) is used for
--     getSession / onAuthStateChange / signInWithOAuth / signOut. It
--     performs no table read.
--   - There is not one .rpc( call across index.html, public-chat.html
--     or archive/index_v1.html. public-chat.html reaches the backend
--     through /api/* netlify functions only.
--   - All four RPCs resolve to bjl-public-chat-background.js, which
--     builds its client from SUPABASE_SERVICE_KEY (line 37).
--   - service_role has rolbypassrls=true and 96 SELECT grants in
--     public, and can read the base tables, read the _safe views, and
--     execute all four functions.
--
-- So the public API is served entirely by service_role, server-side.
-- The anon grants on it were an unused key opening unused windows.
-- Revoking them leaves every one of the fifteen objects fully
-- functional for the only caller that ever used them.
--
-- The allowlist is therefore EMPTY. anon and authenticated get no read
-- access to anything in schema public.
--
--
-- WHAT THE BASELINE PROBE ACTUALLY FOUND, BEFORE ANY OF THIS RAN
--
--     probed                                          96
--     denied (42501)                                  26
--     reachable, returning rows                       22
--     reachable, returning nothing                    48
--     definer functions executable by anon             4
--
-- The 48 are the number worth pausing on, and no grant query would
-- have separated them from the 26. anon holds SELECT on all 48 and
-- gets no rows, because those tables have RLS on with zero policies
-- and RLS with no policy denies everything. They are not locked. They
-- are unlocked with a second lock behind them, and the second lock is
-- one CREATE POLICY away from opening. Step 1 turns all 48 into real
-- denials, which is the substance of this migration and is not
-- something either earlier plan articulated, because both were
-- counting grants rather than watching results.
--
-- Of the 22 that return rows, 12 are tables and 10 are views: the
-- seven _safe views, plus the three in step 3.
--
--
-- ONE INTENT SIGNAL POINTING THE OTHER WAY, NAMED RATHER THAN SWEPT
--
--     bjl_articles       RLS on, policy "Public read articles",     15 rows
--     bjl_case_studies   RLS on, policy "Public read case studies",  7 rows
--
-- Both policies are FOR SELECT TO public USING (true). Someone wrote
-- those deliberately to let anon read, and they are the only two
-- objects in the schema where that is true — everything else anon can
-- reach is reachable by default or by definer bypass, not by a policy
-- someone authored saying so.
--
-- They are still swept, on the evidence in PART TWO: no page issues a
-- PostgREST call, so the intention those policies express is not
-- exercised by any code that exists. But an authored policy is a
-- weaker thing to overrule than an inherited default, so it is written
-- here rather than absorbed into a count of 70. If the articles and
-- case studies surface is meant to be read from the browser later,
-- these two names go on the allowlist array in step 1 with this
-- paragraph as the reason, and the revoke is one line to undo.
--
--
-- SCOPE — schema public ONLY.
--
-- Deliberately untouched: storage, realtime, extensions, auth, graphql,
-- graphql_public. anon holds USAGE on all six by Supabase default, with
-- 11 readable objects across storage/extensions/realtime. Those are
-- platform-managed; revoking there breaks Supabase internals rather
-- than reducing our exposure. Named so their absence reads as a
-- decision and not an oversight.
--
--
-- CATALOG-DRIVEN, NOT A HAND-WRITTEN LIST. The revoke loops over
-- pg_class and pg_proc rather than naming 60 tables. A static list is
-- stale the moment it is written — two tables appeared inside a single
-- day during this remediation — and it under-covers SILENTLY, which is
-- the failure mode this whole file exists to remove. The exception set
-- is one readable array, and a replay re-covers anything added since.
--
-- RE-RUNNABLE. REVOKE on an already-revoked privilege is a no-op, ALTER
-- VIEW ... SET is idempotent, and ALTER DEFAULT PRIVILEGES is
-- last-writer-wins. Running this file twice leaves the same state and
-- raises no error.
--
-- VERIFY WITH bin/verify_anon_read_lockdown.sql, NOT WITH A GRANT
-- QUERY. The check probes as anon and observes what comes back. Reading
-- the catalog is what produced the false green that started this: the
-- grant table said anon was denied on bjl_front_door_log while anon
-- read 22 rows out of it through a definer view.


-- -------------------------------------------------------------------
-- STEP 1 — REVOKE SELECT on every table, view and matview in public.
-- -------------------------------------------------------------------
DO $$
DECLARE
  -- The allowlist. Empty by evidence, not by omission: see PART TWO.
  -- Anything added here needs a reason written next to it.
  allowlist text[] := ARRAY[]::text[];
  r record;
BEGIN
  FOR r IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r','p','v','m')
      AND NOT (c.relname = ANY (allowlist))
    ORDER BY c.relname
  LOOP
    EXECUTE format('REVOKE SELECT ON public.%I FROM anon, authenticated', r.relname);
  END LOOP;
END $$;


-- -------------------------------------------------------------------
-- STEP 2a — REVOKE EXECUTE on the four SECURITY DEFINER functions.
--
-- These are the only real bypass: they run as postgres and survive
-- step 1 entirely. A sweep covering tables and views but not EXECUTE
-- would report a locked read side with this vector wide open.
--
-- Extension-owned functions (320 of them: pgvector, pg_trgm and
-- friends) are NOT touched. They are SECURITY INVOKER, so they execute
-- as the caller and are not a privilege boundary; revoking them risks
-- breaking operators for no security gain.
--
--
-- ...FROM PUBLIC, AND WHY. THIS FILE WAS WRONG WITHOUT IT.
--
-- The first version of this step revoked FROM anon, authenticated only.
-- It ran, and the probe immediately after it reported one survivor:
--
--     bjl_public_segment_read(integer,text,text)
--     acl: {=X/postgres,postgres=X/postgres,service_role=X/postgres,
--           bjl_agent_readonly=X/postgres}
--
-- The leading "=" with no grantee is a grant to PUBLIC. anon and
-- authenticated inherit EXECUTE through it, and REVOKE naming only
-- those two roles does not touch it. Three siblings held explicit anon
-- grants and were revoked cleanly; this one did not, and would have
-- stayed executable by anon behind a step that reported success.
--
-- A SECURITY DEFINER function left executable by anon is precisely the
-- vector this whole file was written to close, so the sweep would have
-- under-covered on the one class it exists for. Nothing in the catalog
-- view of "who has EXECUTE" made that visible in advance —
-- has_function_privilege('anon', ...) answers true either way, whether
-- the grant is direct or inherited from PUBLIC. Only revoking and then
-- re-probing separated them.
--
-- VERIFIED SAFE BEFORE WIDENING, not after: every app-defined function
-- reachable this way carries an explicit service_role=X/postgres in its
-- ACL (68 of 68 checked), so removing the PUBLIC grant cannot strip
-- service_role. Confirmed after the fact too — 81 of 81 app-defined
-- functions remain executable by service_role.
-- -------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public' AND d.objid IS NULL AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
  END LOOP;
END $$;


-- -------------------------------------------------------------------
-- STEP 2b — REVOKE EXECUTE on the remaining app-defined functions.
--
-- Surface reduction, not a leak fix. These 67 are SECURITY INVOKER, so
-- after step 1 they execute as anon against tables anon can no longer
-- read and can return nothing. Sequenced separately from 2a so that if
-- anything darkens, the cause set is four objects rather than 71.
--
-- FROM PUBLIC here too, for the reason argued under step 2a.
-- -------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
    WHERE n.nspname = 'public' AND d.objid IS NULL AND NOT p.prosecdef
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
  END LOOP;
END $$;


-- -------------------------------------------------------------------
-- STEP 3 — security_invoker=true on three views that are a LIVE
--          bypass. Not a latent one. This is a correction.
--
--   bjl_anchor_unmapped        over bjl_anchor_map, bjl_anchor_sets
--   bjl_item_scope             over bjl_scores
--   bjl_item_scores_canonical  over bjl_scores
--
-- The scope document these steps came from called these three LATENT,
-- on the reasoning that anon holds SELECT on their base tables and so
-- the views bypass nothing until step 1 closes those tables. The probe
-- says otherwise, and the probe is right:
--
--   AS anon:  bjl_scores            ->  0 rows   (3,731 rows exist)
--             bjl_anchor_map        ->  0 rows   (152 rows exist)
--             bjl_anchor_sets       ->  0 rows   (126 rows exist)
--
--             bjl_item_scope             ->  rows
--             bjl_item_scores_canonical  ->  rows
--             bjl_anchor_unmapped        ->  rows
--
-- All three base tables have relrowsecurity = true and ZERO policies.
-- RLS with no policy is deny-all. So anon holds a SELECT grant that
-- returns nothing, and reads the same data through a definer view that
-- runs as postgres and never meets the policy check. That is
-- bjl_front_door_health exactly, three more times, live today.
--
-- HOW THE ERROR WAS MADE, because it is the same error twice. I read
-- has_table_privilege, saw the grant, and wrote "anon can read those
-- base tables." The grant is only the first of two gates. RLS is the
-- second and it was shut. Reading one gate and calling it access is
-- the identical mistake as reading the grant table and calling it
-- reachability — made by me, inside the file whose whole subject is
-- that mistake. Only SET ROLE anon and an actual SELECT caught it.
--
-- WHAT CHANGES BECAUSE OF IT. Step 1 is the fix, not step 3: revoking
-- SELECT closes these three now. Step 3 stops them coming back if
-- someone re-grants. Both still land, in that order, and the ordering
-- claim in the scope document — that step 3 is not load-bearing today
-- — was true only by accident of step 1 running first.
--
-- Correct for these three precisely because their job is NOT to
-- bypass — the exact opposite of the seven _safe views above, which is
-- why "flip all views" and "flip no views" are both wrong.
--
-- Nothing in the codebase references any of the three.
-- -------------------------------------------------------------------
ALTER VIEW public.bjl_anchor_unmapped       SET (security_invoker = true);
ALTER VIEW public.bjl_item_scope            SET (security_invoker = true);
ALTER VIEW public.bjl_item_scores_canonical SET (security_invoker = true);


-- -------------------------------------------------------------------
-- STEP 4 — born closed. The read-side mirror of the write-side default
-- already in place.
--
-- ON TABLES covers views and foreign tables as well as tables, so this
-- closes the view vector for new objects too.
--
-- TWO REAL LIMITS, which is why the probe in bin/ is not optional:
--   - Default privileges are per-creating-role. An object created by a
--     role other than the one running this file is not covered.
--   - They govern objects created AFTER this statement and do nothing
--     about an explicit GRANT written later.
-- -------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE SELECT ON TABLES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

-- And from PUBLIC. Postgres grants EXECUTE to PUBLIC on every new
-- function by default, so without this line a new definer function is
-- born executable by anon no matter what the two lines above say. That
-- is not a hypothetical: it is exactly how bjl_public_segment_read came
-- to survive step 2a. The default is the mechanism that created the
-- object this migration had to be corrected for.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;


-- ===================================================================
-- STANDING RULE — added 2026-08-10. READ THIS BEFORE YOU CHANGE A
-- FUNCTION SIGNATURE IN THIS SCHEMA.
--
--   Every CREATE FUNCTION in public is born executable by anon.
--   The line directly above does NOT prevent it. Only an explicit
--   REVOKE does. CREATE OR REPLACE is safe; DROP + CREATE is not.
--
-- Written because it has now bitten twice — the connectivity v3
-- promotion's security regression, and again on 2026-08-10 when the
-- obvious way to expose the cohort floor to the JS was to add a column
-- to bjl_joy_map_sweep_v2's returned TABLE. Postgres cannot change a
-- function's return type with CREATE OR REPLACE, so that fix requires
-- DROP + CREATE, which silently reopens the function to anon. The floor
-- shipped as a separate scalar function instead, specifically to avoid
-- this. See migrations/2026-08-10_name_and_single_source_cohort_floors.sql.
--
-- -------------------------------------------------------------------
-- THE MEASUREMENT, because the first draft of this rule asserted the
-- mechanism and the assertion was wrong in an important direction.
--
-- I doubted the rule before writing it, on the reasoning that step 4
-- above already revokes EXECUTE from PUBLIC by default, which ought to
-- make DROP + CREATE harmless. So I tested it rather than assert it.
-- Scratch function zz_acl_probe2(), created as postgres in public, no
-- REVOKE, nothing else:
--
--   current_user = postgres, owner = postgres
--   proacl       = {=X/postgres,postgres=X/postgres,service_role=X/postgres}
--   has_function_privilege('anon', ..., 'EXECUTE')          -> TRUE
--   has_function_privilege('authenticated', ..., 'EXECUTE') -> TRUE
--
-- The leading "=X/postgres" is the grant to PUBLIC. It is there on a
-- function created by the same role that owns the default-privileges
-- entry, in the same schema that entry names, after step 4 ran.
--
-- Step 4 DID run and IS recorded correctly:
--
--   pg_default_acl, defaclrole=postgres, nspname=public, objtype='f'
--     -> {postgres=X/postgres,service_role=X/postgres}     (no PUBLIC)
--
-- So the rule is worse than "DROP + CREATE loses the ACL". It is:
--
-- -------------------------------------------------------------------
-- WHY IT HAPPENS. Default-privilege entries MERGE OVER the hardwired
-- default; they do not replace it. The merge can add, not subtract.
-- The born ACL above proves it in one string:
--
--   service_role=X   can ONLY come from the pg_default_acl entry
--   =X (PUBLIC)      can ONLY come from the hardwired acldefault
--
-- Both present => union, not substitution. The entry's ADDITION
-- (service_role) landed. Its REMOVAL (PUBLIC) did nothing.
--
-- AND THIS IS WHY STEP 4 WORKS FOR TABLES BUT NOT FUNCTIONS. It is not
-- that one line is right and the other wrong — they meet different
-- hardwired defaults:
--
--   TABLES:    hardwired default grants nothing to PUBLIC. Nothing to
--              fight. anon's SELECT came from a Supabase GRANT-based
--              default, and REVOKE SELECT genuinely stripped the r:
--              pg_default_acl 'r' -> anon=xtm/postgres (no r). Born
--              closed is REAL for tables.
--   FUNCTIONS: hardwired default grants EXECUTE to PUBLIC. The revoke
--              is recorded and then overridden every single time. Born
--              closed is FALSE for functions.
--
-- The "born closed" claim in step 4's header is therefore half true and
-- should be read as covering tables and views only.
--
-- -------------------------------------------------------------------
-- WHAT IS ACTUALLY HOLDING THE LINE TODAY. Not the default. The
-- explicit per-function REVOKE sweep in step 2, and nothing else.
-- Measured 2026-08-10:
--
--   public functions where anon has EXECUTE:  316 / 399
--   of those, named bjl%:                       0
--
-- The 316 are extension and system functions that ship into public
-- (pgcrypto, uuid-ossp, and friends) and were never in Track B's
-- scope. The number that matters is the zero. The project surface is
-- shut because step 2 shut each function by name — every one of them
-- would be open again the moment it were recreated.
--
-- -------------------------------------------------------------------
-- THE RULE, operationally:
--
--   1. Prefer CREATE OR REPLACE. It preserves proacl, so the REVOKE
--      that step 2 already applied survives. This is the ONLY reason
--      replacing a function is safe — not because Postgres is careful,
--      but because it leaves the old ACL alone.
--   2. If the change forces DROP + CREATE — any return-type change,
--      including adding one column to a RETURNS TABLE — then the
--      REVOKE is mandatory and belongs in the same transaction:
--
--        DROP FUNCTION public.f(...);
--        CREATE FUNCTION public.f(...) ...;
--        REVOKE EXECUTE ON FUNCTION public.f(...) FROM PUBLIC, anon, authenticated;
--        GRANT  EXECUTE ON FUNCTION public.f(...) TO service_role;   -- if needed
--
--   3. Then CHECK it, in the same migration. Do not trust step 4 and
--      do not trust step 2 to have covered an object that did not
--      exist when step 2 ran:
--
--        SELECT has_function_privilege('anon','public.f(...)','EXECUTE');
--        -- must be false
--
--   4. If you can avoid the signature change, avoid it. A new scalar
--      function alongside the old one costs one more object and zero
--      ACL risk. That is the trade the cohort-floor work took.
--
-- bin/verify_anon_read_lockdown.sql is the backstop for all of the
-- above and is the reason this is survivable rather than silent.
-- ===================================================================
