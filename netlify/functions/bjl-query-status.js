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

  const { data, error } = await supabase
    .from('bjl_query_jobs')
    .select('job_id, status, query_type, finding, scratch, query_count, error, created_at, completed_at')
    .eq('job_id', jobId)
    .single();

  if (error || !data) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Job not found' }) };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  };
};
