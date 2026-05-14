#!/usr/bin/env python3
"""
Path 3: verify present_vs_future tag applications on the rows still carrying
it after the v7 retag. For each row, ask Haiku to keep-or-remove. Apply the
"remove" verdicts via array_remove and log them.

Uses prompt caching on the verification system prompt for cost efficiency.
"""

import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

REPO_ROOT = Path('/Users/haddowe/repos/brand-joy-lab')
sys.path.insert(0, str(REPO_ROOT / 'bin'))

import requests
from anthropic import AsyncAnthropic

SUPABASE_URL = os.environ['SUPABASE_URL']
SUPABASE_SERVICE_KEY = os.environ['SUPABASE_SERVICE_KEY']
ANTHROPIC_API_KEY = os.environ['ANTHROPIC_API_KEY']

HEADERS = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': f'Bearer {SUPABASE_SERVICE_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal',
}

MODEL = 'claude-haiku-4-5-20251001'
CONCURRENCY = 12
MAX_TOKENS = 200
LOG_PATH = Path('/Users/haddowe/repos/brand-joy-lab/logs/path3_verdicts.jsonl')

SYSTEM_PROMPT = """You are reviewing a verbatim previously tagged with the present_vs_future tension. Your job is to verify whether this tag application is correct.

The present_vs_future tension requires:
- An explicit PULL or GAP between a present-state desire/value AND a future-state desire/value
- BOTH pulls must be present in the verbatim text
- The respondent must express the trade-off, conflict, or gap between them
- Mere mention of the future, planning, or saving is NOT sufficient

CORRECT (keep tag):
- "Part of me wants to save for retirement, part of me wants to enjoy life now"
- "I should be planning ahead but I keep living for today"
- "Caught between investing in tomorrow and not missing out today"
- "I want to be present with my kids now but I'm always thinking about their future"

INCORRECT (remove tag):
- "Saving up for my 2026 vacation" (no present pull)
- "Planning my future career" (only future mention)
- "Looking forward to next year" (anticipation, not tension)
- "Spending time with family now" (only present mention)
- "Buying a house someday" (loose future, no present-side pull)

Read the verbatim. Output JSON only, no preamble:
{"verdict": "keep" | "remove", "reason": "<one short sentence>"}"""


def _http_with_retry(method, url, *, max_retries=8, **kwargs):
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
        sys.stderr.write(f'    [retry {attempt+1}/{max_retries} after {sleep_s}s] {method}: {last_err}\n')
        sys.stderr.flush()
        time.sleep(sleep_s)
    raise last_err


def fetch_pvf_rows():
    """Pull every bjl_verbatims row still carrying present_vs_future after the v7 retag."""
    url = f'{SUPABASE_URL}/rest/v1/bjl_verbatims'
    out = []
    last_id = 0
    while True:
        params = {
            'select': 'id,response_text,question_text',
            'tensions_haiku': 'cs.{present_vs_future}',
            'order': 'id.asc',
            'limit': '1000',
            'id': f'gt.{last_id}',
        }
        r = _http_with_retry('GET', url, headers=HEADERS, params=params, timeout=60)
        r.raise_for_status()
        rows = r.json()
        if not rows:
            break
        out.extend(rows)
        last_id = rows[-1]['id']
        if len(rows) < 1000:
            break
    return out


def parse_verdict(text):
    text = text.strip()
    # Strip code fences if present
    if text.startswith('```'):
        text = re.sub(r'^```(?:json)?\s*', '', text)
        text = re.sub(r'\s*```$', '', text)
    try:
        obj = json.loads(text)
        v = obj.get('verdict', '').lower().strip()
        if v in ('keep', 'remove'):
            return v, (obj.get('reason') or '').strip()
    except json.JSONDecodeError:
        pass
    return None, text[:200]


async def verify_one(client, row, sem):
    async with sem:
        for attempt in range(4):
            try:
                rsp = await client.messages.create(
                    model=MODEL,
                    max_tokens=MAX_TOKENS,
                    system=[{
                        'type': 'text',
                        'text': SYSTEM_PROMPT,
                        'cache_control': {'type': 'ephemeral'},
                    }],
                    messages=[{
                        'role': 'user',
                        'content': (
                            f"Verbatim: {row['response_text']}\n\n"
                            f"Question context: {row.get('question_text') or '(none)'}"
                        ),
                    }],
                )
                text = ''.join(b.text for b in rsp.content if b.type == 'text')
                verdict, reason = parse_verdict(text)
                return {
                    'id': row['id'],
                    'verdict': verdict,
                    'reason': reason,
                    'usage': {
                        'input': rsp.usage.input_tokens,
                        'output': rsp.usage.output_tokens,
                        'cache_creation': getattr(rsp.usage, 'cache_creation_input_tokens', 0),
                        'cache_read': getattr(rsp.usage, 'cache_read_input_tokens', 0),
                    },
                }
            except Exception as e:
                if attempt < 3:
                    await asyncio.sleep(2 ** (attempt + 1))
                    continue
                return {'id': row['id'], 'verdict': None, 'error': str(e)[:200]}


async def main():
    print('Fetching present_vs_future rows after v7 retag...')
    rows = fetch_pvf_rows()
    print(f'Total to verify: {len(rows):,}\n')

    client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    sem = asyncio.Semaphore(CONCURRENCY)
    tasks = [verify_one(client, row, sem) for row in rows]

    keep_ids = []
    remove_ids = []
    error_ids = []
    cumulative = {'in': 0, 'out': 0, 'cache_w': 0, 'cache_r': 0}
    t0 = time.time()

    with LOG_PATH.open('w') as f:
        for i, coro in enumerate(asyncio.as_completed(tasks), 1):
            r = await coro
            f.write(json.dumps(r) + '\n')
            if r.get('verdict') == 'keep':
                keep_ids.append(r['id'])
            elif r.get('verdict') == 'remove':
                remove_ids.append(r['id'])
            else:
                error_ids.append(r['id'])
            u = r.get('usage') or {}
            cumulative['in']      += u.get('input', 0)
            cumulative['out']     += u.get('output', 0)
            cumulative['cache_w'] += u.get('cache_creation', 0)
            cumulative['cache_r'] += u.get('cache_read', 0)
            if i % 50 == 0 or i == len(rows):
                elapsed = time.time() - t0
                rate = i / elapsed if elapsed else 0
                cost = (cumulative['in'] / 1e6 * 1.0
                        + cumulative['out'] / 1e6 * 5.0
                        + cumulative['cache_w'] / 1e6 * 1.25
                        + cumulative['cache_r'] / 1e6 * 0.10)
                print(f'  {i:>5}/{len(rows):,}  keep={len(keep_ids)}  remove={len(remove_ids)}  err={len(error_ids)}  '
                      f'cost=${cost:.2f}  rate={rate:.1f}/s')

    # Save the verdict-id lists for the next step
    Path('/tmp/path3_keep_ids.json').write_text(json.dumps(keep_ids))
    Path('/tmp/path3_remove_ids.json').write_text(json.dumps(remove_ids))
    Path('/tmp/path3_error_ids.json').write_text(json.dumps(error_ids))
    print()
    print(f'Done. keep={len(keep_ids)}  remove={len(remove_ids)}  errors={len(error_ids)}')
    print(f'Cost estimate: total tokens in={cumulative["in"]:,} out={cumulative["out"]:,} cache_w={cumulative["cache_w"]:,} cache_r={cumulative["cache_r"]:,}')
    print(f'Verdict log: {LOG_PATH}')
    print(f'Remove-ids list: /tmp/path3_remove_ids.json')


if __name__ == '__main__':
    asyncio.run(main())
