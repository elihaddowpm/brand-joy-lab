-- Migration: Tier A — take the sensitive tables to service-role only.
--
-- PARTIALLY APPLIED, August 4 2026. Six of the eight below are live, and
-- RLS was enabled on those six at the same time (this file did not ask
-- for that; it is an improvement and is recorded here as fact).
--
--   APPLIED   bjl_authorized_users, bjl_approved_emails, bjl_respondents,
--             bjl_front_door_log, bjl_projects, bjl_project_cards
--             — anon/authenticated SELECT false, RLS on, service_role
--               SELECT true. Verified against live.
--
--   NOT YET   bjl_profile_targets, bjl_profile_weights
--             — still anon-readable, RLS off, verified against live on
--               August 5. 13,051 rows of strategist weighting between
--               them. The two REVOKEs below are the outstanding work;
--               running the whole file again is safe and completes it.
--
-- Re-runnable by construction: REVOKE on a grant that is already gone is
-- a no-op, so this file can be replayed against any state.
--
-- WHAT THIS IS.
--
-- 2026-08-04_revoke_anon_write_schemawide.sql closed the write half of
-- the frontend key's access to this schema and deliberately left SELECT
-- alone, because a wrong read revoke darkens the public tool while a
-- write revoke breaks nothing. This is the first slice of the read half:
-- the eight tables where the data is sensitive, the caller is known, and
-- the answer does not depend on the out-of-repo question.
--
-- WHY THESE EIGHT AND NOT A BLANKET REVOKE.
--
-- The frontend audit found that nothing in this repo reads any table as
-- anon or authenticated — index.html builds one anon client and calls
-- only sb.auth.* on it, public-chat.html does not touch Supabase, and
-- all 37 function clients are service_role but one, which calls
-- auth.getUser(). That argues for revoking SELECT schema-wide.
--
-- It is held back anyway, because a grep of this repo cannot see a
-- Retool board, a notebook, a BI connector or a cron script pointed at
-- PostgREST with the anon key, and those would break silently — the
-- failure mode this build keeps refusing to ship. That check belongs to
-- a human with the deploy surface in view.
--
-- These eight do not wait on it. Nothing legitimate reads an
-- access-control whitelist or respondent PII as anon under any
-- architecture, in this repo or outside it, so the out-of-repo unknown
-- does not change the ruling for them. If a blanket revoke follows, this
-- was simply its first slice.
--
-- ORDER. bjl_authorized_users goes first and that is not cosmetic. An
-- anon-readable list of who is authorized is reconnaissance against the
-- access-control layer itself: it names the six accounts worth
-- attacking. It should be closed before anything else even within the
-- same transaction.

BEGIN;

-- 1. The access-control layer. Read by bjl-auth-helper.js via the admin
--    client on every authenticated request; read by nothing else.
REVOKE ALL ON TABLE public.bjl_authorized_users  FROM anon, authenticated;
REVOKE ALL ON TABLE public.bjl_approved_emails   FROM anon, authenticated;

-- 2. Personal data. bjl_respondents is the demographic profile joined to
--    every response; bjl_front_door_log carries user emails and the
--    verbatim text of what they asked.
REVOKE ALL ON TABLE public.bjl_respondents       FROM anon, authenticated;
REVOKE ALL ON TABLE public.bjl_front_door_log    FROM anon, authenticated;

-- 3. Strategist work product — claims, evidence and weighting that are
--    internal by definition. Served by bjl-projects.js and
--    bjl-project-cards.js, both service_role, both behind the auth gate.
REVOKE ALL ON TABLE public.bjl_projects          FROM anon, authenticated;
REVOKE ALL ON TABLE public.bjl_project_cards     FROM anon, authenticated;
REVOKE ALL ON TABLE public.bjl_profile_targets   FROM anon, authenticated;
REVOKE ALL ON TABLE public.bjl_profile_weights   FROM anon, authenticated;

COMMIT;

-- REVOKE ALL rather than REVOKE SELECT: the write grants are already
-- gone schema-wide, so ALL is the same change today, and it states the
-- intent — these tables are service-role only — rather than describing
-- one privilege that happened to be left.
--
-- RLS was deliberately not enabled by this file, on the argument that it
-- is Tier B's job and a policy decision per table. The apply enabled it
-- on the six anyway, with no policy, which is the correct end state for
-- all six and is now live. The two outstanding tables should get the
-- same treatment when they land:
--
--   ALTER TABLE public.bjl_profile_targets ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.bjl_profile_weights ENABLE ROW LEVEL SECURITY;

-- VERIFY, after applying:
--
--   SELECT c.relname,
--          has_table_privilege('anon',          c.oid, 'SELECT') AS anon_select,
--          has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select,
--          has_table_privilege('service_role',  c.oid, 'SELECT') AS svc_select
--     FROM pg_class c
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public'
--      AND c.relname IN ('bjl_authorized_users','bjl_approved_emails',
--                        'bjl_respondents','bjl_front_door_log',
--                        'bjl_projects','bjl_project_cards',
--                        'bjl_profile_targets','bjl_profile_weights')
--    ORDER BY c.relname;
--
--   -- Expect eight rows, anon_select and auth_select all false,
--   -- svc_select all true. service_role losing SELECT here would break
--   -- the auth gate on the next request, so that column is the one to
--   -- read first.
--
-- Then smoke: sign in to the staff tool. If bjl_authorized_users went
-- too far, the whitelist lookup in bjl-auth-helper.js fails and every
-- authenticated request 500s — that is the one regression this file
-- could plausibly cause, and it announces itself immediately.
