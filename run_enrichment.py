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
5. For select_all items in food_joy, general_joy, or sports_fandom, use minimal tagging (often just 1-2 joy_modes and 1 occasion). These are answer choices, not standalone items.

OUTPUT FORMAT:
{{
  "items": [
    {{"item_name": "...", "category": "...", "joy_modes": [...], "occasions": [...], "functional_jobs": [...], "tensions": [...]}},
    ...
  ]
}}

The output MUST contain exactly one entry per input item, in the same order. The item_name and category fields in your output MUST match the input exactly so the writeback can match rows."""


def get_untagged_items(conn, limit: int) -> list[dict[str, Any]]:
    """Pull the next batch of untagged (item_name, category) pairs, prioritized by JI and n."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT 
                item_name,
                category,
                MAX(joy_index)::float AS joy_index,
                MAX(n) AS n,
                STRING_AGG(DISTINCT question_type, '|') AS question_types
            FROM bjl_scores
            WHERE (joy_modes IS NULL OR array_length(joy_modes, 1) = 0)
              AND item_name IS NOT NULL
              AND category IS NOT NULL
            GROUP BY item_name, category
            ORDER BY 
                MAX(joy_index) DESC NULLS LAST,
                MAX(n) DESC NULLS LAST
            LIMIT %s
        """, (limit,))
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
        max_tokens=8000,
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


def writeback(conn, tagged: list[dict], dry_run: bool) -> int:
    """Write enrichments back to bjl_scores. Returns number of distinct (item, category) pairs updated."""
    if dry_run:
        print(f"  [DRY RUN] Would update {len(tagged)} (item, category) pairs")
        for t in tagged[:3]:
            print(f"    {t['item_name'][:60]} ({t['category']}): joy_modes={t['joy_modes']}")
        return 0

    updated = 0
    with conn.cursor() as cur:
        for t in tagged:
            # Defensive validation: make sure all values are in the controlled vocab
            joy_modes = [v for v in t.get("joy_modes", []) if v in JOY_MODES]
            occasions = [v for v in t.get("occasions", []) if v in OCCASIONS]
            functional_jobs = [v for v in t.get("functional_jobs", []) if v in FUNCTIONAL_JOBS]
            tensions = [v for v in t.get("tensions", []) if v in TENSIONS]

            cur.execute("""
                UPDATE bjl_scores
                SET joy_modes = %s,
                    occasions = %s,
                    functional_jobs = %s,
                    tensions = %s,
                    enrichment_updated_at = now()
                WHERE item_name = %s AND category = %s
            """, (joy_modes, occasions, functional_jobs, tensions, t["item_name"], t["category"]))
            updated += cur.rowcount
    conn.commit()
    return updated


def get_progress(conn) -> tuple[int, int]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT 
                COUNT(DISTINCT (item_name, category)) FILTER (WHERE joy_modes IS NOT NULL AND array_length(joy_modes, 1) > 0) AS tagged,
                COUNT(DISTINCT (item_name, category)) AS total
            FROM bjl_scores
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
    db_url = os.environ.get("SUPABASE_DB_URL")
    if not api_key:
        print("ERROR: ANTHROPIC_API_KEY environment variable not set", file=sys.stderr)
        sys.exit(1)
    if not db_url:
        print("ERROR: SUPABASE_DB_URL environment variable not set", file=sys.stderr)
        sys.exit(1)

    client = anthropic.Anthropic(api_key=api_key)
    conn = psycopg2.connect(db_url)

    tagged_start, total = get_progress(conn)
    print(f"Starting state: {tagged_start}/{total} (item, category) combos tagged ({100*tagged_start/total:.1f}%)")

    batch_num = 0
    rows_updated_total = 0

    while batch_num < args.max_batches:
        batch_num += 1
        items = get_untagged_items(conn, args.limit)
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

        rows = writeback(conn, tagged, args.dry_run)
        rows_updated_total += rows
        print(f"  Updated {rows} rows in bjl_scores")

        time.sleep(SLEEP_BETWEEN_CALLS)

    tagged_end, _ = get_progress(conn)
    print(f"\nFinal state: {tagged_end}/{total} (item, category) combos tagged ({100*tagged_end/total:.1f}%)")
    print(f"Net new combos this run: {tagged_end - tagged_start}")
    print(f"Total bjl_scores rows updated: {rows_updated_total}")

    conn.close()


if __name__ == "__main__":
    main()
