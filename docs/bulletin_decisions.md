# Bulletin Build — Decisions of Record

### Canonical decisions doc for docs/bulletin_decisions.md · originally drafted July 31, 2026 · reconciled August 4, 2026 · Eli/BJL

> **How to read this file.** The body below is the original July 31 decisions doc, preserved verbatim so the reasoning is intact. Several rulings were superseded or refined by later decisions in the same build. Rather than silently rewrite the body — which would erase why a choice changed — every supersession is caught in the **Reconciliation addendum** at the foot of this file, and the affected body passages carry an inline **[SUPERSEDED → see addendum N]** marker. When body and addendum disagree, the addendum wins. This mirrors the register's own discipline: a superseded thing stays addressable, it does not vanish.

---
---

# BODY — as decided July 31, 2026

## Q1 · Generation v1 — what drafts come from, and the rails

**Confirmed, with the input scoped by the recovered addendum.** Generation operates at the run level: "Draft bulletin from this run" assembles the payload server-side: the focal card (items, door, cohort sentence, mode/gate), all sixteen map rows with alignment states, the territory profile for every territory whose lead is measured or GROWTH (fetched server-side, never client-cached expansions), plus the engagement's non-superseded signals. One synthesis call. Investigation runs qualify as sources too, with the population rule below as their gate.

**Your four rails, confirmed and extended:**

- **Status:** entry status changes from the original spec; see Q3. (Original said candidate + generated flag; superseded.)
- **Tier:** `evidence_tier` comes from `deriveEvidenceTier` over the source rows, never from the model. Mapping from house marks where relevant: measured rows → `measured`; model-inferred rows → `modeled`; territory with no qualifying rows → `unmeasured`; a card anchored only on Waldo material → `signal-only`.
- **Numbers, extended to entities:** no number in any field that isn't verbatim in the retrieved payload, and no brand, person, or place name that isn't in the payload or the referenced signal rows. `claim_summary` carries the full triplet (lift, shared answerers, share moving together) unless the source row carries a skew flag, in which case lift and n only, per the register's standing rule. `claim_population` is copied verbatim from the run's cohort sentence, never paraphrased. `claim_items` gets the source item_ids **[SUPERSEDED → see addendum 1: the grounding path]**; `signal_ids` by reference only. A source finding with no explicit population sentence cannot produce a draft; the builder refuses rather than invents.
- **Provenance:** three new columns (DDL below): `source_run_id`, `origin`, and `generated_by` (model + prompt version + timestamp inside a jsonb). Every machine draft names its run.
- **Volume:** cap 10 drafts per run, ranked by the generator; rows below the n=30 reporting floor cannot anchor a `measured` draft.

**Interpretation-field whitelist (added this session, formalizes here).** Signal fields a generated card may read: `headline`, `exact_quote`, `detail`, `urgency`, `source_url`, `captured_at`. The interpretation fields `why_it_matters` and `relevance` may inform ranking but never enter claim text or evidence lines — one model's opinion is not laundered into a card as evidence.

## Q2 · Run-level harvest — your reading is right

Confirmed verbatim from the addendum: harvest "operates at the run level and considers everything, independent of what the user expanded in the UI," firing in the background function at run completion, after synthesis, so drafts exist server-side before anyone looks. Three engineering conditions: **idempotent** (unique on `(source_run_id, claim_hash)`; re-running a harvest supersedes rather than duplicates), **isolated** (harvest failure logs and never fails the run), and the manual per-row button survives as the analyst's capture path, relabeled per the addendum: "Capture this finding," so the two verbs stop sharing a name.

## Q3 · Where drafts live — same table, new status, and this supersedes the original

The original spec said candidate + `generated=true`. Your instinct is better, and here's the decision: **same table, distinct entry status.** Machine drafts enter `bjl_opportunities` at `status='machine_draft'` with `origin='harvest'`. Promotion to `candidate` is a human act that records `promoted_by` and `promoted_at`. Default `list` excludes `machine_draft` unless explicitly requested, so an ungroomed machine draft can never sit in the register looking authored; the guarantee is structural, not a render-time flag check.

Why same-table rather than staging: the claim-triple validation, the tier machinery, and the freshness computation apply identically to drafts and cards, and you described the write path as singular; a staging table forks it. And since the status lifecycle currently lives only in JS, add the CHECK constraint in the same migration, encoding your existing lifecycle values plus `machine_draft` at the front.

---

## Piece 1 · The per-surface honesty table

The four `*Draft()` builders, with what each surface can carry: **[SUPERSEDED → see addendum 2: two surfaces are dormant]**

| Surface | claim_population | evidence_tier available |
|---|---|---|
| Joy Map territory row | The run's cohort sentence, verbatim | measured or modeled, per the row's verdict |
| Territory profile finding | Same cohort sentence | measured; modeled for inferred items |
| Investigator / Intelligence pane | Extracted from the finding's own population sentence; if the finding names none, the builder refuses with a message saying why | measured only when the claim cites lift and n from retrieved rows; otherwise unmeasured |
| Audience Map | The audience definition sentence of that map | measured or modeled per row |
| Dance Map | The shared-answerers sentence for the pair | measured (pairs are measured by construction) |
| Public chat | **No send-to-bulletin.** The public surface never writes to the register; provenance and auth both argue for it, and nothing stops staff from re-running a public question inside the Intelligence pane. | — |

`signal-only` is never available from a map surface; it exists for cards born from the signals table alone.

---

## The migrations gap — DDL from the live database

**[SUPERSEDED → see addendum 3: the DDL shipped, with corrections.]** Both tables were reconstructed from the live schema (July 31); the applied form differs from the sketch below in three ways the addendum records. The sketch is kept for reasoning only; the applied migrations are the source of truth.

```sql
-- SKETCH ONLY — see the applied migrations for the shipped form.
-- bjl_marketplace_signals and bjl_opportunities, with the six provenance
-- columns (source_run_id, origin, generated_by, claim_hash, promoted_by,
-- promoted_at), the tier CHECK, the status CHECK, and the harvest
-- idempotency index. The status CHECK's lifecycle values were encoded from
-- bjl-opportunities.js. See addendum 3 for what the sketch got wrong.
```

Piece 2 stands as you read it: the paste box **[SUPERSEDED → see addendum 4: no extractor on the signals path]** writes bjl_marketplace_signals with re-paste superseding on (engagement, external_id), malformed paste returning the same legible-400 contract as the opportunities endpoint. Your existing refusal list (perceived_gaps, category context, demographics, internal sentiment never reach the LLM) is exactly right and now written down where the next lost thread can't take it.

---
---

# RECONCILIATION ADDENDUM — decided August 3–4, 2026

### Where the build refined or reversed the July 31 body. The addendum wins.

**Addendum 1 · The claim_items grounding path (refines Q1 rail 3).**
Rail 3 said "claim_items gets the source item_ids." When built, there was no path to an item_id: blocks carry rendered prose, `bjl_corpus_search` returned names only, and item names are not unique (e.g. "A BEER" maps to twelve items). Ruling: **option C — resolve where unique, refuse where not, loudly.** `bjl_corpus_search` now returns `item_id` plus a per-row `resolution` verdict (`unique` | `adjudicated` | `ambiguous` | `unmatched`). A row grounds an item_id only when the name maps to exactly one item or a human has adjudicated it; otherwise item_id is null and **the row is excluded from a generated draft entirely — not merely from claim_items — so a card never cites a figure it cannot ground.** Ambiguous names accumulate in `bjl_item_resolutions`, an adjudication worklist seeded with candidates only (no machine guess wearing human provenance); a human resolution there immediately widens what the next draft can ground. Applied: `migrations/2026-08-04_item_resolution_and_corpus_search.sql`.

**Addendum 2 · Two of the five Piece-1 surfaces are dormant (corrects the honesty table).** `AudienceMapResults` and `JoyMapDanceMapResults` are mounted nowhere; their builders were not written. The Dance Map capability the table described already ships via the Connections sweep's `territoryDraft`/`findingDraft`. The Audience Map payload cannot honestly feed the register as-is: it carries no `item_id`, so `claim_items` would dead-end. Ruling: leave both dormant, builders unwritten. If the Audience Map returns, its payload must carry `item_id` and a modeled flag from day one, and the builder is written against the real shape then. Live Piece-1 surfaces: Joy Map territory row, territory profile finding, Intelligence pane (with the refuse-on-no-population rule), and public chat (no send-to-bulletin, by design).

**Addendum 3 · The DDL as shipped (corrects the migrations-gap sketch).** Three corrections to the July 31 sketch. (a) `CREATE TABLE IF NOT EXISTS` is a no-op against the live tables, so new columns ship as their own `ALTER TABLE ... ADD COLUMN`. **Going forward, migrations must be re-runnable**: `ADD COLUMN IF NOT EXISTS`, and constraints wrapped in `DO` blocks that swallow `duplicate_object`. A file that aborts on a second run cannot be safely replayed against an environment whose state is uncertain, which is every handshake in this build. Earlier migrations in this repo predate the rule and are left as applied; `2026-08-04_resolution_note.sql` is the first written to it. (b) The status lifecycle is `machine_draft, candidate, reviewed, selected, shipped, retired`. (c) `source_run_id` carries no foreign key by design — a card outlives the run that suggested it. Applied across `2026-07-31_bulletin_provenance.sql` and the MCP-applied provenance migration. The tier/audit-trail constraint is tier-aware, not blanket NOT NULL (see addendum 5).

**Addendum 4 · No extractor on the signals write path (corrects Piece 2).** The July 31 body said the paste box routes through `bjl-waldo-extractor`. It does not: the extractor whitelists the 4Cs *brand profile* payload because that feeds an LLM. The *signals* payload never reaches an LLM — it maps field-to-column and writes, parsing fresh. Rulings that governed the shipped paste path: signals require an emitted `external_id` (refuse if absent — Waldo always emits one); activation windows synthesize identity as `WIN-` + hash over engagement + normalized window name, **truncating at the ` — ` separator before normalizing** so subtitle edits don't fork identity, with same-payload prefix collisions returning a legible 400; re-paste supersedes only rows whose mapped content changed (unchanged rows skipped, so chains record market movement not paste count); payload `source` (a URL) maps to `source_url` while column `source` stays `'waldo'`; `owned_source: true` maps to the boolean column; a truthy `flag` appends to `detail`. Applied: `2026-08-03_signal_paste_apply.sql`.

**Addendum 5 · The tier-aware evidence constraint (adds to Q1/Q3).** `schema_doc` claimed `claim_items` was blanket NOT NULL; the database was right and the doc was wrong — a blanket rule outlaws signal-only cards, which rest on `signal_ids`. The honest constraint: measured/modeled require non-empty `claim_items`; signal-only requires non-empty `signal_ids`; unmeasured requires neither. It cannot catch a `claim_summary` citing a figure whose row was dropped from `claim_items` — that is closed upstream by the row-level exclusion rule in addendum 1. Applied in `2026-08-04_item_resolution_and_corpus_search.sql`.

**Addendum 6 · Security posture the build established (context for future functions).** Two default-privilege flips make new objects fail-closed: `bjl_agent_readonly` and `anon`/`authenticated` no longer inherit EXECUTE on functions created by `postgres` in `public`. Every future agent- or public-facing function therefore needs a **deliberate** GRANT (this is why the corpus-arm migration re-grants explicitly after its DROP/CREATE). One live critical was closed in the same pass: `execute_write_sql` (SECURITY DEFINER, arbitrary SQL) had been `anon`-executable and is now service-role only. Open on the ledger: the analogous **table** and **sequence** defaults still grant to `anon`/`authenticated`; RLS covers existing tables but a future table created without RLS would be born exposed — flagged, not yet flipped, pending a read of how the frontend uses table-level PostgREST.

**Addendum 7 · The resolution_note strengthening (refines addendum 1).** `bjl_item_resolutions` gains a `resolution_note`, required when `status = 'unresolvable'` and forbidden otherwise, mirroring the triple CHECK. An unresolvable name with no reason is the silent refusal the worklist exists to end; the note records whether it was "two genuinely different items sharing a string" or "needs a human who knows the wave." Applied August 4, 2026: `2026-08-04_resolution_note.sql`.
