/**
 * bjl-waldo-extractor.js — source-aware extractor for Waldo brand JSON
 * (Joy Map Delta 0).
 *
 * The synthesis layer must not treat the Waldo JSON as undifferentiated
 * brand input. Some fields are positioning claims; some are factual context;
 * some are stated absences; some are tactical actions; some are pain points
 * (consumer-reported friction). Feeding the LLM the raw JSON produced wrong
 * findings (perceived_gaps read as brand emphasis, category trends read as
 * brand emphasis, pain points read as brand emphasis).
 *
 * This module classifies the JSON into three buckets:
 *
 *   - emphasis: positioning content the brand actively claims about itself.
 *               Eligible for alignment or misalignment findings.
 *   - tactical: actions the brand is currently taking (investments,
 *               relaunches, events). Weak positioning signal. Eligible for
 *               alignment when consistent with stated positioning; eligible
 *               for misalignment only when sharply inconsistent. Default to
 *               caution.
 *   - friction: consumer-reported pain points. Eligible for opportunity
 *               framing only. NEVER eligible for misalignment.
 *
 * Excluded paths (never contribute brand_snippet content):
 *   - any path under four_cs.category.*       (category context, not brand)
 *   - any *.perceived_gaps                     (stated absences, not claims)
 *   - four_cs.consumer.demographic_profile.*   (factual)
 *   - four_cs.consumer.behavioral_signals.*    (factual)
 *   - four_cs.company.verified_milestones.*    (events, not positioning)
 *   - four_cs.company.employee_sentiment.*     (internal, not brand-facing)
 *
 * The synthesis prompt is hardcoded to source brand_snippet ONLY from the
 * three labeled arrays this module produces. Anything else is forbidden.
 */

// Object fields we treat as text-bearing when flattening. Generic enough
// to handle the variety of object shapes inside the four Cs without
// pulling junk like timestamps or attribution metadata.
const TEXT_BEARING_FIELDS = [
  'statement', 'text', 'quote', 'description', 'name', 'archetype',
  'summary', 'value', 'goal', 'sentiment', 'example', 'mission',
  'unspoken_rule', 'unspoken_code', 'meaning', 'why_they_belong',
  'how_they_show_up', 'investment', 'investment_description',
  'pain_point', 'context', 'detail',
];

function getPath(obj, dottedPath) {
  if (!obj) return undefined;
  return dottedPath.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function flattenStrings(v, label) {
  const out = [];
  if (v == null) return out;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed.length > 0) out.push({ snippet: trimmed, source_path: label });
    return out;
  }
  if (Array.isArray(v)) {
    v.forEach((item, i) => out.push(...flattenStrings(item, `${label}[${i}]`)));
    return out;
  }
  if (typeof v === 'object') {
    for (const key of TEXT_BEARING_FIELDS) {
      const val = v[key];
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed.length > 0) out.push({ snippet: trimmed, source_path: `${label}.${key}` });
      } else if (Array.isArray(val)) {
        val.forEach((item, i) => {
          if (typeof item === 'string' && item.trim().length > 0) {
            out.push({ snippet: item.trim(), source_path: `${label}.${key}[${i}]` });
          }
        });
      }
    }
    return out;
  }
  return out;
}

// Whitelisted paths for brand emphasis (positioning content the brand
// actively claims about itself).
const EMPHASIS_PATHS = [
  'four_cs.consumer.consumer_goals.functional',
  'four_cs.consumer.consumer_goals.emotional',
  'four_cs.consumer.consumer_goals.higher_order',
  'four_cs.consumer.verified_positive_sentiments.examples',
  'four_cs.consumer.current_mindset.summary',
  'four_cs.culture.cultural_fight.statement',
  'four_cs.culture.brand_archetype',
  'four_cs.culture.subcultures_fhf_belongs_to.subcultures',
  'four_cs.culture.cultural_muses.muses',
  'four_cs.company.origin.founding_mission',
  'four_cs.company.core_values.values',
  'four_cs.company.brand_promise.statement',
];

const TACTICAL_PATH = 'four_cs.company.verified_strategic_investments.investments';
const FRICTION_PATH  = 'four_cs.consumer.verified_pain_points.examples';

function extractWaldoBrandFields(json) {
  if (!json || typeof json !== 'object') {
    return { emphasis: [], tactical: [], friction: [] };
  }
  const emphasis = [];
  for (const path of EMPHASIS_PATHS) {
    const v = getPath(json, path);
    if (v != null) emphasis.push(...flattenStrings(v, path));
  }
  const tactical = flattenStrings(getPath(json, TACTICAL_PATH), TACTICAL_PATH);
  const friction = flattenStrings(getPath(json, FRICTION_PATH), FRICTION_PATH);
  return { emphasis, tactical, friction };
}

module.exports = {
  EMPHASIS_PATHS,
  TACTICAL_PATH,
  FRICTION_PATH,
  extractWaldoBrandFields,
  // exported for tests
  _flattenStrings: flattenStrings,
};
