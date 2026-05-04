#!/usr/bin/env python3
"""
ingest_wave.py — reusable monthly BJL wave ingestion tool.

Replaces the one-off load_april_respondents.py / load_april_responses.py
scripts referenced in the original April handoff. Each new monthly wave
becomes a single command per phase.

Usage:
  bin/ingest_wave.py --xlsx <path> --year-month <YYYY-MM> --phase <N>
                     --col-map <path/to/col_to_ids.json>
                     [--limit <N>] [--dry-run] [--out <output_dir>]

Phases:
  3 — load respondents from year_month rows (writes bjl_respondents)
  4 — load responses + verbatims (writes bjl_responses + bjl_verbatims)
  5 — framework Haiku scan on this wave's verbatims (writes joy_modes etc.)
  6 — populate bjl_respondent_usage from screener-style questions
  7 — emit schema_doc.md update notes

Output: each phase emits SQL files under <out>/ that the operator applies
via Supabase MCP apply_migration. This keeps the script side-effect-free
and human-reviewable.

Required env: ANTHROPIC_API_KEY (for phase 5 only).
Required deps: pandas, openpyxl. (pip install pandas openpyxl)
"""

import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

import pandas as pd

# ---------------------------------------------------------------------------
# Demographic column mapping (April 2026; verify per wave)
# ---------------------------------------------------------------------------
DEMOG_COLS = {
    'response_id': 0,
    'date_submitted': 2,
    'longitude': 13,
    'latitude': 14,
    'country': 15,
    'city': 16,
    'state_region': 17,  # the canonical region/area
    'postal': 18,
    'state': 20,
    'age_text': 55,           # "18-26" / "27-42" etc.
    'children_under_18': 56,
    'income_bracket': 57,
    'employment_status': 58,
    'gender': 63,
    # 67-72 race/ethnicity multi-select; we'll inspect dynamically
}
RACE_RANGE = range(67, 73)
MARITAL_COL = 3679
CHILDREN_DUP_COL = 3678  # duplicate of 56; ignore

# ---------------------------------------------------------------------------
# Generation derivation from age band
# ---------------------------------------------------------------------------
def age_band_to_generation(band):
    """Maps age band text (e.g., '18 to 26', '27 to 42') to BJL generation."""
    if not band or pd.isna(band):
        return None
    s = str(band).strip()
    # Find the first integer in the string as the lower bound
    m = re.search(r'(\d+)', s)
    if not m:
        return None
    lo = int(m.group(1))
    if lo <= 26:   return 'Gen Z'
    if lo <= 42:   return 'Millennial'
    if lo <= 58:   return 'Gen X'
    if lo <= 77:   return 'Boomer'
    return 'Silent'

def normalize_age_band(band):
    """Normalize the age field to a canonical band like '27 to 29'.
       The April spreadsheet uses ranges; normalize whitespace."""
    if not band or pd.isna(band):
        return None
    s = str(band).strip()
    # Sometimes the spreadsheet has "18 to 24" or "18-24"; normalize to "to" form
    s = re.sub(r'\s*-\s*', ' to ', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s

# ---------------------------------------------------------------------------
# Region from state (US Census)
# ---------------------------------------------------------------------------
NORTHEAST = {'CT','ME','MA','NH','NJ','NY','PA','RI','VT'}
MIDWEST = {'IL','IN','IA','KS','MI','MN','MO','NE','ND','OH','SD','WI'}
SOUTH = {'AL','AR','DE','FL','GA','KY','LA','MD','MS','NC','OK','SC','TN','TX','VA','WV','DC'}
WEST = {'AK','AZ','CA','CO','HI','ID','MT','NV','NM','OR','UT','WA','WY'}

STATE_NAMES_TO_CODE = {
    'ALABAMA':'AL','ALASKA':'AK','ARIZONA':'AZ','ARKANSAS':'AR','CALIFORNIA':'CA',
    'COLORADO':'CO','CONNECTICUT':'CT','DELAWARE':'DE','FLORIDA':'FL','GEORGIA':'GA',
    'HAWAII':'HI','IDAHO':'ID','ILLINOIS':'IL','INDIANA':'IN','IOWA':'IA',
    'KANSAS':'KS','KENTUCKY':'KY','LOUISIANA':'LA','MAINE':'ME','MARYLAND':'MD',
    'MASSACHUSETTS':'MA','MICHIGAN':'MI','MINNESOTA':'MN','MISSISSIPPI':'MS','MISSOURI':'MO',
    'MONTANA':'MT','NEBRASKA':'NE','NEVADA':'NV','NEW HAMPSHIRE':'NH','NEW JERSEY':'NJ',
    'NEW MEXICO':'NM','NEW YORK':'NY','NORTH CAROLINA':'NC','NORTH DAKOTA':'ND','OHIO':'OH',
    'OKLAHOMA':'OK','OREGON':'OR','PENNSYLVANIA':'PA','RHODE ISLAND':'RI','SOUTH CAROLINA':'SC',
    'SOUTH DAKOTA':'SD','TENNESSEE':'TN','TEXAS':'TX','UTAH':'UT','VERMONT':'VT',
    'VIRGINIA':'VA','WASHINGTON':'WA','WEST VIRGINIA':'WV','WISCONSIN':'WI','WYOMING':'WY',
    'DISTRICT OF COLUMBIA':'DC',
}

def state_to_region(state_text):
    if not state_text or pd.isna(state_text):
        return None
    s = str(state_text).strip().upper()
    if len(s) > 2:
        s = STATE_NAMES_TO_CODE.get(s, s[:2])
    if s in NORTHEAST: return 'Northeast'
    if s in MIDWEST:   return 'Midwest'
    if s in SOUTH:     return 'South'
    if s in WEST:      return 'West'
    return None

# ---------------------------------------------------------------------------
# Parental status from "children under 18 living with you" text
# ---------------------------------------------------------------------------
def parental_status_from_text(t):
    if not t or pd.isna(t):
        return 'Unknown'
    s = str(t).strip().lower()
    # patterns: "0", "none", "no children", "1", "2", "3 or more"
    if any(k in s for k in ['none', 'no child', '0', 'do not have']):
        return 'Non-parent'
    if re.search(r'[1-9]', s):
        return 'Parent'
    return 'Unknown'

def normalize_children_text(t):
    if not t or pd.isna(t):
        return None
    return str(t).strip()

# ---------------------------------------------------------------------------
# Income bracket validation
# ---------------------------------------------------------------------------
CANONICAL_INCOME_BRACKETS = {
    'Less than $25,000', '$25,000 to $34,999', '$35,000 to $49,999',
    '$50,000 to $74,999', '$75,000 to $99,999', '$100,000 to $124,999',
    '$125,000 to $149,999', '$150,000 to $199,999', '$200,000 or more',
}
def normalize_income(text):
    if not text or pd.isna(text):
        return None
    s = str(text).strip()
    if s in CANONICAL_INCOME_BRACKETS:
        return s
    return None  # caller decides what to do with unrecognized

# ---------------------------------------------------------------------------
# Race columns: detect header→column mapping at runtime
# ---------------------------------------------------------------------------
RACE_HEADER_TO_DB = {
    'american indian': 'race_american_indian',
    'native american': 'race_american_indian',
    'asian': 'race_asian',
    'black': 'race_black',
    'african american': 'race_black',
    'hispanic': 'race_hispanic',
    'latino': 'race_hispanic',
    'middle eastern': 'race_middle_eastern',
    'pacific islander': 'race_pacific_islander',
    'native hawaiian': 'race_pacific_islander',
    'white': 'race_white',
}

def detect_race_columns(header_row):
    """Walk cols 60..90 in the header row. Match each header against the
    race patterns. Return a list of (col_idx, db_column_name).

    Critical: the race multi-select columns have headers in the form
    'RACE_LABEL:What is your race and/or ethnicity?...' — we filter on
    the second half being the canonical race-question text so we don't
    pick up adjacent demographic columns like the Hispanic origin
    single-select that uses different wording."""
    RACE_QUESTION_MARKER = 'what is your race and/or ethnicity'
    out = []
    seen_db_cols = set()
    for ci in range(60, 90):
        h = header_row[ci] if ci < len(header_row) else None
        if not h or pd.isna(h):
            continue
        h_low = str(h).lower()
        if RACE_QUESTION_MARKER not in h_low:
            continue
        # Item label is the part before the colon
        label = h_low.split(':', 1)[0]
        for pattern, db_col in RACE_HEADER_TO_DB.items():
            if pattern in label and db_col not in seen_db_cols:
                out.append((ci, db_col))
                seen_db_cols.add(db_col)
                break
    return out


HISPANIC_ORIGIN_COL = 65  # 'Are you of Hispanic, Latino, or Spanish origin?'

# ---------------------------------------------------------------------------
# Response value parsing (per question_type)
# ---------------------------------------------------------------------------
def parse_response_value(raw_value, question_type):
    """Returns (raw_value_str, numeric_value, joy_index, is_selected).

    question_type values from the inventory/inferred_type:
      joy_scale_0_to_5, importance_scale_0_to_5, description_scale_0_to_5,
      single_select, multi_select, open_end, mixed

    Plus older types in the legacy bjl_questions_v2:
      joy_scale, momentum, agreement_scale, etc.
    """
    if raw_value is None or (isinstance(raw_value, float) and pd.isna(raw_value)):
        return None, None, None, None
    rv = str(raw_value).strip()
    if not rv:
        return None, None, None, None

    numeric = None
    joy_index = None
    is_selected = None

    if question_type in ('joy_scale_0_to_5', 'importance_scale_0_to_5', 'description_scale_0_to_5'):
        # Cell looks like "4" or "5 = Maximum Joy" — parse leading int
        m = re.match(r'^\s*(-?\d+)', rv)
        if m:
            numeric = int(m.group(1))
            if question_type == 'joy_scale_0_to_5':
                joy_index = numeric * 20  # 0..5 → 0..100
    elif question_type == 'joy_scale':
        # Legacy 5..-3 scale: cell looks like "5 (Maximum Joy!)" or "-3"
        m = re.match(r'^\s*(-?\d+)', rv)
        if m:
            numeric = int(m.group(1))
            joy_index = numeric * 20  # -3..5 → -60..100
    elif question_type == 'momentum':
        # "More than usual" / "About the same" / "Less than usual" → +1/0/-1
        s_low = rv.lower()
        if 'more' in s_low and 'less' not in s_low:
            numeric = 1
        elif 'less' in s_low and 'more' not in s_low:
            numeric = -1
        elif 'about the same' in s_low or 'same' in s_low:
            numeric = 0
    elif question_type in ('multi_select', 'select_all'):
        # Both terms describe the same shape. Each item gets its own column;
        # cell = item text if selected, blank if not. Non-empty = selected.
        # 'multi_select' is the April-2026 convention; 'select_all' is the
        # legacy term used on questions 1-415.
        is_selected = True
    # else: single_select, open_end, mixed, *_scale (likelihood/agreement/
    # familiarity/frequency/importance — text-valued scales without numeric
    # parsing rules), unknown → leave numeric/joy_index/is_selected as None.

    return rv, numeric, joy_index, is_selected


# ---------------------------------------------------------------------------
# SQL helpers
# ---------------------------------------------------------------------------
def sql_escape(s):
    if s is None:
        return 'NULL'
    if isinstance(s, bool):
        return 'true' if s else 'false'
    if isinstance(s, (int, float)):
        return str(s)
    return "'" + str(s).replace("'", "''") + "'"

def sql_array(arr):
    if not arr:
        return "ARRAY[]::text[]"
    return "ARRAY[" + ", ".join(sql_escape(x) for x in arr) + "]::text[]"

# ---------------------------------------------------------------------------
# Phase 3: respondents
# ---------------------------------------------------------------------------
def phase_3(df, year_month, fielding_id, max_resp_id, out_path):
    """Generate INSERT SQL for new respondents in this wave."""
    date_col = df.iloc[:, DEMOG_COLS['date_submitted']]
    target_mask = date_col.astype(str).str.startswith(year_month)
    rows = df[target_mask]
    print(f"[phase 3] {len(rows)} rows for {year_month}", flush=True)

    race_cols = detect_race_columns(df.iloc[0].tolist())
    print(f"[phase 3] detected {len(race_cols)} race/ethnicity cols: " +
          ", ".join(f"{ci}->{name}" for ci, name in race_cols))

    next_id = max_resp_id + 1
    inserts = []
    income_misses = Counter()
    for _, row in rows.iterrows():
        resp_id = str(next_id)
        next_id += 1

        date_submitted = str(row.iloc[DEMOG_COLS['date_submitted']])
        gen = age_band_to_generation(row.iloc[DEMOG_COLS['age_text']])
        age_band = normalize_age_band(row.iloc[DEMOG_COLS['age_text']])
        gender = row.iloc[DEMOG_COLS['gender']] if pd.notna(row.iloc[DEMOG_COLS['gender']]) else None
        income_raw = row.iloc[DEMOG_COLS['income_bracket']]
        income = normalize_income(income_raw)
        if income_raw and not income and pd.notna(income_raw):
            income_misses[str(income_raw).strip()] += 1
        state = row.iloc[DEMOG_COLS['state']] if pd.notna(row.iloc[DEMOG_COLS['state']]) else None
        region = state_to_region(state) or (
            row.iloc[DEMOG_COLS['state_region']] if pd.notna(row.iloc[DEMOG_COLS['state_region']]) else None
        )
        city = row.iloc[DEMOG_COLS['city']] if pd.notna(row.iloc[DEMOG_COLS['city']]) else None
        postal = row.iloc[DEMOG_COLS['postal']] if pd.notna(row.iloc[DEMOG_COLS['postal']]) else None
        lat = row.iloc[DEMOG_COLS['latitude']] if pd.notna(row.iloc[DEMOG_COLS['latitude']]) else None
        lon = row.iloc[DEMOG_COLS['longitude']] if pd.notna(row.iloc[DEMOG_COLS['longitude']]) else None
        emp = row.iloc[DEMOG_COLS['employment_status']] if pd.notna(row.iloc[DEMOG_COLS['employment_status']]) else None
        children = normalize_children_text(row.iloc[DEMOG_COLS['children_under_18']])
        parental = parental_status_from_text(row.iloc[DEMOG_COLS['children_under_18']])
        marital = row.iloc[MARITAL_COL] if MARITAL_COL < len(row) and pd.notna(row.iloc[MARITAL_COL]) else None

        # Race columns: each is "X" or some non-empty text if selected
        race_flags = {db_col: False for _, db_col in race_cols}
        for ci, db_col in race_cols:
            v = row.iloc[ci]
            if pd.notna(v) and str(v).strip():
                race_flags[db_col] = True

        # Hispanic origin is a separate single-select column (col 65), distinct
        # from the race/ethnicity multi-select battery.
        hispanic_origin = (row.iloc[HISPANIC_ORIGIN_COL]
                           if HISPANIC_ORIGIN_COL < len(row) and pd.notna(row.iloc[HISPANIC_ORIGIN_COL])
                           else None)

        # Build the insert row tuple
        cols = ['respondent_id','fielding_id','year_month','date_submitted',
                'age_band','generation','gender','income_bracket','state','region',
                'city','postal','latitude','longitude','employment_status',
                'children_under_18','parental_status','marital_status','hispanic_origin']
        vals = [resp_id, fielding_id, year_month, date_submitted,
                age_band, gen, gender, income, state, region, city, postal,
                float(lat) if lat else None, float(lon) if lon else None,
                emp, children, parental, marital, hispanic_origin]
        # Race flags
        for db_col in ['race_american_indian','race_asian','race_black','race_hispanic',
                       'race_middle_eastern','race_pacific_islander','race_white']:
            cols.append(db_col)
            vals.append(race_flags.get(db_col, False))

        values_sql = ", ".join(sql_escape(v) for v in vals)
        inserts.append(f"  ({values_sql})")

    if income_misses:
        print(f"[phase 3] WARNING: {sum(income_misses.values())} respondents had unrecognized income bracket:")
        for v, n in income_misses.most_common(5):
            print(f"           {n}× {v!r}")

    cols_sql = ", ".join(cols)
    sql = (
        f"-- Phase 3: insert {len(inserts)} respondents for {year_month}\n"
        f"INSERT INTO bjl_respondents ({cols_sql}) VALUES\n"
        + ",\n".join(inserts) + ";\n"
    )

    out_file = Path(out_path) / f"{year_month}_phase3_respondents.sql"
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(sql)
    print(f"[phase 3] wrote {out_file} ({len(sql):,} bytes, {len(inserts)} rows)")
    return out_file


# ---------------------------------------------------------------------------
# Phase 4: responses + verbatims
# ---------------------------------------------------------------------------
def phase_4(df, year_month, fielding_id, col_to_ids, max_resp_id, max_verbatim_id,
            question_types, out_path, batch_size=10000):
    """Generate response + verbatim INSERT SQL chunks for this wave."""
    date_col = df.iloc[:, DEMOG_COLS['date_submitted']]
    target_mask = date_col.astype(str).str.startswith(year_month)
    rows = df[target_mask]
    print(f"[phase 4] processing {len(rows)} respondents × {len(col_to_ids)} cols")

    next_resp_id = max_resp_id + 1
    next_verb_id = max_verbatim_id + 1

    response_rows = []
    verbatim_rows = []
    skipped_no_qtype = 0

    for resp_idx, (_, row) in enumerate(rows.iterrows()):
        resp_id = str(next_resp_id + resp_idx)
        date_submitted = str(row.iloc[DEMOG_COLS['date_submitted']])
        # demographic context for verbatims
        gen = age_band_to_generation(row.iloc[DEMOG_COLS['age_text']])
        gender = row.iloc[DEMOG_COLS['gender']] if pd.notna(row.iloc[DEMOG_COLS['gender']]) else None
        income = normalize_income(row.iloc[DEMOG_COLS['income_bracket']])
        state = row.iloc[DEMOG_COLS['state']] if pd.notna(row.iloc[DEMOG_COLS['state']]) else None
        region = state_to_region(state)
        children_raw = row.iloc[DEMOG_COLS['children_under_18']]
        parental = parental_status_from_text(children_raw)

        for col_idx_str, ids in col_to_ids.items():
            ci = int(col_idx_str)
            if ci >= len(row):
                continue
            cell = row.iloc[ci]
            if cell is None or (isinstance(cell, float) and pd.isna(cell)) or not str(cell).strip():
                continue

            qid = ids['question_id']
            iid = ids['item_id']
            qtype = question_types.get(qid)
            if not qtype:
                skipped_no_qtype += 1
                continue

            raw, numeric, joy_index, is_selected = parse_response_value(cell, qtype)
            if raw is None:
                continue

            # Build the response row
            response_rows.append((resp_id, qid, iid, ids.get('item_name'),
                                   raw, numeric, joy_index, is_selected,
                                   fielding_id, year_month))

            # If open_end, also create a verbatim
            if qtype == 'open_end':
                verbatim_rows.append((resp_id, qid, iid, raw, gen, gender, income, region, parental,
                                       fielding_id, year_month, next_verb_id))
                next_verb_id += 1

    print(f"[phase 4] {len(response_rows):,} response rows, {len(verbatim_rows):,} verbatim rows")
    if skipped_no_qtype:
        print(f"[phase 4] WARNING: {skipped_no_qtype} cells skipped (no question_type for question_id)")

    # Write response SQL in chunks (batch_size rows per file)
    out_files = []
    for chunk_idx in range(0, len(response_rows), batch_size):
        chunk = response_rows[chunk_idx:chunk_idx + batch_size]
        rows_sql = []
        for (rid, qid, iid, iname, raw, num, ji, sel, fid, ym) in chunk:
            rows_sql.append(
                f"  ({sql_escape(rid)}, {qid}, {iid}, "
                f"{sql_escape(raw)}, "
                f"{sql_escape(num) if num is not None else 'NULL'}, "
                f"{sql_escape(ji) if ji is not None else 'NULL'}, "
                f"{sql_escape(sel) if sel is not None else 'NULL'}, "
                f"{sql_escape(fid)}, {sql_escape(ym)})"
            )
        chunk_sql = (
            f"-- Phase 4: bjl_responses chunk {chunk_idx//batch_size + 1} of {(len(response_rows)+batch_size-1)//batch_size}\n"
            f"INSERT INTO bjl_responses (respondent_id, question_id, item_id, "
            f"raw_value, numeric_value, joy_index, is_selected, fielding_id, year_month) VALUES\n"
            + ",\n".join(rows_sql) + ";\n"
        )
        out_file = Path(out_path) / f"{year_month}_phase4_responses_{chunk_idx//batch_size:03d}.sql"
        out_file.write_text(chunk_sql)
        out_files.append(out_file)

    if verbatim_rows:
        rows_sql = []
        for (rid, qid, iid, txt, gen, gnd, inc, reg, par, fid, ym, vid) in verbatim_rows:
            rows_sql.append(
                f"  ({sql_escape(rid)}, {qid}, {iid}, {sql_escape(txt)}, "
                f"{sql_escape(gen)}, {sql_escape(gnd)}, {sql_escape(inc)}, {sql_escape(reg)}, {sql_escape(par)}, "
                f"{sql_escape(fid)}, {sql_escape(ym)})"
            )
        verb_sql = (
            f"-- Phase 4: bjl_verbatims for {year_month}\n"
            f"INSERT INTO bjl_verbatims (respondent_id, question_id, item_id, response_text, "
            f"generation, gender, income_bracket, region, parental_status, fielding_id, year_month) VALUES\n"
            + ",\n".join(rows_sql) + ";\n"
        )
        verb_file = Path(out_path) / f"{year_month}_phase4_verbatims.sql"
        verb_file.write_text(verb_sql)
        out_files.append(verb_file)

    print(f"[phase 4] wrote {len(out_files)} SQL files to {out_path}")
    for f in out_files:
        print(f"           {f.name} ({f.stat().st_size:,} bytes)")
    return out_files


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--xlsx', required=True)
    ap.add_argument('--year-month', required=True, help='YYYY-MM')
    ap.add_argument('--phase', required=True, choices=['3', '4'], help='Phase number')
    ap.add_argument('--col-map', help='Path to col_idx -> {question_id, item_id} JSON')
    ap.add_argument('--max-resp-id', type=int, required=True, help='Current max respondent_id (numeric)')
    ap.add_argument('--max-verbatim-id', type=int, default=0, help='Current max verbatim id (for phase 4)')
    ap.add_argument('--out', default='out/', help='Output directory for SQL files')
    args = ap.parse_args()

    fielding_id = 'm_' + args.year_month.replace('-', '_')
    print(f"=== ingest_wave.py ===")
    print(f"  xlsx:        {args.xlsx}")
    print(f"  year_month:  {args.year_month}")
    print(f"  fielding_id: {fielding_id}")
    print(f"  phase:       {args.phase}")
    print()

    print(f"loading Excel ({Path(args.xlsx).stat().st_size:,} bytes)...", flush=True)
    df = pd.read_excel(args.xlsx, header=None, dtype=str)
    print(f"  {df.shape[0]:,} rows × {df.shape[1]:,} cols")

    if args.phase == '3':
        phase_3(df, args.year_month, fielding_id, args.max_resp_id, args.out)
    elif args.phase == '4':
        if not args.col_map:
            sys.exit('--col-map required for phase 4')
        col_map = json.load(open(args.col_map))
        # Build question_id -> question_type lookup from local data files. The
        # caller can also pass it pre-built; for April we read from
        # data/april_question_types.json if present, else default rules apply.
        qtypes_file = Path('data/question_types_lookup.json')
        if qtypes_file.exists():
            question_types = {int(k): v for k, v in json.load(qtypes_file.open()).items()}
        else:
            sys.exit('Need data/question_types_lookup.json — run query against bjl_questions_v2 to build')
        phase_4(df, args.year_month, fielding_id, col_map, args.max_resp_id,
                args.max_verbatim_id, question_types, args.out)


if __name__ == '__main__':
    main()
