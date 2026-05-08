#!/usr/bin/env python3
"""REST-API backfill driver for the framework tagger.

Drop-in alternative to bin/backfill_frameworks.py for environments where the
Supavisor pooler tenant isn't provisioned (modern Supabase projects).
Uses PostgREST endpoints with the service-role key for both reads and writes.

Reads: GET /rest/v1/bjl_verbatims with PostgREST filtering and pagination.
Writes: PATCH /rest/v1/bjl_verbatims?id=in.(...) — bulk update of matching rows
        per-batch with one HTTP call per batch.

The framework definitions are also fetched via REST (joy_modes, tensions,
functional_jobs, occasions tables).

Required environment:
  SUPABASE_URL          — https://<project>.supabase.co
  SUPABASE_SERVICE_KEY  — service-role JWT (Settings → API → service_role)
  ANTHROPIC_API_KEY     — Anthropic API key (used by tagger module)

Optional CLI flags:
  --batch-size N      default 200
  --concurrency N     default 8
  --limit N           cap total verbatims (smoke / cost dry runs)
  --resume / --no-resume  default --resume; skips rows where joy_modes_haiku is not null
  --dry-run           tag but do not write back
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time
from pathlib import Path

import requests  # type: ignore

# Tagger module is in the same dir
sys.path.insert(0, str(Path(__file__).resolve().parent))
from framework_tagger import tag_verbatims_batch  # type: ignore


# ---------------------------------------------------------------------------
# REST client helpers
# ---------------------------------------------------------------------------

def _headers():
    key = os.environ['SUPABASE_SERVICE_KEY']
    return {
        'apikey': key,
        'Authorization': f'Bearer {key}',
        'Content-Type': 'application/json',
    }


def _base():
    return os.environ['SUPABASE_URL'].rstrip('/')


def fetch_frameworks() -> dict:
    """Pulls the four framework tables via REST."""
    base = _base()
    h = _headers()
    out: dict[str, list] = {}
    spec = {
        'joy_modes':       ('bjl_joy_modes',       'mode_key',     'short_definition'),
        'tensions':        ('bjl_tensions',        'tension_key',  'description'),
        'functional_jobs': ('bjl_functional_jobs', 'job_key',      'description'),
        'occasions':       ('bjl_occasions',       'occasion_key', 'description'),
    }
    for fwk, (table, key_col, def_col) in spec.items():
        url = f'{base}/rest/v1/{table}'
        params = {'select': f'{key_col},display_name,{def_col}', 'order': key_col}
        r = _http_with_retry('GET', url, headers=h, params=params, timeout=30)
        r.raise_for_status()
        rows = r.json()
        out[fwk] = [
            {'key': row[key_col], 'display_name': row['display_name'],
             'definition': row.get(def_col) or ''}
            for row in rows
        ]
    return out


def count_remaining(resume: bool) -> int:
    """Returns the count of substantive verbatims still needing tags."""
    base = _base()
    h = _headers() | {'Prefer': 'count=exact'}
    url = f'{base}/rest/v1/bjl_verbatims'
    params = {'select': 'id', 'limit': '1'}
    if resume:
        params['joy_modes_haiku'] = 'is.null'
    # length filter via PostgREST: "char_length(response_text)>=5" isn't directly
    # exposed; we apply the >= 5 filter in Python. The total count from REST
    # excludes that, but practically all verbatims in bjl_verbatims have content.
    r = _http_with_retry('GET', url, headers=h, params=params, timeout=30)
    r.raise_for_status()
    cr = r.headers.get('Content-Range', '')
    # Format: '0-0/12345'
    if '/' in cr:
        try:
            return int(cr.split('/')[-1])
        except (ValueError, IndexError):
            return 0
    return 0


def _http_with_retry(method: str, url: str, *, headers: dict, max_retries: int = 8, **kwargs):
    """Wraps requests.{get,post} with exponential backoff on transient
    network/timeout errors and 5xx responses. Returns the requests.Response.

    Retries on:
      - requests.ConnectionError (includes TimeoutError on connection)
      - requests.Timeout
      - 5xx status codes (server errors)
      - 429 rate limiting

    Does NOT retry on 4xx client errors (other than 429).
    Backoff: 2s, 4s, 8s, 16s, 32s.
    """
    import time
    last_err: Exception | None = None
    for attempt in range(max_retries + 1):
        try:
            r = requests.request(method, url, headers=headers, **kwargs)
            if r.status_code < 500 and r.status_code != 429:
                return r
            # 5xx or 429 — fall through to retry path
            last_err = RuntimeError(f'HTTP {r.status_code}: {r.text[:200]}')
        except (requests.ConnectionError, requests.Timeout) as e:
            last_err = e
        if attempt >= max_retries:
            break
        sleep_s = min(2 ** (attempt + 1), 32)
        sys.stderr.write(f'    [retry {attempt+1}/{max_retries} after {sleep_s}s] {method} {url.split("?")[0]}: {last_err}\n')
        sys.stderr.flush()
        time.sleep(sleep_s)
    raise last_err  # type: ignore[misc]


def fetch_batch(batch_size: int, resume: bool, last_id: int | None = None) -> tuple[list[dict], int | None]:
    """Fetches the next batch of verbatims. Uses keyset pagination by id ASC.

    Returns a tuple of (filtered_rows, raw_max_id) so the caller can
    advance the cursor even when all rows in this batch were filtered
    out for being too short. Without this, the loop can terminate
    prematurely when the next page is dominated by short verbatims.
    """
    base = _base()
    h = _headers()
    url = f'{base}/rest/v1/bjl_verbatims'
    params = {
        'select': 'id,response_text,question_text',
        'order': 'id.asc',
        'limit': str(batch_size),
    }
    if resume:
        params['joy_modes_haiku'] = 'is.null'
    if last_id is not None:
        params['id'] = f'gt.{last_id}'
    r = _http_with_retry('GET', url, headers=h, params=params, timeout=60)
    r.raise_for_status()
    rows = r.json()
    raw_max_id = max((r['id'] for r in rows), default=None)
    # Filter to substantive (>=5 chars) on the client.
    filtered = [r for r in rows if r.get('response_text') and len(r['response_text'].strip()) >= 5]
    return filtered, raw_max_id


def update_batch(results: list[dict]) -> int:
    """Writes tag results to the staging columns via the bulk-update RPC
    (bjl_update_haiku_tags). One HTTP call per batch, one SQL transaction
    on the server side."""
    base = _base()
    h = _headers()
    payload = []
    for r in results:
        if not r.get('ok'):
            continue
        payload.append({
            'id':                    r['id'],
            'joy_modes_haiku':       r.get('joy_modes') or [],
            'tensions_haiku':        r.get('tensions') or [],
            'functional_jobs_haiku': r.get('functional_jobs') or [],
            'occasions_haiku':       r.get('occasions') or [],
        })
    if not payload:
        return 0
    url = f'{base}/rest/v1/rpc/bjl_update_haiku_tags'
    rsp = _http_with_retry('POST', url, headers=h, json={'rows': payload}, timeout=120)
    if rsp.status_code != 200:
        # Surface the server-side error body so we can diagnose mid-backfill.
        ids = [p['id'] for p in payload]
        raise RuntimeError(
            f'RPC bjl_update_haiku_tags failed: status={rsp.status_code} '
            f'batch_size={len(payload)} ids[{ids[0]}..{ids[-1]}] '
            f'body={rsp.text[:600]}'
        )
    # The RPC returns the row count as a JSON integer.
    return int(rsp.text or '0')


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main_async(args):
    for var in ('SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY'):
        if not os.environ.get(var):
            sys.exit(f'missing env var: {var}')

    print('Fetching frameworks via REST...')
    frameworks = fetch_frameworks()
    counts = {k: len(v) for k, v in frameworks.items()}
    print(f'Frameworks loaded: {counts}')
    if any(counts[k] == 0 for k in counts):
        sys.exit('Empty framework table. Aborting.')

    total = count_remaining(args.resume)
    if args.limit:
        total = min(total, args.limit)
    print(f'Target: {total} verbatims at concurrency={args.concurrency}, batch_size={args.batch_size}')
    print()

    processed = 0
    last_id: int | None = None
    cumulative_cost = 0.0
    cumulative_tokens_in = 0
    cumulative_tokens_out = 0
    cumulative_cache_writes = 0
    cumulative_cache_reads = 0
    n_failed_total = 0
    t0 = time.time()

    while processed < total:
        remaining = total - processed
        bs = min(args.batch_size, remaining)
        batch, raw_max_id = fetch_batch(bs, args.resume, last_id)
        if raw_max_id is None:
            # Server returned zero rows — we're at the end of the dataset.
            print('No more verbatims to fetch — stopping.')
            break
        # Always advance the cursor by the raw max id, even if all rows in
        # this batch were filtered out for being too short. This prevents
        # premature termination when the next page is dominated by sub-5-char
        # verbatims (which the tagger correctly skips).
        last_id = raw_max_id
        if not batch:
            # Filtered out entirely; loop again to fetch more.
            continue

        results, stats = await tag_verbatims_batch(
            batch, frameworks, concurrency=args.concurrency
        )

        if not args.dry_run:
            try:
                n_written = update_batch(results)
            except Exception as e:
                # Persistent write failure (after _http_with_retry exhausted
                # its 5 retries). Log and continue rather than crash the
                # whole multi-hour run. The failed rows stay NULL in
                # staging and will be picked up on the next --resume.
                ids = [r.get('id') for r in results if r.get('ok')][:5]
                sys.stderr.write(
                    f'    [WRITE FAILED — skipping batch] {type(e).__name__}: {e}\n'
                    f'    [skipped ids preview] {ids}{"..." if len(results) > 5 else ""}\n'
                    f'    [these rows stay NULL in staging; will be retried on next --resume]\n'
                )
                sys.stderr.flush()
                n_written = 0
        else:
            n_written = 0

        processed += len(batch)
        cumulative_cost += stats.est_cost_usd
        cumulative_tokens_in += stats.total_input_tokens
        cumulative_tokens_out += stats.total_output_tokens
        cumulative_cache_writes += stats.total_cache_creation_tokens
        cumulative_cache_reads += stats.total_cache_read_tokens
        n_failed_total += stats.n_failed

        elapsed = time.time() - t0
        rate = processed / elapsed if elapsed > 0 else 0
        eta_min = (total - processed) / rate / 60 if rate > 0 else 0
        print(
            f'  +{len(batch)} → {processed}/{total} '
            f'({processed*100//max(total,1)}%) '
            f'cost ${cumulative_cost:.2f} '
            f'cache_read={cumulative_cache_reads:,} cache_write={cumulative_cache_writes:,} '
            f'failed={n_failed_total} '
            f'rate={rate:.1f}/s '
            f'eta={eta_min:.0f}min '
            f'wrote={n_written}'
        )

    print()
    elapsed = time.time() - t0
    print(f'Done. {processed} verbatims tagged in {elapsed/60:.1f} min')
    print(f'Cost: ${cumulative_cost:.2f}')
    print(f'Tokens: in={cumulative_tokens_in:,} cache_w={cumulative_cache_writes:,} '
          f'cache_r={cumulative_cache_reads:,} out={cumulative_tokens_out:,}')
    if n_failed_total > 0:
        print(f'Failures: {n_failed_total} (these verbatims were left untagged; re-run with --resume to retry)')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--batch-size', type=int, default=200)
    ap.add_argument('--concurrency', type=int, default=8)
    ap.add_argument('--limit', type=int, default=None,
                    help='cap total verbatims (smoke / cost dry runs)')
    ap.add_argument('--resume', dest='resume', action='store_true', default=True)
    ap.add_argument('--no-resume', dest='resume', action='store_false')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    asyncio.run(main_async(args))


if __name__ == '__main__':
    main()
