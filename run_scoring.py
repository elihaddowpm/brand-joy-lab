#!/usr/bin/env python3
"""
BJL scoring pipeline (v8.0).

Reads raw responses from `bjl_responses`, classifies each item's
question_type by inspecting actual response labels (the `detect_scale`
function), computes the right metrics per type, and upserts into
`bjl_scores` keyed on the natural key (item_name, question, question_type).

By default, the pipeline targets the question_ids listed in
`bjl_backfill_scope` where `loaded = false`. Override with --question-ids
to score arbitrary questions (for verification or incremental adds).

## Per-type metric rules (v8.0 — strict joy_index rule)

| question_type      | joy_index (mean × 20)        | top_response / top_pct       | pct (selected/base) | pct_max | pct_negative |
|--------------------|------------------------------|------------------------------|---------------------|---------|--------------|
| joy_scale          | YES                          | NO                           | NO                  | YES     | YES          |
| ordinal_scale      | NO   ← strict rule, v8.0     | YES                          | NO                  | NO      | NO           |
| likelihood_scale   | NO                           | YES                          | NO                  | YES     | NO           |
| familiarity_trust  | NO                           | YES                          | NO                  | NO      | NO           |
| select_all         | NO                           | NO                           | YES                 | NO      | NO           |

The strict rule (only `joy_scale` carries `joy_index`) is a deliberate
divergence from the original loader, which surfaced `joy_index = mean × 20`
on all scaled types. Joy Index is specifically the -3 to +5 emotional-joy
measurement. Other scaled types (ordinal, likelihood, familiarity) carry
their own mean and top_response/top_pct but do not get a Joy Index.

## Sample-size thresholds

- joy_scale: n ≥ 30
- ordinal/likelihood/familiarity: n ≥ 50, base_n ≥ 100
- select_all: n ≥ 30 (selections), base_n ≥ 100

## Brand and demographic gating

- Items whose `item_name` matches an entry in `bjl_gated_entities` are
  silently skipped (per-item, not per-question).
- Demographic battery questions (race, ethnicity, language) are skipped
  at the question level when the response labels are exclusively
  demographic terms.

## Usage

    export SUPABASE_DB_URL="postgresql://postgres:[password]@db.iqjkgswpzbklihdfccnd.supabase.co:5432/postgres"
    pip install psycopg2-binary
    python3 run_scoring.py                     # all pending backfill scope rows
    python3 run_scoring.py --dry-run           # show what would be written, don't insert
    python3 run_scoring.py --verify-existing   # score 5 existing questions, diff vs live
    python3 run_scoring.py --question-ids 224,234,235   # score specific questions
    python3 run_scoring.py --max-questions 5   # cap for testing

## Output

For each item that clears the thresholds and isn't brand-gated, the script:
1. Upserts a row in `bjl_scores` (ON CONFLICT (item_name, question,
   question_type) DO UPDATE SET ...). search_vector is populated by the
   `bjl_scores_search_tsv` trigger. joy_modes/occasions/functional_jobs/
   tensions are left NULL — enrichment via `run_enrichment.py` follows.
2. After every item in a question is processed, flips
   `bjl_backfill_scope.loaded = true` on that row.

After this script completes, run:
    python3 run_enrichment.py    # populate joy_modes / occasions / etc
    python3 run_embeddings.py    # populate vector(1536) embeddings

Re-running the script is idempotent: existing rows update in place, no
duplicates are created.

See SCORING_README.md for a full description of detect_scale's vocab
mappings and the rationale behind the classifier rules.
"""

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from typing import Iterable, Optional

import psycopg2
from psycopg2.extras import RealDictCursor, execute_values


# ---------------------------------------------------------------------------
# Label vocab — used by detect_scale to classify the question_type by
# inspecting the actual response labels. Each vocab is the canonical label
# set for one scale family. New label families can be added without
# changing call sites.
# ---------------------------------------------------------------------------

# Joy scale, -3 to +5. raw_value may include anchored text like "5 (Maximum Joy!)"
JOY_MIN3_TO_5_NUMS = {'-3', '-2', '-1', '0', '1', '2', '3', '4', '5'}
JOY_MIN3_TO_5_ANCHORS = {
    '-3 (Definitely NOT Joy)', '-3 (definitely not joy)',
    '5 (Maximum Joy!)', '5 (maximum joy!)',
}

# 0-to-5 anchored scales — joy, description, importance, familiarity. The
# anchor text on '0' and '5' tells us which family.
ZERO_TO_FIVE_NUMS = {'0', '1', '2', '3', '4', '5'}
ZERO_TO_FIVE_JOY_ANCHORS    = {'no joy', 'maximum joy'}
ZERO_TO_FIVE_DESC_ANCHORS   = {'not at all', 'describes', 'describes perfectly'}
ZERO_TO_FIVE_IMP_ANCHORS    = {'not at all important', 'essential', 'important', 'extremely important'}
ZERO_TO_FIVE_FAM_ANCHORS    = {'not familiar', 'very familiar', 'extremely familiar'}

# 3-pt ordinal: "Very much so / Somewhat / Not at all" — joy variant or generic.
# Real-world data uses several phrasings of the negative pole — "Not really"
# appears in some batteries alongside the standard "Not at all" in others.
ORDINAL_3PT = {
    'very much so', 'somewhat', 'not at all', 'not really',
    # Capitalization variants normalized by _normalize_label() to lower already
}

# Joy-keyword detector — when 3-pt ordinal labels appear AND the question
# text contains a joy-family keyword, classify as joy_scale rather than
# generic ordinal_scale. This is how the original loader picked joy_scale
# for questions declared `single_select` whose data was actually 3-pt joy.
JOY_KEYWORDS = ('joy', 'joyful', 'joyfulness', 'happiness', 'happy', 'enjoy')

# 5-pt likelihood
LIKELIHOOD_5PT = {
    'very likely', 'likely', 'neutral', 'neither likely nor unlikely',
    'unlikely', 'very unlikely', 'not at all likely',
}

# 5-pt familiarity
FAMILIARITY_5PT = {
    'very familiar', 'somewhat familiar', 'familiar', 'neutral',
    'not very familiar', 'not familiar at all', 'not familiar',
}

# 5-pt agreement
AGREEMENT_5PT = {
    'strongly agree', 'agree', 'neither agree nor disagree', 'neutral',
    'disagree', 'strongly disagree',
}

# Frequency labels (5-pt-ish). Real BJL data uses several phrasings — the
# "at least once a X, on average" forms appear in the racing/casino/
# entertainment batteries; the temporal recency forms appear in
# "When was the last time..." questions.
FREQUENCY_LABELS = {
    # Bare frequency
    'daily', 'weekly', 'monthly', 'yearly',
    'rarely', 'seldom', 'never', 'occasionally', 'often', 'always',
    'sometimes', 'very often',
    # Multi-word frequency
    'a few times a week', 'a few times a month', 'a few times a year',
    'at least once a week', 'at least once a week, on average',
    'at least once a month', 'at least once a month, on average',
    'at least once a year', 'at least once a year, on average',
    'at least twice a month', 'once a month', 'twice a month',
    # Temporal recency ("When was the last time..." patterns)
    'today', 'this week', 'this month', 'this year', 'last year',
    'within the last few months', 'within the last 5 years',
    'more than a year ago', 'more than 5 years ago',
}

# 4-point intensity scale: "How much does X influence you" → A lot / Somewhat
# / Just a little / Not at all. Maps to 0-3 (or 0-5 to keep parity with
# joy if needed; I'll use 0-3 to reflect the actual 4-pt nature).
INTENSITY_4PT = {'a lot!', 'a lot', 'somewhat', 'just a little', 'not at all'}

def make_4pt_intensity_map():
    return {'not at all': 0.0, 'just a little': 1.0, 'somewhat': 2.0, 'a lot': 3.0, 'a lot!': 3.0}


# Comparison-to-prior scales — "more so / less so than a year ago" patterns.
# Common in trend questions (spending vs last year, news consumption vs last
# year, etc.). 5-pt and 3-pt variants both appear in BJL data.
MORE_LESS_5PT = {
    'much more so than a year ago', 'somewhat more so than a year ago',
    'about the same as a year ago',
    'somewhat less so than a year ago', 'much less so than a year ago',
}
MORE_LESS_3PT = {
    'more so than the last year or two', 'about the same as the last year or two',
    'less so than the last year or two',
    'more likely than usual to have an alcoholic beverage to unwind',
    'about the same as usual',
    'less likely than usual to have an alcoholic beverage to unwind',
}

def make_more_less_5pt_map():
    return {
        'much less so than a year ago': 0.0,
        'somewhat less so than a year ago': 1.0,
        'about the same as a year ago': 2.0,
        'somewhat more so than a year ago': 3.0,
        'much more so than a year ago': 4.0,
    }

def make_more_less_3pt_map():
    return {
        'less so than the last year or two': 0.0,
        'less likely than usual to have an alcoholic beverage to unwind': 0.0,
        'about the same as the last year or two': 1.0,
        'about the same as usual': 1.0,
        'more so than the last year or two': 2.0,
        'more likely than usual to have an alcoholic beverage to unwind': 2.0,
    }


# Count-4pt — "Not at all / Once / Twice / 3 or more times". Used in trip-
# count questions (in the past year, how many business/personal trips).
COUNT_4PT = {'not at all', 'once', 'twice', '3 or more times'}

def make_count_4pt_map():
    return {'not at all': 0.0, 'once': 1.0, 'twice': 2.0, '3 or more times': 3.0}

# Skip values that don't carry analytic meaning. Real-world response sets
# include several variants — empty string, the canonical N/A, and the
# longer "Don't know" / "Unfamiliar" markers that respondents use when
# they didn't know the brand or topic enough to rate it.
SKIP_VALUES = {
    'not applicable', 'n/a', 'na', "n/a, don't know", "don't know",
    'unfamiliar', 'no opinion', 'prefer not to answer', '', None,
}

# Demographic battery markers — if a question's response set is dominated
# by these, the whole question is skipped
DEMOGRAPHIC_MARKERS = {
    'white', 'black', 'hispanic', 'latino', 'asian', 'native american',
    'pacific islander', 'middle eastern', 'multiracial', 'biracial',
    'english', 'spanish', 'french', 'chinese',
    'male', 'female', 'non-binary', 'transgender',
    'prefer not to say',
}


# ---------------------------------------------------------------------------
# Numeric mappings per scale. For each detected (question_type, scale_type),
# scale_map[label_lower_stripped] -> numeric value used in mean computation.
# ---------------------------------------------------------------------------

def make_3pt_joy_map():
    return {'not at all': 0.0, 'somewhat': 2.5, 'very much so': 5.0}

def make_5pt_likelihood_map():
    # 0-4 mapping so mean × 20 = 0-80 (no joy_index emitted under strict rule)
    return {
        'very unlikely': 0.0, 'not at all likely': 0.0,
        'unlikely': 1.0,
        'neither likely nor unlikely': 2.0, 'neutral': 2.0,
        'likely': 3.0,
        'very likely': 4.0,
    }

def make_5pt_familiarity_map():
    return {
        'not familiar at all': 0.0, 'not familiar': 0.0,
        'not very familiar': 1.0,
        'neutral': 2.0,
        'somewhat familiar': 2.5, 'familiar': 3.0,
        'very familiar': 4.0,
    }

def make_5pt_agreement_map():
    return {
        'strongly disagree': 0.0,
        'disagree': 1.0,
        'neither agree nor disagree': 2.0, 'neutral': 2.0,
        'agree': 3.0,
        'strongly agree': 4.0,
    }

def make_frequency_map():
    # 0-4 mapping for never -> daily
    return {
        'never': 0.0,
        'seldom': 1.0, 'rarely': 1.0, 'a few times a year': 1.0, 'yearly': 1.0,
        'a few times a month': 2.0, 'monthly': 2.0, 'occasionally': 2.0,
        'a few times a week': 3.0, 'weekly': 3.0, 'often': 3.0,
        'daily': 4.0, 'always': 4.0,
    }


# ---------------------------------------------------------------------------
# Classifier
# ---------------------------------------------------------------------------

def _normalize_label(s: Optional[str]) -> str:
    if s is None:
        return ''
    return s.strip().lower()


def _looks_joy_question(question_text: Optional[str]) -> bool:
    if not question_text:
        return False
    qt = question_text.lower()
    return any(kw in qt for kw in JOY_KEYWORDS)


def detect_scale(distinct_raws: set, has_numeric: bool, has_is_selected: bool,
                 declared_type: Optional[str], declared_scale: Optional[str],
                 question_text: Optional[str] = None) -> tuple:
    """
    Returns (question_type, scale_type, label_to_numeric_map_or_None).

    question_type is one of the bjl_scores types or 'SKIP'.
    scale_type may be None for select_all.
    label_to_numeric_map is None when responses already carry numeric_value
    (so we use that directly); otherwise it's the dict mapping label -> number.

    Decision order:
      1. Joy -3 to 5 — numeric labels with negative anchors
      2. 0 to 5 anchored — distinguish family by anchor text
      3. 3-pt ordinal (very much so / somewhat / not at all)
      4. 5-pt vocabularies (likelihood / familiarity / agreement / frequency)
      5. select_all — has_is_selected with non-ordinal labels
      6. Open-ended text — many distinct values, no structure → SKIP
      7. Demographic battery → SKIP
    """
    norm = {_normalize_label(v) for v in distinct_raws if v is not None}
    norm.discard('')

    real_labels = norm - SKIP_VALUES
    if not real_labels:
        return ('SKIP', 'empty_responses', None)

    # 1. Joy -3 to +5
    if has_numeric:
        # Strip anchored text like "5 (Maximum Joy!)" → "5"
        flat = {v.split(' ')[0] if v else v for v in real_labels}
        # Allow up to 15% of labels to be unrecognized (stray "Unfamiliar"
        # or other outliers) — the majority-match makes the classifier
        # robust to mixed-vocabulary batteries.
        in_joy = sum(1 for v in flat if v in JOY_MIN3_TO_5_NUMS)
        joy_share = in_joy / len(flat) if flat else 0
        has_negative = any(v in {'-3', '-2', '-1'} for v in flat)
        if joy_share >= 0.85 and has_negative:
            return ('joy_scale', 'ordinal_-3_to_5', None)
        # 0 to 5 anchored — distinguish family
        if flat.issubset(ZERO_TO_FIVE_NUMS | {'0', '1', '2', '3', '4', '5'}) or \
           all(v[0:1] in '012345' or v.startswith('0 =') or v.startswith('5 =') or v == '' for v in real_labels):
            joined = ' '.join(real_labels)
            if 'joy' in joined:
                return ('joy_scale', 'ordinal_0_to_5', None)
            if 'describe' in joined:
                return ('ordinal_scale', 'description_0_to_5', None)
            if 'important' in joined or 'essential' in joined:
                return ('ordinal_scale', 'importance_0_to_5', None)
            if 'familiar' in joined:
                return ('familiarity_trust', 'familiarity_0_to_5', None)
            # Bare 0-5 numeric without anchors — declared type wins
            if declared_type and 'joy' in declared_type:
                return ('joy_scale', 'ordinal_0_to_5', None)
            return ('ordinal_scale', 'numeric_0_to_5', None)

    # 3. Joy 3pt or generic 3pt ordinal — "very much so / somewhat / not at all"
    # Use question_text inspection to distinguish joy from generic ordinal:
    # if the question mentions joy/joyful/happiness, the 3-pt is a joy variant.
    # Falls back to declared_type as the secondary signal.
    if real_labels.issubset(ORDINAL_3PT):
        is_joy_question = (
            _looks_joy_question(question_text)
            or (declared_type and declared_type.startswith('joy_scale'))
        )
        if is_joy_question:
            return ('joy_scale', 'ordinal_3pt_joy', make_3pt_joy_map())
        return ('ordinal_scale', 'very_much_not_at_all', make_3pt_joy_map())

    # 4a. 5-pt likelihood
    if real_labels.issubset(LIKELIHOOD_5PT):
        return ('likelihood_scale', 'likely_unlikely_5pt', make_5pt_likelihood_map())

    # 4b. 5-pt familiarity
    if real_labels.issubset(FAMILIARITY_5PT):
        return ('familiarity_trust', 'familiar_unfamiliar_5pt', make_5pt_familiarity_map())

    # 4c. 5-pt agreement
    if real_labels.issubset(AGREEMENT_5PT):
        return ('ordinal_scale', 'agree_disagree_5pt', make_5pt_agreement_map())

    # 4d. Frequency — allow majority match for robustness
    freq_match = sum(1 for v in real_labels if v in FREQUENCY_LABELS)
    if real_labels and freq_match / len(real_labels) >= 0.8 and freq_match >= 3:
        # Build a richer frequency map covering all observed labels
        full_freq_map = make_frequency_map()
        full_freq_map.update({
            'at least once a week': 3.0, 'at least once a week, on average': 3.0,
            'at least once a month': 2.0, 'at least once a month, on average': 2.0,
            'at least once a year': 1.0, 'at least once a year, on average': 1.0,
            'at least twice a month': 2.5,
            'twice a month': 2.5,
            'very often': 4.0,
            # Temporal recency: more recent = higher value (more frequent activity)
            'today': 4.0, 'this week': 3.5, 'this month': 3.0, 'this year': 2.0,
            'last year': 1.5, 'within the last few months': 2.5,
            'within the last 5 years': 1.0, 'more than a year ago': 0.5,
            'more than 5 years ago': 0.0,
        })
        return ('likelihood_scale', 'frequency_5pt', full_freq_map)

    # 4e. 4-pt intensity ("A lot! / Somewhat / Just a little / Not at all")
    if real_labels.issubset(INTENSITY_4PT):
        return ('ordinal_scale', 'intensity_4pt', make_4pt_intensity_map())

    # 4f. Comparison-to-prior 5-pt: "more so / less so than a year ago"
    if real_labels.issubset(MORE_LESS_5PT):
        return ('ordinal_scale', 'more_less_year_5pt', make_more_less_5pt_map())

    # 4g. Comparison-to-prior 3-pt
    if real_labels.issubset(MORE_LESS_3PT):
        return ('ordinal_scale', 'more_less_year_3pt', make_more_less_3pt_map())

    # 4h. Count-4pt ("Not at all / Once / Twice / 3 or more times")
    if real_labels.issubset(COUNT_4PT):
        return ('ordinal_scale', 'count_4pt', make_count_4pt_map())

    # 7. Demographic battery — exclusively demographic terms
    if real_labels.issubset(DEMOGRAPHIC_MARKERS | SKIP_VALUES) and len(real_labels) <= 10:
        return ('SKIP', 'demographic_battery', None)

    # 5. select_all — has is_selected, non-ordinal labels (statement-length)
    if has_is_selected and not has_numeric:
        if len(real_labels) >= 2:
            return ('select_all', None, None)

    # 6. Open-ended text — many distinct values, no structure. We also
    # treat declared single_select / joy_scale (without scale_type) as
    # verbatim when the data doesn't match any known vocab — these are
    # usually free-response questions (e.g. "What is joyful about pizza?")
    # whose data belongs in bjl_verbatims, not bjl_scores.
    if not has_is_selected and not has_numeric:
        if len(real_labels) > 20:
            return ('SKIP', 'open_ended_verbatim', None)
        # Smaller distinct count but declared as a free-response type
        if declared_type in ('single_select', 'joy_scale') and not declared_scale:
            return ('SKIP', 'open_ended_verbatim', None)

    # Unclassified — log so the human can extend the classifier
    return ('SKIP', 'unclassified', None)


# ---------------------------------------------------------------------------
# Aggregation per question_type. Returns a dict of metrics for a single item.
# ---------------------------------------------------------------------------

def aggregate_item(qtype: str, stype: Optional[str], label_map: Optional[dict],
                   item_rows: list) -> Optional[dict]:
    """
    Aggregate responses for a single item into a metrics dict for bjl_scores.
    Returns None if the item fails sample-size thresholds.
    """
    # Skip rows whose raw_value is "Not applicable" etc.
    real_rows = [r for r in item_rows
                 if r['raw_value'] is None or _normalize_label(r['raw_value']) not in SKIP_VALUES]

    if not real_rows:
        return None

    if qtype == 'joy_scale':
        # Use numeric_value when present; otherwise apply label_map
        vals = []
        for r in real_rows:
            if r['numeric_value'] is not None:
                vals.append(float(r['numeric_value']))
            elif label_map:
                m = label_map.get(_normalize_label(r['raw_value']))
                if m is not None:
                    vals.append(m)
        n = len(vals)
        if n < 30:                                       # joy_scale threshold
            return None
        mean = sum(vals) / n
        # joy_index = mean × 20 (Joy Index spec)
        joy_index = round(mean * 20, 1)
        # pct_max — share answering 5 (the joy scale's max-joy value)
        max_count = sum(1 for v in vals if v == 5)
        pct_max = round(max_count / n * 100, 1) if n > 0 else None
        # pct_negative — share answering < 0 (joy scale only)
        neg_count = sum(1 for v in vals if v < 0)
        pct_negative = round(neg_count / n * 100, 1) if n > 0 else None
        return dict(
            mean=round(mean, 3), joy_index=joy_index, n=n,
            pct_max=pct_max, pct_negative=pct_negative,
        )

    if qtype in ('ordinal_scale', 'likelihood_scale', 'familiarity_trust'):
        # mean from numeric_value or label_map. NO joy_index per strict rule.
        # Plus modal top_response + top_pct.
        vals = []
        labels_for_mode = []
        for r in real_rows:
            label = r['raw_value']
            if r['numeric_value'] is not None:
                vals.append(float(r['numeric_value']))
                labels_for_mode.append(label)
            elif label_map:
                m = label_map.get(_normalize_label(label))
                if m is not None:
                    vals.append(m)
                    labels_for_mode.append(label)
        n = len(vals)
        base_n = len(item_rows)
        if n < 50 or base_n < 100:                       # ordinal/likelihood/familiarity thresholds
            return None
        mean = sum(vals) / n
        # Modal label
        cnt = Counter(labels_for_mode)
        top_label, top_count = cnt.most_common(1)[0] if cnt else (None, 0)
        top_pct = round(top_count / n * 100, 1) if n > 0 else None
        # likelihood_scale also carries pct_max
        pct_max = None
        if qtype == 'likelihood_scale':
            max_val = max(vals) if vals else None
            if max_val is not None:
                pct_max = round(sum(1 for v in vals if v == max_val) / n * 100, 1)
        return dict(
            mean=round(mean, 3), joy_index=None, n=n, base_n=base_n,
            top_response=top_label, top_pct=top_pct, pct_max=pct_max,
        )

    if qtype == 'select_all':
        # pct = selections / base_n × 100. base_n = total respondents who saw
        # the question (distinct respondents in this group).
        selections = sum(1 for r in real_rows if r.get('is_selected') is True)
        if selections < 30:                              # select_all threshold
            return None
        # base_n at the question level, not item level — but here we get item-level rows
        # so use distinct respondent count as best available estimate
        base_n = len({r['respondent_id'] for r in real_rows})
        if base_n < 100:
            return None
        pct = round(selections / base_n * 100, 1) if base_n > 0 else None
        return dict(
            mean=None, joy_index=None, n=selections, base_n=base_n,
            pct=pct,
        )

    return None


# ---------------------------------------------------------------------------
# Brand gating
# ---------------------------------------------------------------------------

_gated_cache: Optional[set] = None

def get_gated_entities(conn) -> set:
    global _gated_cache
    if _gated_cache is not None:
        return _gated_cache
    with conn.cursor() as cur:
        cur.execute("SELECT LOWER(name) FROM bjl_gated_entities")
        _gated_cache = {row[0].strip() for row in cur.fetchall()}
    return _gated_cache


def is_brand_gated(item_name: str, gated: set) -> bool:
    if not item_name:
        return False
    norm = item_name.strip().lower()
    # Exact match
    if norm in gated:
        return True
    # Substring match — gated entity name appears as a word/phrase in the item name
    for g in gated:
        if g and g in norm:
            return True
    return False


# ---------------------------------------------------------------------------
# Main scoring loop
# ---------------------------------------------------------------------------

def fetch_question_meta(conn, question_id: int) -> Optional[dict]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT question_id, question_text, question_type, scale_type, primary_topic
            FROM bjl_questions_v2 WHERE question_id = %s
        """, (question_id,))
        row = cur.fetchone()
        return dict(row) if row else None


def fetch_responses(conn, question_id: int) -> list:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT respondent_id, item_name, raw_value, numeric_value,
                   joy_index, is_selected, fielding_id
            FROM bjl_responses
            WHERE question_id = %s
              AND item_name IS NOT NULL
              AND item_name <> ''
        """, (question_id,))
        return [dict(r) for r in cur.fetchall()]


def score_question(conn, question_id: int, dry_run: bool = False) -> dict:
    """
    Score one question_id end-to-end. Returns a summary:
      { 'question_id', 'qtype', 'stype', 'items_total', 'items_inserted',
        'items_skipped_threshold', 'items_skipped_gated', 'items_skipped_other',
        'status' }
    """
    meta = fetch_question_meta(conn, question_id)
    if not meta:
        return dict(question_id=question_id, status='question_not_found')

    rows = fetch_responses(conn, question_id)
    if not rows:
        return dict(question_id=question_id, status='no_responses')

    # Classify at the question level by looking at the full distinct raw_value set
    all_raws = {r['raw_value'] for r in rows if r['raw_value']}
    has_numeric = any(r['numeric_value'] is not None for r in rows)
    has_is_selected = any(r['is_selected'] is True for r in rows)
    qtype, stype, label_map = detect_scale(
        all_raws, has_numeric, has_is_selected,
        meta.get('question_type'), meta.get('scale_type'),
        question_text=meta.get('question_text'),
    )

    if qtype == 'SKIP':
        return dict(question_id=question_id, status=f'skipped_{stype}')

    # Group by item
    by_item = defaultdict(list)
    for r in rows:
        by_item[r['item_name']].append(r)

    gated = get_gated_entities(conn)

    summary = dict(
        question_id=question_id, qtype=qtype, stype=stype,
        items_total=len(by_item), items_inserted=0,
        items_skipped_threshold=0, items_skipped_gated=0, items_skipped_other=0,
    )

    rows_to_upsert = []
    for item_name, item_rows in by_item.items():
        if is_brand_gated(item_name, gated):
            summary['items_skipped_gated'] += 1
            continue
        metrics = aggregate_item(qtype, stype, label_map, item_rows)
        if metrics is None:
            summary['items_skipped_threshold'] += 1
            continue

        upsert_row = dict(
            item_name=item_name,
            category=meta.get('primary_topic'),
            question=meta['question_text'],
            question_id=question_id,
            question_type=qtype,
            scale_type=stype,
            wave='wave_backfill',
            mean=metrics.get('mean'),
            joy_index=metrics.get('joy_index'),
            n=metrics.get('n'),
            base_n=metrics.get('base_n'),
            top_response=metrics.get('top_response'),
            top_pct=metrics.get('top_pct'),
            pct=metrics.get('pct'),
            pct_max=metrics.get('pct_max'),
            pct_negative=metrics.get('pct_negative'),
        )
        rows_to_upsert.append(upsert_row)
        summary['items_inserted'] += 1

    if dry_run:
        summary['dry_run_rows'] = rows_to_upsert[:3]   # preview for sanity check
        summary['status'] = 'dry_run'
        return summary

    if rows_to_upsert:
        upsert_scores(conn, rows_to_upsert)
        mark_loaded(conn, question_id)

    summary['status'] = 'loaded'
    return summary


def upsert_scores(conn, rows: list) -> None:
    if not rows:
        return
    cols = [
        'item_name', 'category', 'question', 'question_id', 'question_type',
        'scale_type', 'wave', 'mean', 'joy_index', 'n', 'base_n',
        'top_response', 'top_pct', 'pct', 'pct_max', 'pct_negative',
    ]
    values = [tuple(r.get(c) for c in cols) for r in rows]
    sql = f"""
        INSERT INTO bjl_scores ({', '.join(cols)})
        VALUES %s
        ON CONFLICT (item_name, question, question_type)
        DO UPDATE SET
            scale_type = EXCLUDED.scale_type,
            mean = EXCLUDED.mean,
            joy_index = EXCLUDED.joy_index,
            n = EXCLUDED.n,
            base_n = EXCLUDED.base_n,
            top_response = EXCLUDED.top_response,
            top_pct = EXCLUDED.top_pct,
            pct = EXCLUDED.pct,
            pct_max = EXCLUDED.pct_max,
            pct_negative = EXCLUDED.pct_negative,
            question_id = EXCLUDED.question_id,
            category = COALESCE(bjl_scores.category, EXCLUDED.category),
            wave = EXCLUDED.wave
    """
    with conn.cursor() as cur:
        execute_values(cur, sql, values)
    conn.commit()


def mark_loaded(conn, question_id: int) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE bjl_backfill_scope SET loaded = true WHERE question_id = %s",
            (question_id,),
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Verify mode — score 5 existing questions and diff against live bjl_scores
# ---------------------------------------------------------------------------

VERIFICATION_QIDS = [1, 5, 60, 106, 154]   # one per existing question_type

def verify_existing(conn) -> None:
    print('Verification mode — scoring 5 existing questions and diffing vs live bjl_scores')
    print()
    for qid in VERIFICATION_QIDS:
        result = score_question(conn, qid, dry_run=True)
        print(f'Q{qid}: {result.get("status")} qtype={result.get("qtype")} stype={result.get("stype")}')
        print(f'  items: total={result.get("items_total")} '
              f'inserted={result.get("items_inserted")} '
              f'gated={result.get("items_skipped_gated")} '
              f'sub_threshold={result.get("items_skipped_threshold")}')
        for preview in result.get('dry_run_rows', [])[:2]:
            item = preview['item_name']
            # Diff vs live
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT mean, joy_index, n, top_response, top_pct, pct
                    FROM bjl_scores
                    WHERE question_id = %s AND item_name = %s
                    LIMIT 1
                """, (qid, item))
                live = cur.fetchone()
            if not live:
                print(f'  [no live row to compare] {item[:60]}')
                continue
            mean_diff = abs((live['mean'] or 0) - (preview.get('mean') or 0))
            ji_diff   = abs((live['joy_index'] or 0) - (preview.get('joy_index') or 0))
            n_diff    = abs((live['n'] or 0) - (preview.get('n') or 0))
            print(f'  {item[:50]:50s} mean Δ={mean_diff:.3f} '
                  f'ji Δ={ji_diff:.1f} n Δ={n_diff}')
        print()


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true',
                        help='Show what would be written without inserting.')
    parser.add_argument('--verify-existing', action='store_true',
                        help='Score 5 existing questions and diff against live rows.')
    parser.add_argument('--question-ids',
                        help='Comma-separated list of question_ids to score (overrides scope).')
    parser.add_argument('--max-questions', type=int,
                        help='Cap on number of questions processed (testing).')
    args = parser.parse_args()

    # Accept either var name. The existing .env in this repo uses
    # DATABASE_URL; run_enrichment.py and run_embeddings.py historically
    # used SUPABASE_DB_URL. Either works.
    db_url = os.environ.get('SUPABASE_DB_URL') or os.environ.get('DATABASE_URL')
    if not db_url:
        print('ERROR: set SUPABASE_DB_URL or DATABASE_URL env var', file=sys.stderr)
        sys.exit(1)

    with psycopg2.connect(db_url) as conn:
        if args.verify_existing:
            verify_existing(conn)
            return

        if args.question_ids:
            qids = [int(q.strip()) for q in args.question_ids.split(',') if q.strip()]
        else:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT question_id FROM bjl_backfill_scope
                    WHERE COALESCE(loaded, false) = false
                    ORDER BY question_id
                """)
                qids = [r[0] for r in cur.fetchall()]

        if args.max_questions:
            qids = qids[:args.max_questions]

        print(f'Scoring {len(qids)} question(s). dry_run={args.dry_run}')
        print()
        totals = Counter()
        for qid in qids:
            result = score_question(conn, qid, dry_run=args.dry_run)
            status = result.get('status', 'unknown')
            qtype = result.get('qtype', '-')
            inserted = result.get('items_inserted', 0)
            gated = result.get('items_skipped_gated', 0)
            sub = result.get('items_skipped_threshold', 0)
            print(f'Q{qid:4d}  {status:28s}  qtype={qtype:18s}  '
                  f'inserted={inserted:3d}  gated={gated:3d}  sub_threshold={sub:3d}')
            totals[status] += 1
            totals['items_inserted'] += inserted
            totals['items_gated'] += gated
            totals['items_sub_threshold'] += sub

        print()
        print('Summary:')
        for k, v in sorted(totals.items()):
            print(f'  {k:30s} {v}')


if __name__ == '__main__':
    main()
