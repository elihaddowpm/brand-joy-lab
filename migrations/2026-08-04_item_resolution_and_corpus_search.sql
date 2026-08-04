-- 2026-08-04 — Ground the corpus arm in real item_ids, and open the
-- adjudication worklist that closes the gap it can't close itself.
--
-- WHY THIS EXISTS
--
-- Generation v1 (piece 3) has a rail: claim_items gets the source item_ids.
-- There was no path to an item_id. Blocks carry rendered prose, the corpus
-- arm returned names only, and across the 30 most recent completed runs, of
-- 141 scratch query entries, zero carried an item_id. Not a low rate — none.
--
-- The obvious fix does not work. bjl_scores has no item_id; it has
-- question_id and item_name. bjl_items has both. But the pair
-- (question_id, item_name) — which IS unique across all 5,688 bjl_items
-- rows — resolves only 21 of 205 eligible corpus rows, because the two
-- question_id columns mean different things:
--
--   bjl_scores.question_id  = the question asked in that wave
--   bjl_items.question_id   = the item's originating question
--
-- Same item, same topic, overlapping id spaces (1-446 vs 1-478), different
-- meaning. Joining them is wrong, not broken. So this migration does not
-- pretend a join exists.
--
-- Resolution falls back to item_name, which is honest but incomplete:
-- of 205 eligible rows, 122 resolve to exactly one item and 83 do not.
-- Those 83 span 33 distinct names. primary_topic does not help — it
-- disambiguates exactly zero of the 33 and eliminates none, because the
-- duplicate items share the topic.
--
-- THE RULING (option C — resolve where unique, refuse where not, loudly)
--
-- The arm returns item_id where it can and a per-row `resolution` status
-- always, so a refusal is a visible verdict rather than a silent absence.
-- Unresolved rows cannot ground a measured draft, and per the row-level
-- exclusion rule they contribute nothing to a draft at all — not to
-- claim_items, and not to claim_summary either. A card must never cite
-- evidence its audit trail disowns.
--
-- The names that cannot resolve become a worklist rather than a hole, and
-- an adjudication is a decision, so it persists with provenance
-- (resolved_by / resolved_at, same discipline as promoted_by). The arm
-- reads the worklist, so a human adjudication immediately widens what the
-- next draft can ground. That is what makes this a road to a repaired
-- substrate rather than a parking lot.
--
-- SEED SCOPE. The 33 above is only the slice visible at the arm's default
-- thresholds (joy_scale, n>=100, score>=60). Across every name the arm can
-- reach at any threshold there are 366 ambiguous names, so the worklist is
-- seeded to all 366. Seeding the full set means the arm never needs to
-- write, which is what keeps it STABLE and free of definer's rights.
--
-- The seed carries candidate ids only. It deliberately does NOT populate
-- the resolution triple: candidate_item_ids is derived from the data and is
-- therefore a fact, while any choice among the candidates is a judgment.
-- Shipping 366 machine guesses wearing a human's provenance is precisely
-- the failure this worklist exists to prevent. resolved_by stays NULL until
-- a person puts their name in it.

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The adjudication worklist.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.bjl_item_resolutions (
  resolution_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- The ambiguity is name-level. bjl_scores rows key back to bjl_items by
  -- name alone, so the decision is "which item does this name mean," asked
  -- once and answered once.
  item_name          text        NOT NULL UNIQUE,

  -- Derived fact: every bjl_items.item_id sharing this name.
  candidate_item_ids integer[]   NOT NULL,

  -- Machine suggestion. May be pre-ranked from evidence (n, score
  -- proximity, wave overlap) to make the human act confirmation rather
  -- than research. Never a resolution.
  suggested_item_id  integer     REFERENCES public.bjl_items(item_id),
  suggestion_basis   jsonb,

  status             text        NOT NULL DEFAULT 'pending',

  -- The resolution triple. All three or none of them.
  resolved_item_id   integer     REFERENCES public.bjl_items(item_id),
  resolved_by        text,
  resolved_at        timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bjl_item_resolutions_status_chk
    CHECK (status IN ('pending', 'resolved', 'unresolvable')),

  -- A resolution is only a resolution when it is attributable. 'pending'
  -- and 'unresolvable' carry no triple at all, so a half-filled row cannot
  -- masquerade as a decision.
  CONSTRAINT bjl_item_resolutions_triple_chk
    CHECK (
      (status = 'resolved'
        AND resolved_item_id IS NOT NULL
        AND resolved_by      IS NOT NULL
        AND resolved_at      IS NOT NULL)
      OR
      (status <> 'resolved'
        AND resolved_item_id IS NULL
        AND resolved_by      IS NULL
        AND resolved_at      IS NULL)
    ),

  -- You cannot resolve to an item that was never a candidate. Without this
  -- the worklist would accept an id from anywhere and the arm would serve
  -- it as grounded evidence.
  CONSTRAINT bjl_item_resolutions_candidate_chk
    CHECK (resolved_item_id IS NULL OR resolved_item_id = ANY (candidate_item_ids)),

  CONSTRAINT bjl_item_resolutions_suggestion_chk
    CHECK (suggested_item_id IS NULL OR suggested_item_id = ANY (candidate_item_ids))
);

CREATE INDEX IF NOT EXISTS bjl_item_resolutions_pending
  ON public.bjl_item_resolutions (status)
  WHERE status = 'pending';

COMMENT ON TABLE public.bjl_item_resolutions IS
  'Adjudication worklist for corpus item names that map to more than one '
  'bjl_items row. bjl_corpus_search reads status=''resolved'' rows to ground '
  'item_id. Seeded with candidates only; the resolution triple is filled by '
  'a human and is what backfills a real item_id column onto bjl_scores later.';

COMMENT ON COLUMN public.bjl_item_resolutions.suggested_item_id IS
  'Machine pre-ranking, for confirmation. Never read by bjl_corpus_search — '
  'only resolved_item_id grounds a claim.';

-- Default-deny, matching every other core table.
ALTER TABLE public.bjl_item_resolutions ENABLE ROW LEVEL SECURITY;

-- Fail-closed: born callable by the server and nobody else. Deliberate,
-- not inherited — the default privileges for postgres in this schema were
-- revoked from anon and authenticated on 2026-08-03.
REVOKE ALL ON TABLE public.bjl_item_resolutions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.bjl_item_resolutions TO service_role;

-- The investigator's read-only role gets SELECT so it can see WHY a row
-- refused to ground, and nothing more. It never adjudicates.
GRANT SELECT ON TABLE public.bjl_item_resolutions TO bjl_agent_readonly;

-- ---------------------------------------------------------------------
-- 2. Seed the worklist. Idempotent.
-- ---------------------------------------------------------------------

INSERT INTO public.bjl_item_resolutions (item_name, candidate_item_ids)
SELECT n.item_name, c.ids
  FROM (
    SELECT DISTINCT s.item_name
      FROM public.bjl_scores s
     WHERE s.joy_index IS NOT NULL
  ) n
  CROSS JOIN LATERAL (
    SELECT array_agg(i.item_id ORDER BY i.item_id) AS ids
      FROM public.bjl_items i
     WHERE i.item_name = n.item_name
  ) c
 WHERE array_length(c.ids, 1) > 1
ON CONFLICT (item_name) DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. The corpus arm, widened to carry identity.
-- ---------------------------------------------------------------------
--
-- DROP/CREATE rather than CREATE OR REPLACE: the return type changes, and
-- Postgres will not replace a function's OUT columns in place.
--
-- CALLER AUDIT. Nothing consumes this positionally or via SELECT * into a
-- fixed shape. The consumers are:
--   netlify/functions/bjl-cross-domain-provenance-guard.js — reads named
--     keys off scratch rows; ignores unknown keys, so extra columns are
--     inert to it.
--   netlify/functions/bjl-query-background.js — prompt text enumerating
--     the columns the model may copy.
--   prompts/investigator_prompt_v3.md, prompts/synthesizer_prompt_v3.md —
--     document the return shape.
-- The three text surfaces are updated in the same change as this file.
--
-- GRANTS. DROP FUNCTION destroys the ACL, and since the 2026-08-03 default
-- privileges flip, CREATE will not restore it. Every grant below is
-- therefore deliberate and must stay. The pre-drop ACL was:
--   PUBLIC=X, postgres=X, anon=X, authenticated=X, service_role=X,
--   bjl_agent_readonly=X
-- It is restored MINUS the blanket PUBLIC grant, which the enumerated
-- roles already cover. bjl_agent_readonly is not optional — it is the
-- investigator's role and this arm's primary caller.

DROP FUNCTION IF EXISTS public.bjl_corpus_search(text, text[], text[], text[], text[], numeric, integer, integer);

CREATE FUNCTION public.bjl_corpus_search(
  target_topic          text     DEFAULT NULL::text,
  joy_mode_filter       text[]   DEFAULT NULL::text[],
  functional_job_filter text[]   DEFAULT NULL::text[],
  tension_filter        text[]   DEFAULT NULL::text[],
  question_type_filter  text[]   DEFAULT ARRAY['joy_scale'::text],
  min_score             numeric  DEFAULT 60,
  min_n                 integer  DEFAULT 100,
  limit_n               integer  DEFAULT 20
)
RETURNS TABLE(
  item_name     text,
  primary_topic text,
  question_type text,
  score         numeric,
  n             integer,
  item_id       integer,
  resolution    text
)
LANGUAGE sql
STABLE
AS $function$
  WITH hits AS (
    SELECT
      s.item_name,
      s.item_topic    AS primary_topic,
      s.question_type AS question_type,
      ROUND(s.joy_index, 1)::numeric AS score,
      s.n,
      s.joy_index
    FROM bjl_scores s
    WHERE
      -- At least one meaningful filter must be present. All-NULL calls are
      -- inert, so the investigator can never scan the whole corpus by
      -- accident.
      (
        target_topic IS NOT NULL
        OR joy_mode_filter IS NOT NULL
        OR functional_job_filter IS NOT NULL
        OR tension_filter IS NOT NULL
      )
      AND (target_topic IS NULL OR s.item_topic = target_topic)
      AND (joy_mode_filter IS NULL OR s.joy_modes @> joy_mode_filter)
      AND (functional_job_filter IS NULL OR s.functional_jobs @> functional_job_filter)
      AND (tension_filter IS NULL OR s.tensions @> tension_filter)
      AND (question_type_filter IS NULL OR s.question_type = ANY(question_type_filter))
      AND s.joy_index IS NOT NULL
      AND s.joy_index >= min_score
      AND s.n >= min_n
  ),
  candidates AS (
    SELECT
      h.*,
      (SELECT array_agg(i.item_id ORDER BY i.item_id)
         FROM bjl_items i
        WHERE i.item_name = h.item_name) AS cand_ids
    FROM hits h
  )
  SELECT
    c.item_name,
    c.primary_topic,
    c.question_type,
    c.score,
    c.n,
    -- One candidate is identity. More than one is identity only once a
    -- human has said so. Never a guess in either case.
    CASE
      WHEN array_length(c.cand_ids, 1) = 1 THEN c.cand_ids[1]
      ELSE r.resolved_item_id
    END AS item_id,
    CASE
      WHEN array_length(c.cand_ids, 1) = 1        THEN 'unique'
      WHEN r.resolved_item_id IS NOT NULL         THEN 'adjudicated'
      WHEN c.cand_ids IS NULL                     THEN 'unmatched'
      ELSE                                             'ambiguous'
    END AS resolution
  FROM candidates c
  LEFT JOIN bjl_item_resolutions r
         ON r.item_name = c.item_name
        AND r.status = 'resolved'
  ORDER BY c.joy_index DESC, c.n DESC
  LIMIT GREATEST(1, LEAST(limit_n, 100));
$function$;

COMMENT ON FUNCTION public.bjl_corpus_search(text, text[], text[], text[], text[], numeric, integer, integer) IS
  'Lateral corpus search. Returns item identity alongside the numbers: '
  'item_id is non-null only when the name maps to exactly one item '
  '(resolution=unique) or a human adjudicated it (resolution=adjudicated). '
  'resolution=ambiguous or unmatched means item_id is NULL and the row '
  'cannot ground a measured claim — the row is excluded from a generated '
  'draft entirely, not merely from claim_items.';

REVOKE ALL ON FUNCTION public.bjl_corpus_search(text, text[], text[], text[], text[], numeric, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bjl_corpus_search(text, text[], text[], text[], text[], numeric, integer, integer)
  TO anon, authenticated, service_role, bjl_agent_readonly;

-- ---------------------------------------------------------------------
-- 4. Make evidence tier and audit trail agree.
-- ---------------------------------------------------------------------
--
-- schema_doc claimed claim_items was blanket NOT NULL. That was wrong and
-- the database was right: a blanket rule outlaws signal-only cards, which
-- rest on signal_ids by definition. The honest constraint is tier-aware.
--
-- Note what this deliberately does NOT do: it cannot catch a claim_summary
-- that cites a figure whose row was dropped from claim_items, because it
-- only tests non-emptiness. That case is closed upstream by the row-level
-- exclusion rule in the generator, not here.

ALTER TABLE public.bjl_opportunities
  ADD CONSTRAINT bjl_opportunities_evidence_chk
  CHECK (
    (evidence_tier IN ('measured','modeled') AND claim_items IS NOT NULL AND array_length(claim_items,1) > 0)
    OR (evidence_tier = 'signal-only' AND signal_ids IS NOT NULL AND array_length(signal_ids,1) > 0)
    OR (evidence_tier = 'unmeasured')
  );

COMMIT;

-- Verification, for the apply:
--
--   SELECT count(*) FROM bjl_item_resolutions;                      -- expect 366
--   SELECT count(*) FROM bjl_item_resolutions WHERE status<>'pending'; -- expect 0
--
--   SELECT pg_get_function_result(oid) FROM pg_proc
--    WHERE proname='bjl_corpus_search';                             -- 7 columns
--
--   SELECT proacl FROM pg_proc WHERE proname='bjl_corpus_search';
--     -- expect postgres, anon, authenticated, service_role,
--     -- bjl_agent_readonly. NO bare "=X/postgres" PUBLIC entry.
--
--   SELECT resolution, count(*) FROM bjl_corpus_search(target_topic := 'food_beverage')
--    GROUP BY 1;   -- expect a mix of unique and ambiguous, no NULLs
