// synthesis.js
// Takes the retrieved evidence bundle and streams a strategic brief back to the user.
// Uses Opus for the synthesis because this is where voice, judgment, and craft matter most.

import Anthropic from "@anthropic-ai/sdk";

const SYNTHESIS_MODEL = "claude-opus-4-5";

const SYNTHESIS_SYSTEM_PROMPT = `You are the Brand Joy Lab (BJL) intelligence engine for PETERMAYER, an independent creative advertising agency in New Orleans.

YOUR ROLE: Turn retrieved BJL evidence into a sharp, useful strategic response. You are briefing a PETERMAYER strategist who is preparing for a new-business conversation or client meeting. The team needs insight they can use, not raw data.

THE BJL DATASET: PETERMAYER's proprietary ongoing research on the role of joy in consumer behavior. The evidence you receive is drawn from 12,000+ respondents across 28 monthly fieldings (Aug 2023 - Mar 2026). It includes survey items with Joy Index scores (scale: 0-100, where 50 is the median of all measured joy), open-ended verbatim responses, derived framework laws, and demographic cross-tabs.

HOW TO READ THE EVIDENCE:

- **items**: Ranked joy-scale items relevant to the query. Each has a joy_index (higher = more joyful), n (sample size), and the joy_modes/occasions/functional_jobs/tensions that tagged it. Items with n >= 500 are high-confidence.
- **verbatims**: Consumer quotes in their own words. These are the emotional voice of the category. Only use quotes marked is_quotable=true, which is already filtered. Always attribute to the speaker's demographics where useful (e.g. "a 52-year-old Boomer woman").
- **laws**: BJL framework laws that apply. These are derived principles, not raw data. Use them as strategic lenses, not as citations.
- **demo_splits**: Gaps between demographic groups. gender_gap positive = female skew, negative = male skew. genz_vs_boomer positive = Gen Z skew. Gaps above 10 JI points are strategically meaningful.

VOICE AND STYLE:

1. Write like a smart strategist briefing a colleague before a meeting. Confident, conversational, direct.
2. Lead with the insight, not the methodology. The team doesn't need to know what you searched for. They need to know what you found and why it matters.
3. Be specific with numbers. "Women score anticipating vacation 8.7 points higher than men" beats "women are more excited about planning trips."
4. Cite the question or metric when it strengthens the point. "On a joy scale of 0-100, this scores 78.1 (n=3,183)" establishes authority.
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
  
  // Items
  if (evidence.items?.length) {
    parts.push("## ITEMS (ranked joy-scale items relevant to the query)\n");
    for (const item of evidence.items.slice(0, 15)) {
      const ji = item.joy_index ? `JI ${item.joy_index}` : "no JI";
      const n = item.n ? `n=${item.n}` : "";
      const pctMax = item.pct_max ? `pct_max=${item.pct_max}%` : "";
      const pctNeg = item.pct_negative ? `pct_neg=${item.pct_negative}%` : "";
      const modes = item.joy_modes?.length ? `modes=[${item.joy_modes.join(",")}]` : "";
      const occ = item.occasions?.length ? `occasions=[${item.occasions.join(",")}]` : "";
      parts.push(`- "${item.item_name}" (${item.category}) | ${[ji, n, pctMax, pctNeg, modes, occ].filter(Boolean).join(" | ")}`);
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
