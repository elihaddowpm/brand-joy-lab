-- Migration: close the frontend key's write path into the whole schema.
--
-- ALREADY APPLIED, via MCP, on August 4 2026, in response to a
-- third-party data audit. This file is the repo's record so the tree
-- matches the database. Every statement is a REVOKE or a default-privilege
-- change, so re-running it is a no-op.
--
-- WHAT THE AUDIT FOUND, AND WHY IT WAS BIGGER THAN THE AUDIT SAID.
--
-- The audit flagged twelve tables with RLS disabled. Checking it against
-- live turned up the wider shape underneath: a role-level census showed
-- anon AND authenticated holding INSERT, UPDATE and DELETE on roughly
-- seventy tables — effectively the entire public schema. Nobody granted
-- that. It was inherited from the same fail-open default privileges this
-- schema had for functions, one layer down, on tables.
--
-- anon is the key that ships in the site's client JavaScript. So this was
-- a public arbitrary-write-and-delete path into the research database,
-- including bjl_responses (2.2M raw response rows), bjl_respondents
-- (respondent PII), bjl_front_door_log (user emails and query text), the
-- bulletin register built the same day — and bjl_authorized_users and
-- bjl_approved_emails, the access-control whitelists themselves, which
-- means the exposure included the ability to write yourself in.
--
-- 2026-08-03_lock_definer_write_functions.sql flagged exactly this at its
-- foot as STILL OPEN, "its own audit, its own migration, its own
-- decision." This is that audit and that migration. The flag was right
-- and the delay was the wrong call: it was described there as "currently
-- theory," and it was not theory, it was live.
--
-- WHY WRITE CLOSED IMMEDIATELY AND READ DID NOT.
--
-- Write exposure is unbounded damage and closing it is safe, because
-- nothing legitimate writes as anon. Read exposure is bounded damage and
-- closing it is risky, because a wrong revoke darkens the public tool.
-- So the write half was closed unilaterally and the read half was left
-- for a deliberate, per-table pass. See the read audit at the foot of
-- this file, which has since been done.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public
  FROM anon, authenticated;

REVOKE UPDATE ON ALL SEQUENCES IN SCHEMA public
  FROM anon, authenticated;

-- The same change made fail-closed for tables and sequences created
-- later, so this does not become a thing someone has to remember. Same
-- argument as the function defaults in the August 3 file: a control that
-- depends on remembering is not a control.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE UPDATE ON SEQUENCES FROM anon, authenticated;

-- Verified after applying: tables_with_anon_write_remaining = 0.
--
-- SELECT was deliberately not touched here. Every read grant is intact,
-- service_role retains everything, and all legitimate writes run
-- server-side under service_role — so nothing the frontend reads or the
-- backend writes changed.
--
-- Residual, known and accepted: USAGE on sequences is still granted, and
-- USAGE alone permits nextval(). With INSERT revoked there is nothing to
-- consume a sequence value for, and setval() requires the UPDATE that was
-- just revoked, so the remaining reachable behaviour is burning sequence
-- numbers out of a bigint space. Noted so a later reader does not mistake
-- the omission for an oversight.

-- ---------------------------------------------------------------------
-- THE READ AUDIT the August 3 file asked for, done August 4.
--
-- The question that file left open was "how does the frontend actually
-- use table-level PostgREST," because PostgREST's convention is table
-- grants plus RLS doing the filtering, which would make revoking reads a
-- change to how the frontend reaches data rather than a pure tightening.
--
-- The answer is that this frontend does not use table-level PostgREST at
-- all. Grepped across the whole tree:
--
--   index.html            constructs exactly one anon client, at the
--                         AuthGate, and calls only sb.auth.* on it —
--                         signInWithOAuth, getSession, onAuthStateChange,
--                         signOut. Zero .from(), zero .rpc(), zero
--                         /rest/v1 URLs in ~8100 lines. The four
--                         references to sensitive tables in that file are
--                         all code comments.
--   public-chat.html      touches Supabase not at all. It calls three
--                         Netlify functions and nothing else.
--   netlify/functions     37 Supabase clients. Every one is service_role,
--                         either outright or as SERVICE_KEY || ANON_KEY.
--                         The single deliberate anon client is in
--                         bjl-auth-helper.js and calls auth.getUser(jwt)
--                         to verify a token — the Auth API, not
--                         PostgREST. The whitelist lookup immediately
--                         after it uses the admin client.
--
-- So the anon key is an authentication credential in this system, not a
-- data credential, and the authenticated role is the same: the browser
-- receives a user JWT and forwards it to Netlify functions as a bearer
-- token, which verify it server-side. Neither role's table grants are
-- load-bearing for anything in this repo.
--
-- That collapses the risk the August 3 file was hedging against. It does
-- not by itself authorise a blanket SELECT revoke, for one reason worth
-- writing down: this audit can only see this repo. Anything querying
-- PostgREST with the anon key from outside it — an embed on the
-- marketing site, a notebook, a BI tool — would not appear in any grep
-- run here, and would break silently on a revoke. That is the check to
-- run before the read half lands, and it is a question for a human with
-- the deploy surface in view, not for a grep.
--
-- Sequenced read-side work, in the order it should land:
--
--   Tier A, sensitive and nothing in-repo reads them as anon:
--     bjl_front_door_log      user emails + query text
--     bjl_respondents         respondent PII
--     bjl_authorized_users    the access whitelist
--     bjl_approved_emails     the approval list
--     bjl_project_cards, bjl_projects, bjl_profile_*   strategist claims
--
--   Tier B, the audit's twelve RLS-disabled tables. RLS on with no
--   policy denies all client access, which is the correct end state for
--   most of these but is a decision per access pattern, not a mechanical
--   flip. The pattern to copy for a genuinely public surface is the
--   bjl_public_* tables: RLS on, one SELECT policy, no write grants.
--
-- Also noted by the audit, lower severity, not addressed here: the RLS
-- policies on bjl_sessions and bjl_session_messages re-evaluate
-- current_setting() per row and should wrap it as (SELECT ...); and the
-- Auth server's 10-connection cap will bite on upsize.
