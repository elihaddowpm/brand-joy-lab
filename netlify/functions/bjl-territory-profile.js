/**
 * bjl-territory-profile.js — row-expand endpoint on the Joy Map.
 *
 * Contract per the functional-wiring spec:
 *   POST { focal_item_ids: int[1..4], territory_key: text,
 *          model_version?: text }
 *   Response: { ok, items: [{ item_id, item_wording, item_verdict,
 *                              n_hot, n_cool, measured_lift,
 *                              modeled_lift_raw }, ...] }
 *
 * item_verdict is display text: 'measured' / 'inferred' / other.
 * The client groups by that string. modeled_lift_raw is calibrated
 * despite the column name (per the spec note).
 *
 * Runs bjl_territory_profile(focals, territory_key, model_version)
 * via execute_read_sql so the array literal is inlined and Postgres
 * picks the fast plan the SQL editor uses. Same dodge as the map
 * endpoint (RPC path hits the 8s authenticator statement_timeout).
 *
 * Auth: workbench-authenticated only. Auth failures write a
 * bjl_front_door_log row with auth_failed=true.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_FOCALS = 4;
const DEFAULT_MODEL_VERSION = 'mf_v1_k24';

function sqlEscape(s) { return String(s).replace(/'/g, "''"); }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    try {
      await supabase.from('bjl_front_door_log').insert({
        query: 'territory_profile',
        brief: {},
        surface: 'joy_map_territory_profile',
        user_email: null,
        context: { auth_status: auth.status, auth_error: auth.error || null },
        auth_failed: true,
      });
    } catch (e) { console.warn('[territory-profile] auth-failure log failed:', e.message); }
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message, auth_failed: true }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON body' }) }; }

  const rawIds = Array.isArray(body.focal_item_ids) ? body.focal_item_ids : [];
  const focalIds = rawIds.map(n => Number(n)).filter(Number.isFinite).slice(0, MAX_FOCALS);
  const territoryKey = typeof body.territory_key === 'string' ? body.territory_key.trim() : '';
  const modelVersion = typeof body.model_version === 'string' && body.model_version.trim()
    ? body.model_version.trim()
    : DEFAULT_MODEL_VERSION;

  if (focalIds.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'focal_item_ids required (1-4 integers)' }) };
  }
  if (!territoryKey) {
    return { statusCode: 400, body: JSON.stringify({ error: 'territory_key required' }) };
  }

  try {
    const focalIdsSql = `ARRAY[${focalIds.join(',')}]::int[]`;
    const territorySql = `'${sqlEscape(territoryKey)}'`;
    const modelSql     = `'${sqlEscape(modelVersion)}'`;

    const sql = `
      SELECT item_id, item_wording, item_verdict,
             n_hot, n_cool, measured_lift, modeled_lift_raw
      FROM bjl_territory_profile(${focalIdsSql}, ${territorySql}, ${modelSql})
    `;
    const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
    if (error) throw new Error(`bjl_territory_profile failed: ${error.message}`);

    const items = (Array.isArray(data) ? data : []).map(r => ({
      item_id:          r.item_id == null ? null : Number(r.item_id),
      item_wording:     r.item_wording || null,
      item_verdict:     r.item_verdict || null,
      n_hot:            r.n_hot == null ? null : Number(r.n_hot),
      n_cool:           r.n_cool == null ? null : Number(r.n_cool),
      // 2 decimals on both: these are standardised differences off
      // bjl_conn_centered_v3, not Joy Index point differences. The SQL
      // already rounds to 2; rounding to 1 here threw that away.
      measured_lift:    r.measured_lift == null ? null : Math.round(Number(r.measured_lift) * 100) / 100,
      modeled_lift_raw: r.modeled_lift_raw == null ? null : Math.round(Number(r.modeled_lift_raw) * 100) / 100,
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        focal_item_ids: focalIds,
        territory_key: territoryKey,
        model_version: modelVersion,
        items,
      }),
    };
  } catch (e) {
    console.error('[territory-profile] handler error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
