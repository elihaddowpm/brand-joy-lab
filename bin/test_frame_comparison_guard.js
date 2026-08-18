#!/usr/bin/env node
/**
 * The ordering check on the frame pass's connective read.
 *
 * The first read this system ever verified said:
 *
 *   "The largest gap across all 14 modes is playful: 52% of live music
 *    verbatims carry it versus 18% of home cooking verbatims, a 34-point
 *    spread."
 *
 * Every number in that sentence is real and copied correctly off a row.
 * Playful's gap IS 34 points. The sentence is still false: hedonic runs 69.8%
 * home cooking against 30% live music, a 39.8-point spread. The numbers were
 * true and the RANKING was the lie, and no check on numerals can see that,
 * because 34 is a true number.
 *
 * That is not an incidental bug. The insight this pass exists to produce is
 * usually a superlative -- "the surprising thing is that X matters most" is the
 * shape of nearly every read worth having -- so the tool's most valuable
 * sentence and its most dangerous one are the same sentence, and only
 * recomputing the ordering tells them apart.
 *
 * So this file pins the rule: a comparative claim carries the whole set it
 * ranks over, and the guard does the ranking itself.
 *
 *   REJECT   the shipped sentence, superlative wording with nothing behind it
 *   REJECT   the same claim carrying all 14 rows -- hedonic is larger
 *   REJECT   the same claim carrying 3 of the 14
 *   VERIFY   the true superlative over the full set
 *   VERIFY   the downgrade: the same finding with the ranking word removed
 *   REJECT   "identical" / "parity" on 67.4 and 70.1
 *
 * Fixtures are the real rows from job 8e3edf63 -- query 8 is the mode
 * comparison, query 5 is the joy-index pull.
 *
 * Exits non-zero on any failed assertion.
 */

const path = require('path');
const { runConnectiveReadGuard } = require(
  path.join(__dirname, '..', 'netlify', 'functions', 'bjl-cross-domain-provenance-guard'));

const results = [];
function check(name, cond) { results.push([name, !!cond]); }

// ---------------------------------------------------------------------------
// Fixtures: job 8e3edf63's actual query 8 and query 5 output.
// ---------------------------------------------------------------------------
const MODES = [
  { mode: 'hedonic',            hc_n: 97, lm_n: 15,   hc_pct: 69.8, lm_pct: 30 },
  { mode: 'relational',         hc_n: 81, lm_n: 34,   hc_pct: 58.3, lm_pct: 68 },
  { mode: 'playful',            hc_n: 25, lm_n: 26,   hc_pct: 18,   lm_pct: 52 },
  { mode: 'tranquil',           hc_n: 23, lm_n: 5,    hc_pct: 16.5, lm_pct: 10 },
  { mode: 'physical',           hc_n: 15, lm_n: 8,    hc_pct: 10.8, lm_pct: 16 },
  { mode: 'aesthetic',          hc_n: 15, lm_n: 8,    hc_pct: 10.8, lm_pct: 16 },
  { mode: 'sentimental',        hc_n: 14, lm_n: 3,    hc_pct: 10.1, lm_pct: 6 },
  { mode: 'achievement',        hc_n: 10, lm_n: 3,    hc_pct: 7.2,  lm_pct: 6 },
  { mode: 'inspirational',      hc_n: 5,  lm_n: 1,    hc_pct: 3.6,  lm_pct: 2 },
  { mode: 'self_actualization', hc_n: 4,  lm_n: 3,    hc_pct: 2.9,  lm_pct: 6 },
  { mode: 'awe',                hc_n: 2,  lm_n: 4,    hc_pct: 1.4,  lm_pct: 8 },
  { mode: 'freedom',            hc_n: 3,  lm_n: null, hc_pct: 2.2,  lm_pct: null },
  { mode: 'spiritual',          hc_n: 2,  lm_n: 2,    hc_pct: 1.4,  lm_pct: 4 },
  { mode: 'triumph',            hc_n: 2,  lm_n: 1,    hc_pct: 1.4,  lm_pct: 2 },
].map(r => Object.assign({}, r, { hc_total: 139, lm_total: 50 }));

const LM = 'Listening to LIVE MUSIC';
const HC = 'Having a HOME COOKED meal in your home';

const SCRATCH = [
  {
    type: 'query',
    query: 'SELECT i.item_name, COUNT(*) AS n, ROUND(AVG(r.joy_index)::numeric,1) AS ji '
         + 'FROM bjl_responses r JOIN bjl_items i ON i.item_id = r.item_id GROUP BY 1',
    result: [
      { item_name: 'Listening to MUSIC', item_id: 236,  n: 1245, ji: 71.5 },
      { item_name: HC,                    item_id: 4581, n: 836,  ji: 70.1 },
      { item_name: LM,                    item_id: 4625, n: 377,  ji: 67.4 },
      { item_name: 'Cookies',             item_id: 3138, n: 831,  ji: 66.8 },
    ],
  },
  {
    type: 'query',
    query: 'WITH live_music_verbs AS (SELECT respondent_id, joy_modes FROM bjl_verbatims) '
         + 'SELECT mode, hc_n, lm_n, hc_pct, lm_pct, hc_total, lm_total FROM ...',
    result: MODES,
  },
];

// Grounded evidence, so every assertion below isolates the comparison check.
const EVIDENCE = [
  { item_name: LM, score: 67.4, n: 377 },
  { item_name: HC, score: 70.1, n: 836 },
];

function frame(read, comparisons) {
  return runConnectiveReadGuard({
    connective_read: { has_read: true, read, evidence: EVIDENCE, comparisons },
    scratch: SCRATCH,
  });
}
function reasons(r) { return r.failures.map(f => f.reason); }

// The gap for one mode, as the read computes it: |live music % - home cooking %|.
function gapMember(mode) {
  const row = MODES.find(m => m.mode === mode);
  const from = row.lm_pct === null ? [row.hc_pct] : [row.lm_pct, row.hc_pct];
  const value = from.length === 1 ? from[0] : Math.round(Math.abs(from[0] - from[1]) * 10) / 10;
  return { label: mode, value, from };
}
const FULL_SET = MODES.map(m => gapMember(m.mode));

// ---------------------------------------------------------------------------
// The shipped sentence, exactly as it went out.
// ---------------------------------------------------------------------------
const SHIPPED = 'Two experiences that score identically at the headline level arrive at that '
  + 'parity through their most divergent mode. The largest gap across all 14 modes is playful: '
  + '52% of live music verbatims carry it versus 18% of home cooking verbatims, a 34-point spread.';

check('shipped read: a superlative with no set behind it is rejected',
  reasons(frame(SHIPPED, [])).includes('uncarried_comparative_claim'));

// ---------------------------------------------------------------------------
// The claim carrying its set. This is the assertion the whole file is for:
// every number true, the ordering false, and the guard catches it.
// ---------------------------------------------------------------------------
const CARRIED = 'The largest gap across all 14 modes is playful, a 34-point spread, '
  + 'across 50 live music and 139 home cooking verbatims.';

const wrongMax = frame(CARRIED, [{
  claim: 'The largest gap across all 14 modes is playful',
  direction: 'max', subject: 'playful', set: FULL_SET, basis_n: [50, 139],
}]);
check('carried set: a false superlative over true numbers is rejected',
  reasons(wrongMax).includes('comparison_ordering_false'));
check('carried set: the failure names the actual maximum',
  JSON.stringify(wrongMax.failures).includes('hedonic=39.8'));

// The true superlative on the same set verifies.
const TRUE_MAX = 'The largest gap across all 14 modes is hedonic, a 39.8-point spread, '
  + 'across 50 live music and 139 home cooking verbatims.';
check('carried set: the true superlative verifies',
  frame(TRUE_MAX, [{
    claim: 'The largest gap across all 14 modes is hedonic',
    direction: 'max', subject: 'hedonic', set: FULL_SET, basis_n: [50, 139],
  }]).ok);

// The slice. Three real modes, playful genuinely the largest of the three, and
// the sentence still false about all 14.
check('sliced set: ranking 3 of the 14 rows is rejected as incomplete',
  reasons(frame(CARRIED, [{
    claim: 'The largest gap across all 14 modes is playful',
    direction: 'max', subject: 'playful', basis_n: [50, 139],
    set: [gapMember('playful'), gapMember('awe'), gapMember('achievement')],
  }])).includes('comparison_set_incomplete'));

// min works the same way.
check('carried set: a false minimum is rejected',
  reasons(frame('The smallest gap across all 14 modes is playful, across 50 and 139 verbatims.', [{
    claim: 'The smallest gap across all 14 modes is playful',
    direction: 'min', subject: 'playful', set: FULL_SET, basis_n: [50, 139],
  }])).includes('comparison_ordering_false'));

// ---------------------------------------------------------------------------
// The downgrade. This is the fallback the rule depends on being available:
// the same finding, the ranking word removed, no set required, still true.
// ---------------------------------------------------------------------------
// The downgraded sentence states three numbers -- 52, 18, 34 -- that live on a
// mode row `evidence` has no shape for. Declaring them as `figures` is the
// legal form: same rows, same arithmetic, no ranking asserted.
const DOWNGRADE = 'Playful separates the two: 52% of live music verbatims carry it against 18% '
  + 'of home cooking verbatims, a 34-point difference.';
const DOWNGRADE_FIGURES = [
  { label: 'playful, live music', value: 52 },
  { label: 'playful, home cooking', value: 18 },
  { label: 'the distance between them', value: 34, from: [52, 18] },
];

check('downgrade: the finding without the ranking word passes with no set',
  runConnectiveReadGuard({
    connective_read: { has_read: true, read: DOWNGRADE, evidence: EVIDENCE,
      comparisons: [], figures: DOWNGRADE_FIGURES },
    scratch: SCRATCH,
  }).ok);

check('downgrade: the same sentence with the numbers undeclared is rejected',
  reasons(frame(DOWNGRADE, [])).includes('prose_number_unaccounted'));

// ---------------------------------------------------------------------------
// Relational wording gets the same scrutiny as an explicit superlative.
// 67.4 and 70.1 are 2.7 apart and were called "identical".
// ---------------------------------------------------------------------------
check('parity: calling 67.4 and 70.1 identical is rejected',
  reasons(frame('Live music and home cooking are identical at the headline level, 67.4 and 70.1.', [{
    claim: 'Live music and home cooking are identical at the headline level',
    direction: 'equal', subject: 'live music', against: 'home cooking',
    set: [{ label: 'live music', value: 67.4 }, { label: 'home cooking', value: 70.1 }],
    basis_n: [377, 836],
  }])).includes('comparison_ordering_false'));

check('parity: an unbacked relational word is rejected too',
  reasons(frame('Live music and home cooking sit at parity, 67.4 and 70.1.', []))
    .includes('uncarried_comparative_claim'));

// A pairwise claim spans two queries and does NOT have to carry the rest of
// either result -- that pairing is the point of this pass.
check('pairwise: a true cross-query comparison verifies without full coverage',
  frame('Home cooking runs higher than live music, 70.1 against 67.4, on 836 and 377 responses.', [{
    claim: 'Home cooking runs higher than live music',
    direction: 'greater', subject: 'home cooking', against: 'live music',
    set: [{ label: 'home cooking', value: 70.1 }, { label: 'live music', value: 67.4 }],
    basis_n: [836, 377],
  }]).ok);

// ---------------------------------------------------------------------------
// Places other than first. The first live run under this check made two true
// claims -- "ranked second in both distributions" and "lands in the top three
// for both" -- that max/min could not express, so the model forced them into a
// shape that did not fit and the guard rejected them for the wrong reason. A
// guard that leaves a true claim no legal form is the over-strict half of the
// defect this whole line of work exists to end, so it is pinned here.
//
// By home-cooking share: hedonic 69.8, relational 58.3, playful 18. Relational
// is second, and it is in the top three.
// ---------------------------------------------------------------------------
const HC_SET = MODES.map(m => ({ label: m.mode, value: m.hc_pct }))
  .filter(m => m.value !== null);
const HC_READ = 'Relational is the second most common mode in home cooking at 58.3%, '
  + 'and it lands in the top three, across 139 verbatims.';

check('rank: a true second place verifies',
  frame(HC_READ, [{
    claim: 'Relational is the second most common mode in home cooking',
    direction: 'rank', k: 2, subject: 'relational', set: HC_SET, basis_n: [139],
  }]).ok);

check('rank: a false second place is rejected and names the real one',
  (() => {
    const r = frame(HC_READ.replace('Relational is the second', 'Playful is the second'), [{
      claim: 'Playful is the second most common mode in home cooking',
      direction: 'rank', k: 2, subject: 'playful', set: HC_SET, basis_n: [139],
    }]);
    return reasons(r).includes('comparison_ordering_false')
        && JSON.stringify(r.failures).includes('"actual_place":3');
  })());

check('top: membership in the leading three verifies',
  frame(HC_READ, [{
    claim: 'it lands in the top three',
    direction: 'top', k: 3, subject: 'relational', set: HC_SET, basis_n: [139],
  }]).ok);

check('top: a member outside the cutoff is rejected',
  reasons(frame(HC_READ, [{
    claim: 'it lands in the top three',
    direction: 'top', k: 3, subject: 'awe', set: HC_SET, basis_n: [139],
  }])).includes('comparison_ordering_false'));

// spiritual, triumph and awe all sit at 1.4: no place claim among them is
// answerable, and saying so is different from calling it false.
check('a tie makes a place claim unanswerable, not merely wrong',
  (() => {
    const r = frame('Awe ranks twelfth among home cooking modes at 1.4%, across 139 verbatims.', [{
      claim: 'Awe ranks twelfth among home cooking modes',
      direction: 'rank', k: 12, subject: 'awe', set: HC_SET, basis_n: [139],
    }]);
    return reasons(r).includes('comparison_ordering_false')
        && JSON.stringify(r.failures).includes('Tied on value');
  })());

check('a place claim still requires the whole set',
  reasons(frame(HC_READ, [{
    claim: 'Relational is the second most common mode in home cooking',
    direction: 'rank', k: 2, subject: 'relational', basis_n: [139],
    set: HC_SET.slice(0, 4),
  }])).includes('comparison_set_incomplete'));

check('rank without k is rejected',
  reasons(frame(HC_READ, [{
    claim: 'Relational is the second most common mode in home cooking',
    direction: 'rank', subject: 'relational', set: HC_SET, basis_n: [139],
  }])).includes('malformed_comparison'));

// ---------------------------------------------------------------------------
// Shape and provenance of the set itself.
// ---------------------------------------------------------------------------
check('a member whose numbers are on no returned row is rejected',
  reasons(frame(TRUE_MAX, [{
    claim: 'The largest gap across all 14 modes is hedonic',
    direction: 'max', subject: 'hedonic', basis_n: [50, 139],
    set: FULL_SET.map(m => m.label === 'awe' ? { label: 'awe', value: 44.4, from: [88.8, 44.4] } : m),
  }])).includes('comparison_member_not_in_rows'));

check('a value that is not derivable from its own row numbers is rejected',
  reasons(frame(TRUE_MAX, [{
    claim: 'The largest gap across all 14 modes is hedonic',
    direction: 'max', subject: 'hedonic', basis_n: [50, 139],
    set: FULL_SET.map(m => m.label === 'playful' ? { label: 'playful', value: 61, from: [52, 18] } : m),
  }])).includes('comparison_value_not_derivable'));

check('a comparison backing a sentence not in the read is rejected',
  reasons(frame(TRUE_MAX, [{
    claim: 'Awe is the sharpest divider of the two',
    direction: 'max', subject: 'hedonic', set: FULL_SET, basis_n: [50, 139],
  }])).includes('comparison_claim_not_in_read'));

check('a subject outside its own set is rejected',
  reasons(frame(TRUE_MAX, [{
    claim: 'The largest gap across all 14 modes is hedonic',
    direction: 'max', subject: 'nostalgic', set: FULL_SET, basis_n: [50, 139],
  }])).includes('comparison_subject_not_in_set'));

// ---------------------------------------------------------------------------
// The base. Every other surface carries its n; the frame was exempt, which let
// a 34-point spread over 50 and 139 verbatims read like a spread over the
// corpus.
// ---------------------------------------------------------------------------
check('a comparison with no base is rejected',
  reasons(frame(TRUE_MAX, [{
    claim: 'The largest gap across all 14 modes is hedonic',
    direction: 'max', subject: 'hedonic', set: FULL_SET,
  }])).includes('comparison_basis_missing'));

check('a base stated to the guard but not to the reader is rejected',
  reasons(frame('The largest gap across all 14 modes is hedonic, a 39.8-point spread.', [{
    claim: 'The largest gap across all 14 modes is hedonic',
    direction: 'max', subject: 'hedonic', set: FULL_SET, basis_n: [50, 139],
  }])).includes('comparison_basis_undisclosed'));

check('a base on no returned row is rejected',
  reasons(frame('The largest gap across all 14 modes is hedonic, over 500 and 139 verbatims.', [{
    claim: 'The largest gap across all 14 modes is hedonic',
    direction: 'max', subject: 'hedonic', set: FULL_SET, basis_n: [500, 139],
  }])).includes('comparison_basis_not_in_rows'));

// ---------------------------------------------------------------------------
// The comparison check must not disturb the surfaces already guarded.
// ---------------------------------------------------------------------------
check('a plain non-comparative read still passes',
  runConnectiveReadGuard({
    connective_read: { has_read: true, evidence: EVIDENCE, comparisons: [],
      read: 'Live music at 67.4 and home cooking at 70.1 draw on different modes.' },
    scratch: SCRATCH,
  }).ok);

check('a fabricated evidence number is still rejected',
  reasons(runConnectiveReadGuard({
    connective_read: { has_read: true, comparisons: [],
      read: 'Live music at 88.4 and home cooking at 70.1 draw on different modes.',
      evidence: [{ item_name: LM, score: 88.4, n: 377 }, { item_name: HC, score: 70.1, n: 836 }] },
    scratch: SCRATCH,
  })).includes('connective_read_number_mismatch'));

check('an honest no-corner result is unaffected',
  runConnectiveReadGuard({
    connective_read: { has_read: false, read: null, evidence: [],
      why_not: 'Nothing crossed; the largest signal was the one the brief predicted.' },
    scratch: SCRATCH,
  }).ok);

// ---------------------------------------------------------------------------
// Rounding. Live job c903ec21 produced a correct read -- live music's
// generational spread is 13.7 against home cooking's 8.7 -- and it was dropped
// because the displayed 74.5 and 65.9 subtract to 8.6. The real gap is
// 74.5205 - 65.8683 = 8.6522, so 8.7 is right and the guard was wrong.
//
// The fix is at the root: the investigator now returns the unrounded value
// alongside the rounded one, so the guard can perform the SAME subtraction the
// read did. Two exact computations are accepted -- the displayed operands and
// the unrounded ones -- and nothing between or around them. 8.5 was accepted
// under the interval version that this replaces; it is not accepted now.
// ---------------------------------------------------------------------------
const RAW_SCRATCH = [{
  type: 'query',
  query: 'SELECT i.item_name, AVG(...) FILTER (...) AS genx_ji, ... FROM bjl_responses r ...',
  result: [
    { item_name: LM, hi_ji: 72.9, hi_ji_raw: 72.8712, lo_ji: 59.2, lo_ji_raw: 59.1544, n: 93 },
    { item_name: HC, hi_ji: 74.5, hi_ji_raw: 74.5205, lo_ji: 65.9, lo_ji_raw: 65.8683, n: 438 },
  ],
}];
// The same two rows with the unrounded copies withheld.
const ROUNDED_ONLY = [{
  type: 'query',
  query: RAW_SCRATCH[0].query,
  result: RAW_SCRATCH[0].result.map(r =>
    ({ item_name: r.item_name, hi_ji: r.hi_ji, lo_ji: r.lo_ji, n: r.n })),
}];

const GAP = 'Live music splits generations by 13.7 points against home cooking\'s 8.7, on 93 and 438.';
const gapCmp = value => [{
  claim: 'Live music splits generations by 13.7 points against home cooking\'s 8.7',
  direction: 'greater', subject: 'live music', against: 'home cooking',
  set: [{ label: 'live music', value: 13.7, from: [72.9, 59.2] },
        { label: 'home cooking', value, from: [74.5, 65.9] }],
  basis_n: [93, 438],
}];
const gapRun = (value, scratch) => runConnectiveReadGuard({
  connective_read: {
    has_read: true, read: GAP, comparisons: gapCmp(value),
    evidence: [{ item_name: LM, score: 72.9, n: 93 }, { item_name: HC, score: 74.5, n: 438 }],
    figures: [{ label: 'live music, older cohort', value: 59.2 },
              { label: 'home cooking, older cohort', value: 65.9 }],
  },
  scratch,
});

check('rounding: a gap subtracted before rounding is accepted when the row carries the raw value',
  !reasons(gapRun(8.7, RAW_SCRATCH)).includes('comparison_value_not_derivable'));

check('rounding: the arithmetic on the displayed operands is still accepted',
  !reasons(gapRun(8.6, RAW_SCRATCH)).includes('comparison_value_not_derivable'));

check('rounding: exactly two values are admitted, not a band around them',
  gapRun(8.9, RAW_SCRATCH).failures
    .find(f => f.reason === 'comparison_value_not_derivable').detail.accepted.join(',') === '8.6,8.7');

check('rounding: 8.5 was inside the old interval and is now rejected',
  reasons(gapRun(8.5, RAW_SCRATCH)).includes('comparison_value_not_derivable'));

check('rounding: with no unrounded copy on the row the check is exact again',
  reasons(gapRun(8.7, ROUNDED_ONLY)).includes('comparison_value_not_derivable'));

check('rounding: the rounded-operand answer still passes without an unrounded copy',
  !reasons(gapRun(8.6, ROUNDED_ONLY)).includes('comparison_value_not_derivable'));

// ---------------------------------------------------------------------------
// The prose latch. Live job 837726b0 passed every check above and shipped
// "28.5 points below Gen Z's 61.5" where 61.5 - 32.4 is 29.1 -- then called it
// "the 29-point generational gap" two sentences later. The 28.5 was never
// declared anywhere the guard could see it.
// ---------------------------------------------------------------------------
const PROSE_SCRATCH = [{
  type: 'query',
  query: 'SELECT i.item_name, p.generation, AVG(r.joy_index) AS ji, COUNT(*) AS n '
       + 'FROM bjl_responses r JOIN bjl_items i ON i.item_id = r.item_id '
       + 'JOIN bjl_respondents p ON p.respondent_id = r.respondent_id GROUP BY 1,2',
  result: [
    { item_name: 'A Music- or Festival-Focused Trip', generation: 'Boomer', ji: 32.4, n: 816 },
    { item_name: 'A Music- or Festival-Focused Trip', generation: 'Gen Z',  ji: 61.5, n: 522 },
  ],
}];
const proseRead = gap => 'Boomers score 32.4 (n=816) on a music-focused trip, ' + gap
  + ' points under Gen Z\'s 61.5 (n=522).';
const PROSE_EVIDENCE = [
  { item_name: 'A Music- or Festival-Focused Trip', axis: 'Boomer', score: 32.4, n: 816 },
  { item_name: 'A Music- or Festival-Focused Trip', axis: 'Gen Z',  score: 61.5, n: 522 },
];
// The ordering IS carried, exactly as the shipped read carried it. Everything
// the guard was handed is correct; the only wrong number is the one that
// appears solely in the sentence.
const proseCmp = gap => [{
  claim: gap + ' points under Gen Z\'s 61.5',
  direction: 'greater', subject: 'gen z', against: 'boomers',
  set: [{ label: 'gen z', value: 61.5 }, { label: 'boomers', value: 32.4 }],
  basis_n: [816, 522],
}];
const proseRun = gap => runConnectiveReadGuard({
  connective_read: {
    has_read: true, read: proseRead(gap), comparisons: proseCmp(gap), figures: [],
    evidence: PROSE_EVIDENCE,
  },
  scratch: PROSE_SCRATCH,
});

check('prose: the shipped wrong difference is rejected',
  reasons(proseRun(28.5)).includes('prose_number_unaccounted'));

check('prose: the rejection names the number and offers the true one',
  (() => {
    const f = proseRun(28.5).failures.find(x => x.reason === 'prose_number_unaccounted');
    return f.claim.number === 28.5 && f.detail.nearest_declared_differences.includes(29.1);
  })());

check('prose: the true difference between two cited rows needs no declaration',
  !reasons(proseRun(29.1)).includes('prose_number_unaccounted'));

check('prose: an integer restatement of a true difference is allowed',
  !reasons(proseRun(29)).includes('prose_number_unaccounted'));

check('prose: a number on no cited row is rejected even when it is real',
  reasons(runConnectiveReadGuard({
    connective_read: {
      has_read: true, comparisons: [], figures: [], evidence: PROSE_EVIDENCE,
      read: 'Boomers score 32.4 (n=816) on a music-focused trip; Gen Z 61.5 (n=522); '
          + 'elsewhere the number is 44.5.',
    },
    scratch: PROSE_SCRATCH,
  })).includes('prose_number_unaccounted'));

// A figure is the legal form, and it is checked, not merely accepted.
check('figures: a fabricated difference declared as a figure is still rejected',
  reasons(runConnectiveReadGuard({
    connective_read: {
      has_read: true, comparisons: proseCmp(28.5), read: proseRead(28.5),
      figures: [{ label: 'the distance', value: 28.5, from: [61.5, 32.4] }],
      evidence: PROSE_EVIDENCE,
    },
    scratch: PROSE_SCRATCH,
  })).includes('figure_value_not_derivable'));

check('figures: a figure standing on no returned row is rejected',
  reasons(runConnectiveReadGuard({
    connective_read: {
      has_read: true, comparisons: [], evidence: EVIDENCE,
      read: 'Live music at 67.4 and home cooking at 70.1 sit either side of 88.8.',
      figures: [{ label: 'invented', value: 88.8 }],
    },
    scratch: SCRATCH,
  })).includes('figure_not_in_rows'));

check('prose: difference wording with nothing behind it is caught as a comparison',
  reasons(runConnectiveReadGuard({
    connective_read: {
      has_read: true, comparisons: [], figures: [], evidence: EVIDENCE,
      read: 'Home cooking at 70.1 sits above live music at 67.4.',
    },
    scratch: SCRATCH,
  })).includes('uncarried_comparative_claim'));

// ---------------------------------------------------------------------------
const failed = results.filter(r => !r[1]);
for (const [name, ok] of results) console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' assertions passed');
if (failed.length) process.exit(1);
