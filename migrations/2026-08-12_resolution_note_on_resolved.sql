-- 2026-08-12 — Let a resolution say why, when the answer was to mint.
--
-- WHAT BROKE. The m_2026_08 load carries the first six resolutions this
-- table has ever received. All six were ruled the same way: the name exists
-- under other question_ids, no q9 item_id exists to match, so reaching for a
-- q11 or q28 id would be a text match wearing a different hat — mint a new
-- item under question_id 9 instead, and accept that the q11 rivalry series
-- and the new q9 series will not auto-join.
--
-- bjl_item_resolutions cannot record that. Two constraints, both deliberate,
-- both carrying their reasoning in the file that added them:
--
--   candidate_chk  "You cannot resolve to an item that was never a
--                   candidate."                (2026-08-04, item_resolution)
--   note_chk       "The note is forbidden on 'pending' and 'resolved'
--                   rows."                     (2026-08-04, resolution_note)
--
-- Both are correct under one assumption: that resolving means PICKING one of
-- the listed candidates. Under that assumption the chosen id is its own
-- explanation and a note on a resolved row really is dead weight. Minting is
-- the case the assumption does not cover, and it is the case that arrived.
--
-- WHAT THIS CHANGES, AND ONLY THIS. One constraint, note_chk. A non-blank
-- resolution_note becomes REQUIRED on status='resolved'. Everything else
-- holds exactly as before:
--
--   * required on 'unresolvable' — a terminal refusal still has to say why
--   * forbidden on 'pending'     — an undecided row still carries no rationale
--   * never blank anywhere       — btrim <> '' still enforced on every state
--
-- Required, not merely permitted, and that is the deliberate choice. The
-- failure this corpus keeps producing is a decision recorded without its
-- premise and read wrong later. A note that is optional is a note that is
-- absent on the row where it mattered, and nobody finds out until someone
-- re-litigates a ruling or misreads a resolved id as an exact match. Making
-- it required means every resolution is self-documenting by construction
-- rather than by discipline.
--
-- The cost is one sentence from every future resolver, including trivial
-- pick-a-candidate confirmations. A trivial confirmation gets a trivial note
-- — 'exact match, reused existing id' — which costs seconds and prevents a
-- future mystery. That trade was taken with eyes open.
--
-- The 366 pending rows are untouched and unexamined by the new predicate:
-- 'pending' still forbids the note, and none of them carry one. No existing
-- row becomes illegal, because there are no resolved rows yet. This is the
-- only moment this constraint can be tightened without a backfill, which is
-- the other reason to take the strict form now rather than later.
--
-- WHAT THIS DOES NOT CHANGE. candidate_chk stays at full strength. It is not
-- weakened and it does not need to be. candidate_item_ids is documented in
-- the creating migration as a DERIVED fact — "every bjl_items.item_id
-- sharing this name" — so once the new item is minted, it IS an item_id
-- sharing that name, and re-deriving the array is the column behaving as
-- specified rather than an exception carved into the guard. The load
-- re-derives it in the same transaction that mints. The guard's stated
-- purpose, "the worklist would accept an id from anywhere and the arm would
-- serve it as grounded evidence," is fully preserved: an id that does not
-- share the name is still refused.
--
-- The cost of re-deriving is that the array alone no longer distinguishes a
-- minted id from a pre-existing one. That is exactly what the note is now
-- allowed to carry, which is why these two halves ship together and why the
-- note is not decorative.
--
-- RE-RUNNABLE, per house standard. Drop-then-add is idempotent by
-- construction; running this file twice leaves the same schema and raises no
-- error.

BEGIN;

ALTER TABLE public.bjl_item_resolutions
  DROP CONSTRAINT IF EXISTS bjl_item_resolutions_note_chk;

ALTER TABLE public.bjl_item_resolutions
  ADD CONSTRAINT bjl_item_resolutions_note_chk
  CHECK (
    (status =  'unresolvable' AND resolution_note IS NOT NULL AND btrim(resolution_note) <> '')
    OR
    (status =  'resolved'     AND resolution_note IS NOT NULL AND btrim(resolution_note) <> '')
    OR
    (status =  'pending'      AND resolution_note IS NULL)
  );

COMMENT ON COLUMN public.bjl_item_resolutions.resolution_note IS
  'Why this name landed where it did. REQUIRED on status=''resolved'' and on '
  'status=''unresolvable'', forbidden on ''pending'', never blank. A refusal has '
  'to say why, and so does a decision: the chosen item_id cannot explain '
  'itself when the resolution was to mint a new item, and a bare id is how a '
  'ruling gets re-litigated or misread as an exact match one wave later. A '
  'trivial confirmation gets a trivial note (''exact match, reused existing '
  'id''); that is the intended cost.';

COMMIT;

-- Verification:
--
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid='bjl_item_resolutions'::regclass
--      AND conname='bjl_item_resolutions_note_chk';
--
--   -- Still forbidden (must both fail):
--   --   UPDATE bjl_item_resolutions SET resolution_note='x' WHERE status='pending';
--   --   UPDATE bjl_item_resolutions SET status='unresolvable', resolution_note='   '
--   --    WHERE resolution_id=1;
--
--   -- Still required on unresolvable (must fail):
--   --   UPDATE bjl_item_resolutions SET status='unresolvable' WHERE resolution_id=1;
--
--   -- NOW required on resolved too (must fail — this is the new strictness):
--   --   UPDATE bjl_item_resolutions
--   --      SET status='resolved', resolved_item_id=candidate_item_ids[1],
--   --          resolved_by='verify', resolved_at=now()
--   --    WHERE resolution_id=1;
--
--   -- Newly permitted (must succeed, then roll back):
--   --   UPDATE bjl_item_resolutions
--   --      SET status='resolved', resolved_item_id=candidate_item_ids[1],
--   --          resolved_by='verify', resolved_at=now(),
--   --          resolution_note='verification only'
--   --    WHERE resolution_id=1;
--
--   -- And the whole file must run a second time without error.
