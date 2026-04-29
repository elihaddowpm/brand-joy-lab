/**
 * bjl-query.js — sync enqueue endpoint
 *
 * Accepts BOTH request shapes (V1 and V2):
 *   V1: { query_type, prompt }
 *   V2: { query, intentHint, strategistContext, waldoContext, debug }
 *
 * Maps V2 → V1: query → prompt, intentHint → query_type.
 * strategistContext / waldoContext / debug get persisted to extra_context
 * and passed through to the investigator background function.
 *
 * Inserts a job row into bjl_query_jobs (status=pending) and fires the
 * background function. Returns {job_id} with HTTP 202.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const VALID_TYPES = ['brand_lookup', 'audience_dive', 'outreach_angle', 'data_pull', 'email_findings'];

function normalizeRequest(body) {
  // V1 shape passthrough
  if (typeof body.prompt === 'string' && body.prompt) {
    return {
      prompt: body.prompt,
      query_type: VALID_TYPES.includes(body.query_type) ? body.query_type : 'data_pull',
      extra_context: null
    };
  }
  // V2 shape translation. The Intelligence-mode client sends `intent`, the
  // email-mode client sends `intentHint`. Both map to query_type.
  if (typeof body.query === 'string' && body.query) {
    const intentRaw = body.intentHint || body.intent_hint || body.intent;
    const queryType = VALID_TYPES.includes(intentRaw) ? intentRaw : 'data_pull';

    const extra = {};
    if (body.strategistContext) extra.strategistContext = body.strategistContext;
    if (body.waldoContext) extra.waldoContext = body.waldoContext;
    if (body.debug) extra.debug = !!body.debug;
    if (body.intentHint) extra.intentHint = body.intentHint;
    if (body.intent) extra.intent = body.intent;
    if (body.mode) extra.mode = body.mode;

    return {
      prompt: body.query,
      query_type: queryType,
      extra_context: Object.keys(extra).length ? extra : null
    };
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const norm = normalizeRequest(body);
  if (!norm) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing prompt or query' }) };
  }

  const { data: jobRow, error: insertErr } = await supabase
    .from('bjl_query_jobs')
    .insert({
      status: 'pending',
      query_type: norm.query_type,
      prompt: norm.prompt,
      extra_context: norm.extra_context
    })
    .select('job_id')
    .single();

  if (insertErr) {
    console.error('[bjl-query] insert error:', insertErr);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to enqueue job: ' + insertErr.message }) };
  }

  const jobId = jobRow.job_id;
  const siteUrl = process.env.URL || `https://${event.headers.host}`;
  const bgUrl = `${siteUrl}/.netlify/functions/bjl-query-background`;

  // Dispatch the background function. Capture the response status — Netlify's
  // password-protection gate (and other auth/proxy issues) returns 401 with an
  // HTML body, which fetch() resolves successfully. Without checking the
  // status, a non-2xx response would let the sync fn return 202 and the job
  // would silently stick in 'pending' forever.
  let dispatchStatus = null;
  let dispatchPreview = null;
  let dispatchThrew = null;

  try {
    const bgRes = await fetch(bgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId })
    });
    dispatchStatus = bgRes.status;
    if (dispatchStatus < 200 || dispatchStatus >= 300) {
      try {
        const bodyText = await bgRes.text();
        dispatchPreview = bodyText ? bodyText.slice(0, 500) : null;
      } catch (_) {
        dispatchPreview = null;
      }
    }
  } catch (e) {
    console.error('[bjl-query] background dispatch threw:', e);
    dispatchThrew = e && e.message ? e.message : String(e);
  }

  // Failure path: dispatch threw OR returned non-2xx. Mark the job error
  // immediately so the next status poll surfaces a real message. Surface the
  // most actionable diagnostic we have.
  if (dispatchThrew || (dispatchStatus !== null && (dispatchStatus < 200 || dispatchStatus >= 300))) {
    let errMsg;
    if (dispatchThrew) {
      errMsg = 'Background dispatch threw: ' + dispatchThrew;
    } else if (dispatchStatus === 401 && dispatchPreview && dispatchPreview.includes('Password Protection')) {
      errMsg = 'Background function blocked by Netlify site password protection (HTTP 401). Disable site password in Netlify dashboard for the function-to-function dispatch to work.';
    } else if (dispatchStatus === 401 || dispatchStatus === 403) {
      errMsg = `Background function rejected with HTTP ${dispatchStatus} (auth gate). Check Netlify access controls.`;
    } else {
      errMsg = `Background function dispatch returned HTTP ${dispatchStatus} (expected 2xx).`;
    }

    await supabase
      .from('bjl_query_jobs')
      .update({
        status: 'error',
        error: errMsg,
        dispatch_status: dispatchStatus,
        dispatch_response_preview: dispatchPreview,
        completed_at: new Date().toISOString()
      })
      .eq('job_id', jobId);

    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: errMsg, job_id: jobId, dispatch_status: dispatchStatus })
    };
  }

  // Success path. Record dispatch status for future debugging.
  await supabase
    .from('bjl_query_jobs')
    .update({ dispatch_status: dispatchStatus })
    .eq('job_id', jobId);

  return {
    statusCode: 202,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, status: 'pending' })
  };
};
