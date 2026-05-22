-- Mojibake cleanup (v5.5).
--
-- The ingestion pipeline read the source .xlsx as Latin-1 instead of UTF-8,
-- so UTF-8-encoded Windows-1252 smart quotes / em-dashes / en-dashes / ellipses
-- ended up triple-encoded. The stored text reads as "they‚Äôve" where the
-- intended display is "they've".
--
-- Scope (confirmed 2026-05-22):
--   bjl_verbatims.question_text   4,053 rows
--   bjl_verbatims.response_text     196 rows
--   bjl_questions_v2.question_text   23 rows
--
-- search_vector is a `GENERATED ALWAYS` column on bjl_verbatims computed by
-- bjl_verbatim_search_tsv(response_text, question_text, themes, tags), so
-- regeneration happens automatically when the underlying text columns are
-- updated. No follow-on refresh step needed.
--
-- The migration is idempotent: re-running on already-clean text is a no-op
-- because the WHERE clauses no longer match.

UPDATE bjl_verbatims
SET question_text =
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
    question_text,
    '‚Äô', ''''),
    '‚Äò', ''''),
    '‚Äú', '"'),
    '‚Äù', '"'),
    '‚Äî', '—'),
    '‚Äì', '–'),
    '‚Ä¶', '…'),
    '‚Äë', '‑')   -- non-breaking hyphen U+2011 (added in followup; covers a 2-row tail not in the 7-pattern brief)
WHERE question_text ~ '‚Ä';

UPDATE bjl_verbatims
SET response_text =
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
    response_text,
    '‚Äô', ''''),
    '‚Äò', ''''),
    '‚Äú', '"'),
    '‚Äù', '"'),
    '‚Äî', '—'),
    '‚Äì', '–'),
    '‚Ä¶', '…'),
    '‚Äë', '‑')   -- non-breaking hyphen U+2011 (added in followup; covers a 2-row tail not in the 7-pattern brief)
WHERE response_text ~ '‚Ä';

UPDATE bjl_questions_v2
SET question_text =
  REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
    question_text,
    '‚Äô', ''''),
    '‚Äò', ''''),
    '‚Äú', '"'),
    '‚Äù', '"'),
    '‚Äî', '—'),
    '‚Äì', '–'),
    '‚Ä¶', '…'),
    '‚Äë', '‑')   -- non-breaking hyphen U+2011 (added in followup; covers a 2-row tail not in the 7-pattern brief)
WHERE question_text ~ '‚Ä';
