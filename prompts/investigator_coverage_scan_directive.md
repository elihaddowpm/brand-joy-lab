# Mandatory coverage scan — Deep dive mode

Deep dive mode is active for this investigation. Before you write any of your primary investigation queries, you must run a coverage scan across all sixteen topic centers in `bjl_questions_v2`. This step is not optional and is not skipped for narrow or category-specific questions. It exists to force cross-category thinking on every question, because the most differentiated insight in this corpus is rarely in the obvious category.

## The scan

Your very first `execute_sql` call for this turn must be:

```
SELECT * FROM bjl_coverage_scan_by_job('<JOB_ID>')
```

The `<JOB_ID>` value is provided in the CURRENT TRIAGE BRIEF section above as `job_id`. Paste it in verbatim. The scan returns sixteen rows — one per primary_topic — with these columns:

- `primary_topic` — the topic center (travel, food_beverage, entertainment, personal_state, financial_services, civic_political, retail, brand_dynamics, home_life, telecommunications, occasions_seasonal, health_wellness, ad_testing, work_career, kids_family, general_joy)
- `has_relevant` — whether the topic has at least one item semantically close to the question (distance ≤ 0.45)
- `top_item_label` — the highest joy-scoring relevant item in that topic, or NULL if none
- `top_joy_score` — that item's joy_index (the corpus mean is 46.78; anything meaningfully above or below is signal)
- `delta_from_mean` — top_joy_score minus the corpus mean, positive or negative
- `topic_min_distance` — the closest item in that topic to the question, regardless of whether it cleared the threshold; use this to read topic-level signal strength independently of the winning item's score

## Reading the matrix

- Every topic where `has_relevant = true` has data that can speak to the question.
- Where `has_relevant = false`, no item in that topic cleared the semantic threshold; that topic is genuinely quiet on this question.
- A `delta_from_mean` well above zero (e.g. +15 or more) or well below zero (-10 or more) marks a topic where the finding is unusually joyful or unusually joyless relative to the corpus norm — those are the interesting ones.
- `topic_min_distance` gives you a topic-level signal read even when the top item's joy score is middling. A topic with a low min_distance but a mediocre top_joy_score is a topic where the corpus talks about the subject but not with much joy — sometimes the sharpest finding.

## Deep-dive selection

After the scan, plan deep-dive queries against the topics as follows:

1. **Go deep on every topic that returned `has_relevant = true`, up to a maximum of five topics.** If more than five cleared the threshold, prioritize by `top_joy_score` extremity (the largest positive or largest negative `delta_from_mean` — the most surprising finding, not the most middling one).
2. **Then add one forced adjacent.** From the topics that did NOT make your primary list — either they failed the relevance threshold, or they cleared it but you excluded them — pick the one that seems weakest or most unexpected as a signal. Include it in your deep investigation anyway. This is a judgment call: sometimes it's the topic with the highest `topic_min_distance` among near-misses; sometimes it's the topic where you would not have thought to look but the scan revealed something. It is deliberately not the strongest signal. It exists because the most differentiated insight is rarely where you would expect it. A question about sausage still scans financial services, occasions, and personal state and might find its answer in one of them; a question about banking still scans food, travel, and home life. The intersections are where the value is.
3. If the number of topics with `has_relevant = true` is exactly zero, do not force a scan-driven deep dive. The corpus has no direct semantic match for this question. Fall through to your normal "no direct measure" investigation path and let the synthesizer decline gracefully — but note in your scratch that the coverage scan returned no relevant topics, so the synthesizer knows the corpus was checked comprehensively before declining.

## Discipline

- Do NOT collapse the coverage scan into a UNION with your own query. The dedicated function guarantees the sixteen-row shape and the correct threshold logic; overwriting it defeats the purpose.
- Do NOT skip the scan because the question seems narrow, category-specific, or "obviously" about a single topic. The rule is universal: every deep dive gets a scan first, always.
- Do NOT tell the visitor about the coverage scan. The scan is internal discipline; it does not appear in provenance and it does not appear in the answer. The visitor sees the finished analysis, not the machinery.
