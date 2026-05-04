#!/usr/bin/env python3
"""
Smoke test for bin/ingest_wave.py — constructs a tiny mock DataFrame and
verifies the SQL output contains expected fragments. Not exhaustive; the
goal is to catch obvious regressions on the helpers (parse_response_value,
age_band_to_generation, state_to_region, sql_escape, etc.).

Run: python3 bin/test_ingest_wave.py

Exits 0 on pass, non-zero with a descriptive message on failure.
"""

import sys
from pathlib import Path

# Make sibling module importable
sys.path.insert(0, str(Path(__file__).parent))
from ingest_wave import (  # noqa: E402
    parse_response_value, age_band_to_generation, normalize_age_band,
    state_to_region, parental_status_from_text, normalize_income,
    sql_escape, sql_array, detect_race_columns,
)


def test_age_band_to_generation():
    assert age_band_to_generation('18 to 26') == 'Gen Z'
    assert age_band_to_generation('27 to 42') == 'Millennial'
    assert age_band_to_generation('43 to 58') == 'Gen X'
    assert age_band_to_generation('59 to 77') == 'Boomer'
    assert age_band_to_generation('80 to 89') == 'Silent'
    assert age_band_to_generation(None) is None
    assert age_band_to_generation('') is None
    print('  PASS age_band_to_generation')


def test_normalize_age_band():
    assert normalize_age_band('27 to 29') == '27 to 29'
    assert normalize_age_band('27-29') == '27 to 29'  # hyphen normalized
    assert normalize_age_band('  27  to  29  ') == '27 to 29'  # whitespace
    assert normalize_age_band(None) is None
    print('  PASS normalize_age_band')


def test_state_to_region():
    assert state_to_region('CA') == 'West'
    assert state_to_region('California') == 'West'
    assert state_to_region('NY') == 'Northeast'
    assert state_to_region('New York') == 'Northeast'
    assert state_to_region('TX') == 'South'
    assert state_to_region('Illinois') == 'Midwest'
    assert state_to_region(None) is None
    assert state_to_region('') is None
    print('  PASS state_to_region')


def test_parental_status_from_text():
    assert parental_status_from_text('2') == 'Parent'
    assert parental_status_from_text('1 child') == 'Parent'
    assert parental_status_from_text('None') == 'Non-parent'
    assert parental_status_from_text('0') == 'Non-parent'
    assert parental_status_from_text('No children at home') == 'Non-parent'
    assert parental_status_from_text(None) == 'Unknown'
    assert parental_status_from_text('') == 'Unknown'
    print('  PASS parental_status_from_text')


def test_normalize_income():
    assert normalize_income('$50,000 to $74,999') == '$50,000 to $74,999'
    assert normalize_income('$200,000 or more') == '$200,000 or more'
    assert normalize_income('Less than $25,000') == 'Less than $25,000'
    assert normalize_income('$50K-75K') is None  # non-canonical form rejected
    assert normalize_income(None) is None
    print('  PASS normalize_income')


def test_parse_response_value_joy_scale_0_to_5():
    # April-style 0-5 joy: numeric × 20 → 0..100
    raw, num, ji, sel = parse_response_value('4', 'joy_scale_0_to_5')
    assert raw == '4' and num == 4 and ji == 80 and sel is None
    raw, num, ji, sel = parse_response_value('5 = Maximum Joy', 'joy_scale_0_to_5')
    assert raw == '5 = Maximum Joy' and num == 5 and ji == 100
    raw, num, ji, sel = parse_response_value('0 = No joy at all', 'joy_scale_0_to_5')
    assert raw and num == 0 and ji == 0
    print('  PASS parse_response_value joy_scale_0_to_5')


def test_parse_response_value_legacy_joy_scale():
    # Legacy 5..-3 joy: numeric × 20 → -60..100
    raw, num, ji, sel = parse_response_value('5 (Maximum Joy!)', 'joy_scale')
    assert num == 5 and ji == 100
    raw, num, ji, sel = parse_response_value('-3', 'joy_scale')
    assert num == -3 and ji == -60
    raw, num, ji, sel = parse_response_value('0', 'joy_scale')
    assert num == 0 and ji == 0
    print('  PASS parse_response_value legacy joy_scale')


def test_parse_response_value_importance_no_joy_index():
    # importance_scale_0_to_5: parse numeric, but joy_index stays NULL
    # (importance is not joy)
    raw, num, ji, sel = parse_response_value('4', 'importance_scale_0_to_5')
    assert num == 4 and ji is None
    raw, num, ji, sel = parse_response_value('description_scale_0_to_5 sample 3',
                                              'description_scale_0_to_5')
    # Cell value here is non-canonical — but we still expect ji=None
    assert ji is None
    print('  PASS parse_response_value importance/description (no joy_index)')


def test_parse_response_value_multi_select():
    # multi_select / select_all: non-empty cell → is_selected=True
    raw, num, ji, sel = parse_response_value('A national bank', 'multi_select')
    assert raw == 'A national bank' and sel is True and num is None and ji is None
    raw, num, ji, sel = parse_response_value('Some option', 'select_all')  # legacy alias
    assert sel is True
    print('  PASS parse_response_value multi_select / select_all')


def test_parse_response_value_null_inputs():
    raw, num, ji, sel = parse_response_value(None, 'joy_scale_0_to_5')
    assert raw is None and num is None and ji is None and sel is None
    raw, num, ji, sel = parse_response_value('', 'multi_select')
    assert raw is None
    raw, num, ji, sel = parse_response_value('   ', 'single_select')
    assert raw is None
    print('  PASS parse_response_value null/empty inputs')


def test_sql_escape():
    assert sql_escape(None) == 'NULL'
    assert sql_escape("simple") == "'simple'"
    assert sql_escape("can't stop") == "'can''t stop'"  # single quote escaped
    assert sql_escape(42) == '42'
    assert sql_escape(True) == 'true'
    assert sql_escape(False) == 'false'
    assert sql_escape(3.14) == '3.14'
    print('  PASS sql_escape')


def test_sql_array():
    assert sql_array([]) == 'ARRAY[]::text[]'
    assert sql_array(None) == 'ARRAY[]::text[]'
    assert sql_array(['a', 'b']) == "ARRAY['a', 'b']::text[]"
    assert sql_array(["it's"]) == "ARRAY['it''s']::text[]"
    print('  PASS sql_array')


def test_detect_race_columns_ignores_hispanic_origin():
    # Mock header row matching the April spreadsheet pattern around col 65-72.
    # Col 65 is 'Are you of Hispanic, Latino, or Spanish origin?' — must NOT
    # be detected as a race-multi-select column even though it contains
    # 'Hispanic'. Col 69 IS the Hispanic-or-Latino race option and SHOULD
    # be detected.
    header = [None] * 90
    header[65] = 'Are you of Hispanic, Latino, or Spanish origin?'
    header[66] = 'American Indian or Alaska Native:What is your race and/or ethnicity? Please select all that apply.'
    header[67] = 'Asian:What is your race and/or ethnicity? Please select all that apply.'
    header[68] = 'Black or African American:What is your race and/or ethnicity? Please select all that apply.'
    header[69] = 'Hispanic or Latino:What is your race and/or ethnicity? Please select all that apply.'
    header[70] = 'Middle Eastern or North African:What is your race and/or ethnicity? Please select all that apply.'
    header[71] = 'Native Hawaiian or Pacific Islander:What is your race and/or ethnicity? Please select all that apply.'
    header[72] = 'White:What is your race and/or ethnicity? Please select all that apply.'
    detected = detect_race_columns(header)
    cols = [ci for ci, _ in detected]
    assert 65 not in cols, f'col 65 (Hispanic origin question) should be excluded from race detection: got {detected}'
    assert 69 in cols, f'col 69 (Hispanic/Latino race option) should be detected: got {detected}'
    assert len(detected) == 7, f'expected 7 race cols, got {len(detected)}: {detected}'
    print('  PASS detect_race_columns (hispanic origin separation)')


def main():
    print('Running ingest_wave smoke tests...')
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
