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

    // bjl_finding via /api/bjl-query investigator pipeline.
    //
    // The previous implementation ran its own FTS + Sonnet synthesis here.
    // That approach was fast but narrow — it never saw the corpus-wide
    // aggregates the investigator produces. The new path enqueues a job
    // on /api/bjl-query with email_mode=true and polls /api/bjl-query-status
    // for the one-sentence result. Generation is slower but the finding
    // is defensible across the full bjl_verbatims/bjl_responses corpus,
    // and the synthesize stage's email_mode override (in
    // bjl-query-background.js) trims the output to a single counterintuitive
    // sentence rather than the standard interpretive response.
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const hostHeader = event.headers.host || event.headers.Host;
    const siteUrl = process.env.URL || (hostHeader ? `https://${hostHeader}` : '');
    if (!siteUrl) {
      console.error('[bjl-content] bjl_finding: no site URL available for server-to-server call');
      return { statusCode: 200, body: JSON.stringify({ found: false, type: 'bjl_finding', error: 'no_site_url' }) };
    }

    const categoryLabel = (category && category.trim()) || 'this category';
    const companyLabel = (company || '').trim() || 'a brand in this category';
    const painSummary = (Array.isArray(painKeywords) ? painKeywords : [])
      .filter(Boolean)
      .slice(0, 6)
      .join(', ');
    const investigatorPrompt =
      `Find one counterintuitive finding from BJL consumer research that would land as a data point ` +
      `in a cold outreach email to ${companyLabel}, a ${categoryLabel} brand` +
      (painSummary ? ` (signals: ${painSummary})` : '') +
      `. Look for what consumers in or adjacent to this category actually do, feel, or prefer — ` +
      `especially anything that contradicts what brands like ${companyLabel} typically assume about their audience.`;

    let jobId = null;
    try {
      const enqRes = await fetch(`${siteUrl}/.netlify/functions/bjl-query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authHeader ? { Authorization: authHeader } : {}),
        },
        body: JSON.stringify({
          query: investigatorPrompt,
          intentHint: 'email_findings',
          email_mode: true,
          mode: 'email',
        }),
      });
      if (enqRes.status !== 202) {
        const txt = await enqRes.text().catch(() => '');
        console.error('[bjl-content] bjl-query enqueue non-202:', enqRes.status, txt.slice(0, 300));
        return {
          statusCode: 200,
          body: JSON.stringify({
            found: false, type: 'bjl_finding',
            error: 'enqueue_failed', enqueue_status: enqRes.status,
          }),
        };
      }
      const enqData = await enqRes.json();
      jobId = enqData && enqData.job_id;
    } catch (e) {
      console.error('[bjl-content] bjl-query enqueue threw:', e && e.message);
      return { statusCode: 200, body: JSON.stringify({ found: false, type: 'bjl_finding', error: 'enqueue_threw' }) };
    }
    if (!jobId) {
      return { statusCode: 200, body: JSON.stringify({ found: false, type: 'bjl_finding', error: 'no_job_id' }) };
    }

    // Poll bjl-query-status for completion. Budget leaves headroom under
    // the sync-function timeout ceiling; if the investigator hasn't
    // converged in this window the orchestrator just omits the BJL block.
    const POLL_INTERVAL_MS = 2000;
    const POLL_BUDGET_MS   = 22000;
    const pollStart = Date.now();
    let finalJob = null;
    while (Date.now() - pollStart < POLL_BUDGET_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      try {
        const statusRes = await fetch(
          `${siteUrl}/.netlify/functions/bjl-query-status?id=${encodeURIComponent(jobId)}`,
          { headers: authHeader ? { Authorization: authHeader } : {} }
        );
        if (statusRes.status !== 200) continue;
        const sb = await statusRes.json();
        if (sb.status === 'complete' || sb.status === 'error' || sb.status === 'clarification_needed') {
          finalJob = sb;
          break;
        }
      } catch (e) {
        console.warn('[bjl-content] status poll threw:', e && e.message);
      }
    }

    const pollMs = Date.now() - pollStart;
    console.log('[bjl-content] bjl_finding (investigator)', {
      jobId,
      poll_ms: pollMs,
      final_status: finalJob && finalJob.status,
      query_count: finalJob && finalJob.query_count,
      stage: finalJob && finalJob.stage,
    });

    if (!finalJob || finalJob.status !== 'complete' || !finalJob.finding) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          found: false,
          type: 'bjl_finding',
          error: finalJob ? finalJob.status : 'investigator_timeout',
          job_id: jobId,
          poll_ms: pollMs,
        }),
      };
    }

    const observation = stripScoreLanguage(String(finalJob.finding).trim());
    if (!observation) {
      return { statusCode: 200, body: JSON.stringify({ found: false, type: 'bjl_finding', job_id: jobId }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        found: true,
        type: 'bjl_finding',
        data: { observation, category: category || null },
        inputs: {
          via: 'investigator',
          job_id: jobId,
          query_count: finalJob.query_count || 0,
          poll_ms: pollMs,
          category_label: categoryLabel,
        },
        // The Sources panel expects score_rows + verbatims arrays. With the
        // investigator path the raw inputs aren't easily extractable from
        // the scratch JSON, and the user's spec says the full analysis is
        // discarded. Surface a single provenance line so the panel shows
        // where the finding came from; leave verbatims empty.
        sources: {
          score_rows: [
            `BJL investigator pipeline (${finalJob.query_count || 0} corpus queries, job ${String(jobId).slice(0, 8)})`,
          ],
          verbatims: [],
        },
      }),
    };
  } catch (e) {
    console.error('[bjl-content] unexpected error:', e);
    return { statusCode: 500, body: JSON.stringify({ error: 'Unexpected error', detail: e.message }) };
  }
};
