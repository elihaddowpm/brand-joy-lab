-- Add concept_tags array column to bjl_questions_v2 so the investigator can
-- discover relevant questions by strategic concept rather than by keyword
-- matching against question_text. Keyword matching misses queries where the
-- user's framing differs from the survey's wording (e.g. "furniture journey"
-- misses "When it comes to furnishing or decorating your home...").
--
-- The column is populated by a one-time Haiku tagging pass over existing
-- questions, then ongoing tagging at wave authoring or load time.

ALTER TABLE bjl_questions_v2
  ADD COLUMN IF NOT EXISTS concept_tags text[] DEFAULT ARRAY[]::text[];

COMMENT ON COLUMN bjl_questions_v2.concept_tags IS
  'Strategic-concept tags for question discovery. Multi-value; questions can carry multiple tags. Initial taxonomy: furniture_journey, home_identity, financing_journey, prequalification, retail_in_store, retail_online, significant_purchase, new_purchase_meaning, home_transformation. Extensible.';

CREATE INDEX IF NOT EXISTS bjl_questions_v2_concept_tags_gin
  ON bjl_questions_v2 USING GIN (concept_tags);
