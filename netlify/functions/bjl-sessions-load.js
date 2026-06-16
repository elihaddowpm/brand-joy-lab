/**
 * bjl-sessions-load.js — Workbench session persistence (v7).
 *
 * GET /.netlify/functions/bjl-sessions-load?session_id=<uuid>
 *
 * Returns the full message list for a single session — used by the
 * Intelligence-pane mount path to reconcile localStorage against the
 * server (the brief's "localStorage repaints instantly and then
 * reconciles against the server as the source of truth").
 *
 * Auth: workbench-only. Service-role on the backend bypasses RLS, so
 * we enforce ownership in code: the session's `user_email` must equal
 * lower(auth.user.email). A foreign session returns 404 (not 403) so
 * we don't disclose existence.
 *
 * Response (200):
 *   {
 *     session: { id, title, summary, started_at, last_active_at },
 *     messages: [
 *       { seq, role, content, context, created_at },
 *       ...                                           // ordered by seq ASC
 *     ]
 *   }
 *
 * Response (404):
 *   { error: 'session not found' }
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!auth.user) {
    return {
      statusCode: 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'sign-in required to load a session' }),
    };
  }

  const params = event.queryStringParameters || {};
  const sessionId = (params.session_id || '').trim();
  if (!UUID_RE.test(sessionId)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'invalid session_id' }),
    };
  }

  const email = String(auth.user.email).toLowerCase();

  const { data: session, error: sErr } = await supabase
    .from('bjl_sessions')
    .select('id, user_email, title, summary, is_active, started_at, last_active_at')
    .eq('id', sessionId)
    .single();

  if (sErr || !session) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'session not found' }),
    };
  }
  // Ownership check (in code, since service-role bypasses RLS).
  // Foreign / inactive sessions return 404 — don't disclose existence.
  if (session.user_email !== email || session.is_active === false) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'session not found' }),
    };
  }

  const { data: messages, error: mErr } = await supabase
    .from('bjl_session_messages')
    .select('seq, role, content, context, created_at')
    .eq('session_id', sessionId)
    .order('seq', { ascending: true });

  if (mErr) {
    console.error('[bjl-sessions-load] message select error:', mErr);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'load failed', detail: mErr.message }),
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: {
        id:             session.id,
        title:          session.title,
        summary:        session.summary,
        started_at:     session.started_at,
        last_active_at: session.last_active_at,
      },
      messages: messages || [],
    }),
  };
};
