#!/usr/bin/env node
// =====================================================================
// A thin audience must announce itself.
//
// WHAT THIS PINS
//
// bjl_audience_affinity_v2 keeps items whose per-item audience count
// (aud_n) clears min_aud_n, default 75. aud_n is drawn FROM the audience,
// so aud_n <= audience_size always. When the audience itself is smaller
// than 75, NO item can clear the bar -- the request is arithmetically
// impossible and the arm returns zero rows.
//
// That was not hypothetical. Across 60 days, 8 of 32 affinity_v2 calls
// returned nothing, and all four that could be replayed were impossible
// rather than empty:
//
//   job c2acaf5d   3 of 5 names resolved   audience 56
//   job c6061f5f   1 of 1 names resolved   audience 73   <- missed by two
//   job c635c8d9   0 of 6 names resolved   audience  0
//   job 587f65ac   0 of 3 names resolved   audience  0
//
// The thin band lets those audiences through at a relaxed floor of 30 and
// marks every row audience_thin: true. Measured across 6 genuinely thin
// audiences, 23 of 38 recovered rows were reportable -- so this band
// carries real findings, not just noise, which is exactly why the warning
// on them has to be load-bearing.
//
// The rule pinned here: a row that only exists because the floor was
// relaxed must arrive DECLARED thin. A thin finding stripped of its
// warning reads identically to one resting on 400 people, and a
// reportable-and-thin row (material gap, small base) is the most
// dangerous shape in the set because it looks strongest and is weakest.
//
// The asymmetry is deliberate and is tested below. A NOT-thin row need
// not carry the flag at all, so v1 rows and every scratch predating the
// thin band keep passing untouched. Only the dangerous direction is
// required. Widening what must be declared would have broken every
// historical fixture to buy nothing.
//
// NON-VACUITY
//
// Each refusal was proved by reverting its clause and confirming this
// file fails legibly. Recipe:
//   cp netlify/functions/bjl-cross-domain-provenance-guard.js /tmp/g.orig.js
//   <break one clause>
//   node bin/test_audience_thin_band.js     # must FAIL, legibly
//   cp /tmp/g.orig.js netlify/functions/bjl-cross-domain-provenance-guard.js
//   diff /tmp/g.orig.js netlify/functions/bjl-cross-domain-provenance-guard.js
//
// Assertions are null-safe on purpose: a test that throws aborts the
// suite and reports nothing, which is not a passing proof.
// =====================================================================

const path = require('path');
const { runProvenanceGuard } = require(
  path.join(__dirname, '..', 'netlify', 'functions', 'bjl-cross-domain-provenance-guard'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else      { fail++; console.log('FAIL  ' + name); }
}

// Job c6061f5f's real shape: audience 73, two points under the floor.
const THIN_SCRATCH = [{
  type: 'query',
  query: "SELECT * FROM bjl_audience_affinity_v2(ARRAY['Hot sauce'])",
  result: [
    { construct: 'joy', primary_topic: 'health_wellness', item_name: 'Vitamins',
      rel_lift: 4.7, audience_score: 61.2, general_score: 56.5, aud_n: 72,
      audience_size: 73, reportable: true, audience_thin: true },
  ],
}];

// A full-floor audience. Same shape, nothing thin about it.
const FAT_SCRATCH = [{
  type: 'query',
  query: "SELECT * FROM bjl_audience_affinity_v2(ARRAY['Fresh fruit'])",
  result: [
    { construct: 'joy', primary_topic: 'retail', item_name: 'Finding a great deal on a brand they love',
      rel_lift: 4.4, audience_score: 65.1, general_score: 60.7, aud_n: 412,
      audience_size: 1160, reportable: true, audience_thin: false },
  ],
}];

// A v1-era row: no audience_thin column at all.
const V1_SCRATCH = [{
  type: 'query',
  query: "SELECT * FROM bjl_audience_affinity(ARRAY['Fresh fruit'])",
  result: [
    { construct: 'joy', primary_topic: 'retail', item_name: 'Finding a great deal on a brand they love',
      rel_lift: 4.4, audience_ji: 65.1, general_ji: 60.7, aud_n: 412 },
  ],
}];

const entry = (over) => Object.assign({
  item_name: 'Vitamins', primary_topic: 'health_wellness', construct: 'joy',
  rel_lift: 4.7, audience_score: 61.2, general_score: 56.5, aud_n: 72,
  reportable: true,
}, over);

const run = (audience_affinity, scratch) =>
  runProvenanceGuard({ audience_affinity, scratch }).failures || [];
const reasons = (fs) => fs.map(f => f && f.reason);

// ---------------------------------------------------------------------
// The core refusal: a thin row must say it is thin.
// ---------------------------------------------------------------------
{
  const f = run([entry({})], THIN_SCRATCH);   // audience_thin omitted entirely
  check('a thin row emitted without the flag is refused',
    reasons(f).indexOf('audience_thin_undeclared') !== -1);
}
{
  const f = run([entry({ audience_thin: false })], THIN_SCRATCH);
  check('a thin row emitted as NOT thin is refused',
    reasons(f).indexOf('audience_thin_undeclared') !== -1);
}
{
  const f = run([entry({ audience_thin: true })], THIN_SCRATCH);
  check('a thin row correctly declared thin passes',
    reasons(f).indexOf('audience_thin_undeclared') === -1
    && reasons(f).indexOf('audience_thin_mismatch') === -1);
}

// ---------------------------------------------------------------------
// The asymmetry. A not-thin row need not carry the flag -- this is what
// keeps every pre-thin-band fixture passing. But it may not LIE.
// ---------------------------------------------------------------------
const fatEntry = (over) => Object.assign({
  item_name: 'Finding a great deal on a brand they love', primary_topic: 'retail',
  construct: 'joy', rel_lift: 4.4, audience_score: 65.1, general_score: 60.7,
  aud_n: 412, reportable: true,
}, over);
{
  const f = run([fatEntry({})], FAT_SCRATCH);   // flag omitted, row is not thin
  check('a not-thin row may omit the flag entirely',
    reasons(f).indexOf('audience_thin_undeclared') === -1
    && reasons(f).indexOf('audience_thin_mismatch') === -1);
}
{
  const f = run([fatEntry({ audience_thin: true })], FAT_SCRATCH);
  check('claiming thin on a row that cleared the floor is refused',
    reasons(f).indexOf('audience_thin_mismatch') !== -1);
}
{
  const f = run([{ item_name: 'Finding a great deal on a brand they love',
    primary_topic: 'retail', construct: 'joy', rel_lift: 4.4,
    audience_ji: 65.1, general_ji: 60.7, aud_n: 412, reportable: true }], V1_SCRATCH);
  check('a v1 row with no audience_thin column still passes untouched',
    reasons(f).indexOf('audience_thin_undeclared') === -1
    && reasons(f).indexOf('audience_thin_mismatch') === -1);
}

// ---------------------------------------------------------------------
// reportable and audience_thin are independent axes. The reportable AND
// thin row is the one that looks strongest and rests on least, so the
// thin check must fire on it even though reportability is clean.
// ---------------------------------------------------------------------
{
  const f = run([entry({ reportable: true })], THIN_SCRATCH);  // thin omitted
  check('a reportable row is still refused when it hides a thin base',
    reasons(f).indexOf('audience_thin_undeclared') !== -1
    && reasons(f).indexOf('audience_reportable_mismatch') === -1);
}
{
  // Both flags wrong at once: each must be reported, not just the first.
  const f = run([entry({ reportable: false, audience_thin: false })], THIN_SCRATCH);
  check('reportable and thin failures are reported independently',
    reasons(f).indexOf('audience_thin_undeclared') !== -1
    && reasons(f).indexOf('audience_reportable_mismatch') !== -1);
}

// ---------------------------------------------------------------------
// The thin check must not fire on a row that never matched. An unmatched
// entry already fails; adding a second confusing reason helps nobody.
// ---------------------------------------------------------------------
{
  const f = run([entry({ item_name: 'Not a real item' })], THIN_SCRATCH);
  check('an unmatched item fails on the allowlist, not on thinness',
    reasons(f).indexOf('audience_item_not_in_allowlist') !== -1
    && reasons(f).indexOf('audience_thin_undeclared') === -1);
}
{
  const f = run([entry({ rel_lift: 99.9 })], THIN_SCRATCH);
  check('a number mismatch does not also raise a thin failure',
    reasons(f).indexOf('audience_thin_undeclared') === -1);
}

// ---------------------------------------------------------------------
// Malformed input must not throw. This runs on the failure path.
// ---------------------------------------------------------------------
{
  let threw = false, f = null;
  try {
    f = run([entry({ audience_thin: 'yes' }), null, {}],
            [{ type: 'query', query: 'bjl_audience_affinity_v2(x)', result: null }]);
  } catch (_) { threw = true; }
  check('malformed input does not throw', !threw);
  check('malformed input still yields an array of failures', Array.isArray(f));
}

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail === 0 ? 0 : 1);
