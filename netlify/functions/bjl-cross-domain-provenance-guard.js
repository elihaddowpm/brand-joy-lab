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
 * Six surfaces are guarded on the same code path:
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
 * E) cross_domain_threads (legacy nested shape). Kept for back-compat with
 *    already-deployed surfaces. Same checks as (B) but on the older
 *    {thread_tag, members[]} shape.
 * F) cards. Allowlist: any row from any SELECT in scratch, tagged with the
 *    source table inferred from the query's FROM clause. Checks:
 *      1. Item provenance: stat_item.item_name matches a returned row.
 *      2. Number provenance: joy_index (1 decimal), n (exact).
 *      3. Source provenance: stat_item.source equals row's source.
 *      4. Single-source rule: every stat_item in a card shares a source.
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
    // function name. bjl_corpus_bridges is the current item-lens source;
    // bjl_corpus_threads and bjl_corpus_pivot are recognized for back-compat
    // during the transition.
    const alt = [entry.sql, entry.query_text]
      .filter(v => typeof v === 'string')
      .map(v => v.toLowerCase());
    const hay = [q, ...alt].join(' ');
    if (
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
      const bucket = itemIndex.get(key) || [];
      bucket.push({
        joy_index: roundJoy(row.joy_index),
        n: toInt(row.n),
        primary_topic: typeof row.primary_topic === 'string' ? row.primary_topic : null,
      });
      itemIndex.set(key, bucket);
      // bjl_corpus_bridges emits `tag`; bjl_corpus_threads emitted
      // `thread_tag`. Accept either so the guard covers both transitional
      // shapes.
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
      const bucket = itemIndex.get(key) || [];
      bucket.push({
        joy_index: roundJoy(row.joy_index),
        n: toInt(row.n),
        source,
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
  const rows = collectRowsFromFn(scratch, ['bjl_audience_affinity']);
  const byItem = new Map();
  for (const r of rows) {
    const key = normalizeItemName(r.item_name);
    if (!key) continue;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push({
      rel_lift:    r.rel_lift == null ? null : Math.round(Number(r.rel_lift) * 10) / 10,
      audience_ji: r.audience_ji == null ? null : Math.round(Number(r.audience_ji) * 10) / 10,
      general_ji:  r.general_ji == null ? null : Math.round(Number(r.general_ji) * 10) / 10,
      aud_n:       toInt(r.aud_n),
      primary_topic: typeof r.primary_topic === 'string' ? r.primary_topic : null,
    });
  }
  return byItem;
}

function buildAudienceProfileAllowlist(scratch) {
  const rows = collectRowsFromFn(scratch, ['bjl_audience_profile']);
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
  home_topic,
  scratch,
}) {
  const failures = [
    ...runSignatureGuard({ signature, scratch })
      .map(f => Object.assign({ surface: 'signature' }, f)),
    ...runCrossDomainItemsGuard({ cross_domain_items, home_topic, scratch })
      .map(f => Object.assign({ surface: 'cross_domain_items' }, f)),
    ...runAudienceAffinityGuard({ audience_affinity, scratch })
      .map(f => Object.assign({ surface: 'audience_affinity' }, f)),
    ...runAudienceProfileGuard({ audience_profile, scratch })
      .map(f => Object.assign({ surface: 'audience_profile' }, f)),
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
      detail: 'cross_domain_items was populated but bjl_corpus_bridges did not run this turn or returned no rows',
    });
    return failures;
  }

  for (const m of list) {
    if (!m || typeof m !== 'object' || typeof m.item_name !== 'string') {
      failures.push({ claim: m, reason: 'malformed_cross_domain_item' });
      continue;
    }
    // Tag check (from bridges rows).
    if (typeof m.tag !== 'string' || !threadTags.has(m.tag)) {
      failures.push({ claim: { item_name: m.item_name, tag: m.tag }, reason: 'cross_domain_tag_not_in_allowlist' });
    }
    const key = normalizeItemName(m.item_name);
    const bucket = itemIndex.get(key);
    if (!bucket || bucket.length === 0) {
      failures.push({ claim: { item_name: m.item_name, tag: m.tag }, reason: 'cross_domain_item_not_in_allowlist' });
      continue;
    }
    const claimJoy   = roundJoy(m.joy_index);
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
      if (closest.joy)   failures.push({ claim: { item_name: m.item_name, joy_index: m.joy_index }, reason: 'cross_domain_joy_mismatch', detail: closest.joy });
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
    const claimLift  = m.rel_lift == null ? null : Math.round(Number(m.rel_lift) * 10) / 10;
    const claimJI    = m.audience_ji == null ? null : Math.round(Number(m.audience_ji) * 10) / 10;
    const claimN     = toInt(m.aud_n);
    let matched = false;
    let closest = { lift: null, ji: null, n: null };
    for (const row of bucket) {
      const liftOk = claimLift === null || row.rel_lift === null || claimLift === row.rel_lift;
      const jiOk   = claimJI === null || row.audience_ji === null || claimJI === row.audience_ji;
      const nOk    = claimN === null || row.aud_n === null || claimN === row.aud_n;
      if (liftOk && jiOk && nOk) { matched = true; break; }
      if (!liftOk && closest.lift === null) closest.lift = { claim: claimLift, allowlist: row.rel_lift };
      if (!jiOk   && closest.ji   === null) closest.ji   = { claim: claimJI, allowlist: row.audience_ji };
      if (!nOk    && closest.n    === null) closest.n    = { claim: claimN, allowlist: row.aud_n };
    }
    if (!matched) {
      if (closest.lift) failures.push({ claim: { item_name: m.item_name, rel_lift: m.rel_lift }, reason: 'audience_rel_lift_mismatch', detail: closest.lift });
      else if (closest.ji) failures.push({ claim: { item_name: m.item_name, audience_ji: m.audience_ji }, reason: 'audience_ji_mismatch', detail: closest.ji });
      else if (closest.n) failures.push({ claim: { item_name: m.item_name, aud_n: m.aud_n }, reason: 'audience_n_mismatch', detail: closest.n });
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

    const seenSources = new Set();
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

      const claimJoy    = roundJoy(s.joy_index);
      const claimN      = toInt(s.n);
      const claimSource = typeof s.source === 'string' ? s.source.toLowerCase() : null;
      if (claimSource) seenSources.add(claimSource);

      // A row matches when joy_index, n, and source all agree. Multiple
      // rows can exist per item; accept the stat item if any row agrees.
      let matched = false;
      let closest = { joy: null, n: null, source: null };
      for (const row of bucket) {
        const joyOk    = claimJoy === null || row.joy_index === null || claimJoy === row.joy_index;
        const nOk      = claimN === null || row.n === null || claimN === row.n;
        const sourceOk = claimSource === null || claimSource === row.source;
        if (joyOk && nOk && sourceOk) { matched = true; break; }
        if (!joyOk    && closest.joy    === null) closest.joy    = { claim: claimJoy, allowlist: row.joy_index };
        if (!nOk      && closest.n      === null) closest.n      = { claim: claimN, allowlist: row.n };
        if (!sourceOk && closest.source === null) closest.source = { claim: claimSource, allowlist: row.source };
      }
      if (!matched) {
        if (closest.joy) {
          failures.push({
            claim: { card_index: ci, item_name: s.item_name, joy_index: s.joy_index },
            reason: 'card_joy_index_mismatch',
            detail: closest.joy,
          });
        } else if (closest.n) {
          failures.push({
            claim: { card_index: ci, item_name: s.item_name, n: s.n },
            reason: 'card_n_mismatch',
            detail: closest.n,
          });
        } else if (closest.source) {
          failures.push({
            claim: { card_index: ci, item_name: s.item_name, source: s.source },
            reason: 'card_source_mismatch',
            detail: closest.source,
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
  }

  return failures;
}

/**
 * Build a compact allowlist digest the synthesizer can be shown on retry.
 * Groups the returned rows into a shape the model can reproduce verbatim:
 * threads (by thread_tag) with their members and exact numbers. Used only
 * on the one retry after a guard failure.
 */
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
      !hay.includes('bjl_corpus_bridges(') &&
      !hay.includes('bjl_corpus_threads(') &&
      !hay.includes('bjl_corpus_pivot(')
    ) continue;

    const rows = Array.isArray(entry.result) ? entry.result
               : Array.isArray(entry.rows)   ? entry.rows
               : [];
    for (const row of rows) {
      // bjl_corpus_bridges: row.tag + row.tag_rank
      // bjl_corpus_threads: row.thread_tag + row.thread_rank
      const tag = typeof row.thread_tag === 'string' ? row.thread_tag
                : typeof row.tag === 'string' ? row.tag
                : null;
      if (!tag) continue;
      const rank = row.thread_rank ?? row.tag_rank ?? null;
      if (!byThread.has(tag)) {
        byThread.set(tag, {
          thread_tag: tag,
          thread_rank: rank,
          members: [],
        });
      }
      byThread.get(tag).members.push({
        item_name: row.item_name,
        joy_index: roundJoy(row.joy_index),
        n: toInt(row.n),
        primary_topic: row.primary_topic || null,
      });
    }
  }

  return Array.from(byThread.values())
    .sort((a, b) => (a.thread_rank ?? 999) - (b.thread_rank ?? 999));
}

module.exports = {
  runProvenanceGuard,
  runCrossDomainProvenanceGuard,   // back-compat alias
  buildRetryAllowlistDigest,
  buildCardAllowlist,
  buildSignatureAllowlist,
  buildAudienceAffinityAllowlist,
  buildAudienceProfileAllowlist,
  // Exported for tests + reuse.
  normalizeItemName,
  roundJoy,
  buildAllowlist,
  inferSourceTable,
};
