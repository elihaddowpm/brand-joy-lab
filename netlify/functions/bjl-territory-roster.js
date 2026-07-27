/**
 * bjl-territory-roster.js — "what's in this territory" provenance tap.
 *
 * Contract per the functional-wiring spec:
 *   POST { territory_key: text }
 *   Response: { ok, territory_key, items: [{ item_id, item_wording,
 *              scale_family, n, spread, in_ledger, basis }, ...] }
 *
 * Plain table. No filtering, no interpretation — this is the show-
 * your-work view. Empty result → { items: [] } (client shows the
 * "no items mapped" note; empty is a rendered verdict).
 *
 * Auth: workbench-authenticated only.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function sqlEscape(s) { return String(s).replace(/'/g, "''"); }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    try {
      await supabase.from('bjl_front_door_log').insert({
        query: 'territory_roster',
        brief: {},
        surface: 'joy_map_territory_roster',
        user_email: null,
        context: { auth_status: auth.status, auth_error: auth.error || null },
        auth_failed: true,
      });
    } catch (e) { console.warn('[territory-roster] auth-failure log failed:', e.message); }
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message, auth_failed: true }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON body' }) }; }

  const territoryKey = typeof body.territory_key === 'string' ? body.territory_key.trim() : '';
  if (!territoryKey) {
    return { statusCode: 400, body: JSON.stringify({ error: 'territory_key required' }) };
  }

  try {
    const sql = `
      SELECT item_id, item_wording, scale_family, n, spread, in_ledger, basis
      FROM bjl_territory_roster('${sqlEscape(territoryKey)}')
    `;
    const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
    if (error) throw new Error(`bjl_territory_roster failed: ${error.message}`);

    const items = (Array.isArray(data) ? data : []).map(r => ({
      item_id:      r.item_id == null ? null : Number(r.item_id),
      item_wording: r.item_wording || null,
      scale_family: r.scale_family || null,
      n:            r.n == null ? null : Number(r.n),
      spread:       r.spread == null ? null : Math.round(Number(r.spread) * 1000) / 1000,
      in_ledger:    !!r.in_ledger,
      basis:        r.basis || null,
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        territory_key: territoryKey,
        items,
      }),
    };
  } catch (e) {
    console.error('[territory-roster] handler error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
