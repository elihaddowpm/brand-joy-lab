-- v6.3 — Public Joy Lab Chat semantic-retrieval substrate.
--
-- Adds embedding columns to bjl_public_insights and
-- bjl_public_verbatim_truths so the public chat function can run
-- semantic retrieval across all three text-bearing layers (laws,
-- insights, verbatim truths) alongside structured retrieval on the
-- score tables.
--
-- Vector dimension matches bjl_laws.embedding (vector(1536)). All four
-- embedding columns will be populated from OpenAI text-embedding-3-small
-- in a separate population pass (bjl-embed-public-corpus.js). The
-- existing bjl_laws.embedding rows are also regenerated in that pass
-- because the provenance of the originals can't be verified and a
-- model mismatch between stored vectors and query-time vectors would
-- return garbage matches while appearing to work.
--
-- HNSW cosine indexes ship in this same migration. They sit empty
-- until the population pass writes vectors, which is fine — HNSW on
-- a column of NULL embeddings is a no-op until rows have values.

ALTER TABLE bjl_public_insights
  ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE bjl_public_insights
  ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz;

ALTER TABLE bjl_public_verbatim_truths
  ADD COLUMN IF NOT EXISTS embedding vector(1536);
ALTER TABLE bjl_public_verbatim_truths
  ADD COLUMN IF NOT EXISTS embedding_updated_at timestamptz;

-- Cosine HNSW indexes — same access pattern as bjl_laws.
CREATE INDEX IF NOT EXISTS idx_insights_embedding
  ON bjl_public_insights USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_truths_embedding
  ON bjl_public_verbatim_truths USING hnsw (embedding vector_cosine_ops);
