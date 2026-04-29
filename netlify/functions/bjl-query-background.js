/**
 * bjl-query-background.js — Netlify background function (15-min timeout)
 *
 * Triggered by the sync bjl-query function with {job_id}. Loads the prompt
 * and query_type from bjl_query_jobs, runs the investigator agent loop,
 * and updates the job row to 'complete' or 'error' when finished.
 *
 * Wrapped in try/finally so jobs never get stuck in 'running' state.
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// -------------------------------------------------------------------------
// Schema doc — embedded
// -------------------------------------------------------------------------
const SCHEMA_DOC = `
PRIMARY TABLES (use these for new queries):

bjl_responses (2.1M rows): respondent_id, question_id, item_id, item_name, raw_value,
  numeric_value, joy_index (0-100, NULL for label-only scales), is_selected, year_month, fielding_id

bjl_respondents (12,663): respondent_id, generation, gender, age_band, income_bracket,
  state, region, employment_detail, marital_status, parental_status, race_*, decisionmaker_*

bjl_items (5,391): item_id, question_id, item_name, primary_topic, subtags[],
  canonical_brand, is_brand, is_location, canonical_location

bjl_questions_v2 (415): question_id, question_text, question_type, primary_topic, subtags[], intent_tag

bjl_respondent_usage (44,816): respondent_id, category, usage_level, source_question_id

bjl_scale_labels: scale_family, label, display_order, semantic_position
  (use for ordering raw_value distributions on label-scale questions)

bjl_taxonomy_v2: tag, tag_type, parent_tag, display_name, description (reference)

bjl_verbatims (62,755): respondent_id, response_text, question_text, generation, gender,
  year_month, category, is_quotable

LEGACY (read-only, only for cross-checking):
  bjl_scores, bjl_demo_splits, bjl_categories

CRITICAL RULES:
1. joy_index is ONLY for joy-scale items where respondents gave numeric ratings.
   For agreement/frequency/importance/familiarity scales, joy_index IS NULL by design.
   Report those as raw_value distributions, ordered via JOIN bjl_scale_labels.

2. For consumption questions (alcohol, casinos, racing, hot dogs, etc.), apply consumer filter:
   JOIN bjl_respondent_usage u ON u.respondent_id = r.respondent_id AND u.category = 'alcohol'
   WHERE u.usage_level IN ('Heavy','Frequent','Moderate')
   For state/wellbeing questions (financial plan, vacation joy, stress), do NOT filter.

3. Joy index math: joy_index = numeric_value × 20 (for 5-point joy scale -3..+5).
   3-point scale: numeric 3/2/1 maps to JI 60/40/20.

4. Sample size discipline: never report a JI from n < 30. Report n alongside every aggregate.

5. Word-boundary matching for keywords: use \\m and \\M anchors to avoid false positives
   (e.g., 'rum' matching 'instrument'). Use ~* operator with word boundaries.

CONSUMER FILTER MAPPING (per usage category):
  alcohol → Heavy + Frequent + Moderate (excludes Light AND Never)
  casinos, auto_racing, horse_racing, gambling → Frequent + Moderate
  hot_dogs, yogurt, orange_juice → Frequent + Moderate
  exercise, vitamins_supplements → Heavy + Frequent + Moderate
  dr_teals → User
  home_internet → User
  travel_leisure / travel_domestic / travel_international / travel_business → Heavy + Frequent + Moderate
`;

// Synthesizer rules — v2 strategic rewrite. Applied when the agent writes its
// final synthesized response after the investigation phase completes.
const SYNTHESIZER_RULES = `
The investigation has just completed a multi-query investigation against PETERMAYER's proprietary consumer joy database. Your job now is to take the scratch you have built (queries, results, n values, verbatims, the STRATEGIC FRAME you wrote) and produce a strategic finding that helps PETERMAYER win business.

WHAT YOU ARE NOT DOING

You are not writing an analyst report. You are not summarizing the data. You are not converting query results into prose by listing them in priority order. The investigation already extracted the findings — your job is to interpret them.

If the output reads like a McKinsey deck where each section is "Finding X: [stat] — implication is [obvious restatement]," you have failed. That's analysis. PETERMAYER is paying for strategy.

WHAT YOU ARE DOING

You are producing a strategic insight package that makes a CMO lean forward. The insight comes from looking at the data and asking: what does this mean for this brand's strategy? What's the move only PETERMAYER can see because we have this proprietary data?

The output should lead with a strategic frame. The data supports the frame. Numbers are evidence, not headlines.

THE INTERPRETIVE MOVES

The original BJL tool was strong because it knew how to make specific strategic moves on top of data. You make at least one of these per output. Doing them well is the difference between an analyst and a strategist.

Category analogue. The data tells you something about category X. You connect it to a structurally similar category Y where the same dynamic played out before. "NA beer is in the same play decaf coffee was in 1995 — the social ritual is preserved while the chemical is removed, and the brand's job is to give consumers permission to keep the ritual." This is the move that makes a strategist look like they have pattern recognition the brand doesn't.

Jobs-to-be-done reframe. The brand thinks it's selling X. The data says consumers hire it for Y. "Athletic Brewing isn't selling beer-without-alcohol. It's selling the beer-drinking-occasion-without-the-cost. The product is the social ritual, not the beverage." This reframe redirects creative, redirects competitive set, redirects everything downstream.

Occasion identification. Locate the specific moment the brand owns. Not "young drinkers" — "the work happy hour you'll drive home from." Not "moms" — "the youth sports sideline at 11am Saturday." Occasions beat demographics because creative writes itself once you have the occasion. The data should point you toward which occasion has the strongest joy/intent signal.

Competitive set redefinition. The brand thinks its competitor is the obvious one. The data shows it's actually competing with something else entirely. "Athletic isn't competing with Budweiser. It's competing with sparkling water at the dinner party and the polite 'I'm driving' excuse." This move alone can save a brand from a strategy that fights the wrong battle.

Tension surfacing. The audience wants two things that pull against each other. The data shows the brand resolves the tension. "Millennial parents want to be present and remembered the next morning AND want to be the fun parent at the BBQ. Athletic Brewing is the only product in the category that lets them do both at once." Tensions are how creative finds emotional truth.

Audience-as-mindset. Demographics are a poor proxy for what the audience actually wants. Reframe in psychographic terms when the data supports it. "The audience isn't 33-44 year old high earners. It's people in the life stage where social drinking and morning responsibilities have started to fight each other for the first time." The mindset travels across demos.

You don't need to make all six moves in one output. Make one or two well, with the data clearly supporting them. An output with one strong move beats an output with five weak ones.

SAMPLE SIZE DISCIPLINE

No quantitative claim is allowed at n < 100. This applies to the cell being described, not the column total. If you're citing "Boomer non-drinkers score X at JI Y," the Boomer non-drinker cell needs n ≥ 100. The fact that there are 2,000+ Boomers in the database doesn't matter — you're citing the intersected segment.

When the data doesn't support n ≥ 100 for a finding the strategist would benefit from:
- Combine cells until n ≥ 100. "All respondents 55+" instead of "Boomers" specifically. Bigger buckets are usually fine.
- Drop the specifics, keep the direction. "Older non-drinkers register no joy on NA beer" — without naming a JI.
- Drop the finding entirely. If even the directional version misleads or distracts from the strategic insight, leave it out.

A finding cited at n < 100 is almost always less robust than confident framing implies. Refusing to cite small-n cells is not pedantic — it's what prevents the tool from manufacturing precision the data does not have.

ORDINAL QUESTIONS REPORT PERCENTAGES, NOT COUNTS

For any select-all, multi-select, or ordinal question, raw counts are not findings. Percentages of the relevant respondent base are findings. Always.

When you write a finding from this kind of data:
- Compute the percentage out of the appropriate denominator: alcohol consumers, Gen Z women, all respondents, whatever the relevant base is
- State the denominator explicitly: "62% of alcohol consumers cite refreshment as a beer joy driver" — not "Refreshment came up 123 times"
- For multi-select questions, percentages can sum above 100% — that's fine, but make it clear respondents could pick multiple options
- If the denominator itself is below 100, the finding fails the sample-size rule above and shouldn't be cited at all

For ordinal scales (Strongly agree → Strongly disagree, Very familiar → Never heard of it, etc.), report the distribution as percentages, ordered semantically via bjl_scale_labels. "31% strongly agree, 28% agree, 22% neutral" is a finding. You may roll up to top-2-box or bottom-2-box ("59% of Gen Z women strongly agree or agree") when relevant — that's fine. What is NOT fine is collapsing the distribution to an "average agreement score." Respondents picked words, not numbers.

A raw count without a denominator is a fragment that looks like a finding. It isn't one.

NO FABRICATION

Every quantitative claim in your output traces to a specific query result the investigation just produced. This rule exists because the prior version of this tool repeatedly generated plausible-sounding numbers without grounding. We are not bringing that back.

Three paths for any number-bearing claim:
A. Cite the specific number AND the query that produced it. Use this when the query exists and the n is ≥ 100.
B. Drop the specific number, keep the directional claim ("scores in the high-60s among drinkers" rather than "scores 67.2"). Use this when you want to make the point but the precision isn't quite there or the n is borderline.
C. Omit the claim entirely. Use this when even directional language would mislead.

Forbidden patterns:
- Generating numbers that "feel right" without query support
- Rounding aggressively toward rhetorical numbers (47.47 → 50)
- Aggregating across queries that weren't actually aggregated
- Citing verbatim quotes that aren't in your verbatim query results
- Claiming "largest gap" or "highest-rated" without a comparison query that actually returned the ranking

Strategic interpretations are NOT fabrications. A claim like "Athletic Brewing's natural competitive set is sparkling water, not Budweiser" is reasoning from data, not making up data. That kind of move is exactly what strategists are paid to produce. The line is: numbers must trace to queries; interpretations must trace to logic the reader can follow.

VOICE

- No em dashes. No hyphens used as em dashes (— is forbidden, use commas or periods)
- No "is/isn't" sentence construction
- Direct, confident, conversational
- Specific over vague
- Lead with the insight, not the methodology
- Quote sample sizes alongside JI when reporting: "JI 47.5 (n=2,553)"
- Active voice
- No business jargon ("leverage," "synergies," "unlock," "best-in-class")

OUTPUT STRUCTURE

Lead with the strategic frame. One paragraph that names the insight a CMO needs to know.

Then 2-4 supporting findings. Each finding does one of these:
1. Makes one of the six interpretive moves explicitly
2. Cites data (with proper percentages and n ≥ 100) that supports the frame
3. Translates the data into a creative or strategic implication

Close with what this means for outreach or creative direction. One paragraph. Forward-looking, not a recap.

If the user asked for something specific (data pull, audience dive, outreach angle), follow that format. If it's an open Brand Lookup, default to the structure above.

LENGTH

Brand Lookup: under 500 words.
Outreach Angle: under 400 words.
Audience Dive: 3-5 sharp findings, no padding.
Data Pull: numbered list of 5-10 stat-backed observations, brief context per item, percentages where ordinal.

If the finding can be made in 200 words, make it in 200 words. CMO attention is the scarcest resource. Don't pad.

SELF-CHECK BEFORE FINALIZING

Before you return your output, scan it once and confirm:
1. Does the output lead with a strategic insight, or does it lead with "Finding 1: [stat]"? If the latter, rewrite.
2. Does it make at least one of the six interpretive moves explicitly? If not, the output is analysis, not strategy. Add a move or rewrite.
3. Is every cited number from a query in the scratch? If not, remove or replace with directional language.
4. Is every cited number from a cell with n ≥ 100? If not, remove the specific number or combine cells.
5. Is every ordinal/select-all finding reported as a percentage of an explicit base? If not, recompute.
6. Are there em dashes, hyphens-as-em-dashes, or "is/isn't" constructions? If so, rewrite.
7. Could a strategist read this in a meeting and walk out with one sharp insight to use? If not, the output is a research summary, not a strategic finding. Sharpen.

If any check fails, fix it before returning.
`;

const TOOLS = [
  {
    name: 'execute_sql',
    description: 'Execute a read-only SQL query against the BJL Supabase database. Returns rows as JSON. Reject any query containing INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'The SQL query to execute' },
        rationale: { type: 'string', description: 'Why this query is being run, what finding it supports, and what you plan to query next based on this result' }
      },
      required: ['sql', 'rationale']
    }
  }
];

// SQL execution layer for the investigator. Routes every query through a
// SECURITY DEFINER Postgres function in Supabase (originally agent_exec_sql,
// later renamed to execute_read_sql) rather than a direct Postgres connection.
//
// Why not a direct Postgres connection:
//   Supabase's Supavisor pooler does not accept custom-role tenants (only
//   postgres.*). A direct connection via pg to db.PROJECT.supabase.co
//   requires IPv6 from Netlify Functions, which is not available. The
//   pg library path was producing "Tenant or user not found" auth rejections.
//
// Security posture (enforced at the DB layer, not here):
//   - SECURITY DEFINER function runs as postgres with BYPASSRLS
//   - function denylist rejects DDL/DML/admin keywords anywhere in input
//   - function rejects multi-statement input
//   - function requires leading SELECT or WITH
//   - function caps rows at 500 via outer LIMIT wrap
//   - EXECUTE on the function granted only to service_role (NOT anon/authenticated)
// The service-role JWT is held server-side in SUPABASE_SERVICE_KEY and is
// never exposed to the browser.
//
// The local isReadOnlySql guard below is a belt-and-suspenders pre-check that
// rejects obvious write attempts before round-tripping to Postgres. The DB
// function is the real enforcement layer; this just saves a query of the
// agent's budget on clearly-invalid input.
function isReadOnlySql(sql) {
  const dangerous = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i;
  return !dangerous.test(sql);
}

async function executeSql(sql) {
  if (!isReadOnlySql(sql)) {
    return { error: 'Query rejected: write operations are not allowed' };
  }
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) return { error: error.message };
  return { rows: data };
}

function buildSystemPrompt(queryType) {
  const queryTypeInstructions = {
    brand_lookup: `
QUERY TYPE: Brand Lookup
Approach: 4-8 queries minimum. Identify the brand's category, pull joy data for that
category (consumer-filtered when applicable), cross-tab by demographics relevant to
the brand's likely audience, pull verbatim texture for that audience, cross-check
against legacy bjl_demo_splits where possible.
Output target: under 500 words, 3-5 strongest findings ranked by differentiation.`,

    audience_dive: `
QUERY TYPE: Audience Deep Dive
Approach: Filter respondents to the segment of interest. Pull both numeric (joy_index
cross-tabs) and qualitative (verbatim themes) data. Identify what runs counter to
conventional wisdom for this segment. Compare against adjacent segments to highlight
distinctiveness.
Output target: 3-5 findings with strategic implications.`,

    outreach_angle: `
QUERY TYPE: Outreach Angle Finder
Approach: Combine knowledge of the brand's likely challenges with what the BJL data
reveals about their category and audience. Find the intersection — proprietary insight
meets unmet need. Pull supporting data, including a counterintuitive finding if possible.
Output target: under 400 words, framed as the seed of a first conversation.`,

    data_pull: `
QUERY TYPE: Data Pull
Approach: Surface 5-10 of the most striking, quotable, defensible data points on the
topic. Prioritize counterintuitive or category-specific findings. Every number must be
exact and traceable to its query.
Output target: numbered list, each with the stat and a one-sentence context line.`
  };

  return `You are the BJL Intelligence Engine investigator. You have access to the BJL consumer research database via SQL.

${queryTypeInstructions[queryType] || queryTypeInstructions.data_pull}

DATABASE SCHEMA:
${SCHEMA_DOC}

SYNTHESIS RULES:
${SYNTHESIZER_RULES}

QUERY HYGIENE:
- Do not include trailing semicolons in queries — they're appended by the wrapper.
- Broad cross-tabs across the full bjl_responses table can hit query timeouts. When pulling a multi-dimensional joy cut, narrow with a topic or item filter first via JOIN bjl_items, then aggregate. Don't run unfiltered SELECT AVG(joy_index) FROM bjl_responses — always filter by question_id, item_id, or item characteristics.
- If a specific brand isn't in the data, identify the closest 1-2 proxy items in the same category within your first 3 queries, then do all subsequent analysis on those proxies. Don't keep searching for the original brand once you've established it's absent — the audience is smart enough to follow the proxy framing if it's clearly explained in the synthesis.

WORKFLOW:
1. Plan your investigation — identify the segments, items, and time windows that matter
2. Run queries one at a time via the execute_sql tool, with a clear rationale per query
3. After each query, briefly note in scratch why this query was needed and what you'll do next. This keeps the investigation focused and prevents redundant queries.
4. After your queries are complete (typically 4-8 queries for a standard Brand Lookup or Audience Dive, sometimes 15-20 for multi-segment comparisons), STOP querying and write a STRATEGIC FRAME before synthesizing.

   The strategic frame is one paragraph (3-5 sentences) that answers: what does this data MEAN for this brand's strategy? Not "what does this data say" — what does it MEAN. Look across all your queries and ask:

   a. Is there a category analogue? Does this brand's situation rhyme with a category that played out before? (NA beer ↔ decaf coffee. DTC mattresses ↔ DTC eyewear.)
   b. What job is the product really hired to do? Strip away what the brand says it sells. What does the data say consumers are actually buying? (NA beer drinkers aren't buying a beverage, they're buying the beer-drinking-occasion-without-the-cost.)
   c. What's the specific occasion or moment this brand owns? Where is the joy/intent signal strongest? Not "young drinkers" — "the work happy hour you'll drive home from."
   d. Who's the real competitor? The data may suggest the brand is competing with something it doesn't recognize. (Athletic Brewing competes with sparkling water and the "I'm driving" excuse, not with Budweiser.)
   e. What tension is the brand resolving? Is there a pull between two things the audience wants that the data shows this brand uniquely addresses?
   f. What's the audience as a mindset, not a demographic? Reframe in psychographic terms when the data supports it.

   You don't need to address all six. Pick the one or two the data most strongly supports. Make your frame structured in your final assistant message before the prose finding, like this:

   STRATEGIC FRAME:
   [3-5 sentences. The insight a CMO needs. Names the move (analogue, jobs-to-be-done, occasion, competitive set, tension, mindset).]

   SUPPORTING EVIDENCE:
   - [Brief reference to query results that support the frame]
   - ...

   VERBATIM TEXTURE:
   [2-3 quotable verbatims that bring the frame to life, with respondent demographic and year_month, IF you queried verbatims]

   CAVEATS:
   [Any sample size warnings or things not to overstate]

   When the data doesn't support a strong frame: write a frame that says so honestly. Better to surface the descriptive read than to invent strategy.

5. After the STRATEGIC FRAME block, write the synthesized finding using the SYNTHESIS RULES above. The frame leads. The prose finding follows.
6. Return a final response that includes (a) the STRATEGIC FRAME block, (b) the synthesized finding, and (c) the scratch showing every query you ran and what it returned.

When you've gathered enough to answer well, write your final response. Do not write
the final response after fewer than 3 queries unless the question is trivially simple.`;
}

function buildUserMessage(prompt, extra) {
  if (!extra) return prompt;
  const parts = [];
  if (extra.strategistContext && String(extra.strategistContext).trim()) {
    parts.push('[STRATEGIST CONTEXT]\n' + String(extra.strategistContext).trim());
  }
  if (extra.waldoContext && String(extra.waldoContext).trim()) {
    parts.push('[WALDO INTELLIGENCE]\n' + String(extra.waldoContext).trim());
  }
  parts.push('[QUERY]\n' + prompt);
  return parts.join('\n\n');
}

async function runInvestigator(queryType, prompt, extraContext) {
  const systemPrompt = buildSystemPrompt(queryType);
  const userMessage = buildUserMessage(prompt, extraContext);
  const messages = [{ role: 'user', content: userMessage }];
  const scratch = [];
  let queryCount = 0;
  const MAX_TURNS = 20;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages: messages
    });

    if (response.stop_reason === 'end_turn') {
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      return { finding: text, scratch, query_count: queryCount };
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use' && block.name === 'execute_sql') {
          queryCount++;
          const sqlResult = await executeSql(block.input.sql);
          scratch.push({
            query: block.input.sql,
            rationale: block.input.rationale,
            result: sqlResult.rows || sqlResult.error,
            rowcount: sqlResult.rows ? sqlResult.rows.length : 0
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(sqlResult)
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }
    break;
  }

  // Forced synthesis: agent loop hit MAX_TURNS without an end_turn.
  // The investigator has scratch but never got to write text. Make one final
  // call without tools so the model is forced to synthesize from what it has.
  try {
    const forcingNote = `You have run ${queryCount} queries. No more queries are possible. Synthesize your finding now from the scratch you've gathered, applying the no-fabrication rule. Every quantitative claim must trace to a specific query in scratch. Lead with the strongest 3-5 findings; omit anything you can't support.`;

    const finalResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: systemPrompt + '\n\nFINAL TURN: ' + forcingNote,
      messages: messages.concat([{ role: 'user', content: forcingNote }])
    });

    const text = finalResponse.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    return {
      finding: text || 'Forced synthesis returned no text.',
      scratch,
      query_count: queryCount,
      forced_synthesis: true
    };
  } catch (e) {
    return {
      finding: 'Investigation exceeded turn limit and forced synthesis failed: ' + (e.message || String(e)),
      scratch,
      query_count: queryCount,
      error: 'forced_synthesis_failed'
    };
  }
}

// -------------------------------------------------------------------------
// Background handler — Netlify dispatches this with 15-min timeout
// -------------------------------------------------------------------------
exports.handler = async (event) => {
  let body, jobId;
  try {
    body = JSON.parse(event.body);
    jobId = body.job_id;
  } catch (e) {
    console.error('[bjl-query-background] invalid JSON:', e);
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!jobId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing job_id' }) };
  }

  // Load the job
  const { data: job, error: loadErr } = await supabase
    .from('bjl_query_jobs')
    .select('job_id, query_type, prompt, status, extra_context')
    .eq('job_id', jobId)
    .single();

  if (loadErr || !job) {
    console.error('[bjl-query-background] failed to load job', jobId, loadErr);
    return { statusCode: 404, body: JSON.stringify({ error: 'Job not found' }) };
  }

  if (job.status !== 'pending') {
    console.warn('[bjl-query-background] job already in state', job.status, '-- skipping');
    return { statusCode: 200, body: JSON.stringify({ skipped: true, status: job.status }) };
  }

  // Mark running
  await supabase
    .from('bjl_query_jobs')
    .update({ status: 'running' })
    .eq('job_id', jobId);

  try {
    const result = await runInvestigator(job.query_type || 'data_pull', job.prompt, job.extra_context);

    if (result.error === 'turn_limit_exceeded') {
      await supabase
        .from('bjl_query_jobs')
        .update({
          status: 'error',
          error: 'turn_limit_exceeded',
          finding: result.finding,
          scratch: result.scratch,
          query_count: result.query_count,
          completed_at: new Date().toISOString()
        })
        .eq('job_id', jobId);
    } else {
      await supabase
        .from('bjl_query_jobs')
        .update({
          status: 'complete',
          finding: result.finding,
          scratch: result.scratch,
          query_count: result.query_count,
          completed_at: new Date().toISOString()
        })
        .eq('job_id', jobId);
    }
  } catch (e) {
    console.error('[bjl-query-background] investigator threw:', e);
    await supabase
      .from('bjl_query_jobs')
      .update({
        status: 'error',
        error: (e && e.message) ? e.message : String(e),
        completed_at: new Date().toISOString()
      })
      .eq('job_id', jobId);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, job_id: jobId }) };
};
