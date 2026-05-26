/**
 * bjl-content.js — synchronous lookup for case studies, articles, and BJL findings
 *
 * POST body:
 *   {
 *     type:          "case_study" | "article" | "bjl_finding",
 *     category:      string,
 *     pain_keywords: string[],
 *     batch_index:   number      // case_study + bjl_finding; preserves cross-contact rotation
 *   }
 *
 * Response:
 *   { found: true,  type, data: { ... whitelisted fields ... } }
 *   { found: false, type }
 *
 * Scoring (case_study / article): count overlap between row tags
 * (use_for_tags for case studies, tags for articles) and the caller's
 * pain_keywords, +1 if the prospect category appears in those tags.
 * Sort descending; return ranked[batch_index % ranked.length] for case
 * studies, or ranked[0] for articles.
 *
 * bjl_finding: query bjl_scores (3,500+ rows; despite the "LEGACY" comment
 * on the schema, this is the table that holds finding-level aggregates
 * keyed by category + joy_index, which is what we need for a single
 * behavioral observation). Map the prospect category to a BJL category via
 * exact-then-fuzzy-then-general_joy fallback. Take top N by joy_index,
 * rotate by batch_index, then strip any numeric score references before
 * returning a single observation string. The LLM is instructed by the
 * [BJL FINDING] wrapper to translate the raw observation into one plain
 * behavioral sentence; the stripper here is belt-and-suspenders so a
 * residual "44.2" or "JI 60" can't leak into the email.
 *
 * Anon-key reads are sufficient: RLS is disabled on bjl_case_studies and
 * bjl_articles. bjl_scores has RLS enabled; the function uses service_role
 * (configured in env), which bypasses RLS.
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
// bjl_finding synthesis runs on Sonnet, not Haiku — Haiku with 80 tokens
// only summarizes; Sonnet with room to reason can surface a tension.
const SONNET_MODEL = 'claude-sonnet-4-20250514';

// Length of the title prefix used for in-brief substring matching. Long
// enough to be distinctive across the article catalog, short enough to
// tolerate strategists abbreviating or only naming the first phrase.
const TITLE_MATCH_LEN = 25;

const VALID_TYPES = ['case_study', 'article', 'bjl_finding'];

// Loose mapping from prospect categories (which come from Waldo account
// data, ad-hoc strings like "destination_marketing" or "attractions_entertainment")
// to BJL category keys (a fixed taxonomy: travel_destinations, travel_attractions,
// travel_hospitality, food_joy, sports_fandom, ...). Substring match in priority
// order. If nothing hits, fall back to general_joy.
const BJL_CATEGORY_FUZZY = [
  { needle: 'destination', cat: 'travel_destinations' },
  { needle: 'attraction',  cat: 'travel_attractions' },
  { needle: 'hospital',    cat: 'travel_hospitality' },
  { needle: 'travel',      cat: 'travel_journey_stages' },
  { needle: 'tourism',     cat: 'travel_destinations' },
  { needle: 'food',        cat: 'food_joy' },
  { needle: 'restaurant',  cat: 'food_eating' },
  { needle: 'grocer',      cat: 'retail_grocery' },
  { needle: 'retail',      cat: 'retail_grocery' },
  { needle: 'sport',       cat: 'sports_fandom' },
  { needle: 'tailgat',     cat: 'sports_tailgating' },
  { needle: 'health',      cat: 'health_wellness' },
  { needle: 'wellness',    cat: 'health_wellness' },
  { needle: 'tech',        cat: 'technology_internet' },
  { needle: 'internet',    cat: 'technology_internet' },
  { needle: 'furnitur',    cat: 'home_furniture' },
  { needle: 'home',        cat: 'home_furniture' },
  { needle: 'financ',      cat: 'financial' },
  { needle: 'bank',        cat: 'financial' },
  { needle: 'celebr',      cat: 'celebrities' },
];

function resolveBjlCategory(input) {
  const c = String(input || '').toLowerCase().trim();
  if (!c) return null;
  // Exact match first
  const direct = ['travel_destinations','travel_attractions','travel_hospitality','travel_journey_stages',
    'brand_trust','celebrities','financial','food_eating','food_joy','general_joy',
    'health_ratings','health_wellness','home_furniture','retail_grocery','sports_fandom',
    'sports_tailgating','technology_internet'];
  if (direct.includes(c)) return c;
  // Fuzzy substring match in priority order
  for (const { needle, cat } of BJL_CATEGORY_FUZZY) {
    if (c.includes(needle)) return cat;
  }
  return null;
}

// Strip residual numeric score references before returning a finding text.
// The LLM is also instructed not to quote them; this is a safety net.
function stripScoreLanguage(s) {
  return String(s || '')
    .replace(/\d+\.?\d*\s*(?:joy\s*)?(?:index\s*)?points?/gi, '')
    .replace(/\bJI\s*\d+\.?\d*/gi, '')
    .replace(/\bscored?\s+\d+\.?\d*/gi, '')
    .replace(/\bjoy\s+index\s+of\s+\d+\.?\d*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function composeFindingObservation(row) {
  const item = String(row.item_name || '').trim();
  // Trim common survey-question scaffolding so the observation reads more
  // like a behavioral statement and less like a poll prompt.
  let q = String(row.question || '').trim();
  q = q.replace(/^to what (degree|extent)\s+(would|do|does|did)\s+/i, '')
       .replace(/^how much\s+(would|do|does|did)\s+/i, '')
       .replace(/[?]+\s*$/, '')
       .replace(/\bbring\s+you\s+joy\b/i, 'bring people joy')
       .trim();
  const composed = item && q ? `${item} — ${q}` : (item || q);
  return stripScoreLanguage(composed);
}

const CASE_STUDY_FIELDS = [
  'identifier', 'client', 'campaign', 'when_note',
  'situation', 'strategic_move', 'work',
  'results', 'results_type', 'parallel_type',
  'email_usage_note', 'use_for_tags',
].join(', ');

const ARTICLE_FIELDS = [
  'title', 'author', 'url', 'summary', 'key_findings', 'tags',
].join(', ');

const CASE_STUDY_RETURN = [
  'identifier', 'client', 'campaign', 'when_note',
  'situation', 'strategic_move', 'work',
  'results', 'results_type', 'parallel_type', 'email_usage_note',
];

const ARTICLE_RETURN = ['title', 'author', 'url', 'summary', 'key_findings'];

function pick(row, keys) {
  const out = {};
  for (const k of keys) out[k] = row[k];
  return out;
}

function scoreRow(rowTags, painKeywords, category) {
  const tags = Array.isArray(rowTags) ? rowTags : [];
  const kws = Array.isArray(painKeywords) ? painKeywords : [];
  const cat = (category || '').trim();
  const tagSet = new Set(tags.map(t => String(t).toLowerCase()));
  let score = 0;
  for (const kw of kws) {
    if (tagSet.has(String(kw).toLowerCase())) score += 1;
  }
  if (cat && tagSet.has(cat.toLowerCase())) score += 1;
  return score;
}

// Like scoreRow but returns the actual list of overlapping tags (preserving
// the row's original casing). Used to build the sources panel so the user
// can see which prospect signals drove the match.
function overlapTags(rowTags, painKeywords, category) {
  const tags = Array.isArray(rowTags) ? rowTags : [];
  const kwSet = new Set(
    (Array.isArray(painKeywords) ? painKeywords : []).map(k => String(k).toLowerCase())
  );
  const catLow = String(category || '').toLowerCase().trim();
  const matched = [];
  for (const t of tags) {
    const tl = String(t).toLowerCase();
    if (kwSet.has(tl) || (catLow && tl === catLow)) matched.push(t);
  }
  return Array.from(new Set(matched));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!VALID_TYPES.includes(body.type)) {
    return { statusCode: 400, body: JSON.stringify({ error: `type must be one of ${VALID_TYPES.join(', ')}` }) };
  }

  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return {
      statusCode: auth.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error, message: auth.message, email: auth.email }),
    };
  }

  const category      = typeof body.category === 'string' ? body.category : '';
  const painKeywords  = Array.isArray(body.pain_keywords) ? body.pain_keywords : [];
  const batchIndex    = Number.isFinite(body.batch_index) ? body.batch_index : 0;
  const brief         = typeof body.brief === 'string' ? body.brief : '';
  const company       = typeof body.company === 'string' ? body.company : '';

  try {
    if (body.type === 'case_study') {
      const { data, error } = await supabase
        .from('bjl_case_studies')
        .select(CASE_STUDY_FIELDS)
        .eq('is_active', true);
      if (error) {
        console.error('[bjl-content] case_studies query error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Lookup failed', detail: error.message }) };
      }
      const rows = data || [];
      if (rows.length === 0) {
        return { statusCode: 200, body: JSON.stringify({ found: false, type: 'case_study' }) };
      }
      const ranked = rows
        .map(r => ({ row: r, score: scoreRow(r.use_for_tags, painKeywords, category) }))
        .sort((a, b) => b.score - a.score);
      const idx = ((batchIndex % ranked.length) + ranked.length) % ranked.length;
      const chosen = ranked[idx].row;
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          found: true,
          type: 'case_study',
          data: pick(chosen, CASE_STUDY_RETURN),
          sources: {
            identifier: chosen.identifier,
            tags_matched: overlapTags(chosen.use_for_tags, painKeywords, category),
          },
        }),
      };
    }

    if (body.type === 'article') {
      const { data, error } = await supabase
        .from('bjl_articles')
        .select(ARTICLE_FIELDS)
        .eq('is_active', true);
      if (error) {
        console.error('[bjl-content] articles query error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Lookup failed', detail: error.message }) };
      }
      const rows = data || [];
      if (rows.length === 0) {
        return { statusCode: 200, body: JSON.stringify({ found: false, type: 'article' }) };
      }
      // Title-substring match first: if the brief names an article by its
      // opening phrase (first TITLE_MATCH_LEN chars), prefer that article
      // over tag-overlap ranking. Specified-by-name beats heuristic match.
      let chosen = null;
      let matchPath = 'tag_overlap';
      const briefLower = brief.toLowerCase();
      if (briefLower) {
        const hit = rows.find(r => {
          const prefix = String(r.title || '').toLowerCase().slice(0, TITLE_MATCH_LEN).trim();
          return prefix && briefLower.includes(prefix);
        });
        if (hit) {
          chosen = hit;
          matchPath = 'title_substring';
        }
      }
      if (!chosen) {
        const ranked = rows
          .map(r => ({ row: r, score: scoreRow(r.tags, painKeywords, category) }))
          .sort((a, b) => b.score - a.score);
        chosen = ranked[0].row;
      }
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          found: true,
          type: 'article',
          match_path: matchPath,
          data: pick(chosen, ARTICLE_RETURN),
          sources: {
            match_method: matchPath === 'title_substring' ? 'title_match' : 'tag_overlap',
            title: chosen.title,
            tags_matched: overlapTags(chosen.tags, painKeywords, category),
          },
        }),
      };
    }

    // bjl_finding
    const bjlCat = resolveBjlCategory(category);
    // Fetch candidates: try resolved category first, then general_joy fallback.
    async function fetchByCat(cat) {
      const { data, error } = await supabase
        .from('bjl_scores')
        .select('item_name, question, category, joy_index, topics')
        .eq('category', cat)
        .not('joy_index', 'is', null)
        .order('joy_index', { ascending: false })
        .limit(10);
      if (error) {
        console.error('[bjl-content] bjl_scores query error:', error);
        return [];
      }
      return data || [];
    }

    let candidates = bjlCat ? await fetchByCat(bjlCat) : [];
    if (candidates.length === 0 && bjlCat !== 'general_joy') {
      candidates = await fetchByCat('general_joy');
    }
    if (candidates.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ found: false, type: 'bjl_finding' }) };
    }

    // Secondary rank by topic overlap with pain_keywords (the joy_index sort
    // already picked top-of-category; this just nudges among them when the
    // brief named something specific). Take the top 3, then rotate by
    // batch_index so contacts at the same account see different findings.
    const ranked = candidates
      .map(r => ({ row: r, score: scoreRow(r.topics, painKeywords, category) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (ranked.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ found: false, type: 'bjl_finding' }) };
    }
    const idx = ((batchIndex % ranked.length) + ranked.length) % ranked.length;
    const rotated = ranked.slice(idx).concat(ranked.slice(0, idx));
    const lead = rotated[0].row;
    const chosenCategory = lead.category;

    // The rows we just picked are survey instrument text (item + question
    // stem), not findings. Hand them — together with quotable consumer
    // verbatims for the same category — to Sonnet to find a counterintuitive
    // observation. Without this step the email model gets "Hawaii — If you
    // were deciding today about a vacation… be TO CHOOSE each of the
    // following destinations:" and fabricates around it. With richer inputs
    // and a more capable model, it can surface a tension instead of a
    // restatement.
    const surveyContext = rotated
      .map(r => {
        const item = String(r.row.item_name || '').trim();
        const q = String(r.row.question || '').trim();
        return item && q ? `${item} (${q})` : (item || q);
      })
      .filter(Boolean)
      .join(' | ');

    // Verbatims for the chosen category. Prefer quotable rows; widen the
    // filter if we don't get enough. Truncate each to keep token budget in
    // check; verbatims over ~250 chars tend to be tangential anyway.
    let verbatimRows = [];
    try {
      const { data: qVerbs, error: qErr } = await supabase
        .from('bjl_verbatims')
        .select('response_text')
        .eq('category', chosenCategory)
        .eq('is_quotable', true)
        .not('response_text', 'is', null)
        .limit(10);
      if (qErr) console.warn('[bjl-content] quotable verbatim fetch error:', qErr.message);
      verbatimRows = qVerbs || [];
      if (verbatimRows.length < 5) {
        const { data: anyVerbs } = await supabase
          .from('bjl_verbatims')
          .select('response_text')
          .eq('category', chosenCategory)
          .not('response_text', 'is', null)
          .limit(10);
        verbatimRows = anyVerbs || verbatimRows;
      }
    } catch (e) {
      console.warn('[bjl-content] verbatim fetch failed:', e && e.message);
    }
    const verbatimContext = verbatimRows
      .map(v => String(v.response_text || '').trim().replace(/\s+/g, ' ').slice(0, 250))
      .filter(Boolean)
      .join(' | ');

    // Humanize the category for the prompt. Prefer the raw prospect category
    // (closer to how the user names it) over the BJL taxonomy key.
    const categoryLabel = (category && category.trim())
      || String(chosenCategory || '').replace(/_/g, ' ').trim()
      || 'unknown';
    const companyLabel = company.trim() || 'a brand';

    let observation = '';
    if (anthropic) {
      try {
        const synth = await anthropic.messages.create({
          model: SONNET_MODEL,
          max_tokens: 200,
          messages: [{
            role: 'user',
            content:
`You are a strategist preparing a single data point for a cold outreach email to ${companyLabel}, a ${categoryLabel} brand.

Here is BJL consumer research data for this category:

SURVEY FINDINGS:
${surveyContext}

CONSUMER VERBATIMS:
${verbatimContext}

Your job: find the single most counterintuitive or surprising insight in this data — something that reveals a gap between what brands in this category typically assume and what consumers actually experience or feel.

Rules:
- One sentence only
- Plain language — no scores, no percentages, no research terms, no markdown, no headers
- Do not describe obvious preferences (do not say "people enjoy" or "consumers prefer" or "escape from everyday life")
- The sentence should make a CMO lean forward, not nod along
- If the data contains something unexpected about who feels the most joy, when they feel it, or why — lead with that`,
          }],
        });
        const raw = (synth && synth.content && synth.content[0] && synth.content[0].text) || '';
        observation = stripScoreLanguage(String(raw).trim());
      } catch (e) {
        console.error('[bjl-content] sonnet synthesis failed:', e && e.message);
      }
    } else {
      console.error('[bjl-content] ANTHROPIC_API_KEY missing; bjl_finding cannot synthesize');
    }

    if (!observation) {
      return { statusCode: 200, body: JSON.stringify({ found: false, type: 'bjl_finding' }) };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        found: true,
        type: 'bjl_finding',
        data: { observation, category: chosenCategory },
        // Observability: how rich were the inputs? Lets the orchestrator
        // log {scores_n, verbatims_n} and flag thin synthesis upstream.
        inputs: {
          scores_n: rotated.length,
          verbatims_n: verbatimRows.length,
          category_label: categoryLabel,
        },
        // Raw inputs the synthesis call saw, for the email Sources panel.
        // score_rows = the same "item — question" pairs in surveyContext;
        // verbatims = the response_text values, truncation preserved.
        sources: {
          score_rows: rotated.map(r => {
            const item = String(r.row.item_name || '').trim();
            const q = String(r.row.question || '').trim();
            return item && q ? `${item} — ${q}` : (item || q);
          }).filter(Boolean),
          verbatims: verbatimRows
            .map(v => String(v.response_text || '').trim().replace(/\s+/g, ' ').slice(0, 250))
            .filter(Boolean),
        },
      }),
    };
  } catch (e) {
    console.error('[bjl-content] unexpected error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Unexpected error', detail: e.message }) };
  }
};
