/**
 * bjl-content.js — synchronous lookup for case studies and articles
 *
 * POST body:
 *   {
 *     type:          "case_study" | "article",
 *     category:      string,
 *     pain_keywords: string[],
 *     batch_index:   number      // case_study only; preserves cross-contact rotation
 *   }
 *
 * Response:
 *   { found: true,  type, data: { ... whitelisted fields ... } }
 *   { found: false, type }
 *
 * Scoring: count overlap between row tags (use_for_tags for case studies,
 * tags for articles) and the caller's pain_keywords, +1 if the prospect
 * category appears in those tags. Sort descending; return ranked[batch_index
 * % ranked.length] for case studies (so multiple contacts at the same
 * account get different primary cases when overlap profiles are similar),
 * or ranked[0] for articles.
 *
 * Anon-key reads are sufficient: RLS is disabled on both bjl_case_studies
 * and bjl_articles. Both tables are small (single-digit row counts) so
 * client-side ranking after a full fetch is the simplest correct shape.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const VALID_TYPES = ['case_study', 'article'];

const CASE_STUDY_FIELDS = [
  'identifier', 'client', 'campaign', 'when_note',
  'situation', 'strategic_move', 'work',
  'results', 'results_type', 'parallel_type',
  'email_usage_note', 'use_for_tags',
].join(', ');

const ARTICLE_FIELDS = [
  'title', 'author', 'url', 'summary', 'key_findings', 'tags',
].join(', ');

const CASE_STUDY_RETURN = [
  'identifier', 'client', 'campaign', 'when_note',
  'situation', 'strategic_move', 'work',
  'results', 'results_type', 'parallel_type', 'email_usage_note',
];

const ARTICLE_RETURN = ['title', 'author', 'url', 'summary', 'key_findings'];

function pick(row, keys) {
  const out = {};
  for (const k of keys) out[k] = row[k];
  return out;
}

function scoreRow(rowTags, painKeywords, category) {
  const tags = Array.isArray(rowTags) ? rowTags : [];
  const kws = Array.isArray(painKeywords) ? painKeywords : [];
  const cat = (category || '').trim();
  const tagSet = new Set(tags.map(t => String(t).toLowerCase()));
  let score = 0;
  for (const kw of kws) {
    if (tagSet.has(String(kw).toLowerCase())) score += 1;
  }
  if (cat && tagSet.has(cat.toLowerCase())) score += 1;
  return score;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!VALID_TYPES.includes(body.type)) {
    return { statusCode: 400, body: JSON.stringify({ error: `type must be one of ${VALID_TYPES.join(', ')}` }) };
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message, email: auth.email }),
    };
  }

  const category      = typeof body.category === 'string' ? body.category : '';
  const painKeywords  = Array.isArray(body.pain_keywords) ? body.pain_keywords : [];
  const batchIndex    = Number.isFinite(body.batch_index) ? body.batch_index : 0;

  try {
    if (body.type === 'case_study') {
      const { data, error } = await supabase
        .from('bjl_case_studies')
        .select(CASE_STUDY_FIELDS)
        .eq('is_active', true);
      if (error) {
        console.error('[bjl-content] case_studies query error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Lookup failed', detail: error.message }) };
      }
      const rows = data || [];
      if (rows.length === 0) {
        return { statusCode: 200, body: JSON.stringify({ found: false, type: 'case_study' }) };
      }
      const ranked = rows
        .map(r => ({ row: r, score: scoreRow(r.use_for_tags, painKeywords, category) }))
        .sort((a, b) => b.score - a.score);
      const idx = ((batchIndex % ranked.length) + ranked.length) % ranked.length;
      const chosen = ranked[idx].row;
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ found: true, type: 'case_study', data: pick(chosen, CASE_STUDY_RETURN) }),
      };
    }

    // article
    const { data, error } = await supabase
      .from('bjl_articles')
      .select(ARTICLE_FIELDS)
      .eq('is_active', true);
    if (error) {
      console.error('[bjl-content] articles query error:', error);
      return { statusCode: 500, body: JSON.stringify({ error: 'Lookup failed', detail: error.message }) };
    }
    const rows = data || [];
    if (rows.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ found: false, type: 'article' }) };
    }
    const ranked = rows
      .map(r => ({ row: r, score: scoreRow(r.tags, painKeywords, category) }))
      .sort((a, b) => b.score - a.score);
    const chosen = ranked[0].row;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ found: true, type: 'article', data: pick(chosen, ARTICLE_RETURN) }),
    };
  } catch (e) {
    console.error('[bjl-content] unexpected error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Unexpected error', detail: e.message }) };
  }
};
