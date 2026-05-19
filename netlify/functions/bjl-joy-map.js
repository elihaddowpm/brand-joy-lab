/**
 * bjl-joy-map.js — sync enqueue endpoint for the Joy Map tool.
 *
 * Accepts:
 *   {
 *     workflow: "audience_profile" | "dance_map",
 *     brand_text: string | null,        // free-text brand input
 *     brand_json: object | null,        // Waldo JSON paste-in
 *     audience_mode: "demographic" | "joy_pattern" | "combined",
 *     audience_filters: {
 *       age_band, gender, income_bracket, region,
 *       parental_status, marital_status
 *     },
 *     joy_pattern_rules: [{ item_id, kind, criterion }, ...]   // Phase 1.5
 *   }
 *
 * audience_mode defaults to "demographic" (back-compat with v0.3 callers).
 * When audience_mode is "joy_pattern", audience_filters is ignored.
 * When audience_mode is "combined", both apply (intersection).
 *
 * For workflow="audience_profile", brand_text/brand_json are ignored.
 * For workflow="dance_map", at least one of brand_text or brand_json is required.
 *
 * Inserts a row into bjl_query_jobs with query_type="joy_map_<workflow>"
 * and the structured request body in extra_context. Background function
 * picks up the job, runs the pipeline, writes the structured result to
 * the `finding` column as a JSON string.
 *
 * Returns {job_id} with HTTP 202. Frontend polls bjl-query-status.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const VALID_WORKFLOWS = ['audience_profile', 'dance_map'];
const VALID_AUDIENCE_MODES = ['demographic', 'joy_pattern', 'combined'];

function validate(body) {
  if (!body || typeof body !== 'object') return { error: 'Missing body' };
  if (!VALID_WORKFLOWS.includes(body.workflow)) {
    return { error: `workflow must be one of ${VALID_WORKFLOWS.join(', ')}` };
  }
  if (body.workflow === 'dance_map') {
    const hasText = typeof body.brand_text === 'string' && body.brand_text.trim().length > 0;
    const hasJson = body.brand_json && typeof body.brand_json === 'object';
    if (!hasText && !hasJson) {
      return { error: 'dance_map requires brand_text or brand_json' };
    }
  }
  // audience_mode is optional; defaults to "demographic" for back-compat.
  if (body.audience_mode && !VALID_AUDIENCE_MODES.includes(body.audience_mode)) {
    return { error: `audience_mode must be one of ${VALID_AUDIENCE_MODES.join(', ')}` };
  }
  // Validate joy_pattern_rules shape if provided
  if (body.joy_pattern_rules !== undefined) {
    if (!Array.isArray(body.joy_pattern_rules)) {
      return { error: 'joy_pattern_rules must be an array' };
    }
    for (const rule of body.joy_pattern_rules) {
      if (!rule || typeof rule !== 'object') return { error: 'joy_pattern_rule must be an object' };
      if (typeof rule.item_id !== 'number' && !/^\d+$/.test(String(rule.item_id))) {
        return { error: 'joy_pattern_rule.item_id must be an integer' };
      }
      if (typeof rule.kind !== 'string' || !rule.kind) {
        return { error: 'joy_pattern_rule.kind must be a non-empty string' };
      }
      if (typeof rule.criterion !== 'string' || !rule.criterion) {
        return { error: 'joy_pattern_rule.criterion must be a non-empty string' };
      }
    }
  }
  const mode = body.audience_mode || 'demographic';
  if ((mode === 'joy_pattern' || mode === 'combined')
      && (!Array.isArray(body.joy_pattern_rules) || body.joy_pattern_rules.length === 0)) {
    return { error: `audience_mode "${mode}" requires at least one joy_pattern_rule` };
  }
  if (body.logical_operator !== undefined) {
    const op = String(body.logical_operator).toUpperCase();
    if (op !== 'AND' && op !== 'OR') {
      return { error: 'logical_operator must be "AND" or "OR"' };
    }
  }
  return { ok: true };
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

  const v = validate(body);
  if (v.error) {
    return { statusCode: 400, body: JSON.stringify({ error: v.error }) };
  }

  // Auth using the same helper bjl-query uses. Helper takes the auth header
  // string directly, NOT (event, supabase). Returns { ok, user, status, error }.
  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message, email: auth.email })
    };
  }

  // Rate-limit check — only when auth is enforced (auth.user is null in bypass).
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
          message: `You've reached your hourly limit of ${auth.user.rate_limit_per_hour} queries. Try again in a bit, or contact Eli if you need a higher cap.`,
          retry_after_seconds: 3600
        })
      };
    }
  }

  // Insert job. We reuse bjl_query_jobs and use a distinct query_type prefix.
  const queryType = `joy_map_${body.workflow}`;
  const extraContext = {
    workflow:           body.workflow,
    brand_text:         body.brand_text || null,
    brand_json:         body.brand_json || null,
    audience_mode:      body.audience_mode || 'demographic',
    audience_filters:   body.audience_filters || {},
    joy_pattern_rules:  Array.isArray(body.joy_pattern_rules) ? body.joy_pattern_rules : [],
    logical_operator:   body.logical_operator
                          ? String(body.logical_operator).toUpperCase()
                          : 'AND',
  };

  // The `prompt` column is required (NOT NULL); set a human-readable summary.
  const prompt = body.workflow === 'audience_profile'
    ? '[joy_map.audience_profile] ' + JSON.stringify(extraContext.audience_filters)
    : '[joy_map.dance_map] ' + (body.brand_text || JSON.stringify(body.brand_json)).slice(0, 200);

  const insertRow = {
    status: 'pending',
    query_type: queryType,
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

  // Fire-and-forget the background worker. Match the bjl-query.js URL pattern
  // (process.env.URL || event.headers.host fallback for local dev).
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
      try {
        const txt = await resp.text();
        dispatchPreview = (txt || '').slice(0, 500);
      } catch (_) {
        dispatchPreview = null;
      }
    }
  } catch (err) {
    console.error('[bjl-joy-map] background dispatch threw:', err);
    dispatchPreview = `dispatch err: ${err && err.message ? err.message : String(err)}`.slice(0, 500);
  }

  // Best-effort write of dispatch diagnostics; failures here don't change the response.
  await supabase
    .from('bjl_query_jobs')
    .update({ dispatch_status: dispatchStatus, dispatch_response_preview: dispatchPreview })
    .eq('job_id', job.job_id);

  // Rate-limit log (only when authenticated)
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
