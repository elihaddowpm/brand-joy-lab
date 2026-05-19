/**
 * bjl-joy-pattern-helper.js — shared classifier + SQL builder for joy-pattern
 * audience rules (Phase 1.5).
 *
 * scale_kind classification: maps a (question_type, scale_type) pair onto a
 * compact kind we use to drive UI dropdowns AND build criterion SQL. Items
 * whose underlying question type doesn't fit any kind are not surfaced in
 * the picker.
 *
 * Criterion options: per-kind list of {value, label}. The frontend uses
 * this; the backend uses buildCriterionClause(kind, criterion) to translate
 * a chosen criterion into a SQL clause fragment (used inside a WHERE on
 * bjl_responses r aliased as such).
 *
 * Cohort SQL: buildJoyPatternCohortSQL(rules, baseRespondentFilterSQL)
 * returns SQL that selects the respondent_id set for the rules. Multiple
 * rules intersect (AND logic). The base filter, if any, applies on top.
 */

const PICKER_QUESTION_TYPES = [
  'joy_scale',
  'joy_scale_0_to_5',
  'select_all',
  'multi_select',
  'likelihood_scale',
  'familiarity_scale',
  'agreement_scale',
  'description_scale_0_to_5',
  'importance_scale_0_to_5',
  'importance_scale',
];

function classifyScaleKind(question_type, scale_type) {
  if (question_type === 'joy_scale') {
    if (scale_type === 'ordinal_3pt_joy') return 'joy_3pt';
    // ordinal_-3_to_5 OR null both treated as the 9-point joy scale
    return 'joy_9pt';
  }
  if (question_type === 'joy_scale_0_to_5') return 'joy_6pt';
  if (question_type === 'select_all' || question_type === 'multi_select') return 'select_all';
  if (question_type === 'likelihood_scale') return 'likelihood';
  if (question_type === 'familiarity_scale') return 'familiarity';
  if (question_type === 'agreement_scale') return 'agreement';
  if (question_type === 'description_scale_0_to_5'
      || question_type === 'importance_scale_0_to_5'
      || question_type === 'importance_scale') {
    return 'ordinal_0_5';
  }
  return null;
}

// Per-kind criterion options. value = stable key sent over the wire; label = UI text.
const CRITERION_OPTIONS = {
  joy_9pt: [
    { value: 'max_joy',         label: 'Maximum Joy (5)' },
    { value: 'top_quartile',    label: 'Top quartile (\u2265 3)' },
    { value: 'above_median',    label: 'Above median (> 0)' },
    { value: 'below_median',    label: 'Below median (< 0)' },
    { value: 'negative',        label: 'Negative joy (-3 to -1)' },
  ],
  joy_6pt: [
    { value: 'max_joy',         label: 'Maximum Joy (5)' },
    { value: 'top_quartile',    label: 'Top quartile (\u2265 4)' },
    { value: 'above_median',    label: 'Above median (> 2)' },
  ],
  joy_3pt: [
    { value: 'very_much_so',    label: 'Very much so (top-box)' },
    { value: 'somewhat_or_higher', label: 'Somewhat or higher' },
    { value: 'not_at_all',      label: 'Not at all' },
  ],
  select_all: [
    { value: 'selected',        label: 'Selected' },
    { value: 'not_selected',    label: 'Not selected' },
  ],
  likelihood: [
    { value: 'very_likely',     label: 'Very likely (top-box)' },
    { value: 'top_2_box',       label: 'Top-2-box' },
    { value: 'below_top',       label: 'Below top-box' },
  ],
  familiarity: [
    { value: 'very_familiar',   label: 'Very familiar (top-box)' },
    { value: 'top_2_box',       label: 'Top-2-box' },
    { value: 'below_top',       label: 'Below top-box' },
  ],
  agreement: [
    { value: 'strongly_agree',  label: 'Strongly agree (top-box)' },
    { value: 'top_2_box',       label: 'Top-2-box' },
    { value: 'below_top',       label: 'Below top-box' },
  ],
  ordinal_0_5: [
    { value: 'top_box',         label: 'Top box (5)' },
    { value: 'top_2_box',       label: 'Top-2-box (\u2265 4)' },
    { value: 'above_median',    label: 'Above median (\u2265 3)' },
  ],
};

/**
 * Returns a SQL clause string that, applied inside a WHERE on bjl_responses
 * aliased as r, restricts to responses matching this criterion. Caller is
 * responsible for joining bjl_responses to bjl_questions_v2 q if a clause
 * needs the question (currently none do — all clauses use r columns only).
 *
 * Returns null if the kind/criterion pair is unsupported (caller should skip
 * the rule and log).
 */
function buildCriterionClause(kind, criterion) {
  const k = kind;
  const c = criterion;
  switch (k) {
    case 'joy_9pt':
      if (c === 'max_joy')      return 'r.numeric_value = 5';
      if (c === 'top_quartile') return 'r.numeric_value >= 3';
      if (c === 'above_median') return 'r.numeric_value > 0';
      if (c === 'below_median') return 'r.numeric_value < 0';
      if (c === 'negative')     return 'r.numeric_value BETWEEN -3 AND -1';
      return null;
    case 'joy_6pt':
      if (c === 'max_joy')      return 'r.numeric_value = 5';
      if (c === 'top_quartile') return 'r.numeric_value >= 4';
      if (c === 'above_median') return 'r.numeric_value > 2';
      return null;
    case 'joy_3pt':
      if (c === 'very_much_so')         return "r.raw_value ILIKE 'Very much%'";
      if (c === 'somewhat_or_higher')   return "(r.raw_value ILIKE 'Very much%' OR r.raw_value ILIKE 'Somewhat%')";
      if (c === 'not_at_all')           return "r.raw_value ILIKE 'Not at all%'";
      return null;
    case 'select_all':
      if (c === 'selected')     return 'r.is_selected = true';
      if (c === 'not_selected') return '(r.is_selected = false OR r.is_selected IS NULL)';
      return null;
    case 'likelihood':
      if (c === 'very_likely')  return "r.raw_value ILIKE 'Very likely%'";
      if (c === 'top_2_box')    return "(r.raw_value ILIKE 'Very likely%' OR r.raw_value ILIKE 'Somewhat likely%')";
      if (c === 'below_top')    return "NOT (r.raw_value ILIKE 'Very likely%')";
      return null;
    case 'familiarity':
      if (c === 'very_familiar') return "r.raw_value ILIKE 'Very familiar%'";
      if (c === 'top_2_box')     return "(r.raw_value ILIKE 'Very familiar%' OR r.raw_value ILIKE 'Somewhat familiar%')";
      if (c === 'below_top')     return "NOT (r.raw_value ILIKE 'Very familiar%')";
      return null;
    case 'agreement':
      if (c === 'strongly_agree') return "r.raw_value ILIKE 'Strongly agree%'";
      if (c === 'top_2_box')      return "(r.raw_value ILIKE 'Strongly agree%' OR r.raw_value ILIKE 'Somewhat agree%')";
      if (c === 'below_top')      return "NOT (r.raw_value ILIKE 'Strongly agree%')";
      return null;
    case 'ordinal_0_5':
      if (c === 'top_box')      return 'r.numeric_value = 5';
      if (c === 'top_2_box')    return 'r.numeric_value >= 4';
      if (c === 'above_median') return 'r.numeric_value >= 3';
      return null;
    default:
      return null;
  }
}

/**
 * Build a SQL expression that selects the respondent_id set for the given
 * joy-pattern rules. Each rule = {item_id, kind, criterion}. Multiple rules
 * intersect (AND logic) — every respondent must match every rule.
 *
 * Returns a SQL string of the form `(SELECT respondent_id FROM ...)` that
 * can be embedded in another query as a respondent_id list. Caller controls
 * how it gets used (IN, JOIN, etc.).
 *
 * Returns null if rules is empty or no rules produced valid clauses.
 */
function buildJoyPatternCohortSQL(rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  const perRuleSelects = [];
  for (const rule of rules) {
    const itemId = Number(rule.item_id);
    if (!Number.isFinite(itemId) || itemId <= 0) continue;
    const clause = buildCriterionClause(rule.kind, rule.criterion);
    if (!clause) continue;
    perRuleSelects.push(`
      SELECT DISTINCT r.respondent_id
      FROM bjl_responses r
      WHERE r.item_id = ${itemId}
        AND ${clause}
    `);
  }
  if (perRuleSelects.length === 0) return null;
  if (perRuleSelects.length === 1) {
    return `(${perRuleSelects[0]})`;
  }
  // Multi-rule: intersect respondent sets via INTERSECT
  return `(${perRuleSelects.join('\nINTERSECT\n')})`;
}

module.exports = {
  PICKER_QUESTION_TYPES,
  CRITERION_OPTIONS,
  classifyScaleKind,
  buildCriterionClause,
  buildJoyPatternCohortSQL,
};
