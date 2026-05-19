/**
 * bjl-joy-map-audience-parse-background.js — async worker for the joy-map
 * free-text audience parser.
 *
 * Pipeline (identical to what bjl-joy-map-audience-parse.js used to do
 * inline as a sync function — moved here so the long-running LLM call
 * doesn't blow the sync gateway timeout):
 *
 *   1. Load job from bjl_query_jobs
 *   2. Load bjl_items_clean catalog (~2K items) with scale_kind + fielding_ids
 *   3. Call Haiku 4.5 with the joy_map_audience_parse system prompt
 *   4. Validate and hydrate the LLM's return against the catalog (drop any
 *      invalid item_ids or invalid criteria for the matched scale_kind)
 *   5. Write the structured result to bjl_query_jobs.finding as JSON
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;
const {
  PICKER_QUESTION_TYPES,
  CRITERION_OPTIONS,
  classifyScaleKind,
} = require('./bjl-joy-pattern-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const PROMPTS = require('./_prompts_bundle.json');

const PARSE_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 4000;

async function loadCleanCatalog() {
  const typesList = PICKER_QUESTION_TYPES.map(t => `'${t.replace(/'/g, "''")}'`).join(',');
  const sql = `
    SELECT item_id, item_name, question_id, question_text,
           question_type, scale_type, n_responses, fielding_ids
    FROM bjl_items_clean
    WHERE question_type IN (${typesList})
    ORDER BY n_responses DESC
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`clean catalog load: ${error.message}`);
  return (data || [])
    .map(row => ({
      item_id:       row.item_id,
      item_name:     row.item_name,
      question_id:   row.question_id,
      question_text: row.question_text,
      scale_kind:    classifyScaleKind(row.question_type, row.scale_type),
      n_responses:   row.n_responses,
      fielding_ids:  Array.isArray(row.fielding_ids) ? row.fielding_ids : [],
    }))
    .filter(row => row.scale_kind !== null);
}

async function callParseLLM({ description, catalog }) {
  const systemPrompt = PROMPTS.joyMapAudienceParse;
  if (!systemPrompt) throw new Error('joy_map_audience_parse prompt missing from bundle');

  const catalogForLLM = catalog.map(c => ({
    item_id:       c.item_id,
    item_name:     c.item_name,
    question_text: c.question_text,
    scale_kind:    c.scale_kind,
    n_responses:   c.n_responses,
    fielding_ids:  c.fielding_ids,
  }));

  const userMessage = [
    'description:',
    description,
    '',
    `catalog (${catalog.length} items, all n_responses >= 100):`,
    JSON.stringify(catalogForLLM),
    '',
    'criterion_options_by_kind:',
    JSON.stringify(CRITERION_OPTIONS, null, 2),
  ].join('\n');

  const rsp = await anthropic.messages.create({
    model: PARSE_MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: systemPrompt }],
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = (rsp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

function validateAndHydrate(parsed, catalog) {
  const byId = new Map(catalog.map(c => [c.item_id, c]));
  const validRules = [];
  let invalidItems = 0;
  let invalidCriteria = 0;

  for (const rule of (parsed.rules || [])) {
    const hydratedMatches = [];
    for (const m of (rule.matched_items || [])) {
      const itemId = Number(m.item_id);
      const cat = byId.get(itemId);
      if (!cat) { invalidItems++; continue; }
      hydratedMatches.push({
        item_id:       cat.item_id,
        item_name:     cat.item_name,
        question_id:   cat.question_id,
        question_text: cat.question_text,
        scale_kind:    cat.scale_kind,
        n_responses:   cat.n_responses,
        fielding_ids:  cat.fielding_ids,
        confidence:    typeof m.confidence === 'number'
                         ? Math.round(m.confidence * 100) / 100
                         : null,
      });
    }
    if (hydratedMatches.length === 0) continue;

    let primary = hydratedMatches.find(m => m.item_id === Number(rule.primary_match_item_id));
    if (!primary) primary = hydratedMatches[0];

    const validCriteria = (CRITERION_OPTIONS[primary.scale_kind] || []).map(o => o.value);
    let criterion = rule.detected_criterion;
    if (!validCriteria.includes(criterion)) {
      invalidCriteria++;
      criterion = validCriteria[0] || null;
      if (!criterion) continue;
    }

    validRules.push({
      concept:               rule.concept || '',
      matched_items:         hydratedMatches,
      primary_match_item_id: primary.item_id,
      primary_scale_kind:    primary.scale_kind,
      detected_criterion:    criterion,
      rationale:             rule.rationale || '',
    });
  }

  let logicalOperator = (parsed.logical_operator || '').toString().toUpperCase();
  if (logicalOperator !== 'AND' && logicalOperator !== 'OR') logicalOperator = 'AND';

  return {
    rules: validRules,
    logical_operator: logicalOperator,
    unresolved_concepts: Array.isArray(parsed.unresolved_concepts) ? parsed.unresolved_concepts : [],
    diagnostics: {
      invalid_items_dropped: invalidItems,
      invalid_criteria_dropped: invalidCriteria,
    },
  };
}

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) {
    return { statusCode: 400, body: 'invalid JSON' };
  }
  const jobId = body.job_id;
  if (!jobId) return { statusCode: 400, body: 'missing job_id' };

  await supabase.from('bjl_query_jobs').update({ status: 'running' }).eq('job_id', jobId);

  try {
    const { data: job, error: loadErr } = await supabase
      .from('bjl_query_jobs')
      .select('*')
      .eq('job_id', jobId)
      .single();
    if (loadErr) throw new Error(`load job: ${loadErr.message}`);

    const description = (job.extra_context && job.extra_context.description) || '';
    if (!description) throw new Error('extra_context.description missing');

    const catalog = await loadCleanCatalog();
    const parsed = await callParseLLM({ description, catalog });
    const result = validateAndHydrate(parsed, catalog);
    result.diagnostics.catalog_size = catalog.length;
    result.diagnostics.model = PARSE_MODEL;

    await supabase.from('bjl_query_jobs').update({
      status: 'complete',
      finding: JSON.stringify(result),
      scratch: { rule_count: result.rules.length, unresolved_count: result.unresolved_concepts.length },
      completed_at: new Date().toISOString(),
    }).eq('job_id', jobId);

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('[bjl-joy-map-audience-parse-background] error:', err);
    await supabase.from('bjl_query_jobs').update({
      status: 'error',
      error: String(err.message || err).slice(0, 1000),
      completed_at: new Date().toISOString(),
    }).eq('job_id', jobId);
    return { statusCode: 500, body: String(err.message || err) };
  }
};
