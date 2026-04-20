// netlify/functions/bjl-query.js
// Main entry point for the BJL Intelligence Engine.
// Orchestrates: decompose query → retrieve evidence → stream synthesis back.

import Anthropic from "@anthropic-ai/sdk";
import { decompose } from "../../src/decomposer.js";
import { retrieve } from "../../src/retrieval.js";
import { synthesize } from "../../src/synthesis.js";

// Sanitize the synthesis output at the point of streaming.
// Catches em dashes the model might slip in despite the system prompt.
function sanitizeChunk(text) {
  return text.replace(/—/g, ", ").replace(/–/g, "-");
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
          const sanitized = sanitizeChunk(chunk);
          sendEvent("chunk", { text: sanitized });
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
