#!/usr/bin/env node
/**
 * build_prompts_bundle.js
 *
 * Generates netlify/functions/_prompts_bundle.json containing the contents
 * of prompts/*.md and docs/schema_doc.md as JSON-encoded strings. The
 * background function require()s this bundle, which esbuild then inlines
 * into the function's lambda bundle.
 *
 * This sidesteps Netlify's included_files mechanism, which doesn't reliably
 * include non-JS files when node_bundler = "esbuild".
 *
 * Run before every deploy if the prompts or schema doc have changed:
 *   node bin/build_prompts_bundle.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCES = {
  triage: 'prompts/triage_prompt.md',
  investigator: 'prompts/investigator_prompt_v3.md',
  synthesizer: 'prompts/synthesizer_prompt_v3.md',
  schemaDoc: 'docs/schema_doc.md',
};

const bundle = {};
for (const [key, rel] of Object.entries(SOURCES)) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    console.error(`MISSING: ${full}`);
    process.exit(1);
  }
  bundle[key] = fs.readFileSync(full, 'utf8');
  console.log(`  ${key.padEnd(15)} ${bundle[key].length.toString().padStart(6)} chars  <- ${rel}`);
}

bundle._meta = {
  generated_at: new Date().toISOString(),
  source_paths: SOURCES,
};

const outDir = path.join(ROOT, 'netlify/functions');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, '_prompts_bundle.json');
fs.writeFileSync(outPath, JSON.stringify(bundle));
console.log(`\nWrote ${outPath}`);
console.log(`Bundle size: ${(fs.statSync(outPath).size / 1024).toFixed(1)} KB`);
