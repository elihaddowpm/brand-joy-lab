// decomposer.js
// Takes a user query (plus optional intent hint, strategist context, Waldo context)
// and returns a structured retrieval spec the orchestrator uses to hit Supabase.

import Anthropic from "@anthropic-ai/sdk";

const DECOMPOSER_MODEL = "claude-sonnet-4-5";

// Closed vocabularies that match the Supabase reference tables.
// If these drift, retrieval will silently drop tags.
const JOY_MODES = [
  "playful", "aesthetic", "hedonic", "physical", "sentimental",
  "relational", "achievement", "triumph", "freedom", "awe",
  "inspirational", "self_actualization", "spiritual", "tranquil",
];

const OCCASIONS = [
  "everyday", "weekend", "vacation", "holiday", "birthday",
  "celebration", "gathering", "gift_giving", "alone_time", "mealtime",
  "morning", "evening", "special_occasion", "purchase_moment",
  "post_purchase", "anticipation", "in_moment", "memory", "transition",
  "work", "hosting", "travel_journey", "sports_viewing", "live_event",
  "shopping",
];

const FUNCTIONAL_JOBS = [
  "reward_self", "nourish_others", "build_belonging", "mark_milestone",
  "escape_routine", "relax_recover", "signal_status", "signal_identity",
  "connect_remotely", "create_memory", "demonstrate_care",
  "provide_security", "plan_future", "express_creativity", "learn_grow",
  "compete", "cheer_team", "refuel", "relieve_anxiety", "feel_proud",
  "display_taste", "immerse_in_story", "share_experience",
  "preserve_tradition",
];

const TENSIONS = [
  "challenger_vs_legacy", "discovery_vs_comfort",
  "moderation_vs_indulgence", "performance_vs_pleasure",
  "savings_vs_spending", "individual_vs_communal", "present_vs_future",
  "tradition_vs_modern", "luxury_vs_value", "digital_vs_physical",
  "introvert_vs_extrovert", "control_vs_surrender",
  "aspiration_vs_acceptance", "self_vs_others",
  "forgiveness_vs_foresight",
];

const CATEGORY_KEYS = [
  "general_joy", "food_joy", "food_eating",
  "travel_attractions", "travel_destinations", "travel_journey_stages", "travel_hospitality",
  "home_furniture", "retail_grocery", "financial",
  "sports_fandom", "sports_tailgating", "technology_internet",
  "brand_trust", "celebrities", "health_wellness", "health_ratings",
];

const GENERATIONS = ["Gen Z", "Younger Millennial", "Elder Millennial", "Gen X", "Boomer"];
const GENDERS = ["Male", "Female"];
const INCOME_BRACKETS = ["Under $35K", "$35K-$75K", "$75K-$125K", "Over $125K"];
const PARENTAL_STATUSES = ["Parent", "Non-parent"];

const DECOMPOSER_SYSTEM_PROMPT = `You translate a BJL (Brand Joy Lab) research query into a structured retrieval spec. Your output is parsed as JSON, so output valid JSON only. No preamble, no markdown fences, no commentary.

YOUR JOB: Look at the query and figure out what evidence from the BJL dataset would make the response strongest. Specify that evidence as a retrieval spec.

THE FOUR TAG DIMENSIONS (all values must come from these lists):

joy_modes: ${JSON.stringify(JOY_MODES)}
occasions: ${JSON.stringify(OCCASIONS)}
functional_jobs: ${JSON.stringify(FUNCTIONAL_JOBS)}
tensions: ${JSON.stringify(TENSIONS)}

CATEGORIES (optional filter, for narrowing retrieval to relevant verticals):
${JSON.stringify(CATEGORY_KEYS)}

DEMOGRAPHICS (for verbatim filtering):
- generation: ${JSON.stringify(GENERATIONS)}
- gender: ${JSON.stringify(GENDERS)}
- income_bracket: ${JSON.stringify(INCOME_BRACKETS)}
- parental_status: ${JSON.stringify(PARENTAL_STATUSES)}

OUTPUT SCHEMA:
{
  "intent": "outreach_angle" | "brand_lookup" | "audience_deep_dive" | "data_pull" | "email_findings" | "general",
  "category_keys": ["..."],
  "joy_modes": ["..."],
  "occasions": ["..."],
  "functional_jobs": ["..."],
  "tensions": ["..."],
  "demographics": {
    "generation": ["..."] | null,
    "gender": ["..."] | null,
    "income_bracket": ["..."] | null,
    "parental_status": ["..."] | null
  },
  "semantic_query": "short phrase capturing the query's emotional/strategic core, used for embedding search",
  "entity_tokens": [...] | null,
  "min_n": integer (default 200; use lower for narrow queries),
  "reasoning": "one sentence explaining your tag choices"
}

entity_tokens: specific brand names, product names, proper nouns from the query that should be searched directly by text match. Null if the query has no specific entity.

TAGGING PRINCIPLES:
1. Pick 2-5 joy_modes, 1-4 occasions, 2-5 functional_jobs, 0-3 tensions. Tighter specs produce sharper retrieval.
2. Use the intent hint if provided; otherwise infer from query shape.
3. For brand-lookup and outreach queries, lean into the category the brand competes in plus the joy modes that fit their natural emotional territory.
4. For audience queries, set the relevant demographic filter. Leave others null.
5. The semantic_query should be 3-10 words capturing the emotional/strategic core. Not a restatement of the query; a distillation.
6. Only set a demographic filter if the query explicitly targets that demographic. Don't infer demographics from the brand's imagined audience.
7. If the query is genuinely about something outside BJL's scope (e.g. asking Claude to write code), return empty arrays and intent="general".
8. If the query contains specific brand names, product names, destination names, celebrity names, or other proper nouns that identify a particular entity, extract them into entity_tokens. Examples:
   - "Tell me what we know about Cracker Barrel" → entity_tokens: ["Cracker Barrel"]
   - "How do travelers describe Hawaii versus Florida" → entity_tokens: ["Hawaii", "Florida"]
   - "What do BJL verbatims say about Disney" → entity_tokens: ["Disney"]
   - "joy among Gen Z sports fans" → entity_tokens: null (no specific entity)
   - "Outreach for EchoPark Speedway" → entity_tokens: ["EchoPark Speedway"]
Entity tokens enable a text-based retrieval path that bypasses the categorization of the underlying data. Only include tokens that are specific entities — do not include common nouns, category names, or generic terms.`;

/**
 * Decompose a user query into a structured retrieval spec.
 * @param {Object} params
 * @param {string} params.query - The user's natural-language query
 * @param {string} [params.intentHint] - UI-provided intent hint
 * @param {string} [params.strategistContext] - PETERMAYER-specific context (agency credentials, focus areas)
 * @param {Object} [params.waldoContext] - Account-level prospect research if present
 * @param {Anthropic} params.client - Anthropic client instance
 * @returns {Promise<Object>} The retrieval spec
 */
export async function decompose({ query, intentHint, strategistContext, waldoContext, client }) {
  let userMessage = `QUERY:\n${query}`;
  
  if (intentHint) {
    userMessage += `\n\nINTENT HINT: ${intentHint}`;
  }
  if (strategistContext) {
    userMessage += `\n\nSTRATEGIST CONTEXT:\n${strategistContext}`;
  }
  if (waldoContext) {
    userMessage += `\n\nACCOUNT CONTEXT (Waldo research on the target account):\n${JSON.stringify(waldoContext).slice(0, 3000)}`;
  }
  
  userMessage += "\n\nReturn the retrieval spec as JSON.";

  const response = await client.messages.create({
    model: DECOMPOSER_MODEL,
    max_tokens: 1500,
    system: DECOMPOSER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  let text = response.content[0].text.trim();
  if (text.startsWith("```")) {
    text = text.split("\n").slice(1, -1).join("\n").trim();
    if (text.startsWith("json")) text = text.slice(4).trim();
  }

  const spec = JSON.parse(text);
  
  // Defensive filtering: drop any values that aren't in the controlled vocab.
  // This prevents silent retrieval drops if the model hallucinates a tag.
  spec.joy_modes = (spec.joy_modes || []).filter(v => JOY_MODES.includes(v));
  spec.occasions = (spec.occasions || []).filter(v => OCCASIONS.includes(v));
  spec.functional_jobs = (spec.functional_jobs || []).filter(v => FUNCTIONAL_JOBS.includes(v));
  spec.tensions = (spec.tensions || []).filter(v => TENSIONS.includes(v));
  spec.category_keys = (spec.category_keys || []).filter(v => CATEGORY_KEYS.includes(v));
  
  if (spec.demographics) {
    if (spec.demographics.generation) {
      spec.demographics.generation = spec.demographics.generation.filter(v => GENERATIONS.includes(v));
      if (spec.demographics.generation.length === 0) spec.demographics.generation = null;
    }
    if (spec.demographics.gender) {
      spec.demographics.gender = spec.demographics.gender.filter(v => GENDERS.includes(v));
      if (spec.demographics.gender.length === 0) spec.demographics.gender = null;
    }
    if (spec.demographics.income_bracket) {
      spec.demographics.income_bracket = spec.demographics.income_bracket.filter(v => INCOME_BRACKETS.includes(v));
      if (spec.demographics.income_bracket.length === 0) spec.demographics.income_bracket = null;
    }
    if (spec.demographics.parental_status) {
      spec.demographics.parental_status = spec.demographics.parental_status.filter(v => PARENTAL_STATUSES.includes(v));
      if (spec.demographics.parental_status.length === 0) spec.demographics.parental_status = null;
    }
  }
  
  spec.entity_tokens = Array.isArray(spec.entity_tokens) && spec.entity_tokens.length > 0
    ? spec.entity_tokens.slice(0, 5)
    : null;

  spec.min_n = spec.min_n ?? 200;
  spec.intent = spec.intent ?? "general";

  return spec;
}
