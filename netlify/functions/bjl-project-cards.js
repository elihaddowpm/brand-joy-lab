/**
 * bjl-project-cards.js — Save-to-project card CRUD.
 *
 * Replaces the "Add to public corpus" path with a per-project scratch
 * set the strategist assembles. A saved card carries the full insight
 * block (claim / frame / evidence / implication) plus the structured
 * synth payload the block drew from (provenance), so a Move 3 synthesis
 * run over a curated set can verify each card's numbers without
 * re-querying.
 *
 * Auth: workbench-authenticated only.
 *
 * GET  /bjl-project-cards?project_id=<uuid>  -> list cards in a project
 * POST /bjl-project-cards                    -> { action, ... }
 *   action = 'save' : {
 *     project_id, claim, frame?, evidence, implication?,
 *     provenance?, source_job_id?, source_block_index?,
 *     source_question?, strategist_notes?
 *   } -> { ok, card }
 *   action = 'update-notes': { id, strategist_notes } -> { ok, card }
 *   action = 'delete': { id }                          -> { ok }
 *   action = 'move'  : { id, target_project_id }       -> { ok, card }
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CARD_COLUMNS =
  'id, project_id, claim, frame, evidence, implication, provenance, ' +
  'source_job_id, source_block_index, source_question, strategist_notes, saved_at';

function validateBlockPayload(body) {
  if (!body || typeof body !== 'object') return 'body required';
  if (!body.project_id || typeof body.project_id !== 'string') return 'project_id required';
  if (!body.claim || typeof body.claim !== 'string') return 'claim required';
  if (!Array.isArray(body.evidence)) return 'evidence must be an array';
  return null;
}

async function saveCard(body) {
  const err = validateBlockPayload(body);
  if (err) return { statusCode: 400, error: err };

  // Confirm the project exists and is not archived — cheap, prevents
  // orphan writes if the frontend has a stale project id.
  const { data: proj, error: projErr } = await supabase
    .from('bjl_projects')
    .select('id, archived_at')
    .eq('id', body.project_id)
    .maybeSingle();
  if (projErr) return { statusCode: 500, error: `project lookup failed: ${projErr.message}` };
  if (!proj) return { statusCode: 404, error: 'project not found' };
  if (proj.archived_at) return { statusCode: 400, error: 'project is archived; unarchive before saving' };

  const insert = {
    project_id:         body.project_id,
    claim:              String(body.claim).trim(),
    frame:              body.frame ? String(body.frame).trim() : null,
    evidence:           body.evidence,
    implication:        body.implication ? String(body.implication).trim() : null,
    provenance:         body.provenance || null,
    source_job_id:      body.source_job_id || null,
    source_block_index: Number.isFinite(body.source_block_index) ? body.source_block_index : null,
    source_question:    body.source_question ? String(body.source_question).slice(0, 4000) : null,
    strategist_notes:   body.strategist_notes ? String(body.strategist_notes).trim() : null,
  };
  const { data, error } = await supabase
    .from('bjl_project_cards')
    .insert(insert)
    .select(CARD_COLUMNS)
    .single();
  if (error) return { statusCode: 500, error: `card save failed: ${error.message}` };
  return { statusCode: 201, card: data };
}

async function updateNotes(body) {
  const id = String(body.id || '').trim();
  if (!id) return { statusCode: 400, error: 'id required' };
  const notes = typeof body.strategist_notes === 'string' ? body.strategist_notes.trim() : null;
  const { data, error } = await supabase
    .from('bjl_project_cards')
    .update({ strategist_notes: notes || null })
    .eq('id', id)
    .is('deleted_at', null)
    .select(CARD_COLUMNS)
    .single();
  if (error) return { statusCode: 500, error: `notes update failed: ${error.message}` };
  if (!data) return { statusCode: 404, error: 'card not found' };
  return { statusCode: 200, card: data };
}

async function softDelete(body) {
  const id = String(body.id || '').trim();
  if (!id) return { statusCode: 400, error: 'id required' };
  const { error } = await supabase
    .from('bjl_project_cards')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null);
  if (error) return { statusCode: 500, error: `delete failed: ${error.message}` };
  return { statusCode: 200 };
}

async function moveCard(body) {
  const id = String(body.id || '').trim();
  const target = String(body.target_project_id || '').trim();
  if (!id || !target) return { statusCode: 400, error: 'id and target_project_id required' };
  const { data, error } = await supabase
    .from('bjl_project_cards')
    .update({ project_id: target })
    .eq('id', id)
    .is('deleted_at', null)
    .select(CARD_COLUMNS)
    .single();
  if (error) return { statusCode: 500, error: `move failed: ${error.message}` };
  if (!data) return { statusCode: 404, error: 'card not found' };
  return { statusCode: 200, card: data };
}

async function listCards(projectId) {
  if (!projectId) return { statusCode: 400, error: 'project_id required' };
  const { data, error } = await supabase
    .from('bjl_project_cards')
    .select(CARD_COLUMNS)
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('saved_at', { ascending: false });
  if (error) return { statusCode: 500, error: `list failed: ${error.message}` };
  return { statusCode: 200, cards: data || [] };
}

exports.handler = async (event) => {
  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message }),
    };
  }

  try {
    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};
      const r = await listCards(params.project_id);
      return {
        statusCode: r.statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(r.error ? { error: r.error } : { ok: true, cards: r.cards }),
      };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const action = String(body.action || '').trim();
      let r;
      if (action === 'save')          r = await saveCard(body);
      else if (action === 'update-notes') r = await updateNotes(body);
      else if (action === 'delete')   r = await softDelete(body);
      else if (action === 'move')     r = await moveCard(body);
      else return { statusCode: 400, body: JSON.stringify({ error: `unknown action '${action}'` }) };

      return {
        statusCode: r.statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(r.error ? { error: r.error } : (r.card ? { ok: true, card: r.card } : { ok: true })),
      };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'GET or POST only' }) };
  } catch (e) {
    console.error('[bjl-project-cards] handler error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
