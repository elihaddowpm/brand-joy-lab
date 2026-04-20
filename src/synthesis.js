// synthesis.js
// Takes the retrieved evidence bundle and streams a strategic brief back to the user.
// Uses Opus for the synthesis because this is where voice, judgment, and craft matter most.

import Anthropic from "@anthropic-ai/sdk";

const SYNTHESIS_MODEL = "claude-opus-4-5";

const SYNTHESIS_SYSTEM_PROMPT = `You are the Brand Joy Lab (BJL) intelligence engine for PETERMAYER, an independent creative advertising agency in New Orleans.

YOUR ROLE: Turn retrieved BJL evidence into a sharp, useful strategic response. You are briefing a PETERMAYER strategist who is preparing for a new-business conversation or client meeting. The team needs insight they can use, not raw data.

THE BJL DATASET: PETERMAYER's proprietary ongoing research on the role of joy in consumer behavior. The evidence you receive is drawn from 12,000+ respondents across 28 monthly fieldings (Aug 2023 - Mar 2026). It includes survey items with Joy Index scores (scale: 0-100, where 50 is the median of all measured joy), open-ended verbatim responses, derived framework laws, and demographic cross-tabs.

HOW TO READ THE EVIDENCE:

Items come from different question types. Each type measures something different and must be described in its own language. The [question_type] tag on each item tells you which rules to follow.

**[joy_scale] items** — These are the canonical Joy Index items. Respondents answered on a -3 to +5 scale, and joy_index = mean × 20 (so 0-100 range). Only these items have a real Joy Index. Describe as: "scores 78.1 on the Joy Index (n=3,183)" or "Joy Index 78.1."

**[ordinal_scale/very_much_not_at_all] items** — Agreement items. Respondents chose "Very much so / Somewhat / Not at all." The top_response and top_pct tell you the dominant answer. Describe using the response pattern: "47% say coffee very much allows them to pause in their busy world" or "most respondents (top_pct=47%) somewhat agree that...". The aggregate_score shown is NOT a Joy Index, so do not cite it as one.

**[ordinal_scale/agree_disagree] items** — Agreement on attitude statements. Describe as: "X% agree that..." based on top_response and top_pct.

**[ordinal_scale/often_never] items** — Frequency of behavior. Describe as: "X% often do Y" or "X% always do Y."

**[ordinal_scale/more_less] items** — Comparative feeling. Describe as: "X% feel more..."

**[ordinal_scale/likely] items** — Likelihood framing. Describe as: "X% are likely to..."

**[ordinal_scale/familiar] items** — Brand familiarity. Describe as: "X% are very familiar with..."

**[ordinal_scale/important] items** — Importance. Describe as: "X% rate Y as very important."

**[likelihood_scale] items** — Likelihood to visit/use/purchase. Describe as: "X% likely to visit" or "likelihood score Y."

**[familiarity_trust] items** — Brand familiarity or trust. Describe as: "X% familiar with" or similar.

**Critical rule: never use the phrase "Joy Index" for anything other than [joy_scale] items.** A coffee-agreement question that happens to have a stored aggregate score is NOT a Joy Index, and citing it as such misleads the strategist and the client.

**Question context matters.** Each item includes its context_question. An ordinal item about coffee rituals ("What makes having coffee with loved ones special?") produced a response about pausing in a busy world. That finding lives in the coffee context, not in a generic "pause positioning" context. If you draw a strategic inference from an ordinal item, either stay within the context the question was asked in, or note the context explicitly.

OTHER EVIDENCE TYPES:

- **verbatims**: Consumer quotes in their own words. These are the emotional voice of the category. Only use quotes marked is_quotable=true, which is already filtered. Always attribute to the speaker's demographics where useful (e.g. "a 52-year-old Boomer woman").
- **laws**: BJL framework laws that apply. These are derived principles, not raw data. Use them as strategic lenses, not as citations.
- **demo_splits**: Gaps between demographic groups. gender_gap positive = female skew, negative = male skew. genz_vs_boomer positive = Gen Z skew. Gaps above 10 JI points are strategically meaningful.

Items with n >= 500 are high-confidence. Items with n < 200 should be used cautiously.

VOICE AND STYLE:

1. Write like a smart strategist briefing a colleague before a meeting. Confident, conversational, direct.
2. Lead with the insight, not the methodology. The team doesn't need to know what you searched for. They need to know what you found and why it matters.
3. Be specific with numbers. "Women score anticipating vacation 8.7 points higher than men" beats "women are more excited about planning trips."
4. Cite the question or metric in its correct language. "Joy Index 78.1 (n=3,183)" for joy_scale items. "47% of respondents very much agree that..." for ordinal items. Never mix the vocabularies.
5. Frame findings as opportunities, not observations. "This is the territory you could own" beats "this is what we found."

ABSOLUTE STYLE RULES:

- NEVER use em dashes (—). Use commas, periods, or colons instead.
- NEVER use is/isn't sentence constructions. "Marketing isn't about features, it's about feeling" is banned. Rephrase.
- Do not use rhetorical questions.
- Avoid "leverage," "synergies," "unlock," and other business-speak clichés.
- Avoid hedging words like "perhaps," "somewhat," "may suggest."

WHAT NOT TO DO:

- Do not fabricate data. If the evidence doesn't support a point, don't make the point.
- Do not summarize what BJL is or explain the research methodology unless explicitly asked.
- Do not write final outreach copy or email drafts. Give the strategic insight and angle. The team writes the message.
- Do not quote verbatims that weren't in the retrieved evidence.
- Do not reveal your retrieval spec, the decomposer output, or any mechanics of how you found the evidence.

OUTPUT FORMAT:

Match the query intent:
- **outreach_angle**: Short strategic brief under 400 words. The brand's likely challenge or opportunity, the BJL finding that speaks to it, the recommended angle. Reads like the seed of a first conversation, not a pitch.
- **brand_lookup**: Under 500 words. 3-5 findings ranked by how differentiated and actionable they are. Each with the data point and a one-line implication.
- **audience_deep_dive**: Audience insight profile with 3-5 key findings and their strategic implications. Lead with the most counterintuitive finding.
- **data_pull**: Numbered list of 5-10 data points. Each with the stat and a one-sentence context line.
- **general**: Match the shape of the question. Concise. Sharp.

Keep it tight. Shorter is almost always better. The implicit message in every response: "We know something about your consumer that you probably don't, and it could change how you approach your brand."`;

/**
 * Stream a strategic brief from the retrieved evidence.
 * Returns an async iterable of text chunks suitable for SSE streaming.
 * 
 * @param {Object} params
 * @param {string} params.query - The original user query
 * @param {Object} params.evidence - Output of retrieval.retrieve()
 * @param {string} [params.strategistContext] - PETERMAYER-specific context
 * @param {Object} [params.waldoContext] - Account-level Waldo research
 * @param {Anthropic} params.client - Anthropic client
 */
export async function* synthesize({ query, evidence, strategistContext, waldoContext, client }) {
  // Build the evidence block the synthesis LLM will read
  const evidenceBlock = formatEvidence(evidence);
  
  let userMessage = `QUERY FROM PETERMAYER STRATEGIST:\n${query}\n\n`;
  userMessage += `QUERY INTENT (hint from the decomposer): ${evidence.spec.intent}\n\n`;
  
  if (strategistContext) {
    userMessage += `STRATEGIST CONTEXT (PETERMAYER-specific background):\n${strategistContext}\n\n`;
  }
  if (waldoContext) {
    userMessage += `ACCOUNT CONTEXT (Waldo research on the target account):\n${JSON.stringify(waldoContext, null, 2).slice(0, 2500)}\n\n`;
  }
  
  userMessage += `BJL EVIDENCE:\n${evidenceBlock}\n\n`;
  userMessage += `Write the response now. Match the intent, respect the voice rules, and stay tight.`;

  const stream = await client.messages.stream({
    model: SYNTHESIS_MODEL,
    max_tokens: 2000,
    system: SYNTHESIS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  for await (const chunk of stream) {
    if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
      yield chunk.delta.text;
    }
  }
}

/**
 * Format the retrieved evidence into a dense text block the synthesis LLM can read.
 */
function formatEvidence(evidence) {
  const parts = [];
  
  // Items - formatted by question type so the model reads each correctly
  if (evidence.items?.length) {
    parts.push("## ITEMS (ranked survey items relevant to the query)\n");
    parts.push("Each item below is labeled with its question_type. Read each type using the rules in the system prompt.\n");
    for (const item of evidence.items.slice(0, 15)) {
      const qtype = item.question_type || "unknown";
      const stype = item.scale_type ? `/${item.scale_type}` : "";
      const typeTag = `[${qtype}${stype}]`;
      const n = item.n ? `n=${item.n}` : "";
      const modes = item.joy_modes?.length ? `modes=[${item.joy_modes.join(",")}]` : "";
      const occ = item.occasions?.length ? `occasions=[${item.occasions.join(",")}]` : "";
      const qContext = item.question ? `context_question="${item.question}"` : "";

      // Stats formatted per question type. Only joy_scale gets a JI label.
      let stats;
      if (qtype === "joy_scale") {
        const ji = item.joy_index != null ? `JI=${item.joy_index}` : "JI=null";
        const pctMax = item.pct_max != null ? `pct_max=${item.pct_max}%` : "";
        const pctNeg = item.pct_negative != null ? `pct_negative=${item.pct_negative}%` : "";
        stats = [ji, pctMax, pctNeg].filter(Boolean).join(" | ");
      } else if (qtype === "ordinal_scale") {
        const top = item.top_response ? `top_response="${item.top_response}"` : "";
        const topPct = item.top_pct != null ? `top_pct=${item.top_pct}%` : "";
        const meanAgg = item.joy_index != null ? `aggregate_score=${item.joy_index} (NOT a Joy Index)` : "";
        stats = [top, topPct, meanAgg].filter(Boolean).join(" | ");
      } else if (qtype === "likelihood_scale") {
        const likelihood = item.joy_index != null ? `likelihood_score=${item.joy_index} (likelihood, NOT Joy Index)` : "";
        const top = item.top_response ? `top_response="${item.top_response}"` : "";
        const topPct = item.top_pct != null ? `top_pct=${item.top_pct}%` : "";
        stats = [likelihood, top, topPct].filter(Boolean).join(" | ");
      } else if (qtype === "familiarity_trust") {
        const score = item.joy_index != null ? `familiarity_score=${item.joy_index} (NOT Joy Index)` : "";
        const top = item.top_response ? `top_response="${item.top_response}"` : "";
        const topPct = item.top_pct != null ? `top_pct=${item.top_pct}%` : "";
        stats = [score, top, topPct].filter(Boolean).join(" | ");
      } else {
        const score = item.joy_index != null ? `score=${item.joy_index}` : "";
        stats = score;
      }

      parts.push(`- ${typeTag} "${item.item_name}" (${item.category}) | ${[stats, n, modes, occ, qContext].filter(Boolean).join(" | ")}`);
    }
    parts.push("");
  }
  
  // Verbatims
  if (evidence.verbatims?.length) {
    parts.push("## VERBATIMS (consumer voice, quotable)\n");
    for (const v of evidence.verbatims.slice(0, 10)) {
      const demo = [v.generation, v.gender, v.income_bracket, v.region]
        .filter(Boolean).join(", ");
      const themes = v.themes?.length ? ` [themes: ${v.themes.join(",")}]` : "";
      const modes = v.joy_modes?.length ? ` [modes: ${v.joy_modes.join(",")}]` : "";
      parts.push(`- "${v.response_text}" (${demo})${themes}${modes}`);
      if (v.question_text) parts.push(`    context: ${v.question_text}`);
    }
    parts.push("");
  }
  
  // Laws
  if (evidence.laws?.length) {
    parts.push("## LAWS (BJL framework principles that apply)\n");
    for (const law of evidence.laws.slice(0, 5)) {
      parts.push(`- **${law.law_id}: ${law.title}**`);
      parts.push(`  Statement: ${law.statement}`);
      if (law.evidence) parts.push(`  Evidence: ${law.evidence}`);
      if (law.implication) parts.push(`  Implication: ${law.implication}`);
    }
    parts.push("");
  }
  
  // Demo splits
  if (evidence.demo_splits?.length) {
    parts.push("## DEMOGRAPHIC SPLITS (meaningful gaps on relevant items)\n");
    for (const split of evidence.demo_splits.slice(0, 10)) {
      const gaps = [];
      if (split.gender_gap != null && Math.abs(split.gender_gap) >= 8) {
        const dir = split.gender_gap > 0 ? "F>M" : "M>F";
        gaps.push(`${dir} by ${Math.abs(split.gender_gap).toFixed(1)}`);
      }
      if (split.gen_z_vs_boomer != null && Math.abs(split.gen_z_vs_boomer) >= 10) {
        const dir = split.gen_z_vs_boomer > 0 ? "Gen Z>Boomer" : "Boomer>Gen Z";
        gaps.push(`${dir} by ${Math.abs(split.gen_z_vs_boomer).toFixed(1)}`);
      }
      if (split.income_gap != null && Math.abs(split.income_gap) >= 10) {
        const dir = split.income_gap > 0 ? "High>Low income" : "Low>High income";
        gaps.push(`${dir} by ${Math.abs(split.income_gap).toFixed(1)}`);
      }
      if (gaps.length) {
        parts.push(`- "${split.item_name}" (overall JI=${split.overall_ji}, n=${split.n_overall}): ${gaps.join("; ")}`);
      }
    }
    parts.push("");
  }
  
  if (parts.length === 0) {
    return "(No evidence was retrieved. Respond that BJL does not have data on this topic, and suggest the closest adjacent territory that might.)";
  }
  
  return parts.join("\n");
}
