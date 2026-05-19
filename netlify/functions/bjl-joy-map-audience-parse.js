/**
 * bjl-joy-map-audience-parse.js — parse a free-text audience description
 * into structured joy-pattern rules using an LLM (Joy Map Phase 1.5 v3,
 * Delta 1).
 *
 * POST /.netlify/functions/bjl-joy-map-audience-parse
 * body: { description: <string> }
 *
 * Pipeline:
 *   1. Load bjl_items_clean (pre-filtered to n_responses >= 100)
 *      restricted to picker-eligible question types.
 *   2. Attach the scale_kind classification per item.
 *   3. Call Haiku 4.5 with the joy_map_audience_parse system prompt and
 *      a user message containing the description + catalog + criterion
 *      options.
 *   4. Parse the JSON return, validate every item_id exists in the
 *      catalog and every detected_criterion is valid for its scale_kind.
 *      Drop invalid rules; surface them in diagnostics.
 *
 * Returns:
 *   {
 *     rules: [<validated rule with full hydrated fields>, ...],
 *     unresolved_concepts: [<string>, ...],
 *     diagnostics: { invalid_items_dropped: N, invalid_criteria_dropped: N,
 *                    catalog_size: N, model: "claude-haiku-4-5" }
 *   }
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;
const { verifyAndAuthorize } = require('./bjl-auth-helper');
const {
  PICKER_QUESTION_TYPES,
  CRITERION_OPTIONS,
  classifyScaleKind,
} = require('./bjl-joy-pattern-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const PROMPTS = require('./_prompts_bundle.json');

const PARSE_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 4000;

async function loadCleanCatalog() {
  // Load every clean item whose question_type is picker-eligible. Attach
  // scale_kind on the way out so the LLM (and our validator) can key off it.
  // fielding_ids[] travels through for cross-fielding cohort detection.
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

  // The LLM doesn't need question_id; trim to keep the context tight.
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
    // Match items against the catalog
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

    // Pick primary; honor the LLM's choice if valid, else first match
    let primary = hydratedMatches.find(m => m.item_id === Number(rule.primary_match_item_id));
    if (!primary) primary = hydratedMatches[0];

    // Validate criterion against the primary's scale_kind
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

  // Normalize logical_operator. Default AND when unspecified.
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
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message, email: auth.email })
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid JSON' }) };
  }
  const description = (body.description || '').trim();
  if (!description) {
    return { statusCode: 400, body: JSON.stringify({ error: 'description required' }) };
  }
  if (description.length > 4000) {
    return { statusCode: 400, body: JSON.stringify({ error: 'description too long (max 4000 chars)' }) };
  }

  try {
    const catalog = await loadCleanCatalog();
    const parsed = await callParseLLM({ description, catalog });
    const result = validateAndHydrate(parsed, catalog);
    result.diagnostics.catalog_size = catalog.length;
    result.diagnostics.model = PARSE_MODEL;
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('[bjl-joy-map-audience-parse] error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'audience parse failed', detail: String(err.message || err) }),
    };
  }
};
