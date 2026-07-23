/**
 * bjl-connections-beta.js — Connections (beta) endpoint.
 *
 * v2 (2026-07-23): four fixes and a skew-aware suppression, per field
 * feedback from the first live run.
 *
 * Pipeline:
 *   1. Auth + feature-flag check.
 *   2. Question-shape gate — a Haiku classifier decides whether the
 *      query is item-shaped (goes to the ledger), audience-shaped
 *      (redirects to the main tool's audience arms), or something else
 *      (redirects with a note). Prevents misrouted questions from
 *      resolving to junk, which is how the pane would lose trust in
 *      week one.
 *   3. Focal-item resolution. Two paths:
 *      a) job_id supplied — pull the decomposer_plan.home_items[] from
 *         the linked investigator run and resolve those names to
 *         item_ids via SQL exact/normalized match. This is the primary
 *         mode: connections-beside-the-finding, inheriting the
 *         investigator's already-vetted focal items. No LLM resolution.
 *      b) job_id absent — two-stage resolver. A guarded keyword
 *         shortlist (min 5-char tokens, no hyphen-split fragments)
 *         narrows bjl_items to ~30 candidates, then a Haiku call picks
 *         1-4 items that name the semantic subject of the query. The
 *         standalone form is a secondary test harness; job_id is the
 *         intended usage.
 *   4. Per focal: bjl_item_edges(item_id) for every connection, sorted
 *      by |r| desc (r stays server-side).
 *   5. Batch item-skew lookup: one SQL round trip against bjl_conn_
 *      centered to compute pct_positive per involved item. When an
 *      item's centered values are heavily one-sided (< 25% or > 75%
 *      on one side of zero), suppress pct_move_together on cards
 *      involving that item — the metric is unreliable when the
 *      distribution is skewed.
 *   6. Translate each surfaced edge via bjl_pair_plain(a, b), applying
 *      skew suppression. Correlation coefficients (r) never appear in
 *      the response payload.
 *   7. Two variants of unmeasured copy per spec: (a) item outside
 *      ledger (under 50 respondents), (b) no qualifying pair (under
 *      30 shared).
 *   8. Optional scratch log to bjl_query_jobs under key
 *      'connections_beta' when a job_id is supplied.
 *
 * Hard rule (unchanged): correlation coefficients never leave the
 * server. Every card speaks in shared answerers, pct moving together
 * (unless skew-suppressed), and Joy Index point lift.
 *
 * Auth: workbench-authenticated only.
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

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
// Job-id inheritance (Fix 2)
// ---------------------------------------------------------------------
async function fetchInvestigatorHomeItems(jobId) {
  if (!jobId) return null;
  const { data, error } = await supabase
    .from('bjl_query_jobs')
    .select('scratch')
    .eq('job_id', jobId)
    .maybeSingle();
  if (error || !data) return null;
  const scratch = Array.isArray(data.scratch) ? data.scratch : [];
  for (const entry of scratch) {
    if (entry && entry.type === 'decomposer_plan' && Array.isArray(entry.home_items)) {
      return entry.home_items.map(s => String(s || '').trim()).filter(Boolean);
    }
  }
  return null;
}

function sqlEscape(s) { return String(s).replace(/'/g, "''"); }

async function resolveNamesToItemIds(names) {
  if (!names || names.length === 0) return [];
  const uniq = Array.from(new Set(names.map(n => n.trim()).filter(Boolean)));
  if (uniq.length === 0) return [];
  const inList = uniq.map(n => `'${sqlEscape(n)}'`).join(',');
  // Exact match first; if the decomposer's names are slightly off, we
  // fall back to case-insensitive equality on trimmed name.
  const sql = `
    SELECT item_id, item_name, primary_topic, canonical_brand, is_brand, is_location
    FROM bjl_items
    WHERE item_name IN (${inList})
       OR LOWER(BTRIM(item_name)) IN (${uniq.map(n => `LOWER(BTRIM('${sqlEscape(n)}'))`).join(',')})
    LIMIT ${Math.max(uniq.length * 2, 10)}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`resolveNamesToItemIds failed: ${error.message}`);
  const rows = Array.isArray(data) ? data : [];
  return rows.map(r => ({
    item_id:         Number(r.item_id),
    item_name:       String(r.item_name),
    primary_topic:   r.primary_topic || null,
    canonical_brand: r.canonical_brand || null,
    is_brand:        !!r.is_brand,
    is_location:     !!r.is_location,
    match_source:    'investigator_home_items',
  }));
}

// ---------------------------------------------------------------------
// Two-stage resolver — guarded shortlist + Haiku picker (Fix 1)
// ---------------------------------------------------------------------

// Hard-guarded keyword filter. Enforces the spec's guards on top of
// simple ILIKE matching:
//  - Tokens under 5 characters are dropped (kills "non", "fan", "the").
//  - Hyphenated words are NOT split into fragments — the token is the
//    whole hyphenated form.
//  - Common stopwords are dropped.
// The output is a shortlist of ~30 candidate items that the Haiku
// picker then reasons over.
const RESOLVER_STOPWORDS = new Set([
  'about','after','again','against','along','among','around','because',
  'before','being','below','between','both','could','does','doing',
  'during','early','experience','experiences','feels','from','general',
  'given','going','having','including','into','likely','little','local',
  'looking','maybe','means','might','other','others','people','person',
  'perhaps','possibly','probably','question','rather','really','recently',
  'seems','shall','simple','specific','still','their','there','these',
  'thing','things','those','though','through','throughout','together',
  'toward','under','until','using','various','versus','well','were',
  'when','whether','which','while','with','within','without','would',
  'you','your','yourself',
]);

function extractGuardedTokens(query) {
  if (!query) return [];
  const raw = String(query).toLowerCase();
  // Split on whitespace, punctuation, and quotes — but NOT hyphens.
  // A hyphenated word ("non-alcoholic") stays intact so we can't
  // false-match "non" as an incidental fragment.
  const words = raw.split(/[^a-z0-9\-']+/).filter(Boolean);
  const tokens = words
    .filter(w => w.length >= 5)                 // spec guard: no <5-char tokens
    .filter(w => !RESOLVER_STOPWORDS.has(w))
    .filter(w => !/^-+$/.test(w))               // reject pure hyphens
    .map(w => w.replace(/^['-]+|['-]+$/g, '')); // trim leading/trailing hyphens+apostrophes
  return Array.from(new Set(tokens.filter(w => w.length >= 5)));
}

async function buildFocalShortlist(query) {
  const tokens = extractGuardedTokens(query);
  if (tokens.length === 0) return [];
  const orConds = tokens.map(t =>
    `(LOWER(item_name) LIKE '%${sqlEscape(t)}%' OR LOWER(COALESCE(canonical_brand, '')) LIKE '%${sqlEscape(t)}%')`
  ).join(' OR ');
  const scoreExpr = tokens.map(t =>
    `(CASE WHEN LOWER(item_name) LIKE '%${sqlEscape(t)}%' OR LOWER(COALESCE(canonical_brand, '')) LIKE '%${sqlEscape(t)}%' THEN 1 ELSE 0 END)`
  ).join(' + ');
  // DISTINCT ON collapses duplicates by name (the corpus carries several
  // items named "Sports", "Entertainment", "enjoy", etc. — deduping keeps
  // the shortlist informative). Tiebreak prefers LONGER names on ties:
  // "GOING TO A GAME of your favorite sports team" carries more semantic
  // content than the single word "Sports", so on a one-token hit it should
  // outrank the short duplicate. LIMIT 60 gives the Haiku picker enough
  // room to see the specific descriptive items even when many short
  // generic items also match one token.
  const sql = `
    WITH matches AS (
      SELECT DISTINCT ON (LOWER(item_name))
             item_id, item_name, primary_topic, canonical_brand, is_brand, is_location,
             (${scoreExpr})::int AS hit_count,
             CHAR_LENGTH(item_name) AS name_len
      FROM bjl_items
      WHERE ${orConds}
      ORDER BY LOWER(item_name), item_id
    )
    SELECT item_id, item_name, primary_topic, canonical_brand, is_brand, is_location, hit_count
    FROM matches
    ORDER BY hit_count DESC, name_len DESC
    LIMIT 60
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`shortlist failed: ${error.message}`);
  return (Array.isArray(data) ? data : []).map(r => ({
    item_id:         Number(r.item_id),
    item_name:       String(r.item_name),
    primary_topic:   r.primary_topic || null,
    canonical_brand: r.canonical_brand || null,
    is_brand:        !!r.is_brand,
    is_location:     !!r.is_location,
  }));
}

async function pickFocalItemsWithHaiku(query, shortlist) {
  if (shortlist.length === 0) return { picks: [], reason: 'shortlist empty' };

  const candidates = shortlist.map(c =>
    `${c.item_id}: "${c.item_name}"${c.primary_topic ? ` [${c.primary_topic}]` : ''}${c.canonical_brand ? ` (brand: ${c.canonical_brand})` : ''}`
  ).join('\n');

  const system = `You are choosing which items in the corpus best NAME THE SEMANTIC SUBJECT of a strategist's query, for a connectivity read.

You get a query and a numbered candidate list from the corpus (each item is "id: name [topic] (brand)"). Return a JSON object:
  {
    "picks": [<item_id>, ...],   // 0 to 4 item_ids that name what the query is really asking about
    "reason": "one short sentence"
  }

Rules:
- Pick 1 to 4 items MAX. Prefer 1-3 unless the corpus clearly carries the same subject under multiple framings (e.g. theme parks appear as several trip-type items).
- The item must be the SEMANTIC SUBJECT of the query, not an incidental token match. If the query is "what do fans enjoy," an item called "non" (with 'fans' incidentally elsewhere) is wrong. If the query is "theme parks," "A THEME PARK trip" is right; "Visiting a HISTORY MUSEUM" is wrong even if 'trip' matches.
- If no candidate is a real semantic match, return empty picks with a reason.
- Do NOT invent item_ids that aren't in the candidate list.

Output ONLY the JSON, no preamble.`;

  const userMessage = `Query: ${query}\n\nCandidates:\n${candidates}`;

  try {
    const rsp = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 400,
      system: [{ type: 'text', text: system }],
      messages: [{ role: 'user', content: userMessage }],
    });
    const text = (rsp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const idsRaw = Array.isArray(parsed.picks) ? parsed.picks : [];
    const validIds = new Set(shortlist.map(c => c.item_id));
    const picks = idsRaw
      .map(Number)
      .filter(id => Number.isFinite(id) && validIds.has(id))
      .slice(0, 4);
    return { picks, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  } catch (e) {
    console.warn('[connections-beta] Haiku picker failed:', e.message);
    return { picks: [], reason: `picker failed: ${e.message}` };
  }
}

async function resolveFocalItemsFromQuery(query) {
  const shortlist = await buildFocalShortlist(query);
  const picked = await pickFocalItemsWithHaiku(query, shortlist);
  if (picked.picks.length === 0) return { focals: [], resolver_note: picked.reason };
  const byId = new Map(shortlist.map(c => [c.item_id, c]));
  const focals = picked.picks
    .map(id => byId.get(id))
    .filter(Boolean)
    .map(c => ({ ...c, match_source: 'name' }));
  return { focals, resolver_note: picked.reason };
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
    // No shape gate. Any query the strategist types goes to the resolver
    // (v2 shape-gate approach was removed 2026-07-23 as over-blocking —
    // it redirected direct instructions like "run what connects with
    // being a fan" because the enclosing sentence had comparison
    // framing). The guarded two-stage resolver is the honest filter:
    // if there is a semantic subject to resolve, run the ledger on it;
    // if there isn't, the empty-focals response carries a soft hint
    // toward Intelligence for audience-shaped questions.

    // Fix 2: prefer investigator-derived focal items when a job_id is
    // supplied. The decomposer has already done the semantic work of
    // choosing home_items; skip Haiku resolution.
    let focalItems = [];
    let resolverPath = null;
    let resolverNote = null;

    if (jobId) {
      const invNames = await fetchInvestigatorHomeItems(jobId);
      if (invNames && invNames.length > 0) {
        focalItems = await resolveNamesToItemIds(invNames);
        resolverPath = 'investigator_home_items';
        if (focalItems.length === 0) {
          resolverNote = `Job ${jobId} had ${invNames.length} home_items but none resolved to bjl_items rows — likely a mismatch between the investigator's item names and the canonical bjl_items.item_name.`;
        }
      }
    }

    // Fix 1: two-stage resolver as the fallback path. Guarded shortlist
    // (min 5-char tokens, no hyphen-split fragments) then Haiku picker
    // on semantic subject.
    if (focalItems.length === 0) {
      const r = await resolveFocalItemsFromQuery(query);
      focalItems = r.focals;
      resolverPath = resolverPath || 'query_text_two_stage';
      resolverNote = r.resolver_note;
    }

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
          detail: 'The query did not resolve to a semantic subject in bjl_items — the resolver looked for a specific experience, brand, or category to run through the ledger and did not find one. Two things to try: (a) rephrase to name a specific experience (e.g. "going to a game", "having coffee at a cafe", "a theme park trip"), or (b) if the question is really about comparing groups of people (fans vs non-fans, Gen Z vs Boomers), that\u2019s an audience read — the main Intelligence pane\u2019s audience arms answer it. Attach an Intelligence job_id here to use its already-resolved focals.',
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
