# BJL Database Schema — Investigator Reference

This is the canonical schema reference for the BJL Intelligence Engine investigator. Keep it up to date with the database. If the database changes, update this doc before changing investigator behavior.

## Top-level rule

**Use `bjl_responses` joined to `bjl_respondents` and `bjl_items` as the primary source for every quantitative question.** This is the long-form respondent-level table that supports any cross-tab. The legacy tables (`bjl_scores`, `bjl_demo_splits`) remain for backward compatibility but should not be used for new queries — they only support pre-computed marginal splits and don't intersect demographics.

## Tables

### `bjl_responses` — long-form respondent answers (~2.12M rows)

One row per (respondent, question, item, answer).

| Column | Type | Notes |
|---|---|---|
| id | bigserial | PK |
| respondent_id | text | joins to `bjl_respondents.respondent_id` and `bjl_verbatims.respondent_id` |
| question_id | integer | joins to `bjl_questions_v2.question_id` |
| item_id | integer | joins to `bjl_items.item_id` |
| item_name | text | denormalized for query convenience |
| raw_value | text | the literal answer text |
| numeric_value | numeric | parsed numeric (joy scale, momentum, ordinal numerics) |
| joy_index | numeric | 0-100 scale, ONLY populated for joy-scale items where respondent gave a numeric answer |
| is_selected | boolean | for select_all items, true if checked |
| fielding_id | text | 'm_YYYY_MM' format |
| year_month | text | 'YYYY-MM' format, 29 unique months from 2023-08 to 2026-03 |

**Critical:** `joy_index` is ONLY for items where respondents gave numeric ratings. For label-scale questions (agreement, frequency, importance, familiarity, likelihood-text), `joy_index` and `numeric_value` are NULL by design. Report those as distributions of `raw_value`, not averages. See `bjl_scale_labels` for canonical ordering.

### `bjl_respondents` — full demographic profile (~12,663 rows)

One row per respondent.

| Column | Notes |
|---|---|
| respondent_id | PK, joins to `bjl_responses` and `bjl_verbatims` |
| age_band | granular: '18 to 24', '25 to 29', etc. through '80 to 89' |
| generation | derived: Gen Z / Millennial / Gen X / Boomer / Silent |
| gender | Female / Male / Non-binary/Other / Trans M/F / Prefer not |
| income_bracket | 9 bands: 'Less than $25,000' through '$200,000 or more' |
| state, region, city, postal | Northeast/Midwest/South/West for region |
| latitude, longitude | numeric |
| employment_status, employment_detail | use `employment_detail` (newer column, higher fill) |
| occupation | text |
| marital_status | text |
| parental_status | derived: 'Parent' / 'Non-parent' / 'Unknown' |
| children_under_18 | '0' / '1' / '2' / '3 or more' |
| hispanic_origin | text |
| race_american_indian, race_asian, race_black, race_hispanic, race_middle_eastern, race_pacific_islander, race_white | boolean per race |
| race_other | text write-in |
| decisionmaker_vacation, decisionmaker_internet, decisionmaker_car, decisionmaker_groceries, decisionmaker_bank, decisionmaker_vacation_activities, decisionmaker_car_insurance, decisionmaker_home_furnishing | text — household-decision-maker flags from the Decision_Maker battery |

### `bjl_items` — one row per (question, item) (~5,391 rows)

| Column | Notes |
|---|---|
| item_id | PK |
| question_id | FK to `bjl_questions_v2` |
| item_name | the literal item text from the survey |
| primary_topic | one of 16 canonical primary topics (see `bjl_taxonomy_v2`) |
| subtags | text array — zero or more canonical subtags |
| canonical_brand | normalized brand name when `is_brand=true` |
| is_brand, is_location | booleans |
| canonical_location | normalized place name when `is_location=true` |

After the Haiku retag, `primary_topic` and `subtags` are reliable for filtering by industry. Trust them.

### `bjl_questions_v2` — question catalog (~415 rows)

| Column | Notes |
|---|---|
| question_id | PK |
| question_text | full question text |
| question_type | joy_scale / likelihood_scale / familiarity_scale / trust_scale / frequency_scale / agreement_scale / importance_scale / select_all / single_select / open_end / numeric / momentum |
| primary_topic | inherited up from items, or set explicitly for question-level filtering |
| subtags | array |
| intent_tag | joy / trust / familiarity / likelihood / preference / behavior / emotion / frequency / importance / agreement / identity / decision_maker / life_context |
| concept_tags | text[] — strategic-concept tags for question discovery beyond keyword search (e.g. `furniture_journey`, `financing_journey`, `retail_in_store`). GIN-indexed. Use `concept_tags && ARRAY['...']` for any-overlap, `@>` for must-contain-all. See "Concept-tag taxonomy" section. |
| short_label | 5-10 word descriptor of what the question measures |
| n_items | how many items the question has |

**Concept-tag taxonomy** (initial set, extensible):
- `furniture_journey` — moments in furniture buying, choosing, owning, living-with arc
- `home_identity` — what home means: pride, family, identity expression
- `financing_journey` — financing as an emotional/experiential layer
- `prequalification` — prequalification offers and their effects
- `retail_in_store` — physical retail experience
- `retail_online` — online or app-based retail experience
- `significant_purchase` — major/significant purchase moment specifically
- `new_purchase_meaning` — what a new purchase means emotionally
- `home_transformation` — post-purchase realization phase

**Population status:** populated by an initial Haiku tagging pass on 2026-05-13 (37 of 446 questions tagged with at least one concept). Default for un-tagged questions is `ARRAY[]::text[]`. Tags expand over time as new strategic territories are surfaced.

### `bjl_respondent_usage` — category usage screener results (~44,816 rows)

One row per (respondent, category) combination. Built from screener questions that ask whether or how often respondents engage with a category.

| Column | Notes |
|---|---|
| respondent_id | FK |
| category | alcohol / orange_juice / hot_dogs / yogurt / snacks / nonalcoholic_beverages / home_internet / knows_isp / casinos / auto_racing / horse_racing / gambling / exercise / vitamins_supplements / dr_teals / travel_leisure / travel_domestic / travel_international / travel_business / planning_kennedy_space / planning_orlando / travel_planning_horizon / news_engagement / outlook_2026 |
| usage_level | varies by category — for alcohol: Heavy / Frequent / Moderate / Light / Never |
| source_question_id | which screener provided this |

**Use this table for consumer filtering on consumption-style questions.** When asking about beer joy or casino joy or any product category, `JOIN bjl_respondent_usage` and filter by appropriate usage_level.

### `bjl_scale_labels` — canonical ordering for label distributions (~49 rows)

When reporting distributions of `raw_value` for agreement / frequency / importance / familiarity / likelihood-text / 3-point-non-joy ordinals, JOIN this table to display labels in semantic order rather than alphabetical.

| scale_family | label | display_order | semantic_position |
|---|---|---|---|
| agreement | Strongly agree | 1 | top |
| agreement | Agree | 2 | high |
| ... | ... | ... | ... |

### `bjl_taxonomy_v2` — reference for valid tag values (~107 rows)

16 primary topics, 78 subtags, 13 intent tags. Query this to discover what values are valid before writing filters.

### `bjl_verbatims` — open-end responses (~62,755 rows)

| Column | Notes |
|---|---|
| respondent_id | FK |
| response_text | what the consumer wrote |
| question_text | the prompt |
| year_month | 'YYYY-MM' fielding bucket |
| fielding_id | 'm_YYYY_MM' for month metadata |
| generation, gender, income_bracket, region, parental_status | denormalized demographic columns |
| category, category_key | categorization of the response |
| is_quotable | pre-flagged quotability — ALWAYS filter `is_quotable = true` for output |
| sentiment | positive / negative / mixed / neutral |
| themes | text[] — thematic tags |
| joy_modes, tensions, functional_jobs, occasions | text[] — **SPARSE. Non-empty on 33.0% / 5.1% / 26.4% / 23.6% of rows respectively.** An empty array means no tag was assigned, which is NOT evidence the respondent lacks that attribute. Never compute a rate over all verbatims — see "Population status and the denominator rule" below. Valid values in Reference vocabularies; per-tag confidence in `bjl_tag_calibration`. |
| search_vector | tsvector — full-text index on response_text |
| embedding | vector — semantic embedding |

Brand mentions: brand mentions in verbatims often appear in unexpected categories (Cracker Barrel under travel_hospitality because the question was framed in road-trip context). Use `retrieve_verbatims_full_text(...)` to bypass category filtering for entity searches.

## Legacy tables (do not write to, generally do not read)

- `bjl_scores` (~3,589 rows) — pre-aggregated; only use for cross-checking new query results against published numbers
- `bjl_demo_splits` (~560 rows) — pre-computed marginal splits; same caveat
- `bjl_questions` (old version) — kept for backward compat, use `bjl_questions_v2` instead
- `bjl_fieldings` (~29 rows) — reference table for fielding metadata: `fielding_id` (`'m_YYYY_MM'`), `year_month`, `field_start`, `field_end`, `n_respondents`, `notes`
- `bjl_waves` — DO NOT USE. See Temporal guardrails below.

### `bjl_laws` — synthesized strategic frameworks (~46 rows)

PETERMAYER's accumulated findings, written as numbered laws with title, statement, evidence summary, implication, and applies_to_* arrays for categories / joy_modes / tensions / demographics. Synthesized layer, not raw data. Use them to frame interpretations during thorough investigations. Pull applicable laws by category overlap or topic match. The `retrieve_laws(...)` and `retrieve_laws_semantic(...)` RPCs are convenience wrappers.

## Workbench tables — real, but not investigation surfaces

These two back the Opportunity Bulletin. They are documented here because their DDL now lives in `migrations/` and a schema reference that omits them is how they went undocumented in the first place. They are not sources of evidence: nothing in them was measured, and no finding should ever be built by querying them.

**Do not join `bjl_marketplace_signals` to any respondent table.** A signal is what the market said; a score is what respondents were measured saying. Kept separate, a card can cite both and a reader can tell which is which. Joined, the distinction is gone and cannot be recovered from the output.

### `bjl_opportunities` — the register (one row per card)

| Column | Notes |
|---|---|
| opportunity_id | PK |
| engagement | groups cards by client engagement |
| title, action | what the card is called, what to do about it |
| claim_summary, claim_population, claim_items | the claim triple: what is true, who it holds for, which item_ids it rests on. A claim without a population is not a claim. `claim_items` is **not** blanket NOT NULL — see the evidence constraint below |
| evidence_tier | `measured` / `modeled` / `unmeasured` / `signal-only`, CHECK-constrained. Derived from the source rows, never chosen freehand |
| signal_ids | int[] — marketplace signals cited, by reference only |

**The evidence constraint (`bjl_opportunities_evidence_chk`).** A card's tier and its audit trail must agree:

- `measured` / `modeled` — `claim_items` must be non-empty.
- `signal-only` — `signal_ids` must be non-empty. These cards rest on marketplace observations by definition, so requiring `claim_items` would outlaw them.
- `unmeasured` — neither is required.

Earlier revisions of this doc claimed `claim_items` was blanket NOT NULL. That was wrong and the database was right; the rule was corrected to the tier-aware form on 2026-08-04. Note also what the constraint cannot see: it tests only non-emptiness, so it cannot catch a `claim_summary` citing a figure whose row was excluded from `claim_items`. That case is closed upstream by the generator's row-level exclusion rule — a source row that cannot resolve to an `item_id` contributes nothing to a draft anywhere, not merely to `claim_items`.
| status | `machine_draft` → `candidate` → `reviewed` → `selected` → `shipped` → `retired`, CHECK-constrained |
| origin | `analyst` or `harvest` |
| source_run_id | `bjl_query_jobs.job_id` of the generating run. No FK: the card outlives the job |
| generated_by | jsonb — model, prompt version, generated_at, for harvested drafts |
| claim_hash | harvest idempotency key, unique per (source_run_id, claim_hash) |
| promoted_by, promoted_at | the human act that turns a machine draft into a candidate |
| register_number, prediction_id, window_label, window_date, owner, notes | lineage, timing and ownership |

### `bjl_marketplace_signals` — marketplace observations

| Column | Notes |
|---|---|
| signal_id | PK |
| engagement, source, theme, signal_type | where it belongs and what kind of thing it is. `source` defaults to `waldo` |
| headline, detail, exact_quote, source_url, urgency | the observation itself |
| external_id | the source's own id. Unique per engagement among live rows, so re-ingesting supersedes rather than duplicates |
| owned_source | true when the brand itself is the source |
| captured_at | when the observation was made, and the basis of the staleness warning on any card citing it |
| superseded_by | signal_id of the row that replaced this one. Non-null means historical |
| raw | jsonb — the payload as pasted |

### `bjl_item_resolutions` — the item-name adjudication worklist

`bjl_scores` has no `item_id`; it keys back to `bjl_items` by name, and 366 corpus names map to more than one item. This table is where that ambiguity gets decided once, by a person, and remembered.

| Column | Notes |
|---|---|
| resolution_id | PK |
| item_name | the ambiguous name. Unique — the question is asked once and answered once |
| candidate_item_ids | int[] — every `bjl_items.item_id` sharing the name. Derived fact, not a judgment |
| suggested_item_id, suggestion_basis | machine pre-ranking so the human act is confirmation rather than research. Never read by `bjl_corpus_search` |
| status | `pending` / `resolved` / `unresolvable` |
| resolved_item_id, resolved_by, resolved_at | the resolution triple. All three or none — a resolution is only a resolution when it is attributable. Constrained to a member of `candidate_item_ids` |
| resolution_note | why a name is `unresolvable`. Allowed only on that status |

`bjl_corpus_search` reads only `status = 'resolved'` rows, so a human adjudication immediately widens what the next generated draft can ground. The table is also the eventual backfill source for a real `item_id` column on `bjl_scores`.

## Reference vocabularies

The four BJL frameworks are tagged via reference tables. Each table has at minimum `_key` (snake_case identifier used in array filters) and `display_name`. Some include `short_definition` / `purchase_mapping` / `benchmark_finding` columns; query the table directly for the full definitions when needed.

### Joy modes (14, table `bjl_joy_modes`)

`achievement, aesthetic, awe, freedom, hedonic, inspirational, physical, playful, relational, self_actualization, sentimental, spiritual, tranquil, triumph`

`tranquil` was added as the 14th mode per Law 9.

### Tensions (15, table `bjl_tensions`)

`aspiration_vs_acceptance, challenger_vs_legacy, control_vs_surrender, digital_vs_physical, discovery_vs_comfort, dwelling_vs_advancing, individual_vs_communal, introvert_vs_extrovert, luxury_vs_value, moderation_vs_indulgence, performance_vs_pleasure, present_vs_future, self_vs_others, served_vs_overlooked, tradition_vs_modern`

`dwelling_vs_advancing` and `served_vs_overlooked` were added in v6.

### Functional jobs (23, table `bjl_functional_jobs`)

`build_belonging, cheer_team, compete, connect_remotely, create_memory, demonstrate_care, display_taste, escape_routine, express_creativity, feel_proud, immerse_in_story, learn_grow, mark_milestone, nourish_others, plan_future, preserve_tradition, provide_security, refuel, relax_recover, relieve_anxiety, reward_self, share_experience, signal_identity`

### Occasions (26, table `bjl_occasions`)

`alone_time, anticipation, birthday, celebration, evening, everyday, gathering, gift_giving, holiday, hosting, in_moment, live_event, mealtime, memory, morning, post_purchase, purchase_moment, service, shopping, special_occasion, sports_viewing, transition, travel_journey, vacation, weekend, work`

`service` was added in v6 to capture customer-service / help-seeking interactions distinct from `shopping` and `post_purchase`.

### Population status and the denominator rule — READ BEFORE COUNTING TAGS

**These four columns are sparse, not complete.** An earlier version of this document said all four were "populated for every substantive verbatim." That was false, by a factor of 3 on joy_modes and roughly 20 on tensions. It was wrong in a specific, load-bearing way: it invited the reader to treat an absent tag as a measured zero.

Measured against all 67,635 `bjl_verbatims` rows:

| Framework | Rows with ≥1 tag | % of all rows | Tag instances | Keys |
|---|---|---|---|---|
| joy_modes | 22,326 | **33.0%** | 31,603 | 14 |
| functional_jobs | 17,882 | **26.4%** | 22,777 | 23 |
| occasions | 15,969 | **23.6%** | 19,512 | 26 |
| tensions | 3,476 | **5.1%** | 3,593 | 15 |

Most-used keys: joy_modes — relational, hedonic, tranquil, inspirational. functional_jobs — share_experience, build_belonging, relax_recover, immerse_in_story. occasions — vacation, anticipation, shopping, everyday. tensions — luxury_vs_value, present_vs_future, dwelling_vs_advancing, aspiration_vs_acceptance.

Note the shape of the old error: `~32K` was the joy_modes *tag instance* count (31,603) reported as a *verbatim* count. Row counts and instance counts are different numbers and one is not a proxy for the other — a verbatim can carry several tags.

**What an empty array means.** It means no tag was assigned. It does NOT mean the respondent lacks that attribute. Three different situations all produce an empty array and they are indistinguishable from the column alone:

1. The tagger examined the row and found nothing that met its threshold.
2. The row was never scanned. 4,364 rows have `framework_scanned_at IS NULL` — 484 too-short verbatims (`response_text` < 5 chars, deliberately skipped) and the entire `sp_2025_01_rivalry` fielding (3,880 rows, never scanned).
3. The tagger has low recall on that key. See `bjl_tag_calibration` — tensions in particular is a precision-oriented layer, which is why it lands at 5.1%.

**The denominator rule — mandatory.** Any rate, share, or percentage over these four columns must be computed over rows that carry at least one tag in that framework. Never over all verbatims, and never over `COUNT(*)` of a filtered set that includes untagged rows.

```sql
-- CORRECT: denominator is rows tagged in this framework
SELECT t AS tension, COUNT(*) AS n,
       ROUND(100.0 * COUNT(*) / (
         SELECT COUNT(*) FROM bjl_verbatims
         WHERE array_length(tensions, 1) > 0   -- same filters as the outer query
       )::numeric, 1) AS pct_of_tensioned
FROM bjl_verbatims v, unnest(v.tensions) AS t
WHERE array_length(v.tensions, 1) > 0
GROUP BY t ORDER BY n DESC;

-- WRONG: denominator is every verbatim, 94.9% of which were never tensioned.
-- Produces a real numerator over a false base. Nothing downstream catches this.
SELECT t, ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM bjl_verbatims)::numeric, 1)
FROM bjl_verbatims v, unnest(v.tensions) AS t GROUP BY t;
```

**How to report it.** State the tagged base alongside the rate, the same way every other surface of this tool carries its n: "of the 3,476 verbatims carrying any tension tag, 18% cite luxury_vs_value" — not "18% of consumers express a luxury-vs-value tension." The second sentence is a claim about the population and this data does not support it.

Filter with `'relational' = ANY(joy_modes)` or `joy_modes && ARRAY['hedonic','playful']` for overlap. Same patterns work for the other three array columns.

## Tag confidence — `bjl_tag_calibration`

Each of the 78 framework tags has a calibration record in `bjl_tag_calibration` derived from the v6 50-sample empirical run. Use it to scale how confidently a finding can be cited.

Schema:
- `framework` — joy_modes / tensions / functional_jobs / occasions
- `tag_key` — matches the keys in the four reference tables
- `precision`, `recall` — empirical from the 50-sample (NULL if no calibration data)
- `gold_sample_n`, `pred_sample_n` — sizes for the precision/recall denominators
- `confidence_band` — `'high'` | `'medium'` | `'low'` | `'untested'`
- `notes` — calibration-specific guidance per tag

### Confidence-band semantics

The `confidence_band` column tells the synthesizer how to scale its voice when surfacing tag-derived findings. Bands are assigned from empirical precision/recall on the calibration sample, with manual override when small samples make the empirical value misleading.

| Band | Criteria | Voice instruction |
|---|---|---|
| `high` | P ≥ 0.80 AND R ≥ 0.50 AND gold ≥ 2 | Cite confidently. No hedge. |
| `medium` | P 0.50–0.79, OR high P with low recall | Present directionally. Mild hedge ("looks like", "skews toward"). |
| `low` | P < 0.50, OR known over-fires in production | Hedge explicitly OR move to "worth testing" block. |
| `untested` | No calibration sample for this tag | Treat as medium-low. Flag uncertainty. |

### Default precision rules

Some tags have a band but a NULL precision (manually-assigned band, no empirical data). The `bjl_tag_precision()` helper encapsulates the defaults so callers don't reinvent them:

| State | Precision returned by helper |
|---|---|
| Precision non-null in the table | The stored value |
| Precision NULL, band ∈ {`high`, `medium`, `low`} | **1.0** (trust the band assignment) |
| Precision NULL, band = `untested` | **0.65** (medium-low penalty by default) |
| Tag not in `bjl_tag_calibration` at all | **NULL** (caller decides; do not silently weight) |

The NULL return for unregistered tags is intentional: a new tag that hasn't been added to the calibration table should NOT silently get a 1.0 weight. Register the tag first.

### Helper functions

**`bjl_tag_precision(framework text, tag_key text) → numeric`**
Returns the weight to apply to a tag's count. Use this in any query that needs to weight tag-derived metrics by empirical accuracy.

```sql
SELECT
  mode AS joy_mode,
  COUNT(*) AS raw_n,
  COUNT(*) * bjl_tag_precision('joy_modes', mode) AS weighted_n,
  c.confidence_band,
  c.notes AS confidence_note
FROM bjl_verbatims, unnest(joy_modes) AS mode
LEFT JOIN bjl_tag_calibration c
  ON c.framework = 'joy_modes' AND c.tag_key = mode
WHERE -- ... filters ...
GROUP BY mode, c.confidence_band, c.notes
ORDER BY raw_n DESC;
```

**`bjl_tag_calibration_coverage() → TABLE(drift_type, framework, tag_key, details)`**
Returns one row per drift between `bjl_tag_calibration` and the four framework reference tables. Empty result = aligned. Drift types: `missing_in_calibration` (tag in reference table, not in calibration), `orphan_in_calibration` (tag in calibration, not in reference table), `invalid_precision` (outside [0, 1]), `invalid_band` (not in valid set).

Run before deploying any tagger or framework change:

```sql
SELECT * FROM bjl_tag_calibration_coverage();
-- Empty result = clean. Any rows = drift to resolve.
```

### Maintenance protocol

When adding or removing a framework tag:
1. Edit the relevant reference table (`bjl_joy_modes`, `bjl_tensions`, `bjl_functional_jobs`, `bjl_occasions`)
2. Add a row to `bjl_tag_calibration` (band='untested' if no calibration data yet)
3. Run `SELECT * FROM bjl_tag_calibration_coverage();` and resolve any drift it reports
4. Run a new calibration pass to populate precision/recall when sample is available

The synthesizer reads `confidence_band` and chooses hedging language. Don't bury the band — it belongs in scratch alongside the count.

### Quantitative findings have NO tag-uncertainty

Joy Index, demographic splits, item rankings, response counts, and percentages from `bjl_responses` and `bjl_scores` have **zero Haiku error**. Margin is statistical sampling error only. Only verbatim-derived framework findings are subject to the confidence-band machinery above.

## Joy index math (scale-aware)

The Joy Index is methodologically defined as a transformation of the **9-point joy scale only** (anchored "-3 Definitely NOT Joy" through 0 to "5 Maximum Joy!"), normalized to a 0-to-100 range. **Do NOT compute or report JI for items measured on any other scale**, even if the user phrases their question as "joy score" or "joy index".

For 9-point joy_scale items (the only items where JI is methodologically valid):
- `numeric_value` = parsed integer from raw_value (range -3 to +5)
- `joy_index` = `(numeric_value + 3) × (100/8)` — normalizes -3 to 0, +5 to 100
- Filter to these items via `bjl_questions_v2.question_type = 'joy_scale'` joined to items / responses

For 3-point ordinal items (Very much so / Somewhat / Not really or Not at all):
- Report **top-box percentage**: share who chose "Very much so" / strongest endorsement
- OR report the full distribution across all options when granularity matters
- `joy_index` on these rows is methodologically null and should be ignored even if a value exists in the table

For agree/disagree, likelihood, trust, familiarity, importance, frequency scales:
- Report top-box or top-2-box percentages, OR the full distribution
- Never compute a JI-equivalent number

For mixed views (journey maps, category surveys):
- Separate JI items from top-box items in the output. Don't blend them in a combined "score" column.

Public-population JI is `AVG(joy_index)` across all respondents, **filtered to joy_scale items**. Consumer-only JI requires JOIN to `bjl_respondent_usage`.

```sql
-- Correct: JI averaged only across joy_scale items
SELECT i.item_name, AVG(r.joy_index) AS ji, COUNT(*) AS n
FROM bjl_responses r
JOIN bjl_items i ON i.item_id = r.item_id
JOIN bjl_questions_v2 q ON q.question_id = i.question_id
WHERE q.question_type = 'joy_scale'
  AND r.joy_index IS NOT NULL
  AND -- ... other filters ...
GROUP BY i.item_name
ORDER BY ji DESC;

-- For 3-point ordinal items: top-box percentage instead
SELECT i.item_name,
       100.0 * COUNT(*) FILTER (WHERE r.raw_value = 'Very much so')
         / NULLIF(COUNT(*), 0) AS top_pct,
       COUNT(*) AS n
FROM bjl_responses r
JOIN bjl_items i ON i.item_id = r.item_id
JOIN bjl_questions_v2 q ON q.question_id = i.question_id
WHERE q.question_type = 'description_scale_0_to_5'  -- or whichever 3-point variant
  AND -- ... other filters ...
GROUP BY i.item_name
ORDER BY top_pct DESC;
```

## Consumer filter rule

For any consumption-style category (alcohol, casinos, horse racing, auto racing, hot dogs, yogurt, dr_teals, exercise, vitamins, internet service, leisure travel, business travel), the default investigator behavior is to filter respondents to actual consumers using `bjl_respondent_usage`. The exact filter varies by category — see `consumer_filter_rules.md` for the canonical mapping per category.

For wellbeing/state questions (joy from a financial plan, joy from time with loved ones, mental state), DO NOT apply a consumer filter. The full population is the right base.

## Temporal guardrails

The ONLY temporal column to query is `year_month` (text, format `'YYYY-MM'`), populated on every row of `bjl_responses` and `bjl_verbatims`. It joins to `bjl_fieldings.year_month` for fielding metadata.

Do NOT use:
- `wave` — internal jargon, opaque to users, and collapses many months into two buckets. Do not filter, group, or label output by wave. Do not surface the word "wave" in any investigator note or final response.
- `created_at` — database ingestion timestamp, not fielding date. Every row has the same value. Useless for temporal analysis.
- `bjl_waves` lookup — legacy table, ignore.

For "last N months" questions: filter `year_month >= to_char(CURRENT_DATE - INTERVAL 'N months', 'YYYY-MM')`. For "how has X shifted" / "momentum of Y" / trend framings with no explicit window: default to the last 6 months. For a named month or quarter: pin the exact `year_month` values. When writing the response, name months directly ("Jan-Mar 2026", "the last six months"), never "Wave 2" or similar.

## Verbatim text search

When searching verbatim `response_text` for keywords, use word-boundary regex to avoid false positives (`'rum'` matching `'instrument'`). Postgres word-boundary anchors are `\m` (start) and `\M` (end), or `\y` for either side.

```sql
WHERE response_text ~* '\y(beer|beers)\y'
```

Include common inflections and compounds unless the question explicitly calls for a single exact form:

| stem | pattern |
|---|---|
| `run` | `run|running|ran|runs` |
| `buy` | `buy|buying|bought|buys|purchased|purchasing|purchase` |
| `fuck` | `fuck|fucking|fucked|fucks` |
| `shit` | `shit|shits|shitty|bullshit|dipshit|horseshit` |

`ILIKE` only tells you whether a word appears, not how often. For word-frequency or instance-counting questions, use `regexp_matches` with the `'g'` flag and count the rows returned:

```sql
SELECT COUNT(*) FROM bjl_verbatims, regexp_matches(response_text, '\y(pattern)\y', 'gi');
```

## RPC functions

Convenience wrappers around the underlying tables. Call via `SELECT * FROM function_name(args)`. The RPCs run with `SECURITY DEFINER`; raw SQL against the underlying tables works too.

| Function | Purpose |
|---|---|
| `retrieve_items_by_tags(category_keys, joy_modes, themes, ...)` | Tag-based item retrieval against `bjl_items`/`bjl_scores` |
| `retrieve_items_full_text(query)` | Full-text search on item names and questions |
| `retrieve_items_fuzzy(...)` | Fuzzy matching on item names |
| `retrieve_items_semantic(query_embedding, ...)` | Vector similarity on items |
| `retrieve_verbatims(joy_modes, themes, category_keys, ...)` | Tag-based verbatim retrieval |
| `retrieve_verbatims_full_text(entity_query, joy_modes, generation, gender, require_quotable, limit)` | Full-text verbatim search WITHOUT category filtering. **Use this for any brand/entity query** — brand mentions often live under unexpected categories. |
| `retrieve_verbatims_semantic(query_embedding, ...)` | Vector similarity on verbatims |
| `retrieve_demo_splits(item_name, ...)` | Demo split retrieval |
| `retrieve_laws(...)` | Law retrieval by category overlap |
| `retrieve_laws_semantic(...)` | Vector similarity on laws |

## Cross-tab patterns

### Pattern 1 — single-item joy by demographic intersection

```sql
SELECT p.generation, p.gender,
       COUNT(*) AS n, ROUND(AVG(r.joy_index)::numeric, 1) AS ji
FROM bjl_responses r
JOIN bjl_respondents p ON p.respondent_id = r.respondent_id
JOIN bjl_items i ON i.item_id = r.item_id
JOIN bjl_respondent_usage u ON u.respondent_id = r.respondent_id AND u.category = 'alcohol'
WHERE i.item_name = 'Drinking a BEER'
  AND r.joy_index IS NOT NULL
  AND u.usage_level IN ('Heavy','Frequent','Moderate')
  AND p.generation IS NOT NULL AND p.gender IS NOT NULL
GROUP BY p.generation, p.gender
ORDER BY p.generation, p.gender;
```

### Pattern 2 — topic-level scan (find what's strongest in a category)

**`primary_topic` and `subtags` are SEPARATE taxonomy levels** (16 canonical primary topics, 78 canonical subtags — see `bjl_taxonomy_v2.tag_type`). A category name like `home_goods_furniture` lives in only ONE of them. Filtering on the wrong level returns zero rows even when the category has dozens of items.

When the user names a category and you're unsure which level it belongs to, **default to the OR-against-both pattern**:

```sql
SELECT i.item_name, COUNT(*) AS n,
       ROUND(AVG(r.joy_index)::numeric, 1) AS ji
FROM bjl_responses r
JOIN bjl_items i ON i.item_id = r.item_id
WHERE (i.primary_topic = 'home_goods_furniture'
       OR 'home_goods_furniture' = ANY(i.subtags))
  AND r.joy_index IS NOT NULL
GROUP BY i.item_name
HAVING COUNT(*) >= 200
ORDER BY ji DESC
LIMIT 20;
```

This catches all matching items regardless of where the term sits in the taxonomy. Worked examples:
- `home_goods_furniture` is a **subtag only** — the 41 furniture items all have `primary_topic = 'home_life'` and `'home_goods_furniture' = ANY(subtags)`. A bare `primary_topic = 'home_goods_furniture'` filter returns zero rows.
- `financial_services` is a **primary_topic** — items have `primary_topic = 'financial_services'` and possibly subtags like `'investing'` or `'banking'`.
- `wine` is a **subtag** under `food_beverage` primary_topic.

Use the AND form (`primary_topic = X AND tag = ANY(subtags)`) only when you're deliberately narrowing within a known parent — e.g. "investing items WITHIN financial services":

```sql
WHERE i.primary_topic = 'financial_services'
  AND 'investing' = ANY(i.subtags)
```

When in doubt, query `bjl_taxonomy_v2 WHERE tag = $cat` to confirm the level before filtering, or just use the OR form — it's the safe default.

### Pattern 3 — label distribution (for non-numeric scales)

```sql
SELECT r.raw_value, sl.display_order, sl.semantic_position,
       COUNT(*) AS n,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER ()::numeric, 1) AS pct
FROM bjl_responses r
LEFT JOIN bjl_scale_labels sl ON sl.label = r.raw_value AND sl.scale_family = 'agreement'
WHERE r.question_id = $QID
GROUP BY r.raw_value, sl.display_order, sl.semantic_position
ORDER BY sl.display_order NULLS LAST;
```

### Pattern 4 — temporal trend

```sql
SELECT r.year_month,
       COUNT(*) AS n,
       ROUND(AVG(r.joy_index)::numeric, 1) AS ji
FROM bjl_responses r
JOIN bjl_items i ON i.item_id = r.item_id
WHERE i.primary_topic = 'travel'
  AND r.joy_index IS NOT NULL
  AND r.year_month >= '2025-10'
GROUP BY r.year_month
ORDER BY r.year_month;
```

### Pattern 5 — verbatim texture alongside numeric finding

```sql
SELECT v.response_text, v.year_month, v.question_text
FROM bjl_verbatims v
JOIN bjl_respondents p ON p.respondent_id = v.respondent_id
JOIN bjl_respondent_usage u ON u.respondent_id = p.respondent_id AND u.category = 'alcohol'
WHERE p.generation = 'Millennial' AND p.gender = 'Female'
  AND u.usage_level IN ('Heavy','Frequent','Moderate')
  AND v.response_text ILIKE '%wine%'
  AND v.is_quotable = true
  AND v.year_month >= '2025-10'
ORDER BY v.year_month DESC
LIMIT 20;
```

## Hard rules

1. **NEVER write DDL or DML.** SELECT only. The executor enforces this, but a write would fail and waste a query of your budget.
2. **Always include LIMIT.** Default `LIMIT 50` unless the question specifically needs more (cap at 500). The executor injects `LIMIT 500` if you forget.
3. **For verbatims reaching the synthesizer, filter `is_quotable = true`.**
4. **Array operators:**
   - `&&` for overlap (any element in common): `joy_modes && ARRAY['hedonic','playful']`
   - `= ANY()` for single-value match: `'relational' = ANY(joy_modes)`
   - `@>` for contains-all: `joy_modes @> ARRAY['hedonic','aesthetic']`
5. **Statement timeout is 5 seconds.** Large unfiltered scans will time out. Always filter by `question_id`, `item_id`, or item characteristics via `JOIN bjl_items` before aggregating across `bjl_responses`.
6. **Trailing semicolons.** The `execute_read_sql` wrapper appends its own. Do not include trailing semicolons in queries.

## Sample size discipline

Reject any cross-tab cell with n < 30 unless the user explicitly accepts the directional caveat. For specific JI claims to be defensible, n >= 50 is the working floor. The investigator should report sample sizes alongside every aggregate.
