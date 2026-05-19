/**
 * bjl-joy-map-background.js — async worker for Dance Map jobs (Joy Map
 * Phase 2).
 *
 * The Dance Map now consumes an Audience Map (created upstream via
 * bjl-audience-map.js) as its audience input. The Audience Map's
 * reverse-engineered cohort, parameters, and authored sections (Joy Peaks,
 * Joy Valleys, Emotional Signature, Decision Context, Demographic Shape,
 * Synthesis paragraph) constitute the audience profile the brand maps
 * against.
 *
 * Pipeline:
 *   1. Load the Dance Map job
 *   2. Load the referenced Audience Map job + its finding
 *   3. Extract brand fields via the v4 source-aware Waldo parser
 *   4. Call Sonnet 4.6 with joy_map_synthesis prompt; user message
 *      contains brand fields + Audience Map profile
 *   5. Cap each section at 5 cards; augment Layer 3 with calibration bands
 *   6. Write to bjl_query_jobs.finding
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk').default;
const { extractWaldoBrandFields } = require('./bjl-waldo-extractor');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const PROMPTS = require('./_prompts_bundle.json');

const SYNTHESIS_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 8000;

function quote(s) {
  if (s === null || s === undefined) return 'NULL';
  return `'${String(s).replace(/'/g, "''")}'`;
}

function buildBrandPayload(brandText, brandJson) {
  if (brandJson) {
    const fields = extractWaldoBrandFields(brandJson);
    return [
      'BRAND INPUT (Waldo JSON, source-aware extraction):',
      '',
      'brand_emphasis (positioning claims — eligible for alignment OR misalignment):',
      JSON.stringify(fields.emphasis, null, 2),
      '',
      'brand_tactical_signals (actions, not positioning — weak signal):',
      JSON.stringify(fields.tactical, null, 2),
      '',
      'brand_friction_points (consumer-reported pain — opportunity-eligible only, NEVER misalignment):',
      JSON.stringify(fields.friction, null, 2),
    ].join('\n');
  }
  return [
    'BRAND INPUT (free-text — treat as a single emphasis blob):',
    '',
    'brand_emphasis:',
    JSON.stringify([{ snippet: brandText || '', source_path: 'free_text' }], null, 2),
    '',
    'brand_tactical_signals: []',
    'brand_friction_points: []',
  ].join('\n');
}

function buildAudienceMapPayload(audienceMap) {
  return [
    'AUDIENCE MAP:',
    '',
    `Routing: ${audienceMap.routing?.routing_notice || audienceMap.routing?.strategy || 'unknown'}`,
    `Reverse-engineered cohort n: ${audienceMap.reverse_engineered_cohort_n}`,
    `Seed cohort n: ${audienceMap.seed_cohort_n}`,
    '',
    'Synthesis paragraph:',
    audienceMap.sections?.synthesis_paragraph || '',
    '',
    'Joy Peaks (themed):',
    JSON.stringify(audienceMap.sections?.joy_peaks, null, 2),
    '',
    'Joy Valleys:',
    JSON.stringify(audienceMap.sections?.joy_valleys, null, 2),
    '',
    'Emotional Signature (top tags per framework + LLM notes):',
    JSON.stringify(audienceMap.sections?.emotional_signature, null, 2),
    '',
    'Decision Context (Layer 2 batteries with audience items):',
    JSON.stringify(audienceMap.sections?.decision_context, null, 2),
    '',
    'Demographic Shape:',
    JSON.stringify(audienceMap.sections?.demographic_shape, null, 2),
  ].join('\n');
}

async function augmentLayer3Confidence(cards) {
  const layer3 = cards.filter(c => String(c.layer) === '3' && c.framework && c.bjl_item_name);
  if (!layer3.length) return cards;
  const keys = layer3.map(c => `(${quote(c.framework)},${quote(c.bjl_item_name)})`).join(',');
  const sql = `
    SELECT framework, tag_key, confidence_band
    FROM bjl_tag_calibration
    WHERE (framework, tag_key) IN (${keys})
  `;
  const { data } = await supabase.rpc('execute_read_sql', { query_text: sql });
  const map = new Map();
  for (const row of data || []) {
    map.set(`${row.framework}|${row.tag_key}`, row.confidence_band);
  }
  for (const c of cards) {
    if (String(c.layer) === '3' && c.framework && c.bjl_item_name) {
      const band = map.get(`${c.framework}|${c.bjl_item_name}`);
      if (band) c.calibration_band = band;
    }
  }
  return cards;
}

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

    const ctx = job.extra_context || {};
    if (ctx.workflow !== 'dance_map') throw new Error(`unsupported workflow: ${ctx.workflow}`);
    if (!ctx.audience_map_job_id) throw new Error('audience_map_job_id missing from extra_context');

    const { data: audJob, error: audErr } = await supabase
      .from('bjl_query_jobs')
      .select('job_id, status, finding, query_type')
      .eq('job_id', ctx.audience_map_job_id)
      .single();
    if (audErr || !audJob) throw new Error('audience_map job not found');
    if (audJob.query_type !== 'audience_map') throw new Error('referenced job is not audience_map');
    if (audJob.status !== 'complete') throw new Error(`audience_map status=${audJob.status}, not complete`);
    let audienceMap;
    try {
      audienceMap = typeof audJob.finding === 'string' ? JSON.parse(audJob.finding) : audJob.finding;
    } catch (e) {
      throw new Error(`Could not parse audience_map finding: ${e.message}`);
    }
    if (audienceMap.unresolved || audienceMap.low_n_refused) {
      throw new Error('referenced audience_map did not produce a valid profile (unresolved or low-n refused)');
    }

    const brandSection = buildBrandPayload(ctx.brand_text, ctx.brand_json);
    const audienceSection = buildAudienceMapPayload(audienceMap);

    const systemPrompt = PROMPTS.joyMapSynthesis;
    if (!systemPrompt) throw new Error('joy_map_synthesis prompt missing from bundle');

    const userMessage = [brandSection, '', audienceSection].join('\n');

    const rsp = await anthropic.messages.create({
      model: SYNTHESIS_MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: 'text', text: systemPrompt }],
      messages: [{ role: 'user', content: userMessage }],
    });
    const text = (rsp.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const llmResult = JSON.parse(cleaned);

    for (const k of ['strong_alignment','misalignment','untapped_opportunity']) {
      if (Array.isArray(llmResult[k]) && llmResult[k].length > 5) {
        llmResult[k] = llmResult[k].slice(0, 5);
      }
    }

    const allCards = [
      ...(llmResult.strong_alignment || []),
      ...(llmResult.misalignment || []),
      ...(llmResult.untapped_opportunity || []),
    ];
    await augmentLayer3Confidence(allCards);

    const finding = {
      workflow: 'dance_map',
      audience_map_job_id: ctx.audience_map_job_id,
      audience_map_summary: {
        routing_notice: audienceMap.routing?.routing_notice,
        reverse_engineered_cohort_n: audienceMap.reverse_engineered_cohort_n,
        synthesis_paragraph: audienceMap.sections?.synthesis_paragraph,
      },
      dance_map: llmResult,
    };

    const counts = [
      `${(llmResult.strong_alignment || []).length} alignment`,
      `${(llmResult.misalignment || []).length} misalignment`,
      `${(llmResult.untapped_opportunity || []).length} opportunity`,
    ].join(' / ');
    const oneLine = `Dance map vs Audience Map: ${counts}.`;

    await supabase.from('bjl_query_jobs').update({
      status: 'complete',
      finding: JSON.stringify(finding),
      scratch: { one_line_summary: oneLine },
      completed_at: new Date().toISOString(),
    }).eq('job_id', jobId);

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('[bjl-joy-map-background] error:', err);
    await supabase.from('bjl_query_jobs').update({
      status: 'error',
      error: String(err.message || err).slice(0, 1000),
      completed_at: new Date().toISOString(),
    }).eq('job_id', jobId);
    return { statusCode: 500, body: String(err.message || err) };
  }
};
