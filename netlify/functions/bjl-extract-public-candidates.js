/**
 * bjl-extract-public-candidates.js — Workbench-side Haiku pass that
 * scans an Intelligence-pane synthesizer response and proposes 0–3
 * candidate insights for the Public Joy Lab Chat corpus (v6.1).
 *
 * Called automatically by the Intelligence pane after each completed
 * turn. Returns candidates the strategist can click to open the
 * staging modal with everything pre-filled.
 *
 * Auth: workbench-authenticated only (via bjl-auth-helper). Not public.
 *
 * Body shape:
 *   {
 *     original_question: string,
 *     response_text:     string,
 *     turn_id?:          string   // optional, for client-side bookkeeping
 *   }
 *
 * Response:
 *   { candidates: [...] }  // see prompts/public_candidate_extractor.md
 *
 * Failure mode: this function is best-effort. If the LLM call fails,
 * we return { candidates: [] } with a 200 — never a 5xx — so the
 * Intelligence-pane response flow is never blocked by extractor
 * problems.
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const PROMPTS = require('./_prompts_bundle.json');

const EXTRACTOR_MODEL = 'claude-haiku-4-5-20251001';
const MAX_RESPONSE_CHARS = 12000;          // hard cap before truncation
const MAX_CANDIDATES = 3;
const VALID_CONFIDENCE = new Set(['high', 'medium']);

function jsonResp(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function loadExistingCategories() {
  const { data, error } = await supabase
    .from('bjl_public_insights')
    .select('category')
    .order('category');
  if (error) return [];
  const set = new Set();
  for (const r of (data || [])) {
    if (r.category) set.add(r.category);
  }
  return [...set];
}

function sanitizeCandidate(c) {
  if (!c || typeof c !== 'object') return null;
  if (!c.title || typeof c.title !== 'string')   return null;
  if (!c.insight || typeof c.insight !== 'string') return null;
  if (!c.stat || typeof c.stat !== 'string')       return null;
  if (!c.category || typeof c.category !== 'string') return null;
  if (!VALID_CONFIDENCE.has(c.confidence))         return null;
  const sourceN = Number(c.source_n);
  if (!Number.isFinite(sourceN) || sourceN <= 0) return null;
  if (c.confidence === 'high'   && sourceN < 100) return null;  // contract
  if (c.confidence === 'medium' && sourceN < 30)  return null;

  return {
    title:             c.title.trim().slice(0, 200),
    insight:           c.insight.trim().slice(0, 2000),
    stat:              c.stat.trim().slice(0, 600),
    category:          c.category.trim().toLowerCase().slice(0, 60),
    topic_tags:        Array.isArray(c.topic_tags)
                         ? c.topic_tags.filter(t => typeof t === 'string').map(t => t.trim().toLowerCase()).slice(0, 12)
                         : [],
    question_framings: Array.isArray(c.question_framings)
                         ? c.question_framings.filter(q => typeof q === 'string' && q.trim().length > 0).map(q => q.trim()).slice(0, 6)
                         : [],
    confidence:        c.confidence,
    source_n:          Math.floor(sourceN),
    rationale:         typeof c.rationale === 'string' ? c.rationale.trim().slice(0, 400) : '',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResp(405, { candidates: [], error: 'POST only' });
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    // Don't break the Intelligence flow on auth issues — extractor is
    // a best-effort enhancement. Return empty.
    return jsonResp(auth.status || 401, { candidates: [], error: auth.error });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return jsonResp(400, { candidates: [], error: 'invalid JSON' }); }

  const originalQuestion = (body.original_question || '').trim();
  let responseText = (body.response_text || '').trim();
  if (!responseText) return jsonResp(200, { candidates: [] });
  if (responseText.length > MAX_RESPONSE_CHARS) {
    responseText = responseText.slice(0, MAX_RESPONSE_CHARS) + '\n\n[truncated]';
  }

  const systemPrompt = PROMPTS.publicCandidateExtractor;
  if (!systemPrompt) {
    console.error('[bjl-extract-public-candidates] prompt missing from bundle');
    return jsonResp(200, { candidates: [] });
  }

  try {
    const existingCategories = await loadExistingCategories();

    const userMessage = [
      'original_question:',
      originalQuestion || '(not provided)',
      '',
      `existing_categories: ${JSON.stringify(existingCategories)}`,
      '',
      'response_text:',
      responseText,
    ].join('\n');

    const rsp = await anthropic.messages.create({
      model: EXTRACTOR_MODEL,
      max_tokens: 2500,
      system: [{ type: 'text', text: systemPrompt }],
      messages: [{ role: 'user', content: userMessage }],
    });
    const text = (rsp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      console.error('[bjl-extract-public-candidates] LLM returned non-JSON:', text.slice(0, 200));
      return jsonResp(200, { candidates: [] });
    }

    const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    const candidates = rawCandidates
      .map(sanitizeCandidate)
      .filter(Boolean)
      .slice(0, MAX_CANDIDATES);

    return jsonResp(200, { candidates });
  } catch (err) {
    console.error('[bjl-extract-public-candidates] extractor failed:', err);
    return jsonResp(200, { candidates: [] });
  }
};
