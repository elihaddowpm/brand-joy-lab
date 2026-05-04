"""
Tag April 2026 wave catalog (questions + items) via Haiku 4.5.

Inputs:
  - data/april_inventory.json — 31 questions with items, sample values, inferred types

Outputs:
  - data/april_question_tags.json — primary_topic, subtags, short_label, confidence per question
  - data/april_item_tags.json — primary_topic, subtags, is_brand, canonical_brand per item

Run:
  ANTHROPIC_API_KEY=... python tag_april_catalog.py

Cost: under $1. Wall time: 1-2 minutes.
"""

import os, sys, json, time
from anthropic import Anthropic

if not os.environ.get('ANTHROPIC_API_KEY'):
    sys.exit("Set ANTHROPIC_API_KEY env var")

client = Anthropic()
HAIKU_MODEL = "claude-haiku-4-5-20251001"

# Load inventory
with open('data/april_inventory.json') as f:
    inventory = json.load(f)

CANONICAL_TOPICS = [
    'financial_services', 'food_beverage', 'travel', 'retail', 'entertainment',
    'telecommunications', 'health_wellness', 'home_life', 'occasions_seasonal',
    'civic_political', 'work_career', 'personal_state', 'sports_fandom',
    'brand_trust', 'technology_internet', 'food_eating', 'food_joy',
    'retail_grocery', 'sports_tailgating', 'travel_attractions',
    'travel_destinations', 'travel_hospitality', 'travel_journey_stages',
    'general_joy', 'home_furniture', 'health_ratings', 'celebrities'
]

# ============================================================================
# Phase 1A: Tag the 31 questions
# ============================================================================

QUESTION_PROMPT = f"""You are tagging survey questions for the BJL Intelligence Engine.

For each question, return JSON with these fields:
- primary_topic: ONE canonical category from: {', '.join(CANONICAL_TOPICS)}
- subtags: array of 2-5 specific topical tags using snake_case (e.g., 'banking_relationship', 'switching_behavior', 'wine_consumption_patterns')
- short_label: 5-10 word descriptor of what the question measures
- confidence: 'high' | 'medium' | 'low'

Tagging rules:
- Banking/wealth/insurance questions → 'financial_services'
- Wine/beer/cocktail/beverage questions → 'food_beverage'
- Cross-category questions about general joy → 'general_joy'
- subtags should be specific enough to disambiguate (e.g., 'wine_drinking_decreased_reasons' not just 'wine')
- Never invent topic categories. Use only the canonical list above.

Return ONLY valid JSON array, no preamble."""

print("Phase 1A: Tagging 31 questions...")

parts = ["Tag these 31 questions. Return a JSON array with one object per question, in order:\n"]
for q in inventory:
    parts.append(f"\nQuestion {q['q_num']}:")
    parts.append(f"  Question text: {q['question_text']}")
    parts.append(f"  Number of items: {q['n_items']}")
    parts.append(f"  Inferred type: {q['inferred_type']}")
    parts.append(f"  Sample values: {q['sample_values'][:8]}")
    if q['n_items'] > 1:
        sample_items = [it['item_name'] for it in q['items'][:5] if it['item_name']]
        if sample_items:
            parts.append(f"  Sample items: {sample_items}")
user_msg = "\n".join(parts)

response = client.messages.create(
    model=HAIKU_MODEL,
    max_tokens=4000,
    system=QUESTION_PROMPT,
    messages=[{"role": "user", "content": user_msg}]
)
raw = response.content[0].text.strip()
if raw.startswith("```"):
    raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
question_tags = json.loads(raw)
assert len(question_tags) == 31, f"Expected 31 question tags, got {len(question_tags)}"

with open('data/april_question_tags.json', 'w') as f:
    json.dump(question_tags, f, indent=2)
print(f"  Saved {len(question_tags)} question tags to data/april_question_tags.json")

# ============================================================================
# Phase 1B: Tag the items (~199)
# ============================================================================

ITEM_PROMPT = f"""You are tagging survey items for the BJL Intelligence Engine.

Each item is a single response option or sub-question that belongs to a parent question.

For each item, return JSON with:
- primary_topic: ONE canonical category from: {', '.join(CANONICAL_TOPICS)}
- subtags: 2-5 specific snake_case tags
- is_brand: true/false — true if the item names a specific commercial brand or product line
- canonical_brand: the canonical brand name if is_brand=true, else null
- confidence: 'high' | 'medium' | 'low'

Tagging rules:
- Items inherit the parent question's primary_topic in most cases — confirm or override
- For named bank brands (Chase, Bank of America, Ally, Chime), is_brand=true
- For wine items, is_brand=false unless the item names a specific wine brand
- For joy mode response options like "Playful — fun, lighthearted, and unpretentious", primary_topic='general_joy'
- Never invent topic categories.

Return ONLY a valid JSON array in input order, no preamble."""

# Build list of all items across all questions, with parent question context
items_to_tag = []
for q in inventory:
    parent_topic = next((t['primary_topic'] for t in question_tags if 'q_num' not in t), None)
    # Find the matched question_tag
    q_tag = question_tags[q['q_num'] - 1]
    for item in q['items']:
        items_to_tag.append({
            'q_num': q['q_num'],
            'parent_question': q['question_text'][:120],
            'parent_topic': q_tag.get('primary_topic'),
            'item_name': item['item_name'],
            'col_idx': item['col_idx']
        })

print(f"Phase 1B: Tagging {len(items_to_tag)} items in batches...")

# Process in batches of 40 to respect token limits
BATCH_SIZE = 40
all_item_tags = []

for batch_start in range(0, len(items_to_tag), BATCH_SIZE):
    batch = items_to_tag[batch_start:batch_start + BATCH_SIZE]
    parts = [f"Tag these {len(batch)} items. Return JSON array, one object per input, in order:\n"]
    for idx, it in enumerate(batch, 1):
        parts.append(f"\n{idx}. Parent question: \"{it['parent_question']}\"")
        parts.append(f"   Parent topic: {it['parent_topic']}")
        parts.append(f"   Item name: {it['item_name']}")
    user_msg = "\n".join(parts)

    try:
        response = client.messages.create(
            model=HAIKU_MODEL,
            max_tokens=4000,
            system=ITEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}]
        )
        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        batch_tags = json.loads(raw)
        if len(batch_tags) != len(batch):
            print(f"  WARNING: batch {batch_start} returned {len(batch_tags)} tags for {len(batch)} items")
        all_item_tags.extend(batch_tags)
        print(f"  batch {batch_start//BATCH_SIZE + 1}: tagged {len(batch_tags)} items")
    except Exception as e:
        print(f"  batch {batch_start} failed: {e}")
        # On failure, append placeholder tags so the array stays aligned
        for it in batch:
            all_item_tags.append({
                'primary_topic': it['parent_topic'],
                'subtags': [],
                'is_brand': False,
                'canonical_brand': None,
                'confidence': 'low',
                '_error': str(e)
            })
    time.sleep(0.3)

# Attach the col_idx and item_name to each tag for downstream use
for tag, src in zip(all_item_tags, items_to_tag):
    tag['col_idx'] = src['col_idx']
    tag['item_name'] = src['item_name']
    tag['q_num'] = src['q_num']

with open('data/april_item_tags.json', 'w') as f:
    json.dump(all_item_tags, f, indent=2)
print(f"  Saved {len(all_item_tags)} item tags to data/april_item_tags.json")

# ============================================================================
# Summary diff for Eli's review
# ============================================================================

print(f"\n=== SUMMARY ===")
print(f"Tagged {len(question_tags)} questions, {len(all_item_tags)} items")
print(f"\nQuestion topic distribution:")
from collections import Counter
q_topics = Counter(t['primary_topic'] for t in question_tags)
for t, n in q_topics.most_common():
    print(f"  {t}: {n}")
print(f"\nItem topic distribution:")
i_topics = Counter(t['primary_topic'] for t in all_item_tags)
for t, n in i_topics.most_common():
    print(f"  {t}: {n}")
print(f"\nLow-confidence questions: {sum(1 for t in question_tags if t['confidence']=='low')}")
print(f"Low-confidence items: {sum(1 for t in all_item_tags if t.get('confidence')=='low')}")
print(f"Items flagged is_brand=true: {sum(1 for t in all_item_tags if t.get('is_brand'))}")

print(f"\nNext step: review data/april_question_tags.json and data/april_item_tags.json")
print("Then run scripts/build_catalog_inserts.py to generate SQL.")
