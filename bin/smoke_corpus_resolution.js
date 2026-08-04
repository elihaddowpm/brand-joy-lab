#!/usr/bin/env node
/**
 * Smoke battery for the grounded corpus arm and the guard reconciliation.
 *
 * Two halves, both read-only. Nothing here writes a row, so it is safe to
 * run against live at any time.
 *
 *   Part 1 (--guard-only skips the database): the provenance guard.
 *     The bug this locks down: bjl_corpus_search returns no `tag`, and both
 *     prompts forbid the model from emitting one, but the guard demanded a
 *     tag anyway. Every adjacent-search item failed as
 *     cross_domain_tag_not_in_allowlist and the whole sidecar dropped —
 *     silently, on every run that used the arm. The retry was worse: the
 *     allowlist digest skipped untagged rows, so the one retry after a
 *     failure showed the model an empty allowlist and asked it to try
 *     harder.
 *
 *   Part 2: the arm itself, against live data. The invariant that matters
 *     is two-directional — item_id is populated for exactly the rows whose
 *     resolution says it should be, and NULL for exactly the rows whose
 *     resolution says it should not. A one-directional check would pass a
 *     function that never resolved anything.
 *
 * Usage:
 *   node bin/smoke_corpus_resolution.js --guard-only
 *   NODE_PATH=/path/to/node_modules node bin/smoke_corpus_resolution.js
 *
 * The repo carries no node_modules, so the live half needs @supabase/
 * supabase-js on NODE_PATH. --guard-only has no dependencies at all.
 */

const path = require('path');
const fs = require('fs');

// Load .env before requiring anything that builds a client at module scope.
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const guard = require('../netlify/functions/bjl-cross-domain-provenance-guard.js');

let passed = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { passed++; return; }
  failures.push(label + (detail ? ` — ${detail}` : ''));
};

// ---------------------------------------------------------------------
// Part 1 — the guard.
// ---------------------------------------------------------------------

function part1() {
  console.log('\nPart 1 — provenance guard reconciliation\n');

  // A Shape B scratch: bjl_corpus_search rows. No tag anywhere, by design.
  const searchScratch = [{
    query: "SELECT * FROM bjl_corpus_search(target_topic := 'food_beverage')",
    result: [
      { item_name: 'Sharing a bottle with people you care about', primary_topic: 'food_beverage', question_type: 'joy_scale', score: 78.4, n: 232, item_id: 5499, resolution: 'unique' },
      { item_name: 'Fresh fruit', primary_topic: 'food_beverage', question_type: 'joy_scale', score: 76.3, n: 435, item_id: null, resolution: 'ambiguous' },
    ],
  }];

  // The sidecar the synthesizer is INSTRUCTED to emit: no tag, no item_id.
  const cleanItems = [
    { item_name: 'Sharing a bottle with people you care about', primary_topic: 'food_beverage', question_type: 'joy_scale', score: 78.4, n: 232 },
    { item_name: 'Fresh fruit', primary_topic: 'food_beverage', question_type: 'joy_scale', score: 76.3, n: 435 },
  ];

  let f = guard.runProvenanceGuard({
    cross_domain_items: cleanItems, home_topic: 'travel', scratch: searchScratch,
  }).failures || [];
  ok('a compliant Shape B sidecar passes', f.length === 0, JSON.stringify(f).slice(0, 300));
  ok('no tag failure is raised for untagged rows',
    !f.some(x => x.reason === 'cross_domain_tag_not_in_allowlist'));

  // An ambiguous row is still fully citable — resolution must not gate the
  // guard. This is the rule that keeps identity out of the reader's way.
  ok('an ambiguous row (item_id NULL) is not rejected',
    !f.some(x => x.claim && x.claim.item_name === 'Fresh fruit'));

  // Real provenance failures must still fail. The fix relaxed the tag
  // requirement, nothing else.
  f = guard.runProvenanceGuard({
    cross_domain_items: [{ ...cleanItems[0], score: 91.2 }],
    home_topic: 'travel', scratch: searchScratch,
  }).failures || [];
  ok('a wrong score still fails', f.some(x => x.reason === 'cross_domain_score_mismatch'));

  f = guard.runProvenanceGuard({
    cross_domain_items: [{ item_name: 'Something nobody measured', primary_topic: 'travel', score: 70, n: 200 }],
    home_topic: 'travel', scratch: searchScratch,
  }).failures || [];
  ok('an invented item still fails', f.some(x => x.reason === 'cross_domain_item_not_in_allowlist'));

  f = guard.runProvenanceGuard({
    cross_domain_items: cleanItems, home_topic: 'food_beverage', scratch: searchScratch,
  }).failures || [];
  ok('home-topic bleed still fails', f.some(x => x.reason === 'cross_domain_home_topic_bleed'));

  // Legacy bridges rows DO carry tags, and the tag check must still bite
  // for them. Relaxing it everywhere would have been the lazy fix.
  const legacyScratch = [{
    query: 'SELECT * FROM bjl_corpus_bridges_v2(...)',
    result: [{ item_name: 'A quiet morning', primary_topic: 'home', question_type: 'joy_scale', score: 70.1, n: 300, tag: 'tranquil' }],
  }];
  f = guard.runProvenanceGuard({
    cross_domain_items: [{ item_name: 'A quiet morning', primary_topic: 'home', question_type: 'joy_scale', score: 70.1, n: 300, tag: 'invented_tag' }],
    home_topic: 'travel', scratch: legacyScratch,
  }).failures || [];
  ok('a bogus tag on a TAGGED row still fails', f.some(x => x.reason === 'cross_domain_tag_not_in_allowlist'));

  f = guard.runProvenanceGuard({
    cross_domain_items: [{ item_name: 'A quiet morning', primary_topic: 'home', question_type: 'joy_scale', score: 70.1, n: 300, tag: 'tranquil' }],
    home_topic: 'travel', scratch: legacyScratch,
  }).failures || [];
  ok('a correct tag on a tagged row passes', f.length === 0, JSON.stringify(f).slice(0, 300));

  // Mixed scratch is judged row by row, not in bulk. A blanket "skip the
  // tag check when no tags exist" would have quietly stopped enforcing
  // tags the moment one search row joined the scratch.
  f = guard.runProvenanceGuard({
    cross_domain_items: [
      { item_name: 'Fresh fruit', primary_topic: 'food_beverage', question_type: 'joy_scale', score: 76.3, n: 435 },
      { item_name: 'A quiet morning', primary_topic: 'home', question_type: 'joy_scale', score: 70.1, n: 300, tag: 'invented_tag' },
    ],
    home_topic: 'travel', scratch: [...searchScratch, ...legacyScratch],
  }).failures || [];
  ok('mixed scratch: untagged item passes',
    !f.some(x => x.claim && x.claim.item_name === 'Fresh fruit'));
  ok('mixed scratch: tagged item still enforced',
    f.some(x => x.reason === 'cross_domain_tag_not_in_allowlist'));

  // The retry digest. Empty here meant the retry taught the model nothing.
  const digest = guard.buildRetryAllowlistDigest(searchScratch);
  ok('retry digest is not empty for Shape B', digest.length > 0);
  const members = digest.flatMap(d => d.members || []);
  ok('retry digest carries both rows', members.length === 2, `got ${members.length}`);
  ok('retry digest keeps exact numbers',
    members.some(m => m.item_name === 'Fresh fruit' && m.n === 435 && m.joy_index === 76.3));
  ok('untagged group is labelled null, not a fake tag',
    digest.every(d => d.thread_tag === null));

  const legacyDigest = guard.buildRetryAllowlistDigest(legacyScratch);
  ok('legacy digest still groups by tag',
    legacyDigest.length === 1 && legacyDigest[0].thread_tag === 'tranquil');
}

// ---------------------------------------------------------------------
// Part 2 — the arm, live.
// ---------------------------------------------------------------------

async function part2() {
  console.log('\nPart 2 — grounded corpus arm (live)\n');
  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const read = async (sql) => {
    const { data, error } = await db.rpc('execute_read_sql', { query_text: sql });
    if (error) throw new Error(error.message);
    return data;
  };

  const rows = await read(
    "SELECT * FROM bjl_corpus_search(target_topic := 'food_beverage')");
  ok('arm returns rows', rows.length > 0);

  const cols = Object.keys(rows[0] || {});
  for (const c of ['item_name', 'primary_topic', 'question_type', 'score', 'n', 'item_id', 'resolution']) {
    ok(`return carries ${c}`, cols.includes(c));
  }

  const GROUNDED = ['unique', 'adjudicated'];
  ok('every resolution is one of the four verdicts',
    rows.every(r => ['unique', 'adjudicated', 'ambiguous', 'unmatched'].includes(r.resolution)));
  ok('no row has a null resolution', rows.every(r => r.resolution != null));

  // Both directions. Either alone would pass a broken function.
  ok('grounded rows all carry an item_id',
    rows.filter(r => GROUNDED.includes(r.resolution)).every(r => r.item_id != null));
  ok('ungrounded rows never carry an item_id',
    rows.filter(r => !GROUNDED.includes(r.resolution)).every(r => r.item_id == null));

  // A resolved item_id must be a real item, not a number that looks like one.
  const ids = rows.filter(r => r.item_id != null).map(r => r.item_id);
  if (ids.length) {
    const found = await read(
      `SELECT count(*) AS c FROM bjl_items WHERE item_id IN (${ids.join(',')})`);
    ok('every returned item_id exists in bjl_items',
      Number(found[0].c) === new Set(ids).size, `${found[0].c} of ${new Set(ids).size}`);

    const names = await read(
      `SELECT i.item_id, i.item_name FROM bjl_items i WHERE i.item_id IN (${ids.join(',')})`);
    const byId = new Map(names.map(r => [r.item_id, r.item_name]));
    ok('every returned item_id names the row it was attached to',
      rows.filter(r => r.item_id != null).every(r => byId.get(r.item_id) === r.item_name));
  }

  // The filter guard predates this change and must survive it.
  const inert = await read('SELECT * FROM bjl_corpus_search()');
  ok('an all-NULL call is still inert', inert.length === 0, `returned ${inert.length}`);

  // The worklist.
  const wl = await read(`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE status = 'pending')      AS pending,
           count(*) FILTER (WHERE resolved_by IS NOT NULL) AS claimed,
           count(*) FILTER (WHERE array_length(candidate_item_ids,1) < 2) AS not_ambiguous
      FROM bjl_item_resolutions`);
  ok('worklist is seeded', Number(wl[0].total) === 366, `got ${wl[0].total}`);
  ok('every seeded row is pending', Number(wl[0].pending) === Number(wl[0].total));
  ok('the seed claims no human provenance', Number(wl[0].claimed) === 0);
  ok('every worklist row is genuinely ambiguous', Number(wl[0].not_ambiguous) === 0);

  // The arm only reads resolved rows, so a pending suggestion must not leak
  // into a claim. This is the rule that keeps a machine guess from wearing
  // a human's provenance.
  const leak = await read(`
    SELECT count(*) AS c
      FROM bjl_corpus_search(target_topic := 'food_beverage') s
      JOIN bjl_item_resolutions r ON r.item_name = s.item_name
     WHERE r.status <> 'resolved' AND s.item_id IS NOT NULL`);
  ok('no pending worklist row grounds an item_id', Number(leak[0].c) === 0);
}

(async () => {
  part1();
  if (!process.argv.includes('--guard-only')) await part2();

  console.log('');
  if (failures.length) {
    console.log(`FAILED — ${passed} passed, ${failures.length} failed:`);
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log(`ALL ASSERTIONS PASS — ${passed} assertions.`);
})().catch(err => { console.error('\nERROR: ' + err.message); process.exit(1); });
