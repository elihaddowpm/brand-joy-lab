/**
 * bjl-joy-map-connections.js — Joy Map three-tier renderer endpoint.
 *
 * Runs the SQL contract from the spec:
 *   SELECT ... FROM bjl_joy_map_sweep_v2(focal) s
 *   JOIN bjl_joy_map_modeled(focal, model) m USING (ord, territory)
 *
 * Returns one entry per (ord, territory) with three tiers exposed:
 *   1. Measured lead — the strongest joy-lead pair for the territory,
 *      lift_points + direction anchor the row's coloured bar.
 *   2. Runners-up + attitude/intent split rows behind the lead
 *      (row_kind = 'joy_runner_up' | 'attitude_intent').
 *   3. Modeled — the modeled_lift_points diamond plotted against
 *      measured_territory_mean_lift (never against the lead bar),
 *      with modeled_verdict, model_holdout_r, cohort_hot/cool.
 *
 * Sign-conflict flag: sign(modeled) !== sign(measured_territory_mean_lift)
 * AND pairs_behind >= 3. Suppression is client-side (staff-only
 * toggle); the flag is emitted here so the UI can honour it.
 *
 * THIN badge: pairs_behind < 3. Emitted as `thin` boolean.
 *
 * Focal resolution:
 *   Body { focal_item_ids: int[] }   — direct path (staff enters ids).
 *   Body { query: string }           — front-door resolver path;
 *                                       brief.entities.items become
 *                                       the focals.
 *
 * Verdicts on the measured side (from sweep_v2):
 *   measured   — lead pair meets the |r| threshold
 *   flat       — lead exists but the correlation is under the flat
 *                floor; content, not empty state
 *   unmeasured — no ledger pair for the territory (dashed row)
 * Verdicts on the modeled side (from bjl_joy_map_modeled):
 *   modeled                — factor prediction meets accuracy gate
 *   model_abstains         — holdout_r below the model registry floor
 *   model_abstains_cohort  — cohort too small to trust the modeled read
 *
 * r_internal never leaves the server. holdout_r renders on
 * model_abstains rows only.
 *
 * Auth: workbench-authenticated only. Auth failures write a
 * bjl_front_door_log row with auth_failed=true so the health view
 * surfaces auth churn.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');
const { bjlFrontDoor } = require('./bjl-front-door.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MAX_FOCALS = 4;
const DEFAULT_MODEL_VERSION = 'mf_v1_k24';
// THIN badge and sign-conflict rule both key off this.
const PAIRS_BEHIND_MIN = 3;

async function fetchItemsByIds(ids) {
  if (!ids.length) return new Map();
  const inList = ids.filter(Number.isFinite).join(',');
  if (!inList) return new Map();
  const sql = `SELECT item_id, item_name FROM bjl_items WHERE item_id IN (${inList})`;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`item name lookup failed: ${error.message}`);
  const nameById = new Map();
  const idByName = new Map();
  for (const r of (Array.isArray(data) ? data : [])) {
    nameById.set(Number(r.item_id), String(r.item_name));
    idByName.set(String(r.item_name), Number(r.item_id));
  }
  return { nameById, idByName };
}

function sign(x) {
  if (x == null || Number.isNaN(Number(x))) return 0;
  const n = Number(x);
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

function round1(x) {
  return x == null ? null : Math.round(Number(x) * 10) / 10;
}

function roundInt(x) {
  return x == null ? null : Math.round(Number(x));
}

function shapePairRow(r) {
  return {
    row_kind:          r.row_kind || 'joy_lead',
    focal_item:        r.focal_item || null,
    other_item:        r.other_item || null,
    other_family:      r.other_family || null,
    direction:         r.direction || null,
    shared_answerers:  r.shared_answerers == null ? null : Number(r.shared_answerers),
    pct_move_together: r.pct_move_together == null ? null : roundInt(r.pct_move_together),
    lift_points:       round1(r.lift_points),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    try {
      let attempted = '';
      try {
        const parsed = JSON.parse(event.body || '{}');
        attempted = parsed.query
          ? `joy_map query="${String(parsed.query).slice(0, 200)}"`
          : `joy_map focals=[${(parsed.focal_item_ids || []).join(',')}]`;
      } catch (_) { /* body absent */ }
      await supabase.from('bjl_front_door_log').insert({
        query: attempted,
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

  const userEmail = (auth.user && auth.user.email) || auth.email || null;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON body' }) }; }

  const modelVersion = typeof body.model_version === 'string' && body.model_version.trim()
    ? body.model_version.trim()
    : DEFAULT_MODEL_VERSION;

  // Focal resolution: direct ids OR front-door query.
  let focalIds = [];
  let frontDoorBrief = null;
  const rawIds = Array.isArray(body.focal_item_ids) ? body.focal_item_ids : [];
  const idsFromBody = rawIds.map(n => Number(n)).filter(Number.isFinite).slice(0, MAX_FOCALS);
  const query = typeof body.query === 'string' ? body.query.trim() : '';

  if (idsFromBody.length > 0) {
    focalIds = idsFromBody;
  } else if (query) {
    try {
      const brief = await bjlFrontDoor(query, { surface: 'joy_map_connections', user_email: userEmail });
      frontDoorBrief = brief;
      if (brief.shape === 'needs_clarification' || brief.shape === 'out_of_scope') {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ok: true,
            focals: [],
            brief,
            territories: [],
            model_version: modelVersion,
          }),
        };
      }
      const items = (brief.entities && Array.isArray(brief.entities.items)) ? brief.entities.items : [];
      focalIds = items
        .map(i => Number(i.item_id))
        .filter(Number.isFinite)
        .slice(0, MAX_FOCALS);
    } catch (e) {
      console.error('[joy-map-connections] front door failed:', e.message);
      return { statusCode: 500, body: JSON.stringify({ error: `front door failed: ${e.message}` }) };
    }
  } else {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'either focal_item_ids (1-4 ints) or query (string) is required' }),
    };
  }

  if (focalIds.length === 0) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        focals: [],
        brief: frontDoorBrief,
        territories: [],
        model_version: modelVersion,
        note: 'Front-door resolved zero items; no focals to sweep.',
      }),
    };
  }

  try {
    const { nameById } = await fetchItemsByIds(focalIds);

    // Sweep_v2: measured tier (lead + runner-ups + attitude_intent
    // split rows, all keyed by ord + territory).
    const { data: sweepRows, error: sweepErr } = await supabase.rpc(
      'bjl_joy_map_sweep_v2', { p_focal: focalIds },
    );
    if (sweepErr) throw new Error(`bjl_joy_map_sweep_v2 failed: ${sweepErr.message}`);

    // Modeled: one row per (ord, territory).
    const { data: modelRows, error: modelErr } = await supabase.rpc(
      'bjl_joy_map_modeled', { p_focal: focalIds, p_model: modelVersion },
    );
    if (modelErr) throw new Error(`bjl_joy_map_modeled failed: ${modelErr.message}`);

    // Index modeled rows by (ord, territory) for the JOIN.
    const modeledByKey = new Map();
    for (const m of (Array.isArray(modelRows) ? modelRows : [])) {
      modeledByKey.set(`${m.ord}::${m.territory}`, m);
    }

    // Bucket sweep rows into territories by (ord, territory). Preserve
    // the row_kind hierarchy: lead first, then runner-ups, then
    // attitude/intent split rows.
    const bucketByKey = new Map();
    for (const s of (Array.isArray(sweepRows) ? sweepRows : [])) {
      const key = `${s.ord}::${s.territory}`;
      if (!bucketByKey.has(key)) {
        bucketByKey.set(key, {
          ord: Number(s.ord),
          territory: s.territory,
          verdict: s.verdict,
          territory_magnitude: round1(s.territory_magnitude),
          pairs_behind: s.pairs_behind == null ? 0 : Number(s.pairs_behind),
          lead: null,
          runner_ups: [],
          attitude_intent: [],
        });
      }
      const bucket = bucketByKey.get(key);
      // The lead row carries the territory's verdict; runner-ups mirror
      // it. Prefer the sweep-provided verdict from the lead row.
      if (s.row_kind === 'joy_lead') {
        bucket.verdict = s.verdict;
        bucket.lead = shapePairRow(s);
      } else if (s.row_kind === 'attitude_intent') {
        bucket.attitude_intent.push(shapePairRow(s));
      } else {
        bucket.runner_ups.push(shapePairRow(s));
      }
    }

    // Assemble territories in ord order and merge modeled + flags.
    const territories = Array.from(bucketByKey.values())
      .sort((a, b) => a.ord - b.ord)
      .map(t => {
        const m = modeledByKey.get(`${t.ord}::${t.territory}`);
        const modeledLift  = m ? round1(m.modeled_lift_points) : null;
        const measuredMean = m ? round1(m.measured_territory_mean_lift) : null;
        const holdoutR     = m && m.model_holdout_r != null
          ? Math.round(Number(m.model_holdout_r) * 1000) / 1000
          : null;
        // Sign-conflict rule (two-part):
        //   sign_conflict fires whenever modeled and measured
        //     territory mean point opposite ways with both non-zero;
        //     surfaces as a visible flag in every case.
        //   suppress_on_conflict fires when sign_conflict AND the
        //     measured signal is stable (pairs_behind >= 3). Client
        //     hides the diamond by default; staff can toggle back on.
        // Treats & Indulgence for focal 4646 is the pairs_behind=2
        // case: flag surfaces, suppression does not.
        const signConflict = (
          m &&
          modeledLift != null && measuredMean != null &&
          sign(modeledLift) !== 0 && sign(measuredMean) !== 0 &&
          sign(modeledLift) !== sign(measuredMean)
        );
        const suppressOnConflict = !!(signConflict && t.pairs_behind >= PAIRS_BEHIND_MIN);
        return {
          ord: t.ord,
          territory: t.territory,
          verdict: t.verdict,
          territory_magnitude: t.territory_magnitude,
          pairs_behind: t.pairs_behind,
          thin: t.pairs_behind < PAIRS_BEHIND_MIN,
          lead: t.lead,
          runner_ups: t.runner_ups,
          attitude_intent: t.attitude_intent,
          modeled: m ? {
            verdict:               m.modeled_verdict,
            lift_points:           modeledLift,
            holdout_r:             holdoutR,
            centroid_items:        m.centroid_items == null ? null : Number(m.centroid_items),
            cohort_hot:            m.cohort_hot == null ? null : Number(m.cohort_hot),
            cohort_cool:           m.cohort_cool == null ? null : Number(m.cohort_cool),
            measured_territory_mean_lift: measuredMean,
            sign_conflict:         !!signConflict,
            suppress_on_conflict:  suppressOnConflict,
          } : null,
        };
      });

    const focals = focalIds.map(id => ({
      item_id: id,
      item_name: nameById.get(id) || null,
    }));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        focals,
        brief: frontDoorBrief,
        model_version: modelVersion,
        territories,
      }),
    };
  } catch (e) {
    console.error('[joy-map-connections] handler error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
