// netlify/functions/bjl-query.js
// Main entry point for the BJL Intelligence Engine.
// Orchestrates: decompose query → retrieve evidence → stream synthesis back.

import Anthropic from "@anthropic-ai/sdk";
import { decompose } from "../../src/decomposer.js";
import { retrieve } from "../../src/retrieval.js";
import { synthesize } from "../../src/synthesis.js";

// Trim a string to max N chars, preserving word boundaries where possible.
function trim(str, n) {
  if (!str) return "";
  const s = String(str);
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > n * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

// Shape the retrieval bundle into slim, UI-friendly rows for the evidence drawer.
// This is a display-only projection — the full rows still flow into synthesis
// unchanged inside retrieve() / synthesize(). No existing caller is affected.
function toEvidenceRows(evidence) {
  const rows = [];

  // Items — ranked survey items (joy_scale, ordinal_scale, likelihood_scale, etc.)
  for (const it of (evidence.items || []).slice(0, 20)) {
    const qtype = it.question_type || "item";
    let body = it.item_name || "(unnamed item)";
    let meta = "";
    if (qtype === "joy_scale" && it.joy_index != null) {
      meta = `Joy Index ${it.joy_index}${it.n ? ` · n=${it.n}` : ""}`;
    } else if (it.top_response && it.top_pct != null) {
      meta = `${it.top_pct}% ${trim(it.top_response, 40)}${it.n ? ` · n=${it.n}` : ""}`;
    } else if (it.joy_index != null) {
      meta = `score ${it.joy_index}${it.n ? ` · n=${it.n}` : ""}`;
    } else if (it.n) {
      meta = `n=${it.n}`;
    }
    if (it.category) meta = meta ? `${meta} · ${it.category}` : it.category;
    rows.push({
      id: `item-${it.item_name ? it.item_name.replace(/\s+/g, "_").slice(0, 40) : rows.length}`,
      kind: "item",
      body: trim(it.question ? `${it.item_name} (${trim(it.question, 90)})` : it.item_name, 220),
      meta,
    });
  }

  // Verbatims — quotable consumer voice
  for (const v of (evidence.verbatims || []).slice(0, 15)) {
    const demo = [v.generation, v.gender, v.income_bracket, v.region].filter(Boolean).join(", ");
    rows.push({
      id: `verbatim-${v.id || rows.length}`,
      kind: "verbatim",
      body: trim(v.response_text || "", 280),
      meta: demo || "anonymous",
    });
  }

  // Laws — derived BJL framework principles
  for (const law of (evidence.laws || []).slice(0, 8)) {
    rows.push({
      id: `law-${law.law_id || rows.length}`,
      kind: "law",
      body: trim(`${law.title || "Law"}: ${law.statement || ""}`, 280),
      meta: law.law_id || "derived",
    });
  }

  // Demo splits — meaningful demographic gaps
  for (const s of (evidence.demo_splits || []).slice(0, 10)) {
    const gaps = [];
    if (s.gender_gap != null && Math.abs(s.gender_gap) >= 8) {
      gaps.push(`${s.gender_gap > 0 ? "F>M" : "M>F"} ${Math.abs(s.gender_gap).toFixed(1)}`);
    }
    if (s.gen_z_vs_boomer != null && Math.abs(s.gen_z_vs_boomer) >= 10) {
      gaps.push(`${s.gen_z_vs_boomer > 0 ? "GenZ>Boomer" : "Boomer>GenZ"} ${Math.abs(s.gen_z_vs_boomer).toFixed(1)}`);
    }
    if (s.income_gap != null && Math.abs(s.income_gap) >= 10) {
      gaps.push(`${s.income_gap > 0 ? "Hi>Lo" : "Lo>Hi"} income ${Math.abs(s.income_gap).toFixed(1)}`);
    }
    if (!gaps.length) continue;
    rows.push({
      id: `split-${s.item_name ? s.item_name.replace(/\s+/g, "_").slice(0, 30) : rows.length}`,
      kind: "demo_split",
      body: trim(s.item_name || "(unnamed split)", 180),
      meta: `${gaps.join(" · ")}${s.overall_ji != null ? ` · overall JI=${s.overall_ji}` : ""}${s.n_overall ? ` · n=${s.n_overall}` : ""}`,
    });
  }

  return rows;
}

export default async (request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { query, intentHint, strategistContext, waldoContext, debug } = body;
  
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return new Response(JSON.stringify({ error: "Missing required field: query" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  
  if (!anthropicKey || !supabaseUrl || !supabaseKey || !openaiKey) {
    return new Response(JSON.stringify({ 
      error: "Server misconfigured: missing one or more required environment variables" 
    }), { status: 500, headers: { "Content-Type": "application/json" } });
  }

  const anthropic = new Anthropic({ apiKey: anthropicKey });

  // Stream the response using Server-Sent Events format
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (eventType, data) => {
        controller.enqueue(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      
      try {
        // Step 1: Decompose
        sendEvent("status", { phase: "decomposing" });
        const spec = await decompose({ 
          query, 
          intentHint, 
          strategistContext, 
          waldoContext, 
          client: anthropic 
        });
        
        if (debug) {
          sendEvent("debug", { spec });
        }

        // Step 2: Retrieve
        sendEvent("status", { phase: "retrieving" });
        const evidence = await retrieve({ 
          spec, 
          rawQuery: query, 
          supabaseUrl, 
          supabaseKey, 
          openaiKey 
        });
        
        if (debug) {
          sendEvent("debug", {
            evidence_counts: {
              items: evidence.items?.length ?? 0,
              verbatims: evidence.verbatims?.length ?? 0,
              laws: evidence.laws?.length ?? 0,
              demo_splits: evidence.demo_splits?.length ?? 0,
            }
          });
        }

        // Step 2.5: Emit compact evidence rows for the frontend evidence drawer.
        // Additive event — existing callers that ignore it keep working unchanged.
        // Rows are slimmed to what the UI renders, not the full shape fed to synthesis.
        sendEvent("evidence", { rows: toEvidenceRows(evidence) });

        // Step 3: Synthesize (streaming)
        sendEvent("status", { phase: "synthesizing" });
        
        const synthStream = synthesize({ 
          query, 
          evidence, 
          strategistContext, 
          waldoContext, 
          client: anthropic 
        });
        
        for await (const chunk of synthStream) {
          sendEvent("chunk", { text: chunk });
        }
        
        sendEvent("done", { 
          evidence_counts: {
            items: evidence.items?.length ?? 0,
            verbatims: evidence.verbatims?.length ?? 0,
            laws: evidence.laws?.length ?? 0,
            demo_splits: evidence.demo_splits?.length ?? 0,
          }
        });
        
      } catch (err) {
        console.error("Orchestrator error:", err);
        sendEvent("error", { 
          message: err.message || "An error occurred during processing",
          phase: err.phase || "unknown",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // Disable proxy buffering for Netlify
    },
  });
};

export const config = {
  path: "/api/bjl-query",
};
