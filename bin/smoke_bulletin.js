#!/usr/bin/env node
/**
 * smoke_bulletin.js — executable form of the Bulletin write-path battery.
 * Exercises netlify/functions/bjl-opportunities.js end to end: the
 * validation contract, create, the status lifecycle and its guard, and
 * the list round-trip with its signals join.
 *
 * ====================== READ THIS. THIS ONE WRITES. ======================
 * THIS IS NOT AN ISOLATED UNIT TEST, AND IT IS NOT READ-ONLY. It stubs
 * exactly one thing — verifyAndAuthorize — so the handler can be called
 * without a browser session. Everything else is LIVE:
 *   - the real Netlify function handler
 *   - the real Supabase database named in .env
 *
 * It INSERTS a row into bjl_opportunities and then UPDATES it. The row is
 * not cleaned up automatically; the delete statement is printed at the end
 * and is yours to run. Credentials come from .env at the repo root, so
 * whichever database that file points at is the one you are about to
 * write to. Check it before running against anything you care about.
 *
 * The card is marked disposable in its TITLE, not in engagement or notes.
 * That is deliberate and was learned the hard way: a cleanup guard — human
 * or scripted — reads the title. A card whose title looks like real work
 * and whose disposability is buried in metadata will survive the sweep
 * that was meant to catch it. Keep the marker in the title.
 * ========================================================================
 *
 * Usage:  node bin/smoke_bulletin.js
 *
 * Exits non-zero if any assertion fails.
 */
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');

const envPath = path.join(REPO, '.env');
if (!fs.existsSync(envPath)) {
  console.error(`No .env at ${envPath}. This harness writes to a live database and cannot proceed without one.`);
  process.exit(1);
}
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

// The single stub. Auth is a browser-session concern and is not what this
// battery is testing; everything downstream of it is real.
const authPath = require.resolve(path.join(REPO, 'netlify/functions/bjl-auth-helper.js'));
require(authPath);
require.cache[authPath].exports.verifyAndAuthorize = async () => ({
  ok: true, user: { email: 'smoke@local' },
});

const { handler } = require(path.join(REPO, 'netlify/functions/bjl-opportunities.js'));

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const call = async (body) => {
  const res = await handler({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer smoke' },
    body: JSON.stringify(body),
  });
  return { status: res.statusCode, json: JSON.parse(res.body) };
};

(async () => {
  console.log('\n=== VALIDATION — an incomplete create must fail legibly ===');
  // The claim standard is enforced in the function, not left to a Postgres
  // NOT NULL violation leaking out as a 500.
  const bad = await call({
    action: 'create',
    engagement: 'Smoke battery',
    title: 'SMOKE TEST — delete me — validation probe',
  });
  console.log('  response     :', bad.status, bad.json.error);
  check('400, not 500', bad.status === 400, `${bad.status}`);
  check('legible error text', typeof bad.json.error === 'string' && bad.json.error.length > 0);

  console.log('\n=== CREATE — a full draft, shaped exactly as the map builds it ===');
  const draft = {
    action: 'create',
    engagement: 'Smoke battery',
    title: 'SMOKE TEST — delete me — Money & Security lead pair',
    claim_summary: 'Lead pair: Having access to HIGH-SPEED INTERNET in your home rises with Shopping at a store that gives you access to high quality GROCERIES FOR LOW PRICES, lift +20.8 points across 7,452 shared answerers.',
    claim_population: "Leaners cohort on Having access to HIGH-SPEED INTERNET in your home — 6,510 hot / 1,324 cool. Substitution: home internet service isn't fielded on scored items; reading through: Having access to HIGH-SPEED INTERNET in your home.",
    evidence_tier: 'measured',
    claim_items: [4589],
    action_text: 'Smoke test of the create path — retire this card.',
    window_label: 'n/a',
    notes: 'Written by bin/smoke_bulletin.js. Disposable.',
  };
  const made = await call(draft);
  const opp = made.json.opportunity;
  console.log('  response     :', made.status, made.json.error || `opportunity_id=${opp.opportunity_id} status=${opp.status} register=${opp.register_number}`);
  check('create succeeded', made.status === 200 && made.json.ok === true, made.json.error);
  if (!made.json.ok) {
    console.log(`\n${failures} assertion(s) FAILED. Nothing was written.`);
    process.exit(1);
  }
  const id = opp.opportunity_id;
  check('born as candidate', opp.status === 'candidate', opp.status);
  // register_number is the lineage link to the analyst's working register.
  // Seed-loaded cards carry one; tool-native cards are born without one,
  // and that is correct, not a gap in the create path.
  check('no register_number on a tool-native card', opp.register_number == null, `${opp.register_number}`);

  console.log('\n=== STATUS — the lifecycle and its guard ===');
  const badStatus = await call({ action: 'set_status', opportunity_id: id, status: 'bogus' });
  console.log('  bad status   :', badStatus.status, badStatus.json.error);
  check('unknown status rejected', badStatus.status === 400, `${badStatus.status}`);
  const moved = await call({ action: 'set_status', opportunity_id: id, status: 'reviewed' });
  console.log('  set_status   :', moved.status, moved.json.ok ? `status=${moved.json.opportunity.status}` : moved.json.error);
  check('moved to reviewed', moved.json.ok === true && moved.json.opportunity.status === 'reviewed',
    moved.json.error || (moved.json.opportunity && moved.json.opportunity.status));

  console.log('\n=== LIST — the card round-trips with its signals join ===');
  const listed = await call({ action: 'list', engagement: 'Smoke battery' });
  const row = (listed.json.opportunities || []).find(o => o.opportunity_id === id);
  console.log('  response     :', listed.status, `${(listed.json.opportunities || []).length} card(s)`);
  check('card found in list', !!row);
  if (row) {
    console.log('  card         :', `tier=${row.evidence_tier} items=[${row.claim_items}] signals=${row.signals.length} newest_signal=${row.newest_signal_at}`);
    check('evidence_tier round-tripped', row.evidence_tier === 'measured', row.evidence_tier);
    check('claim_items round-tripped', Array.isArray(row.claim_items) && row.claim_items.length === 1 && Number(row.claim_items[0]) === 4589,
      `[${row.claim_items}]`);
    check('signals join present', Array.isArray(row.signals), typeof row.signals);
    check('status persisted', row.status === 'reviewed', row.status);
  }

  console.log(`\nThis run WROTE opportunity_id ${id}. It is still there. Retire it with:`);
  console.log(`  delete from bjl_opportunities where opportunity_id = ${id};`);
  console.log(failures === 0 ? '\nAll assertions passed.' : `\n${failures} assertion(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('harness failed:', e); process.exit(1); });
