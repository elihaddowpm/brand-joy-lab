-- Migration: dispatch diagnostics for bjl_query_jobs (watchdog support)
--
-- Adds two columns the sync fn writes when it dispatches the background fn:
--   dispatch_status: HTTP status code returned by the bg URL
--   dispatch_response_preview: first 500 chars of the response body
--
-- These let the watchdog (in bjl-query-status.js) and downstream debugging
-- see WHY a dispatch failed. Most common case: Netlify password-protection
-- gate returns 401 + an HTML password page. fetch() resolves successfully,
-- the sync fn would silently return 202 with a job_id, but the bg fn never
-- runs. Watchdog flips the job to error after 90s with a clear message.

ALTER TABLE bjl_query_jobs
  ADD COLUMN IF NOT EXISTS dispatch_status int,
  ADD COLUMN IF NOT EXISTS dispatch_response_preview text;

COMMENT ON COLUMN bjl_query_jobs.dispatch_status IS
  'HTTP status code returned when sync fn dispatched the bg fn. NULL if dispatch never happened or sync fn errored before recording.';

COMMENT ON COLUMN bjl_query_jobs.dispatch_response_preview IS
  'First 500 chars of the bg dispatch response body (for non-2xx responses, to diagnose why bg never ran).';
