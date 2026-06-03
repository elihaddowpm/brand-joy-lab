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

// bjl_finding is no longer served here. Frontend now pre-pulls per account
// via /api/bjl-query with email_mode: true and injects the cached one-sentence
// observation directly into generateOneEmail. Keeping case_study and article
// here; both are stable.
const VALID_TYPES = ['case_study', 'article', 'approved_email'];

// Approved-email retrieval limits. One query PER requested content type
// (PER_TYPE each) so a sparse pool — e.g. a single bjl_insight example among
// 25+ case studies — is guaranteed representation rather than being crowded
// out by a shared limit that fills with the dominant type. FALLBACK is used
// when the brief signals no content type; CAP bounds the combined,
// deduplicated set passed to the model so context stays lean as the catalog
// grows.
const APPROVED_EMAIL_PER_TYPE = 2;
const APPROVED_EMAIL_FALLBACK = 3;
const APPROVED_EMAIL_CAP = 5;
// Content types queried, in signal-priority order (bjl > case study > article).
const APPROVED_EMAIL_CONTENT_TYPES = ['bjl_insight', 'case_study', 'article_share'];
const APPROVED_EMAIL_RETURN = ['subject', 'body', 'final_text', 'company', 'brief'];
const APPROVED_EMAIL_SELECT = 'id, subject, body, final_text, company, brief, content_types, cadence_position';

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

    if (body.type === 'approved_email') {
      // Retrieval over the approved-email corpus. One query PER requested
      // content type, each with its own limit, so a sparse pool (e.g. a single
      // bjl_insight example among 25+ case studies) is guaranteed
      // representation instead of being crowded out — a shared limit fills
      // with the dominant type before it ever reaches the rare one. Results
      // are combined, deduplicated by id, and capped. The embedding column
      // exists for a later semantic phase but is unused here.
      const contentTypes = Array.isArray(body.content_types)
        ? body.content_types.filter(t => typeof t === 'string' && t)
        : [];

      const examplesByType = [];
      // Query each requested type in signal-priority order. Skip types the
      // brief didn't ask for.
      for (const ct of APPROVED_EMAIL_CONTENT_TYPES) {
        if (!contentTypes.includes(ct)) continue;
        const { data, error } = await supabase
          .from('bjl_approved_emails')
          .select(APPROVED_EMAIL_SELECT)
          .contains('content_types', [ct])
          .not('body', 'is', null)
          .order('approved_at', { ascending: false })
          .limit(APPROVED_EMAIL_PER_TYPE);
        if (error) {
          console.error('[bjl-content] approved_emails query error:', error);
          return { statusCode: 500, body: JSON.stringify({ error: 'Lookup failed', detail: error.message }) };
        }
        if (data) examplesByType.push(...data);
      }

      // No content signal fired (or none matched): fall back to a few recent
      // general examples so drafting still has voice/structure anchors.
      if (examplesByType.length === 0) {
        const { data, error } = await supabase
          .from('bjl_approved_emails')
          .select(APPROVED_EMAIL_SELECT)
          .not('body', 'is', null)
          .order('approved_at', { ascending: false })
          .limit(APPROVED_EMAIL_FALLBACK);
        if (error) {
          console.error('[bjl-content] approved_emails fallback query error:', error);
          return { statusCode: 500, body: JSON.stringify({ error: 'Lookup failed', detail: error.message }) };
        }
        if (data) examplesByType.push(...data);
      }

      // Deduplicate by id (a multi-type email can match more than one query),
      // then cap the total passed to the model.
      const seen = new Set();
      const deduped = examplesByType
        .filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; })
        .slice(0, APPROVED_EMAIL_CAP);

      if (deduped.length === 0) {
        return { statusCode: 200, body: JSON.stringify({ found: false, type: 'approved_email' }) };
      }
      const top = deduped.map(x => pick(x, APPROVED_EMAIL_RETURN));
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ found: true, type: 'approved_email', data: top }),
      };
    }

    // bjl_finding removed — frontend now pre-pulls per account via
    // /api/bjl-query with email_mode: true and injects the cached
    // one-sentence finding directly into generateOneEmail. The
    // VALID_TYPES gate above rejects type:bjl_finding requests with
    // 400; this fallthrough exists only as a defensive guard.
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Unhandled type: ${body.type}` }),
    };
  } catch (e) {
    console.error('[bjl-content] unexpected error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Unexpected error', detail: e.message }) };
  }
};
