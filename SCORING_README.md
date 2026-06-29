# BJL Scoring Pipeline — `run_scoring.py`

The pipeline that turns raw `bjl_responses` into aggregated `bjl_scores`
rows. Runs locally against the Supabase database with the service role.
Re-runnable and idempotent.

## Why this script exists

The original loader that produced the first 3,589 rows in `bjl_scores`
was written inside a Claude session and never committed. When 135
non-brand quant questions surfaced as missing from the corpus (the
backfill scope tracked in `bjl_backfill_scope`), there was no script to
re-run. This file is the documented, committed replacement so the next
wave of incoming questions doesn't recreate the same gap.

Maintained alongside `run_enrichment.py` (joy_modes / occasions /
functional_jobs / tensions tagging) and `run_embeddings.py` (vector
1536 embeddings). Run order after raw waves land:

1. `python3 run_scoring.py`     — raw responses → aggregated `bjl_scores` rows
2. `python3 run_enrichment.py`  — tag the rows with framework metadata
3. `python3 run_embeddings.py`  — fill vector embeddings for semantic search

## Strict `joy_index` rule (v8.0)

**Only rows with `question_type = 'joy_scale'` carry a `joy_index`.**

Joy Index is the measurement specific to the -3 to +5 emotional-joy
scale (and its 0-to-5 / 3-pt variants). Earlier the loader applied
`joy_index = mean × 20` to all scaled types (ordinal, likelihood,
familiarity), which conflated different measurement instruments under
one label. The strict rule keeps the Joy Index name reserved for actual
joy measurements; other scales carry their own metrics.

Per-type populated fields:

| question_type      | mean | joy_index | n  | base_n | top_response | top_pct | pct | pct_max | pct_negative |
|--------------------|------|-----------|----|--------|--------------|---------|-----|---------|--------------|
| joy_scale          | ✓    | ✓         | ✓  |        |              |         |     | ✓       | ✓            |
| ordinal_scale      | ✓    |           | ✓  | ✓      | ✓            | ✓       |     |         |              |
| likelihood_scale   | ✓    |           | ✓  | ✓      | ✓            | ✓       |     | ✓       |              |
| familiarity_trust  | ✓    |           | ✓  | ✓      | ✓            | ✓       |     |         |              |
| select_all         |      |           | ✓  | ✓      |              |         | ✓   |         |              |

## `detect_scale()` — how the classifier picks the question_type

The classifier reads the actual distinct response labels for each
question and matches against known vocabularies. The declared
`question_type` in `bjl_questions_v2` is consulted as a hint but does
not determine the output — the original loader couldn't trust the
declared type either, because a single declared type (e.g.
`single_select`) spreads across multiple bjl_scores types in practice.

Decision order:

1. **Joy -3 to +5.** `numeric_value` is populated AND labels include
   negative numbers ("-3", "-2", "-1") OR anchored text like
   "-3 (Definitely NOT Joy)" / "5 (Maximum Joy!)". Classifies as
   `joy_scale`, `scale_type='ordinal_-3_to_5'`.

2. **0-to-5 anchored.** `numeric_value` is populated AND labels are
   "0" through "5" with anchor text on the endpoints. The anchor text
   distinguishes the family:
   - `"joy" in anchor` → `joy_scale`, `ordinal_0_to_5`
   - `"describe" in anchor` → `ordinal_scale`, `description_0_to_5`
   - `"important" / "essential"` → `ordinal_scale`, `importance_0_to_5`
   - `"familiar"` → `familiarity_trust`, `familiarity_0_to_5`
   - Bare 0-5 numeric with no anchor → defaults to `ordinal_scale`,
     `numeric_0_to_5` unless the declared type contains 'joy'.

3. **3-pt ordinal — "Very much so / Somewhat / Not at all".** This is
   the canonical 3-point ordinal vocabulary. The declared type
   determines whether it's a joy variant:
   - Declared `joy_scale*` → `joy_scale`, `ordinal_3pt_joy`
   - Otherwise → `ordinal_scale`, `very_much_not_at_all`
   Label mapping: Not at all=0, Somewhat=2.5, Very much so=5.

4. **5-pt likelihood vocabulary** — "Very likely / Likely / Neither /
   Unlikely / Very unlikely" → `likelihood_scale`,
   `likely_unlikely_5pt`. Mapping 0-4.

5. **5-pt familiarity** — "Very familiar / Somewhat / Neutral / Not very
   / Not at all" → `familiarity_trust`, `familiar_unfamiliar_5pt`.

6. **5-pt agreement** — "Strongly agree / Agree / Neither / Disagree /
   Strongly disagree" → `ordinal_scale`, `agree_disagree_5pt`.

7. **Frequency labels** — "Daily / Weekly / Monthly / Seldom / Never"
   → `likelihood_scale`, `frequency_5pt`. (Frequency lives under
   likelihood_scale because it's a behavioral-intent-like metric.)

8. **`is_selected=true` with non-ordinal multi-statement labels** →
   `select_all`, no scale_type.

9. **Demographic battery** — response labels are exclusively
   demographic terms (race / ethnicity / language). → SKIP. Never
   loaded as a quant item.

10. **Open-ended verbatim** — > 20 distinct labels with no structure
    and no `is_selected`. → SKIP. Belongs in `bjl_verbatims`, not
    `bjl_scores`.

11. **Unclassified** — anything that doesn't match. → SKIP, logged so
    the human can extend the classifier.

## Sample-size thresholds

| Question type      | n threshold | base_n threshold |
|--------------------|-------------|------------------|
| joy_scale          | 30          | —                |
| ordinal_scale      | 50          | 100              |
| likelihood_scale   | 50          | 100              |
| familiarity_trust  | 50          | 100              |
| select_all         | 30 (selections) | 100          |

Items below threshold are silently skipped — they don't insert under-
sampled rows that would mislead retrieval.

## Brand and demographic gating

- Items whose `item_name` matches an entry in `bjl_gated_entities`
  (either exact match or substring) are skipped per-item, not
  per-question. A question with a generic stem and brand-named items
  loads only its non-brand items.
- Demographic batteries (race, ethnicity, language) skip at the
  question level when the response set is exclusively demographic
  terms. Demographic data is staff-only and lives in
  `bjl_respondents`, not in the searchable corpus.

## Known divergence from the original loader

The original loader appears to have aggregated by `item_name` /
`question_text` **across question_ids** — the bjl_scores row stamped
with `question_id=1` actually pools responses from `question_id=278`
in `bjl_responses` (verified: that row's n=10,637 has zero matches
under qid=1 but 11,664 matches under qid=278 for the same item).
The `question_id` column on `bjl_scores` is a metadata stamp, not the
source-of-aggregation pointer.

`run_scoring.py` (v8.0) takes the simpler path: it aggregates per
`(question_id, item_name)` from the backfill scope's question_ids,
without pooling across question_ids that share the same item_name
across different waves. Trade-offs:

- **Pro**: predictable, transparent, easy to reason about. Each
  `bjl_scores` row maps to exactly one `bjl_responses.question_id`.
- **Pro**: matches the explicit backfill scope (135 question_ids
  → 135 question_ids of new rows, plus the items inside each).
- **Con**: when the same item_name appears under multiple
  question_ids (multi-wave deployment), v8.0 inserts SEPARATE
  bjl_scores rows for each. The natural key
  `(item_name, question, question_type)` still prevents duplicates
  AT THE QUESTION-TEXT LEVEL, but if two question_ids in the scope
  share the exact same question_text, only one of them surfaces in
  bjl_scores (last write wins on the upsert).

If cross-wave pooling becomes a requirement, v8.1 would pool first
(by item_name across all bjl_responses) and stamp the most-common
question_id afterward — but adds complexity to verify and explain.
Recommend keeping v8.0 simple unless a real use case forces the
change.

## Re-runnability + idempotency

Inserts use `ON CONFLICT (item_name, question, question_type) DO UPDATE`.
Re-running the script on the same question_ids updates existing rows
in place; no duplicates are created. The composite natural key is
preserved by the `bjl_scores_natural_key` constraint set in the
original schema migration.

`bjl_backfill_scope.loaded` flips to `true` after each question
completes successfully. Re-running picks up only `loaded = false`
rows by default.

## What this script does NOT do

- Doesn't enrich (joy_modes / occasions / functional_jobs / tensions).
  That's `run_enrichment.py`.
- Doesn't embed (vector(1536) for semantic search). That's
  `run_embeddings.py`.
- Doesn't refresh the public-side tables (`bjl_public_scores`,
  `bjl_public_ordinal`, `bjl_public_agreement`,
  `bjl_public_distributions`). Those are populated by
  `netlify/functions/bjl-refresh-public-scores-background.js`,
  triggered from the Public Corpus pane in the workbench.

## CLI

```
python3 run_scoring.py                     # all pending scope rows
python3 run_scoring.py --dry-run           # preview, no inserts
python3 run_scoring.py --verify-existing   # score 5 known questions,
                                            # diff vs live rows
python3 run_scoring.py --question-ids 224,234,235   # arbitrary qids
python3 run_scoring.py --max-questions 5   # cap for testing
```

Required env var: `SUPABASE_DB_URL` (the direct connection on port 5432
or the pooled connection on 6543 — either works). Pull from Supabase
Dashboard → Project Settings → Database → Connection string.

## Extending the classifier

If `run_scoring.py` reports `skipped_unclassified` for any
question_ids, that means a new label vocabulary needs to be added.
The fix:

1. Run the question through `detect_scale()` manually, see what labels
   it's emitting.
2. Add the new vocabulary to the module-level constants near the top
   of `run_scoring.py` (e.g. add a new 5-pt scale family).
3. Add the matching branch in `detect_scale()` and a numeric
   mapping function if labels need conversion.
4. Add the new `scale_type` to this README's "Decision order" section
   so future maintainers know what's recognized.
5. Re-run the script — the question is now classified and loaded.

Don't add brittle "if question_id == 234" branches. The classifier
should always be label-driven, never id-driven.
