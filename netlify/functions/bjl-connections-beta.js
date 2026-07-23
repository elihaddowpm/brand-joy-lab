/**
 * bjl-connections-beta.js — Connections (beta) endpoint.
 *
 * A staff-only beta surface that reads the within-person centered joy
 * correlation ledger (bjl_connectivity_ledger, 53,558 pairs) and
 * translates edges into strategist-facing cards via bjl_pair_plain.
 *
 * The pipeline:
 *   1. Auth + feature-flag check (small hardcoded email allowlist for MVP).
 *   2. Resolve focal items from the query — SQL keyword match against
 *      bjl_items.item_name and canonical_brand, ranked by match hits.
 *   3. Per focal item: pull edges via bjl_item_edges(item_id).
 *   4. Group each item's edges into "inside_category" (same primary_topic
 *      as focal) vs "beyond_category" (different topics), ranked by |r|
 *      internally. r itself never leaves the server.
 *   5. For each surfaced edge (top N inside + top N beyond, plus the
 *      negative-rim subsections): call bjl_pair_plain(a, b) for the
 *      client-safe numbers (shared_answerers, pct_move_together,
 *      lift_points).
 *   6. Attach edge-diversity caveats when a focal item has fewer than
 *      50 edges in the ledger.
 *   7. Optionally scratch-log to bjl_query_jobs under key
 *      'connections_beta' when a job_id is supplied.
 *
 * Hard rule: correlation coefficients (r) never appear in the response
 * payload. They're used internally to rank; they never render. Every
 * displayed connection speaks in shared answerers, pct moving together,
 * and Joy Index point lift.
 *
 * Auth: workbench-authenticated only.
 *
 * POST /bjl-connections-beta
 *   body:  { query: string, job_id?: uuid, max_focal_items?: int }
 *   200:   { ok, feature_enabled, focal_items[], inside_category[],
 *            beyond_category[], negative_rim_inside[],
 *            negative_rim_beyond[], unmeasured[], caveats[] }
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Feature-flag allowlist. MVP hardcoded; move to
// bjl_authorized_users.features_enabled in a follow-up if the beta pans out.
const CONNECTIONS_BETA_ALLOWLIST = new Set([
  'haddowe@peteramayer.com',
  'edelmanm@peteramayer.com',
]);

// Section sizes for what surfaces to the client.
const INSIDE_MAX_POSITIVE   = 6;
const INSIDE_MAX_NEGATIVE   = 3;
const BEYOND_MAX_POSITIVE   = 8;
const BEYOND_MAX_NEGATIVE   = 3;
const EDGE_DIVERSITY_FLOOR  = 50;   // caveat threshold on total edge count per focal item

const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','by','can','could','do','does','for','from',
  'has','have','how','in','is','it','its','of','on','or','so','that','the','this',
  'to','was','were','what','when','where','which','who','why','with','you','your',
  'my','our','we','us','they','their','if','but','not','no','all','any','also',
  'joy','joyful','people','person','brand','brands','brought','bring','shows','show',
  'about','get','give','tell','into','onto','over','under','more','most','some',
  'like','would','should','than','then','them','these','those','other',
]);

function tokenizeQuery(query) {
  const words = String(query || '').toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  return Array.from(new Set(words.filter(w => w.length >= 3 && !STOPWORDS.has(w))));
}

function sqlEscape(s) {
  return String(s).replace(/'/g, "''");
}

// Focal-item resolver. SQL keyword matching against item_name + canonical_brand,
// scored by number of query tokens that hit anywhere in the name. Prefer
// shorter, more-specific names on ties so 'A THEME PARK trip' outranks
// 'Visiting a THEME PARK or amusement park' when both hit.
async function resolveFocalItems(query, maxFocalItems) {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  const limitN = Math.max(1, Math.min(maxFocalItems || 5, 12));
  const orConds = tokens.map(t =>
    `(LOWER(item_name) LIKE '%${sqlEscape(t)}%' OR LOWER(COALESCE(canonical_brand, '')) LIKE '%${sqlEscape(t)}%')`
  ).join(' OR ');
  const scoreExpr = tokens.map(t =>
    `(CASE WHEN LOWER(item_name) LIKE '%${sqlEscape(t)}%' OR LOWER(COALESCE(canonical_brand, '')) LIKE '%${sqlEscape(t)}%' THEN 1 ELSE 0 END)`
  ).join(' + ');

  const sql = `
    SELECT item_id, item_name, primary_topic, canonical_brand, is_brand, is_location,
           (${scoreExpr})::int AS hit_count,
           CHAR_LENGTH(item_name) AS name_len
    FROM bjl_items
    WHERE ${orConds}
    ORDER BY hit_count DESC, name_len ASC
    LIMIT ${limitN}
  `;

  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`focal resolve failed: ${error.message}`);
  const rows = Array.isArray(data) ? data : [];

  // Only keep matches that share at least 1 token — the LIMIT + hit_count
  // ordering already ensures this, but guard defensively.
  return rows
    .filter(r => Number(r.hit_count) >= 1)
    .map(r => ({
      item_id:         Number(r.item_id),
      item_name:       String(r.item_name),
      primary_topic:   r.primary_topic || null,
      canonical_brand: r.canonical_brand || null,
      is_brand:        !!r.is_brand,
      is_location:     !!r.is_location,
      match_source:    r.canonical_brand ? 'brand' : 'name',
    }));
}

// Pull all edges for a focal item. Returns rows sorted by |r| desc.
async function fetchEdges(focalItemId) {
  const { data, error } = await supabase.rpc('bjl_item_edges', { p_item: focalItemId });
  if (error) throw new Error(`bjl_item_edges failed for item ${focalItemId}: ${error.message}`);
  const rows = Array.isArray(data) ? data : [];
  // Sort by |r| desc; ties broken by n_pair desc.
  return rows
    .map(r => ({
      other_item: Number(r.other_item),
      n_pair:     Number(r.n_pair),
      r:          Number(r.r),
      abs_r:      Math.abs(Number(r.r)),
    }))
    .sort((a, b) => (b.abs_r - a.abs_r) || (b.n_pair - a.n_pair));
}

// Look up primary_topic + item_name for a batch of item_ids in one round trip.
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

// Translate a ranked edge into the client-safe card via bjl_pair_plain.
// The r value stays inside; only the plain numbers leave.
async function translateEdge(focal, edge, otherMeta) {
  const [a, b] = focal.item_id < edge.other_item
    ? [focal.item_id, edge.other_item]
    : [edge.other_item, focal.item_id];
  const { data, error } = await supabase.rpc('bjl_pair_plain', { p_item_a: a, p_item_b: b });
  if (error) throw new Error(`bjl_pair_plain failed for (${a}, ${b}): ${error.message}`);
  const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
  if (!row) return null;
  return {
    focal_item_id:      focal.item_id,
    focal_item_name:    focal.item_name,
    focal_primary_topic: focal.primary_topic,
    other_item_id:      edge.other_item,
    other_item_name:    otherMeta ? otherMeta.item_name : null,
    other_primary_topic: otherMeta ? otherMeta.primary_topic : null,
    direction:          edge.r >= 0 ? 'rises with' : 'runs against',
    shared_answerers:   Number(row.shared_answerers),
    pct_move_together:  row.pct_move_together == null ? null : Math.round(Number(row.pct_move_together)),
    lift_points:        row.lift_points == null ? null : Math.round(Number(row.lift_points) * 10) / 10,
  };
}

// Split edges into inside/beyond by primary_topic; select top-N positive
// and top-N negative in each. r stays internal — only the ranking uses it.
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

// Append a connections_beta entry to a job's scratch array. Non-blocking
// on error — the endpoint's success shouldn't depend on scratch write.
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

  // Not on the allowlist — return a 200 with feature_enabled=false so the
  // frontend can render a "not available" state without treating this as
  // an error.
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
  const maxFocalItems = Number.isFinite(body.max_focal_items) ? body.max_focal_items : 5;

  try {
    const focalItems = await resolveFocalItems(query, maxFocalItems);
    if (focalItems.length === 0) {
      const empty = {
        ok: true,
        feature_enabled: true,
        query,
        focal_items: [],
        inside_category: [],
        beyond_category: [],
        negative_rim_inside: [],
        negative_rim_beyond: [],
        unmeasured: [{
          reason: 'no_focal_items_resolved',
          detail: 'The query did not match any items in bjl_items by keyword. Try a more specific brand, category, or experience name.',
        }],
        caveats: [],
      };
      await appendScratchEntry(jobId, { type: 'connections_beta', ...empty });
      return { statusCode: 200, body: JSON.stringify(empty) };
    }

    // Per-focal edge fetch + partitioning + translation.
    const insideCategory     = [];
    const beyondCategory     = [];
    const negativeRimInside  = [];
    const negativeRimBeyond  = [];
    const unmeasured         = [];
    const caveats            = [];
    const rInternalLog       = [];   // stays in scratch, never returned to client-facing render logic

    for (const focal of focalItems) {
      const edges = await fetchEdges(focal.item_id);
      if (edges.length === 0) {
        unmeasured.push({
          focal_item_id:   focal.item_id,
          focal_item_name: focal.item_name,
          reason:          'no_edges_in_ledger',
          detail:          'This item is outside the connectivity ledger (fewer than 50 shared respondents on any pair). Unmeasured — candidate for co-fielding.',
        });
        continue;
      }
      if (edges.length < EDGE_DIVERSITY_FLOOR) {
        caveats.push({
          focal_item_id:   focal.item_id,
          focal_item_name: focal.item_name,
          edge_count:      edges.length,
          warning:         'edge_diversity_low',
          detail:          `Only ${edges.length} edges in the ledger for this item — its neighborhood may all come from one co-fielding module. Treat cross-category connections here with extra care.`,
        });
      }

      // Batch meta lookup for every other_item on this focal's edges
      // (before partition — we need primary_topic to split inside vs
      // beyond).
      const otherIds = edges.map(e => e.other_item);
      const metaById = await fetchItemMeta(otherIds);
      const parts = partitionEdges(focal, edges, metaById);

      // Translate each kept edge via bjl_pair_plain. r stays out of the
      // response but is captured for the internal scratch log.
      const translateBatch = async (bucket, targetArr) => {
        for (const edge of bucket) {
          const meta = metaById.get(edge.other_item) || null;
          const card = await translateEdge(focal, edge, meta);
          if (card) {
            targetArr.push(card);
            rInternalLog.push({
              focal_item_id:   focal.item_id,
              other_item_id:   edge.other_item,
              r:               edge.r,
              n_pair:          edge.n_pair,
              same_topic:      meta && meta.primary_topic === focal.primary_topic,
              direction:       edge.r >= 0 ? 'positive' : 'negative',
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

    // Scratch log — includes the internal r values used for ranking,
    // per the spec's "log per job" requirement.
    await appendScratchEntry(jobId, {
      type:             'connections_beta',
      query,
      user_email:       userEmail,
      focal_items:      responsePayload.focal_items,
      inside_category:  insideCategory,
      beyond_category:  beyondCategory,
      negative_rim_inside: negativeRimInside,
      negative_rim_beyond: negativeRimBeyond,
      unmeasured,
      caveats,
      r_internal:       rInternalLog,   // internal-only; never returned to the client render
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
