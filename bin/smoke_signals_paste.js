#!/usr/bin/env node
/**
 * smoke_signals_paste.js — the Waldo signal paste box, end to end.
 *
 * ====================== READ THIS. THIS ONE WRITES. ======================
 * Part 2 of this battery is NOT read-only. It stubs exactly one thing —
 * verifyAndAuthorize — and everything downstream is live: the real
 * handler, the real bjl_signals_paste_apply function, the real Supabase
 * database named in .env. It writes twenty-one rows to
 * bjl_marketplace_signals and then supersedes two of them.
 *
 * Every row it writes is disposable and says so twice: the engagement is
 * SMOKE_ENGAGEMENT below, and every headline is prefixed. The marker is
 * in the headline because the headline is what a cleanup sweep reads —
 * a row whose label looks like real work and whose disposability is
 * buried in a metadata column survives the sweep meant to catch it.
 *
 * The delete statement is printed at the end and is yours to run.
 *
 * Part 1 touches nothing and needs no database.
 *
 * Usage:  node bin/smoke_signals_paste.js
 *         node bin/smoke_signals_paste.js --map-only    (part 1 only)
 *
 * Exits non-zero if any assertion fails.
 * ========================================================================
 *
 * THE HAZARDS THIS LAYER IS BUILT AROUND
 *
 * HAZARD 1: a supersede chain that counts pastes instead of movements.
 * Re-emitting all fourteen signals is the normal case — Waldo re-runs and
 * hands back everything it still sees. If every re-emission wrote a new
 * generation, the chain would record how many times someone pasted, and
 * "this signal has been revised four times" would mean nothing. A row is
 * unchanged when its MAPPED CONTENT columns match. captured_at alone is
 * never a revision.
 *
 * HAZARD 2: two windows collapsing into one. Windows carry no id, so
 * identity is synthesized from the name, truncated at the em dash so a
 * reworded subtitle is a revision rather than a fork. The truncation cuts
 * both ways: two windows that share everything before the dash become one
 * id, and inside a single paste that means one silently eats the other
 * and a real window disappears. That is a legible 400, never a silent
 * drop.
 *
 * HAZARD 3: the normalization order that ships green and fails later.
 * Lowercase-strip-collapse-then-truncate deletes the em dash before
 * looking for it, so nothing truncates and every window hashes whole,
 * subtitle included. Nothing in the real fixture catches this — every r2
 * window name is byte-identical to r1, so the truncation path is never
 * exercised by it. Part 1 exercises it synthetically, on purpose.
 */

const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');
const MAP_ONLY = process.argv.includes('--map-only');

const SMOKE_ENGAGEMENT = 'SMOKE — disposable — signals paste battery (delete me)';
// A colon, not an em dash. The first version of this used " — " and every
// window in the fixture normalized to "smoke disposable", because the
// marker became the head and the real name became the subtitle. The
// collision guard caught it on the first run, which is the guard working:
// seven windows collapsing into one is exactly the silent loss it exists
// to refuse.
const HEADLINE_MARK = 'SMOKE-DISPOSABLE: ';

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------
const r1Raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/hi_cultural_currents_r1.json'), 'utf8'));
const delta = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/hi_cultural_currents_r2_delta.json'), 'utf8'));

const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * r2 is assembled from r1 rather than read from a materialized file, so
 * the nineteen unchanged rows are byte-identical by construction. A
 * separately generated r2 that drifted one character would turn this
 * from a supersede test into a change-detection test, and it would pass.
 */
function assembleR2(r1) {
  const r2 = clone(r1);
  r2.captured_at = delta.captured_at_to;
  r2.signals = r2.signals.map(s => {
    const changed = delta.signals_changed.find(c => c.signal_id === s.signal_id);
    if (changed) return clone(changed);
    return { ...s, captured_at: delta.captured_at_to };
  });
  r2.activation_windows = r2.activation_windows.map(w => {
    const changed = delta.windows_changed.find(c => c.window === w.window);
    return changed ? clone(changed) : w;
  });
  return r2;
}

// Both rounds get the disposable engagement and marked headlines. Applied
// identically to both, so an unchanged row is still unchanged.
function disposable(payload) {
  const p = clone(payload);
  p.engagement = SMOKE_ENGAGEMENT;
  p.signals = p.signals.map(s => ({ ...s, headline: HEADLINE_MARK + s.headline }));
  p.activation_windows = p.activation_windows.map(w => ({ ...w, window: HEADLINE_MARK + w.window }));
  return p;
}

const R1 = disposable(r1Raw);
const R2 = disposable(assembleR2(r1Raw));

// =====================================================================
// PART 1 — mapping and identity. No database.
// =====================================================================
// The handler builds its Supabase client at module scope, so .env has to
// be in the environment before the require even for --map-only. Nothing
// in part 1 opens a connection; the client is constructed and unused.
const envPath = path.join(REPO, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} else {
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://map-only.invalid';
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'map-only';
}

const { _internals } = require(path.join(REPO, 'netlify/functions/bjl-signals-paste.js'));
const { mapPayload, normalizeWindowName, windowExternalId } = _internals;

section('Part 1a — the payload maps field to column');
{
  const { engagement, theme, rows, problems } = mapPayload(R1);
  check('r1 maps with no problems', problems.length === 0, problems.join(' | '));
  check('engagement carried', engagement === SMOKE_ENGAGEMENT);
  check('theme carried', theme === r1Raw.theme);
  check('21 rows (14 signals + 7 windows)', rows.length === 21, `got ${rows.length}`);

  const cc6 = rows.find(r => r.external_id === 'CC-006');
  check('signal external_id is the emitted signal_id', !!cc6);
  check('signal headline mapped', cc6.headline.startsWith(HEADLINE_MARK));
  check('signal urgency mapped', cc6.urgency === 'critical');
  check('signal exact_quote mapped', typeof cc6.exact_quote === 'string' && cc6.exact_quote.length > 0);

  // The collision the header warns about. The payload's `source` is a
  // URL; the column `source` is the producing system.
  check('payload source lands in source_url', cc6.source_url === 'https://www.tiktok.com/@alexpepperr/video/7659926703405272351');
  check('no row sets the `source` column', rows.every(r => r.source === undefined));

  // why_it_matters is Waldo's interpretation. It has no column, and the
  // only place it survives is raw, where a card cannot cite it.
  check('why_it_matters has no column', !('why_it_matters' in cc6));
  check('why_it_matters survives in raw', typeof cc6.raw.why_it_matters === 'string');

  const cc14 = rows.find(r => r.external_id === 'CC-014');
  check('a null exact_quote stays null', cc14.exact_quote === null);
  check('owned_source false is boolean false', cc6.owned_source === false);
}

section('Part 1b — windows map by the ruling');
{
  const { rows } = mapPayload(R1);
  const windows = rows.filter(r => r.signal_type === 'activation_window');
  check('7 windows', windows.length === 7, `got ${windows.length}`);

  const lonely = windows.find(w => w.headline.includes('Loneliness and belonging'));
  check('window name is the headline', !!lonely);
  check('window timing is the detail', lonely.detail.startsWith('Active now — Fortune article'));
  check('window exact_quote is null', lonely.exact_quote === null);
  check('window urgency is null', lonely.urgency === null);
  check('window source is source_url', lonely.source_url.startsWith('https://fortune.com/'));
  check('relevance rides in raw only', !('relevance' in lonely) && typeof lonely.raw.relevance === 'string');
  check('owned_property rides in raw only', !('owned_property' in lonely) && typeof lonely.raw.owned_property === 'string');
  check('every window id is a WIN- hash', windows.every(w => /^WIN-[0-9a-f]{16}$/.test(w.external_id)));
  check('all 7 window ids distinct', new Set(windows.map(w => w.external_id)).size === 7);
  check('windows inherit the payload capture date', windows.every(w => w.captured_at === r1Raw.captured_at));
}

section('Part 1c — a flag appends to the detail rather than hiding in raw');
{
  const flagged = clone(R1);
  flagged.activation_windows = [{
    window: 'Iowa State Fair America250 programming — Midwest travel moment',
    timing: 'August 13 — 23, 2026',
    flag: 'exact date unconfirmed, flagged not dropped',
    source: 'https://example.invalid/x',
  }];
  flagged.signals = [];
  const { rows, problems } = mapPayload(flagged);
  check('flagged window maps', problems.length === 0, problems.join(' | '));
  check('timing still leads the detail', rows[0].detail.startsWith('August 13 — 23, 2026'));
  check('flag is readable in the detail', rows[0].detail.includes('exact date unconfirmed, flagged not dropped'));
}

section('Part 1d — HAZARD 3: truncate FIRST, or the rule does nothing');
{
  // The rule exists so a reworded subtitle is a revision, not a fork.
  // Under the wrong order — strip punctuation, then look for the em dash
  // that is no longer there — these two hash differently and Waldo
  // rewording a subtitle silently forks the window.
  const a = 'Fall shoulder season — solo and first-timer travel conversion window';
  const b = 'Fall shoulder season — conversion window for solo travelers';
  check('subtitle edits normalize identically', normalizeWindowName(a) === normalizeWindowName(b),
    `${normalizeWindowName(a)} vs ${normalizeWindowName(b)}`);
  check('normalized form is the head only', normalizeWindowName(a) === 'fall shoulder season');
  check('same engagement + head ⇒ same id', windowExternalId('E', a) === windowExternalId('E', b));
  check('different engagement ⇒ different id', windowExternalId('E', a) !== windowExternalId('F', a));
  // Punctuation and case are cosmetic within the head.
  check("punctuation in the head is cosmetic", windowExternalId('E', "Cleveland Orchestra 'Happy 250th' concert — Sept") === windowExternalId('E', 'Cleveland Orchestra Happy 250th concert — Oct'));
  // And the id must not move when the thing revisions actually change moves.
  check('timing is not in the hash', windowExternalId('E', a) === windowExternalId('E', a));
}

section('Part 1e — HAZARD 2: two windows sharing a head is a legible 400');
{
  const collide = clone(R1);
  collide.signals = [];
  collide.activation_windows = [
    { window: 'Fall shoulder season — solo and first-timer travel conversion window', timing: 'Sep–Nov', source: null },
    { window: 'Fall shoulder season — conversion window for solo travelers', timing: 'Sep–Nov', source: null },
  ];
  const { problems } = mapPayload(collide);
  check('collision is reported', problems.length === 1, problems.join(' | '));
  check('the message names both windows',
    problems[0].includes('conversion window for solo travelers') && problems[0].includes('solo and first-timer'));
  check('the message names the shared identity', problems[0].includes('fall shoulder season'));
}

section('Part 1f — the legible 400 contract');
{
  const noId = clone(R1);
  noId.signals = [{ headline: 'A signal with no id at all', captured_at: '2026-08-01' }];
  noId.activation_windows = [];
  const a = mapPayload(noId);
  check('a signal with no signal_id is refused', a.problems.length === 1);
  check('and the message names the offender', a.problems[0].includes('signals[0]') && a.problems[0].includes('signal_id'));

  const noHead = clone(R1);
  noHead.signals = [{ signal_id: 'CC-901', captured_at: '2026-08-01' }];
  noHead.activation_windows = [];
  const b = mapPayload(noHead);
  check('a signal with no headline is refused', b.problems.length === 1 && b.problems[0].includes('CC-901'));

  const dupe = clone(R1);
  dupe.signals = [
    { signal_id: 'CC-001', headline: 'first', captured_at: '2026-08-01' },
    { signal_id: 'CC-001', headline: 'second', captured_at: '2026-08-01' },
  ];
  dupe.activation_windows = [];
  const c = mapPayload(dupe);
  check('a repeated signal_id in one paste is refused', c.problems.length === 1 && c.problems[0].includes('CC-001'));

  const bare = mapPayload({ signals: [], activation_windows: [] });
  check('missing engagement, theme and content all report at once', bare.problems.length === 3,
    `got ${bare.problems.length}: ${bare.problems.join(' | ')}`);

  // Every problem, not just the first. An analyst should repair one paste.
  const many = { engagement: 'E', theme: 'T', captured_at: '2026-08-01', signals: [
    { headline: 'no id' }, { signal_id: 'CC-902' }, { signal_id: 'CC-903', headline: 'ok' },
  ], activation_windows: [] };
  check('problems accumulate rather than short-circuit', mapPayload(many).problems.length === 2);
}

section('Part 1g — r2 differs from r1 in exactly two rows');
{
  const m1 = mapPayload(R1);
  const m2 = mapPayload(R2);
  const key = (r) => [r.signal_type, r.headline, r.detail, r.exact_quote, r.urgency, r.source_url, r.owned_source].join('\u0001');
  const byId1 = new Map(m1.rows.map(r => [r.external_id, r]));
  const differing = m2.rows.filter(r => key(r) !== key(byId1.get(r.external_id) || {}));
  check('r2 has the same 21 identities', m2.rows.length === 21 && m2.rows.every(r => byId1.has(r.external_id)));
  check('exactly two rows differ in mapped content', differing.length === 2,
    differing.map(d => d.external_id).join(', '));
  check('one of them is CC-006', differing.some(d => d.external_id === 'CC-006'));
  check('the other is the loneliness window', differing.some(d => d.headline.includes('Loneliness and belonging')));
  // The whole point of the skip rule.
  check('captured_at moved on all 21', m2.rows.every(r => r.captured_at === '2026-08-01'));
}

if (MAP_ONLY) {
  console.log(`\n${failures === 0 ? 'ALL MAPPING ASSERTIONS PASS' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

// =====================================================================
// PART 2 — the live write path.
// =====================================================================
if (!fs.existsSync(envPath)) {
  console.error(`\nNo .env at ${envPath}. Part 2 writes to a live database and cannot proceed without one.`);
  console.error('Run with --map-only to skip it.');
  process.exit(1);
}

const authPath = require.resolve(path.join(REPO, 'netlify/functions/bjl-auth-helper.js'));
require(authPath);
require.cache[authPath].exports.verifyAndAuthorize = async () => ({
  ok: true, user: { email: 'smoke@local' },
});

// Required AFTER the stub and the env, so the module's Supabase client is
// built with real credentials.
delete require.cache[require.resolve(path.join(REPO, 'netlify/functions/bjl-signals-paste.js'))];
const { handler } = require(path.join(REPO, 'netlify/functions/bjl-signals-paste.js'));
const { createClient } = require('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const post = async (body) => {
  const res = await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer smoke' }, body: JSON.stringify(body) });
  return { status: res.statusCode, json: JSON.parse(res.body) };
};

const liveRows = async () => {
  const { data, error } = await db
    .from('bjl_marketplace_signals')
    .select('signal_id, external_id, headline, detail, urgency, superseded_by, captured_at, signal_type')
    .eq('engagement', SMOKE_ENGAGEMENT);
  if (error) throw new Error(error.message);
  return data;
};

(async () => {
  section('Part 2a — a malformed paste never reaches the database');
  {
    const bad = await post({ paste: '{ "engagement": "x", ' });
    check('truncated JSON is a 400', bad.status === 400, `got ${bad.status}`);
    check('and says so in English', /not valid JSON/.test(bad.json.error));

    const notObj = await post({ paste: '[1,2,3]' });
    check('a bare array is a 400', notObj.status === 400 && /not a Waldo payload/.test(notObj.json.error));

    const empty = await post({ paste: '   ' });
    check('an empty box is a 400', empty.status === 400 && /nothing pasted/.test(empty.json.error));
  }

  section('Part 2b — clean slate');
  {
    const before = await liveRows();
    if (before.length > 0) {
      console.log(`  (clearing ${before.length} row(s) left by a previous run)`);
      // Break the self-references first or the delete trips the FK.
      await db.from('bjl_marketplace_signals').update({ superseded_by: null }).eq('engagement', SMOKE_ENGAGEMENT);
      await db.from('bjl_marketplace_signals').delete().eq('engagement', SMOKE_ENGAGEMENT);
    }
    check('no smoke rows to start', (await liveRows()).length === 0);
  }

  section('Part 2c — round 1 writes all 21');
  {
    const r = await post({ payload: R1 });
    check('r1 accepted', r.status === 200, JSON.stringify(r.json).slice(0, 200));
    check('21 inserted, nothing revised or skipped',
      r.json.applied.inserted === 21 && r.json.applied.revised === 0 && r.json.applied.unchanged === 0,
      JSON.stringify(r.json.applied));
    const rows = await liveRows();
    check('21 rows in the table', rows.length === 21, `got ${rows.length}`);
    check('all live', rows.every(x => x.superseded_by === null));
    check('14 signals + 7 windows', rows.filter(x => x.signal_type === 'activation_window').length === 7);
  }

  section('Part 2d — round 2 revises two and skips nineteen');
  let r1Ids;
  {
    r1Ids = new Map((await liveRows()).map(x => [x.external_id, x.signal_id]));
    const r = await post({ payload: R2 });
    check('r2 accepted', r.status === 200, JSON.stringify(r.json).slice(0, 200));
    check('2 revised, 19 unchanged, 0 inserted',
      r.json.applied.revised === 2 && r.json.applied.unchanged === 19 && r.json.applied.inserted === 0,
      JSON.stringify(r.json.applied));

    const rows = await liveRows();
    check('23 rows total: 21 live + 2 superseded', rows.length === 23, `got ${rows.length}`);
    const live = rows.filter(x => x.superseded_by === null);
    check('21 live rows, no duplicates', live.length === 21 && new Set(live.map(x => x.external_id)).size === 21);

    // CC-006: the changed-field assertion.
    const cc6Live = live.find(x => x.external_id === 'CC-006');
    check('CC-006 live row carries the revised headline', cc6Live.headline.includes('passes 21K views'));
    check('CC-006 live row carries the revised detail', cc6Live.detail.startsWith('REVISED r2:'));
    check('CC-006 urgency unchanged', cc6Live.urgency === 'critical');
    check('CC-006 is a NEW row', cc6Live.signal_id !== r1Ids.get('CC-006'));
    const cc6Old = rows.find(x => x.signal_id === r1Ids.get('CC-006'));
    check("CC-006's r1 row points at its r2 counterpart", cc6Old.superseded_by === cc6Live.signal_id);

    // The window, superseded via its synthesized id.
    const lonelyLive = live.find(x => x.signal_type === 'activation_window' && x.headline.includes('Loneliness and belonging'));
    check('the loneliness window carries the MOVED timing', lonelyLive.detail.startsWith('MOVED r2:'));
    const lonelyOld = rows.find(x => x.signal_id !== lonelyLive.signal_id && x.headline.includes('Loneliness and belonging'));
    check('its r1 row was superseded via the synthesized id', lonelyOld.superseded_by === lonelyLive.signal_id);
    check('and the id itself did not move', lonelyOld.external_id === lonelyLive.external_id);

    // HAZARD 1. Nineteen rows the market did not move.
    const skipped = live.filter(x => x.external_id !== 'CC-006' && x.external_id !== lonelyLive.external_id);
    check('19 rows skipped entirely', skipped.length === 19, `got ${skipped.length}`);
    check('every skipped row kept its original signal_id',
      skipped.every(x => x.signal_id === r1Ids.get(x.external_id)));
    check('every skipped row kept its r1 capture date — captured_at alone is never a revision',
      skipped.every(x => x.captured_at === '2026-07-31'));
    check('no skipped row was superseded', skipped.every(x => x.superseded_by === null));
  }

  section('Part 2e — round 3 is a no-op');
  {
    const before = (await liveRows()).length;
    const r = await post({ payload: R2 });
    check('r2 again writes nothing', r.json.applied.unchanged === 21 && r.json.applied.revised === 0 && r.json.applied.inserted === 0,
      JSON.stringify(r.json.applied));
    check('row count unmoved', (await liveRows()).length === before);
  }

  console.log(`\n${failures === 0 ? 'ALL ASSERTIONS PASS' : `${failures} FAILURE(S)`}`);
  console.log(`\nCleanup — these rows are yours to delete:\n`
    + `  UPDATE bjl_marketplace_signals SET superseded_by = NULL WHERE engagement = '${SMOKE_ENGAGEMENT.replace(/'/g, "''")}';\n`
    + `  DELETE FROM bjl_marketplace_signals WHERE engagement = '${SMOKE_ENGAGEMENT.replace(/'/g, "''")}';`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => {
  console.error('\nHarness error:', e.message);
  process.exit(1);
});
