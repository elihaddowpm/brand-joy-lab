/**
 * bjl-joy-map.js — SYNC enqueue endpoint for the Dance Map workflow
 * (Joy Map Phase 2).
 *
 * Body shape (Phase 2):
 *   {
 *     workflow: "dance_map",
 *     brand_text: string | null,
 *     brand_json: object | null,
 *     audience_map_job_id: string         // job_id of a completed Audience Map run
 *   }
 *
 * Phase 2 architectural shift: the Dance Map no longer takes audience
 * filters or joy-pattern rules directly. The strategist creates an
 * Audience Map first (via bjl-audience-map.js) and then references its
 * job_id when running the Dance Map. The Audience Map's reverse-engineered
 * cohort + parameter set + profile sections all serve as the audience
 * side of the dance.
 *
 * For workflow="dance_map", at least one of brand_text or brand_json
 * AND an audience_map_job_id are required. Audience Joy Profile (old
 * workflow 1) is retired — Audience Map subsumes it.
 *
 * Returns 202 + {job_id}. Frontend polls bjl-query-status.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const VALID_WORKFLOWS = ['dance_map'];

function validate(body) {
  if (!body || typeof body !== 'object') return { error: 'Missing body' };
  if (!VALID_WORKFLOWS.includes(body.workflow)) {
    return { error: `workflow must be one of ${VALID_WORKFLOWS.join(', ')}` };
  }
  const hasText = typeof body.brand_text === 'string' && body.brand_text.trim().length > 0;
  const hasJson = body.brand_json && typeof body.brand_json === 'object';
  if (!hasText && !hasJson) {
    return { error: 'dance_map requires brand_text or brand_json' };
  }
  if (!body.audience_map_job_id || typeof body.audience_map_job_id !== 'string') {
    return { error: 'audience_map_job_id is required (create an Audience Map first)' };
  }
  return { ok: true };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const v = validate(body);
  if (v.error) return { statusCode: 400, body: JSON.stringify({ error: v.error }) };

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message, email: auth.email })
    };
  }

  if (auth.user) {
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const { count, error: rlErr } = await supabase
      .from('bjl_rate_limit_log')
      .select('*', { count: 'exact', head: true })
      .eq('auth_user_email', auth.user.email)
      .gte('query_at', oneHourAgo);
    if (rlErr) {
      console.error('[bjl-joy-map] rate-limit lookup error (failing open):', rlErr);
    } else if (typeof count === 'number' && count >= auth.user.rate_limit_per_hour) {
      return {
        statusCode: 429,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'rate_limit_exceeded',
          message: `You've reached your hourly limit of ${auth.user.rate_limit_per_hour} queries.`,
          retry_after_seconds: 3600
        })
      };
    }
  }

  // Validate that the referenced Audience Map exists and is complete
  const { data: audMap, error: audErr } = await supabase
    .from('bjl_query_jobs')
    .select('job_id, status, query_type, finding')
    .eq('job_id', body.audience_map_job_id)
    .single();
  if (audErr || !audMap) {
    return { statusCode: 404, body: JSON.stringify({ error: 'audience_map_job_id not found' }) };
  }
  if (audMap.query_type !== 'audience_map') {
    return { statusCode: 400, body: JSON.stringify({ error: 'referenced job is not an audience_map' }) };
  }
  if (audMap.status !== 'complete') {
    return { statusCode: 400, body: JSON.stringify({ error: `referenced audience_map is not complete (status=${audMap.status})` }) };
  }

  const extraContext = {
    workflow:             body.workflow,
    brand_text:           body.brand_text || null,
    brand_json:           body.brand_json || null,
    audience_map_job_id:  body.audience_map_job_id,
  };

  const prompt = '[joy_map.dance_map] '
                 + (body.brand_text || JSON.stringify(body.brand_json)).slice(0, 200);

  const insertRow = {
    status: 'pending',
    query_type: `joy_map_${body.workflow}`,
    prompt,
    extra_context: extraContext,
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
    console.error('[bjl-joy-map] insert error:', jobErr);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to create job', detail: jobErr.message }) };
  }

  const siteUrl = process.env.URL || `https://${event.headers.host}`;
  const bgUrl = `${siteUrl}/.netlify/functions/bjl-joy-map-background`;
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
      try { dispatchPreview = ((await resp.text()) || '').slice(0, 500); }
      catch (_) { dispatchPreview = null; }
    }
  } catch (err) {
    console.error('[bjl-joy-map] background dispatch threw:', err);
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
