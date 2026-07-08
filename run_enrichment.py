#!/usr/bin/env python3
"""
BJL enrichment backfill. Pulls untagged (item, category) pairs from Supabase,
sends them to Claude in batches with the controlled vocabularies, parses the
JSON response, and writes back joy_modes / occasions / functional_jobs / tensions.

Usage:
  export ANTHROPIC_API_KEY="sk-ant-..."
  export SUPABASE_DB_URL="postgresql://postgres:[password]@db.iqjkgswpzbklihdfccnd.supabase.co:5432/postgres"
  python3 run_enrichment.py [--limit 50] [--dry-run] [--max-batches 999]

Get the SUPABASE_DB_URL from Supabase dashboard -> Project Settings -> Database
-> Connection string -> URI (use the "session" pooler or direct connection).

The script tags select_all items with empty arrays (they are answer-choice tokens,
not standalone joy items). Scaled items get full tagging.
"""

import argparse
import json
import os
import sys
import time
from typing import Any

import anthropic
import psycopg2
from psycopg2.extras import RealDictCursor

MODEL = "claude-sonnet-4-5"  # Cheap, fast, accurate enough for tagging
BATCH_SIZE = 50
SLEEP_BETWEEN_CALLS = 0.5  # Polite throttle

# Controlled vocabularies. These MUST match the reference tables in Supabase.
JOY_MODES = [
    "playful", "aesthetic", "hedonic", "physical", "sentimental",
    "relational", "achievement", "triumph", "freedom", "awe",
    "inspirational", "self_actualization", "spiritual", "tranquil",
]

OCCASIONS = [
    "everyday", "weekend", "vacation", "holiday", "birthday",
    "celebration", "gathering", "gift_giving", "alone_time", "mealtime",
    "morning", "evening", "special_occasion", "purchase_moment",
    "post_purchase", "anticipation", "in_moment", "memory", "transition",
    "work", "hosting", "travel_journey", "sports_viewing", "live_event",
    "shopping",
]

FUNCTIONAL_JOBS = [
    "reward_self", "nourish_others", "build_belonging", "mark_milestone",
    "escape_routine", "relax_recover", "signal_status", "signal_identity",
    "connect_remotely", "create_memory", "demonstrate_care",
    "provide_security", "plan_future", "express_creativity", "learn_grow",
    "compete", "cheer_team", "refuel", "relieve_anxiety", "feel_proud",
    "display_taste", "immerse_in_story", "share_experience",
    "preserve_tradition",
]

TENSIONS = [
    "challenger_vs_legacy", "discovery_vs_comfort",
    "moderation_vs_indulgence", "performance_vs_pleasure",
    "savings_vs_spending", "individual_vs_communal", "present_vs_future",
    "tradition_vs_modern", "luxury_vs_value", "digital_vs_physical",
    "introvert_vs_extrovert", "control_vs_surrender",
    "aspiration_vs_acceptance", "self_vs_others",
    "forgiveness_vs_foresight",
]

SYSTEM_PROMPT = f"""You tag consumer joy survey items with controlled vocabularies for a retrieval system. Your output is parsed as JSON, so you must output valid JSON only with no preamble, no markdown fences, no commentary.

CONTROLLED VOCABULARIES. You MUST only use values from these lists.

joy_modes: {JOY_MODES}
occasions: {OCCASIONS}
functional_jobs: {FUNCTIONAL_JOBS}
tensions: {TENSIONS}

TAGGING RULES:
1. Each item should typically have 2-4 joy_modes, 1-4 occasions, 2-5 functional_jobs, 0-3 tensions.
2. Use empty arrays for items that are not actual joy drivers (political stim text, abstract attitude statements, anchor questions, raw emotion words like "Anxious" or "Stressed").
3. Pick the modes/jobs that BEST fit, not every plausible one. Tighter tagging produces better retrieval.
4. Consider the category context: "Hawaii" in travel_destinations vs in food_joy would be tagged differently if applicable.
5. Select-all items in this queue have already been filtered to real-signal readings (MAX n >= 100). For these, let functional_jobs and tensions flow freely where they genuinely apply — those two frameworks are what the pivot bridges on, so real signal there is valuable. Return empty for options that are truly just answer tokens with no job or tension of their own. Keep joy_modes and occasions tight: assign only when the option itself clearly carries a specific, non-generic value, since those two frameworks are noisy and mostly inherited from the parent question rather than the option.
6. HARD RULE on tensions: assign a tension only where the item genuinely sits in a conflict between the two poles named. Tensions are sparse by nature. Most items do not sit in a tension, and empty is the correct output for most. Do not force-fill tensions to cover the item. Forced tensions are noise on the dimension we most need clean.

OUTPUT FORMAT:
{{
  "items": [
    {{"item_name": "...", "category": "...", "joy_modes": [...], "occasions": [...], "functional_jobs": [...], "tensions": [...]}},
    ...
  ]
}}

The output MUST contain exactly one entry per input item, in the same order. The item_name and category fields in your output MUST match the input exactly so the writeback can match rows."""


def get_untagged_items(conn, limit: int, run_start_ts) -> list[dict[str, Any]]:
    """Pull the next batch of combos needing enrichment, prioritized by JI and n.

    Fetch key is functional_jobs OR tensions emptiness (the pivot's strongest
    bridge, and the thinnest layer we have). Note that Postgres
    array_length('{}',1) returns NULL, so all three empty-shapes have to be
    caught explicitly.

    Pure select_all combos are admitted only when MAX(n) >= 100 — thin
    answer-choice tokens are excluded from the queue.

    Scan-status guard: combos already scanned in the current run are excluded
    via enrichment_updated_at < run_start_ts. Without this, a tensionless item
    that legitimately gets an empty tensions array would still match the
    tag-emptiness key and get re-fetched forever, burning API calls to arrive
    at the same empty answer.

    Future reruns: once every combo has enrichment_updated_at set, callers can
    switch the fetch entirely to `enrichment_updated_at IS NULL` so items
    intentionally left empty are not re-pulled between runs.
    """
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT
                item_name,
                category,
                MAX(joy_index)::float AS joy_index,
                MAX(n) AS n,
                STRING_AGG(DISTINCT question_type, '|') AS question_types
            FROM bjl_scores
            WHERE (
                    functional_jobs IS NULL
                    OR array_length(functional_jobs, 1) IS NULL
                    OR array_length(functional_jobs, 1) = 0
                    OR tensions IS NULL
                    OR array_length(tensions, 1) IS NULL
                    OR array_length(tensions, 1) = 0
                  )
              AND item_name IS NOT NULL
              AND category IS NOT NULL
            GROUP BY item_name, category
            HAVING (bool_or(question_type <> 'select_all') OR MAX(n) >= 100)
               AND (MAX(enrichment_updated_at) IS NULL OR MAX(enrichment_updated_at) < %s)
            ORDER BY
                MAX(joy_index) DESC NULLS LAST,
                MAX(n) DESC NULLS LAST
            LIMIT %s
        """, (run_start_ts, limit))
        return [dict(r) for r in cur.fetchall()]


def tag_batch(client: anthropic.Anthropic, items: list[dict]) -> list[dict]:
    """Send a batch to Claude, parse the JSON response."""
    user_msg = "Tag the following items. Return a single JSON object with an 'items' array.\n\n"
    user_msg += json.dumps([
        {
            "item_name": it["item_name"],
            "category": it["category"],
            "joy_index": it["joy_index"],
            "n": it["n"],
            "question_types": it["question_types"],
        }
        for it in items
    ], indent=2)

    response = client.messages.create(
        model=MODEL,
        max_tokens=12000,  # 50 items × ~200 tokens per tagged row + headroom
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )

    text = response.content[0].text.strip()
    # Strip any markdown fence the model might add
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        if text.startswith("json"):
            text = text[4:].strip()
    
    parsed = json.loads(text)
    return parsed["items"]


def writeback(conn, sources: list[dict], tagged: list[dict], dry_run: bool) -> int:
    """Write enrichments back to bjl_scores. Returns number of distinct (item, category) pairs updated.

    Pairs each fetched source with the LLM's tag response by position (the
    prompt contracts for same-order same-length output). Uses the source's
    item_name/category for the WHERE clause, not the LLM's echo, so Unicode
    variants the LLM canonicalizes (curly apostrophes → straight, em-dashes →
    hyphens, non-breaking spaces → spaces) still match the row in the DB.
    """
    if dry_run:
        print(f"  [DRY RUN] Would update {len(tagged)} (item, category) pairs")
        for src, t in list(zip(sources, tagged))[:3]:
            print(f"    {src['item_name'][:60]} ({src['category']}): joy_modes={t.get('joy_modes')}")
        return 0

    if len(tagged) != len(sources):
        print(f"  WARN: writeback pairing count mismatch (sources={len(sources)}, tagged={len(tagged)})", file=sys.stderr)

    pair_count = min(len(sources), len(tagged))
    updated = 0
    with conn.cursor() as cur:
        for i in range(pair_count):
            src = sources[i]
            t = tagged[i]
            # Defensive validation: make sure all values are in the controlled vocab
            joy_modes = [v for v in t.get("joy_modes", []) if v in JOY_MODES]
            occasions = [v for v in t.get("occasions", []) if v in OCCASIONS]
            functional_jobs = [v for v in t.get("functional_jobs", []) if v in FUNCTIONAL_JOBS]
            tensions = [v for v in t.get("tensions", []) if v in TENSIONS]

            # CASE-guard: fill each array only when it is currently empty
            # (NULL, empty literal {}, or explicit zero-length). Preserves any
            # tags that are already there. enrichment_updated_at is set on
            # every scan, including no-op passes, so future reruns can gate on
            # scan status rather than tag emptiness.
            cur.execute("""
                UPDATE bjl_scores
                SET joy_modes = CASE
                        WHEN joy_modes IS NULL
                             OR array_length(joy_modes, 1) IS NULL
                             OR array_length(joy_modes, 1) = 0
                        THEN %s ELSE joy_modes END,
                    occasions = CASE
                        WHEN occasions IS NULL
                             OR array_length(occasions, 1) IS NULL
                             OR array_length(occasions, 1) = 0
                        THEN %s ELSE occasions END,
                    functional_jobs = CASE
                        WHEN functional_jobs IS NULL
                             OR array_length(functional_jobs, 1) IS NULL
                             OR array_length(functional_jobs, 1) = 0
                        THEN %s ELSE functional_jobs END,
                    tensions = CASE
                        WHEN tensions IS NULL
                             OR array_length(tensions, 1) IS NULL
                             OR array_length(tensions, 1) = 0
                        THEN %s ELSE tensions END,
                    enrichment_updated_at = now()
                WHERE item_name = %s AND category = %s
            """, (joy_modes, occasions, functional_jobs, tensions, src["item_name"], src["category"]))
            if cur.rowcount == 0:
                # Should not happen with pair-by-position; log so we notice.
                print(f"  WARN: 0 rows matched for '{src['item_name'][:60]}' ({src['category']})", file=sys.stderr)
            updated += cur.rowcount
    conn.commit()
    return updated


def get_progress(conn) -> tuple[int, int]:
    """Report scan status: how many combos have any enrichment attempt vs total.
    This tracks the same signal the writeback bumps (enrichment_updated_at), so
    a run's net delta reflects new scan coverage — not just tag completeness,
    since tensions and other arrays can be legitimately empty."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                COUNT(DISTINCT (item_name, category)) FILTER (WHERE enrichment_updated_at IS NOT NULL) AS scanned,
                COUNT(DISTINCT (item_name, category)) AS total
            FROM bjl_scores
            WHERE item_name IS NOT NULL AND category IS NOT NULL
        """)
        return cur.fetchone()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=BATCH_SIZE,
                        help="Items per batch (default: 50)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print what would be updated without writing")
    parser.add_argument("--max-batches", type=int, default=999,
                        help="Stop after N batches (default: run until done)")
    args = parser.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    db_url = (os.environ.get("SUPABASE_DB_URL") or os.environ.get("DATABASE_URL"))
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY environment variable not set", file=sys.stderr)
        sys.exit(1)
    if not db_url:
        print("ERROR: SUPABASE_DB_URL environment variable not set", file=sys.stderr)
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)
    conn = psycopg2.connect(db_url)

    scanned_start, total = get_progress(conn)
    print(f"Starting state: {scanned_start}/{total} (item, category) combos scanned ({100*scanned_start/total:.1f}%)")

    # Capture the run's start timestamp from the database's clock so the
    # scan-status guard in get_untagged_items uses the same clock the
    # writeback stamps with (now()). Without this, combos scanned during this
    # run would keep matching the tag-emptiness fetch key on subsequent
    # batches whenever the LLM legitimately returned empty arrays.
    with conn.cursor() as cur:
        cur.execute("SELECT now()")
        run_start_ts = cur.fetchone()[0]
    print(f"Run start timestamp: {run_start_ts.isoformat()}")

    batch_num = 0
    rows_updated_total = 0

    while batch_num < args.max_batches:
        batch_num += 1
        items = get_untagged_items(conn, args.limit, run_start_ts)
        if not items:
            print("No untagged items remaining.")
            break

        print(f"\nBatch {batch_num}: {len(items)} items, top JI={items[0]['joy_index']}, top n={items[0]['n']}")

        try:
            tagged = tag_batch(client, items)
        except (json.JSONDecodeError, KeyError, IndexError) as e:
            print(f"  ERROR parsing response: {e}", file=sys.stderr)
            print(f"  Sleeping 5s and continuing...", file=sys.stderr)
            time.sleep(5)
            continue
        except anthropic.APIError as e:
            print(f"  ERROR from Anthropic API: {e}", file=sys.stderr)
            time.sleep(10)
            continue

        if len(tagged) != len(items):
            print(f"  WARN: input had {len(items)} items, got {len(tagged)} back", file=sys.stderr)

        rows = writeback(conn, items, tagged, args.dry_run)
        rows_updated_total += rows
        print(f"  Updated {rows} rows in bjl_scores")

        time.sleep(SLEEP_BETWEEN_CALLS)

    scanned_end, _ = get_progress(conn)
    print(f"\nFinal state: {scanned_end}/{total} (item, category) combos scanned ({100*scanned_end/total:.1f}%)")
    print(f"Net new combos scanned this run: {scanned_end - scanned_start}")
    print(f"Total bjl_scores rows updated: {rows_updated_total}")

    conn.close()


if __name__ == "__main__":
    main()
