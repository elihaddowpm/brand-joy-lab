/**
 * bjl-query-status.js — sync read endpoint
 *
 * GET /api/bjl-query-status?id=<uuid>
 * Returns the current bjl_query_jobs row as JSON.
 *
 * Adds a synthetic `stage` field for UI progress display:
 *   queued        -> status='pending'
 *   triage        -> status='running' AND triage_brief is null
 *   investigation -> status='running' AND triage_brief is set
 *   synthesis     -> (collapsed into investigation; status flips to complete
 *                    before synthesis is observable from polling)
 *
 * Terminal states (no watchdog applies):
 *   complete             -> finding + scratch + followup_chips populated
 *   clarification_needed -> clarifying_question populated, no investigation ran
 *   error                -> error message populated
 *
 * Pending watchdog: any job stuck in 'pending' for > 90s gets flipped to
 * 'error' with a diagnostic message about why dispatch likely failed.
 * 'running' jobs are NOT swept — thorough investigations may legitimately
 * run for several minutes.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const STATUS_COLUMNS = 'job_id, status, query_type, finding, scratch, query_count, error, created_at, completed_at, dispatch_status, dispatch_response_preview, triage_brief, triage_completed_at, followup_chips, clarifying_question';

function deriveStage(row) {
  switch (row.status) {
    case 'pending': return 'queued';
    case 'running': return row.triage_brief ? 'investigation' : 'triage';
    case 'complete': return 'complete';
    case 'clarification_needed': return 'clarification_needed';
    case 'error': return 'error';
    default: return row.status;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const jobId = (event.queryStringParameters && event.queryStringParameters.id) || null;
  if (!jobId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing id' }) };
  }

  let { data, error } = await supabase
    .from('bjl_query_jobs')
    .select(STATUS_COLUMNS)
    .eq('job_id', jobId)
    .single();

  if (error || !data) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Job not found' }) };
  }

  // Watchdog: any job stuck in 'pending' for > 90s never had its background
  // function start. The bg fn flips status to 'running' as its first DB write,
  // so a 'pending' status this old means dispatch silently failed (most often
  // the Netlify password gate eating the function-to-function POST).
  // Lazy-sweep: flip to 'error' on read so the user sees a real message.
  if (data.status === 'pending') {
    const ageMs = Date.now() - new Date(data.created_at).getTime();
    if (ageMs > 90_000) {
      const dispatchHint = data.dispatch_status
        ? ` (dispatch returned HTTP ${data.dispatch_status})`
        : ' (no dispatch status recorded)';
      const sweepMsg = `Background function never started${dispatchHint}. Likely cause: Netlify site password protection blocking server-to-server function dispatch. Disable site password in Netlify dashboard if queries are returning this error.`;

      const { data: updated, error: updateErr } = await supabase
        .from('bjl_query_jobs')
        .update({
          status: 'error',
          error: sweepMsg,
          completed_at: new Date().toISOString()
        })
        .eq('job_id', jobId)
        .eq('status', 'pending') // race-safe: only update if still pending
        .select(STATUS_COLUMNS)
        .single();

      if (!updateErr && updated) {
        data = updated;
      }
    }
  }

  // Attach derived stage for the UI's progress indicator.
  const out = { ...data, stage: deriveStage(data) };

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(out)
  };
};
