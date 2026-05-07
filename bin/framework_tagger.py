#!/usr/bin/env python3
"""
framework_tagger.py — deterministic Haiku tagger for BJL verbatims.

Single canonical module that assigns four-framework tags
(joy_modes, tensions, functional_jobs, occasions) to a verbatim
consumer response. Used in two places:

  - bin/backfill_frameworks.py — one-off backfill of the existing
    ~63K verbatims that lack canonical tags.
  - bin/ingest_wave.py phase 5 — automatic per-wave tagging for new
    monthly waves, called inline at the end of ingestion.

Same module, same prompt, two invocations. Build once, deploy twice.

## Why deterministic and not agentic

The framework taxonomies are stable and the calibration rules in the
prompt are mechanical pattern-matching against textual signals. There
is no autonomous decision-making, no retry-with-different-strategy
logic, no tool use. Just: input verbatim, output tags, store result.

This module is intentionally NOT an agent. It is a typed function with
retry on transient errors and exponential backoff. Trustworthy and
debuggable. The agentic version would be harder to validate and could
drift over time.

## Public API

  load_frameworks_from_db(conn) -> dict
      Reads bjl_joy_modes / bjl_tensions / bjl_functional_jobs /
      bjl_occasions and returns a dict the prompt builder consumes.

  build_system_prompt(frameworks) -> str
      Returns the full system prompt with framework definitions
      injected into placeholder sections.

  tag_verbatim_sync(client, response_text, question_text, system_prompt)
      Sync convenience wrapper used by smoke tests and ad-hoc one-offs.

  async tag_verbatim(client, response_text, question_text, system_prompt)
      One Haiku call. Parses JSON. Retries on 429 / 529 / transient up
      to 3x with exponential backoff. Returns dict or None on
      irrecoverable failure.

  async tag_verbatims_batch(verbatims, frameworks, concurrency=8, ...)
      Asyncio-based parallel batch with a semaphore. Returns
      (results, stats). Cost + time tracked per batch.

## Cost / latency expectations

Haiku 4.5 pricing as of 2026-05: $1/M input tokens, $5/M output tokens.
A typical verbatim tag call is ~3K input tokens (mostly the prompt) +
~80 output tokens. ≈ $0.0034 + $0.0004 = $0.0038 per call. The full
~62K-verbatim backfill should land between $5 and $15 once retries
and prompt-cache hits factor in.

Wall time: at concurrency=8 with ~1-2s per call, expect ~50-100 verbatims
per minute. The full backfill is 45-90 minutes.

## Required env

  ANTHROPIC_API_KEY  — Anthropic API key
  DATABASE_URL       — Postgres connection string for Supabase. Use the
                       Supavisor-pooler URL pattern from the Phase 3+4
                       commit message: postgres://postgres.PROJECT_REF
                       :PASSWORD@aws-0-us-east-1.pooler.supabase.com:
                       6543/postgres
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Iterable

# These imports are deferred-friendly: the test suite imports the module
# without the SDKs installed for offline tests. Heavy deps live below.
try:
    from anthropic import Anthropic, AsyncAnthropic
    from anthropic import APIError, APIStatusError, RateLimitError, APIConnectionError
    HAS_ANTHROPIC = True
except ImportError:  # pragma: no cover — only hit in offline test env
    Anthropic = AsyncAnthropic = None  # type: ignore
    APIError = APIStatusError = RateLimitError = APIConnectionError = Exception  # type: ignore
    HAS_ANTHROPIC = False


HAIKU_MODEL = 'claude-haiku-4-5-20251001'
DEFAULT_MAX_TOKENS = 1024
DEFAULT_CONCURRENCY = 8
RETRY_DELAYS_SEC = (1, 4, 16)  # exponential backoff for 3 retries
INPUT_PRICE_PER_M = 1.0   # USD per million input tokens
OUTPUT_PRICE_PER_M = 5.0  # USD per million output tokens

log = logging.getLogger('framework_tagger')


# ---------------------------------------------------------------------------
# Framework loading (DB → dict)
# ---------------------------------------------------------------------------

# Maps logical framework name → (table, key column, definition column).
# All four tables share `display_name` for the human-readable name and
# differ only in the key column and the definition column. The bjl_joy_modes
# table also has purchase_mapping / benchmark_finding / sort_order — we
# only consume short_definition.
FRAMEWORK_TABLES = {
    'joy_modes':       ('bjl_joy_modes',       'mode_key',     'short_definition'),
    'tensions':        ('bjl_tensions',        'tension_key',  'description'),
    'functional_jobs': ('bjl_functional_jobs', 'job_key',      'description'),
    'occasions':       ('bjl_occasions',       'occasion_key', 'description'),
}


def load_frameworks_from_db(conn) -> dict:
    """Reads the four framework tables and returns a normalized dict.

    Returns:
        {
          'joy_modes': [
            {'key': 'hedonic', 'display_name': 'Hedonic', 'definition': '...'},
            ...
          ],
          'tensions':  [...],
          'functional_jobs': [...],
          'occasions': [...]
        }

    The sort within each list is alphabetical by key for stability —
    the prompt content (and therefore prompt-caching keys) shouldn't
    depend on row insertion order.
    """
    out = {}
    with conn.cursor() as cur:
        for fwk, (table, key_col, def_col) in FRAMEWORK_TABLES.items():
            cur.execute(
                f'SELECT {key_col}, display_name, {def_col} '
                f'FROM {table} ORDER BY {key_col}'
            )
            rows = cur.fetchall()
            out[fwk] = [
                {'key': r[0], 'display_name': r[1], 'definition': r[2] or ''}
                for r in rows
            ]
    return out


def canonical_keys(frameworks: dict) -> dict[str, set[str]]:
    """Returns {framework_name: set_of_valid_keys} for output filtering."""
    return {fwk: {item['key'] for item in entries}
            for fwk, entries in frameworks.items()}


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

# The static parts of the prompt — calibration rules + worked examples — are
# defined as module constants so they're easy to inspect and version-control.
# Framework definitions get spliced in at runtime so the prompt always
# reflects current taxonomy state without a code redeploy.

CALIBRATION_RULES = """\
# CALIBRATION RULES

These rules are absolute. Apply them to every tagging decision.

## Rule 1: Multi-tag is the default
Apply EVERY tag from each framework that has direct textual support in the verbatim. A single verbatim often expresses two, three, or four joy modes simultaneously, plus multiple tensions, jobs, and occasions. Do NOT pick a single dominant signal. Capture all word-grounded signals.

## Rule 2: Word-grounded, not context-inferred
Tags must be supported by the actual words and phrases in the verbatim. The question topic, the response category, and the respondent's demographics CANNOT drive a tag.

WRONG: A respondent talks about the Rock and Roll Hall of Fame, so tag aesthetic because museums are aesthetic categories.

RIGHT: Apply aesthetic only if the respondent uses words about beauty, design, visual appreciation, or art.

## Rule 3: Expressed gaps count as word-grounded signal
"I want X and don't have it" is real textual evidence even when not framed as an explicit polarity. The respondent doesn't have to say "I'm torn between X and Y" to express a tension. Naming the gap between what they want and what exists is enough.

EXAMPLE: "It would be great if my credit union offered higher interest rates" expresses a present_vs_future tension because the respondent is naming the gap between current rates and desired rates, even though they don't say "I'm torn between..."

## Rule 4: Some verbatims have zero tags
Thin, ambiguous, fragmentary, or non-emotional verbatims should NOT be force-tagged. Better to return empty arrays than wrong tags. Logistical statements, pure preference comparisons without emotional content, fragmentary or unclear responses, and pure factual statements often have no clear framework signal. Return [] for any framework that has no word-grounded signal.

## Rule 5: Job vs Tension distinction
- A respondent describing what they want a product or experience to DO for them = functional_job
- A respondent describing the gap between desired state and current reality = tension

The same verbatim CAN have both, tagged via different frameworks. But do NOT confuse them. Unmet wants are tensions, not jobs.

EXAMPLE: "I love sharing wine with friends" -> share_experience (job: respondent is hiring wine to share)
EXAMPLE: "I wish my bank offered higher rates" -> present_vs_future (tension: gap between want and reality), NOT plan_future (job)
"""

WORKED_EXAMPLES = """\
# WORKED EXAMPLES

## Positive examples (well-tagged)

EXAMPLE 1 (multi-mode, all word-grounded):
Verbatim: "Feeling energized, cooking colorful meals, and sharing tasty food with people I love."
Tags: {
  "joy_modes": ["physical", "aesthetic", "hedonic", "relational"],
  "tensions": [],
  "functional_jobs": ["nourish_others"],
  "occasions": []
}
Reasoning: "energized" -> physical; "colorful" -> aesthetic; "tasty" -> hedonic; "people I love" -> relational. All directly in the words.

EXAMPLE 2 (textbook tension with both poles named):
Verbatim: "I would like higher interest rates on my CD. But I do understand it may not be possible."
Tags: {
  "joy_modes": [],
  "tensions": ["aspiration_vs_acceptance"],
  "functional_jobs": [],
  "occasions": []
}
Reasoning: "I would like" (aspiration) AND "I understand it may not be possible" (acceptance) explicit in adjacent sentences. No clear joy mode language. No active job. No occasion.

EXAMPLE 3 (clean explicit signals):
Verbatim: "I enjoyed a very good Reisling with my wife and friends during a small gathering in my home."
Tags: {
  "joy_modes": ["hedonic", "relational"],
  "tensions": [],
  "functional_jobs": ["share_experience"],
  "occasions": ["gathering", "hosting"]
}
Reasoning: "very good Reisling" -> hedonic; "with my wife and friends" -> relational + share_experience; "small gathering" -> gathering; "in my home" -> hosting.

## Anti-pattern examples (what NOT to do)

ANTI-PATTERN 1 (category-driven inference):
Verbatim: "Actually have been there in Cleveland, Ohio. It was interesting but I like the science museum right next door way more interesting."
WRONG: ["aesthetic"] (because the question was about a music museum, and museums are aesthetic-coded)
RIGHT: [] or possibly ["awe"] for the curiosity-of-discovery in "interesting" (twice)
Lesson: The respondent didn't use any aesthetic language. The verbatim is a comparative preference statement with thin emotional content.

ANTI-PATTERN 2 (job applied where tension belongs):
Verbatim: "If it were marketed in a way that easily let you know what to expect for the taste."
WRONG: ["learn_grow", "signal_identity"] as functional jobs
RIGHT: discovery_vs_comfort or served_vs_overlooked as tensions
Lesson: The respondent is expressing an unmet want (clearer marketing). That's tension territory, not job territory.

ANTI-PATTERN 3 (single-tag where multi-tag is needed):
Verbatim: "I'd like to go back to Alaska and do some more things that we didn't get time to do when we were last there."
WRONG: ["sentimental"] alone
RIGHT: ["inspirational", "sentimental"] - inspirational for the forward-action ("would like to go back, do more things"), sentimental for the personal history with the place
Lesson: Forward-action language and backward-personal-history language can coexist. Tag both.
"""

OUTPUT_FORMAT_RULE = """\
# OUTPUT FORMAT

Return ONLY valid JSON in this exact structure, with no preamble, explanation, or markdown:

{
  "joy_modes": ["key1", "key2"],
  "tensions": ["key1"],
  "functional_jobs": [],
  "occasions": ["key1", "key2"]
}

Use the canonical keys from the framework definitions, not display names. Empty arrays are valid and expected for thin verbatims.
"""

OCCASIONS_NOTE = """\
Important note on occasions: journey-phase occasions (anticipation, in_moment, transition, memory) are ADDITIVE. A verbatim about anticipating a vacation should get BOTH `vacation` AND `anticipation`, not one or the other.
"""


def _format_framework_block(name: str, entries: list[dict]) -> str:
    """Renders one framework's keys as a bullet list for the prompt.

    Format: `key — display_name: definition`
    """
    title_map = {
        'joy_modes': 'JOY MODES',
        'tensions': 'TENSIONS',
        'functional_jobs': 'FUNCTIONAL JOBS',
        'occasions': 'OCCASIONS',
    }
    title = title_map.get(name, name.upper())
    lines = [f'# FRAMEWORK: {title}', '']
    for e in entries:
        defn = (e.get('definition') or '').strip().replace('\n', ' ')
        lines.append(f"- `{e['key']}` ({e['display_name']}): {defn}")
    if name == 'occasions':
        lines.append('')
        lines.append(OCCASIONS_NOTE.strip())
    return '\n'.join(lines)


def build_system_prompt(frameworks: dict) -> str:
    """Builds the full system prompt with framework definitions injected.

    Returns a string ~6-8K chars. Token-stable for prompt caching when
    framework definitions don't change.
    """
    parts = [
        'You are a framework tagger for the Brand Joy Lab consumer research database. '
        'Your job is to assign tags from four canonical frameworks to a verbatim consumer response.',
        '',
        CALIBRATION_RULES,
        '',
        _format_framework_block('joy_modes', frameworks['joy_modes']),
        '',
        _format_framework_block('tensions', frameworks['tensions']),
        '',
        _format_framework_block('functional_jobs', frameworks['functional_jobs']),
        '',
        _format_framework_block('occasions', frameworks['occasions']),
        '',
        OUTPUT_FORMAT_RULE,
        '',
        WORKED_EXAMPLES,
    ]
    return '\n'.join(parts)


def build_user_message(response_text: str, question_text: str | None) -> str:
    """The per-call user-message turn. Question context is given but
    never authoritative — Rule 2 says category context can't drive tags."""
    q = (question_text or '').strip() or '(no question text on file)'
    r = (response_text or '').strip()
    return f'Question: {q}\n\nVerbatim: {r}\n\nApply the calibration rules. Return JSON only.'


# ---------------------------------------------------------------------------
# JSON response parsing
# ---------------------------------------------------------------------------

# Regex for stripping ```json ... ``` fences. Handles ```json, ```JSON, ```
# (no language tag), with or without trailing newlines.
_FENCE_OPEN = re.compile(r'^```(?:json)?\s*\n', re.IGNORECASE)
_FENCE_CLOSE = re.compile(r'\n```\s*$')

# Comma-before-closing-bracket cleanup for the most common malformations.
_TRAILING_COMMA = re.compile(r',\s*([\]}])')


def _strip_fences(raw: str) -> str:
    s = raw.strip()
    s = _FENCE_OPEN.sub('', s)
    s = _FENCE_CLOSE.sub('', s)
    return s.strip()


def parse_response(raw: str) -> dict | None:
    """Parses Haiku's response into a tag dict, or None if unparseable.

    Tolerant to common malformations:
      - ```json ... ``` fence wrapping
      - trailing whitespace
      - single trailing commas (best-effort)
    """
    if not raw or not raw.strip():
        return None
    s = _strip_fences(raw)
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        s2 = _TRAILING_COMMA.sub(r'\1', s)
        try:
            return json.loads(s2)
        except json.JSONDecodeError:
            log.warning('parse_response: JSON decode failed after cleanup; raw=%r', raw[:300])
            return None


def filter_to_canonical(parsed: dict, canonical: dict[str, set[str]]) -> dict:
    """Returns a normalized dict with hallucinated keys dropped.

    Always includes all four framework keys, even if the model omitted them
    or returned non-array values. Defaults to []. Keys outside the canonical
    set are dropped with a debug log.
    """
    out = {}
    for fwk in ('joy_modes', 'tensions', 'functional_jobs', 'occasions'):
        raw = parsed.get(fwk) if isinstance(parsed, dict) else None
        if not isinstance(raw, list):
            out[fwk] = []
            continue
        valid = canonical.get(fwk, set())
        kept = []
        for v in raw:
            if not isinstance(v, str):
                continue
            v = v.strip()
            if v in valid:
                kept.append(v)
            else:
                log.debug('filter_to_canonical: dropped hallucinated %s key %r', fwk, v)
        # Dedupe preserving order
        seen = set()
        deduped = []
        for v in kept:
            if v not in seen:
                seen.add(v)
                deduped.append(v)
        out[fwk] = deduped
    return out


# ---------------------------------------------------------------------------
# Cost / token tracking
# ---------------------------------------------------------------------------

@dataclass
class BatchStats:
    n_total: int = 0
    n_success: int = 0
    n_failed: int = 0
    wall_seconds: float = 0.0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    failures: list[tuple[int | str, str]] = field(default_factory=list)

    @property
    def est_cost_usd(self) -> float:
        return (
            self.total_input_tokens * INPUT_PRICE_PER_M / 1_000_000
            + self.total_output_tokens * OUTPUT_PRICE_PER_M / 1_000_000
        )

    def as_dict(self) -> dict:
        return {
            'n_total': self.n_total,
            'n_success': self.n_success,
            'n_failed': self.n_failed,
            'wall_seconds': round(self.wall_seconds, 2),
            'total_input_tokens': self.total_input_tokens,
            'total_output_tokens': self.total_output_tokens,
            'est_cost_usd': round(self.est_cost_usd, 4),
            'failures': self.failures[:10],  # cap for logging
        }


# ---------------------------------------------------------------------------
# Async tagging — single + batch
# ---------------------------------------------------------------------------

async def tag_verbatim(
    client,
    response_text: str,
    question_text: str | None,
    system_prompt: str,
    canonical: dict[str, set[str]],
    *,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> tuple[dict | None, dict]:
    """One Haiku call. Returns (tags_dict_or_None, usage_dict).

    Retries on:
      - RateLimitError (429)
      - APIStatusError with status_code == 529 (overloaded)
      - APIConnectionError (network blip)

    Up to 3 retries with exponential backoff (1s, 4s, 16s). Other errors
    propagate. Irrecoverable parse failures return (None, usage).
    """
    user_msg = build_user_message(response_text, question_text)
    last_exc = None

    for attempt, delay in enumerate([0] + list(RETRY_DELAYS_SEC)):
        if delay:
            await asyncio.sleep(delay)
        try:
            resp = await client.messages.create(
                model=HAIKU_MODEL,
                max_tokens=max_tokens,
                system=system_prompt,
                messages=[{'role': 'user', 'content': user_msg}],
            )
            usage = {
                'input_tokens': getattr(resp.usage, 'input_tokens', 0) or 0,
                'output_tokens': getattr(resp.usage, 'output_tokens', 0) or 0,
            }
            text_parts = [b.text for b in resp.content if getattr(b, 'type', None) == 'text']
            raw = '\n'.join(text_parts).strip()
            parsed = parse_response(raw)
            if parsed is None:
                # Unparseable — don't retry, return failure with usage so we
                # still account for the cost.
                return None, usage
            return filter_to_canonical(parsed, canonical), usage
        except RateLimitError as e:
            last_exc = e
            log.info('tag_verbatim: rate limit, retry %s/%s', attempt + 1, len(RETRY_DELAYS_SEC))
            continue
        except APIStatusError as e:
            sc = getattr(e, 'status_code', None)
            if sc == 529:
                last_exc = e
                log.info('tag_verbatim: overloaded (529), retry %s/%s', attempt + 1, len(RETRY_DELAYS_SEC))
                continue
            raise
        except APIConnectionError as e:
            last_exc = e
            log.info('tag_verbatim: connection error, retry %s/%s', attempt + 1, len(RETRY_DELAYS_SEC))
            continue

    log.warning('tag_verbatim: gave up after retries: %s', last_exc)
    return None, {'input_tokens': 0, 'output_tokens': 0}


async def tag_verbatims_batch(
    verbatims: Iterable[dict],
    frameworks: dict,
    *,
    concurrency: int = DEFAULT_CONCURRENCY,
    api_key: str | None = None,
    progress_cb=None,
) -> tuple[list[dict], BatchStats]:
    """Batch-tag verbatims with a configurable concurrency cap.

    verbatims: iterable of {'id', 'response_text', 'question_text'}
    Returns (results, stats) where results is a list of:
        {'id': ..., 'joy_modes': [...], 'tensions': [...],
         'functional_jobs': [...], 'occasions': [...], 'ok': True|False}
    Order of results matches the input order.

    progress_cb: optional callback invoked as progress_cb(done, total) on
    every completion. Useful for CLI progress lines.
    """
    if not HAS_ANTHROPIC:
        raise RuntimeError(
            'anthropic SDK not installed. Run: pip install -r requirements-tagger.txt'
        )

    verbatims_list = list(verbatims)
    canonical = canonical_keys(frameworks)
    system_prompt = build_system_prompt(frameworks)

    client = AsyncAnthropic(api_key=api_key or os.environ.get('ANTHROPIC_API_KEY'))
    sem = asyncio.Semaphore(concurrency)
    stats = BatchStats(n_total=len(verbatims_list))
    results: list[dict] = [None] * len(verbatims_list)  # type: ignore
    done_count = [0]

    async def one(i: int, v: dict):
        async with sem:
            tags, usage = await tag_verbatim(
                client,
                v.get('response_text', ''),
                v.get('question_text'),
                system_prompt,
                canonical,
            )
        stats.total_input_tokens += usage.get('input_tokens', 0)
        stats.total_output_tokens += usage.get('output_tokens', 0)
        if tags is None:
            stats.n_failed += 1
            stats.failures.append((v.get('id', i), 'parse_or_retry_failure'))
            results[i] = {
                'id': v.get('id'),
                'joy_modes': [], 'tensions': [],
                'functional_jobs': [], 'occasions': [],
                'ok': False,
            }
        else:
            stats.n_success += 1
            results[i] = {
                'id': v.get('id'),
                'joy_modes': tags['joy_modes'],
                'tensions': tags['tensions'],
                'functional_jobs': tags['functional_jobs'],
                'occasions': tags['occasions'],
                'ok': True,
            }
        done_count[0] += 1
        if progress_cb:
            try:
                progress_cb(done_count[0], stats.n_total)
            except Exception:
                pass

    t0 = time.time()
    await asyncio.gather(*(one(i, v) for i, v in enumerate(verbatims_list)))
    stats.wall_seconds = time.time() - t0
    return results, stats


# ---------------------------------------------------------------------------
# Sync convenience (single verbatim) — used by smoke tests + ad-hoc one-offs
# ---------------------------------------------------------------------------

def tag_verbatim_sync(
    response_text: str,
    question_text: str | None,
    system_prompt: str,
    canonical: dict[str, set[str]],
    *,
    api_key: str | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> dict | None:
    """Sync one-off helper. Internally runs the async path with concurrency=1.

    Returns the tags dict or None on irrecoverable failure.
    """
    if not HAS_ANTHROPIC:
        raise RuntimeError(
            'anthropic SDK not installed. Run: pip install -r requirements-tagger.txt'
        )

    async def _run():
        client = AsyncAnthropic(api_key=api_key or os.environ.get('ANTHROPIC_API_KEY'))
        tags, _usage = await tag_verbatim(
            client, response_text, question_text, system_prompt,
            canonical, max_tokens=max_tokens,
        )
        return tags

    return asyncio.run(_run())


# ---------------------------------------------------------------------------
# Module CLI: 'python -m bin.framework_tagger' tags one verbatim from stdin
# ---------------------------------------------------------------------------

def _cli():  # pragma: no cover — convenience tool only
    """Tags a single verbatim from STDIN. Useful for ad-hoc inspection.

    Usage: echo "the verbatim text" | python bin/framework_tagger.py
    """
    import psycopg2  # local import: only the CLI needs DB access
    import sys
    text = sys.stdin.read().strip()
    if not text:
        sys.exit('no verbatim on stdin')
    db_url = os.environ['DATABASE_URL']
    with psycopg2.connect(db_url) as conn:
        frameworks = load_frameworks_from_db(conn)
    canonical = canonical_keys(frameworks)
    prompt = build_system_prompt(frameworks)
    tags = tag_verbatim_sync(text, None, prompt, canonical)
    print(json.dumps(tags, indent=2))


if __name__ == '__main__':  # pragma: no cover
    _cli()
