/**
 * bjl-public-promote.js — Promote-to-public pipeline endpoint.
 *
 * Called from the workbench when a strategist clicks "Publish to public"
 * on a finding (Audience Map section / Intelligence pane finding / Dance
 * Map card). Writes a STAGED row to bjl_public_insights (published=false).
 * A human reviews the staged row in the Public Corpus pane and flips
 * published=true.
 *
 * Auth: workbench-authenticated only (via bjl-auth-helper). Not a public
 * endpoint.
 *
 * Body shape:
 *   {
 *     slug:             string  (kebab-case unique handle)
 *     title:            string  (the argument-winning headline)
 *     insight:          string  (plain-English finding)
 *     stat?:            string  (supporting number, framed simply)
 *     category:         string
 *     topic_tags?:      string[]
 *     question_framings?: string[]
 *     supporting_quote?: string
 *     confidence?:      'high' | 'medium'         (default 'high')
 *     source_n?:        number
 *     source_note?:     string
 *     created_from?:    string  (e.g. 'intelligence:job_id=...', 'audience_map:job_id=...')
 *   }
 *
 * Response: { ok: true, slug, id }   (201 on create, 200 on slug-existed)
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function validate(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.title || typeof body.title !== 'string') return 'title required';
  if (!body.insight || typeof body.insight !== 'string') return 'insight required';
  if (!body.category || typeof body.category !== 'string') return 'category required';
  if (body.confidence && !['high','medium'].includes(body.confidence)) {
    return 'confidence must be high or medium';
  }
  if (body.topic_tags && !Array.isArray(body.topic_tags)) return 'topic_tags must be array';
  if (body.question_framings && !Array.isArray(body.question_framings)) return 'question_framings must be array';
  return null;
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

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON' }) }; }
  const err = validate(body);
  if (err) return { statusCode: 400, body: JSON.stringify({ error: err }) };

  const slug = (body.slug && body.slug.trim()) || slugify(body.title);
  if (!slug) return { statusCode: 400, body: JSON.stringify({ error: 'slug could not be derived' }) };

  const insertRow = {
    slug,
    title: body.title.trim(),
    insight: body.insight.trim(),
    stat: body.stat ? body.stat.trim() : null,
    category: body.category.trim(),
    topic_tags: Array.isArray(body.topic_tags) ? body.topic_tags.filter(Boolean).slice(0, 20) : [],
    question_framings: Array.isArray(body.question_framings) ? body.question_framings.filter(Boolean).slice(0, 12) : [],
    supporting_quote: body.supporting_quote ? body.supporting_quote.trim() : null,
    confidence: body.confidence || 'high',
    source_n: typeof body.source_n === 'number' ? body.source_n : null,
    source_note: body.source_note ? body.source_note.trim() : null,
    created_from: body.created_from || 'workbench_promote',
    published: false,    // ALWAYS staged. Human reviews + flips in Public Corpus pane.
  };

  // Upsert by slug — if a staged row with the same slug exists, return it
  // (200) rather than erroring on the unique constraint. Strategist can
  // edit the existing staged row in the review pane.
  const { data: existing } = await supabase
    .from('bjl_public_insights')
    .select('id, slug, published')
    .eq('slug', slug)
    .maybeSingle();

  if (existing) {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, slug, id: existing.id, already_existed: true, published: existing.published }),
    };
  }

  const { data: inserted, error: insErr } = await supabase
    .from('bjl_public_insights')
    .insert(insertRow)
    .select('id, slug')
    .single();
  if (insErr) {
    console.error('[bjl-public-promote] insert error:', insErr);
    return { statusCode: 500, body: JSON.stringify({ error: 'insert failed', detail: insErr.message }) };
  }

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, slug: inserted.slug, id: inserted.id, already_existed: false, published: false }),
  };
};
