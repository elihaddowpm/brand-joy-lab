/**
 * bjl-front-door.js — unified query understanding for all BJL surfaces.
 *
 * One function, one brief. Every surface (investigator, public tool,
 * connections pane) calls the same front door; nobody re-implements
 * query understanding at the edge. Restores the decomposer principle:
 * reasoning at the front, v2 arms behind it for confirmation and
 * quantification.
 *
 * This file ships Steps 1 and 2 of the front-door migration:
 *   Step 1: shape classification + entity resolution (connections pane
 *           consumer).
 *   Step 2: capability computation — ledger_degree + verbatim_depth
 *           per resolved item plus a rolled-up verdict. Two batch
 *           SQL calls; no per-item round trips. Consumers read
 *           brief.capability rather than re-running the coverage math
 *           per surface.
 * Route (Step 3) is stubbed in the brief schema so consumers can read
 * it defensively; it populates in a later PR.
 *
 * Contract:
 *   const brief = await bjlFrontDoor(query, context);
 * Input:
 *   query    string  — user's raw question
 *   context  object  — { surface: 'connections'|'investigator'|'public',
 *                        session_history?: [], prior_job_id?: uuid,
 *                        extra_context?: object, user_email?: string }
 * Output: the brief JSON per the spec's schema.
 *
 * The module also exposes a Netlify HTTP handler at the bottom so a
 * frontend can call the front door directly (e.g. for the connections
 * pane's standalone entry path) — auth required. Non-HTTP callers
 * (require()'d from another Netlify function) skip auth; they assume
 * the caller already authenticated.
 */

const Anthropic = require('@anthropic-ai/sdk').default;
const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// Every shape recognized by the front door. Keep in sync with the spec's
// brief schema. Shape names are stable strings — consumers switch on them.
const KNOWN_SHAPES = new Set([
  'item_connection',
  'audience_comparison',
  'brand_lookup',
  'territory_read',
  'data_pull',
  'outreach_angle',
  'out_of_scope',
  'needs_clarification',
]);

// Shapes that require at least one resolvable entity to be actionable.
// If a shape below returns zero entities after resolution, the front
// door escalates to needs_clarification with a specific ask — never a
// guess, per Regression Test 4.
const SHAPES_REQUIRING_ENTITIES = new Set([
  'item_connection',
  'audience_comparison',
  'brand_lookup',
]);

// ---------------------------------------------------------------------
// Decision 1: Shape
// ---------------------------------------------------------------------

function sqlEscape(s) { return String(s).replace(/'/g, "''"); }

async function classifyShape(query, context) {
  const surface = (context && context.surface) || null;
  // Surface-specific default. The connections pane's whole purpose is
  // "what connects to X" — a bare item, brand, or experience typed
  // into it is by convention a connection query, not an ambiguous
  // ask. Without this bias, log ids 4-7 in bjl_front_door_log show
  // the classifier over-escalating bare inputs ("Mcdonalds", "Being
  // a fan of something", "Going to a fast food restaurant") to
  // needs_clarification, forcing a three-retry burst on a surface
  // that could have just run the ledger.
  const surfaceHint = surface === 'connections'
    ? `\nCalling surface: connections
CONNECTIONS-SURFACE DEFAULT: this pane runs the within-person connectivity ledger on a specific item or brand. A bare noun phrase typed here means "what connects to it" — classify bare items/experiences as item_connection and bare brand names as brand_lookup. Do NOT escalate to needs_clarification for a bare item, bare brand, or a query missing only a verb; the surface default supplies the verb. Reserve needs_clarification for pronouns without antecedents, meta questions about the tool, or genuinely empty asks.`
    : surface
    ? `\nCalling surface: ${surface}`
    : '';
  const system = `You classify a strategist's query into ONE shape for the BJL front door. Every downstream surface reads the shape and gates behavior on it, so misclassification cascades.

Shapes (choose exactly one):
- item_connection: Asks what travels with, connects to, moves with, or against a specific experience, brand, or category, INSIDE the same people. "What connects to going to a theme park?" "How does joy from wine spread to other things?" "What travels with being a fan?" IMPORTANT: "what do people who love X also love" IS item_connection (one focal, no groups compared).
- audience_comparison: Compares two or more groups of people, named or implied. "What do fans enjoy more than non-fans?" "How does Gen Z differ from Boomers on X?" "Is the QSR audience more brand-loyal than the fast-casual audience?" Signal is a comparator ("more than", "vs", "differ") between groups.
- brand_lookup: Asks about a specific named brand's standing, emotional read, or performance. "Tell me about Silver Dollar City" "How is Cox performing?" "What do people feel about Chick-fil-A?" Signal is a named real brand plus a request for its read.
- territory_read: Asks about an emotional territory, theme, or whitespace — not a specific item. "What territories are underexplored in theme parks?" "Where's the whitespace in NA beer?" "What emotional angles haven't we mined in banking?"
- data_pull: Requests raw data or specific stats — not interpretation. "List all joy scores above 60" "Show me the Q3 numbers" "Give me the top 10 items in food_beverage."
- outreach_angle: Asks for a cold-email or client-facing angle. "What's my angle for pitching X?" "Write me a cold email to Y."
- out_of_scope: Weather, coding, arithmetic, tool navigation, meta questions. Nothing to do with joy, brands, or the corpus.
- needs_clarification: Query is too vague, ambiguous, or missing critical info to resolve without asking a follow-up. "Tell me about that." "What did we decide?" "Can you dig into it?" — pronouns without antecedents, missing subject, ambiguous scope.

Return ONLY this JSON, no preamble:
{
  "shape": "<one of the shapes above>",
  "shape_reasoning": "one sentence naming the signal that decided it",
  "clarifying_question": "populated only when shape is needs_clarification — a specific question the tool should ask"
}${surfaceHint}`;

  try {
    const rsp = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 300,
      system: [{ type: 'text', text: system }],
      messages: [{ role: 'user', content: query }],
    });
    const text = (rsp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const shape = KNOWN_SHAPES.has(parsed.shape) ? parsed.shape : 'item_connection';
    return {
      shape,
      shape_reasoning: typeof parsed.shape_reasoning === 'string' ? parsed.shape_reasoning : '',
      clarifying_question: (shape === 'needs_clarification' && typeof parsed.clarifying_question === 'string')
        ? parsed.clarifying_question
        : null,
    };
  } catch (e) {
    // Fail toward item_connection so the downstream resolver at least
    // tries; the shape_reasoning names the failure so scratch can audit.
    console.warn('[front-door] shape classify failed, defaulting to item_connection:', e.message);
    return { shape: 'item_connection', shape_reasoning: `Classifier failed (${e.message}); defaulted.`, clarifying_question: null };
  }
}

// ---------------------------------------------------------------------
// Decision 2: Entities
// ---------------------------------------------------------------------

// Haiku Stage 0 — extract search phrases from the query in natural
// corpus wording. Same shape as the connections-beta extractor, but
// aware of the shape so it can lean the right way (brand lookup wants
// brand phrases; territory read wants tension/mode names).
async function extractSearchTerms(query, shape) {
  const shapeHint = shape === 'brand_lookup'
    ? '\n\nThis is a brand_lookup query. Prefer brand-name phrases; the corpus stores named brands as their canonical name in the item_name and canonical_brand columns.'
    : shape === 'audience_comparison'
    ? '\n\nThis is an audience_comparison query. Extract phrases that name the ANCHOR EXPERIENCES for the audiences being compared (e.g. for "fans vs non-fans", the anchor is "sports team" / "attending a game" / "sports fan"; for "Gen Z vs Boomer QSR customers", the anchor is "QSR" / "fast food").'
    : shape === 'territory_read'
    ? '\n\nThis is a territory_read query. Extract phrases that name the territory or category itself (theme parks, NA beer, banking) — not individual items.'
    : '';
  const system = `Given a strategist's query, extract 2-5 short phrases (each 1-6 words) that name the specific experiences, brands, or categories the query is asking about. These phrases will search bjl_items via case-insensitive substring match, so use natural corpus wording — the phrasing that would actually appear inside real item names.

Examples:
Query: "What connects with being a fan or attending a game?"
["sports team","attending a game","sports fan","sports","game"]

Query: "How does joy from a theme park spread to other categories?"
["theme park","amusement park","theme park trip"]

Query: "Tell me about Silver Dollar City"
["Silver Dollar City","Silver Dollar"]

Query: "Where's the whitespace in NA beer?"
["non-alcoholic beer","NA beer","non-alcoholic","alcohol-free beer"]

Rules:
- Return 2-5 phrases.
- Each phrase 1-6 words.
- Use natural corpus wording ("attending a game", not "game attendance").
- Include short single-word forms alongside longer phrases when both would help match.
- If the query names a specific brand, include the brand as one phrase verbatim.
- If the query is very vague, do your best with the strongest 2 phrases.

Return ONLY a JSON array of strings, no preamble.${shapeHint}`;

  try {
    const rsp = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 300,
      system: [{ type: 'text', text: system }],
      messages: [{ role: 'user', content: query }],
    });
    const text = (rsp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(s => String(s || '').trim())
      .filter(s => s.length >= 2 && s.length <= 60)
      .slice(0, 6);
  } catch (e) {
    console.warn('[front-door] concept extractor failed:', e.message);
    return [];
  }
}

async function buildCandidateShortlist(terms) {
  if (terms.length === 0) return [];
  const orConds = terms.map(t =>
    `(LOWER(item_name) LIKE '%${sqlEscape(t.toLowerCase())}%' OR LOWER(COALESCE(canonical_brand, '')) LIKE '%${sqlEscape(t.toLowerCase())}%')`
  ).join(' OR ');
  const scoreExpr = terms.map(t =>
    `(CASE WHEN LOWER(item_name) LIKE '%${sqlEscape(t.toLowerCase())}%' OR LOWER(COALESCE(canonical_brand, '')) LIKE '%${sqlEscape(t.toLowerCase())}%' THEN 1 ELSE 0 END)`
  ).join(' + ');
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

// Haiku Stage 2 — semantic-subject picker. Same guarantee as before:
// only items that name the semantic subject reach the ledger. Rejects
// incidental matches ("non" on a query about non-fans).
async function pickSemanticSubjects(query, shape, shortlist) {
  if (shortlist.length === 0) return { picks: [], reason: 'shortlist empty' };
  const candidates = shortlist.map(c =>
    `${c.item_id}: "${c.item_name}"${c.primary_topic ? ` [${c.primary_topic}]` : ''}${c.canonical_brand ? ` (brand: ${c.canonical_brand})` : ''}`
  ).join('\n');
  const shapeGuide = shape === 'brand_lookup'
    ? 'This is a brand_lookup — prefer items whose canonical_brand matches the named brand.'
    : shape === 'audience_comparison'
    ? 'This is an audience_comparison — pick anchor items that define the audience being compared (e.g. sports team / attending a game items for "fans vs non-fans").'
    : shape === 'territory_read'
    ? 'This is a territory_read — pick 1-2 items that best anchor the territory; more is worse than fewer here.'
    : 'Pick items that name what the query is really asking about.';

  const system = `You are choosing which items in the corpus best NAME THE SEMANTIC SUBJECT of a strategist's query. Return a JSON object:
{
  "picks": [<item_id>, ...],
  "reason": "one short sentence",
  "confidence": "high" | "medium" | "low"
}

Rules:
- 0 to 4 picks. Prefer 1-3 unless the corpus clearly carries the same subject under multiple framings.
- The item must be the SEMANTIC SUBJECT of the query, not an incidental token match. An item literally named "non" on a query about non-fans is wrong; an item named "Silver Dollar" is right for a Silver Dollar City query.
- ${shapeGuide}
- confidence:
    high = the item(s) clearly name the query's subject
    medium = plausible but partial match; the query might have meant a slightly different framing
    low = weak match; consider returning empty picks instead
- If nothing in the candidate list is a real semantic match, return empty picks with a reason. Below-medium confidence should return empty; the caller escalates to clarification rather than surface a guess.
- Do NOT invent item_ids that aren't in the candidate list.

Output ONLY the JSON, no preamble.`;

  try {
    const rsp = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 400,
      system: [{ type: 'text', text: system }],
      messages: [{ role: 'user', content: `Query: ${query}\n\nCandidates:\n${candidates}` }],
    });
    const text = (rsp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const idsRaw = Array.isArray(parsed.picks) ? parsed.picks : [];
    const validIds = new Set(shortlist.map(c => c.item_id));
    const confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium';
    // Below-medium confidence resolves to none, per spec.
    const picks = confidence === 'low'
      ? []
      : idsRaw.map(Number).filter(id => Number.isFinite(id) && validIds.has(id)).slice(0, 4);
    return {
      picks,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      confidence: picks.length === 0 ? 'low' : confidence,
    };
  } catch (e) {
    console.warn('[front-door] semantic picker failed:', e.message);
    return { picks: [], reason: `picker failed: ${e.message}`, confidence: 'low' };
  }
}

// Job-id inheritance. When a caller passes context.prior_job_id (e.g.
// the connections pane opened beside an investigator finding), the
// front door short-circuits entity resolution by reading the linked
// investigator run's decomposer_plan.home_items and looking them up
// against bjl_items. This gives connections-beside-the-finding the
// investigator's already-vetted focal items — no Haiku round trip,
// no risk of the resolver picking different focals than the finding
// was built on.
async function fetchInheritedItems(jobId) {
  if (!jobId) return [];
  const { data, error } = await supabase
    .from('bjl_query_jobs')
    .select('scratch')
    .eq('job_id', jobId)
    .maybeSingle();
  if (error || !data) return [];
  const scratch = Array.isArray(data.scratch) ? data.scratch : [];
  let names = [];
  for (const entry of scratch) {
    if (entry && entry.type === 'decomposer_plan' && Array.isArray(entry.home_items)) {
      names = entry.home_items.map(s => String(s || '').trim()).filter(Boolean);
      break;
    }
  }
  if (names.length === 0) return [];
  const uniq = Array.from(new Set(names));
  const inList = uniq.map(n => `'${sqlEscape(n)}'`).join(',');
  const normList = uniq.map(n => `LOWER(BTRIM('${sqlEscape(n)}'))`).join(',');
  const sql = `
    SELECT item_id, item_name, primary_topic, canonical_brand, is_brand, is_location
    FROM bjl_items
    WHERE item_name IN (${inList})
       OR LOWER(BTRIM(item_name)) IN (${normList})
    LIMIT ${Math.max(uniq.length * 2, 10)}
  `;
  const { data: rows, error: e2 } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (e2) throw new Error(`prior-job item lookup failed: ${e2.message}`);
  return (Array.isArray(rows) ? rows : []).map(r => ({
    item_id:       Number(r.item_id),
    item_name:     String(r.item_name),
    primary_topic: r.primary_topic || null,
    match_basis:   'inherited_job',
    confidence:    'high',
  }));
}

async function resolveEntities(query, shape, context) {
  const empty = { items: [], brands: [], audiences: [], topics: [], resolver_note: null };
  if (shape === 'out_of_scope' || shape === 'needs_clarification') return empty;

  // Job-id inheritance path. If the caller supplied a prior_job_id and
  // that job carries a decomposer_plan.home_items list, use those items
  // and skip Haiku resolution entirely. Applies to any shape that
  // benefits from item focals.
  const priorJobId = context && context.prior_job_id ? String(context.prior_job_id).trim() : null;
  if (priorJobId && shape !== 'audience_comparison') {
    const inherited = await fetchInheritedItems(priorJobId);
    if (inherited.length > 0) {
      const topics = Array.from(new Set(inherited.map(i => i.primary_topic).filter(Boolean)));
      return {
        items: inherited,
        brands: [],
        audiences: [],
        topics,
        resolver_note: `Inherited ${inherited.length} focal item(s) from prior job ${priorJobId}.`,
      };
    }
  }

  // Terms → shortlist → semantic picker. Same three-stage as the
  // connections-beta resolver's current shape.
  const terms = await extractSearchTerms(query, shape);
  if (terms.length === 0) {
    return { ...empty, resolver_note: 'Concept extractor returned no search terms.' };
  }
  const shortlist = await buildCandidateShortlist(terms);
  if (shortlist.length === 0) {
    return {
      ...empty,
      resolver_note: `Extracted terms [${terms.join(', ')}] but nothing in bjl_items matched.`,
    };
  }
  const picked = await pickSemanticSubjects(query, shape, shortlist);
  if (picked.picks.length === 0) {
    return {
      ...empty,
      resolver_note: `Extracted [${terms.join(', ')}]; ${shortlist.length} candidates; picker rejected all: ${picked.reason}`,
    };
  }
  const byId = new Map(shortlist.map(c => [c.item_id, c]));
  const items = picked.picks
    .map(id => byId.get(id))
    .filter(Boolean)
    .map(c => ({
      item_id:      c.item_id,
      item_name:    c.item_name,
      primary_topic: c.primary_topic,
      match_basis:  'reasoning',    // 'reasoning' | 'embedding' (embedding not wired in Step 1)
      confidence:   picked.confidence,
    }));

  // Brands: any picked item that is_brand or has a canonical_brand.
  const brandsByName = new Map();
  for (const c of picked.picks.map(id => byId.get(id)).filter(Boolean)) {
    if (c.canonical_brand) {
      if (!brandsByName.has(c.canonical_brand)) {
        brandsByName.set(c.canonical_brand, { canonical_brand: c.canonical_brand, item_ids: [] });
      }
      brandsByName.get(c.canonical_brand).item_ids.push(c.item_id);
    }
  }
  const brands = Array.from(brandsByName.values());

  // Audiences: for audience_comparison, the picked items ARE the
  // anchor items. Cohort size estimation is a Step-2 (capability)
  // concern; leave est_cohort_n null here.
  const audiences = shape === 'audience_comparison'
    ? [{
        description: `Audience anchored by preference for: ${items.map(i => i.item_name).join(', ')}`,
        anchor_item_ids: items.map(i => i.item_id),
        est_cohort_n: null,
      }]
    : [];

  // Topics: primary_topics of the picked items.
  const topics = Array.from(new Set(items.map(i => i.primary_topic).filter(Boolean)));

  return {
    items,
    brands,
    audiences,
    topics,
    resolver_note: `Extracted [${terms.join(', ')}] via Haiku; ${shortlist.length} candidates; picker selected ${items.length} with ${picked.confidence} confidence. ${picked.reason}`,
  };
}

// ---------------------------------------------------------------------
// Decision 3: Capability
// ---------------------------------------------------------------------
// Two thresholds set from the connections pane's live behavior. The
// pane's own EDGE_DIVERSITY_FLOOR (50) is the boundary between "we
// can read this item's neighborhood confidently" and "this item's
// edges may all come from one co-fielding module — treat cross-
// category reads with care." Verbatim depth uses looser tiers because
// the corpus is deep; 100 shared answerers' verbatims is comfortably
// "measurable" for a qualitative texture read.
const LEDGER_MEASURABLE = 50;
const VERBATIM_MEASURABLE = 100;
const VERBATIM_THIN = 20;

// One batch call per metric. When entities.items is empty, returns
// a stub verdict (no items → nothing to measure) so downstream can
// still switch on capability shape.
async function computeCapability(entities) {
  const items = Array.isArray(entities && entities.items) ? entities.items : [];
  if (items.length === 0) {
    return {
      ledger_degree: {},
      verbatim_depth: {},
      verdict: 'unmeasured',
      unmeasured_detail: 'No items resolved; nothing to measure.',
    };
  }
  const ids = items.map(i => Number(i.item_id)).filter(Number.isFinite);
  if (ids.length === 0) {
    return {
      ledger_degree: {},
      verbatim_depth: {},
      verdict: 'unmeasured',
      unmeasured_detail: 'Resolved items had no numeric ids.',
    };
  }
  const idList = ids.join(',');

  // ledger_degree — count of ledger rows mentioning each item on
  // either side. Single scan; no per-item round trip.
  const ledgerSql = `
    WITH ids(item_id) AS (VALUES ${ids.map(id => `(${id})`).join(',')})
    SELECT ids.item_id,
           (SELECT COUNT(*) FROM bjl_connectivity_ledger l
            WHERE l.item_a = ids.item_id OR l.item_b = ids.item_id) AS degree
    FROM ids
  `;

  // verbatim_depth — count of verbatims from respondents who
  // answered the item at all. is_selected is a multi-select flag
  // that zeroes out scale/Likert items (their raw_value carries the
  // rating instead), so we join on item_id alone. LEFT JOIN so items
  // with no responses return zero rather than dropping out.
  const verbatimSql = `
    WITH ids(item_id) AS (VALUES ${ids.map(id => `(${id})`).join(',')})
    SELECT ids.item_id, COUNT(DISTINCT v.id)::int AS depth
    FROM ids
    LEFT JOIN bjl_responses r ON r.item_id = ids.item_id
    LEFT JOIN bjl_verbatims v ON v.respondent_id = r.respondent_id
    GROUP BY ids.item_id
  `;

  const ledgerDegree = {};
  const verbatimDepth = {};
  try {
    const { data: lRows, error: lErr } = await supabase.rpc('execute_read_sql', { query_text: ledgerSql });
    if (lErr) throw new Error(`ledger_degree query: ${lErr.message}`);
    for (const row of (Array.isArray(lRows) ? lRows : [])) {
      ledgerDegree[String(row.item_id)] = Number(row.degree || 0);
    }
  } catch (e) {
    console.warn('[front-door] ledger_degree failed:', e.message);
  }
  try {
    const { data: vRows, error: vErr } = await supabase.rpc('execute_read_sql', { query_text: verbatimSql });
    if (vErr) throw new Error(`verbatim_depth query: ${vErr.message}`);
    for (const row of (Array.isArray(vRows) ? vRows : [])) {
      verbatimDepth[String(row.item_id)] = Number(row.depth || 0);
    }
  } catch (e) {
    console.warn('[front-door] verbatim_depth failed:', e.message);
  }

  // Rollup verdict — best-case across resolved items. If ANY item
  // clears both floors, the query is measurable. If any has any
  // ledger presence at all, it's thin. Otherwise unmeasured.
  let maxLedger = 0, maxVerbatim = 0;
  for (const id of ids) {
    const l = ledgerDegree[String(id)] || 0;
    const v = verbatimDepth[String(id)] || 0;
    if (l > maxLedger) maxLedger = l;
    if (v > maxVerbatim) maxVerbatim = v;
  }
  let verdict, unmeasuredDetail = null;
  if (maxLedger >= LEDGER_MEASURABLE || maxVerbatim >= VERBATIM_MEASURABLE) {
    verdict = 'measurable';
  } else if (maxLedger > 0 || maxVerbatim >= VERBATIM_THIN) {
    verdict = 'thin';
    unmeasuredDetail = `Best-case coverage across resolved items: ${maxLedger} ledger edges, ${maxVerbatim} verbatims. Reads may be directional but under the confidence floor (${LEDGER_MEASURABLE} edges / ${VERBATIM_MEASURABLE} verbatims).`;
  } else {
    verdict = 'unmeasured';
    unmeasuredDetail = `No resolved item has ledger presence at all (max ${maxLedger} edges) and verbatim depth is below the thin floor (max ${maxVerbatim} verbatims). Candidate for co-fielding.`;
  }

  return {
    ledger_degree: ledgerDegree,
    verbatim_depth: verbatimDepth,
    verdict,
    unmeasured_detail: unmeasuredDetail,
  };
}

// Empty capability shape for shapes that never resolve items
// (out_of_scope, needs_clarification). Consumers switch on verdict.
function emptyCapability() {
  return {
    ledger_degree: {},
    verbatim_depth: {},
    verdict: 'unmeasured',
    unmeasured_detail: null,
  };
}

// ---------------------------------------------------------------------
// Decision 4 (route): stubbed in Step 1. Populates in Step 3.
// ---------------------------------------------------------------------

function emptyRoute() {
  return {
    arms: [],
    order: [],
    connections_focal_items: [],
  };
}

// ---------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------

async function logBrief(query, brief, context) {
  try {
    const surface = (context && context.surface) || null;
    const userEmail = (context && context.user_email) || null;
    // Job-attached callers (investigator with a bjl_query_jobs row) do
    // NOT log here — they persist the brief on jobs.triage_brief. This
    // log is for surface calls without a job row.
    if (context && context.prior_job_id) return;
    await supabase.from('bjl_front_door_log').insert({
      query,
      brief,
      surface,
      user_email: userEmail,
      context: context ? { surface, session_history_len: Array.isArray(context.session_history) ? context.session_history.length : 0 } : null,
    });
  } catch (e) {
    console.warn('[front-door] log write failed:', e.message);
  }
}

// ---------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------

async function bjlFrontDoor(query, context = {}) {
  const q = String(query || '').trim();
  if (!q) {
    return {
      shape: 'needs_clarification',
      shape_reasoning: 'Empty query.',
      entities: { items: [], brands: [], audiences: [], topics: [] },
      capability: emptyCapability(),
      route: emptyRoute(),
      clarifying_question: 'What would you like to ask?',
      resolver_note: null,
    };
  }

  // Decision 1: Shape.
  const shapeResult = await classifyShape(q, context);
  let { shape, shape_reasoning, clarifying_question } = shapeResult;

  // Short-circuit for shapes that never resolve entities.
  if (shape === 'out_of_scope' || shape === 'needs_clarification') {
    const brief = {
      shape,
      shape_reasoning,
      entities: { items: [], brands: [], audiences: [], topics: [] },
      capability: emptyCapability(),
      route: emptyRoute(),
      clarifying_question: shape === 'needs_clarification' ? clarifying_question : null,
      resolver_note: null,
    };
    await logBrief(q, brief, context);
    return brief;
  }

  // Decision 2: Entities.
  const entitiesResult = await resolveEntities(q, shape, context);
  const entities = {
    items:     entitiesResult.items,
    brands:    entitiesResult.brands,
    audiences: entitiesResult.audiences,
    topics:    entitiesResult.topics,
  };

  // Escalation: if the shape requires entities and we got zero, don't
  // guess — escalate to needs_clarification with a specific ask. This is
  // the spec's Regression Test 4: never a junk resolution when nothing
  // resolved.
  const totalEntities = entities.items.length + entities.brands.length + entities.audiences.length;
  if (SHAPES_REQUIRING_ENTITIES.has(shape) && totalEntities === 0) {
    const originalShape = shape;
    shape = 'needs_clarification';
    shape_reasoning = `Original classification was ${originalShape}, but entity resolution returned zero. Escalating to needs_clarification per front-door guarantee.`;
    clarifying_question = originalShape === 'brand_lookup'
      ? "I couldn't find that brand in the corpus by name. Can you tell me the exact brand name, or the category it competes in?"
      : originalShape === 'audience_comparison'
      ? "I couldn't identify the audiences being compared. Which two groups of people do you want to compare, and on what experience or preference?"
      : "I couldn't identify a specific experience, brand, or category to run this against. Can you name the experience you're asking about? For example: \"how does joy from theme parks connect to other things\" or \"what do people who love a specific brand also love.\"";
  }

  // Capability — computed here so every consumer reads the same
  // ledger_degree / verbatim_depth off the brief instead of
  // re-computing per surface. If shape flipped to needs_clarification
  // above, entities is empty and computeCapability returns the empty
  // shape.
  const capability = shape === 'needs_clarification'
    ? emptyCapability()
    : await computeCapability(entities);

  const brief = {
    shape,
    shape_reasoning,
    entities,
    capability,
    route: emptyRoute(),             // Step 3 populates.
    clarifying_question: shape === 'needs_clarification' ? clarifying_question : null,
    resolver_note: entitiesResult.resolver_note,
  };

  await logBrief(q, brief, context);
  return brief;
}

// ---------------------------------------------------------------------
// HTTP handler — enables direct frontend calls (e.g. connections pane
// standalone). Auth required. require()-based callers bypass this by
// importing bjlFrontDoor directly.
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
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON body' }) }; }
  const query = String(body.query || '').trim();
  if (!query) return { statusCode: 400, body: JSON.stringify({ error: 'query required' }) };
  const context = Object.assign({}, body.context || {}, { user_email: userEmail });
  try {
    const brief = await bjlFrontDoor(query, context);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, brief }),
    };
  } catch (e) {
    console.error('[front-door] handler error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

exports.bjlFrontDoor = bjlFrontDoor;
