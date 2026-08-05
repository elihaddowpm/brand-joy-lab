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
 * session_history is CONSUMED, as of the Joy Map clarification-loop fix. It
 * was documented here for months without being read: classifyShape and
 * extractSearchTerms both sent the bare query, so a clarifying answer
 * ("the QSR category") arrived divorced from the question it answered and
 * got re-escalated. Both now thread prior turns as real conversation
 * messages. An absent or empty history is a STRICT no-op — identical system
 * prompt, identical message list, identical output — which is what keeps the
 * consumers that pass no history provably unchanged. See priorTurnsToMessages.
 *
 * extra_context is still accepted and still not read. Left in the signature
 * because callers pass it; do not infer from its presence that it works.
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

// Prior-turn threading limits. History exists so a clarifying answer reads
// as an answer; it is not a transcript store.
const MAX_PRIOR_TURNS = 6;
const MAX_PRIOR_TURN_CHARS = 1200;

// ---------------------------------------------------------------------
// Decision 1: Shape
// ---------------------------------------------------------------------

function sqlEscape(s) { return String(s).replace(/'/g, "''"); }

// Prior turns → Anthropic message list.
//
// STRICT NO-OP CONTRACT. When there is no usable history this returns [],
// and every caller then builds exactly the single-user-message array it
// built before this function existed. That is the property that keeps the
// other two consumers of this module (the connections-beta pane and the
// investigator) provably unchanged: neither passes session_history, so
// neither can take a different path. It is a no-op by construction, not by
// resemblance — do not add behaviour here that fires on an empty list.
//
// Accepts the turn shape the staff tool already assembles for
// prior_conversation_context: [{ role, content }] or [{ query, response }].
function priorTurnsToMessages(context) {
  const raw = context && Array.isArray(context.session_history)
    ? context.session_history
    : null;
  if (!raw || raw.length === 0) return [];

  const msgs = [];
  for (const turn of raw.slice(-MAX_PRIOR_TURNS)) {
    if (!turn || typeof turn !== 'object') continue;
    if (typeof turn.role === 'string' && typeof turn.content === 'string') {
      if (turn.role !== 'user' && turn.role !== 'assistant') continue;
      const text = turn.content.trim().slice(0, MAX_PRIOR_TURN_CHARS);
      if (text) msgs.push({ role: turn.role, content: text });
      continue;
    }
    const q = typeof turn.query === 'string' ? turn.query.trim() : '';
    const a = typeof turn.response === 'string' ? turn.response.trim() : '';
    if (q) msgs.push({ role: 'user', content: q.slice(0, MAX_PRIOR_TURN_CHARS) });
    if (a) msgs.push({ role: 'assistant', content: a.slice(0, MAX_PRIOR_TURN_CHARS) });
  }

  // Anthropic requires the list to start with a user turn and to alternate.
  // Rather than repair a malformed history, drop it — a wrong reconstruction
  // of the conversation is worse than no conversation.
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].role === msgs[i - 1].role) return [];
  }
  // Callers append the live query as a user turn, so history must end on
  // the assistant side.
  if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs.pop();
  return msgs;
}

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
  // Connections-shaped surfaces (the connections beta pane and the
  // Joy Map connections sweep) both run a ledger read on whatever
  // the strategist types. A bare noun typed into either surface is
  // a connection query by convention — the surface default supplies
  // the verb, and escalating to needs_clarification for a bare item
  // or bare brand produces the three-retry burst the connections
  // pane's log 4-7 captured. Same rule applies here.
  const isConnectionsShapedSurface = (
    surface === 'connections' || surface === 'joy_map_connections'
  );
  const surfaceHint = isConnectionsShapedSurface
    ? `\nCalling surface: ${surface}
CONNECTIONS-SURFACE DEFAULT: this pane runs a within-person connectivity read on a specific item, brand, category, or audience. A bare noun phrase typed here means "what connects to it" — classify bare items/experiences as item_connection and bare brand names as brand_lookup. When the query names a group of people (e.g. "parents who love X", "sports fans", "Gen Z"), classify as audience_comparison (anchor items resolve for the audience side). Do NOT escalate to needs_clarification for a bare item, bare brand, or a query missing only a verb; the surface default supplies the verb. Reserve needs_clarification for pronouns without antecedents, meta questions about the tool, or genuinely empty asks.`
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

  // Prior turns, when the caller supplied them. The live query is always
  // the final user message, so an empty history reproduces the original
  // single-message call exactly.
  const priorMsgs = priorTurnsToMessages(context);
  const historyHint = priorMsgs.length
    ? `\n\nCONVERSATION IN PROGRESS: the messages before the last one are earlier turns on this surface, including any clarifying question this tool already asked. The FINAL user message is what you are classifying, and it is very likely an ANSWER to that clarifying question rather than a new standalone query. Read it together with what came before: if the earlier turn established the subject and the final message supplies the missing detail, classify the COMBINED intent and do not return needs_clarification for a second time on the same subject.`
    : '';

  try {
    const rsp = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 300,
      system: [{ type: 'text', text: system + historyHint }],
      messages: [...priorMsgs, { role: 'user', content: query }],
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
async function extractSearchTerms(query, shape, context) {
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

  // Same strict no-op as the classifier: no history, identical call.
  const priorMsgs = priorTurnsToMessages(context);
  const historyHint = priorMsgs.length
    ? '\n\nCONVERSATION IN PROGRESS: earlier turns precede the final user message. The final message may be a short answer to a clarifying question ("the QSR category", "it competes with hostels") rather than a self-contained query. Extract phrases for the SUBJECT UNDER DISCUSSION across the whole exchange, taking the detail the final message adds — not phrases for the final message read alone.'
    : '';

  try {
    const rsp = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 300,
      system: [{ type: 'text', text: system + historyHint }],
      messages: [...priorMsgs, { role: 'user', content: query }],
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

// Ranking note. The old tiebreak was `hit_count DESC, name_len DESC`,
// which was presumably meant to prefer descriptive names and instead
// built an open-end promotion engine: long strings are question-shaped
// ("What types of problems do you have with your Internet…"), short
// ones are item-shaped ("Having access to HIGH-SPEED INTERNET in your
// home"). On any open-end-heavy topic every candidate Haiku saw was an
// unscored verbatim item. So the tiebreak is inverted, and membership
// in bjl_conn_centered_v2 — the scored ledger — leads the sort.
//
// Open-ends are ranked down, never dropped. Verbatim surfaces
// legitimately want them; they just should not crowd out scored items
// for the quant surfaces. Every row carries in_centered so a consumer
// can filter on it explicitly rather than infer it from position.
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
    SELECT m.item_id, m.item_name, m.primary_topic, m.canonical_brand,
           m.is_brand, m.is_location, m.hit_count,
           EXISTS (SELECT 1 FROM bjl_conn_centered_v2 c WHERE c.item_id = m.item_id) AS in_centered
    FROM matches m
    ORDER BY in_centered DESC, hit_count DESC, name_len ASC
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
    in_centered:     !!r.in_centered,
  }));
}

// Haiku Stage 2 — semantic-subject picker. Same guarantee as before:
// only items that name the semantic subject reach the ledger. Rejects
// incidental matches ("non" on a query about non-fans).
async function pickSemanticSubjects(query, shape, shortlist) {
  if (shortlist.length === 0) return { picks: [], reason: 'shortlist empty' };
  const candidates = shortlist.map(c =>
    `${c.item_id}: "${c.item_name}"${c.primary_topic ? ` [${c.primary_topic}]` : ''}${c.canonical_brand ? ` (brand: ${c.canonical_brand})` : ''}${c.in_centered ? '' : ' <unscored: open-end / verbatim only>'}`
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
- Candidates tagged <unscored: open-end / verbatim only> carry no numeric responses. They are the right answer only when the query is asking to read what people SAID. For anything measured, prefer a scored candidate even when the open-end's wording looks like a closer match — an open-end's question text repeats the topic and reads as a better match than it is.
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
  const terms = await extractSearchTerms(query, shape, context);
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
      // Carried through so a quant consumer can filter on scoredness
      // explicitly instead of inferring it from shortlist position.
      in_centered:  c.in_centered,
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
// Two thresholds anchor the rendered unmeasured copy:
//   Item-level 50-respondents floor: an item that fewer than 50
//     respondents answered never entered the connectivity ledger.
//     Encoded by bjl_item_capability(...).in_ledger (server-side).
//   Pair-level 30-shared floor: a pair with fewer than 30 shared
//     answerers is enforced per-pair by the connections pane; the
//     front door reports item-level capability, the pane reports
//     pair-level capability.
// Front-door verdict values:
//   'measurable'       — at least one item has degree >= EDGE_MEASURABLE
//   'thin'             — item is in the ledger but neighborhood small
//   'unmeasured'       — no resolved item cleared the 50-respondent floor
//   'capability_error' — helper calls errored out; distinct so consumers
//                        do not silently downgrade to "no coverage" when
//                        they actually do not know. Never renders as
//                        connection language.
const EDGE_MEASURABLE = 50;
// Anchor-fallback tuning. When shape=item_connection resolves items
// that are all outside the ledger, we retrieve up to this many
// in-ledger anchors nearest by name (pg_trgm similarity) with
// primary_topic as tiebreak. The connections pane then substitutes
// these anchors as focals and labels the substitution explicitly;
// the unmeasured card for the resolved items stays visible above
// so co-fielding candidacy remains a rendered verdict.
const ANCHOR_FALLBACK_MAX = 5;
const ANCHOR_FALLBACK_SHORTLIST = 30;
const VOICES_OFFER_MIN_DEPTH = 30;

// Fallback anchor retrieval. Trigram similarity on lowercased
// item_name against every resolved item name; take best-scoring
// in-ledger items across the whole corpus, use primary_topic match
// as tiebreak. Substitutes for a name-embedding lookup — bjl_items
// carries no embedding column and no per-item embedding table
// exists yet, so pg_trgm is the shipped substitute; if an
// embedding column arrives later, only this helper needs replacing.
async function fetchAnchorFallback(resolvedItems) {
  if (!Array.isArray(resolvedItems) || resolvedItems.length === 0) {
    return { anchors: [], reason: null };
  }
  const nameLiterals = resolvedItems
    .map(i => `'${sqlEscape(String(i.item_name || '').toLowerCase())}'`)
    .join(',');
  const topicLiterals = Array.from(new Set(
    resolvedItems.map(i => i.primary_topic).filter(Boolean)
  )).map(t => `'${sqlEscape(t)}'`).join(',');
  const excludeIds = resolvedItems
    .map(i => Number(i.item_id))
    .filter(Number.isFinite)
    .join(',');
  const topicJoinCond = topicLiterals.length > 0
    ? `MAX(CASE WHEN i.primary_topic IN (${topicLiterals}) THEN 1 ELSE 0 END) = 1`
    : `FALSE`;
  // Filter to in-ledger items via bjl_connectivity_ledger before
  // trigram-ranking, so the shortlist can never come back empty just
  // because the top name matches happen to all be out-of-ledger
  // variants of the resolved items (which was log id 12's failure
  // mode: three fan-question phrasings dominate name similarity but
  // none entered the ledger).
  const sql = `
    WITH resolved(name) AS (SELECT UNNEST(ARRAY[${nameLiterals}]::text[])),
    in_ledger_ids AS (
      SELECT DISTINCT item_id FROM (
        SELECT item_a AS item_id FROM bjl_connectivity_ledger
        UNION
        SELECT item_b FROM bjl_connectivity_ledger
      ) u
    ),
    scored AS (
      SELECT i.item_id, i.item_name, i.primary_topic,
             MAX(similarity(LOWER(i.item_name), r.name)) AS name_sim,
             ${topicJoinCond} AS topic_match
      FROM bjl_items i
      JOIN in_ledger_ids l ON l.item_id = i.item_id
      CROSS JOIN resolved r
      WHERE i.item_id NOT IN (${excludeIds || '0'})
      GROUP BY i.item_id, i.item_name, i.primary_topic
    ),
    top_picks AS (
      SELECT * FROM scored
      ORDER BY topic_match DESC, name_sim DESC
      LIMIT ${ANCHOR_FALLBACK_MAX}
    )
    SELECT t.item_id, t.item_name, t.primary_topic, t.name_sim, t.topic_match,
           c.respondents, c.in_ledger, c.degree
    FROM top_picks t
    JOIN bjl_item_capability(ARRAY(SELECT item_id FROM top_picks)::int[]) c
      ON c.item_id = t.item_id
    ORDER BY t.topic_match DESC, t.name_sim DESC, c.degree DESC
  `;
  try {
    const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
    if (error) throw new Error(error.message);
    const anchors = (Array.isArray(data) ? data : []).map(r => ({
      item_id:       Number(r.item_id),
      item_name:     String(r.item_name),
      primary_topic: r.primary_topic || null,
      name_similarity: r.name_sim == null ? null : Math.round(Number(r.name_sim) * 1000) / 1000,
      topic_match:   !!r.topic_match,
      respondents:   Number(r.respondents || 0),
      in_ledger:     !!r.in_ledger,
      degree:        Number(r.degree || 0),
    }));
    return {
      anchors,
      reason: anchors.length > 0
        ? 'Resolved items are outside the connectivity ledger; substituting the nearest in-ledger items by name similarity so the read can still run. The strategist sees which anchors carried each connection.'
        : 'No in-ledger anchors nearby enough to substitute; no fallback available.',
    };
  } catch (e) {
    console.warn('[front-door] anchor fallback failed:', e.message);
    return { anchors: [], reason: `anchor fallback errored: ${e.message}` };
  }
}

// bjl_item_capability + bjl_verbatim_depth are the server-side helpers.
// One RPC call for the batch ledger triple (respondents, in_ledger,
// degree); one RPC per item for verbatim depth (function takes a text
// query, so per-item, dispatched in parallel).
async function computeCapability(entities, shape) {
  const items = Array.isArray(entities && entities.items) ? entities.items : [];
  if (items.length === 0) {
    return {
      ledger_degree: {},
      respondents: {},
      in_ledger: {},
      verbatim_depth: {},
      verdict: 'unmeasured',
      unmeasured_detail: 'No items resolved; nothing to measure.',
      error_detail: null,
    };
  }
  const ids = items.map(i => Number(i.item_id)).filter(Number.isFinite);
  if (ids.length === 0) {
    return {
      ledger_degree: {},
      respondents: {},
      in_ledger: {},
      verbatim_depth: {},
      verdict: 'unmeasured',
      unmeasured_detail: 'Resolved items had no numeric ids.',
      error_detail: null,
    };
  }

  const ledgerDegree = {};
  const respondents = {};
  const inLedger = {};
  const verbatimDepth = {};
  const errors = [];

  // Batch ledger capability — bjl_item_capability(int[]).
  try {
    const { data, error } = await supabase.rpc('bjl_item_capability', { p_items: ids });
    if (error) throw new Error(error.message);
    for (const row of (Array.isArray(data) ? data : [])) {
      const key = String(row.item_id);
      ledgerDegree[key] = Number(row.degree || 0);
      respondents[key] = Number(row.respondents || 0);
      inLedger[key] = !!row.in_ledger;
    }
  } catch (e) {
    console.warn('[front-door] bjl_item_capability failed:', e.message);
    errors.push(`ledger capability: ${e.message}`);
  }

  // Per-item verbatim depth — function signature takes a text query,
  // so one call per item name, dispatched in parallel.
  const depthCalls = items.map(async (it) => {
    try {
      const { data, error } = await supabase.rpc('bjl_verbatim_depth', { p_query: it.item_name });
      if (error) throw new Error(error.message);
      return { id: it.item_id, depth: Number(data || 0) };
    } catch (e) {
      errors.push(`verbatim depth (${it.item_name}): ${e.message}`);
      return { id: it.item_id, depth: null };
    }
  });
  const depthResults = await Promise.all(depthCalls);
  for (const r of depthResults) {
    if (r.depth != null) verbatimDepth[String(r.id)] = r.depth;
  }

  // Capability_error: total ledger failure with no items resolved from
  // that path. Distinct verdict so downstream consumers do not present
  // the ledger read as authoritative when the coverage check itself
  // could not run.
  const ledgerRan = Object.keys(ledgerDegree).length > 0;
  if (!ledgerRan && errors.length > 0) {
    return {
      ledger_degree: ledgerDegree,
      respondents,
      in_ledger: inLedger,
      verbatim_depth: verbatimDepth,
      verdict: 'capability_error',
      unmeasured_detail: null,
      error_detail: errors.join('; '),
    };
  }

  // Verdict — item-level, anchored on the 50-respondent floor via
  // in_ledger. Verbatim depth is exposed as data but does not drive
  // the verdict; it is a secondary qualitative signal.
  const anyInLedger = ids.some(id => inLedger[String(id)]);
  const maxDegree = ids.reduce((m, id) => Math.max(m, ledgerDegree[String(id)] || 0), 0);
  const maxRespondents = ids.reduce((m, id) => Math.max(m, respondents[String(id)] || 0), 0);

  let verdict, unmeasuredDetail = null;
  if (!anyInLedger) {
    verdict = 'unmeasured';
    unmeasuredDetail = `No resolved item cleared the 50-respondent floor to enter the connectivity ledger (best-case ${maxRespondents} respondents). Unmeasured at the item level — candidate for co-fielding.`;
  } else if (maxDegree >= EDGE_MEASURABLE) {
    verdict = 'measurable';
  } else {
    verdict = 'thin';
    unmeasuredDetail = `Ledger carries at least one resolved item but the neighborhood is small (${maxDegree} edges, ${maxRespondents} respondents). Reads may be directional but sit under the edge-diversity floor of ${EDGE_MEASURABLE}.`;
  }

  // Anchor fallback — only fires on item_connection queries whose
  // resolved items are all outside the ledger. When it fires, the
  // resolved items still surface as unmeasured (co-fielding
  // candidacy stays visible); the anchors are substituted in as
  // focals downstream and the substitution is labeled explicitly.
  let anchorFallback = null;
  if (shape === 'item_connection' && verdict === 'unmeasured') {
    anchorFallback = await fetchAnchorFallback(items);
  }

  // Voices offer — surface verbatim_depth >= 30 as an offered
  // qualitative read even when the ledger side is unmeasured.
  // Voices are how you honor a co-fielding candidate before the
  // quant catches up.
  const voicesItems = items
    .map(i => ({
      item_id:      i.item_id,
      item_name:    i.item_name,
      verbatim_depth: verbatimDepth[String(i.item_id)] || 0,
    }))
    .filter(v => v.verbatim_depth >= VOICES_OFFER_MIN_DEPTH);
  const voicesOffer = voicesItems.length > 0
    ? {
        available:  true,
        min_depth:  VOICES_OFFER_MIN_DEPTH,
        items:      voicesItems,
        detail:     `Verbatim depth is at or above the offer floor (${VOICES_OFFER_MIN_DEPTH}) on ${voicesItems.length} resolved item(s). A voices read is available even when the ledger is silent.`,
      }
    : { available: false, min_depth: VOICES_OFFER_MIN_DEPTH, items: [], detail: null };

  return {
    ledger_degree: ledgerDegree,
    respondents,
    in_ledger: inLedger,
    verbatim_depth: verbatimDepth,
    verdict,
    unmeasured_detail: unmeasuredDetail,
    error_detail: errors.length > 0 ? errors.join('; ') : null,
    anchor_fallback: anchorFallback,
    voices_offer: voicesOffer,
  };
}

// Empty capability shape for shapes that never resolve items
// (out_of_scope, needs_clarification). Consumers switch on verdict.
function emptyCapability() {
  return {
    ledger_degree: {},
    respondents: {},
    in_ledger: {},
    verbatim_depth: {},
    verdict: 'unmeasured',
    unmeasured_detail: null,
    error_detail: null,
    anchor_fallback: null,
    voices_offer: { available: false, min_depth: VOICES_OFFER_MIN_DEPTH, items: [], detail: null },
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
      escalated_from: null,
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
      escalated_from: null,          // classifier asked; nothing was resolved against.
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
  //
  // Two different failures used to arrive at consumers looking identical:
  // "Theme parks" (present in the corpus, query too vague) and "Hostelling
  // International" (query perfectly clear, brand simply not fielded). Both
  // land on needs_clarification, and a surface cannot offer the right next
  // move without telling them apart — asking someone to rephrase a brand
  // name that does not exist is a loop with no exit. escalated_from records
  // which one this is. The shape stays needs_clarification so existing
  // consumers are unaffected; the discriminator is additive.
  const totalEntities = entities.items.length + entities.brands.length + entities.audiences.length;
  let escalatedFrom = null;
  if (SHAPES_REQUIRING_ENTITIES.has(shape) && totalEntities === 0) {
    const originalShape = shape;
    escalatedFrom = originalShape;
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
  // re-computing per surface. Shape is passed so item_connection
  // queries whose items land outside the ledger can pick up the
  // anchor-fallback substitution. If shape flipped to
  // needs_clarification above, entities is empty and
  // computeCapability returns the empty shape.
  const capability = shape === 'needs_clarification'
    ? emptyCapability()
    : await computeCapability(entities, shape);

  const brief = {
    shape,
    shape_reasoning,
    entities,
    capability,
    route: emptyRoute(),             // Step 3 populates.
    clarifying_question: shape === 'needs_clarification' ? clarifying_question : null,
    // null when the classifier itself asked for clarification (the query was
    // ambiguous); the original shape name when the query was understood and
    // the corpus simply had nothing. Consumers that do not read it are
    // unaffected — behaviour is identical to before this field existed.
    escalated_from: escalatedFrom,
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
