/**
 * bjl-refresh-public-scores-background.js — Background worker that runs
 * the bjl_public_scores snapshot refresh.
 *
 * Netlify Background Functions get a 15-minute timeout, so the ~45s
 * aggregation across ~991K bjl_responses rows runs comfortably.
 *
 * Behavior:
 *   1. Execute the INSERT ... ON CONFLICT ... refresh SQL via the
 *      execute_write_sql RPC (added in the v6.3 migration).
 *   2. The query's RETURNING clause yields the upserted item_ids.
 *   3. Write a single operator-visible row to bjl_query_jobs
 *      (query_type='public_scores_refresh') so the team can see
 *      when the refresh ran and how many rows were touched.
 *
 * No external response — Background Functions return 202 to the
 * caller before this code runs. Errors are logged + stored in the
 * operator log row for post-hoc inspection.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const REFRESH_SQL = `
INSERT INTO bjl_public_scores
  (item_id, question_id, category, question_label, item_name, joy_index, n, question_type, public_safe)
SELECT
  i.item_id,
  i.question_id,
  q.primary_topic,
  COALESCE(NULLIF(q.short_label, ''), LEFT(q.question_text, 90)),
  i.item_name,
  ROUND(AVG(r.joy_index)::numeric, 1),
  COUNT(*),
  q.question_type,
  (q.primary_topic <> 'civic_political')
FROM bjl_responses r
JOIN bjl_items i        ON i.item_id     = r.item_id
JOIN bjl_questions_v2 q ON q.question_id = i.question_id
WHERE r.joy_index IS NOT NULL
  AND r.joy_index BETWEEN -60 AND 100
GROUP BY
  i.item_id, i.question_id, q.primary_topic, q.short_label, q.question_text,
  i.item_name, q.question_type
HAVING COUNT(*) >= 30
ON CONFLICT (item_id) DO UPDATE SET
  joy_index      = EXCLUDED.joy_index,
  n              = EXCLUDED.n,
  question_label = EXCLUDED.question_label,
  category       = EXCLUDED.category,
  question_type  = EXCLUDED.question_type
-- public_safe intentionally NOT updated — preserves curation
RETURNING item_id
`;

async function logOperatorRow(scratch, errorMessage) {
  // Lightweight operator log: writes a row to bjl_query_jobs the team can
  // see in the Supabase dashboard. We avoid creating a dedicated table
  // for one operation per refresh.
  try {
    await supabase.from('bjl_query_jobs').insert({
      status: errorMessage ? 'error' : 'complete',
      query_type: 'public_scores_refresh',
      prompt: '[public_scores_refresh] ' + new Date().toISOString(),
      extra_context: { triggered_by: 'workbench refresh button' },
      scratch,
      error: errorMessage || null,
      completed_at: new Date().toISOString(),
    });
  } catch (logErr) {
    console.error('[refresh-public-scores] could not write operator log:', logErr);
  }
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { /* fallthrough */ }
  const startedAt = body.started_at || new Date().toISOString();
  const t0 = Date.now();

  try {
    const { data, error } = await supabase.rpc('execute_write_sql', { query_text: REFRESH_SQL });
    if (error) throw new Error(error.message);

    // execute_write_sql wraps the query in `WITH x AS (...) SELECT
    // to_jsonb(coalesce(jsonb_agg(...))) FROM x` so data is a jsonb
    // array of {item_id} objects.
    const rowsUpserted = Array.isArray(data) ? data.length : 0;
    const tookMs = Date.now() - t0;

    await logOperatorRow({
      one_line_summary: `Refreshed bjl_public_scores: ${rowsUpserted} rows in ${tookMs}ms`,
      rows_upserted: rowsUpserted,
      took_ms: tookMs,
      started_at: startedAt,
    }, null);

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    const tookMs = Date.now() - t0;
    console.error('[refresh-public-scores-background] error:', err);
    await logOperatorRow(
      { took_ms: tookMs, started_at: startedAt },
      String(err.message || err).slice(0, 1000),
    );
    return { statusCode: 500, body: String(err.message || err) };
  }
};
