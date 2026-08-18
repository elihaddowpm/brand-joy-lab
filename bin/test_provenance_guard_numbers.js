#!/usr/bin/env node
/**
 * Number provenance on the two free-form-SQL surfaces: cards and
 * connective_read.
 *
 * Both read rows produced by investigator SQL that the investigator writes
 * itself. It aliases the joy index however the query reads best -- `ji`,
 * `avg_ji`, `mean_score` -- so a guard that looks for a column literally named
 * `score` / `joy_index` / `audience_score` cannot see the number on most rows.
 *
 * That was the shipped behaviour, and it failed in OPPOSITE directions on the
 * two surfaces, which is why it went unnoticed for so long:
 *
 *   - connective_read read the missing score as a mismatch and rejected reads
 *     whose numbers had been copied correctly off the row.
 *   - cards read the missing score as agreement and stopped checking scores
 *     altogether, accepting fabricated and spliced figures.
 *
 * A guard that is simultaneously too strict and too loose, depending on which
 * caller you ask, is worse than either. This file pins the fixed behaviour so
 * the next edit has to keep both halves:
 *
 *   VERIFY   a number copied verbatim off an aliased column
 *   REJECT   a fabricated number on that same aliased column
 *   REJECT   a score and an n spliced from two different rows
 *   REJECT   one field standing in for both the score and the n
 *
 * The last two are the anti-splice latch, and they are the reason this is a
 * loosening of the column assumption and not a loosening of the guarantee.
 * The guarantee is that a score and an n came from ONE returned row. Which
 * column carried them was never part of the guarantee; it was an assumption
 * about SQL that the SQL never agreed to.
 *
 * Exits non-zero on any failed assertion.
 */

const path = require('path');
const {
  runProvenanceGuard,
  runConnectiveReadGuard,
} = require(path.join(__dirname, '..', 'netlify', 'functions', 'bjl-cross-domain-provenance-guard'));

const results = [];
function check(name, cond) { results.push([name, !!cond]); }

// ---------------------------------------------------------------------------
// Fixtures. `ji` is the alias the live investigator actually emitted on job
// 48f6e172; the rows are that job's real query-7 output.
// ---------------------------------------------------------------------------
const ALIASED = [{
  type: 'query',
  query: 'SELECT i.item_name, r.generation, ROUND(AVG(r.joy_index)::numeric,1) AS ji, COUNT(*) AS n '
       + 'FROM bjl_responses r JOIN bjl_items i ON i.item_id = r.item_id GROUP BY 1,2',
  result: [
    { generation: 'Boomer',     item_name: 'Listening to LIVE MUSIC', ji: 59.2, n: 96 },
    { generation: 'Gen X',      item_name: 'Listening to LIVE MUSIC', ji: 72.9, n: 93 },
    { generation: 'Gen Z',      item_name: 'Listening to LIVE MUSIC', ji: 66.6, n: 64 },
    { generation: 'Millennial', item_name: 'Listening to LIVE MUSIC', ji: 70.5, n: 116 },
    { generation: 'Gen X',      item_name: 'Bringing/cooking your favorite dish', ji: 51.8, n: 66 },
  ],
}];

const CANONICAL = [{
  type: 'query',
  query: 'SELECT item_name, score, n FROM bjl_corpus_search($1)',
  result: [
    { item_name: 'A home cooked meal', score: 70.14, n: 202 },
    { item_name: 'Going out to eat',   score: 66.0,  n: 1292 },
  ],
}];

function read(evidence, scratch) {
  return runConnectiveReadGuard({
    connective_read: { has_read: true, read: 'r', evidence },
    scratch,
  });
}

function cardStats(stat, scratch) {
  const r = runProvenanceGuard({
    cards: [{ headline: 'h', stat_items: [stat] }],
    scratch,
  });
  return r.failures.filter(f => f.surface === 'cards');
}

// ---------------------------------------------------------------------------
// connective_read
// ---------------------------------------------------------------------------
const LM = 'Listening to LIVE MUSIC';
const DISH = 'Bringing/cooking your favorite dish';

// These fixture rows are a generation cut, so a claim on them must say which
// generation. This assertion used to pass without naming one, and that is
// exactly the hole test_frame_axis_guard.js now covers: unnamed, 72.9/93 and
// 59.2/96 were interchangeable to the guard, so Boomers' number could be sold
// as Gen Z's. The cohort is not decoration on the claim; it is the claim.
check('read: aliased column verifies when copied verbatim',
  read([{ item_name: LM, axis: 'Gen X', score: 72.9, n: 93 },
        { item_name: DISH, axis: 'Gen X', score: 51.8, n: 66 }], ALIASED).ok);

check('read: a cut row cited without its cohort is rejected',
  !read([{ item_name: LM, score: 72.9, n: 93 },
         { item_name: DISH, score: 51.8, n: 66 }], ALIASED).ok);

check('read: fabricated score on an aliased row is rejected',
  !read([{ item_name: LM, score: 88.4, n: 93 }, { item_name: DISH, score: 51.8, n: 66 }], ALIASED).ok);

check('read: score and n spliced across rows of the same item is rejected',
  !read([{ item_name: LM, score: 72.9, n: 96 }, { item_name: DISH, score: 51.8, n: 66 }], ALIASED).ok);

check('read: one field cannot supply both the score and the n',
  !read([{ item_name: LM, score: 93, n: 93 }, { item_name: DISH, score: 51.8, n: 66 }], ALIASED).ok);

check('read: canonical score column still verifies, rounded to 1dp',
  read([{ item_name: 'A home cooked meal', score: 70.1, n: 202 },
        { item_name: 'Going out to eat', score: 66.0, n: 1292 }], CANONICAL).ok);

check('read: cross-row splice on canonical columns still rejected',
  !read([{ item_name: 'A home cooked meal', score: 70.1, n: 1292 },
         { item_name: 'Going out to eat', score: 66.0, n: 1292 }], CANONICAL).ok);

check('read: numeric-as-string columns verify (Postgres numerics over JSON)',
  read([{ item_name: LM, score: 72.9, n: 93 }, { item_name: DISH, score: 51.8, n: 66 }], [{
    type: 'query',
    query: 'SELECT item_name, avg_ji, n FROM bjl_responses',
    result: [{ item_name: LM, avg_ji: '72.9', n: '93' }, { item_name: DISH, avg_ji: '51.8', n: '66' }],
  }]).ok);

// A date or a label must not become match surface just because it contains
// digits, and a boolean must not pass for 1.
check('read: non-numeric columns are not match surface',
  !read([{ item_name: LM, score: 2024, n: 93 }, { item_name: DISH, score: 51.8, n: 66 }], [{
    type: 'query',
    query: 'SELECT item_name, ji, n, wave FROM bjl_responses',
    result: [{ item_name: LM, ji: 72.9, n: 93, wave: '2024-01-01' },
             { item_name: DISH, ji: 51.8, n: 66, wave: '2024-01-01' }],
  }]).ok);

// ---------------------------------------------------------------------------
// cards -- the surface where the same defect ran the other way
// ---------------------------------------------------------------------------
check('cards: aliased column verifies when copied verbatim',
  cardStats({ item_name: LM, score: 72.9, n: 93, source: 'bjl_responses' }, ALIASED).length === 0);

check('cards: fabricated score on an aliased row is rejected',
  cardStats({ item_name: LM, score: 88.4, n: 93, source: 'bjl_responses' }, ALIASED)
    .some(f => f.reason === 'card_score_mismatch'));

check('cards: score spliced from another row of the same item is rejected',
  cardStats({ item_name: LM, score: 59.2, n: 93, source: 'bjl_responses' }, ALIASED)
    .some(f => f.reason === 'card_score_mismatch'));

check('cards: canonical score column still verifies',
  cardStats({ item_name: 'A home cooked meal', score: 70.1, n: 202, source: 'bjl_corpus_search' }, CANONICAL)
    .length === 0);

check('cards: wrong source still rejected',
  cardStats({ item_name: LM, score: 72.9, n: 93, source: 'bjl_scores' }, ALIASED)
    .some(f => f.reason === 'card_source_mismatch'));

// ---------------------------------------------------------------------------
// Cut queries. These group by a cut and never select item_name, so the rows
// identify no item -- but the query pinned one in its own WHERE clause. These
// are the real rows behind job 7e3ad9fc's theme-park income card, which was
// a correct citation the allowlist could not see.
// ---------------------------------------------------------------------------
const CUT = [{
  type: 'query',
  query: "SELECT p.income_bracket, COUNT(*) AS n, ROUND(AVG(r.joy_index)::numeric,1) AS ji "
       + "FROM bjl_responses r JOIN bjl_respondents p ON p.respondent_id = r.respondent_id "
       + "JOIN bjl_items i ON i.item_id = r.item_id "
       + "WHERE i.item_name = 'Visiting a THEME PARK or amusement park' GROUP BY 1",
  result: [
    { income_bracket: '$150,000 to $199,999', n: 323,  ji: 63.7 },
    { income_bracket: 'Less than $25,000',    n: 1096, ji: 51.9 },
  ],
}];
const PARK = 'Visiting a THEME PARK or amusement park';

check('cut query: rows inherit the item the WHERE clause pinned',
  cardStats({ item_name: PARK, score: 63.7, n: 323, source: 'bjl_responses' }, CUT).length === 0);

check('cut query: a fabricated number on an inherited row is still rejected',
  cardStats({ item_name: PARK, score: 77.7, n: 323, source: 'bjl_responses' }, CUT)
    .some(f => f.reason === 'card_score_mismatch'));

check('cut query: splicing across two cuts is still rejected',
  cardStats({ item_name: PARK, score: 63.7, n: 1096, source: 'bjl_responses' }, CUT)
    .some(f => f.reason === 'card_score_mismatch' || f.reason === 'card_no_single_row_match'));

// Ambiguous pins must NOT be inherited: several items named, rows identifying
// none, so no row can be said to belong to any one of them.
check('cut query: a multi-item WHERE clause confers no provenance',
  cardStats({ item_name: PARK, score: 63.7, n: 323, source: 'bjl_responses' }, [{
    type: 'query',
    query: "SELECT p.income_bracket, COUNT(*) AS n, ROUND(AVG(r.joy_index)::numeric,1) AS ji "
         + "FROM bjl_responses r WHERE i.item_name IN ('Visiting a THEME PARK or amusement park', "
         + "'Listening to LIVE MUSIC') GROUP BY 1",
    result: [{ income_bracket: '$150,000 to $199,999', n: 323, ji: 63.7 }],
  }]).some(f => f.reason === 'no_scratch_rows_for_cards' || f.reason === 'card_item_not_in_allowlist'));

// The investigator pins by id at least as often as by name. Live job
// c635c8d9 cut coffee by generation with `WHERE i.item_id IN (4753, 4765)`;
// every row was dropped, and a true read drawn from them failed as
// ungrounded. A single id resolves through the corpus rows the investigation
// already returned.
const ID_LOOKUP = {
  type: 'query',
  query: 'SELECT i.item_id, i.item_name FROM bjl_items i',
  result: [{ item_id: 4753, item_name: PARK }, { item_id: 4765, item_name: 'Listening to LIVE MUSIC' }],
};
const ID_CUT = [ID_LOOKUP, {
  type: 'query',
  query: 'SELECT p.income_bracket, COUNT(*) AS n, ROUND(AVG(r.joy_index)::numeric,1) AS ji '
       + 'FROM bjl_responses r JOIN bjl_items i ON i.item_id = r.item_id '
       + 'WHERE i.item_id = 4753 GROUP BY 1',
  result: [{ income_bracket: '$150,000 to $199,999', n: 323, ji: 63.7 }],
}];

check('id pin: a single item_id resolves to its name and grounds the cut',
  cardStats({ item_name: PARK, score: 63.7, n: 323, source: 'bjl_responses' }, ID_CUT).length === 0);

check('id pin: a fabricated number on an id-resolved row is still rejected',
  cardStats({ item_name: PARK, score: 77.7, n: 323, source: 'bjl_responses' }, ID_CUT)
    .some(f => f.reason === 'card_score_mismatch'));

// Two ids do not return one row per item -- they return rows aggregated
// across both, belonging to neither. This is the live c635c8d9
// misattribution, now caught by design rather than by absence.
// The name is in the allowlist from the corpus lookup, so the rejection lands
// on the number: the blended figure belongs to no single item and no row of
// that item ever carried it.
check('id pin: a two-id WHERE clause confers no number',
  cardStats({ item_name: PARK, score: 63.7, n: 323, source: 'bjl_responses' }, [ID_LOOKUP, {
    type: 'query',
    query: 'SELECT p.income_bracket, COUNT(*) AS n, ROUND(AVG(r.joy_index)::numeric,1) AS ji '
         + 'FROM bjl_responses r JOIN bjl_items i ON i.item_id = r.item_id '
         + 'WHERE i.item_id IN (4753, 4765) GROUP BY 1',
    result: [{ income_bracket: '$150,000 to $199,999', n: 323, ji: 63.7 }],
  }]).some(f => f.reason === 'card_score_mismatch'
             || f.reason === 'card_item_not_in_allowlist'
             || f.reason === 'no_scratch_rows_for_cards'));

// The live case, with the live numbers, because the abstract version above
// understates what the blend costs.
//
// bjl_items holds TWO rows named 'Drinking COFFEE': 4753 and 4765. They are
// different stimuli that happen to share a label, and they do not agree --
// 51.7 on n=1939 against 47.5 on n=3964. Pinning both and averaging gives
// 48.9 on n=5903, which is a real computation over real responses and is
// nobody's score. It is also entirely plausible: it sits between the two,
// carries a huge base, and nothing about it looks wrong.
//
// This is why a multi-id pin confers no name. A guard that resolved the pair
// to 'Drinking COFFEE' would clear 48.9 as that item's score, and the read
// would be sourced, checked, and false.
const COFFEE = 'Drinking COFFEE';
const COFFEE_LOOKUP = {
  type: 'query',
  query: "SELECT i.item_id, i.item_name FROM bjl_items i WHERE i.item_name = 'Drinking COFFEE'",
  result: [{ item_id: 4753, item_name: COFFEE }, { item_id: 4765, item_name: COFFEE }],
};
const blendQuery = ids => ({
  type: 'query',
  query: 'SELECT COUNT(*) AS n, ROUND(AVG(r.joy_index)::numeric,1) AS ji '
       + 'FROM bjl_responses r WHERE r.item_id IN (' + ids + ')',
  result: ids === '4753, 4765'
    ? [{ n: 5903, ji: 48.9 }]
    : [{ n: 1939, ji: 51.7 }],
});

check('two ids, one name: the blended score is attributed to neither item',
  cardStats({ item_name: COFFEE, score: 48.9, n: 5903, source: 'bjl_responses' },
    [COFFEE_LOOKUP, blendQuery('4753, 4765')]).length > 0);

check('two ids, one name: pinning just one still grounds that one',
  cardStats({ item_name: COFFEE, score: 51.7, n: 1939, source: 'bjl_responses' },
    [COFFEE_LOOKUP, blendQuery('4753')]).length === 0);

check('two ids, one name: the other item\'s score is not grounded by the single pin',
  cardStats({ item_name: COFFEE, score: 47.5, n: 3964, source: 'bjl_responses' },
    [COFFEE_LOOKUP, blendQuery('4753')]).length > 0);

// ---------------------------------------------------------------------------
const failed = results.filter(r => !r[1]);
for (const [name, ok] of results) console.log((ok ? '  PASS  ' : '  FAIL  ') + name);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' assertions passed');
if (failed.length) process.exit(1);
