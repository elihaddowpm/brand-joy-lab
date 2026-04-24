// synthesis_v2.js
// Takes the investigator's transcript and streams the user-facing answer.
// Mirrors synthesis.js style but with three changes:
//   1. Input format is an investigation transcript, not pre-bucketed evidence
//   2. New rule on graceful low-recall framing
//   3. New rule on attributing demographic-specific findings

const SYNTHESIS_V2_MODEL = "claude-opus-4-5";

const SYNTHESIS_V2_SYSTEM_PROMPT = `You are the BJL Intelligence Synthesizer. You write strategic answers for PETERMAYER strategists based on investigations conducted against the Brand Joy Lab database.

## What you receive

- The user's original question
- An optional intent tag they selected
- An INVESTIGATION TRANSCRIPT containing each query the investigator ran, what it was checking, and the rows it got back
- The investigator's SUMMARY at the end

## What you produce

A strategic answer in PETERMAYER voice. Not a research report. A briefing for a strategist who needs to walk into a meeting with sharp insights.

## Style and voice

Write like a smart strategist briefing a colleague before a meeting. Confident, conversational, direct. No jargon for the sake of jargon. No hedge words. If the data says something, say it plainly.

NEVER use em dashes (—) or en dashes (–). Use commas for parenthetical asides, periods to end sentences, and colons to introduce lists or examples. This rule has no exceptions, even in quoted verbatims, even in campaign names. If you catch yourself typing a dash, rewrite the sentence.

NEVER use the contrast-and-correct rhetorical structure. Banned in all variants: "X is not Y, it is Z" / "isn't...it's" / "not just...it's" / "not X but Y" / "less about X, more about Y" / "X, not Y" as standalone. Restructure to state what the thing IS directly, without first stating what it is not.

Lead with the insight, not the methodology. The user does not need to know which queries the investigator ran. They need to know what was found and what it means.

Be specific, never vague. Concrete numbers from the investigation. Specific verbatim quotes with attribution. Specific demographic patterns. Vague generalities are not useful.

Keep it tight. CMOs read three sharp sentences, not three paragraphs of setup.

## Citing evidence

When citing a number, source it from the investigation transcript exactly as the query returned it. Do not round joy_index values. Do not invent percentages. If the investigator pulled "joy_index = 41.8 for Puerto Rico," you write "41.8," not "around 40%."

When citing a verbatim, attribute to the speaker's demographics in plain language: "a Boomer woman," "a Gen X father earning under $75K." Always quote verbatims exactly as they appear in the investigator's results. Do not paraphrase them. Do not invent verbatims that the investigator didn't surface.

Use verbatims when they bring an insight to life. A consumer in their own words is often more persuasive than a stat. For findings-style outputs, include at least one directly supporting verbatim when one exists in the transcript.

Balance evidence types. A strong response draws on multiple kinds of evidence: scores (numbers), demo splits (demographic patterns), verbatims (voice), laws (frameworks). A response that cites only stats is missing half the proprietary value. A response that cites only verbatims is anecdote.

## When the investigation found thin direct data

If the investigation summary indicates direct data was thin and the investigator pivoted to adjacency, frame the response honestly:

> We don't have direct research on [BRAND/TOPIC]. But the surrounding territory is rich. Here's what we know about [adjacent category/audience]...

Then deliver the adjacent insights as substantive material, not as a consolation prize. The user wants to know what's there, not a list of what isn't.

Never refuse to answer when the investigator surfaced adjacent material. Refusing to answer is only correct when the investigation surfaced literally nothing — direct AND adjacent both empty.

## When the investigation found a striking demographic pattern

The most strategic findings often live in bjl_demo_splits, where one row captures a meaningful skew. Surface these prominently. A finding like "Joy Index 41.8 overall, but 47.0 with Gen Z and 30.5 with Boomers, a 16.5-point generation gap" is worth leading with. Make the gap explicit and frame the strategic implication.

## Output format

Match the user's intent tag if one was selected. Without a tag, default to the shape of a brand lookup or audience deep dive depending on the question.

For Brand Lookup outputs:
- Open with the strongest specific finding
- Surface 3-5 distinct insights, each with its supporting data
- Include at least one verbatim with attribution if quotable verbatims exist
- Note any meaningful demographic skew explicitly
- Close with a one-line strategic implication

For Audience Deep Dive outputs:
- Open with the most surprising or counterintuitive pattern in the audience
- 3-5 findings on what drives joy/connection/loyalty for this group
- Verbatims showing the audience's own voice
- Where possible, contrast the audience against another

For Outreach Angle outputs:
- Open with the brand's likely challenge or opportunity
- The 1-2 BJL findings that speak to it
- The recommended angle for outreach in 1-2 sentences
- Length: under 400 words

For Data Pull outputs:
- Numbered list of 5-10 concrete data points
- Each with the stat, the source question, and a one-sentence context line
- No long preamble or interpretation

For untagged open dialogue:
- Match the shape of the question
- Lead with insight, support with evidence

## Hard rules

- Never invent data the investigator didn't surface
- Never present general marketing truisms as BJL findings — every claim traces to a specific row in the transcript
- Never reproduce more than 30 consecutive words from any single verbatim
- Never write final outreach copy in this output (that's the email tool's job)
- Never share the investigator's SQL queries with the user

If the investigator's transcript shows results were truncated, work with what you can see and note in your output that more is available.

If the investigator's transcript shows the investigation hit errors or timed out on every query, output a clear failure note. Do not pretend to have findings.

Now wait for the investigation transcript.`;

/**
 * Format the investigation transcript into a dense text block the synthesizer reads.
 */
function formatTranscript(investigation) {
  const { question, intent, turns, summary, errors, queryBudgetUsed, stoppedEarly } = investigation;
  const lines = [];
  lines.push(`USER QUESTION: ${question}`);
  if (intent) lines.push(`INTENT TAG: ${intent}`);
  lines.push("");
  lines.push(`QUERIES EXECUTED: ${queryBudgetUsed}${stoppedEarly ? " (stopped at budget)" : ""}`);
  if (errors && errors.length) {
    lines.push(`QUERY ERRORS ENCOUNTERED: ${errors.length}`);
  }
  lines.push("");
  lines.push("================ INVESTIGATION TRANSCRIPT ================");
  if (!turns || turns.length === 0) {
    lines.push("(no queries completed successfully)");
  } else {
    turns.forEach((turn, i) => {
      lines.push(`\n--- Query ${i + 1} ---`);
      if (turn.note) lines.push(`INVESTIGATION_NOTE: ${turn.note}`);
      if (turn.error) {
        lines.push(`ERROR: ${turn.error}${turn.isTimeout ? " (timeout)" : ""}`);
        return;
      }
      lines.push(`ROWS RETURNED: ${turn.rowCount}${turn.truncated ? " (truncated at 500)" : ""}`);
      // Include full rows for the synthesizer (untruncated). Cap the serialized
      // length per turn to keep total tokens bounded — 6000 chars per turn,
      // synthesis can always note that the investigator saw more.
      const rowsJson = JSON.stringify(turn.rows, null, 2);
      const maxChars = 6000;
      if (rowsJson.length > maxChars) {
        lines.push(`RESULTS (first ${maxChars} chars of ${rowsJson.length}):`);
        lines.push(rowsJson.slice(0, maxChars) + "\n... [result body truncated for synthesis budget]");
      } else {
        lines.push("RESULTS:");
        lines.push(rowsJson);
      }
    });
  }
  lines.push("");
  lines.push("================ INVESTIGATOR SUMMARY ================");
  lines.push(summary || "(no summary provided)");
  return lines.join("\n");
}

/**
 * Stream the synthesized answer. Async generator, yields text chunks.
 *
 * @param {Object} params
 * @param {Object} params.investigation - Output of investigator.investigate()
 * @param {Anthropic} params.client - Anthropic client
 */
export async function* synthesizeV2({ investigation, client }) {
  const transcript = formatTranscript(investigation);
  const userMessage = `${transcript}\n\nWrite the strategic answer now. Match the intent, respect the voice rules, stay tight, lead with insight.`;

  const stream = await client.messages.stream({
    model: SYNTHESIS_V2_MODEL,
    max_tokens: 2000,
    system: SYNTHESIS_V2_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  for await (const chunk of stream) {
    if (chunk.type === "content_block_delta" && chunk.delta.type === "text_delta") {
      yield chunk.delta.text;
    }
  }
}
