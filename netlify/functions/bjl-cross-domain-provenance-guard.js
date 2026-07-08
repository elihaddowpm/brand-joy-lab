/**
 * Cross-domain provenance guard.
 *
 * Post-generation check that binds the synthesizer's cross-domain claims to
 * the rows bjl_corpus_threads (or bjl_corpus_pivot) actually returned in the
 * same turn. Prompt guidance asks; this guard decides. If a claim can't be
 * grounded in a returned row, the sidecar gets dropped rather than shipped.
 *
 * Called from bjl-query-background.js after runSynthesis and before persisting
 * the answer. Pure function: no I/O, no side effects, easy to test.
 *
 * Four checks:
 *   1. Item provenance: every member's item_name matches a returned row (name
 *      normalized against curly quotes and casing).
 *   2. Number provenance: joy_index equal to one decimal, n exact.
 *   3. Thread provenance: every thread_tag is one of the tags in the returned
 *      rows.
 *   4. Home-topic exclusion: no member's primary_topic is a home topic.
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
 * The four checks. Returns { ok, failures } and does not throw.
 *
 * @param {object} args
 * @param {Array}  args.threads       — cross_domain_threads from synth output
 * @param {string|string[]} args.home_topic — from synth output
 * @param {Array}  args.scratch       — investigator scratch (for allowlist)
 */
function runCrossDomainProvenanceGuard({ threads, home_topic, scratch }) {
  const failures = [];

  const list = Array.isArray(threads) ? threads : [];
  // Nothing to guard. Trivially ok: guard fires only when the model made
  // structured cross-domain claims.
  if (list.length === 0) return { ok: true, failures };

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
    return { ok: false, failures };
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

  return { ok: failures.length === 0, failures };
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
  runCrossDomainProvenanceGuard,
  buildRetryAllowlistDigest,
  // Exported for tests + reuse when cards are added.
  normalizeItemName,
  roundJoy,
  buildAllowlist,
};
