# BJL Intelligence Engine

Strategic intelligence tool for PETERMAYER, powered by the Brand Joy Lab (BJL) dataset.

The frontend is a single-page React app (`index.html`) that uses runtime Babel — no build step.
The backend is a triage-aware three-stage Netlify serverless pipeline (Haiku triage → Sonnet
investigation → Sonnet synthesis), polled from the frontend via a job-queue pattern.

> **Note**: this README's "Architecture" section below describes the legacy V1 system and is
> partially stale. The current architecture replaced V1's SSE streaming with a polling pattern
> (PR #1, commits `5210d9a`..`a4eeeb0`) and the V1 frontend was archived to `archive/index_v1.html`
> in PR #4. The current canonical references are:
> - **Schema reference**: `docs/schema_doc.md` (loaded by the bg fn at startup)
> - **Prompts**: `prompts/triage_prompt.md`, `prompts/investigator_prompt_v3.md`,
>   `prompts/synthesizer_prompt_v3.md`
> - **Functions**: `netlify/functions/bjl-query.js` (sync enqueuer),
>   `netlify/functions/bjl-query-background.js` (agent loop, 15-min ceiling),
>   `netlify/functions/bjl-query-status.js` (poller + watchdog)
>
> A full README rewrite to describe the V2 architecture is a separate housekeeping task.

## Architecture (LEGACY — describes archived V1)

```
index.html                     static, loads React + Babel from CDN, inlines JSX
netlify/functions/bjl-query.js HTTP entry, SSE streaming
src/
├── bjlClient.js               canonical client-side SSE parser (mirrored inline in index.html)
├── decomposer.js              Sonnet decomposer → structured retrieval spec
├── retrieval.js               parallel Supabase RPCs, merge/dedupe
└── synthesis.js               Opus synthesis, streaming
BJL_Intelligence_Tool_v5.jsx   historical JSX source (pre-orchestrator); for reference only
```

The `src/` directory was removed in commit `ad27618` when its contents became orphaned by the
V1→V2 architecture transition. The block above is preserved as a snapshot of what V1 looked like.

Flow per query (V1):

1. **Decompose** (Sonnet) — classifies intent, picks joy modes / audiences / filters
2. **Retrieve** (Supabase) — tag + semantic + full-text items, verbatims, laws, demo splits
3. **Synthesize** (Opus, streamed) — PETERMAYER-voiced brief grounded in the retrieved evidence

## Required environment variables

Set these in Netlify → Site settings → Environment variables:

- `ANTHROPIC_API_KEY` — for triage (Haiku 4.5) + investigation + synthesis (Sonnet 4.6)
- `SUPABASE_URL` — e.g. `https://iqjkgswpzbklihdfccnd.supabase.co`
- `SUPABASE_SERVICE_KEY` — service role key; the bg fn uses this for the SECURITY DEFINER `execute_read_sql` RPC

## Local development

```bash
npm install
netlify dev
```

If you change the prompts in `prompts/*.md` or the schema doc in `docs/schema_doc.md`, regenerate
the bundle that the bg fn loads at startup:

```bash
node bin/build_prompts_bundle.js
```

## Deploy

Netlify auto-deploys on push to `main`.

## Notes

- `/api/bjl-query` is the sync enqueuer (returns 202 with a job_id).
- `/api/bjl-query-status` is the poll endpoint (frontend polls every 2s).
- `/api/claude` is an Anthropic Messages passthrough still used by legacy email-generation paths
  in `archive/index_v1.html`. The current V2 frontend's email mode routes through `/api/bjl-query`
  with `mode: "email"`.
