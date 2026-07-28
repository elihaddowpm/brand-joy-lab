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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const PROMPTS = require('./_prompts_bundle.json');

const ROUTING_MODEL = 'claude-haiku-4-5-20251001';
const SYNTHESIS_MODEL = 'claude-sonnet-4-6';
const EMBED_MODEL = 'text-embedding-3-small';
const MAX_TOKENS = 8000;

// v9.17: Coverage scan is always on for the Audience Map build. We embed
// the audience description and pull the 16-topic matrix ahead of Pass 3
// so the synthesis LLM sees cross-topic signal alongside the seed cohort
// profile. Returns null on failure so synthesis proceeds without it.
async function embedText(text) {
  if (!OPENAI_API_KEY || !text) return null;
  try {
    const rsp = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: String(text).slice(0, 8000) }),
    });
    if (!rsp.ok) return null;
    const json = await rsp.json();
    const vec = json && json.data && json.data[0] && json.data[0].embedding;
    if (!Array.isArray(vec)) return null;
    return `[${vec.join(',')}]`;
  } catch (_) { return null; }
}

async function runCoverageScan(descriptionText) {
  const vecLit = await embedText(descriptionText);
  if (!vecLit) return null;
  const sql = `SELECT * FROM bjl_coverage_scan('${vecLit}'::vector)`;
  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) {
    console.error('[bjl-audience-map] coverage scan failed:', error.message);
    return null;
  }
  return Array.isArray(data) ? data : null;
}

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
      ARRAY(SELECT DISTINCT parental_status FROM bjl_respondents WHERE parental_status IS NOT NULL ORDER BY parental_status) AS parental_status,
      ARRAY(SELECT DISTINCT occupation FROM bjl_respondents WHERE occupation IS NOT NULL ORDER BY occupation) AS occupation,
      ${DECISIONMAKER_FIELDS.map(f => `ARRAY(SELECT DISTINCT ${f} FROM bjl_respondents WHERE ${f} IS NOT NULL ORDER BY ${f}) AS ${f}`).join(',\n      ')}
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
  for (const key of ['age_band','generation','gender','income_bracket','region','parental_status','marital_status', ...BEHAVIORAL_FIELDS]) {
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
 * v5.4 Fix 3 — Pass 4 cross-category discovery.
 *
 * The previous implementation INTERSECTed the per-parameter respondent sets,
 * which collapsed the cohort when parameters touched fielding-bound items
 * (theme-park family seed → n=47 from a seed of n=1,971, defaulting to the
 * residual high-joy cluster).
 *
 * The new implementation:
 *   1. Restricts Layer 1 parameters to the wide-longitudinal substrate
 *      (5+ fieldings) so eligibility differences across respondents shrink.
 *      Layer 3 tags and demographics are universal across all waves.
 *   2. Computes a per-respondent match count across all parameters
 *      (UNION ALL of per-parameter matches, COUNT DISTINCT per respondent).
 *   3. Returns respondents whose match-count meets a threshold that's
 *      relaxed progressively until the cohort hits n≥100.
 *
 * Strict AND collapses on fielding gaps; resonance scoring tolerates them
 * and surfaces a broader, more representative audience — which is the
 * promise of reverse-engineering. A cohort of several hundred derived
 * from the universal signature beats a cohort of 47 derived from a
 * fielding accident.
 *
 * Caller is responsible for filtering parameters to universal-dimension
 * only before calling this (see filterToUniversalParameters).
 */
function buildResonanceCohortSQL(parameters, options) {
  const opts = Object.assign({ targetN: 500, matchedAtLeast: null }, options || {});
  if (!Array.isArray(parameters) || parameters.length === 0) return null;

  const matchClauses = [];
  for (const p of parameters) {
    if (p.type === 'layer_1') {
      const itemId = Number(p.item_id);
      const crit = criterionClause(p.criterion);
      if (!Number.isFinite(itemId) || !crit) continue;
      // The JOIN to bjl_items_longitudinal_wide enforces the universal-dimension
      // restriction at the SQL level: if Pass 3 slipped a fielding-bound item
      // through, it gets dropped here.
      matchClauses.push(`
        SELECT DISTINCT r.respondent_id,
               'l1:'::text || ${itemId}::text AS pkey
        FROM bjl_responses r
        JOIN bjl_items_longitudinal_wide il ON il.item_id = r.item_id
        WHERE r.item_id = ${itemId} AND ${crit}
      `);
    } else if (p.type === 'layer_3') {
      const fw = p.framework;
      const tag = p.tag;
      if (!['joy_modes','tensions','functional_jobs','occasions'].includes(fw)) continue;
      if (!tag) continue;
      matchClauses.push(`
        SELECT DISTINCT v.respondent_id,
               ${quote('l3:' + fw + ':' + tag)} AS pkey
        FROM bjl_verbatims v
        WHERE ${quote(tag)} = ANY(v.${fw})
      `);
    } else if (p.type === 'demographic') {
      const field = p.field;
      const values = Array.isArray(p.values) ? p.values.filter(Boolean) : [];
      if (!field || values.length === 0) continue;
      matchClauses.push(`
        SELECT DISTINCT resp.respondent_id,
               ${quote('demo:' + field)} AS pkey
        FROM bjl_respondents resp
        WHERE resp.${field} IN (${quoteList(values)})
      `);
    }
  }
  if (matchClauses.length === 0) return null;

  const minMatched = opts.matchedAtLeast != null
    ? opts.matchedAtLeast
    : Math.max(2, Math.ceil(matchClauses.length * 0.5));

  return `(
    WITH all_matches AS (
      ${matchClauses.join('\n      UNION ALL\n')}
    ),
    scored AS (
      SELECT respondent_id, COUNT(DISTINCT pkey) AS matched
      FROM all_matches
      GROUP BY respondent_id
    )
    SELECT respondent_id
    FROM scored
    WHERE matched >= ${minMatched}
    ORDER BY matched DESC, respondent_id
    LIMIT ${opts.targetN}
  )`;
}

/**
 * Universal-dimension filter for Pass 3's parameter list. Layer 3 tags and
 * demographics are always universal. Layer 1 parameters must reference an
 * item in the wide-longitudinal substrate (5+ fieldings) — fielding-bound
 * items don't qualify.
 *
 * Returns { universal: [...], dropped: [...] } so the caller can record
 * which parameters were dropped in scratch / diagnostics.
 */
async function filterToUniversalParameters(parameters) {
  const universal = [];
  const dropped   = [];
  if (!Array.isArray(parameters)) return { universal, dropped };

  // Load the longitudinal-wide item_id set once
  const rows = await execSQL(
    `SELECT item_id FROM bjl_items_longitudinal_wide`,
    'load longitudinal-wide ids'
  );
  const wideIds = new Set(rows.map(r => Number(r.item_id)));

  for (const p of parameters) {
    if (p.type === 'layer_3' || p.type === 'demographic') {
      universal.push(p);
    } else if (p.type === 'layer_1') {
      const itemId = Number(p.item_id);
      if (wideIds.has(itemId)) {
        universal.push(p);
      } else {
        dropped.push({ ...p, reason: 'layer_1 item is not in bjl_items_longitudinal_wide (fielding-bound)' });
      }
    } else {
      dropped.push({ ...p, reason: 'unknown parameter type' });
    }
  }
  return { universal, dropped };
}

// =====================================================================
// Cohort profiling (Layer 1 universal core, Layer 3, demographics, L2)
// =====================================================================

async function profileLayer1UniversalCore(cohortSQL) {
  // Layer 1 cohort vs corpus on the wide longitudinal substrate.
  //
  // v5.4 Fix 3: switched from bjl_items_longitudinal (10+ fieldings, ~45
  // items) to bjl_items_longitudinal_wide (5+ fieldings, ~182 items). The
  // wider substrate spans food / grocery / finance / tech / retail / travel
  // / social and is the cross-category surface Pass 3 picks parameters from
  // and Pass 4 resonance-scores against. The trade-off — slightly less
  // longitudinal strictness per item — is worth the breadth: 45 items can't
  // surface a grocery / finance / tech discovery for a theme-park-family
  // seed; 182 items can.
  const sql = `
    WITH cohort AS (
      SELECT i.item_id, i.item_name, q.question_text,
             ROUND(AVG(r.joy_index)::numeric, 1) AS cohort_ji,
             COUNT(*) AS cohort_n
      FROM bjl_responses r
      JOIN bjl_items i ON i.item_id = r.item_id
      JOIN bjl_items_longitudinal_wide il ON il.item_id = i.item_id
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
      JOIN bjl_items_longitudinal_wide i ON i.item_id = r.item_id
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

// Behavioural cohort cuts added alongside the standard demographics.
// occupation is a 36-value panel field at ~62% coverage; the
// decisionmaker_* columns are a 5-level household-role scale asked per
// category. Coverage varies a lot by column (groceries and vacation are
// near-full, home_furnishing is a single small fielding), so every row
// these produce carries a coverage note.
const DECISIONMAKER_FIELDS = [
  'decisionmaker_groceries',
  'decisionmaker_vacation',
  'decisionmaker_vacation_activities',
  'decisionmaker_car',
  'decisionmaker_car_insurance',
  'decisionmaker_internet',
  'decisionmaker_bank',
  'decisionmaker_home_furnishing',
];
const BEHAVIORAL_FIELDS = ['occupation', ...DECISIONMAKER_FIELDS];

async function profileDemographics(cohortSQL) {
  // Six standard fields plus race and hispanic_origin, plus the
  // behavioural cuts (occupation + decisionmaker_*).
  const fields = ['age_band','generation','gender','income_bracket','region','marital_status','parental_status','hispanic_origin', ...BEHAVIORAL_FIELDS];
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

  // Race columns are booleans. The columns are only populated in recent
  // fieldings (the older 2023-mid-2025 waves carry race_* = false uniformly).
  // Computing race percentages across the full corpus pulls in those zeros
  // and dilutes the dominant values — producing the "White 0% vs 16.6%
  // corpus" artifact reported in v5.4 Fix 4 Bug A.
  //
  // The fix: scope BOTH the cohort and corpus race calculations to
  // respondents whose fielding has any race signal at all (proxy: at least
  // one race_* = true exists in that fielding). Apples-to-apples
  // comparison.
  const raceCols = ['race_american_indian','race_asian','race_black','race_hispanic','race_middle_eastern','race_pacific_islander','race_white'];
  const RACE_FIELDING_FILTER = `
    fielding_id IN (
      SELECT fielding_id
      FROM bjl_respondents
      WHERE (race_white OR race_black OR race_asian OR race_hispanic OR race_american_indian OR race_pacific_islander OR race_middle_eastern)
      GROUP BY fielding_id
    )
  `;
  const cohortRaceSql = raceCols.map(c => `
    SELECT '${c}'::text AS value,
           COUNT(*) FILTER (WHERE ${c} = true) AS cohort_yes,
           COUNT(*) AS cohort_total
    FROM bjl_respondents
    WHERE respondent_id IN ${cohortSQL}
      AND ${RACE_FIELDING_FILTER}
  `).join('\nUNION ALL\n');
  const corpusRaceSql = raceCols.map(c => `
    SELECT '${c}'::text AS value,
           COUNT(*) FILTER (WHERE ${c} = true) AS corpus_yes,
           COUNT(*) AS corpus_total
    FROM bjl_respondents
    WHERE ${RACE_FIELDING_FILTER}
  `).join('\nUNION ALL\n');
  const cohortRace = await execSQL(cohortRaceSql, 'profile race cohort');
  const corpusRace = await execSQL(corpusRaceSql, 'profile race corpus');

  // Denominators for the coverage note on the behavioural cuts.
  const totalsRows = await execSQL(`
    SELECT (SELECT COUNT(*) FROM bjl_respondents) AS corpus_total,
           (SELECT COUNT(*) FROM bjl_respondents WHERE respondent_id IN ${cohortSQL}) AS cohort_total
  `, 'profile demo totals');

  return { cohortDist, corpusDist, cohortRace, corpusRace, totals: totalsRows[0] || {} };
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

async function pass3Synthesis(routing, seedProfile, decisionContextCatalog, coverageMatrix) {
  const systemPrompt = PROMPTS.audienceMapSynthesis;
  if (!systemPrompt) throw new Error('audience_map_synthesis prompt missing from bundle');

  // v9.17: When the coverage scan ran, include the 16-topic matrix. It sits
  // alongside the seed cohort profile so the synthesizer can factor
  // cross-topic patterns (a driver ranking unexpectedly high in an
  // adjacent topic center) into the parameter set and editorial layer.
  const coverageBlock = Array.isArray(coverageMatrix) && coverageMatrix.length > 0
    ? [
        '',
        'coverage_matrix (all 16 primary_topic centers, semantic-scan against the audience description; use for cross-topic signal — a strong pattern in an adjacent topic is worth naming):',
        JSON.stringify(coverageMatrix, null, 2),
      ].join('\n')
    : '';

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
    coverageBlock,
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

  const fieldOrder = ['generation','gender','income_bracket','region','marital_status','parental_status', ...BEHAVIORAL_FIELDS];
  const corpusRespondents = Number((demoProfile.totals || {}).corpus_total) || 0;
  const rows = [];

  for (const field of fieldOrder) {
    const cohortRows = cohortByField.get(field) || [];
    const corpusRows = corpusByField.get(field) || [];

    let total = cohortRows.reduce((s, r) => s + Number(r.cohort_n), 0);
    let corpusTotal = corpusRows.reduce((s, r) => s + Number(r.corpus_n), 0);
    let denominatorNote = null;

    // Parental status special handling (v5.4 Fix 4 Bug B): the corpus is
    // ~77% "Unknown" and ~23% "Parent" with no third value. The previous
    // logic excluded Unknown from both denominators, which collapsed the
    // result to 100% Parent on both sides (every reported value is Parent).
    // The strategist-useful framing is the raw rate against the full
    // denominator — typical Rock Hall demos surface as ~50% Parent (cohort)
    // vs ~23% Parent (corpus), a +27pp directional skew worth seeing.
    //
    // We keep both denominators raw (include Unknown), force the row to
    // surface the "Parent" value (not the dominant Unknown), and label
    // it explicitly as a raw rate so the strategist knows what they're
    // reading.
    let cohortRowsFiltered = cohortRows;
    let corpusRowsFiltered = corpusRows;
    let forcedTopValue = null;
    if (field === 'parental_status') {
      forcedTopValue = 'Parent';
      denominatorNote = 'raw rate (parental_status not collected in all fieldings; absolute magnitudes are directional)';
    }

    // Behavioural cuts are asked in a subset of fieldings. Both sides are
    // computed on answerers only, so the note states what fraction of the
    // corpus was asked — the strategist reads the skew against that base,
    // not against everyone.
    if (BEHAVIORAL_FIELDS.includes(field)) {
      if (corpusRespondents === 0) continue;
      const coveragePct = Math.round((corpusTotal / corpusRespondents) * 1000) / 10;
      denominatorNote = `answerers only — ${coveragePct}% of corpus asked (n=${corpusTotal.toLocaleString()})`;
    }

    if (total === 0 || corpusTotal === 0) continue;

    const top = forcedTopValue
      ? cohortRowsFiltered.find(r => r.value === forcedTopValue)
      : cohortRowsFiltered.sort((a, b) => Number(b.cohort_n) - Number(a.cohort_n))[0];
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

    // v9.17: Coverage scan is always on for the Audience Map build. The
    // 16-topic matrix is computed from the audience description and
    // passed into Pass 3 alongside the seed cohort profile. Non-fatal
    // if the scan fails — synthesis proceeds with the standard payload.
    const coverageMatrix = await runCoverageScan(description);

    // Pass 3: synthesis
    const synthesis = await pass3Synthesis(routing, seedProfile, decisionContextCatalog, coverageMatrix);
    if (!Array.isArray(synthesis.parameters) || synthesis.parameters.length === 0) {
      throw new Error('Pass 3 returned no parameters');
    }

    // Pass 4: reverse-engineer — conditional by seed strategy.
    //
    // v5.4 Fix 3: not every seed strategy benefits from reverse-engineering.
    //   brand_entity / multi_trait / category   → run Pass 4
    //   demographic                             → SKIP. The Pass 2 cohort
    //                                              is already the audience;
    //                                              reverse-engineering on top
    //                                              of joy-pattern params
    //                                              over-constrains and
    //                                              collapses the cohort.
    //   hybrid                                  → run Pass 4 on the
    //                                              brand/trait component,
    //                                              then intersect with the
    //                                              demographic filter.
    //
    // Plus: if the reverse-engineered cohort lands below the n=30 refusal
    // floor, fall back to the Pass 2 (seed) cohort with a note rather than
    // erroring. The strategist gets a usable Audience Map either way.
    const STRATEGIES_THAT_SKIP_PASS_4 = new Set(['demographic']);
    const STRATEGIES_THAT_APPLY_DEMO_FILTER_POST = new Set(['hybrid']);
    let useReverse = !STRATEGIES_THAT_SKIP_PASS_4.has(routing.strategy);
    let pass4Note = null;

    let activeCohortSQL = seedCohortSQL;
    let activeCohortN   = seedCohortN;

    if (useReverse) {
      // v5.4 Fix 3 — resonance scoring with universal-dimension parameters
      // and a relaxation ladder. Replaces the strict INTERSECT that caused
      // cohort collapse (e.g., theme-park family seed → n=47).
      const { universal: universalParams, dropped: droppedParams } =
        await filterToUniversalParameters(synthesis.parameters);

      if (universalParams.length === 0) {
        useReverse = false;
        pass4Note = 'No universal-dimension parameters survived filtering; using seed cohort as audience.';
      } else {
        // Resonance ladder: start at 70% of params matched, relax to 50%,
        // then 30%, then any single match. First threshold that yields
        // n ≥ LOW_N_WARN_THRESHOLD wins. If none do, fall back to the seed.
        const numParams = universalParams.length;
        const thresholds = [
          Math.max(2, Math.ceil(numParams * 0.7)),
          Math.max(2, Math.ceil(numParams * 0.5)),
          Math.max(2, Math.ceil(numParams * 0.3)),
          1,
        ].filter((v, i, arr) => arr.indexOf(v) === i);

        let chosenSQL = null;
        let chosenN = 0;
        let chosenThreshold = null;

        for (const thresh of thresholds) {
          let candidateSQL = buildResonanceCohortSQL(universalParams, {
            targetN: 500,
            matchedAtLeast: thresh,
          });
          if (!candidateSQL) continue;

          // Hybrid: intersect resonance cohort with the demographic filter
          // from Pass 1 (brand/trait dimensions ∩ demographic constraint).
          if (STRATEGIES_THAT_APPLY_DEMO_FILTER_POST.has(routing.strategy)
              && routing.demographic_filter) {
            const dc = demographicClauseSQL(routing.demographic_filter, 'resp');
            if (dc.length > 0) {
              const demoSQL = `(SELECT DISTINCT resp.respondent_id FROM bjl_respondents resp WHERE ${dc.join(' AND ')})`;
              candidateSQL = `(${candidateSQL.slice(1,-1)}\nINTERSECT\n${demoSQL.slice(1,-1)})`;
            }
          }

          const n = await cohortCount(candidateSQL);
          if (n >= LOW_N_WARN_THRESHOLD) {
            chosenSQL = candidateSQL;
            chosenN = n;
            chosenThreshold = thresh;
            break;
          }
          // Track best-effort fallback in case all thresholds underperform
          if (n > chosenN) {
            chosenSQL = candidateSQL;
            chosenN = n;
            chosenThreshold = thresh;
          }
        }

        if (chosenN < LOW_N_REFUSE_THRESHOLD || !chosenSQL) {
          useReverse = false;
          pass4Note = `Resonance scoring did not yield a usable cohort (best n=${chosenN}). Showing seed cohort instead.`;
        } else if (chosenN < LOW_N_WARN_THRESHOLD) {
          activeCohortSQL = chosenSQL;
          activeCohortN   = chosenN;
          pass4Note = `Cross-category discovery cohort: n=${chosenN} (below the n≥100 floor; relaxed to ≥${chosenThreshold} of ${numParams} parameters matched). Read deltas as directional.`;
        } else {
          activeCohortSQL = chosenSQL;
          activeCohortN   = chosenN;
          if (droppedParams.length > 0) {
            pass4Note = `Cross-category discovery cohort: n=${chosenN} (≥${chosenThreshold} of ${numParams} universal parameters matched; ${droppedParams.length} fielding-bound parameter${droppedParams.length === 1 ? '' : 's'} dropped).`;
          } else {
            pass4Note = `Cross-category discovery cohort: n=${chosenN} (≥${chosenThreshold} of ${numParams} parameters matched).`;
          }
        }
      }
    } else {
      pass4Note = 'Demographic seed strategy — Pass 2 cohort used directly. Reverse-engineering skipped.';
    }

    const pickedQids = (synthesis.sections.decision_context || [])
      .map(b => Number(b.question_id)).filter(Number.isFinite);

    // Profile whichever cohort is active. For skip-Pass-4 paths this re-uses
    // the seed cohort SQL; for run-Pass-4 paths this is the reverse-engineered
    // cohort SQL (optionally hybrid-intersected with the demographic filter).
    const [revL1, revL3, revDemo, revL2] = await Promise.all([
      profileLayer1UniversalCore(activeCohortSQL),
      profileLayer3(activeCohortSQL),
      profileDemographics(activeCohortSQL),
      profileLayer2Battery(activeCohortSQL, pickedQids),
    ]);

    const reverseProfile = {
      cohort_n: activeCohortN,
      layer_1: revL1,
      layer_3: revL3,
      demographics: revDemo,
    };

    const finalFinding = mergeFinal(
      routing, synthesis, reverseProfile, revL2, seedCohortN, activeCohortN
    );
    if (pass4Note) finalFinding.pass_4_note = pass4Note;
    finalFinding.pass_4_ran = useReverse;
    finalFinding.description = description;
    finalFinding.diagnostics = {
      catalog_size: catalog.length,
      seed_strategy: routing.strategy,
      models: { routing: ROUTING_MODEL, synthesis: SYNTHESIS_MODEL },
    };

    // activeCohortN is the cohort the Audience Map was actually computed
    // against. When Pass 4 ran, it equals the reverse-engineered cohort n;
    // when Pass 4 was skipped (demographic seed) or fell back (under-floor
    // reverse cohort), it equals the seed cohort n. The Fix 3 refactor
    // block-scoped the prior `reverseCohortN` constant inside the
    // useReverse branch, so this section must use activeCohortN.
    const oneLine = `Audience Map: ${routing.routing_notice || routing.strategy}. `
      + `Cohort n=${activeCohortN.toLocaleString()}.`;

    await supabase.from('bjl_query_jobs').update({
      status: 'complete',
      finding: JSON.stringify(finalFinding),
      scratch: {
        one_line_summary: oneLine,
        seed_cohort_n: seedCohortN,
        reverse_engineered_cohort_n: activeCohortN,
        pass_4_ran: useReverse,
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
