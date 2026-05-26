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

    // bjl_finding — inline corpus aggregation.
    //
    // Two-hop server-to-server (bjl-content -> bjl-query -> background ->
    // status polling) exceeded the Netlify sync timeout. This path runs
    // the same shape of analysis inline: aggregate joy_mode and topic
    // distributions across the category's full verbatim corpus, pull a
    // small high-signal verbatim sample via FTS, and hand all three to
    // Sonnet for one synthesized sentence. Defensible because the
    // distributions ARE the corpus, not a sample picked by ranking.
    const resolvedCat = resolveBjlCategory(category) || 'general_joy';
    const categoryLabel = (category && category.trim())
      || resolvedCat.replace(/_/g, ' ');
    const companyLabel = (company || '').trim() || 'a brand in this category';

    // 1. Joy-mode distribution across the corpus slice for this category.
    //    joy_modes is a text[]; unnest client-side. Pull broad so the
    //    distribution is stable; if the server caps the response we use
    //    whatever it returned (still corpus-wide for typical categories).
    const { data: modeRows, error: modeErr } = await supabase
      .from('bjl_verbatims')
      .select('joy_modes')
      .eq('category', resolvedCat)
      .not('joy_modes', 'is', null)
      .limit(10000);
    if (modeErr) console.warn('[bjl-content] joy_modes aggregation error:', modeErr.message);

    const modeCounts = {};
    (modeRows || []).forEach(row => {
      (row.joy_modes || []).forEach(m => {
        if (!m) return;
        modeCounts[m] = (modeCounts[m] || 0) + 1;
      });
    });
    const modeTotal = Object.values(modeCounts).reduce((a, b) => a + b, 0);
    const modeDistribution = Object.entries(modeCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([mode, count]) => `${mode}: ${modeTotal ? Math.round((count / modeTotal) * 100) : 0}% (n=${count})`);

    // 2. Top topics across the same corpus slice.
    const { data: topicRows, error: topicErr } = await supabase
      .from('bjl_verbatims')
      .select('topics')
      .eq('category', resolvedCat)
      .not('topics', 'is', null)
      .limit(10000);
    if (topicErr) console.warn('[bjl-content] topics aggregation error:', topicErr.message);

    const topicCounts = {};
    (topicRows || []).forEach(row => {
      (row.topics || []).forEach(t => {
        if (!t) return;
        topicCounts[t] = (topicCounts[t] || 0) + 1;
      });
    });
    const topTopics = Object.entries(topicCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([topic, count]) => `${topic} (${count})`);

    // 3. Representative verbatim sample via FTS on search_vector. Filter
    //    rejects punctuation that breaks websearch tsquery; >3-char tokens
    //    drawn from company name + pain_keywords drive relevance.
    const tokenize = s => String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3);
    const tokens = Array.from(new Set([
      ...tokenize(company),
      ...((Array.isArray(painKeywords) ? painKeywords : []).flatMap(k => tokenize(k))),
    ]));
    const searchTerms = tokens.join(' OR ');

    let verbatimRows = [];
    if (searchTerms) {
      const { data: vRows, error: vErr } = await supabase
        .from('bjl_verbatims')
        .select('response_text')
        .textSearch('search_vector', searchTerms, { type: 'websearch' })
        .not('response_text', 'is', null)
        .limit(20);
      if (vErr) console.warn('[bjl-content] verbatim FTS error:', vErr.message);
      else verbatimRows = vRows || [];
    }
    const verbatimList = verbatimRows
      .map(r => String(r.response_text || '').trim().replace(/\s+/g, ' ').slice(0, 250))
      .filter(Boolean);
    const verbatimSample = verbatimList.slice(0, 15).join(' | ');

    const verbatimsAnalyzed = (modeRows || []).length;

    console.log('[bjl-content] bjl_finding (inline_aggregate)', {
      raw_category: category,
      resolved_category: resolvedCat,
      verbatims_analyzed: verbatimsAnalyzed,
      mode_total_tags: modeTotal,
      mode_distribution_n: modeDistribution.length,
      top_topics_n: topTopics.length,
      search_terms: searchTerms,
      verbatim_sample_n: verbatimList.length,
    });

    let observation = '';
    if (!anthropic) {
      console.error('[bjl-content] ANTHROPIC_API_KEY missing; bjl_finding cannot synthesize');
    } else if (verbatimsAnalyzed === 0 && verbatimList.length === 0) {
      // Nothing to synthesize — category mismatch or empty slice. Skip
      // the LLM call entirely so we don't waste tokens producing a
      // hallucinated finding from empty context.
      console.warn('[bjl-content] bjl_finding: no corpus data for category', {
        raw_category: category, resolved_category: resolvedCat,
      });
    } else {
      try {
        const synth = await anthropic.messages.create({
          model: SONNET_MODEL,
          max_tokens: 150,
          messages: [{
            role: 'user',
            content:
`You are preparing a single BJL data point for a cold outreach email to ${companyLabel}, a ${categoryLabel} brand.

Here is aggregated BJL consumer research for this category:

JOY MODE DISTRIBUTION (${modeTotal} mode tags across ${verbatimsAnalyzed} verbatims):
${modeDistribution.join('\n') || '(no joy_mode tags in this slice)'}

TOP TOPICS IN VERBATIMS:
${topTopics.join(', ') || '(no topic tags in this slice)'}

REPRESENTATIVE VERBATIMS:
${verbatimSample || '(no verbatim sample available)'}

Your job: find the single most counterintuitive or surprising finding in this data. Something that reveals a gap between what ${companyLabel} and brands like them typically assume about their audience and what consumers actually experience or feel.

Rules:
- One sentence only
- Plain language — no scores, no percentages, no research terms, no markdown
- Do not describe obvious preferences
- Do not use generic phrases like "escape from everyday life" or "people enjoy"
- The finding should make a CMO lean forward, not nod along
- Draw from the joy mode distribution or topic patterns — these are corpus-wide numbers, not anecdotes`,
          }],
        });
        const raw = (synth && synth.content && synth.content[0] && synth.content[0].text) || '';
        observation = stripScoreLanguage(String(raw).trim());
      } catch (e) {
        console.error('[bjl-content] sonnet synthesis failed:', e && e.message);
      }
    }

    if (!observation) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          found: false,
          type: 'bjl_finding',
          diagnostic: {
            raw_category: category,
            resolved_category: resolvedCat,
            verbatims_analyzed: verbatimsAnalyzed,
            mode_total_tags: modeTotal,
            verbatim_sample_n: verbatimList.length,
          },
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        found: true,
        type: 'bjl_finding',
        data: { observation, category: resolvedCat },
        inputs: {
          via: 'inline_aggregate',
          raw_category: category,
          resolved_category: resolvedCat,
          category_label: categoryLabel,
          verbatims_analyzed: verbatimsAnalyzed,
          mode_total_tags: modeTotal,
          search_terms: searchTerms,
        },
        sources: {
          // New fields per spec — Sources panel can render these directly
          // (and the EmailSources component already lists score_rows as
          // bullets, so populating score_rows with the distribution gives
          // the existing UI the corpus-wide view without a frontend edit).
          mode_distribution: modeDistribution,
          top_topics: topTopics,
          verbatim_sample: verbatimList.slice(0, 10),
          total_verbatims_analyzed: verbatimsAnalyzed,
          // Back-compat with the existing EmailSources renderer:
          score_rows: [
            `Verbatims analyzed: ${verbatimsAnalyzed} (category=${resolvedCat})`,
            ...modeDistribution,
            topTopics.length ? `Top topics: ${topTopics.join(', ')}` : '',
          ].filter(Boolean),
          verbatims: verbatimList.slice(0, 10),
        },
      }),
    };
  } catch (e) {
    console.error('[bjl-content] unexpected error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Unexpected error', detail: e.message }) };
  }
};
