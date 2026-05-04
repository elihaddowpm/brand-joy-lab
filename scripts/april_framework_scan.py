#!/usr/bin/env python3
"""Phase 5: framework Haiku scan on April 2026 verbatims.

For each substantive (>=5 char) April verbatim, asks Haiku 4.5 to tag
joy_modes / tensions / functional_jobs / occasions from the canonical
BJL frameworks. Writes to *_haiku SHADOW columns only — does NOT promote
to live columns until operator review.

Run: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... ANTHROPIC_API_KEY=... python3 framework_scan.py

Cost estimate: ~$0.30 in Haiku tokens for 1k verbatims.
Wall time: ~5-8 minutes.
"""
import os, sys, time, json, math
import requests
from anthropic import Anthropic

SUPABASE_URL = os.environ['SUPABASE_URL']
SERVICE_KEY = os.environ['SUPABASE_SERVICE_KEY']
HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

client = Anthropic()
HAIKU_MODEL = "claude-haiku-4-5-20251001"
BATCH_SIZE = 20

JOY_MODES = ["achievement", "aesthetic", "awe", "freedom", "hedonic", "inspirational",
             "physical", "playful", "relational", "self_actualization", "sentimental",
             "spiritual", "tranquil", "triumph"]
TENSIONS = ["aspiration_vs_acceptance", "challenger_vs_legacy", "control_vs_surrender",
            "digital_vs_physical", "discovery_vs_comfort", "forgiveness_vs_foresight",
            "individual_vs_communal", "introvert_vs_extrovert", "luxury_vs_value",
            "moderation_vs_indulgence", "performance_vs_pleasure", "present_vs_future",
            "savings_vs_spending", "self_vs_others", "tradition_vs_modern"]
FUNCTIONAL_JOBS = ["build_belonging", "cheer_team", "compete", "connect_remotely",
                   "create_memory", "demonstrate_care", "display_taste", "escape_routine",
                   "express_creativity", "feel_proud", "immerse_in_story", "learn_grow",
                   "mark_milestone", "nourish_others", "plan_future", "preserve_tradition",
                   "provide_security", "refuel", "relax_recover", "relieve_anxiety",
                   "reward_self", "share_experience", "signal_identity", "signal_status"]
OCCASIONS = ["alone_time", "anticipation", "birthday", "celebration", "evening",
             "everyday", "gathering", "gift_giving", "holiday", "hosting", "in_moment",
             "live_event", "mealtime", "memory", "morning", "post_purchase",
             "purchase_moment", "shopping", "special_occasion", "sports_viewing",
             "transition", "travel_journey", "vacation", "weekend", "work"]

SYSTEM_PROMPT = f"""You are tagging consumer verbatim responses from the BJL (Brand Joy Lab) database with four frameworks.

For each verbatim, return a JSON object with these arrays (each value MUST come from the controlled vocab):

joy_modes (pick 0-3 most relevant): {JOY_MODES}
tensions (pick 0-2 most relevant, or empty): {TENSIONS}
functional_jobs (pick 0-2 most relevant): {FUNCTIONAL_JOBS}
occasions (pick 0-2 most relevant): {OCCASIONS}

Rules:
- ONLY use values from the controlled lists above. NEVER invent new tags.
- Empty arrays are fine if the verbatim doesn't fit the framework. Do not force tags.
- joy_modes is the primary framework — most verbatims should have at least one if they describe a joy/positive state.
- tensions only when the verbatim explicitly surfaces a pull between two competing values (rarer than the others).
- functional_jobs = what the consumer is hiring the activity/product to do for them.
- occasions = the moment or context the verbatim describes.

Return JSON array, one object per input, in input order. Each object MUST have all 4 keys:
{{"joy_modes": [...], "tensions": [...], "functional_jobs": [...], "occasions": [...]}}

Return ONLY valid JSON, no preamble, no code fences."""

def fetch_verbatims():
    url = f"{SUPABASE_URL}/rest/v1/bjl_verbatims"
    params = {
        "year_month": "eq.2026-04",
        "select": "id,response_text,question_text",
        "response_text": "not.is.null",
    }
    all_rows = []
    # PostgREST returns max 1000 by default; set Range
    headers = dict(HEADERS, **{"Range-Unit": "items", "Range": "0-9999"})
    r = requests.get(url, headers=headers, params=params, timeout=30)
    r.raise_for_status()
    rows = r.json()
    # Filter substantive
    rows = [r for r in rows if r.get("response_text") and len(r["response_text"].strip()) >= 5]
    return rows

def scan_batch(batch):
    """Send a batch of verbatims to Haiku, return list of tag dicts."""
    user_msg_parts = ["Tag these verbatims. Return a JSON array, one object per verbatim, in order:\n"]
    for i, v in enumerate(batch, 1):
        qcontext = (v.get("question_text") or "")[:80]
        text = (v.get("response_text") or "").replace('\n', ' ')[:600]
        user_msg_parts.append(f"\n{i}. Question: {qcontext}\n   Response: {text}")
    user_msg = "\n".join(user_msg_parts)

    response = client.messages.create(
        model=HAIKU_MODEL,
        max_tokens=4000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_msg}],
    )
    raw = response.content[0].text.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        if raw.startswith("json"):
            raw = raw[4:].strip()
    try:
        tags = json.loads(raw)
    except json.JSONDecodeError:
        # Try one more time: strip trailing junk
        end = raw.rfind(']')
        if end != -1:
            tags = json.loads(raw[:end+1])
        else:
            raise
    if len(tags) != len(batch):
        print(f"    WARN: returned {len(tags)} tags for {len(batch)} inputs")
    return tags

def update_verbatim(vid, tags):
    """PATCH the *_haiku columns on a single verbatim row."""
    url = f"{SUPABASE_URL}/rest/v1/bjl_verbatims?id=eq.{vid}"
    # Filter tags to only canonical values (defensive)
    payload = {
        "joy_modes_haiku": [t for t in tags.get("joy_modes", []) if t in JOY_MODES],
        "tensions_haiku": [t for t in tags.get("tensions", []) if t in TENSIONS],
        "functional_jobs_haiku": [t for t in tags.get("functional_jobs", []) if t in FUNCTIONAL_JOBS],
        "occasions_haiku": [t for t in tags.get("occasions", []) if t in OCCASIONS],
        "framework_scanned_at": "now()",
    }
    headers = dict(HEADERS, **{"Prefer": "return=minimal"})
    r = requests.patch(url, headers=headers, json=payload, timeout=30)
    if r.status_code not in (200, 204):
        print(f"    UPDATE FAILED for id={vid}: HTTP {r.status_code} {r.text[:200]}")
        return False
    return True


print("Fetching April verbatims...")
verbatims = fetch_verbatims()
print(f"  {len(verbatims)} substantive verbatims to scan")

n_batches = math.ceil(len(verbatims) / BATCH_SIZE)
print(f"  {n_batches} batches of up to {BATCH_SIZE}")

t0 = time.time()
total_updated = 0
total_failed = 0
for batch_idx in range(n_batches):
    batch = verbatims[batch_idx*BATCH_SIZE:(batch_idx+1)*BATCH_SIZE]
    try:
        tags_list = scan_batch(batch)
    except Exception as e:
        print(f"  batch {batch_idx} SCAN FAILED: {e}")
        total_failed += len(batch)
        continue
    for v, tags in zip(batch, tags_list):
        if update_verbatim(v['id'], tags):
            total_updated += 1
        else:
            total_failed += 1
    if (batch_idx + 1) % 5 == 0 or batch_idx == n_batches - 1:
        elapsed = time.time() - t0
        rate = total_updated / elapsed if elapsed > 0 else 0
        eta = (len(verbatims) - total_updated) / rate if rate > 0 else 0
        print(f"  batch {batch_idx + 1}/{n_batches} — updated {total_updated} failed {total_failed} ({elapsed:.0f}s, ETA {eta:.0f}s)")
    time.sleep(0.2)  # gentle on the API

print(f"\nDone. Updated {total_updated}, failed {total_failed} in {time.time()-t0:.0f}s")
