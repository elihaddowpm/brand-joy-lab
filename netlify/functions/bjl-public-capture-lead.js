/**
 * bjl-public-capture-lead.js — Public-facing lead-capture endpoint
 * (Public Joy Lab Chat v6.6).
 *
 * The chat surface now drives lead capture via an explicit form:
 *   1. Inline form on no-answer / decline-warmly paths
 *      (trigger_source = 'no_answer')
 *   2. Lightbox after 7–8 consecutive queries in a session
 *      (trigger_source = 'consecutive_queries')
 *   3. Inline form when the chat endpoint itself fails (502/504/timeout
 *      or network error), so the visitor isn't left with just the
 *      "Something hiccuped" bubble and no path forward.
 *      (trigger_source = 'error', added v6.13)
 * All surfaces carry a "No thanks, I'll keep searching." control.
 *
 * Submit and decline BOTH write a row to bjl_public_questions so the
 * team can see what triggered each surface and what the visitor was
 * working on (conversation_synthesis), regardless of whether they
 * left personal info.
 *
 * Body shape (POST):
 *   {
 *     status:                  'submitted' | 'declined',
 *     trigger_source:          'no_answer' | 'consecutive_queries' | 'error',
 *     question:                <string>  (latest question that triggered the surface)
 *     conversation_synthesis:  <string>  (latest running synthesis; may be empty)
 *     query_count:             <integer> (queries asked so far in this session)
 *     matched_insight_slugs?:  <string[]>
 *     category_guess?:         <string>
 *     // Personal fields — required on 'submitted', ignored on 'declined':
 *     first_name?:             <string>
 *     last_name?:              <string>
 *     email?:                  <string>
 *     company_name?:           <string>
 *   }
 *
 * Response: { ok: true, id, suppress_next_lightbox_for_queries }
 *   suppress_next_lightbox_for_queries is 8 on decline, null on submit.
 *
 * NO auth (public-facing). CORS allows peteramayer.com.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

const VALID_STATUS  = new Set(['submitted', 'declined']);
const VALID_TRIGGER = new Set(['no_answer', 'consecutive_queries', 'error']);
const SUPPRESS_AFTER_DECLINE_FOR_QUERIES = 8;

function clean(s, max) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  return t.slice(0, max);
}

function isEmail(s) {
  if (typeof s !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
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
  catch (_) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid JSON' }) };
  }

  const status         = body.status;
  const triggerSource  = body.trigger_source;
  const question       = clean(body.question, 2000);
  const synthesis      = clean(body.conversation_synthesis, 2000);
  const queryCount     = Number(body.query_count);

  if (!VALID_STATUS.has(status)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'status must be "submitted" or "declined"' }) };
  }
  if (!VALID_TRIGGER.has(triggerSource)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'trigger_source must be "no_answer", "consecutive_queries", or "error"' }) };
  }
  if (!question) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'question required' }) };
  }
  if (!Number.isFinite(queryCount) || queryCount < 1) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'query_count must be a positive integer' }) };
  }

  // v8.4: visitor_id ties this capture to a bjl_public_sessions row. We
  // look it up to stamp session_id on the question and (for submits) flip
  // session.converted=true so analytics can count lead-conversion rates.
  const visitorId = typeof body.visitor_id === 'string' && body.visitor_id.trim().length > 0
                      ? body.visitor_id.trim().slice(0, 64)
                      : null;
  let sessionId = null;
  if (visitorId) {
    const { data: sess } = await supabase
      .from('bjl_public_sessions')
      .select('id')
      .eq('visitor_id', visitorId)
      .maybeSingle();
    if (sess) sessionId = sess.id;
  }

  const row = {
    question,
    conversation_synthesis: synthesis,
    trigger_source: triggerSource,
    query_count: Math.floor(queryCount),
    status,
    matched_insight_slugs: Array.isArray(body.matched_insight_slugs)
      ? body.matched_insight_slugs.filter(s => typeof s === 'string').slice(0, 6)
      : [],
    category_guess: clean(body.category_guess, 120),
    session_id: sessionId,                                          // v8.4
  };

  if (status === 'submitted') {
    const firstName   = clean(body.first_name,   120);
    const lastName    = clean(body.last_name,    120);
    const email       = clean(body.email,        200);
    const companyName = clean(body.company_name, 200);

    if (!firstName || !lastName) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'first_name and last_name required on submitted' }) };
    }
    if (!email || !isEmail(email)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'valid email required on submitted' }) };
    }

    row.first_name   = firstName;
    row.last_name    = lastName;
    row.email        = email;
    row.company_name = companyName;
  }
  // On 'declined', personal fields are intentionally not stored.

  const { data, error } = await supabase
    .from('bjl_public_questions')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    console.error('[bjl-public-capture-lead] insert error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'capture failed', detail: error.message }) };
  }

  // v8.4: flip session.converted=true on submitted leads so analytics
  // can compute "% of sessions that converted." Declines don't set this.
  if (status === 'submitted' && sessionId) {
    const { error: convErr } = await supabase
      .from('bjl_public_sessions')
      .update({ converted: true })
      .eq('id', sessionId);
    if (convErr) {
      // Non-fatal — the lead row landed; the conversion flag is a nice-to-have.
      console.error('[bjl-public-capture-lead] session converted flip failed:', convErr.message);
    }
  }

  // v7.7.1 — Dispatch to the Monday.com push (background function,
  // 15-min budget; idempotent on bjl_public_questions.monday_item_id).
  // Only 'submitted' rows go to Monday. Declines stay anonymous in Supabase.
  //
  // We AWAIT the dispatch call (was fire-and-forget in v7.4). On Netlify,
  // a non-awaited fetch can be killed by lambda termination before the
  // request is actually flushed to the routing layer — observed twice in
  // production where rows landed in Supabase but never reached the push
  // function. Awaiting blocks the visitor's response only until Netlify
  // returns 202 from the background dispatch (~50ms typically; the
  // background work itself does NOT block). The push function still owns
  // the actual Monday API call and writes monday_item_id back on success.
  //
  // The push function is graceful on its own failures (logs + returns 200),
  // so awaiting here adds reliability without introducing a new failure
  // path for the visitor.
  if (status === 'submitted' && data && data.id) {
    const host       = (event.headers && (event.headers.host || event.headers.Host)) || '';
    const siteUrl    = process.env.URL || (host ? `https://${host}` : '');
    const bgUrl      = siteUrl ? `${siteUrl}/.netlify/functions/bjl-monday-push-background` : null;
    if (bgUrl) {
      try {
        await fetch(bgUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ question_row_id: data.id }),
        });
      } catch (err) {
        // Dispatch threw, but the row is already in Supabase. Log and
        // ship the visitor's success response anyway — orphan rows can
        // be retried manually via the same endpoint.
        console.error('[bjl-public-capture-lead] Monday dispatch threw (non-fatal):', err && err.message);
      }
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      id: data && data.id,
      suppress_next_lightbox_for_queries: status === 'declined'
        ? SUPPRESS_AFTER_DECLINE_FOR_QUERIES
        : null,
    }),
  };
};
