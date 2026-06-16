/**
 * bjl-sessions-list.js — Workbench session persistence (v7).
 *
 * GET /.netlify/functions/bjl-sessions-list[?limit=15]
 *
 * Returns the signed-in user's recent active workbench Intelligence
 * sessions, ordered by last_active_at DESC. Powers the "Recent" pill
 * + dropdown next to the New conversation button.
 *
 * Auth: workbench-only via verifyAndAuthorize. Backend uses the
 * service-role key, so it bypasses RLS — we enforce per-user scope
 * in code by filtering on lower(auth.user.email).
 *
 * Response:
 *   { sessions: [
 *       { id, title, summary, started_at, last_active_at },
 *       ...
 *   ] }
 *
 * The endpoint omits `user_email` and `is_active` from the response —
 * the visitor doesn't need them. is_active=false rows are filtered out
 * server-side.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DEFAULT_LIMIT = 15;
const MAX_LIMIT     = 50;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'GET only' }) };
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message, email: auth.email }),
    };
  }
  // Bypass mode (no auth): can't return per-user sessions without an
  // identity to scope against. Return empty rather than leaking
  // everyone's sessions or erroring.
  if (!auth.user) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessions: [] }),
    };
  }

  const params = event.queryStringParameters || {};
  let limit = parseInt(params.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  const email = String(auth.user.email).toLowerCase();

  const { data, error } = await supabase
    .from('bjl_sessions')
    .select('id, title, summary, started_at, last_active_at')
    .eq('user_email', email)
    .eq('is_active', true)
    .order('last_active_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[bjl-sessions-list] select error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'session list failed', detail: error.message }),
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessions: data || [] }),
  };
};
