-- 2026-08-04 — Give 'unresolvable' a voice.
--
-- 'unresolvable' is the terminal state a name lands in when even a human
-- cannot pick between the candidates. Without a reason it is exactly the
-- thing the worklist exists to abolish: a refusal with no voice. The next
-- person to hit the name needs to know whether it was "genuinely two
-- different items that share a string" or "nobody could tell, this needs
-- the person who fielded the wave."
--
-- ONE DELIBERATE STRENGTHENING, flag it if you disagree. The spec said a
-- nullable note "allowed only when status='unresolvable'", and also said to
-- mirror the triple CHECK's structure. Those two pull in different
-- directions, and this file follows the mirror: the triple CHECK REQUIRES
-- all three columns when status='resolved', so this one REQUIRES the note
-- when status='unresolvable'. An unresolvable row with a null note is the
-- silent refusal restated, and a constraint that permits it does not close
-- the hole the note was added to close.
--
-- The note is forbidden on 'pending' and 'resolved' rows, so it stays dead
-- weight nowhere and can never be mistaken for a rationale attached to a
-- decision that was actually made.
--
-- RE-RUNNABLE, and this is the house standard going forward. A migration
-- that aborts on a second run cannot be safely replayed against an
-- environment whose state you are unsure of, which is every handshake in
-- this build. Every statement below is therefore idempotent: the column
-- uses ADD COLUMN IF NOT EXISTS, and the constraint is wrapped in a DO
-- block that swallows duplicate_object. Running this file twice leaves the
-- same schema and raises no error.

BEGIN;

ALTER TABLE public.bjl_item_resolutions
  ADD COLUMN IF NOT EXISTS resolution_note text;

DO $note_chk$
BEGIN
  ALTER TABLE public.bjl_item_resolutions
    ADD CONSTRAINT bjl_item_resolutions_note_chk
    CHECK (
      (status =  'unresolvable' AND resolution_note IS NOT NULL AND btrim(resolution_note) <> '')
      OR
      (status <> 'unresolvable' AND resolution_note IS NULL)
    );
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'bjl_item_resolutions_note_chk already exists, leaving it alone';
END
$note_chk$;

COMMENT ON COLUMN public.bjl_item_resolutions.resolution_note IS
  'Why this name could not be resolved. Required on status=''unresolvable'', '
  'forbidden otherwise. A terminal refusal has to say why, or the next '
  'person to reach this row learns nothing from it.';

COMMIT;

-- Verification:
--
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid='bjl_item_resolutions'::regclass
--      AND conname='bjl_item_resolutions_note_chk';
--
--   SELECT count(*) AS total,
--          count(*) FILTER (WHERE status='pending')          AS pending,
--          count(*) FILTER (WHERE resolution_note IS NOT NULL) AS with_note
--     FROM bjl_item_resolutions;          -- expect 366 / 366 / 0
--
--   -- Both of these must fail:
--   --   UPDATE bjl_item_resolutions SET status='unresolvable' WHERE resolution_id=1;
--   --   UPDATE bjl_item_resolutions SET resolution_note='x'  WHERE resolution_id=1;
--
--   -- This must succeed:
--   --   UPDATE bjl_item_resolutions
--   --      SET status='unresolvable', resolution_note='two distinct items share this string'
--   --    WHERE resolution_id=1;
--   -- (roll it back afterwards; the seed should stay all-pending)
--
--   -- And the whole file must run a second time without error.
