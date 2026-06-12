/**
 * bjl-public-chat.js — Public Joy Lab Chat enqueue endpoint (v6.15).
 *
 * v6.14 ran retrieval + Sonnet synthesis inline in a sync function.
 * Netlify's 10s/26s sync ceiling produced 502/504 timeouts on slow
 * Sonnet calls. v6.15 splits the work:
 *
 *   bjl-public-chat.js              ← this file. Validates input,
 *                                     inserts a row in bjl_query_jobs
 *                                     with query_type='public_chat',
 *                                     auth_user_id=null (visitors
 *                                     aren't authenticated), dispatches
 *                                     bjl-public-chat-background, and
 *                                     returns {job_id} with HTTP 202.
 *
 *   bjl-public-chat-background.js   ← does the actual work. Netlify
 *                                     Background Function, 15-min
 *                                     timeout. Writes the result to
 *                                     the job row's `finding`.
 *
 *   bjl-public-chat-status.js       ← public read-only polling endpoint
 *                                     the frontend hits every 1.5s.
 *
 * Surface: cross-origin POST from the embeddable chat page (joylab
 * Netlify deploy) inside an iframe on peteramayer.com. NO visitor auth
 * (public-facing). Service role on the Supabase side.
 *
 * Body shape:
 *   {
 *     question: string,                    // required, ≤ 2000 chars
 *     conversation_synthesis?: string,     // optional, ≤ 2000 chars
 *   }
 *
 * Response (202):
 *   { job_id: "<uuid>" }
 *
 * Response (400 / 405): { error }
 *
 * The frontend then polls bjl-public-chat-status?job_id=<uuid> until the
 * job completes or errors. Polling is the visitor's responsibility; this
 * endpoint returns immediately.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;
const supabase        = createClient(SUPABASE_URL, SUPABASE_KEY);

const DEFAULT_ALLOWED_ORIGINS = [
  'https://peteramayer.com',
  'https://www.peteramayer.com',
  'http://localhost:8888',
];
const ALLOWED_ORIGINS = (process.env.PUBLIC_CHAT_ALLOWED_ORIGINS
  ? process.env.PUBLIC_CHAT_ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : DEFAULT_ALLOWED_ORIGINS);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

exports.handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid JSON' }) };
  }

  const question = (body.question || '').trim();
  if (!question) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'question required' }) };
  }
  if (question.length > 2000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'question too long' }) };
  }

  const conversationSynthesis = typeof body.conversation_synthesis === 'string'
                                  ? body.conversation_synthesis.slice(0, 2000)
                                  : '';

  // Insert the job row. auth_user_id=null (visitors aren't logged in).
  // `prompt` is NOT NULL on the table; use the question (truncated to a
  // safe length) as a human-readable summary.
  const { data: job, error: insertErr } = await supabase
    .from('bjl_query_jobs')
    .insert({
      status:        'pending',
      query_type:    'public_chat',
      prompt:        '[public_chat] ' + question.slice(0, 240),
      extra_context: {
        question,
        conversation_synthesis: conversationSynthesis,
      },
    })
    .select('job_id')
    .single();

  if (insertErr || !job) {
    console.error('[bjl-public-chat] insert error:', insertErr);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'could not queue job' }),
    };
  }

  // Fire-and-forget dispatch to the background worker. Match the
  // existing background-dispatch pattern from bjl-audience-map.js
  // (process.env.URL is set by Netlify; event.headers.host is the
  // local-dev fallback).
  const siteUrl = process.env.URL || `https://${event.headers.host}`;
  const bgUrl   = `${siteUrl}/.netlify/functions/bjl-public-chat-background`;
  let dispatchStatus = null;
  let dispatchPreview = null;
  try {
    const resp = await fetch(bgUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ job_id: job.job_id }),
    });
    dispatchStatus = resp.status;
    if (!resp.ok) {
      try { dispatchPreview = ((await resp.text()) || '').slice(0, 500); }
      catch (_) { dispatchPreview = null; }
    }
  } catch (err) {
    console.error('[bjl-public-chat] dispatch threw:', err);
    dispatchPreview = `dispatch err: ${err && err.message ? err.message : String(err)}`.slice(0, 500);
  }

  // Best-effort dispatch diagnostics; doesn't change the response.
  await supabase
    .from('bjl_query_jobs')
    .update({
      dispatch_status:           dispatchStatus,
      dispatch_response_preview: dispatchPreview,
    })
    .eq('job_id', job.job_id);

  return {
    statusCode: 202,
    headers,
    body: JSON.stringify({ job_id: job.job_id }),
  };
};
