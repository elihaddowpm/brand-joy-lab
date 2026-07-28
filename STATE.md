# Corpus state

The full rebuild routine last ran on **2026-07-25**, immediately after the
`sp_2025_01_rivalry` load — both centered tables (`bjl_conn_centered`,
`bjl_conn_centered_v2`) and both connectivity ledgers were rebuilt from
scratch, and the anchor checks reproduced to the digit: **v1 826 / 0.3279**
and **v2 826 / 0.3291**. The live model is **`mf_v1_k24`** (ALS, k=24,
λ=8.0, 15 sweeps), trained on the post-rivalry universe of **14,063
respondents × 1,229 items / 1,452,730 observations** — the rivalry data is
inside its training footprint, not pending against it. The newest fielding
in the corpus is **`sp_2025_01_rivalry` (2025-01)**: 1,000 respondents,
75,970 responses, 3,880 verbatims, with embedding coverage complete at
67,635 / 67,635.

_Update this file as the final step of the rebuild routine: date, anchor
values, model version and training footprint, newest fielding. If a load
lands and this file still reads as above, the rebuild has not run yet._
