#!/usr/bin/env python3
"""
BJL topic rescan. Two jobs, one classifier.

Job 1 (bjl_items rescan): re-classifies ~1,870 items where haiku_confidence is
medium/low/null, or primary_topic drifted off the 16-topic taxonomy
(e.g. 'technology'). Guarded writeback: never downgrades a high-confidence tag,
never overwrites when the new call is 'not_an_item'.

Job 2 (bjl_scores null residue): classifies the 19 bjl_scores rows still
lacking item_topic that have no bjl_items row. Most come back 'not_an_item'
and stay null; the few real items are written straight to bjl_scores.item_topic.

Between the two jobs a re-propagation runs, refreshing bjl_scores.item_topic
from the improved bjl_items on a punctuation-normalized name key.

Trust order, not the LLM's echoed strings (curly apostrophes and quotes will
not round-trip reliably).

Usage:
  export ANTHROPIC_API_KEY="sk-ant-..."
  export SUPABASE_DB_URL="postgresql://postgres:[password]@..."
  python3 run_topic_rescan.py --job 1 --dry-run --max-batches 1
  python3 run_topic_rescan.py --job 1
  python3 run_topic_rescan.py --job 2
  python3 run_topic_rescan.py --job both
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

MODEL = "claude-sonnet-4-5"  # Same cheap/fast classifier used in run_enrichment.py
BATCH_SIZE = 50
SLEEP_BETWEEN_CALLS = 0.5

ALLOWED_TOPICS = [
    "travel", "food_beverage", "entertainment", "personal_state",
    "financial_services", "civic_political", "retail", "brand_dynamics",
    "home_life", "telecommunications", "occasions_seasonal", "health_wellness",
    "ad_testing", "work_career", "kids_family", "general_joy",
]

VALID_TOPICS_SET = set(ALLOWED_TOPICS) | {"not_an_item"}
VALID_CONFIDENCES = {"high", "medium", "low"}

SYSTEM_PROMPT = """You classify survey items into exactly one topic. You are given a list of item texts.
For each, decide what the item itself is about, independent of any survey or question it
may have come from. Return only JSON.

Allowed topics (choose exactly one, or "not_an_item"):
- travel: trips, destinations, vacations, the act and stages of traveling
- food_beverage: eating, drinking, food and drink products, dining, cooking
- entertainment: sports, fandom, TV, film, music, games, live events, following or watching
- personal_state: mood and emotional states and rest not tied to a category (feeling calm, sleeping)
- financial_services: money, budgeting, saving, insurance, financing, affordability, banking
- civic_political: politics, news, government, social and civic issues
- retail: shopping, stores, and non-food products, browsing and buying
- brand_dynamics: attitudes toward brands themselves, trust, loyalty, brand involvement in fandom
- home_life: the home, living space, furnishing, decorating, household
- telecommunications: phone, internet, and TV service, carriers, connectivity, and consumer devices
- occasions_seasonal: holidays, seasons, celebrations, calendar moments
- health_wellness: physical and mental health, fitness, self-care, skincare, medical care
- ad_testing: reactions to an advertisement or ad concept shown in the survey
- work_career: job, workplace, career, work tasks
- kids_family: children, parenting, family relationships, caregiving
- general_joy: joy in the abstract or life-joy items not tied to any category

Rules:
- Choose the single best topic for the item's primary subject.
- If the text is not an analyzable item (a survey non-answer like "Don't know" or
  "I'm not sure", a demographic option, a question stem or fragment, or pure filler),
  return "not_an_item".
- Never invent a topic outside the list. Consumer electronics and devices go to
  telecommunications unless the item is clearly about media content (entertainment) or
  the home setting (home_life).
- confidence is "high" only when the item text alone makes the topic clear. Use "medium"
  when plausible but underspecified, "low" when you are guessing.

Output: a JSON array, one object per input item, same order, no prose, no markdown:
[{"topic":"<one allowed value or not_an_item>","confidence":"high|medium|low","reason":"<=12 words"}]"""


def fetch_job1(conn) -> list[dict[str, Any]]:
    """Rows in bjl_items needing rescan."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT item_id, item_name, primary_topic, haiku_confidence
            FROM bjl_items
            WHERE haiku_confidence IN ('medium','low')
               OR haiku_confidence IS NULL
               OR primary_topic = 'technology'
               OR primary_topic NOT IN (
                  'travel','food_beverage','entertainment','personal_state',
                  'financial_services','civic_political','retail','brand_dynamics',
                  'home_life','telecommunications','occasions_seasonal',
                  'health_wellness','ad_testing','work_career','kids_family','general_joy'
               )
            ORDER BY item_id
        """)
        return [dict(r) for r in cur.fetchall()]


def fetch_job2(conn) -> list[dict[str, Any]]:
    """bjl_scores rows still with NULL item_topic (no matching bjl_items)."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""
            SELECT id, item_name
            FROM bjl_scores
            WHERE item_topic IS NULL
            ORDER BY id
        """)
        return [dict(r) for r in cur.fetchall()]


def classify_batch(client: anthropic.Anthropic, items: list[dict], name_key: str) -> list[dict]:
    """Send a batch of item_name strings; parse a JSON array of {topic,confidence,reason}."""
    names = [it[name_key] for it in items]
    user_msg = f"Classify these items (return one object per item, same order):\n{json.dumps(names, ensure_ascii=False)}"

    response = client.messages.create(
        model=MODEL,
        max_tokens=12000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )

    text = response.content[0].text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        if text.startswith("json"):
            text = text[4:].strip()

    parsed = json.loads(text)
    if not isinstance(parsed, list):
        raise ValueError("classifier returned non-array")
    return parsed


def writeback_job1(conn, sources: list[dict], tagged: list[dict], dry_run: bool) -> tuple[int, int, int]:
    """Guarded UPDATE on bjl_items. Returns (updates_applied, guarded_skips, not_an_item_skips)."""
    if dry_run:
        print(f"  [DRY RUN] Would consider {len(tagged)} classifications")
        for src, t in list(zip(sources, tagged))[:5]:
            print(f"    #{src['item_id']} '{src['item_name'][:60]}' "
                  f"(was {src['primary_topic']}/{src['haiku_confidence']}) "
                  f"→ {t.get('topic')}/{t.get('confidence')}  {t.get('reason','')}")
        return (0, 0, 0)

    if len(tagged) != len(sources):
        print(f"  WARN: pairing count mismatch (sources={len(sources)}, tagged={len(tagged)})", file=sys.stderr)

    pair_count = min(len(sources), len(tagged))
    updates = guarded_skips = not_item_skips = 0

    with conn.cursor() as cur:
        for i in range(pair_count):
            src = sources[i]
            t = tagged[i]
            new_topic = t.get("topic")
            new_conf = t.get("confidence")

            # Defensive validation against the controlled vocabulary
            if new_topic not in VALID_TOPICS_SET:
                print(f"  WARN: item {src['item_id']} got out-of-vocab topic '{new_topic}', skipping", file=sys.stderr)
                continue
            if new_conf not in VALID_CONFIDENCES:
                new_conf = "low"

            if new_topic == "not_an_item":
                not_item_skips += 1
                continue

            # Guarded writeback: skip if the item currently sits on 'high'.
            # Curly apostrophes / quotes are not a concern here because we match
            # on item_id, not on echoed item_name.
            cur.execute("""
                UPDATE bjl_items
                SET primary_topic = %s,
                    primary_topic_haiku = %s,
                    haiku_confidence = %s
                WHERE item_id = %s
                  AND haiku_confidence IS DISTINCT FROM 'high'
            """, (new_topic, new_topic, new_conf, src["item_id"]))
            if cur.rowcount:
                updates += cur.rowcount
            else:
                guarded_skips += 1
    conn.commit()
    return (updates, guarded_skips, not_item_skips)


def writeback_job2(conn, sources: list[dict], tagged: list[dict], dry_run: bool) -> tuple[int, int]:
    """Write real items directly to bjl_scores.item_topic by id. Returns (writes, not_item_skips)."""
    if dry_run:
        print(f"  [DRY RUN] Would consider {len(tagged)} classifications")
        for src, t in list(zip(sources, tagged))[:10]:
            print(f"    #{src['id']} '{src['item_name'][:60]}' → {t.get('topic')}  {t.get('reason','')}")
        return (0, 0)

    if len(tagged) != len(sources):
        print(f"  WARN: pairing count mismatch (sources={len(sources)}, tagged={len(tagged)})", file=sys.stderr)

    pair_count = min(len(sources), len(tagged))
    writes = not_item_skips = 0

    with conn.cursor() as cur:
        for i in range(pair_count):
            src = sources[i]
            t = tagged[i]
            new_topic = t.get("topic")

            if new_topic not in VALID_TOPICS_SET:
                print(f"  WARN: id {src['id']} got out-of-vocab topic '{new_topic}', skipping", file=sys.stderr)
                continue
            if new_topic == "not_an_item":
                not_item_skips += 1
                continue

            cur.execute("""
                UPDATE bjl_scores
                SET item_topic = %s
                WHERE id = %s
            """, (new_topic, src["id"]))
            writes += cur.rowcount
    conn.commit()
    return (writes, not_item_skips)


def repropagate_item_topic(conn, dry_run: bool) -> int:
    """Refresh bjl_scores.item_topic from bjl_items on a punctuation-normalized name key.
    Highest confidence, then most frequent, wins per name. Runs once after Job 1."""
    if dry_run:
        print("[DRY RUN] Would re-propagate bjl_scores.item_topic from bjl_items")
        return 0
    with conn.cursor() as cur:
        cur.execute("""
            WITH cand AS (
              SELECT lower(btrim(replace(replace(replace(replace(item_name,'’',''''),'‘',''''),'“','"'),'”','"'))) AS k,
                     primary_topic AS topic,
                     MAX(CASE haiku_confidence WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END) AS best_conf,
                     COUNT(*) AS freq
              FROM bjl_items
              WHERE primary_topic IS NOT NULL
              GROUP BY 1, primary_topic
            ),
            pick AS (
              SELECT DISTINCT ON (k) k, topic
              FROM cand
              ORDER BY k, best_conf DESC, freq DESC, topic
            )
            UPDATE bjl_scores s
            SET item_topic = p.topic
            FROM pick p
            WHERE lower(btrim(replace(replace(replace(replace(s.item_name,'’',''''),'‘',''''),'“','"'),'”','"'))) = p.k
              AND s.item_topic IS DISTINCT FROM p.topic
        """)
        n = cur.rowcount
        conn.commit()
        return n


def verification(conn) -> None:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        print("\n=== Verification ===")
        print("\n1) bjl_items confidence distribution:")
        cur.execute("""
            SELECT COALESCE(haiku_confidence, '(null)') AS haiku_confidence, COUNT(*) AS n
            FROM bjl_items GROUP BY 1 ORDER BY n DESC
        """)
        for r in cur.fetchall():
            print(f"   {r['haiku_confidence']:>10} : {r['n']}")

        print("\n2) Off-taxonomy topics remaining in bjl_items:")
        cur.execute("""
            SELECT primary_topic, COUNT(*) AS n
            FROM bjl_items
            WHERE primary_topic IS NOT NULL
              AND primary_topic NOT IN (
                'travel','food_beverage','entertainment','personal_state',
                'financial_services','civic_political','retail','brand_dynamics',
                'home_life','telecommunications','occasions_seasonal',
                'health_wellness','ad_testing','work_career','kids_family','general_joy'
              )
            GROUP BY 1 ORDER BY n DESC
        """)
        rows = cur.fetchall()
        if not rows:
            print("   (none)")
        for r in rows:
            print(f"   {r['primary_topic']:>20} : {r['n']}")

        print("\n3) bjl_scores.item_topic coverage:")
        cur.execute("SELECT COUNT(*) AS rows, COUNT(item_topic) AS tagged FROM bjl_scores")
        r = cur.fetchone()
        pct = 100.0 * r['tagged'] / r['rows'] if r['rows'] else 0.0
        print(f"   {r['tagged']}/{r['rows']} ({pct:.2f}%) tagged")


def run_job(name, fetch_fn, writeback_fn, name_key, client, conn, args) -> None:
    print(f"\n=== {name} ===")
    all_items = fetch_fn(conn)
    print(f"{name} queue: {len(all_items)} items")
    if not all_items:
        return

    totals = [0, 0, 0]  # updates, guarded_skips, not_item_skips (job 2 uses first two)
    for batch_num, start in enumerate(range(0, len(all_items), args.limit), start=1):
        if batch_num > args.max_batches:
            print(f"[stopping at max_batches={args.max_batches}]")
            break
        batch = all_items[start:start + args.limit]
        print(f"\nBatch {batch_num}: {len(batch)} items (window {start+1}..{start+len(batch)})")

        try:
            tagged = classify_batch(client, batch, name_key)
        except (json.JSONDecodeError, ValueError, KeyError) as e:
            print(f"  ERROR parsing classifier response: {e}", file=sys.stderr)
            time.sleep(3)
            continue
        except anthropic.APIError as e:
            print(f"  ERROR from Anthropic API: {e}", file=sys.stderr)
            time.sleep(10)
            continue

        if writeback_fn is writeback_job1:
            u, g, ni = writeback_fn(conn, batch, tagged, args.dry_run)
            totals[0] += u; totals[1] += g; totals[2] += ni
            print(f"  updated={u}  guarded_skipped={g}  not_an_item={ni}")
        else:
            w, ni = writeback_fn(conn, batch, tagged, args.dry_run)
            totals[0] += w; totals[2] += ni
            print(f"  written={w}  not_an_item={ni}")

        time.sleep(SLEEP_BETWEEN_CALLS)

    if writeback_fn is writeback_job1:
        print(f"\n{name} totals: updated={totals[0]}, guarded_skipped={totals[1]}, not_an_item={totals[2]}")
    else:
        print(f"\n{name} totals: written={totals[0]}, not_an_item={totals[2]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", choices=["1", "2", "both"], default="both")
    parser.add_argument("--limit", type=int, default=BATCH_SIZE)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-batches", type=int, default=999)
    parser.add_argument("--skip-propagation", action="store_true",
                        help="Skip the re-propagation step after Job 1")
    parser.add_argument("--skip-verification", action="store_true")
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

    if args.job in ("1", "both"):
        run_job("Job 1 (bjl_items rescan)", fetch_job1, writeback_job1, "item_name", client, conn, args)
        if not args.skip_propagation:
            print("\n=== Re-propagating bjl_scores.item_topic ===")
            n = repropagate_item_topic(conn, args.dry_run)
            print(f"bjl_scores rows updated by propagation: {n}")

    if args.job in ("2", "both"):
        run_job("Job 2 (bjl_scores null residue)", fetch_job2, writeback_job2, "item_name", client, conn, args)

    if not args.skip_verification and not args.dry_run:
        verification(conn)

    conn.close()


if __name__ == "__main__":
    main()
