# BJL Database Schema — Investigator Reference

This is the canonical schema reference for the BJL Intelligence Engine investigator. Keep it up to date with the database. If the database changes, update this doc before changing investigator behavior.

## Top-level rule

**Use `bjl_responses` joined to `bjl_respondents` and `bjl_items` as the primary source for every quantitative question.** This is the long-form respondent-level table that supports any cross-tab. The legacy tables (`bjl_scores`, `bjl_demo_splits`) remain for backward compatibility but should not be used for new queries — they only support pre-computed marginal splits and don't intersect demographics.

## Tables

### `bjl_responses` — long-form respondent answers (~2.18M rows)

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
| year_month | text | 'YYYY-MM' format, 30 unique months from 2023-08 to 2026-04 |

**Critical:** `joy_index` is ONLY for items where respondents gave numeric ratings. For label-scale questions (agreement, frequency, importance, familiarity, likelihood-text), `joy_index` and `numeric_value` are NULL by design. Report those as distributions of `raw_value`, not averages. See `bjl_scale_labels` for canonical ordering.

### `bjl_respondents` — full demographic profile (~13,064 rows)

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

### `bjl_items` — one row per (question, item) (~5,590 rows)

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

### `bjl_questions_v2` — question catalog (~446 rows)

| Column | Notes |
|---|---|
| question_id | PK |
| question_text | full question text |
| question_type | joy_scale / joy_scale_0_to_5 / likelihood_scale / familiarity_scale / trust_scale / frequency_scale / agreement_scale / importance_scale / importance_scale_0_to_5 / description_scale_0_to_5 / select_all / multi_select / single_select / open_end / numeric / momentum |
| primary_topic | inherited up from items, or set explicitly for question-level filtering |
| subtags | array |
| intent_tag | joy / trust / familiarity / likelihood / preference / behavior / emotion / frequency / importance / agreement / identity / decision_maker / life_context |
| n_items | how many items the question has |

### `bjl_respondent_usage` — category usage screener results (~45,217 rows)

One row per (respondent, category) combination. Built from screener questions that ask whether or how often respondents engage with a category.

| Column | Notes |
|---|---|
| respondent_id | FK |
| category | alcohol / wine / orange_juice / hot_dogs / yogurt / snacks / nonalcoholic_beverages / home_internet / knows_isp / casinos / auto_racing / horse_racing / gambling / exercise / vitamins_supplements / dr_teals / travel_leisure / travel_domestic / travel_international / travel_business / planning_kennedy_space / planning_orlando / travel_planning_horizon / news_engagement / outlook_2026 |
| usage_level | varies by category — for alcohol and wine: Frequent / Moderate / Light / Never (wine has no Heavy tier; the Q429 screener tops out at "regularly — once or twice a week") |
| source_question_id | which screener provided this. Wine = Q429 (April 2026 onward). |

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

### `bjl_verbatims` — open-end responses (~63,755 rows)

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
| joy_modes | text[] — populated for all months, see Reference vocabularies |
| tensions, occasions, functional_jobs | text[] — populated for 2026-04 onward (April load applied via `framework_scan.py`); pre-April rows still NULL/empty pending backfill |
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

## Reference vocabularies

The four BJL frameworks are tagged via reference tables. Each table has at minimum `_key` (snake_case identifier used in array filters) and `display_name`. Some include `short_definition` / `purchase_mapping` / `benchmark_finding` columns; query the table directly for the full definitions when needed.

### Joy modes (14, table `bjl_joy_modes`)

`achievement, aesthetic, awe, freedom, hedonic, inspirational, physical, playful, relational, self_actualization, sentimental, spiritual, tranquil, triumph`

`tranquil` was added as the 14th mode per Law 9.

**Population status:** `bjl_verbatims.joy_modes` is populated on all rows (the Haiku framework backfill completed). Filter with `'relational' = ANY(joy_modes)` or `joy_modes && ARRAY['hedonic','playful']` for overlap.

### Tensions (15, table `bjl_tensions`)

`aspiration_vs_acceptance, challenger_vs_legacy, control_vs_surrender, digital_vs_physical, discovery_vs_comfort, forgiveness_vs_foresight, individual_vs_communal, introvert_vs_extrovert, luxury_vs_value, moderation_vs_indulgence, performance_vs_pleasure, present_vs_future, savings_vs_spending, self_vs_others, tradition_vs_modern`

**Population status:** `bjl_verbatims.tensions` is populated for 2026-04 onward (886 April verbatims tagged via Haiku 4.5 in May 2026). Pre-April rows remain NULL pending the historical backfill. The 15 framework definitions in `bjl_tensions` are queryable today for "what tensions does BJL track?" questions. When filtering on this array, also filter `year_month >= '2026-04'` until the historical backfill lands.

### Functional jobs (24, table `bjl_functional_jobs`)

`build_belonging, cheer_team, compete, connect_remotely, create_memory, demonstrate_care, display_taste, escape_routine, express_creativity, feel_proud, immerse_in_story, learn_grow, mark_milestone, nourish_others, plan_future, preserve_tradition, provide_security, refuel, relax_recover, relieve_anxiety, reward_self, share_experience, signal_identity, signal_status`

**Population status:** Same as tensions — populated for 2026-04 onward, NULL pre-April pending historical backfill.

### Occasions (25, table `bjl_occasions`)

`alone_time, anticipation, birthday, celebration, evening, everyday, gathering, gift_giving, holiday, hosting, in_moment, live_event, mealtime, memory, morning, post_purchase, purchase_moment, shopping, special_occasion, sports_viewing, transition, travel_journey, vacation, weekend, work`

**Population status:** Same as tensions — populated for 2026-04 onward, NULL pre-April pending historical backfill.

## Joy index math

For joy-scale questions:
- 5-point joy scale (`-3..+5` numeric in raw_value): `numeric_value` = parsed integer, `joy_index` = `numeric_value × 20`. Range -60 to +100.
- 3-point joy scale (Very much so / Somewhat / Not really or Not at all): `numeric_value` ∈ {3, 2, 1}, `joy_index` ∈ {60, 40, 20}.
- 4-point joy variant (with "One of my favorites!" label): "One of my favorites!" is excluded from the joy mean per BJL convention. Both `numeric_value` and `joy_index` are NULL for that label.

Public-population JI is `AVG(joy_index)` across all respondents. Consumer-only JI requires JOIN to `bjl_respondent_usage`.

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

### April 2026 wave additions

The April 2026 fielding (`year_month = '2026-04'`, `fielding_id = 'm_2026_04'`, n=401 respondents) added two new survey batteries plus a cross-cutting summative pair:

- **Banking battery (Q416–Q428)** — current banking situation, institution type, tenure, switching triggers, joy drivers (`joy_scale_0_to_5`), importance drivers (`importance_scale_0_to_5`), description scale, and an open-end (Q428) on what consumers wish their bank understood about their financial life.
- **Wine battery (Q429–Q444)** — Q429 is the relationship-with-wine screener that feeds `bjl_respondent_usage` (category=`wine`). Q433–Q436 are joy/importance scales on wine occasions and choice drivers. Q438 (open-end) and Q440 (memorable wine experience open-end) are the wine verbatims. Q443/Q444 capture price ranges as `mixed`-type.
- **Cross-category joy preference (Q446, multi_select)** — the joy_mode preference question. Each item maps to one of the 14 canonical joy modes; respondents pick the modes that feel most true to them across categories. Use this to filter respondents by self-reported joy-mode affinity.

These questions only have responses for `year_month = '2026-04'` (and forward, once subsequent waves carry them). Filter by `year_month` accordingly; do not assume historical coverage.

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

```sql
SELECT i.item_name, COUNT(*) AS n,
       ROUND(AVG(r.joy_index)::numeric, 1) AS ji
FROM bjl_responses r
JOIN bjl_items i ON i.item_id = r.item_id
WHERE i.primary_topic = 'financial_services'
  AND 'investing' = ANY(i.subtags)
  AND r.joy_index IS NOT NULL
GROUP BY i.item_name
HAVING COUNT(*) >= 200
ORDER BY ji DESC
LIMIT 20;
```

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
