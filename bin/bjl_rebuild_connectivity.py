#!/usr/bin/env python3
"""
Rebuild the centered table and the connectivity ledger.

This is the routine STATE.md has referred to since 2026-07-25 as "the full
rebuild routine". It was never in version control. What follows was recovered
from the live data in August 2026 and is written down here so the next rebuild
is not another archaeology dig.

Usage:
  DATABASE_URL='postgresql://...' python3 bjl_rebuild_connectivity.py verify
  DATABASE_URL='postgresql://...' python3 bjl_rebuild_connectivity.py build

  verify  Rebuilds the LEGACY definition (per-scale-family centering) over
          PRE-DEDUP responses and checks it against the live ledger. This
          proves the recovered definition is the one that produced the live
          numbers. It writes nothing. Run it first; `build` refuses to run
          unless it passes.

  build   Rebuilds under the ruled definition — option (ii), whole-instrument
          centering — over CURRENT (post-dedup) responses, into _v3 tables.
          It does not touch v2. See "WHY _v3" below.

Requires: psycopg2. All work happens server-side; nothing large is pulled
into Python.


THE RECOVERED DEFINITION
------------------------

Universe.  bjl_item_spread is the item list and the scale_family assignment.
  1,229 items, and its (item_id, scale_family) agrees with the live
  bjl_conn_centered_v2 on all 1,229 — it is not a coincidence, it is the
  source.

Value.  Per family, in that family's native units:
    joy      -> bjl_responses.joy_index      (0-100, so sd of cz is ~40)
    other    -> bjl_responses.numeric_value  (Likert points, sd of cz ~0.7)
  bjl_anchor_map looks like it should be the value source for the non-joy
  families. It is not: joining it on (raw_value, scale_family) matches zero
  of 338,915 likelihood rows. numeric_value is the source.

Centering.  cz = value - the respondent's mean over the centering group.
  Mean-centered, NOT z-scored: the point scale is retained, only the mean is
  removed.

  The legacy centering group is the respondent x scale_family, where
  scale_family is bjl_item_spread's — the FINE, per-item taxonomy. There is
  a second, coarser one (bjl_question_family.family) whose 'likelihood'
  contains fine likelihood, trust and familiarity. Centering on the coarse
  one is wrong: it misses the anchor by 0.0012 (gives 0.3279, not 0.3291).
  See KNOWN RESIDUAL, which is where the coarse taxonomy earns its mention.

Ledger.  r = corr(a.cz, b.cz) over shared respondents, plain Pearson, nothing
  else. Undirected, stored once as item_a < item_b, kept where n_pair >= 31.


THE ANCHOR
----------

STATE.md's anchor is one pair, not an aggregate: items 1393 x 4856, n_pair 826,
r 0.3291. The legacy definition above reproduces it exactly from pre-dedup
data. `verify` asserts it and exits non-zero if it drifts.

V1 HAS BEEN OVERWRITTEN — this is a finding, not a footnote
-----------------------------------------------------------

STATE.md records two anchors for the same pair at the same n: v1 826 / 0.3279
and v2 826 / 0.3291. Both are real numbers. Only one of them still exists.

Live, every v1 artifact is an exact slice of v2:

  - bjl_conn_centered.cj is byte-identical to bjl_conn_centered_v2.cz
    restricted to scale_family = 'joy'. All 1,053,961 cells, max abs diff
    0.0000.
  - all 60,401 rows of bjl_connectivity_ledger appear in
    bjl_connectivity_ledger_v2 with identical n_pair and identical r, and
    every one is joy x joy.
  - both give 0.3291 for the anchor pair.

So v1 no longer reproduces its own documented anchor. Whatever computation
produced 0.3279 was overwritten — most likely by the 2026-07-25 rebuild
writing v2's joy slice over it — and STATE.md is the only surviving record
that it ever differed.

Circumstantial evidence for what v1 was: centering on the COARSE question
family instead of the fine one gives this pair exactly 826 / 0.3279. That is
suggestive, not proof, and it is not worth chasing — v1 has no consumer. What
matters is the integrity lesson, which is the same one Tier A taught today:
a stored table agreeing with itself is not evidence that it is what its
documentation says it is.


KNOWN RESIDUAL, stated rather than buried
-----------------------------------------

The joy path reproduces exactly — 826 / 0.3291 — and joy is 73% of centered
cells and 52% of ledger pairs. The non-joy path reproduces n_pair exactly but
r only to about +/-0.012:

    pair          live r    fine-family (used)   coarse-family
    3941 x 3942   0.2029    0.1919               0.2061
    3936 x 3942   0.4804    0.4680               0.4784
    3936 x 3941   0.1931    0.1793               0.1912

Coarse-family centering is closer on these three. It is nonetheless rejected,
because it misses the anchor, and the anchor is the one target STATE.md
actually commits to. Fitting the residual at the cost of the anchor would be
choosing the unverified target over the verified one.

What this means is that the non-joy centering group is somewhat WIDER than
the fine family but not as wide as the coarse one — probably it includes
responses to items that never made it into bjl_item_spread. That is unclosed.

It does not affect the ruling or the rebuild: under option (ii) the centering
group is the whole instrument and the fine/coarse question dissolves. It does
mean one thing for readers of the OLD ledger — a joy x joy row is
reproducible to four decimals, a non-joy row is not.


WHY _v3, AND NOT AN OVERWRITE
-----------------------------

v2 is currently the only surviving record of the numbers the trade-off map and
bulletin v1 were built on, including the two hand-corrected rows. Overwriting
it in place destroys the before side of the before/after this rebuild exists
to produce. So `build` writes bjl_conn_centered_v3 and
bjl_connectivity_ledger_v3, prints the diff, and stops. Promoting v3 over v2
is a separate, deliberate, human step.


WHAT CHANGES UNDER THE RULING
-----------------------------

(ii) as the generator. The centering group becomes the respondent's WHOLE
INSTRUMENT rather than one family. This removes response style — the reason
centering exists — without manufacturing the negative dependency that made
r = -1.000 arithmetically inevitable at k = 2.

Because families are on different native scales (joy 0-100, everything else
1-5), a raw whole-instrument mean would be dominated by joy. So under (ii)
each family's values are put on a common footing before the instrument mean
is taken: value is divided by that family's global sd, then the respondent's
mean across all their standardised values is removed. Pearson is scale
invariant, so this does not change any within-family r relative to (ii)
without the rescale; it makes the cross-family means meaningful instead of
arbitrary.

(i) as the reported metric. The floor has to be computed against the group
that was ACTUALLY centred, and under (ii) that group is the respondent's whole
instrument, not their scale_family. Computing -1/(k-1) from the per-family k
would describe the floor that applied under v2 and would be wrong here — a
first pass did exactly that and had to be corrected. The ledger gains five
columns, two of them explicitly legacy diagnostics:

    k_instr                 average instrument size (cells) of the shared
                            respondents. This is the (ii) centring group.
    floor_r                 the mechanical floor -1/(k_instr - 1). Applies to
                            every pair, same- and cross-family alike, because
                            under (ii) every pair is inside one centring group.
    excess_r                r - floor_r. THIS is the consumer-facing metric.

    k_mean_family_legacy    average per-family k of the shared respondents.
    floor_r_family_legacy   -1/(k_mean_family_legacy - 1), NULL cross-family.
                            Not a property of v3 at all. It is the floor these
                            pairs sat on under v2's per-family centring, kept
                            so a reader can see what each pair escaped and
                            which v2 rows were floor artefacts. Do not rank on
                            it.

Consumers rank and threshold on excess_r, not r. Under (ii) floor_r should be
near zero for everything, which is the point; the column stays because it is
the evidence that it is near zero rather than the assumption, and because it
is what catches a future fielding that reintroduces a small centring group.

The |r| >= 0.98 guard is kept as a TRIPWIRE, not as the fix. It halts the
build and names the offending pairs. It does not silently drop or clamp them.
"""
import os
import sys

import psycopg2

ANCHOR_ITEM_A = 1393
ANCHOR_ITEM_B = 4856
ANCHOR_N = 826
ANCHOR_R = 0.3291
ANCHOR_TOL = 0.0001

MIN_N_PAIR = 31
TRIPWIRE_ABS_R = 0.98
TRIPWIRE_MIN_N = 100

# Staging for the two steps that exceed the statement timeout as single
# statements: the ledger self-join and the per-pair k means. Chunks are ntile
# bands over items ordered by cell count descending, so chunk 1 is the heaviest
# ~4% of items and chunk 24 the lightest. The batch boundaries below are the
# ones that actually completed on 2026-08-05; widen them at your own risk.
LEDGER_CHUNKS = 24
LEDGER_BATCHES = [(1, 1), (2, 4), (5, 10), (11, 24)]
KMEAN_BATCHES = [(1, 1), (2, 2), (3, 3), (4, 6), (7, 12), (13, 24)]


# Pre-dedup responses: what is in the table now, plus what the August 4 dedup
# took out. Only used by `verify`, which has to hit a pre-dedup target.
PREDUP = """
  SELECT respondent_id, item_id, question_id, numeric_value, joy_index
    FROM bjl_responses
  UNION ALL
  SELECT respondent_id, item_id, question_id, numeric_value, joy_index
    FROM bjl_responses_dedup_snapshot_20260804
"""

CURRENT = """
  SELECT respondent_id, item_id, question_id, numeric_value, joy_index
    FROM bjl_responses
"""


def legacy_centered_sql(source):
    """Legacy cz: mean-centred within respondent x scale_family, where
    scale_family is bjl_item_spread's (the fine, per-item taxonomy), in each
    family's native units. This is the definition that produced the live v2,
    and it is the one being replaced."""
    return f"""
    WITH src AS ({source}),
    val AS (
      SELECT s.respondent_id,
             s.item_id,
             sp.scale_family,
             CASE WHEN sp.scale_family = 'joy'
                  THEN s.joy_index::double precision
                  ELSE s.numeric_value::double precision END AS v
        FROM src s
        JOIN bjl_item_spread sp ON sp.item_id = s.item_id
       WHERE CASE WHEN sp.scale_family = 'joy'
                  THEN s.joy_index ELSE s.numeric_value END IS NOT NULL
    ),
    centered AS (
      SELECT respondent_id, item_id, scale_family,
             v - avg(v) OVER (PARTITION BY respondent_id, scale_family) AS cz
        FROM val
    )
    SELECT respondent_id, item_id, scale_family, avg(cz) AS cz
      FROM centered
     GROUP BY 1, 2, 3
    """


def ruled_centered_sql(source):
    """Option (ii) cz: each family put on a common footing by its own global
    sd, then the respondent's WHOLE-INSTRUMENT mean removed. No per-family
    centering, so no -1/(k-1) dependency is manufactured."""
    return f"""
    WITH src AS ({source}),
    val AS (
      SELECT s.respondent_id,
             s.item_id,
             sp.scale_family,
             CASE WHEN sp.scale_family = 'joy'
                  THEN s.joy_index::double precision
                  ELSE s.numeric_value::double precision END AS v
        FROM src s
        JOIN bjl_item_spread sp ON sp.item_id = s.item_id
       WHERE CASE WHEN sp.scale_family = 'joy'
                  THEN s.joy_index ELSE s.numeric_value END IS NOT NULL
    ),
    fam_sd AS (
      SELECT scale_family, NULLIF(stddev_pop(v), 0) AS sd
        FROM val GROUP BY 1
    ),
    scaled AS (
      SELECT v.respondent_id, v.item_id, v.scale_family,
             v.v / COALESCE(f.sd, 1.0) AS sv
        FROM val v JOIN fam_sd f USING (scale_family)
    ),
    centered AS (
      SELECT respondent_id, item_id, scale_family,
             sv - avg(sv) OVER (PARTITION BY respondent_id) AS cz
        FROM scaled
    )
    SELECT respondent_id, item_id, scale_family, avg(cz) AS cz
      FROM centered
     GROUP BY 1, 2, 3
    """


def ledger_sql(centered_table, chunk_range=None):
    """Plain Pearson over shared respondents. Never an algebraic function of
    a 'twin' item — that was the suspected mechanism and it was not the
    mechanism, but the rule is still correct and cheap to keep.

    chunk_range restricts item_a to a band of bjl_v3_build_chunks so the
    self-join can be run in batches under the statement timeout. Partitioning
    on item_a alone is safe: item_b > item_a is evaluated inside each batch
    against the full table, so every pair is emitted exactly once, by whichever
    batch owns its item_a."""
    where = ''
    if chunk_range is not None:
        lo, hi = chunk_range
        where = (f'JOIN bjl_v3_build_chunks ch ON ch.item_id = a.item_id '
                 f'AND ch.chunk BETWEEN {lo} AND {hi}')
    return f"""
    SELECT a.item_id AS item_a,
           b.item_id AS item_b,
           a.scale_family AS scale_a,
           b.scale_family AS scale_b,
           count(*)::numeric AS n_pair,
           corr(a.cz, b.cz)::numeric AS r
      FROM {centered_table} a
      {where}
      JOIN {centered_table} b
        ON b.respondent_id = a.respondent_id
       AND b.item_id > a.item_id
     GROUP BY 1, 2, 3, 4
    HAVING count(*) >= {MIN_N_PAIR}
       AND corr(a.cz, b.cz) IS NOT NULL
    """


def q1(cur, sql, args=None):
    cur.execute(sql, args or ())
    return cur.fetchone()


def verify(cur):
    """Rebuild the legacy definition over pre-dedup data and check the anchor.
    Writes nothing."""
    print('verify: rebuilding legacy (per-family) centering over pre-dedup responses...')
    cur.execute('CREATE TEMP TABLE _legacy_cz ON COMMIT DROP AS ' + legacy_centered_sql(PREDUP))
    cur.execute('CREATE INDEX ON _legacy_cz (respondent_id)')
    cur.execute('CREATE INDEX ON _legacy_cz (item_id)')
    cur.execute('ANALYZE _legacy_cz')
    n_cells, = q1(cur, 'SELECT count(*) FROM _legacy_cz')
    print(f'  {n_cells} centered cells')

    n_pair, r = q1(cur, """
        SELECT count(*), round(corr(a.cz, b.cz)::numeric, 4)
          FROM _legacy_cz a JOIN _legacy_cz b USING (respondent_id)
         WHERE a.item_id = %s AND b.item_id = %s
    """, (ANCHOR_ITEM_A, ANCHOR_ITEM_B))

    print(f'  anchor {ANCHOR_ITEM_A} x {ANCHOR_ITEM_B}: '
          f'n={n_pair} r={r}   (expected n={ANCHOR_N} r={ANCHOR_R})')

    ok = (n_pair == ANCHOR_N and r is not None
          and abs(float(r) - ANCHOR_R) <= ANCHOR_TOL)
    if not ok:
        print('\nANCHOR FAILED. The recovered definition no longer reproduces the '
              'ledger it was recovered from. Do not build on it. Something under '
              'this script changed: bjl_item_spread, bjl_question_family, the '
              'dedup snapshot, or bjl_responses itself.')
        return False

    print('  anchor OK — the recovered definition is the one that built live v2.')

    # Not an assertion, just the honest number: how much of the OLD ledger this
    # definition reproduces to four decimals, joy and non-joy reported apart.
    cur.execute("""
        WITH calc AS (
          SELECT a.item_id AS item_a, b.item_id AS item_b,
                 a.scale_family AS fam_a, b.scale_family AS fam_b,
                 count(*) AS n, corr(a.cz, b.cz) AS r
            FROM _legacy_cz a JOIN _legacy_cz b
              ON b.respondent_id = a.respondent_id AND b.item_id > a.item_id
           GROUP BY 1,2,3,4 HAVING count(*) >= %s
        )
        SELECT CASE WHEN c.fam_a = 'joy' AND c.fam_b = 'joy' THEN 'joy x joy'
                    ELSE 'other' END AS band,
               count(*) AS pairs,
               count(*) FILTER (WHERE l.n_pair = c.n) AS n_exact,
               count(*) FILTER (WHERE abs(l.r - round(c.r::numeric,4)) <= 0.0001) AS r_exact,
               round(max(abs(l.r - round(c.r::numeric,4))), 4) AS max_r_drift
          FROM calc c
          JOIN bjl_connectivity_ledger_v2 l
            ON l.item_a = c.item_a AND l.item_b = c.item_b
         GROUP BY 1 ORDER BY 1
    """, (MIN_N_PAIR,))
    print('\n  reproduction of live v2 by band (informational, not a gate):')
    for band, pairs, n_exact, r_exact, drift in cur.fetchall():
        print(f'    {band:<10} pairs={pairs:<7} n exact={n_exact:<7} '
              f'r exact={r_exact:<7} max r drift={drift}')
    print('    (the two hand-corrected rows, 185x186 and 6043x6044, will show as '
          'drift — they are raw Pearson over raw values, by hand, not this '
          'definition. That is expected.)')
    return True


def build(cur):
    """Rebuild under the ruling: (ii) whole-instrument centering as the
    generator, (i) excess over the mechanical floor as the reported metric.
    Writes bjl_conn_centered_v3 and bjl_connectivity_ledger_v3. Does not
    touch v2."""
    print('build: option (ii) whole-instrument centering over current responses...')

    cur.execute('DROP TABLE IF EXISTS bjl_conn_centered_v3')
    cur.execute('CREATE TABLE bjl_conn_centered_v3 AS ' + ruled_centered_sql(CURRENT))
    cur.execute('ALTER TABLE bjl_conn_centered_v3 ENABLE ROW LEVEL SECURITY')
    cur.execute('REVOKE ALL ON TABLE bjl_conn_centered_v3 FROM anon, authenticated')
    cur.execute('CREATE INDEX ON bjl_conn_centered_v3 (respondent_id)')
    cur.execute('CREATE INDEX ON bjl_conn_centered_v3 (item_id)')
    cur.execute('ANALYZE bjl_conn_centered_v3')

    n_cells, n_resp, n_items = q1(cur, """
        SELECT count(*), count(DISTINCT respondent_id), count(DISTINCT item_id)
          FROM bjl_conn_centered_v3
    """)
    print(f'  bjl_conn_centered_v3: {n_cells} cells, {n_resp} respondents, {n_items} items')

    # Sanity: under (ii) the respondent's whole-instrument mean is 0 by
    # construction, and the per-family mean should NOT be 0 — that difference
    # is the whole point of the ruling.
    inst_mean, fam_mean = q1(cur, """
        SELECT round(avg(m)::numeric, 6), round(avg(fm)::numeric, 6) FROM (
          SELECT avg(cz) OVER (PARTITION BY respondent_id) AS m,
                 avg(cz) OVER (PARTITION BY respondent_id, scale_family) AS fm
            FROM bjl_conn_centered_v3
        ) x
    """)
    print(f'  mean of per-respondent means        {inst_mean}   (expect ~0)')
    print(f'  mean of per-respondent-family means {fam_mean}   '
          '(expect NOT pinned to 0 — that is the fix)')

    # The ledger is a 1.45M-cell self-join. Doing it in one statement exceeds
    # the statement timeout on this instance; it has to be staged. Chunking on
    # ntile ORDER BY cell_count DESC puts the heaviest items in the earliest
    # chunks, so those get run in small batches and the long tail runs in
    # large ones. This is what actually completed: 1, 2-4, 5-10, 11-24.
    print('build: ledger (staged self-join)...')
    cur.execute('DROP TABLE IF EXISTS bjl_v3_build_chunks')
    cur.execute(f"""
        CREATE TABLE bjl_v3_build_chunks AS
        SELECT item_id, ntile({LEDGER_CHUNKS}) OVER (ORDER BY n DESC, item_id) AS chunk
          FROM (SELECT item_id, count(*) AS n
                  FROM bjl_conn_centered_v3 GROUP BY 1) t
    """)
    cur.execute('CREATE INDEX ON bjl_v3_build_chunks (chunk)')
    cur.execute('CREATE INDEX ON bjl_v3_build_chunks (item_id)')

    cur.execute('DROP TABLE IF EXISTS bjl_connectivity_ledger_v3')
    cur.execute('CREATE TABLE bjl_connectivity_ledger_v3 AS '
                + ledger_sql('bjl_conn_centered_v3') + ' LIMIT 0')
    for lo, hi in LEDGER_BATCHES:
        cur.execute('INSERT INTO bjl_connectivity_ledger_v3 '
                    + ledger_sql('bjl_conn_centered_v3',
                                 chunk_range=(lo, hi)))
        print(f'  chunks {lo}-{hi} done')
    cur.execute('ALTER TABLE bjl_connectivity_ledger_v3 ENABLE ROW LEVEL SECURITY')
    cur.execute('REVOKE ALL ON TABLE bjl_connectivity_ledger_v3 FROM anon, authenticated')

    # TRIPWIRE. Not a fix, not a filter — a halt. If this fires, a family has
    # gone near-degenerate again and the numbers are not to be believed until
    # somebody looks.
    cur.execute("""
        SELECT item_a, item_b, scale_a, scale_b, n_pair, round(r, 4)
          FROM bjl_connectivity_ledger_v3
         WHERE abs(r) >= %s AND n_pair >= %s
         ORDER BY abs(r) DESC LIMIT 50
    """, (TRIPWIRE_ABS_R, TRIPWIRE_MIN_N))
    tripped = cur.fetchall()
    if tripped:
        print(f'\nTRIPWIRE: {len(tripped)} pair(s) at |r| >= {TRIPWIRE_ABS_R} '
              f'on n >= {TRIPWIRE_MIN_N}:')
        for row in tripped:
            print('   ', row)
        print('This is a halt, not a filter. Nothing has been dropped or clamped. '
              'Investigate before promoting v3.')
        return False

    # (i) the reported metric. The floor must be computed against the group
    # that was ACTUALLY centred. Under (ii) that is the respondent's whole
    # instrument, so k is the instrument size and the floor -1/(k_instr - 1)
    # applies to every pair, cross-family included. Using the per-family k here
    # would report v2's floor against v3's numbers; that is a real trap and the
    # first pass fell into it. The per-family k is still computed, under
    # explicitly legacy names, as the record of what each pair escaped.
    for ddl in (
        'ALTER TABLE bjl_connectivity_ledger_v3 ADD COLUMN IF NOT EXISTS k_instr numeric',
        'ALTER TABLE bjl_connectivity_ledger_v3 ADD COLUMN IF NOT EXISTS floor_r numeric',
        'ALTER TABLE bjl_connectivity_ledger_v3 ADD COLUMN IF NOT EXISTS excess_r numeric',
        'ALTER TABLE bjl_connectivity_ledger_v3 '
        'ADD COLUMN IF NOT EXISTS k_mean_family_legacy numeric',
        'ALTER TABLE bjl_connectivity_ledger_v3 '
        'ADD COLUMN IF NOT EXISTS floor_r_family_legacy numeric',
    ):
        cur.execute(ddl)

    # Materialise cells-with-their-k once. Re-deriving k inside the pair join
    # makes the UPDATE time out; this does not.
    for scope, col in (('respondent_id', 'k_instr'),
                       ('respondent_id, scale_family', 'k_fam')):
        cur.execute(f'DROP TABLE IF EXISTS bjl_v3_cz_{col}')
        cur.execute(f"""
            CREATE TABLE bjl_v3_cz_{col} AS
            WITH k AS (SELECT {scope}, count(*)::numeric AS k
                         FROM bjl_conn_centered_v3 GROUP BY {scope})
            SELECT c.item_id, c.respondent_id, c.scale_family, k.k
              FROM bjl_conn_centered_v3 c JOIN k USING ({scope})
        """)
        cur.execute(f'CREATE INDEX ON bjl_v3_cz_{col} (item_id)')

    for col in ('k_instr', 'k_fam'):
        cur.execute(f'DROP TABLE IF EXISTS bjl_v3_pair_{col}')
        cur.execute(f'CREATE TABLE bjl_v3_pair_{col} '
                    '(item_a int, item_b int, k numeric)')
        same_fam = 'AND a.scale_family = b.scale_family' if col == 'k_fam' else ''
        for lo, hi in KMEAN_BATCHES:
            cur.execute(f"""
                INSERT INTO bjl_v3_pair_{col} (item_a, item_b, k)
                SELECT l.item_a, l.item_b, avg(a.k)
                  FROM bjl_connectivity_ledger_v3 l
                  JOIN bjl_v3_build_chunks ch
                    ON ch.item_id = l.item_a AND ch.chunk BETWEEN {lo} AND {hi}
                  JOIN bjl_v3_cz_{col} a ON a.item_id = l.item_a
                  JOIN bjl_v3_cz_{col} b ON b.item_id = l.item_b
                                        AND b.respondent_id = a.respondent_id
                                        {same_fam}
                 GROUP BY 1, 2
            """)
        cur.execute(f'CREATE INDEX ON bjl_v3_pair_{col} (item_a, item_b)')

    cur.execute("""
        UPDATE bjl_connectivity_ledger_v3 l
           SET k_instr  = p.k,
               floor_r  = -1.0 / (p.k - 1.0),
               excess_r = l.r - (-1.0 / (p.k - 1.0))
          FROM bjl_v3_pair_k_instr p
         WHERE l.item_a = p.item_a AND l.item_b = p.item_b
    """)
    cur.execute("""
        UPDATE bjl_connectivity_ledger_v3 l
           SET k_mean_family_legacy  = p.k,
               floor_r_family_legacy = CASE WHEN p.k > 1
                                            THEN -1.0 / (p.k - 1.0) END
          FROM bjl_v3_pair_k_fam p
         WHERE l.item_a = p.item_a AND l.item_b = p.item_b
           AND l.scale_a = l.scale_b
    """)

    for scratch in ('bjl_v3_cz_k_instr', 'bjl_v3_cz_k_fam',
                    'bjl_v3_pair_k_instr', 'bjl_v3_pair_k_fam',
                    'bjl_v3_build_chunks'):
        cur.execute(f'DROP TABLE IF EXISTS {scratch}')

    cur.execute('CREATE INDEX ON bjl_connectivity_ledger_v3 (item_a, item_b)')
    cur.execute('CREATE INDEX ON bjl_connectivity_ledger_v3 (excess_r)')
    cur.execute('ANALYZE bjl_connectivity_ledger_v3')

    # The before/after the rebuild exists to produce.
    print('\nBEFORE / AFTER on the negative set:')
    cur.execute("""
        SELECT 'v2 r <= -0.35' AS metric, count(*)::text
          FROM bjl_connectivity_ledger_v2 WHERE r <= -0.35
        UNION ALL SELECT 'v3 r <= -0.35', count(*)::text
          FROM bjl_connectivity_ledger_v3 WHERE r <= -0.35
        UNION ALL SELECT 'v2 same-family share of r <= -0.35',
               round(100.0 * count(*) FILTER (WHERE scale_a = scale_b)
                     / NULLIF(count(*), 0), 1)::text || '%'
          FROM bjl_connectivity_ledger_v2 WHERE r <= -0.35
        UNION ALL SELECT 'v3 same-family share of r <= -0.35',
               round(100.0 * count(*) FILTER (WHERE scale_a = scale_b)
                     / NULLIF(count(*), 0), 1)::text || '%'
          FROM bjl_connectivity_ledger_v3 WHERE r <= -0.35
        UNION ALL SELECT 'v3 excess_r <= -0.35', count(*)::text
          FROM bjl_connectivity_ledger_v3 WHERE excess_r <= -0.35
        UNION ALL SELECT 'v3 worst (ii) floor', round(min(floor_r), 4)::text
          FROM bjl_connectivity_ledger_v3
        UNION ALL SELECT 'v3 mean (ii) floor', round(avg(floor_r), 4)::text
          FROM bjl_connectivity_ledger_v3
        UNION ALL SELECT 'v3 worst LEGACY per-family floor (escaped)',
               round(min(floor_r_family_legacy), 4)::text
          FROM bjl_connectivity_ledger_v3
        UNION ALL SELECT 'v3 pairs', count(*)::text FROM bjl_connectivity_ledger_v3
        UNION ALL SELECT 'v2 pairs', count(*)::text FROM bjl_connectivity_ledger_v2
    """)
    for metric, value in cur.fetchall():
        print(f'  {metric:<38} {value}')

    print('\nTOP 20 TRADE-OFFS BY EXCESS OVER FLOOR (the reported metric):')
    cur.execute("""
        SELECT item_a, item_b, scale_a, scale_b, n_pair,
               round(r, 4), round(k_instr, 1), round(floor_r, 4), round(excess_r, 4)
          FROM bjl_connectivity_ledger_v3
         WHERE excess_r < 0
         ORDER BY excess_r ASC
         LIMIT 20
    """)
    print('  item_a  item_b  scale_a          scale_b          n     r        k     floor    excess')
    for a, b, sa, sb, n, r, k, fl, ex in cur.fetchall():
        print(f'  {a:<7} {b:<7} {str(sa):<16} {str(sb):<16} {str(n):<5} '
              f'{r!s:<8} {k!s:<5} {fl!s:<8} {ex}')

    print('\nv3 is built. v2 is untouched. Promoting v3 over v2 is a separate, '
          'deliberate step — the trade-off map and bulletin v1 both read v2 and '
          'the ship gate on the map is not closed by this script.')
    return True


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'verify'
    if mode not in ('verify', 'build'):
        sys.exit('usage: bjl_rebuild_connectivity.py [verify|build]')

    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    cur = conn.cursor()

    if not verify(cur):
        conn.rollback()
        sys.exit(1)

    if mode == 'verify':
        conn.rollback()
        print('\nverify only — nothing written.')
        return

    if not build(cur):
        conn.rollback()
        sys.exit('\nbuild halted; nothing written.')

    conn.commit()
    print('\ncommitted. Update STATE.md as the final step: date, anchor, and the '
          'fact that the ledger is now generated by this script.')


if __name__ == '__main__':
    main()
