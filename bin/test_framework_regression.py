#!/usr/bin/env python3
"""
test_framework_regression.py — DB-backed regression test for the
framework tagger against Eli's calibrated 16-verbatim fixture.

Loads the YAML block from data/framework_regression_fixture.md, fetches
each verbatim from the live BJL DB by id, runs the tagger, and validates
the output per the strict pass criteria documented in the fixture:

  must_include ⊆ output                         (required tags present)
  output ⊆ (must_include ∪ may_include)         (no spurious tags)
  must_not_include ∩ output = ∅                 (anti-pattern tags absent)

Reports per-fixture pass/fail and surfaces the five canonical anti-pattern
failures separately. Exits non-zero on any failure.

Required env:
  ANTHROPIC_API_KEY
  DATABASE_URL (Supavisor-pooler URL pattern)

Usage:
  python3 bin/test_framework_regression.py
  python3 bin/test_framework_regression.py --concurrency 4   # slower, gentler

Cost: ~$0.06 (16 verbatims at ~$0.004 each). Wall time ~30-60s.
"""

import argparse
import asyncio
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import psycopg2  # noqa: E402

from framework_tagger import (  # noqa: E402
    load_frameworks_from_db,
    tag_verbatims_batch,
)


FIXTURE_PATH = Path(__file__).resolve().parent.parent / 'data' / 'framework_regression_fixture.md'

# Five canonical failures from the fixture's "Failure cases that should
# immediately invalidate the prompt" section. If any of these specific
# (verbatim_id, framework, tag) triples appear, the regression has hit
# the calibration anti-patterns we explicitly designed against.
CANONICAL_FAILURES = [
    (35116, 'joy_modes', 'aesthetic'),       # category-driven inference
    (21779, 'joy_modes', 'freedom'),         # vacation-context inference
    (63474, 'functional_jobs', 'plan_future'),  # Job-vs-Tension confusion
    (63600, 'occasions', 'work'),            # surface-word confusion
    (63318, 'occasions', 'mealtime'),        # category-context inference
]


def parse_fixture(md_path: Path) -> list[dict]:
    """Extracts the YAML fixtures from the markdown document.

    The fixture lives in a ```yaml ... ``` fence inside the .md. We
    parse the YAML and return the list of fixture dicts under the
    'fixtures' key.
    """
    text = md_path.read_text()
    m = re.search(r'```yaml\s*\n(.*?)\n```', text, re.DOTALL)
    if not m:
        raise RuntimeError(f'no yaml block found in {md_path}')
    yaml_text = m.group(1)
    try:
        import yaml  # type: ignore
    except ImportError:
        sys.exit(
            'pyyaml not installed. Run: pip install -r requirements-tagger.txt'
        )
    parsed = yaml.safe_load(yaml_text)
    if not isinstance(parsed, dict) or 'fixtures' not in parsed:
        raise RuntimeError(f'malformed fixture: missing "fixtures" key in {md_path}')
    return parsed['fixtures']


def fetch_verbatims(conn, ids: list[int]) -> dict[int, dict]:
    """Returns {id: {response_text, question_text}} for the given IDs."""
    out: dict[int, dict] = {}
    with conn.cursor() as cur:
        cur.execute(
            'SELECT id, response_text, question_text FROM bjl_verbatims '
            'WHERE id = ANY(%s)',
            (ids,),
        )
        for row in cur.fetchall():
            out[row[0]] = {'id': row[0], 'response_text': row[1], 'question_text': row[2]}
    return out


def evaluate(fixture: dict, output: dict) -> tuple[bool, list[str]]:
    """Validates one fixture's output. Returns (passed, list_of_violations)."""
    violations: list[str] = []
    expected = fixture.get('expected', {}) or {}
    for fwk in ('joy_modes', 'tensions', 'functional_jobs', 'occasions'):
        spec = expected.get(fwk, {}) or {}
        must = set(spec.get('must_include') or [])
        may = set(spec.get('may_include') or [])
        must_not = set(spec.get('must_not_include') or [])
        out = set(output.get(fwk) or [])
        # must_include ⊆ output
        missing = must - out
        if missing:
            violations.append(f'{fwk}: missing must_include {sorted(missing)} (got {sorted(out)})')
        # output ⊆ (must ∪ may)
        spurious = out - (must | may)
        if spurious:
            violations.append(f'{fwk}: spurious tags {sorted(spurious)} not in must/may (got {sorted(out)})')
        # must_not_include ∩ output = ∅
        forbidden = out & must_not
        if forbidden:
            violations.append(f'{fwk}: forbidden tags present {sorted(forbidden)}')
    return len(violations) == 0, violations


async def main_async(args):
    if not os.environ.get('ANTHROPIC_API_KEY'):
        sys.exit('ANTHROPIC_API_KEY not set')
    if not os.environ.get('DATABASE_URL'):
        sys.exit('DATABASE_URL not set (use the Supavisor-pooler URL)')

    fixtures = parse_fixture(FIXTURE_PATH)
    print(f'Loaded {len(fixtures)} fixtures from {FIXTURE_PATH.name}')

    fixture_ids = [int(f['id']) for f in fixtures]
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        verbatims_by_id = fetch_verbatims(conn, fixture_ids)
        missing = [i for i in fixture_ids if i not in verbatims_by_id]
        if missing:
            sys.exit(f'fixture IDs not found in bjl_verbatims: {missing}')
        print(f'Fetched {len(verbatims_by_id)} verbatims from DB')

        frameworks = load_frameworks_from_db(conn)
        counts = {k: len(v) for k, v in frameworks.items()}
        print(f'Loaded frameworks: {counts}')
    finally:
        conn.close()

    # Order results by fixture order (so the report aligns)
    inputs = [verbatims_by_id[int(f['id'])] for f in fixtures]
    print(f'Tagging {len(inputs)} fixtures at concurrency={args.concurrency}...')
    results, stats = await tag_verbatims_batch(
        inputs, frameworks, concurrency=args.concurrency,
    )
    print(f'Done: {stats.as_dict()}')
    print()

    # Evaluate each fixture
    n_pass = 0
    canonical_hits: list[str] = []
    for fixture, result in zip(fixtures, results):
        fid = int(fixture['id'])
        notes = (fixture.get('notes') or '').strip()
        excerpt = (fixture.get('excerpt') or '').strip()
        ok, violations = evaluate(fixture, result)

        # Check canonical failures
        for cfid, cfwk, ctag in CANONICAL_FAILURES:
            if cfid == fid and ctag in (result.get(cfwk) or []):
                canonical_hits.append(f'{fid} -> {cfwk}={ctag} (CANONICAL FAILURE)')

        status = 'PASS' if ok else 'FAIL'
        print(f'[{status}] id={fid} — {excerpt[:80]}{"…" if len(excerpt) > 80 else ""}')
        if notes:
            print(f'        notes: {notes}')
        for fwk in ('joy_modes', 'tensions', 'functional_jobs', 'occasions'):
            tags = result.get(fwk) or []
            if tags:
                print(f'        {fwk}: {tags}')
        if not ok:
            for v in violations:
                print(f'        - {v}')
        else:
            n_pass += 1
        print()

    print('=' * 70)
    print(f'SUMMARY: {n_pass}/{len(fixtures)} fixtures passed')
    print(f'Cost (USD): ${stats.est_cost_usd:.4f}')
    print(f'Wall time:  {stats.wall_seconds:.1f}s')
    if canonical_hits:
        print()
        print('CANONICAL ANTI-PATTERN FAILURES (these should NOT appear):')
        for h in canonical_hits:
            print(f'  - {h}')
        print('The prompt needs adjustment before the cost dry-run.')
    print()

    if n_pass < len(fixtures) or canonical_hits:
        sys.exit(1)
    print('Regression PASSED. Safe to proceed to cost dry-run.')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--concurrency', type=int, default=4,
                    help='Parallel Haiku calls (default 4 — gentler than backfill default of 8)')
    args = ap.parse_args()
    asyncio.run(main_async(args))


if __name__ == '__main__':
    main()
