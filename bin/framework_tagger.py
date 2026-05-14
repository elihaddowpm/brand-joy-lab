#!/usr/bin/env python3
"""
framework_tagger.py — deterministic Haiku tagger for BJL verbatims.

Single canonical module that assigns four-framework tags
(joy_modes, tensions, functional_jobs, occasions) to a verbatim
consumer response. Used in two places:

  - bin/backfill_frameworks.py — one-off backfill of the existing
    ~63K verbatims that lack canonical tags.
  - bin/ingest_wave.py phase 5 — automatic per-wave tagging for new
    monthly waves, called inline at the end of ingestion.

Same module, same prompt, two invocations. Build once, deploy twice.

## Why deterministic and not agentic

The framework taxonomies are stable and the calibration rules in the
prompt are mechanical pattern-matching against textual signals. There
is no autonomous decision-making, no retry-with-different-strategy
logic, no tool use. Just: input verbatim, output tags, store result.

This module is intentionally NOT an agent. It is a typed function with
retry on transient errors and exponential backoff. Trustworthy and
debuggable. The agentic version would be harder to validate and could
drift over time.

## Public API

  load_frameworks_from_db(conn) -> dict
      Reads bjl_joy_modes / bjl_tensions / bjl_functional_jobs /
      bjl_occasions and returns a dict the prompt builder consumes.

  build_system_prompt(frameworks) -> str
      Returns the full system prompt with framework definitions
      injected into placeholder sections.

  tag_verbatim_sync(client, response_text, question_text, system_prompt)
      Sync convenience wrapper used by smoke tests and ad-hoc one-offs.

  async tag_verbatim(client, response_text, question_text, system_prompt)
      One Haiku call. Parses JSON. Retries on 429 / 529 / transient up
      to 3x with exponential backoff. Returns dict or None on
      irrecoverable failure.

  async tag_verbatims_batch(verbatims, frameworks, concurrency=8, ...)
      Asyncio-based parallel batch with a semaphore. Returns
      (results, stats). Cost + time tracked per batch.

## Cost / latency expectations

Haiku 4.5 pricing as of 2026-05: $1/M input tokens, $5/M output tokens.
A typical verbatim tag call is ~3K input tokens (mostly the prompt) +
~80 output tokens. ≈ $0.0034 + $0.0004 = $0.0038 per call. The full
~62K-verbatim backfill should land between $5 and $15 once retries
and prompt-cache hits factor in.

Wall time: at concurrency=8 with ~1-2s per call, expect ~50-100 verbatims
per minute. The full backfill is 45-90 minutes.

## Required env

  ANTHROPIC_API_KEY  — Anthropic API key
  DATABASE_URL       — Postgres connection string for Supabase. Use the
                       Supavisor-pooler URL pattern from the Phase 3+4
                       commit message: postgres://postgres.PROJECT_REF
                       :PASSWORD@aws-0-us-east-1.pooler.supabase.com:
                       6543/postgres
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Iterable

# These imports are deferred-friendly: the test suite imports the module
# without the SDKs installed for offline tests. Heavy deps live below.
try:
    from anthropic import Anthropic, AsyncAnthropic
    from anthropic import APIError, APIStatusError, RateLimitError, APIConnectionError
    HAS_ANTHROPIC = True
except ImportError:  # pragma: no cover — only hit in offline test env
    Anthropic = AsyncAnthropic = None  # type: ignore
    APIError = APIStatusError = RateLimitError = APIConnectionError = Exception  # type: ignore
    HAS_ANTHROPIC = False


HAIKU_MODEL = 'claude-haiku-4-5-20251001'
DEFAULT_MAX_TOKENS = 1024
DEFAULT_CONCURRENCY = 8
RETRY_DELAYS_SEC = (1, 4, 16)  # exponential backoff for 3 retries
INPUT_PRICE_PER_M = 1.0   # USD per million input tokens
OUTPUT_PRICE_PER_M = 5.0  # USD per million output tokens

log = logging.getLogger('framework_tagger')


# ---------------------------------------------------------------------------
# Framework loading (DB → dict)
# ---------------------------------------------------------------------------

# Maps logical framework name → (table, key column, definition column).
# All four tables share `display_name` for the human-readable name and
# differ only in the key column and the definition column. The bjl_joy_modes
# table also has purchase_mapping / benchmark_finding / sort_order — we
# only consume short_definition.
FRAMEWORK_TABLES = {
    'joy_modes':       ('bjl_joy_modes',       'mode_key',     'short_definition'),
    'tensions':        ('bjl_tensions',        'tension_key',  'description'),
    'functional_jobs': ('bjl_functional_jobs', 'job_key',      'description'),
    'occasions':       ('bjl_occasions',       'occasion_key', 'description'),
}


def load_frameworks_from_db(conn) -> dict:
    """Reads the four framework tables and returns a normalized dict.

    Returns:
        {
          'joy_modes': [
            {'key': 'hedonic', 'display_name': 'Hedonic', 'definition': '...'},
            ...
          ],
          'tensions':  [...],
          'functional_jobs': [...],
          'occasions': [...]
        }

    The sort within each list is alphabetical by key for stability —
    the prompt content (and therefore prompt-caching keys) shouldn't
    depend on row insertion order.
    """
    out = {}
    with conn.cursor() as cur:
        for fwk, (table, key_col, def_col) in FRAMEWORK_TABLES.items():
            cur.execute(
                f'SELECT {key_col}, display_name, {def_col} '
                f'FROM {table} ORDER BY {key_col}'
            )
            rows = cur.fetchall()
            out[fwk] = [
                {'key': r[0], 'display_name': r[1], 'definition': r[2] or ''}
                for r in rows
            ]
    return out


def canonical_keys(frameworks: dict) -> dict[str, set[str]]:
    """Returns {framework_name: set_of_valid_keys} for output filtering."""
    return {fwk: {item['key'] for item in entries}
            for fwk, entries in frameworks.items()}


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

# The static parts of the prompt — calibration rules + worked examples — are
# defined as module constants so they're easy to inspect and version-control.
# Framework definitions get spliced in at runtime so the prompt always
# reflects current taxonomy state without a code redeploy.

CALIBRATION_RULES = """\
# CALIBRATION RULES

These rules are absolute. Apply them to every tagging decision.

## Rule 1: Multi-tag is the default
Apply EVERY tag from each framework that has direct textual support in the verbatim. A single verbatim often expresses two, three, or four joy modes simultaneously, plus multiple tensions, jobs, and occasions. Do NOT pick a single dominant signal. Capture all word-grounded signals.

## Rule 2: Word-grounded, not context-inferred
Tags must be supported by the actual words and phrases in the verbatim. The question topic, the response category, and the respondent's demographics CANNOT drive a tag.

WRONG: A respondent talks about the Rock and Roll Hall of Fame, so tag aesthetic because museums are aesthetic categories.

RIGHT: Apply aesthetic only if the respondent uses words about beauty, design, visual appreciation, or art.

## Rule 3: Expressed gaps and conditional joy count as word-grounded signal
"I want X and don't have it" is real textual evidence even when not framed as an explicit polarity. The respondent doesn't have to say "I'm torn between X and Y" to express a tension. Naming the gap between what they want and what exists is enough.

EXAMPLE: "It would be great if my credit union offered higher interest rates" expresses a present_vs_future tension because the respondent is naming the gap between current rates and desired rates, even though they don't say "I'm torn between..."

When a respondent describes what would bring them joy under specific conditions ("if X were true, I would feel Y", "I would be more interested if it offered Z", "marketing should make it more enjoyable"), the joy modes named in the conditional ARE valid tags. Conditional joy is still word-grounded signal. The respondent is naming the joy modes in the verbatim itself; they should be tagged.

EXAMPLE: "I would be more interested in drinking wine more often if it offered clearer health benefits in moderation. Better value and simpler recommendations would make it feel more approachable and enjoyable." → tag hedonic (the conditional names "enjoyable") AND moderation_vs_indulgence (the explicit "in moderation" framing).

## Rule 4: Some verbatims have zero tags
Thin, ambiguous, fragmentary, or non-emotional verbatims should NOT be force-tagged. Better to return empty arrays than wrong tags.

Specifically, these verbatim shapes get zero tags across all four frameworks unless paired with descriptive content that grounds a tag:
- Bare admiration: "I love it." "It's great." "Best ever." "So good."
- Generic preference: "I prefer X." "I like Y better than Z."
- Bare descriptor: "It's nice." "It's cool." "Pretty good."
- Pure factual statements: "I bought one last week."
- Logistical statements: "It comes in three sizes."
- Pure preference comparisons without emotional content

EXCEPTION: When bare admiration appears alongside descriptive content that grounds a tag, apply only the grounded tags.
- "I love it because it tastes amazing" -> joy_modes: [hedonic] (taste = sensory grounding)
- "I love it" alone -> joy_modes: [] (no grounding)
- "It's the best because it brings my whole family together" -> joy_modes: [relational]
- "It's the best" alone -> joy_modes: []

Default to empty arrays when in doubt. A wrong tag is worse than a missing tag.

## Rule 4 hierarchy: when Rule 1 wins over Rule 4

Rule 4 applies when the verbatim is GENUINELY thin — bare admiration, generic preference, logistical statement, factual statement, with no other content.

When the verbatim contains descriptive content alongside any opinion or framing, Rule 1 (multi-tag default) WINS over Rule 4. Apply EVERY grounded tag.

DESCRIPTIVE CONTENT signals include:
- Action verbs ("watching", "playing", "sharing", "discussing", "experiencing", "going")
- Specific objects, places, or activities ("videos", "honeymoon", "menu", "decoration", "outdoor activities")
- Named relationships ("wife", "friends", "grandchildren", "family")
- Sensory words ("tasty", "loud", "snazzy", "colorful", "relaxing")
- Specific feeling states ("excitement", "feelings we enjoyed", "fun they were having")

WORKED EXAMPLES (Rule 1 wins, multi-tag is correct even though no single phrase is over-the-top):

RIGHT: "Watching videos, sharing pictures on social media. Playing games."
Tags: joy_modes: [playful], jobs: [immerse_in_story, share_experience], occasions: [everyday]
Reasoning: Three named activities with descriptive content. Multi-tag.

RIGHT: "My wife and I discuss places we haven't visited and would like to visit"
Tags: joy_modes: [relational, inspirational], jobs: [plan_future], occasions: [anticipation, vacation]
Reasoning: "wife" -> relational, "would like to visit" -> inspirational + anticipation, "discuss... haven't visited" -> plan_future.

RIGHT: "Going to Hawaii and experiencing the feelings and excitement that we enjoyed on our honeymoon"
Tags: joy_modes: [sentimental, inspirational, relational], jobs: [create_memory], occasions: [vacation, anticipation, memory]
Reasoning: "honeymoon" -> relational + sentimental, "excitement" -> inspirational, "going to Hawaii" -> vacation + anticipation, "experiencing the feelings" -> create_memory.

RIGHT: "Spending time with grandchildren at Disney World, watching the fun they were having"
Tags: joy_modes: [relational, playful], jobs: [build_belonging, demonstrate_care], occasions: [vacation]
Reasoning: "grandchildren" -> relational + build_belonging + demonstrate_care, "fun they were having" -> playful.

RIGHT: "A vacation to West Palm Beach, Florida would likely involve a mix of relaxation, outdoor activities, and cultural experiences"
Tags: joy_modes: [tranquil, physical], jobs: [relax_recover], occasions: [vacation]
Reasoning: Even inside a "would likely involve" hypothetical frame, the descriptive nouns inside it count as word-grounded content. "relaxation" -> tranquil + relax_recover. "outdoor activities" -> physical. "vacation" -> vacation. The "would involve" framing is hypothetical only at the outer level — the descriptive nouns inside remain concrete signals. Apply tags grounded in those nouns.

RIGHT-pattern: when a verbatim describes what a category typically involves with named activities or feeling-words inside the description ("a vacation involves X, Y, Z" / "this kind of trip means X" / "you can expect Y" + naming specific activities), the named activities ARE the word-grounded content. Tag them. Do NOT fall back to empty just because the surrounding clause is hypothetical.

WRONG (Rule 4 over-applied, descriptive content was present but tagger fell back to empty):
"Watching videos, sharing pictures on social media. Playing games." -> all empty
Lesson: Three named activities is descriptive content. Multi-tag.

## Rule 5: Job vs Tension distinction
- A respondent describing what they want a product or experience to DO for them = functional_job
- A respondent describing the gap between desired state and current reality = tension

The same verbatim CAN have both, tagged via different frameworks. But do NOT confuse them. Unmet wants are tensions, not jobs.

EXAMPLE: "I love sharing wine with friends" -> share_experience (job: respondent is hiring wine to share)
EXAMPLE: "I wish my bank offered higher rates" -> present_vs_future (tension: gap between want and reality), NOT plan_future (job)

## Rule 6: Negative valence overrides surface-word tagging
When a verbatim's dominant valence is negative (disappointment, frustration, complaint, regret, anti-joy), DO NOT apply joy modes based on positive surface words inside the verbatim. The respondent is not expressing joy.

Negative valence signals include:
- "disappointed" / "disappointing"
- "not worth it" / "wasn't worth"
- "less enjoyable" / "not as good"
- "let down"
- "regret"
- "used to" + past-tense positive (now negative)
- Direct complaint framing
- Negation of positive ("not great," "doesn't bring me joy anymore")

When dominant valence is negative, joy_modes should be empty even when individual positive words appear.

WORKED EXAMPLES:
RIGHT: "Cocoa Pebbles used to bring me joy as a kid but now they're just sugary and disappointing" -> joy_modes: [] (negative valence dominates, even though "joy" appears)
RIGHT: "The food was good but it wasn't worth the price and I left disappointed" -> joy_modes: [] (negative valence dominates "good food")
RIGHT: "It was less enjoyable than I remembered" -> joy_modes: []
RIGHT: "Not worth it" -> joy_modes: []

WRONG: Tagging hedonic because "food" or "good" appears in a disappointment verbatim.

Note: tensions, jobs, and occasions can still apply to negative-valence verbatims if their respective signals are present. The override applies only to joy_modes.

## Rule 7: Read semantically through obvious typos
When a verbatim contains an obvious typo or malformed word, read semantically based on surrounding context. Do not tag based on the literal incorrect word.

WORKED EXAMPLES:
"The medical atmosphere of Medieval Times was great" -> read as "medieval atmosphere" (Medieval Times is a themed dinner venue). Tag based on themed entertainment context, not medical.
"I had a fun time at the resturant" -> read as "restaurant"
"Going to the beech every summer" -> read as "beach"
"My cat brings me so much joye" -> read as "joy"

If the typo is genuinely ambiguous and surrounding context cannot resolve it, fall back to zero-tagging rather than guessing wrong.

## Rule 8: PRECISION OVER RECALL — when in doubt, do not tag

This is the most important meta-rule. It overrides Rule 1 (multi-tag default) when the evidence for a tag is hedge-y, uncertain, or implied-rather-than-stated.

A tag should be applied ONLY when its word-grounded evidence is unambiguous. If you find yourself reasoning "this could be X" or "X is sort of implied" or "the respondent might mean X" — DO NOT TAG X. Skip it.

Erroneous tags are worse than missing tags. Researchers querying the data trust that when a tag is present, it actually fits. False positives erode that trust faster than false negatives. We optimize for HIGH PRECISION even at the cost of recall.

CONCRETE APPLICATIONS:
- If a joy mode is plausibly inferable but the words for it aren't in the verbatim, do NOT tag it.
- If a tension's both-pulls criterion is iffy, do NOT tag it.
- If an occasion is contextually adjacent but not named, do NOT tag it.
- If a job is one of three plausible reads, do NOT tag any until you find the unambiguous one.
- When the verbatim has a clear central tag PLUS some hedge-y peripheral tags, emit ONLY the clear central tag.

When in doubt, under-tag. The full output `{joy_modes: [], tensions: [], functional_jobs: [], occasions: []}` is better than a wrongly-applied tag.

ANTI-PATTERN: emitting 5+ tags across the four frameworks for a verbatim with three or four words. Thin verbatims should produce thin output.

## Rule 9: Temporal and conditional language is grammar, not signal

Hypothetical, conditional, frequency-based, and post-experience temporal language do NOT trigger their lexically-similar tags by themselves. The verbatim must express the actual phenomenon, not merely gesture at it through grammar.

The principle: temporal language describes WHEN something is being discussed. Tags describe WHAT phenomenon the verbatim expresses. Don't confuse the two.

### Hypothetical / conditional framings ("would," "if," "could")

These describe hypotheses about categories, not actual phenomena.

WRONG: "I would expect a hotel to feel relaxing" -> anticipation (this is hypothetical category framing)
WRONG: "I would feel relaxed at the spa" -> tranquil (hypothetical, not expressed feeling)
WRONG: "If I went on vacation, I'd be happy" -> anticipation (counterfactual, not planned event)

RIGHT: "Looking forward to my Hawaii trip in March" -> anticipation (specific planned event + forward emotion)
RIGHT: "I'm so relaxed when I'm at my cabin" -> tranquil (expressed actual state)

### Future-tense without commitment

Loose future-tense and uncertain framings should not trigger anticipation.

WRONG: "I'll probably do that someday" -> anticipation (loose future, no commitment)
WRONG: "I might go to a concert" -> anticipation (uncertainty, not planning)

RIGHT: "I'm planning to take my daughter to Disney in June" -> anticipation (specific event + commitment)

### Frequency / habit mentions ("every," "always," "usually")

Frequency mentions describe regularity, not necessarily the everyday joy mode.

WRONG: "I watch movies every weekend" -> everyday (frequency description only)
WRONG: "I always buy that brand" -> everyday (preference, not joy of ordinary moments)

The everyday occasion requires the verbatim to express the JOY of routine, ordinary, or quotidian moments — not merely mention that something happens frequently.

RIGHT: "There's something special about my morning coffee routine, just being still" -> everyday (expressed joy of ordinary)
RIGHT: "I love the small daily moments with my dog before work" -> everyday (joy in the routine itself)

### Post-experience reflection ("after," "later," "afterwards")

Sequential mentions of a post-purchase moment do not automatically warrant the post_purchase tag.

WRONG: "After I bought it, I was happy" -> post_purchase (sequential, not focally post-purchase)
WRONG: "I bought it and then enjoyed it" -> post_purchase (purchase moment is the focus, not after)

The post_purchase occasion requires the verbatim's emotional weight to sit squarely AFTER the purchase, with sustained or recurring satisfaction tied to ownership.

RIGHT: "Every time I see it on the shelf, I'm proud I bought it" -> post_purchase (focal sustained ownership emotion)
RIGHT: "I keep noticing how much I enjoy using it months later" -> post_purchase (sustained post-purchase joy)

### Mixed feelings / ambivalence ("but," "however")

Generic ambivalence does not trigger aspiration_vs_acceptance.

WRONG: "Horrible but great" -> aspiration_vs_acceptance (mixed feelings, no aspiration framing)
WRONG: "Stressful but worth it" -> aspiration_vs_acceptance (ambivalence, not aspiration tension)

The aspiration_vs_acceptance tension specifically requires an expressed gap between aspiring/wanting/dreaming and accepting/settling/making-do.

RIGHT: "I want the premium model but I'm settling for what I can afford" -> aspiration_vs_acceptance (explicit aspiration + acceptance)
RIGHT: "I dream of a bigger house but I've made peace with this one" -> aspiration_vs_acceptance (dream vs. acceptance)

### Present + future mentions without tension

Mentioning both timeframes does not equal present_vs_future tension.

WRONG: "Saving up for my 2026 vacation" -> present_vs_future (no present pull expressed)
WRONG: "Planning my future career" -> present_vs_future (only future mention)
WRONG: "Looking forward to next year while enjoying now" -> present_vs_future (sequential, no pull)

The present_vs_future tension requires an explicit dual PULL between a present-state desire/value AND a future-state desire/value, with the respondent expressing the gap or trade-off between them.

RIGHT: "Part of me wants to save for retirement, part wants to enjoy life now" -> present_vs_future (explicit dual pull)
RIGHT: "I should be planning ahead but I keep living for today" -> present_vs_future (gap between should and is)
RIGHT: "Caught between investing in tomorrow and not missing out today" -> present_vs_future (named tension)

### Inspirational vs awe boundary tightening

Inspirational was over-firing in v6 and pulled cases that belonged to awe. The discrimination:

- **Inspirational** -> energized toward a specific action or behavior change. The verbatim expresses being moved to DO something.
- **Awe** -> wonder or amazement at something larger than self. The verbatim expresses being struck by scale, beauty, history, or grandeur.

WRONG: "Visiting historical sites" -> inspirational by default (history alone is not inspirational)

RIGHT: "Visiting historical sites makes me want to learn more about my heritage" -> inspirational (action-oriented)
RIGHT: "Standing in those ancient ruins, just feeling small in the best way" -> awe (scale + wonder)

If a verbatim expresses both, both tags can apply. If it only expresses one, only that one applies.
"""

WORKED_EXAMPLES = """\
# WORKED EXAMPLES

## Positive examples (well-tagged)

EXAMPLE 1 (multi-mode, all word-grounded):
Verbatim: "Feeling energized, cooking colorful meals, and sharing tasty food with people I love."
Tags: {
  "joy_modes": ["physical", "aesthetic", "hedonic", "relational"],
  "tensions": [],
  "functional_jobs": ["nourish_others"],
  "occasions": []
}
Reasoning: "energized" -> physical; "colorful" -> aesthetic; "tasty" -> hedonic; "people I love" -> relational. All directly in the words.

EXAMPLE 2 (textbook tension with both poles named):
Verbatim: "I would like higher interest rates on my CD. But I do understand it may not be possible."
Tags: {
  "joy_modes": [],
  "tensions": ["aspiration_vs_acceptance"],
  "functional_jobs": [],
  "occasions": []
}
Reasoning: "I would like" (aspiration) AND "I understand it may not be possible" (acceptance) explicit in adjacent sentences. No clear joy mode language. No active job. No occasion.

EXAMPLE 3 (clean explicit signals):
Verbatim: "I enjoyed a very good Reisling with my wife and friends during a small gathering in my home."
Tags: {
  "joy_modes": ["hedonic", "relational"],
  "tensions": [],
  "functional_jobs": ["share_experience"],
  "occasions": ["gathering", "hosting"]
}
Reasoning: "very good Reisling" -> hedonic; "with my wife and friends" -> relational + share_experience; "small gathering" -> gathering; "in my home" -> hosting.

EXAMPLE 4 (the "enjoy" verb is direct hedonic signal):
Verbatim: "I would like to see all of the historic parts of music history! I enjoy music in all it's forms"
Tags: {
  "joy_modes": ["hedonic", "inspirational"],
  "tensions": [],
  "functional_jobs": [],
  "occasions": ["anticipation"]
}
Reasoning: "I enjoy music" is direct present-tense sensory enjoyment -> hedonic. Whenever a respondent says "I enjoy X" or "I enjoyed X" or "X is enjoyable", that is hedonic word-grounded signal — not a conditional, just direct enjoyment language. "I would like to see" is forward-action -> inspirational + anticipation.

EXAMPLE 5 (legacy-brand security register is tranquil, NOT hedonic):
Verbatim: "Purchasing from a legacy brand is similar to picking something dependable, trustworthy, and long-lasting."
Tags: {
  "joy_modes": ["tranquil"],
  "tensions": [],
  "functional_jobs": ["provide_security"],
  "occasions": []
}
Reasoning: "dependable, trustworthy" is tranquil per the definition (explicit dependability language) -> tranquil. The respondent is describing the security/peace register, not sensory pleasure -> NO hedonic. "Long-lasting" + dependability = provide_security as a job.

EXAMPLE 6 (legacy-brand multi-tag — challenger_vs_legacy + purchase_moment activate when the words are present):
Verbatim: "Buying from a legacy brand feels like choosing something trusted, proven, and familiar."
Tags: {
  "joy_modes": ["tranquil"],
  "tensions": ["challenger_vs_legacy"],
  "functional_jobs": ["provide_security"],
  "occasions": ["purchase_moment"]
}
Reasoning: "trusted, proven, familiar" -> tranquil + provide_security (explicit dependability language). "legacy brand" itself is the explicit naming of the legacy/tradition pole, which activates the challenger_vs_legacy tension; the respondent is choosing the comfort/tradition side of the pull, and the "legacy" word is in the verbatim, not just in the question. "Buying from" -> purchase_moment (the purchase-act framing is in the words). When a respondent uses the word "legacy" or "legacy brand" in their answer, tag challenger_vs_legacy. When a respondent says "Buying" / "Purchasing" / "I bought", tag purchase_moment.

EXAMPLE 7 (themed dinner is BOTH live_event AND mealtime — typo recoverable):
Verbatim: "A dinner themed for the medical atmosphere as well as a jousting show"
Tags: {
  "joy_modes": ["playful", "aesthetic"],
  "tensions": [],
  "functional_jobs": ["immerse_in_story"],
  "occasions": ["live_event", "mealtime"]
}
Reasoning: "dinner" -> mealtime (eating IS part of the experience even when the focus is themed entertainment — themed dinners are dual-purpose). "jousting show" -> playful + live_event (a fun-physical activity to watch). "themed atmosphere" -> aesthetic + immerse_in_story (themed = curated visual world). The typo "medical" is inferable as "medieval" from the question context (Medieval Times); tag based on the corrected reading per Rule 7. Don't drop mealtime just because the entertainment is the headline.

## Anti-pattern examples (what NOT to do)

ANTI-PATTERN 1 (category-driven inference):
Verbatim: "Actually have been there in Cleveland, Ohio. It was interesting but I like the science museum right next door way more interesting."
WRONG: ["aesthetic"] (because the question was about a music museum, and museums are aesthetic-coded)
RIGHT: [] or possibly ["awe"] for the curiosity-of-discovery in "interesting" (twice)
Lesson: The respondent didn't use any aesthetic language. The verbatim is a comparative preference statement with thin emotional content.

ANTI-PATTERN 2 (job applied where tension belongs):
Verbatim: "If it were marketed in a way that easily let you know what to expect for the taste."
WRONG: ["learn_grow", "signal_identity"] as functional jobs
RIGHT: discovery_vs_comfort or served_vs_overlooked as tensions
Lesson: The respondent is expressing an unmet want (clearer marketing). That's tension territory, not job territory.

ANTI-PATTERN 3 (single-tag where multi-tag is needed):
Verbatim: "I'd like to go back to Alaska and do some more things that we didn't get time to do when we were last there."
WRONG: ["sentimental"] alone
RIGHT: ["inspirational", "sentimental"] - inspirational for the forward-action ("would like to go back, do more things"), sentimental for the personal history with the place
Lesson: Forward-action language and backward-personal-history language can coexist. Tag both.

ANTI-PATTERN 4 (surface-word misread on connect_remotely):
Verbatim: "Something that I need is important is connecting to the bank itself. Chase is a great bank."
WRONG: ["connect_remotely"] (because the surface word "connecting" appears)
RIGHT: [] (no functional job — the verbatim is about transactional access to an institution, not about staying in touch with people)
Lesson: connect_remotely applies ONLY to verbatims about staying in touch with PEOPLE across distance — phone or video calls between people, distance-spanning relationships. It does NOT apply to a respondent describing access to an institution's services ("connecting to my bank", "reaching the company", "getting through to support"). Institutional access is not connect_remotely.

ANTI-PATTERN 5 (tranquil applied to inferred security from a feature):
Verbatim: "Committing to allowing the customer to see their money reflected fast and in real time."
WRONG: ["tranquil"] (because real-time visibility plausibly reduces anxiety)
RIGHT: [] for joy_modes (no explicit calm/dependability language)
Lesson: Tranquil requires explicit calm or dependability language IN THE WORDS — dependable, trustworthy, reliable, solid, secure, stable, anchored, at-ease, calm, peace, peaceful, worry-free, taken-care-of. A feature that might reduce anxiety (real-time visibility, simpler choices, faster service, more approachable products) is NOT tranquil unless the verbatim also uses explicit calm/dependability language. Same rule applies to "approachable" or "easy" — those are not synonyms for peace.

ANTI-PATTERN 6 (anticipation on a past completed event with embedded "wanting"):
Verbatim: "The first time I bought my new car and was able to take my family on a vacation they've been wanting to do for years"
WRONG: ["anticipation"] (because "wanting to do" appears)
RIGHT: [] (or just [vacation, post_purchase]) — the verbatim describes a COMPLETED past event. The family's prior wanting is embedded narrative, not a current pre-experience phase the respondent is in.
Lesson: anticipation applies to the RESPONDENT's current pre-experience phase. Past-tense ("I bought", "we went", "I saw") + embedded "wanting" is NOT anticipation. The respondent is reflecting on a completed action.

ANTI-PATTERN 7 (anticipation on hope-for-systemic-change, not a planned event):
Verbatim: "I hope women's sports continue to grow in popularity"
WRONG: ["anticipation"] (because "I hope" appears)
RIGHT: [] for occasions (no specific planned event the respondent is anticipating)
Lesson: "I hope X happens in society / the world / culture" is a statement of social-systemic preference, not a personal pre-experience phase. anticipation is for personal upcoming events the respondent is preparing for or looking forward to. NOT for hopes about systemic change, market dynamics, social trends, or population-level outcomes.

ANTI-PATTERN 8 (purchase_moment + post_purchase double-tagging):
Verbatim: "I bought my used Lincoln MKS. It's very snazzy!!! I love the bells and whistles"
WRONG: ["purchase_moment", "post_purchase"]
RIGHT: ["post_purchase"] (the verbatim describes ownership/use AFTER buying; "snazzy", "bells and whistles", "love the radio" are all post-purchase enjoyment)
Lesson: purchase_moment is the act of browsing/choosing/buying. post_purchase is the owning/using/displaying phase. These are SEQUENTIAL phases in a journey, not co-occurring. When the verbatim is centered on enjoyment-of-ownership (post-purchase), do NOT also tag purchase_moment. When the verbatim is centered on the buying-act ("Buying from", "I'm shopping for", "in the store"), do NOT also tag post_purchase. Pick the one that matches the dominant tense / framing.

ANTI-PATTERN 9 (inspirational over-fire on positive forward statements):
Verbatim: "I have a feeling it's going to be a great year just waiting for winter to end"
WRONG: ["inspirational"] (because "going to be a great year" is positive-forward)
RIGHT: ["inspirational"] IS correct here (the respondent expresses hopeful momentum)
Verbatim: "Watching videos, sharing pictures on social media. Playing games."
WRONG: ["inspirational"] (because activities are listed positively)
RIGHT: [] for inspirational (no explicit motivation/empowerment/energizing-toward-action language)
Lesson: inspirational requires explicit language of being motivated, energized, empowered, encouraged, or moved-to-act. Words like "motivated", "inspired", "empowering", "energized to do", "made me want to", "got me going". A general positive forward-looking statement is NOT enough. A list of pleasurable activities is NOT enough. Without the explicit motivational register, do NOT tag inspirational.

ANTI-PATTERN 10 (immerse_in_story over-fire on music / history / memorabilia):
Verbatim: "Bon Jovi's music makes me happy"
WRONG: ["immerse_in_story"] (because Bon Jovi has songs that tell stories)
RIGHT: [] for immerse_in_story (no explicit narrative/story/film/show framing in the words)
Verbatim: "lear a good history about the palce its mission"
WRONG: ["immerse_in_story"] (because history involves narrative)
RIGHT: ["learn_grow"] (the verbatim is about learning, not story-immersion)
Lesson: immerse_in_story is for verbatims about FILMS, SHOWS, BOOKS, or explicit narrative-fandom. The respondent must mention story/film/show/book/character/plot/narrative or be naming a fictional universe (Marvel, Star Wars, Game of Thrones, etc.). General music, abstract history, museum displays, learning, and informational content do NOT count. The narrative framing must be explicit.

ANTI-PATTERN 11 (connect_remotely over-fire on general "connected"):
Verbatim: "I can do so much - watch movies, play faves, learn things - I feel connected to the world"
WRONG: ["connect_remotely"] (because "connected" appears)
RIGHT: [] for connect_remotely (no person-to-person distance-spanning communication described)
Lesson: connect_remotely applies ONLY to person-to-person distance-spanning communication: phone calls, video calls, text/messaging between people who are physically apart. "Feeling connected to the world", "connecting to my bank", "feeling connected to nature" are NOT connect_remotely. Even "stay connected with friends" requires explicit distance-spanning context (call/message/video). When in doubt, do NOT tag connect_remotely.

ANTI-PATTERN 12 (sentimental over-fire on present-time pride/joy without nostalgia):
Verbatim: "I saw my first grandson graduate as king of the prom and i'm so proud of him"
WRONG: ["sentimental"] (because grandparent + grandson is heritage-adjacent)
RIGHT: [] for sentimental (no explicit nostalgia/past-reference/memory-emotion language; this is present-time pride)
Verbatim: "the look on their face is priceless when they get their gift"
WRONG: ["sentimental"]
RIGHT: [] for sentimental (no nostalgia/past-reference language; this is present-time joy)
Lesson: sentimental requires explicit nostalgia, memory of the past, looking-back, or "how things used to be" framing. Words like "I remember", "back when", "used to", "miss [X from the past]", "took me back", "reminds me of". Present-time pride, joy, or family-moment is NOT sentimental unless the verbatim explicitly references a past memory.

ANTI-PATTERN 13 (shopping over-fire on ad recall):
Verbatim: "Fast food restaurant, Burger King commercial and one my favorite"
WRONG: ["shopping"] (because Burger King is a retailer / restaurant chain)
RIGHT: [] for occasions (the verbatim is about an AD, not about shopping at the restaurant)
Lesson: shopping requires the respondent to describe browsing, buying, or visiting a store. A verbatim about an AD or COMMERCIAL for a brand is NOT shopping. The shopping context must come from the respondent's own activity, not from a brand they saw advertised.
"""

OUTPUT_FORMAT_RULE = """\
# OUTPUT FORMAT

Return ONLY valid JSON in this exact structure, with no preamble, explanation, or markdown:

{
  "joy_modes": ["key1", "key2"],
  "tensions": ["key1"],
  "functional_jobs": [],
  "occasions": ["key1", "key2"]
}

Use the canonical keys from the framework definitions, not display names. Empty arrays are valid and expected for thin verbatims.
"""

OCCASIONS_NOTE = """\
Important note on occasions: journey-phase occasions (anticipation, in_moment, transition, memory) are ADDITIVE. A verbatim about anticipating a vacation should get BOTH `vacation` AND `anticipation`, not one or the other.

## ANTICIPATION (occasion) - explicit guardrail

Apply `anticipation` ONLY when the verbatim contains explicit pre-experience language signaling looking-forward-to-something-that-hasn't-happened-yet.

EXPLICIT ANTICIPATION TRIGGERS (any of these in the verbatim = apply anticipation):
- "looking forward to"
- "can't wait to" / "can't wait for"
- "hoping to" / "hope to"
- "planning to" / "planning a"
- "would like to" (when about a specific future plan)
- "excited for [specific future thing]"
- "dreaming about" / "thinking about going"
- Tense indicating planning a specific event

DO NOT TAG anticipation when the verbatim contains:
- General "would expect" / "would feel" hypotheticals describing how someone imagines a category in the abstract
- Future tense without a planned event ("I usually go in summer")
- Conditional statements without forward-looking emotional content
- Past-tense reflection on a previous experience

HARD GATE: Before tagging `anticipation`, ask: does the verbatim contain ANY of the trigger phrases above (looking forward, can't wait, hoping/planning to, would like to + specific future event, etc.)? If NO, do NOT tag anticipation. There is no second path to this tag — the trigger language must be present.

DISQUALIFYING PATTERNS (these LOOK like anticipation but are NOT — do NOT tag):
- Vague life-state wishes without a specific event: "hoping to enjoy a life without X", "wanting to be in a better position", "I'd like to be happier"
- Hypothetical "would" / "might" / "could" framings about a category in the abstract: "I think getting to visit a new state and seeing what they have to offer", "to see all the rockets and history", "I would expect to feel..."
- Speculative possibility language: "Maybe catch a live lift off", "perhaps go", "could try"
- Habitual present-tense routines: "I go to see all the movies the week they come out", "I usually plan a summer trip", "Every year I"
- Aspirational identity statements without a specific event: "I'd like to be in a position to participate in more activities"

False positives on anticipation are the #1 over-tagging error. When in doubt, DO NOT tag anticipation. Anticipation requires (a) explicit looking-forward language AND (b) a specific named planned event. Both conditions, not either.

WORKED EXAMPLES:
RIGHT: "I'm looking forward to my Hawaii trip in March" -> anticipation (specific planned event, explicit looking-forward language)
RIGHT: "Can't wait for the holidays this year" -> anticipation
RIGHT: "Planning a road trip for the summer" -> anticipation
RIGHT: "I have a feeling it's going to be a great year just waiting for winter to end" -> anticipation ("just waiting for X to end" is explicit looking-forward language)

WRONG: "I would expect a hotel to feel relaxing" -> NOT anticipation (hypothetical category framing, not pre-experience)
WRONG: "Hotels feel relaxing" -> NOT anticipation (general statement)
WRONG: "When I went to Hawaii I felt great" -> NOT anticipation (past-tense reflection)
WRONG: "Beachside Resort because it has one of the greatest beaches" -> NOT anticipation (preference for a destination, no specific planned trip, no looking-forward language)
WRONG: "Tokyo Japan I have been there once and I loved it" -> NOT anticipation (past-tense)
WRONG: "What kind of experience would you expect on a vacation to Florida?" -> "I would probably have a great time" -> NOT anticipation (hypothetical category framing in response to a hypothetical-framed question)
WRONG: "Peloton ad showing motivational instructors" -> NOT anticipation (about an ad, not about a planned future event)
WRONG: "lear a good history about the palce its mission and get better understandint about its techology" -> NOT anticipation (no looking-forward language; describes general expectations)
WRONG: "If you visited Kennedy Space Center, what would you expect?" -> "to see all the rockets and history" -> NOT anticipation unless the response itself contains looking-forward language
WRONG: "Life without roomates that are useless in 2026" -> NOT anticipation alone unless the verbatim contains "hoping to enjoy" or similar trigger (NOTE: "hoping to enjoy" IS a trigger, so this specific verbatim WOULD be anticipation; but the general principle is that "in 2026" tense alone is not enough)

LANGUAGE CLARIFICATION: "looking for" is NOT the same as "looking forward to". They are different phrases with different meanings, and only the latter is an anticipation trigger.
- "looking for an adventure" -> NOT anticipation (about searching/wanting in general, not a planned future event)
- "looking forward to an adventure" -> IS anticipation
- "I'm looking for new restaurants" -> NOT anticipation (search/preference, not pre-experience)
- "I'm looking forward to dinner tonight" -> IS anticipation

WRONG: "Any place tropical. Caribbean islands Love the beach and water to me it's so relaxing" -> NOT anticipation (preference statement about where you'd like to go in general; no specific planned trip; no "looking forward" / "planning" / "hoping to" trigger)
WRONG: "A beautiful backdrop to whatever adventure you're looking for" -> NOT anticipation ("looking for" is search/preference language, not pre-experience phase)

## POST_PURCHASE (occasion) - explicit guardrail

Apply `post_purchase` ONLY when the verbatim FOREGROUNDS the ongoing relationship with the purchased item — actively using it, displaying it, integrating it into life, expressing lasting satisfaction with ownership. It is NOT applied just because a purchase is mentioned.

POST_PURCHASE TRIGGERS (must be present in the verbatim):
- Active ongoing use ("I drive my new car every day", "I wear them all the time")
- Display / showing-off ("I love showing off my Lincoln", "everyone notices it")
- Integration into life ("the new couch makes my living room", "transformed my routine")
- Lasting satisfaction with ownership ("snazzy bells and whistles still impress me")
- Wearing/equipping with continuing identity meaning ("my scrubs make me feel like a professional")

DO NOT TAG post_purchase when:
- The verbatim is just about the act of buying ("I bought X", "the upgrade was nicer than the first")
- A purchase is mentioned as one item in a list of activities or fandom behaviors (focus is the activity/fandom, not ownership)
- The verbatim describes the buying decision or justification ("I got it because Y", "it was a better deal")
- The mention of "I bought" or "I purchased" is incidental to a different focus (career milestone, vacation, gift, etc.)

WORKED EXAMPLES:
RIGHT: "I bought my used Lincoln MKS. It's very snazzy! I love the bells and whistles and the radio sounds amazing!" -> post_purchase (active ongoing experience of the car's features foregrounded; "I love" the features in continuing tense)
RIGHT: "My scrubs for my nursing program" -> post_purchase (the scrubs continue to be worn as ongoing professional identity gear)

WRONG: "an upgrade of my wedding set b/c it was nicer than the first set" -> NOT post_purchase (the verbatim is about the act/justification of upgrading, not ongoing ownership)
WRONG: "I buy merchandise watch the games on tv as well as attend games in person" -> NOT post_purchase (purchase is one item in a list of fandom activities; ownership/display is not the foregrounded focus — the foregrounded focus is fandom expression)
WRONG: "I go to see all the movies in theaters the week they come out. I buy all of the movies. I buy merchandise..." -> NOT post_purchase (the verbatim is about ongoing fandom expression; the merchandise buying is part of the fandom-activity list, not a foregrounded ownership/display narrative)
WRONG: "I bought my new car and was able to take my family on a vacation" -> NOT post_purchase (the verbatim is about a vacation enabled by the car; vacation is the foregrounded focus, not ongoing ownership of the car)

When in doubt, do NOT tag post_purchase. False positives on this tag are a major over-tagging error.

## SHOPPING (occasion) - explicit guardrail

Apply `shopping` whenever the verbatim names a store, retailer, marketplace, or shopping activity, even when the verbatim is otherwise logistical or thin. Shopping captures the browse/buy/store-visit context.

RIGHT: "Stop and Shop, Shaws, and Trader Joe's, I mainly go there when BJ's doesn't have what I need" -> shopping (multiple grocery stores named, regardless of joy content)
RIGHT: "Walmart Supercenter wide variety of products" -> shopping
RIGHT: "Temu is one of my favorite places to shop" -> shopping
RIGHT: "I bought it on Amazon" -> shopping (Amazon = online shopping context)
RIGHT: "Costco for bulk" -> shopping
RIGHT: "Browsing at the mall" -> shopping

NOT shopping:
"I love a good deal" alone (preference, no store/shopping context named)
"The cashier was rude" (service interaction with no shopping framing — `service`)
"It comes in three sizes" (product factual, not shopping)
"""

TENSIONS_NOTE = """\
## ASPIRATION_VS_ACCEPTANCE vs PRESENT_VS_FUTURE - disambiguation

Both can apply when a verbatim has two conflicting pulls. Use this decision rule:

ASPIRATION_VS_ACCEPTANCE: when both poles are EMOTIONAL or LIFEWORLD (continuing pride vs accepting precarity, wanting more vs accepting what is, striving vs settling). The conflict is between desired-state and actual-state, framed in feeling/identity terms. No financial-temporal trade-off required.

PRESENT_VS_FUTURE: when both poles are EXPLICITLY TEMPORAL-FINANCIAL (spend now vs save for later, immediate joy vs disciplined preparation, carpe diem vs delayed gratification). REQUIRES either explicit financial framing ("save", "money for retirement", "budget", "rates", "interest") OR an explicit "now vs later" / "today vs tomorrow" temporal trade-off framing. Forward-looking aspiration alone is NOT enough.

WORKED EXAMPLES:

ASPIRATION_VS_ACCEPTANCE (NOT present_vs_future):
"My boss kept saying he cannot pay us on time. We are all worried the company may close. I am always proud of my job, which brings me joy and satisfaction over last 25 years."
-> aspiration_vs_acceptance: ongoing pride (aspiration: "always proud", "joy and satisfaction over last 25 years") vs accepting financial/job precarity ("worried the company may close", "cannot pay us on time"). Both poles emotional/lifeworld. NOT present_vs_future because there is no explicit "spend now vs save later" or "today vs tomorrow" trade-off — the temporal language is about a precarious-employment NOW, not a deferred-vs-immediate-financial-choice.

PRESENT_VS_FUTURE (genuine cases):
"I want to enjoy my paycheck now but I know I should save for retirement"
-> present_vs_future: explicit temporal-financial trade-off (spend now vs save for later, retirement framing)
"I would like higher interest rates on my CD but I understand it may not be possible"
-> aspiration_vs_acceptance (both emotional/financial-aspiration poles named) AND present_vs_future (the rates framing is explicit financial)

PRESENT_VS_FUTURE OVER-FIRES — DO NOT TAG these:
"I'd like to be in a position to participate in more activities and spend time with people I care about"
-> NOT present_vs_future. Aspirational forward-looking statement only — no explicit "now vs later" trade-off and no financial framing. Just an aspiration.

"I'm hoping to enjoy a life without roomates that are useless in 2026"
-> NOT present_vs_future. The "in 2026" tense is not a financial-temporal trade-off; it's just a target date for a life-state wish.

"I have a feeling it's going to be a great year just waiting for winter to end"
-> NOT present_vs_future. Forward-looking but not a now-vs-later trade-off.

When a verbatim is forward-looking but lacks an explicit "now vs later" trade-off and lacks explicit financial framing, do NOT tag present_vs_future.

## SERVED_VS_OVERLOOKED — positive-framing clarifier

served_vs_overlooked applies even when the verbatim is positively framed (hopes, aspirations) about a structurally underserved group, category, or population. The structural visibility / recognition / inclusion gap is what counts, not whether the framing is a complaint.

POSITIVE-FRAMING TRIGGERS (these all qualify):
- "I hope X (an underserved group) gets more attention/recognition/parity"
- "I want brands to make more for [overlooked population]"
- "It would be great if [overlooked group] had what [served group] has"
- Naming a parity gap between two groups, regardless of complaint frame

WORKED EXAMPLES:
RIGHT: "I hope women's sports continue to grow in popularity and can be as profitable as men's sports have become at the pro levels. This will then increase the salaries of women in sports."
-> served_vs_overlooked. The structural gap is named — women's sports positioned BELOW men's sports, with hope for parity. The positive framing ("hope", "increase") does not disqualify the tag.
RIGHT: "I want fashion brands to make more clothes for plus-size customers"
-> served_vs_overlooked (positive framing, structural visibility gap named)
RIGHT: "Every category should have options for older adults — most just market to younger people"
-> served_vs_overlooked

NOT served_vs_overlooked even with a positive frame:
"I hope this brand keeps making good products" (no structural gap named)
"I hope I get a raise this year" (individual aspiration, not group visibility)

## DWELLING_VS_ADVANCING (tension) - worked examples

The pull between staying with what's familiar, comfortable, or known vs moving on to something new, different, or forward.

WORKED EXAMPLES:
RIGHT: "I keep going back to the same restaurant even though I should try new ones" -> dwelling_vs_advancing
RIGHT: "I love this old neighborhood but I know I need to grow" -> dwelling_vs_advancing
RIGHT: "Part of me wants to stay in this routine, part of me wants to break out of it" -> dwelling_vs_advancing
RIGHT: "I miss how things used to be but I'm trying to move forward" -> dwelling_vs_advancing
RIGHT: "Everything is getting better for me and going in the right direction" -> dwelling_vs_advancing (forward-momentum framing implies leaving prior state behind; advancing pull explicit, dwelling pull implicit by contrast)
RIGHT: "Trying to release what doesn't serve me anymore" -> dwelling_vs_advancing (releasing language explicit, dwelling-pull implicit)
RIGHT: "I'm finally moving forward after a hard year" -> dwelling_vs_advancing

NOTE: Unlike luxury_vs_value (which requires BOTH pulls present), dwelling_vs_advancing CAN apply when only the advancing pull is explicit, IF the verbatim's framing implies movement-from-something. Forward-momentum language ("getting better", "going in the right direction", "moving forward", "trying to release", "leaving behind", "trying to grow", "breaking through", "finally") activates this tension even without explicit dwelling language. The framing "I am moving forward" presupposes a prior state being moved-from.

NOT this tension:
"I prefer my usual spot" (mere preference, no gap expressed)
"I always go to the same place" (habit, no opposing pull)
"I'm trying new things this year" (forward motion alone with no narrative of moving-from-prior-state — just a habit change)

## SELF_VS_OTHERS (tension) - worked examples

The pull between joy from inward focus (self-care, self-investment, treat-yourself) vs outward focus (others' joy, generosity, giving to others).

WORKED EXAMPLES:
RIGHT: "I would donate some to charity and then use it to my likings" -> self_vs_others (BOTH polarities explicit: "donate to charity" = others, "use it to my likings" = self)
RIGHT: "Half for me, half for my family" -> self_vs_others
RIGHT: "Sometimes I treat myself; sometimes I give it away" -> self_vs_others
RIGHT: "Part of me wants to help others, part wants to spend on myself" -> self_vs_others

NOT this tension:
"I love giving gifts" alone (one-directional outward, no opposing self pull)
"I'm being selfish for once" alone (no others' pull expressed)
"I bought myself something nice" alone (one-directional inward, no opposing others pull)

## SERVED_VS_OVERLOOKED (tension) - worked examples

The gap between feeling addressed, recognized, or catered to vs feeling ignored, unseen, or overlooked by a category, brand, or institution.

WORKED EXAMPLES:
RIGHT: "Women's sports get nowhere near the attention men's sports do" -> served_vs_overlooked
RIGHT: "Brands market to younger people but not us" -> served_vs_overlooked
RIGHT: "There's nothing for people like me in this category" -> served_vs_overlooked
RIGHT: "Plus-size options are an afterthought everywhere" -> served_vs_overlooked
RIGHT: "Nobody makes products for someone in my situation" -> served_vs_overlooked

NOT this tension:
"I wish there were more options" (general gap, not about being seen or recognized)
"I want better quality" (quality complaint, not visibility complaint)
"They should lower prices" (pricing complaint)

## LUXURY_VS_VALUE (tension) - worked examples

The pull between paying for quality, experience, or status vs paying for affordability, practicality, or savings.

CRITICAL: Both pulls must be present in the verbatim. If only the value side or only the luxury side is expressed without the other, this tension does not apply.

WORKED EXAMPLES:
RIGHT: "I want the nice version but I can't justify the price" -> luxury_vs_value (both pulls present)
RIGHT: "I keep buying the cheap one even though I want to splurge" -> luxury_vs_value
RIGHT: "Part of me says treat yourself, part says save the money" -> luxury_vs_value
RIGHT: "I'd love the premium option but the budget version is fine" -> luxury_vs_value
RIGHT: "Going back and forth between the two - quality matters but so does price" -> luxury_vs_value
RIGHT: "A good menu with variety of meals... offers a drink with the price of a meal" -> luxury_vs_value (quality desire — variety, taste — explicitly paired with value calculation — bundled drink/meal pricing). Bundling, "included with", "for the price of", "good deal on a quality product" are value-calculation phrases that pair with the quality/luxury preference being expressed.
RIGHT: "Better value and simpler recommendations would make it more approachable and enjoyable" -> luxury_vs_value ("better value" is the value pull; "more enjoyable / approachable" implies the quality/experience pull)
RIGHT: "I want fresh ingredients but not pay restaurant prices" -> luxury_vs_value

NOT this tension:
"It was overpriced" (complaint about a single side, not a tension between two pulls)
"I bought the cheap one" (no expressed pull toward luxury)
"I love a good deal" (no opposing luxury pull)
"This is high quality" (no opposing value pull)
"I always buy the best" (resolution, not tension)
"""


def _format_framework_block(name: str, entries: list[dict]) -> str:
    """Renders one framework's keys as a bullet list for the prompt.

    Format: `key — display_name: definition`
    """
    title_map = {
        'joy_modes': 'JOY MODES',
        'tensions': 'TENSIONS',
        'functional_jobs': 'FUNCTIONAL JOBS',
        'occasions': 'OCCASIONS',
    }
    title = title_map.get(name, name.upper())
    lines = [f'# FRAMEWORK: {title}', '']
    for e in entries:
        defn = (e.get('definition') or '').strip().replace('\n', ' ')
        lines.append(f"- `{e['key']}` ({e['display_name']}): {defn}")
    if name == 'occasions':
        lines.append('')
        lines.append(OCCASIONS_NOTE.strip())
    elif name == 'tensions':
        lines.append('')
        lines.append(TENSIONS_NOTE.strip())
    return '\n'.join(lines)


def build_system_prompt(frameworks: dict) -> str:
    """Builds the full system prompt with framework definitions injected.

    Returns a string ~6-8K chars. Token-stable for prompt caching when
    framework definitions don't change.
    """
    parts = [
        'You are a framework tagger for the Brand Joy Lab consumer research database. '
        'Your job is to assign tags from four canonical frameworks to a verbatim consumer response.',
        '',
        CALIBRATION_RULES,
        '',
        _format_framework_block('joy_modes', frameworks['joy_modes']),
        '',
        _format_framework_block('tensions', frameworks['tensions']),
        '',
        _format_framework_block('functional_jobs', frameworks['functional_jobs']),
        '',
        _format_framework_block('occasions', frameworks['occasions']),
        '',
        OUTPUT_FORMAT_RULE,
        '',
        WORKED_EXAMPLES,
    ]
    return '\n'.join(parts)


def build_user_message(response_text: str, question_text: str | None) -> str:
    """The per-call user-message turn. Question context is given but
    never authoritative — Rule 2 says category context can't drive tags."""
    q = (question_text or '').strip() or '(no question text on file)'
    r = (response_text or '').strip()
    return f'Question: {q}\n\nVerbatim: {r}\n\nApply the calibration rules. Return JSON only.'


# ---------------------------------------------------------------------------
# JSON response parsing
# ---------------------------------------------------------------------------

# Regex for stripping ```json ... ``` fences. Handles ```json, ```JSON, ```
# (no language tag), with or without trailing newlines.
_FENCE_OPEN = re.compile(r'^```(?:json)?\s*\n', re.IGNORECASE)
_FENCE_CLOSE = re.compile(r'\n```\s*$')

# Comma-before-closing-bracket cleanup for the most common malformations.
_TRAILING_COMMA = re.compile(r',\s*([\]}])')


def _strip_fences(raw: str) -> str:
    s = raw.strip()
    s = _FENCE_OPEN.sub('', s)
    s = _FENCE_CLOSE.sub('', s)
    return s.strip()


def parse_response(raw: str) -> dict | None:
    """Parses Haiku's response into a tag dict, or None if unparseable.

    Tolerant to common malformations:
      - ```json ... ``` fence wrapping
      - trailing whitespace
      - single trailing commas (best-effort)
      - trailing prose after the JSON object (e.g. unsolicited "Reasoning: ..." block)
    """
    if not raw or not raw.strip():
        return None
    s = _strip_fences(raw)
    # First try strict parse.
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    # Try with trailing-comma cleanup.
    s2 = _TRAILING_COMMA.sub(r'\1', s)
    try:
        return json.loads(s2)
    except json.JSONDecodeError:
        pass
    # Fallback: extract the first balanced JSON object via raw_decode.
    # Handles cases where Haiku appends prose ("Reasoning: ...") after the
    # closing brace despite the prompt forbidding it.
    decoder = json.JSONDecoder()
    start = s2.find('{')
    if start >= 0:
        try:
            obj, _end = decoder.raw_decode(s2[start:])
            if isinstance(obj, dict):
                return obj
        except json.JSONDecodeError:
            pass
    log.warning('parse_response: JSON decode failed after cleanup; raw=%r', raw[:300])
    return None


def filter_to_canonical(parsed: dict, canonical: dict[str, set[str]]) -> dict:
    """Returns a normalized dict with hallucinated keys dropped.

    Always includes all four framework keys, even if the model omitted them
    or returned non-array values. Defaults to []. Keys outside the canonical
    set are dropped with a debug log.
    """
    out = {}
    for fwk in ('joy_modes', 'tensions', 'functional_jobs', 'occasions'):
        raw = parsed.get(fwk) if isinstance(parsed, dict) else None
        if not isinstance(raw, list):
            out[fwk] = []
            continue
        valid = canonical.get(fwk, set())
        kept = []
        for v in raw:
            if not isinstance(v, str):
                continue
            v = v.strip()
            if v in valid:
                kept.append(v)
            else:
                log.debug('filter_to_canonical: dropped hallucinated %s key %r', fwk, v)
        # Dedupe preserving order
        seen = set()
        deduped = []
        for v in kept:
            if v not in seen:
                seen.add(v)
                deduped.append(v)
        out[fwk] = deduped
    return out


# ---------------------------------------------------------------------------
# Cost / token tracking
# ---------------------------------------------------------------------------

@dataclass
class BatchStats:
    n_total: int = 0
    n_success: int = 0
    n_failed: int = 0
    wall_seconds: float = 0.0
    # Anthropic prompt caching breaks 'input_tokens' into three buckets.
    # We track all three so cost projections are realistic for backfills.
    total_input_tokens: int = 0          # uncached fresh input (per-verbatim user msg)
    total_cache_creation_tokens: int = 0  # cache write — billed at 1.25x input price
    total_cache_read_tokens: int = 0      # cache hit — billed at 0.1x input price
    total_output_tokens: int = 0
    failures: list[tuple[int | str, str]] = field(default_factory=list)

    @property
    def est_cost_usd(self) -> float:
        # Haiku 4.5 prompt-caching prices:
        #   cache write = 1.25x base input
        #   cache read  = 0.10x base input
        return (
            self.total_input_tokens * INPUT_PRICE_PER_M / 1_000_000
            + self.total_cache_creation_tokens * INPUT_PRICE_PER_M * 1.25 / 1_000_000
            + self.total_cache_read_tokens * INPUT_PRICE_PER_M * 0.10 / 1_000_000
            + self.total_output_tokens * OUTPUT_PRICE_PER_M / 1_000_000
        )

    def as_dict(self) -> dict:
        return {
            'n_total': self.n_total,
            'n_success': self.n_success,
            'n_failed': self.n_failed,
            'wall_seconds': round(self.wall_seconds, 2),
            'total_input_tokens': self.total_input_tokens,
            'total_cache_creation_tokens': self.total_cache_creation_tokens,
            'total_cache_read_tokens': self.total_cache_read_tokens,
            'total_output_tokens': self.total_output_tokens,
            'est_cost_usd': round(self.est_cost_usd, 4),
            'failures': self.failures[:10],  # cap for logging
        }


# ---------------------------------------------------------------------------
# Async tagging — single + batch
# ---------------------------------------------------------------------------

async def tag_verbatim(
    client,
    response_text: str,
    question_text: str | None,
    system_prompt: str,
    canonical: dict[str, set[str]],
    *,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> tuple[dict | None, dict]:
    """One Haiku call. Returns (tags_dict_or_None, usage_dict).

    Retries on:
      - RateLimitError (429)
      - APIStatusError with status_code == 529 (overloaded)
      - APIConnectionError (network blip)

    Up to 3 retries with exponential backoff (1s, 4s, 16s). Other errors
    propagate. Irrecoverable parse failures return (None, usage).

    The system prompt is sent as a cache-controlled content block so the
    first call writes the cache and subsequent calls within the 5-minute
    TTL hit it. For the 62K-verbatim backfill at concurrency=8 this drops
    input cost by ~90% (cache reads bill at 0.10x base input).
    """
    user_msg = build_user_message(response_text, question_text)
    system_blocks = [{
        'type': 'text',
        'text': system_prompt,
        'cache_control': {'type': 'ephemeral'},
    }]
    last_exc = None

    for attempt, delay in enumerate([0] + list(RETRY_DELAYS_SEC)):
        if delay:
            await asyncio.sleep(delay)
        try:
            resp = await client.messages.create(
                model=HAIKU_MODEL,
                max_tokens=max_tokens,
                system=system_blocks,
                messages=[{'role': 'user', 'content': user_msg}],
            )
            usage = {
                'input_tokens': getattr(resp.usage, 'input_tokens', 0) or 0,
                'cache_creation_input_tokens': getattr(resp.usage, 'cache_creation_input_tokens', 0) or 0,
                'cache_read_input_tokens': getattr(resp.usage, 'cache_read_input_tokens', 0) or 0,
                'output_tokens': getattr(resp.usage, 'output_tokens', 0) or 0,
            }
            text_parts = [b.text for b in resp.content if getattr(b, 'type', None) == 'text']
            raw = '\n'.join(text_parts).strip()
            parsed = parse_response(raw)
            if parsed is None:
                # Unparseable — don't retry, return failure with usage so we
                # still account for the cost.
                return None, usage
            return filter_to_canonical(parsed, canonical), usage
        except RateLimitError as e:
            last_exc = e
            log.info('tag_verbatim: rate limit, retry %s/%s', attempt + 1, len(RETRY_DELAYS_SEC))
            continue
        except APIStatusError as e:
            sc = getattr(e, 'status_code', None)
            if sc == 529:
                last_exc = e
                log.info('tag_verbatim: overloaded (529), retry %s/%s', attempt + 1, len(RETRY_DELAYS_SEC))
                continue
            raise
        except APIConnectionError as e:
            last_exc = e
            log.info('tag_verbatim: connection error, retry %s/%s', attempt + 1, len(RETRY_DELAYS_SEC))
            continue

    log.warning('tag_verbatim: gave up after retries: %s', last_exc)
    return None, {'input_tokens': 0, 'cache_creation_input_tokens': 0,
                  'cache_read_input_tokens': 0, 'output_tokens': 0}


async def tag_verbatims_batch(
    verbatims: Iterable[dict],
    frameworks: dict,
    *,
    concurrency: int = DEFAULT_CONCURRENCY,
    api_key: str | None = None,
    progress_cb=None,
) -> tuple[list[dict], BatchStats]:
    """Batch-tag verbatims with a configurable concurrency cap.

    verbatims: iterable of {'id', 'response_text', 'question_text'}
    Returns (results, stats) where results is a list of:
        {'id': ..., 'joy_modes': [...], 'tensions': [...],
         'functional_jobs': [...], 'occasions': [...], 'ok': True|False}
    Order of results matches the input order.

    progress_cb: optional callback invoked as progress_cb(done, total) on
    every completion. Useful for CLI progress lines.
    """
    if not HAS_ANTHROPIC:
        raise RuntimeError(
            'anthropic SDK not installed. Run: pip install -r requirements-tagger.txt'
        )

    verbatims_list = list(verbatims)
    canonical = canonical_keys(frameworks)
    system_prompt = build_system_prompt(frameworks)

    client = AsyncAnthropic(api_key=api_key or os.environ.get('ANTHROPIC_API_KEY'))
    sem = asyncio.Semaphore(concurrency)
    stats = BatchStats(n_total=len(verbatims_list))
    results: list[dict] = [None] * len(verbatims_list)  # type: ignore
    done_count = [0]

    async def one(i: int, v: dict):
        async with sem:
            tags, usage = await tag_verbatim(
                client,
                v.get('response_text', ''),
                v.get('question_text'),
                system_prompt,
                canonical,
            )
        stats.total_input_tokens += usage.get('input_tokens', 0)
        stats.total_cache_creation_tokens += usage.get('cache_creation_input_tokens', 0)
        stats.total_cache_read_tokens += usage.get('cache_read_input_tokens', 0)
        stats.total_output_tokens += usage.get('output_tokens', 0)
        if tags is None:
            stats.n_failed += 1
            stats.failures.append((v.get('id', i), 'parse_or_retry_failure'))
            results[i] = {
                'id': v.get('id'),
                'joy_modes': [], 'tensions': [],
                'functional_jobs': [], 'occasions': [],
                'ok': False,
            }
        else:
            stats.n_success += 1
            results[i] = {
                'id': v.get('id'),
                'joy_modes': tags['joy_modes'],
                'tensions': tags['tensions'],
                'functional_jobs': tags['functional_jobs'],
                'occasions': tags['occasions'],
                'ok': True,
            }
        done_count[0] += 1
        if progress_cb:
            try:
                progress_cb(done_count[0], stats.n_total)
            except Exception:
                pass

    t0 = time.time()
    await asyncio.gather(*(one(i, v) for i, v in enumerate(verbatims_list)))
    stats.wall_seconds = time.time() - t0
    return results, stats


# ---------------------------------------------------------------------------
# Sync convenience (single verbatim) — used by smoke tests + ad-hoc one-offs
# ---------------------------------------------------------------------------

def tag_verbatim_sync(
    response_text: str,
    question_text: str | None,
    system_prompt: str,
    canonical: dict[str, set[str]],
    *,
    api_key: str | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> dict | None:
    """Sync one-off helper. Internally runs the async path with concurrency=1.

    Returns the tags dict or None on irrecoverable failure.
    """
    if not HAS_ANTHROPIC:
        raise RuntimeError(
            'anthropic SDK not installed. Run: pip install -r requirements-tagger.txt'
        )

    async def _run():
        client = AsyncAnthropic(api_key=api_key or os.environ.get('ANTHROPIC_API_KEY'))
        tags, _usage = await tag_verbatim(
            client, response_text, question_text, system_prompt,
            canonical, max_tokens=max_tokens,
        )
        return tags

    return asyncio.run(_run())


# ---------------------------------------------------------------------------
# Module CLI: 'python -m bin.framework_tagger' tags one verbatim from stdin
# ---------------------------------------------------------------------------

def _cli():  # pragma: no cover — convenience tool only
    """Tags a single verbatim from STDIN. Useful for ad-hoc inspection.

    Usage: echo "the verbatim text" | python bin/framework_tagger.py
    """
    import psycopg2  # local import: only the CLI needs DB access
    import sys
    text = sys.stdin.read().strip()
    if not text:
        sys.exit('no verbatim on stdin')
    db_url = os.environ['DATABASE_URL']
    with psycopg2.connect(db_url) as conn:
        frameworks = load_frameworks_from_db(conn)
    canonical = canonical_keys(frameworks)
    prompt = build_system_prompt(frameworks)
    tags = tag_verbatim_sync(text, None, prompt, canonical)
    print(json.dumps(tags, indent=2))


if __name__ == '__main__':  # pragma: no cover
    _cli()
