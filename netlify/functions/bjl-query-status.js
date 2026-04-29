/**
 * bjl-query-status.js — sync read endpoint
 *
 * GET /api/bjl-query-status?id=<uuid>
 * Returns the current bjl_query_jobs row as JSON.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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
    .select('job_id, status, query_type, finding, scratch, query_count, error, created_at, completed_at, dispatch_status, dispatch_response_preview')
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
        .select('job_id, status, query_type, finding, scratch, query_count, error, created_at, completed_at, dispatch_status, dispatch_response_preview')
        .single();

      if (!updateErr && updated) {
        data = updated;
      }
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  };
};
