/**
 * bjl-audience-map-background.js — 4-pass async worker for the
 * Audience Map workflow (Joy Map Phase 2).
 *
 * Pipeline:
 *
 *   Pass 1 — ROUTING.   Haiku 4.5 reads the description and the clean
 *                       catalog; picks one of five seed strategies and
 *                       returns the seed cohort definition(s) + a routing
 *                       notice.
 *
 *   Pass 2 — PROFILE.   Build the seed cohort's respondent_id set in SQL;
 *                       pull its Layer 1 universal-core JI, Layer 3 tag
 *                       rates (all four frameworks), and demographic
 *                       distribution. Compute the corpus baselines on the
 *                       same items/tags/fields and compute deltas.
 *
 *   Pass 3 — SYNTHESIS. Sonnet 4.6 takes the seed profile and authors:
 *                         (a) the parameter set (4–8 items that define
 *                             the audience without the seed-item tautology)
 *                         (b) the editorial layer of the six output
 *                             sections (themes, notes, paragraph, picked
 *                             decision_context batteries).
 *
 *   Pass 4 — REVERSE.   Apply the parameter set to the full corpus,
 *                       producing the reverse-engineered audience. Pull the
 *                       SAME profile structure on this cohort. Merge
 *                       Pass 3's editorial layer with the reverse-engineered
 *                       numbers — Joy Peaks items inherit Pass 4's deltas;
 *                       items that no longer survive the reverse cohort are
 *                       dropped from themes; emotional signature top 5
 *                       come from the reverse cohort; demographics from
 *                       the reverse cohort.
 *
 * Final finding shape (written to bjl_query_jobs.finding):
 *   {
 *     workflow: 'audience_map',
 *     description,
 *     routing: { strategy, routing_notice, rationale, seed_definition },
 *     seed_cohort_n,
 *     reverse_engineered_cohort_n,
 *     parameters: [...],
 *     sections: { synthesis_paragraph, joy_peaks, joy_valleys,
 *                 emotional_signature, decision_context, demographic_shape },
 *     diagnostics: { ... }
 *   }
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;
const { classifyScaleKind } = require('./bjl-joy-pattern-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const PROMPTS = require('./_prompts_bundle.json');

const ROUTING_MODEL = 'claude-haiku-4-5-20251001';
const SYNTHESIS_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8000;

const LOW_N_WARN_THRESHOLD = 100;
const LOW_N_REFUSE_THRESHOLD = 30;

// =====================================================================
// Helpers
// =====================================================================

function quote(s) {
  if (s === null || s === undefined) return 'NULL';
  return `'${String(s).replace(/'/g, "''")}'`;
}
function quoteList(arr) {
  return (arr || []).map(quote).join(',');
}

async function execSQL(sql, label) {
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) throw new Error(`${label}: ${error.message}`);
  return data || [];
}

function parseLLMJSON(text) {
  const cleaned = (text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

// Convert a criterion key (max_joy / top_quartile / above_median / selected /
// top_2_box / top_box / very_much_so / strongly_agree / very_likely / etc.)
// into a SQL clause fragment against bjl_responses r. Mirrors
// bjl-joy-pattern-helper's buildCriterionClause but lives here so this
// module is self-contained for the audience-map path.
function criterionClause(criterion) {
  switch (criterion) {
    case 'max_joy':       return 'r.numeric_value = 5';
    case 'top_quartile':  return 'r.numeric_value >= 3';
    case 'above_median':  return 'r.numeric_value > 0';
    case 'top_2_box':     return "(r.numeric_value >= 4 OR r.raw_value ILIKE 'Very %' OR r.raw_value ILIKE 'Somewhat %' OR r.raw_value ILIKE 'Strongly agree%')";
    case 'top_box':       return "(r.numeric_value = 5 OR r.raw_value ILIKE 'Very much%' OR r.raw_value ILIKE 'Strongly agree%' OR r.raw_value ILIKE 'Very likely%' OR r.raw_value ILIKE 'Very familiar%' OR r.raw_value ILIKE 'One of my favorites%')";
    case 'very_much_so':  return "(r.raw_value ILIKE 'Very much%' OR r.raw_value ILIKE 'One of my favorites%')";
    case 'strongly_agree': return "r.raw_value ILIKE 'Strongly agree%'";
    case 'very_likely':   return "r.raw_value ILIKE 'Very likely%'";
    case 'very_familiar': return "r.raw_value ILIKE 'Very familiar%'";
    case 'selected':      return 'r.is_selected = true';
    case 'not_selected':  return '(r.is_selected = false OR r.is_selected IS NULL)';
    default:              return null;
  }
}

// =====================================================================
// Pass 1: Routing
// =====================================================================

async function loadCleanCatalogForRouting() {
  const sql = `
    SELECT item_id, item_name, question_id, question_text,
           question_type, scale_type, n_responses, fielding_ids
    FROM bjl_items_clean
    ORDER BY n_responses DESC
  `;
  const rows = await execSQL(sql, 'routing catalog load');
  return rows
    .map(r => ({
      item_id: r.item_id,
      item_name: r.item_name,
      question_id: r.question_id,
      question_text: r.question_text,
      scale_kind: classifyScaleKind(r.question_type, r.scale_type),
      n_responses: r.n_responses,
      fielding_ids: r.fielding_ids || [],
    }))
    .filter(r => r.scale_kind !== null);
}

async function loadDemographicVocab() {
  const sql = `
    SELECT
      ARRAY(SELECT DISTINCT age_band FROM bjl_respondents WHERE age_band IS NOT NULL ORDER BY age_band) AS age_band,
      ARRAY(SELECT DISTINCT generation FROM bjl_respondents WHERE generation IS NOT NULL ORDER BY generation) AS generation,
      ARRAY(SELECT DISTINCT gender FROM bjl_respondents WHERE gender IS NOT NULL ORDER BY gender) AS gender,
      ARRAY(SELECT DISTINCT income_bracket FROM bjl_respondents WHERE income_bracket IS NOT NULL ORDER BY income_bracket) AS income_bracket,
      ARRAY(SELECT DISTINCT region FROM bjl_respondents WHERE region IS NOT NULL ORDER BY region) AS region,
      ARRAY(SELECT DISTINCT marital_status FROM bjl_respondents WHERE marital_status IS NOT NULL ORDER BY marital_status) AS marital_status,
      ARRAY(SELECT DISTINCT parental_status FROM bjl_respondents WHERE parental_status IS NOT NULL ORDER BY parental_status) AS parental_status
  `;
  const rows = await execSQL(sql, 'demographic vocab load');
  return rows[0] || {};
}

async function pass1Routing(description, catalog, demographicVocab) {
  const systemPrompt = PROMPTS.audienceMapRouting;
  if (!systemPrompt) throw new Error('audience_map_routing prompt missing from bundle');

  // The LLM needs item_id, name, question_text, scale_kind, n_responses.
  // Dropping fielding_ids here to keep the routing context lean.
  const catalogForLLM = catalog.map(c => ({
    item_id: c.item_id,
    item_name: c.item_name,
    question_text: c.question_text,
    scale_kind: c.scale_kind,
    n_responses: c.n_responses,
  }));

  const userMessage = [
    'description:',
    description,
    '',
    `catalog (${catalog.length} items, n_responses >= 100):`,
    JSON.stringify(catalogForLLM),
    '',
    'demographic_fields (literal values from bjl_respondents):',
    JSON.stringify(demographicVocab, null, 2),
  ].join('\n');

  const rsp = await anthropic.messages.create({
    model: ROUTING_MODEL,
    max_tokens: 2500,
    system: [{ type: 'text', text: systemPrompt }],
    messages: [{ role: 'user', content: userMessage }],
  });
  const text = (rsp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return parseLLMJSON(text);
}

// =====================================================================
// Cohort builders (used by Pass 2 + Pass 4)
// =====================================================================

function demographicClauseSQL(filter, alias) {
  const a = alias || 'resp';
  const f = filter || {};
  const out = [];
  for (const key of ['age_band','generation','gender','income_bracket','region','parental_status','marital_status']) {
    const v = f[key];
    if (Array.isArray(v) && v.length > 0) {
      out.push(`${a}.${key} IN (${quoteList(v)})`);
    }
  }
  return out;
}

/**
 * Build the seed cohort's respondent_id list from the routing output.
 * Returns SQL of the form `(SELECT respondent_id FROM ...)` that can be
 * embedded in downstream queries.
 */
function buildSeedCohortSQL(routing) {
  const clauses = [];

  // brand_entity / hybrid → use the brand_entity_match item
  if (routing.brand_entity_match && routing.brand_entity_match.item_id) {
    const itemId = Number(routing.brand_entity_match.item_id);
    const crit = criterionClause(routing.criterion || 'top_2_box');
    if (Number.isFinite(itemId) && crit) {
      clauses.push(`
        SELECT DISTINCT r.respondent_id
        FROM bjl_responses r
        WHERE r.item_id = ${itemId}
          AND ${crit}
      `);
    }
  }

  // multi_trait / category → UNION of per-trait/per-category-item cohorts
  if (Array.isArray(routing.trait_matches) && routing.trait_matches.length > 0) {
    const subClauses = [];
    for (const tm of routing.trait_matches) {
      const itemId = Number(tm.item_id);
      const crit = criterionClause(routing.criterion || 'top_quartile');
      if (Number.isFinite(itemId) && crit) {
        subClauses.push(`
          SELECT DISTINCT r.respondent_id
          FROM bjl_responses r
          WHERE r.item_id = ${itemId}
            AND ${crit}
        `);
      }
    }
    if (subClauses.length === 1) clauses.push(subClauses[0]);
    else if (subClauses.length > 1) clauses.push(`(${subClauses.join('\nUNION\n')})`);
  }

  // demographic / hybrid → respondents matching demographic filter
  if (routing.demographic_filter) {
    const dc = demographicClauseSQL(routing.demographic_filter, 'resp');
    if (dc.length > 0) {
      clauses.push(`
        SELECT DISTINCT resp.respondent_id
        FROM bjl_respondents resp
        WHERE ${dc.join(' AND ')}
      `);
    }
  }

  if (clauses.length === 0) return null;
  if (clauses.length === 1) return `(${clauses[0]})`;
  // Multiple seed paths (hybrid): intersect them
  return `(${clauses.join('\nINTERSECT\n')})`;
}

/**
 * Build the reverse-engineered cohort SQL from Pass 3's parameters.
 * Each parameter becomes a respondent_id-producing subquery; the cohort
 * is the INTERSECT.
 */
function buildReverseCohortSQL(parameters) {
  if (!Array.isArray(parameters) || parameters.length === 0) return null;
  const subs = [];
  for (const p of parameters) {
    if (p.type === 'layer_1') {
      const itemId = Number(p.item_id);
      const crit = criterionClause(p.criterion);
      if (!Number.isFinite(itemId) || !crit) continue;
      subs.push(`
        SELECT DISTINCT r.respondent_id
        FROM bjl_responses r
        WHERE r.item_id = ${itemId}
          AND ${crit}
      `);
    } else if (p.type === 'layer_3') {
      const fw = p.framework;
      const tag = p.tag;
      if (!['joy_modes','tensions','functional_jobs','occasions'].includes(fw)) continue;
      if (!tag) continue;
      subs.push(`
        SELECT DISTINCT v.respondent_id
        FROM bjl_verbatims v
        WHERE ${quote(tag)} = ANY(v.${fw})
      `);
    } else if (p.type === 'demographic') {
      const field = p.field;
      const values = Array.isArray(p.values) ? p.values.filter(Boolean) : [];
      if (!field || values.length === 0) continue;
      subs.push(`
        SELECT DISTINCT resp.respondent_id
        FROM bjl_respondents resp
        WHERE resp.${field} IN (${quoteList(values)})
      `);
    }
  }
  if (subs.length === 0) return null;
  if (subs.length === 1) return `(${subs[0]})`;
  return `(${subs.join('\nINTERSECT\n')})`;
}

// =====================================================================
// Cohort profiling (Layer 1 universal core, Layer 3, demographics, L2)
// =====================================================================

async function profileLayer1UniversalCore(cohortSQL) {
  // Layer 1 cohort vs corpus on the universal-core items (n_fieldings >= 10).
  const sql = `
    WITH cohort AS (
      SELECT i.item_id, i.item_name, q.question_text,
             ROUND(AVG(r.joy_index)::numeric, 1) AS cohort_ji,
             COUNT(*) AS cohort_n
      FROM bjl_responses r
      JOIN bjl_items i ON i.item_id = r.item_id
      JOIN bjl_items_longitudinal il ON il.item_id = i.item_id
      JOIN bjl_questions_v2 q ON q.question_id = i.question_id
      WHERE r.respondent_id IN ${cohortSQL}
        AND r.joy_index IS NOT NULL
      GROUP BY i.item_id, i.item_name, q.question_text
    ),
    corpus AS (
      SELECT i.item_id,
             ROUND(AVG(r.joy_index)::numeric, 1) AS corpus_ji,
             COUNT(*) AS corpus_n
      FROM bjl_responses r
      JOIN bjl_items_longitudinal i ON i.item_id = r.item_id
      WHERE r.joy_index IS NOT NULL
      GROUP BY i.item_id
    )
    SELECT c.item_id, c.item_name, c.question_text,
           c.cohort_ji, c.cohort_n,
           x.corpus_ji, x.corpus_n,
           ROUND(c.cohort_ji - x.corpus_ji, 1) AS delta
    FROM cohort c
    LEFT JOIN corpus x ON x.item_id = c.item_id
    WHERE c.cohort_n >= 10
    ORDER BY delta DESC NULLS LAST
  `;
  return await execSQL(sql, 'profile L1 universal core');
}

async function profileLayer3(cohortSQL) {
  // All four frameworks, cohort rate vs corpus rate.
  const sql = `
    WITH cohort_verbatims AS (
      SELECT v.id, v.joy_modes, v.tensions, v.functional_jobs, v.occasions
      FROM bjl_verbatims v
      WHERE v.respondent_id IN ${cohortSQL}
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
           ROUND(100.0 * c.n / NULLIF((SELECT n FROM cohort_total), 0), 1) AS cohort_rate,
           x.n AS corpus_n,
           ROUND(100.0 * x.n / NULLIF((SELECT n FROM corpus_total), 0), 1) AS corpus_rate,
           ROUND(
             100.0 * c.n / NULLIF((SELECT n FROM cohort_total),0)
             - 100.0 * x.n / NULLIF((SELECT n FROM corpus_total),0),
             1
           ) AS delta_pp
    FROM cohort_counts c
    LEFT JOIN corpus_counts x ON x.framework = c.framework AND x.tag = c.tag
    WHERE c.n >= 5
    ORDER BY c.framework, c.n DESC
  `;
  return await execSQL(sql, 'profile L3');
}

async function profileDemographics(cohortSQL) {
  // Six standard fields plus race and hispanic_origin.
  const fields = ['age_band','generation','gender','income_bracket','region','marital_status','parental_status','hispanic_origin'];
  const sqlParts = fields.map(f => `
    SELECT '${f}'::text AS field, ${f} AS value, COUNT(*) AS cohort_n
    FROM bjl_respondents resp
    WHERE respondent_id IN ${cohortSQL}
      AND ${f} IS NOT NULL
    GROUP BY ${f}
  `);
  const cohortDist = await execSQL(sqlParts.join('\nUNION ALL\n'), 'profile demo cohort');

  const corpusParts = fields.map(f => `
    SELECT '${f}'::text AS field, ${f} AS value, COUNT(*) AS corpus_n
    FROM bjl_respondents
    WHERE ${f} IS NOT NULL
    GROUP BY ${f}
  `);
  const corpusDist = await execSQL(corpusParts.join('\nUNION ALL\n'), 'profile demo corpus');

  // Race columns are booleans; pull each separately.
  const raceCols = ['race_american_indian','race_asian','race_black','race_hispanic','race_middle_eastern','race_pacific_islander','race_white'];
  const cohortRaceSql = raceCols.map(c => `
    SELECT '${c}'::text AS value,
           COUNT(*) FILTER (WHERE ${c} = true) AS cohort_yes,
           COUNT(*) AS cohort_total
    FROM bjl_respondents
    WHERE respondent_id IN ${cohortSQL}
  `).join('\nUNION ALL\n');
  const corpusRaceSql = raceCols.map(c => `
    SELECT '${c}'::text AS value,
           COUNT(*) FILTER (WHERE ${c} = true) AS corpus_yes,
           COUNT(*) AS corpus_total
    FROM bjl_respondents
  `).join('\nUNION ALL\n');
  const cohortRace = await execSQL(cohortRaceSql, 'profile race cohort');
  const corpusRace = await execSQL(corpusRaceSql, 'profile race corpus');

  return { cohortDist, corpusDist, cohortRace, corpusRace };
}

async function profileLayer2Battery(cohortSQL, questionIds) {
  if (!questionIds || questionIds.length === 0) return [];
  const qIdsList = questionIds.map(q => Number(q)).filter(Number.isFinite).join(',');
  if (!qIdsList) return [];
  const sql = `
    WITH cohort AS (
      SELECT i.item_id, i.item_name, q.question_id, q.question_text, q.question_type,
             ROUND(100.0 * COUNT(*) FILTER (
               WHERE r.raw_value ILIKE 'Very much%' OR r.raw_value ILIKE 'Strongly agree%' OR r.raw_value ILIKE 'Very likely%' OR r.raw_value ILIKE 'Very familiar%' OR r.numeric_value = 5
             ) / NULLIF(COUNT(*),0), 1) AS cohort_pct,
             COUNT(*) AS cohort_n
      FROM bjl_responses r
      JOIN bjl_items i ON i.item_id = r.item_id
      JOIN bjl_questions_v2 q ON q.question_id = i.question_id
      WHERE r.respondent_id IN ${cohortSQL}
        AND q.question_id IN (${qIdsList})
      GROUP BY i.item_id, i.item_name, q.question_id, q.question_text, q.question_type
    ),
    corpus AS (
      SELECT i.item_id,
             ROUND(100.0 * COUNT(*) FILTER (
               WHERE r.raw_value ILIKE 'Very much%' OR r.raw_value ILIKE 'Strongly agree%' OR r.raw_value ILIKE 'Very likely%' OR r.raw_value ILIKE 'Very familiar%' OR r.numeric_value = 5
             ) / NULLIF(COUNT(*),0), 1) AS corpus_pct,
             COUNT(*) AS corpus_n
      FROM bjl_responses r
      JOIN bjl_items i ON i.item_id = r.item_id
      JOIN bjl_questions_v2 q ON q.question_id = i.question_id
      WHERE q.question_id IN (${qIdsList})
      GROUP BY i.item_id
    )
    SELECT c.item_id, c.item_name, c.question_id, c.question_text,
           c.cohort_pct, c.cohort_n,
           x.corpus_pct, x.corpus_n,
           ROUND(c.cohort_pct - x.corpus_pct, 1) AS delta_pp
    FROM cohort c
    LEFT JOIN corpus x ON x.item_id = c.item_id
    ORDER BY c.question_id, delta_pp DESC NULLS LAST
  `;
  return await execSQL(sql, 'profile L2 battery');
}

async function loadDecisionContextCatalog() {
  // Layer 2 batteries are grouped by question_id. Surface the question
  // text and the count of items per battery so Pass 3 can pick the most
  // relevant 2-4.
  const sql = `
    SELECT q.question_id, q.question_text, q.question_type, q.scale_type,
           COUNT(DISTINCT i.item_id) AS n_items
    FROM bjl_questions_v2 q
    JOIN bjl_items i ON i.question_id = q.question_id
    WHERE q.question_type IN ('description_scale_0_to_5','agreement_scale','importance_scale_0_to_5','likelihood_scale','familiarity_scale','select_all','multi_select')
       OR (q.question_type = 'joy_scale' AND q.scale_type = 'ordinal_3pt_joy')
    GROUP BY q.question_id, q.question_text, q.question_type, q.scale_type
    HAVING COUNT(DISTINCT i.item_id) >= 3
    ORDER BY q.question_id
  `;
  return await execSQL(sql, 'L2 battery catalog');
}

async function cohortCount(cohortSQL) {
  if (!cohortSQL) return 0;
  const sql = `SELECT COUNT(DISTINCT respondent_id) AS n FROM (${cohortSQL.slice(1, -1)}) sub`;
  const rows = await execSQL(sql, 'cohort count');
  return Number((rows[0] && rows[0].n) || 0);
}

// =====================================================================
// Pass 3: Synthesis
// =====================================================================

async function pass3Synthesis(routing, seedProfile, decisionContextCatalog) {
  const systemPrompt = PROMPTS.audienceMapSynthesis;
  if (!systemPrompt) throw new Error('audience_map_synthesis prompt missing from bundle');

  const userMessage = [
    'seed_strategy:',
    routing.strategy,
    '',
    'routing_summary:',
    JSON.stringify({
      brand_entity_match: routing.brand_entity_match || null,
      trait_matches: routing.trait_matches || null,
      demographic_filter: routing.demographic_filter || null,
      criterion: routing.criterion || null,
    }, null, 2),
    '',
    'seed_cohorts:',
    JSON.stringify([{
      cohort_name: routing.routing_notice || 'seed',
      cohort_n: seedProfile.cohort_n,
      layer_1_universal_core: seedProfile.layer_1,
      layer_3_tag_rates: seedProfile.layer_3,
      demographics: seedProfile.demographics_for_llm,
    }], null, 2),
    '',
    'decision_context_catalog:',
    JSON.stringify(decisionContextCatalog.map(b => ({
      question_id: b.question_id,
      question_text: b.question_text,
      n_items: b.n_items,
    })), null, 2),
  ].join('\n');

  const rsp = await anthropic.messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: systemPrompt }],
    messages: [{ role: 'user', content: userMessage }],
  });
  const text = (rsp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return parseLLMJSON(text);
}

// =====================================================================
// Demographic shape helper (Pass 4 final-section construction)
// =====================================================================

function buildDemographicShape(demoProfile) {
  // demoProfile = { cohortDist, corpusDist, cohortRace, corpusRace }
  const cohortByField = new Map();
  const corpusByField = new Map();
  for (const r of demoProfile.cohortDist) {
    if (!cohortByField.has(r.field)) cohortByField.set(r.field, []);
    cohortByField.get(r.field).push(r);
  }
  for (const r of demoProfile.corpusDist) {
    if (!corpusByField.has(r.field)) corpusByField.set(r.field, []);
    corpusByField.get(r.field).push(r);
  }

  const fieldOrder = ['generation','gender','income_bracket','region','marital_status','parental_status'];
  const rows = [];

  for (const field of fieldOrder) {
    const cohortRows = cohortByField.get(field) || [];
    const corpusRows = corpusByField.get(field) || [];

    let total = cohortRows.reduce((s, r) => s + Number(r.cohort_n), 0);
    let corpusTotal = corpusRows.reduce((s, r) => s + Number(r.corpus_n), 0);
    let denominatorNote = null;

    // Special handling for parental_status: exclude Unknown from both
    // numerator and denominator, label clearly.
    let cohortRowsFiltered = cohortRows;
    let corpusRowsFiltered = corpusRows;
    if (field === 'parental_status') {
      cohortRowsFiltered = cohortRows.filter(r => r.value && r.value !== 'Unknown' && r.value !== 'unknown');
      corpusRowsFiltered = corpusRows.filter(r => r.value && r.value !== 'Unknown' && r.value !== 'unknown');
      total = cohortRowsFiltered.reduce((s, r) => s + Number(r.cohort_n), 0);
      corpusTotal = corpusRowsFiltered.reduce((s, r) => s + Number(r.corpus_n), 0);
      denominatorNote = 'of those reporting';
    }

    if (total === 0 || corpusTotal === 0) continue;

    // Top value = max cohort_n in the cohort distribution
    const top = cohortRowsFiltered.sort((a, b) => Number(b.cohort_n) - Number(a.cohort_n))[0];
    if (!top) continue;
    const topCorpus = corpusRowsFiltered.find(r => r.value === top.value);

    const cohortPct = Math.round((Number(top.cohort_n) / total) * 1000) / 10;
    const corpusPct = topCorpus ? Math.round((Number(topCorpus.corpus_n) / corpusTotal) * 1000) / 10 : 0;
    const deltaPp = Math.round((cohortPct - corpusPct) * 10) / 10;

    rows.push({
      field,
      top_value: top.value,
      cohort_pct: cohortPct,
      corpus_pct: corpusPct,
      delta_pp: deltaPp,
      denominator_note: denominatorNote,
    });
  }

  // Conditional race/ethnicity row — only if at least one group is 3pp+ off corpus
  const RACE_LABELS = {
    race_american_indian: 'American Indian / Alaska Native',
    race_asian: 'Asian',
    race_black: 'Black',
    race_hispanic: 'Hispanic',
    race_middle_eastern: 'Middle Eastern',
    race_pacific_islander: 'Pacific Islander',
    race_white: 'White',
  };
  let mostDivergent = null;
  let mostDivergentMagnitude = 0;
  for (const cr of demoProfile.cohortRace) {
    const xr = demoProfile.corpusRace.find(x => x.value === cr.value);
    if (!xr) continue;
    const cohortPct = (Number(cr.cohort_total) > 0)
      ? Math.round((Number(cr.cohort_yes) / Number(cr.cohort_total)) * 1000) / 10
      : 0;
    const corpusPct = (Number(xr.corpus_total) > 0)
      ? Math.round((Number(xr.corpus_yes) / Number(xr.corpus_total)) * 1000) / 10
      : 0;
    const delta = Math.round((cohortPct - corpusPct) * 10) / 10;
    if (Math.abs(delta) >= 3 && Math.abs(delta) > mostDivergentMagnitude) {
      mostDivergent = {
        field: 'race_ethnicity',
        top_value: RACE_LABELS[cr.value] || cr.value,
        cohort_pct: cohortPct,
        corpus_pct: corpusPct,
        delta_pp: delta,
        denominator_note: null,
      };
      mostDivergentMagnitude = Math.abs(delta);
    }
  }
  if (mostDivergent) rows.push(mostDivergent);

  return { rows };
}

// =====================================================================
// Final merge: Pass 3 editorial + Pass 4 numbers
// =====================================================================

function mergeFinal(routing, synthesis, reverseProfile, decisionContextL2, seedCohortN, reverseCohortN) {
  // Joy Peaks — Pass 3's themes; numbers from reverseProfile.layer_1
  const reverseByItem = new Map(reverseProfile.layer_1.map(r => [r.item_id, r]));
  const survivingThemes = [];
  for (const theme of (synthesis.sections.joy_peaks && synthesis.sections.joy_peaks.themes) || []) {
    const items = [];
    for (const it of (theme.items || [])) {
      const r = reverseByItem.get(it.item_id);
      if (!r) continue;
      const delta = Number(r.delta);
      if (!Number.isFinite(delta) || delta < 0) continue;       // dropped if no longer elevated
      items.push({
        item_id: r.item_id,
        item_name: r.item_name,
        cohort_ji: Math.round(Number(r.cohort_ji) * 10) / 10,
        corpus_ji: Math.round(Number(r.corpus_ji) * 10) / 10,
        delta: Math.round(delta * 10) / 10,
        cohort_n: Number(r.cohort_n),
      });
    }
    if (items.length > 0) {
      items.sort((a, b) => b.delta - a.delta);
      survivingThemes.push({ theme_name: theme.theme_name, items });
    }
  }

  // Joy Valleys — re-pick from Pass 4 (negative delta items, top 5 by magnitude)
  const valleys = reverseProfile.layer_1
    .filter(r => Number.isFinite(Number(r.delta)) && Number(r.delta) <= -2)
    .sort((a, b) => Number(a.delta) - Number(b.delta))
    .slice(0, 5)
    .map(r => ({
      item_id: r.item_id,
      item_name: r.item_name,
      cohort_ji: Math.round(Number(r.cohort_ji) * 10) / 10,
      corpus_ji: Math.round(Number(r.corpus_ji) * 10) / 10,
      delta: Math.round(Number(r.delta) * 10) / 10,
      cohort_n: Number(r.cohort_n),
    }));

  // Emotional Signature — Pass 3's notes; tags from Pass 4 (top 5 per framework by cohort_rate)
  const emotionalSignature = {};
  const FRAMEWORKS = ['joy_modes','tensions','functional_jobs','occasions'];
  for (const fw of FRAMEWORKS) {
    const rows = reverseProfile.layer_3
      .filter(r => r.framework === fw)
      .sort((a, b) => Number(b.cohort_rate) - Number(a.cohort_rate))
      .slice(0, 5)
      .map(r => ({
        tag: r.tag,
        cohort_rate: Math.round(Number(r.cohort_rate) * 10) / 10,
        corpus_rate: Math.round(Number(r.corpus_rate) * 10) / 10,
        delta_pp: Math.round(Number(r.delta_pp) * 10) / 10,
        cohort_n: Number(r.cohort_n),
      }));
    const note = (synthesis.sections.emotional_signature
                  && synthesis.sections.emotional_signature[fw]
                  && synthesis.sections.emotional_signature[fw].note)
                 || '';
    emotionalSignature[fw] = { tags: rows, note };
  }

  // Decision Context — Pass 3's picked batteries + Pass 4's numbers
  const dcByQid = new Map();
  for (const it of decisionContextL2 || []) {
    if (!dcByQid.has(it.question_id)) dcByQid.set(it.question_id, []);
    dcByQid.get(it.question_id).push(it);
  }
  const dcOut = [];
  for (const battery of (synthesis.sections.decision_context || [])) {
    const items = (dcByQid.get(battery.question_id) || [])
      .filter(r => Number.isFinite(Number(r.delta_pp)))
      .sort((a, b) => Number(b.delta_pp) - Number(a.delta_pp))
      .slice(0, 5)
      .map(r => ({
        item_id: r.item_id,
        item_name: r.item_name,
        cohort_pct: Math.round(Number(r.cohort_pct) * 10) / 10,
        corpus_pct: Math.round(Number(r.corpus_pct) * 10) / 10,
        delta_pp: Math.round(Number(r.delta_pp) * 10) / 10,
        cohort_n: Number(r.cohort_n),
        metric_label: 'TB%',
      }));
    if (items.length > 0) {
      dcOut.push({
        question_id: battery.question_id,
        question_text: battery.question_text,
        relevance_rationale: battery.relevance_rationale || '',
        items,
      });
    }
  }

  return {
    workflow: 'audience_map',
    routing: {
      strategy: routing.strategy,
      routing_notice: routing.routing_notice,
      rationale: routing.rationale,
      brand_entity_match: routing.brand_entity_match || null,
      trait_matches: routing.trait_matches || null,
      demographic_filter: routing.demographic_filter || null,
    },
    seed_cohort_n: seedCohortN,
    reverse_engineered_cohort_n: reverseCohortN,
    low_n_warning: reverseCohortN < LOW_N_WARN_THRESHOLD,
    parameters: synthesis.parameters,
    sections: {
      synthesis_paragraph: (synthesis.sections.synthesis_paragraph || '').trim(),
      joy_peaks: { themes: survivingThemes },
      joy_valleys: valleys,
      emotional_signature: emotionalSignature,
      decision_context: dcOut,
      demographic_shape: buildDemographicShape(reverseProfile.demographics),
    },
  };
}

// =====================================================================
// Main handler
// =====================================================================

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, body: 'invalid JSON' }; }
  const jobId = body.job_id;
  if (!jobId) return { statusCode: 400, body: 'missing job_id' };

  await supabase.from('bjl_query_jobs').update({ status: 'running' }).eq('job_id', jobId);

  try {
    const { data: job, error: loadErr } = await supabase
      .from('bjl_query_jobs').select('*').eq('job_id', jobId).single();
    if (loadErr) throw new Error(`load job: ${loadErr.message}`);
    const description = (job.extra_context && job.extra_context.description) || '';
    if (!description) throw new Error('extra_context.description missing');

    // Pass 1: routing
    const catalog = await loadCleanCatalogForRouting();
    const demographicVocab = await loadDemographicVocab();
    const routing = await pass1Routing(description, catalog, demographicVocab);

    if (routing.strategy === 'unresolved') {
      const finding = {
        workflow: 'audience_map',
        unresolved: true,
        unresolved_reason: routing.unresolved_reason || 'Audience description could not be routed.',
        description,
      };
      await supabase.from('bjl_query_jobs').update({
        status: 'complete',
        finding: JSON.stringify(finding),
        scratch: { unresolved: true },
        completed_at: new Date().toISOString(),
      }).eq('job_id', jobId);
      return { statusCode: 200, body: 'ok (unresolved)' };
    }

    // Pass 2: seed cohort + profile
    const seedCohortSQL = buildSeedCohortSQL(routing);
    if (!seedCohortSQL) throw new Error('Pass 1 produced no usable seed cohort clauses');
    const seedCohortN = await cohortCount(seedCohortSQL);
    if (seedCohortN === 0) {
      throw new Error('Seed cohort matched 0 respondents. The routing entity or trait did not yield any responses meeting the criterion.');
    }

    const [seedL1, seedL3, seedDemo, decisionContextCatalog] = await Promise.all([
      profileLayer1UniversalCore(seedCohortSQL),
      profileLayer3(seedCohortSQL),
      profileDemographics(seedCohortSQL),
      loadDecisionContextCatalog(),
    ]);

    // Build a compact demographics view for the LLM (top values per field with deltas).
    const seedDemoForLLM = buildDemographicShape(seedDemo);

    const seedProfile = {
      cohort_n: seedCohortN,
      layer_1: seedL1,
      layer_3: seedL3,
      demographics_for_llm: seedDemoForLLM.rows,
    };

    // Pass 3: synthesis
    const synthesis = await pass3Synthesis(routing, seedProfile, decisionContextCatalog);
    if (!Array.isArray(synthesis.parameters) || synthesis.parameters.length === 0) {
      throw new Error('Pass 3 returned no parameters');
    }

    // Pass 4: reverse-engineer
    const reverseCohortSQL = buildReverseCohortSQL(synthesis.parameters);
    if (!reverseCohortSQL) {
      throw new Error('Pass 3 parameters produced no usable cohort SQL');
    }
    const reverseCohortN = await cohortCount(reverseCohortSQL);
    if (reverseCohortN < LOW_N_REFUSE_THRESHOLD) {
      const finding = {
        workflow: 'audience_map',
        low_n_refused: true,
        reverse_engineered_cohort_n: reverseCohortN,
        seed_cohort_n: seedCohortN,
        parameters: synthesis.parameters,
        routing: {
          strategy: routing.strategy,
          routing_notice: routing.routing_notice,
        },
        message: `Reverse-engineered audience is too small (n=${reverseCohortN}; minimum 30). The parameter set was too tight. Try a broader audience description or relax specificity.`,
      };
      await supabase.from('bjl_query_jobs').update({
        status: 'complete',
        finding: JSON.stringify(finding),
        scratch: { low_n_refused: true, reverse_n: reverseCohortN },
        completed_at: new Date().toISOString(),
      }).eq('job_id', jobId);
      return { statusCode: 200, body: 'ok (low-n refused)' };
    }

    const pickedQids = (synthesis.sections.decision_context || [])
      .map(b => Number(b.question_id)).filter(Number.isFinite);

    const [revL1, revL3, revDemo, revL2] = await Promise.all([
      profileLayer1UniversalCore(reverseCohortSQL),
      profileLayer3(reverseCohortSQL),
      profileDemographics(reverseCohortSQL),
      profileLayer2Battery(reverseCohortSQL, pickedQids),
    ]);

    const reverseProfile = {
      cohort_n: reverseCohortN,
      layer_1: revL1,
      layer_3: revL3,
      demographics: revDemo,
    };

    const finalFinding = mergeFinal(
      routing, synthesis, reverseProfile, revL2, seedCohortN, reverseCohortN
    );
    finalFinding.description = description;
    finalFinding.diagnostics = {
      catalog_size: catalog.length,
      seed_strategy: routing.strategy,
      models: { routing: ROUTING_MODEL, synthesis: SYNTHESIS_MODEL },
    };

    const oneLine = `Audience Map: ${routing.routing_notice || routing.strategy}. `
      + `Reverse-engineered n=${reverseCohortN.toLocaleString()}.`;

    await supabase.from('bjl_query_jobs').update({
      status: 'complete',
      finding: JSON.stringify(finalFinding),
      scratch: {
        one_line_summary: oneLine,
        seed_cohort_n: seedCohortN,
        reverse_engineered_cohort_n: reverseCohortN,
        strategy: routing.strategy,
      },
      completed_at: new Date().toISOString(),
    }).eq('job_id', jobId);

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('[bjl-audience-map-background] error:', err);
    await supabase.from('bjl_query_jobs').update({
      status: 'error',
      error: String(err.message || err).slice(0, 1000),
      completed_at: new Date().toISOString(),
    }).eq('job_id', jobId);
    return { statusCode: 500, body: String(err.message || err) };
  }
};
