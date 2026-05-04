"""
Generate SQL inserts for bjl_questions_v2 and bjl_items from the Haiku tagging output.

Inputs:
  - data/april_inventory.json
  - data/april_question_tags.json (from tag_april_catalog.py)
  - data/april_item_tags.json (from tag_april_catalog.py)

Outputs:
  - scripts/insert_april_catalog.sql — applied via Supabase apply_migration

Run after Eli has reviewed and approved the tag outputs.
"""

import json

# Adjust these to match the current DB max IDs at time of run
# Verify before running with: SELECT MAX(question_id) FROM bjl_questions_v2; SELECT MAX(item_id) FROM bjl_items;
START_QUESTION_ID = 416  # current max is 415
START_ITEM_ID = 5392     # current max is 5391

with open('data/april_inventory.json') as f:
    inventory = json.load(f)
with open('data/april_question_tags.json') as f:
    question_tags = json.load(f)
with open('data/april_item_tags.json') as f:
    item_tags = json.load(f)

# Build question_id and item_id mappings
question_id_for_q_num = {}
for i, q in enumerate(inventory):
    question_id_for_q_num[q['q_num']] = START_QUESTION_ID + i

# Verify counts align
assert len(question_tags) == len(inventory), "Question tags count mismatch"

def sql_escape(s):
    if s is None:
        return 'NULL'
    return "'" + str(s).replace("'", "''") + "'"

def array_sql(arr):
    if not arr:
        return "ARRAY[]::text[]"
    quoted = ", ".join("'" + s.replace("'", "''") + "'" for s in arr)
    return f"ARRAY[{quoted}]::text[]"

# Generate SQL
lines = [
    "-- ============================================================================",
    "-- April 2026 wave catalog inserts",
    "-- Auto-generated from data/april_inventory.json + tag outputs",
    "-- ============================================================================",
    "",
    "BEGIN;",
    "",
    "-- Sanity check: verify current max IDs match expectations before inserting",
    "DO $$",
    "DECLARE",
    "  current_max_q INT;",
    "  current_max_i INT;",
    "BEGIN",
    "  SELECT COALESCE(MAX(question_id), 0) INTO current_max_q FROM bjl_questions_v2;",
    "  SELECT COALESCE(MAX(item_id), 0) INTO current_max_i FROM bjl_items;",
    f"  IF current_max_q != {START_QUESTION_ID - 1} THEN",
    f"    RAISE EXCEPTION 'Expected max question_id={START_QUESTION_ID - 1}, got %', current_max_q;",
    "  END IF;",
    f"  IF current_max_i != {START_ITEM_ID - 1} THEN",
    f"    RAISE EXCEPTION 'Expected max item_id={START_ITEM_ID - 1}, got %', current_max_i;",
    "  END IF;",
    "END $$;",
    "",
    "-- ============================================================================",
    "-- Insert 31 new questions",
    "-- ============================================================================",
    "",
]

for i, (q, t) in enumerate(zip(inventory, question_tags)):
    qid = question_id_for_q_num[q['q_num']]
    lines.append(f"INSERT INTO bjl_questions_v2 (question_id, question_text, primary_topic, subtags, question_type, short_label) VALUES")
    lines.append(f"  ({qid}, {sql_escape(q['question_text'])}, {sql_escape(t['primary_topic'])}, {array_sql(t.get('subtags', []))}, {sql_escape(q['inferred_type'])}, {sql_escape(t.get('short_label'))});")
    lines.append("")

lines.append("")
lines.append("-- ============================================================================")
lines.append(f"-- Insert ~{len(item_tags)} new items (linked to questions above)")
lines.append("-- ============================================================================")
lines.append("")

next_item_id = START_ITEM_ID
for tag in item_tags:
    qid = question_id_for_q_num[tag['q_num']]
    iid = next_item_id
    next_item_id += 1
    
    item_name = tag.get('item_name')
    # If item_name is None (single-item question), use the question text or a placeholder
    if not item_name:
        # Get the question text from inventory
        parent_q = next(q for q in inventory if q['q_num'] == tag['q_num'])
        item_name = f"(single-item) {parent_q['question_text'][:80]}"
    
    lines.append(
        f"INSERT INTO bjl_items (item_id, question_id, item_name, primary_topic, subtags, is_brand, canonical_brand) VALUES "
        f"({iid}, {qid}, {sql_escape(item_name)}, {sql_escape(tag['primary_topic'])}, {array_sql(tag.get('subtags', []))}, "
        f"{str(tag.get('is_brand', False)).lower()}, {sql_escape(tag.get('canonical_brand'))});"
    )

lines.append("")
lines.append("COMMIT;")
lines.append("")
lines.append("-- Verification queries (run after commit):")
lines.append("-- SELECT COUNT(*) FROM bjl_questions_v2;       -- expect 446")
lines.append(f"-- SELECT COUNT(*) FROM bjl_items;              -- expect ~{START_ITEM_ID - 1 + len(item_tags)}")
lines.append("-- SELECT MAX(question_id), MAX(item_id) FROM bjl_questions_v2 q JOIN bjl_items i ON i.question_id = q.question_id;")

with open('scripts/insert_april_catalog.sql', 'w') as f:
    f.write("\n".join(lines))

print(f"Wrote scripts/insert_april_catalog.sql")
print(f"  31 questions: IDs {START_QUESTION_ID} to {START_QUESTION_ID + 30}")
print(f"  {len(item_tags)} items: IDs {START_ITEM_ID} to {next_item_id - 1}")
print(f"\nApply via Supabase MCP apply_migration or psql.")
print(f"After apply, also save the column_idx → (question_id, item_id) mapping for Phase 4.")

# Also build the column_idx → (question_id, item_id) lookup that Phase 4 needs
col_to_ids = {}
next_item_id = START_ITEM_ID
for tag in item_tags:
    qid = question_id_for_q_num[tag['q_num']]
    iid = next_item_id
    next_item_id += 1
    col_to_ids[tag['col_idx']] = {'question_id': qid, 'item_id': iid}

with open('data/april_col_to_ids.json', 'w') as f:
    json.dump(col_to_ids, f, indent=2)
print(f"\nSaved column→IDs lookup to data/april_col_to_ids.json (for use in Phase 4 response load)")
