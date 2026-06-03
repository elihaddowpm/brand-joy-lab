/**
 * bjl-public-chat.js — Public Joy Lab Chat answer endpoint (v6 Public Chat).
 *
 * Surface: cross-origin POST from the embeddable chat page (joylab Netlify
 * deploy) inside an iframe on petermayer.com. NO auth (public-facing).
 * Service role on the Supabase side. Returns an answer or a no-match
 * capture acknowledgement.
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
 * Pipeline:
 *   1. Lightweight scope classifier (Haiku) — in_corpus / brand_specific /
 *      live_cut_requested / out_of_scope.
 *   2. Multi-channel retrieval over published rows (topic_tags + framings +
 *      title/insight token overlap), normalized 0–1.
 *   3. Compose answer via Sonnet with strict grounding rules.
 *   4. On no-match / brand-specific / live-cut paths: write a
 *      bjl_public_questions row.
 *
 * Match threshold: starts at 0.45 (conservative — wrong-but-confident in
 * public is worse than an honest miss). Tunable via MATCH_THRESHOLD const.
 *
 * CORS: Access-Control-Allow-Origin allows petermayer.com (configurable
 * via PUBLIC_CHAT_ALLOWED_ORIGINS env var, comma-separated).
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const PROMPTS = require('./_prompts_bundle.json');

const SCOPE_MODEL = 'claude-haiku-4-5-20251001';
const ANSWER_MODEL = 'claude-sonnet-4-6';

const MATCH_THRESHOLD = 0.45;        // top row must clear this to compose
const CLOSEST_OFFER_FLOOR = 0.30;    // below threshold but worth surfacing as "closest"
const MAX_RETRIEVED = 3;

const DEFAULT_ALLOWED_ORIGINS = [
  'https://petermayer.com',
  'https://www.petermayer.com',
  'http://localhost:8888',           // local dev
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

function tokenize(s) {
  return (s || '').toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

const STOPWORDS = new Set([
  'the','and','for','are','that','this','with','from','what','does','did','was','were','been','have','has','had','about','their','they','them','some','more','than','then','can','could','would','should','will','will','any','our','out','how','why','who','where','when','which','whom','your','you','one','two','also','into','over','onto','very','much','most','few','still','just','only','like','because','through','during','before','after','between','among','these','those','being','make','made','let','say','said','says','tell','told','think','thought','know','known','want','wants','use','using','need','needs','look','looks','found','find','findings','data','people','person','around','really','pretty','quite','sort','kind'
]);

function scoreRow(row, queryTokens, queryText) {
  // Three channels, weighted, normalized to 0–1
  // (a) topic_tags ∩ query tokens : weight 0.4
  // (b) question_framings best-fuzzy : weight 0.4
  // (c) title + insight ILIKE token overlap : weight 0.2

  const querySet = new Set(queryTokens);

  // (a) topic_tags overlap
  const tagTokens = (row.topic_tags || [])
    .flatMap(t => tokenize(String(t)));
  const tagSet = new Set(tagTokens);
  const tagHits = [...querySet].filter(t => !STOPWORDS.has(t) && tagSet.has(t)).length;
  const tagScore = querySet.size === 0 ? 0 : Math.min(1, tagHits / 2);  // 2 hits = max

  // (b) question_framings best-fuzzy — bag-of-words Jaccard against each framing
  let bestFramingScore = 0;
  for (const framing of (row.question_framings || [])) {
    const framingTokens = new Set(tokenize(framing).filter(t => !STOPWORDS.has(t)));
    const qContent = new Set([...querySet].filter(t => !STOPWORDS.has(t)));
    if (framingTokens.size === 0 || qContent.size === 0) continue;
    const intersection = [...qContent].filter(t => framingTokens.has(t)).length;
    const union = new Set([...framingTokens, ...qContent]).size;
    const jaccard = union > 0 ? intersection / union : 0;
    if (jaccard > bestFramingScore) bestFramingScore = jaccard;
  }
  // Boost framings since they're explicit "this answers" tags
  const framingScore = Math.min(1, bestFramingScore * 1.5);

  // (c) title + insight ILIKE token overlap (content match)
  const contentText = `${row.title || ''} ${row.insight || ''}`.toLowerCase();
  let contentHits = 0;
  const contentCandidates = [...querySet].filter(t => !STOPWORDS.has(t));
  for (const t of contentCandidates) {
    if (contentText.includes(t)) contentHits++;
  }
  const contentScore = contentCandidates.length === 0
    ? 0
    : Math.min(1, contentHits / Math.max(2, contentCandidates.length * 0.5));

  return 0.4 * tagScore + 0.4 * framingScore + 0.2 * contentScore;
}

async function classifyScope(question) {
  // Lightweight Haiku call to bucket the question.
  const system = `You are a scope classifier for a public-facing joy chat. Given a visitor's question, output a JSON object with one field:

  "scope": "in_corpus_scope" | "brand_specific" | "live_cut_requested" | "out_of_scope"

Rules:
- "brand_specific": the question names a specific brand, product, or company and asks for analysis of THAT entity. Examples: "What does the data say about Nike?", "How do Disney visitors feel?", "Is Trader Joe's beating Whole Foods?". General category questions like "what makes grocery shopping joyful" are NOT brand_specific.
- "live_cut_requested": the visitor asked for a custom analysis, cross-tab, demographic cut, or any "give me the breakdown by X" style request. Examples: "show me joy by income bracket", "cross-tab fandom and age", "run a query on Gen Z".
- "out_of_scope": not about consumer joy or behavior at all (greetings, weather, off-topic, troll, request to do something other than answer questions).
- "in_corpus_scope": everything else — a question about general consumer joy patterns, category-level findings, audience truths, that the curated corpus might answer.

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

async function retrieve(question) {
  const { data: rows, error } = await supabase
    .from('bjl_public_insights')
    .select('slug,title,insight,stat,category,topic_tags,question_framings,supporting_quote,confidence,source_n,source_note')
    .eq('published', true);
  if (error) throw new Error(`retrieve: ${error.message}`);

  const tokens = tokenize(question);
  const scored = (rows || [])
    .map(r => ({ row: r, score: scoreRow(r, tokens, question) }))
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, MAX_RETRIEVED);
}

async function composeAnswer({ question, scope, retrieved, thresholdCleared }) {
  const systemPrompt = PROMPTS.publicChatSynthesis;
  if (!systemPrompt) throw new Error('public_chat_synthesis prompt missing from bundle');

  const userMessage = [
    `question: ${question}`,
    '',
    `scope: ${scope}`,
    '',
    `match_score: ${retrieved.length > 0 ? retrieved[0].score.toFixed(3) : 'null'}`,
    `threshold_cleared: ${thresholdCleared}`,
    '',
    `retrieved_rows: ${JSON.stringify(retrieved.map(r => ({
      slug: r.row.slug,
      title: r.row.title,
      insight: r.row.insight,
      stat: r.row.stat,
      category: r.row.category,
      confidence: r.row.confidence,
      supporting_quote: r.row.supporting_quote,
      source_n: r.row.source_n,
      source_note: r.row.source_note,
      _score: Number(r.score.toFixed(3)),
    })), null, 2)}`,
  ].join('\n');

  const rsp = await anthropic.messages.create({
    model: ANSWER_MODEL,
    max_tokens: 800,
    system: [{ type: 'text', text: systemPrompt }],
    messages: [{ role: 'user', content: userMessage }],
  });
  const text = (rsp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

async function captureQuestion({ question, email, userContext, scope, closestSlugs, categoryGuess }) {
  const insertRow = {
    question: question.slice(0, 2000),
    email: email ? String(email).slice(0, 200) : null,
    category_guess: categoryGuess || null,
    matched_insight_slugs: closestSlugs || [],
    status: 'new',
    user_context: userContext ? String(userContext).slice(0, 500) : null,
  };
  const { data, error } = await supabase
    .from('bjl_public_questions')
    .insert(insertRow)
    .select('id')
    .single();
  if (error) {
    console.error('[bjl-public-chat] capture insert error:', error);
    return null;
  }

  // TODO(crm): push to CRM (HubSpot? Salesforce? other?) once Eli
  // confirms target system + field mapping. Field mapping draft:
  //   question         → CRM 'Initial question'
  //   email            → CRM 'Email' (create / merge contact)
  //   category_guess   → CRM 'Topic'
  //   matched_insight_slugs → CRM 'Closest insights' (multi-line text)
  //   user_context     → CRM 'Notes'
  //   status='new'     → CRM 'Lead status: New from Public Chat'
  // Until then the bjl_public_questions row is the lead record; team
  // pulls from there.

  return data && data.id;
}

exports.handler = async (event) => {
  const origin = event.headers && (event.headers.origin || event.headers.Origin) || '';
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
    // Pass 1 — scope
    const scope = await classifyScope(question);

    // For decline paths, we still retrieve (to surface a closest insight
    // when capturing), but we don't compose from rows.
    const retrieved = await retrieve(question);
    const topScore = retrieved.length > 0 ? retrieved[0].score : 0;
    const thresholdCleared = (scope === 'in_corpus_scope') && (topScore >= MATCH_THRESHOLD);

    const llmResult = await composeAnswer({
      question, scope, retrieved, thresholdCleared,
    });

    // Capture path: write a row when the LLM (or our scope router) flags it
    let captureId = null;
    if (llmResult.capture_question) {
      const closestSlugs = (llmResult.closest_slugs_for_capture && llmResult.closest_slugs_for_capture.length > 0)
        ? llmResult.closest_slugs_for_capture
        : retrieved.filter(r => r.score >= CLOSEST_OFFER_FLOOR).map(r => r.row.slug);
      const categoryGuess = retrieved[0] ? retrieved[0].row.category : null;
      captureId = await captureQuestion({
        question,
        email: body.email,
        userContext: body.user_context,
        scope: llmResult.scope_taken || scope,
        closestSlugs,
        categoryGuess,
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        answer: llmResult.answer || '',
        scope_taken: llmResult.scope_taken || scope,
        rows_used: llmResult.rows_used || [],
        captured: !!captureId,
        capture_id: captureId,
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
