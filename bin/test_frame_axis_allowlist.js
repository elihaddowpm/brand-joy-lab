#!/usr/bin/env node
/**
 * The cohort check, on every demographic axis a read can actually stand on.
 *
 * `AXIS_FIELDS` used to hold three columns -- mode, generation, income_bracket.
 * Any cut on a column outside that list was invisible to the axis latch: the
 * bucket for an item held every cohort's row, and the numbers check accepted
 * ANY row in the bucket. So a read could say "Parent" and cite the Non-parent
 * number, and the guard cleared it, because that number really did come back on
 * a real row. Exactly the failure test_frame_axis_guard.js pins for generation,
 * on ten columns where nothing was watching.
 *
 * Widening the list is only half of it. The claim is matched against the cohort
 * values that came back by containment, and on these columns containment is
 * wrong in a way that fails OPEN:
 *
 *     candidates = bucket.filter(r => vals.every(v => claimAxes.has(v)))
 *
 * `claimAxes` too LARGE widens the candidate set, so a claim that accidentally
 * "names" a second cohort inherits that cohort's rows as legal sources. Three
 * separate real cases below, none hypothetical:
 *
 *     'west'   sits inside 'midwest'         -> boundary rule
 *     'parent' sits inside 'non-parent'      -> longest-match-wins rule
 *     'male'   inside 'female', and 'female'
 *              inside 'transgender female'   -> both rules at once
 *
 * Without those two rules the widening is cosmetic: parental_status would be in
 * the allowlist and the Parent/Non-parent swap would still pass. Each block
 * below therefore pins a TRUE read and the SWAP that must now reject.
 *
 * Fixtures are live rows, pulled 2026-08-18 from bjl_responses joined to
 * bjl_respondents, one real cut per column. Nothing here is shaped to suit the
 * guard -- including the state column's duplicate coding ('CA' and 'California'
 * are separate cohorts carrying different numbers), which is dirty data the
 * latch has to survive rather than something to tidy away.
 *
 * Note on shape: every read below cites TWO rows, because one row is a
 * restatement rather than a connection and the guard rejects it as such. A
 * swap case therefore corrupts one cited row and leaves the other correct, so
 * the only thing under test is the cohort attribution.
 *
 * Exits non-zero on any failed assertion.
 */

const path = require('path');
const { runConnectiveReadGuard, pinnedAxesInSql } = require(
  path.join(__dirname, '..', 'netlify', 'functions', 'bjl-cross-domain-provenance-guard'));

const results = [];
function check(name, cond) { results.push([name, !!cond]); }

// A cut on one column, as the investigator returns it: one row per cohort.
function cut(column, item, rows) {
  return [{
    type: 'query',
    query: `SELECT i.item_name, p.${column}, ROUND(AVG(r.joy_index)::numeric,1) AS ji, COUNT(*) AS n `
         + 'FROM bjl_responses r JOIN bjl_items i ON i.item_id = r.item_id '
         + 'JOIN bjl_respondents p ON p.respondent_id = r.respondent_id GROUP BY 1,2',
    result: rows.map(([ax, ji, n]) => ({ item_name: item, [column]: ax, ji, n })),
  }];
}

// Deliberately free of comparative and difference wording: this suite is
// testing cohort attribution, and a read that states a distance would pull in
// the prose latch and confuse which guard did the rejecting.
function read(evidence, scratch) {
  return runConnectiveReadGuard({
    connective_read: {
      has_read: true,
      read: 'This item splits by cohort.',
      evidence,
    },
    scratch,
  });
}

const reasons = r => r.failures.map(f => f.reason);

// The shapes every column gets pinned with. `column` is the field the read
// names the cohort in, so each fixture exercises the real column, not `axis`.
function pin(label, column, item, rows, trueCohort, swapCohort) {
  const scratch = cut(column, item, rows);
  const own = rows.find(r => r[0] === trueCohort);
  const other = rows.find(r => r[0] === swapCohort);
  const at = (cohort, r) => ({ item_name: item, [column]: cohort, score: r[1], n: r[2] });

  check(`${label}: a true read with both cohorts on their own numbers verifies`,
    read([at(trueCohort, own), at(swapCohort, other)], scratch).ok);

  check(`${label}: SWAP -- ${swapCohort}'s numbers under ${trueCohort} is rejected`,
    !read([at(trueCohort, other), at(swapCohort, other)], scratch).ok);

  check(`${label}: SWAP the other way is rejected too`,
    !read([at(trueCohort, own), at(swapCohort, own)], scratch).ok);

  check(`${label}: the two cohorts fully transposed is rejected`,
    !read([at(trueCohort, other), at(swapCohort, own)], scratch).ok);

  check(`${label}: citing cut rows with no cohort named is rejected`,
    reasons(read([
      { item_name: item, score: own[1], n: own[2] },
      { item_name: item, score: other[1], n: other[2] },
    ], scratch)).includes('connective_read_axis_unspecified'));

  check(`${label}: an invented cohort is rejected by name`,
    reasons(read([
      { item_name: item, [column]: 'Cohort That Does Not Exist', score: own[1], n: own[2] },
      at(swapCohort, other),
    ], scratch)).includes('connective_read_axis_not_in_allowlist'));

  return { scratch, at };
}

// ---------------------------------------------------------------------------
// age_band -- Epcot, 13 cohorts, a 32-point slide across them.
// ---------------------------------------------------------------------------
pin('age_band', 'age_band', 'Epcot, Walt Disney World', [
  ['18 to 24', 61.8, 2094], ['25 to 29', 62.0, 1814], ['30 to 34', 65.4, 2651],
  ['35 to 39', 65.8, 2925], ['40 to 44', 63.3, 2123], ['45 to 49', 60.9, 2000],
  ['50 to 54', 52.8, 2023], ['55 to 59', 51.2, 2449], ['60 to 64', 44.2, 1804],
  ['65 to 69', 38.8, 1565], ['70 to 79', 33.3, 2329], ['80 to 89', 41.2, 432],
  ['90 to 99', 44.0, 20],
], '35 to 39', '70 to 79');

// ---------------------------------------------------------------------------
// gender -- the hardest real case in the schema. Three nested values, all
// live, all carrying different numbers:
//
//     'male'   inside 'female'
//     'female' inside 'transgender female'
//     'male'   inside 'transgender male'
//
// Under plain containment a claim about Transgender Female (41.4, n=26) also
// "names" Female, and Female's row (45.5, n=11441) becomes a legal source for
// it -- a true number under a false label, on the smallest cohort in the cut.
// ---------------------------------------------------------------------------
const GENDER = pin('gender', 'gender', 'Dollywood', [
  ['Female', 45.5, 11441], ['Gender Variant / Non-conforming', 46.2, 74],
  ['Male', 41.7, 9252], ['Prefer not to answer', 58.6, 37],
  ['Transgender Female', 41.4, 26], ['Transgender Male', 40.0, 59],
], 'Transgender Female', 'Female');

const MALE_OK = { item_name: 'Dollywood', gender: 'Male', score: 41.7, n: 9252 };

check('gender: BOUNDARY -- male sits inside female, and does not confer its row',
  !read([{ item_name: 'Dollywood', gender: 'Female', score: 41.7, n: 9252 },
         { item_name: 'Dollywood', gender: 'Transgender Male', score: 40.0, n: 59 }], GENDER.scratch).ok);

check('gender: BOUNDARY -- female does not inherit transgender female either',
  !read([{ item_name: 'Dollywood', gender: 'Female', score: 41.4, n: 26 }, MALE_OK], GENDER.scratch).ok);

check('gender: LONGEST WINS -- transgender male keeps its own 40.0',
  read([{ item_name: 'Dollywood', gender: 'Transgender Male', score: 40.0, n: 59 }, MALE_OK],
    GENDER.scratch).ok);

check('gender: LONGEST WINS -- transgender male cannot cite male\'s 41.7',
  !read([{ item_name: 'Dollywood', gender: 'Transgender Male', score: 41.7, n: 9252 },
         { item_name: 'Dollywood', gender: 'Female', score: 45.5, n: 11441 }], GENDER.scratch).ok);

// ---------------------------------------------------------------------------
// region -- 'west' sits inside 'midwest'. Under plain containment a Midwest
// claim (38.9) could stand on West's 30.2.
// ---------------------------------------------------------------------------
const REGION_ROWS = [
  ['Midwest', 38.9, 70], ['Northeast', 45.6, 64], ['South', 41.7, 84], ['West', 30.2, 45],
];
const REGION = pin('region', 'region', '30A, Florida', REGION_ROWS, 'Midwest', 'West');
const SOUTH_OK = { item_name: '30A, Florida', region: 'South', score: 41.7, n: 84 };

check('region: BOUNDARY -- midwest does not inherit west\'s row',
  !read([{ item_name: '30A, Florida', region: 'Midwest', score: 30.2, n: 45 }, SOUTH_OK],
    REGION.scratch).ok);

check('region: BOUNDARY -- northeast inherits neither south nor west',
  ['South', 'West'].every(other => {
    const r = REGION_ROWS.find(x => x[0] === other);
    return !read([{ item_name: '30A, Florida', region: 'Northeast', score: r[1], n: r[2] },
                  { item_name: '30A, Florida', region: 'Midwest', score: 38.9, n: 70 }],
      REGION.scratch).ok;
  }));

// ---------------------------------------------------------------------------
// parental_status -- 'parent' sits inside 'non-parent', and the gap between
// them on Christmas is 13.3 points. This is the swap that motivated the whole
// widening, and the one that stayed open under plain containment.
// ---------------------------------------------------------------------------
const PARENT = pin('parental_status', 'parental_status', 'Christmas', [
  ['Non-parent', 65.0, 285], ['Parent', 78.3, 329], ['Unknown', 72.3, 641],
], 'Non-parent', 'Parent');

const UNKNOWN_OK = { item_name: 'Christmas', parental_status: 'Unknown', score: 72.3, n: 641 };

check('parental_status: LONGEST WINS -- non-parent cannot stand on the parent row',
  !read([{ item_name: 'Christmas', parental_status: 'Non-parent', score: 78.3, n: 329 }, UNKNOWN_OK],
    PARENT.scratch).ok);

check('parental_status: LONGEST WINS -- and parent cannot stand on non-parent\'s',
  !read([{ item_name: 'Christmas', parental_status: 'Parent', score: 65.0, n: 285 }, UNKNOWN_OK],
    PARENT.scratch).ok);

// ---------------------------------------------------------------------------
// children_under_18 -- cohort labels that are bare numerals.
// ---------------------------------------------------------------------------
pin('children_under_18', 'children_under_18', '365 by Whole Foods Market', [
  ['1', 45.9, 58], ['2', 57.1, 62], ['3 or more', 46.4, 22],
], '1', '2');

// ---------------------------------------------------------------------------
// marital_status
// ---------------------------------------------------------------------------
const JOY_Q = 'Over the last month or so, how would you rate the level of joy you\'ve '
            + 'experienced in your life? (The scale goes from 5 to -3, with 5 indicating maximum joy.)';

pin('marital_status', 'marital_status', JOY_Q, [
  ['Divorced', 44.8, 561], ['Married, or living with a partner', 58.7, 3068],
  ['Prefer not to answer', 34.1, 27], ['Separated', 38.2, 87],
  ['Single, never married', 49.5, 1750], ['Widowed', 42.8, 284],
], 'Single, never married', 'Married, or living with a partner');

// ---------------------------------------------------------------------------
// employment_status
// ---------------------------------------------------------------------------
const EMPLOY = pin('employment_status', 'employment_status', 'A Beach Trip', [
  ['Employed Full-Time', 71.5, 737], ['Employed Part-Time', 63.7, 163],
  ['Other - Write In', 58.8, 65], ['Retired', 55.1, 406],
  ['Self-Employed', 69.6, 113], ['Student', 68.4, 45], ['Unemployed', 69.2, 207],
], 'Unemployed', 'Retired');

const STUDENT_OK = { item_name: 'A Beach Trip', employment_status: 'Student', score: 68.4, n: 45 };

check('employment_status: self-employed and unemployed stay distinct cohorts',
  !read([{ item_name: 'A Beach Trip', employment_status: 'Self-Employed', score: 69.2, n: 207 },
         STUDENT_OK], EMPLOY.scratch).ok);

check('employment_status: full-time cannot borrow part-time\'s row',
  !read([{ item_name: 'A Beach Trip', employment_status: 'Employed Full-Time', score: 63.7, n: 163 },
         STUDENT_OK], EMPLOY.scratch).ok);

// ---------------------------------------------------------------------------
// employment_detail -- the successor column, added as an axis 2026-08-24.
//
// Not a duplicate of employment_status and not in conflict with it. Verified
// against live: of 14,548 respondents, 1,756 carry employment_status (fielded
// 2024-06 to 2024-10), 8,010 carry employment_detail (2024-10 onward), and
// ZERO carry both. Same construct, re-asked with ten levels instead of eight,
// on disjoint populations. So there is no respondent on whom the two columns
// could disagree, and each is a real cut in its own right.
//
// The cohort pair chosen here is the hard one, and it is the reason this block
// is not just a sixth copy of the pin. 'Employed full time' sits INSIDE
// 'Self-employed full time' -- and on a token boundary, because the character
// before it is a hyphen. So a claim naming the self-employed cohort matches
// BOTH values by containment, claimAxes comes back too large, and the
// employed-full-time row joins the candidate set as a legal source. That is
// the parent/non-parent failure again, one column over: it fails OPEN. Only
// longest-match-wins keeps the two apart, so the swap below is the assertion
// that proves the widening is real rather than cosmetic.
// ---------------------------------------------------------------------------
const DETAIL_ROWS = [
  ['Employed full time', 73.2, 402], ['Employed part time', 66.1, 82],
  ['Not employed and not looking for work', 50.0, 14],
  ['Not employed, but looking for work', 65.4, 26],
  ['Not employed, unable to work due to a disability or illness', 61.6, 38],
  ['Retired', 51.7, 144], ['Self-employed full time', 66.3, 32],
  ['Self-employed part time', 50.5, 21],
  ['Stay-at-home spouse or partner', 62.1, 29], ['Student', 77.5, 24],
];

const DETAIL = pin('employment_detail', 'employment_detail', 'A Beach Trip', DETAIL_ROWS,
  'Self-employed full time', 'Employed full time');

const DETAIL_STUDENT_OK = {
  item_name: 'A Beach Trip', employment_detail: 'Student', score: 77.5, n: 24,
};

// The part-time twin of the same containment trap.
check('employment_detail: self-employed part time cannot stand on employed part time',
  !read([{ item_name: 'A Beach Trip', employment_detail: 'Self-employed part time',
           score: 66.1, n: 82 }, DETAIL_STUDENT_OK], DETAIL.scratch).ok);

// The two 'Not employed' levels differ only after the comma. Neither contains
// the other, so this is the boundary rule rather than longest-wins, but a read
// that blurs them is claiming the opposite thing about looking for work.
check('employment_detail: the two not-employed levels are not interchangeable',
  !read([{ item_name: 'A Beach Trip', employment_detail: 'Not employed and not looking for work',
           score: 65.4, n: 26 }, DETAIL_STUDENT_OK], DETAIL.scratch).ok);

// ---------------------------------------------------------------------------
// hispanic_origin -- two-level, and the labels are the bare tokens 'Yes'/'No'.
// ---------------------------------------------------------------------------
pin('hispanic_origin', 'hispanic_origin', 'A day at a THEME PARK or amusement park', [
  ['No', 80.8, 148], ['Yes', 83.4, 35],
], 'Yes', 'No');

// ---------------------------------------------------------------------------
// state -- 29 cohorts on one item. High cardinality is the point: the latch
// matches on the VALUE a row carried and never counts levels.
//
// The column is also genuinely dirty -- 'CA' and 'California' are separate
// cohorts with different numbers (76.6 on n=745 against 80.4 on n=97). That is
// a real coding fault in the data, and the latch's job is not to reconcile
// them but to refuse to let one stand for the other.
// ---------------------------------------------------------------------------
const STATE_ROWS = [
  ['AL', 73.2, 111], ['AR', 65.5, 44], ['AZ', 71.5, 172], ['CA', 76.6, 745],
  ['California', 80.4, 97], ['CO', 75.1, 106], ['CT', 76.4, 106], ['DE', 71.2, 34],
  ['FL', 78.3, 595], ['Florida', 80.4, 55], ['GA', 76.1, 327], ['IL', 74.0, 437],
  ['Illinois', 78.4, 50], ['IN', 74.4, 162], ['Indiana', 81.9, 21], ['MA', 73.4, 187],
  ['Massachusetts', 82.0, 20], ['MI', 73.8, 366], ['Michigan', 79.4, 36],
  ['MO', 69.9, 151], ['Missouri', 70.4, 23], ['NC', 72.2, 289],
  ['North Carolina', 73.3, 30], ['NH', 88.6, 37], ['NY', 74.3, 739],
  ['New York', 74.6, 100], ['OK', 57.0, 93], ['TX', 70.6, 597], ['Texas', 73.1, 58],
];
const STATE = pin('state', 'state', 'Taking a VACATION', STATE_ROWS, 'OK', 'NH');
const AL_OK = { item_name: 'Taking a VACATION', state: 'AL', score: 73.2, n: 111 };
const AZ_OK = { item_name: 'Taking a VACATION', state: 'AZ', score: 71.5, n: 172 };
const anchorFor = ax => (ax === 'AL' ? AZ_OK : AL_OK);

check('state: high cardinality -- every one of the 29 cohorts verifies on its own row',
  STATE_ROWS.every(([ax, ji, n]) =>
    read([{ item_name: 'Taking a VACATION', state: ax, score: ji, n }, anchorFor(ax)],
      STATE.scratch).ok));

check('state: DIRTY DATA -- the CA row cannot stand for the California row',
  !read([{ item_name: 'Taking a VACATION', state: 'California', score: 76.6, n: 745 }, AL_OK],
    STATE.scratch).ok);

check('state: DIRTY DATA -- nor California for CA',
  !read([{ item_name: 'Taking a VACATION', state: 'CA', score: 80.4, n: 97 }, AL_OK],
    STATE.scratch).ok);

check('state: BOUNDARY -- an abbreviation inside a full name is not that cohort',
  [['IN', 'Indiana', 81.9, 21], ['MA', 'Massachusetts', 82.0, 20],
   ['MO', 'Missouri', 70.4, 23], ['MI', 'Michigan', 79.4, 36]]
    .every(([abbr, full, ji, n]) =>
      !read([{ item_name: 'Taking a VACATION', state: abbr, score: ji, n }, AL_OK], STATE.scratch).ok
      && read([{ item_name: 'Taking a VACATION', state: full, score: ji, n }, AL_OK], STATE.scratch).ok));

check('state: a spliced score and n from two states is rejected',
  !read([{ item_name: 'Taking a VACATION', state: 'TX', score: 70.6, n: 739 }, AL_OK],
    STATE.scratch).ok);

// ---------------------------------------------------------------------------
// occupation -- long labels with punctuation, slashes and parentheses.
// ---------------------------------------------------------------------------
const OCC = pin('occupation', 'occupation', JOY_Q, [
  ['Accounting', 56.4, 262], ['Aerospace / Aviation / Automotive', 54.9, 70],
  ['Business / Professional Services', 59.8, 254],
  ['Business Services (Hotels, Lodging Places)', 61.2, 49],
  ['Computers (Hardware, Desktop Software)', 69.5, 465],
  ['Consulting', 45.0, 80], ['Education', 54.9, 653], ['Food Service', 50.0, 419],
  ['Healthcare / Medical', 55.5, 816], ['Non-Profit', 52.0, 105],
  ['Not applicable', 45.9, 1664], ['Other - Write In', 51.3, 877],
  ['Retail', 48.3, 697],
], 'Consulting', 'Computers (Hardware, Desktop Software)');

check('occupation: the two Business cohorts do not stand for one another',
  !read([{ item_name: JOY_Q, occupation: 'Business / Professional Services', score: 61.2, n: 49 },
         { item_name: JOY_Q, occupation: 'Retail', score: 48.3, n: 697 }], OCC.scratch).ok);

// ---------------------------------------------------------------------------
// decisionmaker_* -- eight columns sharing one 5-level scale. Held back at
// first on the expectation that they were select-all booleans like race_*.
// They are not: race_* really is boolean (True/False/None), but each
// decisionmaker_* column is a coherent single-construct categorical, so a row
// cut on one is a cohort row like any other and needs the same check.
//
// 'choosing' and 'decision-making' recur across the labels, which is exactly
// the shape that makes containment matching dangerous -- 'Not involved in
// choosing' and 'Influence or participate in choosing' are different cohorts
// carrying different numbers.
// ---------------------------------------------------------------------------
const DM = pin('decisionmaker_groceries', 'decisionmaker_groceries', 'Arlington, Texas', [
  ['Do not use this product', 21.5, 27],
  ['Influence or participate in choosing', 31.7, 249],
  ['Not involved in choosing', 30.8, 83],
  ['Share equally in decision-making', 30.2, 1588],
  ['Sole or primary decision-maker', 33.7, 4808],
], 'Not involved in choosing', 'Influence or participate in choosing');

const SOLE_OK = { item_name: 'Arlington, Texas',
  decisionmaker_groceries: 'Sole or primary decision-maker', score: 33.7, n: 4808 };

check('decisionmaker: the two \'choosing\' cohorts do not stand for one another',
  !read([{ item_name: 'Arlington, Texas', decisionmaker_groceries: 'Not involved in choosing',
           score: 31.7, n: 249 }, SOLE_OK], DM.scratch).ok);

check('decisionmaker: sole and shared decision-makers stay distinct',
  !read([{ item_name: 'Arlington, Texas',
           decisionmaker_groceries: 'Share equally in decision-making', score: 33.7, n: 4808 },
         { item_name: 'Arlington, Texas', decisionmaker_groceries: 'Not involved in choosing',
           score: 30.8, n: 83 }], DM.scratch).ok);

check('decisionmaker: an item name carrying a comma and a state still grounds',
  read([{ item_name: 'Arlington, Texas', decisionmaker_groceries: 'Do not use this product',
          score: 21.5, n: 27 }, SOLE_OK], DM.scratch).ok);

// ---------------------------------------------------------------------------
// Compound cells still read. A row cut two ways must have both cohorts named,
// and naming one is not enough -- the widening must not weaken that.
// ---------------------------------------------------------------------------
const TWO_WAY = [{
  type: 'query',
  query: 'SELECT i.item_name, p.generation, p.parental_status, '
       + 'ROUND(AVG(r.joy_index)::numeric,1) AS ji, COUNT(*) AS n FROM bjl_responses r '
       + 'JOIN bjl_items i ON i.item_id = r.item_id '
       + 'JOIN bjl_respondents p ON p.respondent_id = r.respondent_id GROUP BY 1,2,3',
  result: [
    { item_name: 'Christmas', generation: 'Millennial', parental_status: 'Parent',     ji: 79.1, n: 141 },
    { item_name: 'Christmas', generation: 'Millennial', parental_status: 'Non-parent', ji: 66.2, n: 58 },
    { item_name: 'Christmas', generation: 'Boomer',     parental_status: 'Non-parent', ji: 63.4, n: 97 },
  ],
}];
const BOOMER_CELL = { item_name: 'Christmas', axis: ['Boomer', 'Non-parent'], score: 63.4, n: 97 };

check('two-way: naming both cohorts of the cell verifies',
  read([{ item_name: 'Christmas', axis: ['Millennial', 'Non-parent'], score: 66.2, n: 58 },
        BOOMER_CELL], TWO_WAY).ok);

check('two-way: naming only the generation is underspecified, not accepted',
  reasons(read([{ item_name: 'Christmas', generation: 'Millennial', score: 66.2, n: 58 },
                BOOMER_CELL], TWO_WAY)).includes('connective_read_axis_underspecified'));

check('two-way: a compound cohort written as one string still reads',
  read([{ item_name: 'Christmas', axis: 'Millennial / Non-parent', score: 66.2, n: 58 },
        BOOMER_CELL], TWO_WAY).ok);

check('two-way: LONGEST WINS inside a compound -- non-parent does not pull in parent',
  !read([{ item_name: 'Christmas', axis: 'Millennial / Non-parent', score: 79.1, n: 141 },
         BOOMER_CELL], TWO_WAY).ok);

// ---------------------------------------------------------------------------
// The pinned cohort -- a WHERE clause instead of a cut.
//
// The third shape in this family and the quietest. A pivot at least puts
// several cohorts on the row; a pinned query puts none:
//
//     ... WHERE p.gender = 'Female' GROUP BY 1
//
// Every row is a woman's number and no returned value says so. Characterized
// against live 2026-08-24: `known` is built from the values the ROWS carried,
// so on this shape it came back EMPTY -- the latch had no vocabulary, a
// declared cohort was DISCARDED rather than checked, and an undeclared claim
// took the un-cut branch and seated on anything. A read saying "Women sit at
// 64.3 and 47.9" over a query pinned to 'Male' returned ok:true with every
// number real, byte-identical to the true read.
//
// The rule now: a pinned cohort counts as a value the rows carried, so a
// subpopulation read must NAME its subpopulation. That kills three reads and
// keeps one:
//
//   - prose says "Women", claim declares nothing  -> reject (the natural swap)
//   - claim declares Female over Male-pinned rows -> reject (the declared swap)
//   - claim declares nothing at all               -> reject (a partial number
//                                                    presented as a whole one)
//   - claim declares Female over Female-pinned    -> PASSES
//
// It only ever narrows: before, an undeclared claim seated on any pinned row.
// No claim gains a seat it did not already have, so a false positive costs a
// rewrite and can never buy a fabrication a way through.
//
// Live rows, 2026-08-24.
// ---------------------------------------------------------------------------
const ANT = 'ANTICIPATING your vacation';
const FLY = 'FLYING (on a commercial airline) to a vacation destination';

const pinnedScratch = (g, rows) => [{
  type: 'query',
  query: 'SELECT i.item_name, ROUND(AVG(r.joy_index)::numeric,1) AS ji, COUNT(*) AS n '
       + 'FROM bjl_responses r JOIN bjl_items i ON i.item_id = r.item_id '
       + 'JOIN bjl_respondents p ON p.respondent_id = r.respondent_id '
       + `WHERE p.gender = '${g}' GROUP BY 1`,
  result: rows,
}];

const PINNED_F = pinnedScratch('Female', [
  { item_name: ANT, ji: 70.1, n: 993 },
  { item_name: FLY, ji: 39.0, n: 2572 },
]);
const PINNED_M = pinnedScratch('Male', [
  { item_name: ANT, ji: 64.3, n: 732 },
  { item_name: FLY, ji: 47.9, n: 2122 },
]);

// The female numbers, undeclared -- the shape the true read used to take.
const F_UNDECLARED = [{ item_name: ANT, score: 70.1, n: 993 },
                      { item_name: FLY, score: 39.0, n: 2572 }];
// The male numbers, undeclared. Against PINNED_M these are all true; the lie
// lives entirely in the prose, which is why nothing structural caught it.
const M_UNDECLARED = [{ item_name: ANT, score: 64.3, n: 732 },
                      { item_name: FLY, score: 47.9, n: 2122 }];
const declared = ev => ev.map(r => Object.assign({ gender: 'Female' }, r));

check('pinned: the declared true read seats on the cohort its query pinned',
  read(declared(F_UNDECLARED), PINNED_F).ok);

check('pinned: THE SWAP -- prose says Women, every number is a man\'s',
  reasons(read(M_UNDECLARED, PINNED_M))
    .includes('connective_read_cohort_pinned_in_filter'));

check('pinned: the declared swap -- Female claimed on Male-pinned rows',
  reasons(read(declared(M_UNDECLARED), PINNED_M))
    .includes('connective_read_cohort_pinned_in_filter'));

check('pinned: an undeclared read of pinned rows is a partial number sold as a whole one',
  reasons(read(F_UNDECLARED, PINNED_F))
    .includes('connective_read_cohort_pinned_in_filter'));

// Read through an empty failure list rather than off the end of it: under a
// revert this assertion must report a legible FAIL, not throw and take the
// count with it.
const detailOf = v => (v.failures || []).map(f => f.detail || '').join(' ');
check('pinned: the rejection names the pin and offers the cut',
  /group by gender/i.test(detailOf(read(F_UNDECLARED, PINNED_F)))
  && /gender = female/i.test(detailOf(read(F_UNDECLARED, PINNED_F))));

check('pinned: an invented cohort on pinned rows is still rejected',
  !read(F_UNDECLARED.map(r => Object.assign({ gender: 'Gen Alpha' }, r)), PINNED_F).ok);

// Detector precision. Each of these is a shape that must NOT read as a pin,
// because calling it one would reject an honest read.
check('pinned detector: one equality literal is a pin',
  pinnedAxesInSql(PINNED_F[0].query).gender === 'female');

check('pinned detector: a single-member IN-list is the same pin written longer',
  pinnedAxesInSql("SELECT 1 FROM t JOIN bjl_respondents p ON 1=1 "
    + "WHERE p.gender IN ('Female') GROUP BY 1").gender === 'female');

check('pinned detector: a multi-member IN-list is a scoping filter, not a pin',
  pinnedAxesInSql("SELECT 1 FROM t JOIN bjl_respondents p ON 1=1 "
    + "WHERE p.gender IN ('Male','Female') GROUP BY 1").gender === undefined);

check('pinned detector: an axis in the GROUP BY is on the row already, not pinned',
  pinnedAxesInSql("SELECT i.item_name, p.gender FROM t "
    + "WHERE p.gender = 'Female' GROUP BY 1, p.gender").gender === undefined);

check('pinned detector: two equality literals is the pivot rule, not a pin',
  pinnedAxesInSql("SELECT 1 FROM t WHERE p.gender = 'Female' OR p.gender = 'Male' "
    + 'GROUP BY 1').gender === undefined);

check('pinned: a genuinely un-cut query still needs no cohort',
  read([{ item_name: ANT, score: 70.1, n: 993 }, { item_name: FLY, score: 39.0, n: 2572 }],
    [{ type: 'query',
       query: 'SELECT i.item_name, ROUND(AVG(r.joy_index)::numeric,1) AS ji, COUNT(*) AS n '
            + 'FROM bjl_responses r JOIN bjl_items i ON i.item_id = r.item_id GROUP BY 1',
       result: [{ item_name: ANT, ji: 70.1, n: 993 }, { item_name: FLY, ji: 39.0, n: 2572 }] }]).ok);

// ---------------------------------------------------------------------------
// Not a regression: the uncut case is untouched.
// ---------------------------------------------------------------------------
const POPULATION = [{
  type: 'query',
  query: 'SELECT i.item_name, ROUND(AVG(r.joy_index)::numeric,1) AS ji, COUNT(*) AS n '
       + 'FROM bjl_responses r JOIN bjl_items i ON i.item_id = r.item_id GROUP BY 1',
  result: [
    { item_name: 'Christmas', ji: 72.0, n: 1255 },
    { item_name: 'Taking a VACATION', ji: 73.9, n: 9892 },
  ],
}];

check('no regression: whole-population evidence still needs no cohort',
  read([{ item_name: 'Christmas', score: 72.0, n: 1255 },
        { item_name: 'Taking a VACATION', score: 73.9, n: 9892 }], POPULATION).ok);

check('no regression: a fabricated whole-population number is still rejected',
  !read([{ item_name: 'Christmas', score: 88.8, n: 1255 },
         { item_name: 'Taking a VACATION', score: 73.9, n: 9892 }], POPULATION).ok);

check('no regression: an honest no-corner result is unaffected',
  runConnectiveReadGuard({
    connective_read: { has_read: false, read: null, evidence: [], why_not: 'nothing crossed' },
    scratch: PARENT.scratch,
  }).ok);

// ---------------------------------------------------------------------------

let failed = 0;
for (const [name, ok] of results) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} assertions passed`);
process.exit(failed ? 1 : 0);
