/**
 * bjl-public-chat.js — Public Joy Lab Chat answer endpoint (v6.3, three-layer).
 *
 * v6 (single-table): retrieved only from bjl_public_insights.
 * v6.3 (this version): retrieves across the full three-layer substrate:
 *   - Structured numbers (bjl_public_scores, bjl_public_ordinal)
 *      via tokenized ILIKE on item_name + question_label + category
 *   - Semantic frame/voice/story (bjl_laws, bjl_public_verbatim_truths,
 *      bjl_public_insights) via OpenAI text-embedding-3-small +
 *      pgvector cosine search
 *
 * Surface: cross-origin POST from the embeddable chat page (joylab Netlify
 * deploy) inside an iframe on peteramayer.com. NO auth (public-facing).
 * Service role on the Supabase side.
 *
 * Body shape:
 *   { question: string, email?: string, user_context?: string }
 *
 * Response shape:
 *   {
 *     answer: string,
 *     scope_taken: 'in_corpus_scope'|'brand_specific'|'live_cut_requested'|'out_of_scope'|'no_match',
 *     rows_used: string[],
 *     captured: boolean,
 *     capture_id?: string,
 *   }
 *
 * Gates honored:
 *   - bjl_public_scores            WHERE public_safe = true
 *   - bjl_public_ordinal           WHERE public_safe = true
 *   - bjl_laws                     WHERE public_safe = true
 *   - bjl_public_verbatim_truths   WHERE public_safe = true
 *   - bjl_public_insights          WHERE published   = true
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
  scores:        5,
  ordinal:       3,
  agreement:     4,   // v6.4 — agreement-battery % shares (X% strongly agree, X% net agree)
  distributions: 4,   // v6.4 — frequency / describe-grid polarity-summed shares
  laws:          3,
  insights:      3,
  truths:        2,
};

const DEFAULT_ALLOWED_ORIGINS = [
  'https://peteramayer.com',
  'https://www.peteramayer.com',
  'http://localhost:8888',
];
const ALLOWED_ORIGINS = (process.env.PUBLIC_CHAT_ALLOWED_ORIGINS
  ? process.env.PUBLIC_CHAT_ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : DEFAULT_ALLOWED_ORIGINS);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

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

// =============================================================
// Scope classifier (Haiku) — unchanged behavior from v6
// =============================================================

async function classifyScope(question) {
  const system = `You are a scope classifier for a public-facing joy chat. Given a visitor's question, output a JSON object with one field:

  "scope": "in_corpus_scope" | "brand_specific" | "live_cut_requested" | "out_of_scope"

Rules:
- "brand_specific": names a specific brand, product, or company and asks for analysis of THAT entity (e.g., "How do Disney visitors feel?"). General category questions are NOT brand_specific.
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

  // Build OR-of-ILIKE for each token across the three searchable columns.
  // Score = number of distinct tokens that hit anywhere on the row.
  // 795 rows total — full scan is fine.
  const conds = tokens.map(t => {
    const tEsc = sqlEscape(t);
    return `(item_name ILIKE '%${tEsc}%' OR question_label ILIKE '%${tEsc}%' OR category ILIKE '%${tEsc}%')`;
  });
  const scoreExpr = tokens.map(t => {
    const tEsc = sqlEscape(t);
    return `(CASE WHEN (item_name ILIKE '%${tEsc}%' OR question_label ILIKE '%${tEsc}%' OR category ILIKE '%${tEsc}%') THEN 1 ELSE 0 END)`;
  }).join(' + ');

  const sql = `
    SELECT item_id, item_name, question_label, category, joy_index, n, question_type,
           (${scoreExpr})::int AS hit_count
    FROM bjl_public_scores
    WHERE public_safe = true
      AND (${conds.join(' OR ')})
    ORDER BY hit_count DESC, n DESC NULLS LAST
    LIMIT ${PER_LAYER_LIMITS.scores}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) {
    console.error('[bjl-public-chat] retrieveScores error:', error.message);
    return [];
  }
  return (data || []).filter(r => r.hit_count >= STRUCTURED_MIN_HITS);
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
  return (data || []).filter(r => r.hit_count >= STRUCTURED_MIN_HITS);
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
  return (data || []).filter(r => r.hit_count >= STRUCTURED_MIN_HITS);
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
  return (data || []).filter(r => r.hit_count >= STRUCTURED_MIN_HITS);
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

  const structuredPromises = [
    retrieveScores(question),
    retrieveOrdinal(question),
    retrieveAgreement(question),       // v6.4
    retrieveDistributions(question),   // v6.4
  ];

  let semanticPromises;
  if (semanticAvailable) {
    const vecLit = vectorLiteral(queryEmbedding);
    semanticPromises = [
      retrieveLawsSemantic(vecLit),
      retrieveInsightsSemantic(vecLit),
      retrieveTruthsSemantic(vecLit),
    ];
  } else {
    // Token fallback for the insights layer only — laws + truths have no
    // searchable text columns that ILIKE would help on.
    semanticPromises = [
      Promise.resolve([]),
      retrieveInsightsTokenFallback(question),
      Promise.resolve([]),
    ];
  }

  const [scores, ordinal, agreement, distributions, laws, insights, truths] = await Promise.all([
    ...structuredPromises,
    ...semanticPromises,
  ]);

  // Does anything clear the answer threshold?
  const bestSemanticDistance = Math.min(
    ...[...laws, ...insights, ...truths]
      .map(r => Number(r.distance))
      .filter(d => Number.isFinite(d)),
    Infinity,
  );
  const hasStrongSemantic = bestSemanticDistance <= SEMANTIC_DISTANCE_THRESHOLD;
  const hasStrongStructured =
    (scores.length + ordinal.length + agreement.length + distributions.length) > 0;

  return {
    scores, ordinal, agreement, distributions, laws, insights, truths,
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
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

// v6.6: capture-write logic moved out of this endpoint. The frontend now
// drives lead capture via a dedicated form (inline on no-answer, lightbox
// after consecutive queries). bjl-public-capture-lead.js is the new
// write endpoint; this function returns nothing capture-related.

// =============================================================
// Handler
// =============================================================

exports.handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid JSON' }) };
  }
  const question = (body.question || '').trim();
  if (!question) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'question required' }) };
  }
  if (question.length > 2000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'question too long' }) };
  }

  try {
    // v6.6: visitor session context
    const conversationSynthesis = typeof body.conversation_synthesis === 'string'
                                    ? body.conversation_synthesis.slice(0, 2000)
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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        answer:                          llmResult.answer || '',
        scope_taken:                     llmResult.scope_taken || scope,
        rows_used:                       llmResult.rows_used || [],
        updated_conversation_synthesis:  llmResult.updated_conversation_synthesis || '',
        prompt_lead_capture:             !!llmResult.prompt_lead_capture,
        lead_capture_trigger_source:     llmResult.lead_capture_trigger_source || null,
        closest_insight_slugs:           closestInsightSlugs,
        category_guess:                  categoryGuess,
      }),
    };
  } catch (err) {
    console.error('[bjl-public-chat] error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'internal error',
        answer: "Something went wrong on our side. Please try again in a moment, or use the contact page if you'd like to reach the team directly.",
      }),
    };
  }
};
