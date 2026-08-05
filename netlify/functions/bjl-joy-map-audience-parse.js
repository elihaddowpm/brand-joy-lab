/**
 * bjl-joy-map-audience-parse.js — SYNC enqueue endpoint for the free-text
 * audience parser (Joy Map Phase 1.5).
 *
 * The actual LLM call lives in bjl-joy-map-audience-parse-background.js.
 * This file just enqueues the job and dispatches the background worker,
 * mirroring the bjl-joy-map.js / bjl-joy-map-background.js pattern. The
 * sync function previously held the full LLM call inline but the round
 * trip (load 2K-item catalog + Haiku 4.5 with ~240KB input) routinely
 * exceeded Netlify's sync function gateway timeout, returning 504.
 *
 * POST /.netlify/functions/bjl-joy-map-audience-parse
 * body: { description: <string> }
 *
 * Returns: { job_id } with HTTP 202. Frontend polls via the standard
 * bjl-query-status endpoint and parses bjl_query_jobs.finding as JSON.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
// Service key only — no anon fallback. A missing key must fail loudly at
// createClient, not silently degrade this function to the frontend's role.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message, email: auth.email })
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON' }) };
  }
  const description = (body.description || '').trim();
  if (!description) {
    return { statusCode: 400, body: JSON.stringify({ error: 'description required' }) };
  }
  if (description.length > 4000) {
    return { statusCode: 400, body: JSON.stringify({ error: 'description too long (max 4000 chars)' }) };
  }

  // Insert job. We reuse bjl_query_jobs with a distinct query_type so the
  // frontend can branch on it if/when we add server-side observability.
  const insertRow = {
    status: 'pending',
    query_type: 'joy_map_audience_parse',
    prompt: '[joy_map.audience_parse] ' + description.slice(0, 200),
    extra_context: { description },
  };
  if (auth.user) {
    insertRow.auth_user_id = auth.user.id;
    insertRow.auth_user_email = auth.user.email;
  }

  const { data: job, error: jobErr } = await supabase
    .from('bjl_query_jobs')
    .insert(insertRow)
    .select('job_id')
    .single();

  if (jobErr) {
    console.error('[bjl-joy-map-audience-parse] insert error:', jobErr);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create job', detail: jobErr.message }) };
  }

  // Fire-and-forget the background worker. Same dispatch shape as bjl-joy-map.js.
  const siteUrl = process.env.URL || `https://${event.headers.host}`;
  const bgUrl = `${siteUrl}/.netlify/functions/bjl-joy-map-audience-parse-background`;
  let dispatchStatus = null;
  let dispatchPreview = null;
  try {
    const resp = await fetch(bgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: job.job_id }),
    });
    dispatchStatus = resp.status;
    if (!resp.ok) {
      try {
        const txt = await resp.text();
        dispatchPreview = (txt || '').slice(0, 500);
      } catch (_) {
        dispatchPreview = null;
      }
    }
  } catch (err) {
    console.error('[bjl-joy-map-audience-parse] background dispatch threw:', err);
    dispatchPreview = `dispatch err: ${err && err.message ? err.message : String(err)}`.slice(0, 500);
  }

  await supabase
    .from('bjl_query_jobs')
    .update({ dispatch_status: dispatchStatus, dispatch_response_preview: dispatchPreview })
    .eq('job_id', job.job_id);

  return {
    statusCode: 202,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: job.job_id }),
  };
};
