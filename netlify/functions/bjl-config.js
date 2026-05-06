/**
 * bjl-config.js — public client config endpoint
 *
 * Returns the small set of values the browser needs to initialize the
 * Supabase Auth client and decide whether to render the login gate.
 *
 *   GET /api/bjl-config
 *   -> 200 { supabaseUrl, supabaseAnonKey, authEnforced }
 *
 * The anon key is designed to be public (it's the browser-facing key the
 * Supabase JS client uses to talk to PostgREST/Auth/Realtime). The service
 * role key is NEVER exposed by this endpoint and lives only in the
 * server-side environment of the other functions.
 *
 * authEnforced toggles the frontend's AuthGate. When false, the existing
 * unauthenticated experience is preserved — used during the deploy window
 * before the Microsoft Azure provider is fully wired up in Supabase Auth.
 *
 * Cache-Control: no-store so a flip of AUTH_ENFORCED in Netlify env vars
 * takes effect on the next page load without any code deploy.
 */

exports.handler = async () => ({
  statusCode: 200,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  },
  body: JSON.stringify({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    authEnforced: process.env.AUTH_ENFORCED === 'true'
  })
});
