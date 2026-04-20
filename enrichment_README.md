# BJL Enrichment Backfill

Finishes the enrichment tagging on `bjl_scores` items that don't yet have `joy_modes`, `occasions`, `functional_jobs`, or `tensions` populated. Uses Claude Sonnet via the Anthropic API.

## What it does

For each untagged `(item_name, category)` pair in `bjl_scores`, this script:
1. Pulls a batch of 50 items, prioritized by Joy Index then by sample size
2. Sends them to Claude Sonnet with the four controlled vocabularies
3. Parses Claude's JSON response
4. Validates that all returned tags are in the controlled vocab (drops anything that isn't)
5. Writes back via `UPDATE bjl_scores ... WHERE item_name = ? AND category = ?`

The vocabularies in the script (JOY_MODES, OCCASIONS, FUNCTIONAL_JOBS, TENSIONS) match the reference tables `bjl_joy_modes`, `bjl_occasions`, `bjl_functional_jobs`, and `bjl_tensions` in Supabase.

## Setup

```bash
pip install anthropic psycopg2-binary
```

Set environment variables:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export SUPABASE_DB_URL="postgresql://postgres:[YOUR-DB-PASSWORD]@db.iqjkgswpzbklihdfccnd.supabase.co:5432/postgres"
```

The DB URL comes from Supabase dashboard:
**Project Settings → Database → Connection string → URI**

Use the direct connection (5432) for this script. The pooled connection on 6543 also works but isn't necessary.

## Run

Test with one batch first:

```bash
python3 run_enrichment.py --max-batches 1
```

Verify the writeback by spot-checking in Supabase. Then run the full backfill:

```bash
python3 run_enrichment.py
```

The script will keep pulling batches until no untagged items remain. Expected runtime: roughly 30-45 minutes for the remaining ~2,400 combos at 50 per batch.

## Cost estimate

Each batch call is roughly:
- Input: 1,500 tokens (system prompt + 50 items)
- Output: 2,500 tokens (50 tagged items)

Claude Sonnet 4.5 pricing × ~50 batches ≈ a few dollars total.

## Useful flags

- `--limit N` — items per batch (default 50). Smaller batches = more LLM accuracy, more API calls.
- `--dry-run` — print what would be updated without writing
- `--max-batches N` — stop after N batches (useful for testing or partial runs)

## After the run

Verify coverage:

```sql
SELECT 
  COUNT(DISTINCT (item_name, category)) FILTER (WHERE joy_modes IS NOT NULL AND array_length(joy_modes, 1) > 0) AS tagged,
  COUNT(DISTINCT (item_name, category)) AS total
FROM bjl_scores;
```

Then test retrieval:

```sql
SELECT item_name, category, joy_index, joy_modes, overlap_score
FROM retrieve_items_by_tags(
  p_joy_modes := ARRAY['relational','sentimental'],
  p_occasions := ARRAY['gift_giving','holiday'],
  p_min_n := 100,
  p_limit := 10
);
```
