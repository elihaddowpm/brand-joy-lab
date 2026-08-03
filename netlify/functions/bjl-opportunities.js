/**
 * bjl-opportunities.js — the Opportunity Bulletin (layer 2).
 *
 * Reads the opportunity register plus the marketplace signals each
 * opportunity cites, and writes exactly one thing: the status
 * transition (plus an optional note). Everything else about an
 * opportunity is authored in an analysis session, not here.
 *
 * Contract:
 *   POST { action: 'list', engagement?: text,
 *          include_machine_drafts?: bool }
 *     → { ok, engagements: [...], opportunities: [{ ..., signals: [...] }] }
 *   POST { action: 'set_status', opportunity_id: int,
 *          status: text, notes?: text }
 *     → { ok, opportunity }
 *   POST { action: 'create', engagement, title, claim_summary,
 *          claim_population, evidence_tier, action_text,
 *          claim_items?, signal_ids?, window_label?, owner?, notes? }
 *     → { ok, opportunity }
 *   POST { action: 'promote', opportunity_id: int, notes?: text }
 *     → { ok, opportunity }   // machine_draft -> candidate, recorded
 *
 * Cards are authored from a run (the Capture this finding affordance on
 * a map row, a profile finding, or an investigation result), never
 * invented here. Every create lands at status='candidate'.
 *
 * Machine drafts are the exception, and they are kept apart structurally
 * rather than by convention. The run-level harvest writes them directly
 * at status='machine_draft' with origin='harvest'; this endpoint cannot
 * set that status, does not return those rows from `list` unless they
 * are asked for by name, and turns them into cards only through
 * `promote`, which stamps the promoter from the verified token. The
 * effect is that a paragraph no human has read cannot appear in the
 * register looking authored — not because every view remembers to check
 * a flag, but because it is not in the list the views are given.
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

// The status lifecycle from the spec. Also a CHECK constraint on the
// column as of 2026-07-31_bulletin_provenance.sql; kept here so a bad
// status is a legible 400 rather than a Postgres constraint error.
//
// machine_draft sits at the front because it is UPSTREAM of candidate,
// not a branch off it. It is where the run-level harvest writes, and it
// is not a status anything can be set to through this endpoint: harvest
// creates it, promotion leaves it, nothing returns to it.
const STATUSES = ['machine_draft', 'candidate', 'reviewed', 'selected', 'shipped', 'retired'];
const ANALYST_STATUSES = STATUSES.filter(s => s !== 'machine_draft');

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
      // machine_draft is deliberately not settable. Only the harvest
      // writes it, and a card that has been through a human's hands must
      // not be able to put that back on — an authored card wearing a
      // machine_draft status would be excluded from the default list and
      // quietly disappear from the register.
      if (!ANALYST_STATUSES.includes(status)) {
        return { statusCode: 400, body: JSON.stringify({ error: `status must be one of ${ANALYST_STATUSES.join(', ')}` }) };
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

    if (action === 'promote') {
      // The one door out of machine_draft, and the only place a machine
      // draft becomes a card in the register. It is a human act by
      // definition, so it is recorded as one: promoted_by comes from the
      // verified token, never from the request body, because a field the
      // client can set is not a record of who did anything.
      const opportunityId = Number(body.opportunity_id);
      if (!Number.isFinite(opportunityId)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'opportunity_id required' }) };
      }
      const promotedBy = (auth.user && auth.user.email) || 'auth-bypass';
      const patch = {
        status: 'candidate',
        promoted_by: promotedBy,
        promoted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      if (typeof body.notes === 'string') patch.notes = body.notes;

      // Scoped to machine_draft. Promoting an already-promoted card would
      // overwrite the first promoter's name with the second reader's,
      // which is worse than doing nothing: it looks like a record and
      // isn't one. No match means no rows, which is the 404 below.
      const { data, error } = await supabase
        .from('bjl_opportunities')
        .update(patch)
        .eq('opportunity_id', opportunityId)
        .eq('status', 'machine_draft')
        .select();
      if (error) throw new Error(`promote failed: ${error.message}`);
      if (!Array.isArray(data) || data.length === 0) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `opportunity ${opportunityId} is not a machine draft — nothing to promote` }),
        };
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, opportunity: data[0] }),
      };
    }

    if (action !== 'list') {
      return { statusCode: 400, body: JSON.stringify({ error: `unknown action '${action}' — expected list, create, set_status, or promote` }) };
    }

    const engagement = typeof body.engagement === 'string' ? body.engagement.trim() : '';
    const engagementFilter = engagement ? `WHERE engagement = '${sqlEscape(engagement)}'` : '';

    // Machine drafts are out of the register unless they are asked for by
    // name. This is the half of the guarantee that lives here; the other
    // half is the status value itself, which no client can set. A card
    // nobody has read cannot appear in a list of cards, and it cannot get
    // there by a render-time flag check being forgotten in one view.
    const includeDrafts = body.include_machine_drafts === true;
    const oppConditions = [];
    if (engagement) oppConditions.push(`engagement = '${sqlEscape(engagement)}'`);
    if (!includeDrafts) oppConditions.push(`status <> 'machine_draft'`);
    const oppWhere = oppConditions.length ? `WHERE ${oppConditions.join(' AND ')}` : '';

    const oppSql = `
      SELECT opportunity_id, engagement, register_number, title,
             claim_summary, claim_population, claim_items, evidence_tier,
             signal_ids, action, window_label,
             lower(window_date) AS window_start, upper(window_date) AS window_end,
             owner, status, prediction_id, notes, created_at, updated_at,
             origin, source_run_id, generated_by, claim_hash,
             promoted_by, promoted_at
      FROM bjl_opportunities
      ${oppWhere}
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
        // Provenance. `origin` is the one the UI reads: a harvested draft
        // is labelled as one wherever it is rendered, so nobody mistakes
        // a model's paragraph for a colleague's.
        origin:            r.origin || 'analyst',
        source_run_id:     r.source_run_id || null,
        generated_by:      r.generated_by || null,
        claim_hash:        r.claim_hash || null,
        promoted_by:       r.promoted_by || null,
        promoted_at:       r.promoted_at || null,
      };
    });

    const engagements = Array.from(new Set(opportunities.map(o => o.engagement).filter(Boolean))).sort();

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, statuses: ANALYST_STATUSES, engagements, opportunities }),
    };
  } catch (e) {
    console.error('[opportunities] handler error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
