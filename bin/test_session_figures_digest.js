#!/usr/bin/env node
// =====================================================================
// The figures digest — read side of bjl_session_figures.
//
// WHAT THIS PINS
//
// The write side (test_session_figures_writer.js) proves a figure is stored
// attached to the item it was measured on. This proves it comes BACK that
// way, because the read is where the binding gets handed to the model and a
// digest that drops the construct, the cohort, or the pairing itself would
// reintroduce the ambiguity the ledger exists to remove.
//
// The failure being prevented is reconstruction. On 2026-08-21 a turn held
// the shape of an earlier answer but not its values and put 58.0 -- the
// safety barrier -- back as a community expectation. The fix is not a better
// memory, it is not having to remember: the binding is on the page.
//
// So the assertions below are mostly about what must NEVER be separable:
//   - a number from its item
//   - a number from its construct (58.0 barrier vs 17.6 expectation)
//   - a cohort figure from its cohort
//
// NON-VACUITY
//
// Every refusal here was proved to fail when the clause implementing it is
// reverted. Recipe:
//   cp netlify/functions/bjl-query-background.js /tmp/q.orig.js
//   <break one clause>
//   node bin/test_session_figures_digest.js     # must FAIL, legibly
//   cp /tmp/q.orig.js netlify/functions/bjl-query-background.js
//   diff /tmp/q.orig.js netlify/functions/bjl-query-background.js
//
// A test that throws instead of failing is not a passing proof -- it aborts
// the suite and reports nothing. Assertions here are null-safe on purpose.
// =====================================================================

// The function module builds a Supabase client at import time, so .env has
// to be in process.env before the require. Same idiom as the sibling suites.
for (const line of require('fs').readFileSync(
  require('path').join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const i = line.indexOf('=');
  if (i > 0 && !line.startsWith('#')) {
    process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}

const {
  formatSessionFigures,
  dedupeFigureBindings,
} = require('../netlify/functions/bjl-query-background');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else      { fail++; console.log('FAIL  ' + name); }
}

// The real incident bindings. community 17.6 and safety 58.0 sit on the same
// question with the same n, which is exactly why the pair is confusable and
// exactly why the digest must keep them apart.
const COMMUNITY = { item_name: 'A sense of community', score: 17.6, n: 482,
  construct: 'pct_selected', source: 'bjl_responses', question_id: 491, cohort: null };
const SAFETY = { item_name: 'A sense of safety', score: 58.0, n: 482,
  construct: 'pct_selected', source: 'bjl_responses', question_id: 491, cohort: null };
const GENZ_MUSIC = { item_name: 'Listening to MUSIC', score: 72.2, n: 129,
  construct: 'joy', source: 'bjl_responses', question_id: null,
  cohort: { generation: 'Gen Z' } };
const HOTEL_JOY = { item_name: 'Hotel stays', score: 62.0, n: 900,
  construct: 'joy', source: 'bjl_scores', question_id: null, cohort: null };

// ---------------------------------------------------------------------
// The binding stays whole
// ---------------------------------------------------------------------
{
  const d = formatSessionFigures([COMMUNITY, SAFETY]);
  const lines = d.split('\n').filter(l => l.startsWith('- '));

  check('every figure gets its own line', lines.length === 2);

  // The whole point: item and number on the same line, inseparable.
  const communityLine = lines.find(l => l.includes('A sense of community')) || '';
  const safetyLine    = lines.find(l => l.includes('A sense of safety')) || '';
  check('the item carries its own number',
    communityLine.includes('17.6') && safetyLine.includes('58'));

  // The incident, stated as an assertion: the safety barrier must not be
  // reachable on the community line.
  check('58 is NOT on the community line', !communityLine.includes('58'));
  check('17.6 is NOT on the safety line', !safetyLine.includes('17.6'));
}

// ---------------------------------------------------------------------
// The construct travels with the number
// ---------------------------------------------------------------------
{
  // 58.0 as a barrier share and 62.0 as a joy index are both real numbers and
  // neither is an expectation share. A digest printing bare values would hand
  // back precisely the ambiguity the construct column exists to remove.
  const d = formatSessionFigures([SAFETY, HOTEL_JOY]);
  const safetyLine = d.split('\n').find(l => l.includes('A sense of safety')) || '';
  const hotelLine  = d.split('\n').find(l => l.includes('Hotel stays')) || '';
  check('a share names its construct', safetyLine.includes('pct_selected'));
  check('an index names its construct', hotelLine.includes('joy'));
  check('the index is not presented as a share', !hotelLine.includes('pct_selected'));
}

// ---------------------------------------------------------------------
// The cohort travels with the number
// ---------------------------------------------------------------------
{
  const d = formatSessionFigures([GENZ_MUSIC, HOTEL_JOY]);
  const musicLine = d.split('\n').find(l => l.includes('Listening to MUSIC')) || '';
  const hotelLine = d.split('\n').find(l => l.includes('Hotel stays')) || '';

  check('a cohort figure names its cohort',
    musicLine.includes('cohort:') && musicLine.includes('generation=Gen Z'));

  // An unqualified line must SAY it is unqualified. Silence is what let a cut
  // figure read as a general one in the first place; the digest states the
  // scope either way rather than leaving it to be inferred.
  check('an uncut figure is marked whole-sample', hotelLine.includes('[whole sample]'));
  check('an uncut figure claims no cohort', !hotelLine.includes('cohort:'));
}

// ---------------------------------------------------------------------
// n and provenance survive the trip
// ---------------------------------------------------------------------
{
  const d = formatSessionFigures([COMMUNITY]);
  check('n is carried', d.includes('n=482'));
  check('the source table is carried', d.includes('bjl_responses'));
  check('the question id is carried', d.includes('q491'));
}
{
  // Missing optionals must not produce "n=null" or "qnull" in the model's view.
  const d = formatSessionFigures([
    { item_name: 'Bare', score: 5, construct: 'joy', source: 'bjl_scores' },
  ]);
  check('a missing n prints nothing rather than null', !d.includes('n=null') && !d.includes('n=undefined'));
  check('a missing question_id prints nothing rather than null', !d.includes('qnull') && !d.includes('qundefined'));
  check('the binding still renders', d.includes('"Bare" = 5'));
}

// ---------------------------------------------------------------------
// The header tells the model what it is holding
// ---------------------------------------------------------------------
{
  const d = formatSessionFigures([COMMUNITY]);
  check('the block is labelled', d.includes('[VERIFIED FIGURES FROM EARLIER IN THIS CONVERSATION]'));
  check('the block points at the governing rules', d.includes('RECALLED FIGURES'));
}

// ---------------------------------------------------------------------
// Empty and degenerate input
// ---------------------------------------------------------------------
{
  // No figures must yield NO block at all -- an empty header would assert
  // that the conversation established nothing, which is a claim, and one the
  // caller would then paste into the prompt for no reason.
  check('no figures yields no block', formatSessionFigures([]) === '');
  check('null yields no block', formatSessionFigures(null) === '');
  check('undefined yields no block', formatSessionFigures(undefined) === '');
  check('a non-array yields no block', formatSessionFigures('nope') === '');
}

// ---------------------------------------------------------------------
// Dedupe is on the binding, not the row
// ---------------------------------------------------------------------
{
  // The same fact republished across four turns is one fact. Showing it four
  // times spends context to make one point and invites repetition to be read
  // as emphasis.
  const rows = [COMMUNITY, COMMUNITY, COMMUNITY];
  check('a republished binding collapses to one', dedupeFigureBindings(rows).length === 1);
}
{
  // 58.0 out of a numeric column comes back as 58. Keyed as a string those are
  // two facts and the same binding prints twice.
  const rows = [SAFETY, Object.assign({}, SAFETY, { score: 58 })];
  check('58.0 and 58 are the same binding', dedupeFigureBindings(rows).length === 1);
}
{
  // Different VALUES on one item are different facts and both must survive --
  // this is how a cohort figure and a pooled figure coexist.
  const pooled = { item_name: 'Listening to MUSIC', score: 71.5, n: 1245,
    construct: 'joy', source: 'bjl_responses', cohort: null };
  const kept = dedupeFigureBindings([GENZ_MUSIC, pooled]);
  check('two values on one item both survive', kept.length === 2);
}
{
  // Same item, same value, DIFFERENT cohort: two facts. Collapsing these
  // would silently drop a cohort qualifier, which is the misattribution.
  const genX = Object.assign({}, GENZ_MUSIC, { cohort: { generation: 'Gen X' } });
  check('same value on two cohorts stays two bindings',
    dedupeFigureBindings([GENZ_MUSIC, genX]).length === 2);
}
{
  // Same item and value, different CONSTRUCT: two facts, for the same reason
  // the construct column is NOT NULL.
  const asShare = Object.assign({}, HOTEL_JOY, { construct: 'pct_selected' });
  check('same value under two constructs stays two bindings',
    dedupeFigureBindings([HOTEL_JOY, asShare]).length === 2);
}
{
  check('first-published order is preserved',
    (dedupeFigureBindings([SAFETY, COMMUNITY, SAFETY])[0] || {}).item_name === 'A sense of safety');
}
{
  // Junk must be dropped, not rendered. A row with no usable score cannot
  // state a binding, and a half-rendered line is worse than no line.
  const junk = [null, 'nope', {}, { item_name: 'x' }, { item_name: 'y', score: 'abc' },
    { score: 1, construct: 'joy' }];
  check('unusable rows are dropped', dedupeFigureBindings(junk).length === 0);
  check('dedupe survives null input', dedupeFigureBindings(null).length === 0);
  check('dedupe survives a non-array', dedupeFigureBindings('nope').length === 0);
}

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail === 0 ? 0 : 1);
