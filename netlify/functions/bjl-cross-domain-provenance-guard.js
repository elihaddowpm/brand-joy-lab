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
 * Two surfaces are guarded on the same code path:
 *
 * A) Cross-domain threads (cross_domain_threads). Allowlist is the rows
 *    returned by bjl_corpus_threads / bjl_corpus_pivot in scratch. Checks:
 *      1. Item provenance: member.item_name matches a returned row.
 *      2. Number provenance: joy_index equal to one decimal, n exact.
 *      3. Thread provenance: thread_tag is one of the returned tags.
 *      4. Home-topic exclusion: member.primary_topic is not a home topic.
 *
 * B) Publishable cards (cards). Allowlist is the broader index of any
 *    row returned by any SELECT in scratch, tagged with the source table
 *    inferred from the query's FROM clause. Checks:
 *      1. Item provenance: stat_item.item_name matches a returned row.
 *      2. Number provenance: joy_index equal to one decimal, n exact.
 *      3. Source provenance: stat_item.source equals the row's source table.
 *      4. Single-source rule: every stat_item inside a card shares a source.
 *
 * Returns { ok, failures } where failures is [] on success and an array of
 * { claim, reason } objects on failure. The caller decides retry/drop policy.
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
    // function name.
    const alt = [entry.sql, entry.query_text]
      .filter(v => typeof v === 'string')
      .map(v => v.toLowerCase());
    const hay = [q, ...alt].join(' ');
    if (!hay.includes('bjl_corpus_threads(') && !hay.includes('bjl_corpus_pivot(')) continue;

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
      if (typeof row.thread_tag === 'string' && row.thread_tag) {
        threadTags.add(row.thread_tag);
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
function runProvenanceGuard({ threads, cards, home_topic, scratch }) {
  const threadFailures = runThreadsGuard({ threads, home_topic, scratch });
  const cardFailures   = runCardsGuard({ cards, scratch });
  const failures = [
    ...threadFailures.map(f => Object.assign({ surface: 'threads' }, f)),
    ...cardFailures.map(f => Object.assign({ surface: 'cards' }, f)),
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
    if (!hay.includes('bjl_corpus_threads(') && !hay.includes('bjl_corpus_pivot(')) continue;

    const rows = Array.isArray(entry.result) ? entry.result
               : Array.isArray(entry.rows)   ? entry.rows
               : [];
    for (const row of rows) {
      if (!row || typeof row.thread_tag !== 'string') continue;
      const tag = row.thread_tag;
      if (!byThread.has(tag)) {
        byThread.set(tag, {
          thread_tag: tag,
          thread_rank: row.thread_rank ?? null,
          members: [],
        });
      }
      byThread.get(tag).members.push({
        item_name: row.item_name,
        joy_index: roundJoy(row.joy_index),
        n: toInt(row.n),
        primary_topic: row.primary_topic || null,
        shared_jobs: row.shared_jobs || null,
        shared_tensions: row.shared_tensions || null,
        shared_joy_modes: row.shared_joy_modes || null,
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
  // Exported for tests + reuse.
  normalizeItemName,
  roundJoy,
  buildAllowlist,
  inferSourceTable,
};
