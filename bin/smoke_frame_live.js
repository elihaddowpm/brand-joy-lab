#!/usr/bin/env node
/**
 * Live end-to-end run of the query pipeline, instrumented for read quality and
 * for cost. Ad-hoc instrument, not a regression test -- it calls the Anthropic
 * API and writes a real job row.
 *
 * Usage: node bin/smoke_frame_live.js "<prompt>" [depth_hint]
 */

const fs = require('fs');
const path = require('path');

// .env -> process.env, before anything requires the function module.
const envPath = path.join(__dirname, '..', '.env');
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Capture the pipeline's own console output. The frame pass logs its outcome
// and its guard failures there and nowhere else.
const LOG = [];
const t0 = Date.now();
for (const level of ['log', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    LOG.push({ ms: Date.now() - t0, level, line });
    orig('   |', `+${((Date.now() - t0) / 1000).toFixed(1)}s`, line.slice(0, 300));
  };
}

const { handler } = require(path.join(__dirname, '..', 'netlify', 'functions', 'bjl-query-background'));

(async () => {
  const prompt = process.argv[2];
  if (!prompt) { console.error('need a prompt'); process.exit(1); }

  const { data: job, error } = await supabase
    .from('bjl_query_jobs')
    .insert({
      status: 'pending',
      query_type: 'data_pull',
      prompt,
      extra_context: { triggered_by: 'bin/smoke_frame_live.js', frame_probation_run: true },
    })
    .select('job_id')
    .single();
  if (error) { console.error('insert failed:', error.message); process.exit(1); }

  console.log('=== job', job.job_id, '===');
  console.log('=== prompt:', prompt);

  const started = Date.now();
  const res = await handler({ body: JSON.stringify({ job_id: job.job_id }) });
  const wallMs = Date.now() - started;

  const { data: done } = await supabase
    .from('bjl_query_jobs')
    .select('status, triage_brief, scratch, finding, response_preview, query_count, error, created_at, completed_at')
    .eq('job_id', job.job_id)
    .single();

  const scratch = Array.isArray(done && done.scratch) ? done.scratch : [];
  const queries = scratch.filter(s => s.type === 'query');
  const frame = scratch.find(s => s.type === 'connective_read');

  const out = {
    job_id: job.job_id,
    prompt,
    status: done && done.status,
    handler_status: res && res.statusCode,
    wall_seconds: +(wallMs / 1000).toFixed(1),
    depth: done && done.triage_brief && done.triage_brief.investigation_depth,
    queries_run: queries.length,
    frame: frame || null,
    frame_log: LOG.filter(l => /\[frame\]/.test(l.line)),
    turn_log: LOG.filter(l => /turn|investigation|depth=/i.test(l.line)).slice(0, 40),
    queries: queries.map(q => ({ sql: (q.query || '').replace(/\s+/g, ' ').slice(0, 400), rows: (q.result || []).length })),
    finding: done && done.finding,
    response_preview: done && done.response_preview,
    error: done && done.error,
  };

  const outPath = path.join('/tmp', `frame_run_${job.job_id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('\n=== WROTE', outPath, '===');
  console.log('status=' + out.status, 'wall=' + out.wall_seconds + 's',
    'depth=' + out.depth, 'queries=' + out.queries_run,
    'frame_outcome=' + (frame ? frame.frame_outcome : 'ABSENT'),
    'has_read=' + (frame ? frame.has_read : 'n/a'));
})();
