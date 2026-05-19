/**
 * bjl-joy-map-items.js — searchable item picker for the Joy Map's
 * joy-pattern audience definition mode (Phase 1.5).
 *
 * GET /.netlify/functions/bjl-joy-map-items?q=<query>&limit=<n>
 *
 * Returns: { items: [{item_id, item_name, question_text, question_type,
 *                     scale_type, scale_kind, short_label}, ...],
 *            criterion_options: { <scale_kind>: [{value,label},...], ... } }
 *
 * Items are restricted to question types we can build criterion clauses
 * for (see PICKER_QUESTION_TYPES in bjl-joy-pattern-helper). Free-text
 * question types (open_end, single_select, etc.) are excluded.
 *
 * Limit is capped at 50 server-side regardless of what the client asks for.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');
const {
  PICKER_QUESTION_TYPES,
  CRITERION_OPTIONS,
  classifyScaleKind,
} = require('./bjl-joy-pattern-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_LIMIT = 50;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message, email: auth.email })
    };
  }

  const params = event.queryStringParameters || {};
  const q = (params.q || '').trim();
  const requestedLimit = Number(params.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_LIMIT)
    : 25;

  // Build the ILIKE pattern. Treat the query as a substring match against
  // item_name OR question_text OR short_label. Empty query returns the
  // first <limit> items alphabetically (useful for first-open browsing).
  const typesList = PICKER_QUESTION_TYPES.map(t => `'${t.replace(/'/g, "''")}'`).join(',');

  let whereClauses = [`q.question_type IN (${typesList})`];
  if (q) {
    const safe = q.replace(/'/g, "''");
    whereClauses.push(`(i.item_name ILIKE '%${safe}%' OR q.question_text ILIKE '%${safe}%' OR q.short_label ILIKE '%${safe}%')`);
  }

  const sql = `
    SELECT i.item_id, i.item_name,
           q.question_text, q.question_type, q.scale_type, q.short_label
    FROM bjl_items i
    JOIN bjl_questions_v2 q ON q.question_id = i.question_id
    WHERE ${whereClauses.join(' AND ')}
    ORDER BY
      CASE WHEN q.question_type = 'joy_scale' AND (q.scale_type = 'ordinal_-3_to_5' OR q.scale_type IS NULL) THEN 0 ELSE 1 END,
      i.item_name
    LIMIT ${limit}
  `;

  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'items lookup failed', detail: error.message })
    };
  }

  const items = (data || []).map(row => ({
    item_id: row.item_id,
    item_name: row.item_name,
    question_text: row.question_text,
    question_type: row.question_type,
    scale_type: row.scale_type,
    short_label: row.short_label,
    scale_kind: classifyScaleKind(row.question_type, row.scale_type),
  })).filter(row => row.scale_kind !== null);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, criterion_options: CRITERION_OPTIONS })
  };
};
