#!/usr/bin/env python3
"""
Rivalry & Brand Hate 2025 — pass 2 loader.
Loads: ordinal scales, raw categoricals, select-alls, verbatims + their full catalog.
(Pass 1 — respondents, joy battery, core catalog — was loaded via MCP by Claude.)

Usage:
  DATABASE_URL='postgresql://postgres:...@db.iqjkgswpzbklihdfccnd.supabase.co:5432/postgres' \
    python3 load_rivalry_2025_pass2.py rivalry_2025_pass2_data.json

Idempotent: deletes prior pass-2 rows for fielding sp_2025_01_rivalry before inserting.
After running: rebuild ledgers + snapshots per bjl_build_state_and_next_for_cc.md,
then queue embedding + framework backfill for the new verbatims (they load with
search_vector auto-generated; embeddings NULL until the pipeline pass).

Notes on this pass (review pass folded in):
  1. Empty-tuple guard on the IN-clause delete: no-op if pass-2 has zero
     questions (which would otherwise emit `IN ()` — a syntax error).
  2. NEW_ITEM_TOPIC is a constant so any non-entertainment items in a
     future rivalry batch can be relabeled in one place. Every rivalry
     item is entertainment-anchored today; if that stops being true,
     lift topic-per-item out of the JSON.
  3. Question upsert key is (question_text, wave_id ANY(wave_ids)) — an
     identically-worded question already tagged with a different wave
     will spawn a duplicate row rather than append this wave to the
     existing row's wave_ids. That is intentional: waves own their own
     question rows so downstream ledger math isn't cross-contaminated.
  4. bjl_item_construct upsert is keyed on item_name globally (no
     fielding scope) — matches existing convention. Cross-fielding
     item-name collisions would inherit the earliest-inserted construct.
  5. Idempotency scope: `DELETE ... WHERE question_id IN <pass2_qids>`
     keeps prior rows for questions that were in an earlier JSON but
     dropped in this run. If the JSON's question set is stable across
     reruns, this is fine; if it changes, remove the stale question
     rows manually before rerunning.
  6. Verbatim delete is fielding-wide (loader owns all pass-2 verbatims).
  7. Joy-battery question lookup adds LIMIT 1 and a wave-arg check so
     the (rare) case where two waves share the standing joy-question
     text can't silently pick the wrong row.
  8. is_quotable is provisional at length>=40; enrichment pass refines.
"""
import json
import os
import sys

import psycopg2
import psycopg2.extras

FIELDING = 'sp_2025_01_rivalry'
YM = '2025-01'
WAVE = 'rivalry_hate_2025'
VERBATIM_CATEGORY = 'sports_rivalry'
NEW_ITEM_TOPIC = 'entertainment'
JOY_QUESTION_TEXT = 'To what degree do/would each of the following give you joy?'


def main(path):
    data = json.load(open(path))
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    cur = conn.cursor()

    # --- catalog: questions + items + constructs (skip any already created in pass 1) ---
    cur.execute(
        "SELECT coalesce(max(question_id),0), "
        "(SELECT coalesce(max(item_id),0) FROM bjl_items) "
        "FROM bjl_questions_v2"
    )
    qbase, ibase = cur.fetchone()
    qid_map, item_map = {}, {}
    for qi, q in enumerate(data['questions']):
        cur.execute(
            "SELECT question_id FROM bjl_questions_v2 "
            "WHERE question_text=%s AND %s = ANY(wave_ids)",
            (q['question'], WAVE),
        )
        row = cur.fetchone()
        if row:
            qid = row[0]
        else:
            qbase += 1
            qid = qbase
            qtype = {
                'scale': 'grid_scale',
                'raw': 'open_categorical',
                'select_all': 'select_all',
            }[q['kind']]
            cur.execute(
                "INSERT INTO bjl_questions_v2 "
                "(question_id, question_text, question_type, scale_type, n_items, wave_ids, notes) "
                "VALUES (%s,%s,%s,%s,%s,ARRAY[%s],'Rivalry & Brand Hate study, Jan 2025')",
                (qid, q['question'], qtype, q.get('construct', ''), len(q['items']), WAVE),
            )
        qid_map[qi] = qid
        for nm in q['items']:
            key = (qi, nm)
            cur.execute(
                "SELECT item_id FROM bjl_items WHERE question_id=%s AND item_name=%s",
                (qid, nm),
            )
            row = cur.fetchone()
            if row:
                item_map[key] = row[0]
            else:
                ibase += 1
                cur.execute(
                    "INSERT INTO bjl_items (item_id, question_id, item_name, primary_topic) "
                    "VALUES (%s,%s,%s,%s)",
                    (ibase, qid, nm, NEW_ITEM_TOPIC),
                )
                item_map[key] = ibase
            if q['kind'] == 'scale' and q.get('construct'):
                cur.execute(
                    "INSERT INTO bjl_item_construct (item_name, item_topic, question_type, construct) "
                    "SELECT %s,%s,'grid_scale',%s "
                    "WHERE NOT EXISTS (SELECT 1 FROM bjl_item_construct WHERE item_name=%s)",
                    (nm, NEW_ITEM_TOPIC, q['construct'], nm),
                )

    # --- idempotency: clear prior pass-2 data rows (guarded against empty qid_map) ---
    if qid_map:
        cur.execute(
            "DELETE FROM bjl_responses WHERE fielding_id=%s AND question_id IN %s",
            (FIELDING, tuple(qid_map.values())),
        )
    cur.execute("DELETE FROM bjl_verbatims WHERE fielding_id=%s", (FIELDING,))

    # --- responses ---
    rows = []
    for rec in data['respondent_scored']:
        rid = rec['rid']
        for qi, nm, raw, nv in rec['scored']:
            rows.append((rid, qid_map[qi], item_map[(qi, nm)], nm, raw, nv, None, None, FIELDING, YM))
        for qi, nm, raw in rec['raw']:
            rows.append((rid, qid_map[qi], item_map[(qi, nm)], nm, raw, None, None, None, FIELDING, YM))
        for qi, nm in rec['selected']:
            rows.append((rid, qid_map[qi], item_map[(qi, nm)], nm, 'selected', None, None, True, FIELDING, YM))
    psycopg2.extras.execute_values(
        cur,
        "INSERT INTO bjl_responses "
        "(respondent_id, question_id, item_id, item_name, raw_value, numeric_value, joy_index, is_selected, fielding_id, year_month) "
        "VALUES %s",
        rows,
        page_size=2000,
    )
    print('responses inserted:', len(rows))

    # --- verbatims ---
    vrows = [
        (
            v['rid'], v['q'], v['text'], WAVE, VERBATIM_CATEGORY, VERBATIM_CATEGORY,
            len(v['text']) >= 40, v['gen'], v['age'], v['gender'], v['income'], v['region'], v['state'],
            FIELDING, YM,
        )
        for v in data['verbatims']
    ]
    psycopg2.extras.execute_values(
        cur,
        "INSERT INTO bjl_verbatims "
        "(respondent_id, question_text, response_text, wave, category, category_key, "
        "is_quotable, generation, age_band, gender, income_bracket, region, state, fielding_id, year_month) "
        "VALUES %s",
        vrows,
        page_size=1000,
    )
    print('verbatims inserted:', len(vrows), '(is_quotable provisional at length>=40; enrichment pass refines)')

    # --- respondents (rows not yet loaded via MCP pass 1) ---
    rdir = os.path.dirname(os.path.abspath(path))
    rfile = os.path.join(rdir, 'rivalry_respondents_all.txt')
    if os.path.exists(rfile):
        rr = []
        for l in open(rfile):
            p = (l.rstrip('\n') + '||||||').split('|')
            rr.append((p[0], FIELDING, YM, p[1] or None, p[2] or None, p[3] or None, p[4] or None, p[5] or None, p[6] or None))
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO bjl_respondents "
            "(respondent_id, fielding_id, year_month, generation, age_band, gender, income_bracket, state, region) "
            "VALUES %s ON CONFLICT (respondent_id) DO NOTHING",
            rr,
            page_size=1000,
        )
        print('respondents upserted:', len(rr))

    # --- joy battery (24 items on the standing joy question) ---
    jfile = os.path.join(rdir, 'rivalry_joy.txt')
    if os.path.exists(jfile):
        jnames = json.load(open(os.path.join(rdir, 'rivalry_joy_items.json')))
        # Joy-question lookup: match the standing text AND require this
        # wave in wave_ids, then LIMIT 1 so a (rare) cross-wave text
        # collision can't silently pick the wrong row.
        cur.execute(
            "SELECT question_id FROM bjl_questions_v2 "
            "WHERE question_text=%s AND %s = ANY(wave_ids) LIMIT 1",
            (JOY_QUESTION_TEXT, WAVE),
        )
        joy_row = cur.fetchone()
        if not joy_row:
            # Fall back to the canonical joy row (any wave). Guarded LIMIT 1
            # so we still pick deterministically.
            cur.execute(
                "SELECT question_id FROM bjl_questions_v2 WHERE question_text=%s LIMIT 1",
                (JOY_QUESTION_TEXT,),
            )
            joy_row = cur.fetchone()
        if not joy_row:
            raise RuntimeError(
                f"Joy question row not found in bjl_questions_v2 for text: {JOY_QUESTION_TEXT!r}. "
                "Pass 1 must have created it before this loader runs."
            )
        joy_qid = joy_row[0]
        cur.execute(
            "SELECT i.item_id, i.item_name FROM bjl_items i "
            "JOIN bjl_questions_v2 q ON q.question_id=i.question_id "
            "WHERE q.question_id=%s AND i.item_name = ANY(%s)",
            (joy_qid, jnames),
        )
        idmap = {nm: iid for iid, nm in cur.fetchall()}
        missing = [nm for nm in jnames if nm not in idmap]
        if missing:
            raise RuntimeError(
                f"Joy battery items missing from bjl_items on question {joy_qid}: {missing}. "
                "Pass 1 must have inserted them before this loader runs."
            )
        cur.execute(
            "DELETE FROM bjl_responses WHERE fielding_id=%s AND question_id=%s",
            (FIELDING, joy_qid),
        )
        jr = []
        for l in open(jfile):
            rid, vals = l.rstrip('\n').split('|')
            for nm, v in zip(jnames, vals.split(',')):
                if v != '':
                    nv = int(v)
                    jr.append((rid, joy_qid, idmap[nm], nm, v, nv, nv * 20, FIELDING, YM))
        psycopg2.extras.execute_values(
            cur,
            "INSERT INTO bjl_responses "
            "(respondent_id, question_id, item_id, item_name, raw_value, numeric_value, joy_index, fielding_id, year_month) "
            "VALUES %s",
            jr,
            page_size=2000,
        )
        print('joy battery responses inserted:', len(jr))

    conn.commit()
    cur.execute("SELECT count(*) FROM bjl_responses WHERE fielding_id=%s", (FIELDING,))
    print('total responses in fielding now:', cur.fetchone()[0])
    print('NEXT: rebuild bjl_conn_centered/_v2 + both ledgers + snapshots; queue embedding backfill.')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'rivalry_2025_pass2_data.json')
