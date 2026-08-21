#!/usr/bin/env node
/**
 * Two things, both found by reading live runs rather than by reading code.
 *
 * 1. THE PIVOT BLIND SPOT -- a real fabrication surface, not a bar technicality.
 *
 *    The axis latch matches a claim's cohort against the cohort VALUE its row
 *    carried. Job cee0bae9's investigator wrote the cut as a pivot instead:
 *
 *      AVG(r.joy_index) FILTER (WHERE p.gender = 'Female') AS ji_female,
 *      AVG(r.joy_index) FILTER (WHERE p.gender = 'Male')   AS ji_male
 *
 *    Now the cohort is in the column NAME. rowAxisValues finds no axis column,
 *    the row reads as un-cut, and the latch does not fail -- it never runs.
 *    Every number on the row clears any claim that names no cohort, while the
 *    prose names one. So a read citing 70.1 as men's number, when 70.1 is
 *    `ji_female`, was accepted. A cohort swap did not reject. That is the
 *    same true-number-false-attribution failure the axis latch was written for,
 *    arriving through a door the latch could not see.
 *
 *    Zero axis failures on a pivot run was never evidence of checking. It meant
 *    the latch was asleep.
 *
 *    The fix forbids the representation rather than chasing it. Teaching the
 *    latch to parse cohorts out of FILTER predicates would add a parser that
 *    has to be right for the guard to be honest, and a thing that has to be
 *    right is a thing that can be fooled. A cut written as a cut is checkable,
 *    so the answer is to write it as a cut -- and the rejection says so.
 *
 *    The load-bearing assertion is the SWAP one. Rejecting the pivot shape is
 *    only worth anything if the swap that used to sail through now stops.
 *
 * 2. ITEM-ALLOWLIST LEGIBILITY -- the same class as the subject-not-in-set gap.
 *
 *    cee0bae9's first pass cited `item_name: "everyday"` and `"big_ticket"` --
 *    its own category labels. Correctly rejected. But the failure carried no
 *    detail and no list of what the real names were, alone among the evidence
 *    latches: the axis failure returns `cohorts_available`, the number mismatch
 *    returns the values each row held, the comparison subject failure returns
 *    the set members. Told its names were wrong and not told what was right,
 *    the retry abandoned the evidence framing and reached for prose, which then
 *    died on the comparative latch. A real read lost to an unactionable
 *    failure.
 *
 *    Showing the names is legibility, not licence, and the last block asserts
 *    exactly that: the matching rule is untouched.
 *
 * Fixtures are live rows, pulled 2026-08-21, gender cut on the travel arc.
 * The known answer they encode is the direction flip cee0bae9 actually found:
 *
 *   ANTICIPATING your vacation   F 70.1 (n=993)  > M 64.3 (n=732)
 *   FLYING to a destination      F 39.0 (n=2572) < M 47.9 (n=2122)
 *
 * Exits non-zero on any failed assertion.
 */

const path = require('path');
const { runConnectiveReadGuard, pivotAxesInSql } = require(
  path.join(__dirname, '..', 'netlify', 'functions', 'bjl-cross-domain-provenance-guard'));

const results = [];
function check(name, cond) { results.push([name, !!cond]); }

const ANT = 'ANTICIPATING your vacation';
const FLY = 'FLYING (on a commercial airline) to a vacation destination';

const reasons = v => (v.failures || []).map(f => f.reason);
const has = (v, reason) => reasons(v).includes(reason);

// ---------------------------------------------------------------------------
// The same cut, written both ways.
// ---------------------------------------------------------------------------

// As a cut: the cohort is a VALUE on the row, one row per cohort.
const CUT = [{
  type: 'query',
  query: 'SELECT i.item_name, p.gender, ROUND(AVG(r.joy_index)::numeric,1) AS ji, COUNT(*) AS n '
       + 'FROM bjl_responses r JOIN bjl_items i ON i.item_id = r.item_id '
       + 'JOIN bjl_respondents p ON p.respondent_id = r.respondent_id '
       + "WHERE p.gender IN ('Male','Female') GROUP BY 1, p.gender",
  result: [
    { item_name: ANT, gender: 'Female', ji: 70.1, n: 993 },
    { item_name: ANT, gender: 'Male',   ji: 64.3, n: 732 },
    { item_name: FLY, gender: 'Female', ji: 39.0, n: 2572 },
    { item_name: FLY, gender: 'Male',   ji: 47.9, n: 2122 },
  ],
}];

// As a pivot: the cohort is in the column NAME, both cohorts on one row.
// Same four numbers, same four counts, no cohort anywhere a check can read.
const PIVOT = [{
  type: 'query',
  query: 'SELECT i.item_name, '
       + "ROUND(AVG(r.joy_index) FILTER (WHERE p.gender = 'Female')::numeric,1) AS ji_female, "
       + "COUNT(*) FILTER (WHERE p.gender = 'Female') AS n_female, "
       + "ROUND(AVG(r.joy_index) FILTER (WHERE p.gender = 'Male')::numeric,1) AS ji_male, "
       + "COUNT(*) FILTER (WHERE p.gender = 'Male') AS n_male "
       + 'FROM bjl_responses r JOIN bjl_items i ON i.item_id = r.item_id '
       + 'JOIN bjl_respondents p ON p.respondent_id = r.respondent_id GROUP BY 1',
  result: [
    { item_name: ANT, ji_female: 70.1, n_female: 993,  ji_male: 64.3, n_male: 732 },
    { item_name: FLY, ji_female: 39.0, n_female: 2572, ji_male: 47.9, n_male: 2122 },
  ],
}];

// The true read, stated without comparative wording so the only latch under
// test here is the cohort one.
const trueRead = (antAxis, flyAxis) => ({
  has_read: true,
  read: 'Anticipation and execution split by gender across one trip. Women sit at 70.1 '
      + 'on anticipating a vacation (n=993) while men sit at 47.9 on flying to it (n=2,122).',
  evidence: [
    { item_name: ANT, axis: antAxis, score: 70.1, n: 993,  note: 'anticipation' },
    { item_name: FLY, axis: flyAxis, score: 47.9, n: 2122, note: 'execution' },
  ],
  figures: [],
  comparisons: [],
  why_not: null,
});

// ---------------------------------------------------------------------------
// 1. The cut shape. The latch has a cohort value to match, so it works.
// ---------------------------------------------------------------------------

const cutTrue = runConnectiveReadGuard({
  connective_read: trueRead('Female', 'Male'), scratch: CUT });
check('cut shape: the true read, correctly attributed, passes',
  cutTrue.ok === true);

// The proof that the latch is doing anything at all: swap the two cohorts and
// keep every number identical. Both numbers are still real and still on real
// rows; only the attribution is false.
const cutSwapped = runConnectiveReadGuard({
  connective_read: trueRead('Male', 'Female'), scratch: CUT });
check('cut shape: THE SWAP -- same numbers, cohorts exchanged, is rejected',
  cutSwapped.ok === false);
// It lands on the joint check rather than on the cohort-exists check, and that
// is the right place: both cohorts are real, so what is false is the PAIRING
// of these numbers with this cohort. The latch matches (cohort, score, n) on
// one row, which is exactly the claim, and reports the numbers the named
// cohort actually carried.
check('cut shape: and it is the cohort-to-number pairing that fails',
  has(cutSwapped, 'connective_read_number_mismatch'));

// ---------------------------------------------------------------------------
// 2. The pivot shape. This is the blind spot.
// ---------------------------------------------------------------------------

const pivotTrue = runConnectiveReadGuard({
  connective_read: trueRead('Female', 'Male'), scratch: PIVOT });
check('pivot shape: a cohort claim on a pivot row is rejected',
  pivotTrue.ok === false);
check('pivot shape: and the rejection names the shape',
  has(pivotTrue, 'connective_read_cohort_in_column_name'));

const pivotFail = (pivotTrue.failures || [])
  .find(f => f.reason === 'connective_read_cohort_in_column_name') || {};
check('pivot shape: the rejection says which axis went into the column names',
  Array.isArray(pivotFail.pivot_axes) && pivotFail.pivot_axes.includes('gender'));
check('pivot shape: and tells the retry to re-run it as a GROUP BY',
  String(pivotFail.detail || '').includes('GROUP BY gender'));

// THE ONE THAT MATTERS. Before this fix the pivot row read as un-cut, so the
// cohort in the prose was matched against nothing and the swap cleared. The
// numbers here are real, the rows are real, and the attribution is backwards.
const pivotSwapped = runConnectiveReadGuard({
  connective_read: {
    has_read: true,
    read: 'Men lead the anticipation of a trip at 70.1 (n=993), while women lead the '
        + 'flying at 47.9 (n=2,122).',
    evidence: [
      { item_name: ANT, axis: 'Male',   score: 70.1, n: 993,  note: 'anticipation' },
      { item_name: FLY, axis: 'Female', score: 47.9, n: 2122, note: 'execution' },
    ],
    figures: [], comparisons: [], why_not: null,
  },
  scratch: PIVOT,
});
check('pivot shape: THE SWAP that used to sail through is now rejected',
  pivotSwapped.ok === false);
check('pivot shape: and it is the pivot latch that stops it',
  has(pivotSwapped, 'connective_read_cohort_in_column_name'));

// Naming no cohort must not be a way round it either. This is the exact hole:
// on a pivot row an unattributed claim used to seat on any number the row
// held, while the prose carried the attribution the guard never saw.
const pivotUnattributed = runConnectiveReadGuard({
  connective_read: {
    has_read: true,
    read: 'Anticipating a vacation reaches 70.1 among women (n=993) while flying reaches '
        + '47.9 among men (n=2,122).',
    evidence: [
      { item_name: ANT, score: 70.1, n: 993,  note: 'anticipation' },
      { item_name: FLY, score: 47.9, n: 2122, note: 'execution' },
    ],
    figures: [], comparisons: [], why_not: null,
  },
  scratch: PIVOT,
});
check('pivot shape: dropping the axis field does not buy the claim a seat',
  pivotUnattributed.ok === false && has(pivotUnattributed, 'connective_read_cohort_in_column_name'));

// A pivot result is not a seat for the arithmetic latches either, and this is
// not covered by the evidence rejection above. The comparison form is what the
// prompt now pushes a two-cohort direction claim toward, so if it could seat on
// pivot rows the fix would have moved the hole rather than closed it.
//
// Two members on two DIFFERENT pivot rows, which is what makes this bite: the
// distinct-row rule is satisfied honestly, so nothing else stops it. 70.1 is
// women's anticipation and 47.9 is men's flying, and the member LABELS are
// never matched against a row -- there is no cohort on a pivot row to match
// them to. So the claim below, which is backwards on both counts, seats and
// its ordering holds.
const pivotComparison = runConnectiveReadGuard({
  connective_read: {
    has_read: true,
    read: 'Men are higher than women across the trip.',
    evidence: [
      { item_name: ANT, score: 70.1, n: 993,  note: 'a' },
      { item_name: FLY, score: 47.9, n: 2122, note: 'b' },
    ],
    figures: [],
    comparisons: [{
      claim: 'Men are higher than women across the trip',
      direction: 'greater', subject: 'Male', against: 'Female',
      set: [{ label: 'Male', value: 70.1 }, { label: 'Female', value: 47.9 }],
      basis_n: [993, 2122],
    }],
    why_not: null,
  },
  scratch: PIVOT,
});
check('pivot shape: a comparison cannot seat its members on pivot rows',
  has(pivotComparison, 'comparison_member_not_in_rows'));

// The figure latch, same reasoning, and the case that needs a mixed scratch to
// show. On the cut, 70.1 and 64.3 sit on two different rows, so a two-operand
// figure over them may only seat across rows the evidence already cites --
// and this read cites 47.9, not 64.3. On the pivot the pair sits on ONE row,
// which is a same-row seat and needs no evidence at all. So the pivot copy of
// the identical data buys a figure a seat the cut refuses it.
const MIXED = CUT.concat(PIVOT);
const mixedFigure = runConnectiveReadGuard({
  connective_read: {
    has_read: true,
    read: 'Women reach 70.1 on anticipating a vacation (n=993) and men 47.9 on flying '
        + 'to it (n=2,122), a spread of 5.8 between the sexes on anticipation.',
    evidence: [
      { item_name: ANT, axis: 'Female', score: 70.1, n: 993,  note: 'a' },
      { item_name: FLY, axis: 'Male',   score: 47.9, n: 2122, note: 'b' },
    ],
    figures: [{ label: 'women minus men on anticipating', value: 5.8, from: [70.1, 64.3] }],
    comparisons: [],
    why_not: null,
  },
  scratch: MIXED,
});
check('pivot shape: a figure cannot use a pivot row as a same-row seat',
  has(mixedFigure, 'figure_not_in_rows'));

// ---------------------------------------------------------------------------
// 3. The detector. It has to be blunt in the safe direction only.
// ---------------------------------------------------------------------------

check('detector: a FILTER pivot on an axis is caught',
  pivotAxesInSql(PIVOT[0].query).includes('gender'));

check('detector: a CASE WHEN pivot on an axis is caught',
  pivotAxesInSql("SELECT i.item_name, AVG(CASE WHEN p.generation = 'Gen Z' THEN r.joy_index END) "
    + 'AS ji_genz FROM bjl_responses r GROUP BY 1').includes('generation'));

check('detector: a plain cut is not a pivot',
  pivotAxesInSql(CUT[0].query).length === 0);

// The precision that keeps this from rejecting the shape it exists to ask for.
// A cut may legitimately use FILTER for a subcount while still grouping on the
// axis -- and when it groups on the axis, the cohort IS on the row and the
// latch can match it.
check('detector: an axis that is also grouped on is a value, not a pivot',
  pivotAxesInSql("SELECT p.gender, COUNT(*) FILTER (WHERE p.gender = 'Female') AS f "
    + 'FROM bjl_respondents p GROUP BY p.gender').length === 0);

check('detector: a FILTER on something that is not a cohort is not a pivot',
  pivotAxesInSql('SELECT i.item_name, COUNT(*) FILTER (WHERE r.joy_index > 50) AS n_high '
    + 'FROM bjl_responses r GROUP BY 1').length === 0);

// The third spelling, and the one the clearing run actually reached for.
// No FILTER, no CASE -- two single-cohort CTEs joined back together on the
// item, which lands the two cohorts side by side on one row with the cohort
// recorded only in the aliases. Identical shape, so it has to be identically
// refused; a detector that catches two of the three spellings has not detected
// the shape, it has only moved the hole to the spelling it does not know.
check('detector: a CTE-join pivot is caught even with no FILTER and no CASE',
  pivotAxesInSql(
    "WITH female AS (SELECT i.item_name, AVG(r.joy_index) AS ji_f FROM bjl_responses r "
    + 'JOIN bjl_items i ON i.item_id = r.item_id JOIN bjl_respondents p '
    + "ON p.respondent_id = r.respondent_id WHERE p.gender = 'Female' GROUP BY 1), "
    + 'male AS (SELECT i.item_name, AVG(r.joy_index) AS ji_m FROM bjl_responses r '
    + 'JOIN bjl_items i ON i.item_id = r.item_id JOIN bjl_respondents p '
    + "ON p.respondent_id = r.respondent_id WHERE p.gender = 'Male' GROUP BY 1) "
    + 'SELECT f.item_name, f.ji_f, m.ji_m FROM female f JOIN male m USING (item_name)'
  ).includes('gender'));

// The false positive the equality-only rule exists to avoid, and the reason
// that rule reads `=` and not `IN`. A scoping filter names its cohorts in one
// list and then aggregates ACROSS them: the row is honestly un-cut, not
// pivoted, and refusing it would reject a legitimate whole-population shape.
check('detector: an IN-list scoping filter is not a pivot',
  pivotAxesInSql('SELECT i.item_name, AVG(r.joy_index) AS ji FROM bjl_responses r '
    + 'JOIN bjl_items i ON i.item_id = r.item_id JOIN bjl_respondents p '
    + "ON p.respondent_id = r.respondent_id WHERE p.gender IN ('Male','Female') "
    + 'GROUP BY 1').length === 0);

check('detector: no SQL at all is not a pivot',
  pivotAxesInSql('').length === 0 && pivotAxesInSql(null).length === 0);

// ---------------------------------------------------------------------------
// 4. Item-allowlist legibility.
// ---------------------------------------------------------------------------

const categoryLabels = runConnectiveReadGuard({
  connective_read: {
    has_read: true,
    read: 'Everyday pleasures sit at 70.1 (n=993) and big-ticket trips at 47.9 (n=2,122).',
    evidence: [
      { item_name: 'everyday',   score: 70.1, n: 993,  note: 'a' },
      { item_name: 'big_ticket', score: 47.9, n: 2122, note: 'b' },
    ],
    figures: [], comparisons: [], why_not: null,
  },
  scratch: CUT,
});
check('legibility: a category label is still not an item name',
  categoryLabels.ok === false && has(categoryLabels, 'connective_read_item_not_in_allowlist'));

const labelFail = (categoryLabels.failures || [])
  .find(f => f.reason === 'connective_read_item_not_in_allowlist') || {};
check('legibility: the failure now hands back the names that did come back',
  Array.isArray(labelFail.items_available)
  && labelFail.items_available.includes(ANT)
  && labelFail.items_available.includes(FLY));
check('legibility: and says why a category label is not one of them',
  String(labelFail.detail || '').includes('copied verbatim'));

// The relevant subset, not an arbitrary one: a name sharing a word with the
// rejected claim sorts ahead of one that does not.
const vacationish = runConnectiveReadGuard({
  connective_read: {
    has_read: true,
    read: 'Anticipating vacation sits at 70.1 (n=993) and flying at 47.9 (n=2,122).',
    evidence: [
      { item_name: 'ANTICIPATING vacation', score: 70.1, n: 993,  note: 'a' },
      { item_name: FLY, axis: 'Male', score: 47.9, n: 2122, note: 'b' },
    ],
    figures: [], comparisons: [], why_not: null,
  },
  scratch: CUT,
});
const nearFail = (vacationish.failures || [])
  .find(f => f.reason === 'connective_read_item_not_in_allowlist') || {};
check('legibility: the closest name is offered first',
  (nearFail.items_available || [])[0] === ANT);

// Legibility, not licence. Showing the names changes nothing about the match:
// a near-miss is still a miss, and the correct name still has to carry the
// correct cohort and the correct numbers.
check('LICENCE CHECK: a near-miss name is still rejected',
  vacationish.ok === false);

const wrongNumber = runConnectiveReadGuard({
  connective_read: trueRead('Female', 'Male'), scratch: CUT });
check('LICENCE CHECK: the correct-name path is unchanged and still passes',
  wrongNumber.ok === true);

const fabricated = runConnectiveReadGuard({
  connective_read: {
    has_read: true,
    read: 'Women sit at 78.4 on anticipating a vacation (n=993) and men at 47.9 on flying (n=2,122).',
    evidence: [
      { item_name: ANT, axis: 'Female', score: 78.4, n: 993,  note: 'a' },
      { item_name: FLY, axis: 'Male',   score: 47.9, n: 2122, note: 'b' },
    ],
    figures: [], comparisons: [], why_not: null,
  },
  scratch: CUT,
});
check('LICENCE CHECK: a fabricated score under a real name is still rejected',
  fabricated.ok === false && has(fabricated, 'connective_read_number_mismatch'));

// ---------------------------------------------------------------------------
const failed = results.filter(r => !r[1]);
for (const [name, ok] of results) console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' assertions passed');
if (failed.length) process.exit(1);
