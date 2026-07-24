/**
 * bjl-joy-map-connections.js — Joy Map connections section endpoint.
 *
 * Runs bjl_joy_map_sweep(int[]) against a small set of focal item ids
 * and returns 13 rows (one per fixed life domain) with the lead pair
 * per domain across all focals. Applies pair-skew suppression on
 * pct_move_together and strips r_internal before returning. r never
 * leaves the server.
 *
 * Contract:
 *   POST { focal_item_ids: int[] }  — 1 to 4 ids
 * Response:
 *   { ok: true,
 *     focals: [{ item_id, item_name }, ...],
 *     rows: [{
 *       ord, domain, verdict, direction,
 *       focal_item, focal_item_id,
 *       domain_item, domain_item_id,
 *       shared_answerers, pct_move_together, pct_suppressed,
 *       pct_suppress_reason, lift_points,
 *     }, ...] }
 *
 * Verdicts (from the DB function):
 *   'measured'   — |r| >= 0.08 (rendered as a real connection row)
 *   'flat'       — |r| < 0.08 (rendered; content, not empty state)
 *   'unmeasured' — no ledger pair (rendered; content, not empty state)
 *
 * Auth: workbench-authenticated only. Auth failures write a
 * bjl_front_door_log row with auth_failed=true so the health view
 * surfaces auth churn.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_FOCALS = 4;

// Skew thresholds (same as connections-beta). When either side of a
// pair has a heavily one-sided distribution (<25% or >75% on one side
// of zero), pct_move_together is unreliable and gets suppressed.
const SKEW_LOW  = 25;
const SKEW_HIGH = 75;

async function fetchItemsByIds(ids) {
  if (!ids.length) return new Map();
  const inList = ids.filter(Number.isFinite).join(',');
  if (!inList) return new Map();
  const sql = `SELECT item_id, item_name FROM bjl_items WHERE item_id IN (${inList})`;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`item name lookup failed: ${error.message}`);
  const map = new Map();
  for (const r of (Array.isArray(data) ? data : [])) {
    map.set(String(r.item_name), Number(r.item_id));
  }
  return map;
}

async function fetchSkewByItem(ids) {
  if (!ids.length) return new Map();
  const inList = Array.from(new Set(ids)).filter(Number.isFinite).join(',');
  if (!inList) return new Map();
  const sql = `
    SELECT item_id,
           ROUND(100.0 * SUM(CASE WHEN c > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1)::numeric AS pct_positive
    FROM bjl_conn_centered
    WHERE item_id IN (${inList})
    GROUP BY item_id
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`item skew lookup failed: ${error.message}`);
  const map = new Map();
  for (const r of (Array.isArray(data) ? data : [])) {
    const pct = r.pct_positive == null ? null : Number(r.pct_positive);
    map.set(Number(r.item_id), pct != null && (pct < SKEW_LOW || pct > SKEW_HIGH));
  }
  return map;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    try {
      let attemptedIds = [];
      try { const parsed = JSON.parse(event.body || '{}'); attemptedIds = Array.isArray(parsed.focal_item_ids) ? parsed.focal_item_ids : []; }
      catch (_) { /* body may be absent */ }
      await supabase.from('bjl_front_door_log').insert({
        query: `joy_map_connections focals=[${attemptedIds.join(',')}]`,
        brief: {},
        surface: 'joy_map_connections',
        user_email: null,
        context: { auth_status: auth.status, auth_error: auth.error || null },
        auth_failed: true,
      });
    } catch (e) { console.warn('[joy-map-connections] auth-failure log failed:', e.message); }
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
  if (focalIds.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'focal_item_ids required (1-4 integers)' }) };
  }

  try {
    // Pre-fetch focal names so the response can carry focal_item_id
    // alongside the function's text-only focal_item column.
    const focalNameToId = await fetchItemsByIds(focalIds);
    // Reverse map: name → id (already what fetchItemsByIds returns).

    // Run the sweep.
    const { data: sweepRows, error: sweepErr } = await supabase.rpc('bjl_joy_map_sweep', { p_focal: focalIds });
    if (sweepErr) throw new Error(`bjl_joy_map_sweep failed: ${sweepErr.message}`);
    const rowsIn = Array.isArray(sweepRows) ? sweepRows : [];

    // Collect all item ids touched (focal + domain) via name lookup for
    // the domain items, so we can batch-fetch skew in one shot.
    const domainItemNames = new Set();
    for (const r of rowsIn) if (r.domain_item) domainItemNames.add(String(r.domain_item));
    const domainNameToId = domainItemNames.size > 0
      ? await (async () => {
          const inList = Array.from(domainItemNames).map(n => `'${String(n).replace(/'/g, "''")}'`).join(',');
          const sql = `SELECT item_id, item_name FROM bjl_items WHERE item_name IN (${inList})`;
          const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
          if (error) throw new Error(`domain item lookup failed: ${error.message}`);
          const m = new Map();
          for (const row of (Array.isArray(data) ? data : [])) m.set(String(row.item_name), Number(row.item_id));
          return m;
        })()
      : new Map();

    const allIds = new Set(focalIds);
    for (const id of domainNameToId.values()) allIds.add(id);
    const skewByItem = await fetchSkewByItem(Array.from(allIds));

    // Build response rows. Skew suppression on pct_move_together;
    // r_internal stripped.
    const rowsOut = rowsIn.map(r => {
      const focalItemId = r.focal_item ? (focalNameToId.get(String(r.focal_item)) || null) : null;
      const domainItemId = r.domain_item ? (domainNameToId.get(String(r.domain_item)) || null) : null;
      const focalSkewed  = focalItemId != null ? !!skewByItem.get(focalItemId) : false;
      const domainSkewed = domainItemId != null ? !!skewByItem.get(domainItemId) : false;
      const pctSuppressed = r.verdict === 'measured' && (focalSkewed || domainSkewed);
      return {
        ord:               Number(r.ord),
        domain:            r.domain,
        verdict:           r.verdict,
        direction:         r.direction || null,
        focal_item:        r.focal_item || null,
        focal_item_id:     focalItemId,
        domain_item:       r.domain_item || null,
        domain_item_id:    domainItemId,
        shared_answerers:  r.shared_answerers == null ? null : Number(r.shared_answerers),
        pct_move_together: pctSuppressed
          ? null
          : (r.pct_move_together == null ? null : Math.round(Number(r.pct_move_together))),
        pct_suppressed:    pctSuppressed,
        pct_suppress_reason: pctSuppressed
          ? 'One side of this pair has a heavily one-sided distribution (>75% or <25% on one side of zero). Percent moving together loses meaning under skew.'
          : null,
        lift_points:       r.lift_points == null ? null : Math.round(Number(r.lift_points) * 10) / 10,
      };
    });

    const focals = focalIds.map(id => {
      // Reverse-lookup focal name from the pre-fetched map (which is name→id).
      let name = null;
      for (const [n, i] of focalNameToId) { if (i === id) { name = n; break; } }
      return { item_id: id, item_name: name };
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, focals, rows: rowsOut }),
    };
  } catch (e) {
    console.error('[joy-map-connections] handler error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
