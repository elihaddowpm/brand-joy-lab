// retrieval.js
// Takes a retrieval spec + the raw query, fires parallel Supabase RPCs,
// and returns the merged, deduplicated evidence bundle for synthesis.

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIM = 1536;

/**
 * Generate an embedding for the query's semantic core.
 * Used for semantic retrieval across items, verbatims, and laws.
 */
async function embedQuery(semanticQuery, openaiClient) {
  if (!semanticQuery || semanticQuery.length === 0) return null;
  const resp = await openaiClient.embeddings.create({
    model: EMBEDDING_MODEL,
    input: semanticQuery,
    dimensions: EMBEDDING_DIM,
  });
  return resp.data[0].embedding;
}

/**
 * Dedupe items by item_name, keeping the highest overlap_score or similarity.
 * Preserves wave/question_id info in a combined record.
 */
function dedupeItems(items) {
  const byName = new Map();
  for (const item of items) {
    const key = item.item_name;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { ...item, appears_in: [item.category] });
    } else {
      // Keep the higher-scored instance, merge categories
      const newScore = (item.overlap_score ?? 0) + (item.similarity ?? 0);
      const oldScore = (existing.overlap_score ?? 0) + (existing.similarity ?? 0);
      if (newScore > oldScore) {
        byName.set(key, { ...item, appears_in: [...new Set([...existing.appears_in, item.category])] });
      } else if (!existing.appears_in.includes(item.category)) {
        existing.appears_in.push(item.category);
      }
    }
  }
  return Array.from(byName.values());
}

/**
 * Merge tag-retrieval and semantic-retrieval item results.
 * Ranking: joy_scale items with high JI come first (these are true joy measurements),
 * then other scaled items (ordinal, likelihood, familiarity) by their relevance score,
 * so the synthesis model sees canonical Joy Index items at the top of its evidence block.
 */
function mergeItemResults(tagItems, semanticItems, fullTextItems) {
  const all = [
    ...(tagItems || []).map(i => ({ ...i, retrieval_source: "tag" })),
    ...(semanticItems || []).map(i => ({ ...i, retrieval_source: "semantic" })),
    ...(fullTextItems || []).map(i => ({ ...i, retrieval_source: "full_text" })),
  ];
  const deduped = dedupeItems(all);
  
  deduped.sort((a, b) => {
    // Primary sort: joy_scale items first (canonical Joy Index), then ordinal/likelihood/familiarity
    const aIsJoy = a.question_type === "joy_scale" ? 1 : 0;
    const bIsJoy = b.question_type === "joy_scale" ? 1 : 0;
    if (aIsJoy !== bIsJoy) return bIsJoy - aIsJoy;
    
    // Within each tier, sort by joy_index/score (if present), then by retrieval relevance
    const aScore = parseFloat(a.joy_index) || 0;
    const bScore = parseFloat(b.joy_index) || 0;
    if (Math.abs(aScore - bScore) > 5) return bScore - aScore;
    
    const aRel = (a.overlap_score ?? 0) + (a.similarity ?? 0);
    const bRel = (b.overlap_score ?? 0) + (b.similarity ?? 0);
    return bRel - aRel;
  });
  
  return deduped.slice(0, 20);
}

/**
 * Retrieve evidence from BJL based on the decomposer's spec.
 * Fires 8 RPC calls in parallel and returns the merged bundle.
 */
export async function retrieve({ spec, rawQuery, supabaseUrl, supabaseKey, openaiKey }) {
  const supabase = createClient(supabaseUrl, supabaseKey);
  const openai = new OpenAI({ apiKey: openaiKey });
  
  const hasTags = (spec.joy_modes?.length || spec.occasions?.length || 
                   spec.functional_jobs?.length || spec.tensions?.length) > 0;
  
  // Generate query embedding for semantic retrieval (can fail silently if needed)
  const queryEmbedding = spec.semantic_query 
    ? await embedQuery(spec.semantic_query, openai).catch(err => {
        console.error("Embedding generation failed:", err);
        return null;
      })
    : null;
  
  // Fire all retrievals in parallel
  const demographics = spec.demographics || {};
  
  const [
    tagItemsResult,
    semanticItemsResult,
    fullTextItemsResult,
    tagVerbatimsResult,
    semanticVerbatimsResult,
    fullTextVerbatimsResult,
    lawsResult,
    demoSplitsResult,
  ] = await Promise.all([
    // 1. Tag-based item retrieval
    hasTags ? supabase.rpc("retrieve_items_by_tags", {
      p_joy_modes: spec.joy_modes?.length ? spec.joy_modes : null,
      p_occasions: spec.occasions?.length ? spec.occasions : null,
      p_functional_jobs: spec.functional_jobs?.length ? spec.functional_jobs : null,
      p_tensions: spec.tensions?.length ? spec.tensions : null,
      p_category_keys: spec.category_keys?.length ? spec.category_keys : null,
      p_min_n: spec.min_n,
      p_limit: 20,
    }) : { data: [], error: null },

    // 2. Semantic item retrieval
    queryEmbedding ? supabase.rpc("retrieve_items_semantic", {
      p_query_embedding: JSON.stringify(queryEmbedding),
      p_category_keys: spec.category_keys?.length ? spec.category_keys : null,
      p_joy_modes: spec.joy_modes?.length ? spec.joy_modes : null,
      p_min_n: spec.min_n,
      p_limit: 15,
    }) : { data: [], error: null },

    // 3. Full-text item retrieval (catches category nouns the other two miss)
    spec.semantic_query ? supabase.rpc("retrieve_items_full_text", {
      p_query: spec.semantic_query,
      p_category_keys: spec.category_keys?.length ? spec.category_keys : null,
      p_min_n: spec.min_n,
      p_limit: 10,
    }) : { data: [], error: null },

    // 4. Tag-based verbatim retrieval
    hasTags ? supabase.rpc("retrieve_verbatims", {
      p_joy_modes: spec.joy_modes?.length ? spec.joy_modes : null,
      p_category_keys: spec.category_keys?.length ? spec.category_keys : null,
      p_generation: demographics.generation,
      p_gender: demographics.gender,
      p_income_bracket: demographics.income_bracket,
      p_parental_status: demographics.parental_status,
      p_require_quotable: true,
      p_limit: 12,
    }) : { data: [], error: null },

    // 5. Semantic verbatim retrieval
    queryEmbedding ? supabase.rpc("retrieve_verbatims_semantic", {
      p_query_embedding: JSON.stringify(queryEmbedding),
      p_category_keys: spec.category_keys?.length ? spec.category_keys : null,
      p_joy_modes: spec.joy_modes?.length ? spec.joy_modes : null,
      p_generation: demographics.generation,
      p_require_quotable: true,
      p_limit: 12,
    }) : { data: [], error: null },

    // 6. Full-text entity search on verbatims (NO category filter).
    // Fires only when the decomposer extracted entity tokens.
    // Catches brand/entity mentions regardless of how the verbatim was categorized.
    spec.entity_tokens && spec.entity_tokens.length > 0
      ? supabase.rpc("retrieve_verbatims_full_text", {
          p_entity_query: spec.entity_tokens.join(" OR "),
          p_joy_modes: spec.joy_modes?.length ? spec.joy_modes : null,
          p_generation: demographics.generation,
          p_gender: demographics.gender,
          p_require_quotable: true,
          p_limit: 15,
        })
      : { data: [], error: null },

    // 7. Laws (combines tag overlap + full text)
    supabase.rpc("retrieve_laws", {
      p_joy_modes: spec.joy_modes?.length ? spec.joy_modes : null,
      p_categories: spec.category_keys?.length ? spec.category_keys : null,
      p_tensions: spec.tensions?.length ? spec.tensions : null,
      p_demographics: [
        ...(demographics.generation || []),
        ...(demographics.gender || []),
        ...(demographics.income_bracket || []),
        ...(demographics.parental_status || []),
      ].map(v => v.toLowerCase().replace(/\s+/g, "_")),
      p_full_text_query: spec.semantic_query,
      p_limit: 8,
    }),

    // 8. Demographic splits (only if there's a demographic focus)
    (demographics.gender || demographics.generation || demographics.income_bracket) 
      ? supabase.rpc("retrieve_demo_splits", {
          p_min_abs_gender_gap: demographics.gender ? 10 : null,
          p_min_abs_genz_boomer_gap: demographics.generation ? 15 : null,
          p_min_abs_income_gap: demographics.income_bracket ? 15 : null,
          p_limit: 15,
        })
      : { data: [], error: null },
  ]);

  // Log errors for debugging without failing the whole request
  const errorSources = [
    ["tag items", tagItemsResult],
    ["semantic items", semanticItemsResult],
    ["full-text items", fullTextItemsResult],
    ["tag verbatims", tagVerbatimsResult],
    ["semantic verbatims", semanticVerbatimsResult],
    ["full-text verbatims", fullTextVerbatimsResult],
    ["laws", lawsResult],
    ["demo splits", demoSplitsResult],
  ];
  for (const [name, result] of errorSources) {
    if (result.error) console.error(`Retrieval error in ${name}:`, result.error);
  }

  // Merge item results across the three retrieval modes
  const mergedItems = mergeItemResults(
    tagItemsResult.data,
    semanticItemsResult.data,
    fullTextItemsResult.data
  );

  // Dedupe verbatims by id (same verbatim can show up in multiple retrieval paths).
  // Full-text entity matches go first in the merge so they survive dedupe when the
  // same verbatim appears in multiple paths. Slice limit bumped from 15 to 18 to
  // accommodate the additional path's contributions.
  const verbatimMap = new Map();
  for (const v of [
    ...(fullTextVerbatimsResult.data || []),
    ...(tagVerbatimsResult.data || []),
    ...(semanticVerbatimsResult.data || []),
  ]) {
    if (!verbatimMap.has(v.id)) verbatimMap.set(v.id, v);
  }
  const verbatims = Array.from(verbatimMap.values()).slice(0, 18);

  return {
    items: mergedItems,
    verbatims,
    laws: lawsResult.data || [],
    demo_splits: demoSplitsResult.data || [],
    spec, // Pass through for synthesis prompt
  };
}
