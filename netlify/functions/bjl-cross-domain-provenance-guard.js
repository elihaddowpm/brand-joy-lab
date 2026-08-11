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

// Round to one decimal, matching what bjl_corpus_threads emits.
function roundJoy(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
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
 * Build the card allowlist from investigator scratch. Broader than the
 * threads allowlist: indexes every row from any SELECT with an item_name,
 * tagged with the source table inferred from the query's FROM clause.
 *
 * Returns Map<normalized_item_name, Array<{joy_index, n, source}>>.
 */
function buildCardAllowlist(scratch) {
  const itemIndex = new Map();
  const entries = Array.isArray(scratch) ? scratch : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const rawSql = typeof entry.query === 'string' ? entry.query
                 : typeof entry.sql === 'string' ? entry.sql
                 : typeof entry.query_text === 'string' ? entry.query_text
                 : '';
    const source = inferSourceTable(rawSql);
    if (!source) continue;
    const rows = Array.isArray(entry.result) ? entry.result
               : Array.isArray(entry.rows)   ? entry.rows
               : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const key = normalizeItemName(row.item_name);
      if (!key) continue;
      // v2 rows use `score`; v1/legacy rows use `joy_index`. Also accept
      // `audience_score` when the row comes from bjl_audience_affinity(_v2),
      // so a card citing an affinity finding matches.
      const scoreValue = row.score != null ? row.score
                       : row.joy_index != null ? row.joy_index
                       : row.audience_score;
      const nValue = row.n != null ? row.n : row.aud_n;
      const bucket = itemIndex.get(key) || [];
      bucket.push({
        joy_index: roundJoy(scoreValue),
        n:         toInt(nValue),
        source,
        construct: typeof row.construct === 'string' ? row.construct : null,
        // The row's full numeric surface, so a claim can verify against an
        // aliased score column. joy_index and n above stay for the failure
        // detail a human reads; `values` is what the match runs against.
        values:    numericFields(row),
      });
      itemIndex.set(key, bucket);
    }
  }
  return itemIndex;
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

  for (const m of list) {
    if (!m || typeof m !== 'object' || typeof m.item_name !== 'string') {
      failures.push({ claim: m, reason: 'malformed_cross_domain_item' });
      continue;
    }
    const key = normalizeItemName(m.item_name);
    const bucket = itemIndex.get(key);
    if (!bucket || bucket.length === 0) {
      failures.push({ claim: { item_name: m.item_name, tag: m.tag }, reason: 'cross_domain_item_not_in_allowlist' });
      continue;
    }
    // Tag check, but only for items whose authorizing row actually carried
    // a tag. bjl_corpus_search returns no tag and both prompts forbid the
    // model from emitting one, so demanding a tag here failed every
    // Shape B item and silently dropped the whole sidecar. The arm is the
    // authority on its own return shape; the guard follows it.
    if (bucket.some(row => row.tagged)) {
      if (typeof m.tag !== 'string' || !threadTags.has(m.tag)) {
        failures.push({ claim: { item_name: m.item_name, tag: m.tag }, reason: 'cross_domain_tag_not_in_allowlist' });
      }
    }
    // v2 claims use `score`; v1 claims use `joy_index`. Accept either.
    const claimScoreRaw = m.score != null ? m.score : m.joy_index;
    const claimJoy   = roundJoy(claimScoreRaw);
    const claimN     = toInt(m.n);
    const claimTopic = typeof m.primary_topic === 'string' ? m.primary_topic.toLowerCase() : null;
    let matched = false;
    let closest = { joy: null, n: null, topic: null };
    for (const row of bucket) {
      const joyOk   = claimJoy === row.joy_index;
      const nOk     = claimN === row.n;
      const topicOk = claimTopic === (row.primary_topic ? row.primary_topic.toLowerCase() : null);
      if (joyOk && nOk && topicOk) { matched = true; break; }
      if (!joyOk   && closest.joy   === null) closest.joy   = { claim: claimJoy, allowlist: row.joy_index };
      if (!nOk     && closest.n     === null) closest.n     = { claim: claimN, allowlist: row.n };
      if (!topicOk && closest.topic === null) closest.topic = { claim: claimTopic, allowlist: row.primary_topic };
    }
    if (!matched) {
      if (closest.joy)   failures.push({ claim: { item_name: m.item_name, score: claimScoreRaw }, reason: 'cross_domain_score_mismatch', detail: closest.joy });
      else if (closest.n)   failures.push({ claim: { item_name: m.item_name, n: m.n }, reason: 'cross_domain_n_mismatch', detail: closest.n });
      else if (closest.topic) failures.push({ claim: { item_name: m.item_name, primary_topic: m.primary_topic }, reason: 'cross_domain_topic_mismatch', detail: closest.topic });
    }
    if (claimTopic && homeTopics.has(claimTopic)) {
      failures.push({
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

  for (const m of list) {
    if (!m || typeof m !== 'object' || typeof m.item_name !== 'string') {
      failures.push({ claim: m, reason: 'malformed_audience_affinity_entry' });
      continue;
    }
    const key = normalizeItemName(m.item_name);
    const bucket = byItem.get(key);
    if (!bucket || bucket.length === 0) {
      failures.push({ claim: { item_name: m.item_name }, reason: 'audience_item_not_in_allowlist' });
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
      if (closest.lift) failures.push({ claim: { item_name: m.item_name, rel_lift: m.rel_lift }, reason: 'audience_rel_lift_mismatch', detail: closest.lift });
      else if (closest.ji) failures.push({ claim: { item_name: m.item_name, audience_score: claimScoreRaw }, reason: 'audience_score_mismatch', detail: closest.ji });
      else if (closest.gen) failures.push({ claim: { item_name: m.item_name, general_score: claimGenScoreRaw }, reason: 'audience_general_score_mismatch', detail: closest.gen });
      else if (closest.n) failures.push({ claim: { item_name: m.item_name, aud_n: m.aud_n }, reason: 'audience_n_mismatch', detail: closest.n });
      continue;
    }
    // Structural reportability check: every audience-affinity entry MUST
    // carry the reportable boolean, and it must match the row's flag from
    // scratch. This prevents the synth from silently upgrading a
    // sub-threshold row into a distinctive-preference finding.
    if (claimReportable === null) {
      failures.push({ claim: { item_name: m.item_name }, reason: 'audience_reportable_missing', detail: 'audience_affinity entry omitted the reportable boolean; every entry must carry it (source of truth is the scratch row).' });
    } else if (matchedRow && typeof matchedRow.reportable === 'boolean' && claimReportable !== matchedRow.reportable) {
      failures.push({
        claim: { item_name: m.item_name, reportable: claimReportable },
        reason: 'audience_reportable_mismatch',
        detail: { claim: claimReportable, allowlist: matchedRow.reportable, rel_lift: matchedRow.rel_lift },
      });
    }
    // Both raw scores (audience_score AND general_score) must be present on
    // every entry. The reportability rule requires the reader to see both
    // numbers alongside rel_lift so a raw gap cannot be inferred as the
    // effect size.
    if (claimScoreRaw == null) {
      failures.push({ claim: { item_name: m.item_name }, reason: 'audience_score_missing' });
    }
    if (claimGenScoreRaw == null) {
      failures.push({ claim: { item_name: m.item_name }, reason: 'audience_general_score_missing', detail: 'audience_affinity entry must include general_score alongside audience_score; the reader must see both numbers, not just one side of the comparison.' });
    }
    if (claimLift === null) {
      failures.push({ claim: { item_name: m.item_name }, reason: 'audience_rel_lift_missing', detail: 'audience_affinity entry must include rel_lift; it is the centered effect size and the honest finding.' });
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
 * Card provenance guard. Applies the four checks (item, joy_index, n, source)
 * to each stat_item, and enforces the single-source rule (all stat_items in
 * one card share a source). Returns a bare failures array; the unified
 * guard tags them with surface='cards'.
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
      for (const row of bucket) {
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
            detail: bucket.slice(0, 4).map(row => ({
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

    const bucket = itemIndex.get(normalizeItemName(e.item_name));
    if (!bucket || bucket.length === 0) {
      failures.push({
        surface: 'connective_read',
        claim: { item_name: e.item_name },
        reason: 'connective_read_item_not_in_allowlist',
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
    const matched = bucket.some(row => rowCarriesNumbers(row, claimScore, claimN).ok);
    if (!matched) {
      failures.push({
        surface: 'connective_read',
        claim: { item_name: e.item_name, score: e.score, n: e.n },
        reason: 'connective_read_number_mismatch',
        // The numbers each candidate row actually carried, so a retry can
        // read the correct values off the failure rather than guess at them.
        detail: bucket.slice(0, 4).map(row => {
          const nums = {};
          for (const v of (row.values || [])) nums[v.field] = v.num;
          return nums;
        }),
      });
    }
  }

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
  buildSignatureAllowlist,
  buildAudienceAffinityAllowlist,
  buildAudienceProfileAllowlist,
  buildAudienceSelectsAllowlist,
  buildAudienceDistributionsAllowlist,
  // Exported for tests + reuse.
  normalizeItemName,
  roundJoy,
  buildAllowlist,
  inferSourceTable,
  numericFields,
  rowCarriesNumbers,
};
