-- Migration: promote bjl_connectivity_ledger_v3 / bjl_conn_centered_v3 to be
-- the ledger the shipped code reads. Consumers rank on excess_r, per the
-- August 5 ruling — (ii) whole-instrument centering as the generator,
-- (i) excess over the mechanical floor as the reported metric.
--
-- APPLIED 2026-08-07, in six transactions, in this order:
--
--   connectivity_v3_promotion                        A1 A2 B1 B2 C1
--   connectivity_v3_promotion_part_e_cohort          E1 E2 E3
--   connectivity_v3_promotion_revoke_public_regression
--   connectivity_v3_lift_units_and_modeled_gate      F1 F2 G H
--   connectivity_v3_territory_profile_eligibility_gate  G2
--   connectivity_v3_lift_precision_two_decimals      I
--
-- The JS in Parts B3/B4/B5/D and the client changes ship in the same
-- commit as this file. Nothing here is committed until the reported-path
-- units, the eligibility flip and the 349 are verified independently.
--
-- v2 AND v1 CONTENTS ARE NOT TOUCHED BY THIS FILE. No DROP, no DELETE, no
-- UPDATE against bjl_connectivity_ledger, bjl_connectivity_ledger_v2,
-- bjl_conn_centered or bjl_conn_centered_v2. v2 remains the before-record
-- for the trade-off map and bulletin v1, including its two hand-corrected
-- rows. Everything below rewrites function bodies only.
--
--
-- ====================================================================
-- WHY THIS IS TWELVE SITES AND NOT THREE
-- ====================================================================
--
-- The promotion was scoped as "three consumers: trade-off map, bulletin
-- gen v1, and the front-door.js:321 sort." Checked against live, that is
-- not the shape of it.
--
--   front-door.js:321 IS NOT A LEDGER CONSUMER. It reads
--   bjl_conn_centered_v2 in an EXISTS producing `in_centered`, used only
--   as a shortlist sort key (ORDER BY in_centered DESC, hit_count DESC,
--   name_len ASC). No r, no excess_r, no pair. The comment above it at
--   bjl-front-door.js:295 calls that table "the scored ledger", which is
--   where the name came from. Left alone by this file.
--
--   The trade-off map and bulletin v1 are analysis artifacts, not code
--   paths. Nothing in the repo or the database thresholds tensions at
--   all — no consumer reads the 200 set. (bjl_tensions is 15 curated
--   rows and is unrelated to the ledger.)
--
-- What actually reads the ledger or the centered grid, from pg_proc and
-- from the netlify functions. The count went 3 -> 6 -> 7 -> 9 -> 12 as
-- each site turned up a dependency the one before it hid:
--
--   SITE                                          WAS   PART
--   --------------------------------------------------------------
--   bjl_joy_map_sweep_v2                          v2     A1
--   bjl_territory_roster                          v2     A2
--   bjl_item_capability                           v1     B1
--   bjl_item_edges                                v1     B2
--   bjl-front-door.js:598  in_ledger_ids          v1     B3 (JS)
--   connections-beta.js:229 bjl_pair_plain call   v1     B4 (JS)
--   connections-beta.js fetchItemSkew             v1     B5 (JS)
--   bjl_pair_plain_v2                             v2     C1
--   three membership-only reads of a v2 grid      v2     D  (JS)
--   bjl_map_cohort                                v2     E1
--   bjl_joy_map_modeled                           v2     E2
--   bjl_territory_profile                         v2     E3
--   bjl_joy_map_sweep, bjl_pair_plain             v1     not done
--
-- FIVE OF THE TWELVE WERE ON v1, NOT v2. STATE.md's note that the
-- consumers read v2 is true of the analysis artifacts and false of the
-- shipped code, which was mostly a version behind that.
--
-- The last four of the first nine were not visible from the ledger grep
-- that produced the first six. B4 and B5 read the centered grid rather
-- than the ledger and surfaced only when Part B changed what the edges
-- above them contain; C1 the same. Each was found by asking what the site
-- I had just edited depends on, not by a wider search — which is the only
-- method that would have found them, and is why the count kept moving.
--
-- HOW THE LAST THREE WERE FOUND, AND WHY THEY NEARLY SHIPPED BROKEN.
-- E1/E2/E3 were not in the inventory at all when A and C were applied.
-- They read bjl_conn_centered_v2 for COMPUTATION, not for membership, so
-- neither the ledger grep nor the centered-grid membership sweep in Part
-- D reached them. bjl_joy_map_modeled is joined to bjl_joy_map_sweep_v2
-- inside a query string in bjl-joy-map-connections.js:
--
--     FROM bjl_joy_map_sweep_v2(...) s
--     JOIN bjl_joy_map_modeled(...) m USING (ord, territory)
--
-- Applying A and C without E therefore put a v3-centered correlation
-- beside a v2-centered cohort IN THE SAME ROW — the exact incoherence
-- Part C exists to prevent, one join further up than the inventory
-- looked.
--
-- It was caught because post-apply check 1 asserts the COMPLETE expected
-- set of remaining pre-v3 readers and got five where it expected two. A
-- check phrased as "no v1 names remain" would have passed and shipped it.
-- Write the assertion against the whole expected set, not against the
-- absence of a bad pattern.
--
-- Check 1 had a second bug of the same family, found on the re-run: it
-- searched for `bjl_connectivity_ledger_v1` and `bjl_conn_centered_v1`.
-- Those names do not exist. The v1 tables are UNSUFFIXED —
-- bjl_connectivity_ledger and bjl_conn_centered — so the check matched
-- nothing and reported a clean board. The corrected form is in check 1
-- below and must stay word-bounded, or `bjl_conn_centered` also matches
-- `bjl_conn_centered_v3` and every function looks like a v1 reader.
--
--
-- ====================================================================
-- THE BUG THIS CLOSES, WHICH WAS NOT WHY THE PROMOTION WAS SCOPED
-- ====================================================================
--
--   v1    60,401 pairs      880 items
--   v2   115,144 pairs    1,229 items
--   v3   115,144 pairs    1,229 items
--
-- v1 is a STRICT SUBSET of v3: 349 items are in v3 and not in v1, zero
-- the other way. Every site in Part B gates measurability on v1, so the
-- front door has been telling strategists, for those 349 items:
--
--     "No resolved item cleared the 50-respondent floor to enter the
--      connectivity ledger."                    bjl-front-door.js:755
--
-- That is false for all 349, and not marginally. Probed against v3:
--
--     items in v3 and not v1                    349
--     of those, absent from bjl_conn_centered_v3  0
--     of those, under the 50-respondent floor     0
--     of those, at or over the floor             349
--     respondent count   min 129   avg 1,142   max 11,443
--
-- The weakest of the 349 carries 129 respondents — 2.6x the floor it is
-- currently being told it failed. After Part B the message stops firing
-- for all of them, and where it does still fire it is true.
--
-- Related, and repaired in B1 rather than merely noted: bjl_item_capability
-- returns a column called `in_ledger` that was computed from centered-grid
-- membership (n.cnt IS NOT NULL), not from the ledger. The name asserts
-- the ledger and the front-door copy quoted above asserts the ledger, so
-- B1 derives it from the ledger. Verified a no-op on today's data — the
-- v3 centered grid and the v3 ledger cover an identical 1,229 items, 0
-- either way — so this changes the definition without changing a value.
--
--
-- ====================================================================
-- WHAT CHANGES FOR A READER, r -> excess_r
-- ====================================================================
--
-- excess_r = r - floor_r, and floor_r is negative everywhere
-- (min -0.0288, avg -0.0083, max -0.0050). So excess_r > r for every one
-- of the 115,144 pairs, and the shifts are one-directional:
--
--     pairs flipping "runs against" -> "rises with"      2,516
--     pairs flipping "rises with" -> "runs against"          0
--     crossing the 0.08 flat cut, flat -> measured        1,349
--     crossing the 0.08 flat cut, measured -> flat        3,017
--
-- Net 1,668 more territory-lead candidates read as flat. This is the
-- ruling working, not a regression: a pair whose entire negative signal
-- was the mechanical floor should read flat. But it is a visible change
-- to what the joy map calls measured, and it is here so that nobody
-- discovers it as a surprise.
--
-- Threshold, reproduced cold on v3:
--
--     excess_r <= -0.40      200      the promoted headline
--     excess_r <= -0.35      580
--     v2 raw r <= -0.35      648
--
-- And the retired figure: 1,364 corresponds to no clean cut on v2.
-- v2 r <= -0.35 gives 648, <= -0.33 gives 936, <= -0.32 gives 1,141,
-- <= -0.30 gives 1,667. 1,364 implies approximately -0.313. Nobody can
-- source it because it is not a threshold anybody would have chosen.
-- Ship gate condition #2 closes on that: retired, with a reason.
--
--
-- ====================================================================
-- A LIVE BREAK THIS TURNED UP, WHICH IS NOT PART OF THE PROMOTION
-- ====================================================================
--
-- connections-beta.js fetchItemSkew HAS NEVER RUN. It selected `c` from
-- bjl_conn_centered, whose value column is `cj`:
--
--     ERROR: 42703: column "c" does not exist
--
-- Confirmed by running the function's own query string verbatim against
-- live. fetchItemSkew throws, the throw is uncaught at its call site
-- (connections-beta.js:549) and lands in the handler catch, so every
-- request that resolves focals and finds edges fails there. The pane is
-- wired up — index.html:7156 fetches it — so this is live.
--
-- The consequence beyond the 500: skew suppression has never suppressed
-- anything. pct_move_together is supposed to be withheld when an item's
-- distribution is skewed past 25/75 because the metric stops meaning
-- anything, and that guard has never fired.
--
-- Fixed in B5 rather than filed, because B5 rewrites that exact query to
-- move it to v3 and the column fix is the same edit. Splitting it would
-- mean repointing a query that has never executed and calling it done.
-- Flagged here at length so it is not read as part of the promotion — it
-- predates v3 and would be a bug against v2 and v1 equally.
--
-- AND THE GATE SHIPS OFF. B5 makes the query run; it does NOT make the
-- suppression bite. SKEW_GATE_ENFORCED = false.
--
-- The reason is that "fix a never-executed query" and "turn on a guard
-- for the first time" look like one change and are two, and the second
-- one is much larger than it reads. Measured against live once the query
-- worked:
--
--     items tripping 25/75    328 / 1,229        26.7%
--     pairs losing their pct  45,781 / 115,144   39.8%
--     pct_positive spread     median 54.0, mean 53.0
--       <10: 26 | 10-25: 113 | 25-40: 219 | 40-60: 392
--       60-75: 290 | 75-90: 151 | >90: 38
--
-- 25/75 was written blind — it could never have been validated, because
-- the query it depends on never returned a row. The genuinely
-- pathological tail (<10 or >90) is 64 items. The threshold as written is
-- about five times wider than the problem it describes, and enabling it
-- here would pull the pct line off two of every five cards in the same
-- deploy as four other user-visible changes. Nobody could then tell a
-- skew suppression from a v3 artefact, which is exactly the diagnosis
-- this promotion would need if something looked wrong.
--
-- So: the flag is computed, carried on the card as
-- pct_move_together_skew_flagged, written into rInternalLog as
-- pct_skew_flagged, and logged per request as a flagged/total count. That
-- gives a live "before" at real query shapes. The threshold ruling —
-- 25/75 vs 10/90 vs something else — happens separately, against that
-- distribution and a measured before/after. Turning the gate on is a
-- user-visible change in its own right and carries its own comms line.
--
-- USER-VISIBLE CHANGES IN THIS DEPLOY: 4. Cards losing the pct line: 0.
--
-- WHAT THE PRE-DEPLOY BROWSER CHECK DID AND DID NOT COVER. It covered the
-- JOY MAP connections pane (index.html:4965 ->
-- bjl-joy-map-connections.js), which renders 24 cards cleanly. That
-- function has no skew lookup and never calls bjl_pair_plain — it reads
-- bjl_joy_map_sweep_v2 and bjl_conn_centered_v3 directly. It is a
-- different surface from the connections-beta pane.
--
-- The CONNECTIONS-BETA pane (index.html:7168 ->
-- bjl-connections-beta.js) was NOT exercised in the browser, and cannot
-- be pre-deploy, because it is the surface that 500s: the deployed
-- fetchItemSkew selects `c` from bjl_conn_centered, whose columns are
-- (respondent_id, item_id, cj) — re-confirmed against live
-- information_schema, not inferred. Any request reaching that line
-- fails. So there is no working "before" to compare against; B5 is the
-- thing that makes the surface reachable at all, and its verification is
-- necessarily post-deploy.
--
-- Do not read "connections pane renders" in the check log as covering
-- this one. Two panes, similar names, different functions.
--
--
-- ====================================================================
-- NOT DONE, DELIBERATELY
-- ====================================================================
--
-- bjl_joy_map_sweep (v1) and bjl_pair_plain (v1) still read v1 and are
-- left there.
--
-- Stated precisely, because the first draft of this file got it wrong:
-- bjl_pair_plain was NOT dead when this work started. connections-beta.js
-- called it at line 229, and I wrote "neither has a caller" before
-- checking. It becomes dead only because B4 repoints that call site to
-- bjl_pair_plain_v2. bjl_joy_map_sweep was and is genuinely uncalled —
-- it is the domain-model predecessor of _v2 and joins bjl_map_domains,
-- which the territory model superseded.
--
-- So after this file both are uncalled, and both stay on v1. Repointing
-- dead code to v3 would make a v1-era function look current, which is the
-- exact failure this arc keeps hitting — a name that implies a version it
-- does not have. Left as the v1 record for the same reason v2 is
-- preserved. Two REPLACEs away if wanted.
--
--
-- ====================================================================
-- ORDER, AND WHAT EACH PART CAN BE VERIFIED AGAINST ALONE
-- ====================================================================
--
--   PART A   the two v2 sites          joy map territory reads
--   PART B   the v1 sites              front door + connections pane,
--                                      closes the 349
--   PART C   bjl_pair_plain_v2         provenance numbers under the map
--   PART D   membership-only swaps     no-ops, verified as such
--   PART E   the cohort spine          bjl_map_cohort, _modeled, _profile
--   PART F   fam_scale removal         the reported path stops inverting
--                                      a standardisation that no longer
--                                      applies
--   PART G   eligible = false          modeled tier off pending recalibration
--   PART G2  the gate that G needed     bjl_territory_profile had no
--                                      eligibility gate for G to act on
--   PART H   prediction unit stamp     protects the pre-registered rows
--   PART I   lift precision 1 -> 2 dp  the unit shrank 46.7x; the display
--                                      contract had to follow
--
-- PLUS ONE REVOKE THAT IS NOT A PART AND MUST NOT BE DROPPED. A1 and B2
-- are DROP/CREATE, not CREATE OR REPLACE, because they change an output
-- column name. CREATE FUNCTION grants EXECUTE TO PUBLIC by default, and
-- re-granting the three named roles does NOT undo that: the August 6
-- lockdown was expressed as the ABSENCE of a `=X/postgres` entry in the
-- proacl, and an absence cannot be restored by granting what is present.
-- Post-apply check 2 caught anon = true on both functions, exposing
-- excess_r and excess_r_internal, which the design states never leave the
-- server. Closed by an explicit REVOKE EXECUTE ... FROM PUBLIC on both.
--
--     RULE: after any DROP/CREATE of a locked-down function, pair it with
--     REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC and re-verify the proacl
--     byte-for-byte against the pre-drop value. Named-role GRANTs are not
--     sufficient. Every CREATE OR REPLACE in this file (A2, B1, C1, E, F,
--     G2, I) preserves the ACL and needs no REVOKE.
--
-- A, B and C are independently applicable and independently reversible —
-- each is a self-contained CREATE OR REPLACE (or DROP/CREATE + GRANT)
-- against one function. B is the one that fixes a live wrong answer.
--
-- READ THE HEADER ON PART C BEFORE APPLYING A WITHOUT IT. C is not
-- optional in the way A and B are optional relative to each other: A
-- moves the sweep's correlation to v3 while C moves the numbers printed
-- beside it, and applying one without the other puts two centerings in
-- one row.
--
-- THE JS CHANGES SHIP WITH THE SQL, NOT BEFORE OR AFTER. B2 renames an
-- output column, so bjl-connections-beta.js and the database have to move
-- together or fetchEdges reads undefined. The staged JS:
--
--   B3  bjl-front-door.js          in_ledger_ids -> ledger_v3
--   B4  bjl-connections-beta.js    bjl_pair_plain -> bjl_pair_plain_v2
--   B5  bjl-connections-beta.js    fetchItemSkew -> centered_v3, and the
--                                  `c` -> `cz` fix (see the section above).
--                                  Gate ships OFF: SKEW_GATE_ENFORCED
--                                  = false, flag computed not applied.
--   B2' bjl-connections-beta.js    fetchEdges reads excess_r, and the
--                                  scratch log keys follow the rename
--   D   bjl-joy-map-connections.js filterEligibleFocals + rungBAnchors
--       bjl-front-door.js          the in_centered sort key
--       index.html / comments      r_internal -> excess_r_internal
--
-- PART D IS A NO-OP AND WAS VERIFIED AS ONE BEFORE BEING WRITTEN. All
-- three are membership tests against the centered grid, and v2 and v3
-- cover an identical 1,229 items — 0 in one and not the other. They are
-- in scope only so that no app-code path still names a v2 object once the
-- promotion lands; the alternative is leaving three v2 references behind
-- and a claim that nothing reads v2, which is the kind of straggler that
-- started this. (One caveat inside D: rungBAnchors also counts centered
-- rows to break ties, and v3 has 1,452,629 cells against v2's 1,452,730.
-- The 101-row difference is the August 4 dedup, so the v3 count is the
-- more correct tiebreak, but it is not literally identical and is called
-- out here rather than filed under "no-op".)


BEGIN;


-- ====================================================================
-- PART A1 — bjl_joy_map_sweep_v2, the joy map territory sweep
-- ====================================================================
--
-- ledger_v2 -> ledger_v3, and every rank, threshold and direction test
-- moves from r to excess_r.
--
-- DROP/CREATE rather than REPLACE because the output column r_internal is
-- renamed to excess_r_internal. Leaving the name would put excess_r in a
-- column called r, which is the mislabel class this whole file exists to
-- stop. Safe to rename: bjl-joy-map-connections.js selects s.* and never
-- reads the column, index.html:5242 states "r_internal never renders",
-- and bjl-joy-map-connections.js:119 states it never leaves the server.
--
-- DROP DISCARDS THE ACL. Re-granted explicitly below, matching the ACL
-- read off pg_proc before the drop:
--   {postgres=X/postgres, service_role=X/postgres, bjl_agent_readonly=X/postgres}
-- Nothing is granted to anon or authenticated, which is the post-lockdown
-- posture from 2026-08-06_read_lockdown_allowlist_sweep.sql and is
-- deliberate — this function is reached through a netlify function running
-- as service_role, never from the browser.

DROP FUNCTION IF EXISTS public.bjl_joy_map_sweep_v2(integer[]);

CREATE FUNCTION public.bjl_joy_map_sweep_v2(p_focal integer[])
RETURNS TABLE(
  ord integer, territory text, row_kind text, verdict text, direction text,
  focal_item text, other_item text, other_family text,
  shared_answerers bigint, pct_move_together numeric, lift_points numeric,
  excess_r_internal numeric, pairs_behind bigint, territory_magnitude numeric
)
LANGUAGE sql
STABLE
AS $function$
  WITH focal_qs AS (
    SELECT i.question_id FROM bjl_items i JOIN bjl_questions_v2 q ON q.question_id = i.question_id
    WHERE i.item_id = ANY(p_focal) GROUP BY i.question_id
    HAVING (SELECT count(*) FROM bjl_items i2 WHERE i2.question_id = i.question_id) < 40
  ),
  edges AS (
    SELECT it.territory_key,
           CASE WHEN l.item_a = f.f_id THEN l.item_a ELSE l.item_b END AS focal_id,
           CASE WHEN l.item_a = f.f_id THEN l.item_b ELSE l.item_a END AS other_id,
           CASE WHEN l.item_a = f.f_id THEN l.scale_b ELSE l.scale_a END AS other_fam,
           l.n_pair, l.excess_r
    FROM unnest(p_focal) AS f(f_id)
    JOIN bjl_connectivity_ledger_v3 l ON f.f_id IN (l.item_a, l.item_b)
    JOIN bjl_item_territory it ON it.item_id = CASE WHEN l.item_a = f.f_id THEN l.item_b ELSE l.item_a END
    JOIN bjl_items oi ON oi.item_id = CASE WHEN l.item_a = f.f_id THEN l.item_b ELSE l.item_a END
    WHERE l.excess_r IS NOT NULL AND it.territory_key <> 'unassigned'
      AND NOT (CASE WHEN l.item_a = f.f_id THEN l.item_b ELSE l.item_a END = ANY(p_focal))
      AND oi.question_id NOT IN (SELECT question_id FROM focal_qs)
  ),
  depth AS (
    SELECT territory_key, count(*) AS pairs_behind FROM edges WHERE other_fam='joy' GROUP BY 1
  ),
  mag AS (
    SELECT it.territory_key, round(avg(r.joy_index),1) AS territory_magnitude
    FROM bjl_item_territory it JOIN bjl_responses r ON r.item_id = it.item_id
    WHERE r.joy_index IS NOT NULL GROUP BY 1
  ),
  joy_ranked AS (
    SELECT e.*, row_number() OVER (PARTITION BY territory_key ORDER BY abs(excess_r) DESC) AS rk
    FROM edges e WHERE other_fam = 'joy'
  ),
  x_ranked AS (
    SELECT e.*, row_number() OVER (PARTITION BY territory_key ORDER BY abs(excess_r) DESC) AS rk
    FROM edges e WHERE other_fam <> 'joy'
  ),
  picked AS (
    SELECT territory_key, 'joy_lead' AS row_kind, focal_id, other_id, other_fam, n_pair, excess_r FROM joy_ranked WHERE rk = 1
    UNION ALL
    SELECT territory_key, 'joy_runner_up', focal_id, other_id, other_fam, n_pair, excess_r FROM joy_ranked WHERE rk IN (2,3) AND abs(excess_r) >= 0.10
    UNION ALL
    SELECT territory_key, 'attitude_intent', focal_id, other_id, other_fam, n_pair, excess_r FROM x_ranked WHERE rk = 1
  )
  SELECT t.ord, t.territory_name,
    coalesce(p.row_kind, 'joy_lead'),
    CASE WHEN p.territory_key IS NULL THEN 'unmeasured'
         WHEN p.row_kind = 'joy_lead' AND abs(p.excess_r) < 0.08 THEN 'flat'
         ELSE 'measured' END,
    CASE WHEN p.excess_r > 0 THEN 'rises with' WHEN p.excess_r < 0 THEN 'runs against' ELSE NULL END,
    (SELECT item_name FROM bjl_items WHERE item_id = p.focal_id LIMIT 1),
    (SELECT item_name FROM bjl_items WHERE item_id = p.other_id LIMIT 1),
    p.other_fam,
    pl.shared_answerers, pl.pct_move_together, pl.lift_points, round(p.excess_r, 3),
    coalesce(d.pairs_behind, 0), m.territory_magnitude
  FROM bjl_territories t
  LEFT JOIN picked p ON p.territory_key = t.territory_key
  LEFT JOIN depth d ON d.territory_key = t.territory_key
  LEFT JOIN mag m ON m.territory_key = t.territory_key
  LEFT JOIN LATERAL bjl_pair_plain_v2(
      CASE WHEN p.other_fam = 'joy' THEN p.focal_id ELSE p.other_id END,
      CASE WHEN p.other_fam = 'joy' THEN p.other_id ELSE p.focal_id END
    ) pl ON p.territory_key IS NOT NULL
  ORDER BY t.ord, CASE p.row_kind WHEN 'joy_lead' THEN 1 WHEN 'joy_runner_up' THEN 2 ELSE 3 END, abs(p.excess_r) DESC
$function$;

GRANT EXECUTE ON FUNCTION public.bjl_joy_map_sweep_v2(integer[])
  TO postgres, service_role, bjl_agent_readonly;


-- ====================================================================
-- PART A2 — bjl_territory_roster, the roster provenance tap
-- ====================================================================
--
-- Membership only. No r anywhere in it, so there is no metric change —
-- this is a table swap and nothing else. Signature unchanged, so REPLACE
-- keeps the ACL.
--
-- Effect: the in_ledger flag beside each roster item stops being computed
-- against a 1,229-item ledger it already matched. Included for coherence
-- rather than for a fix — after this file, no function in public reads
-- bjl_connectivity_ledger_v2.

CREATE OR REPLACE FUNCTION public.bjl_territory_roster(p_territory_key text)
RETURNS TABLE(item_id integer, item_wording text, scale_family text, n integer, spread real, in_ledger boolean, basis text)
LANGUAGE sql
STABLE
AS $function$
  SELECT it.item_id, i.item_name, s.scale_family, s.n, s.spread,
         EXISTS (SELECT 1 FROM bjl_connectivity_ledger_v3 l WHERE it.item_id IN (l.item_a, l.item_b)),
         it.basis
  FROM bjl_item_territory it
  JOIN bjl_items i ON i.item_id = it.item_id
  LEFT JOIN bjl_item_spread s ON s.item_id = it.item_id
  WHERE it.territory_key = p_territory_key
  ORDER BY s.n DESC NULLS LAST
$function$;


-- ====================================================================
-- PART B1 — bjl_item_capability, the front door's measurability gate
-- ====================================================================
--
-- This is the one that closes the 349.
--
-- Two source swaps and one definition repair:
--
--   degree       bjl_connectivity_ledger    -> _v3
--   respondents  bjl_conn_centered          -> _v3
--   in_ledger    centered-grid membership   -> ledger membership
--
-- The third is the repair. The column is called in_ledger and the copy it
-- drives says "enter the connectivity ledger", but it was answering a
-- question about the centered grid. Verified identical on v3 today (1,229
-- items each way, 0 in one and not the other), so this is a definition
-- change with no value change — which is the only safe time to make one.
--
-- Signature unchanged. REPLACE keeps the ACL.

CREATE OR REPLACE FUNCTION public.bjl_item_capability(p_items integer[])
RETURNS TABLE(item_id integer, respondents bigint, in_ledger boolean, degree bigint)
LANGUAGE sql
STABLE
AS $function$
  WITH deg AS (
    SELECT i, count(*) AS d FROM (
      SELECT item_a AS i FROM bjl_connectivity_ledger_v3
      UNION ALL SELECT item_b FROM bjl_connectivity_ledger_v3) x
    GROUP BY 1
  )
  SELECT p.item_id,
         coalesce(n.cnt, 0) AS respondents,
         (d.d IS NOT NULL) AS in_ledger,
         coalesce(d.d, 0) AS degree
  FROM unnest(p_items) AS p(item_id)
  LEFT JOIN (SELECT c.item_id, count(*) AS cnt FROM bjl_conn_centered_v3 c
             WHERE c.item_id = ANY(p_items) GROUP BY 1) n USING (item_id)
  LEFT JOIN deg d ON d.i = p.item_id
$function$;


-- ====================================================================
-- PART B2 — bjl_item_edges, the connections pane's edge list
-- ====================================================================
--
-- ledger v1 -> v3, and the returned correlation becomes excess_r.
--
-- DROP/CREATE because the output column r is renamed to excess_r. Its one
-- caller, bjl-connections-beta.js fetchEdges (line ~156), reads r.r and is
-- updated in the same change. Renaming rather than quietly putting
-- excess_r in a column called r is the point: connections-beta thresholds
-- the value at zero to choose between "rises with" and "runs against"
-- (lines 243, 267, 269, 577, 590), and 2,516 pairs change that answer.
-- A reader deserves to see which metric decided it.
--
-- n_pair is numeric on the v3 ledger and bigint on the v1 one; cast so the
-- return contract does not move.
--
-- DROP DISCARDS THE ACL. Re-granted below to match what pg_proc held.

DROP FUNCTION IF EXISTS public.bjl_item_edges(integer);

CREATE FUNCTION public.bjl_item_edges(p_item integer)
RETURNS TABLE(other_item integer, n_pair bigint, excess_r numeric)
LANGUAGE sql
STABLE
AS $function$
  SELECT item_b, n_pair::bigint, excess_r FROM bjl_connectivity_ledger_v3 WHERE item_a = p_item
  UNION ALL
  SELECT item_a, n_pair::bigint, excess_r FROM bjl_connectivity_ledger_v3 WHERE item_b = p_item
$function$;

GRANT EXECUTE ON FUNCTION public.bjl_item_edges(integer)
  TO postgres, service_role, bjl_agent_readonly;


-- ====================================================================
-- PART C1 — bjl_pair_plain_v2, the provenance numbers under the map
-- ====================================================================
--
-- READ THIS BEFORE APPLYING PART A WITHOUT PART C.
--
-- bjl_pair_plain_v2 is the LATERAL that produces shared_answerers,
-- pct_move_together and lift_points for every row of the joy map sweep.
-- It reads the centered grid directly, and it was on v2.
--
-- Part A moves the sweep's correlation to v3. If C does not go with it,
-- the joy map shows a correlation computed under whole-instrument
-- centering next to a "% move together" and a lift computed under
-- per-family centering — two different centerings in one row, which is
-- precisely the silent heterogeneity the August 5 rebuild closed. A
-- without C is not a smaller change than A with C; it is an incoherent
-- one.
--
-- WHAT MOVES, measured across 60 pairs at n_pair >= 300, v2 grid vs v3:
--
--     shared_answerers   unchanged on all 60 (it is a join count)
--     pct_move_together  avg |delta| 1.0 points, max 12, one pair >= 10
--     lift_points        avg |delta| 5.45 points, max 23.8
--
-- CORRECTION, 2026-08-07, POST-APPLY. The lift_points line above is a
-- true statistic that produced a false impression, and it was reported to
-- the ruling party as "~5 points per card" before apply. It is not a
-- ~5-point move. It is a CHANGE OF UNIT of roughly 46.7x:
--
--     lead pair "treats", v2 grid      +17.6
--     same pair, v3 grid                +0.43
--
-- The error was method, not arithmetic: |delta| was averaged across 60
-- pairs and reported without looking at the resulting magnitudes, so a
-- 17.6 -> 0.43 collapse presented as a 5-point drift. Printing
-- before/after PAIRS instead of DELTAS would have shown it immediately.
--     RULE: when a transform may change units, print before/after values,
--     never summary statistics of the difference.
--
-- The cause is in bjl_conn_centered itself, not in this function.
-- bjl_conn_centered_v2 left the joy family in RAW JOY INDEX POINTS
-- (sd 40.10, range -156.42..146.67) and z-scored the other nine families
-- (sd 0.40..0.79). v3 standardises all ten (sd 0.76..1.08). Because lift
-- is a difference of cz values, every measured lift on the reported path
-- changed UNIT, not value. Rescale ratio across 865 joy items: 46.72
-- +/- 0.99, range 41.09..50.95.
--
-- Three consequences, each handled in a later part rather than here:
--     the model's fam_scale inversion became a 40x false comparison   F
--     every client label saying "points" became wrong                 F/client
--     1 decimal place stopped being enough resolution                 I
--
-- pct_move_together is a sign-agreement rate and barely moves.
--
-- Signature unchanged. REPLACE keeps the ACL.

CREATE OR REPLACE FUNCTION public.bjl_pair_plain_v2(p_item_a integer, p_item_b integer)
RETURNS TABLE(shared_answerers bigint, pct_move_together numeric, lift_points numeric)
LANGUAGE sql
STABLE
AS $function$
  WITH pair AS (
    SELECT a.cz AS ca, b.cz AS cb
    FROM bjl_conn_centered_v3 a
    JOIN bjl_conn_centered_v3 b USING (respondent_id)
    WHERE a.item_id = p_item_a AND b.item_id = p_item_b
  )
  SELECT count(*),
         round(100.0 * avg(CASE WHEN (ca > 0) = (cb > 0) THEN 1 ELSE 0 END), 0),
         -- 1 decimal as originally staged. SUPERSEDED BY PART I, which
         -- moves this to 2. Left visible rather than silently rewritten
         -- because the reason for the change is the whole point.
         round((avg(cb) FILTER (WHERE ca > 0) - avg(cb) FILTER (WHERE ca <= 0))::numeric, 1)
  FROM pair
$function$;


-- ====================================================================
-- PART E — THE COHORT SPINE
-- ====================================================================
--
-- Three functions that read bjl_conn_centered_v2 for COMPUTATION rather
-- than membership, and were therefore invisible to every sweep that
-- produced the first nine sites. See the inventory header for how they
-- surfaced and why applying A and C without them left the database
-- incoherent rather than merely stale.
--
--     bjl_map_cohort         1 site   the hot/cool split itself
--     bjl_joy_map_modeled    2 sites
--     bjl_territory_profile  2 sites
--
-- USER-VISIBLE CONSEQUENCE, NOT A REGRESSION. bjl_map_cohort splits
-- respondents on focal_cz > 0. Under v2 that threshold sat on per-family
-- centering; under v3 it sits on whole-instrument centering, so the split
-- moves. For focal 4589:
--
--     v2   6,510 hot / 1,324 cool
--     v3   6,040 hot / 1,794 cool      488 of 7,834 reassigned
--
-- The correction reaching the cohorts is the point of the promotion.
-- Holding 6,510/1,324 would mean preserving the biased split to protect a
-- test fixture. The fixture was rewritten instead.
--
-- COHORT_FLOOR CONSEQUENCE, CONFIRMED NOT DISCOVERED. Across all 1,229
-- items as single-item focals, against the 50-per-side floor:
--
--     newly halts (fired under v3, not under v2)      52
--     newly clears                                     2
--     halts under both                                37
--
-- So 52 focals that previously drew a map now halt with an explanation.
-- That is the floor doing its job on a corrected split, but it is a
-- behaviour change and it is here so nobody meets it as a surprise.
--
-- All three are CREATE OR REPLACE with unchanged signatures. ACLs
-- preserved, no REVOKE required.
--
-- [Bodies applied in migration connectivity_v3_promotion_part_e_cohort.
--  Each is the prior body with bjl_conn_centered_v2 -> _v3 and no other
--  change. E2 and E3 are superseded by Parts F and G2 below, so their
--  current definitions are the ones printed there.]


-- ====================================================================
-- PART F — THE REPORTED PATH STOPS INVERTING A DEAD STANDARDISATION
-- ====================================================================
--
-- THE BUG THIS FIXES WAS LIVE AND WAS A 40x FALSE COMPARISON.
--
-- bin/bjl_factorize_v1.py:79-85 standardises each scale family before
-- training and stores the per-family SD vector, fam_scale, for one
-- purpose: to de-standardise predictions on the way out.
--
--     fam_scale[fam] = float(V[m].std()) or 1.0
--     V[m] = V[m] / fam_scale[fam]
--
-- So the model PREDICTS IN STANDARDISED UNITS NATIVELY. The inversion
-- existed only to put predictions back into the units of the v2 grid,
-- where joy was in raw Joy Index points. bjl_conn_centered_v3 is already
-- standardised. Multiplying by fam_scale (~46.7 for joy) therefore takes
-- a correct standardised prediction and inflates it 46.7x, and the joy
-- map then prints that beside a measured lift that is now ~0.43. The
-- diamond and the bar were being plotted against each other in units
-- that differ by a factor of forty.
--
-- THE FIX IS REMOVAL, NOT REPOINTING. There is no v3 fam_scale to swap
-- in, because v3 needs no inversion at all. Repointing would reintroduce
-- the same error with fresher constants.
--
-- WHY THE MODEL DOES NOT NEED RETRAINING TO SHIP THIS — settled by
-- measurement, not argument. Reconstruction test: 400 sampled
-- respondents, dot product of the k=24 respondent and item latents,
-- correlated against the v2 training target and against v3:
--
--     joy               30,017 cells   0.8000 -> 0.7894   (-1.3% rel)
--     likelihood         8,169         0.7311 -> 0.6634
--     familiarity          738         0.6504 -> 0.4830
--     trust                682         0.7199 -> 0.5369
--     emotional_state      499         0.9661 -> 0.1630
--     fandom               489         0.9078 -> 0.6391
--     self_description     324         0.8362 -> 0.7444
--     importance           279         0.8457 -> 0.6449
--     behavior             238         0.9338 -> 0.2601
--     perception           216         0.8170 -> 0.5215
--
-- v2 -> v3 changed the CENTERING, not the scale, because scale was
-- already divided out during training. Joy barely moves. The non-joy
-- families collapse badly, but exactly two functions in public read
-- bjl_respondent_latent or bjl_item_latent — bjl_joy_map_modeled and
-- bjl_territory_profile — and BOTH filter scale_family = 'joy'. So the
-- non-joy collapse never reaches a user. Retrain is a real finding, filed
-- with a measured reason, and is not a blocker for this push.
--
-- Rounding moves 1 -> 2 decimals on both lift columns for the reason
-- given in Part I.
--
-- The output column names modeled_lift_points and lift_points are
-- deliberately NOT renamed, though they now carry standardised units.
-- Renaming forces DROP/CREATE on functions that were just DROP/CREATEd,
-- each needing its own paired REVOKE. The compensating change is on the
-- client, where every user-visible "points"/"pts" label on one of these
-- values became "SD". Filed: rename the columns on the next occasion that
-- already requires a DROP/CREATE.
--
-- [F1 bjl_joy_map_modeled and F2 bjl_territory_profile applied in
--  migration connectivity_v3_lift_units_and_modeled_gate. In both, the
--  `* fam_scale` multiply is deleted from the lift CTE and replaced by a
--  comment; F2 retains calibration_slope. F2's current definition is the
--  one printed under Part G2.]


-- ====================================================================
-- PART G — THE MODELED TIER GOES OFF, ON PURPOSE
-- ====================================================================
--
-- holdout_r and calibration_slope in bjl_model_accuracy were fitted
-- against the v2 centering. After the promotion they are STALE, NOT
-- WRONG — they describe a real fit against a grid the reported path no
-- longer uses.
--
-- Part F makes the modeled number dimensionally comparable to the
-- measured one. It does not make it VERIFIED. Shipping a recalibrated-
-- but-unvalidated modeled estimate beside a verified measured one is the
-- same two-things-in-one-row incoherence that Part C exists to prevent,
-- wearing a different costume. So the tier goes off until calibration is
-- refit against v3, and the joy map renders model_abstains — a state the
-- client already draws.
--
--     UPDATE bjl_model_accuracy SET eligible = false
--     WHERE model_version = 'mf_v1_k24' AND scope_type = 'territory';   -- 17 rows
--
-- plus a COMMENT ON COLUMN bjl_model_accuracy.eligible recording that the
-- stored values are stale-not-wrong and must not be flipped back before a
-- refit. COMMENT rather than a new notes column, because the table has no
-- notes column and because \d+ and pg_description are where someone about
-- to flip the flag would already be looking.


-- ====================================================================
-- PART G2 — THE GATE PART G ASSUMED EXISTED
-- ====================================================================
--
-- FOUND BY VERIFYING PART G RATHER THAN BY TRUSTING IT.
--
-- Part G took the modeled tier off in bjl_joy_map_modeled, which joins
-- scope_type='territory' and emits 'model_abstains' on
-- NOT coalesce(a.eligible, false).
--
-- It did nothing of the kind in bjl_territory_profile, which had NO
-- eligibility gate at all. item_verdict became 'inferred' whenever a
-- modeled lift existed, and modeled_lift_raw was emitted unconditionally.
-- The unverified number went on sitting beside the verified one.
--
-- AND PART G MADE THAT PATH QUIETLY WORSE. The slope CTE selects the
-- territory calibration_slope only WHERE eligible, falling back to the
-- joy-family slope otherwise. Flipping eligibility therefore swapped
-- every territory from its own slope to a single family constant:
--
--     territory slopes   min -0.0419   avg 0.8019   max 1.3356
--     family 'joy' slope  0.8598 applied to all 17
--
-- The territory carrying -0.0419 had its modeled lift flip sign and grow
-- roughly twentyfold. Nobody ruled on that; it was a side effect of a
-- flag set for an unrelated reason. The gate below makes the fallback
-- unreachable rather than silently active.
--
-- VERDICT VOCABULARY. 'unmeasured' is kept for items with no modeled
-- value at all; 'model_abstains' is used only where a modeled value
-- exists and is being withheld. Collapsing them would say "we have
-- nothing" where the truth is "we have something we do not yet trust".
-- index.html:6030 routes any verdict other than measured/inferred into
-- the collapsed other-rows block and renders the literal string, so no
-- client change is required.
--
-- ORDERING is gated too. Ranking rows by a number the function refuses to
-- display would leak the withheld model through row order.

CREATE OR REPLACE FUNCTION public.bjl_territory_profile(p_focal integer[], p_territory text, p_model text DEFAULT 'mf_v1_k24'::text, p_mode text DEFAULT 'leaners'::text, p_gate_field text DEFAULT NULL::text, p_gate_value text DEFAULT NULL::text)
RETURNS TABLE(item_id integer, item_wording text, item_verdict text, n_hot integer, n_cool integer, measured_lift numeric, modeled_lift_raw numeric)
LANGUAGE sql
STABLE
AS $function$
  WITH elig AS (
    SELECT EXISTS (
      SELECT 1 FROM bjl_model_accuracy
      WHERE model_version = p_model AND scope_type='territory'
        AND scope_key = p_territory AND eligible
    ) AS ok
  ),
  slope AS (
    SELECT coalesce(
      (SELECT calibration_slope FROM bjl_model_accuracy
       WHERE model_version = p_model AND scope_type='territory' AND scope_key = p_territory AND eligible),
      (SELECT calibration_slope FROM bjl_model_accuracy
       WHERE model_version = p_model AND scope_type='family' AND scope_key = 'joy'), 1) AS s
  ),
  focal_qs AS (
    SELECT i.question_id FROM bjl_items i
    WHERE i.item_id = ANY(p_focal)
    GROUP BY i.question_id
    HAVING (SELECT count(*) FROM bjl_items i2 WHERE i2.question_id = i.question_id) < 40
  ),
  cohort AS (
    SELECT * FROM bjl_map_cohort(p_focal, p_mode, p_gate_field, p_gate_value)
  ),
  members AS (
    SELECT it.item_id, i.item_name
    FROM bjl_item_territory it JOIN bjl_items i ON i.item_id = it.item_id
    JOIN (SELECT DISTINCT item_id FROM bjl_conn_centered_v3 WHERE scale_family='joy') j ON j.item_id = it.item_id
    WHERE it.territory_key = p_territory
      AND coalesce(i.is_location, false) = false AND coalesce(i.is_brand, false) = false
      AND NOT (it.item_id = ANY(p_focal))
      AND i.question_id NOT IN (SELECT question_id FROM focal_qs)
  ),
  meas AS (
    SELECT m.item_id,
      count(*) FILTER (WHERE co.is_hot) AS n_hot,
      count(*) FILTER (WHERE NOT co.is_hot) AS n_cool,
      avg(c.cz) FILTER (WHERE co.is_hot) - avg(c.cz) FILTER (WHERE NOT co.is_hot) AS lift
    FROM bjl_conn_centered_v3 c
    JOIN members m USING (item_id)
    JOIN cohort co USING (respondent_id)
    WHERE c.scale_family = 'joy'
    GROUP BY 1
  ),
  iv AS (
    SELECT l.item_id, e.o AS k, e.v::float AS qv
    FROM bjl_item_latent l JOIN members m USING (item_id),
    LATERAL jsonb_array_elements_text(l.factors) WITH ORDINALITY e(v, o)
    WHERE l.model_version = p_model
  ),
  rl AS (
    SELECT l.respondent_id, c.is_hot, e.o AS k, e.v::float AS pv
    FROM bjl_respondent_latent l JOIN cohort c USING (respondent_id),
    LATERAL jsonb_array_elements_text(l.factors) WITH ORDINALITY e(v, o)
    WHERE l.model_version = p_model
  ),
  modeled AS (
    SELECT x.item_id,
      -- fam_scale multiply REMOVED, see F1. calibration_slope retained.
      (avg(sum_hat) FILTER (WHERE is_hot) - avg(sum_hat) FILTER (WHERE NOT is_hot))
        * (SELECT s FROM slope)
      AS mlift
    FROM (
      SELECT iv.item_id, rl.respondent_id, rl.is_hot, sum(rl.pv * iv.qv) AS sum_hat
      FROM rl JOIN iv USING (k) GROUP BY 1, 2, 3
    ) x
    GROUP BY 1
  )
  SELECT m.item_id, m.item_name,
    CASE WHEN coalesce(me.n_hot,0) >= 30 AND coalesce(me.n_cool,0) >= 30 THEN 'measured'
         WHEN mo.mlift IS NULL THEN 'unmeasured'
         WHEN NOT (SELECT ok FROM elig) THEN 'model_abstains'
         ELSE 'inferred' END,
    me.n_hot::int, me.n_cool::int,
    CASE WHEN coalesce(me.n_hot,0) >= 30 AND coalesce(me.n_cool,0) >= 30
         THEN round(me.lift::numeric, 2) END,
    CASE WHEN (SELECT ok FROM elig) THEN round(mo.mlift::numeric, 2) END
  FROM members m
  LEFT JOIN meas me USING (item_id)
  LEFT JOIN modeled mo USING (item_id)
  ORDER BY coalesce(
    CASE WHEN coalesce(me.n_hot,0) >= 30 AND coalesce(me.n_cool,0) >= 30 THEN me.lift END,
    CASE WHEN (SELECT ok FROM elig) THEN mo.mlift END) DESC NULLS LAST
$function$;


-- ====================================================================
-- PART H — PROTECT THE PRE-REGISTERED PREDICTIONS
-- ====================================================================
--
-- bjl_model_predictions holds 2 rows registered 2026-07-27 with
-- registered_before_fielding = true and verdict still NULL. Their
-- predicted_lift values (20.5 and 3.3) are in v2 JOY INDEX POINTS.
--
-- Their stated verification method computes measured_lift from the live
-- grid, which now returns STANDARD DEVIATIONS. A naive points-vs-SDs
-- comparison would score both as catastrophic misses regardless of how
-- accurate they actually were — a FALSE FALSIFICATION VERDICT on the
-- ledger whose entire purpose is to prove the predictions were
-- pre-registered and honestly scored. That costs far more than two rows.
--
-- Both rows carry a UNIT stamp in notes giving the two valid remedies:
-- convert the prediction by 46.72, or compute measured_lift against the
-- preserved v2 grid. Applied in
-- connectivity_v3_lift_units_and_modeled_gate.
--
-- CLIENT SIDE, AND THIS IS THE HALF THAT WILL BE GOT WRONG LATER.
-- index.html:5914 renders the prediction chip tooltip as "predicted
-- {predicted_lift} pts". That "pts" is the one surviving correct use of
-- the word on the whole pane — every other lift beside it is now SD. A
-- future tidy-up that sweeps for "points"/"pts" and relabels this to SD
-- reintroduces the exact false comparison this part exists to prevent,
-- and does it silently, because the number itself does not move.
--
-- So the label was left alone, the tooltip now says "(v2 Joy Index
-- points — not SD)" out loud, and a nine-line comment above it says do
-- not change this and why. Check 9's "no label says points" sweep must
-- be read as excluding this one site.


-- ====================================================================
-- PART I — DISPLAY PRECISION FOLLOWS THE UNIT
-- ====================================================================
--
-- NOT IN THE ORIGINAL SCOPE. Found while making the client label change
-- that Part F requires, and it is the third face of the same defect, so
-- it was fixed rather than filed.
--
-- lift_points was rounded to ONE decimal throughout — in
-- bjl_pair_plain_v2 and again in three JS layers. That precision was
-- chosen when the value was a Joy Index point difference around 17.6,
-- where 0.1 is ~0.6% resolution. The same quantity is now a standardised
-- difference around 0.13, where 0.1 is ~77% resolution.
--
-- Measured across 400 ledger_v3 pairs at n_pair >= 300:
--
--     avg |lift| raw                 0.1277
--     max |lift| raw                 0.5606
--     renders 0.0 at 1 decimal      101 of 400   (25.3%)
--     renders 0.00 at 2 decimals     10 of 400   ( 2.5%)
--     distinct values at 1 decimal   12
--     distinct values at 2 decimals  78
--
-- A QUARTER OF WELL-POWERED MEASURED PAIRS WERE RENDERING AS A FLAT ZERO.
-- That is worse than the mislabelled unit beside it: "17.6 points" was a
-- true number under a wrong name, whereas "+0.0" reads as "we measured
-- this and found nothing" about a pair that carries a real difference.
-- Shipping the label fix alone would have put an honest unit on top of a
-- null-looking value.
--
-- 2 decimals matches the contract set in F1/F2/G2. 3 was rejected as
-- false precision on a cohort-difference statistic.
--
-- territory_magnitude in bjl_joy_map_sweep_v2 is deliberately unchanged:
-- it is an average Joy Index, genuinely in points, and 1 decimal is right.
--
-- Client side, shipped in the same commit:
--     bjl-joy-map-connections.js   round2() for lift_points,
--                                  modeled_lift_points and
--                                  measured_territory_mean_lift;
--                                  round1() retained for
--                                  territory_magnitude
--     bjl-connections-beta.js      lift_points to 2 dp
--     bjl-territory-profile.js     measured_lift and modeled_lift_raw
--                                  to 2 dp (the SQL already emitted 2;
--                                  the JS was throwing it away)
--     index.html                   every "points"/"pts" label on one of
--                                  these values becomes "SD"

CREATE OR REPLACE FUNCTION public.bjl_pair_plain_v2(p_item_a integer, p_item_b integer)
RETURNS TABLE(shared_answerers bigint, pct_move_together numeric, lift_points numeric)
LANGUAGE sql
STABLE
AS $function$
  WITH pair AS (
    SELECT a.cz AS ca, b.cz AS cb
    FROM bjl_conn_centered_v3 a
    JOIN bjl_conn_centered_v3 b USING (respondent_id)
    WHERE a.item_id = p_item_a AND b.item_id = p_item_b
  )
  SELECT count(*),
         round(100.0 * avg(CASE WHEN (ca > 0) = (cb > 0) THEN 1 ELSE 0 END), 0),
         -- 2 decimals, not 1: standardised difference now. See Part I.
         round((avg(cb) FILTER (WHERE ca > 0) - avg(cb) FILTER (WHERE ca <= 0))::numeric, 2)
  FROM pair
$function$;


COMMIT;


-- ====================================================================
-- AFTER APPLYING — what to check, and what a pass looks like
-- ====================================================================
--
-- 1. NO FUNCTION IN public STILL READS v1 OR v2, except the two dead ones
--    left on purpose. ASSERT THE COMPLETE EXPECTED SET, not the absence of
--    a bad pattern — this check returned five where it expected two and is
--    the only reason Part E was written before the incoherence shipped.
--
--    The v1 tables are UNSUFFIXED. An earlier draft of this check searched
--    for `_v1` names that do not exist, matched nothing, and reported a
--    clean board. The \y word boundaries are load-bearing: without them
--    `bjl_conn_centered` matches `bjl_conn_centered_v3` and every function
--    looks like a v1 reader.
--
--      SELECT p.proname,
--             (p.prosrc ~ '\ybjl_conn_centered\y')          AS centered_v1,
--             (p.prosrc ~ '\ybjl_conn_centered_v2\y')       AS centered_v2,
--             (p.prosrc ~ '\ybjl_connectivity_ledger\y')    AS ledger_v1,
--             (p.prosrc ~ '\ybjl_connectivity_ledger_v2\y') AS ledger_v2
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public'
--        AND (p.prosrc ~ '\ybjl_conn_centered\y'
--          OR p.prosrc ~ '\ybjl_conn_centered_v2\y'
--          OR p.prosrc ~ '\ybjl_connectivity_ledger\y'
--          OR p.prosrc ~ '\ybjl_connectivity_ledger_v2\y')
--      ORDER BY 1;
--
--    PASS IS EXACTLY TWO ROWS:
--      bjl_joy_map_sweep   ledger_v1 = true, everything else false
--      bjl_pair_plain      centered_v1 = true, everything else false
--    Any third row, and any true in a _v2 column, is a straggler.
--
-- 1b. AND NEITHER DOES THE APP CODE. The query above reads pg_proc and
--     cannot see the four JS sites, which is how B3 through B5 stayed
--     hidden.
--
--       rg -n 'bjl_conn_centered(_v2)?[^_v3]|bjl_connectivity_ledger(_v2)?[^_v3]' \
--          netlify/functions index.html
--
--     PASS IS THREE HITS, ALL OF THEM COMMENT LINES — not zero. Two in
--     connections-beta.js (198, 237) and one in joy-map-connections.js
--     (99) name the v1/v2 tables while explaining why the code no longer
--     reads them. Deleting them to make the grep come back empty would
--     delete the record of why B4/B5 exist. What must be zero is hits on
--     a line that is not a comment.
--
--     Pair it with a call-site grep, since the promoted functions kept
--     their names and so are invisible to the table-name grep:
--
--       rg -n 'bjl_pair_plain\b|bjl_joy_map_sweep\b' netlify/functions index.html
--
--     PASS: no live call. bjl_pair_plain appears once, in the
--     connections-beta.js:237 comment saying the v1 function is not the
--     one being called. The live calls are to the _v2 / promoted names.
--
-- 2. THE ACLs SURVIVED THE TWO DROPS. Both must come back exactly
--    postgres / service_role / bjl_agent_readonly, and anon must be false
--    — a DROP/CREATE that silently re-opened a function to anon would
--    undo the August 6 lockdown from inside an unrelated migration.
--
--      SELECT p.proname, p.proacl::text,
--             has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc,
--             has_function_privilege('anon',         p.oid, 'EXECUTE') AS anon
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public'
--        AND p.proname IN ('bjl_joy_map_sweep_v2','bjl_item_edges');
--
-- 3. THE 349 GO TRUTHFUL. Pick any item that is in v3 and not in v1 and
--    put it through the gate the front door actually calls. in_ledger must
--    come back true and respondents must clear 50.
--
--      WITH v1 AS (SELECT DISTINCT x FROM (
--             SELECT item_a x FROM bjl_connectivity_ledger
--             UNION ALL SELECT item_b FROM bjl_connectivity_ledger) a),
--           v3 AS (SELECT DISTINCT x FROM (
--             SELECT item_a x FROM bjl_connectivity_ledger_v3
--             UNION ALL SELECT item_b FROM bjl_connectivity_ledger_v3) a),
--           gap AS (SELECT array_agg(x) g FROM v3 WHERE x NOT IN (SELECT x FROM v1))
--      SELECT count(*) AS gap_items,
--             count(*) FILTER (WHERE in_ledger)             AS now_in_ledger,
--             count(*) FILTER (WHERE respondents >= 50)     AS clear_the_floor,
--             min(respondents), max(respondents)
--      FROM gap, LATERAL bjl_item_capability(gap.g);
--
--    PASS IS 349 / 349 / 349. Anything less means the gate still disagrees
--    with the ledger it names.
--
-- 4. v2 AND v1 ARE UNTOUCHED. Row counts must be exactly what they were:
--
--      bjl_connectivity_ledger      60,401
--      bjl_connectivity_ledger_v2  115,144
--      bjl_conn_centered_v2      1,452,730
--
-- 5. THE REPORTED PATH IS IN ONE UNIT. fam_scale must appear in the two
--    modeled functions ONLY inside the comments that record its removal.
--    Grepping pg_get_functiondef for the string is not enough — the
--    removal comments contain it, and a naive check reads them as a live
--    reference.
--
--      SELECT p.proname, l.lineno, l.line
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace,
--      LATERAL unnest(string_to_array(p.prosrc, E'\n'))
--        WITH ORDINALITY AS l(line, lineno)
--      WHERE n.nspname = 'public'
--        AND p.proname IN ('bjl_joy_map_modeled','bjl_territory_profile')
--        AND l.line ILIKE '%fam_scale%';
--
--    PASS is exactly two rows, both beginning with `--`.
--
-- 6. THE MODELED TIER IS OFF EVERYWHERE, INCLUDING WHERE PART G DID NOT
--    REACH. Both functions, not just the one the flag was written for.
--
--      SELECT modeled_verdict, count(*),
--             count(*) FILTER (WHERE modeled_lift_points IS NOT NULL) AS shown
--      FROM bjl_joy_map_modeled(ARRAY[4589]::int[], 'mf_v1_k24')
--      GROUP BY 1;
--
--      SELECT item_verdict, count(*),
--             count(*) FILTER (WHERE modeled_lift_raw IS NOT NULL) AS shown
--      FROM bjl_territory_profile(ARRAY[4589]::int[], 'escape_away')
--      GROUP BY 1;
--
--    PASS: `shown` is 0 on every row of both, no verdict is 'inferred',
--    and every modeled_verdict matches /^model_abstains/. Measured values
--    must still be present — this takes the modeled tier off, not the
--    measured one. Observed: 16 territories all abstaining, and for
--    escape_away 32 measured / 6 model_abstains.
--
-- 7. MEASURED LIFT READS AS SD AT 2 DECIMALS, AND NOTHING FLATTENS TO 0.
--
--      SELECT count(*), min(lift_points), max(lift_points),
--             count(*) FILTER (WHERE lift_points = 0) AS flat_zero,
--             count(DISTINCT lift_points) AS distinct_vals
--      FROM bjl_joy_map_sweep_v2(ARRAY[4589]::int[])
--      WHERE lift_points IS NOT NULL;
--
--    PASS: values in roughly -0.3..0.6, flat_zero = 0, distinct_vals well
--    above the ~11 that 1 decimal produced. Observed 41 / -0.30 / 0.52 /
--    0 / 33. If lift_points comes back in the tens, Part F or Part C has
--    been reverted and the client labels now lie in the other direction.
--
-- 8. THE PRE-REGISTERED PREDICTIONS CARRY THEIR UNIT STAMP AND ARE STILL
--    UNSCORED.
--
--      SELECT prediction_id, predicted_lift, verdict,
--             registered_before_fielding,
--             (notes ILIKE '%UNIT: predicted_lift is in JOY INDEX POINTS%')
--      FROM bjl_model_predictions;
--
--    PASS: 2 rows, both stamped, both verdict NULL,
--    registered_before_fielding still true.
--
-- 9. THE BROWSER, WHICH NONE OF THE ABOVE SUBSTITUTES FOR. The joy map
--    and the connections pane both render through service_role, so every
--    check here passes whether or not the panes still draw. Open a
--    territory and confirm:
--      - the verdict chips populate and lift numbers render, now reading
--        like +0.43 rather than +17.6 (Parts C, F, I)
--      - the modeled diamond is ABSENT and the row reads model_abstains
--        rather than showing a number (Parts G, G2)
--      - no label anywhere still says "points" or "pts" beside one of
--        these values, WITH ONE DELIBERATE EXCEPTION: the prediction
--        chip tooltip at index.html:5914 says "pts" because
--        predicted_lift really is in v2 points. Read the comment above
--        it before touching it. See Part H.
--    Then run one front-door query against an item from the 349 and
--    confirm the unmeasured banner stays down.
