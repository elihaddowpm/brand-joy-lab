// case_study_loader.js
// Loads the structured case study library and filters it against prospect context
// to return only the case studies most likely to be relevant for a given email.
//
// Design intent:
// - Keep filter logic simple: tag-match scoring with light boost for exact category hits
// - Return 2-3 case studies (never zero) so the email writer always has material
// - Distinguish between "insight parallel" cases and "process parallel" cases
//   so the email writer can pick the right archetype for the prospect's pain
// - Honor the results_type flag so cases without numbers (Petoskey) are used appropriately

let _libraryCache = null;

/**
 * Load the case study library. Cached after first call.
 * @returns {Promise<Object>} Parsed library.json
 */
export async function loadLibrary() {
  if (_libraryCache) return _libraryCache;
  const response = await fetch("/case_studies/library.json");
  if (!response.ok) {
    throw new Error(`Failed to load case study library: ${response.status}`);
  }
  _libraryCache = await response.json();
  return _libraryCache;
}

/**
 * Score a case study against prospect context.
 *
 * prospectContext shape:
 * {
 *   category: string,              // prospect category/industry, e.g. "destination marketing", "healthcare"
 *   pain_shape: "brand" | "performance" | "mixed",  // is the prospect's pain positioning or performance?
 *   pain_keywords: string[],       // extracted keywords from Waldo + BJL insights
 *   audience_hints: string[],      // audience pattern keywords if available
 *   needs_current_proof: boolean,  // does the prospect need to see recent work specifically?
 *   needs_quantitative_proof: boolean  // does this email require numerical results?
 * }
 *
 * @param {Object} caseStudy - One case study object from library.json
 * @param {Object} prospectContext - Extracted context about the prospect
 * @returns {number} Score (higher is more relevant)
 */
function scoreCaseStudy(caseStudy, prospectContext) {
  let score = 0;
  const { category, pain_shape, pain_keywords = [], audience_hints = [], needs_current_proof, needs_quantitative_proof } = prospectContext;

  // Tag overlap: each matched keyword counts
  const allTags = [...(caseStudy.use_for_tags || [])];
  const allContext = [...(pain_keywords || []), ...(audience_hints || [])].map(s => s.toLowerCase());
  for (const tag of allTags) {
    const normalizedTag = tag.toLowerCase().replace(/_/g, " ");
    for (const ctx of allContext) {
      if (normalizedTag.includes(ctx) || ctx.includes(normalizedTag)) {
        score += 2;
      }
    }
  }

  // Category match: boost if prospect category matches the use_for_narrative
  if (category && caseStudy.use_for_narrative) {
    const narrative = caseStudy.use_for_narrative.toLowerCase();
    if (narrative.includes(category.toLowerCase())) {
      score += 5;
    }
  }

  // Parallel type match: strongly prefer the right archetype
  if (pain_shape === "performance" && caseStudy.parallel_type === "process") {
    score += 10;
  }
  if (pain_shape === "brand" && caseStudy.parallel_type === "insight") {
    score += 3;
  }
  // Mixed shape doesn't get a boost either way — rely on tag match

  // Exclude process cases for brand-pain prospects and vice versa (hard filter)
  if (pain_shape === "brand" && caseStudy.parallel_type === "process") {
    score -= 20;
  }
  if (pain_shape === "performance" && caseStudy.parallel_type === "insight") {
    score -= 10;
  }

  // Timing boost: prefer current work if the prospect needs it
  if (needs_current_proof) {
    if (caseStudy.timing_frame === "current" || caseStudy.timing_frame === "brand_new") {
      score += 4;
    }
  }

  // Exclude cases without numerical results when numbers are required
  if (needs_quantitative_proof && caseStudy.results_type === "descriptive_only") {
    score -= 15;
  }

  return score;
}

/**
 * Filter the case study library down to the 2-3 most relevant entries for this prospect.
 *
 * Always returns at least 2 case studies (falling back to generic brand cases if scoring fails)
 * so the email writer never gets an empty library.
 *
 * @param {Object} prospectContext - Context about the prospect
 * @param {number} [maxCases=3] - Maximum number of cases to return
 * @returns {Promise<Array>} Array of case study objects ranked by relevance
 */
export async function filterCaseStudies(prospectContext, maxCases = 3) {
  const library = await loadLibrary();
  const scored = library.case_studies.map(cs => ({
    case_study: cs,
    score: scoreCaseStudy(cs, prospectContext)
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Take the top maxCases, but ensure we always return at least 2
  const topN = scored.slice(0, Math.max(maxCases, 2));

  // If the top score is very low (all cases are weak matches), also include a safe default brand case
  // so the email writer has something defensible to reach for
  if (scored.length > 0 && scored[0].score < 3) {
    const brandDefault = scored.find(s => 
      s.case_study.parallel_type === "insight" && 
      s.case_study.results_type === "quantitative" &&
      !topN.some(t => t.case_study.identifier === s.case_study.identifier)
    );
    if (brandDefault && topN.length < maxCases) {
      topN.push(brandDefault);
    }
  }

  return topN.map(s => s.case_study);
}

/**
 * Format filtered case studies into the text block that goes into the buildEmailSystem prompt.
 * This replaces the hard-coded CASE_STUDY_LIBRARY constant.
 *
 * @param {Array} caseStudies - Array of case study objects (output of filterCaseStudies)
 * @returns {string} Formatted text block
 */
export function formatCaseStudiesForPrompt(caseStudies) {
  if (!caseStudies || caseStudies.length === 0) {
    return "No case studies pre-selected for this prospect. Use agency credentials only; do not fabricate case study references.";
  }

  const primary = caseStudies[0];
  const alternatives = caseStudies.slice(1);

  let output = "PRIMARY CASE STUDY (cite this one as the parallel reference in the email):\n\n";
  output += formatSingleCaseStudy(primary);

  if (alternatives.length > 0) {
    output += "\n\nOTHER CASE STUDIES THE FILTER CONSIDERED (do not cite these; shown only so you understand what was ranked below the primary and why):\n\n";
    output += alternatives.map(formatSingleCaseStudy).join("\n\n");
  }

  return output;
}

function formatSingleCaseStudy(cs) {
  const lines = [];
  lines.push(`─── ${cs.client.toUpperCase()} / ${cs.campaign.toUpperCase()} ───`);
  if (cs.url) lines.push(`URL: ${cs.url}`);
  lines.push(`When: ${cs.when}`);
  lines.push(`Situation: ${cs.situation}`);
  lines.push(`Strategic move: ${cs.strategic_move}`);
  lines.push(`Work: ${cs.work}`);
  lines.push(`Results: ${cs.results}`);
  lines.push(`Parallel type: ${cs.parallel_type}`);
  lines.push(`Use for: ${cs.use_for_narrative}`);
  if (cs.relative_positioning) lines.push(`Relative positioning: ${cs.relative_positioning}`);
  if (cs.email_usage_note) lines.push(`EMAIL USAGE NOTE: ${cs.email_usage_note}`);
  if (cs.relationship_credential) lines.push(`Relationship credential: ${cs.relationship_credential}`);
  return lines.join("\n");
}

/**
 * Extract prospect context from a Waldo object and BJL insights.
 * This is the bridge between the tool's existing data flow and the filter.
 *
 * @param {Object} params
 * @param {Object} [params.waldo] - Parsed Waldo JSON for the account
 * @param {string} [params.bjlInsights] - Pulled BJL insights text
 * @param {string} [params.strategistContext] - Strategist's PETERMAYER context note
 * @param {string} [params.prospectCategory] - Explicit category if known
 * @returns {Object} prospectContext suitable for filterCaseStudies
 */
export function extractProspectContext({ waldo, bjlInsights, strategistContext, prospectCategory }) {
  const pain_keywords = [];
  const audience_hints = [];
  let pain_shape = "brand"; // default assumption
  let needs_current_proof = false;
  let needs_quantitative_proof = true; // default: first-touch emails want defensible numbers

  // Extract signal keywords from Waldo if present
  if (waldo) {
    const waldoText = JSON.stringify(waldo).toLowerCase();
    
    // Performance-pain keywords
    const performanceIndicators = ["roas", "cac", "attribution", "booking cost", "performance marketing", 
                                    "conversion", "cost per", "media efficiency", "media waste", "measurement",
                                    "ceo pressure on revenue", "revenue pressure", "budget cut", "flat budget",
                                    "fragmented media", "multi-location", "portfolio", "multi-property"];
    const performanceHits = performanceIndicators.filter(term => waldoText.includes(term));
    if (performanceHits.length >= 2) {
      pain_shape = "performance";
    } else if (performanceHits.length === 1) {
      pain_shape = "mixed";
    }
    pain_keywords.push(...performanceHits);

    // Brand-pain keywords
    const brandIndicators = ["positioning", "repositioning", "brand refresh", "identity", "platform",
                             "differentiation", "category", "audience shift", "rebrand", "tagline",
                             "creative", "emotional territory", "perception", "resonance"];
    pain_keywords.push(...brandIndicators.filter(term => waldoText.includes(term)));

    // Audience hints
    const audienceIndicators = ["multicultural", "diverse audience", "black", "latino", "gen z", "millennial",
                                "boomer", "family", "parents", "wellness", "luxury", "heritage",
                                "performance marketing", "destination", "tourism", "cvb", "hospitality"];
    audience_hints.push(...audienceIndicators.filter(term => waldoText.includes(term)));
  }

  // Add BJL insights text to the keyword mining
  if (bjlInsights) {
    const bjlLower = bjlInsights.toLowerCase();
    const joyKeywords = ["escape", "discovery", "reconnection", "reset", "anticipation", "playful",
                         "tranquil", "relational", "aspirational", "wonder", "belonging"];
    pain_keywords.push(...joyKeywords.filter(term => bjlLower.includes(term)));
  }

  return {
    category: prospectCategory || null,
    pain_shape,
    pain_keywords: [...new Set(pain_keywords)], // dedupe
    audience_hints: [...new Set(audience_hints)],
    needs_current_proof,
    needs_quantitative_proof
  };
}
