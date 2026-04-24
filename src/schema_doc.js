// schema_doc.js
// The schema documentation the investigator sees.
// Static at build time but lives as a module so it can be regenerated
// when the schema changes. Covers all bjl_* tables, key columns,
// array value vocabularies, and lookup tables.

export const SCHEMA_DOC = `# BJL Database Schema (for the investigator)

This document describes the Brand Joy Lab database. Treat it as authoritative — every query you write runs against this schema. All tables live in the \`public\` schema.

## Quick orientation

The BJL corpus is a multi-wave consumer survey on emotional joy and brand response. Three primary data tables (scores, verbatims, demo_splits), one synthesis table (laws), and several lookup tables defining the vocabulary.

Key concept: most quantitative responses are scored on a "Joy Index" (JI), a normalized 0-100 score where higher means more joy. JI values are comparable across items asked the same way. Compare JI only within matching \`question_type\`.

---

## Primary data tables

### \`bjl_scores\` — quantitative survey items (~3,589 rows)

One row per item × question. An "item" is whatever was measured (a brand, an experience, an emotional state). A "question" is the survey prompt.

Key columns:
- \`id\` (integer) — primary key
- \`item_name\` (text) — what was measured
- \`category\` (text) — broad category label
- \`category_key\` (text) — normalized key (joins to bjl_categories)
- \`question\` (text) — the actual survey prompt
- \`question_type\` (text) — values include: joy_index_scale, select_all, ordinal_scale, single_select, open_text, numeric
- \`joy_index\` (numeric) — the JI score; NULL for non-JI question types
- \`mean\` (numeric) — for ordinal scales
- \`top_pct\` (numeric) — % choosing the top response
- \`top_response\` (text) — most common answer
- \`pct\` (numeric) — generic percentage column
- \`n\` (integer) — sample size
- \`wave\` (text) — fielding wave identifier
- \`joy_modes\` (text[]) — which joy modes apply
- \`tags\` (text[]) — free-form tags
- \`topics\` (text[]) — topical tags
- \`occasions\` (text[]) — occasion tags
- \`functional_jobs\` (text[]) — JTBD tags
- \`tensions\` (text[]) — tension/dilemma tags
- \`search_vector\` (tsvector) — full-text index on item_name + question
- \`embedding\` (vector) — semantic embedding

How to use:
- Brand lookups: \`item_name ILIKE '%brand%' OR question ILIKE '%brand%'\`. Brands appear in both depending on question structure.
- Category overviews: filter on \`category_key\`.
- Dedicated study batteries: GROUP BY \`question\` to see clusters (e.g. the furniture financing study lives across 7 questions with "furniture" and "prequalif").
- JI comparisons: only compare values from the same \`question_type\`.

### \`bjl_verbatims\` — open-ended consumer responses (~62,755 rows)

One row per consumer response to an open-ended question.

Key columns:
- \`id\` (integer) — primary key
- \`response_text\` (text) — what the consumer wrote
- \`question_text\` (text) — the prompt they were responding to
- \`category\` (text) — categorization of the response
- \`category_key\` (text)
- \`joy_modes\` (text[])
- \`themes\` (text[]) — thematic tags (family togetherness, sensory pleasure, achievement / pride, etc.)
- \`sentiment\` (text) — positive, negative, mixed, neutral
- \`generation\` (text) — Gen Z, Younger Millennial, Elder Millennial, Millennial, Gen X, Boomer, Silent
- \`gender\` (text) — Male, Female
- \`income_bracket\` (text) — Under $35K, $35-75K, $75-125K, Over $125K
- \`region\` (text) — US Census region
- \`parental_status\` (text) — Parent, Non-Parent
- \`is_quotable\` (boolean) — pre-flagged quotability; ALWAYS filter \`is_quotable = true\` for anything that will appear in output
- \`search_vector\` (tsvector)
- \`embedding\` (vector)

How to use:
- Brand mentions: \`response_text ILIKE '%brand%'\`. Brand mentions often appear in verbatims filed under unexpected categories (Cracker Barrel lives under travel_hospitality because the question was framed in road-trip context).
- For entity searches: \`SELECT * FROM retrieve_verbatims_full_text('Brand Name', NULL, NULL, NULL, true, 15)\`. This RPC bypasses category filtering — use it for any brand/entity query.
- Audience analysis: combine generation + gender + theme + parental_status. The schema fully supports demographic combinations.
- Always attribute verbatims to demographics ("a Boomer woman in the South").

### \`bjl_demo_splits\` — demographic Joy Index breakdowns (~560 rows)

One row per item with JI broken out by demographic slice.

Key columns:
- \`split_id\` (integer) — primary key
- \`item_name\` (text)
- \`overall_ji\` (numeric), \`n_overall\` (integer)
- \`ji_female\`, \`ji_male\`, \`n_female\`, \`n_male\` (numeric/integer)
- \`gender_gap\` (numeric) — male JI minus female JI
- \`ji_gen_z\`, \`ji_younger_mil\`, \`ji_elder_mil\`, \`ji_genx_y\`, \`ji_genx_o\`, \`ji_boomer\` (numeric)
- \`gen_z_vs_boomer\` (numeric) — Gen Z JI minus Boomer JI
- \`ji_under_35k\`, \`ji_35_75k\`, \`ji_75_125k\`, \`ji_over_125k\` (numeric)
- \`income_gap\` (numeric) — top bracket minus bottom

How to use:
- This table is GOLD for surfacing demographic patterns. A 15+ point gender gap or generation gap is a story.
- Coverage is partial — only ~560 items have demo splits. Not every bjl_scores row has a corresponding row here.
- For brand lookups, always check this table even if direct match is one row. A single row often contains the most strategically interesting finding.

### \`bjl_laws\` — synthesized strategic frameworks (46 rows)

PETERMAYER's accumulated findings, written as numbered laws.

Key columns:
- \`law_id\` (text) — e.g. "1.2", "3.1"
- \`title\` (text)
- \`part\` (text) — section heading
- \`statement\` (text) — the law itself
- \`evidence\` (text) — supporting data summary
- \`implication\` (text) — strategic meaning
- \`applies_to_categories\` (text[])
- \`applies_to_joy_modes\` (text[])
- \`applies_to_tensions\` (text[])
- \`applies_to_demographics\` (text[])
- \`is_foundational\` (boolean)

How to use:
- Pull applicable laws by category overlap or topic match.
- Laws are synthesized, not raw data. Use them to frame interpretations.

---

## Lookup tables

### \`bjl_categories\` (22 rows)
Hierarchical taxonomy. Columns: \`category_key\`, \`display_name\`, \`parent_key\`, \`description\`, \`path\`.
Keys include: brand_trust, celebrities, financial, food, food_eating, food_joy, general_joy, health_ratings, health_wellness, home, home_furniture, retail, retail_grocery, sports_fandom, sports_tailgating, technology_internet, travel, travel_attractions, travel_destinations, travel_hospitality, travel_journey_stages.

Notes: \`home_furniture\` is the dedicated furniture financing study category. \`general_joy\` is a catch-all where many cross-category responses live.

### \`bjl_joy_modes\` (14 rows)
Columns: \`mode_key\`, \`display_name\`, \`short_definition\`, \`purchase_mapping\`, \`benchmark_finding\`.
Modes: achievement, aesthetic, awe, freedom, hedonic, inspirational, physical, playful, relational, self_actualization, sentimental, spiritual, tranquil, triumph.

\`relational\` is the most common verbatim mode at 24% (Law 3.1). \`tranquil\` was added as the 14th mode per Law 9.

### \`bjl_tensions\` (15 rows) — strategic tensions/dilemmas
### \`bjl_occasions\` (25 rows) — consumption occasions
### \`bjl_functional_jobs\` (24 rows) — jobs-to-be-done
### \`bjl_questions\` (203 rows) — master list of survey questions with metadata
### \`bjl_waves\` (1 row) — fielding waves with date ranges
### \`bjl_fieldings\` (29 rows) — detail on each fielding event

---

## Custom RPC functions

Call via SQL: \`SELECT * FROM function_name(args)\`.

- \`retrieve_items_by_tags(category_keys, joy_modes, themes, ...)\` — tag-based item retrieval
- \`retrieve_items_full_text(query)\` — full-text search on bjl_scores
- \`retrieve_items_semantic(query_embedding, ...)\` — vector similarity on bjl_scores
- \`retrieve_verbatims(joy_modes, themes, category_keys, ...)\` — tag-based verbatim retrieval
- \`retrieve_verbatims_full_text(entity_query, joy_modes, generation, gender, require_quotable, limit)\` — full-text verbatim search WITHOUT category filtering. Use this for brand/entity queries.
- \`retrieve_verbatims_semantic(query_embedding, ...)\` — vector similarity on verbatims
- \`retrieve_demo_splits(item_name, ...)\` — demo split retrieval
- \`retrieve_laws(...)\` — law retrieval

You can also write raw SQL. The RPCs are convenience wrappers; the underlying tables are queryable.

---

## Hard rules

1. NEVER write DDL or DML. SELECT only. The connection enforces this, but a write would fail and waste a query of your budget.
2. Always include LIMIT. Default LIMIT 50 unless the question specifically needs more (cap at 500). The executor injects LIMIT 500 if you forget.
3. For verbatims reaching the synthesizer, filter \`is_quotable = true\`.
4. For arrays: \`&&\` for overlap, \`= ANY()\` for single-value match, \`@>\` for contains-all.
5. Statement timeout is 5 seconds. Large unfiltered scans will time out.
6. At most 8 queries per investigation. A single UNION ALL query that checks four tables counts as one query and is often the right opening move.
`;
