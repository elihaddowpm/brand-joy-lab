/**
 * bjl-audience-map.js — SYNC enqueue endpoint for the Audience Map workflow
 * (Joy Map Phase 2).
 *
 * POST body: { description: <string> }
 *
 * Inserts a bjl_query_jobs row (query_type='audience_map'), dispatches the
 * background worker, returns 202 + {job_id}. Frontend polls via the
 * existing job-status endpoint and renders the result from
 * bjl_query_jobs.finding.
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

  // Rate-limit check
  if (auth.user) {
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const { count, error: rlErr } = await supabase
      .from('bjl_rate_limit_log')
      .select('*', { count: 'exact', head: true })
      .eq('auth_user_email', auth.user.email)
      .gte('query_at', oneHourAgo);
    if (rlErr) {
      console.error('[bjl-audience-map] rate-limit lookup error (failing open):', rlErr);
    } else if (typeof count === 'number' && count >= auth.user.rate_limit_per_hour) {
      return {
        statusCode: 429,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'rate_limit_exceeded',
          message: `You've reached your hourly limit of ${auth.user.rate_limit_per_hour} queries. Try again in a bit.`,
          retry_after_seconds: 3600
        })
      };
    }
  }

  const insertRow = {
    status: 'pending',
    query_type: 'audience_map',
    prompt: '[audience_map] ' + description.slice(0, 200),
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
    console.error('[bjl-audience-map] insert error:', jobErr);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create job', detail: jobErr.message }) };
  }

  // Fire-and-forget dispatch to the background worker
  const siteUrl = process.env.URL || `https://${event.headers.host}`;
  const bgUrl = `${siteUrl}/.netlify/functions/bjl-audience-map-background`;
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
      try { dispatchPreview = (await resp.text() || '').slice(0, 500); }
      catch (_) { dispatchPreview = null; }
    }
  } catch (err) {
    console.error('[bjl-audience-map] dispatch threw:', err);
    dispatchPreview = `dispatch err: ${err && err.message ? err.message : String(err)}`.slice(0, 500);
  }

  await supabase
    .from('bjl_query_jobs')
    .update({ dispatch_status: dispatchStatus, dispatch_response_preview: dispatchPreview })
    .eq('job_id', job.job_id);

  if (auth.user) {
    await supabase
      .from('bjl_rate_limit_log')
      .insert({ auth_user_email: auth.user.email, job_id: job.job_id });
  }

  return {
    statusCode: 202,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: job.job_id }),
  };
};
