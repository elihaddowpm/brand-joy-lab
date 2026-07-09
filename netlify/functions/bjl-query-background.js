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
//
// 'thorough' lowered from 20 to 12 turns (target 6-8 queries) on 2026-05-01
// after multi-part prompts ("Tell me about X. What about Y? How differ?")
// produced 13-18 query investigations running 5-13 minutes. The investigator
// prompt now asks the model to pick the ONE central sub-question and surface
// the others as followup chips; the lowered hard cap forces the discipline.
const DEPTH_TO_MAX_TURNS = {
  none: 0,
  minimal: 4,    // 1-2 queries
  focused: 10,   // 3-5 queries
  thorough: 12   // target 6-8 queries
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
const {
  runProvenanceGuard,
  buildRetryAllowlistDigest,
} = require('./bjl-cross-domain-provenance-guard');

// ============================================================
// v7 — Session persistence helpers.
//
// bjl-query.js wrote the USER message + created the session (if
// needed) at enqueue time. After the background pipeline produces
// a response (clarification, early-exit, or full synthesis), we
// write the ASSISTANT message and bump the session's last_active_at
// + summary so the Recent dropdown stays ordered correctly.
//
// session_id arrives via job.extra_context._session_id (threaded by
// bjl-query.js). Null in bypass / unauthenticated mode.
// ============================================================
async function writeAssistantTurn(sessionId, content, contextObj) {
  if (!sessionId) return;
  if (!content || typeof content !== 'string') return;

  try {
    // Compute next seq. Reusing the same scheme as the sync enqueue:
    // max(seq)+1, defaults to a higher number than the user message
    // we just wrote.
    const { data: maxRows, error: seqErr } = await supabase
      .from('bjl_session_messages')
      .select('seq')
      .eq('session_id', sessionId)
      .order('seq', { ascending: false })
      .limit(1);
    if (seqErr) {
      console.error('[bjl-query-background] seq lookup failed:', seqErr);
      return;
    }
    const nextSeq = (maxRows && maxRows.length > 0) ? Number(maxRows[0].seq || 0) + 1 : 1;

    const { error: insErr } = await supabase
      .from('bjl_session_messages')
      .insert({
        session_id: sessionId,
        seq:        nextSeq,
        role:       'assistant',
        content,
        context:    (contextObj && Object.keys(contextObj).length) ? contextObj : null,
      });
    if (insErr) {
      console.error('[bjl-query-background] assistant-message insert failed:', insErr);
      return;
    }

    // Bump last_active_at. Summary updates happen on the sync path
    // (which has the latest user prompt at hand); we don't touch
    // summary here.
    const { error: updErr } = await supabase
      .from('bjl_sessions')
      .update({ last_active_at: new Date().toISOString() })
      .eq('id', sessionId);
    if (updErr) {
      console.error('[bjl-query-background] session bump failed:', updErr);
    }
  } catch (e) {
    // Session writes are best-effort: a failed write does NOT roll
    // back the strategist's job. The conversation still renders from
    // the polled job result; only the session-persistence side
    // diverges, and the next turn will continue regardless.
    console.error('[bjl-query-background] writeAssistantTurn threw:', e);
  }
}

function getSessionIdFromJob(job) {
  if (!job || !job.extra_context || typeof job.extra_context !== 'object') return null;
  const raw = job.extra_context._session_id;
  return (typeof raw === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw))
    ? raw
    : null;
}

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
function buildInvestigatorSystemPrompt(triage, opts) {
  opts = opts || {};
  const jobId = opts.jobId || null;

  return `${INVESTIGATOR_PROMPT_BASE_GET()}

## DATABASE SCHEMA
${SCHEMA_DOC_GET()}

## CURRENT TRIAGE BRIEF

the_question:        ${triage.the_question || ''}
investigation_depth: ${triage.investigation_depth || 'focused'}
response_posture:    ${triage.response_posture || 'interpretive'}
response_length:     ${triage.response_length || 'medium'}
job_id:              ${jobId || '(unknown)'}

investigator_brief:
${triage.investigator_brief || '(none)'}
`;
}

async function runInvestigation(triage, prompt, extraContext, opts) {
  if (triage.investigation_depth === 'none') {
    return { scratch: [], queryCount: 0 };
  }
  opts = opts || {};
  const jobId = opts.jobId || null;

  const maxTurns = DEPTH_TO_MAX_TURNS[triage.investigation_depth] || DEPTH_TO_MAX_TURNS.focused;
  const systemPrompt = buildInvestigatorSystemPrompt(triage, { jobId });

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
// v6.8: raised medium + long to give the synthesizer more headroom on
// dense responses. The "user sees raw JSON" pattern was partially driven
// by mid-object truncation that didn't trip the truncation heuristic
// cleanly; more room reduces the frequency.
//
// Immediate stop-the-bleed: three recent reports (a fandom follow-up, two
// HI USA runs) cut off mid-card at the medium ceiling. The medium cap is
// raised with real headroom so a full response (deep-dive prose +
// structured cross_domain_threads + structured cards) fits with room to
// spare while the bounded output contract lands. The contract itself
// (caps on word count, thread count, card count) is the real fix; this is
// insurance until it takes effect.
const LENGTH_TO_MAX_TOKENS = {
  short:  2000,
  medium: 12000,
  long:   24000
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

// v6.8: prep the raw model output for JSON.parse. Handles three drift
// patterns we've seen intermittently:
//   1. Lead-in prose before the JSON ("Here's the response:\n{...}")
//   2. Code fences that don't sit exactly at the start of the buffer
//      (the prior strip only caught ^```json\n)
//   3. Trailing prose after the JSON close (rare but happens)
//
// Strategy: locate the outermost {...} and slice. Bracket-counting handles
// nested objects/arrays correctly; strings (with escapes) are skipped so
// quotes inside response_text don't fool the counter.
function extractJsonObjectSubstring(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const first = raw.indexOf('{');
  if (first === -1) return null;
  let depth = 0;
  let inString = false;
  for (let i = first; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return raw.slice(first, i + 1);
    }
  }
  // Reached EOF mid-object — truncated. Return the partial buffer from
  // the first { onward so downstream extractors can still pull response_text.
  return raw.slice(first);
}

// v6.8: key-normalization read. The synthesizer schema specifies
// snake_case (response_text, followup_chips) but Sonnet occasionally
// emits camelCase or lowercase-no-underscore variants (responseText,
// responsetext, followupchips, followupChips). Build a case-/separator-
// insensitive lookup so we read the right value regardless of which
// spelling the model picked.
function makeNormalizedReader(obj) {
  const map = new Map();
  if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const norm = k.toLowerCase().replace(/[_\-\s]/g, '');
      if (!map.has(norm)) map.set(norm, obj[k]);
    }
  }
  return (canonicalKey) => {
    const norm = canonicalKey.toLowerCase().replace(/[_\-\s]/g, '');
    return map.has(norm) ? map.get(norm) : undefined;
  };
}

// Try to extract whatever response_text the truncated JSON managed to
// produce before being cut off, so we can show the user the partial
// content alongside the truncation notice. Best-effort; returns null if
// nothing salvageable.
//
// v6.8: also handles the casing-wobble case where the model wrote
// "responsetext" or "responseText" instead of "response_text".
function extractTruncatedResponseText(raw) {
  if (!raw) return null;
  // Find the start of the response_text value: looks like
  //    "response_text": "..." (or any case/separator variant)
  // The value is a JSON string, so we need to walk it manually because
  // it can contain escaped quotes.
  const keyMatch = raw.match(/"response[_\-\s]?text"\s*:\s*"/i)
                || raw.match(/"responsetext"\s*:\s*"/i);
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

async function runSynthesis(triage, scratch, extraContext) {
  const systemPrompt = buildSynthesizerSystemPrompt(triage);

  // The synthesizer authors the final response, so it MUST see the
  // strategist context. Triage + investigator already received it; if we
  // skip the synthesizer the strategist's pasted background never reaches
  // the rendered output (Issue 1 in the v5.3 brief).
  const parts = [];
  if (extraContext && extraContext.strategistContext && String(extraContext.strategistContext).trim()) {
    parts.push('[STRATEGIST CONTEXT]\nThe strategist pasted this context. Treat it as authoritative background on the brand, audience, or situation and reflect it in your response where relevant.\n\n' + String(extraContext.strategistContext).trim());
  }
  if (extraContext && extraContext.waldoContext) {
    const wc = typeof extraContext.waldoContext === 'string'
      ? extraContext.waldoContext
      : JSON.stringify(extraContext.waldoContext).slice(0, 2000);
    parts.push('[WALDO INTELLIGENCE]\n' + wc);
  }
  parts.push(`Investigator scratch (${scratch.length} entries):\n${JSON.stringify(scratch, null, 2)}\n\nProduce the response now as JSON: {"response_text": "...", "followup_chips": ["...", "...", "..."]}`);
  // Guard-retry prefix: when the cross-domain provenance guard fails the
  // first pass, runSynthesisWithGuard re-invokes runSynthesis with an
  // allowlist digest and a rewrite instruction threaded through
  // extra_context. Prepending it here so the model sees the retry rules
  // before the scratch.
  if (extraContext && typeof extraContext.__guard_retry_prefix === 'string' && extraContext.__guard_retry_prefix.trim()) {
    parts.unshift(extraContext.__guard_retry_prefix.trim());
  }
  const userMessage = parts.join('\n\n');

  // Output-volume cap: when any single investigator query returned more
  // than HEAVY_RESULT_THRESHOLD rows, augment the synthesizer's system
  // prompt at runtime to ask it to summarize + offer narrowing rather
  // than enumerate. Prevents the 242-item joy-index dump symptom from a
  // prior session, where a thorough investigation produced a query with
  // n>200 rows that the synthesizer rendered as a literal list, hitting
  // the max_tokens ceiling and truncating mid-line. This is gentler than
  // a hard cap on the function side — the synthesizer can adapt response
  // shape based on actual data volume rather than the function
  // truncating output bytes after the fact.
  const HEAVY_RESULT_THRESHOLD = 200;
  const hasHeavyResult = Array.isArray(scratch)
    && scratch.some(s => s && s.type === 'query' && (s.rowcount || 0) > HEAVY_RESULT_THRESHOLD);
  const augmentedSystemPrompt = hasHeavyResult
    ? `${systemPrompt}\n\n## OUTPUT VOLUME CAP\n\nNOTE: One or more queries returned more than ${HEAVY_RESULT_THRESHOLD} rows. Do NOT enumerate every row. Show the top 50 by relevance, total count, and add: "I can show more if you narrow the query — try filtering by [demographic/topic/etc]."`
    : systemPrompt;

  // email_mode: invoked from /api/bjl-content for bjl_finding requests. The
  // full investigator analysis runs as normal, but the synthesize stage
  // emits a single strategically-relevant sentence for use as a cold-email
  // data point. The caller discards everything except response_text.
  const emailMode = !!(extraContext && extraContext.email_mode === true);
  const finalSystemPrompt = emailMode
    ? `${augmentedSystemPrompt}\n\n## EMAIL MODE\n\nFrom your full analysis, select the single finding that speaks most directly to the prospect's strategic challenge as stated in the query above (look for "Strategic tension:"). Strategic relevance beats novelty: do NOT default to the highest-joy, most striking, or most counterintuitive item if it does not bear on what this prospect is actually working on. A finding that reframes how the prospect thinks about their specific challenge is worth more than one that simply describes their category or geography. Return one plain sentence only - no scores, no index numbers, no markdown, no methodology. Describe what people feel, prefer, or do in plain language. Discard the rest of your analysis. Put the sentence in response_text. followup_chips may be empty.`
    : augmentedSystemPrompt;

  const lengthKey = emailMode ? 'short' : ((triage && triage.response_length) || 'medium');
  const maxTokens = LENGTH_TO_MAX_TOKENS[lengthKey] || LENGTH_TO_MAX_TOKENS.medium;

  const response = await anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: maxTokens,
    system: finalSystemPrompt,
    messages: [{ role: 'user', content: userMessage }]
  });

  let raw = (response.content[0] && response.content[0].text) ? response.content[0].text.trim() : '';
  // v6.8: lenient fence + preamble strip. The strict ^```json\n form
  // missed cases where the model wrote "Here's the JSON:\n```json\n{...}"
  // or wrapped the fences with surrounding prose. Walk the buffer to the
  // outermost {…} and slice; that handles preamble, late fences, and
  // trailing prose at once.
  const jsonSlice = extractJsonObjectSubstring(raw);
  if (jsonSlice) raw = jsonSlice;

  // Helper for the never-dump-raw-JSON fallback: try the permissive
  // string-walking extractor regardless of stop_reason. The extractor
  // already handles case/separator variants for the response_text key.
  const salvagePartial = () => extractTruncatedResponseText(raw);

  try {
    const parsed = JSON.parse(raw);
    // v6.8: read via normalized lookup so case/separator drift in the
    // model's keys (responsetext / responseText / response_text) doesn't
    // dump the whole object on the user.
    const read = makeNormalizedReader(parsed);
    const responseTextValue = read('response_text');
    const followupChipsValue = read('followup_chips');

    const responseText = (typeof responseTextValue === 'string' && responseTextValue.trim())
      ? responseTextValue
      : null;
    const followupChips = Array.isArray(followupChipsValue)
      ? followupChipsValue
      : (triage.followup_seeds || []);

    // Cross-domain structured contract (v-guard). Optional fields the
    // synthesizer emits when it made cross-domain claims. Read via the
    // normalized reader so case/separator drift doesn't drop them.
    const crossDomainThreadsValue = read('cross_domain_threads');
    const homeTopicValue = read('home_topic');
    const cardsValue = read('cards');
    const crossDomainThreads = Array.isArray(crossDomainThreadsValue)
      ? crossDomainThreadsValue
      : null;
    const homeTopic = (typeof homeTopicValue === 'string' && homeTopicValue.trim())
      ? homeTopicValue
      : (Array.isArray(homeTopicValue) ? homeTopicValue : null);
    const cards = Array.isArray(cardsValue) ? cardsValue : null;

    if (!responseText) {
      // JSON parsed but no recognizable response_text key in any casing.
      // Salvage what we can from the buffer; never expose the raw JSON.
      const partial = salvagePartial();
      console.warn('[synthesis] parsed JSON OK but response_text missing across all key variants. keys:',
        Object.keys(parsed || {}), 'raw chars:', raw.length, 'partial chars:', partial ? partial.length : 0);
      if (partial && partial.trim()) {
        return {
          response_text: partial.trim(),
          followup_chips: followupChips,
          synth_warning: 'key_drift_recovered'
        };
      }
      return {
        response_text: "The synthesizer parsed valid JSON but did not include a recognizable "
          + "response_text field. The investigation scratch is intact (look at the evidence "
          + "drawer or pull job_id from the URL). Try rephrasing the question or rerun.",
        followup_chips: followupChips,
        synth_error: 'missing_response_text'
      };
    }

    return {
      response_text: responseText,
      followup_chips: followupChips,
      cross_domain_threads: crossDomainThreads,
      home_topic: homeTopic,
      cards
    };
  } catch (e) {
    // JSON.parse failed entirely. Three sub-paths, all of which now route
    // through the permissive extractor so we NEVER hand the user raw
    // braces as the answer body.
    const truncated = looksLikeTruncation(response.stop_reason, raw);
    const partial = salvagePartial();

    if (truncated) {
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

    // Non-truncation malformation. v6.8: if we can extract a clean
    // response_text via the string walker, return that (no raw JSON
    // ever reaches the user). If we can't, return an honest hiccup
    // message instead of dumping the buffer.
    if (partial && partial.trim()) {
      console.warn('[synthesis] JSON parse failed but response_text extracted. err:', e.message,
        'stop_reason=', response.stop_reason, 'raw chars=', raw.length,
        'partial chars=', partial.length);
      return {
        response_text: partial.trim(),
        followup_chips: triage.followup_seeds || [],
        synth_warning: 'parse_failed_recovered'
      };
    }

    console.warn('[synthesis] JSON parse failed and no response_text salvageable. err:', e.message,
      'stop_reason=', response.stop_reason, 'raw chars=', raw.length);
    return {
      response_text: "The synthesizer hit a formatting hiccup on this one. The investigation "
        + "scratch is intact (the evidence drawer carries the underlying data). Try rerunning, "
        + "or rephrase the question and we'll have another go.",
      followup_chips: triage.followup_seeds || [],
      synth_error: 'parse_failed_unsalvageable'
    };
  }
}

// Provenance guard: retry-once, then drop.
//
// After the synthesizer returns, if it emitted structured cross_domain_threads
// or cards we verify every item, number, thread_tag, source, and topic against
// the rows in scratch. On failure we re-invoke the synthesizer once with a
// strict allowlist digest and a rewrite instruction. On second failure the
// offending surface(s) are dropped — threads and cards drop independently, so
// a failing card doesn't take the threads sidecar down with it — and a
// synth_warning is attached. response_text is re-authored on the retry so a
// dropped structured field doesn't leave prose asserting the failed claims.
async function runSynthesisWithGuard(triage, scratch, extraContext) {
  const initial = await runSynthesis(triage, scratch, extraContext);

  const threads = Array.isArray(initial.cross_domain_threads) ? initial.cross_domain_threads : [];
  const cards   = Array.isArray(initial.cards) ? initial.cards : [];
  // Nothing to guard against unless the synthesizer emitted structured
  // claims. Bail out fast in the common case.
  if (threads.length === 0 && cards.length === 0) return initial;

  const firstPass = runProvenanceGuard({
    threads,
    cards,
    home_topic: initial.home_topic,
    scratch,
  });
  if (firstPass.ok) return initial;

  console.warn('[guard] provenance failed on first pass. failures:',
    JSON.stringify(firstPass.failures).slice(0, 800));

  // One retry with the allowlist digest laid out explicitly and a rewrite
  // instruction. The digest groups threads by thread_tag with their exact
  // numbers, so the model can reproduce a strict subset with confidence.
  const digest = buildRetryAllowlistDigest(scratch);
  const retryPrefix = [
    'RETRY WITH ALLOWLIST.',
    'Your previous response contained structured claims (cross_domain_threads and/or cards) that did not match the rows in scratch. The specific failures were:',
    JSON.stringify(firstPass.failures, null, 2),
    '',
    'Regenerate the full response now. Rules for this retry:',
    '1. cross_domain_threads may only reference the threads and members in the ALLOWLIST DIGEST below. You may drop a thread or a member; you may not add or alter one. Every item_name, joy_index, n, and primary_topic MUST be copied exactly from the digest.',
    '2. cards may only cite item_name / joy_index / n values that come verbatim from a row in the investigator scratch, and every stat_item in one card MUST share the same source. If a card cannot be grounded that cleanly, drop the card.',
    '3. Rewrite response_text so it does not name any item or number that is not present in the structured fields you kept. If you drop a thread or a card, remove any prose that leaned on it.',
    '4. home_topic must equal the primary_topic of the within-category anchors, as before.',
    '5. followup_chips remain from triage.',
    '6. Respect the caps: response_text ≤ 500 words, ≤ 3 threads (≤ 3 members each), ≤ 3 cards (≤ 4 stat_items each).',
    '',
    'ALLOWLIST DIGEST (the only cross-domain claims you may make):',
    JSON.stringify(digest, null, 2),
    '',
    'Return the full JSON response now, following the same schema.',
  ].join('\n');

  const retryContext = Object.assign({}, extraContext || {}, {
    __guard_retry_prefix: retryPrefix,
  });

  // The retry re-runs the full synthesis with the digest prepended to the
  // user message. runSynthesis is unchanged; the prefix is threaded through
  // extraContext and picked up in the userMessage build.
  const retry = await runSynthesis(triage, scratch, retryContext);
  const retryThreads = Array.isArray(retry.cross_domain_threads) ? retry.cross_domain_threads : [];
  const retryCards   = Array.isArray(retry.cards) ? retry.cards : [];

  const secondPass = runProvenanceGuard({
    threads: retryThreads,
    cards: retryCards,
    home_topic: retry.home_topic,
    scratch,
  });
  if (secondPass.ok) return retry;

  console.warn('[guard] provenance failed on retry. dropping offending surfaces. failures:',
    JSON.stringify(secondPass.failures).slice(0, 800));

  // Second failure. Drop the specific surface(s) that failed, keep the ones
  // that verified. Threads and cards fail independently — a bad card
  // shouldn't cost us the threads sidecar, and vice versa.
  const threadsFailed = secondPass.failures.some(f => f.surface === 'threads');
  const cardsFailed   = secondPass.failures.some(f => f.surface === 'cards');

  const outThreads = threadsFailed ? [] : retryThreads;
  const outHomeTopic = threadsFailed ? null : retry.home_topic;
  // For cards, drop the specific cards that failed rather than all of them,
  // when we can attribute failures to a card_index. Keep the ones that
  // passed. If any card failure has no card_index (e.g. a global
  // 'no_scratch_rows_for_cards'), drop the whole card list.
  let outCards = retryCards;
  if (cardsFailed) {
    const globalCardFail = secondPass.failures.some(f =>
      f.surface === 'cards' && (!f.claim || typeof f.claim.card_index !== 'number')
    );
    if (globalCardFail) {
      outCards = [];
    } else {
      const failedCardIndices = new Set(
        secondPass.failures
          .filter(f => f.surface === 'cards' && f.claim && typeof f.claim.card_index === 'number')
          .map(f => f.claim.card_index)
      );
      outCards = retryCards.filter((_, i) => !failedCardIndices.has(i));
    }
  }

  return {
    response_text: retry.response_text,
    followup_chips: retry.followup_chips,
    cross_domain_threads: outThreads,
    home_topic: outHomeTopic,
    cards: outCards,
    synth_warning: 'provenance_failed',
    synth_warning_detail: secondPass.failures,
  };
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

    // v7 — session id threaded by the sync enqueue. Used by all three
    // completion paths below to log the assistant's reply against the
    // session message log.
    const sessionId = getSessionIdFromJob(job);

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
      // Session log: clarification IS the assistant's turn from the
      // strategist's POV — render it as the next message.
      await writeAssistantTurn(sessionId, triage.clarifying_question || '', { kind: 'clarification' });
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
      await writeAssistantTurn(sessionId, triage.early_exit_response || '', {
        kind: 'early_exit',
        followup_chips: triage.followup_seeds || [],
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, status: 'complete', early_exit: true, job_id: jobId }) };
    }

    // Stage 2: Investigation
    const { scratch, queryCount, hit_max_turns } = await runInvestigation(triage, job.prompt, job.extra_context, {
      jobId: job.job_id,
    });

    // Stage 3: Synthesis (guard-wrapped). The wrapper runs the provenance
    // guard on any structured cross_domain_threads the synthesizer emits,
    // retries once on failure with a strict allowlist digest, and drops the
    // sidecar (empty threads + null home_topic + synth_warning) if the retry
    // still doesn't verify.
    const synth = await runSynthesisWithGuard(triage, scratch, job.extra_context);
    const {
      response_text,
      followup_chips,
      cross_domain_threads,
      home_topic,
      cards,
      synth_warning,
      synth_warning_detail,
    } = synth;

    // Structured artifacts persist as a meta entry on scratch so the sidecar
    // rendering path has them alongside the investigator handoff without
    // requiring a schema change. When the guard drops a surface, the entry
    // still lands but with the failure recorded so the UI can render an
    // "answer without that sidecar" state and the log has the offending
    // claims.
    const hasThreads = Array.isArray(cross_domain_threads) && cross_domain_threads.length > 0;
    const hasCards   = Array.isArray(cards) && cards.length > 0;
    const guardMeta = (hasThreads || hasCards || home_topic || synth_warning)
      ? [{
          type: 'structured_synth_output',
          cross_domain_threads: Array.isArray(cross_domain_threads) ? cross_domain_threads : [],
          cards: Array.isArray(cards) ? cards : [],
          home_topic: home_topic || null,
          synth_warning: synth_warning || null,
          synth_warning_detail: synth_warning_detail || null,
        }]
      : [];

    // Mark complete. If we hit the depth budget without an end_turn,
    // append a meta entry so the synthesizer scratch reflects that state
    // (no dedicated column for it; the scratch is the source of truth).
    const finalScratch = (hit_max_turns
      ? scratch.concat([{ type: 'meta', hit_max_turns: true }])
      : scratch
    ).concat(guardMeta);

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

    // v7 session log — the strategist-facing assistant message + a
    // compact context payload (followup chips, query count). Full
    // scratch lives on the job row; we don't duplicate it into the
    // session message context (avoids ballooning the JSONB column).
    await writeAssistantTurn(sessionId, response_text, {
      kind: 'synthesized',
      followup_chips: followup_chips || [],
      query_count:    queryCount,
      hit_max_turns:  !!hit_max_turns,
    });

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
