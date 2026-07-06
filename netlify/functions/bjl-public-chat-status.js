/**
 * bjl-public-chat-status.js — Public read-only polling endpoint for the
 * Public Joy Lab Chat (v6.15).
 *
 * The chat frontend POSTs a question to bjl-public-chat, gets back a
 * job_id, then polls THIS endpoint every ~1.5s until the job is
 * complete or errored. When the job is complete, the response payload
 * is the same shape v6.14's bjl-public-chat returned inline — answer,
 * scope_taken, rows_used, provenance, updated_conversation_synthesis,
 * prompt_lead_capture, lead_capture_trigger_source,
 * closest_insight_slugs, category_guess.
 *
 * Surface: cross-origin GET from the embeddable chat page. NO auth
 * (public-facing). Security model: job_id is an unguessable UUID;
 * status is read-only and only reflects job rows whose
 * query_type='public_chat'.
 *
 * Query:
 *   GET /.netlify/functions/bjl-public-chat-status?job_id=<uuid>
 *
 * Response shapes:
 *   pending / running   →  { status, queued_at, ... }
 *   complete            →  { status: 'complete', ...finding payload }
 *   error               →  { status: 'error', error: <short message> }
 *   not_found           →  HTTP 404
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);

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
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Polling endpoint: no client cache. Status changes second-to-second.
    'Cache-Control':                'no-store',
    'Vary':                         'Origin',
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

exports.handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'GET only' }) };
  }

  const params = event.queryStringParameters || {};
  const jobId  = (params.job_id || '').trim();
  if (!UUID_RE.test(jobId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid job_id' }) };
  }

  const { data: job, error: loadErr } = await supabase
    .from('bjl_query_jobs')
    .select('status, finding, error, query_type, created_at, completed_at, progress_stage, progress_hint')
    .eq('job_id', jobId)
    .single();

  if (loadErr || !job) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'job not found' }) };
  }

  // Defense in depth: this endpoint must only reveal public_chat job
  // rows. Workbench job rows live in the same table but contain
  // strategist data; refuse cross-type reads even if a job_id collision
  // hypothetically occurred.
  if (job.query_type !== 'public_chat') {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'job not found' }) };
  }

  if (job.status === 'complete') {
    let finding = {};
    try {
      finding = typeof job.finding === 'string'
                  ? JSON.parse(job.finding)
                  : (job.finding || {});
    } catch (e) {
      console.error('[bjl-public-chat-status] could not parse finding:', e);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ status: 'error', error: 'malformed finding payload' }),
      };
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(Object.assign({ status: 'complete' }, finding)),
    };
  }

  if (job.status === 'error') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'error',
        error:  (job.error || 'unknown error').slice(0, 500),
      }),
    };
  }

  // pending / running — surface progress fields (v9.14) so the frontend
  // can render a stage-aware loading bubble.
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      status:         job.status,
      queued_at:      job.created_at,
      progress_stage: job.progress_stage || 'queued',
      progress_hint:  job.progress_hint || null,
    }),
  };
};
