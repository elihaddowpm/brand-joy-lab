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
from psycopg2.extras import RealDictCursor, execute_values, Json


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

# 4-pt likelihood — no midpoint, "somewhat" on both poles. Distinct from
# LIKELIHOOD_5PT, which has a neutral centre and no "somewhat unlikely".
LIKELIHOOD_4PT = {
    'not at all likely', 'somewhat unlikely', 'somewhat likely', 'very likely',
}

def make_4pt_likelihood_map():
    return {
        'not at all likely': 0.0, 'somewhat unlikely': 1.0,
        'somewhat likely': 2.0, 'very likely': 3.0,
    }

# 4-pt improvement — "how much would X improve each of these"
IMPROVEMENT_4PT = {
    'no improvement', 'minor improvement', 'moderate improvement',
    'major improvement',
}

def make_4pt_improvement_map():
    return {
        'no improvement': 0.0, 'minor improvement': 1.0,
        'moderate improvement': 2.0, 'major improvement': 3.0,
    }

# Stress-change ladder. DELIBERATELY ASYMMETRIC: the fielded scale offers two
# steps toward stress and only one toward relief, with no "Much Less Stressed".
# Mapped honestly at -2/-1/0/+1 rather than forced into symmetry or padded with
# a response option nobody was offered. Consequence: the mean leans negative as
# an artefact of the ladder's shape, not of sentiment. The scale_type carries
# 'asymmetric' so nothing downstream reads the lean as severity.
STRESS_CHANGE_4PT = {
    'much more stressed', 'more stressed', 'about the same', 'less stressed',
}

def make_stress_change_map():
    return {
        'much more stressed': -2.0, 'more stressed': -1.0,
        'about the same': 0.0, 'less stressed': 1.0,
    }

# Constant markers a loader may put in raw_value when the option text itself
# lives in item_name. Their presence means "this box was ticked", nothing more.
SELECTION_MARKERS = {'selected', 'checked', 'yes', 'true', '1'}

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


# Direction-of-change 3-pt. Distinct from MORE_LESS_3PT, whose labels carry
# their own comparison clause ("...than the last year or two").
MORE_OFTEN_3PT = {'more often', 'about the same', 'less often'}

def make_more_often_3pt_map():
    return {'less often': -1.0, 'about the same': 0.0, 'more often': 1.0}


# Worry-change 5-pt. Unlike STRESS_CHANGE_4PT this ladder IS symmetric — it
# offers two steps in each direction around a true midpoint — so it maps to a
# symmetric scale and carries no asymmetry caveat. Sign convention matches the
# stress ladder: more worried is negative.
WORRY_CHANGE_5PT = {
    'much more worried', 'somewhat more worried', 'about the same',
    'somewhat less worried', 'much less worried',
}

def make_worry_change_map():
    return {
        'much more worried': -2.0, 'somewhat more worried': -1.0,
        'about the same': 0.0, 'somewhat less worried': 1.0,
        'much less worried': 2.0,
    }


# Engagement 4-pt. Ordered by degree of engagement, not by frequency:
# "consistently" is a stronger commitment than "occasionally", and "very
# actively" stronger again.
ENGAGEMENT_4PT = {'not at all', 'occasionally', 'consistently', 'very actively'}

def make_engagement_4pt_map():
    return {
        'not at all': 0.0, 'occasionally': 1.0,
        'consistently': 2.0, 'very actively': 3.0,
    }


# Degree-of-increase 4-pt, used for "is this a reason you are doing X more".
MORE_THAN_BEFORE_4PT = {
    'not at all', 'not more than before', 'somewhat more than before',
    'much more than before',
}

def make_more_than_before_map():
    return {
        'not at all': 0.0, 'not more than before': 1.0,
        'somewhat more than before': 2.0, 'much more than before': 3.0,
    }


# Intent 4-pt. The fielded set also offers "I have no idea", which is not a
# point on this axis — see UNAWARE_LABELS. It is stripped before matching and
# reported separately, so the axis itself is a clean four points.
INTENT_4PT = {'not at all', 'maybe', 'probably', 'absolutely!'}

def make_intent_4pt_map():
    return {
        'not at all': 0.0, 'maybe': 1.0, 'probably': 2.0, 'absolutely!': 3.0,
    }


# Count-4pt — "Not at all / Once / Twice / 3 or more times". Used in trip-
# count questions (in the past year, how many business/personal trips).
COUNT_4PT = {'not at all', 'once', 'twice', '3 or more times'}

def make_count_4pt_map():
    return {'not at all': 0.0, 'once': 1.0, 'twice': 2.0, '3 or more times': 3.0}

# Two different things used to live in one bucket here, and collapsing them
# lost a real measurement.
#
# NON_RESPONSE is an absence of data: the respondent declined, or the item
# did not apply. Nothing can be inferred, so these rows leave the base.
#
# UNAWARE_LABELS is a finding. "I have no idea" / "Unfamiliar" / "Never heard
# of it" is not a refusal to answer — it is the respondent telling us they
# have no mental picture of the thing. For anything at awareness stage that
# cohort is often the most strategically interesting group in the data. It
# has no position on the response axis, so it can never enter a mean; but
# dropping it silently deletes the finding. It is counted and reported as its
# own number instead. Same measurement as "one in five hostel rejecters have
# no mental picture of a hostel" — that only exists if this set is kept.
NON_RESPONSE = {
    'not applicable', 'n/a', 'na', 'prefer not to answer', '', None,
}

UNAWARE_LABELS = {
    "don't know", "n/a, don't know", 'dont know', 'unfamiliar', 'not familiar',
    'no opinion', 'i have no idea', 'no idea', 'never heard of it',
    'never heard of them', "i've never heard of it", 'not sure',
    'unsure', "i'm not familiar with it", 'not familiar with it',
}

# Everything that must stay out of a mean, for either reason. Classification
# and averaging both use this; only the reporting differs.
SKIP_VALUES = NON_RESPONSE | UNAWARE_LABELS

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
    # U+2212 MINUS SIGN is a different character from ASCII '-', so a fielding
    # whose tool emits "−1" produces labels that match no scale vocabulary and
    # the whole question falls through to 'unclassified'. clean_mojibake() does
    # not touch it — this is typography, not encoding damage.
    return s.strip().lower().replace('\u2212', '-')


def _looks_joy_question(question_text: Optional[str]) -> bool:
    if not question_text:
        return False
    qt = question_text.lower()
    return any(kw in qt for kw in JOY_KEYWORDS)


def detect_scale(distinct_raws: set, has_numeric: bool, has_is_selected: bool,
                 declared_type: Optional[str], declared_scale: Optional[str],
                 question_text: Optional[str] = None,
                 presence_encoded: bool = False) -> tuple:
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
        # "+1" and "1" are the same point on a -3..+5 scale; some fieldings
        # write the positive sign explicitly.
        flat = {v[1:] if v and v.startswith('+') else v for v in flat}
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

    # 4a-ii. 4-pt likelihood (no midpoint)
    if real_labels.issubset(LIKELIHOOD_4PT):
        return ('likelihood_scale', 'likely_unlikely_4pt', make_4pt_likelihood_map())

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

    # 4i. Improvement-4pt ("Major / Moderate / Minor / No improvement")
    if real_labels.issubset(IMPROVEMENT_4PT):
        return ('ordinal_scale', 'improvement_4pt', make_4pt_improvement_map())

    # 4j. Stress-change ladder — asymmetric by design, see STRESS_CHANGE_4PT
    if real_labels.issubset(STRESS_CHANGE_4PT):
        return ('ordinal_scale', 'stress_change_asymmetric_4pt',
                make_stress_change_map())

    # 4k. Worry-change 5-pt — symmetric, see WORRY_CHANGE_5PT
    if real_labels.issubset(WORRY_CHANGE_5PT):
        return ('ordinal_scale', 'worry_change_symmetric_5pt',
                make_worry_change_map())

    # 4l. Direction-of-change 3-pt ("More often / About the same / Less often")
    if real_labels.issubset(MORE_OFTEN_3PT):
        return ('ordinal_scale', 'more_often_3pt', make_more_often_3pt_map())

    # 4m. Engagement 4-pt
    if real_labels.issubset(ENGAGEMENT_4PT):
        return ('ordinal_scale', 'engagement_4pt', make_engagement_4pt_map())

    # 4n. Degree-of-increase 4-pt
    if real_labels.issubset(MORE_THAN_BEFORE_4PT):
        return ('ordinal_scale', 'more_than_before_4pt',
                make_more_than_before_map())

    # 4o. Intent 4-pt — the unaware option is already stripped from
    #     real_labels, so the axis here is exactly four points.
    if real_labels.issubset(INTENT_4PT):
        return ('likelihood_scale', 'intent_4pt', make_intent_4pt_map())

    # 7. Demographic battery — exclusively demographic terms
    if real_labels.issubset(DEMOGRAPHIC_MARKERS | SKIP_VALUES) and len(real_labels) <= 10:
        return ('SKIP', 'demographic_battery', None)

    # 5. select_all — has is_selected, non-ordinal labels (statement-length)
    if has_is_selected and not has_numeric:
        if len(real_labels) >= 2:
            return ('select_all', None, None)
        # Single-label encoding: the option text is in item_name and raw_value
        # is a constant tick marker. Same question, different loader convention
        # — without this the whole battery falls through to 'unclassified'.
        if real_labels.issubset(SELECTION_MARKERS):
            return ('select_all', None, None)

    # 5b. select_all with the selection encoded as row presence. is_selected is
    # NULL throughout and raw_value simply repeats the option text, so a stored
    # row IS a tick and an unticked option has no row at all. The caller proves
    # raw_value == item_name on every row before setting this, which is what
    # separates the shape from a single-answer question (item_name is the
    # question, raw_value the chosen option) and from a rated grid (raw_value is
    # a scale label). Must precede the open-ended check below, or any battery
    # with more than 20 options would be read as verbatim text.
    if presence_encoded and not has_is_selected and not has_numeric:
        if len(real_labels) >= 2:
            return ('select_all', 'presence_encoded', None)

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
                   item_rows: list,
                   question_base_n: Optional[int] = None) -> Optional[dict]:
    """
    Aggregate responses for a single item into a metrics dict for bjl_scores.
    Returns None if the item fails sample-size thresholds.

    question_base_n is the number of distinct respondents who saw the whole
    question. It matters for select_all: see the note at that branch.
    """
    # Three cohorts, not two. real_rows are the people who placed themselves
    # on the response axis. unaware_rows are the people who told us they have
    # no mental picture of the thing — a finding, reported separately below.
    # The remainder is non-response and carries nothing.
    real_rows, unaware_rows = [], []
    for r in item_rows:
        if r['raw_value'] is None:
            real_rows.append(r)
            continue
        lab = _normalize_label(r['raw_value'])
        if lab in UNAWARE_LABELS:
            unaware_rows.append(r)
        elif lab not in SKIP_VALUES:
            real_rows.append(r)

    if not real_rows:
        return None

    # Share of everyone who saw this item who has no mental picture of it.
    # Denominator is the whole item base, so this is comparable to the axis
    # percentages rather than to each other. Null when nobody was unaware, so
    # an absent cohort is distinguishable from a zero-sized one.
    dist = None
    if unaware_rows:
        seen = len(item_rows)
        dist = {
            'unaware_n': len(unaware_rows),
            'unaware_pct': round(len(unaware_rows) / seen * 100, 1) if seen else None,
            'unaware_labels': sorted({r['raw_value'] for r in unaware_rows
                                      if r['raw_value']}),
            'axis_n': len(real_rows),
            'item_base_n': seen,
        }

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
            pct_max=pct_max, pct_negative=pct_negative, distribution=dist,
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
            distribution=dist,
        )

    if qtype == 'select_all':
        # pct = selections / base_n × 100. base_n = total respondents who saw
        # the question (distinct respondents in this group).
        if stype == 'presence_encoded':
            # Every stored row is a tick, so the row count is the selection
            # count. Reading is_selected here would score every option zero.
            selections = len(real_rows)
        else:
            selections = sum(1 for r in real_rows if r.get('is_selected') is True)
        if selections < 30:                              # select_all threshold
            return None
        # base_n must be everyone who SAW the question, which cannot be derived
        # from the rows handed in: when the loader stores only ticked boxes,
        # those rows ARE the selections, so base_n would equal the selection
        # count and every option would score exactly 100%. Options with few
        # selections would additionally fall under the base_n floor and vanish,
        # biasing the battery toward its popular answers. Caller supplies it.
        base_n = question_base_n or len({r['respondent_id'] for r in real_rows})
        if base_n < 100:
            return None
        pct = round(selections / base_n * 100, 1) if base_n > 0 else None
        return dict(
            mean=None, joy_index=None, n=selections, base_n=base_n,
            pct=pct, distribution=dist,
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


def fetch_live_keys(conn) -> set:
    """Every natural key already present in bjl_scores.

    The upsert conflicts on (item_name, question, question_type), so this
    is exactly the set of rows a run would UPDATE rather than INSERT.
    Used by --refresh-only.
    """
    with conn.cursor() as cur:
        cur.execute("SELECT item_name, question, question_type FROM bjl_scores")
        return {(a, b, c) for a, b, c in cur.fetchall()}


def score_question(conn, question_id: int, dry_run: bool = False,
                   live_keys: Optional[set] = None) -> dict:
    """
    Score one question_id end-to-end. Returns a summary:
      { 'question_id', 'qtype', 'stype', 'items_total', 'items_inserted',
        'items_skipped_threshold', 'items_skipped_gated', 'items_skipped_other',
        'status' }

    When `live_keys` is supplied (--refresh-only), any computed row whose
    natural key is not already in bjl_scores is dropped. That confines the
    run to in-place updates of existing rows and makes inserts impossible.
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
    # Selection encoded as row presence — raw_value repeats the option text.
    # Checked across every row rather than sampled: one mismatch means
    # raw_value carries something other than the item and the shape is not this.
    presence_encoded = (
        len({r['item_name'] for r in rows}) >= 2
        and all((r['raw_value'] or '').strip().lower()
                == (r['item_name'] or '').strip().lower() for r in rows)
    )
    qtype, stype, label_map = detect_scale(
        all_raws, has_numeric, has_is_selected,
        meta.get('question_type'), meta.get('scale_type'),
        question_text=meta.get('question_text'),
        presence_encoded=presence_encoded,
    )

    if qtype == 'SKIP':
        return dict(question_id=question_id, status=f'skipped_{stype}')

    # Everyone who saw the question, counted once. select_all percentages are
    # shares of this, and it cannot be recovered from a single item's rows.
    question_base_n = len({r['respondent_id'] for r in rows})

    # Group by item
    by_item = defaultdict(list)
    for r in rows:
        by_item[r['item_name']].append(r)

    gated = get_gated_entities(conn)

    summary = dict(
        question_id=question_id, qtype=qtype, stype=stype,
        items_total=len(by_item), items_inserted=0,
        items_skipped_threshold=0, items_skipped_gated=0, items_skipped_other=0,
        items_skipped_not_live=0,
    )

    rows_to_upsert = []
    for item_name, item_rows in by_item.items():
        if is_brand_gated(item_name, gated):
            summary['items_skipped_gated'] += 1
            continue
        metrics = aggregate_item(qtype, stype, label_map, item_rows,
                                 question_base_n=question_base_n)
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
            distribution=(Json(metrics['distribution'])
                          if metrics.get('distribution') else None),
        )
        if live_keys is not None and (
                item_name, meta['question_text'], qtype) not in live_keys:
            summary['items_skipped_not_live'] += 1
            continue

        rows_to_upsert.append(upsert_row)
        summary['items_inserted'] += 1

    if dry_run:
        # Full set, not a 3-row preview: verify_existing diffs every row.
        summary['dry_run_rows'] = rows_to_upsert
        summary['status'] = 'dry_run'
        return summary

    if rows_to_upsert:
        upsert_scores(conn, rows_to_upsert)
        # In refresh-only mode the question was NOT fully loaded — its
        # not-yet-live items were skipped by design. Flipping loaded=true
        # here would retire it from the backfill queue with items missing.
        if live_keys is None:
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
        'distribution',
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
            distribution = EXCLUDED.distribution,
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


def verify_existing(conn, qids: Optional[list] = None) -> bool:
    """Gate: does the script reproduce live numbers where the data has NOT moved?

    Diffs on the NATURAL KEY (item_name, question, question_type) — the same
    key the upsert conflicts on. It deliberately does NOT look up by
    question_id: bjl_scores.question_id is a metadata stamp, not the
    source-of-aggregation pointer (see "Known divergence" in
    SCORING_README.md), so a question_id lookup misses almost every row and
    reports a false failure.

    A row only counts toward the verdict if its question has no responses
    newer than the live score row. Where new responses HAVE landed, a moved
    number is the refresh working, not a disagreement, and is reported
    separately. Returns True if every comparable row reproduces exactly.
    """
    qids = qids or VERIFICATION_QIDS
    with conn.cursor() as cur:
        cur.execute("""SELECT item_name, question, question_type,
                              n, mean, joy_index, created_at
                       FROM bjl_scores""")
        live = {(r[0], r[1], r[2]): r[3:] for r in cur.fetchall()}
        cur.execute("SELECT question_id, max(created_at) FROM bjl_responses GROUP BY 1")
        last_resp = dict(cur.fetchall())

    stable_ok = stable_bad = refreshed = absent = 0
    failures = []

    print(f'Verification — {len(qids)} question(s), diffed on the natural key')
    print()
    for qid in qids:
        result = score_question(conn, qid, dry_run=True)
        for row in result.get('dry_run_rows', []):
            key = (row['item_name'], row['question'], row['question_type'])
            if key not in live:
                absent += 1
                continue
            ln, lmean, lji, screated = live[key]
            moved = (ln or 0) != (row.get('n') or 0)
            has_new_data = (last_resp.get(qid) and screated
                            and last_resp[qid] > screated)
            if has_new_data:
                refreshed += 1
            elif moved:
                stable_bad += 1
                if len(failures) < 15:
                    failures.append(
                        f"  q{qid} {row['item_name'][:40]!r} "
                        f"n {ln}->{row.get('n')}  ji {lji}->{row.get('joy_index')}")
            else:
                stable_ok += 1

    print(f'  reproduces exactly (no new data)   : {stable_ok}')
    print(f'  DISAGREES (no new data)            : {stable_bad}')
    print(f'  moved, question has new responses  : {refreshed}   (expected)')
    print(f'  not yet in bjl_scores              : {absent}')
    if failures:
        print('\n  disagreements:')
        for f in failures:
            print(f)
    verdict = stable_bad == 0 and stable_ok > 0
    print(f'\n  GATE: {"PASS" if verdict else "FAIL"}')
    return verdict


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true',
                        help='Show what would be written without inserting.')
    parser.add_argument('--verify-existing', action='store_true',
                        help='Diff computed rows against live on the natural key. '
                             'Honours --question-ids; defaults to 5 sample questions.')
    parser.add_argument('--refresh-only', action='store_true',
                        help='Only update rows already in bjl_scores; never insert. '
                             'Use this to bring existing scores current without '
                             'expanding the corpus.')
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
            qids = ([int(q.strip()) for q in args.question_ids.split(',') if q.strip()]
                    if args.question_ids else None)
            sys.exit(0 if verify_existing(conn, qids) else 1)

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

        live_keys = fetch_live_keys(conn) if args.refresh_only else None
        if live_keys is not None:
            print(f'refresh-only: {len(live_keys)} existing natural keys; '
                  f'rows outside this set will be skipped, not inserted')

        print(f'Scoring {len(qids)} question(s). dry_run={args.dry_run}')
        print()
        totals = Counter()
        for qid in qids:
            result = score_question(conn, qid, dry_run=args.dry_run,
                                    live_keys=live_keys)
            status = result.get('status', 'unknown')
            qtype = result.get('qtype', '-')
            inserted = result.get('items_inserted', 0)
            gated = result.get('items_skipped_gated', 0)
            sub = result.get('items_skipped_threshold', 0)
            notlive = result.get('items_skipped_not_live', 0)
            print(f'Q{qid:4d}  {status:28s}  qtype={qtype:18s}  '
                  f'written={inserted:3d}  gated={gated:3d}  sub_threshold={sub:3d}'
                  + (f'  not_live={notlive:3d}' if live_keys is not None else ''))
            totals[status] += 1
            totals['items_written'] += inserted
            totals['items_gated'] += gated
            totals['items_sub_threshold'] += sub
            totals['items_skipped_not_live'] += notlive

        print()
        print('Summary:')
        for k, v in sorted(totals.items()):
            print(f'  {k:30s} {v}')


if __name__ == '__main__':
    main()
