#!/usr/bin/env python3
"""
v7 targeted retag: re-tag the 10,201 bjl_verbatims rows that carry at least
one of the six v6 over-firers, using the patched (Rule 9) framework_tagger
prompt. Writes via bjl_update_haiku_tags_v7 RPC which also sets
framework_version='v7'.

Reads: GET /rest/v1/bjl_verbatims with PostgREST `id=in.(...)` chunks.
Writes: POST /rest/v1/rpc/bjl_update_haiku_tags_v7 with the standard
        {rows: [...]} payload.

Run from repo root:
  ANTHROPIC_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
    python3 -u /tmp/retag_v7_overfirers.py
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

REPO_ROOT = Path('/Users/haddowe/repos/brand-joy-lab')
sys.path.insert(0, str(REPO_ROOT / 'bin'))
sys.path.insert(0, '/tmp')

import requests
import importlib.util
spec = importlib.util.spec_from_file_location('rro', '/tmp/run_regression_offline.py')
rro = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rro)
FRAMEWORKS = rro.FRAMEWORKS

from framework_tagger import tag_verbatims_batch  # type: ignore

SUPABASE_URL = os.environ['SUPABASE_URL']
SUPABASE_SERVICE_KEY = os.environ['SUPABASE_SERVICE_KEY']
HEADERS = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': f'Bearer {SUPABASE_SERVICE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
}

def _http_with_retry(method, url, *, max_retries=8, **kwargs):
    """Wraps requests.{get,post} with exponential backoff on transient errors."""
    last_err = None
    for attempt in range(max_retries + 1):
        try:
            r = requests.request(method, url, **kwargs)
            if r.status_code < 500 and r.status_code != 429:
                return r
            last_err = RuntimeError(f'HTTP {r.status_code}: {r.text[:200]}')
        except (requests.ConnectionError, requests.Timeout) as e:
            last_err = e
        if attempt >= max_retries:
            break
        sleep_s = min(2 ** (attempt + 1), 32)
        sys.stderr.write(f'    [retry {attempt+1}/{max_retries} after {sleep_s}s] {method} {url.split("?")[0]}: {last_err}\n')
        sys.stderr.flush()
        time.sleep(sleep_s)
    raise last_err


CONCURRENCY = 8
TAG_BATCH = 50          # rows per Haiku batch
FETCH_CHUNK = 200       # rows per PostgREST IN-filter fetch
WRITE_BATCH = 50        # rows per RPC write call


def fetch_affected_ids():
    """Pull every id whose v6 tags include at least one of the six over-firers."""
    url = f'{SUPABASE_URL}/rest/v1/bjl_verbatims'
    # PostgREST does not directly support array-overlap on multiple columns via
    # query string, so we fetch in two passes (joy_modes_haiku=in then unions
    # for each over-firer). The cleanest is one IN-filter per over-firer.
    over_firers = [
        ('occasions_haiku', 'anticipation'),
        ('occasions_haiku', 'everyday'),
        ('occasions_haiku', 'post_purchase'),
        ('joy_modes_haiku', 'inspirational'),
        ('tensions_haiku', 'present_vs_future'),
        ('tensions_haiku', 'aspiration_vs_acceptance'),
    ]
    seen = set()
    for col, tag in over_firers:
        # paginate by id ASC
        last_id = 0
        page = 0
        while True:
            params = {
                'select': 'id',
                'order': 'id.asc',
                'limit': '1000',
                col: f'cs.{{{tag}}}',  # array contains
                'id': f'gt.{last_id}',
                'framework_scanned_at': 'not.is.null',
                'framework_version': 'eq.v6',  # skip rows already retagged to v7
            }
            r = requests.get(url, headers=HEADERS, params=params, timeout=60)
            r.raise_for_status()
            rows = r.json()
            if not rows:
                break
            for row in rows:
                seen.add(row['id'])
            last_id = rows[-1]['id']
            page += 1
            if len(rows) < 1000:
                break
        print(f'  + {col} contains {tag:32s}: cumulative unique = {len(seen):,}')
    return sorted(seen)


def fetch_verbatims_by_id(id_chunk):
    """Fetch full verbatim payloads for a chunk of ids."""
    url = f'{SUPABASE_URL}/rest/v1/bjl_verbatims'
    params = {
        'select': 'id,response_text,question_text',
        'id': f'in.({",".join(str(i) for i in id_chunk)})',
        'order': 'id.asc',
    }
    r = _http_with_retry('GET', url, headers=HEADERS, params=params, timeout=60)
    r.raise_for_status()
    return r.json()


def write_v7(results):
    """POST tag results to bjl_update_haiku_tags_v7."""
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
    url = f'{SUPABASE_URL}/rest/v1/rpc/bjl_update_haiku_tags_v7'
    rsp = _http_with_retry('POST', url, headers=HEADERS, json={'rows': payload}, timeout=120)
    if rsp.status_code != 200:
        ids = [p['id'] for p in payload]
        raise RuntimeError(
            f'RPC bjl_update_haiku_tags_v7 failed: status={rsp.status_code} '
            f'batch_size={len(payload)} ids[{ids[0]}..{ids[-1]}] '
            f'body={rsp.text[:400]}'
        )
    return len(payload)


async def main():
    print('Fetching affected verbatim IDs...')
    affected = fetch_affected_ids()
    print(f'Total affected verbatims: {len(affected):,}\n')

    if not affected:
        print('Nothing to do.')
        return

    print(f'Retagging at concurrency={CONCURRENCY}, tag_batch={TAG_BATCH}, fetch_chunk={FETCH_CHUNK}, write_batch={WRITE_BATCH}\n')

    total = len(affected)
    processed = 0
    written = 0
    cumulative_cost = 0.0
    cumulative_failed = 0
    t0 = time.time()

    for chunk_start in range(0, total, FETCH_CHUNK):
        chunk_ids = affected[chunk_start:chunk_start + FETCH_CHUNK]
        verbatims = fetch_verbatims_by_id(chunk_ids)
        # Run Haiku across the chunk (filtered to substantive >=5 chars)
        verbatims = [v for v in verbatims if v.get('response_text') and len(v['response_text'].strip()) >= 5]
        if not verbatims:
            processed += len(chunk_ids)
            continue
        results, stats = await tag_verbatims_batch(verbatims, FRAMEWORKS, concurrency=CONCURRENCY)
        cumulative_cost += stats.est_cost_usd
        cumulative_failed += stats.n_failed
        # Write in WRITE_BATCH-sized sub-batches
        for w_start in range(0, len(results), WRITE_BATCH):
            sub = results[w_start:w_start + WRITE_BATCH]
            n = write_v7(sub)
            written += n
        processed += len(chunk_ids)
        elapsed = time.time() - t0
        rate = processed / elapsed if elapsed else 0
        eta = (total - processed) / rate / 60 if rate else 0
        print(f'  {processed:>6,}/{total:,} ({100*processed/total:5.1f}%)  '
              f'cost=${cumulative_cost:6.2f}  wrote={written:,}  '
              f'failed_llm={cumulative_failed}  rate={rate:.1f}/s  eta={eta:.0f}min')

    elapsed = time.time() - t0
    print()
    print(f'Done. Retagged {written:,} verbatims in {elapsed/60:.1f} min')
    print(f'Cost: ${cumulative_cost:.2f}')
    print(f'LLM-failed: {cumulative_failed} (these rows keep their v6 tags)')


if __name__ == '__main__':
    asyncio.run(main())
