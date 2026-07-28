/**
 * bjl-opportunities.js — the Opportunity Bulletin (layer 2).
 *
 * Reads the opportunity register plus the marketplace signals each
 * opportunity cites, and writes exactly one thing: the status
 * transition (plus an optional note). Everything else about an
 * opportunity is authored in an analysis session, not here.
 *
 * Contract:
 *   POST { action: 'list', engagement?: text }
 *     → { ok, engagements: [...], opportunities: [{ ..., signals: [...] }] }
 *   POST { action: 'set_status', opportunity_id: int,
 *          status: text, notes?: text }
 *     → { ok, opportunity }
 *   POST { action: 'create', engagement, title, claim_summary,
 *          claim_population, evidence_tier, action_text,
 *          claim_items?, signal_ids?, window_label?, owner?, notes? }
 *     → { ok, opportunity }
 *
 * Cards are authored from the map (the Send to Bulletin affordance on
 * a territory row or a profile finding), never invented here. Every
 * create lands at status='candidate'.
 *
 * Signals never join respondent tables — they are marketplace
 * observations, kept visibly distinct from measured claims.
 *
 * Auth: workbench-authenticated only.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// The status lifecycle from the spec. Enforced here because the column
// carries no CHECK constraint and this is the only write path.
const STATUSES = ['candidate', 'reviewed', 'selected', 'shipped', 'retired'];

function sqlEscape(s) { return String(s).replace(/'/g, "''"); }

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    try {
      await supabase.from('bjl_front_door_log').insert({
        query: 'opportunities',
        brief: {},
        surface: 'joy_map_bulletin',
        user_email: null,
        context: { auth_status: auth.status, auth_error: auth.error || null },
        auth_failed: true,
      });
    } catch (e) { console.warn('[opportunities] auth-failure log failed:', e.message); }
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message, auth_failed: true }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON body' }) }; }

  const action = body.action || 'list';

  try {
    if (action === 'create') {
      // The only write path that makes a card. The claim triple is
      // NOT NULL in the table; it is required here too so the failure
      // is a legible 400 rather than a Postgres constraint error.
      const text = (k) => (typeof body[k] === 'string' ? body[k].trim() : '');
      const required = {
        engagement:       text('engagement'),
        title:            text('title'),
        claim_summary:    text('claim_summary'),
        claim_population: text('claim_population'),
        evidence_tier:    text('evidence_tier'),
        action:           text('action_text'),
      };
      const missing = Object.keys(required).filter(k => !required[k]);
      if (missing.length > 0) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `missing required field(s): ${missing.map(k => k === 'action' ? 'action_text' : k).join(', ')}` }),
        };
      }

      const intArray = (k) => (Array.isArray(body[k])
        ? body[k].map(Number).filter(Number.isFinite).map(n => Math.trunc(n))
        : []);

      const row = {
        ...required,
        claim_items: intArray('claim_items'),
        signal_ids:  intArray('signal_ids'),
        status:      'candidate',
      };
      if (typeof body.window_label === 'string' && body.window_label.trim()) row.window_label = body.window_label.trim();
      if (typeof body.owner === 'string' && body.owner.trim())               row.owner = body.owner.trim();
      if (typeof body.notes === 'string' && body.notes.trim())               row.notes = body.notes.trim();

      const { data, error } = await supabase
        .from('bjl_opportunities')
        .insert(row)
        .select()
        .single();
      if (error) throw new Error(`opportunity insert failed: ${error.message}`);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, opportunity: data }),
      };
    }

    if (action === 'set_status') {
      const opportunityId = Number(body.opportunity_id);
      const status = typeof body.status === 'string' ? body.status.trim() : '';
      if (!Number.isFinite(opportunityId)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'opportunity_id required' }) };
      }
      if (!STATUSES.includes(status)) {
        return { statusCode: 400, body: JSON.stringify({ error: `status must be one of ${STATUSES.join(', ')}` }) };
      }
      const patch = { status, updated_at: new Date().toISOString() };
      if (typeof body.notes === 'string') patch.notes = body.notes;

      const { data, error } = await supabase
        .from('bjl_opportunities')
        .update(patch)
        .eq('opportunity_id', opportunityId)
        .select()
        .single();
      if (error) throw new Error(`status update failed: ${error.message}`);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, opportunity: data }),
      };
    }

    if (action !== 'list') {
      return { statusCode: 400, body: JSON.stringify({ error: `unknown action '${action}' — expected list, create, or set_status` }) };
    }

    const engagement = typeof body.engagement === 'string' ? body.engagement.trim() : '';
    const engagementFilter = engagement ? `WHERE engagement = '${sqlEscape(engagement)}'` : '';

    const oppSql = `
      SELECT opportunity_id, engagement, register_number, title,
             claim_summary, claim_population, claim_items, evidence_tier,
             signal_ids, action, window_label,
             lower(window_date) AS window_start, upper(window_date) AS window_end,
             owner, status, prediction_id, notes, created_at, updated_at
      FROM bjl_opportunities
      ${engagementFilter}
      ORDER BY engagement, register_number NULLS LAST, opportunity_id
    `;
    const { data: oppData, error: oppErr } = await supabase.rpc('execute_read_sql', { query_text: oppSql });
    if (oppErr) throw new Error(`bjl_opportunities read failed: ${oppErr.message}`);
    const oppRows = Array.isArray(oppData) ? oppData : [];

    // Signals for the same engagement scope. Small tables — one read,
    // joined in memory against signal_ids.
    const sigSql = `
      SELECT signal_id, engagement, source, theme, signal_type, headline,
             detail, exact_quote, urgency, source_url, owned_source,
             captured_at, superseded_by
      FROM bjl_marketplace_signals
      ${engagementFilter}
      ORDER BY captured_at DESC, signal_id
    `;
    const { data: sigData, error: sigErr } = await supabase.rpc('execute_read_sql', { query_text: sigSql });
    if (sigErr) throw new Error(`bjl_marketplace_signals read failed: ${sigErr.message}`);
    const sigRows = Array.isArray(sigData) ? sigData : [];

    const signalById = new Map();
    for (const s of sigRows) {
      signalById.set(Number(s.signal_id), {
        signal_id:     Number(s.signal_id),
        engagement:    s.engagement || null,
        source:        s.source || null,
        theme:         s.theme || null,
        signal_type:   s.signal_type || null,
        headline:      s.headline || null,
        detail:        s.detail || null,
        exact_quote:   s.exact_quote || null,
        urgency:       s.urgency || null,
        source_url:    s.source_url || null,
        owned_source:  !!s.owned_source,
        captured_at:   s.captured_at || null,
        superseded_by: s.superseded_by == null ? null : Number(s.superseded_by),
      });
    }

    const opportunities = oppRows.map(r => {
      const ids = Array.isArray(r.signal_ids) ? r.signal_ids.map(Number) : [];
      const signals = ids.map(id => signalById.get(id)).filter(Boolean);
      // Freshness is computed from the newest cited signal. A card with
      // no signals is legal — evergreen claims stand on the measured
      // evidence alone — and carries no freshness warning.
      let newestCapture = null;
      for (const s of signals) {
        if (s.captured_at && (!newestCapture || s.captured_at > newestCapture)) newestCapture = s.captured_at;
      }
      return {
        opportunity_id:    Number(r.opportunity_id),
        engagement:        r.engagement || null,
        register_number:   r.register_number == null ? null : Number(r.register_number),
        title:             r.title || null,
        claim_summary:     r.claim_summary || null,
        claim_population:  r.claim_population || null,
        claim_items:       Array.isArray(r.claim_items) ? r.claim_items : [],
        evidence_tier:     r.evidence_tier || null,
        signal_ids:        ids,
        signals,
        newest_signal_at:  newestCapture,
        action:            r.action || null,
        window_label:      r.window_label || null,
        window_start:      r.window_start || null,
        window_end:        r.window_end || null,
        owner:             r.owner || null,
        status:            r.status || null,
        prediction_id:     r.prediction_id == null ? null : Number(r.prediction_id),
        notes:             r.notes || null,
        created_at:        r.created_at || null,
        updated_at:        r.updated_at || null,
      };
    });

    const engagements = Array.from(new Set(opportunities.map(o => o.engagement).filter(Boolean))).sort();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, statuses: STATUSES, engagements, opportunities }),
    };
  } catch (e) {
    console.error('[opportunities] handler error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
