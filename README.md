# BJL Intelligence Engine

Strategic intelligence tool for PETERMAYER, powered by the Brand Joy Lab (BJL) dataset.

The frontend is a single-page React app (`index.html`) that uses runtime Babel — no build step.
The backend is a Netlify serverless function that orchestrates decompose → retrieve → synthesize
in a single Server-Sent Events stream.

## Architecture

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

Flow per query:

1. **Decompose** (Sonnet) — classifies intent, picks joy modes / audiences / filters
2. **Retrieve** (Supabase) — tag + semantic + full-text items, verbatims, laws, demo splits
3. **Synthesize** (Opus, streamed) — PETERMAYER-voiced brief grounded in the retrieved evidence

## Required environment variables

Set these in Netlify → Site settings → Environment variables:

- `ANTHROPIC_API_KEY` — for decomposer (Sonnet) + synthesis (Opus)
- `OPENAI_API_KEY` — query embedding for semantic retrieval (text-embedding-3-small)
- `SUPABASE_URL` — e.g. `https://iqjkgswpzbklihdfccnd.supabase.co`
- `SUPABASE_ANON_KEY` — anon public key; retrieval uses SELECT-only RPCs

## Local development

```bash
npm install
netlify dev
```

## Deploy

Netlify auto-deploys on push to `main`.

## Notes

- `/api/bjl-query` is now the streaming orchestrator. It replaces the old "fetch BJL rows as JSON"
  endpoint that earlier versions of this tool used.
- The old `fetchBJLData` helper in `index.html` is now a no-op stub. Legacy call-sites (batch email
  generation, web-research enrichment, etc.) still route through `/api/claude` — rewire them to the
  orchestrator if/when needed.
