# Joy Map Tool — Design Spec v0.2

A workbench tool that helps PETERMAYER strategists find where a brand's emotional territory aligns with an audience's joy profile, and where it diverges. The tool surfaces alignment first (strategic strengths to amplify) and divergence second (challenges or stretch opportunities). It complements the BJL Intelligence Engine by adding brand-audience matching as a distinct workflow.

**Changes from v0.1:** Added detail on mapping bridge mechanics, confidence schema, stretch angle structure, and the first-pass mockup direction. Updated UI vocabulary to match the actual current site (modes/routes, not tabs). Pre-resolved one of the three open questions; the remaining two stay open for implementation surfacing.

---

## Three Workflows

The design supports three workflows. Phase 1 ships two of them.

**Workflow 1: Audience → Joy Profile.** Strategist enters audience parameters (demographic filters in Phase 1, named cohorts in Phase 2). Tool returns the full joy profile for that audience: top Layer 1 items, top Layer 2 items, framework-level patterns from Layer 3.

**Workflow 2: Brand → Audience Discovery.** Strategist enters brand text. Tool surfaces which audience cohorts the brand's emotional territory most resonates with. **Phase 2 scope.**

**Workflow 3: Brand + Audience → Dance Map.** Strategist enters both. Tool surfaces alignment (where brand and audience are already in step) and divergence (where they are not yet aligned). The strategic centerpiece.

Phase 1 ships Workflows 1 and 3.

---

## The Layer Model

All workflows operate over a layered data model. Layers run in order of methodological rigor, and queries descend through them in priority.

**Layer 1: joy_scale.** 9-point joy scale items with computed Joy Index on a 0-100 normalized scale. Sampling error only (~±5-7% at typical n=400). Direct measurement of joy on specific surveyed items. Gold standard.

**Layer 2: Quant items beyond JI.** Five sub-types, each with its own presentation conventions:
- **2a: ordinal_scale.** 3-point or other non-9-point ordinal scales. Reported as top-box % or response distribution.
- **2b: select_all.** Multi-select items. Reported as % of respondents selecting each option. Percentages sum above 100% across all options.
- **2c: likelihood_scale.** Behavioral intent items, usually 5-point. Reported as top-box ("Very likely") or distribution.
- **2d: familiarity_trust.** Brand familiarity and trust questions when fielded. Reported as top-box or distribution.
- **2e: numeric_0_10.** Direct numeric ratings, often satisfaction or NPS-style. Reported as mean, top/bottom box, or distribution.

**Layer 3: Framework tag aggregations.** Joy modes (14 tags), tensions (14 tags), functional jobs (23 tags), and occasions (25 tags) derived from LLM tagging of open-ended verbatim text. Precision around 73-78% F1 post-v7. Absolute rate claims carry ~3-5pp error. Sample-size floor of n=100 for audience cuts. Pattern-level resolution, no item-level specificity.

**Layer 4: Verbatim text.** Raw open-ended responses. Used for illustration, color, and direct quotation. Never used to ground aggregate claims.

---

## Layer Descent Protocol

For every query in every workflow:

1. **Start at Layer 1.** Identify every joy_scale item relevant to the query topic. For category-specific queries, category-specific items take priority over category-general ones. If Layer 1 covers the question, surface and stop descending.

2. **Add Layer 2.** Pull every relevant ordinal_scale, select_all, likelihood_scale, familiarity_trust, and numeric_0_10 item. Present alongside Layer 1, with clear visual and labeling separation between metric types. JI integers next to top-box percentages, never blended into a combined score.

3. **Within Layer 2, sub-priority runs:** 2a (ordinal_scale, closest analog to Layer 1) → 2c (likelihood) → 2b (select_all) → 2d / 2e (situational).

4. **Use Layer 3 only when Layer 1 and 2 don't cover the question.** Pattern-level questions, cross-cutting questions, or gap-filling for journey phases with no quant item. When Layer 3 fires, label the tradeoff: "n=X verbatims tagged, methodology precision ~75% F1."

5. **Sample-size floor on Layer 3:** don't surface Layer 3 audience-cut claims below n=100 verbatims for that cut. Below the floor, mark the gap rather than reporting noise.

6. **Layer 4 illustrates, never grounds.** Pull a verbatim quote to color a Layer 1/2/3 finding. If no higher-layer finding supports the point, the claim doesn't ship.

---

## Brand Input

Phase 1 ships brand text input through two modes:

1. **Waldo JSON paste-in** (primary, for prospect intelligence-driven analysis)
2. **Free-text field** (for ad-hoc strategist input)

The tool ingests the text as-is. No structured form fields required in Phase 1. The mapping bridge parses the text and maps to BJL data.

Brand-side numerical scoring is explicitly out of scope. BJL data does not measure individual brands; it measures joy across categories, items, and audience segments. The brand side of the equation lives in text.

**Phase 2 addition:** structured brand attribute form (positioning statement, target audience, current emotional territory, key tensions).

---

## Audience Input

Phase 1 ships demographic cut dropdowns covering the BJL audience dimensions:
- Age band
- Gender
- Household income
- Region
- Household type (presence of children, marital status)

The strategist picks one or more dimensions to define the cohort. The tool pulls audience-specific joy intensity across every layer. Show n once filters are applied.

**Phase 2 addition:** named audience library (curated cohorts).

---

## The Mapping Bridge (detailed)

The mapping bridge connects brand text input to BJL data. It runs as an LLM call inside the synthesis layer.

### Inputs to the bridge LLM call

- The brand offering text (Waldo JSON or free-text)
- A structured catalog of BJL items grouped by layer:
  - Layer 1 items with their full question text and JI scores
  - Layer 2a-e items with their full question text and top-box / distribution data
  - Layer 3 framework taxonomies (joy modes, tensions, jobs, occasions) with tag definitions
- The four framework taxonomies as a fallback vocabulary

### What the LLM returns

A JSON object with the following structure:

```json
{
  "layer_1_matches": [
    {
      "bjl_item_id": "uuid-or-key",
      "bjl_item_name": "Having a home you feel proud of",
      "brand_snippet": "the home they're building",
      "confidence": 0.88,
      "rationale": "brand language about 'building a home' maps to home pride"
    }
  ],
  "layer_2_matches": [
    {
      "bjl_item_id": "uuid-or-key",
      "bjl_item_name": "Knowing in advance what you can afford",
      "bjl_layer": "2a",
      "brand_snippet": "prequalification gives you confidence before you walk into the store",
      "confidence": 0.92,
      "rationale": "near-verbatim match on prequalification + confidence concept"
    }
  ],
  "layer_3_matches": [
    {
      "framework": "joy_modes",
      "tag": "relational",
      "brand_snippet": "help families",
      "confidence": 0.74,
      "rationale": "family-oriented language maps to relational joy mode"
    }
  ]
}
```

### Confidence schema

Confidence is a 0-1 score returned by the LLM with these calibration anchors:

- **0.9-1.0** = direct verbatim or near-verbatim match between brand language and BJL item
- **0.7-0.9** = strong semantic match (different words, same concept)
- **0.5-0.7** = directional match (broader theme, reasonable interpretation)
- **0.3-0.5** = weak match (loose conceptual connection)
- **Below 0.3** = filtered out, not surfaced

The tool surfaces only mappings with confidence ≥ 0.5 in the final output. Each surfaced mapping carries its confidence score, visible on hover or in a detail view (see Confidence Display below).

### Phase 2 calibration anchors

In Phase 2, the bridge prompt gains a `calibration_anchors` section: a JSON array of ~20 expert-validated brand-language-to-BJL-mapping pairs that the LLM uses as in-context examples to anchor its inference patterns. The anchors get added to the prompt before the brand text is presented for mapping. The schema for an anchor:

```json
{
  "brand_language_example": "We offer a fast, judgment-free path to financing.",
  "expected_matches": [
    {"layer": 1, "item": "Knowing in advance what you can afford", "confidence": 0.85},
    {"layer": "2a", "item": "Knowing you will not face a difficult or embarrassing moment", "confidence": 0.78}
  ],
  "notes": "Speed + dignity together; do not anchor to 'credit access'"
}
```

The anchors come from manual curation: the team reviews actual Phase 1 mappings, flags the misses, and writes anchors that would have produced the right mapping.

---

## Output Structure: Alignment First, Divergence Second

The dance map output organizes findings into three sections:

**Strong alignment.** Brand emphasizes a dimension AND audience indexes high on that dimension. These represent the strategic strengths to amplify.

**Misalignment.** Brand emphasizes a dimension but audience shows weak signal on it. These flag challenges to reconsider.

**Untapped opportunity.** Audience indexes high on a dimension the brand doesn't currently emphasize. These name stretch opportunities.

Each output card carries layer attribution so the strategist reads it with the appropriate confidence framing.

### Stretch angle line (opportunity cards only)

Each opportunity card carries a one-sentence stretch angle that translates the data gap into a pitch frame. Valid forms:

**Form 1 — Strategic implication:** "Lead with [territory] as a brand promise."
**Form 2 — Audience-truth-as-positioning hook:** "The audience is already moving toward [territory]; the brand can follow."

The opinion is explicit but grounded in the data point. Not pure brand advice ("run a TV campaign on Sunday football"). Pure data-to-strategy translation, kept to one sentence.

Worked examples:
- "Feeling helped rather than sold to" (Layer 2a, 63% TB) → "Lead with consultative service messaging at the customer-care moments."
- "Feeling like you got a genuinely good deal" (Layer 2a, 65% TB) → "Position financing as the bargain partner rather than as the credit line."
- "Knowing you will not face a difficult or embarrassing moment" (Layer 2a, 55% TB) → "Own the dignified financing territory more explicitly."

---

## Alignment Logic (Phase 1)

For Phase 1, alignment uses **top-N overlap** rather than vector similarity. The brand maps to a set of dimensions across layers. The audience has its own top dimensions across the same layers. The alignment list is the intersection. Each alignment point reads as "you both index high on X."

**Phase 2 addition:** composite resonance score (cosine similarity or weighted overlap).

---

## First-Pass Mockup Direction

Described in prose so CC can build directly against the actual site styling.

### Overall structure

- Outer container with subtle secondary-background surface, generous border-radius, ~1.25rem padding
- Header section at top: title bar "Joy Map · [Brand identifier] × [Audience identifier]" with brand input echo (in quotes) and audience filter echo below, separated from the body by a 0.5px border
- Three section panels stacked vertically: Strong Alignment, then Misalignment, then Untapped Opportunity
- Each section has a colored indicator dot + section title + count subscript + one-line description

### Section colors (subtle accents, not overpowering)

- Strong alignment: teal accent
- Misalignment: amber accent
- Untapped opportunity: purple accent

Cards stay neutral (primary background, 0.5px border). Section color appears as: a small dot next to the section header, the layer chip background tint inside cards, and the metric value text color.

### Finding card structure

- Title: the matched BJL item name or concept (~13px, weight 500)
- Layer chip in top-right corner: "Layer 1 · JI" / "Layer 2a · TB%" / "Layer 3 · Tag" — small pill, ~10px
- Metric value: prominent, ~24px, weight 500, in the section accent color. For JI items, integer (e.g., "79"). For top-box items, percentage (e.g., "65%"). For Layer 3, the rate (e.g., "22%") with a confidence band shown alongside.
- Brand emphasis line: "Brand: [text snippet in quotes]" — primary text color for label, secondary for the snippet
- Audience signal line: "Audience: [short context]" — same treatment
- Optional stretch angle line (opportunity cards only): one sentence, separated by a 0.5px dashed border-top, with a small arrow indicator

### Card spacing within a section

- Cards stack with ~8px gap
- 1-3 cards per section is typical for Phase 1 output

### Match title vs brand-frame title

For Phase 1, the card title is the **BJL item name** (data-led). The brand snippet sits in the supporting context line. This makes the data the spine and the brand language the evidence of fit. Alternative framing (brand-frame title with BJL item as evidence) is a Phase 2 consideration; flagged for review after the team uses Phase 1.

---

## Phase 1 Scope Summary

- Brand input: Waldo JSON paste-in plus free-text field
- Audience input: demographic dropdowns
- Workflows: 1 (Audience Joy Profile) and 3 (Dance Map)
- Mapping bridge: pure LLM with confidence scores, no calibration anchors
- Alignment logic: top-N overlap
- Output: structured card layout with three sections, alignment-first
- Layer protocol enforced: descent through Layer 1 → 2 → 3 → 4

## Phase 2 Scope Summary

- Brand input: add structured attribute form
- Audience input: add named cohort library
- Workflows: add 2 (Brand → Audience Discovery)
- Mapping bridge: add calibration anchors
- Alignment logic: add composite resonance score
- Output: radar chart overlay; classified opening types from named taxonomy
- Optional: brand-frame card titles instead of BJL-item titles

---

## Resolved Design Decisions (since v0.1)

**Confidence display granularity:** show numeric confidence only on Layer 3 cards where methodology uncertainty actually matters. Layer 1 / Layer 2 cards just carry the layer chip. Layer 3 cards carry the layer chip plus a small confidence indicator ("medium confidence" or precision-band label) alongside the metric.

---

## Open Questions for Implementation

These need a call during the build. Surface them in the PR description as you encounter them.

**1. UI placement.** Three options identified by CC:
- A. New top-level mode/route (like Intelligence Engine), with Joy Map workflows as sub-views inside it
- B. Fifth chip in the existing chat that pre-fills a structured form
- C. Sibling top-level route in the rail under "Workbench"

Recommendation: **Option A.** The Joy Map workflows belong together conceptually (both are brand-audience matching exercises), and grouping them under a single Joy Map mode preserves that. Option B falls short because the structured inputs and structured output don't fit the chat surface shape. Option C works but adds clutter at the top-level rail.

If A doesn't fit cleanly into the current UI shell, C is the second-best path.

**2. Phase 1 visual layout details.** Three sub-questions worth flagging in the PR:
- Section ordering: currently Strong Alignment → Misalignment → Untapped Opportunity. Confirm or change.
- Card density: 1-3 cards per section is the working assumption. Pressure-test against actual outputs.
- Stretch angle line scope: included in Phase 1 per this spec. Confirm or defer to Phase 2.

---

## Acceptance Test for Phase 1

A strategist should be able to:

1. Open the Joy Map mode in the workbench.
2. Select Dance Map workflow.
3. Paste a Wayfinder Financing-style brand text into the brand field: "We help families afford the home they're building. Flexible payment terms designed for your life. Prequalification gives you confidence before you walk into the store."
4. Set audience filters: Age 35-54, HH income $50K-$100K, with children, suburban.
5. Click Run.

Expected output:
- Three sections rendered (Strong Alignment, Misalignment, Untapped Opportunity)
- Each finding card grounded in a specific BJL data point with layer attribution
- Every Joy Index claim sourced to a 9-point scale joy_scale item. Zero JI computed from 3-point ordinals.
- Cards visually consistent with Brand Lookup / Audience Dive output formatting
- The layer descent protocol traceable in the actual findings (Layer 1 items appearing before Layer 2 items within each section)
- Opportunity cards include a stretch angle sentence

The brand text and audience filters in this test are illustrative. Real-world tests will use actual prospect Waldo JSON.

---

## Addendum, 2026-08-05 — the pane clarifying loop, and one piece it left open

The Joy Map connections pane could ask a clarifying question but rendered no way
to answer it. Every response that was not a finding was a terminal statement, so
the only move left to a strategist was to retype the same brand into the same
box — "Hotwire Communications" appears eight times in one day in
`bjl_front_door_log`, which is the behavioural signature of the dead end.
`needs_clarification` was 46% of that surface's front-door traffic and the only
shape logged after July 29.

Two things were structurally missing rather than merely unwired:

1. **The front door ignored the context it documented.** `session_history` was
   accepted and dropped, so a re-dispatched answer ("the budget travel
   category") would have been classified as a brand new standalone query and
   drawn the same clarifying question again. Prior turns are now threaded into
   both Haiku stages. Absent history is a strict no-op by construction, which is
   what keeps the connections-beta pane and the investigator — neither of which
   passes history — provably unchanged. `bin/test_front_door_nonregression.js`
   holds that property.

2. **`no_data` and `ambiguous` were collapsed into one shape.** "Theme parks"
   (in the corpus, query too vague) and "Hostelling International" (query
   perfectly clear, brand not fielded) both arrived as `needs_clarification`,
   and a surface cannot offer the right next move without telling them apart.
   Asking someone to rephrase a brand name that does not exist is a loop with
   no exit. The brief now carries `escalated_from`, additively; the shape is
   unchanged so existing consumers are unaffected.

### The open piece: AudienceMapResults as a real destination

When the named brand is genuinely not fielded, the honest next move is to build
from the audience described rather than the brand named. That route is now wired
— the chip calls `bjl-joy-map-audience-parse` and renders what comes back — but
**what it renders is the parser's raw output behind an explicit
"raw audience read — provisional, not a finished map" label**, on a hatched,
monospace panel that deliberately does not inherit finished-surface styling.

This is the same rule as `machine_draft` in the bulletin register: an ungroomed
machine output must never look authored, because if it does it gets quoted. The
label is load-bearing, not decoration. Do not restyle that panel to match the
sweep's cards without first doing the work below.

`AudienceMapResults` exists in `index.html` and has had no entry point since the
pane was restructured. Designing it as a real destination is its own piece, and
it is not a render-time cleanup:

- Its rows are `{ item_name, cohort_ji, corpus_ji, cohort_n }` — a different
  payload from the focal/other pairs the connections sweep renders. It needs its
  own builder written against what the parser actually emits, not an adaptation
  of the sweep's.
- The cohort needs the same eligibility and thinness treatment the sweep gives
  focals, or it will render sixteen confident rows off a cohort of nine people.
- It needs a stated relationship to the Dance Map, which shares the audience
  side and is also unmounted.

Until that lands, the provisional label is the whole guarantee.
