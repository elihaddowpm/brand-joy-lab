#!/usr/bin/env node
// =====================================================================
// What survives a retry that also failed the guard.
//
// WHAT THIS PINS
//
// When the first provenance pass fails, the whole synthesis is regenerated.
// That regeneration is unconditional: surfaces that already verified get
// re-rolled along with the broken ones, and a re-roll can come back worse.
// Before resolveSurfacesAfterRetry existed, worse-on-the-retry meant the
// surface was emptied -- so a LATER, WRONGER attempt could delete output the
// guard had already cleared.
//
// That is not hypothetical. Job 729a0be3 on 2026-08-26 failed the first pass
// only on cross_domain_home_topic_bleed and cross_domain_item_not_in_allowlist.
// Its cards were clean. The retry fixed cross-domain and returned cards
// failing card_source_mismatch, so the turn shipped with NO CARDS. Nothing
// was ever wrong with the cards the user lost. That job is the fixture below.
//
// The rule being pinned: a surface is only emptied when BOTH passes failed
// it. Recovery serves the pass the guard cleared, so nothing unverified ever
// ships -- this widens what survives, it does not weaken what is checked.
//
// The one place recovery is REFUSED is the interesting case. `threads` and
// `cross_domain_items` are checked against home_topic, so recovering them
// beside a different home_topic would ship a pairing no guard ever saw. When
// the passes disagree on home_topic we decline and strip, because an
// unverifiable combination is worse than a missing sidecar.
//
// NON-VACUITY
//
// Every refusal here was proved to fail when the clause implementing it is
// reverted. Recipe:
//   cp netlify/functions/bjl-query-background.js /tmp/q.orig.js
//   <break one clause>
//   node bin/test_retry_surface_recovery.js     # must FAIL, legibly
//   cp /tmp/q.orig.js netlify/functions/bjl-query-background.js
//   diff /tmp/q.orig.js netlify/functions/bjl-query-background.js
//
// A test that throws instead of failing is not a passing proof -- it aborts
// the suite and reports nothing. Assertions here are null-safe on purpose.
// =====================================================================

for (const line of require('fs').readFileSync(
  require('path').join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const i = line.indexOf('=');
  if (i > 0 && !line.startsWith('#')) {
    process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}

const { resolveSurfacesAfterRetry } = require('../netlify/functions/bjl-query-background');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else      { fail++; console.log('FAIL  ' + name); }
}

const EMPTY = {
  threads: [], cards: [], signature: [], cross_domain_items: [],
  audience_affinity: [], audience_profile: [], audience_selects: [],
  audience_distributions: [],
};
const s = (over) => Object.assign({}, EMPTY, over);

const CARD_A = { headline: 'Home cooking carries the category', stat_items: [{ item_name: 'Having a HOME COOKED meal in your home', score: 74.1 }] };
const CARD_B = { headline: 'Convenience is not the draw', stat_items: [{ item_name: 'Eating at full-service restaurants', score: 70.7 }] };
const XD_GOOD = { item_name: 'Taking a relaxing BATH', primary_topic: 'personal_care', score: 67.3, n: 375 };
const XD_BLEED = { item_name: 'Fresh fruit', primary_topic: 'food_beverage', score: 71.0, n: 400 };

const bleed = (name) => ({ surface: 'cross_domain_items', reason: 'cross_domain_home_topic_bleed', claim: { item_name: name, primary_topic: 'food_beverage' } });
const cardFail = (idx) => ({ surface: 'cards', reason: 'card_source_mismatch', claim: { card_index: idx, item_name: 'x' } });
const cardFailNoIndex = () => ({ surface: 'cards', reason: 'card_source_mismatch', claim: { item_name: 'x' } });

// ---------------------------------------------------------------------
// The 729a0be3 shape: cards clean on pass 1, broken by the retry.
// ---------------------------------------------------------------------
{
  const r = resolveSurfacesAfterRetry({
    first:  { structured: s({ cards: [CARD_A, CARD_B], cross_domain_items: [XD_BLEED] }),
              home_topic: 'food_beverage', failures: [bleed('Fresh fruit')] },
    second: { structured: s({ cards: [], cross_domain_items: [XD_GOOD] }),
              home_topic: 'food_beverage', failures: [cardFail(0)] },
  });
  check('729a0be3: cards the retry broke are recovered, not dropped',
    (r.surfaces.cards || []).length === 2);
  check('729a0be3: the recovered cards are the first pass\'s own',
    (r.surfaces.cards || [])[0] === CARD_A && (r.surfaces.cards || [])[1] === CARD_B);
  check('729a0be3: the surface the retry FIXED comes from the retry',
    (r.surfaces.cross_domain_items || [])[0] === XD_GOOD);
  check('729a0be3: the recovery is reported, not silent',
    Array.isArray(r.recovered) && r.recovered.indexOf('cards') !== -1);
}

// ---------------------------------------------------------------------
// A surface that failed BOTH passes must still be emptied. Recovery must
// not become a way for unverified output to ride through.
// ---------------------------------------------------------------------
{
  const r = resolveSurfacesAfterRetry({
    first:  { structured: s({ cross_domain_items: [XD_BLEED] }), home_topic: 'food_beverage',
              failures: [bleed('Fresh fruit')] },
    second: { structured: s({ cross_domain_items: [XD_BLEED] }), home_topic: 'food_beverage',
              failures: [bleed('Fresh fruit')] },
  });
  check('failed on both passes is still stripped to empty',
    (r.surfaces.cross_domain_items || []).length === 0);
  check('a stripped surface is not reported as recovered',
    (r.recovered || []).indexOf('cross_domain_items') === -1);
}

// ---------------------------------------------------------------------
// home_topic disagreement: recovery of the coupled surfaces is REFUSED.
// This is the fail-closed case -- the entries are individually clean but
// the pairing was never checked.
// ---------------------------------------------------------------------
{
  const r = resolveSurfacesAfterRetry({
    // Both surfaces are clean on pass 1 and both are broken by the retry.
    // Only the home_topic-coupled one is refused recovery.
    first:  { structured: s({ cross_domain_items: [XD_GOOD], cards: [CARD_A] }),
              home_topic: 'food_beverage',
              failures: [{ surface: 'signature', reason: 'signature_not_in_allowlist', claim: {} }] },
    second: { structured: s({ cross_domain_items: [], cards: [] }),
              home_topic: 'travel', failures: [bleed('x'), cardFail(0)] },
  });
  check('home_topic disagreement refuses recovery of cross_domain_items',
    (r.surfaces.cross_domain_items || []).length === 0);
  check('home_topic disagreement does NOT block recovery of uncoupled cards',
    (r.surfaces.cards || []).length === 1);
}
{
  // Same shape, passes agreeing -> the recovery is allowed. Without this
  // the refusal above would pass for the wrong reason.
  const r = resolveSurfacesAfterRetry({
    first:  { structured: s({ cross_domain_items: [XD_GOOD] }),
              home_topic: 'food_beverage', failures: [cardFail(0)] },
    second: { structured: s({ cross_domain_items: [] }),
              home_topic: 'food_beverage', failures: [bleed('x')] },
  });
  check('agreeing home_topic DOES allow cross_domain_items recovery',
    (r.surfaces.cross_domain_items || [])[0] === XD_GOOD);
}

// ---------------------------------------------------------------------
// An empty surface has nothing to recover. Recovery must not resurrect a
// surface the first pass never populated.
// ---------------------------------------------------------------------
{
  const r = resolveSurfacesAfterRetry({
    first:  { structured: s({}), home_topic: null, failures: [] },
    second: { structured: s({ cards: [CARD_A] }), home_topic: null, failures: [cardFailNoIndex()] },
  });
  check('an empty first pass yields no recovery',
    (r.surfaces.cards || []).length === 0 && (r.recovered || []).length === 0);
}

// ---------------------------------------------------------------------
// Per-card index filtering still applies when cards failed BOTH passes.
// Recovery replaces the strip; it must not delete it.
// ---------------------------------------------------------------------
{
  const r = resolveSurfacesAfterRetry({
    first:  { structured: s({ cards: [CARD_A] }), home_topic: null, failures: [cardFail(0)] },
    second: { structured: s({ cards: [CARD_A, CARD_B] }), home_topic: null, failures: [cardFail(0)] },
  });
  check('cards bad on both passes keep per-index filtering',
    (r.surfaces.cards || []).length === 1 && (r.surfaces.cards || [])[0] === CARD_B);
}
{
  const r = resolveSurfacesAfterRetry({
    first:  { structured: s({ cards: [CARD_A] }), home_topic: null, failures: [cardFail(0)] },
    second: { structured: s({ cards: [CARD_A, CARD_B] }), home_topic: null, failures: [cardFailNoIndex()] },
  });
  check('an indexless card failure still drops the whole list',
    (r.surfaces.cards || []).length === 0);
}

// ---------------------------------------------------------------------
// home_topic itself.
// ---------------------------------------------------------------------
{
  const r = resolveSurfacesAfterRetry({
    first:  { structured: s({}), home_topic: 'food_beverage', failures: [] },
    second: { structured: s({}), home_topic: 'food_beverage', failures: [bleed('x')] },
  });
  check('home_topic drops when both coupled surfaces end up empty',
    r.home_topic === null);
}
{
  const r = resolveSurfacesAfterRetry({
    first:  { structured: s({ cross_domain_items: [XD_GOOD] }), home_topic: 'food_beverage', failures: [] },
    second: { structured: s({ cross_domain_items: [XD_GOOD] }), home_topic: 'food_beverage', failures: [cardFail(0)] },
  });
  check('home_topic survives while a coupled surface has entries',
    r.home_topic === 'food_beverage');
}

// ---------------------------------------------------------------------
// A fully clean retry is taken whole -- no recovery, no mixing. Coherence
// between prose and surfaces is worth more than nothing here.
// ---------------------------------------------------------------------
{
  const r = resolveSurfacesAfterRetry({
    first:  { structured: s({ cards: [CARD_A] }), home_topic: 'food_beverage', failures: [bleed('x')] },
    second: { structured: s({ cards: [CARD_B], cross_domain_items: [XD_GOOD] }),
              home_topic: 'food_beverage', failures: [] },
  });
  check('a clean retry is taken whole',
    (r.surfaces.cards || [])[0] === CARD_B && (r.recovered || []).length === 0);
}

// ---------------------------------------------------------------------
// Malformed input must not throw. This runs on the failure path, which is
// the worst possible place to add a crash.
// ---------------------------------------------------------------------
{
  let threw = false;
  let r = null;
  try {
    r = resolveSurfacesAfterRetry({
      first:  { structured: null, home_topic: null, failures: null },
      second: { structured: { cards: 'nope' }, home_topic: null, failures: [null, {}, 'x'] },
    });
  } catch (_) { threw = true; }
  check('malformed input does not throw', !threw);
  check('malformed input yields empty surfaces, not undefined',
    !!r && Array.isArray(r.surfaces && r.surfaces.cards) && r.surfaces.cards.length === 0);
  check('every guarded surface is present in the output',
    !!r && ['threads','cards','signature','cross_domain_items','audience_affinity',
            'audience_profile','audience_selects','audience_distributions']
      .every(k => Array.isArray(r.surfaces[k])));
}

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail === 0 ? 0 : 1);
