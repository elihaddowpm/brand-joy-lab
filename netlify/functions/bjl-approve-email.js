/**
 * bjl-approve-email.js — write path for the approved-email corpus
 *
 * Called from the frontend when a strategist edits a generated draft and
 * clicks Save & approve. Only edited emails are written (user_edited true) —
 * these are the high-signal teaching examples (model draft vs. what the
 * strategist actually wanted). Untouched approvals are skipped client-side.
 *
 * POST body:
 *   {
 *     contact_name, company, brief, category,
 *     pain_keywords:     string[],
 *     waldo_signal_type, audience_mode,
 *     subject, body,
 *     final_text,        // the approved/edited email (required)
 *     original_generated // the raw pipeline output, for diff/learning
 *   }
 *
 * Response:
 *   { ok: true, id }
 *   { error, message } on failure
 *
 * Service-role client: bjl_approved_emails has RLS enabled with no policies,
 * so only the service_role key can write. The embedding column is left null;
 * a later phase backfills it for semantic retrieval.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

const str = (v) => (typeof v === 'string' ? v : '');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message, email: auth.email }),
    };
  }

  if (!supabase) {
    return { statusCode: 500, body: JSON.stringify({ error: 'server_misconfigured', message: 'SUPABASE_URL and SUPABASE_SERVICE_KEY must be set' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const finalText = str(body.final_text).trim();
  if (!finalText) {
    return { statusCode: 400, body: JSON.stringify({ error: 'final_text required' }) };
  }

  const row = {
    approved_at:        new Date().toISOString(),
    approved_by:        (auth.user && auth.user.email) || null,
    contact_name:       str(body.contact_name) || null,
    company:            str(body.company) || null,
    brief:              str(body.brief) || null,
    category:           str(body.category) || null,
    pain_keywords:      Array.isArray(body.pain_keywords) ? body.pain_keywords.map(String) : [],
    waldo_signal_type:  str(body.waldo_signal_type) || null,
    audience_mode:      str(body.audience_mode) || null,
    subject:            str(body.subject) || null,
    body:               str(body.body) || null,
    final_text:         finalText,
    original_generated: str(body.original_generated) || null,
    user_edited:        true,
  };

  try {
    const { data, error } = await supabase
      .from('bjl_approved_emails')
      .insert(row)
      .select('id')
      .single();
    if (error) {
      console.error('[bjl-approve-email] insert error:', error);
      return { statusCode: 500, body: JSON.stringify({ error: 'insert_failed', detail: error.message }) };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, id: data.id }),
    };
  } catch (e) {
    console.error('[bjl-approve-email] unexpected error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'unexpected_error', detail: e.message }) };
  }
};
