#!/usr/bin/env python3
"""
BJL embedding generation. Pulls rows from bjl_scores, bjl_verbatims, and bjl_laws
that don't yet have an embedding, sends them to OpenAI's embeddings endpoint
in batches, and writes the 1536-dim vectors back to the embedding column.

Why OpenAI embeddings: Anthropic does not currently offer an embeddings endpoint,
and we sized the embedding column at vector(1536) which matches text-embedding-3-small.
This is the smallest, fastest, cheapest OpenAI embedding model and is well-suited
to the short-text item names and verbatim responses we're embedding.

Usage:
  export OPENAI_API_KEY="sk-..."
  export SUPABASE_DB_URL="postgresql://postgres:[password]@db.iqjkgswpzbklihdfccnd.supabase.co:5432/postgres"
  python3 run_embeddings.py [--table scores|verbatims|laws|all] [--limit 100] [--max-batches 999] [--dry-run]

Defaults: --table all, --limit 100, no max.

After all three tables are populated, run the SQL block at the bottom of this file
to create HNSW indexes (one-time, takes a few minutes).

Cost estimate at text-embedding-3-small ($0.02 per 1M tokens):
  - bjl_scores ~3,589 rows × ~30 tokens each = $0.002
  - bjl_verbatims ~62,755 rows × ~50 tokens each = $0.063
  - bjl_laws ~46 rows × ~400 tokens each = trivial
  Total: roughly 7 cents.
"""

import argparse
import os
import sys
import time
from typing import Iterable

import psycopg2
from psycopg2.extras import RealDictCursor
from openai import OpenAI

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIM = 1536  # matches the vector(1536) column type
BATCH_SIZE = 100  # OpenAI accepts up to 2048 inputs per request; 100 keeps memory sane
SLEEP_BETWEEN_CALLS = 0.1  # Generous throttle


def get_untagged_rows(conn, table: str, limit: int) -> list[dict]:
    """Pull rows that don't have an embedding yet. Builds the input text per table."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        if table == "scores":
            # Item + category + joy modes makes the embedding semantically rich
            cur.execute("""
                SELECT 
                    id,
                    COALESCE(item_name, '') || ' | ' ||
                    COALESCE(category, '') || ' | ' ||
                    COALESCE(question_type, '') || ' | ' ||
                    COALESCE(array_to_string(joy_modes, ', '), '') AS embed_text
                FROM bjl_scores
                WHERE embedding IS NULL
                  AND item_name IS NOT NULL
                ORDER BY id
                LIMIT %s
            """, (limit,))
        elif table == "verbatims":
            # Response text + question context + joy modes
            cur.execute("""
                SELECT 
                    id,
                    COALESCE(response_text, '') || ' | ' ||
                    COALESCE(question_text, '') || ' | ' ||
                    COALESCE(array_to_string(joy_modes, ', '), '') AS embed_text
                FROM bjl_verbatims
                WHERE embedding IS NULL
                  AND response_text IS NOT NULL
                ORDER BY id
                LIMIT %s
            """, (limit,))
        elif table == "laws":
            # Title + statement + evidence + implication is the full law
            cur.execute("""
                SELECT 
                    law_id AS id,
                    COALESCE(title, '') || ' | ' ||
                    COALESCE(statement, '') || ' | ' ||
                    COALESCE(evidence, '') || ' | ' ||
                    COALESCE(implication, '') AS embed_text
                FROM bjl_laws
                WHERE embedding IS NULL
                ORDER BY law_id
                LIMIT %s
            """, (limit,))
        else:
            raise ValueError(f"Unknown table: {table}")
        return [dict(r) for r in cur.fetchall()]


def embed_batch(client: OpenAI, texts: list[str]) -> list[list[float]]:
    """Call the OpenAI embeddings endpoint, return list of 1536-dim vectors."""
    # Truncate to ~8000 tokens worth (model max is 8192). Crude char limit:
    truncated = [t[:32000] for t in texts]
    resp = client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=truncated,
        dimensions=EMBEDDING_DIM,
    )
    return [d.embedding for d in resp.data]


def writeback(conn, table: str, rows: list[dict], embeddings: list[list[float]], dry_run: bool) -> int:
    """Write embeddings back. id type differs by table (int for scores/verbatims, text for laws)."""
    if dry_run:
        print(f"  [DRY RUN] Would update {len(rows)} rows in bjl_{table}")
        return 0

    id_col = "law_id" if table == "laws" else "id"
    sql = f"UPDATE bjl_{table} SET embedding = %s::vector, embedding_updated_at = now() WHERE {id_col} = %s"

    updated = 0
    with conn.cursor() as cur:
        for row, vec in zip(rows, embeddings):
            cur.execute(sql, (str(vec), row["id"]))
            updated += cur.rowcount
    conn.commit()
    return updated


def get_progress(conn, table: str) -> tuple[int, int]:
    """Return (with_embedding, total) for the given table."""
    with conn.cursor() as cur:
        cur.execute(f"""
            SELECT 
                COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS with_emb,
                COUNT(*) AS total
            FROM bjl_{table}
        """)
        row = cur.fetchone()
        return row[0], row[1]


def run_table(conn, client, table: str, limit: int, max_batches: int, dry_run: bool):
    with_emb_start, total = get_progress(conn, table)
    print(f"\n=== {table.upper()} ===")
    print(f"Starting state: {with_emb_start}/{total} rows have embeddings ({100*with_emb_start/total:.1f}%)")

    if with_emb_start == total:
        print(f"All rows already embedded. Skipping.")
        return

    batch_num = 0
    rows_updated_total = 0

    while batch_num < max_batches:
        batch_num += 1
        rows = get_untagged_rows(conn, table, limit)
        if not rows:
            print(f"No more rows to embed in bjl_{table}.")
            break

        texts = [r["embed_text"] for r in rows]

        try:
            vectors = embed_batch(client, texts)
        except Exception as e:
            print(f"  ERROR from OpenAI: {e}", file=sys.stderr)
            print(f"  Sleeping 10s and continuing...", file=sys.stderr)
            time.sleep(10)
            continue

        if len(vectors) != len(rows):
            print(f"  WARN: input had {len(rows)} rows, got {len(vectors)} vectors back", file=sys.stderr)
            continue

        rows_updated = writeback(conn, table, rows, vectors, dry_run)
        rows_updated_total += rows_updated

        if batch_num == 1 or batch_num % 10 == 0:
            with_emb_now, _ = get_progress(conn, table)
            pct = 100*with_emb_now/total
            print(f"  Batch {batch_num}: {len(rows)} rows embedded. Total: {with_emb_now}/{total} ({pct:.1f}%)")

        time.sleep(SLEEP_BETWEEN_CALLS)

    with_emb_end, _ = get_progress(conn, table)
    print(f"Final state: {with_emb_end}/{total} rows have embeddings ({100*with_emb_end/total:.1f}%)")
    print(f"Net new this run: {with_emb_end - with_emb_start}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--table", choices=["scores", "verbatims", "laws", "all"], default="all",
                        help="Which table(s) to embed (default: all)")
    parser.add_argument("--limit", type=int, default=BATCH_SIZE,
                        help=f"Rows per batch (default: {BATCH_SIZE})")
    parser.add_argument("--max-batches", type=int, default=999999,
                        help="Stop after N batches per table (default: run until done)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would be updated without writing")
    args = parser.parse_args()

    api_key = os.environ.get("OPENAI_API_KEY")
    db_url = os.environ.get("SUPABASE_DB_URL")
    if not api_key:
        print("ERROR: OPENAI_API_KEY environment variable not set", file=sys.stderr)
        sys.exit(1)
    if not db_url:
        print("ERROR: SUPABASE_DB_URL environment variable not set", file=sys.stderr)
        sys.exit(1)

    client = OpenAI(api_key=api_key)
    conn = psycopg2.connect(db_url)

    tables_to_run = ["scores", "verbatims", "laws"] if args.table == "all" else [args.table]

    for table in tables_to_run:
        run_table(conn, client, table, args.limit, args.max_batches, args.dry_run)

    conn.close()
    print("\nAll done. Next step: run the HNSW index creation SQL (see comment at bottom of this script).")


if __name__ == "__main__":
    main()


# AFTER all embeddings are populated, run this once in Supabase SQL Editor.
# HNSW indexes take a few minutes to build but make semantic retrieval fast.
"""
CREATE INDEX IF NOT EXISTS bjl_scores_embedding_hnsw 
  ON bjl_scores USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS bjl_verbatims_embedding_hnsw 
  ON bjl_verbatims USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS bjl_laws_embedding_hnsw 
  ON bjl_laws USING hnsw (embedding vector_cosine_ops);
"""
