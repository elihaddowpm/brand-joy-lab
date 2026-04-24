// bjlClient.js
// Client-side helpers for consuming the streaming bjl-query endpoint.
// - queryBJL: structured decompose → retrieve → synthesize pipeline (email path).
// - investigateQuery: investigator → synthesis_v2 pipeline (Intelligence mode).
// Both hit the same /api/bjl-query endpoint; the server routes based on `mode`.

/**
 * Query the BJL Intelligence Engine and stream results.
 *
 * @param {Object} params
 * @param {string} params.query - The user's query
 * @param {string} [params.intentHint] - "outreach_angle" | "brand_lookup" | "audience_deep_dive" | "data_pull" | "general"
 * @param {string} [params.strategistContext] - PETERMAYER-specific context field
 * @param {Object} [params.waldoContext] - Waldo JSON for account-level context
 * @param {boolean} [params.debug] - If true, surfaces decomposer spec and evidence counts
 * @param {Function} params.onStatus - Called with {phase: "decomposing"|"retrieving"|"synthesizing"}
 * @param {Function} params.onChunk - Called with each text chunk as it streams
 * @param {Function} params.onDone - Called when synthesis completes, with {evidence_counts}
 * @param {Function} params.onError - Called if anything fails
 * @param {Function} [params.onDebug] - Optional debug-event handler
 * @param {Function} [params.onEvidence] - Optional handler for compact evidence rows
 *   emitted between retrieval and synthesis. Payload: {rows: [{id, kind, body, meta}]}.
 *   Callers that omit this keep working unchanged — the event is silently dropped.
 * @param {string} [params.endpoint] - API endpoint path (default: /api/bjl-query)
 */
export async function queryBJL({
  query,
  intentHint,
  strategistContext,
  waldoContext,
  debug = false,
  onStatus = () => {},
  onChunk = () => {},
  onDone = () => {},
  onError = () => {},
  onDebug = () => {},
  onEvidence = () => {},
  endpoint = "/api/bjl-query",
}) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, intentHint, strategistContext, waldoContext, debug, mode: "email" }),
    });
  } catch (err) {
    onError({ message: err.message, phase: "fetch" });
    return;
  }

  if (!response.ok) {
    let errorBody;
    try { errorBody = await response.json(); } catch { errorBody = { error: response.statusText }; }
    onError({ message: errorBody.error || "Request failed", phase: "http", status: response.status });
    return;
  }

  if (!response.body) {
    onError({ message: "No response body", phase: "stream" });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      
      // Parse SSE frames: each event is "event: X\ndata: Y\n\n"
      let frameEnd;
      while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        
        const lines = frame.split("\n");
        let eventType = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) eventType = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        
        if (!data) continue;
        
        let parsed;
        try { parsed = JSON.parse(data); } 
        catch { continue; }
        
        switch (eventType) {
          case "status": onStatus(parsed); break;
          case "chunk": onChunk(parsed.text); break;
          case "done": onDone(parsed); break;
          case "error": onError(parsed); break;
          case "debug": onDebug(parsed); break;
          case "evidence": onEvidence(parsed); break;
        }
      }
    }
  } catch (err) {
    onError({ message: err.message, phase: "stream" });
  } finally {
    reader.releaseLock();
  }
}

/**
 * Run a full investigation: SQL investigator writes queries, synthesizes the answer.
 * Used by Intelligence mode. 12-25s latency expected; stream begins when synthesis starts.
 *
 * @param {Object} params
 * @param {string} params.question - The user's question
 * @param {string} [params.intent] - Optional intent hint: "brand_lookup" | "audience_deep_dive" | "outreach_angle" | "data_pull" | null
 * @param {Function} [params.onStatus] - {phase: "investigating"|"synthesizing"}
 * @param {Function} [params.onNote] - {note, queryIndex} — investigator's reasoning, one per query
 * @param {Function} [params.onChunk] - text chunks during synthesis
 * @param {Function} [params.onDone] - {queryBudgetUsed, errorCount, stoppedEarly}
 * @param {Function} [params.onError]
 * @param {Function} [params.onDebug]
 * @param {string} [params.endpoint] - default /api/bjl-query
 */
export async function investigateQuery({
  question,
  intent = null,
  onStatus = () => {},
  onNote = () => {},
  onChunk = () => {},
  onDone = () => {},
  onError = () => {},
  onDebug = () => {},
  endpoint = "/api/bjl-query",
  debug = false,
}) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: question,
        mode: "investigate",
        intent,
        debug,
      }),
    });
  } catch (err) {
    onError({ message: err.message, phase: "fetch" });
    return;
  }

  if (!response.ok) {
    let errorBody;
    try { errorBody = await response.json(); } catch { errorBody = { error: response.statusText }; }
    onError({ message: errorBody.error || "Request failed", phase: "http", status: response.status });
    return;
  }

  if (!response.body) {
    onError({ message: "No response body", phase: "stream" });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let frameEnd;
      while ((frameEnd = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        const lines = frame.split("\n");
        let eventType = "message";
        let data = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) eventType = line.slice(7);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!data) continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        switch (eventType) {
          case "status": onStatus(parsed); break;
          case "investigation_note": onNote(parsed); break;
          case "chunk": onChunk(parsed.text); break;
          case "done": onDone(parsed); break;
          case "error": onError(parsed); break;
          case "debug": onDebug(parsed); break;
        }
      }
    }
  } catch (err) {
    onError({ message: err.message, phase: "stream" });
  } finally {
    reader.releaseLock();
  }
}
