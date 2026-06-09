/**
 * bjl-embed-public-corpus.js — Workbench-triggered embedding population
 * for the Public Joy Lab Chat semantic-retrieval substrate.
 *
 * Why this endpoint exists: query-time vectors only match stored
 * vectors when both come from the same embedding model. The 46
 * bjl_laws.embedding rows on disk were populated externally and the
 * model that produced them can't be verified. To avoid a silent
 * garbage-match failure mode where the laws layer LOOKS like it works
 * but returns unrelated rows, this run standardizes all three text
 * layers on OpenAI text-embedding-3-small (1536-dim) and regenerates
 * the law vectors with the same model.
 *
 * Auth: workbench-authenticated (NOT public). Service-role on Supabase.
 *
 * Body shape (POST):
 *   {
 *     mode?:      'incremental' | 'force_all',  // default 'incremental'
 *     tables?:    ['bjl_laws','bjl_public_insights','bjl_public_verbatim_truths']
 *                 (default: all three)
 *     batch_size?: integer  (default 32)
 *     max_rows?:  integer  (safety cap per table per call; default 200)
 *   }
 *
 * In incremental mode each table embeds only rows where embedding IS NULL
 * (so re-running picks up newly added rows). In force_all mode every row
 * gets re-embedded. The first call against bjl_laws should be force_all,
 * since the provenance of the existing vectors is unknown.
 *
 * Returns: { results: { table: { embedded, skipped, errors } }, took_ms }
 */

const { createClient } = require('@supabase/supabase-js');
const { verifyAndAuthorize } = require('./bjl-auth-helper');

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY;
const EMBED_MODEL     = 'text-embedding-3-small';   // 1536-dim
const EMBED_DIMENSION = 1536;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function jsonResp(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Per-table sources of the text the embedding should reflect.
const TABLE_CONFIG = {
  bjl_laws: {
    id_col: 'id',
    embed_input: (row) => {
      // Laws are paragraph-like: combine statement + evidence + implication
      // so semantic retrieval surfaces a law for any aspect of its content.
      return [row.statement, row.evidence, row.implication]
        .filter(s => typeof s === 'string' && s.trim().length > 0)
        .join('\n\n');
    },
    select_cols: 'id,statement,evidence,implication',
  },
  bjl_public_insights: {
    id_col: 'id',
    embed_input: (row) => {
      // Insights: title + insight + stat. Question_framings ALSO inform
      // retrieval — they're how visitors will phrase questions. Including
      // them in the embedding biases the vector toward visitor language.
      const framings = Array.isArray(row.question_framings)
        ? row.question_framings.join(' / ')
        : '';
      return [row.title, row.insight, row.stat, framings]
        .filter(s => typeof s === 'string' && s.trim().length > 0)
        .join('\n\n');
    },
    select_cols: 'id,title,insight,stat,question_framings',
  },
  bjl_public_verbatim_truths: {
    id_col: 'id',
    embed_input: (row) => {
      return [row.title, row.truth, row.evidence]
        .filter(s => typeof s === 'string' && s.trim().length > 0)
        .join('\n\n');
    },
    select_cols: 'id,title,truth,evidence',
  },
};

async function embedBatch(inputs) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set on this deployment');
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: inputs,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI embeddings call failed (${resp.status}): ${text.slice(0, 400)}`);
  }
  const j = await resp.json();
  if (!Array.isArray(j.data) || j.data.length !== inputs.length) {
    throw new Error('OpenAI returned mismatched embedding count');
  }
  return j.data.map(d => d.embedding);
}

async function embedTable(table, opts) {
  const cfg = TABLE_CONFIG[table];
  if (!cfg) throw new Error(`unknown table: ${table}`);
  const limit = Math.min(Number(opts.max_rows || 200), 1000);
  const batchSize = Math.max(1, Math.min(Number(opts.batch_size || 32), 128));

  let query = supabase
    .from(table)
    .select(cfg.select_cols)
    .order(cfg.id_col, { ascending: true })
    .limit(limit);
  if (opts.mode !== 'force_all') {
    query = query.is('embedding', null);
  }
  const { data: rows, error } = await query;
  if (error) throw new Error(`select ${table}: ${error.message}`);

  let embedded = 0;
  let skipped  = 0;
  const errors  = [];

  for (let i = 0; i < (rows || []).length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const inputs = slice.map(cfg.embed_input);
    // Drop rows whose composite text is empty — embed those with a
    // single space so the row still gets a vector but it sits near
    // the model's neutral midpoint (a NULL-equivalent for retrieval).
    const safeInputs = inputs.map(t => (t && t.trim()) ? t : ' ');

    let vectors;
    try {
      vectors = await embedBatch(safeInputs);
    } catch (err) {
      errors.push({ batch_start: i, error: String(err.message || err).slice(0, 400) });
      continue;
    }

    // Validate dimension on first batch
    if (vectors[0] && vectors[0].length !== EMBED_DIMENSION) {
      throw new Error(`OpenAI returned ${vectors[0].length}-dim vectors; expected ${EMBED_DIMENSION}`);
    }

    // Write back one row at a time (UPDATE by id). Doing this serially
    // keeps the code simple and avoids batch-write quirks; the volumes
    // are tiny (≤795 rows across all tables).
    for (let j = 0; j < slice.length; j++) {
      const row = slice[j];
      const vec = vectors[j];
      const { error: upErr } = await supabase
        .from(table)
        .update({
          embedding: vec,
          embedding_updated_at: new Date().toISOString(),
        })
        .eq(cfg.id_col, row[cfg.id_col]);
      if (upErr) {
        errors.push({ row_id: row[cfg.id_col], error: upErr.message });
        continue;
      }
      embedded++;
    }
  }

  return { embedded, skipped, errors, total_rows_considered: (rows || []).length };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResp(405, { error: 'POST only' });
  }
  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return jsonResp(auth.status || 401, { error: auth.error || 'unauthorized' });
  }
  if (!OPENAI_API_KEY) {
    return jsonResp(500, {
      error: 'missing_env',
      message: 'OPENAI_API_KEY is not set on this Netlify deployment. Add it and redeploy before running the embedding population.',
    });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch (_) { return jsonResp(400, { error: 'invalid JSON' }); }

  const mode = body.mode === 'force_all' ? 'force_all' : 'incremental';
  const requestedTables = Array.isArray(body.tables) && body.tables.length > 0
    ? body.tables.filter(t => TABLE_CONFIG[t])
    : Object.keys(TABLE_CONFIG);

  const t0 = Date.now();
  const results = {};
  for (const table of requestedTables) {
    try {
      results[table] = await embedTable(table, {
        mode,
        max_rows: body.max_rows,
        batch_size: body.batch_size,
      });
    } catch (err) {
      results[table] = { embedded: 0, skipped: 0, errors: [{ error: String(err.message || err).slice(0, 400) }] };
    }
  }
  return jsonResp(200, {
    model: EMBED_MODEL,
    mode,
    results,
    took_ms: Date.now() - t0,
  });
};
