/**
 * bjl-model-predictions.js — staff-only prediction ledger.
 *
 * Read-only view of bjl_model_predictions ordered by predicted_at
 * DESC. Verification writes happen through the analysis session
 * (not the UI). Unverified rows carry measured_lift = null and
 * verified_at = null; the client renders those as "awaiting
 * fielding."
 *
 * Contract:
 *   GET  → returns the whole ledger (small — 2 rows today)
 *   POST → same, kept for parity with the other endpoints' POST
 *          convention.
 *
 * Auth: workbench-authenticated only.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'GET or POST only' }) };
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    try {
      await supabase.from('bjl_front_door_log').insert({
        query: 'model_predictions',
        brief: {},
        surface: 'joy_map_predictions',
        user_email: null,
        context: { auth_status: auth.status, auth_error: auth.error || null },
        auth_failed: true,
      });
    } catch (e) { console.warn('[model-predictions] auth-failure log failed:', e.message); }
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message, auth_failed: true }),
    };
  }

  try {
    // Explicit column list so we never leak unexpected columns if
    // the schema grows. Ordered newest-first per spec.
    const sql = `
      SELECT prediction_id, model_version, cohort_definition,
             focal_items, item_id, item_wording, territory_key,
             predicted_lift, predicted_at, registered_before_fielding,
             fielding_id, measured_lift, verified_at, verdict, notes
      FROM bjl_model_predictions
      ORDER BY predicted_at DESC
    `;
    const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
    if (error) throw new Error(`bjl_model_predictions read failed: ${error.message}`);

    const predictions = (Array.isArray(data) ? data : []).map(r => ({
      prediction_id:               r.prediction_id == null ? null : Number(r.prediction_id),
      model_version:               r.model_version || null,
      cohort_definition:           r.cohort_definition || null,
      focal_items:                 Array.isArray(r.focal_items) ? r.focal_items : (r.focal_items ? [r.focal_items] : []),
      item_id:                     r.item_id == null ? null : Number(r.item_id),
      item_wording:                r.item_wording || null,
      territory_key:               r.territory_key || null,
      predicted_lift:              r.predicted_lift == null ? null : Math.round(Number(r.predicted_lift) * 10) / 10,
      predicted_at:                r.predicted_at || null,
      registered_before_fielding:  !!r.registered_before_fielding,
      fielding_id:                 r.fielding_id || null,
      measured_lift:               r.measured_lift == null ? null : Math.round(Number(r.measured_lift) * 10) / 10,
      verified_at:                 r.verified_at || null,
      verdict:                     r.verdict || null,
      notes:                       r.notes || null,
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, predictions }),
    };
  } catch (e) {
    console.error('[model-predictions] handler error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
