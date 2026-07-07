/**
 * bjl-query.js — sync enqueue endpoint
 *
 * Accepts BOTH request shapes (V1 and V2):
 *   V1: { query_type, prompt, prior_conversation_context? }
 *   V2: { query, intentHint, strategistContext, waldoContext, debug, prior_conversation_context? }
 *
 * Maps V2 → V1: query → prompt, intentHint → query_type.
 * strategistContext / waldoContext / debug get persisted to extra_context
 * and passed through to the investigator background function.
 * prior_conversation_context is persisted to its own jsonb column so the
 * triage stage can recognize follow-ups against recent turns.
 *
 * Inserts a job row into bjl_query_jobs (status=pending) and fires the
 * background function. Returns {job_id} with HTTP 202.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const VALID_TYPES = ['brand_lookup', 'audience_dive', 'outreach_angle', 'data_pull', 'email_findings'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// v7: derive a 60-char title from the first user message in a session.
function deriveTitle(prompt) {
  const trimmed = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 57) + '\u2026';
}

// Compute the next seq for a session. Service-role bypasses RLS, so the
// caller is responsible for confirming ownership before this is called.
// Returns 1 when the session has no messages yet.
async function nextSeq(sessionId) {
  const { data, error } = await supabase
    .from('bjl_session_messages')
    .select('seq')
    .eq('session_id', sessionId)
    .order('seq', { ascending: false })
    .limit(1);
  if (error) {
    console.error('[bjl-query] nextSeq error:', error);
    return null;
  }
  if (!data || data.length === 0) return 1;
  return Number(data[0].seq || 0) + 1;
}

function normalizeRequest(body) {
  // Triage uses prior_conversation_context to recognize follow-ups. Accept
  // it from either request shape, as either prior_conversation_context (snake)
  // or priorConversationContext (camel) for client convenience.
  const priorContext = body.prior_conversation_context
    || body.priorConversationContext
    || null;

  // v7: optional session id (uuid). Validated again on the handler
  // before any write; we just normalize the shape here.
  const sessionId = (typeof body.session_id === 'string' && UUID_RE.test(body.session_id))
    ? body.session_id
    : null;

  // v9.17: Deep Dive toggle. Accepts either shape (v1 or v2). When true
  // the investigator runs the mandatory 16-topic coverage scan as its
  // first query. Off by default in Intelligence; hardcoded on by the
  // Audience Map path.
  const deepCoverageScan = body.deep_coverage_scan === true
    || body.deepCoverageScan === true;

  // V1 shape passthrough
  if (typeof body.prompt === 'string' && body.prompt) {
    return {
      prompt: body.prompt,
      query_type: VALID_TYPES.includes(body.query_type) ? body.query_type : 'data_pull',
      extra_context: null,
      prior_conversation_context: priorContext,
      session_id: sessionId,
      deep_coverage_scan: deepCoverageScan
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
    // email_mode: when true, the synthesize stage produces a single
    // counterintuitive sentence (no scores, no markdown) instead of the
    // standard interpretive response. Used by /api/bjl-content to route
    // bjl_finding requests through the corpus-wide investigator pipeline.
    if (body.email_mode === true) extra.email_mode = true;

    return {
      prompt: body.query,
      query_type: queryType,
      extra_context: Object.keys(extra).length ? extra : null,
      prior_conversation_context: priorContext,
      session_id: sessionId,
      deep_coverage_scan: deepCoverageScan
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

  // Auth + whitelist gate. In bypass mode (AUTH_ENFORCED !== 'true') this
  // returns { ok: true, user: null, bypass: true } and the rest of the
  // handler runs as it did before this PR — preserving the unauthenticated
  // experience until the Azure provider goes live in Supabase Auth.
  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message, email: auth.email })
    };
  }

  // Rate-limit check — only when auth is enforced. Counts the user's
  // bjl_rate_limit_log rows in the trailing hour and rejects with HTTP 429
  // if they're at or over their per-user cap.
  if (auth.user) {
    const oneHourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const { count, error: rlErr } = await supabase
      .from('bjl_rate_limit_log')
      .select('*', { count: 'exact', head: true })
      .eq('auth_user_email', auth.user.email)
      .gte('query_at', oneHourAgo);
    if (rlErr) {
      // Fail open on lookup error — better to let a query through than
      // lock everyone out because a count() failed. Logged for ops.
      console.error('[bjl-query] rate-limit lookup error (failing open):', rlErr);
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

  // ============================================================
  // v7 — Session persistence (writes happen only when authenticated).
  //
  // Three cases:
  //   (a) Caller supplied session_id AND owns it → use it.
  //   (b) Caller supplied session_id they don't own → 404.
  //       Foreign / inactive sessions are not silently rewritten.
  //   (c) Caller supplied nothing OR a malformed id → create a new
  //       session, derive title from the first prompt.
  //
  // After the session is resolved, write the USER message immediately.
  // The background worker writes the ASSISTANT message after the
  // synthesizer completes (see bjl-query-background.js).
  //
  // Bypass mode (auth.user === null) skips session writes entirely.
  // Sessions are RLS-scoped to email; without one there's nothing to
  // attach the row to.
  // ============================================================
  let activeSessionId = null;
  let createdSessionThisTurn = false;

  if (auth.user) {
    const email = String(auth.user.email).toLowerCase();

    if (norm.session_id) {
      // (a) or (b): verify ownership
      const { data: existing, error: existingErr } = await supabase
        .from('bjl_sessions')
        .select('id, user_email, is_active')
        .eq('id', norm.session_id)
        .single();
      if (existingErr || !existing) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'session not found' })
        };
      }
      if (existing.user_email !== email || existing.is_active === false) {
        // Don't disclose existence
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'session not found' })
        };
      }
      activeSessionId = existing.id;
    } else {
      // (c) Create new session
      const { data: newRow, error: newErr } = await supabase
        .from('bjl_sessions')
        .insert({
          user_email: email,
          title:      deriveTitle(norm.prompt),
          // started_at, last_active_at, is_active take their defaults
        })
        .select('id')
        .single();
      if (newErr || !newRow) {
        console.error('[bjl-query] session create error:', newErr);
        return {
          statusCode: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'session create failed', detail: newErr && newErr.message })
        };
      }
      activeSessionId = newRow.id;
      createdSessionThisTurn = true;
    }

    // Compute next seq + write the user message.
    const seq = await nextSeq(activeSessionId);
    if (seq != null) {
      const userMsgContext = {};
      if (norm.extra_context) {
        // Persist a small subset of useful context per turn (don't
        // duplicate the prompt itself; that's `content`).
        if (norm.extra_context.intent)            userMsgContext.intent            = norm.extra_context.intent;
        if (norm.extra_context.intentHint)        userMsgContext.intentHint        = norm.extra_context.intentHint;
        if (norm.extra_context.strategistContext) userMsgContext.strategistContext = norm.extra_context.strategistContext;
        if (norm.extra_context.waldoContext)      userMsgContext.waldoContext      = norm.extra_context.waldoContext;
      }
      if (norm.prior_conversation_context) {
        userMsgContext.prior_conversation_context = norm.prior_conversation_context;
      }
      const { error: msgErr } = await supabase
        .from('bjl_session_messages')
        .insert({
          session_id: activeSessionId,
          seq:        seq,
          role:       'user',
          content:    norm.prompt,
          context:    Object.keys(userMsgContext).length ? userMsgContext : null,
        });
      if (msgErr) {
        console.error('[bjl-query] user-message insert error:', msgErr);
      }
    }

    // Bump last_active_at so the recent-sessions list ordering is fresh
    // even before the assistant reply lands.
    await supabase
      .from('bjl_sessions')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', activeSessionId);
  }

  // Thread the session id through to the background worker via
  // extra_context._session_id (underscore prefix marks it as worker-
  // internal; not a strategist-facing field).
  const extraForJob = activeSessionId
    ? Object.assign({}, norm.extra_context || {}, { _session_id: activeSessionId })
    : norm.extra_context;

  const { data: jobRow, error: insertErr } = await supabase
    .from('bjl_query_jobs')
    .insert({
      status: 'pending',
      query_type: norm.query_type,
      prompt: norm.prompt,
      extra_context: extraForJob,
      prior_conversation_context: norm.prior_conversation_context,
      auth_user_id: auth.user ? auth.user.id : null,
      auth_user_email: auth.user ? auth.user.email : null,
      deep_coverage_scan: !!norm.deep_coverage_scan
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

  // Per-user rate-limit log row. One row per accepted query. Used by the
  // pre-insert count check at the top of the handler. Best-effort — a
  // failed insert here doesn't break the user's query, just under-counts
  // their usage in the next hour.
  if (auth.user) {
    const { error: logErr } = await supabase.from('bjl_rate_limit_log').insert({
      auth_user_email: auth.user.email,
      job_id: jobId
    });
    if (logErr) {
      console.warn('[bjl-query] rate_limit_log insert failed (non-fatal):', logErr);
    }
  }

  return {
    statusCode: 202,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      job_id: jobId,
      status: 'pending',
      // v7: surface the session id (esp. when we created one this turn)
      // so the client can stash it in the URL + localStorage.
      session_id: activeSessionId,
      session_created: createdSessionThisTurn
    })
  };
};
