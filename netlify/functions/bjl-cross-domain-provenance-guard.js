/**
 * Provenance guard for structured synthesizer output.
 *
 * Post-generation check that binds the synthesizer's structured claims to the
 * rows the investigator actually returned in the same turn. Prompt guidance
 * asks; this guard decides. If a claim can't be grounded in a returned row,
 * the offending structured field gets dropped rather than shipped.
 *
 * Called from bjl-query-background.js after runSynthesis and before persisting
 * the answer. Pure function: no I/O, no side effects, easy to test.
 *
 * Eight surfaces are guarded on the same code path:
 *
 * A) signature. Allowlist: rows from bjl_signature.
 *    Check: every {tag, framework} appears in a returned row.
 * B) cross_domain_items. Allowlist: rows from bjl_corpus_bridges (item lens),
 *    plus the legacy bjl_corpus_threads / bjl_corpus_pivot names. Checks:
 *      1. Item provenance: item_name matches a returned row.
 *      2. Number provenance: joy_index (1 decimal), n (exact).
 *      3. Tag provenance: tag is one of the returned tags.
 *      4. Home-topic exclusion: primary_topic is not a home topic.
 * C) audience_affinity. Allowlist: rows from bjl_audience_affinity. Checks:
 *      1. Item provenance: item_name matches a returned row.
 *      2. Metric provenance: rel_lift (1 decimal), audience_ji (1 decimal),
 *         aud_n (exact) all match.
 * D) audience_profile. Allowlist: rows from bjl_audience_profile. Checks:
 *      1. Row provenance: {dimension, cut_value} matches a returned row.
 *      2. Index provenance: index (integer) matches.
 * E) audience_selects. Allowlist: rows from bjl_audience_selects_v2, keyed
 *    on the (question, item_name) pair because option text recurs across
 *    batteries and only the question label disambiguates. Checks:
 *      1. Question is present on the claim (mandatory).
 *      2. (question, item_name) pair matches a returned row.
 *      3. aud_pct (1 decimal), gen_pct (1 decimal), aud_exposed (exact).
 *    Neither lift nor norm_lift is verified; both are selection scores
 *    the prompt-side rule keeps out of prose.
 * F) audience_distributions. Allowlist: rows from bjl_audience_distributions_v2,
 *    keyed on the (item_name, set_name, answer) triple because one item can
 *    carry two scales from different waves and shares are only comparable
 *    within a set. Checks:
 *      1. set_name and answer are present on the claim (mandatory).
 *      2. (item_name, set_name, answer) triple matches a returned row.
 *      3. aud_pct (1 decimal), gen_pct (1 decimal), gap_pts (1 decimal),
 *         aud_n (exact).
 * G) cross_domain_threads (legacy nested shape). Kept for back-compat with
 *    already-deployed surfaces. Same checks as (B) but on the older
 *    {thread_tag, members[]} shape.
 * H) cards. Allowlist: any row from any SELECT in scratch, tagged with the
 *    source table inferred from the query's FROM clause. Checks:
 *      1. Item provenance: stat_item.item_name matches a returned row.
 *      2. Number provenance: joy_index (1 decimal), n (exact).
 *      3. Source provenance: stat_item.source equals row's source.
 *      4. Single-source rule: every stat_item in a card shares a source.
 * I) connective_read. The frame pass's cross-cutting claim. Allowlist: the
 *    same broad card allowlist (any row from any SELECT), deliberately NOT
 *    the single-source one — a read that does not span sources is not a
 *    cross-cutting read. Checks:
 *      1. Two-row minimum: a connection needs two things to connect, so a
 *         one-row read is a restatement and is rejected as such.
 *      2. Item provenance: every evidence item_name matches a returned row.
 *      3. Number provenance: score (1 decimal), n (exact).
 *      4. Negative-claim hygiene: has_read false must carry no read text and
 *         no evidence, so "there is no corner" cannot smuggle a claim.
 *      5. Comparative provenance: any comparative or superlative wording in
 *         the read must be backed by a `comparisons` entry that carries the
 *         WHOLE set it ranks over, and the guard recomputes the ordering
 *         itself. See checkComparison.
 *    This surface exists because a fabricated cross-cutting insight is the
 *    single most dangerous output the tool can produce: it is exactly what
 *    the reader wants to hear, so it is the least likely to be questioned.
 *
 * Number matching on (H) and (I) is same-row, any-column. Both surfaces read
 * rows produced by free-form investigator SQL, which aliases the joy index
 * however the query reads best -- `ji`, `avg_ji`, `mean_score`. Matching on
 * named columns meant those rows parsed to a null score, which (I) treated as
 * a mismatch and rejected correct claims on, and (H) treated as agreement and
 * so stopped checking scores on entirely. Same-row is the property that
 * matters and is kept: a score and an n must come from ONE returned row, in
 * different fields, so neither can be spliced in from another row. The cost
 * is that a wide row offers more surface for a coincidental match. That cost
 * is accepted; the column-name assumption free-form SQL cannot honor is not.
 *
 * Returns { ok, failures } where failures is [] on success and an array of
 * { surface, claim, reason } objects on failure. The caller decides
 * retry/drop policy.
 */

// Curly / smart punctuation to straight, plus casing + trim. Same
// normalization used by run_topic_rescan.py so item names that round-trip
// through the LLM (which may canonicalize apostrophes and em-dashes) still
// match the corpus row.
// Which known cohort values does a claim actually name?
//
// Plain substring containment is not safe on these columns, and the failure is
// silent: it makes the latch pass things it should catch.
//
//   1. The value has to sit on a boundary. 'male' appears inside 'female' and
//      'ca' inside 'chicago'; neither is a mention of that cohort. Without
//      this, a claim about women is read as naming men as well, and the men's
//      row becomes an acceptable source for it.
//   2. Where one matched value contains another, only the longer survives.
//      'parent' sits inside 'non-parent', so a read saying Non-parent would
//      otherwise be treated as naming BOTH cohorts -- and the Parent row would
//      back a Non-parent claim. That is the cohort swap the axis latch exists
//      to catch, so the widening would have been cosmetic without this.
//
// Compound cells still work: 'millennial / $200,000 or more' names two values,
// neither inside the other, and both survive.
function matchAxisValues(known, claimText) {
  const hit = [];
  for (const k of known) {
    if (!k) continue;
    for (let from = 0; ; ) {
      const at = claimText.indexOf(k, from);
      if (at < 0) break;
      const before = at === 0 ? '' : claimText[at - 1];
      const after = claimText[at + k.length] || '';
      if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) { hit.push(k); break; }
      from = at + 1;
    }
  }
  return hit.filter(a => !hit.some(b => b !== a && b.includes(a)));
}

function normalizeItemName(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/[\u2018\u2019]/g, "'")   // ' '  ->  '
    .replace(/[\u201C\u201D]/g, '"')   // " "  ->  "
    .replace(/[\u2013\u2014]/g, '-')   // – —  ->  -
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The cross-cutting columns a cut query groups by.
 *
 * These are the columns an around-corners finding actually lives on. A read
 * about "Gen Z on live music" is a claim about ONE row of a cut, and the
 * cohort is not decoration on that claim -- it IS the claim. Recording which
 * cohort each returned row belongs to is what lets the guard check it.
 */
const AXIS_FIELDS = [
  'mode', 'generation', 'income_bracket',
  'age_band', 'gender', 'region', 'parental_status', 'children_under_18',
  'marital_status', 'hispanic_origin',
  // Two columns, one construct, two fielding eras -- and NOT a duplicate pair
  // on any respondent. Verified 2026-08-24: of 14,548 respondents, 1,756 carry
  // employment_status (5 fieldings, 2024-06 to 2024-10), 8,010 carry
  // employment_detail (19 fieldings, 2024-10 onward), and ZERO carry both. The
  // newer column asks the same question with ten levels instead of eight and
  // backs 521k joy responses against the older one's small tail, so both are
  // real cohort columns and neither can contradict the other on a person.
  //
  // They do share value spellings -- 'Retired' and 'Student' are identical
  // strings in both -- which is harmless here, because the latch matches a
  // claim against the value its own row carried and both spellings mean what
  // they say. What it does NOT make safe is comparing a cohort drawn from one
  // column against a cohort drawn from the other: those are disjoint
  // populations from different waves. Nothing in this guard checks that, and
  // it is logged rather than fixed here.
  'employment_status', 'employment_detail',
  // High cardinality is not a problem here: the latch matches a claim against
  // the VALUE its row carried, and never counts levels or assumes an axis is
  // small. state has 124 levels and occupation 38; each behaves exactly as
  // generation's five do.
  'state', 'occupation',
  // Eight columns sharing one 5-level scale (Sole or primary decision-maker /
  // Share equally in decision-making / Influence or participate in choosing /
  // Not involved in choosing / Do not use this product). Held back initially
  // on the expectation that they were select-all booleans like race_*; they
  // are not. Each is a coherent single-construct categorical, so a row cut on
  // one is a cohort row and the claim on it needs checking like any other.
  'decisionmaker_bank', 'decisionmaker_car', 'decisionmaker_car_insurance',
  'decisionmaker_groceries', 'decisionmaker_home_furnishing',
  'decisionmaker_internet', 'decisionmaker_vacation',
  'decisionmaker_vacation_activities',
];

/**
 * The cohort axes a query wrote into COLUMN NAMES instead of column values.
 *
 * This is the shape that put the axis latch to sleep. Written as a cut --
 *
 *   SELECT i.item_name, AVG(r.joy_index) AS ji FROM ... GROUP BY 1, p.gender
 *
 * -- every row carries `gender` as a VALUE, and rowAxisValues records it, and
 * a claim naming the wrong cohort has nowhere to sit. Written as a pivot --
 *
 *   SELECT i.item_name,
 *          AVG(r.joy_index) FILTER (WHERE p.gender = 'Female') AS ji_female,
 *          AVG(r.joy_index) FILTER (WHERE p.gender = 'Male')   AS ji_male
 *   FROM ... GROUP BY 1
 *
 * -- the cohort lives in the alias. rowAxisValues finds no axis column, the
 * row reads as un-cut, and the latch does not fail: it never runs. So zero
 * axis failures on a pivot run is not evidence that the attributions were
 * checked. It means nothing checked them, and a read citing 71.3 as men's
 * number when 71.3 is `ji_female` would have cleared. A cohort swap does not
 * reject on this shape, which is the definition of an unguarded surface.
 *
 * The fix is to forbid the representation rather than chase it. Teaching the
 * latch to parse cohorts out of FILTER predicates would add a parsing surface
 * that has to be right to keep the guard honest, and anything that has to be
 * right is a thing that can be fooled. Refusing rows whose cohort cannot be
 * matched needs no such parser: a cut written as a cut is checkable, so the
 * answer is to write it as a cut.
 *
 * Detection errs toward detecting. A false positive costs a true read a
 * rewrite in a shape that verifies; a false negative is the hole above.
 *
 * An axis that ALSO appears in the GROUP BY is not a pivot: it is on the row
 * as a value, the latch can match it, and flagging it would reject the exact
 * shape this function exists to push the investigator toward.
 */
function pivotAxesInSql(sql) {
  const s = String(sql || '').toLowerCase();
  if (!s) return [];
  const gb = s.lastIndexOf('group by');
  const groupBy = gb === -1 ? '' : s.slice(gb);
  const hits = new Set();
  // A window after each pivot keyword, rather than a full expression parse.
  // The predicate that names the cohort sits immediately inside it.
  const re = /(?:filter\s*\(\s*where|case\s+when)([\s\S]{0,160})/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    for (const f of AXIS_FIELDS) {
      if (new RegExp('\\b' + f + '\\b').test(m[1])) hits.add(f);
    }
  }

  // The third spelling, and the one the clearing run actually used:
  //
  //   WITH female AS (SELECT ... WHERE p.gender = 'Female'),
  //        male   AS (SELECT ... WHERE p.gender = 'Male')
  //   SELECT f.item_name, f.ji_f, m.ji_m FROM female f JOIN male m USING (item_name)
  //
  // No FILTER, no CASE, and the same result: two cohorts side by side on one
  // row with the cohort recorded only in the aliases. Keying on the keyword
  // would have missed it, so the test is on the shape of the predicates --
  // an axis pinned to two DIFFERENT literals in one query is a query putting
  // two cohorts next to each other.
  //
  // Equality predicates only. A scoping filter writes its literals in one
  // list -- `WHERE p.gender IN ('Male','Female')` over a whole-population
  // aggregate -- and that row is honestly un-cut rather than pivoted, so
  // rejecting it would be a false positive on a legitimate shape.
  for (const f of AXIS_FIELDS) {
    const lits = new Set();
    const eq = new RegExp('\\b' + f + "\\s*=\\s*'([^']*)'", 'g');
    let e;
    while ((e = eq.exec(s)) !== null) lits.add(e[1]);
    if (lits.size >= 2) hits.add(f);
  }

  return Array.from(hits).filter(f => !new RegExp('\\b' + f + '\\b').test(groupBy));
}

/**
 * The cohorts a query PINNED in its WHERE clause, keyed by column.
 *
 * The third shape in this family, and the worst of the three. A pivot at least
 * puts several cohorts on the row; a pinned query puts none:
 *
 *   SELECT i.item_name, ROUND(AVG(r.joy_index)::numeric,1) AS ji, COUNT(*) AS n
 *   FROM   ... WHERE p.gender = 'Female' GROUP BY 1
 *
 * Every row is a woman's number and no returned value says so. `known` in the
 * evidence loop is built from the values the ROWS carried, so on this shape it
 * comes back EMPTY -- the latch has no vocabulary at all. A claim declaring
 * `gender: 'Female'` is therefore not checked and not rejected; it is silently
 * DISCARDED, and the undeclared claim takes the un-cut branch and seats on
 * anything. Characterized against live 2026-08-24: a read saying "Women sit at
 * 64.3 and 47.9" over a query pinned to 'Male' returned ok:true with every
 * number real, indistinguishable from the true read.
 *
 * Recording the pin gives the latch its vocabulary back, and that is all it
 * does. It is not the FILTER-predicate parser this file refused to build for
 * the pivot: there the cohort has to be mapped to the right COLUMN and a
 * mis-map misattributes a number, whereas here there is exactly one cohort and
 * it applies to every row, so there is no mapping to get wrong. And the rule
 * only ever narrows -- before it, an undeclared claim seated on any pinned row;
 * after it, a claim must name the pinned cohort to seat at all. No claim gains
 * a seat it did not already have, so a false positive costs a rewrite and can
 * never buy a fabrication a way through.
 *
 * EXACTLY ONE literal. Two or more via `=` is the pivot rule above; two or more
 * in an IN-list is a scoping filter over a pooled aggregate, which is honestly
 * un-cut and must keep passing. An axis in the GROUP BY is on the row as a
 * value already and is not pinned.
 */
function pinnedAxesInSql(sql) {
  const s = String(sql || '').toLowerCase();
  const out = {};
  if (!s) return out;
  const gb = s.lastIndexOf('group by');
  const groupBy = gb === -1 ? '' : s.slice(gb);

  for (const f of AXIS_FIELDS) {
    if (new RegExp('\\b' + f + '\\b').test(groupBy)) continue;
    const lits = new Set();
    const eq = new RegExp('\\b' + f + "\\s*=\\s*'([^']*)'", 'g');
    let e;
    while ((e = eq.exec(s)) !== null) lits.add(e[1]);
    // `IN ('Female')` is the same pin written longer. `IN` with more than one
    // member is the scoping filter and drops out on the size test below.
    const inList = new RegExp('\\b' + f + "\\s+in\\s*\\(([^)]*)\\)", 'g');
    let i;
    while ((i = inList.exec(s)) !== null) {
      for (const m of i[1].matchAll(/'([^']*)'/g)) lits.add(m[1]);
    }
    if (lits.size === 1) {
      const only = normalizeItemName(Array.from(lits)[0]);
      if (only) out[f] = only;
    }
  }
  return out;
}

// The normalized axis values a returned row carried, keyed by column.
// Empty object for a row that is not part of a cut.
function rowAxisValues(row) {
  const out = {};
  if (!row || typeof row !== 'object') return out;
  for (const field of AXIS_FIELDS) {
    const raw = row[field];
    if (typeof raw !== 'string') continue;
    const norm = normalizeItemName(raw);
    if (norm) out[field] = norm;
  }
  return out;
}

// Round to one decimal, matching what bjl_corpus_threads emits.
function roundJoy(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

// A difference, rounded by magnitude and keeping its sign.
//
// Differences here are signed: the sign is half of what a gap claim says, and
// dropping it left a read that correctly wrote "retired minus full-time,
// -9.5" with no legal form at all -- the guard demanded +9.5, which is the
// wrong answer to the figure's own label.
//
// Rounding the magnitude rather than deferring to roundJoy keeps the two
// directions of one gap symmetrical. roundJoy rounds a half toward +Infinity,
// so -9.45 would land on -9.4 while 9.45 lands on 9.5, and a read stating the
// gap the other way round would fail on a tie it could not see.
function roundDiff(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return n < 0 ? -roundJoy(-n) : roundJoy(n);
}

function toInt(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/**
 * Every numeric value a returned row carried, paired with the field it came
 * from.
 *
 * The investigator writes its own SQL and aliases the joy index however the
 * query reads best -- `ji`, `avg_ji`, `mean_score`. A guard that looks only
 * at `score` / `joy_index` / `audience_score` therefore cannot see the
 * number on most rows, records it as null, and rejects claims that copied it
 * correctly. Recording the whole numeric surface of the row lets a claim
 * verify against the row it actually came from without the guard having to
 * guess what the column was called.
 *
 * Postgres numerics arrive as strings over JSON, so a string is accepted
 * only when it is wholly a number -- '2024-01-01' and 'Gen X' stay out.
 * Booleans are excluded so `true` cannot pass for 1.
 */
function numericFields(row) {
  const out = [];
  if (!row || typeof row !== 'object') return out;
  for (const field of Object.keys(row)) {
    const raw = row[field];
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'string') {
      if (!/^-?\d+(\.\d+)?$/.test(raw.trim())) continue;
    } else if (typeof raw !== 'number') {
      continue;
    }
    const num = Number(raw);
    if (!Number.isFinite(num)) continue;
    out.push({ field, num });
  }
  return out;
}

/**
 * Does a single allowlist row carry both claimed numbers?
 *
 * The property worth keeping is that the score and the n came from the SAME
 * returned row. That is the anti-splice latch: it stops a score from one row
 * pairing with an n from another to authorize a figure no row ever carried.
 *
 * The property not worth keeping is the assumption that the score lives in a
 * column named `score`, `joy_index` or `audience_score`. Free-form SQL
 * cannot honor that, and asking the investigator to alias canonically is a
 * request, not a latch.
 *
 * So the check is same-row, any-column, with the score and the n required to
 * come from DIFFERENT fields so one value cannot stand in for both. A wide
 * row gives more surface for a coincidental match: that is the real cost of
 * this design, and it is accepted deliberately, because the alternative it
 * replaces was rejecting correct numbers on most rows.
 *
 * Returns { ok, joyFound, nFound } so a caller can attribute a failure to
 * the specific number that is absent rather than reporting a bare mismatch.
 */
function rowCarriesNumbers(row, claimJoy, claimN) {
  const values = Array.isArray(row && row.values) ? row.values : [];

  const joyFields = claimJoy === null ? null
    : values.filter(v => roundJoy(v.num) === claimJoy).map(v => v.field);
  const nFields = claimN === null ? null
    : values.filter(v => v.num === claimN).map(v => v.field);

  const joyFound = joyFields === null || joyFields.length > 0;
  const nFound   = nFields   === null || nFields.length > 0;
  if (!joyFound || !nFound) return { ok: false, joyFound, nFound };

  // Only one number was claimed, so there is no pairing to police.
  if (joyFields === null || nFields === null) return { ok: true, joyFound, nFound };

  const distinct = joyFields.some(f => nFields.some(g => g !== f));
  return { ok: distinct, joyFound, nFound };
}

/**
 * Build the allowlist from investigator scratch. Recognizes any scratch
 * entry whose query mentions bjl_corpus_threads( or bjl_corpus_pivot(, and
 * collects the returned rows. Row shape is what the SQL returns:
 *   { item_name, primary_topic, joy_index, n, thread_tag?, ... }
 *
 * Returns:
 *   {
 *     itemIndex: Map<normalized_item_name, { joy_index, n, primary_topic }[]>,
 *     threadTags: Set<string>,
 *   }
 *
 * The item index is a Map of arrays because the same item can legitimately
 * appear in multiple rows across the threads output (once per shared tag,
 * for instance). A member matches if any row for that name matches on
 * joy_index + n + primary_topic.
 */
function buildAllowlist(scratch) {
  const itemIndex = new Map();
  const threadTags = new Set();

  const entries = Array.isArray(scratch) ? scratch : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const q = typeof entry.query === 'string' ? entry.query.toLowerCase() : '';
    // Also handle entries that carry the sql on a different key (some flows
    // use `sql` or `query_text`); the invariant is a string containing the
    // function name. bjl_corpus_search is the Shape B lateral-search source;
    // bjl_corpus_bridges_v2 / bjl_corpus_bridges (v1) / bjl_corpus_threads /
    // bjl_corpus_pivot are recognized for back-compat with any scratch that
    // still carries them.
    const alt = [entry.sql, entry.query_text]
      .filter(v => typeof v === 'string')
      .map(v => v.toLowerCase());
    const hay = [q, ...alt].join(' ');
    if (
      !hay.includes('bjl_corpus_search(') &&
      !hay.includes('bjl_corpus_bridges_v2(') &&
      !hay.includes('bjl_corpus_bridges(') &&
      !hay.includes('bjl_corpus_threads(') &&
      !hay.includes('bjl_corpus_pivot(')
    ) continue;

    const rows = Array.isArray(entry.result) ? entry.result
               : Array.isArray(entry.rows)   ? entry.rows
               : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const key = normalizeItemName(row.item_name);
      if (!key) continue;
      // v2 rows use `score`; v1/legacy rows use `joy_index`. Accept either
      // as the primary numeric value so a member match works across
      // versions.
      const scoreValue = row.score != null ? row.score : row.joy_index;
      const bucket = itemIndex.get(key) || [];
      bucket.push({
        joy_index:     roundJoy(scoreValue),
        n:             toInt(row.n),
        primary_topic: typeof row.primary_topic === 'string' ? row.primary_topic : null,
        construct:     typeof row.construct === 'string' ? row.construct : null,
        // Whether the row that authorized this item carried a tag at all.
        // bjl_corpus_search (Shape B) returns items only — no tag, by
        // design — so an item sourced from it can never satisfy a tag
        // check. Recorded per row so mixed scratch, legacy bridges rows
        // alongside search rows, is judged row by row rather than in bulk.
        tagged:        !!(row.thread_tag || row.tag),
        // The stem this row was measured under. 792 item names in bjl_items
        // repeat, and all 792 repeat ACROSS question stems — they are grid
        // answer-labels ("A BEER", "Other - Write In") that appear once per
        // stem in the grid. Keying the bucket on the name alone puts two
        // different questions' "A BEER" in one place, and a claim matches if
        // any row in the bucket matches. Recording the stem is what lets a
        // number be bound to the question it was actually asked under.
        //
        // null on scratch produced before the search returned question_id.
        // That is a whole-job property, not a per-row one: the allowlist and
        // the claims come from the same job, so an older job simply has no
        // stems anywhere and is judged exactly as it was before.
        question_id:   toInt(row.question_id),
      });
      itemIndex.set(key, bucket);
      // bjl_corpus_bridges(_v2) emits `tag`; bjl_corpus_threads emitted
      // `thread_tag`. Accept either.
      if (typeof row.thread_tag === 'string' && row.thread_tag) {
        threadTags.add(row.thread_tag);
      } else if (typeof row.tag === 'string' && row.tag) {
        threadTags.add(row.tag);
      }
    }
  }

  return { itemIndex, threadTags };
}

/**
 * Infer the source table from a SQL string by looking at the first FROM
 * clause. Function-based calls (bjl_corpus_threads, bjl_corpus_pivot) are
 * mapped to bjl_scores since those functions read from bjl_scores. Returns
 * null when the SQL has no recognizable FROM.
 */
function inferSourceTable(sql) {
  if (typeof sql !== 'string') return null;
  const m = sql.match(/\bfrom\s+(?:public\.)?([a-z_][a-z0-9_]*)/i);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  if (raw === 'bjl_corpus_threads' || raw === 'bjl_corpus_pivot') return 'bjl_scores';
  return raw;
}

/**
 * The item a query pinned in its own WHERE clause, when it pinned exactly
 * one.
 *
 * A cut query -- theme-park joy by income bracket, live music by generation
 * -- groups by the cut and never selects item_name, so its rows carry no item
 * at all and the allowlist cannot see them. The item is not missing, though:
 * the query named it in `WHERE i.item_name = '...'`. Reading it from there
 * gives those rows the provenance they always had.
 *
 * Exactly one is required. A query pinning several items and returning rows
 * that identify none of them cannot say which row belongs to which item, and
 * attributing every row to every pinned name would invent provenance rather
 * than recover it.
 */
function pinnedItemName(sql) {
  if (typeof sql !== 'string') return null;
  const names = new Set();
  const eq = /\bitem_name\s*=\s*'((?:[^']|'')*)'/gi;
  let m;
  while ((m = eq.exec(sql)) !== null) names.add(m[1].replace(/''/g, "'"));
  const list = /\bitem_name\s*(?:=\s*any\s*\(\s*array\s*\[|in\s*\()([^)\]]*)/gi;
  while ((m = list.exec(sql)) !== null) {
    const lit = /'((?:[^']|'')*)'/g;
    let l;
    while ((l = lit.exec(m[1])) !== null) names.add(l[1].replace(/''/g, "'"));
  }
  return names.size === 1 ? Array.from(names)[0] : null;
}

/**
 * The item_id a query pinned in its own WHERE clause, when it pinned exactly
 * one.
 *
 * The investigator pins by id at least as often as by name -- `WHERE
 * i.item_id IN (4753, 4765)` -- and pinnedItemName cannot see that at all, so
 * every row of such a query was dropped from the allowlist and any true read
 * drawn from it failed as ungrounded.
 *
 * Exactly one, for the same reason as above and with a sharper edge here: a
 * query pinning two ids does not return one row per item, it returns rows
 * AGGREGATED ACROSS BOTH. That number belongs to neither item and attributing
 * it to either is a misattribution, not a recovery. Multi-id pins stay
 * dropped, deliberately.
 */
function pinnedItemId(sql) {
  if (typeof sql !== 'string') return null;
  const ids = new Set();
  const eq = /\bitem_id\s*=\s*(\d+)/gi;
  let m;
  while ((m = eq.exec(sql)) !== null) ids.add(m[1]);
  const list = /\bitem_id\s*(?:=\s*any\s*\(\s*array\s*\[|in\s*\()([^)\]]*)/gi;
  while ((m = list.exec(sql)) !== null) {
    for (const d of m[1].match(/\d+/g) || []) ids.add(d);
  }
  return ids.size === 1 ? Array.from(ids)[0] : null;
}

/**
 * item_id -> item_name, harvested from every row in scratch that carried
 * both. The corpus lookups the investigator runs first are exactly this
 * shape, so the map is usually populated before any cut query needs it.
 */
function buildItemIdIndex(scratch) {
  const byId = new Map();
  for (const entry of (Array.isArray(scratch) ? scratch : [])) {
    if (!entry || typeof entry !== 'object') continue;
    const rows = Array.isArray(entry.result) ? entry.result
               : Array.isArray(entry.rows)   ? entry.rows
               : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (row.item_id == null || typeof row.item_name !== 'string') continue;
      byId.set(String(row.item_id), row.item_name);
    }
  }
  return byId;
}

/**
 * Build the card allowlist from investigator scratch. Broader than the
 * threads allowlist: indexes every row from any SELECT with an item_name,
 * tagged with the source table inferred from the query's FROM clause.
 *
 * Rows are indexed under their item name AND under each cross-cutting axis
 * value they carry (generation, mode, income_bracket), so a read that names
 * the cohort rather than the item can be grounded at all. Every bucketed row
 * records the axis values it came with, which is what lets the guard check
 * that a cited number belongs to the cohort the claim names rather than
 * merely existing somewhere under the item.
 *
 * Returns Map<normalized_key, Array<{joy_index, n, source, axis}>>.
 */
function buildCardAllowlist(scratch) {
  const itemIndex = new Map();
  const entries = Array.isArray(scratch) ? scratch : [];
  const idIndex = buildItemIdIndex(scratch);
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const rawSql = typeof entry.query === 'string' ? entry.query
                 : typeof entry.sql === 'string' ? entry.sql
                 : typeof entry.query_text === 'string' ? entry.query_text
                 : '';
    const source = inferSourceTable(rawSql);
    if (!source) continue;
    // Named pin first; fall back to a single id pin resolved through the
    // corpus rows the investigation already returned.
    const pinnedId = pinnedItemId(rawSql);
    const pinned = pinnedItemName(rawSql)
                || (pinnedId !== null ? (idIndex.get(pinnedId) || null) : null);
    const pivotAxes = pivotAxesInSql(rawSql);
    const pinnedAxes = pinnedAxesInSql(rawSql);
    const rows = Array.isArray(entry.result) ? entry.result
               : Array.isArray(entry.rows)   ? entry.rows
               : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      // A row that names its own item wins. A row that names none inherits
      // the item its query pinned in the WHERE clause, which is how cut
      // queries (by generation, by income bracket) get provenance at all.
      const key = normalizeItemName(row.item_name || pinned);
      if (!key) continue;
      // v2 rows use `score`; v1/legacy rows use `joy_index`. Also accept
      // `audience_score` when the row comes from bjl_audience_affinity(_v2),
      // so a card citing an affinity finding matches.
      const scoreValue = row.score != null ? row.score
                       : row.joy_index != null ? row.joy_index
                       : row.audience_score;
      const nValue = row.n != null ? row.n : row.aud_n;
      const axis = rowAxisValues(row);
      const entry_ = {
        joy_index: roundJoy(scoreValue),
        n:         toInt(nValue),
        source,
        construct: typeof row.construct === 'string' ? row.construct : null,
        // The item name as the row spelled it, kept unnormalized so a
        // rejection can show a retry the string to copy rather than the
        // lowercased key the match ran on.
        item_name: (typeof row.item_name === 'string' && row.item_name) || pinned || null,
        // Which cohort axes this row's query wrote into COLUMN NAMES rather
        // than column values. Non-empty means the cohort on this row is
        // unmatchable -- see pivotAxesInSql.
        pivot_axes: pivotAxes,
        // The cohort this row's query pinned in its WHERE clause. Not on the
        // row as a value, but true of every row it returned, so the latch
        // treats it as one. See pinnedAxesInSql.
        pinned_axes: pinnedAxes,
        // Which cohort of a cut this row is. Empty when the row is not a cut.
        axis,
        // The row's full numeric surface, so a claim can verify against an
        // aliased score column. joy_index and n above stay for the failure
        // detail a human reads; `values` is what the match runs against.
        values:    numericFields(row),
      };
      // Index under the item, and under each axis value the row carried. The
      // second is how a read that says "Gen Z" finds any rows at all. An axis
      // value that collides with a real item name simply merges the two
      // buckets; the axis check below is what separates them again.
      const keys = new Set([key, ...Object.values(axis)]);
      for (const k of keys) {
        const bucket = itemIndex.get(k) || [];
        bucket.push(entry_);
        itemIndex.set(k, bucket);
      }
    }
  }
  return itemIndex;
}

/**
 * The item names the scratch actually returned, as the rows spelled them,
 * with the ones sharing a word with `claimed` first.
 *
 * Legibility for the item latch, which was the one major evidence rejection
 * that handed back nothing. Its siblings all show their work -- the axis
 * failure returns `cohorts_available`, the number mismatch returns the values
 * each candidate row really held, the comparison subject failure returns the
 * set members -- and this one said only "not in the allowlist". Job cee0bae9
 * cited `item_name: "everyday"` and `"big_ticket"`, its own category labels;
 * told those were not items and not told what was, its retry abandoned the
 * evidence framing entirely and reached for prose, which then died on the
 * comparative latch. The read was real and the run lost it to a failure that
 * could not be acted on.
 *
 * Showing the names is legibility, not licence. The match is unchanged: an
 * evidence entry still has to name a row the scratch returned, and a name
 * copied off this list is verified exactly as one typed from memory is.
 */
function allowlistItemNames(itemIndex, claimed, cap = 40) {
  const seen = new Set();
  const names = [];
  for (const bucket of itemIndex.values()) {
    for (const r of bucket) {
      if (typeof r.item_name !== 'string' || !r.item_name || seen.has(r.item_name)) continue;
      seen.add(r.item_name);
      names.push(r.item_name);
    }
  }
  const words = new Set(normalizeItemName(claimed).split(' ').filter(w => w.length > 2));
  const shares = n => normalizeItemName(n).split(' ').some(w => words.has(w));
  return names.filter(shares).concat(names.filter(n => !shares(n))).slice(0, cap);
}

/**
 * Function-based allowlist builders. Each recognizes scratch entries whose
 * SQL text contains a specific function name and collects the returned rows.
 * These four surfaces (signature, cross_domain_items, audience_affinity,
 * audience_profile) map 1:1 to bjl_signature / bjl_corpus_bridges /
 * bjl_audience_affinity / bjl_audience_profile respectively.
 */
function collectRowsFromFn(scratch, fnNames) {
  const out = [];
  const entries = Array.isArray(scratch) ? scratch : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const q = typeof entry.query === 'string' ? entry.query.toLowerCase() : '';
    const alt = [entry.sql, entry.query_text]
      .filter(v => typeof v === 'string')
      .map(v => v.toLowerCase());
    const hay = [q, ...alt].join(' ');
    if (!fnNames.some(name => hay.includes(name + '('))) continue;
    const rows = Array.isArray(entry.result) ? entry.result
               : Array.isArray(entry.rows)   ? entry.rows
               : [];
    for (const row of rows) if (row && typeof row === 'object') out.push(row);
  }
  return out;
}

function buildSignatureAllowlist(scratch) {
  const rows = collectRowsFromFn(scratch, ['bjl_signature']);
  // Set of "framework|tag" strings; tag alone as fallback since framework is
  // optional in the claim.
  const byTag = new Map();
  for (const r of rows) {
    if (typeof r.tag !== 'string' || !r.tag) continue;
    const framework = typeof r.framework === 'string' ? r.framework : null;
    const distinctiveness = r.distinctiveness == null ? null : Number(r.distinctiveness);
    if (!byTag.has(r.tag)) byTag.set(r.tag, []);
    byTag.get(r.tag).push({ framework, distinctiveness });
  }
  return byTag;
}

function buildAudienceAffinityAllowlist(scratch) {
  // Accept both v2 and v1 function names, plus their score-column aliases:
  //   v2 uses audience_score / general_score
  //   v1 uses audience_ji / general_ji
  // v2 also carries the reportable boolean (rel_lift >= materiality_floor);
  // absent on v1 rows, defaults to true so v1 guard behavior is unchanged.
  //
  // audience_thin marks a row whose whole audience fell below min_aud_n, so
  // the per-item floor was relaxed to let it through at all. Absent on v1
  // rows and on any scratch predating the thin band, where it defaults to
  // false -- those rows cleared the full floor, so treating them as
  // not-thin is the truthful default and leaves old behavior unchanged.
  const rows = collectRowsFromFn(scratch, ['bjl_audience_affinity_v2', 'bjl_audience_affinity']);
  const byItem = new Map();
  for (const r of rows) {
    const key = normalizeItemName(r.item_name);
    if (!key) continue;
    const audScore = r.audience_score != null ? r.audience_score : r.audience_ji;
    const genScore = r.general_score  != null ? r.general_score  : r.general_ji;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push({
      rel_lift:      r.rel_lift == null ? null : Math.round(Number(r.rel_lift) * 10) / 10,
      audience_ji:   audScore == null ? null : Math.round(Number(audScore) * 10) / 10,
      general_ji:    genScore == null ? null : Math.round(Number(genScore) * 10) / 10,
      aud_n:         toInt(r.aud_n),
      primary_topic: typeof r.primary_topic === 'string' ? r.primary_topic : null,
      construct:     typeof r.construct === 'string' ? r.construct : null,
      reportable:    typeof r.reportable === 'boolean' ? r.reportable : true,
      audience_thin: typeof r.audience_thin === 'boolean' ? r.audience_thin : false,
    });
  }
  return byItem;
}

/**
 * Select-all allowlist. Rows are keyed on the (question, item_name) pair,
 * not item_name alone, because option text ("food", "connection") recurs
 * across batteries and only the question label disambiguates the meaning.
 */
function buildAudienceSelectsAllowlist(scratch) {
  const rows = collectRowsFromFn(scratch, ['bjl_audience_selects_v2']);
  const byKey = new Map();
  for (const r of rows) {
    const item = normalizeItemName(r.item_name);
    const question = typeof r.question === 'string' ? r.question.trim() : null;
    if (!item || !question) continue;
    const key = `${normalizeItemName(question)}|${item}`;
    if (!byKey.has(key)) byKey.set(key, []);
    // lift and norm_lift are both selection scores; captured for diagnostic
    // completeness but never verified against claims. The prompt-side rule
    // keeps both out of prose. aud_pct / gen_pct / aud_exposed are what the
    // guard actually checks.
    byKey.get(key).push({
      question,
      aud_pct:     r.aud_pct == null ? null : Math.round(Number(r.aud_pct) * 10) / 10,
      gen_pct:     r.gen_pct == null ? null : Math.round(Number(r.gen_pct) * 10) / 10,
      lift:        r.lift == null ? null : Math.round(Number(r.lift) * 100) / 100,
      norm_lift:   r.norm_lift == null ? null : Math.round(Number(r.norm_lift) * 100) / 100,
      aud_exposed: toInt(r.aud_exposed),
    });
  }
  return byKey;
}

/**
 * Distribution allowlist. Rows keyed on (item_name, set_name, answer) because
 * one item can carry two scales from different waves and shares are only
 * comparable within a set. All three parts of the key are mandatory on the
 * claim; the guard rejects entries that omit any.
 */
function buildAudienceDistributionsAllowlist(scratch) {
  const rows = collectRowsFromFn(scratch, ['bjl_audience_distributions_v2']);
  const byKey = new Map();
  for (const r of rows) {
    const item = normalizeItemName(r.item_name);
    const set  = typeof r.set_name === 'string' ? r.set_name.trim() : null;
    const answer = typeof r.answer === 'string' ? r.answer.trim() : null;
    if (!item || !set || !answer) continue;
    const key = `${item}|${normalizeItemName(set)}|${normalizeItemName(answer)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({
      construct: typeof r.construct === 'string' ? r.construct : null,
      aud_pct:   r.aud_pct == null ? null : Math.round(Number(r.aud_pct) * 10) / 10,
      gen_pct:   r.gen_pct == null ? null : Math.round(Number(r.gen_pct) * 10) / 10,
      gap_pts:   r.gap_pts == null ? null : Math.round(Number(r.gap_pts) * 10) / 10,
      aud_n:     toInt(r.aud_n),
    });
  }
  return byKey;
}

function buildAudienceProfileAllowlist(scratch) {
  const rows = collectRowsFromFn(scratch, ['bjl_audience_profile_v2', 'bjl_audience_profile']);
  const byKey = new Map();
  for (const r of rows) {
    const dim = typeof r.dimension === 'string' ? r.dimension : null;
    const cut = typeof r.cut_value === 'string' ? r.cut_value : (r.cut_value == null ? null : String(r.cut_value));
    if (!dim || cut === null) continue;
    const key = `${dim}|${cut}`.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({
      index:             r.index == null ? null : Math.round(Number(r.index)),
      pct_of_audience:   r.pct_of_audience == null ? null : Math.round(Number(r.pct_of_audience) * 10) / 10,
      pct_of_population: r.pct_of_population == null ? null : Math.round(Number(r.pct_of_population) * 10) / 10,
    });
  }
  return byKey;
}

/**
 * Coerce home_topic (string or string[]) into a normalized Set<string>.
 * Everything is lowercased for comparison, since primary_topic values are
 * lowercase in the corpus.
 */
function buildHomeTopicSet(home_topic) {
  const set = new Set();
  const push = v => {
    if (typeof v === 'string' && v.trim()) set.add(v.trim().toLowerCase());
  };
  if (Array.isArray(home_topic)) home_topic.forEach(push);
  else push(home_topic);
  return set;
}

/**
 * The provenance guard entry point. Returns { ok, failures } and does not
 * throw. Runs both surfaces (threads + cards) on the same call so the
 * caller can retry once and drop the offending field(s) on second failure.
 *
 * Failures carry a `surface` field ('threads' or 'cards') so the caller
 * can drop only what actually failed rather than the whole structured
 * output.
 *
 * @param {object} args
 * @param {Array}  [args.threads]     — cross_domain_threads from synth output
 * @param {Array}  [args.cards]       — cards from synth output
 * @param {string|string[]} [args.home_topic] — from synth output
 * @param {Array}  args.scratch       — investigator scratch (for allowlists)
 */
function runProvenanceGuard({
  threads,
  cards,
  signature,
  cross_domain_items,
  audience_affinity,
  audience_profile,
  audience_selects,
  audience_distributions,
  audience_readout_preamble,
  home_topic,
  scratch,
}) {
  const affinityHasEntries = Array.isArray(audience_affinity) && audience_affinity.length > 0;
  const preambleMissing = affinityHasEntries && (
    typeof audience_readout_preamble !== 'string' ||
    audience_readout_preamble.trim().length < 40
  );
  const failures = [
    ...runSignatureGuard({ signature, scratch })
      .map(f => Object.assign({ surface: 'signature' }, f)),
    ...runCrossDomainItemsGuard({ cross_domain_items, home_topic, scratch })
      .map(f => Object.assign({ surface: 'cross_domain_items' }, f)),
    ...runAudienceAffinityGuard({ audience_affinity, scratch })
      .map(f => Object.assign({ surface: 'audience_affinity' }, f)),
    ...(preambleMissing ? [{
      surface: 'audience_readout_preamble',
      reason: 'preamble_required_with_affinity',
      detail: 'audience_affinity has entries but audience_readout_preamble is missing or too short. The preamble defines raw vs centered for the reader; it must accompany every turn with audience-affinity findings.',
    }] : []),
    ...runAudienceProfileGuard({ audience_profile, scratch })
      .map(f => Object.assign({ surface: 'audience_profile' }, f)),
    ...runAudienceSelectsGuard({ audience_selects, scratch })
      .map(f => Object.assign({ surface: 'audience_selects' }, f)),
    ...runAudienceDistributionsGuard({ audience_distributions, scratch })
      .map(f => Object.assign({ surface: 'audience_distributions' }, f)),
    ...runThreadsGuard({ threads, home_topic, scratch })
      .map(f => Object.assign({ surface: 'threads' }, f)),
    ...runCardsGuard({ cards, scratch })
      .map(f => Object.assign({ surface: 'cards' }, f)),
  ];
  return { ok: failures.length === 0, failures };
}

// Back-compat alias so existing callers importing runCrossDomainProvenanceGuard
// keep working. Internally delegates to the unified guard.
function runCrossDomainProvenanceGuard(args) {
  return runProvenanceGuard(args);
}

function runThreadsGuard({ threads, home_topic, scratch }) {
  const failures = [];

  const list = Array.isArray(threads) ? threads : [];
  if (list.length === 0) return failures;

  const { itemIndex, threadTags } = buildAllowlist(scratch);
  const homeTopics = buildHomeTopicSet(home_topic);

  // Nothing came back from the function. Any structured cross-domain claim
  // in this state is off-source by definition.
  if (itemIndex.size === 0 && threadTags.size === 0) {
    failures.push({
      claim: null,
      reason: 'no_threads_rows_in_scratch',
      detail: 'bjl_corpus_threads / bjl_corpus_pivot did not run this turn or returned no rows, but cross_domain_threads was populated',
    });
    return failures;
  }

  for (const t of list) {
    if (!t || typeof t !== 'object') {
      failures.push({ claim: t, reason: 'malformed_thread' });
      continue;
    }

    // Check 3 — thread_tag must be one of the tags in the allowlist.
    if (typeof t.thread_tag !== 'string' || !threadTags.has(t.thread_tag)) {
      failures.push({
        claim: { thread_tag: t.thread_tag, name: t.name },
        reason: 'thread_tag_not_in_allowlist',
      });
    }

    const members = Array.isArray(t.members) ? t.members : [];
    for (const m of members) {
      if (!m || typeof m !== 'object' || typeof m.item_name !== 'string') {
        failures.push({ claim: m, reason: 'malformed_member' });
        continue;
      }
      const key = normalizeItemName(m.item_name);
      const bucket = itemIndex.get(key);

      // Check 1 — item name must exist in the allowlist.
      if (!bucket || bucket.length === 0) {
        failures.push({
          claim: { item_name: m.item_name, thread: t.thread_tag },
          reason: 'item_not_in_allowlist',
        });
        continue;
      }

      const claimJoy   = roundJoy(m.joy_index);
      const claimN     = toInt(m.n);
      const claimTopic = typeof m.primary_topic === 'string' ? m.primary_topic.toLowerCase() : null;

      // A row matches if joy_index, n, AND primary_topic all agree. Multiple
      // rows can exist per item; we accept the member if any row agrees.
      let matched = false;
      let closestJoyMismatch = null;
      let closestNMismatch = null;
      let closestTopicMismatch = null;
      for (const row of bucket) {
        const joyOk   = claimJoy === row.joy_index;
        const nOk     = claimN === row.n;
        const topicOk = claimTopic === (row.primary_topic ? row.primary_topic.toLowerCase() : null);
        if (joyOk && nOk && topicOk) { matched = true; break; }
        if (!joyOk && closestJoyMismatch === null) {
          closestJoyMismatch = { claim: claimJoy, allowlist: row.joy_index };
        }
        if (!nOk && closestNMismatch === null) {
          closestNMismatch = { claim: claimN, allowlist: row.n };
        }
        if (!topicOk && closestTopicMismatch === null) {
          closestTopicMismatch = { claim: claimTopic, allowlist: row.primary_topic };
        }
      }

      if (!matched) {
        // Attribute the failure to whichever axis diverged. Numbers reported
        // first because they're the ones a client sees.
        if (closestJoyMismatch) {
          failures.push({
            claim: { item_name: m.item_name, joy_index: m.joy_index },
            reason: 'joy_index_mismatch',
            detail: closestJoyMismatch,
          });
        } else if (closestNMismatch) {
          failures.push({
            claim: { item_name: m.item_name, n: m.n },
            reason: 'n_mismatch',
            detail: closestNMismatch,
          });
        } else if (closestTopicMismatch) {
          failures.push({
            claim: { item_name: m.item_name, primary_topic: m.primary_topic },
            reason: 'primary_topic_mismatch',
            detail: closestTopicMismatch,
          });
        }
      }

      // Check 4 — home-topic exclusion. bjl_corpus_threads already excludes
      // the home topic in its default call, so this catches a member the
      // synthesizer reintroduced from outside the allowlist or a topic
      // relabel between rows and claim.
      if (claimTopic && homeTopics.has(claimTopic)) {
        failures.push({
          claim: { item_name: m.item_name, primary_topic: m.primary_topic },
          reason: 'home_topic_bleed',
          detail: { home_topics: Array.from(homeTopics) },
        });
      }
    }
  }

  return failures;
}

/**
 * Signature guard. Every claimed {tag, framework, distinctiveness?} must
 * appear in a bjl_signature row. Distinctiveness match is 2-decimal-tolerant
 * (0.01 slack) since the model may restate it truncated.
 */
function runSignatureGuard({ signature, scratch }) {
  const failures = [];
  const list = Array.isArray(signature) ? signature : [];
  if (list.length === 0) return failures;

  const byTag = buildSignatureAllowlist(scratch);
  if (byTag.size === 0) {
    failures.push({
      claim: null,
      reason: 'no_signature_rows_in_scratch',
      detail: 'signature was populated but bjl_signature did not run this turn',
    });
    return failures;
  }

  for (const s of list) {
    if (!s || typeof s !== 'object' || typeof s.tag !== 'string') {
      failures.push({ claim: s, reason: 'malformed_signature_entry' });
      continue;
    }
    const bucket = byTag.get(s.tag);
    if (!bucket || bucket.length === 0) {
      failures.push({ claim: { tag: s.tag }, reason: 'signature_tag_not_in_allowlist' });
      continue;
    }
    const claimFramework = typeof s.framework === 'string' ? s.framework.toLowerCase() : null;
    const claimDist = s.distinctiveness == null ? null : Number(s.distinctiveness);
    let matched = false;
    for (const row of bucket) {
      const frameworkOk = claimFramework === null || row.framework === null || claimFramework === (row.framework || '').toLowerCase();
      const distOk = claimDist === null || row.distinctiveness === null
        || Math.abs(claimDist - row.distinctiveness) <= 0.01;
      if (frameworkOk && distOk) { matched = true; break; }
    }
    if (!matched) {
      failures.push({
        claim: { tag: s.tag, framework: s.framework, distinctiveness: s.distinctiveness },
        reason: 'signature_row_mismatch',
      });
    }
  }
  return failures;
}

/**
 * Cross_domain_items guard (flat shape from bjl_corpus_bridges). Runs the
 * same four checks as the legacy threads guard: item, joy_index, n,
 * primary_topic (from bridges rows) + home-topic exclusion.
 */
function runCrossDomainItemsGuard({ cross_domain_items, home_topic, scratch }) {
  const failures = [];
  const list = Array.isArray(cross_domain_items) ? cross_domain_items : [];
  if (list.length === 0) return failures;

  const { itemIndex, threadTags } = buildAllowlist(scratch);
  const homeTopics = buildHomeTopicSet(home_topic);

  if (itemIndex.size === 0 && threadTags.size === 0) {
    failures.push({
      claim: null,
      reason: 'no_bridges_rows_in_scratch',
      detail: 'cross_domain_items was populated but bjl_corpus_search (or the legacy bjl_corpus_bridges) did not run this turn or returned no rows',
    });
    return failures;
  }

  // entry_index rides on every failure raised INSIDE this loop, and
  // deliberately not on the whole-surface failures above it. It is what lets
  // a retry drop the offending rows instead of the offending surface: three
  // bad items used to cost the reader all ten. A failure with no index is a
  // statement about the list itself, so the list still goes.
  for (let entry_index = 0; entry_index < list.length; entry_index++) {
    const m = list[entry_index];
    if (!m || typeof m !== 'object' || typeof m.item_name !== 'string') {
      failures.push({ entry_index, claim: m, reason: 'malformed_cross_domain_item' });
      continue;
    }
    const key = normalizeItemName(m.item_name);
    const bucket = itemIndex.get(key);
    if (!bucket || bucket.length === 0) {
      failures.push({ entry_index, claim: { item_name: m.item_name, tag: m.tag }, reason: 'cross_domain_item_not_in_allowlist' });
      continue;
    }
    // Tag check, but only for items whose authorizing row actually carried
    // a tag. bjl_corpus_search returns no tag and both prompts forbid the
    // model from emitting one, so demanding a tag here failed every
    // Shape B item and silently dropped the whole sidecar. The arm is the
    // authority on its own return shape; the guard follows it.
    if (bucket.some(row => row.tagged)) {
      if (typeof m.tag !== 'string' || !threadTags.has(m.tag)) {
        failures.push({ entry_index, claim: { item_name: m.item_name, tag: m.tag }, reason: 'cross_domain_tag_not_in_allowlist' });
      }
    }
    // v2 claims use `score`; v1 claims use `joy_index`. Accept either.
    const claimScoreRaw = m.score != null ? m.score : m.joy_index;
    const claimJoy   = roundJoy(claimScoreRaw);
    const claimN     = toInt(m.n);
    const claimTopic = typeof m.primary_topic === 'string' ? m.primary_topic.toLowerCase() : null;
    const claimStem  = toInt(m.question_id);

    const stems = new Set(bucket.map(r => r.question_id).filter(v => v != null));

    // NOT ENFORCED YET, AND THE REASON IS A MEASUREMENT.
    //
    // The unverifiable shape here is a claim that names no stem for an item
    // whose name spans several stems with DIFFERENT scores -- "Visiting a
    // ZOO" carries four, from 54.1 to 70.0. Nothing in that claim says which
    // number is meant, and the reader is shown a label meaning several
    // things. By the usual rule this should be refused rather than guessed.
    //
    // It is not refused today because the synthesizer has never emitted
    // question_id: bjl_session_figures has 23 rows and the column is NULL on
    // every one, and that column is already read from stat_items, so it
    // would be populated if it were ever set. Refusing stemless claims
    // against a model that emits no stems would reject 38.5% of returned
    // rows across 241 replayed calls, on 77% of calls -- a larger hole than
    // it closes, pointed the other way, and a direct reversal of 8fba327 and
    // 22f73cf.
    //
    // Sequence: the prompt now requires question_id on every cross_domain
    // item and stat_item. When the ledger shows it populated at a high rate,
    // promote this to a hard refusal in a follow-up, citing that rate. The
    // stems set is computed above and left in place so the mismatch check
    // below can report what was available.

    let matched = false;
    let consideredAny = false;
    let closest = { joy: null, n: null, topic: null };
    for (const row of bucket) {
      // When both sides name a stem they must agree. A claim carrying the
      // wrong stem is the relabel stated outright, and no amount of matching
      // score and n redeems it.
      if (claimStem !== null && row.question_id !== null && claimStem !== row.question_id) continue;
      consideredAny = true;
      const joyOk   = claimJoy === row.joy_index;
      const nOk     = claimN === row.n;
      const topicOk = claimTopic === (row.primary_topic ? row.primary_topic.toLowerCase() : null);
      if (joyOk && nOk && topicOk) { matched = true; break; }
      if (!joyOk   && closest.joy   === null) closest.joy   = { claim: claimJoy, allowlist: row.joy_index };
      if (!nOk     && closest.n     === null) closest.n     = { claim: claimN, allowlist: row.n };
      if (!topicOk && closest.topic === null) closest.topic = { claim: claimTopic, allowlist: row.primary_topic };
    }
    // The stem filter can empty the bucket. When it does, `closest` was never
    // populated and the mismatch branches below would all be skipped, so the
    // claim would pass by falling through every check. It is raised here
    // instead: the item exists under some stem, just not the one claimed.
    if (!matched && !consideredAny) {
      failures.push({
        entry_index,
        claim: { item_name: m.item_name, question_id: m.question_id },
        reason: 'cross_domain_item_stem_mismatch',
        detail: { claim: claimStem, allowlist: Array.from(stems) },
      });
      continue;
    }
    if (!matched) {
      if (closest.joy)   failures.push({ entry_index, claim: { item_name: m.item_name, score: claimScoreRaw }, reason: 'cross_domain_score_mismatch', detail: closest.joy });
      else if (closest.n)   failures.push({ entry_index, claim: { item_name: m.item_name, n: m.n }, reason: 'cross_domain_n_mismatch', detail: closest.n });
      else if (closest.topic) failures.push({ entry_index, claim: { item_name: m.item_name, primary_topic: m.primary_topic }, reason: 'cross_domain_topic_mismatch', detail: closest.topic });
    }
    if (claimTopic && homeTopics.has(claimTopic)) {
      failures.push({
        entry_index,
        claim: { item_name: m.item_name, primary_topic: m.primary_topic },
        reason: 'cross_domain_home_topic_bleed',
        detail: { home_topics: Array.from(homeTopics) },
      });
    }
  }
  return failures;
}

/**
 * Audience affinity guard. Every claimed {item_name, rel_lift, audience_ji,
 * aud_n} must appear in a bjl_audience_affinity row. Numeric comparisons
 * are 1-decimal for joy/lift, exact for n.
 */
function runAudienceAffinityGuard({ audience_affinity, scratch }) {
  const failures = [];
  const list = Array.isArray(audience_affinity) ? audience_affinity : [];
  if (list.length === 0) return failures;

  const byItem = buildAudienceAffinityAllowlist(scratch);
  if (byItem.size === 0) {
    failures.push({
      claim: null,
      reason: 'no_audience_affinity_rows_in_scratch',
      detail: 'audience_affinity was populated but bjl_audience_affinity did not run this turn',
    });
    return failures;
  }

  for (let entry_index = 0; entry_index < list.length; entry_index++) {
    const m = list[entry_index];
    if (!m || typeof m !== 'object' || typeof m.item_name !== 'string') {
      failures.push({ entry_index, claim: m, reason: 'malformed_audience_affinity_entry' });
      continue;
    }
    const key = normalizeItemName(m.item_name);
    const bucket = byItem.get(key);
    if (!bucket || bucket.length === 0) {
      failures.push({ entry_index, claim: { item_name: m.item_name }, reason: 'audience_item_not_in_allowlist' });
      continue;
    }
    // v2 claims use `audience_score`; v1 claims use `audience_ji`. Accept either.
    const claimScoreRaw = m.audience_score != null ? m.audience_score : m.audience_ji;
    const claimGenScoreRaw = m.general_score != null ? m.general_score : m.general_ji;
    const claimLift  = m.rel_lift == null ? null : Math.round(Number(m.rel_lift) * 10) / 10;
    const claimJI    = claimScoreRaw == null ? null : Math.round(Number(claimScoreRaw) * 10) / 10;
    const claimGen   = claimGenScoreRaw == null ? null : Math.round(Number(claimGenScoreRaw) * 10) / 10;
    const claimN     = toInt(m.aud_n);
    // Reportability rule: reportable is required on every entry, and the
    // value the synth emits must match the row's reportable flag. Rows are
    // never re-tagged in prose; the DB function is the source of truth.
    const claimReportable = typeof m.reportable === 'boolean' ? m.reportable : null;
    const claimThin = typeof m.audience_thin === 'boolean' ? m.audience_thin : null;
    let matched = false;
    let matchedRow = null;
    let closest = { lift: null, ji: null, gen: null, n: null };
    for (const row of bucket) {
      const liftOk = claimLift === null || row.rel_lift === null || claimLift === row.rel_lift;
      const jiOk   = claimJI === null || row.audience_ji === null || claimJI === row.audience_ji;
      const genOk  = claimGen === null || row.general_ji === null || claimGen === row.general_ji;
      const nOk    = claimN === null || row.aud_n === null || claimN === row.aud_n;
      if (liftOk && jiOk && genOk && nOk) { matched = true; matchedRow = row; break; }
      if (!liftOk && closest.lift === null) closest.lift = { claim: claimLift, allowlist: row.rel_lift };
      if (!jiOk   && closest.ji   === null) closest.ji   = { claim: claimJI, allowlist: row.audience_ji };
      if (!genOk  && closest.gen  === null) closest.gen  = { claim: claimGen, allowlist: row.general_ji };
      if (!nOk    && closest.n    === null) closest.n    = { claim: claimN, allowlist: row.aud_n };
    }
    if (!matched) {
      if (closest.lift) failures.push({ entry_index, claim: { item_name: m.item_name, rel_lift: m.rel_lift }, reason: 'audience_rel_lift_mismatch', detail: closest.lift });
      else if (closest.ji) failures.push({ entry_index, claim: { item_name: m.item_name, audience_score: claimScoreRaw }, reason: 'audience_score_mismatch', detail: closest.ji });
      else if (closest.gen) failures.push({ entry_index, claim: { item_name: m.item_name, general_score: claimGenScoreRaw }, reason: 'audience_general_score_mismatch', detail: closest.gen });
      else if (closest.n) failures.push({ entry_index, claim: { item_name: m.item_name, aud_n: m.aud_n }, reason: 'audience_n_mismatch', detail: closest.n });
      continue;
    }
    // Structural reportability check: every audience-affinity entry MUST
    // carry the reportable boolean, and it must match the row's flag from
    // scratch. This prevents the synth from silently upgrading a
    // sub-threshold row into a distinctive-preference finding.
    if (claimReportable === null) {
      failures.push({ entry_index, claim: { item_name: m.item_name }, reason: 'audience_reportable_missing', detail: 'audience_affinity entry omitted the reportable boolean; every entry must carry it (source of truth is the scratch row).' });
    } else if (matchedRow && typeof matchedRow.reportable === 'boolean' && claimReportable !== matchedRow.reportable) {
      failures.push({
        entry_index,
        claim: { item_name: m.item_name, reportable: claimReportable },
        reason: 'audience_reportable_mismatch',
        detail: { claim: claimReportable, allowlist: matchedRow.reportable, rel_lift: matchedRow.rel_lift },
      });
    }
    // Thin-audience rule. A thin row only exists because the per-item floor
    // was relaxed for an audience that could not clear min_aud_n, so it MUST
    // arrive declared thin -- a thin finding stripped of its warning reads
    // exactly like one that cleared the full bar, which is the specific
    // failure the thin band would otherwise introduce.
    //
    // Deliberately asymmetric: a NOT-thin row need not carry the flag, so v1
    // rows and every pre-thin-band scratch keep passing untouched. Only the
    // dangerous direction is required.
    if (matchedRow && matchedRow.audience_thin === true && claimThin !== true) {
      failures.push({
        entry_index,
        claim: { item_name: m.item_name, audience_thin: claimThin },
        reason: 'audience_thin_undeclared',
        detail: 'this row comes from an audience below min_aud_n and survived only because the per-item floor was relaxed; the entry must carry audience_thin: true so the reader is told the base is thin.',
      });
    } else if (claimThin !== null && matchedRow
               && typeof matchedRow.audience_thin === 'boolean'
               && claimThin !== matchedRow.audience_thin) {
      failures.push({
        entry_index,
        claim: { item_name: m.item_name, audience_thin: claimThin },
        reason: 'audience_thin_mismatch',
        detail: { claim: claimThin, allowlist: matchedRow.audience_thin },
      });
    }
    // Both raw scores (audience_score AND general_score) must be present on
    // every entry. The reportability rule requires the reader to see both
    // numbers alongside rel_lift so a raw gap cannot be inferred as the
    // effect size.
    if (claimScoreRaw == null) {
      failures.push({ entry_index, claim: { item_name: m.item_name }, reason: 'audience_score_missing' });
    }
    if (claimGenScoreRaw == null) {
      failures.push({ entry_index, claim: { item_name: m.item_name }, reason: 'audience_general_score_missing', detail: 'audience_affinity entry must include general_score alongside audience_score; the reader must see both numbers, not just one side of the comparison.' });
    }
    if (claimLift === null) {
      failures.push({ entry_index, claim: { item_name: m.item_name }, reason: 'audience_rel_lift_missing', detail: 'audience_affinity entry must include rel_lift; it is the centered effect size and the honest finding.' });
    }
  }
  return failures;
}

/**
 * Audience profile guard. Every claimed {dimension, cut_value, index} must
 * appear in a bjl_audience_profile row. Index is exact-integer.
 */
function runAudienceProfileGuard({ audience_profile, scratch }) {
  const failures = [];
  const list = Array.isArray(audience_profile) ? audience_profile : [];
  if (list.length === 0) return failures;

  const byKey = buildAudienceProfileAllowlist(scratch);
  if (byKey.size === 0) {
    failures.push({
      claim: null,
      reason: 'no_audience_profile_rows_in_scratch',
      detail: 'audience_profile was populated but bjl_audience_profile did not run this turn',
    });
    return failures;
  }

  for (const m of list) {
    if (!m || typeof m !== 'object' || typeof m.dimension !== 'string' || m.cut_value == null) {
      failures.push({ claim: m, reason: 'malformed_audience_profile_entry' });
      continue;
    }
    const key = `${m.dimension}|${m.cut_value}`.toLowerCase();
    const bucket = byKey.get(key);
    if (!bucket || bucket.length === 0) {
      failures.push({ claim: { dimension: m.dimension, cut_value: m.cut_value }, reason: 'audience_profile_row_not_in_allowlist' });
      continue;
    }
    const claimIndex = m.index == null ? null : Math.round(Number(m.index));
    let matched = false;
    let closest = null;
    for (const row of bucket) {
      const indexOk = claimIndex === null || row.index === null || claimIndex === row.index;
      if (indexOk) { matched = true; break; }
      if (closest === null) closest = { claim: claimIndex, allowlist: row.index };
    }
    if (!matched) {
      failures.push({
        claim: { dimension: m.dimension, cut_value: m.cut_value, index: m.index },
        reason: 'audience_profile_index_mismatch',
        detail: closest,
      });
    }
  }
  return failures;
}

/**
 * Audience_selects guard. Every claim must appear in a bjl_audience_selects_v2
 * row keyed on the (question, item_name) pair. Numeric checks: aud_pct and
 * gen_pct to one decimal, aud_exposed exact. norm_lift is a selection score
 * and is not verified against the claim (the model should not be citing it
 * as a finding; the prompt-side rule catches that).
 */
function runAudienceSelectsGuard({ audience_selects, scratch }) {
  const failures = [];
  const list = Array.isArray(audience_selects) ? audience_selects : [];
  if (list.length === 0) return failures;

  const byKey = buildAudienceSelectsAllowlist(scratch);
  if (byKey.size === 0) {
    failures.push({
      claim: null,
      reason: 'no_audience_selects_rows_in_scratch',
      detail: 'audience_selects was populated but bjl_audience_selects_v2 did not run this turn',
    });
    return failures;
  }

  for (const m of list) {
    if (!m || typeof m !== 'object' || typeof m.item_name !== 'string') {
      failures.push({ claim: m, reason: 'malformed_audience_selects_entry' });
      continue;
    }
    // The question label is mandatory because option text recurs across
    // batteries. A claim without one cannot be located unambiguously in
    // the allowlist.
    if (typeof m.question !== 'string' || !m.question.trim()) {
      failures.push({
        claim: { item_name: m.item_name },
        reason: 'audience_selects_missing_question',
      });
      continue;
    }
    const key = `${normalizeItemName(m.question)}|${normalizeItemName(m.item_name)}`;
    const bucket = byKey.get(key);
    if (!bucket || bucket.length === 0) {
      failures.push({
        claim: { question: m.question, item_name: m.item_name },
        reason: 'audience_selects_row_not_in_allowlist',
      });
      continue;
    }
    const claimAud = m.aud_pct == null ? null : Math.round(Number(m.aud_pct) * 10) / 10;
    const claimGen = m.gen_pct == null ? null : Math.round(Number(m.gen_pct) * 10) / 10;
    const claimExposed = toInt(m.aud_exposed);
    let matched = false;
    let closest = { aud: null, gen: null, exposed: null };
    for (const row of bucket) {
      const audOk     = claimAud === null || row.aud_pct === null || claimAud === row.aud_pct;
      const genOk     = claimGen === null || row.gen_pct === null || claimGen === row.gen_pct;
      const exposedOk = claimExposed === null || row.aud_exposed === null || claimExposed === row.aud_exposed;
      if (audOk && genOk && exposedOk) { matched = true; break; }
      if (!audOk     && closest.aud     === null) closest.aud     = { claim: claimAud, allowlist: row.aud_pct };
      if (!genOk     && closest.gen     === null) closest.gen     = { claim: claimGen, allowlist: row.gen_pct };
      if (!exposedOk && closest.exposed === null) closest.exposed = { claim: claimExposed, allowlist: row.aud_exposed };
    }
    if (!matched) {
      if (closest.aud) {
        failures.push({
          claim: { question: m.question, item_name: m.item_name, aud_pct: m.aud_pct },
          reason: 'audience_selects_aud_pct_mismatch',
          detail: closest.aud,
        });
      } else if (closest.gen) {
        failures.push({
          claim: { question: m.question, item_name: m.item_name, gen_pct: m.gen_pct },
          reason: 'audience_selects_gen_pct_mismatch',
          detail: closest.gen,
        });
      } else if (closest.exposed) {
        failures.push({
          claim: { question: m.question, item_name: m.item_name, aud_exposed: m.aud_exposed },
          reason: 'audience_selects_aud_exposed_mismatch',
          detail: closest.exposed,
        });
      }
    }
  }
  return failures;
}

/**
 * Audience_distributions guard. Every claim must appear in a
 * bjl_audience_distributions_v2 row keyed on the (item_name, set_name,
 * answer) triple. All three parts of the key are mandatory on the claim
 * — set_name in particular, because one item can carry two scales from
 * different waves and shares are only comparable within a set. Numeric
 * checks: aud_pct / gen_pct / gap_pts to one decimal, aud_n exact.
 */
function runAudienceDistributionsGuard({ audience_distributions, scratch }) {
  const failures = [];
  const list = Array.isArray(audience_distributions) ? audience_distributions : [];
  if (list.length === 0) return failures;

  const byKey = buildAudienceDistributionsAllowlist(scratch);
  if (byKey.size === 0) {
    failures.push({
      claim: null,
      reason: 'no_audience_distributions_rows_in_scratch',
      detail: 'audience_distributions was populated but bjl_audience_distributions_v2 did not run this turn',
    });
    return failures;
  }

  for (const m of list) {
    if (!m || typeof m !== 'object' || typeof m.item_name !== 'string') {
      failures.push({ claim: m, reason: 'malformed_audience_distributions_entry' });
      continue;
    }
    if (typeof m.set_name !== 'string' || !m.set_name.trim()) {
      failures.push({
        claim: { item_name: m.item_name, answer: m.answer },
        reason: 'audience_distributions_missing_set_name',
      });
      continue;
    }
    if (typeof m.answer !== 'string' || !m.answer.trim()) {
      failures.push({
        claim: { item_name: m.item_name, set_name: m.set_name },
        reason: 'audience_distributions_missing_answer',
      });
      continue;
    }
    const key = `${normalizeItemName(m.item_name)}|${normalizeItemName(m.set_name)}|${normalizeItemName(m.answer)}`;
    const bucket = byKey.get(key);
    if (!bucket || bucket.length === 0) {
      failures.push({
        claim: { item_name: m.item_name, set_name: m.set_name, answer: m.answer },
        reason: 'audience_distributions_row_not_in_allowlist',
      });
      continue;
    }
    const claimAud  = m.aud_pct == null ? null : Math.round(Number(m.aud_pct) * 10) / 10;
    const claimGen  = m.gen_pct == null ? null : Math.round(Number(m.gen_pct) * 10) / 10;
    const claimGap  = m.gap_pts == null ? null : Math.round(Number(m.gap_pts) * 10) / 10;
    const claimN    = toInt(m.aud_n);
    let matched = false;
    let closest = { aud: null, gen: null, gap: null, n: null };
    for (const row of bucket) {
      const audOk = claimAud === null || row.aud_pct === null || claimAud === row.aud_pct;
      const genOk = claimGen === null || row.gen_pct === null || claimGen === row.gen_pct;
      const gapOk = claimGap === null || row.gap_pts === null || claimGap === row.gap_pts;
      const nOk   = claimN === null || row.aud_n === null || claimN === row.aud_n;
      if (audOk && genOk && gapOk && nOk) { matched = true; break; }
      if (!audOk && closest.aud === null) closest.aud = { claim: claimAud, allowlist: row.aud_pct };
      if (!genOk && closest.gen === null) closest.gen = { claim: claimGen, allowlist: row.gen_pct };
      if (!gapOk && closest.gap === null) closest.gap = { claim: claimGap, allowlist: row.gap_pts };
      if (!nOk   && closest.n   === null) closest.n   = { claim: claimN, allowlist: row.aud_n };
    }
    if (!matched) {
      const baseClaim = { item_name: m.item_name, set_name: m.set_name, answer: m.answer };
      if (closest.aud) {
        failures.push({ claim: Object.assign({}, baseClaim, { aud_pct: m.aud_pct }), reason: 'audience_distributions_aud_pct_mismatch', detail: closest.aud });
      } else if (closest.gen) {
        failures.push({ claim: Object.assign({}, baseClaim, { gen_pct: m.gen_pct }), reason: 'audience_distributions_gen_pct_mismatch', detail: closest.gen });
      } else if (closest.gap) {
        failures.push({ claim: Object.assign({}, baseClaim, { gap_pts: m.gap_pts }), reason: 'audience_distributions_gap_pts_mismatch', detail: closest.gap });
      } else if (closest.n) {
        failures.push({ claim: Object.assign({}, baseClaim, { aud_n: m.aud_n }), reason: 'audience_distributions_aud_n_mismatch', detail: closest.n });
      }
    }
  }
  return failures;
}

/**
 * Which cohort a card's stat_item claims, and which rows it may seat on.
 *
 * This is the connective_read axis latch, applied to cards. It is factored out
 * rather than reimplemented because the two surfaces have to agree: a figure
 * that cannot be attributed on one is not attributable on the other, and two
 * copies of this reasoning would drift into two different answers to the same
 * question.
 *
 * Cards ran without it until 2026-08-25. runCardsGuard matched on score, n,
 * source and construct and never looked at the cohort, so a bucket holding
 * every generation's row cleared any of those numbers presented as the item's
 * number. Measured against live saved cards: 5 of 191 stat_items resolve to a
 * cut row, and one of them cites Gen Z's 72.2 (n=129) under the headline
 * "consistent across all generations" while the pooled figure is 71.5
 * (n=1,245). Every number in it is real. It passed clean.
 *
 * The claim is matched against the cohort values the ROWS carried rather than
 * parsed out of the claim, which is what lets a compound cohort be written any
 * way the model likes without a separator convention to get wrong.
 *
 * A cohort is only read off the stat_item itself -- its `cohort` field, an
 * axis field on it, or an item_name that IS a cohort value. Deliberately not
 * off the card's headline or `why`: the stat_item is the thing that carries
 * the number and the thing the ledger stores, and a cohort mentioned in
 * neighbouring prose does not bind to this figure. Prose saying "Gen Z" beside
 * a pooled number is the failure, not the fix for it.
 */
function cardCohortSeating(bucket, s) {
  // Pinned cohorts count as values the rows carried. They are not printed on
  // the row, but they are true of every row the query returned. See
  // pinnedAxesInSql.
  const rowCohorts = r => Object.values(r.axis || {})
    .concat(Object.values(r.pinned_axes || {}));
  const known = Array.from(new Set(bucket.flatMap(rowCohorts)));

  const claimParts = [];
  const declared = s.cohort;
  if (Array.isArray(declared)) {
    claimParts.push(...declared.filter(x => typeof x === 'string'));
  } else if (typeof declared === 'string') {
    claimParts.push(declared);
  } else if (declared && typeof declared === 'object') {
    for (const v of Object.values(declared)) if (typeof v === 'string') claimParts.push(v);
  }
  for (const f of AXIS_FIELDS) if (typeof s[f] === 'string') claimParts.push(s[f]);
  const claimNamed = claimParts.map(normalizeItemName).filter(Boolean);

  const claimAxes = new Set(matchAxisValues(known, claimNamed.join(' | ')));
  // A cohort named in item_name rather than in a field said the thing; the
  // field it said it in does not matter.
  const itemKey = normalizeItemName(s.item_name);
  if (!claimAxes.size && known.includes(itemKey)) claimAxes.add(itemKey);

  // Rows whose cohort was written into a column NAME carry no value to match,
  // so they would read as un-cut and clear a claim that names no cohort.
  // Dropped before the match rather than after it, so nothing seats on a row
  // whose attribution cannot be verified. See pivotAxesInSql.
  const seatable = bucket.filter(r => !(r.pivot_axes && r.pivot_axes.length));

  // A row backs the claim only when the claim names EVERY cut the row sits in.
  // One dimension is not enough on a two-way cut: the Millennial x $200k+ cell
  // is not "Millennials". Rows outside any cut need no cohort and accept none,
  // which is the half that makes a subpopulation figure fail when it is
  // presented as a whole-population one.
  const candidates = seatable.filter(r => {
    const vals = rowCohorts(r);
    if (!vals.length) return claimAxes.size === 0;
    return claimAxes.size > 0 && vals.every(v => claimAxes.has(v));
  });

  return { known, claimAxes, claimNamed, seatable, candidates };
}

/**
 * The cohort each surviving stat_item is actually true of, read off the row
 * the guard matched it to.
 *
 * Not asked of the model. The cohort comes from the same row whose score and n
 * were verified, so recording it extends no trust that the provenance check
 * did not already establish. This is what fills bjl_session_figures.cohort;
 * without it that column is uniformly NULL, and a NULL cohort reads as "true
 * of everyone" -- which is precisely the misattribution the ledger exists to
 * make checkable, written down and vouched for by the ledger's own structure.
 *
 * Returns one entry per stat_item that seats on a row, with cohort null when
 * the matched row is genuinely un-cut. A stat_item that seats on nothing is
 * omitted rather than recorded with an unknown cohort.
 */
function resolveCardCohorts({ cards, scratch }) {
  const out = [];
  const list = Array.isArray(cards) ? cards : [];
  if (list.length === 0) return out;
  const itemIndex = buildCardAllowlist(scratch);
  if (itemIndex.size === 0) return out;

  for (let ci = 0; ci < list.length; ci++) {
    const card = list[ci];
    const statItems = Array.isArray(card && card.stat_items) ? card.stat_items : [];
    for (let si = 0; si < statItems.length; si++) {
      const s = statItems[si];
      if (!s || typeof s !== 'object' || typeof s.item_name !== 'string') continue;
      const bucket = itemIndex.get(normalizeItemName(s.item_name));
      if (!bucket || bucket.length === 0) continue;

      const { candidates } = cardCohortSeating(bucket, s);
      const claimJoy       = roundJoy(s.score != null ? s.score : s.joy_index);
      const claimN         = toInt(s.n);
      const claimSource    = typeof s.source === 'string' ? s.source.toLowerCase() : null;
      const claimConstruct = typeof s.construct === 'string' ? s.construct.toLowerCase() : null;

      const row = candidates.find(r => {
        const nums        = rowCarriesNumbers(r, claimJoy, claimN);
        const sourceOk    = claimSource === null || claimSource === r.source;
        const constructOk = claimConstruct === null || r.construct === null
                         || claimConstruct === (r.construct || '').toLowerCase();
        return nums.ok && sourceOk && constructOk;
      });
      if (!row) continue;

      const cohort = Object.assign({}, row.axis || {}, row.pinned_axes || {});
      out.push({
        card_index: ci,
        stat_index: si,
        cohort: Object.keys(cohort).length ? cohort : null,
      });
    }
  }
  return out;
}

/**
 * Card provenance guard. Applies the four checks (item, joy_index, n, source)
 * to each stat_item, plus the cohort latch above, and enforces the
 * single-source rule (all stat_items in one card share a source). Returns a
 * bare failures array; the unified guard tags them with surface='cards'.
 */
function runCardsGuard({ cards, scratch }) {
  const failures = [];
  const list = Array.isArray(cards) ? cards : [];
  if (list.length === 0) return failures;

  const itemIndex = buildCardAllowlist(scratch);

  // No allowlist rows at all. Any card is off-source.
  if (itemIndex.size === 0) {
    failures.push({
      claim: null,
      reason: 'no_scratch_rows_for_cards',
      detail: 'cards was populated but the scratch has no queryable rows to ground them in',
    });
    return failures;
  }

  for (let ci = 0; ci < list.length; ci++) {
    const card = list[ci];
    if (!card || typeof card !== 'object') {
      failures.push({ claim: { card_index: ci }, reason: 'malformed_card' });
      continue;
    }
    const statItems = Array.isArray(card.stat_items) ? card.stat_items : [];
    if (statItems.length === 0) {
      failures.push({
        claim: { card_index: ci, headline: card.headline },
        reason: 'card_has_no_stat_items',
      });
      continue;
    }

    const seenSources    = new Set();
    const seenConstructs = new Set();
    for (let si = 0; si < statItems.length; si++) {
      const s = statItems[si];
      if (!s || typeof s !== 'object' || typeof s.item_name !== 'string') {
        failures.push({
          claim: { card_index: ci, stat_index: si, headline: card.headline },
          reason: 'malformed_stat_item',
        });
        continue;
      }

      const key = normalizeItemName(s.item_name);
      const bucket = itemIndex.get(key);
      if (!bucket || bucket.length === 0) {
        failures.push({
          claim: { card_index: ci, item_name: s.item_name, headline: card.headline },
          reason: 'card_item_not_in_allowlist',
        });
        continue;
      }

      // Which rows this stat_item is allowed to seat on, once the cohort is
      // taken into account. Applied BEFORE the number match, so a figure can
      // never be authorized by a row belonging to a cohort the card does not
      // name. See cardCohortSeating.
      const seat = cardCohortSeating(bucket, s);
      if (seat.candidates.length === 0) {
        const baseCohortClaim = { card_index: ci, item_name: s.item_name, score: s.score, n: s.n };

        // Every row for this item came back from a pivot. There is no cohort
        // to check against and no honest way to invent one, so the rejection
        // names the shape and asks for the cut instead.
        if (seat.seatable.length === 0) {
          const axes = Array.from(new Set(bucket.flatMap(r => r.pivot_axes || [])));
          failures.push({
            claim: baseCohortClaim,
            reason: 'card_cohort_in_column_name',
            detail: 'The query that returned this row put ' + axes.join(', ')
                  + ' in the column NAMES (a FILTER or CASE pivot), so each row holds several '
                  + 'cohorts side by side and no returned value says which cohort it belongs to. '
                  + 'A cohort claim on such a row cannot be checked, so it is not accepted. '
                  + 'Re-run the cut as GROUP BY ' + axes.join(', ')
                  + ' so each cohort is its own row, and cite that row.',
            pivot_axes: axes,
          });
          continue;
        }

        // Every seatable row came from a query pinned to one cohort in its
        // WHERE clause, and the card did not name that cohort.
        const pinnedOnly = seat.seatable.every(r =>
          !Object.values(r.axis || {}).length
          && Object.keys(r.pinned_axes || {}).length);
        if (pinnedOnly) {
          const pins = {};
          for (const r of seat.seatable) Object.assign(pins, r.pinned_axes || {});
          const cols = Object.keys(pins);
          failures.push({
            claim: baseCohortClaim,
            reason: 'card_cohort_pinned_in_filter',
            detail: 'The query that returned this row filtered its WHERE clause to '
                  + cols.map(c => c + ' = ' + pins[c]).join(', ')
                  + ', so every number it returned is that cohort\'s and no returned value '
                  + 'says so. This card either names no cohort -- reporting a subpopulation '
                  + 'figure as if it were the whole population -- or names a different one. '
                  + 'Either re-run as GROUP BY ' + cols.join(', ')
                  + ' with the filter dropped, or set cohort on this stat_item to '
                  + cols.map(c => pins[c]).join(' / ') + ' so the claim matches the filter.',
            pinned_axes: pins,
          });
          continue;
        }

        // An invented cohort must stay distinguishable from no cohort at all,
        // and naming one dimension of a two-way cell from naming none.
        const underSpecified = seat.claimAxes.size > 0 && bucket.some(r => {
          const vals = Object.values(r.axis || {});
          return vals.length > seat.claimAxes.size && vals.some(v => seat.claimAxes.has(v));
        });
        const axisShown = seat.claimAxes.size ? Array.from(seat.claimAxes)
                        : seat.claimNamed.length ? seat.claimNamed
                        : null;
        failures.push({
          claim: Object.assign({}, baseCohortClaim, { cohort: axisShown }),
          reason: (!seat.claimAxes.size && !seat.claimNamed.length) ? 'card_cohort_unspecified'
                : underSpecified ? 'card_cohort_underspecified'
                : 'card_cohort_not_in_allowlist',
          detail: (!seat.claimAxes.size && !seat.claimNamed.length)
            ? 'Every returned row for this item belongs to a cut, so this figure is one '
              + 'cohort\'s and the card presents it as the item\'s. Set cohort on this '
              + 'stat_item to the cohort the number came from, or cite a pooled row.'
            : underSpecified
            ? 'These rows are cut on more than one dimension. Name every cohort the cell '
              + 'belongs to, not just one: a generation-by-income cell is not a claim about '
              + 'the generation.'
            : 'No returned row for this item carries that cohort.',
          cohorts_available: Array.from(new Set(
            bucket.map(r => Object.values(r.axis || {}).join(' + ')).filter(Boolean)
          )).slice(0, 16),
        });
        continue;
      }

      // Accept `score` (v2 shape) as an alias for `joy_index` (v1/legacy).
      const claimScoreRaw  = s.score != null ? s.score : s.joy_index;
      const claimJoy       = roundJoy(claimScoreRaw);
      const claimN         = toInt(s.n);
      const claimSource    = typeof s.source === 'string' ? s.source.toLowerCase() : null;
      const claimConstruct = typeof s.construct === 'string' ? s.construct.toLowerCase() : null;
      if (claimSource)    seenSources.add(claimSource);
      if (claimConstruct) seenConstructs.add(claimConstruct);

      // A row matches when the score, n, and source all agree. Construct
      // must match too when both sides provide one (bjl_scores rows have
      // no construct; v2 rows do). Multiple rows can exist per item;
      // accept the stat item if any row agrees.
      //
      // The numbers are matched same-row, any-column. Reading them from
      // named columns meant an aliased score column parsed to null, and the
      // null was treated as agreement -- so the score check silently stopped
      // running on any row whose SQL did not spell the column `score`.
      let matched = false;
      // Whether ANY row in the bucket satisfied each dimension on its own. An
      // item can legitimately have several rows, so a row that failed on the
      // score is not evidence the score is wrong when a different row carried
      // it. Attributing the failure to a dimension no row satisfied keeps the
      // reported reason pointed at the thing that is actually wrong, which
      // matters because the reason is what a retry is sent after.
      let anyNums = false, anySource = false, anyConstruct = false;
      let closest = { joy: null, n: null, source: null, construct: null };
      for (const row of seat.candidates) {
        const nums        = rowCarriesNumbers(row, claimJoy, claimN);
        const sourceOk    = claimSource === null || claimSource === row.source;
        const constructOk = claimConstruct === null || row.construct === null || claimConstruct === (row.construct || '').toLowerCase();
        if (nums.ok && sourceOk && constructOk) { matched = true; break; }
        if (nums.ok)     anyNums = true;
        if (sourceOk)    anySource = true;
        if (constructOk) anyConstruct = true;
        const rowNums = (row.values || []).map(v => v.field + '=' + v.num).join(', ');
        if (!nums.joyFound && closest.joy       === null) closest.joy       = { claim: claimJoy, row_numbers: rowNums };
        if (!nums.nFound   && closest.n         === null) closest.n         = { claim: claimN, row_numbers: rowNums };
        // Both numbers appear but only as the same single field, so the row
        // cannot supply a distinct score and n. Report it against the score.
        if (nums.joyFound && nums.nFound && !nums.ok && closest.joy === null) {
          closest.joy = { claim: claimJoy, row_numbers: rowNums, note: 'score and n resolve to the same field' };
        }
        if (!sourceOk    && closest.source    === null) closest.source    = { claim: claimSource, allowlist: row.source };
        if (!constructOk && closest.construct === null) closest.construct = { claim: claimConstruct, allowlist: row.construct };
      }
      if (!matched) {
        const baseClaim = { card_index: ci, item_name: s.item_name };

        // Before blaming a number: do these numbers sit, exactly, on a row
        // this claim was NOT allowed to seat on for cohort reasons? Then the
        // figure is real and its attribution is what is wrong, and saying
        // "score mismatch" would send a retry to change a correct number.
        // This is the live shape -- a Gen Z figure cited as the item's, where
        // a pooled row for the same item also exists, so `candidates` is
        // non-empty and the cohort latch above never fires.
        const excluded = seat.seatable.filter(r => !seat.candidates.includes(r));
        const offCohort = excluded.find(r => {
          const nums        = rowCarriesNumbers(r, claimJoy, claimN);
          const sourceOk    = claimSource === null || claimSource === r.source;
          const constructOk = claimConstruct === null || r.construct === null
                           || claimConstruct === (r.construct || '').toLowerCase();
          return nums.ok && sourceOk && constructOk;
        });
        if (offCohort) {
          const rowCohort = Object.assign({}, offCohort.axis || {}, offCohort.pinned_axes || {});
          failures.push({
            claim: Object.assign({}, baseClaim, {
              score: claimScoreRaw, n: s.n,
              cohort: seat.claimAxes.size ? Array.from(seat.claimAxes) : null,
            }),
            reason: seat.claimAxes.size ? 'card_cohort_mismatch' : 'card_cohort_unspecified',
            detail: 'These numbers are real, and they belong to '
                  + Object.entries(rowCohort).map(([k, v]) => k + ' = ' + v).join(', ')
                  + '. The card '
                  + (seat.claimAxes.size
                      ? 'attributes them to ' + Array.from(seat.claimAxes).join(' / ') + ' instead.'
                      : 'names no cohort, so it reports one cohort\'s figure as the item\'s.')
                  + ' Set cohort on this stat_item to the cohort the number came from, or cite '
                  + 'the pooled row instead.',
            row_cohort: rowCohort,
          });
          continue;
        }

        if (!anyNums && closest.joy) {
          failures.push({
            claim: Object.assign({}, baseClaim, { score: claimScoreRaw }),
            reason: 'card_score_mismatch',
            detail: closest.joy,
          });
        } else if (!anyNums && closest.n) {
          failures.push({
            claim: Object.assign({}, baseClaim, { n: s.n }),
            reason: 'card_n_mismatch',
            detail: closest.n,
          });
        } else if (!anySource && closest.source) {
          failures.push({
            claim: Object.assign({}, baseClaim, { source: s.source }),
            reason: 'card_source_mismatch',
            detail: closest.source,
          });
        } else if (!anyConstruct && closest.construct) {
          failures.push({
            claim: Object.assign({}, baseClaim, { construct: s.construct }),
            reason: 'card_construct_mismatch',
            detail: closest.construct,
          });
        } else {
          // Every dimension was satisfied by some row, but never by one row
          // together. That is a claim assembled out of parts of several rows,
          // which is exactly what same-row matching exists to catch, and it
          // deserves its own name rather than being filed under whichever
          // single field happened to be checked first.
          failures.push({
            claim: Object.assign({}, baseClaim, { score: claimScoreRaw, n: s.n, source: s.source }),
            reason: 'card_no_single_row_match',
            detail: seat.candidates.slice(0, 4).map(row => ({
              source: row.source,
              numbers: (row.values || []).map(v => v.field + '=' + v.num).join(', '),
            })),
          });
        }
      }
    }

    // Single-source rule: all stat_items in one card share a source.
    if (seenSources.size > 1) {
      failures.push({
        claim: { card_index: ci, headline: card.headline, sources: Array.from(seenSources) },
        reason: 'card_mixed_sources',
      });
    }

    // Same-construct rule: all stat_items in one card share a construct
    // when they carry one. Cards mixing constructs put two centered
    // scales on the same axis, which is meaningless.
    if (seenConstructs.size > 1) {
      failures.push({
        claim: { card_index: ci, headline: card.headline, constructs: Array.from(seenConstructs) },
        reason: 'card_mixed_constructs',
      });
    }
  }

  return failures;
}

// ---------------------------------------------------------------------------
// Comparative and superlative claims.
//
// The frame pass's first verified read said "the largest gap across all 14
// modes is playful ... a 34-point spread". Every number in it was real and
// traced to a row. Playful's gap really is 34. The read was still false:
// hedonic's gap is 39.8. The ORDERING was the lie, and no amount of number
// checking reaches it, because 34 is a true number.
//
// This is structural rather than incidental. The around-the-corner insight the
// tool exists to produce IS a superlative -- "the surprising thing is that X
// matters most" is the shape of nearly every read worth having. So the tool's
// most valuable output and its most dangerous failure are the same sentence,
// and they are not separable by checking numerals. Only recomputing the
// ordering separates them.
//
// So a comparative claim must carry the whole set it ranks over, and the guard
// does the ranking itself. "Largest of 14" requires all 14 members present;
// the guard confirms the named one is actually the maximum, or the claim
// cannot be made. When the set cannot be carried, the fallback is to downgrade
// to a non-comparative statement -- say the smaller true thing rather than
// assert an unbacked ranking.
//
// THE BOUNDARY, stated because it is real and this guard does not reach past
// it: orderings can only be checked over rows that came back. This verifies
// "largest of these 14 gathered modes". It cannot verify "the strongest
// divergence in the corpus" when the corpus was never scanned. A comparative
// claim over an ungathered set is forbidden by the prompt, not by this code,
// and past that line only a hand-read catches it.
// ---------------------------------------------------------------------------

// Wording that asserts a relationship between quantities rather than reporting
// one. Deliberately wide: an over-trigger costs a downgrade to a plainer true
// sentence, an under-trigger ships an unchecked ranking. Relational words like
// `identical` and `parity` are in here on purpose -- calling 67.4 and 70.1
// "parity" is a claim about a relationship the numbers do not support, and it
// deserves exactly the scrutiny "largest" gets.
const COMPARATIVE_TERMS = [
  'largest', 'biggest', 'smallest', 'highest', 'lowest', 'greatest', 'strongest',
  'weakest', 'widest', 'narrowest', 'steepest', 'sharpest', 'maximum', 'minimum',
  'most', 'least', 'top', 'peak', 'no other', 'nothing else', 'above all',
  'larger', 'bigger', 'smaller', 'higher', 'lower', 'greater', 'stronger',
  'weaker', 'wider', 'narrower', 'steeper', 'sharper',
  'more than', 'less than', 'fewer than', 'outpaces', 'outstrips', 'outperforms',
  'dominates', 'dwarfs', 'double', 'triple', 'twice', 'half as',
  'identical', 'parity', 'indistinguishable', 'on par', 'equally', 'the same as',
  'as high as', 'as low as', 'matched', 'flat across', 'no difference',
  // Plain ordering wording. "Boomers score 32.4, below Gen Z's 61.5" ranks
  // two quantities without reaching for a comparative adjective, and the
  // ordering it asserts is checkable in exactly the way `greater` is.
  'below', 'above', 'under', 'over', 'ahead of', 'behind', 'trails', 'leads',
];
const COMPARATIVE_RE = new RegExp('\\b(' + COMPARATIVE_TERMS.join('|') + ')\\b', 'i');

// Wording that asserts a DISTANCE rather than an order: "a 34-point
// difference", "28.5 points apart". Split out from the list above because the
// two need different things behind them, and conflating them would break the
// downgrade the comparison rule depends on.
//
// A ranking needs its whole set -- nothing smaller can check "the largest".
// A distance needs one subtraction, and a two-operand `figures` entry carries
// exactly that. Demanding a full comparison object for "a 34-point
// difference" would push the model back toward the ranking it was just told
// to drop, which is the over-strict half of the defect this work exists to
// end.
const DIFFERENCE_TERMS = [
  'points apart', 'points off', 'point difference', 'point gap', 'point spread',
  'separated by', 'the difference between', 'differ by', 'apart',
];
const DIFFERENCE_RE = new RegExp('\\b(' + DIFFERENCE_TERMS.join('|') + ')\\b', 'i');

// `rank` and `top` exist because "the largest" is not the only ordering a real
// read makes. The first live run under this check produced two true claims --
// "ranked second in both distributions" and "the one job that lands in the top
// three for both" -- that max/min could not express, so the model forced them
// into a shape that did not fit and the guard rejected them for the wrong
// reason. A guard that leaves a true claim no legal form is the over-strict
// half of the defect this whole line of work exists to end.
const COMPARISON_DIRECTIONS = new Set(['max', 'min', 'rank', 'top', 'greater', 'less', 'equal']);

// Every returned SELECT, with each row's numeric surface precomputed. A
// comparison's set has to live inside ONE of these results: that is what makes
// "the whole set" a checkable statement rather than an assertion.
function collectQueryResults(scratch) {
  const out = [];
  for (const entry of (Array.isArray(scratch) ? scratch : [])) {
    if (!entry || typeof entry !== 'object' || entry.type !== 'query') continue;
    // A pivot result is not a seat. Its rows hold several cohorts' numbers
    // side by side under aliased column names, so seating a member or a figure
    // on one proves the number was returned and nothing about whose it is --
    // and a cohort swap between two columns of the same row does not reject.
    // Withheld here rather than checked downstream, so all three arithmetic
    // latches inherit the same rule from one place. See pivotAxesInSql.
    if (pivotAxesInSql(entry.query).length) continue;
    const rows = (Array.isArray(entry.result) ? entry.result : [])
      .filter(r => r && typeof r === 'object')
      .map(r => ({ raw: r, values: numericFields(r) }));
    if (rows.length) out.push({ query: typeof entry.query === 'string' ? entry.query : '', rows });
  }
  return out;
}

// Does one row carry all of these numbers, in distinct fields? Distinct so a
// single column cannot supply both halves of a difference -- the same
// anti-splice property rowCarriesNumbers enforces, applied to set members.
// Greedy assignment, which can only ever be stricter than optimal, and strict
// is the safe direction here.
function rowCarriesValues(row, nums) {
  const used = new Set();
  for (const x of nums) {
    const target = roundJoy(x);
    const hit = (row.values || []).find(v => !used.has(v.field) && roundJoy(v.num) === target);
    if (!hit) return false;
    used.add(hit.field);
  }
  return true;
}

// Dates carry digits that are not quantities. Masked before anything else so
// the scanner never sees the halves of one as two separate numbers.
const DATE_SHAPED = /\b\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?\b/g;

// Every numeral a piece of prose actually CLAIMS, as numbers.
//
// The naive reading of this is /\d+(\.\d+)?/g, and it was wrong in a way that
// failed closed on truth. A live run (2436bad7) stated a true, correctly
// attributed 9.4-point parental gap "in the 2026-08 wave" and was dropped,
// because the scanner pulled 2026 and 8 out of the date and demanded the read
// cite them as figures. They are not quantities; there is no row to cite.
//
// The class is wider than dates. Digits appear in labels all over this data --
// item names like '365 by Whole Foods Market' and '30A, Florida', wave labels,
// question ids like q146 -- and none of them are arithmetic. A numeral is a
// claim only when it stands as its own numeric token:
//
//   - a digit run touching a letter is part of an identifier, not a quantity
//     ('30A', 'q146'), so it is not a claim;
//   - a date-shaped token is a label, not two numbers;
//   - comma grouping is read as one number, so '200,000' is 200000 rather
//     than a 200 and a 000 that no row could ever account for.
//
// This is a scope correction, not a loosening. Every standalone numeral is
// still checked exactly as before, and a fabricated figure is standalone by
// construction -- a made-up gap is written "28.5", not welded into a word.
// Nothing that was caught before stops being caught.
function proseNumerals(text, labels) {
  let s = String(text || '').replace(DATE_SHAPED, m => ' '.repeat(m.length));

  // Labels the read is entitled to name. Their digits belong to the name, not
  // to any claim: an item called '365 by Whole Foods Market' has no row
  // carrying 365, so scanning it would demand provenance for a word. Masked
  // longest-first so a short label cannot eat part of a longer one.
  for (const label of (labels || []).slice().sort((a, b) => b.length - a.length)) {
    if (!label || label.length < 2) continue;
    let at = s.toLowerCase().indexOf(label.toLowerCase());
    while (at >= 0) {
      s = s.slice(0, at) + ' '.repeat(label.length) + s.slice(at + label.length);
      at = s.toLowerCase().indexOf(label.toLowerCase(), at + label.length);
    }
  }

  const out = new Set();
  const isAlnum = ch => /[A-Za-z0-9]/.test(ch || '');
  for (const m of s.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    let text_ = m[0];
    let start = m.index;
    // A hyphen between two digits is a separator, not a sign: in '50-75' the
    // second number is 75, not -75. A leading minus anywhere else is the sign
    // of a real value -- joy indices go negative, and dropping the sign would
    // let a claimed -20.0 pass as a checked 20.0.
    if (text_[0] === '-' && isAlnum(s[start - 1])) { text_ = text_.slice(1); start += 1; }
    if (isAlnum(s[start - 1])) continue;
    if (isAlnum(s[start + text_.length])) continue;
    const clean = text_.replace(/,/g, '').replace(/\.$/, '');
    const n = Number(clean);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

// The labels a read may name without owing a number for their digits: the
// items it cited and the cohorts it attributed them to.
function proseLabels(evidence) {
  const out = [];
  for (const e of (Array.isArray(evidence) ? evidence : [])) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.item_name === 'string') out.push(e.item_name);
    if (Array.isArray(e.axis)) out.push(...e.axis.filter(a => typeof a === 'string'));
    else if (typeof e.axis === 'string') out.push(e.axis);
    for (const f of AXIS_FIELDS) if (typeof e[f] === 'string') out.push(e[f]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The prose is the claim.
//
// Everything above checks the numbers the read HANDS the guard. The read also
// states numbers it never hands over, and those reached the reader unchecked.
//
// A passing live run said: "Boomers score 32.4 (n=816) -- 28.5 points below
// Gen Z's 61.5 (n=522)". Every cited row verified. 61.5 - 32.4 is 29.1. The
// same read then called it "the 29-point generational gap", contradicting
// itself two sentences on. Nothing caught it, because 28.5 was never declared
// anywhere the guard could see it -- the model performed the subtraction in
// the sentence and only the sentence.
//
// So: every numeral in the read must be accounted for. A number is accounted
// for when it is one the read itself declared, or a plain difference between
// two it declared -- the exact arithmetic the prompt licenses and no more.
// An integer restatement of either is allowed, because "the 29-point gap" for
// 29.1 is a display convention rather than a different claim.
//
// Deliberately NOT accounted for: any number merely present somewhere in the
// returned rows. Thousands of values come back on a wide run, and admitting
// all of them would let a fabricated gap clear by coincidence -- which is the
// precise failure mode this exists to stop. If the read wants to say a number,
// it has to cite the row it came from.
//
// This is a latch and it will occasionally cost a true sentence: a read that
// mentions "14 modes" without citing them gets rejected. That is the intended
// direction. The remedy is to cite the row or drop the numeral, both of which
// are always available, and the prompt says so.
// ---------------------------------------------------------------------------
function declaredNumbers(evidence, comparisons, figures) {
  const out = new Set();
  const add = (x) => {
    const n = Number(x);
    if (Number.isFinite(n)) out.add(roundJoy(n));
  };

  for (const e of (Array.isArray(evidence) ? evidence : [])) {
    if (!e || typeof e !== 'object') continue;
    if (e.score != null) add(e.score);
    if (e.joy_index != null) add(e.joy_index);
    if (e.n != null) add(e.n);
  }

  for (const f of (Array.isArray(figures) ? figures : [])) {
    if (!f || typeof f !== 'object') continue;
    if (f.value != null) add(f.value);
    for (const x of (Array.isArray(f.from) ? f.from : [])) add(x);
  }

  for (const c of (Array.isArray(comparisons) ? comparisons : [])) {
    if (!c || typeof c !== 'object') continue;
    for (const m of (Array.isArray(c.set) ? c.set : [])) {
      if (!m || typeof m !== 'object') continue;
      if (m.value != null) add(m.value);
      for (const f of (Array.isArray(m.from) ? m.from : [])) add(f);
    }
    const basis = Array.isArray(c.basis_n) ? c.basis_n
                : (c.basis_n == null ? [] : [c.basis_n]);
    for (const b of basis) add(b);
  }

  return out;
}

/**
 * `figures`: numbers the read states without asserting a relationship.
 *
 * This exists because the prose latch would otherwise close the escape hatch
 * the comparison rule leans on. The prompt's whole fallback is "drop the
 * comparative word and say the smaller true thing" -- *"Playful separates
 * them by 34 points, 52% to 18%"* -- and those three numerals live on a mode
 * row that `evidence`, which carries item rows, has no shape for. Requiring
 * every stated number to be declared while leaving that sentence no legal
 * form would push the model back toward the comparison it was told to drop.
 *
 * A figure is a number plus where it came from. Same arithmetic license as a
 * comparison member and the same seating requirement -- so a two-operand
 * figure gets the exact difference check, which is the second place a
 * fabricated gap gets caught.
 */
// The rows the read already cited, each with the most precise value it
// carried. A figure whose operands come off two different rows may stand only
// on these.
//
// Why cited evidence and not any returned row: a wide run returns thousands of
// numbers, and on the live beer run 73.9 came back on BOTH 'Snacking at home'
// (n=252) and 'Taking a VACATION' (n=9892). Seating an operand against any row
// that happens to carry its value would let a figure labelled "snacking" stand
// on the vacation number -- a true number under a false label, the same shape
// as every other fabrication here. Evidence entries are already latched
// jointly on item, score and n, so drawing operands from them inherits that
// precision rather than re-deriving it.
//
// An evidence entry that does not seat contributes nothing, so a figure cannot
// borrow provenance from a row that failed its own check.
function evidenceSeats(evidence, results) {
  const seats = [];
  for (const e of (Array.isArray(evidence) ? evidence : [])) {
    if (!e || typeof e !== 'object') continue;
    const score = roundJoy(e.score != null ? e.score : e.joy_index);
    if (!Number.isFinite(score)) continue;
    const n = toInt(e.n);

    let seated = null;
    for (const res of (Array.isArray(results) ? results : [])) {
      for (const row of res.rows) {
        if (!rowCarriesNumbers(row, score, n).ok) continue;
        seated = { item_name: e.item_name, value: score, precise: preciseOnRow(row, score) };
        break;
      }
      if (seated) break;
    }
    if (seated) seats.push(seated);
  }
  return seats;
}

function checkFigures(figures, results, evidence) {
  const failures = [];
  const list = Array.isArray(figures) ? figures : [];
  const seats = evidenceSeats(evidence, results);

  for (let fi = 0; fi < list.length; fi++) {
    const f = list[fi];
    const at = { figure_index: fi, label: (f && f.label) || null };
    const fail = (reason, detail) =>
      failures.push({ surface: 'connective_read', claim: at, reason, detail });

    if (!f || typeof f !== 'object' || typeof f.label !== 'string' || !f.label.trim()) {
      fail('malformed_figure', 'Every figure needs a label saying what the number is.');
      continue;
    }
    const resolved = comparisonMemberValue(f, results);
    if (!resolved) {
      fail('malformed_figure',
        'Figure ' + f.label + ': value must be a number, or `from` must hold one or two numbers.');
      continue;
    }
    // A gap between two items lives on two rows by construction, so the
    // same-row seating below cannot express it. Requiring it anyway left a
    // true cross-item gap no legal form at all -- declared as a figure it was
    // rejected here, left undeclared it was rejected as an uncarried
    // difference -- which killed the commonest shape a connective read takes.
    // Each operand seats on its own cited row, and the two must be different
    // rows, so one row can never supply both halves of its own difference.
    const crossSeated = [];
    if (resolved.from.length === 2) {
      const want = resolved.from.map(roundJoy);
      for (let a = 0; a < seats.length; a++) {
        if (seats[a].value !== want[0]) continue;
        for (let b = 0; b < seats.length; b++) {
          if (b === a || seats[b].value !== want[1]) continue;
          // Same `from` order as the same-row path above: seats[a] is from[0].
          crossSeated.push(roundDiff(seats[a].precise - seats[b].precise));
        }
      }
    }
    // Added before the derivability check so the unrounded cross-row
    // subtraction is one of the exact answers, on the same terms as the
    // same-row one: two computations, never a band between them.
    for (const v of crossSeated) resolved.accepts.add(v);

    // roundDiff, not roundJoy, so the stated value is normalised by the same
    // rule as the computed ones. roundJoy rounds a half toward +Infinity, so
    // mixing them would compare two magnitudes rounded different ways once the
    // values can be negative. Identical for anything non-negative.
    if (!resolved.accepts.has(roundDiff(f.value))) {
      fail('figure_value_not_derivable', {
        figure: f.label, stated: f.value, from: resolved.from,
        accepted: Array.from(resolved.accepts).sort((a, b) => a - b),
        note: 'A two-operand figure is `from[0]` minus `from[1]`, sign kept. If the '
            + 'accepted value has the opposite sign to yours, swap the two entries in '
            + '`from` so they run the way your label reads.',
      });
      continue;
    }
    const sameRow = (results || []).some(res => res.rows.some(row => rowCarriesValues(row, resolved.from)));
    if (!sameRow && !crossSeated.length) {
      fail('figure_not_in_rows', {
        figure: f.label, numbers: resolved.from,
        note: 'A figure must come off a returned row. Either one row carries all of '
            + 'these numbers, or -- for a gap between two items -- each number is the '
            + 'score of a row this read already cites in `evidence`. Cite both rows as '
            + 'evidence, or take the figure out.',
        cited_evidence_values: seats.map(s => s.value),
      });
    }
  }

  return failures;
}

function checkProseNumbers(readText, evidence, comparisons, figures) {
  const declared = declaredNumbers(evidence, comparisons, figures);
  if (!declared.size) return [];

  // Both directions of every pair, unlike the figure and comparison latches
  // above. There is no `from` here to carry an order: `declared` is a set, and
  // signing its pairs by iteration index would make the accepted number depend
  // on the order the read happened to list its evidence, which is not a claim
  // anyone made. Direction is latched where a label states one; this site only
  // asks whether a number in the prose is a real difference of real cited
  // numbers, and -9.5 and 9.5 are the same answer to that question.
  const list = Array.from(declared);
  const accounted = new Set(declared);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const d = roundDiff(list[i] - list[j]);
      accounted.add(d);
      accounted.add(-d);
    }
  }
  // An integer restatement of an accounted value is the same claim, said for
  // the reader. Added after the differences so "29" covers a 29.1 gap.
  for (const v of Array.from(accounted)) accounted.add(Math.round(v));

  const failures = [];
  for (const v of proseNumerals(readText, proseLabels(evidence))) {
    if (accounted.has(roundJoy(v))) continue;
    failures.push({
      surface: 'connective_read',
      claim: { number: v, read: String(readText).slice(0, 200) },
      reason: 'prose_number_unaccounted',
      detail: {
        note: 'The read states this number but never cites it. It is not one of the '
            + 'numbers carried in evidence, figures or comparisons, and it is not a '
            + 'difference between two of them. Add a `figures` entry naming the row it '
            + 'came from, or take the number out of the read.',
        nearest_declared_differences: Array.from(accounted)
          .filter(x => Math.abs(x - v) <= 2 && x !== v)
          .sort((a, b) => Math.abs(a - v) - Math.abs(b - v))
          .slice(0, 4),
      },
    });
  }
  return failures;
}

function decimalPlaces(x) {
  const s = String(x);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

// The most precise value on this row that rounds to `v`.
//
// A row that carries both `ji` 74.5 and `ji_raw` 74.5205 is carrying one
// number twice, once for the reader and once for arithmetic. Given the
// displayed 74.5 this returns 74.5205: the same measurement, unrounded.
// Returns `v` unchanged when the row carries no finer copy, which is what
// makes the caller fail closed rather than guess.
function preciseOnRow(row, v) {
  let best = v;
  for (const f of (row.values || [])) {
    if (roundJoy(f.num) !== roundJoy(v)) continue;
    if (decimalPlaces(f.num) > decimalPlaces(best)) best = f.num;
  }
  return best;
}

// A member's value is either read straight off a row or is the plain
// difference between two numbers read off one row. That is the same arithmetic
// the read itself is licensed to do, and no more: no ratios, no modelled
// figures, no shares of a population nobody counted.
//
// Two exact computations are accepted, never a band between them:
//
//   1. The difference of the operands AS CITED, which are rounded for display.
//   2. The difference of the same two measurements UNROUNDED, recovered from
//      the row that carries both.
//
// They disagree by a tenth whenever the operands' rounding pushes them the
// same way: home cooking's real gap is 74.5205 - 65.8683 = 8.6522, which is
// 8.7, while the displayed 74.5 and 65.9 subtract to 8.6. Both are correct
// answers to slightly different questions, and a read that subtracts before
// rounding is right to say 8.7. Rejecting it cost a true read on a run where
// every number was correct.
//
// What is NOT accepted is anything between or around them. Each candidate is
// a real subtraction of two real returned values, so a fabricated gap cannot
// land inside the accepted set by being merely close -- it has to BE one of
// the two answers. When the investigator returns no unrounded copy there is
// only one candidate and the check is as tight as it ever was.
//
// Both subtractions run in `from` order: from[0] - from[1], sign kept. The
// order of `from` is therefore a claim, and it is checked like every other
// one. A gap labelled "retired minus full-time" off [62.6, 72.1] is -9.5, and
// stating it as 9.5 now fails -- which is the point. The sign says which way
// the gap runs, direction is the substance of a comparative read, and taking
// an absolute value meant the one guard whose job is direction was not
// checking it. There is no absolute-value fallback: a read that wants the
// positive number writes the operands the other way round and says so.
function comparisonMemberValue(m, results) {
  const from = (Array.isArray(m.from) && m.from.length) ? m.from : [m.value];
  const nums = from.map(Number);
  if (!nums.length || nums.some(x => !Number.isFinite(x))) return null;
  if (nums.length === 1) {
    const v = roundJoy(nums[0]);
    return { value: v, from: nums, accepts: new Set([v]) };
  }
  if (nums.length !== 2) return null;

  const v = roundDiff(nums[0] - nums[1]);
  const accepts = new Set([v]);

  for (const res of (Array.isArray(results) ? results : [])) {
    for (const row of res.rows) {
      if (!rowCarriesValues(row, nums)) continue;
      const a = preciseOnRow(row, nums[0]);
      const b = preciseOnRow(row, nums[1]);
      accepts.add(roundDiff(a - b));
    }
  }

  return { value: v, from: nums, accepts };
}

/**
 * Check one comparative claim against the returned rows.
 *
 * Four things have to hold, and they are ordered so a failure names the
 * earliest thing that broke rather than a downstream symptom:
 *
 *   1. The claim is quoted from the read, so the structured object cannot back
 *      a sentence the reader never sees.
 *   2. Every member's numbers came off a returned row, and each member stands
 *      on its OWN row.
 *   3. A superlative's set covers its home result completely. A set that ranks
 *      three of fourteen rows is a ranking of a hand-picked slice, which is how
 *      a true number ends up carrying a false superlative. Pairwise claims are
 *      exempt: they quantify over their two members and nothing else.
 *   4. The ordering, recomputed here. This is the check the whole thing is for.
 *
 * Returns an array of failure objects.
 */
function checkComparison(cmp, results, readText, ci) {
  const failures = [];
  const at = { comparison_index: ci, claim: (cmp && cmp.claim) || null };
  const fail = (reason, detail) => {
    failures.push({ surface: 'connective_read', claim: at, reason, detail });
    return failures;
  };

  if (!cmp || typeof cmp !== 'object') return fail('malformed_comparison', 'Not an object.');

  const direction = typeof cmp.direction === 'string' ? cmp.direction.toLowerCase() : null;
  if (!COMPARISON_DIRECTIONS.has(direction)) {
    return fail('malformed_comparison',
      'direction must be one of max, min, rank, top, greater, less, equal. Got: '
      + JSON.stringify(cmp.direction));
  }
  const needsK = direction === 'rank' || direction === 'top';
  const k = needsK ? toInt(cmp.k) : null;
  if (needsK && (k === null || k < 1)) {
    return fail('malformed_comparison',
      'direction ' + direction + ' requires `k`: the place for rank (2 = second), the cutoff for top (3 = top three).');
  }
  if (typeof cmp.subject !== 'string' || !cmp.subject.trim()) {
    return fail('malformed_comparison', 'subject must name the member the claim is about.');
  }
  const needsAgainst = direction === 'greater' || direction === 'less' || direction === 'equal';
  if (needsAgainst && (typeof cmp.against !== 'string' || !cmp.against.trim())) {
    return fail('malformed_comparison', 'direction ' + direction + ' requires `against` naming the other member.');
  }

  // 1. The prose this backs must actually be in the read.
  const flat = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (typeof cmp.claim !== 'string' || !cmp.claim.trim()) {
    return fail('malformed_comparison', 'claim must quote the clause of the read this backs.');
  }
  if (!flat(readText).includes(flat(cmp.claim))) {
    return fail('comparison_claim_not_in_read',
      'The quoted claim does not appear in the read. A comparison must back a sentence the reader actually gets.');
  }

  const set = Array.isArray(cmp.set) ? cmp.set : [];
  if (set.length < 2) {
    return fail('comparison_set_too_small', 'A comparison needs at least two members. Got ' + set.length + '.');
  }

  const members = [];
  for (const m of set) {
    if (!m || typeof m !== 'object' || typeof m.label !== 'string' || !m.label.trim()) {
      return fail('malformed_comparison', 'Every set member needs a label and a value.');
    }
    const resolved = comparisonMemberValue(m, results);
    if (!resolved) {
      return fail('malformed_comparison',
        'Member ' + m.label + ': value must be a number, or `from` must hold one or two numbers.');
    }
    if (!resolved.accepts.has(roundDiff(m.value))) {
      return fail('comparison_value_not_derivable', {
        member: m.label, stated: m.value, from: resolved.from, difference: resolved.value,
        accepted: Array.from(resolved.accepts).sort((a, b) => a - b),
      });
    }
    members.push({ label: m.label, key: normalizeItemName(m.label), value: resolved.value, from: resolved.from });
  }

  const labels = new Set(members.map(m => m.key));
  if (labels.size !== members.length) {
    return fail('malformed_comparison', 'Set members must have distinct labels.');
  }
  // The subject has to BE one of the members, matched on the label. Nothing
  // fuzzy: a subject resolved to the nearest-looking member is how a claim
  // gets attached to a number that is not its own, which is the whole class of
  // failure this file exists to stop.
  //
  // So the rejection has to be actionable instead. Live jobs 2436bad7 and
  // e5f3165a both wrote descriptive subjects -- "Midwest parental gap on
  // home-cooked meal", "TREATING YOURSELF -- Midwest Parent" -- against sets
  // labelled otherwise, and both retries failed the same way, because the
  // failure said only that the subject was wrong and never said what the
  // members were. The model was told it had guessed wrong without being shown
  // what it was choosing between. Every other latch here hands back the real
  // options; this one did not.
  //
  // Showing the members is legibility, not licence: the matching rule is
  // unchanged, and a subject still has to be copied from a label rather than
  // approximated.
  const memberChoices = members.map(m => ({ label: m.label, value: m.value }));
  const notInSet = (field, value) => fail('comparison_subject_not_in_set', {
    field,
    stated: value,
    set_members: memberChoices,
    note: `\`${field}\` must be copied verbatim from one of the \`set\` labels above. `
        + 'It names which member the claim is about, so it has to be one of them, '
        + 'not a description of it.',
  });

  const subjectKey = normalizeItemName(cmp.subject);
  if (!labels.has(subjectKey)) return notInSet('subject', cmp.subject);

  const againstKey = needsAgainst ? normalizeItemName(cmp.against) : null;
  if (needsAgainst && !labels.has(againstKey)) return notInSet('against', cmp.against);

  // 2 + 3. Provenance, and -- for superlatives only -- completeness.
  //
  // The two directions need different things. `max` and `min` quantify over a
  // set ("the largest of the fourteen"), so the set has to BE a returned
  // result, whole: ranking three of fourteen rows is how a true number ends up
  // carrying a false superlative. A pairwise `greater` / `less` / `equal`
  // quantifies over nothing but its two members, so requiring it to drag in
  // the other twenty-one rows of whatever query it touched would be a tax on
  // exactly the cross-query pairing this pass exists to make -- and the two
  // members are usually in DIFFERENT results anyway.
  const ranksASet = direction === 'max' || direction === 'min'
                 || direction === 'rank' || direction === 'top';

  if (ranksASet) {
    let home = null;
    for (const res of results) {
      const taken = new Set();
      const seats = new Map();
      for (const m of members) {
        const idx = res.rows.findIndex((row, i) => !taken.has(i) && rowCarriesValues(row, m.from));
        if (idx >= 0) { taken.add(idx); seats.set(m.key, idx); }
      }
      if (!home || seats.size > home.seats.size) home = { res, seats, taken };
    }
    if (!home || home.seats.size < members.length) {
      return fail('comparison_member_not_in_rows', {
        note: 'A ranked set must sit inside ONE returned result, each member on its own row.',
        unseated: members.filter(m => !home || !home.seats.has(m.key))
                         .map(m => ({ member: m.label, numbers: m.from })).slice(0, 6),
      });
    }
    const uncovered = home.res.rows.filter((_, i) => !home.taken.has(i)).map(r => r.raw);
    if (uncovered.length) {
      return fail('comparison_set_incomplete', {
        note: 'The set ranks ' + members.length + ' of the ' + home.res.rows.length
            + ' rows this result returned. A ranking over a slice is not a ranking. '
            + 'Carry every row, or drop the comparative wording.',
        query: home.res.query.slice(0, 300),
        uncovered_rows: uncovered.slice(0, 8),
      });
    }
  } else {
    // Each member on its own returned row, anywhere in the payload. Distinct
    // rows so one row cannot supply both sides of a comparison with itself.
    const taken = new Set();
    for (const m of members) {
      let seated = false;
      for (let ri = 0; ri < results.length && !seated; ri++) {
        for (let i = 0; i < results[ri].rows.length; i++) {
          const key = ri + ':' + i;
          if (taken.has(key)) continue;
          if (rowCarriesValues(results[ri].rows[i], m.from)) { taken.add(key); seated = true; break; }
        }
      }
      if (!seated) {
        return fail('comparison_member_not_in_rows', {
          note: 'Every member of a comparison must stand on its own returned row.',
          unseated: [{ member: m.label, numbers: m.from }],
        });
      }
    }
  }

  // 4. The ordering, recomputed. This is the check.
  const byKey = new Map(members.map(m => [m.key, m]));
  const subject = byKey.get(subjectKey);
  const others = members.filter(m => m.key !== subjectKey);
  const ranked = members.slice().sort((a, b) => b.value - a.value);
  const table = ranked.map(m => m.label + '=' + m.value);

  const orderingFail = (detail) => fail('comparison_ordering_false', Object.assign({
    direction, subject: cmp.subject, set_ranked: table,
  }, detail));

  if (direction === 'max' && others.some(m => m.value >= subject.value)) {
    return orderingFail({ actual_extreme: ranked[0].label + '=' + ranked[0].value });
  }
  if (direction === 'min' && others.some(m => m.value <= subject.value)) {
    const low = ranked[ranked.length - 1];
    return orderingFail({ actual_extreme: low.label + '=' + low.value });
  }
  // A tie makes a place claim unanswerable rather than false: two members at
  // the same value have no second place between them. Rejected as such, so a
  // retry knows to say something else rather than to pick one.
  if (needsK) {
    if (k > members.length) {
      return orderingFail({ k, note: 'k is larger than the set: ' + members.length + ' members.' });
    }
    const above = others.filter(m => m.value > subject.value).length;
    const tied  = others.filter(m => m.value === subject.value).length;
    if (tied) {
      return orderingFail({ k, note: 'Tied on value with ' + tied + ' other member(s); no place claim is answerable.' });
    }
    const place = above + 1;
    const holds = direction === 'rank' ? place === k : place <= k;
    if (!holds) return orderingFail({ k, actual_place: place });
  }
  if (needsAgainst) {
    const against = byKey.get(againstKey);
    const holds = direction === 'greater' ? subject.value > against.value
                : direction === 'less'    ? subject.value < against.value
                : subject.value === against.value;
    if (!holds) {
      return orderingFail({ against: cmp.against, values: [subject.value, against.value] });
    }
  }

  // The base the compared numbers rest on. The rest of the tool carries its n
  // everywhere; the frame was quietly exempt, which let a 34-point spread over
  // 50 and 139 verbatims read like a spread over the corpus. Required, traced
  // to a row, and required to reach the prose -- a base disclosed only to the
  // guard is not disclosed.
  const basis = Array.isArray(cmp.basis_n) ? cmp.basis_n
              : (cmp.basis_n === undefined || cmp.basis_n === null) ? [] : [cmp.basis_n];
  if (!basis.length) {
    return fail('comparison_basis_missing',
      'basis_n must give the count the compared numbers rest on, and the read must state it.');
  }
  const numerals = proseNumerals(readText);
  for (const b of basis) {
    const n = toInt(b);
    if (n === null || n <= 0) return fail('comparison_basis_missing', 'basis_n must be a positive whole number. Got: ' + JSON.stringify(b));
    const onARow = results.some(res => res.rows.some(row => (row.values || []).some(v => v.num === n)));
    if (!onARow) {
      return fail('comparison_basis_not_in_rows', { basis_n: n, note: 'No returned row carries this count.' });
    }
    if (!numerals.has(n)) {
      return fail('comparison_basis_undisclosed', {
        basis_n: n,
        note: 'The read does not state the base these numbers rest on. Say it in the read, not only here.',
      });
    }
  }

  return failures;
}

/**
 * Guard the frame pass's connective read.
 *
 * Standalone rather than folded into runProvenanceGuard because the read is
 * produced by its own pass, before synthesis, and carries its own
 * retry-once-then-drop policy. Wiring it into the synthesizer's guard would
 * have coupled two independent failure domains and delayed the check until
 * after the read had already shaped the report.
 *
 * The allowlist is buildCardAllowlist — every row from every SELECT, keyed on
 * item_name and tagged with an inferred source. That breadth is deliberate:
 * the read's whole job is to hold findings from different queries together,
 * so a narrower per-function allowlist would reject exactly the claims worth
 * making.
 *
 * Returns { ok, failures }. The caller decides retry/drop.
 */
function runConnectiveReadGuard({ connective_read, scratch }) {
  const failures = [];
  const cr = connective_read;

  if (!cr || typeof cr !== 'object') return { ok: true, failures };

  const hasRead = cr.has_read === true;
  const evidence = Array.isArray(cr.evidence) ? cr.evidence : [];
  const readText = typeof cr.read === 'string' ? cr.read.trim() : '';

  // Negative-claim hygiene. "There is no corner" is a valid and wanted
  // outcome, but it must arrive empty-handed. A false read carrying prose or
  // evidence is a claim wearing a disclaimer, and it would pass unguarded
  // into the report because nothing downstream inspects a negative result.
  if (!hasRead) {
    if (readText) {
      failures.push({
        surface: 'connective_read',
        claim: { read: readText.slice(0, 200) },
        reason: 'negative_read_carries_text',
        detail: 'has_read is false but read is non-empty. A no-corner result must not carry a claim.',
      });
    }
    if (evidence.length > 0) {
      failures.push({
        surface: 'connective_read',
        claim: { evidence_count: evidence.length },
        reason: 'negative_read_carries_evidence',
      });
    }
    return { ok: failures.length === 0, failures };
  }

  if (!readText) {
    failures.push({ surface: 'connective_read', claim: null, reason: 'read_text_missing' });
  }

  // Two-row minimum. A connection needs two things to connect; a single-row
  // "read" is a restatement of one query, which is the report writer's job
  // and not this pass's. Enforced in JS because the prompt asking for it is
  // exactly the kind of instruction a model satisfies in spirit and not in
  // fact.
  if (evidence.length < 2) {
    failures.push({
      surface: 'connective_read',
      claim: { evidence_count: evidence.length },
      reason: 'connective_read_insufficient_evidence',
      detail: 'A connective read must cite at least two rows. One row is a restatement, not a connection.',
    });
  }

  const itemIndex = buildCardAllowlist(scratch);

  // Nothing came back at all. Any grounded claim in this state is off-source
  // by definition.
  if (itemIndex.size === 0 && evidence.length > 0) {
    failures.push({
      surface: 'connective_read',
      claim: null,
      reason: 'connective_read_no_allowlist',
      detail: 'Scratch produced no item rows, so no evidence entry can be grounded.',
    });
    return { ok: false, failures };
  }

  for (const e of evidence) {
    if (!e || typeof e !== 'object' || typeof e.item_name !== 'string') {
      failures.push({ surface: 'connective_read', claim: e, reason: 'malformed_evidence_entry' });
      continue;
    }

    const itemKey = normalizeItemName(e.item_name);
    const bucket = itemIndex.get(itemKey);
    if (!bucket || bucket.length === 0) {
      failures.push({
        surface: 'connective_read',
        claim: { item_name: e.item_name },
        reason: 'connective_read_item_not_in_allowlist',
        detail: 'No returned row carries that item name. `item_name` is copied verbatim '
              + 'from a scratch row, not a label for a group of items: a read about a '
              + 'category cites the rows it rests on, one entry each.',
        items_available: allowlistItemNames(itemIndex, e.item_name),
      });
      continue;
    }

    // Which cohort of a cut this claim is about.
    //
    // On a cross-cutting read the cohort IS the claim. Without this the
    // bucket for `live music` holds every generation's row and the numbers
    // check below, which accepts ANY row in the bucket, will clear Boomers'
    // number attached to Gen Z: a true number carrying a false attribution,
    // the same shape as the superlative failure and just as invisible to
    // anything that only checks numerals.
    //
    // A claim that names the cohort in item_name instead of in `axis` is
    // read the same way -- it said the thing, the field it said it in does
    // not matter.
    // Every cohort value that came back for this item. Matching the claim
    // against these, rather than parsing the claim, is what makes a compound
    // cohort readable without guessing at a separator: the model writes
    // "Millennial / $200,000 or more" or "Millennial x $200k+" or an array,
    // and all of them contain the cohort names the rows actually carried.
    // Pinned cohorts count as values the rows carried. They are not printed on
    // the row, but they are true of every row the query returned, and leaving
    // them out is what left `known` empty on a pinned query -- no vocabulary,
    // so nothing to match, so a declared cohort was discarded rather than
    // checked. See pinnedAxesInSql.
    const rowCohorts = r => Object.values(r.axis || {})
      .concat(Object.values(r.pinned_axes || {}));
    const known = Array.from(new Set(bucket.flatMap(rowCohorts)));

    const claimParts = [];
    if (Array.isArray(e.axis)) claimParts.push(...e.axis);
    else if (typeof e.axis === 'string') claimParts.push(e.axis);
    for (const f of AXIS_FIELDS) if (typeof e[f] === 'string') claimParts.push(e[f]);
    const claimNamed = claimParts.map(normalizeItemName).filter(Boolean);
    const claimText = claimNamed.join(' | ');

    const claimAxes = new Set(matchAxisValues(known, claimText));
    // A cohort named in item_name rather than in a field said the thing; the
    // field it said it in does not matter.
    if (!claimAxes.size && known.includes(itemKey)) claimAxes.add(itemKey);

    // A row backs the claim only when the claim names EVERY cut the row sits
    // in. One dimension is not enough on a two-way cut: the Millennial x
    // $200k+ cell is not "Millennials", and citing its 69.5 as a generational
    // figure is the same false attribution one dimension down. Rows outside
    // any cut need no cohort and accept none.
    // Rows whose cohort was written into a column NAME carry no value for the
    // check below to match, so they read as un-cut and clear any claim that
    // names no cohort -- while the prose names one. Dropped before the match
    // rather than after it, so nothing seats on a row whose attribution
    // cannot be verified. See pivotAxesInSql.
    const seatable = bucket.filter(r => !(r.pivot_axes && r.pivot_axes.length));

    // A pinned cohort is one of those cuts. It is not printed on the row, but
    // every row the query returned is inside it, so a claim that does not name
    // it is a subpopulation number presented as a whole one -- the same false
    // attribution as citing the Boomer row as Gen Z, one step quieter. In one
    // line: a subpopulation read must name its subpopulation.
    const candidates = seatable.filter(r => {
      const vals = rowCohorts(r);
      if (!vals.length) return claimAxes.size === 0;
      return claimAxes.size > 0 && vals.every(v => claimAxes.has(v));
    });

    // Every row for this item came back from a pivot. There is no cohort to
    // check the claim against and there is no honest way to invent one, so the
    // rejection names the shape and asks for the cut instead of the pivot.
    if (candidates.length === 0 && seatable.length === 0) {
      const axes = Array.from(new Set(bucket.flatMap(r => r.pivot_axes || [])));
      failures.push({
        surface: 'connective_read',
        claim: { item_name: e.item_name, score: e.score, n: e.n },
        reason: 'connective_read_cohort_in_column_name',
        detail: 'The query that returned this row put ' + axes.join(', ')
              + ' in the column NAMES (a FILTER or CASE pivot), so each row holds several '
              + 'cohorts side by side and no returned value says which cohort it belongs to. '
              + 'A cohort claim on such a row cannot be checked, so it is not accepted. '
              + 'Re-run the cut as GROUP BY ' + axes.join(', ')
              + ' so each cohort is its own row, and cite that row.',
        pivot_axes: axes,
      });
      continue;
    }

    // Every row for this item came from a query pinned to one cohort in its
    // WHERE clause, and the claim did not name that cohort -- either it named
    // none (a subpopulation number read as the whole population) or it named a
    // different one (a swap). Both are unseatable for the same reason, so they
    // get the same rejection, which names the pin and offers the two honest
    // ways out. See pinnedAxesInSql.
    const pinnedOnly = seatable.length > 0 && seatable.every(r =>
      !Object.values(r.axis || {}).length
      && Object.keys(r.pinned_axes || {}).length);
    if (candidates.length === 0 && pinnedOnly) {
      const pins = {};
      for (const r of seatable) Object.assign(pins, r.pinned_axes || {});
      const cols = Object.keys(pins);
      failures.push({
        surface: 'connective_read',
        claim: { item_name: e.item_name, score: e.score, n: e.n },
        reason: 'connective_read_cohort_pinned_in_filter',
        detail: 'The query that returned this row filtered its WHERE clause to '
              + cols.map(c => c + ' = ' + pins[c]).join(', ')
              + ', so every number it returned is that cohort\'s and no returned value '
              + 'says so. This read either names no cohort -- reporting a '
              + 'subpopulation figure as if it were the whole population -- or names a '
              + 'different one. Either re-run as GROUP BY ' + cols.join(', ')
              + ' with the filter dropped, so the cohort is a value on the row and the '
              + 'comparison is visible, or say plainly that the finding is about '
              + cols.map(c => pins[c]).join(' / ') + ' so the claim matches the filter.',
        pinned_axes: pins,
      });
      continue;
    }

    if (candidates.length === 0) {
      // An invented cohort must stay distinguishable from no cohort at all.
      // "Gen Alpha" matches nothing in `known`, so claimAxes is empty -- but
      // the read did name a cohort, and reporting that as "unspecified" would
      // tell a retry to add a cohort it already added. Show it back what it
      // said so the rejection is legible.
      const axisShown = claimAxes.size ? Array.from(claimAxes)
                      : claimNamed.length ? claimNamed
                      : null;
      // Distinguish "named nothing" from "named too little". A read that
      // half-specifies a two-way cell needs to be told the cell has another
      // dimension, not told its cohort does not exist.
      const underSpecified = claimAxes.size > 0 && bucket.some(r => {
        const vals = Object.values(r.axis || {});
        return vals.length > claimAxes.size && vals.some(v => claimAxes.has(v));
      });
      failures.push({
        surface: 'connective_read',
        claim: { item_name: e.item_name, axis: axisShown, score: e.score, n: e.n },
        reason: (!claimAxes.size && !claimNamed.length) ? 'connective_read_axis_unspecified'
              : underSpecified ? 'connective_read_axis_underspecified'
              : 'connective_read_axis_not_in_allowlist',
        detail: (!claimAxes.size && !claimNamed.length)
          ? 'Every returned row for this item belongs to a cut. Name the cohort the number came from.'
          : underSpecified
          ? 'These rows are cut on more than one dimension. Name every cohort the cell belongs to, '
            + 'not just one: a generation-by-income cell is not a claim about the generation.'
          : 'No returned row for this item carries that cohort.',
        // The cohorts that did come back, so a retry can name one rather
        // than guess at it. Cells first, because on a multi-way cut the whole
        // combination is what a claim has to name.
        cohorts_available: Array.from(new Set(
          bucket.map(r => Object.values(r.axis || {}).join(' + ')).filter(Boolean)
        )).slice(0, 16),
      });
      continue;
    }

    // A row matches when BOTH numbers line up on that ONE row. Checking them
    // jointly, rather than each against any row, stops a score from one row
    // pairing with an n from another to authorize a figure that no single row
    // ever carried. Which column held them is not checked -- see
    // rowCarriesNumbers.
    const claimScore = roundJoy(e.score != null ? e.score : e.joy_index);
    const claimN = toInt(e.n);
    const matched = candidates.some(row => rowCarriesNumbers(row, claimScore, claimN).ok);
    if (!matched) {
      failures.push({
        surface: 'connective_read',
        claim: { item_name: e.item_name, axis: Array.from(claimAxes), score: e.score, n: e.n },
        reason: 'connective_read_number_mismatch',
        // The numbers each candidate row actually carried, so a retry can
        // read the correct values off the failure rather than guess at them.
        detail: candidates.slice(0, 4).map(row => {
          const nums = {};
          for (const v of (row.values || [])) nums[v.field] = v.num;
          return nums;
        }),
      });
    }
  }

  // Comparative and superlative claims. Checked against the whole set they
  // rank over rather than against the numerals in them, because the failure
  // this catches is a true number carrying a false ordering.
  const comparisons = Array.isArray(cr.comparisons) ? cr.comparisons : [];
  const results = collectQueryResults(scratch);
  for (let ci = 0; ci < comparisons.length; ci++) {
    for (const f of checkComparison(comparisons[ci], results, readText, ci)) failures.push(f);
  }
  // A comparative word with nothing behind it. The read is where the claim
  // actually reaches the reader, so this is checked on the prose and not on
  // whether the model chose to declare a comparison.
  if (!comparisons.length && COMPARATIVE_RE.test(readText)) {
    const hit = readText.match(COMPARATIVE_RE);
    failures.push({
      surface: 'connective_read',
      claim: { term: hit && hit[0], read: readText.slice(0, 200) },
      reason: 'uncarried_comparative_claim',
      detail: 'The read asserts a comparison ("' + (hit && hit[0])
            + '") but carries no `comparisons` entry, so the ordering cannot be checked. '
            + 'Either carry the full set it ranks over, or state the finding without the comparison.',
    });
  }

  // Numbers the read states plainly, without asserting a relationship.
  const figures = Array.isArray(cr.figures) ? cr.figures : [];
  for (const f of checkFigures(figures, results, evidence)) failures.push(f);

  // A stated distance needs the subtraction behind it -- from a comparison or
  // from a two-operand figure, either is a checked arithmetic claim.
  const carriesDifference = comparisons.length > 0
    || figures.some(f => f && Array.isArray(f.from) && f.from.length === 2);
  if (!carriesDifference && DIFFERENCE_RE.test(readText)) {
    const hit = readText.match(DIFFERENCE_RE);
    failures.push({
      surface: 'connective_read',
      claim: { term: hit && hit[0], read: readText.slice(0, 200) },
      reason: 'uncarried_difference_claim',
      detail: 'The read states a distance ("' + (hit && hit[0])
            + '") but nothing carries the subtraction, so the arithmetic cannot be '
            + 'checked. Add a `figures` entry whose `from` holds the two numbers it '
            + 'came from.',
    });
  }

  // Numbers the read states but never hands over. Last, and unconditional: a
  // retry is shown every failure at once, so suppressing this one behind the
  // others would cost a round trip for no gain.
  for (const f of checkProseNumbers(readText, evidence, comparisons, figures)) failures.push(f);

  return { ok: failures.length === 0, failures };
}

/**
 * Build a compact allowlist digest the synthesizer can be shown on retry.
 * Groups the returned rows into a shape the model can reproduce verbatim:
 * threads (by thread_tag) with their members and exact numbers. Used only
 * on the one retry after a guard failure.
 */
// Map key for rows that carry no tag. A NUL byte cannot appear in a real
// tag, so this can never collide with one.
const UNTAGGED_GROUP = '\u0000untagged';

function buildRetryAllowlistDigest(scratch) {
  const byThread = new Map();
  const entries = Array.isArray(scratch) ? scratch : [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const q = typeof entry.query === 'string' ? entry.query.toLowerCase() : '';
    const alt = [entry.sql, entry.query_text]
      .filter(v => typeof v === 'string')
      .map(v => v.toLowerCase());
    const hay = [q, ...alt].join(' ');
    if (
      !hay.includes('bjl_corpus_search(') &&
      !hay.includes('bjl_corpus_bridges_v2(') &&
      !hay.includes('bjl_corpus_bridges(') &&
      !hay.includes('bjl_corpus_threads(') &&
      !hay.includes('bjl_corpus_pivot(')
    ) continue;

    const rows = Array.isArray(entry.result) ? entry.result
               : Array.isArray(entry.rows)   ? entry.rows
               : [];
    for (const row of rows) {
      // bjl_corpus_bridges(_v2): row.tag + row.tag_rank
      // bjl_corpus_threads:     row.thread_tag + row.thread_rank
      // bjl_corpus_search:      no tag at all, by design.
      //
      // Untagged rows used to be skipped here, which meant a Shape B run
      // produced an EMPTY digest — the one retry after a guard failure
      // showed the model nothing and asked it to do better. They now group
      // under a single untagged bucket so the retry carries real rows.
      if (!row || typeof row !== 'object' || !row.item_name) continue;
      const tag = typeof row.thread_tag === 'string' && row.thread_tag ? row.thread_tag
                : typeof row.tag === 'string' && row.tag ? row.tag
                : null;
      const groupKey = tag === null ? UNTAGGED_GROUP : tag;
      const rank = row.thread_rank ?? row.tag_rank ?? null;
      if (!byThread.has(groupKey)) {
        byThread.set(groupKey, {
          thread_tag: tag,
          thread_rank: rank,
          members: [],
        });
      }
      // v2 rows use `score`; v1/legacy use `joy_index`. Prefer `score`.
      const scoreValue = row.score != null ? row.score : row.joy_index;
      byThread.get(groupKey).members.push({
        item_name:     row.item_name,
        joy_index:     roundJoy(scoreValue),
        n:             toInt(row.n),
        primary_topic: row.primary_topic || null,
        construct:     typeof row.construct === 'string' ? row.construct : null,
      });
    }
  }

  return Array.from(byThread.values())
    .sort((a, b) => (a.thread_rank ?? 999) - (b.thread_rank ?? 999));
}

module.exports = {
  runProvenanceGuard,
  runCrossDomainProvenanceGuard,   // back-compat alias
  runConnectiveReadGuard,
  buildRetryAllowlistDigest,
  buildCardAllowlist,
  resolveCardCohorts,
  cardCohortSeating,
  buildSignatureAllowlist,
  buildAudienceAffinityAllowlist,
  buildAudienceProfileAllowlist,
  buildAudienceSelectsAllowlist,
  buildAudienceDistributionsAllowlist,
  // Exported for tests + reuse.
  normalizeItemName,
  pivotAxesInSql,
  pinnedAxesInSql,
  roundJoy,
  buildAllowlist,
  inferSourceTable,
  numericFields,
  rowCarriesNumbers,
  checkComparison,
  checkFigures,
  checkProseNumbers,
  collectQueryResults,
  COMPARATIVE_RE,
};
