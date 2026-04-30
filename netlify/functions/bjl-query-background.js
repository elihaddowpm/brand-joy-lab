/**
 * bjl-query-background.js — Netlify background function (15-min timeout)
 *
 * Three-stage pipeline:
 *   1. Triage (Haiku 4.5) — reads question + prior conversation, produces
 *      a structured brief with depth, posture, length, and free-text guidance.
 *   2. Investigation (Sonnet 4.6) — writes SQL queries scoped to triage's
 *      depth budget; honors triage's investigator_brief.
 *   3. Synthesis (Sonnet 4.6) — writes the response calibrated to triage's
 *      posture and length; emits {response_text, followup_chips}.
 *
 * Bypass paths (no investigation runs):
 *   - triage.needs_clarification → write clarifying_question, set status to
 *     'clarification_needed', exit.
 *   - triage.early_exit → write triage.early_exit_response as finding, set
 *     status to 'complete', exit.
 *
 * Triggered by the sync bjl-query function with {job_id}. Loads the prompt,
 * query_type, and prior_conversation_context from bjl_query_jobs, runs the
 * three-stage pipeline, and updates the job row to 'complete', 'error', or
 * 'clarification_needed' when finished.
 *
 * Wrapped in try/catch so jobs never get stuck in 'running' state.
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-6';

// Investigation depth -> max turns mapping. Each successful query is one turn;
// turn budget includes overhead for tool result + final synthesis.
const DEPTH_TO_MAX_TURNS = {
  none: 0,
  minimal: 4,    // 1-2 queries
  focused: 10,   // 3-5 queries
  thorough: 20   // 6-10 queries
};

// -------------------------------------------------------------------------
// Load prompts and schema doc — bundled as a JSON sibling
// -------------------------------------------------------------------------
// _prompts_bundle.json is generated from prompts/*.md and docs/schema_doc.md
// by bin/build_prompts_bundle.js. esbuild inlines JSON requires into the
// function bundle, which sidesteps Netlify's included_files mechanism (which
// doesn't reliably include non-JS files when node_bundler = "esbuild").
//
// Run `node bin/build_prompts_bundle.js` from the repo root before each
// deploy if the .md sources have changed.
const PROMPTS = require('./_prompts_bundle.json');

console.log('[bjl-query-background] prompts bundle loaded:');
console.log('  triage_prompt.md       ', PROMPTS.triage.length, 'chars');
console.log('  investigator_v3.md     ', PROMPTS.investigator.length, 'chars');
console.log('  synthesizer_v3.md      ', PROMPTS.synthesizer.length, 'chars');
console.log('  schema_doc.md          ', PROMPTS.schemaDoc.length, 'chars');
console.log('  schema_doc.md head[200]:', PROMPTS.schemaDoc.slice(0, 200).replace(/\n/g, ' | '));

const TRIAGE_PROMPT_GET            = () => PROMPTS.triage;
const INVESTIGATOR_PROMPT_BASE_GET = () => PROMPTS.investigator;
const SYNTHESIZER_PROMPT_BASE_GET  = () => PROMPTS.synthesizer;
const SCHEMA_DOC_GET               = () => PROMPTS.schemaDoc;

// -------------------------------------------------------------------------
// Tools available to the investigator
// -------------------------------------------------------------------------
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
  // Strip trailing semicolon — the wrapper appends its own and a double
  // semicolon trips the multi-statement guard in the SECURITY DEFINER fn.
  const cleaned = String(sql).replace(/;\s*$/, '').trim();
  if (!isReadOnlySql(cleaned)) {
    return { error: 'Query rejected: write operations are not allowed' };
  }
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: cleaned });
  if (error) return { error: error.message };
  return { rows: data };
}

// -------------------------------------------------------------------------
// Stage 1: Triage (Haiku 4.5)
// -------------------------------------------------------------------------
// Returns a parsed brief object. On JSON parse failure, falls back to
// safe-default 'focused' depth so the system never wedges on a malformed
// brief.
async function runTriage(question, priorContext, extraContext) {
  const contextParts = [];
  if (priorContext && Array.isArray(priorContext) && priorContext.length > 0) {
    contextParts.push('Prior conversation:\n' + JSON.stringify(priorContext, null, 2));
  }
  if (extraContext && extraContext.strategistContext && String(extraContext.strategistContext).trim()) {
    contextParts.push('Strategist context:\n' + String(extraContext.strategistContext).trim());
  }
  if (extraContext && extraContext.waldoContext) {
    const wc = typeof extraContext.waldoContext === 'string'
      ? extraContext.waldoContext
      : JSON.stringify(extraContext.waldoContext).slice(0, 2000);
    contextParts.push('Account intelligence (Waldo):\n' + wc);
  }
  contextParts.push('Current user question:\n' + question);

  const userMessage = contextParts.join('\n\n');

  const response = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1500,
    system: TRIAGE_PROMPT_GET(),
    messages: [{ role: 'user', content: userMessage }]
  });

  let raw = (response.content[0] && response.content[0].text) ? response.content[0].text.trim() : '';
  // Haiku occasionally wraps in code fences despite being told not to.
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('[triage] JSON parse failed:', e.message, 'raw[0..200]:', raw.slice(0, 200));
    // Fail open: focused depth, interpretive posture, medium length.
    // The investigator+synthesizer downstream will still produce a defensible
    // response; the user just doesn't get the proportionality benefit.
    return {
      the_question: question,
      investigation_depth: 'focused',
      response_posture: 'interpretive',
      response_length: 'medium',
      investigator_brief: 'Triage JSON parse failed. Apply default focused investigation.',
      followup_seeds: [],
      needs_clarification: false,
      clarifying_question: null,
      early_exit: false,
      early_exit_response: null
    };
  }
}

// -------------------------------------------------------------------------
// Stage 2: Investigation (Sonnet 4.6)
// -------------------------------------------------------------------------
function buildInvestigatorSystemPrompt(triage) {
  return `${INVESTIGATOR_PROMPT_BASE_GET()}

## DATABASE SCHEMA
${SCHEMA_DOC_GET()}

## CURRENT TRIAGE BRIEF

the_question:        ${triage.the_question || ''}
investigation_depth: ${triage.investigation_depth || 'focused'}
response_posture:    ${triage.response_posture || 'interpretive'}
response_length:     ${triage.response_length || 'medium'}

investigator_brief:
${triage.investigator_brief || '(none)'}
`;
}

async function runInvestigation(triage, prompt, extraContext) {
  if (triage.investigation_depth === 'none') {
    return { scratch: [], queryCount: 0 };
  }

  const maxTurns = DEPTH_TO_MAX_TURNS[triage.investigation_depth] || DEPTH_TO_MAX_TURNS.focused;
  const systemPrompt = buildInvestigatorSystemPrompt(triage);

  // Build user message: the question, plus any extra context blocks.
  const parts = [];
  if (extraContext && extraContext.strategistContext && String(extraContext.strategistContext).trim()) {
    parts.push('[STRATEGIST CONTEXT]\n' + String(extraContext.strategistContext).trim());
  }
  if (extraContext && extraContext.waldoContext) {
    const wc = typeof extraContext.waldoContext === 'string'
      ? extraContext.waldoContext
      : JSON.stringify(extraContext.waldoContext).slice(0, 2000);
    parts.push('[WALDO INTELLIGENCE]\n' + wc);
  }
  parts.push('[QUERY]\n' + (triage.the_question || prompt));

  const messages = [{ role: 'user', content: parts.join('\n\n') }];
  const scratch = [];
  let queryCount = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await anthropic.messages.create({
      model: SONNET_MODEL,
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
      if (text) {
        scratch.push({ type: 'final_summary', text });
      }
      return { scratch, queryCount };
    }

    if (response.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: response.content });
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use' && block.name === 'execute_sql') {
          queryCount++;
          const sqlResult = await executeSql(block.input.sql);
          scratch.push({
            type: 'query',
            query: block.input.sql,
            rationale: block.input.rationale,
            result: sqlResult.rows || sqlResult.error,
            rowcount: sqlResult.rows ? sqlResult.rows.length : 0
          });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(sqlResult).slice(0, 50000)
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
      continue;
    }
    break;
  }

  // Hit the depth budget without an end_turn. Return scratch as-is; the
  // synthesizer can write the response from queries alone.
  return { scratch, queryCount, hit_max_turns: true };
}

// -------------------------------------------------------------------------
// Stage 3: Synthesis (Sonnet 4.6)
// -------------------------------------------------------------------------
function buildSynthesizerSystemPrompt(triage) {
  return `${SYNTHESIZER_PROMPT_BASE_GET()}

## CURRENT TRIAGE BRIEF

the_question:    ${triage.the_question || ''}
response_posture:${triage.response_posture || 'interpretive'}
response_length: ${triage.response_length || 'medium'}
followup_seeds:  ${JSON.stringify(triage.followup_seeds || [])}
`;
}

// Synthesizer max_tokens scaled by triage's response_length. The previous
// hardcoded 3000 was too low for any literal-posture data dump request — a
// 242-item table with n>1000 truncated mid-line at item 115. These ceilings
// give literal/long requests room while keeping short responses fast and
// cheap (each output token is real money + latency on Sonnet).
const LENGTH_TO_MAX_TOKENS = {
  short:  1500,
  medium: 4000,
  long:   16000
};

// Heuristic for distinguishing truncation from other JSON-parse failures.
// Truncation symptoms: stop_reason === 'max_tokens' from the API, or the
// raw text doesn't end with a closing brace/bracket. Other malformations
// (model emitted plain prose, model wrapped in unexpected fence, etc.)
// fall through to the raw-text fallback so the user still sees something.
function looksLikeTruncation(stopReason, raw) {
  if (stopReason === 'max_tokens') return true;
  const trimmed = (raw || '').trim();
  if (!trimmed) return false;
  const last = trimmed.slice(-1);
  // A complete JSON object ends with } and a complete array with ].
  // If the last non-whitespace char is anything else AND the start was {
  // (we're expecting a JSON object), the model likely got cut off.
  return trimmed.startsWith('{') && last !== '}';
}

// Try to extract whatever response_text the truncated JSON managed to
// produce before being cut off, so we can show the user the partial
// content alongside the truncation notice. Best-effort; returns null if
// nothing salvageable.
function extractTruncatedResponseText(raw) {
  if (!raw) return null;
  // Find the start of the response_text value: looks like
  //    "response_text": "..."
  // The value is a JSON string, so we need to walk it manually because
  // it can contain escaped quotes.
  const keyMatch = raw.match(/"response_text"\s*:\s*"/);
  if (!keyMatch) return null;
  const start = keyMatch.index + keyMatch[0].length;
  let i = start;
  let out = '';
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      // Decode common JSON escapes; pass through anything else literally.
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === '"') out += '"';
      else if (next === '\\') out += '\\';
      else if (next === '/') out += '/';
      else if (next === 'u' && i + 5 < raw.length) {
        const code = parseInt(raw.slice(i + 2, i + 6), 16);
        if (!isNaN(code)) { out += String.fromCharCode(code); i += 4; }
      } else {
        out += next;
      }
      i += 2;
      continue;
    }
    if (c === '"') {
      // End of the JSON string — the rest of the JSON is metadata
      // (followup_chips array, closing brace). We have the full
      // response_text. Return it.
      return out;
    }
    out += c;
    i++;
  }
  // Hit end of buffer mid-string: this is truncation. Return what we have.
  return out;
}

async function runSynthesis(triage, scratch) {
  const systemPrompt = buildSynthesizerSystemPrompt(triage);
  const userMessage = `Investigator scratch (${scratch.length} entries):\n${JSON.stringify(scratch, null, 2)}\n\nProduce the response now as JSON: {"response_text": "...", "followup_chips": ["...", "...", "..."]}`;

  const lengthKey = (triage && triage.response_length) || 'medium';
  const maxTokens = LENGTH_TO_MAX_TOKENS[lengthKey] || LENGTH_TO_MAX_TOKENS.medium;

  const response = await anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });

  let raw = (response.content[0] && response.content[0].text) ? response.content[0].text.trim() : '';
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '').trim();
  }

  try {
    const parsed = JSON.parse(raw);
    // The JSON parsed cleanly. Use parsed.response_text directly — never fall
    // back to the raw JSON string as the response. If parsed.response_text is
    // missing or empty, that's a separate failure mode (synthesizer produced
    // valid JSON but didn't include the expected field). Surface a clear
    // error instead of dumping the raw JSON to the user, which is what was
    // happening before this fix and showed up to users as a literal
    // `{ "response_text": "..." }` rendered as the answer body.
    const responseText = (parsed && typeof parsed.response_text === 'string')
      ? parsed.response_text
      : null;
    const followupChips = Array.isArray(parsed.followup_chips)
      ? parsed.followup_chips
      : (triage.followup_seeds || []);

    if (!responseText) {
      console.warn('[synthesis] parsed JSON OK but response_text missing/empty/non-string. parsed keys:',
        Object.keys(parsed || {}), 'raw chars:', raw.length);
      return {
        response_text: "The synthesizer parsed valid JSON but did not include a response_text field. "
          + "The investigation scratch is intact (look at the evidence drawer or pull job_id "
          + "from the URL). This is a synthesizer-prompt issue, not a data issue. Try rephrasing "
          + "the question or rerun.",
        followup_chips: followupChips,
        synth_error: 'missing_response_text'
      };
    }

    return {
      response_text: responseText,
      followup_chips: followupChips
    };
  } catch (e) {
    // Distinguish truncation from other malformations. Truncation gets a
    // clean message + whatever partial content we can salvage. Anything
    // else falls through to the raw-text fallback so the user still sees
    // the model's output rather than a silent failure.
    if (looksLikeTruncation(response.stop_reason, raw)) {
      const partial = extractTruncatedResponseText(raw);
      const truncMsg = "I had to cut this short due to response length limits"
        + ` (the lab's synthesizer hit its ${maxTokens.toLocaleString()}-token ceiling on this ${lengthKey} response).`
        + " The full result set may be larger than fits in one response."
        + " Try asking for a narrower slice (e.g. top 50, by category, only items above a JI threshold)"
        + " or break the question into stages and we'll page through the corpus.";
      console.warn('[synthesis] truncation detected. stop_reason=', response.stop_reason,
        'maxTokens=', maxTokens, 'raw chars=', raw.length,
        'partial chars=', partial ? partial.length : 0);
      return {
        response_text: partial && partial.trim()
          ? (partial.trim() + '\n\n---\n\n**' + truncMsg + '**')
          : truncMsg,
        followup_chips: triage.followup_seeds || [],
        truncated: true
      };
    }
    // Non-truncation malformation: model emitted plain prose, fence the
    // strip didn't catch, etc. Surface the raw output so we don't lose the
    // model's work; the user sees something readable.
    console.warn('[synthesis] JSON parse failed (non-truncation), using raw text. err:', e.message,
      'stop_reason=', response.stop_reason, 'raw chars=', raw.length);
    return {
      response_text: raw,
      followup_chips: triage.followup_seeds || []
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
    .select('job_id, query_type, prompt, status, extra_context, prior_conversation_context')
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
    // Stage 1: Triage
    const triage = await runTriage(job.prompt, job.prior_conversation_context, job.extra_context);
    console.log('[bjl-query-background] triage returned:',
      'needs_clarification=' + JSON.stringify(triage.needs_clarification),
      'early_exit=' + JSON.stringify(triage.early_exit),
      'depth=' + triage.investigation_depth,
      'cq_len=' + (triage.clarifying_question ? triage.clarifying_question.length : 0)
    );
    await supabase
      .from('bjl_query_jobs')
      .update({
        triage_brief: triage,
        triage_completed_at: new Date().toISOString()
      })
      .eq('job_id', jobId);

    // Bypass: clarification needed
    if (triage.needs_clarification === true) {
      console.log('[bjl-query-background] taking clarification bypass for job', jobId);
      const { error: clarErr } = await supabase
        .from('bjl_query_jobs')
        .update({
          status: 'clarification_needed',
          clarifying_question: triage.clarifying_question,
          followup_chips: [],
          completed_at: new Date().toISOString()
        })
        .eq('job_id', jobId);
      if (clarErr) {
        console.error('[bjl-query-background] clarification update failed:', clarErr);
      } else {
        console.log('[bjl-query-background] clarification update OK for job', jobId);
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'clarification_needed', job_id: jobId }) };
    }

    // Bypass: early exit (no investigation needed)
    if (triage.early_exit === true) {
      await supabase
        .from('bjl_query_jobs')
        .update({
          status: 'complete',
          finding: triage.early_exit_response || '',
          followup_chips: triage.followup_seeds || [],
          query_count: 0,
          scratch: [],
          completed_at: new Date().toISOString()
        })
        .eq('job_id', jobId);
      return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'complete', early_exit: true, job_id: jobId }) };
    }

    // Stage 2: Investigation
    const { scratch, queryCount, hit_max_turns } = await runInvestigation(triage, job.prompt, job.extra_context);

    // Stage 3: Synthesis
    const { response_text, followup_chips } = await runSynthesis(triage, scratch);

    // Mark complete. If we hit the depth budget without an end_turn,
    // append a meta entry so the synthesizer scratch reflects that state
    // (no dedicated column for it; the scratch is the source of truth).
    const finalScratch = hit_max_turns
      ? scratch.concat([{ type: 'meta', hit_max_turns: true }])
      : scratch;

    await supabase
      .from('bjl_query_jobs')
      .update({
        status: 'complete',
        finding: response_text,
        scratch: finalScratch,
        query_count: queryCount,
        followup_chips,
        completed_at: new Date().toISOString()
      })
      .eq('job_id', jobId);

    return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'complete', job_id: jobId }) };

  } catch (e) {
    console.error('[bjl-query-background] pipeline threw:', e);
    await supabase
      .from('bjl_query_jobs')
      .update({
        status: 'error',
        error: (e && e.message) ? e.message : String(e),
        completed_at: new Date().toISOString()
      })
      .eq('job_id', jobId);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: (e && e.message) || String(e) }) };
  }
};
