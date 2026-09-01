#!/usr/bin/env node
/**
 * Stem binding: a number must belong to the QUESTION it was measured under,
 * not merely to the label it was printed beside.
 *
 * 792 item names in bjl_items repeat, and all 792 of them repeat ACROSS
 * question stems -- they are grid answer-labels that appear once under every
 * stem in the grid. "A BEER" under 12 stems, "Other - Write In" under 26,
 * "Established/Legacy Brands" under 11. Among the 1000 rows the corpus search
 * can reach, 218 names are duplicated; 48 of those collide at an identical
 * score and are harmless, and 170 do not:
 *
 *   "Arlington, Texas"                        7 distinct scores, 26.5..43.9
 *   "Visiting a ZOO"                          4 distinct scores, 54.1..70.0
 *   "Visiting a THEME PARK or amusement park" 4 distinct scores, 50.9..73.3
 *
 * The guard used to key its allowlist on the item name alone, with a bucket
 * of rows per name and a claim matching if ANY row in the bucket matched. Two
 * different questions' "A BEER" shared one bucket. The failure that produces
 * is not a fabricated number -- it is a REAL number seated on the wrong
 * question, which is the hardest kind to notice, because every individual
 * field checks out.
 *
 * (question_id, item_name) is a complete disambiguation of the reachable set:
 * 218 duplicated names collapse to 0, and question_id is populated on 1000 of
 * 1000 rows. item_id would have been the better key and is not usable -- the
 * search resolves it only for unambiguous names, so it is NULL on ~49% of
 * returned rows, and keying on it would fail closed on half of everything.
 *
 * WHAT IS PINNED HERE
 *
 *   VERIFY   a claim naming the right stem
 *   REJECT   a claim naming the WRONG stem, even when score/n/topic all
 *            match some other stem's row exactly            <- the relabel
 *   VERIFY   a claim on scratch that carries no stem at all  <- back-compat
 *   ACCEPT   a stemless claim against a multi-stem bucket    <- held back,
 *            deliberately, see the note in the guard and below
 *
 * The third is what keeps every job recorded before the search returned
 * question_id judged exactly as it was. The fourth is a decision, not an
 * oversight, and it is pinned so that promoting it later has to be done on
 * purpose and has to break this file first.
 *
 * Exits non-zero on any failed assertion.
 */

const path = require('path');
const {
  runProvenanceGuard,
} = require(path.join(__dirname, '..', 'netlify', 'functions', 'bjl-cross-domain-provenance-guard'));

const results = [];
function check(name, cond) { results.push([name, !!cond]); }

const SQL = 'SELECT item_name, score, n, primary_topic, question_id FROM bjl_corpus_search($1)';
const HOME = 'food_beverage';

function guard(items, rows) {
  return runProvenanceGuard({
    cross_domain_items: items,
    home_topic: HOME,
    scratch: [{ type: 'query', query: SQL, result: rows }],
  });
}
function failuresFor(out) {
  return (out && out.failures || []).filter(f => f && f.surface === 'cross_domain_items');
}

// ---------------------------------------------------------------------------
// The collision, built to mirror the real one: ONE name, TWO stems, TWO very
// different scores. Both rows are legitimately in the allowlist.
// ---------------------------------------------------------------------------
const ZOO_ROWS = [
  { item_name: 'Visiting a ZOO', score: 54.1, n: 480, primary_topic: 'travel',        question_id: 11 },
  { item_name: 'Visiting a ZOO', score: 70.0, n: 512, primary_topic: 'entertainment', question_id: 24 },
];

// --- right stem, right numbers -> verifies -------------------------------
{
  const out = guard(
    [{ item_name: 'Visiting a ZOO', score: 70.0, n: 512, primary_topic: 'entertainment', question_id: 24 }],
    ZOO_ROWS);
  check('correct stem verifies', failuresFor(out).length === 0);
}

// --- THE RELABEL. Every field matches a real row; the stem does not. ------
// score/n/topic are stem 24's, verbatim and correct. The claim says stem 11.
// Keyed on name alone this PASSED, because the bucket held a row matching
// 70.0/512/entertainment. It is the wrong question.
//
// It is refused as a score mismatch rather than a stem mismatch, and that is
// the accurate reading: stem 11 IS in the allowlist, so the claim is checked
// against stem 11's row, and stem 11 does not score 70.0. The stem filter's
// job here is to stop stem 24's row from vouching for a claim about stem 11.
{
  const out = guard(
    [{ item_name: 'Visiting a ZOO', score: 70.0, n: 512, primary_topic: 'entertainment', question_id: 11 }],
    ZOO_ROWS);
  const fs = failuresFor(out);
  check('wrong stem is refused', fs.length > 0);
  check('wrong stem refused against ITS OWN row, not the other stem\'s',
    fs.some(f => f.reason === 'cross_domain_score_mismatch'
      && f.detail && f.detail.allowlist === 54.1));
}

// --- a stem the allowlist does not contain at all -------------------------
// Distinct case: no row survives the stem filter, so `closest` is never
// populated and every mismatch branch below it would be skipped. Without an
// explicit failure here the claim passes by falling through all of them.
{
  const out = guard(
    [{ item_name: 'Visiting a ZOO', score: 70.0, n: 512, primary_topic: 'entertainment', question_id: 99 }],
    ZOO_ROWS);
  const fs = failuresFor(out);
  check('a stem absent from the allowlist is refused as stem_mismatch',
    fs.some(f => f.reason === 'cross_domain_item_stem_mismatch'));
  check('stem_mismatch reports the claim and what was available',
    fs.some(f => f.reason === 'cross_domain_item_stem_mismatch'
      && f.detail && f.detail.claim === 99
      && Array.isArray(f.detail.allowlist)
      && f.detail.allowlist.indexOf(11) !== -1
      && f.detail.allowlist.indexOf(24) !== -1));
}

// --- the mirror: right stem, WRONG numbers, still caught -----------------
// Proves the stem filter did not swallow the pre-existing score check.
{
  const out = guard(
    [{ item_name: 'Visiting a ZOO', score: 63.3, n: 512, primary_topic: 'entertainment', question_id: 24 }],
    ZOO_ROWS);
  const fs = failuresFor(out);
  check('right stem with a bad score still fails',
    fs.some(f => f.reason === 'cross_domain_score_mismatch'));
  check('a bad score is NOT reported as a stem problem',
    !fs.some(f => f.reason === 'cross_domain_item_stem_mismatch'));
}

// --- the other half of the collision, to prove both stems are reachable ---
{
  const out = guard(
    [{ item_name: 'Visiting a ZOO', score: 54.1, n: 480, primary_topic: 'travel', question_id: 11 }],
    ZOO_ROWS);
  check('the other stem also verifies on its own numbers', failuresFor(out).length === 0);
}

// --- splicing across stems: stem 11 named, stem 24's score ----------------
{
  const out = guard(
    [{ item_name: 'Visiting a ZOO', score: 70.0, n: 480, primary_topic: 'travel', question_id: 11 }],
    ZOO_ROWS);
  check('score spliced from the other stem is refused', failuresFor(out).length > 0);
}

// ---------------------------------------------------------------------------
// BACK-COMPAT. Every job recorded before the search returned question_id has
// no stem anywhere in its scratch. Those must be judged exactly as before --
// this is the whole reason the stem checks are conditional rather than
// mandatory, and if this breaks, every historical job starts failing.
// ---------------------------------------------------------------------------
const LEGACY_ROWS = [
  { item_name: 'Petting a dog', score: 71.2, n: 300, primary_topic: 'pets' },
  { item_name: 'A long walk',   score: 68.5, n: 412, primary_topic: 'outdoors' },
];
{
  const out = guard(
    [{ item_name: 'Petting a dog', score: 71.2, n: 300, primary_topic: 'pets' }],
    LEGACY_ROWS);
  check('stemless scratch + stemless claim still verifies', failuresFor(out).length === 0);
}
{
  const out = guard(
    [{ item_name: 'Petting a dog', score: 71.2, n: 300, primary_topic: 'pets', question_id: 9 }],
    LEGACY_ROWS);
  check('a claim naming a stem the allowlist does not carry still verifies',
    failuresFor(out).length === 0);
}
{
  const out = guard(
    [{ item_name: 'Petting a dog', score: 40.0, n: 300, primary_topic: 'pets' }],
    LEGACY_ROWS);
  check('stemless scratch still catches a bad score',
    failuresFor(out).some(f => f.reason === 'cross_domain_score_mismatch'));
}

// ---------------------------------------------------------------------------
// HELD BACK ON PURPOSE.
//
// A stemless claim against a bucket spanning two stems with two scores is
// genuinely unverifiable -- nothing says which of 54.1 and 70.0 is meant. By
// the usual rule that should be refused. It is not, yet, because the
// synthesizer has never emitted question_id (bjl_session_figures: 23 rows,
// NULL on all of them) and refusing stemless claims today would reject 38.5%
// of returned rows across 241 replayed calls.
//
// This assertion pins the CURRENT behaviour so that promoting the check is a
// deliberate act that breaks this file and has to be re-reasoned, rather than
// something that silently starts rejecting a third of the corpus.
// ---------------------------------------------------------------------------
{
  const out = guard(
    [{ item_name: 'Visiting a ZOO', score: 70.0, n: 512, primary_topic: 'entertainment' }],
    ZOO_ROWS);
  check('HELD BACK: stemless claim on an ambiguous name is still accepted',
    failuresFor(out).length === 0);
}

// ---------------------------------------------------------------------------
// Row-level refusal must survive. A stem failure has to carry entry_index or
// 8fba327 regresses and one bad row costs the whole surface again. Only the
// middle row names an absent stem; the two either side are good rows and must
// come through untouched.
// ---------------------------------------------------------------------------
{
  const out = guard([
    { item_name: 'Visiting a ZOO', score: 54.1, n: 480, primary_topic: 'travel',        question_id: 11 },
    { item_name: 'Visiting a ZOO', score: 70.0, n: 512, primary_topic: 'entertainment', question_id: 99 },
    { item_name: 'Visiting a ZOO', score: 70.0, n: 512, primary_topic: 'entertainment', question_id: 24 },
  ], ZOO_ROWS);
  const fs = failuresFor(out);
  const stem = fs.filter(f => f.reason === 'cross_domain_item_stem_mismatch');
  check('only the offending row fails', stem.length === 1);
  check('the stem failure names its row', stem.length === 1 && stem[0].entry_index === 1);
}

// --- malformed input must not throw --------------------------------------
{
  let threw = false;
  try {
    guard([
      { item_name: 'Visiting a ZOO', score: 70.0, n: 512, primary_topic: 'entertainment', question_id: 'twenty-four' },
      { item_name: 'Visiting a ZOO', score: 70.0, n: 512, primary_topic: 'entertainment', question_id: null },
    ], ZOO_ROWS);
    guard([{ item_name: 'Visiting a ZOO', score: 70.0, n: 512, primary_topic: 'entertainment', question_id: {} }],
      [{ item_name: 'Visiting a ZOO', score: 70.0, n: 512, primary_topic: 'entertainment', question_id: [] }]);
  } catch (e) { threw = true; }
  check('malformed question_id does not throw', !threw);
}

// ---------------------------------------------------------------------------
const failed = results.filter(([, ok]) => !ok);
for (const [name, ok] of results) console.log((ok ? '  ok   ' : '  FAIL ') + name);
console.log((results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
