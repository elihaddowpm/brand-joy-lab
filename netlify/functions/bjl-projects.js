/**
 * bjl-projects.js — Project collection CRUD for the strategist workbench.
 *
 * Move 2 of the strategist redesign: projects are per-engagement scratch
 * sets a strategist saves insight cards to. The workbench maintains an
 * "active project" (localStorage) so a Save button targets the right
 * collection. This endpoint lists, creates, updates, and archives them.
 *
 * Auth: workbench-authenticated only.
 *
 * GET  /bjl-projects            -> list active projects (with card_count)
 * GET  /bjl-projects?include_archived=1 -> also return archived rows
 * POST /bjl-projects            -> { action, ... }
 *   action = 'create' : { name, notes?, slug? }             -> { ok, project }
 *   action = 'update' : { id, name?, notes? }               -> { ok, project }
 *   action = 'archive': { id }                              -> { ok }
 *   action = 'restore': { id }                              -> { ok }
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
    .slice(0, 96);
}

async function uniqueSlug(base) {
  const candidate = base || `project-${Date.now().toString(36)}`;
  for (let n = 0; n < 20; n++) {
    const trySlug = n === 0 ? candidate : `${candidate}-${n + 1}`;
    const { data, error } = await supabase
      .from('bjl_projects')
      .select('id')
      .eq('slug', trySlug)
      .maybeSingle();
    if (error) throw new Error(`slug lookup failed: ${error.message}`);
    if (!data) return trySlug;
  }
  return `${candidate}-${Date.now().toString(36)}`;
}

async function listProjects(includeArchived) {
  const q = supabase
    .from('bjl_projects')
    .select('id, name, slug, notes, created_at, updated_at, archived_at')
    .order('updated_at', { ascending: false });
  if (!includeArchived) q.is('archived_at', null);
  const { data, error } = await q;
  if (error) throw new Error(`project list failed: ${error.message}`);

  // Card counts per project — one round trip, grouped in JS.
  const ids = (data || []).map(p => p.id);
  const counts = {};
  if (ids.length) {
    const { data: cardRows, error: cardErr } = await supabase
      .from('bjl_project_cards')
      .select('project_id')
      .in('project_id', ids)
      .is('deleted_at', null);
    if (cardErr) throw new Error(`card count failed: ${cardErr.message}`);
    for (const r of (cardRows || [])) {
      counts[r.project_id] = (counts[r.project_id] || 0) + 1;
    }
  }
  return (data || []).map(p => ({ ...p, card_count: counts[p.id] || 0 }));
}

async function createProject(body) {
  const name = String(body.name || '').trim();
  if (!name) return { statusCode: 400, error: 'name required' };
  const slug = await uniqueSlug(body.slug ? slugify(body.slug) : slugify(name));
  const { data, error } = await supabase
    .from('bjl_projects')
    .insert({ name, slug, notes: body.notes ? String(body.notes).trim() : null })
    .select('id, name, slug, notes, created_at, updated_at, archived_at')
    .single();
  if (error) return { statusCode: 500, error: `create failed: ${error.message}` };
  return { statusCode: 201, project: { ...data, card_count: 0 } };
}

async function updateProject(body) {
  const id = String(body.id || '').trim();
  if (!id) return { statusCode: 400, error: 'id required' };
  const patch = {};
  if (typeof body.name === 'string') {
    const nm = body.name.trim();
    if (!nm) return { statusCode: 400, error: 'name cannot be empty' };
    patch.name = nm;
  }
  if (typeof body.notes === 'string') patch.notes = body.notes.trim() || null;
  if (Object.keys(patch).length === 0) return { statusCode: 400, error: 'no fields to update' };

  const { data, error } = await supabase
    .from('bjl_projects')
    .update(patch)
    .eq('id', id)
    .select('id, name, slug, notes, created_at, updated_at, archived_at')
    .single();
  if (error) return { statusCode: 500, error: `update failed: ${error.message}` };
  return { statusCode: 200, project: data };
}

async function setArchived(id, archived) {
  if (!id) return { statusCode: 400, error: 'id required' };
  const { error } = await supabase
    .from('bjl_projects')
    .update({ archived_at: archived ? new Date().toISOString() : null })
    .eq('id', id);
  if (error) return { statusCode: 500, error: `archive toggle failed: ${error.message}` };
  return { statusCode: 200 };
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
      const includeArchived = params.include_archived === '1' || params.include_archived === 'true';
      const projects = await listProjects(includeArchived);
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, projects }),
      };
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const action = String(body.action || '').trim();
      if (action === 'create') {
        const r = await createProject(body);
        return {
          statusCode: r.statusCode,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(r.error ? { error: r.error } : { ok: true, project: r.project }),
        };
      }
      if (action === 'update') {
        const r = await updateProject(body);
        return {
          statusCode: r.statusCode,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(r.error ? { error: r.error } : { ok: true, project: r.project }),
        };
      }
      if (action === 'archive' || action === 'restore') {
        const r = await setArchived(String(body.id || '').trim(), action === 'archive');
        return {
          statusCode: r.statusCode,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(r.error ? { error: r.error } : { ok: true }),
        };
      }
      return { statusCode: 400, body: JSON.stringify({ error: `unknown action '${action}'` }) };
    }

    return { statusCode: 405, body: JSON.stringify({ error: 'GET or POST only' }) };
  } catch (e) {
    console.error('[bjl-projects] handler error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
