/**
 * bjl-connections-beta.js — Connections (beta) endpoint.
 *
 * Front-door consumer (2026-07-23): all query understanding — shape
 * classification, entity resolution, job-id inheritance, needs_
 * clarification / out_of_scope escalation — moved to
 * netlify/functions/bjl-front-door.js so every BJL surface shares one
 * brief. This pane just reads brief.shape and brief.entities and
 * routes accordingly.
 *
 * Pipeline:
 *   1. Auth + feature-flag check.
 *   2. bjlFrontDoor(query, { surface, prior_job_id, user_email })
 *      returns the brief. If brief.shape is needs_clarification, echo
 *      brief.clarifying_question; if out_of_scope, decline politely;
 *      otherwise convert brief.entities into focal items via
 *      focalItemsFromBrief().
 *   3. Per focal: bjl_item_edges(item_id) for every connection, sorted
 *      by |r| desc (r stays server-side).
 *   4. Batch item-skew lookup against bjl_conn_centered. When an
 *      item's centered values are heavily one-sided (< 25% or > 75%
 *      on one side of zero), suppress pct_move_together on cards
 *      involving that item — the metric is unreliable under a skewed
 *      distribution.
 *   5. Translate each surfaced edge via bjl_pair_plain(a, b), applying
 *      skew suppression. Correlation coefficients (r) never appear in
 *      the response payload.
 *   6. Two variants of unmeasured copy: (a) item outside ledger (under
 *      50 respondents), (b) no qualifying pair (under 30 shared).
 *   7. Optional scratch log to bjl_query_jobs under key
 *      'connections_beta' when a job_id is supplied. Includes the
 *      brief for downstream auditing.
 *
 * Hard rule (unchanged): correlation coefficients never leave the
 * server. Every card speaks in shared answerers, pct moving together
 * (unless skew-suppressed), and Joy Index point lift.
 *
 * Auth: workbench-authenticated only.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CONNECTIONS_BETA_ALLOWLIST = new Set([
  'haddowe@peteramayer.com',
  'edelmanm@peteramayer.com',
]);

const INSIDE_MAX_POSITIVE   = 6;
const INSIDE_MAX_NEGATIVE   = 3;
const BEYOND_MAX_POSITIVE   = 8;
const BEYOND_MAX_NEGATIVE   = 3;
const EDGE_DIVERSITY_FLOOR  = 50;

// Skew thresholds. If an item's centered values are heavily one-sided
// (fewer than 25% on one side of zero, or more than 75%), the pct-
// moving-together metric on any pair involving that item becomes
// unreliable — a skewed item can produce a low pct_move_together even
// when the pair has a strong positive lift, because nearly everyone
// sits on the same side of their own baseline on the skewed item and
// there's little variance to co-move with.
const SKEW_LOW  = 25;
const SKEW_HIGH = 75;

// ---------------------------------------------------------------------
// Query understanding — delegated to the front door (bjl-front-door.js).
// ---------------------------------------------------------------------
// The connections pane is now a pure consumer of the front-door brief.
// The local three-stage resolver that lived here previously (Haiku
// concept extractor + SQL shortlist + Haiku semantic-subject picker)
// moved into netlify/functions/bjl-front-door.js so every BJL surface
// shares the same query understanding. The pane reads brief.shape,
// brief.entities.items, and brief.entities.audiences and routes
// accordingly.

const { bjlFrontDoor } = require('./bjl-front-door.js');

// Turn the brief into the pane's focal-item list. The pane runs the
// ledger against whichever items the shape resolved to — items for
// item_connection, audience anchor items for audience_comparison,
// items again for brand_lookup / territory_read (when any items came
// back), etc. Only needs_clarification and out_of_scope skip the
// ledger entirely; every other shape gets to run if entities resolved.
async function focalItemsFromBrief(brief) {
  if (!brief || !brief.entities) return [];
  const shape = brief.shape;
  if (shape === 'audience_comparison') {
    const audiences = Array.isArray(brief.entities.audiences) ? brief.entities.audiences : [];
    const anchorIds = new Set();
    for (const aud of audiences) {
      for (const id of (Array.isArray(aud.anchor_item_ids) ? aud.anchor_item_ids : [])) {
        anchorIds.add(Number(id));
      }
    }
    if (anchorIds.size > 0) {
      const idList = Array.from(anchorIds).join(',');
      const sql = `SELECT item_id, item_name, primary_topic, canonical_brand FROM bjl_items WHERE item_id IN (${idList})`;
      const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
      if (error) throw new Error(`focal fetch from audience anchors failed: ${error.message}`);
      return (Array.isArray(data) ? data : []).map(r => ({
        item_id:         Number(r.item_id),
        item_name:       String(r.item_name),
        primary_topic:   r.primary_topic || null,
        canonical_brand: r.canonical_brand || null,
        match_source:    'audience_anchor',
      }));
    }
    return [];
  }
  // Every other actionable shape uses brief.entities.items directly.
  const items = Array.isArray(brief.entities.items) ? brief.entities.items : [];
  return items.map(i => ({
    item_id:         Number(i.item_id),
    item_name:       String(i.item_name),
    primary_topic:   i.primary_topic || null,
    canonical_brand: null,
    match_source:    i.match_basis === 'embedding' ? 'embedding' : 'reasoning',
  }));
}

// ---------------------------------------------------------------------
// Edges + item meta
// ---------------------------------------------------------------------
async function fetchEdges(focalItemId) {
  const { data, error } = await supabase.rpc('bjl_item_edges', { p_item: focalItemId });
  if (error) throw new Error(`bjl_item_edges failed for item ${focalItemId}: ${error.message}`);
  const rows = Array.isArray(data) ? data : [];
  return rows
    .map(r => ({
      other_item: Number(r.other_item),
      n_pair:     Number(r.n_pair),
      r:          Number(r.r),
      abs_r:      Math.abs(Number(r.r)),
    }))
    .sort((a, b) => (b.abs_r - a.abs_r) || (b.n_pair - a.n_pair));
}

async function fetchItemMeta(itemIds) {
  if (!itemIds || itemIds.length === 0) return new Map();
  const uniq = Array.from(new Set(itemIds));
  const idList = uniq.map(Number).filter(Number.isFinite).join(',');
  if (!idList) return new Map();
  const sql = `SELECT item_id, item_name, primary_topic FROM bjl_items WHERE item_id IN (${idList})`;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`item meta lookup failed: ${error.message}`);
  const map = new Map();
  for (const r of (Array.isArray(data) ? data : [])) {
    map.set(Number(r.item_id), {
      item_name:     String(r.item_name),
      primary_topic: r.primary_topic || null,
    });
  }
  return map;
}

// ---------------------------------------------------------------------
// Item skew — one batch SQL round trip against bjl_conn_centered.
// Returns Map<item_id, pct_positive>. If pct_positive < 25 or > 75,
// pct_move_together on any pair involving that item is suppressed
// because the metric loses meaning under a skewed distribution.
// ---------------------------------------------------------------------
async function fetchItemSkew(itemIds) {
  if (!itemIds || itemIds.length === 0) return new Map();
  const uniq = Array.from(new Set(itemIds));
  const idList = uniq.map(Number).filter(Number.isFinite).join(',');
  if (!idList) return new Map();
  const sql = `
    SELECT item_id,
           ROUND(100.0 * SUM(CASE WHEN c > 0 THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1)::numeric AS pct_positive,
           COUNT(*) AS n
    FROM bjl_conn_centered
    WHERE item_id IN (${idList})
    GROUP BY item_id
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`item skew lookup failed: ${error.message}`);
  const map = new Map();
  for (const r of (Array.isArray(data) ? data : [])) {
    const pct = r.pct_positive == null ? null : Number(r.pct_positive);
    map.set(Number(r.item_id), {
      pct_positive: pct,
      skewed: pct != null && (pct < SKEW_LOW || pct > SKEW_HIGH),
      n: Number(r.n),
    });
  }
  return map;
}

async function translateEdge(focal, edge, otherMeta, skewByItem) {
  const [a, b] = focal.item_id < edge.other_item
    ? [focal.item_id, edge.other_item]
    : [edge.other_item, focal.item_id];
  const { data, error } = await supabase.rpc('bjl_pair_plain', { p_item_a: a, p_item_b: b });
  if (error) throw new Error(`bjl_pair_plain failed for (${a}, ${b}): ${error.message}`);
  const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
  if (!row) return null;
  const focalSkew = skewByItem.get(focal.item_id) || { skewed: false };
  const otherSkew = skewByItem.get(edge.other_item) || { skewed: false };
  const suppressPct = focalSkew.skewed || otherSkew.skewed;
  return {
    focal_item_id:       focal.item_id,
    focal_item_name:     focal.item_name,
    focal_primary_topic: focal.primary_topic,
    other_item_id:       edge.other_item,
    other_item_name:     otherMeta ? otherMeta.item_name : null,
    other_primary_topic: otherMeta ? otherMeta.primary_topic : null,
    direction:           edge.r >= 0 ? 'rises with' : 'runs against',
    shared_answerers:    Number(row.shared_answerers),
    pct_move_together:   suppressPct
      ? null
      : (row.pct_move_together == null ? null : Math.round(Number(row.pct_move_together))),
    pct_move_together_suppressed: suppressPct,
    pct_move_together_suppress_reason: suppressPct
      ? 'One side of this pair has a heavily one-sided distribution (>75% or <25% on one side of zero). Percent moving together loses meaning when there is little variance to co-move with.'
      : null,
    lift_points: row.lift_points == null ? null : Math.round(Number(row.lift_points) * 10) / 10,
  };
}

function partitionEdges(focal, edges, otherMetaById) {
  const positiveInside  = [];
  const negativeInside  = [];
  const positiveBeyond  = [];
  const negativeBeyond  = [];
  for (const edge of edges) {
    const meta = otherMetaById.get(edge.other_item) || null;
    const otherTopic = meta ? meta.primary_topic : null;
    const sameTopic = otherTopic && focal.primary_topic && otherTopic === focal.primary_topic;
    if (sameTopic) {
      if (edge.r >= 0) positiveInside.push(edge); else negativeInside.push(edge);
    } else {
      if (edge.r >= 0) positiveBeyond.push(edge); else negativeBeyond.push(edge);
    }
  }
  return {
    positiveInside: positiveInside.slice(0, INSIDE_MAX_POSITIVE),
    negativeInside: negativeInside.slice(0, INSIDE_MAX_NEGATIVE),
    positiveBeyond: positiveBeyond.slice(0, BEYOND_MAX_POSITIVE),
    negativeBeyond: negativeBeyond.slice(0, BEYOND_MAX_NEGATIVE),
  };
}

async function appendScratchEntry(jobId, entry) {
  if (!jobId) return;
  try {
    const { data: existing, error: readErr } = await supabase
      .from('bjl_query_jobs')
      .select('scratch')
      .eq('job_id', jobId)
      .maybeSingle();
    if (readErr || !existing) return;
    const scratch = Array.isArray(existing.scratch) ? existing.scratch : [];
    scratch.push(entry);
    await supabase
      .from('bjl_query_jobs')
      .update({ scratch })
      .eq('job_id', jobId);
  } catch (e) {
    console.warn('[connections-beta] scratch append failed:', e.message);
  }
}

// ---------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message }),
    };
  }

  const userEmail = (auth.user && auth.user.email) || auth.email || null;
  const flagEnabled = !!(userEmail && CONNECTIONS_BETA_ALLOWLIST.has(userEmail.toLowerCase()));
  if (!flagEnabled) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, feature_enabled: false, reason: 'not_on_allowlist' }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON body' }) }; }

  const query = String(body.query || '').trim();
  if (!query) return { statusCode: 400, body: JSON.stringify({ error: 'query required' }) };
  const jobId = body.job_id && typeof body.job_id === 'string' ? body.job_id.trim() : null;

  try {
    // Single call to the front door. It owns shape classification,
    // entity resolution (including job-id inheritance from the
    // investigator's decomposer_plan when jobId is supplied), and
    // needs_clarification / out_of_scope escalation. The pane just
    // consumes the brief.
    const brief = await bjlFrontDoor(query, {
      surface: 'connections',
      prior_job_id: jobId,
      user_email: userEmail,
    });

    // Shapes that never reach the ledger: return the front door's
    // clarifying question (or a polite decline) unchanged.
    if (brief.shape === 'needs_clarification') {
      const payload = {
        ok: true,
        feature_enabled: true,
        query,
        brief,
        focal_items: [],
        inside_category: [],
        beyond_category: [],
        negative_rim_inside: [],
        negative_rim_beyond: [],
        unmeasured: [{
          reason: 'needs_clarification',
          detail: brief.clarifying_question || 'Could you rephrase — I need a specific experience, brand, or category to run this against.',
        }],
        caveats: [],
        resolver_path: 'front_door',
        resolver_note: brief.resolver_note,
      };
      await appendScratchEntry(jobId, { type: 'connections_beta', ...payload });
      return { statusCode: 200, body: JSON.stringify(payload) };
    }

    if (brief.shape === 'out_of_scope') {
      const payload = {
        ok: true,
        feature_enabled: true,
        query,
        brief,
        focal_items: [],
        inside_category: [],
        beyond_category: [],
        negative_rim_inside: [],
        negative_rim_beyond: [],
        unmeasured: [{
          reason: 'out_of_scope',
          detail: "That's outside what the Joy Lab corpus can answer. This pane runs the within-person connectivity ledger — try a question about how experiences, brands, or categories move together in people's joy.",
        }],
        caveats: [],
        resolver_path: 'front_door',
        resolver_note: brief.resolver_note,
      };
      await appendScratchEntry(jobId, { type: 'connections_beta', ...payload });
      return { statusCode: 200, body: JSON.stringify(payload) };
    }

    const focalItems = await focalItemsFromBrief(brief);
    const resolverPath = 'front_door';
    const resolverNote = brief.resolver_note;

    if (focalItems.length === 0) {
      const empty = {
        ok: true,
        feature_enabled: true,
        query,
        brief,
        focal_items: [],
        inside_category: [],
        beyond_category: [],
        negative_rim_inside: [],
        negative_rim_beyond: [],
        unmeasured: [{
          reason: 'no_focal_items_resolved',
          detail: 'The front door classified this query but no focal items resolved for the ledger. Two things to try: (a) rephrase to name a specific experience (e.g. "going to a game", "having coffee at a cafe", "a theme park trip"), or (b) if the question is really about comparing groups of people (fans vs non-fans, Gen Z vs Boomers), the main Intelligence pane\u2019s audience arms answer it. Attach an Intelligence job_id here to use its already-resolved focals.',
        }],
        caveats: [],
        resolver_path: resolverPath,
        resolver_note: resolverNote,
      };
      await appendScratchEntry(jobId, { type: 'connections_beta', ...empty });
      return { statusCode: 200, body: JSON.stringify(empty) };
    }

    // Edges + partition per focal.
    const insideCategory     = [];
    const beyondCategory     = [];
    const negativeRimInside  = [];
    const negativeRimBeyond  = [];
    const unmeasured         = [];
    const caveats            = [];
    const rInternalLog       = [];

    // First pass: gather every other_item_id across all focals so we
    // can do ONE batch fetch for item meta + item skew.
    const allEdgesPerFocal = new Map();
    const allOtherIds = new Set();
    for (const focal of focalItems) {
      const edges = await fetchEdges(focal.item_id);
      allEdgesPerFocal.set(focal.item_id, edges);
      for (const e of edges) allOtherIds.add(e.other_item);
      if (edges.length === 0) {
        // Fix 4a: item outside the ledger — under 50 respondents.
        unmeasured.push({
          focal_item_id:   focal.item_id,
          focal_item_name: focal.item_name,
          reason:          'item_below_ledger_floor',
          detail:          `This item has too few respondents to enter the connectivity ledger (under 50). Unmeasured — candidate for co-fielding.`,
        });
      } else if (edges.length < EDGE_DIVERSITY_FLOOR) {
        caveats.push({
          focal_item_id:   focal.item_id,
          focal_item_name: focal.item_name,
          edge_count:      edges.length,
          warning:         'edge_diversity_low',
          detail:          `Only ${edges.length} edges in the ledger for this item — its neighborhood may all come from one co-fielding module. Treat cross-category connections here with extra care.`,
        });
      }
    }

    // Batch meta + skew lookup — includes focal items themselves so
    // the pct-suppression check catches skewed focals.
    const allItemIdsForLookup = new Set(allOtherIds);
    for (const focal of focalItems) allItemIdsForLookup.add(focal.item_id);
    const metaById = await fetchItemMeta(Array.from(allItemIdsForLookup));
    const skewByItem = await fetchItemSkew(Array.from(allItemIdsForLookup));

    // Translate + partition per focal.
    for (const focal of focalItems) {
      const edges = allEdgesPerFocal.get(focal.item_id) || [];
      if (edges.length === 0) continue;
      const parts = partitionEdges(focal, edges, metaById);
      const translateBatch = async (bucket, targetArr) => {
        for (const edge of bucket) {
          const meta = metaById.get(edge.other_item) || null;
          const card = await translateEdge(focal, edge, meta, skewByItem);
          if (card) {
            targetArr.push(card);
            rInternalLog.push({
              focal_item_id: focal.item_id,
              other_item_id: edge.other_item,
              r:             edge.r,
              n_pair:        edge.n_pair,
              same_topic:    meta && meta.primary_topic === focal.primary_topic,
              direction:     edge.r >= 0 ? 'positive' : 'negative',
              pct_suppressed: card.pct_move_together_suppressed || false,
            });
          }
        }
      };
      await translateBatch(parts.positiveInside, insideCategory);
      await translateBatch(parts.negativeInside, negativeRimInside);
      await translateBatch(parts.positiveBeyond, beyondCategory);
      await translateBatch(parts.negativeBeyond, negativeRimBeyond);
    }

    const responsePayload = {
      ok: true,
      feature_enabled: true,
      query,
      brief,
      resolver_path:   resolverPath,
      resolver_note:   resolverNote,
      focal_items: focalItems.map(f => ({
        item_id:         f.item_id,
        item_name:       f.item_name,
        primary_topic:   f.primary_topic,
        canonical_brand: f.canonical_brand,
        match_source:    f.match_source,
      })),
      inside_category: insideCategory,
      beyond_category: beyondCategory,
      negative_rim_inside: negativeRimInside,
      negative_rim_beyond: negativeRimBeyond,
      unmeasured,
      caveats,
    };

    await appendScratchEntry(jobId, {
      type:            'connections_beta',
      query,
      user_email:      userEmail,
      brief,
      resolver_path:   resolverPath,
      resolver_note:   resolverNote,
      focal_items:     responsePayload.focal_items,
      inside_category: insideCategory,
      beyond_category: beyondCategory,
      negative_rim_inside: negativeRimInside,
      negative_rim_beyond: negativeRimBeyond,
      unmeasured,
      caveats,
      r_internal:      rInternalLog,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(responsePayload),
    };
  } catch (e) {
    console.error('[connections-beta] handler error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
