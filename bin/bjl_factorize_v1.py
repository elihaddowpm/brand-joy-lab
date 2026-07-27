#!/usr/bin/env python3
"""
BJL factorization ("the Netflix method") — train, validate, write back.

Scope (fixed by design decisions 2026-07): respondent profiling and cold-start
inference ONLY. Never connection discovery. Modeled outputs are a labeled
evidence tier below measurement, gated by the holdout accuracy this script
computes, and abstain wherever accuracy cannot be demonstrated.

Usage:
  DATABASE_URL='postgresql://...' python3 bjl_factorize_v1.py

Requires: numpy, psycopg2. Runtime: minutes on the ~1.4M-entry matrix.

What it does:
 1. Loads bjl_conn_centered_v2 (respondent x item centered scores, all families).
 2. Holds out 5% of observed entries (seeded, stratified by scale family).
 3. Trains ALS matrix factorization (k=24 latent factors, ridge-regularized).
 4. Validates: holdout correlation + RMSE, overall, per scale family, and per
    territory (via bjl_item_territory).
 5. Cold-start test: for 400 held-out respondents, keeps ONLY the territory
    anchor items visible, folds them in, predicts everything else, reports
    accuracy. This is the sixteen-in, universe-out number.
 6. Writes: bjl_item_latent, bjl_respondent_latent, bjl_model_accuracy,
    bjl_model_registry. Idempotent per MODEL_VERSION.

Abstention rule (baked in): any (territory x family) cell with holdout
correlation < ABSTAIN_R or holdout n < ABSTAIN_N is recorded eligible=false.
Consumers (map sweep modeled rows) MUST join accuracy and skip ineligible cells.
"""
import os, json, math, random
import numpy as np
import psycopg2, psycopg2.extras

MODEL_VERSION = 'mf_v1_k24'
K = 24                 # latent factors
LAMBDA = 8.0           # ridge regularization
ITERS = 15             # ALS sweeps
HOLDOUT_FRAC = 0.05
COLDSTART_N = 400
ABSTAIN_R = 0.30       # minimum holdout correlation to be eligible
ABSTAIN_N = 60         # minimum holdout observations per cell
SEED = 42

ANCHOR_ITEMS_SQL = """
  SELECT i.item_id FROM bjl_items i
  WHERE i.item_name IN (
   'Having a HOME COOKED meal in your home','Ice cream',
   'GIVING A SPECIAL GIFT to someone you care about',
   'GETTING TOGETHER with good friends and family','Seeing your favorite team win',
   'Seeing AUTO RACING in person','Taking a VACATION',
   'Having access to HIGH-SPEED INTERNET in your home','Taking a BATH',
   'Coming in UNDER BUDGET at the grocery checkout','WORKING at your job or business',
   'Christmas','DOOM SCROLLING, scrolling the negative or upsetting news online',
   'Drinking COFFEE')
"""

def main():
    rng = np.random.default_rng(SEED)
    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    cur = conn.cursor()

    print('loading centered matrix...')
    cur.execute("SELECT respondent_id, item_id, scale_family, cz FROM bjl_conn_centered_v2")
    rows = cur.fetchall()
    resp_ids = sorted({r[0] for r in rows})
    item_ids = sorted({r[1] for r in rows})
    r_idx = {rid: i for i, rid in enumerate(resp_ids)}
    i_idx = {iid: j for j, iid in enumerate(item_ids)}
    fam_of_item = {}
    R, C, V, F = [], [], [], []
    for rid, iid, fam, cz in rows:
        R.append(r_idx[rid]); C.append(i_idx[iid]); V.append(float(cz)); F.append(fam)
        fam_of_item[iid] = fam
    R = np.array(R); C = np.array(C); V = np.array(V); F = np.array(F)
    n_r, n_i, n_obs = len(resp_ids), len(item_ids), len(V)
    print(f'  {n_r} respondents x {n_i} items, {n_obs} observations')

    # scale normalization: joy is in JI points, others are z-units; standardize
    # per family so the loss treats families comparably, remember factors to invert
    fam_scale = {}
    for fam in np.unique(F):
        m = F == fam
        fam_scale[fam] = float(V[m].std()) or 1.0
        V[m] = V[m] / fam_scale[fam]

    # holdout mask, stratified by family
    hold = np.zeros(n_obs, dtype=bool)
    for fam in np.unique(F):
        idx = np.where(F == fam)[0]
        take = rng.choice(idx, size=max(1, int(len(idx) * HOLDOUT_FRAC)), replace=False)
        hold[take] = True
    # cold-start respondents: fully held out except anchors
    cur.execute(ANCHOR_ITEMS_SQL)
    anchor_ids = {row[0] for row in cur.fetchall()}
    anchor_cols = {i_idx[a] for a in anchor_ids if a in i_idx}
    cs_resp = set(rng.choice(n_r, size=COLDSTART_N, replace=False).tolist())
    cs_mask = np.isin(R, list(cs_resp)) & ~np.isin(C, list(anchor_cols))
    hold = hold | cs_mask
    train = ~hold
    print(f'  train {train.sum()}, holdout {hold.sum()} (incl. cold-start cells {cs_mask.sum()})')

    # ALS
    P = rng.normal(0, 0.1, (n_r, K))
    Q = rng.normal(0, 0.1, (n_i, K))
    Rt, Ct, Vt = R[train], C[train], V[train]
    by_resp = [[] for _ in range(n_r)]
    by_item = [[] for _ in range(n_i)]
    for t in range(len(Vt)):
        by_resp[Rt[t]].append(t)
        by_item[Ct[t]].append(t)
    eyeK = np.eye(K) * LAMBDA
    for it in range(ITERS):
        for u in range(n_r):
            ts = by_resp[u]
            if not ts: continue
            Qs = Q[Ct[ts]]; vs = Vt[ts]
            P[u] = np.linalg.solve(Qs.T @ Qs + eyeK, Qs.T @ vs)
        for j in range(n_i):
            ts = by_item[j]
            if not ts: continue
            Ps = P[Rt[ts]]; vs = Vt[ts]
            Q[j] = np.linalg.solve(Ps.T @ Ps + eyeK, Ps.T @ vs)
        pred_tr = np.einsum('ij,ij->i', P[Rt], Q[Ct])
        rmse = float(np.sqrt(np.mean((pred_tr - Vt) ** 2)))
        print(f'  iter {it+1}/{ITERS} train rmse {rmse:.4f}')

    # cold-start fold-in: recompute those respondents from anchors only
    for u in cs_resp:
        ts = [t for t in by_resp[u] if Ct[t] in anchor_cols] if by_resp[u] else []
        obs = [t for t in range(len(Vt)) if Rt[t] == u and Ct[t] in anchor_cols]
        if obs:
            Qs = Q[Ct[obs]]; vs = Vt[obs]
            P[u] = np.linalg.solve(Qs.T @ Qs + eyeK, Qs.T @ vs)

    # validation
    cur.execute("SELECT item_id, territory_key FROM bjl_item_territory")
    terr_of = dict(cur.fetchall())
    Rh, Ch, Vh = R[hold], C[hold], V[hold]
    pred = np.einsum('ij,ij->i', P[Rh], Q[Ch])
    def scope_stats(a, p):
        """holdout correlation, rmse, and calibration slope (actual regressed on
        predicted: slope > 1 means predictions are shrunk; consumers multiply
        raw model estimates by the slope to de-shrink)."""
        if len(a) < 3 or a.std() == 0 or p.std() == 0:
            return None, float(np.sqrt(np.mean((p - a) ** 2))) if len(a) else None, None
        c = float(np.corrcoef(a, p)[0, 1])
        slope = float(np.cov(a, p)[0, 1] / np.var(p))
        return c, float(np.sqrt(np.mean((p - a) ** 2))), slope
    results = []
    c, e, s = scope_stats(Vh, pred); results.append(('overall', 'all', c, e, int(len(Vh)), s))
    Fh = F[hold]
    for fam in np.unique(Fh):
        m = Fh == fam
        c, e, s = scope_stats(Vh[m], pred[m]); results.append(('family', fam, c, e, int(m.sum()), s))
    item_arr = np.array(item_ids)
    terr_h = np.array([terr_of.get(item_arr[c2], 'unassigned') for c2 in Ch])
    for tk in np.unique(terr_h):
        m = terr_h == tk
        c, e, s = scope_stats(Vh[m], pred[m]); results.append(('territory', tk, c, e, int(m.sum()), s))
    csm = np.isin(Rh, list(cs_resp))
    c, e, s = scope_stats(Vh[csm], pred[csm]); results.append(('coldstart_16in', 'all', c, e, int(csm.sum()), s))
    print('\nHOLDOUT RESULTS (correlation / rmse / n / calibration slope):')
    for scope, key, c, e, n, s in results:
        flag = '' if (c or 0) >= ABSTAIN_R and n >= ABSTAIN_N else '  [ABSTAIN]'
        print(f'  {scope:>14} {key:<22} r={c if c is None else round(c,3)}  rmse={e:.3f}  n={n}  slope={s if s is None else round(s,3)}{flag}')

    # write back
    cur.execute("""CREATE TABLE IF NOT EXISTS bjl_model_registry (
      model_version text PRIMARY KEY, trained_at timestamptz DEFAULT now(),
      params jsonb, overall_holdout_r numeric, coldstart_r numeric, notes text)""")
    cur.execute("""CREATE TABLE IF NOT EXISTS bjl_item_latent (
      model_version text, item_id int, factors jsonb, PRIMARY KEY (model_version, item_id))""")
    cur.execute("""CREATE TABLE IF NOT EXISTS bjl_respondent_latent (
      model_version text, respondent_id text, factors jsonb, PRIMARY KEY (model_version, respondent_id))""")
    cur.execute("""CREATE TABLE IF NOT EXISTS bjl_model_accuracy (
      model_version text, scope_type text, scope_key text,
      holdout_r numeric, rmse numeric, n_holdout int, eligible boolean,
      PRIMARY KEY (model_version, scope_type, scope_key))""")
    cur.execute("ALTER TABLE bjl_model_accuracy ADD COLUMN IF NOT EXISTS calibration_slope numeric")
    for t in ('bjl_model_registry','bjl_item_latent','bjl_respondent_latent','bjl_model_accuracy'):
        cur.execute(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY")
    cur.execute("DELETE FROM bjl_item_latent WHERE model_version=%s", (MODEL_VERSION,))
    cur.execute("DELETE FROM bjl_respondent_latent WHERE model_version=%s", (MODEL_VERSION,))
    cur.execute("DELETE FROM bjl_model_accuracy WHERE model_version=%s", (MODEL_VERSION,))
    psycopg2.extras.execute_values(cur,
      "INSERT INTO bjl_item_latent VALUES %s",
      [(MODEL_VERSION, int(item_ids[j]), json.dumps([round(float(x),5) for x in Q[j]])) for j in range(n_i)],
      page_size=2000)
    psycopg2.extras.execute_values(cur,
      "INSERT INTO bjl_respondent_latent VALUES %s",
      [(MODEL_VERSION, resp_ids[u], json.dumps([round(float(x),5) for x in P[u]])) for u in range(n_r)],
      page_size=2000)
    psycopg2.extras.execute_values(cur,
      "INSERT INTO bjl_model_accuracy (model_version, scope_type, scope_key, holdout_r, rmse, n_holdout, eligible, calibration_slope) VALUES %s",
      [(MODEL_VERSION, sc, k, None if c is None else round(c,4), round(e,4), n,
        (c or 0) >= ABSTAIN_R and n >= ABSTAIN_N,
        None if sl is None else round(sl,4)) for sc, k, c, e, n, sl in results],
      page_size=500)
    ov = next(x for x in results if x[0]=='overall'); cs = next(x for x in results if x[0]=='coldstart_16in')
    cur.execute("""INSERT INTO bjl_model_registry (model_version, params, overall_holdout_r, coldstart_r, notes)
      VALUES (%s,%s,%s,%s,%s) ON CONFLICT (model_version) DO UPDATE
      SET trained_at=now(), params=EXCLUDED.params, overall_holdout_r=EXCLUDED.overall_holdout_r,
          coldstart_r=EXCLUDED.coldstart_r, notes=EXCLUDED.notes""",
      (MODEL_VERSION, json.dumps({'k':K,'lambda':LAMBDA,'iters':ITERS,'holdout':HOLDOUT_FRAC,
       'coldstart_n':COLDSTART_N,'abstain_r':ABSTAIN_R,'abstain_n':ABSTAIN_N,'seed':SEED,
       'fam_scale':{k:round(v,4) for k,v in fam_scale.items()}}),
       round(ov[2],4), None if cs[2] is None else round(cs[2],4),
       'Scope: respondent profiling + cold-start inference only. Never connection discovery. Modeled tier gated by bjl_model_accuracy.eligible.'))
    conn.commit()
    print(f"\nwritten: model_version={MODEL_VERSION}. Consumers must join bjl_model_accuracy and respect eligible=false.")

if __name__ == '__main__':
    main()
