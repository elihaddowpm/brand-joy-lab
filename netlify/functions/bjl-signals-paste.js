/**
 * bjl-signals-paste.js — the Waldo signal paste box (Bulletin piece 2).
 *
 * Takes a Waldo signals payload as pasted text and writes it to
 * bjl_marketplace_signals. Re-pasting the same payload supersedes the
 * rows whose content moved and skips the rows that did not.
 *
 * Contract:
 *   POST { paste: "<raw json>" }  or  { payload: { ... } }
 *     → 200 { ok, engagement, theme, applied: { inserted, revised,
 *             unchanged }, rows: [{ external_id, signal_id, outcome }] }
 *     → 400 { error, problems: [ "<one sentence per thing that is wrong>" ] }
 *
 * THIS PAYLOAD DOES NOT GO THROUGH THE EXTRACTOR, AND THAT IS DELIBERATE.
 *
 * bjl-waldo-extractor whitelists the 4Cs brand profile because that
 * payload is fed to a synthesis prompt, and raw JSON reaching a prompt
 * produced wrong findings. Nothing here reaches a model. A signals
 * payload maps field to column and is written, so there is no
 * classification step to run and a whitelist would have nothing to do:
 * run extractWaldoBrandFields over this file and every one of its
 * thirteen dotted paths misses, because there is no four_cs in it.
 *
 * The whitelist question is real, but it belongs to the generator.
 * why_it_matters and relevance are Waldo's interpretation, not market
 * observation, and they are never citable as evidence: they inform
 * ranking and never enter claim text. They have no column here for
 * exactly that reason and survive only inside `raw`, where a card cannot
 * reach them by accident.
 *
 * TWO FIELD NAMES COLLIDE WITH COLUMNS THAT MEAN SOMETHING ELSE. The
 * payload's `source` is a URL; the column `source` is the system that
 * produced the row and stays 'waldo'. The URL goes to source_url. The
 * payload's `signal_id` is "CC-006"; the column signal_id is a serial
 * primary key. The payload's goes to external_id. Both are written down
 * here because the names are identical and the writer sees both.
 *
 * Auth: workbench-authenticated only.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const WINDOW_SEPARATOR = ' — ';

/**
 * The identity of a window, for hashing.
 *
 * TRUNCATE FIRST. The order matters and the obvious order is wrong:
 * stripping punctuation before looking for the separator deletes the em
 * dash, leaves nothing to truncate at, and hashes the subtitle along
 * with the name — which is the precise failure truncation exists to
 * prevent. It would not fail loudly either. It would ship green and
 * surface the first time Waldo rewords a subtitle, as a duplicate window
 * rather than a revision.
 */
function normalizeWindowName(name) {
  const head = String(name).split(WINDOW_SEPARATOR)[0];
  return head
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Windows carry no id of their own — zero of roughly thirty-two across
 * this week's payloads had one — so identity is synthesized from the
 * engagement and the window's name.
 *
 * Neither captured_at nor timing is in the hash. Timing is exactly what
 * a revision changes; hashing it would make every revised window a new
 * window and nothing would ever supersede.
 */
function windowExternalId(engagement, windowName) {
  const basis = `${engagement}\u0000${normalizeWindowName(windowName)}`;
  return 'WIN-' + crypto.createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Windows have four fields against a table with headline/detail/
 * exact_quote/urgency. The name is the headline and the timing is the
 * detail, because timing is what revisions move and it has to be
 * readable rather than buried.
 *
 * A flag appends to the detail for the same reason: "exact date
 * unconfirmed, flagged not dropped" is the caveat an analyst must see
 * when citing the window, and putting it in raw defeats it.
 *
 * THE KEY IS `flag`, SINGULAR, verified across five real payloads: the
 * market scans carry it on every window and set it to null when the
 * window is unflagged, and the broad intakes omit it. `flags` plural
 * appears nowhere; it is read here only because reading it costs a line
 * and missing a caveat costs an analyst.
 *
 * Truthiness, not presence, and that distinction is the whole guard: a
 * window that carries "flag": null is the COMMON case, and testing for
 * the key would append the string "null" to the detail of every
 * unflagged window in a market scan.
 */
function windowFlagLines(w) {
  const out = [];
  for (const key of ['flag', 'flags']) {
    const v = w[key];
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x.trim()) out.push(x.trim());
  }
  return out;
}

/**
 * Payload to rows. Returns { rows, problems }.
 *
 * Every problem is collected rather than thrown at the first one, so the
 * analyst fixes one paste instead of discovering the next fault after
 * each repair.
 */
function mapPayload(payload) {
  const problems = [];

  const engagement = str(payload.engagement);
  const theme = str(payload.theme);
  const payloadCapturedAt = str(payload.captured_at);

  if (!engagement) problems.push('The payload has no `engagement`. Every signal is filed under one, and there is no default.');
  if (!theme) problems.push('The payload has no `theme`. It is the scope line every row in this paste inherits.');

  const signals = Array.isArray(payload.signals) ? payload.signals : [];
  const windows = Array.isArray(payload.activation_windows) ? payload.activation_windows : [];
  if (signals.length === 0 && windows.length === 0) {
    problems.push('The payload has neither `signals` nor `activation_windows`. There is nothing in it to write.');
  }

  const rows = [];
  // external_id -> the human label of the row that claimed it, so a
  // collision can name both sides rather than just reporting that one
  // happened.
  const claimed = new Map();

  const claim = (externalId, label) => {
    const prior = claimed.get(externalId);
    if (prior) return prior;
    claimed.set(externalId, label);
    return null;
  };

  signals.forEach((s, i) => {
    const at = `signals[${i}]`;
    const externalId = str(s.signal_id);
    const headline = str(s.headline);
    const capturedAt = str(s.captured_at) || payloadCapturedAt;

    if (!externalId) {
      problems.push(`${at} (headline: ${headline ? `"${headline.slice(0, 60)}…"` : 'none either'}) has no \`signal_id\`. Without one a re-paste duplicates the signal instead of superseding it, so it cannot be written.`);
      return;
    }
    if (!headline) {
      problems.push(`${at} (${externalId}) has no \`headline\`. The headline is the row — there is nothing to file without it.`);
      return;
    }
    if (!capturedAt) {
      problems.push(`${at} (${externalId}) has no \`captured_at\`, and neither does the payload. A signal with no date cannot be aged.`);
      return;
    }

    const collision = claim(externalId, `${at} "${headline.slice(0, 50)}…"`);
    if (collision) {
      problems.push(`${at} reuses the signal_id ${externalId}, already claimed by ${collision}. Two signals sharing an id inside one paste means one silently supersedes the other and a real signal disappears.`);
      return;
    }

    rows.push({
      external_id:  externalId,
      signal_type:  str(s.signal_type),
      headline,
      detail:       str(s.detail),
      exact_quote:  str(s.exact_quote),
      urgency:      str(s.urgency),
      // The payload's `source` is a URL. See the header.
      source_url:   str(s.source),
      owned_source: s.owned_source === true,
      captured_at:  capturedAt,
      raw:          s,
    });
  });

  windows.forEach((w, i) => {
    const at = `activation_windows[${i}]`;
    const name = str(w.window);
    if (!name) {
      problems.push(`${at} has no \`window\` name. The name is both the headline and the identity of the row, so there is nothing to write and nothing to supersede against.`);
      return;
    }
    if (!engagement) return; // the id is derived from it; already reported
    if (!payloadCapturedAt) {
      problems.push(`${at} "${name}" has no date: windows inherit \`captured_at\` from the payload and the payload has none.`);
      return;
    }

    const externalId = windowExternalId(engagement, name);
    const collision = claim(externalId, `${at} "${name}"`);
    if (collision) {
      problems.push(`${at} "${name}" and ${collision} normalize to the same identity ("${normalizeWindowName(name)}"). Two windows sharing everything before the "${WINDOW_SEPARATOR.trim()}" cannot be told apart, so one would silently supersede the other and a real window would vanish. Give them distinct names.`);
      return;
    }

    const timing = str(w.timing);
    const flags = windowFlagLines(w);
    const detail = [timing, ...flags].filter(Boolean).join('\n\n') || null;

    rows.push({
      external_id:  externalId,
      signal_type:  'activation_window',
      headline:     name,
      detail,
      // A window is a period, not a quotation, and it carries no urgency
      // of its own. Both stay null rather than being filled with
      // something plausible.
      exact_quote:  null,
      urgency:      null,
      source_url:   str(w.source),
      // Windows carry owned_source too — the broad intake sets it true on
      // the Great Hostel Give Back entry. The table has the column, so it
      // maps to the column. Defaulting windows to false would have
      // silently reclassified an owned property as observed market.
      owned_source: w.owned_source === true,
      captured_at:  payloadCapturedAt,
      // relevance and owned_property are interpretation, same class as
      // why_it_matters. They ride in raw and are never citable.
      raw:          w,
    });
  });

  return { engagement, theme, rows, problems };
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
      body: JSON.stringify({ error: auth.error, message: auth.message, auth_failed: true }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON body' }) }; }

  let payload = body.payload;
  if (!payload) {
    const paste = typeof body.paste === 'string' ? body.paste.trim() : '';
    if (!paste) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'nothing pasted', problems: ['The paste box was empty.'] }),
      };
    }
    try { payload = JSON.parse(paste); }
    catch (e) {
      // The parser's own message names the offset, which is the only
      // useful thing to say about a truncated copy-paste.
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'that is not valid JSON', problems: [e.message] }),
      };
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'that is not a Waldo payload', problems: ['The top level of a signals payload is an object with `engagement`, `theme` and `signals`.'] }),
    };
  }

  const { engagement, theme, rows, problems } = mapPayload(payload);
  if (problems.length > 0) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: `this payload cannot be written as it stands — ${problems.length} problem${problems.length === 1 ? '' : 's'}`,
        problems,
      }),
    };
  }

  try {
    // One call, one transaction, all or nothing. See the migration for
    // why the supersede cannot be assembled out of separate writes.
    const { data, error } = await supabase.rpc('bjl_signals_paste_apply', {
      p_engagement: engagement,
      p_theme: theme,
      p_rows: rows,
    });
    if (error) throw new Error(error.message);

    const applied = { inserted: 0, revised: 0, unchanged: 0 };
    for (const r of (Array.isArray(data) ? data : [])) {
      if (applied[r.outcome] !== undefined) applied[r.outcome] += 1;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, engagement, theme, applied, rows: data || [] }),
    };
  } catch (e) {
    console.error('[signals-paste] apply failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

// Exported for the smoke test, which exercises the mapping and the
// window identity without a database.
exports._internals = { mapPayload, normalizeWindowName, windowExternalId };
