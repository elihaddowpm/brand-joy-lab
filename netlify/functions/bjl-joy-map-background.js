/**
 * bjl-joy-map-background.js — async worker for Joy Map jobs.
 *
 * Pipeline:
 *   1. Load job
 *   2. Build cohort filter SQL from audience_filters
 *   3. Query audience joy profile (Layer 1 / 2 / 3 top items for cohort)
 *   4. If workflow=audience_profile: format directly and finish
 *   5. If workflow=dance_map: query corpus-wide catalog, call Sonnet
 *      with joy_map_synthesis prompt, augment Layer 3 cards with
 *      bjl_tag_precision band, finish
 *
 * Writes structured result to bjl_query_jobs.finding as a JSON string,
 * plus a brief one-line summary that the frontend can show as a header.
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;
const { buildJoyPatternCohortSQL } = require('./bjl-joy-pattern-helper');
const { extractWaldoBrandFields } = require('./bjl-waldo-extractor');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const PROMPTS = require('./_prompts_bundle.json');

const SYNTHESIS_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8000;

// Layer 1: 9-point joy scale (or 6-point joy_scale_0_to_5).
// Layer 2: each sub-type maps to one or more question_types.
const LAYER_2_SUBTYPES = {
  '2a': ['description_scale_0_to_5', 'agreement_scale', 'importance_scale_0_to_5'],
  '2b': ['select_all', 'multi_select'],
  '2c': ['likelihood_scale'],
  '2d': ['familiarity_scale'],
  '2e': ['importance_scale'],
};

// ---------------------------------------------------------------------------
// Filter SQL builder
// ---------------------------------------------------------------------------

function quote(s) {
  if (s === null || s === undefined) return 'NULL';
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Build the cohort filter clause used by every cohort query. All queries
 * follow the pattern "JOIN bjl_respondents resp ... WHERE ${cohortFilter}",
 * so this returns a SQL string that goes in that slot.
 *
 * Phase 1.5 supports three audience modes:
 *   - demographic: just demographic equality clauses on resp.*
 *   - joy_pattern: resp.respondent_id IN (intersection-of-rules subquery)
 *   - combined:    both, AND'd together
 *
 * Returns '1=1' when nothing is specified (full corpus).
 */
function buildCohortFilter(mode, filters, joyPatternRules) {
  const f = filters || {};
  const demographicClauses = [];
  if (mode === 'demographic' || mode === 'combined') {
    if (f.age_band)        demographicClauses.push(`resp.age_band = ${quote(f.age_band)}`);
    if (f.gender)          demographicClauses.push(`resp.gender = ${quote(f.gender)}`);
    if (f.income_bracket)  demographicClauses.push(`resp.income_bracket = ${quote(f.income_bracket)}`);
    if (f.region)          demographicClauses.push(`resp.region = ${quote(f.region)}`);
    if (f.parental_status) demographicClauses.push(`resp.parental_status = ${quote(f.parental_status)}`);
    if (f.marital_status)  demographicClauses.push(`resp.marital_status = ${quote(f.marital_status)}`);
  }

  let joyPatternClause = null;
  if (mode === 'joy_pattern' || mode === 'combined') {
    const sub = buildJoyPatternCohortSQL(joyPatternRules || []);
    if (sub) joyPatternClause = `resp.respondent_id IN ${sub}`;
  }

  const all = [...demographicClauses];
  if (joyPatternClause) all.push(joyPatternClause);
  return all.length ? all.join(' AND ') : '1=1';
}

// ---------------------------------------------------------------------------
// Audience profile queries (cohort)
// ---------------------------------------------------------------------------

async function queryCohortN(cohortFilter) {
  const sql = `
    SELECT COUNT(*) AS n
    FROM bjl_respondents resp
    WHERE ${cohortFilter}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`cohort n query: ${error.message}`);
  return Number((data && data[0] && data[0].n) || 0);
}

async function queryLayer1Cohort(cohortFilter, limit = 25) {
  // Layer 1 JI for the cohort, paired with the corpus baseline JI on the
  // same item so the synthesis LLM can populate the cohort-vs-corpus delta.
  const sql = `
    WITH cohort AS (
      SELECT i.item_id, i.item_name,
             ROUND(AVG(r.joy_index)::numeric, 1) AS metric_value,
             COUNT(*) AS cohort_n
      FROM bjl_responses r
      JOIN bjl_items i ON i.item_id = r.item_id
      JOIN bjl_questions_v2 q ON q.question_id = i.question_id
      JOIN bjl_respondents resp ON resp.respondent_id = r.respondent_id
      WHERE q.question_type IN ('joy_scale', 'joy_scale_0_to_5')
        AND r.joy_index IS NOT NULL
        AND (q.scale_type = 'ordinal_-3_to_5' OR q.scale_type IS NULL OR q.question_type = 'joy_scale_0_to_5')
        AND ${cohortFilter}
      GROUP BY i.item_id, i.item_name
      HAVING COUNT(*) >= 30
    ),
    corpus AS (
      SELECT i.item_id,
             ROUND(AVG(r.joy_index)::numeric, 1) AS corpus_value,
             COUNT(*) AS corpus_n
      FROM bjl_responses r
      JOIN bjl_items i ON i.item_id = r.item_id
      JOIN bjl_questions_v2 q ON q.question_id = i.question_id
      WHERE q.question_type IN ('joy_scale', 'joy_scale_0_to_5')
        AND r.joy_index IS NOT NULL
        AND (q.scale_type = 'ordinal_-3_to_5' OR q.scale_type IS NULL OR q.question_type = 'joy_scale_0_to_5')
      GROUP BY i.item_id
    )
    SELECT c.item_id, c.item_name, c.metric_value, c.cohort_n,
           x.corpus_value, x.corpus_n
    FROM cohort c
    LEFT JOIN corpus x ON x.item_id = c.item_id
    ORDER BY c.metric_value DESC
    LIMIT ${limit}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`layer 1 cohort: ${error.message}`);
  return (data || []).map(r => ({
    ...r,
    layer: '1',
    metric_label: 'JI',
  }));
}

async function queryLayer2aCohort(cohortFilter, limit = 25) {
  // Top-box on 3-point ordinal items. "Top" = "Very much so" / strongest endorsement.
  // Returns both cohort top-box AND corpus baseline so the synthesis LLM can
  // pick which to surface per the conditional cohort-slicing protocol
  // (cohort when cohort_n >= 50; corpus baseline otherwise, with the source labeled).
  const sql = `
    WITH cohort AS (
      SELECT i.item_id, i.item_name,
             ROUND(100.0 * COUNT(*) FILTER (WHERE r.raw_value ILIKE 'Very much%' OR r.raw_value ILIKE 'Strongly%') / NULLIF(COUNT(*),0), 1) AS metric_value,
             COUNT(*) AS cohort_n
      FROM bjl_responses r
      JOIN bjl_items i ON i.item_id = r.item_id
      JOIN bjl_questions_v2 q ON q.question_id = i.question_id
      JOIN bjl_respondents resp ON resp.respondent_id = r.respondent_id
      WHERE (
          q.question_type IN ('description_scale_0_to_5','agreement_scale','importance_scale_0_to_5')
          OR (q.question_type = 'joy_scale' AND q.scale_type = 'ordinal_3pt_joy')
        )
        AND ${cohortFilter}
      GROUP BY i.item_id, i.item_name
    ),
    corpus AS (
      SELECT i.item_id,
             ROUND(100.0 * COUNT(*) FILTER (WHERE r.raw_value ILIKE 'Very much%' OR r.raw_value ILIKE 'Strongly%') / NULLIF(COUNT(*),0), 1) AS corpus_value,
             COUNT(*) AS corpus_n
      FROM bjl_responses r
      JOIN bjl_items i ON i.item_id = r.item_id
      JOIN bjl_questions_v2 q ON q.question_id = i.question_id
      WHERE (
          q.question_type IN ('description_scale_0_to_5','agreement_scale','importance_scale_0_to_5')
          OR (q.question_type = 'joy_scale' AND q.scale_type = 'ordinal_3pt_joy')
        )
      GROUP BY i.item_id
    )
    SELECT c.item_id, c.item_name, c.metric_value, c.cohort_n,
           x.corpus_value, x.corpus_n
    FROM cohort c
    LEFT JOIN corpus x ON x.item_id = c.item_id
    ORDER BY c.metric_value DESC NULLS LAST
    LIMIT ${limit}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`layer 2a cohort: ${error.message}`);
  return (data || []).map(r => ({ ...r, layer: '2a', metric_label: 'TB%' }));
}

async function queryLayer2bCohort(cohortFilter, limit = 25) {
  // select_all / multi_select — share of respondents selecting each item.
  // Denominator = respondents who saw the question (any non-null response for that question_id).
  // Also returns corpus baseline so synthesis can apply conditional cohort-slicing.
  const sql = `
    WITH question_base AS (
      SELECT i.question_id, COUNT(DISTINCT r.respondent_id) AS base_n
      FROM bjl_responses r
      JOIN bjl_items i ON i.item_id = r.item_id
      JOIN bjl_questions_v2 q ON q.question_id = i.question_id
      JOIN bjl_respondents resp ON resp.respondent_id = r.respondent_id
      WHERE q.question_type IN ('select_all','multi_select')
        AND ${cohortFilter}
      GROUP BY i.question_id
    ),
    corpus_base AS (
      SELECT i.question_id, COUNT(DISTINCT r.respondent_id) AS base_n
      FROM bjl_responses r
      JOIN bjl_items i ON i.item_id = r.item_id
      JOIN bjl_questions_v2 q ON q.question_id = i.question_id
      WHERE q.question_type IN ('select_all','multi_select')
      GROUP BY i.question_id
    ),
    corpus_item AS (
      SELECT i.item_id, COUNT(DISTINCT r.respondent_id) AS sel_n
      FROM bjl_responses r
      JOIN bjl_items i ON i.item_id = r.item_id
      WHERE r.is_selected = true
      GROUP BY i.item_id
    )
    SELECT i.item_id, i.item_name,
           ROUND(100.0 * COUNT(DISTINCT r.respondent_id) / NULLIF(qb.base_n,0), 1) AS metric_value,
           qb.base_n AS cohort_n,
           ROUND(100.0 * ci.sel_n / NULLIF(cb.base_n,0), 1) AS corpus_value,
           cb.base_n AS corpus_n
    FROM bjl_responses r
    JOIN bjl_items i ON i.item_id = r.item_id
    JOIN question_base qb ON qb.question_id = i.question_id
    JOIN corpus_base cb ON cb.question_id = i.question_id
    LEFT JOIN corpus_item ci ON ci.item_id = i.item_id
    JOIN bjl_respondents resp ON resp.respondent_id = r.respondent_id
    WHERE r.is_selected = true
      AND ${cohortFilter}
    GROUP BY i.item_id, i.item_name, qb.base_n, ci.sel_n, cb.base_n
    ORDER BY metric_value DESC NULLS LAST
    LIMIT ${limit}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`layer 2b cohort: ${error.message}`);
  return (data || []).map(r => ({ ...r, layer: '2b', metric_label: 'TB%' }));
}

async function queryLayer3Cohort(cohortFilter, limit = 60) {
  // Tag frequencies in verbatims for this cohort, paired with corpus tag
  // rate so the synthesis LLM can populate the cohort-vs-corpus delta.
  const sql = `
    WITH cohort_verbatims AS (
      SELECT v.id, v.joy_modes, v.tensions, v.functional_jobs, v.occasions
      FROM bjl_verbatims v
      JOIN bjl_respondents resp ON resp.respondent_id = v.respondent_id
      WHERE ${cohortFilter}
    ),
    cohort_total AS (SELECT COUNT(*)::numeric AS n FROM cohort_verbatims),
    cohort_counts AS (
      SELECT 'joy_modes'::text AS framework, t AS tag, COUNT(*) AS n
      FROM cohort_verbatims, unnest(joy_modes) t WHERE joy_modes IS NOT NULL GROUP BY t
      UNION ALL
      SELECT 'tensions', t, COUNT(*) FROM cohort_verbatims, unnest(tensions) t WHERE tensions IS NOT NULL GROUP BY t
      UNION ALL
      SELECT 'functional_jobs', t, COUNT(*) FROM cohort_verbatims, unnest(functional_jobs) t WHERE functional_jobs IS NOT NULL GROUP BY t
      UNION ALL
      SELECT 'occasions', t, COUNT(*) FROM cohort_verbatims, unnest(occasions) t WHERE occasions IS NOT NULL GROUP BY t
    ),
    corpus_total AS (SELECT COUNT(*)::numeric AS n FROM bjl_verbatims),
    corpus_counts AS (
      SELECT 'joy_modes'::text AS framework, t AS tag, COUNT(*) AS n
      FROM bjl_verbatims, unnest(joy_modes) t WHERE joy_modes IS NOT NULL GROUP BY t
      UNION ALL
      SELECT 'tensions', t, COUNT(*) FROM bjl_verbatims, unnest(tensions) t WHERE tensions IS NOT NULL GROUP BY t
      UNION ALL
      SELECT 'functional_jobs', t, COUNT(*) FROM bjl_verbatims, unnest(functional_jobs) t WHERE functional_jobs IS NOT NULL GROUP BY t
      UNION ALL
      SELECT 'occasions', t, COUNT(*) FROM bjl_verbatims, unnest(occasions) t WHERE occasions IS NOT NULL GROUP BY t
    )
    SELECT c.framework, c.tag,
           c.n AS cohort_n,
           ROUND(100.0 * c.n / NULLIF((SELECT n FROM cohort_total),0), 1) AS metric_value,
           x.n AS corpus_n,
           ROUND(100.0 * x.n / NULLIF((SELECT n FROM corpus_total),0), 1) AS corpus_value
    FROM cohort_counts c
    LEFT JOIN corpus_counts x ON x.framework = c.framework AND x.tag = c.tag
    WHERE c.n >= 100
    ORDER BY c.n DESC
    LIMIT ${limit}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`layer 3 cohort: ${error.message}`);
  return (data || []).map(r => ({ ...r, layer: '3', metric_label: 'Tag rate' }));
}

// ---------------------------------------------------------------------------
// Corpus-wide catalog (for the LLM mapping pass on dance_map)
// ---------------------------------------------------------------------------

async function queryCatalogLayer1(limit = 120) {
  const sql = `
    SELECT i.item_id, i.item_name, q.question_text,
           ROUND(AVG(r.joy_index)::numeric, 1) AS corpus_ji,
           COUNT(*) AS corpus_n
    FROM bjl_responses r
    JOIN bjl_items i ON i.item_id = r.item_id
    JOIN bjl_questions_v2 q ON q.question_id = i.question_id
    WHERE q.question_type IN ('joy_scale', 'joy_scale_0_to_5')
      AND r.joy_index IS NOT NULL
      AND (q.scale_type = 'ordinal_-3_to_5' OR q.scale_type IS NULL OR q.question_type = 'joy_scale_0_to_5')
    GROUP BY i.item_id, i.item_name, q.question_text
    HAVING COUNT(*) >= 100
    ORDER BY corpus_ji DESC
    LIMIT ${limit}
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`catalog L1: ${error.message}`);
  return data || [];
}

async function queryCatalogLayer2(limit = 200) {
  // Mix of 2a + 2b + 2c + 2d items by top-box / selection rate.
  const sql = `
    WITH ordinal_items AS (
      SELECT i.item_id, i.item_name, q.question_text, q.question_type AS qtype,
             ROUND(100.0 * COUNT(*) FILTER (WHERE r.raw_value ILIKE 'Very much%' OR r.raw_value ILIKE 'Strongly%' OR r.raw_value ILIKE 'Very%') / NULLIF(COUNT(*),0), 1) AS top_pct,
             COUNT(*) AS corpus_n
      FROM bjl_responses r
      JOIN bjl_items i ON i.item_id = r.item_id
      JOIN bjl_questions_v2 q ON q.question_id = i.question_id
      WHERE q.question_type IN ('description_scale_0_to_5','agreement_scale','importance_scale_0_to_5','likelihood_scale','familiarity_scale')
         OR (q.question_type = 'joy_scale' AND q.scale_type = 'ordinal_3pt_joy')
      GROUP BY i.item_id, i.item_name, q.question_text, q.question_type
      HAVING COUNT(*) >= 100
      ORDER BY top_pct DESC NULLS LAST
      LIMIT ${limit}
    )
    SELECT * FROM ordinal_items
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`catalog L2: ${error.message}`);
  return data || [];
}

async function queryCatalogLayer3Taxonomy() {
  // Framework tag definitions + corpus rates for the LLM context.
  const sql = `
    WITH tag_rates AS (
      SELECT 'joy_modes'::text AS framework, t AS tag, COUNT(*) AS n FROM bjl_verbatims, unnest(joy_modes) t WHERE joy_modes IS NOT NULL GROUP BY t
      UNION ALL
      SELECT 'tensions', t, COUNT(*) FROM bjl_verbatims, unnest(tensions) t WHERE tensions IS NOT NULL GROUP BY t
      UNION ALL
      SELECT 'functional_jobs', t, COUNT(*) FROM bjl_verbatims, unnest(functional_jobs) t WHERE functional_jobs IS NOT NULL GROUP BY t
      UNION ALL
      SELECT 'occasions', t, COUNT(*) FROM bjl_verbatims, unnest(occasions) t WHERE occasions IS NOT NULL GROUP BY t
    )
    SELECT tr.framework, tr.tag,
           CASE tr.framework
             WHEN 'joy_modes' THEN (SELECT short_definition FROM bjl_joy_modes WHERE mode_key = tr.tag)
             WHEN 'tensions' THEN (SELECT description FROM bjl_tensions WHERE tension_key = tr.tag)
             WHEN 'functional_jobs' THEN (SELECT description FROM bjl_functional_jobs WHERE job_key = tr.tag)
             WHEN 'occasions' THEN (SELECT description FROM bjl_occasions WHERE occasion_key = tr.tag)
           END AS definition,
           tr.n AS corpus_n,
           c.confidence_band
    FROM tag_rates tr
    LEFT JOIN bjl_tag_calibration c ON c.framework = tr.framework AND c.tag_key = tr.tag
    ORDER BY tr.framework, tr.n DESC
  `;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`catalog L3: ${error.message}`);
  return data || [];
}

// ---------------------------------------------------------------------------
// Synthesis LLM call (dance_map only)
// ---------------------------------------------------------------------------

function buildSynthesisUserMessage({ brandText, brandJson, audienceProfile, audienceFilters, cohortN, catalog }) {
  // Build the brand payload. Two paths:
  //   - brandJson (Waldo JSON): source-aware extraction into three labeled
  //     arrays (emphasis, tactical, friction). Excluded paths (perceived_gaps,
  //     category, demographics, milestones, employee_sentiment) are dropped.
  //   - brand_text (free-text): single emphasis block, no source attribution.
  // Either way, the LLM must only quote from labeled emphasis/tactical/
  // friction blocks. The prompt enforces this.
  let brandSection;
  if (brandJson) {
    const fields = extractWaldoBrandFields(brandJson);
    brandSection = [
      'BRAND INPUT (Waldo JSON, source-aware extraction):',
      '',
      `brand_emphasis (positioning claims — eligible for alignment OR misalignment):`,
      JSON.stringify(fields.emphasis, null, 2),
      '',
      `brand_tactical_signals (actions, not positioning — weak signal, default to caution):`,
      JSON.stringify(fields.tactical, null, 2),
      '',
      `brand_friction_points (consumer-reported pain — opportunity-eligible only, NEVER misalignment):`,
      JSON.stringify(fields.friction, null, 2),
    ].join('\n');
  } else {
    brandSection = [
      'BRAND INPUT (free-text — treat as a single emphasis blob):',
      '',
      'brand_emphasis:',
      JSON.stringify([{ snippet: brandText || '', source_path: 'free_text' }], null, 2),
      '',
      'brand_tactical_signals: []',
      'brand_friction_points: []',
    ].join('\n');
  }

  return [
    brandSection,
    '',
    'AUDIENCE FILTERS:',
    JSON.stringify(audienceFilters, null, 2),
    `(cohort n = ${cohortN})`,
    '',
    'AUDIENCE PROFILE (this cohort\'s top items):',
    JSON.stringify(audienceProfile, null, 2),
    '',
    'BJL ITEM CATALOG (corpus-wide reference for mapping):',
    JSON.stringify(catalog, null, 2),
  ].join('\n');
}

async function callSynthesisLLM(payload) {
  const systemPrompt = PROMPTS.joyMapSynthesis;
  if (!systemPrompt) throw new Error('joy_map_synthesis prompt missing from bundle');
  const userMessage = buildSynthesisUserMessage(payload);

  const rsp = await anthropic.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: systemPrompt }],
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = (rsp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  // The model is instructed to return JSON only, but defensively strip code fences.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(cleaned);
}

// ---------------------------------------------------------------------------
// Augment Layer 3 cards with calibration confidence band
// ---------------------------------------------------------------------------

async function augmentLayer3Confidence(cards) {
  const layer3 = cards.filter(c => String(c.layer) === '3' && c.framework && c.bjl_item_name);
  if (!layer3.length) return cards;
  const keys = layer3.map(c => `(${quote(c.framework)},${quote(c.bjl_item_name)})`).join(',');
  const sql = `
    SELECT framework, tag_key, confidence_band
    FROM bjl_tag_calibration
    WHERE (framework, tag_key) IN (${keys})
  `;
  const { data } = await supabase.rpc('execute_read_sql', { query_text: sql });
  const map = new Map();
  for (const row of data || []) {
    map.set(`${row.framework}|${row.tag_key}`, row.confidence_band);
  }
  for (const c of cards) {
    if (String(c.layer) === '3' && c.framework && c.bjl_item_name) {
      const band = map.get(`${c.framework}|${c.bjl_item_name}`);
      if (band) c.calibration_band = band;
    }
  }
  return cards;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: 'invalid JSON' };
  }
  const jobId = body.job_id;
  if (!jobId) return { statusCode: 400, body: 'missing job_id' };

  // Mark running
  await supabase.from('bjl_query_jobs').update({ status: 'running' }).eq('job_id', jobId);

  try {
    const { data: job, error: loadErr } = await supabase
      .from('bjl_query_jobs')
      .select('*')
      .eq('job_id', jobId)
      .single();
    if (loadErr) throw new Error(`load job: ${loadErr.message}`);

    const ctx = job.extra_context || {};
    const workflow = ctx.workflow;
    const audienceMode = ctx.audience_mode || 'demographic';
    const audienceFilters = ctx.audience_filters || {};
    const joyPatternRules = Array.isArray(ctx.joy_pattern_rules) ? ctx.joy_pattern_rules : [];
    const cohortFilter = buildCohortFilter(audienceMode, audienceFilters, joyPatternRules);

    const cohortN = await queryCohortN(cohortFilter);

    const [l1, l2a, l2b, l3] = await Promise.all([
      queryLayer1Cohort(cohortFilter, 25),
      queryLayer2aCohort(cohortFilter, 25),
      queryLayer2bCohort(cohortFilter, 25),
      queryLayer3Cohort(cohortFilter, 60),
    ]);

    const audienceProfile = {
      cohort_n: cohortN,
      audience_mode: audienceMode,
      filters_applied: audienceFilters,
      joy_pattern_rules: joyPatternRules,
      layer_1_top_items: l1,
      layer_2_top_items: [...l2a, ...l2b],
      layer_3_top_tags:  l3,
    };

    let finding;
    let oneLine;

    if (workflow === 'audience_profile') {
      finding = {
        workflow,
        audience_profile: audienceProfile,
      };
      oneLine = `Audience joy profile for cohort (n=${cohortN}). `
        + `Top JI item: ${l1[0]?.item_name || '—'}. `
        + `Top tag: ${l3[0]?.tag || '—'}.`;
    } else if (workflow === 'dance_map') {
      // Build catalog
      const [catalogL1, catalogL2, catalogL3] = await Promise.all([
        queryCatalogLayer1(120),
        queryCatalogLayer2(150),
        queryCatalogLayer3Taxonomy(),
      ]);
      const catalog = {
        layer_1: catalogL1,
        layer_2: catalogL2,
        layer_3_taxonomy: catalogL3,
      };

      const llmResult = await callSynthesisLLM({
        brandText: ctx.brand_text,
        brandJson: ctx.brand_json,
        audienceProfile,
        audienceFilters,
        cohortN,
        catalog,
      });

      // Cap each section at 5 cards (defensive — prompt asks for this too).
      ['strong_alignment', 'misalignment', 'untapped_opportunity'].forEach(k => {
        if (Array.isArray(llmResult[k]) && llmResult[k].length > 5) {
          llmResult[k] = llmResult[k].slice(0, 5);
        }
      });

      // Augment Layer 3 cards with calibration band labels
      const allCards = [
        ...(llmResult.strong_alignment || []),
        ...(llmResult.misalignment || []),
        ...(llmResult.untapped_opportunity || []),
      ];
      await augmentLayer3Confidence(allCards);

      finding = {
        workflow,
        audience_profile: audienceProfile,
        dance_map: llmResult,
      };
      const counts = [
        `${(llmResult.strong_alignment || []).length} alignment`,
        `${(llmResult.misalignment || []).length} misalignment`,
        `${(llmResult.untapped_opportunity || []).length} opportunity`,
      ].join(' / ');
      oneLine = `Dance map for cohort (n=${cohortN}): ${counts}.`;
    } else {
      throw new Error(`unknown workflow: ${workflow}`);
    }

    await supabase.from('bjl_query_jobs').update({
      status: 'complete',
      finding: JSON.stringify(finding),
      scratch: { one_line_summary: oneLine },
      completed_at: new Date().toISOString(),
    }).eq('job_id', jobId);

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    await supabase.from('bjl_query_jobs').update({
      status: 'error',
      error: String(err.message || err).slice(0, 1000),
      completed_at: new Date().toISOString(),
    }).eq('job_id', jobId);
    return { statusCode: 500, body: String(err.message || err) };
  }
};
