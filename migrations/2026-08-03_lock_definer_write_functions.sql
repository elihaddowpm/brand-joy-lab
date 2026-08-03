-- Migration: fail-closed EXECUTE defaults, and the four write functions
-- that were reachable without them.
--
-- ALREADY APPLIED. This file is the repo's record of a change made
-- during the ACL audit that followed shipping the signals paste box, so
-- that the tree matches the database. Re-running it is a no-op.
--
-- WHAT THE AUDIT WAS LOOKING FOR.
--
-- bjl_signals_paste_apply shipped with an explicit revoke list, and the
-- list turned out to be one role short: Postgres default privileges had
-- already granted EXECUTE to bjl_agent_readonly, the investigator's
-- read-only SQL role. REVOKE ... FROM PUBLIC does not touch a grant made
-- directly to a role, so the read-only agent would have kept EXECUTE on
-- a SECURITY DEFINER function silently — a role that cannot write to
-- bjl_marketplace_signals, holding a way to call something that writes
-- on its behalf with the definer's rights.
--
-- Two things follow. The standing fix is at the bottom of this file.
-- The audit it prompted is immediately below, and it found worse.
--
-- THE FOUR FUNCTIONS.
--
-- execute_write_sql is the serious one. It is SECURITY DEFINER, it has
-- no internal guards, it executes arbitrary SQL through a CTE wrapper —
-- and data-modifying CTEs are writes — and it was executable by anon.
-- anon is the key embedded in the public frontend. Anyone who opened
-- the site and read its JavaScript held an unguarded arbitrary-write
-- path into every table in the database, running as the definer.
--
-- The other three are the same shape at smaller scale: all SECURITY
-- DEFINER, all writes, all carrying anon and authenticated grants that
-- nothing needed. Every caller of all four in this repo uses the
-- service-role key —
--
--   execute_write_sql          netlify/functions/bjl-refresh-public-scores-background.js
--   bjl_update_haiku_tags      bin/backfill_frameworks_rest.py
--   bjl_update_haiku_tags_v7   bin/retag_v7_overfirers.py
--   refresh_public_safe_flags  (no caller in this repo)
--
-- — and index.html calls none of them. So nothing broke when these were
-- locked. The hole was pure exposure, which is the good version of this
-- finding and not a reason to have left it open.

REVOKE ALL ON FUNCTION public.execute_write_sql(query_text text)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bjl_update_haiku_tags(rows jsonb)       FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bjl_update_haiku_tags_v7(rows jsonb)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_public_safe_flags()             FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.execute_write_sql(query_text text)      TO service_role;
GRANT EXECUTE ON FUNCTION public.bjl_update_haiku_tags(rows jsonb)       TO service_role;
GRANT EXECUTE ON FUNCTION public.bjl_update_haiku_tags_v7(rows jsonb)    TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_public_safe_flags()             TO service_role;

-- DELIBERATELY NOT TOUCHED, so that a later reader does not mistake the
-- omission for an oversight:
--
--   bjl_public_segment_read — PUBLIC execute is the design, not a leak.
--     It is the read path the public chat is built on.
--   execute_read_sql, agent_exec_sql — guarded read paths whose ACLs
--     are already minimal. These are the functions bjl_agent_readonly
--     is supposed to have, and the grant below does not remove them:
--     ALTER DEFAULT PRIVILEGES is not retroactive.
--   The public search functions — same reasoning as segment_read.

-- THE STANDING CHANGE.
--
-- Stubbed as a comment at the foot of 2026-08-03_signal_paste_apply.sql
-- on the argument that it should land as a decision rather than as a
-- side effect of shipping a paste box. This is that decision, so the
-- stub stays commented there and lives here instead.
--
-- The alternative was to add bjl_agent_readonly to the revoke list of
-- every future SECURITY DEFINER function. That is a thing someone has
-- to remember, whose failure is silent and whose blast radius is the
-- whole read-only guarantee. This inverts it: the agent gets EXECUTE
-- only where someone wrote a GRANT on purpose, so forgetting now breaks
-- a call loudly at the agent instead of quietly widening it.
--
-- FOR ROLE postgres is sufficient and not a hedge. pg_default_acl shows
-- the bjl_agent_readonly grant on postgres's defaults only; the
-- supabase_admin defaults for schema public never included the role,
-- and every migration here runs as postgres. Without FOR ROLE the
-- statement would silently apply to the current role alone, which is
-- the same thing today and would stop being so the first time anything
-- runs as anyone else.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM bjl_agent_readonly;

-- STILL OPEN, and the reason execute_write_sql was reachable by anon in
-- the first place: the postgres defaults for schema public continue to
-- grant EXECUTE on every new function to anon and authenticated. anon
-- is the frontend key. So each future SECURITY DEFINER function is
-- born reachable from the public internet, and stays that way unless
-- its migration carries an explicit revoke — which is exactly the
-- remember-every-time control this file just argued against.
--
-- Not flipped here because it is a wider blast radius than the audit
-- that surfaced it: revoking it would break any function the frontend
-- legitimately calls with the anon key that relies on the default
-- rather than an explicit grant, and that set has to be enumerated
-- first. Its own audit, its own migration, its own decision.
