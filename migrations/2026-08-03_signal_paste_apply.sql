-- Migration: the signals write path, as one atomic statement.
--
-- Piece 2 pastes a Waldo signals payload into bjl_marketplace_signals.
-- The spec is: a re-paste supersedes rather than duplicates, and a row
-- whose mapped content is unchanged is skipped entirely, so a supersede
-- chain records how many times the market moved and never how many times
-- someone pasted.
--
-- WHY THIS IS A DATABASE FUNCTION AND NOT THREE POSTGREST CALLS.
--
-- The partial unique index bjl_signals_ext_engagement forbids two LIVE
-- rows for the same (engagement, external_id). So the new row cannot be
-- inserted while the old one is still live — the insert is rejected. But
-- the old row cannot be retired first either, because superseded_by has
-- to point at the new row's id, and that id does not exist until the
-- insert succeeds. The two operations are deadlocked unless they share a
-- transaction, and PostgREST gives one statement per call.
--
-- Inside a transaction the knot unties: retire the old row by pointing
-- it at itself, insert, then repoint it at the new row. Nothing outside
-- the transaction ever observes the self-reference, and a failure at any
-- step rolls the whole thing back.
--
-- The same reasoning applies to the paste as a whole, which is why the
-- function takes every row at once. A paste is one act. Twenty-one rows
-- applied and one rejected is a state no analyst asked for and cannot
-- reason about; all or nothing is the only honest outcome.

CREATE OR REPLACE FUNCTION bjl_signals_paste_apply(
  p_engagement text,
  p_theme      text,
  p_rows       jsonb
)
-- Returns jsonb rather than a TABLE deliberately. RETURNS TABLE would
-- make `external_id` and `signal_id` plpgsql variables, and every bare
-- column reference of those names inside the body would silently
-- substitute the variable instead of the column. Every reference below is
-- qualified, but a future edit that forgets one would not fail loudly —
-- it would compare a column to itself and quietly supersede the wrong
-- row. Removing the names removes the trap.
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r        jsonb;
  v_live   bjl_marketplace_signals%ROWTYPE;
  v_new_id integer;
  v_found  boolean;
  v_out    jsonb := '[]'::jsonb;
BEGIN
  IF p_engagement IS NULL OR btrim(p_engagement) = '' THEN
    RAISE EXCEPTION 'engagement is required';
  END IF;
  IF p_theme IS NULL OR btrim(p_theme) = '' THEN
    RAISE EXCEPTION 'theme is required';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'rows must be a json array';
  END IF;

  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP

    IF r->>'external_id' IS NULL OR btrim(r->>'external_id') = '' THEN
      RAISE EXCEPTION 'row with headline % has no external_id', coalesce(r->>'headline', '(none)');
    END IF;

    -- FOR UPDATE so two analysts pasting the same payload at once cannot
    -- both read "no live row" and both insert. The second waits, sees the
    -- first's row, and skips it as unchanged.
    SELECT * INTO v_live
      FROM bjl_marketplace_signals s
     WHERE s.engagement = p_engagement
       AND s.external_id = r->>'external_id'
       AND s.superseded_by IS NULL
     FOR UPDATE;
    v_found := FOUND;

    IF v_found THEN
      -- Unchanged means every MAPPED CONTENT column matches. Two columns
      -- are deliberately excluded from that comparison:
      --
      -- captured_at, because a re-capture on a later date is not a
      -- revision. Waldo stamps every payload with the day it ran, so
      -- including it would make every row of every re-paste a revision
      -- and turn the chain into a paste counter.
      --
      -- raw, because raw is where the interpretation fields land —
      -- why_it_matters, relevance, owned_property — and those are never
      -- citable as evidence. A change to a field no card may quote is
      -- not a change to the record.
      IF  v_live.theme        IS NOT DISTINCT FROM p_theme
      AND v_live.signal_type  IS NOT DISTINCT FROM (r->>'signal_type')
      AND v_live.headline     IS NOT DISTINCT FROM (r->>'headline')
      AND v_live.detail       IS NOT DISTINCT FROM (r->>'detail')
      AND v_live.exact_quote  IS NOT DISTINCT FROM (r->>'exact_quote')
      AND v_live.urgency      IS NOT DISTINCT FROM (r->>'urgency')
      AND v_live.source_url   IS NOT DISTINCT FROM (r->>'source_url')
      AND v_live.owned_source IS NOT DISTINCT FROM coalesce((r->>'owned_source')::boolean, false)
      THEN
        -- jsonb_build_array, not bare ||. Concatenating an array with an
        -- object relies on an implicit wrap that reads like a merge.
        v_out := v_out || jsonb_build_array(jsonb_build_object(
          'external_id', v_live.external_id,
          'signal_id',   v_live.signal_id,
          'outcome',     'unchanged'));
        CONTINUE;
      END IF;

      -- Retire the live row by pointing it at itself, so it leaves the
      -- partial unique index and the insert below has room. See the note
      -- at the top: this value is overwritten three statements later and
      -- is never visible outside this transaction.
      UPDATE bjl_marketplace_signals
         SET superseded_by = v_live.signal_id
       WHERE bjl_marketplace_signals.signal_id = v_live.signal_id;
    END IF;

    INSERT INTO bjl_marketplace_signals (
      engagement, source, theme, external_id, signal_type, headline,
      detail, exact_quote, urgency, source_url, owned_source,
      captured_at, raw
    ) VALUES (
      p_engagement,
      'waldo',
      p_theme,
      r->>'external_id',
      r->>'signal_type',
      r->>'headline',
      r->>'detail',
      r->>'exact_quote',
      r->>'urgency',
      r->>'source_url',
      coalesce((r->>'owned_source')::boolean, false),
      (r->>'captured_at')::date,
      r->'raw'
    )
    RETURNING signal_id INTO v_new_id;

    IF v_found THEN
      UPDATE bjl_marketplace_signals
         SET superseded_by = v_new_id
       WHERE bjl_marketplace_signals.signal_id = v_live.signal_id;
    END IF;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'external_id', r->>'external_id',
      'signal_id',   v_new_id,
      'outcome',     CASE WHEN v_found THEN 'revised' ELSE 'inserted' END));

  END LOOP;

  RETURN v_out;
END $$;

COMMENT ON FUNCTION bjl_signals_paste_apply(text, text, jsonb) IS
  'Applies one Waldo signals payload atomically. Returns a jsonb array, one entry per input row, with outcome inserted|revised|unchanged. Unchanged rows are skipped so supersede chains record market movement, not paste count.';

-- The paste box runs as the service role. anon and authenticated get
-- nothing: a grant to authenticated would open a write path into the
-- signals table that does not go through the handler's validation, which
-- is where the id rules and the collision guard live.
--
-- bjl_agent_readonly is on this list for a sharper reason, found during
-- the ACL check on apply. Default privileges had already granted it
-- EXECUTE, which means a SECURITY DEFINER function is a hole in a
-- read-only role: the investigator's SQL agent cannot write to
-- bjl_marketplace_signals, but it could have CALLED something that
-- writes on its behalf, with the definer's rights. Revoking from PUBLIC
-- does not touch a grant made directly to a role, so the read-only agent
-- would have kept it silently.
--
-- Every future SECURITY DEFINER function inherits the same default
-- grant. Remembering this line each time is the weak version; see the
-- note below the GRANT.
REVOKE ALL ON FUNCTION bjl_signals_paste_apply(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION bjl_signals_paste_apply(text, text, jsonb) FROM anon, authenticated;
REVOKE ALL ON FUNCTION bjl_signals_paste_apply(text, text, jsonb) FROM bjl_agent_readonly;
GRANT EXECUTE ON FUNCTION bjl_signals_paste_apply(text, text, jsonb) TO service_role;

-- NOT RUN HERE — the standing version of this revoke was deliberately
-- left for its own migration so it would land as a decision rather than
-- as a side effect of shipping the paste box. It has since landed, in
-- 2026-08-03_lock_definer_write_functions.sql:
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     REVOKE EXECUTE ON FUNCTIONS FROM bjl_agent_readonly;
--
-- After it, the read-only agent gets EXECUTE only where someone wrote a
-- GRANT on purpose. It is not retroactive, so the line above is still
-- doing real work for this function and is not redundant with it.
