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
 *   Body { session_history }         — optional prior turns, [{ role, content }].
 *                                       Only meaningful alongside `query`, and
 *                                       only when the pane is re-dispatching an
 *                                       answer to a clarifying question this
 *                                       endpoint asked. Without it the front
 *                                       door reads the answer as a brand new
 *                                       standalone query and asks the same
 *                                       question again — the dead-end loop.
 *
 * Focal eligibility (hard gate). The front door serves every surface,
 * including ones that legitimately want open-ends, so it returns items
 * this sweep cannot use. A focal is only valid if its item_id exists in
 * bjl_conn_centered_v3 — that table IS the definition of "scored". An
 * ineligible focal produces an empty cohort and sixteen dead rows, so
 * it is filtered out BEFORE selection rather than discovered after.
 *
 * The ladder, reported back as `resolution.rung`:
 *   direct  staff entered ids; no resolution step was taken.
 *   a       the resolver's own items survived the eligibility gate —
 *           the brand (or category) is fielded on scored items.
 *   b       none survived. Substitutes are drawn from the category the
 *           dropped items sit in: eligible, non-brand, sharing a subtag
 *           (or failing that a primary_topic), ranked by ledger
 *           coverage. A brand is never substituted for another brand.
 *           The substitution is labelled, never silent.
 *   none    nothing eligible at any rung. No sweep runs.
 *
 * Rung A2 (customer gate) — PARKED, deliberately not built. The design
 * is settled so it does not get re-litigated:
 *   Shape. When a brand string matches an ANSWER VALUE rather than an
 *   item name — "who is your ISP?" answered "Hotwire" — the cohort is
 *   respondents who gave that raw_value on the chooser item versus the
 *   other non-null answerers of the same item, and the focals are
 *   category anchors. Floor of n >= 60 on the value; below it, fall to
 *   rung B with the substitution labelled. A2 is never claimed off a
 *   thin match.
 *   Where it belongs. Server-side, as a value_gate mode on
 *   bjl_map_cohort. The client passes the mode and nothing else. Do not
 *   build this in JS.
 *   Why it is parked. It is an enhancement with a demand trigger, not a
 *   missing guardrail — gates 1 and 3 close the safety hole on their
 *   own. Build it when either trigger fires: (a) a live engagement that
 *   needs a customer-cohort read, e.g. a grocery or telecom prospect
 *   whose pitch is "their customers vs everyone else's"; or (b) the
 *   front-door logs showing a brand query whose answer-value n actually
 *   clears 60. Hotwire's n=1 suggests (b) may be rare in this corpus.
 *
 * Pre-run halt. Even an eligible focal can isolate a cohort too small
 * to read. Below COHORT_FLOOR per side the territories array comes back
 * empty and `halt` explains why — the client renders the focal card in
 * an error state instead of sixteen rows of noise.
 *
 * REGRESSION FIXTURE for the gate. Use this phrasing, not a bare brand
 * name — see the forensic note below for why:
 *   query "people who have problems with their internet provider"
 *   -> Haiku picks 5008 and 5009 (it reasons, verbatim, that "item 5009
 *      specifically addresses internet provider issues")
 *   -> the eligibility gate drops both; neither is in bjl_conn_centered_v3
 *   -> rung b substitutes 4589 "Having access to HIGH-SPEED INTERNET in
 *      your home"
 *   -> cohort 6,040 hot / 1,794 cool, sixteen rows (15 measured, 1
 *      unmeasured: Mastery & Making), leads:
 *      treats +0.43 SD (n=1,665, 77%), value-groceries +0.52 SD
 *      (n=7,452, 77%), bath +0.43 SD (n=375, 73%), gift +0.44 SD
 *      (n=2,136, 79%)
 *   Item 5009 must never appear in focals at any rung.
 *
 *   UNITS. The lift figures above are STANDARD DEVIATIONS, not Joy Index
 *   points, and the cohort sizes are not the ones this fixture carried
 *   before 2026-08-07. Both moved for the same reason and neither is a
 *   regression:
 *     - bjl_conn_centered_v2 left the joy family in raw Joy Index points
 *       (sd 40.10) and z-scored the other nine. v3 standardises all ten.
 *       So the same measured quantity restated: treats was +17.6 points,
 *       is +0.43 SD. A ~46.7x rescale, not a change in finding.
 *     - the hot/cool split sits on that same centering, so correcting it
 *       reassigned 488 of 7,834 respondents. 6,510/1,324 -> 6,040/1,794.
 *   If a future edit makes these read as points again, the promotion has
 *   been partially reverted. Check bjl_pair_plain_v2 and Part F before
 *   changing the numbers to match whatever the code now returns.
 *
 * Forensic note, kept because it corrects the obvious assumption. The
 * bare string "Hotwire Communications" does NOT reproduce the bug and
 * never did: the concept extractor emits multi-word terms, the shortlist
 * matches by literal substring LIKE, so nothing matches, the shortlist
 * is empty and the front door returns needs_clarification. Verified
 * stable across repeated runs. The original live failure therefore
 * carried category language alongside the brand name — which is what
 * reaches the poisoned shortlist and what the fixture above reproduces.
 *
 * That dead-end is worth naming as a fourth gate nobody designed: an
 * unfielded brand name cannot reach fabrication, because it cannot even
 * reach the shortlist. Clarification is the correct answer for an n=1
 * brand. Anything that later makes term matching fuzzier (trigram,
 * embeddings) removes this accidental protection and puts the whole
 * weight back on the eligibility gate.
 *
 * Verdicts on the measured side (from sweep_v2):
 *   measured   — lead pair meets the |r| threshold
 *   flat       — lead exists but the correlation is under the flat
 *                floor; content, not empty state
 *   unmeasured — no ledger pair for the territory (dashed row)
 * Verdicts on the modeled side (from bjl_joy_map_modeled):
 *   modeled                  — factor prediction meets accuracy gate
 *   model_abstains           — the territory row in bjl_model_accuracy is
 *                              not eligible
 *   model_abstains_cohort    — cohort too small to trust the modeled read
 *   model_abstains_items     — territory centroid under 10 items
 *   model_abstains_coherence — centroid coherence under 0.35
 *
 * AS OF 2026-08-07 EVERY TERRITORY RETURNS model_abstains. That is
 * deliberate, not a fault. All 17 territory rows in bjl_model_accuracy
 * were set eligible=false with the v3 promotion: holdout_r and
 * calibration_slope were fitted against the v2 centering, so they are
 * stale rather than wrong, and an unverified modeled number must not sit
 * beside a verified measured one. The tier turns back on only after a
 * recalibration pass against v3. Do not flip eligible back to restore the
 * diamond.
 *
 * excess_r_internal never leaves the server. holdout_r renders on
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
// Minimum respondents per side of the cohort split. Below this the
// sweep is arithmetic on noise; we halt rather than render it.
const COHORT_FLOOR = 50;

// Membership in bjl_conn_centered_v3 is the definition of a scored
// item. Anything absent cannot carry a cohort and must never be a focal.
//
// v3 rather than v2 is a no-op on membership and was verified as one
// before the swap: both grids cover an identical 1,229 items, 0 in one
// and not the other. It is here so that no app-code path is still
// reading a v2 object once the promotion lands.
async function filterEligibleFocals(ids) {
  const inList = ids.filter(Number.isFinite).join(',');
  if (!inList) return [];
  const sql = `
    SELECT DISTINCT item_id
    FROM bjl_conn_centered_v3
    WHERE item_id IN (${inList})
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`focal eligibility check failed: ${error.message}`);
  const eligible = new Set((Array.isArray(data) ? data : []).map(r => Number(r.item_id)));
  return ids.filter(id => eligible.has(id));
}

// Rung B. The dropped items still tell us what the query was about;
// borrow their category and find scored items in it. Non-brand only —
// reading Hotwire through Comcast would be a category error dressed up
// as a substitution. Subtag matches beat topic matches; ties break on
// ledger coverage. Duplicate item names are the same question asked in
// different fieldings, so keep only the better-covered one.
async function rungBAnchors(droppedIds) {
  const inList = droppedIds.filter(Number.isFinite).join(',');
  if (!inList) return [];
  const sql = `
    WITH dropped AS (
      SELECT primary_topic, COALESCE(subtags, '{}') AS subtags
      FROM bjl_items WHERE item_id IN (${inList})
    ),
    topics AS (SELECT DISTINCT primary_topic AS t FROM dropped WHERE primary_topic IS NOT NULL),
    tags   AS (SELECT DISTINCT unnest(subtags) AS tag FROM dropped),
    eligible AS (
      SELECT i.item_id, i.item_name,
             (EXISTS (SELECT 1 FROM tags g WHERE g.tag = ANY(COALESCE(i.subtags, '{}')))) AS tag_match,
             count(*)::int AS n_centered
      FROM bjl_items i
      JOIN bjl_conn_centered_v3 c ON c.item_id = i.item_id
      WHERE i.item_id NOT IN (${inList})
        AND COALESCE(i.is_brand, false) = false
        AND (i.primary_topic IN (SELECT t FROM topics)
             OR EXISTS (SELECT 1 FROM tags g WHERE g.tag = ANY(COALESCE(i.subtags, '{}'))))
      GROUP BY i.item_id, i.item_name, i.subtags
    ),
    best AS (
      SELECT DISTINCT ON (LOWER(item_name)) item_id, item_name, tag_match, n_centered
      FROM eligible
      ORDER BY LOWER(item_name), n_centered DESC
    )
    SELECT item_id, item_name, n_centered
    FROM best
    WHERE tag_match OR NOT EXISTS (SELECT 1 FROM best WHERE tag_match)
    ORDER BY n_centered DESC
    LIMIT ${MAX_FOCALS}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`rung B anchor lookup failed: ${error.message}`);
  return (Array.isArray(data) ? data : []).map(r => ({
    item_id: Number(r.item_id),
    item_name: String(r.item_name),
    n_centered: Number(r.n_centered),
  }));
}

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

// round2 is for the standardised-difference values (lift). After the v3
// promotion these are ~0.13 typical, ~0.56 max, so 1 decimal collapsed a
// quarter of well-powered pairs to a flat 0.0. round1 is retained for
// territory_magnitude, which is an average Joy Index and still in points.
function round2(x) {
  return x == null ? null : Math.round(Number(x) * 100) / 100;
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
    lift_points:       round2(r.lift_points),
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

  // Prior turns, normalised to the two fields the front door reads. The front
  // door drops a malformed history rather than repairing it, so anything odd
  // here degrades to the no-history behaviour instead of inventing a
  // conversation.
  const sessionHistory = (Array.isArray(body.session_history) ? body.session_history : [])
    .filter(t => t && typeof t.role === 'string' && typeof t.content === 'string')
    .map(t => ({ role: t.role, content: t.content }));

  if (idsFromBody.length > 0) {
    focalIds = idsFromBody;
  } else if (query) {
    try {
      const brief = await bjlFrontDoor(query, {
        surface: 'joy_map_connections',
        user_email: userEmail,
        session_history: sessionHistory,
      });
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
      // Focal extraction from the brief. audience_comparison keeps
      // its focals on entities.audiences[].anchor_item_ids; every
      // other shape uses entities.items. Same convention as the
      // connections-beta pane's focalItemsFromBrief.
      if (brief.shape === 'audience_comparison') {
        const audiences = (brief.entities && Array.isArray(brief.entities.audiences)) ? brief.entities.audiences : [];
        const audIds = new Set();
        for (const aud of audiences) {
          for (const id of (Array.isArray(aud.anchor_item_ids) ? aud.anchor_item_ids : [])) {
            const n = Number(id);
            if (Number.isFinite(n)) audIds.add(n);
          }
        }
        focalIds = Array.from(audIds).slice(0, MAX_FOCALS);
      } else {
        const items = (brief.entities && Array.isArray(brief.entities.items)) ? brief.entities.items : [];
        focalIds = items
          .map(i => Number(i.item_id))
          .filter(Number.isFinite)
          .slice(0, MAX_FOCALS);
      }
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
        resolution: {
          rung: 'none',
          line: `The resolver found nothing for "${query}". Nothing to sweep.`,
          dropped: [],
        },
        note: 'Front-door resolved zero items; no focals to sweep.',
      }),
    };
  }

  // ---- Gate 1: focal eligibility, applied before selection ----
  let resolution;
  try {
    const resolvedIds = focalIds;
    const eligible = await filterEligibleFocals(resolvedIds);
    const droppedIds = resolvedIds.filter(id => !eligible.includes(id));
    const { nameById: resolvedNames } = await fetchItemsByIds(resolvedIds);
    const dropped = droppedIds.map(id => ({ item_id: id, item_name: resolvedNames.get(id) || null }));
    const droppedLabel = dropped.map(d => d.item_name || `#${d.item_id}`).join(', ');

    // force_rung_b is the halt card's one-tap escape: the resolver's own
    // items were eligible but isolated too thin a cohort, so read the
    // category instead. Only meaningful on the query path.
    const forceRungB = body.force_rung_b === true && idsFromBody.length === 0;

    if (eligible.length > 0 && !forceRungB) {
      focalIds = eligible;
      const kept = eligible.map(id => resolvedNames.get(id) || `#${id}`).join(', ');
      resolution = idsFromBody.length > 0
        ? { rung: 'direct', line: `Focal items entered by id — no resolution step. Reading: ${kept}.`, dropped }
        : {
            rung: 'a',
            line: dropped.length === 0
              ? `"${query}" is fielded on scored items. Reading it directly off ${kept}.`
              : `"${query}" is fielded on scored items. Reading it off ${kept}; dropped ${droppedLabel} — not in the scored ledger.`,
            dropped,
          };
    } else if (idsFromBody.length > 0) {
      // Staff asked for specific ids. Substituting silently would be
      // worse than refusing; say which ids are unscored and stop.
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          focals: [],
          brief: frontDoorBrief,
          territories: [],
          model_version: modelVersion,
          resolution: {
            rung: 'none',
            line: `${droppedLabel} carries no scored responses (absent from the connection ledger), so it cannot anchor a cohort. Enter a scored item, or run a query and let the ladder pick the category.`,
            dropped,
          },
        }),
      };
    } else {
      // ---- Rung B: substitute from the category, labelled ----
      // Normally we borrow the category off the items the gate dropped.
      // Under force_rung_b nothing was dropped, so borrow it off the
      // resolved items themselves — rungBAnchors excludes its own seeds.
      const anchorSeeds = forceRungB ? resolvedIds : droppedIds;
      const seedLabel = forceRungB
        ? resolvedIds.map(id => resolvedNames.get(id) || `#${id}`).join(', ')
        : droppedLabel;
      const anchors = await rungBAnchors(anchorSeeds);
      if (anchors.length === 0) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ok: true,
            focals: [],
            brief: frontDoorBrief,
            territories: [],
            model_version: modelVersion,
            resolution: {
              rung: 'none',
              line: `"${query}" resolved to ${seedLabel}, and the category behind it has no other scored items to read through. No sweep is possible.`,
              dropped,
            },
          }),
        };
      }
      focalIds = anchors.map(a => a.item_id);
      resolution = {
        rung: 'b',
        line: forceRungB
          ? `Reading "${query}" through its category instead of ${seedLabel}: ${anchors.map(a => a.item_name).join(', ')}.`
          : `${query} isn't fielded on scored items; reading through: ${anchors.map(a => a.item_name).join(', ')}.`,
        dropped,
        substituted_for: seedLabel,
      };
    }
  } catch (e) {
    console.error('[joy-map-connections] eligibility gate failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }

  try {
    const { nameById } = await fetchItemsByIds(focalIds);

    // Single JOIN query per the functional-wiring spec — one SQL
    // round-trip. bjl_territories carries the (ord, key, name)
    // lookup so we can hand the row-expand endpoint the territory_key
    // without a client-side map. LEFT JOIN so the sweep still renders
    // even if the territories table lags a new territory added to
    // the sweep function.
    const focalIdsSql = `ARRAY[${focalIds.join(',')}]::int[]`;
    const modelSql = `'${String(modelVersion).replace(/'/g, "''")}'`;

    const joinedQuery = `
      SELECT s.*,
             m.modeled_verdict, m.modeled_lift_points, m.measured_territory_mean_lift,
             m.model_holdout_r, m.coherence, m.centroid_items,
             m.cohort_hot, m.cohort_cool,
             t.territory_key, t.emotional_job
      FROM bjl_joy_map_sweep_v2(${focalIdsSql}) s
      JOIN bjl_joy_map_modeled(${focalIdsSql}, ${modelSql}) m USING (ord, territory)
      LEFT JOIN bjl_territories t ON t.ord = s.ord
    `;
    const { data: joinedRows, error: joinedErr } = await supabase.rpc(
      'execute_read_sql', { query_text: joinedQuery },
    );
    if (joinedErr) throw new Error(`joy-map join failed: ${joinedErr.message}`);
    const rowsIn = Array.isArray(joinedRows) ? joinedRows : [];

    // Bucket rows into territories by (ord, territory). Preserve
    // the row_kind hierarchy: lead first, then runner-ups, then
    // attitude/intent split rows. Modeled columns are constant
    // across a territory's rows (they come from the JOIN); grab
    // them off any row.
    const bucketByKey = new Map();
    const modeledByKey = new Map();
    for (const s of rowsIn) {
      const key = `${s.ord}::${s.territory}`;
      if (!modeledByKey.has(key)) modeledByKey.set(key, s);
      if (!bucketByKey.has(key)) {
        bucketByKey.set(key, {
          ord: Number(s.ord),
          territory: s.territory,
          territory_key: s.territory_key || null,
          emotional_job: s.emotional_job || null,
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
    // Cohort_hot / cool are constant across the whole sweep (per
    // focal set); pull them out of the first modeled row for the
    // response-level focal card.
    const firstModeled = modeledByKey.size > 0 ? modeledByKey.values().next().value : null;
    const cohortHot  = firstModeled && firstModeled.cohort_hot  != null ? Number(firstModeled.cohort_hot)  : null;
    const cohortCool = firstModeled && firstModeled.cohort_cool != null ? Number(firstModeled.cohort_cool) : null;

    // ---- Gate 3: pre-run halt ----
    // An eligible focal can still isolate a cohort too thin to read.
    // Sixteen rows computed off 12 people look identical to sixteen
    // rows computed off 12,000, so the rows do not render at all.
    if (cohortHot == null || cohortCool == null || cohortHot < COHORT_FLOOR || cohortCool < COHORT_FLOOR) {
      const focalsForHalt = focalIds.map(id => ({ item_id: id, item_name: nameById.get(id) || null }));
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok: true,
          focals: focalsForHalt,
          brief: frontDoorBrief,
          model_version: modelVersion,
          cohort_hot: cohortHot,
          cohort_cool: cohortCool,
          resolution,
          territories: [],
          halt: {
            reason: 'cohort_below_floor',
            floor: COHORT_FLOOR,
            cohort_hot: cohortHot,
            cohort_cool: cohortCool,
            line: `The cohort split is ${cohortHot == null ? '—' : cohortHot} hot / ${cohortCool == null ? '—' : cohortCool} cool, under the ${COHORT_FLOOR}-per-side floor. Territory rows are withheld — at this size the sixteen leads are noise, not signal.`,
          },
        }),
      };
    }

    const territories = Array.from(bucketByKey.values())
      .sort((a, b) => a.ord - b.ord)
      .map(t => {
        const m = modeledByKey.get(`${t.ord}::${t.territory}`);
        const modeledLift  = m ? round2(m.modeled_lift_points) : null;
        const measuredMean = m ? round2(m.measured_territory_mean_lift) : null;
        const holdoutR     = m && m.model_holdout_r != null
          ? Math.round(Number(m.model_holdout_r) * 1000) / 1000
          : null;
        const coherence    = m && m.coherence != null
          ? Math.round(Number(m.coherence) * 1000) / 1000
          : null;
        // Sign-conflict rule (two-part):
        //   sign_conflict fires whenever modeled and measured
        //     territory mean point opposite ways with both non-zero;
        //     surfaces as a visible flag in every case.
        //   suppress_on_conflict fires when sign_conflict AND the
        //     measured signal is stable (pairs_behind >= 3). Client
        //     hides the diamond by default; staff can toggle back on.
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
          territory_key: t.territory_key,
          emotional_job: t.emotional_job,
          verdict: t.verdict,
          territory_magnitude: t.territory_magnitude,
          pairs_behind: t.pairs_behind,
          thin: t.pairs_behind < PAIRS_BEHIND_MIN,
          lead: t.lead,
          runner_ups: t.runner_ups,
          attitude_intent: t.attitude_intent,
          modeled: m ? {
            // modeled_verdict is display text, not an enum. Consumers
            // render whatever string arrives; anything matching
            // /^model_abstains/ styles muted.
            verdict:               m.modeled_verdict || null,
            lift_points:           modeledLift,
            holdout_r:             holdoutR,
            coherence:             coherence,
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
        cohort_hot: cohortHot,
        cohort_cool: cohortCool,
        resolution,
        territories,
      }),
    };
  } catch (e) {
    console.error('[joy-map-connections] handler error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
