#!/usr/bin/env python3
"""
Haiku-driven concept-tagging pass for bjl_questions_v2.

Reads every question with its full context (question_text, primary_topic,
subtags, intent_tag, short_label, n_items, scale_type) and asks Haiku 4.5
which concept tags from the taxonomy apply. Most questions will return an
empty array — only questions that genuinely touch a strategic concept
should be tagged.

Writes to bjl_questions_v2.concept_tags via PostgREST.

Run from repo root:
  ANTHROPIC_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
    python3 -u bin/tag_questions_concepts.py
"""

import asyncio
import json
import os
import re
import sys
import time

import requests
from anthropic import AsyncAnthropic

SUPABASE_URL = os.environ['SUPABASE_URL']
SUPABASE_SERVICE_KEY = os.environ['SUPABASE_SERVICE_KEY']
ANTHROPIC_API_KEY = os.environ['ANTHROPIC_API_KEY']
HEADERS = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': f'Bearer {SUPABASE_SERVICE_KEY}',
    'Content-Type': 'application/json',
}

MODEL = 'claude-haiku-4-5-20251001'
CONCURRENCY = 8

TAXONOMY = {
    'furniture_journey':    "Items mapping moments in the furniture buying, choosing, owning, or living-with arc.",
    'home_identity':        "Items about what home means: pride, family, identity, who-am-I expression through the home.",
    'financing_journey':    "Items about financing as an emotional or experiential layer (paying over time, monthly payment feel, the financial decision part).",
    'prequalification':     "Items specific to prequalification offers and their effects on shopper behavior or confidence.",
    'retail_in_store':      "Items about the physical retail experience — visiting stores, salespeople, in-person browsing.",
    'retail_online':        "Items about the online or app-based retail experience — browsing, comparing, buying digitally.",
    'significant_purchase': "Items about the major / significant / once-in-a-while purchase moment specifically (vs everyday purchase).",
    'new_purchase_meaning': "Items about what a new purchase means emotionally — pride, accomplishment, what-it-says-about-me.",
    'home_transformation':  "Items about the post-purchase realization phase — when the item is in the home and the space transforms.",
}

SYSTEM_PROMPT = f"""You are tagging survey questions from the Brand Joy Lab corpus with strategic concept tags. The taxonomy below identifies questions that touch specific furniture-and-home strategic territories. Most questions in the BJL corpus do NOT touch any of these concepts — they cover other categories (banking, vacations, sports, food, etc). Only apply tags that genuinely fit; default to an empty array.

TAXONOMY:

{chr(10).join(f"- `{k}`: {v}" for k, v in TAXONOMY.items())}

# Tagging rules

1. Apply only tags from the taxonomy. No invented tags.
2. Apply EVERY tag that genuinely fits — questions can carry multiple tags.
3. A question about furniture purchase at a store could carry: furniture_journey + significant_purchase + retail_in_store.
4. Default to empty array. If the question is clearly about a non-furniture-non-home category (banking, sports, food, vacations, etc), return [].
5. The question's `primary_topic` and `subtags` give you strong signal. If primary_topic is 'home_life' or includes 'home_goods_furniture' in subtags, furniture/home concepts likely apply. If primary_topic is 'financial_services' AND the question is about furniture financing, financing_journey applies. If primary_topic is 'financial_services' but the question is about banking generally, no furniture-domain tags apply.
6. Use the question_text + short_label to disambiguate.

Output JSON only, no preamble:
{{"concept_tags": ["tag1", "tag2"]}}

If no tags fit, output:
{{"concept_tags": []}}"""


def fetch_questions():
    url = f'{SUPABASE_URL}/rest/v1/bjl_questions_v2'
    out = []
    last_id = 0
    while True:
        params = {
            'select': 'question_id,question_text,question_type,scale_type,primary_topic,subtags,intent_tag,short_label,n_items',
            'order': 'question_id.asc',
            'limit': '1000',
            'question_id': f'gt.{last_id}',
        }
        r = requests.get(url, headers=HEADERS, params=params, timeout=60)
        r.raise_for_status()
        rows = r.json()
        if not rows:
            break
        out.extend(rows)
        last_id = rows[-1]['question_id']
        if len(rows) < 1000:
            break
    return out


def patch_question(qid, tags):
    url = f'{SUPABASE_URL}/rest/v1/bjl_questions_v2?question_id=eq.{qid}'
    r = requests.patch(url, headers={**HEADERS, 'Prefer': 'return=minimal'},
                       json={'concept_tags': tags}, timeout=30)
    if r.status_code not in (200, 204):
        raise RuntimeError(f'PATCH failed: {r.status_code} {r.text[:200]}')


def parse_tags(text):
    text = text.strip()
    if text.startswith('```'):
        text = re.sub(r'^```(?:json)?\s*', '', text)
        text = re.sub(r'\s*```$', '', text)
    try:
        obj = json.loads(text)
        tags = obj.get('concept_tags', [])
        if isinstance(tags, list):
            return [t for t in tags if t in TAXONOMY]
    except json.JSONDecodeError:
        pass
    return None


async def tag_one(client, q, sem):
    async with sem:
        user_content = (
            f"question_id: {q['question_id']}\n"
            f"question_text: {q['question_text']}\n"
            f"primary_topic: {q.get('primary_topic') or '(none)'}\n"
            f"subtags: {q.get('subtags') or []}\n"
            f"intent_tag: {q.get('intent_tag') or '(none)'}\n"
            f"short_label: {q.get('short_label') or '(none)'}\n"
            f"scale_type: {q.get('scale_type') or '(none)'}\n"
            f"n_items: {q.get('n_items') or 0}"
        )
        for attempt in range(4):
            try:
                rsp = await client.messages.create(
                    model=MODEL,
                    max_tokens=200,
                    system=[{
                        'type': 'text',
                        'text': SYSTEM_PROMPT,
                        'cache_control': {'type': 'ephemeral'},
                    }],
                    messages=[{'role': 'user', 'content': user_content}],
                )
                text = ''.join(b.text for b in rsp.content if b.type == 'text')
                tags = parse_tags(text)
                return {'question_id': q['question_id'], 'tags': tags or [], 'raw': text,
                        'usage': {'in': rsp.usage.input_tokens, 'out': rsp.usage.output_tokens,
                                  'cw': getattr(rsp.usage, 'cache_creation_input_tokens', 0),
                                  'cr': getattr(rsp.usage, 'cache_read_input_tokens', 0)}}
            except Exception as e:
                if attempt < 3:
                    await asyncio.sleep(2 ** (attempt + 1))
                    continue
                return {'question_id': q['question_id'], 'tags': None, 'error': str(e)[:200]}


async def main():
    print('Fetching questions...')
    questions = fetch_questions()
    print(f'Total questions: {len(questions)}')

    client = AsyncAnthropic(api_key=ANTHROPIC_API_KEY)
    sem = asyncio.Semaphore(CONCURRENCY)
    tasks = [tag_one(client, q, sem) for q in questions]

    cumulative = {'in': 0, 'out': 0, 'cw': 0, 'cr': 0}
    tag_counts = {k: 0 for k in TAXONOMY}
    tagged = 0
    errors = 0
    t0 = time.time()

    for i, coro in enumerate(asyncio.as_completed(tasks), 1):
        r = await coro
        u = r.get('usage') or {}
        for k in cumulative:
            cumulative[k] += u.get(k, 0)
        if r.get('tags') is None:
            errors += 1
            print(f"  err id={r['question_id']}: {r.get('error','')[:100]}")
            continue
        if r['tags']:
            tagged += 1
            for t in r['tags']:
                tag_counts[t] = tag_counts.get(t, 0) + 1
            try:
                patch_question(r['question_id'], r['tags'])
            except Exception as e:
                print(f"  patch err id={r['question_id']}: {e}")
                errors += 1
        if i % 50 == 0 or i == len(questions):
            cost = (cumulative['in']/1e6*1.0 + cumulative['out']/1e6*5.0
                    + cumulative['cw']/1e6*1.25 + cumulative['cr']/1e6*0.10)
            elapsed = time.time() - t0
            print(f"  {i:>4}/{len(questions)} tagged={tagged} err={errors} "
                  f"cost=${cost:.2f} rate={i/elapsed:.1f}/s")

    print()
    print(f'Done. Tagged {tagged} of {len(questions)} questions. Errors: {errors}')
    print('Tag distribution:')
    for k, n in sorted(tag_counts.items(), key=lambda x: -x[1]):
        if n > 0:
            print(f'  {k:30s} {n}')

if __name__ == '__main__':
    asyncio.run(main())
