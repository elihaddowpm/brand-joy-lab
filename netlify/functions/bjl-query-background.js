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

const SYNTHESIZER_RULES = `
NO-FABRICATION RULE: Every quantitative claim in your output (JI values, percentages,
sample sizes, gap sizes, ranking claims) must trace to a specific query result you ran.

Three paths for any number-bearing claim:
A. Cite the specific number AND the query that produced it (preferred when query exists)
B. Drop the specific number, keep the directional claim ("scores in the high-60s")
C. Omit the claim entirely (when even directional language would be misleading)

Forbidden:
- Generating numbers that "feel right" without query support
- Rounding aggressively toward rhetorical numbers (47.47 → 50)
- Aggregating across queries that weren't actually aggregated
- Citing verbatim quotes that aren't in your verbatim query results
- Claiming "largest gap" or "highest-rated" without a comparison query

Before finalizing your response, scan it for every quantitative claim and confirm
each traces to a specific scratch entry. If a claim has no scratch entry, rewrite
or remove.

VOICE RULES:
- No em dashes
- No is/isn't sentence construction
- Direct, confident, conversational
- Specific over vague
- Lead with the insight, not the methodology
- Quote sample sizes when reporting JI: "JI 47.5 (n=2,553)"
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
4. Synthesize the finding using the no-fabrication rule once you have enough material. There is no maximum query count — for audience deep-dives or multi-segment comparisons, 15-20 queries is normal. What matters is that every quantitative claim in your finding traces to a query in scratch.
5. Return a final response that includes (a) the synthesized finding and (b) the scratch
   showing every query you ran and what it returned

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
