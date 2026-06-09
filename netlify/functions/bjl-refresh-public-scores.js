/**
 * bjl-refresh-public-scores.js — Workbench-triggered enqueue for the
 * bjl_public_scores snapshot refresh.
 *
 * The refresh SQL aggregates ~991K bjl_responses rows and runs ~45
 * seconds, well beyond Netlify's sync function timeout. This endpoint
 * dispatches to the background worker (15-minute timeout) and returns
 * 202 immediately so the workbench gets a fast confirmation.
 *
 * No polling endpoint in v1 — the team verifies completion by
 * re-checking bjl_public_scores counts or watching for the operator
 * log row written by the background worker.
 *
 * Auth: workbench-authenticated.
 *
 * POST body: {}  (no parameters)
 * Returns:    202 + { dispatched: true, started_at }
 */

const { verifyAndAuthorize } = require('./bjl-auth-helper');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
  }
  const auth = await verifyAndAuthorize(event.headers.authorization || event.headers.Authorization);
  if (!auth.ok) {
    return {
      statusCode: auth.status || 401,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: auth.error || 'unauthorized' }),
    };
  }

  const siteUrl = process.env.URL || `https://${event.headers.host}`;
  const bgUrl = `${siteUrl}/.netlify/functions/bjl-refresh-public-scores-background`;
  const startedAt = new Date().toISOString();

  let dispatchStatus = null;
  let dispatchPreview = null;
  try {
    const resp = await fetch(bgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ started_at: startedAt }),
    });
    dispatchStatus = resp.status;
    if (!resp.ok) {
      try { dispatchPreview = ((await resp.text()) || '').slice(0, 500); }
      catch (_) { dispatchPreview = null; }
    }
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `dispatch failed: ${err.message || err}` }),
    };
  }

  return {
    statusCode: 202,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dispatched: true,
      started_at: startedAt,
      dispatch_status: dispatchStatus,
      message: 'Refresh started. Aggregating ~991K responses; usually completes in ~60s. Re-check bjl_public_scores counts or the operator log after a minute.',
    }),
  };
};
