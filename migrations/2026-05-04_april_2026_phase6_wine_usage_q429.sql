-- April 2026 Phase 6 — populate bjl_respondent_usage(category='wine') from
-- Q429 ("Which of the following best describes your relationship with wine?").
--
-- Q429 is single_select with 6 mutually-exclusive options. Mapping into the
-- canonical Heavy / Frequent / Moderate / Light / Never taxonomy:
--
--   "I drink wine regularly — at least once or twice a week"   → Frequent
--   "I drink wine occasionally — a few times a month"           → Moderate
--   "I drink wine rarely — a few times a year or less"          → Light
--   "I have tried wine but it is not really for me"             → Never
--   "I have never really tried wine"                            → Never
--   "I used to drink wine but I no longer do"                   → Never
--
-- No Heavy tier exists for wine — Q429's top option is "regularly … once or
-- twice a week", which maps to Frequent in the standard taxonomy.
--
-- ON CONFLICT update keeps this idempotent: re-running is a no-op when no
-- new April Q429 responses arrive.

INSERT INTO bjl_respondent_usage (respondent_id, category, usage_level, source_question_id)
SELECT r.respondent_id,
       'wine'::text AS category,
       CASE
         WHEN r.raw_value = 'I drink wine regularly — at least once or twice a week' THEN 'Frequent'
         WHEN r.raw_value = 'I drink wine occasionally — a few times a month'        THEN 'Moderate'
         WHEN r.raw_value = 'I drink wine rarely — a few times a year or less'        THEN 'Light'
         WHEN r.raw_value IN (
           'I have tried wine but it is not really for me',
           'I have never really tried wine',
           'I used to drink wine but I no longer do'
         ) THEN 'Never'
       END AS usage_level,
       429 AS source_question_id
FROM bjl_responses r
WHERE r.question_id = 429
  AND r.year_month = '2026-04'
  AND r.raw_value IS NOT NULL
ON CONFLICT (respondent_id, category) DO UPDATE
  SET usage_level        = EXCLUDED.usage_level,
      source_question_id = EXCLUDED.source_question_id;
-- Expected on first apply for April 2026: 401 rows
--   Never=169, Moderate=86, Light=76, Frequent=70.
