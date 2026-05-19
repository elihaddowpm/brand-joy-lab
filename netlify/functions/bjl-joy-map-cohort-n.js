/**
 * bjl-joy-map-cohort-n.js — live cohort sizer for the Joy Map (Phase 1.5).
 *
 * POST /.netlify/functions/bjl-joy-map-cohort-n
 * body: {
 *   audience_filters?:    { age_band, gender, income_bracket, region,
 *                           parental_status, marital_status },
 *   joy_pattern_rules?:   [{ item_id, kind, criterion }, ...],
 * }
 *
 * Returns: { cohort_n: <integer> }
 *
 * Used by the audience-definition panel to update the displayed cohort n
 * in real time as the strategist adds or edits rules. Should be fast
 * enough to call on every change with light debouncing on the frontend.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');
const { buildJoyPatternCohortSQL } = require('./bjl-joy-pattern-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function quote(s) {
  if (s === null || s === undefined) return 'NULL';
  return `'${String(s).replace(/'/g, "''")}'`;
}

function buildDemographicClauses(filters) {
  const f = filters || {};
  const clauses = [];
  if (f.age_band)        clauses.push(`age_band = ${quote(f.age_band)}`);
  if (f.gender)          clauses.push(`gender = ${quote(f.gender)}`);
  if (f.income_bracket)  clauses.push(`income_bracket = ${quote(f.income_bracket)}`);
  if (f.region)          clauses.push(`region = ${quote(f.region)}`);
  if (f.parental_status) clauses.push(`parental_status = ${quote(f.parental_status)}`);
  if (f.marital_status)  clauses.push(`marital_status = ${quote(f.marital_status)}`);
  return clauses;
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

  const demographicClauses = buildDemographicClauses(body.audience_filters);
  const operator = body.logical_operator
                   ? String(body.logical_operator).toUpperCase()
                   : 'AND';
  const joyPatternSubquery = buildJoyPatternCohortSQL(body.joy_pattern_rules, operator);

  let sql;
  if (joyPatternSubquery && demographicClauses.length) {
    // Intersection: joy-pattern respondents AND demographic match
    sql = `
      SELECT COUNT(*) AS n
      FROM bjl_respondents
      WHERE respondent_id IN ${joyPatternSubquery}
        AND ${demographicClauses.join(' AND ')}
    `;
  } else if (joyPatternSubquery) {
    sql = `
      SELECT COUNT(DISTINCT respondent_id) AS n
      FROM (${joyPatternSubquery.slice(1, -1)}) jp
    `;
  } else if (demographicClauses.length) {
    sql = `
      SELECT COUNT(*) AS n
      FROM bjl_respondents
      WHERE ${demographicClauses.join(' AND ')}
    `;
  } else {
    sql = `SELECT COUNT(*) AS n FROM bjl_respondents`;
  }

  const { data, error } = await supabase.rpc('execute_read_sql', { query_text: sql });
  if (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'cohort sizer failed', detail: error.message })
    };
  }

  const n = Number((data && data[0] && data[0].n) || 0);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cohort_n: n })
  };
};
