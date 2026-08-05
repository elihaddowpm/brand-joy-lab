# Corpus state

> **STALE AS OF 2026-08-04 — do not ship from the ledger.** The dedup
> removed 7,080 rows from `bjl_responses`
> (`2026-08-04_responses_dedup.sql`). `bjl_conn_centered_v2` and both
> connectivity ledgers were computed before that delete and no longer
> match source. The trade-off map and bulletin generation v1 both read
> `bjl_connectivity_ledger_v2`; neither is safe until the rebuild lands.
> Rebuilding is necessary but not sufficient — see
> `2026-08-04_ledger_negative_one_correction.sql`, which shows the
> centering itself biases same-family pairs negative. **Ruled August 5:
> option (ii) whole-instrument centering as the generator, (i) excess over
> the mechanical floor as the reported metric.** The rebuild routine is now
> in version control as `bin/bjl_rebuild_connectivity.py` — run
> `verify` (asserts the anchor, writes nothing) before `build`.
>
> **v3 IS BUILT (2026-08-05) and v2 is untouched.** `bjl_conn_centered_v3`
> (1,452,629 cells) and `bjl_connectivity_ledger_v3` (115,144 pairs, matching
> v2's 115,144) exist under (ii)+(i). Tripwire clean. See
> `2026-08-05_connectivity_v3_build.sql` for the before/after. **Promotion of
> v3 over v2 has NOT happened and is a deliberate human step** — the trade-off
> map and bulletin v1 both still read v2, and ship gate condition #2 (source
> the 1,364, or retire it) is still open. Consumers of v3 rank on `excess_r`,
> not `r`; `k_mean_family_legacy` / `floor_r_family_legacy` are v2 diagnostics
> and must not be ranked on.

**The anchor line below is one pair, not an aggregate** — items
1393 x 4856, n_pair 826. Verified August 5: the recovered definition in
`bin/bjl_rebuild_connectivity.py` reproduces **826 / 0.3291** exactly from
pre-dedup responses, and rebuilds the centered table to 1,452,730 cells
against live's 1,452,730.

**v1 has been overwritten, and the 0.3279 below is the only surviving
trace of it.** Live, every v1 artifact is an exact slice of v2:
`bjl_conn_centered.cj` is byte-identical to `bjl_conn_centered_v2.cz`
where `scale_family = 'joy'` (all 1,053,961 cells, max abs diff 0.0000),
and all 60,401 rows of `bjl_connectivity_ledger` appear in
`bjl_connectivity_ledger_v2` with identical `n_pair` and `r`, every one
joy x joy. Both now return 0.3291 for the anchor. So v1 no longer
reproduces its own documented number. Do not read the two anchors below
as a live v1/v2 distinction — it is a record of a computation that is
gone. (Centering on the coarse question family instead of the fine one
returns exactly 826 / 0.3279 for this pair, which is suggestive of what
v1 was, but v1 has no consumer and is not worth reconstructing.)

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
