#!/usr/bin/env node
// =====================================================================
// A few bad rows must not cost the reader the whole surface.
//
// WHAT THIS PINS
//
// When both synthesis passes fail the guard on the same surface, that
// surface used to be emptied. Every row went, including the ones the guard
// had just verified. Cards were the single exception -- they alone carried
// a per-entry index, so they alone got filtered instead of dropped.
//
// The cost of that was concentrated in exactly the output this tool exists
// to produce. Of the nine jobs that retried between 2026-08-26 and 08-27,
// FOUR shipped with no cross_domain_items whatsoever:
//
//   job c6061f5f    7 bad rows    cross_domain_items -> 0
//   job ad5a42e6    5 bad rows    cross_domain_items -> 0
//   job 561a9e6e    4 bad rows    cross_domain_items -> 0
//   job b6514d6a   15 bad rows    cross_domain_items -> 0, cards -> 0
//
// Each had paid 53-121s for the retry first. The around-the-corner surface
// went to zero because a handful of entries in it were wrong.
//
// The rule pinned here: a surface whose failures NAME their rows ships
// minus those rows. This widens what survives; it does not weaken what is
// checked. Every row that ships passed the same guard byte-for-byte, and
// every row that failed is still refused. What changed is that the refusal
// no longer takes the survivors with it.
//
// THE SAFETY CLAUSE, AND WHY IT IS THE IMPORTANT ONE
//
// Some failures are about the LIST, not a row in it --
// no_bridges_rows_in_scratch fires when the arm never ran, and no subset of
// an unauthorized list is authorized. Those carry no index and still strip
// whole. A mixed batch strips whole too: one unlocated failure poisons the
// surface no matter how many located ones sit beside it. The fallback on
// not knowing which row is at fault is to drop all of them, which is what
// makes the widening safe rather than merely generous.
//
// Recovery is still preferred over partial. A recovered surface is whole
// and verified; a partial one is missing whatever the retry got wrong.
//
// NON-VACUITY
//
// Each refusal was proved by reverting its clause and confirming this file
// fails legibly. Recipe:
//   cp netlify/functions/bjl-query-background.js /tmp/q.orig.js
//   <break one clause>
//   node bin/test_retry_partial_surface.js     # must FAIL, legibly
//   cp /tmp/q.orig.js netlify/functions/bjl-query-background.js
//   diff /tmp/q.orig.js netlify/functions/bjl-query-background.js
//
// The end-to-end block at the bottom is load-bearing for that proof. Every
// assertion above it builds its own failure objects, so all of them would
// keep passing if the guard stopped emitting entry_index entirely and the
// resolver silently stripped every surface in production. Only the last
// block reads an index the guard actually produced.
//
// Assertions are null-safe on purpose: a test that throws aborts the suite
// and reports nothing, which is not a passing proof.
// =====================================================================

for (const line of require('fs').readFileSync(
  require('path').join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const i = line.indexOf('=');
  if (i > 0 && !line.startsWith('#')) {
    process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}

const { resolveSurfacesAfterRetry } = require('../netlify/functions/bjl-query-background');
const { runProvenanceGuard } = require('../netlify/functions/bjl-cross-domain-provenance-guard');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else      { fail++; console.log('FAIL  ' + name); }
}

const names = (a) => (Array.isArray(a) ? a : []).map(x => x && x.item_name);

// Five cross-domain items; the retry got rows 1 and 3 wrong. c6061f5f's shape.
const FIVE = [
  { item_name: 'Petting a dog',        primary_topic: 'pets' },
  { item_name: 'Hot sauce',            primary_topic: 'food_beverage' },   // bleed
  { item_name: 'A long walk',          primary_topic: 'outdoors' },
  { item_name: 'Cooking a big meal',   primary_topic: 'food_beverage' },   // bleed
  { item_name: 'Finding a great deal', primary_topic: 'retail' },
];

const bleed = (entry_index) => ({
  surface: 'cross_domain_items', entry_index,
  claim: { item_name: FIVE[entry_index].item_name, primary_topic: 'food_beverage' },
  reason: 'cross_domain_home_topic_bleed',
});

const resolve = (first, second) => resolveSurfacesAfterRetry({ first, second }) || {};
const EMPTY = { structured: {}, home_topic: null, failures: [] };

// ---------------------------------------------------------------------
// The core rule: located failures drop rows, not the surface.
// ---------------------------------------------------------------------
{
  const r = resolve(EMPTY, {
    structured: { cross_domain_items: FIVE },
    home_topic: 'food_beverage',
    failures: [bleed(1), bleed(3)],
  });
  const kept = (r.surfaces || {}).cross_domain_items;
  check('two bad rows of five leave three shipping, not zero',
    Array.isArray(kept) && kept.length === 3);
  check('the rows kept are exactly the ones that did not fail',
    JSON.stringify(names(kept))
      === JSON.stringify(['Petting a dog', 'A long walk', 'Finding a great deal']));
  check('a partial surface is reported, not silent',
    Array.isArray(r.partial) && r.partial.some(p =>
      p && p.surface === 'cross_domain_items' && p.kept === 3 && p.dropped === 2));
  check('a partial surface is NOT reported as recovered',
    Array.isArray(r.recovered) && r.recovered.indexOf('cross_domain_items') === -1);
}
{
  // The coupling. cross_domain_items is checked against home_topic, so a
  // surviving row must keep the home_topic it was checked against.
  const r = resolve(EMPTY, {
    structured: { cross_domain_items: FIVE },
    home_topic: 'food_beverage',
    failures: [bleed(1), bleed(3)],
  });
  check('home_topic survives when rows survive',
    r.home_topic === 'food_beverage');
}
{
  // Every row bad: nothing survives, and that is not a partial ship.
  const r = resolve(EMPTY, {
    structured: { cross_domain_items: [FIVE[1], FIVE[3]] },
    home_topic: 'food_beverage',
    failures: [
      Object.assign(bleed(1), { entry_index: 0 }),
      Object.assign(bleed(3), { entry_index: 1 }),
    ],
  });
  check('a surface whose every row failed still ends up empty',
    ((r.surfaces || {}).cross_domain_items || []).length === 0);
  check('an emptied surface is not reported as partial',
    !(r.partial || []).some(p => p && p.surface === 'cross_domain_items'));
}

// ---------------------------------------------------------------------
// The safety clause. A failure that names no row still strips whole.
// ---------------------------------------------------------------------
{
  const r = resolve(EMPTY, {
    structured: { cross_domain_items: FIVE },
    home_topic: 'food_beverage',
    failures: [{ surface: 'cross_domain_items', claim: null,
                 reason: 'no_bridges_rows_in_scratch' }],
  });
  check('an unlocated failure strips the whole surface',
    ((r.surfaces || {}).cross_domain_items || []).length === 0);
}
{
  // The dangerous shape: one unlocated failure hiding among located ones.
  // If the unlocated one were ignored, four unauthorized rows would ship.
  const r = resolve(EMPTY, {
    structured: { cross_domain_items: FIVE },
    home_topic: 'food_beverage',
    failures: [bleed(1),
               { surface: 'cross_domain_items', claim: null,
                 reason: 'no_bridges_rows_in_scratch' }],
  });
  check('one unlocated failure poisons the surface despite located siblings',
    ((r.surfaces || {}).cross_domain_items || []).length === 0);
}

// ---------------------------------------------------------------------
// Order: recovery beats partial. A whole verified surface is worth more
// than the retry's surface with holes in it.
// ---------------------------------------------------------------------
{
  const r = resolve(
    { structured: { cross_domain_items: [FIVE[0], FIVE[2], FIVE[4]] },
      home_topic: 'food_beverage', failures: [] },
    { structured: { cross_domain_items: FIVE },
      home_topic: 'food_beverage', failures: [bleed(1), bleed(3)] });
  check('a clean first pass is recovered rather than partially shipped',
    (r.recovered || []).indexOf('cross_domain_items') !== -1
    && !(r.partial || []).some(p => p && p.surface === 'cross_domain_items'));
  check('the recovered surface is the first pass\'s own rows',
    JSON.stringify(names((r.surfaces || {}).cross_domain_items))
      === JSON.stringify(['Petting a dog', 'A long walk', 'Finding a great deal']));
}
{
  // Recovery is refused when the passes disagree on home_topic. Partial
  // then applies -- and is sound, because the surviving rows and the
  // home_topic they ship beside both come from the second pass.
  const r = resolve(
    { structured: { cross_domain_items: [FIVE[0]] }, home_topic: 'travel', failures: [] },
    { structured: { cross_domain_items: FIVE },
      home_topic: 'food_beverage', failures: [bleed(1), bleed(3)] });
  check('home_topic disagreement falls through to partial, not to empty',
    ((r.surfaces || {}).cross_domain_items || []).length === 3);
  check('the partial surface ships beside the pass its rows were checked against',
    r.home_topic === 'food_beverage');
}

// ---------------------------------------------------------------------
// Audience affinity gets the same treatment, and cards keep theirs.
// ---------------------------------------------------------------------
{
  const r = resolve(EMPTY, {
    structured: { audience_affinity: [
      { item_name: 'Vitamins' }, { item_name: 'Yoga' }, { item_name: 'Running' }] },
    home_topic: null,
    failures: [{ surface: 'audience_affinity', entry_index: 1,
                 claim: { item_name: 'Yoga' }, reason: 'audience_item_not_in_allowlist' }],
  });
  check('audience_affinity drops the bad row and keeps the rest',
    JSON.stringify(names((r.surfaces || {}).audience_affinity))
      === JSON.stringify(['Vitamins', 'Running']));
}
{
  // Cards carry their index inside claim, not as entry_index. Both
  // spellings are live and both must locate the row.
  const r = resolve(EMPTY, {
    structured: { cards: [{ headline: 'a' }, { headline: 'b' }, { headline: 'c' }] },
    home_topic: null,
    failures: [{ surface: 'cards', claim: { card_index: 1 },
                 reason: 'card_source_mismatch' }],
  });
  const kept = (r.surfaces || {}).cards || [];
  check('a card index spelled the old way still locates its row',
    kept.length === 2 && kept[0] && kept[0].headline === 'a' && kept[1].headline === 'c');
}

// ---------------------------------------------------------------------
// Malformed input must not throw. This runs on the failure path.
// ---------------------------------------------------------------------
{
  let threw = false, r = null;
  try {
    r = resolveSurfacesAfterRetry({
      first: null,
      second: { structured: { cross_domain_items: [null, FIVE[0]] },
                failures: [null, { surface: 'cross_domain_items', entry_index: 0 }] },
    });
  } catch (_) { threw = true; }
  check('malformed input does not throw', !threw);
  check('malformed input still yields every guarded surface',
    !!(r && r.surfaces && Array.isArray(r.surfaces.cards)
       && Array.isArray(r.surfaces.cross_domain_items)));
  check('malformed input yields a partial list, not undefined',
    !!(r && Array.isArray(r.partial)));
}

// ---------------------------------------------------------------------
// END TO END. Everything above builds its own failure objects, so all of
// it would still pass if the guard never emitted entry_index at all and
// every surface silently stripped in production. This block reads an index
// the guard actually produced, and is the only thing here that proves the
// two halves are connected.
// ---------------------------------------------------------------------
{
  const scratch = [{
    type: 'query',
    query: 'SELECT item_name, score, n, primary_topic FROM bjl_corpus_search($1)',
    result: [
      { item_name: 'Petting a dog', score: 71.2, n: 300, primary_topic: 'pets' },
      { item_name: 'Hot sauce',     score: 64.0, n: 210, primary_topic: 'food_beverage' },
      { item_name: 'A long walk',   score: 68.5, n: 412, primary_topic: 'outdoors' },
    ],
  }];
  const items = [
    { item_name: 'Petting a dog', score: 71.2, n: 300, primary_topic: 'pets' },
    { item_name: 'Hot sauce',     score: 64.0, n: 210, primary_topic: 'food_beverage' },
    { item_name: 'A long walk',   score: 68.5, n: 412, primary_topic: 'outdoors' },
  ];
  const out = runProvenanceGuard({
    cross_domain_items: items, home_topic: 'food_beverage', scratch });
  const fs = (out && out.failures || []).filter(f => f && f.surface === 'cross_domain_items');
  const bleedFails = fs.filter(f => f.reason === 'cross_domain_home_topic_bleed');

  check('the guard still catches the home-topic bleed it always caught',
    bleedFails.length === 1);
  check('the guard reports WHICH row bled, not just that one did',
    bleedFails.length === 1 && bleedFails[0].entry_index === 1);

  // Feed the guard's own output back through the resolver: the bad row
  // must drop and the two clean ones must ship.
  const r = resolve(EMPTY, { structured: { cross_domain_items: items },
                             home_topic: 'food_beverage', failures: fs });
  check('guard output drives a real partial ship, end to end',
    JSON.stringify(names((r.surfaces || {}).cross_domain_items))
      === JSON.stringify(['Petting a dog', 'A long walk']));
}

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail === 0 ? 0 : 1);
