#!/usr/bin/env node
/**
 * The cohort check on the frame pass's connective read.
 *
 * The bug this pins is the same shape as the superlative bug and it was live.
 *
 * A cut query -- live music by generation -- returns one row per cohort, and
 * every one of those rows is indexed under the same item. The numbers check
 * accepted ANY row in that bucket:
 *
 *     const matched = bucket.some(row => rowCarriesNumbers(row, claimScore, claimN).ok);
 *
 * So a read could say "Gen Z" and cite 59.2 on n=96 -- which is BOOMERS -- and
 * the guard cleared it, because 59.2 and 96 really did come back together on a
 * real row. A true number carrying a false attribution. Nothing that checks
 * numerals can see it, exactly as with the ranking.
 *
 * On a cross-cutting read the cohort is not a qualifier on the claim. It IS
 * the claim. "Live music scores 72.9 on n=93" is a different sentence
 * depending on whether that is Gen X or Boomers, and one of the two is false.
 *
 * So this file pins the rule: a claim citing a cut row must name the cohort,
 * and the guard matches the numbers against that cohort's row only.
 *
 * Fixtures are live rows, pulled 2026-08-17 from bjl_responses joined to
 * bjl_respondents. The known answer they encode:
 *
 *   live music   59.2 Boomer -> 72.9 Gen X   13.7-point generational spread
 *   home cooking 50.4 Gen Z  -> 53.8 Boomer   3.4-point spread, effectively flat
 *
 * Exits non-zero on any failed assertion.
 */

const path = require('path');
const { runConnectiveReadGuard } = require(
  path.join(__dirname, '..', 'netlify', 'functions', 'bjl-cross-domain-provenance-guard'));

const results = [];
function check(name, cond) { results.push([name, !!cond]); }

const LM = 'Listening to LIVE MUSIC';
const HC = 'Bringing/cooking your favorite dish';

// The cut, as the investigator would return it: one row per cohort, item_name
// selected, generation selected.
const CUT = [{
  type: 'query',
  query: 'SELECT i.item_name, p.generation, ROUND(AVG(r.joy_index)::numeric,1) AS ji, COUNT(*) AS n '
       + 'FROM bjl_responses r JOIN bjl_items i ON i.item_id = r.item_id '
       + 'JOIN bjl_respondents p ON p.respondent_id = r.respondent_id GROUP BY 1,2',
  result: [
    { item_name: LM, generation: 'Boomer',     ji: 59.2, n: 96 },
    { item_name: LM, generation: 'Gen X',      ji: 72.9, n: 93 },
    { item_name: LM, generation: 'Gen Z',      ji: 66.6, n: 64 },
    { item_name: LM, generation: 'Millennial', ji: 70.5, n: 116 },
    { item_name: LM, generation: 'Silent',     ji: 65.0, n: 8 },
    { item_name: HC, generation: 'Boomer',     ji: 53.8, n: 48 },
    { item_name: HC, generation: 'Gen X',      ji: 51.8, n: 66 },
    { item_name: HC, generation: 'Gen Z',      ji: 50.4, n: 79 },
    { item_name: HC, generation: 'Millennial', ji: 52.0, n: 142 },
    { item_name: HC, generation: 'Silent',     ji: 55.0, n: 4 },
  ],
}];

// A whole-population pull. No cut, so no cohort to name.
const POPULATION = [{
  type: 'query',
  query: 'SELECT i.item_name, ROUND(AVG(r.joy_index)::numeric,1) AS ji, COUNT(*) AS n '
       + 'FROM bjl_responses r JOIN bjl_items i ON i.item_id = r.item_id GROUP BY 1',
  result: [
    { item_name: LM, ji: 67.4, n: 377 },
    { item_name: HC, ji: 52.1, n: 339 },
  ],
}];

function read(evidence, scratch, text) {
  return runConnectiveReadGuard({
    connective_read: {
      has_read: true,
      read: text || 'Live music splits by generation where home cooking does not.',
      evidence,
    },
    scratch,
  });
}

const reasons = r => r.failures.map(f => f.reason);

// ---------------------------------------------------------------------------
// Direction 1: the guard passes a TRUE cross-cutting read.
// ---------------------------------------------------------------------------

check('true read: cohorts correctly attached verifies',
  read([
    { item_name: LM, axis: 'Boomer', score: 59.2, n: 96 },
    { item_name: LM, axis: 'Gen X',  score: 72.9, n: 93 },
  ], CUT).ok);

check('true read: the cross-item comparison the tool exists to make verifies',
  read([
    { item_name: LM, axis: 'Gen X',  score: 72.9, n: 93 },
    { item_name: HC, axis: 'Gen X',  score: 51.8, n: 66 },
  ], CUT).ok);

check('true read: the cohort may be named in generation instead of axis',
  read([
    { item_name: LM, generation: 'Boomer', score: 59.2, n: 96 },
    { item_name: LM, generation: 'Gen X',  score: 72.9, n: 93 },
  ], CUT).ok);

check('true read: a read that names only the cohort still grounds',
  read([
    { item_name: 'Gen X',  score: 72.9, n: 93 },
    { item_name: 'Boomer', score: 59.2, n: 96 },
  ], CUT).ok);

// ---------------------------------------------------------------------------
// Direction 2: the guard rejects a FABRICATED one. This is the test that
// matters -- every number below is real and came back on a real row.
// ---------------------------------------------------------------------------

const swapped = read([
  { item_name: LM, axis: 'Gen Z',  score: 59.2, n: 96 },   // Boomers' row
  { item_name: LM, axis: 'Gen X',  score: 72.9, n: 93 },
], CUT);

check('FABRICATION: Boomers\' number attached to Gen Z is rejected',
  !swapped.ok);

check('FABRICATION: the failure is attributed, not a bare mismatch',
  swapped.failures.some(f => f.reason === 'connective_read_number_mismatch'
                          && Array.isArray(f.claim.axis)
                          && f.claim.axis.join(' + ') === 'gen z'));

check('FABRICATION: the failure carries Gen Z\'s real numbers for the retry',
  JSON.stringify(swapped.failures[0].detail).includes('66.6'));

check('FABRICATION: every cohort\'s number is blocked on every other cohort',
  ['Boomer', 'Gen X', 'Gen Z', 'Millennial']
    .every(cohort => [
      { g: 'Boomer', s: 59.2, n: 96 }, { g: 'Gen X', s: 72.9, n: 93 },
      { g: 'Gen Z', s: 66.6, n: 64 },  { g: 'Millennial', s: 70.5, n: 116 },
    ].filter(row => row.g !== cohort).every(row =>
      !read([{ item_name: LM, axis: cohort, score: row.s, n: row.n },
             { item_name: HC, axis: 'Gen X', score: 51.8, n: 66 }], CUT).ok)));

check('FABRICATION: an invented cohort is rejected by name',
  reasons(read([
    { item_name: LM, axis: 'Gen Alpha', score: 72.9, n: 93 },
    { item_name: LM, axis: 'Gen X',     score: 72.9, n: 93 },
  ], CUT)).includes('connective_read_axis_not_in_allowlist'));

// An invented cohort and no cohort at all are different mistakes and need
// different retry instructions. Telling a read that named "Gen Alpha" to
// "name the cohort" would send it round the same loop.
check('FABRICATION: an invented cohort is shown back what it said',
  read([
    { item_name: LM, axis: 'Gen Alpha', score: 72.9, n: 93 },
    { item_name: LM, axis: 'Gen X',     score: 72.9, n: 93 },
  ], CUT).failures.some(f => f.reason === 'connective_read_axis_not_in_allowlist'
                          && Array.isArray(f.claim.axis)
                          && f.claim.axis.includes('gen alpha')));

check('FABRICATION: citing a cut row without naming the cohort is rejected',
  reasons(read([
    { item_name: LM, score: 59.2, n: 96 },
    { item_name: HC, score: 51.8, n: 66 },
  ], CUT)).includes('connective_read_axis_unspecified'));

check('FABRICATION: the rejection lists the cohorts that did come back',
  read([{ item_name: LM, score: 59.2, n: 96 }, { item_name: HC, score: 51.8, n: 66 }], CUT)
    .failures[0].cohorts_available.includes('gen z'));

check('FABRICATION: a cross-item splice is still caught under a real cohort',
  !read([
    { item_name: LM, axis: 'Gen X', score: 51.8, n: 66 },   // home cooking's row
    { item_name: HC, axis: 'Gen X', score: 51.8, n: 66 },
  ], CUT).ok);

check('FABRICATION: score and n spliced across two cohorts is still rejected',
  !read([
    { item_name: LM, axis: 'Gen X', score: 72.9, n: 96 },   // Gen X's ji, Boomers' n
    { item_name: HC, axis: 'Gen X', score: 51.8, n: 66 },
  ], CUT).ok);

// ---------------------------------------------------------------------------
// Not a regression: a claim with no cut behind it is untouched.
// ---------------------------------------------------------------------------

check('no regression: whole-population evidence needs no cohort',
  read([
    { item_name: LM, score: 67.4, n: 377 },
    { item_name: HC, score: 52.1, n: 339 },
  ], POPULATION).ok);

check('no regression: a fabricated whole-population number is still rejected',
  !read([
    { item_name: LM, score: 88.8, n: 377 },
    { item_name: HC, score: 52.1, n: 339 },
  ], POPULATION).ok);

check('no regression: an honest no-corner result is unaffected',
  runConnectiveReadGuard({
    connective_read: { has_read: false, read: null, evidence: [], why_not: 'nothing crossed' },
    scratch: CUT,
  }).ok);

// ---------------------------------------------------------------------------

let failed = 0;
for (const [name, ok] of results) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} assertions passed`);
process.exit(failed ? 1 : 0);
