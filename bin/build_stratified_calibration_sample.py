#!/usr/bin/env python3
"""
Build a stratified calibration sample for the v7-tagged corpus.

Stratification logic:
  - 6 v7 over-firers (anticipation, everyday, post_purchase, inspirational,
    present_vs_future, aspiration_vs_acceptance): 12 positives each
  - 4 v6 "fixed" wins (achievement, signal_identity, served_vs_overlooked,
    dwelling_vs_advancing): 8 positives each
  - 24 untested tags (confidence_band='untested'): up to 5 positives each,
    falling back to fewer if the tag has limited corpus volume
  - 20 thin / control verbatims (response_text length 5-25 chars OR carrying
    zero tags across all four frameworks) to test Rule 4

Output: data/calibration_v7_sample_300.md — a YAML-fronted fixture file with
each verbatim's current v7 tags ready for Eli to adjudicate (mark up to remove
incorrect tags or add missing must_include tags). The same calibration runner
that handles the 50-sample fixture can then process this larger sample.
"""

import os
import re
import sys
from collections import OrderedDict
from pathlib import Path

import requests

SUPABASE_URL = os.environ['SUPABASE_URL']
SUPABASE_SERVICE_KEY = os.environ['SUPABASE_SERVICE_KEY']
HEADERS = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': f'Bearer {SUPABASE_SERVICE_KEY}',
}

OUT = Path('/Users/haddowe/repos/brand-joy-lab/data/calibration_v7_sample_300.md')

OVER_FIRERS = {
    'joy_modes': ['inspirational'],
    'tensions': ['present_vs_future', 'aspiration_vs_acceptance'],
    'occasions': ['anticipation', 'everyday', 'post_purchase'],
}
FIXED_WINS = {
    'joy_modes': ['achievement'],
    'tensions': ['served_vs_overlooked', 'dwelling_vs_advancing'],
    'functional_jobs': ['signal_identity'],
}
N_OVERFIRER = 12
N_FIXED = 8
N_UNTESTED = 5
N_THIN = 20


def fetch_untested_tags():
    """Get every tag where confidence_band='untested'."""
    r = requests.get(
        f'{SUPABASE_URL}/rest/v1/bjl_tag_calibration',
        headers=HEADERS,
        params={'select': 'framework,tag_key', 'confidence_band': 'eq.untested', 'order': 'framework,tag_key'},
        timeout=30,
    )
    r.raise_for_status()
    return [(row['framework'], row['tag_key']) for row in r.json()]


COLUMN_MAP = {
    'joy_modes': 'joy_modes',
    'tensions': 'tensions',
    'functional_jobs': 'functional_jobs',
    'occasions': 'occasions',
}


def sample_for_tag(framework, tag, n, excluded_ids):
    """Pull up to n random-ish verbatims carrying the tag, excluding already-picked ids."""
    col = COLUMN_MAP[framework]
    # Strategy: pull a larger pool, then sample. We use modulo on id as a cheap
    # randomizer since random() inside a function is non-deterministic and we
    # want reproducible sampling.
    params = {
        'select': 'id,response_text,question_text,joy_modes,tensions,functional_jobs,occasions',
        col: f'cs.{{{tag}}}',
        'limit': '500',
        'order': 'id.asc',
    }
    r = requests.get(f'{SUPABASE_URL}/rest/v1/bjl_verbatims', headers=HEADERS, params=params, timeout=60)
    r.raise_for_status()
    pool = [row for row in r.json() if row['id'] not in excluded_ids and (row.get('response_text') or '').strip()]
    # Take every (len(pool)//n)-th row for a quasi-random stratified spread
    if not pool:
        return []
    step = max(1, len(pool) // max(n, 1))
    picked = []
    i = 0
    while len(picked) < n and i < len(pool):
        picked.append(pool[i])
        i += step
    return picked[:n]


def sample_thin(n, excluded_ids):
    """Pull short verbatims (5-25 chars) or zero-tag verbatims for Rule 4 control."""
    r = requests.get(
        f'{SUPABASE_URL}/rest/v1/bjl_verbatims',
        headers=HEADERS,
        params={
            'select': 'id,response_text,question_text,joy_modes,tensions,functional_jobs,occasions',
            'response_text': 'not.is.null',
            'limit': '500',
            'order': 'id.asc',
            'id': 'gt.5000',  # skip first chunk where short rows cluster
        },
        timeout=60,
    )
    r.raise_for_status()
    pool = []
    for row in r.json():
        if row['id'] in excluded_ids:
            continue
        text = (row.get('response_text') or '').strip()
        if 5 <= len(text) <= 25:
            pool.append(row)
        elif (
            not (row.get('joy_modes') or [])
            and not (row.get('tensions') or [])
            and not (row.get('functional_jobs') or [])
            and not (row.get('occasions') or [])
        ):
            pool.append(row)
    if not pool:
        return []
    step = max(1, len(pool) // max(n, 1))
    return [pool[i] for i in range(0, len(pool), step)][:n]


def render_fixture(items):
    """Build the YAML-fronted markdown fixture file."""
    lines = []
    lines.append('# v7 Calibration Sample (stratified ~300 verbatims)')
    lines.append('')
    lines.append('Adjudicate each verbatim by editing the `must_include`, `may_include`, '
                 'and `must_not_include` fields per framework. The calibration runner '
                 '(`bin/test_framework_regression.py` or the offline variant) will '
                 'compute per-tag precision/recall from your annotations.')
    lines.append('')
    lines.append('Each fixture entry was pre-populated with the current v7 tags. If those '
                 'tags are correct, copy them into `must_include`. If any is wrong, '
                 'move it into `must_not_include`. Add any tags v7 missed.')
    lines.append('')
    lines.append('```yaml')
    lines.append('fixtures:')
    for it in items:
        lines.append(f"  - id: {it['id']}")
        lines.append(f"    stratum: {it['stratum']!r}")
        excerpt = (it['response_text'] or '').replace('"', "'").replace('\n', ' ').strip()[:120]
        lines.append(f'    excerpt: "{excerpt}"')
        qt = (it.get('question_text') or '').replace('"', "'").replace('\n', ' ').strip()[:120]
        lines.append(f'    question: "{qt}"')
        lines.append(f"    v7_current:")
        for fwk in ('joy_modes', 'tensions', 'functional_jobs', 'occasions'):
            tags = it.get(fwk) or []
            tags_str = '[' + ', '.join(tags) + ']'
            lines.append(f'      {fwk}: {tags_str}')
        lines.append(f"    expected:")
        for fwk in ('joy_modes', 'tensions', 'functional_jobs', 'occasions'):
            tags = it.get(fwk) or []
            tags_str = '[' + ', '.join(tags) + ']'
            lines.append(f"      {fwk}:")
            lines.append(f"        must_include: {tags_str}    # remove tags that don't fit; add tags v7 missed")
            lines.append(f"        may_include: []             # tags that are defensible but not required")
            lines.append(f"        must_not_include: []        # tags v7 should never apply to this verbatim")
        lines.append('')
    lines.append('```')
    return '\n'.join(lines) + '\n'


def main():
    print('Building stratified v7 calibration sample...')
    items = []
    seen = set()

    print('\nOver-firers (12 each):')
    for fwk, tags in OVER_FIRERS.items():
        for tag in tags:
            picked = sample_for_tag(fwk, tag, N_OVERFIRER, seen)
            for row in picked:
                row['stratum'] = f'over_firer:{fwk}:{tag}'
                items.append(row)
                seen.add(row['id'])
            print(f'  {fwk}.{tag:30s}  picked={len(picked)}')

    print('\nFixed wins (8 each):')
    for fwk, tags in FIXED_WINS.items():
        for tag in tags:
            picked = sample_for_tag(fwk, tag, N_FIXED, seen)
            for row in picked:
                row['stratum'] = f'fixed_win:{fwk}:{tag}'
                items.append(row)
                seen.add(row['id'])
            print(f'  {fwk}.{tag:30s}  picked={len(picked)}')

    print('\nUntested (5 each):')
    untested = fetch_untested_tags()
    for fwk, tag in untested:
        picked = sample_for_tag(fwk, tag, N_UNTESTED, seen)
        for row in picked:
            row['stratum'] = f'untested:{fwk}:{tag}'
            items.append(row)
            seen.add(row['id'])
        print(f'  {fwk}.{tag:30s}  picked={len(picked)}')

    print('\nThin / Rule 4 controls (20):')
    thin = sample_thin(N_THIN, seen)
    for row in thin:
        row['stratum'] = 'thin_control'
        items.append(row)
        seen.add(row['id'])
    print(f'  thin_control  picked={len(thin)}')

    text = render_fixture(items)
    OUT.write_text(text)
    print(f'\nWrote {OUT}')
    print(f'Total verbatims: {len(items):,}')


if __name__ == '__main__':
    main()
