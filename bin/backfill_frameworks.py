#!/usr/bin/env python3
"""
backfill_frameworks.py — one-off backfill of the framework tags on
existing BJL verbatims.

Uses bin/framework_tagger.py to assign joy_modes / tensions /
functional_jobs / occasions tags to every substantive verbatim in
bjl_verbatims, writing to the *_haiku staging columns. Live columns
(joy_modes, tensions, etc.) are NOT touched — promotion is a separate
manual SQL step Eli runs after he reviews the staged tags.

Resume capability: if the script is interrupted, re-running it picks
up where it left off because the pull query filters to
joy_modes_haiku IS NULL (or whichever staging column is the gating
one). Already-tagged rows skip on the next run. Use --no-resume to
re-tag every substantive verbatim regardless.

Required env:
  ANTHROPIC_API_KEY
  DATABASE_URL  (Supavisor-pooler URL pattern)

Usage examples:
  # Full backfill
  python3 bin/backfill_frameworks.py

  # Cost dry-run on 100 verbatims (DB still gets written)
  python3 bin/backfill_frameworks.py --limit 100

  # Tag-only smoke (no DB write — useful before committing to a full run)
  python3 bin/backfill_frameworks.py --limit 10 --dry-run

  # Slower / gentler (avoid rate limits during business hours)
  python3 bin/backfill_frameworks.py --concurrency 4

CLI flags:
  --batch-size N           Verbatims per batch                   default 100
  --concurrency N          Parallel Haiku calls within a batch   default 8
  --limit N                Cap total verbatims processed         default unlimited
  --frameworks LIST        Which frameworks to write             default all four
  --resume / --no-resume   Skip rows where the gating staging
                           col is already non-NULL               default --resume
  --dry-run                Tag but don't write to DB             default false
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import psycopg2  # noqa: E402
from psycopg2.extras import execute_values  # noqa: E402

from framework_tagger import (  # noqa: E402
    load_frameworks_from_db,
    tag_verbatims_batch,
    BatchStats,
)


# Map each framework name → its staging column on bjl_verbatims.
# These already exist on the table; this commit does not modify schema.
STAGING_COLUMNS = {
    'joy_modes':       'joy_modes_haiku',
    'tensions':        'tensions_haiku',
    'functional_jobs': 'functional_jobs_haiku',
    'occasions':       'occasions_haiku',
}

# Gating column for the resume filter. Choosing joy_modes_haiku is
# arbitrary but consistent — every full tagger run writes all four,
# so the rows with joy_modes_haiku NULL are exactly the rows that
# haven't been tagged. (If a partial run wrote one column but not
# others, --no-resume forces a full re-run.)
RESUME_GATE_COLUMN = 'joy_modes_haiku'


# ---------------------------------------------------------------------------
# DB I/O
# ---------------------------------------------------------------------------

def count_remaining(conn, *, resume: bool, limit: int | None) -> int:
    """Count substantive verbatims still to process under the given
    resume / limit policy."""
    sql = (
        'SELECT COUNT(*) FROM bjl_verbatims '
        "WHERE LENGTH(TRIM(response_text)) >= 5"
    )
    if resume:
        sql += f' AND {RESUME_GATE_COLUMN} IS NULL'
    with conn.cursor() as cur:
        cur.execute(sql)
        n = int(cur.fetchone()[0])
    return min(n, limit) if limit is not None else n


def pull_batch(conn, *, batch_size: int, resume: bool, last_id: int) -> list[dict]:
    """Fetch the next batch of verbatims to tag.

    Iterates by id ASC starting after `last_id` so the script makes
    forward progress even when --no-resume is set.
    """
    sql = (
        'SELECT id, response_text, question_text FROM bjl_verbatims '
        "WHERE LENGTH(TRIM(response_text)) >= 5"
    )
    if resume:
        sql += f' AND {RESUME_GATE_COLUMN} IS NULL'
    sql += ' AND id > %s ORDER BY id ASC LIMIT %s'
    with conn.cursor() as cur:
        cur.execute(sql, (last_id, batch_size))
        rows = cur.fetchall()
    return [{'id': r[0], 'response_text': r[1], 'question_text': r[2]} for r in rows]


def bulk_update_staging(conn, results: list[dict], frameworks_to_write: list[str]) -> int:
    """Bulk-update the *_haiku staging columns + framework_scanned_at.

    Uses execute_values for one round-trip per batch instead of one
    UPDATE per row. Page size is the batch size — typically ≤100.

    Only updates the staging columns named in frameworks_to_write.
    Returns the number of rows updated (= len(results) on success).
    """
    if not results:
        return 0

    set_clauses = []
    select_cols = ['id']
    for fwk in frameworks_to_write:
        col = STAGING_COLUMNS[fwk]
        set_clauses.append(f'{col} = data.{fwk}')
        select_cols.append(fwk)
    set_clauses.append('framework_scanned_at = now()')

    select_sql = ', '.join(select_cols)
    update_sql = f"""
        UPDATE bjl_verbatims AS v
        SET {', '.join(set_clauses)}
        FROM (VALUES %s) AS data ({select_sql})
        WHERE v.id = data.id
    """

    rows = [
        tuple([r['id']] + [r[fwk] for fwk in frameworks_to_write])
        for r in results
    ]
    with conn.cursor() as cur:
        execute_values(cur, update_sql, rows, page_size=500)
    conn.commit()
    return len(rows)


# ---------------------------------------------------------------------------
# Main run loop
# ---------------------------------------------------------------------------

def fmt_rate(n: int, seconds: float) -> str:
    if seconds <= 0:
        return '— /min'
    return f'{60.0 * n / seconds:.0f} /min'


async def main_async(args: argparse.Namespace) -> None:
    if not os.environ.get('ANTHROPIC_API_KEY'):
        sys.exit('ANTHROPIC_API_KEY not set')
    if not os.environ.get('DATABASE_URL'):
        sys.exit('DATABASE_URL not set (use the Supavisor-pooler URL)')

    frameworks_to_write = [f.strip() for f in args.frameworks.split(',') if f.strip()]
    for fwk in frameworks_to_write:
        if fwk not in STAGING_COLUMNS:
            sys.exit(f'unknown framework: {fwk}. Valid: {",".join(STAGING_COLUMNS.keys())}')

    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        # Fix-once: load framework definitions and total count.
        frameworks = load_frameworks_from_db(conn)
        counts = {k: len(v) for k, v in frameworks.items()}
        print(f'Loaded frameworks: {counts}')

        total = count_remaining(conn, resume=args.resume, limit=args.limit)
        print(f'Substantive verbatims to tag: {total:,} '
              f'(resume={args.resume}, limit={args.limit})')
        print(f'Writing to staging columns: {[STAGING_COLUMNS[f] for f in frameworks_to_write]}')
        if args.dry_run:
            print('DRY RUN — tagger will run but DB will not be written')
        print()

        if total == 0:
            print('Nothing to tag.')
            return

        # Roll-up stats across all batches
        cumulative = BatchStats(n_total=total)
        last_id = 0
        processed = 0
        t_start = time.time()

        while processed < total:
            remaining_cap = total - processed
            this_batch = min(args.batch_size, remaining_cap)
            verbatims = pull_batch(conn, batch_size=this_batch, resume=args.resume, last_id=last_id)
            if not verbatims:
                # No more matching rows — early exit (e.g. another worker
                # tagged the rest, or the count above is stale).
                break

            results, stats = await tag_verbatims_batch(
                verbatims, frameworks, concurrency=args.concurrency,
            )

            if not args.dry_run:
                bulk_update_staging(conn, results, frameworks_to_write)

            # Roll up stats
            cumulative.n_success += stats.n_success
            cumulative.n_failed += stats.n_failed
            cumulative.total_input_tokens += stats.total_input_tokens
            cumulative.total_output_tokens += stats.total_output_tokens
            cumulative.failures.extend(stats.failures)

            processed += len(verbatims)
            last_id = max(v['id'] for v in verbatims)

            elapsed = time.time() - t_start
            cumulative.wall_seconds = elapsed
            print(
                f'  +{len(verbatims):3d}  total={processed}/{total} '
                f'({100*processed/total:5.1f}%)  '
                f'rate={fmt_rate(processed, elapsed)}  '
                f'cost=${cumulative.est_cost_usd:.3f}  '
                f'fail={cumulative.n_failed}'
            )

        print()
        print('=' * 70)
        print('SUMMARY')
        print('=' * 70)
        for k, v in cumulative.as_dict().items():
            if k == 'failures' and v:
                print(f'  {k}: {len(v)} (first 10): {v[:10]}')
            else:
                print(f'  {k}: {v}')
        if args.dry_run:
            print()
            print('DRY RUN — no DB writes performed.')
    finally:
        conn.close()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--batch-size', type=int, default=100,
                    help='Verbatims per batch (default 100)')
    ap.add_argument('--concurrency', type=int, default=8,
                    help='Parallel Haiku calls (default 8)')
    ap.add_argument('--limit', type=int, default=None,
                    help='Cap total verbatims processed (default: unlimited)')
    ap.add_argument('--frameworks', default='joy_modes,tensions,functional_jobs,occasions',
                    help='Comma-separated frameworks to write (default: all four)')
    resume_group = ap.add_mutually_exclusive_group()
    resume_group.add_argument('--resume', dest='resume', action='store_true',
                              help='Skip already-tagged rows (default)')
    resume_group.add_argument('--no-resume', dest='resume', action='store_false',
                              help='Re-tag every substantive verbatim regardless')
    ap.set_defaults(resume=True)
    ap.add_argument('--dry-run', action='store_true',
                    help='Tag verbatims but do NOT write to DB')
    ap.add_argument('--log-level', default='WARNING',
                    help='Python logging level (default WARNING)')
    args = ap.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.WARNING),
        format='%(asctime)s %(name)s %(levelname)s: %(message)s',
    )
    asyncio.run(main_async(args))


if __name__ == '__main__':
    main()
