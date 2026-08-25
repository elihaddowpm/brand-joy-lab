#!/usr/bin/env node
/**
 * The figures-ledger writer: what it records, and what it refuses to record.
 *
 * bjl_session_figures exists to answer "is 58% bound to community?" rather
 * than "does 58 appear somewhere?". Those questions only differ if the
 * BINDING is stored intact, so every assertion here is about the binding:
 * the item, the value, and what KIND of value it is, kept together or not
 * kept at all.
 *
 * The failure it was built for (2026-08-21): "58% of hostel guests expect
 * community". 58.0% is real -- it is the SAFETY BARRIER. Community
 * expectation is 17.6%. Two of that incident's three fabrications also
 * changed construct on the way out, a Joy Index of 62.0 reported as a
 * percentage of respondents. So a row that carries item_name and score but
 * not construct would confirm the number and still permit the relabeling.
 * That is why an unbindable figure is DROPPED rather than half-recorded:
 * the ledger's structure vouches for whatever is in it.
 *
 * Non-vacuity: revert the `!construct` clause in buildFigureRows and
 * "drops a stat_item with no construct" fails. Revert the `!source` clause
 * and "drops a stat_item with no source" fails. Revert the Number.isFinite
 * score clause and both "drops a stat_item with no score" and "drops a
 * non-numeric score" fail.
 *
 * Exits non-zero on any failed assertion.
 */

const fs = require('fs');
const path = require('path');

// .env -> process.env, before anything requires the function module: it builds
// a Supabase client at import time. No network call is made by this file --
// buildFigureRows is pure, which is why it is the half that is tested here.
const envPath = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { buildFigureRows } = require(
  path.join(__dirname, '..', 'netlify', 'functions', 'bjl-query-background'));

const SESSION = '6a7ca25c-0000-4000-8000-000000000000';
const JOB     = '494aeeb4-0000-4000-8000-000000000000';

const results = [];
function check(name, cond) { results.push([name, !!cond]); }

const build = cards => buildFigureRows(SESSION, JOB, cards);

// ---------------------------------------------------------------------------
// The real binding the incident got wrong. Shape is the live stat_item
// contract: item_name / score / n / source / construct.
// ---------------------------------------------------------------------------
const HOSTEL_CARD = {
  stat_items: [
    { item_name: 'A sense of community', score: 17.6, n: 482,
      source: 'bjl_responses', construct: 'pct_selected', question_id: 491 },
    { item_name: 'Feeling safe',         score: 58.0, n: 482,
      source: 'bjl_responses', construct: 'pct_selected', question_id: 491 },
  ],
};

{
  const { rows, skipped } = build([HOSTEL_CARD]);
  check('writes both figures from a well-formed card', rows.length === 2);
  check('skips nothing on a well-formed card', skipped === 0);

  const community = rows.find(r => r.item_name === 'A sense of community');
  const safety    = rows.find(r => r.item_name === 'Feeling safe');

  // The binding, intact and unswapped. This is the entire point of the table.
  check('community keeps its own 17.6', community && community.score === 17.6);
  check('58.0 stays bound to safety, not community',
    safety && safety.score === 58.0 && community.score !== 58.0);
  check('construct travels with the score',
    community.construct === 'pct_selected' && safety.construct === 'pct_selected');
  check('n is preserved as the denominator, not the selector count',
    community.n === 482 && safety.n === 482);
  check('question_id is preserved', community.question_id === 491);
  check('scope columns are stamped',
    community.session_id === SESSION && community.job_id === JOB);
  check('cohort is null when the card does not name one', community.cohort === null);
}

// ---------------------------------------------------------------------------
// The relabeling this table is meant to make checkable. A Joy Index of 62.0
// and a percentage of 62.0 are the same numeral and different claims. Both
// are recorded, and they are distinguishable afterwards ONLY by construct.
// ---------------------------------------------------------------------------
{
  const { rows } = build([
    { stat_items: [{ item_name: 'Hotels', score: 62.0, n: 947,
                     source: 'bjl_responses', construct: 'joy_index' }] },
    { stat_items: [{ item_name: 'A clean space', score: 58.5, n: 482,
                     source: 'bjl_responses', construct: 'pct_selected' }] },
  ]);
  check('same numeral under different constructs stays distinguishable',
    rows.length === 2
    && rows.find(r => r.item_name === 'Hotels').construct === 'joy_index'
    && rows.find(r => r.item_name === 'A clean space').construct === 'pct_selected');
}

// ---------------------------------------------------------------------------
// Refusals. Each of these is a figure that could be confirmed by the ledger
// and still be reported as something it is not.
// ---------------------------------------------------------------------------
{
  const { rows, skipped } = build([{ stat_items: [
    { item_name: 'Hotels', score: 62.0, n: 947, source: 'bjl_responses' },
  ]}]);
  check('drops a stat_item with no construct', rows.length === 0 && skipped === 1);
}
{
  const { rows, skipped } = build([{ stat_items: [
    { item_name: 'Hotels', score: 62.0, n: 947, construct: 'joy_index' },
  ]}]);
  check('drops a stat_item with no source', rows.length === 0 && skipped === 1);
}
{
  const { rows, skipped } = build([{ stat_items: [
    { item_name: 'Hotels', n: 947, source: 'bjl_responses', construct: 'joy_index' },
  ]}]);
  check('drops a stat_item with no score', rows.length === 0 && skipped === 1);
}
{
  const { rows, skipped } = build([{ stat_items: [
    { item_name: 'Hotels', score: 'sixty-two', n: 947,
      source: 'bjl_responses', construct: 'joy_index' },
  ]}]);
  check('drops a non-numeric score', rows.length === 0 && skipped === 1);
}
{
  const { rows, skipped } = build([{ stat_items: [
    { item_name: '   ', score: 62.0, n: 947,
      source: 'bjl_responses', construct: 'joy_index' },
  ]}]);
  check('drops a blank item_name', rows.length === 0 && skipped === 1);
}
{
  const { rows, skipped } = build([{ stat_items: [
    { item_name: 'Hotels', score: 62.0, n: 947,
      source: 'bjl_responses', construct: 'joy_index' },
    { item_name: 'Hostels', score: 58.0, n: 482, source: 'bjl_responses' },
  ]}]);
  check('an unbindable sibling does not take the bindable one down with it',
    rows.length === 1 && rows[0].item_name === 'Hotels' && skipped === 1);
}

// ---------------------------------------------------------------------------
// Shape tolerance. `joy_index` is the v1 alias for `score` -- the same
// aliasing the provenance guard already applies when it verifies these.
// ---------------------------------------------------------------------------
{
  const { rows } = build([{ stat_items: [
    { item_name: 'Hotels', joy_index: 62.0, n: 947,
      source: 'bjl_responses', construct: 'joy_index' },
  ]}]);
  check('accepts the legacy joy_index alias for score',
    rows.length === 1 && rows[0].score === 62.0);
}
{
  const { rows } = build([{ stat_items: [
    { item_name: 'A sense of community', score: 19.8,
      source: 'BJL_Responses', construct: 'PCT_Selected' },
  ]}]);
  check('normalizes construct and source case so bindings compare',
    rows[0].construct === 'pct_selected' && rows[0].source === 'bjl_responses');
  check('n is null, not zero, when the card omits it', rows[0].n === null);
}
{
  const { rows } = build([{ stat_items: [
    { item_name: 'A sense of community', score: 22.4, n: 118,
      source: 'bjl_responses', construct: 'pct_selected',
      cohort: { generation: 'Gen Z' } },
  ]}]);
  // Same argument as construct: a figure true of one subpopulation must not
  // be recallable as a general one.
  check('records a cohort when the card names one',
    rows[0].cohort && rows[0].cohort.generation === 'Gen Z');
}

// ---------------------------------------------------------------------------
// Degenerate inputs must not throw. A ledger write is best-effort and sits
// downstream of synthesis; it may never take a completed turn down.
// ---------------------------------------------------------------------------
for (const [label, cards] of [
  ['null cards', null],
  ['empty cards', []],
  ['card with no stat_items', [{}]],
  ['card with a null stat_item', [{ stat_items: [null] }]],
  ['card with a string stat_item', [{ stat_items: ['58%'] }]],
  ['stat_items not an array', [{ stat_items: 'nope' }]],
]) {
  let threw = false;
  let out = null;
  try { out = build(cards); } catch (e) { threw = true; }
  check('survives ' + label, !threw && out && out.rows.length === 0);
}

// ---------------------------------------------------------------------------
const failed = results.filter(([, ok]) => !ok);
for (const [name, ok] of results) console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
