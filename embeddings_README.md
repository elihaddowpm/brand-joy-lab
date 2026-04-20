# BJL Embeddings Generation

Populates the `embedding vector(1536)` column on `bjl_scores`, `bjl_verbatims`, and `bjl_laws` so the orchestrator can do semantic retrieval alongside tag-based retrieval.

## Why this matters

Tag retrieval (joy_modes, occasions, etc.) requires the orchestrator to decompose the query correctly. When that decomposition is good, retrieval is great. When the decomposer misses a dimension, relevant items get missed.

Embeddings are the fallback. Semantic search catches what the orchestrator wouldn't think to query. The combined retrieval (tags + embeddings, deduped and merged) gives the synthesis call a richer evidence base.

## Why OpenAI for this

Anthropic does not currently have an embeddings endpoint. The script uses OpenAI's `text-embedding-3-small` (1536 dims), which matches the column type we set up (`vector(1536)`). Cheap (~7 cents total for the full pass), fast, and well-suited to short text.

If you'd rather use Voyage AI or Cohere, the script structure is the same — just swap the API client and adjust the dimensions.

## Setup

```bash
pip install openai psycopg2-binary
```

Set environment variables:

```bash
export OPENAI_API_KEY="sk-..."
export SUPABASE_DB_URL="postgresql://postgres:[YOUR-DB-PASSWORD]@db.iqjkgswpzbklihdfccnd.supabase.co:5432/postgres"
```

## Run

Test with one batch first:

```bash
python3 run_embeddings.py --table scores --max-batches 1
```

Verify the writeback:

```sql
SELECT COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded, COUNT(*) AS total 
FROM bjl_scores;
```

Then run the full pass on all three tables:

```bash
python3 run_embeddings.py
```

Expected runtime: roughly 5-10 minutes (verbatims is the bulk of the work — 62,755 rows in batches of 100 = 628 API calls).

## After embeddings are populated: build HNSW indexes

These are one-time index builds that make semantic retrieval fast (otherwise every query scans the whole table). Run in Supabase SQL Editor:

```sql
CREATE INDEX IF NOT EXISTS bjl_scores_embedding_hnsw 
  ON bjl_scores USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS bjl_verbatims_embedding_hnsw 
  ON bjl_verbatims USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS bjl_laws_embedding_hnsw 
  ON bjl_laws USING hnsw (embedding vector_cosine_ops);
```

These take a few minutes to build (verbatims will take the longest). After they exist, the three `retrieve_*_semantic` functions that already exist in the database become fast.

## Useful flags

- `--table scores|verbatims|laws|all` — run a specific table (default: all)
- `--limit N` — rows per batch (default 100). OpenAI accepts up to 2048; smaller batches use less memory.
- `--max-batches N` — stop after N batches (useful for testing)
- `--dry-run` — print what would be updated without writing

## Verify retrieval after the indexes are built

The orchestrator can call `retrieve_items_semantic`, `retrieve_verbatims_semantic`, and `retrieve_laws_semantic` once embeddings are populated. To test in SQL, you'd need a query embedding (which the orchestrator will generate per-query). For now, the existence check is sufficient:

```sql
SELECT 
  (SELECT COUNT(*) FROM bjl_scores WHERE embedding IS NOT NULL) AS scores_embedded,
  (SELECT COUNT(*) FROM bjl_verbatims WHERE embedding IS NOT NULL) AS verbatims_embedded,
  (SELECT COUNT(*) FROM bjl_laws WHERE embedding IS NOT NULL) AS laws_embedded;
```
