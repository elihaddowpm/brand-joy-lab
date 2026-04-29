<!-- Note for future maintainers: these patterns were originally written for the SSE-flow investigator
(circa Apr 2025) and reference the legacy aggregate tables (bjl_scores, bjl_demo_splits, bjl_verbatims)
plus the retrieve_* RPC family. The strategic patterns underneath the SQL — four-pass brand lookups,
adjacency pivots when direct data is thin, where demographic gaps are the strategic finding — remain
architecture-agnostic and useful for thinking about investigations on the new long-form schema
(bjl_responses + bjl_items + bjl_respondents). When porting a pattern, translate the table references
to the long-form tables. The reasoning notes (the prose above each query block) are the durable part. -->

# Example Investigative Patterns (18 worked examples)

These examples teach patterns that produce strong outputs. Each shows: the user question, the intent tag (if any), the reasoning, and the actual queries. Adapt, don't copy.

---

## INTENT: Brand Lookup

### Example 1: Established brand with rich data
Question: "Tell me about Cracker Barrel"
Intent: Brand Lookup

Reasoning: Four-pass pattern. (1) Direct hits in scores. (2) Demo splits — the demographic story is often the most strategic finding. (3) Verbatims for emotional voice (via full-text RPC to bypass category misrouting). (4) Adjacent territory if thin.

Queries:
```sql
-- 1. Scores: direct mentions
SELECT item_name, question, joy_index, top_pct, top_response, n
FROM bjl_scores
WHERE item_name ILIKE '%cracker barrel%' OR question ILIKE '%cracker barrel%'
LIMIT 50;

-- 2. Demo splits
SELECT * FROM bjl_demo_splits
WHERE item_name ILIKE '%cracker barrel%';

-- 3. Verbatims via full-text RPC (bypasses category filter)
SELECT * FROM retrieve_verbatims_full_text('Cracker Barrel', NULL, NULL, NULL, true, 15);

-- 4. Theme/mode shape
SELECT unnest(themes) AS theme, unnest(joy_modes) AS mode, COUNT(*) AS n
FROM bjl_verbatims
WHERE response_text ILIKE '%cracker barrel%' AND is_quotable = true
GROUP BY theme, mode
ORDER BY n DESC LIMIT 20;
```

---

### Example 2: Brand with data in unexpected category
Question: "What do we know about Discover Puerto Rico?"
Intent: Brand Lookup

Reasoning: DMO — data lives under travel_destinations but brand isn't named directly. Search for "Puerto Rico" the place. Pull demo splits. Check adjacent Caribbean destinations for benchmarks.

```sql
-- 1. Scores
SELECT item_name, question, joy_index, n FROM bjl_scores
WHERE item_name ILIKE '%puerto rico%' OR question ILIKE '%puerto rico%'
LIMIT 30;

-- 2. Demo splits — PR vs other Caribbean destinations
SELECT item_name, overall_ji, ji_male, ji_female, gender_gap, ji_gen_z, ji_boomer, gen_z_vs_boomer, n_overall
FROM bjl_demo_splits
WHERE item_name IN ('Puerto Rico', 'Hawaii', 'Bahamas', 'Cancun', 'Caribbean')
   OR item_name ILIKE '%caribbean%'
LIMIT 20;

-- 3. Verbatims via full-text
SELECT * FROM retrieve_verbatims_full_text('Puerto Rico', NULL, NULL, NULL, true, 15);

-- 4. Travel/destination laws
SELECT law_id, title, statement, implication FROM bjl_laws
WHERE 'travel_destinations' = ANY(applies_to_categories);
```

---

### Example 3: Thin direct data, rich adjacent
Question: "Brand lookup for Jolly Rancher"
Intent: Brand Lookup

Reasoning: Direct check first. If thin (<~5 hits across all tables), pivot to category benchmarking. Frame the response as adjacent.

```sql
-- 1. Direct check across all four tables in one query
SELECT 'scores' AS source, COUNT(*) AS n FROM bjl_scores WHERE item_name ILIKE '%jolly rancher%'
UNION ALL SELECT 'demo_splits', COUNT(*) FROM bjl_demo_splits WHERE item_name ILIKE '%jolly rancher%'
UNION ALL SELECT 'verbatims', COUNT(*) FROM bjl_verbatims WHERE response_text ILIKE '%jolly rancher%'
UNION ALL SELECT 'laws', COUNT(*) FROM bjl_laws WHERE statement ILIKE '%jolly rancher%' OR evidence ILIKE '%jolly rancher%';

-- 2. Adjacent: candy / sweets benchmarks
SELECT item_name, joy_index, n, question
FROM bjl_scores
WHERE (item_name ILIKE '%candy%' OR item_name ILIKE '%hershey%' OR item_name ILIKE '%m&m%'
    OR item_name ILIKE '%snickers%' OR item_name ILIKE '%reese%' OR item_name ILIKE '%sweet%')
  AND joy_index IS NOT NULL
ORDER BY joy_index DESC LIMIT 15;

-- 3. Demo splits on candy competitors
SELECT item_name, overall_ji, ji_male, ji_female, gender_gap, ji_gen_z, ji_boomer, gen_z_vs_boomer
FROM bjl_demo_splits
WHERE item_name IN ('Hershey', 'M&Ms', 'Snickers', 'Reese''s')
   OR item_name ILIKE '%candy%' LIMIT 15;

-- 4. Verbatim shape of the category
SELECT response_text, generation, gender, joy_modes, themes
FROM bjl_verbatims
WHERE (response_text ILIKE '%candy%' OR response_text ILIKE '%hershey%' OR response_text ILIKE '%sweet treat%')
  AND is_quotable = true
LIMIT 12;
```

---

### Example 4: Multi-property / parent company
Question: "Brand lookup for Marriott Bonvoy"
Intent: Brand Lookup

Reasoning: Loyalty programs can be sparse on direct mention but rich on parent brand. Look up parent, named properties, then broader hospitality category.

```sql
-- 1. Direct + parent + properties
SELECT item_name, question, joy_index, n FROM bjl_scores
WHERE item_name ILIKE '%marriott%' OR item_name ILIKE '%bonvoy%' OR item_name ILIKE '%ritz%' OR item_name ILIKE '%westin%'
LIMIT 25;

-- 2. Demo splits on hospitality brands
SELECT item_name, overall_ji, ji_gen_z, ji_boomer, ji_under_35k, ji_over_125k
FROM bjl_demo_splits
WHERE item_name ILIKE '%marriott%' OR item_name ILIKE '%hilton%' OR item_name ILIKE '%hyatt%'
   OR item_name ILIKE '%hotel%';

-- 3. Hospitality verbatims via tag retrieval
SELECT * FROM retrieve_verbatims(
  NULL, NULL, ARRAY['travel_hospitality'], NULL, NULL, NULL, NULL, NULL, 'marriott OR bonvoy OR loyalty', true, 15
);
```

---

## INTENT: Audience Deep Dive

### Example 5: Demographic + topic
Question: "How do millennial women feel about buying furniture?"
Intent: Audience Deep Dive

Reasoning: Filter verbatims on generation + gender + topic. Pull related score items. Check theme/joy_mode shape. Always check parental_status and income for context.

```sql
-- 1. Quotable verbatims
SELECT response_text, joy_modes, themes, parental_status, income_bracket
FROM bjl_verbatims
WHERE generation IN ('Younger Millennial', 'Elder Millennial', 'Millennial')
  AND gender = 'Female'
  AND (response_text ILIKE '%furniture%' OR response_text ILIKE '%couch%' OR response_text ILIKE '%sofa%'
       OR response_text ILIKE '%mattress%' OR question_text ILIKE '%furniture%')
  AND is_quotable = true
ORDER BY length(response_text) DESC
LIMIT 15;

-- 2. Theme distribution
SELECT unnest(themes) AS theme, COUNT(*) AS n
FROM bjl_verbatims
WHERE generation IN ('Younger Millennial','Elder Millennial','Millennial')
  AND gender = 'Female'
  AND (response_text ILIKE '%furniture%' OR response_text ILIKE '%couch%' OR response_text ILIKE '%sofa%')
  AND is_quotable = true
GROUP BY theme ORDER BY n DESC LIMIT 12;

-- 3. Dedicated furniture surveys
SELECT DISTINCT question, COUNT(*) AS items
FROM bjl_scores WHERE question ILIKE '%furniture%' GROUP BY question;

-- 4. Top items from the dedicated furniture-shopping joy question
SELECT item_name, top_pct, top_response, n
FROM bjl_scores
WHERE question ILIKE '%add to your joy when shopping for furniture in a physical store%'
ORDER BY top_pct DESC NULLS LAST LIMIT 10;
```

---

### Example 6: Generation alone
Question: "What brings Gen Z joy that surprises us?"
Intent: Audience Deep Dive

Reasoning: High gen_z_vs_boomer gap (positive = Gen Z higher). Surprising findings are where the gap is large.

```sql
-- 1. Gen Z meaningfully over-indexing vs Boomers
SELECT item_name, ji_gen_z, ji_boomer, gen_z_vs_boomer, overall_ji, n_overall
FROM bjl_demo_splits
WHERE gen_z_vs_boomer > 10 AND n_overall > 100
ORDER BY gen_z_vs_boomer DESC LIMIT 20;

-- 2. Gen Z under-indexing Boomers
SELECT item_name, ji_gen_z, ji_boomer, gen_z_vs_boomer
FROM bjl_demo_splits
WHERE gen_z_vs_boomer < -10 AND n_overall > 100
ORDER BY gen_z_vs_boomer ASC LIMIT 10;

-- 3. Quotable Gen Z verbatims with distinct joy modes
SELECT response_text, themes, joy_modes
FROM bjl_verbatims
WHERE generation = 'Gen Z'
  AND joy_modes && ARRAY['achievement', 'self_actualization', 'inspirational']
  AND is_quotable = true
ORDER BY length(response_text) DESC LIMIT 10;
```

---

### Example 7: Gender pattern
Question: "Where do men and women diverge most on travel?"
Intent: Audience Deep Dive

```sql
SELECT item_name, ji_male, ji_female, gender_gap, n_overall
FROM bjl_demo_splits ds
WHERE EXISTS (
  SELECT 1 FROM bjl_scores s
  WHERE s.item_name = ds.item_name
    AND s.category_key LIKE 'travel%'
)
ORDER BY ABS(gender_gap) DESC LIMIT 25;
```

---

### Example 8: Income split
Question: "Joy gaps by income for hospitality brands"
Intent: Audience Deep Dive

```sql
SELECT item_name, ji_under_35k, ji_35_75k, ji_75_125k, ji_over_125k, income_gap, overall_ji
FROM bjl_demo_splits
WHERE item_name IN (SELECT DISTINCT item_name FROM bjl_scores WHERE category_key = 'travel_hospitality')
  AND income_gap IS NOT NULL
ORDER BY ABS(income_gap) DESC LIMIT 20;
```

---

### Example 9: Parental status
Question: "How do parents differ from non-parents on family togetherness?"
Intent: Audience Deep Dive

Reasoning: demo_splits has no parental_status breaks. Has to come from verbatims.

```sql
SELECT
  parental_status,
  COUNT(*) AS total_responses,
  COUNT(*) FILTER (WHERE 'family togetherness' = ANY(themes)) AS family_together,
  COUNT(*) FILTER (WHERE 'relational' = ANY(joy_modes)) AS relational_mode
FROM bjl_verbatims
WHERE parental_status IS NOT NULL AND is_quotable = true
GROUP BY parental_status;
```

Then sample:
```sql
SELECT response_text, themes, joy_modes
FROM bjl_verbatims
WHERE parental_status = 'Parent'
  AND themes && ARRAY['family togetherness']
  AND is_quotable = true
ORDER BY length(response_text) DESC LIMIT 8;
```

---

## INTENT: Outreach Angle

### Example 10: Brand pursuing + specific challenge
Question: "We're pursuing Visit Wyoming. What's our angle?"
Intent: Outreach Angle

Reasoning: Outreach angles need (1) what BJL says about this brand or close adjacency, (2) something surprising/strategic, (3) demographic pattern pointing at growth opportunity. The angle is the intersection of what we know and what the prospect probably doesn't.

```sql
-- 1. Direct + state-name hits in verbatims
SELECT * FROM retrieve_verbatims_full_text('Wyoming', NULL, NULL, NULL, true, 12);

-- 2. Demo splits on adjacent state/destination items
SELECT item_name, overall_ji, gender_gap, gen_z_vs_boomer, income_gap
FROM bjl_demo_splits
WHERE item_name ILIKE '%wyoming%' OR item_name IN ('Yellowstone', 'Grand Teton', 'Jackson Hole', 'Montana');

-- 3. Travel destination laws
SELECT law_id, title, statement, implication
FROM bjl_laws WHERE 'travel_destinations' = ANY(applies_to_categories);

-- 4. Freedom/awe joy modes in nature context
SELECT response_text, generation, gender, themes
FROM bjl_verbatims
WHERE joy_modes && ARRAY['freedom', 'awe', 'tranquil']
  AND themes && ARRAY['mountains / nature', 'travel adventure']
  AND is_quotable = true
LIMIT 8;
```

---

### Example 11: Category-level outreach
Question: "We're pursuing a regional bank. What's the angle?"
Intent: Outreach Angle

Reasoning: No brand. Surface what BJL knows about financial services emotional landscape that a bank CMO probably doesn't.

```sql
-- 1. Financial items ranked
SELECT item_name, joy_index, n, question
FROM bjl_scores WHERE category_key = 'financial' AND joy_index IS NOT NULL
ORDER BY joy_index DESC LIMIT 15;

-- 2. Demo gaps in financial
SELECT item_name, overall_ji, gender_gap, gen_z_vs_boomer, income_gap
FROM bjl_demo_splits ds
WHERE EXISTS (SELECT 1 FROM bjl_scores s WHERE s.item_name = ds.item_name AND s.category_key = 'financial')
ORDER BY ABS(gen_z_vs_boomer) DESC NULLS LAST LIMIT 12;

-- 3. Voicy financial verbatims
SELECT response_text, generation, gender, joy_modes, themes
FROM bjl_verbatims
WHERE category_key = 'financial' AND is_quotable = true
ORDER BY length(response_text) DESC LIMIT 10;

-- 4. Financial laws
SELECT law_id, title, statement FROM bjl_laws WHERE 'financial' = ANY(applies_to_categories);
```

---

## INTENT: Data Pull

### Example 12: Top stats on a topic
Question: "Give me the top stats about anticipation"
Intent: Data Pull

```sql
-- 1. High-JI items measuring anticipation
SELECT item_name, joy_index, top_pct, n, question
FROM bjl_scores
WHERE (item_name ILIKE '%anticipat%' OR question ILIKE '%anticipat%'
       OR 'anticipation' = ANY(tags) OR 'anticipation' = ANY(themes))
  AND joy_index IS NOT NULL
ORDER BY joy_index DESC LIMIT 15;

-- 2. Anticipation verbatims
SELECT response_text, joy_modes, themes
FROM bjl_verbatims
WHERE 'anticipation' = ANY(themes) AND is_quotable = true
ORDER BY length(response_text) DESC LIMIT 8;

-- 3. Laws referencing anticipation
SELECT law_id, title, statement FROM bjl_laws
WHERE statement ILIKE '%anticipat%' OR evidence ILIKE '%anticipat%';
```

---

### Example 13: Specific quantitative comparison
Question: "Joy Index of major QSR brands ranked"
Intent: Data Pull

```sql
SELECT item_name, joy_index, n, question
FROM bjl_scores
WHERE item_name IN ('McDonalds', 'McDonald''s', 'Burger King', 'Wendys', 'Wendy''s',
                     'Chick-fil-A', 'Taco Bell', 'Subway', 'Chipotle', 'Popeyes', 'KFC')
   OR item_name ILIKE 'McDonald%' OR item_name ILIKE 'Wendy%'
ORDER BY joy_index DESC NULLS LAST LIMIT 20;
```

---

### Example 14: Joy mode distribution
Question: "How are joy modes distributed across our verbatim corpus?"
Intent: Data Pull

```sql
SELECT
  unnest(joy_modes) AS mode,
  COUNT(*) AS n,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM bjl_verbatims
WHERE is_quotable = true
GROUP BY mode
ORDER BY n DESC;
```

---

### Example 15: Question battery exploration
Question: "What did we ask about gift giving?"
Intent: Data Pull

```sql
SELECT DISTINCT question, COUNT(*) AS items
FROM bjl_scores
WHERE question ILIKE '%gift%' OR 'gift giving' = ANY(occasions)
GROUP BY question
ORDER BY items DESC;
```

---

## INTENT: Open dialogue (no tag)

### Example 16: Cross-cutting question
Question: "What does our research say about how joy decays after purchase?"
Intent: none

Reasoning: Cast wide. Laws first for synthesized findings, then scores, then verbatims.

```sql
-- 1. Laws
SELECT law_id, title, statement, evidence FROM bjl_laws
WHERE statement ILIKE '%decay%' OR statement ILIKE '%after purchase%' OR statement ILIKE '%hedonic%'
   OR statement ILIKE '%fade%' OR statement ILIKE '%diminish%';

-- 2. Post-purchase score items
SELECT item_name, joy_index, question, n FROM bjl_scores
WHERE question ILIKE '%after%purchas%' OR question ILIKE '%still feel%'
   OR question ILIKE '%now that you%' OR question ILIKE '%use it%'
LIMIT 20;

-- 3. Verbatims expressing post-purchase fade
SELECT response_text, joy_modes, themes
FROM bjl_verbatims
WHERE (response_text ILIKE '%wore off%' OR response_text ILIKE '%not as %' OR response_text ILIKE '%novelty%'
       OR response_text ILIKE '%got used to%')
  AND is_quotable = true
LIMIT 10;
```

---

### Example 17: Comparative analysis across categories
Question: "Which categories have the strongest relational joy?"
Intent: none

```sql
SELECT
  category_key,
  COUNT(*) AS n_items,
  ROUND(AVG(joy_index)::numeric, 1) AS avg_joy_index,
  COUNT(*) FILTER (WHERE 'relational' = ANY(joy_modes)) AS relational_items,
  ROUND(100.0 * COUNT(*) FILTER (WHERE 'relational' = ANY(joy_modes)) / COUNT(*), 1) AS pct_relational
FROM bjl_scores
WHERE joy_index IS NOT NULL AND category_key IS NOT NULL
GROUP BY category_key
HAVING COUNT(*) >= 10
ORDER BY pct_relational DESC LIMIT 10;
```

---

### Example 18: Multi-brand comparison
Question: "How do legacy brands compare to challenger brands on sentimental joy?"
Intent: none

```sql
-- 1. Items where sentimental is a primary joy mode
SELECT item_name, joy_index, joy_modes, category_key, n
FROM bjl_scores
WHERE 'sentimental' = ANY(joy_modes) AND joy_index IS NOT NULL
ORDER BY joy_index DESC LIMIT 25;

-- 2. Sentimental verbatims mentioning legacy cues
SELECT response_text, themes, generation
FROM bjl_verbatims
WHERE 'sentimental' = ANY(joy_modes)
  AND is_quotable = true
  AND (response_text ILIKE '%childhood%' OR response_text ILIKE '%growing up%' OR response_text ILIKE '%always%')
ORDER BY length(response_text) DESC LIMIT 12;

-- 3. Demo splits — sentimental items often skew older
SELECT item_name, overall_ji, ji_gen_z, ji_boomer, gen_z_vs_boomer
FROM bjl_demo_splits ds
WHERE EXISTS (SELECT 1 FROM bjl_scores s WHERE s.item_name = ds.item_name AND 'sentimental' = ANY(s.joy_modes))
ORDER BY gen_z_vs_boomer ASC LIMIT 15;
```

---

## Habits to internalize

1. Always check all four primary tables for brand/topic questions. Demo splits often hold the most strategic finding in a single row.
2. For brand/entity queries, use retrieve_verbatims_full_text. Category filtering misroutes brand mentions.
3. For thin direct data, pivot to adjacency. Run at least one adjacency query before declaring an investigation done.
4. For demographic queries: bjl_demo_splits when item is named; bjl_verbatims with demo filters when topic is broad.
5. When aggregating, look for the surprising number. Biggest gap, most over-indexed mode.
6. UNION ALL queries that parallel-check multiple tables in one query save budget.
