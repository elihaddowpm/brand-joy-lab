#!/usr/bin/env python3
"""
test_framework_tagger.py — offline smoke tests for bin/framework_tagger.

These tests do NOT call Anthropic and do NOT require DATABASE_URL.
They validate the pure-Python parts: prompt construction, response
parsing, hallucinated-key filtering, and batch-stats accounting.

Run: python3 bin/test_framework_tagger.py

Exits 0 on pass, non-zero with a descriptive message on failure.

For the live regression test (16 fixture verbatims from the DB,
requires ANTHROPIC_API_KEY + DATABASE_URL), see
bin/test_framework_regression.py.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from framework_tagger import (  # noqa: E402
    build_system_prompt,
    build_user_message,
    canonical_keys,
    filter_to_canonical,
    parse_response,
    BatchStats,
    CALIBRATION_RULES,
    WORKED_EXAMPLES,
    OUTPUT_FORMAT_RULE,
    OCCASIONS_NOTE,
)


# ---------------------------------------------------------------------------
# A small fake-frameworks fixture used by all tests. Mirrors the shape that
# load_frameworks_from_db would return, with a handful of representative
# canonical keys per framework. Keep the keys realistic so the prompt smoke
# checks see plausible content.
# ---------------------------------------------------------------------------
FAKE_FRAMEWORKS = {
    'joy_modes': [
        {'key': 'achievement',   'display_name': 'Achievement',   'definition': 'Mastery and accomplishment.'},
        {'key': 'aesthetic',     'display_name': 'Aesthetic',     'definition': 'Beauty and visual pleasure.'},
        {'key': 'awe',           'display_name': 'Awe',           'definition': 'Wonder and curiosity.'},
        {'key': 'freedom',       'display_name': 'Freedom',       'definition': 'Autonomy and release.'},
        {'key': 'hedonic',       'display_name': 'Hedonic',       'definition': 'Sensory enjoyment.'},
        {'key': 'inspirational', 'display_name': 'Inspirational', 'definition': 'Energized toward action.'},
        {'key': 'physical',      'display_name': 'Physical',      'definition': 'Embodied vitality.'},
        {'key': 'playful',       'display_name': 'Playful',       'definition': 'Lighthearted fun.'},
        {'key': 'relational',    'display_name': 'Relational',    'definition': 'Connection with others.'},
        {'key': 'self_actualization', 'display_name': 'Self-actualization', 'definition': 'Becoming who you want to be.'},
        {'key': 'sentimental',   'display_name': 'Sentimental',   'definition': 'Personal history and memory.'},
        {'key': 'spiritual',     'display_name': 'Spiritual',     'definition': 'Transcendence.'},
        {'key': 'tranquil',      'display_name': 'Tranquil',      'definition': 'Calm and peace.'},
        {'key': 'triumph',       'display_name': 'Triumph',       'definition': 'Victory.'},
    ],
    'tensions': [
        {'key': 'aspiration_vs_acceptance',     'display_name': 'Aspiration vs Acceptance',     'definition': 'Want vs accept.'},
        {'key': 'challenger_vs_legacy',         'display_name': 'Challenger vs Legacy',         'definition': 'New vs established.'},
        {'key': 'control_vs_surrender',         'display_name': 'Control vs Surrender',         'definition': 'Hold on vs let go.'},
        {'key': 'discovery_vs_comfort',         'display_name': 'Discovery vs Comfort',         'definition': 'New vs familiar.'},
        {'key': 'luxury_vs_value',              'display_name': 'Luxury vs Value',              'definition': 'Premium vs price.'},
        {'key': 'moderation_vs_indulgence',     'display_name': 'Moderation vs Indulgence',     'definition': 'Restrain vs treat.'},
        {'key': 'present_vs_future',            'display_name': 'Present vs Future',            'definition': 'Now vs later.'},
        {'key': 'served_vs_overlooked',         'display_name': 'Served vs Overlooked',         'definition': 'Cared for vs ignored.'},
        {'key': 'individual_vs_communal',       'display_name': 'Individual vs Communal',       'definition': 'Self vs group.'},
        {'key': 'savings_vs_spending',          'display_name': 'Savings vs Spending',          'definition': 'Save vs spend.'},
        {'key': 'self_vs_others',               'display_name': 'Self vs Others',               'definition': 'Me vs them.'},
        {'key': 'tradition_vs_modern',          'display_name': 'Tradition vs Modern',          'definition': 'Heritage vs new.'},
        {'key': 'introvert_vs_extrovert',       'display_name': 'Introvert vs Extrovert',       'definition': 'Inward vs outward.'},
        {'key': 'forgiveness_vs_foresight',     'display_name': 'Forgiveness vs Foresight',     'definition': 'Past vs prevention.'},
        {'key': 'performance_vs_pleasure',      'display_name': 'Performance vs Pleasure',      'definition': 'Output vs joy.'},
    ],
    'functional_jobs': [
        {'key': 'build_belonging',     'display_name': 'Build belonging',     'definition': 'Connect to a group.'},
        {'key': 'cheer_team',          'display_name': 'Cheer team',          'definition': 'Support a side.'},
        {'key': 'connect_remotely',    'display_name': 'Connect remotely',    'definition': 'Bridge distance.'},
        {'key': 'create_memory',       'display_name': 'Create memory',       'definition': 'Make a moment.'},
        {'key': 'demonstrate_care',    'display_name': 'Demonstrate care',    'definition': 'Show love.'},
        {'key': 'display_taste',       'display_name': 'Display taste',       'definition': 'Show sensibility.'},
        {'key': 'escape_routine',      'display_name': 'Escape routine',      'definition': 'Break the everyday.'},
        {'key': 'express_creativity',  'display_name': 'Express creativity',  'definition': 'Make something.'},
        {'key': 'feel_proud',          'display_name': 'Feel proud',          'definition': 'Self-recognition.'},
        {'key': 'immerse_in_story',    'display_name': 'Immerse in story',    'definition': 'Lose self in narrative.'},
        {'key': 'learn_grow',          'display_name': 'Learn / grow',        'definition': 'Master something.'},
        {'key': 'mark_milestone',      'display_name': 'Mark milestone',      'definition': 'Celebrate a moment.'},
        {'key': 'nourish_others',      'display_name': 'Nourish others',      'definition': 'Feed and tend.'},
        {'key': 'plan_future',         'display_name': 'Plan future',         'definition': 'Look ahead.'},
        {'key': 'preserve_tradition',  'display_name': 'Preserve tradition',  'definition': 'Keep continuity.'},
        {'key': 'provide_security',    'display_name': 'Provide security',    'definition': 'Steady ground.'},
        {'key': 'refuel',              'display_name': 'Refuel',              'definition': 'Recharge.'},
        {'key': 'relax_recover',       'display_name': 'Relax / recover',     'definition': 'Rest.'},
        {'key': 'relieve_anxiety',     'display_name': 'Relieve anxiety',     'definition': 'Calm worry.'},
        {'key': 'reward_self',         'display_name': 'Reward self',         'definition': 'Treat oneself.'},
        {'key': 'share_experience',    'display_name': 'Share experience',    'definition': 'Bring others in.'},
        {'key': 'signal_identity',     'display_name': 'Signal identity',     'definition': 'Show who you are.'},
        {'key': 'signal_status',       'display_name': 'Signal status',       'definition': 'Show standing.'},
    ],
    'occasions': [
        {'key': 'alone_time',         'display_name': 'Alone time',         'definition': 'Solitary moment.'},
        {'key': 'anticipation',       'display_name': 'Anticipation',       'definition': 'Looking forward.'},
        {'key': 'birthday',           'display_name': 'Birthday',           'definition': 'Personal milestone.'},
        {'key': 'celebration',        'display_name': 'Celebration',        'definition': 'Marking a moment.'},
        {'key': 'evening',            'display_name': 'Evening',            'definition': 'End of day.'},
        {'key': 'everyday',           'display_name': 'Everyday',           'definition': 'Routine.'},
        {'key': 'gathering',          'display_name': 'Gathering',          'definition': 'Group event.'},
        {'key': 'gift_giving',        'display_name': 'Gift giving',        'definition': 'Giving an item.'},
        {'key': 'holiday',            'display_name': 'Holiday',            'definition': 'Calendar holiday.'},
        {'key': 'hosting',            'display_name': 'Hosting',            'definition': 'Welcoming others.'},
        {'key': 'in_moment',          'display_name': 'In the moment',      'definition': 'During the experience.'},
        {'key': 'live_event',         'display_name': 'Live event',         'definition': 'Concert, game, etc.'},
        {'key': 'mealtime',           'display_name': 'Mealtime',           'definition': 'During a meal.'},
        {'key': 'memory',             'display_name': 'Memory',             'definition': 'Recalling later.'},
        {'key': 'morning',            'display_name': 'Morning',            'definition': 'Start of day.'},
        {'key': 'post_purchase',      'display_name': 'Post purchase',      'definition': 'After buying.'},
        {'key': 'purchase_moment',    'display_name': 'Purchase moment',    'definition': 'Act of buying.'},
        {'key': 'service',            'display_name': 'Service',            'definition': 'Customer service interaction.'},
        {'key': 'shopping',           'display_name': 'Shopping',           'definition': 'Browsing or buying.'},
        {'key': 'special_occasion',   'display_name': 'Special occasion',   'definition': 'Notable moment.'},
        {'key': 'sports_viewing',     'display_name': 'Sports viewing',     'definition': 'Watching a game.'},
        {'key': 'transition',         'display_name': 'Transition',         'definition': 'Life change.'},
        {'key': 'travel_journey',     'display_name': 'Travel journey',     'definition': 'En route.'},
        {'key': 'vacation',           'display_name': 'Vacation',           'definition': 'Trip away.'},
        {'key': 'weekend',            'display_name': 'Weekend',            'definition': 'Off days.'},
        {'key': 'work',               'display_name': 'Work',               'definition': 'Workplace context.'},
    ],
}


def test_build_system_prompt_includes_all_keys():
    p = build_system_prompt(FAKE_FRAMEWORKS)
    for fwk, entries in FAKE_FRAMEWORKS.items():
        for e in entries:
            assert f"`{e['key']}`" in p, f'{fwk} key {e["key"]!r} missing from prompt'
    print('  PASS build_system_prompt includes every framework key')


def test_build_system_prompt_contains_calibration_rules():
    p = build_system_prompt(FAKE_FRAMEWORKS)
    for snippet in (
        'Rule 1: Multi-tag is the default',
        'Rule 2: Word-grounded, not context-inferred',
        'Rule 3: Expressed gaps count',
        'Rule 4: Some verbatims have zero tags',
        'Rule 5: Job vs Tension distinction',
    ):
        assert snippet in p, f'calibration rule snippet missing: {snippet!r}'
    print('  PASS build_system_prompt contains all 5 calibration rules')


def test_build_system_prompt_contains_examples():
    p = build_system_prompt(FAKE_FRAMEWORKS)
    for snippet in (
        'EXAMPLE 1',
        'EXAMPLE 2',
        'EXAMPLE 3',
        'ANTI-PATTERN 1',
        'ANTI-PATTERN 2',
        'ANTI-PATTERN 3',
    ):
        assert snippet in p, f'worked example missing: {snippet!r}'
    print('  PASS build_system_prompt contains 3 positive + 3 anti-pattern examples')


def test_build_system_prompt_includes_occasions_note():
    p = build_system_prompt(FAKE_FRAMEWORKS)
    assert 'journey-phase occasions' in p
    assert 'ADDITIVE' in p
    print('  PASS build_system_prompt includes occasions journey-phase note')


def test_build_user_message_format():
    msg = build_user_message('I love wine.', 'Tell me about wine.')
    assert 'Question: Tell me about wine.' in msg
    assert 'Verbatim: I love wine.' in msg
    assert 'Apply the calibration rules' in msg
    assert 'Return JSON only' in msg
    # Empty question still safe
    msg2 = build_user_message('Just words.', None)
    assert '(no question text on file)' in msg2
    print('  PASS build_user_message formats correctly with and without question')


def test_parse_response_strips_fences():
    raw = '```json\n{"joy_modes": ["hedonic"], "tensions": [], "functional_jobs": [], "occasions": []}\n```'
    parsed = parse_response(raw)
    assert parsed == {'joy_modes': ['hedonic'], 'tensions': [], 'functional_jobs': [], 'occasions': []}
    raw_no_lang = '```\n{"joy_modes": []}\n```'
    parsed2 = parse_response(raw_no_lang)
    assert parsed2 == {'joy_modes': []}
    print('  PASS parse_response strips ```json and ``` fences')


def test_parse_response_handles_trailing_comma():
    raw = '{"joy_modes": ["hedonic", "relational",], "tensions": [], "functional_jobs": [], "occasions": []}'
    parsed = parse_response(raw)
    assert parsed is not None
    assert parsed['joy_modes'] == ['hedonic', 'relational']
    print('  PASS parse_response recovers from a single trailing comma')


def test_parse_response_returns_none_on_garbage():
    assert parse_response('not json at all') is None
    assert parse_response('') is None
    assert parse_response('   ') is None
    print('  PASS parse_response returns None on garbage / empty')


def test_filter_to_canonical_drops_hallucinated_keys():
    canonical = canonical_keys(FAKE_FRAMEWORKS)
    parsed = {
        'joy_modes': ['hedonic', 'aesthetic', 'made_up_mode'],
        'tensions': ['luxury_vs_value', 'made_up_tension'],
        'functional_jobs': ['share_experience'],
        'occasions': ['gathering', 'NOT_A_REAL_OCCASION'],
    }
    out = filter_to_canonical(parsed, canonical)
    assert out['joy_modes'] == ['hedonic', 'aesthetic']
    assert out['tensions'] == ['luxury_vs_value']
    assert out['functional_jobs'] == ['share_experience']
    assert out['occasions'] == ['gathering']
    print('  PASS filter_to_canonical drops hallucinated keys')


def test_filter_to_canonical_dedupes():
    canonical = canonical_keys(FAKE_FRAMEWORKS)
    parsed = {
        'joy_modes': ['hedonic', 'hedonic', 'aesthetic'],
        'tensions': [],
        'functional_jobs': [],
        'occasions': [],
    }
    out = filter_to_canonical(parsed, canonical)
    assert out['joy_modes'] == ['hedonic', 'aesthetic']
    print('  PASS filter_to_canonical dedupes preserving order')


def test_filter_to_canonical_handles_missing_or_wrong_type():
    canonical = canonical_keys(FAKE_FRAMEWORKS)
    # Missing keys → default to []
    parsed = {'joy_modes': ['hedonic']}
    out = filter_to_canonical(parsed, canonical)
    assert out['tensions'] == [] and out['functional_jobs'] == [] and out['occasions'] == []
    # Wrong type (string instead of list) → []
    parsed2 = {'joy_modes': 'hedonic', 'tensions': [], 'functional_jobs': [], 'occasions': []}
    out2 = filter_to_canonical(parsed2, canonical)
    assert out2['joy_modes'] == []
    # Non-dict input → all []
    out3 = filter_to_canonical('not a dict', canonical)  # type: ignore[arg-type]
    assert all(v == [] for v in out3.values())
    print('  PASS filter_to_canonical handles missing keys and wrong types')


def test_canonical_keys_shape():
    c = canonical_keys(FAKE_FRAMEWORKS)
    assert set(c.keys()) == {'joy_modes', 'tensions', 'functional_jobs', 'occasions'}
    assert 'hedonic' in c['joy_modes']
    assert 'luxury_vs_value' in c['tensions']
    assert 'share_experience' in c['functional_jobs']
    assert 'gathering' in c['occasions']
    print('  PASS canonical_keys returns the expected shape')


def test_batch_stats_cost_computation():
    s = BatchStats(n_total=2, n_success=2, total_input_tokens=2_000_000, total_output_tokens=400_000)
    # 2M input * $1/M = $2.00; 400K output * $5/M = $2.00 → total $4.00
    assert abs(s.est_cost_usd - 4.00) < 0.001
    print('  PASS BatchStats.est_cost_usd computes correctly')


def main():
    print('Running framework_tagger offline smoke tests...')
    tests = [v for k, v in globals().items() if k.startswith('test_') and callable(v)]
    failures = 0
    for t in tests:
        try:
            t()
        except AssertionError as e:
            print(f'  FAIL {t.__name__}: {e}')
            failures += 1
        except Exception as e:
            print(f'  ERROR {t.__name__}: {type(e).__name__}: {e}')
            failures += 1
    if failures:
        print(f'\n{failures} of {len(tests)} tests failed')
        sys.exit(1)
    print(f'\nAll {len(tests)} smoke tests passed.')


if __name__ == '__main__':
    main()
