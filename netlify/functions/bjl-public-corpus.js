/**
 * bjl-public-corpus.js — Workbench-side management for the Public Corpus.
 *
 * Auth: workbench-authenticated only (via bjl-auth-helper). Not a public
 * endpoint.
 *
 * Operations (action field in the body or ?action= query param):
 *   - list_insights:       GET. Returns all bjl_public_insights rows
 *                          (staged + live), ordered by published asc,
 *                          updated_at desc.
 *   - list_questions:      GET. Returns all bjl_public_questions rows
 *                          (captured visitor questions). Ordered by
 *                          created_at desc.
 *   - update_insight:      POST { id, ...patch }. Edits a row.
 *                          Allowed fields: title, insight, stat,
 *                          category, topic_tags, question_framings,
 *                          supporting_quote, confidence, source_n,
 *                          source_note, published.
 *   - delete_insight:      POST { id }. Hard-deletes a row.
 *   - update_question:     POST { id, status, ...patch }. Edits a
 *                          captured-question row. Allowed status:
 *                          new | reviewing | answered | closed.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const INSIGHT_EDITABLE = [
  'title','insight','stat','category','topic_tags','question_framings',
  'supporting_quote','confidence','source_n','source_note','published',
];
const QUESTION_EDITABLE = ['status','category_guess'];
const VALID_STATUSES = new Set(['new','reviewing','answered','closed']);

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function listInsights() {
  const { data, error } = await supabase
    .from('bjl_public_insights')
    .select('*')
    .order('published', { ascending: true })
    .order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function listQuestions() {
  const { data, error } = await supabase
    .from('bjl_public_questions')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function updateInsight(id, patch) {
  const cleanPatch = {};
  for (const key of INSIGHT_EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      cleanPatch[key] = patch[key];
    }
  }
  if (Object.keys(cleanPatch).length === 0) {
    return { error: 'no editable fields in patch' };
  }
  if (cleanPatch.confidence && !['high','medium'].includes(cleanPatch.confidence)) {
    return { error: 'confidence must be high or medium' };
  }
  cleanPatch.updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from('bjl_public_insights')
    .update(cleanPatch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) return { error: error.message };
  return { data };
}

async function deleteInsight(id) {
  const { error } = await supabase
    .from('bjl_public_insights')
    .delete()
    .eq('id', id);
  if (error) return { error: error.message };
  return { ok: true };
}

async function updateQuestion(id, patch) {
  const cleanPatch = {};
  for (const key of QUESTION_EDITABLE) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      cleanPatch[key] = patch[key];
    }
  }
  if (cleanPatch.status && !VALID_STATUSES.has(cleanPatch.status)) {
    return { error: 'invalid status' };
  }
  if (Object.keys(cleanPatch).length === 0) {
    return { error: 'no editable fields in patch' };
  }
  const { data, error } = await supabase
    .from('bjl_public_questions')
    .update(cleanPatch)
    .eq('id', id)
    .select('*')
    .single();
  if (error) return { error: error.message };
  return { data };
}

exports.handler = async (event) => {
  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return jsonResponse(auth.status, { error: auth.error, message: auth.message });
  }

  // Action can come from ?action= (GET-style) or JSON body
  const method = event.httpMethod;
  const queryAction = (event.queryStringParameters && event.queryStringParameters.action) || null;

  if (method === 'GET') {
    try {
      if (queryAction === 'list_insights' || !queryAction) {
        const insights = await listInsights();
        return jsonResponse(200, { insights });
      }
      if (queryAction === 'list_questions') {
        const questions = await listQuestions();
        return jsonResponse(200, { questions });
      }
      if (queryAction === 'list_all') {
        const [insights, questions] = await Promise.all([listInsights(), listQuestions()]);
        return jsonResponse(200, { insights, questions });
      }
      return jsonResponse(400, { error: `unknown GET action: ${queryAction}` });
    } catch (err) {
      console.error('[bjl-public-corpus] GET error:', err);
      return jsonResponse(500, { error: 'internal error', detail: String(err.message || err) });
    }
  }

  if (method !== 'POST') {
    return jsonResponse(405, { error: 'method not allowed' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return jsonResponse(400, { error: 'invalid JSON' }); }
  const action = body.action;

  try {
    if (action === 'update_insight') {
      if (!body.id) return jsonResponse(400, { error: 'id required' });
      const r = await updateInsight(body.id, body);
      return r.error ? jsonResponse(400, { error: r.error }) : jsonResponse(200, { insight: r.data });
    }
    if (action === 'delete_insight') {
      if (!body.id) return jsonResponse(400, { error: 'id required' });
      const r = await deleteInsight(body.id);
      return r.error ? jsonResponse(400, { error: r.error }) : jsonResponse(200, { ok: true });
    }
    if (action === 'update_question') {
      if (!body.id) return jsonResponse(400, { error: 'id required' });
      const r = await updateQuestion(body.id, body);
      return r.error ? jsonResponse(400, { error: r.error }) : jsonResponse(200, { question: r.data });
    }
    return jsonResponse(400, { error: `unknown POST action: ${action}` });
  } catch (err) {
    console.error('[bjl-public-corpus] POST error:', err);
    return jsonResponse(500, { error: 'internal error', detail: String(err.message || err) });
  }
};
