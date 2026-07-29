#!/usr/bin/env node
/**
 * smoke_joy_map.js — executable form of the focal resolver fixtures
 * documented in the header of netlify/functions/bjl-joy-map-connections.js.
 *
 * ============================ READ THIS ============================
 * THIS IS NOT AN ISOLATED UNIT TEST. It stubs exactly one thing —
 * verifyAndAuthorize — so the handler can be called without a browser
 * session. Everything else is LIVE:
 *   - the real Netlify function handler
 *   - the real front door, which calls the Anthropic API and costs money
 *   - the real Supabase database named in .env
 * These cases are all READS. They create nothing and mutate nothing.
 * Credentials come from .env at the repo root, so whichever database
 * that file points at is the one you are about to query. Check it
 * before running against anything you care about.
 * ===================================================================
 *
 * Usage:  node bin/smoke_joy_map.js [case]
 *   (no arg)  every case
 *   gate      the regression: resolver picks unscored items, gate drops
 *             them, rung B substitutes, sixteen rows land
 *   runga     rung A non-regression — a genuinely fielded brand still
 *             resolves directly, proving the redefinition didn't
 *             over-tighten
 *   deadend   the fourth gate: an unfielded brand name dead-ends at
 *             clarification because it cannot even reach the shortlist
 *   topics    blast-radius check on open-end-heavy topics, confirming
 *             the shortlist ordering surfaces scored items
 *
 * Exits non-zero if any assertion fails.
 *
 * A note on what these assertions do and do not pin. The gate case checks
 * lifts to the tenth but checks a base on only one of the four leads. That
 * is fine for regression purposes — the lift is the thing that moves when
 * the resolver breaks. It is not fine as a model of how the numbers should
 * be read: Body & Restoration leads at +20.7 on n=375 while Money &
 * Security leads at +20.8 on n=7,452, and those are not peer claims. The
 * rendering contract is that no number appears without its n at equal
 * prominence, base first, so every lift arrives pre-qualified. Visual
 * confidence weighting is the proper treatment and sits with the CD brief.
 * Do not read a passing fixture as a statement that two equal lifts carry
 * equal weight.
 */
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');

const envPath = path.join(REPO, '.env');
if (!fs.existsSync(envPath)) {
  console.error(`No .env at ${envPath}. This harness runs against a live database and cannot proceed without one.`);
  process.exit(1);
}
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

// The single stub. Auth is a browser-session concern and is not what
// these fixtures are testing; everything downstream of it is real.
const authPath = require.resolve(path.join(REPO, 'netlify/functions/bjl-auth-helper.js'));
require(authPath);
require.cache[authPath].exports.verifyAndAuthorize = async () => ({
  ok: true, user: { email: 'smoke@local' },
});

const { handler } = require(path.join(REPO, 'netlify/functions/bjl-joy-map-connections.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function run(label, query) {
  const res = await handler({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer smoke' },
    body: JSON.stringify({ query }),
  });
  const j = JSON.parse(res.body);
  console.log(`\n=== ${label} ===`);
  console.log(`  query        : "${query}"`);
  if (j.error) { console.log('  ERROR        :', j.error); failures++; return j; }
  if (j.brief) {
    console.log('  brief.shape  :', j.brief.shape);
    const items = (j.brief.entities && j.brief.entities.items) || [];
    if (items.length) {
      console.log('  resolved     :', items.map(i => `${i.item_id} (scored=${i.in_centered})`).join(' | '));
    }
  }
  if (j.resolution) {
    console.log('  rung         :', j.resolution.rung);
    console.log('  line         :', j.resolution.line);
    if ((j.resolution.dropped || []).length) {
      console.log('  dropped      :', j.resolution.dropped.map(d => d.item_id).join(', '));
    }
  }
  console.log('  focals       :', (j.focals || []).map(f => `${f.item_id} "${f.item_name}"`).join(' | ') || '—');
  console.log('  cohort       :', `${j.cohort_hot} hot / ${j.cohort_cool} cool`);
  console.log('  territories  :', (j.territories || []).length);
  if (j.halt) console.log('  HALT         :', j.halt.line);
  return j;
}

const leadFor = (j, territory) => {
  const t = (j.territories || []).find(x => x.territory === territory);
  return t && t.lead ? t.lead : null;
};

async function caseGate() {
  // The mechanism that produced the live failure. Haiku reaches for the
  // open-end here — on the original run it reasoned, verbatim, that
  // "item 5009 specifically addresses internet provider issues".
  const j = await run('GATE — resolver picks unscored, gate substitutes',
    'people who have problems with their internet provider');
  const ids = (j.focals || []).map(f => f.item_id);
  check('5009 never selected as a focal', !ids.includes(5009), `focals [${ids}]`);
  check('rung b claimed', j.resolution && j.resolution.rung === 'b', j.resolution && j.resolution.rung);
  check('substituted to 4589', ids.length === 1 && ids[0] === 4589, `focals [${ids}]`);
  check('sixteen live rows', (j.territories || []).length === 16, `${(j.territories || []).length} rows`);
  check('cohort in the thousands', j.cohort_hot > 1000 && j.cohort_cool > 1000,
    `${j.cohort_hot} / ${j.cohort_cool}`);
  // The four leads cited in the fixture, checked by value.
  const expect = [
    ['Treats & Indulgence', 17.6, null],
    ['Money & Security', 20.8, 7452],
    ['Body & Restoration', 20.7, null],
    ['Providing & Care', 16.9, null],
  ];
  for (const [terr, lift, n] of expect) {
    const l = leadFor(j, terr);
    const ok = l && l.lift_points === lift && (n == null || l.shared_answerers === n);
    check(`${terr} lead ${lift > 0 ? '+' : ''}${lift}${n ? ` n=${n}` : ''}`, !!ok,
      l ? `got ${l.lift_points} n=${l.shared_answerers}` : 'no lead');
  }
}

async function caseRungA() {
  const j = await run('RUNG A — a genuinely fielded brand resolves directly', 'Busch Gardens');
  check('rung a claimed', j.resolution && j.resolution.rung === 'a', j.resolution && j.resolution.rung);
  check('focal is the brand item', (j.focals || []).some(f => f.item_id === 2155),
    (j.focals || []).map(f => f.item_id).join(','));
  check('sixteen live rows', (j.territories || []).length === 16, `${(j.territories || []).length} rows`);
  check('not halted', !j.halt);
}

async function caseDeadEnd() {
  // The fourth gate — see the forensic note in the handler header. An
  // unfielded brand name cannot reach the shortlist, so it cannot reach
  // fabrication. If this case ever starts resolving, term matching has
  // been made fuzzier and gate 1 is now carrying the full load alone.
  const j = await run('DEAD END — unfielded brand name cannot reach the shortlist',
    'Hotwire Communications');
  check('clarifies rather than resolving',
    j.brief && j.brief.shape === 'needs_clarification', j.brief && j.brief.shape);
  check('no focals', (j.focals || []).length === 0);
  check('no territory rows', (j.territories || []).length === 0);
}

async function caseTopics() {
  // Blast radius of the shortlist reordering. "banking" is one of the
  // classes that used to return nothing but open-ends.
  const j = await run('TOPICS — open-end-heavy topic surfaces scored items', 'banking');
  const items = (j.brief && j.brief.entities && j.brief.entities.items) || [];
  check('resolver returned items', items.length > 0, `${items.length}`);
  check('every resolved item is scored', items.length > 0 && items.every(i => i.in_centered),
    items.map(i => `${i.item_id}:${i.in_centered}`).join(' '));
  check('rung a claimed', j.resolution && j.resolution.rung === 'a', j.resolution && j.resolution.rung);
}

(async () => {
  const which = (process.argv[2] || 'all').toLowerCase();
  const cases = { gate: caseGate, runga: caseRungA, deadend: caseDeadEnd, topics: caseTopics };
  if (which === 'all') { for (const fn of Object.values(cases)) await fn(); }
  else if (cases[which]) { await cases[which](); }
  else { console.error(`Unknown case "${which}". Expected one of: all, ${Object.keys(cases).join(', ')}`); process.exit(1); }
  console.log(failures === 0 ? '\nAll assertions passed.' : `\n${failures} assertion(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('harness failed:', e); process.exit(1); });
