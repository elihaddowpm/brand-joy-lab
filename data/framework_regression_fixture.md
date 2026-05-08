# Framework Tagger — Regression Test Fixture

These 16 verbatims were sampled and calibrated jointly by Eli and the lab during a manual review session. The "expected" tag profiles below represent the calibrated reads that should emerge from a properly-prompted tagger. Use these as regression tests for `bin/framework_tagger.py`.

## How to interpret the fixtures

Each verbatim has three categories of expectation:

- **must_include** — tags that MUST appear (failure if missing). These have unambiguous textual support.
- **may_include** — tags that are defensible alternatives or secondary reads (no failure either way). Multi-tag flexibility lives here.
- **must_not_include** — tags that would indicate a calibration failure (failure if present). These represent the anti-patterns we're explicitly trying to avoid (category-driven inference, surface-word matching, Job-vs-Tension confusion).

A tagger run passes if all 16 verbatims meet `must_include` ⊆ output ⊆ (must_include ∪ may_include) and `must_not_include` ∩ output = ∅.

## The 16 fixtures

```yaml
fixtures:

  # ============================================================
  # JOY MODES SAMPLING (5 verbatims)
  # ============================================================

  - id: 35116
    excerpt: "Actually have been there in Cleveland, Ohio. It was interesting but I like the science museum right next door way more interesting."
    notes: "Comparative preference statement; thin emotional content"
    expected:
      joy_modes:
        must_include: []
        may_include: ["awe"]  # the repeated 'interesting' has faint curiosity-as-wonder signal
        must_not_include: ["aesthetic"]  # category-driven; no aesthetic language in the words
      tensions:
        must_include: []
        may_include: []
        must_not_include: []
      functional_jobs:
        must_include: []
        may_include: []
        must_not_include: []
      occasions:
        must_include: []
        may_include: []
        must_not_include: []

  - id: 38979
    excerpt: "I would like to see all of the historic parts of music history! I enjoy music in all it's forms"
    notes: "Anticipated discovery + appreciation of music; multi-mode"
    expected:
      joy_modes:
        must_include: ["hedonic"]  # 'I enjoy music' is direct sensory enjoyment
        may_include: ["aesthetic", "sentimental", "awe", "inspirational"]  # appreciation across forms / heritage feel / curiosity / forward-action energy
        must_not_include: []
      tensions:
        must_include: []
        may_include: []
        must_not_include: []
      functional_jobs:
        must_include: []
        may_include: ["learn_grow"]
        must_not_include: []
      occasions:
        must_include: []
        may_include: ["anticipation"]  # 'I would like to see' is pre-experience phase
        must_not_include: []

  - id: 47599
    excerpt: "Purchasing from a legacy brand is similar to picking something dependable, trustworthy, and long-lasting."
    notes: "No sensory or indulgent language; the dominant register is security/peace"
    expected:
      joy_modes:
        must_include: ["tranquil"]  # 'dependable, trustworthy' is peace/calm/worry-free
        may_include: ["sentimental"]  # legacy = heritage adjacency
        must_not_include: ["hedonic"]  # nothing sensory or indulgent in the words
      tensions:
        must_include: []
        may_include: ["challenger_vs_legacy"]  # the question prompts this framing
        must_not_include: []
      functional_jobs:
        must_include: []
        may_include: ["provide_security"]
        must_not_include: []
      occasions:
        must_include: []
        may_include: []
        must_not_include: []

  - id: 21779
    excerpt: "I'd like to go back to Alaska and do some more things that we didn't get time to do when we were last there."
    notes: "Forward-looking anticipation + personal history with the place; do NOT infer freedom from vacation context"
    expected:
      joy_modes:
        must_include: ["inspirational"]  # 'I'd like to go back' is energized toward action
        may_include: ["sentimental"]  # personal connection to a prior trip
        must_not_include: ["freedom"]  # NOT in the words; would be category-context inference
      tensions:
        must_include: []
        may_include: ["present_vs_future"]  # 'do some more things we didn't get time to do' frames a now-vs-future gap
        must_not_include: []
      functional_jobs:
        must_include: []
        may_include: ["create_memory"]  # 'do some more things' = make experiences worth remembering
        must_not_include: []
      occasions:
        must_include: []
        may_include: ["vacation", "memory", "anticipation"]  # 'I'd like to go back' is pre-experience phase
        must_not_include: []

  - id: 61111
    excerpt: "Feeling energized, cooking colorful meals, and sharing tasty food with people I love."
    notes: "Dense multi-mode verbatim; THE canonical positive example of multi-tag working correctly"
    expected:
      joy_modes:
        must_include: ["physical", "aesthetic", "hedonic", "relational"]  # energized / colorful / tasty / people I love — all four directly in the words
        may_include: []
        must_not_include: []
      tensions:
        must_include: []
        may_include: []
        must_not_include: []
      functional_jobs:
        must_include: []
        may_include: ["nourish_others", "share_experience"]
        must_not_include: []
      occasions:
        must_include: []
        may_include: ["mealtime"]
        must_not_include: []

  # ============================================================
  # TENSIONS SAMPLING (5 verbatims)
  # ============================================================

  - id: 63046
    excerpt: "I feel banks are greedy. Things always seem to help the person with the most money not the people who need real help"
    notes: "Class resentment / institutional service complaint; primary use case for served_vs_overlooked"
    expected:
      joy_modes:
        must_include: []
        may_include: []
        must_not_include: []
      tensions:
        must_include: ["served_vs_overlooked"]  # 'help the person with the most money' vs 'people who need real help' is the textual polarity
        may_include: []
        must_not_include: ["luxury_vs_value"]  # category-driven; respondent is NOT navigating personal premium-vs-value
      functional_jobs:
        must_include: []
        may_include: []
        must_not_include: []
      occasions:
        must_include: []
        may_include: []
        must_not_include: []

  - id: 63127
    excerpt: "It was. Red wine and very tasty and delicious and the price was just right for the quality of the wine"
    notes: "Clean explicit signals across joy_modes and tensions; positive case"
    expected:
      joy_modes:
        must_include: ["hedonic"]  # 'tasty and delicious' is direct
        may_include: ["aesthetic"]
        must_not_include: []
      tensions:
        must_include: ["luxury_vs_value"]  # 'price was just right for the quality' is the explicit value calculation
        may_include: []
        must_not_include: []
      functional_jobs:
        must_include: []
        may_include: []
        must_not_include: ["reward_self"]  # current tagger applied this; it's not in the words
      occasions:
        must_include: []
        may_include: []
        must_not_include: []

  - id: 63474
    excerpt: "It would be great if my credit union offered higher interest rates on savings accounts."
    notes: "Expressed-gap principle; unmet want = tension territory, NOT job territory"
    expected:
      joy_modes:
        must_include: []
        may_include: []
        must_not_include: []
      tensions:
        must_include: ["present_vs_future"]  # expressed gap between desired rate and current reality (per Eli's expressed-gap principle)
        may_include: ["served_vs_overlooked"]
        must_not_include: []
      functional_jobs:
        must_include: []
        may_include: []
        must_not_include: ["plan_future"]  # Job-vs-Tension confusion; respondent is naming a gap, not actively planning
      occasions:
        must_include: []
        may_include: []
        must_not_include: []

  - id: 63229
    excerpt: "I would be more interested in drinking wine more often if it offered clearer health benefits in moderation and if there were more guidance on choosing the right wine for different meals and occasions. Better value and simpler recommendations would also make it feel more approachable and enjoyable."
    notes: "Multiple explicit tension signals; respondent essentially hands over the brief"
    expected:
      joy_modes:
        must_include: ["hedonic"]  # 'more enjoyable' is explicit
        may_include: ["achievement"]  # 'guidance on choosing' implies mastery aspiration
        must_not_include: []
      tensions:
        must_include: ["moderation_vs_indulgence", "luxury_vs_value"]  # 'in moderation' AND 'better value' are both explicit
        may_include: ["discovery_vs_comfort", "served_vs_overlooked"]  # wanting newness with comfort of clarity / unmet-want framing toward marketers
        must_not_include: []
      functional_jobs:
        must_include: []
        may_include: ["learn_grow"]
        must_not_include: []
      occasions:
        must_include: []
        may_include: ["everyday"]  # 'drinking wine more often' frames everyday/habitual cadence
        must_not_include: []

  - id: 63600
    excerpt: "Help me understand, there are so many that don't speak English very well, so when I call I get frustrated because I can't understand the person."
    notes: "Service interaction frustration; primary use case for the new 'service' occasion AND served_vs_overlooked"
    expected:
      joy_modes:
        must_include: []
        may_include: []
        must_not_include: []
      tensions:
        must_include: ["served_vs_overlooked"]  # respondent feels overlooked by their bank's service quality
        may_include: []
        must_not_include: ["individual_vs_communal"]  # current tag is category-driven
      functional_jobs:
        must_include: []
        may_include: ["relieve_anxiety"]
        must_not_include: []
      occasions:
        must_include: ["service"]  # 'when I call' = customer service interaction
        may_include: []
        must_not_include: ["work"]  # current tag confuses 'phone call' with 'workplace phone call'

  # ============================================================
  # FUNCTIONAL JOBS SAMPLING (5 verbatims; 63474 already covered above)
  # ============================================================

  - id: 63527
    excerpt: "Something that I need is important is connecting to the bank itself. Chase is a great bank"
    notes: "Thin/ambiguous verbatim; surface word 'connecting' was misread as belonging"
    expected:
      joy_modes:
        must_include: []
        may_include: []
        must_not_include: []
      tensions:
        must_include: []
        may_include: []
        must_not_include: []
      functional_jobs:
        must_include: []
        may_include: []
        must_not_include: ["build_belonging"]  # 'connecting' here means transactional access, NOT group-identity belonging
      occasions:
        must_include: []
        may_include: []
        must_not_include: []

  - id: 62935
    excerpt: "Not really I'm pretty well open to any kind although my preference is red and I do enjoy wine more when sharing with others"
    notes: "Clean positive case; multi-tag working correctly when signals are explicit"
    expected:
      joy_modes:
        must_include: ["relational", "hedonic"]  # 'with others' / 'enjoy wine more'
        may_include: []
        must_not_include: []
      tensions:
        must_include: []
        may_include: []
        must_not_include: []
      functional_jobs:
        must_include: ["share_experience"]  # 'sharing with others' is direct
        may_include: []
        must_not_include: ["build_belonging"]  # transient co-experiencing, not durable group identity
      occasions:
        must_include: []
        may_include: ["gathering"]
        must_not_include: []

  - id: 63745
    excerpt: "If it were marketed in a way that easily let you know what to expect for the taste. (Besides dry, etc)"
    notes: "Job-vs-Tension confusion; respondent expresses unmet want, NOT a job-to-be-done"
    expected:
      joy_modes:
        must_include: []
        may_include: []
        must_not_include: ["hedonic"]  # 'taste' appears but NOT as sensory pleasure expression
      tensions:
        must_include: []
        may_include: ["discovery_vs_comfort", "served_vs_overlooked"]  # the unmet-want is the tension
        must_not_include: []
      functional_jobs:
        must_include: []
        may_include: []
        must_not_include: ["learn_grow", "signal_identity"]  # both wrong; respondent isn't hiring wine to learn or signal
      occasions:
        must_include: []
        may_include: ["shopping"]
        must_not_include: []

  - id: 62934
    excerpt: "I mostly would like higher interest rates on my CD. But I do understand it may not be possible there have been times where they've increased it by a quarter of eighty percent for me sometimes half."
    notes: "TEXTBOOK aspiration_vs_acceptance — both poles named in adjacent sentences"
    expected:
      joy_modes:
        must_include: []
        may_include: []
        must_not_include: ["hedonic"]  # no sensory or indulgent language in the words
      tensions:
        must_include: ["aspiration_vs_acceptance"]  # 'I would like' (aspiration) AND 'I understand it may not be possible' (acceptance) explicit
        may_include: ["served_vs_overlooked", "present_vs_future"]
        must_not_include: []
      functional_jobs:
        must_include: []
        may_include: []
        must_not_include: ["reward_self"]  # nothing about indulgence or treat-yourself in the words
      occasions:
        must_include: []
        may_include: []
        must_not_include: []

  # ============================================================
  # OCCASIONS SAMPLING (3 verbatims; 63600 already covered above)
  # ============================================================

  - id: 63596
    excerpt: "Committing to allowing the customer to see their money reflected fast and in real time."
    notes: "Service-feature unmet want; tension-territory more than occasion-rich"
    expected:
      joy_modes:
        must_include: []
        may_include: []
        must_not_include: ["tranquil"]  # 'real-time visibility' inferred to reduce anxiety, not in the words
      tensions:
        must_include: []
        may_include: ["served_vs_overlooked", "present_vs_future"]
        must_not_include: []
      functional_jobs:
        must_include: []
        may_include: ["provide_security"]
        must_not_include: []
      occasions:
        must_include: []
        may_include: ["everyday", "service"]
        must_not_include: []

  - id: 63318
    excerpt: "I enjoyed a very good Reisling with my wife and friends during a small gathering in my home."
    notes: "Clean positive case; explicit signals across multiple frameworks"
    expected:
      joy_modes:
        must_include: ["hedonic", "relational"]
        may_include: []
        must_not_include: []
      tensions:
        must_include: []
        may_include: []
        must_not_include: []
      functional_jobs:
        must_include: ["share_experience"]
        may_include: ["build_belonging"]
        must_not_include: []
      occasions:
        must_include: ["gathering"]  # explicit
        may_include: ["hosting"]  # 'in my home' with friends
        must_not_include: ["mealtime"]  # NOT explicit; would be category-context inference (wine = meals)
```

## Pass criteria

The tagger passes regression if:

- All 16 fixtures have `must_include` ⊆ output for every framework
- All 16 fixtures have output ⊆ (`must_include` ∪ `may_include`) for every framework
- All 16 fixtures have `must_not_include` ∩ output = ∅ for every framework

Failure cases that should immediately invalidate the prompt:
- Verbatim 35116 tagged `aesthetic` (category-driven inference)
- Verbatim 21779 tagged `freedom` (vacation-context inference)
- Verbatim 63474 tagged `plan_future` as a job (Job-vs-Tension confusion)
- Verbatim 63600 tagged `work` as occasion (surface-word confusion)
- Verbatim 63318 tagged `mealtime` (category-context inference)

If any of those five failures show up in the regression run, the prompt needs adjustment before we trust it on the full 63K backfill.
