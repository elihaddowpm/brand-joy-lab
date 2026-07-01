/**
 * bjl-public-chat-background.js — Public Joy Lab Chat async worker (v6.15).
 *
 * v6.15 splits the public chat into an enqueue endpoint
 * (bjl-public-chat.js) + this background worker. Netlify Background
 * Functions (-background.js suffix) get a 15-minute timeout, eliminating
 * the 10s/26s sync function ceiling that was producing 502/504 timeouts
 * on slow Sonnet calls.
 *
 * Pipeline (logic unchanged from v6.14 sync version, just moved):
 *   1. Load the public_chat job row + read extra_context
 *      (question, conversation_synthesis)
 *   2. Classify scope via Haiku
 *   3. Retrieve across all seven layers (structured + semantic)
 *   4. Compose the answer via Sonnet
 *   5. Sanitize provenance + closest-insight slugs
 *   6. Write the result payload to bjl_query_jobs.finding (JSON-stringified),
 *      flip status='complete'. On error, flip status='error'.
 *
 * The frontend polls bjl-public-chat-status with the job_id.
 *
 * Invoked server-to-server by bjl-public-chat.js. No CORS handling, no
 * direct visitor auth (Netlify's gateway already accepted the upstream
 * enqueue from the public chat surface).
 *
 * Gates honored: same as v6.14 (public_safe / published).
 *
 * Graceful degradation: if OPENAI_API_KEY is unset, the function falls
 * back to structured retrieval only and notes the missing semantic
 * substrate in the logs. It does not crash.
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const PROMPTS = require('./_prompts_bundle.json');

const SCOPE_MODEL    = 'claude-haiku-4-5-20251001';
const ANSWER_MODEL   = 'claude-sonnet-4-6';
const EMBED_MODEL    = 'text-embedding-3-small';

const SEMANTIC_DISTANCE_THRESHOLD = 0.55;  // cosine distance; lower is closer. tune live.
const CLOSEST_OFFER_DISTANCE      = 0.75;  // surface as "closest" even if below answer threshold
const STRUCTURED_MIN_HITS         = 1;     // a structured row needs at least 1 token hit

const PER_LAYER_LIMITS = {
  scores:           5,
  ordinal:          3,
  agreement:        4,   // v6.4 — agreement-battery % shares (X% strongly agree, X% net agree)
  distributions:    4,   // v6.4 — frequency / describe-grid polarity-summed shares
  laws:             3,
  insights:         3,
  truths:           2,
  global_extremes: 10,   // v6.9 — top-N highest + top-N lowest, dedup-aware
};

// v6.15: CORS handling lives on the enqueue (bjl-public-chat.js) and
// status (bjl-public-chat-status.js) endpoints, not here. This worker
// is invoked server-to-server by the Netlify dispatch URL.

const STOPWORDS = new Set([
  'the','and','for','are','that','this','with','from','what','does','did','was','were','been','have','has','had','about','their','they','them','some','more','than','then','can','could','would','should','will','any','our','out','how','why','who','where','when','which','whom','your','you','one','two','also','into','over','onto','very','much','most','few','still','just','only','like','because','through','during','before','after','between','among','these','those','being','make','made','let','say','said','says','tell','told','think','thought','know','known','want','wants','use','using','need','needs','look','looks','found','find','findings','data','people','person','around','really','pretty','quite','sort','kind','tell','show','give'
]);

function tokenize(s) {
  return (s || '').toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function sqlEscape(s) {
  return String(s || '').replace(/'/g, "''");
}

// v7.2.1 — Tolerant LLM JSON parser.
//
// The synthesizer is told to return ONLY a JSON object, but Sonnet
// occasionally leaks a preamble sentence ("Looking at the data..." /
// "No data on this exact question...") or wraps the JSON in a code
// fence despite the prompt rule. The strict JSON.parse failed on
// these turns and the worker would propagate "Unexpected token X in
// JSON at position 0" up through the status endpoint as an error,
// which the frontend renders as the "Something hiccuped" bubble.
//
// Two recovery attempts:
//   1. Strip code fences + whitespace, parse directly.
//   2. Locate the first balanced { ... } block in the text and parse
//      that. Handles arbitrary preamble or trailing prose.
// Returns null on total failure; the caller is responsible for the
// graceful fallback (better than throwing).
function parseLLMJSON(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try { return JSON.parse(fenced); } catch (_) { /* fall through */ }
  // Walk the string to find the first balanced JSON object. Handles
  // strings/escapes so a `{` inside a string literal doesn't break
  // depth counting.
  const start = fenced.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape  = false;
  for (let i = start; i < fenced.length; i++) {
    const ch = fenced[i];
    if (escape)         { escape = false; continue; }
    if (ch === '\\')    { escape = true;  continue; }
    if (ch === '"')     { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{')     { depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = fenced.slice(start, i + 1);
        try { return JSON.parse(candidate); } catch (_) { return null; }
      }
    }
  }
  return null;
}

// =============================================================
// Scope classifier (Haiku) — unchanged behavior from v6
// =============================================================

async function classifyScope(question) {
  const system = `You are a scope classifier for a public-facing joy chat. Given a visitor's question, output a JSON object with one field:

  "scope": "in_corpus_scope" | "brand_specific" | "live_cut_requested" | "out_of_scope"

Rules:
- "brand_specific": names a SPECIFIC, real brand/company/product by name AND asks for analysis of THAT named entity (e.g., "How do Disney visitors feel?"). This is narrow. A visitor describing themselves ("I run a CPG brand", "my product", "our company") has NOT named a brand — classify that in_corpus_scope. General category, strategy, positioning, and "how do I..." questions are in_corpus_scope, never brand_specific.
- "live_cut_requested": custom analysis, cross-tab, or "give me the breakdown by X" request.
- "out_of_scope": not about consumer joy or behavior at all.
- "in_corpus_scope": everything else.

Output ONLY the JSON. No preamble.`;
  try {
    const rsp = await anthropic.messages.create({
      model: SCOPE_MODEL,
      max_tokens: 100,
      system: [{ type: 'text', text: system }],
      messages: [{ role: 'user', content: question }],
    });
    const text = (rsp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const scope = parsed.scope;
    if (['in_corpus_scope','brand_specific','live_cut_requested','out_of_scope'].includes(scope)) {
      return scope;
    }
  } catch (err) {
    console.error('[bjl-public-chat] scope classify failed, defaulting in_corpus_scope:', err.message);
  }
  return 'in_corpus_scope';
}

// =============================================================
// Query-time embedding via OpenAI text-embedding-3-small (1536-dim)
// =============================================================

async function embedQuery(question) {
  if (!OPENAI_API_KEY) return null;
  try {
    const resp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: question }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error('[bjl-public-chat] embed call failed:', resp.status, text.slice(0, 300));
      return null;
    }
    const j = await resp.json();
    return (j.data && j.data[0] && j.data[0].embedding) || null;
  } catch (err) {
    console.error('[bjl-public-chat] embed call threw:', err.message);
    return null;
  }
}

function vectorLiteral(embedding) {
  // pgvector accepts the string form '[1.23,4.56,...]' cast to ::vector(N)
  return `'[${embedding.join(',')}]'::vector(1536)`;
}

// =============================================================
// Structured retrieval (bjl_public_scores, bjl_public_ordinal)
// Tokenized ILIKE across item_name + question_label + category
// =============================================================

async function retrieveScores(question) {
  const tokens = tokenize(question);
  if (tokens.length === 0) return [];

  // v9: repointed from the curated bjl_public_scores snapshot (795 rows) to the
  // live public-safe slice of the full scored corpus (bjl_scores_public_safe,
  // ~1,244 rows and growing). The view is pre-gated, so no public_safe filter is
  // needed. Searchable surface: item_name, question, category_key.
  const conds = tokens.map(t => {
    const tEsc = sqlEscape(t);
    return `(item_name ILIKE '%${tEsc}%' OR question ILIKE '%${tEsc}%' OR category_key ILIKE '%${tEsc}%')`;
  });
  const scoreExpr = tokens.map(t => {
    const tEsc = sqlEscape(t);
    return `(CASE WHEN (item_name ILIKE '%${tEsc}%' OR question ILIKE '%${tEsc}%' OR category_key ILIKE '%${tEsc}%') THEN 1 ELSE 0 END)`;
  }).join(' + ');

  // DISTINCT ON collapses the same concept appearing under multiple question
  // batteries; the outer query restores relevance ordering after the dedup.
  const sql = `
    SELECT * FROM (
      SELECT DISTINCT ON (item_name, joy_index, n)
             question_id AS item_id, item_name,
             question AS question_label, category_key AS category,
             joy_index, n, question_type,
             (${scoreExpr})::int AS hit_count
      FROM bjl_scores_public_safe
      WHERE (${conds.join(' OR ')})
      ORDER BY item_name, joy_index, n
    ) d
    WHERE d.hit_count >= ${STRUCTURED_MIN_HITS}
    ORDER BY d.hit_count DESC, d.n DESC NULLS LAST
    LIMIT ${PER_LAYER_LIMITS.scores}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) {
    console.error('[bjl-public-chat] retrieveScores error:', error.message);
    return [];
  }
  // v8.5: defensive against execute_read_sql returning {error, sqlstate}
  // when the SQL is malformed or rejected. Array.isArray guard ensures
  // we silently return [] instead of crashing the worker with
  // (data || []).filter is not a function.
  if (!Array.isArray(data)) {
    if (data && data.error) {
      console.error('[bjl-public-chat] execute_read_sql returned error:', data.error);
    }
    return [];
  }
  return data.filter(r => r.hit_count >= STRUCTURED_MIN_HITS);
}

// v9: semantic search over the live public-safe scored corpus. This is the
// capability the public tool was missing — meaning-based retrieval over raw
// scores, not token match and not the curated card layer.
async function retrieveScoresSemantic(vecLit) {
  const sql = `
    SELECT * FROM (
      SELECT DISTINCT ON (item_name, joy_index, n)
             question_id AS item_id, item_name,
             question AS question_label, category_key AS category,
             joy_index, n, question_type,
             (embedding <=> ${vecLit})::float AS distance
      FROM bjl_scores_public_safe
      WHERE embedding IS NOT NULL
      ORDER BY item_name, joy_index, n, embedding <=> ${vecLit}
    ) d
    ORDER BY d.distance
    LIMIT ${PER_LAYER_LIMITS.scores}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) {
    console.error('[bjl-public-chat] retrieveScoresSemantic error:', error.message);
    return [];
  }
  return Array.isArray(data) ? data : [];
}

// v9: union token + semantic score rows, deduped by concept + reading
// (item_name + joy_index + n). Token rows carry hit_count; semantic-only rows
// carry distance. Token hits are kept first, then semantic-only additions.
function mergeScoreRows(tokenRows, semanticRows) {
  const byKey = new Map();
  const keyOf = r => `${(r.item_name || '').toLowerCase().trim()}|${r.joy_index}|${r.n}`;
  for (const r of (tokenRows || [])) byKey.set(keyOf(r), r);
  for (const r of (semanticRows || [])) {
    const k = keyOf(r);
    if (byKey.has(k)) {
      const existing = byKey.get(k);
      if (existing.distance == null && r.distance != null) existing.distance = r.distance;
    } else {
      byKey.set(k, r);
    }
  }
  return Array.from(byKey.values()).slice(0, PER_LAYER_LIMITS.scores * 2);
}

async function retrieveOrdinal(question) {
  const tokens = tokenize(question);
  if (tokens.length === 0) return [];

  // v6.4: also search item_name + category, matching the surface used by
  // retrieveScores / retrieveAgreement / retrieveDistributions per the
  // brief's "item_name and question_label across the four quant tables".
  const conds = tokens.map(t => {
    const tEsc = sqlEscape(t);
    return `(item_name ILIKE '%${tEsc}%' OR question_label ILIKE '%${tEsc}%' OR battery_type ILIKE '%${tEsc}%' OR category ILIKE '%${tEsc}%')`;
  });
  const scoreExpr = tokens.map(t => {
    const tEsc = sqlEscape(t);
    return `(CASE WHEN (item_name ILIKE '%${tEsc}%' OR question_label ILIKE '%${tEsc}%' OR battery_type ILIKE '%${tEsc}%' OR category ILIKE '%${tEsc}%') THEN 1 ELSE 0 END)`;
  }).join(' + ');

  const sql = `
    SELECT item_id, item_name, question_label, battery_type, category,
           mean_value, scale_min, scale_max, n,
           (${scoreExpr})::int AS hit_count
    FROM bjl_public_ordinal
    WHERE public_safe = true
      AND (${conds.join(' OR ')})
    ORDER BY hit_count DESC, n DESC NULLS LAST
    LIMIT ${PER_LAYER_LIMITS.ordinal}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) {
    console.error('[bjl-public-chat] retrieveOrdinal error:', error.message);
    return [];
  }
  // v8.5: defensive against execute_read_sql returning {error, sqlstate}
  // when the SQL is malformed or rejected. Array.isArray guard ensures
  // we silently return [] instead of crashing the worker with
  // (data || []).filter is not a function.
  if (!Array.isArray(data)) {
    if (data && data.error) {
      console.error('[bjl-public-chat] execute_read_sql returned error:', data.error);
    }
    return [];
  }
  return data.filter(r => r.hit_count >= STRUCTURED_MIN_HITS);
}

// v6.4 — bjl_public_agreement: 54 live agreement-battery items.
// One row per item with the % shares: strongly_agree_pct, net_agree_pct,
// neutral_pct, net_disagree_pct. The "X% agree" answers — including the
// fandom grids the brief calls out. Token-match on item_name +
// question_label + category, return top N by hit count then by n.
async function retrieveAgreement(question) {
  const tokens = tokenize(question);
  if (tokens.length === 0) return [];

  const conds = tokens.map(t => {
    const tEsc = sqlEscape(t);
    return `(item_name ILIKE '%${tEsc}%' OR question_label ILIKE '%${tEsc}%' OR category ILIKE '%${tEsc}%')`;
  });
  const scoreExpr = tokens.map(t => {
    const tEsc = sqlEscape(t);
    return `(CASE WHEN (item_name ILIKE '%${tEsc}%' OR question_label ILIKE '%${tEsc}%' OR category ILIKE '%${tEsc}%') THEN 1 ELSE 0 END)`;
  }).join(' + ');

  const sql = `
    SELECT item_id, item_name, question_label, category, n,
           strongly_agree_pct, net_agree_pct, neutral_pct, net_disagree_pct,
           (${scoreExpr})::int AS hit_count
    FROM bjl_public_agreement
    WHERE public_safe = true
      AND (${conds.join(' OR ')})
    ORDER BY hit_count DESC, n DESC NULLS LAST
    LIMIT ${PER_LAYER_LIMITS.agreement}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) {
    console.error('[bjl-public-chat] retrieveAgreement error:', error.message);
    return [];
  }
  // v8.5: defensive against execute_read_sql returning {error, sqlstate}
  // when the SQL is malformed or rejected. Array.isArray guard ensures
  // we silently return [] instead of crashing the worker with
  // (data || []).filter is not a function.
  if (!Array.isArray(data)) {
    if (data && data.error) {
      console.error('[bjl-public-chat] execute_read_sql returned error:', data.error);
    }
    return [];
  }
  return data.filter(r => r.hit_count >= STRUCTURED_MIN_HITS);
}

// v6.4 — bjl_public_distributions: 348 live items, with many rows per
// item (one per response_label). Per the brief: the "X% feel this often"
// or "X% very much so" answers are computed as the sum of pct where
// polarity = 'top'. We aggregate at the SQL layer (GROUP BY item_id)
// and surface one row per item with top_pct, mid_pct, bottom_pct, and
// the label set so the synthesizer can quote a specific phrase.
async function retrieveDistributions(question) {
  const tokens = tokenize(question);
  if (tokens.length === 0) return [];

  const conds = tokens.map(t => {
    const tEsc = sqlEscape(t);
    return `(item_name ILIKE '%${tEsc}%' OR question_label ILIKE '%${tEsc}%' OR battery_type ILIKE '%${tEsc}%' OR category ILIKE '%${tEsc}%')`;
  });
  const scoreExpr = tokens.map(t => {
    const tEsc = sqlEscape(t);
    return `(CASE WHEN (item_name ILIKE '%${tEsc}%' OR question_label ILIKE '%${tEsc}%' OR battery_type ILIKE '%${tEsc}%' OR category ILIKE '%${tEsc}%') THEN 1 ELSE 0 END)`;
  }).join(' + ');

  const sql = `
    SELECT item_id,
           MAX(item_name)      AS item_name,
           MAX(question_label) AS question_label,
           MAX(battery_type)   AS battery_type,
           MAX(category)       AS category,
           MAX(n_total)        AS n_total,
           ROUND(COALESCE(SUM(pct) FILTER (WHERE polarity = 'top'),    0)::numeric, 1) AS top_pct,
           ROUND(COALESCE(SUM(pct) FILTER (WHERE polarity = 'mid'),    0)::numeric, 1) AS mid_pct,
           ROUND(COALESCE(SUM(pct) FILTER (WHERE polarity = 'bottom'), 0)::numeric, 1) AS bottom_pct,
           STRING_AGG(response_label, ' | ' ORDER BY pct DESC NULLS LAST)
             FILTER (WHERE polarity = 'top')  AS top_labels,
           (MAX(${scoreExpr}))::int AS hit_count
    FROM bjl_public_distributions
    WHERE public_safe = true
      AND (${conds.join(' OR ')})
    GROUP BY item_id
    HAVING SUM(pct) FILTER (WHERE polarity = 'top') IS NOT NULL
       AND SUM(pct) FILTER (WHERE polarity = 'top') > 0
    ORDER BY hit_count DESC, MAX(n_total) DESC NULLS LAST
    LIMIT ${PER_LAYER_LIMITS.distributions}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) {
    console.error('[bjl-public-chat] retrieveDistributions error:', error.message);
    return [];
  }
  // v8.5: defensive against execute_read_sql returning {error, sqlstate}
  // when the SQL is malformed or rejected. Array.isArray guard ensures
  // we silently return [] instead of crashing the worker with
  // (data || []).filter is not a function.
  if (!Array.isArray(data)) {
    if (data && data.error) {
      console.error('[bjl-public-chat] execute_read_sql returned error:', data.error);
    }
    return [];
  }
  return data.filter(r => r.hit_count >= STRUCTURED_MIN_HITS);
}

// v6.9 — true global extremes (dedup-aware).
//
// Two grounding failures from Eli's diagnostic motivate this layer:
//   - The "highest-joy" answer crowned a verbatim relational finding
//     as edging out the top scored items. Vacation (78.7) is actually
//     above the relationship item (78.2); the top cluster sits within
//     a few points and there's no clean #1.
//   - The "lowest-score" answer crowned the end-of-vacation arc low
//     (35.5) as "the single lowest anywhere", missing the actual
//     global minimum (psychedelics in the public-safe set has rows at
//     0.2 and −6.3; tofu sits at −2.6).
//
// Both bugs trace to the same root: the synthesizer was asserting a
// superlative from rows that were a slice, not the universe. This
// layer pre-computes the true global top-N and bottom-N from
// bjl_public_scores so the synthesizer has the actual extremes
// available whenever a question reaches for "highest" / "lowest".
//
// Dedup rule: the same item can appear under multiple fielding cuts
// (psychedelics shows up at both 0.2 n=1,468 and −6.3 n=1,364 — same
// item_name, different question wording). Without dedup, the answer
// flips depending on which fielding row got returned. We dedupe by
// LOWER(TRIM(item_name)) and keep the highest-n row per concept as
// the canonical reading. The synthesizer is told that some items
// have multiple fielding cuts and to treat the canonical row as the
// headline number.
async function retrieveGlobalExtremes() {
  const sql = `
    WITH deduped AS (
      SELECT DISTINCT ON (LOWER(TRIM(item_name)))
        question_id AS item_id, item_name, question AS question_label,
        category_key AS category, joy_index, n
      FROM bjl_scores_public_safe
      WHERE joy_index IS NOT NULL
      ORDER BY LOWER(TRIM(item_name)), n DESC NULLS LAST
    ),
    top_n AS (
      SELECT item_id, item_name, question_label, category, joy_index, n,
             'highest' AS extreme
      FROM deduped
      ORDER BY joy_index DESC
      LIMIT ${PER_LAYER_LIMITS.global_extremes}
    ),
    bottom_n AS (
      SELECT item_id, item_name, question_label, category, joy_index, n,
             'lowest' AS extreme
      FROM deduped
      ORDER BY joy_index ASC
      LIMIT ${PER_LAYER_LIMITS.global_extremes}
    )
    SELECT * FROM top_n
    UNION ALL
    SELECT * FROM bottom_n
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) {
    console.error('[bjl-public-chat] retrieveGlobalExtremes error:', error.message);
    return { highest: [], lowest: [] };
  }
  const highest = [];
  const lowest  = [];
  for (const r of (Array.isArray(data) ? data : [])) {
    if (r.extreme === 'highest') highest.push(r);
    else if (r.extreme === 'lowest') lowest.push(r);
  }
  return { highest, lowest };
}

// =============================================================
// Semantic retrieval (bjl_laws, bjl_public_verbatim_truths,
// bjl_public_insights) via pgvector cosine
// =============================================================

async function retrieveLawsSemantic(vecLit) {
  // v6.3.1: bjl_laws PK is law_id, not id. Aliased to id for the
  // downstream payload so the synthesizer prompt's "law:<id>" rows_used
  // identifier still works.
  const sql = `
    SELECT law_id AS id, statement, evidence, implication,
           (embedding <=> ${vecLit})::float AS distance
    FROM bjl_laws
    WHERE public_safe = true AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vecLit}
    LIMIT ${PER_LAYER_LIMITS.laws}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) {
    console.error('[bjl-public-chat] retrieveLawsSemantic error:', error.message);
    return [];
  }
  return data || [];
}

async function retrieveInsightsSemantic(vecLit) {
  const sql = `
    SELECT id, slug, title, insight, stat, category, confidence, source_n, source_note,
           supporting_quote,
           (embedding <=> ${vecLit})::float AS distance
    FROM bjl_public_insights
    WHERE published = true AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vecLit}
    LIMIT ${PER_LAYER_LIMITS.insights}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) {
    console.error('[bjl-public-chat] retrieveInsightsSemantic error:', error.message);
    return [];
  }
  return data || [];
}

async function retrieveTruthsSemantic(vecLit) {
  // v6.3.1: bjl_public_verbatim_truths PK is slug, not id. Aliased to id
  // for the downstream payload so the synthesizer prompt's
  // "truth:<id>" rows_used identifier remains stable.
  const sql = `
    SELECT slug AS id, title, truth, evidence, category, source_question, supporting_quote,
           confidence, source_n,
           (embedding <=> ${vecLit})::float AS distance
    FROM bjl_public_verbatim_truths
    WHERE public_safe = true AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vecLit}
    LIMIT ${PER_LAYER_LIMITS.truths}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) {
    console.error('[bjl-public-chat] retrieveTruthsSemantic error:', error.message);
    return [];
  }
  return data || [];
}

// =============================================================
// Token-fallback retrieval on insights when the embedding substrate
// isn't usable (OPENAI_API_KEY unset, or embeddings still null).
// =============================================================

async function retrieveInsightsTokenFallback(question) {
  const tokens = tokenize(question);
  if (tokens.length === 0) return [];
  const conds = tokens.map(t => {
    const tEsc = sqlEscape(t);
    return `(title ILIKE '%${tEsc}%' OR insight ILIKE '%${tEsc}%' OR EXISTS (SELECT 1 FROM unnest(topic_tags) tag WHERE tag ILIKE '%${tEsc}%'))`;
  });
  const scoreExpr = tokens.map(t => {
    const tEsc = sqlEscape(t);
    return `(CASE WHEN (title ILIKE '%${tEsc}%' OR insight ILIKE '%${tEsc}%') THEN 1 ELSE 0 END)`;
  }).join(' + ');
  const sql = `
    SELECT id, slug, title, insight, stat, category, confidence, source_n, source_note,
           supporting_quote,
           NULL::float AS distance,
           (${scoreExpr})::int AS hit_count
    FROM bjl_public_insights
    WHERE published = true
      AND (${conds.join(' OR ')})
    ORDER BY hit_count DESC
    LIMIT ${PER_LAYER_LIMITS.insights}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) {
    console.error('[bjl-public-chat] insights fallback error:', error.message);
    return [];
  }
  return data || [];
}

// =============================================================
// Retrieval orchestrator
// =============================================================

async function retrieve(question) {
  const queryEmbedding = await embedQuery(question);
  const semanticAvailable = !!queryEmbedding;
  const vecLit = semanticAvailable ? vectorLiteral(queryEmbedding) : null;

  const structuredPromises = [
    retrieveScores(question),
    retrieveOrdinal(question),
    retrieveAgreement(question),       // v6.4
    retrieveDistributions(question),   // v6.4
    retrieveGlobalExtremes(),          // v6.9 — always-on top/bottom N for superlative grounding
  ];

  // v9: semantic search over the live scored corpus runs alongside the existing
  // semantic layers. Without embeddings, fall back to token retrieval on
  // insights (laws + truths have no ILIKE-searchable text).
  const scoresSemanticPromise = semanticAvailable
    ? retrieveScoresSemantic(vecLit)
    : Promise.resolve([]);

  const semanticPromises = semanticAvailable
    ? [retrieveLawsSemantic(vecLit), retrieveInsightsSemantic(vecLit), retrieveTruthsSemantic(vecLit)]
    : [Promise.resolve([]), retrieveInsightsTokenFallback(question), Promise.resolve([])];

  const [scoresTok, ordinal, agreement, distributions, globalExtremes, scoresSem, laws, insights, truths] =
    await Promise.all([...structuredPromises, scoresSemanticPromise, ...semanticPromises]);

  // v9: merge token + semantic score hits into one deduped list, so the
  // synthesizer sees the union of keyword and meaning matches over raw scores.
  const scores = mergeScoreRows(scoresTok, scoresSem);

  // v9: a strong score match now also counts toward clearing the answer
  // threshold, so the tool answers from raw data instead of deflecting when
  // the corpus can speak to the question.
  const bestSemanticDistance = Math.min(
    ...[...laws, ...insights, ...truths, ...scoresSem]
      .map(r => Number(r.distance))
      .filter(d => Number.isFinite(d)),
    Infinity,
  );
  const hasStrongSemantic = bestSemanticDistance <= SEMANTIC_DISTANCE_THRESHOLD;
  const hasStrongStructured =
    (scores.length + ordinal.length + agreement.length + distributions.length) > 0;

  return {
    scores, ordinal, agreement, distributions, laws, insights, truths,
    global_extremes: globalExtremes,    // v6.9 — always available; the synthesizer reaches for it on superlative questions
    semantic_available: semanticAvailable,
    best_semantic_distance: Number.isFinite(bestSemanticDistance) ? bestSemanticDistance : null,
    threshold_cleared: hasStrongSemantic || hasStrongStructured,
  };
}

// =============================================================
// Answer composition (Sonnet) with the three-layer payload
// =============================================================

function buildRetrievedPayloadForLLM(retrieved) {
  return {
    scores: retrieved.scores.map(r => ({
      item_id: r.item_id,
      item_name: r.item_name,
      question_label: r.question_label,
      category: r.category,
      joy_index: r.joy_index,
      n: r.n,
      question_type: r.question_type,
    })),
    ordinal: retrieved.ordinal.map(r => ({
      item_id: r.item_id,
      item_name: r.item_name,
      question_label: r.question_label,
      battery_type: r.battery_type,
      category: r.category,
      mean_value: r.mean_value,
      scale_min: r.scale_min,
      scale_max: r.scale_max,
      n: r.n,
    })),
    agreement: (retrieved.agreement || []).map(r => ({
      item_id: r.item_id,
      item_name: r.item_name,
      question_label: r.question_label,
      category: r.category,
      n: r.n,
      strongly_agree_pct: r.strongly_agree_pct,
      net_agree_pct: r.net_agree_pct,
      neutral_pct: r.neutral_pct,
      net_disagree_pct: r.net_disagree_pct,
    })),
    distributions: (retrieved.distributions || []).map(r => ({
      item_id: r.item_id,
      item_name: r.item_name,
      question_label: r.question_label,
      battery_type: r.battery_type,
      category: r.category,
      n_total: r.n_total,
      top_pct: r.top_pct,
      mid_pct: r.mid_pct,
      bottom_pct: r.bottom_pct,
      top_labels: r.top_labels,
    })),
    laws: retrieved.laws.map(r => ({
      id: r.id,
      statement: r.statement,
      evidence: r.evidence,
      implication: r.implication,
      distance: r.distance != null ? Number(Number(r.distance).toFixed(3)) : null,
    })),
    insights: retrieved.insights.map(r => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      insight: r.insight,
      stat: r.stat,
      category: r.category,
      confidence: r.confidence,
      source_n: r.source_n,
      source_note: r.source_note,
      supporting_quote: r.supporting_quote,
      distance: r.distance != null ? Number(Number(r.distance).toFixed(3)) : null,
    })),
    truths: retrieved.truths.map(r => ({
      id: r.id,
      title: r.title,
      truth: r.truth,
      evidence: r.evidence,
      category: r.category,
      source_question: r.source_question,
      supporting_quote: r.supporting_quote,
      confidence: r.confidence,
      source_n: r.source_n,
      distance: r.distance != null ? Number(Number(r.distance).toFixed(3)) : null,
    })),
    global_extremes: {
      highest: ((retrieved.global_extremes && retrieved.global_extremes.highest) || []).map(r => ({
        item_id: r.item_id,
        item_name: r.item_name,
        category: r.category,
        joy_index: Number(r.joy_index),
        n: Number(r.n),
      })),
      lowest: ((retrieved.global_extremes && retrieved.global_extremes.lowest) || []).map(r => ({
        item_id: r.item_id,
        item_name: r.item_name,
        category: r.category,
        joy_index: Number(r.joy_index),
        n: Number(r.n),
      })),
    },
  };
}

async function composeAnswer({ question, scope, retrieved, conversation_synthesis }) {
  const systemPrompt = PROMPTS.publicChatSynthesis;
  if (!systemPrompt) throw new Error('public_chat_synthesis prompt missing from bundle');

  const userMessage = [
    `question: ${question}`,
    '',
    `conversation_synthesis: ${conversation_synthesis ? conversation_synthesis : '(none yet — this is the first turn or no prior synthesis was provided)'}`,
    '',
    `scope: ${scope}`,
    `threshold_cleared: ${retrieved.threshold_cleared}`,
    '',
    `retrieved:`,
    JSON.stringify(buildRetrievedPayloadForLLM(retrieved), null, 2),
  ].join('\n');

  const rsp = await anthropic.messages.create({
    model: ANSWER_MODEL,
    max_tokens: 900,
    system: [{ type: 'text', text: systemPrompt }],
    messages: [{ role: 'user', content: userMessage }],
  });
  const text = (rsp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

  // v7.2.1 — tolerant parse. The strict JSON.parse here was the cause
  // of intermittent "Something hiccuped" failures: Sonnet occasionally
  // leaked a preamble sentence before the JSON object, and the worker
  // surfaced a JSON.parse error up to the frontend instead of an
  // answer the visitor could read.
  const parsed = parseLLMJSON(text);
  if (parsed && typeof parsed === 'object' && typeof parsed.answer === 'string' && parsed.answer.trim().length > 0) {
    return parsed;
  }

  // Total parse failure or empty answer. Log the raw output (first 500
  // chars) so we can diagnose drift, then return a graceful fallback
  // finding so the visitor still gets a coherent response + the
  // lead-capture surface. The job completes with status='complete'
  // rather than 'error' — the frontend renders this as a Path-B-style
  // bot bubble + the inline lead form, not as a hiccups error.
  console.error('[bjl-public-chat-background] synthesizer returned unparseable output; falling back to graceful capture. Raw output (first 500 chars):', text.slice(0, 500));
  return {
    answer: "PETERMAYER's Brand Joy Lab hit a snag putting that answer together. "
          + "Want to leave the question with us? The team will take a real look and come back to you.",
    scope_taken: scope || 'in_corpus_scope',
    rows_used: [],
    provenance: [],
    updated_conversation_synthesis: conversation_synthesis || '',
    prompt_lead_capture: true,
    lead_capture_trigger_source: 'no_answer',
    _synthesizer_parse_failed: true,            // internal diagnostic
    _synthesizer_raw_head: text.slice(0, 200),  // trim head for trace
  };
}

// v6.6: capture-write logic moved out of this endpoint. The frontend now
// drives lead capture via a dedicated form (inline on no-answer, lightbox
// after consecutive queries). bjl-public-capture-lead.js is the new
// write endpoint; this function returns nothing capture-related.

// =============================================================
// Handler
// =============================================================

// v6.15 — Background worker handler.
//
// Invoked server-to-server by bjl-public-chat.js (the slim enqueue). The
// body carries { job_id }. We load the queued row from bjl_query_jobs,
// run the pipeline, and write the result back as the row's `finding`
// payload. The frontend polls bjl-public-chat-status for the result.
//
// Netlify Background Functions have a 15-minute timeout, so Sonnet
// variance stops being a category of failure here.
exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: 'invalid JSON' }; }

  const jobId = body.job_id;
  if (!jobId) return { statusCode: 400, body: 'missing job_id' };

  // Best-effort: flip the row to running so the status endpoint can
  // distinguish "queued, waiting on the dispatch" from "actively
  // processing." If this update fails, we still proceed.
  await supabase
    .from('bjl_query_jobs')
    .update({ status: 'running' })
    .eq('job_id', jobId);

  try {
    const { data: job, error: loadErr } = await supabase
      .from('bjl_query_jobs')
      .select('job_id, extra_context, query_type')
      .eq('job_id', jobId)
      .single();
    if (loadErr) throw new Error(`load job: ${loadErr.message}`);
    if (!job)    throw new Error('job not found');
    if (job.query_type !== 'public_chat') {
      throw new Error(`unexpected query_type=${job.query_type}`);
    }

    const ctx = job.extra_context || {};
    const question = (ctx.question || '').trim();
    if (!question) throw new Error('extra_context.question missing');
    const conversationSynthesis = typeof ctx.conversation_synthesis === 'string'
                                    ? ctx.conversation_synthesis.slice(0, 2000)
                                    : '';

    // Scope classification
    const scope = await classifyScope(question);

    // Retrieve across all seven layers (semantic + structured)
    const retrieved = await retrieve(question);

    // For decline paths (brand_specific / live_cut_requested / out_of_scope),
    // we still pass retrieved rows so the LLM can offer the nearest thing.
    const llmResult = await composeAnswer({
      question, scope, retrieved,
      conversation_synthesis: conversationSynthesis,
    });

    // Closest insight slugs the frontend can stash in case the visitor
    // submits the lead form. The form endpoint accepts these and writes
    // them to matched_insight_slugs on the captured row.
    const closestInsightSlugs = retrieved.insights
      .filter(r => Number.isFinite(Number(r.distance)) && Number(r.distance) <= CLOSEST_OFFER_DISTANCE)
      .map(r => r.slug)
      .slice(0, 3);
    const categoryGuess = (retrieved.insights[0] && retrieved.insights[0].category)
                        || (retrieved.scores[0]   && retrieved.scores[0].category)
                        || null;

    // v6.14: provenance is a small sanitized array surfaced to the
    // visitor in a footer beneath each answer. We pass through what the
    // LLM authored, capped at 8 entries and with field-level type guards
    // so a malformed entry can't break the frontend render.
    const provenance = Array.isArray(llmResult.provenance)
      ? llmResult.provenance
          .filter(p => p && typeof p === 'object')
          .slice(0, 8)
          .map(p => ({
            question: typeof p.question === 'string' ? p.question.slice(0, 400) : '',
            item:     typeof p.item     === 'string' ? p.item.slice(0, 200)     : '',
            metric:   typeof p.metric   === 'string' ? p.metric.slice(0, 60)    : '',
            value:    (typeof p.value === 'string' || typeof p.value === 'number')
                        ? p.value
                        : null,
            n:        Number.isFinite(Number(p.n)) ? Math.round(Number(p.n)) : null,
          }))
          .filter(p => p.question || p.item)
      : [];

    const finding = {
      answer:                          llmResult.answer || '',
      scope_taken:                     llmResult.scope_taken || scope,
      rows_used:                       llmResult.rows_used || [],
      provenance,
      updated_conversation_synthesis:  llmResult.updated_conversation_synthesis || '',
      prompt_lead_capture:             !!llmResult.prompt_lead_capture,
      lead_capture_trigger_source:     llmResult.lead_capture_trigger_source || null,
      closest_insight_slugs:           closestInsightSlugs,
      category_guess:                  categoryGuess,
    };

    await supabase.from('bjl_query_jobs').update({
      status:       'complete',
      finding:      JSON.stringify(finding),
      completed_at: new Date().toISOString(),
    }).eq('job_id', jobId);

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('[bjl-public-chat-background] error:', err);
    await supabase.from('bjl_query_jobs').update({
      status:       'error',
      error:        String(err && err.message ? err.message : err).slice(0, 1000),
      completed_at: new Date().toISOString(),
    }).eq('job_id', jobId);
    return { statusCode: 500, body: String(err && err.message ? err.message : err) };
  }
};
