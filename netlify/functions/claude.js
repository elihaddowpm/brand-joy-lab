// netlify/functions/claude.js
// Thin server-side proxy to Anthropic's Messages API.
// Used by legacy call-sites in index.html (batch email generation, brand lookup,
// web-research pre-step, Waldo insights) that POST the Anthropic Messages body
// directly and expect a JSON response.
//
// The body passed by the client is forwarded verbatim to /v1/messages, minus any
// attempts to override auth/version headers. This keeps the ANTHROPIC_API_KEY
// server-side instead of embedding it in the browser.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: "Server misconfigured: ANTHROPIC_API_KEY not set" }, 500);
  }

  let bodyText;
  try {
    bodyText = await request.text();
    if (!bodyText || !bodyText.trim()) {
      return json({ error: "Empty request body" }, 400);
    }
    // Validate the body is JSON before forwarding, so we return a clean JSON
    // error instead of letting Anthropic reject it with a different shape.
    JSON.parse(bodyText);
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // If the body enables the web_search tool, the API needs the beta header.
  // Detect it cheaply from the raw text — avoids re-stringifying.
  const needsWebSearchBeta = bodyText.includes('"web_search_20250305"');

  const headers = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": DEFAULT_ANTHROPIC_VERSION,
  };
  if (needsWebSearchBeta) {
    headers["anthropic-beta"] = "web-search-2025-03-05";
  }

  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers,
      body: bodyText,
    });
  } catch (err) {
    return json({ error: "Upstream fetch failed: " + (err?.message || "unknown") }, 502);
  }

  const responseText = await upstream.text();
  return new Response(responseText, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const config = {
  path: "/api/claude",
};
